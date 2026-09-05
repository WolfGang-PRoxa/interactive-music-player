# 06 — Persistance

[← Sommaire](README.md)

Aucune base de données : tout est stocké en fichiers JSON dans `data/`, avec un
cache mémoire faisant autorité pendant l'exécution.

---

## Vue d'ensemble

| Fichier | Contenu | Rythme d'écriture |
|---|---|---|
| `data/settings.json` | Réglages par serveur + playlists globales | À chaque modification, regroupées sur 120 ms |
| `data/playback_state.json` | Dernier état de lecture connu | Toutes les 5 s et sur événement |
| `data/dashboard-token` | Jeton d'accès | Une fois, au premier démarrage |

> `better-sqlite3` figure en `optionalDependencies` mais **n'est jamais
> importé**. C'est un reliquat d'une approche abandonnée : la compilation native
> posait problème sous Windows.

---

## Écriture atomique

[`utils/atomicJson.js`](../../../src/utils/atomicJson.js) est le seul point
d'écriture JSON autorisé.

### Le problème résolu

`fs.writeFileSync` **tronque le fichier avant de le réécrire**. Une coupure
pendant cette fenêtre laisse un JSON incomplet, donc illisible. Le comportement
antérieur aggravait la perte : l'erreur d'analyse était interceptée, le cache
repartait vide, et le premier enregistrement suivant écrasait définitivement le
fichier corrompu.

### La séquence

```
1. écrire dans  .<nom>.<pid>.tmp   (même dossier, donc même système de fichiers)
2. fsync                            (garantir que les octets sont sur le disque)
3. rename  →  <nom>                 (opération atomique)
```

À tout instant, le fichier cible est soit l'ancienne version complète, soit la
nouvelle. Le `fsync` n'est pas optionnel : sans lui, le renommage peut précéder
l'écriture réelle des octets, et une coupure de courant laisse un fichier vide.

`renameSync` écrase bien une cible existante sous Windows, libuv utilisant
`MOVEFILE_REPLACE_EXISTING`.

### Lecture et mise en quarantaine

`readJsonSafe()` renomme un fichier illisible en `<nom>.corrompu-<date>` au lieu
de le laisser être écrasé. Le démarrage se poursuit sur les valeurs par défaut,
et le fichier reste récupérable.

`cleanStaleTemp()` supprime au démarrage les `.tmp` laissés par un arrêt brutal.

### Sérialisation

`createSafeReplacer()` gère les `BigInt` (convertis en chaîne) et les
références répétées. **Attention** : il écarte tout objet déjà rencontré, pas
seulement les cycles réels. C'est le comportement historique, conservé pour ne
pas modifier la sortie ; un objet légitimement présent à deux endroits serait
omis à sa seconde occurrence.

Le replacer conserve un état interne — il doit être créé pour **chaque**
sérialisation.

---

## Database

[`Database.js`](../../../src/database/Database.js) — singleton, réglages par
serveur et playlists globales.

### Structure du fichier

```json
{
  "__global__": {
    "playlists": [ { "id": "playlist_…", "name": "…", "tracks": [...] } ],
    "lastGuildId": "…",
    "lastVoiceChannelId": "…"
  },
  "<guildId>": { "duckingEnabled": true, "baseVolume": 70, ... }
}
```

Les playlists sont **globales**, communes à tous les serveurs. Une migration
automatique (`_migratePerGuildPlaylists`) déplace les playlists héritées d'un
stockage par serveur vers `__global__` au premier démarrage.

### Cache et écriture

Le cache `Map` fait autorité pendant l'exécution ; le fichier n'en est qu'une
projection. `_save()` **programme** une écriture regroupée sur 120 ms : une
rafale de modifications ne provoque qu'un seul passage sur disque.

`flush()` force l'écriture immédiate. Elle est branchée sur `process.on('exit')`,
ce qui couvre aussi les `process.exit()` de redémarrage et d'extinction — ces
chemins ne passent pas par `close()`.

### Lecture sans effet de bord

`getSettings()` renvoie `{ ...defauts, ...cache }` : les valeurs par défaut sont
réappliquées à chaque lecture, si bien qu'ajouter une clé à `_defaults()` suffit
pour que tous les serveurs existants en héritent.

