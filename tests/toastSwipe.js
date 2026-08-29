/**
 * Vérifie qu'une notification se chasse du doigt — le vrai settingsModal.js,
 * exécuté dans un DOM simulé.
 *
 * La notification ne se retirait qu'au bout de son compte à rebours : au doigt,
 * rien ne permettait de s'en débarrasser plus tôt. Pire, l'appui synthétise un
 * `mouseenter` que rien ne vient dénouer sur un écran tactile — le compte à
 * rebours restait alors suspendu, et la notification à l'écran.
 *
 * Le geste retenu va vers la droite ou vers le bas, les deux bords que la
 * notification longe déjà. Trois choses doivent tenir ensemble, et le test les
 * prend une par une :
 *
 *  - **la direction**, verrouillée à la sortie de la zone morte, pour qu'un
 *    geste diagonal ne louvoie pas entre les deux axes ;
 *  - **le seuil**, sans lequel un appui un peu glissant congédierait un message
 *    qu'on cherchait à lire ;
 *  - **le compte à rebours**, suspendu tant que le doigt est posé et repris
 *    s'il repart sans avoir chassé la notification.
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const SOURCE = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'web', 'public', 'js', 'settingsModal.js'),
    'utf8'
);
const CSS = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'web', 'public', 'css', 'modals.css'),
    'utf8'
);

let failed = 0;
let passed = 0;
const check = (label, ok, detail = '') => {
    if (ok) { passed++; console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`); }
    else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

/** Élément factice : juste ce que le module touche. */
function makeElement(id) {
    const classes = new Set();
    const listeners = {};
    const el = {
        id,
        dataset: {},
        textContent: '',
        parentElement: null,
        offsetWidth: 320,
        classList: {
            add: (...names) => names.forEach(n => classes.add(n)),
            remove: (...names) => names.forEach(n => classes.delete(n)),
            contains: (n) => classes.has(n),
            toggle: (n, force) => (force ? classes.add(n) : classes.delete(n)),
        },
        style: {
            setProperty(name, value) { this[name] = value; },
            removeProperty(name) { delete this[name]; },
        },
        addEventListener: (type, fn) => { listeners[type] = fn; },
        removeEventListener: (type) => { delete listeners[type]; },
        matches: () => false,
        appendChild() {},
    };
    el._classes = classes;
    el._listeners = listeners;
    return el;
}

/**
 * Monte la notification et rend de quoi la manœuvrer.
 *
 * Les minuteries sont factices : le test doit pouvoir constater qu'un compte à
 * rebours court, ou ne court pas, sans attendre les quatre secondes qu'il dure.
 */
function mountToast({ touch = true } = {}) {
    const timers = new Map();
    let nextTimerId = 1;

    const elements = {
        'error-toast': makeElement('error-toast'),
        'error-toast-message': makeElement('error-toast-message'),
        'btn-toast-action': makeElement('btn-toast-action'),
        'btn-copy-toast': makeElement('btn-copy-toast'),
    };

    const fakeDocument = {
        getElementById: (id) => elements[id] || null,
        querySelectorAll: () => [],
        addEventListener() {},
        body: makeElement('body'),
    };

    const fakeWindow = { addEventListener() {} };

    const sandbox = {
        window: fakeWindow,
        document: fakeDocument,
        console: { log() {}, warn() {}, error() {} },
        setTimeout: (fn, ms) => { const id = nextTimerId++; timers.set(id, { fn, ms }); return id; },
        clearTimeout: (id) => { timers.delete(id); },
        Date,
    };
    sandbox.globalThis = sandbox;
    fakeWindow.document = fakeDocument;
    vm.createContext(sandbox);
    vm.runInContext(SOURCE, sandbox);

    const MP = fakeWindow.MusicPlayer;
    MP.deviceMode = { isTouch: () => touch };
    MP.dashboardSettings = { toast: { inDuration: 0.3, holdDuration: 4, outDuration: 0.3 } };
    MP.copyToClipboard = async () => true;
    MP.setupToastInteractions();

    const toast = elements['error-toast'];

    const touchEventAt = (x, y, prevented) => ({
        touches: [{ clientX: x, clientY: y }],
        preventDefault() { prevented.push([x, y]); },
    });

    /** Un geste complet, de (x0,y0) à (x1,y1), en passant par le milieu. */
    const swipe = (x0, y0, x1, y1, { release = 'touchend' } = {}) => {
        const prevented = [];
        toast._listeners.touchstart(touchEventAt(x0, y0, prevented));
        toast._listeners.touchmove(
            touchEventAt(Math.round((x0 + x1) / 2), Math.round((y0 + y1) / 2), prevented));
        toast._listeners.touchmove(touchEventAt(x1, y1, prevented));
        toast._listeners[release](touchEventAt(x1, y1, prevented));
        return { prevented };
    };

    /** Exécute les minuteries en attente, comme le ferait l'horloge. */
    const runTimers = () => {
        [...timers.entries()].forEach(([id, { fn }]) => { timers.delete(id); fn(); });
    };

    return { MP, toast, elements, swipe, runTimers, timers, touchEventAt };
}

