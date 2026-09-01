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

Was gebaut, aber **noch nie gegen die Wirklichkeit gehalten** wurde:
`tools/llm-check.mjs` und `tools/probe-travel.mjs`. Beides sind Messungen, keine
Features. Sie stehen ganz oben, weil ihre Ergebnisse entscheiden, was danach
überhaupt sinnvoll ist.

---

## 1. Wie dicht sind die Daten wirklich?

```bash
node tools/collect-local.mjs --stats
```

Das ist die wichtigste offene Frage im ganzen Projekt. Das erklärte Ziel ist
eine **90-Prozent-Prognose für den nächsten Nachschub**. Ob das erreichbar ist,
hängt nicht an unserem Messtakt — wir fragen alle 15 Sekunden — sondern daran,
wie oft die YATA-Gemeinschaft überhaupt neue Vorräte einliefert. Liefert YATA
nur alle 20 Minuten einen neuen Zeitstempel, ist der Timer nie enger als
20 Minuten zu bestimmen, egal wie oft wir anklopfen.

**Was zu berichten ist:** Punkte je Reihe und Stunde. Und die Verteilung der
Abstände zwischen aufeinanderfolgenden Messpunkten — der Median sagt mehr als
der Mittelwert, weil einzelne lange Lücken ihn sonst verzerren.

**Wenn die Dichte niedrig ist**, ist das kein Rückschlag, sondern die Antwort:
dann ist das 90-Prozent-Ziel mit YATA allein nicht zu halten, und die
Konsequenz wäre eine zweite Quelle oder eigene Beobachtungen vor Ort. Sag das
dann klar, statt an der Rechnung zu drehen.

---

## 2. Taugt das Modell für die eine Aufgabe?

```bash
node tools/llm-check.mjs
nvidia-smi          # währenddessen: passt das Modell wirklich in 4 GB?
```

Zwölf Torn-Logzeilen. Sechs trifft `priceFromDescription()`, sechs nicht. Das
Urteil ist hart und absichtlich so:

- **`gebrochen` > 0** → nicht einsetzen. Ein Modell, das die klaren Fälle anders
  beantwortet als die Regex, ist unbrauchbar, egal wie gut es bei den schweren
  aussieht. Größeres Modell probieren, solange es in 4 GB passt.
- **`gerettet` == 0** → bringt nichts. Der ganze Pfad wäre umsonst.
- **dazwischen** → brauchbar als Auffangnetz.

**Modelle, die die Größe halten** (Q4, vollständig auf der GPU): Qwen2.5 3B,
Llama 3.2 3B, Gemma 3 4B. Miss die Tokens/s aus der Ollama-Antwort, nicht mit
einer Stoppuhr — die misst sonst die Latenz mit.

Fällt das Urteil positiv aus, ist der nächste Schritt der Einbau ins
Log-Import: **Regex zuerst, Modell nur für die Zeilen, an denen sie `null`
liefert.** Nie umgekehrt. Und jede Modellantwort muss durch
`onlyKnownNumbers()` — die Prüfung ist der Grund, warum das Ganze überhaupt
zulässig ist.

---

## 3. Gibt es weav3r- oder Prometheus-Routen für Auslandsvorräte?

```bash
node tools/probe-travel.mjs
```

Seit Wochen offen und aus dem Browser nicht zu klären: ein 404 ohne
CORS-Header sieht dort identisch aus wie eine Blockade. Serverseitig gibt es
echte Statuscodes.

**Was zu berichten ist:** je Pfad der Statuscode und der Anfang der Antwort.
Und — das ist der Punkt, an dem ich schon einmal danebenlag — **sag genau, was
bewiesen ist und was nicht.** „Alle Pfade 404" heißt: diese Pfade gibt es
nicht. Es heißt nicht, dass es keine Route gibt.

Findet sich eine brauchbare Route, ist das die zweite Quelle aus Punkt 1 — und
damit möglicherweise der Unterschied zwischen 70 und 90 Prozent.

---

## 4. Erst danach: die Nachricht, wenn ein Timer abläuft

Das ist die Funktion, die eine eigene Maschine hat und GitHub Pages nie haben
wird: ein Hinweis aufs Telefon, **bevor** der Nachschub kommt — früh genug, um
loszufliegen.

Die Rechnung dafür gibt es schon: `nextRestock()` in `js/restock.js` und
`departure()` in `js/travelPage.js` wissen, wann man starten muss. Was fehlt,
ist der Weg zum Telefon.

Zwei Bedingungen, ohne die es nicht gebaut werden sollte:

- **Erst wenn Punkt 1 sagt, dass die Vorhersage etwas taugt.** Eine
  Benachrichtigung, die dreimal am Tag falsch liegt, schaltet man nach zwei
  Tagen ab — und dann ist die Funktion tot, obwohl der Ansatz stimmt.
- **Nur Hinweis, keine Handlung.** Torn-Regeln: das Werkzeug rechnet und
  empfiehlt, es handelt nicht. Kein automatisches Irgendwas.

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

**Der Hypothesengenerator.** Das Modell sieht sich Wochen an Bestandsverläufen
an und schlägt ein fünftes Vorhersagemodell für `js/travelModels.js` vor; der
bestehende Backtest entscheidet, ob es antritt oder verliert. Das ist der eine
Einsatz, bei dem die Nichtdeterminiertheit harmlos ist — aber er braucht erst
Wochen an Daten. Nicht jetzt.

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
