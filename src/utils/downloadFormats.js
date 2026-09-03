/**
 * downloadFormats — Les conteneurs proposés au téléchargement vers le disque.
 *
 * Le menu « Format » de la boîte d'ajout ne choisit qu'une extension ; le débit,
 * lui, vient du menu « Audio » voisin. Ce module fait la jonction : à partir
 * d'un conteneur et d'un débit, il rend l'extension et les arguments que ffmpeg
 * attend.
 *
 * Seuls des conteneurs **audio** figurent ici. Le chemin de téléchargement vers
 * le disque passe par `resolveAudioInput` du préchargeur, qui rend un flux
 * audio : proposer MP4 reviendrait à promettre une vidéo que rien n'irait
 * chercher. La vidéo a son propre chemin, celui de `/api/download`, et
 * l'apporter ici demanderait de l'y brancher.
 *
 * À rapprocher de la table de `routes/api.js`, qui sert le téléchargement d'une
 * piste vers le navigateur. Les deux disent les mêmes codecs, mais ne répondent
 * pas à la même question : celle-là offre des combinaisons format + qualité
 * toutes faites — « MP3 320 », « FLAC studio » —, celle-ci compose un conteneur
 * avec un débit choisi ailleurs. Les fusionner demanderait de plier l'une des
 * deux formes à l'autre.
 */

/**
 * Conteneurs, dans l'ordre où le menu les présente : du plus courant au plus
 * spécialisé, les deux sans perte au milieu.
 *
 * `lossless` marque ceux pour lesquels le débit ne veut rien dire : le menu
 * « Audio » ne les concerne pas, et un `-ab` y serait ignoré par ffmpeg.
 */
const CONTAINERS = {
    mp3: { label: 'MP3', codec: 'libmp3lame', mux: 'mp3' },
    m4a: { label: 'M4A', codec: 'aac', mux: 'ipod' },
    flac: { label: 'FLAC', codec: 'flac', mux: 'flac', lossless: true },
    wav: { label: 'WAV', codec: 'pcm_s16le', mux: 'wav', lossless: true },
    ogg: { label: 'OGG', codec: 'libvorbis', mux: 'ogg' },
    opus: { label: 'OPUS', codec: 'libopus', mux: 'opus' },
    webm: { label: 'WEBM', codec: 'libopus', mux: 'webm' },
};

/** Le conteneur retenu quand rien n'a été choisi, ou que le choix est inconnu. */
const DEFAULT_CONTAINER = 'mp3';

/** Les extensions acceptées, pour valider ce qui arrive du tableau de bord. */
const EXTENSIONS = Object.keys(CONTAINERS);

/**
 * Ce qu'il faut passer à ffmpeg pour écrire dans ce conteneur.
 *
 * Le muxer est nommé explicitement plutôt que laissé à deviner d'après
 * l'extension : ffmpeg le déduit correctement dans la plupart des cas, mais
 * « .m4a » demande le muxer `ipod` — un nom que rien dans l'extension
 * n'annonce — et c'est déjà ainsi que la route de téléchargement le nomme.
 *
 * @param {string} container Une clé de CONTAINERS ; inconnue, on retombe sur MP3.
 * @param {number|string} bitrate Débit en kbps, ignoré par les formats sans perte.
 * @returns {{ ext: string, args: string[] }}
 */
function encodeArgs(container, bitrate) {
    const key = EXTENSIONS.includes(String(container)) ? String(container) : DEFAULT_CONTAINER;
    const spec = CONTAINERS[key];

    const args = ['-acodec', spec.codec];
    if (!spec.lossless) {
        const kbps = parseInt(bitrate, 10);
        args.push('-ab', `${Number.isFinite(kbps) && kbps > 0 ? kbps : 320}k`);
    }
    args.push('-f', spec.mux);

    return { ext: `.${key}`, args };
}

module.exports = {
    CONTAINERS,
    EXTENSIONS,
    DEFAULT_CONTAINER,
    encodeArgs,
};
