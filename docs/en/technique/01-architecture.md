# 01 — Architecture

[← Contents](README.md)

---

## Directory tree

```
src/
├── index.js                  Entry point: Discord client, player, ducking, shutdown
├── config.js                 Constants and defaults (not modified at runtime)
├── deploy-commands.js        Registration script for the slash commands
│
├── audio/
│   ├── PlaybackSession.js    Per-server playback state (declared schema)
│   ├── DuckingManager.js     Speech detection → volume steering
│   ├── VolumeController.js   Gradual fades on the audio node
│   ├── PlayerEvents.js       discord-player event listeners
│   ├── PresenceManager.js    Bot arrival and departure by channel occupancy
│   ├── PreloadManager.js     Disk cache of remote tracks
│   ├── LocalFilePlayer.js    Audio folder scanning helpers
│   ├── playbackSettings.js   Speed and mix effects, whatever the audio path
│   └── mix/                  Mixing bus: shared broadcast, two stackable tracks
│       ├── format.js         PCM exchange format and framing
│       ├── input.js          Resolving a track into an FFmpeg input
│       ├── MixSource.js      One decoded track, with gain and filter
│       ├── MixBus.js         The permanent stream sent to Discord
│       ├── MixEngine.js      Per-server orchestration and queue steering
│       ├── playerBridge.js   Routing of the player's methods to the bus
│       └── index.js          Registry of buses, one per server
│
├── broadcast/
│   └── BroadcastManager.js   Broadcast modes, personal channels
│
├── commands/                 Discord slash commands (one per file)
│
├── database/
│   ├── Database.js           Per-server settings + global playlists
│   └── PlaybackStateManager.js  Playback snapshot and restoration
│
├── utils/
│   ├── logger.js             Application logging
│   ├── atomicJson.js         Crash-resistant JSON reading/writing
│   ├── mediaPaths.js         Guard rail for paths served to the client
│   ├── downloadDir.js        Folder the downloaded files are written to
│   ├── paths.js              Path comparison and cleanup
│   ├── duration.js           Duration formatting and parsing
│   ├── embeds.js             Discord embeds
│   └── permissions.js        Permission checks
│
└── web/
    ├── WebServer.js          HTTP + WebSocket server, state aggregation
    ├── auth.js               Access token (HTTP and WebSocket)
    ├── uploadService.js      Reception and integration of imported files
    ├── routes/api.js         HTTP routes (stream, download, upload, video-info)
    ├── websocket/
    │   ├── wsHandler.js      WebSocket message router
    │   ├── handlerUtils.js   Helpers shared by the handlers
    │   └── handlers/         One module per domain + routing table
    └── public/               Frontend served as-is (HTML, CSS, JS)
```

The `data/` folder, created at runtime, is not versioned:

```
data/
├── settings.json           Per-server settings + global playlists
├── playback_state.json     Last known playback state
├── dashboard-token         Access token generated on first startup
├── uploads/                Imported files, named by fingerprint
├── cache/                  Preloaded remote tracks in MP3
├── downloads/              Downloaded files, if no other folder is chosen
└── logs/                   One log per startup + latest.log
```

The `tools/` folder carries the Windows tooling, unrelated to the bot's process
— no module in `src/` references it:

```
Create shortcut.vbs       Double-clickable entry point, at the root
Start bot.vbs             Direct startup, without going through a shortcut
tools/
├── create-shortcut.ps1   WPF wizard: choice of location, writing of the .lnk
├── start-bot.vbs         Target of the shortcut: calls the .ps1 without a window
├── start-bot.ps1         Checks, installation, startup of the bot
└── icon.ico              Shortcut icon, redrawn if absent, not versioned
```

**Why `.vbs` files.** The shortcut launches `wscript.exe start-bot.vbs`, which
calls PowerShell with a window style of `0`. That is the only way on Windows to
start a script without any console existing at all: a `.bat`, or a `.lnk`
pointing at `powershell.exe -WindowStyle Hidden`, always makes a terminal flash
— visible on screen and in the taskbar — before hiding it. The `.lnk` targets
`wscript.exe` explicitly, and not the `.vbs`, because some machines associate
`.vbs` files with `cscript.exe`, which would open a console.

