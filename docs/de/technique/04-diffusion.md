# 04 — Übertragungsmodi

[← Inhalt](README.md)

Der Bot verfügt über zwei grundverschiedene Wiedergabemodi. Ihren Unterschied zu
verstehen ist unerlässlich, bevor man den Zustandscode anrührt.

---

## Die beiden Modi

| | `everyone` (gemeinsam) | `personal` (persönlich) |
|---|---|---|
| Wo der Ton herauskommt | Discord-Sprachkanal | Browser des Benutzers |
| Wer dekodiert | discord-player + FFmpeg | `<audio>`-Element des Dashboards |
| Wiedergabeposition | `queue.node.getTimestamp()` | Serverseitig berechneter Zähler |
| Ducking | Aktiv | Gegenstandslos |
| Laufender Titel | `queue.currentTrack` | `queue.virtualCurrentTrack` |
| Warteschlange | `queue.tracks` | `queue.virtualTracks` |

Die Einstellung heißt `broadcastMode`, je Server.

---

## Gemeinsamer Modus

Das erwartete Verhalten eines Musik-Bots: discord-player dekodiert den Strom und
sendet ihn in den Sprachkanal. Alle hören dasselbe, das Ducking greift.

---

## Eine Stream-Adresse, eine einzige Datei

Im persönlichen Modus holt der Browser den Ton von `/api/stream`, einer Adresse,
die nichts als die Titelkennung trägt. Diese Adresse kann jedoch zwei sehr
verschiedene Dateien bezeichnen: die MP3 aus dem Vorlade-Cache oder die
Originaldatei auf der Platte. Die erste existiert noch nicht, während das
Vorladen sie schreibt, und verschwindet später, wenn der Cache aufgeräumt wird.

Ein Browser lädt eine Mediendatei nicht in einem Stück: er fordert über mehrere
Minuten Abschnitte an, auf derselben Adresse. Die Datei je Anfrage zu wählen
lässt daher einen MP3-Abschnitt in einer WAV-Dekodierung landen, die ohne ihn
begonnen hat — und das hört sich weder wie Stille noch wie ein Fehler an,
sondern wie ein **enormes weißes Rauschen**: komprimierte Bytes, als rohe
Abtastwerte gelesen, sind Zufallsrauschen in voller Lautstärke.

Die Repräsentation wird deshalb beim ersten gelieferten Byte festgelegt und
jedem Abschnitt **desselben Ladevorgangs** unverändert geliefert, auch wenn der
Cache inzwischen aufgetaucht ist.

Was einen Ladevorgang kennzeichnet, ist der Parameter `load` der Adresse, vom
Dashboard gesetzt und bei jedem Wiedergabestart hochgezählt — keinesfalls die
angeforderte Position. Ein Bereich ab null sieht wie ein Neustart aus, ist aber
auch das, was eine Wiedergabe **in Schleife** sendet, und dort hat der Browser
nichts vergessen: er behält seine Bytes unter dieser Adresse und seinen Dekoder
auf dem im ersten Durchgang erkannten Format. Genau das Neuwählen in diesem
Moment erzeugte vierzig Sekunden Rauschen und danach Stille, bei der zweiten
Schleife eines zwischenzeitlich vorgeladenen Titels. Da sich die Adresse mit
jedem Ladevorgang ändert, kann der Browser nie zwei Formen unter einer Ressource
vermischen.

Verschwindet die festgelegte Datei mitten in der Wiedergabe, wird die Anfrage
mit einem 404 abgelehnt statt im anderen Format bedient — das Dashboard lädt den
Titel an der erreichten Position unter einer neuen Adresse neu, was einige
hundert Millisekunden Stille statt des Rauschens kostet. Siehe
[`api.js`](../../../src/web/routes/api.js) und den Test `tests/streamSource.js`.

---

## Persönlicher Modus: der virtuelle Player

Im persönlichen Modus **dekodiert der Bot überhaupt keinen Ton**. Er hält einen
fiktiven Wiedergabezustand nach, und der Browser ist es, der das Audio über
`/api/stream` tatsächlich abspielt.

### Warum ein virtueller Player

