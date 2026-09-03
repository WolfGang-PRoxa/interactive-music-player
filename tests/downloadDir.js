/**
 * Vérifie le dossier de téléchargement — le vrai utils/downloadDir.js, éprouvé
 * sur un dossier temporaire réel.
 *
 * Sur un vrai disque, et non sur un système de fichiers simulé : tout l'intérêt
 * de ce module est de répondre à des questions que seul le système sait
 * trancher — ce dossier existe-t-il, est-ce bien un dossier, accepte-t-il qu'on
 * y écrive. Un simulacre répondrait ce qu'on lui aurait soufflé.
 *
 * Trois choses s'y cassent en silence :
 *
 *  - **Le nom de fichier.** Un titre de morceau contient volontiers « : » ou
 *    « / ». Écrit tel quel, il fait échouer l'écriture sous Windows — mais avec
 *    une erreur système qu'on impute alors au transcodage, jamais au titre.
 *
 *  - **Les collisions.** Retélécharger un morceau ne doit pas écraser le
 *    précédent. La perte est totale, immédiate, et ne laisse aucune trace.
 *
 *  - **L'écriture, éprouvée et non supposée.** Un dossier peut exister, être
 *    lisible, et refuser qu'on y crée quoi que ce soit. Le découvrir au moment
 *    du téléchargement laisserait l'utilisateur devant un échec sans rapport
 *    apparent avec son choix.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const downloadDir = require('../src/utils/downloadDir');

let failed = 0;
let passed = 0;
const check = (label, ok, detail = '') => {
    if (ok) { passed++; console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`); }
    else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-downloaddir-'));

console.log('\n=== Dossier de téléchargement ===\n');

// ─────────────────────────── La validation ───────────────────────────

console.log('La validation d’un dossier\n');

{
    const good = downloadDir.validate(root);
    check('un dossier existant et inscriptible est accepté', good.ok, good.reason || good.resolved);
    check('  … et rendu sous sa forme résolue',
        good.resolved === path.resolve(root), good.resolved);

    check('un dossier absent est refusé, en le disant',
        downloadDir.validate(path.join(root, 'nulle-part')).reason === 'missing');

    const file = path.join(root, 'un-fichier.txt');
    fs.writeFileSync(file, 'x');
    check('un fichier n’est pas un dossier',
        downloadDir.validate(file).reason === 'notADirectory');

    check('une chaîne vide est refusée', downloadDir.validate('').reason === 'empty');
    check('un chemin absent est refusé', downloadDir.validate(null).reason === 'empty');

    /*
     * L'octet nul tronque le chemin au niveau des appels système : ce qui est
     * vérifié ici ne serait pas ce qui est ouvert plus bas. Node lève sur ces
     * chaînes, mais le refus doit être explicite plutôt que d'être un effet de
     * bord de l'exception.
     */
    check('un octet nul est refusé avant tout accès disque',
        downloadDir.validate(`${root}\0/ailleurs`).reason === 'invalid');
}

// ─────────────────────────── Les noms de fichiers ───────────────────────────

console.log('\nLes noms de fichiers\n');

