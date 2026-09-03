# 05 — Tableau de bord

[← Sommaire](README.md)

Le tableau de bord est une application web servie par le bot lui-même. Il pilote
la lecture en temps réel et double la totalité des commandes Discord.

---

## Serveur

[`WebServer.js`](../../../src/web/WebServer.js) est un singleton qui assemble :

- un serveur **HTTP** Express : fichiers statiques et routes `/api/*` ;
- un serveur **WebSocket** (`ws`) partageant le même port ;
- l'agrégation de l'état complet (`getState`) et sa diffusion.

L'écoute se fait sur `HOST:PORT`, **`127.0.0.1:3000` par défaut**. Au démarrage,
le navigateur est ouvert automatiquement après 5 secondes si aucun client n'est
connecté, sur une URL contenant le jeton d'accès.

### Découpage des responsabilités

| Fichier | Rôle |
|---|---|
| [`WebServer.js`](../../../src/web/WebServer.js) | Cycle de vie, agrégation d'état, diffusion |
| [`auth.js`](../../../src/web/auth.js) | Jeton d'accès HTTP et WebSocket |
| [`routes/api.js`](../../../src/web/routes/api.js) | Routes HTTP |
| [`uploadService.js`](../../../src/web/uploadService.js) | Réception et intégration des imports |
| [`websocket/wsHandler.js`](../../../src/web/websocket/wsHandler.js) | Routeur de messages |
| [`websocket/handlers/`](../../../src/web/websocket/handlers/) | Logique métier, un module par domaine |

---

## Routes HTTP

Toutes sont protégées par le jeton ([07 — Sécurité](07-securite.md)).

| Route | Rôle |
|---|---|
| `GET /api/state` | État complet, en secours si le WebSocket est indisponible |
| `GET /api/invite` | Lien d'invitation du bot sur un nouveau serveur Discord |
| `GET /api/stream` | Flux audio d'une piste, pour le lecteur du navigateur |
| `GET /api/download` | Téléchargement transcodé, 32 combinaisons format/qualité (MP3, M4A, FLAC, WAV, OGG, OPUS, WEBM, MP4) |
| `GET /api/video-info` | Résolution d'une URL vidéo via yt-dlp, cache mémoire d'une heure |
| `POST /api/upload` | Import de fichier, flux brut avec en-tête `X-File-Name` |
| `GET /api/docs` | Sommaire de la documentation embarquée, dans la langue demandée |
| `GET /api/docs/contenu` | Source Markdown d'un document, désigné par son identifiant et sa langue |
| `GET /api/download-dir` | Dossier de téléchargement courant, et le défaut auquel il se compare |
| `POST /api/download-dir` | Choix du dossier, validé avant d'être retenu ; corps vide pour revenir au défaut |
| `GET /api/browse-dirs` | Sous-dossiers d'un chemin de la machine hôte, pour le sélecteur |

`/api/docs` inventorie `docs/` à chaque appel, depuis la **version en cours
d'exécution** et non depuis la racine partagée : la documentation affichée est
donc celle du code qui tourne. Les identifiants renvoyés forment la liste
blanche du service de contenu — celui-ci ne construit jamais de chemin à partir
de la requête, il cherche l'identifiant dans l'inventaire qu'il vient d'établir.
C'est ce qui met une remontée de dossier hors sujet plutôt que hors la loi.

Les deux routes acceptent un paramètre `lang`, celui du tableau de bord : `docs/`
est rangé par langue — `docs/fr/`, `docs/en/`… —, les identifiants restent les
mêmes partout, et le lecteur ne demande jamais autre chose que la langue de son
interface. La valeur reçue subit le même traitement que l'identifiant : elle est
comparée aux dossiers que le serveur a lui-même lus, jamais assemblée en chemin.
L'inventaire part du dossier de la langue retenue, et **jamais de `docs/`** :
parcourue depuis la racine partagée, l'arborescence rendrait les dossiers de
langue eux-mêmes comme autant de groupes, et le sommaire du lecteur se muerait en
sélecteur de langue — alors que la langue ne se choisit que dans les réglages.
Une langue absente de `docs/` retombe sur le français, en bloc.

