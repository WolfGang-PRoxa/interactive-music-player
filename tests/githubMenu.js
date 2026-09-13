/**
 * Vérifie le sous-menu du bouton GitHub — le balisage, la feuille de style et
 * le vrai js/githubMenu.js, exécuté dans un DOM simulé.
 *
 * Un appui long sur le bouton GitHub déplie trois entrées : mettre le projet en
 * favori, le partager, signaler un problème. Quatre choses s'y jouent, et
 * aucune ne se voit dans un diff.
 *
 *  - **Le clic qui ouvre le menu ne doit pas ouvrir le dépôt.** GitHub est un
 *    lien, pas un bouton : arrêter la propagation ne suffit pas, il faut
 *    annuler l'action par défaut. Sans cela, on demande le sous-menu et l'on
 *    quitte la page — le menu s'ouvrirait dans un onglet qu'on ne regarde plus.
 *
 *  - **L'appui court, lui, doit toujours ouvrir le dépôt.** C'est le geste que
 *    le bouton avait avant ; un `preventDefault` posé trop large le supprimait.
 *
 *  - **Une seule adresse dans tout le projet.** Les trois entrées se déduisent
 *    du `href` du bouton. Trois adresses écrites à la main, c'est trois
 *    endroits à changer le jour d'un renommage, et deux qu'on oublie.
 *
 *  - **Un seul ressort pour les deux panneaux d'en-tête.** Le réglage fin du
 *    jour et de la nuit et ce menu s'ouvrent du même geste : ils doivent
 *    s'ouvrir de la même façon. L'animation est donc écrite une fois, dans
 *    `.header-pop`, et ce test vérifie qu'aucun des deux ne s'en est refait une.
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MARKUP = fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'index.html'), 'utf8');
const MODALS = fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'css', 'modals.css'), 'utf8');
const TOOLTIPS = fs.readFileSync(
    path.join(ROOT, 'src', 'web', 'public', 'js', 'tooltipSystem.js'), 'utf8');
const SOURCE = fs.readFileSync(
    path.join(ROOT, 'src', 'web', 'public', 'js', 'githubMenu.js'), 'utf8');

let failed = 0;
let passed = 0;
const check = (label, ok, detail = '') => {
    if (ok) { passed++; console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`); }
    else { failed++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
};

console.log('\n=== Le sous-menu de GitHub ===\n');

/* ═══════════════ Le balisage ═══════════════ */

console.log('Ce que la page déclare\n');

check('le lien et son menu partagent un ancrage',
    /<div class="gh-menu-anchor"/.test(MARKUP)
    && MARKUP.indexOf('gh-menu-anchor') < MARKUP.indexOf('id="btn-github"'),
    'le panneau se place par rapport à lui — le lien ne pouvait pas le porter');
check('le menu est replié au repos',
    /<div class="header-pop gh-menu-pop" id="gh-menu-pop" role="menu" hidden>/.test(MARKUP),
    '`hidden` : ni affiché, ni focalisable, ni lu');

for (const [id, key] of [['gh-menu-star', 'github_menu_star'],
    ['gh-menu-share', 'github_menu_share'],
    ['gh-menu-issue', 'github_menu_issue']]) {
    const entry = new RegExp(`id="${id}"[\\s\\S]{0,700}?data-i18n="${key}"`);
    check(`« ${key} » est une entrée du menu`, entry.test(MARKUP) && MARKUP.includes('role="menuitem"'));
}

/*
 * Le dépôt n'est nommé qu'une fois. Les deux liens du menu partent sans `href` :
 * le script le pose, à partir de celui du bouton.
 */
for (const id of ['gh-menu-star', 'gh-menu-issue']) {
    const tag = new RegExp(`<a class="gh-menu-item" id="${id}"[^>]*>`).exec(MARKUP);
    check(`« ${id} » n'écrit pas l'adresse une seconde fois`,
        !!tag && !/href=/.test(tag[0]),
        'un renommage du dépôt ne doit avoir qu’un seul endroit à visiter');
}

check('le module est chargé', /<script src="js\/githubMenu\.js"><\/script>/.test(MARKUP));
check('l\'appui long est annoncé sur le bouton',
    /id="btn-github"[^>]*data-tooltip-hint="tooltip_github_menu_hint"/.test(MARKUP),
    'une fonctionnalité qu\'on ne devine pas n\'existe que pour qui l\'a codée');

