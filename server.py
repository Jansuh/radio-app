#!/usr/bin/env python3
"""
Lokale server voor de radio-app.
- Serveert de app op http://localhost:8080
- Regelt systeemtaken via de beveiligde hulpopdracht /usr/local/sbin/radio-helper:
  uitzetten, herstarten, wifi, updates en schermhelderheid
- Kiest de audio-uitgang en het hoofdvolume (via pactl, zonder root)
- Haalt KNMI-weerwaarschuwingen op via MeteoAlarm

Luistert alleen op 127.0.0.1, dus alleen het scherm van de Pi zelf kan hem gebruiken.
Alleen Python-standaardbibliotheek, geen extra pakketten nodig.
"""
import json
import os
import shutil
import re
import socket
import ssl
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

APP_DIR = os.path.dirname(os.path.abspath(__file__))
CONF_DIR = os.path.expanduser('~/.config/radio-app')
INSTELLINGEN = os.path.join(CONF_DIR, 'instellingen.json')
UPGRADE_LOG = os.path.join(CONF_DIR, 'upgrade.log')
APP_STATUS = os.path.join(CONF_DIR, 'app-update.json')
HELPER = '/usr/local/sbin/radio-helper'
PORT = int(os.environ.get('RADIO_PORT', '8080'))
DEMO = os.environ.get('RADIO_DEMO') == '1'
METEOALARM = 'https://feeds.meteoalarm.org/api/v1/warnings/feeds-netherlands'
TOEGESTANE_HOSTS = {f'localhost:{PORT}', f'127.0.0.1:{PORT}'}

os.makedirs(CONF_DIR, exist_ok=True)
slot = threading.Lock()

status = {
    'updates': None,            # aantal beschikbare updates (None = nog niet gecontroleerd)
    'laatsteCheck': None,
    'upgrade': {'bezig': False, 'klaar': False, 'fout': False, 'regel': ''},
    'herstartAanbevolen': False,
}


# ------------------------------------------------------------------ helpers
def helper(*args, timeout=120):
    """Voer een systeemtaak uit via de root-hulpopdracht (alleen vaste taken toegestaan)."""
    if DEMO:
        return demo_helper(*args)
    r = subprocess.run(['sudo', '-n', HELPER, *args], capture_output=True, text=True, timeout=timeout)
    return r.returncode, r.stdout, r.stderr


def lees(pad, standaard=''):
    try:
        with open(pad) as f:
            return f.read().strip()
    except OSError:
        return standaard


def lokaal_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('1.1.1.1', 80))   # er wordt niets verstuurd
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return None


def splits_nmcli(regel):
    """Splits een 'nmcli -t -e yes' regel op ':' met backslash-escapes."""
    delen, huidig, esc = [], '', False
    for ch in regel:
        if esc:
            huidig += ch
            esc = False
        elif ch == '\\':
            esc = True
        elif ch == ':':
            delen.append(huidig)
            huidig = ''
        else:
            huidig += ch
    delen.append(huidig)
    return delen


def huidig_wifi():
    if DEMO:
        return {'ssid': 'Thuisnetwerk', 'signaal': 72}
    try:
        r = subprocess.run(['nmcli', '-t', '-e', 'yes', '-f', 'ACTIVE,SSID,SIGNAL', 'device', 'wifi'],
                           capture_output=True, text=True, timeout=10)
        for regel in r.stdout.splitlines():
            d = splits_nmcli(regel)
            if len(d) >= 3 and d[0] == 'yes':
                return {'ssid': d[1], 'signaal': int(d[2] or 0)}
    except (OSError, subprocess.SubprocessError, ValueError):
        pass
    return None


def heeft_backlight():
    return DEMO or (os.path.isdir('/sys/class/backlight') and bool(os.listdir('/sys/class/backlight')))


