# 02 — Audio playback

[← Contents](README.md)

This page covers the chain that goes from a user request to the Opus stream
emitted in the voice channel, as well as the preload cache.

---

## Processing chain

```
request ──► extractor ──► stream ──► FFmpeg ──► Opus ──► Discord UDP
            (resolution)  (HTTP     (filters,  (encoding)
                           or        volume)
                           file)
```

The project does not manipulate the audio itself: it configures
[discord-player](https://discord-player.js.org/), which orchestrates FFmpeg and
`@discordjs/voice`. The FFmpeg binary comes from the `ffmpeg-static` package,
which avoids any system-wide installation.

---

## Extractors

Registered at startup in [`index.js`](../../../src/index.js):

| Extractor | Source | Note |
|---|---|---|
| `YoutubeiExtractor` | YouTube | Configured with `useYoutubeDL: false` |
| `SpotifyExtractor` | Spotify | Metadata only, audio taken from YouTube |
| `SoundCloudExtractor` | SoundCloud | |
| `AppleMusicExtractor` | Apple Music | Metadata only |
| `AttachmentExtractor` | Local files and attachments | Used for imports |

> **Deezer and Qobuz are not supported**, despite the variables present in
> `.env.example`. No corresponding extractor is installed or registered. Those
> variables are a leftover.

### Resolving a request

`searchLocalAwareTrack()` in
[`handlerUtils.js`](../../../src/web/websocket/handlerUtils.js) wraps the
search:

1. If the request points to an existing file → search forced to
   `QueryType.FILE`.
2. `music.youtube.com` URLs are rewritten to `www.youtube.com`, not resolved
   otherwise by the extractor.
3. If there is no result and the URL is of the YouTube kind, fall back to
   **yt-dlp** (`youtube-dl-exec`) in `flatPlaylist` mode, then resolve track by
   track. This path covers YouTube Music albums (`OLAK5uy_…`).
4. For a local file, the title is replaced by the file name stripped of its
   technical prefix.

---

## Playback speed

FFmpeg limits the `atempo` filter to the range `[0.5, 2.0]`. To cover 0.20× to
3.05×, [`index.js`](../../../src/index.js) registers 286 filters named
`speed_<value>` by chaining two `atempo` calls outside that range:

```js
if speed < 0.5   →  atempo=0.5,atempo=(v / 0.5)
if speed > 2.0   →  atempo=2.0,atempo=(v / 2.0)
otherwise        →  atempo=v
```

The filter's name encodes the value with an underscore: `1.25` becomes
`speed_1_25`. The chosen speed is persisted in the settings (`playbackSpeed`)
and **reapplied on every `playerStart`**, because FFmpeg filters are reset with
each new track.

An additional filter, `muffled` (`lowpass=f=400`), serves the DJ-style
transitions.

---

## Fades and crossfades

Three distinct mechanisms act on the volume, all through
[`VolumeController`](../../../src/audio/VolumeController.js) when it is
available.

### Fade in

Triggered in `playerStart` if `fadeinEnabled` or `mixEnabled` is active. The
volume starts from 0 and reaches `baseVolume` over `fadeinDuration` seconds. The
`queue.mixAppliedTrackId` lock avoids applying the fade twice to the same track.

### Fade out

Applied on stop (`shutdownBot`) and on process shutdown, by
`fadeOutAndSaveState()` in
[`PlaybackStateManager.js`](../../../src/database/PlaybackStateManager.js): 35
steps, exponential curve (`factor^2.5`) for a decay perceived as linear.

### DJ-style crossfade

In personal broadcasting, the crossfade is carried out by the browser, which has
two `<audio>` elements and can therefore overlap them.

In shared broadcasting, it is the **mixing bus** that takes care of it (see the
following section). When the time remaining on the track drops below
`mixDuration` seconds, the next piece is poured into the bus on top of the
current one:

- `mixType: 'volume'` → the two gains cross over according to a constant-power
  law;
- `mixType: 'effects'` → **plus** a low-pass sweep, which closes the outgoing
  piece down towards 400 Hz while the incoming one opens up.

---

## Mixing bus (shared broadcasting)

A Discord voice connection only carries one stream: two pieces cannot be
overlapped on it if the second can only exist by replacing the audio resource of
the first. That is why the mix crossfade was long refused in shared
broadcasting.

[`src/audio/mix/`](../../../src/audio/mix/) lifts this limit by interposing a
single, permanent stream between the pieces and Discord:

```
track A ──► FFmpeg ──► PCM ──┐
                             ├──► MixBus ──► AudioResource ──► Opus ──► UDP
track B ──► FFmpeg ──► PCM ──┘   (sum,       (permanent)
 (during the transition)          gains)
```

| Module | Role |
|---|---|
| [`format.js`](../../../src/audio/mix/format.js) | Exchange format: PCM s16le, 48 kHz, stereo, 20 ms frames |
| [`input.js`](../../../src/audio/mix/input.js) | Reduces a track to an FFmpeg input (cache, local file, extractor) |
| [`MixSource.js`](../../../src/audio/mix/MixSource.js) | One decoded piece: buffer, gain envelope, filter sweep |
| [`MixBus.js`](../../../src/audio/mix/MixBus.js) | The permanent stream: sums the sources frame by frame |
| [`MixEngine.js`](../../../src/audio/mix/MixEngine.js) | Per-server orchestration, steering of the discord-player queue |
| [`playerBridge.js`](../../../src/audio/mix/playerBridge.js) | Wraps the methods of `GuildQueuePlayerNode` to route them to the bus |

**Clock.** The bus only produces a frame when the voice player asks for one,
that is every 20 ms. All the sources therefore advance by the same exact number
of samples on each turn: no drift can set in between two overlapped pieces,
whatever the length of the crossfade. If a source runs short of data, the bus
stops entirely rather than filling one of them in with silence — a hitch costs a
blank, never a shift.

**Transparency.** Outside a crossfade, with a single source at full gain and a
nominal volume, the decoded bytes are passed on without any arithmetic at all:
the broadcast sound is exactly what FFmpeg produced.

**Playback position.** The bus makes its frames as soon as it is asked for them,
and the Opus encoder keeps some in hand: what is made is not what is heard.
`MixEngine.positionMs()` therefore subtracts that lead, measured by comparing
the frames made against `AudioResource.playbackDuration`, which only counts the
packets actually emitted. Without this correction, the progress bar leapt at
startup — the chain fills with several seconds in an instant — then marked time
while playback caught up.

**Division of roles.** discord-player keeps the queue, the history, the repeat
modes and its events. The engine signals the end of a piece to it by emitting on
its dispatcher the same signals that the end of a resource would have produced,
and presents it with a permanent `AudioResource` that `queue.currentTrack` goes
on consulting. Everything that used to go through discord-player's FFmpeg chain
is, on the other hand, taken over by the bus: volume and ducking (master gain),
pause, repositioning, playback speed, and the playback position — now counted in
emitted samples rather than estimated.

**Fallback.** `activeEngine()` returns `null` when no bus is mounted, and each
wrapped method then falls back onto the original implementation. Personal
broadcasting, where the sound comes out of the browser, never mounts a bus.

---

## Preloading

[`PreloadManager`](../../../src/audio/PreloadManager.js) downloads and
transcodes remote tracks to MP3 in `data/cache/` ahead of time, for three
reasons: instantaneous startup, resistance to network dropouts, and feeding the
browser's audio player in personal mode.

### Interception

At initialisation, the `stream()` method of every registered extractor is
replaced:

```js
extractor.stream = async (track, ...args) => {
    const cachedPath = this.getCachedPath(track);
    if (cachedPath) return fs.createReadStream(cachedPath);
    return originalStream.apply(extractor, [track, ...args]);
};
```

Any playback of a track already in cache is therefore served from disk, with no
network request, transparently for discord-player.

### Naming and validity

The key is the **SHA-256 of the track's URL**, and the file is
`data/cache/<key>.<bitrate>.mp3` (`<key>.mp3` for files predating the quality
choice, whose bitrate is unknown). A file smaller than 10 KB is considered
incomplete and ignored. Local files are never cached (`getTrackKey()` returns
`null`).

A download in progress writes to `<key>.<bitrate>.tmp`, accompanied by
`<key>.<bitrate>.tmp.src` which records the URL actually encoded. The file is
only renamed to `.mp3` once complete and validated.

### Selecting the targets

`getActivePreloadTracks()` builds the list to preload:

| Source | Quantity (adjustable, max 5) |
|---|---|
| Current track | always |
| Next tracks in the queue | `preloading.queueCount` (default 3) |
| Start of the queue set aside by a playlist | `preloading.queueCount` (default 3) |
| Recent tracks from the history | `preloading.historyCount` (default 3) |
| Rest of the active playlist | `preloading.playlistCount` (default 3) |
| Start of **each** saved playlist | `preloading.playlistCount` (default 3) |

The player has only one physical list of tracks: when a playlist occupies it,
that is what `session.getTracks()` returns, and the user's queue is set aside in
the settings (see
[setAsideQueue](../../../src/utils/setAsideQueue.js)). Preloading therefore goes
looking for it there, without which it would lose its cache as soon as a
playlist starts. It is a plain list, the same in both broadcast modes and the
same as the one shown by the panel: the `queueCount` window therefore bears
exactly on the titles announced.

The history is returned from the most recent track to the oldest — the order of
a LIFO queue, and that of the panel. It is therefore its **first** titles that
must be kept: the only ones a step backwards will reach.

The last two lines add up, they do not exclude each other: preloading a playlist
does not depend on what is playing. Starting a playlist must not empty the cache
of the others — rejoining them would then cost a full reload, and playback would
start on a break. The current playlist is evaluated first: it is its upcoming
titles that must be at hand before anything else.

Duplicates between these sources have no effect: `update()` indexes the targets
by track key before acting.

### Update cycle

`update(guildId)` is called on every state broadcast. It:

1. compares the list of targets with the previous one and exits immediately if
   it is identical — that is what makes the call bearable at one-second
   intervals. Except if one of the targets is neither in cache nor being
   downloaded: a network failure or an interrupted transcode would otherwise
   leave it missing until the next reshuffling of the queue, that is to say
   never on a stable queue. The retry respects a delay that doubles on each
   failure (30 s, then 1 min… capped at 15 min), so that a dead URL is not
   picked up again every second;
2. cancels the downloads that have gone off-target, except those started less
   than 5 seconds ago (protection against premature cancellations);
3. deletes the cache files that are targets for **no** server, as well as the
   partial files that have become useless (track off-target, or track now
   entirely cached);
4. starts the missing downloads.

Progress is reported to the dashboard by the `preloadManager.onProgress`
callback, limited to one send every 150 ms.

**When nothing arrives from the network.** The source may refuse the connection:
ffmpeg then writes no bytes at all, and the resulting file does not clear the
10 KB threshold. The failure is announced for what it is — the refusal and its
HTTP code — and not as a corrupted file: the disk has nothing to do with it, and
saying so saves looking on the cache side. On a YouTube track, a 403 almost
always signals a stale yt-dlp, which `npm run update-ytdlp` brings up to date:
the URLs YouTube hands out are bound to the client that requested them, and its
rules change faster than the binary shipped with the package.

### Resuming after a restart

Partial files used to be deleted at startup: a preload interrupted at 95%
started again from scratch, and on long tracks a normal rhythm of restarts was
enough for them never to be cached at all. They are now kept and completed.

An MP3 is just a sequence of independent frames, each preceded by a 4-byte
header that carries its own length.
[`analyzePartial()`](../../../src/utils/mp3.js) walks through them to determine
up to which byte the file is sound — the last frame is almost always cut short,
the process having been killed mid-write — and what time position that byte
corresponds to.

`startDownload()` then truncates the partial on that frame boundary, launches
FFmpeg with `-ss <position>` **before** `-i` (on a direct URL, the beginning is
not even re-downloaded) and appends the result to the file. The join is exact to
the sample. Two options are necessary: `-id3v2_version 0` and `-write_xing 0`,
without which every encoded segment would open on an ID3 tag that would end up
in the middle of the file.

Two guard rails frame the resumption:

- **Source verified.** The key derives from the *requested* URL, not from the
  one that ended up being encoded: a Spotify title is bridged to YouTube, and
  nothing guarantees that the search lands on the same video again. The partial
  is only resumed if `.tmp.src` matches the resolved URL; otherwise it is
  re-encoded from scratch.
- **Completeness verified.** A stream that breaks lets FFmpeg finish cleanly on
  what it has received: the size of the file no longer says whether it is whole,
  since a resumed partial necessarily exceeds the minimum. The encoded duration
  is compared with the duration announced by the track (95% tolerance); below
  that, the file stays a partial instead of being promoted to cache.

A failure therefore keeps what has been encoded, for the next attempt. A
cancellation (track gone off-target), on the contrary, deletes the partial, just
as the purge removes its cache file.

### Size ceiling

Purging by relevance is not enough: it only removes tracks that are targets for
no server. With several bulky playlists, the set of targets can on its own
exceed any reasonable limit.

`enforceCacheLimit()` brings the cache back under `MAX_CACHE_MB` (2048 MB by
default) by evicting the **oldest files first**, with the exception of the
tracks currently playing — protected explicitly so as not to provoke an
immediate re-download.

The in-memory index `cacheIndex` (key → `{ size, mtime }`) makes it possible to
apply the ceiling without querying the file system again. It is rebuilt at
startup, then kept up to date on every completed download and every purge.

If the ceiling is exceeded while **all** the tracks are protected, a warning is
logged and nothing is deleted: better to exceed it temporarily than to cut off a
playback in progress.

---

## Loudness (LUFS)

LUFS (EBU R128) measures *perceived* loudness, not amplitude: two files at the
same LUFS are heard at the same level, whatever their dynamics. Three modules
share the subject, and the separation matters.

[`loudness.js`](../../../src/audio/loudness.js) only does the conversion: it
knows neither FFmpeg nor the audio path. A track carries a **measurement**
(`measured`, `peak`) and, possibly, a **target** (`target`); the gain in
decibels is their difference, bounded. Without a measurement the gain is zero —
a target alone means nothing, and correcting by guesswork would be worse than
doing nothing.

[`LoudnessAnalyzer`](../../../src/audio/LoudnessAnalyzer.js) produces the
measurement by running `ffmpeg -af loudnorm=print_format=json` on the file — the
preload cache if it exists, the disk file otherwise. One analysis at a time:
decoding for playback comes first. The result is written to the database and
never recomputed, a file's loudness not being subject to change. A remote source
that has not been preloaded is not analysed; downloading it just to measure it
would cost the price of a preload nobody asked for.

Applying it differs by audio path:

- **Mixing bus** — [`MixSource`](../../../src/audio/mix/MixSource.js) carries a
  `levelGain` separate from the fade envelope. Separate, because it can exceed 1
  where the envelope cannot, and because it describes something else: the
  envelope says where a fade stands, the level gain says how loud the track is
  heard. The two are multiplied per frame. A change is spread over ten frames
  (200 ms), without which every notch of the slider would be heard as a click.
- **Browser** —
  [`loudnessGain.js`](../../../src/web/public/js/loudnessGain.js) wraps the
  `volume` property of both `<audio>` elements. The rest of the dashboard goes
  on writing the *intended* volume — fade ramps, ducking, shutdown — and the
  wrapper lays down the product. An `<audio>` never exceeds volume 1:
  attenuation is exact, a boost only has the headroom the main slider leaves.

Synchronization is a **layer**, never a write. When `lufsSyncEnabled` is set,
`effectiveTarget()` returns the common target without touching the individual
ones, which stay in the database. That distinction, and it alone, is what allows
the option to be unticked and every track to be given back the setting it had.

---

## Local files

[`LocalFilePlayer`](../../../src/audio/LocalFilePlayer.js) provides the folder
scan used by the `/playlist` command: recursive traversal, filtering on
`config.supportedExtensions`, sorting by name, optional Fisher-Yates shuffle.

The recognised extensions are declared in
[`config.js`](../../../src/config.js): `supportedExtensions` for audio,
`supportedVideoExtensions` for video. These lists also serve the path security
guard rail ([07 — Security](07-securite.md)).
