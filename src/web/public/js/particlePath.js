/**
 * Traînée de particules « Ajouter un fichier » → carte de destination.
 *
 * Elle matérialise, en continu, ce que le sélecteur de destination annonce : un
 * fichier chargé dans la carte « Ajouter un fichier » partira vers la file
 * d'attente, la playlist active ou la lecture. La traînée relie donc la carte
 * source à celle des trois cartes qui est visée.
 *
 * Le tracé n'est pas décoratif, il est calculé. Chaque carte du tableau de bord
 * est dilatée d'une demi-gouttière, puis on cherche le plus court chemin qui ne
 * traverse aucune de ces zones : graphe de visibilité (coins des cartes +
 * points d'accroche répartis sur le pourtour du départ et de l'arrivée) parcouru
 * par Dijkstra. La traînée passe ainsi exactement au milieu des espaces entre
 * les cartes, et contourne leurs coins en épousant leur arrondi — le rayon de
 * chaque virage vaut le rayon de la carte plus la marge, ce qui est précisément
 * la courbe parallèle à son bord.
 *
 * Les couleurs sont lues sur les variables CSS de `<html>` : le module ne
 * connaît aucune palette en dur et suit les huit combinaisons style × thème.
 */

window.MusicPlayer = window.MusicPlayer || {};

