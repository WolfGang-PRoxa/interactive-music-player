/**
 * Contrôles de lecture : play, pause, navigation, seek, vitesse.
 *
 * Chaque handler reçoit le contexte assemblé par wsHandler :
 * { ws, data, webServer, player, queue, currentGuildId, dispatch }.
 */
const database = require('../../../database/Database');
const playbackStateManager = require('../../../database/PlaybackStateManager');
const presenceManager = require('../../../audio/PresenceManager');
const { foldVirtualElapsed } = require('../../../audio/PlaybackSession');
const { searchLocalAwareTrack, playlistIsSource, addToSetAsideQueue } = require('../handlerUtils');
const { getCleanFilename } = require('../../../utils/paths');
const log = require('../../../utils/logger');
const { isInsideAllowedRoots } = require('../../../utils/mediaPaths');

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

            /*
             * Le disque de l'hôte n'est pas une bibliothèque partagée.
             *
             * Ce qui suit parcourt un dossier et en rend les fichiers audio, en
             * remontant leurs noms dans la file — donc dans le tableau de bord de
             * qui a demandé. Le chemin étant celui qu'on veut, un invité pourvu
             * du seul droit d'ajouter à la file pouvait s'en servir pour explorer
             * la machine, dossier par dossier.
             *
             * Les racines de `mediaPaths` disent où la musique habite :
             * data/uploads, data/cache, et ce que `MEDIA_ROOTS` désigne. C'est
             * déjà la frontière que `/api/stream` oppose au moment de servir un
             * fichier ; elle s'applique désormais aussi au moment de l'ajouter,
             * faute de quoi on ajoutait des pistes qu'on ne pouvait pas écouter.
             *
             * Le maître n'est pas concerné : c'est sa machine, et lui interdire
             * de jouer un dossier qu'il vient de brancher n'y protégerait rien.
             */
            if (resolvedPath && fs.existsSync(resolvedPath) && !ws.identity?.master
                && !isInsideAllowedRoots(resolvedPath)) {
                log.warn(`[Play] Local path refused to guest `
                    + `${ws.identity?.session?.userId || '?'}: outside the media roots.`);
                webServer._sendError(
                    'Ce dossier est en dehors de la bibliothèque musicale du bot.');
                return;
            }

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
                // Avant de figer l'horloge, solder ce qu'elle doit.
                //
                // La position n'avance que par tours d'une seconde, et une pause
                // tombe presque toujours entre deux : sans ce solde, la fraction
                // en cours était perdue, et la lecture reprenait jusqu'à une
                // seconde en deçà du point où l'utilisateur l'avait arrêtée.
                foldVirtualElapsed(queue, parseFloat(settings.playbackSpeed || '1.0'));
                queue.virtualIsPlaying = false;
                queue.virtualIsPaused = true;
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
    const { data, ws, webServer, currentGuildId } = ctx;
    let queue = ctx.queue;

        /*
         * Le pilote seul fait foi.
         *
         * Chaque tableau de bord remontait sa position chaque seconde, et le
         * serveur retenait celle du dernier arrivé. Avec un invité distant, la
         * position partagée oscillait donc entre la sienne et celle de l'hôte,
         * à la latence près — et tout tableau de bord à plus de deux secondes de
         * l'écart se voyait recaler dessus. Le message étant ouvert à tous, un
         * invité sans le moindre droit déplaçait en outre la lecture des autres.
         *
         * Les fins de piste obéissent déjà à cette règle (voir
         * `handleSkip`) ; la position la rejoint. Le refus est muet : le
         * message part chaque seconde, et ne pas être pilote n'est pas une faute.
         */
        if (ws && webServer && typeof webServer.isPilot === 'function'
            && !webServer.isPilot(ws, currentGuildId)) {
            return;
        }

        const { progressMs } = data;
        if (queue && typeof progressMs === 'number' && !queue.isPendingTransition) {
            queue.virtualProgressMs = progressMs;
            queue.virtualLastUpdated = Date.now();
        }
}

