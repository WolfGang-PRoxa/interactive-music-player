# 04 — Modes de diffusion

[← Sommaire](README.md)

Le bot dispose de deux modes de lecture radicalement différents. Comprendre leur
distinction est indispensable avant de toucher au code d'état.

---

## Les deux modes

| | `everyone` (commun) | `personal` (personnel) |
|---|---|---|
| Où sort le son | Salon vocal Discord | Navigateur de l'utilisateur |
| Qui décode | discord-player + FFmpeg | Balise `<audio>` du tableau de bord |
| Position de lecture | `queue.node.getTimestamp()` | Compteur calculé côté serveur |
| Ducking | Actif | Sans objet |
| Piste courante | `queue.currentTrack` | `queue.virtualCurrentTrack` |
| File d'attente | `queue.tracks` | `queue.virtualTracks` |

Le réglage est `broadcastMode`, par serveur.

---

## Mode commun

Le fonctionnement attendu d'un bot musical : discord-player décode le flux et
l'émet dans le salon vocal. Tout le monde entend la même chose, le ducking
s'applique.

---

## Une adresse de flux, un seul fichier

En mode personnel, le navigateur va chercher le son sur `/api/stream`, une
adresse qui ne porte que l'identifiant de la piste. Or cette adresse peut
désigner deux fichiers très différents : le MP3 du cache de préchargement, ou le
fichier d'origine sur le disque. Le premier n'existe pas encore pendant que le
préchargement l'écrit, et disparaît ensuite quand le cache fait le ménage.

Un navigateur ne télécharge pas un média d'un seul tenant : il en demande des
tranches au fil de la lecture, sur la même adresse, pendant plusieurs minutes.
Choisir le fichier à chaque requête fait donc atterrir une tranche de MP3 dans
un décodage de WAV commencé sans elle — et cela ne s'entend ni comme un silence
ni comme une erreur, mais comme un **énorme bruit blanc** : des octets
compressés lus comme des échantillons bruts sont du bruit aléatoire, à plein
niveau.

La représentation est donc retenue au premier octet servi et resservie telle
quelle à toutes les tranches du **même chargement**, même si le cache est apparu
entretemps.

Ce qui identifie un chargement est le paramètre `load` de l'adresse, posé par le
tableau de bord et incrémenté à chaque mise en lecture — surtout pas la position
demandée. Une plage repartant de zéro ressemble à un nouveau départ, mais c'est
aussi ce qu'envoie une lecture **en boucle**, et là le navigateur n'a rien
oublié : il garde ses octets sous cette adresse et son décodeur ouvert sur le
format reconnu au premier passage. Rechoisir à ce moment-là est précisément ce
qui produisait quarante secondes de bruit puis un silence, à la seconde boucle
d'un morceau préchargé entretemps. L'adresse changeant à chaque chargement, le
navigateur ne peut jamais mélanger deux formes sous une même ressource.

Si le fichier retenu disparaît en pleine lecture, la requête est refusée par un
404 plutôt que servie dans l'autre format — le tableau de bord recharge la piste
à la position atteinte, sous une adresse neuve, ce qui coûte un blanc de
quelques centaines de millisecondes au lieu du bruit. Voir
[`api.js`](../../../src/web/routes/api.js) et le test `tests/streamSource.js`.

---

## Mode personnel : le lecteur virtuel

En mode personnel, **le bot ne décode aucun son**. Il tient à jour un état de
lecture fictif, et c'est le navigateur qui lit réellement l'audio via
`/api/stream`.

### Pourquoi un lecteur virtuel

Le tableau de bord doit continuer d'afficher une piste, une progression, une
file d'attente et un historique cohérents. Plutôt que de créer un second modèle
de données, le projet réplique la forme de la queue dans des propriétés
préfixées `virtual`.

### Avancement de la position

La progression n'est pas mesurée, elle est **calculée** par la boucle de
rafraîchissement du serveur web, chaque seconde :

