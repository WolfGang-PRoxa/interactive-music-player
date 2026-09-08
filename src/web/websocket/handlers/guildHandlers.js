/**
 * Sélection de salon, paramètres de guild et détection vocale.
 *
 * Chaque handler reçoit le contexte assemblé par wsHandler :
 * { ws, data, webServer, player, queue, currentGuildId, dispatch }.
 */
const database = require('../../../database/Database');
const broadcastManager = require('../../../broadcast/BroadcastManager');
const presenceManager = require('../../../audio/PresenceManager');
const playbackStateManager = require('../../../database/PlaybackStateManager');
const { restoreHistory } = require('../../../utils/historyOrder');
const { ensureEngine } = require('../../../audio/mix');
const { applySpeed, cancelMixEffects, applyLoudness } = require('../../../audio/playbackSettings');
const loudness = require('../../../audio/loudness');
const downloadFormats = require('../../../utils/downloadFormats');
const channelQueue = require('../../../audio/channelQueue');
const log = require('../../../utils/logger');

/**
 * Destinations du champ d'ajout, dans l'ordre du menu déroulant.
 *
 * Doit rester identique aux valeurs des `<option>` de `#add-target-select`, dans
 * index.html : c'est le même choix, écrit des deux côtés du fil.
 */
const ADD_TARGETS = ['queue', 'playlist', 'play', 'download'];

