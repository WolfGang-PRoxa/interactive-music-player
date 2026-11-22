/**
 * dragPreview — Aperçu de l'élément déplacé, au doigt comme à la souris.
 *
 * ## Le problème
 *
 * Rien ne suivait le pointeur. À la souris, le navigateur produit bien une
 * vignette, mais il la capture au moment où les gestionnaires viennent
 * d'appliquer `.is-dragging` — soit `opacity: 0.35` et un léger rétrécissement.
 * L'utilisateur déplaçait donc un fantôme à peine visible.
 *
 * Au doigt, c'était pire : le clone héritait lui aussi de `.is-dragging`, dont
 * le `transform: scale(0.97) !important` écrasait le `translate()` chargé de le
 * faire suivre. L'aperçu restait épinglé dans le coin de l'écran.
 *
 * Corrigés tous deux, il restait une différence de nature entre les deux modes.
 * Au doigt, ce qui suit le contact est un **nœud du document** : net, entier,
 * stylable, à la densité de l'écran. À la souris, c'était la vignette du
 * système — une photographie prise au départ, figée, délavée, et rééchantillonnée
 * de travers sur un écran à forte densité. Le même geste ne donnait pas la même
 * chose selon la machine.
 *
 * ## L'approche
 *
 * Un seul constructeur d'aperçu pour les deux modes, et désormais un seul
 * mécanisme : la vignette native est effacée, et c'est le clone qu'on déplace.
 * Il retire du clone les classes d'état, qui décrivent l'élément **d'origine**
 * en train d'être déplacé — estompé, à sa place —, alors que l'aperçu doit
 * montrer l'élément tel qu'il sera une fois déposé : net et entier.
 *
 * Les propriétés de position sont posées en `!important`. Les feuilles du
 * projet emploient largement ce niveau de priorité ; sans cela, la moindre
 * règle sur `.queue-item` reprendrait la main sur le placement de l'aperçu.
 */
