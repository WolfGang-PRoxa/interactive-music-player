# 05 — Dashboard

[← Contents](README.md)

The dashboard is a web application served by the bot itself. It drives playback
in real time and duplicates every one of the Discord commands.

---

## Server

[`WebServer.js`](../../../src/web/WebServer.js) is a singleton that assembles:

- an Express **HTTP** server: static files and `/api/*` routes;
- a **WebSocket** server (`ws`) sharing the same port;
- the aggregation of the complete state (`getState`) and its broadcast.

It listens on `HOST:PORT`, **`127.0.0.1:3000` by default**. At startup, the
browser is opened automatically after 5 seconds if no client is connected, on a
URL containing the access token.

### Division of responsibilities

| File | Role |
|---|---|
| [`WebServer.js`](../../../src/web/WebServer.js) | Life cycle, state aggregation, broadcast |
| [`auth.js`](../../../src/web/auth.js) | HTTP and WebSocket access token |
| [`oauth.js`](../../../src/web/oauth.js), [`sessions.js`](../../../src/web/sessions.js) | Discord OAuth journey, per-tab sessions |
| [`owner.js`](../../../src/web/owner.js), [`guests.js`](../../../src/web/guests.js) | Owner of the installation, book of guests |
| [`permissions.js`](../../../src/web/permissions.js) | What a guest is allowed to do |
| [`tailscale.js`](../../../src/web/tailscale.js) | Publishing the dashboard on the internet |
| [`routes/api.js`](../../../src/web/routes/api.js) | HTTP routes |
| [`routes/auth.js`](../../../src/web/routes/auth.js) | A guest's authentication journey |
| [`uploadService.js`](../../../src/web/uploadService.js) | Reception and integration of imports |
| [`websocket/wsHandler.js`](../../../src/web/websocket/wsHandler.js) | Message router |
| [`websocket/handlers/`](../../../src/web/websocket/handlers/) | Business logic, one module per domain |

---

## HTTP routes

All are protected by the token ([07 — Security](07-securite.md)).

| Route | Role |
|---|---|
| `GET /api/state` | Complete state, as a fallback if the WebSocket is unavailable |
| `GET /api/invite` | Link to invite the bot onto a new Discord server |
| `GET /api/stream` | Audio stream of a track, for the browser's player |
| `GET /api/download` | Transcoded download, 32 format/quality combinations (MP3, M4A, FLAC, WAV, OGG, OPUS, WEBM, MP4) |
| `GET /api/video-info` | Resolution of a video URL through yt-dlp, one-hour memory cache |
| `POST /api/upload` | File import, raw stream with an `X-File-Name` header |
| `GET /api/docs` | Contents of the embedded documentation, in the requested language |
| `GET /api/docs/content` | Markdown source of a document, designated by its identifier and its language |
| `GET /api/download-dir` | Current download folder, and the default it compares against |
| `POST /api/download-dir` | Choice of folder, validated before being kept; empty body returns to the default |
| `GET /api/browse-dirs` | Sub-folders of a path on the host machine, for the picker |
| `GET /api/version` | Running version — `dev` or the release tag |
| `GET /api/clients` | Number of connected dashboards, and address at which to open the dashboard; consulted by the launch window |

`/api/docs` inventories `docs/` on every call, from the **version currently
running** and not from the shared root: the documentation displayed is therefore
that of the code that is running. The identifiers returned form the whitelist of
the content service — that service never builds a path from the request, it
looks the identifier up in the inventory it has just established. That is what
makes a directory traversal beside the point rather than against the law.

Both routes accept a `lang` parameter, that of the dashboard: `docs/` is
arranged by language — `docs/fr/`, `docs/en/`… —, the identifiers stay the same
everywhere, and the reader never asks for anything other than the language of its
interface. The value received undergoes the same treatment as the identifier: it
is compared with the folders the server has itself read, never assembled into a
path. The inventory starts from the folder of the language retained, and **never
from `docs/`**: walked from the shared root, the tree would return the language
folders themselves as so many groups, and the reader's table of contents would
turn into a language selector — whereas the language is only chosen in the
settings. A language absent from `docs/` falls back to French, as a whole.

`/api/invite` assembles the address from the application actually connected
(`client.generateInvite`, `bot` and `applications.commands` scopes): an
identifier hard-coded into the page ends up designating another application, and
Discord then answers "unknown application". It is an HTTP route and not a state
field, because `/api/state` refuses to answer as long as the bot has joined no
server — precisely the case in which this link is the only recourse.

`/api/stream` serves, in order: the preload cache file if it exists, otherwise
the local file if it is under an allowed root, otherwise an on-the-fly MP3
transcode of the remote stream.

