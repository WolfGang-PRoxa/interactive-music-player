/**
 * Vérifie la copie du numéro de version — le vrai js/versions.js, exécuté dans
 * un DOM simulé.
 *
 * Le numéro affiché en pied de tiroir finit toujours par être recopié à la
 * main : dans un message, un rapport de bug, une question au dépôt. Le rendre
 * cliquable supprime la transcription, et avec elle la faute de frappe qui fait
 * chercher un défaut dans la mauvaise version.
 *
 * Quatre choses portent le sens, et aucune ne se voit dans un diff.
 *
 *  - **C'est le texte affiché qui part**, pas une valeur reconstruite en
 *    coulisses. On copie ce qu'on voit — « DEV (1.0.0) » pour du code en cours
 *    d'écriture, ce qui dit à la fois qu'il ne s'agit pas d'une release et de
 *    quelle base elle part. Reconstruire donnerait un jour deux vérités.
 *
 *  - **Le refus se dit.** Hors contexte sécurisé — et le tableau de bord est
 *    couramment servi en HTTP simple sur une adresse de réseau local —
 *    `navigator.clipboard` n'existe pas, et le repli `execCommand` est refusé
 *    par certains navigateurs. Rester muet laisserait coller le contenu d'avant
 *    en croyant tenir la version.
 *
 *  - **Le double s'en va, l'original reste.** Copier ne déplace rien : c'est un
 *    exemplaire de plus qu'on prend. Un décalque monte donc et se dissout
 *    pendant que la valeur ne bouge pas. Il se retire de lui-même, sans quoi il
 *    resterait posé sur le bouton.
 *
 *  - **Un vrai bouton, désactivé tant qu'il n'y a rien à copier.** Un `<span>`
 *    qu'on écoute serait hors de portée du clavier, et le tiret affiché avant
 *    que la version ne soit connue ne rendrait service à personne dans le
 *    presse-papier.
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(
    path.join(ROOT, 'src', 'web', 'public', 'js', 'versions.js'), 'utf8');
const MARKUP = fs.readFileSync(
    path.join(ROOT, 'src', 'web', 'public', 'index.html'), 'utf8');
const CSS = fs.readFileSync(
    path.join(ROOT, 'src', 'web', 'public', 'css', 'drawer.css'), 'utf8');

let failed = 0;
let passed = 0;
const check = (label, ok, detail = '') => {
    if (ok) { passed++; console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`); }
    else { failed++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
};

console.log('\n=== Copier le numéro de version ===\n');

/* ════════════════════ Ce que le balisage déclare ════════════════════ */

console.log('Le balisage et la feuille de style\n');

const BUTTON = /<button type="button" class="drawer-footer-value" id="drawer-version-value"([\s\S]{0,240}?)>/
    .exec(MARKUP);

check('la version est un vrai bouton', Boolean(BUTTON),
    'un <span> qu\'on écoute serait hors de portée du clavier');
check('  … désactivé tant que la version est inconnue',
    Boolean(BUTTON) && /\bdisabled\b/.test(BUTTON[1]),
    'le tiret affiché au départ n\'a rien à faire dans le presse-papier');
check('  … et il dit ce qu\'il fait',
    Boolean(BUTTON) && /data-i18n-tooltip="tooltip_copy_version"/.test(BUTTON[1]));

/*
 * Un bouton traîne son apparence par défaut. Sans reprise, le pied du tiroir
 * gagnerait un rectangle gris au milieu de sa ligne.
 */
const valueRule = /\.drawer-footer-value \{([^}]*)\}/.exec(CSS);
check('l\'apparence de bouton est défaite',
    Boolean(valueRule) && /background: none;/.test(valueRule[1])
    && /font: inherit;/.test(valueRule[1]),
    'sinon un rectangle gris au milieu du pied');
check('  … et le double a de quoi se poser', Boolean(valueRule)
    && /position: relative;/.test(valueRule[1]));

const ghostRule = /\.version-ghost \{([^}]*)\}/.exec(CSS);
check('le double reprend le remplissage du bouton',
    Boolean(ghostRule) && /padding: inherit;/.test(ghostRule[1]),
    'sinon il part décalé de l\'original, ce qui se voit précisément');
check('  … et ne prend aucun clic',
    Boolean(ghostRule) && /pointer-events: none;/.test(ghostRule[1]));

