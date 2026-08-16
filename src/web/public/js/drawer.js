/* ═══════════════════════════════════════════════════════════════
   Right-Side Drawer & Bot Activity Memory Graph Controller
   ═══════════════════════════════════════════════════════════════ */

(function() {
    let drawerPanel = null;
    let drawerBackdrop = null;

    // Network Bandwidth Counters
    let totalBytesReceived = 0;

    /** Traduction avec repli sur la valeur française d'origine. */
    function tr(cle, defaut) {
        const t = window.MusicPlayer && window.MusicPlayer.t;
        const valeur = typeof t === 'function' ? t(cle) : null;
        return (valeur && valeur !== cle) ? valeur : defaut;
    }

    /**
     * Symboles d'unités de taille. Ils diffèrent selon la langue : « Mo » en
     * français, « MB » en anglais, allemand et espagnol.
     */
    function unites() {
        return {
            octet: tr('unit_bytes', 'octets'),
            ko: tr('unit_kb', 'Ko'),
            mo: tr('unit_mb', 'Mo'),
            go: tr('unit_gb', 'Go'),
        };
    }

    // Dynamic auto-scaling unit formatter (octets, Ko, Mo, Go)
    function formatBytes(bytes) {
        const u = unites();
        if (!bytes || bytes <= 0) return { val: '0.00', unit: u.ko, raw: `0 ${u.octet}` };
        if (bytes < 1024) {
            return { val: bytes.toString(), unit: u.octet, raw: `${bytes} ${u.octet}` };
        }
        if (bytes < 1024 * 1024) {
            return { val: (bytes / 1024).toFixed(2), unit: u.ko, raw: `${bytes.toLocaleString()} ${u.octet}` };
        }
        if (bytes < 1024 * 1024 * 1024) {
            return { val: (bytes / (1024 * 1024)).toFixed(2), unit: u.mo, raw: `${(bytes / 1024).toFixed(1)} ${u.ko}` };
        }
        return { val: (bytes / (1024 * 1024 * 1024)).toFixed(2), unit: u.go, raw: `${(bytes / (1024 * 1024)).toFixed(1)} ${u.mo}` };
    }

    function updateBandwidthUI() {
        const formatted = formatBytes(totalBytesReceived);
        const elVal = document.getElementById('bw-main-val');
        const elUnit = document.getElementById('bw-unit-badge');
        const elDetail = document.getElementById('bw-sub-detail');

        if (elVal) elVal.textContent = formatted.val;
        if (elUnit) elUnit.textContent = formatted.unit;
        if (elDetail) elDetail.textContent = `${tr('drawer_total_label', 'Total')} : ${formatted.raw}`;
    }

    // Expose network tracking globally
    window.MusicPlayer = window.MusicPlayer || {};
    window.MusicPlayer.trackNetworkBytes = function(bytes) {
        if (typeof bytes === 'number' && bytes > 0) {
            totalBytesReceived += bytes;
            updateBandwidthUI();
        }
    };

    // Track original fetch and WebSocket incoming bytes
    (function interceptNetwork() {
        const origFetch = window.fetch;
        if (origFetch) {
            window.fetch = async function(...args) {
                const response = await origFetch.apply(this, args);
                try {
                    const clone = response.clone();
                    const reader = clone.body ? clone.body.getReader() : null;
                    if (reader) {
                        (async () => {
                            while (true) {
                                const { done, value } = await reader.read();
                                if (done) break;
                                if (value && value.byteLength) {
                                    window.MusicPlayer.trackNetworkBytes(value.byteLength);
                                }
                            }
                        })().catch(() => {});
                    }
                } catch (e) {}
                return response;
            };
        }
    })();

    /* ═══════════════════════════════════════════════════════════════
       Graphique mémoire — fenêtre temporelle réelle
       ───────────────────────────────────────────────────────────────
       L'axe X porte du temps, pas un rang d'échantillon. Le curseur de
       durée définit donc littéralement la largeur de la fenêtre visible :
       l'élargir dévoile davantage de passé au lieu d'étirer la même
       poignée de points.

       Deux sources se relaient :
         • `echantillonsLents` — la mesure embarquée dans `progress`, une par
           seconde, reçue même tiroir fermé : c'est l'historique long.
         • `echantillonsFins`  — le flux haute cadence, demandé au serveur à
           l'ouverture du tiroir et coupé à sa fermeture : c'est le détail.
       Le tracé consomme le flux fin là où il existe, l'historique au-delà.

       Trois étages :
         1. les mesures brutes ci-dessus, à leur cadence d'origine.
         2. `paquets` — agrégats par pas de temps, alignés sur une grille
            temporelle absolue : un point ne change donc pas de paquet au fil
            du défilement, et ne tressaute pas. Le pas vise un point de courbe
            tous les quelques pixels — la finesse que l'écran peut rendre.
         3. le rendu — abscisse déduite de l'horodatage réel, d'où un
            défilement continu à 60 ips sans compteur artificiel.
    ═══════════════════════════════════════════════════════════════ */

    const MO = 1024 * 1024;
    const DUREE_MIN_SEC = 10;
    const DUREE_MAX_SEC = 3600;
    /** Cadence réclamée au serveur pour le flux fin, tiroir ouvert. */
    const CADENCE_FINE_HZ = 60;
    /** Profondeur gardée à cadence fine ; au-delà l'historique 1 Hz prend le relais. */
    const FENETRE_FINE_SEC = 120;
    /** Marge de conservation au-delà de la plus large fenêtre possible. */
    const MARGE_TAMPON_MS = 60 * 1000;
    /** Pas d'agrégation plancher : inutile de descendre sous la trame d'affichage. */
    const PAS_MIN_MS = Math.floor(1000 / CADENCE_FINE_HZ);
    /** Un point de courbe tous les N pixels. */
    const PX_PAR_POINT = 3;
    const POINTS_MIN = 8;
    const POINTS_MAX = 400;
    // La marge droite loge la moitié du dernier libellé de temps (HH:MM:SS)
    // ainsi que la tête du tracé, qui vit exactement sur le bord.
    const MARGE = { haut: 22, bas: 28, gauche: 64, droite: 26 };
    const NIVEAUX_Y = 3;   // nombre d'intervalles → 4 graduations
    const ECHELLES_TEMPS_SEC = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];

    /** Mesures 1 Hz de `progress` : { t, rss, heapUsed, heapTotal }. */
    const echantillonsLents = [];
    /** Mesures du flux haute cadence, même forme. */
    const echantillonsFins = [];
    /** Horodatage de la dernière mesure agrégée, tous flux confondus. */
    let dernierTIntegre = 0;
    let dernierFinRecuMs = 0;
    let derniereDemandeFluxMs = 0;

    /** Agrégats affichés, ordre chronologique. */
    let paquets = [];
    let pasPaquetMs = PAS_MIN_MS;

    let dureeFenetreSec = 30;
    let maxAfficheMo = 100;
    let derniereLargeurGraphe = 0;

    let animFrameId = null;
    let derniereFrameMs = 0;

    // Interactive Hover & Tooltip State
    let hoverX = -1;
    let isHoveringGraph = false;

    /**
     * Facteur d'interpolation corrigé du temps écoulé : un lissage réglé
     * pour 60 ips ne doit pas ralentir quand la fenêtre rame.
     */
    function facteurLissage(dtSec, k60) {
        const frames = Math.max(0.1, Math.min(6, dtSec * 60));
        return 1 - Math.pow(1 - k60, frames);
    }

    // ── Étage 1 : échantillons bruts ────────────────────────────────

    /**
     * Range une mesure dans son tampon. L'élagage se fait par lots : décaler
     * le tableau à chaque mesure coûterait plus cher, à 60 Hz, que de laisser
     * vivre quelques éléments hors fenêtre — ils sont filtrés au tracé.
     */
    function ajouterMesure(tampon, profondeurMs, rss, heapUsed, heapTotal, horodatage) {
        const t = Number(horodatage) || Date.now();
        const dernier = tampon[tampon.length - 1];
        // Un horodatage qui n'avance pas ne doit pas créer de point.
        if (dernier && t <= dernier.t) return;

        tampon.push({
            t,
            rss: Math.max(0, rss || 0),
            heapUsed: Math.max(0, heapUsed || 0),
            heapTotal: Math.max(0, heapTotal || 0)
        });

        const limite = t - profondeurMs;
        let obsoletes = 0;
        while (obsoletes < tampon.length && tampon[obsoletes].t < limite) obsoletes++;
        if (obsoletes > 64) tampon.splice(0, obsoletes);

        // Les deux flux se recouvrent : n'agréger que ce qui fait avancer le
        // temps, pour ne pas compter deux fois le même instant.
        if (t > dernierTIntegre) {
            dernierTIntegre = t;
            integrerAuxPaquets(tampon[tampon.length - 1]);
        }
    }

    /**
     * Mesures à tracer depuis `depuis` : cadence fine là où elle existe,
     * historique 1 Hz au-delà. Le graphique garde ainsi son passé même quand
     * le flux rapide vient tout juste de démarrer.
     */
    function fluxFusionne(depuis) {
        const bascule = echantillonsFins.length > 0 ? echantillonsFins[0].t : Infinity;
        const sortie = [];
        for (const m of echantillonsLents) {
            if (m.t >= depuis && m.t < bascule) sortie.push(m);
        }
        for (const m of echantillonsFins) {
            if (m.t >= depuis) sortie.push(m);
        }
        return sortie;
    }

    // ── Étage 2 : agrégation par pas de temps ───────────────────────

    /** Points de courbe tenables : la finesse que la largeur permet de rendre. */
    function nombrePoints(largeurGraphe) {
        return Math.max(POINTS_MIN, Math.min(POINTS_MAX, Math.floor(largeurGraphe / PX_PAR_POINT)));
    }

    function calculerPas(largeurGraphe) {
        const brut = (dureeFenetreSec * 1000) / nombrePoints(largeurGraphe);
        return Math.max(PAS_MIN_MS, Math.ceil(brut));
    }

    function creerPaquet(debut, mesure) {
        return {
            debut,
            fin: debut + pasPaquetMs,
            tPremier: mesure.t,
            tDernier: mesure.t,
            sommeRss: mesure.rss,
            sommeHeap: mesure.heapUsed,
            sommeHeapTotal: mesure.heapTotal,
            nb: 1,
            // Valeurs affichées, rattrapées par interpolation à chaque image.
            dRss: mesure.rss,
            dHeap: mesure.heapUsed,
            dHeapTotal: mesure.heapTotal
        };
    }

    function cumuler(paquet, mesure) {
        paquet.sommeRss += mesure.rss;
        paquet.sommeHeap += mesure.heapUsed;
        paquet.sommeHeapTotal += mesure.heapTotal;
        paquet.nb++;
        paquet.tDernier = mesure.t;
    }

    function integrerAuxPaquets(mesure) {
        const debut = Math.floor(mesure.t / pasPaquetMs) * pasPaquetMs;
        const dernier = paquets[paquets.length - 1];
        if (dernier && dernier.debut === debut) {
            cumuler(dernier, mesure);
        } else {
            paquets.push(creerPaquet(debut, mesure));
        }
        elaguerPaquets();
    }

    /**
     * Recalcule tous les paquets depuis les mesures brutes. Appelé quand le
     * pas change (curseur de durée, redimensionnement), donc jamais à chaque
     * image : le rendu ne fait ensuite que lire ces agrégats.
     */
    function reconstruirePaquets(largeurGraphe) {
        pasPaquetMs = calculerPas(largeurGraphe);
        paquets = [];

        // Inutile de reconstruire ce qui est déjà sorti par la gauche.
        const depuis = Date.now() - dureeFenetreSec * 1000 - 2 * pasPaquetMs;

        let courant = null;
        for (const mesure of fluxFusionne(depuis)) {
            const debut = Math.floor(mesure.t / pasPaquetMs) * pasPaquetMs;
            if (courant && courant.debut === debut) {
                cumuler(courant, mesure);
            } else {
                courant = creerPaquet(debut, mesure);
                paquets.push(courant);
            }
        }
        elaguerPaquets();
    }

    function elaguerPaquets() {
        // Deux paquets de battement au-delà du bord gauche : le tracé doit
        // entrer dans le cadre plutôt que d'y commencer net.
        const limite = Date.now() - dureeFenetreSec * 1000 - 2 * pasPaquetMs;
        while (paquets.length > 0 && paquets[0].fin < limite) {
            paquets.shift();
        }
    }

    function lisserValeurs(dtSec) {
        const k = facteurLissage(dtSec, 0.15);
        for (const p of paquets) {
            p.dRss += (p.sommeRss / p.nb - p.dRss) * k;
            p.dHeap += (p.sommeHeap / p.nb - p.dHeap) * k;
            p.dHeapTotal += (p.sommeHeapTotal / p.nb - p.dHeapTotal) * k;
        }
    }

    // ── Étage 3 : rendu ─────────────────────────────────────────────

    // Auto-scale byte units into o, Ko, Mo, or Go
    function formatBytesWithUnit(bytes) {
        const val = Math.max(0, bytes || 0);
        const u = unites();
        if (val >= 1024 * 1024 * 1024) {
            return `${(val / (1024 * 1024 * 1024)).toFixed(1)} ${u.go}`;
        }
        if (val >= 1024 * 1024) {
            return `${Math.round(val / (1024 * 1024))} ${u.mo}`;
        }
        if (val >= 1024) {
            return `${Math.round(val / 1024)} ${u.ko}`;
        }
        return `${Math.round(val)} o`;
    }

    /** Arrondit le sommet de l'axe Y à une valeur « ronde » lisible. */
    function maxJoli(valeurMo) {
        const base = Math.max(50, valeurMo);
        const ordre = Math.pow(10, Math.floor(Math.log10(base)));
        for (const m of [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8]) {
            if (base <= m * ordre) return m * ordre;
        }
        return 10 * ordre;
    }

    function heureCourte(ms, avecSecondes) {
        const d = new Date(ms);
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        if (!avecSecondes) return `${hh}:${mm}`;
        return `${hh}:${mm}:${String(d.getSeconds()).padStart(2, '0')}`;
    }

    /** Intervalle des graduations de temps, choisi pour ne pas les tasser. */
    function pasTempsSec(largeurGraphe) {
        const maxGraduations = Math.max(2, Math.floor(largeurGraphe / 64));
        for (const pas of ECHELLES_TEMPS_SEC) {
            if (dureeFenetreSec / pas <= maxGraduations) return pas;
        }
        return DUREE_MAX_SEC;
    }

    /** Récupère (en le créant au besoin) le n-ième enfant d'un conteneur. */
    function elementPool(parent, index, creer) {
        let el = parent.children[index];
        if (!el) {
            el = creer();
            parent.appendChild(el);
        }
        el.style.display = '';
        return el;
    }

    function masquerSurplus(parent, aPartirDe) {
        for (let i = aPartirDe; i < parent.children.length; i++) {
            parent.children[i].style.display = 'none';
        }
    }

    function creerLigneSvg() {
        return document.createElementNS('http://www.w3.org/2000/svg', 'line');
    }

    // Build SVG spline paths
    function buildSvgPath(pts) {
        if (pts.length < 2) return '';
        let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
        for (let i = 0; i < pts.length - 1; i++) {
            const xc = ((pts[i].x + pts[i + 1].x) / 2).toFixed(1);
            const yc = ((pts[i].y + pts[i + 1].y) / 2).toFixed(1);
            d += ` Q ${pts[i].x.toFixed(1)} ${pts[i].y.toFixed(1)}, ${xc} ${yc}`;
        }
        d += ` L ${pts[pts.length - 1].x.toFixed(1)} ${pts[pts.length - 1].y.toFixed(1)}`;
        return d;
    }

    function buildSvgArea(pts, basY) {
        if (pts.length < 2) return '';
        const lineD = buildSvgPath(pts);
        const dernier = pts[pts.length - 1];
        const premier = pts[0];
        return `${lineD} L ${dernier.x.toFixed(1)} ${basY.toFixed(1)} L ${premier.x.toFixed(1)} ${basY.toFixed(1)} Z`;
    }

    function renderGraph(dtSec) {
        const container = document.getElementById('memory-graph-container');
        if (!container) return;

        const rect = container.getBoundingClientRect();
        const width = rect.width || 340;
        const height = rect.height || 170;
        const graphW = Math.max(20, width - MARGE.gauche - MARGE.droite);
        const graphH = Math.max(20, height - MARGE.haut - MARGE.bas);
        const basY = MARGE.haut + graphH;

        // La densité de nœuds dépend de la largeur : un tiroir redimensionné
        // change le pas d'agrégation, donc les paquets.
        if (Math.abs(graphW - derniereLargeurGraphe) > 1) {
            derniereLargeurGraphe = graphW;
            reconstruirePaquets(graphW);
        }

        const maintenant = Date.now();
        const fenetreMs = dureeFenetreSec * 1000;
        const tGauche = maintenant - fenetreMs;
        const xDe = (t) => MARGE.gauche + ((t - tGauche) / fenetreMs) * graphW;

        elaguerPaquets();
        lisserValeurs(dtSec);

        // Paquets visibles, plus le dernier sorti par la gauche pour que la
        // courbe traverse le bord au lieu d'y naître.
        const visibles = [];
        for (let i = 0; i < paquets.length; i++) {
            if (paquets[i].tDernier >= tGauche) {
                if (visibles.length === 0 && i > 0) visibles.push(paquets[i - 1]);
                visibles.push(paquets[i]);
            }
        }

        // Échelle verticale : sommet arrondi, rejoint en douceur.
        let sommetMo = 0;
        for (const p of visibles) {
            const rssMo = p.dRss / MO;
            const heapMo = p.dHeap / MO;
            if (rssMo > sommetMo) sommetMo = rssMo;
            if (heapMo > sommetMo) sommetMo = heapMo;
        }
        const cibleMo = maxJoli(sommetMo * 1.15);
        maxAfficheMo += (cibleMo - maxAfficheMo) * facteurLissage(dtSec, 0.12);
        const maxOctets = Math.max(1, maxAfficheMo) * MO;
        const yDe = (octets) => basY - Math.min(1.2, (octets || 0) / maxOctets) * graphH;

        // Graduations verticales (valeurs) — libellés alignés au pixel près
        // sur les lignes de la grille.
        const yAxis = document.getElementById('y-axis-labels');
        if (yAxis) {
            for (let i = 0; i <= NIVEAUX_Y; i++) {
                const fraction = i / NIVEAUX_Y;
                const lbl = elementPool(yAxis, i, () => {
                    const span = document.createElement('span');
                    span.className = 'y-axis-label';
                    return span;
                });
                lbl.textContent = formatBytesWithUnit(maxOctets * fraction);
                lbl.style.top = `${(basY - fraction * graphH).toFixed(1)}px`;
            }
            masquerSurplus(yAxis, NIVEAUX_Y + 1);
        }

        // Grille : horizontales sur les graduations, verticales sur des
        // instants ronds — c'est ce qui rend la fenêtre du curseur lisible.
        const grille = document.getElementById('svg-grid-group');
        const xAxis = document.getElementById('x-axis-labels');
        let iLigne = 0;
        if (grille) {
            for (let i = 0; i <= NIVEAUX_Y; i++) {
                const y = (basY - (i / NIVEAUX_Y) * graphH).toFixed(1);
                const ligne = elementPool(grille, iLigne++, creerLigneSvg);
                ligne.setAttribute('class', 'graph-grid-line');
                ligne.setAttribute('x1', MARGE.gauche);
                ligne.setAttribute('y1', y);
                ligne.setAttribute('x2', (MARGE.gauche + graphW).toFixed(1));
                ligne.setAttribute('y2', y);
            }
        }

        const pasTemps = pasTempsSec(graphW) * 1000;
        const avecSecondes = pasTemps < 60000;
        let iLabelX = 0;
        for (let t = Math.ceil(tGauche / pasTemps) * pasTemps; t <= maintenant; t += pasTemps) {
            const x = xDe(t);
            if (x < MARGE.gauche - 1 || x > MARGE.gauche + graphW + 1) continue;

            if (grille) {
                const ligne = elementPool(grille, iLigne++, creerLigneSvg);
                ligne.setAttribute('class', 'graph-grid-line vertical');
                ligne.setAttribute('x1', x.toFixed(1));
                ligne.setAttribute('y1', MARGE.haut);
                ligne.setAttribute('x2', x.toFixed(1));
                ligne.setAttribute('y2', basY);
            }
            if (xAxis) {
                const lbl = elementPool(xAxis, iLabelX++, () => {
                    const span = document.createElement('span');
                    span.className = 'x-axis-label';
                    return span;
                });
                lbl.textContent = heureCourte(t, avecSecondes);
                lbl.style.left = `${x.toFixed(1)}px`;
                lbl.style.top = `${(basY + 8).toFixed(1)}px`;
            }
        }
        if (grille) masquerSurplus(grille, iLigne);
        if (xAxis) masquerSurplus(xAxis, iLabelX);

        // Zone de tracé : la courbe ne doit pas déborder sous les libellés.
        const clip = document.getElementById('graph-clip-rect');
        if (clip) {
            clip.setAttribute('x', MARGE.gauche);
            clip.setAttribute('y', MARGE.haut - 6);
            clip.setAttribute('width', graphW.toFixed(1));
            clip.setAttribute('height', (graphH + 6).toFixed(1));
        }

        const ptsRss = visibles.map(p => ({ x: xDe(p.tDernier), y: yDe(p.dRss) }));
        const ptsHeap = visibles.map(p => ({ x: xDe(p.tDernier), y: yDe(p.dHeap) }));

        const svgRssLine = document.getElementById('svg-rss-line');
        const svgHeapLine = document.getElementById('svg-heap-line');
        const svgRssArea = document.getElementById('svg-rss-area');
        const svgHeapArea = document.getElementById('svg-heap-area');

        if (svgRssLine) svgRssLine.setAttribute('d', buildSvgPath(ptsRss));
        if (svgHeapLine) svgHeapLine.setAttribute('d', buildSvgPath(ptsHeap));
        if (svgRssArea) svgRssArea.setAttribute('d', buildSvgArea(ptsRss, basY));
        if (svgHeapArea) svgHeapArea.setAttribute('d', buildSvgArea(ptsHeap, basY));

        // Survol : le paquet dont l'abscisse est la plus proche du curseur.
        let survole = -1;
        if (isHoveringGraph && hoverX >= MARGE.gauche - 12 && hoverX <= MARGE.gauche + graphW + 12) {
            let ecartMin = Infinity;
            ptsRss.forEach((pt, i) => {
                const ecart = Math.abs(pt.x - hoverX);
                if (ecart < ecartMin) {
                    ecartMin = ecart;
                    survole = i;
                }
            });
        }

        // Repères : un seul point par série, sous le curseur. La courbe compte
        // un point tous les quelques pixels ; les matérialiser tous couvrirait
        // le tracé de pastilles. Hors survol, le graphique reste nu.
        const nodesLayer = document.getElementById('graph-nodes-layer');
        if (nodesLayer) {
            if (survole >= 0) {
                [[ptsRss[survole], 'rss'], [ptsHeap[survole], 'heap']].forEach(([pt, serie], j) => {
                    const node = elementPool(nodesLayer, j, () => document.createElement('div'));
                    node.className = `dom-graph-node ${serie} active`;
                    node.style.left = `${pt.x.toFixed(1)}px`;
                    node.style.top = `${pt.y.toFixed(1)}px`;
                    node.style.opacity = '1';
                });
            }
            masquerSurplus(nodesLayer, survole >= 0 ? 2 : 0);
        }

        // Réticule et infobulle
        const tooltip = document.getElementById('graph-tooltip');
        const crosshair = document.getElementById('svg-crosshair');

        if (survole >= 0) {
            const paquet = visibles[survole];
            const hx = ptsRss[survole].x;

            if (crosshair) {
                crosshair.setAttribute('x1', hx.toFixed(1));
                crosshair.setAttribute('y1', MARGE.haut);
                crosshair.setAttribute('x2', hx.toFixed(1));
                crosshair.setAttribute('y2', basY);
                crosshair.style.opacity = '1';
            }

            if (tooltip) {
                tooltip.classList.remove('hidden');

                // Les valeurs affichées sont les mesures réelles du paquet,
                // pas leur version lissée pour l'animation.
                const rssMo = (paquet.sommeRss / paquet.nb) / MO;
                const heapMo = (paquet.sommeHeap / paquet.nb) / MO;
                const heapTotalMo = (paquet.sommeHeapTotal / paquet.nb) / MO;

                const elTime = document.getElementById('gt-time');
                const elRss = document.getElementById('gt-rss');
                const elHeap = document.getElementById('gt-heap');

                // Un paquet qui condense plus d'une seconde de mesures affiche
                // sa plage : la moyenne annoncée reste ainsi interprétable.
                if (elTime) {
                    elTime.textContent = (paquet.tDernier - paquet.tPremier) >= 1000
                        ? `${heureCourte(paquet.tPremier, true)} → ${heureCourte(paquet.tDernier, true)}`
                        : heureCourte(paquet.tDernier, true);
                }
                const uniteMo = unites().mo;
                if (elRss) elRss.textContent = `${rssMo.toFixed(1)} ${uniteMo}`;
                if (elHeap) elHeap.textContent = `${heapMo.toFixed(1)} / ${heapTotalMo.toFixed(1)} ${uniteMo}`;

                const tooltipW = tooltip.offsetWidth || 140;
                const tooltipH = tooltip.offsetHeight || 75;

                let posX = hx - tooltipW / 2;
                let posY = Math.min(ptsRss[survole].y, ptsHeap[survole].y) - tooltipH - 12;
                if (posY < 5) posY = Math.max(ptsRss[survole].y, ptsHeap[survole].y) + 12;
                posX = Math.max(8, Math.min(width - tooltipW - 8, posX));

                tooltip.style.left = `${posX}px`;
                tooltip.style.top = `${posY}px`;
            }
        } else {
            if (crosshair) crosshair.style.opacity = '0';
            if (tooltip) tooltip.classList.add('hidden');
        }
    }

    function boucleAnimation(horodatage) {
        const maintenant = typeof horodatage === 'number' ? horodatage : performance.now();
        const dtSec = derniereFrameMs > 0 ? (maintenant - derniereFrameMs) / 1000 : 1 / 60;
        derniereFrameMs = maintenant;

        renderGraph(Math.min(0.5, Math.max(0.001, dtSec)));

        if (drawerPanel && drawerPanel.classList.contains('open')) {
            animFrameId = requestAnimationFrame(boucleAnimation);
        } else {
            animFrameId = null;
            derniereFrameMs = 0;
        }
    }

    function startAnimationLoop() {
        if (!animFrameId) {
            derniereFrameMs = 0;
            boucleAnimation();
        }
    }

    function stopAnimationLoop() {
        if (animFrameId) {
            cancelAnimationFrame(animFrameId);
            animFrameId = null;
            derniereFrameMs = 0;
        }
    }

    /** Le graphique ne se redessine que s'il est à l'écran. */
    function estOuvert() {
        return !!(drawerPanel && drawerPanel.classList.contains('open'));
    }

    /**
     * (Dés)abonnement au flux mémoire haute cadence. Il coûte au serveur un
     * minuteur et quelques kilo-octets par seconde : on ne le demande que
     * pendant que le graphique est visible.
     */
    function demanderFluxMemoire(actif) {
        if (typeof window.MusicPlayer.sendWS !== 'function') return;
        window.MusicPlayer.sendWS({
            type: 'memoryStream',
            data: { enabled: !!actif, hz: CADENCE_FINE_HZ }
        });
        derniereDemandeFluxMs = Date.now();
    }

    /**
     * Empreinte des tampons de mesures, pour le widget de répartition.
     * Chaque mesure est un petit objet de quatre nombres ; chaque agrégat en
     * porte une douzaine de champs.
     */
    window.MusicPlayer.empreinteGraphique = function() {
        const mesures = echantillonsLents.length + echantillonsFins.length;
        return {
            mesures,
            paquets: paquets.length,
            octets: mesures * (4 * 8 + 40) + paquets.length * (12 * 8 + 40)
        };
    };

    /**
     * Lots d'échantillons du flux haute cadence : [t, rss, heapUsed, heapTotal].
     */
    window.MusicPlayer.onMemorySamples = function(data) {
        if (!data || !Array.isArray(data.samples)) return;
        for (const s of data.samples) {
            if (!Array.isArray(s) || s.length < 4) continue;
            ajouterMesure(echantillonsFins, FENETRE_FINE_SEC * 1000, s[1], s[2], s[3], s[0]);
        }
        dernierFinRecuMs = Date.now();
    };

    // Drawer Open / Close Controls
    function openDrawer() {
        if (drawerPanel && drawerBackdrop) {
            drawerPanel.classList.add('open');
            drawerBackdrop.classList.add('active');
            document.body.classList.add('drawer-is-open');
            localStorage.setItem('music_player_drawer_open', 'true');
            const savedBlur = localStorage.getItem('music_player_drawer_blur') ?? '4';
            applyDrawerBlur(savedBlur);
            demanderFluxMemoire(true);
            startAnimationLoop();
            if (typeof window.MusicPlayer.setRepartitionActive === 'function') {
                window.MusicPlayer.setRepartitionActive(true);
            }
        }
    }

    function closeDrawer() {
        if (drawerPanel && drawerBackdrop) {
            drawerPanel.classList.remove('open');
            drawerBackdrop.classList.remove('active');
            document.body.classList.remove('drawer-is-open');
            localStorage.setItem('music_player_drawer_open', 'false');
            demanderFluxMemoire(false);
            stopAnimationLoop();
            if (typeof window.MusicPlayer.setRepartitionActive === 'function') {
                window.MusicPlayer.setRepartitionActive(false);
            }
        }
    }

    function toggleDrawer() {
        if (drawerPanel && drawerPanel.classList.contains('open')) {
            closeDrawer();
        } else {
            openDrawer();
        }
    }

    // Format Uptime
    function formatUptime(seconds) {
        if (!seconds || seconds <= 0) return '0s';
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = seconds % 60;
        if (h > 0) return `${h}h ${m}m ${s}s`;
        if (m > 0) return `${m}m ${s}s`;
        return `${s}s`;
    }

    // Handle WebSocket bot state metrics update
    function handleBotStatsUpdate(state) {
        if (!state || !state.botStats) return;

        const stats = state.botStats;
        if (stats.memory) {
            // L'historique se remplit même tiroir fermé : à l'ouverture, le
            // graphique montre le passé réel plutôt qu'une courbe vide.
            ajouterMesure(
                echantillonsLents,
                DUREE_MAX_SEC * 1000 + MARGE_TAMPON_MS,
                stats.memory.rss,
                stats.memory.heapUsed,
                stats.memory.heapTotal,
                stats.timestamp
            );

            // Le flux rapide vit côté serveur, attaché à la connexion : une
            // reconnexion (ou un redémarrage du bot) le perd sans prévenir.
            // Ce message-ci arrive chaque seconde et sert de battement : si le
            // flux se tait alors que le tiroir est ouvert, on le redemande.
            const maintenant = Date.now();
            if (estOuvert()
                && maintenant - dernierFinRecuMs > 2000
                && maintenant - derniereDemandeFluxMs > 2000) {
                demanderFluxMemoire(true);
            }

            // Update UI metric text labels
            const rssMB = (stats.memory.rss / MO).toFixed(1);
            const heapUsedMB = (stats.memory.heapUsed / MO).toFixed(1);
            const heapTotalMB = (stats.memory.heapTotal / MO).toFixed(1);

            const elRss = document.getElementById('bot-mem-rss');
            const elHeap = document.getElementById('bot-mem-heap');
            const elUptime = document.getElementById('bot-uptime');

            const mo = unites().mo;
            if (elRss) elRss.textContent = `${rssMB} ${mo}`;
            if (elHeap) elHeap.textContent = `${heapUsedMB} / ${heapTotalMB} ${mo}`;
            if (elUptime) elUptime.textContent = formatUptime(stats.uptime);

            // Dernières valeurs connues, pour pouvoir réafficher au changement de langue
            derniersStats = stats;
        }
    }

    /** Dernier instantané reçu, réutilisé lors d'un changement de langue. */
    let derniersStats = null;

    /**
     * Réapplique la langue aux libellés que le tiroir construit lui-même :
     * les attributs data-i18n ne les atteignent pas.
     */
    window.MusicPlayer.refreshDrawerLabels = function() {
        updateBandwidthUI();
        if (derniersStats && derniersStats.memory) {
            const stats = derniersStats;
            const mo = unites().mo;
            const elRss = document.getElementById('bot-mem-rss');
            const elHeap = document.getElementById('bot-mem-heap');
            const elUptime = document.getElementById('bot-uptime');
            if (elRss) elRss.textContent = `${(stats.memory.rss / MO).toFixed(1)} ${mo}`;
            if (elHeap) {
                elHeap.textContent = `${(stats.memory.heapUsed / MO).toFixed(1)} / ${(stats.memory.heapTotal / MO).toFixed(1)} ${mo}`;
            }
            if (elUptime) elUptime.textContent = formatUptime(stats.uptime);
        }
        if (estOuvert()) renderGraph(1 / 60);
    };

    function applyDrawerBlur(val) {
        if (!drawerBackdrop) return;
        const blurPx = parseInt(val, 10);
        const filterVal = blurPx > 0 ? `blur(${blurPx}px)` : 'none';
        drawerBackdrop.style.backdropFilter = filterVal;
        drawerBackdrop.style.webkitBackdropFilter = filterVal;

        const valSpan = document.getElementById('val-drawer-blur-range');
        if (valSpan) valSpan.textContent = `${blurPx}px`;
    }

    function formatDurationHHMMSS(totalSeconds) {
        const sec = Math.max(0, Math.floor(totalSeconds));
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = sec % 60;
        const hh = String(h).padStart(2, '0');
        const mm = String(m).padStart(2, '0');
        const ss = String(s).padStart(2, '0');
        return `${hh}:${mm}:${ss}`;
    }

    /**
     * Applique la durée choisie : c'est la largeur réelle de la fenêtre
     * affichée. Les paquets sont refaits depuis les mesures brutes, si bien
     * qu'élargir la fenêtre fait apparaître du passé déjà enregistré.
     */
    function applyGraphDuration(val) {
        const demande = parseInt(val, 10);
        dureeFenetreSec = Math.max(DUREE_MIN_SEC, Math.min(DUREE_MAX_SEC, isNaN(demande) ? 30 : demande));

        const valSpan = document.getElementById('val-graph-duration');
        if (valSpan) valSpan.textContent = formatDurationHHMMSS(dureeFenetreSec);

        const container = document.getElementById('memory-graph-container');
        const largeur = container
            ? Math.max(20, container.getBoundingClientRect().width - MARGE.gauche - MARGE.droite)
            : derniereLargeurGraphe || 240;
        derniereLargeurGraphe = largeur;
        reconstruirePaquets(largeur);

        if (estOuvert()) renderGraph(1 / 60);
    }

    // Initialize Drawer Elements and Event Listeners
    function initDrawer() {
        drawerPanel = document.getElementById('drawer-panel');
        drawerBackdrop = document.getElementById('drawer-backdrop');

        const graphContainer = document.getElementById('memory-graph-container');
        if (graphContainer) {
            const pointerSuivi = (clientX) => {
                const rect = graphContainer.getBoundingClientRect();
                hoverX = clientX - rect.left;
                isHoveringGraph = true;
            };
            const pointerFin = () => {
                isHoveringGraph = false;
                hoverX = -1;
                const tooltip = document.getElementById('graph-tooltip');
                if (tooltip) tooltip.classList.add('hidden');
                const crosshair = document.getElementById('svg-crosshair');
                if (crosshair) crosshair.style.opacity = '0';
                const nodesLayer = document.getElementById('graph-nodes-layer');
                if (nodesLayer) {
                    nodesLayer.querySelectorAll('.dom-graph-node.active').forEach(n => n.classList.remove('active'));
                }
            };

            graphContainer.addEventListener('mousemove', (e) => pointerSuivi(e.clientX));
            graphContainer.addEventListener('mouseleave', pointerFin);
            graphContainer.addEventListener('touchstart', (e) => {
                if (e.touches.length > 0) pointerSuivi(e.touches[0].clientX);
            }, { passive: true });
            graphContainer.addEventListener('touchmove', (e) => {
                if (e.touches.length > 0) pointerSuivi(e.touches[0].clientX);
            }, { passive: true });
            graphContainer.addEventListener('touchend', pointerFin);
            graphContainer.addEventListener('touchcancel', pointerFin);
        }

        const edgeTab = document.getElementById('drawer-edge-tab');
        if (edgeTab) {
            edgeTab.addEventListener('mouseenter', () => {
                openDrawer();
            });
            edgeTab.addEventListener('click', () => {
                openDrawer();
            });
        }

        // Top-Right Screen Corner Mouse Proximity Activation
        document.addEventListener('mousemove', (e) => {
            if (!drawerPanel || drawerPanel.classList.contains('open')) return;
            if (e.clientX >= window.innerWidth - 12 && e.clientY >= 30 && e.clientY <= 180) {
                openDrawer();
            }
        });

        const btnClose = document.getElementById('drawer-close-btn');

        if (btnClose) {
            btnClose.addEventListener('click', closeDrawer);
        }

        if (drawerBackdrop) {
            drawerBackdrop.addEventListener('click', closeDrawer);
        }

        const blurRange = document.getElementById('drawer-blur-range');
        const savedBlur = localStorage.getItem('music_player_drawer_blur') ?? '4';
        if (blurRange) {
            blurRange.value = savedBlur;
            applyDrawerBlur(savedBlur);

            blurRange.addEventListener('input', () => {
                applyDrawerBlur(blurRange.value);
                localStorage.setItem('music_player_drawer_blur', blurRange.value);
            });

            blurRange.addEventListener('wheel', (e) => {
                e.preventDefault();
                const step = 1;
                let val = parseInt(blurRange.value, 10) || 0;
                if (e.deltaY < 0 || e.deltaX > 0) {
                    val = Math.min(30, val + step);
                } else {
                    val = Math.max(0, val - step);
                }
                blurRange.value = val;
                applyDrawerBlur(val);
                localStorage.setItem('music_player_drawer_blur', val);
            }, { passive: false });
        } else {
            applyDrawerBlur(savedBlur);
        }

        const durationRange = document.getElementById('graph-duration-range');
        const savedDuration = localStorage.getItem('music_player_drawer_graph_duration') ?? '30';
        if (durationRange) {
            durationRange.value = savedDuration;
            applyGraphDuration(durationRange.value);

            durationRange.addEventListener('input', () => {
                applyGraphDuration(durationRange.value);
                localStorage.setItem('music_player_drawer_graph_duration', durationRange.value);
            });

            durationRange.addEventListener('wheel', (e) => {
                e.preventDefault();
                const step = 5;
                let val = parseInt(durationRange.value, 10) || 30;
                if (e.deltaY < 0 || e.deltaX > 0) {
                    val = Math.min(DUREE_MAX_SEC, val + step);
                } else {
                    val = Math.max(DUREE_MIN_SEC, val - step);
                }
                durationRange.value = val;
                applyGraphDuration(val);
                localStorage.setItem('music_player_drawer_graph_duration', val);
            }, { passive: false });
        } else {
            applyGraphDuration(savedDuration);
        }

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && drawerPanel && drawerPanel.classList.contains('open')) {
                closeDrawer();
            }
        });

        window.addEventListener('resize', () => {
            if (estOuvert()) renderGraph(1 / 60);
        });
        updateBandwidthUI();

        if (localStorage.getItem('music_player_drawer_open') === 'true') {
            openDrawer();
        }
    }

    // Hook into MusicPlayer state listener
    window.MusicPlayer.onBotStatsUpdate = handleBotStatsUpdate;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initDrawer);
    } else {
        initDrawer();
    }
})();
