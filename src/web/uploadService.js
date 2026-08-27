/**
 * uploadService — Traitement d'un fichier reçu via POST /api/upload.
 *
 * Appelé par la route HTTP, et non par le routeur WebSocket : ce module vit
 * donc hors de websocket/handlers/. Extrait de l'ancien playbackHandlers.js.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const database = require('../database/Database');
const { switchToQueueSourceIfNeeded, addToSetAsideQueue } = require('./websocket/handlerUtils');
const { formatMs } = require('../utils/duration');
const log = require('../utils/logger');

const UPLOADS_DIR = path.join(process.cwd(), 'data', 'uploads');

/** Préfixe des transferts en cours, avant nommage définitif. */
const INCOMING_PREFIX = '.incoming-';

/**
 * Longueur du préfixe d'empreinte apposé aux fichiers stockés. 12 caractères
 * hexadécimaux offrent 2^48 valeurs : largement assez pour une bibliothèque
 * personnelle, tout en gardant un nom de fichier lisible.
 */
const HASH_PREFIX_LENGTH = 12;

/**
 * Supprime les transferts interrompus laissés par un arrêt brutal.
 * @returns {number} Nombre de fichiers supprimés
 */
function cleanIncomingUploads() {
    let removed = 0;
    try {
        for (const name of fs.readdirSync(UPLOADS_DIR)) {
            if (!name.startsWith(INCOMING_PREFIX)) continue;
            try {
                fs.unlinkSync(path.join(UPLOADS_DIR, name));
                removed++;
            } catch (e) {}
        }
    } catch (e) {
        // Dossier absent : rien à nettoyer
    }
    if (removed > 0) {
        log.info(`[Upload] ${removed} interrupted transfer(s) deleted.`);
    }
    return removed;
}

/**
 * Reçoit le corps d'une requête d'upload et le range dans data/uploads.
 *
 * Deux garanties, absentes de l'implémentation précédente :
 *   - le fichier ne prend son nom définitif qu'une fois complet, si bien qu'un
 *     transfert interrompu ne laisse pas de média tronqué dans la bibliothèque ;
 *   - le nom dérive de l'empreinte du contenu, donc réimporter un fichier déjà
 *     présent réutilise l'existant au lieu d'en accumuler une copie de plus.
 *
 * @param {import('http').IncomingMessage} req
 * @param {{ name: string, maxBytes: number }} options
 * @returns {Promise<{ filePath: string, deduplicated: boolean, bytes: number }>}
 */
