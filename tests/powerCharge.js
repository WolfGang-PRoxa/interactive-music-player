/**
 * Vérifie l'amorçage du bouton d'alimentation — le vrai
 * headerButtonAnimations.js, exécuté dans un DOM simulé.
 *
 * Le propos de cette animation n'est pas décoratif. Ce bouton éteint le bot, et
 * l'animation doit accuser le survol sans le récompenser : le glyphe se met
 * sous tension, il ne s'amuse pas. Deux choses portent tout le sens, et aucune
 * des deux ne se voit dans un diff.
 *
 *  - **L'anneau s'allume par ses deux bouts à la fois.** Ses extrémités sont
 *    les deux lèvres de la coupure du symbole, là où la barre entre : deux
 *    lueurs qui en partent et se rejoignent en bas se lisent comme un circuit
 *    qui se ferme. Un simple décalage de tiret aurait fait courir une seule
 *    lueur dans un sens, ce qui se lit comme une roue qui tourne — un
 *    chargement, une attente, tout autre chose. C'est plus simple à écrire, et
 *    c'est le piège dans lequel une réécriture distraite retomberait.
 *
 *  - **Le repos est rendu à la feuille de style**, pas reposé à la main. Le
 *    script retire ses déclarations en ligne au lieu d'écrire « opacity: 0 »,
 *    sans quoi le glyphe garderait l'empreinte de son animation.
 *
 * Le reste tient l'ordre des choses : le courant remonte la barre avant que
 * l'anneau ne finisse, et la boucle une fois fermée respire au lieu de rester
 * figée.
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(
    path.join(ROOT, 'src', 'web', 'public', 'js', 'headerButtonAnimations.js'),
    'utf8'
);
const MARKUP = fs.readFileSync(
    path.join(ROOT, 'src', 'web', 'public', 'index.html'),
    'utf8'
);
const CSS = fs.readFileSync(
    path.join(ROOT, 'src', 'web', 'public', 'css', 'modals.css'),
    'utf8'
);

let failed = 0;
let passed = 0;
const check = (label, ok, detail = '') => {
    if (ok) { passed++; console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`); }
    else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

/** Élément factice, dont on relit le style en ligne. */
function makeElement(id, totalLength) {
    const listeners = {};
    const el = {
        id,
        style: {},
        addEventListener: (type, fn) => { listeners[type] = fn; },
        removeEventListener: (type) => { delete listeners[type]; },
        setAttribute() {},
        getAttribute: () => undefined,
        removeAttribute() {},
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 18, height: 18 }),
        querySelector: () => null,
        querySelectorAll: () => [],
        appendChild() {},
        _listeners: listeners,
    };
    if (totalLength) el.getTotalLength = () => totalLength;
    return el;
}

/** Les trois nombres d'un « stroke-dasharray », ou null. */
function dashes(value) {
    if (!value) return null;
    return value.trim().split(/[\s,]+/).map(Number);
}

