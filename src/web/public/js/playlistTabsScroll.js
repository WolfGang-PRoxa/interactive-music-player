/**
 * playlistTabsScroll — Défilement horizontal de la bande d'onglets de
 * playlists, et repères de bord.
 *
 * ## Pourquoi
 *
 * La bande tient sur une seule ligne et déborde ; c'est ici qu'elle se déplace.
 *
 * Le navigateur ne s'en charge pas, et c'est délibéré : une boîte réellement
 * défilable est peinte sur mobile dans un calque séparé, borné à la hauteur de
 * fenêtre d'avant la rétractation de la barre d'adresse, et cesse d'être peinte
 * au-delà — la bande d'onglets disparaissait purement et simplement en bas de
 * page. `.playlists-tabs` est donc en `overflow: hidden`, ce qui laisse
 * `scrollLeft` inscriptible tout en rendant la boîte inerte aux yeux du
 * navigateur. Voir le commentaire de cette règle dans css/queue.css, et la
 * section « Plus de défilement dans le défilement » de css/device.css.
 *
 * Ce module lui rend donc les trois choses que ce renoncement lui a coûtées.
 *
 * Le glissement au doigt, avec l'élan qui va avec : sans lui, une bande inerte
 * le serait pour de bon.
 *
 * La molette ensuite. Elle manquait de toute façon : une souris n'émet que du
 * défilement vertical, qu'aucun navigateur ne redirige vers un débordement
 * horizontal, et les onglets hors cadre étaient inatteignables sur ordinateur.
 *
 * La position enfin. Rien ne distingue une bande qui tient tout entière d'une
 * bande dont la moitié est hors cadre — l'onglet coupé au bord ressemble à un
 * onglet mal dimensionné. Ce module estompe donc le bord du côté où il reste
 * quelque chose, et seulement de ce côté-là.
 *
 * ## Ce qui n'est pas fait ici
 *
 * Aucune position n'est mémorisée, et aucun onglet n'est ramené dans le cadre à
 * la sélection. Les onglets sont reconstruits à chaque mise à jour d'état, et
 * le navigateur conserve de lui-même `scrollLeft` tant que le conteneur reste
 * le même élément — ce qui est le cas ici, seuls ses enfants changent.
 */
