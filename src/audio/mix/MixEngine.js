/**
 * MixEngine — la lecture en diffusion commune, portée par le bus de mixage.
 *
 * ## Le problème
 *
 * discord-player fabrique une chaîne audio complète par morceau : extraction,
 * FFmpeg, filtres, puis une `AudioResource` neuve confiée au lecteur vocal.
 * Passer d'un titre au suivant remplace donc la ressource, et remplacer la
 * ressource interrompt le son. C'est structurel : deux morceaux ne peuvent pas
 * se superposer si le second ne peut exister qu'en chassant le premier.
 *
 * ## L'approche
 *
 * Une seule `AudioResource`, créée à l'arrivée dans le salon et jamais
 * remplacée, alimentée par le bus de mixage. Les morceaux deviennent des
 * sources du bus : en ajouter un second ne coûte rien, et le retirer non plus.
 *
 * discord-player garde tout le reste — file d'attente, historique, modes de
 * répétition, événements. Ce moteur se contente de lui dire quand un morceau
 * s'achève, en émettant sur son répartiteur les mêmes signaux que ceux qu'une
 * fin de ressource aurait produits. La machine à états reste la sienne ; seul
 * le son passe par un autre chemin.
 *
 * ## Ce que le moteur reprend à sa charge
 *
 * Puisque la chaîne de discord-player n'est plus montée, tout ce qui s'y
 * greffait est réimplémenté sur le bus : volume et ducking (gain maître),
 * pause, repositionnement, vitesse de lecture, et la position de lecture — qui
 * devient d'ailleurs exacte, puisqu'elle se compte en échantillons émis plutôt
 * qu'en millisecondes estimées.
 */

const {
    createAudioPlayer,
    createAudioResource,
    StreamType,
    NoSubscriberBehavior,
    AudioPlayerStatus,
    VoiceConnectionStatus,
} = require('@discordjs/voice');
const { GuildQueueEvent } = require('discord-player');

const MixBus = require('./MixBus');
const MixSource = require('./MixSource');
const { FRAME_DURATION_MS } = require('./format');
const database = require('../../database/Database');
const loudness = require('../loudness');
const loudnessAnalyzer = require('../LoudnessAnalyzer');
const log = require('../../utils/logger');

/**
 * Avance avec laquelle le morceau suivant est décodé, en millisecondes.
 *
 * Elle s'ajoute à la durée du fondu : quand celui-ci démarre, la source
 * entrante a déjà du son d'avance et le mixage commence sur du décodé, pas sur
 * l'aléa d'un démarrage de FFmpeg. C'est aussi ce qui rend l'enchaînement sans
 * blanc quand l'effet mix est désactivé.
 */
const PREPARATION_LEAD_MS = 4000;

/** Fondu appliqué à un morceau qui démarre seul, quand l'effet mix est actif. */
const ISOLATED_FADE_IN_CURVE = 'perceptif';

/**
 * Durée d'une piste en millisecondes, 0 si elle est inconnue.
 * @param {object} piste
 * @returns {number}
 */
function trackDurationMs(track) {
    if (!track) return 0;
    if (track.durationMS) return track.durationMS;
    if (typeof track.duration === 'string') {
        const parts = track.duration.split(':').map(Number);
        if (parts.some(isNaN)) return 0;
        if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
        if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
    }
    return 0;
}

/**
 * Deux références désignent-elles la même piste ?
 *
 * L'identifiant est régénéré à chaque reconstruction de piste — depuis un état
 * sauvegardé, ou depuis une playlist enregistrée —, si bien qu'il ne suffit pas
 * à reconnaître le morceau qu'on vient de préparer.
 *
 * @param {object} a
 * @param {object} b
 * @returns {boolean}
 */
function sameTrack(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    if (a.id && a.id === b.id) return true;
    return !!a.url && a.url === b.url;
}

