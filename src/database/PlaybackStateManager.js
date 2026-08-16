const fs = require('fs');
const path = require('path');
const { Track } = require('discord-player');
const { writeJsonAtomic, readJsonSafe, cleanStaleTemp } = require('../utils/atomicJson');
const { restoreHistory } = require('../utils/historyOrder');
const log = require('../utils/logger');

class PlaybackStateManager {
    constructor() {
        this.filepath = path.join(process.cwd(), 'data', 'playback_state.json');
        cleanStaleTemp(this.filepath);
    }

    /**
     * Effectue un fade-out progressif de 5 secondes sur le volume des queues actives avant de sauvegarder l'état final.
     * @param {import('discord-player').Player|null} player 
     * @param {number} fadeDurationMs - Durée du fade-out (par défaut 5000ms)
     * @returns {Promise<void>}
     */
    async fadeOutAndSaveState(player, fadeDurationMs = 5000) {
        if (!player || !player.queues) return;

        const activeQueues = [];
        player.queues.cache.forEach(queue => {
            const isPlaying = queue.virtualCurrentTrack ? queue.virtualIsPlaying : (queue.currentTrack && queue.node && queue.node.isPlaying());
            if (isPlaying) {
                activeQueues.push(queue);
            }
        });

        if (activeQueues.length === 0) {
            log.info('[PlaybackState] Aucune lecture active nécessitant un fade-out. Sauvegarde directe.');
            this.saveState(player);
            return;
        }

        log.info(`[PlaybackState] Démarrage du fade-out de ${fadeDurationMs / 1000}s avant sauvegarde...`);

        const steps = 35;
        const stepIntervalMs = Math.round(fadeDurationMs / steps);
        const startTime = Date.now();

        const queueFadeData = activeQueues.map(queue => {
            const guildId = queue.guild.id;
            const settings = require('./Database').getSettings(guildId);
            let initialVol = (settings.baseVolume !== undefined && settings.baseVolume !== null) ? settings.baseVolume : 100;
            if (queue.node && typeof queue.node.volume === 'number' && queue.node.volume > 0) {
                initialVol = queue.node.volume;
            }
            return {
                queue,
                guildId,
                initialVol,
                // Le contrôleur de volume porte le ducking : il faut passer par lui,
                // sinon ses propres rampes réécrivent le volume par-dessus la
                // descente et le silence final n'est jamais atteint.
                volumeController: this._volumeControllerDe(queue)
            };
        });

        // Verrouiller les contrôleurs avant la première étape : le ducking ne doit
        // plus toucher au volume à partir d'ici.
        queueFadeData.forEach(item => {
            if (item.volumeController) {
                item.volumeController.reserverPourFadeExterne();
            }
        });

        for (let step = 1; step <= steps; step++) {
            await new Promise(resolve => setTimeout(resolve, stepIntervalMs));
            const linearFactor = 1 - (step / steps);
            // Courbe exponentielle pour atteindre 0dB de façon naturelle et imperceptible
            const curveFactor = Math.pow(linearFactor, 2.5);

            queueFadeData.forEach(item => {
                try {
                    const targetVol = (step === steps) ? 0 : Math.max(0, Math.round(item.initialVol * curveFactor));
                    if (item.volumeController) {
                        item.volumeController._setVolumeImmediate(targetVol);
                    } else if (item.queue.node && typeof item.queue.node.setVolume === 'function') {
                        item.queue.node.setVolume(targetVol);
                    }
                } catch (e) {}
            });
        }

        const elapsedMs = Date.now() - startTime;

        // Mettre à jour virtualProgressMs pour la lecture virtuelle / personnelle
        activeQueues.forEach(queue => {
            if (queue.virtualCurrentTrack && queue.virtualIsPlaying) {
                queue.virtualProgressMs = (queue.virtualProgressMs || 0) + elapsedMs;
            }
        });

        // Sauvegarder l'état final avec le volume maintenu à 0 jusqu'à l'arrêt complet
        this.saveState(player);

        log.info(`[PlaybackState] Fade-out exponentiel de ${elapsedMs}ms complété jusqu'à 0dB et état sauvegardé.`);
    }

    /**
     * Récupère le contrôleur de volume d'une file, s'il en existe un.
     * @param {object} queue
     * @returns {import('../audio/VolumeController')|null}
     */
    _volumeControllerDe(queue) {
        const guildId = queue?.guild?.id;
        const managers = queue?.player?.client?.duckingManagers;
        if (!guildId || !managers) return null;
        return managers.get(guildId)?.volumeController || null;
    }

