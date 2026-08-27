/**
 * PresenceManager — le bot ne s'installe dans un salon vocal que s'il y a
 * quelqu'un pour l'entendre.
 *
 * ## Le principe
 *
 * Trois règles, appliquées par guilde :
 *
 * 1. Au démarrage, aucune connexion vocale n'est établie si le salon visé est
 *    désert. La lecture est restaurée tout de même, mais figée.
 * 2. Dès qu'un humain entre dans le salon rattaché à la guilde, le bot l'y
 *    rejoint et reprend la lecture là où elle s'était arrêtée.
 * 3. Dès que le dernier humain le quitte, le bot s'en va — après un court délai
 *    de grâce, pour ne pas faire l'aller-retour sur une déconnexion passagère.
 *
 * ## La lecture figée
 *
 * Partir ne veut pas dire tout perdre : la file d'attente, l'historique et la
 * piste courante restent en mémoire, intacts. Seul le lecteur de discord-player
 * disparaît avec la connexion vocale, et avec lui la seule chose qu'il savait
 * encore : où en était la lecture. La session prend le relais le temps de
 * l'absence (`positionFigeeMs`, `lectureFigeeEnCours`) ; le tableau de bord et
 * la sauvegarde d'état lisent ces deux valeurs au lieu d'interroger un lecteur
 * démonté, et le retour les rejoue.
 *
 * Détruire la connexion demande une précaution : discord-player voit le flux
 * s'arrêter, le prend pour une fin de piste et enchaîne sur la suivante. Le
 * mode « transition » est donc levé le temps de la destruction, ce qui lui fait
 * ignorer cette fin de flux.
 *
 * ## Prise en main du gestionnaire d'état vocal
 *
 * S'abonner à `voiceStateUpdate` sur le player désactive celui de
 * discord-player, dont le comportement par défaut est incompatible : il détruit
 * la file entière (`queue.delete()`) quand le salon se vide ou quand le bot en
 * sort, emportant la file d'attente, l'historique et l'état par salon. Les
 * quelques cas utiles qu'il traitait — sourdine serveur, scène, déplacement du
 * bot par un modérateur — sont repris ici.
 */

const { ChannelType } = require('discord.js');
const config = require('../config');
const database = require('../database/Database');
const log = require('../utils/logger');

/** Un salon vocal compte-t-il au moins un humain ? */
function isInhabited(channel) {
    if (!channel || !channel.members) return false;
    return channel.members.filter(m => !m.user.bot).size > 0;
}

class PresenceManager {
    constructor() {
        this.client = null;
        this.player = null;
        /** @type {Map<string, NodeJS.Timeout>} guildId → départ programmé */
        this.scheduledDepartures = new Map();
        /** @type {Set<string>} guildes dont la connexion est en cours de bascule */
        this.switchesInProgress = new Set();
    }

    /** La règle de présence est-elle active ? */
    get active() {
        return config.presence.enabled !== false;
    }

    /**
     * @param {import('discord.js').Client} client
     * @param {import('discord-player').Player} player
     */
    init(client, player) {
        this.client = client;
        this.player = player;

        // Prend la main sur le gestionnaire d'état vocal de discord-player
        // (cf. en-tête). Il n'est appelé que lorsque le bot est connecté ;
        // l'arrivée de quelqu'un alors qu'il est absent passe, elle, par
        // l'écouteur de client dans index.js.
        player.events.on('voiceStateUpdate', (queue, oldState, newState) => {
            try {
                this._trackBotVoiceState(queue, oldState, newState);
            } catch (err) {
                log.error('[Presence] Voice state tracking error:', err.message);
            }
        });

        // Toute connexion vocale, d'où qu'elle vienne — commande /play, import
        // de fichier, sélection de salon —, met fin au gel : le lecteur existe
        // de nouveau et redevient la source de vérité.
        player.events.on('connection', (queue) => {
            queue.absentEmptyChannel = false;

            // L'écoute de la parole se monte ici plutôt qu'à chaque appelant.
            // Elle était jusqu'ici accrochée au démarrage d'une piste, si bien
            // qu'en diffusion personnelle — où le son sort du navigateur et où
            // aucune piste ne démarre côté bot — une connexion établie par la
            // commande /play ou un import restait sourde : le tableau de bord
            // n'animait personne. Elle appartient à la connexion, pas à la
            // lecture, et vaut donc pour les deux modes.
            try {
                this.client?.setupDucking?.(queue.guild.id);
            } catch (err) {
                log.error('[Presence] Error starting speech detection:', err.message);
            }
        });
    }

