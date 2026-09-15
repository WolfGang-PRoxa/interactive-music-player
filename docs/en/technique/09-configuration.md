# 09 — Configuration

[← Contents](README.md)

---

## Two levels of configuration

| Level | File | Changeable at runtime |
|---|---|---|
| Environment | `.env` | No — restart required |
| Application constants | [`src/config.js`](../../../src/config.js) | No — defaults in the code |
| Per-server settings | `data/settings.json` | Yes — commands or dashboard |

`config.js` contains nothing but **default values**: as soon as a server is
known, its effective settings live in `settings.json` (see
[06 — Persistence](06-persistance.md)).

---

## Environment variables

Copy `.env.example` to `.env` and fill in at least `DISCORD_TOKEN`.

### Discord

| Variable | Required | Role |
|---|---|---|
| `DISCORD_TOKEN` | **Yes** | Bot token. Its absence interrupts startup. |
| `DISCORD_CLIENT_ID` | For `npm run deploy` | Identifier of the application |
| `DISCORD_CLIENT_SECRET` | For Discord sign-in | OAuth2 secret. Left empty, nobody can be identified: the dashboard says so and falls back on the access token alone. |
| `GUILD_ID` | For a local deployment | Registers the commands on that one server, with no propagation delay |

### Dashboard

| Variable | Default | Role |
|---|---|---|
| `PORT` | `3000` | Listening port |
| `HOST` | `127.0.0.1` | Listening interface. `0.0.0.0` to expose on the local network. |
| `PUBLIC_URL` | — | Address at which guests reach this dashboard, with no trailing slash. It cannot be guessed, and the callback URL `<PUBLIC_URL>/auth/discord/callback` must be declared identically in the Discord portal. |
| `AUTO_OPEN_DASHBOARD` | `true` | Opening of the browser at startup. `false` when the bot runs on a remotely driven machine — that dashboard would play the music twice over. |
| `DASHBOARD_TOKEN` | generated | Access token. If empty, generated and saved in `data/dashboard-token`. |

### Versions

| Variable | Default | Role |
|---|---|---|
| `GITHUB_TOKEN`, `GH_TOKEN` | — | GitHub API token. Optional on a public repository; raises the quota from 60 to 5,000 requests per hour. Failing that, the `gh` CLI is consulted if installed and signed in. |
| `IMP_REPO` | repository from `package.json` | Repository whose releases are offered, as `owner/repo` or as a URL |
| `IMP_VERSIONS_DIR` | `versions/` | Moves the installed releases elsewhere — secondary disk, folder outside the repository |
| `IMP_RESTART` | — | Set by the instance relaunching itself. Marks a resume, which removes the opening fade and makes the favourite channel be ignored. |

The last three are not user settings: the bot sets them itself when relaunching
another version. See [10 — Versions](10-versions.md).

### Media

| Variable | Default | Role |
|---|---|---|
| `MEDIA_ROOTS` | — | Local folders allowed for streaming, in addition to `data/uploads` and `data/cache`. Separator `;` or `,`. |
| `MAX_UPLOAD_MB` | `1024` | Maximum size of an imported file |
| `MAX_CACHE_MB` | `2048` | Ceiling of the preload cache in `data/cache` |

### Logging

| Variable | Default | Role |
|---|---|---|
| `LOG_LEVEL` | `debug` | Threshold: `debug`, `info`, `warn`, `error` |
| `LOG_RETENTION` | `20` | Number of logs kept in `data/logs` |

### Variables with no effect

`SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` are read by
`@discord-player/extractor` if present, and improve Spotify resolution.

`DEEZER_ARL`, `QOBUZ_EMAIL` and `QOBUZ_PASSWORD` have **no effect whatsoever**:
no corresponding extractor is installed or registered. They are leftovers.

---

## config.js

```js
ducking: {
    enabled: true,          // ducking active by default
    level: 20,              // % of the base volume while speaking
    restoreDelay: 800,      // ms of silence before restoration
    fadeDuration: 200,      // ms of transition
    fadeStepInterval: 20,   // ms between two fade steps
},
volume: { defaultBase: 70, min: 0, max: 100 },
presence: {
    enabled: true,          // only enter a voice channel if it is inhabited
    departureDelay: 30000,  // ms to wait before leaving an emptied channel (fallback)
},
broadcast: { defaultMode: 'everyone', personalChannelPrefix: '🎵' },
supportedExtensions:      ['.mp3', '.flac', '.wav', '.ogg', '.m4a', '.opus', '.aac', '.wma'],
supportedVideoExtensions: ['.mp4', '.webm', '.mkv', '.avi', '.mov', '.flv', '.m4v', '.3gp', '.ogv', '.wmv'],
colors: { … },   // colours of the Discord embeds
```

