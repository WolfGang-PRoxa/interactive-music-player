# 01 — Architecture

[← Sommaire](README.md)

---

## Arborescence

```
src/
├── index.js                  Point d'entrée : client Discord, player, ducking, arrêt
├── config.js                 Constantes et valeurs par défaut (non modifiées à l'exécution)
├── deploy-commands.js        Script d'enregistrement des commandes slash
│
├── audio/
│   ├── PlaybackSession.js    État de lecture par serveur (schéma déclaré)
│   ├── DuckingManager.js     Détection de parole → pilotage du volume
│   ├── VolumeController.js   Fondus progressifs sur le nœud audio
│   ├── PlayerEvents.js       Écouteurs d'événements discord-player
│   ├── PresenceManager.js    Arrivée et départ du bot selon l'occupation du salon
│   ├── PreloadManager.js     Cache disque des pistes distantes
│   ├── LocalFilePlayer.js    Utilitaires de scan de dossiers audio
│   ├── playbackSettings.js   Vitesse et effets de mix, quel que soit le chemin audio
│   └── mix/                  Bus de mixage : la diffusion commune, deux pistes superposables
│       ├── format.js         Format d'échange PCM et découpage en trames
│       ├── input.js          Résolution d'une piste en entrée FFmpeg
│       ├── MixSource.js      Un morceau décodé, avec gain et filtre
│       ├── MixBus.js         Le flux permanent envoyé à Discord
│       ├── MixEngine.js      Orchestration par serveur et pilotage de la file
│       ├── playerBridge.js   Routage des méthodes du lecteur vers le bus
│       └── index.js          Registre des bus, un par serveur
│
├── broadcast/
│   └── BroadcastManager.js   Modes de diffusion, salons personnels
│
├── commands/                 Commandes slash Discord (une par fichier)
│
├── database/
│   ├── Database.js           Réglages par serveur + playlists globales
│   └── PlaybackStateManager.js  Instantané et restauration de la lecture
│
├── utils/
│   ├── logger.js             Journalisation applicative
│   ├── atomicJson.js         Lecture/écriture JSON résistantes aux crashs
│   ├── mediaPaths.js         Garde-fou des chemins servis au client
│   ├── paths.js              Comparaison et nettoyage de chemins
│   ├── duration.js           Formatage et analyse des durées
│   ├── embeds.js             Encadrés Discord
│   └── permissions.js        Vérifications de permissions
│
└── web/
    ├── WebServer.js          Serveur HTTP + WebSocket, agrégation de l'état
    ├── auth.js               Jeton d'accès (HTTP et WebSocket)
    ├── uploadService.js      Réception et intégration des fichiers importés
    ├── routes/api.js         Routes HTTP (stream, download, upload, video-info)
    ├── websocket/
    │   ├── wsHandler.js      Routeur des messages WebSocket
    │   ├── handlerUtils.js   Helpers partagés par les handlers
    │   └── handlers/         Un module par domaine + table de routage
    └── public/               Frontend servi tel quel (HTML, CSS, JS)
```

Le dossier `data/`, créé à l'exécution, n'est pas versionné :

```
data/
├── settings.json           Réglages par serveur + playlists globales
├── playback_state.json     Dernier état de lecture connu
├── dashboard-token         Jeton d'accès généré au premier démarrage
├── uploads/                Fichiers importés, nommés par empreinte
├── cache/                  Pistes distantes préchargées en MP3
└── logs/                   Un journal par démarrage + latest.log
```

Le dossier `tools/` porte l'outillage Windows, sans lien avec le processus du
bot — aucun module de `src/` ne le référence :

```
Create shortcut.vbs       Point d'entrée double-cliquable, à la racine
Start bot.vbs             Démarrage direct, sans passer par un raccourci
tools/
├── create-shortcut.ps1   Assistant WPF : choix de l'emplacement, écriture du .lnk
├── start-bot.vbs         Cible du raccourci : appelle le .ps1 sans fenêtre
├── start-bot.ps1         Vérifications, installation, démarrage du bot
└── icon.ico              Icône du raccourci, redessinée si absente, non versionnée
```

**Pourquoi des `.vbs`.** Le raccourci lance `wscript.exe start-bot.vbs`, qui
appelle PowerShell avec un style de fenêtre `0`. C'est le seul moyen sous
Windows de démarrer un script sans qu'aucune console n'existe : un `.bat`, ou
un `.lnk` pointant sur `powershell.exe -WindowStyle Hidden`, fait toujours
clignoter un terminal — visible à l'écran et dans la barre des tâches — avant
de le masquer. Le `.lnk` vise `wscript.exe` explicitement, et non le `.vbs`,
car certaines machines associent les `.vbs` à `cscript.exe`, qui lui ouvrirait
une console.

