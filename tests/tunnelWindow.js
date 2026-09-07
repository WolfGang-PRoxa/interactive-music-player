/**
 * Vérifie la fenêtre qui rend le tableau de bord joignable de l'extérieur.
 *
 * Publier demande quatre choses que rien n'annonçait : installer Tailscale,
 * authentifier la machine, obtenir du tailnet le droit de publier, monter le
 * tunnel. On ne découvrait l'étape suivante qu'en butant dessus, après avoir cru
 * à chaque fois que la précédente avait raté.
 *
 * Ce que ce test protège :
 *
 *  - **Une étape à la fois.** Montrer les quatre avec trois barrées n'aide pas :
 *    savoir ce qui reste ne sert à rien quand on ne peut rien y faire.
 *
 *  - **Chaque étape porte son geste.** Ce que la machine sait faire, elle le
 *    propose ; ce qui lui échappe part vers la bonne page — et jamais vers une
 *    autre, un lien qui envoie au mauvais endroit coûtant plus cher que pas de
 *    lien du tout.
 *
 *  - **Un tunnel qui n'est pas le nôtre n'est pas écrasé**, même quand l'hôte
 *    clique pour publier. Quelqu'un s'en sert peut-être depuis des mois.
 *
 *  - **La clé d'authentification ne se journalise pas.** Elle vaut un mot de
 *    passe le temps de son emploi, et le journal du bot se lit à plusieurs.
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(
    path.join(ROOT, 'src', 'web', 'public', 'js', 'shareTunnel.js'), 'utf8');
const HANDLERS = fs.readFileSync(
    path.join(ROOT, 'src', 'web', 'websocket', 'handlers', 'tunnelHandlers.js'), 'utf8');

let failed = 0;
let passed = 0;
const check = (label, ok, detail = '') => {
    if (ok) { passed++; console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`); }
    else { failed++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
};

/**
 * Un nœud factice : ce que le module écrit, et de quoi le relire.
 *
 * `textContent` y est un accesseur plutôt qu'un simple champ : lui affecter une
 * chaîne vide vide aussi les enfants, comme le fait un vrai DOM. C'est ainsi que
 * le module efface la zone entre deux étapes — sans cela la doublure les
 * empilerait, et l'on croirait en voir deux à la fois là où il n'y en a qu'une.
 */
function makeNode(tag) {
    let text = '';
    const node = {
        tagName: tag.toUpperCase(),
        className: '',
        get textContent() { return text; },
        set textContent(value) {
            text = value;
            if (value === '') node.children.length = 0;
        },
        children: [],
        style: {},
        disabled: false,
        listeners: {},
        appendChild(child) { this.children.push(child); return child; },
        addEventListener(type, fn) { this.listeners[type] = fn; },
        classList: { add(c) { node.className += ` ${c}`; } },
    };
    return node;
}