Cette méthode **n'écrit pas** sur disque pour un serveur inconnu — elle le
faisait auparavant, alors qu'elle est appelée en boucle chaque seconde. L'entrée
est simplement mise en cache ; la première modification réelle la persistera.

### Méthodes principales

| Méthode | Effet |
|---|---|
| `getSettings(guildId)` | Réglages fusionnés avec les valeurs par défaut |
| `updateSettings(guildId, patch)` | Fusion et enregistrement différé |
| `getGlobalPlaylists()` | Liste des playlists |
| `createPlaylist`, `renamePlaylist`, `deletePlaylist`, `reorderPlaylists` | Gestion des playlists |
| `addTrackToPlaylist`, `removeTrackFromPlaylist`, `movePlaylistTrack` | Gestion des pistes |
| `toggleVoiceDetection`, `isVoiceDetectionDisabled` | Exclusions de ducking |
| `setLastVoiceChannel`, `getLastVoiceChannel` | Dernier salon visité |
| `applyStartupChannel()` | Fixe le salon d'ouverture — au démarrage seulement |

`updateSettings` applique une règle particulière : définir un salon favori
(`defaultVoiceChannelId`) le retire de tous les autres serveurs — il n'y a qu'un
favori global.

`applyStartupChannel()` est appelé une fois, à `ClientReady`. Il écrit le favori
dans le dernier salon visité à l'allumage, et le laisse de côté à la reprise —
un redémarrage doit ramener là où l'on était. Le lire ailleurs
en ferait une préférence permanente, qui ramènerait sans fin le bot et le tableau
de bord sur lui — voir
[Présence dans les salons vocaux](04-diffusion.md#présence-dans-les-salons-vocaux).

---

## PlaybackStateManager

[`PlaybackStateManager.js`](../../../src/database/PlaybackStateManager.js) —
instantané de lecture, pour reprendre là où l'on s'était arrêté.

### Contenu sauvegardé

Par serveur, l'état de **chaque salon** (`queue.channelStates`) : piste courante,
position, file d'attente, historique, mode de répétition, lecture ou pause.

### Rythme

Toutes les 5 secondes (minuteur d'[`index.js`](../../../src/index.js)) et à chaque
événement notable : démarrage et fin de piste, ajout, file vide, changement
d'état vocal du bot.

### Restauration

`restoreAll()` est appelée à `ClientReady`. Elle reconnecte le bot, recrée les
pistes (`new Track(...)` avec réassociation de l'extracteur par son
identifiant), puis reprend la lecture **en silence** :

```
restorePaused = true, volume = 0
        │
        ▼
  démarrer la lecture
        │
        ▼
  playerStart → seek(position sauvegardée)
        │
        ▼
  restaurer le volume, appliquer la pause si nécessaire
```

Sans cette précaution, l'utilisateur entendrait le début de la piste avant le
saut à la bonne position.

### Fondu de sortie

`fadeOutAndSaveState()` descend le volume en 35 paliers selon une courbe
exponentielle avant l'enregistrement final. Appelée sur `SIGINT` et sur
`shutdownBot`, elle évite la coupure sèche. La durée écoulée est ajoutée à
`virtualProgressMs` pour que la position sauvegardée reste juste.

---

## Stockage des imports

[`uploadService.js`](../../../src/web/uploadService.js) — voir aussi
[07 — Sécurité](07-securite.md).

### Nommage par empreinte

Les fichiers sont stockés sous `<empreinte12>-<nom original>`, où l'empreinte
est le préfixe de 12 caractères du SHA-256 du **contenu**. Réimporter un fichier
déjà présent réutilise l'exemplaire existant, sans copie supplémentaire.

Ce mécanisme corrige une accumulation observée : sans lui, un même morceau
réimporté produisait autant de copies que d'imports.

### Nommage différé

Le transfert transite par `.incoming-<pid>-<horodatage>-<aléa>`, renommé
seulement une fois complet. Un transfert interrompu ne laisse donc pas de média
tronqué dans la bibliothèque. Les orphelins d'un arrêt brutal sont purgés au
démarrage par `cleanIncomingUploads()`.

### Nom affiché

`getCleanFilename()` de [`utils/paths.js`](../../../src/utils/paths.js) retire le
préfixe technique. Il gère les deux formes : l'empreinte actuelle et
l'horodatage des fichiers importés avant la déduplication, toujours référencés
par les playlists existantes.