`Start bot.vbs` et `tools/start-bot.vbs` sont volontairement le même appel, à
un chemin relatif près : le premier est le point d'entrée que l'on double-clique
dans le dossier du projet, le second la cible stable du `.lnk`. Les garder
distincts évite qu'un raccourci existant dépende d'un fichier de la racine, où
l'utilisateur est le plus susceptible de renommer ou déplacer quelque chose.
Aucun des deux ne porte de logique : tout est dans `start-bot.ps1`.

**La fenêtre de lancement.** Le bot tournant sans console, ce que celle-ci
portait est repris ailleurs : le déroulé du démarrage et les erreurs par la
fenêtre WPF de `start-bot.ps1`, le détail par `data/logs/`, l'arrêt par le
bouton d'extinction du tableau de bord (`shutdownBot`, voir
[05](05-tableau-de-bord.md)).

Cette fenêtre s'affiche à **chaque** lancement, et non plus à la seule première
utilisation. Elle liste les étapes réellement à faire — les dépendances et
l'enregistrement des commandes n'apparaissent que si `node_modules` manque — et
marque chacune d'un point en attente, d'un anneau qui tourne, d'une coche verte,
d'une coche ambre pour un échec non bloquant, ou d'une croix rouge. Sur une
croix, le déroulé s'arrête et le pied de la fenêtre porte le motif, un extrait
du journal et le bouton qui débloque : télécharger Node.js, ouvrir `.env`,
ouvrir les journaux.

Trois points méritent d'être connus avant d'y toucher :

- **Le signal de « prêt » est le port du tableau de bord.** Le bot ne l'ouvre
  qu'une fois connecté à Discord (`ClientReady` dans `src/index.js`) : une
  simple connexion TCP sur `127.0.0.1:PORT` est donc le seul témoin fiable, là
  où l'existence du processus ne prouve rien. La fenêtre s'efface dès que le
  port répond, et le navigateur est ouvert par le bot lui-même
  (`WebServer.start`), jamais par le script.
- **Un port déjà ouvert arrête le lancement.** Sans cette vérification
  préalable, un second démarrage mourrait sur un port occupé pendant que
  l'attente ci-dessus réussirait aussitôt — un faux succès. La fenêtre annonce
  alors que le bot tourne déjà et offre trois cartes : ouvrir le tableau de
  bord, redémarrer, éteindre.
- **La configuration est vérifiée avant l'installation.** L'ordre n'est pas
  indifférent : `npm run deploy` a besoin du jeton Discord, et il n'est rejoué
  que lorsque `node_modules` manque. Le vérifier après aurait condamné les
  commandes slash à n'être jamais enregistrées sur un dossier fraîchement
  récupéré.

Un échec immédiat — jeton refusé, module cassé — resterait invisible : l'étape
de démarrage surveille donc le processus, et celle du tableau de bord rend la
main au bout de quatre-vingt-dix secondes plutôt que d'attendre sans fin.

**Piloter un bot déjà lancé.** Les cartes « Redémarrer » et « Éteindre »
n'ajoutent aucun point d'accès : elles empruntent le canal du tableau de bord,
une WebSocket authentifiée sur laquelle transitent `restartBot` et
`shutdownBot` (`src/web/websocket/handlers/systemHandlers.js`). Exposer
l'extinction du process une seconde fois, en HTTP, aurait élargi la surface
d'attaque sans rien apporter. Le jeton voyage en query — forme acceptée par
`auth.extractToken` aussi bien pour `/api` que pour la poignée de main
WebSocket.

L'extinction demande confirmation, comme la fenêtre de maintenance du tableau
de bord : couper la lecture d'un serveur entier ne doit pas tenir à un clic de
travers. Le redémarrage, lui, part directement — la lecture reprend où elle en
était. Les deux rendent compte d'eux-mêmes en rejouant le moteur d'étapes : le
port qui tombe, puis qui revient.

Une seule addition côté bot : `GET /api/clients`, qui rend le nombre de
tableaux de bord connectés. C'est la même mesure que celle par laquelle
`WebServer.start` décide d'ouvrir ou non le navigateur, et la fenêtre s'en sert
pour ne pas ouvrir un onglet de plus quand il y en a déjà un. Le compte est
redemandé à chaque clic plutôt que retenu à l'ouverture : un onglet fermé
entre-temps condamnerait sinon le bouton. Si la question ne peut pas être posée,
l'onglet est ouvert — mieux vaut un doublon qu'un tableau de bord inatteignable.

Quatre pièges de Windows PowerShell 5.1 et de GDI+ sont désamorcés dans ces
scripts, et doivent le rester :

