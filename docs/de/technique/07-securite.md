# 07 — Sicherheit

[← Inhalt](README.md)

Der Bot stellt einen Webserver bereit, der die Wiedergabe steuert, Dateien von
der Festplatte liest und den Prozess anhalten kann. Diese Seite beschreibt die
vorhandenen Schutzmaßnahmen und das zugrunde gelegte Bedrohungsmodell.

---

## Bedrohungsmodell

Der Bot ist dafür ausgelegt, auf dem Rechner seines Besitzers zu laufen. Das
Zugangstoken öffnet dort die Seite; **es benennt niemanden**. Die Rechte hängen
an einem Discord-Konto, und ein Konto ohne Rechte sieht ein reglos daliegendes
Dashboard.

Was abgedeckt ist:

- Zugriff von einem anderen Rechner des lokalen Netzes oder aus dem Internet,
  wenn der Tunnel steht ([11 — Fernzugriff](11-acces-distant.md));
- Lesen beliebiger Dateien von der Festplatte über die Medienrouten;
- Erschöpfung von Speicher oder Festplatte durch eine einzelne Anfrage;
- Anhalten des Prozesses durch einen nicht authentifizierten Dritten;
- Trennung der Rechte zwischen dem Sitzungsmeister und seinen Gästen — ein Gast
  kann den Bot weder abschalten noch seine Version wechseln noch Rechte
  verteilen.

Was es nicht ist:

- Schutz vor dem Sitzungsmeister selbst: er kann bauartbedingt alles;
- Schutz vor einem Gast, dem man ein Recht eingeräumt hat, das er missbraucht —
  der Entzug ist das einzige Mittel (`revokeControl`);
- Vertraulichkeit der ausgelieferten Inhalte: ein Titel, den ein Gast hören
  kann, ist ein Titel, den er herunterladen kann.

---

## Authentifizierung

[`auth.js`](../../../src/web/auth.js) schützt **HTTP und WebSocket**.

### Das Token öffnet, es benennt nicht

Das Token ist einzig und geteilt: es zu besitzen beweist, dass man an der
Maschine sitzt, nie wer man ist. Da der Bot auf Servern voller echter Menschen
handelt, hat er keinen Grund, einem Anonymen zu gehorchen.

Rechte hängen deshalb an einer **Discord-Sitzung**, nie am Token. Eine Anfrage,
die das Token ohne Sitzung vorlegt, erhält Zugang zur Seite — die das
Anmeldefenster trägt, muss ja ausgeliefert werden — und sonst nichts:
`identify()` liefert `master: false` und setzt `pendingLogin`, was das Dashboard
in ein Fenster übersetzt, das sich nicht schließen lässt
([`loginGate.js`](../../../src/web/public/js/loginGate.js)).

Eigentümer ist das erste Konto, das **unter Vorlage des Tokens** von Discord
zurückkommt ([`owner.js`](../../../src/web/owner.js)). Das ist keine Abkürzung:
das Token steht in der Konsole dessen, der den Bot gestartet hat, und der an
Zuhörer geschickte Einladungslink trägt es nicht. Die Beanspruchung geschieht
einmal — ein zweites Konto enteignet das erste nicht, sonst übernähme der
zuletzt Gekommene, und geteilte Kontrolle gäbe es nicht mehr.

Das Token wird auf dem Hinweg festgestellt, unter `/auth/discord`, und die
Antwort reist im OAuth-`state`. Das ist nötig: das Dashboard öffnet sich auf
`127.0.0.1`, wo sein Cookie liegt, während Discord auf `PUBLIC_URL` zurückleitet
— einen Tunnel, einen Domänennamen, eine Adresse im lokalen Netz. Zwei Hosts,
zwei Cookie-Gläser, und ein Rückruf ohne Token. Der `state` ist zufällig, bleibt
serverseitig und wird einmal verbraucht: diese Tatsache darin preiszugeben
kostet nichts.

Eine Ausnahme, und nur eine: eine Installation ohne eingerichtete
Discord-Anwendung *kann* keine Anmeldung entgegennehmen. Dort nimmt das Token
seine alte Rolle wieder ein. Ablehnen hieße, den Installierenden wegen eines in
einer Datei fehlenden Geheimnisses aus seinem eigenen Bot auszusperren, was
niemanden schützt.

