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

let echecs = 0;
let reussites = 0;
const verifier = (libelle, ok, detail = '') => {
    if (ok) { reussites++; console.log(`  ok    ${libelle}${detail ? ` — ${detail}` : ''}`); }
    else { echecs++; console.log(`  ECHEC ${libelle}${detail ? ` — ${detail}` : ''}`); }
};

/** Élément suffisant pour ce que dragPreview manipule. */
function fakeElement(classes = [], enfants = []) {
    const el = {
        _classes: new Set(classes),
        _attrs: {},
        _styles: new Map(),
        children: enfants,
        classList: {
            add: (c) => el._classes.add(c),
            remove: (c) => el._classes.delete(c),
            contains: (c) => el._classes.has(c),
        },
        style: {
            setProperty: (prop, valeur, priorite) => {
                el._styles.set(prop, { valeur, priorite: priorite || '' });
            },
        },
        removeAttribute: (a) => { delete el._attrs[a]; },
        querySelectorAll: () => enfants,
        getBoundingClientRect: () => ({ left: 100, top: 200, width: 320, height: 64 }),
        cloneNode: () => fakeElement([...el._classes], enfants.map((c) => c.cloneNode())),
        closest: () => el,
    };
    return el;
}

function charger() {
    let dragstartHandler = null;
    const corps = { _ajoutes: [], appendChild(n) { this._ajoutes.push(n); }, };
    const fenetre = {};
    const contexte = {
        window: fenetre,
        document: {
            addEventListener: (type, fn, capture) => {
                if (type === 'dragstart' && capture === true) dragstartHandler = fn;
            },
            body: corps,
        },
        console,
        setTimeout: () => {},
    };
    contexte.globalThis = contexte;
    vm.createContext(contexte);
    vm.runInContext(SOURCE, contexte);
    return { api: fenetre.MusicPlayer.dragPreview, dragstartHandler, corps, fenetre };
}

console.log('dragPreview — construction de l\'aperçu\n');

const { api, dragstartHandler, corps, fenetre } = charger();

const enfant = fakeElement(['queue-index', 'is-dragging']);
const source = fakeElement(['queue-item', 'is-dragging', 'drag-over'], [enfant]);
const { node, rect } = api.build(source);

verifier('un clone est rendu', !!node && node !== source);
verifier('classe .drag-preview ajoutée', node.classList.contains('drag-preview'));
verifier('.is-dragging retirée du clone', !node.classList.contains('is-dragging'));
verifier('.drag-over retirée du clone', !node.classList.contains('drag-over'));
verifier('la classe utile est conservée', node.classList.contains('queue-item'));
verifier("l'élément source n'est pas modifié", source.classList.contains('is-dragging'));
verifier('les descendants du clone sont nettoyés',
    !node.children[0].classList.contains('is-dragging'));
verifier("les descendants d'origine sont laissés intacts",
    enfant.classList.contains('is-dragging'),
    'le clone ne doit jamais toucher au document');
verifier('le rectangle est remonté', rect.width === 320 && rect.height === 64);

console.log('\ndragPreview — priorité des styles\n');

const styles = node._styles;
verifier('largeur figée en !important',
    styles.get('width')?.valeur === '320px' && styles.get('width')?.priorite === 'important');
verifier('transform neutralisé en !important',
    styles.get('transform')?.valeur === 'none' && styles.get('transform')?.priorite === 'important',
    'sinon le scale() de .is-dragging reprend la main');
verifier('opacité forcée à 1 en !important',
    styles.get('opacity')?.valeur === '1' && styles.get('opacity')?.priorite === 'important');
verifier('pointeurs neutralisés',
    styles.get('pointer-events')?.valeur === 'none',
    'sinon elementFromPoint ne verrait que l\'aperçu');
verifier('transitions coupées', styles.get('transition')?.valeur === 'none');

console.log('\ndragPreview — déplacement\n');

api.moveTo(node, 500, 400, 20, 10);
const t = node._styles.get('transform');
verifier('translate appliqué', t?.valeur === 'translate(480px, 390px)', t?.valeur);
verifier('  et en !important', t?.priorite === 'important',
    'la garantie qui manquait et figeait l\'aperçu dans un coin');

console.log('\ndragPreview — vignette du glisser à la souris\n');

verifier('un gestionnaire dragstart est posé en capture', typeof dragstartHandler === 'function');

let imageDemandee = null;
const evenement = {
    target: source,
    clientX: 150,
    clientY: 230,
    dataTransfer: {
        setDragImage: (n, x, y) => { imageDemandee = { n, x, y }; },
    },
};
fenetre.MusicPlayer.deviceMode = { isTouch: () => false };
dragstartHandler(evenement);

verifier('setDragImage est appelé à la souris', !!imageDemandee);
verifier('  décalage calculé depuis le coin de l\'élément',
    imageDemandee && imageDemandee.x === 50 && imageDemandee.y === 30,
    imageDemandee ? `${imageDemandee.x}, ${imageDemandee.y}` : '');
verifier('  le clone est inséré pour être photographié', corps._ajoutes.length === 1);
verifier('  et rendu hors champ',
    corps._ajoutes[0]?._styles.get('top')?.valeur === '-10000px');

imageDemandee = null;
corps._ajoutes.length = 0;
fenetre.MusicPlayer.deviceMode = { isTouch: () => true };
dragstartHandler(evenement);
verifier('au doigt, la vignette native est laissée de côté', imageDemandee === null,
    'touchDragDrop gère son propre aperçu');

console.log(`\n=== ${reussites} réussite(s), ${echecs} échec(s) ===`);
process.exit(echecs === 0 ? 0 : 1);
