# 10 — Versionen

[← Inhalt](README.md)

Der Bot kann die auf GitHub veröffentlichten Releases auflisten, eine neben der
laufenden installieren und von einer zur anderen wechseln, ohne dass sich eine
Einstellung oder eine Wiedergabeliste bewegt. Alles steckt in
[`src/versioning/`](../../../src/versioning/), fünf Module und keine zusätzliche
Abhängigkeit.

---

## Zwei Wurzeln

Das ist der Gedanke, aus dem alles Übrige folgt. In der Entwicklung fallen sie
zusammen; sobald eine Release installiert ist, trennen sie sich.

| Wurzel | Inhalt | Wert |
|---|---|---|
| **Geteilte** Wurzel | `.env`, `data/`, `node_modules/`, `versions/` | `process.cwd()` |
| **Installations**wurzel | der ausgeführte Code | das Repository oder `versions/<tag>/` |

Alle Module des Bots lösen ihre Daten von `process.cwd()` aus auf — `Database`,
`auth`, `mediaPaths`, `uploadService`: die geteilte Wurzel entscheidet, wo die
Wiedergabelisten, die Einstellungen und das Dashboard-Token liegen.

Die Version zu wechseln heißt also, `versions/<tag>/src/index.js` auszuführen und
dabei **`cwd` auf der geteilten Wurzel zu belassen**: der Code ändert sich, die
Daten nicht.

```
geteilte Wurzel/                 ← process.cwd(), und damit die Daten
├── .env
├── data/                        Einstellungen, Listen, Cache, Protokolle
├── node_modules/                Abhängigkeiten, von allen Versionen gesehen
├── src/                         das Entwicklungs-Repository — Kennzeichnung „dev“
└── versions/
    ├── v1.4.0/
    │   ├── .imp-version.json    Unversehrtheitsmarke
    │   └── src/index.js         ← Installationswurzel, wenn diese Version läuft
    └── v1.5.0/
```

Da Node die übergeordneten Ordner auf der Suche nach `node_modules` hinaufsteigt,
**erbt eine in der geteilten Wurzel eingebettete Release deren Abhängigkeiten
nebenbei, ohne die geringste Kopie**. Es wird also nichts installiert, solange
die Release dieselben Pakete verlangt wie die Wurzel; ein lokales `npm install`
findet nur statt, wenn die Liste abweicht, und bleibt dann auf den Ordner der
Version beschränkt.

[`locations.js`](../../../src/versioning/locations.js) ist das einzige Modul, das
all dies weiß, und das einzige, das befugt ist zu sagen, ob ein Ordner
überschrieben oder gelöscht werden darf. `assertTargetInstallable()` und
`assertTargetRemovable()` sind die Schutzgeländer, die das Entwicklungs-
Repository — und die laufende Version — dem Installationsprogramm wie der
Deinstallation entziehen.

`IMP_VERSIONS_DIR` erlaubt, `versions/` anderswohin zu verlagern, auf eine zweite
Platte oder aus dem Repository heraus. Das Schutzgeländer prüft gleichwohl, dass
es sich nicht mit dem Entwicklungs-Repository überschneidet, welchen Wert es auch
habe.

---

## Welche Version läuft

`currentVersion()` liefert `{ type, tag, packageVersion }`, wobei `type` `dev`
oder `release` ist. Es rät nicht: es liest die Marke `.imp-version.json`, die an
der Wurzel jeder installierten Version abgelegt wird. Die Marke dient zweifach —
sie benennt die Version, und ihr Fehlen meldet ein unvollendetes Entpacken.

Der Wert wird auf drei Wegen offengelegt: das Protokollbanner beim Start, die
Route `GET /api/version` und der Fuß der Dashboard-Schublade — von wo er sich mit
einer Geste kopieren lässt.

---

## Der Katalog

`catalog()` fügt zusammen, was das Aufklappmenü zeigt: die veröffentlichten
Releases, die bereits auf der Platte liegenden und die laufende.

**Das Scheitern des Aufrufs an GitHub ist kein tödlicher Fehler.** Es wird in
`error` gemeldet, und der Katalog bleibt benutzbar, verkleinert auf die schon auf
der Platte vorhandenen Versionen. Ohne Netz kann man also stets zu einer
installierten Version oder zur Entwicklung zurückkehren.

Eine installierte Version, deren Release aus dem Repository verschwunden ist,
bleibt startbar: sie wird als `orphan` markiert und erscheint gleichwohl in der
Liste. Sie liegt auf der Platte, und der Benutzer muss zu ihr zurückkehren
können.

[`github.js`](../../../src/versioning/github.js) befragt die öffentliche API. Ein
öffentliches Repository wird **ohne Zugangsdaten** abgefragt: das ist der
Normalfall, und es ist nichts einzurichten. Ein Token wird gleichwohl angenommen,
wenn es gefunden wird — in `GITHUB_TOKEN`, dann `GH_TOKEN`, dann bei der
`gh`-CLI, sofern installiert und angemeldet —, was das noch private Repository
abdeckt und nebenbei das Stundenkontingent von 60 auf 5 000 Anfragen hebt.

