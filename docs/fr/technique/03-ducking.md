# 03 — Ducking

[← Sommaire](README.md)

Le *ducking* est la fonction centrale du bot : la musique s'atténue dès qu'une
personne parle, puis remonte après un silence.

---

## Principe

Discord transmet aux bots des événements de parole par salon vocal. Aucune
analyse de signal n'est nécessaire : `connection.receiver.speaking` émet `start`
et `end` avec l'identifiant de l'utilisateur.

```
        parole détectée                    silence
              │                               │
              ▼                               ▼
     ┌─────────────────┐              ┌─────────────────┐
     │ Set des parleurs│              │ Set des parleurs│
     │   vide → 1      │              │   1 → vide      │
     └────────┬────────┘              └────────┬────────┘
              │                                │
       annuler la restauration          attendre `duckingDelay`
              │                                │
              ▼                                ▼
        duckDown(niveau, fondu)          duckUp(fondu)
```

Deux classes se partagent le travail :

- [`DuckingManager`](../../../src/audio/DuckingManager.js) — *quand* atténuer ;
- [`VolumeController`](../../../src/audio/VolumeController.js) — *comment* faire varier le volume.

Une instance de chaque existe **par serveur**, stockée dans
`client.duckingManagers` (une `Map` indexée par `guildId`).

---

## DuckingManager

### État interne

| Champ | Rôle |
|---|---|
| `activeSpeakers` | `Set<userId>` des personnes en train de parler |
| `_restoreTimer` | Minuteur de restauration différée |
| `_active` | Indique si les écouteurs sont branchés |
| `channelId` | Salon surveillé, pour la liste d'exclusions |

### Début de parole

```
_handleSpeakingStart(userId)
  ├─ activeSpeakers.add(userId)
  ├─ si ducking activé ET utilisateur non exclu :
  │    ├─ annuler le minuteur de restauration en attente
  │    └─ si c'est le PREMIER parleur non exclu :
  │         └─ volumeController.duckDown(duckingLevel, duckingFade)
  └─ rediffuser l'état au tableau de bord
```

La condition « premier parleur non exclu » évite de relancer un fondu à chaque
nouvelle personne qui prend la parole alors que le volume est déjà baissé.

### Fin de parole

```
_handleSpeakingEnd(userId)
  ├─ activeSpeakers.delete(userId)
  ├─ si ducking activé ET plus aucun parleur non exclu :
  │    └─ programmer la restauration dans `duckingDelay` ms
  └─ rediffuser l'état au tableau de bord
```

Le délai est un **anti-rebond**. Sans lui, le volume remonterait pendant les
respirations au milieu d'une phrase, produisant un effet de pompage. Au
déclenchement, une seconde vérification (`activeSpeakers.size === 0`) évite une
remontée si quelqu'un a repris la parole entre-temps.

### Exclusions par utilisateur

`database.isVoiceDetectionDisabled(guildId, channelId, userId)` permet d'ignorer
certaines personnes. La liste est stockée **par salon** dans les réglages :

```json
"ignoredVoiceUsers": { "<channelId>": ["<userId>", "…"] }
```

Un utilisateur exclu est bien ajouté à `activeSpeakers` — le tableau de bord
l'affiche comme parlant — mais n'est pas compté par `_countActiveNonIgnored()`
et ne déclenche donc aucune atténuation.

La clé est **le salon que le tableau de bord affiche**
(`ws.selectedVoiceChannelId`), et non le salon où le bot se trouve : c'est sous
cette clé que `getState()` relit la liste. Les deux coïncident le plus souvent,
mais pas quand le bot n'est connecté nulle part — l'interrupteur était alors
rangé ailleurs qu'où il était relu, et revenait à sa position d'origine à l'état
suivant.

### Reconfiguration à chaud

`refresh()` est appelée après une modification des réglages :

- ducking désactivé → restauration immédiate du volume, sans fondu ;
- ducking activé et quelqu'un parle → atténuation immédiate ;
- ducking activé et silence → restauration immédiate.

