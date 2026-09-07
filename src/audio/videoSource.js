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
        .map((f) => Number(f.height)))]
        .sort((a, b) => b - a);

    const debits = formats
        .filter((f) => f && f.acodec && f.acodec !== 'none' && Number(f.abr) > 0)
        .map((f) => Number(f.abr));

    const value = {
        heights,
        audioKbps: debits.length ? Math.round(Math.max(...debits)) : null,
        known: true,
    };

    inventoryCache.set(url, { at: Date.now(), value });
    return value;
}

/**
 * Le meilleur flux vidéo à la résolution voulue, et le son qui va avec.
 *
 * @param {string} url - L'adresse de la piste, telle que l'extracteur la connaît.
 * @param {number} [height] - Hauteur visée, en pixels.
 * @returns {Promise<{ videoUrl: string|null, audioUrl: string|null, audioOnly: boolean,
 *   height: number|null }>}
 */
async function resolve(url, height = DEFAULT_HEIGHT) {
    const vide = { videoUrl: null, audioUrl: null, audioOnly: true, height: null };
    if (!url || !/^https?:\/\//i.test(url)) return vide;

    // Interrogation partagée avec `inventory` : une source qui ne répond pas
    // n'a pas d'image, et l'appelant en fabriquera une plutôt que d'échouer.
    const entry = await dump(url);

    const formats = (entry && Array.isArray(entry.formats)) ? entry.formats : [];
    if (!formats.length) return vide;

    const images = formats.filter((f) => f && f.vcodec && f.vcodec !== 'none' && f.height);
    if (!images.length) return vide;

    // La plus haute qui ne dépasse pas la cible ; à défaut la plus petite qui
    // existe, parce qu'une image trop grande vaut mieux que pas d'image.
    const choisi = images
        .filter((f) => f.height <= height)
        .sort((a, b) => b.height - a.height)[0]
        || images.sort((a, b) => a.height - b.height)[0];

    if (!choisi || !choisi.url) return vide;

    let audioUrl = null;
    if (!choisi.acodec || choisi.acodec === 'none') {
        const sons = formats
            .filter((f) => f && f.acodec && f.acodec !== 'none')
            .sort((a, b) => (b.tbr || 0) - (a.tbr || 0));
        audioUrl = sons[0] ? sons[0].url : null;
    }

    return {
        videoUrl: choisi.url,
        audioUrl,
        audioOnly: false,
        height: choisi.height || null,
    };
}

module.exports = { resolve, inventory, DEFAULT_HEIGHT };