class MixEngine {
    /**
     * @param {import('discord-player').GuildQueue} queue
     */
    constructor(queue) {
        this.queue = queue;
        this.guildId = queue.guild.id;

        this.bus = null;
        this.resource = null;
        this.player = null;
        this.subscription = null;
        this.connection = null;

        /** @type {MixSource|null} Morceau courant */
        this._source = null;

        /** @type {MixSource|null} Morceau suivant, préparé puis superposé */
        this._incoming = null;

        /** @type {object|null} Piste correspondant à `_entrante` */
        this._incomingTrack = null;

        /** Préparation du morceau suivant en cours. */
        this._preparation = null;

        /** Le fondu enchaîné a-t-il déjà été lancé pour le morceau courant ? */
        this._fadeStarted = false;

        /**
         * Incrémentée à chaque demande de lecture.
         *
         * Sert à savoir, au retour d'une opération asynchrone, si la demande
         * qu'on servait est toujours celle en cours — un enchaînement rapide de
         * `skip` peut en avoir déclenché une autre entretemps.
         */
        this._generation = 0;

        /** Volume nominal, 0 à 100, ducking compris. */
        this._volume = 100;

        /**
         * Source dont la fin est annoncée mais pas encore traitée.
         *
         * L'avancement de la file est différé hors de la pile du flux audio ;
         * une commande arrivée entretemps — un saut de piste — l'aura déjà fait
         * avancer, et ce témoin évite d'enchaîner deux fois.
         */
        this._pendingEnd = null;

        this._settingsCache = null;
        this._settingsRead = 0;

        this._stopped = false;
    }

    // ─── Cycle de vie ─────────────────────────────────────────────────────

    /**
     * Monte le bus et prend la main sur la connexion vocale.
     *
     * Le lecteur de discord-player est détaché : une connexion ne dessert qu'un
     * abonnement, et le laisser en place ferait dialoguer deux émetteurs sur le
     * même flux UDP.
     *
     * @returns {boolean} true si le moteur est en place
     */
    start() {
        if (this.bus) return true;

        const dispatcher = this.queue.dispatcher;
        const connection = dispatcher?.voiceConnection;
        if (!connection) return false;

        this.bus = new MixBus();
        this.bus.onFrame(() => this._clock());
        this.bus.on('sourceEpuisee', (source) => this._onSourceExhausted(source));
        this.bus.on('engineError', (err) => {
            log.error('[MixEngine] Error in the bus clock:', err.message);
        });

        this.resource = createAudioResource(this.bus, {
            inputType: StreamType.Raw,
            // Le gain est appliqué dans le bus, source par source : un
            // transformateur de volume supplémentaire ne ferait qu'ajouter un
            // arrondi sur des échantillons déjà mixés.
            inlineVolume: false,
            metadata: null,
        });

        this.player = createAudioPlayer({
            behaviors: {
                noSubscriber: NoSubscriberBehavior.Pause,
                // Un creux d'alimentation ne doit jamais arrêter la ressource :
                // elle est permanente, et l'arrêter reviendrait à couper la
                // lecture pour de bon. Le lecteur comble avec du silence et
                // reprend exactement là où le bus s'était interrompu.
                maxMissedFrames: Number.MAX_SAFE_INTEGER,
            },
        });

        this.player.on('error', (err) => {
            log.error('[MixEngine] Audio player error:', err.message);
        });

        // Le volume nominal est posé avant la première trame : le bus démarrerait
        // sinon à plein régime le temps que le contrôleur de volume soit monté,
        // et une reprise muette — restauration au démarrage, retour en diffusion
        // commune — laisserait échapper un éclat sonore.
        const settings = database.getSettings(this.guildId);
        const muted = !!this.queue.restorePaused || !!this.queue.transitioningToEveryone;
        this.setVolume(muted ? 0 : (settings.baseVolume ?? 100));

        this._stopSilenceBroadcaster();
        this._takeSubscription(connection);

        this.player.play(this.resource);

        // La ressource tient lieu de celle qu'aurait créée discord-player :
        // `queue.currentTrack` la consulte, et le répartiteur la transmet à ses
        // propres écouteurs quand on lui signale une fin de morceau.
        dispatcher.audioResource = this.resource;

        dispatcher.once('destroyed', () => this.stop());

        log.info(`[MixEngine] Mix bus opened for guild ${this.guildId}.`);
        return true;
    }

