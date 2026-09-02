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

## Warum keine Treffer

Eine leere Trefferliste ist keine Auskunft. Sie kann heißen: der Markt gibt gerade nichts
her, der Rabatt-Regler steht zu streng, das Kandidatenlimit schneidet zu früh ab, oder der
Mindestprofit ist zu hoch. Das sind vier verschiedene Handlungen, und ohne Zwischenstände
sehen sie alle gleich aus.

Nach jedem Scan steht deshalb über der Tabelle ein Trichter — eine Zeile je Siebstufe, in
genau der Reihenfolge, in der `scan.js` tatsächlich siebt:

```
Katalog                     400
Mit Bazaar und Preis        320   −80: kein Bazaar-Listing oder kein Marktpreis
Unter Rabattschwelle         48   −272: teurer als 90 % vom Marktpreis · Regler „Kandidat ab Rabatt"
Erwarteter Profit reicht     48
Kandidaten geprüft           25   −23: Limit von 25 Kandidaten · Regler „Max. Kandidaten"
Mit Käufer                   15   −10: 8 ohne aktiven Abnehmer, 2 nur unter Bewertung 0
────────────────────────────────
Angebote gefunden            30
Über den Profitfiltern       15   −15: unter $10.000 pro Stück oder 5 % Marge
Über Alter und Preisgrenze   15
Im Budget                     2   −13: Budget von $900.000 aufgebraucht · Regler „Budget"
```

Jede Stufe nennt den Regler, der sie steuert; die Stufe mit dem größten Verlust ist
hervorgehoben und wird darüber im Klartext benannt. Stufen ohne gesetzten Regler — Budget
auf 0, keine Preisgrenze — tauchen gar nicht erst auf.

Drei Entscheidungen dahinter:

**Die Zählung kommt aus derselben Funktion, die wirklich siebt.** `prescreenBreakdown()`
gibt die Zwischenstände zurück, `prescreen()` ist nur noch deren letzte Stufe. Eine zweite
Zählfunktion daneben wäre nach der ersten Änderung still falsch geworden.

**Der Trichter hat zwei Abschnitte.** Bis „Mit Käufer" werden Items gezählt, danach
einzelne Bazaar-Listings — ein Item bringt mehrere mit. Ohne sichtbare Trennung springt
die Zahl mitten im Trichter nach oben und sieht aus wie ein Rechenfehler.

**Fehlgeschlagene Abfragen bekommen eine eigene Stufe.** Ein Rate-Limit oder ein
Netzaussetzer sah vorher aus wie ein Markt, der nichts hergibt — man dreht dann am Rabatt,
statt es noch einmal zu versuchen. Aufgefallen ist das erst im Browser, als der Mock nicht
griff und der Trichter ungerührt behauptete, alle 25 Kandidaten seien geprüft worden.

Der Hinweis zeigt nur auf Stufen, an denen sich etwas einstellen lässt. Dass 80 Items
keinen Bazaar-Eintrag haben, ist oft der größte Posten — aber eine Sackgasse.


## Der Normalbereich

**„20% unter Marktpreis" heißt beim einen Item Schnäppchen und beim anderen Normalzustand.**
Der Marktpreis ist zudem selbst ein nachlaufender Wert — er entsteht aus vergangenen Verkäufen.
Der ehrlichere Maßstab ist, was dieses Item in den letzten Tagen tatsächlich gekostet hat.

Keine der drei Quellen bietet einen Preisverlauf an, also legt ein stündlicher Workflow
(`collect-prices.yml`) ihn selbst an. Die Spalte *ggü. üblich* zeigt den Abstand zum üblichen
Tiefstpreis; liegt ein Angebot unter dem unteren Zehntel seiner eigenen Verteilung, steht
*selten billig* daneben. Ein Beispiel aus dem Browsertest, das den Unterschied trägt:

| Item | Marge | ggü. üblich |
|---|---|---|
| Xanax | 18,8% | **−12%, selten billig** |
| Dahlia | 35,7% | +2% |

Nach der Marge wäre Dahlia der bessere Flip. Tatsächlich ist er der Normalzustand — Xanax ist
der Fund. Diese Unterscheidung kann `market_price` nicht ausdrücken.

Zwei Dateien, aus einem Grund:

- `data/prices/JJJJ-MM.ndjson` — Rohdaten, **eine Zeile je Lauf**, angehängt statt umgeschrieben.
  Git speichert die Datei damit in Deltas statt jedes Mal von vorn.
