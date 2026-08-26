# 08 — Protokollierung

[← Inhalt](README.md)

---

## Verwendung

```js
const log = require('../utils/logger');   // Pfad relativ zur Datei

log.debug('[Ducking Debug] Détection parole - Début');
log.info('[Player] ▶ En lecture : ' + track.title);
log.success('[Bot] Connecté à Discord');
log.warn('[Upload] Extension refusée : ' + name);
log.error('[Player] Erreur de lecture :', err);   // ein Error behält seinen Stack
```

**`console.*` darf in `src/` nicht mehr verwendet werden** (außer in
`web/public/`, das im Browser läuft). Der Logger ist der einzige Einstiegspunkt.

---

## Stufen

| Stufe | Schwere | Verwendung |
|---|---|---|
| `debug` | 10 | Innere Spuren, Diagnose-Einzelheiten |
| `info` | 20 | Normaler Ablauf |
| `success` | 20 | Bemerkenswert gelungener Schritt — eine Spielart von `info`, in der Anzeige unterschieden |
| `warn` | 30 | Nicht blockierende Auffälligkeit |
| `error` | 40 | Fehlschlag |

`LOG_LEVEL` legt die Schwelle fest (Vorgabe `debug`, es kommt also alles durch).
`success` teilt die Schwere von `info`: eine Filterung auf `info` behält beide.

Ausgaben der Schwere `warn` und darüber gehen auf `stderr`, die übrigen auf
`stdout`.

---

## Was dieses Modul ersetzt hat

Früher **ersetzte** [`WebServer.js`](../../../src/web/WebServer.js) beim Laden
des Moduls **`console.log`, `console.warn`, `console.error` und
`console.info`**, um die Meldungen aufzufangen und ans Dashboard zu schicken.
Daraus folgten zwei Mängel.

**Eine umgekehrte Kopplung.** Das Web-Modul steuerte die Protokollierung der
gesamten Anwendung. `WebServer` zu laden hatte die Nebenwirkung, `console`
global zu verändern.

**Eine aus dem Text erratene Stufe.** Die Stufe wurde durch Suche nach
Teilzeichenketten abgeleitet:

```js
else if (u.includes('WARN') || u.includes('WARNING') || u.includes('ATTENTION'))
    detectedLevel = 'WARN';
```

Eine völlig gewöhnliche französische Meldung, die „attention" enthielt, wurde
damit als Warnung eingestuft. Dieselbe Heuristik bestand **ein zweites Mal** auf
der Client-Seite, in `logs.js`, wo sie die Stufe jedes `INFO`-Eintrags
überschrieb.

Die Stufe wird nun an der Aufrufstelle festgelegt, und beide Heuristiken wurden
entfernt.

---

## Architektur

Der Logger ist **eigenständig**: er hängt in keiner Weise vom Webserver ab. Die
Kopplung ist umgekehrt — `WebServer` abonniert ihn.

```
   Module der Anwendung
          │  log.info(...)
          ▼
   ┌──────────────┐
   │   Logger     │
   └──────┬───────┘
          ├──► process.stdout / stderr        (Terminal)
          ├──► Verlauf im Speicher (200)       (neue Clients)
          ├──► Abonnenten                      (WebServer → WebSocket)
          └──► Puffer → data/logs/*.log        (gebündelt)
```

### Abonnement

```js
log.subscribe((entry) => { /* entry = { timestamp, level, text } */ });
```

Liefert eine Funktion zum Abbestellen zurück. `WebServer` nutzt sie in seinem
Konstruktor, um jeden Eintrag an die verbundenen WebSocket-Clients zu senden.

`log.getHistory()` liefert die letzten 200 Einträge, die beim Verbinden eines
Clients unter dem Typ `logsHistory` gesendet werden.

### Aufbereitung der Argumente

| Typ | Darstellung |
|---|---|
| `string` | unverändert |
| `Error` | `err.stack`, Meldung und Stack bleiben erhalten |
| Objekt | `util.inspect(obj, { depth: 2, breakLength: Infinity })`, auf einer Zeile |
| sonstiges | `String(arg)` |

Die Behandlung von `Error`-Werten ist eine bemerkenswerte Korrektur: die alte
Aufbereitung verwendete `JSON.stringify`, das einen `Error` auf `{}`
zusammenschrumpfen lässt. Das Dashboard zeigte daher nichts Brauchbares an, um
eine Störung einzugrenzen.

### Schreiben auf die Festplatte

Zwei Dateien je Lauf:

- `data/logs/<JJJJ-MM-TT_HH-MM-SS>.log` — Protokoll der Instanz;
- `data/logs/latest.log` — bei jedem Start neu geschrieben, stets das jüngste.

Die Zeilen werden **gebündelt**: geschrieben wird nach 250 ms oder 64 Einträgen,
statt zweier synchroner `appendFileSync`-Aufrufe je Zeile. `flush()` erzwingt das
Schreiben und hängt an `process.on('exit')`, was Neustarts über `process.exit()`
abdeckt.

Zeilenformat:

```
[2026-08-02 21:05:07] [ERROR  ] [Player] Erreur de lecture : ...
```

### Aufbewahrung

`LOG_RETENTION` Protokolle werden behalten (Vorgabe 20). Die Bereinigung läuft
**nach** dem Anlegen des laufenden Protokolls, sodass der Ordner höchstens `N`
Dateien enthält, die der laufenden Instanz eingeschlossen. `latest.log` wird nie
bereinigt.

---

## Konfiguration

`log.configure()` wird einmal aufgerufen, beim Laden von
[`WebServer.js`](../../../src/web/WebServer.js):

```js
log.configure({
    dir: path.join(process.cwd(), 'data/logs'),
    level: process.env.LOG_LEVEL || 'debug',
    retention: Number(process.env.LOG_RETENTION) || 20,
});
```

Ohne Aufruf von `configure()` arbeitet der Logger, schreibt aber nur auf die
Standardausgabe. Das ist bei
[`deploy-commands.js`](../../../src/deploy-commands.js) der Fall, das den
Webserver nicht lädt.

---

## Protokolle auf der Client-Seite

Das Dashboard kann seine eigenen Meldungen über die WebSocket-Nachricht
`clientLog` an den Server zurückschicken:

```js
window.MusicPlayer.sendWS({ type: 'clientLog', data: { source: 'Video', message: '…' } });
```

Sie werden mit dem mitgelieferten Präfix auf Stufe `info` protokolliert und dann
wie jeder andere Eintrag weitergesendet.
