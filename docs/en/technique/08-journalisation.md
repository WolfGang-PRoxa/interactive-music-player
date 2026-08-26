# 08 — Logging

[← Contents](README.md)

---

## Usage

```js
const log = require('../utils/logger');   // path relative to the file

log.debug('[Ducking Debug] Détection parole - Début');
log.info('[Player] ▶ En lecture : ' + track.title);
log.success('[Bot] Connecté à Discord');
log.warn('[Upload] Extension refusée : ' + name);
log.error('[Player] Erreur de lecture :', err);   // an Error keeps its stack
```

**`console.*` must no longer be used in `src/`** (apart from `web/public/`, which
runs in the browser). The logger is the only entry point.

---

## Levels

| Level | Severity | Use |
|---|---|---|
| `debug` | 10 | Internal traces, diagnostic detail |
| `info` | 20 | Normal course of events |
| `success` | 20 | Notable successful step — a variant of `info`, distinguished on display |
| `warn` | 30 | Non-blocking anomaly |
| `error` | 40 | Failure |

`LOG_LEVEL` sets the threshold (default `debug`, so everything gets through).
`success` shares the severity of `info`: filtering at `info` keeps both.

Output of severity `warn` and above goes to `stderr`, the rest to `stdout`.

---

## What this module replaced

Previously, [`WebServer.js`](../../../src/web/WebServer.js) **replaced
`console.log`, `console.warn`, `console.error` and `console.info`** when the
module was loaded, in order to capture messages and send them to the dashboard.
Two flaws followed from this.

**An inverted coupling.** The web module drove the logging of the whole
application. Loading `WebServer` had the side effect of modifying `console`
globally.

**A level guessed from the text.** The level was deduced by substring search:

```js
else if (u.includes('WARN') || u.includes('WARNING') || u.includes('ATTENTION'))
    detectedLevel = 'WARN';
```

A perfectly ordinary French message containing "attention" was therefore
classified as a warning. The same heuristic existed **twice over** on the client
side, in `logs.js`, where it rewrote the level of every `INFO` entry.

The level is now fixed at the call site, and both heuristics have been removed.

---

## Architecture

The logger is **self-contained**: it has no dependency on the web server. The
coupling is inverted — `WebServer` subscribes to it.

```
   application modules
          │  log.info(...)
          ▼
   ┌──────────────┐
   │   Logger     │
   └──────┬───────┘
          ├──► process.stdout / stderr        (terminal)
          ├──► in-memory history (200)         (new clients)
          ├──► subscribers                     (WebServer → WebSocket)
          └──► buffer → data/logs/*.log        (batched)
```

### Subscription

```js
log.subscribe((entry) => { /* entry = { timestamp, level, text } */ });
```

Returns an unsubscribe function. `WebServer` uses it in its constructor to
broadcast every entry to the connected WebSocket clients.

`log.getHistory()` returns the last 200 entries, sent when a client connects
under the `logsHistory` type.

### Formatting of the arguments

| Type | Rendering |
|---|---|
| `string` | as-is |
| `Error` | `err.stack`, message and stack preserved |
| object | `util.inspect(obj, { depth: 2, breakLength: Infinity })`, on one line |
| other | `String(arg)` |

The handling of `Error` values is a notable correction: the old formatting used
`JSON.stringify`, which reduces an `Error` to `{}`. The dashboard therefore
displayed nothing usable for diagnosing a breakdown.

### Writing to disk

Two files per run:

- `data/logs/<YYYY-MM-DD_HH-MM-SS>.log` — log of the instance;
- `data/logs/latest.log` — rewritten at every startup, always the most recent.

The lines are **batched**: written after 250 ms or 64 entries, instead of two
synchronous `appendFileSync` calls per line. `flush()` forces the write and is
hooked onto `process.on('exit')`, which covers restarts through `process.exit()`.

Line format:

```
[2026-08-02 21:05:07] [ERROR  ] [Player] Erreur de lecture : ...
```

### Retention

`LOG_RETENTION` logs kept (default 20). The purge runs **after** the creation of
the current log, so that the folder contains at most `N` files, including that of
the running instance. `latest.log` is never purged.

---

## Configuration

`log.configure()` is called once, when
[`WebServer.js`](../../../src/web/WebServer.js) is loaded:

```js
log.configure({
    dir: path.join(process.cwd(), 'data/logs'),
    level: process.env.LOG_LEVEL || 'debug',
    retention: Number(process.env.LOG_RETENTION) || 20,
});
```

Without a call to `configure()`, the logger works but only writes to standard
output. That is the case for
[`deploy-commands.js`](../../../src/deploy-commands.js), which does not load the
web server.

---

## Client-side logs

The dashboard can send its own messages back to the server through the
`clientLog` WebSocket message:

```js
window.MusicPlayer.sendWS({ type: 'clientLog', data: { source: 'Video', message: '…' } });
```

They are logged at `info` level with the prefix supplied, then rebroadcast like
any other entry.
