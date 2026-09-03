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

    return new Promise((resolve, reject) => {
        const ffmpeg = require('ffmpeg-static');
        const args = [];

        // Une URL directe peut se rompre en route : ffmpeg reprend la connexion
        // plutôt que d'écrire un fichier tronqué.
        if (input.ffmpegInput && /^https?:\/\//i.test(input.ffmpegInput)) {
            args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
        }

        args.push('-i', input.ffmpegInput || 'pipe:0');
        // `-vn` : la source porte souvent une pochette en flux vidéo, que les
        // muxers audio ne savent ranger que dans une étiquette. Sans cela ffmpeg
        // s'arrête sur « nothing was written into output file ». Voir
        // PreloadManager, où le même écueil a été rencontré.
        args.push('-vn', ...encoding, '-y', partial);

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
            const input = await preloadManager.resolveAudioInput(playable.track, playable.url);
            if (!input.ffmpegInput && !input.inputStream) {
                webServer._sendError(`Aucune source audio pour « ${title} ».`);
                return;
            }
            written = await transcodeRemote(input, dir, playable.track.title || title,
                bitrateFor(currentGuildId), containerFor(currentGuildId));
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
