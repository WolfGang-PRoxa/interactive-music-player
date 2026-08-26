# 06 — Persistenz

[← Inhalt](README.md)

Keine Datenbank: alles wird in JSON-Dateien unter `data/` abgelegt, mit einem
Speicher-Cache, der während des Betriebs maßgeblich ist.

---

## Überblick

| Datei | Inhalt | Schreibrhythmus |
|---|---|---|
| `data/settings.json` | Einstellungen je Server + globale Wiedergabelisten | Bei jeder Änderung, über 120 ms gebündelt |
| `data/playback_state.json` | Letzter bekannter Wiedergabezustand | Alle 5 s und bei Ereignissen |
| `data/dashboard-token` | Zugangstoken | Einmal, beim ersten Start |

> `better-sqlite3` steht in den `optionalDependencies`, wird aber **nie
> importiert**. Es ist ein Überbleibsel eines aufgegebenen Ansatzes: die native
> Übersetzung bereitete unter Windows Schwierigkeiten.

---

## Atomares Schreiben

[`utils/atomicJson.js`](../../../src/utils/atomicJson.js) ist die einzige
zugelassene Stelle zum Schreiben von JSON.

### Das gelöste Problem

`fs.writeFileSync` **kürzt die Datei, bevor es sie neu schreibt**. Eine
Unterbrechung in diesem Zeitfenster hinterlässt ein unvollständiges und damit
unlesbares JSON. Das frühere Verhalten verschlimmerte den Verlust: der
Analysefehler wurde abgefangen, der Cache begann leer, und die erste
darauffolgende Sicherung überschrieb die beschädigte Datei endgültig.

### Der Ablauf

```
1. in  .<Name>.<pid>.tmp schreiben   (gleicher Ordner, also gleiches Dateisystem)
2. fsync                              (sicherstellen, dass die Bytes auf der Platte sind)
3. rename  →  <Name>                  (atomarer Vorgang)
```

Zu jedem Zeitpunkt ist die Zieldatei entweder die alte vollständige Fassung oder
die neue. Der `fsync` ist nicht wahlfrei: ohne ihn kann die Umbenennung dem
tatsächlichen Schreiben der Bytes vorausgehen, und ein Stromausfall hinterlässt
eine leere Datei.

`renameSync` überschreibt ein bestehendes Ziel unter Windows sehr wohl, da libuv
`MOVEFILE_REPLACE_EXISTING` verwendet.

### Lesen und Quarantäne

`readJsonSafe()` benennt eine unlesbare Datei in `<Name>.corrompu-<Datum>` um,
statt sie überschreiben zu lassen. Der Start läuft mit den Vorgabewerten weiter,
und die Datei bleibt wiederherstellbar.

`cleanStaleTemp()` löscht beim Start die `.tmp`-Dateien, die ein harter Abbruch
hinterlassen hat.

### Serialisierung

`createSafeReplacer()` behandelt `BigInt`-Werte (in Zeichenketten gewandelt) und
wiederholte Verweise. **Achtung**: es verwirft jedes bereits angetroffene Objekt,
nicht nur echte Zyklen. Das ist das überkommene Verhalten, beibehalten, um die
Ausgabe nicht zu verändern; ein Objekt, das berechtigterweise an zwei Stellen
steht, würde bei seinem zweiten Auftreten weggelassen.

Der Replacer führt einen inneren Zustand — er muss für **jede** Serialisierung
neu erzeugt werden.

---

## Database

[`Database.js`](../../../src/database/Database.js) — Singleton, Einstellungen je
Server und globale Wiedergabelisten.

### Aufbau der Datei

```json
{
  "__global__": {
    "playlists": [ { "id": "playlist_…", "name": "…", "tracks": [...] } ],
    "lastGuildId": "…",
    "lastVoiceChannelId": "…"
  },
  "<guildId>": { "duckingEnabled": true, "baseVolume": 70, ... }
}
```

Die Wiedergabelisten sind **global**, allen Servern gemeinsam. Eine selbsttätige
Migration (`_migratePerGuildPlaylists`) verschiebt beim ersten Start
Wiedergabelisten, die aus einer serverweisen Ablage stammen, nach `__global__`.

### Cache und Schreiben

Der `Map`-Cache ist während des Betriebs maßgeblich; die Datei ist nur ein Abbild
davon. `_save()` **plant** ein über 120 ms gebündeltes Schreiben ein: eine Salve
von Änderungen bewirkt nur einen einzigen Gang auf die Platte.

`flush()` erzwingt das sofortige Schreiben. Sie hängt an `process.on('exit')`,
was auch die `process.exit()`-Aufrufe von Neustart und Abschalten abdeckt — diese
Wege gehen nicht über `close()`.

### Lesen ohne Nebenwirkung

`getSettings()` liefert `{ ...Vorgaben, ...Cache }`: die Vorgabewerte werden bei
jedem Lesen erneut angewandt, sodass es genügt, `_defaults()` um einen Schlüssel
zu erweitern, damit alle bestehenden Server ihn erben.

Diese Methode **schreibt nicht** für einen unbekannten Server auf die Platte —
früher tat sie es, obwohl sie im Sekundentakt in einer Schleife aufgerufen wird.
Der Eintrag wird schlicht zwischengespeichert; die erste tatsächliche Änderung
wird ihn festschreiben.

