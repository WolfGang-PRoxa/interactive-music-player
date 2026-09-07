/**
 * Vérifie le téléchargement en vidéo, et l'image noire quand il n'y en a pas.
 *
 * Le menu « Format » de la boîte d'ajout ne proposait que des conteneurs
 * sonores, et pour une raison honnête : le téléchargement vers le disque passait
 * par la résolution audio du préchargeur, si bien que proposer MP4 aurait promis
 * une image que rien n'allait chercher.
 *
 * Trois choses portent le sens, et deux ne se lisent pas dans un diff.
 *
 *  - **Une source sans image n'est pas un échec.** Un enregistrement mis en
 *    ligne sans clip n'a pas de vidéo ; refuser de le télécharger pour cette
 *    raison répondrait à côté de la demande. On fabrique alors une image noire,
 *    et le son y est intact.
 *
 *  - **L'image existante n'est jamais réencodée.** La recopier garde la qualité
 *    qu'on venait chercher, et prend cent fois moins de temps.
 *
 *  - **Le repli reste dans sa famille.** Un MP3 rendu à qui a demandé une vidéo
 *    n'irait pas se ranger là où on l'attend.
 *
 * L'image noire est éprouvée pour de vrai : ffmpeg est lancé avec les arguments
 * que le module produit, et le fichier obtenu est relu. C'est le seul moyen de
 * savoir que la ligne de commande tient — un argument mal placé ne se voit pas.
 */
const fs = require('fs');
const os = require('os');
const cp = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const formats = require(path.join(ROOT, 'src', 'utils', 'downloadFormats.js'));
const videoSource = require(path.join(ROOT, 'src', 'audio', 'videoSource.js'));

