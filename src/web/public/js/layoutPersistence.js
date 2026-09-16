/**
 * Disposition des boîtes du tableau de bord : placement, déplacement,
 * redimensionnement, verrouillage et sauvegarde.
 *
 * Grille orthonormée de 48 colonnes à cellules carrées. Chaque boîte y occupe
 * un rectangle `{ colStart, colSpan, rowStart, rowSpan }` ; une fois un geste
 * terminé, deux boîtes ne se chevauchent jamais.
 *
 * ## Ce que fait un déplacement
 *
 * Le système précédent recalculait tout à chaque mouvement de souris, à partir
 * de la disposition qu'il venait lui-même de bousculer : les boîtes heurtées
 * descendaient, puis toutes remontaient se tasser en haut de la grille. Rien ne
 * revenait en place quand on rebroussait chemin, la boîte posée remontait elle
 * aussi au relâchement, et le tableau entier sautait sans qu'on puisse dire
 * pourquoi. Les règles sont désormais :
 *
 *  1. La boîte saisie suit le pointeur au pixel près ; un emplacement en
 *     pointillés montre, calé sur la grille, où elle se posera.
 *  2. **Aucun aimant.** Une boîte que rien ne heurte ne bouge pas, et un espace
 *     vide reste vide.
 *  3. **Au-dessus d'un espace libre**, l'emplacement s'y cale. S'il n'y tient
 *     pas tout à fait, il glisse vers la place libre la plus proche — sans rien
 *     pousser.
 *  4. **Au-dessus d'une autre boîte** — la moitié au moins de la plus petite
 *     des deux recouverte —, les deux boîtes **échangent leur place**. Si leurs
 *     tailles diffèrent, ce qui gêne descend, juste assez.
 *  5. **Une boîte verrouillée ne bouge jamais**, ni poussée ni échangée. La
 *     viser rougit l'emplacement, et la boîte lâchée là revient d'où elle vient.
 *  6. Tout se calcule depuis la disposition du début du geste : rebrousser
 *     chemin remet les autres boîtes en place, et Échap annule le geste.
 *  7. Les voisines ne se réarrangent qu'après un court arrêt du pointeur :
 *     traverser le tableau d'un geste vif ne le bouscule pas.
 *
 * Le redimensionnement suit les mêmes principes : la boîte grandit sous le
 * pointeur, ce qu'elle recouvre descend juste assez, et une boîte verrouillée
 * l'arrête comme un mur.
 *
 * ## Les animations
 *
 * Elles passent par les propriétés individuelles `translate` et `scale`, et par
 * l'API Web Animations — jamais par `transform` ni par une transition posée en
 * ligne. `.card` déclare `transition: … transform 0.2s ease !important`
 * (components.css) : ce `!important` l'emporte sur toute transition en ligne,
 * et c'est lui qui rendait instantanés les déplacements de l'ancien système.
 * tests/cardLayout.js y veille.
 *
 * Le moteur de placement (`MusicPlayer.layoutEngine`) est pur : il ne touche ni
 * au DOM ni au stockage, ce qui permet de le vérifier hors navigateur.
 */

