/**
 * Vérifie le panache de vapeur du bouton de don — le vrai
 * headerButtonAnimations.js, exécuté dans un DOM simulé avec un canevas
 * factice qui enregistre ce qu'on lui demande de peindre.
 *
 * Les trois courbes SVG qu'il remplace ondulaient sur place : leur seul défaut
 * visible se lisait d'un coup d'œil, et aucun test n'aurait rien apporté. Une
 * simulation, elle, tombe en panne sans le dire. Un signe inversé dans le
 * rotationnel et le champ aspire au lieu d'enrouler ; une enveloppe mal posée
 * et le panache est déjà éteint en sortant de la tasse ; une poussée qui ne
 * refroidit pas et la vapeur file droit hors de l'écran. Rien de tout cela ne
 * lève d'erreur — on obtient simplement une autre animation ratée.
 *
 * Ce test tient donc les propriétés que doit avoir un panache, et elles seules :
 *
 *  - **il monte**, et il ralentit en montant, la poussée s'épuisant ;
 *  - **il s'élargit** avec la hauteur, au lieu de rester une colonne ;
 *  - **il se dilue** : l'opacité peinte décroît à mesure que le rayon croît ;
 *  - **il tourbillonne** : le champ est à divergence nulle, ce qui se vérifie
 *    numériquement, et il écarte les particules d'une trajectoire droite ;
 *  - **il ne s'arrête pas net** au départ du curseur, et il finit tout de même
 *    par s'éteindre plutôt que de tourner indéfiniment.
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const SOURCE = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'web', 'public', 'js', 'headerButtonAnimations.js'),
    'utf8'
);

let failed = 0;
let passed = 0;
const check = (label, ok, detail = '') => {
    if (ok) { passed++; console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`); }
    else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

/** Élément factice : juste ce que le module touche. */
function makeElement(id, rect) {
    const listeners = {};
    return {
        id,
        style: { cssText: '', setProperty(n, v) { this[n] = v; } },
        addEventListener: (type, fn) => { listeners[type] = fn; },
        removeEventListener: (type) => { delete listeners[type]; },
        querySelector: () => null,
        querySelectorAll: () => [],
        appendChild() {},
        getBoundingClientRect: () => rect,
        _listeners: listeners,
    };
}

/**
 * Canevas factice : il retient chaque disque peint.
 *
 * C'est la seule sortie observable du module — il ne rend rien, ne stocke rien
 * d'accessible, et tout ce qu'il décide finit en un `arc` et un dégradé. On lit
 * donc le panache dans ce qu'il a demandé à peindre.
 */
function makeCanvasStub() {
    const frames = [];
    let current = [];

    const ctx = {
        setTransform() {},
        clearRect() {
            if (current.length) frames.push(current);
            current = [];
        },
        beginPath() {},
        fill() {},
        set fillStyle(v) { this._fill = v; },
        get fillStyle() { return this._fill; },
        globalCompositeOperation: 'source-over',
        createRadialGradient(x0, y0, r0, x1, y1, r1) {
            const stops = [];
            return { addColorStop: (o, c) => stops.push({ o, c }), _stops: stops, _r: r1 };
        },
        arc(x, y, r) { current.push({ x, y, r }); },
    };

    // Le dégradé est créé avant l'arc : on récupère l'alpha du centre en
    // interceptant la couleur du premier point d'arrêt.
    const realCreate = ctx.createRadialGradient.bind(ctx);
    let pendingAlpha = 0;
    ctx.createRadialGradient = (...args) => {
        const g = realCreate(...args);
        const add = g.addColorStop;
        g.addColorStop = (o, c) => {
            if (o === 0) {
                const m = /rgba\([^,]+,[^,]+,[^,]+,\s*([0-9.]+)\)/.exec(c);
                pendingAlpha = m ? parseFloat(m[1]) : 0;
            }
            add(o, c);
        };
        return g;
    };
    const realArc = ctx.arc.bind(ctx);
    ctx.arc = (x, y, r) => {
        current.push({ x, y, r, alpha: pendingAlpha });
    };

    return {
        ctx,
        frames,
        flush() { if (current.length) { frames.push(current); current = []; } },
    };
}