function mountPower({ reduced = false } = {}) {
    // Longueurs réelles du glyphe : la barre va de 12,2 à 12,12 ; l'anneau est
    // un arc de rayon 9 sur 270°.
    const RING_LENGTH = 2 * Math.PI * 9 * 0.75;
    const BAR_LENGTH = 10;

    const ring = makeElement('ring', RING_LENGTH);
    const bar = makeElement('bar', BAR_LENGTH);
    const button = makeElement('btn-restart-bot');
    button.querySelector = (sel) => {
        if (sel === '.power-charge-ring') return ring;
        if (sel === '.power-charge-bar') return bar;
        return null;
    };

    const rafQueue = [];
    const canvasStub = {
        style: {}, width: 0, height: 0,
        getContext: () => ({
            setTransform() {}, clearRect() {}, beginPath() {}, fill() {}, arc() {},
            createRadialGradient: () => ({ addColorStop() {} }),
        }),
    };

    const sandbox = {
        window: {
            MusicPlayer: {},
            addEventListener() {},
            matchMedia: () => ({ matches: reduced }),
            devicePixelRatio: 1,
        },
        document: {
            getElementById: (id) => (id === 'btn-restart-bot' ? button : null),
            createElement: () => canvasStub,
            documentElement: { getAttribute: () => 'dark' },
            body: { appendChild() {} },
            querySelector: () => null,
        },
        requestAnimationFrame: (fn) => { rafQueue.push(fn); return rafQueue.length; },
        cancelAnimationFrame() {},
        performance: { now: () => 0 },
        Math, Uint8Array, console,
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(SOURCE, sandbox);

    let clock = 0;
    const advance = (frames) => {
        for (let i = 0; i < frames; i++) {
            const fn = rafQueue.shift();
            if (!fn) break;
            clock += 16;
            fn(clock);
        }
    };

    return {
        ring, bar, button, advance,
        RING_LENGTH, BAR_LENGTH,
        pending: () => rafQueue.length,
        enter: () => button._listeners.mouseenter(),
        leave: () => button._listeners.mouseleave(),
    };
}

console.log('\n=== Le bouton d’alimentation — l’amorçage du circuit ===\n');

// ───────────────────── Les calques et leur repos ─────────────────────

console.log('Les calques lumineux\n');

{
    const ring = /<path class="power-charge power-charge-ring" d="([^"]+)"/.exec(MARKUP);
    const bar = /<line class="power-charge power-charge-bar" ([^/>]+)\/?>/.exec(MARKUP);
    const baseRing = /<path d="(M18\.36 6\.64[^"]+)"><\/path>/.exec(MARKUP);

    check('l’anneau lumineux existe', !!ring);
    check('la barre lumineuse existe', !!bar);

    /*
     * L'invariant : la lueur doit suivre le glyphe, pas dessiner une seconde
     * forme. Un écart d'un centième entre la copie et l'original la ferait
     * passer à côté du trait qu'elle est censée allumer — ce qui, à dix-huit
     * pixels, se verrait comme un flou et non comme un décalage.
     */
    if (ring && baseRing) {
        check('l’anneau lumineux est la copie exacte du glyphe',
            ring[1] === baseRing[1], ring[1] === baseRing[1] ? ring[1] : `${ring[1]} ≠ ${baseRing[1]}`);
    }
    if (bar) {
        check('la barre lumineuse est la copie exacte du glyphe',
            /x1="12"\s+y1="2"\s+x2="12"\s+y2="12"/.test(bar[1]), bar[1].trim());
    }

    // Sans script, rien ne doit apparaître : le repos est dans la feuille de
    // style, et lui seul.
    const rule = /\.danger-power-btn \.power-charge \{([^}]+)\}/.exec(CSS);
    check('la feuille de style les laisse éteints', !!rule && /opacity:\s*0\s*;/.test(rule[1]),
        rule ? 'opacity: 0' : 'règle absente');
    check('  … et hors de portée du curseur',
        !!rule && /pointer-events:\s*none/.test(rule[1]));
}

// ───────────────────── L'anneau se ferme par ses deux bouts ─────────────────────

console.log('\nL’anneau\n');

{
    const s = mountPower();
    s.enter();
    s.advance(50); // ~0,8 s : la boucle vient de se fermer

    const d = dashes(s.ring.style.strokeDasharray);
    check('l’anneau porte un motif à trois tirets', !!d && d.length === 3,
        s.ring.style.strokeDasharray || 'aucun');

    if (d && d.length === 3) {
        /*
         * Le cœur du test. « p, L−2p, p » allume les deux extrémités du tracé
         * et laisse le milieu vide ; un motif à deux nombres, ou trois nombres
         * dont les extrêmes diffèrent, trahirait une lueur unique qui court
         * dans un sens.
         */
        check('ses deux extrémités s’allument de la même longueur',
            Math.abs(d[0] - d[2]) < 0.01, `${d[0]} et ${d[2]}`);
        check('le total reste la longueur de l’anneau',
            Math.abs(d[0] + d[1] + d[2] - s.RING_LENGTH) < 0.02,
            `${(d[0] + d[1] + d[2]).toFixed(3)} pour ${s.RING_LENGTH.toFixed(3)}`);
        check('la boucle est fermée : plus de vide au milieu',
            d[1] < 0.01, `${d[1]} unité(s) d’écart restant`);
    }
}

