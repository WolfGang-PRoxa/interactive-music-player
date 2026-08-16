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
const { assurerMoteur } = require('../../../audio/mix');
const { appliquerVitesse, annulerEffetsMix } = require('../../../audio/reglagesLecture');
const log = require('../../../utils/logger');

async function handleSelectChannel(ctx) {
    const { ws, data, webServer, player } = ctx;
    let queue = ctx.queue;

        const { guildId: targetGuildId, channelId } = data;
        if (targetGuildId && channelId) {
            ws.selectedGuildId = targetGuildId;
            ws.selectedVoiceChannelId = channelId;
            database.setLastVoiceChannel(targetGuildId, channelId);

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
                        if (!presenceManager.connexionAutorisee(voiceChannel)) {
                            log.info(`[WebServer] Salon « ${voiceChannel.name} » désert : `
                                + 'le bot y viendra à l\'arrivée d\'un auditeur.');
                            presenceManager.detacher(targetGuildId);

                            const isPersonal = settings.broadcastMode === 'personal';
                            if (isPersonal) {
                                const savedState = queue.channelStates[channelId];
                                queue.virtualCurrentTrack = savedState?.currentTrack || null;
                                queue.virtualProgressMs = savedState?.currentProgress || 0;
                                queue.virtualIsPlaying = !!savedState?.isPlaying;
                                queue.virtualIsPaused = !!savedState?.isPaused;
                                queue.virtualTracks = savedState?.queue || [];
                                queue.virtualHistory = savedState?.history || [];
                                presenceManager.marquerAbsent(queue);
                            } else {
                                presenceManager.chargerEtatFige(queue, channelId);
                            }

                            webServer.broadcastState(targetGuildId);
                            playbackStateManager.saveState(player);
                            return;
                        }

                        // Le salon est habité : les branches ci-dessous s'y
                        // connectent toutes, la lecture n'est donc plus figée.
                        queue.absentSalonVide = false;

                        // 2. Charger le nouvel état du salon cible s'il existe
                        const savedState = queue.channelStates[channelId];
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
                                        log.error('[WebServer] Erreur play lors du changement de salon :', playErr.message);
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
                        log.error('[WebServer] Erreur connexion salon vocal:', err.message);
                        webServer._sendError(`Impossible de rejoindre le salon vocal : ${err.message}`);
                    }
                }
            }
            webServer.broadcastState(targetGuildId);
            playbackStateManager.saveState(player);
        }
}

function handleSetDefaultChannel(ctx) {
    const { data, webServer, currentGuildId } = ctx;

        const { channelId } = data;
        database.updateSettings(currentGuildId, {
            defaultVoiceChannelId: channelId || null
        });
        webServer.broadcastState(currentGuildId);
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
                        const salonDesert = !presenceManager.connexionAutorisee(voiceChannel);
                        if (salonDesert) {
                            // Le rattachement doit être inscrit avant de couper
                            // la connexion : `queue.channel` disparaît avec elle,
                            // et le tableau de bord ne saurait plus à quel salon
                            // rapporter la lecture figée — ni donc l'expliquer.
                            queue.activeChannelId = voiceChannel.id;
                            presenceManager.detacher(currentGuildId);
                            presenceManager.marquerAbsent(queue, {
                                positionMs: queue.virtualProgressMs || 0,
                                enLecture: !!queue.virtualIsPlaying,
                            });
                        } else if (queue.channel?.id !== voiceChannel.id || !queue.connection || !queue.dispatcher) {
                            await queue.connect(voiceChannel);
                        } else {
                            // Le bot est déjà dans le salon : c'est le bus de
                            // mixage qui doit alimenter la connexion, et non le
                            // lecteur de discord-player — celui-ci ne produit
                            // plus rien en diffusion commune.
                            try {
                                const moteur = assurerMoteur(queue);
                                if (moteur) log.info('[WebServer] Bus de mixage raccroché à la connexion vocale.');
                            } catch (subErr) {
                                log.error('[WebServer] Erreur de raccrochage du bus de mixage :', subErr.message);
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
                            if (!salonDesert) {
                                queue.transitioningToEveryone = true;
                                queue.transitionTargetProgress = progress;
                                queue.transitionTrack = track;
                            }

                            try {
                                if (salonDesert) {
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
                                log.error('[WebServer] Erreur play lors du retour en mode everyone :', playErr.message);
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
                        log.error('[WebServer] Erreur reconnexion bot en mode everyone:', err.message);
                    }
                }
            }
            delete data.broadcastMode;
        }

        if (Object.keys(data).length > 0) {
            if (data.baseVolume !== undefined) {
                const muteStatus = data.baseVolume === 0 ? '[SOURDINE ACTIVÉE]' : `[VOLUME ${data.baseVolume}%]`;
                log.info(`[Player Mute] ${muteStatus} Réglage du volume à ${data.baseVolume}% pour le serveur (Source: IHM / Fenêtre Vidéo)`);
            }
            if (data.playbackSpeed !== undefined) {
                log.info(`[Player Speed] Vitesse de lecture ajustée à ${data.playbackSpeed}x (Source: IHM / Fenêtre Vidéo)`);
            }

            // Délai de grâce avant que le bot ne quitte un salon vidé. Il arme
            // un minuteur : une valeur aberrante — négative, texte, absurde —
            // laisserait le bot dans le salon indéfiniment ou l'en ferait
            // sortir sans cesse. Bornée aux 5 minutes du curseur.
            if (data.presenceDepartureDelay !== undefined) {
                const secondes = Number(data.presenceDepartureDelay);
                if (Number.isFinite(secondes)) {
                    data.presenceDepartureDelay = Math.min(300, Math.max(0, Math.round(secondes)));
                    log.info(`[Presence] Départ d'un salon vide fixé à ${data.presenceDepartureDelay}s.`);
                } else {
                    delete data.presenceDepartureDelay;
                }
            }

            database.updateSettings(currentGuildId, data);

            // Un compte à rebours déjà lancé tourne sur l'ancien délai : le
            // réarmer fait valoir le nouveau réglage sans attendre le prochain
            // salon vidé.
            if (data.presenceDepartureDelay !== undefined) {
                presenceManager.reprogrammerDepart(currentGuildId);
            }

            // Mettre à jour le lecteur en cours de lecture
            if (queue && data.baseVolume !== undefined) {
                queue.node.setVolume(data.baseVolume);
            }

            // Mettre à jour la vitesse de lecture
            if (queue && data.playbackSpeed !== undefined) {
                appliquerVitesse(queue, data.playbackSpeed);
            }

            // Désactivation du mix en cours de route
            if (data.mixEnabled === false && queue) {
                queue.isMixFadingOut = false;
                const baseVol = data.baseVolume !== undefined ? data.baseVolume : oldSettings.baseVolume;
                queue.node.setVolume(baseVol);
                annulerEffetsMix(queue);
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
            log.warn('[WebServer] toggleVoiceDetection : aucun salon vocal actif');
            return;
        }

        database.toggleVoiceDetection(currentGuildId, activeChannelId, userId, enabled);

        // Rafraîchir le DuckingManager pour prendre en compte le changement immédiatement
        const duckMgr = webServer.client?.duckingManagers?.get(currentGuildId);
        if (duckMgr) {
            duckMgr.refresh();
        }

        log.info(`[WebServer] Détection vocale ${enabled ? 'activée' : 'désactivée'} pour ${userId} dans ${activeChannelId}`);
        webServer.broadcastState(currentGuildId);
}

module.exports = {
    handleSelectChannel,
    handleSetDefaultChannel,
    handleUpdateSettings,
    handleToggleVoiceDetection,
};
