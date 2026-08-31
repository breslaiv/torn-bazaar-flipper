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
            ↓ Vorauswahl: billigstes Listing ≤ X% des Marktpreises,
            ↓ nach erwartetem Profit sortiert, Filter schon hier angelegt
2N Requests GET /marketplace/{id}                Bazaar-Listings, günstigste zuerst
            GET /marketplace/{id}/traders        Käufer, höchster Ankaufspreis zuerst
            ↓ mehrere Kandidaten gleichzeitig (Einstellung *Parallele Abfragen*)

Profit/Stück = Ankaufspreis × Sicherheitsabschlag − Bazaar-Preis
Gesamtprofit = Profit/Stück × zugeteilte Menge   (Budget über alle Zeilen verteilt)
```

Die Vorauswahl ist nötig, weil jeder Kandidat zwei Requests kostet und Cloudflare bei
100 Aufrufen/Minute dichtmacht. Bei 35 Kandidaten sind das 71 Requests pro Scan; der Client
drosselt selbst auf 80/Minute.

**Gemessen wird an derselben Rechnung wie später die Zeile**, nur mit dem Marktpreis als
Platzhalter für den Ankaufspreis. Wer die Profit- und Margenschwelle schon dagegen reißt,
kann sie gegen einen realen Käufer erst recht nicht halten — Käufer zahlen unter Markt, nicht
darüber. Der Platzhalter schätzt also zu günstig, und das ist die richtige Richtung: lieber
ein Kandidat zu viel als ein echter Flip, der nie geprüft wird. Sortiert wird nach diesem
erwarteten Profit statt nach der nackten Preisspanne; nach Spanne gewinnen sonst teure Items
mit ein paar Prozent Rabatt, und billige Items mit 40% Marge fallen aus den Kandidaten heraus,
obwohl genau sie die Filter bestehen würden.

**Die Kandidaten laufen parallel.** Vorher wartete jeder auf den vorigen: 35 Kandidaten sind
70 Requests hintereinander. Der Rate-Limiter zählt weiterhin jeden Request — er sitzt im
Client, nicht im Ablauf —, nur die Wartezeit auf Antworten überlappt sich. Mit vier
gleichzeitigen Kandidaten dauert ein Scan im Test etwa ein Drittel so lang. Wer auf Nummer
sicher gehen will, stellt *Parallele Abfragen* auf 1; dann läuft es wie zuvor.

**Zweiter Modus: $1-Bazaare.** `/dollar-bazaars/items` listet Items, die für einen Dollar
im Bazaar stehen — der Kaufpreis ist per Definition 1, der Profit praktisch der volle
Marktwert. Diese Listings sind aus `/marketplace/{id}` bewusst ausgeschlossen und nur
über diese Route zu finden.

## Zwei Fallen, die der Client abfängt

**Gesponserte Zeilen.** Sowohl bei Listings als auch bei Tradern hängt die API einen
bezahlten Eintrag vorne an, unabhängig vom Preis. Wer die Liste für sortiert hält, kauft
teurer als nötig. Der Client sortiert selbst nach und markiert die Zeile als `gesponsert`.

**Alte Listings sind oft schon verkauft.** weav3r sieht die Bazaare per Crawl; `content_updated`
sagt, wann ein Listing zuletzt bestätigt wurde. Die Spalte *Alter* zeigt es, und *Listing
höchstens (Stunden) alt* wirft zu alte Zeilen raus. In welchem Format der Zeitstempel kommt,
legt die Spec nicht fest — der Client liest Unix-Sekunden, Millisekunden und ISO-Strings, und
was er nicht deuten kann, gilt als **unbekannt**, nicht als uralt. Unbekanntes Alter fällt
deshalb nie durch den Filter: ein Fehlgriff beim Format würde sonst stillschweigend jede Zeile
aussortieren. Beim Käufer steht daneben, wie lange er nichts getan hat — ein Trade an jemanden,
der seit Tagen offline ist, bleibt liegen.

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
  ignorieren den Zeitraum: ein Kauf von vor 90 Tagen bindet immer noch Geld.
- **Abgeschlossene Verkäufe** — je Verkauf Einstand, Erlös, Profit und Marge.

**Zeitraum: Gesamt, Heute, Gestern, 7 Tage, 30 Tage.** Gerechnet wird in Kalendertagen
lokaler Zeit, nicht in rollenden 24-Stunden-Fenstern — *Heute* meint um 9 Uhr morgens den
heutigen Tag und nicht die Zeit ab gestern 9 Uhr. *Gestern* ist der einzige Zeitraum mit
Obergrenze; ohne sie wäre er von „seit gestern" nicht zu unterscheiden. Die Auswahl bleibt
über einen Neuladen hinweg erhalten.

Zugeordnet wird dabei immer über die **ganze** Historie, und erst das Ergebnis wird nach
dem Verkaufsdatum zugeschnitten. Andernfalls verlöre ein Verkauf von heute den Einstand
eines Kaufs von letzter Woche und stünde als Verkauf *ohne Einstand* mit Profit null da.

### Bestand bewerten

Die offenen Positionen zeigten lange nur, was die Ware gekostet hat. Was sie jetzt wert ist,
steht im öffentlichen weav3r-Katalog — ein Request, kein Key —, und wird beim Öffnen der Seite
aus einem zehn Minuten gültigen Zwischenspeicher gefüllt. Daraus die Spalten *Wert jetzt* und
*Unrealisiert* sowie eine eigene Kachel.

Zwei Preise, die nicht dasselbe sind und deshalb getrennt bleiben:

| | Bedeutung |
|---|---|
| **Marktwert** | Torns `market_price`. Was das Item wert ist, nicht was jemand zahlt. Der richtige Maßstab für eine Bestandsbewertung. |
| **Ankauf** | Der Preis des besten Käufers mit öffentlicher Pricelist. Was du jetzt tatsächlich bekämst — meist deutlich darunter. |

Der Ankaufspreis kostet einen Request je Item und läuft deshalb nur auf Knopfdruck
(*Ankaufspreise prüfen*), gedeckelt auf die zwölf größten Positionen. **Ohne Kurs wird nicht
geschätzt:** eine Position ohne Preis bleibt unbewertet und wird als solche gezählt. Der
Einstand als Ersatzwert wäre bequem und falsch — die Position sähe dann immer nach plus/minus
null aus.

### Erfassen und Korrigieren

Beim manuellen Eintrag genügt der **Itemname**; die Vorschlagsliste kommt aus dem Katalog, und
eine reine Zahl gilt weiterhin als Item-ID. Unter dem Feld steht der aktuelle Marktpreis, damit
man den Einstand einordnen kann.

Jede Zeile lässt sich **ändern** statt nur löschen. Id, Quelle und Referenz bleiben dabei
erhalten — sonst käme ein importierter Vorgang beim nächsten Import ein zweites Mal herein.

### Ein Knopf statt vier Schritten

*Aktualisieren* oben auf der Seite holt die Kurse, liest den Log, übernimmt das Gefundene und
bewertet den Bestand. Der ausführliche Bericht entsteht weiterhin und steht im Import-Panel,
falls etwas fehlt. Wer will, lässt das beim Öffnen der Seite automatisch laufen — die Option
ist **aus** als Vorgabe, denn sie kostet jedes Mal einen Zugriff mit dem Full-Access-Key.

### Angebote

Ein Trade, der abläuft, hinterlässt nichts außer der Ware, die wieder im Inventar liegt —
und der Frage, für wen sie eigentlich gedacht war. Das Torn-Log weiß es: `Trade initiate
outgoing` trägt den Text, den man beim Anlegen eingetippt hat („Brass Ingot @ $17,732"),
`Trade items add` die Ware, und `Trade expire` / `Trade cancel …` / `Trade decline …` das
Ende.

Der Ledger bucht davon nur die abgeschlossenen Trades — alles andere ist keine Buchung.
Für die Erinnerung ist aber gerade der Rest wichtig, deshalb landet **jeder** gesehene Trade
im Panel *Angebote*: mit wem, was, wie viel, zu welchem Preis und wie es ausgegangen ist.
Dazu ein Notizfeld, das dir gehört und keinen Import überschrieben bekommt.

Zwei Dinge dazu:

- **„Offen" heißt nicht „läuft noch".** Es heißt: im gelesenen Ausschnitt des Logs steht kein
  Ende. Ist der Abschluss älter als der Import, bleibt der Trade als offen stehen — dann hilft
  ein größerer Ausschnitt. Umgekehrt wird ein einmal beendeter Trade **nie** wieder auf offen
  zurückgedreht, auch wenn ein späterer, kürzerer Import nur noch seine Eröffnung sieht.
- **Der Preis aus dem Angebotstext ist nur ein Hinweis.** Hat die Gegenseite Geld hinterlegt,
  wird damit gerechnet; sonst bleibt der Stückpreis aus dem frei eingetippten Text und die
  Zeile sagt *laut Text* dazu.

Die Angebote liegen unter `tbf.offers.v1` im localStorage, die neuesten 500.

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

Der Key wird direkt im Import-Bereich der Ledger-Seite eingetragen — es ist derselbe wie in
den Scanner-Einstellungen, beide Felder schreiben in denselben Eintrag. Bei leerem Ledger
ist der Bereich schon aufgeklappt, sonst stünden vier Null-Kacheln vor dem Einrichten.

Der Bericht vor dem Übernehmen zeigt beides: welche Log-Typen zugeordnet wurden — mit Id und
Torns Originaltitel, also nachprüfbar — und was aus welchem Grund liegen blieb, **je Grund mit
einem Rohbeispiel**. Ein einziges Beispiel reichte nicht: es zeigt nur die erste Form und
verdeckt genau die Fälle, die man noch nachbessern muss.

Kategorien tragen zwei getrennte Marken, weil es zwei verschiedene Fehler sind: `[Typ ok]`
heisst, der Log-Typ ist bekannt, aber die Daten liessen sich nicht lesen; `[unbekannt]`
heisst, schon der Typ passt zu keiner Regel. Passt etwas nicht, ist das eine Zeile in
`RULES` in `js/tornlog.js`.

**Beträge:** Bazaar und Item Market nennen `cost_each` und `cost_total`. Der Stückpreis wird
aus `cost_each` genommen, nicht aus Summe durch Menge — dasselbe Ergebnis ohne
Rundungsrisiko. Fehlt `cost_each`, bleibt die Division als Rückfall.

**Gefiltert wird über `cat=`, nicht über `log=`.** Der Id-Filter lieferte im echten Betrieb
nichts zurück — auch mit nur zwölf Ids, ohne Fehlermeldung. Die erste Vermutung, es seien zu
viele Ids gewesen, war falsch. Über die Kategorie kommen dagegen genau die Einträge, um die
es geht: ein ungefilterter Abzug von 100 Zeilen enthielt nur **8** Bazaar-Käufe, der Rest
waren Crimes, Company, Trade-Zwischenschritte und Nachrichten. Wer ungefiltert liest, liest
am Ziel vorbei.

Liefert auch `cat=` nichts, wird einmal ungefiltert nachgelesen. Der Bericht sagt in jedem
Fall, welcher Weg gegriffen hat — ein leeres Ergebnis ist nie von „nichts passiert"
ununterscheidbar.

### Trades zusammensetzen

Ein Trade verteilt sich über mehrere Log-Einträge; einzeln ist keiner davon buchbar.
`Trade completed` nennt weder Ware noch Betrag, `Trade items add` keinen Preis. Verbunden
sind sie über `parsed_trade_id`:

```
Trade initiate outgoing     "Brass Imgot @ $17,732"
Trade items add             ich lege 12x Item 1252 ein
Trade money add other user  er legt 212.784 ein
Trade completed             Abschluss
Trade money incoming        ich bekomme 212.784
```

12 × 17.732 = 212.784. **Wer Ware einlegt und Geld bekommt, hat verkauft** — damit steht die
Richtung fest, ohne sie zu raten. Der Kauf ist der gespiegelte Fall
(`Trade items add other user` plus `Trade money outgoing`).

Entscheidend ist das Suffix `other user`: es unterscheidet die Gegenseite von der eigenen.
Die Muster in `js/tradelog.js` sind deshalb verankert — `trade items add` darf nicht auch
auf `trade items add other user` passen, sonst kippt die Richtung.

Nicht gebucht wird:

- **ohne `Trade completed`** — abgebrochene, abgelehnte und abgelaufene Trades hinterlassen
  dieselben Bestückungs-Einträge;
- **Ware auf beiden Seiten** — ein Tausch hat keinen Geldwert je Seite;
- **mehrere verschiedene Items** — ohne Einzelpreise ließe sich die Summe nicht fair
  aufteilen. Der Eröffnungstext nennt zwar oft einen Stückpreis, aber freier Text ist keine
  Grundlage für eine Bilanz.

Wieder entfernte Ware (`Trade items remove`) wird abgezogen. Die Referenz `trade-<id>` ist
über Importe hinweg stabil, ein erneuter Import verdoppelt also nichts.

**Ein Rohbeispiel je Titel, nicht je Grund.** 80 übersprungene Einträge aus fünfzehn
verschiedenen Titeln teilten sich vorher ein einziges Beispiel — ausgerechnet ein
`Company deposit`. Die Form der Trade-Zwischenschritte blieb damit unsichtbar.

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


## Versionsstempel

GitHub Pages liefert Dateien mit `max-age=600` aus, und iOS hält eine zum Home-Bildschirm
hinzugefügte Seite noch hartnäckiger fest. Zweimal wurde deshalb ein längst behobener Fehler
erneut gemeldet — der Browser führte schlicht den alten Stand aus.

Deshalb trägt **jeder relative Import** einen Versionsstempel:

```js
import { makeEvent } from './ledger.js?v=1';
```

Nur das Entry-Script zu versionieren reicht nicht: dessen Importe lösen relativ zur
Modul-URL *ohne* Query auf und blieben im Cache. Gestempelt wird mit

```bash
python3 tools/version-assets.py     # nach dem Hochzählen von APP_VERSION in js/config.js
```

`tests/version.test.mjs` hält fest, dass kein Import ohne aktuellen Stempel durchrutscht —
sonst wäre die Lücke genau dort, wo man sie nicht sucht.

Jede Seite zeigt den Build oben im Kopf, und der Importbericht trägt ihn als erste Zeile.

**Der Stempel allein reicht nicht.** Er bustet den Browser-Cache, aber der Server ignoriert
den Query-Parameter und liefert unter `config.js?v=2` trotzdem die *neue* Datei. Wird ein
Modul aus dem Cache verdrängt und ein anderes nicht, mischen sich die Stände — einmal stand
oben „Build 3", während die Logik noch die von Build 2 war. Ein Etikett, das lügt, ist
schlimmer als keins.

Deshalb trägt jede Seite den Build zusätzlich als `<meta name="app-build">`. Die HTML
bestimmt, welche `?v=`-URLs geladen werden; `APP_VERSION` kommt aus einem geladenen Modul.
Weichen beide ab, steht oben `Build 3 ≠ 4 — neu laden` als Warnung, mit einem Link auf die
Seite samt Cache-brechendem Parameter. Der Mischzustand wird damit sichtbar statt
beschönigt.


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
Laufzeit. Seit die Kandidaten parallel laufen, fällt das weniger ins Gewicht.


## Flüge

`travel.html` plant Item-Running: wohin fliegen, was mitnehmen, und lohnt sich der Weg
überhaupt. Gerechnet wird in **Profit pro Minute Rundflug** — ein Flug nach Südafrika bringt
pro Flug mehr als einer nach Mexiko und dauert zehnmal so lang; wer die Zeit nicht mitrechnet,
fliegt systematisch zu weit.

Die Menge, die eine Zeile ansetzt, ist die kleinste von drei Grenzen: Platz im Koffer,
Ware im Regal, Geld auf der Hand. Welche gerade bindet, steht als Marker daneben.

### Woher die Zahlen kommen

| | Quelle |
|---|---|
| Marktwert zuhause | weav3r-Katalog, derselbe wie im Scanner |
| Preis und Vorrat im Ausland | yata.yt, oder von Hand erfasst |
| Reisezeit | Tabelle mal Faktor des Fliegers, oder deine gemessene Zeit |

**Torns API kennt die Auslandsvorräte nicht.** In der offiziellen Spec (6.13.1) gibt es
`/user/travel` für den eigenen Flugstatus, aber keinen Bestand der Shops in Mexiko oder Japan;
weav3r hat gar keine Travel-Routen. In Torn werden diese Zahlen seit jeher von Spielern
gesammelt, und [YATA](https://yata.yt) ist die verbreitetste Sammelstelle. Deshalb steht
`https://yata.yt` in der CSP — aber nur auf den zwei Seiten, die es brauchen.

