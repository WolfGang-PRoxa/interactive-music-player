/**
 * touchDragDrop — Rend le glisser-déposer HTML5 utilisable au doigt.
 *
 * ## Le problème
 *
 * Tout le glisser-déposer du tableau de bord — réordonner la file, déplacer un
 * titre entre playlists, glisser la pochette vers la file — repose sur l'API
 * HTML5 et son `dataTransfer`. Aucun navigateur mobile n'émet ces événements :
 * au doigt, ces interactions n'étaient pas malcommodes, elles étaient
 * inaccessibles.
 *
 * ## L'approche
 *
 * Plutôt que de doubler chaque interaction d'une variante tactile, ce module
 * traduit les événements tactiles en événements de glisser-déposer authentiques,
 * dispatchés sur les mêmes éléments. Les vingt surfaces existantes continuent de
 * fonctionner sans être modifiées, et une évolution du glisser à la souris
 * profite au tactile sans effort.
 *
 * Le déclencheur est l'appui long : un simple contact doit rester un défilement,
 * sinon la moindre liste deviendrait impossible à parcourir. Un mouvement avant
 * la fin du délai annule donc la saisie et rend la main au défilement natif.
 *
 * Le contrat HTML5 est respecté : `drop` n'est émis que si le dernier `dragover`
 * a appelé `preventDefault()`, comme le font déjà tous les gestionnaires du
 * projet. Une cible qui refuse le dépôt le refuse donc aussi au doigt.
 */
