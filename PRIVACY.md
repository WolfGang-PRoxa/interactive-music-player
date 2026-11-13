# Privacy Policy

**Interactive Music Player**
Last updated: 13 November 2026

---

## 1. In short

- **The author of the Software collects no data.** No telemetry, no usage
  analytics, no crash reports sent anywhere. The only service the author runs
  is a sign-in relay that keeps nothing (see
  [section 3](#3-what-the-author-collects)).
- Every instance runs on the machine of the person who installed it. All data
  stays in that machine's `data/` folder.
- **No audio is ever recorded.** The bot knows *that* someone is speaking, never
  *what* they said.
- **No message content is read.** The *Message Content* privileged intent is not
  enabled.

---

## 2. Who is the data controller

The Software is **self-hosted**: no public instance is operated by the author
(see [Terms of Service, section 2](TERMS.md#2-distribution-model-self-hosting)).

| | |
|---|---|
| **Data controller** | The **operator** — the person or entity who installs the Software, creates the Discord application, and runs the instance |
| **The author's role** | Publisher of the source code. Neither controller nor processor: they have access to no instance and to no data |

To exercise a right over data held by a given instance, contact **that
instance's operator** — the person who invited the bot to the Discord server
concerned. The author has no technical means of reaching that data, of
correcting it, or of deleting it.

---

## 3. What the author collects

Nothing.

The Software sends no data to the author, in any form. It contains no tracker,
no analytics probe, and no crash-reporting service. The source code is public
and verifiable.

Available releases are listed through GitHub's public API (`api.github.com`).
That request goes to **GitHub**, not to the author, and carries no usage data:
GitHub sees the machine's IP address, exactly as it would for any visit to the
repository page.

### The sign-in relay

The only service operated by the author is the **OAuth return relay**,
`imp-auth.romainpiau.dev`, hosted on Cloudflare Workers. It is used only when a
guest signs in with their Discord account to a dashboard shared through a quick
tunnel (a `trycloudflare.com` address that changes at every launch): Discord
requires a fixed return address, and the relay stands in for it.

- **What it receives**: the guest's browser passes through it once, carrying
  Discord's authorisation code and the tunnel address the sign-in started from.
  It immediately sends the browser back to that address.
- **What it keeps**: nothing. No storage, no application log. The authorisation
  code is worthless without the Discord application's secret, which only the
  operator's bot holds.
- **What Cloudflare sees**: as with any web request, the host sees the browser's
  IP address and headers, under its
  [privacy policy](https://www.cloudflare.com/privacypolicy/).

An operator can do without it: with a fixed address (`PUBLIC_URL`, for example a
named tunnel on their own domain), with their own relay (`OAUTH_RELAY_URL`), or
by turning it off (`OAUTH_RELAY_URL=off`).

---

## 4. Data processed locally by an instance

This data is written to the `data/` folder on the operator's machine. It never
leaves that machine.

| File | Data | Purpose |
|---|---|---|
| `settings.json` | Discord server and channel IDs; per-server settings (volume, ducking, speed); IDs of members excluded from speech detection; playlists (titles, URLs, file paths) | Preserving settings and playlists between sessions |
| `playback_state.json` | Per server and per channel: current track, position, queue, history, repeat mode, playing or paused | Resuming playback at the exact position after a restart |
| `sessions.json` | Per signed-in guest: Discord user ID, username, display name, avatar URL, session creation date and last-activity date | Recognising a dashboard guest in order to apply the rights the session owner granted them |
| `dashboard-token` | The dashboard access token (`0600` permissions) | Protecting the dashboard |
| `logs/*.log` | Technical logs: playback events, errors, and depending on the configured level, server, channel and member IDs | Diagnostics |
| `cache/*` | Preloaded audio files for upcoming tracks | Instant start-up, resilience to network interruptions |
| `uploads/*` | Media files uploaded by dashboard users, stored as `<fingerprint>-<original name>` | Making uploads replayable |

None of this data is sold, rented, shared or transmitted to a third party by the
Software.

---

## 5. What the Software does not do

This deserves stating plainly, because a voice bot can reasonably cause concern.

**It does not record, store, transmit or analyse any audio.**

Automatic volume ducking relies on the `speaking` `start` and `end` events of
the Discord voice connection. Those events carry exactly one piece of
information: *this member ID started or stopped transmitting*. The Software
subscribes to no incoming audio stream. There is no path in the code by which a
voice could be captured, written to disk, or sent anywhere — this is verifiable
in [`src/audio/DuckingManager.js`](src/audio/DuckingManager.js).

**It reads the content of no message.** The *Message Content* privileged intent
is neither required nor enabled. The bot works with three non-privileged intents
only: `Guilds`, `GuildVoiceStates` and `GuildMessages`.

**It builds no member list.** The *Server Members* intent is not enabled.

**It tracks no presence status.** The *Presence* intent is not enabled.

**It profiles no one and makes no automated decisions** producing legal effects.

---

## 6. Data received from Discord

### Gateway intents

| Intent | Privileged | What it provides |
|---|---|---|
| `Guilds` | No | The list of servers and channels, to know where the bot may play |
| `GuildVoiceStates` | No | Who is connected to which voice channel, and speaking events |
| `GuildMessages` | No | Receiving commands, without access to message content |

### Guest OAuth2 sign-in

If the operator configures `DISCORD_CLIENT_SECRET`, the dashboard can offer
guests the option to sign in with their Discord account so that part of the
control may be delegated to them.

This sign-in requests the **`identify` scope only** — the bare minimum. It gives
access to the user ID, the username, the display name and the avatar. It gives
access to neither the email address, nor the servers, nor the messages, nor the
account's linked connections.

The Discord access token obtained is used once, to read that profile, then
discarded: it is never written to disk.

A guest declines this processing by not signing in; they retain whatever access
the dashboard's shared token allows.

---

## 7. Cookies

The dashboard sets two cookies, both strictly necessary for it to work. There
are no advertising cookies and no analytics cookies.

| Cookie | Contents | Lifetime | Role |
|---|---|---|---|
| `dashboard_token` | The access token | 1 year | Avoiding having to put the token back in the URL on every visit, and letting the browser load media and open the WebSocket |
| `dashboard_session` | A random session identifier | 30 days, sliding | Tying the browser tab to the guest's Discord identity |

Both are `httpOnly` and `sameSite=lax`: the page's JavaScript cannot read them,
and they are not sent with a request triggered from another site.

---

## 8. Retention

| Data | Retention |
|---|---|
| Guest sessions | 30 days without activity, then automatic deletion. Each request pushes the deadline back |
| Logs | The 20 most recent files by default, configurable via `LOG_RETENTION`. Older ones are deleted at start-up |
| Settings and playlists | Until deleted by the operator |
| Playback state | Continuously overwritten; only the last known state is kept |
| Audio cache | Until deleted by the operator |
| Uploaded files | Until deleted by the operator |

An operator deletes all data by removing the `data/` folder.

---

## 9. Recipients and third-party services

The Software transmits data to no third party for commercial purposes. It does
issue technical requests to the following services, each governed by its own
privacy policy:

| Service | What it receives | Policy |
|---|---|---|
| **Discord** | The bot's API calls and the OAuth2 round trip | [discord.com/privacy](https://discord.com/privacy) |
| **YouTube / Google** | Searches and stream requests, with the host machine's IP address | [policies.google.com/privacy](https://policies.google.com/privacy) |
| **Spotify** | Metadata requests, if credentials are configured | [spotify.com/legal/privacy-policy](https://www.spotify.com/legal/privacy-policy/) |
| **SoundCloud**, **Apple Music** | Metadata and stream requests | Respective policies |
| **GitHub** | Release listings, download of an update, and download of `cloudflared` | [GitHub Privacy Statement](https://docs.github.com/site-policy/privacy-policies/github-privacy-statement) |
| **Cloudflare** | If the operator shares their dashboard through a tunnel: all visitor traffic, encrypted up to Cloudflare's network; and the pass through the sign-in relay | [cloudflare.com/privacypolicy](https://www.cloudflare.com/privacypolicy/) |

These requests originate from the operator's machine. It is **their IP address**
that is exposed to those services, not that of the Discord server's members.

**Transfers outside the European Union.** These services may process requests
outside the EU, subject to their own safeguards. An operator concerned about
this can restrict the sources used — to local files, for instance.

---

## 10. Security

The protections in place are described in detail in the
[technical documentation](docs/en/technique/07-securite.md). In summary:

- The dashboard listens on `127.0.0.1` only by default; opening it to the
  network or sharing it through a Cloudflare tunnel is an explicit decision by
  the operator.
- Every HTTP request and every WebSocket connection is authenticated before
  reaching any route.
- Token comparison is constant-time, so the token cannot be recovered by timing
  the responses.
- Files served are restricted to a list of permitted roots, with symbolic links
  resolved: an arbitrary path on disk is refused.
- The dashboard token is written with `0600` permissions.

No measure makes a system impregnable. An instance's effective security depends
on the machine hosting it, the network it is exposed on, and the operator's
discretion with their tokens.

---

## 11. Your rights

The GDPR grants data subjects rights of access, rectification, erasure,
restriction, objection and portability.

These rights are exercised **with the operator of the instance** concerned, who
alone holds the data. In practice, on an instance:

- **Access and portability** — the data sits in readable JSON files in the
  `data/` folder;
- **Erasure** — deleting `data/sessions.json` signs out every guest; deleting
  the `data/` folder erases everything;
- **Objection** — a member can be excluded from speech detection from the
  dashboard; equally, simply not signing in via OAuth2 means no profile is
  stored;
- **Removing the bot** — a server administrator may remove the bot at any time,
  which ends all processing for that server.

The author of the Software can act on none of these requests: they have access
to no data. Requests reaching them can only be redirected.

Anyone who believes their rights have been disregarded may lodge a complaint
with their national supervisory authority — in France, the
[CNIL](https://www.cnil.fr).

---

## 12. Minors

The Software is intended for users meeting Discord's age requirements: at least
thirteen years of age, or the higher minimum age required locally. It does not
target children and knowingly collects no data concerning them.

---

## 13. Changes

This policy may be revised. The applicable version is the one published on the
repository's `main` branch, whose Git history serves as the change log. The date
at the top of the document marks the latest revision.

---

## 14. Contact

For a question about this policy or about how the Software works:
[the repository's GitHub issues](https://github.com/WolfGang-PRoxa/interactive-music-player/issues).

For a request concerning data held by an instance encountered on a Discord
server, contact the person who invited the bot to that server: they alone are
its operator, and they alone hold that data.

---

*[Version française](CONFIDENTIALITE.md) · [Terms of Service](TERMS.md)*
