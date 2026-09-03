/**
 * Vérifie l'historique du champ d'ajout — le vrai js/searchHistory.js, exécuté
 * dans un DOM simulé.
 *
 * Ce module remplace une liste que le navigateur rendait lui-même. La
 * remplacer n'a d'intérêt que si la nôtre fait au moins aussi bien, et deux
 * choses s'y cassent en silence :
 *
 *  - **La saisie mise de côté.** Remonter au-dessus de la première entrée doit
 *    rendre au champ ce qu'on était en train de taper, et non y laisser la
 *    dernière entrée parcourue. C'est la seule raison pour laquelle `draft`
 *    existe ; l'oublier ne lève aucune erreur, cela fait simplement perdre une
 *    frappe à chaque fois qu'une flèche est effleurée.
 *
 *  - **Le `preventDefault` des flèches.** Sans lui, le comportement ordinaire
 *    de ces touches s'ajoute au nôtre : le curseur file au début ou à la fin du
 *    texte pendant qu'on parcourt la liste. Cela ne se voit qu'à l'usage, et
 *    jamais dans un diff.
 *
 * Le reste tient l'historique lui-même : une entrée déjà connue remonte en tête
 * au lieu de se dédoubler, le plafond tient, et la recherche porte sur le
 * contenu — on retrouve un lien par le nom du morceau qu'il porte, ce qu'un
 * filtre par préfixe interdirait sur une URL, qui commence toujours pareil.
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const SOURCE = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'web', 'public', 'js', 'searchHistory.js'),
    'utf8'
);

let failed = 0;
let passed = 0;
const check = (label, ok, detail = '') => {
    if (ok) { passed++; console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`); }
    else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

/** Élément factice : assez de DOM pour ce que le module touche. */
function makeElement(tag = 'div') {
    const listeners = {};
    const classes = new Set();
    const el = {
        tagName: tag.toUpperCase(),
        children: [],
        style: {},
        value: '',
        offsetLeft: 12,
        offsetTop: 8,
        offsetWidth: 400,
        offsetHeight: 48,
        get className() { return [...classes].join(' '); },
        set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach(c => classes.add(c)); },
        classList: {
            add: (...n) => n.forEach(c => classes.add(c)),
            remove: (...n) => n.forEach(c => classes.delete(c)),
            contains: (c) => classes.has(c),
        },
        setAttribute() {},
        getAttribute: () => null,
        setSelectionRange() {},
        focus() {},
        closest: () => null,
        appendChild(child) { el.children.push(child); return child; },
        addEventListener: (type, fn) => {
            (listeners[type] = listeners[type] || []).push(fn);
        },
        removeEventListener() {},
        get textContent() { return el._text || ''; },
        set textContent(v) {
            el._text = v;
            // Une chaîne vide vide l'élément : c'est ainsi que le module
            // repeint son panneau.
            if (v === '') el.children = [];
        },
        _listeners: listeners,
        _fire(type, event = {}) {
            (listeners[type] || []).forEach(fn => fn(event));
        },
    };
    return el;
}

/** Événement clavier factice, qui retient ce qu'on lui a demandé. */
function keyEvent(key) {
    return {
        key,
        defaultPrevented: false,
        propagationStopped: false,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() { this.propagationStopped = true; },
    };
}

function mount({ stored = null, clearsFieldFirst = false } = {}) {
    const store = new Map();
    if (stored) store.set('searchInputHistory', JSON.stringify(stored));

    const input = makeElement('input');
    const form = makeElement('form');
    const box = makeElement('div');
    input.closest = (sel) => (sel === '.search-box' ? box : null);

    const created = [];
    const docCapture = {};
    const docBubble = {};
    const sandbox = {
        window: { MusicPlayer: {}, addEventListener() {} },
        document: {
            readyState: 'complete',
            getElementById: (id) => {
                if (id === 'search-input') return input;
                if (id === 'search-form') return form;
                return null;
            },
            createElement: (tag) => { const el = makeElement(tag); created.push(el); return el; },
            // La capture est distinguée de la remontée : c'est elle que le
            // module emploie pour lire le champ avant qu'un autre écouteur ne
            // le vide, et un stub qui les confondrait ne prouverait rien.
            addEventListener: (type, fn, capture) => {
                const bucket = capture ? docCapture : docBubble;
                (bucket[type] = bucket[type] || []).push(fn);
            },
        },
        localStorage: {
            getItem: (k) => (store.has(k) ? store.get(k) : null),
            setItem: (k, v) => store.set(k, v),
            removeItem: (k) => store.delete(k),
        },
        JSON, Math, Array, console,
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);

    /*
     * L'écouteur concurrent est posé AVANT le module, et c'est indispensable :
     * c'est ainsi que les choses se passent dans la page, app.js se branchant
     * dès son exécution quand le module attend `DOMContentLoaded`. Le poser
     * après reviendrait à tester l'ordre inverse — celui qui ne pose problème
     * à personne.
     */
    if (clearsFieldFirst) {
        form.addEventListener('submit', () => { input.value = ''; });
    }

    vm.runInContext(SOURCE, sandbox);

    // Le panneau est le premier élément que le module ait créé et attaché.
    const panel = box.children[0];

    return {
        input, form, box, panel, store, sandbox,
        /** Le texte des lignes actuellement peintes. */
        rows: () => panel.children.map(r => r.children[0].textContent),
        highlightedIndex: () => panel.children.findIndex(r => r.classList.contains('is-highlighted')),
        isOpen: () => !panel.classList.contains('hidden'),
        type(value) { input.value = value; input._fire('input', {}); },
        press(key) { const e = keyEvent(key); input._fire('keydown', e); return e; },
        /**
         * Envoie le formulaire comme le ferait le navigateur : la capture
         * descend du document jusqu'à la cible, puis les écouteurs de la cible
         * s'exécutent. C'est cet ordre-là, et non celui d'enregistrement, qui
         * décide de qui lit le champ en premier.
         */
        submit(value) {
            input.value = value;
            const event = { target: form };
            (docCapture.submit || []).forEach(fn => fn(event));
            form._fire('submit', event);
            (docBubble.submit || []).forEach(fn => fn(event));
        },
        focus() { input._fire('focus', {}); },
        saved: () => JSON.parse(store.get('searchInputHistory') || '[]'),
    };
}

