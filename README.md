**English** · [Français](README.fr.md)

# Interactive Music Player

Discord music bot with **automatic volume lowering when someone speaks**
(*ducking*) and a **real-time web dashboard**.

The music drops as soon as someone starts talking in the voice channel, then
comes back up gradually once silence returns — no intervention, no noticeable
latency.

```
┌─────────────────────────────────────────────────────────────┐
│  ♪ Music at 70 %                                            │
│  ─────────────────────────────────────────────              │
│                    🗣  someone speaks                       │
│  ♪ Music at 14 %   ╲___________________╱   ← 200 ms fade    │
│                          800 ms of silence                  │
└─────────────────────────────────────────────────────────────┘
```

---

## At a glance

| | |
|---|---|
| **Configurable ducking** | Adjustable level, hold time and fade length; participants can be excluded |
| **Real-time dashboard** | Full control, drag-and-drop queue, playlists, logs, statistics |
| **Two broadcast modes** | In the voice channel, or in your own browser without disturbing the server |
| **Many sources** | YouTube, Spotify, SoundCloud, Apple Music, local files and folders |
| **Preloading** | Upcoming tracks are cached: instant start, resilient to network drops |
| **Resume after restart** | The bot picks up the interrupted track, at its exact position |
| **Speed and transitions** | 0.20× to 3.05×; crossfade between tracks, by volume or with an effect |
| **Loudness (LUFS)** | Loudness measured per track, adjustable to the decibel, and syncable to a common target |
| **No external dependency** | No database, no build step, no FFmpeg to install |

---

## Documentation

| For | Document |
|---|---|
| Using the bot and the dashboard | **[User guide](docs/en/GUIDE.md)** |
| Understanding or changing the code | **[Technical documentation](docs/en/technique/README.md)** |

The technical documentation covers the [architecture](docs/en/technique/01-architecture.md),
the [audio chain](docs/en/technique/02-lecture-audio.md),
[ducking](docs/en/technique/03-ducking.md), the
[broadcast modes](docs/en/technique/04-diffusion.md), the
[dashboard](docs/en/technique/05-tableau-de-bord.md),
[persistence](docs/en/technique/06-persistance.md),
[security](docs/en/technique/07-securite.md),
[logging](docs/en/technique/08-journalisation.md) and
[configuration](docs/en/technique/09-configuration.md).

---

## Desktop app *(Windows, Linux)*

The easiest way: **the installer**. It brings Node.js, the bot and its
dependencies — no prerequisites —, then the app walks you through the first
setup, keeps the bot in the notification area and opens the dashboard in its
own window. The dashboard is still reachable from any browser, as before.