```js
const elapsed = (now - queue.virtualLastUpdated) * vitesse;
queue.virtualProgressMs += elapsed;
queue.virtualLastUpdated = now;

if (queue.virtualProgressMs >= durée) handleVirtualSkip(queue, guildId);
```

Le facteur `vitesse` reprend `playbackSpeed`, afin que le compteur suive la
lecture accélérée ou ralentie du navigateur. Le client renvoie périodiquement sa
position réelle par le message `syncProgress`, ce qui corrige la dérive.

### Fin de piste

`handleVirtualSkip()` dans [`WebServer.js`](../../../src/web/WebServer.js) reproduit
le comportement d'un vrai lecteur : gestion du mode répétition, empilage dans
`virtualHistory`, dépilage de `virtualTracks`, et synchronisation de
`playlistCurrentIndex` si une playlist est active.

### L'émetteur de silence

Problème : sans flux audio, Discord ferme la connexion UDP après quelques
secondes, et la reprise du mode commun exigerait une reconnexion complète.

Solution — `startSilencePlayer()` dans [`index.js`](../../../src/index.js) : un
`Readable` en `objectMode` émet une trame de silence Opus toutes les 20 ms.

```js
silenceStream.push(Buffer.from([0xF8, 0xFF, 0xFE]));  // trame de silence Opus
```

`objectMode: true` est essentiel : sans lui, Node concatène les trames en un
seul bloc, que Discord rejette. La connexion reste ainsi ouverte et le bot
visible dans le salon, sans émettre de son audible.

---

## Bascule entre modes

### Commun → personnel

`BroadcastManager.setMode()` :

1. copie `currentTrack`, la position, la file et l'historique dans les
   propriétés `virtual*` ;
2. vide `queue.tracks` et `queue.history` pour arrêter la lecture réelle ;
3. termine le `dispatcher` sans déconnecter le bot ;
4. démarre l'émetteur de silence.

### Personnel → commun

L'opération inverse est la plus délicate du projet, car il faut **reprendre la
lecture à la position exacte** où le navigateur en était.

```
transitioningToEveryone = true
transitionTrack         = piste à reprendre
transitionTargetProgress = position en ms
        │
        ▼
  queue.play(track)  ── volume forcé à 0
        │
        ▼
  événement 'playerStart'
        │
        ├─ attendre 100 ms (laisser le flux s'établir)
        ├─ queue.node.seek(progress)
        ├─ retirer la piste de l'historique (le seek l'y ajoute à tort)
        ├─ retirer le doublon éventuel de la file
        ├─ transitioningToEveryone = false
        └─ restaurer le volume (ou fondu d'entrée si configuré)
```

Le volume est maintenu à 0 pendant toute la manœuvre : sans cela, l'utilisateur
entendrait le début de la piste avant le saut à la bonne position. Les drapeaux
`restorePaused` et `transitioningToEveryone` sont consultés par
[`VolumeController`](../../../src/audio/VolumeController.js) à sa construction et à
chaque changement de nœud, pour ne pas remonter le volume prématurément.

---

## Salons personnels

Indépendamment du lecteur virtuel, `BroadcastManager` sait créer un salon vocal
temporaire privé :

- nom : préfixe `config.broadcast.personalChannelPrefix` (🎵) suivi du nom
  affiché du membre ;
- permissions : `@everyone` refusé, membre et bot autorisés ;
- suivi dans `personalChannels` : `Map<guildId, Map<userId, channelId>>` ;
- suppression automatique quand le membre quitte le vocal, via l'écouteur
  `VoiceStateUpdate` de [`index.js`](../../../src/index.js).

> Ce suivi est **en mémoire seule**. Un redémarrage du bot alors que des salons
> personnels existent les laisse orphelins : ils devront être supprimés à la
> main.

---

## Le coût du double modèle

Chaque endroit qui lit ou écrit l'état doit distinguer les deux modes. Le motif
se répète dans tout le code :

```js
const currentTrack = isPersonal ? queue.virtualCurrentTrack : queue.currentTrack;
const tracks       = isPersonal ? queue.virtualTracks       : queue.tracks.toArray();
const isPlaying    = isPersonal ? !!queue.virtualIsPlaying  : queue.node.isPlaying();
```

