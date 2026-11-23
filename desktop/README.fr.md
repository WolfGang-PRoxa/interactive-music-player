[English](README.md) · **Français**

# Application de bureau

Le bot, empaqueté en application Windows et Linux : un installeur, une icône
dans la zone de notification, et le tableau de bord dans sa propre fenêtre.

Le bot reste ce qu'il est : un serveur Node. L'application le lance, le garde et
l'arrête, mais le tableau de bord s'ouvre toujours dans n'importe quel
navigateur — sur ce PC à `http://localhost:3000`, ou depuis un téléphone, un
autre ordinateur, un invité, exactement comme avant.

---

## Ce qu'elle fait

|                                   |                                                                                                                   |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Aucun prérequis**               | Node.js est embarqué ; l'installeur apporte le bot et toutes ses dépendances                                      |
| **Première configuration guidée** | Coller le jeton suffit : il est vérifié auprès de Discord, `.env` est écrit, l'invitation préparée                |
| **Ouverture immédiate**           | La fenêtre du tableau de bord paraît dès le lancement ; ce qui demande Discord dit d'attendre la fin du démarrage |
| **Zone de notification**          | Fermer la fenêtre ne coupe rien : le bot continue, l'icône permet de rouvrir, redémarrer, éteindre                |
| **Redémarrage et versions**       | L'application démarre toujours la version installée la plus récente ; redémarrage et bascule passent par elle     |
| **Démarrage avec la session**     | À cocher dans le menu de l'icône : le bot démarre en arrière-plan, sans fenêtre                                   |
| **Une seule instance**            | Rouvrir l'application montre celle qui tourne déjà                                                                |

Il n'y a plus de fenêtre de lancement : l'application s'ouvre directement sur
le tableau de bord. Pendant la seconde ou deux où le serveur du bot ne répond
pas encore, la fenêtre montre une page d'attente ; puis le tableau de bord se
charge, avec un bandeau tant que le bot n'est pas connecté à Discord. Entre-temps,
la lecture, les files et les salons attendent, et c'est le tableau de bord qui
le dit.

Une fenêtre d'état ne paraît que s'il n'y a pas de tableau de bord à montrer :
première configuration, panne, ou bot éteint. La fermer alors que rien ne tourne
quitte l'application. _Quitter_ depuis l'icône éteint le bot en douceur — fondu,
sauvegarde de l'état de lecture — avant de fermer.

### Quelle version démarre