check('animations refusées : le double ne part pas',
    /@media \(prefers-reduced-motion: reduce\) \{[\s\S]{0,220}?\.version-ghost \{ animation: none;/.test(CSS));
check('  … mais la confirmation demeure',
    /\.drawer-footer-value\.is-copied \{[^}]*color: var\(--c-success\);/.test(CSS),
    'une copie silencieuse laisserait douter qu\'elle a eu lieu');

/* ════════════════════ Un DOM juste assez vrai ════════════════════ */

function makeElement(tag) {
    const listeners = {};
    const attributes = {};
    const classes = new Set();

    const el = {
        tagName: String(tag).toUpperCase(),
        children: [],
        parentNode: null,
        disabled: false,
        _text: '',
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
        addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
        removeEventListener: () => {},
        appendChild: (c) => { c.parentNode = el; el.children.push(c); return c; },
        removeChild: (c) => {
            const i = el.children.indexOf(c);
            if (i >= 0) el.children.splice(i, 1);
            c.parentNode = null;
            return c;
        },
        fire: (type) => (listeners[type] || []).forEach((fn) => fn({})),
    };

    Object.defineProperty(el, 'className', {
        get: () => [...classes].join(' '),
        set: (v) => { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
    });

    /*
     * `textContent` comme le vrai : il rend le texte de l'élément **et de tous
     * ses descendants**, et l'écrire efface les enfants.
     *
     * Une simple propriété de chaîne, plus simple à écrire, cachait exactement
     * le défaut qu'il fallait voir : le double en vol est un enfant du bouton,
     * si bien qu'un second clic lisait « DEV (1.0.0)DEV (1.0.0) » et le copiait
     * tel quel. Un DOM simulé qui ment sur ce point donne un test qui rassure
     * à tort.
     */
    Object.defineProperty(el, 'textContent', {
        get: () => el._text + el.children.map((c) => c.textContent).join(''),
        set: (v) => { el.children.forEach((c) => { c.parentNode = null; }); el.children = []; el._text = String(v); },
    });

    /** `.classe` en profondeur — tout ce dont versions.js se sert ici. */
    const descend = (root, out = []) => {
        for (const child of root.children) { out.push(child); descend(child, out); }
        return out;
    };
    el.querySelectorAll = (sel) => descend(el)
        .filter((n) => sel.startsWith('.') && n._classes.has(sel.slice(1)));
    el.querySelector = (sel) => el.querySelectorAll(sel)[0] || null;

    return el;
}

/**
 * Monte le vrai module, avec une horloge et un presse-papier sous la main.
 *
 * @param {{ copyWorks?: boolean, reduced?: boolean, version?: object|null }} options
 */
function mount(options = {}) {
    const copyWorks = options.copyWorks !== false;
    const reduced = Boolean(options.reduced);
    const version = options.version === undefined
        ? { tag: 'v1.4.0', type: 'release' }
        : options.version;

    const button = makeElement('button');
    button.disabled = true;
    button.textContent = '—';

    const known = { 'drawer-version-value': button };

    const copied = [];
    const toasts = [];
    let clock = 0;
    let nextTimer = 1;
    const timers = new Map();

    const sandbox = {
        window: {
            MusicPlayer: {
                copyToClipboard: async (text) => { copied.push(text); return copyWorks; },
                showToast: (message) => { toasts.push(message); },
            },
            matchMedia: () => ({ matches: reduced }),
        },
        document: {
            readyState: 'complete',
            getElementById: (id) => known[id] || null,
            createElement: makeElement,
            addEventListener() {},
        },
        // La version est servie en HTTP : le module la demande au démarrage.
        fetch: async () => ({
            ok: version !== null,
            json: async () => version,
        }),
        setTimeout: (fn, ms) => {
            const id = nextTimer++;
            timers.set(id, { fn, at: clock + (Number(ms) || 0) });
            return id;
        },
        clearTimeout: (id) => { timers.delete(id); },
        console,
    };
    sandbox.globalThis = sandbox;
    sandbox.window.matchMedia = sandbox.window.matchMedia;
    vm.createContext(sandbox);
    vm.runInContext(SOURCE, sandbox);

    /** Laisse les promesses en attente se résoudre. */
    const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

    /** Avance l'horloge et déclenche les minuteries échues. */
    const advance = (ms) => {
        clock += ms;
        for (const [id, timer] of [...timers]) {
            if (timer.at <= clock) {
                timers.delete(id);
                timer.fn();
            }
        }
    };

    return { button, copied, toasts, settle, advance, ghosts: () => button.children };
}

/* ════════════════════ Le comportement ════════════════════ */

(async () => {

    console.log('\nCe qui part dans le presse-papier\n');

    {
        const s = mount();
        await s.settle();

        check('la version connue déverrouille le bouton', s.button.disabled === false);
        check('  … et s\'affiche', s.button.textContent === 'v1.4.0', s.button.textContent);

        s.button.fire('click');
        await s.settle();

        check('cliquer copie le texte affiché', s.copied[0] === 'v1.4.0',
            s.copied[0] || 'rien n\'a été copié');
        check('  … et rien n\'est signalé à l\'écran', s.toasts.length === 0,
            'l\'animation est la confirmation');
    }

    {
        // Le cas qui interdit de reconstruire la valeur : pour du code en cours
        // d'écriture, ce qu'on voit n'est pas le tag mais une forme composée.
        const s = mount({ version: { tag: 'dev', type: 'dev', packageVersion: '1.0.0' } });
        await s.settle();

        check('une version de développement s\'affiche comme telle',
            s.button.textContent === 'DEV (1.0.0)', s.button.textContent);

        s.button.fire('click');
        await s.settle();
        check('  … et c\'est cette forme-là qui est copiée',
            s.copied[0] === 'DEV (1.0.0)', s.copied[0] || 'rien');
    }

    {
        const s = mount({ version: null });
        await s.settle();

        check('sans version connue, le bouton reste inerte', s.button.disabled === true);
        s.button.fire('click');
        await s.settle();
        check('  … et un clic ne copie rien', s.copied.length === 0);
    }

    console.log('\nLe double s\'envole, l\'original reste\n');

    {
        const s = mount();
        await s.settle();
        s.button.fire('click');
        await s.settle();

        const ghost = s.ghosts()[0];
        check('un décalque se détache', Boolean(ghost)
            && ghost._classes.has('version-ghost'));
        check('  … portant le même texte', ghost && ghost.textContent === 'v1.4.0',
            ghost ? ghost.textContent : '—');
        check('  … et masqué aux lecteurs d\'écran',
            ghost && ghost.getAttribute('aria-hidden') === 'true',
            'le texte est déjà lu sur le bouton');
        /*
         * L'original ne bouge pas : c'est le propre d'une copie. On mesure son
         * texte propre, et non `textContent`, qui vaut ici « v1.4.0v1.4.0 » —
         * le bouton plus son double. C'est très exactement cette concaténation
         * qui partait autrefois dans le presse-papier.
         */
        check('la valeur, elle, ne bouge pas', s.button._text === 'v1.4.0', s.button._text);
        check('  … et le double n\'existe que comme enfant du bouton',
            s.button.textContent === 'v1.4.0v1.4.0',
            'la raison pour laquelle le libellé se lit sur le modèle');

        check('le bouton s\'enfonce', s.button._classes.has('is-pressed'));
        s.advance(150);
        check('  … puis se relève', !s.button._classes.has('is-pressed'));

        check('la confirmation s\'allume', s.button._classes.has('is-copied'));
        s.advance(1000);
        check('  … puis s\'éteint', !s.button._classes.has('is-copied'));

        // Le double se retire de lui-même : sans cela il resterait posé sur la
        // valeur, qu'il recouvre exactement.
        ghost.fire('animationend');
        check('le décalque se retire à la fin de son vol', s.ghosts().length === 0);
    }

    {
        // Le filet : un moteur qui n'animerait rien ne déclencherait jamais
        // `animationend`, et le double resterait là pour toujours.
        const s = mount();
        await s.settle();
        s.button.fire('click');
        await s.settle();

        check('un double jamais animé finit tout de même par partir',
            s.ghosts().length === 1 && (s.advance(1500), s.ghosts().length === 0));
    }

    {
        /*
         * Le défaut trouvé à l'usage, et la raison d'être de ce bloc.
         *
         * Le double en vol est un enfant du bouton. Lire le libellé sur
         * `button.textContent` rendait donc, au deuxième clic tombé avant la fin
         * du vol, « DEV (1.0.0)DEV (1.0.0) » — chaîne copiée telle quelle dans
         * le presse-papier, puis recopiée dans le double suivant, qui
         * grossissait à chaque clic jusqu'à barrer le pied du tiroir.
         *
         * Le libellé vient désormais du modèle, et un seul double vole à la
         * fois : cliquer vite relance le vol au lieu d'empiler des calques.
         */
        const s = mount();
        await s.settle();

        for (let i = 0; i < 6; i++) {
            s.button.fire('click');
            await s.settle();
        }

        check('cliquer vite ne laisse qu\'un seul double', s.ghosts().length === 1,
            `${s.ghosts().length} décalque(s)`);
        check('  … qui porte le libellé, et rien de plus',
            s.ghosts()[0].textContent === 'v1.4.0',
            s.ghosts()[0].textContent);
        check('  … et chaque copie reste le seul numéro de version',
            s.copied.length === 6 && s.copied.every((c) => c === 'v1.4.0'),
            [...new Set(s.copied)].join(' | '));
        // Le texte propre du bouton — celui qui reste quand le double s'en va.
        check('la valeur affichée n\'a pas enflé', s.button._text === 'v1.4.0',
            s.button._text);
    }

    console.log('\nQuand le presse-papier se refuse\n');

    {
        const s = mount({ copyWorks: false });
        await s.settle();
        s.button.fire('click');
        await s.settle();

        check('le refus est dit', s.toasts.length === 1, s.toasts[0] || 'rien');
        check('  … et rien ne prétend le contraire',
            !s.button._classes.has('is-copied') && s.ghosts().length === 0,
            'une confirmation mensongère ferait coller le contenu d\'avant');
        check('l\'enfoncement a tout de même eu lieu',
            s.button._classes.has('is-pressed'),
            'il accuse le clic, pas son résultat');
    }

    console.log('\nQuand les animations sont refusées\n');

    {
        const s = mount({ reduced: true });
        await s.settle();
        s.button.fire('click');
        await s.settle();

        check('aucun double ne part', s.ghosts().length === 0);
        check('  … mais la copie a bien lieu', s.copied[0] === 'v1.4.0');
        check('  … et la confirmation reste visible', s.button._classes.has('is-copied'),
            'sans quoi rien ne dirait que la copie a eu lieu');
    }

    console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
    process.exit(failed > 0 ? 1 : 0);
})();
