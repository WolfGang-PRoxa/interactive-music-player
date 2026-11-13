# 11 — Fernzugriff

[← Inhalt](README.md)

Der Bot lauscht standardmäßig auf `127.0.0.1`. Dieses Kapitel behandelt die zwei
Dinge, die nötig sind, damit er von anderswo erreichbar ist: ihm eine
öffentliche Adresse geben, und jemand anderen als seinen Eigentümer hereinlassen.

---

## Die öffentliche Adresse

Zwei Fälle, je nachdem, ob die Adresse fest ist oder nicht.

**Ohne feste Adresse** — der Standardfall — ist nichts einzutragen. Die schnelle
Freigabe (siehe [der Tunnel](#der-tunnel)) erhält von Cloudflare bei jedem Start
eine neue Adresse, und das Rückkehr-Relais kümmert sich um Discord.

**Mit einer festen Adresse** — eine Domain hinter einem benannten Tunnel, eine
IP im lokalen Netz — trägt `PUBLIC_URL` sie, ohne abschließenden Schrägstrich.
Sie lässt sich nicht erraten, und Discord verlangt, dass die Rückruf-URL
**genau** der im Entwicklerportal eingetragenen entspricht, Reiter
*OAuth2 → Redirects*:

```
PUBLIC_URL=https://imp.romainpiau.dev
      └──► eintragen   https://imp.romainpiau.dev/auth/discord/callback
```

`PUBLIC_URL` gewinnt immer: sobald sie gesetzt ist, tritt das Relais zurück, und
der Weg wird wieder direkt. Sie erklärt auch den Umweg des Tokens über den
OAuth-`state`: das Dashboard öffnet sich auf `127.0.0.1`, wo sein Cookie liegt,
während Discord auf `PUBLIC_URL` zurückleitet. Zwei Hosts, zwei Keksdosen, und
ein Rückruf, der das Token nicht hat — siehe
[07 — Sicherheit](07-securite.md#authentifizierung).

### Das Rückkehr-Relais

Discord leitet einen Besucher nur an eine im Voraus eingetragene Adresse
zurück. Die der schnellen Freigabe ändert sich bei jedem Start: man müsste bei
jedem Start ins Portal zurück. Das Relais
([`oauthRelay.js`](../../../src/web/oauthRelay.js), und der Worker in
`tools/oauth-relay/`) ist eine feste Station zwischen beiden:

```
Dashboard ──/auth/discord──► Discord ──► Relais (feste Adresse, einmal eingetragen)
      ▲                                          │
      └──── /auth/discord/callback?code=… ◄──────┘  zum Ursprung aus dem state
```

Der `state` trägt nach seinem zufälligen Teil den Ursprung, von dem die
Anmeldung ausging. Das Relais schickt den Besucher mit dem Code dorthin zurück.
Die Rückkehr landet also dort, wo die Cookies des Browsers leben — das Token, der
`nonce` der Anmeldung —, ob das Dashboard nun auf `localhost` oder über den Link
des Tunnels geöffnet wurde.

Das Relais sieht nur einen Einmal-Code vorbeiziehen, wertlos ohne das Geheimnis
der Anwendung, das allein der Bot besitzt. Es speichert nichts und
protokolliert nichts. Ein Standard-Relais ist für alle Installationen
bereitgestellt; `OAUTH_RELAY_URL` bezeichnet ein anderes, und
`OAUTH_RELAY_URL=off` verzichtet darauf.

| Ziel | Angenommen | Warum |
|---|---|---|
| `https://….trycloudflare.com` | Ja | Die schnelle Freigabe, deren Adresse sich ändert |
| `http://localhost:<Port>`, `http://127.0.0.1:<Port>` | Ja | Der Rechner selbst |
| Eine Domain, eine IP im lokalen Netz | Nein | Eine feste Adresse wird direkt bei Discord eingetragen |
| Jede andere Adresse | Nein | Ein offenes Relais würde Codes an beliebige Empfänger liefern |

Die Regel ist zweimal geschrieben — im Bot und im Worker, der nichts aus dem
Repository importiert —, und [`tests/oauthRelay.js`](../../../tests/oauthRelay.js)
prüft beide an denselben Fällen.

---

## Der Tunnel

Das Dashboard nach außen zu öffnen lief über Tailscale Funnel und verlangte vier
Gesten, die nichts ankündigte: Tailscale mit Administratorrechten installieren,
ein Konto anlegen, vom Netz das Recht zum Veröffentlichen erhalten, den Funnel
aufbauen. Jeder Nutzer des Bots musste alle vier wiederholen.

[`cloudflare.js`](../../../src/web/cloudflare.js) ersetzt sie durch zwei, die der
Bot auf einen Klick erledigt. `cloudflared` ist eine einzelne ausführbare Datei:
sie wird nicht installiert, sondern in `data/bin/` abgelegt und gestartet, ohne
besondere Rechte. Der Bot lädt sie von den offiziellen Veröffentlichungen
Cloudflares herunter und öffnet dann den Tunnel. Wie das Modul, das er ersetzt,
**stellt** er zuerst **fest** und handelt nur auf Anfrage.

### Die Zustände

| Zustand | Was festgestellt wird | Nächste Geste |
|---|---|---|
| `absent` | `cloudflared` ist nicht zu finden | Herunterladen (ein Klick) |
| `downloading` | Der Download läuft | — |
| `needsAddress` | Token eines benannten Tunnels, aber keine `PUBLIC_URL` | Die Adresse des Tunnels eintragen |
| `ready` | Alles ist bereit; der Tunnel muss noch geöffnet werden | `mount()` — bewusst |
| `starting` | Gestartet, Cloudflare hat noch nicht bestätigt | Ein paar Sekunden warten |
| `serving` | Das Dashboard ist aus dem Internet erreichbar | — |
| `failed` | Der Tunnel hat sich selbst beendet | Erneut versuchen, die Ursache steht dabei |

Die ganze Entscheidung steckt in `decide()`, einer reinen Funktion des
Festgestellten: jeder Zustand lässt sich prüfen, ohne `cloudflared`
herunterzuladen oder einen Tunnel zu öffnen. Zum Feststellen wird nichts
gestartet — alles liegt schon im Prozess des Bots —, sodass das Fenster den
Zustand so oft abfragen kann, wie es will.

### Die schnelle Freigabe

Das ist der Standardmodus, und er braucht kein Konto. `cloudflared tunnel --url`
öffnet einen Tunnel, und Cloudflare weist ihm eine Adresse
`https://….trycloudflare.com` zu, die aus seiner Ausgabe gelesen wird — nie
erraten. `api.trycloudflare.com`, das in seinen Fehlern auftaucht, ist keine.

Die Adresse ändert sich bei jedem Start. Die Gäste leiden nicht darunter, da der
Bot ihnen den Link postet; Discord geht über das Relais. Sie wird **nie in
`PUBLIC_URL` kopiert**: die Cookies würden `Secure`, und die Sitzung dessen, der
am Rechner sitzt, auf `http://localhost`, hielte nicht mehr.

Cloudflare stellt diese Tunnel als Testwerkzeug vor: keine
Verfügbarkeitsgarantie und eine Obergrenze gleichzeitiger Anfragen. Für einen
Kanal unter Freunden reicht das reichlich; die feste Adresse bleibt, falls es
eng wird.

### Die feste Adresse

Wer eine Domain bei Cloudflare besitzt, legt in seinem Dashboard einen benannten
Tunnel an (*Zero Trust → Networks → Tunnels*), gibt ihm einen Hostnamen, der zu
`http://localhost:<Port>` führt, und kopiert zwei Werte in `.env`:

```
CLOUDFLARE_TUNNEL_TOKEN=eyJhIjoi…
PUBLIC_URL=https://imp.romainpiau.dev
```

Der Bot startet dann diesen Tunnel statt der schnellen Freigabe. Das Token geht
über die Umgebung von `cloudflared` (`TUNNEL_TOKEN`) und nie über seine
Befehlszeile, wo jeder Prozess des Rechners es lesen könnte. Ein benannter
Tunnel kennt seinen eigenen Hostnamen nicht — er lebt im Cloudflare-Dashboard
—, daher der Zustand `needsAddress`, wenn `PUBLIC_URL` fehlt.

Ein und derselbe Tunnel darf nur auf einem Rechner zugleich laufen: auf zweien
gestartet, würde Cloudflare die Besucher zwischen ihnen aufteilen.

### Was nie von selbst geschieht

Veröffentlichen setzt das Dashboard dem **gesamten Internet** aus. Es ungefragt
zu tun, würde den Player eines Menschen ohne dessen Wissen veröffentlichen:
`mount()` wird nur auf eine Geste des Meisters hin aufgerufen. Diese Geste wird
gemerkt (`data/tunnel.json`), und der Tunnel öffnet sich beim nächsten Start
wieder — wie der Funnel, der Neustarts überlebte. Die Freigabe zurückzuziehen
vergisst sie.

Der Tunnel lebt mit dem Prozess des Bots und endet mit ihm.

Die vier Nachrichten des Bereichs — `tunnelState`, `tunnelInstall`,
`tunnelMount`, `tunnelUnmount` — sind **dem Sitzungsmeister vorbehalten**. Das
Dashboard erreichbar zu machen oder eine ausführbare Datei auf den Rechner des
Gastgebers zu holen, ist kein Befehl, den man teilt.

### Die Grenzen von Cloudflare

- **100 MB pro Anfrage** im kostenlosen Tarif, darüber antwortet Cloudflare mit
  413, ohne dass der Bot etwas davon sieht. Der Browser teilt deshalb jede Datei
  über 64 MB auf, und der Server setzt die Stücke wieder zusammen
  ([`chunkedUpload.js`](../../../src/web/chunkedUpload.js)). `MAX_UPLOAD_MB`
  gilt für die Gesamtgröße und behält seinen vollen Sinn.
- **Eine einzige Herkunftsadresse.** Alle Anfragen kommen von `cloudflared`,
  also vom Rechner selbst: der Ratenbegrenzer liest die echte Adresse in
  `CF-Connecting-IP`, der er nur bei einer Verbindung vom Rechner selbst traut.
- **Video.** Die CDN-Bedingungen von Cloudflare behalten die Auslieferung von
  Video grundsätzlich den bezahlten Angeboten vor. Eine private Nutzung unter
  Freunden bleibt bescheiden, doch das Video-Relais des Dashboards liegt in
  einer Grauzone.

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
- Die Ziele des Relais anzufassen heißt, beide Kopien der Regel anzufassen —
  `oauthRelay.js` und `tools/oauth-relay/src/index.js` — und den Worker neu
  bereitzustellen.
- `decide()` muss eine reine Funktion dessen bleiben, was es erhält. Das ist es,
  was es ohne `cloudflared` erprobbar macht.
