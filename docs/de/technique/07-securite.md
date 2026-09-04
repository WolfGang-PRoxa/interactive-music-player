# 07 — Sicherheit

[← Inhalt](README.md)

Der Bot stellt einen Webserver bereit, der die Wiedergabe steuert, Dateien von
der Festplatte liest und den Prozess anhalten kann. Diese Seite beschreibt die
vorhandenen Schutzmaßnahmen und das zugrunde gelegte Bedrohungsmodell.

---

## Bedrohungsmodell

Der Bot ist dafür ausgelegt, auf dem Rechner seines Besitzers zu laufen. Das
Dashboard kennt **keine** Kontenverwaltung: ein einziges Token gewährt Zugang zu
allem.

Was abgedeckt ist:

- Zugriff von einem anderen Rechner des lokalen Netzes;
- Lesen beliebiger Dateien von der Festplatte über die Medienrouten;
- Erschöpfung von Speicher oder Festplatte durch eine einzelne Anfrage;
- Anhalten des Prozesses durch einen nicht authentifizierten Dritten.

Was es nicht ist:

- Trennung der Rechte zwischen mehreren Benutzern des Dashboards;
- unmittelbare Erreichbarkeit aus dem Internet — den Bot bei Bedarf hinter einen
  Reverse Proxy mit TLS stellen;
- Schutz vor einem böswilligen berechtigten Benutzer.

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

---

## Bei Änderungen

- Niemals einen vom Client stammenden Pfad an `fs.createReadStream`,
  `fs.statSync` oder FFmpeg weiterreichen, ohne über `resolveMediaPath()` zu
  gehen.
- Niemals eine Route vor `auth.middleware` einhängen.
- Eine neue WebSocket-Nachricht, die auf die Festplatte schreiben kann, muss ihre
  Eingaben prüfen: der Router verbürgt nur das Vorhandensein von `data`.
