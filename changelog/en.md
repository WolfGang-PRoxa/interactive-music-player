# Changelog

Every change to the bot, newest first. Each entry carries the date the change
was delivered.

<!--
    Format — read by src/web/changelog.js, displayed by js/changelog.js.

    ## YYYY-MM-DD — Release title
    An optional one-line summary.
    ### Added | Changed | Fixed | Removed | Security
    - One change per line.

    The six section words stay in English in every language: they are Keep a
    Changelog's structural keywords, which the parser recognises and the
    dashboard displays translated. Translating them here would mean keeping a
    lookup table per language, which the first synonym would put out of step.

    The changelog is written by hand in French and English. The dashboard's
    other languages fall back to English — see REFERENCE_LANG in
    src/web/changelog.js.
-->

## 2026-11-21 — Version 0.0.2: a cleaner desktop app that is yours again

### Fixed
- On the bot's own computer, the token is enough to be the owner, even once Discord sign-in is set up: the app no longer treats you as a guest, and Quit or Restart from the tray icon work again.
- External links in the dashboard (GitHub, Buy Me a Coffee, documentation, Discord portal) open in the browser instead of doing nothing in the app window.
- The app icon no longer sits on a black background, and the startup window shows that icon instead of a rough drawing. The beamed note is redrawn cleanly, with no stroke sticking out of the beam.

## 2026-11-14 — Configuration in the dashboard

The `.env` file can now be edited from the settings, without having to find it on disk.

### Added
- A “Bot configuration” section in the settings, for the owner only: Discord token and credentials, fixed address and named tunnel, local network access, port, music folders, limits and logs. It says when a restart is needed and offers one.
- The desktop app is now available for Linux too: an AppImage for any distribution, and a `.deb` package for Debian, Ubuntu and their derivatives.

### Fixed
- npm 12 blocked install scripts: ffmpeg and yt-dlp were no longer downloaded, and the bot could not play anything.
- Two tests failed on Windows, because of CRLF line endings and a temporary folder that could not be removed.

### Security
- Secrets are never sent back to the browser, and whatever can cut off access to the dashboard or open folders on the disk can only be changed from the bot's computer.

## 2026-11-13 — Ready for the first release

The last adjustments before publishing version 0.0.1.

### Changed
- Node.js 22.12 or above is now required, and checked at launch: it is the real minimum of the dependencies, which the documentation understated (Node 18).
- The privacy policy and the terms of service describe the sign-in relay and sharing through Cloudflare.
- The Windows installer is not signed: the documentation explains how to get past the SmartScreen warning.

### Security
- No npm security advisory left open: undici moves to 6.29.1 and 7.30.2, and reading local files uses a fixed file-type, which no longer loops on a malformed ASF file.

## 2026-11-12 — Sharing through Cloudflare

The dashboard is now shared through a Cloudflare tunnel, with no account to create and nothing to install yourself.

### Added
- “Reaching it from outside” downloads cloudflared by itself and opens a Cloudflare tunnel in one click: no account, no administrator rights.
- Anyone with a domain at Cloudflare can keep a fixed address, by filling in their tunnel's token (`CLOUDFLARE_TUNNEL_TOKEN`) and its address (`PUBLIC_URL`).
- A fixed return relay lets the Discord sign-in work with a sharing address that changes at every launch: its address is declared once in the Discord portal.
- Files over 64 MB are sent in pieces, to get past Cloudflare's 100 MB per-request cap without lowering the maximum accepted size; a dropped connection only resends the current piece.

### Changed
- The chosen sharing is remembered, and the tunnel reopens at the next launch.
- The rate limiter tells visitors apart behind the tunnel, instead of counting everyone as a single address.

### Removed
- Sharing through Tailscale Funnel, and the four steps it required.

## 2026-11-11 — The desktop app

The bot now installs as a Windows app, without losing anything of its dashboard in the browser.

### Added
- A Windows installer brings Node.js, the bot and its dependencies: nothing left to install by hand.
- The app walks through the first setup, starts the bot, and opens the dashboard in its own window once the bot is ready; it stays reachable from any browser, here or elsewhere.
- An icon in the notification area keeps the bot running with the window closed, and reopens, restarts or shuts it down, or starts it with Windows.
- An existing installation, with its configuration and playlists, can be taken over as it is by the app.

