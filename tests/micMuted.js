/**
 * Vérifie le micro coupé dans la boîte d'activité vocale — le vrai
 * js/queue.js, exécuté dans un DOM simulé.
 *
 * ## Pourquoi ce symbole existe
 *
 * La boîte montre qui est dans le salon et allume un halo quand quelqu'un
 * parle. Un membre dont le halo ne s'allume jamais pouvait l'être pour deux
 * raisons sans rapport : le bot ne l'écoute pas — l'interrupteur de détection
 * vocale est fermé —, ou bien il s'est tu. Les deux se ressemblaient à l'écran,
 * et rien ne les départageait ; on pouvait chercher longtemps pourquoi le
 * volume ne baisse jamais.
 *
 * ## Ce que le test surveille
 *
 *  - **Deux causes, une icône, deux infobulles.** S'être tu et avoir été fait
 *    taire par un modérateur donnent le même silence — plus rien ne sort — mais
 *    pas le même recours : l'un se défait d'un clic par l'intéressé, l'autre
 *    non. Le serveur envoie donc les deux faits séparément et laisse le tableau
 *    de bord les formuler.
 *
 *  - **La place est tenue en permanence.** `visibility` et non `display` : sans
 *    cela, chaque personne qui coupe son micro décalerait son interrupteur, et
 *    la colonne des interrupteurs cesserait d'en être une. Cachée, l'icône sort
 *    en prime de l'arbre d'accessibilité, ce qu'une opacité nulle ne ferait
 *    pas — un lecteur d'écran annoncerait un micro coupé qui ne l'est pas.
 *
 *  - **Elle vit dans le temps.** Couper puis rouvrir son micro se voit sans
 *    recharger : l'état est relu à chaque diffusion, comme le nom ou le halo.
 *
 *  - **Elle reste lisible sur une ligne éteinte.** La détection désactivée fait
 *    tomber la ligne entière à moitié transparente ; l'icône y disparaissait
 *    presque, alors que c'est précisément là que la distinction compte.
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(
    path.join(ROOT, 'src', 'web', 'public', 'js', 'queue.js'), 'utf8');
const CSS = fs.readFileSync(
    path.join(ROOT, 'src', 'web', 'public', 'css', 'queue.css'), 'utf8');
const SERVER = fs.readFileSync(
    path.join(ROOT, 'src', 'web', 'WebServer.js'), 'utf8');
const FR = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'src', 'web', 'public', 'locales', 'fr.json'), 'utf8'));

let failed = 0;
let passed = 0;
const check = (label, ok, detail = '') => {
    if (ok) { passed++; console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`); }
    else { failed++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
};

console.log('\n=== Le micro coupé dans l\'activité vocale ===\n');

/* ══════════════════ Ce que le serveur envoie ══════════════════ */

console.log('Le fait, tel qu\'il voyage\n');

check('le serveur lit le micro sur l\'état vocal du membre',
    /selfMute: Boolean\(m\.voice\?\.selfMute\)/.test(SERVER)
    && /serverMute: Boolean\(m\.voice\?\.serverMute\)/.test(SERVER));
check('  … et garde les deux causes distinctes',
    !/mute: Boolean\(m\.voice\?\.mute\)/.test(SERVER),
    's\'être tu et avoir été fait taire n\'appellent pas la même phrase');

/*
 * Les deux infobulles doivent exister dans les quatre langues : une clé
 * manquante rendrait la clé elle-même, et l'utilisateur lirait
 * « tooltip_mic_muted » au survol.
 */
for (const lang of ['fr', 'en', 'es', 'de']) {
    const dict = JSON.parse(fs.readFileSync(
        path.join(ROOT, 'src', 'web', 'public', 'locales', `${lang}.json`), 'utf8'));
    check(`${lang} : les deux infobulles sont traduites`,
        Boolean(dict.tooltip_mic_muted) && Boolean(dict.tooltip_mic_muted_server),
        `${dict.tooltip_mic_muted} / ${dict.tooltip_mic_muted_server}`);
}

/* ══════════════════ Ce que la feuille de style tient ══════════════════ */

console.log('\nLa place réservée\n');

const muteRule = /\.speaker-mute \{([^}]*)\}/.exec(CSS);
check('l\'icône est cachée sans quitter la mise en page',
    Boolean(muteRule) && /visibility: hidden;/.test(muteRule[1])
    && !/display: none;/.test(muteRule[1]),
    'sinon l\'interrupteur se décale à chaque micro coupé');