Everything is attached to the [releases](https://github.com/WolfGang-PRoxa/interactive-music-player/releases):

| System | File |
|---|---|
| Windows 10 and 11 | `…_x64-setup.exe`, the installer |
| Linux (any distribution) | `…_amd64.AppImage`: make it executable, then run it |
| Debian, Ubuntu and derivatives | `…_amd64.deb`: `sudo apt install ./…_amd64.deb` |

Each file is built by the *Application de bureau* workflow, and
`SHA256SUMS.txt` lists its fingerprint. All the details are in
[desktop/README.md](desktop/README.md).

> **The installer is not signed.** Windows SmartScreen shows "Windows protected
> your PC" on first launch: click **More info**, then **Run anyway**. See
> [why](desktop/README.md#installing-the-windows-warning).

The rest of this document describes installing from source.

---

## Requirements

- **Node.js 22.12** or later (the LTS release is fine)
- A Discord account — the bot's application is created during setup, on the
  [developer portal](https://discord.com/developers/applications), and the
  first launch takes you there

FFmpeg and yt-dlp come with the npm dependencies: nothing to install on the
system.

---

## Installation

### 1. Get the project

```bash
git clone https://github.com/WolfGang-PRoxa/interactive-music-player
cd interactive-music-player
```

On Windows, the dependencies are installed on first launch by the startup
window; there is nothing else to do here.

### 2. Create the Discord bot

**On Windows, let it guide you**: double-click `Start bot.vbs`, at the root of
the project. On first launch, the window that opens starts nothing — it walks
you through the setup, and takes care of everything below.

Two steps are left to you: create the application on the portal, which the
button opens for you (**New Application**, then the **Bot** tab → **Reset
Token** → **Copy**), and click *Invite*. The copied token is picked up without
you having to paste it, the application ID is derived from it, `.env` is
written, the dependencies installed, the commands registered, and the invite
URL assembled with the right scopes and permissions.

The same window is then used at every launch, and offers to redo this setup if
Discord ever rejects the saved token.

<details>
<summary>By hand, or outside Windows</summary>

Start with `npm install`, then:

1. On the [developer portal](https://discord.com/developers/applications),
   create an application (**New Application**).
2. Note the **Application ID** → variable `DISCORD_CLIENT_ID`.
3. **Bot** tab → **Reset Token** → variable `DISCORD_TOKEN`. This token is
   confidential.
4. Invite the bot through **OAuth2 → URL Generator**, ticking the `bot` and
   `applications.commands` scopes, then the permissions:
   *View Channels*, *Connect*, *Speak*, *Manage Channels*, *Move Members*.

Then create the configuration file:

```bash
cp .env.example .env      # copy .env.example .env on Windows
```

The minimum to fill in:

```env
DISCORD_TOKEN=your_token
DISCORD_CLIENT_ID=your_application_id
```

And finally:

```bash
npm run deploy    # once, then whenever a command changes
npm start
```

</details>

> **No privileged intent is required.** The bot only uses `Guilds`,
> `GuildVoiceStates` and `GuildMessages`, none of which is privileged. There is
> no need to enable *Presence*, *Server Members* or *Message Content*.

### 3. Going further with configuration

Everything else is optional and set in `.env`. See the
[full variable reference](docs/en/technique/09-configuration.md#environment-variables)
for the port, network exposure, local music folders and logging.

Setting `GUILD_ID` in `.env` makes the commands available immediately on that
server; without it, deployment is global and can take up to an hour.

### 4. The shortcut *(Windows, optional)*

To keep the bot at hand outside the project folder, double-click
**`Create shortcut.vbs`** instead, at the root of the project. A wizard opens:
choose the location — desktop, Start menu or any folder on your PC — and the
shortcut is placed there. An option also starts the bot every time you sign in
to Windows.

The bot starts **without any terminal window**: nothing opens on screen,
nothing shows in the taskbar. A small window follows the startup step by step —
Node.js, configuration, installing the dependencies on first use, startup,
dashboard — then closes by itself as soon as the bot is ready. If a step fails,
it stays open with the reason, an excerpt of the log and the button that gets
you unstuck.

Since the bot now runs without a console, you **stop it from the dashboard**
(power button), and its logs are read in the dedicated tab or in `data/logs/`.

### 5. Open the dashboard

The browser opens automatically five seconds after startup. The dashboard is
protected by an **access token**, saved in `data/dashboard-token` — and shown
in the console when the bot was started from a terminal:

```
http://localhost:3000/?token=YOUR_TOKEN
```

By default, it only listens on the local machine. To reach it from a phone or
another computer, see [Dashboard access](docs/en/GUIDE.md#dashboard-access).

---

## Updating

**Desktop app**: download the installer of the new version from the
[releases](https://github.com/WolfGang-PRoxa/interactive-music-player/releases)
page and install it over the old one. `.env`, playlists, settings and logs are
kept: an update replaces the bot's code and the runtime, never the data.

**From source**:

```bash
git pull
npm install
npm run deploy    # only if slash commands changed
```

The dashboard can also switch between published versions, from the versions
menu. If YouTube suddenly refuses to play, `npm run update-ytdlp` updates
yt-dlp without waiting for a new version of the bot.

---

## Where the data lives

| What | From source | Desktop app |
|---|---|---|
| Configuration (`.env`) | project root | `%LOCALAPPDATA%\com.wolfgangproxa.interactive-music-player\bot\` |
| Settings, playback state, playlists, dashboard token | `data/` | `bot\data\` |
| Logs | `data/logs/` | `bot\data\logs\` |
| Versions downloaded from the dashboard | `versions/` | `bot\versions\` |

On Linux, the desktop app's folder is
`~/.local/share/com.wolfgangproxa.interactive-music-player/`. None of this is
versioned, and nothing leaves the machine.

---

## Commands

| Command | Action |
|---|---|
| `/play query:<search, URL or path>` | Plays or queues a track |
| `/playlist path:<folder> [shuffle]` | Loads a whole local folder |
| `/queue [page]` | Shows the queue |
| `/pause` `/resume` `/skip` `/stop` | Playback control |
| `/nowplaying` | Current track and progress |
| `/volume level:<0-100>` | Reference volume |
| `/ducking toggle\|level\|delay\|fade\|status` | Ducking settings |
| `/broadcast mode:<everyone\|personal>` | Broadcast mode *(administrator)* |

Details and examples in the [user guide](docs/en/GUIDE.md#complete-discord-command-reference).

---

## Structure

```
src/
├── index.js          Entry point: Discord client, player, clean shutdown
├── config.js         Constants and default values
├── audio/            Ducking, volume, player events, preloading
├── broadcast/        Broadcast modes, personal channels
├── commands/         Slash commands
├── database/         Settings and playback state
├── utils/            Logging, atomic JSON, paths, durations
└── web/              HTTP + WebSocket server, API, dashboard

tools/                Windows shortcut: graphical wizard and launcher
data/                 Created at runtime, not versioned
docs/<language>/      User guide and technical documentation (fr, en, es, de)

Create shortcut.vbs   Opens the wizard (Windows)
Start bot.vbs         Starts the bot without a console (Windows)
```

Detailed tree and dependency map:
[01 — Architecture](docs/en/technique/01-architecture.md#directory-tree).

---

## Development

| Command | Effect |
|---|---|
| `npm install` | Installs the dependencies (FFmpeg and yt-dlp included) |
| `npm start` | Starts the bot |
| `npm run dev` | Starts with a restart on every file change |
| `npm run deploy` | Registers the slash commands with Discord |
| `npm test` | Runs all the automated tests |
| `npm run check` | Checks formatting (Prettier) and code (ESLint) |
| `npm run format` | Formats the whole project with Prettier |
| `npm run lint` | Runs ESLint alone |
| `npm run update-ytdlp` | Updates yt-dlp |
| `Start bot.vbs` | *(Windows)* Starts the bot without a console, by double-click |
| `Create shortcut.vbs` | *(Windows)* Wizard that creates the launch shortcut |
| `tools/start-bot.vbs` | *(Windows)* The shortcut's target: starts without a console |

Continuous integration runs `npm run check` and `npm test` on every push. The
last stage of the smoke test starts the real bot: it needs a `DISCORD_TOKEN` in
`.env` and reports itself as skipped without one.

The desktop app has its own [Building](desktop/README.md#building) section.
The version history is in [CHANGELOG.md](CHANGELOG.md).

---

## Troubleshooting

**The commands don't show up on Discord**
Check that `npm run deploy` was run and that the bot was invited with the
`applications.commands` scope. Without `GUILD_ID`, global propagation can take
an hour.

**The bot doesn't join the voice channel**
Check the *Connect* and *Speak* permissions on the channel, and that you are
connected to it yourself when you run the command.

**Ducking doesn't react**
A track must be playing — ducking is set up when a track starts, not on
connection. Then check `/ducking status`, and that the participant isn't
excluded from detection in the dashboard. See the
[diagnosis guide](docs/en/technique/03-ducking.md#diagnosis).

**The browser player refuses my local files**
Only files from the bot's folders or declared in `MEDIA_ROOTS` are served. See
[Security — path restriction](docs/en/technique/07-securite.md#path-restriction).

---

## License and terms

The code is released under the **[MIT](LICENSE)** license.

The bot is **self-hosted**: everyone creates their own Discord application and
runs their own instance, on their own machine. No data goes back to the author —
no telemetry, no statistics, no central server. No audio is recorded: ducking
only reads the "so-and-so is speaking" event, never what is said.

| Document | English | Français |
|---|---|---|
| Terms of service | **[TERMS.md](TERMS.md)** | **[CONDITIONS.md](CONDITIONS.md)** |
| Privacy policy | **[PRIVACY.md](PRIVACY.md)** | **[CONFIDENTIALITE.md](CONFIDENTIALITE.md)** |