    isInhabited(channel) {
        return isInhabited(channel);
    }

    /**
     * Le bot a-t-il le droit de s'installer maintenant dans ce salon ?
     *
     * Consulté par les points de connexion du projet — restauration au
     * démarrage, sélection de salon, lancement d'une lecture — pour ne pas
     * entrer dans un salon désert.
     *
     * @param {import('discord.js').VoiceBasedChannel|null|undefined} channel
     * @returns {boolean}
     */
    connectionAllowed(channel) {
        if (!channel) return false;
        if (!this.active) return true;
        return isInhabited(channel);
    }

    /**
     * Salon vocal auquel le bot est rattaché pour cette guilde.
     *
     * Le rattachement en cours (`activeChannelId`) prime : c'est la dernière
     * volonté exprimée, et c'est ce que le tableau de bord écrit en changeant de
     * salon. Viennent ensuite le salon où le bot se trouve, puis le dernier
     * salon visité — trois façons de dire « celui qu'on lui a désigné », de la
     * plus récente à la plus ancienne.
     *
     * Le salon favori n'y figure pas, et c'est essentiel. Consulté ici, il
     * s'appliquait à chaque mouvement vocal et toutes les 30 secondes : dès que
     * le rattachement manquait — file créée par la commande `/play`, par un
     * import, ou restaurée sans salon —, il ramenait le bot chez lui, et le
     * premier auditeur entrant dans le favori l'y rappelait quel que soit le
     * salon où on l'avait installé. Le favori ne vaut qu'au démarrage, où
     * `Database.appliquerSalonFavori()` en fait le salon courant une fois pour
     * toutes ; la restauration d'état l'inscrit ensuite comme rattachement, et
     * c'est à ce titre — et non comme favori — qu'il est retrouvé ici.
     *
     * @param {string} guildId
     * @returns {import('discord.js').VoiceBasedChannel|null}
     */
    assignedChannel(guildId) {
        const guild = this.client?.guilds?.cache?.get(guildId);
        if (!guild) return null;

        const settings = database.getSettings(guildId);
        const queue = this.player?.queues?.get(guildId);

        const candidates = [
            queue?.activeChannelId,
            queue?.channel?.id,
            settings.lastVoiceChannelId,
        ];

        for (const id of candidates) {
            if (!id) continue;
            const channel = guild.channels.cache.get(id);
            if (channel?.isVoiceBased?.()) return channel;
        }
        return null;
    }

    /**
     * Décide de l'arrivée ou du départ du bot sur une guilde.
     *
     * Appelée à chaque mouvement vocal, y compris quand le bot n'est connecté
     * nulle part — c'est justement le cas où il doit décider d'arriver.
     *
     * @param {string} guildId
     */
    evaluate(guildId) {
        if (!this.active || !guildId) return;
        if (this.switchesInProgress.has(guildId)) return;

        const queue = this.player?.queues?.get(guildId);
        const currentChannel = queue?.connection ? queue.channel : null;

        if (currentChannel) {
            if (isInhabited(currentChannel)) {
                this._cancelDeparture(guildId);
            } else {
                this._scheduleDeparture(guildId);
            }
            return;
        }

        this._cancelDeparture(guildId);
        if (!queue) return;

        const target = this.assignedChannel(guildId);
        if (target) {
            if (isInhabited(target)) this._joinInBackground(guildId, target);
            return;
        }

        // Aucun salon rattaché : première utilisation sur cette guilde. Le bot
        // se pose là où quelqu'un vient d'apparaître plutôt que de rester
        // introuvable en attendant une sélection depuis le tableau de bord.
        const guild = this.client?.guilds?.cache?.get(guildId);
        const spontaneous = guild?.channels?.cache
            ?.filter(c => c.type === ChannelType.GuildVoice && isInhabited(c))
            ?.first();
        if (spontaneous) this._joinInBackground(guildId, spontaneous);
    }

