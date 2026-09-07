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

    let entry;
    try {
        const youtubedl = require('youtube-dl-exec');
        const info = await youtubedl(url, {
            dumpSingleJson: true,
            noCheckCertificates: true,
            noWarnings: true,
            preferFreeFormats: true,
            addHeader: ['referer:youtube.com', 'user-agent:googlebot'],
        }, { windowsHide: true });
        entry = (info && info.entries && info.entries[0]) ? info.entries[0] : info;
    } catch (err) {
        // Source inconnue de l'outil, réseau coupé, page privée : il n'y a pas
        // d'image, et l'appelant en fabriquera une plutôt que d'échouer.
        log.debug(`[VideoSource] No format list for ${url}: ${err.message}`);
        return vide;
    }

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

module.exports = { resolve, DEFAULT_HEIGHT };
