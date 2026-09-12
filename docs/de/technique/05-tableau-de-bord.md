# 05 — Dashboard

[← Inhalt](README.md)

Das Dashboard ist eine Webanwendung, die der Bot selbst ausliefert. Es steuert
die Wiedergabe in Echtzeit und bildet sämtliche Discord-Befehle nach.

---

## Server

[`WebServer.js`](../../../src/web/WebServer.js) ist ein Singleton, das
zusammenfügt:

- einen **HTTP**-Server auf Express-Basis: statische Dateien und `/api/*`-Routen;
- einen **WebSocket**-Server (`ws`), der denselben Port mitbenutzt;
- die Zusammenführung des vollständigen Zustands (`getState`) und dessen
  Aussendung.

Gelauscht wird auf `HOST:PORT`, **standardmäßig `127.0.0.1:3000`**. Beim Start
wird der Browser nach 5 Sekunden selbsttätig geöffnet, sofern kein Client
verbunden ist, unter einer URL, die das Zugangstoken enthält.

### Verteilung der Zuständigkeiten

| Datei | Rolle |
|---|---|
| [`WebServer.js`](../../../src/web/WebServer.js) | Lebenszyklus, Zustandszusammenführung, Aussendung |
| [`auth.js`](../../../src/web/auth.js) | Zugangstoken für HTTP und WebSocket |
| [`oauth.js`](../../../src/web/oauth.js), [`sessions.js`](../../../src/web/sessions.js) | Discord-OAuth-Ablauf, Sitzungen je Tab |
| [`owner.js`](../../../src/web/owner.js), [`guests.js`](../../../src/web/guests.js) | Eigentümer der Installation, Gästebuch |
| [`permissions.js`](../../../src/web/permissions.js) | Was ein Gast tun darf |
| [`tailscale.js`](../../../src/web/tailscale.js) | Veröffentlichung des Dashboards im Internet |
| [`routes/api.js`](../../../src/web/routes/api.js) | HTTP-Routen |
| [`routes/auth.js`](../../../src/web/routes/auth.js) | Authentifizierungsablauf eines Gastes |
| [`uploadService.js`](../../../src/web/uploadService.js) | Annahme und Einbindung der Importe |
| [`websocket/wsHandler.js`](../../../src/web/websocket/wsHandler.js) | Nachrichten-Router |
| [`websocket/handlers/`](../../../src/web/websocket/handlers/) | Fachlogik, ein Modul je Bereich |

---

## HTTP-Routen

Alle sind durch das Token geschützt ([07 — Sicherheit](07-securite.md)).

| Route | Rolle |
|---|---|
| `GET /api/state` | Vollständiger Zustand, als Rückfall, wenn der WebSocket nicht verfügbar ist |
| `GET /api/invite` | Einladungslink des Bots auf einen neuen Discord-Server |
| `GET /api/stream` | Audiostrom eines Titels, für den Player des Browsers |
| `GET /api/download` | Umgewandelter Download, 32 Format-/Qualitätskombinationen (MP3, M4A, FLAC, WAV, OGG, OPUS, WEBM, MP4) |
| `GET /api/video-info` | Auflösung einer Video-URL über yt-dlp, Speicher-Cache von einer Stunde |
| `POST /api/upload` | Dateiimport, roher Strom mit Kopfzeile `X-File-Name` |
| `GET /api/docs` | Inhaltsverzeichnis der eingebetteten Dokumentation, in der angefragten Sprache |
| `GET /api/docs/content` | Markdown-Quelle eines Dokuments, bezeichnet durch Kennung und Sprache |
| `GET /api/download-dir` | Aktueller Download-Ordner und der Standard, mit dem er verglichen wird |
| `POST /api/download-dir` | Wahl des Ordners, vor dem Merken geprüft; leerer Rumpf kehrt zum Standard zurück |
| `GET /api/browse-dirs` | Unterordner eines Pfades der Host-Maschine, für die Auswahl |
| `GET /api/version` | Laufende Version — `dev` oder die Kennzeichnung der Release |
| `GET /api/clients` | Zahl der verbundenen Dashboards, vom Startfenster abgefragt |