Ob YATA Zugriffe aus dem Browser einer fremden Seite erlaubt, entscheidet deren Server, nicht
diese App. Der Fall ist eingeplant: schlägt es fehl, sagt die Meldung CORS als wahrscheinliche
Ursache, die Seite rechnet mit von Hand erfassten Vorräten weiter, und **API-Diagnose → YATA
testen** zeigt, was tatsächlich zurückkam.

Zwei Stellschrauben dafür, unter *Quelle*:

- **Die Adresse ist einstellbar.** Ändert YATA die Route, wird sie hier korrigiert statt per
  Deploy. Der Host bleibt auf `yata.yt` festgenagelt — alles andere blockt die CSP ohnehin,
  und ein früh benannter Fehler ist besser als ein rätselhafter Netzwerkfehler später.
- **Antwort einfügen.** Adresse in einem normalen Tab öffnen, JSON kopieren, einfügen. Es läuft
  durch denselben Parser wie ein Abruf und legt dieselbe Messung an — der Weg funktioniert
  also auch dann, wenn der Browser den direkten Zugriff nie erlaubt. Wird kein Land erkannt,
  nennt die Meldung die gefundenen Schlüssel; daran lässt sich die tatsächliche Form ablesen.

**Die Antwort ist gecacht, bis jemand neue Vorräte einliefert**, und YATA weist darauf hin,
genau `/api/v1/travel/export/` aufzurufen und keine Variante davon. Deshalb entfernt die App
Query-Parameter aus der eingestellten Adresse — ein angehängter Parameter, auch ein harmloser
Cache-Buster, liefe an der zwischengespeicherten Antwort vorbei. Ein Key ist für diese Route
nicht vorgesehen.

