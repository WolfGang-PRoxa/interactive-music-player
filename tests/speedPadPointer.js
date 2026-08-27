/**
 * Vérifie que la roulette de vitesse se manœuvre au doigt — le vrai
 * speedPad.js, exécuté dans un DOM simulé.
 *
 * Le pad n'écoutait que la souris. Sur un écran tactile, `mousedown` n'est émis
 * qu'en compatibilité, une fois le geste terminé : la roulette ne suivait pas le
 * doigt, et la seule façon de changer de vitesse au téléphone était de taper une
 * valeur déjà visible dans les 140 px du cadre. Rien de tout cela ne se voit à
 * la souris, où l'interface reste parfaitement fonctionnelle.
 *
 * Deux moitiés font le correctif, et il faut les deux :
 *
 *  - **les événements pointeur**, qui couvrent souris, doigt et stylet ;
 *  - **`touch-action: pan-y`** sur le conteneur. Sans cette déclaration, le
 *    navigateur tactile garde les deux axes pour son défilement : il laisse
 *    passer le `pointerdown`, puis reprend la main au premier mouvement et
 *    émet `pointercancel`. Le code JavaScript est alors irréprochable et le pad
 *    ne bouge quand même pas.
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const SOURCE = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'web', 'public', 'js', 'speedPad.js'),
    'utf8'
);
const CSS = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'web', 'public', 'css', 'components.css'),
    'utf8'
);

let failed = 0;
let passed = 0;
const check = (label, ok, detail = '') => {
    if (ok) { passed++; console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`); }
    else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

/** Trois vitesses posées à 0, 50 et 100 px, larges de 40 : centres 20, 70, 120. */
const SPEEDS = ['1.00', '1.25', '1.50'];

/**
 * Monte un pad factice et rend de quoi lui envoyer des événements.
 *
 * Le conteneur fait 140 px, donc un centre à 70 : au repos c'est la deuxième
 * valeur qui est sous le repère, et un glissement de -50 px amène la troisième.
 */
function mountPad() {
    const listeners = { container: {}, window: {} };

    const values = SPEEDS.map((speed, i) => ({
        dataset: { speed },
        offsetLeft: i * 50,
        offsetWidth: 40,
        getBoundingClientRect: () => ({ left: i * 50, width: 40 }),
    }));
    values.forEach((v) => { v.closest = (sel) => (sel === '.speed-value' ? v : null); });

    const track = {
        dataset: { translateX: '0' },
        style: {},
        classList: { contains: () => false, add() {}, remove() {} },
        querySelectorAll: () => values,
    };

    const container = {
        dataset: {},
        clientWidth: 140,
        querySelector: (sel) => (sel === '.speed-pad-track' ? track : null),
        addEventListener: (type, fn) => { listeners.container[type] = fn; },
    };

    const fakeDocument = {
        getElementById: (id) => (id === 'speed-pad-container' ? container : null),
        querySelectorAll: () => [],
        addEventListener() {},
    };

    const fakeWindow = {
        addEventListener: (type, fn) => { listeners.window[type] = fn; },
        // Pas d'IntersectionObserver : la branche est sautée, elle n'est pas
        // le sujet et demanderait un observateur factice complet.
        IntersectionObserver: undefined,
    };

    const sandbox = { window: fakeWindow, document: fakeDocument, console };
    sandbox.globalThis = sandbox;
    fakeWindow.document = fakeDocument;
    vm.createContext(sandbox);
    vm.runInContext(SOURCE, sandbox);

    const MP = fakeWindow.MusicPlayer;
    const sends = [];
    // La reconstruction de la piste touche à un DOM que ce test ne simule pas,
    // et n'a rien à voir avec la saisie : elle est neutralisée.
    MP.rebuildSpeedPadTrack = () => {};
    MP.updateSpeedPad = () => {};
    MP.sendSpeedUpdate = (v) => sends.push(v);
    MP.initSpeedPad();

    return { listeners, sends, MP, values };
}

/**
 * Les scénarios de geste ne veulent rien dire si les écouteurs manquent.
 *
 * Sans cette garde, un retour aux événements souris ne ferait pas échouer le
 * test mais le ferait planter sur un `undefined` appelé comme une fonction — le
 * verdict serait juste, la lecture beaucoup moins.
 */
function supportsGestures(listeners, label) {
    const present = typeof listeners.container.pointerdown === 'function'
        && typeof listeners.window.pointermove === 'function'
        && typeof listeners.window.pointerup === 'function';
    if (!present) check(label, false, 'no pointer listener: scenario not played');
    return present;
}

const evt = (x, y, type = 'touch', id = 1) => ({
    clientX: x, clientY: y, pointerId: id, pointerType: type, isPrimary: true,
    target: { closest: () => null },
    preventDefault() {}, stopPropagation() {},
});