    /**
     * Détache le lecteur de discord-player et met le nôtre à sa place.
     * @param {import('@discordjs/voice').VoiceConnection} connexion
     */
    _takeSubscription(connection) {
        try {
            connection.state?.subscription?.unsubscribe();
        } catch (e) {}
        this.subscription = connection.subscribe(this.player);

        if (this.connection !== connection) {
            this.connection = connection;
            // Le répartiteur n'émet « destroyed » que lorsqu'on le détruit
            // explicitement : une connexion coupée par ailleurs — départ d'un
            // salon vide, arrêt du bot — laisserait sinon le bus tourner dans
            // le vide, décodeurs compris.
            connection.once(VoiceConnectionStatus.Destroyed, () => this.stop());
            // Une reconnexion remonte l'abonnement d'origine, celui du lecteur
            // de discord-player, qui ne produit plus rien : le son se tairait
            // sans que rien ne le signale.
            connection.on(VoiceConnectionStatus.Ready, () => {
                if (!this._stopped) this.checkSubscription();
            });
        }
    }

    /**
     * Vérifie que le bus alimente toujours la connexion.
     *
     * Une reconnexion peut remettre en place l'abonnement du lecteur de
     * discord-player, qui ne diffuse rien : le son se tairait sans que rien ne
     * le signale.
     */
    checkSubscription() {
        const connection = this.queue.dispatcher?.voiceConnection;
        if (!connection || this._stopped) return;
        if (connection.state?.subscription === this.subscription) return;
        log.info('[MixEngine] Voice subscription taken over by the mix bus.');
        this._takeSubscription(connection);
    }

    /**
     * Coupe le diffuseur de silence, hérité de la diffusion personnelle.
     *
     * Il s'abonne lui aussi à la connexion : le laisser tourner déposséderait
     * le bus de sa sortie audio dès le premier changement de mode.
     */
    _stopSilenceBroadcaster() {
        const queue = this.queue;
        if (queue.silencePlayer) {
            try { queue.silencePlayer.stop(true); } catch (e) {}
            queue.silencePlayer = null;
        }
        if (queue.silenceStream) {
            try { queue.silenceStream.destroy(); } catch (e) {}
            queue.silenceStream = null;
        }
    }

    /** Referme le bus et libère tout ce qui en dépend. */
    stop() {
        if (this._stopped) return;
        this._stopped = true;

        this._abandonIncoming();
        if (this._source) {
            this._source.stop();
            this._source = null;
        }

        try { this.bus?.close(); } catch (e) {}
        try { this.player?.stop(true); } catch (e) {}
        try { this.subscription?.unsubscribe(); } catch (e) {}

        if (this.queue.dispatcher?.audioResource === this.resource) {
            this.queue.dispatcher.audioResource = null;
        }

        this.bus = null;
        this.resource = null;
        this.player = null;
        this.subscription = null;

        log.info(`[MixEngine] Mix bus closed again for guild ${this.guildId}.`);
    }

    /** @returns {boolean} */
    get active() {
        return !this._stopped && !!this.bus;
    }

    // ─── Lecture ──────────────────────────────────────────────────────────

    /**
     * Met un morceau en lecture.
     *
     * Appelée par le pont posé sur `queue.node.play()`, y compris lorsque
     * discord-player enchaîne de lui-même sur le titre suivant. Dans ce dernier
     * cas, le morceau demandé est celui que le fondu a déjà mis en route : il
     * est promu sur place plutôt que redémarré, ce qui est exactement ce qui
     * rend la superposition possible.
     *
     * @param {object} piste
     * @param {object} [options]
     * @param {number} [options.seek] - Position de départ, en millisecondes
     * @returns {Promise<void>}
     */
    async play(track, { seek = 0 } = {}) {
        if (!this.active || !track) return;

        const generation = ++this._generation;
        this._pendingEnd = null;
        this._setCurrentTrack(track);

        // Le morceau attendu est celui que le fondu enchaîné a déjà lancé :
        // il joue, il est à sa place, il n'y a qu'à en faire le morceau courant.
        if (this._incoming && sameTrack(this._incomingTrack, track) && !seek) {
            this._promoteIncoming();
            this._signalStart();
            return;
        }

        this._abandonIncoming();
        if (this._source) {
            this.bus.remove(this._source);
            this._source.stop();
            this._source = null;
        }

        const settings = this._settings();
        const source = new MixSource(track, {
            player: this.queue.player,
            startMs: seek,
            speed: this._speed(settings),
            gain: 1,
            levelGain: loudness.linearGain(track.url, settings),
        });

        try {
            await source.start();
        } catch (err) {
            log.error(`[MixEngine] Cannot decode « ${track?.title} »:`, err.message);
            source.stop();
            if (generation === this._generation) this._failTrack(track, err);
            return;
        }

        // Une autre demande est passée pendant le décodage : celle-ci n'a plus
        // lieu d'être, et sa source n'a jamais rejoint le bus.
        if (generation !== this._generation || !this.active) {
            source.stop();
            return;
        }

        // Le décodeur a rendu la main sans un octet : la source est
        // introuvable. Passer au titre suivant vaut mieux que d'annoncer une
        // lecture muette dont rien ne signalerait jamais la fin.
        if (!source.hasSound) {
            source.stop();
            this._failTrack(track, new Error('Decoding produced no sound at all.'));
            return;
        }

        this._fadeStarted = false;
        this._source = source;

        // La mesure de sonie manque tant que le morceau n'a jamais été joué :
        // on la demande ici, et le gain se posera de lui-même quand elle
        // tombera — `applyLoudness()` est rappelée sur l'événement de mesure.
        loudnessAnalyzer.ensure(track);

        // Entrée en fondu d'un morceau qui démarre seul — un démarrage manuel,
        // un saut de piste. L'enchaînement de fin de morceau, lui, amène le
        // suivant déjà monté à plein gain : y ajouter un fondu le ferait
        // repartir de zéro.
        if (settings.mixEnabled) {
            const duration = this._fadeDuration(settings);
            source.setGain(0);
            source.fade(1, duration, { curve: ISOLATED_FADE_IN_CURVE });
            if (settings.mixType === 'effects') source.sweepFilter('ouvre');
        }

        this.bus.add(source);
        this._signalStart();
    }