    _joinInBackground(guildId, channel) {
        this.join(guildId, channel).catch(err => {
            log.error('[Presence] Error on arrival in the channel:', err.message);
        });
    }

    /**
     * Fige la lecture d'une file restée hors du salon.
     *
     * Appelée par les points de connexion qui renoncent à se connecter : c'est
     * ce drapeau qui fera reprendre la lecture au retour du bot.
     *
     * @param {import('discord-player').GuildQueue} queue
     * @param {object} [state] Position et état de lecture à mémoriser.
     */
    markAbsent(queue, state = {}) {
        if (!queue) return;
        queue.absentEmptyChannel = true;
        if (state.positionMs !== undefined) queue.frozenPositionMs = state.positionMs;
        if (state.playing !== undefined) queue.frozenIsPlaying = !!state.playing;
    }

    /**
     * Lève l'absence : le bot est dans le salon, c'est son lecteur qui fait foi.
     * @param {import('discord-player').GuildQueue} queue
     */
    _markPresent(queue) {
        if (!queue || !queue.absentEmptyChannel) return;
        queue.absentEmptyChannel = false;
        queue.frozenPositionMs = 0;
        queue.frozenIsPlaying = false;
    }

    // ─── Arrivée ──────────────────────────────────────────────────────────

    /**
     * Installe le bot dans un salon et y reprend la lecture figée.
     *
     * @param {string} guildId
     * @param {import('discord.js').VoiceBasedChannel} channel
     */
    async join(guildId, channel) {
        const queue = this.player?.queues?.get(guildId);
        if (!queue || !channel) return;
        if (queue.connection && queue.channel?.id === channel.id) {
            // Le bot y est déjà : il n'y a rien à rejoindre, mais l'absence a
            // pu être déclarée sans que la connexion ne tombe — un changement
            // de mode de diffusion sur un salon alors désert, par exemple. La
            // laisser inscrite figerait la position affichée par le tableau de
            // bord sur celle du départ, pendant que le son avance.
            this._markPresent(queue);
            return;
        }
        if (this.switchesInProgress.has(guildId)) return;

        this.switchesInProgress.add(guildId);
        try {
            log.info(`[Presence] Someone arrived in « ${channel.name} »: the bot is connecting.`);
            await queue.connect(channel);
            queue.activeChannelId = channel.id;

            if (this.client?.setupDucking) {
                this.client.setupDucking(guildId);
            }

            const settings = database.getSettings(guildId);
            if (settings.broadcastMode === 'personal') {
                // Le son sort du navigateur : la connexion ne sert qu'à capter
                // la parole pour le ducking, et le flux UDP doit être alimenté
                // pour ne pas se refermer.
                this.client?.startSilencePlayer?.(queue);
            } else {
                await this._resumePlayback(queue);
            }

            this._markPresent(queue);
        } finally {
            this.switchesInProgress.delete(guildId);
        }

        this._notify(guildId);
    }

    /**
     * Remonte la piste figée dans le lecteur fraîchement reconnecté.
     *
     * La file et l'historique n'ont pas bougé : seule la piste courante doit
     * être relancée, à la position où le départ l'avait laissée.
     *
     * @param {import('discord-player').GuildQueue} queue
     */
    async _resumePlayback(queue) {
        const frozenTrack = queue.currentTrack;

        if (!frozenTrack) {
            if (queue.tracks.size > 0) {
                try {
                    await queue.node.play();
                } catch (err) {
                    log.error('[Presence] Error starting the queue:', err.message);
                }
            }
            return;
        }

        // Mêmes drapeaux que la transition personnel → commun : démarrage muet,
        // repositionnement en silence, puis rétablissement du volume — le tout
        // piloté par `playerStart` dans PlayerEvents.
        queue.transitioningToEveryone = true;
        queue.transitionTargetProgress = queue.frozenPositionMs || 0;
        queue.transitionTrack = frozenTrack;
        queue.restorePaused = !queue.frozenIsPlaying;

        try {
            queue.node.setVolume(0);
        } catch (e) {}

        try {
            // Lecture directe plutôt que `queue.play()` : celle-ci ferait passer
            // la piste par la file d'attente, où elle se rangerait derrière les
            // titres suivants au lieu de démarrer.
            await queue.node.play(frozenTrack, { queue: false });
        } catch (err) {
            log.error('[Presence] Error resuming playback:', err.message);
            queue.transitioningToEveryone = false;
            queue.transitionTrack = null;
            queue.transitionTargetProgress = 0;
            queue.restorePaused = false;
        }
    }

