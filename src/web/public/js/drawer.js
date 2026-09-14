/* ═══════════════════════════════════════════════════════════════
   Right-Side Drawer & Bot Activity Memory Graph Controller
   ═══════════════════════════════════════════════════════════════ */

(function() {
    let drawerPanel = null;
    let drawerBackdrop = null;

    // Network Bandwidth Counters
    let totalBytesReceived = 0;

    /** Traduction avec repli sur la valeur française d'origine. */
    function tr(key, fallback) {
        const t = window.MusicPlayer && window.MusicPlayer.t;
        const value = typeof t === 'function' ? t(key) : null;
        return (value && value !== key) ? value : fallback;
    }

    /**
     * Symboles d'unités de taille. Ils diffèrent selon la langue : « Mo » en
     * français, « MB » en anglais, allemand et espagnol.
     */
    function units() {
        return {
            byte: tr('unit_bytes', 'octets'),
            kb: tr('unit_kb', 'Ko'),
            mb: tr('unit_mb', 'Mo'),
            go: tr('unit_gb', 'Go'),
        };
    }

    // Dynamic auto-scaling unit formatter (octets, Ko, Mo, Go)
    function formatBytes(bytes) {
        const u = units();
        if (!bytes || bytes <= 0) return { val: '0.00', unit: u.kb, raw: `0 ${u.byte}` };
        if (bytes < 1024) {
            return { val: bytes.toString(), unit: u.byte, raw: `${bytes} ${u.byte}` };
        }
        if (bytes < 1024 * 1024) {
            return { val: (bytes / 1024).toFixed(2), unit: u.kb, raw: `${bytes.toLocaleString()} ${u.byte}` };
        }
        if (bytes < 1024 * 1024 * 1024) {
            return { val: (bytes / (1024 * 1024)).toFixed(2), unit: u.mb, raw: `${(bytes / 1024).toFixed(1)} ${u.kb}` };
        }
        return { val: (bytes / (1024 * 1024 * 1024)).toFixed(2), unit: u.go, raw: `${(bytes / (1024 * 1024)).toFixed(1)} ${u.mb}` };
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

    const BYTES_PER_MB = 1024 * 1024;
    const MIN_DURATION_SEC = 10;
    const MAX_DURATION_SEC = 3600;
    /** Cadence réclamée au serveur pour le flux fin, tiroir ouvert. */
    const FINE_RATE_HZ = 60;
    /** Profondeur gardée à cadence fine ; au-delà l'historique 1 Hz prend le relais. */
    const FINE_WINDOW_SEC = 120;
    /** Marge de conservation au-delà de la plus large fenêtre possible. */
    const BUFFER_MARGIN_MS = 60 * 1000;
    /** Pas d'agrégation plancher : inutile de descendre sous la trame d'affichage. */
    const MIN_STEP_MS = Math.floor(1000 / FINE_RATE_HZ);
    /** Un point de courbe tous les N pixels. */
    const PX_PER_POINT = 3;
    const POINTS_MIN = 8;
    const POINTS_MAX = 400;
    // La marge droite loge la moitié du dernier libellé de temps (HH:MM:SS)
    // ainsi que la tête du tracé, qui vit exactement sur le bord.
    const MARGIN = { top: 22, bottom: 28, left: 64, right: 26 };
    const Y_LEVELS = 3;   // nombre d'intervalles → 4 graduations
    const TIME_SCALES_SEC = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];

    /** Mesures 1 Hz de `progress` : { t, rss, heapUsed, heapTotal }. */
    const slowSamples = [];
    /** Mesures du flux haute cadence, même forme. */
    const fineSamples = [];
    /** Horodatage de la dernière mesure agrégée, tous flux confondus. */
    let lastIntegratedT = 0;
    let lastEndReceivedMs = 0;
    let lastStreamRequestMs = 0;

    /** Agrégats affichés, ordre chronologique. */
    let buckets = [];
    let bucketStepMs = MIN_STEP_MS;

    let windowDurationSec = 30;
    let maxDisplayedMB = 100;
    let lastGraphWidth = 0;

    let animFrameId = null;
    let lastFrameMs = 0;

    // Interactive Hover & Tooltip State
    let hoverX = -1;
    let isHoveringGraph = false;

    /**
     * Facteur d'interpolation corrigé du temps écoulé : un lissage réglé
     * pour 60 ips ne doit pas ralentir quand la fenêtre rame.
     */
    function smoothingFactor(dtSec, k60) {
        const frames = Math.max(0.1, Math.min(6, dtSec * 60));
        return 1 - Math.pow(1 - k60, frames);
    }

    // ── Étage 1 : échantillons bruts ────────────────────────────────

    /**
     * Range une mesure dans son tampon. L'élagage se fait par lots : décaler
     * le tableau à chaque mesure coûterait plus cher, à 60 Hz, que de laisser
     * vivre quelques éléments hors fenêtre — ils sont filtrés au tracé.
     */
    function addSample(buffer, depthMs, rss, heapUsed, heapTotal, timestamp) {
        const t = Number(timestamp) || Date.now();
        const last = buffer[buffer.length - 1];
        // Un horodatage qui n'avance pas ne doit pas créer de point.
        if (last && t <= last.t) return;

        buffer.push({
            t,
            rss: Math.max(0, rss || 0),
            heapUsed: Math.max(0, heapUsed || 0),
            heapTotal: Math.max(0, heapTotal || 0)
        });

        const limit = t - depthMs;
        let stale = 0;
        while (stale < buffer.length && buffer[stale].t < limit) stale++;
        if (stale > 64) buffer.splice(0, stale);

        // Les deux flux se recouvrent : n'agréger que ce qui fait avancer le
        // temps, pour ne pas compter deux fois le même instant.
        if (t > lastIntegratedT) {
            lastIntegratedT = t;
            integrateIntoBuckets(buffer[buffer.length - 1]);
        }
    }

    /**
     * Mesures à tracer depuis `depuis` : cadence fine là où elle existe,
     * historique 1 Hz au-delà. Le graphique garde ainsi son passé même quand
     * le flux rapide vient tout juste de démarrer.
     */
    function mergedStream(from) {
        const toggleEl = fineSamples.length > 0 ? fineSamples[0].t : Infinity;
        const out = [];
        for (const m of slowSamples) {
            if (m.t >= from && m.t < toggleEl) out.push(m);
        }
        for (const m of fineSamples) {
            if (m.t >= from) out.push(m);
        }
        return out;
    }

    // ── Étage 2 : agrégation par pas de temps ───────────────────────

    /** Points de courbe tenables : la finesse que la largeur permet de rendre. */
    function pointCount(graphWidth) {
        return Math.max(POINTS_MIN, Math.min(POINTS_MAX, Math.floor(graphWidth / PX_PER_POINT)));
    }

    function computeStep(graphWidth) {
        const raw = (windowDurationSec * 1000) / pointCount(graphWidth);
        return Math.max(MIN_STEP_MS, Math.ceil(raw));
    }

    function createBucket(start, sample) {
        return {
            start,
            end: start + bucketStepMs,
            tFirst: sample.t,
            tLast: sample.t,
            rssSum: sample.rss,
            heapSum: sample.heapUsed,
            heapTotalSum: sample.heapTotal,
            count: 1,
            // Valeurs affichées, rattrapées par interpolation à chaque image.
            dRss: sample.rss,
            dHeap: sample.heapUsed,
            dHeapTotal: sample.heapTotal
        };
    }

    function accumulate(bucket, sample) {
        bucket.rssSum += sample.rss;
        bucket.heapSum += sample.heapUsed;
        bucket.heapTotalSum += sample.heapTotal;
        bucket.count++;
        bucket.tLast = sample.t;
    }

    function integrateIntoBuckets(sample) {
        const start = Math.floor(sample.t / bucketStepMs) * bucketStepMs;
        const last = buckets[buckets.length - 1];
        if (last && last.start === start) {
            accumulate(last, sample);
        } else {
            buckets.push(createBucket(start, sample));
        }
        pruneBuckets();
    }

    /**
     * Recalcule tous les paquets depuis les mesures brutes. Appelé quand le
     * pas change (curseur de durée, redimensionnement), donc jamais à chaque
     * image : le rendu ne fait ensuite que lire ces agrégats.
     */
    function rebuildBuckets(graphWidth) {
        bucketStepMs = computeStep(graphWidth);
        buckets = [];

        // Inutile de reconstruire ce qui est déjà sorti par la gauche.
        const from = Date.now() - windowDurationSec * 1000 - 2 * bucketStepMs;

        let current = null;
        for (const sample of mergedStream(from)) {
            const start = Math.floor(sample.t / bucketStepMs) * bucketStepMs;
            if (current && current.start === start) {
                accumulate(current, sample);
            } else {
                current = createBucket(start, sample);
                buckets.push(current);
            }
        }
        pruneBuckets();
    }

    function pruneBuckets() {
        // Deux paquets de battement au-delà du bord gauche : le tracé doit
        // entrer dans le cadre plutôt que d'y commencer net.
        const limit = Date.now() - windowDurationSec * 1000 - 2 * bucketStepMs;
        while (buckets.length > 0 && buckets[0].end < limit) {
            buckets.shift();
        }
    }

    function smoothValues(dtSec) {
        const k = smoothingFactor(dtSec, 0.15);
        for (const p of buckets) {
            p.dRss += (p.rssSum / p.count - p.dRss) * k;
            p.dHeap += (p.heapSum / p.count - p.dHeap) * k;
            p.dHeapTotal += (p.heapTotalSum / p.count - p.dHeapTotal) * k;
        }
    }

    // ── Étage 3 : rendu ─────────────────────────────────────────────

    // Auto-scale byte units into o, Ko, Mo, or Go
    function formatBytesWithUnit(bytes) {
        const val = Math.max(0, bytes || 0);
        const u = units();
        if (val >= 1024 * 1024 * 1024) {
            return `${(val / (1024 * 1024 * 1024)).toFixed(1)} ${u.go}`;
        }
        if (val >= 1024 * 1024) {
            return `${Math.round(val / (1024 * 1024))} ${u.mb}`;
        }
        if (val >= 1024) {
            return `${Math.round(val / 1024)} ${u.kb}`;
        }
        return `${Math.round(val)} o`;
    }

    /** Arrondit le sommet de l'axe Y à une valeur « ronde » lisible. */
    function niceMax(valueMB) {
        const base = Math.max(50, valueMB);
        const order = Math.pow(10, Math.floor(Math.log10(base)));
        for (const m of [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8]) {
            if (base <= m * order) return m * order;
        }
        return 10 * order;
    }

    function shortTime(ms, withSeconds) {
        const d = new Date(ms);
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        if (!withSeconds) return `${hh}:${mm}`;
        return `${hh}:${mm}:${String(d.getSeconds()).padStart(2, '0')}`;
    }

    /** Intervalle des graduations de temps, choisi pour ne pas les tasser. */
    function timeStepSec(graphWidth) {
        const maxGraduations = Math.max(2, Math.floor(graphWidth / 64));
        for (const stepValue of TIME_SCALES_SEC) {
            if (windowDurationSec / stepValue <= maxGraduations) return stepValue;
        }
        return MAX_DURATION_SEC;
    }

    /** Récupère (en le créant au besoin) le n-ième enfant d'un conteneur. */
    function elementPool(parent, index, create) {
        let el = parent.children[index];
        if (!el) {
            el = create();
            parent.appendChild(el);
        }
        el.style.display = '';
        return el;
    }

    function clipOverflow(parent, since) {
        for (let i = since; i < parent.children.length; i++) {
            parent.children[i].style.display = 'none';
        }
    }

    function createSvgLine() {
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

    function buildSvgArea(pts, bottomY) {
        if (pts.length < 2) return '';
        const lineD = buildSvgPath(pts);
        const last = pts[pts.length - 1];
        const first = pts[0];
        return `${lineD} L ${last.x.toFixed(1)} ${bottomY.toFixed(1)} L ${first.x.toFixed(1)} ${bottomY.toFixed(1)} Z`;
    }

    function renderGraph(dtSec) {
        const container = document.getElementById('memory-graph-container');
        if (!container) return;

        const rect = container.getBoundingClientRect();
        const width = rect.width || 340;
        const height = rect.height || 170;
        const graphW = Math.max(20, width - MARGIN.left - MARGIN.right);
        const graphH = Math.max(20, height - MARGIN.top - MARGIN.bottom);
        const bottomY = MARGIN.top + graphH;

        // La densité de nœuds dépend de la largeur : un tiroir redimensionné
        // change le pas d'agrégation, donc les paquets.
        if (Math.abs(graphW - lastGraphWidth) > 1) {
            lastGraphWidth = graphW;
            rebuildBuckets(graphW);
        }

        const now = Date.now();
        const windowMs = windowDurationSec * 1000;
        const tLeft = now - windowMs;
        const xFrom = (t) => MARGIN.left + ((t - tLeft) / windowMs) * graphW;

        pruneBuckets();
        smoothValues(dtSec);

        // Paquets visibles, plus le dernier sorti par la gauche pour que la
        // courbe traverse le bord au lieu d'y naître.
        const visible = [];
        for (let i = 0; i < buckets.length; i++) {
            if (buckets[i].tLast >= tLeft) {
                if (visible.length === 0 && i > 0) visible.push(buckets[i - 1]);
                visible.push(buckets[i]);
            }
        }

        // Échelle verticale : sommet arrondi, rejoint en douceur.
        let peakMB = 0;
        for (const p of visible) {
            const rssMegabytes = p.dRss / BYTES_PER_MB;
            const heapMegabytes = p.dHeap / BYTES_PER_MB;
            if (rssMegabytes > peakMB) peakMB = rssMegabytes;
            if (heapMegabytes > peakMB) peakMB = heapMegabytes;
        }
        const targetMB = niceMax(peakMB * 1.15);
        maxDisplayedMB += (targetMB - maxDisplayedMB) * smoothingFactor(dtSec, 0.12);
        const maxBytes = Math.max(1, maxDisplayedMB) * BYTES_PER_MB;
        const yFrom = (bytes) => bottomY - Math.min(1.2, (bytes || 0) / maxBytes) * graphH;

        // Graduations verticales (valeurs) — libellés alignés au pixel près
        // sur les lignes de la grille.
        const yAxis = document.getElementById('y-axis-labels');
        if (yAxis) {
            for (let i = 0; i <= Y_LEVELS; i++) {
                const fraction = i / Y_LEVELS;
                const lbl = elementPool(yAxis, i, () => {
                    const span = document.createElement('span');
                    span.className = 'y-axis-label';
                    return span;
                });
                lbl.textContent = formatBytesWithUnit(maxBytes * fraction);
                lbl.style.top = `${(bottomY - fraction * graphH).toFixed(1)}px`;
            }
            clipOverflow(yAxis, Y_LEVELS + 1);
        }

        // Grille : horizontales sur les graduations, verticales sur des
        // instants ronds — c'est ce qui rend la fenêtre du curseur lisible.
        const grid = document.getElementById('svg-grid-group');
        const xAxis = document.getElementById('x-axis-labels');
        let lineIndex = 0;
        if (grid) {
            for (let i = 0; i <= Y_LEVELS; i++) {
                const y = (bottomY - (i / Y_LEVELS) * graphH).toFixed(1);
                const line = elementPool(grid, lineIndex++, createSvgLine);
                line.setAttribute('class', 'graph-grid-line');
                line.setAttribute('x1', MARGIN.left);
                line.setAttribute('y1', y);
                line.setAttribute('x2', (MARGIN.left + graphW).toFixed(1));
                line.setAttribute('y2', y);
            }
        }

        const timeStep = timeStepSec(graphW) * 1000;
        const withSeconds = timeStep < 60000;
        let iLabelX = 0;
        for (let t = Math.ceil(tLeft / timeStep) * timeStep; t <= now; t += timeStep) {
            const x = xFrom(t);
            if (x < MARGIN.left - 1 || x > MARGIN.left + graphW + 1) continue;

            if (grid) {
                const line = elementPool(grid, lineIndex++, createSvgLine);
                line.setAttribute('class', 'graph-grid-line vertical');
                line.setAttribute('x1', x.toFixed(1));
                line.setAttribute('y1', MARGIN.top);
                line.setAttribute('x2', x.toFixed(1));
                line.setAttribute('y2', bottomY);
            }
            if (xAxis) {
                const lbl = elementPool(xAxis, iLabelX++, () => {
                    const span = document.createElement('span');
                    span.className = 'x-axis-label';
                    return span;
                });
                lbl.textContent = shortTime(t, withSeconds);
                lbl.style.left = `${x.toFixed(1)}px`;
                lbl.style.top = `${(bottomY + 8).toFixed(1)}px`;
            }
        }
        if (grid) clipOverflow(grid, lineIndex);
        if (xAxis) clipOverflow(xAxis, iLabelX);

        // Zone de tracé : la courbe ne doit pas déborder sous les libellés.
        const clip = document.getElementById('graph-clip-rect');
        if (clip) {
            clip.setAttribute('x', MARGIN.left);
            clip.setAttribute('y', MARGIN.top - 6);
            clip.setAttribute('width', graphW.toFixed(1));
            clip.setAttribute('height', (graphH + 6).toFixed(1));
        }

        const ptsRss = visible.map(p => ({ x: xFrom(p.tLast), y: yFrom(p.dRss) }));
        const ptsHeap = visible.map(p => ({ x: xFrom(p.tLast), y: yFrom(p.dHeap) }));

        const svgRssLine = document.getElementById('svg-rss-line');
        const svgHeapLine = document.getElementById('svg-heap-line');
        const svgRssArea = document.getElementById('svg-rss-area');
        const svgHeapArea = document.getElementById('svg-heap-area');

        if (svgRssLine) svgRssLine.setAttribute('d', buildSvgPath(ptsRss));
        if (svgHeapLine) svgHeapLine.setAttribute('d', buildSvgPath(ptsHeap));
        if (svgRssArea) svgRssArea.setAttribute('d', buildSvgArea(ptsRss, bottomY));
        if (svgHeapArea) svgHeapArea.setAttribute('d', buildSvgArea(ptsHeap, bottomY));

        // Survol : le paquet dont l'abscisse est la plus proche du curseur.
        let hovered = -1;
        if (isHoveringGraph && hoverX >= MARGIN.left - 12 && hoverX <= MARGIN.left + graphW + 12) {
            let minGap = Infinity;
            ptsRss.forEach((pt, i) => {
                const gap = Math.abs(pt.x - hoverX);
                if (gap < minGap) {
                    minGap = gap;
                    hovered = i;
                }
            });
        }

        // Repères : un seul point par série, sous le curseur. La courbe compte
        // un point tous les quelques pixels ; les matérialiser tous couvrirait
        // le tracé de pastilles. Hors survol, le graphique reste nu.
        const nodesLayer = document.getElementById('graph-nodes-layer');
        if (nodesLayer) {
            if (hovered >= 0) {
                [[ptsRss[hovered], 'rss'], [ptsHeap[hovered], 'heap']].forEach(([pt, series], j) => {
                    const node = elementPool(nodesLayer, j, () => document.createElement('div'));
                    node.className = `dom-graph-node ${series} active`;
                    node.style.left = `${pt.x.toFixed(1)}px`;
                    node.style.top = `${pt.y.toFixed(1)}px`;
                    node.style.opacity = '1';
                });
            }
            clipOverflow(nodesLayer, hovered >= 0 ? 2 : 0);
        }

        // Réticule et infobulle
        const tooltip = document.getElementById('graph-tooltip');
        const crosshair = document.getElementById('svg-crosshair');

        if (hovered >= 0) {
            const bucket = visible[hovered];
            const hx = ptsRss[hovered].x;

            if (crosshair) {
                crosshair.setAttribute('x1', hx.toFixed(1));
                crosshair.setAttribute('y1', MARGIN.top);
                crosshair.setAttribute('x2', hx.toFixed(1));
                crosshair.setAttribute('y2', bottomY);
                crosshair.style.opacity = '1';
            }

            if (tooltip) {
                tooltip.classList.remove('hidden');

                // Les valeurs affichées sont les mesures réelles du paquet,
                // pas leur version lissée pour l'animation.
                const rssMegabytes = (bucket.rssSum / bucket.count) / BYTES_PER_MB;
                const heapMegabytes = (bucket.heapSum / bucket.count) / BYTES_PER_MB;
                const heapTotalMegabytes = (bucket.heapTotalSum / bucket.count) / BYTES_PER_MB;

                const elTime = document.getElementById('gt-time');
                const elRss = document.getElementById('gt-rss');
                const elHeap = document.getElementById('gt-heap');

                // Un paquet qui condense plus d'une seconde de mesures affiche
                // sa plage : la moyenne annoncée reste ainsi interprétable.
                if (elTime) {
                    elTime.textContent = (bucket.tLast - bucket.tFirst) >= 1000
                        ? `${shortTime(bucket.tFirst, true)} → ${shortTime(bucket.tLast, true)}`
                        : shortTime(bucket.tLast, true);
                }
                const mbUnit = units().mb;
                if (elRss) elRss.textContent = `${rssMegabytes.toFixed(1)} ${mbUnit}`;
                if (elHeap) elHeap.textContent = `${heapMegabytes.toFixed(1)} / ${heapTotalMegabytes.toFixed(1)} ${mbUnit}`;

                const tooltipW = tooltip.offsetWidth || 140;
                const tooltipH = tooltip.offsetHeight || 75;

                let posX = hx - tooltipW / 2;
                let posY = Math.min(ptsRss[hovered].y, ptsHeap[hovered].y) - tooltipH - 12;
                if (posY < 5) posY = Math.max(ptsRss[hovered].y, ptsHeap[hovered].y) + 12;
                posX = Math.max(8, Math.min(width - tooltipW - 8, posX));

                tooltip.style.left = `${posX}px`;
                tooltip.style.top = `${posY}px`;
            }
        } else {
            if (crosshair) crosshair.style.opacity = '0';
            if (tooltip) tooltip.classList.add('hidden');
        }
    }

    function animationLoop(timestamp) {
        const now = typeof timestamp === 'number' ? timestamp : performance.now();
        const dtSec = lastFrameMs > 0 ? (now - lastFrameMs) / 1000 : 1 / 60;
        lastFrameMs = now;

        renderGraph(Math.min(0.5, Math.max(0.001, dtSec)));

        if (drawerPanel && drawerPanel.classList.contains('open')) {
            animFrameId = requestAnimationFrame(animationLoop);
        } else {
            animFrameId = null;
            lastFrameMs = 0;
        }
    }

    function startAnimationLoop() {
        if (!animFrameId) {
            lastFrameMs = 0;
            animationLoop();
        }
    }

    function stopAnimationLoop() {
        if (animFrameId) {
            cancelAnimationFrame(animFrameId);
            animFrameId = null;
            lastFrameMs = 0;
        }
    }

    /** Le graphique ne se redessine que s'il est à l'écran. */
    function isOpen() {
        return !!(drawerPanel && drawerPanel.classList.contains('open'));
    }

    /**
     * (Dés)abonnement au flux mémoire haute cadence. Il coûte au serveur un
     * minuteur et quelques kilo-octets par seconde : on ne le demande que
     * pendant que le graphique est visible.
     */
    function requestMemoryStream(active) {
        if (typeof window.MusicPlayer.sendWS !== 'function') return;
        window.MusicPlayer.sendWS({
            type: 'memoryStream',
            data: { enabled: !!active, hz: FINE_RATE_HZ }
        });
        lastStreamRequestMs = Date.now();
    }

    /**
     * Empreinte des tampons de mesures, pour le widget de répartition.
     * Chaque mesure est un petit objet de quatre nombres ; chaque agrégat en
     * porte une douzaine de champs.
     */
    window.MusicPlayer.graphicsFingerprint = function() {
        const samples = slowSamples.length + fineSamples.length;
        return {
            samples,
            buckets: buckets.length,
            bytes: samples * (4 * 8 + 40) + buckets.length * (12 * 8 + 40)
        };
    };

    /**
     * Lots d'échantillons du flux haute cadence : [t, rss, heapUsed, heapTotal].
     */
    window.MusicPlayer.onMemorySamples = function(data) {
        if (!data || !Array.isArray(data.samples)) return;
        for (const s of data.samples) {
            if (!Array.isArray(s) || s.length < 4) continue;
            addSample(fineSamples, FINE_WINDOW_SEC * 1000, s[1], s[2], s[3], s[0]);
        }
        lastEndReceivedMs = Date.now();
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
            requestMemoryStream(true);
            startAnimationLoop();
            if (typeof window.MusicPlayer.setBreakdownActive === 'function') {
                window.MusicPlayer.setBreakdownActive(true);
            }
        }
    }

    function closeDrawer() {
        if (drawerPanel && drawerBackdrop) {
            drawerPanel.classList.remove('open');
            drawerBackdrop.classList.remove('active');
            document.body.classList.remove('drawer-is-open');
            localStorage.setItem('music_player_drawer_open', 'false');
            requestMemoryStream(false);
            stopAnimationLoop();
            if (typeof window.MusicPlayer.setBreakdownActive === 'function') {
                window.MusicPlayer.setBreakdownActive(false);
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
            addSample(
                slowSamples,
                MAX_DURATION_SEC * 1000 + BUFFER_MARGIN_MS,
                stats.memory.rss,
                stats.memory.heapUsed,
                stats.memory.heapTotal,
                stats.timestamp
            );

            // Le flux rapide vit côté serveur, attaché à la connexion : une
            // reconnexion (ou un redémarrage du bot) le perd sans prévenir.
            // Ce message-ci arrive chaque seconde et sert de battement : si le
            // flux se tait alors que le tiroir est ouvert, on le redemande.
            const now = Date.now();
            if (isOpen()
                && now - lastEndReceivedMs > 2000
                && now - lastStreamRequestMs > 2000) {
                requestMemoryStream(true);
            }

            // Update UI metric text labels
            const rssMB = (stats.memory.rss / BYTES_PER_MB).toFixed(1);
            const heapUsedMB = (stats.memory.heapUsed / BYTES_PER_MB).toFixed(1);
            const heapTotalMB = (stats.memory.heapTotal / BYTES_PER_MB).toFixed(1);

            const elRss = document.getElementById('bot-mem-rss');
            const elHeap = document.getElementById('bot-mem-heap');
            const elUptime = document.getElementById('bot-uptime');

            const mb = units().mb;
            if (elRss) elRss.textContent = `${rssMB} ${mb}`;
            if (elHeap) elHeap.textContent = `${heapUsedMB} / ${heapTotalMB} ${mb}`;
            if (elUptime) elUptime.textContent = formatUptime(stats.uptime);

            // Dernières valeurs connues, pour pouvoir réafficher au changement de langue
            lastStats = stats;
        }
    }

    /** Dernier instantané reçu, réutilisé lors d'un changement de langue. */
    let lastStats = null;

    /**
     * Réapplique la langue aux libellés que le tiroir construit lui-même :
     * les attributs data-i18n ne les atteignent pas.
     */
    window.MusicPlayer.refreshDrawerLabels = function() {
        updateBandwidthUI();
        if (lastStats && lastStats.memory) {
            const stats = lastStats;
            const mb = units().mb;
            const elRss = document.getElementById('bot-mem-rss');
            const elHeap = document.getElementById('bot-mem-heap');
            const elUptime = document.getElementById('bot-uptime');
            if (elRss) elRss.textContent = `${(stats.memory.rss / BYTES_PER_MB).toFixed(1)} ${mb}`;
            if (elHeap) {
                elHeap.textContent = `${(stats.memory.heapUsed / BYTES_PER_MB).toFixed(1)} / ${(stats.memory.heapTotal / BYTES_PER_MB).toFixed(1)} ${mb}`;
            }
            if (elUptime) elUptime.textContent = formatUptime(stats.uptime);
        }
        if (isOpen()) renderGraph(1 / 60);
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
        const request = parseInt(val, 10);
        windowDurationSec = Math.max(MIN_DURATION_SEC, Math.min(MAX_DURATION_SEC, isNaN(request) ? 30 : request));

        const valSpan = document.getElementById('val-graph-duration');
        if (valSpan) valSpan.textContent = formatDurationHHMMSS(windowDurationSec);

        const container = document.getElementById('memory-graph-container');
        const panelWidth = container
            ? Math.max(20, container.getBoundingClientRect().width - MARGIN.left - MARGIN.right)
            : lastGraphWidth || 240;
        lastGraphWidth = panelWidth;
        rebuildBuckets(panelWidth);

        if (isOpen()) renderGraph(1 / 60);
    }

    // Initialize Drawer Elements and Event Listeners
    function initDrawer() {
        drawerPanel = document.getElementById('drawer-panel');
        drawerBackdrop = document.getElementById('drawer-backdrop');

        const graphContainer = document.getElementById('memory-graph-container');
        if (graphContainer) {
            const pointerTracked = (clientX) => {
                const rect = graphContainer.getBoundingClientRect();
                hoverX = clientX - rect.left;
                isHoveringGraph = true;
            };
            const pointerEnd = () => {
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

            graphContainer.addEventListener('mousemove', (e) => pointerTracked(e.clientX));
            graphContainer.addEventListener('mouseleave', pointerEnd);
            graphContainer.addEventListener('touchstart', (e) => {
                if (e.touches.length > 0) pointerTracked(e.touches[0].clientX);
            }, { passive: true });
            graphContainer.addEventListener('touchmove', (e) => {
                if (e.touches.length > 0) pointerTracked(e.touches[0].clientX);
            }, { passive: true });
            graphContainer.addEventListener('touchend', pointerEnd);
            graphContainer.addEventListener('touchcancel', pointerEnd);
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

        /*
         * Top-Right Screen Corner Mouse Proximity Activation
         *
         * Une commande de souris, et d'elle seule : il s'agit d'approcher sans
         * cliquer. Au doigt, elle n'a rien à ouvrir et beaucoup à casser — un
         * navigateur mobile émet un `mousemove` simulé à chaque appui, et deux
         * autres languettes ont depuis pris place sous celle-ci, dans la bande
         * de 30 à 180 px que cette zone couvre. Y toucher aurait ouvert le
         * tiroir d'activité par-dessus celui qu'on demandait.
         */
        document.addEventListener('mousemove', (e) => {
            const deviceMode = window.MusicPlayer.deviceMode;
            if (deviceMode && deviceMode.isTouch()) return;
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

            /*
             * Un clic dans la ligne arme le curseur sans le régler, la molette le
             * règle ensuite depuis tout son cadre — voir js/rangeArm.js. Le corps
             * du tiroir défile : une molette qui ne fait que passer ne doit rien
             * changer.
             */
            if (typeof window.MusicPlayer.armRange === 'function') {
                window.MusicPlayer.armRange(blurRange, (e) => {
                    const step = 1;
                    let val = parseInt(blurRange.value, 10) || 0;
                    if (e.deltaY < 0 || e.deltaX > 0) {
                        val = Math.min(30, val + step);
                    } else {
                        val = Math.max(0, val - step);
                    }
                    blurRange.value = val;
                    // Le chemin de l'écouteur d'« input » ci-dessus, qui applique
                    // et enregistre : deux fois le même geste finirait par
                    // diverger.
                    blurRange.dispatchEvent(new Event('input', { bubbles: true }));
                });
            }
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

            // Mêmes deux gestes que son voisin du dessus, et pour les mêmes
            // raisons.
            if (typeof window.MusicPlayer.armRange === 'function') {
                window.MusicPlayer.armRange(durationRange, (e) => {
                    const step = 5;
                    let val = parseInt(durationRange.value, 10) || 30;
                    if (e.deltaY < 0 || e.deltaX > 0) {
                        val = Math.min(MAX_DURATION_SEC, val + step);
                    } else {
                        val = Math.max(MIN_DURATION_SEC, val - step);
                    }
                    durationRange.value = val;
                    durationRange.dispatchEvent(new Event('input', { bubbles: true }));
                });
            }
        } else {
            applyGraphDuration(savedDuration);
        }

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && drawerPanel && drawerPanel.classList.contains('open')) {
                closeDrawer();
            }
        });

        window.addEventListener('resize', () => {
            if (isOpen()) renderGraph(1 / 60);
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
