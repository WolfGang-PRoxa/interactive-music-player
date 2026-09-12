# 10 — Versions

[← Sommaire](README.md)

Le bot sait lister les releases publiées sur GitHub, en installer une à côté de
celle qui tourne, et basculer de l'une à l'autre sans qu'aucun réglage ni
aucune playlist ne bouge. Tout tient dans
[`src/versioning/`](../../../src/versioning/), cinq modules et aucune
dépendance ajoutée.

---

## Deux racines

C'est l'idée dont tout le reste découle. En développement, elles se confondent ;
dès qu'une release est installée, elles se séparent.

| Racine | Contenu | Valeur |
|---|---|---|
| Racine **partagée** | `.env`, `data/`, `node_modules/`, `versions/` | `process.cwd()` |
| Racine **d'installation** | le code exécuté | le dépôt, ou `versions/<tag>/` |

Tous les modules du bot résolvent leurs données depuis `process.cwd()` —
`Database`, `auth`, `mediaPaths`, `uploadService` : c'est la racine partagée qui
décide où sont les playlists, les réglages et le jeton du tableau de bord.

Changer de version revient donc à exécuter `versions/<tag>/src/index.js` **en
laissant `cwd` sur la racine partagée** : le code change, les données non.

```
racine partagée/                 ← process.cwd(), et donc les données
├── .env
├── data/                        réglages, playlists, cache, journaux
├── node_modules/                dépendances, vues par toutes les versions
├── src/                         le dépôt de développement — tag « dev »
└── versions/
    ├── v1.4.0/
    │   ├── .imp-version.json    marqueur d'intégrité
    │   └── src/index.js         ← racine d'installation quand cette version tourne
    └── v1.5.0/
```

Node remontant les dossiers parents à la recherche de `node_modules`, une
release imbriquée dans la racine partagée **hérite au passage de ses dépendances
sans la moindre copie**. Il n'est donc rien installé tant que la release réclame
les mêmes paquets que la racine ; un `npm install` local n'a lieu que lorsque la
liste diverge, et il reste alors confiné au dossier de la version.

[`locations.js`](../../../src/versioning/locations.js) est le seul module à
savoir tout cela, et le seul habilité à dire si un dossier peut être écrasé ou
supprimé. `assertTargetInstallable()` et `assertTargetRemovable()` sont les
garde-fous qui mettent le dépôt de développement — et la version en cours
d'exécution — hors d'atteinte de l'installateur comme de la désinstallation.

`IMP_VERSIONS_DIR` permet de déporter `versions/` ailleurs, sur un disque
secondaire ou hors du dépôt. Le garde-fou vérifie tout de même qu'il ne recouvre
pas le dépôt de développement, quelle qu'en soit la valeur.

---

## Quelle version tourne

`currentVersion()` rend `{ type, tag, packageVersion }`, où `type` vaut `dev` ou
`release`. Il ne le devine pas : il lit le marqueur `.imp-version.json` déposé à
la racine de chaque version installée. Le marqueur sert deux fois — il nomme la
version, et son absence signale une extraction inachevée.

La valeur est exposée de trois façons : la bannière du journal au démarrage, la
route `GET /api/version`, et le pied du tiroir du tableau de bord — d'où elle se
copie d'un geste.

---

## Le catalogue

`catalog()` assemble ce que le menu déroulant affiche : les releases publiées,
celles qui sont déjà sur le disque, et celle qui tourne.

**L'échec de l'appel à GitHub n'est pas une erreur fatale.** Il est rapporté
dans `error` et le catalogue reste utilisable, réduit aux versions déjà
présentes sur le disque. Hors ligne, on peut donc toujours revenir à une version
installée ou au développement.

Une version installée dont la release a disparu du dépôt reste lançable : elle
est marquée `orphan` et figure quand même dans la liste. Elle est sur le disque,
et l'utilisateur doit pouvoir y revenir.

[`github.js`](../../../src/versioning/github.js) interroge l'API publique. Le
dépôt public se consulte **sans identifiant** : c'est le mode nominal, et rien
n'est à configurer. Un jeton reste accepté s'il est trouvé — dans `GITHUB_TOKEN`,
puis `GH_TOKEN`, puis auprès du CLI `gh` s'il est installé et connecté —, ce qui
couvre le dépôt encore privé et relève le quota horaire de 60 à 5 000 requêtes.