    // ─── Départ ───────────────────────────────────────────────────────────

    /**
     * Délai de grâce avant de quitter un salon vidé, en millisecondes.
     *
     * Réglé par serveur depuis le tableau de bord, où il s'exprime en secondes ;
     * `config.presence.departureDelay` sert de repli quand rien n'a été choisi.
     * Zéro est une valeur recevable — un départ sans délai —, ce qui interdit
     * le `||` habituel : il ferait retomber sur le repli de 30 s.
     *
     * @param {string} guildId
     * @returns {number}
     */
    _departureDelayMs(guildId) {
        const seconds = Number(database.getSettings(guildId)?.presenceDepartureDelay);
        if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
        return config.presence.departureDelay;
    }

    _scheduleDeparture(guildId) {
        if (this.scheduledDepartures.has(guildId)) return;

        const delay = this._departureDelayMs(guildId);
        const queue = this.player?.queues?.get(guildId);
        log.info(`[Presence] Channel « ${queue?.channel?.name || '?'} » empty: `
            + `the bot leaves in ${Math.round(delay / 1000)}s.`);

        const timer = setTimeout(() => {
            this.scheduledDepartures.delete(guildId);
            this.leave(guildId).catch(err => {
                log.error('[Presence] Error on leaving the channel:', err.message);
            });
        }, delay);
        if (timer.unref) timer.unref();

        this.scheduledDepartures.set(guildId, timer);
    }

    /**
     * Réarme un départ déjà programmé sur le délai courant.
     *
     * Changer le délai depuis le tableau de bord doit valoir tout de suite, y
     * compris pour un compte à rebours en cours : sans cela, le nouveau réglage
     * n'aurait d'effet qu'au prochain salon vidé. Sans départ en attente, il n'y
     * a rien à réarmer.
     *
     * @param {string} guildId
     */
    rescheduleDeparture(guildId) {
        const timer = this.scheduledDepartures.get(guildId);
        if (!timer) return;
        clearTimeout(timer);
        this.scheduledDepartures.delete(guildId);
        this.evaluate(guildId);
    }

    _cancelDeparture(guildId) {
        const timer = this.scheduledDepartures.get(guildId);
        if (!timer) return;
        clearTimeout(timer);
        this.scheduledDepartures.delete(guildId);
        log.info('[Presence] Someone is here: the bot no longer leaves.');
    }

    /**
     * Retire le bot d'un salon devenu vide, en préservant la lecture.
     * @param {string} guildId
     */
    async leave(guildId) {
        const queue = this.player?.queues?.get(guildId);
        if (!queue?.dispatcher) return;

        const leavingChannel = queue.channel;
        if (isInhabited(leavingChannel)) return; // quelqu'un est revenu entre-temps

        log.info(`[Presence] Channel « ${leavingChannel?.name || '?'} » still empty: the bot withdraws.`);
        this.withdraw(guildId);
    }

    /**
     * Coupe la connexion vocale en figeant la lecture en cours.
     *
     * Distinct de `quitter()` : celui-ci vérifie d'abord que le salon est bien
     * vide, alors qu'un changement de salon depuis le tableau de bord veut le
     * retrait quoi qu'il arrive.
     *
     * @param {string} guildId
     */
    withdraw(guildId) {
        const queue = this.player?.queues?.get(guildId);
        if (!queue?.dispatcher) return;

        // Relever la position pendant que le lecteur sait encore répondre.
        let positionMs = 0;
        let playing = false;
        try {
            positionMs = queue.node.getTimestamp()?.current?.value || 0;
            playing = queue.node.isPlaying();
        } catch (e) {}
        this.markAbsent(queue, { positionMs, playing });

        this.detach(guildId);
        this._notify(guildId);
    }

