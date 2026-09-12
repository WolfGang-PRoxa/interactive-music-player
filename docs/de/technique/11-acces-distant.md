# 11 — Fernzugriff

[← Inhalt](README.md)

Der Bot lauscht standardmäßig auf `127.0.0.1`. Dieses Kapitel behandelt die zwei
Dinge, die zu tun sind, damit er von anderswo erreicht wird: ihm eine öffentliche
Adresse geben und jemand anderen als seinen Besitzer hereinlassen.

---

## Die öffentliche Adresse

`PUBLIC_URL` ist die Adresse, unter der Gäste dieses Dashboard erreichen, ohne
abschließenden Schrägstrich. **Sie lässt sich nicht erraten**: der Server lauscht
auf `127.0.0.1`, und die nützliche Adresse — IP des lokalen Netzes, Tunnel,
Domänenname — kennt nur der Betreiber.

Sie dient nicht bloß der Anzeige. Discord verlangt, dass die Rückruf-URL **genau**
derjenigen entspricht, die im Entwicklerportal eingetragen ist, Reiter *OAuth2 →
Redirects*:

```
PUBLIC_URL=http://192.168.1.20:3000
      └──► einzutragen   http://192.168.1.20:3000/auth/discord/callback
```

Ohne `PUBLIC_URL` zeigt die Rückruf-URL auf `127.0.0.1`: der Ablauf gelingt vom
Wirtsrechner aus und scheitert überall sonst. In diesem Fall wird beim Start eine
Warnung protokolliert.

