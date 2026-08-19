const { Track } = require('discord-player');
const database = require('../database/Database');
const playbackStateManager = require('../database/PlaybackStateManager');
const embeds = require('../utils/embeds');
const webServer = require('../web/WebServer');
const { activeEngine } = require('./mix');
const { applySpeed } = require('./playbackSettings');
const log = require('../utils/logger');

/** Délai au-delà duquel on cesse d'attendre le rattrapage du seeker PCM. */
const MAX_SEEK_CATCH_UP_MS = 8000;

/**
 * Temps laissé à la chaîne DSP pour se mettre en place avant de repositionner.
 *
 * Le transformateur de seek refuse tout repositionnement tant qu'il ignore la
 * durée du morceau (`totalDuration` à 0) — et il l'apprend d'un événement émis
 * après le démarrage du flux. Les pistes reconstruites depuis un état sauvegardé
 * sont justement dans ce cas : elles ne portent qu'une durée textuelle, pas de
 * `durationMS`. Sans cette attente, le seek serait silencieusement ignoré et la
 * lecture resterait au début du morceau.
 */
const DSP_SETUP_DELAY_MS = 100;

/** Petite pause utilitaire. */
const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Attend que le repositionnement demandé soit réellement atteint.
 *
 * `queue.node.seek()` rend la main aussitôt : sur un flux en pipe, il se contente
 * d'armer le transformateur de seek de la chaîne DSP, qui jettera ensuite les
 * échantillons au fil de leur arrivée jusqu'à la position visée. Rendre le son
 * sans attendre ce rattrapage revient à diffuser le début du morceau — c'est
 * précisément ce qu'on cherche à éviter lors d'un changement de mode.
 *
 * Le transformateur remet sa cible à `null` une fois celle-ci atteinte : c'est
 * le signal qu'on guette. En l'absence de transformateur, `seek()` a reconstruit
 * le flux de façon synchrone et il n'y a rien à attendre.
 *
 * @param {import('discord-player').GuildQueue} queue
 * @returns {Promise<void>}
 */
function awaitSeekCatchUp(queue) {
    const seeker = queue?.filters?.seeker;
    if (!seeker || seeker.seekTarget === null) return Promise.resolve();

    return new Promise(resolve => {
        const deadline = Date.now() + MAX_SEEK_CATCH_UP_MS;
        const pollTimer = setInterval(() => {
            const stillSeeking = queue?.filters?.seeker === seeker && seeker.seekTarget !== null;
            if (!stillSeeking) {
                clearInterval(pollTimer);
                resolve();
                return;
            }
            if (Date.now() >= deadline) {
                clearInterval(pollTimer);
                log.warn('[Player] Rattrapage de position toujours incomplet après '
                    + `${MAX_SEEK_CATCH_UP_MS}ms : rétablissement du son malgré tout.`);
                resolve();
            }
        }, 20);
    });
}

function clearTransition(queue) {
    if (!queue) return;
    if (queue.transitionTimeout) {
        clearTimeout(queue.transitionTimeout);
        queue.transitionTimeout = null;
    }
    queue.isPendingTransition = false;
}