Das hat eine Folge für die Vorhersage: derselbe Abzug zweimal gelesen ist **eine** Messung,
nicht zwei. Die App erkennt das am Zeitstempel — `update` je Land, sonst der `timestamp` der
Nutzlast. Ohne diese Unterscheidung entstünde aus lauter gleichen Mengen ein Abverkauf von
null, und die Vorhersage sähe zuversichtlich aus, ohne dass jemand hingeschaut hätte.

Die dokumentierte Form:

```
{ "stocks": { "mex": { "update": <ts>,
                       "stocks": [ { "id": …, "name": …, "quantity": …, "cost": … }, … ] },
              "cay": { … } },
  "timestamp": <ts> }
```

### Vorhersage

Ein Vorrat bewegt sich in zwei Richtungen: Spieler kaufen ihn leer, und in Abständen legt der
Shop nach. Beides lässt sich nicht ausrechnen, nur beobachten. Jeder Abruf und jede Eingabe
legt deshalb eine Messung ab, und aus der Reihe entstehen zwei Größen:

- **Abverkauf** in Stück pro Minute, gemessen an fallenden Mengen.
- **Nachschub**: wie viel ein Sprung nach oben bringt, und in welchem Abstand solche Sprünge
  passieren. Die Menge ist eine Untergrenze — zwischen zwei Messungen wurde auch wieder gekauft.