    /**
     * Coupe la connexion vocale, sans rien présumer de ce que devient la file.
     *
     * L'appelant qui s'apprête à charger un autre salon veut ce découplage :
     * geler la lecture en cours et la sauvegarder ici écraserait l'état du
     * salon qu'il vient de désigner.
     *
     * @param {string} guildId
     */
    detach(guildId) {
        const queue = this.player?.queues?.get(guildId);
        if (!queue?.dispatcher) return;

        // Démonter l'écoute de la parole et le diffuseur de silence, tous deux
        // accrochés à la connexion qui va disparaître.
        if (this.client?.cleanupDucking) {
            this.client.cleanupDucking(guildId);
        }

        // Couper la connexion sans que la file avance. Le mode transition fait
        // ignorer à discord-player la fin de flux que provoque la destruction :
        // sans lui, il enchaînerait sur la piste suivante et pousserait la
        // courante dans l'historique.
        const wasTransitioning = queue.isTransitioning();
        queue.setTransitioning(true);
        try {
            queue.dispatcher.destroy();
        } finally {
            queue.setTransitioning(wasTransitioning);
        }

        // La lecture reprendra depuis l'état figé : les drapeaux d'une
        // transition inachevée n'ont plus lieu d'être.
        queue.transitioningToEveryone = false;
        queue.transitionTrack = null;
        queue.transitionTargetProgress = 0;
        queue.isPendingTransition = false;
    }

    // ─── Points de connexion du projet ────────────────────────────────────

    /**
     * Connecte le bot au salon demandé, ou fige la file si le salon est désert.
     *
     * Point de passage unique des endroits qui lançaient jusqu'ici un
     * `queue.connect()` direct : lancement d'une lecture, sélection de salon,
     * import de fichier. Le retour dit si le bot est en mesure de jouer.
     *
     * @param {import('discord-player').GuildQueue} queue
     * @param {import('discord.js').VoiceBasedChannel} voiceChannel
     * @returns {Promise<boolean>}
     */
    async connectIfInhabited(queue, voiceChannel) {
        if (!queue || !voiceChannel) return false;
        const guildId = queue.guild.id;

        if (!this.connectionAllowed(voiceChannel)) {
            log.info(`[Presence] Channel « ${voiceChannel.name} » deserted: `
                + 'playback will wait for a listener.');
            if (queue.connection) this.withdraw(guildId);
            else this.markAbsent(queue);
            return false;
        }

        if (!queue.connection || queue.channel?.id !== voiceChannel.id) {
            await queue.connect(voiceChannel);
        }
        queue.absentEmptyChannel = false;
        return true;
    }

    /**
     * Applique une commande de lecture à une file figée.
     *
     * Le tableau de bord reste utilisable pendant l'absence du bot : ce qu'on y
     * demande façonne l'état que la reprise jouera. Sans cela, ces commandes
     * s'adresseraient à un lecteur démonté et se perdraient en silence.
     *
     * @param {import('discord-player').GuildQueue} queue
     * @param {'pause'|'resume'|'stop'|'skip'|'previous'|'seek'} action
     * @param {number} [valeur] Position visée, pour `seek`.
     * @returns {boolean} true si la commande a été absorbée par l'état figé
     */
    applyFrozenCommand(queue, action, value = 0) {
        if (!queue?.session?.isFrozen()) return false;

        switch (action) {
            case 'pause':
                queue.frozenIsPlaying = false;
                break;
            case 'resume':
                queue.frozenIsPlaying = true;
                break;
            case 'stop':
                queue.frozenIsPlaying = false;
                queue.frozenPositionMs = 0;
                break;
            case 'seek':
                queue.frozenPositionMs = Math.max(0, value || 0);
                break;
            case 'skip': {
                if (queue.currentTrack) queue.history.push(queue.currentTrack);
                queue.__current = queue.tracks.dispatch() || null;
                queue.frozenPositionMs = 0;
                break;
            }
            case 'previous': {
                const previous = queue.history.tracks.dispatch();
                if (!previous) return true;
                if (queue.currentTrack) queue.insertTrack(queue.currentTrack, 0);
                queue.__current = previous;
                queue.frozenPositionMs = 0;
                break;
            }
            default:
                return false;
        }
        return true;
    }

