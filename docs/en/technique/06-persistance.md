# 06 — Persistence

[← Contents](README.md)

No database: everything is stored in JSON files in `data/`, with a memory cache
that is authoritative while the process runs.

---

## Overview

| File | Content | Write rhythm |
|---|---|---|
| `data/settings.json` | Per-server settings + global playlists | On every change, batched over 120 ms |
| `data/playback_state.json` | Last known playback state | Every 5 s and on events |
| `data/dashboard-token` | Access token | Once, on first startup |
| `data/sessions.json` | Open Discord sessions | On opening, then batched over 5 s |
| `data/guests.json` | Book of guests already seen | On every visit, batched over 5 s |
| `data/owner.json` | Account that owns the installation | Once, when claimed |

> `better-sqlite3` appears in `optionalDependencies` but is **never imported**.
> It is a leftover from an abandoned approach: the native compilation was
> problematic on Windows.

---

## Atomic writing

[`utils/atomicJson.js`](../../../src/utils/atomicJson.js) is the only authorised
JSON write point.

### The problem solved

`fs.writeFileSync` **truncates the file before rewriting it**. An interruption
during that window leaves an incomplete, therefore unreadable, JSON. The previous
behaviour made the loss worse: the parse error was caught, the cache started
again empty, and the first subsequent save definitively overwrote the corrupted
file.

### The sequence

```
1. write to  .<name>.<pid>.tmp   (same folder, so same file system)
2. fsync                          (guarantee that the bytes are on disk)
3. rename  →  <name>              (atomic operation)
```

At any instant, the target file is either the old complete version or the new
one. The `fsync` is not optional: without it, the rename can precede the actual
writing of the bytes, and a power cut leaves an empty file.

`renameSync` does overwrite an existing target on Windows, libuv using
`MOVEFILE_REPLACE_EXISTING`.

### Reading and quarantine

`readJsonSafe()` renames an unreadable file to `<name>.corrompu-<date>` instead
of letting it be overwritten. Startup carries on with the default values, and the
file remains recoverable.

`cleanStaleTemp()` deletes at startup the `.tmp` files left by an abrupt stop.

### Serialisation

`createSafeReplacer()` handles `BigInt` values (converted to strings) and
repeated references. **Careful**: it discards every object already encountered,
not just genuine cycles. That is the historical behaviour, kept so as not to
change the output; an object legitimately present in two places would be omitted
at its second occurrence.

The replacer keeps internal state — it must be created for **every**
serialisation.

---

## Database

[`Database.js`](../../../src/database/Database.js) — singleton, per-server
settings and global playlists.

### Structure of the file

```json
{
  "__global__": {
    "playlists": [ { "id": "playlist_…", "name": "…", "tracks": [...] } ],
    "lastGuildId": "…",
    "lastVoiceChannelId": "…"
  },
  "<guildId>": { "duckingEnabled": true, "baseVolume": 70, ... }
}
```

Playlists are **global**, shared across all servers. An automatic migration
(`_migratePerGuildPlaylists`) moves playlists inherited from per-server storage
into `__global__` on first startup.

### Cache and writing

The `Map` cache is authoritative while the process runs; the file is only a
projection of it. `_save()` **schedules** a write batched over 120 ms: a burst of
changes causes only one trip to disk.

`flush()` forces the immediate write. It is hooked onto `process.on('exit')`,
which also covers the `process.exit()` calls of restart and shutdown — those
paths do not go through `close()`.

### Reading without side effects

`getSettings()` returns `{ ...defaults, ...cache }`: the default values are
reapplied on every read, so that adding a key to `_defaults()` is enough for all
existing servers to inherit it.

This method **does not write** to disk for an unknown server — it used to, even
though it is called in a loop every second. The entry is simply cached; the first
real modification will persist it.

### Main methods

| Method | Effect |
|---|---|
| `getSettings(guildId)` | Settings merged with the default values |
| `updateSettings(guildId, patch)` | Merge and deferred save |
| `getGlobalPlaylists()` | List of the playlists |
| `createPlaylist`, `renamePlaylist`, `deletePlaylist`, `reorderPlaylists` | Playlist management |
| `addTrackToPlaylist`, `removeTrackFromPlaylist`, `movePlaylistTrack` | Track management |
| `toggleVoiceDetection`, `isVoiceDetectionDisabled` | Ducking exclusions |
| `setLastVoiceChannel`, `getLastVoiceChannel` | Last channel visited |
| `applyStartupChannel()` | Settles the opening channel — at startup only |

`updateSettings` applies one particular rule: setting a favourite channel
(`defaultVoiceChannelId`) removes it from all the other servers — there is only
one global favourite.

`applyStartupChannel()` is called once, at `ClientReady`. It writes the
favourite into the last channel visited on switch-on, and leaves it aside on
resume — a restart must bring you back where you were. Reading it elsewhere would
make
it a permanent preference, which would endlessly bring the bot and the dashboard
back to it — see
[Presence in voice channels](04-diffusion.md#presence-in-voice-channels).

---

## PlaybackStateManager

[`PlaybackStateManager.js`](../../../src/database/PlaybackStateManager.js) —
playback snapshot, to pick up where things were left off.

### Content saved

Per server, the state of **each channel** (`queue.channelStates`): current track,
position, queue, history, repeat mode, playing or paused.

### Rhythm

Every 5 seconds (timer in [`index.js`](../../../src/index.js)) and on every
notable event: start and end of a track, addition, empty queue, change of the
bot's voice state.

### Restoration

`restoreAll()` is called at `ClientReady`. It reconnects the bot, recreates the
tracks (`new Track(...)` with the extractor re-associated by its identifier),
then resumes playback **silently**:

```
restorePaused = true, volume = 0
        │
        ▼
  start playback
        │
        ▼
  playerStart → seek(saved position)
        │
        ▼
  restore the volume, apply the pause if necessary
```

Without this precaution, the user would hear the beginning of the track before
the jump to the right position.

### Fade out

`fadeOutAndSaveState()` brings the volume down in 35 steps following an
exponential curve before the final save. Called on `SIGINT` and on
`shutdownBot`, it avoids an abrupt cut. The elapsed time is added to
`virtualProgressMs` so that the saved position stays accurate.

---

## Storage of imports

[`uploadService.js`](../../../src/web/uploadService.js) — see also
[07 — Security](07-securite.md).

### Naming by fingerprint

Files are stored as `<fingerprint12>-<original name>`, where the fingerprint is
the 12-character prefix of the SHA-256 of the **content**. Reimporting a file
already present reuses the existing copy, with no additional copy.

This mechanism corrects an accumulation that had been observed: without it, the
same piece reimported produced as many copies as there were imports.

### Deferred naming

The transfer passes through `.incoming-<pid>-<timestamp>-<random>`, renamed only
once complete. An interrupted transfer therefore leaves no truncated media in the
library. Orphans from an abrupt stop are purged at startup by
`cleanIncomingUploads()`.

### Displayed name

`getCleanFilename()` from [`utils/paths.js`](../../../src/utils/paths.js) strips
the technical prefix. It handles both forms: the current fingerprint and the
timestamp of files imported before deduplication, still referenced by existing
playlists.
