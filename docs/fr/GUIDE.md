# Guide utilisateur — Bot Musique Interactive

Ce guide détaille l'utilisation du bot au sein de Discord ainsi que la
manipulation de son tableau de bord web.

Pour la documentation d'ingénierie, voir [docs/fr/technique/](technique/README.md).

---

## Sommaire

- [Premiers pas](#premiers-pas)
- [Accès au tableau de bord](#accès-au-tableau-de-bord)
- [Commandes Discord](#référence-complète-des-commandes-discord)
- [Tableau de bord web](#utilisation-du-tableau-de-bord-web)
- [Scénarios types](#scénarios-dutilisation-types)
- [FAQ](#questions-fréquemment-posées)

---

## Premiers pas

### 1. Démarrage du bot

Le bot doit tourner sur votre machine pour répondre aux commandes. Sous Windows,
il suffit de double-cliquer sur `Start bot.vbs`, à la racine du projet.

Pour ne plus avoir à ouvrir ce dossier, créez-vous un raccourci une fois pour
toutes : double-cliquez sur `Create shortcut.vbs` à la racine du projet,
choisissez l'emplacement voulu dans l'assistant, et le raccourci s'y installe.
Un double-clic dessus démarre ensuite le bot et ouvre le tableau de bord.

Le bot démarre **en tâche de fond** : aucune fenêtre de terminal ne s'ouvre et
rien n'apparaît dans la barre des tâches. Une petite fenêtre vous montre où en
est le lancement, coche les étapes au fur et à mesure, puis disparaît toute
seule dès que le bot est prêt — le tableau de bord s'ouvre juste après dans
votre navigateur. Si quelque chose bloque, elle reste affichée et vous dit quoi
faire : installer Node.js, reprendre la configuration, ou consulter
les journaux. Le premier lancement est plus long que les suivants :
il installe les dépendances.

**Au tout premier lancement**, cette fenêtre ne démarre rien : elle vous
accompagne. Le bot a besoin de sa propre application Discord, et personne ne
peut la créer à votre place — un jeton désigne une application, il ne se partage
pas. Tout le reste est pris en charge :

- un bouton ouvre le portail développeur de Discord, où vous créez
  l'application (*New Application*), puis, dans l'onglet *Bot*, cliquez sur
  *Reset Token* puis *Copy* ;
- il n'y a rien à coller : dès que le jeton est dans votre presse-papiers, la
  fenêtre le reconnaît, le soumet à Discord et affiche en retour le nom de
  l'application. Le champ reste là pour les cas où cette détection n'aboutit
  pas ;
- l'identifiant de l'application n'est **pas** demandé — il se déduit du jeton.
  Le fichier `.env` est écrit pour vous, sans que vous ayez à l'ouvrir ;
- un dernier bouton invite le bot sur votre serveur, permissions déjà cochées.
  Le bot démarre pendant ce temps, sans attendre que vous ayez fini.

Un jeton que Discord refuse est signalé sur-le-champ, avec son motif — plutôt
qu'au démarrage suivant, sous la forme d'un bot qui s'arrête sans rien dire. Et
si le jeton enregistré cesse d'être accepté, parce qu'il a été régénéré depuis
sur le portail, la fenêtre propose de refaire cette configuration.

**Pour arrêter le bot**, utilisez le bouton d'extinction du tableau de bord :
c'est lui qui remplace la fermeture de la console. Le bouton de redémarrage y
est également disponible.

Si le bot tourne déjà lorsque vous le relancez, la petite fenêtre vous le dit
au lieu d'en démarrer un second, et vous propose sur place d'ouvrir le tableau
de bord, de redémarrer ou d'éteindre. L'ouverture du tableau de bord vérifie
d'abord qu'un onglet n'y est pas déjà connecté, pour ne pas en empiler un de
plus ; l'extinction, elle, demande confirmation.

En ligne de commande, l'équivalent du démarrage est `npm start` depuis le
dossier du projet — avec, cette fois, une console et ses journaux en direct.

### 2. Connexion à un salon vocal

Avant de solliciter le bot, connectez-vous à l'un des salons vocaux de votre
serveur Discord. Le bot requiert votre présence dans un salon vocal pour pouvoir
s'y connecter et y diffuser des flux audio.

### 3. Lancement d'une piste audio

Saisissez la commande slash suivante dans n'importe quel salon textuel autorisé :

```
/play query:nom du morceau ou URL
```

Le bot effectue alors les opérations suivantes :

1. Connexion automatique à votre salon vocal actuel.
2. Recherche et récupération des métadonnées du morceau.
3. Initialisation de la lecture audio.
4. Envoi d'un encadré récapitulatif contenant le titre, l'auteur, la durée et la
   miniature du morceau.

---

## Accès au tableau de bord

Le tableau de bord est protégé par un **jeton d'accès**. Sans lui, la page
affiche « Accès refusé ».

### Se connecter avec Discord

À l'ouverture, une fenêtre demande de vous connecter avec votre compte Discord.
Elle ne se ferme pas : le tableau de bord pilote un bot présent sur vos
serveurs, et n'obéit à personne qui refuse de se nommer.

Seuls votre identifiant, votre nom et votre avatar sont demandés — ni vos
serveurs, ni votre adresse électronique. Votre compte doit par ailleurs être
membre d'un serveur où le bot est présent.

Le **premier compte à se connecter en présentant le jeton** devient le
propriétaire de l'installation, une fois pour toutes. C'est celui qui a lancé le
bot : le jeton s'affiche dans sa console, et le lien d'invitation envoyé aux
auditeurs ne le porte pas. Le propriétaire garde tous les droits ; les autres
n'ont que ceux qu'il leur accorde (voir « Partager le contrôle »).

Pour rendre l'installation à un autre compte, supprimez le fichier
`data/owner.json` et reconnectez-vous avec le jeton.

Si l'application Discord n'est pas configurée — `DISCORD_CLIENT_SECRET` ou
`PUBLIC_URL` manquants —, la connexion est impossible : la fenêtre dit alors ce
qu'il reste à renseigner et laisse entrer avec le seul jeton, comme avant. Nul
ne se retrouve enfermé hors de son propre bot pour une variable oubliée.

### Récupérer le jeton

Il est créé au premier démarrage et vous est proposé de trois façons :

- le bot **ouvre automatiquement votre navigateur** sur la bonne adresse, jeton
  compris, cinq secondes après le démarrage ;
- l'adresse complète est affichée dans la console au démarrage, si le bot a été
  lancé depuis un terminal — le raccourci, lui, démarre sans console ;
- le jeton est enregistré dans le fichier `data/dashboard-token`.

Une fois la page ouverte avec le jeton, celui-ci est mémorisé dans un cookie :
les visites suivantes ne nécessitent plus rien. L'adresse est ensuite nettoyée
automatiquement pour que le jeton n'apparaisse pas dans la barre d'adresse.

Pour ouvrir manuellement le tableau de bord :

```
http://localhost:3000/?token=VOTRE_JETON
```

### Accéder depuis un autre appareil

Par défaut, le tableau de bord n'est accessible **que depuis la machine qui
héberge le bot**. Pour le consulter depuis un téléphone ou un autre ordinateur du
réseau local, ajoutez cette ligne au fichier `.env`, puis redémarrez :

```
HOST=0.0.0.0
```

Le jeton d'accès protège alors l'accès depuis le réseau. Ne rendez pas le
tableau de bord accessible depuis Internet sans protection supplémentaire.

### Lire des fichiers stockés ailleurs

Le bot ne diffuse au navigateur que les fichiers situés dans ses propres
dossiers. Pour écouter une bibliothèque personnelle, déclarez ses dossiers dans
`.env` :

```
MEDIA_ROOTS=D:\Musique;E:\Films
```

Sans cette déclaration, la lecture depuis Discord fonctionne, mais le lecteur du
navigateur affichera une erreur pour ces fichiers.

---

## Référence complète des commandes Discord

### Lecture et listes de lecture

#### `/play`

Recherche une piste ou lit un fichier spécifique.

- **Recherche textuelle** : `/play query:nom de l'artiste ou du morceau`
  (recherche par défaut sur YouTube).
- **Lien direct** : `/play query:https://www.youtube.com/watch?v=...`
- **Fichier local** : `/play query:C:\musiques\titre.mp3` (chemin absolu sur la
  machine hébergeant le bot).

Plateformes prises en charge : **YouTube**, **Spotify**, **SoundCloud** et
**Apple Music**. Pour Spotify et Apple Music, le bot récupère les métadonnées et
lit l'équivalent audio depuis YouTube.

> Deezer et Qobuz ne sont pas pris en charge, malgré la présence de variables
> correspondantes dans le fichier de configuration.

#### `/playlist`

Charge en file d'attente l'intégralité des fichiers audio d'un répertoire local.

- Commande standard : `/playlist path:C:\musiques\mon_album`
- Lecture aléatoire : `/playlist path:C:\musiques\mon_album shuffle:true`

Formats reconnus : MP3, FLAC, WAV, OGG, M4A, OPUS, AAC, WMA.

---

### Contrôle de la lecture

| Commande | Action |
|---|---|
| `/pause` | Met en pause la lecture en cours. |
| `/resume` | Relance la lecture de la piste suspendue. |
| `/skip` | Passe à la piste suivante de la file d'attente. |
| `/stop` | Arrête la musique et vide la file d'attente. |
| `/nowplaying` | Affiche le morceau en cours avec une barre de progression. |

---

### File d'attente

#### `/queue`

Consulte les pistes programmées. La liste est paginée par groupes de dix.

- Première page : `/queue`
- Page précise : `/queue page:2`

Ajouter une piste via `/play` pendant une lecture l'insère en fin de file.

---

### Volume sonore

#### `/volume`

Règle le niveau sonore général (0 à 100).

```
/volume level:60
```

Cette valeur sert de **référence**. Le ducking calcule l'atténuation en
appliquant un pourcentage sur cette base : avec un volume de 70 et un niveau de
ducking de 20 %, la musique descend à 14 pendant les prises de parole.

---

### Ducking — atténuation automatique

Le ducking est le cœur fonctionnel du bot : il diminue temporairement le volume
de la musique lorsque des utilisateurs parlent, puis le restaure après un temps
de silence.

| Commande | Effet |
|---|---|
| `/ducking status` | Affiche l'état et l'ensemble des paramètres du serveur. |
| `/ducking toggle` | Active ou désactive l'atténuation automatique. |
| `/ducking level percent:<0-100>` | Pourcentage du volume conservé pendant la parole. |
| `/ducking delay ms:<n>` | Délai de silence avant restauration. |
| `/ducking fade ms:<n>` | Durée de la transition entre les deux volumes. |

**Choisir un niveau** — `15` pour une baisse forte, `50` pour une atténuation de
moitié, `0` pour une coupure complète pendant les prises de parole.

**Choisir un délai** — `400` ms pour un retour réactif, `800` ms en standard,
`1500` ms pour un rétablissement progressif. Un délai suffisant évite l'effet de
pompage lors des courtes pauses de respiration au milieu d'une phrase.

**Choisir un fondu** — `100` ms pour une transition franche, `200` ms en
standard, `500` ms pour un effet très doux.

---

### Diffusion et salons privés

La commande `/broadcast`, **réservée aux administrateurs**, modifie le canal de
destination :

- **Mode public (`everyone`)** — la musique est diffusée dans le salon vocal
  commun. Tout le monde écoute le même flux et le ducking s'applique.
- **Mode privé (`personal`)** — la musique est diffusée **dans votre
  navigateur**, par le lecteur du tableau de bord. Le bot reste présent dans le
  salon vocal sans y émettre de son. Le bot sait également créer un salon vocal
  privé temporaire, nommé `🎵 <votre nom>`, supprimé automatiquement à votre
  déconnexion.

---

## Utilisation du tableau de bord web

### Contrôles généraux

- **Contrôle média** — les boutons centraux suspendent, relancent ou arrêtent la
  lecture. Le bouton « suivant » dispose d'un verrouillage de deux secondes
  contre le clic répété. Un sélecteur à trois positions permet de choisir :
  - *Normal* — lecture séquentielle de la file d'attente ;
  - *Recommencer l'historique* — replace les morceaux déjà lus dans la file et
    vide l'historique ;
  - *Boucle* — répète indéfiniment la piste courante.
- **Déplacement dans la piste** — cliquez ou faites glisser le curseur de la
  barre de progression.
- **Sélecteur de salon vocal** — bascule instantanément le bot d'un salon à un
  autre. Chaque salon conserve sa propre file d'attente et son historique.
- **Salon favori** — un salon peut être marqué comme favori (l'étoile, dans le
  sélecteur) ; c'est là que le bot et le tableau de bord se placent au démarrage
  du bot. Le marquer ne déplace rien sur le moment, et ne vous retient pas :
  changez de salon quand vous voulez, le favori ne reprendra la main qu'au
  prochain démarrage. Il n'y en a qu'un, tous serveurs confondus.

### Activité vocale

La section dédiée affiche les membres connectés au salon sélectionné. Lorsqu'un
membre parle, son profil s'illumine en temps réel. Vous pouvez **exclure un
membre de la détection** : sa voix n'atténuera plus la musique, ce qui est utile
pour un micro bruyant ou une source audio permanente.

### Playlists

Le tableau de bord gère des playlists **communes à tous vos serveurs**,
organisées en onglets. Vous pouvez les créer, les renommer, les réordonner et
les supprimer, y ajouter des pistes par glisser-déposer, et définir une playlist
comme source de lecture active à la place de la file d'attente.

Une playlist qui joue met la file d'attente de côté — elle reste affichée, mais
rien n'en part tant que la playlist dure. **Sa dernière piste terminée, la file
reprend la main d'elle-même** et enchaîne sur son premier titre, sans rien vous
demander. La lecture ne s'arrête donc que si la file est vide. La lecture en
boucle passe avant : tant qu'elle est active, la playlist repart de son premier
titre et la file continue d'attendre son tour.

### File d'attente et historique

- **Glisser-déposer** — réorganisez l'ordre de passage en faisant glisser les
  pistes. Vous pouvez aussi faire glisser une piste depuis l'historique, depuis
  une playlist ou depuis la vignette de lecture en cours.
- **Lecture immédiate** — l'icône de lecture de chaque élément joue le titre
  sur-le-champ, sans nouvelle requête réseau.
- **Suppression et nettoyage** — retirez un élément précis ou videz
  intégralement la file ou l'historique.

### Historique du champ d'ajout

Le champ d'ajout retient les saisies validées — les vingt-cinq dernières, une
entrée déjà connue remontant en tête plutôt que de s'y inscrire une seconde
fois. Le panneau s'ouvre à la prise de focus et se filtre à la frappe ; la
recherche porte sur le contenu et non sur le début, de sorte qu'un lien se
retrouve par le nom du morceau qu'il porte.

- **Flèches haut et bas** — parcourent la liste et portent l'entrée dans le
  champ. Remonter au-dessus de la première restitue la saisie en cours, mise de
  côté au premier déplacement : une frappe interrompue par une flèche n'est
  jamais perdue.
- **Clic** — choisit directement une entrée.
- **Croix** — retire une entrée de l'historique.
- **Échap** — referme le panneau et rend au champ ce qui y était tapé.

Chaque ligne porte l'image du morceau et son nom, plutôt que l'adresse tapée :
un lien ne dit rien de ce qu'il contient. Le nom d'un fichier local remplace son
chemin, et l'adresse ou le chemin complet reparaît au survol. Faute d'image —
piste pas encore reconnue, source qui n'en fournit pas —, une note de musique
tient la place, de sorte que les noms restent alignés.

Ces images et ces noms viennent de ce que le bot a résolu : une adresse collée à
l'instant s'affiche telle quelle, et se complète dès que la piste apparaît dans
la file, l'historique ou une playlist.

Cet historique **vit dans le navigateur**, et non sur le bot : il est propre à
l'appareil et au navigateur depuis lesquels vous consultez, et deux appareils
pilotant le même bot n'ont pas le même. Il remplace la liste que le navigateur
proposait de lui-même, laquelle ignorait le thème du tableau de bord et
n'offrait aucun moyen d'oublier une entrée.

Le menu de destination, à côté du champ, se souvient lui aussi — mais ailleurs :
sa position est retenue **par le bot**, et par serveur, comme les deux menus de
qualité d'import. Elle se retrouve donc au rechargement de la page, au
redémarrage du bot, et depuis un autre appareil.

### Import de fichiers

Déposez un fichier audio ou vidéo sur l'interface pour l'ajouter à la file, à
une playlist, ou le lire immédiatement. Le bot **détecte les doublons** : un
fichier déjà importé n'est pas stocké une seconde fois.

La taille maximale est de 1 Go par défaut, ajustable par `MAX_UPLOAD_MB`.

**Qualité d'import** — deux menus, sous le champ d'ajout, fixent la qualité des
médias récupérés depuis une source distante :

- **Audio** : débit du fichier mis en cache (320 à 96 kbps) ;
- **Vidéo** : définition du flux vidéo affiché (2160p à 360p).

Ces réglages ne s'appliquent **pas aux fichiers locaux**, importés tels quels
sans réencodage. Lorsque vous saisissez un chemin local dans le champ d'ajout,
les deux menus se grisent pour le signaler.

### Téléchargement

Chaque piste peut être téléchargée dans une trentaine de formats et qualités :
MP3, M4A, FLAC, WAV, OGG, OPUS, WEBM, ainsi que MP4 pour la vidéo. La conversion
est effectuée à la volée.

**Vers le disque du bot** — le menu de destination, à droite du champ d'ajout,
compte une quatrième entrée : « Vers `data/downloads/` ». Elle n'envoie rien au
lecteur — elle écrit le fichier sur la machine qui héberge le bot. Son libellé
porte le dossier de destination, ce qui évite d'avoir à l'ouvrir pour savoir où
les fichiers tombent.

Le bouton en forme de dossier, à droite de cette ligne du menu, ouvre un
explorateur de la machine hôte — et non un champ où taper un chemin, cette
machine n'étant pas forcément celle d'où vous regardez. Sous Windows, les
disques sont proposés en haut de la fenêtre : sans eux, remonter depuis un
dossier de `C:` mène à `C:\` et jamais à `D:`. Deux pastilles les
précèdent : **Dossier par défaut**, qui ramène à `data/downloads/`, et
**Téléchargements**, qui conduit au dossier de téléchargement du système — celui
du navigateur, souvent la bonne destination et quatre ou cinq pas plus loin dans
l'arborescence. L'une comme l'autre mènent l'explorateur là-bas plutôt que de
valider : on voit ce que le dossier contient, et on peut encore descendre d'un
cran avant de confirmer. Le champ « Ou saisir un chemin » reste là pour les cas
que l'explorateur ne couvre pas.

Le dossier est retenu **par le bot**, et non par le navigateur : il est commun à
tous vos serveurs et à tous vos appareils. Un chemin qui n'existe pas, qui n'est
pas un dossier, ou qui refuse l'écriture est écarté au moment du choix et la
raison en est affichée — plutôt que de faire échouer le téléchargement plus
tard, loin de la décision qui l'a causé.

Une source distante est transcodée dans le format du menu **Format**, au débit
du menu **Audio** — MP3, M4A, OGG, OPUS ou WEBM ; FLAC et WAV sont sans perte et
ignorent ce débit. Ce troisième menu n'apparaît, en glissant à côté des deux
autres, que pour cette destination : les trois autres n'écrivent aucun fichier,
et une extension n'y désignerait rien. Il n'offre que des formats audio, la
vidéo ayant son propre chemin — le bouton de téléchargement d'une piste.

Les trois menus ne portent pas sur les mêmes choses, et ce qui est sans objet se
grise : la définition vidéo pour cette destination, qui n'écrit que du son, et le
débit audio pour FLAC et WAV, sans perte, qui gardent tout ce qu'on leur donne.
Une phrase sous la rangée dit à chaque fois pourquoi.

Enfin, la composition d'une source ne se découvre qu'au moment de l'encoder. Si
le format demandé n'aboutit pas, le fichier est écrit en MP3 — celui que rien ne
refuse — et une notification le dit, plutôt que de rendre un échec là où un
fichier était possible. Un fichier déjà présent sur le disque du bot est copié tel quel, sans
réencodage : vous avez demandé à l'avoir dans votre dossier, pas à en perdre la
qualité au passage. Deux garanties, enfin : retélécharger un morceau ne remplace
pas le précédent — le nouveau fichier est numéroté —, et un téléchargement
interrompu ne laisse pas de fichier tronqué dans le dossier, l'écriture se
faisant sous un nom provisoire renommé une fois seulement le transcodage réussi.

L'opération se déroule en arrière-plan et se signale par des notifications : le
morceau doit d'abord être résolu, puis transcodé, ce qui prend le temps que cela
prend.

### Vidéo

Lorsqu'une piste possède une vidéo associée, le tableau de bord peut l'afficher
en fond. Les fichiers audio locaux bénéficient d'un visualiseur graphique.

### Niveau sonore (LUFS)

Deux morceaux réglés au même volume ne s'entendent pas au même niveau : un
master récent sort autour de −7 LUFS, un enregistrement classique autour de −25.
Le curseur de volume n'y change rien, puisqu'il agit sur les deux à la fois.

Le clic droit sur une piste — dans la file, l'historique ou une playlist — ouvre
un menu dont l'entrée **Niveau sonore** déplie un réglage :

- **Le curseur** vise une sonie, en LUFS, et non un volume. La valeur s'affiche
  au-dessus et suit le curseur en temps réel ; la correction s'entend pendant
  qu'on le déplace, sans relancer la lecture.
- **Le repère sur le rail** marque la sonie mesurée du fichier : curseur posé
  dessus, le morceau sort tel qu'il a été enregistré. La mesure est aussi
  rappelée en toutes lettres sous le rail.
- **Le bouton circulaire** rend au morceau ce niveau d'origine.
- **La barre dégradée** annonce ce que la correction coûte au son. Monter le
  niveau au-delà de la marge que laisse le fichier écrête les crêtes : la barre
  passe du vert au rouge à mesure que l'écrêtage s'aggrave.

La mesure demande de lire le fichier d'un bout à l'autre, ce que seul le bot
peut faire. Elle est donc lancée quand le morceau démarre ou quand ce menu
s'ouvre, et n'est jamais recalculée ensuite. Une piste distante non préchargée
n'est pas mesurable : le réglage attend son préchargement.

La boîte **Enchaînement Mix** porte un interrupteur **Synchroniser les LUFS**,
désactivé par défaut, et son propre curseur. Activé, il aligne tous les morceaux
sur une même cible — chacun corrigé selon sa propre mesure. Les réglages faits
piste par piste ne sont pas effacés pour autant : ils sont simplement recouverts,
et décocher l'interrupteur les rend tels quels. Régler une piste à la main
pendant que la synchronisation est active la désactive, et seule cette piste
garde la nouvelle valeur.

En diffusion personnelle, la correction est appliquée par le navigateur. Une
atténuation y est exacte, mais une amplification n'a que la marge que laisse le
curseur de volume principal : demander +6 dB alors qu'il est déjà à fond n'en
donnera qu'une partie. En diffusion commune, où le bot mélange lui-même le son,
la correction est appliquée entièrement.

### Vitesse et enchaînement

- **Vitesse de lecture** — réglable de 0,20× à 3,05×, par pas de 0,01.
- **Enchaînement type DJ** — fondu automatique entre deux pistes, avec deux
  variantes : fondu de volume seul, ou fondu accompagné d'un effet de filtre.
- **Fondus d'entrée et de sortie** — activables séparément, avec durée réglable.

### Préchargement

Les pistes à venir sont téléchargées à l'avance en arrière-plan. Un indicateur
de progression apparaît sur chaque piste. Cela rend le démarrage instantané et
la lecture résistante aux coupures réseau. Le nombre de pistes préchargées est
réglable pour la file, l'historique et les playlists.

### Journaux et statistiques

Un terminal intégré affiche les journaux du bot en temps réel, filtrables par
niveau (info, avertissement, erreur, succès, débogage). Un panneau latéral
présente la consommation mémoire, le temps de fonctionnement et l'activité
réseau.

**Copier des lignes de journal**

| Geste | Effet |
|---|---|
| Survol d'une ligne | Fait apparaître un bouton de copie à sa droite |
| Clic sur une ligne | La sélectionne |
| **Maj + clic** sur une autre | Sélectionne toute la plage entre les deux |
| **Ctrl + clic** (Cmd sur Mac) | Ajoute ou retire une ligne isolée |
| **Ctrl + C** | Copie la sélection |
| **Échap** | Annule la sélection |

Dès qu'une ligne est sélectionnée, une barre apparaît en bas de la fenêtre avec
le nombre de lignes et un bouton **Copier**. Le bouton en haut de la fenêtre
copie d'un coup **toutes les lignes affichées**, filtres actifs compris — un
niveau masqué n'est jamais copié.

La sélection de texte à la souris reste disponible : un glissement qui
sélectionne du texte n'est pas interprété comme un clic de sélection.

### Maintenance

Le menu d'alimentation permet de **redémarrer** ou d'**éteindre** le bot depuis
l'interface. L'extinction applique un fondu de sortie et sauvegarde l'état de
lecture, qui sera restauré au démarrage suivant.

### Personnalisation visuelle

- **Styles** — *Glassmorphism* (panneaux translucides), *Neon Cyberpunk*
  (bordures néon), *Minimalist* (aplats sobres), *Retro Synthwave* (dégradés
  chauds).
- **Mode clair / sombre** — l'ensemble des styles s'adapte.
- **Langues** — français, anglais, espagnol, allemand.
- **Disposition** — la disposition des panneaux peut être réorganisée et
  enregistrée.

Ces préférences sont conservées dans votre navigateur.

---

## Scénarios d'utilisation types

### Jeu en ligne coopératif

Volume modéré pour ne pas masquer les signaux du jeu, ducking réactif :

```
/volume level:50
/ducking level percent:20
/ducking delay ms:500
/ducking fade ms:150
```

### Session de travail ou de révision

Musique d'ambiance très discrète, s'estompant presque intégralement lors des
échanges :

```
/volume level:30
/ducking level percent:5
/ducking delay ms:2000
/ducking fade ms:500
```

### Écoute musicale dédiée

Priorité au signal musical, avec une atténuation légère pour que les
interventions restent audibles :

```
/volume level:85
/ducking level percent:70
/ducking delay ms:300
/ducking fade ms:100
```

---

## Questions fréquemment posées

**Le bot prend-il en charge les liens Spotify ?**
Oui. Le bot extrait les métadonnées de la piste et recherche automatiquement
l'équivalent audio sur YouTube. Renseigner `SPOTIFY_CLIENT_ID` et
`SPOTIFY_CLIENT_SECRET` améliore la fiabilité de la résolution.

**Pourquoi le volume met-il du temps à remonter après une phrase ?**
C'est le délai de restauration. Il empêche le volume de remonter pendant les
courtes pauses au milieu d'une phrase. Abaissez-le avec
`/ducking delay ms:200` ou depuis le tableau de bord.

**Le ducking s'applique-t-il aussi à ma propre voix ?**
Oui, à tous les participants non-bots du salon. Vous pouvez toutefois exclure
un membre précis de la détection depuis le tableau de bord.

**Puis-je écouter de la musique seul sans déranger le serveur ?**
Oui, en mode `personal` : la musique est diffusée dans votre navigateur et non
dans le salon vocal. Le bot peut également créer un salon vocal privé
temporaire.

**Les réglages sont-ils conservés après un redémarrage ?**
Oui. Volume, ducking, mode de diffusion et playlists sont enregistrés dans des
fichiers JSON locaux (`data/settings.json`). L'état de lecture est également
restauré : le bot reprend la piste interrompue à sa position exacte. Les
préférences visuelles du tableau de bord sont conservées dans votre navigateur.

**J'ai perdu le jeton du tableau de bord.**
Il figure dans `data/dashboard-token` et dans la console au démarrage. Vous
pouvez aussi en imposer un de votre choix par la variable `DASHBOARD_TOKEN` du
fichier `.env`.

**Le lecteur du navigateur affiche une erreur sur mes fichiers locaux.**
Le bot ne diffuse que les fichiers situés dans ses dossiers ou dans les
répertoires déclarés par `MEDIA_ROOTS`. Voir
[Lire des fichiers stockés ailleurs](#lire-des-fichiers-stockés-ailleurs).

**Le dossier `data/` occupe beaucoup d'espace.**
`data/cache` contient les pistes préchargées. Il se purge selon la pertinence
mais n'a pas de plafond de taille : vous pouvez le vider sans risque, bot
arrêté. `data/uploads` contient vos imports — les supprimer rendra les playlists
qui les référencent inopérantes.