`updateConnection()` gère le changement de salon du bot : les écouteurs sont
retirés de l'ancienne connexion et rebranchés sur la nouvelle. Omettre cette
étape laisserait le ducking silencieusement inopérant après un déplacement.

### Durée de vie de l'écoute

**L'écoute de la parole appartient à la connexion vocale, pas à la lecture.**
Elle se monte sur l'événement `connection` du player — un seul point de passage,
que la connexion vienne d'une commande, d'un import, du tableau de bord ou de la
règle de présence — et se démonte avec elle (`PresenceManager.detacher()`,
extinction du bot).

Elle était auparavant accrochée au démarrage d'une piste, et démontée sur
`emptyQueue` dans le seul mode « tout le monde ». Deux conséquences : le tableau
de bord cessait d'animer les auditeurs dès la dernière piste terminée alors que
le bot était toujours là, et une connexion établie en diffusion personnelle —
où aucune piste ne démarre côté bot, le son sortant du navigateur — restait
sourde. L'activité vocale est désormais captée dans les deux modes, file vide ou
non.

### Remontée au tableau de bord

Chaque début et chaque fin de parole émet un message léger `speakers`
(`WebServer.broadcastSpeakers()`), sur le modèle de `progress` : la parole va et
vient plusieurs fois par seconde et par personne, et y répondre par un état
complet resérialiserait à chaque fois la file, l'historique et les playlists. Le
message ne porte que la liste des locuteurs, et n'est adressé qu'aux tableaux de
bord affichant le salon que le bot écoute.

Cette remontée était rompue : le code appelait `WebServer.instance.broadcastState()`
alors que `require('../web/WebServer')` rend **l'instance**, `instance` étant une
propriété statique posée sur la classe — donc toujours `undefined`. Aucune
notification ne partait. Le tableau de bord n'apprenait qui parlait qu'au
prochain état diffusé pour une autre raison, d'où une boîte « Activité vocale »
qui n'animait presque jamais. En diffusion personnelle, la conséquence allait
plus loin : le ducking y est appliqué **par le navigateur** sur son propre
élément audio (`clientDucking`, dans `app.js`), sur la foi de `state.speakers`.
Sans ces messages, aucune atténuation n'était possible dans ce mode.

### Locuteurs fantômes

Discord annonce les changements de micro, pas les départs : quelqu'un qui quitte
le salon en parlant ne produit **aucun** « fin de parole ». Il restait alors
inscrit dans `activeSpeakers` pour toujours — halo allumé sur le tableau de bord,
et volume tenu baissé pour un salon silencieux.

Deux ménages y répondent : `oublierLocuteur(userId)` sur le départ d'un
utilisateur (écouteur `VoiceStateUpdate`), et `oublierLocuteurs()` quand la
connexion change ou que le bot est déplacé — ce qu'une connexion disparue avait
vu ne vaut plus rien.

---

## L'oreille de la connexion

Tout ce qui précède suppose que la connexion vocale sache **recevoir**. Ce n'est
pas acquis : discord-player 7 ne s'appuie plus sur `@discordjs/voice` mais sur
`discord-voip`, un embranchement réduit à la diffusion dont les connexions n'ont
pas de `receiver` — le symbole `VoiceReceiver` n'y existe même pas.

Le paquet du projet demande donc la redirection de ce nom vers
`@discordjs/voice`, qui l'a. Mais npm range malgré tout une copie propre à
discord-player sous son dossier :

```
node_modules/
├── discord-voip/          ← l'alias vers @discordjs/voice, avec receiver
└── discord-player/
    └── node_modules/
        └── discord-voip/  ← la vraie discord-voip, sans receiver
```

Node cherchant d'abord dans le dossier du demandeur, c'est la seconde qui gagne,
et les `overrides` n'y peuvent rien : discord-player déclare
`discord-voip: ^7.2.0`, une plage que `@discordjs/voice@0.19.2` ne satisfait pas,
et npm renonce en silence — le verrou régénéré ressort identique.

