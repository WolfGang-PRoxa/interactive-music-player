/**
 * Vérifie le diagnostic du partage du tableau de bord.
 *
 * Ouvrir le tableau de bord à l'extérieur demande quatre gestes que rien
 * n'annonçait : installer Tailscale, authentifier la machine, obtenir du tailnet
 * le droit de publier, monter le Funnel. Chacun échoue à sa façon, et l'on
 * découvrait l'étape suivante en butant dessus.
 *
 * Ce que ce test protège :
 *
 *  - **Les six états se distinguent.** Un diagnostic qui confondrait « pas
 *    authentifié » et « pas le droit de publier » enverrait l'utilisateur dans
 *    la mauvaise console.
 *
 *  - **L'adresse publique se déduit.** C'est le vrai gain : recopiée à la main
 *    dans PUBLIC_URL, elle voyage avec le dépôt, et une seconde installation
 *    hérite de l'adresse de la première — l'aller-retour de connexion Discord
 *    renvoie alors l'utilisateur sur l'ordinateur d'à côté. C'est arrivé.
 *
 *  - **Un Funnel qui n'est pas le nôtre n'est pas le nôtre.** Quelqu'un peut
 *    publier autre chose depuis des mois ; l'écraser en silence serait le pire
 *    service à lui rendre.
 *
 * La décision est éprouvée séparément de ce qui la nourrit : `decide()` ne reçoit
 * que deux objets déjà lus, si bien que les six états se jouent sans installer
 * Tailscale, sans le déconnecter, et sans retirer un droit à un tailnet réel.
 */
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ts = require(path.join(ROOT, 'src', 'web', 'tailscale.js'));

