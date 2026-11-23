# 01 — Architektur

[← Inhalt](README.md)

---

## Verzeichnisbaum

```
src/
├── index.js                  Einstiegspunkt: Discord-Client, Player, Ducking, Beenden
├── config.js                 Konstanten und Vorgabewerte (zur Laufzeit unverändert)
├── deploy-commands.js        Skript zur Registrierung der Slash-Befehle
│
├── audio/
│   ├── PlaybackSession.js    Wiedergabezustand je Server (deklariertes Schema)
│   ├── DuckingManager.js     Spracherkennung → Steuerung der Lautstärke
│   ├── VolumeController.js   Allmähliche Blenden auf dem Audioknoten
│   ├── PlayerEvents.js       Ereignis-Listener von discord-player
│   ├── PresenceManager.js    Kommen und Gehen des Bots je nach Kanalbelegung
│   ├── PreloadManager.js     Festplatten-Cache der entfernten Titel
│   ├── rangeStream.js        Abschnittsweises Laden, um die Drosselung zu umgehen
│   ├── LocalFilePlayer.js    Hilfsmittel zum Durchsuchen von Audioordnern
│   ├── LoudnessAnalyzer.js   LUFS-Messung einer Datei, mittels FFmpeg
│   ├── loudness.js           Messung + Ziel → Verstärkung, ohne Audiowissen
│   ├── channelQueue.js       Die Warteschlange, Sprachkanal für Sprachkanal abgelegt
│   ├── transitions.js        Weichen zwischen zwei Titeln einer Wiedergabeliste
│   ├── videoSource.js        Auflösung des Bildstroms eines Titels
│   ├── playbackSettings.js   Geschwindigkeit und Mischeffekte, unabhängig vom Audioweg
│   └── mix/                  Mischbus: die gemeinsame Übertragung, zwei überlagerbare Spuren
│       ├── format.js         PCM-Austauschformat und Aufteilung in Frames
│       ├── input.js          Auflösung eines Titels zu einem FFmpeg-Eingang
│       ├── MixSource.js      Ein dekodiertes Stück, mit Verstärkung und Filter
│       ├── MixBus.js         Der dauerhafte Strom, der an Discord geht
│       ├── MixEngine.js      Orchestrierung je Server und Steuerung der Warteschlange
│       ├── playerBridge.js   Weiterleitung der Player-Methoden an den Bus
│       └── index.js          Verzeichnis der Busse, einer je Server
│
├── broadcast/
│   └── BroadcastManager.js   Übertragungsmodi, persönliche Kanäle
│
├── commands/                 Discord-Slash-Befehle (einer je Datei)
│
├── database/
│   ├── Database.js           Einstellungen je Server + globale Wiedergabelisten
│   └── PlaybackStateManager.js  Momentaufnahme und Wiederherstellung der Wiedergabe
│
├── utils/
│   ├── logger.js             Protokollierung der Anwendung
│   ├── atomicJson.js         Absturzsicheres Lesen/Schreiben von JSON
│   ├── mediaPaths.js         Schutzgeländer für die dem Client gelieferten Pfade
│   ├── downloadDir.js        Ordner, in den heruntergeladene Dateien geschrieben werden
│   ├── downloadFormats.js    Angebotene Container → FFmpeg-Argumente
│   ├── mp3.js                Analyse einer unvollständigen MP3, um ein Vorladen fortzusetzen
│   ├── artwork.js            Ersatz-Cover, vom Bot statt von Dritten geliefert
│   ├── setAsideQueue.js      Von einer Wiedergabeliste beiseitegelegte Warteschlange
│   ├── historyOrder.js       Wiedereinfügen eines Verlaufs in eine LIFO-Schlange
│   ├── paths.js              Vergleich und Bereinigung von Pfaden
│   ├── duration.js           Formatierung und Auswertung von Dauern
│   ├── embeds.js             Discord-Einbettungen
│   └── permissions.js        Prüfung von Discord-Berechtigungen
│
├── versioning/               Bot-Versionen: Katalog, Installation, Wechsel
│   ├── index.js              Vom Dashboard genutzte Fassade
│   ├── locations.js          Geteilte vs. Installationswurzel, Schutzgeländer
│   ├── github.js             Releases des Repositorys und Herunterladen ihrer Archive
│   ├── installer.js          Entpacken, Abhängigkeiten, Bestandsaufnahme der Platte
│   └── targz.js              `.tar.gz`-Entpacken ohne externe Abhängigkeit
│
└── web/
    ├── WebServer.js          HTTP- + WebSocket-Server, Zusammenführung des Zustands
    ├── auth.js               Zugangstoken (HTTP und WebSocket)
    ├── oauth.js              Discord-OAuth2-Ablauf
    ├── sessions.js           Kurzlebige Sitzungen je Tab
    ├── owner.js              Konto, dem die Installation gehört
    ├── guests.js             Buch der bereits erschienenen Gäste
    ├── permissions.js        Was ein Gast tun darf
    ├── cloudflare.js         Veröffentlichung des Dashboards im Internet
    ├── oauthRelay.js         OAuth-Rückkehr-Relais der schnellen Freigabe
    ├── uploadService.js      Annahme und Einbindung der importierten Dateien
    ├── chunkedUpload.js      In Stücken gesendete Dateien, wieder zusammengesetzt
    ├── routes/api.js         HTTP-Routen (stream, download, upload, video-info)
    ├── routes/auth.js        Authentifizierungsablauf eines Gastes
    ├── websocket/
    │   ├── wsHandler.js      Router der WebSocket-Nachrichten
    │   ├── handlerUtils.js   Von den Handlern gemeinsam genutzte Helfer
    │   └── handlers/         Ein Modul je Bereich + Routing-Tabelle
    └── public/               Unverändert ausgeliefertes Frontend (HTML, CSS, JS)
```