console.log('\n=== Historique du champ d’ajout ===\n');

// ─────────────────────────── Ce qui est retenu ───────────────────────────

console.log('Ce qui est retenu\n');

{
    const s = mount();
    s.submit('https://youtu.be/aaa');
    s.submit('daft punk');
    check('une saisie validée est retenue', s.saved().length === 2, s.saved().join(' | '));
    check('la plus récente vient en tête', s.saved()[0] === 'daft punk', s.saved()[0]);

    s.submit('https://youtu.be/aaa');
    check('une entrée déjà connue remonte au lieu de se dédoubler',
        s.saved().length === 2 && s.saved()[0] === 'https://youtu.be/aaa',
        `${s.saved().length} entrée(s) : ${s.saved().join(' | ')}`);

    s.submit('   ');
    check('une saisie vide n’est pas retenue', s.saved().length === 2);

    s.submit('  espaces autour  ');
    check('les espaces de bord sont retirés',
        s.saved()[0] === 'espaces autour', `« ${s.saved()[0]} »`);

    s.submit('x'.repeat(401));
    check('une entrée démesurée est écartée',
        s.saved().every(e => e.length <= 400), `${s.saved().length} entrée(s)`);
}

{
    /*
     * Le champ vidé par un autre écouteur, et l'entrée retenue tout de même.
     *
     * C'est la panne qu'a connue la première version : app.js pose son écouteur
     * de soumission dès son exécution, quand ce module attendait
     * `DOMContentLoaded` pour poser le sien. Le sien passait donc en premier, et
     * il vide le champ après envoi — on lisait une chaîne vide, et l'historique
     * restait éternellement vide sans qu'aucune erreur ne le signale.
     *
     * La capture règle la question par la phase plutôt que par l'ordre : elle
     * descend du document avant que la cible ne soit atteinte. Ce test pose donc
     * un écouteur concurrent qui vide le champ, et vérifie qu'il ne prive de
     * rien.
     */
    const s = mount({ clearsFieldFirst: true });
    s.submit('https://youtu.be/zzz');
    check('un écouteur qui vide le champ ne fait pas perdre l’entrée',
        s.saved().length === 1 && s.saved()[0] === 'https://youtu.be/zzz',
        s.saved().join(' | ') || 'rien retenu');
}

{
    const s = mount();
    for (let i = 0; i < 30; i++) s.submit(`entree ${i}`);
    check('le plafond de 25 entrées tient', s.saved().length === 25, `${s.saved().length}`);
    check('  … et ce sont les plus anciennes qui tombent',
        s.saved()[0] === 'entree 29' && !s.saved().includes('entree 0'),
        `tête « ${s.saved()[0]} »`);
}

{
    // La persistance : un rechargement de page retrouve la liste.
    const s = mount({ stored: ['un', 'deux'] });
    s.focus();
    check('l’historique est relu au chargement',
        s.rows().length === 2 && s.rows()[0] === 'un', s.rows().join(' | '));
}

// ─────────────────────────── Les flèches ───────────────────────────

console.log('\nLe parcours aux flèches\n');

