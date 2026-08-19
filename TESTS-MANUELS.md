# Tests manuels — conversion des identifiants en anglais

Établi le 18 août 2026, après la conversion des six lots (`src/audio/mix`, `src/audio`,
`src/database`, `src/versioning`, `src/web` serveur, `src/web/public`) et des tests.

**Pourquoi cette liste.** `npm test` passe (102 assertions) mais ne joue pas une seconde de
musique et n'ouvre aucune page. Les trois bugs trouvés aujourd'hui — vitesse de lecture sur le
bus, état du fondu enchaîné, passage au titre suivant — sont tous passés au travers de la suite
automatisée. Ce qui suit couvre précisément ce qu'elle ne voit pas.

**Ordre.** Les sections sont classées par risque décroissant. Si le temps manque, la §1 et la §2
sont celles qui comptent.

---

## Avant de commencer

- [ ] **Recharger tout onglet du tableau de bord ouvert avant aujourd'hui (F5).** Le protocole
      WebSocket a changé de noms (`attenteAuditeur` → `listenerWait`, `sortante`/`entrante` →
      `outgoing`/`incoming`, `pilote` → `pilot`, tout le catalogue de versions). Un onglet ancien
      parlerait à un serveur neuf.
- [ ] Lancer le bot : `npm start` (ou le raccourci habituel).
- [ ] Garder le journal sous la main : `data/logs/latest.log`. Toute `TypeError` ou
      `is not a function` y apparaît immédiatement et désigne un appel resté sur un ancien nom.

---

## 1. Moteur audio — bus de mixage · *le plus exposé*

Réglages : **diffusion commune** (`everyone`) et **mix activé**. C'est le chemin qui portait les
deux bugs rétablis avec le lot `src/audio/mix`.

- [ ] **Fondu enchaîné entre deux titres.** Laisser une piste finir avec une suivante en file.
      → Les deux morceaux se superposent, sans coupure.
      → **La lecture ne saute pas au titre n+2** (le bug historique).
      → Le tableau de bord montre la transition (pochette et barre du titre entrant).
- [ ] **Passage automatique au titre suivant.** C'est le bug de ce soir (`estPilote` →
      `isPilot`). Laisser deux ou trois titres s'enchaîner d'affilée.
      → Aucun `ERROR` dans le journal à chaque fin de piste.