`/api/invite` assemble l'adresse depuis l'application réellement connectée
(`client.generateInvite`, portées `bot` et `applications.commands`) : un
identifiant écrit en dur dans la page finit par désigner une autre application,
et Discord répond alors « application inconnue ». C'est une route HTTP et non un
champ de l'état, car `/api/state` refuse de répondre tant que le bot n'a rejoint
aucun serveur — précisément le cas où ce lien est le seul recours.

`/api/stream` sert, dans l'ordre : le fichier de cache de préchargement s'il
existe, sinon le fichier local s'il est sous une racine autorisée, sinon un
transcodage MP3 à la volée du flux distant.

### Requêtes Range

Les deux premières branches passent par `serveFileWithRange()`, qui répond
`206 Partial Content` avec le bon `Content-Range`, borne les fins hors limites,
gère la forme suffixe (`bytes=-500`), et renvoie `416` sur une plage
inatteignable. Une plage illisible est ignorée : le fichier entier est servi.

**C'est indispensable au déplacement dans la piste.** Sans réponse `206`, le
navigateur doit télécharger depuis le début pour atteindre la position demandée.
La branche du cache de préchargement annonçait `Accept-Ranges: bytes` tout en
ignorant l'en-tête `Range` : au rechargement du tableau de bord, la lecture ne
reprenait qu'une fois le téléchargement arrivé à la position enregistrée.

Le transcodage distant, lui, est intrinsèquement séquentiel (`Transfer-Encoding:
chunked`) et ne peut pas honorer de plage — raison de plus pour que le
préchargement alimente le cache.

---

## Protocole WebSocket

### Messages serveur → client

| Type | Charge utile |
|---|---|
| `state` | État complet (voir ci-dessous), émis sur événement |
| `progress` | `{ progress, isPlaying, isPaused, botStats }` — émis chaque seconde, ~200 octets |
| `log` | Une entrée de journal `{ timestamp, level, text }` |
| `logsHistory` | Les 200 dernières entrées, à la connexion |
| `error` | `{ message }`, affiché en notification |
| `status` | `{ status: 'restarting' \| 'shutting_down', … }` |

### Messages client → serveur

37 types, déclarés dans la table de routage
[`handlers/index.js`](../../../src/web/websocket/handlers/index.js) :

| Domaine | Messages |
|---|---|
| Lecture | `play`, `pause`, `resume`, `skip`, `previous`, `stop`, `seek`, `setPlayMode`, `syncProgress` |
| File d'attente | `removeTrack`, `playNow`, `moveOrInsertTrack`, `clearQueue`, `removeFromHistory`, `clearHistory` |
| Playlists | `createPlaylist`, `renamePlaylist`, `deletePlaylist`, `reorderPlaylists`, `addPlaylistTrack`, `addTrackToPlaylist`, `removeTrackFromPlaylist`, `movePlaylistTrack`, `setActivePlaybackSource` |
| Serveur Discord | `selectChannel`, `setDefaultChannel`, `updateSettings`, `toggleVoiceDetection`, `leaveGuild` |
| Piste | `setTrackQuality`, `downloadTrack` |
| Système | `requestState`, `clientLog`, `memoryStream`, `startupFadeinConsumed`, `restartBot`, `shutdownBot` |

`leaveGuild` fait quitter au bot un serveur Discord — la corbeille des réglages,
après confirmation du nom. La file de lecture est détruite avant le départ, puis
les tableaux de bord restés sur ce serveur sont rebasculés sur un autre
(`WebServer.reattribuerClients`), faute de quoi ils ne recevraient plus aucun
état. À distinguer de l'interrupteur voisin, qui ne fait que masquer le serveur
dans les listes de ce navigateur — un réglage local, sans effet sur le bot.

Le menu contextuel d'une piste locale n'ouvre pas son dossier : un navigateur ne
peut pas commander l'explorateur de fichiers de la machine qui l'affiche. Il
propose à la place « Copier le chemin d'accès », qui met `track.url` dans le
presse-papiers — l'utilisateur colle ce chemin où il veut. Tout est côté client,
aucun message WebSocket n'est échangé.

### Structure de l'état

