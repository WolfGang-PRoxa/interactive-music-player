# 02 — Audiowiedergabe

[← Inhalt](README.md)

Diese Seite behandelt die Kette von der Anfrage eines Benutzers bis zum
Opus-Strom, der im Sprachkanal ausgegeben wird, sowie den Vorlade-Cache.

---

## Verarbeitungskette

```
Anfrage ──► Extraktor ──► Strom ──► FFmpeg ──► Opus ──► Discord-UDP
            (Auflösung)   (HTTP     (Filter,   (Kodierung)
                           oder      Lautst.)
                           Datei)
```

Das Projekt bearbeitet das Audio nicht selbst: es konfiguriert
[discord-player](https://discord-player.js.org/), das FFmpeg und
`@discordjs/voice` orchestriert. Die FFmpeg-Binärdatei stammt aus dem Paket
`ffmpeg-static`, was jede systemweite Installation erspart.

---

## Extraktoren

Beim Start in [`index.js`](../../../src/index.js) registriert:

| Extraktor | Quelle | Anmerkung |
|---|---|---|
| `YoutubeiExtractor` | YouTube | Mit `useYoutubeDL: false` konfiguriert |
| `SpotifyExtractor` | Spotify | Nur Metadaten, Audio von YouTube übernommen |
| `SoundCloudExtractor` | SoundCloud | |
| `AppleMusicExtractor` | Apple Music | Nur Metadaten |
| `AttachmentExtractor` | Lokale Dateien und Anhänge | Für die Importe verwendet |

> **Deezer und Qobuz werden nicht unterstützt**, trotz der in `.env.example`
> vorhandenen Variablen. Es ist kein entsprechender Extraktor installiert oder
> registriert. Diese Variablen sind ein Überbleibsel.

### Auflösung einer Anfrage

`searchLocalAwareTrack()` in
[`handlerUtils.js`](../../../src/web/websocket/handlerUtils.js) kapselt die
Suche:

1. Zeigt die Anfrage auf eine vorhandene Datei → Suche auf `QueryType.FILE`
   erzwungen.
2. URLs von `music.youtube.com` werden zu `www.youtube.com` umgeschrieben, da der
   Extraktor sie sonst nicht auflöst.
3. Bleibt das Ergebnis leer und ist die URL vom Typ YouTube, Rückfall auf
   **yt-dlp** (`youtube-dl-exec`) im Modus `flatPlaylist`, anschließend Auflösung
   Titel für Titel. Dieser Weg deckt die Alben von YouTube Music ab
   (`OLAK5uy_…`).
4. Bei einer lokalen Datei wird der Titel durch den um sein technisches Präfix
   bereinigten Dateinamen ersetzt.

---

## Wiedergabegeschwindigkeit

FFmpeg beschränkt den Filter `atempo` auf den Bereich `[0.5, 2.0]`. Um 0,20× bis
3,05× abzudecken, registriert [`index.js`](../../../src/index.js) 286 Filter
namens `speed_<Wert>`, indem es außerhalb dieses Bereichs zwei `atempo`
hintereinanderschaltet:

```js
wenn Geschwindigkeit < 0.5   →  atempo=0.5,atempo=(v / 0.5)
wenn Geschwindigkeit > 2.0   →  atempo=2.0,atempo=(v / 2.0)
sonst                        →  atempo=v
```

Der Name des Filters kodiert den Wert mit einem Unterstrich: aus `1.25` wird
`speed_1_25`. Die gewählte Geschwindigkeit wird in den Einstellungen
gespeichert (`playbackSpeed`) und **bei jedem `playerStart` erneut angewandt**,
denn die FFmpeg-Filter werden mit jedem neuen Titel zurückgesetzt.

Ein zusätzlicher Filter, `muffled` (`lowpass=f=400`), dient den Übergängen im
DJ-Stil.

---

## Blenden und Übergänge

Drei verschiedene Mechanismen wirken auf die Lautstärke, alle über
[`VolumeController`](../../../src/audio/VolumeController.js), sofern dieser
verfügbar ist.

### Einblenden

Wird in `playerStart` ausgelöst, wenn `fadeinEnabled` oder `mixEnabled` aktiv
ist. Die Lautstärke beginnt bei 0 und erreicht `baseVolume` über
`fadeinDuration` Sekunden. Die Sperre `queue.mixAppliedTrackId` verhindert, dass
die Blende zweimal auf denselben Titel angewandt wird.

### Ausblenden

Wird beim Anhalten (`shutdownBot`) und beim Beenden des Prozesses angewandt,
durch `fadeOutAndSaveState()` in
[`PlaybackStateManager.js`](../../../src/database/PlaybackStateManager.js): 35
Stufen, exponentielle Kurve (`Faktor^2.5`) für einen als linear empfundenen
Abfall.

### Übergang im DJ-Stil

Bei persönlicher Übertragung führt der Browser die Überblendung aus, der über
zwei `<audio>`-Elemente verfügt und sie daher überlagern kann.

Bei gemeinsamer Übertragung übernimmt das der **Mischbus** (siehe den folgenden
Abschnitt). Sobald die verbleibende Zeit des Titels unter `mixDuration` Sekunden
sinkt, wird das nächste Stück über das laufende in den Bus gegossen:

- `mixType: 'volume'` → die beiden Verstärkungen kreuzen sich nach einem Gesetz
  konstanter Leistung;
- `mixType: 'effects'` → **zusätzlich** ein Tiefpass-Sweep, der das ausgehende
  Stück gegen 400 Hz schließt, während sich das eingehende öffnet.

---

## Mischbus (gemeinsame Übertragung)

Eine Discord-Sprachverbindung trägt nur einen Strom: zwei Stücke können sich
darauf nicht überlagern, wenn das zweite nur existieren kann, indem es die
Audioressource des ersten ersetzt. Deshalb war der Mix-Übergang bei gemeinsamer
Übertragung lange versagt.

[`src/audio/mix/`](../../../src/audio/mix/) hebt diese Grenze auf, indem es einen
einzigen, dauerhaften Strom zwischen die Stücke und Discord schiebt:

```
Titel A ──► FFmpeg ──► PCM ──┐
                             ├──► MixBus ──► AudioResource ──► Opus ──► UDP
Titel B ──► FFmpeg ──► PCM ──┘   (Summe,     (dauerhaft)
 (während des Übergangs)          Verstärk.)
```

| Modul | Rolle |
|---|---|
| [`format.js`](../../../src/audio/mix/format.js) | Austauschformat: PCM s16le, 48 kHz, Stereo, Frames von 20 ms |
| [`input.js`](../../../src/audio/mix/input.js) | Führt einen Titel auf einen FFmpeg-Eingang zurück (Cache, lokale Datei, Extraktor) |
| [`MixSource.js`](../../../src/audio/mix/MixSource.js) | Ein dekodiertes Stück: Puffer, Verstärkungshüllkurve, Filter-Sweep |
| [`MixBus.js`](../../../src/audio/mix/MixBus.js) | Der dauerhafte Strom: summiert die Quellen Frame für Frame |
| [`MixEngine.js`](../../../src/audio/mix/MixEngine.js) | Orchestrierung je Server, Steuerung der discord-player-Warteschlange |
| [`playerBridge.js`](../../../src/audio/mix/playerBridge.js) | Umhüllt die Methoden von `GuildQueuePlayerNode`, um sie an den Bus zu leiten |

**Taktgeber.** Der Bus erzeugt nur dann einen Frame, wenn der Sprachplayer einen
verlangt, also alle 20 ms. Alle Quellen rücken daher in jeder Runde um genau
dieselbe Anzahl Abtastwerte vor: zwischen zwei überlagerten Stücken kann sich
keine Drift einstellen, wie lang die Blende auch sei. Fehlen einer Quelle Daten,
hält der Bus vollständig an, statt eine von ihnen mit Stille aufzufüllen — ein
Aussetzer kostet eine Lücke, niemals eine Verschiebung.

**Transparenz.** Außerhalb einer Blende, mit einer einzigen Quelle bei voller
Verstärkung und nomineller Lautstärke, werden die dekodierten Bytes ohne jede
Rechnung weitergereicht: der gesendete Klang ist genau der, den FFmpeg erzeugt
hat.

**Wiedergabeposition.** Der Bus fertigt seine Frames, sobald man sie von ihm
verlangt, und der Opus-Kodierer hält einen Vorrat: was gefertigt wird, ist nicht,
was zu hören ist. `MixEngine.positionMs()` zieht daher diesen Vorlauf ab,
gemessen durch Vergleich der gefertigten Frames mit
`AudioResource.playbackDuration`, das nur die tatsächlich gesendeten Pakete
zählt. Ohne diese Korrektur sprang der Fortschrittsbalken beim Start — die Kette
füllt sich in einem Augenblick um mehrere Sekunden — und trat dann auf der
Stelle, bis die Wiedergabe aufgeholt hatte.

**Rollenverteilung.** discord-player behält die Warteschlange, den Verlauf, die
Wiederholungsmodi und seine Ereignisse. Die Maschine meldet ihm das Ende eines
Stücks, indem sie auf seinem Verteiler dieselben Signale aussendet, die das Ende
einer Ressource erzeugt hätte, und legt ihm eine dauerhafte `AudioResource` vor,
die `queue.currentTrack` weiterhin abfragt. Alles jedoch, was über die
FFmpeg-Kette von discord-player lief, übernimmt der Bus: Lautstärke und Ducking
(Hauptverstärkung), Pause, Neupositionierung, Wiedergabegeschwindigkeit und die
Wiedergabeposition — nunmehr in gesendeten Abtastwerten gezählt statt geschätzt.

**Rückfall.** `activeEngine()` liefert `null`, wenn kein Bus aufgebaut ist, und
jede umhüllte Methode fällt dann auf die ursprüngliche Umsetzung zurück. Die
persönliche Übertragung, bei der der Ton aus dem Browser kommt, baut nie einen
Bus auf.

---

## Vorladen

[`PreloadManager`](../../../src/audio/PreloadManager.js) lädt entfernte Titel im
Voraus herunter und wandelt sie in `data/cache/` nach MP3 um, aus drei Gründen:
augenblicklicher Start, Widerstandsfähigkeit gegen Netzunterbrechungen und
Versorgung des Audioplayers im Browser im persönlichen Modus.

### Abfangen

Bei der Initialisierung wird die Methode `stream()` jedes registrierten
Extraktors ersetzt:

```js
extractor.stream = async (track, ...args) => {
    const cachedPath = this.getCachedPath(track);
    if (cachedPath) return fs.createReadStream(cachedPath);
    return originalStream.apply(extractor, [track, ...args]);
};
```

Jede Wiedergabe eines bereits zwischengespeicherten Titels wird also von der
Festplatte bedient, ohne Netzanfrage, für discord-player völlig unbemerkt.

### Benennung und Gültigkeit

Der Schlüssel ist der **SHA-256 der URL** des Titels, und die Datei
`data/cache/<Schlüssel>.<Bitrate>.mp3` (`<Schlüssel>.mp3` für Dateien aus der
Zeit vor der Qualitätswahl, deren Bitrate unbekannt ist). Eine Datei unter 10 KB
gilt als unvollständig und wird übergangen. Lokale Dateien werden nie
zwischengespeichert (`getTrackKey()` liefert `null`).

Ein laufender Download schreibt in `<Schlüssel>.<Bitrate>.tmp`, begleitet von
`<Schlüssel>.<Bitrate>.tmp.src`, das die tatsächlich kodierte URL festhält. Die
Datei wird erst in `.mp3` umbenannt, wenn sie vollständig und geprüft ist.

### Auswahl der Ziele

`getActivePreloadTracks()` stellt die vorzuladende Liste zusammen:

| Quelle | Menge (einstellbar, max. 5) |
|---|---|
| Laufender Titel | immer |
| Nächste Titel der Warteschlange | `preloading.queueCount` (Vorgabe 3) |
| Anfang der von einer Wiedergabeliste beiseitegestellten Warteschlange | `preloading.queueCount` (Vorgabe 3) |
| Jüngste Titel des Verlaufs | `preloading.historyCount` (Vorgabe 3) |
| Fortsetzung der aktiven Wiedergabeliste | `preloading.playlistCount` (Vorgabe 3) |
| Anfang **jeder** gespeicherten Wiedergabeliste | `preloading.playlistCount` (Vorgabe 3) |

Der Player hat nur eine einzige tatsächliche Titelliste: belegt eine
Wiedergabeliste sie, ist sie es, die `session.getTracks()` liefert, und die
Warteschlange des Benutzers wird in den Einstellungen beiseitegestellt (siehe
[setAsideQueue](../../../src/utils/setAsideQueue.js)). Das Vorladen holt sie also
von dort, sonst verlöre sie ihren Cache, sobald eine Wiedergabeliste startet. Es
ist eine schlichte Liste, dieselbe in beiden Übertragungsmodi und dieselbe, die
die Fläche anzeigt: das Fenster `queueCount` bezieht sich daher genau auf die
angekündigten Stücke.

Der Verlauf wird vom jüngsten Titel zum ältesten geliefert — die Ordnung einer
LIFO-Schlange und die der Fläche. Es sind also seine **ersten** Stücke, die man
behalten muss: die einzigen, die ein Schritt zurück erreicht.

Die beiden letzten Zeilen kommen hinzu, sie schließen sich nicht aus: das
Vorladen einer Wiedergabeliste hängt nicht davon ab, was gerade läuft. Eine
Wiedergabeliste zu starten darf nicht den Cache der anderen leeren — zu ihnen
zurückzukehren kostete dann ein vollständiges Neuladen, und die Wiedergabe
begänne mit einem Aussetzer. Die laufende Wiedergabeliste wird zuerst bewertet:
ihre kommenden Stücke muss man zuerst zur Hand haben.

Doppelungen zwischen diesen Quellen bleiben wirkungslos: `update()` indiziert die
Ziele nach Titelschlüssel, bevor es handelt.

### Aktualisierungszyklus

`update(guildId)` wird bei jeder Zustandssendung aufgerufen. Sie:

1. vergleicht die Zielliste mit der vorigen und steigt sofort aus, wenn sie
   gleich ist — das macht den Aufruf im Sekundentakt erträglich. Es sei denn,
   eines der Ziele ist weder im Cache noch im Download: ein Netzfehler oder eine
   abgebrochene Umwandlung ließe es sonst fehlen bis zur nächsten Umstellung der
   Warteschlange, das heißt bei einer stabilen Warteschlange nie. Der neue
   Versuch hält eine Frist ein, die sich bei jedem Fehlschlag verdoppelt (30 s,
   dann 1 min… gedeckelt bei 15 min), damit eine tote URL nicht jede Sekunde
   erneut aufgegriffen wird;
2. bricht die Downloads ab, die kein Ziel mehr sind, außer denen, die vor
   weniger als 5 Sekunden begonnen haben (Schutz vor verfrühten Abbrüchen);
3. löscht die Cache-Dateien, die für **keinen** Server Ziel sind, sowie die
   Teildateien, die nutzlos geworden sind (Titel nicht mehr Ziel, oder Titel
   inzwischen vollständig zwischengespeichert);
4. startet die fehlenden Downloads.

Der Fortschritt wird dem Dashboard über den Rückruf
`preloadManager.onProgress` gemeldet, begrenzt auf eine Sendung alle 150 ms.

**Wenn nichts aus dem Netz eintrifft.** Die Quelle kann die Verbindung
verweigern: ffmpeg schreibt dann kein einziges Byte, und die entstehende Datei
überschreitet die Schwelle von 10 KB nicht. Der Fehlschlag wird als das gemeldet,
was er ist — die Verweigerung und ihr HTTP-Code —, und nicht als beschädigte
Datei: die Festplatte hat damit nichts zu tun, und das zu sagen erspart die Suche
auf der Cache-Seite. Bei einem YouTube-Titel weist ein 403 fast immer auf ein
veraltetes yt-dlp hin, das `npm run update-ytdlp` auf den neuesten Stand bringt:
die URLs, die YouTube ausgibt, sind an den Client gebunden, der sie angefragt
hat, und dessen Regeln ändern sich schneller als die mit dem Paket ausgelieferte
Binärdatei.

### Fortsetzung nach einem Neustart

Teildateien wurden beim Start gelöscht: ein bei 95 % abgebrochenes Vorladen
begann wieder bei null, und bei langen Titeln genügte ein normaler Rhythmus von
Neustarts, damit sie nie zwischengespeichert wurden. Sie werden nun bewahrt und
vervollständigt.

Eine MP3 ist nichts als eine Folge unabhängiger Frames, jeder mit einem 4 Byte
langen Kopf davor, der seine eigene Länge trägt.
[`analyzePartial()`](../../../src/utils/mp3.js) durchläuft sie, um zu bestimmen,
bis zu welchem Byte die Datei unversehrt ist — der letzte Frame ist fast immer
abgeschnitten, da der Prozess mitten im Schreiben getötet wurde — und welcher
Zeitposition dieses Byte entspricht.

`startDownload()` kürzt die Teildatei dann an dieser Frame-Grenze, startet FFmpeg
mit `-ss <Position>` **vor** `-i` (bei einer direkten URL wird der Anfang nicht
einmal erneut geladen) und hängt das Ergebnis an die Datei an. Die Nahtstelle ist
auf den Abtastwert genau. Zwei Optionen sind nötig: `-id3v2_version 0` und
`-write_xing 0`, ohne die jedes kodierte Segment mit einem ID3-Etikett begänne,
das mitten in der Datei landete.

Zwei Schutzgeländer rahmen die Fortsetzung ein:

- **Geprüfte Quelle.** Der Schlüssel leitet sich von der *angefragten* URL ab,
  nicht von der, die schließlich kodiert wurde: ein Spotify-Titel wird zu YouTube
  gebrückt, und nichts verbürgt, dass die Suche wieder auf dasselbe Video fällt.
  Die Teildatei wird nur fortgesetzt, wenn `.tmp.src` mit der aufgelösten URL
  übereinstimmt; sonst wird sie von Grund auf neu kodiert.
- **Geprüfte Vollständigkeit.** Ein abreißender Strom lässt FFmpeg sauber mit dem
  abschließen, was es erhalten hat: die Dateigröße sagt nicht mehr, ob sie
  vollständig ist, denn eine fortgesetzte Teildatei übertrifft zwangsläufig das
  Mindestmaß. Die kodierte Dauer wird mit der vom Titel angekündigten verglichen
  (95 % Toleranz); darunter bleibt die Datei eine Teildatei, statt zum Cache
  befördert zu werden.

Ein Fehlschlag bewahrt somit das bereits Kodierte für den nächsten Versuch. Ein
Abbruch (Titel nicht mehr Ziel) löscht die Teildatei hingegen, ebenso wie die
Bereinigung ihre Cache-Datei entfernt.

### Größenobergrenze

Die Bereinigung nach Relevanz genügt nicht: sie entfernt nur Titel, die für
keinen Server Ziel sind. Bei mehreren umfangreichen Wiedergabelisten kann die
Gesamtheit der Ziele allein schon jede vernünftige Grenze überschreiten.

`enforceCacheLimit()` bringt den Cache wieder unter `MAX_CACHE_MB` (standardmäßig
2048 MB), indem es die **ältesten Dateien zuerst** verdrängt, mit Ausnahme der
gerade laufenden Titel — ausdrücklich geschützt, um kein sofortiges erneutes
Herunterladen auszulösen.

Der Speicherindex `cacheIndex` (Schlüssel → `{ size, mtime }`) erlaubt es, die
Obergrenze anzuwenden, ohne das Dateisystem erneut zu befragen. Er wird beim
Start neu aufgebaut und dann bei jedem abgeschlossenen Download und jeder
Bereinigung nachgeführt.

Wird die Obergrenze überschritten, während **alle** Titel geschützt sind, wird
eine Warnung protokolliert und nichts gelöscht: lieber vorübergehend darüber
liegen, als eine laufende Wiedergabe abzuschneiden.

---

## Lautheit (LUFS)

LUFS (EBU R128) misst die *wahrgenommene* Lautheit, nicht die Amplitude: zwei
Dateien mit gleichem LUFS werden gleich laut gehört, unabhängig von ihrer
Dynamik. Drei Module teilen sich das Thema, und die Trennung ist wesentlich.

[`loudness.js`](../../../src/audio/loudness.js) macht nur die Umrechnung: es
kennt weder FFmpeg noch den Audioweg. Ein Titel trägt eine **Messung**
(`measured`, `peak`) und gegebenenfalls ein **Ziel** (`target`); die Verstärkung
in Dezibel ist ihre Differenz, begrenzt. Ohne Messung ist die Verstärkung null —
ein Ziel allein sagt nichts, und nach Gefühl zu korrigieren wäre schlimmer, als
nichts zu tun.

[`LoudnessAnalyzer`](../../../src/audio/LoudnessAnalyzer.js) erzeugt die Messung,
indem es `ffmpeg -af loudnorm=print_format=json` auf die Datei anwendet — den
Vorlade-Cache, wenn es ihn gibt, sonst die Datei auf der Platte. Eine Analyse
zur Zeit: das Dekodieren der Wiedergabe geht vor. Das Ergebnis wird in die
Datenbank geschrieben und nie neu berechnet, da eine Datei ihre Lautheit nicht
ändert. Eine entfernte Quelle ohne Vorladen wird nicht analysiert; sie nur zum
Messen herunterzuladen kostete den Preis eines Vorladens, das niemand verlangt
hat.

Die Anwendung unterscheidet sich je nach Audioweg:

- **Mischbus** — [`MixSource`](../../../src/audio/mix/MixSource.js) trägt einen
  `levelGain`, getrennt von der Blendenhüllkurve. Getrennt, weil er 1
  überschreiten kann, wo die Hüllkurve es nicht kann, und weil er etwas anderes
  beschreibt: die Hüllkurve sagt, wo eine Blende steht, die Pegelverstärkung
  sagt, wie laut der Titel gehört wird. Beide werden pro Frame multipliziert.
  Eine Änderung wird über zehn Frames (200 ms) verteilt, sonst wäre jede Raste
  des Reglers als Knacken zu hören.
- **Browser** —
  [`loudnessGain.js`](../../../src/web/public/js/loudnessGain.js) umhüllt die
  Eigenschaft `volume` beider `<audio>`-Elemente. Der Rest des Dashboards
  schreibt weiterhin die *gewollte* Lautstärke — Blendenrampen, Ducking,
  Herunterfahren — und die Hülle legt das Produkt ab. Ein `<audio>`
  überschreitet die Lautstärke 1 nie: die Absenkung ist exakt, eine Anhebung hat
  nur den Spielraum, den der Hauptregler lässt.

Die Angleichung ist eine **Schicht**, nie ein Schreibvorgang. Ist
`lufsSyncEnabled` gesetzt, liefert `effectiveTarget()` das gemeinsame Ziel,
ohne die einzelnen Ziele anzutasten, die in der Datenbank bleiben. Genau diese
Unterscheidung erlaubt es, die Option abzuwählen und jedem Titel die
Einstellung zurückzugeben, die er hatte.

---

## Lokale Dateien

[`LocalFilePlayer`](../../../src/audio/LocalFilePlayer.js) liefert das
Durchsuchen von Ordnern, das der Befehl `/playlist` nutzt: rekursiver Durchlauf,
Filterung nach `config.supportedExtensions`, Sortierung nach Namen, optionales
Mischen nach Fisher-Yates.

Die erkannten Erweiterungen sind in [`config.js`](../../../src/config.js)
deklariert: `supportedExtensions` für Audio, `supportedVideoExtensions` für
Video. Diese Listen dienen auch dem Sicherheitsgeländer für Pfade
([07 — Sicherheit](07-securite.md)).
