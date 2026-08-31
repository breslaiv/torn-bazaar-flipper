# Torn Bazaar Flipper

Statischer Scanner, der Bazaar-Angebote aus der [weav3r.dev](https://weav3r.dev/api-docs.html)-API
gegen Torn-Referenzpreise rechnet und daraus eine nach Profit sortierte Trefferliste baut.
Kein Backend, kein Build-Schritt — reines HTML/CSS/ES-Modules, läuft direkt auf GitHub Pages.

## Wie gerechnet wird

```
Netto-Verkauf = Referenzpreis × Verkaufsfaktor × (1 − Gebühr)
Profit/Stück  = Netto-Verkauf − Bazaar-Preis
Gesamtprofit  = Profit/Stück × min(verfügbare Menge, Budget / Bazaar-Preis)
```

**Referenzpreis** ist standardmäßig Torns `market_value`. Das ist eine bewusste Entscheidung:
Torns API erlaubt 100 Requests pro Minute, ein Vollscan des Item Markets ist damit unmöglich.
`market_value` kommt für *alle* Items in einem einzigen Request. Für die besten N Treffer holt
die App danach den echten Item-Market-Tiefstpreis nach und rechnet neu — diese Zeilen sind in
der Tabelle als `verifiziert` markiert.

**Verkaufsfaktor** ist die Stellschraube für das private Trade-Szenario: Wenn dein Abnehmer
90 % des Marktwerts zahlt, trag 90 ein. Trades sind in Torn gebührenfrei, die Gebühr bleibt
dann auf 0.

Zeilen, deren Bazaar-Preis unter 15 % der Referenz liegt, bekommen ein `prüfen`-Flag statt
weggefiltert zu werden. Solche Ausreißer sind fast immer ein veraltetes Listing oder ein
Item, dessen `market_value` nicht stimmt — selten ein echter Fund.

## Einrichtung

1. **Torn API-Key** unter <https://www.torn.com/preferences.php#tab=api> erzeugen.
   *Public Access* reicht für Item-Namen, `market_value` und Item-Market-Preise.
2. Seite öffnen → **Einstellungen** → Key eintragen.
3. **weav3r Endpoint-URL** aus <https://weav3r.dev/api-docs.html> eintragen.
   Braucht der Endpoint eine Item-ID im Pfad, setz `{ITEM_ID}` als Platzhalter ein —
   die App scannt dann die unter *Item-IDs* gelisteten Items (oder ersatzweise die
   teuersten, gedeckelt durch *Max. Items pro Scan*).
4. **Speichern**, dann **Scan starten**.

Bricht der Scan mit einem Netzwerk-/CORS-Fehler ab: `diagnose.html` öffnen und
*weav3r testen*. Die Seite zeigt Statuscode, sichtbare Header, die Rohantwort und was
der Parser daraus gelesen hat.

### Keys

Beide Schlüssel liegen ausschließlich im `localStorage` deines Browsers. Sie gehen nur an
`api.torn.com` bzw. an den von dir eingetragenen weav3r-Endpoint und landen nie im Repository.
*Einstellungen zurücksetzen* löscht sie wieder.

## Hosting auf GitHub Pages

Der Workflow `.github/workflows/pages.yml` deployt bei jedem Push auf `main`. Einmalig nötig:
**Settings → Pages → Source: GitHub Actions**. Danach liegt die App unter
`https://<user>.github.io/torn-bazaar-flipper/`.

Lokal testen geht genauso — nur nicht per `file://`, weil ES-Modules dort an CORS scheitern:

```bash
python3 -m http.server 8000   # dann http://localhost:8000
```

## Die offene Frage: CORS

Ob die App wirklich *nur* auf GitHub Pages laufen kann, hängt an einem Header, den weav3r
sendet oder eben nicht: ohne `Access-Control-Allow-Origin` für deine `github.io`-Domain darf
der Browser die Antwort nicht lesen. `diagnose.html` beantwortet das in zehn Sekunden.

Wenn es scheitert, gibt es zwei Wege:

| Weg | Kosten | Aktualität | Kein Key im Browser |
|---|---|---|---|
| Cloudflare Worker als CORS-Proxy | kostenlos, aber ein zweites Deployment | live | nein |
| GitHub Actions holt die Daten periodisch als JSON ins Repo | keine | so alt wie das Cron-Intervall | ja |

Beides hängt sich an `js/weav3r.js` an, ohne den Rest anzufassen — der Datenzugriff steckt
komplett in dieser einen Datei.

## Aufbau

```
index.html          Scanner
diagnose.html       CORS-/Schema-Test gegen den echten Endpoint
js/config.js        Defaults und Konstanten
js/storage.js       localStorage: Einstellungen und Item-Cache
js/torn.js          Torn API v2 mit Rate-Limit-Fenster (80/min)
js/weav3r.js        weav3r-Adapter + Normalisierung der Antwort
js/profit.js        Profit-Rechnung und Filter
js/ui.js            Tabelle, Formatierung, Sortierung
js/app.js           Ablaufsteuerung
tests/              node --test, ohne Abhängigkeiten
```

Das weav3r-Response-Schema ist **nicht** fest verdrahtet: `normalizeBazaar()` sucht im JSON
nach Arrays, die nach Listings aussehen, und erkennt die üblichen Feldnamen
(`item_id`/`itemId`, `price`/`cost`, `quantity`/`amount`/`qty`, `player_id`/`user_id`).
Auch die Form `{"206": [...]}` mit der Item-ID als Schlüssel wird verstanden. Passt das
Schema trotzdem nicht, ist `js/weav3r.js` die einzige Datei, die angefasst werden muss.

## Tests

```bash
npm test
```

20 Tests über Normalisierung und Profit-Rechnung, ohne externe Abhängigkeiten oder Netzwerk.

## Grenzen

- Bazaar-Daten sind nur so aktuell wie das, was weav3r liefert. Gute Angebote sind in Torn
  oft in Sekunden weg — die Liste ist ein Vorschlag, keine Garantie.
- `market_value` ist ein gleitender Durchschnitt und kann bei dünn gehandelten Items deutlich
  vom real erzielbaren Preis abweichen. Dafür gibt es den Live-Check der Top-Treffer.
- Der Item-Cache hält Stammdaten standardmäßig 60 Minuten. Bei volatilen Preisen kürzer setzen
  oder den Cache manuell leeren.
