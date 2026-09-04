# 03 — Ducking

[← Contents](README.md)

*Ducking* is the bot's central function: the music fades down as soon as someone
speaks, then comes back up after a silence.

---

## Principle

Discord passes speaking events to bots per voice channel. No signal analysis is
needed: `connection.receiver.speaking` emits `start` and `end` with the user's
identifier.

```
       speech detected                     silence
              │                               │
              ▼                               ▼
     ┌─────────────────┐              ┌─────────────────┐
     │ Set of speakers │              │ Set of speakers │
     │  empty → 1      │              │  1 → empty      │
     └────────┬────────┘              └────────┬────────┘
              │                                │
        cancel the restoration          wait `duckingDelay`
              │                                │
              ▼                                ▼
        duckDown(level, fade)            duckUp(fade)
```

Two classes share the work:

- [`DuckingManager`](../../../src/audio/DuckingManager.js) — *when* to attenuate;
- [`VolumeController`](../../../src/audio/VolumeController.js) — *how* to vary the volume.

One instance of each exists **per server**, stored in `client.duckingManagers`
(a `Map` indexed by `guildId`).

---

## DuckingManager

### Internal state

| Field | Role |
|---|---|
| `activeSpeakers` | `Set<userId>` of the people currently speaking |
| `_restoreTimer` | Timer for the deferred restoration |
| `_active` | Indicates whether the listeners are hooked up |
| `channelId` | Watched channel, for the exclusion list |

### Start of speech

```
_handleSpeakingStart(userId)
  ├─ activeSpeakers.add(userId)
  ├─ if ducking enabled AND user not excluded:
  │    ├─ cancel the pending restoration timer
  │    └─ if this is the FIRST non-excluded speaker:
  │         └─ volumeController.duckDown(duckingLevel, duckingFade)
  └─ rebroadcast the state to the dashboard
```

The "first non-excluded speaker" condition avoids restarting a fade every time a
new person starts speaking while the volume is already lowered.

### End of speech

```
_handleSpeakingEnd(userId)
  ├─ activeSpeakers.delete(userId)
  ├─ if ducking enabled AND no non-excluded speaker left:
  │    └─ schedule the restoration in `duckingDelay` ms
  └─ rebroadcast the state to the dashboard
```

The delay is a **debounce**. Without it, the volume would come back up during
breaths in the middle of a sentence, producing a pumping effect. When it fires, a
second check (`activeSpeakers.size === 0`) avoids a rise if someone has started
speaking again in the meantime.

### Per-user exclusions

`database.isVoiceDetectionDisabled(guildId, channelId, userId)` makes it possible
to ignore certain people. The list is stored **per channel** in the settings:

```json
"ignoredVoiceUsers": { "<channelId>": ["<userId>", "…"] }
```

An excluded user is indeed added to `activeSpeakers` — the dashboard shows them
as speaking — but is not counted by `_countActiveNonIgnored()` and therefore
triggers no attenuation.

The key is **the channel the dashboard is displaying**
(`ws.selectedVoiceChannelId`), and not the channel the bot happens to be in: it
is under that key that `getState()` reads the list back. The two coincide most of
the time, but not when the bot is connected nowhere — the switch was then filed
somewhere other than where it was read back, and returned to its original
position at the next state.

### Hot reconfiguration

`refresh()` is called after a change of settings:

- ducking disabled → immediate restoration of the volume, without a fade;
- ducking enabled and someone is speaking → immediate attenuation;
- ducking enabled and silence → immediate restoration.

`updateConnection()` handles the bot changing channel: the listeners are removed
from the old connection and hooked back up on the new one. Omitting this step
would leave ducking silently inoperative after a move.

### Lifetime of the listening

**Listening for speech belongs to the voice connection, not to playback.** It is
set up on the player's `connection` event — a single point of passage, whether
the connection comes from a command, from an import, from the dashboard or from
the presence rule — and is torn down along with it (`PresenceManager.detacher()`,
shutdown of the bot).

It used to be hooked to the start of a track, and torn down on `emptyQueue` in
the "everyone" mode alone. Two consequences: the dashboard stopped animating the
listeners as soon as the last track had finished even though the bot was still
there, and a connection established in personal broadcasting — where no track
starts on the bot's side, the sound coming out of the browser — stayed deaf.
Voice activity is now picked up in both modes, empty queue or not.

### Reporting to the dashboard

Every start and every end of speech emits a light `speakers` message
(`WebServer.broadcastSpeakers()`), on the model of `progress`: speech comes and
goes several times per second and per person, and answering it with a complete
state would re-serialise the queue, the history and the playlists every time. The
message carries only the list of speakers, and is addressed only to the
dashboards displaying the channel the bot is listening to.

