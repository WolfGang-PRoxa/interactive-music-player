/**
 * Vérifie le diagnostic du partage du tableau de bord par Cloudflare.
 *
 * Ce que ce test protège :
 *
 *  - **Chaque état se distingue.** Un diagnostic qui confondrait « cloudflared
 *    manque » et « le tunnel est tombé » proposerait le mauvais geste.
 *
 *  - **L'adresse du partage rapide est lue, jamais devinée.** Elle change à
 *    chaque lancement ; seule la sortie de `cloudflared` la donne. Et
 *    `api.trycloudflare.com`, qui paraît dans ses erreurs, n'en est pas une.
 *
 *  - **Le jeton d'un tunnel nommé ne paraît jamais sur la ligne de commande**,
 *    où n'importe quel processus de la machine le lirait.
 *
 *  - **L'adresse fixe exige qu'on la déclare.** Un tunnel nommé ne connaît pas
 *    son propre nom d'hôte : il vit dans le tableau de bord Cloudflare.
 *
 * La décision est éprouvée séparément de ce qui la nourrit : `decide()` est une
 * fonction pure, si bien que chaque état se joue sans télécharger cloudflared
 * ni ouvrir de tunnel.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const cf = require(path.join(ROOT, 'src', 'web', 'cloudflare.js'));

let failed = 0;
let passed = 0;
const check = (label, ok, detail = '') => {
    if (ok) { passed++; console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`); }
    else { failed++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
};

const CLI = '/opt/cloudflared';
const QUICK = 'https://soft-lake-river.trycloudflare.com';

console.log('\n=== Le partage par Cloudflare ===\n');

// ───────────────────── Les états ─────────────────────

console.log('Ce que la machine constate\n');

{
    const quick = (run, extra = {}) => cf.decide({ cli: CLI, mode: 'quick', run, ...extra });

    check('sans cloudflared : absent',
        cf.decide({ cli: null, mode: 'quick', run: { phase: 'idle' } }).step === 'absent');
    check('  … et « téléchargement » pendant qu\'il arrive',
        cf.decide({ cli: null, downloading: true, mode: 'quick', run: { phase: 'idle' } }).step
            === 'downloading');

    const ready = quick({ phase: 'idle' });
    check('présent, rien ne tourne : prêt', ready.step === 'ready');
    check('  … sans adresse à annoncer en partage rapide', ready.publicUrl === null,
        'elle n\'existe pas avant que Cloudflare l\'attribue');

    check('lancé, pas encore confirmé : en cours', quick({ phase: 'starting' }).step === 'starting');

    const up = quick({ phase: 'up', url: QUICK });
    check('confirmé : publié, à l\'adresse lue', up.step === 'serving' && up.publicUrl === QUICK);

    const down = quick({ phase: 'exited', error: 'failed to request quick Tunnel' });
    check('tombé de lui-même : échec, avec la cause', down.step === 'failed'
        && /quick Tunnel/.test(down.detail));
}

{
    const named = (run, declaredUrl) => cf.decide({ cli: CLI, mode: 'named', declaredUrl, run });

    check('tunnel nommé sans adresse déclarée : il la réclame',
        named({ phase: 'idle' }, '').step === 'needsAddress',
        'un tunnel nommé ne connaît pas son propre nom d\'hôte');

    const ready = named({ phase: 'idle' }, 'https://imp.romainpiau.dev');
    check('  … et avec : prêt, sur l\'adresse déclarée',
        ready.step === 'ready' && ready.publicUrl === 'https://imp.romainpiau.dev');

    const up = named({ phase: 'up', url: null }, 'https://imp.romainpiau.dev');
    check('  … publié sur cette même adresse', up.step === 'serving'
        && up.publicUrl === 'https://imp.romainpiau.dev');
}

// ───────────────────── La sortie de cloudflared ─────────────────────

console.log('\nCe que la sortie de cloudflared apprend\n');

{
    const run = cf._run;
    const reset = (mode) => Object.assign(run, {
        phase: 'starting', mode, url: null, connected: false, error: null, child: null,
    });

    reset('quick');
    cf._readOutput('2026-11-12T05:00:00Z ERR Error unmarshaling QuickTunnel response '
        + 'url=https://api.trycloudflare.com/tunnel\n');
    check('le service d\'attribution n\'est pas pris pour l\'adresse', run.url === null,
        'api.trycloudflare.com paraît dans les erreurs');

    cf._readOutput('2026-11-12T05:00:01Z INF |  https://Soft-Lake-River.trycloudflare.com   |\n');
    check('l\'adresse attribuée est lue', run.url === QUICK, run.url || '');
    check('  … sans être annoncée avant la connexion', run.phase === 'starting'
        && cf.sharedUrl() === null, 'Cloudflare peut encore refuser le tunnel');

    cf._readOutput('2026-11-12T05:00:02Z INF Registered tunnel connection connIndex=0 '
        + 'event=0 ip=198.41.200.13 location=cdg01 protocol=quic\n');
    check('la première connexion la rend publique', run.phase === 'up'
        && cf.sharedUrl() === QUICK);
    check('  … et efface l\'erreur d\'avant', run.error === null);

    reset('named');
    process.env.PUBLIC_URL = 'https://imp.romainpiau.dev/';
    cf._readOutput('2026-11-12T05:00:02Z INF Registered tunnel connection connIndex=0\n');
    check('un tunnel nommé est public à sa connexion, sur l\'adresse déclarée',
        run.phase === 'up' && cf.sharedUrl() === 'https://imp.romainpiau.dev');
    delete process.env.PUBLIC_URL;

    Object.assign(run, { phase: 'idle', mode: null, url: null, connected: false, error: null });
    check('rien ne tourne : aucune adresse partagée', cf.sharedUrl() === null);
}

// ───────────────────── La commande ─────────────────────

console.log('\nCe que la commande porte\n');

{
    const quick = cf.commandArgs('quick', 3000);
    check('le partage rapide vise le port servi, sur la machine elle-même',
        quick.includes('--url') && quick.includes('http://127.0.0.1:3000'));
    check('  … sans se mettre à jour tout seul', quick.includes('--no-autoupdate'),
        'un exécutable qui se remplace sous le bot qui le lance');

    process.env.CLOUDFLARE_TUNNEL_TOKEN = 'eyJhIjoic2VjcmV0In0=';
    const named = cf.commandArgs('named', 3000);
    check('le jeton n\'est jamais sur la ligne de commande',
        !named.some((a) => a.includes('eyJ')) && !named.includes('--token'),
        'la liste des tâches se lit par tous');
    delete process.env.CLOUDFLARE_TUNNEL_TOKEN;

    const SOURCE = fs.readFileSync(path.join(ROOT, 'src', 'web', 'cloudflare.js'), 'utf8');
    check('  … il passe par l\'environnement', /env\.TUNNEL_TOKEN = tunnelToken\(\)/.test(SOURCE));
    check('  … et le partage rapide n\'hérite pas d\'un jeton égaré',
        /delete env\.TUNNEL_TOKEN/.test(SOURCE));
    check('le jeton ne se journalise pas',
        !/log\.[a-z]+\([^)]*tunnelToken\(\)/.test(SOURCE));
}

// ───────────────────── Le téléchargement ─────────────────────

console.log('\nOù cloudflared se télécharge\n');

{
    const win = cf.installer('win32', 'x64');
    check('Windows : le fichier publié par Cloudflare, en direct',
        win.direct && /github\.com\/cloudflare\/cloudflared\/releases\/latest\/download\/cloudflared-windows-amd64\.exe$/.test(win.url));
    check('  … et l\'ARM reprend celui-là, que l\'émulation fait tourner',
        cf.installer('win32', 'arm64').url === win.url);
    check('Linux ARM : le bon processeur',
        cf.installer('linux', 'arm64').url.endsWith('cloudflared-linux-arm64'));
    const mac = cf.installer('darwin', 'arm64');
    check('macOS : la page officielle, faute de fichier unique', !mac.direct
        && mac.url.startsWith('https://developers.cloudflare.com/'));

    const SOURCE = fs.readFileSync(path.join(ROOT, 'src', 'web', 'cloudflare.js'), 'utf8');
    check('le fichier ne prend son nom qu\'une fois complet',
        /fs\.renameSync\(partial, target\)/.test(SOURCE),
        'un exécutable tronqué serait pris pour bon');
}

// ───────────────────── Les gestes ─────────────────────

console.log('\nCe qui ne se fait jamais tout seul\n');

{
    const SOURCE = fs.readFileSync(path.join(ROOT, 'src', 'web', 'cloudflare.js'), 'utf8');
    const announce = SOURCE.slice(SOURCE.indexOf('async function announce'),
        SOURCE.indexOf('module.exports'));
    check('au démarrage, le tunnel ne s\'ouvre que s\'il l\'était avant l\'arrêt',
        /if \(remembered\(\) &&/.test(announce),
        'publier sur l\'internet reste un geste du maître');
    check('retirer le partage oublie qu\'il fallait le rouvrir',
        /async function unmount\(\) \{\s*\n\s*remember\(false\);/.test(SOURCE));
    check('le tunnel meurt avec le bot', /process\.on\('exit'/.test(SOURCE));

    const SERVER = fs.readFileSync(path.join(ROOT, 'src', 'web', 'WebServer.js'), 'utf8');
    check('l\'adresse du partage rapide n\'est jamais recopiée dans PUBLIC_URL',
        !/process\.env\.PUBLIC_URL\s*=/.test(SERVER),
        'elle change à chaque lancement, et les cookies passeraient en Secure');
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed ? 1 : 0);
