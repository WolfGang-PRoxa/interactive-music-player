/*
 * touchDrawers — Le voile et la fermeture des fenêtres passées en tiroirs.
 *
 * ## Pourquoi
 *
 * Sur téléphone et tablette, la fenêtre vidéo et celle des journaux cessent de
 * flotter et deviennent des tiroirs ancrés au bord droit. Cette bascule est
 * écrite en CSS — voir css/touchDrawers.css, qui porte le détail du dispositif
 * et de l'empilement. Reste ce que la feuille de style ne sait pas faire : un
 * voile qui gèle la page derrière, et les deux gestes qui referment.
 *
 * ## L'état n'est pas tenu ici
 *
 * Un tiroir est ouvert quand son panneau n'a pas la classe `.hidden` — celle-là
 * même que l'interrupteur associé pose et retire depuis toujours, l'un dans la
 * carte « En cours de lecture », l'autre dans les paramètres d'affichage. Ce
 * module lit cette classe, il ne l'écrit jamais : refermer, ici, c'est décocher
 * l'interrupteur et laisser le code habituel faire le reste — couper le flux
 * vidéo, retenir le réglage. Un second état, tenu en parallèle, finirait par
 * diverger du premier.
 */
(function () {
  window.MusicPlayer = window.MusicPlayer || {};

  /**
   * Les fenêtres converties, de la plus haute à la plus basse dans la pile.
   *
   * L'ordre est celui des z-index de css/touchDrawers.css : il définit ce que
   * « le tiroir du dessus » désigne, c'est-à-dire celui qu'on referme quand on
   * demande à refermer.
   */
  const DRAWERS = [
    { panelId: 'video-floating-window', toggleId: 'toggle-video-mode', tabId: 'video-drawer-edge-tab' },
    { panelId: 'logs-floating-window', toggleId: 'setting-logs-enable', tabId: 'logs-drawer-edge-tab' },
  ];

  let backdrop = null;

  /** Les tiroirs n'existent qu'en mode tactile ; ailleurs, ce sont des fenêtres. */
  function isTouch() {
    const deviceMode = window.MusicPlayer.deviceMode;
    return !!(deviceMode && deviceMode.isTouch());
  }

  function isOpen(drawer) {
    const panel = document.getElementById(drawer.panelId);
    return !!(panel && !panel.classList.contains('hidden'));
  }

  /** Les tiroirs ouverts, du dessus vers le dessous. Vide au bureau. */
  function openDrawers() {
    return isTouch() ? DRAWERS.filter(isOpen) : [];
  }

  /**
   * Ouvre ou referme par l'interrupteur, seul détenteur de l'état.
   *
   * Tirer la languette ne fait donc pas qu'écarter un panneau : cela allume
   * le mode vidéo, ou active les journaux, exactement comme la case à cocher
   * correspondante. C'est voulu — les deux commandes ne peuvent pas dire
   * l'inverse l'une de l'autre.
   */
  function setOpen(drawer, open) {
    const toggle = document.getElementById(drawer.toggleId);
    if (!toggle || toggle.checked === open) return;
    toggle.checked = open;
    toggle.dispatchEvent(new Event('change'));
  }

  function closeTopmost() {
    const open = openDrawers();
    if (open.length > 0) setOpen(open[0], false);
  }

  /**
   * Aligne le voile et le corps du document sur les tiroirs ouverts.
   *
   * La classe posée sur `<body>` reprend le rôle de `drawer-is-open` pour le
   * tiroir d'activité : elle sert à la feuille de style pour retirer ce qui
   * n'a plus lieu d'être visible tant qu'un tiroir couvre l'écran.
   */
  function sync() {
    const open = openDrawers().length > 0;
    if (backdrop) backdrop.classList.toggle('active', open);
    document.body.classList.toggle('touch-drawer-is-open', open);
  }

  /**
   * Échap est déjà pris ailleurs ?
   *
   * Trois écouteurs se le partagent sur le document : le plein écran de la
   * vidéo en sort, le tiroir d'activité se referme, et celui-ci referme le
   * tiroir du dessus. Les deux premiers passent devant — ils sont, dans les
   * deux cas, ce que l'utilisateur a ouvert en dernier et voit par-dessus.
   */
  function escapeIsTaken() {
    const activityDrawer = document.getElementById('drawer-panel');
    return (
      document.body.classList.contains('video-fullscreen-active') ||
      !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement) ||
      !!(activityDrawer && activityDrawer.classList.contains('open'))
    );
  }

  function init() {
    backdrop = document.getElementById('touch-drawer-backdrop');

    /*
     * La classe `.hidden` est posée depuis plusieurs fichiers et par
     * plusieurs chemins — la bascule de l'interrupteur, le bouton de
     * fermeture, la relecture des réglages au démarrage. On observe donc le
     * résultat plutôt que de s'insérer dans chacun d'eux, comme le fait
     * déjà js/scrollLock.js pour les mêmes raisons.
     */
    const observer = new MutationObserver(sync);
    DRAWERS.forEach((drawer) => {
      const panel = document.getElementById(drawer.panelId);
      if (panel) observer.observe(panel, { attributes: true, attributeFilter: ['class'] });
    });

    if (backdrop) backdrop.addEventListener('click', closeTopmost);

    /*
     * Les languettes du bord droit, à l'appui et à l'appui seul.
     *
     * Celle du tiroir d'activité s'ouvre aussi à l'approche du curseur.
     * Copier ce réflexe ici se retournait contre nous : ces languettes
     * n'existent qu'en mode tactile, où rien ne survole, et le seul
     * `mouseenter` qui arrivait vraiment était celui du curseur resté en
     * place — le tiroir refermé glissait, découvrait la languette sous le
     * pointeur immobile, et se rouvrait aussitôt.
     */
    DRAWERS.forEach((drawer) => {
      const tab = document.getElementById(drawer.tabId);
      if (!tab) return;
      tab.addEventListener('click', () => {
        if (isTouch()) setOpen(drawer, true);
      });
    });

    /*
     * À la capture, et non à la remontée : sans quoi Échap referme deux
     * tiroirs d'un coup.
     *
     * js/drawer.js écoute le même événement et referme le tiroir
     * d'activité ; il est chargé avant ce fichier, donc appelé avant lui.
     * Le temps que la question « le tiroir d'activité est-il ouvert ? »
     * arrive ici, la réponse avait déjà changé — le tiroir venait d'être
     * refermé, et celui du dessous partait avec lui. La phase de capture
     * pose la question avant que quiconque y touche.
     */
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key !== 'Escape' || escapeIsTaken()) return;
        if (openDrawers().length === 0) return;
        e.preventDefault();
        closeTopmost();
      },
      true,
    );

    // Changer de mode change la nature des fenêtres : flottantes au bureau,
    // elles n'ont pas de voile, même restées ouvertes.
    if (window.MusicPlayer.deviceMode) {
      window.MusicPlayer.deviceMode.onChange(sync);
    }

    sync();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