{
    const s = mount({ stored: ['alpha', 'bravo', 'charlie'] });
    s.type('');

    const first = s.press('ArrowDown');
    check('la première flèche ouvre le panneau', s.isOpen());
    check('  … sur l’entrée la plus récente',
        s.input.value === 'alpha' && s.highlightedIndex() === 0,
        `« ${s.input.value} », ligne ${s.highlightedIndex()}`);
    check('  … et neutralise le déplacement du curseur', first.defaultPrevented);

    s.press('ArrowDown');
    check('la flèche du bas descend d’une entrée',
        s.input.value === 'bravo' && s.highlightedIndex() === 1, `« ${s.input.value} »`);

    s.press('ArrowUp');
    check('la flèche du haut remonte',
        s.input.value === 'alpha' && s.highlightedIndex() === 0, `« ${s.input.value} »`);

    s.press('ArrowDown'); s.press('ArrowDown'); s.press('ArrowDown');
    check('elle s’arrête à la dernière au lieu de boucler',
        s.input.value === 'charlie' && s.highlightedIndex() === 2, `« ${s.input.value} »`);
}

{
    /*
     * Le point qui compte : la saisie en cours doit revenir.
     *
     * La saisie choisie ici correspond aux deux entrées, et il le faut : une
     * saisie qui ne correspond à rien referme le panneau, les flèches n'ont
     * alors plus de liste à parcourir, et le champ ne bouge pas. Une première
     * version de ce test partait de « daf » — qui ne trouve ni alpha ni
     * bravo —, si bien que la restauration passait sans jamais avoir eu lieu.
     */
    const s = mount({ stored: ['alpha', 'bravo'] });
    s.type('a');

    s.press('ArrowDown');
    check('la saisie est remplacée par l’entrée parcourue',
        s.input.value === 'alpha', `« ${s.input.value} »`);

    s.press('ArrowUp');
    check('remonter au-dessus de la première rend la saisie en cours',
        s.input.value === 'a', `« ${s.input.value} »`);
    check('  … et plus aucune ligne n’est mise en évidence',
        s.highlightedIndex() === -1, `ligne ${s.highlightedIndex()}`);

    s.press('ArrowUp');
    check('insister ne va pas plus haut', s.input.value === 'a', `« ${s.input.value} »`);
}

{
    // Une saisie sans correspondance : les flèches n'ont rien à proposer et
    // laissent le champ tranquille, plutôt que d'ouvrir un panneau vide.
    const s = mount({ stored: ['alpha', 'bravo'] });
    s.type('zzz');
    s.press('ArrowDown');
    check('sans correspondance, les flèches ne touchent pas au champ',
        s.input.value === 'zzz' && !s.isOpen(), `« ${s.input.value} »`);
}

// ─────────────────────────── Le filtre ───────────────────────────

console.log('\nLe filtre\n');

{
    const s = mount({ stored: [
        'https://youtu.be/abc',
        'daft punk one more time',
        'https://soundcloud.com/daft',
    ] });

    s.type('daft');
    check('la liste se réduit à ce qui contient la saisie',
        s.rows().length === 2, s.rows().join(' | '));
    check('  … y compris au milieu d’une URL',
        s.rows().some(r => r.includes('soundcloud')), s.rows().join(' | '));

    s.type('zzz');
    check('une saisie sans correspondance referme le panneau', !s.isOpen());

    s.type('');
    check('un champ vidé rend toute la liste', s.rows().length === 3);
}

// ─────────────────────────── La sortie ───────────────────────────

console.log('\nLa sortie du panneau\n');

{
    const s = mount({ stored: ['alpha', 'bravo'] });
    s.type('br');
    s.press('ArrowDown');
    check('une entrée est portée dans le champ', s.input.value === 'bravo');

    const esc = s.press('Escape');
    check('Échap referme le panneau', !s.isOpen());
    check('  … en rendant la saisie en cours', s.input.value === 'br', `« ${s.input.value} »`);
    check('  … et retient la touche, qui fermerait sinon une fenêtre',
        esc.propagationStopped);

    s.type('al');
    s.press('ArrowDown');
    s.press('Enter');
    check('Entrée referme le panneau', !s.isOpen());
    check('  … en laissant l’entrée choisie dans le champ',
        s.input.value === 'alpha', `« ${s.input.value} »`);
}

{
    const s = mount({ stored: ['alpha', 'bravo'] });
    s.focus();
    const row = s.panel.children[1];
    const removeBtn = row.children[1];
    row._fire('mousedown', { target: removeBtn, preventDefault() {} });

    check('la croix d’une ligne retire son entrée',
        s.saved().length === 1 && s.saved()[0] === 'alpha', s.saved().join(' | '));
    check('  … et la liste affichée suit', s.rows().length === 1, s.rows().join(' | '));

    const remaining = s.panel.children[0];
    remaining._fire('mousedown', { target: remaining, preventDefault() {} });
    check('un clic sur la ligne la porte dans le champ',
        s.input.value === 'alpha', `« ${s.input.value} »`);
    check('  … et referme le panneau', !s.isOpen());
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed === 0 ? 0 : 1);
