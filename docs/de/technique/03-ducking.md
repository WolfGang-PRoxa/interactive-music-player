# 03 — Ducking

[← Inhalt](README.md)

Das *Ducking* ist die zentrale Funktion des Bots: die Musik wird leiser, sobald
jemand spricht, und steigt nach einer Stille wieder an.

---

## Grundgedanke

Discord übermittelt Bots Sprechereignisse je Sprachkanal. Es ist keinerlei
Signalanalyse nötig: `connection.receiver.speaking` sendet `start` und `end` mit
der Kennung des Benutzers.

```
      Sprache erkannt                      Stille
              │                               │
              ▼                               ▼
     ┌─────────────────┐              ┌─────────────────┐
     │  Sprecher-Set   │              │  Sprecher-Set   │
     │   leer → 1      │              │   1 → leer      │
     └────────┬────────┘              └────────┬────────┘
              │                                │
     Wiederherstellung abbrechen      `duckingDelay` abwarten
              │                                │
              ▼                                ▼
      duckDown(Pegel, Blende)            duckUp(Blende)
```

Zwei Klassen teilen sich die Arbeit:

- [`DuckingManager`](../../../src/audio/DuckingManager.js) — *wann* abgesenkt wird;
- [`VolumeController`](../../../src/audio/VolumeController.js) — *wie* die Lautstärke verändert wird.

Von jeder gibt es eine Instanz **je Server**, abgelegt in
`client.duckingManagers` (eine nach `guildId` indizierte `Map`).

---

## DuckingManager

### Innerer Zustand

| Feld | Rolle |
|---|---|
| `activeSpeakers` | `Set<userId>` der gerade sprechenden Personen |
| `_restoreTimer` | Zeitgeber der aufgeschobenen Wiederherstellung |
| `_active` | Zeigt an, ob die Listener angeschlossen sind |
| `channelId` | Überwachter Kanal, für die Ausschlussliste |

### Sprechbeginn

```
_handleSpeakingStart(userId)
  ├─ activeSpeakers.add(userId)
  ├─ wenn Ducking aktiv UND Benutzer nicht ausgeschlossen:
  │    ├─ den wartenden Wiederherstellungs-Zeitgeber abbrechen
  │    └─ wenn dies der ERSTE nicht ausgeschlossene Sprecher ist:
  │         └─ volumeController.duckDown(duckingLevel, duckingFade)
  └─ den Zustand erneut ans Dashboard senden
```

Die Bedingung „erster nicht ausgeschlossener Sprecher" verhindert, dass bei jeder
weiteren Person, die zu sprechen beginnt, eine neue Blende gestartet wird,
während die Lautstärke bereits abgesenkt ist.

### Sprechende

```
_handleSpeakingEnd(userId)
  ├─ activeSpeakers.delete(userId)
  ├─ wenn Ducking aktiv UND kein nicht ausgeschlossener Sprecher mehr:
  │    └─ die Wiederherstellung in `duckingDelay` ms einplanen
  └─ den Zustand erneut ans Dashboard senden
```

Die Verzögerung ist eine **Entprellung**. Ohne sie stiege die Lautstärke während
der Atemzüge mitten im Satz wieder an und erzeugte einen Pumpeffekt. Beim
Auslösen verhindert eine zweite Prüfung (`activeSpeakers.size === 0`) einen
Anstieg, falls inzwischen jemand wieder zu sprechen begonnen hat.

### Ausschlüsse je Benutzer

`database.isVoiceDetectionDisabled(guildId, channelId, userId)` erlaubt es,
bestimmte Personen zu übergehen. Die Liste wird **je Kanal** in den Einstellungen
abgelegt:

```json
"ignoredVoiceUsers": { "<channelId>": ["<userId>", "…"] }
```

Ein ausgeschlossener Benutzer wird zwar zu `activeSpeakers` hinzugefügt — das
Dashboard zeigt ihn als sprechend —, doch `_countActiveNonIgnored()` zählt ihn
nicht mit und er löst daher keine Absenkung aus.

