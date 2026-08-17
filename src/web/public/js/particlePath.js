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

    const ID_CANEVAS = 'particle-path-canvas';
    const ID_CARTE_SOURCE = 'search-card';
    const CARTES_CIBLES = {
        queue: 'queue-card',
        playlist: 'playlists-card',
        play: 'player-card'
    };

    // --- Réglages du tracé ---------------------------------------------------

    /** Bornes de la marge laissée entre le tracé et le bord d'une carte (px). */
    const MARGE_MIN = 6;
    const MARGE_MAX = 14;
    /**
     * Retrait appliqué aux rectangles pendant les tests de visibilité.
     *
     * Les points de passage sont posés *sur* le pourtour dilaté ; sans ce
     * retrait, un segment qui longe ce pourtour — le cas le plus fréquent, une
     * traînée qui suit une gouttière — serait compté comme traversant la carte.
     */
    const EPSILON = 0.5;
    /** Espacement des points d'accroche le long du pourtour départ/arrivée (px). */
    const PAS_ANCRAGE = 40;
    /** Nombre maximal de points d'accroche par côté de carte. */
    const ANCRAGES_PAR_COTE = 6;
    /** Rayon de virage employé quand le sommet n'appartient à aucune carte. */
    const RAYON_DEFAUT = 10;

    // --- Réglages de l'animation --------------------------------------------

    /** Une particule tous les N pixels de tracé. */
    const ESPACEMENT_PARTICULES = 60;
    const PARTICULES_MIN = 5;
    const PARTICULES_MAX = 26;
    /** Vitesse de parcours, constante en pixels par seconde. */
    const VITESSE_MIN = 70;
    const VITESSE_MAX = 110;
    /** Longueur de la comète derrière chaque particule (px). */
    const LONGUEUR_QUEUE = 26;
    /** Nombre de segments composant cette comète. */
    const SEGMENTS_QUEUE = 5;
    /**
     * Distance de fondu à chaque extrémité (px) : les particules naissent au
     * bord de la carte source et s'éteignent au bord de la carte visée, au lieu
     * d'apparaître et de disparaître d'un coup.
     */
    const FONDU = 36;
    /** Plafond du delta de temps, pour ne pas téléporter les particules au retour d'un onglet. */
    const DT_MAX = 0.05;

    // --- État ----------------------------------------------------------------

    let canvas = null;
    let ctx = null;
    let grille = null;
    let largeurCSS = 0;
    let hauteurCSS = 0;

    /** { points, longueurs, total } — polyligne dense et abscisse curviligne. */
    let trace = null;
    let particules = [];
    let palette = null;
    let degradeLigne = null;

    let cibleCourante = 'queue';
    let idAnimation = null;
    let dernierInstant = 0;
    let recalculDemande = false;
    let initialise = false;

    let actif = localStorage.getItem('particlePathEnabled') !== 'false';
    const mouvementReduit = window.matchMedia
        ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
        : false;

    // --- Utilitaires ---------------------------------------------------------

    function borne(v, min, max) {
        return Math.max(min, Math.min(max, v));
    }

    /**
     * Normalise n'importe quelle couleur CSS en composantes { r, g, b }.
     *
     * Le canevas fait le travail : lui affecter une couleur puis relire la
     * propriété rend toujours une forme canonique, quelle que soit l'écriture
     * d'origine (mot-clé, #abc, rgb(), hsl()...).
     */
    const ctxCouleur = document.createElement('canvas').getContext('2d');
    function versRGB(css, repli) {
        ctxCouleur.fillStyle = '#000000';
        try {
            ctxCouleur.fillStyle = css;
        } catch (e) { /* couleur invalide : le noir reste en place */ }
        let norme = ctxCouleur.fillStyle;

        if (norme === '#000000' && !/^#0{3,6}$|black/i.test(String(css).trim())) {
            // La couleur n'a pas été comprise : on retombe sur le repli.
            ctxCouleur.fillStyle = repli;
            norme = ctxCouleur.fillStyle;
        }

        if (norme[0] === '#') {
            const hex = norme.length === 4
                ? norme[1] + norme[1] + norme[2] + norme[2] + norme[3] + norme[3]
                : norme.slice(1);
            const n = parseInt(hex, 16);
            return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
        }

        const m = norme.match(/([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/);
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
    function construirePalette() {
        const racine = document.documentElement;
        const styles = getComputedStyle(racine);
        const lire = (nom, repli) => versRGB(styles.getPropertyValue(nom).trim(), repli);

        const style = racine.getAttribute('data-style') || 'glassmorphism';
        const clair = racine.getAttribute('data-theme') === 'light';
        const sobre = style === 'minimalist';

        const primaire = lire('--c-primary', '#5865F2');
        const accent = lire('--c-accent', '#EB459E');
        const violet = lire('--c-violet', '#8e44ad');

        palette = {
            couleurs: sobre ? [primaire, accent] : [primaire, accent, violet],
            debutLigne: rgba(primaire, clair ? 0.34 : 0.22),
            finLigne: rgba(accent, clair ? 0.34 : 0.22),
            largeurTrait: sobre ? 1 : 1.3,
            // Un halo sur fond clair ne fait que délaver la couleur : il est
            // réduit en thème clair, supprimé en minimaliste.
            lueur: sobre ? 0 : (clair ? 5 : 10),
            alpha: clair ? 0.95 : 0.85
        };

        construireDegrade();
    }

    /** Dégradé de la ligne guide, tendu d'un bout à l'autre du tracé. */
    function construireDegrade() {
        degradeLigne = null;
        if (!ctx || !palette || !trace || trace.points.length < 2) return;

        const a = trace.points[0];
        const b = trace.points[trace.points.length - 1];
        const d = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
        d.addColorStop(0, palette.debutLigne);
        d.addColorStop(1, palette.finLigne);
        degradeLigne = d;
    }

    // --- Géométrie -----------------------------------------------------------

    /**
     * Rectangles des cartes de la grille, exprimés dans le repère du canevas.
     * Les cartes de taille nulle (repli mobile en cours, carte masquée) sont
     * ignorées : elles n'obstruent rien.
     */
    function rectanglesDesCartes() {
        const origine = canvas.getBoundingClientRect();
        const rects = [];

        grille.querySelectorAll(':scope > .card').forEach(carte => {
            const r = carte.getBoundingClientRect();
            if (r.width < 2 || r.height < 2) return;
            rects.push({
                id: carte.id,
                left: r.left - origine.left,
                top: r.top - origine.top,
                right: r.right - origine.left,
                bottom: r.bottom - origine.top,
                cx: r.left - origine.left + r.width / 2,
                cy: r.top - origine.top + r.height / 2,
                rayon: parseFloat(getComputedStyle(carte).borderTopLeftRadius) || 0
            });
        });

        return rects;
    }

    function dilater(r, marge) {
        return {
            id: r.id,
            left: r.left - marge,
            top: r.top - marge,
            right: r.right + marge,
            bottom: r.bottom + marge,
            cx: r.cx,
            cy: r.cy,
            rayon: r.rayon + marge
        };
    }

    /**
     * Le segment [p1, p2] traverse-t-il le rectangle ? (découpage de Liang-Barsky)
     *
     * Le rectangle reçu est déjà dilaté ; il est ici rétréci d'EPSILON pour que
     * les points posés sur son pourtour, et les segments qui le longent, restent
     * du bon côté.
     */
    function segmentCoupeRect(p1, p2, r) {
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
            if (segmentCoupeRect(p1, p2, obstacles[i])) return false;
        }
        return true;
    }

    function dansRect(pt, r) {
        return pt.x > r.left + EPSILON && pt.x < r.right - EPSILON &&
               pt.y > r.top + EPSILON && pt.y < r.bottom - EPSILON;
    }

    /**
     * Un point est utilisable s'il ne tombe dans aucune carte dilatée et, quand
     * on confine le tracé, s'il reste dans le canevas : au-delà, la traînée
     * serait rognée par le bord.
     */
    function pointUtilisable(pt, obstacles, confiner) {
        if (confiner && (pt.x < 1 || pt.y < 1 || pt.x > largeurCSS - 1 || pt.y > hauteurCSS - 1)) {
            return false;
        }
        for (let i = 0; i < obstacles.length; i++) {
            if (dansRect(pt, obstacles[i])) return false;
        }
        return true;
    }

    /** Point du pourtour de `rect` le plus proche de (px, py). */
    function projeterSurRect(rect, px, py) {
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
            x: borne(px, rect.left, rect.right),
            y: borne(py, rect.top, rect.bottom)
        };
    }

    /**
     * Comme `projeterSurRect`, mais en suivant l'angle arrondi de la carte.
     *
     * Une carte a 20 px de rayon : projeté sur le rectangle nu, un point de coin
     * atterrit à six pixels au-delà du bord visible, et la traînée sembler
     * flotter à côté de la carte. Le ramener sur l'arc la fait toucher.
     */
    function projeterSurBord(rect, px, py) {
        const p = projeterSurRect(rect, px, py);
        const rayon = rect.rayon || 0;
        const surX = p.x === rect.left || p.x === rect.right;
        const surY = p.y === rect.top || p.y === rect.bottom;
        if (rayon <= 0 || !surX || !surY) return p;

        const centre = {
            x: p.x === rect.left ? rect.left + rayon : rect.right - rayon,
            y: p.y === rect.top ? rect.top + rayon : rect.bottom - rayon
        };
        const dx = px - centre.x;
        const dy = py - centre.y;
        const l = Math.hypot(dx, dy) || 1;
        return { x: centre.x + (dx / l) * rayon, y: centre.y + (dy / l) * rayon };
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
    function ancrages(rect, rectReel) {
        const largeur = rect.right - rect.left;
        const hauteur = rect.bottom - rect.top;
        const pts = [
            { x: rect.left, y: rect.top },
            { x: rect.right, y: rect.top },
            { x: rect.right, y: rect.bottom },
            { x: rect.left, y: rect.bottom }
        ];

        const nx = borne(Math.round(largeur / PAS_ANCRAGE), 1, ANCRAGES_PAR_COTE);
        for (let i = 1; i < nx; i++) {
            const x = rect.left + (largeur * i) / nx;
            pts.push({ x, y: rect.top }, { x, y: rect.bottom });
        }

        const ny = borne(Math.round(hauteur / PAS_ANCRAGE), 1, ANCRAGES_PAR_COTE);
        for (let i = 1; i < ny; i++) {
            const y = rect.top + (hauteur * i) / ny;
            pts.push({ x: rect.left, y }, { x: rect.right, y });
        }

        pts.forEach(p => {
            p.amarre = projeterSurBord(rectReel, p.x, p.y);
            p.cout = Math.hypot(p.x - p.amarre.x, p.y - p.amarre.y);
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
    function ajouterVisAVis(a, rectA, rectAReel, b, rectB, rectBReel) {
        const projeter = (source, rect, rectReel, cible) => {
            source.forEach(p => {
                const q = projeterSurRect(rect, p.x, p.y);
                q.amarre = projeterSurBord(rectReel, q.x, q.y);
                q.cout = Math.hypot(q.x - q.amarre.x, q.y - q.amarre.y);
                cible.push(q);
            });
        };
        const copieA = a.slice();
        projeter(b, rectA, rectAReel, a);
        projeter(copieA, rectB, rectBReel, b);
    }

    /**
     * Coins des cartes dilatées : les seuls points où un plus court chemin
     * contournant des rectangles peut changer de direction. Chacun retient le
     * rayon de sa carte, qui servira à arrondir le virage au bon endroit.
     */
    function coins(obstacles, confiner) {
        const liste = [];
        obstacles.forEach(o => {
            [
                { x: o.left, y: o.top },
                { x: o.right, y: o.top },
                { x: o.right, y: o.bottom },
                { x: o.left, y: o.bottom }
            ].forEach(pt => {
                pt.rayon = o.rayon;
                if (pointUtilisable(pt, obstacles, confiner)) liste.push(pt);
            });
        });
        return liste;
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
    function plusCourtChemin(departs, arrivees, sommetsIntermediaires, obstacles) {
        if (!departs.length || !arrivees.length) return null;

        const noeuds = [];
        departs.forEach(p => noeuds.push({ x: p.x, y: p.y, rayon: 0, type: 0, amarre: p.amarre, cout: p.cout }));
        arrivees.forEach(p => noeuds.push({ x: p.x, y: p.y, rayon: 0, type: 1, amarre: p.amarre, cout: p.cout }));
        sommetsIntermediaires.forEach(p => noeuds.push({ x: p.x, y: p.y, rayon: p.rayon, type: 2, cout: 0 }));

        const n = noeuds.length;
        const dist = new Float64Array(n).fill(Infinity);
        const prec = new Int32Array(n).fill(-1);
        const vus = new Uint8Array(n);

        for (let i = 0; i < departs.length; i++) dist[i] = noeuds[i].cout;

        for (let iter = 0; iter < n; iter++) {
            let u = -1;
            let meilleur = Infinity;
            for (let i = 0; i < n; i++) {
                if (!vus[i] && dist[i] < meilleur) {
                    meilleur = dist[i];
                    u = i;
                }
            }
            if (u === -1) break;
            vus[u] = 1;

            if (noeuds[u].type === 1) {
                const chemin = [];
                for (let cur = u; cur !== -1; cur = prec[cur]) {
                    chemin.unshift(noeuds[cur]);
                }
                // Les amarres ferment le tracé sur le bord des deux cartes.
                chemin.unshift(chemin[0].amarre);
                chemin.push(chemin[chemin.length - 1].amarre);
                return chemin;
            }

            for (let v = 0; v < n; v++) {
                if (vus[v] || v === u || noeuds[v].type === 0) continue;
                const d = dist[u] + Math.hypot(noeuds[u].x - noeuds[v].x, noeuds[u].y - noeuds[v].y)
                    + noeuds[v].cout;
                if (d >= dist[v]) continue;
                if (!visible(noeuds[u], noeuds[v], obstacles)) continue;
                dist[v] = d;
                prec[v] = u;
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
    function arrondirAngles(sommets) {
        if (sommets.length < 3) return sommets.map(p => ({ x: p.x, y: p.y }));

        const sortie = [{ x: sommets[0].x, y: sommets[0].y }];

        for (let i = 1; i < sommets.length - 1; i++) {
            const a = sommets[i - 1];
            const b = sommets[i];
            const c = sommets[i + 1];

            const l1 = Math.hypot(a.x - b.x, a.y - b.y);
            const l2 = Math.hypot(c.x - b.x, c.y - b.y);
            if (l1 < 0.5 || l2 < 0.5) continue;

            const u1x = (a.x - b.x) / l1;
            const u1y = (a.y - b.y) / l1;
            const u2x = (c.x - b.x) / l2;
            const u2y = (c.y - b.y) / l2;

            const angle = Math.acos(borne(u1x * u2x + u1y * u2y, -1, 1));
            if (angle > Math.PI - 0.06 || angle < 0.06) {
                sortie.push({ x: b.x, y: b.y });
                continue;
            }

            const demiTan = Math.tan(angle / 2);
            let rayon = b.rayon > 0 ? b.rayon : RAYON_DEFAUT;
            let tangente = rayon / demiTan;
            const tangenteMax = Math.min(l1, l2) * 0.5;
            if (tangente > tangenteMax) {
                tangente = tangenteMax;
                rayon = tangente * demiTan;
            }

            const p1 = { x: b.x + u1x * tangente, y: b.y + u1y * tangente };
            const p2 = { x: b.x + u2x * tangente, y: b.y + u2y * tangente };

            // Centre de l'arc : sur la bissectrice de l'angle, à r / sin(θ/2).
            const bx = u1x + u2x;
            const by = u1y + u2y;
            const lb = Math.hypot(bx, by);
            if (lb < 1e-6) {
                sortie.push({ x: b.x, y: b.y });
                continue;
            }
            const dCentre = rayon / Math.sin(angle / 2);
            const cx = b.x + (bx / lb) * dCentre;
            const cy = b.y + (by / lb) * dCentre;

            const a1 = Math.atan2(p1.y - cy, p1.x - cx);
            const a2 = Math.atan2(p2.y - cy, p2.x - cx);
            let balayage = a2 - a1;
            while (balayage > Math.PI) balayage -= 2 * Math.PI;
            while (balayage < -Math.PI) balayage += 2 * Math.PI;

            const pas = Math.max(2, Math.ceil(Math.abs(balayage) / 0.2));
            for (let k = 0; k <= pas; k++) {
                const t = a1 + (balayage * k) / pas;
                sortie.push({ x: cx + Math.cos(t) * rayon, y: cy + Math.sin(t) * rayon });
            }
        }

        const dernier = sommets[sommets.length - 1];
        sortie.push({ x: dernier.x, y: dernier.y });
        return sortie;
    }

    /** Abscisse curviligne de la polyligne : indispensable à une vitesse constante. */
    function construireTrace(points) {
        const longueurs = new Float64Array(points.length);
        let total = 0;
        for (let i = 1; i < points.length; i++) {
            total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
            longueurs[i] = total;
        }
        return { points, longueurs, total };
    }

    /** Position et tangente unitaire à la distance `d` du départ. */
    function pointA(d) {
        const pts = trace.points;
        const lng = trace.longueurs;
        const cible = borne(d, 0, trace.total);

        let bas = 0;
        let haut = pts.length - 1;
        while (haut - bas > 1) {
            const milieu = (bas + haut) >> 1;
            if (lng[milieu] <= cible) bas = milieu;
            else haut = milieu;
        }

        const segment = lng[haut] - lng[bas];
        const t = segment > 1e-6 ? (cible - lng[bas]) / segment : 0;
        const dx = pts[haut].x - pts[bas].x;
        const dy = pts[haut].y - pts[bas].y;
        const l = Math.hypot(dx, dy) || 1;

        return {
            x: pts[bas].x + dx * t,
            y: pts[bas].y + dy * t,
            tx: dx / l,
            ty: dy / l
        };
    }

    // --- Calcul du tracé -----------------------------------------------------

    function recalculerTrace() {
        if (!canvas || !ctx || !grille) return;
        if (largeurCSS < 2 || hauteurCSS < 2) return;

        const idCible = CARTES_CIBLES[cibleCourante] || CARTES_CIBLES.queue;
        const rects = rectanglesDesCartes();
        const source = rects.find(r => r.id === ID_CARTE_SOURCE);
        const cible = rects.find(r => r.id === idCible);

        if (!source || !cible || source === cible) {
            trace = null;
            particules = [];
            return;
        }

        // La marge vaut la demi-gouttière de la grille : le tracé court alors au
        // milieu exact de l'espace entre deux cartes voisines.
        const gap = parseFloat(getComputedStyle(grille).columnGap) || 16;
        const marge = borne(gap / 2, MARGE_MIN, MARGE_MAX);

        const obstacles = rects.map(r => dilater(r, marge));
        const sourceD = obstacles.find(o => o.id === ID_CARTE_SOURCE);
        const cibleD = obstacles.find(o => o.id === idCible);

        const depart = ancrages(sourceD, source);
        const arrivee = ancrages(cibleD, cible);
        ajouterVisAVis(depart, sourceD, source, arrivee, cibleD, cible);

        // Premier essai en restant dans le canevas, pour que la traînée ne soit
        // jamais coupée par son bord ; second essai sans cette contrainte, au cas
        // où les cartes ne laisseraient aucun passage intérieur.
        let sommets = null;
        for (const confiner of [true, false]) {
            const utilisables = p => pointUtilisable(p, obstacles, confiner);
            sommets = plusCourtChemin(
                depart.filter(utilisables),
                arrivee.filter(utilisables),
                coins(obstacles, confiner),
                obstacles
            );
            if (sommets) break;
        }

        if (!sommets || sommets.length < 2) {
            // Dernier recours : la droite entre les deux cartes. On n'y arrive
            // que si aucune route dégagée n'existe, cartes jointives comprises.
            sommets = [
                projeterSurBord(source, cible.cx, cible.cy),
                projeterSurBord(cible, source.cx, source.cy)
            ];
        }

        const ancienTotal = trace ? trace.total : 0;
        trace = construireTrace(arrondirAngles(sommets));

        ajusterParticules(ancienTotal);
        construireDegrade();
    }

    // --- Particules ----------------------------------------------------------

    function nouvelleParticule(distance) {
        const lenteur = mouvementReduit ? 0.5 : 1;
        return {
            distance,
            vitesse: (VITESSE_MIN + Math.random() * (VITESSE_MAX - VITESSE_MIN)) * lenteur,
            taille: 1.5 + Math.random() * 1.1,
            // Léger écart perpendiculaire : la traînée respire sans quitter le tracé.
            ecart: (Math.random() - 0.5) * 2.4,
            teinte: Math.floor(Math.random() * 3)
        };
    }

    /**
     * Ajuste le nombre de particules à la longueur du tracé.
     *
     * Les particules existantes sont conservées et leur avancement mis à
     * l'échelle : pendant qu'on déplace une carte, le tracé est recalculé à
     * chaque image et un réamorçage ferait scintiller la traînée.
     */
    function ajusterParticules(ancienTotal) {
        if (!trace || trace.total < 4) {
            particules = [];
            return;
        }

        if (ancienTotal > 1) {
            const facteur = trace.total / ancienTotal;
            particules.forEach(p => { p.distance *= facteur; });
        }

        const densite = mouvementReduit ? ESPACEMENT_PARTICULES * 2 : ESPACEMENT_PARTICULES;
        const voulu = borne(Math.round(trace.total / densite), PARTICULES_MIN, PARTICULES_MAX);

        while (particules.length > voulu) particules.pop();
        while (particules.length < voulu) {
            particules.push(nouvelleParticule(Math.random() * trace.total));
        }
    }

    // --- Rendu ---------------------------------------------------------------

    function dessiner(dt) {
        ctx.clearRect(0, 0, largeurCSS, hauteurCSS);
        if (!trace || trace.total < 4 || !palette) return;

        const pts = trace.points;

        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';

        // Ligne guide : elle indique la destination même à l'arrêt.
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.lineWidth = palette.largeurTrait;
        ctx.strokeStyle = degradeLigne || palette.debutLigne;
        ctx.stroke();

        const fondu = Math.min(FONDU, trace.total / 3);

        particules.forEach(p => {
            p.distance += p.vitesse * dt;
            if (p.distance > trace.total) p.distance -= trace.total;

            const couleur = palette.couleurs[p.teinte % palette.couleurs.length];
            const attenuation = Math.min(1, p.distance / fondu, (trace.total - p.distance) / fondu);
            if (attenuation <= 0.01) return;
            const alpha = attenuation * palette.alpha;

            const tete = pointA(p.distance);
            const tx = tete.x - tete.ty * p.ecart;
            const ty = tete.y + tete.tx * p.ecart;

            // Comète : quelques segments qui suivent le tracé en s'effaçant.
            let precX = tx;
            let precY = ty;
            for (let s = 1; s <= SEGMENTS_QUEUE; s++) {
                const d = p.distance - (LONGUEUR_QUEUE * s) / SEGMENTS_QUEUE;
                if (d < 0) break;
                const q = pointA(d);
                const qx = q.x - q.ty * p.ecart;
                const qy = q.y + q.tx * p.ecart;

                const part = 1 - s / SEGMENTS_QUEUE;
                ctx.beginPath();
                ctx.moveTo(precX, precY);
                ctx.lineTo(qx, qy);
                ctx.lineWidth = p.taille * (0.35 + part * 0.75);
                ctx.strokeStyle = rgba(couleur, alpha * part * 0.55);
                ctx.stroke();

                precX = qx;
                precY = qy;
            }

            ctx.save();
            if (palette.lueur > 0) {
                ctx.shadowColor = rgba(couleur, alpha);
                ctx.shadowBlur = palette.lueur;
            }
            ctx.fillStyle = rgba(couleur, alpha);
            ctx.beginPath();
            ctx.arc(tx, ty, p.taille, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        });
    }

    function boucle(instant) {
        if (!actif) {
            idAnimation = null;
            return;
        }

        const dt = dernierInstant ? Math.min((instant - dernierInstant) / 1000, DT_MAX) : 0;
        dernierInstant = instant;

        if (recalculDemande) {
            recalculDemande = false;
            redimensionner();
            recalculerTrace();
        }

        dessiner(dt);
        idAnimation = requestAnimationFrame(boucle);
    }

    function demarrer() {
        if (!actif || idAnimation !== null || document.hidden) return;
        dernierInstant = 0;
        idAnimation = requestAnimationFrame(boucle);
    }

    function arreter() {
        if (idAnimation !== null) {
            cancelAnimationFrame(idAnimation);
            idAnimation = null;
        }
        if (ctx) ctx.clearRect(0, 0, largeurCSS, hauteurCSS);
    }

    /**
     * Marque le tracé comme à refaire.
     *
     * Le recalcul lui-même est reporté à la prochaine image : déplacer une carte
     * émet des dizaines de mutations par seconde, qui n'ont pas à déclencher
     * autant de Dijkstra. Quand l'animation est à l'arrêt (onglet caché), la
     * demande reste en attente et sera honorée à la reprise.
     */
    function demanderRecalcul() {
        recalculDemande = true;
    }

    // --- Canevas -------------------------------------------------------------

    function redimensionner() {
        if (!canvas || !grille) return;

        const rect = grille.getBoundingClientRect();
        const l = Math.max(0, Math.round(rect.width));
        const h = Math.max(0, Math.round(rect.height));
        const dpr = window.devicePixelRatio || 1;

        if (l === largeurCSS && h === hauteurCSS && canvas.width === Math.round(l * dpr)) return;

        largeurCSS = l;
        hauteurCSS = h;
        canvas.style.width = l + 'px';
        canvas.style.height = h + 'px';
        canvas.width = Math.round(l * dpr);
        canvas.height = Math.round(h * dpr);
        // Le contexte raisonne en pixels CSS ; l'échelle rend le tracé net sur
        // les écrans à forte densité.
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function creerCanevas() {
        // Le canevas se cale sur la grille : celle-ci doit lui servir de repère.
        if (getComputedStyle(grille).position === 'static') {
            grille.style.position = 'relative';
        }

        canvas = document.getElementById(ID_CANEVAS);
        if (!canvas) {
            canvas = document.createElement('canvas');
            canvas.id = ID_CANEVAS;
            canvas.style.position = 'absolute';
            canvas.style.top = '0';
            canvas.style.left = '0';
            canvas.style.pointerEvents = 'none';
            canvas.style.zIndex = '90';
            grille.appendChild(canvas);
        }
        ctx = canvas.getContext('2d');
    }

    // --- Cycle de vie --------------------------------------------------------

    function definirActif(valeur) {
        actif = !!valeur;
        localStorage.setItem('particlePathEnabled', actif);

        if (!canvas) return;
        if (actif) {
            canvas.style.display = 'block';
            redimensionner();
            recalculerTrace();
            demarrer();
        } else {
            arreter();
            canvas.style.display = 'none';
        }
    }

    function init() {
        if (initialise) return;
        grille = document.getElementById('dashboard-grid');
        if (!grille) return;

        creerCanevas();
        redimensionner();
        construirePalette();

        const selecteur = document.getElementById('add-target-select');
        if (selecteur) {
            cibleCourante = selecteur.value || 'queue';
            selecteur.addEventListener('change', () => {
                cibleCourante = selecteur.value || 'queue';
                demanderRecalcul();
            });
        }

        const interrupteur = document.getElementById('particle-path-enable-toggle');
        if (interrupteur) {
            interrupteur.checked = actif;
            interrupteur.addEventListener('change', e => definirActif(e.target.checked));
        }

        // Déplacement d'une carte : seules ses propriétés de grille changent,
        // sa taille peut rester identique — un ResizeObserver ne suffit pas.
        new MutationObserver(demanderRecalcul).observe(grille, {
            attributes: true,
            subtree: true,
            attributeFilter: ['style', 'class']
        });

        // Redimensionnement d'une carte, de la grille, ou contenu qui pousse une
        // carte à grandir.
        if (window.ResizeObserver) {
            const ro = new ResizeObserver(demanderRecalcul);
            ro.observe(grille);
            grille.querySelectorAll(':scope > .card').forEach(c => ro.observe(c));
        }
        window.addEventListener('resize', demanderRecalcul);

        // Changement de style ou de thème : la palette entière est refaite.
        new MutationObserver(construirePalette).observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['data-style', 'data-theme']
        });

        document.addEventListener('visibilitychange', () => {
            if (document.hidden) arreter();
            else if (actif) { demanderRecalcul(); demarrer(); }
        });

        if (actif) {
            recalculerTrace();
            demarrer();
        } else {
            canvas.style.display = 'none';
        }

        initialise = true;
    }

    window.MusicPlayer.ParticlePath = {
        init,
        recalculatePath: demanderRecalcul,
        setTarget: function (cle) {
            cibleCourante = cle;
            demanderRecalcul();
        },
        setEnabled: definirActif,
        isEnabled: function () { return actif; }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