(function () {
    window.MusicPlayer = window.MusicPlayer || {};

    /** Durée d'appui avant que la saisie ne commence. */
    const LONG_PRESS_MS = 350;

    /** Mouvement toléré pendant l'appui : au-delà, c'est un défilement. */
    const MOVE_TOLERANCE_PX = 10;

    /** Bande, en bas et en haut de l'écran, qui fait défiler pendant la saisie. */
    const EDGE_BAND_PX = 72;
    const EDGE_SPEED_PX = 12;

    let source = null;          // Élément saisi
    let dataTransfer = null;    // Charge utile partagée par tous les événements
    let ghost = null;           // Aperçu qui suit le doigt
    let currentTarget = null;   // Dernière cible survolée
    let dropAllowed = false;    // Le dernier dragover a-t-il accepté le dépôt ?
    let pressTimer = null;
    let startX = 0;
    let startY = 0;
    let offsetX = 0;
    let offsetY = 0;
    let edgeTimer = null;

    const isTouchMode = () => {
        const dm = window.MusicPlayer.deviceMode;
        return dm ? dm.isTouch() : false;
    };

    /**
     * Charge utile du glisser.
     *
     * `DataTransfer` est constructible dans les navigateurs récents. Le repli
     * n'en imite que ce dont le projet se sert : `setData`, `getData`,
     * `effectAllowed`, `dropEffect` et une liste de fichiers vide — un doigt ne
     * peut de toute façon pas apporter de fichier.
     */
    function createTransfer() {
        try {
            return new DataTransfer();
        } catch (e) {
            const store = new Map();
            return {
                _shim: true,
                effectAllowed: 'all',
                dropEffect: 'move',
                files: [],
                types: [],
                items: [],
                setData(type, value) { store.set(type, String(value)); this.types = [...store.keys()]; },
                getData(type) { return store.get(type) || ''; },
                clearData(type) { if (type) store.delete(type); else store.clear(); },
                setDragImage() {},
            };
        }
    }

    /**
     * Fabrique un événement de glisser positionné là où se trouve le doigt.
     *
     * Les gestionnaires du projet lisent `clientX`/`clientY` pour décider de
     * l'endroit d'insertion : sans eux, tout atterrirait au même index.
     */
    function dragEvent(type, touch) {
        const init = {
            bubbles: true,
            cancelable: true,
            composed: true,
            clientX: touch.clientX,
            clientY: touch.clientY,
            screenX: touch.screenX,
            screenY: touch.screenY,
            dataTransfer,
        };
        try {
            return new DragEvent(type, init);
        } catch (e) {
            // Repli : un MouseEvent porte les coordonnées, le transfert est
            // greffé ensuite puisque son champ n'est pas inscriptible d'origine.
            const evt = new MouseEvent(type, init);
            try {
                Object.defineProperty(evt, 'dataTransfer', { value: dataTransfer, enumerable: true });
            } catch (e2) {}
            return evt;
        }
    }

    /**
     * Prépare l'aperçu qui suivra le doigt.
     *
     * Construit **avant** que `dragstart` ne soit émis : les gestionnaires y
     * appliquent `.is-dragging`, dont le `transform: scale() !important`
     * écraserait le `translate()` chargé de faire suivre l'aperçu — qui
     * resterait alors figé dans un coin de l'écran.
     *
     * @returns {HTMLElement} Clone prêt à être inséré
     */
    function prepareGhost(element, touch) {
        const { node, rect } = window.MusicPlayer.dragPreview.build(element);
        offsetX = touch.clientX - rect.left;
        offsetY = touch.clientY - rect.top;

        const fixed = (prop, value) => node.style.setProperty(prop, value, 'important');
        fixed('position', 'fixed');
        fixed('left', '0');
        fixed('top', '0');
        fixed('z-index', '99999');
        // Sans neutralisation des pointeurs, `elementFromPoint` ne verrait que
        // l'aperçu et jamais la cible qu'il recouvre. `build` la pose déjà,
        // elle est répétée ici parce que tout en dépend.
        fixed('pointer-events', 'none');
        return node;
    }

    function moveGhost(touch) {
        if (!ghost) return;
        window.MusicPlayer.dragPreview.moveTo(
            ghost, touch.clientX, touch.clientY, offsetX, offsetY
        );
    }

    /** Fait défiler le conteneur sous le doigt quand on approche d'un bord. */
    function edgeScroll(touch) {
        stopEdgeScroll();
        const y = touch.clientY;
        const height = window.innerHeight;
        let delta = 0;
        if (y < EDGE_BAND_PX) delta = -EDGE_SPEED_PX;
        else if (y > height - EDGE_BAND_PX) delta = EDGE_SPEED_PX;
        if (delta === 0) return;

        const container = scrollableAt(touch) || document.scrollingElement;
        edgeTimer = setInterval(() => {
            if (container) container.scrollTop += delta;
        }, 16);
    }

    function stopEdgeScroll() {
        if (edgeTimer) { clearInterval(edgeTimer); edgeTimer = null; }
    }

    /** Premier ancêtre réellement défilable sous le doigt. */
    function scrollableAt(touch) {
        let node = document.elementFromPoint(touch.clientX, touch.clientY);
        while (node && node !== document.body) {
            const style = getComputedStyle(node);
            if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) {
                return node;
            }
            node = node.parentElement;
        }
        return null;
    }

    function cancelPress() {
        if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    }

    function beginDrag(element, touch) {
        source = element;
        dataTransfer = createTransfer();
        dropAllowed = false;
        currentTarget = null;

        // L'aperçu est pris avant l'événement, sur un élément encore intact.
        const preview = prepareGhost(element, touch);

        const started = element.dispatchEvent(dragEvent('dragstart', touch));
        // Un `dragstart` annulé vaut refus de la saisie, comme à la souris.
        if (!started) { source = null; dataTransfer = null; return; }

        ghost = preview;
        document.body.appendChild(ghost);
        moveGhost(touch);
        document.body.classList.add('touch-dragging');
        element.classList.add('touch-drag-source');

        // Retour haptique : sans indice, rien ne signale que la saisie a pris.
        if (navigator.vibrate) { try { navigator.vibrate(15); } catch (e) {} }
    }

    function updateTarget(touch) {
        const under = document.elementFromPoint(touch.clientX, touch.clientY);
        if (under !== currentTarget) {
            if (currentTarget) currentTarget.dispatchEvent(dragEvent('dragleave', touch));
            currentTarget = under;
            if (currentTarget) currentTarget.dispatchEvent(dragEvent('dragenter', touch));
        }
        if (!currentTarget) { dropAllowed = false; return; }

        const over = dragEvent('dragover', touch);
        currentTarget.dispatchEvent(over);
        // Contrat HTML5 : seul un `dragover` annulé autorise le dépôt.
        dropAllowed = over.defaultPrevented;
    }

    function endDrag(touch, cancelled) {
        stopEdgeScroll();

        if (source && touch) {
            if (!cancelled && currentTarget && dropAllowed) {
                currentTarget.dispatchEvent(dragEvent('drop', touch));
            } else if (currentTarget) {
                currentTarget.dispatchEvent(dragEvent('dragleave', touch));
            }
            source.dispatchEvent(dragEvent('dragend', touch));
        }

        if (ghost) { ghost.remove(); ghost = null; }
        if (source) source.classList.remove('touch-drag-source');
        document.body.classList.remove('touch-dragging');
        source = null;
        dataTransfer = null;
        currentTarget = null;
        dropAllowed = false;
    }

    document.addEventListener('touchstart', (e) => {
        if (!isTouchMode() || source || e.touches.length !== 1) return;

        const touch = e.touches[0];
        const element = e.target.closest && e.target.closest('[draggable="true"]');
        if (!element) return;

        startX = touch.clientX;
        startY = touch.clientY;
        cancelPress();
        pressTimer = setTimeout(() => {
            pressTimer = null;
            beginDrag(element, touch);
        }, LONG_PRESS_MS);
    }, { passive: true });

    document.addEventListener('touchmove', (e) => {
        if (!isTouchMode()) return;
        const touch = e.touches[0];
        if (!touch) return;

        // Avant la saisie : un mouvement franc signifie que l'utilisateur
        // voulait faire défiler, pas déplacer.
        if (pressTimer) {
            const moved = Math.abs(touch.clientX - startX) > MOVE_TOLERANCE_PX
                || Math.abs(touch.clientY - startY) > MOVE_TOLERANCE_PX;
            if (moved) cancelPress();
            return;
        }
        if (!source) return;

        // Saisie en cours : le défilement natif doit céder la place.
        e.preventDefault();
        moveGhost(touch);
        updateTarget(touch);
        edgeScroll(touch);
    }, { passive: false });

    document.addEventListener('touchend', (e) => {
        cancelPress();
        if (!source) return;
        endDrag(e.changedTouches[0], false);
    }, { passive: true });

    document.addEventListener('touchcancel', (e) => {
        cancelPress();
        if (!source) return;
        endDrag(e.changedTouches[0], true);
    }, { passive: true });

    // Un changement de mode en pleine saisie laisserait un aperçu orphelin.
    if (window.MusicPlayer.deviceMode) {
        window.MusicPlayer.deviceMode.onChange(() => {
            cancelPress();
            if (source) endDrag(null, true);
        });
    }

    window.MusicPlayer.touchDragDrop = {
        isDragging: () => source !== null,
        LONG_PRESS_MS,
    };
})();
