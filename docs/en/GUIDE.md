# User guide — Interactive Music bot

This guide covers using the bot inside Discord as well as operating its web
dashboard.

For engineering documentation, see [docs/en/technique/](technique/README.md).

---

## Contents

- [Getting started](#getting-started)
- [Dashboard access](#dashboard-access)
- [Discord commands](#complete-discord-command-reference)
- [Web dashboard](#using-the-web-dashboard)
- [Typical scenarios](#typical-usage-scenarios)
- [FAQ](#frequently-asked-questions)

---

## Getting started

### 1. Starting the bot

The bot must be running on your machine to answer commands. On Windows, just
double-click `Start bot.vbs` at the root of the project.

So you never have to open that folder again, make yourself a shortcut once and
for all: double-click `Create shortcut.vbs` at the root of the project, pick the
location you want in the wizard, and the shortcut is installed there. A
double-click on it then starts the bot and opens the dashboard.

The bot starts **in the background**: no terminal window opens and nothing
appears in the taskbar. A small window shows you how the launch is going, ticks
off the steps as they complete, then disappears on its own as soon as the bot is
ready — the dashboard opens right afterwards in your browser. If something gets
stuck, the window stays up and tells you what to do: install Node.js, go through the
configuration again, or check the logs. The first launch takes longer
than the following ones: it installs the dependencies.

**On the very first launch**, that window starts nothing: it walks you through.
The bot needs its own Discord application, and nobody can create it for you — a
token designates one application, and does not get shared. Everything else is
taken care of:

- a button opens Discord's developer portal, where you create the application
  (*New Application*), then, in the *Bot* tab, click *Reset Token* and *Copy*;
- there is nothing to paste: as soon as the token is in your clipboard, the
  window recognises it, submits it to Discord, and shows the application's name
  back to you. The field stays there for the cases where that detection does
  not come through;
- the application id is **not** asked for — it is derived from the token. The
  `.env` file is written for you, without your having to open it;
- one last button invites the bot to your server, permissions already ticked.
  The bot boots meanwhile, without waiting for you to be done.

A token Discord turns down is reported there and then, with the reason — rather
than at the next launch, in the shape of a bot that stops without a word. And if
the stored token stops being accepted, because it was regenerated on the portal
since, the window offers to go through this configuration again.

**To stop the bot**, use the shutdown button on the dashboard: that is what
replaces closing the console. The restart button is available there too.

If the bot is already running when you launch it again, the small window says so
instead of starting a second one, and offers you on the spot to open the
dashboard, restart, or shut down. Opening the dashboard first checks that a tab
is not already connected to it, so as not to stack up one more; shutting down,
for its part, asks for confirmation.

On the command line, the equivalent of starting up is `npm start` from the
project folder — with, this time, a console and its live logs.

### 2. Joining a voice channel

Before calling on the bot, join one of the voice channels of your Discord
server. The bot requires your presence in a voice channel in order to connect to
it and broadcast audio streams there.

### 3. Playing an audio track

Enter the following slash command in any permitted text channel:

```
/play query:track name or URL
```

The bot then carries out the following operations:

1. Automatic connection to your current voice channel.
2. Search and retrieval of the track's metadata.
3. Initialisation of audio playback.
4. Posting of a summary card containing the title, author, duration and
   thumbnail of the track.

---

## Dashboard access

The dashboard is protected by an **access token**. Without it, the page shows
"Access denied".

### Signing in with Discord

On opening, a window asks you to sign in with your Discord account. It does not
close: the dashboard drives a bot that lives on your servers, and obeys nobody
who will not give a name.

Only your id, your name and your avatar are requested — neither your servers nor
your email address. Your account must also be a member of a server the bot is
in.

The **first account to sign in while presenting the token** becomes the owner of
the installation, once and for all. That is whoever started the bot: the token
is printed in their console, and the invitation link sent to listeners does not
carry it. The owner keeps every right; the others have only what the owner
grants them (see "Sharing control").

To hand the installation to another account, delete the `data/owner.json` file
and sign in again with the token.

If the Discord application is not configured — `DISCORD_CLIENT_SECRET` or
`PUBLIC_URL` missing — signing in is impossible: the window then says what is
left to fill in and lets you in with the token alone, as before. Nobody ends up
locked out of their own bot over a forgotten variable.

### Retrieving the token

It is created on first startup and offered to you in three ways:

- the bot **opens your browser automatically** at the right address, token
  included, five seconds after startup;
- the full address is printed in the console at startup, if the bot was launched
  from a terminal — the shortcut, for its part, starts without a console;
- the token is saved in the file `data/dashboard-token`.

Once the page has been opened with the token, it is remembered in a cookie:
subsequent visits need nothing further. The address is then cleaned up
automatically so the token does not show in the address bar.

To open the dashboard manually:

```
http://localhost:3000/?token=YOUR_TOKEN
```

### Access from another device

By default, the dashboard is reachable **only from the machine hosting the
bot**. To consult it from a phone or another computer on the local network, add
this line to the `.env` file, then restart:

```
HOST=0.0.0.0
```

The access token then protects access from the network. Do not make the
dashboard reachable from the Internet without additional protection.

### Playing files stored elsewhere

The bot only serves the browser files located inside its own folders. To listen
to a personal library, declare its folders in `.env`:

```
MEDIA_ROOTS=D:\Music;E:\Films
```

Without this declaration, playback from Discord works, but the browser player
will show an error for those files.

---

## Complete Discord command reference

### Playback and playlists

#### `/play`

Searches for a track or plays a specific file.

- **Text search**: `/play query:artist or track name` (searches YouTube by
  default).
- **Direct link**: `/play query:https://www.youtube.com/watch?v=...`
- **Local file**: `/play query:C:\music\track.mp3` (absolute path on the machine
  hosting the bot).

Supported platforms: **YouTube**, **Spotify**, **SoundCloud** and **Apple
Music**. For Spotify and Apple Music, the bot retrieves the metadata and plays
the audio equivalent from YouTube.

> Deezer and Qobuz are not supported, despite the presence of corresponding
> variables in the configuration file.

#### `/playlist`

Queues up every audio file in a local directory.

- Standard command: `/playlist path:C:\music\my_album`
- Shuffled playback: `/playlist path:C:\music\my_album shuffle:true`

Recognised formats: MP3, FLAC, WAV, OGG, M4A, OPUS, AAC, WMA.

---

### Playback control

| Command | Action |
|---|---|
| `/pause` | Pauses the current playback. |
| `/resume` | Resumes playback of the suspended track. |
| `/skip` | Moves on to the next track in the queue. |
| `/stop` | Stops the music and empties the queue. |
| `/nowplaying` | Shows the current track with a progress bar. |

---

### Queue

#### `/queue`

Shows the scheduled tracks. The list is paginated in groups of ten.

- First page: `/queue`
- Specific page: `/queue page:2`

Adding a track through `/play` during playback inserts it at the end of the
queue.

---

### Volume

#### `/volume`

Sets the overall sound level (0 to 100).

```
/volume level:60
```

This value serves as a **reference**. Ducking computes the attenuation by
applying a percentage to this base: with a volume of 70 and a ducking level of
20%, the music drops to 14 while people are speaking.

---

### Ducking — automatic attenuation

Ducking is the functional heart of the bot: it temporarily lowers the volume of
the music when users speak, then restores it after a period of silence.

| Command | Effect |
|---|---|
| `/ducking status` | Shows the state and all the server's parameters. |
| `/ducking toggle` | Enables or disables automatic attenuation. |
| `/ducking level percent:<0-100>` | Percentage of the volume kept while speaking. |
| `/ducking delay ms:<n>` | Silence delay before restoration. |
| `/ducking fade ms:<n>` | Duration of the transition between the two volumes. |

**Choosing a level** — `15` for a strong drop, `50` to halve the volume, `0` for
a complete cut while people are speaking.

**Choosing a delay** — `400` ms for a responsive return, `800` ms as standard,
`1500` ms for a gradual recovery. A sufficient delay avoids the pumping effect
caused by short breathing pauses in the middle of a sentence.

**Choosing a fade** — `100` ms for a clean transition, `200` ms as standard,
`500` ms for a very gentle effect.

---

### Broadcasting and private channels

The `/broadcast` command, **reserved for administrators**, changes the
destination channel:

- **Public mode (`everyone`)** — the music is broadcast in the shared voice
  channel. Everyone listens to the same stream and ducking applies.
- **Private mode (`personal`)** — the music is played **in your browser**, by
  the dashboard's player. The bot stays present in the voice channel without
  emitting any sound there. The bot can also create a temporary private voice
  channel, named `🎵 <your name>`, deleted automatically when you disconnect.

---

## Using the web dashboard

### General controls

- **Media control** — the central buttons suspend, resume or stop playback. The
  "next" button has a two-second lock against repeated clicking. A three-position
  selector lets you choose:
  - *Normal* — sequential playback of the queue;
  - *Restart history* — puts the already played tracks back into the queue and
    empties the history;
  - *Loop* — repeats the current track indefinitely.
- **Moving within the track** — click or drag the cursor on the progress bar.
- **Voice channel selector** — instantly switches the bot from one channel to
  another. Each channel keeps its own queue and history.
- **Favourite channel** — a channel can be marked as favourite (the star, in the
  selector); that is where the bot and the dashboard settle when you **switch the
  bot on**. Marking it moves nothing at the time and never holds you back during
  the session. A **restart**, however, does not recall it: it brings you back to
  the channel you were listening on, since the playback itself was never
  interrupted. There is only one, across all servers.

### Voice activity

The dedicated section shows the members connected to the selected channel. When
a member speaks, their profile lights up in real time. You can **exclude a member
from detection**: their voice will no longer attenuate the music, which is useful
for a noisy microphone or a permanent audio source.

### Playlists

The dashboard manages playlists **shared across all your servers**, organised in
tabs. You can create, rename, reorder and delete them, add tracks to them by
drag and drop, and set a playlist as the active playback source in place of the
queue.

A playlist that is playing sets the queue aside — it stays displayed, but
nothing leaves it for as long as the playlist lasts. **Once its last track has
finished, the queue takes over on its own** and moves on to its first title,
without asking you anything. Playback therefore only stops if the queue is
empty. Loop playback comes first: as long as it is active, the playlist restarts
from its first title and the queue keeps waiting its turn.

### Queue and history

- **Drag and drop** — rearrange the playing order by dragging tracks. You can
  also drag a track from the history, from a playlist or from the now-playing
  thumbnail.
- **Immediate playback** — the play icon on each item plays the title right
  away, with no new network request.
- **Removal and clearing** — take out a specific item or empty the queue or the
  history entirely.

### Add-field history

The add field remembers what you submit — the last twenty-five entries, an
already known one moving back to the top rather than being written a second
time. The panel opens when the field takes focus and narrows as you type; the
search looks at the whole entry rather than its beginning, so a link is found
again by the name of the track it carries.

- **Up and down arrows** — walk the list and carry the entry into the field.
  Going back above the first one restores what you were typing, set aside on the
  first move: a keystroke interrupted by an arrow is never lost.
- **Click** — picks an entry outright.
- **Cross** — drops an entry from the history.
- **Escape** — closes the panel and gives the field back what was typed in it.

Each row carries the track's image and its name rather than the address that was
typed: a link says nothing of what it holds. A local file's name replaces its
path, and the full address or path comes back on hover. Where there is no image
— a track not yet recognised, a source that provides none — a music note takes
the place, so that the names stay aligned.

Those images and names come from what the bot has resolved: an address just
pasted shows as itself, and fills in as soon as the track appears in the queue,
the history or a playlist.

This history **lives in the browser**, not on the bot: it belongs to the device
and the browser you are looking from, and two devices driving the same bot do
not share one. It replaces the list the browser offered on its own, which
ignored the dashboard theme and gave no way to forget an entry.

The destination menu beside the field remembers too, but elsewhere: its position
is kept **by the bot**, and per server, like the two import quality menus. So it
survives a page reload, a restart of the bot, and follows you to another device.

### File import

Drop an audio or video file onto the interface to add it to the queue, to a
playlist, or to play it immediately. The bot **detects duplicates**: a file
already imported is not stored a second time.

The maximum size is 1 GB by default, adjustable through `MAX_UPLOAD_MB`.

**Import quality** — two menus, below the add field, set the quality of media
retrieved from a remote source:

- **Audio**: bitrate of the cached file (320 down to 96 kbps);
- **Video**: definition of the displayed video stream (2160p down to 360p).

These settings do **not apply to local files**, which are imported as-is without
re-encoding. When you type a local path into the add field, both menus grey out
to signal this.

### Downloading

Every track can be downloaded in some thirty formats and qualities: MP3, M4A,
FLAC, WAV, OGG, OPUS, WEBM, as well as MP4 for video. The conversion is
performed on the fly.

**To the bot's disk** — the destination menu, to the right of the add field,
holds a fourth entry: "To `data/downloads/`". It sends nothing to the player —
it writes the file to the machine hosting the bot. Its label carries the
destination folder, which saves opening it to find out where the files land.

The folder button, at the right of that row of the menu, opens a browser of the
host machine — rather than a field to type a path into, that machine not
necessarily being the one you are looking from. On Windows the drives are
offered at the top of the window: without them, going up from a folder of `C:`
leads to `C:\` and never to `D:`. Two chips come before them: **Default
folder**, which returns to `data/downloads/`, and **Downloads**, which goes to
the system's download folder — the browser's own, usually the right destination
and four or five steps further down the tree. Both take the browser there rather
than confirming: you see what the folder holds, and can still go one level
deeper before confirming. The "Or enter a path" field stays there for the cases
the browser does not cover.

The folder is remembered **by the bot**, not by the browser: it is shared by all
your servers and all your devices. A path that does not exist, that is not a
folder, or that refuses to be written to is turned down at the moment of the
choice and the reason is shown — rather than failing the download later, far
from the decision that caused it.

A remote source is transcoded to the format of the **Format** menu, at the
bitrate of the **Audio** one — MP3, M4A, OGG, OPUS or WEBM; FLAC and WAV are
lossless and ignore that bitrate. This third menu only appears, sliding in
beside the other two, for this destination: the other three write no file at
all, and an extension would name nothing there. It offers audio formats only,
video having its own route — a track's download button.

The three menus do not bear on the same things, and whatever does not apply is
greyed out: the video definition for this destination, which writes sound only,
and the audio bitrate for FLAC and WAV, lossless, which keep everything they are
given. A line under the row says why, each time.

Lastly, what a source is made of is only discovered when encoding it. If the
requested format does not come through, the file is written as MP3 — the one
nothing refuses — and a notification says so, rather than returning a failure
where a file was possible. A file already on the bot's disk is copied as is, without
re-encoding: you asked to have it in your folder, not to lose quality on the
way. Two guarantees, finally: downloading a track again does not replace the
previous one — the new file is numbered — and an interrupted download leaves no
truncated file in the folder, the writing being done under a provisional name
renamed only once the transcoding has succeeded.

The operation runs in the background and reports through notifications: the
track has to be resolved first, then transcoded, which takes the time it takes.

### Video

When a track has an associated video, the dashboard can display it in the
background. Local audio files get a graphical visualiser.

### Loudness (LUFS)

Two tracks set to the same volume are not heard at the same level: a recent
master sits around −7 LUFS, a classical recording around −25. The volume slider
changes nothing, since it acts on both at once.

Right-clicking a track — in the queue, the history or a playlist — opens a menu
whose **Loudness** entry unfolds a control:

- **The slider** targets a loudness, in LUFS, not a volume. The value is shown
  above it and follows the slider in real time; the correction is heard while
  you move it, without restarting playback.
- **The mark on the rail** shows the file's measured loudness: with the slider
  on it, the track comes out exactly as it was recorded. The measurement is also
  spelled out below the rail.
- **The circular button** gives the track that original level back.
- **The gradient bar** shows what the correction costs the sound. Raising the
  level beyond the headroom the file leaves clips the peaks: the bar goes from
  green to red as the clipping worsens.

Measuring means reading the file from end to end, which only the bot can do. It
is therefore started when the track begins or when this menu opens, and never
recomputed afterwards. A remote track that has not been preloaded cannot be
measured: the control waits for its preload.

The **Mix crossfade** card carries a **Synchronize LUFS** switch, off by
default, and its own slider. Turned on, it brings every track to a single
target — each corrected according to its own measurement. Per-track settings are
not erased for all that: they are merely covered, and unticking the switch gives
them back as they were. Setting a track by hand while synchronization is on
turns it off, and only that track keeps the new value.

In personal broadcast, the correction is applied by the browser. Attenuation is
exact there, but a boost only has the headroom the main volume slider leaves:
asking for +6 dB while it is already at maximum will only deliver part of it. In
shared broadcast, where the bot mixes the sound itself, the correction is
applied in full.

### Speed and crossfading

- **Playback speed** — adjustable from 0.20× to 3.05×, in steps of 0.01.
- **DJ-style crossfading** — automatic fade between two tracks, with two
  variants: volume fade alone, or fade accompanied by a filter effect.
- **Fade in and fade out** — can be enabled separately, with adjustable
  duration.

### Preloading

Upcoming tracks are downloaded ahead of time in the background. A progress
indicator appears on each track. This makes startup instantaneous and playback
resistant to network dropouts. The number of preloaded tracks is adjustable for
the queue, the history and the playlists.

### Logs and statistics

A built-in terminal shows the bot's logs in real time, filterable by level
(info, warning, error, success, debug). A side panel presents memory usage,
uptime and network activity.

**Copying log lines**

| Gesture | Effect |
|---|---|
| Hovering a line | Brings up a copy button to its right |
| Clicking a line | Selects it |
| **Shift + click** on another | Selects the whole range between the two |
| **Ctrl + click** (Cmd on Mac) | Adds or removes a single line |
| **Ctrl + C** | Copies the selection |
| **Esc** | Cancels the selection |

As soon as a line is selected, a bar appears at the bottom of the window with
the number of lines and a **Copy** button. The button at the top of the window
copies **all the displayed lines** at once, active filters included — a hidden
level is never copied.

Selecting text with the mouse remains available: a drag that selects text is not
interpreted as a selection click.

### Maintenance

The power menu allows you to **restart** or **shut down** the bot from the
interface. Shutting down applies a fade-out and saves the playback state, which
will be restored at the next startup.

### Visual customisation

- **Styles** — *Glassmorphism* (translucent panels), *Neon Cyberpunk* (neon
  borders), *Minimalist* (plain flat colours), *Retro Synthwave* (warm
  gradients).
- **Light / dark mode** — every style adapts.
- **Languages** — French, English, Spanish, German.
- **Layout** — grab a panel by its title to move it: a dashed slot shows where it
  will land. Dropped on another panel, the two swap places; nothing else moves,
  and an empty space stays empty. The bottom-right corner resizes, Escape cancels
  the gesture in progress, and the padlock pins a panel in place. The layout can
  be saved.

These preferences are kept in your browser.

---

## Typical usage scenarios

### Co-operative online gaming

Moderate volume so as not to mask the game's cues, responsive ducking:

```
/volume level:50
/ducking level percent:20
/ducking delay ms:500
/ducking fade ms:150
```

### Work or revision session

Very discreet background music, fading almost entirely away during exchanges:

```
/volume level:30
/ducking level percent:5
/ducking delay ms:2000
/ducking fade ms:500
```

### Dedicated music listening

Priority to the musical signal, with a light attenuation so that interventions
stay audible:

```
/volume level:85
/ducking level percent:70
/ducking delay ms:300
/ducking fade ms:100
```

---

## Frequently asked questions

**Does the bot support Spotify links?**
Yes. The bot extracts the track's metadata and automatically searches for the
audio equivalent on YouTube. Filling in `SPOTIFY_CLIENT_ID` and
`SPOTIFY_CLIENT_SECRET` improves the reliability of the resolution.

**Why does the volume take time to come back up after a sentence?**
That is the restoration delay. It prevents the volume from rising during short
pauses in the middle of a sentence. Lower it with `/ducking delay ms:200` or
from the dashboard.

**Does ducking apply to my own voice as well?**
Yes, to every non-bot participant in the channel. You can, however, exclude a
specific member from detection from the dashboard.

**Can I listen to music alone without disturbing the server?**
Yes, in `personal` mode: the music is played in your browser and not in the
voice channel. The bot can also create a temporary private voice channel.

**Are the settings kept after a restart?**
Yes. Volume, ducking, broadcast mode and playlists are saved in local JSON files
(`data/settings.json`). The playback state is restored too: the bot picks the
interrupted track back up at its exact position. The dashboard's visual
preferences are kept in your browser.

**I have lost the dashboard token.**
It appears in `data/dashboard-token` and in the console at startup. You can also
impose one of your choosing through the `DASHBOARD_TOKEN` variable of the `.env`
file.

**The browser player shows an error on my local files.**
The bot only serves files located in its folders or in the directories declared
by `MEDIA_ROOTS`. See
[Playing files stored elsewhere](#playing-files-stored-elsewhere).

**The `data/` folder takes up a lot of space.**
`data/cache` contains the preloaded tracks. It is purged by relevance but has no
size ceiling: you can empty it safely with the bot stopped. `data/uploads`
contains your imports — deleting them will make the playlists that reference
them inoperative.
