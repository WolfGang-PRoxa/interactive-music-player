/**
 * Vérifie quelle piste sonore est retenue quand la source en porte plusieurs.
 *
 * YouTube ajoute désormais des doublages automatiques : une vidéo française
 * arrive avec une piste anglaise, une vidéo anglaise avec vingt pistes dont
 * l'arabe, le tamoul et le néerlandais. Toutes sont annoncées avec le même
 * sérieux, et rien dans leur ordre ne distingue l'originale.
 *
 * Le préchargement prenait la première de la liste. Trois choses s'y jouaient,
 * dont aucune ne se voit à la relecture.
 *
 *  - **L'ordre de yt-dlp va du pire au meilleur**, et place les variantes HLS
 *    en tête. La première n'était donc pas un flux mais un manifeste `.m3u8`,
 *    dont l'adresse est signée pour le client qui l'a demandée : ffmpeg s'y
 *    présentait avec l'en-tête du bot et se prenait un 404. L'adresse avait
 *    bien été « extraite » — le journal l'annonçait en succès — et zéro octet
 *    était écrit.
 *
 *  - **Le débit ne désigne pas l'originale.** Sur une vidéo anglaise, le
 *    doublage indonésien sort à 124 kbps quand l'original tient à 110. Trier au
 *    meilleur débit revient à tirer une langue au hasard, et le tirage ne se
 *    découvre qu'à l'écoute.
 *
 *  - **La marque existe, mais seulement parfois.** `language_preference` vaut
 *    10 sur la piste d'origine et −1 sur les doublages. L'immense majorité des
 *    vidéos n'a qu'une piste et ne porte aucune de ces marques : filtrer dessus
 *    sans repli ne laisserait rien du tout.
 *
 * Les extraits reproduisent la forme réelle des réponses de yt-dlp, relevées
 * sur les deux vidéos qui ont fait apparaître le défaut.
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');

let failed = 0;
let passed = 0;
const check = (label, ok, detail = '') => {
    if (ok) { passed++; console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`); }
    else { failed++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
};

/* ═══════════════════════ Les extraits ═══════════════════════ */

/** Un format sonore, tel que yt-dlp le décrit. */
const son = (o) => Object.assign({
    acodec: 'mp4a.40.2', vcodec: 'none', protocol: 'https',
    url: `https://exemple/${o.format_id}`,
}, o);

/**
 * Une vidéo française doublée en anglais, comme celle du signalement.
 *
 * L'ordre est celui de yt-dlp : manifestes d'abord, puis les flux directs du
 * plus petit débit au plus grand. Le premier de la liste est donc le pire choix
 * possible sur les deux plans à la fois.
 */
const DOUBLEE = {
    id: '9q9NJvRDzzM',
    language: 'fr-FR',
    formats: [
        son({ format_id: '233-0', protocol: 'm3u8_native', abr: null, language: 'en-US' }),
        son({ format_id: '233-1', protocol: 'm3u8_native', abr: null, language: 'fr-FR',
            language_preference: 10 }),
        son({ format_id: '139-0', abr: 48.787, language: 'en-US', language_preference: -1 }),
        son({ format_id: '139-1', abr: 48.79, language: 'fr-FR', language_preference: 10 }),
        son({ format_id: '140-0', abr: 129.475, language: 'en-US', language_preference: -1 }),
        son({ format_id: '140-1', abr: 129.477, language: 'fr-FR', language_preference: 10 }),
    ],
};

/**
 * Une vidéo anglaise doublée, où le doublage sort *au-dessus* de l'original.
 *
 * C'est le cas qui condamne le tri par débit : 124 kbps en indonésien contre
 * 110 en anglais d'origine. Un choix au mieux-disant prendrait l'indonésien.
 */
const DOUBLEE_MIEUX = {
    id: 'jS0nFxAHkBU',
    language: 'en-US',
    formats: [
        son({ format_id: '233-0', protocol: 'm3u8_native', abr: null, language: 'ar' }),
        son({ format_id: '251-19', abr: 124.615, language: 'id', language_preference: -1 }),
        son({ format_id: '251-20', abr: 110.418, language: 'en-US', language_preference: 10 }),
    ],
};

/** Le cas ordinaire : une seule piste, aucune marque de langue. */
const SIMPLE = {
    id: 'ordinaire',
    language: null,
    formats: [
        son({ format_id: '233', protocol: 'm3u8_native', abr: null }),
        son({ format_id: '139', abr: 49.2 }),
        son({ format_id: '140', abr: 129.5 }),
    ],
};

/* ═══════════════════════ Le module ═══════════════════════ */

const videoSource = require(path.join(ROOT, 'src', 'audio', 'videoSource.js'));

console.log('\n=== La piste sonore retenue ===\n');

// ───────────────────── Le manifeste ─────────────────────

console.log('Ce qui n\'est pas un flux\n');