`/api/docs` erfasst `docs/` bei jedem Aufruf, und zwar aus der **gerade
laufenden Fassung** und nicht aus dem gemeinsamen Stammverzeichnis: die
angezeigte Dokumentation ist also die des laufenden Codes. Die gelieferten
Kennungen bilden die Positivliste des Inhaltsdienstes — dieser baut nie einen
Pfad aus der Anfrage, er sucht die Kennung in dem Verzeichnis, das er soeben
erstellt hat. Das macht einen Ausbruch aus dem Ordner gegenstandslos, statt ihn
bloß zu verbieten.

Beide Routen nehmen einen Parameter `lang` an, den des Dashboards: `docs/` ist
nach Sprache geordnet — `docs/fr/`, `docs/en/`… —, die Kennungen bleiben überall
dieselben, und der Leser fragt nie nach etwas anderem als der Sprache seiner
Oberfläche. Der empfangene Wert erfährt dieselbe Behandlung wie die Kennung: er
wird mit den Ordnern verglichen, die der Server selbst gelesen hat, und nie zu
einem Pfad zusammengesetzt. Die Erfassung geht vom Ordner der gewählten Sprache
aus und **nie von `docs/`**: vom gemeinsamen Stammverzeichnis aus durchlaufen,
gäbe der Baum die Sprachordner selbst als ebenso viele Gruppen zurück, und das
Inhaltsverzeichnis des Lesers verwandelte sich in eine Sprachauswahl — wo die
Sprache doch nur in den Einstellungen gewählt wird. Eine in `docs/` fehlende
Sprache fällt als Ganzes auf Französisch zurück.

`/api/invite` setzt die Adresse aus der tatsächlich verbundenen Anwendung
zusammen (`client.generateInvite`, Geltungsbereiche `bot` und
`applications.commands`): eine fest in die Seite geschriebene Kennung bezeichnet
irgendwann eine andere Anwendung, und Discord antwortet dann „unbekannte
Anwendung". Es ist eine HTTP-Route und kein Feld des Zustands, denn `/api/state`
verweigert die Antwort, solange der Bot keinem Server beigetreten ist — genau der
Fall, in dem dieser Link der einzige Ausweg ist.

`/api/stream` liefert der Reihe nach: die Datei aus dem Vorlade-Cache, sofern sie
besteht, sonst die lokale Datei, sofern sie unter einem erlaubten
Stammverzeichnis liegt, sonst eine MP3-Umwandlung des entfernten Stroms im
laufenden Betrieb.

### Range-Anfragen

Die ersten beiden Zweige gehen über `serveFileWithRange()`, das mit
`206 Partial Content` und dem richtigen `Content-Range` antwortet, Enden
außerhalb der Grenzen beschneidet, die Suffixform (`bytes=-500`) behandelt und
bei einem unerreichbaren Bereich `416` liefert. Ein unlesbarer Bereich wird
übergangen: die gesamte Datei wird ausgeliefert.

**Das ist für das Springen innerhalb des Titels unerlässlich.** Ohne eine
`206`-Antwort muss der Browser von Anfang an herunterladen, um die angefragte
Stelle zu erreichen. Der Zweig des Vorlade-Caches kündigte `Accept-Ranges: bytes`
an, übersah aber die Kopfzeile `Range`: beim Neuladen des Dashboards setzte die
Wiedergabe erst wieder ein, wenn der Download die gespeicherte Stelle erreicht
hatte.

Die entfernte Umwandlung ist ihrem Wesen nach sequenziell
(`Transfer-Encoding: chunked`) und kann keinen Bereich bedienen — ein Grund mehr,
weshalb das Vorladen den Cache füttern soll.

### Authentifizierungsrouten

Vier Routen entgehen dem Präfix `/api` und werden von
[`routes/auth.js`](../../../src/web/routes/auth.js) getragen:

| Route | Aufgabe |
|---|---|
| `GET /auth/discord` | Aufbruch zu `discord.com`, Token festgestellt und im `state` verstaut |
| `GET /auth/discord/callback` | Rückkehr von Discord: Code eingetauscht, Sitzung eröffnet, zurück zum Dashboard |
| `GET /auth/state` | Wer in diesem Tab angemeldet ist und was er tun darf |
| `POST /auth/logout` | Schließt die Sitzung dieses Tabs |