function registerPlayerEvents(player, client) {
    // --- Player Events ---

    player.events.on('playerStart', (queue, track) => {
        clearTransition(queue);
        queue.isMixFadingOut = false;
        queue.trackStartedAt = Date.now();
        const guildId = queue.guild.id;
        const metadata = queue.metadata;

        // Synchroniser playlistCurrentIndex et la file d'attente réelle
        const settings = database.getSettings(guildId);
        if (settings.activePlaybackSource && settings.activePlaybackSource !== 'queue' && !queue.transitioningToEveryone) {
            const globalPlaylists = database.getGlobalPlaylists();
            const playlist = globalPlaylists.find(p => p.id === settings.activePlaybackSource);
            if (playlist && playlist.tracks) {
                const trackIdx = playlist.tracks.findIndex(t => t.url === track.url);
                if (trackIdx !== -1 && (trackIdx !== settings.playlistCurrentIndex || queue.tracks.size === 0)) {
                    database.updateSettings(guildId, { playlistCurrentIndex: trackIdx });
                    
                    const subsequentTracks = playlist.tracks.slice(trackIdx + 1);
                    queue.tracks.clear();
                    if (subsequentTracks.length > 0) {
                        const resolvedTracks = subsequentTracks.map(t => {
                            const trk = new Track(player, {
                                title: t.title,
                                author: t.author || 'Inconnu',
                                duration: t.duration || '0:00',
                                thumbnail: t.thumbnail || null,
                                url: t.url,
                                queryType: t.queryType || 'youtube',
                                raw: t.raw || {}
                            });
                            if (t.extractorName) {
                                trk.extractor = player.extractors.store.get(t.extractorName) || null;
                            }
                            return trk;
                        });
                        queue.addTrack(resolvedTracks);
                    }
                }
            }
        }

        log.info(`[Player] ▶ En lecture : ${track.title} (${guildId})`);

        // Check if we should pause immediately (e.g. from Stop command or server restoration)
        if (queue.pauseOnNextTrack || queue.restorePaused) {
            queue.pauseOnNextTrack = false;
            try {
                queue.node.setPaused(true);
            } catch (err) {
                log.error('[Player] Erreur mise en pause automatique :', err.message);
            }
        }

        // Setup ducking on track start
        if (client.setupDucking) {
            client.setupDucking(guildId);
        }

        // Repositionnement et restauration du volume après une transition vers
        // "everyone".
        //
        // Le flux démarre nécessairement au début du morceau : passer la position
        // à sa création ne sert à rien ici, car les extracteurs fournissent un
        // flux en pipe, pour lequel discord-player place le `-ss` après le `-i`
        // — un seek de sortie, qui décode tout depuis le début de toute façon.
        //
        // On repositionne donc le lecteur, mais sans rien laisser paraître :
        // le volume reste à 0 et l'interface continue d'afficher la position
        // cible tant que le drapeau de transition est levé. Le rattrapage se
        // fait ainsi en silence, sans retour visible à 0:00.
        if (queue.transitioningToEveryone) {
            const progress = queue.transitionTargetProgress || 0;

            (async () => {
                try {
                    const settings = database.getSettings(guildId);

                    if (progress > 0) {
                        await pause(DSP_SETUP_DELAY_MS);
                        log.info(`[Player] Repositionnement de transition : ${progress}ms`);
                        await queue.node.seek(progress);
                        await awaitSeekCatchUp(queue);
                    }

                    // Filet de sécurité : la piste qui reprend sa lecture n'a rien à
                    // faire dans l'historique. La comparaison porte sur l'URL et non
                    // sur l'identifiant — celui-ci est régénéré à chaque `new Track`,
                    // si bien qu'une piste reconstruite depuis un état sauvegardé
                    // n'était jamais reconnue.
                    if (queue.currentTrack) {
                        try {
                            const currentUrl = queue.currentTrack.url;
                            queue.history.tracks.remove(t => t.url === currentUrl);
                            log.info('[Player] Piste courante nettoyée de l\'historique post-transition.');
                        } catch (e) {}
                    }
                    
                    // Retirer de la file d'attente la piste actuelle si elle y est présente par erreur (doublon de transition)
                    if (queue.currentTrack) {
                        try {
                            const duplicate = queue.tracks.toArray().find(t => t.url === queue.currentTrack.url);
                            if (duplicate) {
                                queue.node.remove(duplicate);
                                log.info('[Player] Piste courante nettoyée de la file d\'attente post-seek.');
                            }
                        } catch (e) {}
                    }
                    
                    // Fin de la transition. La progression de repli n'est remise à
                    // zéro qu'ici : tant que le drapeau est levé, c'est elle que
                    // l'interface affiche, et l'annuler plus tôt y faisait
                    // apparaître un retour à 0:00 le temps du basculement.
                    queue.transitioningToEveryone = false;
                    queue.transitionTargetProgress = 0;
                    queue.transitionTrack = null;

                    // Le flux démarre volontairement à 0 pour éviter toute fuite
                    // sonore : il faut donc toujours rétablir le volume ici. Pas de
                    // fondu — `fadeinEnabled` ne concerne que le démarrage du bot.
                    queue.node.setVolume(settings.baseVolume);

                    if (queue.restorePaused) {
                        queue.node.setPaused(true);
                        queue.restorePaused = false;
                        log.info('[Player] Pause et volume restaurés après transition.');
                    } else {
                        log.info(`[Player] Volume rétabli à ${settings.baseVolume}% après transition.`);
                    }
                } catch (seekErr) {
                    log.error('[Player] Erreur restauration transition dans playerStart :', seekErr.message);
                    queue.transitioningToEveryone = false;
                    queue.transitionTargetProgress = 0;
                    queue.restorePaused = false;
                }
            })();
        }

        // Vitesse de lecture mémorisée, à réappliquer sur la nouvelle piste.
        //
        // Sur le bus de mixage, elle est déjà celle du décodeur qui vient
        // d'ouvrir le morceau : `appliquerVitesse` le constate et n'y touche
        // pas. L'appel ne sert donc qu'au chemin d'origine de discord-player,
        // qui monte une chaîne de filtres neuve à chaque piste.
        try {
            const settings = database.getSettings(guildId);
            if (settings.playbackSpeed) {
                applySpeed(queue, settings.playbackSpeed);
            }
        } catch (speedErr) {
            log.error('[Player] Erreur application de la vitesse au démarrage :', speedErr.message);
        }

        // Fondu d'entrée de l'effet Mix DJ, à chaque piste.
        //
        // `fadeinEnabled` n'entre volontairement pas en compte : ce réglage-là
        // ne vaut que pour le démarrage du bot (cf. PlaybackStateManager), et
        // le prendre en compte ici rejouait le fondu à chaque morceau.
        //
        // Le bus de mixage mène ses propres fondus, source par source : il sait
        // distinguer un morceau qui démarre seul — qui entre en fondu — de
        // celui qu'un enchaînement vient d'amener à plein volume, alors qu'ici
        // les deux cas se ressemblent. En diffusion commune, on le laisse donc
        // faire, sous peine de voir le morceau entrant retomber à zéro juste
        // après avoir fini de monter.
        try {
            const settings = database.getSettings(guildId);
            const fadeinEnabled = !!settings.mixEnabled;
            const fadeinDurationMs = (parseFloat(settings.mixDuration) || 5) * 1000;

            if (fadeinEnabled && !activeEngine(queue) && !queue.restorePaused && !queue.transitioningToEveryone) {
                if (queue.mixAppliedTrackId !== track.id) {
                    queue.mixAppliedTrackId = track.id;

                    queue.node.setVolume(0);

                    if (settings.mixEnabled && settings.mixType === 'effects') {
                        const enabled = queue.filters.ffmpeg.getFiltersEnabled();
                        if (!enabled.includes('muffled')) {
                            queue.filters.ffmpeg.setFilters([...enabled, 'muffled']);
                        }
                    }

                    const duckingManager = client.duckingManagers.get(guildId);
                    if (duckingManager && duckingManager.volumeController) {
                        duckingManager.volumeController._fadeTo(settings.baseVolume, fadeinDurationMs);
                    } else {
                        let currentStep = 0;
                        const steps = 30;
                        const interval = Math.max(20, Math.round(fadeinDurationMs / steps));
                        const timer = setInterval(() => {
                            currentStep++;
                            const progress = currentStep / steps;
                            const vol = Math.round(settings.baseVolume * Math.pow(progress, 2));
                            try { queue.node.setVolume(vol); } catch (e) {}
                            if (currentStep >= steps) clearInterval(timer);
                        }, interval);
                    }

                    if (settings.mixEnabled && settings.mixType === 'effects') {
                        setTimeout(() => {
                            try {
                                const enabled = queue.filters.ffmpeg.getFiltersEnabled();
                                queue.filters.ffmpeg.setFilters(enabled.filter(f => f !== 'muffled'));
                            } catch (e) {}
                        }, fadeinDurationMs);
                    }
                }
            }
        } catch (mixErr) {
            log.error('[Player] Erreur fade-in dans playerStart :', mixErr.message);
        }

        // Notify Web UI
        webServer.broadcastState(guildId);

        // Sauvegarder l'état
        playbackStateManager.saveState(queue.player);

        // Send now playing message
        if (metadata?.channel || metadata?.followUp) {
            const embed = embeds.nowPlaying({
                title: track.title,
                author: track.author,
                duration: track.duration,
                thumbnail: track.thumbnail,
                source: track.source || 'Inconnu',
            });

            const channel = metadata.channel || metadata;
            if (channel.send) {
                channel.send({ embeds: [embed] }).catch(() => {});
            }
        }
    });

    player.events.on('audioTrackAdd', (queue, track) => {
        log.info(`[Player] + Ajouté : ${track.title}`);
        webServer.broadcastState(queue.guild.id);
        playbackStateManager.saveState(queue.player);
    });

    player.events.on('playerFinish', (queue) => {
        clearTransition(queue);
        queue.mixAppliedTrackId = null;
        log.info(`[Player] ⏹ Lecture terminée.`);
        webServer.broadcastState(queue.guild.id);
        playbackStateManager.saveState(queue.player);
    });

    player.events.on('emptyQueue', (queue) => {
        clearTransition(queue);
        queue.mixAppliedTrackId = null;
        log.info(`[Player] 📋 File d'attente vide.`);

        // Playlist en boucle : la file vide signe la fin de la playlist, pas
        // la fin de la lecture. On la recharge depuis son premier titre avant
        // de démonter le ducking et la connexion vocale.
        if (webServer.restartLoopedPlaylist(queue.guild.id)) return;

        // Playlist achevée sans bouclage : ce que la file d'attente gardait de
        // côté pendant sa lecture prend la main, plutôt que de rester en plan
        // sous les yeux de l'utilisateur.
        if (webServer.advanceToQueue(queue.guild.id)) return;

        // Le ducking n'est pas démonté ici, et ne l'était que dans un seul mode
        // de diffusion. C'est pourtant lui qui porte l'écoute de la parole : le
        // tableau de bord cessait d'animer les auditeurs dès la dernière piste
        // finie, alors que le bot était toujours dans le salon — et seulement en
        // diffusion commune, ce que rien ne justifiait. Un volume resté baissé
        // ne s'en relevait pas davantage, faute de quelqu'un pour l'entendre.
        //
        // L'écoute vit désormais avec la connexion vocale, pas avec la file :
        // `detacher()` la démonte au départ du salon, l'arrêt du bot aussi.
        webServer.broadcastState(queue.guild.id);
        playbackStateManager.saveState(queue.player);
    });

    // `emptyChannel` n'est plus émis : le PresenceManager a pris la main sur le
    // gestionnaire d'état vocal de discord-player, et mène lui-même le départ
    // du salon vide — en préservant la lecture, ce que le comportement par
    // défaut ne faisait pas.

    player.events.on('playerError', (queue, error, track) => {
        clearTransition(queue);
        queue.mixAppliedTrackId = null;
        log.error(`[Player] ❌ Erreur playerError:`, error.message);
        log.error(`[Player] Track:`, track?.title);
        log.error(`[Player] Stack:`, error.stack);
    });

    player.events.on('error', (queue, error) => {
        clearTransition(queue);
        queue.mixAppliedTrackId = null;
        log.error(`[Player] ❌ Erreur générale :`, error.message);
        log.error(`[Player] Stack:`, error.stack);
    });

    player.events.on('debug', (queue, message) => {
        log.debug(`[Player Debug] ${message}`);
    });

    player.on('debug', (message) => {
        log.debug(`[Player Core Debug] ${message}`);
    });
}

module.exports = { registerPlayerEvents };