{
    // Le remplissage progresse, et le vide central se referme.
    const s = mountPower();
    s.enter();

    const gapAt = (frames) => {
        s.advance(frames);
        const d = dashes(s.ring.style.strokeDasharray);
        return d && d.length === 3 ? d[1] : NaN;
    };

    const early = gapAt(20);   // ~0,32 s
    const mid = gapAt(10);     // ~0,48 s
    const late = gapAt(15);    // ~0,72 s

    check('le vide central se referme au fil du temps',
        early > mid && mid > late,
        `${early.toFixed(1)} → ${mid.toFixed(1)} → ${late.toFixed(1)}`);
}

// ───────────────────── L'ordre : la barre, puis l'anneau ─────────────────────

console.log('\nL’ordre du parcours\n');

{
    const s = mountPower();
    s.enter();
    s.advance(14); // ~0,22 s : la barre est bien engagée, l’anneau démarre à peine

    const barDash = dashes(s.bar.style.strokeDasharray);
    const ringDash = dashes(s.ring.style.strokeDasharray);
    const barFilled = barDash ? barDash[0] / s.BAR_LENGTH : 0;
    const ringFilled = ringDash ? (ringDash[0] + ringDash[2]) / s.RING_LENGTH : 0;

    check('la barre est déjà largement parcourue', barFilled > 0.7,
        `${(barFilled * 100).toFixed(0)} %`);
    check('  … quand l’anneau n’a presque rien reçu', ringFilled < 0.2,
        `${(ringFilled * 100).toFixed(0)} %`);

    s.advance(40);
    const barLate = dashes(s.bar.style.strokeDasharray);
    check('la barre finit pleine', barLate && Math.abs(barLate[0] - s.BAR_LENGTH) < 0.05,
        `${barLate ? barLate[0] : '?'} pour ${s.BAR_LENGTH}`);
}

// ───────────────────── La respiration une fois chargé ─────────────────────

console.log('\nLa respiration\n');

{
    const s = mountPower();
    s.enter();
    s.advance(60); // circuit fermé

    const samples = [];
    for (let i = 0; i < 200; i++) {
        s.advance(1);
        samples.push(Number(s.ring.style.opacity));
    }

    const min = Math.min(...samples);
    const max = Math.max(...samples);
    check('la lueur respire au lieu de rester figée', max - min > 0.05,
        `de ${min.toFixed(3)} à ${max.toFixed(3)}`);
    check('  … sans jamais s’éteindre ni dépasser le plein',
        min > 0.6 && max <= 1.001, `${min.toFixed(3)} … ${max.toFixed(3)}`);
}

// ───────────────────── Le départ du curseur ─────────────────────

console.log('\nLe départ du curseur\n');

{
    const s = mountPower();
    s.enter();
    s.advance(60);
    check('le glyphe est allumé', Number(s.ring.style.opacity) > 0.6,
        s.ring.style.opacity);

    s.leave();
    s.advance(10);
    check('la lueur ne disparaît pas d’un coup',
        Number(s.ring.style.opacity) > 0.3, s.ring.style.opacity);

    s.advance(60);
    check('elle finit par s’éteindre', s.ring.style.opacity === '',
        s.ring.style.opacity === '' ? 'rendue à la feuille de style' : s.ring.style.opacity);
    check('  … et le motif de tirets est retiré, non remis à zéro',
        s.ring.style.strokeDasharray === '' && s.bar.style.strokeDasharray === '',
        `anneau « ${s.ring.style.strokeDasharray} », barre « ${s.bar.style.strokeDasharray} »`);
    check('  … et la boucle s’arrête', s.pending() === 0,
        `${s.pending()} image(s) programmée(s)`);
}

// ───────────────────── Le mouvement réduit ─────────────────────

console.log('\nLe mouvement réduit\n');

{
    const s = mountPower({ reduced: true });
    check('aucun écouteur n’est posé sur le bouton',
        Object.keys(s.button._listeners).length === 0,
        Object.keys(s.button._listeners).join(', ') || 'aucun');
    check('les calques restent tels que la feuille de style les laisse',
        s.ring.style.opacity === undefined && s.ring.style.strokeDasharray === undefined);
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed === 0 ? 0 : 1);
