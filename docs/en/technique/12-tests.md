# 12 — Tests

[← Contents](README.md)

Fifty suites live in [`tests/`](../../../tests/), all launched by `npm test`.
They follow no test framework: they are ordinary Node scripts that run and
return an exit code.

---

## The stance

**No test dependency.** Neither Jest, nor Mocha, nor `node:test`. Each suite is
a file that counts its successes and its failures, prints them, then exits with
`0` or `1`:

```js
let failed = 0;
let passed = 0;
const check = (label, ok, detail = '') => {
    if (ok) { passed++; }
    else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

// …

console.log(`=== ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
```

That is consistent with the rest of the project — nothing is transpiled, nothing
is bundled — and it follows from a real constraint: most of what there is to
exercise here is browser JavaScript served without modules, communicating through
`window.MusicPlayer`. A framework that assumes ES imports would have nothing to
do with it. The frontend suites therefore load the file, evaluate it in a
hand-prepared context, and look at what it puts there.

**A suite says why it exists.** The header of each file describes the defect it
catches, and what that defect cost. That is the part worth reading first when a
suite falls: it often says directly what has just been broken.

---

## The three families

| Family | What is exercised | Examples |
|---|---|---|
| **Unit** | One function, with nothing around it | `loudness`, `downloadFormats`, `historyOrder`, `rangeStream` |
| **Behavioural** | A server-side module, with stand-ins | `channelQueue`, `transitions`, `pilotElection`, `shareGrant` |
| **Frontend** | A script from `public/js/`, evaluated in a fake context | `speedPadPointer`, `toastSwipe`, `scrollFade`, `themeBlend` |

To which are added two suites that do not bear on the application code:
`docsIntegrity` and `docsLanguages`, described below.

---

## The smoke test

[`tests/smoke.js`](../../../tests/smoke.js) is the only one to start the bot for
real. It proceeds in two stages, from the cheapest to the dearest:

1. **Loading** — every module of `src/` is required. Catches broken `require()`
   calls, vanished exports and syntax errors. The two entry points
   (`src/index.js`, `src/deploy-commands.js`) are excluded: loading them would
   start the bot.
2. **Integration** — the bot is started, then queried over HTTP and WebSocket.
   Catches what loading does not see: a protocol field renamed on one side only,
   a route that no longer answers.

It carries a `STATE_FIELDS` list of the top-level fields of the `state` message.
**It is to be updated knowingly** when a protocol field is renamed — that is
precisely the kind of oversight this test exists to catch, a rename done on one
side only producing no error, just an empty display.

> The smoke test needs the dashboard port. If the bot is already running on the
> machine, its integration stage fails on an occupied port: that is not a
> regression, it is the environment. Shut the running instance down before
> launching it.

---

## The two documentation suites

They guard this very corpus, and are worth knowing before touching it.

[`docsIntegrity.js`](../../../tests/docsIntegrity.js) checks three things that
break silently and that no proofreading of a translation shows:

- **Anchors.** A link to `05-tableau-de-bord.md#robustness` designates a heading.
  Translating the heading without translating the anchor, or the reverse, gives a
  link that leads nowhere — in that language only. The anchor computation
  reproduces the one in `js/docs.js`, which follows GitHub's convention.
- **The frame.** A translation must have **as many headings, code blocks and
  table rows** as its French original. A discrepancy signals a forgotten section
  or a truncated table, which a 15 KB file does not show.
- **Links to the code.** They cross `docs/<language>/technique/` to climb back up
  to `src/`. Moving the documentation by one level breaks them all at once,
  without anything signalling it: these are repository links, which the dashboard
  reader does not even open.

[`docsLanguages.js`](../../../tests/docsLanguages.js) mounts the real API router
on an ephemeral port and checks the service: the inventory starts from
`docs/<language>/` and never from `docs/`, the identifiers do not carry the
language, and nothing coming from the client is assembled into a path.

**Practical consequence.** Any change to the French documentation must be carried
into the three translations with the **same frame**: the same number of headings,
code blocks and table rows. Adding a row to a French table without adding it to
the other three makes `docsIntegrity` fall.

---

## Running the tests

| Command | Effect |
|---|---|
| `npm test` | The fifty suites, in sequence. Stops at the first one that fails. |
| `npm run smoke` | The smoke test alone |
| `npm run test:<name>` | One specific suite — one script per suite in `package.json` |

`npm test` chains with `&&`: the first suite that exits `1` interrupts the rest.
That is intended — a cross-cutting regression would fell thirty suites, and
reading the first is more useful than scrolling through the others.

---

## Writing a suite

1. Create `tests/<name>.js`.
2. At the top, describe **the defect the suite catches** and what it cost. Not
   what the code does: what used to break without it.
3. Reuse the `check()` counter above, and exit with
   `process.exit(failed === 0 ? 0 : 1)`.
4. Add `"test:<name>": "node tests/<name>.js"` to `package.json`, **and** insert
   it into the chain of the `test` script. Both: the individual script serves
   development, the chain serves the overall check.

A suite that needs the server mounts the real router on an ephemeral port
(`server.listen(0, '127.0.0.1')`) with a fake `webServer`, as `docsLanguages`
does. Starting the whole bot is only necessary for the smoke test.
