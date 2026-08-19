/**
 * PlaybackSession — état de lecture appartenant au projet.
 *
 * ## Le problème
 *
 * Le bot stockait une vingtaine de propriétés directement sur l'objet
 * `GuildQueue` de discord-player : `virtualCurrentTrack`, `channelStates`,
 * `transitioningToEveryone`… Aucune n'était déclarée nulle part ; leur
 * existence se découvrait en lisant les sites d'accès, chacun devant se
 * prémunir (`if (!queue.virtualTracks) queue.virtualTracks = []`). Une montée
 * de version de discord-player introduisant un nom identique aurait cassé le
 * bot silencieusement.
 *
 * ## L'approche
 *
 * L'état vit désormais dans une `PlaybackSession` que le projet possède, avec
 * un schéma déclaré et des valeurs initiales appliquées une fois pour toutes.
 *
 * Pour ne pas réécrire d'un bloc les 455 sites d'accès existants, des
 * accesseurs sont installés sur `GuildQueue.prototype` : lire ou écrire
 * `queue.virtualTracks` traverse la session. Le stockage a changé, la syntaxe
 * d'accès non. La migration des sites vers `session.virtualTracks` peut ensuite
 * se faire progressivement, fichier par fichier.
 *
 * La session est associée à la queue par une `WeakMap` : une nouvelle queue
 * repart d'un état neuf — comme avant — et l'état est libéré avec elle.
 */

const { GuildQueue } = require('discord-player');
const database = require('../database/Database');

/**
 * Schéma de l'état de lecture : nom → fabrique de valeur initiale.
 *
 * Les valeurs choisies sont équivalentes en comportement à l'absence de
 * propriété : le code existant écrivait `queue.virtualTracks || []`,
 * `queue.virtualProgressMs || 0`, `!!queue.isPendingTransition`. Elles
 * dispensent désormais des initialisations défensives.
 */
const SCHEMA = {
    // --- Lecteur virtuel (mode personnel) ---
    /** @type {object|null} Piste jouée par le navigateur */
    virtualCurrentTrack: () => null,
    /** @type {object[]} File d'attente virtuelle */
    virtualTracks: () => [],
    /** @type {object[]} Historique virtuel */
    virtualHistory: () => [],
    virtualIsPlaying: () => false,
    virtualIsPaused: () => false,
    /** @type {number} Position calculée par le serveur, en ms */
    virtualProgressMs: () => 0,
    /** @type {number} Horodatage du dernier avancement */
    virtualLastUpdated: () => 0,

    // --- État mémorisé par salon vocal ---
    /** @type {Object<string, object>} channelId → instantané de lecture */
    channelStates: () => ({}),
    /** @type {string|null} Salon considéré comme actif */
    activeChannelId: () => null,

    // --- Émetteur de silence (maintien de la connexion en mode personnel) ---
    silencePlayer: () => null,
    silenceStream: () => null,

    // --- Transition personnel → commun ---
    transitioningToEveryone: () => false,
    /** @type {object|null} Piste à reprendre */
    transitionTrack: () => null,
    /** @type {number} Position à restaurer, en ms */
    transitionTargetProgress: () => 0,
    transitionTimeout: () => null,
    /** @type {boolean} Verrou anti-double-saut */
    isPendingTransition: () => false,

    // --- Restauration au démarrage ---
    restorePaused: () => false,
    restoreProgress: () => 0,
    restoreShouldBePaused: () => false,

    // --- Enchaînement type DJ ---
    isMixFadingOut: () => false,
    /** @type {string|null} Piste ayant déjà reçu le fondu d'entrée */
    mixAppliedTrackId: () => null,
    /** @type {number} Début de la piste courante */
    trackStartedAt: () => 0,

    // --- Absence pour salon vide ---
    /**
     * @type {boolean} Le bot s'est retiré d'un salon vidé de ses humains, ou
     * n'y est jamais entré au démarrage.
     *
     * La file reste vivante en mémoire — piste courante, file d'attente,
     * historique —, seul le lecteur de discord-player a disparu avec la
     * connexion vocale. Les deux champs suivants tiennent lieu de lecteur en
     * attendant le retour.
     */
    absentEmptyChannel: () => false,
    /** @type {number} Position figée dans la piste courante, en ms */
    frozenPositionMs: () => 0,
    /** @type {boolean} La lecture était-elle en cours au moment du départ ? */
    frozenIsPlaying: () => false,

    // --- Divers ---
    pauseOnNextTrack: () => false,
};

const FIELDS = Object.keys(SCHEMA);

/** queue → session. Une queue libérée emporte sa session. */
const sessions = new WeakMap();

class PlaybackSession {
    /**
     * @param {import('discord-player').GuildQueue} queue
     */
    constructor(queue) {
        this.queue = queue;
        for (const name of FIELDS) {
            this[name] = SCHEMA[name]();
        }
    }

    /** @returns {string|undefined} */
    get guildId() {
        return this.queue?.guild?.id;
    }

    /** Diffusion dans le navigateur plutôt que dans le salon vocal. */
    get isPersonal() {
        const guildId = this.guildId;
        if (!guildId) return false;
        return database.getSettings(guildId).broadcastMode === 'personal';
    }

    // ─── Interface unifiée ────────────────────────────────────────────────
    // Masque la distinction entre lecteur réel et lecteur virtuel, pour que
    // les appelants cessent de brancher sur `isPersonal ? … : …`.