function receiveUpload(req, { name, maxBytes }) {
    return new Promise((resolve, reject) => {
        fs.mkdirSync(UPLOADS_DIR, { recursive: true });

        const tmpPath = path.join(
            UPLOADS_DIR,
            `${INCOMING_PREFIX}${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
        );
        const writeStream = fs.createWriteStream(tmpPath);
        const hash = crypto.createHash('sha256');

        let received = 0;
        let settled = false;

        const fail = (message, statusCode) => {
            if (settled) return;
            settled = true;
            req.unpipe(writeStream);
            writeStream.destroy();
            fs.promises.unlink(tmpPath).catch(() => {});
            const err = new Error(message);
            err.statusCode = statusCode;
            reject(err);
        };

        // Le listener 'data' et le pipe sont attachés dans le même tour de boucle :
        // aucun morceau ne peut être émis entre les deux.
        req.on('data', (chunk) => {
            received += chunk.length;
            hash.update(chunk);
            if (received > maxBytes) {
                fail(`Fichier trop volumineux (max ${Math.round(maxBytes / 1024 / 1024)} Mo)`, 413);
                req.destroy();
            }
        });
        req.on('aborted', () => fail('Transfert interrompu par le client', 400));
        req.on('error', (err) => fail(err.message, 400));
        writeStream.on('error', (err) => fail(err.message, 500));

        writeStream.on('finish', () => {
            if (settled) return;
            settled = true;

            if (received === 0) {
                fs.promises.unlink(tmpPath).catch(() => {});
                const err = new Error('Empty file');
                err.statusCode = 400;
                return reject(err);
            }

            try {
                const digest = hash.digest('hex').slice(0, HASH_PREFIX_LENGTH);
                const filePath = path.join(UPLOADS_DIR, `${digest}-${name}`);

                if (fs.existsSync(filePath)) {
                    // Contenu déjà présent : on garde l'exemplaire existant
                    fs.unlinkSync(tmpPath);
                    log.info(`[Upload] "${name}" is already there, copy avoided.`);
                    return resolve({ filePath, deduplicated: true, bytes: received });
                }

                fs.renameSync(tmpPath, filePath);
                resolve({ filePath, deduplicated: false, bytes: received });
            } catch (err) {
                fs.promises.unlink(tmpPath).catch(() => {});
                err.statusCode = 500;
                reject(err);
            }
        });

        req.pipe(writeStream);
    });
}

/**
 * Lit la durée réelle d'un média via ffmpeg, quand les métadonnées manquent.
 * @param {string} filePath
 * @returns {Promise<number>} Durée en ms, 0 si indéterminable
 */
async function getMediaDuration(filePath) {
    const fs = require('fs');
    const cp = require('child_process');
    const ffmpegPath = require('ffmpeg-static');

    return new Promise((resolve) => {
        if (!ffmpegPath || !filePath || !fs.existsSync(filePath)) return resolve(0);

        const proc = cp.spawn(ffmpegPath, ['-i', filePath], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        let stderr = '';
        proc.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });
        proc.on('close', () => {
            const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
            if (match) {
                const hours = parseInt(match[1], 10);
                const minutes = parseInt(match[2], 10);
                const seconds = parseFloat(match[3]);
                const totalMs = Math.round(((hours * 3600) + (minutes * 60) + seconds) * 1000);
                return resolve(totalMs);
            }
            resolve(0);
        });
        proc.on('error', () => resolve(0));
    });
}

async function ensureTrackDuration(track, filePath) {
    if (!track) return track;
    const fs = require('fs');
    const targetPath = filePath || track.url;
    if (targetPath && fs.existsSync(targetPath)) {
        if (!track.durationMS || track.durationMS === 0 || track.duration === '0:00' || track.duration === '00:00') {
            const realDurationMs = await getMediaDuration(targetPath);
            if (realDurationMs > 0) {
                track.durationMS = realDurationMs;
                track.duration = formatMs(realDurationMs);
            }
        }
    }
    return track;
}

/**
 * Intègre un fichier uploadé : ajout à une playlist, à la file, ou lecture
 * immédiate selon `target`.
 */
async function processUploadedFile(filePath, fileName, playlistId, currentGuildId, selectedVoiceChannelId, webServer, player, queue, target = 'queue', defaultPlaylistName = 'Ma Playlist') {
    const settings = database.getSettings(currentGuildId);
    const isPersonal = settings.broadcastMode === 'personal';

    const guild = webServer.client.guilds.cache.get(currentGuildId);
    if (!guild) return;

    let voiceChannel = null;
    if (!isPersonal && !playlistId) {
        if (selectedVoiceChannelId) {
            voiceChannel = guild.channels.cache.get(selectedVoiceChannelId);
        }
        if (!voiceChannel) {
            voiceChannel = webServer._findActiveVoiceChannel(guild);
        }
        if (!voiceChannel) {
            webServer._sendError('Vous devez rejoindre un salon vocal pour lancer de la musique.');
            return;
        }
    }

    const { QueryType } = require('discord-player');

    if (target === 'playlist' || playlistId) {
        let playlists = database.getGlobalPlaylists();
        if (!playlistId || !playlists.find(p => p.id === playlistId)) {
            if (playlists.length > 0) {
                playlistId = playlists[0].id;
            } else {
                const nameToUse = defaultPlaylistName || 'Ma Playlist';
                const newPl = database.createPlaylist(currentGuildId, nameToUse);
                playlistId = newPl.id;
            }
        }

        const searchResult = await player.search(filePath, { searchEngine: QueryType.FILE });
        const track = searchResult.tracks[0];
        if (track) {
            await ensureTrackDuration(track, filePath);
            database.addTrackToPlaylist(currentGuildId, playlistId, {
                title: fileName,
                author: track.author || 'Inconnu',
                duration: track.duration || '0:00',
                durationMS: track.durationMS || 0,
                thumbnail: track.thumbnail || null,
                url: track.url,
                queryType: track.queryType || 'file'
            });

            const currentSettings = database.getSettings(currentGuildId);
            if (currentSettings.activePlaybackSource === playlistId) {
                await webServer._syncPlaylistToPlayer(currentGuildId, playlistId, currentSettings.playlistCurrentIndex);
            }
            webServer.broadcastState(currentGuildId);
        } else {
            webServer._sendError(`Impossible de lire le fichier : ${fileName}`);
        }
    } else {
        if (!queue) {
            queue = player.queues.create(guild, {
                nodeOptions: {
                    metadata: { channel: null },
                    selfDeaf: false,
                    volume: settings.baseVolume
                }
            });
        }

        // « Jouer maintenant » demande explicitement d'écouter autre chose : la
        // source de lecture bascule sur la file. Un simple ajout à la file, lui,
        // laisse la playlist en cours poursuivre — la piste sera rangée dans la
        // file mise de côté (cf. `ajouterALaFileEnAttente`).
        if (target === 'play') {
            switchToQueueSourceIfNeeded(currentGuildId, queue, settings);
        }

        if (isPersonal) {
            const searchResult = await player.search(filePath, { searchEngine: QueryType.FILE });
            if (searchResult.tracks.length > 0) {
                const trk = searchResult.tracks[0];
                trk.title = fileName;
                await ensureTrackDuration(trk, filePath);

                if (target === 'play') {
                    if (queue.virtualCurrentTrack) {
                        // En tête : la piste la plus récente d'abord.
                        queue.virtualHistory.unshift(queue.virtualCurrentTrack);
                    }
                    queue.virtualCurrentTrack = {
                        title: trk.title,
                        author: trk.author || 'Inconnu',
                        duration: trk.duration || '0:00',
                        durationMS: trk.durationMS || 0,
                        thumbnail: trk.thumbnail || null,
                        url: trk.url,
                        queryType: trk.queryType || 'file'
                    };
                    queue.virtualIsPlaying = true;
                    queue.virtualIsPaused = false;
                    queue.virtualProgressMs = 0;
                    queue.virtualLastUpdated = Date.now();
                    webServer.broadcastState(currentGuildId);
                } else {
                    if (!addToSetAsideQueue(currentGuildId, settings, trk)) {
                        await webServer._addVirtualTracks(currentGuildId, searchResult.tracks, false);
                    }
                    webServer.broadcastState(currentGuildId);
                }
            }
        } else {
            const searchResult = await player.search(filePath, { searchEngine: QueryType.FILE });
            const track = searchResult.tracks[0];
            if (track) {
                track.title = fileName;
                await ensureTrackDuration(track, filePath);
                if (target !== 'play' && addToSetAsideQueue(currentGuildId, settings, track)) {
                    webServer.broadcastState(currentGuildId);
                    return;
                }
                const presenceManager = require('../audio/PresenceManager');
                if (!await presenceManager.connectIfInhabited(queue, voiceChannel)) {
                    // Salon désert : la piste attend dans la file, que le bot
                    // lancera en arrivant.
                    if (target === 'play') queue.insertTrack(track, 0);
                    else queue.addTrack(track);
                    webServer.broadcastState(currentGuildId);
                    return;
                }
                if (target === 'play' && queue.currentTrack) {
                    queue.insertTrack(track, 0);
                    await queue.node.skip();
                } else {
                    await queue.play(track, {
                        nodeOptions: {
                            metadata: { channel: null },
                            selfDeaf: false,
                            leaveOnEmpty: false,
                            leaveOnEmptyCooldown: 30000,
                            leaveOnEnd: false,
                            leaveOnEndCooldown: 60000,
                            volume: settings.baseVolume
                        }
                    });
                }
                webServer.broadcastState(currentGuildId);
            } else {
                webServer._sendError(`Impossible de lire le fichier : ${fileName}`);
            }
        }
    }
}

module.exports = {
    receiveUpload,
    cleanIncomingUploads,
    processUploadedFile,
    getMediaDuration,
    ensureTrackDuration,
};