{
    const choisi = videoSource.bestAudio(DOUBLEE);
    check('un manifeste HLS n\'est jamais retenu',
        choisi.protocol === 'https', `${choisi.format_id} en ${choisi.protocol}`);
    check('  … même placé en tête de liste',
        DOUBLEE.formats[0].protocol === 'm3u8_native' && choisi.format_id !== '233-0',
        'yt-dlp ordonne du pire au meilleur');

    // Ce n'est pas une question de goût : l'adresse d'un manifeste est signée
    // pour le client qui l'a demandée, et ffmpeg s'y voit refuser l'entrée.
    const tous = videoSource.audioTracks(DOUBLEE);
    check('aucun manifeste ne survit au filtre',
        tous.every((f) => f.protocol === 'https' || f.protocol === 'http'),
        '404 à l\'ouverture, et zéro octet écrit');
}

// ───────────────────── La langue ─────────────────────

console.log('\nLa langue d\'origine, toujours\n');

{
    const choisi = videoSource.bestAudio(DOUBLEE);
    check('la piste d\'origine est retenue', choisi.format_id === '140-1',
        `${choisi.language} — ${choisi.abr} kbps`);
    check('  … et non le doublage', choisi.language === 'fr-FR');

    // Les deux sont à 129 kbps : un départage au débit aurait pu tomber juste
    // par accident. Le cas suivant l'empêche.
    const mieux = videoSource.bestAudio(DOUBLEE_MIEUX);
    check('un doublage mieux servi ne passe pas devant',
        mieux.format_id === '251-20', `${mieux.language} — ${mieux.abr} kbps`);
    check('  … alors même qu\'il sonne plus haut',
        DOUBLEE_MIEUX.formats[1].abr > mieux.abr,
        `${DOUBLEE_MIEUX.formats[1].abr} kbps en indonésien contre ${mieux.abr}`);
}

{
    // La marque directe : `language_preference` vaut 10 sur l'originale.
    const gardes = videoSource.originalLanguage(DOUBLEE.formats, DOUBLEE);
    check('la marque de yt-dlp désigne l\'originale',
        gardes.every((f) => f.language === 'fr-FR'), `${gardes.length} formats gardés`);

    // Sans marque, la langue déclarée de la vidéo tranche.
    const sansMarque = {
        language: 'fr-FR',
        formats: [
            son({ format_id: 'a', abr: 130, language: 'en-US' }),
            son({ format_id: 'b', abr: 120, language: 'fr-FR' }),
        ],
    };
    check('à défaut, la langue déclarée de la vidéo tranche',
        videoSource.bestAudio(sansMarque).format_id === 'b',
        'et non le mieux servi');

    // Et si rien ne dit rien, tout reste : filtrer sur une marque absente ne
    // laisserait aucune piste, donc aucun son.
    const rendus = videoSource.originalLanguage(SIMPLE.formats, SIMPLE);
    check('une source muette sur la langue garde tous ses formats',
        rendus.length === SIMPLE.formats.length,
        'l\'immense majorité des vidéos n\'a qu\'une piste');
    check('  … et c\'est alors le meilleur débit qui gagne',
        videoSource.bestAudio(SIMPLE).format_id === '140');
}

// ───────────────────── Ce qui est utilisable ─────────────────────

console.log('\nCe qu\'on peut réellement lire\n');

{
    // Un format sans adresse ne mène nulle part.
    const bancal = {
        language: null,
        formats: [
            son({ format_id: 'sans-url', abr: 320, url: null }),
            son({ format_id: 'bon', abr: 128 }),
        ],
    };
    check('un format sans adresse est écarté',
        videoSource.bestAudio(bancal).format_id === 'bon',
        'même s\'il annonce le meilleur débit');

    // Le son seul plutôt qu'un format complet : descendre l'image avec lui
    // coûterait la bande passante d'une vidéo pour n'encoder que du son.
    const melange = {
        language: null,
        formats: [
            son({ format_id: 'complet', abr: 192, vcodec: 'avc1.4d401f' }),
            son({ format_id: 'seul', abr: 128 }),
        ],
    };
    check('le son seul passe avant un format complet',
        videoSource.bestAudio(melange).format_id === 'seul',
        'sinon on descend une vidéo entière pour n\'en garder que le son');

    // Mais un format complet vaut mieux que rien.
    const completSeulement = {
        language: null,
        formats: [son({ format_id: 'complet', abr: 192, vcodec: 'avc1.4d401f' })],
    };
    check('  … mais un format complet reste un repli',
        videoSource.bestAudio(completSeulement).format_id === 'complet');

    check('une source sans aucun son ne rend rien',
        videoSource.bestAudio({ formats: [] }) === null
        && videoSource.bestAudio(null) === null,
        'plutôt qu\'un pis-aller que l\'appelant croirait bon');

    // Une source qui ne porte que des manifestes : rien d'utilisable, et il
    // vaut mieux le dire que rendre une adresse qui échouera à l'ouverture.
    const queDesManifestes = {
        language: null,
        formats: [son({ format_id: '233', protocol: 'm3u8_native', abr: null })],
    };
    check('  … pas plus qu\'une source qui n\'offre que des manifestes',
        videoSource.bestAudio(queDesManifestes) === null);
}

