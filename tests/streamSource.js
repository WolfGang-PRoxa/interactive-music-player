/**
 * Vérifie que `/api/stream` ne change pas de fichier sous les pieds du
 * navigateur.
 *
 * ## Ce qui se joue ici
 *
 * Une même adresse de flux désigne deux fichiers selon le moment : le MP3 du
 * cache de préchargement quand il existe, le fichier d'origine sinon. Le cache
 * apparaît quand le préchargement se termine, et disparaît quand la piste sort
 * de la fenêtre de préchargement — deux évènements qui tombent au milieu d'une
 * lecture, puisque c'est précisément pendant qu'on écoute un morceau qu'on
 * l'ajoute à la file.
 *
 * Or un navigateur ne télécharge pas un média d'un seul tenant : il en demande
 * des tranches sur plusieurs minutes, à la même adresse. Une tranche de MP3
 * livrée dans un décodage de WAV ne produit ni erreur ni silence, mais un
 * **énorme bruit blanc** : des octets compressés lus comme des échantillons
 * bruts sont du bruit aléatoire, à plein niveau. C'est le symptôme observé le
 * 2026-09-04, et ce test existe pour qu'il ne revienne pas.
 *
 * Ce qui est vérifié :
 *
 *   - la source est choisie au démarrage d'un décodage et resservie ensuite,
 *     même si le cache est apparu entretemps ;
 *   - un nouveau décodage — requête sans plage, ou plage repartant de zéro —
 *     rechoisit librement, et profite donc du cache ;
 *   - la source retenue disparue en pleine lecture n'est jamais remplacée en
 *     douce : la requête est refusée, à charge pour le tableau de bord de
 *     recharger proprement ;
 *   - le garde-fou des racines autorisées reste en place.
 *
 * Le serveur est monté sur un port éphémère avec un `webServer` factice, dans
 * un bac à sable : la route lit `data/uploads` et `data/cache` sous le
 * répertoire courant, qui est donc déplacé avant tout `require`.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-source-'));
fs.mkdirSync(path.join(SANDBOX, 'data', 'uploads'), { recursive: true });
fs.mkdirSync(path.join(SANDBOX, 'data', 'cache'), { recursive: true });
process.chdir(SANDBOX);

let failed = 0;
let passed = 0;
const check = (label, ok, detail = '') => {
    if (ok) { passed++; console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`); }
    else { failed++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
};

const express = require(path.join(ROOT, 'node_modules', 'express'));

/*
 * La route interroge le lecteur pour retrouver une piste distante. Aucune des
 * pistes de ce test n'en est une — ce sont des fichiers du disque, résolus bien
 * avant —, mais le crochet de discord-player refuse d'être appelé hors d'un
 * lecteur instancié. Le remplacer par une file vide laisse la route suivre
 * exactement le chemin qu'on veut mesurer.
 */
const discordPlayerPath = require.resolve('discord-player', {
    paths: [path.join(ROOT, 'src', 'web', 'routes')],
});
const realDiscordPlayer = require(discordPlayerPath);
// Les exports de la bibliothèque sont scellés : c'est l'entrée du cache de
// modules qu'on remplace, pas une de ses propriétés.
require.cache[discordPlayerPath].exports = new Proxy(realDiscordPlayer, {
    get(target, key) {
        if (key === 'useMainPlayer') return () => ({ queues: { get: () => null } });
        return target[key];
    },
});

const createApiRouter = require(path.join(ROOT, 'src', 'web', 'routes', 'api.js'));
const preloadManager = require(path.join(ROOT, 'src', 'audio', 'PreloadManager.js'));

/**
 * Fait apparaître ou disparaître le fichier de cache d'une piste.
 *
 * L'index mémoire du préchargeur est relu ensuite, comme il l'est au démarrage
 * du bot : sans lui, `getCachedPath()` ne verrait pas le fichier, et le test
 * mesurerait autre chose que ce qu'il croit.
 */
function setCache(present) {
    if (present) fs.writeFileSync(MP3_PATH, MP3_BYTES);
    else fs.rmSync(MP3_PATH, { force: true });
    preloadManager._buildCacheIndex();
}

/*
 * Deux fichiers volontairement reconnaissables à l'octet près : c'est le seul
 * moyen de dire lequel a été servi, et c'est exactement ce que le décodeur du
 * navigateur, lui, ne sait pas faire.
 */
const WAV_PATH = path.join(SANDBOX, 'data', 'uploads', 'temoin.wav');
const WAV_BYTES = Buffer.alloc(200000, 0x11);
fs.writeFileSync(WAV_PATH, WAV_BYTES);

const cacheKey = crypto.createHash('sha256').update(WAV_PATH).digest('hex');
const MP3_PATH = path.join(SANDBOX, 'data', 'cache', `${cacheKey}.320.mp3`);
const MP3_BYTES = Buffer.alloc(120000, 0x99);

const app = express();
app.use('/api', createApiRouter({
    client: null,
    wss: null,
    inviteLink: () => null,
    _getFirstGuildId: () => 'guilde-de-test',
}));

const server = http.createServer(app);

/**
 * Une requête de flux.
 * @param {string|null} range - En-tête `Range`, ou null pour n'en poser aucun
 */
function stream(port, filePath, range, load) {
    const route = `/api/stream?guildId=guilde-de-test&trackUrl=${encodeURIComponent(filePath)}`
        + (load === undefined ? '' : `&load=${load}`);
    return new Promise((resolve, reject) => {
        const headers = range ? { Range: range } : {};
        http.get({ host: '127.0.0.1', port, path: route, headers }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({
                status: res.statusCode,
                type: res.headers['content-type'] || '',
                body: Buffer.concat(chunks),
            }));
        }).on('error', reject);
    });
}

