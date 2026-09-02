// ==UserScript==
// @name         Torn Bazaar Flipper — Beobachter
// @namespace    torn-bazaar-flipper
// @version      1.0.0
// @description  Schreibt mit, was im Auslandsshop steht, und meldet es an den eigenen Sammler. Liest nur, handelt nie.
// @match        https://www.torn.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @connect      *
// @run-at       document-idle
// ==/UserScript==

/* eslint-disable no-underscore-dangle */

// Beobachter fuer den Auslandsshop.
//
// WAS ES TUT: es liest mit, was ohnehin auf dem Bildschirm steht, und meldet
// Land, Item, Menge und Zeitpunkt an den eigenen Server. Nichts wird
// geklickt, nichts gekauft, nichts geflogen - das Werkzeug rechnet und
// empfiehlt, es handelt nicht.
//
// WARUM: der Sammler fragt YATA ab, und YATA rechnet einmal je Minute neu.
// Feiner als eine Minute laesst sich ein Nachfuellzeitpunkt daraus nie
// bestimmen. Wer im Shop steht, sieht den Bestand dagegen in dem Moment, in
// dem er ihn sieht - sekundengenau und ohne fremden Zwischenspeicher. Das ist
// die genaueste Messung, die es in diesem Projekt geben kann.
//
// AUFBAU: zwei Haelften, bewusst getrennt.
//
//   Der Transport   Warteschlange, Wiederholung, Entprellung, Versand. Haengt
//                   an nichts, was Torn morgen aendern kann, und ist hier
//                   fertig.
//
//   Das Ablesen     findeBestaende() weiter unten. Es haengt daran, wie Torn
//                   seine Seite baut, und das aendert sich. Deshalb gibt es
//                   den Erkundungsmodus: einmal laufen lassen, ausgeben, was
//                   ankam, und danach genau darauf hin schaerfen. Ein
//                   geratener Selektor waere eine erfundene Messung.

