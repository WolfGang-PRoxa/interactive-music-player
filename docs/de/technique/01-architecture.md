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
│   ├── LocalFilePlayer.js    Hilfsmittel zum Durchsuchen von Audioordnern
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
│   ├── paths.js              Vergleich und Bereinigung von Pfaden
│   ├── duration.js           Formatierung und Auswertung von Dauern
│   ├── embeds.js             Discord-Einbettungen
│   └── permissions.js        Prüfung von Berechtigungen
│
└── web/
    ├── WebServer.js          HTTP- + WebSocket-Server, Zusammenführung des Zustands
    ├── auth.js               Zugangstoken (HTTP und WebSocket)
    ├── uploadService.js      Annahme und Einbindung der importierten Dateien
    ├── routes/api.js         HTTP-Routen (stream, download, upload, video-info)
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
├── uploads/                Importierte Dateien, nach Prüfsumme benannt
├── cache/                  Vorgeladene entfernte Titel als MP3
├── downloads/              Heruntergeladene Dateien, wenn kein anderer Ordner gewählt ist
└── logs/                   Ein Protokoll je Start + latest.log
```

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

- **Das Signal „bereit" ist der Port des Dashboards.** Der Bot öffnet ihn erst,
  wenn er mit Discord verbunden ist (`ClientReady` in `src/index.js`): eine
  schlichte TCP-Verbindung zu `127.0.0.1:PORT` ist daher der einzige verlässliche
  Zeuge, wo doch die Existenz des Prozesses nichts beweist. Das Fenster
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
Zahl der verbundenen Dashboards zurückgibt. Es ist dasselbe Maß, nach dem
`WebServer.start` entscheidet, ob der Browser geöffnet wird, und das Fenster
nutzt es, um nicht noch einen Tab zu öffnen, wenn schon einer da ist. Die Zahl
wird bei jedem Klick neu erfragt statt beim Öffnen gemerkt: ein zwischenzeitlich
geschlossener Tab würde sonst die Schaltfläche lahmlegen. Kann die Frage nicht
gestellt werden, wird der Tab geöffnet — lieber ein Duplikat als ein
unerreichbares Dashboard.

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

**5. Laden der Befehle** aus `src/commands/`.

**6. Initialisierung von discord-player**, Registrierung der Extraktoren, der
Ereignis-Listener und des Vorlade-Managers.

**7. Verbindung zu Discord.** Beim Ereignis `ClientReady`:
- Start des Webservers;
- Wiederherstellung des gesicherten Wiedergabezustands;
- Einplanung der regelmäßigen Sicherung (alle 5 s).

```
index.js
  ├─ patch spawn (win32)
  ├─ AudioFilters : speed_0_20 … speed_3_05, muffled
  ├─ new Client(...)
  ├─ loadCommands()
  ├─ initPlayer()
  │    ├─ extractors.register(Youtubei, Spotify, SoundCloud, AppleMusic, Attachment)
  │    ├─ registerPlayerEvents()
  │    └─ preloadManager.init()
  └─ client.login()
       └─ ClientReady
            ├─ webServer.start(client, PORT, HOST)
            ├─ playbackStateManager.restoreAll()
            └─ setInterval(saveState, 5000)
```

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
| `pauseOnNextTrack` | Aufgeschobene Pause |

**Warum das ein Problem war.** Keine dieser Eigenschaften war irgendwo
deklariert: ihr Vorhandensein ließ sich nur durch Lesen der Zugriffsstellen
entdecken. Jeder Lesevorgang musste sich absichern
(`if (!queue.virtualTracks) queue.virtualTracks = []` — 18 Vorkommen). Ein
Versionssprung von discord-player, der einen gleichlautenden Namen einführt,
hätte den Bot stillschweigend zerstört.

### Der Zustand gehört nunmehr dem Projekt

[`PlaybackSession`](../../../src/audio/PlaybackSession.js) deklariert die 23
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

### Verbleibende Migration

Die 455 bestehenden Zugriffsstellen arbeiten weiterhin über die Zugriffe: die
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
