# 07 — Security

[← Contents](README.md)

The bot exposes a web server that drives playback, reads files from disk and can
stop the process. This page describes the protections in place and the threat
model adopted.

---

## Threat model

The bot is designed to run on its owner's machine. The dashboard has **no**
account management: a single token grants access to everything.

What is covered:

- access from another machine on the local network;
- reading arbitrary files from disk through the media routes;
- memory or disk exhaustion by a single request;
- stopping the process by an unauthenticated third party.

What is not:

- privilege separation between several dashboard users;
- direct exposure on the Internet — put the bot behind a reverse proxy with TLS
  if necessary;
- protection against a malicious legitimate user.

---

## Authentication

[`auth.js`](../../../src/web/auth.js) protects **both HTTP and WebSocket**.

### The token opens, it does not name

The token is single and shared: holding it proves one is at the machine, never
who one is. Since the bot acts on servers populated by real people, it has no
reason to obey an anonymous caller.

Rights are therefore attached to a **Discord session**, never to the token. A
request presenting the token without a session gets access to the page — the one
carrying the sign-in window has to be served — and nothing else: `identify()`
returns `master: false` and raises `pendingLogin`, which the dashboard turns
into a window that does not close
([`loginGate.js`](../../../src/web/public/js/loginGate.js)).

The owner is the first account back from Discord **while presenting the token**
([`owner.js`](../../../src/web/owner.js)). That is not a shortcut: the token is
printed in the console of whoever started the bot, and the invitation link
posted to listeners does not carry it. The claim happens once — a second account
does not dispossess the first, otherwise the latest arrival would take over and
sharing control would no longer exist.

The token is established on the way out, at `/auth/discord`, and the answer
travels in the OAuth `state`. This is necessary: the dashboard opens on
`127.0.0.1`, where its cookie lives, while Discord redirects to `PUBLIC_URL` — a
tunnel, a domain name, a local network address. Two hosts, two cookie jars, and
a callback that has no token. The `state` is random, kept server-side and
consumed once: putting that fact in it exposes nothing.

One exception, and one only: an installation whose Discord application is not
configured *cannot* receive a sign-in. The token resumes its former role there.
Refusing would lock the installer out of their own bot over a secret missing
from a file, which protects nobody.

The consequence shows in the fallbacks: a socket arriving without an identity is
treated as a guest with no rights, never as the master. While the token made the
master, that fallback was harmless; it would now open everything to an accident.

### Origin of the token

`DASHBOARD_TOKEN` if it is defined, otherwise a 32-byte token generated on first
startup and saved in `data/dashboard-token` (permissions `0600`). It is also
printed in the console at startup.

### Why a cookie

The dashboard loads its media through `<audio src>`, `<video src>` and download
links. **Those elements cannot carry an `Authorization` header.** The cookie is
therefore the only vector that works for all the cases.

It has one further advantage: the browser also passes it during the same-origin
WebSocket handshake, which protects the WebSocket without any change to the
client code.

### Journey

```
GET /?token=<token>
   │
   ├─ valid token → sets the cookie (httpOnly, sameSite=lax, 1 year)
   │                then redirects to the URL without the parameter
   │
   └─ token absent or invalid → 401 + explanation page
```

Removing the token from the URL prevents it from lingering in the address bar,
the history or the `Referer` header.

Three sources are accepted, in order: the `token` parameter, the
`dashboard_token` cookie, the `Authorization: Bearer` header.

The comparison uses `crypto.timingSafeEqual`, so as not to reveal the token byte
by byte through measurement of the response time.

### Placement of the middleware

`auth.middleware` is mounted **before** `express.static`. The dashboard's files
are therefore protected on the same footing as the `/api` routes. The WebSocket
is filtered by the `verifyClient` option of `ws`.

---

## Path restriction

[`utils/mediaPaths.js`](../../../src/utils/mediaPaths.js) decides which files may
be served.

### The problem solved

