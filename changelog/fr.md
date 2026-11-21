# Journal des modifications

Toutes les évolutions du bot, de la plus récente à la plus ancienne. Chaque
entrée porte la date du jour où le changement a été livré.

<!--
    Format — lu par src/web/changelog.js, affiché par js/changelog.js.

    ## AAAA-MM-JJ — Titre de la livraison
    Une phrase de résumé, facultative.
    ### Added | Changed | Fixed | Removed | Security
    - Un changement par ligne.

    Les six mots des sections restent en anglais dans toutes les langues : ce
    sont les mots-clés de structure de Keep a Changelog, que le parseur
    reconnaît et que le tableau de bord affiche traduits. Les traduire ici
    reviendrait à tenir une table de correspondance par langue, qui se
    désaccorderait au premier synonyme.

    Le journal est écrit à la main en français et en anglais. Les autres langues
    du tableau de bord retombent sur l'anglais — voir REFERENCE_LANG dans
    src/web/changelog.js.
-->

## 2026-11-21 — L'application de bureau, propre et à soi

### Fixed
- Depuis l'ordinateur du bot, le jeton suffit à être propriétaire, même une fois la connexion Discord configurée : l'application ne vous traite plus en invité, et Quitter ou Redémarrer depuis l'icône fonctionnent de nouveau.
- Les liens externes du tableau de bord (GitHub, Buy Me a Coffee, documentation, portail Discord) s'ouvrent dans le navigateur au lieu de ne rien faire dans la fenêtre de l'application.
- L'icône de l'application a un fond transparent, et la fenêtre de démarrage affiche la vraie icône.

## 2026-11-14 — La configuration dans le tableau de bord

Le fichier `.env` se règle désormais depuis les paramètres, sans avoir à le chercher sur le disque.

### Added
- Une section « Configuration du bot » dans les paramètres, réservée au propriétaire : jeton et identifiants Discord, adresse fixe et tunnel nommé, accès au réseau local, port, dossiers de musique, plafonds et journaux. Elle signale quand un redémarrage est nécessaire et le propose.
- L'application de bureau existe aussi pour Linux : un AppImage pour toute distribution, et un paquet `.deb` pour Debian, Ubuntu et leurs dérivées.

### Fixed
- npm 12 bloquait les scripts d'installation : ffmpeg et yt-dlp n'étaient plus téléchargés, et le bot ne pouvait rien jouer.
- Deux tests échouaient sous Windows, à cause des fins de ligne CRLF et d'un dossier temporaire impossible à effacer.

### Security
- Les secrets ne sont jamais renvoyés au navigateur, et ce qui peut couper l'accès au tableau de bord ou ouvrir des dossiers du disque ne se change que depuis l'ordinateur du bot.

## 2026-11-13 — Prêt pour la première version

Les derniers réglages avant de publier la version 0.0.1.

### Changed
- Node.js 22.12 ou supérieur est désormais exigé, et vérifié au lancement : c'est le minimum réel des dépendances, que la documentation sous-estimait (Node 18).
- La politique de confidentialité et les conditions d'utilisation décrivent le relais de connexion et le partage par Cloudflare.
- L'installeur Windows n'est pas signé : la documentation explique comment passer l'avertissement de SmartScreen.

### Security
- Plus aucun avis de sécurité npm ouvert : undici passe en 6.29.1 et 7.30.2, et la lecture des fichiers locaux utilise un file-type corrigé, qui ne boucle plus sur un fichier ASF malformé.

## 2026-11-12 — Le partage par Cloudflare

Le tableau de bord se partage désormais par un tunnel Cloudflare, sans compte ni installation à faire soi-même.