`getChannelPlaybackState()` dans [`WebServer.js`](../../../src/web/WebServer.js) en
est l'expression la plus dense : un seul `return` combine trois axes
(`isPersonal` × `transitioningToEveryone` × présence d'un horodatage) en
ternaires imbriqués.

Une interface unique masquant la distinction — évoquée dans
[01 — Architecture](01-architecture.md#playbacksession) — supprimerait ce
motif. Toute modification du code d'état devrait, a minima, ne pas l'aggraver.

---

## État par salon vocal

Le bot mémorise un instantané de lecture **par salon**, dans
`queue.channelStates` :

```js
queue.channelStates[channelId] = {
    isPlaying, isPaused, repeatMode,
    currentTrack, currentProgress,
    queue: [...], history: [...],
    savedAt
};
```

Changer de salon depuis le tableau de bord (`selectChannel`) sauvegarde l'état
du salon quitté avant de restaurer celui du salon rejoint. Le tableau de bord
peut ainsi afficher une file d'attente pour un salon où le bot n'est pas
connecté : `getChannelPlaybackState()` sert alors les données du cache plutôt
que l'état en direct.

En diffusion commune, quitter un salon y **suspend** la lecture : le lecteur est
mis en pause avant la bascule — ce qui fait taire le salon pendant l'attente de
`queue.connect()` — et l'instantané est enregistré en pause à sa position. Le bot
se déconnecte dans tous les cas : il suit le tableau de bord vers le salon
rejoint, ou `detacher()` le retire si ce dernier est désert. Revenir plus tard
sur le salon quitté y retrouve donc le morceau en pause, à la seconde où il avait
été laissé, et non une lecture qui aurait couru sans auditeur.

L'entrée dans le salon rejoint reste soumise à la règle de présence : le bot n'y
va que si quelqu'un s'y trouve. Un salon désert dont l'instantané porte une
lecture reste figé, et le tableau de bord l'explique (voir plus bas).

---

## Présence dans les salons vocaux

Le bot ne s'installe dans un salon vocal que s'il y a quelqu'un pour l'entendre.
La règle est tenue par
[`PresenceManager`](../../../src/audio/PresenceManager.js), et vaut pour les deux
modes de diffusion — en mode personnel, la connexion ne sert qu'à capter la
parole pour le ducking, mais elle n'a pas davantage de raison d'être dans une
pièce vide.

| Événement | Effet |
|---|---|
| Démarrage, salon visé désert | Pas de connexion. La lecture est restaurée puis **figée**. |
| Premier humain entrant dans le salon rattaché | Connexion, ducking remonté, lecture reprise à sa position. |
| Dernier humain sortant | Départ après `config.presence.departureDelay` (30 s par défaut). |
| Retour avant la fin du délai | Départ annulé, rien ne bouge. |

Le **salon rattaché** est, dans l'ordre : le rattachement en cours
(`queue.activeChannelId`), le salon où le bot se trouve, le dernier salon
utilisé. Trois façons de dire « celui qu'on lui a désigné », de la plus récente
à la plus ancienne : le bot ne suit donc pas les auditeurs de salon en salon.
Faute de tout rattachement (première utilisation), il se pose dans le premier
salon où quelqu'un apparaît.

Le **salon favori n'y figure pas**, et c'est délibéré : il ne vaut qu'au
démarrage (voir ci-dessous). Consulté ici, il s'appliquait à chaque mouvement
vocal et toutes les 30 secondes ; dès que le rattachement manquait — file créée
par `/play`, par un import, ou restaurée sans salon —, il ramenait le bot chez
lui, et le premier auditeur entrant dans le favori l'y rappelait quel que soit
le salon où on l'avait installé. Un salon marqué d'une étoile devenait ainsi une
prison : plus moyen de travailler durablement ailleurs.

### Le salon favori : une valeur de démarrage, et rien d'autre

Le favori (`defaultVoiceChannelId`) désigne le salon sur lequel le bot et le
tableau de bord se posent quand le process démarre ou redémarre. Il est lu à
deux endroits, tous deux au démarrage :

- [`Database.appliquerSalonFavori()`](../../../src/database/Database.js), appelé une
  fois à `ClientReady`, en fait le **salon courant** (`setLastVoiceChannel`) ;
- [`PlaybackStateManager.restoreAll()`](../../../src/database/PlaybackStateManager.js)
  lui donne la priorité pour choisir le salon à restaurer, puis inscrit ce choix
  comme rattachement — y compris quand le salon est désert et que la connexion
  est remise à plus tard, sans quoi la règle de présence irait chercher le bot
  ailleurs que là où le tableau de bord l'annonce en attente.

Passé ce point, plus personne ne le lit. Marquer un salon d'une étoile en pleine
session ne déplace donc rien : le réglage est noté pour le prochain démarrage.
Tout le reste — règle de présence, sélecteur de salon, `getState` — ne suit que
le salon courant, que chaque changement de salon met à jour.

### La lecture figée

Partir ne veut pas dire tout perdre. La file d'attente, l'historique et la piste
courante restent en mémoire ; seul le lecteur de discord-player disparaît avec
la connexion vocale, et avec lui la seule chose qu'il savait encore : où en
était la lecture. La session prend le relais le temps de l'absence :

```js
queue.absentSalonVide     // le bot s'est retiré, ou n'est jamais entré
queue.positionFigeeMs     // position relevée juste avant le départ
queue.lectureFigeeEnCours // la lecture était-elle en cours ?
```

`session.estGelee()` est le test à faire avant d'interroger `queue.node` : un
lecteur démonté ne rend que des zéros. Le tableau de bord, la sauvegarde d'état
et les commandes de lecture passent tous par là — `commanderFige()` applique
pause, reprise, seek, stop, skip et previous directement sur l'état figé, si
bien que le tableau de bord reste utilisable pendant l'absence du bot.

Un point de connexion qui renonce à se connecter appelle `marquerAbsent()` ;
inversement, toute connexion vocale lève le gel, quelle qu'en soit l'origine
(l'écouteur `connection` du player).

### Le dire au tableau de bord

Une lecture figée reste déclarée *en cours* — elle repartira d'elle-même —, mais
rien n'avance. Vu du tableau de bord, cela ressemblait à une panne : bouton
pause, pochette qui tourne, et une barre de progression qui gagnait une seconde
avant de la reperdre, indéfiniment — le client interpolait localement pendant que
le serveur renvoyait chaque seconde la même position figée.

`session.attenteAuditeur()` rend de quoi l'expliquer, et `WebServer` y joint le
nom du salon concerné. Le tableau de bord affiche alors un bandeau au-dessus de
la barre (« Personne dans « X » : la lecture est en attente… »), cesse
d'interpoler la position et suspend les animations de lecture. Le message
distingue les deux gels : une lecture qui reprendra à l'arrivée de quelqu'un, et
une lecture en pause, que le retour du bot ne relancera pas.

### Deux pièges de discord-player

**La destruction du flux passe pour une fin de piste.** Détruire le dispatcher
fait passer le lecteur audio à l'état *Idle*, ce que discord-player interprète
comme la fin du morceau : il pousse la piste dans l'historique et enchaîne sur
la suivante. Le mode « transition » est donc levé le temps de la destruction —
`performFinish` s'y abstient de tout traitement.

**Le gestionnaire d'état vocal par défaut détruit la file.** `leaveOnEmpty`
appelle `queue.delete()`, ce qui emporte file d'attente, historique et état par
salon. S'abonner à `voiceStateUpdate` sur le player désactive ce gestionnaire ;
`PresenceManager` reprend à son compte les cas qu'il traitait utilement
(sourdine serveur, salon de conférence, déplacement du bot par un modérateur).
`leaveOnEmpty` est passé à `false` partout, pour que le code ne promette plus un
comportement qui n'a plus cours.