    /**
     * Effectue un fade-in progressif du volume de la queue.
     * @param {object} queue
     * @param {number} targetVol
     * @param {number} fadeinDurationMs
     */
    fadeInVolume(queue, targetVol, fadeinDurationMs = 5000) {
        if (!queue || !queue.node) return;

        try {
            queue.node.setVolume(0);
        } catch (e) {}

        const volumeController = this._volumeControllerDe(queue);
        if (volumeController) {
            // Départ imposé à 0 et courbe perceptive : le contrôleur ne se fie pas
            // à `queue.node.volume`, qui vaut 100 par défaut tant qu'aucun flux
            // n'est branché et faisait conclure qu'il n'y avait rien à monter.
            volumeController.fadeInDepuisSilence(targetVol, fadeinDurationMs);
            return;
        }

        const steps = 30;
        const stepIntervalMs = Math.max(20, Math.round(fadeinDurationMs / steps));
        let currentStep = 0;

        const fadeTimer = setInterval(() => {
            currentStep++;
            const progress = currentStep / steps;
            const curveFactor = Math.pow(progress, 2);
            const currentVol = Math.max(0, Math.min(targetVol, Math.round(targetVol * curveFactor)));

            try {
                if (queue.node && typeof queue.node.setVolume === 'function') {
                    queue.node.setVolume(currentVol);
                }
            } catch (err) {}

            if (currentStep >= steps) {
                clearInterval(fadeTimer);
                try {
                    if (queue.node && typeof queue.node.setVolume === 'function') {
                        queue.node.setVolume(targetVol);
                    }
                } catch (err) {}
            }
        }, stepIntervalMs);
    }

    /**
     * Sauvegarde l'état complet de toutes les files d'attente actives du player (par salon).
     * @param {import('discord-player').Player|null} player 
     */
    saveState(player) {
        if (!player || !player.queues) return;
        try {
            const data = {};
            player.queues.cache.forEach(queue => {
                const guildId = queue.guild.id;

                const settings = require('./Database').getSettings(guildId);
                const isPersonal = settings.broadcastMode === 'personal';
                const activeChannelId = queue.activeChannelId || queue.channel?.id;

                // Le bot s'est retiré d'un salon vide : son lecteur est démonté
                // et ne rendrait que des zéros. La position et l'état de lecture
                // viennent alors de la session, qui les a relevés avant le
                // départ ; le reste — piste, file, historique — n'a pas bougé.
                const geleParAbsence = queue.session.estGelee();

                // Si on a un salon actif, on synchronise son état en cours dans le cache des salons de la queue
                if (activeChannelId) {
                    const currentTrack = isPersonal
                        ? queue.virtualCurrentTrack
                        : (queue.currentTrack ? {
                            title: queue.currentTrack.title,
                            author: queue.currentTrack.author,
                            duration: queue.currentTrack.duration,
                            thumbnail: queue.currentTrack.thumbnail,
                            url: queue.currentTrack.url,
                            queryType: queue.currentTrack.queryType,
                            raw: {},
                            extractorName: queue.currentTrack.extractor?.identifier || null
                        } : null);

                    let currentProgress = 0;
                    if (isPersonal) {
                        currentProgress = queue.virtualProgressMs || 0;
                    } else if (geleParAbsence) {
                        currentProgress = queue.positionFigeeMs || 0;
                    } else if (queue.currentTrack) {
                        try {
                            currentProgress = queue.node.getTimestamp().current.value;
                        } catch (err) {}
                    }

                    queue.channelStates[activeChannelId] = {
                        // La session sait à qui poser la question : au lecteur
                        // virtuel, au lecteur réel, ou à l'état figé de l'absence.
                        isPlaying: queue.session.getIsPlaying(),
                        isPaused: queue.session.getIsPaused(),
                        repeatMode: queue.repeatMode || 0,
                        currentTrack,
                        currentProgress,
                        savedAt: Date.now(),
                        queue: isPersonal
                            ? (queue.virtualTracks || [])
                            : queue.tracks.toArray().map(t => ({
                                title: t.title,
                                author: t.author,
                                duration: t.duration,
                                thumbnail: t.thumbnail || null,
                                url: t.url,
                                queryType: t.queryType,
                                raw: {},
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
                                raw: {},
                                extractorName: t.extractor?.identifier || null
                            }))
                    };
                }

                data[guildId] = {
                    guildId,
                    activeChannelId: activeChannelId || null,
                    channels: queue.channelStates || {}
                };
            });

            writeJsonAtomic(this.filepath, data);
        } catch (err) {
            log.error('[PlaybackState] Erreur lors de la sauvegarde :', err.message);
        }
    }

