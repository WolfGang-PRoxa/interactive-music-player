/**
 * Vérifie qu'on entre une fois, et qu'on peut ensuite changer de compte.
 *
 * La porte d'entrée ne se franchissait qu'une fois — la session vit trente
 * jours, se prolonge à chaque requête et survit aux redémarrages — mais elle
 * n'avait aucune sortie. On entrait pour de bon, et changer de compte demandait
 * de supprimer un cookie à la main.
 *
 * Quatre choses portent le sens, et trois ne se voient pas dans un diff.
 *
 *  - **Discord doit être prié de proposer ses comptes.** Le trajet ordinaire
 *    demande `prompt=none`, qui rouvre en silence la session déjà ouverte chez
 *    lui : c'est ce qu'il faut partout, et exactement ce qu'il ne faut pas quand
 *    on vient précisément pour en changer. Sans ce détour, le bouton rouvrirait
 *    le même compte sans rien dire — une panne muette.
 *
 *  - **La propriété suit celui qui tient le jeton**, parce que tenir le jeton
 *    veut dire être devant la machine. Aucun pouvoir n'est accordé au passage :
 *    qui le tient pouvait déjà supprimer `data/owner.json`. Mais `claim` refuse
 *    d'écraser — c'est tout son contrat — d'où un `transfer` distinct.
 *
 *  - **On ne ferme qu'une session, la sienne.** Le téléphone resté sur la table
 *    n'a pas à tomber parce qu'on change de compte sur le PC.
 *
 *  - **Le bouton se maintient.** Un geste dont on ne revient pas d'un clic
 *    malheureux, comme la réinitialisation générale au bas de la même fenêtre.
 *
 * Les modules du serveur sont éprouvés pour de vrai, dans un dossier de travail
 * jetable : ils écrivent dans `data/` du répertoire courant, et le test n'a rien
 * à faire près des sessions réelles.
 */