### Added
- « Joindre depuis l'extérieur » télécharge cloudflared tout seul et ouvre un tunnel Cloudflare en un clic : aucun compte, aucun droit administrateur.
- Qui a un domaine chez Cloudflare peut garder une adresse fixe, en renseignant le jeton de son tunnel (`CLOUDFLARE_TUNNEL_TOKEN`) et son adresse (`PUBLIC_URL`).
- Un relais de retour fixe permet à la connexion Discord de fonctionner avec une adresse de partage qui change à chaque lancement : son adresse se déclare une seule fois dans le portail Discord.
- Les fichiers de plus de 64 Mo s'envoient en morceaux, pour passer le plafond de 100 Mo par requête de Cloudflare sans baisser la taille maximale acceptée ; une coupure ne fait renvoyer que le morceau en cours.

### Changed
- Le partage choisi est retenu, et le tunnel se rouvre au lancement suivant.
- Le limiteur de débit reconnaît chaque visiteur derrière le tunnel, au lieu de compter tout le monde comme une seule adresse.

### Removed
- Le partage par Tailscale Funnel, et les quatre étapes qu'il demandait.

## 2026-11-11 — L'application de bureau

Le bot s'installe désormais comme une application Windows, sans rien perdre de son tableau de bord dans le navigateur.

### Added
- Un installeur Windows apporte Node.js, le bot et ses dépendances : plus aucun prérequis à installer à la main.
- L'application guide la première configuration, lance le bot, et ouvre le tableau de bord dans sa propre fenêtre une fois le bot prêt ; il reste accessible dans n'importe quel navigateur, ici comme ailleurs.
- Une icône dans la zone de notification garde le bot fenêtre fermée, et permet de le rouvrir, de le redémarrer, de l'éteindre, ou de le lancer avec Windows.
- Une installation existante, avec sa configuration et ses playlists, peut être reprise telle quelle par l'application.

### Changed
- Sous l'application, un redémarrage ou un changement de version depuis le tableau de bord est relancé par l'application elle-même, qui garde ainsi la main sur le bot.

## 2026-09-14 — Le dernier avis laissé ouvert

### Security
- Le seul avis de sécurité npm encore ouvert est désormais documenté, raison comprise : `AttachmentExtractor` épingle `file-type` 16.5.4, qui boucle indéfiniment sur un fichier ASF malformé — et une boucle infinie bloque le bot entier.

## 2026-09-13 — L'audit de sécurité

Six failles refermées, de la lecture du jeton dans le journal à l'exploration du disque de l'hôte par un invité.

### Changed
- La documentation technique est remise en phase avec le code : chaque affirmation chiffrée revérifiée, cent dix-neuf commits de retard rattrapés.
- Cinq commentaires nommaient des modules et des méthodes qui avaient changé de nom ; ils désignent de nouveau ce qui existe.
- Le dépôt suit le nom qu'il a pris chez GitHub, tirets compris.

### Security
- Le jeton du tableau de bord ne paraît plus dans le journal, et le journal n'est plus servi à tout venant : un invité sans aucun droit pouvait y lire le jeton, puis le présenter.
- Les routes `/api` demandent ce que l'appelant a le droit de faire, et non plus seulement qui il est : un invité sans droit pouvait parcourir le disque de l'hôte et détourner son dossier de téléchargement.
- Une connexion Discord détournée ne vaut plus rien à qui la détourne : l'aller-retour OAuth est lié au navigateur qui l'a commencé.
- Le bot ne va plus frapper aux portes de son propre réseau : une adresse ajoutée à la file ne peut plus désigner une machine interne.
- Reprendre la propriété de l'installation demande de nouveau d'être devant la machine : le jeton circule maintenant dans la barre d'adresse et n'en est plus la preuve.
- Le gestionnaire de lecture n'explore plus le disque de l'hôte pour le compte d'un invité qui n'a que le droit d'ajouter à la file.

## 2026-09-12 — Un en-tête plus sobre

### Added
- Un appui long sur le bouton GitHub ouvre trois gestes de plus : mettre le projet en favori, le partager, signaler un problème.
- L'en-tête d'une playlist dit ce qu'elle contient : nombre de morceaux et durée totale.

### Changed
- Le bouton de lecture de « Lecture en cours » a pris le fond, la bordure et le survol de ses trois voisins ; seule sa taille le distingue encore.

