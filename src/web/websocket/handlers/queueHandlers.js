/**
 * File d'attente et historique : ajout, suppression, réordonnancement.
 *
 * Chaque handler reçoit le contexte assemblé par wsHandler :
 * { ws, data, webServer, player, queue, currentGuildId, dispatch }.
 */
const database = require('../../../database/Database');
const playbackStateManager = require('../../../database/PlaybackStateManager');
const { searchLocalAwareTrack, switchToQueueSourceIfNeeded } = require('../handlerUtils');
const { readSetAsideQueue, writeSetAsideQueue } = require('../../../utils/setAsideQueue');
const channelQueue = require('../../../audio/channelQueue');
const log = require('../../../utils/logger');

function handleRemoveTrack(ctx) {
    const { data, webServer, player, currentGuildId } = ctx;
    let queue = ctx.queue;

        const { index } = data;
        if (typeof index === 'number') {
            try {
                const settings = database.getSettings(currentGuildId);
                const isPersonal = settings.broadcastMode === 'personal';
                const isPlaylistPlaying = settings.activePlaybackSource && settings.activePlaybackSource !== 'queue';

                /*
                 * Le retrait porte sur le rangement, dans tous les cas.
                 *
                 * L'indice reçu est celui de la ligne cliquée, et cette ligne
                 * vient du rangement — le seul à connaître les aiguillages et
                 * les titres qui les suivent. Le lecteur, lui, n'a jamais que
                 * la tête de liste : compter dedans désignerait le mauvais
                 * titre dès qu'une transition attend quelque part.
                 *
                 * Les deux modes de diffusion se traitent donc pareil, ce que
                 * trois branches séparées ne garantissaient pas.
                 */
                const stored = channelQueue.read(settings);
                if (index >= 0 && index < stored.length) {
                    stored.splice(index, 1);
                    channelQueue.write(currentGuildId, stored, settings);

                    // La file joue : le lecteur doit suivre. Sinon c'est une
                    // playlist qui l'occupe, et la file attend son tour.
                    if (!isPlaylistPlaying) webServer.loadChannelQueue(currentGuildId);

                    webServer.broadcastState(currentGuildId);
                    playbackStateManager.saveState(player);
                }
            } catch (removeErr) {
                log.error('[WebServer] Track removal error:', removeErr.message);
            }
        }
}

async function handlePlayNow(ctx) {
    const { data, webServer, player, currentGuildId } = ctx;
    let queue = ctx.queue;

        const queryOrUrl = data.url || data.query;
        if (!queryOrUrl) return;

        const settings = database.getSettings(currentGuildId);

        if (!queue) {
            const guild = webServer.client.guilds.cache.get(currentGuildId);
            if (guild) {
                queue = player.queues.create(guild, {
                    nodeOptions: {
                        metadata: { channel: null },
                        selfDeaf: false,
                        volume: settings.baseVolume
                    }
                });
            }
        }

        if (!queue) return;

        switchToQueueSourceIfNeeded(currentGuildId, queue, settings);

        if (settings.broadcastMode === 'personal') {
            try {

                const searchResult = await searchLocalAwareTrack(player, queryOrUrl);
                if (searchResult.tracks.length > 0) {
                    const track = searchResult.tracks[0];
                    if (queue.virtualCurrentTrack) {
                        // En tête : la piste la plus récente d'abord.
                        queue.virtualHistory.unshift(queue.virtualCurrentTrack);
                    }
                    queue.virtualCurrentTrack = {
                        title: track.title,
                        author: track.author || 'Inconnu',
                        duration: track.duration || '0:00',
                        durationMS: track.durationMS || parseDurationToMs(track.duration),
                        thumbnail: track.thumbnail || null,
                        url: track.url,
                        queryType: track.queryType || 'youtube',
                        extractorName: track.extractor?.identifier || null
                    };
                    queue.virtualIsPlaying = true;
                    queue.virtualIsPaused = false;
                    queue.virtualProgressMs = 0;
                    queue.virtualLastUpdated = Date.now();
                    webServer.broadcastState(currentGuildId);
                } else {
                    webServer._sendError(`Impossible de trouver le morceau : ${queryOrUrl}`);
                }
            } catch (err) {
                log.error('[WebServer] Virtual playNow error:', err.message);
                webServer._sendError(`Impossible de jouer maintenant : ${err.message}`);
            }
        } else {
            if (queue && queue.currentTrack) {
                try {
                    const searchResult = await searchLocalAwareTrack(player, queryOrUrl);
                    if (searchResult.tracks.length > 0) {
                        const track = searchResult.tracks[0];
                        queue.insertTrack(track, 0);
                        await queue.node.skip();
                        webServer.broadcastState(currentGuildId);
                    } else {
                        webServer._sendError(`Impossible de trouver le morceau : ${queryOrUrl}`);
                    }
                } catch (err) {
                    log.error('[WebServer] playNow error:', err.message);
                    webServer._sendError(`Impossible de jouer maintenant : ${err.message}`);
                }
            } else {
                await ctx.dispatch({ type: 'play', guildId: currentGuildId, data: { query: queryOrUrl } });
            }
        }
}