    /**
     * Restaure toutes les files d'attente et lectures sauvegardées au démarrage.
     * @param {import('discord.js').Client} client 
     * @param {import('discord-player').Player} player 
     */
    async restoreAll(client, player) {
        // Un redémarrage se veut transparent : l'instance précédente a sauvegardé
        // sans fade-out et sans couper la musique. Lui opposer un fade-in ferait
        // entendre la coupure qu'on cherche justement à masquer. La variable est
        // retirée aussitôt lue : elle ne concerne que cette restauration, pas la
        // durée de vie du process.
        const estRedemarrage = process.env.IMP_REDEMARRAGE === '1';
        delete process.env.IMP_REDEMARRAGE;

        const data = readJsonSafe(this.filepath, '[PlaybackState]');
        if (!data) return;
        try {
            log.info('[PlaybackState] Restauration des files de lecture...');
            if (estRedemarrage) {
                log.info('[PlaybackState] Reprise après redémarrage : fade-in de démarrage ignoré.');
            }

            // Écouteur pour la restauration silencieuse et la reprise en temps réel (sans coupure ni saut en arrière)
            const onRestorePlayerStart = (queue, track) => {
                if (queue.restorePaused) {
                    const guildId = queue.guild.id;
                    const progress = queue.restoreProgress || 0;
                    const shouldBePaused = !!queue.restoreShouldBePaused;
                    
                    try {
                        queue.node.setPaused(true);
                        queue.node.setVolume(0);
                    } catch (err) {}

                    if (progress > 0) {
                        queue.restoreProgress = 0; // Éviter les boucles lors des événements suivants
                        log.info(`[PlaybackState] Restauration : repositionnement immédiat à ${progress}ms...`);
                        try {
                            queue.node.seek(progress);
                        } catch (seekErr) {
                            log.error('[PlaybackState] Erreur seek :', seekErr.message);
                        }
                        
                        setTimeout(() => {
                            try {
                                const settings = require('./Database').getSettings(guildId);
                                const targetVol = (settings.baseVolume !== undefined && settings.baseVolume !== null) ? settings.baseVolume : 100;
                                const fadeinEnabled = !estRedemarrage && !!settings.fadeinEnabled;
                                const fadeinDurationMs = (settings.fadeinDuration !== undefined ? parseFloat(settings.fadeinDuration) : 5) * 1000;

                                if (!shouldBePaused) {
                                    queue.node.setPaused(false);
                                    if (fadeinEnabled && fadeinDurationMs > 0) {
                                        log.info(`[PlaybackState] Restauration terminée : démarrage du fade-in de ${fadeinDurationMs / 1000}s vers ${targetVol}%...`);
                                        this.fadeInVolume(queue, targetVol, fadeinDurationMs);
                                    } else {
                                        queue.node.setVolume(targetVol);
                                        log.info(`[PlaybackState] Restauration terminée : reprise immédiate de la lecture à ${progress}ms (volume: ${targetVol}%).`);
                                    }
                                } else {
                                    queue.node.setPaused(true);
                                    queue.node.setVolume(targetVol);
                                    log.info(`[PlaybackState] Restauration terminée : en pause à ${progress}ms (volume: ${targetVol}%).`);
                                }
                                
                                queue.restorePaused = false;
                                
                                if (!player.queues.cache.some(q => q.restorePaused)) {
                                    player.events.off('playerStart', onRestorePlayerStart);
                                }
                            } catch (volErr) {
                                log.error('[PlaybackState] Erreur finalisation seek :', volErr.message);
                            }
                        }, 1000);
                    } else {
                        setTimeout(() => {
                            try {
                                const settings = require('./Database').getSettings(guildId);
                                const targetVol = (settings.baseVolume !== undefined && settings.baseVolume !== null) ? settings.baseVolume : 100;
                                const fadeinEnabled = !estRedemarrage && !!settings.fadeinEnabled;
                                const fadeinDurationMs = (settings.fadeinDuration !== undefined ? parseFloat(settings.fadeinDuration) : 5) * 1000;

                                if (!shouldBePaused) {
                                    queue.node.setPaused(false);
                                    if (fadeinEnabled && fadeinDurationMs > 0) {
                                        log.info(`[PlaybackState] Restauration terminée : démarrage du fade-in de ${fadeinDurationMs / 1000}s vers ${targetVol}%...`);
                                        this.fadeInVolume(queue, targetVol, fadeinDurationMs);
                                    } else {
                                        queue.node.setVolume(targetVol);
                                    }
                                } else {
                                    queue.node.setPaused(true);
                                    queue.node.setVolume(targetVol);
                                }
                                queue.restorePaused = false;
                                
                                if (!player.queues.cache.some(q => q.restorePaused)) {
                                    player.events.off('playerStart', onRestorePlayerStart);
                                }
                            } catch (volErr) {
                                log.error('[PlaybackState] Erreur finalisation sans seek :', volErr.message);
                            }
                        }, 500);
                    }
                }
            };
            player.events.on('playerStart', onRestorePlayerStart);

            for (const [guildId, state] of Object.entries(data)) {
                const guild = client.guilds.cache.get(guildId);
                if (!guild) {
                    log.info(`[PlaybackState] Guilde ${guildId} non trouvée dans le cache.`);
                    continue;
                }

                const settings = require('./Database').getSettings(guildId);
                const isPersonal = settings.broadcastMode === 'personal';

                // Gestion rétrocompatible de l'ancien format simple vers le nouveau format multi-salons
                let channels = state.channels || {};
                const activeChannelId = state.activeChannelId || state.channelId;
                
                if (Object.keys(channels).length === 0 && activeChannelId) {
                    channels[activeChannelId] = {
                        isPlaying: state.isPlaying,
                        isPaused: state.isPaused,
                        repeatMode: state.repeatMode || 0,
                        currentTrack: state.currentTrack,
                        currentProgress: state.currentProgress || 0,
                        queue: state.queue || [],
                        history: state.history || []
                    };
                }

                const defaultChannelId = settings.defaultVoiceChannelId;
                const channelId = defaultChannelId || activeChannelId || settings.lastVoiceChannelId;

                let voiceChannel = null;
                if (channelId) {
                    voiceChannel = guild.channels.cache.get(channelId);
                }

                // Un salon désert ne mérite pas qu'on s'y connecte : la file est
                // restaurée telle quelle, mais figée, et le bot n'arrivera qu'à
                // l'entrée du premier auditeur.
                const presenceManager = require('../audio/PresenceManager');
                const salonAccessible = voiceChannel && presenceManager.connexionAutorisee(voiceChannel);

                if (salonAccessible) {
                    if (defaultChannelId && defaultChannelId === voiceChannel.id) {
                        log.info(`[PlaybackState] Restauration de la connexion vocale pour la guilde ${guildId} sur le salon par défaut: ${voiceChannel.name}...`);
                    } else {
                        log.info(`[PlaybackState] Restauration de la connexion vocale pour la guilde ${guildId} sur le salon ${voiceChannel.name}...`);
                    }
                } else if (voiceChannel) {
                    log.info(`[PlaybackState] Salon « ${voiceChannel.name} » désert : `
                        + `la lecture de la guilde ${guildId} est restaurée en attente d'un auditeur.`);
                } else {
                    log.info(`[PlaybackState] Restauration de la file virtuelle pour la guilde ${guildId} (sans salon vocal)...`);
                }

                try {
                    let queue = player.queues.get(guildId);
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

                    // Stocker le cache des salons et le salon vocal actif
                    queue.channelStates = channels;
                    queue.activeChannelId = activeChannelId || null;

                    // Connexion déplacée ICI, hors de la condition activeChannelState
                    if (salonAccessible) {
                        if (queue.channel?.id !== voiceChannel.id) {
                            await queue.connect(voiceChannel);
                        }
                        // Le rattachement doit désigner le salon où le bot se
                        // trouve vraiment. La restauration a pu préférer le
                        // salon favori à celui de l'état sauvegardé, et c'est
                        // bien dans le favori que le son sortira ; laisser le
                        // rattachement sur l'autre ferait ensuite repartir la
                        // règle de présence à sa poursuite.
                        queue.activeChannelId = voiceChannel.id;
                        if (client.setupDucking) {
                            client.setupDucking(guildId);
                        }
                    } else {
                        presenceManager.marquerAbsent(queue);
                    }

                    // S'assurer que le volume du node démarre à 0 si le fade-in est activé, ou au volume cible sinon
                    const targetBaseVol = (settings.baseVolume !== undefined && settings.baseVolume !== null) ? settings.baseVolume : 100;
                    const initialQueueVol = (!estRedemarrage && settings.fadeinEnabled) ? 0 : targetBaseVol;
                    if (queue.node && typeof queue.node.setVolume === 'function') {
                        try {
                            queue.node.setVolume(initialQueueVol);
                        } catch (e) {}
                    }
                    // Le contrôleur de volume doit connaître ce point de départ :
                    // c'est lui qui pilotera le fade-in, et `queue.node.volume` ne
                    // lui répondrait pas 0 tant qu'aucun flux n'est branché.
                    const volumeControllerInitial = this._volumeControllerDe(queue);
                    if (volumeControllerInitial) {
                        volumeControllerInitial._setVolumeImmediate(initialQueueVol);
                    }

                    // En diffusion personnelle, le son sort du navigateur et non du
                    // bot : il n'y a rien à faire monter tant que le tableau de bord
                    // n'est pas ouvert. Le fade-in est donc mis en attente, et c'est
                    // le client qui le jouera à la connexion.
                    if (isPersonal && settings.fadeinEnabled && !estRedemarrage) {
                        const dureeSecondes = settings.fadeinDuration !== undefined
                            ? parseFloat(settings.fadeinDuration)
                            : 5;
                        if (dureeSecondes > 0) {
                            queue.fadeinDemarrageEnAttente = { durationMs: dureeSecondes * 1000 };
                            log.info(`[PlaybackState] Fade-in de ${dureeSecondes}s mis en attente : `
                                + 'il débutera à l\'ouverture du tableau de bord (diffusion personnelle).');
                        }
                    }

                    const activeChannelState = channels[activeChannelId];
                    if (activeChannelState) {
                        if (activeChannelState.repeatMode !== undefined) {
                            try {
                                queue.setRepeatMode(activeChannelState.repeatMode);
                            } catch (err) {
                                log.error(`[PlaybackState] Erreur restauration repeatMode pour guild ${guildId} :`, err.message);
                            }
                        }

                        // Forcer le volume à 0 temporairement si on va restaurer une piste en cours de lecture
                        const hasCurrentTrack = !!(activeChannelState.currentTrack && activeChannelState.currentTrack.title && activeChannelState.currentTrack.url);
                        if (hasCurrentTrack) {
                            try {
                                queue.node.setVolume(0);
                            } catch (err) {}
                        }

                        // Restaurer l'historique
                        if (activeChannelState.history && activeChannelState.history.length > 0) {
                            const entrees = activeChannelState.history.filter(tData => tData && tData.title && tData.url);
                            if (isPersonal) {
                                // Le lecteur virtuel range l'historique dans l'ordre
                                // même du fichier d'état : une simple recopie suffit.
                                entrees.forEach(tData => queue.virtualHistory.push(tData));
                            } else {
                                restoreHistory(queue, entrees, tData => {
                                    const track = new Track(player, tData);
                                    track.queryType = tData.queryType || null;
                                    track.raw = tData.raw || {};
                                    if (tData.extractorName) {
                                        track.extractor = player.extractors.store.get(tData.extractorName) || null;
                                    }
                                    return track;
                                });
                            }
                        }

                        // 1. Restaurer d'abord la lecture en cours (si présente)
                        if (hasCurrentTrack) {
                            const track = new Track(player, activeChannelState.currentTrack);
                            track.queryType = activeChannelState.currentTrack.queryType || null;
                            track.raw = activeChannelState.currentTrack.raw || {};
                            if (activeChannelState.currentTrack.extractorName) {
                                track.extractor = player.extractors.store.get(activeChannelState.currentTrack.extractorName) || null;
                            }

                            // Calcul du minutage en temps réel pour compenser le temps écoulé pendant le redémarrage (sans saut en arrière)
                            //
                            // La compensation vaut pour la diffusion commune, où le salon
                            // vocal a continué d'exister pendant la coupure, et pour tout
                            // redémarrage, qui laisse le tableau de bord ouvert et le
                            // navigateur en train de jouer. Elle ne vaut pas pour une
                            // extinction en diffusion personnelle : le son sort du
                            // navigateur, qui n'a rien joué tant que le bot était éteint, et
                            // avancer la position ferait manquer autant de musique.
                            //
                            // Elle ne vaut pas davantage pour une diffusion commune
                            // restaurée sans connexion : le salon est désert, la
                            // lecture est figée en attendant quelqu'un, et rien ne
                            // s'est joué non plus.
                            let calculatedProgress = activeChannelState.currentProgress || 0;
                            const savedAt = activeChannelState.savedAt;
                            const compenserArret = isPersonal ? estRedemarrage : salonAccessible;
                            if (compenserArret && !activeChannelState.isPaused && activeChannelState.isPlaying && savedAt) {
                                const elapsedSinceSave = Date.now() - savedAt;
                                if (elapsedSinceSave > 0 && elapsedSinceSave < 300000) {
                                    calculatedProgress += elapsedSinceSave;
                                    log.info(`[PlaybackState] Restauration temps réel : +${elapsedSinceSave}ms ajustées pour compenser le redémarrage (nouveau minutage: ${calculatedProgress}ms).`);
                                }
                            }

                            if (isPersonal) {
                                queue.virtualCurrentTrack = activeChannelState.currentTrack;
                                queue.virtualProgressMs = calculatedProgress;
                                queue.virtualIsPaused = activeChannelState.isPaused !== undefined ? activeChannelState.isPaused : true;
                                queue.virtualIsPlaying = activeChannelState.isPlaying !== undefined ? activeChannelState.isPlaying : false;
                                queue.virtualLastUpdated = Date.now();
                                log.info(`[PlaybackState] Restauration virtuelle terminée : ${track.title} à ${queue.virtualProgressMs}ms (pause: ${queue.virtualIsPaused})`);
                            } else if (!salonAccessible) {
                                // Pas de connexion vocale, donc pas de lecteur où
                                // remonter la piste. Elle est posée directement
                                // comme piste courante et la session tient lieu de
                                // lecteur : le tableau de bord l'affiche à sa
                                // position, et l'arrivée d'un auditeur la relancera.
                                queue.__current = track;
                                presenceManager.marquerAbsent(queue, {
                                    positionMs: calculatedProgress,
                                    enLecture: !!activeChannelState.isPlaying && !activeChannelState.isPaused
                                });
                                log.info(`[PlaybackState] Lecture figée à ${calculatedProgress}ms : `
                                    + `${track.title} reprendra à l'arrivée d'un auditeur.`);
                            } else {
                                queue.restorePaused = true;
                                queue.restoreProgress = calculatedProgress;
                                queue.restoreShouldBePaused = activeChannelState.isPaused !== undefined ? activeChannelState.isPaused : false;

                                await queue.play(track, {
                                    nodeOptions: {
                                        metadata: { channel: null },
                                        selfDeaf: false,
                                        leaveOnEmpty: false,
                                        leaveOnEmptyCooldown: 30000,
                                        leaveOnEnd: false,
                                        leaveOnEndCooldown: 60000,
                                        volume: 0 // Commencer en silence temporairement pendant le seek
                                    }
                                });
                            }
                        }

                        // 2. Restaurer ensuite la file d'attente (les morceaux suivants)
                        if (activeChannelState.queue && activeChannelState.queue.length > 0) {
                            if (isPersonal) {
                                activeChannelState.queue.forEach(tData => {
                                    if (!tData || !tData.title || !tData.url) return;
                                    queue.virtualTracks.push(tData);
                                });
                            } else {
                                const resolvedTracks = [];
                                activeChannelState.queue.forEach(tData => {
                                    if (!tData || !tData.title || !tData.url) return;
                                    const track = new Track(player, tData);
                                    track.queryType = tData.queryType || null;
                                    track.raw = tData.raw || {};
                                    if (tData.extractorName) {
                                        track.extractor = player.extractors.store.get(tData.extractorName) || null;
                                    }
                                    resolvedTracks.push(track);
                                });
                                if (resolvedTracks.length > 0) {
                                    queue.addTrack(resolvedTracks);
                                }
                            }
                        }
                    }
                } catch (restErr) {
                    log.error(`[PlaybackState] Erreur de restauration pour la guilde ${guildId} :`, restErr.message);
                    // S'assurer de restaurer le volume et désactiver le flag en cas d'erreur de restauration
                    try {
                        const settings = require('./Database').getSettings(guildId);
                        const queue = player.queues.get(guildId);
                        if (queue) {
                            queue.node.setVolume(settings.baseVolume);
                            queue.restorePaused = false;
                        }
                    } catch (volErr) {}
                }
            }
        } catch (err) {
            log.error('[PlaybackState] Erreur globale lors de la restauration :', err.message);
        }
    }
}

module.exports = new PlaybackStateManager();
