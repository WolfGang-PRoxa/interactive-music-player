/**
 * Téléchargement vers le disque du bot.
 *
 * Quatrième destination de la boîte d'ajout. Les trois autres mènent au
 * lecteur — la file, la playlist active, la lecture immédiate ; celle-ci n'y
 * mène pas : elle écrit un fichier et s'arrête là.
 *
 * Elle réemploie la résolution du préchargeur plutôt que d'en écrire une
 * seconde. C'est la même recette qui rend une piste jouable — l'hydrater par
 * `player.search`, la ponter si sa source ne diffuse pas d'audio, ramener les
 * quatre formes qu'un extracteur peut rendre aux deux que ffmpeg connaît —, et
 * la maintenir en double aurait garanti qu'un jour l'une des deux sache faire
 * ce que l'autre ne sait plus.
 *
 * Un fichier déjà présent sur le disque est copié, non transcodé : l'utilisateur
 * a demandé à l'avoir dans son dossier, pas à en perdre la qualité au passage.
 */

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const database = require('../../../database/Database');
const preloadManager = require('../../../audio/PreloadManager');
const { searchLocalAwareTrack } = require('../handlerUtils');
const downloadDir = require('../../../utils/downloadDir');
const downloadFormats = require('../../../utils/downloadFormats');
const videoSource = require('../../../audio/videoSource');
const rangeStream = require('../../../audio/rangeStream');
const log = require('../../../utils/logger');

/** Débits acceptés, repris des réglages d'import de la boîte. */
const VALID_BITRATES = ['96', '128', '192', '256', '320'];
const DEFAULT_BITRATE = '320';

/** Dossier de destination, créé au besoin. */
function targetDir() {
    const chosen = database.getDownloadDir();
    return downloadDir.ensure(chosen || downloadDir.DEFAULT_DIR);
}

/** Conteneur choisi dans le menu « Format », ou le repli du module. */
function containerFor(guildId) {
    try {
        const choice = String(database.getSettings(guildId).importFormat || '');
        return downloadFormats.EXTENSIONS.includes(choice)
            ? choice
            : downloadFormats.DEFAULT_CONTAINER;
    } catch (e) {
        return downloadFormats.DEFAULT_CONTAINER;
    }
}

/**
 * Définition visée, en pixels de hauteur, telle que le menu « Vidéo » la donne.
 *
 * Elle sert deux fois, et c'est pourquoi elle n'était plus grisée : à choisir le
 * flux qu'on va chercher, et — quand la source n'a pas d'image — à dimensionner
 * celle qu'on fabrique. Demander du 1080p et recevoir un noir en 720p serait un
 * réglage qui ment.
 */
function videoHeightFor(guildId) {
    try {
        const choice = parseInt(database.getSettings(guildId).importVideoQuality, 10);
        return Number.isFinite(choice) && choice > 0 ? choice : downloadFormats.DEFAULT_HEIGHT;
    } catch (e) {
        return downloadFormats.DEFAULT_HEIGHT;
    }
}

function bitrateFor(guildId) {
    try {
        const choice = String(database.getSettings(guildId).importAudioQuality || '');
        return VALID_BITRATES.includes(choice) ? choice : DEFAULT_BITRATE;
    } catch (e) {
        return DEFAULT_BITRATE;
    }
}

/**
 * Copie un fichier déjà présent sur le disque.
 *
 * @returns {Promise<string>} Chemin écrit.
 */
function copyLocal(source, dir) {
    const extension = path.extname(source) || '.mp3';
    const name = downloadDir.safeFilename(path.basename(source, extension), extension);
    const destination = downloadDir.uniquePath(dir, name);

    return new Promise((resolve, reject) => {
        fs.copyFile(source, destination, (err) => {
            if (err) reject(err);
            else resolve(destination);
        });
    });
}