This reporting was broken: the code called `WebServer.instance.broadcastState()`
whereas `require('../web/WebServer')` returns **the instance**, `instance` being
a static property set on the class — therefore always `undefined`. No
notification went out. The dashboard only learnt who was speaking at the next
state broadcast for some other reason, hence a "Voice activity" box that almost
never animated. In personal broadcasting, the consequence went further: ducking
there is applied **by the browser** on its own audio element (`clientDucking`, in
`app.js`), on the strength of `state.speakers`. Without these messages, no
attenuation was possible in that mode.

### Ghost speakers

Discord announces microphone changes, not departures: someone who leaves the
channel while speaking produces **no** "end of speech" at all. They then stayed
recorded in `activeSpeakers` forever — halo lit on the dashboard, and volume held
down for a silent channel.

Two cleanups answer this: `oublierLocuteur(userId)` on a user's departure
(`VoiceStateUpdate` listener), and `oublierLocuteurs()` when the connection
changes or the bot is moved — what a vanished connection had seen is worth
nothing any more.

---

## The connection's ear

Everything above assumes the voice connection can **receive**. That is not a
given: discord-player 7 no longer relies on `@discordjs/voice` but on
`discord-voip`, a playback-only fork whose connections have no `receiver` — the
`VoiceReceiver` symbol does not even exist there.

The project's manifest therefore asks for that name to be redirected to
`@discordjs/voice`, which has one. But npm still tucks a copy of its own under
discord-player's folder:

```
node_modules/
├── discord-voip/          ← the alias to @discordjs/voice, with a receiver
└── discord-player/
    └── node_modules/
        └── discord-voip/  ← the real discord-voip, without one
```

Since Node looks in the requester's own folder first, the second one wins, and
the `overrides` can do nothing about it: discord-player declares
`discord-voip: ^7.2.0`, a range `@discordjs/voice@0.19.2` does not satisfy, and
npm gives up silently — a regenerated lock comes back identical.

[`tools/keep-voice-receiver.js`](../../../tools/keep-voice-receiver.js), hooked
on `postinstall`, removes the nested copy after every install. Node then goes up
one level and finds the one that hears. The gesture has to be replayed every
time, including for the installs the bot triggers itself when changing version
([06 — Persistence](06-persistance.md)).

The failure, at least, is now loud. It was not: reading `receiver.speaking`
raised an exception that travelled up through `setupDucking`, taking the volume
controller and the silence player with it, and the log showed only a "Cannot
read properties of undefined" with no apparent bearing on sound. The
`DuckingManager` now checks for the ear before attaching to it, and says so.

---

## VolumeController

Wraps discord-player's `queue.node` to offer gradual transitions.

### The notion of base volume

`baseVolume` is the volume when nobody is speaking (0–100). `duckLevel` is a
**percentage of that volume**, not an absolute value:

```js
attenuatedVolume = round(baseVolume × duckLevel / 100)
```

With `baseVolume: 70` and `duckingLevel: 20`, the music drops to 14, not to 20.
That is what makes it possible to adjust the general volume without upsetting the
balance of the ducking.

### Fade

`_fadeTo(target, duration)` cuts the transition into steps of
`config.ducking.fadeStepInterval` (20 ms) and applies a linear increment. Two
shortcuts avoid pointless work: a null duration or a gap of less than 1 point are
applied immediately.

Any new fade cancels the previous one (`_cancelFade()`), so that a rapid
alternation of speech and silence does not let two contradictory timers coexist.

### Track changeover

`updateQueueNode()` must be called on every change of track: the audio node is
recreated by discord-player, and the old reference becomes inert. The method
reapplies the current volume — 0 if the queue is being restored or is in
transition, otherwise `targetVolume` or `baseVolume` depending on whether we are
attenuated or not.

The controller is also reused outside ducking, for fade-ins, fade-outs and DJ
crossfades, through direct calls to `_fadeTo()`.

---

## Settings

| Key | Default | Effect |
|---|---|---|
| `duckingEnabled` | `true` | Enables the attenuation |
| `duckingLevel` | `20` | Percentage of the base volume while speaking |
| `duckingDelay` | `800` | Milliseconds of silence before restoration |
| `duckingFade` | `200` | Duration of the fade, in milliseconds |
| `baseVolume` | `70` | Volume outside speech |

Modifiable through `/ducking …`, `/volume` or the dashboard. The default
constants live in [`config.js`](../../../src/config.js), the effective values in
`data/settings.json`.

---

## Diagnosis

`DEBUG`-level logs trace every step:

```
[Ducking Debug] Détection parole - Début pour l'utilisateur : 1234…
[Ducking Debug] Baisse du volume (duckDown) vers 20%
[Ducking Debug] Détection parole - Fin pour l'utilisateur : 1234…
[Ducking Debug] Restauration du volume planifiée dans 800ms
```

If ducking does not react, check in this order:

1. Is the bot connected to the channel? Without a voice connection, no
   `DuckingManager` is created.
2. Has `setupDucking()` been called? It is called on `playerStart`, not on
   connection.
3. Is the user in `ignoredVoiceUsers` for that channel?
4. Is the bot server-deafened? The queues are created with `selfDeaf: false`
   precisely so as to keep receiving voice.