const fs = require('fs');
const os = require('os');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let failed = 0;
let passed = 0;
const check = (label, ok, detail = '') => {
    if (ok) { passed++; console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`); }
    else { failed++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
};

/*
 * Dossier jetable, choisi avant tout `require`.
 *
 * `sessions.js` et `owner.js` figent leur chemin de fichier au chargement, à
 * partir du répertoire courant : s'y placer d'abord est la seule façon de les
 * éprouver sans écrire à côté des vraies sessions.
 */
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'compte-'));
fs.mkdirSync(path.join(SANDBOX, 'data'));
const CWD = process.cwd();
process.chdir(SANDBOX);

process.env.DISCORD_CLIENT_ID = 'client-de-test';
process.env.DISCORD_CLIENT_SECRET = 'secret-de-test';
process.env.PUBLIC_URL = 'https://exemple.test';

const sessions = require(path.join(ROOT, 'src', 'web', 'sessions.js'));
const owner = require(path.join(ROOT, 'src', 'web', 'owner.js'));
const oauth = require(path.join(ROOT, 'src', 'web', 'oauth.js'));

console.log('\n=== Entrer une fois, puis changer de compte ===\n');

// ───────────────────── Ce que Discord doit proposer ─────────────────────

console.log('Ce qui est demandé à Discord\n');

{
    const ordinaire = new URL(oauth.buildAuthorizeUrl('/', { holdsToken: true }));
    check('un trajet ordinaire rouvre en silence',
        ordinaire.searchParams.get('prompt') === 'none',
        'l\'invité a déjà dit oui, et le bot ne demande que son nom');

    const changement = new URL(oauth.buildAuthorizeUrl('/', { holdsToken: true, claim: true }));
    check('un changement de compte fait apparaître le sélecteur',
        changement.searchParams.get('prompt') === 'consent',
        'sinon le bouton rouvrirait le même compte, sans rien dire');

    // Le rappel arrive sur PUBLIC_URL, où aucun de nos cookies n'existe :
    // l'intention ne peut voyager que dans le `state`, que ce serveur a émis.
    const route = oauth.consumeState(changement.searchParams.get('state'));
    check('l\'intention voyage dans le state', route && route.claim === true
        && route.holdsToken === true,
        'le rappel arrive sur une origine sans nos cookies');

    check('  … et ne sert qu\'une fois',
        oauth.consumeState(changement.searchParams.get('state')) === null,
        'un rappel rejoué ouvrirait une seconde session');

    const sans = new URL(oauth.buildAuthorizeUrl('/', { holdsToken: false }));
    check('un trajet sans intention n\'en invente pas',
        oauth.consumeState(sans.searchParams.get('state')).claim === false);
}

// ───────────────────── La sortie ─────────────────────

console.log('\nCe que ferme une déconnexion\n');

{
    const paul = { id: '111', username: 'paul' };
    const marie = { id: '222', username: 'marie' };

    const ancienne = sessions.create(paul);
    const nouvelle = sessions.create(paul);

    /*
     * Une identité n'a jamais qu'une session à la fois : `create` ferme les
     * précédentes du même compte. Se reconnecter quelque part décroche donc ce
     * qui était ouvert ailleurs, et c'est le comportement d'avant — noté ici
     * parce qu'il se lit mal dans le code et qu'il surprend.
     */
    check('se reconnecter remplace la session du compte',
        sessions.get(ancienne.id) === null && sessions.get(nouvelle.id) !== null,
        'une identité n\'en a jamais deux à la fois');

    // Celle d'un autre compte n'a rien à voir là-dedans.
    const celleDeMarie = sessions.create(marie);

    check('la session en cours se ferme', sessions.destroy(nouvelle.id) === true
        && sessions.get(nouvelle.id) === null);

    check('  … sans toucher à celle d\'un autre compte',
        sessions.get(celleDeMarie.id) !== null,
        'on ne quitte que la sienne');

    check('fermer deux fois ne casse rien', sessions.destroy(nouvelle.id) === false);
    check('fermer un cookie inventé non plus',
        sessions.destroy('jamais-vu') === false && sessions.destroy('') === false);

    // La révocation, elle, vise un compte plutôt qu'un navigateur.
    sessions.revokeUser('222');
    check('une révocation vise le compte, pas le navigateur',
        sessions.get(celleDeMarie.id) === null);
}

// ───────────────────── La propriété ─────────────────────

console.log('\nCe que la propriété devient\n');

{
    owner.forget();
    const paul = { id: '111', username: 'paul' };
    const marie = { id: '222', username: 'marie' };

    check('la première revendication prend', owner.claim(paul) === true
        && owner.get().id === '111');

    // Le contrat de `claim` est de ne jamais écraser : c'est ce qui empêche un
    // second compte de s'emparer d'une installation déjà nommée.
    check('  … et une seconde ne l\'écrase pas', owner.claim(marie) === false
        && owner.get().id === '111');

    check('le transfert, lui, écrase — c\'est son objet',
        owner.transfer(marie) === true && owner.get().id === '222',
        'demandé par qui tient le jeton, donc est devant la machine');

    check('  … et il survit au redémarrage',
        JSON.parse(fs.readFileSync(path.join(SANDBOX, 'data', 'owner.json'), 'utf8')).id === '222');

    check('l\'ancien propriétaire n\'en est plus un',
        owner.isOwner({ userId: '111' }) === false
        && owner.isOwner({ userId: '222' }) === true);

    check('un transfert sans compte ne fait rien',
        owner.transfer(null) === false && owner.get().id === '222');
}

process.chdir(CWD);
fs.rmSync(SANDBOX, { recursive: true, force: true });

// ───────────────────── Le bouton ─────────────────────

console.log('\nCe que fait le bouton, et ce qu\'il refuse de faire\n');

const SOURCE = fs.readFileSync(
    path.join(ROOT, 'src', 'web', 'public', 'js', 'account.js'), 'utf8');

function makeElement(id) {
    const classes = new Set(['hidden']);
    const attrs = new Map();
    const listeners = {};
    return {
        id,
        textContent: '',
        style: {},
        classList: {
            add: (n) => classes.add(n),
            remove: (n) => classes.delete(n),
            toggle(n, on) { if (on) classes.add(n); else classes.delete(n); },
            contains: (n) => classes.has(n),
        },
        setAttribute: (n, v) => attrs.set(n, v),
        getAttribute: (n) => (attrs.has(n) ? attrs.get(n) : null),
        set src(v) { attrs.set('src', v); },
        get src() { return attrs.get('src'); },
        addEventListener: (type, fn) => { listeners[type] = fn; },
        querySelector: () => ({ style: {} }),
        fire: (type, e = {}) => { if (listeners[type]) listeners[type](e); },
        listeners,
    };
}

function mount() {
    const els = {};
    for (const id of ['account-section', 'account-name', 'account-avatar',
        'account-owner-note', 'account-guest-note', 'btn-switch-account']) {
        els[id] = makeElement(id);
    }

    const fetched = [];
    let horloge = null;
    let maintenant = 1000;
    const navigation = { href: '/tableau' };

    const sandbox = {
        window: { MusicPlayer: {}, location: navigation },
        document: { getElementById: (id) => els[id] || null },
        fetch: (url, options) => {
            fetched.push({ url, method: options && options.method });
            return Promise.resolve({ ok: true });
        },
        setInterval: (fn) => { horloge = fn; return 1; },
        clearInterval: () => { horloge = null; },
        Date: { now: () => maintenant },
        encodeURIComponent,
        console,
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(SOURCE, sandbox);

    return {
        els, fetched, navigation,
        api: sandbox.window.MusicPlayer,
        /** Presse le bouton, laisse filer le temps, puis relâche. */
        hold: (ms) => {
            els['btn-switch-account'].fire('mousedown', { button: 0, preventDefault() {} });
            maintenant += ms;
            if (horloge) horloge();
            els['btn-switch-account'].fire('mouseup');
        },
        settled: () => new Promise((r) => setImmediate(r)),
    };
}

(async () => {
    {
        const m = mount();
        check('sans identité, la section reste absente',
            m.els['account-section'].classList.contains('hidden'),
            'entré par le jeton seul, il n\'y a pas de compte à nommer');

        m.api.refreshAccount({
            role: 'master', holdsToken: true,
            identity: { displayName: 'Paul', avatar: 'a.png' },
        });
        check('le compte connecté est nommé',
            m.els['account-name'].textContent === 'Paul'
            && !m.els['account-section'].classList.contains('hidden'));
        check('  … avec sa pastille', m.els['account-avatar'].src === 'a.png'
            && !m.els['account-avatar'].classList.contains('hidden'));

        check('devant la machine, le maître est prévenu de ce qu\'il emporte',
            !m.els['account-owner-note'].classList.contains('hidden')
            && m.els['account-guest-note'].classList.contains('hidden'));

        /*
         * Le même maître, ouvert depuis un autre poste.
         *
         * Être maître se lit sur le compte Discord et vaut de partout ; tenir le
         * jeton dit qu'on est devant la machine qui lance le bot, et seul le
         * second fait suivre la propriété. Lui promettre un transfert à distance
         * serait lui annoncer ce qui n'arrivera pas, et le laisser invité chez
         * lui sans l'avoir dit.
         */
        m.api.refreshAccount({
            role: 'master', holdsToken: false,
            identity: { displayName: 'Paul', avatar: 'a.png' },
        });
        check('à distance, on lui dit plutôt ce qu\'il perdrait',
            m.els['account-owner-note'].classList.contains('hidden')
            && !m.els['account-guest-note'].classList.contains('hidden'),
            'la propriété ne suit qu\'au jeton, pas au titre');

        m.api.refreshAccount({ role: 'guest', identity: { displayName: 'Marie', avatar: null } });
        check('un invité n\'a ni l\'un ni l\'autre à savoir',
            m.els['account-owner-note'].classList.contains('hidden')
            && m.els['account-guest-note'].classList.contains('hidden'));
        check('  … et sans pastille, rien ne s\'affiche',
            m.els['account-avatar'].classList.contains('hidden'));
    }

    {
        const m = mount();
        m.api.refreshAccount({ role: 'master', identity: { displayName: 'Paul' } });

        // Un clic bref ne doit rien déclencher : c'est tout le propos.
        m.hold(200);
        await m.settled();
        check('un appui bref ne change rien', m.fetched.length === 0
            && m.navigation.href === '/tableau',
            'le maintien existe pour qu\'un doigt malheureux ne suffise pas');

        m.hold(1600);
        await m.settled();
        check('le maintien ferme la session', m.fetched.length === 1
            && m.fetched[0].url === '/auth/logout' && m.fetched[0].method === 'POST',
            'en POST : une adresse qui déconnecte au chargement se déclenche de loin');

        check('  … puis repart choisir un compte',
            m.navigation.href.startsWith('/auth/discord?switch=1'),
            m.navigation.href);
    }

    {
        // La session doit tomber avant le nouveau trajet : laissée ouverte, son
        // cookie resterait valable et l'on n'aurait fait qu'en ajouter une.
        const m = mount();
        m.api.refreshAccount({ role: 'master', identity: { displayName: 'Paul' } });
        m.hold(1600);
        check('la fermeture précède le départ', m.fetched.length === 1
            && m.navigation.href === '/tableau',
            'la redirection attend la réponse');
        await m.settled();
        check('  … et le départ suit', m.navigation.href.includes('/auth/discord'));
    }

    console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
    process.exit(failed > 0 ? 1 : 0);
})();