(function() {
    'use strict';

    window.MusicPlayer = window.MusicPlayer || {};

    /* ══════════════════ Moteur de placement — pur, sans DOM ══════════════════ */

    const COLUMNS = 48;
    const MIN_COL_SPAN = 8;
    const MIN_ROW_SPAN = 6;
    /**
     * Hauteur au-delà de laquelle un redimensionnement ne tire plus. Sans borne,
     * le défilement automatique agrandit la page, donc la boîte, donc la page :
     * garder le pointeur en bas de l'écran l'allongerait sans fin.
     */
    const MAX_ROW_SPAN = 64;
    /** Part de la plus petite des deux boîtes à recouvrir pour les échanger. */
    const SWAP_COVERAGE = 0.5;
    /** Distance, en cellules, jusqu'où l'emplacement cherche une place libre. */
    const SNAP_RADIUS = 4;

    function copyRect(rect) {
        return {
            colStart: rect.colStart,
            colSpan: rect.colSpan,
            rowStart: rect.rowStart,
            rowSpan: rect.rowSpan
        };
    }

    function copyLayout(layout) {
        const copy = {};
        Object.keys(layout).forEach(id => { copy[id] = copyRect(layout[id]); });
        return copy;
    }

    function sameRect(a, b) {
        return !!a && !!b
            && a.colStart === b.colStart && a.colSpan === b.colSpan
            && a.rowStart === b.rowStart && a.rowSpan === b.rowSpan;
    }

    function overlapArea(a, b) {
        const width = Math.min(a.colStart + a.colSpan, b.colStart + b.colSpan) - Math.max(a.colStart, b.colStart);
        const height = Math.min(a.rowStart + a.rowSpan, b.rowStart + b.rowSpan) - Math.max(a.rowStart, b.rowStart);
        return width > 0 && height > 0 ? width * height : 0;
    }

    function overlaps(a, b) {
        return overlapArea(a, b) > 0;
    }

    function distance(a, b) {
        return Math.abs(a.colStart - b.colStart) + Math.abs(a.rowStart - b.rowStart);
    }

    function toInt(value, fallback) {
        const n = Math.round(Number(value));
        return Number.isFinite(n) ? n : fallback;
    }

    function isLocked(locked, id) {
        return !!(locked && locked[id]);
    }

    /** Ramène un rectangle dans la grille, à sa taille minimale au moins. */
    function clampRect(rect) {
        const colSpan = Math.min(COLUMNS, Math.max(MIN_COL_SPAN, toInt(rect.colSpan, MIN_COL_SPAN)));
        const rowSpan = Math.max(MIN_ROW_SPAN, toInt(rect.rowSpan, MIN_ROW_SPAN));
        return {
            colStart: Math.min(COLUMNS - colSpan + 1, Math.max(1, toInt(rect.colStart, 1))),
            colSpan,
            rowStart: Math.max(1, toInt(rect.rowStart, 1)),
            rowSpan
        };
    }

    function entriesOf(layout, ids) {
        return ids.map(id => ({ id, rect: layout[id] }));
    }

    /** Ordre de lecture : de haut en bas, puis de gauche à droite. */
    function readingOrder(entries) {
        return entries.sort((a, b) =>
            a.rect.rowStart - b.rect.rowStart
            || a.rect.colStart - b.rect.colStart
            || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    }

    /**
     * Pose des boîtes l'une après l'autre.
     *
     * Celles de `fixed` sont posées telles quelles. Chacune de `queue`, dans
     * l'ordre donné, garde sa place si elle est libre ; sinon elle descend
     * jusqu'à la première rangée où elle ne heurte plus rien. Jamais elle ne
     * monte ni ne glisse de côté : une boîte ne quitte sa colonne que si
     * l'utilisateur l'y a menée.
     *
     * Sauter directement sous l'obstacle ne manque aucune place : tant que la
     * boîte chevauche cet obstacle en largeur, toute rangée au-dessus de son
     * bas le heurterait encore.
     */
    function settle(fixed, queue) {
        const placed = fixed.map(entry => ({ id: entry.id, rect: copyRect(entry.rect) }));
        queue.forEach(entry => {
            const rect = copyRect(entry.rect);
            let blocker = placed.find(other => overlaps(other.rect, rect));
            while (blocker) {
                rect.rowStart = blocker.rect.rowStart + blocker.rect.rowSpan;
                blocker = placed.find(other => overlaps(other.rect, rect));
            }
            placed.push({ id: entry.id, rect });
        });

        const layout = {};
        placed.forEach(entry => { layout[entry.id] = entry.rect; });
        return layout;
    }

    /**
     * Rend une disposition valide : chaque boîte dans la grille, aucun
     * chevauchement. Les boîtes verrouillées sont posées d'abord ; une boîte qui
     * en heurte une autre descend, et rien ne remonte combler les vides.
     */
    function normalize(layouts, locked) {
        const ids = Object.keys(layouts);
        const clamped = {};
        ids.forEach(id => { clamped[id] = clampRect(layouts[id]); });

        const fixed = settle([], readingOrder(entriesOf(clamped, ids.filter(id => isLocked(locked, id)))));
        return settle(
            entriesOf(fixed, Object.keys(fixed)),
            readingOrder(entriesOf(clamped, ids.filter(id => !isLocked(locked, id))))
        );
    }

    /** Décalages essayés autour d'une cible, du plus proche au plus lointain. */
    const SNAP_OFFSETS = (() => {
        const offsets = [];
        for (let dr = -SNAP_RADIUS; dr <= SNAP_RADIUS; dr++) {
            for (let dc = -SNAP_RADIUS; dc <= SNAP_RADIUS; dc++) offsets.push([dc, dr]);
        }
        return offsets.sort((a, b) =>
            (a[0] * a[0] + a[1] * a[1]) - (b[0] * b[0] + b[1] * b[1])
            || Math.abs(a[1]) - Math.abs(b[1])
            || a[1] - b[1]
            || a[0] - b[0]);
    })();

    /** Place libre la plus proche de `target`, sans rien déplacer ; `null` si aucune alentour. */
    function nearestFree(start, activeId, target) {
        const others = Object.keys(start).filter(id => id !== activeId).map(id => start[id]);
        for (const [dc, dr] of SNAP_OFFSETS) {
            const rect = copyRect(target);
            rect.colStart += dc;
            rect.rowStart += dr;
            if (rect.colStart < 1 || rect.rowStart < 1 || rect.colStart + rect.colSpan - 1 > COLUMNS) continue;
            if (!others.some(other => overlaps(other, rect))) return rect;
        }
        return null;
    }

    function placeAt(start, activeId, rect) {
        const layout = copyLayout(start);
        layout[activeId] = copyRect(rect);
        return { kind: 'free', placeholder: copyRect(rect), layout, partner: null };
    }

    /**
     * Les façons d'échanger A et B, de la plus serrée à la plus simple.
     *
     * La première inverse leur ordre dans l'espace qu'elles couvrent à elles
     * deux : l'une prend le bord de départ de l'autre, la seconde s'aligne sur le
     * bord opposé. Deux voisines de tailles différentes s'échangent ainsi sans
     * laisser de trou ni rien pousser. La seconde échange simplement les coins
     * supérieurs gauches ; elle l'emporte quand une troisième boîte sépare les
     * deux, que la première bousculerait.
     */
    function exchangeSlots(a, b) {
        const slots = [];
        const aAbove = a.rowStart + a.rowSpan <= b.rowStart;
        const bAbove = b.rowStart + b.rowSpan <= a.rowStart;
        const aLeft = a.colStart + a.colSpan <= b.colStart;
        const bLeft = b.colStart + b.colSpan <= a.colStart;

        if (aAbove || bAbove) {
            slots.push({
                active: { colStart: b.colStart, rowStart: aAbove ? b.rowStart + b.rowSpan - a.rowSpan : b.rowStart },
                partner: { colStart: a.colStart, rowStart: aAbove ? a.rowStart : a.rowStart + a.rowSpan - b.rowSpan }
            });
        } else if (aLeft || bLeft) {
            slots.push({
                active: { colStart: aLeft ? b.colStart + b.colSpan - a.colSpan : b.colStart, rowStart: b.rowStart },
                partner: { colStart: aLeft ? a.colStart : a.colStart + a.colSpan - b.colSpan, rowStart: a.rowStart }
            });
        }
        slots.push({
            active: { colStart: b.colStart, rowStart: b.rowStart },
            partner: { colStart: a.colStart, rowStart: a.rowStart }
        });
        return slots;
    }

    /**
     * Échange de la boîte saisie avec `partnerId`, ou `null` si la boîte saisie
     * ne peut se poser nulle part sans empiéter sur une boîte verrouillée.
     *
     * Parmi les façons d'échanger, celle qui dérange le moins l'emporte : le
     * chemin parcouru par les boîtes qui n'ont rien demandé, plus l'écart de la
     * partenaire à la place qui lui était promise.
     */
    function exchange(start, activeId, partnerId, locked) {
        const a = start[activeId];
        const b = start[partnerId];
        const lockedIds = Object.keys(start).filter(id => id !== activeId && isLocked(locked, id));
        const restIds = Object.keys(start).filter(id =>
            id !== activeId && id !== partnerId && !isLocked(locked, id));

        let best = null;
        exchangeSlots(a, b).forEach(slot => {
            const activeRect = clampRect({ ...slot.active, colSpan: a.colSpan, rowSpan: a.rowSpan });
            const partnerRect = clampRect({ ...slot.partner, colSpan: b.colSpan, rowSpan: b.rowSpan });
            if (lockedIds.some(id => overlaps(start[id], activeRect))) return;

            const layout = settle(
                [...entriesOf(start, lockedIds), { id: activeId, rect: activeRect }],
                [{ id: partnerId, rect: partnerRect }, ...readingOrder(entriesOf(start, restIds))]
            );
            const cost = distance(layout[partnerId], partnerRect)
                + restIds.reduce((sum, id) => sum + distance(layout[id], start[id]), 0);
            if (!best || cost < best.cost) best = { cost, layout };
        });

        if (!best) return null;
        return { kind: 'swap', placeholder: copyRect(best.layout[activeId]), layout: best.layout, partner: partnerId };
    }

    /**
     * Où se poserait la boîte `activeId` lâchée avec son coin supérieur gauche
     * en `wanted`, et ce que deviendraient les autres.
     *
     * Renvoie `{ kind, placeholder, layout, partner }` :
     *  - `free`    — posée sur une place libre, rien d'autre ne bouge ;
     *  - `swap`    — échangée avec `partner` ;
     *  - `blocked` — `partner` est verrouillée : `layout` est la disposition de
     *                départ, la boîte reviendra d'où elle vient.
     *
     * `start` est la disposition du début du geste, jamais la précédente
     * réponse : c'est ce qui rend le geste réversible. `previous` ne sert que
     * lorsque la cible chevauche un peu d'autres boîtes sans place libre
     * alentour — l'emplacement reste alors où il était, plutôt que de sauter.
     */
    function arrangeMove(start, activeId, wanted, locked, previous) {
        const own = start[activeId];
        const target = clampRect({
            colStart: wanted.colStart,
            rowStart: wanted.rowStart,
            colSpan: own.colSpan,
            rowSpan: own.rowSpan
        });

        let covered = null;
        Object.keys(start).forEach(id => {
            if (id === activeId) return;
            const shared = overlapArea(target, start[id]);
            if (!shared) return;
            const smaller = Math.min(target.colSpan * target.rowSpan, start[id].colSpan * start[id].rowSpan);
            const share = shared / smaller;
            if (!covered || share > covered.share) covered = { id, share };
        });

        if (!covered) return placeAt(start, activeId, target);

        if (covered.share >= SWAP_COVERAGE) {
            if (isLocked(locked, covered.id)) {
                return { kind: 'blocked', placeholder: target, layout: copyLayout(start), partner: covered.id };
            }
            const swapped = exchange(start, activeId, covered.id, locked);
            if (swapped) return swapped;
        }

        const spot = nearestFree(start, activeId, target);
        if (spot) return placeAt(start, activeId, spot);
        return previous || placeAt(start, activeId, own);
    }

    /**
     * Redimensionnement de `activeId` à `wanted.colSpan` × `wanted.rowSpan`, son
     * coin supérieur gauche fixe. Une boîte verrouillée arrête la croissance ;
     * les autres boîtes recouvertes descendent juste assez.
     */
    function arrangeResize(start, activeId, wanted, locked) {
        const own = start[activeId];
        const colSpan = Math.max(MIN_COL_SPAN,
            Math.min(COLUMNS - own.colStart + 1, toInt(wanted.colSpan, own.colSpan)));
        const rowSpan = Math.max(MIN_ROW_SPAN,
            Math.min(Math.max(own.rowSpan, MAX_ROW_SPAN), toInt(wanted.rowSpan, own.rowSpan)));

        const lockedIds = Object.keys(start).filter(id => id !== activeId && isLocked(locked, id));
        const fits = (cs, rs) => !lockedIds.some(id => overlaps(start[id], {
            colStart: own.colStart, rowStart: own.rowStart, colSpan: cs, rowSpan: rs
        }));

        /*
         * La taille la plus proche de celle demandée qui ne mord sur aucune boîte
         * verrouillée. Il y en a toujours une : l'intersection de la taille
         * demandée et de la taille de départ tient dans la place de départ.
         */
        let size = { colSpan, rowSpan, loss: 0 };
        if (!fits(colSpan, rowSpan)) {
            size = null;
            for (let cs = colSpan; cs >= MIN_COL_SPAN; cs--) {
                for (let rs = rowSpan; rs >= MIN_ROW_SPAN; rs--) {
                    if (!fits(cs, rs)) continue;
                    const loss = (colSpan - cs) + (rowSpan - rs);
                    if (!size || loss < size.loss) size = { colSpan: cs, rowSpan: rs, loss };
                    break;
                }
            }
        }

        const rect = { colStart: own.colStart, rowStart: own.rowStart, colSpan: size.colSpan, rowSpan: size.rowSpan };
        const restIds = Object.keys(start).filter(id => id !== activeId && !isLocked(locked, id));
        const layout = settle(
            [...entriesOf(start, lockedIds), { id: activeId, rect }],
            readingOrder(entriesOf(start, restIds))
        );
        return { kind: 'resize', placeholder: copyRect(rect), layout, partner: null };
    }

    window.MusicPlayer.layoutEngine = {
        COLUMNS,
        MIN_COL_SPAN,
        MIN_ROW_SPAN,
        MAX_ROW_SPAN,
        SWAP_COVERAGE,
        clampRect,
        overlaps,
        normalize,
        arrangeMove,
        arrangeResize
    };

    /* ══════════════════ Grille, cartes et persistance ══════════════════ */

    /** px avant de distinguer un glissement d'un simple clic. */
    const DRAG_THRESHOLD = 4;
    /** Arrêt du pointeur avant que les voisines ne se réarrangent. */
    const DWELL_MS = 150;
    /** Bande haute et basse de la fenêtre qui fait défiler la page. */
    const EDGE_ZONE = 64;
    const MAX_SCROLL_STEP = 18;
    const MOVE_MS = 300;
    const SETTLE_MS = 340;
    const PLACEHOLDER_MS = 160;
    const LIFT_SCALE = 1.02;
    const EASE_MOVE = 'cubic-bezier(0.2, 0, 0, 1)';
    const EASE_SETTLE = 'cubic-bezier(0.34, 1.3, 0.64, 1)';

    const defaultLayout = {
        'player-card': { colStart: 1, colSpan: 18, rowStart: 1, rowSpan: 16 },
        'search-card': { colStart: 19, colSpan: 16, rowStart: 1, rowSpan: 6 },
        'settings-card': { colStart: 19, colSpan: 16, rowStart: 7, rowSpan: 10 },
        'speakers-card': { colStart: 35, colSpan: 14, rowStart: 1, rowSpan: 16 },
        'ducking-card': { colStart: 1, colSpan: 18, rowStart: 17, rowSpan: 16 },
        'history-card': { colStart: 19, colSpan: 16, rowStart: 17, rowSpan: 16 },
        'queue-card': { colStart: 35, colSpan: 14, rowStart: 17, rowSpan: 16 },
        'mix-card': { colStart: 1, colSpan: 18, rowStart: 33, rowSpan: 8 },
        'playlists-card': { colStart: 19, colSpan: 16, rowStart: 33, rowSpan: 16 }
    };

    window.MusicPlayer.cardLayouts = {};
    window.MusicPlayer.lockedCards = JSON.parse(localStorage.getItem('dashboardLockedCards') || '{}');

    let grid = null;
    let placeholder = null;
    let gesture = null;
    let isLayoutPersistenceInit = false;

    /** Animation en cours sur un élément, et ce qu'il faut ranger à sa fin. */
    const motions = new WeakMap();
    /** Rectangle effectivement posé sur chaque élément de la grille. */
    const applied = new WeakMap();

    function gridCards() {
        return Array.from(grid.children).filter(el => el.classList.contains('card') && el.id);
    }

    window.MusicPlayer.applyLayoutToCard = function(card, layout) {
        card.style.gridColumn = `${layout.colStart} / span ${layout.colSpan}`;
        card.style.gridRow = `${layout.rowStart} / span ${layout.rowSpan}`;
        applied.set(card, copyRect(layout));
    };

    window.MusicPlayer.updateGridCellSize = function() {
        const dashboardGrid = document.getElementById('dashboard-grid');
        if (!dashboardGrid) return;
        const gridWidth = dashboardGrid.clientWidth;
        const gap = 16;
        const cellWidth = (gridWidth - (47 * gap)) / 48;
        if (cellWidth > 0) {
            dashboardGrid.style.setProperty('--grid-cell-size', `${cellWidth}px`);
        }
    };

    /**
     * Montre ou cache la grille tracée sous les cartes.
     *
     * Le tracé lui-même est entièrement en CSS (`.dashboard-grid::before`, dans
     * layout.css) : il se cale sur `--grid-cell-size`, la variable que pose
     * `updateGridCellSize()` ci-dessus. Il n'y a donc rien à recalculer au
     * redimensionnement de la fenêtre, ni à redessiner au changement de thème.
     *
     * @param {boolean} visible
     */
    window.MusicPlayer.applyGridOverlay = function(visible) {
        const dashboardGrid = document.getElementById('dashboard-grid');
        if (!dashboardGrid) return;
        dashboardGrid.classList.toggle('grid-visible', !!visible);
    };

    function saveLayout() {
        localStorage.setItem('dashboardLayout', JSON.stringify(window.MusicPlayer.cardLayouts));
    }

    /** Disposition des seules cartes présentes à l'écran. */
    function currentLayout() {
        const layout = {};
        gridCards().forEach(card => {
            const rect = window.MusicPlayer.cardLayouts[card.id];
            if (rect) layout[card.id] = copyRect(rect);
        });
        return layout;
    }

    /**
     * Géométrie de la grille, relue à chaque image : la page peut défiler et la
     * fenêtre changer de taille pendant un geste.
     *
     * Les colonnes se partagent la largeur, les rangées valent
     * `--grid-cell-size` : les deux se lisent séparément, pour rester justes
     * même si les gouttières ne sont pas égales dans les deux sens.
     */
    function gridMetrics() {
        const rect = grid.getBoundingClientRect();
        const style = getComputedStyle(grid);
        const gapX = parseFloat(style.columnGap) || 0;
        const gapY = parseFloat(style.rowGap) || 0;
        const cellX = (grid.clientWidth - (COLUMNS - 1) * gapX) / COLUMNS;
        const cellY = parseFloat(style.getPropertyValue('--grid-cell-size')) || cellX;
        return {
            left: rect.left,
            top: rect.top,
            gapX,
            gapY,
            unitX: cellX + gapX,
            unitY: cellY + gapY
        };
    }

    function pixelsOf(rect, m) {
        return {
            left: m.left + (rect.colStart - 1) * m.unitX,
            top: m.top + (rect.rowStart - 1) * m.unitY,
            width: rect.colSpan * m.unitX - m.gapX,
            height: rect.rowSpan * m.unitY - m.gapY
        };
    }

    /**
     * Grille repliée en une colonne (layout.css, device.css) : les cartes y
     * sont empilées de force, et rien de ce qu'on déplacerait ne se verrait.
     */
    function isCollapsed() {
        const tracks = getComputedStyle(grid).gridTemplateColumns;
        return !tracks || tracks === 'none' || tracks.trim().split(/\s+/).length < COLUMNS;
    }

    /* ─────────────── Animations ─────────────── */

    function prefersReducedMotion() {
        return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    }

    /** Interrompt l'animation d'un élément ; il se retrouve aussitôt à sa place. */
    function stopMotion(el) {
        const motion = motions.get(el);
        if (!motion) return;
        motions.delete(el);
        motion.animation.cancel();
        if (motion.cleanup) motion.cleanup();
    }

    function play(el, keyframes, duration, easing, cleanup) {
        stopMotion(el);
        if (typeof el.animate !== 'function' || prefersReducedMotion()) {
            if (cleanup) cleanup();
            return;
        }
        const motion = { animation: el.animate(keyframes, { duration, easing }), cleanup };
        motions.set(el, motion);
        motion.animation.addEventListener('finish', () => {
            if (motions.get(el) !== motion) return;
            motions.delete(el);
            if (cleanup) cleanup();
        });
    }

    /**
     * Pose une disposition sur les cartes et anime celles qui changent de place,
     * depuis l'endroit où elles se trouvent à l'écran — y compris au milieu d'une
     * animation précédente, qu'elles reprennent sans à-coup.
     *
     * Lectures groupées, puis écritures, puis lectures : une seule mise en page
     * forcée, quel que soit le nombre de cartes.
     */
    function applyLayout(layout, skip) {
        const moving = gridCards().filter(card =>
            card !== skip && layout[card.id] && !sameRect(applied.get(card), layout[card.id]));
        if (!moving.length) return;

        const before = moving.map(card => card.getBoundingClientRect());
        moving.forEach(card => {
            stopMotion(card);
            window.MusicPlayer.applyLayoutToCard(card, layout[card.id]);
        });
        moving.forEach((card, i) => {
            const after = card.getBoundingClientRect();
            const dx = before[i].left - after.left;
            const dy = before[i].top - after.top;
            if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
            play(card, [
                { translate: `${dx}px ${dy}px` },
                { translate: '0px 0px' }
            ], MOVE_MS, EASE_MOVE);
        });
    }

    /**
     * Agrandit un élément de la grille au-delà de sa zone, ou le rétrécit en
     * deçà, sans toucher à sa largeur ni à sa hauteur.
     *
     * Une largeur explicite devient la contribution minimale de l'élément aux
     * pistes qu'il couvre : les colonnes `1fr` s'élargissent alors pour la
     * contenir, et la grille entière déborde de la page le temps du geste — les
     * 48 colonnes passaient de 17 à 31 px pendant un redimensionnement. Une
     * marge négative laisse la largeur à `auto` : l'élément s'étire d'autant,
     * et les pistes ne le voient pas.
     */
    function stretchBy(dx, dy) {
        return { marginRight: `${-dx}px`, marginBottom: `${-dy}px` };
    }

    /* ─────────────── Emplacement ─────────────── */

    /**
     * L'emplacement est un élément de la grille comme les cartes : placé par
     * `grid-column` et `grid-row`, il allonge la grille quand on vise sous la
     * dernière carte, ce qu'un élément en position absolue ne ferait pas. Il
     * précède les cartes dans le document, et se peint donc sous elles.
     */
    function showPlaceholder(rect, kind) {
        if (!placeholder) {
            placeholder = document.createElement('div');
            placeholder.className = 'layout-placeholder';
            placeholder.setAttribute('aria-hidden', 'true');
        }
        if (placeholder.parentNode !== grid) grid.insertBefore(placeholder, grid.firstChild);

        const el = placeholder;
        const shown = el.classList.contains('is-visible') && !el.hidden;
        const before = shown ? el.getBoundingClientRect() : null;

        stopMotion(el);
        el.hidden = false;
        window.MusicPlayer.applyLayoutToCard(el, rect);
        el.classList.toggle('is-swap', kind === 'swap');
        el.classList.toggle('is-blocked', kind === 'blocked');

        if (!shown) {
            void el.offsetWidth;
            el.classList.add('is-visible');
            return;
        }

        const after = el.getBoundingClientRect();
        if (Math.abs(before.left - after.left) < 0.5 && Math.abs(before.top - after.top) < 0.5
            && Math.abs(before.width - after.width) < 0.5 && Math.abs(before.height - after.height) < 0.5) return;

        play(el, [
            {
                translate: `${before.left - after.left}px ${before.top - after.top}px`,
                ...stretchBy(before.width - after.width, before.height - after.height)
            },
            { translate: '0px 0px', ...stretchBy(0, 0) }
        ], PLACEHOLDER_MS, EASE_MOVE);
    }

    function hidePlaceholder() {
        if (!placeholder) return;
        const el = placeholder;
        stopMotion(el);
        el.classList.remove('is-visible', 'is-swap', 'is-blocked');
        setTimeout(() => {
            if (!el.classList.contains('is-visible')) el.hidden = true;
        }, 220);
    }

    /** Signale la boîte avec laquelle on échange, ou celle, verrouillée, qui refuse. */
    function markPartner(decision) {
        gridCards().forEach(card => {
            card.classList.toggle('layout-swap-partner', decision.kind === 'swap' && card.id === decision.partner);
            card.classList.toggle('layout-blocker', decision.kind === 'blocked' && card.id === decision.partner);
        });
    }

    /* ─────────────── Gestes ─────────────── */

    function getCardCleanTitle(card) {
        const titleEl = card.querySelector('.card-title');
        if (!titleEl) return "Boîte";
        const clone = titleEl.cloneNode(true);
        clone.querySelectorAll('.icon-drag-handle, .card-lock-btn, .card-info-btn').forEach(el => el.remove());
        return clone.textContent.trim();
    }

    function toastLocked(card, key) {
        if (typeof window.MusicPlayer.showToast !== 'function') return;
        window.MusicPlayer.showToast(window.MusicPlayer.t(key).replace('{title}', getCardCleanTitle(card)));
    }

    function decisionKey(decision) {
        const p = decision.placeholder;
        return `${decision.kind}|${decision.partner || ''}|${p.colStart},${p.rowStart},${p.colSpan},${p.rowSpan}`;
    }

    function othersKey(layout, activeId) {
        return Object.keys(layout)
            .filter(id => id !== activeId)
            .sort()
            .map(id => `${id}:${layout[id].colStart},${layout[id].rowStart}`)
            .join('|');
    }

    function beginPending(type, card, e) {
        const g = {
            type,
            card,
            id: card.id,
            pointerId: e.pointerId,
            x0: e.clientX,
            y0: e.clientY,
            x: e.clientX,
            y: e.clientY,
            started: false,
            raf: 0
        };

        g.onMove = (moveEvent) => {
            if (moveEvent.pointerId !== g.pointerId) return;
            g.x = moveEvent.clientX;
            g.y = moveEvent.clientY;
            if (!g.started) {
                if (Math.hypot(g.x - g.x0, g.y - g.y0) < DRAG_THRESHOLD) return;
                startGesture(g);
                if (gesture !== g) return;
            }
            if (moveEvent.cancelable) moveEvent.preventDefault();
        };
        g.onUp = (upEvent) => {
            if (upEvent.pointerId !== g.pointerId) return;
            endGesture(g, upEvent.type === 'pointercancel');
        };
        g.onKey = (keyEvent) => {
            if (keyEvent.key !== 'Escape' || !g.started) return;
            keyEvent.preventDefault();
            keyEvent.stopPropagation();
            endGesture(g, true);
        };
        g.onBlur = () => endGesture(g, true);
        g.onResize = () => {
            if (g.started && isCollapsed()) endGesture(g, true);
        };

        gesture = g;
        window.addEventListener('pointermove', g.onMove, { passive: false });
        window.addEventListener('pointerup', g.onUp);
        window.addEventListener('pointercancel', g.onUp);
        window.addEventListener('keydown', g.onKey, true);
        window.addEventListener('blur', g.onBlur);
        window.addEventListener('resize', g.onResize);
    }

    function startGesture(g) {
        if (window.MusicPlayer.lockedCards[g.id]) {
            // Le refus n'est dit qu'au glissement : un simple clic sur le titre
            // d'une boîte verrouillée n'a rien demandé.
            toastLocked(g.card, g.type === 'move' ? 'toast_box_locked_move' : 'toast_box_locked_resize');
            endGesture(g, true);
            return;
        }
        if (isCollapsed()) {
            endGesture(g, true);
            return;
        }

        g.started = true;
        g.start = currentLayout();
        const own = g.start[g.id];

        stopMotion(g.card);
        const m = gridMetrics();
        const slot = pixelsOf(own, m);

        if (g.type === 'move') {
            g.grabX = g.x0 - slot.left;
            g.grabY = g.y0 - slot.top;
            g.tx = 0;
            g.ty = 0;
            g.lowestRow = Object.keys(g.start).reduce((lowest, id) =>
                id === g.id ? lowest : Math.max(lowest, g.start[id].rowStart + g.start[id].rowSpan), own.rowStart);
            // Soulevée depuis le point saisi : ce point reste sous le pointeur.
            g.card.style.transformOrigin = `${g.grabX}px ${g.grabY}px`;
            g.card.style.scale = String(LIFT_SCALE);
            g.card.classList.add('layout-dragging');
            document.body.classList.add('layout-gesture-move');
        } else {
            g.offsetX = slot.left + slot.width - g.x0;
            g.offsetY = slot.top + slot.height - g.y0;
            g.areaWidth = slot.width;
            g.areaHeight = slot.height;
            g.width = slot.width;
            g.height = slot.height;
            g.card.classList.add('layout-resizing');
            document.body.classList.add('layout-gesture-resize');
        }

        g.decision = {
            kind: g.type === 'move' ? 'free' : 'resize',
            placeholder: copyRect(own),
            layout: copyLayout(g.start),
            partner: null
        };
        g.committed = g.decision;
        g.committedKey = decisionKey(g.decision);
        g.pendingKey = null;
        g.pendingSince = 0;
        g.scrollArmed = false;

        grid.classList.add('layout-active');
        showPlaceholder(own, g.decision.kind);
        g.raf = requestAnimationFrame(() => frame(g));
    }

    /** Défilement de la page quand le pointeur touche le haut ou le bas de la fenêtre. */
    function autoScroll(g) {
        const height = window.innerHeight;
        // Armé seulement une fois le pointeur passé hors des bandes : un geste qui
        // commence près du bord ne doit pas faire défiler la page d'emblée.
        if (!g.scrollArmed) {
            g.scrollArmed = g.y >= EDGE_ZONE && g.y <= height - EDGE_ZONE;
            return;
        }
        let step = 0;
        if (g.y < EDGE_ZONE) {
            step = -Math.ceil(MAX_SCROLL_STEP * Math.min(1, (EDGE_ZONE - g.y) / EDGE_ZONE));
        } else if (g.y > height - EDGE_ZONE) {
            step = Math.ceil(MAX_SCROLL_STEP * Math.min(1, (g.y - (height - EDGE_ZONE)) / EDGE_ZONE));
        }
        if (step) window.scrollBy(0, step);
    }

    function setStyle(el, property, value) {
        if (el.style[property] !== value) el.style[property] = value;
    }

    /**
     * Une image du geste. Tourne tant que le geste dure, même pointeur immobile :
     * c'est ce qui fait défiler la page et laisse mûrir l'arrêt du pointeur.
     */
    function frame(g) {
        if (gesture !== g) return;
        g.raf = requestAnimationFrame(() => frame(g));

        autoScroll(g);
        const engine = window.MusicPlayer.layoutEngine;
        const m = gridMetrics();
        const own = g.start[g.id];
        const slot = pixelsOf(own, m);

        let decision;
        if (g.type === 'move') {
            const left = g.x - g.grabX;
            const top = g.y - g.grabY;
            g.tx = Math.round((left - slot.left) * 10) / 10;
            g.ty = Math.round((top - slot.top) * 10) / 10;
            setStyle(g.card, 'translate', `${g.tx}px ${g.ty}px`);

            const col = Math.round((left - m.left) / m.unitX) + 1;
            const row = Math.min(g.lowestRow, Math.round((top - m.top) / m.unitY) + 1);
            decision = engine.arrangeMove(g.start, g.id, { colStart: col, rowStart: row },
                window.MusicPlayer.lockedCards, g.decision);
        } else {
            const maxWidth = (COLUMNS - own.colStart + 1) * m.unitX - m.gapX;
            const maxHeight = Math.max(own.rowSpan, MAX_ROW_SPAN) * m.unitY - m.gapY;
            g.width = Math.round(Math.max(MIN_COL_SPAN * m.unitX - m.gapX,
                Math.min(maxWidth, g.x + g.offsetX - slot.left)));
            g.height = Math.round(Math.max(MIN_ROW_SPAN * m.unitY - m.gapY,
                Math.min(maxHeight, g.y + g.offsetY - slot.top)));
            const stretch = stretchBy(g.width - g.areaWidth, g.height - g.areaHeight);
            setStyle(g.card, 'marginRight', stretch.marginRight);
            setStyle(g.card, 'marginBottom', stretch.marginBottom);

            decision = engine.arrangeResize(g.start, g.id, {
                colSpan: Math.round((g.width + m.gapX) / m.unitX),
                rowSpan: Math.round((g.height + m.gapY) / m.unitY)
            }, window.MusicPlayer.lockedCards);
        }

        g.decision = decision;
        consider(g, decision);
    }

    /**
     * Montre une décision, tout de suite si seule la boîte saisie bouge, après
     * un arrêt du pointeur si d'autres boîtes doivent se déplacer. Au
     * redimensionnement, pas d'attente : la boîte pousse ce qu'elle recouvre au
     * rythme où elle grandit.
     */
    function consider(g, decision) {
        const key = decisionKey(decision);
        if (key === g.committedKey) {
            g.pendingKey = null;
            return;
        }

        const disturbs = othersKey(decision.layout, g.id) !== othersKey(g.committed.layout, g.id);
        if (disturbs && g.type === 'move') {
            const now = performance.now();
            if (g.pendingKey !== key) {
                g.pendingKey = key;
                g.pendingSince = now;
                return;
            }
            if (now - g.pendingSince < DWELL_MS) return;
        }

        g.committed = decision;
        g.committedKey = key;
        g.pendingKey = null;
        applyLayout(decision.layout, g.card);
        showPlaceholder(decision.placeholder, decision.kind);
        markPartner(decision);
    }

    /** Un clic suit toujours le relâchement : après un vrai glissement, il n'a rien à déclencher. */
    function swallowNextClick() {
        const swallow = (clickEvent) => {
            clickEvent.stopPropagation();
            clickEvent.preventDefault();
        };
        window.addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
    }

    function endGesture(g, cancelled) {
        if (gesture !== g) return;
        gesture = null;
        cancelAnimationFrame(g.raf);
        window.removeEventListener('pointermove', g.onMove, { passive: false });
        window.removeEventListener('pointerup', g.onUp);
        window.removeEventListener('pointercancel', g.onUp);
        window.removeEventListener('keydown', g.onKey, true);
        window.removeEventListener('blur', g.onBlur);
        window.removeEventListener('resize', g.onResize);
        if (!g.started) return;

        swallowNextClick();
        document.body.classList.remove('layout-gesture-move', 'layout-gesture-resize');
        grid.classList.remove('layout-active');
        markPartner({ kind: 'none' });
        hidePlaceholder();

        // Au relâchement, c'est la dernière intention qui compte, même si l'arrêt
        // du pointeur n'a pas encore eu le temps de la montrer.
        const final = cancelled || g.decision.kind === 'blocked' ? g.start : g.decision.layout;

        applyLayout(final, g.card);
        const m = gridMetrics();
        const card = g.card;
        const rect = final[g.id];

        if (g.type === 'move') {
            const from = pixelsOf(g.start[g.id], m);
            const to = pixelsOf(rect, m);
            card.style.translate = '';
            card.style.scale = '';
            card.classList.remove('layout-dragging');
            card.classList.add('layout-settling');
            window.MusicPlayer.applyLayoutToCard(card, rect);
            play(card, [
                { translate: `${g.tx + from.left - to.left}px ${g.ty + from.top - to.top}px`, scale: String(LIFT_SCALE) },
                { translate: '0px 0px', scale: '1' }
            ], SETTLE_MS, EASE_SETTLE, () => {
                card.classList.remove('layout-settling');
                card.style.transformOrigin = '';
            });
        } else {
            const to = pixelsOf(rect, m);
            card.style.marginRight = '';
            card.style.marginBottom = '';
            card.classList.remove('layout-resizing');
            card.classList.add('layout-settling');
            window.MusicPlayer.applyLayoutToCard(card, rect);
            play(card, [
                stretchBy(g.width - to.width, g.height - to.height),
                stretchBy(0, 0)
            ], MOVE_MS, EASE_MOVE, () => card.classList.remove('layout-settling'));
        }

        if (cancelled) return;
        Object.keys(final).forEach(id => {
            window.MusicPlayer.cardLayouts[id] = copyRect(final[id]);
        });
        saveLayout();
    }

    function onTitlePointerDown(e) {
        if (gesture || !e.isPrimary) return;
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        if (e.target.closest('input, button, select, a, textarea, label')) return;
        // Au doigt, seule la poignée saisit la boîte : le reste du titre doit
        // laisser défiler la page.
        if (e.pointerType === 'touch' && !e.target.closest('.icon-drag-handle')) return;

        const card = e.currentTarget.closest('.card');
        if (!card || card.parentNode !== grid || !window.MusicPlayer.cardLayouts[card.id]) return;
        e.preventDefault();
        beginPending('move', card, e);
    }

    function onHandlePointerDown(e) {
        if (gesture || !e.isPrimary) return;
        if (e.pointerType === 'mouse' && e.button !== 0) return;

        const card = e.currentTarget.closest('.card');
        if (!card || card.parentNode !== grid || !window.MusicPlayer.cardLayouts[card.id]) return;
        e.preventDefault();
        e.stopPropagation();
        beginPending('resize', card, e);
    }

    /* ─────────────── Verrouillage ─────────────── */

    function paintLockState(card, isLocked) {
        const lockBtn = card.querySelector('.card-lock-btn');
        card.classList.toggle('card-locked', isLocked);
        if (!lockBtn) return;

        const iconUnlocked = lockBtn.querySelector('.icon-unlocked');
        const iconLocked = lockBtn.querySelector('.icon-locked');
        if (iconUnlocked) iconUnlocked.classList.toggle('hidden', isLocked);
        if (iconLocked) iconLocked.classList.toggle('hidden', !isLocked);
        lockBtn.dataset.tooltip = isLocked
            ? (window.MusicPlayer.t && window.MusicPlayer.t('tooltip_unlock_card')) || "Déverrouiller la taille et la position"
            : (window.MusicPlayer.t && window.MusicPlayer.t('tooltip_lock_card')) || "Verrouiller la taille et la position";
    }

    function saveLockedCards() {
        localStorage.setItem('dashboardLockedCards', JSON.stringify(window.MusicPlayer.lockedCards));
    }

    window.MusicPlayer.updateHeaderLockAllButton = function() {
        const btnLockAll = document.getElementById('btn-lock-all');
        const dashboardGrid = document.getElementById('dashboard-grid');
        if (!btnLockAll || !dashboardGrid) return;

        const cards = dashboardGrid.querySelectorAll('.card');
        const totalCards = cards.length;
        if (totalCards === 0) return;

        let lockedCount = 0;
        cards.forEach(card => {
            if (window.MusicPlayer.lockedCards[card.id]) {
                lockedCount++;
            }
        });

        const svgUnlocked = btnLockAll.querySelector('#svg-lock-all-unlocked');
        const svgLocked = btnLockAll.querySelector('#svg-lock-all-locked');

        if (lockedCount === totalCards) {
            if (svgUnlocked) svgUnlocked.classList.add('hidden');
            if (svgLocked) svgLocked.classList.remove('hidden');
            btnLockAll.dataset.tooltip = (window.MusicPlayer.t && window.MusicPlayer.t('tooltip_unlock_all')) || "Déverrouiller toutes les boîtes";
            btnLockAll.classList.add('header-lock-active');
        } else {
            if (svgUnlocked) svgUnlocked.classList.remove('hidden');
            if (svgLocked) svgLocked.classList.add('hidden');
            btnLockAll.dataset.tooltip = (window.MusicPlayer.t && window.MusicPlayer.t('tooltip_lock_all')) || "Verrouiller toutes les boîtes";
            btnLockAll.classList.remove('header-lock-active');
        }
    };

    window.MusicPlayer.setupCardLocking = function() {
        const dashboardGrid = document.getElementById('dashboard-grid');
        const btnLockAll = document.getElementById('btn-lock-all');
        if (!dashboardGrid) return;
        const cards = dashboardGrid.querySelectorAll('.card');

        cards.forEach(card => {
            const lockBtn = card.querySelector('.card-lock-btn');
            if (!lockBtn) return;

            paintLockState(card, !!window.MusicPlayer.lockedCards[card.id]);

            lockBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();

                const isLocked = !window.MusicPlayer.lockedCards[card.id];
                window.MusicPlayer.lockedCards[card.id] = isLocked;
                saveLockedCards();
                paintLockState(card, isLocked);

                if (typeof window.MusicPlayer.showToast === 'function') {
                    const key = isLocked ? 'toast_box_now_locked' : 'toast_box_unlocked';
                    window.MusicPlayer.showToast(window.MusicPlayer.t(key).replace('{title}', getCardCleanTitle(card)));
                }
                window.MusicPlayer.updateHeaderLockAllButton();
            });
        });

        window.MusicPlayer.updateHeaderLockAllButton();

        if (btnLockAll) {
            btnLockAll.addEventListener('click', (e) => {
                e.preventDefault();
                const totalCards = cards.length;
                if (totalCards === 0) return;

                let lockedCount = 0;
                cards.forEach(card => {
                    if (window.MusicPlayer.lockedCards[card.id]) {
                        lockedCount++;
                    }
                });

                const shouldLockAll = lockedCount < totalCards;

                cards.forEach(card => {
                    window.MusicPlayer.lockedCards[card.id] = shouldLockAll;
                    if (card.querySelector('.card-lock-btn')) paintLockState(card, shouldLockAll);
                });

                saveLockedCards();
                window.MusicPlayer.updateHeaderLockAllButton();

                if (typeof window.MusicPlayer.showToast === 'function') {
                    window.MusicPlayer.showToast(window.MusicPlayer.t(shouldLockAll ? 'toast_all_boxes_locked' : 'toast_all_boxes_unlocked'));
                }
            });
        }
    };

    /* ─────────────── Initialisation ─────────────── */

    window.MusicPlayer.initLayoutPersistence = function() {
        if (isLayoutPersistenceInit) return;
        grid = document.getElementById('dashboard-grid');
        if (!grid) return;
        isLayoutPersistenceInit = true;

        const customDefaultLayout = localStorage.getItem('dashboardDefaultLayout');
        if (customDefaultLayout) {
            try {
                const parsed = JSON.parse(customDefaultLayout);
                Object.keys(parsed).forEach(key => {
                    defaultLayout[key] = { ...parsed[key] };
                });
            } catch (err) {}
        }

        const savedLayout = localStorage.getItem('dashboardLayout') || localStorage.getItem('dashboardDefaultLayout');
        const layouts = window.MusicPlayer.cardLayouts;
        let loaded = null;
        if (savedLayout) {
            try {
                loaded = JSON.parse(savedLayout);
            } catch (err) {}
        }

        if (loaded && typeof loaded === 'object') {
            Object.keys(loaded).forEach(key => {
                if (loaded[key] && typeof loaded[key] === 'object') layouts[key] = loaded[key];
            });

            // Dispositions enregistrées sur l'ancienne grille de 24 colonnes.
            if (layouts['player-card'] && layouts['player-card'].colSpan <= 9) {
                Object.keys(layouts).forEach(key => {
                    layouts[key].colStart = (layouts[key].colStart - 1) * 2 + 1;
                    layouts[key].colSpan = layouts[key].colSpan * 2;
                    layouts[key].rowStart = (layouts[key].rowStart - 1) * 2 + 1;
                    layouts[key].rowSpan = layouts[key].rowSpan * 2;
                });
                saveLayout();
            }
        }

        Object.keys(defaultLayout).forEach(key => {
            if (!layouts[key]) layouts[key] = { ...defaultLayout[key] };
        });

        /*
         * Une disposition abîmée — chevauchements, boîte sortie de la grille — est
         * remise d'aplomb en ne faisant que descendre ce qui gêne. Les boîtes
         * absentes de cette page, venues d'une autre version, restent dans
         * l'enregistrement sans compter ici comme obstacles.
         */
        const normalized = normalize(currentLayout(), window.MusicPlayer.lockedCards);
        gridCards().forEach(card => {
            if (!normalized[card.id]) return;
            layouts[card.id] = normalized[card.id];
            window.MusicPlayer.applyLayoutToCard(card, normalized[card.id]);
        });

        window.MusicPlayer.updateGridCellSize();
        window.addEventListener('resize', window.MusicPlayer.updateGridCellSize);

        gridCards().forEach(card => {
            const title = card.querySelector('.card-title');
            if (title) title.addEventListener('pointerdown', onTitlePointerDown);
            const handle = card.querySelector('.card-resize-handle');
            if (handle) handle.addEventListener('pointerdown', onHandlePointerDown);
        });

        window.MusicPlayer.setupCardLocking();
    };
})();