    /**
     * Piste en cours, quel que soit le mode.
     * @returns {object|null}
     */
    getCurrentTrack() {
        return this.isPersonal ? this.virtualCurrentTrack : (this.queue?.currentTrack || null);
    }

    /**
     * Pistes à venir, quel que soit le mode.
     * @returns {object[]}
     */
    getTracks() {
        if (this.isPersonal) return this.virtualTracks || [];
        return this.queue?.tracks ? this.queue.tracks.toArray() : [];
    }

    /**
     * Historique, de la piste la plus récente à la plus ancienne, quel que soit
     * le mode — l'ordre d'une file LIFO, que `history.tracks` et
     * `virtualHistory` suivent tous deux, et celui du panneau du tableau de
     * bord.
     *
     * @returns {object[]}
     */
    getHistory() {
        if (this.isPersonal) return this.virtualHistory || [];
        return this.queue?.history?.tracks ? this.queue.history.tracks.toArray() : [];
    }

    /**
     * La lecture est-elle figée par l'absence du bot ?
     *
     * Le lecteur de discord-player a été démonté avec la connexion vocale : il
     * ne sait plus rien de la piste ni de sa position, et l'interroger ne
     * rendrait que des zéros. Ce sont alors `positionFigeeMs` et
     * `lectureFigeeEnCours` qui font foi, jusqu'au retour du bot.
     *
     * Sans objet en diffusion personnelle : le son sort du navigateur, que la
     * présence du bot dans le salon ne concerne pas.
     *
     * La connexion vocale tranche, et non le seul drapeau : celui-ci a pu
     * rester levé alors que le bot est revenu — il joue alors réellement, et
     * répondre « gelée » figerait le tableau de bord sur une position d'avant
     * son retour, pendant que le son avance. Un lecteur démonté, lui, n'a plus
     * de connexion : les deux vont de pair.
     *
     * @returns {boolean}
     */
    isFrozen() {
        if (this.isPersonal || !this.absentEmptyChannel) return false;
        return !this.queue?.connection;
    }

    /** @returns {boolean} */
    getIsPlaying() {
        if (this.isFrozen()) return !!this.frozenIsPlaying;
        if (this.isPersonal) return !!this.virtualIsPlaying;
        if (this.transitioningToEveryone) return !this.restorePaused;
        try {
            return !!this.queue?.node?.isPlaying();
        } catch (e) {
            return false;
        }
    }

    /** @returns {boolean} */
    getIsPaused() {
        if (this.isPersonal) return !!this.virtualIsPaused;
        if (this.isFrozen()) return !this.frozenIsPlaying && !!this.queue?.currentTrack;
        if (this.transitioningToEveryone) return !!this.restorePaused;
        try {
            return !!this.queue?.node?.isPaused();
        } catch (e) {
            return false;
        }
    }

    /**
     * Ce que le tableau de bord doit expliquer d'une lecture qui n'avance pas.
     *
     * Le gel a deux visages. Une lecture mise en pause pendant l'absence du bot
     * n'a rien d'étonnant : elle ne bougerait pas davantage s'il était là. Une
     * lecture *en cours* et pourtant immobile, elle, dément tout ce que le
     * tableau de bord affiche par ailleurs — bouton pause, pochette qui tourne,
     * barre annoncée en progression. Sans un mot d'explication, il ne reste que
     * l'apparence d'une panne.
     *
     * Rendre l'état plutôt qu'un booléen laisse au tableau de bord le choix du
     * message : « la lecture reprendra à l'arrivée de quelqu'un » quand elle est
     * en cours, « le bot rejoindra le salon » quand elle est en pause.
     *
     * @returns {{enLecture: boolean}|null} `null` si rien n'est à expliquer.
     */
    listenerWait() {
        if (!this.isFrozen() || !this.getCurrentTrack()) return null;
        return { playing: !!this.frozenIsPlaying };
    }

}

/**
 * Session associée à une queue, créée à la première demande.
 * @param {import('discord-player').GuildQueue} queue
 * @returns {PlaybackSession}
 */
function getSession(queue) {
    let session = sessions.get(queue);
    if (!session) {
        session = new PlaybackSession(queue);
        sessions.set(queue, session);
    }
    return session;
}

/**
 * Installe les accesseurs sur le prototype de GuildQueue.
 *
 * Passer par le prototype couvre toutes les queues, quel que soit le chemin
 * qui les a créées — y compris celles que discord-player instancie lui-même,
 * hors de portée d'une interception de `queues.create()`.
 *
 * Les propriétés sont non énumérables : elles n'apparaissent donc pas dans une
 * sérialisation accidentelle de la queue, ce qui est plus sûr qu'auparavant.
 */
function installAccessors() {
    if (GuildQueue.prototype.__playbackSessionInstalled) return;

    for (const name of FIELDS) {
        Object.defineProperty(GuildQueue.prototype, name, {
            get() { return getSession(this)[name]; },
            set(value) { getSession(this)[name] = value; },
            configurable: true,
            enumerable: false,
        });
    }

    Object.defineProperty(GuildQueue.prototype, 'session', {
        get() { return getSession(this); },
        configurable: true,
        enumerable: false,
    });

    Object.defineProperty(GuildQueue.prototype, '__playbackSessionInstalled', {
        value: true,
        enumerable: false,
    });
}

installAccessors();

module.exports = {
    PlaybackSession,
    getSession,
    SCHEMA,
    FIELDS,
};