Genommen wird jeweils der **Median**, nicht der Durchschnitt — ein einzelner Großeinkauf zöge
einen Mittelwert so weit, dass die Vorhersage für alle folgenden Flüge unbrauchbar wäre.
Gerechnet wird ab der letzten Messung, nicht ab jetzt: zwischen beiden liegt oft eine Stunde.

**Neuere Messungen wiegen mehr.** Der Abverkauf schwankt über den Tag — nachts steht die Ware,
abends ist sie in Minuten weg —, und ein Median über eine Woche ergäbe eine Zahl, die zu keiner
Tageszeit stimmt. Das Gewicht halbiert sich alle sechs Stunden. Gemessen wird dabei gegen die
jüngste Messung *derselben Reihe*, nicht gegen die Uhr: sonst fällt bei einer Reihe von gestern
jedes Gewicht auf null und die Schätzung wäre leer statt alt.

**Ein Bereich statt einer Zahl, und die Antwort auf die eigentliche Frage.** „6 Stück" klingt
nach Wissen; die Entscheidung lautet aber *reicht es für meine Plätze?* Deshalb steht dort
`244–364` — die Spanne zwischen dem langsamsten und dem schnellsten beobachteten Tempo — plus
`100% für 19`. Diese Wahrscheinlichkeit wird über die beobachteten Tempi selbst gerechnet, nicht
über eine angenommene Verteilung: jedes gemessene Tempo ist ein Szenario. Mit wenigen Messungen
kommen dabei grobe Werte heraus — ehrlicher als eine glatte Kurve über drei Punkte.

