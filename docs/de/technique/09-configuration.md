# 09 — Konfiguration

[← Inhalt](README.md)

---

## Zwei Ebenen der Konfiguration

| Ebene | Datei | Im laufenden Betrieb änderbar |
|---|---|---|
| Umgebung | `.env` | Nein — Neustart erforderlich |
| Konstanten der Anwendung | [`src/config.js`](../../../src/config.js) | Nein — Vorgabewerte im Code |
| Einstellungen je Server | `data/settings.json` | Ja — Befehle oder Dashboard |

`config.js` enthält nichts als **Vorgabewerte**: sobald ein Server bekannt ist,
leben seine tatsächlichen Einstellungen in `settings.json` (siehe
[06 — Persistenz](06-persistance.md)).

---

## Umgebungsvariablen

`.env.example` nach `.env` kopieren und mindestens `DISCORD_TOKEN` eintragen.

### Discord

| Variable | Erforderlich | Rolle |
|---|---|---|
| `DISCORD_TOKEN` | **Ja** | Token des Bots. Sein Fehlen bricht den Start ab. |
| `DISCORD_CLIENT_ID` | Für `npm run deploy` | Kennung der Anwendung |
| `DISCORD_CLIENT_SECRET` | Für die Discord-Anmeldung | OAuth2-Geheimnis. Leer gelassen kann sich niemand ausweisen: das Dashboard sagt es und fällt auf das bloße Zugangstoken zurück. |
| `GUILD_ID` | Für eine lokale Bereitstellung | Registriert die Befehle nur auf diesem Server, ohne Verbreitungsfrist |

### Dashboard

| Variable | Vorgabe | Rolle |
|---|---|---|
| `PORT` | `3000` | Port, auf dem gelauscht wird |
| `HOST` | `127.0.0.1` | Schnittstelle, auf der gelauscht wird. `0.0.0.0`, um im lokalen Netz erreichbar zu sein. |
| `PUBLIC_URL` | — | Adresse, unter der Gäste dieses Dashboard erreichen, ohne abschließenden Schrägstrich. Sie lässt sich nicht erraten, und die Rückruf-URL `<PUBLIC_URL>/auth/discord/callback` muss im Discord-Portal genau so eingetragen sein. |
| `AUTO_OPEN_DASHBOARD` | `true` | Öffnen des Browsers beim Start. `false`, wenn der Bot auf einem fernbedienten Rechner läuft — dieses Dashboard spielte die Musik doppelt. |
| `DASHBOARD_TOKEN` | erzeugt | Zugangstoken. Wenn leer, wird es erzeugt und in `data/dashboard-token` gespeichert. |

### Versionen

| Variable | Vorgabe | Rolle |
|---|---|---|
| `GITHUB_TOKEN`, `GH_TOKEN` | — | Token der GitHub-API. Bei einem öffentlichen Repository entbehrlich; hebt das Kontingent von 60 auf 5 000 Anfragen je Stunde. Andernfalls wird die `gh`-CLI befragt, sofern installiert und angemeldet. |
| `IMP_REPO` | Repository aus `package.json` | Repository, dessen Releases angeboten werden, als `owner/repo` oder als URL |
| `IMP_VERSIONS_DIR` | `versions/` | Verlagert die installierten Releases anderswohin — zweite Platte, Ordner außerhalb des Repositorys |
| `IMP_RESTART` | — | Von der sich neu startenden Instanz gesetzt. Kennzeichnet eine Wiederaufnahme, was die Eröffnungsblende entfallen und den Lieblingskanal übergehen lässt. |

Die letzten drei sind keine Benutzereinstellungen: der Bot setzt sie selbst, wenn
er eine andere Version neu startet. Siehe [10 — Versionen](10-versions.md).

### Medien

| Variable | Vorgabe | Rolle |
|---|---|---|
| `MEDIA_ROOTS` | — | Lokale Ordner, die zum Streaming zugelassen sind, zusätzlich zu `data/uploads` und `data/cache`. Trennzeichen `;` oder `,`. |
| `MAX_UPLOAD_MB` | `1024` | Höchstgröße einer importierten Datei |
| `MAX_CACHE_MB` | `2048` | Obergrenze des Vorlade-Caches in `data/cache` |

### Protokollierung