- `data/price-stats.json` — das, was der Browser liest: je Item vier Kennzahlen statt tausender
  Messpunkte. Ein Telefon soll keine Megabytes laden, um zu erfahren, ob ein Preis niedrig ist.

**Unter drei Beobachtungen gibt es keinen Normalbereich** — dann bleibt es beim bisherigen
Vergleich gegen den Marktpreis, und die Spalte bleibt leer. Historie lässt sich nicht
nachträglich erzeugen; deshalb sammelt der Workflow ab sofort, auch wenn die Auswertung erst
in ein paar Tagen trägt.

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
  Seitenanfang und Trefferliste. Häufig Gebrauchtes steht direkt darin; alles Seltene liegt
  in *Feineinstellung* eine Ebene tiefer. Welchen Regler man braucht, sagt der Trichter.
- Aufklapper öffnen sich so, wie man die Seite verlassen hat (`js/panels.js`, eigener
  Speicherschlüssel — das ist Bedienzustand, kein Wert für den Export). Auf der Flug-Seite
  mit ihren sechs Kästen spart das bei jedem Besuch dieselbe Klickstrecke.
- Die Navigation zeigt alle vier Seiten, auch die aktuelle, und markiert sie mit
  `aria-current="page"`. Als Reihe kleiner Textlinks war jedes Ziel rund 60 × 18 px groß
  und man sah nirgends, wo man war.
- `color-scheme: dark` auf `:root`. Ohne das rendert iOS Datumsfeld, Auswahlliste und
  Tastatur hell — mitten in einer sonst durchgehend dunklen App.
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
`/user/travel` für den eigenen Flugstatus, aber keinen Bestand der Shops in Mexiko oder Japan.
In der weav3r-Spec, die uns vorliegt, steht ebenfalls keine Travel-Route — deren Website zeigt
Auslandsvorräte allerdings an, ruft also etwas auf.

**Drei Sammelstellen sind bekannt**, und keine davon dokumentiert ihre Schnittstelle
vollständig öffentlich:

| Quelle | Stand |
|---|---|
| [YATA](https://yata.yt) | dokumentiert, in Betrieb — `/api/v1/travel/export/` |
| Prometheus (`prombot.co.uk`) | sammelt dieselben Daten, dient [TornTools als Ausweichquelle](https://www.torn.com/forums.php?p=threads&f=67&t=16316648&b=0&a=0), wenn YATA ausfällt; Route unbekannt |
| weav3r | zeigt Vorräte auf der Website, Route nicht in der Spec |

Deshalb klopft die Diagnose-Seite beide unbekannten selbst ab (**weav3r-Travel-Routen suchen**,
**Prometheus abklopfen**): je ein Dutzend naheliegender Pfade, und für jeden Status, oberste
Schlüssel und der Anfang der Antwort — roh gezeigt statt gedeutet. Findet sich eine Route,
lässt sich die Quelle darauf umstellen, ohne dass etwas neu ausgeliefert werden muss; alle drei
Hosts sind zugelassen.

**Was ein Browser dabei nicht herausfinden kann.** Ohne CORS-Freigabe darf `fetch` nicht einmal
den Status einer fremden Antwort lesen — ein 404 und eine Blockade sind dort ununterscheidbar,
beides meldet sich als Netzwerkfehler. Genau das kam auf alle zwölf Pfade, bei prombot.co.uk
*und* bei weav3r.

Deshalb läuft eine **Gegenprobe** auf `/health` mit: antwortet die, ist der Host erreichbar, und
die stummen Pfade sind mit hoher Wahrscheinlichkeit schlicht 404 — deren Antwort trägt bei
weav3r keine CORS-Header. Scheitert auch die Kontrolle, liegt es am Zugriff insgesamt
(Adblocker, Netz, Ausfall). Ohne diese eine Zeile sieht beides gleich aus, und der Bericht
behauptet mehr, als er weiß.

Der Workflow **Quellen abklopfen** (von Hand auslösbar) fragt dieselben Pfade aus GitHub Actions
ab, wo CORS nicht gilt, und zeigt echte Statuscodes, Inhaltstypen und ob eine `Access-Control-
Allow-Origin`-Freigabe dabei ist. Eine Gegenprobe auf eine bekannte Route läuft mit, damit ein
Netzproblem nicht wie ein leeres Ergebnis aussieht. **Findet sich dort eine Route, kann der
Sammler sie nutzen — auch wenn die Seite selbst nie an sie herankäme**, denn er läuft ohnehin
serverseitig.

Der Grund für den Aufwand ist Ausfallsicherheit: YATA ist crowdsourced und war in der
Vergangenheit zeitweise offline — genau dafür existiert Prometheus. In Torn werden diese Zahlen seit jeher von Spielern
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

### Abgestimmt auf den Torn Travel Planner

Wer zwei Werkzeuge nebeneinander offen hat, will keine widersprüchlichen Zahlen. Deshalb
übernimmt diese App die Definitionen aus
[shab00m/torn-travel-planner](https://github.com/shab00m/torn-travel-planner) wörtlich:

> „Depletion rate per in-stock window (restock → last snapshot before stock hits 0, or → now
> while stock lasts) in items/minute"

Ein **In-Stock-Fenster** endet also bei der letzten Messung *mit* Ware, nicht bei der Null —
wann dazwischen ausverkauft wurde, weiß niemand. Gemittelt wird über die letzten 1, 3, 5, 10
oder 20 Fenster, wie dort auswählbar.

Diese Zahl steht **neben** der Schätzung, mit der die App vorhersagt, nicht an deren Stelle:
die gewichtet nach Alter und nimmt den Median. Beide haben ihren Zweck, und wo sie
auseinanderlaufen, ist das ein Hinweis statt eines Fehlers.

Im Panel *Einzelnes Item ansehen* dazu, was der Planner ebenfalls zeigt: der **Verlauf** mit
schattierten Leerphasen, die **letzten fünf Nachschübe** mit Ausfalldauer, und der **Abverkauf
nach Tageszeit**. Bei den Nachschüben steht die Genauigkeit dabei — die Lücke zwischen letzter
Null und erster Messung mit Ware; mehr gibt die Messdichte nicht her.

### Kapazität und Flugart aus Torn

Statt beides einzustellen, liest *Aus Torn* die Wahrheit: `/user/travel` liefert die Flugart,
`/user/perks` die Kapazitäts-Boni. Beides braucht nur einen **Minimal-Key** — die niedrigste
Stufe, die Torn kennt.

Die Perks kommen als Fließtext, nicht als Zahlen, und es gibt keinen dokumentierten Katalog.
Also wird gesucht statt angenommen: jede Zeile, die von Reisegepäck spricht und eine Zahl nennt.
**Was dabei erkannt wurde, zeigt die Seite an** — eine Kapazität, die man nicht nachvollziehen
kann, wäre schlimmer als eine selbst eingetragene:

```
Kapazität 21 (5 Grundlage + 16 aus Perks) · Flugart Airstrip
erkannt: + 2 travel items [job]; + 10 travel items [faction];
         Increases maximum travel items by 4 [book]
```

Der Abgleich mit Torns eigener Aufzählung (`Private | Business | Airstrip | Standard`) zeigte
nebenbei, dass in der Fliegerauswahl **Privatjet fehlte**. Die Zeitfaktoren dahinter stammen
weiterhin aus der Community, nicht aus einer Dokumentation — eine gemessene Zeit schlägt sie
deshalb immer.

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
dem ein Timer abläuft. Deshalb sammelt ein **GitHub-Actions-Workflow** (`collect.yml`) selbst:
er liest YATA, trägt die Messung ein und committet `data/travel-stock.json`. Die Seite liest die
Datei beim Start und führt sie mit den eigenen Beobachtungen zusammen.

**Dichte schlägt Häufigkeit.** Ein Zeitplan alle zehn Minuten trifft den Moment eines
Nachschubs nur auf zehn Minuten genau — und genau diese Unsicherheit steckt danach im Timer.
Deshalb läuft **ein Lauf pro Stunde, der darin im Minutentakt misst**: sechzigfach genauere
Grenzen bei *weniger* Commits als vorher, weil einmal am Ende committet wird statt sechsmal.
Aus `±5 min` Ungenauigkeit je Zyklus wird `±30 s`.

Der Preis dafür ist Laufzeit: der Runner ist knapp 55 Minuten pro Stunde belegt. Für ein
öffentliches Repository ist das kostenlos, aber es ist eine bewusste Entscheidung und keine
Nebenwirkung.

Zwei Vorkehrungen im Lauf: Nach **jeder** Änderung wird die Datei geschrieben, damit ein
abgebrochener Lauf nicht die ganze Stunde verliert. Und ein Ausfall der Quelle beendet ihn
nicht, sondern verdoppelt den Abstand bis maximal zehn Minuten — ohne diese Bremse klopfte der
Sammler bei einer Störung eine Stunde lang im Minutentakt an.

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

## Die lokale Fassung

GitHub Actions misst 55 Minuten pro Stunde im Minutentakt und macht am
Stundenwechsel eine Lücke. Wer eine Maschine hat, die durchläuft, kann das
besser — und der Engpass wandert dorthin, wo er hingehört: nicht mehr zu
unserem Takt, sondern zu der Frage, wie oft die YATA-Gemeinschaft überhaupt
neue Vorräte einliefert. Genau das beantwortet `--stats` zum ersten Mal.

**Und die Antwort ist inzwischen gemessen.** Über drei Stunden und elf Länder
liegt der kleinste Abstand zwischen zwei YATA-Zeitstempeln bei exakt 60 s
(1599 Lücken, Minimum 60, Median 69, p95 116) — YATA rechnet also einmal je
Minute neu. Damit ist der Takt nach oben *und* nach unten festgelegt:
häufiger als alle 30 s zu fragen bringt keinen einzigen Messpunkt mehr, und
alle 60 s zu fragen wäre bereits zu langsam, weil eine Abfrage selbst 0,5 bis
5,6 s dauert und der Sammler damit hinter der Quelle herliefe. Wer mehr Daten
will, bekommt sie nicht über den Takt, sondern über Laufzeit.

**Was die Seiten davon merken: nichts.** Der lokale Server liefert
`data/travel-stock.json` unter derselben Adresse und in derselben Form aus,
nur aus einer Datenbank statt aus einer Datei. Im Browser ist keine Zeile
anders.

### Speichergrenze und Rechengrenze sind nicht dasselbe

Lange war beides eine Zahl: `MAX_SAMPLES = 40`. Das stammt aus der
Pages-Fassung, wo der Browser selbst mitschreibt und der `localStorage` mit ein
paar Megabyte auskommen muss. Sobald die Historie aber aus SQLite kommt, ist
diese Grenze eine stille Fessel — sie ist eine feste **Anzahl** und wirft
deshalb immer mehr weg, je länger gesammelt wird. Gemessen: von 5,8 Stunden
vorhandener Historie sah die Schätzung 3,5.

Getrennt sind es jetzt drei Zahlen, jede mit einem eigenen Grund:

| | | |
|---|---|---|
| `MAX_SAMPLES` | 40 | was in den `localStorage` geschrieben wird — dort ist der Platz knapp |
| `MAX_HISTORY` | 1000 | was im Arbeitsspeicher steht, also womit gerechnet wird |
| `BACKTEST_POINTS` | 60 | was der Modellwettbewerb bewertet |

Die dritte Zahl ist die unerwartete. Abverkauf, Zyklen und Timer laufen linear
und dürfen alles sehen. `evaluateModels()` dagegen sagt von jedem Punkt aus
voraus und wächst **quadratisch**: für 227 Reihen gemessen 0,5 s bei 40
Punkten, 9 s bei 250, 140 s bei 1000. Ohne diese Grenze wäre „mehr Daten" eine
Seite, die minutenlang steht.

Was der Handel bringt, mit echten Daten über alle 227 Reihen: eine Ansicht
kostet 479 statt 312 ms, erkennt dafür 369 statt 176 Nachfüll-Zyklen und
liefert für 72 statt 44 Items einen Timer.

Damit die längeren Reihen auch über Tailscale ankommen, packt der Server seine
JSON-Antworten: gemessen 393 kB roh, 74 kB gepackt.

### Geprüft wird auf Flugdauer, nicht auf den nächsten Messpunkt

Der Modellwettbewerb hat lange die falsche Frage gestellt. `evaluateModels()`
sagte die nächsten drei **Messungen** vorher — im Mittel 8 Minuten, längstens
20. Auf dieser Frist ändert sich ein Regal in **86 %** der Fälle gar nicht.
Also gewann „bleibt wie es ist" auf **81 %** der Reihen mit einem mittleren
Fehler von **0,0**, und kein besseres Verfahren konnte sich zeigen: eine
gesättigte Messlatte, auf der jeder Kandidat perfekt aussieht.

Entschieden wird aber auf Flugdauer — 26 Minuten nach Mexiko, 297 nach
Südafrika. Geprüft wird deshalb jetzt auf `HORIZONS = [30, 60, 120, 180]`
Minuten, gegen die Messung, die der Frist am nächsten liegt (Toleranz 20 %,
mindestens 5 Minuten). Fehlt sie, wird nicht geprüft — lieber keine Kontrolle
als eine auf einer Frist, auf der niemand fliegt.

Was dabei sichtbar wird, war vorher unsichtbar:

| Frist | `flat` | `drift` | `daily` | `cycle` |
|---|---|---|---|---|
| 30 min | 4 | 4 | 4 | 131 |
| 60 min | 7 | 6 | 6 | 131 |
| 120 min | 9 | 6 | 6 | 131 |
| 180 min | 10 | 7 | 7 | 122 |

*(mittlerer absoluter Fehler, Median über 227 Reihen)*

`flat` wird mit der Frist schlechter, `daily` und `drift` bleiben stabil — und
`daily` steigt entsprechend von 6 auf 32 gewonnene Reihen. Genau diese
Unterscheidung war auf 8 Minuten unmöglich.

**Nachtrag, nachdem die erste Nacht in den Daten war.** Die Zahlen oben
stammen aus 6,8 Stunden eines Nachmittags. Mit 18,3 Stunden — also
einschließlich Abend, Nacht und frühem Morgen — zeigt sich, warum `daily`
überhaupt gebaut wurde: der Abverkauf ist nachts messbar langsamer.

| Stunde UTC | Abverkauf (% des Bestands je Minute) |
|---|---|
| 02 | 1,44 |
| 05 | 1,51 |
| 12 | 2,18 |
| **15** | **2,43** |
| 23 | 2,10 |

Ein geordneter Verlauf über 19 der 24 Stunden, kein Zufallszickzack — die
Spanne beträgt 49 % des Medians. Entsprechend gewinnt `daily` jetzt deutlich
öfter: auf 60 Minuten Frist **43 statt 15** Reihen, auf 120 Minuten **51 statt
28**. Das Modell lag die ganze Zeit im Code und konnte sich nur nicht zeigen,
weil ihm die Tageszeiten fehlten.

### Der Gesamtwert empfiehlt das falsche Modell

In der Tabelle oben hat `cycle` mit 122–131 den mit Abstand größten Fehler —
und dieser Eindruck ist falsch. Getrennt nach Art des Regals, mit dem Fehler
im Verhältnis zum Bestand statt in Stück:

| | `cycle` | `drift` | `daily` | `flat` |
|---|---|---|---|---|
| Regale mit ≥ 2 Zyklen (3328 Kontrollen) | **6,5 %** | 11,7 % | 12,1 % | **61,0 %** |
| Regale ohne Zyklus (17 530 Kontrollen) | 35,7 % | 0,0 % | 0,0 % | 0,0 % |

**84 % aller Kontrollen liegen auf Regalen, die sich in drei Stunden nicht
bewegen.** Dort ist „bleibt wie es ist" trivial richtig, und weil diese Fälle
den Gesamtwert dominieren, sieht `flat` überall gut aus — obwohl es auf den
Regalen, die tatsächlich leerlaufen, um 61 % danebenliegt. Genau dort, wo die
Entscheidung fällt, ob sich ein Flug lohnt, ist `flat` das schlechteste
Verfahren und `cycle` das beste.

Gerettet wird das dadurch, dass die Auswahl **je Reihe** entscheidet und nicht
global: `cycle` gewinnt die rund vierzig Reihen mit Zyklen, die übrigen gehen
an die ruhigen Modelle. Wer den Gesamtwert optimiert, macht die App also
schlechter. Deshalb steht der Befund hier, und deshalb sichert ein Test ab,
dass `cycle` auf einer zyklischen Reihe `flat` schlägt.

Offen bleibt das Maß selbst: ein absoluter Stückfehler vergleicht Items mit
drei Stück gegen Items mit achttausend. Die Zahlen in dieser Tabelle sind
deshalb relativ gerechnet — im Code ist es noch der absolute Fehler.

```bash
git clone … && cd torn-bazaar-flipper
./tools/setup-local.sh          # zeigt erst den Plan, fragt einmal, macht dann
```

Das Skript sichert Node 22+, legt `data/local/` an, schreibt zwei
systemd-Units und schaltet den Deckel-Standby ab. NVIDIA-Treiber, Ollama und
Modelle installiert es **nicht** — die brauchen einen Blick auf die Maschine
(Secure Boot, MOK-Dialog) und kommen danach von Hand. Was es nicht selbst
entscheiden kann, prüft es und berichtet: Akku-Ladeschwelle, Treiberlage.

Zwei Dienste:

| | |
|---|---|
| `torn-collector` | misst alle 30 s, schreibt nach `data/local/stock.db` |
| `torn-web` | liefert die Seiten aus, hört **nur auf 127.0.0.1** |

Dass der Webserver nur lokal hört, ist Absicht. Zugriff vom Telefon läuft über
Tailscale — dann ist der Dienst für die eigenen Geräte da und nicht für jeden
im WLAN. `--host 0.0.0.0` gibt es, aber nicht als Vorgabe.

Beide Units laufen unter einem normalen Konto mit `ProtectSystem=strict` und
`ReadWritePaths=data/local`: ein Fehler im Sammler kann höchstens die eigene
Datenbank beschädigen, nicht das Repository und nicht das System.

### Warum SQLite und nicht weiter JSON

Die Datei im Repository ist auf 120 Punkte je Reihe gedeckelt und wird bei
jedem Schreiben vollständig neu geschrieben. Für einen stündlichen Lauf ist das
richtig; für eine Maschine, die im Sekundentakt misst und Monate durchhält,
nicht mehr. Die Datenbank hängt nur die neue Zeile an, kennt keinen Deckel, und
ein Absturz mitten im Schreiben lässt keine halbe Datei zurück.

`node:sqlite` ist seit Node 22.5 eingebaut — die Nullabhängigkeits-Regel bleibt
also intakt. Unter Node 22 meldet es sich mit einer Experimental-Warnung, ab
Node 24 ist es still; deshalb installiert das Skript Node 24, wenn nichts
Passendes da ist.

Der Deckel gilt weiterhin für das, was **herausgeht**: was der Server ausliefert,
landet im `localStorage` eines Telefons. Was in der Datenbank bleibt, ist die
Grundlage für jede spätere Auswertung und darf wachsen.

### Das Sprachmodell

Auf der lokalen Maschine läuft ein kleines Modell über Ollama. Die Regel, unter
der es überhaupt existiert:

> **Das Modell steht nie zwischen den Daten und einer Zahl.**

Timer-Schätzung, FIFO, Rucksack, konforme Bänder und die Modellwahl bleiben
deterministisch und getestet. Ein Modell, das „ich schätze mal 45 Minuten" sagt,
klingt genau wie eines, das rechnet — und den Unterschied merkt man erst, wenn
der Flug leer ankommt.

Was bleibt, sind die Textkanten. Die erste ist `priceFromDescription()`: ein
handgeschriebener Ausdruck, der `@ $1,234` sucht und bei jeder anderen
Formulierung `null` liefert. Genau dort springt das Modell ein — **Regex zuerst,
Modell nur als Auffangnetz.** Das ist auch der billigere Weg herum, und es
protokolliert nebenbei, welche Formulierungen uns fehlen.

**Die Absicherung** ist der eigentliche Kern von `js/llm.js`:

```js
onlyKnownNumbers(antwort, fakten)   // jede Ziffernfolge muss in der Eingabe stehen
```

Rechnet das Modell 4 × 830.000 aus und schreibt die Summe hin, ist das richtig
gerechnet — steht aber nicht da. Die Antwort wird verworfen und der Aufrufer
fällt auf die nackte Rechnung zurück. Damit kann das Modell schlecht
formulieren, aber es kann keinen Preis erfinden. `1.240.000` und `1240000`
gelten dabei als dieselbe Zahl, sonst schlüge die Prüfung bei jeder korrekten,
nur anders formatierten Antwort an.

**Ob das Modell taugt, wird gemessen, nicht geglaubt:**

```bash
node tools/llm-check.mjs --model qwen2.5:3b
```

Zwölf Logzeilen, sechs davon trifft die Regex, sechs nicht. Das Urteil am Ende
ist hart: bricht das Modell auch nur einen Fall, den die Regex richtig hat, ist
es unbrauchbar — egal wie gut es bei den schweren aussieht. Rettet es keinen der
schweren, war der Aufwand umsonst. Dazwischen liegt der Nutzen.

Kein npm-Paket: Ollama spricht schlichtes JSON über HTTP, das kann `fetch`.

Der Browser erreicht `127.0.0.1:11434` nicht, weil die CSP `connect-src`
namentlich auflistet. Der saubere Weg wäre später ein Durchreichen über
`tools/serve.mjs` — same-origin, statt einen weiteren Host in die Liste zu
schreiben.

### Dieselbe Rechnung, nicht eine zweite

`tools/collect-local.mjs` benutzt `collectOnce()` und `watch()` aus dem
Actions-Sammler. Zwei Sammler mit zwei Rechnungen wären zwei Wahrheiten — und
die wichtigste Regel würde als erste auseinanderlaufen: eine zwischengespeicherte
Antwort von YATA ist **keine** neue Messung, weil ihr Zeitstempel derselbe
bleibt. Zählte jede Abfrage als Messpunkt, wäre jede Reihe voller erfundener
Beobachtungen und jeder Timer daraus wertlos.

Nach einem Neustart liest der Sammler seinen Ausgangszustand aus der Datenbank.
Ohne das meldet er den unveränderten Regalinhalt als frische Messung — und die
Zeitreihe bekäme Punkte, die nie beobachtet wurden.

```bash
node tools/collect-local.mjs --stats     # wie dicht die Daten wirklich sind
curl -s localhost:8080/health            # läuft überhaupt etwas an
journalctl -u torn-collector -f
```


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
js/funnel.js        Siebstufen eines Scans - wo die Items geblieben sind
js/panels.js        merkt sich je Seite, welche Aufklapper offen waren
js/app.js           Verdrahtung, Fortschritt, Trichter
travel.html         Flugplaner: Ziele, Erträge, Vorratsvorhersage
js/travel.js        Länder, Reisezeiten, Ertrag je Flug und Minute
js/yata.js          YATA-Client für die Auslandsvorräte, defensiv geparst
js/stats.js         Median, Altersgewichtung, gewichtete Quantile
js/restock.js       Zyklen, Timer, Simulation, In-Stock-Fenster, Tagesprofil
js/capacity.js      Kapazität aus Perks, Flugart aus Torns Aufzählung
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
js/normal.js        Vergleich eines Preises mit dem Normalbereich seines Items
js/llm.js                Ollama-Anbindung plus die Absicherung gegen erfundene Zahlen
tools/llm-check.mjs      misst, ob das lokale Modell die Aufgabe überhaupt taugt
tools/setup-local.sh     richtet die lokale Fassung auf Ubuntu Server ein
tools/serve.mjs          lokaler Webserver, liefert die Vorräte aus der Datenbank
tools/store.mjs          Messreihen in SQLite, über das eingebaute node:sqlite
tools/collect-local.mjs  Dauersammler für die eigene Maschine
tools/collect-travel.mjs sammelt Vorräte für GitHub Actions, mit der App-Logik
tools/collect-prices.mjs sammelt Marktpreise und rechnet den Normalbereich
tools/version-assets.py  stempelt APP_VERSION in jeden Import
data/travel-stock.json   die gesammelte Vorratshistorie, vom Workflow geschrieben
data/price-stats.json    Normalbereich je Item, stündlich neu gerechnet
tests/              node --test, ohne Abhängigkeiten (inkl. Secret-Scan)
```

`scan.js` nimmt seine API-Funktionen per `deps` entgegen, deshalb laufen die Ablauf-Tests
ohne Netzwerk und ohne Mock-Framework.

## Tests

```bash
npm test
```

459 Tests über Response-Parsing, Vorauswahl, Käuferwahl, Profit-Rechnung, Budget-Verteilung,
Parallelität und Abbruch, Zeitstempel-Deutung, Scan-Ablauf, Markup, Sortierung,
Link-Erzeugung, FIFO-Zuordnung, Log-Auswertung, Angebots-Status, Bestandsbewertung, Flugplanung, Modellwahl, Vorratsvorhersage und Persistenz sowie die Key-, CSP-,
Workflow- und Mobile-Prüfungen aus den Abschnitten oben.

Zwei Wächter sind dazugekommen, weil beides beim Lesen nicht auffällt: dass jede Seite zu
jeder anderen führt und genau einen Eintrag als aktuell markiert, und dass jedes `for=`
ein Feld trifft, das es wirklich gibt. Das zweite hatte auf der Flug-Seite ein totes
Label erwischt — `for="capacity"` bei einem Feld namens `travelCapacity`.

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