async function handleSelectChannel(ctx) {
    const { ws, data, webServer, player } = ctx;
    let queue = ctx.queue;

        const { guildId: targetGuildId, channelId } = data;
        if (targetGuildId && channelId) {
            const previousGuildId = ws.selectedGuildId;
            ws.selectedGuildId = targetGuildId;
            ws.selectedVoiceChannelId = channelId;

            /*
             * Chaque salon garde sa file : on range celle qu'on quitte avant de
             * charger celle qu'on rejoint.
             *
             * L'ordre est tout : le rangement se fait sous la clé du salon
             * courant, si bien que ranger après le changement écrirait la file
             * de l'ancien salon dans le nouveau — et l'écraserait.
             */
            if (database.getSettings(targetGuildId).lastVoiceChannelId !== channelId) {
                webServer.stowChannelQueue(targetGuildId);
            }

            database.setLastVoiceChannel(targetGuildId, channelId);

            // Le chargement de la file du salon rejoint n'a pas lieu ici : la
            // restauration plus bas s'en charge, au même endroit que la piste
            // en cours et l'historique. Deux chemins concurrents se seraient
            // écrasés l'un l'autre selon leur ordre.

            /*
             * L'élection du pilote suit le tableau de bord.
             *
             * Elle n'avait lieu qu'à la connexion et à la déconnexion d'un
             * client : changer de serveur depuis l'interface amenait donc sur
             * une guilde sans pilote, et plus personne n'y annonçait les fins
             * de piste. La lecture s'y arrêtait au bout du morceau, jusqu'à ce
             * que la roue de secours du serveur avance la file une demi-minute
             * plus tard — un blanc à chaque titre, sans rien dans le journal
             * pour le dire.
             *
             * La guilde quittée est réélue d'abord : ce tableau de bord en
             * était peut-être le pilote, et un autre encore ouvert dessus doit
             * prendre le relais.
             */
            if (previousGuildId && previousGuildId !== targetGuildId) {
                webServer._ensurePilot(previousGuildId);
            }
            webServer._ensurePilot(targetGuildId);

            const guild = webServer.client.guilds.cache.get(targetGuildId);
            if (guild) {
                const voiceChannel = guild.channels.cache.get(channelId);
                if (voiceChannel) {
                    try {
                        const { useMainPlayer } = require('discord-player');
                        const player = useMainPlayer();
                        let queue = player.queues.get(targetGuildId);
                        const settings = database.getSettings(targetGuildId);

                        if (!queue) {
                            queue = player.queues.create(guild, {
                                nodeOptions: {
                                    selfDeaf: false,
                                    leaveOnEmpty: false,
                                    leaveOnEmptyCooldown: 30000,
                                    leaveOnEnd: false,
                                    leaveOnEndCooldown: 60000,
                                    volume: settings.baseVolume,
                                }
                            });
                        }


                        // 1. Sauvegarder le salon précédent si différent
                        const oldChannelId = queue.activeChannelId || queue.channel?.id;
                        if (oldChannelId && oldChannelId !== channelId) {
                            const isPersonal = settings.broadcastMode === 'personal';
                            const currentTrack = isPersonal
                                ? queue.virtualCurrentTrack
                                : (queue.currentTrack ? {
                                    title: queue.currentTrack.title,
                                    author: queue.currentTrack.author,
                                    duration: queue.currentTrack.duration,
                                    thumbnail: queue.currentTrack.thumbnail,
                                    url: queue.currentTrack.url,
                                    queryType: queue.currentTrack.queryType,
                                    extractorName: queue.currentTrack.extractor?.identifier || null
                                } : null);

                            let currentProgress = 0;
                            if (isPersonal) {
                                currentProgress = queue.virtualProgressMs || 0;
                            } else if (queue.currentTrack) {
                                try {
                                    currentProgress = queue.node.getTimestamp().current.value;
                                } catch (err) { }
                            }

                            // Diffusion commune : le bot va quitter ce salon —
                            // la suite l'emmène ailleurs, ou le détache — et la
                            // lecture s'y suspend. Le suspendre dès maintenant
                            // fait taire le salon pendant la bascule, dont
                            // l'attente de `queue.connect()` fait un moment
                            // audible, et laisse au salon quitté un morceau en
                            // pause à sa position plutôt qu'une lecture qu'il
                            // aurait poursuivie en l'absence du bot.
                            //
                            // Le mode personnel n'est pas concerné : le son sort
                            // du navigateur, que la connexion ne porte pas.
                            if (!isPersonal && queue.currentTrack) {
                                try {
                                    queue.node.setPaused(true);
                                } catch (err) { }
                            }

                            queue.channelStates[oldChannelId] = {
                                isPlaying: isPersonal ? !!queue.virtualIsPlaying : false,
                                isPaused: isPersonal ? !!queue.virtualIsPaused : !!currentTrack,
                                repeatMode: queue.repeatMode || 0,
                                currentTrack,
                                currentProgress,
                                queue: isPersonal
                                    ? (queue.virtualTracks || [])
                                    : queue.tracks.toArray().map(t => ({
                                        title: t.title,
                                        author: t.author,
                                        duration: t.duration,
                                        thumbnail: t.thumbnail || null,
                                        url: t.url,
                                        queryType: t.queryType,
                                        extractorName: t.extractor?.identifier || null
                                    })),
                                history: isPersonal
                                    ? (queue.virtualHistory || [])
                                    : queue.history.tracks.toArray().map(t => ({
                                        title: t.title,
                                        author: t.author,
                                        duration: t.duration,
                                        thumbnail: t.thumbnail || null,
                                        url: t.url,
                                        queryType: t.queryType,
                                        extractorName: t.extractor?.identifier || null
                                    }))
                            };
                        }

                        // Mettre à jour le salon actif de la queue
                        queue.activeChannelId = channelId;

                        // Salon désigné mais désert : le bot n'y entre pas. La
                        // file est chargée depuis l'instantané du salon et
                        // attend en l'état — l'arrivée du premier auditeur
                        // amènera le bot et relancera la lecture.
                        if (!presenceManager.connectionAllowed(voiceChannel)) {
                            log.info(`[WebServer] Channel « ${voiceChannel.name} » deserted: `
                                + 'the bot will come when a listener arrives.');
                            presenceManager.detach(targetGuildId);

                            const isPersonal = settings.broadcastMode === 'personal';
                            if (isPersonal) {
                                const savedState = queue.channelStates[channelId];
                                // La file en attente vient du rangement, et non de l'instantané : celui-ci
                                // recopie les pistes champ par champ, et un aiguillage y perdrait sa
                                // destination en chemin. Le reste de l'instantané — piste en cours,
                                // position, historique — garde tout son rôle.
                                if (savedState) savedState.queue = channelQueue.playable(database.getSettings(targetGuildId));
                                queue.virtualCurrentTrack = savedState?.currentTrack || null;
                                queue.virtualProgressMs = savedState?.currentProgress || 0;
                                queue.virtualIsPlaying = !!savedState?.isPlaying;
                                queue.virtualIsPaused = !!savedState?.isPaused;
                                queue.virtualTracks = savedState?.queue || [];
                                queue.virtualHistory = savedState?.history || [];
                                presenceManager.markAbsent(queue);
                            } else {
                                presenceManager.loadFrozenState(queue, channelId);
                            }

                            webServer.broadcastState(targetGuildId);
                            playbackStateManager.saveState(player);
                            return;
                        }

                        // Le salon est habité : les branches ci-dessous s'y
                        // connectent toutes, la lecture n'est donc plus figée.
                        queue.absentEmptyChannel = false;

                        // 2. Charger le nouvel état du salon cible s'il existe
                        const savedState = queue.channelStates[channelId];
                        // La file en attente vient du rangement, et non de l'instantané : celui-ci
                        // recopie les pistes champ par champ, et un aiguillage y perdrait sa
                        // destination en chemin. Le reste de l'instantané — piste en cours,
                        // position, historique — garde tout son rôle.
                        if (savedState) savedState.queue = channelQueue.playable(database.getSettings(targetGuildId));
                        if (savedState) {
                            const isPersonal = settings.broadcastMode === 'personal';
                            if (savedState.repeatMode !== undefined) {
                                try {
                                    queue.setRepeatMode(savedState.repeatMode);
                                } catch (err) { }
                            }

                            // Toujours connecter le bot au salon vocal Discord sélectionné
                            if (queue.channel?.id !== channelId || !queue.connection) {
                                await queue.connect(voiceChannel);
                            }
                            if (queue.connection) {
                                queue.guild.client.startSilencePlayer?.(queue);
                            }

                            if (isPersonal) {
                                queue.virtualCurrentTrack = savedState.currentTrack;
                                queue.virtualProgressMs = savedState.currentProgress || 0;
                                queue.virtualIsPlaying = !!savedState.isPlaying;
                                queue.virtualIsPaused = !!savedState.isPaused;
                                queue.virtualTracks = savedState.queue || [];
                                queue.virtualHistory = savedState.history || [];
                            } else {
                                // Tout le monde / Discord mode
                                queue.tracks.clear();
                                queue.history.clear();

                                if (savedState.currentTrack) {
                                    const { Track } = require('discord-player');
                                    const track = new Track(player, savedState.currentTrack);
                                    if (savedState.currentTrack.extractorName) {
                                        track.extractor = player.extractors.store.get(savedState.currentTrack.extractorName) || null;
                                    }

                                    queue.restorePaused = savedState.isPaused;
                                    queue.transitioningToEveryone = true;
                                    queue.transitionTargetProgress = savedState.currentProgress;
                                    queue.transitionTrack = track;

                                    try {
                                        await queue.play(track, {
                                            nodeOptions: {
                                                metadata: { channel: null },
                                                selfDeaf: false,
                                                volume: 0
                                            }
                                        });
                                    } catch (playErr) {
                                        log.error('[WebServer] play error while changing channel:', playErr.message);
                                    } finally {
                                        if (savedState.queue && savedState.queue.length > 0) {
                                            const tracksToRestore = savedState.queue
                                                .filter(t => t.url !== track.url)
                                                .map(tData => {
                                                    const t = new Track(player, tData);
                                                    if (tData.extractorName) {
                                                        t.extractor = player.extractors.store.get(tData.extractorName) || null;
                                                    }
                                                    return t;
                                                });
                                            if (tracksToRestore.length > 0) {
                                                queue.addTrack(tracksToRestore);
                                            }
                                        }
                                        // La piste reprise poursuit sa lecture : hors historique.
                                        restoreHistory(queue, savedState.history, tData => {
                                            const t = new Track(player, tData);
                                            if (tData.extractorName) {
                                                t.extractor = player.extractors.store.get(tData.extractorName) || null;
                                            }
                                            return t;
                                        }, track.url);
                                    }
                                } else {
                                    // Pas de morceau en cours, restaurer uniquement la file
                                    if (savedState.queue && savedState.queue.length > 0) {
                                        const { Track } = require('discord-player');
                                        const tracksToRestore = savedState.queue.map(tData => {
                                            const t = new Track(player, tData);
                                            if (tData.extractorName) {
                                                t.extractor = player.extractors.store.get(tData.extractorName) || null;
                                            }
                                            return t;
                                        });
                                        queue.addTrack(tracksToRestore);
                                    }
                                    if (savedState.history && savedState.history.length > 0) {
                                        const { Track } = require('discord-player');
                                        restoreHistory(queue, savedState.history, tData => {
                                            const t = new Track(player, tData);
                                            if (tData.extractorName) {
                                                t.extractor = player.extractors.store.get(tData.extractorName) || null;
                                            }
                                            return t;
                                        });
                                    }
                                    if (queue.dispatcher) {
                                        queue.dispatcher.end();
                                    }
                                }
                            }
                        } else {
                            // Pas d'état sauvegardé, repartir à vide pour ce salon
                            if (queue.channel?.id !== channelId || !queue.connection) {
                                await queue.connect(voiceChannel);
                            }
                            if (queue.connection) {
                                queue.guild.client.startSilencePlayer?.(queue);
                            }

                            const isPersonal = settings.broadcastMode === 'personal';
                            if (isPersonal) {
                                queue.virtualCurrentTrack = null;
                                queue.virtualProgressMs = 0;
                                queue.virtualIsPlaying = false;
                                queue.virtualIsPaused = false;
                                queue.virtualTracks = [];
                                queue.virtualHistory = [];
                            } else {
                                queue.tracks.clear();
                                queue.history.clear();
                                if (queue.dispatcher) {
                                    queue.dispatcher.end();
                                }
                            }
                        }

                        if (webServer.client.setupDucking) {
                            webServer.client.setupDucking(targetGuildId);
                        }
                    } catch (err) {
                        log.error('[WebServer] Voice channel connection error:', err.message);
                        webServer._sendError(`Impossible de rejoindre le salon vocal : ${err.message}`);
                    }
                }
            }
            webServer.broadcastState(targetGuildId);
            playbackStateManager.saveState(player);
        }
}