Das Dashboard muss weiterhin einen stimmigen Titel, einen Fortschritt, eine
Warteschlange und einen Verlauf anzeigen. Statt ein zweites Datenmodell zu
schaffen, bildet das Projekt die Form der Warteschlange in Eigenschaften mit dem
Präfix `virtual` nach.

### Fortschreiten der Position

Der Fortschritt wird nicht gemessen, er wird von der Aktualisierungsschleife des
Webservers jede Sekunde **berechnet**:

```js
const elapsed = (now - queue.virtualLastUpdated) * Geschwindigkeit;
queue.virtualProgressMs += elapsed;
queue.virtualLastUpdated = now;

if (queue.virtualProgressMs >= Dauer) handleVirtualSkip(queue, guildId);
```

Der Faktor `Geschwindigkeit` greift `playbackSpeed` auf, damit der Zähler der
beschleunigten oder verlangsamten Wiedergabe des Browsers folgt. Der Client
schickt seine tatsächliche Position regelmäßig mit der Nachricht `syncProgress`
zurück, was die Drift ausgleicht.

### Titelende

`handleVirtualSkip()` in [`WebServer.js`](../../../src/web/WebServer.js) bildet
das Verhalten eines echten Players nach: Behandlung des Wiederholungsmodus,
Ablegen in `virtualHistory`, Entnehmen aus `virtualTracks` und Abgleich von
`playlistCurrentIndex`, falls eine Wiedergabeliste aktiv ist.

### Der Stille-Sender

Problem: ohne Audiostrom schließt Discord die UDP-Verbindung nach einigen
Sekunden, und die Rückkehr in den gemeinsamen Modus verlangte eine vollständige
Neuverbindung.

Lösung — `startSilencePlayer()` in [`index.js`](../../../src/index.js): ein
`Readable` im `objectMode` sendet alle 20 ms einen Opus-Stille-Frame.

```js
silenceStream.push(Buffer.from([0xF8, 0xFF, 0xFE]));  // Opus-Stille-Frame
```

`objectMode: true` ist wesentlich: ohne dies verkettet Node die Frames zu einem
einzigen Block, den Discord zurückweist. So bleibt die Verbindung offen und der
Bot im Kanal sichtbar, ohne hörbaren Ton auszugeben.

---

## Wechsel zwischen den Modi

### Gemeinsam → persönlich

`BroadcastManager.setMode()`:

1. kopiert `currentTrack`, die Position, die Warteschlange und den Verlauf in die
   `virtual*`-Eigenschaften;
2. leert `queue.tracks` und `queue.history`, um die tatsächliche Wiedergabe
   anzuhalten;
3. beendet den `dispatcher`, ohne den Bot zu trennen;
4. startet den Stille-Sender.

### Persönlich → gemeinsam

Der umgekehrte Vorgang ist der heikelste des Projekts, denn die Wiedergabe muss
**an genau der Stelle** fortgesetzt werden, an der der Browser stand.

```
transitioningToEveryone = true
transitionTrack         = fortzusetzender Titel
transitionTargetProgress = Position in ms
        │
        ▼
  queue.play(track)  ── Lautstärke auf 0 gezwungen
        │
        ▼
  Ereignis 'playerStart'
        │
        ├─ 100 ms warten (den Strom sich einrichten lassen)
        ├─ queue.node.seek(progress)
        ├─ den Titel aus dem Verlauf nehmen (der Seek trägt ihn zu Unrecht ein)
        ├─ die etwaige Dublette aus der Warteschlange nehmen
        ├─ transitioningToEveryone = false
        └─ die Lautstärke wiederherstellen (oder einblenden, falls eingestellt)
```

Die Lautstärke wird während des gesamten Manövers auf 0 gehalten: sonst hörte der
Benutzer den Anfang des Titels vor dem Sprung an die richtige Stelle. Die
Kennzeichen `restorePaused` und `transitioningToEveryone` werden von
[`VolumeController`](../../../src/audio/VolumeController.js) bei seiner Erzeugung
und bei jedem Knotenwechsel abgefragt, um die Lautstärke nicht zu früh wieder
anzuheben.

---

