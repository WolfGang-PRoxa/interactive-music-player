/**
 * Playlists globales : création, édition, source de lecture active.
 *
 * Chaque handler reçoit le contexte assemblé par wsHandler :
 * { ws, data, webServer, player, queue, currentGuildId, dispatch }.
 */
const database = require('../../../database/Database');
const playbackStateManager = require('../../../database/PlaybackStateManager');
const { searchLocalAwareTrack } = require('../handlerUtils');
const { readSetAsideQueue, writeSetAsideQueue } = require('../../../utils/setAsideQueue');
const { arePathsOrUrlsEqual } = require('../../../utils/paths');
const log = require('../../../utils/logger');

function handleReorderPlaylists(ctx) {
    const { data, webServer, player, currentGuildId } = ctx;

        const { fromIndex, toIndex, playlistOrder } = data;
        database.reorderPlaylists(fromIndex, toIndex, playlistOrder);
        webServer.broadcastState(currentGuildId);
        try {
            playbackStateManager.saveState(player);
        } catch (e) { }
}

function handleCreatePlaylist(ctx) {
    const { data, webServer, currentGuildId } = ctx;

        const { name } = data;
        database.createPlaylist(currentGuildId, name);
        webServer.broadcastState(currentGuildId);
}

function handleRenamePlaylist(ctx) {
    const { data, webServer, currentGuildId } = ctx;

        const { playlistId, name } = data;
        database.renamePlaylist(currentGuildId, playlistId, name);
        webServer.broadcastState(currentGuildId);
}

function handleDeletePlaylist(ctx) {
    const { data, webServer, currentGuildId } = ctx;

        const { playlistId } = data;
        database.deletePlaylist(currentGuildId, playlistId);
        webServer.broadcastState(currentGuildId);
}

async function handleAddPlaylistTrack(ctx) {
    const { data, webServer, player, currentGuildId } = ctx;

        let { playlistId, url, defaultPlaylistName } = data;
        if (!url) return;
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

        try {
            const searchResult = await searchLocalAwareTrack(player, url);
            if (searchResult.tracks.length > 0) {
                const track = searchResult.tracks[0];
                database.addTrackToPlaylist(currentGuildId, playlistId, {
                    title: track.title,
                    author: track.author || 'Inconnu',
                    duration: track.duration || '0:00',
                    durationMS: track.durationMS || 0,
                    thumbnail: track.thumbnail || null,
                    url: track.url,
                    queryType: track.queryType || 'youtube'
                });

                const currentSettings = database.getSettings(currentGuildId);
                if (currentSettings.activePlaybackSource === playlistId) {
                    await webServer._syncPlaylistToPlayer(currentGuildId, playlistId, currentSettings.playlistCurrentIndex);
                }
                webServer.broadcastState(currentGuildId);
            } else {
                webServer._sendError(`Impossible de trouver le morceau : ${url}`);
            }
        } catch (err) {
            log.error('[WebServer] Erreur addPlaylistTrack :', err.message);
        }
}

async function handleAddTrackToPlaylist(ctx) {
    const { data, webServer, currentGuildId } = ctx;

        let { playlistId, track, targetIndex, defaultPlaylistName } = data;
        if (!track) return;

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

        database.addTrackToPlaylist(currentGuildId, playlistId, track, targetIndex);

        const settings = database.getSettings(currentGuildId);
        if (settings.activePlaybackSource === playlistId) {
            let currentIndex = settings.playlistCurrentIndex || 0;
            if (typeof targetIndex === 'number' && targetIndex <= currentIndex) {
                currentIndex++;
                database.updateSettings(currentGuildId, { playlistCurrentIndex: currentIndex });
            }
            await webServer._syncPlaylistToPlayer(currentGuildId, playlistId, currentIndex);
        }
        webServer.broadcastState(currentGuildId);
}

async function handleRemoveTrackFromPlaylist(ctx) {
    const { data, webServer, currentGuildId } = ctx;

        const { playlistId, index } = data;
        database.removeTrackFromPlaylist(currentGuildId, playlistId, index);

        const settings = database.getSettings(currentGuildId);
        if (settings.activePlaybackSource === playlistId) {
            let currentIndex = settings.playlistCurrentIndex || 0;
            if (index <= currentIndex && currentIndex > 0) {
                currentIndex--;
                database.updateSettings(currentGuildId, { playlistCurrentIndex: currentIndex });
            }
            await webServer._syncPlaylistToPlayer(currentGuildId, playlistId, currentIndex);
        }
        webServer.broadcastState(currentGuildId);
}