| Variable | Vorgabe | Rolle |
|---|---|---|
| `LOG_LEVEL` | `debug` | Schwelle: `debug`, `info`, `warn`, `error` |
| `LOG_RETENTION` | `20` | Zahl der in `data/logs` aufbewahrten Protokolle |

### Variablen ohne Wirkung

`SPOTIFY_CLIENT_ID` und `SPOTIFY_CLIENT_SECRET` werden von
`@discord-player/extractor` gelesen, sofern vorhanden, und verbessern die
Spotify-Auflösung.

`DEEZER_ARL`, `QOBUZ_EMAIL` und `QOBUZ_PASSWORD` haben **keinerlei Wirkung**: es
ist kein entsprechender Extraktor installiert oder registriert. Es sind
Überbleibsel.

---

## config.js

```js
ducking: {
    enabled: true,          // Ducking standardmäßig aktiv
    level: 20,              // % der Grundlautstärke während des Sprechens
    restoreDelay: 800,      // ms Stille vor der Wiederherstellung
    fadeDuration: 200,      // ms Übergang
    fadeStepInterval: 20,   // ms zwischen zwei Blendenstufen
},
volume: { defaultBase: 70, min: 0, max: 100 },
presence: {
    enabled: true,          // einen Sprachkanal nur betreten, wenn er bewohnt ist
    departureDelay: 30000,  // ms Wartezeit vor dem Verlassen eines geleerten Kanals (Rückfall)
},
broadcast: { defaultMode: 'everyone', personalChannelPrefix: '🎵' },
supportedExtensions:      ['.mp3', '.flac', '.wav', '.ogg', '.m4a', '.opus', '.aac', '.wma'],
supportedVideoExtensions: ['.mp4', '.webm', '.mkv', '.avi', '.mov', '.flv', '.m4v', '.3gp', '.ogv', '.wmv'],
colors: { … },   // Farben der Discord-Einbettungen
```

`fadeStepInterval` ist die einzige Konstante, die dem Benutzer nicht offensteht:
sie bestimmt die Feinheit der Blenden von
[`VolumeController`](../../../src/audio/VolumeController.js).

