# 09 — Configuration

[← Sommaire](README.md)

---

## Deux niveaux de configuration

| Niveau | Fichier | Modifiable à chaud |
|---|---|---|
| Environnement | `.env` | Non — redémarrage requis |
| Constantes applicatives | [`src/config.js`](../../../src/config.js) | Non — valeurs par défaut au code |
| Réglages par serveur | `data/settings.json` | Oui — commandes ou tableau de bord |

`config.js` ne contient que des **valeurs par défaut** : dès qu'un serveur est
connu, ses réglages effectifs vivent dans `settings.json` (voir
[06 — Persistance](06-persistance.md)).

---

## Variables d'environnement

Copier `.env.example` vers `.env` et renseigner au minimum `DISCORD_TOKEN`.

Le propriétaire peut aussi les régler depuis la section **Configuration du bot**
des paramètres du tableau de bord ([`src/web/botConfig.js`](../../../src/web/botConfig.js),
écriture par [`src/utils/envFile.js`](../../../src/utils/envFile.js)). Trois règles :

- les secrets (`DISCORD_TOKEN`, `DISCORD_CLIENT_SECRET`, `CLOUDFLARE_TUNNEL_TOKEN`)
  ne repartent jamais vers le navigateur, seulement le fait qu'ils sont renseignés ;
- les variables qui peuvent couper l'accès ou élargir ce que le serveur lit sur
  le disque (Discord, partage, `HOST`, `PORT`, `MEDIA_ROOTS`) ne s'écrivent que
  depuis la machine du bot : connexion locale sans en-tête `CF-Connecting-IP`,
  que Cloudflare pose toujours ;
- l'écriture est tout ou rien, ne touche que les lignes concernées et garde
  commentaires et fins de ligne. `DASHBOARD_TOKEN` et `AUTO_OPEN_DASHBOARD` n'y
  figurent pas.

### Discord

| Variable | Requis | Rôle |
|---|---|---|
| `DISCORD_TOKEN` | **Oui** | Jeton du bot. Son absence interrompt le démarrage. |
| `DISCORD_CLIENT_ID` | Pour `npm run deploy` | Identifiant de l'application |
| `DISCORD_CLIENT_SECRET` | Pour la connexion Discord | Secret OAuth2. Laissé vide, personne ne peut s'identifier : le tableau de bord le dit et retombe sur le seul jeton d'accès. |
| `GUILD_ID` | Pour un déploiement local | Enregistre les commandes sur ce seul serveur, sans délai de propagation |

### Tableau de bord

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | `3000` | Port d'écoute |
| `HOST` | `127.0.0.1` | Interface d'écoute. `0.0.0.0` pour exposer au réseau local. |
| `PUBLIC_URL` | — | Adresse **fixe** par laquelle les invités atteignent le tableau de bord, sans barre oblique finale : un domaine derrière un tunnel nommé, une IP de réseau local. L'URL de rappel `<PUBLIC_URL>/auth/discord/callback` doit alors être déclarée à l'identique dans le portail Discord. Vide pour le partage rapide, dont l'adresse change à chaque lancement. |
| `OAUTH_RELAY_URL` | relais par défaut | Relais de retour OAuth employé sans `PUBLIC_URL` : c'est son adresse qu'on déclare chez Discord, une fois pour toutes. `off` pour s'en passer. |
| `CLOUDFLARE_TUNNEL_TOKEN` | — | Jeton d'un tunnel nommé créé dans le tableau de bord Cloudflare. Remplace le partage rapide ; exige `PUBLIC_URL`. |
| `CLOUDFLARED_PATH` | — | Chemin de `cloudflared`, s'il est ailleurs que dans `data/bin/` ou les emplacements habituels. |
| `AUTO_OPEN_DASHBOARD` | `true` | Ouverture du navigateur au démarrage. `false` quand le bot tourne sur une machine pilotée à distance — ce tableau de bord jouerait la musique en double. |
| `DASHBOARD_TOKEN` | généré | Jeton d'accès. Si vide, généré et enregistré dans `data/dashboard-token`. |

### Versions

| Variable | Défaut | Rôle |
|---|---|---|
| `GITHUB_TOKEN`, `GH_TOKEN` | — | Jeton d'API GitHub. Facultatif sur un dépôt public ; relève le quota de 60 à 5 000 requêtes par heure. À défaut, le CLI `gh` est interrogé s'il est installé et connecté. |
| `IMP_REPO` | dépôt de `package.json` | Dépôt dont les releases sont proposées, en `owner/repo` ou en URL |
| `IMP_VERSIONS_DIR` | `versions/` | Déporte les releases installées ailleurs — disque secondaire, dossier hors du dépôt |
| `IMP_RESTART` | — | Posé par l'instance qui se relance. Marque une reprise, ce qui supprime le fondu d'ouverture et fait ignorer le salon favori. |