`fadeStepInterval` is the only constant not exposed to the user: it determines
the granularity of the fades of
[`VolumeController`](../../../src/audio/VolumeController.js).

`presence.enabled` set to `false` gives the bot back its old behaviour: it stays
connected permanently, empty channel or not. See
[04 — Broadcast modes](04-diffusion.md#presence-in-voice-channels).

`presence.departureDelay` is only a fallback value: each server sets its own from
the dashboard (*Settings → Bot settings → Delay before leaving an empty
channel*), saved per server under `presenceDepartureDelay` — **in seconds**, the
unit of the slider, which `PresenceManager._departureDelayMs()` converts back into
milliseconds. The slider runs from 0 to 300 s, and the server re-bounds the value
it receives; zero means a departure with no delay, which forbids the usual `||`
on this setting. Changing the delay rearms a countdown already under way, so as
not to wait for the next emptied channel.

The extension lists have a double role: filtering of the folders scanned by
`/playlist`, and **the perimeter of the security guard rail** for the paths
served to the client (see [07 — Security](07-securite.md)).

---

## Per-server settings

Default values defined in `_defaults()` of
[`Database.js`](../../../src/database/Database.js). Adding a key here is enough:
all existing servers inherit it, `getSettings()` merging the defaults on every
read.

| Key | Default | Description |
|---|---|---|
| `duckingEnabled` | `true` | Attenuation on speech |
| `duckingLevel` | `20` | % of the base volume while speaking |
| `duckingDelay` | `800` | ms before restoration |
| `duckingFade` | `200` | ms of transition |
| `baseVolume` | `70` | Volume outside speech |
| `broadcastMode` | `'everyone'` | Broadcast mode |
| `playbackSpeed` | `'1.0'` | Playback speed |
| `defaultVoiceChannelId` | `null` | Favourite channel — only one, across all servers; read at startup only |
| `lastVoiceChannelId` | `null` | Last channel visited — that is the one everybody follows during a session |
| `mixEnabled` | `false` | DJ-style crossfade |
| `mixDuration` | `5` | Duration of the crossfade, in seconds |
| `mixType` | `'volume'` | `'volume'` or `'effects'` |
| `lufsSyncEnabled` | `false` | Align every track on a single loudness |
| `lufsSyncTarget` | `-14` | Shared target, in LUFS |
| `fadeinEnabled` | `false` | Fade in |
| `fadeinDuration` | `5` | Seconds |
| `fadeoutEnabled` | `true` | Fade out on shutdown |
| `fadeoutDuration` | `5` | Seconds |
| `addTarget` | `'queue'` | Destination of the add field: `queue`, `playlist`, `play` or `download` |
| `importFormat` | `'mp3'` | Container of the files written to disk |
| `importAudioQuality` | `'320'` | MP3 bitrate of the preload, in kbps |
| `importVideoQuality` | `'720'` | Target height of the video stream, in pixels |
| `presenceDepartureDelay` | `30` | Delay before leaving an emptied channel, **in seconds** |
| `ignoredVoiceUsers` | `{}` | Ducking exclusions, per channel |
| `sharedControl` | `{}` | Rights granted to guests, per Discord account |
| `rightRequests` | `{}` | Rights requested by guests, awaiting an answer: account → right → timestamp |
| `mutedRightRequests` | `[]` | Guests whose rights requests are muted |
| `preloading` | see below | Preloading: `enabled`, `queueCount`, `historyCount`, `playlistCount` |
| `activePlaybackSource` | `'queue'` | `'queue'` or a playlist identifier |
| `playlistCurrentIndex` | `0` | Position in the active playlist |
| `loopPlaylist` | `false` | Replay the active playlist from its first entry |
| `channelQueues` | `{}` | The queue, filed voice channel by voice channel |
| `queueBackupPersonal` | `null` | Backup from before the per-channel filing |
| `queueBackupEveryone` | `null` | Likewise, shared mode |

`channelQueues` is `{ "<channelId>": [track | switch, …] }`. A "party" channel
and a "quiet" channel each have their own queue and find it again on return,
where a single per-server queue used to follow the bot everywhere. It is also
the only place where a switch can wait its turn: it needs an ordered list in
order to designate a position, which the player did not offer it. See
[`channelQueue`](../../../src/audio/channelQueue.js).

The last two keys are **inherited**, and stay at `null`: they carried the queue
set aside before the per-channel filing.
[`channelQueue`](../../../src/audio/channelQueue.js) reads them once to pour
back what an earlier version left there, then clears them. Everything now goes
through [`setAsideQueue`](../../../src/utils/setAsideQueue.js): a plain list of
tracks, in which nothing is "current" since nothing is playing from it while the
playlist occupies the player. The old shapes (`{ tracks }`,
`{ virtualCurrentTrack, virtualTracks }`) are still accepted on reading.

`loopPlaylist` is distinct from discord-player's repeat mode, which only knows
the queue actually loaded: replaying "the playlist" means reloading it from its
first entry, even if playback had started in the middle.

`activePlaybackSource` does not go back to `'queue'` on the user's decision
alone: a playlist that finishes without looping hands back to the queue set
aside, which then starts again on its first title
(`WebServer.advanceToQueue()`). The switch is attempted at both points of
exhaustion — the virtual queue of personal mode and the `emptyQueue` event of
shared mode —, always after the loop restart: it is that order, and not a test on
`loopPlaylist`, that gives priority to the loop. An empty set-aside queue lets
playback stop, as before.

The `preloading` sub-object (`enabled`, `queueCount`, `historyCount`,
`playlistCount`) is set from the dashboard but **consumed on the server side**
by [`PreloadManager.js`](../../../src/audio/PreloadManager.js): the value must
therefore live here, and not in the browser's `localStorage` alone.

The three counters run from 0 to 5, plus a final notch that no longer counts and
takes the whole section. That one is recorded as **`-1`**, never as the slider's
position: the position is only worth anything relative to the maximum of the
day, and the day the sliders gained a notch, a recorded `6` would stop meaning
"everything" without anything signalling it. A negative count, by contrast, is
not one in any world. It is read back as `Infinity`, which the `slice(0, n)` and
`Math.min(n, …)` downstream already handle correctly.

---

## npm commands

| Command | Effect |
|---|---|
| `npm start` | Starts the bot |
| `npm run dev` | Starts with `--watch` (restart when a file changes) |
| `npm run deploy` | Registers the slash commands with Discord |
| `npm run update-ytdlp` | Updates yt-dlp — to be done when preloading fails with a 403 |

### Deploying the commands

[`deploy-commands.js`](../../../src/deploy-commands.js) collects the commands
from `src/commands/` and registers them **globally**. Propagation can take up to
an hour. For an immediate test, define `GUILD_ID` in `.env`: the commands are
then registered on that one server, with no delay.

This script must be run again on every addition, removal or change of the
signature of a command. Modifying only the body of a command does not require it.

---

## Discord commands

| Command | Options | Rights |
|---|---|---|
| `/play` | `query` — search, URL, or local path | Everyone |
| `/playlist` | `path`, `shuffle` | Everyone |
| `/queue` | `page` | Everyone |
| `/skip`, `/pause`, `/resume`, `/stop` | — | Everyone |
| `/nowplaying` | — | Everyone |
| `/volume` | `level` (0–100) | Everyone |
| `/ducking toggle\|level\|delay\|fade\|status` | depending on the sub-command | Everyone |
| `/broadcast` | `mode` — `everyone` or `personal` | **Administrator** |

Rights checks use
[`utils/permissions.js`](../../../src/utils/permissions.js).

---

## Prerequisites

- **Node.js 18 or above** — the project uses `fs.promises`, the optional chaining
  operator and `structuredClone` indirectly through its dependencies. No
  `engines` field is declared in `package.json`.
- **FFmpeg** — supplied by `ffmpeg-static`, no system installation required.
- **yt-dlp** — supplied by `youtube-dl-exec`, used as a resolution fallback and
  for video extraction.

The required Discord intents (`Guilds`, `GuildVoiceStates`, `GuildMessages`) must
be enabled on the developer portal.
