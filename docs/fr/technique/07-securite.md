# 07 — Sécurité

[← Sommaire](README.md)

Le bot expose un serveur web qui pilote la lecture, lit des fichiers du disque et
peut arrêter le processus. Cette page décrit les protections en place et le
modèle de menace retenu.

---

## Modèle de menace

Le bot est conçu pour tourner sur la machine de son propriétaire. Le tableau de
bord n'a **pas** de gestion de comptes : un jeton unique donne accès à tout.

Ce qui est couvert :

- accès depuis une autre machine du réseau local ;
- lecture de fichiers arbitraires du disque via les routes média ;
- épuisement mémoire ou disque par une requête unique ;
- arrêt du processus par un tiers non authentifié.

Ce qui ne l'est pas :

- séparation de privilèges entre plusieurs utilisateurs du tableau de bord ;
- exposition directe sur Internet — placer le bot derrière un reverse proxy avec
  TLS si nécessaire ;
- protection contre un utilisateur légitime malveillant.

---

## Authentification

[`auth.js`](../../../src/web/auth.js) protège **HTTP et WebSocket**.

### Origine du jeton

`DASHBOARD_TOKEN` s'il est défini, sinon un jeton de 32 octets généré au premier
démarrage et enregistré dans `data/dashboard-token` (permissions `0600`). Il est
également affiché dans la console au démarrage.

### Pourquoi un cookie

Le tableau de bord charge ses médias par `<audio src>`, `<video src>` et des
liens de téléchargement. **Ces éléments ne peuvent pas porter d'en-tête
`Authorization`.** Le cookie est donc le seul vecteur qui fonctionne pour
l'ensemble des cas.

Il présente un avantage supplémentaire : le navigateur le transmet aussi lors du
handshake WebSocket same-origin, ce qui protège le WebSocket sans aucune
modification du code client.

### Parcours

```
GET /?token=<jeton>
   │
   ├─ jeton valide → pose le cookie (httpOnly, sameSite=lax, 1 an)
   │                 puis redirige vers l'URL sans le paramètre
   │
   └─ jeton absent ou invalide → 401 + page d'explication
```

Le retrait du jeton de l'URL évite qu'il subsiste dans la barre d'adresse,
l'historique ou l'en-tête `Referer`.

Trois sources sont acceptées, dans l'ordre : paramètre `token`, cookie
`dashboard_token`, en-tête `Authorization: Bearer`.

La comparaison utilise `crypto.timingSafeEqual`, pour ne pas révéler le jeton
octet par octet par mesure du temps de réponse.

### Placement du middleware

`auth.middleware` est monté **avant** `express.static`. Les fichiers du tableau
de bord sont donc protégés au même titre que les routes `/api`. Le WebSocket est
filtré par l'option `verifyClient` de `ws`.

---

## Restriction des chemins

[`utils/mediaPaths.js`](../../../src/utils/mediaPaths.js) décide quels fichiers
peuvent être servis.

### Le problème résolu

Les routes `/api/stream` et `/api/download` acceptaient un chemin brut du client
et le servaient s'il existait :

```js
if (fs.existsSync(decodedUrl)) {
    track = { url: decodedUrl, queryType: 'file', ... };
}
```

Une requête `?trackUrl=…/.env` retournait donc le jeton Discord. Toute lecture de
fichier passe désormais par `resolveMediaPath()`.

### Les trois conditions

Un chemin n'est accepté que s'il remplit **toutes** les conditions :

1. **extension média connue** — issue de `supportedExtensions` et
   `supportedVideoExtensions` de [`config.js`](../../../src/config.js) ;
2. **existence réelle**, résolue par `fs.realpathSync` — ce qui neutralise les
   liens symboliques pointant hors du périmètre ;
3. **localisation sous une racine autorisée**.

Sont également rejetés d'emblée les chemins contenant un octet nul (qui tronque
le chemin au niveau des appels système) et les URL distantes.

### Racines autorisées

| Racine | Origine |
|---|---|
| `data/uploads` | Fichiers importés |
| `data/cache` | Préchargement |
| `MEDIA_ROOTS` | Bibliothèques locales, séparées par `;` ou `,` |

Sans `MEDIA_ROOTS`, un fichier joué depuis `D:\Musique` sera **refusé au
streaming**. C'est un durcissement volontaire : élargir le périmètre est une
décision explicite de l'exploitant.

La comparaison est insensible à la casse sous Windows.

### Défense en profondeur

Le garde-fou est appliqué à deux niveaux : à la résolution de la piste demandée,
puis avant la lecture effective du fichier — y compris pour une piste provenant
de la file d'attente. Une piste dont le chemin est hors périmètre produit un
`403`, jamais une lecture.

---

## Plafonds

| Limite | Valeur | Raison |
|---|---|---|
| Charge utile WebSocket | 1 Mo | Le tableau de bord n'échange que de petits messages JSON |
| Corps JSON HTTP | 1 Mo | Idem ; les fichiers passent par `/api/upload` |
| Taille d'import | `MAX_UPLOAD_MB`, défaut 1024 Mo | Éviter qu'un seul POST remplisse le disque |
| Extensions d'import | Liste média | Refus en `415` |

L'import est plafonné **en cours de transfert** : le flux est interrompu dès le
dépassement et le fichier partiel supprimé, sans attendre la fin de la requête.

> Historiquement, la limite WebSocket était de **1 Go**, pour un message
> `uploadPlay` transportant des fichiers encodés en base64. Ce message n'était
> plus utilisé par le client ; il a été supprimé, ce qui a permis de ramener la
> limite à une valeur raisonnable.

---

## Exposition réseau

`HOST` vaut `127.0.0.1` par défaut : le tableau de bord n'est accessible que
depuis la machine hôte. Pour y accéder depuis un téléphone ou un autre poste,
définir `HOST=0.0.0.0` — l'authentification prend alors tout son sens. Un
avertissement est journalisé au démarrage dans ce cas.

---

## En cas de modification

- Ne jamais transmettre un chemin issu du client à `fs.createReadStream`,
  `fs.statSync` ou FFmpeg sans passer par `resolveMediaPath()`.
- Ne jamais monter une route avant `auth.middleware`.
- Un nouveau message WebSocket capable d'écrire sur le disque doit valider ses
  entrées : le routeur ne garantit que la présence de `data`.