### Changed
- Under the app, a restart or a version switch from the dashboard is relaunched by the app itself, which keeps its hold on the bot.

## 2026-09-14 — The last advisory left standing

### Security
- The one npm advisory still open is now written down, reason included: `AttachmentExtractor` pins `file-type` 16.5.4, which loops forever on a malformed ASF file — and an infinite loop blocks the whole bot.

## 2026-09-13 — The security audit

Six holes closed, from reading the token out of the journal to walking the host's disk as a guest.

### Changed
- The technical documentation is back in step with the code: every figure re-checked, a hundred and nineteen commits of drift made up.
- Five comments named modules and methods that had since been renamed; they point at what exists again.
- The repository follows the name it took on GitHub, hyphens included.

### Security
- The dashboard token no longer appears in the journal, and the journal is no longer handed to every socket: a guest with no right at all could read the token there, then present it.
- The `/api` routes now ask what the caller may do, not only who it is: a guest with no right could walk the host's filesystem and divert its download folder.
- A stolen sign-in is worth nothing to whoever stole it: the OAuth round trip is bound to the browser that began it.
- The bot no longer knocks on doors inside its own network: an address added to the queue can no longer name an internal machine.
- Taking over the installation means standing at the machine again: the token now travels in the address bar and is no longer proof of presence.
- The play handler no longer explores the host's disk on behalf of a guest who only holds the right to add to the queue.

## 2026-09-12 — A quieter header

### Added
- A long press on the GitHub button opens three more gestures: star the project, share it, report a problem.
- A playlist's header says what it holds: how many tracks, and for how long.

### Changed
- The play button in "Now playing" has taken the background, border and hover of its three neighbours; only its size still sets it apart.

### Fixed
- The tooltip of the button that copies a notification is no longer painted underneath the notification.

## 2026-09-10 — Between night and day

### Added
- A long press on the day/night button opens a slider: 0 % at night, 100 % in daylight, and everything in between. The whole dashboard follows.

## 2026-09-09 — What the controls announce

### Added
- The voice activity box shows a cut microphone when detection is off, instead of suggesting nobody is speaking.
- A click on the version number, in the drawer footer, copies it.

### Changed
- The layout outline and the general lock announce their gesture on hover.
- The three preload sliders gain a last notch that no longer counts: "everything".

### Fixed
- Granting a guest a right works: the switch no longer jumps and comes straight back.
- The queue's preload slider no longer governs the playing playlist as well.

## 2026-09-08 — Transitions, slices and sharing

A playlist can now send playback elsewhere, and remote files are asked for in slices instead of being served at playback speed.

### Added
- A playlist can carry a transition: at the chosen spot, playback switches to another playlist or to the pending queue.
- A right click on a transition changes its destination, with no need to delete it and lay it down again.
- The pending queue has a stored list of its own, one per voice channel.
- The callback URL to declare with Discord can be copied from the sharing window.

### Changed
- On the mouse as under a finger, what follows the cursor during a drag is a real element of the page, not the system's washed-out thumbnail.
- The fallback artwork of a file without an image is served by the bot, no longer borrowed from Wikimedia.
- The two loudness figures open, on click, the setting they describe.
- The button that copies an address names which one, and takes a line of its own.
- The invite names the channel it goes to, and its address can be copied.
- The sharing window's three gestures are the size of the link send, two sections below.
- The send confirmation plays in three overlapping beats instead of switching all at once.
- The language menu's flags have rounded corners, edging included.

### Fixed
- The quality asked for in the import box is the one actually fetched, not whatever stream came first.
- A portrait video is measured by its short side — 1080 × 1920 is 1080p — and the bitrate cached is the one really obtained.
- An assertion left behind the code, and a file that had no business in the repository.
- Preloading takes the original soundtrack and a stream, never an HLS manifest ffmpeg cannot open.
- Preloading asks for the file in slices: thirteen minutes for a twenty-five-minute track was the playback speed the source imposed.
- Downloads to disk go through the same slices.
- The browser receives a stream it can read, not a playlist of one.
- A transition's destination shows as soon as it changes, without waiting for a page reload.
- A transition reached with the mix on carries into its destination, not into a dead stream.
- The destination picks up where the cross-fade already took it, instead of starting over.
- The bot opens the dashboard at the address where the session lives: the Discord sign-in is no longer asked for at every launch.
- The green of the send confirmation is deep enough for its white label to be read.
- A settings group closes itself, and no longer only opens.
- The language menu shows drawn flags, where Windows only ever displayed two letters.

