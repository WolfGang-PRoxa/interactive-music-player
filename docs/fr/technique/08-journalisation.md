# 08 — Journalisation

[← Sommaire](README.md)

---

## Usage

```js
const log = require('../utils/logger');   // chemin relatif au fichier

log.debug('[Ducking Debug] Détection parole - Début');
log.info('[Player] ▶ En lecture : ' + track.title);
log.success('[Bot] Connecté à Discord');
log.warn('[Upload] Extension refusée : ' + name);
log.error('[Player] Erreur de lecture :', err);   // une Error garde sa pile
```

**`console.*` ne doit plus être utilisé dans `src/`** (hors `web/public/`, qui
s'exécute dans le navigateur). Le logger est le seul point d'entrée.

---

## Niveaux

| Niveau | Sévérité | Usage |
|---|---|---|
| `debug` | 10 | Traces internes, détail de diagnostic |
| `info` | 20 | Déroulement normal |
| `success` | 20 | Étape réussie notable — variante d'`info`, distinguée à l'affichage |
| `warn` | 30 | Anomalie non bloquante |
| `error` | 40 | Échec |

`LOG_LEVEL` fixe le seuil (défaut `debug`, donc tout passe). `success` partage
la sévérité d'`info` : filtrer à `info` conserve les deux.

Les sorties de sévérité `warn` et supérieure vont sur `stderr`, les autres sur
`stdout`.

---

## Ce que ce module a remplacé

Auparavant, [`WebServer.js`](../../../src/web/WebServer.js) **remplaçait
`console.log`, `console.warn`, `console.error` et `console.info`** au chargement
du module, pour capter les messages et les envoyer au tableau de bord. Deux
défauts en découlaient.

**Un couplage inversé.** Le module web pilotait la journalisation de toute
l'application. Charger `WebServer` avait pour effet de bord de modifier
`console` globalement.

**Un niveau deviné à partir du texte.** Le niveau était déduit par recherche de
sous-chaînes :

```js
else if (u.includes('WARN') || u.includes('WARNING') || u.includes('ATTENTION'))
    detectedLevel = 'WARN';
```

Un message français parfaitement normal contenant « attention » était donc
classé comme avertissement. La même heuristique existait **en double** côté
client, dans `logs.js`, où elle réécrivait le niveau de toute entrée `INFO`.

Le niveau est désormais fixé au point d'appel, et les deux heuristiques ont été
retirées.

---

## Architecture

Le logger est **autonome** : il n'a aucune dépendance vers le serveur web. Le
couplage est inversé — `WebServer` s'abonne à lui.

```
   modules applicatifs
          │  log.info(...)
          ▼
   ┌──────────────┐
   │   Logger     │
   └──────┬───────┘
          ├──► process.stdout / stderr        (terminal)
          ├──► historique en mémoire (200)     (nouveaux clients)
          ├──► abonnés                         (WebServer → WebSocket)
          └──► tampon → data/logs/*.log        (regroupé)
```

### Abonnement

```js
log.subscribe((entry) => { /* entry = { timestamp, level, text } */ });
```

Renvoie une fonction de désabonnement. `WebServer` l'utilise dans son
constructeur pour diffuser chaque entrée aux clients WebSocket connectés.

`log.getHistory()` renvoie les 200 dernières entrées, envoyées à la connexion
d'un client sous le type `logsHistory`.

### Mise en forme des arguments

| Type | Rendu |
|---|---|
| `string` | tel quel |
| `Error` | `err.stack`, message et pile conservés |
| objet | `util.inspect(obj, { depth: 2, breakLength: Infinity })`, sur une ligne |
| autre | `String(arg)` |

Le traitement des `Error` est une correction notable : l'ancienne mise en forme
utilisait `JSON.stringify`, qui réduit une `Error` à `{}`. Le tableau de bord
n'affichait donc rien d'exploitable pour diagnostiquer une panne.

### Écriture disque

Deux fichiers par exécution :

- `data/logs/<AAAA-MM-JJ_HH-MM-SS>.log` — journal de l'instance ;
- `data/logs/latest.log` — réécrit à chaque démarrage, toujours le plus récent.

Les lignes sont **regroupées** : écriture après 250 ms ou 64 entrées, au lieu de
deux `appendFileSync` synchrones par ligne. `flush()` force l'écriture et est
branché sur `process.on('exit')`, ce qui couvre les redémarrages par
`process.exit()`.

Format de ligne :

```
[2026-08-02 21:05:07] [ERROR  ] [Player] Erreur de lecture : ...
```

### Rétention

`LOG_RETENTION` journaux conservés (défaut 20). La purge s'exécute **après** la
création du journal courant, si bien que le dossier contient au plus `N`
fichiers, celui de l'instance en cours compris. `latest.log` n'est jamais purgé.

---

## Configuration

`log.configure()` est appelée une fois, au chargement de
[`WebServer.js`](../../../src/web/WebServer.js) :

```js
log.configure({
    dir: path.join(process.cwd(), 'data/logs'),
    level: process.env.LOG_LEVEL || 'debug',
    retention: Number(process.env.LOG_RETENTION) || 20,
});
```

Sans appel à `configure()`, le logger fonctionne mais n'écrit que sur la sortie
standard. C'est le cas pour [`deploy-commands.js`](../../../src/deploy-commands.js),
qui ne charge pas le serveur web.

---

## Journaux côté client

Le tableau de bord peut renvoyer ses propres messages au serveur par le message
WebSocket `clientLog` :

```js
window.MusicPlayer.sendWS({ type: 'clientLog', data: { source: 'Video', message: '…' } });
```

Ils sont journalisés en `info` avec le préfixe fourni, puis rediffusés comme
toute autre entrée.