### Fixed
- L'infobulle du bouton qui copie une notification n'est plus peinte sous la notification.

## 2026-09-10 — Entre la nuit et le jour

### Added
- Un appui long sur le bouton jour/nuit ouvre un curseur : 0 % la nuit, 100 % le jour, et tout ce qu'il y a entre. Le tableau de bord entier suit.

## 2026-09-09 — Ce que les commandes annoncent

### Added
- La boîte d'activité vocale montre un micro barré quand la détection est fermée, au lieu de laisser croire que personne ne parle.
- Un clic sur le numéro de version, en pied de tiroir, le copie.

### Changed
- Le relevé de disposition et le verrou général annoncent leur geste au survol.
- Les trois curseurs de préchargement gagnent un dernier cran, qui ne compte plus : « tout ».

### Fixed
- Accorder un droit à un invité fonctionne : l'interrupteur ne saute plus pour revenir aussitôt.
- Le curseur de préchargement de la file d'attente ne gouverne plus la playlist en cours.

## 2026-09-08 — Aiguillages, tranches et partage

Une playlist peut désormais renvoyer la lecture ailleurs, et les fichiers distants sont demandés par tranches au lieu d'être servis au débit de lecture.

### Added
- Une playlist peut porter un aiguillage : à l'endroit choisi, la lecture bascule vers une autre playlist ou vers la file d'attente.
- Un clic droit sur un aiguillage change sa destination, sans avoir à le supprimer et le reposer.
- La file d'attente a sa propre liste rangée, une par salon vocal.
- L'URL de rappel à déclarer chez Discord se copie depuis la fenêtre de partage.

### Changed
- À la souris comme au doigt, ce qui suit le curseur pendant un glisser-déposer est un vrai élément de la page, et non la vignette délavée du système.
- La pochette de repli d'un fichier sans image est servie par le bot, et non plus empruntée à Wikimedia.
- Les deux nombres de sonie ouvrent au clic le réglage qu'ils décrivent.
- Le bouton qui copie une adresse dit laquelle, et occupe sa propre ligne.
- L'invitation nomme le salon où elle part, et son adresse se copie.
- Les trois gestes de la fenêtre de partage ont la taille de l'envoi du lien, deux sections plus bas.
- La confirmation d'envoi se joue en trois temps qui se recouvrent, au lieu de basculer d'un coup.
- Les drapeaux du menu de langue ont les coins arrondis, liseré compris.

### Fixed
- La qualité demandée dans la boîte d'import est celle qui est réellement récupérée, et non le premier flux venu.
- Une vidéo verticale est mesurée sur son petit côté — 1080 × 1920 est du 1080p —, et le bitrate mis en cache est celui qui a été obtenu.
- Une assertion restée en arrière du code, et un fichier qui n'avait rien à faire dans le dépôt.
- Le préchargement prend la piste audio d'origine et un flux, jamais un manifeste HLS que ffmpeg ne sait pas ouvrir.
- Le préchargement demande le fichier par tranches : treize minutes pour un morceau de vingt-cinq, c'était le débit de lecture imposé par la source.
- Les téléchargements vers le disque passent par les mêmes tranches.
- Le navigateur reçoit un flux qu'il sait lire, et non une playlist d'un seul élément.
- La destination d'un aiguillage s'affiche dès qu'elle change, sans attendre un rechargement de la page.
- Un aiguillage atteint avec le mix activé enchaîne sur sa destination, et non sur un flux mort.
- La destination reprend là où le fondu l'a déjà menée, au lieu de repartir de son début.
- Le bot ouvre le tableau de bord à l'adresse où la session vit : la connexion Discord ne se redemande plus à chaque lancement.
- Le vert de la confirmation d'envoi est assez foncé pour que son libellé blanc se lise.
- Un groupe de réglages se referme, et ne fait plus que s'ouvrir.
- Le menu de langue montre des drapeaux dessinés, là où Windows n'affichait que deux lettres.