## Persönliche Kanäle

Unabhängig vom virtuellen Player kann `BroadcastManager` einen zeitweiligen
privaten Sprachkanal anlegen:

- Name: Präfix `config.broadcast.personalChannelPrefix` (🎵), gefolgt vom
  angezeigten Namen des Mitglieds;
- Berechtigungen: `@everyone` verweigert, Mitglied und Bot erlaubt;
- Nachverfolgung in `personalChannels`: `Map<guildId, Map<userId, channelId>>`;
- selbsttätiges Löschen, wenn das Mitglied den Sprachkanal verlässt, über den
  `VoiceStateUpdate`-Listener von [`index.js`](../../../src/index.js).

> Diese Nachverfolgung liegt **allein im Speicher**. Ein Neustart des Bots,
> während persönliche Kanäle bestehen, lässt sie verwaist zurück: sie müssen von
> Hand gelöscht werden.

---

## Der Preis des doppelten Modells

Jede Stelle, die Zustand liest oder schreibt, muss die beiden Modi unterscheiden.
Das Muster wiederholt sich im gesamten Code:

```js
const currentTrack = isPersonal ? queue.virtualCurrentTrack : queue.currentTrack;
const tracks       = isPersonal ? queue.virtualTracks       : queue.tracks.toArray();
const isPlaying    = isPersonal ? !!queue.virtualIsPlaying  : queue.node.isPlaying();
```

`getChannelPlaybackState()` in [`WebServer.js`](../../../src/web/WebServer.js) ist
sein dichtester Ausdruck: ein einziges `return` verbindet drei Achsen
(`isPersonal` × `transitioningToEveryone` × Vorhandensein eines Zeitstempels) in
verschachtelten Ternäroperatoren.

