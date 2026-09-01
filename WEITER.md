# Wo es weitergeht

Übergabe an die Sitzung, die auf der lokalen Maschine läuft. Die Arbeitsregeln
stehen in `CLAUDE.md` und gelten weiter — hier steht, **was** als Nächstes dran
ist und **woran man merkt, dass es funktioniert hat**.

Lies zuerst `CLAUDE.md`. Zwei Sätze daraus tragen alles Folgende:

> Lieber „zu wenig Daten" als eine erfundene Zahl.
> Das Modell steht nie zwischen den Daten und einer Zahl.

## Wo wir stehen

Die Maschine ist eine HP ZBook 15 G5: i7-8850H (6 Kerne), 32 GB RAM, Quadro
P1000 mit **4 GB VRAM**, Ubuntu Server 24.04. Vier GB sind die harte Grenze —
ein 3B–4B-Modell in Q4 passt vollständig, ein 7–8B nicht.

Was läuft:

| | |
|---|---|
| `torn-collector` | misst Auslandsvorräte, schreibt `data/local/stock.db` |
| `torn-web` | liefert die Seiten aus, **nur** auf 127.0.0.1 |
| Ollama | ein Modell ist geladen |
| GitHub Actions | sammelt weiter als Zweitmessung, falls die Kiste aus ist |

**Der Zugriff läuft nur noch lokal.** GitHub Pages ist nicht mehr das Ziel;
das Telefon kommt über Tailscale an `http://ubuntu-server-home.tail4968d8.ts.net:8080`.
`torn-web` hängt weiterhin ausschließlich an 127.0.0.1 — dazwischen steht
`tailscale serve` als Weiterleitung, damit die Bindung unangetastet bleibt.

Punkt 1 bis 3 der alten Liste sind **abgearbeitet**; die Antworten stehen
unten, weil sie bestimmen, was jetzt noch sinnvoll ist. Kurz:

- **Die Dichte reicht.** YATA rechnet einmal je Minute neu, wir fragen alle
  30 s. Mehr Daten kommen ausschließlich über Laufzeit, nicht über den Takt.
- **Das Sprachmodell taugt nicht zum Deuten von Zahlen.** Gemessen, zweimal,
  mit zwei Modellen. Für Textkanten taugt es.
- **Die geratenen Travel-Routen gibt es nicht.** Die echte Prometheus-Route
  wurde gefunden und auf deine Entscheidung hin verworfen — wir arbeiten nur
  mit YATA.

---

## 1. Wie dicht sind die Daten wirklich? — beantwortet

```bash
node tools/collect-local.mjs --stats
```

**YATA rechnet genau einmal je Minute neu.** Der kleinste Abstand zwischen zwei
Quell-Zeitstempeln ist über 1599 Lücken und elf Länder exakt 60 s (Median 69,
p95 116). Die befürchteten 20 Minuten treten nicht auf. Der Sammler fragt alle
30 s — doppelte Marge, kein Verlust. **Häufiger zu fragen bringt keinen
einzigen Messpunkt mehr**, und 60 s wären bereits zu langsam, weil eine Abfrage
selbst 0,5 bis 5,6 s dauert.

Damit ist der Engpass endgültig die Laufzeit. `--stats` zählt deshalb jetzt
**Zyklen statt Messpunkte**: ein volles Regal liefert beliebig viele Punkte und
verrät nichts über seinen Timer.

Stand nach 6,8 h: 335 abgeschlossene Zyklen, aber nur 96 von 227 Reihen haben
überhaupt einen gezeigt und nur 23 genug für eine geprüfte Vorhersage. **Die
langsamen Items brauchen Tage bis Wochen.** Das ist kein Mangel des Verfahrens,
sondern die Antwort auf die Frage.

**Was der Timer wert ist:** Bei den zehn schnellsten Items ist die
Timer-Streuung (0,17–0,95 min) **kleiner als die eigene Messunsicherheit**
(1,65–2,55 min); der unerklärte Rest ist im Median 0,00 min. Der Timer ist also
eine Konstante je Item, und alles, was wie Schwankung aussieht, ist die
60-Sekunden-Auflösung der Quelle. **Daran kann kein Verfahren etwas verbessern
— auch kein trainiertes.** Enger wird es nur durch mehr Zyklen, weil
`estimateTimer()` die Einklammerungen schneidet.

**Offene Beobachtung:** Die Timer dieser neun Items liegen alle zwischen 12,7
und 13,7 Minuten, sind bei unserer Auflösung also nicht unterscheidbar. Ob das
eine gemeinsame Spielkonstante ist oder Zufall einer Gruppe billiger,
schnelldrehender Items, entscheidet sich, sobald langsamere Items genug Zyklen
haben. Nicht vorher behaupten.

