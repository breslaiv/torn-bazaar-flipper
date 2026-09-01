# Arbeitsregeln für dieses Repository

> Was als Nächstes ansteht, steht in `WEITER.md`. Hier stehen die Regeln, die
> dabei gelten.

Statischer Bazaar-Flipping-Scanner für Torn.com plus Flugplaner und Ledger.
Reine ES-Module, kein Build, gehostet auf GitHub Pages. Ausführliche Begründung
zu jedem Teil steht im README — das hier sind die Regeln, die man verletzt,
bevor man das README liest.

## Keine Schlüssel im Repository

Das Repository war öffentlich, weil GitHub Pages das im Free-Tier verlangt.
Inzwischen ist es privat und die Fassung läuft lokal — die Regeln bleiben
trotzdem, und zwar unverändert:

- API-Keys leben **nur** im `localStorage` des Besuchers, nie im Code.
- `DEFAULTS.tornKey` und `DEFAULTS.weav3rKey` bleiben leer.
- Collector-Workflows benutzen **kein** `secrets.` — ein Test setzt das durch.
- `tests/no-secrets.test.mjs` läuft bei jedem Push mit.

Privat heißt nicht sicher, und es heißt vor allem nicht *dauerhaft* privat.
Ein Repository lässt sich mit zwei Klicks wieder öffentlich machen, es wird
geteilt, geforkt, gesichert — und die Historie vergisst nichts. Ein einmal
committeter Key ist in jedem Klon und in jedem Backup, auch nachdem die Zeile
gelöscht wurde. Die Regeln kosten nichts; sie hinterher zu brauchen, kostet
den Key.

Aus demselben Grund steht in `WEITER.md` keine Tailnet-Adresse.

## Keine Abhängigkeiten

`package.json` hat keine `dependencies` und keine `devDependencies`. Das ist
kein Zufall, sondern die Eigenschaft, die das Projekt wartbar hält.

- Tests: `node --test tests/*.test.mjs`, ohne Framework.
- SQLite über das eingebaute `node:sqlite`, nicht über ein npm-Paket.
- Playwright wird für Browserprüfungen **ad hoc** installiert und **vor dem
  Commit wieder entfernt**: `rm -rf node_modules package-lock.json` und
  `git checkout package.json`.

## Versionsstempel

Nach **jeder** Änderung an `js/`, `css/` oder den HTML-Seiten:

```bash
# js/config.js: APP_VERSION hochzählen, dann
python3 tools/version-assets.py
```

Der Stempel hängt an jedem Import und macht eine neue Fassung zu einer eigenen
URL. Ohne ihn liefert der Browser tagelang den alten Stand.
`tests/version.test.mjs` prüft die Konsistenz.

## Content-Security-Policy

Jede Seite bringt ihre CSP im Markup mit: `default-src 'none'`, `connect-src`
als namentliche Erlaubnisliste, kein `unsafe-*`.

- **Kein `style="…"` im Markup.** Werte zur Laufzeit über CSSOM setzen
  (`el.style.width = …`) — das erlaubt die CSP, ein Attribut nicht.
- Ein neuer Host in `connect-src` ist eine bewusste Entscheidung, keine
  Nebenwirkung.

## Tests sind Wächter, nicht Deko

Aktuell 443. Mehrere Tests lesen das Verzeichnis mit `readdirSync` statt einer
Liste — eine neue HTML-Seite muss die Prüfungen zu Viewport, Safe-Area, CSP,
Navigation und `for=`-Zuordnung bestehen, ohne dass jemand sie einträgt. Genau
das war mit `travel.html` einmal schiefgegangen.

Vor dem Commit: `npm test`.

## Kommentare erklären das Warum

Deutsch, und sie begründen die Entscheidung statt den Code nachzuerzählen. Wenn
eine Zeile aussieht wie ein Fehler und keiner ist, gehört der Grund daneben.

## Zwei fachliche Regeln, die man leicht verletzt

**Nachschub-Timer starten bei 0.** Der Timer eines Items läuft ab dem Moment,
in dem sein Regal leer ist, und ist je Item verschieden. Eine periodische
Annahme („alle 15 Minuten") ist strukturell falsch — das war schon einmal
gebaut und musste ersetzt werden.

**Eine gecachte YATA-Antwort ist keine neue Messung.** Der Zeitstempel der
Quelle zählt, nicht die eigene Uhr. Zählte jede Abfrage als Messpunkt, wäre
jede Reihe voller erfundener Beobachtungen.

## Keine Automatisierung von Spielhandlungen

Torn-Regeln. Das Werkzeug rechnet und empfiehlt, es handelt nicht.

## Lieber „zu wenig Daten" als eine erfundene Zahl

Wo die Datenlage nicht reicht, sagt die Oberfläche das. Eine plausible Zahl
ohne Grundlage ist schlimmer als eine Lücke, weil man sie nicht als Lücke
erkennt.

## Die lokale Fassung

Läuft auf einer eigenen Maschine: `tools/setup-local.sh` richtet sie ein,
`tools/collect-local.mjs` misst durchgehend, `tools/serve.mjs` liefert aus.

- Der Webserver hängt an `127.0.0.1`. Zugriff von außen läuft über Tailscale.
- Der Dauersammler benutzt `collectOnce()` und `watch()` aus dem
  Actions-Sammler — **keine zweite Rechnung**. Zwei Sammler mit zwei Regeln
  wären zwei Wahrheiten.
- `data/local/` ist in `.gitignore`. Die Messdatenbank bleibt auf der Maschine.