/**
 * Ramène une entrée distante à un flux poussé dans l'entrée standard.
 *
 * Tendre une URL à ffmpeg le fait ouvrir une requête et la garder ouverte du
 * début à la fin : YouTube bride alors ce téléchargement au débit de lecture —
 * 32 Ko/s là où la même adresse, demandée par tranches, se sert à 38 Mo/s. Voir
 * `rangeStream`, où la mesure est détaillée.
 *
 * Ne convient qu'aux commandes à une seule entrée distante : ffmpeg n'a qu'une
 * entrée standard. Pour les autres, `fetchToFile`.
 *
 * @param {{ ffmpegInput: string|null, inputStream: object|null, headers?: object }} input
 *   `headers` : ceux que yt-dlp a employés pour obtenir l'adresse, quand on les
 *   connaît. Sans eux, rien de particulier : googlevideo sert sans.
 * @returns {{ ffmpegInput: string, inputStream: object|null }}
 */
function pipeRemote(input) {
    const url = input.ffmpegInput;

    if (url && /^https?:\/\//i.test(url)) {
        return {
            ffmpegInput: 'pipe:0',
            inputStream: rangeStream.chunkedFetch(url, { headers: input.headers || {} }),
        };
    }

    // Déjà un flux — celui d'un extracteur, ou les tranches que le préchargeur
    // a montées lui-même —, ou bien un fichier du disque.
    return {
        ffmpegInput: url || 'pipe:0',
        inputStream: input.inputStream || null,
    };
}

/**
 * Transcode une source distante vers un MP3 du dossier.
 *
 * L'écriture se fait sous un nom provisoire, renommé une fois seulement le
 * transcodage réussi. Un téléchargement interrompu — bot arrêté, réseau coupé,
 * source qui se refuse à mi-parcours — ne laisse donc pas de fichier tronqué au
 * milieu d'une bibliothèque musicale, où il passerait pour un morceau valide
 * jusqu'au jour où on le lirait.
 *
 * @returns {Promise<string>} Chemin écrit.
 */
function transcodeRemote(input, dir, title, bitrate, container) {
    const { ext, args: encoding } = downloadFormats.encodeArgs(container, bitrate);
    const finalPath = downloadDir.uniquePath(dir, downloadDir.safeFilename(title, ext));
    const partial = `${finalPath}.incomplete`;

    const args = [];

    // Une seule entrée à alimenter : les tranches passent par l'entrée standard,
    // et il n'y a pas de fichier intermédiaire à ranger ensuite.
    const source = pipeRemote(input);

    args.push('-i', source.ffmpegInput);
    // `-vn` : la source porte souvent une pochette en flux vidéo, que les
    // muxers audio ne savent ranger que dans une étiquette. Sans cela ffmpeg
    // s'arrête sur « nothing was written into output file ». Voir
    // PreloadManager, où le même écueil a été rencontré.
    args.push('-vn', ...encoding, '-y', partial);

    return runFfmpeg(args, source.inputStream, partial, finalPath, title);
}

/**
 * Lance ffmpeg, surveille sa sortie, et ne renomme qu'au succès.
 *
 * Partagé par l'audio et la vidéo : les deux ne diffèrent que par les arguments,
 * et tout ce qui suit — le diagnostic gardé pour le seul cas d'échec, le flux
 * d'entrée qu'il faut garder d'abattre le bot, le fichier partiel effacé plutôt
 * que laissé au milieu d'une bibliothèque — leur est commun.
 *
 * @param {string[]} args - La ligne de commande, fichier partiel compris.
 * @param {NodeJS.ReadableStream|null} inputStream - Source à pousser sur stdin.
 * @param {string} partial
 * @param {string} finalPath
 * @param {string} title
 * @returns {Promise<string>} Chemin écrit.
 */
