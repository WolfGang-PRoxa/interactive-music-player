# 09 — Configuration

[← Sommaire](README.md)

---

## Deux niveaux de configuration

| Niveau | Fichier | Modifiable à chaud |
|---|---|---|
| Environnement | `.env` | Non — redémarrage requis |
| Constantes applicatives | [`src/config.js`](../../src/config.js) | Non — valeurs par défaut au code |
| Réglages par serveur | `data/settings.json` | Oui — commandes ou tableau de bord |

`config.js` ne contient que des **valeurs par défaut** : dès qu'un serveur est
connu, ses réglages effectifs vivent dans `settings.json` (voir
[06 — Persistance](06-persistance.md)).

---

## Variables d'environnement

Copier `.env.example` vers `.env` et renseigner au minimum `DISCORD_TOKEN`.

### Discord

| Variable | Requis | Rôle |
|---|---|---|
| `DISCORD_TOKEN` | **Oui** | Jeton du bot. Son absence interrompt le démarrage. |
| `DISCORD_CLIENT_ID` | Pour `npm run deploy` | Identifiant de l'application |

### Tableau de bord

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | `3000` | Port d'écoute |
| `HOST` | `127.0.0.1` | Interface d'écoute. `0.0.0.0` pour exposer au réseau local. |
| `DASHBOARD_TOKEN` | généré | Jeton d'accès. Si vide, généré et enregistré dans `data/dashboard-token`. |

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
[`VolumeController`](../../src/audio/VolumeController.js).

`presence.enabled` à `false` rend au bot son ancien comportement : il reste
connecté en permanence, salon vide ou non. Voir
[04 — Modes de diffusion](04-diffusion.md#présence-dans-les-salons-vocaux).

`presence.departureDelay` n'est qu'une valeur de repli : chaque serveur fixe la
sienne depuis le tableau de bord (*Paramètres → Paramètres du bot → Délai avant
de quitter un salon vide*), enregistrée par serveur sous `presenceDepartureDelay`
— **en secondes**, l'unité du curseur, que `PresenceManager._delaiDepart()`
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
[`Database.js`](../../src/database/Database.js). Ajouter une clé ici suffit :
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
| `fadeinEnabled` | `false` | Fondu d'entrée |
| `fadeinDuration` | `5` | Secondes |
| `fadeoutEnabled` | `true` | Fondu de sortie à l'extinction |
| `fadeoutDuration` | `5` | Secondes |
| `ignoredVoiceUsers` | `{}` | Exclusions de ducking, par salon |
| `activePlaybackSource` | `'queue'` | `'queue'` ou identifiant de playlist |
| `playlistCurrentIndex` | `0` | Position dans la playlist active |
| `queueBackupPersonal` | `null` | File mise de côté, écrite en mode personnel |
| `queueBackupEveryone` | `null` | File mise de côté, écrite en mode commun |

Les deux dernières clés portent **la même** file d'attente — celle qu'une
playlist a mise de côté —, rangée sous celle du mode de diffusion courant ;
l'autre est effacée. Tout passe par
[`setAsideQueue`](../../src/utils/setAsideQueue.js) : une simple liste de
pistes, `{ pistes: [...] }`, dans laquelle rien n'est « courant » puisque rien
n'en joue tant que la playlist occupe le lecteur. Ces clés portaient auparavant
deux formes distinctes, et changer de mode faisait lire l'interface dans une
sauvegarde vide — la file paraissait perdue. Les anciennes formes
(`{ tracks }`, `{ virtualCurrentTrack, virtualTracks }`) restent acceptées en
lecture.

`activePlaybackSource` ne revient pas à `'queue'` sur la seule décision de
l'utilisateur : une playlist qui s'achève sans bouclage rend la main à la file
mise de côté, qui repart alors sur son premier titre
(`WebServer.enchainerSurLaFile()`). La bascule est tentée aux deux points
d'épuisement — la file virtuelle du mode personnel et l'événement `emptyQueue`
du mode commun —, toujours après la relance en boucle : c'est cet ordre, et non
un test sur `loopPlaylist`, qui donne la priorité à la boucle. Une file mise de
côté vide laisse la lecture s'arrêter, comme auparavant.

Le sous-objet `preloading` (`enabled`, `queueCount`, `historyCount`,
`playlistCount`) n'est pas déclaré dans `_defaults()` : il est écrit par le
tableau de bord et lu avec des valeurs de repli dans
[`PreloadManager.js`](../../src/audio/PreloadManager.js).

---

## Commandes npm

| Commande | Effet |
|---|---|
| `npm start` | Démarre le bot |
| `npm run dev` | Démarre avec `--watch` (redémarrage au changement de fichier) |
| `npm run deploy` | Enregistre les commandes slash auprès de Discord |

### Déploiement des commandes

[`deploy-commands.js`](../../src/deploy-commands.js) collecte les commandes de
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
[`utils/permissions.js`](../../src/utils/permissions.js).

---

## Prérequis

- **Node.js 18 ou supérieur** — le projet utilise `fs.promises`, l'opérateur de
  chaînage optionnel et `structuredClone` indirectement via ses dépendances.
  Aucun champ `engines` n'est déclaré dans `package.json`.
- **FFmpeg** — fourni par `ffmpeg-static`, aucune installation système requise.
- **yt-dlp** — fourni par `youtube-dl-exec`, utilisé en repli de résolution et
  pour l'extraction vidéo.

Les intentions Discord requises (`Guilds`, `GuildVoiceStates`, `GuildMessages`)
doivent être activées sur le portail développeur.