{
    check('un titre ordinaire passe tel quel',
        downloadDir.safeFilename('Daft Punk - One More Time', '.mp3')
            === 'Daft Punk - One More Time.mp3',
        downloadDir.safeFilename('Daft Punk - One More Time', '.mp3'));

    const slashes = downloadDir.safeFilename('AC/DC : Back in Black', '.mp3');
    check('les caractères interdits sont remplacés, non retirés',
        slashes === 'AC-DC - Back in Black.mp3', slashes);
    check('  … si bien que le nom reste lisible',
        slashes.includes('AC-DC'), slashes);

    const all = downloadDir.safeFilename('a\\b/c:d*e?f"g<h>i|j', '.mp3');
    check('les dix caractères refusés par Windows sont couverts',
        !/[\\/:*?"<>|]/.test(all), all);

    const control = downloadDir.safeFilename('titre\x07avec\x00controle', '.mp3');
    check('les caractères de contrôle disparaissent',
        !/[\x00-\x1f]/.test(control), JSON.stringify(control));

    const dotted = downloadDir.safeFilename('Fin de phrase...', '.mp3');
    check('un point final est retiré',
        dotted === 'Fin de phrase.mp3', dotted);

    const long = downloadDir.safeFilename('x'.repeat(400), '.mp3');
    check('un titre démesuré est écourté', long.length <= 124, `${long.length} caractères`);

    /*
     * Un titre qui ne laisse rien. « /// » ne convenait pas : les barres sont
     * remplacées, pas retirées, si bien qu'il reste « --- » et que le repli
     * n'était jamais éprouvé. Trois points, eux, disparaissent entièrement —
     * un point final est ôté parce que Windows l'ignore.
     */
    const empty = downloadDir.safeFilename('...', '.mp3');
    check('un titre qui ne laisse rien retombe sur un nom par défaut',
        empty === 'piste.mp3', empty);
}

// ─────────────────────────── Les collisions ───────────────────────────

console.log('\nLes collisions\n');

{
    const dir = path.join(root, 'collisions');
    fs.mkdirSync(dir);

    const first = downloadDir.uniquePath(dir, 'morceau.mp3');
    check('un dossier vide rend le nom demandé',
        path.basename(first) === 'morceau.mp3', path.basename(first));

    fs.writeFileSync(first, 'x');
    const second = downloadDir.uniquePath(dir, 'morceau.mp3');
    check('un nom déjà pris est numéroté plutôt qu’écrasé',
        path.basename(second) === 'morceau (2).mp3', path.basename(second));

    fs.writeFileSync(second, 'x');
    const third = downloadDir.uniquePath(dir, 'morceau.mp3');
    check('la numérotation se poursuit',
        path.basename(third) === 'morceau (3).mp3', path.basename(third));

    check('l’extension reste à la fin, jamais au milieu',
        path.extname(third) === '.mp3', path.basename(third));

    // Le fichier d'origine est toujours là : c'est tout l'objet de la
    // numérotation, et une régression le supprimerait sans rien dire.
    check('le fichier d’origine n’a pas bougé', fs.existsSync(first));
}

// ─────────────────────────── La création ───────────────────────────

console.log('\nLa création du dossier\n');

{
    const deep = path.join(root, 'a', 'b', 'c');
    check('un dossier absent est créé, avec ses parents',
        downloadDir.ensure(deep) === deep && fs.existsSync(deep), deep);

    // Idempotent : le dossier est créé au premier téléchargement, puis
    // retrouvé à chaque suivant.
    check('un dossier déjà là est simplement rendu',
        downloadDir.ensure(deep) === deep && fs.existsSync(deep));

    check('le dossier par défaut vit sous data/',
        downloadDir.DEFAULT_DIR.endsWith(path.join('data', 'downloads')),
        downloadDir.DEFAULT_DIR);
}

// ─────────────────────────── Les racines ───────────────────────────

console.log('\nLes racines de l’arborescence\n');

{
    const roots = downloadDir.listRoots();
    check('au moins une racine est trouvée', roots.length >= 1, roots.join('  '));
    check('chacune existe réellement',
        roots.every((r) => fs.existsSync(r)), roots.join('  '));

    if (process.platform === 'win32') {
        check('elles ont la forme d’une lettre de lecteur',
            roots.every((r) => /^[C-Z]:\\$/.test(r)), roots.join('  '));
    } else {
        check('un seul système de fichiers, donc une seule racine',
            roots.length === 1 && roots[0] === '/', roots.join('  '));
    }

    // Le second appel passe par le cache : il doit rendre la même chose, faute
    // de quoi l'explorateur changerait de racines d'une requête à l'autre.
    check('le cache rend la même liste',
        downloadDir.listRoots().join('|') === roots.join('|'));
}

// ────────────────────── Le premier ancêtre lisible ──────────────────────

console.log('\nLe repli sur un dossier lisible\n');

{
    /*
     * C'est la panne qu'a connue la première version : le dossier par défaut
     * n'existe pas tant que rien n'a été téléchargé, la route répondait
     * « illisible », et le sélecteur s'ouvrait entièrement vide — sans contenu
     * ni moyen d'aller ailleurs. La pire des réponses : ni ce qu'on demandait,
     * ni de quoi aller le chercher.
     */
    const missing = path.join(root, 'jamais', 'cree', 'ici');
    check('un dossier inexistant remonte à son premier ancêtre lisible',
        downloadDir.nearestReadable(missing) === path.resolve(root),
        String(downloadDir.nearestReadable(missing)));

    check('un dossier existant se rend lui-même',
        downloadDir.nearestReadable(root) === path.resolve(root));

    // La remontée s'arrête à la racine plutôt que de boucler : `dirname` d'une
    // racine rend la racine, et sans garde on tournerait indéfiniment.
    const roots = downloadDir.listRoots();
    check('la remontée depuis une racine ne boucle pas',
        downloadDir.nearestReadable(roots[0]) !== null, roots[0]);
}

// ────────────────────── La route, de bout en bout ──────────────────────

console.log('\nLa route /api/browse-dirs\n');

const express = require('express');
const http = require('http');
const createApiRouter = require('../src/web/routes/api.js');

const app = express();
app.use('/api', createApiRouter({ client: null, wss: null, inviteLink: () => null }));
const server = http.createServer(app);

server.listen(0, '127.0.0.1', async () => {
    const { port } = server.address();
    const get = (route) => new Promise((resolve) => {
        http.get({ host: '127.0.0.1', port, path: route }, (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(body); } catch (e) {}
                resolve({ status: res.statusCode, json });
            });
        });
    });

    // Sans paramètre : le point de départ doit être utilisable, que le dossier
    // par défaut existe déjà ou non.
    const start = await get('/api/browse-dirs');
    check('un premier appel sans chemin répond', start.status === 200, `HTTP ${start.status}`);
    check('  … sur un dossier réellement ouvert', !!(start.json && start.json.path),
        start.json ? String(start.json.path) : 'aucun');
    check('  … et rapporte les racines de la machine',
        !!(start.json && Array.isArray(start.json.roots) && start.json.roots.length >= 1),
        start.json ? (start.json.roots || []).join('  ') : '');

    // Le cas exact qui laissait la fenêtre vide.
    const gone = await get(`/api/browse-dirs?path=${encodeURIComponent(path.join(root, 'parti'))}`);
    check('un dossier inexistant ne rend pas une fenêtre vide',
        gone.status === 200 && !!(gone.json && gone.json.path), `HTTP ${gone.status}`);
    check('  … et dit ce qui avait été demandé',
        !!(gone.json && gone.json.requested), String(gone.json && gone.json.requested));

    const nul = await get('/api/browse-dirs?path=%00evil');
    check('un octet nul est refusé', nul.status === 400, `HTTP ${nul.status}`);

    const listed = await get(`/api/browse-dirs?path=${encodeURIComponent(root)}`);
    const names = ((listed.json && listed.json.dirs) || []).map((d) => d.name);
    check('seuls les dossiers sont listés',
        names.includes('collisions') && !names.includes('un-fichier.txt'),
        names.join(', ') || 'aucun');
    check('le parent est indiqué', !!(listed.json && listed.json.parent),
        String(listed.json && listed.json.parent));

    server.close();
    fs.rmSync(root, { recursive: true, force: true });

    console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
    process.exit(failed === 0 ? 0 : 1);
});