let failed = 0;
let passed = 0;
const check = (label, ok, detail = '') => {
    if (ok) { passed++; console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`); }
    else { failed++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
};

const ffmpeg = require('ffmpeg-static');
const box = fs.mkdtempSync(path.join(os.tmpdir(), 'video-dl-'));

/** Lance ffmpeg et rend son code de sortie. */
function run(args) {
    const res = cp.spawnSync(ffmpeg, args, { windowsHide: true, encoding: 'utf8' });
    return { code: res.status, err: (res.stderr || '').slice(-400) };
}

/** Interroge un fichier : quels flux, quelle durée. */
function probe(file) {
    const bin = ffmpeg.replace(/ffmpeg(\.exe)?$/i, (m) => m.replace('ffmpeg', 'ffprobe'));
    const args = ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height',
        '-show_entries', 'format=duration', '-of', 'json', file];
    const res = cp.spawnSync(fs.existsSync(bin) ? bin : 'ffprobe', args,
        { windowsHide: true, encoding: 'utf8' });
    try { return JSON.parse(res.stdout); } catch (e) { return null; }
}

console.log('\n=== Le téléchargement en vidéo ===\n');

// ───────────────────── Les conteneurs ─────────────────────

console.log('Ce que le module distingue\n');

{
    check('les conteneurs vidéo sont reconnus comme tels',
        formats.isVideo('mp4') && formats.isVideo('mkv'));
    check('  … et les conteneurs sonores ne le sont pas',
        !formats.isVideo('mp3') && !formats.isVideo('flac') && !formats.isVideo('webm'),
        'WEBM reste audio : la clé est déjà prise');

    check('le menu peut proposer les deux familles',
        formats.EXTENSIONS.includes('mp4') && formats.EXTENSIONS.includes('mp3'));

    /*
     * Le piège que l'élargissement de EXTENSIONS avait ouvert.
     *
     * `encodeArgs` validait contre cette liste, puis cherchait un codec dans la
     * table audio : « mp4 » y passait la validation et plantait juste après, sur
     * une entrée inexistante.
     */
    const audioSurVideo = formats.encodeArgs('mp4', 320);
    check('un conteneur vidéo demandé à l\'encodeur audio ne casse rien',
        audioSurVideo.ext === '.mp3',
        'il retombe sur le repli plutôt que de chercher un codec absent');
}

{
    const copie = formats.videoEncodeArgs('mp4', 192);
    check('une image existante est recopiée, jamais réencodée',
        copie.args.join(' ').includes('-c:v copy'),
        'la réencoder perdrait ce qu\'on venait chercher');

    const noire = formats.videoEncodeArgs('mp4', 192, { still: true });
    check('une image fabriquée est encodée, et cadrée sur le son',
        noire.args.includes('-shortest') && noire.args.join(' ').includes('libx264'),
        'sans -shortest le noir tournerait indéfiniment');

    check('MP4 remonte ses tables en tête',
        copie.args.join(' ').includes('-movflags +faststart'));
    check('  … ce que MKV n\'a pas à faire',
        !formats.videoEncodeArgs('mkv', 192).args.join(' ').includes('movflags'));
}

// ───────────────────── L'image noire, pour de vrai ─────────────────────

console.log('\nL\'image noire, produite et relue\n');

{
    const son = path.join(box, 'son.wav');
    const fait = run(['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
        '-ar', '44100', '-ac', '1', '-y', son]);
    check('un son d\'essai est produit', fait.code === 0 && fs.existsSync(son), fait.err);

    // Exactement ce que le gestionnaire assemble : l'entrée noire à la
    // définition demandée, le son, puis les arguments du module.
    const { ext, args } = formats.videoEncodeArgs('mp4', 192, { still: true });
    const sortie = path.join(box, `resultat${ext}`);
    const res = run(['-v', 'error',
        '-f', 'lavfi', '-i', `color=c=black:s=${formats.blackCanvas(720)}:r=2`,
        '-i', son, ...args, '-y', sortie]);

    check('ffmpeg accepte la ligne de commande', res.code === 0, res.err);
    check('  … et écrit un fichier', fs.existsSync(sortie) && fs.statSync(sortie).size > 0,
        fs.existsSync(sortie) ? `${fs.statSync(sortie).size} octets` : 'absent');

    const info = probe(sortie);
    const flux = (info && info.streams) || [];
    const image = flux.find((s) => s.codec_type === 'video');
    const audio = flux.find((s) => s.codec_type === 'audio');

    check('le fichier porte bien une image', !!image,
        image ? `${image.codec_name} ${image.width}×${image.height}` : 'aucune');
    check('  … et le son d\'origine', !!audio, audio ? audio.codec_name : 'aucun');

    // La durée du noir est celle du son, et non l'inverse : c'est `-shortest`
    // qui le garantit, et c'est la seule chose qui empêche un fichier infini.
    const duree = info && info.format ? parseFloat(info.format.duration) : 0;
    check('  … sur la durée du son, pas au-delà', duree > 2.5 && duree < 4,
        `${duree.toFixed(2)} s pour 3 s de son`);

    /*
     * La définition demandée doit se retrouver dans le fichier.
     *
     * C'est tout l'objet du menu « Vidéo », qui restait grisé pour les
     * téléchargements : demander du 480p et recevoir un noir en 720p serait un
     * réglage qui ment. On l'éprouve sur une valeur qui n'est pas le défaut,
     * sans quoi le test passerait même si la hauteur était ignorée.
     */
    const petite = path.join(box, `petite${ext}`);
    run(['-v', 'error',
        '-f', 'lavfi', '-i', `color=c=black:s=${formats.blackCanvas(480)}:r=2`,
        '-i', son, ...args, '-y', petite]);

    const image480 = ((probe(petite) || {}).streams || []).find((s) => s.codec_type === 'video');
    check('la définition demandée est celle du fichier écrit',
        !!image480 && image480.width === 854 && image480.height === 480,
        image480 ? `${image480.width}×${image480.height} pour 480p demandé` : 'aucune image');
}

// ───────────────────── Les dimensions du noir ─────────────────────

console.log('\nLa taille de l\'image fabriquée\n');

{
    // Chaque entrée du menu, et le 16/9 qui en découle.
    const attendu = {
        2160: '3840x2160', 1440: '2560x1440', 1080: '1920x1080',
        720: '1280x720', 480: '854x480', 360: '640x360',
    };
    for (const [hauteur, taille] of Object.entries(attendu)) {
        check(`${hauteur}p donne ${taille}`, formats.blackCanvas(hauteur) === taille,
            formats.blackCanvas(hauteur));
    }

    // 480p est le cas qui casse une implémentation naïve : sa largeur exacte
    // vaut 853,33, et l'encodage en 4:2:0 refuse une dimension impaire.
    check('  … dont 480p, dont la largeur tombe juste entre deux pixels',
        formats.blackCanvas(480) === '854x480');

    check('un réglage absent ou absurde retombe sur une valeur qui existe',
        formats.blackCanvas(null) === '1280x720'
        && formats.blackCanvas('bêtise') === '1280x720'
        && formats.blackCanvas(12) === '1280x720',
        'une hauteur de douze pixels n\'est pas une demande');
}

fs.rmSync(box, { recursive: true, force: true });

// ───────────────────── Ce que la source répond ─────────────────────

console.log('\nCe que la recherche d\'image répond\n');

(async () => {
    const local = await videoSource.resolve('C:\\musique\\morceau.mp3');
    check('un chemin local n\'a pas d\'image à chercher',
        local.audioOnly === true && local.videoUrl === null,
        'les fichiers du disque sont copiés tels quels');

    const vide = await videoSource.resolve('');
    check('une adresse vide non plus', vide.audioOnly === true);

    // ───────────────────── Le raccordement ─────────────────────

    console.log('\nCe qui tient les deux bouts\n');

    const HANDLER = fs.readFileSync(
        path.join(ROOT, 'src', 'web', 'websocket', 'handlers', 'downloadHandlers.js'), 'utf8');

    check('un conteneur vidéo prend le chemin vidéo',
        /if \(downloadFormats\.isVideo\(container\)\)[\s\S]{0,200}transcodeVideo\(/.test(HANDLER),
        'la résolution audio ne rendrait qu\'un flux sonore');

    check('le repli reste dans la famille demandée',
        /isVideo\(wanted\)\s*\n?\s*\?\s*downloadFormats\.DEFAULT_VIDEO_CONTAINER/.test(HANDLER),
        'un MP3 pour une vidéo demandée ne répondrait pas à la question');

    // Sans ces `-map`, ffmpeg prendrait la meilleure piste de chaque type toutes
    // entrées confondues, et pourrait choisir le son muet de la vidéo.
    check('les flux recousus disent lequel donne quoi',
        /'-map', '0:v:0', '-map', '1:a:0'/.test(HANDLER));

    check('le lancement de ffmpeg est partagé par les deux chemins',
        /function runFfmpeg\(/.test(HANDLER)
        && (HANDLER.match(/runFfmpeg\(/g) || []).length >= 3,
        'la gestion d\'erreur ne se maintient pas en double');

    /*
     * La hauteur sert deux fois : à choisir le flux, et à tailler le noir.
     *
     * Elle voyage désormais avec le débit demandé, les deux étant satisfaits
     * séparément — une définition absente ne doit pas dégrader le son.
     */
    check('la définition demandée guide la recherche d\'image',
        /videoSource\.resolve\(url, \{ height, audioKbps/.test(HANDLER));
    check('  … et dimensionne l\'image fabriquée',
        /blackCanvas\(height\)/.test(HANDLER)
        && /color=c=black:s=\$\{canvas\}/.test(HANDLER),
        'une taille fixe ignorerait le menu');

    const APP = fs.readFileSync(
        path.join(ROOT, 'src', 'web', 'public', 'app.js'), 'utf8');

    /*
     * Le menu « Vidéo » restait grisé pour toute écriture sur le disque, et à
     * raison tant que celle-ci n'écrivait que du son. Il ne l'est plus dès
     * qu'un conteneur vidéo est choisi — sans quoi la définition ne pourrait
     * pas être demandée, et le reste de ce fichier ne servirait à rien.
     */
    check('le menu de définition n\'est plus grisé pour un conteneur vidéo',
        /not-applicable', !local && toDisk && !wantsVideo/.test(APP));

    check('  … et la liste des conteneurs vient du menu, pas d\'une copie',
        /optgroup\[data-i18n-label="import_group_video"\] option/.test(APP),
        'une copie se désaccorderait du balisage sans prévenir');

    console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
    process.exit(failed > 0 ? 1 : 0);
})();