### Der Nachschub-Zyklus

**Der Timer startet beim Ausverkauf, nicht nach der Uhr.** Erreicht ein Item 0, läuft eine
item-spezifische Frist, und danach ist das Regal wieder voll. Das erste Modell nahm feste
Abstände zwischen Nachschüben an — daran ging es systematisch vorbei.

Zu schätzen sind damit drei Größen: der **Timer** (fest je Item), die **Regalgröße** (Näherung:
das je gesehene Maximum) und der **Abverkauf** (bestimmt, wann der nächste Timer startet).

Der Kniff bei fremden Daten: den genauen Moment des Ausverkaufs sieht niemand. Man sieht nur
„um 12:00 waren noch 40 da" und „um 12:30 war es leer" — der Ausverkauf liegt *irgendwo*
dazwischen, der Nachschub genauso. Jeder Zyklus liefert deshalb kein Datum, sondern ein
**Intervall**:

```
Timer ≥ frühester Nachschub − spätester Ausverkauf
Timer ≤ spätester Nachschub − frühester Ausverkauf
```

Der Schnitt über alle Zyklen ist enger als jede einzelne Beobachtung. Aus drei groben Zyklen
(je 60 Minuten Unsicherheit) wird so ein Timer von 15 Minuten Breite — **ohne dass je ein
einzelner Zeitpunkt bekannt wäre**. Widersprechen sich die Zyklen, wird nicht zu einem
falschen Schnitt gezwungen: dann gilt der Median der Mittelwerte, und die Spanne bleibt offen
ausgewiesen (Spalte *Timer* wird gelb).

Vorhergesagt wird dann nicht über eine Formel, sondern durch **Vorwärtssimulation des
Mechanismus**: Ware wird weniger, bis sie null ist; dann läuft der Timer; dann ist das Regal
voll; und von vorn. Über einen Zehn-Stunden-Flug fallen so mehrere Nachschübe an.