Der zur Laufzeit angelegte Ordner `data/` ist nicht versioniert:

```
data/
├── settings.json           Einstellungen je Server + globale Wiedergabelisten
├── playback_state.json     Letzter bekannter Wiedergabezustand
├── dashboard-token         Beim ersten Start erzeugtes Zugangstoken
├── owner.json              Konto, dem die Installation gehört
├── guests.json             Buch der bereits erschienenen Gäste
├── sessions.json           Offene Discord-Sitzungen
├── uploads/                Importierte Dateien, nach Prüfsumme benannt
├── cache/                  Vorgeladene entfernte Titel als MP3
├── downloads/              Heruntergeladene Dateien, wenn kein anderer Ordner gewählt ist
└── logs/                   Ein Protokoll je Start + latest.log
```

Ein zweiter nicht versionierter Ordner, `versions/`, trägt die installierten
Releases — einen je Kennzeichnung. Er bleibt leer, solange das
Entwicklungs-Repository läuft. Siehe [10 — Versionen](10-versions.md).

Der Ordner `tools/` trägt das Windows-Werkzeug, ohne Bezug zum Prozess des Bots
— kein Modul aus `src/` verweist darauf:

```
Create shortcut.vbs       Doppelklickbarer Einstiegspunkt, im Stammverzeichnis
Start bot.vbs             Direkter Start, ohne den Umweg über eine Verknüpfung
tools/
├── create-shortcut.ps1   WPF-Assistent: Wahl des Orts, Schreiben der .lnk
├── start-bot.vbs         Ziel der Verknüpfung: ruft die .ps1 ohne Fenster auf
├── start-bot.ps1         Prüfungen, Installation, Start des Bots
└── icon.ico              Symbol der Verknüpfung, bei Fehlen neu gezeichnet, nicht versioniert
```