### Removed
- Un script de brouillon resté à la racine du dépôt.

## 2026-09-07 — Le chemin vers l'extérieur

Publier le tableau de bord demandait quatre gestes que rien n'annonçait ; chacun est désormais nommé avant d'être atteint.

### Added
- La fenêtre de partage lit l'état de la machine — Tailscale installé, machine connectée, tunnel monté — au lieu de laisser recopier l'adresse à la main.
- Publier le tableau de bord se fait étape par étape, chacune annoncée avant d'être atteinte.
- L'hôte voit qui frappe à la porte, au lieu de laisser l'invité disparaître sans trace.
- La boîte d'import offre des formats vidéo, et fabrique une image noire quand la source n'en porte pas.
- La résolution se choisit, et l'image fabriquée s'y conforme.

### Changed
- Le compte Discord se change depuis les réglages, maintenant que la connexion ne se fait qu'une fois.
- La section du compte dit ce qu'un tableau de bord ouvert à distance ne peut pas accorder.
- Chaque étape du partage nomme ce qu'on vient de faire, au lieu de proposer de « réexaminer ».
- Être admis et recevoir des droits sont deux choses distinctes ; et l'hôte ne figure plus dans la liste des invités.
- Le menu de qualité n'offre plus que les définitions et les débits que la source contient réellement.

### Fixed
- La trace de configuration OAuth — l'URL de rappel à déclarer, l'avertissement quand `PUBLIC_URL` manque — est enfin appelée au démarrage.
- Un même compte tient une session sur plusieurs machines à la fois, sans que l'une ferme l'autre en boucle.

## 2026-09-06 — Ce que le son ne disait pas

### Added
- La sonie du fichier en cours s'affiche à côté du volume : deux morceaux réglés pareil ne s'entendent pas pareil.
- Les deux indicateurs de sonie nomment le morceau qu'ils décrivent, pochette comprise.

### Changed
- La file, l'historique et les pistes d'une playlist s'achèvent en fondu plutôt que coupés net, et leur dernière ligne ne se confond plus avec le bord.
- Le lecteur dit pourquoi le son attend, au lieu de tomber en silence.
- Le silence est expliqué tant que le navigateur n'a pas accordé sa confiance à l'adresse du tableau de bord.

### Fixed
- Le journal n'annonce plus un délai de départ que personne n'a changé.
- Une infobulle de sonie laissée ouverte suit le changement de morceau, au lieu de nommer le précédent.

## 2026-09-05 — L'oreille et la porte

### Added
- Le tableau de bord demande de se connecter avec Discord : le jeton prouvait qu'on était devant la machine, jamais qui on était.
- Le bouton de partage joue au survol la remise du contrôle à quelqu'un qui n'est pas encore là.

### Fixed
- Le bot entend de nouveau parler : l'atténuation automatique était morte depuis le passage à discord-player 7, et rien ne le disait.
- Changer de serveur depuis le tableau de bord élit un pilote, et le journal ne prétend plus le contraire.
- Le salon favori est rappelé à l'allumage du bot, et non à chaque redémarrage.

## 2026-09-04 — Aligner les niveaux

### Added
- Chaque morceau reçoit une sonie à viser, et un interrupteur les aligne tous : quinze décibels séparent un master récent d'un enregistrement classique.

### Changed
- L'historique du champ d'ajout se lit par pochette et par nom, non par l'adresse qui a été tapée.

### Fixed
- Chacune des trois commandes d'un titre de carte répond à son propre survol, et le verrou est devenu un bouton.
- Le rebond du pavé de vitesse ne se joue que si la valeur a réellement dû bouger.
- La glissade du pavé part d'où la valeur était, non d'où l'ancienne échelle l'avait laissée.
- Une même adresse de flux désigne un seul fichier : une boucle ne peut plus mélanger deux formats et rendre du bruit blanc.

## 2026-09-03 — Le premier lancement, et le disque

Installer le bot demandait un terminal et un éditeur de texte ; le lanceur s'en charge.