---

## 2. Taugt das Modell für die eine Aufgabe? — beantwortet, zweigeteilt

```bash
node tools/llm-check.mjs      # Textkanten im Handelslog
node tools/hypothese.mjs      # Deutung von Messreihen
```

**Für Textkanten: brauchbar.** `llama3.2:3b` rettet 2 von 6 Zeilen, an denen
`priceFromDescription()` scheitert, und bricht **keinen** der klaren Fälle
(`gebrochen == 0`). Der Einbau wäre wie beschrieben: Regex zuerst, Modell nur
für die `null`-Fälle, jede Antwort durch `onlyKnownNumbers()`. Gebaut ist er
noch nicht.

Dass der Wächter nötig ist, ist belegt: bei „4x Xanax for $3,320,000 in total"
antwortete das Modell **8320000** — eine Zahl, die in der Eingabe nicht steht.

**Für das Deuten von Messreihen: unbrauchbar.** `tools/hypothese.mjs` legt zehn
Reihen mit ≥ 10 Zyklen eine Beschreibung vor und lässt einen Mechanismus
wählen; der Code urteilt unabhängig. Ergebnis über drei Läufe:

| | einig | uneinig |
|---|---|---|
| `llama3.2:3b`, erster Prompt | 1 | 9 |
| `llama3.2:3b`, ohne Attraktor im Prompt | 1 | 9 |
| `qwen2.5:3b` | 0 | 10 |

Jedes Modell gibt eine **konstante Antwort unabhängig von der Eingabe**, und
keines wählt je `fester-timer`, obwohl das bei 9 von 10 Reihen offensichtlich
richtig ist. Die eine Einigkeit ist Zufall. Nach dem Maßstab dieses Projekts:
nicht einsetzen. **Ein größeres Modell zu probieren wäre erlaubt, aber die
Aufgabe ist keine Sprachaufgabe** — die Arithmetik hat dieselbe Frage nebenbei
und richtig beantwortet.

---

## 3. Gibt es weav3r- oder Prometheus-Routen? — beantwortet, dann verworfen

```bash
node tools/probe-travel.mjs
```

**weav3r: die geratenen Pfade gibt es nicht.** Beweis statt Vermutung: eine
frei erfundene Route (`/voellig-erfunden-xyz`) bekommt exakt dieselbe Antwort
(403, Cloudflare `error code: 1020`) wie alle zwölf geratenen, während
`/marketplace` mit echten Daten und ohne API-Key antwortet. 403/1020 ist dort
das funktionale Gegenstück zu 404.

**Prometheus: die echte Route existiert** — sie steht im nachgeladenen
JS-Bundle der Seite und lautet `https://prombot.co.uk:8443/api/travel`. **Port
8443**; deshalb lief jede Prüfung auf Port 443 ins Leere, wo die Vue-SPA jede
Anfrage mit `200 text/html` abfängt. Sie liefert JSON mit `access-control-allow-origin: *`,
11 Länder, 232 Items, 3 Sekunden alt.

**Auf Nutzerentscheidung verworfen: wir arbeiten nur mit YATA.** Falls das
jemand neu aufrollt, zwei Dinge vorher lesen: das mitgelieferte `nextRestock`
ist **unbrauchbar** — alle 24 Zukunftswerte liegen auf einem 15-Minuten-Raster,
während unsere eigenen 128 beobachteten Übergänge kein Raster zeigen (25,8 %
gegen 24,0 % Zufallserwartung). Wertvoll wären allein die `quantity`-Werte,
wegen der Frische.

**Kaputt und nicht repariert:** die Gegenprobe in `probe-travel.mjs` fragt
`weav3r /health` — diesen Pfad gibt es nicht mehr. Damit kann das Werkzeug
Blockade und Nichtexistenz nicht trennen. `/marketplace` wäre die richtige
Kontrolle.

---

## 4. Erst danach: die Nachricht, wenn ein Timer abläuft

Das ist die Funktion, die eine eigene Maschine hat und GitHub Pages nie haben
wird: ein Hinweis aufs Telefon, **bevor** der Nachschub kommt — früh genug, um
loszufliegen.

Die Rechnung dafür gibt es schon: `nextRestock()` in `js/restock.js` und
`departure()` in `js/travelPage.js` wissen, wann man starten muss. Was fehlt,
ist der Weg zum Telefon.

