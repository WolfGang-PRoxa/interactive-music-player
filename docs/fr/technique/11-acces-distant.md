# 11 — Accès distant

[← Sommaire](README.md)

Le bot écoute par défaut sur `127.0.0.1`. Ce chapitre couvre les deux choses à
faire pour qu'il soit atteint d'ailleurs : lui donner une adresse publique, et
laisser entrer quelqu'un d'autre que son propriétaire.

---

## L'adresse publique

`PUBLIC_URL` est l'adresse par laquelle les invités atteignent ce tableau de
bord, sans barre oblique finale. **Elle ne se devine pas** : le serveur écoute
sur `127.0.0.1`, et l'adresse utile — IP du réseau local, tunnel, nom de
domaine — n'est connue que de l'exploitant.

Elle ne sert pas qu'à l'affichage. Discord exige que l'URL de rappel corresponde
**exactement** à celle déclarée dans le portail développeur, onglet *OAuth2 →
Redirects* :

```
PUBLIC_URL=http://192.168.1.20:3000
      └──► déclarer   http://192.168.1.20:3000/auth/discord/callback
```

Sans `PUBLIC_URL`, l'URL de rappel pointe sur `127.0.0.1` : le trajet
fonctionne depuis la machine hôte et échoue partout ailleurs. Un avertissement
est journalisé au démarrage dans ce cas.

C'est aussi ce qui explique le détour du jeton par le `state` OAuth : le tableau
de bord s'ouvre sur `127.0.0.1` où son cookie est posé, tandis que Discord
renvoie sur `PUBLIC_URL`. Deux hôtes, deux bocaux à cookies, et un rappel qui
n'a pas le jeton — voir [07 — Sécurité](07-securite.md#authentification).

---

## Le tunnel

Ouvrir le tableau de bord à l'extérieur demandait quatre gestes que rien
n'annonçait : installer Tailscale, authentifier la machine, obtenir du tailnet
le droit de publier, puis monter le Funnel. Chacun échoue à sa façon, et aucun
ne dit ce qui manque — on découvrait l'étape suivante en butant dessus. Pire :
l'adresse publique obtenue devait être recopiée à la main dans `PUBLIC_URL`, et
cette copie voyageait avec le dépôt. Une installation sur une seconde machine
héritait ainsi de l'adresse de la première, et l'aller-retour de connexion
Discord renvoyait l'utilisateur sur l'ordinateur d'à côté.

[`tailscale.js`](../../../src/web/tailscale.js) ne fait rien tout seul : il
**constate**. Il répond « voici où tu en es, et voici ce qui manque », dans un
vocabulaire que l'interface traduit en une phrase. Les gestes qui s'automatisent
lui sont demandés explicitement, un par un.

### Les sept états

Ils sont **ordonnés** : chacun suppose le précédent acquis, ce qui permet de les
présenter comme une progression plutôt que comme un diagnostic.

| État | Ce qui est constaté | Geste suivant |
|---|---|---|
| `absent` | La commande `tailscale` est introuvable | Installer Tailscale |
| `unreachable` | Installée, mais le démon ne répond pas | Démarrer le service |
| `needsLogin` | Machine non authentifiée sur un tailnet | `tailscale up`, ou une clé d'authentification |
| `needsCapability` | Authentifiée, mais le tailnet n'accorde pas le droit de publier | Activer HTTPS et Funnel dans la console d'administration |
| `ready` | Tout est en place ; le Funnel reste à monter | `mount()` — délibérément |
| `serving` | Le Funnel publie bien ce tableau de bord | — |
| `otherTarget` | Le Funnel publie **autre chose** | Ne pas l'écraser sans le dire |

Toute la décision tient dans `decide()`, séparée de ce qui la nourrit : elle
travaille sur deux objets déjà lus, ce qui permet de l'éprouver sur les sept
états sans installer Tailscale, ni le déconnecter, ni retirer un droit au
tailnet pour voir ce que ça donne. `inspect()` ne fait plus que porter les
seaux.

Une commande qui traîne vaut une commande absente — le démon peut être figé —,
d'où un délai de huit secondes. Et quand le `PATH` ne porte pas encore la
commande, les emplacements connus sont visités : une installation fraîche ne met
pas à jour le `PATH` des processus déjà lancés, et le bot démarré avant elle ne
verrait rien, ce que l'utilisateur prendrait pour une installation ratée.

### Ce qui ne s'automatise pas

Trois choses, et il vaut mieux le dire que le contourner :

- **L'installation** exige les droits administrateur. Un service en compte
  utilisateur ne les prend pas sans une invite du système.
