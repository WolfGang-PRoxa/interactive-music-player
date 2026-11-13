# 11 — Accès distant

[← Sommaire](README.md)

Le bot écoute par défaut sur `127.0.0.1`. Ce chapitre couvre les deux choses à
faire pour qu'il soit atteint d'ailleurs : lui donner une adresse publique, et
laisser entrer quelqu'un d'autre que son propriétaire.

---

## L'adresse publique

Deux cas, selon que l'adresse est fixe ou non.

**Sans adresse fixe** — le cas par défaut —, rien n'est à déclarer. Le partage
rapide (voir [le tunnel](#le-tunnel)) reçoit de Cloudflare une adresse neuve à
chaque lancement, et le relais de retour se charge de Discord.

**Avec une adresse fixe** — un domaine derrière un tunnel nommé, une IP de
réseau local —, `PUBLIC_URL` la porte, sans barre oblique finale. Elle ne se
devine pas, et Discord exige que l'URL de rappel corresponde **exactement** à
celle déclarée dans le portail développeur, onglet *OAuth2 → Redirects* :

```
PUBLIC_URL=https://imp.romainpiau.dev
      └──► déclarer   https://imp.romainpiau.dev/auth/discord/callback
```

`PUBLIC_URL` l'emporte toujours : dès qu'elle est écrite, le relais s'efface et
le trajet redevient direct. Elle est aussi ce qui explique le détour du jeton
par le `state` OAuth : le tableau de bord s'ouvre sur `127.0.0.1` où son cookie
est posé, tandis que Discord renvoie sur `PUBLIC_URL`. Deux hôtes, deux bocaux à
cookies, et un rappel qui n'a pas le jeton — voir
[07 — Sécurité](07-securite.md#authentification).

### Le relais de retour

Discord n'accepte de renvoyer un visiteur que sur une adresse déclarée
d'avance. Celle du partage rapide change à chaque lancement : il faudrait
retourner au portail à chaque démarrage. Le relais
([`oauthRelay.js`](../../../src/web/oauthRelay.js), et le Worker de
`tools/oauth-relay/`) est une étape fixe entre les deux :

```
tableau de bord ──/auth/discord──► Discord ──► relais (adresse fixe, déclarée une fois)
      ▲                                              │
      └──── /auth/discord/callback?code=… ◄──────────┘  vers l'origine lue dans le state
```

Le `state` porte, après sa part tirée au hasard, l'origine d'où la connexion
est partie. Le relais l'y renvoie avec le code. Le retour revient donc là où
vivent les cookies du navigateur — le jeton, le `nonce` de la connexion —, que
le tableau de bord soit ouvert sur `localhost` ou par le lien du tunnel.

Le relais ne voit passer qu'un code à usage unique, inutilisable sans le secret
de l'application, que seul le bot détient. Il ne garde rien et ne journalise
rien. Un relais par défaut est déployé pour toutes les installations ;
`OAUTH_RELAY_URL` en désigne un autre, et `OAUTH_RELAY_URL=off` s'en passe.

| Destination | Acceptée | Pourquoi |
|---|---|---|
| `https://….trycloudflare.com` | Oui | Le partage rapide, dont l'adresse change |
| `http://localhost:<port>`, `http://127.0.0.1:<port>` | Oui | La machine elle-même |
| Un domaine, une IP de réseau local | Non | Une adresse fixe se déclare directement chez Discord |
| Toute autre adresse | Non | Un relais ouvert ferait porter les codes chez qui l'on veut |

La règle est écrite deux fois — dans le bot et dans le Worker, qui n'importe
rien du dépôt —, et [`tests/oauthRelay.js`](../../../tests/oauthRelay.js)
éprouve les deux sur les mêmes cas.

---

## Le tunnel

Ouvrir le tableau de bord à l'extérieur passait par Tailscale Funnel, et
demandait quatre gestes que rien n'annonçait : installer Tailscale avec les
droits administrateur, créer un compte, obtenir du réseau le droit de publier,
monter le Funnel. Chaque utilisateur du bot devait refaire les quatre.

[`cloudflare.js`](../../../src/web/cloudflare.js) les remplace par deux, que le
bot fait sur un clic. `cloudflared` est un exécutable unique : il ne s'installe
pas, il se pose dans `data/bin/` et se lance, sans droits particuliers. Le bot
le télécharge depuis les publications officielles de Cloudflare, puis ouvre le
tunnel. Comme le module qu'il remplace, il **constate** d'abord, et n'agit que
sur demande.

### Les états

| État | Ce qui est constaté | Geste suivant |
|---|---|---|
| `absent` | `cloudflared` est introuvable | Le télécharger (un clic) |
| `downloading` | Le téléchargement est en cours | — |
| `needsAddress` | Jeton de tunnel nommé, mais pas de `PUBLIC_URL` | Déclarer l'adresse du tunnel |
| `ready` | Tout est en place ; le tunnel reste à ouvrir | `mount()` — délibérément |
| `starting` | Lancé, Cloudflare n'a pas encore confirmé | Attendre quelques secondes |
| `serving` | Le tableau de bord est joignable de l'internet | — |
| `failed` | Le tunnel s'est arrêté de lui-même | Réessayer, la cause est donnée |

Toute la décision tient dans `decide()`, fonction pure de ce qui a été
constaté : chaque état s'éprouve sans télécharger `cloudflared` ni ouvrir de
tunnel. Rien n'est lancé pour constater — tout est déjà dans le processus du
bot —, si bien que la fenêtre peut demander l'état aussi souvent qu'elle veut.

### Le partage rapide

C'est le mode par défaut, et il ne demande aucun compte. `cloudflared tunnel
--url` ouvre un tunnel et Cloudflare lui attribue une adresse
`https://….trycloudflare.com`, lue dans sa sortie — jamais devinée.
`api.trycloudflare.com`, qui paraît dans ses erreurs, n'en est pas une.

L'adresse change à chaque lancement. Les invités n'en souffrent pas, puisque le
lien leur est posté par le bot ; Discord, lui, passe par le relais. Elle n'est
**jamais recopiée dans `PUBLIC_URL`** : les cookies passeraient en `Secure`, et
la session de celui qui est devant la machine, en `http://localhost`, ne
tiendrait plus.

Cloudflare présente ces tunnels comme un outil d'essai : aucune garantie de
disponibilité, et un plafond de requêtes simultanées. Pour un salon entre amis,
c'est largement assez ; l'adresse fixe reste là si ça coince.

### L'adresse fixe

Qui possède un domaine chez Cloudflare crée un tunnel nommé dans son tableau de
bord (*Zero Trust → Networks → Tunnels*), lui donne un nom d'hôte qui mène à
`http://localhost:<port>`, et recopie deux valeurs dans `.env` :

```
CLOUDFLARE_TUNNEL_TOKEN=eyJhIjoi…
PUBLIC_URL=https://imp.romainpiau.dev
```

Le bot lance alors ce tunnel-là à la place du partage rapide. Le jeton passe
par l'environnement de `cloudflared` (`TUNNEL_TOKEN`) et jamais par sa ligne de
commande, où n'importe quel processus de la machine le lirait. Un tunnel nommé
ne connaît pas son propre nom d'hôte — il vit dans le tableau de bord
Cloudflare —, d'où l'état `needsAddress` quand `PUBLIC_URL` manque.

Un même tunnel ne doit tourner que sur une machine à la fois : lancé sur deux,
Cloudflare répartirait les visiteurs entre elles.

### Ce qui ne se fait jamais tout seul

Publier expose le tableau de bord à **l'internet entier**. Le faire sans
l'avoir demandé publierait le lecteur de quelqu'un à son insu : `mount()` n'est
appelé que sur un geste du maître. Ce geste est retenu (`data/tunnel.json`), et
le tunnel se rouvre au lancement suivant — comme le Funnel, qui survivait aux
redémarrages. Retirer le partage l'oublie.

Le tunnel vit avec le processus du bot et s'arrête avec lui.

Les quatre messages du domaine — `tunnelState`, `tunnelInstall`, `tunnelMount`,
`tunnelUnmount` — sont **réservés au maître de session**. Rendre le tableau de
bord joignable, ou rapporter un exécutable sur la machine de l'hôte, n'est pas
une commande qu'on partage.

### Les limites de Cloudflare

- **100 Mo par requête** sur le plan gratuit, au-delà desquels Cloudflare
  répond 413 sans que le bot n'en voie rien. Le navigateur découpe donc tout
  fichier de plus de 64 Mo, et le serveur recolle les morceaux
  ([`chunkedUpload.js`](../../../src/web/chunkedUpload.js)). `MAX_UPLOAD_MB`
  porte sur le total et garde tout son sens.
- **Une seule adresse d'origine.** Toutes les requêtes arrivent de
  `cloudflared`, donc de la machine elle-même : le limiteur de débit lit
  l'adresse réelle dans `CF-Connecting-IP`, qu'il ne croit que sur une
  connexion venue de la machine.
- **La vidéo.** Les conditions du CDN de Cloudflare réservent en principe la
  diffusion de vidéo à ses offres payantes. Un usage personnel entre amis reste
  modeste, mais le relais vidéo du tableau de bord est en zone grise.

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
- Toucher aux destinations du relais, c'est toucher aux deux copies de la règle
  — `oauthRelay.js` et `tools/oauth-relay/src/index.js` —, puis redéployer le
  Worker.
- `decide()` doit rester une fonction pure de ce qu'elle reçoit. C'est ce qui
  la rend éprouvable sans `cloudflared`.
