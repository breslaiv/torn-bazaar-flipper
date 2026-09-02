# Beobachter — Userscript für TornPDA

Schreibt mit, was im Auslandsshop steht, und meldet es an den eigenen Sammler.
**Es liest nur.** Nichts wird geklickt, gekauft oder geflogen — das Werkzeug
rechnet und empfiehlt, es handelt nicht.

## Wozu

Der Sammler fragt YATA ab, und YATA rechnet **einmal je Minute** neu. Feiner
als eine Minute lässt sich ein Nachfüllzeitpunkt daraus nie bestimmen — das ist
gemessen, nicht vermutet (kleinster Abstand zwischen zwei Quell-Zeitstempeln
über 1599 Lücken: exakt 60 s).

Wer im Shop steht, sieht den Bestand dagegen in dem Moment, in dem er ihn
sieht: sekundengenau, aus dem Spiel selbst, ohne fremden Zwischenspeicher. Das
ist die genaueste Messung, die es in diesem Projekt geben kann — und sie
entsteht nebenbei, während man ohnehin dort ist.

Es ersetzt den Sammler nicht. Es schreibt nur mit, wenn du auf der Seite bist —
und das sind genau die Momente, die für deine Flüge zählen.

## Einrichten

**Schritt 1 — Erkundung.** Skript in TornPDA einfügen und einen Auslandsshop
öffnen. Im Auslieferungszustand ist `erkunden: true` und `server: ''`: es wird
**nichts gesendet**, sondern nur in der Konsole ausgegeben, was gefunden wurde.

Das ist kein Zieren. Ich kenne Torns aktuelles Seitenmarkup nicht, und ein
geratener Selektor schriebe Unfug in die Messreihe, bevor es jemand bemerkt.
Erst ansehen, ob die abgelesenen Mengen stimmen.

**Schritt 2 — scharf schalten.** Wenn die Ausgabe stimmt, im Kopf des Skripts:

```js
server:   'http://<deine-tailnet-adresse>:8080',
erkunden: false,
```

Und im Metadatenblock `@connect *` durch den eigenen Host ersetzen:

```
// @connect      deine-tailnet-adresse.ts.net
```

`*` erlaubt Verbindungen zu jedem Host. Das ist für die Erkundung bequem und
danach unnötig weit — das Skript soll genau eine Adresse erreichen dürfen.

## Was es meldet

Land, Item-ID, Menge, Zeitpunkt — an `POST /api/beobachtung`. Keine
Zugangsdaten, keine Spielerdaten, nichts über dich.

Der Server prüft alles, was hereinkommt: unbekanntes Land, unbrauchbare Menge
und unplausibler Zeitpunkt werden abgewiesen, und was im Umkreis einer Minute
liegt, ersetzt den vorhandenen Punkt statt ihn zu ergänzen. Zwei Messungen im
Sekundenabstand wären sonst ein Nachschub, den es nie gab.

Dieselbe Sperre sitzt zur Sicherheit auch im Skript — mit demselben Wert wie im
Sammler, und ein Test hält beide zusammen.

## Warum `GM_xmlhttpRequest` und nicht `fetch`

Der Server verlangt `Content-Type: application/json`, und genau das erzwingt
aus einer torn.com-Seite heraus einen Preflight, den er bewusst **nicht**
beantwortet. So kann keine fremde Webseite in deine Messreihe schreiben,
obwohl der Dienst im Tailnet erreichbar ist.

`GM_xmlhttpRequest` läuft außerhalb dieser Browser-Regel. Damit bleibt der
Server so streng, wie er ist, und das Skript kommt trotzdem durch.

## Zur Regelfrage

Das Skript automatisiert keine Spielhandlung. Es liest Seiten mit, die du
ohnehin gerade ansiehst, und meldet das Gesehene an deinen eigenen Rechner.

Das ist eine andere Kategorie als ein Bot — aber die Einschätzung ist deine:
prüf einmal gegen Torns aktuelle Script-Regeln, bevor du es scharf schaltest.