`Start bot.vbs` and `tools/start-bot.vbs` are deliberately the same call, up to
a relative path: the first is the entry point you double-click in the project
folder, the second the stable target of the `.lnk`. Keeping them distinct avoids
an existing shortcut depending on a file at the root, where the user is most
likely to rename or move something. Neither carries any logic: everything is in
`start-bot.ps1`.

**The launch window.** Since the bot runs without a console, what the console
used to carry is taken up elsewhere: the progress of startup and its errors by
the WPF window of `start-bot.ps1`, the detail by `data/logs/`, shutdown by the
dashboard's power button (`shutdownBot`, see [05](05-tableau-de-bord.md)).

This window appears at **every** launch, and no longer only on first use. It
lists the steps actually to be done — dependencies and command registration only
appear if `node_modules` is missing — and marks each with a pending dot, a
spinning ring, a green tick, an amber tick for a non-blocking failure, or a red
cross. On a cross, the sequence stops and the foot of the window carries the
reason, an excerpt from the log, and the button that unblocks: download Node.js,
open `.env`, open the logs.

Three points are worth knowing before touching any of it:

- **The "ready" signal is the dashboard's port.** The bot only opens it once
  connected to Discord (`ClientReady` in `src/index.js`): a simple TCP
  connection to `127.0.0.1:PORT` is therefore the only reliable witness, where
  the existence of the process proves nothing. The window disappears as soon as
  the port answers, and the browser is opened by the bot itself
  (`WebServer.start`), never by the script.
- **An already open port halts the launch.** Without this preliminary check, a
  second startup would die on an occupied port while the wait above succeeded
  immediately — a false success. The window then announces that the bot is
  already running and offers three cards: open the dashboard, restart, shut
  down.
- **Configuration is checked before installation.** The order is not
  indifferent: `npm run deploy` needs the Discord token, and it is only replayed
  when `node_modules` is missing. Checking afterwards would have condemned the
  slash commands to never being registered on a freshly fetched folder.

An immediate failure — token refused, module broken — would stay invisible: the
startup step therefore watches the process, and the dashboard step hands back
after ninety seconds rather than waiting forever.

**Steering an already running bot.** The "Restart" and "Shut down" cards add no
access point: they borrow the dashboard's channel, an authenticated WebSocket
over which `restartBot` and `shutdownBot` travel
(`src/web/websocket/handlers/systemHandlers.js`). Exposing process shutdown a
second time, over HTTP, would have widened the attack surface without bringing
anything. The token travels in the query — a form accepted by
`auth.extractToken` both for `/api` and for the WebSocket handshake.

Shutting down asks for confirmation, like the dashboard's maintenance window:
cutting off playback for an entire server must not hang on a stray click.
Restarting, for its part, goes straight ahead — playback resumes where it was.
Both account for themselves by replaying the step engine: the port going down,
then coming back.

Only one addition on the bot's side: `GET /api/clients`, which returns the
number of connected dashboards. It is the same measure by which `WebServer.start`
decides whether or not to open the browser, and the window uses it so as not to
open one more tab when there is already one. The count is asked again on every
click rather than remembered at opening: a tab closed in the meantime would
otherwise condemn the button. If the question cannot be asked, the tab is opened
— better a duplicate than an unreachable dashboard.

Four traps of Windows PowerShell 5.1 and of GDI+ are defused in these scripts,
and must remain so:

| Trap | Consequence | Countermeasure in place |
|---|---|---|
| A `.ps1` without a BOM is read in the ANSI code page | The whole interface loses its accents | Both `.ps1` files are in **UTF-8 with BOM**; the `.vbs` files, in pure ASCII |
| `Start-Process -PassThru -RedirectStandardOutput` returns an `ExitCode` that is always null | A successful command is read as a failure | No .NET redirection: `cmd` redirects by itself (`1> … 2>&1`) |
| A script block invoked by `&` runs in the caller's scope, not in that of its definition | The `Start`/`Poll` blocks of a step do not see the parameters of the function that created them | They read their data from the current step (`CurrentStep`) and only write into `$script:` variables |
| `GraphicsPath` and `GeometryGroup` fill using even-odd by default | The overlaps of the musical note punch holes in each other | `FillMode = Winding` on the GDI+ side, `FillRule="Nonzero"` on the XAML side |

Two names are also to be avoided in these scripts: `$host`, a read-only reserved
variable, and any parameter that would take up the name of an interface element
— PowerShell does not distinguish case, and the parameter wins.

---

## Startup sequence

`npm start` runs [`src/index.js`](../../../src/index.js), in this order:

**1. Windows fix.** Before any `require`, `child_process.spawn` is wrapped to
force `windowsHide: true`. Without this, every call to FFmpeg or yt-dlp makes a
console window appear. The fix must precede the other imports in order to cover
third-party libraries.

