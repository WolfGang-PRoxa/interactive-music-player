# 11 — Remote access

[← Contents](README.md)

The bot listens on `127.0.0.1` by default. This chapter covers the two things to
do for it to be reached from elsewhere: giving it a public address, and letting
in someone other than its owner.

---

## The public address

Two cases, depending on whether the address is fixed.

**Without a fixed address** — the default — there is nothing to declare. Quick
sharing (see [the tunnel](#the-tunnel)) gets a new address from Cloudflare at
every launch, and the return relay takes care of Discord.

**With a fixed address** — a domain behind a named tunnel, a local network IP —
`PUBLIC_URL` carries it, with no trailing slash. It cannot be guessed, and
Discord requires the callback URL to match **exactly** the one declared in the
developer portal, tab *OAuth2 → Redirects*:

```
PUBLIC_URL=https://imp.romainpiau.dev
      └──► declare   https://imp.romainpiau.dev/auth/discord/callback
```

`PUBLIC_URL` always wins: as soon as it is written, the relay steps aside and
the journey becomes direct again. It is also what explains the token's detour
through the OAuth `state`: the dashboard opens on `127.0.0.1` where its cookie
lives, while Discord redirects to `PUBLIC_URL`. Two hosts, two cookie jars, and
a callback that does not have the token — see
[07 — Security](07-securite.md#authentication).

### The return relay

Discord only agrees to send a visitor back to an address declared in advance.
Quick sharing's address changes at every launch: you would have to go back to
the portal at every start. The relay
([`oauthRelay.js`](../../../src/web/oauthRelay.js), and the Worker in
`tools/oauth-relay/`) is a fixed step between the two:

```
dashboard ──/auth/discord──► Discord ──► relay (fixed address, declared once)
      ▲                                         │
      └──── /auth/discord/callback?code=… ◄─────┘  to the origin read in the state
```

After its random part, the `state` carries the origin the sign-in started from.
The relay sends the visitor back there with the code. The return therefore
lands where the browser's cookies live — the token, the sign-in's `nonce` —
whether the dashboard was opened on `localhost` or through the tunnel's link.

The relay only sees a single-use code go by, worthless without the
application's secret, which only the bot holds. It keeps nothing and logs
nothing. A default relay is deployed for every installation; `OAUTH_RELAY_URL`
points to another one, and `OAUTH_RELAY_URL=off` does without it.

| Destination | Accepted | Why |
|---|---|---|
| `https://….trycloudflare.com` | Yes | Quick sharing, whose address changes |
| `http://localhost:<port>`, `http://127.0.0.1:<port>` | Yes | The machine itself |
| A domain, a local network IP | No | A fixed address is declared directly with Discord |
| Any other address | No | An open relay would deliver codes to whoever asks |

The rule is written twice — in the bot and in the Worker, which imports nothing
from the repository — and [`tests/oauthRelay.js`](../../../tests/oauthRelay.js)
tests both on the same cases.

---

## The tunnel

Opening the dashboard to the outside used to go through Tailscale Funnel, and
took four gestures nothing announced: installing Tailscale with administrator
rights, creating an account, getting the network's right to publish, mounting
the Funnel. Every user of the bot had to do all four again.

[`cloudflare.js`](../../../src/web/cloudflare.js) replaces them with two, which
the bot does on a click. `cloudflared` is a single executable: it is not
installed, it is dropped into `data/bin/` and started, with no special rights.
The bot downloads it from Cloudflare's official releases, then opens the
tunnel. Like the module it replaces, it **observes** first, and only acts when
asked.

### The states

| State | What is observed | Next gesture |
|---|---|---|
| `absent` | `cloudflared` cannot be found | Download it (one click) |
| `downloading` | The download is under way | — |
| `needsAddress` | Named tunnel token, but no `PUBLIC_URL` | Declare the tunnel's address |
| `ready` | Everything is in place; the tunnel remains to be opened | `mount()` — deliberately |
| `starting` | Started, Cloudflare has not confirmed yet | Wait a few seconds |
| `serving` | The dashboard is reachable from the internet | — |
| `failed` | The tunnel stopped by itself | Try again, the cause is given |

The whole decision lives in `decide()`, a pure function of what was observed:
every state can be tested without downloading `cloudflared` or opening a
tunnel. Nothing is started to observe — everything is already in the bot's
process — so the window can ask for the state as often as it likes.

### Quick sharing

It is the default mode, and it needs no account. `cloudflared tunnel --url`
opens a tunnel and Cloudflare gives it an `https://….trycloudflare.com`
address, read from its output — never guessed. `api.trycloudflare.com`, which
shows up in its errors, is not one.

The address changes at every launch. Guests do not suffer from it, since the
bot posts the link for them; Discord goes through the relay. It is **never
copied into `PUBLIC_URL`**: cookies would turn `Secure`, and the session of the
person sitting at the machine, on `http://localhost`, would no longer hold.

Cloudflare presents these tunnels as a testing tool: no availability guarantee,
and a cap on simultaneous requests. For a channel among friends, that is plenty;
the fixed address is there if it gets tight.

### The fixed address

Anyone who owns a domain at Cloudflare creates a named tunnel in their dashboard
(*Zero Trust → Networks → Tunnels*), gives it a hostname leading to
`http://localhost:<port>`, and copies two values into `.env`:

```
CLOUDFLARE_TUNNEL_TOKEN=eyJhIjoi…
PUBLIC_URL=https://imp.romainpiau.dev
```

The bot then runs that tunnel instead of quick sharing. The token goes through
`cloudflared`'s environment (`TUNNEL_TOKEN`) and never through its command
line, where any process on the machine could read it. A named tunnel does not
know its own hostname — it lives in the Cloudflare dashboard — hence the
`needsAddress` state when `PUBLIC_URL` is missing.

A given tunnel must only run on one machine at a time: started on two,
Cloudflare would split the visitors between them.

### What never happens on its own

Publishing exposes the dashboard to **the whole internet**. Doing it unasked
would publish someone's player without their knowledge: `mount()` is only
called on a gesture from the master. That gesture is remembered
(`data/tunnel.json`), and the tunnel reopens at the next launch — like the
Funnel, which survived restarts. Withdrawing the share forgets it.

The tunnel lives with the bot's process and stops with it.

The domain's four messages — `tunnelState`, `tunnelInstall`, `tunnelMount`,
`tunnelUnmount` — are **reserved for the session master**. Making the dashboard
reachable, or fetching an executable onto the host's machine, is not a command
one shares.

### Cloudflare's limits

- **100 MB per request** on the free plan, beyond which Cloudflare answers 413
  without the bot seeing anything. The browser therefore splits any file over
  64 MB, and the server puts the pieces back together
  ([`chunkedUpload.js`](../../../src/web/chunkedUpload.js)). `MAX_UPLOAD_MB`
  applies to the total and keeps its full meaning.
- **A single source address.** Every request arrives from `cloudflared`, hence
  from the machine itself: the rate limiter reads the real address in
  `CF-Connecting-IP`, which it only trusts on a connection coming from the
  machine.
- **Video.** Cloudflare's CDN terms in principle reserve video delivery for its
  paid offers. Personal use among friends stays modest, but the dashboard's
  video relay is in a grey area.

---

## Letting someone in

The complete journey, from the link posted to the guest driving:

```
master ──sendInviteLink──► the bot posts the link in the voice channel's chat
                                            │
                       the guest clicks ────┴──► GET /auth/discord
                                                       │
                                            Discord identifies them
                                                       │
                                            GET /auth/discord/callback
                                                       │
                                       session opened, entry in the book
                                                       │
                                     dashboard **inert**: no rights at all
                                                       │
master ──admitGuest──────────────────────────────► the guest is admitted
master ──shareControl────────────────────────────► rights granted, gesture by gesture
```

The order is intended: the master can only tick boxes for people who have
introduced themselves. A guest who is recognised but has no rights sees a
dashboard that displays everything and commands nothing.

The link posted in the chat **does not carry the access token**. That is what
makes it postable: the token appears in the console of whoever launched the bot,
and it is worth total control. The guest who clicks brings nothing but their
Discord account.

An account that is a member of no server of the bot is refused — at the door as
everywhere else.

### Remembering a guest

A Discord session does not cross the border between two browsers, and lasts less
long than the rights one grants. Two questions are therefore separated, and that
separation is enough: **who is this person?** belongs to the book
([`guests.js`](../../../src/web/guests.js), `data/guests.json`), **is this tab
theirs?** belongs to the session
([`sessions.js`](../../../src/web/sessions.js)).

The book contains **no secret**: no access token, no Discord token, nothing that
would allow anyone to pass for someone else. Appearing in it means "this account
has authenticated at least once", never "this account is allowed to…".

See [07 — Security](07-securite.md#remembering-a-guest) for silent recognition
(`prompt=none`) and its guard rails.

---

## When making changes

- A new message touching the tunnel or sharing must be declared `MASTER_ONLY`
  in [`permissions.js`](../../../src/web/permissions.js). A message unknown to
  the table already is by default, but relying on the fallback makes the intent
  unreadable.
- Never build the callback URL on the client side: the Discord portal expects
  the one the server builds, and a one-character difference breaks the whole
  journey.
- Touching the relay's destinations means touching both copies of the rule —
  `oauthRelay.js` and `tools/oauth-relay/src/index.js` — then redeploying the
  Worker.
- `decide()` must remain a pure function of what it receives. That is what makes
  it testable without `cloudflared`.