    /**
     * Passe au morceau suivant sur demande explicite.
     *
     * Contrairement à une fin de morceau, rien n'est superposé : le suivant
     * prend la place du courant sans transition.
     *
     * Le morceau préparé d'avance n'est abandonné que si le fondu l'a déjà
     * entamé — il aurait alors quelques secondes d'avance, et reprendrait en
     * plein milieu. Tant qu'il attend, il est conservé : c'est ce qui rend le
     * saut de piste immédiat plutôt que suspendu au démarrage d'un décodeur.
     */
    skip() {
        if (!this.active) return false;
        const track = this.queue.currentTrack;

        this._pendingEnd = null;
        if (this._fadeStarted) this._abandonIncoming();
        if (this._source) {
            this.bus.remove(this._source);
            this._source.stop();
            this._source = null;
        }
        this._fadeStarted = false;

        this._finishTrack(track);
        return true;
    }

    /**
     * Fait taire le bus sans le refermer.
     *
     * Les sources sont retirées et leurs décodeurs fermés ; le flux reste ouvert
     * et prêt à reprendre, la connexion vocale n'a pas à être remontée.
     */
    mute() {
        if (!this.active) return;
        this._generation++;
        this._pendingEnd = null;
        this._abandonIncoming();
        if (this._source) {
            this.bus.remove(this._source);
            this._source.stop();
            this._source = null;
        }
        this._fadeStarted = false;
        this._setCurrentTrack(null);
    }

    /**
     * Repositionne la lecture dans le morceau courant.
     * @param {number} positionMs
     * @returns {Promise<boolean>}
     */
    async seek(positionMs) {
        if (!this.active || !this._source) return false;

        // Un fondu amorcé n'a plus de sens une fois qu'on a changé d'endroit
        // dans le morceau : le suivant n'est plus imminent.
        this._abandonIncoming();
        this._fadeStarted = false;

        const source = this._source;
        const generation = ++this._generation;

        source.setGain(1);
        source.cutFilter();

        try {
            await source.seek(Math.max(0, positionMs));
        } catch (err) {
            log.error('[MixEngine] Repositionnement impossible :', err.message);
            return false;
        }

        return generation === this._generation;
    }

    /**
     * Applique une nouvelle vitesse de lecture.
     *
     * Le rééchantillonnage est fait par FFmpeg, qu'il faut donc relancer — à la
     * position atteinte, pour que le morceau ne reparte pas de son début.
     *
     * @param {number} vitesse
     * @returns {Promise<void>}
     */
    async applySpeed(speed) {
        if (!this.active || !this._source) return;
        if (Math.abs(this._source.speed - speed) < 0.001) return;

        const position = this._source.positionMs;
        this._abandonIncoming();
        this._fadeStarted = false;

        try {
            await this._source.seek(position, speed);
        } catch (err) {
            log.error('[MixEngine] Speed change impossible:', err.message);
        }
    }

