/**
 * Particle Path Routing Module
 * Draws dynamic obstacle-avoiding particle paths between the Add File box and target destination box.
 */

window.MusicPlayer = window.MusicPlayer || {};

(function () {
    let canvas = null;
    let ctx = null;
    let animationFrameId = null;
    let pathPoints = [];
    let particles = [];
    let currentTargetKey = 'queue'; // default
    let isInitialized = false;

    // Marge de sécurité conservée autour de chaque carte lors du test de collision.
    const COLLISION_PADDING = 6;
    // Distance à laquelle les points de passage (coins) sont placés hors d'une carte.
    // Doit toujours être STRICTEMENT supérieur à COLLISION_PADDING, sinon un point de
    // passage pourrait se retrouver considéré comme "à l'intérieur" de sa propre carte.
    const CORNER_OFFSET = 12;

    const TARGET_MAP = {
        'queue': 'queue-card',
        'playlist': 'playlists-card',
        'play': 'player-card'
    };

    let isParticlePathEnabled = localStorage.getItem('particlePathEnabled') !== 'false';

    function init() {
        if (isInitialized) return;

        // Create canvas container if it doesn't exist
        canvas = document.getElementById('particle-path-canvas');
        if (!canvas) {
            canvas = document.createElement('canvas');
            canvas.id = 'particle-path-canvas';
            canvas.style.position = 'absolute';
            canvas.style.top = '0';
            canvas.style.left = '0';
            canvas.style.width = '100%';
            canvas.style.height = '100%';
            canvas.style.pointerEvents = 'none';
            canvas.style.zIndex = '90';

            const dashboardGrid = document.getElementById('dashboard-grid') || document.body;
            if (dashboardGrid.style.position !== 'relative' && dashboardGrid.style.position !== 'absolute') {
                dashboardGrid.style.position = 'relative';
            }
            dashboardGrid.appendChild(canvas);
        }

        ctx = canvas.getContext('2d');
        resizeCanvas();

        window.addEventListener('resize', handleResize);

        // Listen for destination select changes
        const addTargetSelect = document.getElementById('add-target-select');
        if (addTargetSelect) {
            currentTargetKey = addTargetSelect.value || 'queue';
            addTargetSelect.addEventListener('change', (e) => {
                currentTargetKey = e.target.value || 'queue';
                if (isParticlePathEnabled) recalculatePath();
            });
        }

        // Toggle switch for particle path animation
        const enableToggle = document.getElementById('particle-path-enable-toggle');
        if (enableToggle) {
            enableToggle.checked = isParticlePathEnabled;
            enableToggle.addEventListener('change', (e) => {
                setParticlePathEnabled(e.target.checked);
            });
        }

        // Listen for layout changes (grid drag/resize)
        const observer = new MutationObserver(() => {
            if (isParticlePathEnabled) recalculatePath();
        });
        const grid = document.getElementById('dashboard-grid');
        if (grid) {
            observer.observe(grid, { attributes: true, subtree: true, attributeFilter: ['style', 'class'] });
        }

        if (isParticlePathEnabled) {
            recalculatePath();
            startAnimation();
        } else {
            if (canvas) canvas.style.display = 'none';
        }

        isInitialized = true;
    }

    function setParticlePathEnabled(enabled) {
        isParticlePathEnabled = enabled;
        localStorage.setItem('particlePathEnabled', isParticlePathEnabled);
        if (enabled) {
            if (canvas) canvas.style.display = 'block';
            resizeCanvas();
            recalculatePath();
            startAnimation();
        } else {
            if (animationFrameId) {
                cancelAnimationFrame(animationFrameId);
                animationFrameId = null;
            }
            if (ctx && canvas) {
                ctx.clearRect(0, 0, canvas.width, canvas.height);
            }
            if (canvas) canvas.style.display = 'none';
        }
    }

    function handleResize() {
        resizeCanvas();
        recalculatePath();
    }

    function resizeCanvas() {
        if (!canvas) return;
        const parent = canvas.parentElement || document.body;
        const rect = parent.getBoundingClientRect();
        canvas.width = parent.scrollWidth || rect.width;
        canvas.height = parent.scrollHeight || rect.height;
    }

    function getCardRects() {
        const cards = Array.from(document.querySelectorAll('.card'));
        const canvasRect = canvas.getBoundingClientRect();
        const parentScrollTop = canvas.parentElement.scrollTop || 0;
        const parentScrollLeft = canvas.parentElement.scrollLeft || 0;

        return cards.map(card => {
            const r = card.getBoundingClientRect();
            return {
                id: card.id,
                element: card,
                left: r.left - canvasRect.left + parentScrollLeft,
                top: r.top - canvasRect.top + parentScrollTop,
                right: r.right - canvasRect.left + parentScrollLeft,
                bottom: r.bottom - canvasRect.top + parentScrollTop,
                width: r.width,
                height: r.height,
                cx: r.left - canvasRect.left + parentScrollLeft + r.width / 2,
                cy: r.top - canvasRect.top + parentScrollTop + r.height / 2
            };
        });
    }

    // Test d'intersection segment / rectangle (Liang-Barsky). Inchangé.
    function isSegmentIntersectingBox(p1, p2, box, padding = 8) {
        const minX = box.left - padding;
        const maxX = box.right + padding;
        const minY = box.top - padding;
        const maxY = box.bottom + padding;

        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;

        let t0 = 0;
        let t1 = 1;

        const p = [-dx, dx, -dy, dy];
        const q = [p1.x - minX, maxX - p1.x, p1.y - minY, maxY - p1.y];

        for (let i = 0; i < 4; i++) {
            if (p[i] === 0) {
                if (q[i] < 0) return true;
            } else {
                const r = q[i] / p[i];
                if (p[i] < 0) {
                    if (r > t1) return false;
                    if (r > t0) t0 = r;
                } else {
                    if (r < t0) return false;
                    if (r < t1) t1 = r;
                }
            }
        }

        return t0 < t1;
    }

    function hasClearLineOfSight(p1, p2, obstacles) {
        for (const obs of obstacles) {
            if (isSegmentIntersectingBox(p1, p2, obs, COLLISION_PADDING)) return false;
        }
        return true;
    }

    function clamp(v, min, max) {
        return Math.max(min, Math.min(max, v));
    }

    // Point du pourtour du rectangle le plus proche de (px, py). Contrairement à un
    // milieu de bord fixe, ce point peut se trouver n'importe où le long d'une arête,
    // y compris près d'un coin — ce qui permet au chemin de quitter/entrer une carte
    // par le côté qui fait réellement face à l'autre carte.
    function closestPointOnRect(rect, px, py) {
        const insideX = px > rect.left && px < rect.right;
        const insideY = py > rect.top && py < rect.bottom;

        if (insideX && insideY) {
            // Cas défensif : si le point de référence est à l'intérieur du rectangle
            // (cartes superposées), on le pousse vers le bord le plus proche.
            const distLeft = px - rect.left;
            const distRight = rect.right - px;
            const distTop = py - rect.top;
            const distBottom = rect.bottom - py;
            const minDist = Math.min(distLeft, distRight, distTop, distBottom);
            if (minDist === distLeft) return { x: rect.left, y: py };
            if (minDist === distRight) return { x: rect.right, y: py };
            if (minDist === distTop) return { x: px, y: rect.top };
            return { x: px, y: rect.bottom };
        }

        return {
            x: clamp(px, rect.left, rect.right),
            y: clamp(py, rect.top, rect.bottom)
        };
    }

    function isPointInsideAnyObstacle(pt, obstacles, padding) {
        return obstacles.some(obs =>
            pt.x > obs.left - padding && pt.x < obs.right + padding &&
            pt.y > obs.top - padding && pt.y < obs.bottom + padding
        );
    }

    // Points d'ancrage candidats sur le pourtour d'une carte : le point qui fait
    // directement face à l'autre carte, plus les quatre milieux de côté en solution
    // de repli. Le graphe de routage choisira ensuite, parmi toutes ces combinaisons,
    // celle qui donne le chemin le plus court et sans collision — le point de
    // connexion n'est donc jamais figé à un unique endroit.
    function getBoundaryCandidates(rect, towardRect, obstacles) {
        const raw = [
            closestPointOnRect(rect, towardRect.cx, towardRect.cy),
            { x: rect.cx, y: rect.top },
            { x: rect.cx, y: rect.bottom },
            { x: rect.left, y: rect.cy },
            { x: rect.right, y: rect.cy }
        ];

        const unique = [];
        raw.forEach(c => {
            if (!unique.some(u => Math.hypot(u.x - c.x, u.y - c.y) < 4)) {
                unique.push(c);
            }
        });

        const valid = unique.filter(c => !isPointInsideAnyObstacle(c, obstacles, 1));
        return valid.length > 0 ? valid : unique;
    }

    // Points de passage placés juste à l'extérieur des coins de chaque carte-obstacle,
    // utilisés pour faire contourner le chemin autour des cartes à éviter.
    function getValidObstacleCorners(obstacles) {
        const corners = [];
        obstacles.forEach((obs, idx) => {
            [
                { x: obs.left - CORNER_OFFSET, y: obs.top - CORNER_OFFSET },
                { x: obs.right + CORNER_OFFSET, y: obs.top - CORNER_OFFSET },
                { x: obs.left - CORNER_OFFSET, y: obs.bottom + CORNER_OFFSET },
                { x: obs.right + CORNER_OFFSET, y: obs.bottom + CORNER_OFFSET }
            ].forEach(pt => corners.push({ x: pt.x, y: pt.y, ownerIndex: idx }));
        });

        // On retire les coins qui tombent à l'intérieur d'une carte voisine (peut
        // arriver quand deux cartes sont très rapprochées) : ils seraient de toute
        // façon inutilisables puisque tout segment qui les traverse serait bloqué.
        return corners.filter(node => {
            for (let i = 0; i < obstacles.length; i++) {
                if (i === node.ownerIndex) continue;
                const obs = obstacles[i];
                if (node.x > obs.left - COLLISION_PADDING && node.x < obs.right + COLLISION_PADDING &&
                    node.y > obs.top - COLLISION_PADDING && node.y < obs.bottom + COLLISION_PADDING) {
                    return false;
                }
            }
            return true;
        });
    }

    // Construit un graphe de visibilité à partir des points d'ancrage de départ/arrivée
    // et de tous les coins d'obstacles, puis exécute Dijkstra pour trouver le plus court
    // chemin qui ne traverse jamais une carte. Retourne null si aucun chemin n'est trouvé.
    function findShortestObstacleAvoidingPath(startCandidates, endCandidates, obstacles) {
        const cornerNodes = getValidObstacleCorners(obstacles);

        const nodes = [];
        startCandidates.forEach(c => nodes.push({ x: c.x, y: c.y, type: 'start' }));
        endCandidates.forEach(c => nodes.push({ x: c.x, y: c.y, type: 'end' }));
        cornerNodes.forEach(c => nodes.push({ x: c.x, y: c.y, type: 'corner' }));

        const n = nodes.length;
        const dist = new Array(n).fill(Infinity);
        const prev = new Array(n).fill(-1);
        const visited = new Array(n).fill(false);

        nodes.forEach((node, i) => {
            if (node.type === 'start') dist[i] = 0;
        });

        // Dijkstra en O(n²) : largement suffisant vu le nombre de cartes du dashboard.
        for (let iter = 0; iter < n; iter++) {
            let u = -1;
            let best = Infinity;
            for (let i = 0; i < n; i++) {
                if (!visited[i] && dist[i] < best) {
                    best = dist[i];
                    u = i;
                }
            }
            if (u === -1) break;
            visited[u] = true;

            // Premier nœud "end" extrait = chemin le plus court garanti (poids positifs).
            if (nodes[u].type === 'end') {
                const path = [];
                let cur = u;
                while (cur !== -1) {
                    path.unshift({ x: nodes[cur].x, y: nodes[cur].y });
                    cur = prev[cur];
                }
                return path;
            }

            for (let v = 0; v < n; v++) {
                if (visited[v] || v === u || nodes[v].type === 'start') continue;
                if (!hasClearLineOfSight(nodes[u], nodes[v], obstacles)) continue;
                const d = dist[u] + Math.hypot(nodes[u].x - nodes[v].x, nodes[u].y - nodes[v].y);
                if (d < dist[v]) {
                    dist[v] = d;
                    prev[v] = u;
                }
            }
        }

        return null;
    }

    function recalculatePath() {
        if (!canvas) return;

        const sourceCard = document.getElementById('search-card');
        const targetId = TARGET_MAP[currentTargetKey] || 'queue-card';
        const targetCard = document.getElementById(targetId);

        if (!sourceCard || !targetCard || sourceCard === targetCard) {
            pathPoints = [];
            particles = [];
            return;
        }

        const allRects = getCardRects();
        const sourceRect = allRects.find(r => r.id === 'search-card');
        const targetRect = allRects.find(r => r.id === targetId);

        if (!sourceRect || !targetRect) {
            pathPoints = [];
            return;
        }

        const obstacles = allRects.filter(r => r.id !== sourceRect.id && r.id !== targetRect.id);

        const startCandidates = getBoundaryCandidates(sourceRect, targetRect, obstacles);
        const endCandidates = getBoundaryCandidates(targetRect, sourceRect, obstacles);

        let rawPath = findShortestObstacleAvoidingPath(startCandidates, endCandidates, obstacles);

        if (!rawPath || rawPath.length < 2) {
            // Filet de sécurité ultime (ex : cartes collées sans aucun espace) pour
            // toujours afficher un tracé, même si aucune route totalement dégagée
            // n'a pu être trouvée.
            const s = closestPointOnRect(sourceRect, targetRect.cx, targetRect.cy);
            const e = closestPointOnRect(targetRect, sourceRect.cx, sourceRect.cy);
            rawPath = [s, e];
        }

        pathPoints = smoothPolyline(rawPath);

        spawnParticles();
    }

    // Ré-échantillonne le tracé en points régulièrement espacés (par longueur d'arc)
    // pour que les particules avancent à vitesse visuelle constante le long du chemin.
    function smoothPolyline(pts) {
        if (pts.length <= 2) return pts;

        const smoothed = [];
        const numSamples = 60;

        let totalLen = 0;
        const segmentLengths = [];
        for (let i = 0; i < pts.length - 1; i++) {
            const len = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
            segmentLengths.push(len);
            totalLen += len;
        }

        if (totalLen === 0) return pts;

        for (let i = 0; i <= numSamples; i++) {
            const targetDist = (i / numSamples) * totalLen;
            let currentDist = 0;

            for (let j = 0; j < segmentLengths.length; j++) {
                const segLen = segmentLengths[j];
                if (currentDist + segLen >= targetDist || j === segmentLengths.length - 1) {
                    const t = segLen > 0 ? (targetDist - currentDist) / segLen : 0;
                    const p1 = pts[j];
                    const p2 = pts[j + 1];
                    smoothed.push({
                        x: p1.x + (p2.x - p1.x) * t,
                        y: p1.y + (p2.y - p1.y) * t
                    });
                    break;
                }
                currentDist += segLen;
            }
        }

        return smoothed;
    }

    function spawnParticles() {
        particles = [];
        if (pathPoints.length < 2) return;

        const count = 35;
        for (let i = 0; i < count; i++) {
            particles.push({
                progress: Math.random(),
                speed: 0.003 + Math.random() * 0.004,
                size: 2.5 + Math.random() * 3.5,
                alpha: 0.3 + Math.random() * 0.7,
                offset: (Math.random() - 0.5) * 6
            });
        }
    }

    function startAnimation() {
        if (animationFrameId) cancelAnimationFrame(animationFrameId);
        if (!isParticlePathEnabled) return;

        function render() {
            if (!isParticlePathEnabled) {
                if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height);
                return;
            }
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            if (pathPoints.length >= 2) {
                const currentStyle = document.documentElement.getAttribute('data-style') || 'glassmorphism';
                drawParticlePath(currentStyle);
            }

            animationFrameId = requestAnimationFrame(render);
        }

        render();
    }

    function getInterpolatedPoint(progress) {
        if (pathPoints.length < 2) return { x: 0, y: 0 };
        const clampedProgress = Math.max(0, Math.min(1, progress));
        const index = clampedProgress * (pathPoints.length - 1);
        const i1 = Math.floor(index);
        const i2 = Math.min(pathPoints.length - 1, i1 + 1);
        const t = index - i1;

        const p1 = pathPoints[i1];
        const p2 = pathPoints[i2];

        return {
            x: p1.x + (p2.x - p1.x) * t,
            y: p1.y + (p2.y - p1.y) * t
        };
    }

    function drawParticlePath(style) {
        ctx.beginPath();
        ctx.moveTo(pathPoints[0].x, pathPoints[0].y);
        for (let i = 1; i < pathPoints.length; i++) {
            ctx.lineTo(pathPoints[i].x, pathPoints[i].y);
        }
        ctx.lineWidth = 1.5;

        let strokeStyle = 'rgba(168, 85, 247, 0.2)';
        let particleColors = ['#a855f7', '#06b6d4', '#ec4899'];
        let shadowColor = 'rgba(168, 85, 247, 0.8)';

        if (style === 'neon-cyberpunk') {
            strokeStyle = 'rgba(0, 243, 255, 0.25)';
            particleColors = ['#00f3ff', '#ff0055', '#39ff14'];
            shadowColor = '#00f3ff';
        } else if (style === 'minimalist') {
            strokeStyle = 'rgba(226, 232, 240, 0.2)';
            particleColors = ['#e2e8f0', '#ffffff', '#cbd5e1'];
            shadowColor = 'rgba(255, 255, 255, 0.5)';
        } else if (style === 'retro-synthwave') {
            strokeStyle = 'rgba(255, 113, 206, 0.25)';
            particleColors = ['#ff71ce', '#01cdfe', '#fdbb2d'];
            shadowColor = '#ff71ce';
        }

        ctx.strokeStyle = strokeStyle;
        ctx.stroke();

        particles.forEach((p, idx) => {
            p.progress += p.speed;
            if (p.progress > 1) {
                p.progress = 0;
            }

            const pt = getInterpolatedPoint(p.progress);
            const color = particleColors[idx % particleColors.length];

            ctx.save();
            ctx.shadowColor = shadowColor;
            ctx.shadowBlur = (style === 'minimalist') ? 4 : 10;
            ctx.globalAlpha = p.alpha * Math.sin(p.progress * Math.PI);

            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(pt.x + p.offset, pt.y + p.offset, p.size, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        });
    }

    window.MusicPlayer.ParticlePath = {
        init,
        recalculatePath: function() {
            if (isParticlePathEnabled) recalculatePath();
        },
        setTarget: function (targetKey) {
            currentTargetKey = targetKey;
            if (isParticlePathEnabled) recalculatePath();
        },
        setEnabled: setParticlePathEnabled,
        isEnabled: function() { return isParticlePathEnabled; }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();