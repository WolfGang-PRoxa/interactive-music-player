# 04 — Broadcast modes

[← Contents](README.md)

The bot has two radically different playback modes. Understanding the difference
between them is indispensable before touching the state code.

---

## The two modes

| | `everyone` (shared) | `personal` |
|---|---|---|
| Where the sound comes out | Discord voice channel | The user's browser |
| Who decodes | discord-player + FFmpeg | The dashboard's `<audio>` tag |
| Playback position | `queue.node.getTimestamp()` | Counter computed server-side |
| Ducking | Active | Not applicable |
| Current track | `queue.currentTrack` | `queue.virtualCurrentTrack` |
| Queue | `queue.tracks` | `queue.virtualTracks` |

The setting is `broadcastMode`, per server.

---

## Shared mode

The expected behaviour of a music bot: discord-player decodes the stream and
emits it into the voice channel. Everyone hears the same thing, ducking applies.

---

## One stream URL, one single file

In personal mode the browser fetches the sound from `/api/stream`, a URL that
carries nothing but the track identifier. That URL, however, can designate two
very different files: the MP3 from the preload cache, or the original file on
disk. The first does not exist yet while the preload is writing it, and
disappears later when the cache is tidied up.

A browser does not download a media file in one go: it asks for slices as
playback proceeds, on the same URL, over several minutes. Choosing the file per
request therefore lands a slice of MP3 in a WAV decode that started without it —
and that is heard neither as silence nor as an error, but as an **enormous white
noise**: compressed bytes read as raw samples are random noise, at full level.

The representation is therefore settled on the first byte served and served
unchanged to every slice of the **same load**, even if the cache has appeared in
the meantime.

What identifies a load is the URL's `load` parameter, set by the dashboard and
incremented on every start of playback — certainly not the requested position. A
range starting from zero looks like a fresh start, but it is also what a
**looping** track sends, and there the browser has forgotten nothing: it keeps
its bytes under that URL and its decoder open on the format recognised on the
first pass. Re-choosing at that moment is precisely what produced forty seconds
of noise and then silence, on the second loop of a track preloaded in between.
Since the URL changes with every load, the browser can never mix two forms under
one resource.

If the settled file disappears mid-playback, the request is refused with a 404
rather than served in the other format — the dashboard reloads the track at the
position reached, under a fresh URL, which costs a few hundred milliseconds of
silence instead of the noise. See [`api.js`](../../../src/web/routes/api.js) and
the test `tests/streamSource.js`.

---

## Personal mode: the virtual player

In personal mode, **the bot decodes no sound at all**. It keeps a fictitious
playback state up to date, and it is the browser that actually plays the audio
through `/api/stream`.

### Why a virtual player

The dashboard has to go on displaying a coherent track, progress, queue and
history. Rather than creating a second data model, the project replicates the
shape of the queue in properties prefixed with `virtual`.

### Advancing the position

Progress is not measured, it is **computed** by the web server's refresh loop,
every second:

```js
const elapsed = (now - queue.virtualLastUpdated) * speed;
queue.virtualProgressMs += elapsed;
queue.virtualLastUpdated = now;

if (queue.virtualProgressMs >= duration) handleVirtualSkip(queue, guildId);
```

The `speed` factor takes up `playbackSpeed`, so that the counter follows the
browser's sped-up or slowed-down playback. The client periodically sends back its
real position through the `syncProgress` message, which corrects the drift.

### End of track

`handleVirtualSkip()` in [`WebServer.js`](../../../src/web/WebServer.js)
reproduces the behaviour of a real player: handling of the repeat mode, pushing
onto `virtualHistory`, popping from `virtualTracks`, and synchronisation of
`playlistCurrentIndex` if a playlist is active.

### The silence emitter

Problem: without an audio stream, Discord closes the UDP connection after a few
seconds, and returning to shared mode would require a full reconnection.

Solution — `startSilencePlayer()` in [`index.js`](../../../src/index.js): a
`Readable` in `objectMode` emits an Opus silence frame every 20 ms.

```js
silenceStream.push(Buffer.from([0xF8, 0xFF, 0xFE]));  // Opus silence frame
```

`objectMode: true` is essential: without it, Node concatenates the frames into a
single block, which Discord rejects. The connection thus stays open and the bot
visible in the channel, without emitting any audible sound.