Der Schlüssel ist **der Kanal, den das Dashboard anzeigt**
(`ws.selectedVoiceChannelId`), und nicht der Kanal, in dem sich der Bot befindet:
unter diesem Schlüssel liest `getState()` die Liste wieder ein. Meistens fallen
beide zusammen, aber nicht, wenn der Bot nirgends verbunden ist — der Schalter
wurde dann anderswo abgelegt als dort, wo er gelesen wurde, und kehrte beim
nächsten Zustand in seine ursprüngliche Stellung zurück.

### Umkonfiguration im laufenden Betrieb

`refresh()` wird nach einer Änderung der Einstellungen aufgerufen:

- Ducking deaktiviert → sofortige Wiederherstellung der Lautstärke, ohne Blende;
- Ducking aktiviert und jemand spricht → sofortige Absenkung;
- Ducking aktiviert und Stille → sofortige Wiederherstellung.

`updateConnection()` behandelt den Kanalwechsel des Bots: die Listener werden von
der alten Verbindung entfernt und an der neuen wieder angeschlossen. Diesen
Schritt auszulassen ließe das Ducking nach einem Umzug stillschweigend
wirkungslos.

### Lebensdauer des Zuhörens

**Das Zuhören auf Sprache gehört zur Sprachverbindung, nicht zur Wiedergabe.** Es
wird auf dem Ereignis `connection` des Players aufgebaut — ein einziger
Durchgangspunkt, ob die Verbindung nun von einem Befehl, einem Import, dem
Dashboard oder der Präsenzregel kommt — und mit ihr abgebaut
(`PresenceManager.detacher()`, Ausschalten des Bots).

Früher hing es am Start eines Titels und wurde bei `emptyQueue` allein im Modus
„alle" abgebaut. Zwei Folgen: das Dashboard hörte auf, die Zuhörer zu animieren,
sobald der letzte Titel zu Ende war, obwohl der Bot noch da war, und eine bei
persönlicher Übertragung aufgebaute Verbindung — wo auf Seiten des Bots kein
Titel startet, da der Ton aus dem Browser kommt — blieb taub. Die Sprachaktivität
wird nun in beiden Modi erfasst, bei leerer Warteschlange oder nicht.

### Meldung ans Dashboard

Jeder Sprechbeginn und jedes Sprechende sendet eine leichte Nachricht `speakers`
(`WebServer.broadcastSpeakers()`), nach dem Vorbild von `progress`: das Sprechen
kommt und geht mehrmals pro Sekunde und pro Person, und darauf mit einem
vollständigen Zustand zu antworten würde jedes Mal die Warteschlange, den Verlauf
und die Wiedergabelisten neu serialisieren. Die Nachricht trägt nur die Liste der
Sprechenden und geht nur an jene Dashboards, die den vom Bot abgehörten Kanal
anzeigen.

Diese Meldung war zerbrochen: der Code rief
`WebServer.instance.broadcastState()` auf, während `require('../web/WebServer')`
**die Instanz** liefert, wobei `instance` eine statische Eigenschaft der Klasse
ist — also stets `undefined`. Es ging keinerlei Benachrichtigung hinaus. Das
Dashboard erfuhr erst beim nächsten aus anderem Grund gesendeten Zustand, wer
sprach, daher eine Fläche „Sprachaktivität", die sich fast nie regte. Bei
persönlicher Übertragung ging die Folge weiter: dort wendet **der Browser** das
Ducking auf sein eigenes Audioelement an (`clientDucking`, in `app.js`), gestützt
auf `state.speakers`. Ohne diese Nachrichten war in jenem Modus keinerlei
Absenkung möglich.

### Geistersprecher

Discord kündigt Mikrofonwechsel an, keine Abgänge: wer den Kanal sprechend
verlässt, erzeugt **kein** „Sprechende". Er blieb dann für immer in
`activeSpeakers` eingetragen — Heiligenschein am Dashboard erleuchtet und
Lautstärke für einen stillen Kanal unten gehalten.