/** Le corps reçu est-il fait des octets de ce fichier-là ? */
function madeOf(body, byte) {
    return body.length > 0 && body.every(b => b === byte);
}

server.listen(0, '127.0.0.1', async () => {
    const { port } = server.address();

    console.log('\n=== Stabilité de la source servie par /api/stream ===\n');

    // ───────── Le cache n'existe pas encore ─────────

    console.log('Pendant que le préchargement écrit encore\n');

    const opening = await stream(port, WAV_PATH, 'bytes=0-', 1);
    check('le fichier d\'origine est servi',
        opening.status === 206 && madeOf(opening.body, 0x11),
        `${opening.status}, ${opening.type}`);
    check('avec son propre type', opening.type === 'audio/wav', opening.type);

    // ───────── Le préchargement se termine en pleine lecture ─────────

    console.log('\nLe cache apparaît au milieu de la lecture\n');

    setCache(true);

    const middle = await stream(port, WAV_PATH, 'bytes=100000-100999', 1);
    check('la tranche suivante vient toujours du même fichier',
        middle.status === 206 && madeOf(middle.body, 0x11),
        madeOf(middle.body, 0x99) ? 'MP3 servi dans un décodage de WAV — bruit blanc' : 'octets du WAV');
    check('et garde le même type', middle.type === 'audio/wav', middle.type);
    check('la plage demandée est respectée', middle.body.length === 1000,
        `${middle.body.length} octets`);

    /*
     * ───────── La lecture reboucle ─────────
     *
     * Le cas qui a produit le bruit blanc du 2026-09-04, et que la première
     * version du correctif laissait passer. Un morceau qui reboucle redemande
     * la plage `bytes=0-`, exactement comme un nouveau départ — mais le
     * navigateur, lui, n'a rien oublié : ses octets de WAV sont toujours en
     * cache sous cette adresse, et son décodeur est ouvert sur le format qu'il
     * y a reconnu au premier passage. Lui livrer le MP3 à ce moment-là donnait
     * quarante secondes de bruit, puis plus rien.
     *
     * L'adresse ne changeant pas, `load` ne change pas non plus : la source
     * retenue tient.
     */
    console.log('\nLa lecture reboucle sur la même adresse\n');

    const looped = await stream(port, WAV_PATH, 'bytes=0-', 1);
    check('le rebouclage ne change pas de fichier',
        looped.status === 206 && madeOf(looped.body, 0x11),
        madeOf(looped.body, 0x99) ? 'MP3 servi dans un décodage de WAV — bruit blanc' : 'octets du WAV');
    check('ni de type', looped.type === 'audio/wav', looped.type);

    // ───────── Un chargement neuf ─────────

    console.log('\nÀ la lecture suivante, sous une adresse neuve\n');

    const restart = await stream(port, WAV_PATH, 'bytes=0-', 2);
    check('le cache prend enfin le relais',
        restart.status === 206 && madeOf(restart.body, 0x99),
        restart.type);
    check('avec le type du cache', restart.type === 'audio/mpeg', restart.type);

    const following = await stream(port, WAV_PATH, 'bytes=50000-50999', 2);
    check('et la lecture s\'y tient',
        following.status === 206 && madeOf(following.body, 0x99));

    // Deux éléments audio peuvent lire la même piste en même temps — c'est ce
    // que fait un fondu enchaîné. Chacun sous son adresse, chacun sa source.
    const earlier = await stream(port, WAV_PATH, 'bytes=20000-20999', 1);
    check('le chargement précédent garde la sienne',
        earlier.status === 206 && madeOf(earlier.body, 0x11),
        'deux chargements simultanés ne se marchent pas dessus');

    // ───────── Le cache est évincé en pleine lecture ─────────

    console.log('\nLe cache est supprimé sous les pieds du navigateur\n');

    setCache(false);

    const orphaned = await stream(port, WAV_PATH, 'bytes=60000-60999', 2);
    check('la requête est refusée plutôt que servie dans l\'autre format',
        orphaned.status === 404,
        madeOf(orphaned.body, 0x11)
            ? 'WAV servi dans un décodage de MP3 — bruit blanc'
            : `HTTP ${orphaned.status}`);

    const recovered = await stream(port, WAV_PATH, 'bytes=0-', 3);
    check('le rechargement repart proprement sur le fichier d\'origine',
        recovered.status === 206 && madeOf(recovered.body, 0x11) && recovered.type === 'audio/wav',
        recovered.type);

    // ───────── Une adresse sans identifiant de chargement ─────────

    console.log('\nUn onglet resté sur une version antérieure du tableau de bord\n');

    const legacyFirst = await stream(port, WAV_PATH, 'bytes=0-');
    setCache(true);
    const legacyLooped = await stream(port, WAV_PATH, 'bytes=0-');
    check('la source y est figée sur la piste, faute de mieux',
        legacyFirst.type === legacyLooped.type && madeOf(legacyLooped.body, 0x11),
        `${legacyFirst.type} puis ${legacyLooped.type}`);
    setCache(false);

    // ───────── Le garde-fou tient toujours ─────────

    console.log('\nCe que la route continue de refuser\n');

    const outside = await stream(port, path.join(ROOT, 'package.json'), null, 9);
    check('un fichier hors des racines autorisées est refusé',
        outside.status === 404 || outside.status === 403,
        `HTTP ${outside.status}`);

    const traversal = await stream(port,
        path.join(SANDBOX, 'data', 'uploads', '..', '..', 'secret.wav'), null, 10);
    check('un chemin qui remonte l\'arborescence est refusé',
        traversal.status === 404 || traversal.status === 403,
        `HTTP ${traversal.status}`);

    server.close();
    try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) {}

    console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
    process.exit(failed > 0 ? 1 : 0);
});
