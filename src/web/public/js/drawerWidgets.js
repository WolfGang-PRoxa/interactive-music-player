/**
 * Widgets du tiroir : réorganisation verticale par glisser-déposer
 *
 * Chaque `.drawer-widget` du corps du tiroir se saisit par son en-tête (ou par
 * la poignée seule au doigt) et se déplace verticalement ; l'ordre obtenu est
 * conservé dans le localStorage et réappliqué au chargement.
 */

(function() {
    'use strict';

    window.MusicPlayer = window.MusicPlayer || {};

    const STORAGE_KEY = 'music_player_drawer_widget_order';
    const DRAG_THRESHOLD = 4;      // px avant de distinguer un glissement d'un simple clic
    const EDGE_ZONE = 56;          // px : bande haute/basse déclenchant le défilement auto
    const MAX_SCROLL_STEP = 14;    // px par frame au maximum
    const SETTLE_MS = 280;         // durée de l'animation de replacement (idem CSS)

    let drawerBody = null;
    let activeDrag = null;
    let initialOrder = [];   // ordre déclaré dans le HTML, avant restauration

    function getWidgets() {
        return Array.from(drawerBody.children).filter(el => el.classList.contains('drawer-widget'));
    }

    function saveOrder() {
        const ids = getWidgets().map(w => w.dataset.widgetId).filter(Boolean);
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
        } catch (err) {}
    }

    /**
     * Réapplique l'ordre sauvegardé. Un widget ajouté depuis la dernière
     * sauvegarde n'est pas dans la liste : il conserve sa place relative en
     * étant rejeté à la fin, plutôt que de remonter en tête.
     */
    function restoreOrder() {
        let saved = null;
        try {
            saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
        } catch (err) {}
        if (!Array.isArray(saved) || saved.length === 0) return;

        const widgets = getWidgets();
        const byId = new Map(widgets.map(w => [w.dataset.widgetId, w]));

        const ordered = [];
        saved.forEach(id => {
            const widget = byId.get(id);
            if (widget && !ordered.includes(widget)) ordered.push(widget);
        });
        widgets.forEach(widget => {
            if (!ordered.includes(widget)) ordered.push(widget);
        });

        ordered.forEach(widget => drawerBody.appendChild(widget));
    }

    /** Anime les voisins depuis leur position mémorisée vers leur nouvelle place. */
    function flipNeighbours(previousTops) {
        previousTops.forEach((previousTop, widget) => {
            const delta = previousTop - widget.getBoundingClientRect().top;
            if (delta === 0) return;
            widget.style.transition = 'none';
            widget.style.transform = `translateY(${delta}px)`;
            void widget.offsetHeight;
            widget.style.transition = `transform ${SETTLE_MS}ms cubic-bezier(0.34, 1.4, 0.64, 1)`;
            widget.style.transform = '';
        });
    }

    /** Déplace le widget saisi dans le DOM sans que son rendu ne saute. */
    function relocate(drag, target, position) {
        const neighbours = getWidgets().filter(w => w !== drag.widget);
        const previousTops = new Map(neighbours.map(w => [w, w.getBoundingClientRect().top]));
        const visualTop = drag.widget.getBoundingClientRect().top;

        drag.widget.style.transform = '';
        if (position === 'before') {
            drawerBody.insertBefore(drag.widget, target);
        } else {
            drawerBody.insertBefore(drag.widget, target.nextSibling);
        }

        // Recalage de l'origine : le widget doit rester visuellement sous le curseur.
        const offset = visualTop - drag.widget.getBoundingClientRect().top;
        drag.originY = drag.lastClientY - offset;
        drag.widget.style.transform = `translateY(${offset}px)`;

        flipNeighbours(previousTops);
    }

    /** Échange le widget saisi avec le voisin dont il a franchi le milieu. */
    function reorderIfNeeded(drag) {
        const rect = drag.widget.getBoundingClientRect();
        const centerY = rect.top + rect.height / 2;

        for (const other of getWidgets()) {
            if (other === drag.widget) continue;
            const otherRect = other.getBoundingClientRect();
            const otherCenter = otherRect.top + otherRect.height / 2;
            const otherIsBefore = !!(other.compareDocumentPosition(drag.widget) & Node.DOCUMENT_POSITION_FOLLOWING);

            if (otherIsBefore && centerY < otherCenter) {
                relocate(drag, other, 'before');
                return;
            }
            if (!otherIsBefore && centerY > otherCenter) {
                relocate(drag, other, 'after');
                return;
            }
        }
    }

    function applyTransform(drag) {
        drag.widget.style.transform = `translateY(${drag.lastClientY - drag.originY}px)`;
    }

    /** Défilement automatique quand le curseur atteint le haut ou le bas du tiroir. */
    function updateAutoScroll(drag) {
        const bodyRect = drawerBody.getBoundingClientRect();
        const y = drag.lastClientY;

        if (y < bodyRect.top + EDGE_ZONE) {
            const ratio = Math.min(1, (bodyRect.top + EDGE_ZONE - y) / EDGE_ZONE);
            drag.scrollSpeed = -Math.max(1, Math.round(ratio * MAX_SCROLL_STEP));
        } else if (y > bodyRect.bottom - EDGE_ZONE) {
            const ratio = Math.min(1, (y - (bodyRect.bottom - EDGE_ZONE)) / EDGE_ZONE);
            drag.scrollSpeed = Math.max(1, Math.round(ratio * MAX_SCROLL_STEP));
        } else {
            drag.scrollSpeed = 0;
        }

        if (drag.scrollSpeed !== 0 && drag.scrollRaf === null) {
            const step = () => {
                if (!activeDrag || drag.scrollSpeed === 0) {
                    drag.scrollRaf = null;
                    return;
                }
                const before = drawerBody.scrollTop;
                drawerBody.scrollTop = before + drag.scrollSpeed;
                const applied = drawerBody.scrollTop - before;
                if (applied !== 0) {
                    // Le contenu a glissé sous le curseur : on compense pour que
                    // le widget saisi reste accroché à la souris.
                    drag.originY -= applied;
                    applyTransform(drag);
                    reorderIfNeeded(drag);
                }
                drag.scrollRaf = requestAnimationFrame(step);
            };
            drag.scrollRaf = requestAnimationFrame(step);
        }
    }

    function beginDrag(drag) {
        drag.started = true;
        drag.widget.classList.add('widget-dragging');
        document.body.classList.add('drawer-widget-drag-active');
        drag.widget.style.transition = 'none';
    }

    function finishDrag(drag) {
        window.removeEventListener('pointermove', drag.onMove);
        window.removeEventListener('pointerup', drag.onUp);
        window.removeEventListener('pointercancel', drag.onUp);
        activeDrag = null;

        drag.scrollSpeed = 0;
        if (drag.scrollRaf !== null) {
            cancelAnimationFrame(drag.scrollRaf);
            drag.scrollRaf = null;
        }

        if (!drag.started) return;

        const widget = drag.widget;
        document.body.classList.remove('drawer-widget-drag-active');
        widget.classList.remove('widget-dragging');
        widget.style.transition = `transform ${SETTLE_MS}ms cubic-bezier(0.34, 1.4, 0.64, 1)`;
        widget.style.transform = '';

        setTimeout(() => {
            widget.style.transition = '';
            widget.style.transform = '';
        }, SETTLE_MS + 20);

        saveOrder();
    }

    function onHeaderPointerDown(e) {
        if (activeDrag || e.button !== 0) return;
        if (e.target.closest('input, button, select, a, textarea')) return;

        const widget = e.currentTarget.closest('.drawer-widget');
        if (!widget) return;

        // Au doigt, seule la poignée saisit le widget : le reste de l'en-tête
        // doit rester utilisable pour faire défiler le tiroir.
        if (e.pointerType === 'touch' && !e.target.closest('.drawer-widget-handle')) return;

        if (getWidgets().length < 2) return;

        const drag = {
            widget,
            originY: e.clientY,
            startClientY: e.clientY,
            lastClientY: e.clientY,
            started: false,
            scrollSpeed: 0,
            scrollRaf: null
        };

        drag.onMove = (moveEvent) => {
            drag.lastClientY = moveEvent.clientY;

            if (!drag.started) {
                if (Math.abs(moveEvent.clientY - drag.startClientY) < DRAG_THRESHOLD) return;
                beginDrag(drag);
            }

            if (moveEvent.cancelable) moveEvent.preventDefault();
            applyTransform(drag);
            reorderIfNeeded(drag);
            updateAutoScroll(drag);
        };

        drag.onUp = () => finishDrag(drag);

        activeDrag = drag;
        window.addEventListener('pointermove', drag.onMove, { passive: false });
        window.addEventListener('pointerup', drag.onUp);
        window.addEventListener('pointercancel', drag.onUp);
    }

    window.MusicPlayer.initDrawerWidgets = function() {
        drawerBody = document.querySelector('#drawer-panel .drawer-body');
        if (!drawerBody || drawerBody._widgetsBound) return;
        drawerBody._widgetsBound = true;

        initialOrder = getWidgets().map(w => w.dataset.widgetId).filter(Boolean);
        restoreOrder();

        getWidgets().forEach(widget => {
            const header = widget.querySelector('.drawer-section-header');
            if (header) header.addEventListener('pointerdown', onHeaderPointerDown);
        });
    };

    /** Remet l'ordre d'origine défini dans le HTML. */
    window.MusicPlayer.resetDrawerWidgetOrder = function() {
        try {
            localStorage.removeItem(STORAGE_KEY);
        } catch (err) {}
        if (!drawerBody) return;

        const byId = new Map(getWidgets().map(w => [w.dataset.widgetId, w]));
        const previousTops = new Map(getWidgets().map(w => [w, w.getBoundingClientRect().top]));

        initialOrder.forEach(id => {
            const widget = byId.get(id);
            if (widget) drawerBody.appendChild(widget);
        });

        flipNeighbours(previousTops);
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', window.MusicPlayer.initDrawerWidgets);
    } else {
        window.MusicPlayer.initDrawerWidgets();
    }
})();