Sie erklärt auch den Umweg des Tokens über den OAuth-`state`: das Dashboard
öffnet sich auf `127.0.0.1`, wo sein Cookie gesetzt wird, während Discord auf
`PUBLIC_URL` zurückschickt. Zwei Wirte, zwei Cookie-Gläser und ein Rückruf, der
das Token nicht hat — siehe
[07 — Sicherheit](07-securite.md#authentifizierung).

---

## Der Tunnel

Das Dashboard nach außen zu öffnen verlangte vier Gesten, die nichts ankündigte:
Tailscale installieren, den Rechner authentifizieren, vom Tailnet das Recht zu
veröffentlichen erlangen und dann den Funnel aufbauen. Jede scheitert auf ihre
Weise, und keine sagt, was fehlt — man entdeckte den nächsten Schritt, indem man
dagegenstieß. Schlimmer: die gewonnene öffentliche Adresse musste von Hand in
`PUBLIC_URL` abgeschrieben werden, und diese Abschrift reiste mit dem Repository.
Eine Installation auf einem zweiten Rechner erbte so die Adresse des ersten, und
die Hin- und Rückreise der Discord-Anmeldung schickte den Benutzer zum Computer
nebenan.

[`tailscale.js`](../../../src/web/tailscale.js) tut von sich aus nichts: es
**stellt fest**. Es antwortet „hier stehst du, und das fehlt“, in einem
Wortschatz, den die Oberfläche in einen Satz übersetzt. Die Gesten, die sich
automatisieren lassen, werden ihm ausdrücklich aufgetragen, eine nach der
anderen.

### Die sieben Zustände

Sie sind **geordnet**: jeder setzt den vorigen als erreicht voraus, was erlaubt,
sie als Fortschritt statt als Befund darzustellen.

| Zustand | Was festgestellt wird | Nächste Geste |
|---|---|---|
| `absent` | Der Befehl `tailscale` ist nicht auffindbar | Tailscale installieren |
| `unreachable` | Installiert, doch der Dienst antwortet nicht | Den Dienst starten |
| `needsLogin` | Rechner an keinem Tailnet angemeldet | `tailscale up` oder ein Authentifizierungsschlüssel |
| `needsCapability` | Angemeldet, doch das Tailnet gewährt kein Veröffentlichungsrecht | HTTPS und Funnel in der Verwaltungskonsole freischalten |
| `ready` | Alles steht bereit; der Funnel ist noch aufzubauen | `mount()` — absichtlich |
| `serving` | Der Funnel veröffentlicht tatsächlich dieses Dashboard | — |
| `otherTarget` | Der Funnel veröffentlicht **etwas anderes** | Ihn nicht unangekündigt überschreiben |

Die ganze Entscheidung steckt in `decide()`, getrennt von dem, was sie speist:
sie arbeitet auf zwei bereits gelesenen Objekten, was erlaubt, sie an allen
sieben Zuständen zu erproben, ohne Tailscale zu installieren, es zu trennen oder
dem Tailnet ein Recht zu entziehen, um zu sehen, was dabei herauskommt.
`inspect()` trägt nur noch die Eimer.

Ein Befehl, der sich hinzieht, gilt so viel wie ein fehlender — der Dienst kann
eingefroren sein —, daher eine Frist von acht Sekunden. Und wenn der `PATH` den
Befehl noch nicht trägt, werden die bekannten Orte aufgesucht: eine frische
Installation aktualisiert den `PATH` bereits gestarteter Prozesse nicht, und der
vor ihr gestartete Bot sähe nichts, was der Benutzer für eine misslungene
Installation hielte.

### Was sich nicht automatisieren lässt

Drei Dinge, und es ist besser, sie zu sagen, als sie zu umgehen:

- **Die Installation** verlangt Administratorrechte. Ein Dienst unter einem
  Benutzerkonto nimmt sie sich nicht ohne eine Abfrage des Systems.
- **Das Tailscale-Konto** lässt sich über keine API anlegen. Ein
  Authentifizierungsschlüssel nimmt die Interaktivität, doch es braucht bereits
  ein Konto, um ihn auszustellen.
- **Das Recht zu veröffentlichen** (`funnel`, `https`) gewährt die Richtlinie des
  Tailnets, also die Verwaltungskonsole.

### Den Funnel aufzubauen bleibt eine Geste

Der Funnel legt das Dashboard **dem gesamten Internet** offen, nicht dem lokalen
Netz. Ihn ungefragt aufzubauen würde den Player eines Menschen ohne dessen Wissen
veröffentlichen: es ist der einzige Schritt, den das Modul standardmäßig
verweigert, selbst wenn alles bereitsteht. `mount()` gibt es, man muss es
aufrufen.

Der Aufruf erfolgt mit `--bg` — die Vordergrundform blockierte den Start des Bots
— und mit `--yes`, da eine Bestätigungsabfrage in einem Dienst keinen Leser hat.

### Der Zustand steckt nicht in der gewöhnlichen Sendung

Ihn festzustellen startet zwei Prozesse. Dies jede Sekunde zu tun, für einen
Wert, der sich nur auf jemandes Geste bewegt, hieße eine Anzeige teuer zu
bezahlen, die die meiste Zeit niemand ansieht. Das Fenster fordert ihn beim
Öffnen an, über `tunnelState`.

Die vier Nachrichten des Bereichs — `tunnelState`, `tunnelLogin`, `tunnelMount`,
`tunnelUnmount` — sind **dem Sitzungsmeister vorbehalten**. Das Dashboard von
außen erreichbar zu machen oder es nicht mehr zu sein, ist kein Wiedergabebefehl,
den man teilt.

Beim Start schreibt `announce()` eine Zeile ins Protokoll, und jede trägt **die
Handlung statt der Feststellung**: „nicht installiert“ lehrt den nichts, der
eben eine Konsole geöffnet hat, „installiere es hier“ schon. Es ist das
Gegenstück zur OAuth-Spur, und aus demselben Grund — das sind die einzigen zwei
Dinge, die man beim Installieren des Bots auf einem neuen Rechner nicht erraten
kann.

---

## Jemanden hereinlassen

Der vollständige Weg, vom geposteten Link bis zum steuernden Gast:

```
Meister ──sendInviteLink──► der Bot postet den Link im Chat des Sprachkanals
                                            │
                      der Gast klickt ──────┴──► GET /auth/discord
                                                       │
                                            Discord weist ihn aus
                                                       │
                                            GET /auth/discord/callback
                                                       │
                                      Sitzung eröffnet, Eintrag im Buch
                                                       │
                                      Dashboard **reglos**: keinerlei Recht
                                                       │
Meister ──admitGuest─────────────────────────────► der Gast ist zugelassen
Meister ──shareControl───────────────────────────► Rechte gewährt, Geste für Geste
```

Die Reihenfolge ist gewollt: der Meister kann nur für Leute Häkchen setzen, die
sich vorgestellt haben. Ein erkannter Gast ohne Rechte sieht ein Dashboard, das
alles anzeigt und nichts befiehlt.

Der im Chat gepostete Link **trägt das Zugangstoken nicht**. Das ist es, was ihn
postbar macht: das Token erscheint in der Konsole dessen, der den Bot gestartet
hat, und es ist die volle Kontrolle wert. Der Gast, der klickt, bringt nichts
mit als sein Discord-Konto.

Ein Konto, das auf keinem Server des Bots Mitglied ist, wird abgewiesen — an der
Tür wie überall.

### Sich an einen Gast erinnern

Eine Discord-Sitzung überschreitet die Grenze zwischen zwei Browsern nicht und
dauert kürzer als die Rechte, die man gewährt. Zwei Fragen werden daher getrennt,
und diese Trennung genügt: **wer ist diese Person?** gehört zum Buch
([`guests.js`](../../../src/web/guests.js), `data/guests.json`), **gehört dieser
Tab ihr?** gehört zur Sitzung
([`sessions.js`](../../../src/web/sessions.js)).

Das Buch enthält **kein Geheimnis**: kein Zugangstoken, kein Discord-Token,
nichts, womit man sich für jemanden ausgeben könnte. Darin zu stehen bedeutet
„dieses Konto hat sich mindestens einmal ausgewiesen“, nie „dieses Konto darf…“.

Siehe [07 — Sicherheit](07-securite.md#sich-an-einen-gast-erinnern) für die
stumme Erkennung (`prompt=none`) und ihre Schutzgeländer.

---

## Bei Änderungen

- Eine neue Nachricht, die den Tunnel oder die Teilung berührt, muss in
  [`permissions.js`](../../../src/web/permissions.js) als `MASTER_ONLY` deklariert
  werden. Eine der Tabelle unbekannte Nachricht ist es zwar bereits
  standardmäßig, doch sich auf den Rückfall zu verlassen macht die Absicht
  unlesbar.
- Nie die Rückruf-URL clientseitig bauen: das Discord-Portal erwartet jene, die
  der Server baut, und ein Unterschied von einem Zeichen lässt den ganzen Ablauf
  scheitern.
- `decide()` muss eine reine Funktion seiner zwei Argumente bleiben. Das ist es,
  was es ohne installiertes Tailscale erprobbar macht.