/*
 * L'indice est ajouté à l'affichage, par l'infobulle elle-même.
 *
 * Composé d'avance dans `data-tooltip`, il était effacé deux fois plutôt
 * qu'une : par la traduction que l'infobulle relit à chaque affichage, et par
 * `applyLanguage` à chaque changement de langue. Il s'écrivait bien, et ne
 * s'affichait jamais.
 */
check('  … et l\'infobulle sait l\'ajouter au libellé traduit',
    /data-tooltip-hint/.test(TOOLTIPS) && /text = text \? `\$\{text\}\\n\$\{hint\}`/.test(TOOLTIPS),
    'ajouté au libellé, pas à sa place');

/* ═══════════════ Le ressort, partagé ═══════════════ */

console.log('\nL\'apparition, la même que celle du réglage fin\n');

check('les deux panneaux portent la même classe',
    /class="header-pop gh-menu-pop"/.test(MARKUP) && /class="header-pop theme-blend-pop"/.test(MARKUP));
check('l\'apparition rebondit',
    /animation: header-pop-in [\d.]+s cubic-bezier\(0\.34, 1\.56, 0\.64, 1\)/.test(MODALS),
    'le dépassement du ressort tient dans la courbe');
check('  … depuis le bouton, pas depuis son propre centre',
    /\.header-pop \{[^}]*transform-origin: 50% 0;/.test(MODALS));

/*
 * Les images clés contiennent des accolades imbriquées : « [^}]* » s'arrête à
 * la première. Le bloc entier est donc découpé, puis on compte.
 */
const popIn = (/@keyframes header-pop-in \{[\s\S]*?\n\}/.exec(MODALS) || [''])[0];
check('  … en gardant son centrage à chaque image',
    popIn.split('translateX(-50%)').length - 1 === 2,
    'sans quoi le panneau se recentre d\'un bond à la fin');

check('`hidden` l\'emporte sur le display des contenus',
    /\.header-pop\[hidden\] \{[^}]*display: none;/.test(MODALS),
    'sans quoi le panneau ne se referme jamais');

/*
 * Ni l'un ni l'autre ne se refait une animation pour lui seul : deux copies
 * finissent toujours par diverger, et le geste ne serait plus le même des deux
 * côtés.
 */
for (const cls of ['theme-blend-pop', 'gh-menu-pop']) {
    const block = (new RegExp(`\\.${cls} \\{[^}]*\\}`).exec(MODALS) || [''])[0];
    check(`« .${cls} » n'a plus que sa forme`,
        block !== '' && !/animation|position: absolute/.test(block),
        'la surface et le ressort sont ceux de .header-pop');
}

check('la loupe d\'iOS ne s\'invite pas sur le lien',
    /#btn-github \{[^}]*-webkit-touch-callout: none;/.test(MODALS),
    'elle arriverait pile sur le geste qui déplie le menu');

/* ═══════════════ Le comportement ═══════════════ */

function makeElement(tag, doc) {
    const listeners = {};
    const classes = new Set();
    const el = {
        tagName: String(tag).toUpperCase(),
        children: [],
        hidden: false,
        dataset: {},
        _attrs: {},
        classList: {
            add: (...c) => c.forEach((x) => classes.add(x)),
            remove: (...c) => c.forEach((x) => classes.delete(x)),
            contains: (c) => classes.has(c),
        },
        setAttribute: (k, v) => { el._attrs[k] = String(v); },
        getAttribute: (k) => (k in el._attrs ? el._attrs[k] : null),
        /*
         * La phase est retenue : le module avale le clic qui suit un appui long
         * en écoutant *en capture*. Un double qui ignorerait la phase ne saurait
         * pas dire si le clic a bel et bien été arrêté.
         */
        addEventListener: (t, fn, opts) => {
            const capture = opts === true || (opts && opts.capture === true);
            (listeners[t] = listeners[t] || []).push({ fn, capture });
        },
        removeEventListener: (t, fn) => {
            if (listeners[t]) listeners[t] = listeners[t].filter((e) => e.fn !== fn);
        },
        appendChild: (c) => { el.children.push(c); return c; },
        contains: (n) => n === el || el.children.includes(n),
        focus: () => { if (doc) doc.activeElement = el; },
        /**
         * Déclenche un événement et rend ce qu'il en reste : `prevented` dit si
         * le navigateur aurait suivi le lien.
         */
        fire: (t, ev = {}) => {
            let stopped = false;
            const out = { prevented: false, reached: false };
            const event = Object.assign({
                preventDefault() { out.prevented = true; },
                stopPropagation() { stopped = true; },
                target: el, clientX: 0, clientY: 0, button: 0,
            }, ev);

            const queue = (listeners[t] || []).slice()
                .sort((a, b) => Number(b.capture) - Number(a.capture));
            for (const entry of queue) {
                if (stopped && !entry.capture) break;
                if (!entry.capture) out.reached = true;
                entry.fn(event);
            }
            return out;
        },
    };
    return el;
}