async function handleMoveOrInsertTrack(ctx) {
    const { data, webServer, player, currentGuildId } = ctx;
    let queue = ctx.queue;

        const { source, fromIndex, toIndex, url } = data;
        const settings = database.getSettings(currentGuildId);
        const isPersonal = settings.broadcastMode === 'personal';
        const isPlaylistPlaying = settings.activePlaybackSource && settings.activePlaybackSource !== 'queue';

        if (source === 'queue') {
            if (typeof fromIndex === 'number' && typeof toIndex === 'number') {
                // Le déplacement porte sur le rangement, comme le retrait : les
                // indices reçus sont ceux des lignes affichées, que le lecteur
                // ne connaît qu'en partie dès qu'un aiguillage attend.
                const stored = channelQueue.read(settings);
                if (fromIndex >= 0 && fromIndex < stored.length) {
                    const [moved] = stored.splice(fromIndex, 1);
                    if (moved) stored.splice(toIndex, 0, moved);
                    channelQueue.write(currentGuildId, stored, settings);

                    if (!isPlaylistPlaying) webServer.loadChannelQueue(currentGuildId);
                    webServer.broadcastState(currentGuildId);
                }
            }
        } else if ((source === 'history' || source === 'nowplaying' || source === 'playlist_track') && url) {
            try {
                const searchResult = await searchLocalAwareTrack(player, url);
                if (!searchResult || !searchResult.tracks || searchResult.tracks.length === 0) {
                    // Le glissement n'aboutit pas, et rien ne le disait : la
                    // piste ne réapparaissait simplement pas dans la file. Une
                    // source distante devenue injoignable — YouTube qui refuse
                    // la connexion, vidéo retirée — passait ainsi pour un
                    // glisser-déposer cassé.
                    log.warn(`[WebServer] Insertion abandoned, track unresolvable: ${url}`);
                    webServer._sendError('Ce morceau est introuvable pour le moment : sa source ne répond pas.');
                    return;
                }

                {
                    const track = searchResult.tracks[0];
                    const trackData = {
                        title: track.title,
                        author: track.author || 'Inconnu',
                        duration: track.duration || '0:00',
                        thumbnail: track.thumbnail || null,
                        url: track.url,
                        queryType: track.queryType || 'youtube'
                    };

                    if (isPlaylistPlaying) {
                        const stored = readSetAsideQueue(settings);
                        const targetIndex = typeof toIndex === 'number' ? Math.min(toIndex, stored.length) : stored.length;
                        stored.splice(targetIndex, 0, trackData);
                        writeSetAsideQueue(currentGuildId, stored, settings);
                        webServer.broadcastState(currentGuildId);
                    } else if (queue) {
                        if (isPersonal) {
                            const targetIdx = typeof toIndex === 'number' ? Math.min(toIndex, queue.virtualTracks.length) : queue.virtualTracks.length;
                            queue.virtualTracks.splice(targetIdx, 0, trackData);
                            webServer.broadcastState(currentGuildId);
                        } else {
                            const targetIdx = typeof toIndex === 'number' ? Math.min(toIndex, queue.tracks.size) : queue.tracks.size;
                            queue.insertTrack(track, targetIdx);
                            webServer.broadcastState(currentGuildId);
                        }
                    }
                }
            } catch (err) {
                log.error('[WebServer] moveOrInsertTrack error:', err.message);
            }
        }
}

