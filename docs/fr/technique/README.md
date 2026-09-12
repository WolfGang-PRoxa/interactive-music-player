# Documentation technique

Documentation d'ingénierie du bot **Musique Interactive** : un bot Discord de
lecture musicale avec atténuation automatique du volume à la parole (*ducking*),
piloté par un tableau de bord web temps réel.

Ce dossier s'adresse aux personnes qui modifient le code. Pour l'utilisation
courante, voir le [guide utilisateur](../GUIDE.md).

---

## Sommaire

| Document | Contenu |
|---|---|
| [01 — Architecture](01-architecture.md) | Vue d'ensemble, séquence de démarrage, carte des modules, cycle de vie |
| [02 — Lecture audio](02-lecture-audio.md) | discord-player, extracteurs, filtres FFmpeg, vitesse, fondus, préchargement |
| [03 — Ducking](03-ducking.md) | Détection de parole, machine à états, contrôle du volume |
| [04 — Modes de diffusion](04-diffusion.md) | Mode commun et mode personnel, lecteur virtuel, transitions |
| [05 — Tableau de bord](05-tableau-de-bord.md) | Serveur web, protocole WebSocket, routes HTTP, frontend |
| [06 — Persistance](06-persistance.md) | Réglages, état de lecture, écriture atomique, stockage des imports |
| [07 — Sécurité](07-securite.md) | Authentification, restriction des chemins, plafonds |
| [08 — Journalisation](08-journalisation.md) | Logger, niveaux, diffusion vers le tableau de bord |
| [09 — Configuration](09-configuration.md) | Variables d'environnement, `config.js`, déploiement des commandes |
| [10 — Versions](10-versions.md) | Racines partagée et d'installation, releases GitHub, bascule de version |
| [11 — Accès distant](11-acces-distant.md) | Tunnel Tailscale, `PUBLIC_URL`, partage du contrôle |
| [12 — Tests](12-tests.md) | Les suites de `tests/`, ce qu'elles couvrent, comment en écrire une |

---

## Vue à 10 000 pieds

Le bot est un **unique processus Node.js** qui fait tourner trois choses en
parallèle :

```
                    ┌─────────────────────────────┐
                    │      Processus Node.js      │
                    │                             │
   Discord  ◄──────►│  Client discord.js          │
   (gateway         │    └─ discord-player        │──► Salon vocal (Opus/UDP)
    + vocal)        │         └─ FFmpeg           │
                    │                             │
                    │  Serveur HTTP + WebSocket   │◄─► Navigateur
                    │    └─ Express               │    (tableau de bord)
                    │                             │
                    │  Persistance fichiers JSON  │──► data/
                    └─────────────────────────────┘
```

Il n'y a **ni base de données externe, ni service annexe, ni build** : `npm start`
suffit. La contrepartie est que tout l'état vit en mémoire dans ce processus,
avec des instantanés sur disque (voir [06 — Persistance](06-persistance.md)).

---

## Principes structurants

**Le processus est mono-instance, et le bot appartient à quelqu'un.**
Le bot est conçu pour être hébergé sur la machine de son propriétaire. Le jeton
d'accès ouvre la page, mais il ne nomme personne : les droits sont attachés à
un **compte Discord**. Le premier compte revenu de Discord en présentant le
jeton devient le maître de session ; les autres sont des invités, qui n'ont que
ce que le maître leur accorde, geste par geste. Voir
[07 — Sécurité](07-securite.md).

**L'état de lecture appartient au projet.**
Les 26 propriétés d'état (`virtualCurrentTrack`, `channelStates`,
`transitioningToEveryone`…) sont déclarées dans
[`PlaybackSession`](../../../src/audio/PlaybackSession.js), et non plus greffées
sans schéma sur l'objet `GuildQueue` de discord-player. Voir
[01 — Architecture](01-architecture.md#playbacksession).

**Le tableau de bord est un miroir, pas une source de vérité.**
Le serveur diffuse un état complet ; le client l'affiche. Toute action du client
est un message WebSocket qui modifie l'état serveur, lequel rediffuse.

**Rien n'est transpilé.**
CommonJS côté serveur, scripts globaux côté navigateur. Pas de bundler, pas de
TypeScript. Les fichiers frontend sont servis tels quels par Express.

---

## Conventions

- **Langue** : commentaires, journaux et documentation en français ; identifiants
  en anglais.
- **Modules** : CommonJS (`require`). Les singletons sont exportés instanciés
  (`module.exports = new Foo()`).
- **Journalisation** : jamais `console.*`, toujours `log.debug|info|success|warn|error`
  (voir [08 — Journalisation](08-journalisation.md)).
- **Chemins disque exposés au client** : jamais bruts, toujours via
  `resolveMediaPath()` (voir [07 — Sécurité](07-securite.md)).
- **Écriture de fichiers JSON** : jamais `writeFileSync` direct, toujours
  `writeJsonAtomic()` (voir [06 — Persistance](06-persistance.md)).

---

## Limites connues

Ces points sont des dettes identifiées, pas des bugs à signaler.

| Sujet | Description | Voir |
|---|---|---|
| État de lecture | Les 375 sites accèdent encore à l'état via `queue.xxx`, désormais des accesseurs vers `PlaybackSession`. Leur réécriture en `session.xxx` reste à faire. | [01](01-architecture.md#playbacksession) |
| Boucle de diffusion 1 s | L'intervalle n'est jamais arrêté — il n'existe pas de `stop()` sur `WebServer`. La charge utile périodique, elle, a été ramenée à ~200 octets. | [05](05-tableau-de-bord.md#la-boucle-de-rafraîchissement) |
| Double modèle de lecture | Les modes commun et personnel sont entrelacés par des ternaires `isPersonal ? … : …` dans tout le code d'état. | [04](04-diffusion.md#le-coût-du-double-modèle) |
| Arrêt sur erreur inattendue | `uncaughtException` et `unhandledRejection` journalisent puis laissent mourir le processus — c'est voulu, mais rien ne le relève. `SIGTERM` reste non traité. | [05](05-tableau-de-bord.md#robustesse) |
| Découpage frontend inachevé | `app.js` concentre encore 3 819 lignes que le dossier `js/` a commencé à extraire. | [05](05-tableau-de-bord.md#découpage-inachevé) |
