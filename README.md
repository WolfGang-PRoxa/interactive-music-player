# Interactive Music Player

Bot Discord de musique avec **atténuation automatique du volume à la parole**
(*ducking*) et **tableau de bord web temps réel**.

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

| | |
|---|---|
| **Ducking configurable** | Niveau, délai de garde et durée de fondu réglables ; exclusion possible par participant |
| **Tableau de bord temps réel** | Contrôle complet, file d'attente en glisser-déposer, playlists, journaux, statistiques |
| **Deux modes de diffusion** | Dans le salon vocal, ou dans votre navigateur sans déranger le serveur |
| **Sources multiples** | YouTube, Spotify, SoundCloud, Apple Music, fichiers et dossiers locaux |
| **Préchargement** | Les pistes à venir sont mises en cache : démarrage instantané, résistance aux coupures réseau |
| **Reprise après redémarrage** | Le bot repart sur la piste interrompue, à sa position exacte |
| **Vitesse et enchaînement** | 0,20× à 3,05× ; fondu enchaîné entre pistes, par volume ou avec effet |
| **Aucune dépendance externe** | Ni base de données, ni build, ni FFmpeg à installer |

---

## Documentation

| Pour | Document |
|---|---|
| Utiliser le bot et le tableau de bord | **[Guide utilisateur](docs/fr/GUIDE.md)** |
| Comprendre ou modifier le code | **[Documentation technique](docs/fr/technique/README.md)** |

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

## Prérequis

- **Node.js 18** ou supérieur
- Une application Discord créée sur le
  [portail développeur](https://discord.com/developers/applications)

FFmpeg et yt-dlp sont fournis par les dépendances npm : rien à installer sur le
système.

---

## Installation

### 1. Récupérer le projet

```bash
git clone https://github.com/WolfGang-PRoxa/interactive_music_player
cd interactive_music_player
npm install
```

### 2. Créer le bot Discord

1. Sur le [portail développeur](https://discord.com/developers/applications),
   créez une application (**New Application**).
2. Relevez l'**Application ID** → variable `DISCORD_CLIENT_ID`.
3. Onglet **Bot** → **Reset Token** → variable `DISCORD_TOKEN`. Ce jeton est
   confidentiel.
4. Invitez le bot via **OAuth2 → URL Generator**, en cochant les portées `bot`
   et `applications.commands`, puis les permissions :
   *View Channels*, *Connect*, *Speak*, *Manage Channels*, *Move Members*.

> **Aucune intention privilégiée n'est requise.** Le bot n'utilise que
> `Guilds`, `GuildVoiceStates` et `GuildMessages`, toutes trois non
> privilégiées. Il est inutile d'activer *Presence*, *Server Members* ou
> *Message Content*.

### 3. Configurer l'environnement

```bash
cp .env.example .env      # copy .env.example .env sous Windows
```

Le minimum à renseigner :

```env
DISCORD_TOKEN=votre_jeton
DISCORD_CLIENT_ID=votre_application_id
```

Voir la [référence complète des variables](docs/fr/technique/09-configuration.md#variables-denvironnement)
pour le port, l'exposition réseau, les dossiers de musique locaux et la
journalisation.

### 4. Enregistrer les commandes et démarrer

```bash
npm run deploy    # une fois, puis à chaque changement de commande
npm start
```

Définir `GUILD_ID` dans `.env` rend les commandes disponibles immédiatement sur
ce serveur ; sans cette variable, le déploiement est global et peut prendre
jusqu'à une heure.

### 5. Démarrer sans terminal *(Windows, facultatif)*

Double-cliquez sur **`Start bot.vbs`**, à la racine du projet : le bot démarre
directement, sans qu'aucune fenêtre ne s'ouvre.

Pour l'avoir sous la main ailleurs que dans le dossier du projet, double-cliquez
plutôt sur **`Create shortcut.vbs`**, à la racine du projet. Un
assistant s'ouvre : choisissez l'emplacement — bureau, menu Démarrer ou
n'importe quel dossier de votre PC — et le raccourci y est posé. Une option
permet aussi de lancer le bot à chaque ouverture de session Windows.

Dans les deux cas le bot démarre **sans aucune fenêtre de terminal** : rien ne
s'ouvre à l'écran, rien n'apparaît dans la barre des tâches. Une petite fenêtre
suit le lancement étape par étape — Node.js, configuration, installation des
dépendances à la première utilisation, démarrage, tableau de bord — puis
s'efface d'elle-même dès que le bot est prêt. Si une étape échoue, elle reste
ouverte avec le motif, un extrait du journal et le bouton qui débloque.

Le bot tournant désormais sans console, on l'**arrête depuis le tableau de
bord** (bouton d'extinction), et ses journaux se lisent dans l'onglet dédié ou
dans `data/logs/`.

### 6. Ouvrir le tableau de bord

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

## Commandes

| Commande | Action |
|---|---|
| `/play query:<recherche, URL ou chemin>` | Lance ou met en file une piste |
| `/playlist path:<dossier> [shuffle]` | Charge un dossier local entier |
| `/queue [page]` | Affiche la file d'attente |
| `/pause` `/resume` `/skip` `/stop` | Contrôle de la lecture |
| `/nowplaying` | Piste en cours et progression |
| `/volume level:<0-100>` | Volume de référence |
| `/ducking toggle\|level\|delay\|fade\|status` | Réglages du ducking |
| `/broadcast mode:<everyone\|personal>` | Mode de diffusion *(administrateur)* |

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

## Scripts

| Commande | Effet |
|---|---|
| `npm start` | Démarre le bot |
| `npm run dev` | Démarre avec redémarrage au changement de fichier |
| `npm run deploy` | Enregistre les commandes slash auprès de Discord |
| `Start bot.vbs` | *(Windows)* Démarre le bot sans console, par double-clic |
| `Create shortcut.vbs` | *(Windows)* Assistant de création du raccourci de lancement |
| `tools/start-bot.vbs` | *(Windows)* Cible du raccourci : démarrage sans console |

---

## Dépannage

**Les commandes n'apparaissent pas sur Discord**
Vérifiez que `npm run deploy` a été exécuté et que le bot a été invité avec la
portée `applications.commands`. Sans `GUILD_ID`, la propagation globale peut
prendre une heure.

**Le bot ne rejoint pas le salon vocal**
Vérifiez les permissions *Connect* et *Speak* sur le salon, et que vous y êtes
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

## Licence

MIT.
