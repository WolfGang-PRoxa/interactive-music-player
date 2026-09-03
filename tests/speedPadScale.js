/**
 * Vérifie quand la roulette de vitesse joue son animation de bascule.
 *
 * Le pad propose trois échelles : classique, pas de 0,05, pas de 0,01. Changer
 * d'échelle fait rebondir les graduations depuis la valeur retenue, d'autant
 * plus tard qu'elles en sont éloignées.
 *
 * Cette animation a un objet précis : montrer d'où la valeur est partie et où
 * elle a atterri, quand l'échelle demandée ne la contient pas et que le pad se
 * rabat sur la plus proche. Les trois échelles s'emboîtant — les pas de 0,05
 * contiennent les valeurs classiques, ceux de 0,01 contiennent les deux
 * autres —, monter en précision ne perd jamais rien : c'est en redescendant que
 * 1,37 disparaît.
 *
 * Elle se jouait pourtant à chaque bascule, y compris les trois sur quatre où
 * rien ne bouge. Elle annonçait alors un déplacement qui n'avait pas eu lieu.
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const SOURCE = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'web', 'public', 'js', 'speedPad.js'), 'utf8');

let failed = 0;
let passed = 0;
const check = (label, ok, detail = '') => {
    if (ok) { passed++; console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`); }
    else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

/** Élément factice, avec la mémoire de ses classes. */
function el(tag = 'div') {
    const classes = new Set();
    return {
        tagName: tag.toUpperCase(),
        dataset: {},
        style: {},
        children: [],
        textContent: '',
        /*
         * Vider `innerHTML` vide les enfants, comme dans un vrai document.
         *
         * C'est ainsi que la piste se remet à zéro avant d'être repeinte. Sans
         * ce comportement, les graduations des trois échelles s'empilaient, et
         * chercher une valeur y trouvait celle d'une échelle précédente — sans
         * retard d'animation, ce qui faisait passer la vérification pour de
         * mauvaises raisons.
         */
        get innerHTML() { return this._html || ''; },
        set innerHTML(v) {
            this._html = v;
            if (v === '') this.children = [];
        },
        offsetHeight: 0,
        classList: {
            add: (...n) => n.forEach(c => classes.add(c)),
            remove: (...n) => n.forEach(c => classes.delete(c)),
            contains: (c) => classes.has(c),
        },
        appendChild(child) { this.children.push(child); return child; },
    };
}

/**
 * Monte le pad avec son vrai `rebuildSpeedPadTrack`.
 *
 * L'horloge est tenue par le test : le module refuse deux bascules à moins de
 * 300 ms, et des clics envoyés dans la même milliseconde ne passeraient pas.
 */
