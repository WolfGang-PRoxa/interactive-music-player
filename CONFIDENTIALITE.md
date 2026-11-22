# Politique de confidentialité

**Interactive Music Player**
Dernière mise à jour : 13 novembre 2026

---

## 1. En bref

- **L'auteur du Logiciel ne collecte aucune donnée.** Aucune télémétrie,
  aucune statistique d'usage, aucun rapport d'erreur envoyé. Le seul service
  qu'il fait tourner est un relais de connexion qui ne garde rien (voir
  [section 3](#3-ce-que-lauteur-collecte)).
- Chaque instance tourne sur la machine de la personne qui l'installe. Toutes
  les données restent dans le dossier `data/` de cette machine.
- **Aucun audio n'est enregistré.** Le bot sait _qu'une_ personne parle, jamais
  _ce qu'elle_ dit.
- **Aucun contenu de message n'est lu.** L'intention privilégiée
  _Message Content_ n'est pas activée.

---

## 2. Qui est responsable du traitement

Le Logiciel est **auto-hébergé** : il n'existe aucune instance publique
exploitée par l'auteur (voir
[Conditions d'utilisation, article 2](CONDITIONS.md#2-la-distribution-par-auto-hébergement)).

|                               |                                                                                                                            |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Responsable de traitement** | L'**exploitant** — la personne ou l'entité qui installe le Logiciel, crée l'application Discord et fait tourner l'instance |
| **Rôle de l'auteur**          | Éditeur du code source. Ni responsable de traitement, ni sous-traitant : il n'a accès à aucune instance ni à aucune donnée |

Pour exercer un droit sur des données traitées par une instance donnée, il faut
donc s'adresser à **l'exploitant de cette instance** — la personne qui a invité
le bot sur le serveur Discord concerné. L'auteur n'a matériellement aucun moyen
d'accéder à ces données, ni de les corriger, ni de les supprimer.

---

## 3. Ce que l'auteur collecte

Rien.

Le Logiciel n'envoie aucune donnée à l'auteur, sous aucune forme. Il ne contient
ni traceur, ni sonde analytique, ni service de rapport de plantage. Le code
source est public et vérifiable.

La consultation des versions disponibles passe par l'API publique de GitHub
(`api.github.com`). Cette requête est adressée à **GitHub**, pas à l'auteur, et
ne transporte aucune donnée d'usage : GitHub voit l'adresse IP de la machine,
comme pour toute visite de la page du dépôt.

### Le relais de connexion

Le seul service exploité par l'auteur est le **relais de retour OAuth**,
`imp-auth.romainpiau.dev`, hébergé sur Cloudflare Workers. Il ne sert que
lorsqu'un invité se connecte avec son compte Discord à un tableau de bord
partagé par un tunnel rapide (adresse en `trycloudflare.com`, qui change à
chaque lancement) : Discord exige une adresse de retour fixe, et le relais en
tient lieu.

- **Ce qu'il reçoit** : le navigateur de l'invité y passe une fois, avec le code
  d'autorisation de Discord et l'adresse du tunnel d'où la connexion est
  partie. Il renvoie aussitôt le navigateur vers cette adresse.
- **Ce qu'il garde** : rien. Aucun stockage, aucun journal applicatif. Le code
  d'autorisation ne vaut rien sans le secret de l'application Discord, que seul
  le bot de l'exploitant détient.
- **Ce que voit Cloudflare** : comme pour toute requête web, l'hébergeur voit
  l'adresse IP et les en-têtes du navigateur, selon sa
  [politique de confidentialité](https://www.cloudflare.com/privacypolicy/).

L'exploitant peut s'en passer : avec une adresse fixe (`PUBLIC_URL`, par exemple
un tunnel nommé sur son propre domaine), avec son propre relais
(`OAUTH_RELAY_URL`), ou en le coupant (`OAUTH_RELAY_URL=off`).

---

## 4. Données traitées localement par une instance

Ces données sont écrites dans le dossier `data/` de la machine de l'exploitant.
Elles ne quittent jamais cette machine.

| Fichier               | Données                                                                                                                                                                                                    | Finalité                                                                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `settings.json`       | Identifiants de serveurs et de salons Discord ; réglages par serveur (volume, ducking, vitesse) ; identifiants des membres exclus de la détection de parole ; playlists (titres, URL, chemins de fichiers) | Conserver les réglages et les playlists d'une session à l'autre                                                |
| `playback_state.json` | Par serveur et par salon : piste en cours, position, file d'attente, historique, mode de répétition, état lecture ou pause                                                                                 | Reprendre la lecture au point exact après un redémarrage                                                       |
| `sessions.json`       | Par invité connecté : identifiant Discord, nom d'utilisateur, nom affiché, URL de l'avatar, date de création et date de dernière activité de la session                                                    | Reconnaître un invité du tableau de bord pour lui appliquer les droits que le maître de session lui a accordés |
| `dashboard-token`     | Le jeton d'accès au tableau de bord (permissions `0600`)                                                                                                                                                   | Protéger le tableau de bord                                                                                    |
| `logs/*.log`          | Journaux techniques : événements de lecture, erreurs, et selon le niveau retenu, identifiants de serveurs, de salons et de membres                                                                         | Diagnostic                                                                                                     |
| `cache/*`             | Fichiers audio préchargés des pistes à venir                                                                                                                                                               | Démarrage instantané, résistance aux coupures réseau                                                           |
| `uploads/*`           | Fichiers médias importés par les utilisateurs du tableau de bord, sous le nom `<empreinte>-<nom d'origine>`                                                                                                | Rendre les imports rejouables                                                                                  |

Aucune de ces données n'est vendue, louée, partagée ni transmise à un tiers par
le Logiciel.

---

## 5. Ce que le Logiciel ne fait pas

Ce point mérite d'être explicite, car un bot vocal peut légitimement inquiéter.

**Il n'enregistre, ne stocke, ne transmet et n'analyse aucun audio.**

L'atténuation automatique du volume (_ducking_) repose sur les événements
`speaking` `start` et `end` de la connexion vocale Discord. Ces événements ne
portent qu'une information : _tel identifiant de membre a commencé ou cessé
d'émettre_. Le Logiciel ne s'abonne à aucun flux audio entrant. Il n'existe dans
le code aucun chemin par lequel une voix pourrait être capturée, écrite sur
disque ou envoyée ailleurs — cela se vérifie dans
[`src/audio/DuckingManager.js`](src/audio/DuckingManager.js).

**Il ne lit le contenu d'aucun message.** L'intention privilégiée
_Message Content_ n'est ni requise, ni activée. Le bot ne fonctionne qu'avec
trois intentions non privilégiées : `Guilds`, `GuildVoiceStates` et
`GuildMessages`.

**Il ne dresse aucune liste de membres.** L'intention _Server Members_ n'est pas
activée.

**Il ne suit aucun statut de présence.** L'intention _Presence_ n'est pas
activée.

**Il ne profile personne et n'automatise aucune décision** produisant des effets
juridiques.

---

## 6. Données reçues de Discord

### Intentions de la passerelle

| Intention          | Privilégiée | Ce qu'elle apporte                                                 |
| ------------------ | ----------- | ------------------------------------------------------------------ |
| `Guilds`           | Non         | Liste des serveurs et des salons, pour savoir où le bot peut jouer |
| `GuildVoiceStates` | Non         | Qui est connecté à quel salon vocal, et les événements de parole   |
| `GuildMessages`    | Non         | Réception des commandes, sans accès au contenu des messages        |

### Connexion OAuth2 des invités

Le tableau de bord peut, si l'exploitant configure `DISCORD_CLIENT_SECRET`,
proposer à des invités de se connecter avec leur compte Discord afin de leur
déléguer une partie du contrôle.

Cette connexion demande la **seule portée `identify`** — le strict minimum. Elle
donne accès à l'identifiant, au nom d'utilisateur, au nom affiché et à l'avatar.
Elle ne donne accès ni à l'adresse e-mail, ni aux serveurs, ni aux messages, ni
aux connexions associées au compte.

Le jeton d'accès Discord obtenu est utilisé une seule fois, pour lire ce profil,
puis abandonné : il n'est jamais enregistré sur disque.

Un invité refuse ce traitement en ne se connectant pas ; il conserve alors
l'accès qu'autorise le jeton partagé du tableau de bord.

---

## 7. Cookies

Le tableau de bord dépose deux cookies, tous deux strictement nécessaires à son
fonctionnement. Aucun cookie publicitaire, aucun cookie de mesure d'audience.

| Cookie              | Contenu                             | Durée              | Rôle                                                                                                                              |
| ------------------- | ----------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `dashboard_token`   | Le jeton d'accès                    | 1 an               | Éviter de replacer le jeton dans l'URL à chaque visite, et permettre au navigateur de charger les médias et d'ouvrir le WebSocket |
| `dashboard_session` | Un identifiant de session aléatoire | 30 jours glissants | Rattacher l'onglet à l'identité Discord de l'invité                                                                               |

Les deux sont `httpOnly` et `sameSite=lax` : le JavaScript de la page ne peut
pas les lire, et ils ne partent pas avec une requête déclenchée depuis un autre
site.

---

## 8. Durées de conservation

| Donnée                | Conservation                                                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Sessions d'invités    | 30 jours sans activité, puis suppression automatique. Chaque requête repousse l'échéance                                |
| Journaux              | Les 20 fichiers les plus récents par défaut, réglable par `LOG_RETENTION`. Les plus anciens sont supprimés au démarrage |
| Réglages et playlists | Jusqu'à suppression par l'exploitant                                                                                    |
| État de lecture       | Écrasé en continu ; ne conserve que le dernier état connu                                                               |
| Cache audio           | Jusqu'à suppression par l'exploitant                                                                                    |
| Fichiers importés     | Jusqu'à suppression par l'exploitant                                                                                    |

Un exploitant supprime l'intégralité des données en effaçant le dossier `data/`.

---

## 9. Destinataires et services tiers

Le Logiciel ne transmet de données à aucun tiers à des fins commerciales. Il
adresse en revanche des requêtes techniques aux services suivants, chacun régi
par sa propre politique de confidentialité :

| Service                         | Ce qu'il reçoit                                                                                                                                                            | Politique                                                                                                                   |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Discord**                     | Les appels d'API du bot et l'aller-retour OAuth2                                                                                                                           | [discord.com/privacy](https://discord.com/privacy)                                                                          |
| **YouTube / Google**            | Les recherches et les requêtes de flux, avec l'adresse IP de la machine hôte                                                                                               | [policies.google.com/privacy](https://policies.google.com/privacy)                                                          |
| **Spotify**                     | Les requêtes de métadonnées, si des identifiants sont configurés                                                                                                           | [spotify.com/legal/privacy-policy](https://www.spotify.com/legal/privacy-policy/)                                           |
| **SoundCloud**, **Apple Music** | Les requêtes de métadonnées et de flux                                                                                                                                     | Politiques respectives                                                                                                      |
| **GitHub**                      | La consultation des versions publiées, le téléchargement d'une mise à jour et celui de `cloudflared`                                                                       | [docs.github.com — GitHub Privacy Statement](https://docs.github.com/site-policy/privacy-policies/github-privacy-statement) |
| **Cloudflare**                  | Si l'exploitant partage son tableau de bord par un tunnel : tout le trafic des visiteurs, chiffré jusqu'au réseau de Cloudflare ; et le passage par le relais de connexion | [cloudflare.com/privacypolicy](https://www.cloudflare.com/privacypolicy/)                                                   |

Ces requêtes partent de la machine de l'exploitant. C'est **son adresse IP** qui
est exposée à ces services, pas celle des membres du serveur Discord.

**Transferts hors Union européenne.** Ces services sont susceptibles de traiter
les requêtes en dehors de l'UE, selon leurs propres garanties. Un exploitant
soucieux de ce point limitera les sources utilisées, par exemple aux fichiers
locaux.

---

## 10. Sécurité

Les protections en place sont décrites en détail dans la
[documentation technique](docs/fr/technique/07-securite.md). En résumé :

- Le tableau de bord n'écoute que sur `127.0.0.1` par défaut ; l'ouvrir au
  réseau ou le partager par un tunnel Cloudflare est une décision explicite de
  l'exploitant.
- Toute requête HTTP et toute connexion WebSocket sont authentifiées avant
  d'atteindre la moindre route.
- La comparaison du jeton est faite en temps constant, pour ne pas le révéler
  par mesure du temps de réponse.
- Les fichiers servis sont restreints à une liste de racines autorisées, avec
  résolution des liens symboliques : un chemin arbitraire du disque est refusé.
- Le jeton du tableau de bord est écrit avec les permissions `0600`.

Aucune mesure ne rend un système inviolable. La sécurité effective d'une
instance dépend de la machine qui l'héberge, du réseau sur lequel elle est
exposée et de la discrétion de l'exploitant sur ses jetons.

---

## 11. Vos droits

Le RGPD ouvre aux personnes concernées un droit d'accès, de rectification,
d'effacement, de limitation, d'opposition et de portabilité.

Ces droits s'exercent **auprès de l'exploitant de l'instance** concernée, seul à
détenir les données. En pratique, sur une instance :

- **Accès et portabilité** — les données sont dans des fichiers JSON lisibles du
  dossier `data/` ;
- **Effacement** — supprimer `data/sessions.json` déconnecte tous les invités ;
  supprimer le dossier `data/` efface tout ;
- **Opposition** — un membre peut être exclu de la détection de parole depuis le
  tableau de bord ; il suffit également de ne pas se connecter en OAuth2 pour
  qu'aucun profil ne soit enregistré ;
- **Retrait du bot** — un administrateur de serveur retire le bot à tout moment,
  ce qui met fin à tout traitement pour ce serveur.

L'auteur du Logiciel ne peut donner suite à aucune de ces demandes : il n'a
accès à aucune donnée. Les demandes qui lui parviendraient ne pourront être que
réorientées.

Toute personne estimant ses droits méconnus peut saisir l'autorité de contrôle
de son pays — en France, la [CNIL](https://www.cnil.fr).

---

## 12. Mineurs

Le Logiciel s'adresse aux utilisateurs remplissant les conditions d'âge de
Discord : treize ans révolus, ou l'âge minimum supérieur exigé localement. Il ne
cible pas les enfants et ne recueille sciemment aucune donnée les concernant.

---

## 13. Modifications

Cette politique peut être révisée. La version applicable est celle publiée sur
la branche `main` du dépôt, dont l'historique Git tient lieu de journal des
modifications. La date en tête de document signale la dernière révision.

---

## 14. Contact

Pour une question sur cette politique ou sur le fonctionnement du Logiciel :
[issues GitHub du dépôt](https://github.com/WolfGang-PRoxa/interactive-music-player/issues).

Pour une demande portant sur des données traitées par une instance rencontrée
sur un serveur Discord, s'adresser à la personne qui a invité le bot sur ce
serveur : elle seule en est l'exploitant, et elle seule détient ces données.

---

_[English version](PRIVACY.md) · [Conditions d'utilisation](CONDITIONS.md)_