Die Folge zeigt sich in den Rückfalllösungen: ein ohne Identität eintreffender
Socket gilt als Gast ohne Rechte, nie als Master. Solange das Token den Master
machte, war dieser Rückfall folgenlos; jetzt öffnete er bei einem Zwischenfall
alles.

### Sich an einen Gast erinnern

Eine Discord-Sitzung dauert dreißig Tage und überschreitet die Grenze zwischen
zwei Browsern nicht. Ein angenommener Gast musste daher bei jedem Besuch erneut
auf „Anmelden“ klicken und — schlimmer — *verschwand aus dem Fenster des
Meisters*, sobald seine Sitzung ablief: die Gästeliste wurde aus den offenen
Sitzungen gelesen, während seine Rechte in den Einstellungen eingetragen
blieben.

Zwei Fragen waren vermengt, und sie zu trennen genügt:

- **wer ist diese Person?** — das Gästebuch
  ([`guests.js`](../../../src/web/guests.js)), nach `data/guests.json`
  geschrieben, das mindestens so lange hält wie die Rechte, die es begleitet;
- **gehört dieser Tab ihr?** — die Sitzung
  ([`sessions.js`](../../../src/web/sessions.js)), mit der kurzen Lebensdauer,
  die das verdient.

Das Buch enthält **kein Geheimnis**: kein Token, kein Discord-Zugangstoken,
nichts, womit man sich für jemanden ausgeben könnte. Darin zu stehen bedeutet
„dieses Konto hat sich mindestens einmal angemeldet“, nie „dieses Konto darf…“.
Ein entlassener Gast fällt heraus, sonst wäre die Ablehnung keine.

Die Tür versucht dann, ihren Besucher zu erkennen, bevor sie ihm eine
Schaltfläche zeigt. Der Versuch läuft über `prompt=none`, was Discord verbietet,
irgendetwas anzuzeigen: entweder es erkennt das Konto und schickt es
identifiziert zurück, oder es antwortet `login_required` — eine normale Antwort,
kein Zwischenfall — und die Tür zeigt ihre Schaltfläche wie zuvor.

Der Versuch wird nicht wiederholt: der Rückruf kehrt mit `?login=manual` zurück,
zusätzlich zu einer Markierung im `sessionStorage`. Ohne dieses Gedächtnis
löste ein Fehlschlag einen weiteren Versuch aus, endlos. Beide Spuren sind
nötig — der Parameter überlebt den Herkunftswechsel des Rückrufs, der Speicher
überlebt das Aufräumen der URL.

**Unterwegs wird kein Recht erteilt.** Das stille Erkennen beantwortet „wer bist
du“, nie „darfst du herein“: ein Konto, das keinem Server des Bots angehört,
wird dort wie überall abgewiesen, und ein erkannter Gast erhält genau die
Rechte zurück, die man ihm gelassen hatte, kein einziges mehr.

### Geteilte Rechte

[`permissions.js`](../../../src/web/permissions.js) entscheidet, was ein Gast
tun darf. **Die Kontrolle liegt dort und nirgends sonst**: das Dashboard graut
verbotene Befehle aus, doch das ist nur eine Höflichkeit gegenüber dem Gast —
nichts hindert daran, die Browserkonsole zu öffnen und die Nachricht von Hand zu
senden. Die einzige Schranke, die zählt, ist die des Servers.

Ein Recht entspricht **einer Geste** und heißt `Rubrik.Geste`. Die vier Rubriken
sind nur noch eine Ordnung: sie geben dem Teilungsfenster seine Abschnitte und
seine Sammelschalter, sie entscheiden nichts mehr.

| Rubrik | Rechte |
|---|---|
| `playback` | `transport`, `skip`, `seek`, `mode`, `source`, `speed`, `mix`, `loudness` |
| `queue` | `add`, `playNow`, `remove`, `reorder`, `history`, `download`, `clear` |
| `playlists` | `create`, `addTrack`, `removeTrack`, `reorderTracks`, `rename`, `organise`, `transitions`, `delete` |
| `volume` | `level`, `ducking`, `quality`, `trackGain`, `broadcast`, `channel` |