**2. Registration of the speed filters.** 286 FFmpeg `speed_x_xx` filters are
declared (see [02 — Audio playback](02-lecture-audio.md#playback-speed)).

**3. Environment validation.** A missing `DISCORD_TOKEN` interrupts startup.

**4. Creation of the Discord client** with the `Guilds`, `GuildVoiceStates` and
`GuildMessages` intents.

**5. Loading of the commands** from `src/commands/`.

**6. Initialisation of discord-player**, registration of the extractors, of the
event listeners and of the preload manager.

**7. Connection to Discord.** On the `ClientReady` event:
- startup of the web server;
- restoration of the saved playback state;
- scheduling of the periodic save (every 5 s).

```
index.js
  ├─ patch spawn (win32)
  ├─ AudioFilters : speed_0_20 … speed_3_05, muffled
  ├─ new Client(...)
  ├─ loadCommands()
  ├─ initPlayer()
  │    ├─ extractors.register(Youtubei, Spotify, SoundCloud, AppleMusic, Attachment)
  │    ├─ registerPlayerEvents()
  │    └─ preloadManager.init()
  └─ client.login()
       └─ ClientReady
            ├─ webServer.start(client, PORT, HOST)
            ├─ playbackStateManager.restoreAll()
            └─ setInterval(saveState, 5000)
```

---

## Dependency map

The arrows go from the consumer towards the provider.

```
                    index.js
                       │
        ┌──────────────┼──────────────┬───────────────┐
        ▼              ▼              ▼               ▼
   commands/      audio/         web/WebServer   database/
        │              │              │               │
        └──────────────┴──────┬───────┴───────────────┘
                              ▼
                          utils/
              (logger, atomicJson, paths, duration, mediaPaths)
```

`utils/` depends on nothing other than `config.js`. It is the leaf layer:
everything can import it without any risk of a cycle.

**Two cycles exist** and are resolved by `require()` calls deferred inside the
functions:

- `DuckingManager` → `WebServer` (to rebroadcast state on speech detection);
- `PlayerEvents` → `WebServer` → `wsHandler` → handlers → `PlaybackStateManager`.

These inline `require()` calls are deliberate. Moving them to the top of the
file would cause unresolved circular imports.

---

## Life cycle of a playback

Example: a user starts a track from the dashboard.

```
Browser ─────WS {type:'play', data:{query}}──► wsHandler
                                                  │
                                     handlers/playbackHandlers.handlePlay
                                                  │
                              ┌───────────────────┼────────────────────┐
                              ▼                   ▼                    ▼
                    searchLocalAwareTrack   queue.connect()      queue.play()
                    (extractors)            (voice channel)            │
                                                                      ▼
                                                          discord-player → FFmpeg
                                                                      │
                                                            'playerStart' event
                                                                      │
                              ┌───────────────────────────────────────┤
                              ▼                                       ▼
                     client.setupDucking()                  webServer.broadcastState()
                     (VolumeController + DuckingManager)              │
                                                                      ▼
                                                             Browser ◄──WS {type:'state'}
```

---

## PlaybackSession

discord-player exposes a `GuildQueue` object per server. The project used to
attach its own properties directly to it, without encapsulation:

| Property | Role |
|---|---|
| `virtualCurrentTrack`, `virtualTracks`, `virtualHistory` | Virtual player of the personal mode |
| `virtualIsPlaying`, `virtualIsPaused`, `virtualProgressMs`, `virtualLastUpdated` | State of the virtual player |
| `channelStates` | Playback snapshot per voice channel |
| `activeChannelId` | Channel considered active |
| `silencePlayer`, `silenceStream` | Silence emitter of the personal mode |
| `transitioningToEveryone`, `transitionTrack`, `transitionTargetProgress` | Personal → shared switch |
| `isPendingTransition`, `transitionTimeout` | Anti-double-jump lock |
| `restorePaused`, `restoreProgress`, `restoreShouldBePaused` | Restoration at startup |
| `isMixFadingOut`, `mixAppliedTrackId`, `trackStartedAt` | DJ-style crossfading |
| `pauseOnNextTrack` | Deferred pause |

**Why that was a problem.** None of these properties was declared anywhere:
their existence had to be discovered by reading the access sites. Every read had
to guard itself (`if (!queue.virtualTracks) queue.virtualTracks = []` — 18
occurrences). A version bump of discord-player introducing an identical name
would have broken the bot silently.

### The state now belongs to the project

[`PlaybackSession`](../../../src/audio/PlaybackSession.js) declares the 23
properties in a single `SCHEMA`, with their type and their initial value. The
state lives in that object; the queue no longer owns it.

```
   queue.virtualTracks
          │  accessor installed on GuildQueue.prototype
          ▼
   session.virtualTracks        ← PlaybackSession, owned by the project
```

**Association by `WeakMap`.** The session is bound to the queue object, not to
the `guildId`: a new queue starts from a fresh state — identical behaviour to
before — and the state is released along with it, with no memory leak.

**Accessors on the prototype.** They cover every queue, whatever path created
it, including those that discord-player instantiates itself — out of reach of an
interception of `queues.create()`. The properties are **non-enumerable**: they
no longer appear in an accidental serialisation of the queue.

### Unified interface

The session exposes accessors that hide the distinction between shared mode and
personal mode:

| Method | Replaces |
|---|---|
| `getCurrentTrack()` | `isPersonal ? queue.virtualCurrentTrack : queue.currentTrack` |
| `getTracks()` | `isPersonal ? queue.virtualTracks : queue.tracks.toArray()` |
| `getHistory()` | `isPersonal ? queue.virtualHistory : queue.history.tracks.toArray()` |
| `getIsPlaying()` / `getIsPaused()` | mode + transition branching |

Used by `PreloadManager.getActivePreloadTracks` and
`WebServer.getPlaybackPosition`.

### Remaining migration

The 455 existing access sites keep working through the accessors: the
`queue.virtualTracks` syntax is unchanged, only the storage has moved. Rewriting
them as `session.virtualTracks`, then removing the accessors, can be done file
by file — the bulk of the benefit (declared schema, guaranteed initial values,
protection against collisions) is already secured.

---

## Points to watch when making changes

**Adding a Discord command** — create a file in `src/commands/` exporting
`{ data, execute }`, then run `npm run deploy` again. The loader in
[`index.js`](../../../src/index.js) contains a hard-coded special case for
`queue.js`, which exports five commands.

**Adding a WebSocket message** — see
[05 — Dashboard](05-tableau-de-bord.md#adding-a-message).

**Adding a persistent setting** — add it to `_defaults()` in
[`Database.js`](../../../src/database/Database.js); servers already registered
automatically inherit the default value on reading.
