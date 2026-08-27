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
 * ## L'approche
 *
 * Un seul constructeur d'aperçu pour les deux modes. Il retire du clone les
 * classes d'état, qui décrivent l'élément **d'origine** en train d'être
 * déplacé — estompé, à sa place —, alors que l'aperçu doit montrer l'élément
 * tel qu'il sera une fois déposé : net et entier.
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
        node.style.setProperty(
            'transform',
            `translate(${x - offsetX}px, ${y - offsetY}px)`,
            'important'
        );
    }

    /**
     * Vignette de remplacement pour le glisser à la souris.
     *
     * Écouté en phase de capture, donc avant les gestionnaires des éléments :
     * le clone est pris **avant** qu'ils n'appliquent `.is-dragging`, et montre
     * l'élément intact. L'appel n'influe que sur l'apparence — la charge utile
     * et la logique de dépôt ne sont pas touchées.
     */
    document.addEventListener('dragstart', (e) => {
        const dm = window.MusicPlayer.deviceMode;
        // Au doigt, l'aperçu est géré par touchDragDrop : la vignette native
        // n'existe pas, et un setDragImage sur un événement synthétique n'aurait
        // aucun effet.
        if (dm && dm.isTouch()) return;

        const element = e.target && e.target.closest && e.target.closest('[draggable="true"]');
        if (!element || !e.dataTransfer || typeof e.dataTransfer.setDragImage !== 'function') return;

        try {
            const { node, rect } = build(element);
            // Rendu hors champ : le navigateur doit pouvoir photographier
            // l'élément, mais il n'a pas à clignoter à l'écran.
            node.style.setProperty('position', 'fixed', 'important');
            node.style.setProperty('top', '-10000px', 'important');
            node.style.setProperty('left', '-10000px', 'important');
            document.body.appendChild(node);

            const offsetX = e.clientX - rect.left;
            const offsetY = e.clientY - rect.top;
            e.dataTransfer.setDragImage(node, offsetX, offsetY);

            // La capture est synchrone : le clone a fait son office et doit
            // partir, sans quoi il s'accumulerait à chaque glisser.
            setTimeout(() => node.remove(), 0);
        } catch (err) {
            // Vignette indisponible : le navigateur reprend la sienne, le
            // glisser fonctionne exactement comme avant.
            console.warn('[dragPreview] Custom thumbnail impossible:', err);
        }
    }, true);

    window.MusicPlayer.dragPreview = { build, moveTo, STATE_CLASSES };
})();
