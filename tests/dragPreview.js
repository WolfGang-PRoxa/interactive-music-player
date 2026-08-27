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
        querySelectorAll: () => children,
        getBoundingClientRect: () => ({ left: 100, top: 200, width: 320, height: 64 }),
        cloneNode: () => fakeElement([...el._classes], children.map((c) => c.cloneNode())),
        closest: () => el,
    };
    return el;
}

function load() {
    let dragstartHandler = null;
    const fakeBody = { _added: [], appendChild(n) { this._added.push(n); }, };
    const fakeWindow = {};
    const context = {
        window: fakeWindow,
        document: {
            addEventListener: (type, fn, capture) => {
                if (type === 'dragstart' && capture === true) dragstartHandler = fn;
            },
            body: fakeBody,
        },
        console,
        setTimeout: () => {},
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(SOURCE, context);
    return { api: fakeWindow.MusicPlayer.dragPreview, dragstartHandler, fakeBody, fakeWindow };
}

console.log('dragPreview — building the preview\n');

const { api, dragstartHandler, fakeBody, fakeWindow } = load();

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

console.log('\ndragPreview — mouse drag thumbnail\n');

check('a dragstart handler is installed in capture phase', typeof dragstartHandler === 'function');

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
dragstartHandler(event);

check('setDragImage is called for the mouse', !!imageRequested);
check('  offset computed from the corner of the element',
    imageRequested && imageRequested.x === 50 && imageRequested.y === 30,
    imageRequested ? `${imageRequested.x}, ${imageRequested.y}` : '');
check('  the clone is inserted so it can be photographed', fakeBody._added.length === 1);
check('  and rendered off-screen',
    fakeBody._added[0]?._styles.get('top')?.value === '-10000px');

imageRequested = null;
fakeBody._added.length = 0;
fakeWindow.MusicPlayer.deviceMode = { isTouch: () => true };
dragstartHandler(event);
check('with a finger, the native thumbnail is left aside', imageRequested === null,
    'touchDragDrop handles its own preview');

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
