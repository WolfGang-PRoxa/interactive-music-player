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
const { DUREE_TRAME_MS } = require('./format');
const database = require('../../database/Database');
const log = require('../../utils/logger');

/**
 * Avance avec laquelle le morceau suivant est décodé, en millisecondes.
 *
 * Elle s'ajoute à la durée du fondu : quand celui-ci démarre, la source
 * entrante a déjà du son d'avance et le mixage commence sur du décodé, pas sur
 * l'aléa d'un démarrage de FFmpeg. C'est aussi ce qui rend l'enchaînement sans
 * blanc quand l'effet mix est désactivé.
 */
const AVANCE_PREPARATION_MS = 4000;

/** Fondu appliqué à un morceau qui démarre seul, quand l'effet mix est actif. */
const COURBE_ENTREE_ISOLEE = 'perceptif';

/**
 * Durée d'une piste en millisecondes, 0 si elle est inconnue.
 * @param {object} piste
 * @returns {number}
 */
function dureeMs(piste) {
    if (!piste) return 0;
    if (piste.durationMS) return piste.durationMS;
    if (typeof piste.duration === 'string') {
        const parts = piste.duration.split(':').map(Number);
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
function memePiste(a, b) {
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
        this.lecteur = null;
        this.abonnement = null;
        this.connexion = null;

        /** @type {MixSource|null} Morceau courant */
        this._source = null;

        /** @type {MixSource|null} Morceau suivant, préparé puis superposé */
        this._entrante = null;

        /** @type {object|null} Piste correspondant à `_entrante` */
        this._pisteEntrante = null;

        /** Préparation du morceau suivant en cours. */
        this._preparation = null;

        /** Le fondu enchaîné a-t-il déjà été lancé pour le morceau courant ? */
        this._fonduLance = false;

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
        this._finEnAttente = null;

        this._reglagesCache = null;
        this._reglagesLus = 0;

        this._arrete = false;
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
    demarrer() {
        if (this.bus) return true;

        const dispatcher = this.queue.dispatcher;
        const connexion = dispatcher?.voiceConnection;
        if (!connexion) return false;

        this.bus = new MixBus();
        this.bus.surTrame(() => this._horloge());
        this.bus.on('sourceEpuisee', (source) => this._surSourceEpuisee(source));
        this.bus.on('erreurMoteur', (err) => {
            log.error('[MixEngine] Erreur dans l\'horloge du bus :', err.message);
        });

        this.resource = createAudioResource(this.bus, {
            inputType: StreamType.Raw,
            // Le gain est appliqué dans le bus, source par source : un
            // transformateur de volume supplémentaire ne ferait qu'ajouter un
            // arrondi sur des échantillons déjà mixés.
            inlineVolume: false,
            metadata: null,
        });

        this.lecteur = createAudioPlayer({
            behaviors: {
                noSubscriber: NoSubscriberBehavior.Pause,
                // Un creux d'alimentation ne doit jamais arrêter la ressource :
                // elle est permanente, et l'arrêter reviendrait à couper la
                // lecture pour de bon. Le lecteur comble avec du silence et
                // reprend exactement là où le bus s'était interrompu.
                maxMissedFrames: Number.MAX_SAFE_INTEGER,
            },
        });

        this.lecteur.on('error', (err) => {
            log.error('[MixEngine] Erreur du lecteur audio :', err.message);
        });

        // Le volume nominal est posé avant la première trame : le bus démarrerait
        // sinon à plein régime le temps que le contrôleur de volume soit monté,
        // et une reprise muette — restauration au démarrage, retour en diffusion
        // commune — laisserait échapper un éclat sonore.
        const reglages = database.getSettings(this.guildId);
        const muet = !!this.queue.restorePaused || !!this.queue.transitioningToEveryone;
        this.definirVolume(muet ? 0 : (reglages.baseVolume ?? 100));

        this._arreterDiffuseurSilence();
        this._prendreLAbonnement(connexion);

        this.lecteur.play(this.resource);

        // La ressource tient lieu de celle qu'aurait créée discord-player :
        // `queue.currentTrack` la consulte, et le répartiteur la transmet à ses
        // propres écouteurs quand on lui signale une fin de morceau.
        dispatcher.audioResource = this.resource;

        dispatcher.once('destroyed', () => this.arreter());

        log.info(`[MixEngine] Bus de mixage ouvert pour la guild ${this.guildId}.`);
        return true;
    }

    /**
     * Détache le lecteur de discord-player et met le nôtre à sa place.
     * @param {import('@discordjs/voice').VoiceConnection} connexion
     */
    _prendreLAbonnement(connexion) {
        try {
            connexion.state?.subscription?.unsubscribe();
        } catch (e) {}
        this.abonnement = connexion.subscribe(this.lecteur);

        if (this.connexion !== connexion) {
            this.connexion = connexion;
            // Le répartiteur n'émet « destroyed » que lorsqu'on le détruit
            // explicitement : une connexion coupée par ailleurs — départ d'un
            // salon vide, arrêt du bot — laisserait sinon le bus tourner dans
            // le vide, décodeurs compris.
            connexion.once(VoiceConnectionStatus.Destroyed, () => this.arreter());
            // Une reconnexion remonte l'abonnement d'origine, celui du lecteur
            // de discord-player, qui ne produit plus rien : le son se tairait
            // sans que rien ne le signale.
            connexion.on(VoiceConnectionStatus.Ready, () => {
                if (!this._arrete) this.verifierAbonnement();
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
    verifierAbonnement() {
        const connexion = this.queue.dispatcher?.voiceConnection;
        if (!connexion || this._arrete) return;
        if (connexion.state?.subscription === this.abonnement) return;
        log.info('[MixEngine] Abonnement vocal repris par le bus de mixage.');
        this._prendreLAbonnement(connexion);
    }

    /**
     * Coupe le diffuseur de silence, hérité de la diffusion personnelle.
     *
     * Il s'abonne lui aussi à la connexion : le laisser tourner déposséderait
     * le bus de sa sortie audio dès le premier changement de mode.
     */
    _arreterDiffuseurSilence() {
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
    arreter() {
        if (this._arrete) return;
        this._arrete = true;

        this._abandonnerEntrante();
        if (this._source) {
            this._source.arreter();
            this._source = null;
        }

        try { this.bus?.fermer(); } catch (e) {}
        try { this.lecteur?.stop(true); } catch (e) {}
        try { this.abonnement?.unsubscribe(); } catch (e) {}

        if (this.queue.dispatcher?.audioResource === this.resource) {
            this.queue.dispatcher.audioResource = null;
        }

        this.bus = null;
        this.resource = null;
        this.lecteur = null;
        this.abonnement = null;

        log.info(`[MixEngine] Bus de mixage refermé pour la guild ${this.guildId}.`);
    }

    /** @returns {boolean} */
    get actif() {
        return !this._arrete && !!this.bus;
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
    async jouer(piste, { seek = 0 } = {}) {
        if (!this.actif || !piste) return;

        const generation = ++this._generation;
        this._finEnAttente = null;
        this._definirPisteCourante(piste);

        // Le morceau attendu est celui que le fondu enchaîné a déjà lancé :
        // il joue, il est à sa place, il n'y a qu'à en faire le morceau courant.
        if (this._entrante && memePiste(this._pisteEntrante, piste) && !seek) {
            this._promouvoirEntrante();
            this._signalerDemarrage();
            return;
        }

        this._abandonnerEntrante();
        if (this._source) {
            this.bus.retirer(this._source);
            this._source.arreter();
            this._source = null;
        }

        const reglages = this._reglages();
        const source = new MixSource(piste, {
            player: this.queue.player,
            departMs: seek,
            vitesse: this._vitesse(reglages),
            gain: 1,
        });

        try {
            await source.demarrer();
        } catch (err) {
            log.error(`[MixEngine] Impossible de décoder « ${piste?.title} » :`, err.message);
            source.arreter();
            if (generation === this._generation) this._echouerPiste(piste, err);
            return;
        }

        // Une autre demande est passée pendant le décodage : celle-ci n'a plus
        // lieu d'être, et sa source n'a jamais rejoint le bus.
        if (generation !== this._generation || !this.actif) {
            source.arreter();
            return;
        }

        // Le décodeur a rendu la main sans un octet : la source est
        // introuvable. Passer au titre suivant vaut mieux que d'annoncer une
        // lecture muette dont rien ne signalerait jamais la fin.
        if (!source.aDuSon) {
            source.arreter();
            this._echouerPiste(piste, new Error('Le décodage n\'a produit aucun son.'));
            return;
        }

        this._fonduLance = false;
        this._source = source;

        // Entrée en fondu d'un morceau qui démarre seul — un démarrage manuel,
        // un saut de piste. L'enchaînement de fin de morceau, lui, amène le
        // suivant déjà monté à plein gain : y ajouter un fondu le ferait
        // repartir de zéro.
        if (reglages.mixEnabled) {
            const duree = this._dureeFondu(reglages);
            source.definirGain(0);
            source.fondre(1, duree, { courbe: COURBE_ENTREE_ISOLEE });
            if (reglages.mixType === 'effects') source.balayerFiltre('ouvre');
        }

        this.bus.ajouter(source);
        this._signalerDemarrage();
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
    passer() {
        if (!this.actif) return false;
        const piste = this.queue.currentTrack;

        this._finEnAttente = null;
        if (this._fonduLance) this._abandonnerEntrante();
        if (this._source) {
            this.bus.retirer(this._source);
            this._source.arreter();
            this._source = null;
        }
        this._fonduLance = false;

        this._terminerPiste(piste);
        return true;
    }

    /**
     * Fait taire le bus sans le refermer.
     *
     * Les sources sont retirées et leurs décodeurs fermés ; le flux reste ouvert
     * et prêt à reprendre, la connexion vocale n'a pas à être remontée.
     */
    taire() {
        if (!this.actif) return;
        this._generation++;
        this._finEnAttente = null;
        this._abandonnerEntrante();
        if (this._source) {
            this.bus.retirer(this._source);
            this._source.arreter();
            this._source = null;
        }
        this._fonduLance = false;
        this._definirPisteCourante(null);
    }

    /**
     * Repositionne la lecture dans le morceau courant.
     * @param {number} positionMs
     * @returns {Promise<boolean>}
     */
    async repositionner(positionMs) {
        if (!this.actif || !this._source) return false;

        // Un fondu amorcé n'a plus de sens une fois qu'on a changé d'endroit
        // dans le morceau : le suivant n'est plus imminent.
        this._abandonnerEntrante();
        this._fonduLance = false;

        const source = this._source;
        const generation = ++this._generation;

        source.definirGain(1);
        source.couperFiltre();

        try {
            await source.repositionner(Math.max(0, positionMs));
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
    async appliquerVitesse(vitesse) {
        if (!this.actif || !this._source) return;
        if (Math.abs(this._source.vitesse - vitesse) < 0.001) return;

        const position = this._source.positionMs;
        this._abandonnerEntrante();
        this._fonduLance = false;

        try {
            await this._source.repositionner(position, vitesse);
        } catch (err) {
            log.error('[MixEngine] Changement de vitesse impossible :', err.message);
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
    _horloge() {
        const source = this._source;
        if (!source || this._arrete) return;

        const reglages = this._reglages();
        const restant = this._restantMs(source);
        if (restant === null) return;

        const dureeFondu = reglages.mixEnabled ? this._dureeFondu(reglages) : 0;

        if (!this._entrante && !this._preparation && restant <= dureeFondu + AVANCE_PREPARATION_MS) {
            this._preparerSuivante(reglages);
        }

        if (reglages.mixEnabled && !this._fonduLance && this._entrante && restant <= dureeFondu) {
            // Le fondu ne peut pas durer plus longtemps qu'il ne reste de
            // musique : une durée annoncée trop généreuse laisserait sinon le
            // morceau sortant se taire avant d'avoir fini de descendre, et
            // l'entrant terminer sa montée dans le vide.
            this._lancerFondu(reglages, Math.min(dureeFondu, Math.max(500, restant)));
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
    _restantMs(source) {
        if (source.fluxTermine) return source.avanceMs;

        const duree = dureeMs(source.piste);
        if (!duree) return null;
        return Math.max(0, (duree - source.positionMs) / source.vitesse);
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
    _reglages() {
        const maintenant = Date.now();
        if (!this._reglagesCache || maintenant - this._reglagesLus > 200) {
            this._reglagesCache = database.getSettings(this.guildId);
            this._reglagesLus = maintenant;
        }
        return this._reglagesCache;
    }

    /** @param {object} reglages */
    _dureeFondu(reglages) {
        return Math.max(500, (parseFloat(reglages.mixDuration) || 5) * 1000);
    }

    /** @param {object} reglages */
    _vitesse(reglages) {
        const valeur = parseFloat(reglages.playbackSpeed || '1.0');
        return valeur > 0 ? valeur : 1;
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
    _pisteSuivantePrevisible() {
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
    _preparerSuivante(reglages) {
        const suivante = this._pisteSuivantePrevisible();
        if (!suivante) return;

        const source = new MixSource(suivante, {
            player: this.queue.player,
            vitesse: this._vitesse(reglages),
            gain: 0,
        });

        const preparation = source.demarrer()
            .then(() => {
                // `_abandonnerEntrante()` remet la préparation à zéro : c'est le
                // signal que ce morceau-là n'est plus attendu — un saut de piste,
                // un repositionnement.
                if (this._arrete || this._preparation !== preparation) {
                    source.arreter();
                    return;
                }
                this._entrante = source;
                this._pisteEntrante = suivante;
                log.debug(`[MixEngine] Morceau suivant prêt à être superposé : ${suivante.title}`);
            })
            .catch((err) => {
                log.error(`[MixEngine] Préparation impossible pour « ${suivante?.title} » :`, err.message);
                source.arreter();
            })
            .finally(() => {
                if (this._preparation === preparation) this._preparation = null;
            });

        this._preparation = preparation;
    }

    /** Verse le morceau suivant dans le bus et croise les deux gains. */
    _lancerFondu(reglages, dureeFondu) {
        const sortante = this._source;
        const entrante = this._entrante;
        if (!sortante || !entrante) return;

        this._fonduLance = true;

        // Loi de puissance constante des deux côtés : la somme des puissances
        // reste égale à un tout au long du croisement, là où deux rampes
        // linéaires creuseraient le niveau au milieu du fondu.
        sortante.fondre(0, dureeFondu, { courbe: 'puissance' });
        entrante.definirGain(0);
        entrante.fondre(1, dureeFondu, { courbe: 'puissance' });

        if (reglages.mixType === 'effects') {
            sortante.balayerFiltre('ferme');
            entrante.balayerFiltre('ouvre');
        }

        this.bus.ajouter(entrante);
        log.info(`[MixEngine] Fondu enchaîné de ${Math.round(dureeFondu / 1000)}s : `
            + `« ${sortante.piste?.title} » → « ${entrante.piste?.title} ».`);
    }

    /**
     * Une source vient d'être épuisée par le bus.
     * @param {MixSource} source
     */
    _surSourceEpuisee(source) {
        if (source !== this._source || this._arrete) return;

        // Aucun fondu n'a eu lieu — effet mix désactivé, ou durée inconnue —
        // mais le morceau suivant est décodé : il prend le relais sur la trame
        // suivante, donc sans blanc.
        if (this._entrante && !this._fonduLance) {
            this._entrante.definirGain(1);
            this.bus.ajouter(this._entrante);
        }

        const piste = this.queue.currentTrack;
        this._source = null;
        this._finEnAttente = source;
        source.arreter();

        // Sortir de la pile du flux avant de faire avancer la file : la suite
        // touche à la file d'attente, à l'historique et aux événements du bot.
        setImmediate(() => {
            if (this._arrete || this._finEnAttente !== source) return;
            this._finEnAttente = null;
            this._terminerPiste(piste);
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
    _terminerPiste(piste) {
        const dispatcher = this.queue.dispatcher;
        if (!dispatcher) return;

        this._definirPisteCourante(piste);
        const generation = this._generation;

        try {
            dispatcher.emit('finish', this.resource);
        } catch (err) {
            log.error('[MixEngine] Erreur pendant l\'enchaînement :', err.message);
        }

        // Personne n'a réclamé de nouveau morceau : la file est allée au bout.
        if (this._generation === generation && !this._source) {
            this._definirPisteCourante(null);
        }
    }

    /**
     * Signale l'échec d'un morceau, pour que la file ne reste pas bloquée.
     * @param {object} piste
     * @param {Error} erreur
     */
    _echouerPiste(piste, erreur) {
        try {
            this.queue.emit(GuildQueueEvent.PlayerError, this.queue, erreur, piste);
        } catch (e) {}

        // L'avancement est différé : l'échec survient au cœur de `jouer()`, que
        // discord-player a lui-même appelée en enchaînant. Reprendre la file
        // sur place empilerait un niveau d'appel par morceau illisible, et une
        // file entière de pistes mortes finirait par saturer la pile.
        const generation = this._generation;
        setImmediate(() => {
            if (this._arrete || this._generation !== generation) return;
            this._terminerPiste(piste);
        });
    }

    /** Fait du morceau superposé le morceau courant. */
    _promouvoirEntrante() {
        if (this._source) {
            this.bus.retirer(this._source);
            this._source.arreter();
        }

        this._source = this._entrante;
        this._entrante = null;
        this._pisteEntrante = null;
        this._fonduLance = false;

        if (this._source) {
            // Le fondu s'est peut-être achevé avant la fin du morceau sortant :
            // dans le doute, le gain nominal est rétabli et le filtre relâché.
            if (!this._source.enFondu) {
                this._source.definirGain(1);
                this._source.couperFiltre();
            }
            if (!this.bus.contient(this._source)) {
                this.bus.ajouter(this._source);
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
    annulerEnchainement() {
        if (!this.actif) return;
        this._abandonnerEntrante();
        this._fonduLance = false;
        if (this._source) {
            this._source.definirGain(1);
            this._source.couperFiltre();
        }
    }

    /** Abandonne le morceau préparé, qu'il ait déjà rejoint le bus ou non. */
    _abandonnerEntrante() {
        this._preparation = null;
        if (!this._entrante) return;
        this.bus?.retirer(this._entrante);
        this._entrante.arreter();
        this._entrante = null;
        this._pisteEntrante = null;
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
    _definirPisteCourante(piste) {
        if (this.resource) this.resource.metadata = piste || null;

        // `queue.currentTrack` retombe sur `__current` dès que la ressource
        // disparaît — au départ d'un salon vide, par exemple. Le tenir à jour
        // ici évite que la piste figée s'évapore avec le bus.
        this.queue.__current = piste || null;
    }

    /** Émet le signal de démarrage attendu par discord-player. */
    _signalerDemarrage() {
        try {
            this.queue.dispatcher?.emit('start', this.resource);
        } catch (err) {
            log.error('[MixEngine] Erreur à l\'annonce du démarrage :', err.message);
        }
    }

    // ─── Commandes ────────────────────────────────────────────────────────

    /**
     * Volume de diffusion.
     * @param {number} pourcent - 0 à 100
     * @returns {boolean}
     */
    definirVolume(pourcent) {
        if (!this.actif) return false;
        const borne = Math.max(0, Math.min(100, Number(pourcent) || 0));
        this._volume = borne;
        this.bus.definirGainMaitre(borne / 100);
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
    definirPause(enPause) {
        if (!this.actif) return false;
        return enPause ? this.lecteur.pause(true) : this.lecteur.unpause();
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
    enPause() {
        if (!this.actif) return false;
        return this.lecteur.state.status === AudioPlayerStatus.Paused;
    }

    /** @returns {boolean} */
    enLecture() {
        if (!this.actif) return false;
        return !!this._source && !this.enPause();
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
    _avanceChaineMs() {
        if (!this.bus || !this.resource) return 0;
        const emises = Math.round((this.resource.playbackDuration || 0) / DUREE_TRAME_MS);
        return Math.max(0, this.bus.tramesProduites - emises) * DUREE_TRAME_MS;
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
        const recul = this._avanceChaineMs() * source.vitesse;
        return Math.max(source.departMs, source.positionMs - recul);
    }

    /** Un fondu enchaîné est-il en cours ? */
    get enFonduEnchaine() {
        return this._fonduLance && !!this._entrante;
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
    etatFondu() {
        if (!this.enFonduEnchaine || !this._source) return null;

        const avance = this._avanceChaineMs();
        const decrire = (source) => {
            const position = Math.max(source.departMs, source.positionMs - avance * source.vitesse);
            const duree = dureeMs(source.piste);
            return {
                piste: source.piste,
                url: source.piste?.url || null,
                positionMs: position,
                dureeMs: duree,
                ratio: duree > 0 ? Math.min(1, Math.max(0, position / duree)) : 0,
            };
        };

        return { sortante: decrire(this._source), entrante: decrire(this._entrante) };
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
    get vitesse() {
        if (this._source) return this._source.vitesse;
        try {
            return this._vitesse(database.getSettings(this.guildId));
        } catch (e) {
            return 1;
        }
    }
}

module.exports = MixEngine;
