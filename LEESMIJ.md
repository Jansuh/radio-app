# Radio Veghel: wekkerradio voor Raspberry Pi

Een schermvullende wekkerradio die vanzelf opstart, met:
- een grote klok en het weer voor **Veghel** (regen voor de komende 2 uur, verwachting voor 4 dagen)
- internetradio met jouw eigen logo, met **artiest en titel** van wat er nu speelt (tik erop voor wat er eerder speelde)
- **2 wekkers** die langzaam harder gaan, met sluimerknop. Werkt de radio niet, dan hoor je een pieptoon.
- een **slaaptimer** (💤 bovenaan: 15, 30, 60 of 90 min)
- een **KNMI-weeralarm** voor Noord-Brabant: bij code geel, oranje of rood verschijnt er bovenaan een gekleurde balk
- **instellingen op het scherm** (⚙️): wekkers, zenders zoeken en toevoegen, helderheid, nachtmodus, Wi-Fi en systeem
- **Wi-Fi kiezen** met een schermtoetsenbord
- **geluid** (⚙️ › Geluid): kies waar het geluid uit komt (koptelefoonaansluiting, HDMI of USB) en stel het hoofdvolume in
- **weerlocatie** kiezen (⚙️ › Scherm › *Andere plaats*): typ een plaatsnaam, de provincie voor het weeralarm gaat mee
- een **update-melding** (⬆ bovenaan) die je met één tik installeert
- knoppen om de Pi te **herstarten en uit te zetten**
- **de app werkt zichzelf bij via GitHub**: met één tik, of 's nachts automatisch

## Wat je nodig hebt
- Een Raspberry Pi 4 of 5 met **Raspberry Pi OS (64-bit, met bureaublad, Bookworm of nieuwer)**
- Een scherm (het officiële touchscreen of HDMI)
- Geluid: een Pi 4 heeft een koptelefoonaansluiting (3,5 mm). Een Pi 5 heeft die niet, gebruik daar een DAC-HAT, USB-speaker of HDMI-audio

## Installeren

### Via GitHub (aanrader)
Zo haalt de Pi later zelf nieuwe versies op. Open een terminal op de Pi (of log in via SSH):
```
git clone https://github.com/Jansuh/radio-app.git ~/radio-app
cd ~/radio-app && bash install.sh
sudo reboot
```
Na de herstart zie je eerst jouw logo en daarna start de app vanzelf.

- **Eigen kopie?** Maak op GitHub een *fork* van deze repository en gebruik jouw adres in het `git clone`-commando. Dan kun je zelf wijzigingen uitbrengen.
- **Privé repository?** Maak op GitHub een *fine-grained token* aan met alleen leesrechten (*Contents: Read-only*) voor deze repository. Clone dan met `https://TOKEN@github.com/JOUWNAAM/radio-app.git`. Het token staat alleen op de Pi; zet het nooit in de repository zelf.

### Via de zip
```
unzip radio-app.zip -d ~
cd ~/radio-app
bash install.sh
sudo reboot
```
Vanaf de zip werkt alles, behalve het zelf bijwerken van de app. Wil je dat later toch? Verwijder dan `~/radio-app` en clone zoals hierboven. Je instellingen staan in `~/.config/radio-app` en blijven bewaard.

## App bijwerken via GitHub

**Een nieuwe versie uitbrengen**
1. Pas de bestanden aan op GitHub of op je pc. Doe dat niet op de Pi zelf.
2. Verhoog het nummer in `VERSION`, bijvoorbeeld van 1.5.0 naar 1.6.0.
3. Commit met een duidelijke beschrijving (die zie je straks op het scherm) en push.

**Op de Pi**
- De Pi controleert elke 3 uur of er een nieuwe versie is. Je kunt ook zelf controleren via ⚙️ › Systeem › *Nu controleren*.
- Is er een nieuwe versie, dan zie je bovenaan **⬆ App-update** en in ⚙️ › Systeem de lijst met wijzigingen.
- Tik op **App bijwerken**: de app werkt zichzelf bij, herstart en het scherm herlaadt vanzelf.
- Met **Automatisch bijwerken** gebeurt dit 's nachts om 03:00, maar niet als er muziek speelt of als er binnen een uur een wekker gaat.
- Wijzigt een update `radio-helper`, `install.sh`, `start-kiosk.sh` of het logo? Dan meldt de app dat. Draai daarna één keer `bash ~/radio-app/install.sh` via SSH of met een toetsenbord.

## Hoe het werkt
- `server.py` is een kleine lokale server (alleen bereikbaar vanaf de Pi zelf). Die draait als dienst `radio-app` en regelt nu speelt, het weeralarm, Wi-Fi, updates, de helderheid en het uitzetten.
- Nu speelt werkt bij zenders die artiest en titel in hun stream meesturen. Dat doen de meeste zenders, maar niet allemaal. Bij de andere zie je "● Live".
- Systeemtaken lopen via `/usr/local/sbin/radio-helper`. Die mag alleen die vaste taken uitvoeren.
- Wat je via ⚙️ wijzigt, wordt bewaard in `~/.config/radio-app/instellingen.json`.
- Elke 6 uur controleert de Pi of er updates zijn.

## Aanpassen
- **Eigen logo:** zet je bestand (bijv. `logo.png`) in `~/radio-app`, pas `logo:` aan in `config.js` en draai daarna `bash install.sh` opnieuw. Dan wordt je logo ook het opstartscherm.
- **Kleur:** pas `--accent` aan bovenaan `style.css`.
- **Standaardinstellingen:** die staan in `config.js` (zenders, locatie, wekkers, provincie voor het weeralarm).

## Handig om te weten
- **Geen geluid?** Ga naar ⚙️ › Geluid, kies de juiste uitgang (bij een Pi 4 met boxjes: *Koptelefoonaansluiting*) en druk op *Testtoon*. Zet daar ook het hoofdvolume hoog genoeg; de schuif bij de radio regelt daarbinnen.
- Houd je **logo 3 seconden ingedrukt** om de app te herladen.
- 's Nachts maakt de eerste tik het scherm alleen wakker. Er wordt dan niet per ongeluk een knop ingedrukt.
- Helderheid op 0 's nachts zet de verlichting helemaal uit (bij het officiële touchscreen).
- Om de Pi weer aan te zetten na **Uitzetten**: haal de stekker er even uit, of druk op de aan-knop van een Pi 5.
- De Pi heeft geen klokbatterij. Valt de stroom uit zonder internet, dan klopt de tijd pas weer zodra er verbinding is. Voor een Pi 5 is er een officiële RTC-batterij.
- Om de app te stoppen via SSH: `pkill -f start-kiosk.sh; pkill chromium`
- Server herstarten of de log bekijken: `sudo systemctl restart radio-app` / `journalctl -u radio-app`
- Terug naar het normale bureaublad: verwijder `~/.config/labwc/autostart` en herstart de Pi.
- Testen op je pc: `RADIO_DEMO=1 python3 server.py` en open daarna `http://localhost:8080/?demo`