    /**
     * Recharge la file depuis l'instantané d'un salon, sans s'y connecter.
     *
     * Le pendant figé de la bascule de salon : le tableau de bord a désigné un
     * salon désert, la file doit donc en montrer le contenu — et l'avoir prêt
     * à jouer — sans que le bot s'y installe.
     *
     * @param {import('discord-player').GuildQueue} queue
     * @param {string} channelId
     */
    loadFrozenState(queue, channelId) {
        const { Track } = require('discord-player');
        const { restoreHistory } = require('../utils/historyOrder');

        const player = this.player;
        const toTrack = (data) => {
            const track = new Track(player, data);
            track.queryType = data.queryType || null;
            track.raw = data.raw || {};
            if (data.extractorName) {
                track.extractor = player.extractors.store.get(data.extractorName) || null;
            }
            return track;
        };
        const usable = (t) => !!(t && t.title && t.url);

        const snapshot = queue.channelStates?.[channelId];

        queue.tracks.clear();
        queue.history.clear();
        // `currentTrack` retombe sur `__current` faute de flux : c'est là qu'il
        // faut poser la piste tant qu'aucun lecteur n'existe pour la porter.
        queue.__current = usable(snapshot?.currentTrack)
            ? toTrack(snapshot.currentTrack)
            : null;

        const upcoming = (snapshot?.queue || []).filter(usable);
        if (upcoming.length > 0) queue.addTrack(upcoming.map(toTrack));

        restoreHistory(
            queue,
            (snapshot?.history || []).filter(usable),
            toTrack,
            queue.__current?.url || null
        );

        try {
            queue.setRepeatMode(snapshot?.repeatMode || 0);
        } catch (e) {}

        this.markAbsent(queue, {
            positionMs: snapshot?.currentProgress || 0,
            playing: !!snapshot?.isPlaying,
        });
    }

    // ─── Reprise du gestionnaire par défaut de discord-player ─────────────

    /**
     * Cas que traitait `defaultVoiceStateHandler` et qu'il faut conserver, le
     * fait de s'abonner à l'événement l'ayant désactivé.
     *
     * Le retrait du salon n'y figure pas : quand c'est nous qui déconnectons,
     * la file doit survivre, et quand c'est un modérateur, `evaluer()` décidera
     * s'il y a lieu de revenir.
     */
    _trackBotVoiceState(queue, oldState, newState) {
        const botId = newState.guild?.members?.me?.id;
        if (!botId || newState.member?.id !== botId) return;

        // Sourdine serveur : suivre la décision du modérateur.
        if (newState.serverMute != null && oldState.serverMute !== newState.serverMute) {
            try {
                queue.node.setPaused(newState.serverMute);
            } catch (e) {}
            return;
        }

        // Salon de conférence : redemander la parole si elle est retirée.
        if (newState.channel?.type === ChannelType.GuildStageVoice && newState.suppress != null
            && oldState.suppress !== newState.suppress) {
            try {
                queue.node.setPaused(newState.suppress);
            } catch (e) {}
            if (newState.suppress) {
                newState.guild.members.me?.voice.setRequestToSpeak(true).catch(() => {});
            }
            return;
        }

        // Déplacement du bot par un modérateur : suivre le salon.
        if (newState.channelId && oldState.channelId !== newState.channelId && queue.connection) {
            queue.channel = newState.channel;
            queue.activeChannelId = newState.channelId;
            // L'écoute de la parole change de salon avec le bot : les locuteurs
            // de l'ancien n'ont plus cours, et la liste des détections
            // désactivées à consulter est celle du nouveau.
            const ducking = this.client?.duckingManagers?.get(queue.guild.id);
            if (ducking) {
                ducking.setChannelId(newState.channelId);
                ducking.forgetSpeakers();
            }
        }
    }

    _notify(guildId) {
        try {
            const webServer = require('../web/WebServer');
            webServer.broadcastState(guildId);
            const playbackStateManager = require('../database/PlaybackStateManager');
            playbackStateManager.saveState(this.player);
        } catch (err) {
            log.error('[Presence] Error notifying the dashboard:', err.message);
        }
    }
}

// Singleton
module.exports = new PresenceManager();