Zwei Aufräumarbeiten antworten darauf: `oublierLocuteur(userId)` beim Abgang
eines Benutzers (Listener `VoiceStateUpdate`) und `oublierLocuteurs()`, wenn die
Verbindung wechselt oder der Bot versetzt wird — was eine verschwundene
Verbindung gesehen hatte, ist nichts mehr wert.

---

## VolumeController

Kapselt `queue.node` von discord-player, um allmähliche Übergänge anzubieten.

### Der Begriff der Grundlautstärke

`baseVolume` ist die Lautstärke, wenn niemand spricht (0–100). `duckLevel` ist
ein **Prozentsatz dieser Lautstärke**, kein absoluter Wert:

```js
abgesenkteLautstärke = round(baseVolume × duckLevel / 100)
```

Bei `baseVolume: 70` und `duckingLevel: 20` sinkt die Musik auf 14, nicht auf 20.
Das erlaubt es, die allgemeine Lautstärke einzustellen, ohne das Gleichgewicht
des Ducking zu verstellen.

### Blende

`_fadeTo(Ziel, Dauer)` zerlegt den Übergang in Stufen von
`config.ducking.fadeStepInterval` (20 ms) und wendet einen linearen Zuwachs an.
Zwei Abkürzungen ersparen unnütze Arbeit: eine Dauer von null oder ein Abstand
von weniger als 1 Punkt werden unmittelbar angewandt.

Jede neue Blende bricht die vorige ab (`_cancelFade()`), damit ein schneller
Wechsel von Sprache und Stille nicht zwei widersprüchliche Zeitgeber
nebeneinander bestehen lässt.

### Titelwechsel

`updateQueueNode()` muss bei jedem Titelwechsel aufgerufen werden: der
Audioknoten wird von discord-player neu erzeugt, und der alte Verweis wird
wirkungslos. Die Methode wendet die aktuelle Lautstärke erneut an — 0, wenn die
Warteschlange gerade wiederhergestellt wird oder im Übergang ist, sonst
`targetVolume` oder `baseVolume`, je nachdem, ob abgesenkt wird oder nicht.

Der Regler wird auch außerhalb des Ducking wiederverwendet, für Ein- und
Ausblendungen sowie die DJ-Übergänge, über unmittelbare Aufrufe von `_fadeTo()`.

---

## Einstellungen

| Schlüssel | Vorgabe | Wirkung |
|---|---|---|
| `duckingEnabled` | `true` | Aktiviert die Absenkung |
| `duckingLevel` | `20` | Prozentsatz der Grundlautstärke während des Sprechens |
| `duckingDelay` | `800` | Millisekunden Stille vor der Wiederherstellung |
| `duckingFade` | `200` | Dauer der Blende, in Millisekunden |
| `baseVolume` | `70` | Lautstärke außerhalb des Sprechens |

Änderbar über `/ducking …`, `/volume` oder das Dashboard. Die Vorgabekonstanten
leben in [`config.js`](../../../src/config.js), die tatsächlichen Werte in
`data/settings.json`.

---

## Diagnose

Protokolle der Stufe `DEBUG` zeichnen jeden Schritt auf:

```
[Ducking Debug] Détection parole - Début pour l'utilisateur : 1234…
[Ducking Debug] Baisse du volume (duckDown) vers 20%
[Ducking Debug] Détection parole - Fin pour l'utilisateur : 1234…
[Ducking Debug] Restauration du volume planifiée dans 800ms
```

Reagiert das Ducking nicht, ist der Reihe nach zu prüfen:

1. Ist der Bot mit dem Kanal verbunden? Ohne Sprachverbindung wird kein
   `DuckingManager` erzeugt.
2. Wurde `setupDucking()` aufgerufen? Es wird bei `playerStart` aufgerufen, nicht
   beim Verbinden.
3. Steht der Benutzer für diesen Kanal in `ignoredVoiceUsers`?
4. Ist der Bot serverseitig stummgeschaltet? Die Warteschlangen werden gerade
   deshalb mit `selfDeaf: false` erzeugt, um weiterhin Sprache zu empfangen.
