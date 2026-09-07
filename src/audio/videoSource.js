/**
 * videoSource — Trouver une image pour une piste, ou constater qu'il n'y en a pas.
 *
 * ## Le problème
 *
 * Le téléchargement vers le disque ne connaissait que le son : `resolveAudioInput`
 * rend un flux audio, et c'est tout ce dont les conteneurs MP3 ou FLAC ont
 * besoin. Demander un MP4 supposait donc une image que rien n'allait chercher.
 *
 * ## Ce que ce module répond
 *
 * Trois choses, et la troisième est celle qui compte : l'adresse du flux vidéo,
 * celle du flux audio quand il est séparé, et **la piste n'a-t-elle que du son**.
 *
 * Cette dernière n'est pas un échec. Un enregistrement mis en ligne sans clip
 * n'a pas d'image, et refuser de le télécharger en vidéo pour cette raison
 * répondrait à côté : ce qu'on veut, c'est un fichier qui se range avec les
 * autres vidéos et se lit dans un lecteur vidéo. L'appelant fabrique alors une
 * image noire — voir `videoEncodeArgs` — et le son y est intact.
 *
 * ## Pourquoi les flux arrivent parfois séparés
 *
 * Au-delà d'une certaine définition, YouTube ne sert plus l'image et le son
 * ensemble : il faut prendre les deux et les recoudre. Une résolution demandée
 * qui n'existe pas retombe sur la plus proche en dessous, et à défaut sur la plus
 * petite disponible — rendre une erreur là où une image existe serait mesquin.
 *
 * ## À rapprocher de `routes/api.js`
 *
 * La route de lecture fait le même choix de flux, pour l'envoyer au navigateur
 * plutôt que sur le disque. Les deux n'ont pas encore été fondues : celle-là vit
 * au milieu d'une route qui gère aussi les plages d'octets, le cache et les
 * codecs que `<video>` sait décoder, et l'en extraire sans pouvoir éprouver la
 * lecture de bout en bout coûterait plus cher que la duplication.
 */

const log = require('../utils/logger');

/** Résolution visée par défaut, quand l'appelant n'en demande pas. */
const DEFAULT_HEIGHT = 1080;

/**
 * Durée de vie de l'inventaire retenu, en millisecondes.
 *
 * Interroger la source prend une à trois secondes : le refaire à chaque
 * ouverture de menu serait insupportable, et la liste des formats d'une vidéo ne
 * change pas d'une minute à l'autre. Dix minutes couvrent une session d'écoute
 * sans figer une correction du côté de la plateforme.
 */
const INVENTORY_TTL_MS = 10 * 60 * 1000;

/** url → { at: horodatage, value: inventaire } */
const inventoryCache = new Map();

/**
 * Interroge la source et rend son entrée, ou null.
 *
 * Le résultat n'est pas retenu ici : `resolve` et `inventory` n'ont pas la même
 * durée de vie utile, et c'est à chacune de décider ce qu'elle garde.
 */
async function dump(url) {
    try {
        const youtubedl = require('youtube-dl-exec');
        const info = await youtubedl(url, {
            dumpSingleJson: true,
            noCheckCertificates: true,
            noWarnings: true,
            preferFreeFormats: true,
            addHeader: ['referer:youtube.com', 'user-agent:googlebot'],
        }, { windowsHide: true });
        return (info && info.entries && info.entries[0]) ? info.entries[0] : info;
    } catch (err) {
        // Source inconnue de l'outil, réseau coupé, page privée.
        log.debug(`[VideoSource] No format list for ${url}: ${err.message}`);
        return null;
    }
}

/**
 * Ce que la source porte réellement : définitions et meilleur débit sonore.
 *
 * Sert au menu clic droit, qui proposait jusqu'ici les six définitions et les
 * cinq débits sans savoir si le fichier existait dans aucun d'eux. Offrir du 4K
 * sur une vidéo mise en ligne en 720p n'est pas un choix, c'est une promesse
 * qu'on ne tient pas.
 *
 * Pour l'audio, la question n'est pas tout à fait la même : le bot transcode
 * vers le débit demandé, qui est donc toujours *techniquement* atteignable.
 * Mais transcoder une source à 128 kbps vers un MP3 à 320 n'ajoute rien —
 * seulement du poids. Le meilleur débit de la source dit donc jusqu'où le choix
 * a du sens.
 *
 * @param {string} url - Adresse **déjà pontée** : une piste Spotify ou Deezer
 *   doit être résolue par `resolvePlayableTrack` avant d'arriver ici, sans quoi
 *   l'on interrogerait une page qui ne porte aucun flux.
 * @returns {Promise<{ heights: number[], audioKbps: number|null, known: boolean }>}
 */
