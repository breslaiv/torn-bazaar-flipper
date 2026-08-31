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
mehr bietet, ist kein Fortschritt. Standardmäßig fallen negativ bewertete Käufer raus; das
Häkchen lässt sich abwählen.

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

- **Nimm einen *Public Only*-Key.** Er reicht für alles, was die App tut. Selbst wenn er
  abhandenkommt, gibt er nur öffentliche Daten preis — kein Geld, kein Inventar, keine Mails.
- **Key auf einem fremden Rechner?** Danach *Einstellungen zurücksetzen* klicken, das leert
  den `localStorage`.
- **Verdacht auf Kompromittierung:** Key unter
  [Preferences → API Key](https://www.torn.com/preferences.php#tab=api) löschen und neu
  erzeugen. Das ist sofort wirksam.

Der Torn-Key wandert als Query-Parameter (`?key=`) statt als `Authorization`-Header — das
ist bei Torn üblich und vermeidet einen CORS-Preflight. Er steht damit in keiner
Adresszeile und in keinem Browserverlauf, weil er nur in `fetch`-Aufrufen vorkommt.


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
js/ui.js            Tabelle, Formatierung, Sortierung
js/app.js           Verdrahtung
tests/              node --test, ohne Abhängigkeiten (inkl. Secret-Scan)
```

`scan.js` nimmt seine API-Funktionen per `deps` entgegen, deshalb laufen die Ablauf-Tests
ohne Netzwerk und ohne Mock-Framework.

## Tests

```bash
npm test
```

39 Tests über Response-Parsing, Vorauswahl, Profit-Rechnung, Scan-Ablauf sowie die
Key- und CSP-Prüfungen aus dem Abschnitt Sicherheit.

## Grenzen

- Antworten sind serverseitig 30–180 s gecacht. Gute Angebote sind in Torn oft schneller
  weg als der Cache alt ist — die Liste ist ein Vorschlag, keine Garantie.
- Wie viel ein Käufer tatsächlich abnimmt, steht in keiner API. Die Mengenspalte zeigt, was
  im Bazaar liegt und was das Budget hergibt, nicht was der Käufer abnehmen will.
- Ankaufspreise stammen aus der Pricelist des Käufers zum Abfragezeitpunkt. Vor einem großen
  Trade lohnt eine kurze Rückfrage.
- Die Vorauswahl sortiert nach absoluter Spanne. Wer lieber auf Marge optimiert, setzt
  „Kandidat ab Rabatt" niedriger und filtert über die Mindest-Marge.
