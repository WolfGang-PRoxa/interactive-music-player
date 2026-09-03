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

/** Le premier enfant portant cette classe, ou un objet vide à défaut. */
function childByClass(parent, className) {
    return parent.children.find(c => c.classList.contains(className)) || { textContent: '' };
}

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
            // Les icônes sont dessinées en SVG, qui vit dans son propre espace
            // de noms : sans cette fabrique, le module tombe en construisant la
            // note de musique d'une entrée sans image.
            createElementNS: (ns, tag) => { const el = makeElement(tag); created.push(el); return el; },
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
        /*
         * Le texte des lignes actuellement peintes.
         *
         * Cherché par sa classe et non par sa place : une ligne porte
         * maintenant une vignette avant son nom, et un index en dur se
         * tromperait de fils au prochain ornement ajouté.
         */
        rows: () => panel.children.map(r => childByClass(r, 'search-history-label').textContent),
        /** La croix d'une ligne, cherchée de la même façon. */
        removeButtonOf: (row) => childByClass(row, 'search-history-remove'),
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
        /*
         * Les saisies retenues, réduites à leur texte.
         *
         * Une entrée est désormais un objet — la saisie, plus le nom et
         * l'image appris ensuite. Les vérifications de stockage ne portent que
         * sur le texte ; celles de l'enrichissement lisent `stored()`.
         */
        saved: () => JSON.parse(store.get('searchInputHistory') || '[]').map(e => e.q),
        stored: () => JSON.parse(store.get('searchInputHistory') || '[]'),
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
    const removeBtn = s.removeButtonOf(row);
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


// ─────────────────────── Vignette, nom et infobulle ───────────────────────

/*
 * Une ligne ne montre plus la saisie brute.
 *
 * Une adresse ne dit rien de ce qu'elle porte : la ligne affiche donc le nom du
 * morceau quand il est connu, le nom du fichier pour un chemin, et garde
 * l'adresse complète pour le survol. L'image de la piste tient lieu de repère,
 * et une note de musique la remplace quand il n'y en a pas.
 */
console.log('\nCe que montre une ligne\n');

/** La vignette d'une ligne : son image, ou l'icône par défaut. */
function thumbOf(row) {
    const holder = childByClass(row, 'search-history-thumb');
    const child = (holder.children || [])[0] || {};
    return { tag: child.tagName || null, src: child.src || null };
}

{
    const s = mount({
        stored: [
            { q: 'https://youtu.be/aaa', title: 'Around the World', thumb: 'https://img/aaa.jpg' },
            { q: 'C:\\Musique\\Daft Punk\\Da Funk.mp3', title: null, thumb: null },
            { q: 'daft punk', title: null, thumb: null },
        ],
    });
    s.focus();

    check('un titre connu remplace l’adresse',
        s.rows()[0] === 'Around the World', s.rows()[0]);
    check('  … et son image est posée sur la ligne',
        thumbOf(s.panel.children[0]).tag === 'IMG'
            && thumbOf(s.panel.children[0]).src === 'https://img/aaa.jpg',
        JSON.stringify(thumbOf(s.panel.children[0])));
    check('  … l’adresse complète restant au survol',
        s.panel.children[0].title === 'https://youtu.be/aaa',
        String(s.panel.children[0].title));

    check('un chemin est réduit au nom du fichier',
        s.rows()[1] === 'Da Funk.mp3', s.rows()[1]);
    check('  … avec le chemin entier au survol',
        s.panel.children[1].title === 'C:\\Musique\\Daft Punk\\Da Funk.mp3',
        String(s.panel.children[1].title));
    check('  … et la note de musique faute d’image',
        thumbOf(s.panel.children[1]).tag === 'SVG', String(thumbOf(s.panel.children[1]).tag));

    check('une recherche en toutes lettres s’affiche telle quelle',
        s.rows()[2] === 'daft punk', s.rows()[2]);
    check('  … et ne s’encombre pas d’une infobulle qui la répéterait',
        !s.panel.children[2].title, String(s.panel.children[2].title));
}

{
    // Le format d'avant : de simples chaînes. Elles doivent se relire sans
    // migration à la main, et paraître comme des saisies pas encore reconnues.
    const s = mount({ stored: ['https://youtu.be/zzz', 'un titre'] });
    s.focus();
    check('les entrées d’avant se relisent sans rien perdre',
        s.rows().length === 2 && s.rows()[0] === 'https://youtu.be/zzz', s.rows().join(' | '));

    // La conversion n'est pas écrite à la lecture : relire n'a pas à toucher au
    // stockage. Elle l'est à la première sauvegarde, celle-ci par exemple.
    s.submit('https://youtu.be/nouveau');
    check('  … et se rangent au nouveau format dès la première écriture',
        s.stored().every(e => typeof e.q === 'string')
            && s.stored().some(e => e.q === 'https://youtu.be/zzz' && e.title === null),
        JSON.stringify(s.stored()));
}

// ─────────────────────── L'enrichissement par l'état ───────────────────────

console.log('\nCe que l’état vient compléter\n');

{
    const s = mount({ stored: ['https://youtu.be/aaa', 'daft punk', 'introuvable'] });

    s.sandbox.window.MusicPlayer.enrichSearchHistory([
        { url: 'https://youtu.be/aaa', title: 'Around the World', thumbnail: 'https://img/a.jpg' },
        { url: 'https://autre/bbb', title: 'daft punk', thumbnail: 'https://img/b.jpg' },
    ]);

    check('une entrée est reconnue par son adresse',
        s.stored()[0].title === 'Around the World' && s.stored()[0].thumb === 'https://img/a.jpg',
        JSON.stringify(s.stored()[0]));
    check('une recherche est reconnue par le titre revenu',
        s.stored()[1].title === 'daft punk' && s.stored()[1].thumb === 'https://img/b.jpg',
        JSON.stringify(s.stored()[1]));
    check('ce qu’aucune piste ne retrouve garde son texte',
        s.stored()[2].title === null && s.stored()[2].thumb === null,
        JSON.stringify(s.stored()[2]));

    s.focus();
    check('  … et la ligne montre alors le nom appris',
        s.rows()[0] === 'Around the World', s.rows()[0]);
}

{
    // La casse ne doit pas empêcher le rapprochement : une adresse recopiée à
    // la main, un chemin Windows saisi en minuscules.
    const s = mount({ stored: ['C:\\Musique\\Air.mp3'] });
    s.sandbox.window.MusicPlayer.enrichSearchHistory([
        { url: 'c:\\musique\\air.mp3', title: 'La Femme d’Argent', thumbnail: null },
    ]);
    check('le rapprochement ignore la casse',
        s.stored()[0].title === 'La Femme d’Argent', JSON.stringify(s.stored()[0]));
}

{
    // Le cas le plus fréquent : rien de nouveau à apprendre. La fonction est
    // appelée à chaque état, soit une fois par seconde.
    const s = mount({ stored: [{ q: 'a', title: 'A', thumb: 'i' }] });
    const before = s.store.get('searchInputHistory');
    s.sandbox.window.MusicPlayer.enrichSearchHistory([{ url: 'a', title: 'Autre', thumbnail: 'j' }]);
    check('une entrée déjà complète n’est pas retouchée',
        s.store.get('searchInputHistory') === before, s.store.get('searchInputHistory'));

    s.sandbox.window.MusicPlayer.enrichSearchHistory([]);
    check('une liste de pistes vide ne fait rien tomber', true);
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed === 0 ? 0 : 1);
