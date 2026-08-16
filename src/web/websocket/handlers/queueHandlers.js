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

                if (isPlaylistPlaying) {
                    // Même liste et mêmes index dans les deux modes : la file
                    // mise de côté ne dépend pas du mode de diffusion.
                    const pistes = readSetAsideQueue(settings);
                    if (index >= 0 && index < pistes.length) {
                        pistes.splice(index, 1);
                        writeSetAsideQueue(currentGuildId, pistes, settings);
                        webServer.broadcastState(currentGuildId);
                        playbackStateManager.saveState(player);
                    }
                } else if (queue) {
                    if (isPersonal) {
                        if (index >= 0 && index < queue.virtualTracks.length) {
                            queue.virtualTracks.splice(index, 1);
                            webServer.broadcastState(currentGuildId);
                            playbackStateManager.saveState(player);
                        }
                    } else {
                        const tracks = queue.tracks.toArray();
                        if (index >= 0 && index < tracks.length) {
                            const trackToRemove = tracks[index];
                            if (trackToRemove) {
                                queue.node.remove(trackToRemove);
                                webServer.broadcastState(currentGuildId);
                                playbackStateManager.saveState(player);
                            }
                        }
                    }
                }
            } catch (removeErr) {
                log.error('[WebServer] Erreur suppression track :', removeErr.message);
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
                log.error('[WebServer] Erreur playNow virtuel :', err.message);
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
                    log.error('[WebServer] Erreur playNow :', err.message);
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
                if (isPlaylistPlaying) {
                    const pistes = readSetAsideQueue(settings);
                    if (fromIndex >= 0 && fromIndex < pistes.length) {
                        const [deplacee] = pistes.splice(fromIndex, 1);
                        if (deplacee) pistes.splice(toIndex, 0, deplacee);
                        writeSetAsideQueue(currentGuildId, pistes, settings);
                        webServer.broadcastState(currentGuildId);
                    }
                } else if (isPersonal) {
                    if (queue) {
                        if (fromIndex >= 0 && fromIndex < queue.virtualTracks.length) {
                            const track = queue.virtualTracks.splice(fromIndex, 1)[0];
                            queue.virtualTracks.splice(toIndex, 0, track);
                            webServer.broadcastState(currentGuildId);
                        }
                    }
                } else if (queue && queue.tracks) {
                    const tracksArr = queue.tracks.toArray();
                    if (fromIndex >= 0 && fromIndex < tracksArr.length) {
                        queue.node.move(fromIndex, toIndex);
                        webServer.broadcastState(currentGuildId);
                    }
                }
            }
        } else if ((source === 'history' || source === 'nowplaying' || source === 'playlist_track') && url) {
            try {
                const searchResult = await searchLocalAwareTrack(player, url);
                if (searchResult && searchResult.tracks && searchResult.tracks.length > 0) {
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
                        const pistes = readSetAsideQueue(settings);
                        const cible = typeof toIndex === 'number' ? Math.min(toIndex, pistes.length) : pistes.length;
                        pistes.splice(cible, 0, trackData);
                        writeSetAsideQueue(currentGuildId, pistes, settings);
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
                log.error('[WebServer] Erreur moveOrInsertTrack :', err.message);
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
                log.error('[WebServer] Erreur removeFromHistory :', err.message);
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
                log.error('[WebServer] Erreur clearHistory :', err.message);
            }
        }
}

function handleClearQueue(ctx) {
    const { webServer, player, currentGuildId } = ctx;
    let queue = ctx.queue;

        if (queue) {
            try {
                const settings = database.getSettings(currentGuildId);
                if (settings.broadcastMode === 'personal') {
                    queue.virtualTracks = [];
                } else if (queue.tracks) {
                    queue.tracks.clear();
                }
                webServer.broadcastState(currentGuildId);
                playbackStateManager.saveState(player);
            } catch (err) {
                log.error('[WebServer] Erreur clearQueue :', err.message);
            }
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
