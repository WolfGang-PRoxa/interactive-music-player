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
function salonHabite(channel) {
    if (!channel || !channel.members) return false;
    return channel.members.filter(m => !m.user.bot).size > 0;
}

class PresenceManager {
    constructor() {
        this.client = null;
        this.player = null;
        /** @type {Map<string, NodeJS.Timeout>} guildId → départ programmé */
        this.departsProgrammes = new Map();
        /** @type {Set<string>} guildes dont la connexion est en cours de bascule */
        this.basculesEnCours = new Set();
    }

    /** La règle de présence est-elle active ? */
    get actif() {
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
                this._suivreEtatDuBot(queue, oldState, newState);
            } catch (err) {
                log.error('[Presence] Erreur de suivi de l\'état vocal :', err.message);
            }
        });

        // Toute connexion vocale, d'où qu'elle vienne — commande /play, import
        // de fichier, sélection de salon —, met fin au gel : le lecteur existe
        // de nouveau et redevient la source de vérité.
        player.events.on('connection', (queue) => {
            queue.absentSalonVide = false;

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
                log.error('[Presence] Erreur de mise en écoute de la parole :', err.message);
            }
        });
    }

    salonHabite(channel) {
        return salonHabite(channel);
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
    connexionAutorisee(channel) {
        if (!channel) return false;
        if (!this.actif) return true;
        return salonHabite(channel);
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
    salonAssigne(guildId) {
        const guild = this.client?.guilds?.cache?.get(guildId);
        if (!guild) return null;

        const settings = database.getSettings(guildId);
        const queue = this.player?.queues?.get(guildId);

        const candidats = [
            queue?.activeChannelId,
            queue?.channel?.id,
            settings.lastVoiceChannelId,
        ];

        for (const id of candidats) {
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
    evaluer(guildId) {
        if (!this.actif || !guildId) return;
        if (this.basculesEnCours.has(guildId)) return;

        const queue = this.player?.queues?.get(guildId);
        const salonActuel = queue?.connection ? queue.channel : null;

        if (salonActuel) {
            if (salonHabite(salonActuel)) {
                this._annulerDepart(guildId);
            } else {
                this._programmerDepart(guildId);
            }
            return;
        }

        this._annulerDepart(guildId);
        if (!queue) return;

        const cible = this.salonAssigne(guildId);
        if (cible) {
            if (salonHabite(cible)) this._rejoindreEnFond(guildId, cible);
            return;
        }

        // Aucun salon rattaché : première utilisation sur cette guilde. Le bot
        // se pose là où quelqu'un vient d'apparaître plutôt que de rester
        // introuvable en attendant une sélection depuis le tableau de bord.
        const guild = this.client?.guilds?.cache?.get(guildId);
        const spontane = guild?.channels?.cache
            ?.filter(c => c.type === ChannelType.GuildVoice && salonHabite(c))
            ?.first();
        if (spontane) this._rejoindreEnFond(guildId, spontane);
    }

    _rejoindreEnFond(guildId, channel) {
        this.rejoindre(guildId, channel).catch(err => {
            log.error('[Presence] Erreur à l\'arrivée dans le salon :', err.message);
        });
    }

    /**
     * Fige la lecture d'une file restée hors du salon.
     *
     * Appelée par les points de connexion qui renoncent à se connecter : c'est
     * ce drapeau qui fera reprendre la lecture au retour du bot.
     *
     * @param {import('discord-player').GuildQueue} queue
     * @param {object} [etat] Position et état de lecture à mémoriser.
     */
    marquerAbsent(queue, etat = {}) {
        if (!queue) return;
        queue.absentSalonVide = true;
        if (etat.positionMs !== undefined) queue.positionFigeeMs = etat.positionMs;
        if (etat.enLecture !== undefined) queue.lectureFigeeEnCours = !!etat.enLecture;
    }

    /**
     * Lève l'absence : le bot est dans le salon, c'est son lecteur qui fait foi.
     * @param {import('discord-player').GuildQueue} queue
     */
    _marquerPresent(queue) {
        if (!queue || !queue.absentSalonVide) return;
        queue.absentSalonVide = false;
        queue.positionFigeeMs = 0;
        queue.lectureFigeeEnCours = false;
    }

    // ─── Arrivée ──────────────────────────────────────────────────────────

    /**
     * Installe le bot dans un salon et y reprend la lecture figée.
     *
     * @param {string} guildId
     * @param {import('discord.js').VoiceBasedChannel} channel
     */
    async rejoindre(guildId, channel) {
        const queue = this.player?.queues?.get(guildId);
        if (!queue || !channel) return;
        if (queue.connection && queue.channel?.id === channel.id) {
            // Le bot y est déjà : il n'y a rien à rejoindre, mais l'absence a
            // pu être déclarée sans que la connexion ne tombe — un changement
            // de mode de diffusion sur un salon alors désert, par exemple. La
            // laisser inscrite figerait la position affichée par le tableau de
            // bord sur celle du départ, pendant que le son avance.
            this._marquerPresent(queue);
            return;
        }
        if (this.basculesEnCours.has(guildId)) return;

        this.basculesEnCours.add(guildId);
        try {
            log.info(`[Presence] Quelqu'un est arrivé dans « ${channel.name} » : connexion du bot.`);
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
                await this._reprendreLecture(queue);
            }

            this._marquerPresent(queue);
        } finally {
            this.basculesEnCours.delete(guildId);
        }

        this._notifier(guildId);
    }

    /**
     * Remonte la piste figée dans le lecteur fraîchement reconnecté.
     *
     * La file et l'historique n'ont pas bougé : seule la piste courante doit
     * être relancée, à la position où le départ l'avait laissée.
     *
     * @param {import('discord-player').GuildQueue} queue
     */
    async _reprendreLecture(queue) {
        const piste = queue.currentTrack;

        if (!piste) {
            if (queue.tracks.size > 0) {
                try {
                    await queue.node.play();
                } catch (err) {
                    log.error('[Presence] Erreur de démarrage de la file :', err.message);
                }
            }
            return;
        }

        // Mêmes drapeaux que la transition personnel → commun : démarrage muet,
        // repositionnement en silence, puis rétablissement du volume — le tout
        // piloté par `playerStart` dans PlayerEvents.
        queue.transitioningToEveryone = true;
        queue.transitionTargetProgress = queue.positionFigeeMs || 0;
        queue.transitionTrack = piste;
        queue.restorePaused = !queue.lectureFigeeEnCours;

        try {
            queue.node.setVolume(0);
        } catch (e) {}

        try {
            // Lecture directe plutôt que `queue.play()` : celle-ci ferait passer
            // la piste par la file d'attente, où elle se rangerait derrière les
            // titres suivants au lieu de démarrer.
            await queue.node.play(piste, { queue: false });
        } catch (err) {
            log.error('[Presence] Erreur de reprise de la lecture :', err.message);
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
    _delaiDepart(guildId) {
        const secondes = Number(database.getSettings(guildId)?.presenceDepartureDelay);
        if (Number.isFinite(secondes) && secondes >= 0) return Math.round(secondes * 1000);
        return config.presence.departureDelay;
    }

    _programmerDepart(guildId) {
        if (this.departsProgrammes.has(guildId)) return;

        const delai = this._delaiDepart(guildId);
        const queue = this.player?.queues?.get(guildId);
        log.info(`[Presence] Salon « ${queue?.channel?.name || '?'} » vide : `
            + `départ du bot dans ${Math.round(delai / 1000)}s.`);

        const minuteur = setTimeout(() => {
            this.departsProgrammes.delete(guildId);
            this.quitter(guildId).catch(err => {
                log.error('[Presence] Erreur au départ du salon :', err.message);
            });
        }, delai);
        if (minuteur.unref) minuteur.unref();

        this.departsProgrammes.set(guildId, minuteur);
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
    reprogrammerDepart(guildId) {
        const minuteur = this.departsProgrammes.get(guildId);
        if (!minuteur) return;
        clearTimeout(minuteur);
        this.departsProgrammes.delete(guildId);
        this.evaluer(guildId);
    }

    _annulerDepart(guildId) {
        const minuteur = this.departsProgrammes.get(guildId);
        if (!minuteur) return;
        clearTimeout(minuteur);
        this.departsProgrammes.delete(guildId);
        log.info('[Presence] Quelqu\'un est là : départ du bot annulé.');
    }

    /**
     * Retire le bot d'un salon devenu vide, en préservant la lecture.
     * @param {string} guildId
     */
    async quitter(guildId) {
        const queue = this.player?.queues?.get(guildId);
        if (!queue?.dispatcher) return;

        const salon = queue.channel;
        if (salonHabite(salon)) return; // quelqu'un est revenu entre-temps

        log.info(`[Presence] Salon « ${salon?.name || '?'} » toujours vide : le bot s'en retire.`);
        this.retirer(guildId);
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
    retirer(guildId) {
        const queue = this.player?.queues?.get(guildId);
        if (!queue?.dispatcher) return;

        // Relever la position pendant que le lecteur sait encore répondre.
        let positionMs = 0;
        let enLecture = false;
        try {
            positionMs = queue.node.getTimestamp()?.current?.value || 0;
            enLecture = queue.node.isPlaying();
        } catch (e) {}
        this.marquerAbsent(queue, { positionMs, enLecture });

        this.detacher(guildId);
        this._notifier(guildId);
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
    detacher(guildId) {
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
        const etaitEnTransition = queue.isTransitioning();
        queue.setTransitioning(true);
        try {
            queue.dispatcher.destroy();
        } finally {
            queue.setTransitioning(etaitEnTransition);
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
    async connecterSiHabite(queue, voiceChannel) {
        if (!queue || !voiceChannel) return false;
        const guildId = queue.guild.id;

        if (!this.connexionAutorisee(voiceChannel)) {
            log.info(`[Presence] Salon « ${voiceChannel.name} » désert : `
                + 'la lecture attendra un auditeur.');
            if (queue.connection) this.retirer(guildId);
            else this.marquerAbsent(queue);
            return false;
        }

        if (!queue.connection || queue.channel?.id !== voiceChannel.id) {
            await queue.connect(voiceChannel);
        }
        queue.absentSalonVide = false;
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
    commanderFige(queue, action, valeur = 0) {
        if (!queue?.session?.estGelee()) return false;

        switch (action) {
            case 'pause':
                queue.lectureFigeeEnCours = false;
                break;
            case 'resume':
                queue.lectureFigeeEnCours = true;
                break;
            case 'stop':
                queue.lectureFigeeEnCours = false;
                queue.positionFigeeMs = 0;
                break;
            case 'seek':
                queue.positionFigeeMs = Math.max(0, valeur || 0);
                break;
            case 'skip': {
                if (queue.currentTrack) queue.history.push(queue.currentTrack);
                queue.__current = queue.tracks.dispatch() || null;
                queue.positionFigeeMs = 0;
                break;
            }
            case 'previous': {
                const precedente = queue.history.tracks.dispatch();
                if (!precedente) return true;
                if (queue.currentTrack) queue.insertTrack(queue.currentTrack, 0);
                queue.__current = precedente;
                queue.positionFigeeMs = 0;
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
    chargerEtatFige(queue, channelId) {
        const { Track } = require('discord-player');
        const { restoreHistory } = require('../utils/historyOrder');

        const player = this.player;
        const versTrack = (donnees) => {
            const track = new Track(player, donnees);
            track.queryType = donnees.queryType || null;
            track.raw = donnees.raw || {};
            if (donnees.extractorName) {
                track.extractor = player.extractors.store.get(donnees.extractorName) || null;
            }
            return track;
        };
        const utilisable = (t) => !!(t && t.title && t.url);

        const instantane = queue.channelStates?.[channelId];

        queue.tracks.clear();
        queue.history.clear();
        // `currentTrack` retombe sur `__current` faute de flux : c'est là qu'il
        // faut poser la piste tant qu'aucun lecteur n'existe pour la porter.
        queue.__current = utilisable(instantane?.currentTrack)
            ? versTrack(instantane.currentTrack)
            : null;

        const suite = (instantane?.queue || []).filter(utilisable);
        if (suite.length > 0) queue.addTrack(suite.map(versTrack));

        restoreHistory(
            queue,
            (instantane?.history || []).filter(utilisable),
            versTrack,
            queue.__current?.url || null
        );

        try {
            queue.setRepeatMode(instantane?.repeatMode || 0);
        } catch (e) {}

        this.marquerAbsent(queue, {
            positionMs: instantane?.currentProgress || 0,
            enLecture: !!instantane?.isPlaying,
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
    _suivreEtatDuBot(queue, oldState, newState) {
        const moi = newState.guild?.members?.me?.id;
        if (!moi || newState.member?.id !== moi) return;

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
                ducking.oublierLocuteurs();
            }
        }
    }

    _notifier(guildId) {
        try {
            const webServer = require('../web/WebServer');
            webServer.broadcastState(guildId);
            const playbackStateManager = require('../database/PlaybackStateManager');
            playbackStateManager.saveState(this.player);
        } catch (err) {
            log.error('[Presence] Erreur de notification du tableau de bord :', err.message);
        }
    }
}

// Singleton
module.exports = new PresenceManager();