function handleRemoveFromHistory(ctx) {
    const { data, webServer, player, currentGuildId } = ctx;
    let queue = ctx.queue;

        const { index } = data;
        if (queue && typeof index === 'number') {
            try {
                const settings = database.getSettings(currentGuildId);
                // L'index reçu est celui de la liste affichée, qui suit désormais
                // l'ordre de stockage : plus besoin de le retourner.
                if (settings.broadcastMode === 'personal') {
                    if (index >= 0 && index < queue.virtualHistory.length) {
                        queue.virtualHistory.splice(index, 1);
                        webServer.broadcastState(currentGuildId);
                        playbackStateManager.saveState(player);
                    }
                } else if (queue.history) {
                    if (index >= 0 && index < queue.history.tracks.size) {
                        if (typeof queue.history.tracks.removeOne === 'function') {
                            queue.history.tracks.removeOne((t, i) => i === index);
                        } else {
                            const internalQueue = queue.history.tracks;
                            if (internalQueue.store) {
                                internalQueue.store.splice(index, 1);
                            } else if (internalQueue.data) {
                                internalQueue.data.splice(index, 1);
                            }
                        }
                        webServer.broadcastState(currentGuildId);
                        playbackStateManager.saveState(player);
                    }
                }
            } catch (err) {
                log.error('[WebServer] removeFromHistory error:', err.message);
            }
        }
}

function handleClearHistory(ctx) {
    const { webServer, player, currentGuildId } = ctx;
    let queue = ctx.queue;

        if (queue) {
            try {
                const settings = database.getSettings(currentGuildId);
                if (settings.broadcastMode === 'personal') {
                    queue.virtualHistory = [];
                } else if (queue.history) {
                    queue.history.clear();
                }
                webServer.broadcastState(currentGuildId);
                playbackStateManager.saveState(player);
            } catch (err) {
                log.error('[WebServer] clearHistory error:', err.message);
            }
        }
}

/**
 * Vide la file d'attente — celle que le tableau de bord montre.
 *
 * Ce n'est pas toujours la même liste. Une playlist qui occupe le lecteur met
 * la file de côté le temps de sa lecture, et c'est cette file-là que le panneau
 * affiche. Le bouton, lui, vidait la liste du lecteur — celle de la playlist,
 * invisible à ce moment-là : rien ne bougeait à l'écran, et il passait pour
 * cassé. Ses deux voisins, le retrait d'un titre et le déplacement, savaient
 * déjà faire la différence ; celui-ci l'ignorait.
 *
 * Le test de la file mise de côté vient donc en premier, et il ne dépend
 * d'aucun lecteur : elle vit dans les réglages, et se vide même quand plus rien
 * ne joue.
 */
function handleClearQueue(ctx) {
    const { webServer, player, currentGuildId } = ctx;
    const queue = ctx.queue;

    try {
        const settings = database.getSettings(currentGuildId);
        const isPlaylistPlaying = settings.activePlaybackSource
            && settings.activePlaybackSource !== 'queue';

        // Vider la file, c'est vider son rangement : aiguillages compris, et
        // dans les deux modes de diffusion. Le lecteur suit ensuite.
        channelQueue.write(currentGuildId, [], settings);

        if (!isPlaylistPlaying && queue) {
            if (settings.broadcastMode === 'personal') {
                queue.virtualTracks = [];
            } else if (queue.tracks) {
                queue.tracks.clear();
            }
        }

        webServer.broadcastState(currentGuildId);
        playbackStateManager.saveState(player);
    } catch (err) {
        log.error('[WebServer] clearQueue error:', err.message);
    }
}

module.exports = {
    handleRemoveTrack,
    handlePlayNow,
    handleMoveOrInsertTrack,
    handleRemoveFromHistory,
    handleClearHistory,
    handleClearQueue,
};
