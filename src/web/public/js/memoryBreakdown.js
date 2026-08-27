/* ═══════════════════════════════════════════════════════════════
   Widget « Répartition Mémoire » — d'où vient la mémoire du tableau de bord
   ───────────────────────────────────────────────────────────────
   Le graphique voisin suit la mémoire du bot ; celui-ci regarde la page
   elle-même, et répond à une autre question : qu'est-ce qui, ici, occupe
   de la place ?

   Aucun navigateur n'expose la mémoire réellement consommée par un élément
   du DOM (`measureUserAgentSpecificMemory` s'en approche, mais exige une
   page isolée entre origines, ce que le tableau de bord n'est pas). On
   distingue donc ce qui est mesuré de ce qui est estimé :

     • mesuré  — nombre de nœuds, d'attributs, de caractères ; taille des
                 images décodées (largeur × hauteur × 4 octets, la place
                 qu'occupe vraiment une bitmap) ; tas JavaScript et poids
                 du code chargé, quand le navigateur les publie.
     • estimé  — la traduction des comptages en octets, via un coût moyen
                 par nœud annoncé sous le widget.

   Les deux familles ne sont jamais additionnées en silence : les valeurs
   estimées sont regroupées sous « Éléments », les valeurs mesurées sous
   « Hors éléments ».
   ═══════════════════════════════════════════════════════════════ */

