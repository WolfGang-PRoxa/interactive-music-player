# 10 — Versions

[← Contents](README.md)

The bot can list the releases published on GitHub, install one alongside the one
that is running, and switch from one to the other without a single setting or
playlist moving. It all lives in
[`src/versioning/`](../../../src/versioning/), five modules and no added
dependency.

---

## Two roots

This is the idea everything else follows from. In development they coincide; as
soon as a release is installed, they part.

| Root | Contents | Value |
|---|---|---|
| **Shared** root | `.env`, `data/`, `node_modules/`, `versions/` | `process.cwd()` |
| **Install** root | the code being executed | the repository, or `versions/<tag>/` |

Every module of the bot resolves its data from `process.cwd()` — `Database`,
`auth`, `mediaPaths`, `uploadService`: it is the shared root that decides where
the playlists, the settings and the dashboard token are.

Changing version therefore comes down to running `versions/<tag>/src/index.js`
**while leaving `cwd` on the shared root**: the code changes, the data does not.

```
shared root/                     ← process.cwd(), and therefore the data
├── .env
├── data/                        settings, playlists, cache, logs
├── node_modules/                dependencies, seen by every version
├── src/                         the development repository — tag "dev"
└── versions/
    ├── v1.4.0/
    │   ├── .imp-version.json    integrity marker
    │   └── src/index.js         ← install root when this version runs
    └── v1.5.0/
```

Since Node walks up the parent folders looking for `node_modules`, a release
nested inside the shared root **inherits its dependencies along the way, without
a single copy**. Nothing is therefore installed as long as the release asks for
the same packages as the root; a local `npm install` only happens when the list
diverges, and it then stays confined to that version's folder.

[`locations.js`](../../../src/versioning/locations.js) is the only module that
knows all this, and the only one entitled to say whether a folder may be
overwritten or deleted. `assertTargetInstallable()` and
`assertTargetRemovable()` are the guard rails that put the development
repository — and the version currently running — out of reach of the installer
and of uninstallation alike.

`IMP_VERSIONS_DIR` allows `versions/` to be moved elsewhere, onto a secondary
disk or outside the repository. The guard rail still checks that it does not
overlap the development repository, whatever its value.

---

## Which version is running

`currentVersion()` returns `{ type, tag, packageVersion }`, where `type` is
either `dev` or `release`. It does not guess: it reads the `.imp-version.json`
marker dropped at the root of each installed version. The marker serves twice —
it names the version, and its absence signals an unfinished extraction.

The value is exposed in three ways: the log banner at startup, the
`GET /api/version` route, and the foot of the dashboard drawer — from where it
can be copied in one gesture.

---

## The catalogue

`catalog()` assembles what the drop-down menu shows: the published releases,
those already on disk, and the one that is running.

**A failed call to GitHub is not a fatal error.** It is reported in `error` and
the catalogue stays usable, reduced to the versions already present on disk.
Offline, one can therefore still go back to an installed version or to
development.

An installed version whose release has disappeared from the repository stays
launchable: it is marked `orphan` and appears in the list all the same. It is on
the disk, and the user must be able to go back to it.

[`github.js`](../../../src/versioning/github.js) queries the public API. A public
repository is consulted **without credentials**: that is the nominal mode, and
there is nothing to configure. A token is still accepted if found — in
`GITHUB_TOKEN`, then `GH_TOKEN`, then from the `gh` CLI if it is installed and
signed in —, which covers a still-private repository and raises the hourly quota
from 60 to 5,000 requests.

The releases cache only lasts twenty seconds, and the menu forces a re-read as
it opens: it must reflect the releases published at the moment the user pulls it
down, not those of their previous opening.

---

## Installing

Guiding rule: **nothing already in place is ever overwritten.** Each release
lives in its own `versions/<tag>/` folder, and an installation touches no other.

```
listReleases()  ──►  .tar.gz archive  ──►  .tmp-<random>/  ──►  versions/<tag>/
                     (300 MB at most)      extraction          final rename
                                                │
                                                └─ npm install, only if the
                                                   package list diverges
```

Three consequences of that rule:

- a version already installed is not downloaded again: it is simply relaunched,
  which puts the version currently running beyond its own reinstallation;
- the development repository is not a possible target — `locations` refuses it
  before the slightest write;
- extraction happens in a temporary folder, renamed to its final destination once
  complete. An interrupted download therefore never leaves a half-installed
  version, but a `.tmp-…` that the next startup sweeps away (`cleanTempDirs()`,
  called at `ClientReady`).

One installation at a time: two concurrent downloads would aim at the same
temporary folder and fight over the restart. The operation reports its progress
as it goes, so that the dashboard shows something other than a frozen screen.

### Extraction without a dependency

[`targz.js`](../../../src/versioning/targz.js) decompresses the archive in
memory in one go, then walks it 512-byte block by 512-byte block. That avoids
adding a library to the project, and above all avoids depending on a system
`tar` whose presence and dialect are guaranteed on no machine.

Two points deserve attention:

- **long names.** The ustar format houses a name in 100 bytes, topped up by a
  155-byte prefix. Beyond that, the archiver emits an entry carrying the real
  name just before the entry it describes: `L` for GNU, `x` (pax header) for the
  others. GitHub uses both depending on the repository, so both are handled;
- **path traversal.** An entry named `../../elsewhere` would escape the
  destination folder. Every path is therefore resolved and then checked as a
  strict descendant of the destination before the slightest write.

---

## Switching

`resolveEntryPoint(tag)` turns a user's choice into a file to launch, and
refuses a version that is not available locally.

The switch itself borrows the ordinary restart (`restartProcess` in
[`systemHandlers.js`](../../../src/web/websocket/handlers/systemHandlers.js)):
the new process is launched **detached**, with `IMP_RESTART=1` in its
environment, and the old one shuts down. That variable marks a resume rather
than a cold start — which removes the opening fade and makes the favourite
channel be ignored in favour of the last visited one (see
[06 — Persistence](06-persistance.md#database)).

The domain's three WebSocket messages — `listVersions`, `installVersion`,
`uninstallVersion` — are **reserved for the session master**. Changing the
running version is not a playback command one shares. See
[07 — Security](07-securite.md#shared-rights).

---

## When making changes

- Never resolve a data path from `__dirname`: that would be the install root, and
  an installed release would write its settings into its own folder instead of
  the shared root.
- Any write or deletion aimed at `versions/` must go through
  `assertTargetInstallable()` or `assertTargetRemovable()`.
- A new catalogue field must stay readable offline: the menu works without
  GitHub, and that is a property not to lose.