(function () {
  window.MusicPlayer = window.MusicPlayer || {};

  /**
   * Tolérance, en pixels, sur la comparaison des positions de défilement.
   *
   * `scrollLeft` est fractionnaire dès que l'affichage n'est pas à 100 % —
   * facteur système, zoom du navigateur — et n'atteint alors jamais exactement
   * sa borne. Sans cette marge, le repère de droite resterait allumé en bout
   * de course sur la moitié des configurations.
   */
  const TOLERANCE_PX = 2;

  /**
   * Déplacement, en pixels, au-delà duquel un contact devient un glissement.
   *
   * Aligné sur la tolérance de js/touchDragDrop.js, qui abandonne son appui
   * long au même seuil : en deçà le doigt cherche encore, au-delà les deux
   * gestes sont départagés sans jamais se disputer le contact.
   */
  const DRAG_THRESHOLD_PX = 10;

  /** Part de vitesse conservée à chaque image pendant l'élan. */
  const FRICTION = 0.94;

  /** En deçà, l'élan ne se voit plus et n'a plus qu'à s'arrêter. */
  const MIN_SPEED = 0.4;

  /**
   * Écrit une position en la ramenant dans les bornes.
   * @param {HTMLElement} bande
   * @param {number} cible
   */
  function place(strip, target) {
    const overflow = strip.scrollWidth - strip.clientWidth;
    strip.scrollLeft = Math.max(0, Math.min(overflow, target));
  }

  /**
   * Allume ou éteint les repères selon ce qui dépasse de part et d'autre.
   * @param {HTMLElement} bande
   */
  function updateMarkers(strip) {
    const overflow = strip.scrollWidth - strip.clientWidth;
    strip.classList.toggle('can-scroll-left', strip.scrollLeft > TOLERANCE_PX);
    strip.classList.toggle('can-scroll-right', strip.scrollLeft < overflow - TOLERANCE_PX);
  }

  /**
   * Convertit la molette en défilement horizontal.
   *
   * La bande ne capte l'événement que si elle peut réellement avancer dans le
   * sens demandé. Arrivée en bout de course, elle le laisse repartir vers la
   * page : sans cela, la roue bloquerait sur la bande et le tableau de bord
   * refuserait de défiler dès que le pointeur passe dessus.
   *
   * @param {HTMLElement} bande
   * @param {WheelEvent} e
   */
  function onWheel(strip, e) {
    const overflow = strip.scrollWidth - strip.clientWidth;
    if (overflow <= TOLERANCE_PX) return;

    // Les pavés tactiles et les souris à roue inclinable émettent aussi du
    // déplacement horizontal ; on prend le plus franc des deux axes.
    const step = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (!step) return;

    const atEdge = step < 0 ? strip.scrollLeft <= TOLERANCE_PX : strip.scrollLeft >= overflow - TOLERANCE_PX;
    if (atEdge) return;

    e.preventDefault();
    place(strip, strip.scrollLeft + step);
  }

  /**
   * Glissement au doigt, avec élan à la relâche.
   *
   * Il remplace le défilement natif, auquel la bande a renoncé pour ne plus
   * être peinte dans un calque à part — voir le commentaire de
   * `.playlists-tabs` dans css/queue.css. `scrollLeft` reste inscriptible sur
   * une boîte en `overflow: hidden` ; c'est seulement le geste que le
   * navigateur ne relaie plus, et qu'on lui reprend ici.
   *
   * La souris en est exclue : elle a la molette, et son glisser sert déjà à
   * réordonner les onglets.
   *
   * @param {HTMLElement} bande
   */
  function bindDrag(strip) {
    let pointer = null;
    let startX = 0;
    let startScroll = 0;
    let lastX = 0;
    let lastTime = 0;
    let speed = 0;
    let dragging = false;
    let animation = null;
    /*
     * Un glissement se termine par un `click` sur l'onglet resté sous le
     * doigt, que rien ne distingue d'une sélection délibérée : sans ce
     * témoin, faire défiler la bande changeait de playlist.
     */
    let justDragged = false;

    const stopMomentum = () => {
      if (animation === null) return;
      cancelAnimationFrame(animation);
      animation = null;
    };

    const startMomentum = () => {
      let v = speed;
      const step = () => {
        v *= FRICTION;
        if (Math.abs(v) < MIN_SPEED) {
          animation = null;
          return;
        }
        const before = strip.scrollLeft;
        place(strip, before + v);
        // Butée atteinte : insister ne ferait qu'occuper une image sur
        // deux jusqu'à extinction de la vitesse.
        if (strip.scrollLeft === before) {
          animation = null;
          return;
        }
        animation = requestAnimationFrame(step);
      };
      animation = requestAnimationFrame(step);
    };

    strip.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') return;
      stopMomentum();
      pointer = e.pointerId;
      startX = e.clientX;
      lastX = e.clientX;
      lastTime = e.timeStamp;
      startScroll = strip.scrollLeft;
      speed = 0;
      dragging = false;
    });

    strip.addEventListener('pointermove', (e) => {
      if (e.pointerId !== pointer) return;
      const delta = e.clientX - startX;

      if (!dragging) {
        if (Math.abs(delta) < DRAG_THRESHOLD_PX) return;
        dragging = true;
        // Le doigt peut sortir de la bande sans que le geste s'arrête.
        strip.setPointerCapture(pointer);
      }

      const elapsed = e.timeStamp - lastTime;
      // Ramenée à l'image de 16 ms, unité dans laquelle l'élan avance.
      if (elapsed > 0) speed = ((lastX - e.clientX) / elapsed) * 16;
      lastX = e.clientX;
      lastTime = e.timeStamp;

      place(strip, startScroll - delta);
    });

    const release = (e) => {
      if (e.pointerId !== pointer) return;
      if (dragging && strip.hasPointerCapture(pointer)) {
        strip.releasePointerCapture(pointer);
      }
      pointer = null;
      if (!dragging) return;
      dragging = false;
      justDragged = true;
      startMomentum();
    };

    strip.addEventListener('pointerup', release);
    strip.addEventListener('pointercancel', release);

    // En capture : le clic doit être intercepté avant d'atteindre l'onglet,
    // pas après. Le témoin ne vaut que pour ce clic-ci.
    strip.addEventListener(
      'click',
      (e) => {
        if (!justDragged) return;
        justDragged = false;
        e.preventDefault();
        e.stopPropagation();
      },
      true,
    );
  }

  /**
   * Branche la bande d'onglets. Sans effet si elle l'est déjà.
   * @returns {boolean} false si la bande n'est pas encore dans le document
   */
  function init() {
    const strip = document.getElementById('playlists-tabs-container');
    if (!strip) return false;
    if (strip.dataset.scrollInit === 'true') return true;
    strip.dataset.scrollInit = 'true';

    const refresh = () => updateMarkers(strip);

    strip.addEventListener('scroll', refresh, { passive: true });
    // `passive: false` est indispensable : sans lui, `preventDefault` est
    // ignoré et la page défilerait en même temps que la bande.
    strip.addEventListener('wheel', (e) => onWheel(strip, e), { passive: false });
    bindDrag(strip);

    /*
     * Deux sources de changement, toutes deux hors de notre contrôle : la
     * largeur disponible — rotation de l'écran, redimensionnement de la
     * carte dans la grille — et la liste des onglets, reconstruite à chaque
     * mise à jour d'état par updatePlaylistsUI. Les observer dispense d'un
     * point d'accroche dans js/playlists.js, qui n'aurait aucune raison de
     * connaître ce module.
     */
    if (window.ResizeObserver) {
      new ResizeObserver(refresh).observe(strip);
    } else {
      window.addEventListener('resize', refresh);
    }
    if (window.MutationObserver) {
      new MutationObserver(refresh).observe(strip, { childList: true, subtree: true });
    }

    refresh();
    return true;
  }

  window.MusicPlayer.initPlaylistTabsScroll = init;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