The `/api/stream` and `/api/download` routes accepted a raw path from the client
and served it if it existed:

```js
if (fs.existsSync(decodedUrl)) {
    track = { url: decodedUrl, queryType: 'file', ... };
}
```

A request `?trackUrl=…/.env` therefore returned the Discord token. All file
reading now goes through `resolveMediaPath()`.

### The three conditions

A path is only accepted if it meets **all** the conditions:

1. **known media extension** — taken from `supportedExtensions` and
   `supportedVideoExtensions` in [`config.js`](../../../src/config.js);
2. **actual existence**, resolved by `fs.realpathSync` — which neutralises
   symbolic links pointing outside the perimeter;
3. **location under an allowed root**.

Also rejected outright are paths containing a null byte (which truncates the path
at the level of the system calls) and remote URLs.

### Allowed roots

| Root | Origin |
|---|---|
| `data/uploads` | Imported files |
| `data/cache` | Preloading |
| `MEDIA_ROOTS` | Local libraries, separated by `;` or `,` |

Without `MEDIA_ROOTS`, a file played from `D:\Music` will be **refused for
streaming**. This is a deliberate hardening: widening the perimeter is an
explicit decision of the operator.

The comparison is case-insensitive on Windows.

### Defence in depth

The guard rail is applied at two levels: at the resolution of the requested
track, then before the actual reading of the file — including for a track coming
from the queue. A track whose path is outside the perimeter produces a `403`,
never a read.

### Writing, by contrast, is not confined

[`utils/downloadDir.js`](../../../src/utils/downloadDir.js) keeps the folder the
fourth destination of the add box writes its files to, and it has no allowed
roots. The asymmetry is deliberate, and worth stating rather than being put up
with:

- **`mediaPaths` protects reading.** The risk there is serving the client a file
  it has no business seeing — hence a closed perimeter, and `.env` out of reach.
- **The download folder is a target.** The risk is no longer disclosing but
  writing somewhere it should not. And confining it under an allowed root would
  amount to removing the feature: someone who keeps their music in `D:\Music`
  wants to download it there.

What carries the safety is therefore elsewhere. The chosen path is validated
before being kept — it exists, it is a directory, it accepts writing, it holds
no null byte — the file name is derived from the track title rather than
supplied by the client, and the writing goes through a provisional name renamed
only on success. `GET /api/browse-dirs` also lets the tree of the host machine
be walked, which is a new capability.

All of it holds within the threat model above: the bot runs on its owner's
machine, these routes are mounted after `auth.middleware`, and that same
dashboard can already shut the process down. A stolen token therefore opens
nothing it did not already open.

---

## Ceilings

| Limit | Value | Reason |
|---|---|---|
| WebSocket payload | 1 MB | The dashboard only exchanges small JSON messages |
| HTTP JSON body | 1 MB | Likewise; files go through `/api/upload` |
| Import size | `MAX_UPLOAD_MB`, default 1024 MB | Prevent a single POST from filling the disk |
| Import extensions | Media list | Refused with `415` |

The import is capped **during the transfer**: the stream is interrupted as soon
as the limit is exceeded and the partial file deleted, without waiting for the
end of the request.

> Historically, the WebSocket limit was **1 GB**, for an `uploadPlay` message
> carrying base64-encoded files. That message was no longer used by the client;
> it has been removed, which made it possible to bring the limit back to a
> reasonable value.

---

## Network exposure

`HOST` is `127.0.0.1` by default: the dashboard is only reachable from the host
machine. To reach it from a phone or another workstation, set `HOST=0.0.0.0` —
authentication then takes on its full meaning. A warning is logged at startup in
that case.

---

## When making changes

- Never pass a path coming from the client to `fs.createReadStream`,
  `fs.statSync` or FFmpeg without going through `resolveMediaPath()`.
- Never mount a route before `auth.middleware`.
- A new WebSocket message able to write to disk must validate its inputs: the
  router only guarantees the presence of `data`.
