# Torn Bazaar Flipper

Findet Bazaar-Listings, die unter dem liegen, was ein anderer Spieler per Trade dafür zahlt.
Nutzt die [TornW3B-API](https://weav3r.dev/api-docs.html). Kein Backend, kein Build-Schritt,
kein API-Key — reines HTML/CSS/ES-Modules, läuft direkt auf GitHub Pages.

## Der Loop

Die Verkaufsseite ist nicht geschätzt, sondern konkret: `/marketplace/{id}/traders` liefert
Spieler mit öffentlicher Pricelist, die dieses Item ankaufen, samt berechnetem Ankaufspreis.
Die API filtert dabei bereits auf Händler, die in den letzten 7 Tagen gehandelt haben und in
den letzten 48 Stunden online waren.

```
1 Request   GET /marketplace                     alle Items: Marktpreis, billigstes Listing
            ↓ Vorauswahl: billigstes Listing ≤ X% des Marktpreises, nach Spanne sortiert
2N Requests GET /marketplace/{id}                Bazaar-Listings, günstigste zuerst
            GET /marketplace/{id}/traders        Käufer, höchster Ankaufspreis zuerst

Profit/Stück = Ankaufspreis × Sicherheitsabschlag − Bazaar-Preis
Gesamtprofit = Profit/Stück × min(verfügbare Menge, Budget / Bazaar-Preis)
```

Die Vorauswahl ist nötig, weil jeder Kandidat zwei Requests kostet und Cloudflare bei
100 Aufrufen/Minute dichtmacht. Bei 35 Kandidaten sind das 71 Requests pro Scan; der Client
drosselt selbst auf 80/Minute.

**Zweiter Modus: $1-Bazaare.** `/dollar-bazaars/items` listet Items, die für einen Dollar
im Bazaar stehen — der Kaufpreis ist per Definition 1, der Profit praktisch der volle
Marktwert. Diese Listings sind aus `/marketplace/{id}` bewusst ausgeschlossen und nur
über diese Route zu finden.

## Zwei Fallen, die der Client abfängt

**Gesponserte Zeilen.** Sowohl bei Listings als auch bei Tradern hängt die API einen
bezahlten Eintrag vorne an, unabhängig vom Preis. Wer die Liste für sortiert hält, kauft
teurer als nötig. Der Client sortiert selbst nach und markiert die Zeile als `gesponsert`.

**Der höchste Preis ist nicht das beste Angebot.** Ein Käufer mit 6 Downvotes, der 10.000
mehr bietet, ist kein Fortschritt. Unter *Mindestbewertung Käufer* steht die Untergrenze
für Upvotes minus Downvotes — dieselbe Zahl, die als Chip neben dem Käufer steht. Die
Vorgabe 0 lässt neue Käufer zu und schließt negativ bewertete aus; negative Werte lassen
auch die zu.

Höhere Ansprüche kosten Marge, weil der bestbewertete Käufer selten der teuerste ist:

| Mindestbewertung | gewählter Käufer | Profit |
|---|---|---|
| −5 | −3, bietet $790.000 | $377.500 |
| 0 | +10, bietet $780.000 | $337.500 |
| 50 | +59, bietet $760.000 | $240.000 |

Damit sich der Wert überhaupt einstellen lässt, nennt die Statuszeile den Grund für
fehlende Treffer getrennt: „ohne aktiven Käufer" heißt, es gibt für dieses Item keinen —
„nur unter Bewertung 10" heißt, es gäbe welche, sie sind dir nur zu schlecht bewertet.
Nur der zweite Fall lässt sich über die Einstellungen ändern.

Zeilen, deren Bazaar-Preis unter 15 % des Marktpreises liegt, bekommen ein `prüfen`-Flag
statt weggefiltert zu werden — solche Ausreißer sind meist ein veraltetes Listing.

## Einrichtung

Seite öffnen, **Scan starten**. Mehr braucht es nicht — alle genutzten Routen sind öffentlich.

Zwei optionale Keys, beide nur im `localStorage` des Browsers und nie im Repository:

- **Torn API-Key** (*Public Only* reicht): schaltet die Gegenprobe gegen den echten
  Item-Market-Tiefstpreis frei, angezeigt als `IM $…` an der Trefferzeile.
- **weav3r API-Key**: für die hier genutzten Routen nicht nötig, nur für Pricelist- und
  Trade-Endpunkte.

Bricht ein Scan mit einem Netzwerkfehler ab: `diagnose.html` öffnen und **Alle Routen
testen**. Die Seite geht jede benutzte Route einzeln durch und zeigt, woran es hängt.

## Gegencheck über W3B

Der Itemname jeder Trefferzeile verlinkt auf die W3B-Seite zu diesem Item — dort lassen sich
Listings und Ankaufspreise gegenprüfen, bevor Geld fließt. Auf dem Handy ist die ganze
Kartenüberschrift das Tippziel, erkennbar am Pfeil rechts; die Zeile kostet keinen zusätzlichen
Platz.

Die Adresse steht in den Einstellungen unter *Gegencheck*, Vorgabe:

```
https://weav3r.dev/marketplace/{ITEM_ID}
```

**Diese URL ist eine Annahme, keine belegte Tatsache.** Die OpenAPI-Spec beschreibt nur die
API-Routen (`/api/marketplace/{itemId}`), nicht die Seiten der Weboberfläche, und aus der
Entwicklungsumgebung war `weav3r.dev` nicht erreichbar. Die Vorgabe spiegelt deshalb die
API-Route. Stimmt sie nicht, ist es ein Feld statt einer Codeänderung: Muster anpassen,
speichern, fertig — `{ITEM_ID}` wird ersetzt, ein leeres Feld schaltet den Link ab.

Angenommen werden nur `http://`- und `https://`-Adressen. Ein Muster wie `javascript:…` käme
zwar aus dem eigenen `localStorage`, landet aber trotzdem nicht in einem `href`.


## Ledger

`ledger.html` führt Buch über Käufe, Verkäufe und den Profit dazwischen.

**Gespeichert werden Ereignisse, keine fertigen Trades.** Ein Kauf wird oft in mehreren
Portionen verkauft, ein Verkauf bedient sich aus mehreren Käufen, und dazwischen liegt Ware
im Bestand — das lässt sich nur als Ereignisstrom abbilden. Zugeordnet wird nach **FIFO**:
der älteste Kauf deckt den nächsten Verkauf. Das entspricht der Reihenfolge, in der man Ware
tatsächlich losschlägt, und bleibt nachvollziehbar, wenn man eine Zeile im Nachhinein prüft.

Daraus fallen zwei Listen an:

- **Offene Positionen** — gekauft, noch nicht verkauft. Zeigt, wo dein Kapital liegt. Sie
  ignorieren den Zeitraumfilter: ein Kauf von vor 90 Tagen bindet immer noch Geld.
- **Abgeschlossene Verkäufe** — je Verkauf Einstand, Erlös, Profit und Marge.

**Verkäufe ohne Einstand fließen nicht in den Profit.** Wer Ware verkauft, die vor dem
ersten Import gekauft wurde, hätte sonst reinen Fantasiegewinn in der Bilanz. Diese Menge
wird stattdessen als eigene Kachel *Ohne Einstand* ausgewiesen.

### Import aus dem Torn-Log

Gebaut gegen Torns offizielle OpenAPI-Spec (6.13.1). Zwei Dinge daraus bestimmen den Ablauf.

**`/user/log` verlangt einen Key mit Full Access.** So steht es in der Spec — Limited reicht
nicht. Das ist der weiteste Zugriff, den Torn kennt: ein solcher Key liest auch Geld,
Inventar und Nachrichten. Das steht im Widerspruch zur Public-Only-Empfehlung weiter oben,
und der Widerspruch lässt sich nicht wegdiskutieren, nur handhaben: **leg für den Ledger
einen eigenen Key an**, statt den Scanner-Key aufzuwerten, und lösch ihn, wenn du den Import
nicht mehr brauchst. Fehlt der Zugriff, antwortet Torn mit Fehler 16, den die App im
Klartext meldet.

**Geraten wird nichts.** `/torn/logtypes` liefert alle Log-Typen mit Id und Titel und
braucht nur einen Public-Key. Der Import holt diese Liste zuerst, bildet die Titel per
Stichwort auf Kauf und Verkauf ab und lässt `/user/log` dann **serverseitig** danach filtern
(`log=5360,5361,…`). Damit blättert der Client keine irrelevanten Kategorien durch, und die
Zuordnung stammt aus Torns eigener Benennung statt aus einer Vermutung.

Der Bericht vor dem Übernehmen zeigt beides: welche Log-Typen zugeordnet wurden — mit Id und
Torns Originaltitel, also nachprüfbar — und was aus welchem Grund liegen blieb. Passt eine
Zuordnung nicht, ist das eine Zeile in `RULES` in `js/tornlog.js`. Findet sich kein einziger
Typ, liest die App ungefiltert und der Bericht zeigt, wie Torn die Einträge nennt.

Wiederholte Importe verdoppeln nichts: jeder Log-Eintrag trägt seine Referenz mit.

Die Feldnamen *innerhalb* von `data` und `params` lässt die Spec bewusst offen
(„Dynamic key-value pairs"), deshalb bleibt die Extraktion von Item, Menge und Betrag
defensiv und meldet, was sie nicht lesen konnte.

Trades mit **mehreren Items** werden bewusst nicht übernommen: ohne Einzelpreise liesse sich
die Summe nicht fair aufteilen. Sie erscheinen im Bericht und gehören von Hand erfasst.

Itemnamen holt der Import aus dem öffentlichen weav3r-Katalog (ein Request, kein Key) und
trägt sie auch bei früher importierten Zeilen nach. Scheitert das, heissen die Zeilen
`Item 206` — kein Grund, den Import abzubrechen.

### Sicherung

Der Ledger liegt im `localStorage`. **iOS Safari räumt den bei längerer Nichtnutzung weg** —
für eine Historie ist das ein echtes Risiko, nicht nur eine Fussnote. Deshalb Export und
Import als JSON, und ein Hinweis oben auf der Seite, solange nie oder lange nicht exportiert
wurde. Der Export läuft über eine Blob-URL; dass die unter der strengen CSP durchgeht, ist
im Browser gegengeprüft.


## Sicherheit der API-Keys

GitHub Pages verlangt im Free-Tier ein öffentliches Repository. **Das macht die Keys nicht
öffentlich** — sie stehen nirgends im Repo. Öffentlich wird der Quelltext; die Keys liegen im
`localStorage` des jeweiligen Browsers, gehen nie an GitHub und nie an einen Server dieses
Projekts. Wer die Seite besucht, sieht ausschließlich seinen eigenen Key.

Damit bleiben zwei reale Risiken, und beide sind abgedeckt:

**1. Ein Key landet versehentlich im Code.** Die Git-Historie eines öffentlichen Repos ist
dauerhaft einsehbar — ein späteres Löschen hilft nicht mehr. `tests/no-secrets.test.mjs`
prüft bei jedem Push, dass kein Key an eine Key-Variable hartcodiert ist, in keiner URL
steht und die Voreinstellungen in `config.js` leer ausgeliefert werden. `.gitignore` sperrt
zusätzlich `.env`, `secrets.*`, `credentials.*` und `*.key`.

**2. Eingeschleuster Code schickt den Key nach draußen.** Beide Seiten setzen eine
Content-Security-Policy:

```
default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:;
connect-src https://weav3r.dev https://api.torn.com; base-uri 'none'; form-action 'none'
```

`connect-src` ist die entscheidende Zeile: der Browser lässt Verbindungen **nur** zu diesen
zwei Hosts zu. Ein Versuch, den `localStorage` an einen fremden Server zu senden, wird
blockiert, bevor der Request die Maschine verlässt. `script-src 'self'` ohne `unsafe-inline`
verhindert, dass überhaupt fremder Code läuft. Deshalb enthält keine Seite Inline-Scripts
oder `style=`-Attribute — die Testsuite prüft auch das, sonst würde die Policy still etwas
kaputtmachen.

Alle Werte aus der API werden vor dem Rendern escaped, Spieler-IDs in Links laufen durch
`Number()`. Ein Itemname wie `<img src=x onerror=…>` erscheint als Text, nicht als Element.

Was du selbst tun solltest:

- **Nimm einen *Public Only*-Key.** Er reicht für alles, was der Scanner tut. Selbst wenn er
  abhandenkommt, gibt er nur öffentliche Daten preis — kein Geld, kein Inventar, keine Mails.
  Einzige Ausnahme ist der Log-Import des Ledgers, der laut Torns Spec Full Access verlangt;
  dafür lieber einen zweiten, jederzeit löschbaren Key als eine Aufwertung des ersten.
- **Key auf einem fremden Rechner?** Danach *Einstellungen zurücksetzen* klicken, das leert
  den `localStorage`.
- **Verdacht auf Kompromittierung:** Key unter
  [Preferences → API Key](https://www.torn.com/preferences.php#tab=api) löschen und neu
  erzeugen. Das ist sofort wirksam.

Der Torn-Key wandert als Query-Parameter (`?key=`) statt als `Authorization`-Header — das
ist bei Torn üblich und vermeidet einen CORS-Preflight. Er steht damit in keiner
Adresszeile und in keinem Browserverlauf, weil er nur in `fetch`-Aufrufen vorkommt.


## Auf dem Handy

Die Oberfläche ist für die Nutzung am Telefon gebaut, nicht nur dafür verkleinert.

**Aus der Tabelle werden Karten.** Zehn Spalten sind auf 393 px nicht lesbar. Unter 720 px
verschwindet die Kopfzeile und jede Trefferzeile wird zu einer Karte: Itemname als
Überschrift, darunter ein zweispaltiges Raster mit Label über Wert. Kaufseite und
Verkaufsseite stehen dabei nebeneinander — Bazaar/Kaufpreis, Käufer/Ankauf,
Profit/Marge, Menge/Gesamt. Dasselbe Markup, nur anderes CSS: die Zell-Labels kommen aus
`data-label`, gespeist aus derselben Spaltendefinition wie die Kopfzeile in `js/ui.js`.
Weil ohne Kopfzeile niemand sortieren kann, gibt es darüber ein Auswahlfeld plus
Richtungsknopf auf derselben Sortierfunktion.

Die Netto-Zelle entfällt auf dem Handy, solange sie den Ankaufspreis nur wiederholt —
also immer, wenn weder Sicherheitsabschlag noch Gebühr gesetzt sind. Zusammen mit dem
Raster halbiert das die Kartenhöhe von rund 430 auf 254 px; statt einer Karte sind damit
drei gleichzeitig im Bild.

**Was sonst noch anders ist:**

- Eingabefelder sind auf 16 px gesetzt. Darunter zoomt Safari beim Fokussieren in die Seite
  hinein, und man tippt danach in einer verschobenen Ansicht weiter.
- Alle Bedienelemente sind mindestens 44 px hoch — Apples Mindestmaß für ein Tippziel.
- `viewport-fit=cover` plus `env(safe-area-inset-*)`: Inhalt bleibt aus Dynamic Island,
  abgerundeten Ecken und Home-Indikator heraus.
- Die Scan-Leiste klebt am unteren Rand, statt am Seitenanfang zu verschwinden.
- Ein Scan dauert 30–60 Sekunden. Ein Fortschrittsbalken in der Leiste zeigt, dass noch
  etwas passiert.
- Die Einstellungen sind ab dem zweiten Besuch zugeklappt — sonst stehen 15 Felder zwischen
  Seitenanfang und Trefferliste.
- Kein verschachteltes Scrollen: auf dem Handy scrollt die Seite, nicht ein Kasten in ihr.

**Auf den Home-Screen legen:** In Safari über *Teilen → Zum Home-Bildschirm*. Das Manifest
startet die App dann ohne Browser-Leiste, mit dunkler Statusleiste und eigenem Icon.
`icon-180.png` wird von `tools/make-icon.py` erzeugt — iOS akzeptiert für
`apple-touch-icon` kein SVG, und die Umgebung hatte keinen Konverter, also schreibt das
Skript das PNG direkt.

Ein Hinweis zur Ehrlichkeit: sperrst du das Telefon mitten im Scan, hält iOS die Seite an.
Der Scan läuft weiter, sobald du zurückkommst, aber er wird dadurch langsamer. Bei
ungeduldiger Nutzung lohnt es, *Max. Kandidaten* zu senken — 20 statt 35 halbiert die
Laufzeit.


## Hosting auf GitHub Pages

`.github/workflows/pages.yml` deployt bei jedem Push auf `main`. Einmalig nötig:
**Settings → Pages → Source: GitHub Actions**. Danach liegt die App unter
`https://<user>.github.io/torn-bazaar-flipper/`.

Lokal geht das genauso — nur nicht per `file://`, weil ES-Modules dort an CORS scheitern:

```bash
python3 -m http.server 8000   # dann http://localhost:8000
```

### Falls CORS blockt

Ob die App wirklich ohne Backend auskommt, hängt an einem Header, den weav3r sendet oder
nicht: ohne `Access-Control-Allow-Origin` für die `github.io`-Domain darf der Browser die
Antwort nicht lesen. `diagnose.html` klärt das in zehn Sekunden. Der Client schickt bewusst
keine Zusatz-Header (der API-Key ginge als Query-Parameter), damit kein CORS-Preflight nötig
wird — das ist die häufigste Ursache dafür, dass ein offener Endpunkt im Browser trotzdem
scheitert.

Falls es scheitert, gibt es zwei Wege, die beide nur `js/weav3r.js` betreffen:

| Weg | Kosten | Aktualität |
|---|---|---|
| Cloudflare Worker als CORS-Proxy | kostenlos, aber ein zweites Deployment | live |
| GitHub Actions holt die Daten periodisch als JSON ins Repo | keine | so alt wie das Cron-Intervall |

## Aufbau

```
index.html          Scanner
diagnose.html       Routen- und CORS-Test gegen den echten Server
js/config.js        Defaults, Basis-URLs, Rate-Limits
js/ratelimit.js     Gleitendes 60-Sekunden-Fenster, je Host eine Instanz
js/weav3r.js        TornW3B-Client: Katalog, Listings, Trader, $1-Bazaare
js/torn.js          Torn API v2, optional, nur für die Item-Market-Gegenprobe
js/profit.js        Vorauswahl, Käuferwahl, Profit-Rechnung, Filter
js/scan.js          Ablauf eines Scans, abbrechbar, mit Fortschrittsmeldung
js/storage.js       localStorage
js/ui.js            Spaltendefinition, Tabelle/Karten, Sortierung
js/app.js           Verdrahtung, Fortschritt
ledger.html         Buchführung über Käufe, Verkäufe und Profit
js/ledger.js        Ereignismodell, FIFO-Zuordnung, Kennzahlen
js/ledgerStore.js   localStorage, Export und Import
js/tornlog.js       Log-Typen von Torn, serverseitig gefilterter Import, Bericht
js/table.js         Tabellenbau mit data-label für die Kartenansicht
js/ledgerPage.js    Verdrahtung der Ledger-Seite
tools/make-icon.py  erzeugt icon-180.png fuer den iOS-Home-Screen
tests/              node --test, ohne Abhängigkeiten (inkl. Secret-Scan)
```

`scan.js` nimmt seine API-Funktionen per `deps` entgegen, deshalb laufen die Ablauf-Tests
ohne Netzwerk und ohne Mock-Framework.

## Tests

```bash
npm test
```

134 Tests über Response-Parsing, Vorauswahl, Käuferwahl, Profit-Rechnung, Scan-Ablauf,
Markup, Sortierung, Link-Erzeugung, FIFO-Zuordnung, Log-Auswertung und Persistenz sowie
die Key-, CSP-, Workflow- und Mobile-Prüfungen aus den Abschnitten oben.

Der Sortier-Controller wird gegen einen kleinen DOM-Stub getestet (`tests/sorting.test.mjs`),
weil dort ein Fehler saß, den die reine Sortierfunktion nicht zeigen konnte.

## Grenzen

- Antworten sind serverseitig 30–180 s gecacht. Gute Angebote sind in Torn oft schneller
  weg als der Cache alt ist — die Liste ist ein Vorschlag, keine Garantie.
- Wie viel ein Käufer tatsächlich abnimmt, steht in keiner API. Die Mengenspalte zeigt, was
  im Bazaar liegt und was das Budget hergibt, nicht was der Käufer abnehmen will.
- Ankaufspreise stammen aus der Pricelist des Käufers zum Abfragezeitpunkt. Vor einem großen
  Trade lohnt eine kurze Rückfrage.
- Die Vorauswahl sortiert nach absoluter Spanne. Wer lieber auf Marge optimiert, setzt
  „Kandidat ab Rabatt" niedriger und filtert über die Mindest-Marge.