| Piège | Conséquence | Parade en place |
|---|---|---|
| Un `.ps1` sans BOM est lu en page de codes ANSI | Toute l'interface perd ses accents | Les deux `.ps1` sont en **UTF-8 avec BOM** ; les `.vbs`, en ASCII pur |
| `Start-Process -PassThru -RedirectStandardOutput` renvoie un `ExitCode` toujours nul | Une commande réussie est lue comme un échec | Aucune redirection .NET : `cmd` redirige lui-même (`1> … 2>&1`) |
| Un scriptblock invoqué par `&` s'exécute dans la portée de l'appelant, pas dans celle de sa définition | Les blocs `Start`/`Poll` d'une étape ne voient pas les paramètres de la fonction qui les a créés | Ils lisent leurs données dans l'étape courante (`CurrentStep`) et n'écrivent que dans des variables `$script:` |
| `GraphicsPath` et `GeometryGroup` remplissent en pair-impair par défaut | Les recouvrements de la note de musique se percent mutuellement | `FillMode = Winding` côté GDI+, `FillRule="Nonzero"` côté XAML |

Deux noms sont également à éviter dans ces scripts : `$host`, variable réservée
en lecture seule, et tout paramètre qui reprendrait le nom d'un élément de
l'interface — PowerShell ne distingue pas la casse, et le paramètre l'emporte.

---

## Séquence de démarrage

`npm start` exécute [`src/index.js`](../../src/index.js), dans cet ordre :

**1. Correctif Windows.** Avant tout `require`, `child_process.spawn` est
enveloppé pour forcer `windowsHide: true`. Sans cela, chaque appel à FFmpeg ou
yt-dlp fait apparaître une fenêtre de console. Le correctif doit précéder les
autres imports pour couvrir les bibliothèques tierces.