### Added
- Le premier lancement passe par Discord, au lieu de renvoyer à un fichier `.env` dont personne n'explique le format.
- Une quatrième destination du champ d'ajout écrit le morceau sur le disque du bot, sans passer par le lecteur.
- La destination « disque » choisit son conteneur : MP3, M4A, FLAC, WAV, OGG, OPUS, WEBM.
- Le champ d'ajout tient son propre historique, aux couleurs du thème, au lieu de laisser faire le navigateur.
- Le dossier de téléchargement du système est à un clic dans le sélecteur de dossier.

### Changed
- Le dossier par défaut du bot rejoint les autres raccourcis, en pastille, là où l'on choisit un dossier plutôt qu'en bas où l'on valide.
- Le bouton de validation du sélecteur est centré, et posé sur un pied qui lui donne un sol.
- Le bot retient où le champ d'ajout envoie, serveur par serveur.

### Fixed
- Mettre en pause ne perd plus jusqu'à une seconde du morceau, et la reprise repart d'où l'on s'était arrêté.
- La barre de progression s'arrête où elle était, au lieu de reculer d'une fraction de seconde.
- La règle qui resserre le pied du sélecteur de dossier s'applique enfin.
- Le bouton de validation du sélecteur prend la largeur de son pied, et non une largeur fixe.
- Le trajet de particules suit la destination choisie, et sort de la page quand le fichier part sur le disque.
- La liste des formats n'est plus rognée à une seule ligne, et chaque menu dit à quoi il s'applique.

## 2026-08-29 — Les textes publics, et les gestes qui manquaient

### Added
- Les conditions d'utilisation et la politique de confidentialité que Discord demande pour la vérification, tirées du code plutôt que d'un modèle.
- La boîte d'import dit ce qu'elle accepte : un lien, une recherche, ou un chemin sur la machine du bot.
- Une notification s'écarte d'un glissement de doigt, et porte un bouton pour la fermer.
- Les boutons d'en-tête s'animent au survol, chacun annonçant ce qu'il fait.

### Changed
- Les sept fenêtres du tableau de bord se referment toutes des deux mêmes façons : la touche Échap, et le clic à côté.
- Les tiroirs respectent les quatre bords du téléphone, découpe comprise.
- L'icône d'aiguillage est remplie et non tracée : il lui manquait un pour cent d'encre pour avoir la couleur de ses cent quinze voisines.

### Fixed
- Le bouton qui vide la file vide celle qui est à l'écran, et non celle qui attend derrière une playlist.
- Un morceau est hydraté avant d'être diffusé : le tableau de bord ne reçoit plus du silence avec un code 200.
- Le bouton de lecture démarre la source quand le lecteur est vide, au lieu d'annoncer qu'il n'y a rien à jouer.
- La diffusion personnelle survit à un téléphone qui ne regarde pas.

### Removed
- La liste de tests manuels de la conversion des identifiants, dressée pour une migration achevée depuis.

## 2026-08-28 — La vidéo au doigt

Vingt changements autour de l'image et du tactile, dont trois murs successifs du plein écran d'iOS.

### Added
- Sur écran tactile, les fenêtres flottantes — la vidéo, le terminal de journal — deviennent des tiroirs : ni l'attrape par l'en-tête ni la poignée de coin n'existent sous un doigt.
- Précédent, lecture et suivant paraissent en grand au centre de l'image.
- Les erreurs du navigateur partent dans le journal du bot : sur un téléphone, une exception reste sinon dans une console que personne n'ouvrira.
- Le tableau de bord s'installe sur l'écran d'accueil du téléphone, seul moyen d'y perdre les barres du navigateur.
- Le tableau de bord dit s'il a été lancé depuis l'écran d'accueil.
- Le plein écran du système, le seul qu'iOS accorde, est offert à la vidéo.