    /**
     * Réaligne le niveau des morceaux en cours sur les réglages courants.
     *
     * Contrairement à la vitesse, rien n'est à relancer : le gain vit dans le
     * mixage, pas dans le décodeur. C'est ce qui rend le curseur de LUFS
     * immédiat, y compris au milieu d'un fondu enchaîné — le morceau qui entre
     * est corrigé en même temps que celui qui sort.
     *
     * Le cache de réglages est court-circuité : cette méthode est appelée juste
     * après l'écriture en base, et lire une valeur vieille de deux dixièmes de
     * seconde reviendrait à appliquer le réglage précédent.
     */
    applyLoudness() {
        if (!this.active) return;

        this._settingsRead = 0;
        const settings = this._settings();

        for (const source of [this._source, this._incoming]) {
            if (!source || !source.track) continue;
            source.setLevelGain(loudness.linearGain(source.track.url, settings));
        }
    }

    // ─── Horloge et enchaînement ──────────────────────────────────────────

    /**
     * Appelée après chaque trame produite par le bus, soit toutes les 20 ms de
     * son effectivement diffusé.
     *
     * Cadencer l'enchaînement sur le son plutôt que sur une horloge murale est
     * ce qui rend le déclenchement fiable : une pause, un creux d'alimentation
     * ou un ralentissement du processus ne décalent pas le point de fondu.
     */
    _clock() {
        const source = this._source;
        if (!source || this._stopped) return;

        const settings = this._settings();
        const remaining = this._remainingMs(source);
        if (remaining === null) return;

        const fadeDuration = settings.mixEnabled ? this._fadeDuration(settings) : 0;

        if (!this._incoming && !this._preparation && remaining <= fadeDuration + PREPARATION_LEAD_MS) {
            this._prepareNext(settings);
        }

        if (settings.mixEnabled && !this._fadeStarted && this._incoming && remaining <= fadeDuration) {
            // Le fondu ne peut pas durer plus longtemps qu'il ne reste de
            // musique : une durée annoncée trop généreuse laisserait sinon le
            // morceau sortant se taire avant d'avoir fini de descendre, et
            // l'entrant terminer sa montée dans le vide.
            this._startFade(settings, Math.min(fadeDuration, Math.max(500, remaining)));
        }
    }

    /**
     * Temps de lecture restant sur le morceau courant, en millisecondes.
     *
     * Une fois le décodage terminé, le tampon donne le compte exact : c'est la
     * seule mesure qui ne dépende pas des métadonnées, dont la durée annoncée
     * est parfois fausse — un titre ponté vers une autre source ne dure pas
     * forcément ce que sa fiche prétend.
     *
     * @param {MixSource} source
     * @returns {number|null} null si la durée reste inconnue
     */
    _remainingMs(source) {
        if (source.streamEnded) return source.leadMs;

        const duration = trackDurationMs(source.track);
        if (!duration) return null;
        return Math.max(0, (duration - source.positionMs) / source.speed);
    }

    /**
     * Réglages du serveur, relus au plus une fois par dizaine de trames.
     *
     * `getSettings` reconstruit un objet à chaque appel ; l'interroger cinquante
     * fois par seconde depuis le chemin audio ne servirait qu'à faire travailler
     * le ramasse-miettes. Deux dixièmes de seconde de retard sur un changement de
     * réglage ne s'entendent pas.
     *
     * @returns {object}
     */
    _settings() {
        const now = Date.now();
        if (!this._settingsCache || now - this._settingsRead > 200) {
            this._settingsCache = database.getSettings(this.guildId);
            this._settingsRead = now;
        }
        return this._settingsCache;
    }

    /** @param {object} reglages */
    _fadeDuration(settings) {
        return Math.max(500, (parseFloat(settings.mixDuration) || 5) * 1000);
    }

    /** @param {object} reglages */
    _speed(settings) {
        const value = parseFloat(settings.playbackSpeed || '1.0');
        return value > 0 ? value : 1;
    }

    /**
     * Piste que discord-player jouera ensuite, si elle est prévisible.
     *
     * En lecture aléatoire, elle ne l'est pas : le tirage n'a lieu qu'au moment
     * de l'enchaînement. Préparer un morceau au hasard reviendrait à en imposer
     * un, et la répétition d'un titre unique ne s'enchaîne pas avec elle-même.
     *
     * @returns {object|null}
     */
    _predictableNextTrack() {
        const queue = this.queue;
        if (queue.repeatMode === 1) return null;   // répétition du morceau
        if (queue.isShuffling) return null;
        try {
            return queue.tracks.at(0) || null;
        } catch (e) {
            return null;
        }
    }