Daraus die zwei Angaben, um die es beim Item-Running wirklich geht:

- **Nächster Nachschub** — Uhrzeit, Abstand und Genauigkeit (`22:07 · in 22 min · ±18 min`).
  Läuft der Timer bereits, steht das dabei; dann ist der Zeitpunkt am schärfsten.
- **Abflug** — wann du starten musst, um *zum Nachschub* zu landen. Ist der Nachschub näher
  als die Flugzeit, sagt die Kachel „jetzt" und dazu, dass du danach ankommst.

Geplant wird mit der **Menge bei Landung**, nicht mit der von jetzt. Sonst fällt ausgerechnet
das interessanteste Ziel aus der Liste: ein leeres Regal, dessen Timer läuft und das voll ist,
wenn man ankommt. (Genau das tat die erste Fassung — Mexiko mit `0 jetzt` und `169–200 bei
Landung` stand gar nicht in der Tabelle.)

### Der Sammler: Daten ohne Zutun

Eine Messreihe entsteht nur, wenn jemand nachsieht. Solange das nur der Browser tut, gibt es
Daten genau dann, wenn die Seite offen ist — also nicht nachts, und selten in dem Fenster, in
dem ein Timer abläuft. Deshalb sammelt ein **GitHub-Actions-Workflow** (`collect.yml`) alle zehn
Minuten selbst: er liest YATA, trägt die Messung ein und committet `data/travel-stock.json`.
Die Seite liest die Datei beim Start und führt sie mit den eigenen Beobachtungen zusammen.

Drei Eigenschaften, die kein Zufall sind:

- **Gleiche Rechnung.** `tools/collect-travel.mjs` benutzt `parseTravelExport` und
  `recordSnapshot` aus der App. Was gesammelt wird, entsteht nach denselben Regeln wie eine
  Eingabe von Hand — inklusive der Regel, dass eine zwischengespeicherte Antwort keine neue
  Messung ist. Ein Test hält fest, dass der Sammler diese Funktionen importiert und nicht
  eigene nachbaut.
- **Kein CORS.** Serverseitig gibt es die Beschränkung nicht, an der der Browser scheitern
  kann. Selbst wenn yata.yt Zugriffe aus fremden Seiten verweigert, füllt sich die Historie.
- **Same-origin.** Die Datei liegt neben der Seite; in der CSP steht dafür `'self'` statt einer
  weiteren Domain. Kein Key ist beteiligt — ein Test verbietet `secrets.` im Workflow.

Ein frischer Browser hat damit vom ersten Aufruf an Messreihen: im Test 47 Punkte, drei
erkannte Zyklen, Timer auf 50–70 Minuten eingegrenzt — ohne dass jemand je auf *Vorräte laden*
gedrückt hätte.

**Was dabei zu beachten ist:** GitHub hält `cron` nicht auf die Minute genau ein und lässt
unter Last Läufe aus (für die Schätzung unerheblich, sie rechnet mit unregelmäßigen Abständen).
Und GitHub deaktiviert geplante Workflows in Repositories, die 60 Tage keine Aktivität zeigen —
die Commits des Sammlers halten es wach, aber ein Blick auf den Actions-Tab nach längerer Pause
schadet nicht.

### Vier Modelle treten gegeneinander an

Statt eines fest verdrahteten Modells konkurrieren vier Kandidaten, und **je Messreihe gewinnt
das, welches auf deren eigener Vergangenheit am besten lag**:

| Modell | Annahme |
|---|---|
| `bleibt wie es ist` | Nichts passiert. Für ein stehendes Regal die richtige Antwort. |
| `Netto-Trend` | Zu- und Abgänge in einer Zahl. Wo sich Nachschub und Abverkauf bei stundenlangen Messabständen nicht trennen lassen, ehrlicher als zwei Größen, die beide daneben liegen. |
| `Ausverkauf + Timer` | Der Mechanismus des Spiels, oben beschrieben. Der Standard, solange nichts gemessen ist — er kann aber erst antworten, wenn ein Ausverkauf beobachtet wurde. |
| `Tempo nach Tageszeit` | Nur Abschnitte aus derselben Tageszeit wie die Ankunft. Abends leert sich ein Regal schneller als nachts. |

Das ist die ehrliche Form von „lernt dazu": die App **misst**, welche Erklärung zu diesem Regal
passt, statt sie zu raten. Mit jeder Messung wächst die Prüfmenge, und der Sieger kann wechseln.
Welches Modell gerade gewinnt, steht im Panel *Beobachtungen* — nachvollziehbar statt Blackbox.

