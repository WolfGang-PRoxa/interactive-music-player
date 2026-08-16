# 02 — Lecture audio

[← Sommaire](README.md)

Cette page couvre la chaîne qui va d'une requête utilisateur au flux Opus émis
dans le salon vocal, ainsi que le cache de préchargement.

---

## Chaîne de traitement

```
requête ──► extracteur ──► flux ──► FFmpeg ──► Opus ──► UDP Discord
            (résolution)   (HTTP    (filtres,  (encodage)
                            ou       volume)
                            fichier)
```

Le projet ne manipule pas l'audio lui-même : il configure
[discord-player](https://discord-player.js.org/), qui orchestre FFmpeg et
`@discordjs/voice`. Le binaire FFmpeg provient du paquet `ffmpeg-static`, ce qui
évite toute installation système.

---

## Extracteurs

Enregistrés au démarrage dans [`index.js`](../../src/index.js) :

| Extracteur | Source | Remarque |
|---|---|---|
| `YoutubeiExtractor` | YouTube | Configuré avec `useYoutubeDL: false` |
| `SpotifyExtractor` | Spotify | Métadonnées seules, audio repris depuis YouTube |
| `SoundCloudExtractor` | SoundCloud | |
| `AppleMusicExtractor` | Apple Music | Métadonnées seules |
| `AttachmentExtractor` | Fichiers locaux et pièces jointes | Utilisé pour les imports |

> **Deezer et Qobuz ne sont pas pris en charge**, malgré les variables présentes
> dans `.env.example`. Aucun extracteur correspondant n'est installé ni
> enregistré. Ces variables sont un reliquat.

### Résolution d'une requête

`searchLocalAwareTrack()` dans
[`handlerUtils.js`](../../src/web/websocket/handlerUtils.js) encapsule la
recherche :

1. Si la requête pointe vers un fichier existant → recherche forcée en
   `QueryType.FILE`.
2. Les URL `music.youtube.com` sont réécrites en `www.youtube.com`, non résolues
   autrement par l'extracteur.
3. Si aucun résultat et que l'URL est de type YouTube, repli sur **yt-dlp**
   (`youtube-dl-exec`) en mode `flatPlaylist`, puis résolution piste par piste.
   Ce chemin couvre les albums YouTube Music (`OLAK5uy_…`).
4. Pour un fichier local, le titre est remplacé par le nom de fichier nettoyé de
   son préfixe technique.

---

## Vitesse de lecture

FFmpeg limite le filtre `atempo` à l'intervalle `[0.5, 2.0]`. Pour couvrir
0,20× à 3,05×, [`index.js`](../../src/index.js) enregistre 286 filtres nommés
`speed_<valeur>` en chaînant deux `atempo` hors de cet intervalle :

```js
si vitesse < 0.5   →  atempo=0.5,atempo=(v / 0.5)
si vitesse > 2.0   →  atempo=2.0,atempo=(v / 2.0)
sinon              →  atempo=v
```

Le nom du filtre encode la valeur avec un underscore : `1.25` devient
`speed_1_25`. La vitesse retenue est persistée dans les réglages
(`playbackSpeed`) et **réappliquée à chaque `playerStart`**, car les filtres
FFmpeg sont réinitialisés à chaque nouvelle piste.

Un filtre supplémentaire, `muffled` (`lowpass=f=400`), sert aux transitions de
type DJ.

---

## Fondus et enchaînements

Trois mécanismes distincts agissent sur le volume, tous via
[`VolumeController`](../../src/audio/VolumeController.js) lorsqu'il est
disponible.

### Fondu d'entrée

Déclenché dans `playerStart` si `fadeinEnabled` ou `mixEnabled` est actif. Le
volume part de 0 et rejoint `baseVolume` sur `fadeinDuration` secondes. Le
verrou `queue.mixAppliedTrackId` évite d'appliquer deux fois le fondu à la même
piste.

### Fondu de sortie

Appliqué à l'arrêt (`shutdownBot`) et à l'extinction du processus, par
`fadeOutAndSaveState()` dans
[`PlaybackStateManager.js`](../../src/database/PlaybackStateManager.js) : 35
paliers, courbe exponentielle (`facteur^2.5`) pour une décroissance perçue comme
linéaire.

### Enchaînement type DJ

En diffusion personnelle, le fondu enchaîné est mené par le navigateur, qui
dispose de deux éléments `<audio>` et peut donc les superposer.

En diffusion commune, c'est le **bus de mixage** qui s'en charge (voir la
section suivante). Quand le temps restant sur la piste passe sous `mixDuration`
secondes, le morceau suivant est versé dans le bus par-dessus le courant :

- `mixType: 'volume'` → les deux gains se croisent selon une loi de puissance
  constante ;
- `mixType: 'effects'` → **plus** un balayage de passe-bas, qui referme le
  morceau sortant vers 400 Hz pendant que l'entrant s'ouvre.

---

## Bus de mixage (diffusion commune)

Une connexion vocale Discord ne porte qu'un flux : deux morceaux ne peuvent pas
s'y superposer si le second ne peut exister qu'en remplaçant la ressource audio
du premier. C'est pourquoi l'enchaînement mix était longtemps refusé en
diffusion commune.

[`src/audio/mix/`](../../src/audio/mix/) lève cette limite en interposant un
flux unique et permanent entre les morceaux et Discord :

```
piste A ──► FFmpeg ──► PCM ──┐
                             ├──► MixBus ──► AudioResource ──► Opus ──► UDP
piste B ──► FFmpeg ──► PCM ──┘   (somme,     (permanente)
 (pendant la transition)          gains)
```

| Module | Rôle |
|---|---|
| [`format.js`](../../src/audio/mix/format.js) | Format d'échange : PCM s16le, 48 kHz, stéréo, trames de 20 ms |
| [`entree.js`](../../src/audio/mix/entree.js) | Ramène une piste à une entrée FFmpeg (cache, fichier local, extracteur) |
| [`MixSource.js`](../../src/audio/mix/MixSource.js) | Un morceau décodé : tampon, enveloppe de gain, balayage de filtre |
| [`MixBus.js`](../../src/audio/mix/MixBus.js) | Le flux permanent : somme les sources trame par trame |
| [`MixEngine.js`](../../src/audio/mix/MixEngine.js) | Orchestration par serveur, pilotage de la file discord-player |
| [`pontLecteur.js`](../../src/audio/mix/pontLecteur.js) | Enveloppe les méthodes de `GuildQueuePlayerNode` pour les router vers le bus |

**Horloge.** Le bus ne produit une trame que lorsque le lecteur vocal en réclame
une, soit toutes les 20 ms. Toutes les sources avancent donc du même nombre exact
d'échantillons à chaque tour : aucune dérive ne peut s'installer entre deux
morceaux superposés, quelle que soit la durée du fondu. Si une source manque de
données, le bus s'arrête entièrement plutôt que de combler l'une d'elles avec du
silence — un accroc coûte un blanc, jamais un décalage.

**Transparence.** Hors fondu, avec une seule source à plein gain et un volume
nominal, les octets décodés sont transmis sans aucune arithmétique : le son
diffusé est exactement celui que FFmpeg a produit.

**Position de lecture.** Le bus fabrique ses trames dès qu'on lui en demande, et
l'encodeur Opus en garde d'avance : ce qui est fabriqué n'est pas ce qui
s'entend. `MixEngine.positionMs()` retranche donc cette avance, mesurée en
comparant les trames fabriquées à `AudioResource.playbackDuration`, qui ne
compte que les paquets réellement émis. Sans cette correction, la barre de
progression bondissait au démarrage — la chaîne se remplit de plusieurs secondes
en un instant — puis faisait du sur place le temps que la lecture rattrape.

**Répartition des rôles.** discord-player conserve la file d'attente,
l'historique, les modes de répétition et ses événements. Le moteur lui signale
la fin d'un morceau en émettant sur son répartiteur les mêmes signaux qu'une fin
de ressource aurait produits, et lui présente une `AudioResource` permanente que
`queue.currentTrack` continue de consulter. Tout ce qui passait par la chaîne
FFmpeg de discord-player est en revanche repris par le bus : volume et ducking
(gain maître), pause, repositionnement, vitesse de lecture, et la position de
lecture — désormais comptée en échantillons émis plutôt qu'estimée.

**Repli.** `moteurActif()` rend `null` quand aucun bus n'est monté, et chaque
méthode enveloppée retombe alors sur l'implémentation d'origine. La diffusion
personnelle, où le son sort du navigateur, ne monte jamais de bus.

---

## Préchargement

[`PreloadManager`](../../src/audio/PreloadManager.js) télécharge et transcode à
l'avance les pistes distantes en MP3 dans `data/cache/`, pour trois raisons :
démarrage instantané, résistance aux coupures réseau, et alimentation du
lecteur audio du navigateur en mode personnel.

### Interception

À l'initialisation, la méthode `stream()` de chaque extracteur enregistré est
remplacée :

```js
extractor.stream = async (track, ...args) => {
    const cachedPath = this.getCachedPath(track);
    if (cachedPath) return fs.createReadStream(cachedPath);
    return originalStream.apply(extractor, [track, ...args]);
};
```

Toute lecture d'une piste déjà en cache est donc servie depuis le disque, sans
requête réseau, de façon transparente pour discord-player.

### Nommage et validité

La clé est le **SHA-256 de l'URL** de la piste, et le fichier
`data/cache/<clé>.<débit>.mp3` (`<clé>.mp3` pour les fichiers antérieurs au
choix de qualité, dont le débit est inconnu). Un fichier de moins de 10 Ko est
considéré comme incomplet et ignoré. Les fichiers locaux ne sont jamais mis en
cache (`getTrackKey()` renvoie `null`).

Un téléchargement en cours écrit dans `<clé>.<débit>.tmp`, accompagné de
`<clé>.<débit>.tmp.src` qui mémorise l'URL réellement encodée. Le fichier n'est
renommé en `.mp3` qu'une fois complet et validé.

### Sélection des cibles

`getActivePreloadTracks()` construit la liste à précharger :

| Source | Quantité (réglable, max 5) |
|---|---|
| Piste courante | toujours |
| Prochaines pistes de la file | `preloading.queueCount` (défaut 3) |
| Début de la file mise de côté par une playlist | `preloading.queueCount` (défaut 3) |
| Pistes récentes de l'historique | `preloading.historyCount` (défaut 3) |
| Suite de la playlist active | `preloading.playlistCount` (défaut 3) |
| Début de **chaque** playlist enregistrée | `preloading.playlistCount` (défaut 3) |

Le lecteur n'a qu'une liste de pistes physique : quand une playlist l'occupe,
c'est elle que `session.getTracks()` rend, et la file d'attente de l'utilisateur
est mise de côté dans les réglages (voir
[setAsideQueue](../../src/utils/setAsideQueue.js)). Le préchargement va donc
l'y chercher, sans quoi elle perdrait son cache dès qu'une playlist démarre.
C'est une simple liste, la même dans les deux modes de diffusion et la même que
celle affichée par le panneau : la fenêtre `queueCount` porte donc exactement sur
les titres annoncés.

L'historique est rendu de la piste la plus récente à la plus ancienne — l'ordre
d'une file LIFO, et celui du panneau. Ce sont donc ses **premiers** titres qu'il
faut retenir : les seuls qu'un retour en arrière atteindra.

Les deux dernières lignes s'ajoutent, elles ne s'excluent pas : le préchargement
d'une playlist ne dépend pas de ce qui joue. Lancer une playlist ne doit pas
vider le cache des autres — les rejoindre coûterait alors un rechargement
complet, et la lecture démarrerait sur une coupure. La playlist en cours est
évaluée en premier : ce sont ses titres à venir qu'il faut avoir sous la main
d'abord.

Les doublons entre ces sources sont sans effet : `update()` indexe les cibles
par clé de piste avant d'agir.

### Cycle de mise à jour

`update(guildId)` est appelée à chaque diffusion d'état. Elle :

1. compare la liste des cibles à la précédente et sort immédiatement si elle est
   identique — c'est ce qui rend l'appel supportable à la seconde. Sauf si l'une
   des cibles n'est ni en cache ni en cours de téléchargement : un échec réseau
   ou un transcodage interrompu la laisserait sinon manquante jusqu'au prochain
   remaniement de la file, c'est-à-dire jamais sur une file stable. La relance
   respecte un délai qui double à chaque échec (30 s, puis 1 min… plafonné à
   15 min), pour qu'une URL morte ne soit pas reprise à chaque seconde ;
2. annule les téléchargements devenus hors cible, sauf ceux démarrés depuis
   moins de 5 secondes (protection contre les annulations prématurées) ;
3. supprime les fichiers de cache qui ne sont cibles pour **aucun** serveur,
   ainsi que les fichiers partiels devenus inutiles (piste hors cible, ou piste
   désormais entièrement cachée) ;
4. lance les téléchargements manquants.

La progression est remontée au tableau de bord par le rappel
`preloadManager.onProgress`, limité à un envoi toutes les 150 ms.

### Reprise après redémarrage

Les fichiers partiels étaient supprimés au démarrage : un préchargement
interrompu à 95 % repartait de zéro, et sur les longues pistes un rythme normal
de redémarrages suffisait à ce qu'elles ne se cachent jamais. Ils sont
désormais conservés et complétés.

Un MP3 n'est qu'une suite de trames indépendantes, chacune précédée d'un
en-tête de 4 octets qui porte sa propre longueur.
[`analyzePartial()`](../../src/utils/mp3.js) les parcourt pour déterminer
jusqu'à quel octet le fichier est intègre — la dernière trame est presque
toujours amputée, le processus ayant été tué en pleine écriture — et à quelle
position temporelle cet octet correspond.

`startDownload()` tronque alors le partiel sur cette frontière de trame, lance
FFmpeg avec `-ss <position>` **avant** `-i` (sur une URL directe, le début
n'est même pas retéléchargé) et ajoute le résultat à la suite du fichier. Le
raccord est exact à l'échantillon près. Deux options sont nécessaires :
`-id3v2_version 0` et `-write_xing 0`, sans quoi chaque segment encodé
s'ouvrirait sur une étiquette ID3 qui se retrouverait en plein milieu du
fichier.

Deux garde-fous encadrent la reprise :

- **Source vérifiée.** La clé dérive de l'URL *demandée*, pas de celle qui a
  fini par être encodée : un titre Spotify est ponté vers YouTube, et rien ne
  garantit que la recherche retombe sur la même vidéo. Le partiel n'est repris
  que si `.tmp.src` correspond à l'URL résolue ; sinon il est réencodé de zéro.
- **Complétude vérifiée.** Un flux qui se rompt laisse FFmpeg terminer
  proprement sur ce qu'il a reçu : la taille du fichier ne dit plus s'il est
  entier, puisqu'un partiel repris dépasse forcément le minimum. La durée
  encodée est comparée à la durée annoncée par la piste (95 % de tolérance) ;
  en deçà, le fichier reste un partiel au lieu d'être promu en cache.

Un échec conserve donc ce qui a été encodé, pour la tentative suivante. Une
annulation (piste devenue hors cible) supprime au contraire le partiel, au même
titre que la purge retire son fichier de cache.

### Plafond de taille

La purge par pertinence ne suffit pas : elle ne retire que les pistes qui ne
sont cibles pour aucun serveur. Avec plusieurs playlists volumineuses,
l'ensemble des cibles peut à lui seul dépasser toute limite raisonnable.

`enforceCacheLimit()` ramène le cache sous `MAX_CACHE_MB` (2048 Mo par défaut)
en évinçant les fichiers **les plus anciens d'abord**, à l'exception des pistes
en cours de lecture — protégées explicitement pour ne pas provoquer un
re-téléchargement immédiat.

L'index mémoire `cacheIndex` (clé → `{ size, mtime }`) permet d'appliquer le
plafond sans réinterroger le système de fichiers. Il est reconstruit au
démarrage, puis tenu à jour à chaque téléchargement terminé et à chaque purge.

Si le plafond est dépassé alors que **toutes** les pistes sont protégées, un
avertissement est journalisé et rien n'est supprimé : mieux vaut dépasser
temporairement que couper une lecture en cours.

---

## Fichiers locaux

[`LocalFilePlayer`](../../src/audio/LocalFilePlayer.js) fournit le scan de
dossiers utilisé par la commande `/playlist` : parcours récursif, filtrage sur
`config.supportedExtensions`, tri par nom, mélange Fisher-Yates optionnel.

Les extensions reconnues sont déclarées dans
[`config.js`](../../src/config.js) : `supportedExtensions` pour l'audio,
`supportedVideoExtensions` pour la vidéo. Ces listes servent aussi au garde-fou
de sécurité des chemins ([07 — Sécurité](07-securite.md)).