/**
 * Marque — ou démarque — un salon comme favori.
 *
 * Le réglage est enregistré, et rien de plus : marquer un salon ne déplace ni
 * le bot ni le tableau de bord. Le favori ne se lit qu'au démarrage du bot
 * (`Database.applyStartupChannel`), où il devient le salon courant. La
 * diffusion qui suit ne sert donc qu'à rallumer l'étoile dans le sélecteur.
 */
function handleSetDefaultChannel(ctx) {
    const { data, webServer, currentGuildId } = ctx;

        const { channelId } = data;
        database.updateSettings(currentGuildId, {
            defaultVoiceChannelId: channelId || null
        });
        webServer.broadcastState(currentGuildId);
}

/**
 * Retire un serveur Discord de l'instance : le bot le quitte pour de bon.
 *
 * Le tableau de bord ne faisait jusqu'ici que masquer le serveur de ses propres
 * listes — le bot y restait membre, et le serveur réapparaissait sur un autre
 * appareil ou après une réinstallation. Le départ est donc demandé ici à
 * Discord, seule opération qui « supprime » réellement le serveur.
 *
 * La file de lecture est détruite avant le départ : la quitter d'autorité
 * laisserait une connexion vocale orpheline dans discord-player, qui continue
 * de décoder pour un salon devenu inaccessible.
 *
 * Les réglages du serveur ne sont pas effacés : ils ne coûtent rien, et une
 * réinvitation retrouve ainsi son salon favori et ses niveaux de ducking.
 */