    /** Ouvre le décodeur du morceau suivant, sans encore le verser dans le bus. */
    _prepareNext(settings) {
        const next = this._predictableNextTrack();
        if (!next) return;

        // Mesuré pendant qu'il attend son tour : le fondu enchaîné le versera
        // au bon niveau, sans le saut de gain qu'une mesure tardive imposerait
        // en plein milieu du croisement.
        loudnessAnalyzer.ensure(next);

        const source = new MixSource(next, {
            player: this.queue.player,
            speed: this._speed(settings),
            gain: 0,
            levelGain: loudness.linearGain(next.url, settings),
        });

        const preparation = source.start()
            .then(() => {
                // `_abandonnerEntrante()` remet la préparation à zéro : c'est le
                // signal que ce morceau-là n'est plus attendu — un saut de piste,
                // un repositionnement.
                if (this._stopped || this._preparation !== preparation) {
                    source.stop();
                    return;
                }
                this._incoming = source;
                this._incomingTrack = next;
                log.debug(`[MixEngine] Next track ready to be layered in: ${next.title}`);
            })
            .catch((err) => {
                log.error(`[MixEngine] Preparation impossible for « ${next?.title} »:`, err.message);
                source.stop();
            })
            .finally(() => {
                if (this._preparation === preparation) this._preparation = null;
            });

        this._preparation = preparation;
    }

    /** Verse le morceau suivant dans le bus et croise les deux gains. */
    _startFade(settings, fadeDuration) {
        const outgoing = this._source;
        const incoming = this._incoming;
        if (!outgoing || !incoming) return;

        this._fadeStarted = true;

        // Loi de puissance constante des deux côtés : la somme des puissances
        // reste égale à un tout au long du croisement, là où deux rampes
        // linéaires creuseraient le niveau au milieu du fondu.
        outgoing.fade(0, fadeDuration, { curve: 'puissance' });
        incoming.setGain(0);
        incoming.fade(1, fadeDuration, { curve: 'puissance' });

        if (settings.mixType === 'effects') {
            outgoing.sweepFilter('ferme');
            incoming.sweepFilter('ouvre');
        }

        this.bus.add(incoming);
        log.info(`[MixEngine] Crossfade of ${Math.round(fadeDuration / 1000)}s: `
            + `« ${outgoing.track?.title} » → « ${incoming.track?.title} ».`);
    }

    /**
     * Une source vient d'être épuisée par le bus.
     * @param {MixSource} source
     */
    _onSourceExhausted(source) {
        if (source !== this._source || this._stopped) return;

        // Aucun fondu n'a eu lieu — effet mix désactivé, ou durée inconnue —
        // mais le morceau suivant est décodé : il prend le relais sur la trame
        // suivante, donc sans blanc.
        if (this._incoming && !this._fadeStarted) {
            this._incoming.setGain(1);
            this.bus.add(this._incoming);
        }

        const track = this.queue.currentTrack;
        this._source = null;
        this._pendingEnd = source;
        source.stop();

        // Sortir de la pile du flux avant de faire avancer la file : la suite
        // touche à la file d'attente, à l'historique et aux événements du bot.
        setImmediate(() => {
            if (this._stopped || this._pendingEnd !== source) return;
            this._pendingEnd = null;
            this._finishTrack(track);
        });
    }

    /**
     * Signale à discord-player qu'un morceau s'achève, et le laisse enchaîner.
     *
     * Le répartiteur reçoit exactement le signal qu'une fin de ressource aurait
     * produit : historique, événement `playerFinish`, modes de répétition et
     * appel du titre suivant suivent leur cours habituel.
     *
     * @param {object} piste - Morceau qui s'achève
     */
    _finishTrack(track) {
        const dispatcher = this.queue.dispatcher;
        if (!dispatcher) return;

        this._setCurrentTrack(track);
        const generation = this._generation;

        try {
            dispatcher.emit('finish', this.resource);
        } catch (err) {
            log.error('[MixEngine] Error during the crossfade:', err.message);
        }

        // Personne n'a réclamé de nouveau morceau : la file est allée au bout.
        if (this._generation === generation && !this._source) {
            this._setCurrentTrack(null);
        }
    }