(function () {
  window.MusicPlayer = window.MusicPlayer || {};

  /**
   * Classes décrivant un état de glisser-déposer.
   *
   * Elles n'ont de sens que sur l'élément resté en place ou sur une cible
   * survolée. Les traîner dans l'aperçu revient à afficher un élément à moitié
   * effacé sous le doigt.
   */
  const STATE_CLASSES = [
    'is-dragging',
    'drag-over',
    'drag-over-above',
    'drag-over-below',
    'drag-over-empty',
    'drag-over-left',
    'drag-over-right',
    'dragover',
    'touch-drag-source',
  ];

  /** Retire les classes d'état d'un élément et de toute sa descendance. */
  function stripStateClasses(node) {
    STATE_CLASSES.forEach((c) => node.classList.remove(c));
    node.querySelectorAll('*').forEach((child) => {
      STATE_CLASSES.forEach((c) => child.classList.remove(c));
    });
  }

  /**
   * Construit l'aperçu d'un élément, aux dimensions qu'il occupe à l'écran.
   *
   * Le clone n'est pas inséré dans le document : c'est à l'appelant de le
   * placer, les deux usages n'ayant pas les mêmes besoins — le tactile le fait
   * suivre le doigt, le bureau le confie à `setDragImage` puis le jette.
   *
   * @param {HTMLElement} element
   * @returns {{ node: HTMLElement, rect: DOMRect }}
   */
  function build(element) {
    const rect = element.getBoundingClientRect();
    const node = element.cloneNode(true);

    stripStateClasses(node);
    node.classList.add('drag-preview');
    node.removeAttribute('id');

    const fixed = (prop, value) => node.style.setProperty(prop, value, 'important');
    fixed('width', `${rect.width}px`);
    fixed('height', `${rect.height}px`);
    fixed('margin', '0');
    fixed('opacity', '1');
    // Neutralisé ici, puis repositionné par l'appelant : `.is-dragging`
    // pose un `scale()` en !important qui écraserait tout translate.
    fixed('transform', 'none');
    fixed('transition', 'none');
    fixed('animation', 'none');
    fixed('pointer-events', 'none');

    return { node, rect };
  }

  /**
   * Déplace un aperçu sous le pointeur.
   *
   * @param {HTMLElement} node
   * @param {number} x
   * @param {number} y
   * @param {number} offsetX - Distance entre le pointeur et le bord gauche
   * @param {number} offsetY - Distance entre le pointeur et le bord haut
   */
  function moveTo(node, x, y, offsetX, offsetY) {
    node.style.setProperty('transform', `translate(${x - offsetX}px, ${y - offsetY}px)`, 'important');
  }

  /* ═════════════════════ L'aperçu vivant, à la souris ═════════════════════ */

  /**
   * Une image d'un pixel, transparente, pour effacer la vignette native.
   *
   * Le navigateur en veut une : lui passer `null` ne fait rien, et masquer la
   * sienne autrement n'est pas possible. Celle-ci est construite une fois et
   * resservie — elle est décodée d'emblée, ce que Firefox exige pour
   * l'accepter.
   */
  let blankImage = null;
  function blank() {
    if (blankImage) return blankImage;
    blankImage = new Image();
    blankImage.src = 'data:image/gif;base64,' + 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    return blankImage;
  }

  /** Le clone en cours de déplacement, et l'écart pointeur ↔ coin. */
  let ghost = null;
  let ghostOffsetX = 0;
  let ghostOffsetY = 0;

  function dropGhost() {
    if (!ghost) return;
    ghost.remove();
    ghost = null;
  }

  /**
   * Suit le pointeur.
   *
   * Les coordonnées nulles sont écartées : plusieurs navigateurs les rendent
   * sur le dernier `drag` d'un geste, et l'aperçu partirait se coller dans le
   * coin de l'écran juste avant de disparaître.
   */
  function follow(e) {
    if (!ghost) return;
    if (!e.clientX && !e.clientY) return;
    moveTo(ghost, e.clientX, e.clientY, ghostOffsetX, ghostOffsetY);
  }

  /**
   * Aperçu vivant pour le glisser à la souris.
   *
   * Le navigateur sait déjà faire suivre une vignette, mais c'est une
   * photographie : prise au départ, figée, délavée par le système, et rendue
   * approximativement sur un écran à forte densité. Au doigt, l'aperçu est un
   * vrai nœud du document qui suit le contact — net, entier, stylable. C'est
   * celui-là qu'on veut des deux côtés.
   *
   * On efface donc la vignette native et l'on déplace un clone à la place.
   *
   * Écouté en phase de capture, donc avant les gestionnaires des éléments : le
   * clone est pris **avant** qu'ils n'appliquent `.is-dragging`, et montre
   * l'élément intact plutôt qu'à demi effacé. Rien de tout cela ne touche à la
   * charge utile ni à la logique de dépôt — seulement à ce qu'on voit.
   */
  document.addEventListener(
    'dragstart',
    (e) => {
      const dm = window.MusicPlayer.deviceMode;
      // Au doigt, l'aperçu est géré par touchDragDrop : il n'y a pas de
      // glisser natif à corriger.
      if (dm && dm.isTouch()) return;

      const element = e.target && e.target.closest && e.target.closest('[draggable="true"]');
      if (!element || !e.dataTransfer) return;

      try {
        dropGhost();
        const { node, rect } = build(element);
        ghostOffsetX = e.clientX - rect.left;
        ghostOffsetY = e.clientY - rect.top;

        const fixed = (prop, value) => node.style.setProperty(prop, value, 'important');
        fixed('position', 'fixed');
        fixed('left', '0');
        fixed('top', '0');
        fixed('z-index', '99999');
        // Sans cela, l'aperçu s'interposerait entre le pointeur et les
        // cibles : le navigateur ne verrait plus où l'on veut déposer.
        fixed('pointer-events', 'none');

        document.body.appendChild(node);
        ghost = node;
        moveTo(ghost, e.clientX, e.clientY, ghostOffsetX, ghostOffsetY);

        if (typeof e.dataTransfer.setDragImage === 'function') {
          e.dataTransfer.setDragImage(blank(), 0, 0);
        }
      } catch (err) {
        // Aperçu indisponible : le navigateur garde le sien, et le glisser
        // fonctionne exactement comme avant.
        dropGhost();
        console.warn('[dragPreview] Live preview impossible:', err);
      }
    },
    true,
  );

  /*
   * Deux sources pour une même position.
   *
   * `drag` part de l'élément d'origine et suffit la plupart du temps, mais
   * certains navigateurs l'espacent ou en tarissent les coordonnées ;
   * `dragover` arrive de la cible survolée et comble les trous. Aucun des deux
   * n'est préventé : on lit, on ne décide de rien.
   */
  document.addEventListener('drag', follow, true);
  document.addEventListener('dragover', follow, true);

  // Déposé ou abandonné, l'aperçu s'en va. `dragend` suffirait presque, mais
  // il manque à l'appel quand le geste se termine hors de la fenêtre.
  document.addEventListener('dragend', dropGhost, true);
  document.addEventListener('drop', dropGhost, true);

  window.MusicPlayer.dragPreview = { build, moveTo, STATE_CLASSES };
})();