### Range requests

The first two branches go through `serveFileWithRange()`, which answers
`206 Partial Content` with the correct `Content-Range`, bounds out-of-range ends,
handles the suffix form (`bytes=-500`), and returns `416` on an unreachable
range. An unreadable range is ignored: the whole file is served.

**This is indispensable to moving within the track.** Without a `206` response,
the browser has to download from the beginning in order to reach the requested
position. The preload cache branch announced `Accept-Ranges: bytes` while
ignoring the `Range` header: on reloading the dashboard, playback only resumed
once the download had reached the recorded position.

The remote transcode, for its part, is intrinsically sequential
(`Transfer-Encoding: chunked`) and cannot honour a range — all the more reason
for preloading to feed the cache.

### Authentication routes

Four routes escape the `/api` prefix and are carried by
[`routes/auth.js`](../../../src/web/routes/auth.js):

| Route | Role |
|---|---|
| `GET /auth/discord` | Departure to `discord.com`, token noted and stowed in the `state` |
| `GET /auth/discord/callback` | Return from Discord: code exchanged, session opened, back to the dashboard |
| `GET /auth/state` | Who is signed in on this tab, and what they are allowed to do |
| `POST /auth/logout` | Closes this tab's session |

The first two are **open without a token** (`PUBLIC_PATHS` in
[`auth.js`](../../../src/web/auth.js)): whoever clicks the link posted in the
voice channel's chat has by definition nothing to authenticate with — that is
precisely what they have come for. See
[07 — Security](07-securite.md#authentication).

---

## WebSocket protocol

### Server → client messages

| Type | Payload |
|---|---|
| `state` | Complete state (see below), emitted on events |
| `progress` | `{ progress, isPlaying, isPaused, botStats }` — emitted every second, ~200 bytes |
| `log` | One log entry `{ timestamp, level, text }` |
| `logsHistory` | The last 200 entries, on connection |
| `error` | `{ message }`, shown as a notification |
| `status` | `{ status: 'restarting' \| 'shutting_down', … }` |
| `memory` | Memory samples, as long as the side panel asks for them |
| `speakers` | Who is speaking right now, for the voice activity box |
| `permissionDenied` | A message was refused to a guest — the right that was missing |
| `shareResult`, `controlRevoked` | Aftermath of a sharing gesture, for the master and for the guest |
| `tunnelState` | State of the tunnel, when its window opens |
| `versionCatalog` | Catalogue of versions, re-read from GitHub each time the menu opens |
| `trackFormats` | Formats and bitrates actually available for a track |

### Client → server messages

54 types, declared in the routing table
[`handlers/index.js`](../../../src/web/websocket/handlers/index.js). Each domain
matches one module of `handlers/`:

| Domain | Messages |
|---|---|
| Playback | `play`, `pause`, `resume`, `skip`, `previous`, `stop`, `seek`, `setPlayMode`, `syncProgress`, `startPlaybackSource` |
| Queue | `removeTrack`, `playNow`, `moveOrInsertTrack`, `clearQueue`, `removeFromHistory`, `clearHistory` |
| Playlists | `createPlaylist`, `renamePlaylist`, `deletePlaylist`, `reorderPlaylists`, `addPlaylistTrack`, `addTrackToPlaylist`, `removeTrackFromPlaylist`, `movePlaylistTrack`, `setActivePlaybackSource`, `insertTransition`, `setTransitionTarget` |
| Discord server | `selectChannel`, `setDefaultChannel`, `updateSettings`, `toggleVoiceDetection`, `leaveGuild` |
| Track | `setTrackQuality`, `requestTrackFormats`, `requestTrackLoudness`, `setTrackLoudness`, `downloadTrack` |
| Control sharing | `sendInviteLink`, `admitGuest`, `shareControl`, `revokeControl` |
| Tunnel | `tunnelState`, `tunnelLogin`, `tunnelMount`, `tunnelUnmount` |
| Versions | `listVersions`, `installVersion`, `uninstallVersion` |
| System | `requestState`, `clientLog`, `memoryStream`, `startupFadeinConsumed`, `restartBot`, `shutdownBot` |

The last four domains are **reserved for the session master**: they do not
appear in the sharing window, and a guest who sent them by hand would be refused
by [`permissions.js`](../../../src/web/permissions.js) (see
[07 — Security](07-securite.md#shared-rights)). Sharing, publishing the
dashboard on the internet, changing the running version or shutting the bot down
are not playback commands.

`leaveGuild` makes the bot leave a Discord server — the wastebasket in the
settings, after confirmation of the name. The playback queue is destroyed before
the departure, then the dashboards left on that server are switched over to
another (`WebServer.reassignClients`), failing which they would no longer
receive any state. To be distinguished from the neighbouring switch, which only
hides the server in the lists of that browser — a local setting, with no effect
on the bot.

The context menu of a local track does not open its folder: a browser cannot
command the file explorer of the machine displaying it. It offers instead "Copy
the file path", which puts `track.url` on the clipboard — the user pastes that
path wherever they like. Everything is on the client side, no WebSocket message
is exchanged.

### Structure of the state

```js
{
  guildId, selectedVoiceChannelId,
  guilds: [ { id, name, voiceChannels: [ { id, name, userCount, botConnected, isPlaying } ] } ],
  currentTrack, progress: { current, currentMs, total, totalMs, percent },
  mixTransition: null | { sortante: { url, positionMs, dureeMs, ratio },
                          entrante: { url, positionMs, dureeMs, ratio, track } },
  isPlaying, isPaused, isTransitioning, repeatMode, volume,
  listenerWait: null | { playing },   // playback frozen, channel emptied of humans
  settings: { duckingEnabled, duckingLevel, duckingDelay, duckingFade,
              broadcastMode, playbackSpeed, mixEnabled, mixDuration, mixType, … },
  queue: [...], history: [...], playlists: [...],
  activePlaybackSource, playlistCurrentIndex,
  speakers: [userId], ignoredVoiceUsers: [userId],
  members: [ { id, displayName, avatar } ],
  botStats: { memory, uptime, timestamp }
}
```

Every track is enriched by `formatTrackWithPreload()` with `isPreloaded`,
`isPreloading` and `preloadProgress`.

`progress.currentMs` and `progress.totalMs` are always expressed in the file's
own time, with playback speed not applied — whatever the broadcast mode. It is
the browser that divides by `playbackSpeed` when displaying the two durations,
and it is on that scale too that repositioning requests are expected. The ratio
`currentMs / totalMs` therefore gives the progress bar directly. The position
that `queue.node.getTimestamp()` returns follows the same scale, but not its
total duration, already divided by the speed: `buildProgress()` recomputes it
from the track.

`mixTransition` is only filled in during shared broadcasting, while the mixing
bus is crossfading: two pieces then sound together, and the server's queue only
declares the second one current at the end of the overlap. The dashboard uses it
to announce the incoming title from the beginning of the fade and to animate both
lines of the playlist at once — something personal broadcasting works out on its
own from its two `<audio>` elements.

---

## Message routing

[`wsHandler.js`](../../../src/web/websocket/wsHandler.js) contains **no business
logic**. It assembles a context and delegates:

```js
await handler({
    ws, data, webServer, player,
    queue: player.queues.get(currentGuildId),
    currentGuildId,
    dispatch: (payload) => handleMessage(ws, payload, webServer),
});
```

`dispatch` allows a handler to reuse another — `playNow` builds on `play`. `data`
is systematically replaced by `{}` if it is absent, which relieves every handler
of having to guard against it.

### Adding a message

1. Write the function in the module of
   [`handlers/`](../../../src/web/websocket/handlers/) matching the domain, with
   the signature `(ctx)`.
2. Export it.
3. Add the line `myMessage: myModule.handleMyMessage,` in
   [`handlers/index.js`](../../../src/web/websocket/handlers/index.js).

The router is never modified.

---

## The refresh loop

`WebServer.start()` installs a one-second `setInterval` which, for each server:

1. advances the position of the virtual player in personal mode;
2. detects the triggering of a DJ crossfade;
3. calls `preloadManager.update()`;
4. broadcasts **only the progress** (`broadcastProgress`).

The complete state goes out on events — track changed, queue modified, setting
touched — through `broadcastState`. This separation rests on
`getPlaybackPosition()`, which computes the position without reformatting the
tracks.

### What made the one-second turn expensive

Before this separation, every tick rebroadcast the complete state: all the voice
channels, all the members, the queue, the history and **all the playlists**.
Every track went through `getTrackPreloadInfo()`, which chained about four
`fs.existsSync` calls and one `fs.statSync`.

| Tracks | Before — blocking / message | After |
|---|---|---|
| 10 | 0.3 ms / 8 KB | ~0 ms / 216 bytes |
| 50 | 1.6 ms / 40 KB | ~0 ms / 216 bytes |
| 200 | 6.5 ms / 119 KB | ~0 ms / 216 bytes |
| 500 | 16.2 ms / 277 KB | ~0 ms / 216 bytes |

The periodic payload no longer depends on the number of tracks.

### The three measures applied

1. **Progress alone on the one-second turn** — `broadcastProgress` only sends
   `{ progress, isPlaying, isPaused, botStats }`.
2. **In-memory index of the preload cache** — `PreloadManager.cacheIndex`
   replaces re-reading the disk; the status of a track goes from 32.4 µs to
   1.3 µs. An `http(s)` URL now short-circuits the local file test, which could
   not have found anything anyway.
3. **No identical re-emission** — `broadcastState` compares a signature of the
   state, `botStats` excluded (its timestamp changes on every call and would make
   any comparison useless), and sends nothing if it is unchanged.

This interval is never stopped: there is no `stop()` method.

---

## Robustness

The initialisation of a client is isolated in `_initClient()`, called under
`try/catch` from `wss.on('connection')`. An exception occurring there — for
instance `getState()` on an unexpected state — used to be an uncaught exception
that **terminated the process**: a connection to the dashboard at the wrong
moment was enough to stop the bot. The offending client now receives an error
message and is then disconnected; the bot carries on.

Incoming messages are protected in the same way: `ws.on('message')` wraps the
call to the router.

Higher up, `uncaughtException` and `unhandledRejection` are wired to
`dieLoudly()` in [`index.js`](../../../src/index.js). Those two handlers
**catch nothing**: they write `[FATAL]` to the log, then let the process die.
That is deliberate — carrying on after an error whose shape nobody anticipated
would leave a bot running in an unknown state, which is worse than stopping.
What they bring is the **trace**: since the bot runs without a console, what
Node writes by itself on `stderr` before dying is visible nowhere, and a token
refused at login used to depart without a word in `data/logs/`.

> `SIGTERM` is still not handled — only `SIGINT` is, with the fade-out of
> [06 — Persistence](06-persistance.md#fade-out).

A 30-second *heartbeat* (`ping`/`pong`) closes dead connections.

---

## Frontend

Around 28,000 lines of JavaScript, served without transformation. No ES modules,
no bundler: 43 `<script>` tags loaded sequentially in
[`index.html`](../../../src/web/public/index.html) — 41 modules from `js/`, the
translations and `app.js` — communicating through the global `window.MusicPlayer`
namespace.

| File | Role |
|---|---|
| `state.js` | Shared state, preferences, internationalisation |
| `websocket.js` | Connection, automatic reconnection, sending |
| `app.js` | Conductor: player, settings, personal playback |
| `player.js`, `mediaSession.js`, `loudnessGain.js` | Progress bar, durations, system controls, level gain |
| `queue.js`, `searchHistory.js`, `downloadTarget.js` | Queue, history, the add field and its destination |
| `playlists.js`, `playlistTabsScroll.js`, `transitions.js` | Playlist tabs and switches |
| `video.js`, `qualityMenu.js` | Video playback, visualiser, quality and format menus |
| `logs.js`, `clientErrors.js` | Log terminal, reporting of browser errors |
| `drawer.js`, `drawerWidgets.js`, `memoryBreakdown.js` | Statistics side panel |
| `docs.js` | Reader for this documentation, column pagination |
| `loginGate.js`, `account.js`, `sharedControl.js`, `shareTunnel.js` | Discord sign-in, account, control sharing, tunnel |
| `versions.js`, `githubMenu.js` | Version menu and GitHub gestures |
| `settingsModal.js`, `speedPad.js`, `customSelect.js`, `outputLevel.js` | Interface controls |
| `deviceMode.js`, `touchDrawers.js`, `touchDragDrop.js`, `dragPreview.js`, `scrollLock.js`, `scrollFade.js` | Adaptation to touch and small screens |
| `layoutPersistence.js` | Saving of the layout |
| `tooltipSystem.js`, `faviconAnimator.js`, `headerButtonAnimations.js`, `particlePath.js`, `themeBlend.js` | Styling |

The thirteen style sheets are assembled by `@import` in
[`style.css`](../../../src/web/public/style.css), the only sheet referenced by
`index.html`.

The loading order is an implicit dependency: `state.js` must come before all the
others, `app.js` must come last.

### Unfinished split

[`app.js`](../../../src/web/public/app.js) is 3,819 lines long and concentrates
responsibilities that the `js/` folder has already begun to extract. It is the
frontend counterpart of the split carried out on the server side, which remains
to be finished.

### Duplication to watch

`window.MusicPlayer.formatMs` in
[`player.js`](../../../src/web/public/js/player.js) must stay aligned with
`formatMs` from [`src/utils/duration.js`](../../../src/utils/duration.js): it is
the client that renders the timeline, from milliseconds and not from the string
sent by the server.
