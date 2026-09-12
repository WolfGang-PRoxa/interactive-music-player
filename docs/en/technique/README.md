# Technical documentation

Engineering documentation for the **Interactive Music** bot: a Discord music
playback bot that automatically lowers the volume when someone speaks
(*ducking*), driven by a real-time web dashboard.

This folder is for people who modify the code. For everyday use, see the
[user guide](../GUIDE.md).

---

## Contents

| Document | Covers |
|---|---|
| [01 — Architecture](01-architecture.md) | Overview, startup sequence, module map, lifecycle |
| [02 — Audio playback](02-lecture-audio.md) | discord-player, extractors, FFmpeg filters, speed, fades, preloading |
| [03 — Ducking](03-ducking.md) | Speech detection, state machine, volume control |
| [04 — Broadcast modes](04-diffusion.md) | Shared mode and personal mode, virtual player, transitions |
| [05 — Dashboard](05-tableau-de-bord.md) | Web server, WebSocket protocol, HTTP routes, frontend |
| [06 — Persistence](06-persistance.md) | Settings, playback state, atomic writes, import storage |
| [07 — Security](07-securite.md) | Authentication, path restriction, ceilings |
| [08 — Logging](08-journalisation.md) | Logger, levels, broadcast to the dashboard |
| [09 — Configuration](09-configuration.md) | Environment variables, `config.js`, command deployment |
| [10 — Versions](10-versions.md) | Shared and install roots, GitHub releases, version switching |
| [11 — Remote access](11-acces-distant.md) | Tailscale tunnel, `PUBLIC_URL`, control sharing |
| [12 — Tests](12-tests.md) | The suites in `tests/`, what they cover, how to write one |

---

## The 10,000-foot view

The bot is a **single Node.js process** running three things in parallel:

```
                    ┌─────────────────────────────┐
                    │       Node.js process       │
                    │                             │
   Discord  ◄──────►│  Client discord.js          │
   (gateway         │    └─ discord-player        │──► Voice channel (Opus/UDP)
    + voice)        │         └─ FFmpeg           │
                    │                             │
                    │  HTTP + WebSocket server    │◄─► Browser
                    │    └─ Express               │    (dashboard)
                    │                             │
                    │  JSON file persistence      │──► data/
                    └─────────────────────────────┘
```

There is **no external database, no side service, no build step**: `npm start`
is enough. The trade-off is that all state lives in memory inside this process,
with snapshots on disk (see [06 — Persistence](06-persistance.md)).

---

## Structuring principles

**The process is single-instance, and the bot belongs to someone.**
The bot is designed to be hosted on its owner's machine. The access token opens
the page, but it names nobody: rights are attached to a **Discord account**. The
first account back from Discord presenting the token becomes the session master;
the others are guests, who have only what the master grants them, gesture by
gesture. See [07 — Security](07-securite.md).

**Playback state belongs to the project.**
The 26 state properties (`virtualCurrentTrack`, `channelStates`,
`transitioningToEveryone`…) are declared in
[`PlaybackSession`](../../../src/audio/PlaybackSession.js), rather than being
grafted schema-less onto discord-player's `GuildQueue` object. See
[01 — Architecture](01-architecture.md#playbacksession).

**The dashboard is a mirror, not a source of truth.**
The server broadcasts a complete state; the client displays it. Every client
action is a WebSocket message that modifies the server state, which then
rebroadcasts.

**Nothing is transpiled.**
CommonJS on the server, global scripts in the browser. No bundler, no
TypeScript. Frontend files are served as-is by Express.

---

## Conventions

- **Language**: comments, logs and documentation in French; identifiers in
  English.
- **Modules**: CommonJS (`require`). Singletons are exported already
  instantiated (`module.exports = new Foo()`).
- **Logging**: never `console.*`, always `log.debug|info|success|warn|error`
  (see [08 — Logging](08-journalisation.md)).
- **Disk paths exposed to the client**: never raw, always through
  `resolveMediaPath()` (see [07 — Security](07-securite.md)).
- **Writing JSON files**: never `writeFileSync` directly, always
  `writeJsonAtomic()` (see [06 — Persistence](06-persistance.md)).

---

## Known limitations

These are identified debts, not bugs to report.

| Topic | Description | See |
|---|---|---|
| Playback state | All 375 sites still reach state through `queue.xxx`, now accessors onto `PlaybackSession`. Rewriting them as `session.xxx` remains to be done. | [01](01-architecture.md#playbacksession) |
| 1 s broadcast loop | The interval is never stopped — there is no `stop()` on `WebServer`. The periodic payload itself has been brought down to ~200 bytes. | [05](05-tableau-de-bord.md#the-refresh-loop) |
| Dual playback model | Shared and personal modes are interleaved by `isPersonal ? … : …` ternaries throughout the state code. | [04](04-diffusion.md#the-cost-of-the-dual-model) |
| Stopping on an unexpected error | `uncaughtException` and `unhandledRejection` log, then let the process die — that is intended, but nothing picks it back up. `SIGTERM` is still not handled. | [05](05-tableau-de-bord.md#robustness) |
| Unfinished frontend split | `app.js` still concentrates 3,819 lines that the `js/` folder has started to extract. | [05](05-tableau-de-bord.md#unfinished-split) |