```js
{
  guildId, selectedVoiceChannelId,
  guilds: [ { id, name, voiceChannels: [ { id, name, userCount, botConnected, isPlaying } ] } ],
  currentTrack, progress: { current, currentMs, total, totalMs, percent },
  mixTransition: null | { sortante: { url, positionMs, dureeMs, ratio },
                          entrante: { url, positionMs, dureeMs, ratio, track } },
  isPlaying, isPaused, isTransitioning, repeatMode, volume,
  settings: { duckingEnabled, duckingLevel, duckingDelay, duckingFade,
              broadcastMode, playbackSpeed, mixEnabled, mixDuration, mixType, … },
  queue: [...], history: [...], playlists: [...],
  activePlaybackSource, playlistCurrentIndex,
  speakers: [userId], ignoredVoiceUsers: [userId],
  members: [ { id, displayName, avatar } ],
  botStats: { memory, uptime, timestamp }
}
```

Chaque piste est enrichie par `formatTrackWithPreload()` de `isPreloaded`,
`isPreloading` et `preloadProgress`.

`progress.currentMs` et `progress.totalMs` sont toujours exprimés dans le temps
du fichier, vitesse de lecture non appliquée — quel que soit le mode de
diffusion. C'est le navigateur qui divise par `playbackSpeed` au moment
d'afficher les deux durées, et c'est aussi dans cette échelle que sont attendues
les demandes de repositionnement. Le rapport `currentMs / totalMs` donne donc
directement la barre de progression. La position que rend
`queue.node.getTimestamp()` suit la même échelle, mais pas sa durée totale, déjà
divisée par la vitesse : `buildProgress()` la recalcule depuis la piste.

`mixTransition` n'est renseigné qu'en diffusion commune, pendant un fondu
enchaîné du bus de mixage : deux morceaux sonnent alors ensemble, et la file du
serveur ne déclare le second courant qu'au terme de la superposition. Le
tableau de bord s'en sert pour annoncer le titre entrant dès le début du fondu
et pour animer les deux lignes de la playlist à la fois — ce que la diffusion
personnelle déduit toute seule de ses deux éléments `<audio>`.

---

## Routage des messages

[`wsHandler.js`](../../../src/web/websocket/wsHandler.js) ne contient **aucune
logique métier**. Il assemble un contexte et délègue :

```js
await handler({
    ws, data, webServer, player,
    queue: player.queues.get(currentGuildId),
    currentGuildId,
    dispatch: (payload) => handleMessage(ws, payload, webServer),
});
```

`dispatch` permet à un handler d'en réutiliser un autre — `playNow` s'appuie sur
`play`. `data` est systématiquement remplacé par `{}` s'il est absent, ce qui
dispense chaque handler de s'en prémunir.

### Ajouter un message

1. Écrire la fonction dans le module de
   [`handlers/`](../../../src/web/websocket/handlers/) correspondant au domaine,
   avec la signature `(ctx)`.
2. L'exporter.
3. Ajouter la ligne `monMessage: monModule.handleMonMessage,` dans
   [`handlers/index.js`](../../../src/web/websocket/handlers/index.js).

Le routeur n'est jamais modifié.

---

## La boucle de rafraîchissement

`WebServer.start()` installe un `setInterval` d'une seconde qui, pour chaque
serveur :

1. fait avancer la position du lecteur virtuel en mode personnel ;
2. détecte le déclenchement d'un enchaînement DJ ;
3. appelle `preloadManager.update()` ;
4. diffuse **uniquement la progression** (`broadcastProgress`).

L'état complet part sur événement — piste changée, file modifiée, réglage
touché — par `broadcastState`. Cette séparation repose sur
`getPlaybackPosition()`, qui calcule la position sans reformater les pistes.

### Ce qui rendait le tour de seconde coûteux

Avant cette séparation, chaque tick rediffusait l'état complet : tous les salons
vocaux, tous les membres, la file, l'historique et **toutes les playlists**.
Chaque piste passait par `getTrackPreloadInfo()`, qui enchaînait environ quatre
`fs.existsSync` et un `fs.statSync`.