(function () {
    'use strict';

    const CANVAS_ID = 'particle-path-canvas';
    const SOURCE_CARD_ID = 'search-card';
    const TARGET_CARDS = {
        queue: 'queue-card',
        playlist: 'playlists-card',
        play: 'player-card'
    };

    // --- Réglages du tracé ---------------------------------------------------

    /** Bornes de la marge laissée entre le tracé et le bord d'une carte (px). */
    const MIN_MARGIN = 6;
    const MAX_MARGIN = 14;
    /**
     * Retrait appliqué aux rectangles pendant les tests de visibilité.
     *
     * Les points de passage sont posés *sur* le pourtour dilaté ; sans ce
     * retrait, un segment qui longe ce pourtour — le cas le plus fréquent, une
     * traînée qui suit une gouttière — serait compté comme traversant la carte.
     */
    const EPSILON = 0.5;
    /** Espacement des points d'accroche le long du pourtour départ/arrivée (px). */
    const ANCHOR_STEP = 40;
    /** Nombre maximal de points d'accroche par côté de carte. */
    const ANCHORS_PER_SIDE = 6;
    /** Rayon de virage employé quand le sommet n'appartient à aucune carte. */
    const DEFAULT_RADIUS = 10;

    // --- Réglages de l'animation --------------------------------------------

    /** Une particule tous les N pixels de tracé. */
    const PARTICLE_SPACING = 60;
    const MIN_PARTICLES = 5;
    const MAX_PARTICLES = 26;
    /** Vitesse de parcours, constante en pixels par seconde. */
    const MIN_SPEED = 70;
    const MAX_SPEED = 110;
    /** Longueur de la comète derrière chaque particule (px). */
    const TAIL_LENGTH = 26;
    /** Nombre de segments composant cette comète. */
    const TAIL_SEGMENTS = 5;
    /**
     * Distance de fondu à chaque extrémité (px) : les particules naissent au
     * bord de la carte source et s'éteignent au bord de la carte visée, au lieu
     * d'apparaître et de disparaître d'un coup.
     */
    const FADE_DISTANCE = 36;
    /** Plafond du delta de temps, pour ne pas téléporter les particules au retour d'un onglet. */
    const DT_MAX = 0.05;

    // --- État ----------------------------------------------------------------

    let canvas = null;
    let ctx = null;
    let grid = null;
    let cssWidth = 0;
    let cssHeight = 0;

    /** { points, longueurs, total } — polyligne dense et abscisse curviligne. */
    let trail = null;
    let particles = [];
    let palette = null;
    let lineGradient = null;

    let currentTarget = 'queue';
    let animationId = null;
    let lastTime = 0;
    let recomputeRequested = false;
    let initialised = false;

    let active = localStorage.getItem('particlePathEnabled') !== 'false';
    const reducedMotion = window.matchMedia
        ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
        : false;

    // --- Utilitaires ---------------------------------------------------------

    function clamp(v, min, max) {
        return Math.max(min, Math.min(max, v));
    }

    /**
     * Normalise n'importe quelle couleur CSS en composantes { r, g, b }.
     *
     * Le canevas fait le travail : lui affecter une couleur puis relire la
     * propriété rend toujours une forme canonique, quelle que soit l'écriture
     * d'origine (mot-clé, #abc, rgb(), hsl()...).
     */
    const colorCtx = document.createElement('canvas').getContext('2d');
    function toRGB(css, fallback) {
        colorCtx.fillStyle = '#000000';
        try {
            colorCtx.fillStyle = css;
        } catch (e) { /* couleur invalide : le noir reste en place */ }
        let normalised = colorCtx.fillStyle;

        if (normalised === '#000000' && !/^#0{3,6}$|black/i.test(String(css).trim())) {
            // La couleur n'a pas été comprise : on retombe sur le repli.
            colorCtx.fillStyle = fallback;
            normalised = colorCtx.fillStyle;
        }

        if (normalised[0] === '#') {
            const hex = normalised.length === 4
                ? normalised[1] + normalised[1] + normalised[2] + normalised[2] + normalised[3] + normalised[3]
                : normalised.slice(1);
            const n = parseInt(hex, 16);
            return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
        }

        const m = normalised.match(/([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/);
        return m
            ? { r: +m[1], g: +m[2], b: +m[3] }
            : { r: 255, g: 255, b: 255 };
    }

    function rgba(c, a) {
        return `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${a})`;
    }

    // --- Palette du thème ----------------------------------------------------

    /**
     * Reconstruit la palette à partir des variables CSS du thème courant.
     *
     * Le style minimaliste est traité à part : ses trois teintes sont des gris,
     * et `--c-violet` y est si proche du fond qu'une particule de cette couleur
     * serait invisible. On s'y limite donc aux deux teintes contrastées, sans
     * halo — ce style n'en emploie nulle part ailleurs.
     */
    function buildPalette() {
        const rootEl = document.documentElement;
        const styles = getComputedStyle(rootEl);
        const readVar = (nameOf, fallback) => toRGB(styles.getPropertyValue(nameOf).trim(), fallback);

        const style = rootEl.getAttribute('data-style') || 'glassmorphism';
        const light = rootEl.getAttribute('data-theme') === 'light';
        const muted = style === 'minimalist';

        const primary = readVar('--c-primary', '#5865F2');
        const accent = readVar('--c-accent', '#EB459E');
        const violet = readVar('--c-violet', '#8e44ad');

        palette = {
            colors: muted ? [primary, accent] : [primary, accent, violet],
            lineStart: rgba(primary, light ? 0.34 : 0.22),
            lineEnd: rgba(accent, light ? 0.34 : 0.22),
            strokeWidth: muted ? 1 : 1.3,
            // Un halo sur fond clair ne fait que délaver la couleur : il est
            // réduit en thème clair, supprimé en minimaliste.
            glow: muted ? 0 : (light ? 5 : 10),
            alpha: light ? 0.95 : 0.85
        };

        buildGradient();
    }

    /** Dégradé de la ligne guide, tendu d'un bout à l'autre du tracé. */
    function buildGradient() {
        lineGradient = null;
        if (!ctx || !palette || !trail || trail.points.length < 2) return;

        const a = trail.points[0];
        const b = trail.points[trail.points.length - 1];
        const d = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
        d.addColorStop(0, palette.lineStart);
        d.addColorStop(1, palette.lineEnd);
        lineGradient = d;
    }

    // --- Géométrie -----------------------------------------------------------

    /**
     * Rectangles des cartes de la grille, exprimés dans le repère du canevas.
     * Les cartes de taille nulle (repli mobile en cours, carte masquée) sont
     * ignorées : elles n'obstruent rien.
     */
    function cardRects() {
        const origin = canvas.getBoundingClientRect();
        const rects = [];

        grid.querySelectorAll(':scope > .card').forEach(card => {
            const r = card.getBoundingClientRect();
            if (r.width < 2 || r.height < 2) return;
            rects.push({
                id: card.id,
                left: r.left - origin.left,
                top: r.top - origin.top,
                right: r.right - origin.left,
                bottom: r.bottom - origin.top,
                cx: r.left - origin.left + r.width / 2,
                cy: r.top - origin.top + r.height / 2,
                radius: parseFloat(getComputedStyle(card).borderTopLeftRadius) || 0
            });
        });

        return rects;
    }

    function expand(r, margin) {
        return {
            id: r.id,
            left: r.left - margin,
            top: r.top - margin,
            right: r.right + margin,
            bottom: r.bottom + margin,
            cx: r.cx,
            cy: r.cy,
            radius: r.radius + margin
        };
    }

    /**
     * Le segment [p1, p2] traverse-t-il le rectangle ? (découpage de Liang-Barsky)
     *
     * Le rectangle reçu est déjà dilaté ; il est ici rétréci d'EPSILON pour que
     * les points posés sur son pourtour, et les segments qui le longent, restent
     * du bon côté.
     */
    function segmentCrossesRect(p1, p2, r) {
        const minX = r.left + EPSILON;
        const maxX = r.right - EPSILON;
        const minY = r.top + EPSILON;
        const maxY = r.bottom - EPSILON;
        if (minX >= maxX || minY >= maxY) return false;

        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const p = [-dx, dx, -dy, dy];
        const q = [p1.x - minX, maxX - p1.x, p1.y - minY, maxY - p1.y];

        let t0 = 0;
        let t1 = 1;

        for (let i = 0; i < 4; i++) {
            if (p[i] === 0) {
                // Segment parallèle à cette paire de bords : s'il est hors de la
                // bande, il ne peut plus rencontrer le rectangle.
                if (q[i] < 0) return false;
            } else {
                const t = q[i] / p[i];
                if (p[i] < 0) {
                    if (t > t1) return false;
                    if (t > t0) t0 = t;
                } else {
                    if (t < t0) return false;
                    if (t < t1) t1 = t;
                }
            }
        }

        return t0 < t1;
    }

    function visible(p1, p2, obstacles) {
        for (let i = 0; i < obstacles.length; i++) {
            if (segmentCrossesRect(p1, p2, obstacles[i])) return false;
        }
        return true;
    }

    function insideRect(pt, r) {
        return pt.x > r.left + EPSILON && pt.x < r.right - EPSILON &&
               pt.y > r.top + EPSILON && pt.y < r.bottom - EPSILON;
    }

    /**
     * Un point est utilisable s'il ne tombe dans aucune carte dilatée et, quand
     * on confine le tracé, s'il reste dans le canevas : au-delà, la traînée
     * serait rognée par le bord.
     */
    function isUsablePoint(pt, obstacles, confineTo) {
        if (confineTo && (pt.x < 1 || pt.y < 1 || pt.x > cssWidth - 1 || pt.y > cssHeight - 1)) {
            return false;
        }
        for (let i = 0; i < obstacles.length; i++) {
            if (insideRect(pt, obstacles[i])) return false;
        }
        return true;
    }

    /** Point du pourtour de `rect` le plus proche de (px, py). */
    function projectOnRect(rect, px, py) {
        if (px > rect.left && px < rect.right && py > rect.top && py < rect.bottom) {
            // Point intérieur (cartes superposées) : on ressort par le bord le
            // plus proche plutôt que de rendre un point inutilisable.
            const d = [px - rect.left, rect.right - px, py - rect.top, rect.bottom - py];
            const min = Math.min.apply(null, d);
            if (min === d[0]) return { x: rect.left, y: py };
            if (min === d[1]) return { x: rect.right, y: py };
            if (min === d[2]) return { x: px, y: rect.top };
            return { x: px, y: rect.bottom };
        }
        return {
            x: clamp(px, rect.left, rect.right),
            y: clamp(py, rect.top, rect.bottom)
        };
    }

    /**
     * Comme `projeterSurRect`, mais en suivant l'angle arrondi de la carte.
     *
     * Une carte a 20 px de rayon : projeté sur le rectangle nu, un point de coin
     * atterrit à six pixels au-delà du bord visible, et la traînée sembler
     * flotter à côté de la carte. Le ramener sur l'arc la fait toucher.
     */
    function projectOnEdge(rect, px, py) {
        const p = projectOnRect(rect, px, py);
        const radius = rect.radius || 0;
        const surX = p.x === rect.left || p.x === rect.right;
        const surY = p.y === rect.top || p.y === rect.bottom;
        if (radius <= 0 || !surX || !surY) return p;

        const center = {
            x: p.x === rect.left ? rect.left + radius : rect.right - radius,
            y: p.y === rect.top ? rect.top + radius : rect.bottom - radius
        };
        const dx = px - center.x;
        const dy = py - center.y;
        const l = Math.hypot(dx, dy) || 1;
        return { x: center.x + (dx / l) * radius, y: center.y + (dy / l) * radius };
    }

    /**
     * Points d'accroche répartis sur le pourtour dilaté d'une carte.
     *
     * Le plus court chemin ne part pas d'un point imposé : il peut quitter la
     * carte n'importe où sur son bord. On échantillonne donc ce pourtour et on
     * laisse Dijkstra désigner le point de départ — et d'arrivée — réel, ce qui
     * fait naître la traînée du côté qui fait face à la destination.
     *
     * Chaque accroche retient son amarre : le point du bord *réel* de la carte
     * dont elle est issue. C'est là que la traînée commence et finit, pour
     * qu'elle relie visiblement les deux cartes au lieu de flotter à distance.
     * La longueur de cette amarre est comptée dans le coût du chemin, sans quoi
     * une accroche de coin, plus éloignée de la carte, serait choisie à tort.
     */
    function anchors(rect, realRect) {
        const width = rect.right - rect.left;
        const height = rect.bottom - rect.top;
        const pts = [
            { x: rect.left, y: rect.top },
            { x: rect.right, y: rect.top },
            { x: rect.right, y: rect.bottom },
            { x: rect.left, y: rect.bottom }
        ];

        const nx = clamp(Math.round(width / ANCHOR_STEP), 1, ANCHORS_PER_SIDE);
        for (let i = 1; i < nx; i++) {
            const x = rect.left + (width * i) / nx;
            pts.push({ x, y: rect.top }, { x, y: rect.bottom });
        }

        const ny = clamp(Math.round(height / ANCHOR_STEP), 1, ANCHORS_PER_SIDE);
        for (let i = 1; i < ny; i++) {
            const y = rect.top + (height * i) / ny;
            pts.push({ x: rect.left, y }, { x: rect.right, y });
        }

        pts.forEach(p => {
            p.anchor = projectOnEdge(realRect, p.x, p.y);
            p.cost = Math.hypot(p.x - p.anchor.x, p.y - p.anchor.y);
        });

        return pts;
    }

    /**
     * Ajoute à chaque liste d'accroches le vis-à-vis de celles de l'autre carte.
     *
     * Sans cela, deux cartes voisines n'ont que des accroches décalées, choisies
     * chacune sur son propre échantillonnage : la traînée traverserait la
     * gouttière en biais. Le vis-à-vis garantit au moins une paire parfaitement
     * en face, donc une liaison perpendiculaire.
     */
    function addFacingAnchors(a, rectA, realRectA, b, rectB, realRectB) {
        const project = (source, rect, realRect, target) => {
            source.forEach(p => {
                const q = projectOnRect(rect, p.x, p.y);
                q.anchor = projectOnEdge(realRect, q.x, q.y);
                q.cost = Math.hypot(q.x - q.anchor.x, q.y - q.anchor.y);
                target.push(q);
            });
        };
        const copyA = a.slice();
        project(b, rectA, realRectA, a);
        project(copyA, rectB, realRectB, b);
    }

    /**
     * Coins des cartes dilatées : les seuls points où un plus court chemin
     * contournant des rectangles peut changer de direction. Chacun retient le
     * rayon de sa carte, qui servira à arrondir le virage au bon endroit.
     */
    function corners(obstacles, confineTo) {
        const list = [];
        obstacles.forEach(o => {
            [
                { x: o.left, y: o.top },
                { x: o.right, y: o.top },
                { x: o.right, y: o.bottom },
                { x: o.left, y: o.bottom }
            ].forEach(pt => {
                pt.radius = o.radius;
                if (isUsablePoint(pt, obstacles, confineTo)) list.push(pt);
            });
        });
        return list;
    }

    /**
     * Dijkstra sur le graphe de visibilité.
     *
     * Chaque point de départ démarre au coût de son amarre, et l'amarre du point
     * d'arrivée s'ajoute à la relaxation : la distance manipulée est donc
     * exactement la longueur de la traînée finale, amarres comprises. Le premier
     * point d'arrivée extrait de la file donne le chemin optimal — les poids
     * étant des distances, donc positifs. Le graphe n'est pas construit
     * d'avance : les arêtes sont testées au moment où un nœud est extrait, ce
     * qui évite de calculer les visibilités de nœuds jamais atteints.
     */
    function shortestPath(starts, goals, waypoints, obstacles) {
        if (!starts.length || !goals.length) return null;

        const nodes = [];
        starts.forEach(p => nodes.push({ x: p.x, y: p.y, radius: 0, type: 0, anchor: p.anchor, cost: p.cost }));
        goals.forEach(p => nodes.push({ x: p.x, y: p.y, radius: 0, type: 1, anchor: p.anchor, cost: p.cost }));
        waypoints.forEach(p => nodes.push({ x: p.x, y: p.y, radius: p.radius, type: 2, cost: 0 }));

        const n = nodes.length;
        const dist = new Float64Array(n).fill(Infinity);
        const prev = new Int32Array(n).fill(-1);
        const seen = new Uint8Array(n);

        for (let i = 0; i < starts.length; i++) dist[i] = nodes[i].cost;

        for (let iter = 0; iter < n; iter++) {
            let u = -1;
            let best = Infinity;
            for (let i = 0; i < n; i++) {
                if (!seen[i] && dist[i] < best) {
                    best = dist[i];
                    u = i;
                }
            }
            if (u === -1) break;
            seen[u] = 1;

            if (nodes[u].type === 1) {
                const path = [];
                for (let cur = u; cur !== -1; cur = prev[cur]) {
                    path.unshift(nodes[cur]);
                }
                // Les amarres ferment le tracé sur le bord des deux cartes.
                path.unshift(path[0].anchor);
                path.push(path[path.length - 1].anchor);
                return path;
            }

            for (let v = 0; v < n; v++) {
                if (seen[v] || v === u || nodes[v].type === 0) continue;
                const d = dist[u] + Math.hypot(nodes[u].x - nodes[v].x, nodes[u].y - nodes[v].y)
                    + nodes[v].cost;
                if (d >= dist[v]) continue;
                if (!visible(nodes[u], nodes[v], obstacles)) continue;
                dist[v] = d;
                prev[v] = u;
            }
        }

        return null;
    }

    /**
     * Remplace chaque sommet par un virage tangent aux deux segments voisins,
     * et rend une polyligne dense.
     *
     * Le rayon employé est celui de la carte contournée augmenté de la marge :
     * l'arc obtenu est alors exactement la courbe parallèle au bord arrondi de
     * cette carte, à distance constante. Il est réduit si les segments voisins
     * sont trop courts pour l'accueillir, et le virage est sauté quand les deux
     * segments sont pratiquement alignés.
     */
    function roundCorners(vertices) {
        if (vertices.length < 3) return vertices.map(p => ({ x: p.x, y: p.y }));

        const out = [{ x: vertices[0].x, y: vertices[0].y }];

        for (let i = 1; i < vertices.length - 1; i++) {
            const a = vertices[i - 1];
            const b = vertices[i];
            const c = vertices[i + 1];

            const l1 = Math.hypot(a.x - b.x, a.y - b.y);
            const l2 = Math.hypot(c.x - b.x, c.y - b.y);
            if (l1 < 0.5 || l2 < 0.5) continue;

            const u1x = (a.x - b.x) / l1;
            const u1y = (a.y - b.y) / l1;
            const u2x = (c.x - b.x) / l2;
            const u2y = (c.y - b.y) / l2;

            const angle = Math.acos(clamp(u1x * u2x + u1y * u2y, -1, 1));
            if (angle > Math.PI - 0.06 || angle < 0.06) {
                out.push({ x: b.x, y: b.y });
                continue;
            }

            const halfTan = Math.tan(angle / 2);
            let radius = b.radius > 0 ? b.radius : DEFAULT_RADIUS;
            let tangent = radius / halfTan;
            const maxTangent = Math.min(l1, l2) * 0.5;
            if (tangent > maxTangent) {
                tangent = maxTangent;
                radius = tangent * halfTan;
            }

            const p1 = { x: b.x + u1x * tangent, y: b.y + u1y * tangent };
            const p2 = { x: b.x + u2x * tangent, y: b.y + u2y * tangent };

            // Centre de l'arc : sur la bissectrice de l'angle, à r / sin(θ/2).
            const bx = u1x + u2x;
            const by = u1y + u2y;
            const lb = Math.hypot(bx, by);
            if (lb < 1e-6) {
                out.push({ x: b.x, y: b.y });
                continue;
            }
            const dCenter = radius / Math.sin(angle / 2);
            const cx = b.x + (bx / lb) * dCenter;
            const cy = b.y + (by / lb) * dCenter;

            const a1 = Math.atan2(p1.y - cy, p1.x - cx);
            const a2 = Math.atan2(p2.y - cy, p2.x - cx);
            let sweep = a2 - a1;
            while (sweep > Math.PI) sweep -= 2 * Math.PI;
            while (sweep < -Math.PI) sweep += 2 * Math.PI;

            const step = Math.max(2, Math.ceil(Math.abs(sweep) / 0.2));
            for (let k = 0; k <= step; k++) {
                const t = a1 + (sweep * k) / step;
                out.push({ x: cx + Math.cos(t) * radius, y: cy + Math.sin(t) * radius });
            }
        }

        const lastOne = vertices[vertices.length - 1];
        out.push({ x: lastOne.x, y: lastOne.y });
        return out;
    }

    /** Abscisse curviligne de la polyligne : indispensable à une vitesse constante. */
    function buildTrail(points) {
        const lengths = new Float64Array(points.length);
        let total = 0;
        for (let i = 1; i < points.length; i++) {
            total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
            lengths[i] = total;
        }
        return { points, lengths, total };
    }

    /** Position et tangente unitaire à la distance `d` du départ. */
    function pointAt(d) {
        const pts = trail.points;
        const lng = trail.lengths;
        const target = clamp(d, 0, trail.total);

        let bottom = 0;
        let top = pts.length - 1;
        while (top - bottom > 1) {
            const middle = (bottom + top) >> 1;
            if (lng[middle] <= target) bottom = middle;
            else top = middle;
        }

        const segment = lng[top] - lng[bottom];
        const t = segment > 1e-6 ? (target - lng[bottom]) / segment : 0;
        const dx = pts[top].x - pts[bottom].x;
        const dy = pts[top].y - pts[bottom].y;
        const l = Math.hypot(dx, dy) || 1;

        return {
            x: pts[bottom].x + dx * t,
            y: pts[bottom].y + dy * t,
            tx: dx / l,
            ty: dy / l
        };
    }

    // --- Calcul du tracé -----------------------------------------------------

    function recomputeTrail() {
        if (!canvas || !ctx || !grid) return;
        if (cssWidth < 2 || cssHeight < 2) return;

        const idCible = TARGET_CARDS[currentTarget] || TARGET_CARDS.queue;
        const rects = cardRects();
        const source = rects.find(r => r.id === SOURCE_CARD_ID);
        const target = rects.find(r => r.id === idCible);

        if (!source || !target || source === target) {
            trail = null;
            particles = [];
            return;
        }

        // La marge vaut la demi-gouttière de la grille : le tracé court alors au
        // milieu exact de l'espace entre deux cartes voisines.
        const gap = parseFloat(getComputedStyle(grid).columnGap) || 16;
        const margin = clamp(gap / 2, MIN_MARGIN, MAX_MARGIN);

        const obstacles = rects.map(r => expand(r, margin));
        const sourceD = obstacles.find(o => o.id === SOURCE_CARD_ID);
        const targetD = obstacles.find(o => o.id === idCible);

        const from = anchors(sourceD, source);
        const goal = anchors(targetD, target);
        addFacingAnchors(from, sourceD, source, goal, targetD, target);

        // Premier essai en restant dans le canevas, pour que la traînée ne soit
        // jamais coupée par son bord ; second essai sans cette contrainte, au cas
        // où les cartes ne laisseraient aucun passage intérieur.
        let vertices = null;
        for (const confineTo of [true, false]) {
            const usable = p => isUsablePoint(p, obstacles, confineTo);
            vertices = shortestPath(
                from.filter(usable),
                goal.filter(usable),
                corners(obstacles, confineTo),
                obstacles
            );
            if (vertices) break;
        }

        if (!vertices || vertices.length < 2) {
            // Dernier recours : la droite entre les deux cartes. On n'y arrive
            // que si aucune route dégagée n'existe, cartes jointives comprises.
            vertices = [
                projectOnEdge(source, target.cx, target.cy),
                projectOnEdge(target, source.cx, source.cy)
            ];
        }

        const previousTotal = trail ? trail.total : 0;
        trail = buildTrail(roundCorners(vertices));

        adjustParticles(previousTotal);
        buildGradient();
    }

    // --- Particules ----------------------------------------------------------

    function newParticle(distance) {
        const slowness = reducedMotion ? 0.5 : 1;
        return {
            distance,
            speed: (MIN_SPEED + Math.random() * (MAX_SPEED - MIN_SPEED)) * slowness,
            size: 1.5 + Math.random() * 1.1,
            // Léger écart perpendiculaire : la traînée respire sans quitter le tracé.
            gap: (Math.random() - 0.5) * 2.4,
            hue: Math.floor(Math.random() * 3)
        };
    }

    /**
     * Ajuste le nombre de particules à la longueur du tracé.
     *
     * Les particules existantes sont conservées et leur avancement mis à
     * l'échelle : pendant qu'on déplace une carte, le tracé est recalculé à
     * chaque image et un réamorçage ferait scintiller la traînée.
     */
    function adjustParticles(previousTotal) {
        if (!trail || trail.total < 4) {
            particles = [];
            return;
        }

        if (previousTotal > 1) {
            const factor = trail.total / previousTotal;
            particles.forEach(p => { p.distance *= factor; });
        }

        const density = reducedMotion ? PARTICLE_SPACING * 2 : PARTICLE_SPACING;
        const wanted = clamp(Math.round(trail.total / density), MIN_PARTICLES, MAX_PARTICLES);

        while (particles.length > wanted) particles.pop();
        while (particles.length < wanted) {
            particles.push(newParticle(Math.random() * trail.total));
        }
    }

    // --- Rendu ---------------------------------------------------------------

    function draw(dt) {
        ctx.clearRect(0, 0, cssWidth, cssHeight);
        if (!trail || trail.total < 4 || !palette) return;

        const pts = trail.points;

        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';

        // Ligne guide : elle indique la destination même à l'arrêt.
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.lineWidth = palette.strokeWidth;
        ctx.strokeStyle = lineGradient || palette.lineStart;
        ctx.stroke();

        const fade = Math.min(FADE_DISTANCE, trail.total / 3);

        particles.forEach(p => {
            p.distance += p.speed * dt;
            if (p.distance > trail.total) p.distance -= trail.total;

            const color = palette.colors[p.hue % palette.colors.length];
            const falloff = Math.min(1, p.distance / fade, (trail.total - p.distance) / fade);
            if (falloff <= 0.01) return;
            const alpha = falloff * palette.alpha;

            const head = pointAt(p.distance);
            const tx = head.x - head.ty * p.gap;
            const ty = head.y + head.tx * p.gap;

            // Comète : quelques segments qui suivent le tracé en s'effaçant.
            let prevX = tx;
            let prevY = ty;
            for (let s = 1; s <= TAIL_SEGMENTS; s++) {
                const d = p.distance - (TAIL_LENGTH * s) / TAIL_SEGMENTS;
                if (d < 0) break;
                const q = pointAt(d);
                const qx = q.x - q.ty * p.gap;
                const qy = q.y + q.tx * p.gap;

                const part = 1 - s / TAIL_SEGMENTS;
                ctx.beginPath();
                ctx.moveTo(prevX, prevY);
                ctx.lineTo(qx, qy);
                ctx.lineWidth = p.size * (0.35 + part * 0.75);
                ctx.strokeStyle = rgba(color, alpha * part * 0.55);
                ctx.stroke();

                prevX = qx;
                prevY = qy;
            }

            ctx.save();
            if (palette.glow > 0) {
                ctx.shadowColor = rgba(color, alpha);
                ctx.shadowBlur = palette.glow;
            }
            ctx.fillStyle = rgba(color, alpha);
            ctx.beginPath();
            ctx.arc(tx, ty, p.size, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        });
    }

    function loop(now) {
        if (!active) {
            animationId = null;
            return;
        }

        const dt = lastTime ? Math.min((now - lastTime) / 1000, DT_MAX) : 0;
        lastTime = now;

        if (recomputeRequested) {
            recomputeRequested = false;
            resize();
            recomputeTrail();
        }

        draw(dt);
        animationId = requestAnimationFrame(loop);
    }

    function start() {
        if (!active || animationId !== null || document.hidden) return;
        lastTime = 0;
        animationId = requestAnimationFrame(loop);
    }

    function stop() {
        if (animationId !== null) {
            cancelAnimationFrame(animationId);
            animationId = null;
        }
        if (ctx) ctx.clearRect(0, 0, cssWidth, cssHeight);
    }

    /**
     * Marque le tracé comme à refaire.
     *
     * Le recalcul lui-même est reporté à la prochaine image : déplacer une carte
     * émet des dizaines de mutations par seconde, qui n'ont pas à déclencher
     * autant de Dijkstra. Quand l'animation est à l'arrêt (onglet caché), la
     * demande reste en attente et sera honorée à la reprise.
     */
    function requestRecompute() {
        recomputeRequested = true;
    }

    // --- Canevas -------------------------------------------------------------

    function resize() {
        if (!canvas || !grid) return;

        const rect = grid.getBoundingClientRect();
        const l = Math.max(0, Math.round(rect.width));
        const h = Math.max(0, Math.round(rect.height));
        const dpr = window.devicePixelRatio || 1;

        if (l === cssWidth && h === cssHeight && canvas.width === Math.round(l * dpr)) return;

        cssWidth = l;
        cssHeight = h;
        canvas.style.width = l + 'px';
        canvas.style.height = h + 'px';
        canvas.width = Math.round(l * dpr);
        canvas.height = Math.round(h * dpr);
        // Le contexte raisonne en pixels CSS ; l'échelle rend le tracé net sur
        // les écrans à forte densité.
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function createCanvas() {
        // Le canevas se cale sur la grille : celle-ci doit lui servir de repère.
        if (getComputedStyle(grid).position === 'static') {
            grid.style.position = 'relative';
        }

        canvas = document.getElementById(CANVAS_ID);
        if (!canvas) {
            canvas = document.createElement('canvas');
            canvas.id = CANVAS_ID;
            canvas.style.position = 'absolute';
            canvas.style.top = '0';
            canvas.style.left = '0';
            canvas.style.pointerEvents = 'none';
            canvas.style.zIndex = '90';
            grid.appendChild(canvas);
        }
        ctx = canvas.getContext('2d');
    }

    // --- Cycle de vie --------------------------------------------------------

    function setActive(value) {
        active = !!value;
        localStorage.setItem('particlePathEnabled', active);

        if (!canvas) return;
        if (active) {
            canvas.style.display = 'block';
            resize();
            recomputeTrail();
            start();
        } else {
            stop();
            canvas.style.display = 'none';
        }
    }

    function init() {
        if (initialised) return;
        grid = document.getElementById('dashboard-grid');
        if (!grid) return;

        createCanvas();
        resize();
        buildPalette();

        const selectEl = document.getElementById('add-target-select');
        if (selectEl) {
            currentTarget = selectEl.value || 'queue';
            selectEl.addEventListener('change', () => {
                currentTarget = selectEl.value || 'queue';
                requestRecompute();
            });
        }

        const toggleEl = document.getElementById('particle-path-enable-toggle');
        if (toggleEl) {
            toggleEl.checked = active;
            toggleEl.addEventListener('change', e => setActive(e.target.checked));
        }

        // Déplacement d'une carte : seules ses propriétés de grille changent,
        // sa taille peut rester identique — un ResizeObserver ne suffit pas.
        new MutationObserver(requestRecompute).observe(grid, {
            attributes: true,
            subtree: true,
            attributeFilter: ['style', 'class']
        });

        // Redimensionnement d'une carte, de la grille, ou contenu qui pousse une
        // carte à grandir.
        if (window.ResizeObserver) {
            const ro = new ResizeObserver(requestRecompute);
            ro.observe(grid);
            grid.querySelectorAll(':scope > .card').forEach(c => ro.observe(c));
        }
        window.addEventListener('resize', requestRecompute);

        // Changement de style ou de thème : la palette entière est refaite.
        new MutationObserver(buildPalette).observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['data-style', 'data-theme']
        });

        document.addEventListener('visibilitychange', () => {
            if (document.hidden) stop();
            else if (active) { requestRecompute(); start(); }
        });

        if (active) {
            recomputeTrail();
            start();
        } else {
            canvas.style.display = 'none';
        }

        initialised = true;
    }

    window.MusicPlayer.ParticlePath = {
        init,
        recalculatePath: requestRecompute,
        setTarget: function (key) {
            currentTarget = key;
            requestRecompute();
        },
        setEnabled: setActive,
        isEnabled: function () { return active; }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