    /**
     * Signale l'échec d'un morceau, pour que la file ne reste pas bloquée.
     * @param {object} piste
     * @param {Error} erreur
     */
    _failTrack(track, error) {
        try {
            this.queue.emit(GuildQueueEvent.PlayerError, this.queue, error, track);
        } catch (e) {}

        // L'avancement est différé : l'échec survient au cœur de `jouer()`, que
        // discord-player a lui-même appelée en enchaînant. Reprendre la file
        // sur place empilerait un niveau d'appel par morceau illisible, et une
        // file entière de pistes mortes finirait par saturer la pile.
        const generation = this._generation;
        setImmediate(() => {
            if (this._stopped || this._generation !== generation) return;
            this._finishTrack(track);
        });
    }

    /** Fait du morceau superposé le morceau courant. */
    _promoteIncoming() {
        if (this._source) {
            this.bus.remove(this._source);
            this._source.stop();
        }

        this._source = this._incoming;
        this._incoming = null;
        this._incomingTrack = null;
        this._fadeStarted = false;

        if (this._source) {
            // Le fondu s'est peut-être achevé avant la fin du morceau sortant :
            // dans le doute, le gain nominal est rétabli et le filtre relâché.
            if (!this._source.isFading) {
                this._source.setGain(1);
                this._source.cutFilter();
            }
            if (!this.bus.contains(this._source)) {
                this.bus.add(this._source);
            }
        }
    }

    /**
     * Interrompt l'enchaînement en cours et rend au morceau courant son niveau
     * et son timbre nominaux.
     *
     * Désactiver l'effet mix pendant un fondu laisserait sinon le morceau à
     * mi-volume, ou étouffé, jusqu'à sa fin.
     */
    cancelCrossfade() {
        if (!this.active) return;
        this._abandonIncoming();
        this._fadeStarted = false;
        if (this._source) {
            this._source.setGain(1);
            this._source.cutFilter();
        }
    }

    /** Abandonne le morceau préparé, qu'il ait déjà rejoint le bus ou non. */
    _abandonIncoming() {
        this._preparation = null;
        if (!this._incoming) return;
        this.bus?.remove(this._incoming);
        this._incoming.stop();
        this._incoming = null;
        this._incomingTrack = null;
    }

    /**
     * Fait porter à la ressource permanente le morceau en cours.
     *
     * `queue.currentTrack` lit cette métadonnée : c'est par elle que tout le
     * reste du bot — tableau de bord, commandes, sauvegarde d'état — sait ce
     * qui joue.
     *
     * @param {object|null} piste
     */
    _setCurrentTrack(track) {
        if (this.resource) this.resource.metadata = track || null;

        // `queue.currentTrack` retombe sur `__current` dès que la ressource
        // disparaît — au départ d'un salon vide, par exemple. Le tenir à jour
        // ici évite que la piste figée s'évapore avec le bus.
        this.queue.__current = track || null;
    }

    /** Émet le signal de démarrage attendu par discord-player. */
    _signalStart() {
        try {
            this.queue.dispatcher?.emit('start', this.resource);
        } catch (err) {
            log.error('[MixEngine] Error announcing the start:', err.message);
        }
    }

    // ─── Commandes ────────────────────────────────────────────────────────

    /**
     * Volume de diffusion.
     * @param {number} pourcent - 0 à 100
     * @returns {boolean}
     */
    setVolume(percent) {
        if (!this.active) return false;
        const clamp = Math.max(0, Math.min(100, Number(percent) || 0));
        this._volume = clamp;
        this.bus.setMasterGain(clamp / 100);
        return true;
    }

    /** @returns {number} Volume courant, 0 à 100 */
    get volume() {
        return this._volume;
    }

    /**
     * Met la diffusion en pause, ou la reprend.
     *
     * Le bus n'est pas touché : c'est le lecteur qui cesse de venir y puiser.
     * Rien n'est donc perdu, et la reprise repart sur l'échantillon suivant.
     *
     * @param {boolean} enPause
     * @returns {boolean}
     */
    setPaused(paused) {
        if (!this.active) return false;
        return paused ? this.player.pause(true) : this.player.unpause();
    }