let failed = 0;
let passed = 0;
const check = (label, ok, detail = '') => {
    if (ok) { passed++; console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`); }
    else { failed++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
};

const HOST = 'machine.tailnet.ts.net';

/** L'état d'un nœud, tel que `tailscale status --json` le rend. */
function node({ backend = 'Running', caps = ['funnel', 'https'] } = {}) {
    return {
        BackendState: backend,
        MagicDNSSuffix: 'tailnet.ts.net',
        Self: { DNSName: `${HOST}.`, Capabilities: caps },
    };
}

/** Ce que rend `tailscale funnel status --json` quand un Funnel est monté. */
function funnelOn(target) {
    return {
        AllowFunnel: { [`${HOST}:443`]: true },
        Web: { [`${HOST}:443`]: { Handlers: { '/': { Proxy: target } } } },
    };
}

console.log('\n=== Le partage du tableau de bord ===\n');

// ───────────────────── Les six états ─────────────────────

console.log('Ce que la machine sait dire d\'elle-même\n');

{
    check('un démon muet ne se prend pas pour une machine prête',
        ts.decide(null, null, 3000).step === ts.STEP.UNREACHABLE);

    // Trois formulations pour une même situation : pas encore sur un tailnet.
    for (const backend of ['NeedsLogin', 'Stopped', 'NoState']) {
        const r = ts.decide(node({ backend }), null, 3000);
        check(`« ${backend} » veut dire : pas authentifié`,
            r.step === ts.STEP.NEEDS_LOGIN && r.backendState === backend);
    }

    /*
     * La distinction qui compte le plus.
     *
     * Authentifié sans droit de publier n'est pas « non authentifié » : la
     * première situation se règle dans la console d'administration du tailnet,
     * la seconde sur la machine. Les confondre envoie l'utilisateur au mauvais
     * endroit, et il n'y trouvera rien.
     */
    const sansFunnel = ts.decide(node({ caps: ['https'] }), null, 3000);
    check('authentifié sans droit de publier est un état à part',
        sansFunnel.step === ts.STEP.NEEDS_CAPABILITY
        && sansFunnel.canFunnel === false && sansFunnel.canHttps === true,
        'la console du tailnet, pas la machine');

    const sansHttps = ts.decide(node({ caps: ['funnel'] }), null, 3000);
    check('  … et il manque aussi bien le certificat que le Funnel',
        sansHttps.step === ts.STEP.NEEDS_CAPABILITY && sansHttps.canHttps === false);

    check('  … avec le nom du tailnet, pour composer le bon lien',
        sansFunnel.tailnet === 'tailnet.ts.net');
}

{
    check('tout en place mais rien de monté : prêt, pas publié',
        ts.decide(node(), {}, 3000).step === ts.STEP.READY,
        'monter publie sur l\'internet, ça ne se fait pas au démarrage');

    check('un Funnel vers notre port, c\'est le nôtre',
        ts.decide(node(), funnelOn('http://127.0.0.1:3000'), 3000).step === ts.STEP.SERVING);
}

// ───────────────────── Ce qui appartient à quelqu'un d'autre ─────────────

console.log('\nCe qu\'on se garde d\'écraser\n');

{
    const autre = ts.decide(node(), funnelOn('http://127.0.0.1:8080'), 3000);
    check('un Funnel vers un autre service n\'est pas le nôtre',
        autre.step === ts.STEP.OTHER_TARGET && autre.proxy === 'http://127.0.0.1:8080',
        'quelqu\'un publie peut-être ça depuis des mois');

    /*
     * Le piège des ports qui se ressemblent.
     *
     * Une comparaison par simple inclusion prendrait 30000 pour 3000, et l'on
     * annoncerait « publié » un tableau de bord que personne ne peut joindre.
     */
    const voisin = ts.decide(node(), funnelOn('http://127.0.0.1:30000'), 3000);
    check('  … et 30000 n\'est pas 3000',
        voisin.step === ts.STEP.OTHER_TARGET, voisin.step);

    check('un chemin après le port ne trompe pas non plus',
        ts.decide(node(), funnelOn('http://127.0.0.1:3000/'), 3000).step === ts.STEP.SERVING);
}

// ───────────────────── L'adresse déduite ─────────────────────

console.log('\nL\'adresse publique, déduite plutôt que recopiée\n');

{
    check('le point final du nom DNS ne survit pas',
        ts.publicUrlFrom('machine.tailnet.ts.net.') === 'https://machine.tailnet.ts.net');
    check('un nom déjà propre passe tel quel',
        ts.publicUrlFrom('machine.tailnet.ts.net') === 'https://machine.tailnet.ts.net');
    check('rien ne donne rien, pas « https:// »',
        ts.publicUrlFrom('') === null && ts.publicUrlFrom(null) === null);

    check('l\'adresse accompagne l\'état dès qu\'elle est connue',
        ts.decide(node(), funnelOn('http://127.0.0.1:3000'), 3000).publicUrl
            === `https://${HOST}`,
        'c\'est elle qui dispense de PUBLIC_URL');
}

// ───────────────────── Le raccordement ─────────────────────

console.log('\nCe qui tient les deux bouts\n');

{
    const fs = require('fs');
    const SERVER = fs.readFileSync(path.join(ROOT, 'src', 'web', 'WebServer.js'), 'utf8');

    check('le partage est annoncé au démarrage',
        /require\('\.\/tailscale'\)\.announce\(port\)/.test(SERVER));

    // L'ordre est le sujet : la trace OAuth doit imprimer l'adresse déduite, pas
    // celle d'avant. Elle attend donc l'inspection.
    check('  … avant la trace OAuth, qui en dépend',
        SERVER.indexOf("require('./tailscale').announce(port)")
            < SERVER.indexOf("require('./oauth').logConfiguration()"),
        'sinon elle imprimerait une adresse périmée');

    check('une valeur écrite à la main l\'emporte sur la déduction',
        /if \(!process\.env\.PUBLIC_URL/.test(SERVER),
        'un domaine ou un tunnel tiers ne se devine pas');

    // Un diagnostic de confort ne doit jamais empêcher le démarrage.
    check('un diagnostic en échec ne retient pas le bot',
        /\.catch\(\(err\) => \{[\s\S]{0,320}logConfiguration\(\)/.test(SERVER));
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