const HREF = 'https://github.com/WolfGang-PRoxa/interactive-music-player';

/** Monte le vrai module avec une horloge, un presse-papier et des doubles. */
function mount({ href = HREF, share = null } = {}) {
    const doc = { activeElement: null, title: 'Music Player' };

    const button = makeElement('a', doc);
    const pop = makeElement('div', doc);
    const star = makeElement('a', doc);
    const shareItem = makeElement('button', doc);
    const issue = makeElement('a', doc);

    button.setAttribute('href', href);
    pop.hidden = true;
    [star, shareItem, issue].forEach((item) => pop.appendChild(item));

    const known = {
        'btn-github': button,
        'gh-menu-pop': pop,
        'gh-menu-star': star,
        'gh-menu-share': shareItem,
        'gh-menu-issue': issue,
    };

    const timers = [];
    const docListeners = {};
    const toasts = [];
    const copied = [];

    doc.documentElement = makeElement('html', doc);
    doc.getElementById = (id) => known[id] || null;
    doc.addEventListener = (t, fn) => { (docListeners[t] = docListeners[t] || []).push(fn); };

    const sandbox = {
        window: {
            MusicPlayer: {
                t: (k) => k,
                showToast: (m) => toasts.push(m),
                copyToClipboard: async (text) => { copied.push(text); return true; },
            },
        },
        document: doc,
        setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
        clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].fn = null; },
        Math, Number, String, Promise, console,
    };
    if (share) sandbox.navigator = { share };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(SOURCE, sandbox);

    return {
        button, pop, star, share: shareItem, issue, doc, toasts, copied,
        /** Déclenche les minuteries dont le délai est atteint. */
        runTimers: (upTo = Infinity) => {
            for (const timer of timers.slice()) {
                if (timer.fn && timer.ms <= upTo) { const f = timer.fn; timer.fn = null; f(); }
            }
        },
        doc_: (type, ev) => (docListeners[type] || []).forEach((fn) => fn(Object.assign({
            target: makeElement('div', doc), preventDefault() {},
        }, ev))),
    };
}

console.log('\nL\'appui long, et le clic qui ne l\'est pas\n');

{
    const s = mount();
    check('le menu est fermé au départ', s.pop.hidden === true);

    s.button.fire('pointerdown');
    check('  … et le reste tant qu\'on n\'a pas attendu', s.pop.hidden === true);

    s.runTimers();
    check('l\'appui long l\'ouvre', s.pop.hidden === false);
    check('  … et le focus part sur la première entrée', s.doc.activeElement === s.star,
        'ouvert au clavier, le menu doit se parcourir sans le retrouver à la tabulation');

    const click = s.button.fire('click');
    check('le clic qui suit n\'ouvre pas le dépôt', click.prevented === true,
        'on demanderait le sous-menu et l\'on quitterait la page');
    check('  … et ne réveille pas le reste de l\'en-tête', click.reached === false);
}

{
    const s = mount();
    const click = s.button.fire('click');
    check('un appui court ouvre toujours le dépôt', click.prevented === false,
        'c\'est le geste que le bouton avait avant');
}

{
    const s = mount();
    s.button.fire('pointerdown');
    s.button.fire('pointermove', { clientX: 30, clientY: 0 });
    s.runTimers();
    check('un doigt qui glisse n\'ouvre rien', s.pop.hidden === true,
        'sur écran tactile, un début de défilement passerait sinon pour un appui maintenu');
}

{
    const s = mount();
    s.button.fire('pointerdown');
    s.runTimers();
    s.button.fire('click');

    const second = s.button.fire('click');
    s.runTimers();
    check('un second clic sur le bouton referme le menu', s.pop.hidden === true);
    check('  … sans partir sur GitHub au passage', second.prevented === true,
        'le seul moyen de ranger le menu depuis le bouton était de quitter la page');
}

console.log('\nLes trois adresses\n');

{
    const s = mount();
    check('le favori mène au dépôt', s.star.getAttribute('href') === HREF);
    check('l\'issue mène au formulaire', s.issue.getAttribute('href') === `${HREF}/issues/new`);
}

