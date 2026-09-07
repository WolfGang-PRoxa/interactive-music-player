/**
 * downloadFormats — Les conteneurs proposés au téléchargement vers le disque.
 *
 * Le menu « Format » de la boîte d'ajout ne choisit qu'une extension ; le débit,
 * lui, vient du menu « Audio » voisin. Ce module fait la jonction : à partir
 * d'un conteneur et d'un débit, il rend l'extension et les arguments que ffmpeg
 * attend.
 *
 * Les conteneurs **vidéo** y figurent depuis qu'une source d'image est allée les
 * chercher (voir `videoSource`). Ils restent rangés à part : le débit du menu
 * « Audio » n'y concerne que la piste sonore, et l'image, quand il y en a une,
 * est recopiée sans être touchée.
 *
 * Une source purement sonore ne fait pas échouer une demande de vidéo — elle en
 * reçoit une, noire, portant le son. C'est un choix : rendre un fichier audio à
 * la place répondrait à côté de la question posée, et échouer laisserait
 * l'utilisateur sans rien alors qu'un fichier était possible.
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

/**
 * Conteneurs vidéo.
 *
 * Rangés à part parce qu'ils ne répondent pas à la même question : le débit du
 * menu « Audio » n'y concerne que la piste sonore, et la vidéo, elle, est
 * recopiée telle quelle quand elle existe — la réencoder ferait perdre en
 * qualité ce qu'on venait chercher, et prendrait cent fois plus de temps.
 *
 * Deux seulement, et WEBM n'en est pas : la clé est déjà prise par le conteneur
 * audio du même nom, et deux entrées homonymes dans un menu déroulant ne se
 * distinguent pas. MKV accepte à peu près tout sans réencoder, MP4 est celui que
 * tout lit.
 */
const VIDEO_CONTAINERS = {
    mp4: { label: 'MP4', mux: 'mp4', video: true },
    mkv: { label: 'MKV', mux: 'matroska', video: true },
};

/** Le conteneur retenu quand rien n'a été choisi, ou que le choix est inconnu. */
const DEFAULT_CONTAINER = 'mp3';

/**
 * Le repli des conteneurs vidéo.
 *
 * Retomber sur MP3 comme le fait l'audio serait un contresens : on a demandé une
 * vidéo, et rendre un fichier sonore à la place ne répond pas à la question
 * posée. MP4 est le format que tout lit — s'il échoue à son tour, c'est que le
 * problème n'est pas le conteneur.
 */
const DEFAULT_VIDEO_CONTAINER = 'mp4';

/** Les extensions acceptées, pour valider ce qui arrive du tableau de bord. */
const EXTENSIONS = [...Object.keys(CONTAINERS), ...Object.keys(VIDEO_CONTAINERS)];

/** Ce conteneur attend-il une image ? */
function isVideo(container) {
    return Object.prototype.hasOwnProperty.call(VIDEO_CONTAINERS, String(container));
}

/** Hauteur retenue quand le réglage manque ou n'a pas de sens. */
const DEFAULT_HEIGHT = 720;

/**
 * Les dimensions d'une image noire, pour la définition demandée.
 *
 * Le menu ne propose qu'une hauteur — c'est ainsi qu'on parle des définitions —
 * et le 16/9 en donne la largeur. Une image noire n'a certes pas de cadrage
 * propre, mais elle se range avec de vraies vidéos : un 4/3 y sauterait aux yeux
 * dans une bibliothèque, et certains lecteurs ajoutent des bandes pour compenser.
 *
 * Les deux nombres sont arrondis au pair. L'encodage en 4:2:0 échantillonne la
 * couleur par blocs de deux pixels, et refuse une dimension impaire — 480p, dont
 * la largeur exacte vaut 853,33, échouerait sans cet arrondi.
 *
 * @param {number|string} height
 * @returns {string} « 1280x720 », tel que le filtre `color` l'attend.
 */
function blackCanvas(height) {
    const asked = parseInt(height, 10);
    const safe = Number.isFinite(asked) && asked >= 144 ? asked : DEFAULT_HEIGHT;
    const h = safe % 2 ? safe + 1 : safe;
    const w = Math.round((h * 16) / 9);
    return `${w % 2 ? w + 1 : w}x${h}`;
}

/**
 * Ce qu'il faut passer à ffmpeg pour écrire une vidéo.
 *
 * Deux cas, et c'est tout l'objet de cette fonction.
 *
 * **La source porte une image** : elle est recopiée sans être touchée. Le son,
 * lui, est réencodé — les pistes d'origine sont souvent en Opus, que MP4
 * n'accepte pas, et découvrir l'incompatibilité au dernier moment coûterait un
 * fichier illisible plutôt qu'une erreur.
 *
 * **La source n'est que du son** : il n'y a pas d'image à copier, on en
 * fabrique une. Deux images par seconde suffisent pour un fond noir immobile, et
 * `stillimage` dit à l'encodeur de ne pas chercher le mouvement qu'il n'y a pas.
 * Le fichier obtenu pèse alors quelques dizaines de kilo-octets de plus que le
 * son seul, là où une vidéo à 30 images par seconde en coûterait mille.
 *
 * @param {string} container
 * @param {number|string} bitrate - Débit de la piste sonore, en kbps.
 * @param {{ still?: boolean }} [options] - `still` : aucune image dans la source.
 * @returns {{ ext: string, args: string[] }}
 */
function videoEncodeArgs(container, bitrate, options = {}) {
    const key = isVideo(container) ? String(container) : DEFAULT_VIDEO_CONTAINER;
    const spec = VIDEO_CONTAINERS[key];

    const kbps = parseInt(bitrate, 10);
    const audio = ['-c:a', 'aac', '-b:a', `${Number.isFinite(kbps) && kbps > 0 ? kbps : 192}k`];

    const args = options.still
        ? ['-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'stillimage',
            '-pix_fmt', 'yuv420p', ...audio]
        : ['-c:v', 'copy', ...audio];

    // MP4 range ses tables en fin de fichier : les remonter en tête permet de
    // lire le résultat sans l'avoir entièrement reçu.
    if (key === 'mp4') args.push('-movflags', '+faststart');

    args.push('-f', spec.mux);
    return { ext: `.${key}`, args };
}

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
    // Validé sur les conteneurs audio, et non sur `EXTENSIONS` qui porte aussi
    // les vidéo : « mp4 » y passerait, puis chercherait un codec audio qui
    // n'existe pas. Un conteneur vidéo demandé ici est une erreur d'appelant,
    // et retomber sur MP3 la rend visible sans casser le téléchargement.
    const key = Object.prototype.hasOwnProperty.call(CONTAINERS, String(container))
        ? String(container)
        : DEFAULT_CONTAINER;
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
    VIDEO_CONTAINERS,
    EXTENSIONS,
    DEFAULT_CONTAINER,
    DEFAULT_VIDEO_CONTAINER,
    isVideo,
    blackCanvas,
    DEFAULT_HEIGHT,
    encodeArgs,
    videoEncodeArgs,
};