### Removed
- A draft script left at the root of the repository.

## 2026-09-07 — The way out

Publishing the dashboard took four steps nothing announced; each is now named before it is reached.

### Added
- The sharing window reads the machine's state — Tailscale installed, machine signed in, tunnel mounted — instead of leaving the address to be copied by hand.
- Publishing the dashboard goes one step at a time, each announced before it is reached.
- The host sees who is knocking, instead of letting the guest vanish without a trace.
- The import box offers video formats, and makes a black picture when the source carries none.
- The resolution can be chosen, and the made picture obeys it.

### Changed
- The Discord account can be changed from the settings, now that signing in only happens once.
- The account section says what a dashboard opened from afar cannot hand over.
- Each sharing step names what has just been done, instead of offering to "check again".
- Being let in and being given rights are two different things; and the host no longer appears in the guest list.
- The quality menu offers only the definitions and bitrates the source actually holds.

### Fixed
- The OAuth configuration trace — the callback URL to declare, the warning when `PUBLIC_URL` is missing — is finally called at startup.
- One account holds a session on several machines at once, without either closing the other in a loop.

## 2026-09-06 — What the sound was not saying

### Added
- The loudness of the playing file appears beside the volume: two tracks at the same setting are not heard at the same level.
- The two loudness indicators name the track they describe, cover art included.

### Changed
- The queue, the history and a playlist's tracks end in a fade rather than cut short, and their last row no longer merges with the edge.
- The player says why the sound is waiting, instead of failing into silence.
- The silence is explained until the browser trusts the dashboard's address.

### Fixed
- The journal no longer announces a departure delay nobody changed.
- A loudness tooltip held open follows the change of track, instead of naming the previous one.

## 2026-09-05 — The ear and the door

### Added
- The dashboard asks to sign in with Discord: the token proved one was at the machine, never who one was.
- The share button plays, on hover, the handing over of control to someone who is not there yet.

### Fixed
- The bot can hear speech again: automatic ducking had been dead since discord-player 7 went in, and nothing said so.
- Changing server from the dashboard elects a pilot, and the journal no longer claims otherwise.
- The favourite channel is recalled when the bot is switched on, not at every restart.

## 2026-09-04 — Levelling the levels

### Added
- Every track gets a loudness to aim for, and a switch aligns them all: fifteen decibels separate a recent master from a classical recording.

### Changed
- The add field's history reads by cover and name, not by the address that was typed.

### Fixed
- Each of a card title's three controls answers to its own hover, and the lock has become a button.
- The speed pad's bounce plays only when the value really had to move.
- The pad's slide starts where the value was, not where the old scale left it.
- One stream address names one file: a loop can no longer mix two formats and return white noise.

## 2026-09-03 — First launch, and the disk

Installing the bot took a terminal and a text editor; the launcher takes care of it.

### Added
- The first launch goes through Discord, instead of pointing at a `.env` file whose format nobody explains.
- A fourth destination for the add field writes the track to the bot's own disk, without going through the player.
- The disk destination chooses its container: MP3, M4A, FLAC, WAV, OGG, OPUS, WEBM.
- The add field keeps a history of its own, in the theme's colours, instead of leaving it to the browser.
- The system's download folder is one click away in the folder picker.

### Changed
- The bot's default folder joins the other shortcuts, as a chip, where one chooses a folder rather than at the bottom where one confirms.
- The picker's confirm button is centred, and given a footer to stand on.
- The bot remembers where the add field sends, server by server.

### Fixed
- Pausing no longer loses up to a second of the track, and playback resumes where it stopped.
- The progress bar stops where it was, instead of dropping back by a fraction of a second.
- The rule that narrows the folder picker's footer finally applies.
- The picker's confirm button takes the width of its footer, not a fixed one.
- The particle trail follows the chosen destination, and leaves the page when the file goes to the disk.
- The format list is no longer clipped to a single row, and each menu says what it applies to.

## 2026-08-29 — The public texts, and the missing gestures

### Added
- The terms of service and privacy policy Discord asks for at verification, drawn from the code rather than from a template.
- The import box says what it accepts: a link, a search, or a path on the bot's machine.
- A notification is swept away with a finger, and carries a button to dismiss it.
- The header buttons come to life on hover, each announcing what it does.