/**
 * Lance la lecture de la source active, lecteur vide.
 *
 * Le bouton lecture du tableau de bord ne savait rien faire d'un lecteur vide :
 * il annonçait « aucune musique en cours » et s'arrêtait là, alors que la file
 * ou la playlist désignée comme source n'attendait qu'un départ. Ce handler est
 * ce départ. Le tableau de bord vérifie de son côté que la source a de quoi
 * jouer — c'est lui qui sait quoi proposer sinon —, mais rien ici ne s'y fie :
 * son état date de la dernière diffusion, et deux navigateurs peuvent piloter
 * le même bot.
 *
 * `data.source` bascule la source avant de démarrer. C'est ce qu'envoie le
 * bouton de la notification, qui propose l'autre source quand celle qui est
 * choisie n'a rien à jouer. La bascule passe par `setActivePlaybackSource`
 * plutôt que d'être refaite ici : elle range la file de côté, restaure celle
 * qui l'était, et démarre déjà la playlist qu'on lui désigne. Il ne reste alors
 * qu'à ne rien faire — c'est le rôle de la garde ci-dessous.
 *
 * @param {object} ctx Contexte assemblé par wsHandler.
 */
async function handleStartPlaybackSource(ctx) {
    const { ws, data, webServer, player, currentGuildId, dispatch } = ctx;

    if (data && data.source) {
        const before = database.getSettings(currentGuildId).activePlaybackSource || 'queue';
        if (data.source !== before) {
            await dispatch({
                type: 'setActivePlaybackSource',
                guildId: currentGuildId,
                data: { source: data.source, index: 0 },
            });
        }
    }

    const settings = database.getSettings(currentGuildId);
    const isPersonal = settings.broadcastMode === 'personal';
    const source = settings.activePlaybackSource || 'queue';
    const queue = player.queues.get(currentGuildId) || ctx.queue;

    // Une piste occupe déjà le lecteur : il n'y a rien à démarrer. C'est le cas
    // après une bascule vers une playlist, qui a lancé la lecture elle-même.
    const busy = isPersonal ? !!queue?.virtualCurrentTrack : !!queue?.currentTrack;
    if (busy) {
        webServer.broadcastState(currentGuildId);
        return;
    }

    if (source !== 'queue') {
        // Depuis son premier titre, et non depuis `playlistCurrentIndex` : cet
        // index est resté sur la piste où la lecture s'est arrêtée, et repartir
        // de là ne jouerait que la fin de la playlist. « Lancer la playlist »,
        // lecteur vide, veut dire la reprendre au début.
        await webServer._syncPlaylistToPlayer(currentGuildId, source, 0, true);
        webServer.broadcastState(currentGuildId);
        playbackStateManager.saveState(player);
        return;
    }

    if (isPersonal) {
        // Le premier titre de la file quitte l'attente pour le lecteur, comme
        // le fait la fin d'une piste — voir WebServer.handleVirtualSkip.
        const next = (queue?.virtualTracks || [])[0];
        if (!next) return;

        queue.virtualTracks.shift();
        queue.virtualCurrentTrack = next;
        queue.virtualProgressMs = 0;
        queue.virtualIsPlaying = true;
        queue.virtualIsPaused = false;
        queue.virtualLastUpdated = Date.now();

        webServer.broadcastState(currentGuildId);
        playbackStateManager.saveState(player);
        return;
    }

    if (!queue || queue.tracks.size === 0) return;

    const guild = webServer.client.guilds.cache.get(currentGuildId);
    if (!guild) return;

    let voiceChannel = ws && ws.selectedVoiceChannelId
        ? guild.channels.cache.get(ws.selectedVoiceChannelId)
        : null;
    if (!voiceChannel) voiceChannel = webServer._findActiveVoiceChannel(guild);
    if (!voiceChannel) {
        webServer._sendError('Vous devez rejoindre un salon vocal pour lancer de la musique.');
        return;
    }

    // Salon désert : le bot n'y entre pas, et la file démarrera d'elle-même à
    // l'arrivée d'un auditeur. Même arbitrage que pour l'ajout d'une piste.
    if (!await presenceManager.connectIfInhabited(queue, voiceChannel)) {
        webServer.broadcastState(currentGuildId);
        return;
    }

    try {
        // Sans argument, le lecteur dépile le premier titre de la file : il
        // quitte l'attente au lieu d'y rester en double, ce qui arriverait à
        // rejouer la même piste en boucle.
        await queue.node.play();
    } catch (err) {
        log.error('[WebServer] Queue start error:', err.message);
        webServer._sendError(`Impossible de lancer la file d'attente : ${err.message}`);
        return;
    }

    webServer.broadcastState(currentGuildId);
    playbackStateManager.saveState(player);
}

module.exports = {
    handlePlay,
    handleStartPlaybackSource,
    handlePause,
    handleResume,
    handleSkip,
    handlePrevious,
    handleSetPlayMode,
    handleStop,
    handleSeek,
    handleSyncProgress,
};