function mount() {
    const zone = makeNode('div');
    const sent = [];

    const sandbox = {
        window: {
            MusicPlayer: {
                sendWS: (m) => sent.push(m),
                // La clé est rendue marquée : le module ne retombe donc pas
                // sur ses textes de repli, et les assertions visent les clés
                // plutôt que des phrases entières.
                t: (k) => 'k#' + k,
            },
        },
        document: {
            getElementById: (id) => (id === 'share-tunnel' ? zone : null),
            createElement: (tag) => makeNode(tag),
        },
        console,
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(SOURCE, sandbox);

    /** Tous les nœuds, à plat, pour interroger le rendu. */
    const flat = (n = zone, out = []) => {
        n.children.forEach((c) => { out.push(c); flat(c, out); });
        return out;
    };

    return {
        zone, sent,
        api: sandbox.window.MusicPlayer,
        show: (state) => sandbox.window.MusicPlayer.onTunnelState(state),
        nodes: () => flat(),
        texts: () => flat().map((n) => n.textContent).filter(Boolean),
        links: () => flat().filter((n) => n.tagName === 'A').map((n) => n.href),
        buttons: () => flat().filter((n) => n.tagName === 'BUTTON'),
    };
}

console.log('\n=== La fenêtre du tunnel ===\n');

// ───────────────────── Une étape à la fois ─────────────────────

console.log('Ce que chaque étape montre, et propose\n');

{
    const m = mount();

    m.show({ step: 'absent' });
    check('l\'étape dit ce qui manque, et pourquoi',
        m.texts().some((x) => x.includes('tunnel_absent_title'))
        && m.texts().some((x) => x.includes('tunnel_absent_body')));
    check('  … et envoie au téléchargement',
        m.links().includes('https://tailscale.com/download'),
        'l\'installation demande les droits administrateur');

    // Une seule étape est peinte : celle où l'on en est.
    check('  … sans montrer les suivantes',
        !m.texts().some((x) => x.includes('tunnel_ready_title')),
        'savoir ce qui reste n\'aide pas quand on ne peut rien y faire');

    m.show({ step: 'needsLogin' });
    check('l\'authentification propose un champ pour la clé',
        m.nodes().some((n) => n.tagName === 'INPUT'));
    check('  … masqué à la saisie',
        m.nodes().filter((n) => n.tagName === 'INPUT').every((n) => n.type === 'password'),
        'la clé vaut un mot de passe, et la fenêtre s\'ouvre devant quelqu\'un');
    check('  … et le lien mène aux clés, pas à la console générale',
        m.links().some((h) => h.includes('/admin/settings/keys')));

    m.show({ step: 'needsCapability' });
    check('le droit de publier renvoie à la console du tailnet',
        m.links().some((h) => h.includes('login.tailscale.com/admin')),
        'il ne s\'accorde pas depuis la machine');

    m.show({ step: 'ready', publicUrl: 'https://x.ts.net' });
    check('« prêt » affiche l\'adresse à venir et le bouton',
        m.texts().includes('https://x.ts.net')
        && m.buttons().some((b) => b.textContent === 'k#tunnel_ready_action'));

    m.show({ step: 'serving', publicUrl: 'https://x.ts.net' });
    check('« publié » propose de cesser de l\'être',
        m.buttons().some((b) => b.textContent === 'k#tunnel_serving_action'));

    m.show({ step: 'otherTarget', proxy: 'http://127.0.0.1:8080' });
    check('un tunnel étranger est nommé, sans bouton pour l\'écraser',
        m.texts().some((x) => x.includes('8080'))
        && !m.buttons().some((b) => b.textContent === 'k#tunnel_ready_action'),
        'quelqu\'un s\'en sert peut-être depuis des mois');
}

// ───────────────────── Les demandes ─────────────────────

console.log('\nCe que la fenêtre demande au serveur\n');

{
    const m = mount();

    m.api.refreshTunnel();
    check('l\'ouverture demande l\'état', m.sent.length === 1
        && m.sent[0].type === 'tunnelState',
        'constater lance deux processus : jamais en continu');

    m.show({ step: 'ready', publicUrl: 'https://x.ts.net' });
    m.buttons().find((b) => b.textContent === 'k#tunnel_ready_action').listeners.click();
    check('publier envoie tunnelMount',
        m.sent[m.sent.length - 1].type === 'tunnelMount');

    m.show({ step: 'serving', publicUrl: 'https://x.ts.net' });
    m.buttons().find((b) => b.textContent === 'k#tunnel_serving_action').listeners.click();
    check('retirer envoie tunnelUnmount',
        m.sent[m.sent.length - 1].type === 'tunnelUnmount');

    // Une clé vide ne part pas : l'appel serait refusé, et le refus déroutant.
    m.show({ step: 'needsLogin' });
    const vide = m.nodes().find((n) => n.tagName === 'INPUT');
    vide.value = '   ';
    const avant = m.sent.length;
    m.buttons().find((b) => b.textContent === 'k#tunnel_login_submit').listeners.click();
    check('une clé vide ne part pas', m.sent.length === avant);

    vide.value = '  tskey-auth-abc  ';
    m.buttons().find((b) => b.textContent === 'k#tunnel_login_submit').listeners.click();
    const dernier = m.sent[m.sent.length - 1];
    check('  … et une vraie clé part sans ses espaces',
        dernier.type === 'tunnelLogin' && dernier.data.authKey === 'tskey-auth-abc');
}

{
    // Un échec se dit sous l'étape, pas à sa place : on doit pouvoir réessayer
    // sans recharger la page.
    const m = mount();
    m.show({ step: 'ready', publicUrl: 'https://x.ts.net', error: 'refus du tailnet' });
    check('un échec s\'affiche sans effacer l\'étape',
        m.texts().some((x) => x.includes('refus du tailnet'))
        && m.buttons().some((b) => b.textContent === 'k#tunnel_ready_action'));
}

// ───────────────────── Le côté serveur ─────────────────────

console.log('\nCe que le serveur refuse de faire\n');

{
    check('publier n\'écrase jamais un tunnel étranger',
        /STEP\.OTHER_TARGET\)\s*\{\s*\n\s*return send\(ws, before, 'otherTarget'\)/.test(HANDLERS),
        'vérifié avant de monter, pas après');

    // La clé traverse pour être remise à la commande, et rien de plus.
    const login = HANDLERS.slice(HANDLERS.indexOf('async function handleTunnelLogin'),
        HANDLERS.indexOf('async function handleTunnelMount'));
    // La valeur, et non le mot : le message dit « with a key », ce qui est
    // exactement ce qu'on veut lire dans un journal — sans la clé derrière.
    check('la clé n\'est pas journalisée',
        /log\.info/.test(login)
        && !/\$\{\s*key\s*\}/.test(login)
        && !/log\.[a-z]+\([^)]*[,+]\s*key\b/.test(login),
        'le journal du bot se lit à plusieurs');

    const PERMS = fs.readFileSync(path.join(ROOT, 'src', 'web', 'permissions.js'), 'utf8');
    for (const action of ['tunnelState', 'tunnelLogin', 'tunnelMount', 'tunnelUnmount']) {
        check(`${action} est réservé au maître`,
            new RegExp(`${action}: MASTER_ONLY`).test(PERMS));
    }
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
