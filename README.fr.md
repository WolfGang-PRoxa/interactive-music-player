[English](README.md) · **Français**

# Interactive Music Player

Bot Discord de musique avec **atténuation automatique du volume à la parole**
(_ducking_) et **tableau de bord web temps réel**.

La musique baisse dès qu'une personne prend la parole dans le salon vocal, puis
remonte progressivement une fois le silence revenu — sans intervention, sans
latence perceptible.

```
┌─────────────────────────────────────────────────────────────┐
│  ♪ Musique à 70 %                                           │
│  ─────────────────────────────────────────────              │
│                    🗣  quelqu'un parle                      │
│  ♪ Musique à 14 %  ╲___________________╱   ← fondu 200 ms   │
│                          800 ms de silence                  │
└─────────────────────────────────────────────────────────────┘
```

---

## En bref

|                                |                                                                                               |
| ------------------------------ | --------------------------------------------------------------------------------------------- |
| **Ducking configurable**       | Niveau, délai de garde et durée de fondu réglables ; exclusion possible par participant       |
| **Tableau de bord temps réel** | Contrôle complet, file d'attente en glisser-déposer, playlists, journaux, statistiques        |
| **Deux modes de diffusion**    | Dans le salon vocal, ou dans votre navigateur sans déranger le serveur                        |
| **Sources multiples**          | YouTube, Spotify, SoundCloud, Apple Music, fichiers et dossiers locaux                        |
| **Préchargement**              | Les pistes à venir sont mises en cache : démarrage instantané, résistance aux coupures réseau |
| **Reprise après redémarrage**  | Le bot repart sur la piste interrompue, à sa position exacte                                  |
| **Vitesse et enchaînement**    | 0,20× à 3,05× ; fondu enchaîné entre pistes, par volume ou avec effet                         |
| **Niveau sonore (LUFS)**       | Sonie mesurée par piste, réglable au décibel près, et synchronisable sur une cible commune    |
| **Aucune dépendance externe**  | Ni base de données, ni build, ni FFmpeg à installer                                           |

---

## Documentation

| Pour                                  | Document                                                   |
| ------------------------------------- | ---------------------------------------------------------- |
| Utiliser le bot et le tableau de bord | **[Guide utilisateur](docs/fr/GUIDE.md)**                  |
| Comprendre ou modifier le code        | **[Documentation technique](docs/fr/technique/README.md)** |

La documentation technique couvre l'[architecture](docs/fr/technique/01-architecture.md),
la [chaîne audio](docs/fr/technique/02-lecture-audio.md), le
[ducking](docs/fr/technique/03-ducking.md), les
[modes de diffusion](docs/fr/technique/04-diffusion.md), le
[tableau de bord](docs/fr/technique/05-tableau-de-bord.md), la
[persistance](docs/fr/technique/06-persistance.md), la
[sécurité](docs/fr/technique/07-securite.md), la
[journalisation](docs/fr/technique/08-journalisation.md) et la
[configuration](docs/fr/technique/09-configuration.md).

---

## Application de bureau _(Windows, Linux)_

Le plus simple : **l'installeur**. Il apporte Node.js, le bot et ses
dépendances — aucun prérequis —, puis l'application guide la première
configuration, garde le bot dans la zone de notification et ouvre le tableau de
bord dans sa propre fenêtre. Celui-ci reste accessible dans n'importe quel
navigateur, comme avant.