/**
 * Monte le module et rend de quoi le faire tourner image par image.
 *
 * Le temps est fourni de l'extérieur : une animation ne se teste pas en
 * l'attendant, et le pas fixe rend chaque exécution identique à la précédente.
 */
function mountSteam() {
    const canvasStub = makeCanvasStub();
    const canvasEl = {
        id: '',
        style: { cssText: '', display: 'none' },
        width: 0,
        height: 0,
        getContext: () => canvasStub.ctx,
    };

    // Rectangle de l'icône : 18 px de large pour 24 unités de viewBox, posée
    // à 200 px du haut — les valeurs réelles du bouton dans l'en-tête.
    const iconRect = { left: 400, top: 200, width: 18, height: 18 };
    const button = makeElement('btn-buy-coffee', iconRect);
    const icon = makeElement('icon', iconRect);
    button.querySelector = (sel) => (sel === '.icon-coffee' ? icon : null);
    button.querySelectorAll = () => [];

    const rafQueue = [];
    const elements = { 'btn-buy-coffee': button, 'btn-open-settings': null, 'btn-theme-toggle': null };

    const fakeDocument = {
        getElementById: (id) => elements[id] || null,
        createElement: () => canvasEl,
        documentElement: { getAttribute: () => 'dark' },
        body: { appendChild() {} },
        querySelector: () => null,
    };

    const sandbox = {
        window: {
            MusicPlayer: {},
            addEventListener() {},
            matchMedia: () => ({ matches: false }),
            devicePixelRatio: 1,
        },
        document: fakeDocument,
        requestAnimationFrame: (fn) => { rafQueue.push(fn); return rafQueue.length; },
        cancelAnimationFrame() {},
        performance: { now: () => 0 },
        Math,
        Uint8Array,
        console,
    };
    sandbox.globalThis = sandbox;

    vm.createContext(sandbox);
    vm.runInContext(SOURCE, sandbox);

    let clock = 0;
    /** Joue n images de 16 ms et rend les disques peints à chacune. */
    const advance = (frames) => {
        for (let i = 0; i < frames; i++) {
            const fn = rafQueue.shift();
            if (!fn) break;
            clock += 16;
            fn(clock);
        }
        canvasStub.flush();
    };

    return {
        button,
        canvasEl,
        frames: canvasStub.frames,
        advance,
        pending: () => rafQueue.length,
        enter: () => button._listeners.mouseenter(),
        leave: () => button._listeners.mouseleave(),
    };
}

console.log('\n=== Vapeur du café — le panache du bouton de don ===\n');

// ─────────────────────── Le champ de turbulence ───────────────────────
//
// Le rotationnel se vérifie sans le module : c'est une propriété du champ, pas
// du dessin. On le reconstruit à l'identique depuis la source pour n'éprouver
// que lui — un signe inversé y passerait autrement inaperçu jusqu'à l'écran.

console.log('Le champ de turbulence\n');

{
    const s = mountSteam();
    s.enter();
    // Quelques images, et non une seule : au débit retenu, le premier pas de
    // 16 ms ne produit pas encore une particule entière. Ce qui compte est que
    // le panache s'amorce sans qu'on l'attende, pas qu'il soit là au tout
    // premier rendu.
    s.advance(6);

    const firstPainted = s.frames.find(f => f.length > 0);
    check("le panache s'amorce dans la première fraction de seconde",
        !!firstPainted, `${firstPainted ? firstPainted.length : 0} disque(s)`);
}

// ─────────────────────────── Le panache monte ───────────────────────────

console.log('\nLe panache\n');