---

## Switching between modes

### Shared → personal

`BroadcastManager.setMode()`:

1. copies `currentTrack`, the position, the queue and the history into the
   `virtual*` properties;
2. empties `queue.tracks` and `queue.history` to stop the real playback;
3. terminates the `dispatcher` without disconnecting the bot;
4. starts the silence emitter.

### Personal → shared

The reverse operation is the trickiest in the project, because playback has to be
**picked back up at the exact position** the browser had reached.

```
transitioningToEveryone = true
transitionTrack         = track to resume
transitionTargetProgress = position in ms
        │
        ▼
  queue.play(track)  ── volume forced to 0
        │
        ▼
  'playerStart' event
        │
        ├─ wait 100 ms (let the stream establish itself)
        ├─ queue.node.seek(progress)
        ├─ remove the track from the history (the seek wrongly adds it there)
        ├─ remove the possible duplicate from the queue
        ├─ transitioningToEveryone = false
        └─ restore the volume (or fade in if configured)
```

The volume is held at 0 throughout the manoeuvre: without this, the user would
hear the beginning of the track before the jump to the right position. The
`restorePaused` and `transitioningToEveryone` flags are consulted by
[`VolumeController`](../../../src/audio/VolumeController.js) at construction and
on every change of node, so as not to bring the volume back up prematurely.

---

## Personal channels

Independently of the virtual player, `BroadcastManager` can create a temporary
private voice channel:

- name: the `config.broadcast.personalChannelPrefix` prefix (🎵) followed by the
  member's display name;
- permissions: `@everyone` denied, member and bot allowed;
- tracked in `personalChannels`: `Map<guildId, Map<userId, channelId>>`;
- automatic deletion when the member leaves the voice channel, through the
  `VoiceStateUpdate` listener of [`index.js`](../../../src/index.js).

> This tracking is **in memory only**. A restart of the bot while personal
> channels exist leaves them orphaned: they will have to be deleted by hand.

---

## The cost of the dual model

Every place that reads or writes state has to distinguish between the two modes.
The pattern repeats throughout the code:

```js
const currentTrack = isPersonal ? queue.virtualCurrentTrack : queue.currentTrack;
const tracks       = isPersonal ? queue.virtualTracks       : queue.tracks.toArray();
const isPlaying    = isPersonal ? !!queue.virtualIsPlaying  : queue.node.isPlaying();
```

`getChannelPlaybackState()` in [`WebServer.js`](../../../src/web/WebServer.js) is
its densest expression: a single `return` combines three axes (`isPersonal` ×
`transitioningToEveryone` × presence of a timestamp) in nested ternaries.