def systeem_info():
    uptime = float(lees('/proc/uptime', '0').split()[0] or 0)
    temp = lees('/sys/class/thermal/thermal_zone0/temp')
    schijf = shutil.disk_usage('/')
    model = lees('/proc/device-tree/model').replace('\x00', '')
    with slot:
        s = json.loads(json.dumps(status))
    s.update({
        'ip': lokaal_ip(),
        'wifi': huidig_wifi(),
        'temp': round(int(temp) / 1000, 1) if temp.isdigit() else None,
        'uptimeMin': int(uptime // 60),
        'schijfVrijGB': round(schijf.free / 1e9, 1),
        'model': model or ('Raspberry Pi (demo)' if DEMO else None),
        'backlight': heeft_backlight(),
        'herstartNodig': os.path.exists('/var/run/reboot-required') or status['herstartAanbevolen'],
        'demo': DEMO,
    })
    with slot:
        s['app'] = dict(app)
    return s


# ------------------------------------------------------------------ updates
def zoek_updates():
    try:
        code, uit, _ = helper('update-check', timeout=600)
        aantal = int((uit.strip().splitlines() or ['0'])[-1])
    except (ValueError, subprocess.SubprocessError, OSError):
        aantal = None
    with slot:
        status['updates'] = aantal
        status['laatsteCheck'] = datetime.now().strftime('%H:%M')


def update_lus():
    time.sleep(90)                      # eerst rustig opstarten
    while True:
        if not status['upgrade']['bezig']:
            zoek_updates()
        time.sleep(6 * 3600)            # elke 6 uur


def installeer_updates():
    with slot:
        if status['upgrade']['bezig']:
            return
        status['upgrade'] = {'bezig': True, 'klaar': False, 'fout': False, 'regel': 'Starten…'}
        hadden_updates = (status['updates'] or 0) > 0

    def werk():
        ok = False
        try:
            if DEMO:
                for r in ['Pakketlijsten lezen…', 'Uitpakken…', 'Instellen…']:
                    with slot:
                        status['upgrade']['regel'] = r
                    time.sleep(2)
                ok = True
            else:
                with open(UPGRADE_LOG, 'w') as log:
                    p = subprocess.Popen(['sudo', '-n', HELPER, 'upgrade'], stdout=subprocess.PIPE,
                                         stderr=subprocess.STDOUT, text=True)
                    for regel in p.stdout:
                        log.write(regel)
                        regel = regel.strip()
                        if regel:
                            with slot:
                                status['upgrade']['regel'] = regel[:120]
                    ok = p.wait() == 0
        except (OSError, subprocess.SubprocessError) as e:
            with slot:
                status['upgrade']['regel'] = str(e)[:120]
        with slot:
            status['upgrade'].update({'bezig': False, 'klaar': ok, 'fout': not ok})
            if ok:
                status['upgrade']['regel'] = 'Updates geïnstalleerd'
                status['herstartAanbevolen'] = hadden_updates
        zoek_updates()

    threading.Thread(target=werk, daemon=True).start()


# ------------------------------------------------------------------ app zelf bijwerken (git / GitHub)
app = {'git': False, 'versie': '', 'commit': '', 'nieuw': None, 'wijzigingen': [], 'lokaalGewijzigd': False,
       'laatsteCheck': None, 'bezig': False, 'melding': '', 'fout': False, 'systeemdeelGewijzigd': False,
       'bron': ''}
SYSTEEMDEEL = {'radio-helper', 'install.sh', 'start-kiosk.sh'}
# Alleen deze bestandstypen uit de app-map worden geserveerd (dus geen server.py, radio-helper of .git)
STATISCH = {'.html', '.css', '.js', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico'}


def git(*args, timeout=60):
    r = subprocess.run(['git', '-C', APP_DIR, *args], capture_output=True, text=True, timeout=timeout,
                       env={**os.environ, 'GIT_TERMINAL_PROMPT': '0'})
    return r.returncode, r.stdout.strip(), r.stderr.strip()


def app_info():
    app['versie'] = lees(os.path.join(APP_DIR, 'VERSION'), '?')
    try:
        app['git'] = git('rev-parse', '--is-inside-work-tree', timeout=10)[1] == 'true'
    except (OSError, subprocess.SubprocessError):
        app['git'] = False
    if app['git']:
        app['commit'] = git('rev-parse', '--short', 'HEAD', timeout=10)[1]
        bron = git('remote', 'get-url', 'origin', timeout=10)[1]
        app['bron'] = re.sub(r'//[^@/]+@', '//', bron)          # eventueel token niet tonen
    # Melding van een vorige update bewaren over de herstart heen
    try:
        with open(APP_STATUS) as f:
            app.update({k: v for k, v in json.load(f).items() if k in ('systeemdeelGewijzigd', 'melding')})
    except (OSError, ValueError):
        pass


def bewaar_app_status():
    try:
        with open(APP_STATUS, 'w') as f:
            json.dump({'systeemdeelGewijzigd': app['systeemdeelGewijzigd'], 'melding': app['melding']}, f)
    except OSError:
        pass


def zoek_app_update():
    if not app['git'] or app['bezig']:
        return
    try:
        code, _, fout = git('fetch', '--quiet', timeout=90)
        if code != 0:
            with slot:
                app.update({'melding': 'GitHub niet bereikbaar', 'fout': True})
            return
        aantal = int(git('rev-list', '--count', 'HEAD..@{u}')[1] or 0)
        log = git('log', '--format=%s', '-n', '15', 'HEAD..@{u}')[1]
        lokaal = bool(git('status', '--porcelain', '--untracked-files=no')[1])
        with slot:
            app.update({'nieuw': aantal, 'wijzigingen': [r for r in log.splitlines() if r.strip()],
                        'lokaalGewijzigd': lokaal, 'fout': False,
                        'laatsteCheck': datetime.now().strftime('%H:%M')})
            if app['melding'] == 'GitHub niet bereikbaar':
                app['melding'] = ''
    except (OSError, subprocess.SubprocessError, ValueError) as e:
        with slot:
            app.update({'melding': f'Controleren mislukt: {e}'[:150], 'fout': True})


def app_update_lus():
    time.sleep(20)
    while True:
        zoek_app_update()
        time.sleep(3 * 3600)


def herstart_server():
    """Start deze server opnieuw met de nieuwe code (zelfde proces, geen root nodig)."""
    time.sleep(1)
    os.execv(sys.executable, [sys.executable, os.path.abspath(__file__)])


def werk_app_bij(forceer=False):
    with slot:
        if app['bezig'] or not app['git']:
            return False, 'Bijwerken kan nu niet'
        app.update({'bezig': True, 'melding': 'Bijwerken…', 'fout': False})
    try:
        oud = git('rev-parse', 'HEAD')[1]
        if forceer:
            code, uit, fout = git('reset', '--hard', '@{u}')
        else:
            code, uit, fout = git('merge', '--ff-only', '@{u}')
        if code != 0:
            with slot:
                app.update({'bezig': False, 'fout': True,
                            'melding': 'Bijwerken mislukt: ' + (fout or uit).splitlines()[-1][:120] if (fout or uit) else 'Bijwerken mislukt'})
            return False, app['melding']
        nieuw = git('rev-parse', 'HEAD')[1]
        gewijzigd = set(git('diff', '--name-only', oud, nieuw)[1].splitlines())
        logo = re.search(r"logo:\s*'([^']+)'", lees(os.path.join(APP_DIR, 'config.js')))
        if logo:
            SYSTEEMDEEL.add(logo.group(1))
        with slot:
            app['systeemdeelGewijzigd'] = app['systeemdeelGewijzigd'] or bool(gewijzigd & SYSTEEMDEEL)
            app.update({'bezig': False, 'nieuw': 0, 'wijzigingen': [], 'lokaalGewijzigd': False,
                        'melding': f'Bijgewerkt naar versie {lees(os.path.join(APP_DIR, "VERSION"), "?")}'})
            bewaar_app_status()
        threading.Thread(target=herstart_server, daemon=True).start()
        return True, app['melding']
    except (OSError, subprocess.SubprocessError) as e:
        with slot:
            app.update({'bezig': False, 'fout': True, 'melding': f'Bijwerken mislukt: {e}'[:150]})
        return False, app['melding']


# ------------------------------------------------------------------ wifi
def wifi_scan():
    code, uit, fout = helper('wifi-scan', timeout=40)
    if code != 0:
        raise RuntimeError(fout.strip() or 'Zoeken mislukt')
    netten = {}
    for regel in uit.splitlines():
        d = splits_nmcli(regel)
        if len(d) < 4 or not d[1]:
            continue
        ssid = d[1]
        sig = int(d[2] or 0)
        n = {'ssid': ssid, 'signaal': sig, 'beveiligd': d[3] not in ('', '--'), 'actief': d[0] == '*'}
        if ssid not in netten or sig > netten[ssid]['signaal'] or n['actief']:
            n['actief'] = n['actief'] or netten.get(ssid, {}).get('actief', False)
            netten[ssid] = n
    return sorted(netten.values(), key=lambda n: (not n['actief'], -n['signaal']))


def wifi_verbind(ssid, wachtwoord):
    args = ['wifi-connect', ssid] + ([wachtwoord] if wachtwoord else [])
    code, uit, fout = helper(*args, timeout=60)
    melding = (uit + fout).strip().splitlines()
    return code == 0, (melding[-1] if melding else '')


# ------------------------------------------------------------------ weeralarm
waarsch_cache = {'tijd': 0, 'data': []}


def kleur_van(info):
    for p in info.get('parameter', []) or []:
        if str(p.get('valueName', '')).lower() == 'awareness_level':
            v = str(p.get('value', '')).lower()
            for k in ('red', 'orange', 'yellow', 'green'):
                if k in v:
                    return k
    return {'extreme': 'red', 'severe': 'orange', 'moderate': 'yellow'}.get(str(info.get('severity', '')).lower(), 'green')


def parse_tijd(s):
    try:
        return datetime.fromisoformat(str(s).replace('Z', '+00:00'))
    except ValueError:
        return None


def waarschuwingen(regio):
    if DEMO:
        nu_d = datetime.now().astimezone()
        return [{'kleur': 'yellow', 'titel': 'Code geel: windstoten', 'tekst':
                 'Vanavond in het zuiden windstoten van 75 km/u. Let op loslatende voorwerpen.',
                 'van': nu_d.isoformat(), 'tot': nu_d.replace(hour=23, minute=0).isoformat()}]
    nu = time.time()
    sleutel = regio.lower()
    if nu - waarsch_cache['tijd'] < 600 and waarsch_cache.get('regio') == sleutel:
        return waarsch_cache['data']
    req = urllib.request.Request(METEOALARM, headers={'User-Agent': 'radio-app/1.0'})
    with urllib.request.urlopen(req, timeout=20) as r:
        data = json.load(r)
    resultaat, gezien = [], set()
    nu_dt = datetime.now(timezone.utc)
    for w in data.get('warnings', []):
        alert = w.get('alert', {}) or {}
        if str(alert.get('msgType', '')).lower() == 'cancel':
            continue
        infos = alert.get('info', []) or []
        info = next((i for i in infos if str(i.get('language', '')).lower().startswith('nl')), infos[0] if infos else None)
        if not info:
            continue
        gebieden = ' '.join(a.get('areaDesc', '') for a in info.get('area', []) or [])
        if sleutel not in gebieden.lower():
            continue
        kleur = kleur_van(info)
        if kleur == 'green':
            continue
        einde = parse_tijd(info.get('expires') or '')
        if einde and einde < nu_dt:
            continue
        begin = parse_tijd(info.get('onset') or info.get('effective') or '')
        titel = info.get('headline') or info.get('event') or 'Weerwaarschuwing'
        if titel in gezien:
            continue
        gezien.add(titel)
        resultaat.append({'kleur': kleur, 'titel': titel, 'tekst': info.get('description', ''),
                          'van': begin.isoformat() if begin else '', 'tot': einde.isoformat() if einde else ''})
    volgorde = {'red': 0, 'orange': 1, 'yellow': 2}
    resultaat.sort(key=lambda x: volgorde.get(x['kleur'], 9))
    waarsch_cache.update({'tijd': nu, 'data': resultaat, 'regio': sleutel})
    return resultaat


# ------------------------------------------------------------------ nu speelt
nuspeelt_cache = {}
DEMO_TITELS = ['Doe Maar - De bom', 'Golden Earring - Radar Love', 'Suzan & Freek - Blijf bij mij', 'Racoon - Oceaan']


def icy_titel(url, max_doorverwijzingen=4):
    """Lees artiest/titel (ICY StreamTitle) uit een radiostream. Geeft None als de zender dat niet meestuurt."""
    for _ in range(max_doorverwijzingen + 1):
        u = urllib.parse.urlsplit(url)
        if u.scheme not in ('http', 'https') or not u.hostname:
            return None
        poort = u.port or (443 if u.scheme == 'https' else 80)
        sock = socket.create_connection((u.hostname, poort), timeout=8)
        try:
            if u.scheme == 'https':
                sock = ssl.create_default_context().wrap_socket(sock, server_hostname=u.hostname)
            sock.settimeout(8)
            pad = (u.path or '/') + ('?' + u.query if u.query else '')
            host = u.hostname if u.port is None else f'{u.hostname}:{u.port}'
            sock.sendall((f'GET {pad} HTTP/1.0\r\nHost: {host}\r\nUser-Agent: radio-app/1.0\r\n'
                          'Icy-MetaData: 1\r\nAccept: */*\r\nConnection: close\r\n\r\n').encode())
            f = sock.makefile('rb')
            status_regel = f.readline(512).decode('latin-1').split()
            code = int(status_regel[1]) if len(status_regel) > 1 and status_regel[1].isdigit() else 0
            koppen = {}
            for _ in range(100):
                regel = f.readline(2048)
                if not regel or regel in (b'\r\n', b'\n'):
                    break
                k, _, v = regel.decode('latin-1').partition(':')
                koppen[k.strip().lower()] = v.strip()
            if code in (301, 302, 303, 307, 308) and koppen.get('location'):
                url = urllib.parse.urljoin(url, koppen['location'])
                continue
            metaint = int(koppen.get('icy-metaint') or 0)
            if not metaint or metaint > 1_000_000:
                return None
            for _ in range(3):                       # soms is het eerste blok leeg
                f.read(metaint)
                lengte = f.read(1)
                if not lengte:
                    return None
                meta = f.read(lengte[0] * 16)
                if not meta:
                    continue
                try:
                    tekst = meta.decode('utf-8')
                except UnicodeDecodeError:
                    tekst = meta.decode('latin-1')
                m = re.search(r"StreamTitle='(.*?)';", tekst, re.S)
                if m and m.group(1).strip():
                    return m.group(1).strip()
            return None
        finally:
            sock.close()
    return None


def nu_speelt(url):
    if DEMO:
        return DEMO_TITELS[int(time.time() // 30) % len(DEMO_TITELS)]
    nu = time.time()
    oud = nuspeelt_cache.get(url)
    if oud and nu - oud[0] < 15:
        return oud[1]
    try:
        titel = icy_titel(url)
    except (OSError, ValueError, ssl.SSLError):
        titel = None
    nuspeelt_cache[url] = (nu, titel)
    if len(nuspeelt_cache) > 50:
        nuspeelt_cache.pop(next(iter(nuspeelt_cache)))
    return titel


# ------------------------------------------------------------------ geluid (audio-uitgang en hoofdvolume)
# Werkt via pactl (PipeWire of PulseAudio), als de gewone gebruiker: geen root nodig.
demo_geluid = {'actief': 'hdmi', 'volume': 40}


def pactl(*args, timeout=8):
    env = {**os.environ, 'LC_ALL': 'C'}
    env.setdefault('XDG_RUNTIME_DIR', f'/run/user/{os.getuid()}')      # de dienst heeft die zelf niet
    r = subprocess.run(['pactl', *args], capture_output=True, text=True, timeout=timeout, env=env)
    if r.returncode != 0:
        raise RuntimeError((r.stderr.strip().splitlines() or ['pactl mislukt'])[-1])
    return r.stdout


def uitgang_label(naam, oms):
    """Begrijpelijke naam voor een audio-uitgang."""
    t = f'{naam} {oms}'.lower()
    if 'bluez' in t or 'bluetooth' in t:
        return 'Bluetooth'
    if 'hdmi' in t:
        return 'HDMI (scherm of tv)'
    if 'usb' in t:
        return 'USB-geluid'
    if 'bcm2835' in t or 'headphone' in t:
        return 'Koptelefoonaansluiting (3,5 mm)'
    return oms or naam


def parse_uitgangen(tekst, standaard):
    """Lees de uitvoer van 'pactl list sinks'."""
    uit = []
    for blok in re.split(r'^Sink #', tekst, flags=re.M)[1:]:
        naam = re.search(r'^\s*Name: (.+)$', blok, re.M)
        if not naam:
            continue
        naam = naam.group(1).strip()
        oms = re.search(r'^\s*Description: (.+)$', blok, re.M)
        oms = oms.group(1).strip() if oms else ''
        vol = re.search(r'^\s*Volume:.*?(\d+)%', blok, re.M)
        demp = re.search(r'^\s*Mute: (\w+)', blok, re.M)
        uit.append({'naam': naam, 'label': uitgang_label(naam, oms), 'omschrijving': oms,
                    'actief': naam == standaard, 'volume': int(vol.group(1)) if vol else None,
                    'gedempt': bool(demp and demp.group(1) == 'yes')})
    return uit


def geluid_status():
    if DEMO:
        namen = [('jack', 'alsa_output.platform-bcm2835_audio.stereo-fallback', 'Built-in Audio Stereo'),
                 ('hdmi', 'alsa_output.platform-fef00700.hdmi.hdmi-stereo', 'Built-in Audio Digital Stereo (HDMI)'),
                 ('usb', 'alsa_output.usb-Generic_USB_Audio-00.analog-stereo', 'USB Audio Analog Stereo')]
        return {'beschikbaar': True, 'volume': demo_geluid['volume'], 'gedempt': False,
                'uitgangen': [{'naam': n, 'label': uitgang_label(n, o), 'omschrijving': o,
                               'actief': k == demo_geluid['actief']} for k, n, o in namen]}
    try:
        m = re.search(r'^Default Sink: (.+)$', pactl('info'), re.M)
        standaard = m.group(1).strip() if m else ''
        uitgangen = parse_uitgangen(pactl('list', 'sinks'), standaard)
    except FileNotFoundError:
        return {'beschikbaar': False, 'fout': 'pactl ontbreekt. Draai één keer: bash ~/radio-app/install.sh'}
    except (OSError, subprocess.SubprocessError, RuntimeError) as e:
        return {'beschikbaar': False, 'fout': f'Geluidssysteem niet bereikbaar: {e}'[:160]}
    actief = next((u for u in uitgangen if u['actief']), None)
    return {'beschikbaar': True, 'uitgangen': uitgangen,
            'volume': actief['volume'] if actief else None, 'gedempt': bool(actief and actief['gedempt'])}


def zet_geluid(data):
    if DEMO:
        if 'uitgang' in data:
            demo_geluid['actief'] = {'alsa_output.platform-bcm2835_audio.stereo-fallback': 'jack',
                                     'alsa_output.usb-Generic_USB_Audio-00.analog-stereo': 'usb'}.get(str(data['uitgang']), 'hdmi')
        if 'volume' in data:
            demo_geluid['volume'] = max(0, min(100, int(data['volume'])))
        return geluid_status()
    if 'uitgang' in data:
        naam = str(data['uitgang'])
        # Alleen een uitgang die het systeem zelf opgeeft
        if naam not in {u['naam'] for u in geluid_status().get('uitgangen', [])}:
            raise ValueError('Onbekende audio-uitgang')
        pactl('set-default-sink', naam)
        for regel in pactl('list', 'short', 'sink-inputs').splitlines():     # wat al speelt mee verhuizen
            nr = regel.split('\t')[0]
            if nr.isdigit():
                try:
                    pactl('move-sink-input', nr, naam)
                except (RuntimeError, subprocess.SubprocessError):
                    pass
    if 'volume' in data:
        v = max(0, min(100, int(data['volume'])))
        pactl('set-sink-volume', '@DEFAULT_SINK@', f'{v}%')
        pactl('set-sink-mute', '@DEFAULT_SINK@', '0')
    return geluid_status()


# ------------------------------------------------------------------ demo
def demo_helper(*args):
    if args[0] == 'update-check':
        return 0, '7\n', ''
    if args[0] == 'wifi-scan':
        return 0, ('*:Thuisnetwerk:72:WPA2\n:Thuisnetwerk-5G:64:WPA2\n:Buren\\:Gast:41:WPA2\n'
                   ':Gratis WiFi:30:\n'), ''
    if args[0] == 'wifi-connect':
        time.sleep(2)
        return 0, 'Device succesvol geactiveerd.', ''
    return 0, '', ''


# ------------------------------------------------------------------ http
class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=APP_DIR, **kw)

    def log_message(self, *a):
        pass

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def host_ok(self):
        if self.headers.get('Host') not in TOEGESTANE_HOSTS:
            self.send_error(403)
            return False
        return True

    def json(self, data, code=200):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        n = int(self.headers.get('Content-Length') or 0)
        if n > 200_000:
            raise ValueError('te groot')
        return json.loads(self.rfile.read(n) or b'{}')

    def do_GET(self):
        if not self.host_ok():
            return
        pad = self.path.split('?')[0]
        try:
            if pad == '/api/status':
                return self.json(systeem_info())
            if pad == '/api/instellingen':
                return self.json(json.loads(lees(INSTELLINGEN, '{}') or '{}'))
            if pad == '/api/geluid':
                return self.json(geluid_status())
            if pad == '/api/wifi/scan':
                return self.json({'netwerken': wifi_scan()})
            if pad == '/api/nuspeelt':
                q = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
                return self.json({'titel': nu_speelt((q.get('url') or [''])[0][:1000])})
            if pad == '/api/waarschuwingen':
                q = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
                regio = (q.get('regio') or ['Noord-Brabant'])[0][:60]
                return self.json({'waarschuwingen': waarschuwingen(regio)})
        except Exception as e:  # noqa: BLE001 — fout netjes teruggeven aan het scherm
            return self.json({'fout': str(e)[:200]}, 500)
        if pad.startswith('/api/'):
            return self.json({'fout': 'onbekend'}, 404)
        if not self.statisch_ok():
            return self.send_error(404)
        return super().do_GET()

    def do_HEAD(self):
        if not self.host_ok():
            return
        if not self.statisch_ok():
            return self.send_error(404)
        return super().do_HEAD()

    def statisch_ok(self):
        """Alleen de bestanden van de webpagina zelf, direct in de app-map."""
        rel = os.path.relpath(self.translate_path(self.path), APP_DIR)
        if rel == '.':
            return True                                   # de map zelf: index.html
        return (os.sep not in rel and not rel.startswith('.')
                and os.path.splitext(rel)[1].lower() in STATISCH)

    def do_POST(self):
        if not self.host_ok():
            return
        pad = self.path.split('?')[0]
        try:
            data = self.body()
            if pad == '/api/instellingen':
                if not isinstance(data, dict):
                    raise ValueError('ongeldige instellingen')
                tmp = INSTELLINGEN + '.tmp'
                with open(tmp, 'w') as f:
                    json.dump(data, f, indent=2, ensure_ascii=False)
                os.replace(tmp, INSTELLINGEN)
                return self.json({'ok': True})
            if pad == '/api/wifi/verbind':
                ok, melding = wifi_verbind(str(data.get('ssid', ''))[:64], str(data.get('wachtwoord', ''))[:128])
                return self.json({'ok': ok, 'melding': melding})
            if pad == '/api/app/zoeken':
                threading.Thread(target=zoek_app_update, daemon=True).start()
                return self.json({'ok': True})
            if pad == '/api/app/bijwerken':
                ok, melding = werk_app_bij(bool(data.get('forceer')))
                return self.json({'ok': ok, 'melding': melding})
            if pad == '/api/app/melding-gelezen':
                with slot:
                    app.update({'systeemdeelGewijzigd': False, 'melding': ''})
                    bewaar_app_status()
                return self.json({'ok': True})
            if pad == '/api/updates/zoeken':
                threading.Thread(target=zoek_updates, daemon=True).start()
                return self.json({'ok': True})
            if pad == '/api/updates/installeren':
                installeer_updates()
                return self.json({'ok': True})
            if pad == '/api/geluid':
                return self.json(zet_geluid(data))
            if pad == '/api/helderheid':
                waarde = max(0, min(100, int(data.get('waarde', 100))))
                code, _, _ = helper('backlight', str(waarde), timeout=10)
                return self.json({'ok': code == 0})
            if pad in ('/api/systeem/uitzetten', '/api/systeem/herstarten'):
                taak = 'poweroff' if pad.endswith('uitzetten') else 'reboot'
                threading.Timer(1.5, lambda: helper(taak)).start()
                return self.json({'ok': True})
        except Exception as e:  # noqa: BLE001
            return self.json({'ok': False, 'fout': str(e)[:200]}, 500)
        return self.json({'fout': 'onbekend'}, 404)


if __name__ == '__main__':
    app_info()
    threading.Thread(target=update_lus, daemon=True).start()
    threading.Thread(target=app_update_lus, daemon=True).start()
    print(f'Radio-app draait op http://localhost:{PORT}' + (' (demo)' if DEMO else ''))
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