function runFfmpeg(args, inputStream, partial, finalPath, title) {
    const input = { inputStream };

    return new Promise((resolve, reject) => {
        const ffmpeg = require('ffmpeg-static');

        const child = cp.spawn(ffmpeg, args, {
            stdio: ['pipe', 'ignore', 'pipe'],
            windowsHide: true,
        });

        // Les dernières lignes de ffmpeg, gardées pour le seul cas d'échec : son
        // diagnostic est alors la seule explication disponible.
        let stderrTail = '';
        if (child.stderr) {
            child.stderr.on('data', (chunk) => {
                stderrTail = (stderrTail + chunk.toString()).slice(-800);
            });
        }

        if (input.inputStream) {
            // Sans ces gardes, une source qui se coupe fait remonter un `error`
            // sur un flux qui n'en écoute pas : Node abat alors le processus
            // entier, bot compris.
            input.inputStream.on('error', (err) => {
                log.error(`[Download] Source stream error for ${title}:`, err.message);
                try { child.kill(); } catch (e) {}
            });
            if (child.stdin) {
                child.stdin.on('error', (err) => {
                    if (err.code !== 'EPIPE') {
                        log.error(`[Download] ffmpeg stdin error for ${title}:`, err.message);
                    }
                });
            }
            input.inputStream.pipe(child.stdin);
        }

        const fail = (message) => {
            try { fs.unlinkSync(partial); } catch (e) {}
            reject(new Error(message));
        };

        child.on('error', (err) => fail(err.message));

        child.on('close', (code) => {
            if (code !== 0) {
                const last = stderrTail.trim().split('\n').slice(-2).join(' | ');
                return fail(last || `ffmpeg code ${code}`);
            }
            try {
                fs.renameSync(partial, finalPath);
            } catch (err) {
                return fail(err.message);
            }
            resolve(finalPath);
        });
    });
}

/**
 * Télécharge la piste en vidéo, avec ou sans image d'origine.
 *
 * Deux cas, décidés par `videoSource`.
 *
 * **La source porte une image** : elle est recopiée sans être touchée. Quand le
 * son arrive séparément — ce que YouTube fait au-delà d'une certaine définition
 * — les deux entrées sont recousues, et `-map` désigne laquelle donne quoi.
 * Sans ces `-map`, ffmpeg choisirait la meilleure piste de chaque type toutes
 * entrées confondues, et pourrait prendre le son muet de la vidéo.
 *
 * **La source n'a que du son** : une image noire est fabriquée à la volée. Ce
 * n'est pas un pis-aller mais la réponse à la demande — un enregistrement mis en
 * ligne sans clip n'a pas d'image, et l'on veut malgré tout un fichier qui se
 * range avec les vidéos. `-shortest` cale la durée sur le son, faute de quoi le
 * noir tournerait indéfiniment.
 *
 * @returns {Promise<string>} Chemin écrit.
 */