    /**
     * La lecture est-elle en pause à la demande ?
     *
     * L'auto-pause du lecteur — une connexion momentanément indisponible — n'en
     * est pas une : la lecture reprendra d'elle-même, et l'afficher comme une
     * pause ferait clignoter le tableau de bord à chaque reconnexion.
     *
     * @returns {boolean}
     */
    paused() {
        if (!this.active) return false;
        return this.player.state.status === AudioPlayerStatus.Paused;
    }

    /** @returns {boolean} */
    playing() {
        if (!this.active) return false;
        return !!this._source && !this.paused();
    }

    /**
     * Avance de la chaîne de diffusion, en millisecondes de son.
     *
     * Le bus fabrique ses trames dès qu'on lui en demande, et l'encodeur Opus
     * comme la ressource audio en gardent d'avance : au démarrage, la chaîne se
     * remplit de plusieurs secondes en quelques instants. Ce qui a été fabriqué
     * n'est donc pas ce qui s'entend.
     *
     * `playbackDuration` compte les paquets réellement émis vers Discord — et
     * seulement eux, les trames muettes d'un creux d'alimentation n'y entrant
     * pas. L'écart avec le nombre de trames fabriquées donne exactement ce qui
     * attend encore dans la chaîne.
     *
     * @returns {number}
     */
    _chainLeadMs() {
        if (!this.bus || !this.resource) return 0;
        const emitted = Math.round((this.resource.playbackDuration || 0) / FRAME_DURATION_MS);
        return Math.max(0, this.bus.framesProduced - emitted) * FRAME_DURATION_MS;
    }

    /**
     * Position atteinte dans le morceau courant, en millisecondes.
     *
     * C'est la position de ce qui s'entend, pas de ce qui est décodé : l'avance
     * de la chaîne est retranchée. Sans cette correction, la barre de
     * progression du tableau de bord bondissait au démarrage puis faisait du
     * sur place le temps que la lecture réelle rattrape le tampon.
     *
     * Elle reste comptée en échantillons, donc sans dérive — à la différence
     * d'une estimation fondée sur l'horloge murale, qui ignore les pauses et le
     * temps de démarrage du décodeur.
     *
     * @returns {number}
     */
    positionMs() {
        const source = this._source;
        if (!source) return 0;

        // L'avance est comptée en trames du bus, toutes sources confondues ;
        // rapportée au morceau, elle vaut ce que la vitesse de lecture en fait.
        const rewind = this._chainLeadMs() * source.speed;
        return Math.max(source.startMs, source.positionMs - rewind);
    }

    /** Un fondu enchaîné est-il en cours ? */
    get isCrossfading() {
        return this._fadeStarted && !!this._incoming;
    }

    /**
     * Les deux morceaux d'un fondu enchaîné en cours, et où ils en sont.
     *
     * Le tableau de bord en a besoin pour montrer ce qui s'entend : pendant la
     * superposition, deux titres jouent, et n'en afficher qu'un — celui que la
     * file considère encore comme courant — reviendrait à mentir pendant toute
     * la durée du fondu. La diffusion personnelle a l'information sous la main,
     * ses deux éléments audio étant dans le navigateur ; en diffusion commune,
     * elle ne peut venir que d'ici.
     *
     * @returns {{sortante: object, entrante: object}|null}
     */
    fadeState() {
        if (!this.isCrossfading || !this._source) return null;

        const lead = this._chainLeadMs();
        const describe = (source) => {
            const position = Math.max(source.startMs, source.positionMs - lead * source.speed);
            const duration = trackDurationMs(source.track);
            return {
                track: source.track,
                url: source.track?.url || null,
                positionMs: position,
                durationMs: duration,
                ratio: duration > 0 ? Math.min(1, Math.max(0, position / duration)) : 0,
            };
        };

        return { outgoing: describe(this._source), incoming: describe(this._incoming) };
    }

    /**
     * Vitesse appliquée au morceau courant.
     *
     * Sert de multiplicateur de durée au tableau de bord : le décodeur ayant
     * déjà étiré le son, une seconde diffusée ne vaut plus une seconde du
     * morceau d'origine.
     *
     * @returns {number}
     */
    get speed() {
        if (this._source) return this._source.speed;
        try {
            return this._speed(database.getSettings(this.guildId));
        } catch (e) {
            return 1;
        }
    }
}

module.exports = MixEngine;