**Warum `.vbs`-Dateien.** Die Verknüpfung startet `wscript.exe start-bot.vbs`,
das PowerShell mit dem Fensterstil `0` aufruft. Das ist unter Windows der
einzige Weg, ein Skript zu starten, ohne dass überhaupt eine Konsole existiert:
eine `.bat` oder eine `.lnk`, die auf `powershell.exe -WindowStyle Hidden` zeigt,
lässt stets ein Terminal aufblitzen — auf dem Bildschirm und in der Taskleiste
sichtbar —, bevor es verborgen wird. Die `.lnk` zielt ausdrücklich auf
`wscript.exe` und nicht auf die `.vbs`, denn manche Rechner verknüpfen `.vbs`
mit `cscript.exe`, das seinerseits eine Konsole öffnen würde.

`Start bot.vbs` und `tools/start-bot.vbs` sind bewusst derselbe Aufruf, bis auf
einen relativen Pfad: die erste ist der Einstiegspunkt, den man im Projektordner
doppelklickt, die zweite das stabile Ziel der `.lnk`. Sie getrennt zu halten
verhindert, dass eine bestehende Verknüpfung von einer Datei im Stammverzeichnis
abhängt, wo der Benutzer am ehesten etwas umbenennt oder verschiebt. Keine von
beiden trägt Logik: alles steht in `start-bot.ps1`.

**Das Startfenster.** Da der Bot ohne Konsole läuft, wird das, was diese trug,
anderswo aufgenommen: der Ablauf des Starts und die Fehler durch das WPF-Fenster
von `start-bot.ps1`, die Einzelheiten durch `data/logs/`, das Beenden durch die
Ausschaltschaltfläche des Dashboards (`shutdownBot`, siehe
[05](05-tableau-de-bord.md)).

Dieses Fenster erscheint bei **jedem** Start und nicht mehr nur beim ersten
Gebrauch. Es führt die tatsächlich anstehenden Schritte auf — Abhängigkeiten und
Registrierung der Befehle erscheinen nur, wenn `node_modules` fehlt — und
kennzeichnet jeden mit einem wartenden Punkt, einem drehenden Ring, einem grünen
Haken, einem bernsteinfarbenen Haken für einen nicht blockierenden Fehlschlag
oder einem roten Kreuz. Bei einem Kreuz hält der Ablauf an, und der Fuß des
Fensters trägt den Grund, einen Auszug aus dem Protokoll und die Schaltfläche,
die weiterhilft: Node.js herunterladen, `.env` öffnen, die Protokolle öffnen.

Drei Punkte sollte man kennen, bevor man daran rührt:

- **Das Signal „bereit" ist der Port des Dashboards.** Der Bot öffnet ihn gleich
  beim Start seines Prozesses, noch vor der Verbindung zu Discord
  (`webServer.listen` in `src/index.js`): eine schlichte TCP-Verbindung zu
  `127.0.0.1:PORT` beweist daher, dass das Dashboard angezeigt werden kann, was
  die Existenz des Prozesses nicht beweist. Was auf das Ende des Starts wartet,
  sagt das Dashboard dann selbst. Das Fenster
  verschwindet, sobald der Port antwortet, und der Browser wird vom Bot selbst
  geöffnet (`WebServer.start`), niemals vom Skript.
- **Ein bereits offener Port hält den Start an.** Ohne diese Vorabprüfung würde
  ein zweiter Start an einem belegten Port sterben, während das obige Warten
  sogleich gelänge — ein falscher Erfolg. Das Fenster meldet dann, dass der Bot
  bereits läuft, und bietet drei Karten an: Dashboard öffnen, neu starten,
  ausschalten.
- **Die Konfiguration wird vor der Installation geprüft.** Die Reihenfolge ist
  nicht gleichgültig: `npm run deploy` braucht das Discord-Token, und es wird nur
  dann erneut ausgeführt, wenn `node_modules` fehlt. Danach zu prüfen hätte die
  Slash-Befehle dazu verurteilt, auf einem frisch geholten Ordner nie
  registriert zu werden.

Ein sofortiger Fehlschlag — abgewiesenes Token, defektes Modul — bliebe
unsichtbar: der Startschritt überwacht daher den Prozess, und der Schritt des
Dashboards gibt nach neunzig Sekunden auf, statt endlos zu warten.