Tout est joint aux [releases](https://github.com/WolfGang-PRoxa/interactive-music-player/releases) :

| Système                    | Fichier                                                   |
| -------------------------- | --------------------------------------------------------- |
| Windows 10 et 11           | `…_x64-setup.exe`, l'installeur                           |
| Linux (toute distribution) | `…_amd64.AppImage` : le rendre exécutable, puis le lancer |
| Debian, Ubuntu et dérivées | `…_amd64.deb` : `sudo apt install ./…_amd64.deb`          |

Chaque fichier est produit par le workflow _Application de bureau_, et
`SHA256SUMS.txt` donne son empreinte. Tout le détail est dans
[desktop/README.fr.md](desktop/README.fr.md).

> **L'installeur n'est pas signé.** Windows SmartScreen affiche « Windows a
> protégé votre ordinateur » au premier lancement : cliquez sur
> **Informations complémentaires**, puis **Exécuter quand même**. Voir
> [pourquoi](desktop/README.fr.md#installer--lavertissement-de-windows).

La suite de ce document décrit l'installation depuis le code source.

---

## Prérequis

- **Node.js 22.12** ou supérieur (la version LTS convient)
- Un compte Discord — l'application du bot se crée à l'installation, sur le
  [portail développeur](https://discord.com/developers/applications), et le
  premier démarrage vous y conduit

FFmpeg et yt-dlp sont fournis par les dépendances npm : rien à installer sur le
système.

---

## Installation

### 1. Récupérer le projet

```bash
git clone https://github.com/WolfGang-PRoxa/interactive-music-player
cd interactive-music-player
```

Sous Windows, les dépendances sont installées au premier démarrage par la
fenêtre de lancement ; il n'y a rien d'autre à faire ici.

### 2. Créer le bot Discord

**Sous Windows, laissez-vous guider** : double-cliquez sur `Start bot.vbs`, à la
racine du projet. Au premier lancement, la fenêtre qui s'ouvre ne démarre rien —
elle vous accompagne, et se charge de tout ce qui suit.

Il vous reste deux gestes : créer l'application sur le portail, que le bouton
ouvre pour vous (**New Application**, puis onglet **Bot** → **Reset Token** →
**Copy**), et cliquer sur _Inviter_. Le jeton copié est reconnu sans que vous
ayez à le coller, l'identifiant de l'application en est déduit, `.env` est écrit,
les dépendances installées, les commandes enregistrées, et l'URL d'invitation
assemblée avec les bonnes portées et permissions.

Cette même fenêtre sert ensuite à chaque démarrage, et propose de refaire cette
configuration si Discord venait à refuser le jeton enregistré.

<details>
<summary>À la main, ou hors de Windows</summary>

Commencez par `npm install`, puis :

1. Sur le [portail développeur](https://discord.com/developers/applications),
   créez une application (**New Application**).
2. Relevez l'**Application ID** → variable `DISCORD_CLIENT_ID`.
3. Onglet **Bot** → **Reset Token** → variable `DISCORD_TOKEN`. Ce jeton est
   confidentiel.
4. Invitez le bot via **OAuth2 → URL Generator**, en cochant les portées `bot`
   et `applications.commands`, puis les permissions :
   _View Channels_, _Connect_, _Speak_, _Manage Channels_, _Move Members_.

Puis créez le fichier de configuration :

```bash
cp .env.example .env      # copy .env.example .env sous Windows
```

Le minimum à renseigner :

```env
DISCORD_TOKEN=votre_jeton
DISCORD_CLIENT_ID=votre_application_id
```

Et enfin :

```bash
npm run deploy    # une fois, puis à chaque changement de commande
npm start
```

</details>

> **Aucune intention privilégiée n'est requise.** Le bot n'utilise que
> `Guilds`, `GuildVoiceStates` et `GuildMessages`, toutes trois non
> privilégiées. Il est inutile d'activer _Presence_, _Server Members_ ou
> _Message Content_.

### 3. Aller plus loin dans la configuration

Tout le reste est facultatif et se règle dans `.env`. Voir la
[référence complète des variables](docs/fr/technique/09-configuration.md#variables-denvironnement)
pour le port, l'exposition réseau, les dossiers de musique locaux et la
journalisation.

Définir `GUILD_ID` dans `.env` rend les commandes disponibles immédiatement sur
ce serveur ; sans cette variable, le déploiement est global et peut prendre
jusqu'à une heure.

### 4. Le raccourci _(Windows, facultatif)_

Pour avoir le bot sous la main ailleurs que dans le dossier du projet, double-cliquez
plutôt sur **`Create shortcut.vbs`**, à la racine du projet. Un
assistant s'ouvre : choisissez l'emplacement — bureau, menu Démarrer ou
n'importe quel dossier de votre PC — et le raccourci y est posé. Une option
permet aussi de lancer le bot à chaque ouverture de session Windows.

Le bot démarre **sans aucune fenêtre de terminal** : rien ne s'ouvre à l'écran,
rien n'apparaît dans la barre des tâches. Une petite fenêtre suit le lancement
étape par étape — Node.js, configuration, installation des
dépendances à la première utilisation, démarrage, tableau de bord — puis
s'efface d'elle-même dès que le bot est prêt. Si une étape échoue, elle reste
ouverte avec le motif, un extrait du journal et le bouton qui débloque.

Le bot tournant désormais sans console, on l'**arrête depuis le tableau de
bord** (bouton d'extinction), et ses journaux se lisent dans l'onglet dédié ou
dans `data/logs/`.

### 5. Ouvrir le tableau de bord

Le navigateur s'ouvre automatiquement cinq secondes après le démarrage. Le
tableau de bord est protégé par un **jeton d'accès**, enregistré dans
`data/dashboard-token` — et affiché dans la console, quand le bot a été démarré
depuis un terminal :

```
http://localhost:3000/?token=VOTRE_JETON
```

Par défaut, il n'écoute que sur la machine locale. Pour y accéder depuis un
téléphone ou un autre poste, voir
[Accès au tableau de bord](docs/fr/GUIDE.md#accès-au-tableau-de-bord).

---

## Mise à jour

**Application de bureau** : téléchargez l'installeur de la nouvelle version sur
la page des [releases](https://github.com/WolfGang-PRoxa/interactive-music-player/releases)
et installez-le par-dessus l'ancienne. `.env`, playlists, réglages et journaux
sont conservés : une mise à jour remplace le code du bot et le runtime, jamais
les données.

**Depuis le code source** :

```bash
git pull
npm install
npm run deploy    # seulement si des commandes slash ont changé
```

Le tableau de bord permet aussi de basculer entre les versions publiées, depuis
le menu des versions. Si YouTube refuse soudain de lire, `npm run update-ytdlp`
met yt-dlp à jour sans attendre une nouvelle version du bot.

---

## Où sont les données

| Quoi                                                           | Depuis le code source | Application de bureau                                            |
| -------------------------------------------------------------- | --------------------- | ---------------------------------------------------------------- |
| Configuration (`.env`)                                         | racine du projet      | `%LOCALAPPDATA%\com.wolfgangproxa.interactive-music-player\bot\` |
| Réglages, état de lecture, playlists, jeton du tableau de bord | `data/`               | `bot\data\`                                                      |
| Journaux                                                       | `data/logs/`          | `bot\data\logs\`                                                 |
| Versions téléchargées depuis le tableau de bord                | `versions/`           | `bot\versions\`                                                  |

Sous Linux, le dossier de l'application de bureau est
`~/.local/share/com.wolfgangproxa.interactive-music-player/`. Rien de tout cela
n'est versionné, et rien ne quitte la machine.

---

## Commandes

| Commande                                      | Action                               |
| --------------------------------------------- | ------------------------------------ |
| `/play query:<recherche, URL ou chemin>`      | Lance ou met en file une piste       |
| `/playlist path:<dossier> [shuffle]`          | Charge un dossier local entier       |
| `/queue [page]`                               | Affiche la file d'attente            |
| `/pause` `/resume` `/skip` `/stop`            | Contrôle de la lecture               |
| `/nowplaying`                                 | Piste en cours et progression        |
| `/volume level:<0-100>`                       | Volume de référence                  |
| `/ducking toggle\|level\|delay\|fade\|status` | Réglages du ducking                  |
| `/broadcast mode:<everyone\|personal>`        | Mode de diffusion _(administrateur)_ |

Détail et exemples dans le [guide utilisateur](docs/fr/GUIDE.md#référence-complète-des-commandes-discord).

---

## Structure

```
src/
├── index.js          Point d'entrée : client Discord, lecteur, arrêt propre
├── config.js         Constantes et valeurs par défaut
├── audio/            Ducking, volume, événements du lecteur, préchargement
├── broadcast/        Modes de diffusion, salons personnels
├── commands/         Commandes slash
├── database/         Réglages et état de lecture
├── utils/            Journalisation, JSON atomique, chemins, durées
└── web/              Serveur HTTP + WebSocket, API, tableau de bord

tools/                Raccourci Windows : assistant graphique et lanceur
data/                 Créé à l'exécution, non versionné
docs/<langue>/        Guide utilisateur et documentation technique (fr, en, es, de)

Create shortcut.vbs   Ouvre l'assistant (Windows)
Start bot.vbs         Démarre le bot sans console (Windows)
```

Arborescence détaillée et carte des dépendances :
[01 — Architecture](docs/fr/technique/01-architecture.md#arborescence).

---

## Développement

| Commande               | Effet                                                       |
| ---------------------- | ----------------------------------------------------------- |
| `npm install`          | Installe les dépendances (FFmpeg et yt-dlp compris)         |
| `npm start`            | Démarre le bot                                              |
| `npm run dev`          | Démarre avec redémarrage au changement de fichier           |
| `npm run deploy`       | Enregistre les commandes slash auprès de Discord            |
| `npm test`             | Lance tous les tests automatisés                            |
| `npm run check`        | Vérifie la mise en forme (Prettier) et le code (ESLint)     |
| `npm run format`       | Met en forme tout le projet avec Prettier                   |
| `npm run lint`         | Lance ESLint seul                                           |
| `npm run update-ytdlp` | Met à jour yt-dlp                                           |
| `Start bot.vbs`        | _(Windows)_ Démarre le bot sans console, par double-clic    |
| `Create shortcut.vbs`  | _(Windows)_ Assistant de création du raccourci de lancement |
| `tools/start-bot.vbs`  | _(Windows)_ Cible du raccourci : démarrage sans console     |

L'intégration continue lance `npm run check` et `npm test` à chaque push. Le
dernier étage du test de fumée démarre le vrai bot : il demande un
`DISCORD_TOKEN` dans `.env` et se signale comme ignoré sans lui.

L'application de bureau a sa propre section
[Construire](desktop/README.fr.md#construire). L'historique des versions est dans
[CHANGELOG.fr.md](CHANGELOG.fr.md).

---

## Dépannage

**Les commandes n'apparaissent pas sur Discord**
Vérifiez que `npm run deploy` a été exécuté et que le bot a été invité avec la
portée `applications.commands`. Sans `GUILD_ID`, la propagation globale peut
prendre une heure.

**Le bot ne rejoint pas le salon vocal**
Vérifiez les permissions _Connect_ et _Speak_ sur le salon, et que vous y êtes
vous-même connecté au moment de la commande.

**Le ducking ne réagit pas**
Une piste doit être en cours de lecture — le ducking est mis en place au
démarrage d'une piste, pas à la connexion. Vérifiez ensuite `/ducking status` et
que le participant n'est pas exclu de la détection depuis le tableau de bord.
Voir le [guide de diagnostic](docs/fr/technique/03-ducking.md#diagnostic).

**Le lecteur du navigateur refuse mes fichiers locaux**
Seuls les fichiers des dossiers du bot ou déclarés dans `MEDIA_ROOTS` sont
diffusés. Voir [Sécurité — restriction des chemins](docs/fr/technique/07-securite.md#restriction-des-chemins).

---

## Licence et conditions

Le code est publié sous licence **[MIT](LICENSE)**.

Le bot est **auto-hébergé** : chaque personne crée sa propre application Discord
et fait tourner sa propre instance, sur sa propre machine. Aucune donnée ne
remonte à l'auteur — pas de télémétrie, pas de statistiques, pas de serveur
central. Aucun audio n'est enregistré : le ducking ne lit que l'événement
« untel parle », jamais ce qui est dit.

| Document                     | Français                                     | English                      |
| ---------------------------- | -------------------------------------------- | ---------------------------- |
| Conditions d'utilisation     | **[CONDITIONS.md](CONDITIONS.md)**           | **[TERMS.md](TERMS.md)**     |
| Politique de confidentialité | **[CONFIDENTIALITE.md](CONFIDENTIALITE.md)** | **[PRIVACY.md](PRIVACY.md)** |