async function inventory(url) {
    const inconnu = { heights: [], audioKbps: null, known: false };
    if (!url || !/^https?:\/\//i.test(url)) return inconnu;

    const cached = inventoryCache.get(url);
    if (cached && Date.now() - cached.at < INVENTORY_TTL_MS) return cached.value;

    const entry = await dump(url);
    const formats = (entry && Array.isArray(entry.formats)) ? entry.formats : [];
    if (!formats.length) return inconnu;

    // Les définitions réellement présentes, sans doublon, de la plus haute à la
    // plus basse : la même hauteur revient souvent en plusieurs codecs.
    const heights = [...new Set(formats
        .filter((f) => f && f.vcodec && f.vcodec !== 'none' && f.height)
        .map(definitionOf)
        .filter((d) => d > 0))]
        .sort((a, b) => b - a);

    // Le débit annoncé au menu doit être celui qu'on ira chercher : c'est la
    // piste d'origine qui sera téléchargée, et non le doublage le mieux servi.
    const debits = audioTracks(entry).map(nominalKbps).filter((v) => v > 0);

    const value = {
        heights,
        audioKbps: debits.length ? Math.max(...debits) : null,
        known: true,
    };

    inventoryCache.set(url, { at: Date.now(), value });
    return value;
}

/** Les barreaux du menu, du plus haut au plus bas. */
const VIDEO_LADDER = [2160, 1440, 1080, 720, 480, 360];
const AUDIO_LADDER = [320, 256, 192, 128, 96];

/**
 * La définition d'un format, au sens où l'utilisateur l'entend.
 *
 * Ce n'est **pas** la hauteur en pixels, et c'est tout le piège. Une vidéo
 * verticale de 1080 × 1920 s'appelle « 1080p » chez YouTube comme partout
 * ailleurs : l'étiquette suit le petit côté, jamais la hauteur.
 *
 * Lire `height` faisait donc dire 1920 à ce que tout le monde nomme 1080p. Une
 * demande de 2160p y trouvait un « 1920 » inférieur et s'y arrêtait, si bien
 * qu'on croyait descendre d'un cran alors qu'on prenait la meilleure définition
 * existante — et le nombre affiché ne correspondait à aucun barreau du menu.
 *
 * @param {object} format
 * @returns {number} 0 quand le format n'a pas d'image.
 */
function definitionOf(format) {
    const w = Number(format && format.width) || 0;
    const h = Number(format && format.height) || 0;
    if (!h) return 0;
    return w ? Math.min(w, h) : h;
}

/**
 * Les protocoles qu'on sait consommer directement.
 *
 * Un `m3u8` n'est pas un flux : c'est une liste de morceaux, servie par une
 * adresse signée pour le client qui l'a demandée. ffmpeg s'y présente avec
 * l'en-tête du bot et se fait refuser — 404, zéro octet écrit, et un échec qui
 * ne dit pas son nom puisque l'adresse, elle, avait bien été « extraite ».
 */
const DIRECT_PROTOCOLS = new Set(['https', 'http']);

/**
 * Les pistes sonores dans la langue d'origine, quand la source le dit.
 *
 * YouTube ajoute désormais des doublages automatiques : une même vidéo porte
 * vingt pistes sonores, toutes annoncées avec le même sérieux. Rien dans leur
 * ordre ne distingue l'originale, et rien dans leur débit non plus — sur une
 * vidéo anglaise, le doublage indonésien sort à 124 kbps quand l'original tient
 * à 110. Choisir au meilleur débit revient donc à tirer une langue au hasard.
 *
 * Deux marques, dans cet ordre. `language_preference` vaut 10 sur la piste
 * d'origine et −1 sur les doublages : c'est la réponse directe. À défaut, la
 * langue déclarée de la vidéo tranche. Et si la source ne dit rien du tout —
 * cas de l'immense majorité, qui n'a qu'une piste —, tout est rendu tel quel :
 * filtrer sur une marque absente ne laisserait rien.
 *
 * @param {object[]} formats
 * @param {object|null} entry - L'entrée complète, qui porte la langue d'origine.
 * @returns {object[]}
 */
function originalLanguage(formats, entry) {
    const marques = formats.filter((f) => Number(f.language_preference) === 10);
    if (marques.length) return marques;

    const langue = entry && entry.language;
    if (langue) {
        const memeLangue = formats.filter(
            (f) => f.language && String(f.language).toLowerCase() === String(langue).toLowerCase());
        if (memeLangue.length) return memeLangue;
    }

    return formats;
}

/**
 * Les flux sonores utilisables d'une entrée, dans la langue d'origine.
 *
 * @param {object|null} entry
 * @returns {object[]} Du meilleur débit au moindre.
 */
function audioTracks(entry) {
    const formats = (entry && Array.isArray(entry.formats)) ? entry.formats : [];
    const utilisables = formats.filter((f) => f && f.url
        && f.acodec && f.acodec !== 'none'
        && DIRECT_PROTOCOLS.has(String(f.protocol)));

    // Le son seul d'abord. Un format complet ferait descendre l'image avec lui,
    // pour rien quand on n'encode que du son — mais il vaut mieux que rien.
    const seuls = utilisables.filter((f) => f.vcodec === 'none');
    const pool = seuls.length ? seuls : utilisables;

    return originalLanguage(pool, entry)
        .slice()
        .sort((a, b) => (Number(b.abr) || 0) - (Number(a.abr) || 0));
}

/**
 * Le meilleur flux sonore d'une entrée : direct, et dans la langue d'origine.
 *
 * @param {object|null} entry
 * @returns {object|null}
 */
function bestAudio(entry) {
    return audioTracks(entry)[0] || null;
}

/**
 * Le débit nominal d'un format, à partir de ce que la source mesure.
 *
 * `abr` est une moyenne relevée sur le fichier, pas l'étiquette du flux : un
 * AAC « 128 kbps » se mesure à 129,5, l'en-tête du conteneur comptant dans le
 * total. Pris au pied de la lettre, ce kilobit de trop fait qu'une demande de
 * 128 ne trouve plus rien à sa hauteur et dégringole au barreau du dessous —
 * 49 kbps pour un fichier qu'on croyait avoir demandé plein.
 *
 * Le repli à l'arrondi est essentiel : YouTube sert aussi du 160 et du 70, qui
 * ne sont les étiquettes de rien. Les ramener de force à un barreau du menu
 * annoncerait une qualité que la source ne porte pas.
 *
 * @param {object} format
 * @returns {number} 0 quand la source n'annonce aucun débit.
 */
function nominalKbps(format) {
    const mesure = Number(format && format.abr) || 0;
    if (!(mesure > 0)) return 0;

    // Cinq pour cent : de quoi absorber l'en-tête d'un conteneur, pas de quoi
    // confondre deux barreaux voisins, le plus resserré allant de 96 à 128.
    const barreau = AUDIO_LADDER.find((v) => mesure >= v && mesure <= v * 1.05);
    return barreau || Math.round(mesure);
}

/**
 * Descend jusqu'à ce que la source suive : la meilleure valeur qui ne dépasse
 * pas la demande.
 *
 * C'est bien « descendre d'un cran à la fois », mais sur les valeurs que la
 * source porte, et non sur les barreaux du menu. Pour la vidéo cela revient au
 * même — les hauteurs servies *sont* les barreaux — et pour l'audio cela change
 * tout : YouTube sert du 160, du 128, du 70, dont un seul est au menu. Marcher
 * sur les barreaux rendrait 128 pour une demande de 320 en laissant le 160 de
 * côté, c'est-à-dire moins bien que ce qui existe, et sans que rien ne le dise.
 *
 * Un dernier filet : si tout ce que porte la source est au-dessus de la demande,
 * on prend la plus basse. Mieux vaut trop que rien — une image de 2160p pèse
 * lourd, mais un fichier muet ou sans image ne vaut rien du tout.
 *
 * L'échelle du menu reste passée en argument : elle ne sert plus à choisir, mais
 * elle dit d'où vient la demande, et un appelant qui l'oublierait signalerait
 * qu'il a confondu les deux notions.
 *
 * @param {number[]} ladder - Les barreaux du menu, pour mémoire.
 * @param {number} requested
 * @param {number[]} available - Ce que la source porte réellement.
 * @returns {number|null}
 */
function stepDown(ladder, requested, available) {
    const has = [...new Set(available.map(Number))].filter((v) => Number.isFinite(v) && v > 0);
    const target = Number(requested);
    if (!has.length) return null;

    const below = has.filter((v) => v <= target).sort((a, b) => b - a);
    if (below.length) return below[0];

    return has.sort((a, b) => a - b)[0];
}

/**
 * Le flux sonore le plus proche du débit demandé, sans dépasser.
 *
 * Sert aux téléchargements qui n'écrivent que du son. Ils passaient jusqu'ici
 * par la résolution du préchargeur, qui rend le flux que l'extracteur propose
 * sans jamais regarder le débit voulu : le réglage n'agissait qu'au transcodage,
 * si bien qu'un choix à 320 kbps produisait bien un fichier de 320 kbps — mais
 * dont le contenu venait parfois d'une source à 70. Le nombre était exact, la
 * qualité imaginaire.
 *
 * Rend `null` plutôt qu'un pis-aller quand la source ne se laisse pas
 * inventorier : l'appelant retombe alors sur le chemin d'avant, qui fonctionne.
 *
 * @param {string} url - Adresse déjà pontée.
 * @param {number} kbps - Débit demandé.
 * @returns {Promise<{ url: string, kbps: number|null }|null>}
 */
async function resolveAudio(url, kbps) {
    if (!url || !/^https?:\/\//i.test(url)) return null;

    const entry = await dump(url);
    const sons = audioTracks(entry);
    if (!sons.length) return null;

    const debits = sons.map(nominalKbps).filter((v) => v > 0);
    if (!debits.length) return null;

    const retenu = stepDown(AUDIO_LADDER, kbps, debits);
    const exact = sons.find((f) => nominalKbps(f) === retenu);
    return exact ? { url: exact.url, kbps: retenu } : null;
}

/**
 * Le flux vidéo et le flux audio, choisis chacun pour son compte.
 *
 * Les deux demandes sont indépendantes — on peut vouloir du 1080p avec un son
 * modeste, ou l'inverse — et les chercher ensemble ferait qu'une définition
 * absente dégraderait le son sans raison. Chacun descend donc son échelle de son
 * côté, et l'on ne recoud qu'ensuite.
 *
 * Le son d'un format vidéo complet est pris tel quel : le séparer pour aller
 * chercher un autre débit obligerait à réencoder l'image, ce qu'on refuse par
 * ailleurs.
 *
 * @param {string} url - L'adresse de la piste, telle que l'extracteur la connaît.
 * @param {number|{height?: number, audioKbps?: number}} [wanted] - Hauteur visée,
 *   ou les deux demandes. Un nombre seul reste accepté pour les appels d'avant.
 * @returns {Promise<{ videoUrl: string|null, audioUrl: string|null, audioOnly: boolean,
 *   height: number|null, audioKbps: number|null }>}
 */
async function resolve(url, wanted = DEFAULT_HEIGHT) {
    const ask = typeof wanted === 'object' && wanted !== null ? wanted : { height: wanted };
    const height = Number.isFinite(Number(ask.height)) ? Number(ask.height) : DEFAULT_HEIGHT;
    const audioKbps = Number.isFinite(Number(ask.audioKbps)) ? Number(ask.audioKbps) : null;
    return resolveWith(url, height, audioKbps);
}

async function resolveWith(url, height, audioKbps) {
    const vide = {
        videoUrl: null, audioUrl: null, audioOnly: true, height: null, audioKbps: null,
    };
    if (!url || !/^https?:\/\//i.test(url)) return vide;

    // Interrogation partagée avec `inventory` : une source qui ne répond pas
    // n'a pas d'image, et l'appelant en fabriquera une plutôt que d'échouer.
    const entry = await dump(url);

    const formats = (entry && Array.isArray(entry.formats)) ? entry.formats : [];
    if (!formats.length) return vide;

    const images = formats.filter((f) => f && f.vcodec && f.vcodec !== 'none' && f.height);
    if (!images.length) return vide;

    // ── L'image, pour son compte ──
    const retenue = stepDown(VIDEO_LADDER, height, images.map(definitionOf));
    const candidates = images.filter((f) => definitionOf(f) === retenue);
    // À définition égale, le débit le plus élevé : c'est le même nombre de
    // pixels, mieux servis.
    const choisi = candidates.sort((a, b) => (b.tbr || 0) - (a.tbr || 0))[0];
    if (!choisi || !choisi.url) return vide;

    // ── Le son, pour le sien ──
    let audioUrl = null;
    let sonRetenu = null;

    if (!choisi.acodec || choisi.acodec === 'none') {
        // Déjà réduits à la langue d'origine, et déjà triés du meilleur débit
        // au moindre : recoudre l'image avec un doublage passerait inaperçu
        // jusqu'à la lecture.
        const sons = audioTracks(entry);
        const debits = sons.map(nominalKbps).filter((v) => v > 0);

        if (debits.length && audioKbps) {
            sonRetenu = stepDown(AUDIO_LADDER, audioKbps, debits);
            const exact = sons.filter((f) => nominalKbps(f) === sonRetenu);
            audioUrl = (exact[0] || null) && exact[0].url;
        }

        // Aucun débit annoncé, ou aucune demande : le meilleur disponible, comme
        // avant. Ne rien prendre laisserait une vidéo muette.
        if (!audioUrl) {
            const meilleur = sons[0];
            audioUrl = meilleur ? meilleur.url : null;
            sonRetenu = meilleur ? nominalKbps(meilleur) || null : null;
        }
    } else {
        // Format complet : son et image voyagent ensemble, et les séparer
        // obligerait à réencoder l'image pour les recoudre.
        sonRetenu = nominalKbps(choisi) || null;
    }

    return {
        videoUrl: choisi.url,
        audioUrl,
        audioOnly: false,
        height: definitionOf(choisi) || null,
        audioKbps: sonRetenu,
    };
}

module.exports = {
    resolve,
    resolveAudio,
    inventory,
    stepDown,
    nominalKbps,
    bestAudio,
    audioTracks,
    originalLanguage,
    VIDEO_LADDER,
    AUDIO_LADDER,
    DEFAULT_HEIGHT,
};