- **Le compte Tailscale** ne se crée par aucune API. Une clé d'authentification
  lève l'interactivité, mais il faut déjà un compte pour l'émettre.
- **Le droit de publier** (`funnel`, `https`) est accordé par la politique du
  tailnet, donc depuis la console d'administration.

### Monter le Funnel reste un geste

Le Funnel expose le tableau de bord **à l'internet entier**, pas au réseau
local. Le monter sans l'avoir demandé publierait le lecteur de quelqu'un à son
insu : c'est la seule étape que le module refuse de faire par défaut, même quand
tout est prêt. `mount()` existe, il faut l'appeler.

L'appel se fait en `--bg` — la forme au premier plan bloquerait le démarrage du
bot — et en `--yes`, une invite de confirmation dans un service n'ayant pas de
lecteur.

### L'état n'est pas dans la diffusion ordinaire

Le constater lance deux processus. Le faire chaque seconde, pour une valeur qui
ne bouge qu'au geste de quelqu'un, serait payer cher un affichage que personne
ne regarde la plupart du temps. La fenêtre le demande en s'ouvrant, par
`tunnelState`.

Les quatre messages du domaine — `tunnelState`, `tunnelLogin`, `tunnelMount`,
`tunnelUnmount` — sont **réservés au maître de session**. Rendre le tableau de
bord joignable de l'extérieur, ou cesser de l'être, n'est pas une commande de
lecture qu'on partage.

Au démarrage, `announce()` écrit une ligne dans le journal, et chacune porte
**l'action plutôt que le constat** : « non installé » n'apprend rien à qui vient
d'ouvrir une console, « installez-le ici » si. C'est le pendant de la trace
OAuth, et pour la même raison — ce sont les deux seules choses qu'on ne peut pas
deviner en installant le bot sur une machine neuve.

---

## Faire entrer quelqu'un

Le trajet complet, du lien posté à l'invité qui pilote :

```
maître ──sendInviteLink──► le bot poste le lien dans le tchat du salon vocal
                                            │
                          l'invité clique ──┴──► GET /auth/discord
                                                       │
                                              Discord l'identifie
                                                       │
                                            GET /auth/discord/callback
                                                       │
                                        session ouverte, fiche au carnet
                                                       │
                                     tableau de bord **inerte** : aucun droit
                                                       │
maître ──admitGuest──────────────────────────────► l'invité est admis
maître ──shareControl────────────────────────────► droits accordés, geste par geste
```

L'ordre est voulu : le maître ne peut cocher des cases que pour des gens qui se
sont présentés. Un invité reconnu mais sans droit voit un tableau de bord qui
affiche tout et ne commande rien.

Le lien posté dans le tchat **ne porte pas le jeton d'accès**. C'est ce qui
permet de le poster : le jeton s'affiche dans la console de celui qui a lancé le
bot, et il vaut le contrôle total. L'invité qui clique n'apporte que son compte
Discord.

Un compte qui n'est membre d'aucun serveur du bot est refusé — à la porte comme
ailleurs.

### Se souvenir d'un invité

Une session Discord ne franchit pas la frontière entre deux navigateurs, et dure
moins longtemps que les droits qu'on accorde. Deux questions sont donc séparées,
et cette séparation suffit : **qui est cette personne ?** relève du carnet
([`guests.js`](../../../src/web/guests.js), `data/guests.json`), **cet onglet
est-il à elle ?** relève de la session
([`sessions.js`](../../../src/web/sessions.js)).

Le carnet ne contient **aucun secret** : ni jeton d'accès, ni jeton Discord,
rien qui permette de se faire passer pour quelqu'un. Y figurer signifie « ce
compte s'est authentifié au moins une fois », jamais « ce compte a le droit
de… ».

Voir [07 — Sécurité](07-securite.md#se-souvenir-dun-invité) pour la
reconnaissance muette (`prompt=none`) et ses garde-fous.

---

## En cas de modification

- Un nouveau message touchant au tunnel ou au partage doit être déclaré
  `MASTER_ONLY` dans [`permissions.js`](../../../src/web/permissions.js). Un
  message inconnu de la table l'est déjà par défaut, mais s'en remettre au repli
  rend l'intention illisible.
- Ne jamais fabriquer l'URL de rappel côté client : le portail Discord attend
  celle que le serveur construit, et une différence d'un caractère fait échouer
  tout le trajet.
- `decide()` doit rester une fonction pure de ses deux arguments. C'est ce qui
  la rend éprouvable sans Tailscale installé.
