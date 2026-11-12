// =====================================================
//  Instellingen — pas hier alles aan wat je wilt wijzigen
// =====================================================
window.APP_CONFIG = {
  // Naam naast het logo (laat leeg '' als je alleen het logo wilt)
  naam: 'Radio Veghel',

  // Bestandsnaam van je logo in deze map (.svg of .png).
  // Draai na het wijzigen install.sh opnieuw, dan wordt het ook je opstartscherm.
  logo: 'logo.svg',

  // Standaardlocatie voor het weer
  locatie: { naam: 'Veghel', lat: 51.6167, lon: 5.5486 },

  // Hoe vaak het weer ververst wordt (minuten)
  weerVerversMinuten: 15,

  // Bij opstarten automatisch de laatst gekozen zender afspelen
  autoplay: true,
  standaardVolume: 60, // 0–100

  // Scherm 's nachts dimmen (tik op het scherm = 30 sec helder). Helderheid 0–100, 0 = scherm uit.
  nachtmodus: { aan: true, van: 23, tot: 7, helderheid: 20 },
  helderheid: 100,

  // KNMI-weerwaarschuwingen (via MeteoAlarm) voor deze provincie
  weeralarm: { aan: true, regio: 'Noord-Brabant' },

  // Standaardwekkers (aan te passen op het scherm via ⚙). Dagen: 0 = zo, 1 = ma … 6 = za
  wekkers: [
    { aan: false, tijd: '07:00', dagen: [1, 2, 3, 4, 5], zender: 1, volume: 50 },
    { aan: false, tijd: '09:00', dagen: [0, 6], zender: 1, volume: 40 }
  ],
  sluimerMinuten: 9,

  // Alles hierboven is de standaard. Wat je op het scherm via ⚙ wijzigt,
  // wordt bewaard in ~/.config/radio-app/instellingen.json en gaat voor.

  // Zenders. Laat 'url' leeg om de stream automatisch op te zoeken via radio-browser.info.
  // Werkt een url niet meer, dan zoekt de app zelf een werkende stream op naam.
  zenders: [
    { naam: 'NPO Radio 1',    url: 'https://icecast.omroep.nl/radio1-bb-mp3' },
    { naam: 'NPO Radio 2',    url: 'https://icecast.omroep.nl/radio2-bb-mp3' },
    { naam: 'NPO 3FM',        url: 'https://icecast.omroep.nl/3fm-bb-mp3' },
    { naam: 'NPO Radio 5',    url: 'https://icecast.omroep.nl/radio5-bb-mp3' },
    { naam: 'NPO Klassiek',   url: 'https://icecast.omroep.nl/radio4-bb-mp3', zoek: 'NPO Klassiek' },

    // Regionaal, lokaal en nieuws
    { naam: 'Omroep Brabant',     url: '', zoek: 'Omroep Brabant' },
    { naam: 'Omroep Meierijstad', url: '', zoek: 'Omroep Meierijstad' },
    { naam: 'BNR Nieuwsradio',    url: '', zoek: 'BNR Nieuwsradio' },

    // Pop en hits
    { naam: 'Qmusic',         url: 'https://stream.qmusic.nl/qmusic/mp3' },
    { naam: 'Radio 538',      url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/RADIO538.mp3' },
    { naam: 'Radio Veronica', url: '', zoek: 'Radio Veronica' },

    // Rustig en oldies
    { naam: 'Sky Radio',      url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/SKYRADIO.mp3' },
    { naam: 'Radio 10',       url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/RADIO10.mp3' },
    { naam: 'Sublime',        url: '', zoek: 'Sublime' },

    // Andere smaken
    { naam: '100% NL',            url: 'https://stream.100p.nl/100pctnl.mp3' },
    { naam: 'Arrow Classic Rock', url: '', zoek: 'Arrow Classic Rock' },
    { naam: 'KINK',               url: '', zoek: 'KINK' },
    { naam: 'SLAM!',              url: '', zoek: 'SLAM' }
  ]
};