{
    const s = mount({ href: `${HREF}.git/` });
    check('le « .git » et la barre finale sont retirés',
        s.issue.getAttribute('href') === `${HREF}/issues/new`,
        '« …player.git/issues/new » ne mène nulle part');
}

console.log('\nCe que font les trois entrées\n');

/** Laisse se dénouer les promesses du module — la copie en traverse plusieurs. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

(async () => {
    {
        const s = mount();
        s.button.fire('pointerdown');
        s.runTimers();
        s.star.fire('click');
        s.runTimers();
        check('le favori dit où trouver l\'étoile', /Star|star/.test(s.toasts.join(' ')),
            'GitHub ne laisse pas poser l\'étoile depuis une autre page');
        check('  … et range le menu', s.pop.hidden === true);
    }

    {
        const shared = [];
        const s = mount({ share: (data) => { shared.push(data); return Promise.resolve(); } });
        s.share.fire('click');
        await tick();
        check('le partage passe par la feuille du système quand elle existe',
            shared.length === 1 && shared[0].url === HREF);
        check('  … et ne double pas d\'une notification', s.toasts.length === 0);
    }

    {
        const s = mount({ share: () => Promise.reject(Object.assign(new Error('nope'), { name: 'AbortError' })) });
        s.share.fire('click');
        await tick();
        check('un partage abandonné ne dit rien', s.toasts.length === 0 && s.copied.length === 0,
            'l\'utilisateur a refermé la feuille, il le sait');
    }

    {
        const s = mount();
        s.share.fire('click');
        await tick();
        check('sans feuille de partage, l\'adresse est copiée',
            s.copied.length === 1 && s.copied[0] === HREF,
            'le tableau de bord tourne souvent en HTTP simple, où `navigator.share` n\'existe pas');
        check('  … et la copie est annoncée', s.toasts.length === 1);
    }

    {
        const s = mount();
        s.button.fire('pointerdown');
        s.runTimers();
        s.issue.fire('click');
        s.runTimers();
        check('l\'issue range le menu derrière elle', s.pop.hidden === true);
    }

    console.log('\nLe clavier, et le reste de la page\n');

    {
        const s = mount();
        s.button.fire('pointerdown');
        s.runTimers();

        s.doc_('keydown', { key: 'ArrowDown' });
        check('la flèche descend d\'une entrée', s.doc.activeElement === s.share);
        s.doc_('keydown', { key: 'ArrowUp' });
        check('  … et remonte', s.doc.activeElement === s.star);
        s.doc_('keydown', { key: 'ArrowUp' });
        check('  … en bouclant', s.doc.activeElement === s.issue,
            'un menu qui perd son focus à la première flèche fait défiler la page derrière lui');

        s.doc_('keydown', { key: 'Escape' });
        s.runTimers();
        check('Échap referme', s.pop.hidden === true);
        check('  … et rend le focus au bouton', s.doc.activeElement === s.button);
    }

    {
        const s = mount();
        s.button.fire('pointerdown');
        s.runTimers();
        s.doc_('pointerdown');
        s.runTimers();
        check('un clic ailleurs referme', s.pop.hidden === true);

        // Le drapeau du clic à avaler ne survit pas à la fermeture : sans cela,
        // le clic suivant sur le bouton était avalé à son tour.
        const click = s.button.fire('click');
        check('  … et le bouton retrouve son clic', click.prevented === false,
            'le dépôt ne s\'ouvrait plus qu\'une fois sur deux');
    }

    {
        const s = mount();
        check('le menu du navigateur reste permis au repos',
            s.button.fire('contextmenu').prevented === false);
        s.button.fire('pointerdown');
        check('  … et se tait pendant l\'appui',
            s.button.fire('contextmenu').prevented === true,
            '« Ouvrir dans un nouvel onglet » arriverait par-dessus le nôtre');
    }

    console.log('\nLes libellés\n');

    for (const lang of ['fr', 'en', 'es', 'de']) {
        const dict = JSON.parse(fs.readFileSync(
            path.join(ROOT, 'src', 'web', 'public', 'locales', `${lang}.json`), 'utf8'));
        const keys = ['tooltip_github_menu_hint', 'github_menu_star', 'github_menu_share',
            'github_menu_issue', 'toast_github_star_hint', 'toast_github_link_copied',
            'toast_github_link_failed'];
        const missing = keys.filter((k) => !dict[k]);
        check(`${lang} : les libellés du menu sont traduits`, missing.length === 0,
            missing.length ? missing.join(', ') : dict.github_menu_star);
    }

    console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
    process.exit(failed > 0 ? 1 : 0);
})();