**Einen bereits gestarteten Bot steuern.** Die Karten „Neu starten" und
„Ausschalten" fügen keinen Zugangspunkt hinzu: sie nutzen den Kanal des
Dashboards, einen authentifizierten WebSocket, über den `restartBot` und
`shutdownBot` laufen
(`src/web/websocket/handlers/systemHandlers.js`). Das Herunterfahren des
Prozesses ein zweites Mal offenzulegen, über HTTP, hätte die Angriffsfläche
vergrößert, ohne etwas beizutragen. Das Token reist in der Query — eine Form,
die `auth.extractToken` sowohl für `/api` als auch für den WebSocket-Handshake
annimmt.

Das Ausschalten verlangt eine Bestätigung, wie das Wartungsfenster des
Dashboards: die Wiedergabe eines ganzen Servers abzuschneiden darf nicht von
einem verrutschten Klick abhängen. Der Neustart hingegen läuft unmittelbar los —
die Wiedergabe setzt dort wieder ein, wo sie war. Beide legen über sich selbst
Rechenschaft ab, indem sie die Schrittmaschine erneut abspielen: der Port, der
fällt, und dann wiederkommt.

Nur eine einzige Ergänzung auf der Seite des Bots: `GET /api/clients`, das die
Zahl der verbundenen Dashboards und die Adresse zurückgibt, unter der eines zu
öffnen ist. Der Klick öffnet immer einen Tab: die Zahl, die diese Maschine nicht
von einem Gast oder einem Telefon unterscheiden kann, informiert nur die Karte.
Die Adresse ist die von `oauth.publicUrl()`, wo die Discord-Sitzung lebt — auf
der Lauschschnittstelle geöffnet, verlangte der Tab von einem bereits
angemeldeten Eigentümer eine erneute Anmeldung. Das Token reist im Header
`Authorization`: als Query übergeben, bringt es eine Weiterleitung auf die
bereinigte Adresse ein, deren Cookie `Invoke-RestMethod` verliert.

Vier Fallen von Windows PowerShell 5.1 und von GDI+ sind in diesen Skripten
entschärft und müssen es bleiben:

| Falle | Folge | Vorhandene Gegenmaßnahme |
|---|---|---|
| Eine `.ps1` ohne BOM wird in der ANSI-Codepage gelesen | Die gesamte Oberfläche verliert ihre Akzente | Beide `.ps1` sind in **UTF-8 mit BOM**; die `.vbs` in reinem ASCII |
| `Start-Process -PassThru -RedirectStandardOutput` liefert einen stets leeren `ExitCode` | Ein erfolgreicher Befehl wird als Fehlschlag gelesen | Keine .NET-Umleitung: `cmd` leitet selbst um (`1> … 2>&1`) |
| Ein per `&` aufgerufener Skriptblock läuft im Gültigkeitsbereich des Aufrufers, nicht in dem seiner Definition | Die `Start`/`Poll`-Blöcke eines Schritts sehen die Parameter der Funktion nicht, die sie erzeugt hat | Sie lesen ihre Daten aus dem laufenden Schritt (`CurrentStep`) und schreiben nur in `$script:`-Variablen |
| `GraphicsPath` und `GeometryGroup` füllen standardmäßig nach Even-Odd | Die Überlappungen der Musiknote durchlöchern einander | `FillMode = Winding` auf GDI+-Seite, `FillRule="Nonzero"` auf XAML-Seite |

Zwei Namen sind in diesen Skripten ebenfalls zu meiden: `$host`, eine
schreibgeschützte reservierte Variable, und jeder Parameter, der den Namen eines
Oberflächenelements aufgriffe — PowerShell unterscheidet keine Groß- und
Kleinschreibung, und der Parameter setzt sich durch.

---

## Startsequenz

`npm start` führt [`src/index.js`](../../../src/index.js) in dieser Reihenfolge
aus:

**1. Windows-Korrektur.** Vor jedem `require` wird `child_process.spawn`
umhüllt, um `windowsHide: true` zu erzwingen. Ohne dies lässt jeder Aufruf von
FFmpeg oder yt-dlp ein Konsolenfenster erscheinen. Die Korrektur muss den
übrigen Importen vorausgehen, um auch Fremdbibliotheken abzudecken.

**2. Registrierung der Geschwindigkeitsfilter.** 286 FFmpeg-Filter `speed_x_xx`
werden deklariert (siehe
[02 — Audiowiedergabe](02-lecture-audio.md#wiedergabegeschwindigkeit)).

**3. Prüfung der Umgebung.** Ein fehlendes `DISCORD_TOKEN` bricht den Start ab.

**4. Erzeugung des Discord-Clients** mit den Intents `Guilds`,
`GuildVoiceStates` und `GuildMessages`.

**5. Öffnen des Webservers** (`webServer.listen`), dann Laden der Befehle aus
`src/commands/`. Das Dashboard wird ab hier ausgeliefert, im Zustand _Start_:
bis `ClientReady` werden WebSocket-Nachrichten und HTTP-Routen, die Discord,
eine Warteschlange oder den Player brauchen, zurückgestellt, und die Seite zeigt
ein Banner (siehe [05](05-tableau-de-bord.md)). Die Desktop-App öffnet ihr
Fenster so in ein bis zwei Sekunden.

**6. Initialisierung von discord-player**, Registrierung der Extraktoren, der
Ereignis-Listener und des Vorlade-Managers.

**7. Verbindung zu Discord.** Beim Ereignis `ClientReady`:
- Bekanntgabe der laufenden Version und Kehren abgebrochener Installationen;
- Wahl des Eröffnungskanals — der Favorit beim Einschalten, der zuletzt besuchte
  bei der Wiederaufnahme (siehe [06](06-persistance.md#database));
- der Webserver erhält den Client, hebt die Startsperre auf und bedient die
  inzwischen geöffneten Dashboards (`webServer.start`);
- Wiederherstellung des gesicherten Wiedergabezustands, das Vorladen bis zum
  Ende ausgesetzt;
- Einplanung der regelmäßigen Sicherung (alle 5 s) und des Sicherheitsnetzes der
  Anwesenheitsregel (alle 30 s).

```
index.js
  ├─ patch spawn (win32)
  ├─ dieLoudly : uncaughtException, unhandledRejection
  ├─ AudioFilters : speed_0_20 … speed_3_05, muffled
  ├─ installBridge()            (discord-player-Knoten → Mischbus)
  ├─ new Client(...)
  ├─ webServer.listen(PORT, HOST)   (Dashboard ausgeliefert, „Start")
  ├─ loadCommands()
  ├─ initPlayer()
  │    ├─ extractors.register(Youtubei, Spotify, SoundCloud, AppleMusic, Attachment)
  │    ├─ registerPlayerEvents()
  │    └─ preloadManager.init()
  └─ client.login()
       └─ ClientReady
            ├─ versioning.currentVersion() + cleanTempDirs()
            ├─ database.applyStartupChannel({ resuming })
            ├─ webServer.start(client, PORT, HOST)   (Sperre aufgehoben)
            ├─ playbackStateManager.restoreAll()
            │    └─ finally : preloadManager.setSuspended(false)
            ├─ presenceManager.evaluate(guildId)   (für jeden Server)
            ├─ setInterval(saveState, 5000)
            └─ setInterval(presence.evaluate, 30000)
```

Das Vorladen bleibt während der gesamten Wiederherstellung ausgesetzt: es
entfernt aus dem Cache jeden Titel, der in den Schlangen fehlt, und diese sind
erst vollständig, wenn `restoreAll()` beendet ist. Die anschließende
Anwesenheitsschleife holt jene nach, die währenddessen einen Kanal betreten
haben — kein Sprachereignis wird sie nachträglich melden.

---

## Abhängigkeitskarte

Die Pfeile weisen vom Verbraucher zum Anbieter.

```
                    index.js
                       │
        ┌──────────────┼──────────────┬───────────────┐
        ▼              ▼              ▼               ▼
   commands/      audio/         web/WebServer   database/
        │              │              │               │
        └──────────────┴──────┬───────┴───────────────┘
                              ▼
                          utils/
              (logger, atomicJson, paths, duration, mediaPaths)
```

`utils/` hängt von nichts anderem ab als von `config.js`. Es ist die
Blattschicht: alles darf sie importieren, ohne Gefahr eines Zyklus.

**Zwei Zyklen bestehen** und werden durch `require()`-Aufrufe aufgelöst, die in
die Funktionen hinein verschoben sind:

- `DuckingManager` → `WebServer` (um den Zustand bei Spracherkennung erneut zu
  senden);
- `PlayerEvents` → `WebServer` → `wsHandler` → Handler → `PlaybackStateManager`.

Diese `require()`-Aufrufe im Rumpf sind gewollt. Sie an den Dateikopf zu
verschieben würde ungelöste zirkuläre Importe erzeugen.

---

## Lebenszyklus einer Wiedergabe

Beispiel: ein Benutzer startet einen Titel vom Dashboard aus.

```
Browser ─────WS {type:'play', data:{query}}──► wsHandler
                                                  │
                                     handlers/playbackHandlers.handlePlay
                                                  │
                              ┌───────────────────┼────────────────────┐
                              ▼                   ▼                    ▼
                    searchLocalAwareTrack   queue.connect()      queue.play()
                    (Extraktoren)           (Sprachkanal)              │
                                                                      ▼
                                                          discord-player → FFmpeg
                                                                      │
                                                        Ereignis 'playerStart'
                                                                      │
                              ┌───────────────────────────────────────┤
                              ▼                                       ▼
                     client.setupDucking()                  webServer.broadcastState()
                     (VolumeController + DuckingManager)              │
                                                                      ▼
                                                             Browser ◄──WS {type:'state'}
```

---

## PlaybackSession

discord-player stellt je Server ein `GuildQueue`-Objekt bereit. Das Projekt
hängte ihm seine eigenen Eigenschaften unmittelbar an, ohne Kapselung:

| Eigenschaft | Rolle |
|---|---|
| `virtualCurrentTrack`, `virtualTracks`, `virtualHistory` | Virtueller Player des persönlichen Modus |
| `virtualIsPlaying`, `virtualIsPaused`, `virtualProgressMs`, `virtualLastUpdated` | Zustand des virtuellen Players |
| `channelStates` | Wiedergabe-Momentaufnahme je Sprachkanal |
| `activeChannelId` | Als aktiv geltender Kanal |
| `silencePlayer`, `silenceStream` | Stille-Sender des persönlichen Modus |
| `transitioningToEveryone`, `transitionTrack`, `transitionTargetProgress` | Wechsel persönlich → gemeinsam |
| `isPendingTransition`, `transitionTimeout` | Sperre gegen doppelten Sprung |
| `restorePaused`, `restoreProgress`, `restoreShouldBePaused` | Wiederherstellung beim Start |
| `isMixFadingOut`, `mixAppliedTrackId`, `trackStartedAt` | Übergang im DJ-Stil |
| `absentEmptyChannel`, `frozenPositionMs`, `frozenIsPlaying` | Eingefrorene Wiedergabe, während der Bot aus einem leeren Kanal fort ist |
| `pauseOnNextTrack` | Aufgeschobene Pause |

**Warum das ein Problem war.** Keine dieser Eigenschaften war irgendwo
deklariert: ihr Vorhandensein ließ sich nur durch Lesen der Zugriffsstellen
entdecken. Jeder Lesevorgang musste sich absichern
(`if (!queue.virtualTracks) queue.virtualTracks = []` — 18 Vorkommen). Ein
Versionssprung von discord-player, der einen gleichlautenden Namen einführt,
hätte den Bot stillschweigend zerstört.

### Der Zustand gehört nunmehr dem Projekt

[`PlaybackSession`](../../../src/audio/PlaybackSession.js) deklariert die 26
Eigenschaften in einem einzigen `SCHEMA`, mit Typ und Anfangswert. Der Zustand
lebt in diesem Objekt; die Warteschlange besitzt ihn nicht mehr.

```
   queue.virtualTracks
          │  auf GuildQueue.prototype eingerichteter Zugriff
          ▼
   session.virtualTracks        ← PlaybackSession, dem Projekt gehörend
```

**Zuordnung per `WeakMap`.** Die Sitzung ist an das Warteschlangenobjekt
gebunden, nicht an die `guildId`: eine neue Warteschlange beginnt mit einem
frischen Zustand — dasselbe Verhalten wie zuvor — und der Zustand wird mit ihr
freigegeben, ohne Speicherleck.

**Zugriffe auf dem Prototyp.** Sie erfassen sämtliche Warteschlangen, gleich auf
welchem Weg sie entstanden sind, auch jene, die discord-player selbst erzeugt —
außer Reichweite eines Abfangens von `queues.create()`. Die Eigenschaften sind
**nicht aufzählbar**: sie tauchen in einer versehentlichen Serialisierung der
Warteschlange nicht mehr auf.

### Einheitliche Schnittstelle

Die Sitzung stellt Zugriffe bereit, die den Unterschied zwischen gemeinsamem und
persönlichem Modus verbergen:

| Methode | Ersetzt |
|---|---|
| `getCurrentTrack()` | `isPersonal ? queue.virtualCurrentTrack : queue.currentTrack` |
| `getTracks()` | `isPersonal ? queue.virtualTracks : queue.tracks.toArray()` |
| `getHistory()` | `isPersonal ? queue.virtualHistory : queue.history.tracks.toArray()` |
| `getIsPlaying()` / `getIsPaused()` | Verzweigung Modus + Übergang |

Verwendet von `PreloadManager.getActivePreloadTracks` und
`WebServer.getPlaybackPosition`.

`isFrozen()` tritt zu dieser Verzweigung hinzu. Hat sich der Bot aus einem von
seinen Menschen geleerten Kanal zurückgezogen, bleibt die Schlange im Speicher
am Leben, doch der discord-player-Knoten ist mit der Sprachverbindung
verschwunden: die Position kommt nicht mehr von ihm, sondern aus
`frozenPositionMs`. Das Einfrieren verlangt beides — die gesetzte Markierung
**und** das Fehlen einer Verbindung —, denn die Markierung kann gesetzt bleiben,
wenn der Bot bereits zurück ist, und ein „eingefroren“ würde das Dashboard dann
auf eine Position vor seiner Rückkehr festnageln, während der Ton weiterläuft.

### Verbleibende Migration

Die 375 bestehenden Zugriffsstellen arbeiten weiterhin über die Zugriffe: die
Schreibweise `queue.virtualTracks` ist unverändert, nur die Speicherung ist
umgezogen. Ihre Umschreibung auf `session.virtualTracks` und anschließend das
Entfernen der Zugriffe kann Datei für Datei geschehen — der wesentliche Gewinn
(deklariertes Schema, gesicherte Anfangswerte, Schutz vor Namenskollisionen) ist
bereits eingefahren.

---

## Worauf bei Änderungen zu achten ist

**Einen Discord-Befehl hinzufügen** — eine Datei in `src/commands/` anlegen, die
`{ data, execute }` exportiert, und anschließend `npm run deploy` erneut
ausführen. Der Lader von [`index.js`](../../../src/index.js) enthält einen fest
verdrahteten Sonderfall für `queue.js`, das fünf Befehle exportiert.

**Eine WebSocket-Nachricht hinzufügen** — siehe
[05 — Dashboard](05-tableau-de-bord.md#eine-nachricht-hinzufügen).

**Eine dauerhafte Einstellung hinzufügen** — sie in `_defaults()` in
[`Database.js`](../../../src/database/Database.js) eintragen; bereits
registrierte Server erben den Vorgabewert beim Lesen automatisch.