**Bewertet wird in der Lage, in der gefragt wird.** Ein leeres Regal mit laufendem Timer ist
ein anderer Fall als ein volles, das sich leert — also zählen für die Wahl nur Kontrollen aus
derselben Lage und mit ähnlicher Flugdauer (mit Rückfall auf die breitere Grundlage, wenn zu
wenige da sind; die Zeile sagt, welche gerade gilt).

**Gewichtet wird mit dem Mittelwert, nicht mit dem Median** — entgegen der sonstigen Regel in
diesem Projekt, und aus einem konkreten Grund. Bei zehnminütigen Messungen ist ein leeres Regal
fünfmal hintereinander leer und einmal voll. *Bleibt wie es ist* trifft fünf von sechs Fällen
exakt, sein Median-Fehler ist **null**, und damit gewinnt es jeden Vergleich — obwohl es genau
im entscheidenden Moment um 200 Stück danebenliegt. Der Median ist robust gegen Ausreißer; hier
ist der Ausreißer das Ereignis, um das es geht.

**Zwei Bremsen gegen Überanpassung.** Wer auf zehn Prüfpunkten unter fünfzig Modellen wählt,
wählt Rauschen. Deshalb: erst ab vier bestandenen Kontrollen darf ein Modell den Standard
ablösen, und bei annähernd gleichem Fehler gewinnt das **einfachere**. Ein Wechsel wegen zwei
Prozent Vorsprung wäre kein Lernen.

**Ein Modell darf sich abmelden.** *Tempo nach Tageszeit* liefert nichts, wenn für die
Ankunftszeit keine vergleichbaren Abschnitte vorliegen — bei einem Zehn-Stunden-Flug der
Regelfall. Dann rückt der nächstbeste Kandidat nach. (Zuerst blockierte das die ganze Zeile:
der Sieger schwieg, und die Vorhersage sagte *zu wenig Daten*, obwohl drei Modelle bereitstanden.)

### Die Vorhersage prüft sich selbst

Jede Reihe wird gegen ihre eigene Vergangenheit getestet: aus dem Anfang vorhersagen, mit dem
nächsten echten Wert vergleichen. Das kostet keinen zusätzlichen Speicher — die Antworten stehen
schon in der Reihe — und liefert zwei Zahlen, die im Panel *Beobachtungen* stehen:

- **Fehler**: um wie viel Stück die eigenen Vorhersagen im Median danebenlagen.
- **Bereich traf**: wie oft der angegebene Bereich den später gemessenen Wert enthielt.

**Der Bereich lernt seine eigene Breite** (Konformalprognose): er kommt aus der Verteilung der
tatsächlichen Abweichungen, nicht aus gesetzten Quantilen. Ein 80%-Bereich ist damit einer, der
in der Vergangenheit zu 80% getroffen hat — nachprüfbar, und mit jeder Messung genauer.
Herangezogen werden Fehler aus ähnlich langen Horizonten, denn die Unsicherheit wächst mit der
Flugzeit; deshalb sagt die Selbstkontrolle nicht nur den nächsten Punkt vorher, sondern auch den
übernächsten und den darauf. Fehlen passende Horizonte ganz, wird mit der Wurzel des
Verhältnisses gestreckt — eine Annahme, aber eine benannte, und die Zeile sagt es dazu.

Daraus kommt die Güte — gemessen, nicht geschätzt. *brauchbar* heißt: mindestens vier bestandene
Kontrollen, frische Daten, der Bereich enthielt den echten Wert in mindestens der Hälfte der
Fälle, **und** er ist schmal genug, um darauf zu entscheiden. Die letzte Bedingung kam dazu, als
die erste den Zweck verfehlte: seit die Breite aus den eigenen Fehlern kommt, *trifft* der
Bereich fast immer — er wird eben breit. Ein Bereich von 0 bis 400 ist verlässlich und wertlos.

**Was die App nicht gesehen hat, sagt sie nicht vorher.** Unter zwei Messungen steht dort
*zu wenig Daten*. Eine erfundene Zahl ist hier besonders teuer — man fliegt drei Stunden und
steht vor einem leeren Regal.

### Reisezeiten