check('  … et reprend la couleur des états « on ne l\'entend pas »',
    Boolean(muteRule) && /color: var\(--c-error\);/.test(muteRule[1]),
    'la même que Discord, où l\'utilisateur l\'a déjà apprise');

const shownRule = /\.speaker-mute\.is-muted \{([^}]*)\}/.exec(CSS);
check('elle réapparaît quand le micro se coupe',
    Boolean(shownRule) && /visibility: visible;/.test(shownRule[1]));

check('une ligne à détection désactivée la garde lisible',
    /\.speaker-item\.voice-disabled \.speaker-mute\.is-muted \{[^}]*opacity: 1;/.test(CSS),
    'c\'est là que la confusion entre les deux états coûtait le plus cher');

check('les animations refusées n\'emportent pas l\'icône',
    /@media \(prefers-reduced-motion: reduce\) \{[\s\S]{0,320}?\.speaker-mute \{[^}]*transform: none;/.test(CSS));

/* ══════════════════ Un DOM juste assez vrai ══════════════════ */

function makeElement(tag) {
    const listeners = {};
    const attributes = {};
    const classes = new Set();

    const el = {
        tagName: String(tag).toUpperCase(),
        children: [],
        parentNode: null,
        dataset: {},
        style: {},
        checked: false,
        type: '',
        src: '',
        alt: '',
        textContent: '',
        innerHTML: '',
        _listeners: listeners,
        _classes: classes,
        classList: {
            add: (...c) => c.forEach((x) => classes.add(x)),
            remove: (...c) => c.forEach((x) => classes.delete(x)),
            contains: (c) => classes.has(c),
            toggle: (c, force) => {
                const on = force === undefined ? !classes.has(c) : force;
                if (on) classes.add(c); else classes.delete(c);
                return on;
            },
        },
        setAttribute: (n, v) => { attributes[n] = String(v); },
        getAttribute: (n) => (n in attributes ? attributes[n] : null),
        addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
        appendChild: (c) => { c.parentNode = el; el.children.push(c); return c; },
        insertBefore: (c, ref) => {
            const i = ref ? el.children.indexOf(ref) : -1;
            c.parentNode = el;
            if (i < 0) el.children.push(c); else el.children.splice(i, 0, c);
            return c;
        },
        remove: () => {
            if (!el.parentNode) return;
            const i = el.parentNode.children.indexOf(el);
            if (i >= 0) el.parentNode.children.splice(i, 1);
            el.parentNode = null;
        },
        fire: (type, event = {}) => (listeners[type] || []).forEach((fn) => fn(event)),
    };

    Object.defineProperty(el, 'className', {
        get: () => [...classes].join(' '),
        set: (v) => {
            classes.clear();
            String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c));
        },
    });

    el.querySelectorAll = (sel) => matchAll(el, sel);
    el.querySelector = (sel) => matchAll(el, sel)[0] || null;
    return el;
}

function descendants(root, out = []) {
    for (const child of root.children) {
        out.push(child);
        descendants(child, out);
    }
    return out;
}

/** `.classe`, `tag`, `[attr="valeur"]` — tout le vocabulaire dont queue.js se sert. */
function matches(el, simple) {
    if (simple.startsWith('.')) return el._classes.has(simple.slice(1));
    const attr = /^\[([\w-]+)="([^"]*)"\]$/.exec(simple);
    if (attr) return el.getAttribute(attr[1]) === attr[2];
    return el.tagName === simple.toUpperCase();
}

function matchAll(root, selector) {
    let current = [root];
    for (const simple of selector.trim().split(/\s+/)) {
        const next = [];
        for (const node of current) {
            for (const candidate of descendants(node)) {
                if (matches(candidate, simple) && !next.includes(candidate)) next.push(candidate);
            }
        }
        current = next;
    }
    return current;
}