async function handleMovePlaylistTrack(ctx) {
    const { data, webServer, currentGuildId } = ctx;

        const { playlistId, fromIndex, toIndex } = data;
        database.movePlaylistTrack(currentGuildId, playlistId, fromIndex, toIndex);

        const settings = database.getSettings(currentGuildId);
        if (settings.activePlaybackSource === playlistId) {
            let currentIndex = settings.playlistCurrentIndex || 0;
            if (currentIndex === fromIndex) {
                currentIndex = toIndex;
            } else if (fromIndex < currentIndex && toIndex >= currentIndex) {
                currentIndex--;
            } else if (fromIndex > currentIndex && toIndex <= currentIndex) {
                currentIndex++;
            }
            database.updateSettings(currentGuildId, { playlistCurrentIndex: currentIndex });
            await webServer._syncPlaylistToPlayer(currentGuildId, playlistId, currentIndex);
        }
        webServer.broadcastState(currentGuildId);
}

async function handleSetActivePlaybackSource(ctx) {
    const { data, webServer, player, currentGuildId } = ctx;
    let queue = ctx.queue;

        const { source, index } = data;
        const settings = database.getSettings(currentGuildId);
        const oldSource = settings.activePlaybackSource || 'queue';
        const targetIndex = typeof index === 'number' ? index : 0;

        if (source === oldSource && typeof index !== 'number') return;

        const isPersonal = settings.broadcastMode === 'personal';

        const toData = (t) => {
            if (!t) return null;
            return {
                title: t.title,
                author: t.author || 'Inconnu',
                duration: t.duration || '0:00',
                thumbnail: t.thumbnail || null,
                url: t.url,
                queryType: t.queryType || 'youtube',
                extractorName: t.extractor?.identifier || t.extractorName || null
            };
        };
        const currentTrackOf = () => (isPersonal ? queue?.virtualCurrentTrack : queue?.currentTrack) || null;

        // Relevée avant la bascule : c'est en comparant après coup qu'on saura
        // si la nouvelle source a réellement pris la main.
        const trackBefore = currentTrackOf();

        if (oldSource === 'queue') {
            // La piste en cours n'entre pas dans la file mise de côté : elle
            // poursuit sa lecture par-dessus le changement de source, et l'y
            // ranger la ferait apparaître deux fois — une fois comme morceau
            // joué, une fois comme titre en attente. Elle n'y rejoindra sa
            // place que si la nouvelle source l'interrompt (voir plus bas).
            const rest = isPersonal ? (queue?.virtualTracks || []) : (queue ? queue.tracks.toArray() : []);
            writeSetAsideQueue(currentGuildId, rest.map(toData), settings);
        }

        database.updateSettings(currentGuildId, {
            activePlaybackSource: source,
            playlistCurrentIndex: targetIndex
        });

        if (source === 'queue') {
            // Retour à la file : son premier titre redevient la piste courante,
            // dans les deux modes.
            const setAside = readSetAsideQueue(settings);

            if (isPersonal) {
                if (queue && setAside.length > 0) {
                    const [first, ...rest] = setAside;
                    queue.virtualCurrentTrack = first;
                    queue.virtualTracks = rest;
                    queue.virtualProgressMs = 0;
                    queue.virtualIsPlaying = true;
                    queue.virtualIsPaused = false;
                    queue.virtualLastUpdated = Date.now();
                }
            } else if (queue) {
                queue.tracks.clear();
                if (setAside.length > 0) {
                    const { Track } = require('discord-player');
                    const tracksToRestore = setAside.map(tData => {
                        const track = new Track(player, tData);
                        if (tData.extractorName) {
                            track.extractor = player.extractors.store.get(tData.extractorName) || null;
                        }
                        return track;
                    });
                    queue.addTrack(tracksToRestore);
                }
            }
        } else {
            await webServer._syncPlaylistToPlayer(currentGuildId, source, targetIndex, true);

            // La playlist n'interrompt pas toujours ce qui joue : le lecteur
            // range le titre demandé derrière le morceau en cours plutôt que de
            // le couper. Quand elle prend malgré tout la main, la piste qu'elle
            // a interrompue ouvre la file mise de côté — c'est là qu'on la
            // retrouvera au retour, et à cet endroit seulement.
            const trackAfter = currentTrackOf();
            const interrupted = trackBefore
                && (!trackAfter || !arePathsOrUrlsEqual(trackBefore.url, trackAfter.url));

            if (interrupted) {
                const settings = database.getSettings(currentGuildId);
                writeSetAsideQueue(
                    currentGuildId,
                    [toData(trackBefore), ...readSetAsideQueue(settings)],
                    settings
                );
            }
        }

        webServer.broadcastState(currentGuildId);
        playbackStateManager.saveState(player);
}

module.exports = {
    handleReorderPlaylists,
    handleCreatePlaylist,
    handleRenamePlaylist,
    handleDeletePlaylist,
    handleAddPlaylistTrack,
    handleAddTrackToPlaylist,
    handleRemoveTrackFromPlaylist,
    handleMovePlaylistTrack,
    handleSetActivePlaybackSource,
};