async function transcodeVideo(track, url, dir, title, bitrate, container, height) {
    // Les deux demandes voyagent ensemble mais sont satisfaites séparément :
    // une définition absente ne doit pas dégrader le son, ni l'inverse.
    const source = await videoSource.resolve(url, { height, audioKbps: Number(bitrate) });

    const { ext, args: encoding } =
        downloadFormats.videoEncodeArgs(container, bitrate, { still: source.audioOnly });
    const finalPath = downloadDir.uniquePath(dir, downloadDir.safeFilename(title, ext));
    const partial = `${finalPath}.incomplete`;

    const args = [];
    let stdin = null;
    const temporaires = [];

    /**
     * Rapatrie une adresse dans un fichier voisin du fichier final.
     *
     * Le dossier de destination plutôt que celui du système : c'est le seul
     * dont on sait qu'il existe, qu'on peut y écrire et qu'il a la place — une
     * vidéo en 2160p ne tient pas partout.
     */
    const rapatrier = async (adresse, role, headers) => {
        const chemin = `${partial}.${role}`;
        temporaires.push(chemin);
        await rangeStream.fetchToFile(adresse, chemin, { headers: headers || {} });
        return chemin;
    };

    try {
        if (source.audioOnly) {
            // Le son d'abord, par le chemin ordinaire : c'est le seul flux dont
            // on dispose, et il peut arriver autrement qu'en URL directe.
            const input = pipeRemote(await preloadManager.resolveAudioInput(track, url));
            if (input.ffmpegInput === 'pipe:0' && !input.inputStream) {
                throw new Error(`Aucune source pour « ${title} »`);
            }

            // Une seule entrée distante : l'entrée standard suffit, et rien
            // n'a besoin d'être posé sur le disque au passage.
            stdin = input.inputStream;

            // La définition demandée, et non une taille fixe : le menu la
            // propose, elle doit donc se retrouver dans le fichier écrit.
            const canvas = downloadFormats.blackCanvas(height);
            args.push('-f', 'lavfi', '-i', `color=c=black:s=${canvas}:r=2`);
            args.push('-i', input.ffmpegInput);
        } else {
            /*
             * Image et son passent par des fichiers, et non par des URL.
             *
             * Deux raisons, dont la seconde suffirait. ffmpeg n'a qu'une entrée
             * standard, et il en faudrait deux quand la source sert l'image et
             * le son séparément. Et une URL tendue telle quelle est bridée au
             * débit de lecture : une vidéo de dix minutes mettrait dix minutes
             * à se télécharger, deux fois plutôt qu'une.
             *
             * Le fichier a de surcroît ce que le tuyau n'a pas : ffmpeg peut
             * s'y déplacer. Recopier une piste vidéo sans la réencoder demande
             * de lire l'index du conteneur, qui vit parfois à la fin.
             */
            args.push('-i', await rapatrier(source.videoUrl, 'video', source.videoHeaders));

            if (source.audioUrl) {
                args.push('-i', await rapatrier(source.audioUrl, 'audio', source.audioHeaders));
                args.push('-map', '0:v:0', '-map', '1:a:0');
            }
        }

        args.push(...encoding, '-y', partial);
        return await runFfmpeg(args, stdin, partial, finalPath, title);
    } finally {
        // Réussite ou échec, ces fichiers-là n'ont plus rien à faire dans un
        // dossier de musique.
        for (const chemin of temporaires) {
            try { fs.unlinkSync(chemin); } catch (e) {}
        }
    }
}

/**
 * Télécharge la piste désignée par une requête vers le dossier choisi.
 *
 * @param {object} ctx Contexte assemblé par wsHandler.
 */
