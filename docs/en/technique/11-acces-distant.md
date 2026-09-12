# 11 — Remote access

[← Contents](README.md)

The bot listens on `127.0.0.1` by default. This chapter covers the two things to
do for it to be reached from elsewhere: giving it a public address, and letting
in someone other than its owner.

---

## The public address

`PUBLIC_URL` is the address at which guests reach this dashboard, with no
trailing slash. **It cannot be guessed**: the server listens on `127.0.0.1`, and
the useful address — local network IP, tunnel, domain name — is known only to
the operator.

It is not just for display. Discord requires the callback URL to match
**exactly** the one declared in the developer portal, tab *OAuth2 → Redirects*:

```
PUBLIC_URL=http://192.168.1.20:3000
      └──► declare   http://192.168.1.20:3000/auth/discord/callback
```

Without `PUBLIC_URL`, the callback URL points at `127.0.0.1`: the journey works
from the host machine and fails everywhere else. A warning is logged at startup
in that case.

It is also what explains the token's detour through the OAuth `state`: the
dashboard opens on `127.0.0.1` where its cookie is set, while Discord sends the
user back to `PUBLIC_URL`. Two hosts, two cookie jars, and a callback that does
not have the token — see [07 — Security](07-securite.md#authentication).

---

## The tunnel

Opening the dashboard to the outside required four gestures that nothing
announced: installing Tailscale, authenticating the machine, obtaining the right
to publish from the tailnet, then mounting the Funnel. Each fails in its own
way, and none says what is missing — one discovered the next step by running
into it. Worse: the resulting public address had to be copied by hand into
`PUBLIC_URL`, and that copy travelled with the repository. An installation on a
second machine thus inherited the first one's address, and the Discord sign-in
round trip sent the user back to the computer next door.

[`tailscale.js`](../../../src/web/tailscale.js) does nothing on its own: it
**observes**. It answers "here is where you stand, and here is what is missing",
in a vocabulary the interface turns into a sentence. The gestures that can be
automated are asked of it explicitly, one at a time.

### The seven states

They are **ordered**: each assumes the previous one acquired, which allows them
to be presented as a progression rather than as a diagnosis.

| State | What is observed | Next gesture |
|---|---|---|
| `absent` | The `tailscale` command cannot be found | Install Tailscale |
| `unreachable` | Installed, but the daemon does not answer | Start the service |
| `needsLogin` | Machine not signed in to a tailnet | `tailscale up`, or an auth key |
| `needsCapability` | Signed in, but the tailnet does not grant the right to publish | Enable HTTPS and Funnel in the admin console |
| `ready` | Everything is in place; the Funnel remains to be mounted | `mount()` — deliberately |
| `serving` | The Funnel does publish this dashboard | — |
| `otherTarget` | The Funnel publishes **something else** | Do not overwrite it without saying so |

The whole decision lives in `decide()`, separated from what feeds it: it works
on two already-read objects, which makes it possible to exercise it on all seven
states without installing Tailscale, disconnecting it, or removing a right from
the tailnet to see what happens. `inspect()` now does nothing but carry the
buckets.

A command that drags is as good as a missing command — the daemon can be frozen
— hence an eight-second timeout. And when the `PATH` does not yet carry the
command, the known locations are visited: a fresh installation does not update
the `PATH` of processes already started, and the bot launched before it would see
nothing, which the user would take for a failed installation.

### What cannot be automated

Three things, and it is better to say so than to work around it:

- **Installation** requires administrator rights. A service running under a user
  account does not take them without a system prompt.
- **The Tailscale account** cannot be created through any API. An auth key
  removes the interactivity, but an account is needed to issue one.
- **The right to publish** (`funnel`, `https`) is granted by the tailnet's
  policy, therefore from the admin console.

### Mounting the Funnel stays a gesture

The Funnel exposes the dashboard **to the whole internet**, not to the local
network. Mounting it unasked would publish someone's player without their
knowledge: it is the only step the module refuses to take by default, even when
everything is ready. `mount()` exists, it has to be called.

The call is made with `--bg` — the foreground form would block the bot's startup
— and with `--yes`, a confirmation prompt inside a service having no reader.

### The state is not in the ordinary broadcast

Observing it launches two processes. Doing so every second, for a value that
only moves at someone's gesture, would be paying dearly for a display nobody
looks at most of the time. The window asks for it as it opens, through
`tunnelState`.

The domain's four messages — `tunnelState`, `tunnelLogin`, `tunnelMount`,
`tunnelUnmount` — are **reserved for the session master**. Making the dashboard
reachable from outside, or ceasing to be, is not a playback command one shares.

At startup, `announce()` writes one line to the log, and each one carries **the
action rather than the observation**: "not installed" teaches nothing to someone
who has just opened a console, "install it here" does. It is the counterpart of
the OAuth trace, and for the same reason — those are the only two things one
cannot guess when installing the bot on a fresh machine.

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

- A new message touching the tunnel or sharing must be declared `MASTER_ONLY` in
  [`permissions.js`](../../../src/web/permissions.js). A message unknown to the
  table already is by default, but relying on the fallback makes the intent
  unreadable.
- Never build the callback URL on the client side: the Discord portal expects the
  one the server builds, and a one-character difference makes the whole journey
  fail.
- `decide()` must stay a pure function of its two arguments. That is what makes
  it exercisable without Tailscale installed.
