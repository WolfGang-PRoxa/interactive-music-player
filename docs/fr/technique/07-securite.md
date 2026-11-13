# 07 — Sécurité

[← Sommaire](README.md)

Le bot expose un serveur web qui pilote la lecture, lit des fichiers du disque et
peut arrêter le processus. Cette page décrit les protections en place et le
modèle de menace retenu.

---

## Modèle de menace

Le bot est conçu pour tourner sur la machine de son propriétaire. Le jeton
d'accès y ouvre la page ; **il ne nomme personne**. Les droits sont attachés à
un compte Discord, et un compte sans droit voit un tableau de bord inerte.

Ce qui est couvert :

- accès depuis une autre machine du réseau local, ou depuis l'internet quand le
  tunnel est monté ([11 — Accès distant](11-acces-distant.md)) ;
- lecture de fichiers arbitraires du disque via les routes média ;
- épuisement mémoire ou disque par une requête unique ;
- arrêt du processus par un tiers non authentifié ;
- séparation de privilèges entre le maître de session et ses invités — un
  invité ne peut ni éteindre le bot, ni changer sa version, ni distribuer les
  droits.

Ce qui ne l'est pas :

- protection contre le maître de session lui-même : il peut tout, par
  construction ;
- protection contre un invité à qui l'on a accordé un droit dont il abuse — le
  retrait est le seul recours (`revokeControl`) ;
- confidentialité du contenu servi : une piste lisible par un invité est
  téléchargeable par lui.

---

## Authentification

[`auth.js`](../../../src/web/auth.js) protège **HTTP et WebSocket**.

### Le jeton ouvre, il ne nomme pas

Le jeton est unique et partagé : le porter prouve qu'on est devant la machine,
jamais qui l'on est. Le bot agissant sur des serveurs peuplés de gens réels, il
n'a aucune raison d'obéir à un anonyme.

Les droits sont donc attachés à une **session Discord**, jamais au jeton. Une
requête qui présente le jeton sans session obtient l'accès à la page — il faut
bien servir celle qui porte la fenêtre de connexion — et rien d'autre :
`identify()` rend `master: false` et lève `pendingLogin`, que le tableau de bord
traduit par une fenêtre qui ne se ferme pas
([`loginGate.js`](../../../src/web/public/js/loginGate.js)).

Le propriétaire est le premier compte revenu de Discord **en présentant le
jeton** ([`owner.js`](../../../src/web/owner.js)). Ce n'est pas un raccourci :
le jeton s'affiche dans la console de celui qui a lancé le bot, et le lien
d'invitation posté aux auditeurs ne le porte pas. La revendication est unique —
un second compte ne dépossède pas le premier, sans quoi le dernier arrivé
prendrait la main et le partage du contrôle n'existerait plus.

Le jeton est constaté à l'aller, sur `/auth/discord`, et la réponse voyage dans
le `state` OAuth. C'est nécessaire : le tableau de bord s'ouvre sur `127.0.0.1`
où son cookie est posé, tandis que Discord renvoie sur `PUBLIC_URL` — un tunnel,
un nom de domaine, une adresse de réseau local. Deux hôtes, deux bocaux à
cookies, et un rappel qui n'a pas le jeton. Le `state` est tiré au hasard, gardé
côté serveur et consommé une fois : y placer ce fait ne l'expose pas.

Une exception, et une seule : l'installation dont l'application Discord n'est
pas configurée ne *peut* recevoir aucune connexion. Le jeton y reprend son
ancien rôle. Refuser reviendrait à enfermer l'installateur hors de son propre
bot pour un secret manquant dans un fichier, ce qui ne protège personne.

La conséquence tient dans les replis : une socket arrivée sans identité est
traitée en invité sans droit, jamais en maître. Tant que le jeton faisait le
maître, ce repli était sans conséquence ; il ouvrirait maintenant tout à un
incident.

### Se souvenir d'un invité

Une session Discord dure trente jours et ne franchit pas la frontière entre deux
navigateurs. Un invité accepté devait donc recliquer « Se connecter » à chaque
venue, et — plus gênant — il *disparaissait de la fenêtre du maître* dès sa
session expirée : la liste des invités se lisait dans les sessions ouvertes,
alors que ses droits, eux, restaient inscrits dans les réglages.