Diese Feinkörnigkeit trat an die Stelle von vier Sammelrechten, die zu grob
waren: wer die Warteschlange anvertraute, gab damit zugleich das Recht, sie zu
leeren, und wer die Lautstärke regeln ließ, ließ auch den Sprachkanal wechseln.
Man konnte nicht sagen „füg hinzu, was du willst, aber lösche nichts“, was doch
das ist, was man am häufigsten sagen möchte. Der Punkt in `Rubrik.Geste` ist
nicht schmückend: an ihm erkennt man ein heutiges Recht von einem gestrigen, was
erlaubt, eine von einer früheren Fassung geschriebene `settings.json` ohne
Zucken wieder zu lesen.

Drei besondere Werte ergänzen den Katalog:

- `ALWAYS` — die Nachrichten, die nichts befehlen (`requestState`, `clientLog`,
  `syncProgress`). Sie abzulehnen schützte nichts und ließe das Dashboard des
  Gastes blind. `syncProgress` trägt allerdings die Position, der alle folgen:
  sein Handler hört nur auf das Pilot-Dashboard, sonst verschöbe ein Gast ohne
  Rechte die Wiedergabe der anderen.
- `FIELD_FILTERED` — `updateSettings`, dessen Felder je einem anderen Recht
  unterstehen. Die Nachricht geht durch, und `filterSettings()` behält nur die
  erlaubten Einstellungen; ein Gast ohne jedes Recht sieht seine Anfrage von
  allem Inhalt geleert, was der Aufrufer als Ablehnung behandelt.
- `MASTER_ONLY` — siebzehn Nachrichten, die beim Meister bleiben: den Bot
  abschalten oder neu starten, seine Version wechseln, ihn einen Server
  verlassen lassen, den Tunnel aufbauen, die Rechte selbst verteilen sowie
  Rechteanfragen beantworten und stummschalten.

**Eine der Tabelle unbekannte Nachricht wird `MASTER_ONLY` gleichgestellt.** Das
ist gewollt: ein später gedankenlos hinzugefügter Befehl ist von vornherein
geschlossen statt allen offen.