async function handleLeaveGuild(ctx) {
    const { ws, data, webServer } = ctx;

    const fail = (message) => {
        try {
            ws.send(JSON.stringify({ type: 'error', data: { message } }));
        } catch (e) {}
    };

    const guildId = data && data.guildId;
    const guild = guildId ? webServer.client?.guilds.cache.get(guildId) : null;
    if (!guild) {
        log.warn(`[WebServer] Leave refused: guild ${guildId} not found.`);
        return fail('Serveur introuvable — le bot n\'en fait plus partie.');
    }

    // Un bot propriétaire de son serveur ne peut pas le quitter : Discord
    // refuserait, autant le dire tout de suite.
    if (guild.ownerId === webServer.client.user?.id) {
        return fail(`Le bot est propriétaire de « ${guild.name} » : il ne peut pas le quitter.`);
    }

    const name = guild.name;

    try {
        const { useMainPlayer } = require('discord-player');
        const queue = useMainPlayer().queues.get(guildId);
        if (queue) queue.delete();
    } catch (err) {
        log.warn(`[WebServer] Queue of ${name} not destroyed before leaving: ${err.message}`);
    }

    try {
        await guild.leave();
        log.info(`[WebServer] The bot left guild « ${name} » (${guildId}).`);
    } catch (err) {
        log.error(`[WebServer] Failed to leave « ${name} »: ${err.message}`);
        return fail(`Impossible de quitter « ${name} » : ${err.message}`);
    }

    webServer.reassignClients(guildId);
}