/** Monte le vrai queue.js et rend de quoi peindre la boîte. */
function mount() {
    const container = makeElement('div');
    // `innerHTML = '<div class="no-speakers">…'` sert à vider puis remplir : seul
    // le vidage compte pour ce qu'on éprouve ici.
    Object.defineProperty(container, 'innerHTML', {
        get: () => '',
        set: () => { container.children = []; },
    });

    const sent = [];
    const sandbox = {
        window: {
            MusicPlayer: {
                state: {},
                t: (key) => FR[key] || key,
                sendWS: (msg) => sent.push(msg),
            },
            addEventListener() {},
        },
        document: {
            getElementById: (id) => (id === 'speakers-list-container' ? container : null),
            createElement: makeElement,
            body: makeElement('body'),
            addEventListener() {},
            querySelectorAll: () => [],
        },
        console,
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(SOURCE, sandbox);

    return {
        container,
        sent,
        paint: (state) => {
            sandbox.window.MusicPlayer.state = state;
            sandbox.window.MusicPlayer.updateSpeakersUI();
        },
        rowOf: (id) => container.children.find((c) => c.getAttribute('data-user-id') === id),
    };
}

const MEMBER = { id: '111', displayName: 'WolfGang.PRoxa', avatar: null };

/* ══════════════════ Le comportement ══════════════════ */

console.log('\nCe que la boîte montre\n');

{
    const s = mount();
    s.paint({ members: [MEMBER], speakers: [], ignoredVoiceUsers: [] });

    const row = s.rowOf('111');
    check('la ligne du membre est peinte', Boolean(row));

    const badge = row.querySelector('.speaker-mute');
    check('l\'emplacement du micro existe dès le départ', Boolean(badge),
        'la place est tenue, muette ou non');
    check('  … et reste éteint tant que le micro est ouvert',
        badge && !badge._classes.has('is-muted'));

    /*
     * L'endroit compte : juste avant l'interrupteur, à droite du nom. C'est là
     * que le regard tombe en parcourant la colonne des interrupteurs.
     */
    const controls = row.querySelector('.speaker-controls');
    check('il est posé avant l\'interrupteur',
        controls && controls.children[0] === badge
        && controls.children[1]._classes.has('switch-mini'),
        controls ? controls.children.map((c) => c.className).join(' puis ') : '—');
}

{
    const s = mount();
    s.paint({
        members: [{ ...MEMBER, selfMute: true }],
        speakers: [], ignoredVoiceUsers: [],
    });

    const badge = s.rowOf('111').querySelector('.speaker-mute');
    check('un micro coupé s\'allume', badge._classes.has('is-muted'));
    check('  … et se nomme', badge.dataset.tooltip === 'Micro coupé',
        badge.dataset.tooltip);
}

{
    const s = mount();
    s.paint({
        members: [{ ...MEMBER, serverMute: true }],
        speakers: [], ignoredVoiceUsers: [],
    });

    const badge = s.rowOf('111').querySelector('.speaker-mute');
    check('un membre rendu muet par un modérateur s\'allume aussi',
        badge._classes.has('is-muted'));
    check('  … mais ne dit pas la même chose',
        badge.dataset.tooltip === 'Micro coupé par un modérateur',
        badge.dataset.tooltip);
}

console.log('\nCe qui change en cours de route\n');

{
    const s = mount();
    s.paint({ members: [MEMBER], speakers: [], ignoredVoiceUsers: [] });
    const badge = s.rowOf('111').querySelector('.speaker-mute');

    s.paint({
        members: [{ ...MEMBER, selfMute: true }],
        speakers: [], ignoredVoiceUsers: [],
    });
    check('couper son micro se voit sans recharger', badge._classes.has('is-muted'));

    s.paint({ members: [{ ...MEMBER, selfMute: false }], speakers: [], ignoredVoiceUsers: [] });
    check('  … et le rouvrir aussi', !badge._classes.has('is-muted'));

    check('la ligne n\'a pas été reconstruite au passage',
        s.rowOf('111').querySelector('.speaker-mute') === badge,
        'sinon l\'animation d\'apparition rejouerait à chaque diffusion');
}

{
    /*
     * Le cas qui a motivé le symbole : la détection vocale est coupée *et* le
     * micro l'est aussi. Les deux doivent rester distinguables, sans quoi on
     * cherche le mauvais coupable.
     */
    const s = mount();
    s.paint({
        members: [{ ...MEMBER, selfMute: true }],
        speakers: [],
        ignoredVoiceUsers: ['111'],
    });

    const row = s.rowOf('111');
    check('détection coupée et micro coupé se lisent ensemble',
        row._classes.has('voice-disabled')
        && row.querySelector('.speaker-mute')._classes.has('is-muted'),
        'deux faits sans rapport, et deux marques distinctes');
}

{
    // Un membre qui s'en va emporte sa ligne, badge compris.
    const s = mount();
    s.paint({
        members: [MEMBER, { id: '222', displayName: 'Autre', avatar: null, selfMute: true }],
        speakers: [], ignoredVoiceUsers: [],
    });
    check('deux membres, deux lignes', s.container.children.length === 2);

    s.paint({ members: [MEMBER], speakers: [], ignoredVoiceUsers: [] });
    check('  … et le départ de l\'un n\'emporte que la sienne',
        s.container.children.length === 1 && Boolean(s.rowOf('111')));
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
