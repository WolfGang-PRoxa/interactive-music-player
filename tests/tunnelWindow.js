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
function makeNode(tag, downloads) {
    let text = '';
    const node = {
        /*
         * Un clic programmé sur une ancre déclenche un téléchargement, sans
         * écouteur : c'est ainsi que le module rapporte l'installateur. La
         * doublure le note plutôt que de le faire.
         */
        click() {
            if (node.tagName === 'A' && node.href && downloads) downloads.push(node.href);
            if (node.listeners.click) node.listeners.click();
        },
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
        attributes: {},
        appendChild(child) { this.children.push(child); return child; },
        removeChild(child) {
            const i = this.children.indexOf(child);
            if (i >= 0) this.children.splice(i, 1);
        },
        addEventListener(type, fn) { this.listeners[type] = fn; },
        setAttribute(name, value) { this.attributes[name] = value; },
        classList: { add(c) { node.className += ` ${c}`; } },
    };
    return node;
}

function mount() {
    const downloads = [];
    const zone = makeNode('div', downloads);
    const body = makeNode('body', downloads);
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
            body,
            getElementById: (id) => (id === 'share-tunnel' ? zone : null),
            createElement: (tag) => makeNode(tag, downloads),
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
        downloads: () => downloads,
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

    const INSTALLATEUR = {
        url: 'https://pkgs.tailscale.com/stable/tailscale-setup-latest.exe',
        direct: true,
    };

    m.show({ step: 'absent', installer: INSTALLATEUR });
    check('l\'étape dit ce qui manque, et pourquoi',
        m.texts().some((x) => x.includes('tunnel_absent_title'))
        && m.texts().some((x) => x.includes('tunnel_absent_body')));
    const telecharger = () => m.buttons().find((b) => b.textContent === 'k#tunnel_absent_action');

    check('  … et propose le téléchargement comme un vrai bouton',
        !!telecharger(), 'un lien discret ne se remarquait pas');

    check('  … avec une infobulle qui dit ce qu\'il déclenche',
        !!telecharger().attributes['data-tooltip']
        && telecharger().attributes['data-i18n-tooltip'] === 'tunnel_absent_tip');

    /*
     * Le clic ne télécharge pas : il constate d'abord.
     *
     * Tailscale a pu être installé depuis l'ouverture de la fenêtre — c'est même
     * le cas ordinaire, puisqu'on vient d'aller le faire. Rapporter un
     * installateur par-dessus une installation existante ferait perdre du temps
     * à qui n'avait qu'à passer à l'étape suivante.
     */
    telecharger().listeners.click();
    check('  … qui vérifie avant de télécharger',
        m.sent[m.sent.length - 1].type === 'tunnelState',
        'Tailscale a pu être installé entre-temps');

    // Le constat revient : toujours absent, donc le téléchargement part.
    m.show({ step: 'absent', installer: INSTALLATEUR });
    check('  … et ne part que si la commande manque toujours',
        m.downloads().includes(INSTALLATEUR.url), m.downloads().join(', '));

    // L'autre issue : installé entre-temps, rien ne se télécharge.
    telecharger().listeners.click();
    const avantConstat = m.downloads().length;
    m.show({ step: 'ready', publicUrl: 'https://x.ts.net' });
    check('  … et pas du tout si elle est apparue entre-temps',
        m.downloads().length === avantConstat,
        'rapporter un installateur par-dessus une installation ferait perdre du temps');

    // Sans fichier à tendre — macOS, Linux — c'est la page officielle.
    m.show({ step: 'absent', installer: { url: 'https://tailscale.com/download', direct: false } });
    check('  … sur une plateforme sans installateur direct, l\'étiquette change',
        m.buttons().some((b) => b.textContent === 'k#tunnel_absent_page'),
        'macOS passe par l\'App Store, Linux par un script');

    m.show({ step: 'absent', installer: INSTALLATEUR });

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

// ───────────────────── Le bouton de reprise ─────────────────────

console.log('\nCe que propose le bouton de reprise\n');

{
    const m = mount();

    /*
     * Il n'apparaît que là où l'on part faire quelque chose ailleurs, et porte
     * le geste accompli plutôt que l'action technique : « Réexaminer »
     * n'apprenait ni ce qui était examiné ni pourquoi.
     */
    const attendus = {
        absent: 'k#tunnel_recheck_installed',
        unreachable: 'k#tunnel_recheck_started',
        needsCapability: 'k#tunnel_recheck_enabled',
    };

    for (const [step, label] of Object.entries(attendus)) {
        m.show({ step });
        const bouton = m.buttons().find((b) => b.textContent === label);
        check(`« ${step} » nomme le geste accompli`, !!bouton, label);
        check('  … et l\'infobulle dit qu\'il réexamine',
            !!bouton && !!bouton.attributes['data-tooltip']);
    }

    // Là où l'on n'est parti nulle part, il n'y a rien à reprendre.
    for (const step of ['ready', 'serving', 'otherTarget']) {
        m.show({ step, publicUrl: 'https://x.ts.net' });
        const reprise = m.buttons().filter((b) => /recheck/.test(b.textContent));
        check(`« ${step} » n'en propose aucun`, reprise.length === 0,
            'rien ne s\'est passé ailleurs');
    }
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