async function handleDownloadTrack(ctx) {
    const { data, webServer, player, currentGuildId } = ctx;
    const query = data && typeof data.query === 'string' ? data.query.trim() : '';
    if (!query) return;

    let dir;
    try {
        dir = targetDir();
    } catch (err) {
        log.error('[Download] Destination folder unusable:', err.message);
        webServer._sendError(`Dossier de téléchargement inutilisable : ${err.message}`);
        return;
    }

    try {
        const searchResult = await searchLocalAwareTrack(player, query);
        if (!searchResult || !searchResult.tracks || searchResult.tracks.length === 0) {
            webServer._sendError('Ce morceau est introuvable : sa source ne répond pas.');
            return;
        }

        const track = searchResult.tracks[0];
        const title = track.title || query;
        webServer._sendError(`Téléchargement de « ${title} »…`);

        // Un fichier du disque : copié tel quel. Le transcoder reviendrait à
        // dégrader un original que l'utilisateur possède déjà.
        const isLocal = !/^https?:\/\//i.test(track.url || '')
            && fs.existsSync(path.resolve(track.url || ''));

        let written;
        if (isLocal) {
            written = await copyLocal(path.resolve(track.url), dir);
        } else {
            const playable = await preloadManager.resolvePlayableTrack(track);
            const trackTitle = playable.track.title || title;
            const bitrate = bitrateFor(currentGuildId);
            const videoHeight = videoHeightFor(currentGuildId);
            const wanted = containerFor(currentGuildId);

            /**
             * Une tentative d'encodage, entrée fraîchement résolue.
             *
             * L'entrée est redemandée à chaque essai, et ce n'est pas un
             * gaspillage : `resolveAudioInput` peut rendre un flux, qu'une
             * première tentative a consommé. Le réutiliser tel quel écrirait
             * un fichier vide.
             */
            const attempt = async (container) => {
                // La vidéo a sa propre résolution : celle du son ne rendrait
                // qu'un flux sonore, et le conteneur promettrait une image
                // qu'il n'aurait pas.
                if (downloadFormats.isVideo(container)) {
                    return transcodeVideo(playable.track, playable.url, dir, trackTitle,
                        bitrate, container, videoHeight);
                }

                /*
                 * Le débit demandé choisit la source, et pas seulement la sortie.
                 *
                 * Le transcodage écrivait bien un fichier au débit voulu, mais à
                 * partir du flux que l'extracteur proposait — parfois à 70 kbps.
                 * Le nombre était exact et la qualité imaginaire. On cherche donc
                 * d'abord la meilleure source qui ne dépasse pas la demande.
                 *
                 * Le repli reste le chemin d'avant : une source qui ne se laisse
                 * pas inventorier doit continuer de se télécharger.
                 */
                const choisi = await videoSource.resolveAudio(playable.url, bitrate);
                const input = choisi
                    ? { ffmpegInput: choisi.url, inputStream: null, headers: choisi.headers }
                    : await preloadManager.resolveAudioInput(playable.track, playable.url);

                if (!input.ffmpegInput && !input.inputStream) {
                    throw new Error(`Aucune source audio pour « ${trackTitle} »`);
                }
                return transcodeRemote(input, dir, trackTitle, bitrate, container);
            };

            /*
             * Le repli reste dans la famille demandée.
             *
             * Rendre un MP3 à qui a demandé une vidéo ne répondrait pas à la
             * question posée : le fichier n'irait pas se ranger là où on
             * l'attend, et ne s'ouvrirait pas dans le lecteur visé.
             */
            const fallback = downloadFormats.isVideo(wanted)
                ? downloadFormats.DEFAULT_VIDEO_CONTAINER
                : downloadFormats.DEFAULT_CONTAINER;

            try {
                written = await attempt(wanted);
            } catch (err) {
                /*
                 * Le format choisi n'a pas abouti — repli sur MP3.
                 *
                 * On ne sait pas d'avance ce qu'on va télécharger : le débit,
                 * le nombre de canaux, la fréquence d'échantillonnage de la
                 * source ne se découvrent qu'à l'encodage, et tel encodeur
                 * refuse ce que tel autre accepte. Plutôt que de rendre un
                 * échec là où un fichier était possible, on réessaie dans le
                 * format que rien ne refuse, et on le dit — un MP3 arrivé sans
                 * prévenir à la place d'un FLAC serait une surprise désagréable.
                 *
                 * Une seule fois, et jamais si MP3 est déjà ce qui a échoué :
                 * l'erreur est alors ailleurs que dans le format, et réessayer
                 * à l'identique ne ferait que doubler l'attente.
                 */
                if (wanted === fallback) throw err;

                log.warn(`[Download] ${wanted} failed for ${trackTitle} (${err.message}); `
                    + `falling back to ${fallback}.`);
                webServer._sendError(
                    `Le format ${wanted.toUpperCase()} n'a pas abouti pour « ${trackTitle} » : `
                    + `écriture en ${fallback.toUpperCase()}.`);

                written = await attempt(fallback);
            }
        }

        log.success(`[Download] ${title} written to ${written}`);
        webServer._sendError(`« ${path.basename(written)} » enregistré dans ${dir}`);
    } catch (err) {
        log.error('[Download] Failed:', err.message);
        webServer._sendError(`Téléchargement impossible : ${err.message}`);
    }
}

module.exports = {
    handleDownloadTrack,
};
