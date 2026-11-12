(() => {
  'use strict';

  const C = window.APP_CONFIG;
  const $ = id => document.getElementById(id);
  const DEMO = new URLSearchParams(location.search).has('demo');
  const SERVER = location.protocol.startsWith('http');   // geserveerd door server.py op de Pi
  const DAGEN = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'];
  const PROVINCIES = ['Groningen', 'Friesland', 'Drenthe', 'Overijssel', 'Flevoland', 'Gelderland', 'Utrecht',
    'Noord-Holland', 'Zuid-Holland', 'Zeeland', 'Noord-Brabant', 'Limburg'];

  const opslag = {
    get(k, d) { try { const v = localStorage.getItem('radio.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('radio.' + k, JSON.stringify(v)); } catch (e) { /* negeren */ } }
  };

  const fmtTijd = new Intl.DateTimeFormat('nl-NL', { hour: '2-digit', minute: '2-digit' });
  const hoofdletter = s => s.charAt(0).toUpperCase() + s.slice(1);
  const pad = n => String(n).padStart(2, '0');
  const kopie = o => JSON.parse(JSON.stringify(o));
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Klein hulpje om elementen te bouwen
  function h(tag, props = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'html') e.innerHTML = v;
      else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
    }
    kids.flat().forEach(c => { if (c != null && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c))); });
    return e;
  }

  async function haalJson(url, ms = 15000, opties = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
      const r = await fetch(url, { ...opties, signal: ctrl.signal, cache: 'no-store' });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.fout || ('HTTP ' + r.status));
      return data;
    } finally { clearTimeout(t); }
  }

  function api(pad, data, ms = 30000) {
    if (!SERVER) return Promise.reject(new Error('Alleen beschikbaar op de Pi'));
    const opties = data === undefined ? {} :
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) };
    return haalJson(pad, ms, opties);
  }

  // =========================================================
  //  Instellingen (standaard uit config.js, wijzigingen via de server)
  // =========================================================
  const inst = {
    zenders: kopie(C.zenders),
    wekkers: kopie(C.wekkers || []),
    sluimer: C.sluimerMinuten || 9,
    nachtmodus: kopie(C.nachtmodus || { aan: false, van: 23, tot: 7, helderheid: 20 }),
    helderheid: C.helderheid ?? 100,
    weeralarm: kopie(C.weeralarm || { aan: true, regio: 'Noord-Brabant' }),
    locatie: kopie(C.locatie),
    vakantieRegio: C.schoolvakantieRegio || 'zuid',
    appAutoUpdate: true
  };

  async function laadInstellingen() {
    let bewaard = null;
    try { bewaard = await api('/api/instellingen', undefined, 5000); } catch (e) { bewaard = opslag.get('instellingen', null); }
    if (bewaard && typeof bewaard === 'object') Object.assign(inst, bewaard);
    // Wekker onthoudt de zender op naam (zodat herschikken geen kwaad kan)
    inst.wekkers.forEach(w => {
      if (typeof w.zender === 'number') w.zender = (inst.zenders[w.zender] || inst.zenders[0] || {}).naam || '';
    });
  }

  let bewaarTimer;
  function bewaar() {
    opslag.set('instellingen', inst);
    clearTimeout(bewaarTimer);
    bewaarTimer = setTimeout(() => api('/api/instellingen', inst).catch(() => {}), 600);
  }

  // =========================================================
  //  Merk / logo
  // =========================================================
  const logo = $('logo');
  logo.onerror = () => { logo.style.display = 'none'; };
  logo.src = C.logo;
  $('appnaam').textContent = C.naam || '';
  document.title = C.naam || 'Radio';

  let drukTimer;
  $('merk').addEventListener('pointerdown', () => { drukTimer = setTimeout(() => location.reload(), 3000); });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(e =>
    $('merk').addEventListener(e, () => clearTimeout(drukTimer)));
  document.addEventListener('contextmenu', e => e.preventDefault());
  // Inzoomen met twee vingers (of Ctrl + scrollwiel) uitzetten
  document.addEventListener('touchmove', e => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
  document.addEventListener('wheel', e => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
  ['gesturestart', 'gesturechange'].forEach(n => document.addEventListener(n, e => e.preventDefault()));

  // =========================================================
  //  Helderheid en nachtmodus
  // =========================================================
  let systeem = null;            // laatste status van de Pi
  let wakkerTot = 0;             // na een tik 's nachts even helder
  let gezetteHelderheid = null;
  let slikKlik = false;
  let instOpen = false;

  function isNacht(nu) {
    const n = inst.nachtmodus;
    if (!n || !n.aan) return false;
    const u = nu.getHours();
    return n.van > n.tot ? (u >= n.van || u < n.tot) : (u >= n.van && u < n.tot);
  }

  function gewensteHelderheid(nu) {
    if (!wekkerActief && !instOpen && isNacht(nu) && Date.now() > wakkerTot) return inst.nachtmodus.helderheid;
    return inst.helderheid;
  }

  function zetHelderheid(w) {
    if (systeem && systeem.backlight) {
      $('nacht').style.opacity = '0';
      if (w !== gezetteHelderheid) {
        gezetteHelderheid = w;
        api('/api/helderheid', { waarde: w }).catch(() => {});
      }
    } else {
      $('nacht').style.opacity = String(Math.min(0.92, 1 - w / 100));
    }
  }

  // Eerste tik op een gedimd scherm maakt het alleen wakker (drukt geen knop in)
  document.addEventListener('pointerdown', e => {
    const gedimd = gewensteHelderheid(new Date()) < 35 && gewensteHelderheid(new Date()) < inst.helderheid;
    wakkerTot = Date.now() + 30000;
    if (gedimd) {
      e.stopPropagation(); e.preventDefault(); slikKlik = true;
      setTimeout(() => { slikKlik = false; }, 800);     // volgt er geen klik (bijv. vegen), dan niets inslikken
    }
    zetHelderheid(gewensteHelderheid(new Date()));
  }, true);
  document.addEventListener('click', e => {
    if (slikKlik) { e.stopPropagation(); e.preventDefault(); slikKlik = false; }
  }, true);

  // =========================================================
  //  Klok
  // =========================================================
  function tik() {
    const nu = new Date();
    $('uurmin').textContent = fmtTijd.format(nu);
    $('sec').textContent = pad(nu.getSeconds());
    $('datum').textContent = hoofdletter(nu.toLocaleDateString('nl-NL',
      { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }));
    zetHelderheid(gewensteHelderheid(nu));
    controleerWekkers(nu);
    slaapTik();
    toonVolgendeWekker(nu);
    if (nu.getSeconds() === 30) autoAppUpdate(nu);
    if (wekkerActief) $('wekker-tijd').textContent = fmtTijd.format(nu);
    setTimeout(tik, 1000 - nu.getMilliseconds() + 5);
  }

  // =========================================================
  //  Weer (Open-Meteo)
  // =========================================================
  const WMO = {
    0: ['Onbewolkt', '☀️', '🌙'], 1: ['Overwegend helder', '🌤️', '🌙'], 2: ['Half bewolkt', '⛅', '☁️'],
    3: ['Bewolkt', '☁️'], 45: ['Mist', '🌫️'], 48: ['Rijpmist', '🌫️'],
    51: ['Lichte motregen', '🌦️'], 53: ['Motregen', '🌦️'], 55: ['Dichte motregen', '🌧️'],
    56: ['Lichte ijzel', '🌧️'], 57: ['IJzel', '🌧️'],
    61: ['Lichte regen', '🌦️'], 63: ['Regen', '🌧️'], 65: ['Zware regen', '🌧️'],
    66: ['Lichte ijzelregen', '🌧️'], 67: ['IJzelregen', '🌧️'],
    71: ['Lichte sneeuw', '🌨️'], 73: ['Sneeuw', '🌨️'], 75: ['Zware sneeuw', '❄️'], 77: ['Sneeuwkorrels', '🌨️'],
    80: ['Lichte buien', '🌦️'], 81: ['Buien', '🌧️'], 82: ['Zware buien', '⛈️'],
    85: ['Sneeuwbuien', '🌨️'], 86: ['Zware sneeuwbuien', '❄️'],
    95: ['Onweer', '⛈️'], 96: ['Onweer met hagel', '⛈️'], 99: ['Zwaar onweer met hagel', '⛈️']
  };
  const weerInfo = (code, dag = true) => {
    const w = WMO[code] || ['Onbekend', '🌡️'];
    return { oms: w[0], icoon: (!dag && w[2]) ? w[2] : w[1] };
  };
  const windRichting = g => ['N', 'NO', 'O', 'ZO', 'Z', 'ZW', 'W', 'NW'][Math.round(g / 45) % 8];
  const beaufort = kmh => [1, 6, 12, 20, 29, 39, 50, 62, 75, 89, 103, 118].filter(t => kmh >= t).length;

  function haalWeer() {
    const { lat, lon } = inst.locatie;
    return haalJson('https://api.open-meteo.com/v1/forecast' +
      `?latitude=${lat}&longitude=${lon}` +
      '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m,is_day' +
      '&minutely_15=precipitation&forecast_minutely_15=12' +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset' +
      '&timezone=Europe%2FAmsterdam&forecast_days=4');
  }

  function toonWeer(d, verouderd = false) {
    const c = d.current;
    const w = weerInfo(c.weather_code, c.is_day === 1);
    $('weer-icoon').textContent = w.icoon;
    $('weer-temp').textContent = Math.round(c.temperature_2m) + '°';
    $('weer-oms').textContent = w.oms;
    $('weer-details').innerHTML = [
      `Voelt als ${Math.round(c.apparent_temperature)}°`,
      `Wind ${windRichting(c.wind_direction_10m)} ${beaufort(c.wind_speed_10m)} Bft`,
      `Vocht ${Math.round(c.relative_humidity_2m)}%`
    ].map(s => `<span>${s}</span>`).join('');

    const m = d.minutely_15;
    if (m && m.time) {
      const vanaf = Date.now() - 15 * 60000;
      const rijen = m.time.map((t, i) => ({ t: new Date(t), mm: m.precipitation[i] || 0 }))
        .filter(r => r.t.getTime() >= vanaf).slice(0, 8);
      const max = Math.max(0.5, ...rijen.map(r => r.mm));
      $('regen-balken').innerHTML = rijen.map(r =>
        `<div style="height:${Math.max(6, r.mm / max * 100)}%;opacity:${r.mm > 0 ? 0.95 : 0.2}"></div>`).join('');
      const eerste = rijen.find(r => r.mm >= 0.1);
      $('regen-tekst').textContent = !eerste ? '☂️ Droog de komende 2 uur'
        : rijen.indexOf(eerste) === 0 ? '🌧️ Het regent nu'
        : `🌧️ Regen verwacht rond ${fmtTijd.format(eerste.t)}`;
    }

    const dg = d.daily;
    $('verwachting').innerHTML = dg.time.map((t, i) => {
      const wi = weerInfo(dg.weather_code[i]);
      const naam = i === 0 ? 'Vandaag'
        : hoofdletter(new Date(t + 'T12:00').toLocaleDateString('nl-NL', { weekday: 'short' }));
      return `<div class="dag"><div>${naam}</div><div class="d-icoon">${wi.icoon}</div>` +
        `<div><span class="d-max">${Math.round(dg.temperature_2m_max[i])}°</span> ` +
        `<span class="d-min">${Math.round(dg.temperature_2m_min[i])}°</span></div>` +
        `<div class="klein">💧 ${dg.precipitation_probability_max[i] ?? 0}%</div></div>`;
    }).join('');

    const uurMin = s => s.slice(11, 16);
    $('zon').textContent = `🌅 ${uurMin(dg.sunrise[0])}    🌇 ${uurMin(dg.sunset[0])}`;
    $('weer-update').textContent = verouderd
      ? `${inst.locatie.naam} · laatst bekende weer, geen verbinding`
      : `${inst.locatie.naam} · bijgewerkt ${fmtTijd.format(new Date())} · Open-Meteo`;
  }

  let weerGetoond = false, weerTimer = null;
  async function ververWeer() {
    clearTimeout(weerTimer);
    try {
      const d = DEMO ? demoWeer() : await haalWeer();
      toonWeer(d);
      weerGetoond = true;
      opslag.set('weer', d);
      zetOnline(true);
      weerTimer = setTimeout(ververWeer, C.weerVerversMinuten * 60000);
    } catch (e) {
      zetOnline(false);
      const oud = opslag.get('weer', null);
      if (oud && !weerGetoond) { try { toonWeer(oud, true); } catch (x) { /* negeren */ } }
      $('weer-update').textContent = 'Geen verbinding, nieuwe poging over 1 minuut';
      weerTimer = setTimeout(ververWeer, 60000);
    }
  }

  function zetOnline(aan) { $('netwerk').classList.toggle('uit', !aan); }
  window.addEventListener('offline', () => zetOnline(false));

  // =========================================================
  //  Weeralarm (KNMI via MeteoAlarm)
  // =========================================================
  const CODE = { yellow: 'Code geel', orange: 'Code oranje', red: 'Code rood' };
  let waarschuwingen = [];

  async function ververWaarschuwingen() {
    if (inst.weeralarm && inst.weeralarm.aan) {
      try {
        if (DEMO && !SERVER) {
          waarschuwingen = [{ kleur: 'yellow', titel: 'Code geel: windstoten', tekst: 'Demo-waarschuwing.', van: '', tot: '' }];
        } else {
          const d = await api('/api/waarschuwingen?regio=' + encodeURIComponent(inst.weeralarm.regio || 'Noord-Brabant'));
          waarschuwingen = d.waarschuwingen || [];
        }
      } catch (e) { /* bij fout: laatste stand laten staan */ }
    } else {
      waarschuwingen = [];
    }
    toonWaarschuwingen();
    setTimeout(ververWaarschuwingen, 10 * 60000);
  }

  const waarschTitel = w => /^\s*code/i.test(w.titel) ? w.titel : `${CODE[w.kleur] || 'Waarschuwing'}: ${w.titel}`;
  const tijdKort = iso => iso ? hoofdletter(new Date(iso).toLocaleString('nl-NL',
    { weekday: 'short', hour: '2-digit', minute: '2-digit' })) : '';

  function toonWaarschuwingen() {
    const k = $('waarsch-knop');
    if (!waarschuwingen.length) { k.classList.add('verborgen'); return; }
    const w = waarschuwingen[0];
    k.className = 'pil waarsch ' + w.kleur;
    k.textContent = '⚠️ ' + waarschTitel(w) + (waarschuwingen.length > 1 ? ` (+${waarschuwingen.length - 1})` : '');
  }

  $('waarsch-knop').addEventListener('click', () => {
    const html = waarschuwingen.map(w =>
      `<div style="text-align:left;margin-bottom:2vh"><b>⚠️ ${esc(waarschTitel(w))}</b>` +
      `<small>${esc(tijdKort(w.van))}${w.tot ? ' – ' + esc(tijdKort(w.tot)) : ''}</small>` +
      `<small>${esc(w.tekst)}</small></div>`).join('') +
      `<small>Bron: KNMI via MeteoAlarm · ${esc(inst.weeralarm.regio)}</small>`;
    meld(html);
  });

  // =========================================================
  //  Radio
  // =========================================================
  const audio = new Audio();
  audio.preload = 'none';

  let huidig = -1, huidigNaam = null;
  let speelt = false, sessie = 0, gefaald = -1, poging = 0;
  let herstelTimer = null, waakTimer = null;
  let volumeOverride = null;          // gebruikt door wekker (aanzwellen) en slaaptimer (wegsterven)

  const zenders = () => inst.zenders;
  const sliderVolume = () => Number($('volume').value) / 100;
  function status(t, metTitel = false) {
    const el = $('zender-status');
    el.textContent = t;
    el.classList.toggle('met-titel', metTitel);
  }
  function knop() { $('play').innerHTML = speelt ? '■&#xFE0E;' : '▶&#xFE0E;'; }
  function markeer() {
    [...$('zenders').children].forEach((b, i) => b.classList.toggle('actief', i === huidig));
  }

  function bouwZenders() {
    const el = $('zenders');
    el.innerHTML = '';
    zenders().forEach((z, i) => {
      el.appendChild(h('button', { class: 'zender', onclick: () => (i === huidig && speelt) ? stop(true) : speel(i) }, z.naam));
    });
    huidig = zenders().findIndex(z => z.naam === huidigNaam);
    markeer();
  }

  async function zoekStations(naam, alleenNL = true) {
    const q = `stations/search?name=${encodeURIComponent(naam)}${alleenNL ? '&countrycode=NL' : ''}` +
      '&hidebroken=true&order=clickcount&reverse=true&limit=15';
    for (const s of ['de1', 'de2', 'fi1', 'nl1', 'at1']) {
      try {
        const lijst = await haalJson(`https://${s}.api.radio-browser.info/json/${q}`, 8000);
        return lijst.filter(x => x.url_resolved && !/\.m3u8/i.test(x.url_resolved));
      } catch (e) { /* volgende server */ }
    }
    throw new Error('Zoekdienst niet bereikbaar');
  }

  async function zoekStream(naam) {
    try {
      const lijst = await zoekStations(naam);
      const best = lijst.find(x => /mp3|aac/i.test(x.codec)) || lijst[0];
      return best ? best.url_resolved : null;
    } catch (e) { return null; }
  }

  async function streamUrl(z, opnieuwZoeken) {
    const sleutel = 'stream.' + z.naam + '|' + (z.url || '');
    if (!opnieuwZoeken) {
      const cache = opslag.get(sleutel, null);
      if (cache) return cache;
      if (z.url) return z.url;
    }
    const gevonden = await zoekStream(z.zoek || z.naam);
    if (gevonden) opslag.set(sleutel, gevonden);
    return gevonden;
  }

  async function speel(i, p = 0) {
    const z = zenders()[i];
    if (!z) return;
    const mijn = ++sessie;
    clearTimeout(herstelTimer); clearTimeout(waakTimer);
    huidig = i; huidigNaam = z.naam; speelt = true; poging = p;
    opslag.set('zenderNaam', z.naam);
    if (p === 0) stopNuSpeelt();
    markeer(); knop();
    $('zender-naam').textContent = z.naam;
    status(p === 1 ? 'Stream opzoeken…' : 'Verbinden…');

    let url = null;
    try { url = await streamUrl(z, p === 1); } catch (e) { url = null; }
    if (mijn !== sessie) return;
    if (!url) return fout(mijn);

    audio.src = url;
    audio.volume = volumeOverride ?? sliderVolume();
    waak(mijn);
    audio.play().catch(e => {
      if (mijn !== sessie) return;
      if (e.name === 'NotAllowedError') { speelt = false; knop(); status('Tik op ▶ om te starten'); }
      else if (e.name !== 'AbortError') fout(mijn);
    });
  }

  function fout(s) {
    if (s !== sessie || !speelt || gefaald === s) return;
    gefaald = s;
    clearTimeout(waakTimer);
    if (poging === 0) {
      speel(huidig, 1);
    } else {
      status('Zender niet bereikbaar, opnieuw over 15 sec');
      herstelTimer = setTimeout(() => { if (speelt) speel(huidig, 0); }, 15000);
    }
  }

  function waak(s) {
    clearTimeout(waakTimer);
    waakTimer = setTimeout(() => {
      if (s === sessie && speelt) { status('Verbinding hapert, opnieuw verbinden…'); fout(s); }
    }, 20000);
  }

  // doorGebruiker = true als iemand zelf op stop drukt (dan ook slaaptimer stoppen)
  function stop(doorGebruiker = false) {
    sessie++;
    speelt = false;
    clearTimeout(herstelTimer); clearTimeout(waakTimer);
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    stopNuSpeelt();
    knop(); status('Gestopt');
    if (doorGebruiker) slaapStop();
  }

  audio.addEventListener('playing', () => {
    clearTimeout(waakTimer); poging = 0; zetOnline(true);
    toonLive();
    startNuSpeelt();
  });
  audio.addEventListener('waiting', () => { if (speelt) { status('Bufferen…'); waak(sessie); } });
  audio.addEventListener('stalled', () => { if (speelt) waak(sessie); });
  audio.addEventListener('error', () => { if (audio.getAttribute('src')) fout(sessie); });
  audio.addEventListener('ended', () => { if (speelt) herstelTimer = setTimeout(() => speel(huidig, 0), 2000); });
  window.addEventListener('online', () => {
    zetOnline(true);
    if (speelt && huidig >= 0 && (audio.paused || audio.error)) speel(huidig, 0);
  });

  $('play').addEventListener('click', () => {
    if (speelt) stop(true);
    else if (zenders().length) speel(huidig >= 0 ? huidig : 0);
  });

  const vol = $('volume');
  vol.value = opslag.get('volume', C.standaardVolume ?? 60);
  vol.addEventListener('input', () => {
    volumeOverride = null;
    audio.volume = sliderVolume();
    opslag.set('volume', Number(vol.value));
  });


  // =========================================================
  //  Nu speelt (artiest en titel, uitgelezen door de server op de Pi)
  // =========================================================
  let nuTitel = null, nuTimer = null;
  const geschiedenis = [];          // { titel, zender, tijd }

  function toonLive() {
    if (!speelt) return;
    if (nuTitel) status('♪ ' + nuTitel, true);
    else status('● Live');
  }

  function bruikbareTitel(t, zenderNaam) {
    if (!t) return null;
    t = t.replace(/\s+/g, ' ').trim();
    const schoon = t.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (t.length < 3 || schoon === (zenderNaam || '').toLowerCase().replace(/[^a-z0-9]/g, '')) return null;
    if (/^(advert|reclame|commercial|spot|jingle|nieuws|news)\b/i.test(t)) return null;
    if (/^[-\s]+$/.test(t)) return null;
    return t.replace(/^\s*-\s*|\s*-\s*$/g, '');
  }

  function startNuSpeelt() {
    if (!SERVER || nuTimer) return;
    const poll = async () => {
      const src = audio.getAttribute('src');
      if (!speelt || !src) { nuTimer = null; return; }
      const mijn = sessie;
      try {
        const d = await api('/api/nuspeelt?url=' + encodeURIComponent(src), undefined, 20000);
        if (mijn !== sessie || !speelt) { nuTimer = null; return; }
        const naam = huidigNaam;
        const titel = bruikbareTitel(d.titel, naam);
        if (titel !== nuTitel) {
          nuTitel = titel;
          if (titel && (!geschiedenis.length || geschiedenis[0].titel !== titel)) {
            geschiedenis.unshift({ titel, zender: naam, tijd: new Date() });
            geschiedenis.length = Math.min(geschiedenis.length, 15);
          }
          if (!audio.paused) toonLive();
        }
      } catch (e) { /* stil negeren */ }
      nuTimer = setTimeout(poll, 20000);
    };
    nuTimer = setTimeout(poll, 500);
  }

  function stopNuSpeelt() {
    clearTimeout(nuTimer); nuTimer = null;
    nuTitel = null;
  }

  document.querySelector('.nuspeelt').addEventListener('click', () => {
    if (huidig < 0) return;
    const naam = zenders()[huidig] ? zenders()[huidig].naam : '';
    let html = `<b>${esc(naam)}</b>`;
    html += nuTitel ? `<small>Nu: ♪ ${esc(nuTitel)}</small>`
      : `<small>${speelt ? 'Deze zender stuurt op dit moment geen artiest en titel mee.' : 'Er speelt nu niets.'}</small>`;
    const eerder = geschiedenis.filter(g => g.titel !== nuTitel || g.zender !== naam).slice(0, 8);
    if (eerder.length) {
      html += '<div style="text-align:left;margin-top:2vh"><small><b>Eerder gespeeld</b></small>' +
        eerder.map(g => `<small>${fmtTijd.format(g.tijd)} · ${esc(g.titel)}` +
          (g.zender !== naam ? ` <span style="opacity:.7">(${esc(g.zender)})</span>` : '') + '</small>').join('') + '</div>';
    }
    meld(html);
  });

  // =========================================================
  //  Slaaptimer
  // =========================================================
  const SLAAP = [0, 15, 30, 60, 90];
  let slaapStap = 0, slaapEinde = null, slaapWegsterven = false;

  $('slaap-knop').addEventListener('click', () => {
    slaapStap = (slaapStap + 1) % SLAAP.length;
    if (!SLAAP[slaapStap]) { slaapStop(); return; }
    slaapEinde = Date.now() + SLAAP[slaapStap] * 60000;
    if (!speelt && zenders().length) speel(huidig >= 0 ? huidig : 0);
    toonSlaap();
  });

  function slaapStop() {
    if (slaapWegsterven) { volumeOverride = null; audio.volume = sliderVolume(); }
    slaapStap = 0; slaapEinde = null; slaapWegsterven = false;
    toonSlaap();
  }

  function slaapTik() {
    if (!slaapEinde) return;
    const rest = slaapEinde - Date.now();
    if (rest <= 0) { stop(); slaapStop(); status('Slaaptimer: gestopt'); return; }
    if (rest <= 30000) {                    // laatste 30 sec zacht wegsterven
      slaapWegsterven = true;
      volumeOverride = sliderVolume() * rest / 30000;
      audio.volume = volumeOverride;
    }
    toonSlaap();
  }

  function toonSlaap() {
    const k = $('slaap-knop');
    if (!slaapEinde) { k.textContent = '💤'; k.classList.remove('aan'); return; }
    k.textContent = `💤 ${Math.max(1, Math.ceil((slaapEinde - Date.now()) / 60000))} min`;
    k.classList.add('aan');
  }

  // =========================================================
  //  Wekker
  // =========================================================
  let wekkerActief = null;          // { i }
  let sluimerTot = null, sluimerIndex = null;
  let laatsteAfgegaan = opslag.get('wekkerLaatst', '');
  let fadeTimer = null, terugvalTimer = null, autoUitTimer = null;
  let piepCtx = null, piepTimer = null;
  const wekAudio = new Audio();       // eigen wekgeluid (bestand), speelt in een lus
  wekAudio.loop = true;

  // ---------- Vrije dagen: feestdagen (berekend) en schoolvakanties (van de server) ----------
  const datumSleutel = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const REGIOS = ['noord', 'midden', 'zuid'];

  function paasdag(j) {                 // eerste paasdag, algoritme van Meeus/Jones/Butcher
    const a = j % 19, b = Math.floor(j / 100), c = j % 100, d = Math.floor(b / 4), e = b % 4;
    const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), hh = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - hh - k) % 7, m = Math.floor((a + 11 * hh + 22 * l) / 451);
    return new Date(j, Math.floor((hh + l - 7 * m + 114) / 31) - 1, ((hh + l - 7 * m + 114) % 31) + 1);
  }

  const feestCache = {};
  function feestdagen(j) {
    if (feestCache[j]) return feestCache[j];
    const lijst = {};
    const zet = (d, naam) => { lijst[datumSleutel(d)] = naam; };
    const pasen = paasdag(j);
    const naPasen = n => new Date(j, pasen.getMonth(), pasen.getDate() + n);
    zet(new Date(j, 0, 1), 'Nieuwjaarsdag');
    zet(pasen, 'Eerste Paasdag'); zet(naPasen(1), 'Tweede Paasdag');
    zet(new Date(j, 3, new Date(j, 3, 27).getDay() === 0 ? 26 : 27), 'Koningsdag');   // valt 27 april op zondag, dan de 26e
    if (j % 5 === 0) zet(new Date(j, 4, 5), 'Bevrijdingsdag');                         // alleen in lustrumjaren een vrije dag
    zet(naPasen(39), 'Hemelvaartsdag');
    zet(naPasen(49), 'Eerste Pinksterdag'); zet(naPasen(50), 'Tweede Pinksterdag');
    zet(new Date(j, 11, 25), 'Eerste Kerstdag'); zet(new Date(j, 11, 26), 'Tweede Kerstdag');
    return (feestCache[j] = lijst);
  }
  const feestdag = d => feestdagen(d.getFullYear())[datumSleutel(d)] || null;

  let vakanties = opslag.get('schoolvakanties', []);
  async function ververVakanties() {
    try {
      const d = await api('/api/schoolvakanties', undefined, 30000);
      if (Array.isArray(d.vakanties)) { vakanties = d.vakanties; opslag.set('schoolvakanties', vakanties); }
    } catch (e) { /* laatste lijst blijven gebruiken */ }
    vorigeWekkerTekst = '';
    setTimeout(ververVakanties, 24 * 3600e3);
  }
  const vanRegio = v => { const r = String(v.regio).toLowerCase(); return r === inst.vakantieRegio || r === 'heel nederland'; };
  function schoolvakantie(d) {
    const s = datumSleutel(d);
    const v = vakanties.find(x => vanRegio(x) && x.van <= s && s <= x.tot);
    return v ? v.naam : null;
  }
  // Waarom deze wekker op deze dag niet afgaat (of null als hij gewoon afgaat)
  const vrijeReden = (d, w) => (w.nietFeestdag && feestdag(d)) || (w.nietVakantie && schoolvakantie(d)) || null;

  function controleerWekkers(nu) {
    if (wekkerActief) return;
    if (sluimerTot && nu >= sluimerTot) {
      const i = sluimerIndex; sluimerTot = null; sluimerIndex = null;
      return gaAf(i);
    }
    const hhmm = fmtTijd.format(nu);
    inst.wekkers.forEach((w, i) => {
      if (wekkerActief || !w.aan || w.tijd !== hhmm || !w.dagen.includes(nu.getDay())) return;
      if (vrijeReden(nu, w)) return;                       // feestdag of schoolvakantie: overslaan
      const sleutel = nu.toDateString() + '|' + i + '|' + w.tijd;
      if (laatsteAfgegaan === sleutel) return;
      laatsteAfgegaan = sleutel;
      opslag.set('wekkerLaatst', sleutel);
      gaAf(i);
    });
  }

  function gaAf(i) {
    const w = inst.wekkers[i];
    if (!w) return;
    wekkerActief = { i };
    slaapStop();
    sluitToetsenbord(null);
    const zi = Math.max(0, zenders().findIndex(z => z.naam === w.zender));
    $('wekker-tijd').textContent = fmtTijd.format(new Date());
    const soort = w.geluid || 'radio';
    const radio = soort === 'radio' && zenders().length > 0;
    $('wekker-info').textContent = radio ? zenders()[zi].naam : soort.startsWith('bestand:') ? soort.slice(8) : 'Wekker';
    $('sluimer').textContent = `Sluimeren ${inst.sluimer} min`;
    $('wekker-scherm').classList.remove('verborgen');

    const doel = (w.volume ?? 50) / 100;
    volumeOverride = Math.min(doel, 0.05);
    if (radio) speel(zi);
    else {
      stop();
      if (soort.startsWith('bestand:')) speelWekBestand(soort.slice(8)); else startPiep();
    }

    clearInterval(fadeTimer);
    fadeTimer = setInterval(() => {         // in ± 90 sec aanzwellen tot het ingestelde volume
      if (volumeOverride === null) return;
      volumeOverride = Math.min(doel, volumeOverride + doel / 60);
      audio.volume = volumeOverride;
      wekAudio.volume = volumeOverride;
    }, 1500);

    clearTimeout(terugvalTimer);
    terugvalTimer = setTimeout(() => {      // geen radio na 25 sec? Dan piepen.
      if (wekkerActief && radio && (audio.paused || audio.readyState < 3)) {
        stop(); startPiep();
        $('wekker-info').textContent = 'Radio niet bereikbaar';
      }
    }, 25000);

    clearTimeout(autoUitTimer);
    autoUitTimer = setTimeout(() => wekkerUit(true), 60 * 60000);
  }

  // Eigen geluidsbestand afspelen; lukt dat niet, dan de pieptoon
  function speelWekBestand(naam) {
    const terugval = () => {
      if (!wekkerActief || piepTimer) return;
      wekAudio.pause(); startPiep();
      $('wekker-info').textContent = 'Wekgeluid niet gevonden';
    };
    wekAudio.onerror = terugval;
    wekAudio.src = '/geluiden/' + encodeURIComponent(naam);
    wekAudio.volume = volumeOverride ?? 0.5;
    wekAudio.play().catch(terugval);
  }

  function stopWekkerGeluid() {
    clearInterval(fadeTimer); clearTimeout(terugvalTimer); clearTimeout(autoUitTimer);
    stopPiep();
    wekAudio.onerror = null; wekAudio.pause(); wekAudio.removeAttribute('src');
    stop();
    volumeOverride = null;
    audio.volume = sliderVolume();
    $('wekker-scherm').classList.add('verborgen');
    wekkerActief = null;
    wakkerTot = Date.now() + 60000;
  }

  function wekkerUit() { stopWekkerGeluid(); status('Wekker uit'); }

  $('wekker-uit').addEventListener('click', wekkerUit);
  $('sluimer').addEventListener('click', () => {
    const i = wekkerActief ? wekkerActief.i : 0;
    stopWekkerGeluid();
    sluimerIndex = i;
    sluimerTot = new Date(Date.now() + inst.sluimer * 60000);
    status(`Sluimert tot ${fmtTijd.format(sluimerTot)}`);
  });

  function startPiep() {
    try {
      piepCtx = piepCtx || new (window.AudioContext || window.webkitAudioContext)();
      piepCtx.resume();
    } catch (e) { return; }
    const toon = () => {
      const t = piepCtx.currentTime;
      for (let k = 0; k < 2; k++) {
        const o = piepCtx.createOscillator(), g = piepCtx.createGain();
        o.frequency.value = 880;
        g.gain.value = Math.max(0.05, volumeOverride ?? 0.5);
        o.connect(g).connect(piepCtx.destination);
        o.start(t + k * 0.25); o.stop(t + k * 0.25 + 0.15);
      }
    };
    stopPiep(); toon();
    piepTimer = setInterval(toon, 1200);
  }
  function stopPiep() { clearInterval(piepTimer); piepTimer = null; }

  // Korte testtoon (tab Geluid), los van de radio
  function testToon() {
    try {
      piepCtx = piepCtx || new (window.AudioContext || window.webkitAudioContext)();
      piepCtx.resume();
      const t = piepCtx.currentTime;
      [660, 880, 1100].forEach((f, k) => {
        const o = piepCtx.createOscillator(), g = piepCtx.createGain();
        o.frequency.value = f; g.gain.value = 0.4;
        o.connect(g).connect(piepCtx.destination);
        o.start(t + k * 0.3); o.stop(t + k * 0.3 + 0.22);
      });
    } catch (e) { /* geen geluid mogelijk */ }
  }

  function volgendeWekker(nu) {
    let beste = null;
    inst.wekkers.forEach(w => {
      if (!w.aan || !w.dagen.length) return;
      const [hh, mm] = w.tijd.split(':').map(Number);
      for (let d = 0; d < 70; d++) {
        const t = new Date(nu); t.setDate(t.getDate() + d); t.setHours(hh, mm, 0, 0);
        if (t <= nu || !w.dagen.includes(t.getDay()) || vrijeReden(t, w)) continue;
        if (!beste || t < beste) beste = t;
        break;
      }
    });
    return beste;
  }

  let vorigeWekkerTekst = '';
  function toonVolgendeWekker(nu) {
    let tekst = '';
    if (sluimerTot) tekst = `⏰ Sluimert tot ${fmtTijd.format(sluimerTot)}`;
    else {
      const v = volgendeWekker(nu);
      if (v) tekst = `⏰ ${v - nu < 20 * 3600e3 ? '' : hoofdletter(DAGEN[v.getDay()]) + ' '}${v - nu > 6.5 * 864e5 ? v.getDate() + '-' + (v.getMonth() + 1) + ' ' : ''}${fmtTijd.format(v)}`;
    }
    if (tekst === vorigeWekkerTekst) return;
    vorigeWekkerTekst = tekst;
    const k = $('volgende-wekker');
    k.textContent = tekst;
    k.classList.toggle('verborgen', !tekst);
  }
  $('volgende-wekker').addEventListener('click', () => openInstellingen('wekker'));

  // =========================================================
  //  Status van de Pi (updates, wifi, temperatuur)
  // =========================================================
  let statusTimer = null;
  async function ververStatus() {
    clearTimeout(statusTimer);
    if (SERVER) {
      try { systeem = await api('/api/status', undefined, 10000); } catch (e) { systeem = null; }
    }
    controleerNieuweVersie();
    toonUpdateKnop();
    if (instOpen && huidigeTab === 'systeem') tekenTab('systeem');
    const snel = systeem && systeem.upgrade && systeem.upgrade.bezig;
    statusTimer = setTimeout(ververStatus, snel ? 3000 : (instOpen ? 10000 : 60000));
  }

  // Draait de server na een app-update een nieuwe versie? Dan de pagina herladen.
  let geladenCommit = null;
  function controleerNieuweVersie() {
    const a = systeem && systeem.app;
    if (!a || !a.commit) return;
    if (geladenCommit === null) { geladenCommit = a.commit; return; }
    if (a.commit !== geladenCommit && !wekkerActief) {
      location.reload();
    }
  }

  // 's Nachts tussen 03:00 en 04:00 automatisch bijwerken, als er niets speelt en er geen wekker in de buurt is
  let autoUpdateDag = '';
  function autoAppUpdate(nu) {
    const a = systeem && systeem.app;
    if (!inst.appAutoUpdate || !a || !a.git || !(a.nieuw > 0) || a.lokaalGewijzigd || a.bezig) return;
    if (nu.getHours() !== 3 || autoUpdateDag === nu.toDateString()) return;
    if (wekkerActief || speelt || instOpen || sluimerTot) return;
    const v = volgendeWekker(nu);
    if (v && v - nu < 60 * 60000) return;
    autoUpdateDag = nu.toDateString();
    api('/api/app/bijwerken', {}).catch(() => {});
  }

  function toonUpdateKnop() {
    const k = $('update-knop');
    let tekst = '';
    if (systeem) {
      const a = systeem.app || {};
      if ((systeem.upgrade && systeem.upgrade.bezig) || a.bezig) tekst = '⬆ Bijwerken…';
      else if (systeem.herstartNodig) tekst = '↻ Herstart nodig';
      else if (a.nieuw > 0) tekst = '⬆ App-update';
      else if (systeem.updates > 0) tekst = `⬆ ${systeem.updates} update${systeem.updates === 1 ? '' : 's'}`;
    }
    k.textContent = tekst;
    k.classList.toggle('verborgen', !tekst);
  }
  $('update-knop').addEventListener('click', () => openInstellingen('systeem'));

  // =========================================================
  //  Dialoog
  // =========================================================
  function dialoog(html, knoppen) {
    return new Promise(res => {
      $('dialoog-tekst').innerHTML = html;
      const k = $('dialoog-knoppen');
      k.innerHTML = '';
      knoppen.forEach(([label, waarde, klasse]) => k.appendChild(h('button', {
        class: 'knop ' + (klasse || ''),
        onclick: () => { $('dialoog').classList.add('verborgen'); res(waarde); }
      }, label)));
      $('dialoog').classList.remove('verborgen');
    });
  }
  const bevestig = (html, ja = 'Ja', klasse = '') => dialoog(html, [['Annuleren', false, 'zacht'], [ja, true, klasse]]);
  const meld = html => dialoog(html, [['OK', true]]);

  // =========================================================
  //  Schermtoetsenbord
  // =========================================================
  const TB_LAGEN = {
    letters: ['1234567890', 'qwertyuiop', 'asdfghjkl', '⇧zxcvbnm⌫'],
    symbolen: ['1234567890', '!@#$%&*()-', '_=+[]{};:\'', '"/\\,.<>?~⌫']
  };
  let tbKlaar = null;

  function sluitToetsenbord(waarde) {
    $('toetsenbord').classList.add('verborgen');
    if (tbKlaar) { const k = tbKlaar; tbKlaar = null; k(waarde); }
  }

  function toetsenbord({ label = '', waarde = '', wachtwoord = false, ok = 'OK' } = {}) {
    sluitToetsenbord(null);
    return new Promise(res => {
      tbKlaar = res;
      let tekst = waarde, shift = false, laag = 'letters', verberg = wachtwoord;
      $('tb-label').textContent = label;
      const oog = $('tb-oog');
      oog.classList.toggle('verborgen', !wachtwoord);
      oog.onclick = () => { verberg = !verberg; toon(); };

      const toon = () => { $('tb-waarde').textContent = verberg ? '•'.repeat(tekst.length) : tekst; };
      const teken = () => {
        const box = $('tb-toetsen');
        box.innerHTML = '';
        TB_LAGEN[laag].forEach(rij => {
          const r = h('div', { class: 'tb-rij' });
          [...rij].forEach(t => {
            if (t === '⇧') r.appendChild(h('button', { class: 'breed2' + (shift ? ' aan' : ''), onclick: () => { shift = !shift; teken(); } }, '⇧'));
            else if (t === '⌫') r.appendChild(h('button', { class: 'breed2', onclick: () => { tekst = tekst.slice(0, -1); toon(); } }, '⌫'));
            else {
              const teken1 = shift ? t.toUpperCase() : t;
              r.appendChild(h('button', { onclick: () => {
                tekst += teken1; toon();
                if (shift) { shift = false; teken(); }
              } }, teken1));
            }
          });
          box.appendChild(r);
        });
        box.appendChild(h('div', { class: 'tb-rij' },
          h('button', { class: 'breed2', onclick: () => { laag = laag === 'letters' ? 'symbolen' : 'letters'; shift = false; teken(); } },
            laag === 'letters' ? '?123' : 'ABC'),
          h('button', { class: 'spatie', onclick: () => { tekst += ' '; toon(); } }, 'spatie'),
          h('button', { onclick: () => { tekst += '.'; toon(); } }, '.'),
          h('button', { class: 'breed2', onclick: () => sluitToetsenbord(null) }, 'Annuleren'),
          h('button', { class: 'breed2 ok', onclick: () => sluitToetsenbord(tekst) }, ok)
        ));
      };
      toon(); teken();
      $('toetsenbord').classList.remove('verborgen');
    });
  }

  // =========================================================
  //  Instellingenscherm
  // =========================================================
  let huidigeTab = 'wekker';

  function openInstellingen(tab = 'wekker') {
    instOpen = true; geluid = null;
    $('instellingen').classList.remove('verborgen');
    tekenTab(tab);
    ververStatus();
    laadWekBestanden();
  }

  function sluitInstellingen() {
    instOpen = false;
    $('instellingen').classList.add('verborgen');
    bewaar();
    bouwZenders();
    vorigeWekkerTekst = '';
    ververStatus();
  }

  $('instel-knop').addEventListener('click', () => openInstellingen(huidigeTab));
  $('instel-sluit').addEventListener('click', sluitInstellingen);
  $('tabs').addEventListener('click', e => {
    const b = e.target.closest('button[data-tab]');
    if (b) { geluid = null; tekenTab(b.dataset.tab); }
  });

  function tekenTab(tab) {
    huidigeTab = tab;
    [...$('tabs').querySelectorAll('button[data-tab]')].forEach(b => b.classList.toggle('actief', b.dataset.tab === tab));
    const vak = $('tab-inhoud');
    const scroll = vak.scrollTop;
    vak.innerHTML = '';
    vak.appendChild({ wekker: tabWekker, zenders: tabZenders, scherm: tabScherm, geluid: tabGeluid, wifi: tabWifi, systeem: tabSysteem }[tab]());
    vak.scrollTop = scroll;
  }

  const schakel = (aan, wissel) => h('button', {
    class: 'schakel' + (aan ? ' aan' : ''),
    onclick: e => { const n = !e.currentTarget.classList.contains('aan'); e.currentTarget.classList.toggle('aan', n); wissel(n); }
  });

  // Knop die herhaalt zolang je hem ingedrukt houdt
  function herhaalKnop(label, actie) {
    let t1, t2;
    const stopH = () => { clearTimeout(t1); clearInterval(t2); };
    return h('button', {
      class: 'knop klein-k',
      onpointerdown: () => { actie(); t1 = setTimeout(() => { t2 = setInterval(actie, 90); }, 450); },
      onpointerup: stopH, onpointerleave: stopH, onpointercancel: stopH
    }, label);
  }

  function getalKiezer(waarde, min, max, achter, wissel) {
    const w = h('span', { class: 'label', style: 'min-width:12vh;text-align:center' }, waarde + achter);
    const zet = d => { waarde = Math.min(max, Math.max(min, waarde + d)); w.textContent = waarde + achter; wissel(waarde); };
    return h('div', { class: 'rij' }, herhaalKnop('−', () => zet(-1)), w, herhaalKnop('+', () => zet(1)));
  }

  // ---------- Wekker ----------
  let wekBestanden = [];
  const datumKort = d => d.toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short' });
  async function laadWekBestanden() {
    try { wekBestanden = (await api('/api/wekgeluiden', undefined, 8000)).bestanden || []; } catch (e) { wekBestanden = []; }
    if (instOpen && huidigeTab === 'wekker') tekenTab('wekker');
  }

  function tabWekker() {
    const c = h('div', {}, h('h2', {}, 'Wekker'));
    inst.wekkers.forEach((w, i) => {
      let [hh, mm] = w.tijd.split(':').map(Number);
      const uurEl = h('span', { class: 'waarde' }, pad(hh));
      const minEl = h('span', { class: 'waarde' }, pad(mm));
      const zetTijd = (dh, dm) => {
        mm += dm; hh += dh;
        if (mm > 59) { mm = 0; hh++; } if (mm < 0) { mm = 59; hh--; }
        hh = (hh + 24) % 24;
        w.tijd = `${pad(hh)}:${pad(mm)}`;
        uurEl.textContent = pad(hh); minEl.textContent = pad(mm);
        bewaar(); vorigeWekkerTekst = '';
      };
      const tijd = h('div', { class: 'tijdkiezer' },
        h('div', { class: 'pijlen' }, herhaalKnop('▲', () => zetTijd(1, 0)), herhaalKnop('▼', () => zetTijd(-1, 0))),
        uurEl, h('span', { class: 'dubbelepunt' }, ':'), minEl,
        h('div', { class: 'pijlen' }, herhaalKnop('▲', () => zetTijd(0, 1)), herhaalKnop('▼', () => zetTijd(0, -1))));

      const dagen = h('div', { class: 'dagen' }, [1, 2, 3, 4, 5, 6, 0].map(d => h('button', {
        class: w.dagen.includes(d) ? 'aan' : '',
        onclick: e => {
          w.dagen = w.dagen.includes(d) ? w.dagen.filter(x => x !== d) : [...w.dagen, d];
          e.currentTarget.classList.toggle('aan');
          bewaar(); vorigeWekkerTekst = '';
        }
      }, hoofdletter(DAGEN[d]))));

      const zNaam = h('span', { class: 'label groei', style: 'text-align:center' }, w.zender || '—');
      const wisselZender = d => {
        const lijst = zenders(); if (!lijst.length) return;
        let idx = lijst.findIndex(z => z.naam === w.zender);
        idx = (idx + d + lijst.length) % lijst.length;
        w.zender = lijst[idx].naam; zNaam.textContent = w.zender; bewaar();
      };
      const volume = h('input', { type: 'range', min: 10, max: 100, value: w.volume ?? 50, class: 'breed',
        oninput: e => { w.volume = Number(e.target.value); bewaar(); } });

      // Wekgeluid: radio, pieptoon of een eigen bestand
      const soorten = [['radio', '📻 Radio'], ['piep', '🔔 Pieptoon'], ...wekBestanden.map(n => ['bestand:' + n, '🎵 ' + n])];
      const nuSoort = w.geluid || 'radio';
      if (!soorten.some(s => s[0] === nuSoort)) soorten.push([nuSoort, '🎵 ' + nuSoort.slice(8) + ' (ontbreekt)']);
      const wisselGeluid = d => {
        const idx = (soorten.findIndex(s => s[0] === nuSoort) + d + soorten.length) % soorten.length;
        w.geluid = soorten[idx][0]; bewaar(); tekenTab('wekker');
      };
      // Eerstvolgende keer volgens de dagen; valt die op een vrije dag, dan dat melden
      let overslaan = null;
      if (w.aan && w.dagen.length) {
        for (let d = 0; d < 8 && !overslaan; d++) {
          const t = new Date(); t.setDate(t.getDate() + d); t.setHours(hh, mm, 0, 0);
          if (t <= new Date() || !w.dagen.includes(t.getDay())) continue;
          const reden = vrijeReden(t, w);
          if (reden) overslaan = `Gaat ${hoofdletter(DAGEN[t.getDay()])} ${t.getDate()}-${t.getMonth() + 1} niet af: ${reden}`;
          break;
        }
      }

      c.appendChild(h('div', { class: 'kaart' },
        h('div', { class: 'rij' }, h('span', { class: 'label groei' }, h('b', {}, `Wekker ${i + 1}`)),
          schakel(w.aan, n => { w.aan = n; bewaar(); vorigeWekkerTekst = ''; tekenTab('wekker'); })),
        h('div', { class: 'rij' }, tijd, h('div', { class: 'groei' }, dagen)),
        h('div', { class: 'rij' }, h('span', { class: 'sub' }, 'Geluid'),
          h('button', { class: 'knop klein-k zacht', onclick: () => wisselGeluid(-1) }, '◀'),
          h('span', { class: 'label groei', style: 'text-align:center' }, soorten.find(s => s[0] === nuSoort)[1]),
          h('button', { class: 'knop klein-k zacht', onclick: () => wisselGeluid(1) }, '▶')),
        nuSoort !== 'radio' ? null : h('div', { class: 'rij' }, h('span', { class: 'sub' }, 'Zender'),
          h('button', { class: 'knop klein-k zacht', onclick: () => wisselZender(-1) }, '◀'), zNaam,
          h('button', { class: 'knop klein-k zacht', onclick: () => wisselZender(1) }, '▶')),
        h('div', { class: 'rij' }, h('span', { class: 'label groei' }, 'Niet op feestdagen'),
          schakel(!!w.nietFeestdag, n => { w.nietFeestdag = n; bewaar(); vorigeWekkerTekst = ''; tekenTab('wekker'); })),
        h('div', { class: 'rij' }, h('span', { class: 'label groei' }, 'Niet in de schoolvakantie'),
          schakel(!!w.nietVakantie, n => { w.nietVakantie = n; bewaar(); vorigeWekkerTekst = ''; tekenTab('wekker'); })),
        overslaan ? h('div', { class: 'melding' }, '⏭ ' + overslaan) : null,
        h('div', { class: 'rij' }, h('span', { class: 'sub' }, 'Volume'), h('div', { class: 'groei' }, volume),
          h('button', { class: 'knop zacht', onclick: () => { sluitInstellingen(); gaAf(i); } }, 'Test'))
      ));
    });
    c.appendChild(h('div', { class: 'kaart' }, h('div', { class: 'rij' },
      h('span', { class: 'label groei' }, 'Sluimertijd'),
      getalKiezer(inst.sluimer, 1, 30, ' min', v => { inst.sluimer = v; bewaar(); }))));
    // Vrije dagen: regio en wat er aankomt
    const vandaag = new Date(), sleutelNu = datumSleutel(vandaag);
    let komendeFeestdag = '—';
    for (let d = 0; d < 370; d++) {
      const t = new Date(vandaag.getFullYear(), vandaag.getMonth(), vandaag.getDate() + d);
      if (feestdag(t)) { komendeFeestdag = `${feestdag(t)}, ${datumKort(t)}`; break; }
    }
    const kv = vakanties.filter(v => vanRegio(v) && v.tot >= sleutelNu).sort((a, b) => a.van.localeCompare(b.van))[0];
    const vanIso = s => new Date(s + 'T12:00');
    const wisselRegio = d => {
      inst.vakantieRegio = REGIOS[(REGIOS.indexOf(inst.vakantieRegio) + d + REGIOS.length) % REGIOS.length];
      bewaar(); vorigeWekkerTekst = ''; tekenTab('wekker');
    };
    c.appendChild(h('div', { class: 'kaart' },
      h('div', { class: 'rij' }, h('span', { class: 'label groei' }, h('b', {}, 'Vrije dagen'))),
      h('div', { class: 'rij' }, h('span', { class: 'sub' }, 'Regio schoolvakanties'),
        h('button', { class: 'knop klein-k zacht', onclick: () => wisselRegio(-1) }, '◀'),
        h('span', { class: 'label groei', style: 'text-align:center', id: 'vakantie-regio' }, hoofdletter(inst.vakantieRegio)),
        h('button', { class: 'knop klein-k zacht', onclick: () => wisselRegio(1) }, '▶')),
      h('div', { class: 'sub', style: 'margin-top:1.2vh', id: 'komende-vakantie' }, 'Eerstvolgende schoolvakantie: ' +
        (kv ? `${kv.naam}, ${datumKort(vanIso(kv.van))} t/m ${datumKort(vanIso(kv.tot))}` : 'onbekend (geen gegevens)')),
      h('div', { class: 'sub', id: 'komende-feestdag' }, 'Eerstvolgende feestdag: ' + komendeFeestdag),
      h('div', { class: 'sub', style: 'margin-top:.8vh' }, 'Feestdagen: Nieuwjaar, Pasen, Koningsdag, Hemelvaart, Pinksteren en Kerst, en Bevrijdingsdag eens per vijf jaar. Goede Vrijdag telt niet mee. Schoolvakanties komen van de Rijksoverheid.')));
    c.appendChild(h('div', { class: 'sub' }, 'Werkt de radio of het wekgeluid niet als de wekker afgaat, dan klinkt er een pieptoon. ' +
      'Eigen wekgeluid: zet een mp3-bestand in de map ~/.config/radio-app/geluiden op de Pi.'));
    return c;
  }

  // ---------- Zenders ----------
  function tabZenders() {
    const c = h('div', {}, h('h2', {}, 'Zenders'));
    const lijst = h('div', { class: 'kaart' });
    zenders().forEach((z, i) => {
      lijst.appendChild(h('div', { class: 'lijst-rij' },
        h('span', { class: 'naam' }, z.naam),
        h('button', { class: 'knop klein-k zacht', disabled: i === 0, onclick: () => verplaats(i, -1) }, '▲'),
        h('button', { class: 'knop klein-k zacht', disabled: i === zenders().length - 1, onclick: () => verplaats(i, 1) }, '▼'),
        h('button', { class: 'knop klein-k gevaar', onclick: async () => {
          if (await bevestig(`<b>${esc(z.naam)}</b> verwijderen?`, 'Verwijderen', 'gevaar')) {
            inst.zenders.splice(i, 1); bewaar(); tekenTab('zenders');
          }
        } }, '✕')));
    });
    if (!zenders().length) lijst.appendChild(h('div', { class: 'sub' }, 'Nog geen zenders.'));
    const resultaten = h('div', {});
    c.append(lijst,
      h('div', { class: 'rij' },
        h('button', { class: 'knop', onclick: () => zoek(resultaten) }, '＋ Zender zoeken'),
        h('button', { class: 'knop zacht', onclick: async () => {
          if (await bevestig('De standaard zenderlijst terugzetten?', 'Terugzetten')) {
            inst.zenders = kopie(C.zenders); bewaar(); tekenTab('zenders');
          }
        } }, 'Standaardlijst')),
      resultaten);
    return c;
  }

  function verplaats(i, d) {
    const z = inst.zenders.splice(i, 1)[0];
    inst.zenders.splice(i + d, 0, z);
    bewaar(); tekenTab('zenders');
  }

  async function zoek(vak) {
    const q = await toetsenbord({ label: 'Zoek zender', ok: 'Zoeken' });
    if (!q || !q.trim()) return;
    vak.innerHTML = '';
    vak.appendChild(h('div', { class: 'melding' }, `Zoeken naar “${q}”…`));
    let lijst;
    try {
      lijst = await zoekStations(q.trim());
      if (!lijst.length) lijst = await zoekStations(q.trim(), false);
    } catch (e) {
      vak.innerHTML = ''; vak.appendChild(h('div', { class: 'melding fout' }, 'Zoeken lukt niet, controleer de internetverbinding.'));
      return;
    }
    vak.innerHTML = '';
    vak.appendChild(h('h3', {}, lijst.length ? 'Zoekresultaten' : 'Niets gevonden'));
    const kaart = h('div', { class: 'kaart' });
    lijst.slice(0, 12).forEach(s => {
      const naam = s.name.trim();
      kaart.appendChild(h('div', { class: 'lijst-rij' },
        h('span', { class: 'naam' }, naam, h('span', { class: 'sub' }, `  ${s.countrycode || ''} · ${s.codec || ''} ${s.bitrate ? s.bitrate + ' kbps' : ''}`)),
        h('button', { class: 'knop klein-k', onclick: e => {
          if (!inst.zenders.some(z => z.naam === naam)) inst.zenders.push({ naam, url: s.url_resolved });
          bewaar();
          e.currentTarget.textContent = '✓'; e.currentTarget.disabled = true;
          setTimeout(() => tekenTab('zenders'), 600);
        } }, '＋')));
    });
    if (lijst.length) vak.appendChild(kaart);
  }

  // ---------- Scherm ----------
  function tabScherm() {
    const n = inst.nachtmodus;
    const echt = systeem && systeem.backlight;
    const toonNacht = () => { wakkerTot = 0; setTimeout(() => { wakkerTot = Date.now() + 30000; }, 3000); };
    const plaatsen = h('div', {});
    const standaardLoc = inst.locatie.lat === C.locatie.lat && inst.locatie.lon === C.locatie.lon;
    return h('div', {},
      h('h2', {}, 'Scherm en weer'),
      h('div', { class: 'kaart' },
        h('div', { class: 'rij' }, h('span', { class: 'label groei' }, 'Helderheid overdag'), h('span', { class: 'sub' }, inst.helderheid + '%')),
        h('div', { class: 'rij' }, h('input', { type: 'range', min: 10, max: 100, value: inst.helderheid, class: 'breed',
          oninput: e => { inst.helderheid = Number(e.target.value); e.target.closest('.kaart').querySelector('.sub').textContent = inst.helderheid + '%'; zetHelderheid(inst.helderheid); bewaar(); } }))),
      h('div', { class: 'kaart' },
        h('div', { class: 'rij' }, h('span', { class: 'label groei' }, h('b', {}, 'Nachtmodus')),
          schakel(n.aan, v => { n.aan = v; bewaar(); })),
        h('div', { class: 'rij' }, h('span', { class: 'label groei' }, 'Vanaf'), getalKiezer(n.van, 0, 23, ':00', v => { n.van = v; bewaar(); })),
        h('div', { class: 'rij' }, h('span', { class: 'label groei' }, 'Tot'), getalKiezer(n.tot, 0, 23, ':00', v => { n.tot = v; bewaar(); })),
        h('div', { class: 'rij' }, h('span', { class: 'label groei' }, 'Helderheid ’s nachts'),
          h('span', { class: 'sub', id: 'nacht-pct' }, n.helderheid === 0 ? 'scherm uit' : n.helderheid + '%')),
        h('div', { class: 'rij' }, h('input', { type: 'range', min: 0, max: 80, value: n.helderheid, class: 'breed',
          oninput: e => { n.helderheid = Number(e.target.value); $('nacht-pct').textContent = n.helderheid === 0 ? 'scherm uit' : n.helderheid + '%'; bewaar(); } })),
        h('div', { class: 'sub' }, echt ? 'Tik op het scherm om het 30 seconden helder te maken.'
          : 'Dit scherm heeft geen regelbare verlichting. De app maakt het beeld donkerder.')),
      h('div', { class: 'kaart' },
        h('div', { class: 'rij' }, h('span', { class: 'label groei' }, h('b', {}, 'KNMI-weeralarm')),
          schakel(inst.weeralarm.aan, v => { inst.weeralarm.aan = v; bewaar(); ververWaarschuwingen(); })),
        h('div', { class: 'rij' }, h('span', { class: 'sub' }, 'Provincie'),
          h('button', { class: 'knop klein-k zacht', onclick: () => wisselProvincie(-1) }, '◀'),
          h('span', { class: 'label groei', style: 'text-align:center', id: 'provincie' }, inst.weeralarm.regio),
          h('button', { class: 'knop klein-k zacht', onclick: () => wisselProvincie(1) }, '▶')),
        h('div', { class: 'sub' }, 'Bij code geel, oranje of rood verschijnt er bovenaan een melding.')),
      h('div', { class: 'kaart' },
        h('div', { class: 'rij' }, h('span', { class: 'label groei' }, h('b', {}, 'Weerlocatie')),
          h('span', { class: 'label', id: 'locatie-naam' }, inst.locatie.naam)),
        h('div', { class: 'rij' },
          h('button', { class: 'knop', onclick: () => zoekLocatie(plaatsen) }, '📍 Andere plaats'),
          standaardLoc ? null : h('button', { class: 'knop zacht', onclick: () => kiesLocatie(kopie(C.locatie)) }, `Terug naar ${C.locatie.naam}`)),
        h('div', { class: 'sub' }, 'Het weer, de regenverwachting en de zonstijden gelden voor deze plaats.')),
      plaatsen
    );
  }

  async function zoekPlaatsen(q) {
    if (DEMO) {
      return [{ name: 'Eindhoven', admin1: 'Noord-Brabant', country: 'Nederland', country_code: 'NL', latitude: 51.44083, longitude: 5.47778 },
        { name: 'Leeuwarden', admin1: 'Fryslân', country: 'Nederland', country_code: 'NL', latitude: 53.20139, longitude: 5.80859 },
        { name: 'Antwerpen', admin1: 'Vlaanderen', country: 'België', country_code: 'BE', latitude: 51.22047, longitude: 4.40026 }];
    }
    const d = await haalJson('https://geocoding-api.open-meteo.com/v1/search?name=' + encodeURIComponent(q) +
      '&count=8&language=nl&format=json', 10000);
    return d.results || [];
  }

  async function zoekLocatie(vak) {
    const q = await toetsenbord({ label: 'Plaatsnaam', ok: 'Zoeken' });
    if (!q || !q.trim()) return;
    vak.innerHTML = '';
    vak.appendChild(h('div', { class: 'melding' }, `Zoeken naar “${q.trim()}”…`));
    let lijst;
    try { lijst = await zoekPlaatsen(q.trim()); } catch (e) {
      vak.innerHTML = ''; vak.appendChild(h('div', { class: 'melding fout' }, 'Zoeken lukt niet, controleer de internetverbinding.'));
      return;
    }
    vak.innerHTML = '';
    vak.appendChild(h('h3', {}, lijst.length ? 'Kies een plaats' : 'Niets gevonden'));
    if (!lijst.length) return;
    const kaart = h('div', { class: 'kaart' });
    lijst.forEach(p => kaart.appendChild(h('div', { class: 'lijst-rij', onclick: () => kiesLocatie({
      naam: p.name, lat: Math.round(p.latitude * 1e4) / 1e4, lon: Math.round(p.longitude * 1e4) / 1e4
    }, p) },
      h('span', { class: 'naam' }, p.name),
      h('span', { class: 'sub' }, [p.admin1, p.country].filter(Boolean).join(', ')))));
    vak.appendChild(kaart);
    kaart.scrollIntoView({ block: 'nearest' });
  }

  function kiesLocatie(loc, plaats) {
    inst.locatie = loc;
    // Ligt de plaats in Nederland, dan gaat het weeralarm mee naar die provincie
    if (plaats && plaats.country_code === 'NL') {
      const prov = plaats.admin1 === 'Fryslân' ? 'Friesland' : plaats.admin1;
      if (PROVINCIES.includes(prov) && prov !== inst.weeralarm.regio) { inst.weeralarm.regio = prov; ververWaarschuwingen(); }
    } else if (!plaats && C.weeralarm && inst.weeralarm.regio !== C.weeralarm.regio) {
      inst.weeralarm.regio = C.weeralarm.regio; ververWaarschuwingen();
    }
    bewaar();
    opslag.set('weer', null); weerGetoond = false;
    $('weer-update').textContent = `${loc.naam} · weer laden…`;
    ververWeer();
    tekenTab('scherm');
  }

  function wisselProvincie(d) {
    let i = PROVINCIES.indexOf(inst.weeralarm.regio);
    i = (i + d + PROVINCIES.length) % PROVINCIES.length;
    inst.weeralarm.regio = PROVINCIES[i];
    $('provincie').textContent = PROVINCIES[i];
    bewaar();
    clearTimeout(wisselProvincie.t);
    wisselProvincie.t = setTimeout(ververWaarschuwingen, 1500);
  }

  // ---------- Geluid ----------
  let geluid = null, geluidTimer = null;

  async function laadGeluid() {
    try { geluid = await api('/api/geluid', undefined, 12000); }
    catch (e) { geluid = { beschikbaar: false, fout: e.message }; }
    if (instOpen && huidigeTab === 'geluid') tekenTab('geluid');
  }

  async function zetGeluid(data, opnieuwTekenen = true) {
    try { geluid = await api('/api/geluid', data, 12000); }
    catch (e) { geluid = { ...(geluid || {}), fout: e.message }; opnieuwTekenen = true; }
    if (opnieuwTekenen && instOpen && huidigeTab === 'geluid') tekenTab('geluid');
  }

  function tabGeluid() {
    const c = h('div', {}, h('h2', {}, 'Geluid'));
    if (!SERVER) { c.appendChild(h('div', { class: 'kaart sub' }, 'Geluid instellen kan alleen op de Pi zelf.')); return c; }
    if (!geluid) { laadGeluid(); c.appendChild(h('div', { class: 'kaart sub' }, 'Laden…')); return c; }
    if (!geluid.beschikbaar) {
      c.appendChild(h('div', { class: 'kaart' }, h('div', { class: 'melding fout' }, geluid.fout || 'Geluid instellen lukt niet.'),
        h('div', { class: 'rij' }, h('button', { class: 'knop zacht', onclick: () => { geluid = null; tekenTab('geluid'); } }, 'Opnieuw proberen'))));
      return c;
    }
    const lijst = h('div', { class: 'kaart' },
      h('div', { class: 'rij' }, h('span', { class: 'label groei' }, h('b', {}, 'Waar komt het geluid uit?'))));
    geluid.uitgangen.forEach(u => lijst.appendChild(h('div', { class: 'lijst-rij', onclick: () => { if (!u.actief) zetGeluid({ uitgang: u.naam }); } },
      h('span', { class: 'naam' }, (u.actief ? '✓ ' : '') + u.label),
      h('span', { class: 'sub' }, u.omschrijving && u.omschrijving !== u.label ? u.omschrijving : ''))));
    if (!geluid.uitgangen.length) lijst.appendChild(h('div', { class: 'sub' }, 'Geen audio-uitgang gevonden.'));
    if (geluid.fout) lijst.appendChild(h('div', { class: 'melding fout' }, geluid.fout));
    c.appendChild(lijst);

    const pct = h('span', { class: 'sub' }, geluid.volume == null ? '—' : geluid.volume + '%');
    c.appendChild(h('div', { class: 'kaart' },
      h('div', { class: 'rij' }, h('span', { class: 'label groei' }, h('b', {}, 'Hoofdvolume van de Pi')), pct),
      h('div', { class: 'rij' }, h('input', { type: 'range', min: 0, max: 100, value: geluid.volume ?? 50, class: 'breed',
        oninput: e => {
          const v = Number(e.target.value);
          pct.textContent = v + '%';
          clearTimeout(geluidTimer);
          geluidTimer = setTimeout(() => zetGeluid({ volume: v }, false), 250);
        } })),
      h('div', { class: 'rij' },
        h('button', { class: 'knop', onclick: testToon }, '🔔 Testtoon'),
        h('button', { class: 'knop zacht', onclick: () => { geluid = null; tekenTab('geluid'); } }, 'Uitgangen opnieuw zoeken')),
      h('div', { class: 'sub', style: 'margin-top:1vh' }, 'Dit is het maximale volume. De schuif bij de radio en het volume van de wekker regelen daarbinnen.')));
    return c;
  }

  // ---------- Wi-Fi ----------
  let wifiLijst = null, wifiMelding = { tekst: '', soort: '' };

  function tabWifi() {
    const c = h('div', {}, h('h2', {}, 'Wi-Fi'));
    if (!SERVER) { c.appendChild(h('div', { class: 'kaart sub' }, 'Wi-Fi instellen kan alleen op de Pi zelf.')); return c; }
    const nu = systeem && systeem.wifi;
    c.appendChild(h('div', { class: 'kaart' },
      h('div', { class: 'rij' },
        h('span', { class: 'label groei' }, nu ? `Verbonden met ${nu.ssid}` : 'Niet verbonden met wifi'),
        nu ? h('span', { class: 'sub' }, `signaal ${nu.signaal}%`) : null),
      systeem && systeem.ip ? h('div', { class: 'sub' }, `IP-adres ${systeem.ip}`) : null));
    c.appendChild(h('div', { class: 'rij' },
      h('button', { class: 'knop', onclick: scanWifi }, '🔍 Netwerken zoeken')));
    c.appendChild(h('div', { class: 'melding ' + wifiMelding.soort }, wifiMelding.tekst));
    if (wifiLijst) {
      const k = h('div', { class: 'kaart' });
      wifiLijst.forEach(n => k.appendChild(h('div', { class: 'lijst-rij', onclick: () => kiesWifi(n) },
        h('span', { class: 'naam' }, (n.actief ? '✓ ' : '') + n.ssid),
        h('span', { class: 'sub' }, n.beveiligd ? '🔒' : 'open'),
        h('span', { class: 'signaal' }, balkjes(n.signaal)))));
      if (!wifiLijst.length) k.appendChild(h('div', { class: 'sub' }, 'Geen netwerken gevonden.'));
      c.appendChild(k);
    }
    return c;
  }

  const balkjes = s => s >= 75 ? '▂▄▆█' : s >= 50 ? '▂▄▆_' : s >= 25 ? '▂▄__' : '▂___';

  async function scanWifi() {
    wifiMelding = { tekst: 'Zoeken naar netwerken…', soort: '' };
    tekenTab('wifi');
    try {
      const d = await api('/api/wifi/scan', undefined, 45000);
      wifiLijst = d.netwerken || [];
      wifiMelding = { tekst: '', soort: '' };
    } catch (e) {
      wifiMelding = { tekst: 'Zoeken mislukt: ' + e.message, soort: 'fout' };
    }
    if (huidigeTab === 'wifi') tekenTab('wifi');
  }

  async function kiesWifi(n) {
    if (n.actief) { meld(`Je bent al verbonden met <b>${esc(n.ssid)}</b>.`); return; }
    let ww = '';
    if (n.beveiligd) {
      ww = await toetsenbord({ label: `Wachtwoord ${n.ssid}`, wachtwoord: true, ok: 'Verbinden' });
      if (ww === null) return;
    } else if (!await bevestig(`Verbinden met open netwerk <b>${esc(n.ssid)}</b>?`, 'Verbinden')) return;

    wifiMelding = { tekst: `Verbinden met ${n.ssid}…`, soort: '' };
    tekenTab('wifi');
    try {
      const r = await api('/api/wifi/verbind', { ssid: n.ssid, wachtwoord: ww }, 70000);
      wifiMelding = r.ok ? { tekst: `✓ Verbonden met ${n.ssid}`, soort: 'goed' }
        : { tekst: `Verbinden mislukt. Klopt het wachtwoord? ${r.melding || ''}`, soort: 'fout' };
    } catch (e) {
      wifiMelding = { tekst: 'Verbinden mislukt: ' + e.message, soort: 'fout' };
    }
    wifiLijst = null;
    await ververStatus();
    if (huidigeTab === 'wifi') tekenTab('wifi');
  }

  // ---------- Systeem ----------
  function duur(min) {
    const d = Math.floor(min / 1440), u = Math.floor(min % 1440 / 60), m = min % 60;
    return d ? `${d} d ${u} u` : u ? `${u} u ${m} min` : `${m} min`;
  }

  function tabSysteem() {
    const c = h('div', {}, h('h2', {}, 'Systeem'));
    if (!SERVER || !systeem) {
      c.appendChild(h('div', { class: 'kaart sub' }, SERVER ? 'Status laden…' : 'Systeemfuncties werken alleen op de Pi zelf.'));
      c.appendChild(h('div', { class: 'rij' }, h('button', { class: 'knop zacht', onclick: () => location.reload() }, '⟳ App herladen')));
      return c;
    }
    const s = systeem;
    c.appendChild(h('div', { class: 'kaart info-raster' },
      h('div', {}, h('span', {}, 'Apparaat'), s.model || 'Raspberry Pi'),
      h('div', {}, h('span', {}, 'IP-adres'), s.ip || '—'),
      h('div', {}, h('span', {}, 'Wi-Fi'), s.wifi ? `${s.wifi.ssid} (${s.wifi.signaal}%)` : 'kabel of geen'),
      h('div', {}, h('span', {}, 'Temperatuur'), s.temp != null ? `${s.temp} °C` : '—'),
      h('div', {}, h('span', {}, 'Aan sinds'), duur(s.uptimeMin || 0)),
      h('div', {}, h('span', {}, 'Vrije ruimte'), `${s.schijfVrijGB} GB`)));

    c.appendChild(appKaart(s.app || {}));

    // Updates
    const u = s.upgrade || {};
    let tekst, soort = '';
    if (u.bezig) tekst = 'Updates worden geïnstalleerd… ' + (u.regel || '');
    else if (u.fout) { tekst = 'Installeren mislukt: ' + (u.regel || ''); soort = 'fout'; }
    else if (s.updates === null || s.updates === undefined) tekst = 'Nog niet gecontroleerd';
    else if (s.updates === 0) { tekst = `✓ Alles is bijgewerkt (gecontroleerd om ${s.laatsteCheck})`; soort = 'goed'; }
    else tekst = `${s.updates} update${s.updates === 1 ? '' : 's'} beschikbaar (gecontroleerd om ${s.laatsteCheck})`;

    c.appendChild(h('div', { class: 'kaart' },
      h('div', { class: 'rij' }, h('span', { class: 'label groei' }, h('b', {}, 'Systeemupdates (Raspberry Pi OS)'))),
      h('div', { class: 'melding ' + soort }, tekst),
      s.herstartNodig ? h('div', { class: 'melding' }, '↻ Herstart de Pi om de updates af te ronden.') : null,
      h('div', { class: 'rij' },
        h('button', { class: 'knop zacht', disabled: !!u.bezig, onclick: async () => {
          await api('/api/updates/zoeken', {}).catch(() => {});
          systeem.updates = null; tekenTab('systeem');
          setTimeout(ververStatus, 8000);
        } }, 'Nu controleren'),
        h('button', { class: 'knop', disabled: !!u.bezig || !(s.updates > 0), onclick: async () => {
          if (!await bevestig(`${s.updates} update${s.updates === 1 ? '' : 's'} installeren?<small>Dit kan 5 tot 30 minuten duren. De radio blijft spelen. Zet de Pi in de tussentijd niet uit.</small>`, 'Installeren')) return;
          await api('/api/updates/installeren', {}).catch(e => meld('Mislukt: ' + esc(e.message)));
          ververStatus();
        } }, 'Installeren'))));

    // Aan/uit
    c.appendChild(h('div', { class: 'kaart' },
      h('div', { class: 'rij' }, h('span', { class: 'label groei' }, h('b', {}, 'Aan / uit'))),
      h('div', { class: 'rij' },
        h('button', { class: 'knop zacht', onclick: () => location.reload() }, '⟳ App herladen'),
        h('button', { class: 'knop', onclick: () => systeemActie('herstarten') }, '↻ Herstarten'),
        h('button', { class: 'knop gevaar', onclick: () => systeemActie('uitzetten') }, '⏻ Uitzetten'))));
    return c;
  }


  function appKaart(a) {
    const k = h('div', { class: 'kaart' },
      h('div', { class: 'rij' }, h('span', { class: 'label groei' }, h('b', {}, 'App')),
        h('span', { class: 'sub' }, `versie ${a.versie || '?'}${a.commit ? ' · ' + a.commit : ''}`)));
    if (!a.git) {
      k.appendChild(h('div', { class: 'melding' }, 'Deze app is niet via GitHub geïnstalleerd, dus bijwerken op afstand staat uit. Zie LEESMIJ › App bijwerken via GitHub.'));
      return k;
    }
    if (a.bron) k.appendChild(h('div', { class: 'sub' }, a.bron.replace(/^https?:\/\//, '').replace(/\.git$/, '')));

    let tekst, soort = '';
    if (a.bezig) tekst = 'Bijwerken…';
    else if (a.fout) { tekst = a.melding || 'Er ging iets mis'; soort = 'fout'; }
    else if (a.nieuw > 0) tekst = `Nieuwe versie beschikbaar (${a.nieuw} wijziging${a.nieuw === 1 ? '' : 'en'}):`;
    else if (a.nieuw === 0) { tekst = `✓ Je hebt de nieuwste versie${a.laatsteCheck ? ' (gecontroleerd om ' + a.laatsteCheck + ')' : ''}`; soort = 'goed'; }
    else tekst = 'Nog niet gecontroleerd';
    k.appendChild(h('div', { class: 'melding ' + soort }, tekst));

    if (a.nieuw > 0 && a.wijzigingen && a.wijzigingen.length) {
      k.appendChild(h('div', { class: 'sub', style: 'margin:.6vh 0 1vh 1vw' },
        a.wijzigingen.slice(0, 8).map(w => h('div', {}, '• ' + w))));
    }
    if (a.melding && !a.fout && !a.bezig && !(a.nieuw > 0)) k.appendChild(h('div', { class: 'melding goed' }, a.melding));
    if (a.systeemdeelGewijzigd) {
      k.appendChild(h('div', { class: 'melding' },
        '⚠️ Deze update wijzigt ook het systeemdeel of het opstartlogo. Draai één keer ',
        h('b', {}, 'bash ~/radio-app/install.sh'), ' via SSH of een toetsenbord.'));
      k.appendChild(h('div', { class: 'rij' }, h('button', { class: 'knop zacht klein-k', onclick: async () => {
        await api('/api/app/melding-gelezen', {}).catch(() => {}); ververStatus();
      } }, 'Begrepen')));
    }
    if (a.lokaalGewijzigd) {
      k.appendChild(h('div', { class: 'melding fout' }, 'Op de Pi zelf zijn bestanden van de app gewijzigd. Daardoor kan de app niet gewoon bijwerken.'));
    }

    k.appendChild(h('div', { class: 'rij' },
      h('button', { class: 'knop zacht', disabled: !!a.bezig, onclick: async () => {
        await api('/api/app/zoeken', {}).catch(() => {});
        setTimeout(ververStatus, 4000);
      } }, 'Nu controleren'),
      a.nieuw > 0 && !a.lokaalGewijzigd ? h('button', { class: 'knop', disabled: !!a.bezig, onclick: () => appBijwerken(false) }, 'App bijwerken') : null,
      a.nieuw > 0 && a.lokaalGewijzigd ? h('button', { class: 'knop gevaar', disabled: !!a.bezig, onclick: () => appBijwerken(true) }, 'Lokale wijzigingen weggooien en bijwerken') : null));

    k.appendChild(h('div', { class: 'rij' },
      h('span', { class: 'label groei' }, 'Automatisch bijwerken ’s nachts (03:00)'),
      schakel(inst.appAutoUpdate, v => { inst.appAutoUpdate = v; bewaar(); })));
    return k;
  }

  async function appBijwerken(forceer) {
    const vraag = forceer
      ? 'Lokale wijzigingen op de Pi weggooien en de versie van GitHub installeren?<small>Je instellingen via ⚙️ blijven bewaard.</small>'
      : 'De app bijwerken naar de nieuwste versie?<small>Je instellingen blijven bewaard. Het scherm herlaadt vanzelf.</small>';
    if (!await bevestig(vraag, 'Bijwerken', forceer ? 'gevaar' : '')) return;
    try {
      const r = await api('/api/app/bijwerken', { forceer }, 60000);
      if (!r.ok) { meld('Bijwerken mislukt.<small>' + esc(r.melding || '') + '</small>'); return; }
      dialoog('⬆ App bijgewerkt<small>Het scherm herlaadt over een paar seconden…</small>', []);
      setTimeout(() => location.reload(), 6000);     // vangnet als de status het niet oppikt
    } catch (e) { meld('Bijwerken mislukt.<small>' + esc(e.message) + '</small>'); }
  }

  async function systeemActie(actie) {
    const vraag = actie === 'uitzetten'
      ? 'De Pi uitzetten?<small>Om hem weer aan te zetten haal je de stekker er even uit (of druk je op de aan-knop van een Pi 5).</small>'
      : 'De Pi opnieuw opstarten?<small>Dit duurt ongeveer een minuut.</small>';
    if (!await bevestig(vraag, actie === 'uitzetten' ? 'Uitzetten' : 'Herstarten', actie === 'uitzetten' ? 'gevaar' : '')) return;
    try {
      await api('/api/systeem/' + actie, {});
    } catch (e) { meld('Mislukt: ' + esc(e.message)); return; }
    stop();
    $('instellingen').classList.add('verborgen');
    dialoog(actie === 'uitzetten'
      ? '⏻ De Pi wordt uitgezet…<small>Wacht tot het groene lampje niet meer knippert. Daarna kun je de stekker veilig uit het stopcontact halen.</small>'
      : '↻ De Pi start opnieuw op…', []);
  }

  // =========================================================
  //  Demo-weer (alleen met ?demo)
  // =========================================================
  function demoWeer() {
    const nu = new Date(); nu.setMinutes(Math.floor(nu.getMinutes() / 15) * 15, 0, 0);
    const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const kw = [...Array(12)].map((_, i) => iso(new Date(nu.getTime() + i * 900000)));
    const dagen = [...Array(4)].map((_, i) => iso(new Date(Date.now() + i * 864e5)).slice(0, 10));
    return {
      current: { temperature_2m: 9.4, apparent_temperature: 6.8, relative_humidity_2m: 84, weather_code: 3, wind_speed_10m: 18, wind_direction_10m: 230, is_day: 1 },
      minutely_15: { time: kw, precipitation: [0, 0, 0, 0, 0.1, 0.4, 0.8, 0.5, 0.2, 0, 0, 0] },
      daily: {
        time: dagen, weather_code: [3, 61, 2, 80],
        temperature_2m_max: [10, 11, 9, 8], temperature_2m_min: [5, 6, 3, 2],
        precipitation_probability_max: [40, 75, 10, 55],
        sunrise: dagen.map(d => d + 'T07:56'), sunset: dagen.map(d => d + 'T16:49')
      }
    };
  }

  // =========================================================
  //  Start
  // =========================================================
  (async () => {
    await laadInstellingen();
    huidigNaam = opslag.get('zenderNaam', null);
    bouwZenders();
    if (huidig >= 0) $('zender-naam').textContent = zenders()[huidig].naam;
    tik();
    ververWeer();
    ververWaarschuwingen();
    ververVakanties();
    ververStatus();
    if (C.autoplay && !DEMO && huidig >= 0) setTimeout(() => speel(huidig), 1500);
  })();
})();