**2. Enregistrement des filtres de vitesse.** 286 filtres FFmpeg `speed_x_xx`
sont déclarés (voir [02 — Lecture audio](02-lecture-audio.md#vitesse-de-lecture)).

**3. Validation de l'environnement.** L'absence de `DISCORD_TOKEN` interrompt le
démarrage.

**4. Création du client Discord** avec les intentions `Guilds`,
`GuildVoiceStates` et `GuildMessages`.

**5. Chargement des commandes** depuis `src/commands/`.

**6. Initialisation de discord-player**, enregistrement des extracteurs, des
écouteurs d'événements et du gestionnaire de préchargement.

**7. Connexion à Discord.** À l'événement `ClientReady` :
- démarrage du serveur web ;
- restauration de l'état de lecture sauvegardé ;
- programmation de la sauvegarde périodique (toutes les 5 s).

```
index.js
  ├─ patch spawn (win32)
  ├─ AudioFilters : speed_0_20 … speed_3_05, muffled
  ├─ new Client(...)
  ├─ loadCommands()
  ├─ initPlayer()
  │    ├─ extractors.register(Youtubei, Spotify, SoundCloud, AppleMusic, Attachment)
  │    ├─ registerPlayerEvents()
  │    └─ preloadManager.init()
  └─ client.login()
       └─ ClientReady
            ├─ webServer.start(client, PORT, HOST)
            ├─ playbackStateManager.restoreAll()
            └─ setInterval(saveState, 5000)
```

---

## Carte des dépendances

Les flèches vont du consommateur vers le fournisseur.

```
                    index.js
                       │
        ┌──────────────┼──────────────┬───────────────┐
        ▼              ▼              ▼               ▼
   commands/      audio/         web/WebServer   database/
        │              │              │               │
        └──────────────┴──────┬───────┴───────────────┘
                              ▼
                          utils/
              (logger, atomicJson, paths, duration, mediaPaths)
```

`utils/` ne dépend de rien d'autre que de `config.js`. C'est la couche feuille :
tout peut l'importer sans risque de cycle.

**Deux cycles existent** et sont résolus par des `require()` différés à
l'intérieur des fonctions :

- `DuckingManager` → `WebServer` (pour rediffuser l'état à la détection de parole) ;
- `PlayerEvents` → `WebServer` → `wsHandler` → handlers → `PlaybackStateManager`.

Ces `require()` en ligne sont volontaires. Les déplacer en tête de fichier
provoquerait des imports circulaires non résolus.

---

## Cycle de vie d'une lecture

Exemple : un utilisateur lance une piste depuis le tableau de bord.

```
Navigateur ──WS {type:'play', data:{query}}──► wsHandler
                                                  │
                                     handlers/playbackHandlers.handlePlay
                                                  │
                              ┌───────────────────┼────────────────────┐
                              ▼                   ▼                    ▼
                    searchLocalAwareTrack   queue.connect()      queue.play()
                    (extracteurs)           (salon vocal)              │
                                                                      ▼
                                                          discord-player → FFmpeg
                                                                      │
                                                          événement 'playerStart'
                                                                      │
                              ┌───────────────────────────────────────┤
                              ▼                                       ▼
                     client.setupDucking()                  webServer.broadcastState()
                     (VolumeController + DuckingManager)              │
                                                                      ▼
                                                          Navigateur ◄──WS {type:'state'}
```

---

## PlaybackSession

discord-player expose un objet `GuildQueue` par serveur. Le projet y attachait
directement ses propres propriétés, sans encapsulation :

| Propriété | Rôle |
|---|---|
| `virtualCurrentTrack`, `virtualTracks`, `virtualHistory` | Lecteur virtuel du mode personnel |
| `virtualIsPlaying`, `virtualIsPaused`, `virtualProgressMs`, `virtualLastUpdated` | État du lecteur virtuel |
| `channelStates` | Instantané de lecture par salon vocal |
| `activeChannelId` | Salon considéré comme actif |
| `silencePlayer`, `silenceStream` | Émetteur de silence du mode personnel |
| `transitioningToEveryone`, `transitionTrack`, `transitionTargetProgress` | Bascule personnel → commun |
| `isPendingTransition`, `transitionTimeout` | Verrou anti-double-saut |
| `restorePaused`, `restoreProgress`, `restoreShouldBePaused` | Restauration au démarrage |
| `isMixFadingOut`, `mixAppliedTrackId`, `trackStartedAt` | Enchaînement type DJ |
| `pauseOnNextTrack` | Mise en pause différée |

**Pourquoi c'était un problème.** Aucune de ces propriétés n'était déclarée
quelque part : leur existence se découvrait en lisant les sites d'accès. Chaque
lecture devait se prémunir (`if (!queue.virtualTracks) queue.virtualTracks = []`
— 18 occurrences). Une montée de version de discord-player introduisant un nom
identique aurait cassé le bot silencieusement.

### L'état appartient désormais au projet

[`PlaybackSession`](../../src/audio/PlaybackSession.js) déclare les 23
propriétés dans un `SCHEMA` unique, avec leur type et leur valeur initiale.
L'état vit dans cet objet ; la queue n'en est plus propriétaire.

```
   queue.virtualTracks
          │  accesseur installé sur GuildQueue.prototype
          ▼
   session.virtualTracks        ← PlaybackSession, possédée par le projet
```

**Association par `WeakMap`.** La session est liée à l'objet queue, non au
`guildId` : une nouvelle queue repart d'un état neuf — comportement identique à
l'avant — et l'état est libéré avec elle, sans fuite mémoire.

**Accesseurs sur le prototype.** Ils couvrent toutes les queues, quel que soit
le chemin qui les a créées, y compris celles que discord-player instancie
lui-même — hors de portée d'une interception de `queues.create()`. Les
propriétés sont **non énumérables** : elles n'apparaissent plus dans une
sérialisation accidentelle de la queue.

### Interface unifiée

La session expose des accesseurs qui masquent la distinction entre mode commun
et mode personnel :

| Méthode | Remplace |
|---|---|
| `getCurrentTrack()` | `isPersonal ? queue.virtualCurrentTrack : queue.currentTrack` |
| `getTracks()` | `isPersonal ? queue.virtualTracks : queue.tracks.toArray()` |
| `getHistory()` | `isPersonal ? queue.virtualHistory : queue.history.tracks.toArray()` |
| `getIsPlaying()` / `getIsPaused()` | branchement mode + transition |

Utilisée par `PreloadManager.getActivePreloadTracks` et
`WebServer.getPlaybackPosition`.

### Migration restante

Les 455 sites d'accès existants continuent de fonctionner via les accesseurs :
la syntaxe `queue.virtualTracks` est inchangée, seul le stockage a bougé. Leur
réécriture en `session.virtualTracks`, puis le retrait des accesseurs, peut se
faire fichier par fichier — l'essentiel du bénéfice (schéma déclaré, valeurs
initiales garanties, protection contre les collisions) est déjà acquis.

---

## Points d'attention pour les modifications

**Ajouter une commande Discord** — créer un fichier dans `src/commands/`
exportant `{ data, execute }`, puis relancer `npm run deploy`. Le chargeur de
[`index.js`](../../src/index.js) contient un cas particulier en dur pour
`queue.js`, qui exporte cinq commandes.

**Ajouter un message WebSocket** — voir
[05 — Tableau de bord](05-tableau-de-bord.md#ajouter-un-message).

**Ajouter un réglage persistant** — l'ajouter à `_defaults()` dans
[`Database.js`](../../src/database/Database.js) ; les serveurs déjà enregistrés
héritent automatiquement de la valeur par défaut à la lecture.
