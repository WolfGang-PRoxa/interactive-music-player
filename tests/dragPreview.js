/**
 * Vérifie dragPreview.js — le vrai fichier, dans un DOM minimal simulé.
 *
 * Ce module a été écrit pour corriger un défaut discret : l'aperçu clonait un
 * élément qui venait de recevoir `.is-dragging`, dont le
 * `transform: scale() !important` écrasait le `translate()` censé le faire
 * suivre le pointeur. L'aperçu restait figé dans un coin, à 35 % d'opacité.
 *
 * Les deux garanties à ne jamais reperdre sont donc : les classes d'état sont
 * retirées du clone, et les propriétés de placement sont posées en `!important`.
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const SOURCE = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'web', 'public', 'js', 'dragPreview.js'),
    'utf8'
);

let failed = 0;
let passed = 0;
const check = (label, ok, detail = '') => {
    if (ok) { passed++; console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`); }
    else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

/** Élément suffisant pour ce que dragPreview manipule. */
function fakeElement(classes = [], children = []) {
    const el = {
        _classes: new Set(classes),
        _attrs: {},
        _styles: new Map(),
        children: children,
        classList: {
            add: (c) => el._classes.add(c),
            remove: (c) => el._classes.delete(c),
            contains: (c) => el._classes.has(c),
        },
        style: {
            setProperty: (prop, value, priority) => {
                el._styles.set(prop, { value, priority: priority || '' });
            },
        },
        removeAttribute: (a) => { delete el._attrs[a]; },
        remove: () => { el._removed = true; },
        querySelectorAll: () => children,
        getBoundingClientRect: () => ({ left: 100, top: 200, width: 320, height: 64 }),
        cloneNode: () => fakeElement([...el._classes], children.map((c) => c.cloneNode())),
        closest: () => el,
    };
    return el;
}

