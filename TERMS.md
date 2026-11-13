# Terms of Service

**Interactive Music Player**
Last updated: 13 November 2026

---

## 1. Scope

Interactive Music Player ("the Software") is a Discord music bot distributed as
source code and as a Windows installer on
[GitHub](https://github.com/WolfGang-PRoxa/interactive-music-player). It plays
music in a Discord voice channel, automatically lowers the volume when someone
speaks, and provides a web dashboard to control it.

These Terms govern obtaining, installing and using the Software. They supplement
— and do not replace — the [Discord Terms of Service](https://discord.com/terms),
the [Discord Community Guidelines](https://discord.com/guidelines) and the
[Discord Developer Policy](https://discord.com/developers/docs/policies-and-agreements/developer-policy).

---

## 2. Distribution model: self-hosting

This section governs how the rest of the document is to be read.

The Software **is not an online service**. No public instance is offered: there
is no official invite link, no bot operated by the author, and no account to
create. The only service the author runs is an optional sign-in relay that keeps
nothing (see the [Privacy Policy](PRIVACY.md#the-sign-in-relay)).

To use the Software, each person:

1. obtains the source code or the Windows installer from the GitHub repository;
2. creates **their own Discord application** in the
   [Developer Portal](https://discord.com/developers/applications), with their
   own credentials;
3. runs the Software **on their own machine or server**.

This produces a division of roles that never varies:

| Role | Who | Responsibility |
|---|---|---|
| **Author** | The repository maintainer | Publishing the source code. Nothing else. |
| **Operator** | Anyone who installs and runs an instance | The Discord application, the machine, the configuration, the data, the usage |
| **End user** | Members of a Discord server where an instance has been invited | Their own use of the bot and the dashboard |

The author operates no instance, has no access to the data of any instance, and
is not party to any relationship between an operator and their users. An
instance encountered on a Discord server is run by the person who invited it —
that is who to contact about anything concerning it.

---

## 3. Acceptance

Obtaining, installing, running or modifying the Software constitutes acceptance
of these Terms. Anyone who does not accept them must refrain from using the
Software and delete the copies in their possession.

An operator who invites their instance to a Discord server accepts these Terms
**on behalf of that server** and represents that they hold the authority
required to add it.

---

## 4. Eligibility

Using the Software requires meeting Discord's age requirements: at least
thirteen years of age, or the higher minimum age required by the law of the
country of residence.

Operating an instance additionally requires the legal capacity to enter into a
contract, or the consent of a legal guardian.

---

## 5. Licence

The Software is released under the **MIT Licence**, which permits use, copying,
modification and redistribution, including commercially, provided the copyright
notice and the licence text are retained.

These Terms restrict none of the rights granted by the MIT Licence. Where the
two texts conflict as to the scope of the rights granted in the code, **the MIT
Licence prevails**.

---

## 6. Operator obligations

Running an instance carries the following commitments.

### Secrets and access

- The Discord token (`DISCORD_TOKEN`) and the client secret
  (`DISCORD_CLIENT_SECRET`) are **strictly confidential**. Disclosing them lets
  a third party take control of the bot on every server it is present on.
- The dashboard is protected by a single shared token
  (`data/dashboard-token`) granting **full access**: playback, settings, media
  files, shutting the bot down. Distributing it means handing over that control.
- The dashboard listens on `127.0.0.1` only by default. Setting `HOST=0.0.0.0`,
  or exposing it to the Internet, is the operator's decision and their
  consequence to bear. Public exposure must go through a reverse proxy with TLS.
- The `MEDIA_ROOTS` variable widens the set of files the dashboard may read from
  disk. Each added root is an explicit choice.

### Discord servers

- Only invite the bot to servers where the operator is entitled to do so.
- Inform members that a bot is present in the voice channel and that it reacts
  to speech.
- Respect the host server's permissions and organisation.

### Compliance

- Comply with Discord's terms, applicable law, and third-party rights.
- Accept the role of data controller under the GDPR for the data their instance
  handles (see the [Privacy Policy](PRIVACY.md)).

---

## 7. Content and copyright

The Software plays content that **the operator and their users supply**: URLs,
search results, uploaded files, local folders. It hosts, distributes and makes
available no music catalogue of its own.

Accordingly:

- The operator and their users are solely responsible for the rights attached to
  the content they play, upload or queue.
- Playing a protected work in a voice channel may constitute a public
  performance and require authorisation or the payment of royalties, depending
  on the country and the context. That assessment rests with the operator.
- Retrieving streams from third-party platforms may breach those platforms'
  terms of service. The Software provides a technical means; it grants no rights
  and makes no determination as to the lawfulness of any particular use.
- Circumventing technical protection measures is not permitted.

The author performs no moderation: having no access to any instance, they can
neither see, filter, nor remove content played by a third-party instance.

---

## 8. Prohibited uses

The Software must not be used to:

- breach Discord's Terms of Service, Community Guidelines or Developer Policy;
- distribute unlawful content, or infringe the rights of a third party;
- harass, threaten or harm a person or group;
- disrupt a Discord server: spam, raiding, evading a sanction, flooding a voice
  channel;
- automate a Discord user account (*self-botting*), which Discord prohibits;
- collect data about Discord members beyond what the described functionality
  requires;
- circumvent the dashboard's access protections, or reach files outside the
  permitted roots;
- present a modified instance as official, or imply an affiliation with the
  author, with Discord, or with any music platform.

---

## 9. Third-party services

The Software communicates with independent services, each governed by its own
terms:

| Service | Role |
|---|---|
| Discord | Host platform, voice connection, OAuth2 authentication |
| YouTube, Spotify, SoundCloud, Apple Music | Resolving searches and streams |
| GitHub | Distribution of the code and the installer, update checks |
| Cloudflare | Sharing the dashboard through a tunnel, sign-in relay |

None of these services is affiliated with, sponsors, or endorses the Software.
The trademarks named belong to their respective holders.

These services may change their interfaces, or restrict or discontinue access,
at any time, without notice and without recourse. A feature that stops working
for that reason is neither a defect in the Software nor a failure by the author.

---

## 10. Personal data

Data handling is described in the [Privacy Policy](PRIVACY.md), which forms an
integral part of these Terms.

In short: **the author collects nothing**. All data stays on the operator's
machine, in the `data/` folder. The Software sends no telemetry, no usage
analytics, and no crash reports.

---

## 11. Availability, support and updates

The Software is provided **as is**, with no service-level commitment.

- No obligation to maintain, to fix, or to preserve future compatibility.
- No guaranteed support.
  [GitHub issues](https://github.com/WolfGang-PRoxa/interactive-music-player/issues)
  are the only channel, with no promised response time.
- Development may be suspended or abandoned at any time. The MIT Licence then
  leaves anyone free to carry the code forward.
- An update may change or remove a feature, change a file format, or render an
  existing configuration obsolete. Backing up the `data/` folder before
  upgrading is the operator's responsibility.

---

## 12. Warranties and liability

**No warranty.** The Software is provided "as is", without warranty of any kind,
express or implied, including but not limited to merchantability, fitness for a
particular purpose and non-infringement. No warranty is given of uninterrupted
or error-free operation, or against loss of data.

**Limitation of liability.** To the extent permitted by law, the author shall
not be liable for any damage — direct, indirect, incidental, special or
consequential — arising from the use of or inability to use the Software:
loss of data, loss of business, a sanction imposed by Discord or by a
third-party platform, a rightsholder's claim, a breach of a machine's security,
or the compromise of a token.

**Operator indemnity.** The operator shall indemnify the author against any
third-party claim arising from the operator's use of the Software or from the
content they broadcast.

These limitations do not apply in cases of wilful misconduct or gross
negligence, nor to damages that the law forbids excluding. Mandatory consumer
rights remain reserved.

---

## 13. Termination

These Terms apply for as long as the Software is held or operated.

An operator ends them by removing the bot from Discord servers, stopping the
instance, deleting the `data/` folder, and uninstalling the Software.

Sections 7, 9, 10 and 12 survive termination.

---

## 14. Changes

These Terms may be revised. The applicable version is the one published on the
repository's `main` branch, whose Git history serves as the change log. The date
at the top of the document marks the latest revision.

Continuing to use the Software after a revision constitutes acceptance of it.

---

## 15. Miscellaneous

**Governing law.** French law, without prejudice to the mandatory consumer
protection rules of the user's country of residence.

**Severability.** The invalidity of one clause does not affect the others, which
remain in force.

**No waiver.** Failure to enforce a clause is not a waiver of the right to
enforce it later.

**Entire agreement.** These Terms and the [Privacy Policy](PRIVACY.md)
constitute the entire agreement regarding use of the Software, with the MIT
Licence governing rights in the code.

---

## 16. Contact

Questions about these Terms go through the
[repository's GitHub issues](https://github.com/WolfGang-PRoxa/interactive-music-player/issues).

For a question about a particular instance encountered on a Discord server,
contact the person who invited it there: they alone are its operator.

---

*[Version française](CONDITIONS.md) · [Privacy Policy](PRIVACY.md)*
