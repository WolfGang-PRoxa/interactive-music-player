**English** · [Français](README.fr.md)

# Desktop app

The bot, packaged as a Windows and Linux app: an installer, an icon in the
notification area, and the dashboard in its own window.

The bot stays what it is: a Node server. The app starts it, watches over it and
stops it, but the dashboard still opens in any browser — on this PC at
`http://localhost:3000`, or from a phone, another computer, a guest, exactly as
before.

---

## What it does

|                            |                                                                                                       |
| -------------------------- | ----------------------------------------------------------------------------------------------------- |
| **No prerequisites**       | Node.js is bundled; the installer brings the bot and all its dependencies                             |
| **Guided first setup**     | Pasting the token is enough: it is checked with Discord, `.env` is written, the invite prepared       |
| **Built-in dashboard**     | It opens in the app window once the bot is ready; _Open in browser_ stays one click away              |
| **Notification area**      | Closing the window stops nothing: the bot keeps running, the icon lets you reopen, restart, shut down |
| **Restart and versions**   | The dashboard's restart and version switch go through the app, which relaunches the right code        |
| **Start with the session** | A checkbox in the icon's menu: the bot starts in the background, with no window                       |
| **A single instance**      | Reopening the app shows the one already running                                                       |

Closing the startup window while nothing is running quits the app. _Quit_ from
the icon shuts the bot down gently — fade-out, playback state saved — before
closing.

---

## Installing: the Windows warning

The installer **is not signed**: a code-signing certificate costs several
hundred euros a year, which makes no sense for a free project. Windows
SmartScreen therefore shows, on first launch, "Windows protected your PC" and
an unknown publisher.

To install anyway: **More info**, then **Run anyway**. The browser may also ask
you to confirm the download (_Keep_).

On Linux, the AppImage only needs to be made executable (`chmod +x`, or
_Properties → Allow executing_). Depending on the distribution, the
notification area needs the _AppIndicator_ extension (GNOME) and the AppImage
the `libfuse2` library. The `.deb` package installs what is needed.

Each file is built by the public workflow
[`.github/workflows/desktop.yml`](../.github/workflows/desktop.yml), from the
code in this repository: every file attached to a release links back to the run
that produced it, in the _Actions_ tab.

---

## Where the files are

| What                                    | Where                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------- |
| The bot, its configuration and its data | `%LOCALAPPDATA%\com.wolfgangproxa.interactive-music-player\bot\`          |
| `.env`                                  | in that same `bot\` folder                                                |
| Playlists, settings, logs               | `bot\data\`                                                               |
| Bundled Node.js                         | `%LOCALAPPDATA%\com.wolfgangproxa.interactive-music-player\runtime\`      |
| App settings                            | `%LOCALAPPDATA%\com.wolfgangproxa.interactive-music-player\settings.json` |

On Linux, the same folder is `~/.local/share/com.wolfgangproxa.interactive-music-player/`.

An update of the app replaces the bot's code and the runtime, never `.env`,
`data\` or `versions\`.

### Keeping an existing install

A clone of the repository, with its `.env` and its `data/`, can be run as is:
in the wizard, _Use an existing install…_, then pick the folder that contains
`src` and `package.json`. The app then runs that folder with the machine's Node
if it has one — the one that installed its `node_modules` —, and installs the
dependencies if they are missing.

_Back to the app's folder_, at the bottom of the window, undoes this choice.

### A bot already running

If a bot already answers on the dashboard's port — started by `Start bot.vbs`,
for example —, the app attaches to it without starting a second one, and offers
to open it, restart it or shut it down.

---

## Building

The Windows installer is built on Windows, the AppImage and the `.deb` on
Ubuntu, by the workflow
[`.github/workflows/desktop.yml`](../.github/workflows/desktop.yml): on every
change to `desktop/` pushed to `main`, and on demand from the _Actions_ tab.
Pushing a `v*` tag, or running the workflow by hand with _release_ filled in
(`v0.0.1`…), also publishes the release, with the notes from
`.github/releases/<tag>.md` and a `SHA256SUMS.txt` file.

Locally, with Node 24 and Rust:

```bash
cd desktop
npm ci
npm run payload       # bundled Node + bot + dependencies → src-tauri/payload/
npm run build         # Windows: NSIS installer → src-tauri/target/release/bundle/nsis/
npm run build -- --bundles appimage,deb   # Linux → bundle/appimage/ and bundle/deb/
```

On Linux, Tauri first needs WebKitGTK and its neighbours: the exact list is in
the workflow's _Bibliothèques système_ step.

The payload is prepared on the target platform: npm downloads there the
binaries specific to each one (FFmpeg, yt-dlp, DAVE encryption).

### Developing

```bash
cd desktop
npm ci
npm run dev
```

Without a payload, the app runs the repository itself, with the machine's Node.
`IMP_BOT_ROOT` points to another bot folder.

---

## How it is built

```
desktop/
├── ui/                     Startup window: HTML and JS with no dependency
├── scripts/
│   └── build-payload.js    Prepares the archive bundled by the installer
└── src-tauri/
    ├── tauri.conf.json     Window, NSIS installer, resources
    └── src/
        ├── supervisor.rs   Bot lifecycle: preparation, launch, watch, shutdown
        ├── layout.rs       Which bot folder, which Node
        ├── payload.rs      Deploying the bundled archive
        ├── dashboard.rs    Dashboard port, address and commands
        ├── discord.rs      Token check, invite
        ├── env_file.rs     Reading and writing .env
        ├── tray.rs         Notification area icon and menu
        └── view.rs         The snapshot the startup window draws
```

The startup window decides nothing: the app sends it a full snapshot on every
change, and it sends back the ID of the clicked button. The dashboard, for its
part, is loaded from the bot's server and has no access to the app's commands.

### The contract with the bot

The app sets two variables in the bot's environment:

- `AUTO_OPEN_DASHBOARD=false` — the dashboard opens in the app, not in a tab;
- `IMP_SUPERVISOR=desktop` — to restart, the bot no longer starts a detached
  instance itself, which would escape the app. It drops the wanted entry point
  in `data/desktop-restart.json` and exits with code 75; the app relaunches that
  entry point with `IMP_RESTART=1`. See
  [`src/utils/supervisor.js`](../src/utils/supervisor.js).

The rest goes through what already existed for the PowerShell launcher: the
port that opens when the bot is ready, `/api/clients` for the dashboard's
address, and the WebSocket for `restartBot` and `shutdownBot`.