Eine einheitliche Schnittstelle, die den Unterschied verbirgt — in
[01 — Architektur](01-architecture.md#playbacksession) angesprochen —, würde
dieses Muster beseitigen. Jede Änderung am Zustandscode sollte es zumindest nicht
verschlimmern.

---

## Zustand je Sprachkanal

Der Bot merkt sich eine Wiedergabe-Momentaufnahme **je Kanal**, in
`queue.channelStates`:

```js
queue.channelStates[channelId] = {
    isPlaying, isPaused, repeatMode,
    currentTrack, currentProgress,
    queue: [...], history: [...],
    savedAt
};
```

Ein Kanalwechsel vom Dashboard aus (`selectChannel`) sichert den Zustand des
verlassenen Kanals, bevor der des betretenen wiederhergestellt wird. Das
Dashboard kann so eine Warteschlange für einen Kanal anzeigen, mit dem der Bot
nicht verbunden ist: `getChannelPlaybackState()` liefert dann die Daten aus dem
Zwischenspeicher statt des Live-Zustands.

Bei gemeinsamer Übertragung **hält** das Verlassen eines Kanals die Wiedergabe
dort **an**: der Player wird vor dem Wechsel pausiert — was den Kanal während des
Wartens auf `queue.connect()` verstummen lässt — und die Momentaufnahme wird
pausiert an ihrer Position festgehalten. Der Bot trennt sich in jedem Fall: er
folgt dem Dashboard in den betretenen Kanal, oder `detacher()` zieht ihn zurück,
wenn dieser verlassen ist. Kehrt man später in den verlassenen Kanal zurück,
findet man das Stück dort pausiert vor, auf die Sekunde genau dort, wo es
zurückgelassen wurde, und nicht eine Wiedergabe, die ohne Zuhörer weitergelaufen
wäre.

Das Betreten des angesteuerten Kanals bleibt der Präsenzregel unterworfen: der
Bot geht nur hin, wenn jemand da ist. Ein verlassener Kanal, dessen Momentaufnahme
eine Wiedergabe trägt, bleibt eingefroren, und das Dashboard erklärt es (siehe
weiter unten).

---

## Präsenz in den Sprachkanälen

Der Bot setzt sich nur dann in einen Sprachkanal, wenn jemand da ist, der ihn
hören kann. Die Regel hält
[`PresenceManager`](../../../src/audio/PresenceManager.js), und sie gilt für
beide Übertragungsmodi — im persönlichen Modus dient die Verbindung nur dazu, die
Sprache für das Ducking aufzufangen, doch in einem leeren Raum hat sie ebenso
wenig einen Grund zu bestehen.

| Ereignis | Wirkung |
|---|---|
| Start, angesteuerter Kanal verlassen | Keine Verbindung. Die Wiedergabe wird wiederhergestellt und dann **eingefroren**. |
| Erster Mensch, der den zugeordneten Kanal betritt | Verbindung, Ducking wieder angeschlossen, Wiedergabe an ihrer Position fortgesetzt. |
| Letzter Mensch, der geht | Abgang nach `config.presence.departureDelay` (standardmäßig 30 s). |
| Rückkehr vor Ablauf der Frist | Abgang abgesagt, nichts rührt sich. |

Der **zugeordnete Kanal** ist der Reihe nach: die laufende Zuordnung
(`queue.activeChannelId`), der Kanal, in dem der Bot sich befindet, der zuletzt
genutzte Kanal. Drei Arten zu sagen „derjenige, den man ihm zugewiesen hat", von
der jüngsten zur ältesten: der Bot folgt den Zuhörern also nicht von Kanal zu
Kanal. Fehlt jede Zuordnung (erste Nutzung), setzt er sich in den ersten Kanal,
in dem jemand auftaucht.

Der **bevorzugte Kanal steht dort nicht**, und das mit Absicht: er gilt nur beim
Start (siehe unten). Hier abgefragt, griff er bei jeder Sprachbewegung und alle
30 Sekunden; sobald die Zuordnung fehlte — Warteschlange von `/play`, von einem
Import erzeugt oder ohne Kanal wiederhergestellt —, holte er den Bot nach Hause,
und der erste Zuhörer, der den Favoriten betrat, rief ihn dorthin zurück,
gleichgültig, in welchem Kanal man ihn eingerichtet hatte. Ein mit einem Stern
markierter Kanal wurde so zum Gefängnis: kein dauerhaftes Arbeiten anderswo mehr
möglich.

### Der bevorzugte Kanal: beim Einschalten, nie beim Fortsetzen

Der Favorit (`defaultVoiceChannelId`) bezeichnet den Eröffnungskanal **einer
Sitzung**: einen ausgeschalteten Bot einzuschalten eröffnet eine, und darin
erschöpft sich sein Zweck. Ein **Neustart** eröffnet keine — der Prozess startet
neu, das Hören läuft weiter — und führt daher dorthin zurück, wo man war, wie es
ein Neuladen der Seite schon tat. Zuvor ging der Favorit in beiden Fällen vor und
holte bei jedem Neustart alle zu sich zurück, auch nach einem Update, das während
des Hörens anderswo eingespielt wurde.

Vom Start aus gesehen gleichen sich beide Starts aufs Haar: die Instanz, die sich
neu startet, unterscheidet sie, indem sie `IMP_RESTART` bei der von ihr
gestarteten setzt (siehe
[`systemHandlers`](../../../src/web/websocket/handlers/systemHandlers.js)). Dieselbe
Variable dient dazu, die Einblendung beim Start zu unterdrücken, und wird erst
später verbraucht, bei der Wiederherstellung.

Der Favorit wird an zwei Stellen gelesen, beide beim Start:

- [`Database.applyStartupChannel()`](../../../src/database/Database.js), einmal
  bei `ClientReady` aufgerufen, macht ihn beim Einschalten zum **aktuellen
  Kanal** und lässt ihn beim Fortsetzen beiseite;
- [`PlaybackStateManager.restoreAll()`](../../../src/database/PlaybackStateManager.js)
  wählt den wiederherzustellenden Kanal nach derselben Unterscheidung — beim
  Fortsetzen zuerst den beim Beenden spielenden, beim Einschalten den, den die
  vorige Zeile gerade festgelegt hat — und trägt
  diese Wahl dann als Zuordnung ein — auch dann, wenn der Kanal verlassen ist und
  die Verbindung auf später verschoben wird, denn sonst suchte die Präsenzregel
  den Bot anderswo als dort, wo das Dashboard ihn als wartend ankündigt.

Danach liest ihn niemand mehr. Einen Kanal mitten in einer Sitzung mit einem
Stern zu markieren verschiebt daher nichts: die Einstellung wird für den nächsten
Start vermerkt. Alles Übrige — Präsenzregel, Kanalauswahl, `getState` — folgt
allein dem aktuellen Kanal, den jeder Kanalwechsel nachführt.

### Die eingefrorene Wiedergabe

Fortzugehen heißt nicht, alles zu verlieren. Warteschlange, Verlauf und laufender
Titel bleiben im Speicher; nur der Player von discord-player verschwindet mit der
Sprachverbindung, und mit ihm das Einzige, was er noch wusste: wo die Wiedergabe
stand. Die Sitzung übernimmt für die Dauer der Abwesenheit:

```js
queue.absentSalonVide     // der Bot hat sich zurückgezogen oder ist nie eingetreten
queue.positionFigeeMs     // kurz vor dem Abgang abgelesene Position
queue.lectureFigeeEnCours // lief die Wiedergabe?
```

`session.estGelee()` ist die Prüfung, die vor jeder Abfrage von `queue.node`
ansteht: ein abgebauter Player liefert nur Nullen. Das Dashboard, die
Zustandssicherung und die Wiedergabebefehle gehen alle darüber —
`commanderFige()` wendet Pause, Fortsetzen, Seek, Stop, Skip und Previous
unmittelbar auf den eingefrorenen Zustand an, sodass das Dashboard während der
Abwesenheit des Bots benutzbar bleibt.

Ein Verbindungspunkt, der auf das Verbinden verzichtet, ruft `marquerAbsent()`
auf; umgekehrt hebt jede Sprachverbindung das Einfrieren auf, welchen Ursprungs
sie auch sei (der `connection`-Listener des Players).

### Es dem Dashboard sagen

Eine eingefrorene Wiedergabe gilt weiterhin als *laufend* — sie wird von selbst
wieder anlaufen —, doch nichts rückt vor. Vom Dashboard aus sah das wie ein
Defekt aus: Pause-Schaltfläche, sich drehendes Cover und ein Fortschrittsbalken,
der eine Sekunde gewann, um sie gleich wieder zu verlieren, endlos — der Client
interpolierte örtlich, während der Server jede Sekunde dieselbe eingefrorene
Position zurückschickte.

`session.attenteAuditeur()` liefert das Nötige, um es zu erklären, und
`WebServer` fügt den Namen des betroffenen Kanals hinzu. Das Dashboard zeigt dann
ein Band über dem Balken („Niemand in ‚X': die Wiedergabe wartet…"), hört auf,
die Position zu interpolieren, und hält die Wiedergabeanimationen an. Die
Meldung unterscheidet die beiden Einfrierungen: eine Wiedergabe, die bei
jemandes Ankunft weiterläuft, und eine pausierte Wiedergabe, die die Rückkehr des
Bots nicht wieder anwirft.

### Zwei Fallen von discord-player

**Das Zerstören des Stroms gilt als Titelende.** Den Dispatcher zu zerstören
versetzt den Audioplayer in den Zustand *Idle*, was discord-player als das Ende
des Stücks deutet: es schiebt den Titel in den Verlauf und fährt mit dem nächsten
fort. Der Modus „Übergang" wird daher für die Dauer der Zerstörung aufgehoben —
`performFinish` enthält sich dort jeder Verarbeitung.

**Der vorgegebene Sprachzustands-Handler zerstört die Warteschlange.**
`leaveOnEmpty` ruft `queue.delete()` auf, was Warteschlange, Verlauf und den
Zustand je Kanal mitreißt. Ein Abonnement auf `voiceStateUpdate` beim Player
schaltet diesen Handler ab; `PresenceManager` übernimmt die Fälle, die jener
sinnvoll behandelte (serverseitige Stummschaltung, Konferenzkanal, Versetzen des
Bots durch einen Moderator). `leaveOnEmpty` steht überall auf `false`, damit der
Code kein Verhalten mehr verspricht, das nicht mehr gilt.