[`tools/keep-voice-receiver.js`](../../../tools/keep-voice-receiver.js), branché
sur `postinstall`, écarte la copie imbriquée après chaque installation. Node
remonte alors d'un cran et trouve celle qui entend. Le geste doit être rejoué à
chaque fois, y compris pour les installations que le bot déclenche lui-même en
changeant de version ([06 — Persistance](06-persistance.md)).

La panne, elle, est désormais bruyante. Elle ne l'était pas : la lecture de
`receiver.speaking` levait une exception qui remontait à travers `setupDucking`,
emportant avec elle le contrôleur de volume et le diffuseur de silence, et le
journal n'affichait qu'un « Cannot read properties of undefined » sans rapport
apparent avec le son. Le `DuckingManager` vérifie maintenant l'oreille avant de
s'y brancher, et le dit.

---

## VolumeController

Encapsule `queue.node` de discord-player pour offrir des transitions
progressives.

### Notion de volume de base

`baseVolume` est le volume quand personne ne parle (0–100). `duckLevel` est un
**pourcentage de ce volume**, non une valeur absolue :

```js
volumeAtténué = round(baseVolume × duckLevel / 100)
```

Avec `baseVolume: 70` et `duckingLevel: 20`, la musique descend à 14, pas à 20.
C'est ce qui permet de régler le volume général sans dérégler l'équilibre du
ducking.

### Fondu

`_fadeTo(cible, durée)` découpe la transition en paliers de
`config.ducking.fadeStepInterval` (20 ms) et applique un incrément linéaire.
Deux raccourcis évitent le travail inutile : durée nulle ou écart inférieur à 1
point sont appliqués immédiatement.

Tout nouveau fondu annule le précédent (`_cancelFade()`), afin qu'une alternance
rapide parole/silence ne fasse pas cohabiter deux minuteurs contradictoires.

### Enchaînement de piste

`updateQueueNode()` doit être appelée à chaque changement de piste : le nœud
audio est recréé par discord-player, et l'ancienne référence devient inerte. La
méthode réapplique le volume courant — 0 si la queue est en cours de
restauration ou de transition, sinon `targetVolume` ou `baseVolume` selon que
l'on est atténué ou non.

Le contrôleur est aussi réutilisé hors ducking, pour les fondus d'entrée, de
sortie et les enchaînements DJ, via des appels directs à `_fadeTo()`.

---

## Réglages

| Clé | Défaut | Effet |
|---|---|---|
| `duckingEnabled` | `true` | Active l'atténuation |
| `duckingLevel` | `20` | Pourcentage du volume de base pendant la parole |
| `duckingDelay` | `800` | Millisecondes de silence avant restauration |
| `duckingFade` | `200` | Durée du fondu, en millisecondes |
| `baseVolume` | `70` | Volume hors parole |

Modifiables par `/ducking …`, `/volume` ou le tableau de bord. Les constantes de
défaut vivent dans [`config.js`](../../../src/config.js), les valeurs effectives
dans `data/settings.json`.

---

## Diagnostic

Les journaux de niveau `DEBUG` tracent chaque étape :

```
[Ducking Debug] Détection parole - Début pour l'utilisateur : 1234…
[Ducking Debug] Baisse du volume (duckDown) vers 20%
[Ducking Debug] Détection parole - Fin pour l'utilisateur : 1234…
[Ducking Debug] Restauration du volume planifiée dans 800ms
```

Si le ducking ne réagit pas, vérifier dans l'ordre :

1. Le bot est-il connecté au salon ? Sans connexion vocale, aucun
   `DuckingManager` n'est créé.
2. `setupDucking()` a-t-il été appelé ? Il l'est à `playerStart`, pas à la
   connexion.
3. L'utilisateur est-il dans `ignoredVoiceUsers` pour ce salon ?
4. Le bot est-il en sourdine côté serveur ? Les files sont créées avec
   `selfDeaf: false` précisément pour continuer à recevoir la voix.