**Die erste Bedingung ist inzwischen erfüllt** — für einen Teil der Items. Der
Timer ist eine Konstante je Item und für 23 von 227 Reihen scharf genug
bestimmt; bei `can:261` liegt die Unsicherheit bei einer Minute. Für diese
Items würde eine Nachricht halten, was sie verspricht.

Deshalb: **nur für Reihen bauen, die reif sind**, und das an derselben Schwelle
festmachen, die `--stats` zählt. Eine Nachricht für ein Item mit zwei
beobachteten Zyklen ist genau die Sorte Vermutung, die das Projekt sonst
vermeidet.

Was weiterhin gilt:

- **Nur Hinweis, keine Handlung.** Torn-Regeln: das Werkzeug rechnet und
  empfiehlt, es handelt nicht. Kein automatisches Irgendwas.
- **Kein Modell zwischen den Daten und der Zeit.** Der Timer kommt aus
  `estimateTimer()`, nicht aus einer Schätzung, die gut klingt.

---

## 5. Bekannt offen, bewusst liegen gelassen

**Offline-Fähigkeit (Service Worker).** Ledger und Beobachtungen liegen im
`localStorage`, aber ohne Netz öffnet die App nicht — auf dem Homescreen-Icon
getippt, kein Empfang, weiße Seite. Der Nutzer hat das bei einer früheren
Auswahl nicht priorisiert. Es bleibt die größte verbleibende Lücke für die
Nutzung am Telefon.

**Durchreichen der fremden APIs über `tools/serve.mjs`.** Würde CORS im Browser
erledigen und die CSP auf `connect-src 'self'` verengen, also **strenger**
machen. Bewusst nicht gebaut: der Sammler läuft in Node und braucht es nicht,
und ein Proxy, den nichts benutzt, ist Angriffsfläche ohne Nutzen. Bau ihn,
wenn ein konkreter Aufruf ihn braucht — nicht vorher.

**Der Hypothesengenerator.** Gebaut als `tools/hypothese.mjs`, gemessen, und
das Sprachmodell ist daran gescheitert (siehe Punkt 2). Das Werkzeug bleibt als
Messinstrument: es lässt sich mit `--model` gegen ein größeres Modell laufen,
sobald eines in 4 GB passt und man es wissen will. Der deterministische Teil —
`merkmale()` und `urteil()` — ist unabhängig davon nützlich und getestet.

**Ein maßstabsfreies Fehlermaß.** `rankModels()` vergleicht in Stück. Innerhalb
einer Reihe ist das richtig, weil dort immer derselbe Maßstab gilt; über Reihen
hinweg ist es irreführend, und genau daran bin ich einmal hängengeblieben
(siehe README, „Der Gesamtwert empfiehlt das falsche Modell"). Wer je über
Reihen aggregiert, muss relativ rechnen.

**Ein volles Tagesprofil.** Das Modell `daily` gewinnt mit längerer Frist immer
mehr Reihen (6 → 32), aber wir haben bisher nur Stunden **eines** Nachmittags
gesehen: sieben von 24 Stunden. Der Abverkauf schwankt über diese sieben
Stunden um 33 % — ob das Tageszeit ist oder Rauschen, kann erst ein voller Tag
sagen. Vorher kein Tagesmodell anpassen.

---

## Beim Arbeiten

**Messen statt behaupten.** Dieses Projekt hat sich mehrfach dadurch
korrigiert, dass eine Zahl nachgeprüft wurde. Die periodische
Nachschub-Annahme, der Median, der die entscheidenden Fälle versteckte, die
CORS-Diagnose, die mehr behauptete als sie wusste — alles Fälle, in denen eine
plausible Erklärung falsch war. Wenn du etwas nicht gemessen hast, schreib
dazu, dass du es nicht gemessen hast.

**Vor jedem Commit:** `npm test`. Bei Änderungen an `js/`, `css/` oder den
HTML-Seiten zusätzlich `APP_VERSION` hochzählen und
`python3 tools/version-assets.py` laufen lassen.

**Playwright** für Browserprüfungen ad hoc installieren und **vor dem Commit
wieder entfernen** (`rm -rf node_modules package-lock.json` und
`git checkout package.json`). Der Chromium liegt unter `/opt/pw-browsers` oder
wird installiert; `executablePath` setzen statt `playwright install`.

**Der API-Key gehört nicht ins Repository.** Das Repo ist öffentlich, und
`tests/no-secrets.test.mjs` prüft das bei jedem Lauf — aber verlass dich nicht
darauf, sondern denk vorher nach.

**Nichts pushen ohne Rückfrage.** Committen gern, pushen nur, wenn der Nutzer
zustimmt.
