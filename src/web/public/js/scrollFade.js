/**
 * scrollFade — Les listes s'effacent à leurs bords au lieu d'être coupées net.
 *
 * ## Le problème
 *
 * Une liste qui défile se termine sur une arête franche : la piste du haut et
 * celle du bas sont tranchées à mi-hauteur, sans que rien ne distingue une piste
 * coupée par le cadre d'une piste simplement finie. Le cadre ment sur ce qu'il
 * contient.
 *
 * ## L'approche
 *
 * Un masque en dégradé, et non un calque coloré posé par-dessus.
 *
 * Les cartes sont en verre dépoli et changent avec le thème : un dégradé opaque
 * vers une couleur supposée du fond se trahirait au premier changement de style,
 * et laisserait une bande terne sur le flou. Le masque, lui, efface vers le
 * transparent — ce qui est derrière reste derrière, quel que soit le thème.
 *
 * ## Ce que le dégradé mesure
 *
 * Sa hauteur est celle de ce qui est réellement caché, plafonnée. Rien ne
 * dépasse en haut : pas de dégradé en haut. Trois pixels dépassent : trois
 * pixels de dégradé. Au-delà du plafond, il ne grandit plus.
 *
 * Deux choses en découlent, gratuitement.
 *
 * D'abord une liste courte, qui ne défile pas, n'a aucun dégradé : la marquer
 * aurait été le défaut le plus visible de tous — une première piste estompée
 * alors que rien n'est caché au-dessus d'elle.
 *
 * Ensuite l'apparition est continue. Un dégradé qui s'allume d'un coup au
 * premier pixel de défilement se remarque ; celui-ci naît de rien et grandit
 * avec ce qu'il annonce, sans qu'aucune transition n'ait à être écrite.
 *
 * ## Où l'on se raccroche
 *
 * Les conteneurs vont et viennent : la liste d'une playlist est reconstruite à
 * chaque rendu. Rien n'est donc retenu par élément — on repart de la page à
 * chaque réveil, et les réveils viennent du défilement capté à la racine, des
 * mutations des trois cartes, et d'un observateur de taille pour la poignée de
 * redimensionnement, qui ne déclenche ni l'un ni l'autre.
 */

window.MusicPlayer = window.MusicPlayer || {};

(function () {
  'use strict';

  /** Les listes concernées : celles où l'on fait défiler des pistes. */
  const SELECTOR = '.playlist-queue, .playlist-history, .playlist-tracks-list';

  /**
   * Les ancrages qui, eux, ne bougent pas.
   *
   * Deux sont les conteneurs eux-mêmes ; le troisième est le parent de la
   * liste des pistes, qui est recréée à chaque rendu de playlist et qu'on ne
   * peut donc pas observer directement.
   */
  const ROOTS = ['playlist-queue-container', 'playlist-history-container', 'active-playlist-content'];

  /** Hauteur maximale du dégradé, en pixels. */
  const FADE_PX = 18;

  let scheduled = false;

  /** Un seul passage par image, quel que soit le nombre de réveils. */
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      refresh();
    });
  }

  /**
   * N'écrit que si la valeur change.
   *
   * Le défilement réveille cette fonction à chaque image ; réécrire la même
   * valeur invaliderait le style pour rien.
   */
  function setFade(el, name, px) {
    const value = `${px}px`;
    if (el.style.getPropertyValue(name) !== value) {
      el.style.setProperty(name, value);
    }
  }

  /** Le dégradé de chaque bord vaut ce qu'il cache, dans la limite du plafond. */
  function paint(el) {
    const above = el.scrollTop;
    const below = el.scrollHeight - el.clientHeight - el.scrollTop;
    setFade(el, '--scroll-fade-top', Math.min(FADE_PX, Math.max(0, Math.round(above))));
    setFade(el, '--scroll-fade-bottom', Math.min(FADE_PX, Math.max(0, Math.round(below))));
  }

  /*
   * Les conteneurs déjà suivis en taille.
   *
   * Une carte redimensionnée par sa poignée ne déclenche ni défilement ni
   * mutation : sans cet observateur, le dégradé garderait la mesure d'avant.
   * La collection est faible, pour que les conteneurs remplacés s'oublient
   * d'eux-mêmes.
   */
  const sized = new WeakSet();
  const sizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;

  function refresh() {
    const lists = document.querySelectorAll(SELECTOR);
    for (const el of lists) {
      if (sizeObserver && !sized.has(el)) {
        sized.add(el);
        sizeObserver.observe(el);
      }
      paint(el);
    }
  }

  /**
   * Le défilement ne remonte pas la page : il se capte à la descente.
   *
   * C'est ce qui permet de ne rien enregistrer sur les conteneurs eux-mêmes,
   * et donc de survivre à leur reconstruction.
   */
  document.addEventListener('scroll', schedule, true);
  window.addEventListener('resize', schedule);

  if (typeof MutationObserver === 'function') {
    const contentObserver = new MutationObserver(schedule);
    for (const id of ROOTS) {
      const root = document.getElementById(id);
      if (root) contentObserver.observe(root, { childList: true, subtree: true });
    }
  }

  /** Appelé par les rendus qui savent avoir tout réécrit. */
  window.MusicPlayer.refreshScrollFades = schedule;

  refresh();
})();
