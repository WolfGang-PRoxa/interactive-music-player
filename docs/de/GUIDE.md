# Benutzerhandbuch — Bot Interaktive Musik

Dieses Handbuch beschreibt die Nutzung des Bots innerhalb von Discord sowie die
Bedienung seines Web-Dashboards.

Für die Entwicklerdokumentation siehe
[docs/de/technique/](technique/README.md).

---

## Inhalt

- [Erste Schritte](#erste-schritte)
- [Zugang zum Dashboard](#zugang-zum-dashboard)
- [Discord-Befehle](#vollständige-referenz-der-discord-befehle)
- [Web-Dashboard](#nutzung-des-web-dashboards)
- [Typische Szenarien](#typische-anwendungsszenarien)
- [FAQ](#häufig-gestellte-fragen)

---

## Erste Schritte

### 1. Start des Bots

Der Bot muss auf Ihrem Rechner laufen, um auf Befehle zu antworten. Unter
Windows genügt ein Doppelklick auf `Start bot.vbs` im Stammverzeichnis des
Projekts.

Damit Sie diesen Ordner nie wieder öffnen müssen, legen Sie sich ein für alle
Mal eine Verknüpfung an: Doppelklicken Sie auf `Create shortcut.vbs` im
Stammverzeichnis des Projekts, wählen Sie im Assistenten den gewünschten Ort,
und die Verknüpfung wird dort eingerichtet. Ein Doppelklick darauf startet
anschließend den Bot und öffnet das Dashboard.

Der Bot startet **im Hintergrund**: es öffnet sich kein Terminalfenster und in
der Taskleiste erscheint nichts. Ein kleines Fenster zeigt Ihnen, wie weit der
Start gediehen ist, hakt die Schritte nach und nach ab und verschwindet dann von
selbst, sobald der Bot bereit ist — das Dashboard öffnet sich gleich darauf in
Ihrem Browser. Hakt etwas, bleibt das Fenster stehen und sagt Ihnen, was zu tun
ist: Node.js installieren, die Einrichtung erneut durchlaufen oder die
Protokolle einsehen. Der erste Start dauert länger als die folgenden: er
installiert die Abhängigkeiten.

**Beim allerersten Start** startet dieses Fenster nichts, sondern begleitet Sie.
Der Bot braucht seine eigene Discord-Anwendung, und niemand kann sie an Ihrer
Stelle anlegen — ein Token bezeichnet eine Anwendung und wird nicht geteilt. Um
alles Übrige kümmert sich das Fenster:

- eine Schaltfläche öffnet Discords Entwicklerportal, wo Sie die Anwendung
  anlegen (*New Application*) und dann im Reiter *Bot* auf *Reset Token* und
  *Copy* klicken;
- es gibt nichts einzufügen: sobald das Token in Ihrer Zwischenablage liegt,
  erkennt das Fenster es, legt es Discord vor und zeigt Ihnen den Namen der
  Anwendung zurück. Das Feld bleibt für die Fälle, in denen diese Erkennung
  nicht durchkommt;
- nach der Anwendungskennung wird **nicht** gefragt — sie ergibt sich aus dem
  Token. Die Datei `.env` wird für Sie geschrieben, ohne dass Sie sie öffnen
  müssten;
- eine letzte Schaltfläche lädt den Bot auf Ihren Server ein, die Berechtigungen
  bereits angehakt. Der Bot startet unterdessen, ohne zu warten, bis Sie fertig
  sind.

Ein Token, das Discord ablehnt, wird auf der Stelle gemeldet, mit dem Grund —
statt beim nächsten Start, in Gestalt eines Bots, der wortlos stehen bleibt. Und
wenn das gespeicherte Token nicht mehr angenommen wird, weil es seither im
Portal neu erzeugt wurde, bietet das Fenster an, diese Einrichtung zu
wiederholen.

**Zum Anhalten des Bots** verwenden Sie die Ausschaltschaltfläche des
Dashboards: sie ersetzt das Schließen der Konsole. Die Schaltfläche zum Neustart
steht dort ebenfalls bereit.

Läuft der Bot bereits, wenn Sie ihn erneut starten, sagt das kleine Fenster
Ihnen das, statt einen zweiten zu starten, und bietet Ihnen an Ort und Stelle
an, das Dashboard zu öffnen, neu zu starten oder auszuschalten. Das Öffnen des
Dashboards prüft zuerst, ob nicht bereits ein Tab damit verbunden ist, um nicht
noch einen weiteren aufzuschichten; das Ausschalten wiederum verlangt eine
Bestätigung.

Auf der Kommandozeile entspricht dem Start `npm start` aus dem Projektordner —
diesmal mit einer Konsole und ihren Protokollen in Echtzeit.

### 2. Verbindung mit einem Sprachkanal

Bevor Sie den Bot in Anspruch nehmen, verbinden Sie sich mit einem der
Sprachkanäle Ihres Discord-Servers. Der Bot benötigt Ihre Anwesenheit in einem
Sprachkanal, um sich dort verbinden und Audioströme senden zu können.

### 3. Start eines Audiotitels

Geben Sie den folgenden Slash-Befehl in einem beliebigen erlaubten Textkanal
ein:

```
/play query:Name des Titels oder URL
```

Der Bot führt daraufhin folgende Schritte aus:

1. Automatische Verbindung mit Ihrem aktuellen Sprachkanal.
2. Suche und Abruf der Metadaten des Titels.
3. Initialisierung der Audiowiedergabe.
4. Versand einer Übersichtskarte mit Titel, Interpret, Dauer und Vorschaubild
   des Stücks.

---

## Zugang zum Dashboard

Das Dashboard ist durch ein **Zugangstoken** geschützt. Ohne dieses zeigt die
Seite „Zugriff verweigert".

### Mit Discord anmelden

Beim Öffnen fordert ein Fenster zur Anmeldung mit dem Discord-Konto auf. Es
lässt sich nicht schließen: das Dashboard steuert einen Bot auf deinen Servern
und gehorcht niemandem, der seinen Namen nicht nennt.

Angefragt werden nur deine Kennung, dein Name und dein Avatar — weder deine
Server noch deine E-Mail-Adresse. Dein Konto muss außerdem Mitglied eines
Servers sein, auf dem der Bot ist.

Das **erste Konto, das sich unter Vorlage des Tokens anmeldet**, wird ein für
alle Mal Eigentümer der Installation. Das ist, wer den Bot gestartet hat: das
Token steht in dessen Konsole, und der an Zuhörer verschickte Einladungslink
trägt es nicht. Der Eigentümer behält alle Rechte; alle anderen haben nur die,
die er ihnen einräumt (siehe „Kontrolle teilen").

Um die Installation an ein anderes Konto zu übergeben, lösche die Datei
`data/owner.json` und melde dich erneut mit dem Token an.

Ist die Discord-Anwendung nicht eingerichtet — `DISCORD_CLIENT_SECRET` oder
`PUBLIC_URL` fehlen —, ist eine Anmeldung unmöglich: das Fenster nennt dann, was
noch einzutragen ist, und lässt allein mit dem Token herein, wie zuvor. Niemand
sperrt sich wegen einer vergessenen Variable aus seinem eigenen Bot aus.

### Das Token abrufen

Es wird beim ersten Start erzeugt und Ihnen auf drei Wegen angeboten:

- der Bot **öffnet automatisch Ihren Browser** unter der richtigen Adresse,
  Token inklusive, fünf Sekunden nach dem Start;
- die vollständige Adresse wird beim Start in der Konsole angezeigt, sofern der
  Bot aus einem Terminal gestartet wurde — die Verknüpfung startet ohne Konsole;
- das Token wird in der Datei `data/dashboard-token` gespeichert.

Sobald die Seite mit dem Token geöffnet wurde, wird es in einem Cookie
gespeichert: die folgenden Besuche brauchen nichts weiter. Die Adresse wird
anschließend automatisch bereinigt, damit das Token nicht in der Adressleiste
erscheint.

Um das Dashboard von Hand zu öffnen:

```
http://localhost:3000/?token=IHR_TOKEN
```

### Zugriff von einem anderen Gerät

Standardmäßig ist das Dashboard **nur von dem Rechner aus erreichbar, der den
Bot beherbergt**. Um es von einem Telefon oder einem anderen Rechner des lokalen
Netzes aus einzusehen, fügen Sie der Datei `.env` diese Zeile hinzu und starten
neu:

```
HOST=0.0.0.0
```

Das Zugangstoken schützt dann den Zugriff aus dem Netz. Machen Sie das Dashboard
nicht ohne zusätzlichen Schutz aus dem Internet erreichbar.

### Anderswo gespeicherte Dateien abspielen

Der Bot liefert dem Browser nur Dateien aus, die in seinen eigenen Ordnern
liegen. Um eine persönliche Bibliothek zu hören, geben Sie deren Ordner in
`.env` an:

```
MEDIA_ROOTS=D:\Musik;E:\Filme
```

Ohne diese Angabe funktioniert die Wiedergabe über Discord, doch der Player des
Browsers zeigt für diese Dateien einen Fehler.

---

## Vollständige Referenz der Discord-Befehle

### Wiedergabe und Wiedergabelisten

#### `/play`

Sucht einen Titel oder spielt eine bestimmte Datei ab.

- **Textsuche**: `/play query:Name des Interpreten oder des Titels` (sucht
  standardmäßig auf YouTube).
- **Direktlink**: `/play query:https://www.youtube.com/watch?v=...`
- **Lokale Datei**: `/play query:C:\musik\titel.mp3` (absoluter Pfad auf dem
  Rechner, der den Bot beherbergt).

Unterstützte Plattformen: **YouTube**, **Spotify**, **SoundCloud** und **Apple
Music**. Bei Spotify und Apple Music holt der Bot die Metadaten und spielt das
Audio-Äquivalent von YouTube ab.

> Deezer und Qobuz werden nicht unterstützt, trotz entsprechender Variablen in
> der Konfigurationsdatei.

#### `/playlist`

Stellt sämtliche Audiodateien eines lokalen Verzeichnisses in die Warteschlange.

- Standardbefehl: `/playlist path:C:\musik\mein_album`
- Zufallswiedergabe: `/playlist path:C:\musik\mein_album shuffle:true`

Erkannte Formate: MP3, FLAC, WAV, OGG, M4A, OPUS, AAC, WMA.

---

### Steuerung der Wiedergabe

| Befehl | Wirkung |
|---|---|
| `/pause` | Hält die laufende Wiedergabe an. |
| `/resume` | Setzt die Wiedergabe des angehaltenen Titels fort. |
| `/skip` | Geht zum nächsten Titel der Warteschlange über. |
| `/stop` | Hält die Musik an und leert die Warteschlange. |
| `/nowplaying` | Zeigt den laufenden Titel mit einem Fortschrittsbalken. |

---

### Warteschlange

#### `/queue`

Zeigt die vorgemerkten Titel. Die Liste wird in Zehnergruppen umgebrochen.

- Erste Seite: `/queue`
- Bestimmte Seite: `/queue page:2`

Ein Titel, der während der Wiedergabe über `/play` hinzugefügt wird, kommt ans
Ende der Warteschlange.

---

### Lautstärke

#### `/volume`

Stellt den allgemeinen Lautstärkepegel ein (0 bis 100).

```
/volume level:60
```

Dieser Wert dient als **Bezugsgröße**. Das Ducking berechnet die Absenkung,
indem es einen Prozentsatz auf diese Grundlage anwendet: bei einer Lautstärke
von 70 und einem Ducking-Pegel von 20 % sinkt die Musik während des Sprechens
auf 14.

---

### Ducking — automatische Absenkung

Das Ducking ist das funktionale Herz des Bots: es senkt vorübergehend die
Lautstärke der Musik, wenn Nutzer sprechen, und stellt sie nach einer Stillezeit
wieder her.

| Befehl | Wirkung |
|---|---|
| `/ducking status` | Zeigt den Zustand und sämtliche Parameter des Servers. |
| `/ducking toggle` | Aktiviert oder deaktiviert die automatische Absenkung. |
| `/ducking level percent:<0-100>` | Prozentsatz der während des Sprechens beibehaltenen Lautstärke. |
| `/ducking delay ms:<n>` | Stillezeit vor der Wiederherstellung. |
| `/ducking fade ms:<n>` | Dauer des Übergangs zwischen beiden Lautstärken. |

**Einen Pegel wählen** — `15` für eine starke Absenkung, `50` für eine Halbierung,
`0` für eine vollständige Stummschaltung während des Sprechens.

**Eine Verzögerung wählen** — `400` ms für eine reaktionsschnelle Rückkehr,
`800` ms als Standard, `1500` ms für eine allmähliche Wiederherstellung. Eine
ausreichende Verzögerung vermeidet den Pumpeffekt bei kurzen Atempausen
mitten im Satz.

**Eine Blende wählen** — `100` ms für einen klaren Übergang, `200` ms als
Standard, `500` ms für einen sehr sanften Effekt.

---

### Übertragung und private Kanäle

Der Befehl `/broadcast`, **Administratoren vorbehalten**, ändert den Zielkanal:

- **Öffentlicher Modus (`everyone`)** — die Musik wird im gemeinsamen
  Sprachkanal übertragen. Alle hören denselben Strom und das Ducking greift.
- **Privater Modus (`personal`)** — die Musik wird **in Ihrem Browser**
  wiedergegeben, durch den Player des Dashboards. Der Bot bleibt im Sprachkanal
  anwesend, ohne dort Ton auszugeben. Der Bot kann auch einen temporären
  privaten Sprachkanal namens `🎵 <Ihr Name>` anlegen, der bei Ihrer Abmeldung
  automatisch gelöscht wird.

---

## Nutzung des Web-Dashboards

### Allgemeine Bedienelemente

- **Mediensteuerung** — die mittleren Schaltflächen halten die Wiedergabe an,
  setzen sie fort oder beenden sie. Die Schaltfläche „Weiter" ist zwei Sekunden
  lang gegen wiederholtes Klicken gesperrt. Ein Wahlschalter mit drei Stellungen
  erlaubt die Auswahl:
  - *Normal* — sequenzielle Wiedergabe der Warteschlange;
  - *Verlauf wiederholen* — stellt die bereits gespielten Stücke zurück in die
    Warteschlange und leert den Verlauf;
  - *Schleife* — wiederholt den laufenden Titel endlos.
- **Bewegen innerhalb des Titels** — klicken oder ziehen Sie den Regler des
  Fortschrittsbalkens.
- **Sprachkanal-Auswahl** — versetzt den Bot augenblicklich von einem Kanal in
  einen anderen. Jeder Kanal behält seine eigene Warteschlange und seinen
  Verlauf.
- **Bevorzugter Kanal** — ein Kanal kann als bevorzugt markiert werden (der
  Stern in der Auswahl); dorthin stellen sich Bot und Dashboard, wenn Sie den Bot
  **einschalten**. Das Markieren verschiebt im Augenblick nichts und hält Sie
  während der Sitzung nie fest. Ein **Neustart** ruft ihn dagegen nicht zurück:
  er bringt Sie in den Kanal, in dem Sie gehört haben, denn die Wiedergabe wurde
  nicht unterbrochen. Es gibt nur einen, über alle Server hinweg.

### Sprachaktivität

Der zugehörige Abschnitt zeigt die im ausgewählten Kanal verbundenen Mitglieder.
Wenn ein Mitglied spricht, leuchtet sein Profil in Echtzeit auf. Sie können ein
**Mitglied von der Erkennung ausnehmen**: seine Stimme senkt die Musik dann
nicht mehr ab, was bei einem rauschenden Mikrofon oder einer dauerhaften
Audioquelle nützlich ist.

### Wiedergabelisten

Das Dashboard verwaltet Wiedergabelisten, die **allen Ihren Servern gemeinsam**
sind, in Reitern angeordnet. Sie können sie anlegen, umbenennen, umordnen und
löschen, ihnen per Ziehen und Ablegen Titel hinzufügen und eine Wiedergabeliste
anstelle der Warteschlange als aktive Wiedergabequelle festlegen.

Eine laufende Wiedergabeliste stellt die Warteschlange beiseite — diese bleibt
sichtbar, doch solange die Liste läuft, geht nichts von ihr ab. **Ist ihr letzter
Titel beendet, übernimmt die Warteschlange von selbst wieder** und fährt mit
ihrem ersten Stück fort, ohne Sie etwas zu fragen. Die Wiedergabe endet also nur,
wenn die Warteschlange leer ist. Die Schleifenwiedergabe hat Vorrang: solange
sie aktiv ist, beginnt die Wiedergabeliste wieder bei ihrem ersten Stück und die
Warteschlange wartet weiter, bis sie an der Reihe ist.

### Warteschlange und Verlauf

- **Ziehen und Ablegen** — ordnen Sie die Abspielreihenfolge durch Ziehen der
  Titel um. Sie können einen Titel auch aus dem Verlauf, aus einer
  Wiedergabeliste oder aus dem Vorschaubild der laufenden Wiedergabe ziehen.
- **Sofortige Wiedergabe** — das Wiedergabesymbol jedes Eintrags spielt das
  Stück auf der Stelle ab, ohne neue Netzanfrage.
- **Entfernen und Leeren** — nehmen Sie einen bestimmten Eintrag heraus oder
  leeren Sie Warteschlange oder Verlauf vollständig.

### Verlauf des Eingabefelds

Das Eingabefeld merkt sich abgeschickte Eingaben — die letzten fünfundzwanzig,
wobei ein bereits bekannter Eintrag nach oben rückt, statt ein zweites Mal
aufgeführt zu werden. Das Feld öffnet die Liste beim Fokussieren und filtert sie
beim Tippen; gesucht wird im gesamten Eintrag und nicht nur an seinem Anfang, so
dass ein Link über den Namen des Titels wiedergefunden wird, den er trägt.

- **Pfeiltasten hoch und runter** — durchlaufen die Liste und tragen den Eintrag
  ins Feld. Über den ersten hinaus nach oben zu gehen stellt die begonnene
  Eingabe wieder her, die beim ersten Schritt beiseitegelegt wurde: eine von
  einer Pfeiltaste unterbrochene Eingabe geht nie verloren.
- **Klick** — wählt einen Eintrag unmittelbar aus.
- **Kreuz** — entfernt einen Eintrag aus dem Verlauf.
- **Escape** — schließt die Liste und gibt dem Feld zurück, was darin stand.

Jede Zeile trägt das Bild des Titels und seinen Namen statt der eingetippten
Adresse: ein Link sagt nichts über das, was er enthält. Der Name einer lokalen
Datei ersetzt ihren Pfad, und die vollständige Adresse oder der Pfad erscheint
beim Überfahren wieder. Fehlt ein Bild — ein noch nicht erkannter Titel, eine
Quelle, die keines liefert —, nimmt eine Musiknote den Platz ein, so dass die
Namen ausgerichtet bleiben.

Diese Bilder und Namen stammen aus dem, was der Bot aufgelöst hat: eine eben
eingefügte Adresse zeigt sich als sie selbst und wird ergänzt, sobald der Titel
in der Warteschlange, im Verlauf oder in einer Wiedergabeliste auftaucht.

Dieser Verlauf **lebt im Browser**, nicht auf dem Bot: er gehört zu dem Gerät
und dem Browser, von denen aus Sie schauen, und zwei Geräte am selben Bot teilen
sich keinen. Er ersetzt die Liste, die der Browser von sich aus anbot und die
weder das Farbschema des Dashboards kannte noch eine Möglichkeit bot, einen
Eintrag zu vergessen.

Auch das Zielmenü neben dem Feld merkt sich etwas, aber anderswo: seine Stellung
verwahrt **der Bot**, und zwar je Server, wie die beiden Menüs für die
Importqualität. Sie übersteht damit ein Neuladen der Seite, einen Neustart des
Bots, und folgt Ihnen auf ein anderes Gerät.

### Import von Dateien

Legen Sie eine Audio- oder Videodatei auf der Oberfläche ab, um sie der
Warteschlange oder einer Wiedergabeliste hinzuzufügen oder sie sofort
abzuspielen. Der Bot **erkennt Duplikate**: eine bereits importierte Datei wird
kein zweites Mal gespeichert.

Die Höchstgröße beträgt standardmäßig 1 GB, einstellbar über `MAX_UPLOAD_MB`.

**Importqualität** — zwei Menüs unterhalb des Eingabefelds legen die Qualität
der aus einer entfernten Quelle geholten Medien fest:

- **Audio**: Bitrate der zwischengespeicherten Datei (320 bis 96 kbit/s);
- **Video**: Auflösung des angezeigten Videostroms (2160p bis 360p).

Diese Einstellungen gelten **nicht für lokale Dateien**, die unverändert und
ohne Neukodierung importiert werden. Wenn Sie einen lokalen Pfad in das
Eingabefeld schreiben, werden beide Menüs ausgegraut, um darauf hinzuweisen.

### Herunterladen

Jeder Titel lässt sich in rund dreißig Formaten und Qualitäten herunterladen:
MP3, M4A, FLAC, WAV, OGG, OPUS, WEBM sowie MP4 für Video. Die Umwandlung erfolgt
im laufenden Betrieb.

**Auf die Festplatte des Bots** — das Zielmenü rechts vom Eingabefeld hat einen
vierten Eintrag: „Nach `data/downloads/`". Er schickt nichts an den Player,
sondern schreibt die Datei auf die Maschine, die den Bot beherbergt. Seine
Beschriftung trägt den Zielordner, so dass man ihn nicht öffnen muss, um zu
wissen, wo die Dateien landen.

Die Ordner-Schaltfläche rechts in dieser Menüzeile öffnet einen Explorer der
Host-Maschine — und kein Feld zum Eintippen eines Pfades, denn diese Maschine
ist nicht zwangsläufig die, von der aus Sie schauen. Unter Windows werden die
Laufwerke oben im Fenster angeboten: ohne sie führt der Weg nach oben aus einem
Ordner von `C:` nach `C:\` und niemals nach `D:`. Zwei Schaltflächen stehen
davor: **Standardordner**, die nach `data/downloads/` zurückführt, und
**Downloads**, die zum Download-Ordner des Systems führt — dem des Browsers,
meist das richtige Ziel und vier oder fünf Schritte tiefer im Baum. Beide
bringen den Explorer dorthin, statt zu bestätigen: man sieht, was der Ordner
enthält, und kann noch eine Ebene tiefer gehen, bevor man bestätigt. Das Feld
„Oder einen Pfad eingeben" bleibt für die Fälle, die der Explorer nicht
abdeckt.

Den Ordner merkt sich **der Bot**, nicht der Browser: er gilt für alle Ihre
Server und alle Ihre Geräte. Ein Pfad, der nicht existiert, der kein Ordner ist
oder der das Schreiben verweigert, wird schon bei der Wahl abgewiesen und der
Grund genannt — statt den Download später scheitern zu lassen, fern von der
Entscheidung, die ihn verursacht hat.

Eine entfernte Quelle wird in das Format des Menüs **Format** umgewandelt, mit
der Bitrate aus dem Menü **Audio** — MP3, M4A, OGG, OPUS oder WEBM; FLAC und WAV
sind verlustfrei und ignorieren diese Bitrate. Dieses dritte Menü erscheint nur
für dieses Ziel, indem es neben die beiden anderen gleitet: die übrigen drei
schreiben überhaupt keine Datei, und eine Endung benennt dort nichts. Es bietet
allein Audioformate, denn Video hat seinen eigenen Weg — die
Download-Schaltfläche eines Titels.

Die drei Menüs betreffen nicht dieselben Dinge, und was gegenstandslos ist, wird
abgeblendet: die Videoauflösung für dieses Ziel, das nur Ton schreibt, und die
Audio-Bitrate für FLAC und WAV, verlustfrei, die alles behalten, was sie
bekommen. Ein Satz unter der Reihe sagt jedes Mal, warum.

Woraus eine Quelle besteht, zeigt sich schließlich erst beim Kodieren. Kommt das
verlangte Format nicht durch, wird die Datei als MP3 geschrieben — jenes, das
nichts ablehnt — und eine Benachrichtigung sagt es, statt einen Fehlschlag zu
liefern, wo eine Datei möglich war. Eine Datei, die bereits auf der Festplatte des
Bots liegt, wird unverändert kopiert, ohne Neukodierung: Sie wollten sie in
Ihrem Ordner haben, nicht unterwegs an Qualität verlieren. Zwei Zusicherungen
schließlich: ein erneut heruntergeladener Titel ersetzt den vorherigen nicht —
die neue Datei wird nummeriert —, und ein abgebrochener Download hinterlässt
keine abgeschnittene Datei im Ordner, denn geschrieben wird unter einem
vorläufigen Namen, der erst nach erfolgreicher Umwandlung umbenannt wird.

Der Vorgang läuft im Hintergrund und meldet sich über Benachrichtigungen: der
Titel muss erst aufgelöst und dann umgewandelt werden, was die Zeit braucht, die
es braucht.

### Video

Wenn zu einem Titel ein Video gehört, kann das Dashboard es im Hintergrund
anzeigen. Lokale Audiodateien erhalten eine grafische Visualisierung.

### Lautheit (LUFS)

Zwei Titel mit derselben Lautstärke werden nicht gleich laut gehört: ein neueres
Master liegt bei etwa −7 LUFS, eine klassische Aufnahme bei etwa −25. Der
Lautstärkeregler ändert daran nichts, da er auf beide zugleich wirkt.

Ein Rechtsklick auf einen Titel — in der Warteschlange, im Verlauf oder in einer
Playlist — öffnet ein Menü, dessen Eintrag **Lautheit** eine Einstellung
aufklappt:

- **Der Regler** zielt auf eine Lautheit in LUFS, nicht auf eine Lautstärke. Der
  Wert steht darüber und folgt dem Regler in Echtzeit; die Korrektur ist
  hörbar, während man ihn bewegt, ohne die Wiedergabe neu zu starten.
- **Die Marke auf der Schiene** zeigt die gemessene Lautheit der Datei: steht
  der Regler darauf, klingt der Titel genau so, wie er aufgenommen wurde. Die
  Messung steht außerdem ausgeschrieben unter der Schiene.
- **Die runde Schaltfläche** gibt dem Titel diese Ausgangslautheit zurück.
- **Der Verlaufsbalken** zeigt, was die Korrektur den Klang kostet. Wird die
  Lautheit über den Spielraum der Datei hinaus angehoben, werden die Spitzen
  gekappt: der Balken wandert von Grün nach Rot, je stärker das Clipping wird.

Die Messung verlangt, die Datei von Anfang bis Ende zu lesen, was nur der Bot
kann. Sie wird daher gestartet, wenn der Titel beginnt oder wenn dieses Menü
sich öffnet, und danach nie neu berechnet. Ein entfernter Titel ohne Vorladen
ist nicht messbar: die Einstellung wartet auf sein Vorladen.

Die Karte **DJ-Übergang** trägt einen Schalter **LUFS angleichen**,
standardmäßig aus, und einen eigenen Regler. Eingeschaltet bringt er alle Titel
auf dasselbe Ziel — jeden nach seiner eigenen Messung korrigiert. Die einzeln
vorgenommenen Einstellungen werden deswegen nicht gelöscht: sie werden nur
überdeckt, und das Abwählen des Schalters gibt sie unverändert zurück. Wird ein
Titel von Hand eingestellt, während die Angleichung aktiv ist, schaltet sie sich
ab, und nur dieser Titel behält den neuen Wert.

Bei persönlicher Ausgabe wendet der Browser die Korrektur an. Eine Absenkung ist
dort exakt, eine Anhebung hat aber nur den Spielraum, den der
Hauptlautstärkeregler lässt: +6 dB zu verlangen, während er bereits am Anschlag
steht, liefert nur einen Teil davon. Bei gemeinsamer Ausgabe, wo der Bot den Ton
selbst mischt, wird die Korrektur vollständig angewendet.

### Geschwindigkeit und Übergänge

- **Wiedergabegeschwindigkeit** — einstellbar von 0,20× bis 3,05×, in Schritten
  von 0,01.
- **Übergang im DJ-Stil** — automatische Blende zwischen zwei Titeln, in zwei
  Varianten: reine Lautstärkeblende oder Blende mit begleitendem Filtereffekt.
- **Ein- und Ausblenden** — getrennt aktivierbar, mit einstellbarer Dauer.

### Vorladen

Die kommenden Titel werden im Hintergrund im Voraus heruntergeladen. Auf jedem
Titel erscheint eine Fortschrittsanzeige. Das macht den Start augenblicklich und
die Wiedergabe widerstandsfähig gegen Netzunterbrechungen. Die Anzahl der
vorgeladenen Titel ist für Warteschlange, Verlauf und Wiedergabelisten
einstellbar.

### Protokolle und Statistiken

Ein eingebautes Terminal zeigt die Protokolle des Bots in Echtzeit, filterbar
nach Stufe (Info, Warnung, Fehler, Erfolg, Fehlersuche). Eine Seitenleiste
stellt den Speicherverbrauch, die Laufzeit und die Netzaktivität dar.

**Protokollzeilen kopieren**

| Geste | Wirkung |
|---|---|
| Überfahren einer Zeile | Lässt rechts davon eine Kopierschaltfläche erscheinen |
| Klick auf eine Zeile | Wählt sie aus |
| **Umschalt + Klick** auf eine andere | Wählt den gesamten Bereich zwischen beiden |
| **Strg + Klick** (Cmd auf dem Mac) | Fügt eine einzelne Zeile hinzu oder entfernt sie |
| **Strg + C** | Kopiert die Auswahl |
| **Esc** | Hebt die Auswahl auf |

Sobald eine Zeile ausgewählt ist, erscheint am unteren Rand des Fensters eine
Leiste mit der Zeilenzahl und einer Schaltfläche **Kopieren**. Die Schaltfläche
oben im Fenster kopiert auf einen Schlag **alle angezeigten Zeilen**, aktive
Filter eingeschlossen — eine ausgeblendete Stufe wird nie kopiert.

Das Auswählen von Text mit der Maus bleibt möglich: ein Ziehen, das Text
auswählt, wird nicht als Auswahlklick gedeutet.

### Wartung

Über das Energiemenü lässt sich der Bot von der Oberfläche aus **neu starten**
oder **ausschalten**. Das Ausschalten wendet eine Ausblendung an und sichert den
Wiedergabezustand, der beim nächsten Start wiederhergestellt wird.

### Optische Anpassung

- **Stile** — *Glassmorphism* (lichtdurchlässige Flächen), *Neon Cyberpunk*
  (Neonränder), *Minimalist* (nüchterne Farbflächen), *Retro Synthwave* (warme
  Verläufe).
- **Heller / dunkler Modus** — alle Stile passen sich an.
- **Sprachen** — Französisch, Englisch, Spanisch, Deutsch.
- **Anordnung** — die Anordnung der Flächen lässt sich umstellen und speichern.

Diese Vorlieben werden in Ihrem Browser aufbewahrt.

---

## Typische Anwendungsszenarien

### Kooperatives Online-Spiel

Gemäßigte Lautstärke, um die Signale des Spiels nicht zu überdecken,
reaktionsschnelles Ducking:

```
/volume level:50
/ducking level percent:20
/ducking delay ms:500
/ducking fade ms:150
```

### Arbeits- oder Lernsitzung

Sehr dezente Hintergrundmusik, die während der Gespräche fast vollständig
verklingt:

```
/volume level:30
/ducking level percent:5
/ducking delay ms:2000
/ducking fade ms:500
```

### Gezieltes Musikhören

Vorrang für das Musiksignal, mit leichter Absenkung, damit Wortmeldungen hörbar
bleiben:

```
/volume level:85
/ducking level percent:70
/ducking delay ms:300
/ducking fade ms:100
```

---

## Häufig gestellte Fragen

**Unterstützt der Bot Spotify-Links?**
Ja. Der Bot entnimmt die Metadaten des Titels und sucht automatisch das
Audio-Äquivalent auf YouTube. Das Ausfüllen von `SPOTIFY_CLIENT_ID` und
`SPOTIFY_CLIENT_SECRET` verbessert die Zuverlässigkeit der Auflösung.

**Warum braucht die Lautstärke nach einem Satz Zeit, um wieder anzusteigen?**
Das ist die Wiederherstellungsverzögerung. Sie verhindert, dass die Lautstärke
während kurzer Pausen mitten im Satz ansteigt. Senken Sie sie mit
`/ducking delay ms:200` oder über das Dashboard.

**Gilt das Ducking auch für meine eigene Stimme?**
Ja, für alle Teilnehmer des Kanals, die keine Bots sind. Sie können jedoch ein
bestimmtes Mitglied über das Dashboard von der Erkennung ausnehmen.

**Kann ich allein Musik hören, ohne den Server zu stören?**
Ja, im Modus `personal`: die Musik wird in Ihrem Browser wiedergegeben und nicht
im Sprachkanal. Der Bot kann außerdem einen temporären privaten Sprachkanal
anlegen.

**Bleiben die Einstellungen nach einem Neustart erhalten?**
Ja. Lautstärke, Ducking, Übertragungsmodus und Wiedergabelisten werden in
lokalen JSON-Dateien gespeichert (`data/settings.json`). Auch der
Wiedergabezustand wird wiederhergestellt: der Bot nimmt den unterbrochenen Titel
an genau derselben Stelle wieder auf. Die optischen Vorlieben des Dashboards
werden in Ihrem Browser aufbewahrt.

**Ich habe das Token des Dashboards verloren.**
Es steht in `data/dashboard-token` und beim Start in der Konsole. Sie können
auch eines Ihrer Wahl über die Variable `DASHBOARD_TOKEN` der Datei `.env`
vorgeben.

**Der Player des Browsers zeigt bei meinen lokalen Dateien einen Fehler.**
Der Bot liefert nur Dateien aus, die in seinen Ordnern oder in den durch
`MEDIA_ROOTS` angegebenen Verzeichnissen liegen. Siehe
[Anderswo gespeicherte Dateien abspielen](#anderswo-gespeicherte-dateien-abspielen).

**Der Ordner `data/` belegt viel Platz.**
`data/cache` enthält die vorgeladenen Titel. Er wird nach Relevanz bereinigt,
hat aber keine Größenobergrenze: Sie können ihn bei angehaltenem Bot gefahrlos
leeren. `data/uploads` enthält Ihre Importe — sie zu löschen macht die
Wiedergabelisten unbrauchbar, die auf sie verweisen.