Le cache des releases ne dure que vingt secondes, et le menu force sa relecture
en s'ouvrant : il doit refléter les releases publiées à l'instant où
l'utilisateur le déroule, pas celles de sa précédente ouverture.

---

## Installer

Règle directrice : **rien de déjà en place n'est jamais écrasé.** Chaque release
vit dans son propre dossier `versions/<tag>/`, et une installation ne touche à
aucun autre.

```
listReleases()  ──►  archive .tar.gz  ──►  .tmp-<aléa>/  ──►  versions/<tag>/
                     (300 Mo au plus)      extraction        renommage final
                                                │
                                                └─ npm install, seulement si la
                                                   liste des paquets diverge
```

Trois conséquences de cette règle :

- une version déjà installée n'est pas retéléchargée : on se contente de la
  relancer, ce qui met la version en cours d'exécution à l'abri de sa propre
  réinstallation ;
- le dépôt de développement n'est pas une cible possible — `locations` le refuse
  avant la moindre écriture ;
- l'extraction se fait dans un dossier temporaire, renommé vers sa destination
  définitive une fois complet. Un téléchargement interrompu ne laisse donc
  jamais une version à moitié installée, mais un `.tmp-…` que le démarrage
  suivant balaie (`cleanTempDirs()`, appelé à `ClientReady`).

Une installation à la fois : deux téléchargements concurrents viseraient le même
dossier temporaire et se disputeraient le redémarrage. L'opération rend compte
de son avancement au fil de l'eau, pour que le tableau de bord montre autre
chose qu'un écran figé.

### Extraction sans dépendance

[`targz.js`](../../../src/versioning/targz.js) décompresse l'archive en mémoire
d'un bloc, puis la parcourt bloc de 512 octets par bloc de 512 octets. Cela
évite d'ajouter une bibliothèque au projet, et surtout de dépendre d'un `tar`
système dont ni la présence ni le dialecte ne sont garantis d'une machine à
l'autre.

Deux points méritent l'attention :

- **les noms longs.** Le format ustar loge un nom sur 100 octets, complétés par
  un préfixe de 155. Au-delà, l'archiveur émet une entrée porteuse du nom réel
  juste avant l'entrée qu'elle décrit : `L` chez GNU, `x` (en-tête pax) chez les
  autres. GitHub emploie les deux selon les dépôts, donc les deux sont gérés ;
- **la traversée de chemin.** Une entrée nommée `../../autre` sortirait du
  dossier de destination. Chaque chemin est donc résolu puis vérifié comme
  descendant strict de la destination avant la moindre écriture.

---

## Basculer

`resolveEntryPoint(tag)` traduit un choix de l'utilisateur en fichier à lancer,
et refuse une version qui n'est pas disponible localement.

La bascule elle-même emprunte le redémarrage ordinaire
(`restartProcess` de
[`systemHandlers.js`](../../../src/web/websocket/handlers/systemHandlers.js)) :
le nouveau processus est lancé **détaché**, avec `IMP_RESTART=1` dans son
environnement, et l'ancien s'éteint. Cette variable marque une reprise et non un
allumage — ce qui supprime le fondu d'ouverture et fait ignorer le salon favori
au profit du dernier salon visité (voir
[06 — Persistance](06-persistance.md#database)).

Les trois messages WebSocket du domaine — `listVersions`, `installVersion`,
`uninstallVersion` — sont **réservés au maître de session**. Changer la version
qui tourne n'est pas une commande de lecture qu'on partage. Voir
[07 — Sécurité](07-securite.md#droits-partagés).

---

## En cas de modification

- Ne jamais résoudre un chemin de données depuis `__dirname` : ce serait la
  racine d'installation, et une release installée écrirait ses réglages dans son
  propre dossier au lieu de la racine partagée.
- Toute écriture ou suppression visant `versions/` doit passer par
  `assertTargetInstallable()` ou `assertTargetRemovable()`.
- Un nouveau champ du catalogue doit rester lisible hors ligne : le menu
  fonctionne sans GitHub, et c'est une propriété à ne pas perdre.