### Changed
- The dashboard's seven windows all close the same two ways: the Escape key, and a click beside them.
- The drawers respect the four edges of the handset, cutout included.
- The transition icon is filled rather than stroked: it was one per cent of ink short of the colour of its hundred and fifteen neighbours.

### Fixed
- The button that empties the queue empties the one on screen, not the one waiting behind a playlist.
- A track is hydrated before being streamed: the dashboard no longer receives silence with a 200.
- The play button starts the source when the player is empty, instead of announcing there is nothing to play.
- Personal broadcast survives a phone that is not looking.

### Removed
- The manual test list of the identifier conversion, drawn up for a migration long since finished.

## 2026-08-28 — Video under a finger

Twenty changes around the picture and the touch screen, three of them successive walls of iOS fullscreen.

### Added
- On a touch screen the floating windows — the video, the log terminal — become drawers: neither the grab by the header nor the corner handle exists under a finger.
- Previous, play and next appear large in the centre of the picture.
- The browser's own errors go to the bot's journal: on a phone an exception otherwise stays in a console nobody will open.
- The dashboard can be installed on the phone's home screen, the only way to lose the browser's bars there.
- The dashboard reports whether it was launched from the home screen.
- The system's fullscreen, the only one iOS grants, is offered to the video.

### Changed
- The video controls fade in the drawer too, and not only in fullscreen.
- A tap on the picture puts the controls away as much as it calls them back.
- The picture is lifted above the control bar, which takes a quarter of the height on a phone held upright.
- The controls that fade in have lost their frosted glass: a layer whose opacity is animating offers nothing settled to sample.
- The video controls stay while a control is in hand.
- The seek pill is laid on the picture, and the disc at its centre.
- The seek pills move clear of the transport buttons, which take more than half the width on a phone held upright.
- The video controls have three seconds before they fade, instead of a second and a half.
- The fullscreen actually granted is asked of the device, instead of being assumed from memory.
- The system's fullscreen is kept for real videos only: the visualiser came back from it as a black screen.

### Fixed
- Personal broadcast plays without a voice connection: one early return blocked everything, away from home.
- The cover art is loaded with the sharing header it needs, so the canvas stays usable.
- The double tap is read from the touch events and not from the clicks: seeking ten seconds back works once the controls have faded too.

### Removed
- The system's fullscreen is withdrawn: in personal broadcast the sound does not come from the video, and three successive walls made it untenable.

## 2026-08-27 — The code in English

### Added
- The playing track appears on the device's lock screen, cover art included.

### Changed
- The code is written in English: 342 identifiers renamed across JS, CSS, HTML and npm scripts, and 570 log lines translated.

### Fixed
- The speed pad sends the value the finger chose, and the ribbon follows it.

## 2026-08-26 — Documentation in its own language

### Added
- The embedded documentation is translated into English, Spanish and German, and reads in the dashboard's language.

### Fixed
- The speed pad and the cover art stay painted on a phone.
- A refused connection is named as such, with its cure: preloading failed for fifteen minutes on a verdict about the disk, for a file that had never left the network.

## 2026-08-25 — The dashboard on a phone

### Changed
- The dashboard and its documentation are usable on a phone, and a guest's sign-in no longer depends on the member cache — which starts empty at every restart.

## 2026-08-22 — Touch retouches

### Fixed
- Adjustments to the documentation window on a phone.

## 2026-08-19 — Shared control

The dashboard had no notion of who was acting: one shared token, in a cookie, granting everything to anyone holding it.

### Added
- The identity and permission layer, server side: one right per gesture, re-read at every message, closed by default on what it does not know.
- The sharing window and the guest dashboard, laid on that layer.
- The documentation window gains a vertical reading mode, beside its two-page spread.
- A setting shows the layout grid under the cards.

### Changed
- The code's French identifiers turn English, in six batches — the WebSocket protocol with them.

### Fixed
- The documentation's MD/HTML button tooltip follows the change of language.

## 2026-08-17 — First fixes

### Fixed
- The favourite voice channel is stored and found again at startup, and the queue's chaining is fixed.
- The particle trails are rebuilt, and adding as well as removing a Discord server works from the dashboard.

## 2026-08-16 — First version

### Added
- Audio playback in a Discord voice channel, automatic volume ducking when someone speaks, and a web dashboard to drive it all.