Deux questions étaient mêlées, et les séparer suffit :

- **qui est cette personne ?** — le carnet
  ([`guests.js`](../../../src/web/guests.js)), écrit dans `data/guests.json`,
  qui ne dure pas moins que les droits qu'il accompagne ;
- **cet onglet est-il à elle ?** — la session
  ([`sessions.js`](../../../src/web/sessions.js)), avec la durée de vie courte
  que cela mérite.

Le carnet ne contient **aucun secret** : ni jeton, ni jeton d'accès Discord,
rien qui permette de se faire passer pour quelqu'un. Y figurer signifie « ce
compte s'est authentifié au moins une fois », jamais « ce compte a le droit
de… ». Un invité congédié en sort, sans quoi le refus n'en serait pas un.

La porte tente alors de reconnaître son visiteur avant de lui montrer un bouton.
L'essai passe par `prompt=none`, qui interdit à Discord d'afficher quoi que ce
soit : ou bien il reconnaît le compte et le renvoie identifié, ou bien il répond
`login_required` — une réponse normale, pas un incident — et la porte montre son
bouton comme avant.

L'essai ne se retente pas : le rappel revient avec `?login=manual`, doublé d'une
marque en `sessionStorage`. Sans cette mémoire, un échec relancerait un essai,
indéfiniment. Les deux traces sont nécessaires — le paramètre survit au
changement d'origine du rappel, le stockage survit au nettoyage de l'URL.

**Aucun droit n'est accordé au passage.** La reconnaissance muette répond à « qui
êtes-vous », jamais à « pouvez-vous entrer » : un compte qui n'est membre
d'aucun serveur du bot est refusé là comme ailleurs, et un invité reconnu
retrouve exactement les droits qu'on lui avait laissés, pas un de plus.

### Droits partagés

[`permissions.js`](../../../src/web/permissions.js) décide de ce qu'un invité a
le droit de faire. **Le contrôle est là, et nulle part ailleurs** : le tableau
de bord grise les commandes interdites, mais ce n'est qu'une politesse envers
l'invité — rien n'empêche d'ouvrir la console du navigateur et d'envoyer le
message à la main. La seule barrière qui compte est celle que le serveur oppose.

Un droit correspond à **un geste**, et se nomme `rubrique.geste`. Les quatre
rubriques ne sont plus qu'un rangement : elles donnent à la fenêtre de partage
ses sections et ses interrupteurs d'ensemble, elles ne décident de rien.

| Rubrique | Droits |
|---|---|
| `playback` | `transport`, `skip`, `seek`, `mode`, `source`, `speed`, `mix`, `loudness` |
| `queue` | `add`, `playNow`, `remove`, `reorder`, `history`, `download`, `clear` |
| `playlists` | `create`, `addTrack`, `removeTrack`, `reorderTracks`, `rename`, `organise`, `transitions`, `delete` |
| `volume` | `level`, `ducking`, `quality`, `trackGain`, `broadcast`, `channel` |

Ce grain fin est venu remplacer quatre droits d'ensemble, trop grossiers :
confier la file d'attente donnait du même geste le droit de la vider, et laisser
régler le volume laissait aussi changer de salon vocal. On ne pouvait pas dire
« ajoute ce que tu veux, mais n'efface rien », qui est pourtant la chose qu'on
veut dire le plus souvent. Le point de `rubrique.geste` n'est pas décoratif :
c'est à lui qu'on reconnaît un droit d'aujourd'hui d'un droit d'hier, ce qui
permet de relire sans broncher un `settings.json` écrit par une version
précédente.

Trois valeurs particulières complètent le catalogue :

- `ALWAYS` — les messages qui ne commandent rien (`requestState`, `clientLog`,
  `syncProgress`). Les refuser ne protégerait rien et laisserait le tableau de
  bord de l'invité aveugle. `syncProgress` porte pourtant la position que tous
  suivent : son handler n'écoute que le tableau de bord pilote, faute de quoi un
  invité sans droit déplacerait la lecture des autres.
- `FIELD_FILTERED` — `updateSettings`, dont chaque champ relève d'un droit
  différent. Le message passe, et `filterSettings()` ne garde que les réglages
  permis ; un invité sans droit voit sa demande vidée de tout contenu, ce que
  l'appelant traite comme un refus.