### Changed
- Les commandes vidéo s'effacent aussi dans le tiroir, et non seulement en plein écran.
- Un appui sur l'image range les commandes autant qu'il les rappelle.
- L'image est remontée au-dessus de la barre de commandes, qui prend un quart de la hauteur sur un téléphone debout.
- Les commandes qui paraissent en fondu n'ont plus de verre dépoli : un calque dont l'opacité s'anime n'offre rien de stable à échantillonner.
- Les commandes vidéo restent tant qu'une commande est en main.
- La pastille de saut est posée sur l'image, et le disque en son centre.
- Les pastilles de saut s'écartent des boutons de transport, qui prennent plus de la moitié de la largeur sur un téléphone debout.
- Les commandes vidéo ont trois secondes avant de s'effacer, au lieu d'une seconde et demie.
- Le plein écran réellement accordé est demandé à l'appareil, au lieu d'être supposé de mémoire.
- Le plein écran du système est réservé aux vraies vidéos : le visualiseur y revenait en écran noir.

### Fixed
- La diffusion personnelle joue sans connexion vocale : un seul retour anticipé empêchait tout, loin de la maison.
- La pochette est chargée avec l'en-tête de partage qu'il faut, pour que le canevas reste utilisable.
- Le double appui est lu dans les événements tactiles et non dans les clics : reculer de dix secondes marche aussi quand les commandes se sont effacées.

### Removed
- Le plein écran du système est retiré : en diffusion personnelle le son ne vient pas de la vidéo, et trois murs successifs le rendaient intenable.

## 2026-08-27 — Le code en anglais

### Added
- Le morceau en cours paraît sur l'écran verrouillé de l'appareil, pochette comprise.

### Changed
- Le code est écrit en anglais : 342 identifiants renommés à travers le JS, le CSS, le HTML et les scripts npm, et 570 lignes de journal traduites.

### Fixed
- Le pavé de vitesse envoie la valeur que le doigt a choisie, et le ruban la suit.

## 2026-08-26 — La documentation dans sa langue

### Added
- La documentation embarquée est traduite en anglais, espagnol et allemand, et se lit dans la langue du tableau de bord.

### Fixed
- Le pavé de vitesse et la pochette restent peints sur un téléphone.
- Une connexion refusée est nommée comme telle, avec son remède : le préchargement échouait quinze minutes durant sur un verdict de disque, pour un fichier qui n'avait jamais quitté le réseau.

## 2026-08-25 — Le tableau de bord au téléphone

### Changed
- Le tableau de bord et sa documentation sont utilisables sur un téléphone, et la connexion d'un invité ne dépend plus du cache des membres — qui part vide à chaque redémarrage.

## 2026-08-22 — Retouches tactiles

### Fixed
- Ajustements de la fenêtre de documentation sur téléphone.

## 2026-08-19 — Le contrôle partagé

Le tableau de bord n'avait aucune notion de qui agissait : un jeton partagé, dans un cookie, accordait tout à qui le tenait.

### Added
- Couche d'identité et de droits, côté serveur : un droit par geste, relu à chaque message, fermé par défaut sur ce qu'il ne connaît pas.
- La fenêtre de partage et le tableau de bord d'invité, posés sur cette couche.
- La fenêtre de documentation gagne un mode de lecture vertical, à côté de sa double page.
- Un réglage affiche la grille de disposition sous les cartes.

### Changed
- Les identifiants français du code passent à l'anglais, en six lots — le protocole WebSocket avec eux.

### Fixed
- L'infobulle du bouton MD/HTML de la documentation suit le changement de langue.

## 2026-08-17 — Premiers correctifs

### Fixed
- Le salon vocal favori est enregistré et retrouvé au démarrage, et l'enchaînement de la file d'attente est corrigé.
- Les trajets de particules sont refondus, et l'ajout comme le retrait d'un serveur Discord fonctionnent depuis le tableau de bord.

## 2026-08-16 — Première version

### Added
- Lecture audio dans un salon vocal Discord, atténuation automatique du volume quand quelqu'un parle, et tableau de bord web pour tout piloter.