async function handleUpdateSettings(ctx) {
    const { ws, data, webServer, player, currentGuildId } = ctx;
    let queue = ctx.queue;

        const oldSettings = database.getSettings(currentGuildId);

        // L'enchaînement mix était refusé en diffusion commune : Discord ne
        // portant qu'un flux à la fois, deux morceaux ne pouvaient pas sonner
        // ensemble. Le bus de mixage lève cette limite — il additionne les
        // pistes avant l'encodage —, et les deux modes se valent désormais.

        // Mettre à jour les réglages de diffusion
        if (data.broadcastMode !== undefined && data.broadcastMode !== oldSettings.broadcastMode) {
            broadcastManager.setMode(currentGuildId, data.broadcastMode);

            const newSettings = database.getSettings(currentGuildId);

            // Si on repasse en mode everyone, reconnecter le bot
            if (data.broadcastMode === 'everyone' && queue) {
                // Arrêter la diffusion de silence
                if (webServer.client.stopSilencePlayer) {
                    webServer.client.stopSilencePlayer(queue);
                }

                const guild = webServer.client.guilds.cache.get(currentGuildId);
                let voiceChannel = null;
                if (ws.selectedVoiceChannelId) {
                    voiceChannel = guild.channels.cache.get(ws.selectedVoiceChannelId);
                }
                if (!voiceChannel) {
                    voiceChannel = webServer._findActiveVoiceChannel(guild);
                }

                if (voiceChannel) {
                    try {
                        // Salon désert : la file bascule quand même en lecture
                        // commune, mais figée — le bot n'ira l'y jouer qu'à
                        // l'arrivée de quelqu'un.
                        const emptyChannel = !presenceManager.connectionAllowed(voiceChannel);
                        if (emptyChannel) {
                            // Le rattachement doit être inscrit avant de couper
                            // la connexion : `queue.channel` disparaît avec elle,
                            // et le tableau de bord ne saurait plus à quel salon
                            // rapporter la lecture figée — ni donc l'expliquer.
                            queue.activeChannelId = voiceChannel.id;
                            presenceManager.detach(currentGuildId);
                            presenceManager.markAbsent(queue, {
                                positionMs: queue.virtualProgressMs || 0,
                                playing: !!queue.virtualIsPlaying,
                            });
                        } else if (queue.channel?.id !== voiceChannel.id || !queue.connection || !queue.dispatcher) {
                            await queue.connect(voiceChannel);
                        } else {
                            // Le bot est déjà dans le salon : c'est le bus de
                            // mixage qui doit alimenter la connexion, et non le
                            // lecteur de discord-player — celui-ci ne produit
                            // plus rien en diffusion commune.
                            try {
                                const engine = ensureEngine(queue);
                                if (engine) log.info('[WebServer] Mix bus hooked back onto the voice connection.');
                            } catch (subErr) {
                                log.error('[WebServer] Error hooking the mix bus back:', subErr.message);
                            }
                        }
                        if (webServer.client.setupDucking) {
                            webServer.client.setupDucking(currentGuildId);
                        }

                        // Vider l'historique et la file d'attente réels pour repartir sur une base propre
                        queue.history.clear();
                        queue.tracks.clear();

                        const { Track } = require('discord-player');

                        if (queue.virtualCurrentTrack) {
                            const trackData = queue.virtualCurrentTrack;
                            queue.virtualCurrentTrack = null;

                            queue.restorePaused = queue.virtualIsPaused;
                            const progress = queue.virtualProgressMs || 0;

                            const track = new Track(player, trackData);
                            if (trackData.extractorName) {
                                track.extractor = player.extractors.store.get(trackData.extractorName) || null;
                            }

                            // Drapeaux de transition : démarrage muet, et progression
                            // affichée pendant l'extraction du flux (playerStart n'a
                            // pas encore eu lieu, le lecteur ne sait rien de la piste).
                            // Sans connexion, il n'y a pas de transition à mener :
                            // la piste est simplement posée comme piste courante.
                            if (!emptyChannel) {
                                queue.transitioningToEveryone = true;
                                queue.transitionTargetProgress = progress;
                                queue.transitionTrack = track;
                            }

                            try {
                                if (emptyChannel) {
                                    queue.__current = track;
                                } else {
                                    await queue.play(track, {
                                        nodeOptions: {
                                            metadata: { channel: null },
                                            selfDeaf: false,
                                            volume: 0 // Toujours démarrer à volume 0 pour éviter la fuite sonore de 0ms
                                        }
                                    });
                                }
                            } catch (playErr) {
                                log.error('[WebServer] play error when returning to everyone mode:', playErr.message);
                            } finally {
                                // Restaurer la file et l'historique réels (qu'il y ait eu erreur ou non)
                                if (queue.virtualTracks && queue.virtualTracks.length > 0) {
                                    const tracksToRestore = queue.virtualTracks
                                        .filter(t => t.url !== track.url)
                                        .map(tData => {
                                            const t = new Track(player, tData);
                                            if (tData.extractorName) {
                                                t.extractor = player.extractors.store.get(tData.extractorName) || null;
                                            }
                                            return t;
                                        });
                                    if (tracksToRestore.length > 0) {
                                        queue.addTrack(tracksToRestore);
                                    }
                                    queue.virtualTracks = [];
                                }
                                if (queue.virtualHistory && queue.virtualHistory.length > 0) {
                                    // La piste reprise ne fait que poursuivre sa lecture :
                                    // elle est en cours, pas terminée, donc hors historique.
                                    restoreHistory(queue, queue.virtualHistory, tData => {
                                        const t = new Track(player, tData);
                                        if (tData.extractorName) {
                                            t.extractor = player.extractors.store.get(tData.extractorName) || null;
                                        }
                                        return t;
                                    }, track.url);
                                    queue.virtualHistory = [];
                                }
                            }
                        } else {
                            // Pas de morceau en cours, restaurer uniquement la file et l'historique
                            if (queue.virtualTracks && queue.virtualTracks.length > 0) {
                                const tracksToRestore = queue.virtualTracks.map(tData => {
                                    const t = new Track(player, tData);
                                    if (tData.extractorName) {
                                        t.extractor = player.extractors.store.get(tData.extractorName) || null;
                                    }
                                    return t;
                                });
                                queue.addTrack(tracksToRestore);
                                queue.virtualTracks = [];
                            }
                            if (queue.virtualHistory && queue.virtualHistory.length > 0) {
                                restoreHistory(queue, queue.virtualHistory, tData => {
                                    const t = new Track(player, tData);
                                    if (tData.extractorName) {
                                        t.extractor = player.extractors.store.get(tData.extractorName) || null;
                                    }
                                    return t;
                                });
                                queue.virtualHistory = [];
                            }
                        }
                    } catch (err) {
                        log.error('[WebServer] Error reconnecting the bot in everyone mode:', err.message);
                    }
                }
            }
            delete data.broadcastMode;
        }

        if (Object.keys(data).length > 0) {
            if (data.baseVolume !== undefined) {
                const muteStatus = data.baseVolume === 0 ? '[MUTED]' : `[VOLUME ${data.baseVolume}%]`;
                log.info(`[Player Mute] ${muteStatus} Setting the guild volume to ${data.baseVolume}% (Source: UI / Video window)`);
            }
            if (data.playbackSpeed !== undefined) {
                log.info(`[Player Speed] Playback speed adjusted to ${data.playbackSpeed}x (Source: UI / Video window)`);
            }

            // Délai de grâce avant que le bot ne quitte un salon vidé. Il arme
            // un minuteur : une valeur aberrante — négative, texte, absurde —
            // laisserait le bot dans le salon indéfiniment ou l'en ferait
            // sortir sans cesse. Bornée aux 5 minutes du curseur.
            if (data.presenceDepartureDelay !== undefined) {
                const seconds = Number(data.presenceDepartureDelay);
                if (Number.isFinite(seconds)) {
                    data.presenceDepartureDelay = Math.min(300, Math.max(0, Math.round(seconds)));

                    // La fenêtre de réglages renvoie tout son lot à chaque
                    // `input`, et ce délai voyage donc avec le curseur de
                    // n’importe quel autre réglage : tirer celui des toasts
                    // écrivait une ligne par pixel parcouru. Le journal
                    // annonçait un changement là où il n’y en avait aucun.
                    if (data.presenceDepartureDelay !== oldSettings.presenceDepartureDelay) {
                        log.info(`[Presence] Leaving an empty channel set to ${data.presenceDepartureDelay}s.`);
                    }
                } else {
                    delete data.presenceDepartureDelay;
                }
            }

            /*
             * Destination du champ d'ajout.
             *
             * `updateSettings` écrit ce qu'on lui donne : une valeur inconnue
             * serait retenue telle quelle, et le menu déroulant se retrouverait
             * au rechargement suivant sur une option qui n'existe pas — donc
             * vide, sans que rien n'explique pourquoi. Elle est donc écartée
             * plutôt que corrigée : imposer « file d'attente » ferait croire à
             * un choix, là où il n'y a qu'une demande incompréhensible.
             */
            if (data.addTarget !== undefined && !ADD_TARGETS.includes(data.addTarget)) {
                log.warn(`[WebServer Settings] Unknown add destination ignored: ${data.addTarget}`);
                delete data.addTarget;
            }

            // Même raison pour le conteneur de téléchargement : une extension
            // que personne ne sait écrire laisserait le menu vide au
            // rechargement, et ffmpeg sans muxer au téléchargement suivant.
            if (data.importFormat !== undefined
                && !downloadFormats.EXTENSIONS.includes(data.importFormat)) {
                log.warn(`[WebServer Settings] Unknown download format ignored: ${data.importFormat}`);
                delete data.importFormat;
            }

            // La cible de sonie est ramenée dans les bornes du curseur plutôt
            // qu'écartée : hors bornes, elle reste une intention lisible — le
            // plus fort, ou le plus discret possible.
            if (data.lufsSyncTarget !== undefined) {
                data.lufsSyncTarget = loudness.clampTarget(data.lufsSyncTarget);
            }

            database.updateSettings(currentGuildId, data);

            // Un compte à rebours déjà lancé tourne sur l'ancien délai : le
            // réarmer fait valoir le nouveau réglage sans attendre le prochain
            // salon vidé.
            if (data.presenceDepartureDelay !== undefined) {
                presenceManager.rescheduleDeparture(currentGuildId);
            }

            // Mettre à jour le lecteur en cours de lecture
            if (queue && data.baseVolume !== undefined) {
                queue.node.setVolume(data.baseVolume);
            }

            // Mettre à jour la vitesse de lecture
            if (queue && data.playbackSpeed !== undefined) {
                applySpeed(queue, data.playbackSpeed);
            }

            /*
             * Synchronisation des niveaux sonores.
             *
             * Rien n'est écrit sur les pistes : la cible commune est une couche
             * par-dessus les cibles individuelles, jamais à leur place. Décocher
             * l'option suffit donc à rendre à chaque morceau le réglage qu'il
             * avait — il n'a jamais cessé d'être en base.
             *
             * Le gain, lui, s'entend tout de suite : c'est un multiplicateur du
             * mixage, que le bus reprend sans relancer le moindre décodeur.
             */
            if (data.lufsSyncEnabled !== undefined || data.lufsSyncTarget !== undefined) {
                applyLoudness(queue);
            }

            // Désactivation du mix en cours de route
            if (data.mixEnabled === false && queue) {
                queue.isMixFadingOut = false;
                const baseVol = data.baseVolume !== undefined ? data.baseVolume : oldSettings.baseVolume;
                queue.node.setVolume(baseVol);
                cancelMixEffects(queue);
            }

            // Mettre à jour le ducking manager s'il existe
            const duckingManager = webServer.client?.duckingManagers?.get(currentGuildId);
            if (duckingManager) {
                if (data.baseVolume !== undefined) {
                    duckingManager.volumeController.setBaseVolume(data.baseVolume);
                }
                if (data.duckingEnabled !== undefined) {
                    duckingManager.refresh();
                }
            }
        }

        webServer.broadcastState(currentGuildId);
}