Die ersten beiden sind **ohne Token offen** (`PUBLIC_PATHS` in
[`auth.js`](../../../src/web/auth.js)): wer den im Chat des Sprachkanals
geposteten Link anklickt, hat per Definition nichts, womit er sich ausweisen
könnte — genau das kommt er holen. Siehe
[07 — Sicherheit](07-securite.md#authentifizierung).

---

## WebSocket-Protokoll

### Nachrichten Server → Client

| Typ | Nutzlast |
|---|---|
| `state` | Vollständiger Zustand (siehe unten), bei Ereignissen gesendet |
| `progress` | `{ progress, isPlaying, isPaused, botStats }` — jede Sekunde gesendet, ~200 Byte |
| `log` | Ein Protokolleintrag `{ timestamp, level, text }` |
| `logsHistory` | Die letzten 200 Einträge, beim Verbinden |
| `error` | `{ message }`, als Hinweis angezeigt |
| `status` | `{ status: 'restarting' \| 'shutting_down', … }` |
| `memory` | Speicherproben, solange das Seitenpaneel sie anfordert |
| `speakers` | Wer gerade spricht, für das Feld der Sprachaktivität |
| `permissionDenied` | Eine Nachricht wurde einem Gast verweigert — das fehlende Recht |
| `shareResult`, `controlRevoked` | Folgen einer Teilungsgeste, für den Meister und den Gast |
| `tunnelState` | Zustand des Tunnels, beim Öffnen seines Fensters |
| `versionCatalog` | Katalog der Versionen, bei jedem Öffnen des Menüs neu von GitHub gelesen |
| `trackFormats` | Für einen Titel tatsächlich verfügbare Formate und Raten |

### Nachrichten Client → Server

54 Typen, deklariert in der Routing-Tabelle
[`handlers/index.js`](../../../src/web/websocket/handlers/index.js). Jeder
Bereich entspricht einem Modul von `handlers/`:

| Bereich | Nachrichten |
|---|---|
| Wiedergabe | `play`, `pause`, `resume`, `skip`, `previous`, `stop`, `seek`, `setPlayMode`, `syncProgress`, `startPlaybackSource` |
| Warteschlange | `removeTrack`, `playNow`, `moveOrInsertTrack`, `clearQueue`, `removeFromHistory`, `clearHistory` |
| Wiedergabelisten | `createPlaylist`, `renamePlaylist`, `deletePlaylist`, `reorderPlaylists`, `addPlaylistTrack`, `addTrackToPlaylist`, `removeTrackFromPlaylist`, `movePlaylistTrack`, `setActivePlaybackSource`, `insertTransition`, `setTransitionTarget` |
| Discord-Server | `selectChannel`, `setDefaultChannel`, `updateSettings`, `toggleVoiceDetection`, `leaveGuild` |
| Titel | `setTrackQuality`, `requestTrackFormats`, `requestTrackLoudness`, `setTrackLoudness`, `downloadTrack` |
| Teilung der Steuerung | `sendInviteLink`, `admitGuest`, `shareControl`, `revokeControl` |
| Tunnel | `tunnelState`, `tunnelLogin`, `tunnelMount`, `tunnelUnmount` |
| Versionen | `listVersions`, `installVersion`, `uninstallVersion` |
| System | `requestState`, `clientLog`, `memoryStream`, `startupFadeinConsumed`, `restartBot`, `shutdownBot` |

Die letzten vier Bereiche sind **dem Sitzungsmeister vorbehalten**: sie
erscheinen nicht im Teilungsfenster, und ein Gast, der sie von Hand sendete,
würde von [`permissions.js`](../../../src/web/permissions.js) abgewiesen (siehe
[07 — Sicherheit](07-securite.md#geteilte-rechte)). Teilen, das Dashboard im
Internet veröffentlichen, die laufende Version wechseln oder den Bot abschalten
sind keine Wiedergabebefehle.

`leaveGuild` lässt den Bot einen Discord-Server verlassen — der Papierkorb in den
Einstellungen, nach Bestätigung des Namens. Die Wiedergabe-Warteschlange wird vor
dem Abgang zerstört, danach werden die auf diesem Server verbliebenen Dashboards
auf einen anderen umgestellt (`WebServer.reassignClients`), da sie sonst
keinerlei Zustand mehr erhielten. Zu unterscheiden vom benachbarten Schalter, der
den Server lediglich in den Listen dieses Browsers verbirgt — eine örtliche
Einstellung, ohne Wirkung auf den Bot.

Das Kontextmenü eines lokalen Titels öffnet nicht dessen Ordner: ein Browser kann
den Dateimanager des Rechners, der ihn anzeigt, nicht befehligen. Es bietet
stattdessen „Zugriffspfad kopieren" an, was `track.url` in die Zwischenablage
legt — der Benutzer fügt diesen Pfad ein, wo er will. Alles liegt auf der
Client-Seite, es wird keine WebSocket-Nachricht ausgetauscht.

### Aufbau des Zustands

```js
{
  guildId, selectedVoiceChannelId,
  guilds: [ { id, name, voiceChannels: [ { id, name, userCount, botConnected, isPlaying } ] } ],
  currentTrack, progress: { current, currentMs, total, totalMs, percent },
  mixTransition: null | { sortante: { url, positionMs, dureeMs, ratio },
                          entrante: { url, positionMs, dureeMs, ratio, track } },
  isPlaying, isPaused, isTransitioning, repeatMode, volume,
  listenerWait: null | { playing },   // Wiedergabe eingefroren, Kanal ohne Menschen
  settings: { duckingEnabled, duckingLevel, duckingDelay, duckingFade,
              broadcastMode, playbackSpeed, mixEnabled, mixDuration, mixType, … },
  queue: [...], history: [...], playlists: [...],
  activePlaybackSource, playlistCurrentIndex,
  speakers: [userId], ignoredVoiceUsers: [userId],
  members: [ { id, displayName, avatar } ],
  botStats: { memory, uptime, timestamp }
}
```

Jeder Titel wird durch `formatTrackWithPreload()` um `isPreloaded`,
`isPreloading` und `preloadProgress` ergänzt.

`progress.currentMs` und `progress.totalMs` sind stets in der Zeit der Datei
ausgedrückt, ohne angewandte Wiedergabegeschwindigkeit — gleich in welchem
Übertragungsmodus. Der Browser ist es, der beim Anzeigen der beiden Dauern durch
`playbackSpeed` teilt, und in demselben Maßstab werden auch die Anfragen zur
Neupositionierung erwartet. Das Verhältnis `currentMs / totalMs` ergibt daher
unmittelbar den Fortschrittsbalken. Die von `queue.node.getTimestamp()`
gelieferte Position folgt demselben Maßstab, ihre Gesamtdauer jedoch nicht, da
diese bereits durch die Geschwindigkeit geteilt ist: `buildProgress()` berechnet
sie aus dem Titel neu.

`mixTransition` wird nur bei gemeinsamer Übertragung gefüllt, während einer
Überblendung des Mischbusses: zwei Stücke erklingen dann zugleich, und die
Warteschlange des Servers erklärt das zweite erst am Ende der Überlagerung zum
laufenden. Das Dashboard nutzt dies, um den eingehenden Titel schon zu Beginn der
Blende anzukündigen und beide Zeilen der Wiedergabeliste zugleich zu animieren —
was die persönliche Übertragung aus ihren beiden `<audio>`-Elementen von selbst
ableitet.

---

## Weiterleitung der Nachrichten

[`wsHandler.js`](../../../src/web/websocket/wsHandler.js) enthält **keinerlei
Fachlogik**. Es stellt einen Kontext zusammen und delegiert:

```js
await handler({
    ws, data, webServer, player,
    queue: player.queues.get(currentGuildId),
    currentGuildId,
    dispatch: (payload) => handleMessage(ws, payload, webServer),
});
```

`dispatch` erlaubt es einem Handler, einen anderen wiederzuverwenden — `playNow`
stützt sich auf `play`. `data` wird durchgängig durch `{}` ersetzt, wenn es
fehlt, was jedem Handler erspart, sich davor zu schützen.

### Eine Nachricht hinzufügen

1. Die Funktion in dem zum Bereich gehörenden Modul von
   [`handlers/`](../../../src/web/websocket/handlers/) schreiben, mit der
   Signatur `(ctx)`.
2. Sie exportieren.
3. Die Zeile `meineNachricht: meinModul.handleMeineNachricht,` in
   [`handlers/index.js`](../../../src/web/websocket/handlers/index.js) ergänzen.

Der Router wird nie geändert.

---

## Die Aktualisierungsschleife

`WebServer.start()` richtet ein `setInterval` von einer Sekunde ein, das für
jeden Server:

1. die Position des virtuellen Players im persönlichen Modus vorrücken lässt;
2. das Auslösen eines DJ-Übergangs erkennt;
3. `preloadManager.update()` aufruft;
4. **nur den Fortschritt** sendet (`broadcastProgress`).

Der vollständige Zustand geht bei Ereignissen hinaus — Titel gewechselt,
Warteschlange verändert, Einstellung berührt — über `broadcastState`. Diese
Trennung ruht auf `getPlaybackPosition()`, das die Position berechnet, ohne die
Titel neu zu formatieren.

### Was die Sekundenrunde teuer machte

Vor dieser Trennung sendete jeder Takt den vollständigen Zustand erneut:
sämtliche Sprachkanäle, sämtliche Mitglieder, die Warteschlange, den Verlauf und
**alle Wiedergabelisten**. Jeder Titel lief durch `getTrackPreloadInfo()`, das
etwa vier `fs.existsSync` und ein `fs.statSync` aneinanderreihte.

| Titel | Vorher — Blockade / Nachricht | Nachher |
|---|---|---|
| 10 | 0,3 ms / 8 KB | ~0 ms / 216 Byte |
| 50 | 1,6 ms / 40 KB | ~0 ms / 216 Byte |
| 200 | 6,5 ms / 119 KB | ~0 ms / 216 Byte |
| 500 | 16,2 ms / 277 KB | ~0 ms / 216 Byte |

Die regelmäßige Nutzlast hängt nicht mehr von der Zahl der Titel ab.

### Die drei angewandten Maßnahmen

1. **Nur der Fortschritt in der Sekundenrunde** — `broadcastProgress` sendet nur
   `{ progress, isPlaying, isPaused, botStats }`.
2. **Speicherindex des Vorlade-Caches** — `PreloadManager.cacheIndex` ersetzt das
   erneute Lesen der Festplatte; der Status eines Titels sinkt von 32,4 µs auf
   1,3 µs. Eine `http(s)`-URL überspringt nunmehr die Prüfung auf eine lokale
   Datei, die ohnehin nichts finden konnte.
3. **Kein unverändertes erneutes Senden** — `broadcastState` vergleicht eine
   Signatur des Zustands, `botStats` ausgenommen (dessen Zeitstempel sich bei
   jedem Aufruf ändert und jeden Vergleich nutzlos machen würde), und sendet
   nichts, wenn sie unverändert ist.

Dieses Intervall wird nie gestoppt: es gibt keine Methode `stop()`.

---

## Robustheit

Die Initialisierung eines Clients ist in `_initClient()` gekapselt, aus
`wss.on('connection')` unter `try/catch` aufgerufen. Eine dort auftretende
Ausnahme — etwa `getState()` auf einem unerwarteten Zustand — war früher eine
nicht abgefangene Ausnahme, die **den Prozess beendete**: eine Verbindung zum
Dashboard im falschen Augenblick genügte, um den Bot anzuhalten. Der schuldige
Client erhält nun eine Fehlermeldung und wird dann getrennt; der Bot läuft
weiter.

Eingehende Nachrichten sind auf dieselbe Weise geschützt: `ws.on('message')`
umhüllt den Aufruf des Routers.

Weiter oben sind `uncaughtException` und `unhandledRejection` an `dieLoudly()`
in [`index.js`](../../../src/index.js) angeschlossen. Diese beiden Handler
**fangen nichts auf**: sie schreiben `[FATAL]` ins Protokoll und lassen den
Prozess dann sterben. Das ist gewollt — nach einem Fehler weiterzumachen, dessen
Gestalt niemand vorhergesehen hat, ließe einen Bot in unbekanntem Zustand
laufen, was schlimmer ist als der Halt. Was sie beitragen, ist die **Spur**: da
der Bot ohne Konsole läuft, ist das, was Node von sich aus auf `stderr` schreibt,
bevor es stirbt, nirgends zu sehen, und ein bei der Anmeldung abgelehntes Token
ging so ohne ein Wort in `data/logs/` dahin.

> `SIGTERM` wird weiterhin nicht behandelt — nur `SIGINT`, mit dem Ausblenden
> aus [06 — Persistenz](06-persistance.md#ausblenden).

Ein *Heartbeat* von 30 Sekunden (`ping`/`pong`) schließt tote Verbindungen.

---

## Frontend

Rund 28 000 Zeilen JavaScript, ohne Umwandlung ausgeliefert. Keine ES-Module, kein
Bundler: 43 `<script>`-Elemente, die in
[`index.html`](../../../src/web/public/index.html) der Reihe nach geladen werden
— 41 Module aus `js/`, die Übersetzungen und `app.js` —, die über den globalen
Namensraum `window.MusicPlayer` miteinander sprechen.

| Datei | Rolle |
|---|---|
| `state.js` | Gemeinsamer Zustand, Vorlieben, Internationalisierung |
| `websocket.js` | Verbindung, selbsttätige Neuverbindung, Senden |
| `app.js` | Dirigent: Player, Einstellungen, persönliche Wiedergabe |
| `player.js`, `mediaSession.js`, `loudnessGain.js` | Fortschrittsbalken, Dauern, Systemsteuerung, Pegelverstärkung |
| `queue.js`, `searchHistory.js`, `downloadTarget.js` | Warteschlange, Verlauf, Eingabefeld und sein Ziel |
| `playlists.js`, `playlistTabsScroll.js`, `transitions.js` | Reiter der Wiedergabelisten und Weichen |
| `video.js`, `qualityMenu.js` | Videowiedergabe, Visualisierung, Qualitäts- und Formatmenüs |
| `logs.js`, `clientErrors.js` | Protokoll-Terminal, Meldung der Browserfehler |
| `drawer.js`, `drawerWidgets.js`, `memoryBreakdown.js` | Seitenleiste mit Statistiken |
| `docs.js` | Leser dieser Dokumentation, Seitenumbruch in Spalten |
| `loginGate.js`, `account.js`, `sharedControl.js`, `shareTunnel.js` | Discord-Anmeldung, Konto, Teilung der Steuerung, Tunnel |
| `versions.js`, `githubMenu.js` | Versionsmenü und GitHub-Gesten |
| `settingsModal.js`, `speedPad.js`, `customSelect.js`, `outputLevel.js` | Bedienelemente der Oberfläche |
| `deviceMode.js`, `touchDrawers.js`, `touchDragDrop.js`, `dragPreview.js`, `scrollLock.js`, `scrollFade.js` | Anpassung an Touch und kleine Bildschirme |
| `layoutPersistence.js` | Sicherung der Anordnung |
| `tooltipSystem.js`, `faviconAnimator.js`, `headerButtonAnimations.js`, `particlePath.js`, `themeBlend.js` | Ausstattung |

Die dreizehn Stilvorlagen werden per `@import` in
[`style.css`](../../../src/web/public/style.css) zusammengefügt, der einzigen
von `index.html` referenzierten Vorlage.

Die Ladereihenfolge ist eine stillschweigende Abhängigkeit: `state.js` muss allen
anderen vorausgehen, `app.js` muss zuletzt kommen.

### Unvollendete Aufteilung

[`app.js`](../../../src/web/public/app.js) umfasst 3 819 Zeilen und bündelt
Zuständigkeiten, die der Ordner `js/` bereits herauszulösen begonnen hat. Es ist
das Gegenstück im Frontend zu der auf der Serverseite vollzogenen Aufteilung, die
noch zu Ende zu bringen ist.

### Doppelung, die im Auge zu behalten ist

`window.MusicPlayer.formatMs` in
[`player.js`](../../../src/web/public/js/player.js) muss mit `formatMs` aus
[`src/utils/duration.js`](../../../src/utils/duration.js) im Gleichklang bleiben:
der Client zeichnet die Zeitleiste, und zwar aus den Millisekunden und nicht aus
der vom Server gesendeten Zeichenkette.