// ───────────────────── Les mêmes règles partout ─────────────────────

console.log('\nLes trois chemins qui choisissent un son\n');

{
    /*
     * Le préchargement, le téléchargement audio et le téléchargement vidéo
     * choisissent chacun une piste sonore. Trois règles séparées finiraient par
     * diverger — et c'est déjà arrivé : le téléchargement filtrait sur le débit
     * annoncé, ce qui écartait les manifestes par accident, tandis que le
     * préchargement, lui, tombait dedans.
     */
    const SRC = fs.readFileSync(path.join(ROOT, 'src', 'audio', 'videoSource.js'), 'utf8');
    const PRELOAD = fs.readFileSync(path.join(ROOT, 'src', 'audio', 'PreloadManager.js'), 'utf8');

    check('le préchargement délègue le choix',
        /require\('\.\/videoSource'\)\.bestAudio\(entry\)/.test(PRELOAD));
    check('  … et ne prend plus le premier venu',
        !/audioFormats\.find\(f => f\.vcodec === 'none'\)/.test(PRELOAD),
        'yt-dlp met le pire en tête');

    check('le téléchargement audio passe par le même filtre',
        /const sons = audioTracks\(entry\);/.test(SRC));
    check('  … le téléchargement vidéo aussi',
        (SRC.match(/audioTracks\(entry\)/g) || []).length >= 3,
        'recoudre une image avec un doublage passerait inaperçu jusqu\'à la lecture');

    /*
     * Le menu doit promettre ce que le téléchargement ira chercher. S'il
     * annonçait le débit du doublage le mieux servi, l'utilisateur choisirait
     * une qualité que le fichier obtenu n'aurait pas.
     */
    check('l\'inventaire annonce le débit de la piste d\'origine',
        /const debits = audioTracks\(entry\)/.test(SRC));
}

{
    /*
     * Le repli ne doit pas emporter ce qui marchait.
     *
     * Il se déclenche dès que `ffmpegInput` est vide — y compris quand
     * l'extracteur a fourni un flux parfaitement lisible. En écrivant
     * `inputStream = null` sans avoir rien trouvé de mieux, on repartait les
     * mains vides d'une piste qui s'entendait très bien.
     */
    const PRELOAD = fs.readFileSync(path.join(ROOT, 'src', 'audio', 'PreloadManager.js'), 'utf8');
    const bloc = PRELOAD.slice(PRELOAD.indexOf('bestAudio(entry)'),
        PRELOAD.indexOf('} catch (ytdlErr)'));

    check('le flux de l\'extracteur n\'est lâché que pour mieux',
        /if \(chosen && chosen\.url\)/.test(bloc) && /inputStream = null;/.test(bloc)
        && bloc.indexOf('inputStream = null;') > bloc.indexOf('if (chosen && chosen.url)'),
        'l\'abandonner sans rien en échange laissait une piste muette');
    check('  … et le journal dit ce qui a été retenu',
        /chosen\.format_id/.test(bloc) && /langue/.test(bloc),
        'un « succès » qui ne nomme rien a masqué ce défaut pendant tout ce temps');
}

// ───────────────────── De bout en bout ─────────────────────

console.log('\nCe que le téléchargement rend, sans réseau\n');

{
    /*
     * `resolveAudio` interroge la source ; on lui substitue la réponse relevée
     * sur la vidéo du signalement. C'est le seul moyen d'éprouver le chemin
     * complet — filtre, choix de langue et descente de débit — sans dépendre de
     * YouTube ni du réseau.
     */
    const ytdlPath = require.resolve('youtube-dl-exec');
    const faux = new Module(ytdlPath);
    faux.filename = ytdlPath;
    faux.loaded = true;
    faux.exports = async () => DOUBLEE;
    require.cache[ytdlPath] = faux;

    (async () => {
        const retenu = await videoSource.resolveAudio('https://youtube.com/watch?v=9q9NJvRDzzM', 128);
        check('un téléchargement à 128 kbps prend l\'original',
            retenu && retenu.url === 'https://exemple/140-1',
            retenu ? `${retenu.url} à ${retenu.kbps} kbps` : 'rien');

        // 320 n'existe pas : on descend sur ce que la source porte vraiment,
        // et sans changer de langue en chemin.
        const haut = await videoSource.resolveAudio('https://youtube.com/watch?v=9q9NJvRDzzM', 320);
        check('  … et une demande trop haute descend sans changer de langue',
            haut && haut.url === 'https://exemple/140-1',
            haut ? `${haut.url} à ${haut.kbps} kbps` : 'rien');

        delete require.cache[ytdlPath];

        console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
        process.exit(failed > 0 ? 1 : 0);
    })();
}
