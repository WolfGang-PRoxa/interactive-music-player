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
    else { failed++; console.log(`  ECHEC ${label}${detail ? ` — ${detail}` : ''}`); }
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

console.log('dragPreview — construction de l\'aperçu\n');

const { api, dragstartHandler, fakeBody, fakeWindow } = load();

const child = fakeElement(['queue-index', 'is-dragging']);
const source = fakeElement(['queue-item', 'is-dragging', 'drag-over'], [child]);
const { node, rect } = api.build(source);

check('un clone est rendu', !!node && node !== source);
check('classe .drag-preview ajoutée', node.classList.contains('drag-preview'));
check('.is-dragging retirée du clone', !node.classList.contains('is-dragging'));
check('.drag-over retirée du clone', !node.classList.contains('drag-over'));
check('la classe utile est conservée', node.classList.contains('queue-item'));
check("l'élément source n'est pas modifié", source.classList.contains('is-dragging'));
check('les descendants du clone sont nettoyés',
    !node.children[0].classList.contains('is-dragging'));
check("les descendants d'origine sont laissés intacts",
    child.classList.contains('is-dragging'),
    'le clone ne doit jamais toucher au document');
check('le rectangle est remonté', rect.width === 320 && rect.height === 64);

console.log('\ndragPreview — priorité des styles\n');

const styles = node._styles;
check('largeur figée en !important',
    styles.get('width')?.value === '320px' && styles.get('width')?.priority === 'important');
check('transform neutralisé en !important',
    styles.get('transform')?.value === 'none' && styles.get('transform')?.priority === 'important',
    'sinon le scale() de .is-dragging reprend la main');
check('opacité forcée à 1 en !important',
    styles.get('opacity')?.value === '1' && styles.get('opacity')?.priority === 'important');
check('pointeurs neutralisés',
    styles.get('pointer-events')?.value === 'none',
    'sinon elementFromPoint ne verrait que l\'aperçu');
check('transitions coupées', styles.get('transition')?.value === 'none');

console.log('\ndragPreview — déplacement\n');

api.moveTo(node, 500, 400, 20, 10);
const t = node._styles.get('transform');
check('translate appliqué', t?.value === 'translate(480px, 390px)', t?.value);
check('  et en !important', t?.priority === 'important',
    'la garantie qui manquait et figeait l\'aperçu dans un coin');

console.log('\ndragPreview — vignette du glisser à la souris\n');

check('un gestionnaire dragstart est posé en capture', typeof dragstartHandler === 'function');

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

check('setDragImage est appelé à la souris', !!imageRequested);
check('  décalage calculé depuis le coin de l\'élément',
    imageRequested && imageRequested.x === 50 && imageRequested.y === 30,
    imageRequested ? `${imageRequested.x}, ${imageRequested.y}` : '');
check('  le clone est inséré pour être photographié', fakeBody._added.length === 1);
check('  et rendu hors champ',
    fakeBody._added[0]?._styles.get('top')?.value === '-10000px');

imageRequested = null;
fakeBody._added.length = 0;
fakeWindow.MusicPlayer.deviceMode = { isTouch: () => true };
dragstartHandler(event);
check('au doigt, la vignette native est laissée de côté', imageRequested === null,
    'touchDragDrop gère son propre aperçu');

console.log(`\n=== ${passed} réussite(s), ${failed} échec(s) ===`);
process.exit(failed === 0 ? 0 : 1);