- `MASTER_ONLY` — dix-sept messages qui restent au maître : éteindre ou
  redémarrer le bot, changer sa version, le faire quitter un serveur, monter le
  tunnel, distribuer les droits eux-mêmes, répondre aux demandes de droit et les
  mettre en sourdine.

**Un message inconnu de la table est assimilé à `MASTER_ONLY`.** C'est
délibéré : une commande ajoutée plus tard sans y penser sera fermée par défaut
plutôt qu'ouverte à tous.

Les droits vivent dans les réglages du serveur, sous `sharedControl`
(voir [09 — Configuration](09-configuration.md#réglages-par-serveur)). Deux
gestes voisins ne disent pas la même chose et les confondre coûte cher :
`shareControl` avec un jeu vide décoche tout — l'invité reste admis, reconnu,
simplement sans pouvoir, et on peut lui rendre ses droits l'instant d'après ;
`revokeControl` congédie pour de bon — droits effacés, admission retirée,
sessions fermées, fiche du carnet supprimée.

Un invité peut **demander** un droit refusé par `requestRight`, ouvert à tous
puisque c'est précisément celui qui n'a pas le droit qui demande. Demander
n'accorde rien, et le handler trie : un invité reconnu et déjà admis, un droit
du catalogue qu'il n'a pas, pas de sourdine, pas de doublon, trois secondes au
moins entre deux demandes. Les demandes attendent dans les réglages du serveur,
sous `rightRequests`, et l'administrateur y répond par `answerRightRequest` —
accorder n'ajoute que le droit demandé. `muteRightRequests` met un invité en
sourdine, sous `mutedRightRequests`, et efface ce qu'il avait demandé ; un
invité congédié repart sans demandes ni sourdine.

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

### L'écriture, elle, n'est pas enfermée

[`utils/downloadDir.js`](../../../src/utils/downloadDir.js) garde le dossier où
la quatrième destination de la boîte d'ajout écrit ses fichiers, et il n'a pas
de racines autorisées. L'asymétrie est voulue, et vaut d'être énoncée plutôt que
subie :

- **`mediaPaths` protège la lecture.** Le risque y est de servir au client un
  fichier qu'il n'a pas à voir — d'où un périmètre fermé, et `.env` hors
  d'atteinte.
- **Le dossier de téléchargement est une cible.** Le risque n'est plus de
  divulguer mais d'écrire ailleurs qu'il ne faut. Or l'enfermer sous une racine
  autorisée reviendrait à retirer la fonction : quelqu'un qui range sa musique
  dans `D:\Musique` veut l'y télécharger.

Ce qui porte la sûreté est donc ailleurs. Le chemin choisi est validé avant
d'être retenu — il existe, c'est un dossier, il accepte l'écriture, il ne
contient pas d'octet nul —, le nom du fichier est dérivé du titre de la piste et
non fourni par le client, et l'écriture passe par un nom provisoire renommé au
seul succès. `GET /api/browse-dirs` laisse par ailleurs parcourir l'arborescence
de la machine hôte, ce qui est une capacité nouvelle.

Le tout se tient dans le modèle de menace ci-dessus : le bot tourne sur la
machine de son propriétaire, ces routes sont montées après `auth.middleware`, et
ce même tableau de bord peut déjà éteindre le processus. Un jeton dérobé n'ouvre
donc rien qu'il n'ouvrait déjà.

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

Le tableau de bord peut aussi être publié sur l'internet entier par un tunnel
Cloudflare. C'est le seul geste que le module concerné refuse de faire de
lui-même, même quand tout est prêt : l'ouvrir sans l'avoir demandé publierait
le lecteur de quelqu'un à son insu. Voir
[11 — Accès distant](11-acces-distant.md).

---

## En cas de modification

- Ne jamais transmettre un chemin issu du client à `fs.createReadStream`,
  `fs.statSync` ou FFmpeg sans passer par `resolveMediaPath()`.
- Ne jamais monter une route avant `auth.middleware`.
- Un nouveau message WebSocket capable d'écrire sur le disque doit valider ses
  entrées : le routeur ne garantit que la présence de `data`.