Les trois dernières ne sont pas des réglages d'utilisateur : le bot les pose
lui-même en relançant une autre version. Voir
[10 — Versions](10-versions.md).

### Médias

| Variable | Défaut | Rôle |
|---|---|---|
| `MEDIA_ROOTS` | — | Dossiers locaux autorisés au streaming, en plus de `data/uploads` et `data/cache`. Séparateur `;` ou `,`. |
| `MAX_UPLOAD_MB` | `1024` | Taille maximale d'un fichier importé |
| `MAX_CACHE_MB` | `2048` | Plafond du cache de préchargement dans `data/cache` |

### Journalisation

| Variable | Défaut | Rôle |
|---|---|---|
| `LOG_LEVEL` | `debug` | Seuil : `debug`, `info`, `warn`, `error` |
| `LOG_RETENTION` | `20` | Nombre de journaux conservés dans `data/logs` |

### Variables sans effet

`SPOTIFY_CLIENT_ID` et `SPOTIFY_CLIENT_SECRET` sont lues par
`@discord-player/extractor` si présentes, et améliorent la résolution Spotify.

`DEEZER_ARL`, `QOBUZ_EMAIL` et `QOBUZ_PASSWORD` **n'ont aucun effet** : aucun
extracteur correspondant n'est installé ni enregistré. Ce sont des reliquats.

---

## config.js

```js
ducking: {
    enabled: true,          // ducking actif par défaut
    level: 20,              // % du volume de base pendant la parole
    restoreDelay: 800,      // ms de silence avant restauration
    fadeDuration: 200,      // ms de transition
    fadeStepInterval: 20,   // ms entre deux paliers de fondu
},
volume: { defaultBase: 70, min: 0, max: 100 },
presence: {
    enabled: true,          // n'entrer dans un salon vocal que s'il est habité
    departureDelay: 30000,  // ms d'attente avant de quitter un salon vidé (repli)
},
broadcast: { defaultMode: 'everyone', personalChannelPrefix: '🎵' },
supportedExtensions:      ['.mp3', '.flac', '.wav', '.ogg', '.m4a', '.opus', '.aac', '.wma'],
supportedVideoExtensions: ['.mp4', '.webm', '.mkv', '.avi', '.mov', '.flv', '.m4v', '.3gp', '.ogv', '.wmv'],
colors: { … },   // couleurs des encadrés Discord
```

`fadeStepInterval` est la seule constante non exposée à l'utilisateur : elle
détermine la granularité des fondus de
[`VolumeController`](../../../src/audio/VolumeController.js).

