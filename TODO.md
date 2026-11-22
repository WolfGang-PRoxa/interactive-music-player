- [ ] Problèmes côté invité lors d'un second test réalisé (Sa session était Safari sur MacOS) :
  - Nous avons remarqué un problème dont nous n'avions pas parlé lors du premier diagnostic : Comme sur téléphone sur certains navigateurs comme firefox (ancien bug), certains éléments qui ne sont plus visibles pedant un instant par l'utilisateur (car il a scroll vers le bas du dashboard)se déchargent alors qu'il serait préférable qu'ils restent affichés comme la pochette du fichier en cours de lecture dans la box "En cours de lecture", mais aussi les valeur de vitesse de lecture d'un fichier dans la même box, dans le caroussel de la vitesse de lecture des fichiers.

  **Première passe faite, à retester chez l'invité sur Safari.** Même cause que
  l'ancien bug de Firefox mobile : trop de calques de composition, et le
  navigateur cesse de peindre. Tous les remèdes existants étaient conditionnés
  au mode tactile, invisibles sur un Mac de bureau. WebKit est maintenant
  reconnu (`data-engine="webkit"` sur `<html>`) et les huit promotions
  permanentes — les trois barres par ligne de liste, la roulette de vitesse, la
  barre de progression — ne sont plus demandées chez lui. Soixante calques
  rendus pour une liste de vingt titres, sans rien changer à l'écran.

  Si la pochette disparaît encore, le levier suivant est de lui retirer son
  animation sur WebKit, comme c'est déjà fait au doigt (`device.css`, bloc
  « Budget de composition »). C'est visible — le disque cesse de tourner —,
  donc ce n'est pas fait tant que ce n'est pas nécessaire. Impossible à
  vérifier ici : aucun Safari sur ce PC.

- [x] qualité vidéo chez les invités quelques freezes rares. Nous avons constaté que la vidéo à souvent du mal à être reçu chez l'utilisateur invité. Parfois un long moment ou le dashboard essaie d'afficher une vidéo dans la fenêtre prévu à cet effet, mais rien ne se passe. Puis parfois elle fonctionne après quelques rechargement du dashboard. Mais ceci n'est pas un comportement idéal. On préfèrerait que la vidéo soit toute aussi fluide chez l'invité que chez l'hôte.