function handleToggleVoiceDetection(ctx) {
    const { ws, data, webServer, currentGuildId } = ctx;
    let queue = ctx.queue;

        const { userId, enabled } = data;
        if (!userId) return;

        // Le salon que le tableau de bord affiche, d'abord : c'est celui dont
        // il montre les membres, et celui sous lequel `getState()` relira la
        // liste des exclusions. Passer par le salon du bot — voire par le
        // premier salon habité de la guilde quand il n'est connecté nulle part
        // — rangeait le réglage sous une autre clé que celle relue, et
        // l'interrupteur revenait à sa position d'origine à l'état suivant.
        const activeChannelId = ws?.selectedVoiceChannelId
            || queue?.channel?.id
            || webServer._findActiveVoiceChannel(
                webServer.client?.guilds?.cache?.get(currentGuildId)
            )?.id;

        if (!activeChannelId) {
            log.warn('[WebServer] toggleVoiceDetection: no active voice channel');
            return;
        }

        database.toggleVoiceDetection(currentGuildId, activeChannelId, userId, enabled);

        // Rafraîchir le DuckingManager pour prendre en compte le changement immédiatement
        const duckMgr = webServer.client?.duckingManagers?.get(currentGuildId);
        if (duckMgr) {
            duckMgr.refresh();
        }

        log.info(`[WebServer] Voice detection ${enabled ? 'enabled' : 'disabled'} for ${userId} in ${activeChannelId}`);
        webServer.broadcastState(currentGuildId);
}

module.exports = {
    handleSelectChannel,
    handleSetDefaultChannel,
    handleLeaveGuild,
    handleUpdateSettings,
    handleToggleVoiceDetection,
};