A single interface hiding the distinction — mentioned in
[01 — Architecture](01-architecture.md#playbacksession) — would remove this
pattern. Any modification of the state code should, at the very least, not make
it worse.

---

## State per voice channel

The bot remembers a playback snapshot **per channel**, in `queue.channelStates`:

```js
queue.channelStates[channelId] = {
    isPlaying, isPaused, repeatMode,
    currentTrack, currentProgress,
    queue: [...], history: [...],
    savedAt
};
```

Changing channel from the dashboard (`selectChannel`) saves the state of the
channel being left before restoring that of the channel being joined. The
dashboard can thus display a queue for a channel the bot is not connected to:
`getChannelPlaybackState()` then serves the cached data rather than the live
state.

In shared broadcasting, leaving a channel **suspends** playback there: the player
is paused before the switch — which silences the channel while waiting for
`queue.connect()` — and the snapshot is recorded as paused at its position. The
bot disconnects in every case: it follows the dashboard to the channel being
joined, or `detacher()` withdraws it if that one is deserted. Coming back later
to the channel that was left therefore finds the piece paused there, at the
second it was left at, and not a playback that would have run on with no
listener.

Entering the joined channel remains subject to the presence rule: the bot only
goes there if somebody is present. A deserted channel whose snapshot carries a
playback stays frozen, and the dashboard explains it (see below).

---

## Presence in voice channels

The bot only settles into a voice channel if there is someone there to hear it.
The rule is held by
[`PresenceManager`](../../../src/audio/PresenceManager.js), and holds for both
broadcast modes — in personal mode the connection only serves to pick up speech
for the ducking, but it has no more reason to exist in an empty room.

| Event | Effect |
|---|---|
| Startup, target channel deserted | No connection. Playback is restored then **frozen**. |
| First human entering the attached channel | Connection, ducking hooked back up, playback resumed at its position. |
| Last human leaving | Departure after `config.presence.departureDelay` (30 s by default). |
| Return before the delay elapses | Departure cancelled, nothing moves. |

The **attached channel** is, in order: the current attachment
(`queue.activeChannelId`), the channel the bot is in, the last channel used.
Three ways of saying "the one it was assigned", from the most recent to the
oldest: the bot therefore does not follow the listeners from channel to channel.
Failing any attachment at all (first use), it settles into the first channel
where somebody appears.

The **favourite channel does not figure there**, and that is deliberate: it only
counts at startup (see below). Consulted here, it applied on every voice movement
and every 30 seconds; as soon as the attachment was missing — queue created by
`/play`, by an import, or restored without a channel — it brought the bot back
home, and the first listener entering the favourite called it back there
whatever channel it had been installed in. A channel marked with a star thus
became a prison: no way to work lastingly anywhere else.

### The favourite channel: a startup value, and nothing else

The favourite (`defaultVoiceChannelId`) designates the channel that the bot and
the dashboard settle on when the process starts or restarts. It is read in two
places, both at startup:

- [`Database.appliquerSalonFavori()`](../../../src/database/Database.js), called
  once at `ClientReady`, makes it the **current channel** (`setLastVoiceChannel`);
- [`PlaybackStateManager.restoreAll()`](../../../src/database/PlaybackStateManager.js)
  gives it priority when choosing which channel to restore, then records that
  choice as the attachment — including when the channel is deserted and the
  connection is put off until later, without which the presence rule would go
  looking for the bot somewhere other than where the dashboard announces it as
  waiting.

Past that point, nobody reads it any more. Marking a channel with a star in the
middle of a session therefore moves nothing: the setting is noted for the next
startup. Everything else — presence rule, channel selector, `getState` — follows
only the current channel, which every change of channel updates.

### Frozen playback

Leaving does not mean losing everything. The queue, the history and the current
track stay in memory; only discord-player's player disappears along with the
voice connection, and with it the only thing it still knew: where playback had
got to. The session takes over for the duration of the absence:

```js
queue.absentSalonVide     // the bot withdrew, or never entered
queue.positionFigeeMs     // position read just before the departure
queue.lectureFigeeEnCours // was playback under way?
```

`session.estGelee()` is the test to run before querying `queue.node`: a
dismantled player only returns zeros. The dashboard, the state save and the
playback commands all go through it — `commanderFige()` applies pause, resume,
seek, stop, skip and previous directly to the frozen state, so that the dashboard
stays usable while the bot is away.

A connection point that gives up on connecting calls `marquerAbsent()`;
conversely, any voice connection lifts the freeze, whatever its origin (the
player's `connection` listener).

### Telling the dashboard

A frozen playback is still declared *under way* — it will start again by itself —
but nothing advances. Seen from the dashboard, that looked like a breakdown:
pause button, spinning cover art, and a progress bar that gained a second before
losing it again, indefinitely — the client interpolated locally while the server
sent back the same frozen position every second.

`session.attenteAuditeur()` returns what is needed to explain it, and `WebServer`
adds the name of the channel concerned. The dashboard then shows a banner above
the bar ("Nobody in 'X': playback is waiting…"), stops interpolating the position
and suspends the playback animations. The message distinguishes the two freezes:
a playback that will resume when someone arrives, and a paused playback, which
the bot's return will not restart.

### Two traps in discord-player

**Destroying the stream passes for the end of a track.** Destroying the
dispatcher puts the audio player into the *Idle* state, which discord-player
interprets as the end of the piece: it pushes the track into the history and
moves on to the next. The "transition" mode is therefore raised for the duration
of the destruction — `performFinish` abstains from any processing there.

**The default voice state handler destroys the queue.** `leaveOnEmpty` calls
`queue.delete()`, which carries off the queue, the history and the per-channel
state. Subscribing to `voiceStateUpdate` on the player disables that handler;
`PresenceManager` takes over the cases it handled usefully (server deafen,
conference channel, bot moved by a moderator). `leaveOnEmpty` has been set to
`false` everywhere, so that the code no longer promises a behaviour that no
longer holds.