`presence.enabled` à `false` rend au bot son ancien comportement : il reste
connecté en permanence, salon vide ou non. Voir
[04 — Modes de diffusion](04-diffusion.md#présence-dans-les-salons-vocaux).

`presence.departureDelay` n'est qu'une valeur de repli : chaque serveur fixe la
sienne depuis le tableau de bord (*Paramètres → Paramètres du bot → Délai avant
de quitter un salon vide*), enregistrée par serveur sous `presenceDepartureDelay`
— **en secondes**, l'unité du curseur, que `PresenceManager._departureDelayMs()`
reconvertit en millisecondes. Le curseur va de 0 à 300 s, et le serveur reborne
la valeur reçue ; zéro signifie un départ sans délai, ce qui interdit le `||`
habituel sur ce réglage. Changer le délai réarme un compte à rebours déjà lancé,
pour ne pas attendre le prochain salon vidé.

Les listes d'extensions ont un double rôle : filtrage des dossiers scannés par
`/playlist`, et **périmètre du garde-fou de sécurité** des chemins servis au
client (voir [07 — Sécurité](07-securite.md)).

---

## Réglages par serveur

Valeurs par défaut définies dans `_defaults()` de
[`Database.js`](../../../src/database/Database.js). Ajouter une clé ici suffit :
tous les serveurs existants en héritent, `getSettings()` fusionnant les défauts à
chaque lecture.

| Clé | Défaut | Description |
|---|---|---|
| `duckingEnabled` | `true` | Atténuation à la parole |
| `duckingLevel` | `20` | % du volume de base pendant la parole |
| `duckingDelay` | `800` | ms avant restauration |
| `duckingFade` | `200` | ms de transition |
| `baseVolume` | `70` | Volume hors parole |
| `broadcastMode` | `'everyone'` | Mode de diffusion |
| `playbackSpeed` | `'1.0'` | Vitesse de lecture |
| `defaultVoiceChannelId` | `null` | Salon favori — un seul, tous serveurs confondus ; lu au démarrage seulement |
| `lastVoiceChannelId` | `null` | Dernier salon visité — c'est lui que tout le monde suit en session |
| `mixEnabled` | `false` | Enchaînement type DJ |
| `mixDuration` | `5` | Durée de l'enchaînement, en secondes |
| `mixType` | `'volume'` | `'volume'` ou `'effects'` |
| `lufsSyncEnabled` | `false` | Aligner tous les morceaux sur une même sonie |
| `lufsSyncTarget` | `-14` | Cible commune, en LUFS |
| `fadeinEnabled` | `false` | Fondu d'entrée |
| `fadeinDuration` | `5` | Secondes |
| `fadeoutEnabled` | `true` | Fondu de sortie à l'extinction |
| `fadeoutDuration` | `5` | Secondes |
| `addTarget` | `'queue'` | Destination du champ d'ajout : `queue`, `playlist`, `play` ou `download` |
| `importFormat` | `'mp3'` | Conteneur des fichiers écrits sur le disque |
| `importAudioQuality` | `'320'` | Débit MP3 du préchargement, en kbps |
| `importVideoQuality` | `'720'` | Hauteur cible du flux vidéo, en pixels |
| `presenceDepartureDelay` | `30` | Délai avant de quitter un salon vidé, **en secondes** |
| `ignoredVoiceUsers` | `{}` | Exclusions de ducking, par salon |
| `sharedControl` | `{}` | Droits accordés aux invités, par compte Discord |
| `rightRequests` | `{}` | Droits demandés par les invités, en attente de réponse : compte → droit → horodatage |
| `mutedRightRequests` | `[]` | Invités dont les demandes de droit sont en sourdine |
| `preloading` | voir ci-dessous | Préchargement : `enabled`, `queueCount`, `historyCount`, `playlistCount` |
| `activePlaybackSource` | `'queue'` | `'queue'` ou identifiant de playlist |
| `playlistCurrentIndex` | `0` | Position dans la playlist active |
| `loopPlaylist` | `false` | Relire la playlist active depuis son premier titre |
| `shuffle` | `false` | Tirer le titre suivant au sort, à chaque enchaînement |
| `channelQueues` | `{}` | La file d'attente, rangée salon vocal par salon vocal |
| `queueBackupPersonal` | `null` | Sauvegarde d'avant le rangement par salon |
| `queueBackupEveryone` | `null` | Idem, mode commun |

`channelQueues` est `{ "<channelId>": [piste | aiguillage, …] }`. Un salon
« soirée » et un salon « calme » ont chacun leur file et la retrouvent au
retour, là où une file unique par serveur suivait le bot partout. C'est aussi
le seul endroit où un aiguillage peut attendre son tour : il a besoin d'une
liste rangée pour désigner une position, ce que le lecteur ne lui offrait pas.
Voir [`channelQueue`](../../../src/audio/channelQueue.js).

Les deux dernières clés sont **héritées**, et restent à `null` : elles
portaient la file mise de côté avant le rangement par salon.
[`channelQueue`](../../../src/audio/channelQueue.js) les relit une fois pour
reverser ce qu'une version antérieure y avait laissé, puis les efface. Tout
passe désormais par [`setAsideQueue`](../../../src/utils/setAsideQueue.js) :
une simple liste de pistes, dans laquelle rien n'est « courant » puisque rien
n'en joue tant que la playlist occupe le lecteur. Les anciennes formes
(`{ tracks }`, `{ virtualCurrentTrack, virtualTracks }`) restent acceptées en
lecture.

`loopPlaylist` est distinct du mode de répétition de discord-player, qui ne
connaît que la file réellement chargée : rejouer « la playlist » suppose de la
recharger depuis son premier titre, même si la lecture avait démarré en plein
milieu.

`shuffle` est un interrupteur à part, et non un quatrième mode : il tient avec
le bouclage de playlist — la rebattre à chaque tour est une demande courante — et
Comme les trois autres, son bouton allume et n'éteint pas : on le quitte par
« lecture suivie », qui remet tout à plat. Il ne tient pas avec la répétition de
la piste, qui ne
fait jamais avancer la file : il n'y aurait aucun titre suivant à tirer. Le tirage
a lieu à l'enchaînement,
jamais d'avance : la diffusion commune s'en remet au mélange **dynamique** de
discord-player (`enableShuffle(true)`), qui laisse la file dans son ordre, et la
diffusion personnelle tire elle-même dans `WebServer.drawNextVirtualTrack()`.
Battre la file une fois pour toutes serait irréversible, et elle cesserait
d'annoncer ce qui vient. En contrepartie, plus rien ne se déduit de l'ordre :
le fondu enchaîné du navigateur ne prépare plus de titre suivant, et seul un
`preloading` sans limite garde l'enchaînement immédiat — ce que le bouton du
mode propose lui-même, dans le menu qu'il ouvre.

`activePlaybackSource` ne revient pas à `'queue'` sur la seule décision de
l'utilisateur : une playlist qui s'achève sans bouclage rend la main à la file
mise de côté, qui repart alors sur son premier titre
(`WebServer.advanceToQueue()`). La bascule est tentée aux deux points
d'épuisement — la file virtuelle du mode personnel et l'événement `emptyQueue`
du mode commun —, toujours après la relance en boucle : c'est cet ordre, et non
un test sur `loopPlaylist`, qui donne la priorité à la boucle. Une file mise de
côté vide laisse la lecture s'arrêter, comme auparavant.

Le sous-objet `preloading` (`enabled`, `queueCount`, `historyCount`,
`playlistCount`) est réglé depuis le tableau de bord mais **consommé côté
serveur** par [`PreloadManager.js`](../../../src/audio/PreloadManager.js) : la
valeur doit donc vivre ici, et non dans le seul `localStorage` du navigateur.

Les trois compteurs vont de 0 à 5, plus un dernier cran qui ne compte plus et
prend toute la section. Celui-ci s'enregistre comme **`-1`**, jamais comme la
position du curseur : celle-ci ne vaut que par rapport au maximum du jour, et
le jour où les curseurs gagneraient un cran, un `6` enregistré cesserait de
vouloir dire « tout » sans que rien ne le signale. Un compte négatif, lui, n'en
est un dans aucun monde. Il se relit comme `Infinity`, que les `slice(0, n)` et
`Math.min(n, …)` en aval traitent déjà correctement.

---

## Commandes npm

| Commande | Effet |
|---|---|
| `npm start` | Démarre le bot |
| `npm run dev` | Démarre avec `--watch` (redémarrage au changement de fichier) |
| `npm run deploy` | Enregistre les commandes slash auprès de Discord |
| `npm run update-ytdlp` | Met à jour yt-dlp — à faire quand le préchargement échoue en 403 |

### Déploiement des commandes

[`deploy-commands.js`](../../../src/deploy-commands.js) collecte les commandes de
`src/commands/` et les enregistre **globalement**. La propagation peut prendre
jusqu'à une heure. Pour un test immédiat, définir `GUILD_ID` dans `.env` : les
commandes sont alors enregistrées sur ce seul serveur, sans délai.

Ce script est à relancer à chaque ajout, suppression ou modification de la
signature d'une commande. Modifier seulement le corps d'une commande ne le
nécessite pas.

---

## Commandes Discord

| Commande | Options | Droits |
|---|---|---|
| `/play` | `query` — recherche, URL, ou chemin local | Tous |
| `/playlist` | `path`, `shuffle` | Tous |
| `/queue` | `page` | Tous |
| `/skip`, `/pause`, `/resume`, `/stop` | — | Tous |
| `/nowplaying` | — | Tous |
| `/volume` | `level` (0–100) | Tous |
| `/ducking toggle\|level\|delay\|fade\|status` | selon la sous-commande | Tous |
| `/broadcast` | `mode` — `everyone` ou `personal` | **Administrateur** |

Les vérifications de droits utilisent
[`utils/permissions.js`](../../../src/utils/permissions.js).

---

## Prérequis

- **Node.js 22.12 ou supérieur** — c'est le minimum de `@discordjs/voice` 0.19,
  et la version à partir de laquelle `require()` charge un module ESM, ce dont
  dépend `file-type` (voir `src/utils/fileTypeCompat.js`). Le champ `engines`
  de `package.json` le déclare, et le lanceur Windows le vérifie.
- **FFmpeg** — fourni par `ffmpeg-static`, aucune installation système requise.
- **yt-dlp** — fourni par `youtube-dl-exec`, utilisé en repli de résolution et
  pour l'extraction vidéo.

Les intentions Discord requises (`Guilds`, `GuildVoiceStates`, `GuildMessages`)
doivent être activées sur le portail développeur.