Die Rechte leben in den Einstellungen des Servers, unter `sharedControl` (siehe
[09 — Konfiguration](09-configuration.md#einstellungen-je-server)). Zwei
benachbarte Gesten sagen nicht dasselbe, und sie zu verwechseln kostet:
`shareControl` mit leerem Satz hakt alles ab — der Gast bleibt zugelassen,
erkannt, nur ohne Macht, und man kann ihm die Rechte im nächsten Augenblick
zurückgeben; `revokeControl` verabschiedet endgültig — Rechte gelöscht,
Zulassung entzogen, Sitzungen geschlossen, Eintrag im Buch getilgt.

Ein Gast kann ein verweigertes Recht mit `requestRight` **anfragen**, das allen
offensteht, da gerade derjenige fragt, der das Recht nicht hat. Anfragen gewährt
nichts, und der Handler sortiert: ein erkannter, bereits zugelassener Gast, ein
Recht aus dem Katalog, das er nicht hat, keine Stummschaltung, kein Duplikat,
mindestens drei Sekunden zwischen zwei Anfragen. Die Anfragen warten in den
Servereinstellungen unter `rightRequests`, und der Administrator beantwortet sie
mit `answerRightRequest` — Gewähren fügt nur das angefragte Recht hinzu.
`muteRightRequests` schaltet einen Gast stumm, unter `mutedRightRequests`, und
löscht seine Anfragen; ein verabschiedeter Gast geht ohne Anfragen und ohne
Stummschaltung.

### Herkunft des Tokens

`DASHBOARD_TOKEN`, sofern gesetzt, sonst ein beim ersten Start erzeugtes Token
von 32 Byte, das in `data/dashboard-token` gespeichert wird (Rechte `0600`). Es
wird beim Start außerdem in der Konsole angezeigt.

### Warum ein Cookie

Das Dashboard lädt seine Medien über `<audio src>`, `<video src>` und
Download-Links. **Diese Elemente können keine `Authorization`-Kopfzeile
tragen.** Das Cookie ist daher der einzige Weg, der für alle Fälle funktioniert.

Es hat einen weiteren Vorteil: der Browser überträgt es auch beim
Same-Origin-Handshake des WebSockets, was den WebSocket ohne jede Änderung am
Client-Code schützt.

### Ablauf

```
GET /?token=<Token>
   │
   ├─ gültiges Token → setzt das Cookie (httpOnly, sameSite=lax, 1 Jahr)
   │                   und leitet dann auf die URL ohne den Parameter um
   │
   └─ Token fehlt oder ungültig → 401 + Erklärungsseite
```

Das Token aus der URL zu entfernen verhindert, dass es in der Adressleiste, im
Verlauf oder in der `Referer`-Kopfzeile fortbesteht.

Drei Quellen werden angenommen, in dieser Reihenfolge: der Parameter `token`, das
Cookie `dashboard_token`, die Kopfzeile `Authorization: Bearer`.

Der Vergleich verwendet `crypto.timingSafeEqual`, um das Token nicht Byte für
Byte über die Messung der Antwortzeit preiszugeben.

### Platzierung der Middleware

`auth.middleware` wird **vor** `express.static` eingehängt. Die Dateien des
Dashboards sind daher genauso geschützt wie die `/api`-Routen. Der WebSocket wird
durch die Option `verifyClient` von `ws` gefiltert.

---

## Pfadbeschränkung

[`utils/mediaPaths.js`](../../../src/utils/mediaPaths.js) entscheidet, welche
Dateien ausgeliefert werden dürfen.

### Das gelöste Problem

Die Routen `/api/stream` und `/api/download` nahmen einen rohen Pfad vom Client
entgegen und lieferten ihn aus, sofern er bestand:

```js
if (fs.existsSync(decodedUrl)) {
    track = { url: decodedUrl, queryType: 'file', ... };
}
```

Eine Anfrage `?trackUrl=…/.env` lieferte somit das Discord-Token zurück. Jedes
Lesen einer Datei geht nunmehr über `resolveMediaPath()`.

### Die drei Bedingungen

Ein Pfad wird nur angenommen, wenn er **alle** Bedingungen erfüllt:

1. **bekannte Medienerweiterung** — aus `supportedExtensions` und
   `supportedVideoExtensions` in [`config.js`](../../../src/config.js);
2. **tatsächliches Vorhandensein**, durch `fs.realpathSync` aufgelöst — was
   symbolische Verweise unschädlich macht, die aus dem Bereich hinausführen;
3. **Lage unter einem erlaubten Stammverzeichnis**.

Ebenfalls von vornherein zurückgewiesen werden Pfade, die ein Nullbyte enthalten
(welches den Pfad auf Ebene der Systemaufrufe abschneidet), sowie entfernte URLs.

### Erlaubte Stammverzeichnisse

| Stammverzeichnis | Herkunft |
|---|---|
| `data/uploads` | Importierte Dateien |
| `data/cache` | Vorladen |
| `MEDIA_ROOTS` | Lokale Bibliotheken, durch `;` oder `,` getrennt |

Ohne `MEDIA_ROOTS` wird eine aus `D:\Musik` abgespielte Datei **für das Streaming
abgelehnt**. Das ist eine gewollte Härtung: den Bereich zu erweitern ist eine
ausdrückliche Entscheidung des Betreibers.

Der Vergleich achtet unter Windows nicht auf Groß- und Kleinschreibung.

### Gestaffelte Verteidigung

Das Schutzgeländer wird auf zwei Ebenen angewandt: bei der Auflösung des
angefragten Titels und dann vor dem tatsächlichen Lesen der Datei — auch bei
einem Titel aus der Warteschlange. Ein Titel, dessen Pfad außerhalb des Bereichs
liegt, ergibt ein `403`, niemals einen Lesevorgang.

### Das Schreiben dagegen ist nicht eingeschlossen

[`utils/downloadDir.js`](../../../src/utils/downloadDir.js) verwahrt den Ordner,
in den das vierte Ziel des Eingabekastens seine Dateien schreibt, und er kennt
keine erlaubten Stammverzeichnisse. Die Asymmetrie ist gewollt und verdient es,
ausgesprochen statt hingenommen zu werden:

- **`mediaPaths` schützt das Lesen.** Das Risiko liegt dort darin, dem Client
  eine Datei auszuliefern, die ihn nichts angeht — daher ein geschlossener
  Bereich und `.env` außer Reichweite.
- **Der Download-Ordner ist ein Ziel.** Das Risiko ist nicht mehr, etwas
  preiszugeben, sondern dorthin zu schreiben, wohin man nicht soll. Ihn unter
  ein erlaubtes Stammverzeichnis zu sperren, käme jedoch dem Entfernen der
  Funktion gleich: wer seine Musik in `D:\Musik` ablegt, will sie auch dorthin
  herunterladen.

Was die Sicherheit trägt, liegt also woanders. Der gewählte Pfad wird geprüft,
bevor er gemerkt wird — er existiert, er ist ein Ordner, er lässt sich
beschreiben, er enthält kein Nullbyte —, der Dateiname wird aus dem Titel des
Stücks abgeleitet und nicht vom Client geliefert, und geschrieben wird unter
einem vorläufigen Namen, der nur bei Erfolg umbenannt wird. `GET
/api/browse-dirs` lässt zudem den Baum der Host-Maschine durchlaufen, was eine
neue Fähigkeit ist.

Das alles bleibt innerhalb des obigen Bedrohungsmodells: der Bot läuft auf der
Maschine seines Besitzers, diese Routen werden nach `auth.middleware`
eingehängt, und dasselbe Dashboard kann den Prozess ohnehin schon beenden. Ein
gestohlenes Token öffnet somit nichts, was es nicht schon geöffnet hätte.

---

## Obergrenzen

| Grenze | Wert | Grund |
|---|---|---|
| WebSocket-Nutzlast | 1 MB | Das Dashboard tauscht nur kleine JSON-Nachrichten aus |
| HTTP-JSON-Rumpf | 1 MB | Ebenso; Dateien laufen über `/api/upload` |
| Importgröße | `MAX_UPLOAD_MB`, Vorgabe 1024 MB | Verhindern, dass ein einziges POST die Platte füllt |
| Import-Erweiterungen | Medienliste | Ablehnung mit `415` |

Der Import wird **während der Übertragung** begrenzt: der Strom wird abgebrochen,
sobald die Grenze überschritten ist, und die Teildatei gelöscht, ohne das Ende
der Anfrage abzuwarten.

> Ursprünglich lag die WebSocket-Grenze bei **1 GB**, wegen einer Nachricht
> `uploadPlay`, die base64-kodierte Dateien transportierte. Diese Nachricht wurde
> vom Client nicht mehr verwendet; sie wurde entfernt, was es erlaubte, die
> Grenze auf einen vernünftigen Wert zurückzuführen.

---

## Erreichbarkeit im Netz

`HOST` ist standardmäßig `127.0.0.1`: das Dashboard ist nur vom Wirtsrechner aus
erreichbar. Um von einem Telefon oder einem anderen Arbeitsplatz darauf
zuzugreifen, `HOST=0.0.0.0` setzen — die Authentifizierung erhält dann ihren
vollen Sinn. In diesem Fall wird beim Start eine Warnung protokolliert.

Das Dashboard lässt sich zudem über einen Cloudflare-Tunnel im gesamten
Internet veröffentlichen. Es ist die einzige Geste, die das zuständige Modul von
sich aus verweigert, selbst wenn alles bereitsteht: sie ungefragt auszuführen
würde den Player eines Menschen ohne dessen Wissen veröffentlichen. Siehe
[11 — Fernzugriff](11-acces-distant.md).

---

## Bei Änderungen

- Niemals einen vom Client stammenden Pfad an `fs.createReadStream`,
  `fs.statSync` oder FFmpeg weiterreichen, ohne über `resolveMediaPath()` zu
  gehen.
- Niemals eine Route vor `auth.middleware` einhängen.
- Eine neue WebSocket-Nachricht, die auf die Festplatte schreiben kann, muss ihre
  Eingaben prüfen: der Router verbürgt nur das Vorhandensein von `data`.
