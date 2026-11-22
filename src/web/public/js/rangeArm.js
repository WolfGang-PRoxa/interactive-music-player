/**
 * rangeArm — Les deux gestes de la zone d'un curseur.
 *
 * ## Le problème
 *
 * Un `<input type="range">` réglé à la molette change de valeur dès qu'elle
 * passe dessus. Le panneau des réglages est long : descendre vers une section
 * modifiait au passage tout ce qui se trouvait sous le pointeur — la durée d'un
 * fondu, un délai de départ —, sans que rien ne l'annonce. Et comme le geste
 * était pris sans condition, le panneau refusait même de défiler tant que le
 * pointeur touchait une piste.
 *
 * Le focus sert donc d'armement : tant qu'un curseur ne l'a pas, la molette
 * appartient au panneau. Encore faut-il pouvoir le lui donner, et la réponse
 * native ne convenait pas — sur un curseur, l'appui qui focalise **déplace la
 * pastille à l'endroit visé**. Le geste d'armement réglait donc le curseur,
 * exactement ce qu'on cherchait à éviter, déplacé d'un cran.
 *
 * ## Ce que ce module fait
 *
 * Il pose les deux gestes sur **la boîte qui contient le curseur**, et non sur la
 * piste.
 *
 *  - **Le clic arme, sans rien déplacer.** L'action par défaut de l'appui est
 *    refusée et le focus donné à la main : c'est le seul moyen de séparer les
 *    deux, le navigateur les liant dans le même geste. Une fois armé, le curseur
 *    retrouve son comportement natif — la pastille saute où l'on vise, et le
 *    glissement suit. D'où la règle, en un mot : le premier clic choisit, le
 *    second règle.
 *
 *  - **La molette règle, une fois armé.** Elle aussi depuis toute la zone : la
 *    piste fait six pixels de haut, et le geste doit répondre partout où l'œil
 *    voit le réglage — la marge, le libellé, la pastille de valeur. L'événement
 *    remonte de la piste jusqu'à la zone, donc le cas direct ne perd rien.
 *
 * **Pourquoi les deux ensemble.** Ils doivent s'accorder sur ce qu'est la zone.
 * Écrits séparément, l'un pourrait armer depuis un endroit que l'autre ignore, et
 * le curseur se retrouverait armé sans répondre — un défaut qu'on mettrait
 * longtemps à comprendre. Une seule définition, ici, ferme la question.
 *
 * ## Ce qu'il ne fait pas
 *
 * Rien sous un doigt. Il n'y a là ni molette qui passe ni flèches à diriger :
 * l'appui n'a rien à armer, et exiger deux gestes au lieu d'un serait une
 * régression pure. `deviceMode.isTouch()` tranche, comme pour l'ouverture du
 * tiroir d'activité à l'approche du curseur (js/drawer.js).
 *
 * Et rien sur les boutons de la ligne, dont le clic reste le leur : la remise à
 * la valeur par défaut est une commande à part entière. La molette, elle, agit
 * même au-dessus d'eux — elle ne leur dispute rien.
 *
 * ## Ce qu'il ne sait pas
 *
 * Comment appliquer un cran. Chaque curseur le fait à sa façon — l'un émet un
 * `input` que le panneau écoute, un autre écrit dans le localStorage, un
 * troisième repeint une fenêtre —, et ces différences n'ont pas à remonter ici.
 * L'appelant fournit donc le geste, et ce module ne décide que du *quand*.
 */

window.MusicPlayer = window.MusicPlayer || {};

(function () {
  'use strict';

  /**
   * La zone d'un curseur : la boîte qui le contient.
   *
   * Le parent, et non une classe : les conteneurs ne portent pas le même nom
   * d'un endroit à l'autre — le cadre des réglages, la ligne du tiroir, le
   * groupe d'opacité d'une fenêtre. Le parent, lui, est toujours le bon, et se
   * lit sans table de correspondance à tenir à jour.
   *
   * @param {HTMLInputElement} range
   * @returns {HTMLElement}
   */
  function zoneOf(range) {
    return (range && range.parentElement) || range;
  }

  /** Un écran tactile n'a rien à armer — voir l'en-tête du module. */
  function isTouch() {
    const deviceMode = window.MusicPlayer.deviceMode;
    return Boolean(deviceMode && typeof deviceMode.isTouch === 'function' && deviceMode.isTouch());
  }

  /**
   * Arme un curseur au clic dans sa zone, et y règle à la molette une fois
   * armé.
   *
   * @param {HTMLInputElement} range curseur à armer
   * @param {(wheel: WheelEvent) => void} applyNotch applique un cran de molette
   */
  window.MusicPlayer.armRange = function (range, applyNotch) {
    if (!range) return;

    const zone = zoneOf(range);
    // Deux jeux d'écouteurs sur la même zone feraient le travail deux fois,
    // et une initialisation rejouée n'a pas à s'en préoccuper.
    if (zone.dataset.rangeArmed === 'true') return;
    zone.dataset.rangeArmed = 'true';

    /*
     * `mousedown` et non `pointerdown` : c'est à l'appui de la souris que le
     * navigateur attache le déplacement de la pastille et le glissement qui
     * suit, et c'est donc lui qu'il faut refuser. Prendre l'événement de
     * pointeur reviendrait au même sur un écran tactile, où l'on ne veut
     * précisément rien changer.
     */
    zone.addEventListener('mousedown', (e) => {
      if (isTouch()) return;

      // Les commandes de la ligne gardent leur geste.
      if (e.target && e.target.closest && e.target.closest('button')) return;

      // Déjà armé : le clic reprend son office natif.
      if (document.activeElement === range) return;

      e.preventDefault();
      /*
       * `preventScroll` parce que le curseur est sous le pointeur, donc
       * déjà à l'écran : le seul effet que le défilement automatique
       * pourrait avoir ici serait de déplacer la page sous la main qui
       * vient de cliquer.
       */
      range.focus({ preventScroll: true });
    });

    if (typeof applyNotch !== 'function') return;

    zone.addEventListener(
      'wheel',
      (e) => {
        // Pas armé : la molette appartient au panneau, qui défile comme
        // partout ailleurs. C'est aussi ce qui rend le geste non passif
        // nécessaire — il refuse le défilement dans un cas et le laisse dans
        // l'autre.
        if (document.activeElement !== range) return;
        e.preventDefault();
        applyNotch(e);
      },
      { passive: false },
    );
  };
})();
