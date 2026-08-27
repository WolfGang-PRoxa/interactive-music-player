/**
 * Contrôles de lecture : play, pause, navigation, seek, vitesse.
 *
 * Chaque handler reçoit le contexte assemblé par wsHandler :
 * { ws, data, webServer, player, queue, currentGuildId, dispatch }.
 */
const database = require('../../../database/Database');
const playbackStateManager = require('../../../database/PlaybackStateManager');
const presenceManager = require('../../../audio/PresenceManager');
const { searchLocalAwareTrack, playlistIsSource, addToSetAsideQueue } = require('../handlerUtils');
const { getCleanFilename } = require('../../../utils/paths');
const log = require('../../../utils/logger');

async function handlePlay(ctx) {
    const { ws, data, webServer, player, currentGuildId } = ctx;
    let queue = ctx.queue;

        let { query } = data;
        if (!query) return;
        query = query.trim();
        // Supprimer les guillemets encadrants
        if ((query.startsWith('"') && query.endsWith('"')) || (query.startsWith("'") && query.endsWith("'"))) {
            query = query.slice(1, -1).trim();
        }

        const settings = database.getSettings(currentGuildId);
        const isPersonal = settings.broadcastMode === 'personal';

        const guild = webServer.client.guilds.cache.get(currentGuildId);
        if (!guild) return;

        // Trouver le salon vocal cible
        let voiceChannel = null;
        if (!isPersonal) {
            if (ws.selectedVoiceChannelId) {
                voiceChannel = guild.channels.cache.get(ws.selectedVoiceChannelId);
            }
            if (!voiceChannel) {
                voiceChannel = webServer._findActiveVoiceChannel(guild);
            }
            if (!voiceChannel) {
                webServer._sendError('Vous devez rejoindre un salon vocal pour lancer de la musique.');
                return;
            }
        }

        try {
            let queue = player.queues.get(currentGuildId);
            if (!queue) {
                queue = player.queues.create(guild, {
                    nodeOptions: {
                        metadata: { channel: null },
                        selfDeaf: false,
                        volume: settings.baseVolume
                    }
                });
            }

            // Ce handler sert la destination « file d'attente » : il ajoute, il
            // ne décide pas de ce qu'on écoute. Si une playlist occupe le
            // lecteur, elle le reste, et les pistes rejoignent la file mise de
            // côté. Seul « Jouer maintenant » change la source de lecture.
            const toPendingQueue = playlistIsSource(settings);

            const fs = require('fs');
            const path = require('path');
            const LocalFilePlayer = require('../../../audio/LocalFilePlayer');
            const { QueryType } = require('discord-player');

            let resolvedPath = null;
            try {
                resolvedPath = path.resolve(query);
            } catch (err) { }

            if (resolvedPath && fs.existsSync(resolvedPath)) {
                const stat = fs.statSync(resolvedPath);
                if (stat.isDirectory()) {
                    // C'est un dossier
                    const audioFiles = LocalFilePlayer.scanDirectory(resolvedPath);
                    if (audioFiles.length === 0) {
                        webServer._sendError(`Aucun fichier audio trouvé dans le dossier : ${query}`);
                        return;
                    }
                    if (isPersonal) {
                        const tracksToPlay = [];
                        for (const filePath of audioFiles) {
                            const searchResult = await player.search(filePath, { searchEngine: QueryType.FILE });
                            if (searchResult.tracks.length > 0) {
                                searchResult.tracks[0].title = getCleanFilename(filePath);
                                tracksToPlay.push(searchResult.tracks[0]);
                            }
                        }
                        if (!addToSetAsideQueue(currentGuildId, settings, tracksToPlay)) {
                            await webServer._addVirtualTracks(currentGuildId, tracksToPlay, true);
                        }
                        webServer.broadcastState(currentGuildId);
                    } else {
                        // Rangées d'un bloc en fin de parcours : les ajouter une
                        // par une réécrirait les réglages à chaque fichier du
                        // dossier.
                        const toStore = [];
                        for (const filePath of audioFiles) {
                            const searchResult = await player.search(filePath, { searchEngine: QueryType.FILE });
                            const track = searchResult.tracks[0];
                            if (track) {
                                track.title = getCleanFilename(filePath);
                                if (toPendingQueue) {
                                    toStore.push(track);
                                    continue;
                                }
                                // Salon désert : la piste rejoint la file, qui
                                // démarrera quand le bot y sera amené.
                                if (!await presenceManager.connectIfInhabited(queue, voiceChannel)) {
                                    queue.addTrack(track);
                                    continue;
                                }
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
                        }
                        addToSetAsideQueue(currentGuildId, settings, toStore);
                        webServer.broadcastState(currentGuildId);
                    }
                } else if (LocalFilePlayer.isAudioFile(resolvedPath)) {
                    // C'est un fichier unique
                    if (isPersonal) {
                        const searchResult = await player.search(resolvedPath, { searchEngine: QueryType.FILE });
                        if (searchResult.tracks.length > 0) {
                            searchResult.tracks[0].title = getCleanFilename(resolvedPath);
                        }
                        if (!addToSetAsideQueue(currentGuildId, settings, searchResult.tracks[0])) {
                            await webServer._addVirtualTracks(currentGuildId, searchResult.tracks, false);
                        }
                        webServer.broadcastState(currentGuildId);
                    } else {
                        const searchResult = await player.search(resolvedPath, { searchEngine: QueryType.FILE });
                        const track = searchResult.tracks[0];
                        if (track) {
                            track.title = getCleanFilename(resolvedPath);
                            if (addToSetAsideQueue(currentGuildId, settings, track)) {
                                webServer.broadcastState(currentGuildId);
                                return;
                            }
                            if (!await presenceManager.connectIfInhabited(queue, voiceChannel)) {
                                queue.addTrack(track);
                                webServer.broadcastState(currentGuildId);
                                return;
                            }
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
                            webServer.broadcastState(currentGuildId);
                        }
                    }
                } else {
                    webServer._sendError(`Le fichier n'est pas un format audio supporté : ${path.basename(resolvedPath)}`);
                    return;
                }
            } else {
                // Normal play (YouTube, Spotify, YouTube Music, etc.)
                const searchResult = await searchLocalAwareTrack(player, query);
                if (!searchResult || !searchResult.tracks || searchResult.tracks.length === 0) {
                    webServer._sendError(`Aucun résultat trouvé pour : ${query}`);
                    return;
                }

                if (isPersonal) {
                    const toStore = searchResult.playlist ? searchResult.tracks : searchResult.tracks[0];
                    if (!addToSetAsideQueue(currentGuildId, settings, toStore)) {
                        await webServer._addVirtualTracks(currentGuildId, searchResult.tracks, searchResult.playlist);
                    }
                    webServer.broadcastState(currentGuildId);
                } else {
                    const toStore = searchResult.playlist ? searchResult.tracks : searchResult.tracks[0];
                    if (addToSetAsideQueue(currentGuildId, settings, toStore)) {
                        webServer.broadcastState(currentGuildId);
                        return;
                    }
                    if (!await presenceManager.connectIfInhabited(queue, voiceChannel)) {
                        queue.addTrack(searchResult.playlist ? searchResult.tracks : searchResult.tracks[0]);
                        webServer.broadcastState(currentGuildId);
                        return;
                    }
                    if (searchResult.playlist) {
                        await queue.addTrack(searchResult.tracks);
                        if (!queue.isPlaying()) await queue.node.play();
                    } else {
                        await queue.play(searchResult.tracks[0], {
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
                }
            }
        } catch (err) {
            webServer._sendError(`Erreur lors de la lecture : ${err.message}`);
        }
}

function handlePause(ctx) {
    const { webServer, player, currentGuildId } = ctx;
    let queue = ctx.queue;

        const settings = database.getSettings(currentGuildId);
        log.debug(`[Player Debug] WS 'pause' received for guild ${currentGuildId} (broadcastMode: ${settings.broadcastMode})`);
        if (settings.broadcastMode === 'personal') {
            if (queue && queue.virtualCurrentTrack) {
                queue.virtualIsPlaying = false;
                queue.virtualIsPaused = true;
                queue.virtualLastUpdated = Date.now();
                webServer.broadcastState(currentGuildId);
                playbackStateManager.saveState(player);
            }
        } else {
            if (queue) {
                if (!presenceManager.applyFrozenCommand(queue, 'pause')) {
                    try {
                        queue.node.setPaused(true);
                        log.debug(`[Player Debug] queue.node.setPaused(true) executed for guild ${currentGuildId}`);
                    } catch (err) {
                        log.error('[Player Debug] Error setting queue.node.setPaused(true):', err);
                    }
                }
                webServer.broadcastState(currentGuildId);
                playbackStateManager.saveState(player);
            }
        }
}

function handleResume(ctx) {
    const { webServer, player, currentGuildId } = ctx;
    let queue = ctx.queue;

        const settings = database.getSettings(currentGuildId);
        log.debug(`[Player Debug] WS 'resume' received for guild ${currentGuildId} (broadcastMode: ${settings.broadcastMode})`);
        if (settings.broadcastMode === 'personal') {
            if (queue && queue.virtualCurrentTrack) {
                queue.virtualIsPlaying = true;
                queue.virtualIsPaused = false;
                queue.virtualLastUpdated = Date.now();
                webServer.broadcastState(currentGuildId);
                playbackStateManager.saveState(player);
            }
        } else {
            if (queue) {
                queue.restorePaused = false;
                if (!presenceManager.applyFrozenCommand(queue, 'resume')) {
                    try {
                        queue.node.setPaused(false);
                        log.debug(`[Player Debug] queue.node.setPaused(false) executed for guild ${currentGuildId}`);
                    } catch (err) {
                        log.error('[Player Debug] Error setting queue.node.setPaused(false):', err);
                    }
                }
                webServer.broadcastState(currentGuildId);
                playbackStateManager.saveState(player);
            }
        }
}

function handleSkip(ctx) {
    const { data, webServer, currentGuildId, ws } = ctx;
    let queue = ctx.queue;

        // Annonce de fin de piste, par opposition à un appui sur « suivant ».
        //
        // Seul un enchaînement transmet la position déjà jouée du morceau
        // entrant ; une commande de l'utilisateur n'en porte jamais. Les
        // tableaux de bord récents le marquent en plus explicitement.
        //
        // En diffusion personnelle, chaque tableau de bord ouvert mène sa propre
        // lecture et constate la même fin : sans ce filtre, la file avançait
        // d'autant de crans qu'il y avait d'appareils connectés. Seul le pilote
        // est entendu — mais les commandes explicites, elles, restent acceptées
        // de n'importe lequel.
        const isAutomaticAnnounce = !!(data && (data.auto || data.startProgressMs > 0));
        if (isAutomaticAnnounce && ws && !webServer.isPilot(ws, currentGuildId)) {
            log.debug('[WebServer] End of track announced by a non-pilot dashboard: ignored.');
            return;
        }

        const settings = database.getSettings(currentGuildId);
        if (settings.broadcastMode === 'personal') {
            if (queue && (queue.virtualIsPlaying || queue.virtualIsPaused || queue.virtualCurrentTrack)) {
                webServer.handleVirtualSkip(queue, currentGuildId, data);
            }
        } else {
            if (presenceManager.applyFrozenCommand(queue, 'skip')) {
                webServer.broadcastState(currentGuildId);
                return;
            }
            if (queue && (queue.isPlaying() || queue.currentTrack)) {
                if (queue.isPendingTransition) {
                    log.info(`[WebServer] Skip ignored because a transition is already under way.`);
                    return;
                }

                queue.isPendingTransition = true;
                if (queue.transitionTimeout) clearTimeout(queue.transitionTimeout);
                queue.transitionTimeout = setTimeout(() => {
                    queue.isPendingTransition = false;
                    log.info('[WebServer] Transition timeout (skip): resetting isPendingTransition to false.');
                    webServer.broadcastState(currentGuildId);
                }, 8000);

                try {
                    queue.node.skip();
                    webServer.broadcastState(currentGuildId);
                } catch (err) {
                    queue.isPendingTransition = false;
                    if (queue.transitionTimeout) {
                        clearTimeout(queue.transitionTimeout);
                        queue.transitionTimeout = null;
                    }
                    log.error('[WebServer] skip error:', err.message);
                    webServer.broadcastState(currentGuildId);
                }
            }
        }
}

async function handlePrevious(ctx) {
    const { webServer, player, currentGuildId } = ctx;
    let queue = ctx.queue;

        const settings = database.getSettings(currentGuildId);

        if (settings.activePlaybackSource && settings.activePlaybackSource.startsWith('playlist_')) {
            const globalPlaylists = database.getGlobalPlaylists();
            const playlist = globalPlaylists.find(p => p.id === settings.activePlaybackSource);
            if (playlist && playlist.tracks && playlist.tracks.length > 0) {
                const currentIdx = typeof settings.playlistCurrentIndex === 'number' ? settings.playlistCurrentIndex : 0;

                // Depuis la première piste, il n'y a rien avant — sauf en
                // lecture bouclée, où le titre qui précède le premier est le
                // dernier. C'est la règle que suit déjà l'enchaînement.
                let targetIndex;
                if (currentIdx > 0) {
                    targetIndex = currentIdx - 1;
                } else if (settings.loopPlaylist) {
                    targetIndex = playlist.tracks.length - 1;
                } else {
                    targetIndex = 0;
                }

                database.updateSettings(currentGuildId, { playlistCurrentIndex: targetIndex });
                await webServer._syncPlaylistToPlayer(currentGuildId, settings.activePlaybackSource, targetIndex, true);

                // Sans cette diffusion, le tableau de bord ignore tout du
                // changement : il continue d'annoncer l'ancien titre, et en
                // diffusion personnelle le navigateur continue de le jouer —
                // seul un rechargement de la page allait rechercher l'état.
                webServer.broadcastState(currentGuildId);
                playbackStateManager.saveState(player);
                return;
            }
        }

        if (settings.broadcastMode === 'personal') {
            if (queue) {
                // La plus récente est en tête de `virtualHistory`.
                const prevTrack = queue.virtualHistory.shift();
                if (prevTrack) {
                    // Remettre l'actuel en file d'attente à l'index 0
                    if (queue.virtualCurrentTrack) {
                        queue.virtualTracks.unshift(queue.virtualCurrentTrack);
                    }
                    queue.virtualCurrentTrack = prevTrack;
                    queue.virtualIsPlaying = true;
                    queue.virtualIsPaused = false;
                    queue.virtualProgressMs = 0;
                    queue.virtualLastUpdated = Date.now();
                    webServer.broadcastState(currentGuildId);
                    playbackStateManager.saveState(player);
                }
            }
        } else {
            if (presenceManager.applyFrozenCommand(queue, 'previous')) {
                webServer.broadcastState(currentGuildId);
                playbackStateManager.saveState(player);
                return;
            }
            if (queue && queue.history) {
                if (queue.isPendingTransition) {
                    log.info(`[WebServer] Previous ignored because a transition is already under way.`);
                    return;
                }

                queue.isPendingTransition = true;
                if (queue.transitionTimeout) clearTimeout(queue.transitionTimeout);
                queue.transitionTimeout = setTimeout(() => {
                    queue.isPendingTransition = false;
                    log.info('[WebServer] Transition timeout (previous): resetting isPendingTransition to false.');
                    webServer.broadcastState(currentGuildId);
                }, 8000);

                try {
                    await queue.history.back();
                    webServer.broadcastState(currentGuildId);
                    playbackStateManager.saveState(player);
                } catch (err) {
                    queue.isPendingTransition = false;
                    if (queue.transitionTimeout) {
                        clearTimeout(queue.transitionTimeout);
                        queue.transitionTimeout = null;
                    }
                    log.error('[WebServer] previous error:', err.message);
                    webServer.broadcastState(currentGuildId);
                }
            }
        }
}

function handleSetPlayMode(ctx) {
    const { data, webServer, player, currentGuildId } = ctx;
    let queue = ctx.queue;

        const { mode } = data;
        if (queue) {
            try {
                const { QueueRepeatMode } = require('discord-player');

                // Les trois modes s'excluent. Le bouclage de playlist ne passe
                // pas par le mode de répétition de discord-player : celui-ci ne
                // rejouerait que la file réellement chargée, c'est-à-dire la
                // portion à partir du titre lancé, et non la playlist entière.
                if (mode === 'loop_track') {
                    queue.setRepeatMode(QueueRepeatMode.TRACK);
                    database.updateSettings(currentGuildId, { loopPlaylist: false });
                } else if (mode === 'loop_playlist') {
                    queue.setRepeatMode(QueueRepeatMode.OFF);
                    database.updateSettings(currentGuildId, { loopPlaylist: true });
                } else if (mode === 'default') {
                    queue.setRepeatMode(QueueRepeatMode.OFF);
                    database.updateSettings(currentGuildId, { loopPlaylist: false });
                }
                webServer.broadcastState(currentGuildId);
                playbackStateManager.saveState(player);
            } catch (err) {
                log.error('[WebServer] setPlayMode error:', err.message);
            }
        }
}

async function handleStop(ctx) {
    const { webServer, player, currentGuildId } = ctx;
    let queue = ctx.queue;

        const settings = database.getSettings(currentGuildId);
        if (settings.broadcastMode === 'personal') {
            if (queue) {
                queue.virtualIsPlaying = false;
                queue.virtualIsPaused = true;
                queue.virtualProgressMs = 0;
                queue.virtualLastUpdated = Date.now();
                webServer.broadcastState(currentGuildId);
                playbackStateManager.saveState(player);
            }
        } else {
            if (queue) {
                try {
                    if (presenceManager.applyFrozenCommand(queue, 'stop')) {
                        // rien à arrêter : la lecture est déjà à l'arrêt
                    } else if (queue.currentTrack) {
                        queue.node.setPaused(true);
                        await queue.node.seek(0);
                    }
                    webServer.broadcastState(currentGuildId);
                    playbackStateManager.saveState(player);
                } catch (err) {
                    log.error('[WebServer] stop error:', err.message);
                }
            }
        }
}

async function handleSeek(ctx) {
    const { data, webServer, player, currentGuildId } = ctx;
    let queue = ctx.queue;

        const { time } = data;
        const settings = database.getSettings(currentGuildId);
        if (settings.broadcastMode === 'personal') {
            if (queue && typeof time === 'number') {
                queue.virtualProgressMs = time;
                queue.virtualLastUpdated = Date.now();
                webServer.broadcastState(currentGuildId);
                playbackStateManager.saveState(player);
            }
        } else {
            if (queue && typeof time === 'number') {
                if (presenceManager.applyFrozenCommand(queue, 'seek', time)) {
                    webServer.broadcastState(currentGuildId);
                    playbackStateManager.saveState(player);
                    return;
                }
                try {
                    await queue.node.seek(time);

                    // Nettoyer l'historique après seek manuel pour éviter les doublons indu
                    if (queue.currentTrack) {
                        try {
                            queue.history.tracks.remove(t => t.id === queue.currentTrack.id);
                        } catch (e) { }
                    }

                    webServer.broadcastState(currentGuildId);
                    playbackStateManager.saveState(player);
                } catch (seekErr) {
                    log.error('[WebServer] seek error:', seekErr.message);
                }
            }
        }
}

function handleSyncProgress(ctx) {
    const { data } = ctx;
    let queue = ctx.queue;

        const { progressMs } = data;
        if (queue && typeof progressMs === 'number' && !queue.isPendingTransition) {
            queue.virtualProgressMs = progressMs;
            queue.virtualLastUpdated = Date.now();
        }
}

module.exports = {
    handlePlay,
    handlePause,
    handleResume,
    handleSkip,
    handlePrevious,
    handleSetPlayMode,
    handleStop,
    handleSeek,
    handleSyncProgress,
};
