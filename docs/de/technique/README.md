# Technische Dokumentation

Entwicklerdokumentation des Bots **Interaktive Musik**: ein Discord-Bot für
Musikwiedergabe mit automatischer Lautstärkeabsenkung beim Sprechen
(*Ducking*), gesteuert über ein Web-Dashboard in Echtzeit.

Dieser Ordner richtet sich an Personen, die den Code ändern. Für den
alltäglichen Gebrauch siehe das [Benutzerhandbuch](../GUIDE.md).

---

## Inhalt

| Dokument | Inhalt |
|---|---|
| [01 — Architektur](01-architecture.md) | Überblick, Startsequenz, Modulkarte, Lebenszyklus |
| [02 — Audiowiedergabe](02-lecture-audio.md) | discord-player, Extraktoren, FFmpeg-Filter, Geschwindigkeit, Blenden, Vorladen |
| [03 — Ducking](03-ducking.md) | Spracherkennung, Zustandsautomat, Lautstärkesteuerung |
| [04 — Übertragungsmodi](04-diffusion.md) | Gemeinsamer und persönlicher Modus, virtueller Player, Übergänge |
| [05 — Dashboard](05-tableau-de-bord.md) | Webserver, WebSocket-Protokoll, HTTP-Routen, Frontend |
| [06 — Persistenz](06-persistance.md) | Einstellungen, Wiedergabezustand, atomares Schreiben, Speicherung der Importe |
| [07 — Sicherheit](07-securite.md) | Authentifizierung, Pfadbeschränkung, Obergrenzen |
| [08 — Protokollierung](08-journalisation.md) | Logger, Stufen, Übertragung ans Dashboard |
| [09 — Konfiguration](09-configuration.md) | Umgebungsvariablen, `config.js`, Bereitstellung der Befehle |

---

## Der Blick aus 10 000 Fuß

Der Bot ist ein **einziger Node.js-Prozess**, der drei Dinge parallel
betreibt:

```
                    ┌─────────────────────────────┐
                    │       Node.js-Prozess       │
                    │                             │
   Discord  ◄──────►│  discord.js-Client          │
   (Gateway         │    └─ discord-player        │──► Sprachkanal (Opus/UDP)
    + Voice)        │         └─ FFmpeg           │
                    │                             │
                    │  HTTP- + WebSocket-Server   │◄─► Browser
                    │    └─ Express               │    (Dashboard)
                    │                             │
                    │  JSON-Dateipersistenz       │──► data/
                    └─────────────────────────────┘
```

Es gibt **weder eine externe Datenbank noch einen Nebendienst noch einen
Build**: `npm start` genügt. Der Preis dafür ist, dass der gesamte Zustand im
Arbeitsspeicher dieses Prozesses lebt, mit Momentaufnahmen auf der Festplatte
(siehe [06 — Persistenz](06-persistance.md)).

---

## Strukturierende Prinzipien

**Der Prozess ist Einzelinstanz und Einzelbenutzer.**
Das Dashboard kennt keine Konten: ein einziges Token gewährt Zugang zu allem.
Der Bot ist dafür ausgelegt, auf dem Rechner seines Besitzers zu laufen.

**Der Wiedergabezustand gehört dem Projekt.**
Die 23 Zustandseigenschaften (`virtualCurrentTrack`, `channelStates`,
`transitioningToEveryone`…) werden in
[`PlaybackSession`](../../../src/audio/PlaybackSession.js) deklariert und nicht
mehr schemalos auf das `GuildQueue`-Objekt von discord-player aufgepfropft.
Siehe [01 — Architektur](01-architecture.md#playbacksession).

**Das Dashboard ist ein Spiegel, keine Quelle der Wahrheit.**
Der Server sendet einen vollständigen Zustand; der Client zeigt ihn an. Jede
Aktion des Clients ist eine WebSocket-Nachricht, die den Serverzustand ändert,
der daraufhin erneut sendet.

**Nichts wird transpiliert.**
CommonJS auf der Serverseite, globale Skripte auf der Browserseite. Kein
Bundler, kein TypeScript. Express liefert die Frontend-Dateien unverändert aus.

---

## Konventionen

- **Sprache**: Kommentare, Protokolle und Dokumentation auf Französisch;
  Bezeichner auf Englisch.
- **Module**: CommonJS (`require`). Singletons werden bereits instanziiert
  exportiert (`module.exports = new Foo()`).
- **Protokollierung**: niemals `console.*`, immer
  `log.debug|info|success|warn|error` (siehe
  [08 — Protokollierung](08-journalisation.md)).
- **Dem Client offengelegte Festplattenpfade**: niemals roh, immer über
  `resolveMediaPath()` (siehe [07 — Sicherheit](07-securite.md)).
- **Schreiben von JSON-Dateien**: niemals direkt `writeFileSync`, immer
  `writeJsonAtomic()` (siehe [06 — Persistenz](06-persistance.md)).

---

## Bekannte Grenzen

Diese Punkte sind erkannte Altlasten, keine zu meldenden Fehler.

| Thema | Beschreibung | Siehe |
|---|---|---|
| Wiedergabezustand | Alle 455 Stellen greifen weiterhin über `queue.xxx` auf den Zustand zu, nunmehr Zugriffsmethoden auf `PlaybackSession`. Ihre Umschreibung auf `session.xxx` steht noch aus. | [01](01-architecture.md#playbacksession) |
| 1-s-Sendeschleife | Das Intervall wird nie gestoppt — es gibt kein `stop()` auf `WebServer`. Die periodische Nutzlast selbst wurde auf ~200 Byte verkleinert. | [05](05-tableau-de-bord.md#die-aktualisierungsschleife) |
| Doppeltes Wiedergabemodell | Der gemeinsame und der persönliche Modus sind im gesamten Zustandscode durch `isPersonal ? … : …`-Ternäroperatoren verflochten. | [04](04-diffusion.md#der-preis-des-doppelten-modells) |
| Kein globales Sicherheitsnetz | Weder `uncaughtException` noch `unhandledRejection` noch `SIGTERM`: eine Ausnahme außerhalb der geschützten Zonen beendet den Prozess. | [05](05-tableau-de-bord.md#robustheit) |
| Fehlende automatisierte Tests | Im Repository ist keine Testsuite versioniert. | — |