### Wichtigste Methoden

| Methode | Wirkung |
|---|---|
| `getSettings(guildId)` | Mit den Vorgabewerten zusammengeführte Einstellungen |
| `updateSettings(guildId, patch)` | Zusammenführen und aufgeschobenes Sichern |
| `getGlobalPlaylists()` | Liste der Wiedergabelisten |
| `createPlaylist`, `renamePlaylist`, `deletePlaylist`, `reorderPlaylists` | Verwaltung der Wiedergabelisten |
| `addTrackToPlaylist`, `removeTrackFromPlaylist`, `movePlaylistTrack` | Verwaltung der Titel |
| `toggleVoiceDetection`, `isVoiceDetectionDisabled` | Ausschlüsse vom Ducking |
| `setLastVoiceChannel`, `getLastVoiceChannel` | Zuletzt besuchter Kanal |
| `appliquerSalonFavori()` | Macht den Favoriten zum aktuellen Kanal — nur beim Start |

`updateSettings` wendet eine besondere Regel an: einen bevorzugten Kanal zu
setzen (`defaultVoiceChannelId`) entfernt ihn von allen anderen Servern — es gibt
nur einen globalen Favoriten.

`appliquerSalonFavori()` wird einmal aufgerufen, bei `ClientReady`. Es schreibt
den Favoriten in den zuletzt besuchten Kanal, und darin erschöpft sich die Rolle
dieser Einstellung: über den Eröffnungskanal zu entscheiden und dann
zurückzutreten. Ihn anderswo zu lesen machte ihn zu einer dauerhaften Vorliebe,
die Bot und Dashboard endlos zu ihm zurückholte — siehe
[Präsenz in den Sprachkanälen](04-diffusion.md#präsenz-in-den-sprachkanälen).

---

## PlaybackStateManager

[`PlaybackStateManager.js`](../../../src/database/PlaybackStateManager.js) —
Wiedergabe-Momentaufnahme, um dort wieder anzusetzen, wo man aufgehört hat.

### Gesicherter Inhalt

Je Server der Zustand **jedes Kanals** (`queue.channelStates`): laufender Titel,
Position, Warteschlange, Verlauf, Wiederholungsmodus, Wiedergabe oder Pause.

### Rhythmus

Alle 5 Sekunden (Zeitgeber in [`index.js`](../../../src/index.js)) und bei jedem
nennenswerten Ereignis: Beginn und Ende eines Titels, Hinzufügen, leere
Warteschlange, Änderung des Sprachzustands des Bots.

### Wiederherstellung

`restoreAll()` wird bei `ClientReady` aufgerufen. Es verbindet den Bot erneut,
erzeugt die Titel neu (`new Track(...)` mit erneuter Zuordnung des Extraktors
über seine Kennung) und setzt die Wiedergabe dann **lautlos** fort:

```
restorePaused = true, volume = 0
        │
        ▼
  Wiedergabe starten
        │
        ▼
  playerStart → seek(gesicherte Position)
        │
        ▼
  Lautstärke wiederherstellen, bei Bedarf die Pause anwenden
```

Ohne diese Vorsichtsmaßnahme hörte der Benutzer den Anfang des Titels vor dem
Sprung an die richtige Stelle.

### Ausblenden

`fadeOutAndSaveState()` senkt die Lautstärke in 35 Stufen nach einer
exponentiellen Kurve, bevor endgültig gesichert wird. Bei `SIGINT` und bei
`shutdownBot` aufgerufen, vermeidet es den harten Schnitt. Die verstrichene Zeit
wird zu `virtualProgressMs` addiert, damit die gesicherte Position richtig
bleibt.

---

## Ablage der Importe

[`uploadService.js`](../../../src/web/uploadService.js) — siehe auch
[07 — Sicherheit](07-securite.md).

### Benennung nach Prüfsumme

Die Dateien werden als `<Prüfsumme12>-<Originalname>` abgelegt, wobei die
Prüfsumme das 12 Zeichen lange Präfix des SHA-256 des **Inhalts** ist. Eine schon
vorhandene Datei erneut zu importieren nutzt das bestehende Exemplar weiter, ohne
zusätzliche Kopie.

Dieser Mechanismus behebt eine beobachtete Anhäufung: ohne ihn erzeugte dasselbe
Stück bei erneutem Import so viele Kopien, wie es Importe gab.

### Aufgeschobene Benennung

Die Übertragung läuft über `.incoming-<pid>-<Zeitstempel>-<Zufall>`, das erst
nach Vollständigkeit umbenannt wird. Eine abgebrochene Übertragung hinterlässt
daher kein abgeschnittenes Medium in der Bibliothek. Waisen eines harten
Abbruchs werden beim Start durch `cleanIncomingUploads()` beseitigt.

### Angezeigter Name

`getCleanFilename()` aus [`utils/paths.js`](../../../src/utils/paths.js) entfernt
das technische Präfix. Es behandelt beide Formen: die heutige Prüfsumme und den
Zeitstempel der Dateien, die vor der Doppelerkennung importiert wurden und auf
die bestehende Wiedergabelisten noch verweisen.