Die Tabelle enthält die Standardzeiten ohne Perks (Mexiko 26 min bis Südafrika 297 min),
multipliziert mit dem Faktor des Fliegers. Stimmt eine Zeit bei dir nicht — andere Perks,
anderes Flugzeug —, trag deine gemessene ein: sie schlägt die Tabelle, weil sie alles bereits
enthält.

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
js/config.js        APP_VERSION, Defaults, Basis-URLs, Rate-Limits
js/ratelimit.js     Gleitendes 60-Sekunden-Fenster, je Host eine Instanz
js/weav3r.js        TornW3B-Client: Katalog, Listings, Trader, $1-Bazaare
js/torn.js          Torn API v2, optional, nur für die Item-Market-Gegenprobe
js/profit.js        Vorauswahl, Käuferwahl, Profit-Rechnung, Budget, Filter
js/freshness.js     Alter von Listings und Käufern aus uneinheitlichen Zeitstempeln
js/scan.js          Ablauf eines Scans, abbrechbar, mit Fortschrittsmeldung
js/storage.js       localStorage
js/ui.js            Spaltendefinition, Tabelle/Karten, Sortierung
js/app.js           Verdrahtung, Fortschritt
travel.html         Flugplaner: Ziele, Erträge, Vorratsvorhersage
js/travel.js        Länder, Reisezeiten, Ertrag je Flug und Minute
js/yata.js          YATA-Client für die Auslandsvorräte, defensiv geparst
js/stats.js         Median, Altersgewichtung, gewichtete Quantile
js/restock.js       Zyklen finden, Timer eingrenzen, Mechanismus simulieren
js/travelModels.js  die konkurrierenden Vorhersagemodelle
js/travelStock.js   Messreihen, Modellwahl, Konformalbereich, Vorhersage
js/travelPage.js    Verdrahtung der Flugseite
ledger.html         Buchführung über Käufe, Verkäufe und Profit
js/ledger.js        Ereignismodell, FIFO-Zuordnung, Kennzahlen, Zeitraeume
js/valuation.js     Bestandsbewertung, Kurs-Zwischenspeicher
js/ledgerStore.js   localStorage, Export und Import
js/tornlog.js       Log-Typen und -Kategorien von Torn, Import, Bericht
js/tradelog.js      Trades aus mehreren Log-Eintraegen zusammensetzen, Angebote
js/offersStore.js   Angebote merken, Status fortschreiben, Notizen halten
js/table.js         Tabellenbau mit data-label für die Kartenansicht
js/ledgerPage.js    Verdrahtung der Ledger-Seite
tools/make-icon.py  erzeugt icon-180.png fuer den iOS-Home-Screen
tools/collect-travel.mjs sammelt Vorräte für GitHub Actions, mit der App-Logik
tools/version-assets.py  stempelt APP_VERSION in jeden Import
data/travel-stock.json   die gesammelte Historie, vom Workflow geschrieben
tests/              node --test, ohne Abhängigkeiten (inkl. Secret-Scan)
```

`scan.js` nimmt seine API-Funktionen per `deps` entgegen, deshalb laufen die Ablauf-Tests
ohne Netzwerk und ohne Mock-Framework.

## Tests

```bash
npm test
```

335 Tests über Response-Parsing, Vorauswahl, Käuferwahl, Profit-Rechnung, Budget-Verteilung,
Parallelität und Abbruch, Zeitstempel-Deutung, Scan-Ablauf, Markup, Sortierung,
Link-Erzeugung, FIFO-Zuordnung, Log-Auswertung, Angebots-Status, Bestandsbewertung, Flugplanung, Modellwahl, Vorratsvorhersage und Persistenz sowie die Key-, CSP-,
Workflow- und Mobile-Prüfungen aus den Abschnitten oben.

Der Sortier-Controller wird gegen einen kleinen DOM-Stub getestet (`tests/sorting.test.mjs`),
weil dort ein Fehler saß, den die reine Sortierfunktion nicht zeigen konnte.

## Grenzen

- Antworten sind serverseitig 30–180 s gecacht. Gute Angebote sind in Torn oft schneller
  weg als der Cache alt ist — die Liste ist ein Vorschlag, keine Garantie.
- Wie viel ein Käufer tatsächlich abnimmt, steht in keiner API. Die Mengenspalte zeigt, was
  im Bazaar liegt und was das Budget hergibt, nicht was der Käufer abnehmen will.
- Das Budget wird über alle Treffer verteilt, nach Profit je eingesetztem Dollar. Die Summe
  in der Statusleiste ist damit erreichbar — vorher rechnete jede Zeile für sich mit dem
  vollen Budget und die Summe gab dasselbe Geld mehrfach aus. Zeilen, für die nichts übrig
  bleibt, stehen als *über Budget* mit Menge 0 in der Liste.
- Ankaufspreise stammen aus der Pricelist des Käufers zum Abfragezeitpunkt. Vor einem großen
  Trade lohnt eine kurze Rückfrage.
- Die Vorauswahl misst mit dem Marktpreis als Platzhalter für den Ankaufspreis. Sie schätzt
  damit zu günstig; ein Kandidat kann die Schwellen also bestehen und die fertige Zeile
  trotzdem reißen. Andersherum geht nichts verloren.
- *Parallele Abfragen* verkürzt nur die Wartezeit, nicht die Zahl der Requests. Wer das
  Minutenlimit reißt, senkt *Max. Kandidaten* — nicht die Parallelität.