- [ ] **Changement de vitesse en cours de lecture** (pavé de vitesse du tableau de bord).
      → Le son change de vitesse et reprend à la position atteinte. C'était cassé
      (`moteur.appliquerVitesse` n'existait plus) : à éprouver franchement, ×0,5 puis ×2.
- [ ] **Désactiver le mix pendant qu'un fondu est en cours.**
      → Le morceau retrouve son timbre et son volume nominaux, il ne reste ni étouffé ni à
      mi-volume pour le reste de sa durée.
- [ ] **Pause / reprise**, puis **repositionnement (seek)** en pleine lecture.
- [ ] **Suivant / précédent** à la main, plusieurs fois de suite.
- [ ] **Fin de playlist → file d'attente.** Une playlist qui se termine avec des titres en file.
      → La file prend la main (`advanceToQueue`).
- [ ] **Playlist en lecture bouclée** : elle se relance seule à la fin (`restartLoopedPlaylist`).

## 2. Présence du bot et lecture figée

Lot `src/audio` : `PresenceManager` a été renommé de fond en comble (46 identifiants), et l'état
figé traverse `PlaybackSession`, `WebServer` et le tableau de bord.

- [ ] **Quitter le salon vocal, seul.** Attendre le délai de départ.
      → Le bot s'en va, la musique se fige, la file et l'historique restent affichés.
      → Le tableau de bord annonce l'attente d'un auditeur, avec le nom du salon
        (`listenerWait` + `channelName`, deux clés renommées aujourd'hui).
- [ ] **Revenir dans le salon.**
      → Le bot rejoint et **reprend à la position figée**, dans l'état où il était (en lecture ou
        en pause).
- [ ] **Pendant que la lecture est figée**, agir depuis le tableau de bord : pause, reprise,
      suivant, précédent, repositionnement (`applyFrozenCommand`).
      → Chaque commande est absorbée et se retrouve au retour du bot.
- [ ] **Changer le délai de départ** pendant qu'un compte à rebours tourne
      (`rescheduleDeparture`) → le nouveau délai s'applique tout de suite.
- [ ] **Choisir depuis le tableau de bord un salon vide** (`loadFrozenState`).
      → La file de ce salon s'affiche sans que le bot s'y connecte.

## 3. Ducking et volume

- [ ] **Parler dans le salon** pendant la lecture → le volume baisse, puis remonte à la fin.
- [ ] **Deux personnes qui parlent**, puis l'une quitte le salon en parlant (`forgetSpeaker`).
- [ ] **Fade-in au démarrage** : redémarrer le bot avec le fade-in activé
      (`pendingStartupFadein`) → le son monte progressivement au lieu d'entrer sec.

## 4. Préchargement et qualité

Lot `src/audio` : `PreloadManager` est le plus gros fichier converti (≈390 substitutions).

- [ ] **Ajouter un titre distant** → la barre de préchargement avance, puis « préchargé ».
- [ ] **Changer la qualité audio d'une piste** depuis son menu (`requalify`).
      → Flèche montante ou descendante, l'ancien fichier reste joué jusqu'à ce que le nouveau
        soit complet.
- [ ] **Redémarrer le bot pendant un préchargement**, puis le relancer.
      → Le journal annonce « préchargement partiel retrouvé … la reprise s'y raccordera » et la
        barre repart de son niveau, pas de zéro.
- [ ] Si vous avez un titre **Spotify** sous la main : le pont vers YouTube
      (`_resolveBridge`) doit trouver la même version qu'avant.

## 5. Tableau de bord — panneaux

Lot `src/web/public` : les 28 modules du tableau de bord y sont passés. Ouvrir chaque panneau
suffit à détecter une casse — une erreur JavaScript vide le panneau ou le fige.

**Gardez la console du navigateur ouverte (F12).** Une seule erreur rouge suffit à désigner le
module fautif.

- [ ] **Carte lecteur** : lecture, pause, suivant, précédent, barre de progression cliquable,
      volume, pavé de vitesse, boucle, aléatoire, téléchargement du titre.
- [ ] **File d'attente** : ajouter, réordonner par glisser-déposer, retirer, envoyer vers une
      playlist.
- [ ] **Playlists** : créer, renommer, ajouter/retirer un titre, réordonner, lancer, boucler,
      supprimer.
- [ ] **Documentation** (⚠ le module le plus retouché : 300 substitutions rien qu'aujourd'hui) :
      ouvrir, naviguer entre chapitres, basculer l'affichage une/deux colonnes, tourner les pages
      à la molette et au clavier, cliquer un lien du sommaire.
- [ ] **Journaux** : filtres par niveau, sélection d'une plage de lignes, copie de la sélection,
      copie de tout, vidage.
- [ ] **Tiroir mémoire** : ouvrir le tiroir, le graphe se dessine et défile, changer l'échelle de
      temps, survoler pour la bulle d'info.
- [ ] **Répartition mémoire** : le panneau liste les cartes et leurs poids.
- [ ] **Traînée de particules** (« Ajouter un fichier ») : la traînée relie la carte source à la
      destination choisie ; changer de destination la fait recalculer son chemin.
- [ ] **Menu qualité d'une piste** : ouvrir, lire les valeurs audio/vidéo, en changer une.
- [ ] **Menu des versions** : l'ouvrir suffit — le catalogue doit lister `V1.0.0` sans erreur
      (tout le protocole de ce menu a changé de noms aujourd'hui).
- [ ] **Réglages** : délai de départ, mix, ducking, lien d'invitation, mode d'affichage.
- [ ] **Import d'un fichier local** : vers la file, vers une playlist, en lecture immédiate.
- [ ] **Vidéo** : lancer un titre vidéo, changer la qualité, la vitesse, vérifier la resynchro.

## 6. Mode tactile (téléphone)

- [ ] **Appui long sur un titre** puis glisser pour le déplacer dans la file.
- [ ] **Glisser une carte** du tableau de bord pour la réorganiser.
- [ ] Vignette de glisser-déposer visible et bien positionnée.

## 7. Persistance et redémarrage

- [ ] **Redémarrer depuis le tableau de bord** en pleine lecture.
      → Même titre, même position, même file, même historique au retour.
- [ ] **Éteindre puis relancer** le bot.
      → Idem, et le **salon favori** est appliqué au démarrage (`applyFavoriteChannel`).
- [ ] **Changer de mode de diffusion** (commun ↔ personnel) en cours de lecture, dans les deux
      sens.

## 8. Versions — facultatif, plus lourd

`src/versioning` a été entièrement converti, deux fichiers renommés (`locations.js`,
`installer.js`), et son protocole est passé en anglais.

- [ ] Ouvrir le menu des versions → le catalogue se charge (déjà vérifié côté serveur).
- [ ] *Si vous voulez aller au bout* : installer `V1.0.0` puis basculer dessus, et revenir au
      développement. Le bot redémarre à chaque bascule. À ne tenter que si vous avez le temps de
      revenir en arrière.

---

## Si quelque chose casse

1. **Le journal d'abord** : `data/logs/latest.log`. Un `is not a function` ou une propriété
   `undefined` nomme directement l'identifiant fautif — c'est un appel resté sur un ancien nom,
   et la correction tient en une ligne.
2. **La console du navigateur** (F12) pour tout ce qui touche au tableau de bord.
3. Me donner le message tel quel suffit : chaque ancien nom a un nouveau nom connu, la
   correspondance est immédiate.

**Rien n'est commité.** Les 63 fichiers modifiés sont indexés seulement : `git stash` ou
`git checkout -- .` ramène le projet à son état d'avant la conversion si le besoin s'en fait
sentir.