console.log('\n=== The wheel under the finger ===\n');

// 1. Les événements souris ne suffisent pas : ce sont les pointeurs qui doivent
//    être écoutés, sur le conteneur comme sur la fenêtre.
{
    const { listeners } = mountPad();
    check('the container listens for pointerdown', typeof listeners.container.pointerdown === 'function');
    check('the window listens for pointermove', typeof listeners.window.pointermove === 'function');
    check('the window listens for pointerup', typeof listeners.window.pointerup === 'function');
    check('the window listens for pointercancel', typeof listeners.window.pointercancel === 'function',
        'otherwise a gesture taken over by the browser leaves the pad stuck');

    const mouse = ['mousedown', 'mousemove', 'mouseup'].filter(
        (t) => listeners.container[t] || listeners.window[t]);
    check('no mouse listener left for the input', mouse.length === 0, mouse.join(', '));
}

// 2. Un glissement au doigt change réellement la vitesse.
{
    const { listeners, sends } = mountPad();
    const label = 'a -50 px swipe selects the next speed';
    if (supportsGestures(listeners, label)) {
        listeners.container.pointerdown(evt(100, 10));
        listeners.window.pointermove(evt(50, 10));   // -50 px : la 3e valeur passe au centre
        listeners.window.pointerup(evt(50, 10));
        check(label, sends.length === 1 && sends[0] === SPEEDS[2],
            sends.join(', ') || 'nothing sent');
    }
}

// 3. Un appui bref reste un appui, malgré la dérive de la pulpe du doigt.
{
    const { listeners, sends, values } = mountPad();
    const label = 'a press drifting by 10 px still selects the value it landed on';
    if (supportsGestures(listeners, label)) {
        listeners.container.pointerdown(evt(100, 10));
        const release = evt(110, 18);           // 10 px de dérive : sous le seuil tactile
        release.target = { closest: () => values[0] };
        listeners.window.pointerup(release);
        check(label, sends.length === 1 && sends[0] === SPEEDS[0],
            sends.join(', ') || 'nothing sent');
    }
}

// 4. La même dérive à la souris reste un glissement : le seuil ne s'élargit
//    que pour le doigt.
{
    const { listeners, sends } = mountPad();
    const label = 'with a mouse, 10 px still counts as a swipe';
    if (supportsGestures(listeners, label)) {
        listeners.container.pointerdown(evt(100, 10, 'mouse'));
        listeners.window.pointerup(evt(110, 18, 'mouse'));
        check(label, sends.length === 0, sends.join(', ') || 'nothing sent, as expected');
    }
}

// 5. Un geste repris par le navigateur libère le pad.
{
    const { listeners, sends } = mountPad();
    const label = 'a full gesture still works after a cancellation';
    if (supportsGestures(listeners, label)
        && typeof listeners.window.pointercancel === 'function') {
        listeners.container.pointerdown(evt(100, 10));
        listeners.window.pointermove(evt(50, 10));
        listeners.window.pointercancel(evt(50, 10));
        check('pointercancel sends no speed', sends.length === 0, sends.join(', '));

        // Le pad doit être libre : un nouveau geste complet doit repartir.
        listeners.container.pointerdown(evt(100, 10));
        listeners.window.pointermove(evt(50, 10));
        listeners.window.pointerup(evt(50, 10));
        check(label, sends.length === 1 && sends[0] === SPEEDS[2],
            sends.join(', ') || 'nothing sent');
    }
}

// 6. Un second doigt ne vole pas la saisie au premier.
{
    const { listeners, sends } = mountPad();
    const label = 'a second finger does not hijack the gesture';
    if (supportsGestures(listeners, label)) {
        listeners.container.pointerdown(evt(100, 10, 'touch', 1));
        listeners.container.pointerdown(evt(20, 10, 'touch', 2));   // ignoré
        listeners.window.pointermove(evt(50, 10, 'touch', 2));      // ignoré
        listeners.window.pointermove(evt(50, 10, 'touch', 1));
        listeners.window.pointerup(evt(50, 10, 'touch', 1));
        check(label, sends.length === 1 && sends[0] === SPEEDS[2],
            sends.join(', ') || 'nothing sent');
    }
}

// 7. L'autre moitié du correctif, sans laquelle le reste est inerte au doigt.
{
    const block = /\.speed-pad-container\s*\{([^}]*)\}/.exec(CSS.replace(/\/\*[\s\S]*?\*\//g, ''));
    check('the .speed-pad-container rule exists', !!block);
    const touchAction = block && /touch-action\s*:\s*([^;]+);/.exec(block[1]);
    check('it declares touch-action', !!touchAction, touchAction ? touchAction[1].trim() : '');
    check('the horizontal axis is held by the pad',
        !!touchAction && /pan-y|none/.test(touchAction[1]),
        touchAction ? touchAction[1].trim() : '');
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
