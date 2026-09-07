/**
 * Vérifie que la pochette de repli est servie par le bot, et non par un tiers.
 *
 * Un fichier déposé sur le disque n'a pas de pochette, et
 * `@discord-player/extractor` lui en attribue une d'office : le logo iTunes
 * hébergé chez Wikimedia, codé en dur dans la bibliothèque. Chaque `.wav`
 * téléversé repartait avec elle, et elle finissait recopiée dans les playlists,
 * la file et l'état de lecture.
 *
 * Trois raisons de la rapatrier, et une de ne pas le faire partout.
 *
 *  - Le tableau de bord s'utilise en réseau local, parfois sans accès à
 *    l'extérieur : la pochette d'un fichier posé à un mètre de là manquait.
 *  - Chaque affichage sollicitait Wikimedia, qui décourage ce genre de lien
 *    direct, pour toutes les pistes locales de la bibliothèque et à chaque rendu.
 *  - Une adresse distante peut mourir, et des années de bibliothèque avec elle.
 *
 * Mais **pas dans les embeds Discord** : Discord ne sait pas joindre le bot, et
 * lui tendre un chemin local ne lui montrerait rien du tout. La substitution est
 * donc faite au seul endroit qui alimente le tableau de bord.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const artwork = require(path.join(ROOT, 'src', 'utils', 'artwork.js'));

let failed = 0;
let passed = 0;
const check = (label, ok, detail = '') => {
    if (ok) { passed++; console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`); }
    else { failed++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
};

console.log('\n=== La pochette de repli ===\n');

// ───────────────────── La substitution ─────────────────────

console.log('Ce qui est remplacé, et ce qui ne l\'est pas\n');

{
    const distante = artwork.REMOTE_PLACEHOLDER;

    check('l\'adresse imposée par la bibliothèque est celle qu\'on connaît',
        distante === 'https://upload.wikimedia.org/wikipedia/commons/2/2a/'
            + 'ITunes_12.2_logo.png',
        'codée en dur dans @discord-player/extractor');

    check('elle est remplacée par la nôtre',
        artwork.localise(distante) === '/img/itunes-fallback.png');

    check('  … par un chemin absolu',
        artwork.LOCAL_PLACEHOLDER.startsWith('/'),
        'elle est demandée depuis des pages qui n\'ont pas la même base');

    // Une vraie pochette n'a rien à voir là-dedans.
    const vraie = 'https://i.ytimg.com/vi/abc/hqdefault.jpg';
    check('une vraie pochette passe intacte', artwork.localise(vraie) === vraie);

    check('  … y compris une autre image de Wikimedia',
        artwork.localise('https://upload.wikimedia.org/wikipedia/commons/1/1a/Autre.png')
            === 'https://upload.wikimedia.org/wikipedia/commons/1/1a/Autre.png',
        'seule cette adresse-là est imposée, pas l\'hôte entier');

    /*
     * Rien reste rien.
     *
     * Inventer une image ici court-circuiterait les icônes que l'interface
     * possède déjà pour ce cas — le disque vinyle de la carte de lecture, la
     * note de l'historique — qui disent « pas de pochette » mieux qu'un logo
     * emprunté.
     */
    check('l\'absence de pochette n\'en fabrique pas une',
        artwork.localise(null) === null
        && artwork.localise('') === null
        && artwork.localise(undefined) === null);
}

// ───────────────────── Le fichier ─────────────────────

console.log('\nL\'image elle-même\n');

{
    const file = path.join(ROOT, 'src', 'web', 'public', 'img', 'itunes-fallback.png');
    check('elle est dans le dépôt', fs.existsSync(file));

    if (fs.existsSync(file)) {
        const bytes = fs.readFileSync(file);

        // L'en-tête PNG, pour être sûr que ce n'est pas une page d'erreur
        // enregistrée sous ce nom.
        check('  … et c\'est bien un PNG',
            bytes.slice(1, 4).toString('ascii') === 'PNG');

        // Largeur et hauteur se lisent dans le bloc IHDR, aux octets 16 à 23.
        const width = bytes.readUInt32BE(16);
        const height = bytes.readUInt32BE(20);
        check('  … assez grande pour une carte de lecture',
            width >= 512 && height >= 512, `${width}×${height}`);

        check('  … et assez légère pour être servie sans y penser',
            bytes.length < 400 * 1024, `${Math.round(bytes.length / 1024)} Ko`);
    }

    const served = path.join(ROOT, 'src', 'web', 'public');
    check('elle est sous le dossier servi en statique',
        fs.existsSync(path.join(served, 'index.html')),
        'public/ est monté par express.static');
}

// ───────────────────── Où la substitution s'applique ─────────────────────

console.log('\nOù elle s\'applique, et où elle se garde de le faire\n');

{
    const SERVER = fs.readFileSync(path.join(ROOT, 'src', 'web', 'WebServer.js'), 'utf8');

    check('le sérialiseur du tableau de bord l\'applique',
        /thumbnail: artwork\.localise\(t\.thumbnail\)/.test(SERVER),
        'passage obligé de tout ce que le tableau de bord affiche');

    /*
     * Les embeds Discord gardent l'adresse distante.
     *
     * Discord charge les images depuis ses propres serveurs : un chemin local
     * ne désigne rien pour lui, et l'embed arriverait sans vignette. Ce n'est
     * pas un oubli, c'est la seule chose à faire.
     */
    for (const f of ['src/audio/PlayerEvents.js', 'src/commands/nowplaying.js']) {
        const source = fs.readFileSync(path.join(ROOT, f), 'utf8');
        check(`${path.basename(f)} laisse l'adresse distante`,
            !/artwork/.test(source),
            'Discord ne sait pas joindre le bot');
    }

    const CLIENT = fs.readFileSync(
        path.join(ROOT, 'src', 'web', 'public', 'js', 'outputLevel.js'), 'utf8');
    check('le client emploie la même graphie',
        CLIENT.includes("'/img/itunes-fallback.png'"),
        'deux orthographes d\'un même chemin finissent par diverger');

    // Ce qui reste de l'adresse distante dans le code : rien qui la serve.
    const restes = [];
    const parcours = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { parcours(full); continue; }
            if (!/\.(js|html|css)$/.test(entry.name)) continue;
            const text = fs.readFileSync(full, 'utf8');
            if (text.includes('ITunes_12.2_logo.png')) restes.push(full);
        }
    };
    parcours(path.join(ROOT, 'src'));

    check('plus aucun fichier du code ne pointe vers l\'image distante',
        restes.every((f) => f.endsWith('artwork.js')),
        restes.map((f) => path.relative(ROOT, f)).join(', ') || 'aucun');
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
