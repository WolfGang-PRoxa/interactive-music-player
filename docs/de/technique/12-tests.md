# 12 — Tests

[← Inhalt](README.md)

Fünfzig Suiten leben in [`tests/`](../../../tests/), alle von `npm test`
gestartet. Sie folgen keinem Test-Rahmenwerk: es sind gewöhnliche Node-Skripte,
die laufen und einen Beendigungscode zurückgeben.

---

## Die Haltung

**Keine Testabhängigkeit.** Weder Jest noch Mocha noch `node:test`. Jede Suite
ist eine Datei, die ihre Erfolge und ihre Fehlschläge zählt, sie ausgibt und dann
mit `0` oder `1` endet:

```js
let failed = 0;
let passed = 0;
const check = (label, ok, detail = '') => {
    if (ok) { passed++; }
    else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

// …

console.log(`=== ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
```

Das passt zum Rest des Projekts — nichts wird übersetzt, nichts gebündelt — und
folgt einem wirklichen Zwang: das Wesentliche dessen, was hier zu erproben ist,
ist Browser-JavaScript, das ohne Module ausgeliefert wird und über
`window.MusicPlayer` verkehrt. Ein Rahmenwerk, das ES-Importe voraussetzt, hätte
damit nichts zu schaffen. Die Frontend-Suiten laden die Datei daher, werten sie
in einem von Hand vorbereiteten Kontext aus und schauen, was sie ablegt.

**Eine Suite erzählt, warum es sie gibt.** Der Kopf jeder Datei beschreibt den
Mangel, den sie fängt, und was dieser Mangel gekostet hat. Das ist der Teil, den
zu lesen sich zuerst lohnt, wenn eine Suite fällt: er sagt oft unmittelbar, was
eben zerbrochen wurde.

---

## Die drei Familien

| Familie | Was erprobt wird | Beispiele |
|---|---|---|
| **Einheiten** | Eine Funktion, ohne etwas darum herum | `loudness`, `downloadFormats`, `historyOrder`, `rangeStream` |
| **Verhalten** | Ein serverseitiges Modul, mit Doubles | `channelQueue`, `transitions`, `pilotElection`, `shareGrant` |
| **Frontend** | Ein Skript aus `public/js/`, in einem künstlichen Kontext ausgewertet | `speedPadPointer`, `toastSwipe`, `scrollFade`, `themeBlend` |

Dazu kommen zwei Suiten, die nicht den Anwendungscode betreffen:
`docsIntegrity` und `docsLanguages`, weiter unten beschrieben.

---

## Der Rauchtest

[`tests/smoke.js`](../../../tests/smoke.js) ist der einzige, der den Bot
wirklich startet. Er geht in zwei Stufen vor, von der billigsten zur teuersten:

1. **Laden** — jedes Modul von `src/` wird eingebunden. Fängt zerbrochene
   `require()`-Aufrufe, verschwundene Exporte und Syntaxfehler. Die beiden
   Einstiegspunkte (`src/index.js`, `src/deploy-commands.js`) sind ausgenommen:
   sie zu laden startete den Bot.
2. **Integration** — der Bot wird gestartet und dann über HTTP und WebSocket
   befragt. Fängt, was das Laden nicht sieht: ein nur auf einer Seite umbenanntes
   Protokollfeld, eine Route, die nicht mehr antwortet.

Er trägt eine Liste `STATE_FIELDS` der Felder erster Ebene der Nachricht `state`.
**Sie ist wissentlich zu pflegen**, wenn ein Protokollfeld umbenannt wird — genau
diese Art von Versäumnis gibt es diesen Test, denn eine nur auf einer Seite
vollzogene Umbenennung erzeugt keinen Fehler, bloß eine leere Anzeige.

> Der Rauchtest braucht den Port des Dashboards. Läuft der Bot bereits auf dem
> Rechner, scheitert seine Integrationsstufe an einem belegten Port: das ist
> keine Regression, das ist die Umgebung. Die laufende Instanz vor dem Start
> abschalten.

---

## Die zwei Dokumentationssuiten

Sie hüten eben dieses Korpus und verdienen es, vor einem Eingriff bekannt zu
sein.

[`docsIntegrity.js`](../../../tests/docsIntegrity.js) prüft drei Dinge, die
lautlos zerbrechen und die kein Gegenlesen einer Übersetzung zeigt:

- **Die Anker.** Ein Verweis auf `05-tableau-de-bord.md#robustheit` bezeichnet
  eine Überschrift. Die Überschrift zu übersetzen, ohne den Anker zu übersetzen,
  oder umgekehrt, ergibt einen Verweis, der nirgendwohin führt — allein in dieser
  Sprache. Die Berechnung des Ankers greift die von `js/docs.js` auf, die der
  Übereinkunft von GitHub folgt.