Les versions installées depuis le tableau de bord vont dans
`bot\versions\<tag>\`, à côté du code déployé par l'installeur. À chaque
lancement, l'application démarre la plus récente de toutes (ordre semver) ; à
égalité, le code de l'installeur l'emporte. Revenir à une version plus ancienne
depuis le tableau de bord vaut jusqu'à la fermeture de l'application.

Installer une version depuis le tableau de bord n'apporte que le code du bot :
l'application elle-même — sa fenêtre, ses icônes — se met à jour par son
installeur.

---

## Installer : l'avertissement de Windows

L'installeur **n'est pas signé** : un certificat de signature de code coûte
plusieurs centaines d'euros par an, ce qui n'a pas de sens pour un projet
gratuit. Windows SmartScreen affiche donc, au premier lancement, « Windows a
protégé votre ordinateur » et un éditeur inconnu.

Pour installer quand même : **Informations complémentaires**, puis
**Exécuter quand même**. Le navigateur peut aussi demander de confirmer le
téléchargement (_Conserver_).

Sous Linux, l'AppImage n'a besoin que d'être rendu exécutable
(`chmod +x`, ou _Propriétés → Autoriser l'exécution_). Selon la distribution,
la zone de notification demande l'extension _AppIndicator_ (GNOME) et
l'AppImage la bibliothèque `libfuse2`. Le paquet `.deb` installe ce qu'il faut.

Chaque fichier est construit par le workflow public
[`.github/workflows/desktop.yml`](../.github/workflows/desktop.yml), à partir du
code de ce dépôt : chaque fichier joint à une release se rattache au run qui l'a
produit, dans l'onglet _Actions_.

---

## Où sont les fichiers

| Quoi                                    | Où                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------- |
| Le bot, sa configuration et ses données | `%LOCALAPPDATA%\com.wolfgangproxa.interactive-music-player\bot\`          |
| `.env`                                  | dans ce même dossier `bot\`                                               |
| Playlists, réglages, journaux           | `bot\data\`                                                               |
| Node.js embarqué                        | `%LOCALAPPDATA%\com.wolfgangproxa.interactive-music-player\runtime\`      |
| Réglages de l'application               | `%LOCALAPPDATA%\com.wolfgangproxa.interactive-music-player\settings.json` |

Sous Linux, le même dossier est `~/.local/share/com.wolfgangproxa.interactive-music-player/`.

Une mise à jour de l'application remplace le code du bot et le runtime, jamais
`.env`, `data\` ni `versions\`.

### Garder une installation existante

Un clone du dépôt, avec son `.env` et ses `data/`, peut être lancé tel quel :
dans l'assistant, _Utiliser une installation existante…_, puis choisir le
dossier qui contient `src` et `package.json`. L'application lance alors ce
dossier avec le Node de la machine s'il en a un — celui qui a installé ses
`node_modules` —, et installe les dépendances si elles manquent.

_Revenir au dossier de l'application_, en bas de la fenêtre, défait ce choix.

### Un bot déjà lancé

Si un bot répond déjà sur le port du tableau de bord — lancé par
`Start bot.vbs`, par exemple —, l'application s'y rattache sans en démarrer un
second, et ouvre son tableau de bord ; le redémarrer ou l'éteindre reste dans le
menu de l'icône.

---

## Construire

L'installeur Windows se construit sous Windows, l'AppImage et le `.deb` sous
Ubuntu, par le workflow
[`.github/workflows/desktop.yml`](../.github/workflows/desktop.yml) : à chaque
modification de `desktop/` poussée sur `main`, et à la demande depuis l'onglet
_Actions_. Pousser une étiquette `v*`, ou lancer le workflow à la main en
remplissant _release_ (`v0.0.1`…), publie en plus la release, avec les notes de
`.github/releases/<étiquette>.md` et un fichier `SHA256SUMS.txt`.

En local, avec Node 24 et Rust :

```bash
cd desktop
npm ci
npm run payload       # Node embarqué + bot + dépendances → src-tauri/payload/
npm run build         # Windows : installeur NSIS → src-tauri/target/release/bundle/nsis/
npm run build -- --bundles appimage,deb   # Linux → bundle/appimage/ et bundle/deb/
```

Sous Linux, Tauri demande d'abord WebKitGTK et ses voisines : la liste exacte
est dans l'étape _Bibliothèques système_ du workflow.

La charge utile se prépare sur la plateforme visée : npm y télécharge les
binaires propres à chacune (FFmpeg, yt-dlp, chiffrement DAVE).

### Développer

```bash
cd desktop
npm ci
npm run dev
```

Sans charge utile, l'application lance le dépôt lui-même, avec le Node de la
machine. `IMP_BOT_ROOT` désigne un autre dossier de bot.

---

## Comment c'est fait

```
desktop/
├── ui/                     Page d'attente et fenêtre d'état : HTML et JS sans dépendance
├── scripts/
│   └── build-payload.js    Prépare l'archive embarquée par l'installeur
└── src-tauri/
    ├── tauri.conf.json     Fenêtre, installeur NSIS, ressources
    └── src/
        ├── supervisor.rs   Cycle de vie du bot : préparation, lancement, garde, arrêt
        ├── layout.rs       Quel dossier de bot, quel Node
        ├── payload.rs      Déploiement de l'archive embarquée
        ├── versions.rs     Quelle version installée démarrer
        ├── dashboard.rs    Port, adresse et commandes du tableau de bord
        ├── discord.rs      Vérification du jeton, invitation
        ├── env_file.rs     Lecture et écriture de .env
        ├── tray.rs         Icône et menu de la zone de notification
        └── view.rs         L'instantané que dessine la fenêtre d'état
```

La fenêtre d'état ne décide de rien : l'application lui envoie un
instantané complet à chaque changement, et elle renvoie l'identifiant du bouton
cliqué. Le tableau de bord, lui, est chargé depuis le serveur du bot et n'a
aucun accès aux commandes de l'application.

### Le contrat avec le bot

L'application pose deux variables dans l'environnement du bot :

- `AUTO_OPEN_DASHBOARD=false` — le tableau de bord s'ouvre dans l'application,
  pas dans un onglet ;
- `IMP_SUPERVISOR=desktop` — pour redémarrer, le bot ne lance plus lui-même une
  instance détachée, qui échapperait à l'application. Il dépose le point
  d'entrée voulu dans `data/desktop-restart.json` et sort avec le code 75 ;
  l'application relance ce point d'entrée avec `IMP_RESTART=1`. Voir
  [`src/utils/supervisor.js`](../src/utils/supervisor.js).

Le reste passe par ce qui existait déjà pour le lanceur PowerShell : le port
qui s'ouvre dès le lancement du processus du bot (avant Discord), `/api/clients` pour l'adresse du tableau de
bord, et la WebSocket pour `restartBot` et `shutdownBot`.