`presence.enabled` auf `false` gibt dem Bot sein altes Verhalten zurück: er
bleibt dauerhaft verbunden, ob der Kanal leer ist oder nicht. Siehe
[04 — Übertragungsmodi](04-diffusion.md#präsenz-in-den-sprachkanälen).

`presence.departureDelay` ist nur ein Rückfallwert: jeder Server legt seinen
eigenen über das Dashboard fest (*Einstellungen → Bot-Einstellungen → Frist vor
dem Verlassen eines leeren Kanals*), je Server unter `presenceDepartureDelay`
gespeichert — **in Sekunden**, der Einheit des Reglers, die
`PresenceManager._departureDelayMs()` wieder in Millisekunden umrechnet. Der Regler
läuft von 0 bis 300 s, und der Server begrenzt den empfangenen Wert erneut; null
bedeutet einen Abgang ohne Frist, was das übliche `||` bei dieser Einstellung
verbietet. Die Frist zu ändern spannt einen bereits laufenden Countdown neu, um
nicht auf den nächsten geleerten Kanal zu warten.

Die Listen der Erweiterungen haben eine doppelte Rolle: das Filtern der von
`/playlist` durchsuchten Ordner und den **Geltungsbereich des
Sicherheitsgeländers** für die dem Client gelieferten Pfade (siehe
[07 — Sicherheit](07-securite.md)).

---

## Einstellungen je Server

Vorgabewerte in `_defaults()` von
[`Database.js`](../../../src/database/Database.js) festgelegt. Hier einen
Schlüssel zu ergänzen genügt: alle bestehenden Server erben ihn, da
`getSettings()` die Vorgaben bei jedem Lesen zusammenführt.

| Schlüssel | Vorgabe | Beschreibung |
|---|---|---|
| `duckingEnabled` | `true` | Absenkung beim Sprechen |
| `duckingLevel` | `20` | % der Grundlautstärke während des Sprechens |
| `duckingDelay` | `800` | ms vor der Wiederherstellung |
| `duckingFade` | `200` | ms Übergang |
| `baseVolume` | `70` | Lautstärke außerhalb des Sprechens |
| `broadcastMode` | `'everyone'` | Übertragungsmodus |
| `playbackSpeed` | `'1.0'` | Wiedergabegeschwindigkeit |
| `defaultVoiceChannelId` | `null` | Bevorzugter Kanal — nur einer, über alle Server hinweg; nur beim Start gelesen |
| `lastVoiceChannelId` | `null` | Zuletzt besuchter Kanal — ihm folgen während einer Sitzung alle |
| `mixEnabled` | `false` | Übergang im DJ-Stil |
| `mixDuration` | `5` | Dauer des Übergangs, in Sekunden |
| `mixType` | `'volume'` | `'volume'` oder `'effects'` |
| `lufsSyncEnabled` | `false` | Alle Stücke auf dieselbe Lautheit ausrichten |
| `lufsSyncTarget` | `-14` | Gemeinsames Ziel, in LUFS |
| `fadeinEnabled` | `false` | Einblenden |
| `fadeinDuration` | `5` | Sekunden |
| `fadeoutEnabled` | `true` | Ausblenden beim Abschalten |
| `fadeoutDuration` | `5` | Sekunden |
| `addTarget` | `'queue'` | Ziel des Eingabefelds: `queue`, `playlist`, `play` oder `download` |
| `importFormat` | `'mp3'` | Container der auf die Platte geschriebenen Dateien |
| `importAudioQuality` | `'320'` | MP3-Rate des Vorladens, in kbps |
| `importVideoQuality` | `'720'` | Zielhöhe des Videostroms, in Pixeln |
| `presenceDepartureDelay` | `30` | Frist vor dem Verlassen eines geleerten Kanals, **in Sekunden** |
| `ignoredVoiceUsers` | `{}` | Ausschlüsse vom Ducking, je Kanal |
| `sharedControl` | `{}` | Gästen gewährte Rechte, je Discord-Konto |
| `rightRequests` | `{}` | Von Gästen angefragte Rechte, die auf Antwort warten: Konto → Recht → Zeitstempel |
| `mutedRightRequests` | `[]` | Gäste, deren Rechteanfragen stummgeschaltet sind |
| `preloading` | siehe unten | Vorladen: `enabled`, `queueCount`, `historyCount`, `playlistCount` |
| `activePlaybackSource` | `'queue'` | `'queue'` oder Kennung einer Wiedergabeliste |
| `playlistCurrentIndex` | `0` | Position in der aktiven Wiedergabeliste |
| `loopPlaylist` | `false` | Die aktive Wiedergabeliste ab ihrem ersten Titel erneut abspielen |
| `channelQueues` | `{}` | Die Warteschlange, Sprachkanal für Sprachkanal abgelegt |
| `queueBackupPersonal` | `null` | Sicherung aus der Zeit vor der Ablage je Kanal |
| `queueBackupEveryone` | `null` | Ebenso, gemeinsamer Modus |

`channelQueues` ist `{ "<channelId>": [Titel | Weiche, …] }`. Ein Kanal „Party“
und ein Kanal „ruhig“ haben je ihre eigene und finden sie bei der Rückkehr
wieder, wo eine einzige Warteschlange je Server dem Bot überallhin folgte. Es ist
zudem der einzige Ort, an dem eine Weiche warten kann: sie braucht eine geordnete
Liste, um eine Position zu bezeichnen, was der Player ihr nicht bot. Siehe
[`channelQueue`](../../../src/audio/channelQueue.js).

Die beiden letzten Schlüssel sind **ererbt** und bleiben auf `null`: sie trugen
die beiseitegestellte Warteschlange vor der Ablage je Kanal.
[`channelQueue`](../../../src/audio/channelQueue.js) liest sie einmal, um
zurückzugießen, was eine frühere Fassung dort hinterlassen hat, und löscht sie
dann. Alles läuft nunmehr über
[`setAsideQueue`](../../../src/utils/setAsideQueue.js): eine schlichte
Titelliste, in der nichts „laufend“ ist, da nichts daraus gespielt wird, solange
die Wiedergabeliste den Player belegt. Die alten Formen (`{ tracks }`,
`{ virtualCurrentTrack, virtualTracks }`) werden beim Lesen weiterhin
angenommen.

`loopPlaylist` ist vom Wiederholmodus von discord-player verschieden, der nur die
tatsächlich geladene Warteschlange kennt: „die Wiedergabeliste“ erneut
abzuspielen heißt, sie ab ihrem ersten Titel neu zu laden, auch wenn die
Wiedergabe mittendrin begonnen hatte.

`activePlaybackSource` kehrt nicht allein auf Entscheidung des Benutzers zu
`'queue'` zurück: eine Wiedergabeliste, die ohne Schleife endet, gibt an die
beiseitegestellte Warteschlange zurück, die dann mit ihrem ersten Stück beginnt
(`WebServer.advanceToQueue()`). Der Wechsel wird an beiden
Erschöpfungspunkten versucht — der virtuellen Warteschlange des persönlichen
Modus und dem Ereignis `emptyQueue` des gemeinsamen Modus —, stets nach dem
Neustart der Schleife: diese Reihenfolge und nicht eine Prüfung von
`loopPlaylist` gibt der Schleife den Vorrang. Eine leere beiseitegestellte
Warteschlange lässt die Wiedergabe enden, wie zuvor.

Das Unterobjekt `preloading` (`enabled`, `queueCount`, `historyCount`,
`playlistCount`) wird vom Dashboard eingestellt, aber **serverseitig verbraucht**
von [`PreloadManager.js`](../../../src/audio/PreloadManager.js): der Wert muss
daher hier leben und nicht allein im `localStorage` des Browsers.

Die drei Zähler reichen von 0 bis 5, dazu eine letzte Raste, die nicht mehr zählt
und den ganzen Abschnitt nimmt. Sie wird als **`-1`** gespeichert, nie als die
Position des Reglers: diese gilt nur im Verhältnis zum Höchstwert des Tages, und
an dem Tag, an dem die Regler eine Raste gewönnen, hörte eine gespeicherte `6`
auf, „alles“ zu bedeuten, ohne dass irgendetwas es meldete. Eine negative Zahl
dagegen ist in keiner Welt eine. Sie wird als `Infinity` zurückgelesen, was die
nachgelagerten `slice(0, n)` und `Math.min(n, …)` bereits richtig behandeln.

---

## npm-Befehle

| Befehl | Wirkung |
|---|---|
| `npm start` | Startet den Bot |
| `npm run dev` | Startet mit `--watch` (Neustart bei Dateiänderung) |
| `npm run deploy` | Meldet die Slash-Befehle bei Discord an |
| `npm run update-ytdlp` | Aktualisiert yt-dlp — nötig, wenn das Vorladen mit 403 scheitert |

### Bereitstellung der Befehle

[`deploy-commands.js`](../../../src/deploy-commands.js) sammelt die Befehle aus
`src/commands/` und meldet sie **global** an. Die Verbreitung kann bis zu einer
Stunde dauern. Für einen sofortigen Test `GUILD_ID` in `.env` setzen: die Befehle
werden dann auf diesem einen Server angemeldet, ohne Verzögerung.

Dieses Skript ist bei jedem Hinzufügen, Entfernen oder jeder Änderung der
Signatur eines Befehls erneut auszuführen. Nur den Rumpf eines Befehls zu ändern
erfordert es nicht.

---

## Discord-Befehle

| Befehl | Optionen | Rechte |
|---|---|---|
| `/play` | `query` — Suche, URL oder lokaler Pfad | Alle |
| `/playlist` | `path`, `shuffle` | Alle |
| `/queue` | `page` | Alle |
| `/skip`, `/pause`, `/resume`, `/stop` | — | Alle |
| `/nowplaying` | — | Alle |
| `/volume` | `level` (0–100) | Alle |
| `/ducking toggle\|level\|delay\|fade\|status` | je nach Unterbefehl | Alle |
| `/broadcast` | `mode` — `everyone` oder `personal` | **Administrator** |

Die Rechteprüfungen nutzen
[`utils/permissions.js`](../../../src/utils/permissions.js).

---

## Voraussetzungen

- **Node.js 18 oder höher** — das Projekt nutzt `fs.promises`, den Operator für
  optionale Verkettung und mittelbar über seine Abhängigkeiten
  `structuredClone`. In `package.json` ist kein `engines`-Feld deklariert.
- **FFmpeg** — von `ffmpeg-static` mitgeliefert, keine systemweite Installation
  nötig.
- **yt-dlp** — von `youtube-dl-exec` mitgeliefert, als Rückfall bei der Auflösung
  und für die Videoextraktion verwendet.

Die erforderlichen Discord-Intents (`Guilds`, `GuildVoiceStates`,
`GuildMessages`) müssen im Entwicklerportal aktiviert sein.