- **Das Gerüst.** Eine Übersetzung muss **ebenso viele Überschriften, Codeblöcke
  und Tabellenzeilen** haben wie ihr französisches Original. Eine Abweichung
  meldet einen vergessenen Abschnitt oder eine abgeschnittene Tabelle, was eine
  Datei von 15 KB nicht zeigt.
- **Die Verweise auf den Code.** Sie durchqueren `docs/<Sprache>/technique/`, um
  zu `src/` hinaufzusteigen. Die Dokumentation um eine Ebene zu verschieben
  zerbricht sie alle auf einmal, ohne dass etwas es meldet: es sind
  Repository-Verweise, die der Leser des Dashboards nicht einmal öffnet.

[`docsLanguages.js`](../../../tests/docsLanguages.js) hängt den echten API-Router
an einen flüchtigen Port und prüft den Dienst: die Bestandsaufnahme geht von
`docs/<Sprache>/` aus und nie von `docs/`, die Kennungen tragen die Sprache
nicht, und nichts, was vom Client kommt, wird zu einem Pfad zusammengesetzt.

**Praktische Folge.** Jede Änderung der französischen Dokumentation muss mit dem
**gleichen Gerüst** in die drei Übersetzungen übertragen werden: dieselbe Zahl an
Überschriften, Codeblöcken und Tabellenzeilen. Eine Zeile zu einer französischen
Tabelle hinzuzufügen, ohne sie den drei anderen hinzuzufügen, lässt
`docsIntegrity` fallen.

---

## Die Tests starten

| Befehl | Wirkung |
|---|---|
| `npm test` | Die fünfzig Suiten, der Reihe nach. Hält bei der ersten an, die scheitert. |
| `npm run smoke` | Nur der Rauchtest |
| `npm run test:<Name>` | Eine bestimmte Suite — ein Skript je Suite in `package.json` |

Die Verkettung von `npm test` erfolgt mit `&&`: die erste Suite, die mit `1`
endet, bricht den Rest ab. Das ist gewollt — eine querliegende Regression ließe
dreißig Suiten fallen, und die erste zu lesen ist nützlicher, als durch die
übrigen zu blättern.

---

## Eine Suite schreiben

1. `tests/<Name>.js` anlegen.
2. Im Kopf **den Mangel beschreiben, den die Suite fängt**, und was er gekostet
   hat. Nicht, was der Code tut: was ohne sie zerbrach.
3. Den obigen Zähler `check()` übernehmen und mit
   `process.exit(failed === 0 ? 0 : 1)` enden.
4. `"test:<Name>": "node tests/<Name>.js"` in `package.json` ergänzen **und** es
   in die Kette des Skripts `test` einfügen. Beides: das einzelne Skript dient
   der Entwicklung, die Kette der Gesamtprüfung.

Eine Suite, die den Server braucht, hängt den echten Router an einen flüchtigen
Port (`server.listen(0, '127.0.0.1')`) mit einem künstlichen `webServer`, wie es
`docsLanguages` tut. Den ganzen Bot zu starten ist nur für den Rauchtest nötig.