console.log('\n=== The notification swiped away ===\n');

// 1. Les quatre écouteurs tactiles sont posés, et la feuille de style laisse
//    passer le geste.
{
    const { toast } = mountToast();
    ['touchstart', 'touchmove', 'touchend', 'touchcancel'].forEach((type) => {
        check(`the notification listens for ${type}`, typeof toast._listeners[type] === 'function');
    });
    check('the stylesheet leaves the gesture to the notification',
        /\.toast\s*\{[^}]*touch-action:\s*none/s.test(CSS),
        'without touch-action: none the browser takes the swipe for its own scrolling');
}

// 2. Un balayage franc vers la droite la chasse.
{
    const { MP, toast, swipe, runTimers } = mountToast();
    MP.showToast('coucou');
    swipe(200, 300, 320, 300);

    check('a rightward swipe throws the notification off to the right',
        String(toast.style.transform).includes('120vw'), toast.style.transform);
    check('it fades out on the way', toast.style.opacity === '0');
    check('it is still on screen while it flies', !toast.classList.contains('hidden'));

    runTimers();
    check('then it is withdrawn', toast.classList.contains('hidden'));
    check('and leaves no displacement behind', toast.style.transform === '');
}

// 3. Vers le bas également.
{
    const { MP, toast, swipe } = mountToast();
    MP.showToast('coucou');
    swipe(200, 300, 200, 420);
    check('a downward swipe throws it off to the bottom',
        String(toast.style.transform).includes('120vh'), toast.style.transform);
}

// 4. Une course trop courte la ramène à sa place, compte à rebours repris.
{
    const { MP, toast, swipe, timers } = mountToast();
    MP.showToast('coucou');
    const before = timers.size;
    swipe(200, 300, 230, 300);   // 30 px : sous le seuil de 64

    check('a short swipe brings the notification back', toast.style.transform === '',
        toast.style.transform || '(none)');
    check('it stays on screen', !toast.classList.contains('hidden'));
    check('its countdown starts again', timers.size === before,
        `${timers.size} timer(s) pending`);
}

// 5. Le doigt posé suspend le compte à rebours.
{
    const { MP, toast, timers, touchEventAt } = mountToast();
    MP.showToast('coucou');
    check('a countdown runs once the notification is shown', timers.size === 1);

    toast._listeners.touchstart(touchEventAt(200, 300, []));
    check('the finger suspends it', timers.size === 0, `${timers.size} timer(s) pending`);
}

// 6. Vers la gauche ou vers le haut, le geste ne l'accroche pas.
{
    const { MP, toast, swipe } = mountToast();
    MP.showToast('coucou');
    const { prevented } = swipe(200, 300, 80, 300);
    check('a leftward swipe does not move it', toast.style.transform === '',
        toast.style.transform || '(none)');
    check('and leaves the page scrolling alone', prevented.length === 0,
        `${prevented.length} preventDefault()`);
    check('it stays on screen', !toast.classList.contains('hidden'));
}

// 7. L'axe se verrouille : une diagonale ne louvoie pas.
{
    const { MP, toast, touchEventAt } = mountToast();
    MP.showToast('coucou');
    toast._listeners.touchstart(touchEventAt(200, 300, []));
    toast._listeners.touchmove(touchEventAt(240, 305, []));   // horizontal : l'axe se fixe sur x
    toast._listeners.touchmove(touchEventAt(250, 400, []));   // puis le doigt part vers le bas
    check('the locked axis holds for the rest of the gesture',
        /translate\(50px,\s*0px\)/.test(toast.style.transform), toast.style.transform);
}

// 8. À la souris, le geste tactile n'existe pas.
{
    const { MP, toast, touchEventAt } = mountToast({ touch: false });
    MP.showToast('coucou');
    toast._listeners.touchstart(touchEventAt(200, 300, []));
    toast._listeners.touchmove(touchEventAt(320, 300, []));
    check('on a desktop the notification ignores the touch gesture',
        toast.style.transform === '' && !toast.classList.contains('toast-swiping'),
        toast.style.transform || '(none)');
}

// 9. Un geste repris par le système la remet en place.
{
    const { MP, toast, swipe } = mountToast();
    MP.showToast('coucou');
    swipe(200, 300, 330, 300, { release: 'touchcancel' });
    check('a cancelled gesture puts it back rather than dismissing it',
        toast.style.transform === '' && !toast.classList.contains('hidden'),
        toast.style.transform || '(none)');
}

// 10. Le message suivant efface les traces du précédent.
{
    const { MP, toast, swipe } = mountToast();
    MP.showToast('premier');
    swipe(200, 300, 330, 300);
    MP.showToast('second');
    check('a new notification comes back to its place, fully opaque',
        toast.style.transform === '' && toast.style.opacity === '',
        `${toast.style.transform || '(none)'} / ${toast.style.opacity || '(none)'}`);
    check('and is no longer marked as flying away',
        !toast.classList.contains('toast-settling'));
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