Der Cache der Releases hält nur zwanzig Sekunden, und das Menü erzwingt sein
erneutes Lesen beim Öffnen: es muss die Releases widerspiegeln, die in dem
Augenblick veröffentlicht sind, in dem der Benutzer es aufklappt, nicht die
seines vorigen Öffnens.

---

## Installieren

Leitregel: **nichts bereits Vorhandenes wird je überschrieben.** Jede Release
lebt in ihrem eigenen Ordner `versions/<tag>/`, und eine Installation rührt
keinen anderen an.

```
listReleases()  ──►  .tar.gz-Archiv  ──►  .tmp-<Zufall>/  ──►  versions/<tag>/
                     (höchstens 300 MB)   Entpacken          endgültiges Umbenennen
                                                │
                                                └─ npm install, nur wenn die
                                                   Paketliste abweicht
```

Drei Folgen dieser Regel:

- eine bereits installierte Version wird nicht erneut geladen: sie wird lediglich
  neu gestartet, was die laufende Version vor ihrer eigenen Neuinstallation
  bewahrt;
- das Entwicklungs-Repository ist kein mögliches Ziel — `locations` lehnt es vor
  dem geringsten Schreiben ab;
- das Entpacken geschieht in einem temporären Ordner, der nach Vollendung auf
  sein endgültiges Ziel umbenannt wird. Ein abgebrochener Download hinterlässt
  daher nie eine halb installierte Version, sondern ein `.tmp-…`, das der
  nächste Start wegkehrt (`cleanTempDirs()`, bei `ClientReady` aufgerufen).

Eine Installation zur Zeit: zwei gleichzeitige Downloads zielten auf denselben
temporären Ordner und stritten um den Neustart. Der Vorgang meldet seinen
Fortschritt laufend, damit das Dashboard etwas anderes zeigt als einen
eingefrorenen Bildschirm.

### Entpacken ohne Abhängigkeit

[`targz.js`](../../../src/versioning/targz.js) entpackt das Archiv in einem Zug
im Speicher und durchläuft es dann Block für Block zu 512 Byte. Das erspart es,
dem Projekt eine Bibliothek hinzuzufügen, und vor allem, von einem System-`tar`
abzuhängen, dessen Vorhandensein und Dialekt von Rechner zu Rechner nicht
gewährleistet sind.

Zwei Punkte verdienen Aufmerksamkeit:

- **die langen Namen.** Das ustar-Format bringt einen Namen auf 100 Byte unter,
  ergänzt um ein Präfix von 155. Darüber hinaus gibt der Archivierer einen
  Eintrag mit dem wirklichen Namen unmittelbar vor dem beschriebenen Eintrag aus:
  `L` bei GNU, `x` (pax-Kopfzeile) bei den anderen. GitHub verwendet je nach
  Repository beide, also werden beide behandelt;
- **die Pfaddurchquerung.** Ein Eintrag namens `../../anderes` verließe den
  Zielordner. Jeder Pfad wird daher aufgelöst und dann als strikter Nachfahre des
  Ziels geprüft, bevor irgendetwas geschrieben wird.

---

## Wechseln

`resolveEntryPoint(tag)` übersetzt eine Wahl des Benutzers in eine zu startende
Datei und lehnt eine Version ab, die örtlich nicht verfügbar ist.

Der Wechsel selbst bedient sich des gewöhnlichen Neustarts (`restartProcess` aus
[`systemHandlers.js`](../../../src/web/websocket/handlers/systemHandlers.js)):
der neue Prozess wird **abgekoppelt** gestartet, mit `IMP_RESTART=1` in seiner
Umgebung, und der alte schaltet sich ab. Diese Variable kennzeichnet eine
Wiederaufnahme und kein Einschalten — was die Eröffnungsblende entfallen und den
Lieblingskanal zugunsten des zuletzt besuchten übergehen lässt (siehe
[06 — Persistenz](06-persistance.md#database)).

Die drei WebSocket-Nachrichten des Bereichs — `listVersions`, `installVersion`,
`uninstallVersion` — sind **dem Sitzungsmeister vorbehalten**. Die laufende
Version zu wechseln ist kein Wiedergabebefehl, den man teilt. Siehe
[07 — Sicherheit](07-securite.md#geteilte-rechte).

---

## Bei Änderungen

- Nie einen Datenpfad von `__dirname` aus auflösen: das wäre die
  Installationswurzel, und eine installierte Release schriebe ihre Einstellungen
  in ihren eigenen Ordner statt in die geteilte Wurzel.
- Jedes Schreiben oder Löschen, das auf `versions/` zielt, muss über
  `assertTargetInstallable()` oder `assertTargetRemovable()` gehen.
- Ein neues Katalogfeld muss ohne Netz lesbar bleiben: das Menü arbeitet ohne
  GitHub, und das ist eine Eigenschaft, die nicht verloren gehen darf.