function load() {
    // Tous les gestionnaires, et non le seul `dragstart` : l'aperçu vivant se
    // déplace et se retire par quatre autres événements.
    const handlers = {};
    const fakeBody = { _added: [], appendChild(n) { this._added.push(n); }, };
    const fakeWindow = {};
    const context = {
        window: fakeWindow,
        document: {
            addEventListener: (type, fn, capture) => {
                if (capture === true) handlers[type] = fn;
            },
            body: fakeBody,
        },
        console,
        setTimeout: () => {},
        // Le module en fabrique une pour effacer la vignette du navigateur.
        Image: function FakeImage() { this.src = ''; },
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(SOURCE, context);
    return { api: fakeWindow.MusicPlayer.dragPreview, handlers, fakeBody, fakeWindow };
}

console.log('dragPreview — building the preview\n');

const { api, handlers, fakeBody, fakeWindow } = load();

const child = fakeElement(['queue-index', 'is-dragging']);
const source = fakeElement(['queue-item', 'is-dragging', 'drag-over'], [child]);
const { node, rect } = api.build(source);

check('a clone is produced', !!node && node !== source);
check('.drag-preview class added', node.classList.contains('drag-preview'));
check('.is-dragging removed from the clone', !node.classList.contains('is-dragging'));
check('.drag-over removed from the clone', !node.classList.contains('drag-over'));
check('the useful class is kept', node.classList.contains('queue-item'));
check('the source element is left untouched', source.classList.contains('is-dragging'));
check('the descendants of the clone are cleaned up',
    !node.children[0].classList.contains('is-dragging'));
check('the original descendants are left intact',
    child.classList.contains('is-dragging'),
    'the clone must never touch the document');
check('the rectangle is reported back', rect.width === 320 && rect.height === 64);

console.log('\ndragPreview — style priority\n');

const styles = node._styles;
check('width pinned with !important',
    styles.get('width')?.value === '320px' && styles.get('width')?.priority === 'important');
check('transform neutralised with !important',
    styles.get('transform')?.value === 'none' && styles.get('transform')?.priority === 'important',
    'otherwise the scale() of .is-dragging takes over again');
check('opacity forced to 1 with !important',
    styles.get('opacity')?.value === '1' && styles.get('opacity')?.priority === 'important');
check('pointer events neutralised',
    styles.get('pointer-events')?.value === 'none',
    'otherwise elementFromPoint would only ever see the preview');
check('transitions switched off', styles.get('transition')?.value === 'none');

console.log('\ndragPreview — movement\n');

api.moveTo(node, 500, 400, 20, 10);
const t = node._styles.get('transform');
check('translate applied', t?.value === 'translate(480px, 390px)', t?.value);
check('  and with !important', t?.priority === 'important',
    'the guarantee that was missing and pinned the preview in a corner');

console.log('\ndragPreview — the live preview on mouse\n');

check('a dragstart handler is installed in capture phase', typeof handlers.dragstart === 'function');
check('the pointer is followed from two sources',
    typeof handlers.drag === 'function' && typeof handlers.dragover === 'function',
    'drag runs dry in some browsers, dragover fills the gaps');
check('the end of the gesture is caught twice as well',
    typeof handlers.dragend === 'function' && typeof handlers.drop === 'function',
    'dragend is missing when the gesture ends outside the window');

let imageRequested = null;
const event = {
    target: source,
    clientX: 150,
    clientY: 230,
    dataTransfer: {
        setDragImage: (n, x, y) => { imageRequested = { n, x, y }; },
    },
};
fakeWindow.MusicPlayer.deviceMode = { isTouch: () => false };
handlers.dragstart(event);

/*
 * La vignette du navigateur est une photographie : prise au départ, figée,
 * délavée par le système. On l'efface pour lui substituer un nœud vivant, celui
 * que le doigt déplace déjà sur téléphone.
 */
check('the native thumbnail is blanked out', !!imageRequested && imageRequested.x === 0,
    'a browser will not take null for an answer');

const ghost = fakeBody._added[0];
check('  a clone is inserted in the document', fakeBody._added.length === 1 && !!ghost);
check('  laid out fixed and above everything',
    ghost._styles.get('position')?.value === 'fixed'
    && ghost._styles.get('z-index')?.value === '99999');
check('  and transparent to the pointer',
    ghost._styles.get('pointer-events')?.value === 'none',
    'otherwise the browser would no longer see where one is dropping');

// Posé sous le pointeur dès le départ, et non dans un coin en attendant le
// premier mouvement.
check('  placed under the pointer straight away',
    ghost._styles.get('transform')?.value === 'translate(100px, 200px)',
    ghost._styles.get('transform')?.value);

handlers.dragover({ clientX: 400, clientY: 300 });
check('the preview follows the pointer',
    ghost._styles.get('transform')?.value === 'translate(350px, 270px)',
    ghost._styles.get('transform')?.value);

/*
 * Plusieurs navigateurs rendent (0, 0) sur le dernier `drag` d'un geste :
 * l'aperçu irait se coller dans le coin de l'écran juste avant de disparaître.
 */
handlers.drag({ clientX: 0, clientY: 0 });
check('  but ignores the null coordinates of the last event',
    ghost._styles.get('transform')?.value === 'translate(350px, 270px)',
    'otherwise it jumps into the corner before vanishing');

handlers.dragend({});
check('the preview leaves at the end of the gesture', ghost._removed === true);

handlers.dragover({ clientX: 700, clientY: 700 });
check('  and nothing follows a pointer any more',
    ghost._styles.get('transform')?.value === 'translate(350px, 270px)');

// Un second glisser ne doit pas laisser le premier clone derrière lui.
fakeBody._added.length = 0;
handlers.dragstart(event);
handlers.dragstart(event);
check('two starts in a row leave a single preview',
    fakeBody._added.length === 2 && fakeBody._added[0]._removed === true,
    'the first is cleared before the second is laid down');

handlers.dragend({});
imageRequested = null;
fakeBody._added.length = 0;
fakeWindow.MusicPlayer.deviceMode = { isTouch: () => true };
handlers.dragstart(event);
check('with a finger, none of this happens',
    imageRequested === null && fakeBody._added.length === 0,
    'touchDragDrop handles its own preview, and there is no native drag to fix');

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