(function() {
    'use strict';

    window.MusicPlayer = window.MusicPlayer || {};

    /**
     * Coût moyen d'un nœud dans un moteur de rendu : l'objet Element, son
     * style calculé et son objet de mise en page. L'ordre de grandeur vaut
     * mieux qu'un silence, et il est affiché à l'utilisateur.
     */
    const COST_ELEMENT = 256;
    const COST_ATTRIBUTE = 48;
    const COST_CHARACTER = 2;      // chaînes UTF-16
    const BYTES_PER_PIXEL = 4;    // RGBA
    const PERIOD_MS = 2000;
    /** Au-delà, les zones les plus légères sont fondues dans « Autres ». */
    const MAX_ROWS = 8;

    const PALETTE = [
        '#5865f2', '#00f3ff', '#eb459e', '#26de81', '#f7b731',
        '#a55eea', '#fd9644', '#45aaf2', '#2bcbba', '#fc5c65'
    ];
    const ELEMENTS_COLOR = '#5865f2';
    const HEAP_COLOR = '#00f3ff';
    const CODE_COLOR = '#f7b731';

    let timer = null;

    function tr(key, fallback) {
        const t = window.MusicPlayer && window.MusicPlayer.t;
        const value = typeof t === 'function' ? t(key) : null;
        return (value && value !== key) ? value : fallback;
    }

    function formatBytes(bytes) {
        const v = Math.max(0, bytes || 0);
        const kb = tr('unit_kb', 'Ko');
        const mb = tr('unit_mb', 'Mo');
        const go = tr('unit_gb', 'Go');
        if (v >= 1024 * 1024 * 1024) return `${(v / (1024 ** 3)).toFixed(2)} ${go}`;
        if (v >= 1024 * 1024) return `${(v / (1024 * 1024)).toFixed(1)} ${mb}`;
        if (v >= 1024) return `${Math.round(v / 1024)} ${kb}`;
        return `${Math.round(v)} o`;
    }

    function shortCount(n) {
        return (n || 0).toLocaleString();
    }

    // ── Mesure du DOM ───────────────────────────────────────────────

    /**
     * Place occupée par la bitmap d'un élément — la seule mémoire d'affichage
     * réellement calculable depuis la page.
     */
    function bitmapBytes(el) {
        switch (el.tagName) {
            case 'IMG':
                return (el.complete && el.naturalWidth)
                    ? el.naturalWidth * el.naturalHeight * BYTES_PER_PIXEL : 0;
            case 'CANVAS':
                return (el.width || 0) * (el.height || 0) * BYTES_PER_PIXEL;
            case 'VIDEO':
                // Une image décodée. Le nombre de trames gardées en tampon
                // dépend du décodeur et n'est pas exposé.
                return (el.videoWidth || 0) * (el.videoHeight || 0) * BYTES_PER_PIXEL;
            default:
                return 0;
        }
    }

    /** Parcourt une zone une seule fois et en compte le contenu. */
    function weighZone(root) {
        if (!root) return null;

        let elements = 0;
        let attrs = 0;
        let characters = 0;
        let bitmaps = 0;
        let images = 0;

        const walker = document.createTreeWalker(
            root,
            NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT
        );

        let node = root;   // la racine elle-même fait partie de la zone
        while (node) {
            if (node.nodeType === 1) {
                elements++;
                attrs += node.attributes ? node.attributes.length : 0;
                const bitmap = bitmapBytes(node);
                if (bitmap > 0) {
                    bitmaps += bitmap;
                    images++;
                }
            } else if (node.nodeType === 3 && node.nodeValue) {
                characters += node.nodeValue.length;
            }
            node = walker.nextNode();
        }

        return {
            elements, attrs, characters, bitmaps, images,
            bytes: elements * COST_ELEMENT
                  + attrs * COST_ATTRIBUTE
                  + characters * COST_CHARACTER
                  + bitmaps
        };
    }

    function addTotals(a, b) {
        return {
            elements: a.elements + b.elements,
            attrs: a.attrs + b.attrs,
            characters: a.characters + b.characters,
            bitmaps: a.bitmaps + b.bitmaps,
            images: a.images + b.images,
            bytes: a.bytes + b.bytes
        };
    }

    function subtractTotals(a, b) {
        return {
            elements: Math.max(0, a.elements - b.elements),
            attrs: Math.max(0, a.attrs - b.attrs),
            characters: Math.max(0, a.characters - b.characters),
            bitmaps: Math.max(0, a.bitmaps - b.bitmaps),
            images: Math.max(0, a.images - b.images),
            bytes: Math.max(0, a.bytes - b.bytes)
        };
    }

    const ZERO = { elements: 0, attrs: 0, characters: 0, bitmaps: 0, images: 0, bytes: 0 };

    /** Titre visible d'une carte, débarrassé de sa poignée et de son cadenas. */
    function cardTitle(card) {
        const title = card.querySelector('.card-title');
        if (!title) return card.id || '?';
        const copy = title.cloneNode(true);
        copy.querySelectorAll('svg, button').forEach(el => el.remove());
        return copy.textContent.trim() || card.id;
    }

    /**
     * Zones disjointes du document. Le reste de `<body>` — en-tête, fenêtres
     * modales, menus contextuels, décor — est déduit par soustraction.
     */
    function measurableAreas() {
        const list = [];

        const grid = document.getElementById('dashboard-grid');
        if (grid) {
            grid.querySelectorAll(':scope > .card').forEach(card => {
                list.push({ key: card.id, label: cardTitle(card), element: card });
            });
        }

        [
            ['particle-path-canvas', 'mem_zone_particles', 'Animation de particules'],
            ['video-floating-window', 'mem_zone_video', 'Fenêtre vidéo'],
            ['logs-floating-window', 'mem_zone_logs', 'Fenêtre des journaux'],
            ['drawer-panel', 'mem_zone_drawer', 'Tiroir']
        ].forEach(([id, key, fallback]) => {
            const el = document.getElementById(id);
            if (el) list.push({ key: id, label: tr(key, fallback), element: el });
        });

        return list;
    }

    function measureElements() {
        const total = weighZone(document.body) || ZERO;
        const zones = measurableAreas();

        let running = ZERO;
        const rows = zones.map((zone, i) => {
            const weight = weighZone(zone.element) || ZERO;
            running = addTotals(running, weight);
            return { key: zone.key, label: zone.label, weight, color: PALETTE[i % PALETTE.length] };
        });

        // Tout ce que le document contient hors des zones nommées.
        rows.push({
            key: '__reste__',
            label: tr('mem_zone_other', 'Autres éléments'),
            weight: subtractTotals(total, running),
            color: 'rgba(160, 160, 176, 0.75)'
        });

        rows.sort((a, b) => b.weight.bytes - a.weight.bytes);

        // Les zones les plus légères rejoignent le fourre-tout, qui ferme la
        // liste. On repart d'un cumul unique : le fourre-tout figure déjà
        // parmi les lignes triées, et en créer un second le dédoublerait.
        if (rows.length > MAX_ROWS) {
            const kept = [];
            let remainder = ZERO;
            for (const l of rows) {
                if (kept.length < MAX_ROWS - 1 && l.key !== '__reste__') {
                    kept.push(l);
                } else {
                    remainder = addTotals(remainder, l.weight);
                }
            }
            kept.push({
                key: '__reste__',
                label: tr('mem_zone_other', 'Autres éléments'),
                weight: remainder,
                color: 'rgba(160, 160, 176, 0.75)'
            });
            return { total, rows: kept };
        }

        return { total, rows };
    }

    // ── Mesure hors DOM ─────────────────────────────────────────────

    /** Tas JavaScript, quand le navigateur le publie (Chromium). */
    function javascriptHeap() {
        const m = window.performance && window.performance.memory;
        if (!m || typeof m.usedJSHeapSize !== 'number') return null;
        return { used: m.usedJSHeapSize, total: m.totalJSHeapSize, limit: m.jsHeapSizeLimit };
    }

    /**
     * Poids décodé du code et des styles chargés. Les ressources d'une autre
     * origine ne publient pas leur taille sans `Timing-Allow-Origin` : elles
     * comptent pour zéro plutôt que d'être devinées.
     */
    function loadedCode() {
        if (!window.performance || typeof window.performance.getEntriesByType !== 'function') return null;
        const types = ['script', 'link', 'css'];
        let bytes = 0;
        let count = 0;
        for (const e of window.performance.getEntriesByType('resource')) {
            if (!types.includes(e.initiatorType)) continue;
            const size = e.decodedBodySize || 0;
            if (size > 0) {
                bytes += size;
                count++;
            }
        }
        return { bytes, count };
    }

    /**
     * Données que le tableau de bord conserve en mémoire vive. La taille
     * annoncée est celle de leur forme sérialisée : un ordre de grandeur
     * comparable d'une ligne à l'autre, pas l'empreinte exacte dans le tas.
     */
    function retainedData() {
        const state = window.MusicPlayer.state || {};
        const rows = [];

        const add = (label, value, count) => {
            if (!value) return;
            let size = 0;
            try {
                size = JSON.stringify(value).length;
            } catch (e) {
                return;
            }
            if (size <= 2) return;
            rows.push({ label, bytes: size, count });
        };

        add(tr('card_queue', "File d'attente"), state.queue, (state.queue || []).length);
        add(tr('card_history', 'Historique de lecture'), state.history, (state.history || []).length);
        add(tr('card_playlists', 'Playlists'), state.playlists, (state.playlists || []).length);

        const logs = window.MusicPlayer.logsHistory;
        if (Array.isArray(logs)) {
            add(tr('mem_data_logs', 'Journaux'), logs, logs.length);
        }

        if (typeof window.MusicPlayer.graphicsFingerprint === 'function') {
            const g = window.MusicPlayer.graphicsFingerprint();
            if (g && g.bytes > 0) {
                rows.push({
                    label: tr('mem_data_graph', 'Mesures du graphique'),
                    bytes: g.bytes,
                    count: g.samples
                });
            }
        }

        rows.sort((a, b) => b.bytes - a.bytes);
        return rows;
    }

    // ── Rendu ───────────────────────────────────────────────────────

    function buildRow(color, label, detail, value, fraction) {
        const row = document.createElement('div');
        row.className = 'breakdown-row';

        const gauge = document.createElement('div');
        gauge.className = 'breakdown-rowbar';
        gauge.style.width = `${Math.max(0, Math.min(100, fraction * 100)).toFixed(1)}%`;
        gauge.style.background = color;
        row.appendChild(gauge);

        const badgeEl = document.createElement('span');
        badgeEl.className = 'breakdown-dot';
        badgeEl.style.background = color;
        row.appendChild(badgeEl);

        const nameEl = document.createElement('span');
        nameEl.className = 'breakdown-label';
        nameEl.textContent = label;
        row.appendChild(nameEl);

        if (detail) {
            const det = document.createElement('span');
            det.className = 'breakdown-detail';
            det.textContent = detail;
            row.appendChild(det);
        }

        const valueEl = document.createElement('span');
        valueEl.className = 'breakdown-value';
        valueEl.textContent = value;
        row.appendChild(valueEl);

        return row;
    }

    function buildGroupTitle(label, value) {
        const title = document.createElement('div');
        title.className = 'breakdown-group-title';

        const nameEl = document.createElement('span');
        nameEl.textContent = label;
        title.appendChild(nameEl);

        const valueEl = document.createElement('span');
        valueEl.textContent = value;
        title.appendChild(valueEl);

        return title;
    }

    function render() {
        const list = document.getElementById('breakdown-list');
        const bar = document.getElementById('breakdown-bar');
        const badge = document.getElementById('breakdown-total');
        if (!list || !bar) return;

        const elements = measureElements();
        const heap = javascriptHeap();
        const code = loadedCode();

        const elementBytes = elements.total.bytes;
        const heapBytes = heap ? heap.used : 0;
        const codeBytes = code ? code.bytes : 0;
        const grandTotal = elementBytes + heapBytes + codeBytes;

        if (badge) badge.textContent = formatBytes(grandTotal);

        // Barre empilée : uniquement les trois familles, qui ne se recouvrent pas.
        bar.innerHTML = '';
        [
            [elementBytes, ELEMENTS_COLOR],
            [heapBytes, HEAP_COLOR],
            [codeBytes, CODE_COLOR]
        ].forEach(([bytes, color]) => {
            if (bytes <= 0 || grandTotal <= 0) return;
            const seg = document.createElement('div');
            seg.className = 'breakdown-seg';
            seg.style.width = `${(bytes / grandTotal * 100).toFixed(2)}%`;
            seg.style.background = color;
            bar.appendChild(seg);
        });

        list.innerHTML = '';

        // ── Groupe 1 : les éléments de la page ──
        list.appendChild(buildGroupTitle(
            tr('mem_group_elements', 'Éléments du tableau de bord'),
            formatBytes(elementBytes)
        ));

        const heaviest = elements.rows.length > 0 ? elements.rows[0].weight.bytes : 1;
        const nodesWord = tr('mem_unit_nodes', 'nœuds');
        const imagesWord = tr('mem_unit_images', 'img.');

        elements.rows.forEach(l => {
            let detail = `${shortCount(l.weight.elements)} ${nodesWord}`;
            if (l.weight.images > 0) {
                detail += ` · ${l.weight.images} ${imagesWord} ${formatBytes(l.weight.bitmaps)}`;
            }
            list.appendChild(buildRow(
                l.color, l.label, detail, formatBytes(l.weight.bytes),
                heaviest > 0 ? l.weight.bytes / heaviest : 0
            ));
        });

        // ── Groupe 2 : tout le reste ──
        list.appendChild(buildGroupTitle(
            tr('mem_group_other', 'Hors éléments'),
            formatBytes(heapBytes + codeBytes)
        ));

        const reference = Math.max(heapBytes, codeBytes, 1);

        if (heap) {
            list.appendChild(buildRow(
                HEAP_COLOR,
                tr('mem_row_heap', 'Tas JavaScript'),
                `${formatBytes(heap.total)} ${tr('mem_reserved', 'réservés')}`,
                formatBytes(heap.used),
                heapBytes / reference
            ));
        } else {
            // Firefox et Safari ne publient pas la taille du tas. Mieux vaut
            // le dire que d'avancer un chiffre inventé.
            list.appendChild(buildRow(
                'rgba(160, 160, 176, 0.75)',
                tr('mem_row_heap', 'Tas JavaScript'),
                '',
                tr('mem_unavailable', 'non exposé'),
                0
            ));
        }

        // Ce que le tableau de bord garde en mémoire vive : un sous-ensemble
        // du tas ci-dessus, présenté comme tel et jamais additionné à lui.
        // Ce détail ne dépend pas de la publication du tas par le navigateur :
        // il reste affiché là où celle-ci manque, et c'est même là qu'il
        // renseigne le plus.
        const data = retainedData();
        if (data.length > 0) {
            const intro = document.createElement('div');
            intro.className = 'breakdown-sub-intro';
            intro.textContent = tr('mem_of_which', 'dont données conservées (taille sérialisée)');
            list.appendChild(intro);

            data.forEach(d => {
                const sub = document.createElement('div');
                sub.className = 'breakdown-sub';

                const nameEl = document.createElement('span');
                nameEl.className = 'breakdown-label';
                nameEl.textContent = d.label + (d.count ? ` (${shortCount(d.count)})` : '');
                sub.appendChild(nameEl);

                const valueEl = document.createElement('span');
                valueEl.className = 'breakdown-value';
                valueEl.textContent = formatBytes(d.bytes);
                sub.appendChild(valueEl);

                list.appendChild(sub);
            });
        }

        if (code && code.bytes > 0) {
            list.appendChild(buildRow(
                CODE_COLOR,
                tr('mem_row_code', 'Code & styles chargés'),
                `${code.count} ${tr('mem_unit_files', 'fichiers')}`,
                formatBytes(code.bytes),
                codeBytes / reference
            ));
        }
    }

    /** Rendu public, réutilisé au changement de langue. */
    window.MusicPlayer.refreshMemoryBreakdown = function() {
        try {
            render();
        } catch (err) {
            console.error('[MemoryBreakdown] Rendering impossible:', err);
        }
    };

    /**
     * Le parcours du DOM n'a de sens que si le widget est visible : hors de
     * là, rien ne tourne.
     */
    window.MusicPlayer.setBreakdownActive = function(active) {
        if (timer) {
            clearInterval(timer);
            timer = null;
        }
        if (!active) return;
        window.MusicPlayer.refreshMemoryBreakdown();
        timer = setInterval(window.MusicPlayer.refreshMemoryBreakdown, PERIOD_MS);
    };
})();