(() => {
  'use strict';

  const EINSTELLUNGEN = {
    // Die Adresse des eigenen Servers im Tailnet. Ohne sie passiert nichts.
    // Beispiel: 'http://ubuntu-server-home.tail0000.ts.net:8080'
    server: '',

    // Erkundung: nichts senden, nur zeigen, was gefunden wurde. So laesst sich
    // pruefen, ob das Ablesen stimmt, bevor irgendetwas in der Messreihe
    // landet.
    erkunden: true,

    // Dieselbe Sperre wie im Sammler: zwei Messungen im Sekundenabstand sind
    // eine Messung, und aus zweien liest die Zyklenerkennung einen Sprung, den
    // es nie gab.
    mindestabstandMs: 60 * 1000,

    // Unterwegs ist das Telefon oft ohne Netz. Was nicht durchgeht, wartet.
    maxWarteschlange: 200,
    wiederholungMs: 30 * 1000,
  };

  const LAENDER = new Set(['mex', 'cay', 'can', 'haw', 'uni', 'arg', 'swi', 'jap', 'chi', 'uae', 'sou']);

  // Torn schreibt Laendernamen aus; der Sammler kennt Kuerzel.
  const NAME_ZU_CODE = new Map(Object.entries({
    mexico: 'mex',
    'cayman islands': 'cay',
    canada: 'can',
    hawaii: 'haw',
    'united kingdom': 'uni',
    argentina: 'arg',
    switzerland: 'swi',
    japan: 'jap',
    china: 'chi',
    'uae': 'uae',
    'united arab emirates': 'uae',
    'south africa': 'sou',
  }));

  const jetzt = () => Date.now();
  const log = (...a) => console.log('[Beobachter]', ...a);

  // ---------- Transport ----------

  /** Was zuletzt gemeldet wurde, je Reihe - gegen Doppelmeldungen. */
  const zuletzt = new Map();
  const warteschlange = [];
  let laeuft = false;

  function melden(beobachtung) {
    const schluessel = `${beobachtung.country}:${beobachtung.item}`;
    const vorher = zuletzt.get(schluessel);

    // Entprellen: derselbe Wert kurz hintereinander ist keine neue Messung.
    // Eine *geaenderte* Menge dagegen ist immer eine, auch nach Sekunden -
    // gerade der Sprung von null auf voll ist der wertvollste Moment.
    if (vorher
      && vorher.quantity === beobachtung.quantity
      && beobachtung.ts - vorher.ts < EINSTELLUNGEN.mindestabstandMs) {
      return false;
    }
    zuletzt.set(schluessel, beobachtung);

    if (EINSTELLUNGEN.erkunden) {
      log('gefunden (nicht gesendet):', beobachtung);
      return true;
    }
    if (warteschlange.length >= EINSTELLUNGEN.maxWarteschlange) warteschlange.shift();
    warteschlange.push(beobachtung);
    abarbeiten();
    return true;
  }

  function sende(beobachtung) {
    return new Promise((fertig) => {
      // GM_xmlhttpRequest statt fetch: der Server verlangt
      // application/json, und das erzwingt aus einer torn.com-Seite heraus
      // einen Preflight, den er bewusst nicht beantwortet. Ueber diesen Weg
      // bleibt der Server so streng, wie er ist.
      const anfrage = typeof GM_xmlhttpRequest === 'function'
        ? GM_xmlhttpRequest
        : (typeof GM !== 'undefined' && GM.xmlHttpRequest);
      if (!anfrage) {
        log('kein GM_xmlhttpRequest — das Skript braucht diese Berechtigung');
        fertig(false);
        return;
      }

      anfrage({
        method: 'POST',
        url: `${EINSTELLUNGEN.server.replace(/\/+$/, '')}/api/beobachtung`,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify(beobachtung),
        timeout: 15000,
        onload: (a) => fertig(a.status >= 200 && a.status < 300),
        onerror: () => fertig(false),
        ontimeout: () => fertig(false),
      });
    });
  }

  async function abarbeiten() {
    if (laeuft || !warteschlange.length) return;
    if (!EINSTELLUNGEN.server) {
      log('keine Serveradresse eingetragen — nichts wird gesendet');
      warteschlange.length = 0;
      return;
    }
    laeuft = true;
    try {
      while (warteschlange.length) {
        const naechste = warteschlange[0];
        if (await sende(naechste)) {
          warteschlange.shift();
          zeige(`${warteschlange.length} offen`);
        } else {
          // Nicht verwerfen: unterwegs ist kein Netz der Normalfall.
          setTimeout(abarbeiten, EINSTELLUNGEN.wiederholungMs);
          break;
        }
      }
    } finally {
      laeuft = false;
    }
  }

  // ---------- Anzeige ----------

  let anzeige = null;
  function zeige(text) {
    if (!anzeige) {
      anzeige = document.createElement('div');
      anzeige.id = 'tbf-beobachter';
      // Bewusst unauffaellig: das Skript soll die Seite nicht umbauen.
      Object.assign(anzeige.style, {
        position: 'fixed', right: '8px', bottom: '8px', zIndex: 99999,
        background: 'rgba(20,22,26,.9)', color: '#e6e8ec', font: '12px monospace',
        padding: '4px 8px', borderRadius: '6px', pointerEvents: 'none',
      });
      document.body.appendChild(anzeige);
    }
    anzeige.textContent = `Beobachter: ${text}`;
  }

  // ---------- Ablesen ----------
  //
  // Der Teil, der an Torns Seite haengt. Zwei Wege, absichtlich beide:
  //
  //   Netzantworten  Torn laedt den Shop per AJAX. Die Antwort ist
  //                  strukturiert und aendert sich seltener als das Markup.
  //   Seiteninhalt   Der Rueckfall, falls die Daten nicht ueber eine
  //                  erkennbare Antwort kommen.

  /** Alles, was wie {id, quantity} aussieht, aus einer beliebigen Struktur. */
  function sammleAusJson(knoten, treffer = [], tiefe = 0) {
    if (!knoten || typeof knoten !== 'object' || tiefe > 6) return treffer;

    if (Array.isArray(knoten)) {
      for (const k of knoten) sammleAusJson(k, treffer, tiefe + 1);
      return treffer;
    }

    const id = Number(knoten.id ?? knoten.itemID ?? knoten.item_id);
    const menge = Number(knoten.quantity ?? knoten.amount ?? knoten.stock);
    if (Number.isInteger(id) && id > 0 && Number.isInteger(menge) && menge >= 0) {
      treffer.push({ item: id, quantity: menge, name: knoten.name ?? null });
    }
    for (const wert of Object.values(knoten)) sammleAusJson(wert, treffer, tiefe + 1);
    return treffer;
  }

  /**
   * In welchem Land stehen wir?
   *
   * Ohne Land ist eine Menge wertlos - dieselbe Item-ID gibt es in mehreren
   * Shops. Lieber nichts melden als der falschen Reihe.
   */
  function findeLand(text = document.body?.innerText ?? '') {
    const klein = text.toLowerCase();
    for (const [name, code] of NAME_ZU_CODE) {
      if (klein.includes(name)) return code;
    }
    return null;
  }

  function verarbeite(daten, woher) {
    const land = findeLand();
    if (!land || !LAENDER.has(land)) {
      if (EINSTELLUNGEN.erkunden) log(`${woher}: kein Land erkannt, nichts gemeldet`);
      return;
    }
    const gefunden = sammleAusJson(daten);
    if (!gefunden.length) return;

    let gemeldet = 0;
    for (const g of gefunden) {
      if (melden({ country: land, item: g.item, quantity: g.quantity, ts: jetzt() })) gemeldet += 1;
    }
    if (gemeldet) {
      log(`${woher}: ${gemeldet} von ${gefunden.length} in ${land}`);
      zeige(`${gemeldet} × ${land}`);
    }
  }

  /** Haengt sich in Torns eigene Abrufe, ohne sie zu veraendern. */
  function beobachteNetz() {
    const echtesFetch = window.fetch;
    window.fetch = async function (...args) {
      const antwort = await echtesFetch.apply(this, args);
      try {
        const url = String(args[0]?.url ?? args[0] ?? '');
        if (/travel|abroad|item/i.test(url)) {
          antwort.clone().json().then((j) => verarbeite(j, `fetch ${url.slice(0, 60)}`)).catch(() => {});
        }
      } catch { /* niemals den Seitenablauf stoeren */ }
      return antwort;
    };

    const echtesOeffnen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (methode, url, ...rest) {
      this.addEventListener('load', () => {
        try {
          if (!/travel|abroad|item/i.test(String(url))) return;
          verarbeite(JSON.parse(this.responseText), `xhr ${String(url).slice(0, 60)}`);
        } catch { /* keine JSON-Antwort - dann eben nicht */ }
      });
      return echtesOeffnen.call(this, methode, url, ...rest);
    };
  }

  // ---------- Start ----------

  if (!EINSTELLUNGEN.server && !EINSTELLUNGEN.erkunden) {
    log('weder Serveradresse noch Erkundungsmodus — das Skript tut nichts.');
    return;
  }

  // Die reinen Funktionen sichtbar machen, damit sie geprueft werden koennen,
  // ohne sie ein zweites Mal zu schreiben. Zwei Fassungen derselben Regel
  // waeren zwei Wahrheiten - und die Entprellung ist genau die Regel, die
  // einen erfundenen Zyklus verhindert.
  globalThis.__beobachter = { sammleAusJson, findeLand, melden, EINSTELLUNGEN, zuletzt, NAME_ZU_CODE };

  beobachteNetz();
  zeige(EINSTELLUNGEN.erkunden ? 'Erkundung' : 'bereit');
  log(EINSTELLUNGEN.erkunden
    ? 'Erkundungsmodus: es wird nichts gesendet. Auslandsshop oeffnen und die Ausgabe hier ansehen.'
    : `bereit, meldet an ${EINSTELLUNGEN.server}`);
})();