| Pistes | Avant — blocage / message | Après |
|---|---|---|
| 10 | 0,3 ms / 8 Ko | ~0 ms / 216 octets |
| 50 | 1,6 ms / 40 Ko | ~0 ms / 216 octets |
| 200 | 6,5 ms / 119 Ko | ~0 ms / 216 octets |
| 500 | 16,2 ms / 277 Ko | ~0 ms / 216 octets |

La charge utile périodique ne dépend plus du nombre de pistes.

### Les trois mesures appliquées

1. **Progression seule au tour de seconde** — `broadcastProgress` n'envoie que
   `{ progress, isPlaying, isPaused, botStats }`.
2. **Index mémoire du cache de préchargement** — `PreloadManager.cachedKeys`
   remplace la relecture disque ; le statut d'une piste passe de 32,4 µs à
   1,3 µs. Une URL `http(s)` court-circuite désormais le test de fichier local,
   qui ne pouvait de toute façon rien trouver.
3. **Pas de réémission à l'identique** — `broadcastState` compare une signature
   de l'état, `botStats` exclu (son horodatage change à chaque appel et rendrait
   toute comparaison inutile), et n'envoie rien si elle est inchangée.

Cet intervalle n'est jamais arrêté : il n'existe pas de méthode `stop()`.

---

## Robustesse

L'initialisation d'un client est isolée dans `_initClient()`, appelée sous
`try/catch` depuis `wss.on('connection')`. Une exception y survenant — par
exemple `getState()` sur un état inattendu — était auparavant une exception non
interceptée qui **terminait le processus** : une connexion au tableau de bord au
mauvais moment suffisait à arrêter le bot. Le client fautif reçoit désormais un
message d'erreur puis est déconnecté ; le bot poursuit.

Les messages entrants sont protégés de la même façon : `ws.on('message')`
enveloppe l'appel au routeur.

> Il n'existe en revanche **aucun garde-fou global** : ni `uncaughtException`,
> ni `unhandledRejection`, ni gestion de `SIGTERM` (seul `SIGINT` est traité).
> Une exception ailleurs dans le code termine toujours le processus.

Un *heartbeat* de 30 secondes (`ping`/`pong`) ferme les connexions mortes.

---

## Frontend

Environ 9 800 lignes de JavaScript, servies sans transformation. Pas de modules
ES, pas de bundler : 18 balises `<script>` chargées séquentiellement dans
[`index.html`](../../../src/web/public/index.html) — 16 modules de `js/`, les
traductions et `app.js` — communiquant par l'espace de noms global
`window.MusicPlayer`.

| Fichier | Rôle |
|---|---|
| `state.js` | État partagé, préférences, internationalisation |
| `websocket.js` | Connexion, reconnexion automatique, envoi |
| `app.js` | Chef d'orchestre : lecteur, réglages, lecture personnelle |
| `player.js` | Barre de progression, mise en forme des durées |
| `queue.js` | File d'attente et historique, glisser-déposer, import |
| `playlists.js` | Onglets de playlists |
| `video.js` | Lecture vidéo et visualiseur audio |
| `logs.js` | Terminal de journaux |
| `drawer.js` | Panneau latéral de statistiques |
| `settingsModal.js`, `speedPad.js`, `customSelect.js` | Contrôles d'interface |
| `layoutPersistence.js` | Sauvegarde de la disposition |
| `tooltipSystem.js`, `faviconAnimator.js`, `headerButtonAnimations.js`, `particlePath.js` | Habillage |

Les feuilles de style sont assemblées par `@import` dans
[`style.css`](../../../src/web/public/style.css), plus `css/drawer.css` chargée à
part.

L'ordre de chargement est une dépendance implicite : `state.js` doit précéder
tous les autres, `app.js` doit venir en dernier.

### Découpage inachevé

[`app.js`](../../../src/web/public/app.js) fait 1 823 lignes et concentre des
responsabilités que le dossier `js/` a déjà commencé à extraire. C'est le
pendant frontend du découpage effectué côté serveur, qui reste à terminer.

### Duplication à surveiller

`window.MusicPlayer.formatMs` dans
[`player.js`](../../../src/web/public/js/player.js) doit rester aligné sur
`formatMs` de [`src/utils/duration.js`](../../../src/utils/duration.js) : c'est le
client qui rend la timeline, à partir des millisecondes et non de la chaîne
envoyée par le serveur.