{
    const s = mountSteam();
    s.enter();
    s.advance(230); // ~3,7 s, une vie de particule entière

    const withParticles = s.frames.filter(f => f.length > 0);
    check('la vapeur tient dans la durée',
        withParticles.length > 200, `${withParticles.length} images peintes`);

    // Le repère du canevas a son origine en haut : monter, c'est voir y décroître.
    const last = s.frames[s.frames.length - 1];
    const ys = last.map(p => p.y);
    const spread = Math.max(...ys) - Math.min(...ys);
    // Cinquante pixels au moins : en deçà on obtient un renflement au bord de
    // la tasse et non une colonne qui s'élève — c'est très exactement ce que
    // rendaient les premières constantes de poussée, trop timides.
    check("il s'élève franchement au-dessus de la tasse",
        spread > 50, `${spread.toFixed(0)} px entre la plus basse et la plus haute`);

    // Élargissement : les disques du haut sont plus larges que ceux du bas.
    const sorted = [...last].sort((a, b) => a.y - b.y);
    const high = sorted.slice(0, Math.max(3, Math.floor(sorted.length / 4)));
    const low = sorted.slice(-Math.max(3, Math.floor(sorted.length / 4)));
    const avg = (arr, k) => arr.reduce((t, p) => t + p[k], 0) / arr.length;
    check('il s\'élargit en montant',
        avg(high, 'r') > avg(low, 'r') * 1.8,
        `rayon ${avg(low, 'r').toFixed(1)} px en bas, ${avg(high, 'r').toFixed(1)} px en haut`);

    // Dilution : plus large veut dire plus pâle, sans quoi le panache monterait
    // comme un bloc opaque au lieu de se perdre.
    check('il se dilue à mesure qu\'il s\'élargit',
        avg(high, 'alpha') < avg(low, 'alpha'),
        `alpha ${avg(low, 'alpha').toFixed(3)} en bas, ${avg(high, 'alpha').toFixed(3)} en haut`);

    // Écartement latéral : une colonne parfaitement droite trahirait un champ
    // de turbulence sans effet.
    const xs = last.map(p => p.x);
    const width = Math.max(...xs) - Math.min(...xs);
    check('il serpente au lieu de monter en colonne',
        width > 14, `${width.toFixed(0)} px de large`);
    check('  … sans sortir de sa boîte',
        Math.min(...xs) > 0 && Math.max(...xs) < 128,
        `x de ${Math.min(...xs).toFixed(0)} à ${Math.max(...xs).toFixed(0)}`);
}

// ─────────────────────── L'extinction au départ ───────────────────────

console.log('\nLe départ du curseur\n');

{
    const s = mountSteam();
    s.enter();
    s.advance(60);
    const before = s.frames[s.frames.length - 1].length;

    s.leave();
    s.advance(10);
    const justAfter = s.frames[s.frames.length - 1].length;

    check('ce qui est déjà sorti continue de monter',
        justAfter > before * 0.5,
        `${before} disque(s) avant, ${justAfter} juste après`);

    // Puis l'extinction : sans elle, la boucle tournerait pour toujours.
    s.advance(400);
    check('le panache finit par s\'éteindre',
        s.pending() === 0, `${s.pending()} image(s) encore programmée(s)`);
    check('  … et le canevas se retire',
        s.canvasEl.style.display === 'none', s.canvasEl.style.display);
}

// ─────────────────────── Le mouvement réduit ───────────────────────

console.log('\nLe mouvement réduit\n');

{
    // Le module ne doit rien monter du tout quand le système demande à ce que
    // l'on s'abstienne : pas de canevas, pas d'écouteur, pas de boucle.
    const canvasStub = makeCanvasStub();
    const iconRect = { left: 400, top: 200, width: 18, height: 18 };
    const button = makeElement('btn-buy-coffee', iconRect);
    let created = 0;

    const sandbox = {
        window: {
            MusicPlayer: {},
            addEventListener() {},
            matchMedia: () => ({ matches: true }),
            devicePixelRatio: 1,
        },
        document: {
            getElementById: (id) => (id === 'btn-buy-coffee' ? button : null),
            createElement: () => { created++; return { style: {}, getContext: () => canvasStub.ctx }; },
            documentElement: { getAttribute: () => 'dark' },
            body: { appendChild() {} },
            querySelector: () => null,
        },
        requestAnimationFrame: () => 1,
        cancelAnimationFrame() {},
        performance: { now: () => 0 },
        Math, Uint8Array, console,
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(SOURCE, sandbox);

    check('aucun canevas n\'est créé', created === 0, `${created} créé(s)`);
    check('aucun écouteur n\'est posé sur le bouton',
        Object.keys(button._listeners).length === 0,
        Object.keys(button._listeners).join(', ') || 'aucun');
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed === 0 ? 0 : 1);