function mount() {
    let clock = 1_000_000;

    const indicator = el();
    const container = el();
    const track = el();

    const clicks = [];
    const timeouts = [];

    const fakeDocument = {
        getElementById: (id) => ({
            'speed-pad-indicator': indicator,
            'speed-pad-container': container,
            'speed-pad-track': track,
        }[id] || null),
        createElement: (tag) => el(tag),
        querySelectorAll: () => [],
        addEventListener: (type, fn) => { if (type === 'click') clicks.push(fn); },
    };

    const fakeWindow = { addEventListener() {}, document: fakeDocument };
    const sandbox = {
        window: fakeWindow,
        document: fakeDocument,
        console: { log() {} },
        Date: { now: () => clock },
        setTimeout: (fn, ms) => { timeouts.push({ fn, ms }); return timeouts.length; },
        clearTimeout: () => {},
        Math,
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(SOURCE, sandbox);

    const MP = fakeWindow.MusicPlayer;
    // Le recalage de l'aiguille touche un DOM que ce test ne simule pas, et
    // n'est pas le sujet : seule la reconstruction de la piste l'est.
    MP.updateSpeedPad = () => {};
    MP.sendSpeedUpdate = () => {};

    return {
        MP, track, indicator, timeouts,
        /** Un clic sur l'indicateur d'échelle, 400 ms après le précédent. */
        toggleScale() {
            clock += 400;
            const target = { closest: (sel) => (sel === '.speed-pad-indicator' ? indicator : null) };
            clicks.forEach(fn => fn({ target, stopPropagation() {} }));
        },
        /** L'animation est-elle en cours sur la piste ? */
        bouncing: () => track.classList.contains('switching'),
        /** Les graduations peintes, et leur retard d'animation. */
        steps: () => track.children.map(c => ({
            speed: c.dataset.speed, delay: c.style.animationDelay,
        })),
    };
}

console.log('\n=== Bascule d’échelle de la roulette de vitesse ===\n');

// ─────────────────── Monter en précision ne perd rien ───────────────────

console.log('Quand la valeur survit à la bascule\n');

{
    const s = mount();
    s.MP.currentSpeed = '1.00';

    s.toggleScale();   // classique → pas de 0,05
    check('classique → 0,05 : la valeur est conservée',
        s.MP.currentSpeed === '1.00', s.MP.currentSpeed);
    check('  … donc aucune animation',
        !s.bouncing(), s.bouncing() ? 'switching posée' : 'aucune');

    s.toggleScale();   // 0,05 → pas de 0,01
    check('0,05 → 0,01 : la valeur est conservée',
        s.MP.currentSpeed === '1.00', s.MP.currentSpeed);
    check('  … donc aucune animation',
        !s.bouncing(), s.bouncing() ? 'switching posée' : 'aucune');

    // Sans animation, aucun retard n'est posé sur les graduations : c'est la
    // seconde moitié de l'effet, et elle ne doit pas traîner non plus.
    check('  … ni de retard sur les graduations',
        s.steps().every(v => !v.delay), JSON.stringify(s.steps().slice(0, 3)));

    // 1,00 est bien resté visible : c'est ce qui rendait l'animation inutile.
    check('  … la valeur restant présente dans l’échelle',
        s.steps().some(v => v.speed === '1.00'), `${s.steps().length} graduations`);
}

// ─────────────────── Redescendre peut la perdre ───────────────────

console.log('\nQuand la valeur disparaît de l’échelle\n');

{
    const s = mount();
    s.MP.currentSpeed = '1.00';
    s.toggleScale();   // → 0,05
    s.toggleScale();   // → 0,01

    // Une valeur que seul le pas de 0,01 contient.
    s.MP.currentSpeed = '1.37';

    s.toggleScale();   // → classique : 1,37 n'y est pas
    check('0,01 → classique : la valeur se rabat sur la plus proche',
        s.MP.currentSpeed === '1.25', s.MP.currentSpeed);
    check('  … et l’animation se joue',
        s.bouncing(), s.bouncing() ? 'switching posée' : 'aucune');
    check('  … avec un retard croissant depuis la valeur retenue',
        s.steps().some(v => v.delay && v.delay !== '0ms'),
        JSON.stringify(s.steps().map(v => v.delay)));

    // Le retrait de la classe est programmé, sans quoi l'animation resterait.
    check('  … et son retrait est programmé',
        s.timeouts.length === 1 && s.timeouts[0].ms === 700,
        JSON.stringify(s.timeouts.map(t => t.ms)));
}

{
    // La valeur retenue est le point de départ des retards : elle rebondit la
    // première, ses voisines ensuite.
    const s = mount();
    s.MP.currentSpeed = '1.00';
    s.toggleScale();
    s.toggleScale();
    s.MP.currentSpeed = '2.60';
    s.toggleScale();

    const kept = s.steps().find(v => v.speed === s.MP.currentSpeed);
    check('la graduation retenue n’a aucun retard',
        !!kept && (kept.delay === '0ms' || !kept.delay),
        kept ? `${kept.speed} → ${kept.delay}` : 'introuvable');
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed === 0 ? 0 : 1);
