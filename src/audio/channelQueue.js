/**
 * channelQueue — La file d'attente rangée, salon vocal par salon vocal.
 *
 * ## Le problème
 *
 * La file n'existait nulle part. Ses titres vivaient dans le lecteur, et n'y
 * étaient recopiés — sous `queueBackupEveryone` ou `queueBackupPersonal` — que
 * le temps qu'une playlist lui prenne la place. Trois conséquences :
 *
 *  - un aiguillage n'avait aucun endroit où s'inscrire, faute de liste rangée
 *    où poser une position ;
 *  - le bot déplacé d'un salon à l'autre emportait la file du premier, si bien
 *    qu'un salon « soirée » et un salon « calme » se disputaient la même ;
 *  - la sauvegarde était par serveur, alors que ce qui écoute est un salon.
 *
 * ## L'approche
 *
 * Une liste par salon, rangée dans les réglages comme les playlists le sont
 * dans le stockage global. Le salon courant sert de clé ; hors de tout salon,
 * c'est le dernier fréquenté — le tableau de bord continue ainsi de montrer une
 * file, et l'on peut la préparer avant que le bot n'arrive.
 *
 * ## Qui fait foi, et jusqu'où
 *
 * C'est le point délicat, et il tient en une phrase : **le lecteur fait foi
 * pour la tête, le rangement pour la queue.**
 *
 * Quand la file est la source de lecture, ses premiers titres sont chargés dans
 * le lecteur — c'est là qu'ils vivent, qu'ils avancent et qu'ils se consomment.
 * Mais le lecteur ne reçoit rien au-delà du premier aiguillage (voir
 * `transitions`) : tout ce qui suit n'existe que dans le rangement, et il serait
 * effacé si la recopie se contentait de photographier le lecteur.
 *
 * Le miroir recolle donc les deux : ce que le lecteur a encore, suivi de tout ce
 * que le rangement gardait à partir de son premier aiguillage.
 *
 * ## Quand une playlist joue
 *
 * Rien n'est recopié : le lecteur ne porte plus la file mais la playlist, et la
 * photographier écraserait la file par des titres qui ne sont pas les siens. Le
 * rangement garde donc ce qu'il avait — ce qui est exactement le sens qu'avait
 * la « file mise de côté », désormais obtenu sans second stockage.
 */

const database = require('../database/Database');
const transitions = require('./transitions');

/**
 * Clé de rangement quand aucun salon n'a jamais été fréquenté.
 *
 * Un seau nommé plutôt qu'une absence de clé : ce qu'on prépare avant la
 * première connexion vocale doit se retrouver quelque part, et rejoindra le
 * premier salon rejoint.
 */
const NO_CHANNEL = '__no_channel__';

/**
 * Le salon dont la file est actuellement en jeu.
 *
 * Le dernier fréquenté à défaut du courant : c'est ce qui permet au tableau de
 * bord de continuer à montrer une file quand le bot a quitté son salon, plutôt
 * que de la faire disparaître sous les yeux de l'utilisateur.
 *
 * @param {object} settings
 * @returns {string}
 */
function keyOf(settings) {
    return (settings && settings.lastVoiceChannelId) || NO_CHANNEL;
}

/** Toutes les files rangées d'un serveur, sous une forme sûre à lire. */
function allOf(settings) {
    const stored = settings && settings.channelQueues;
    return (stored && typeof stored === 'object') ? stored : {};
}

/**
 * Remet à plat une sauvegarde d'avant ce module.
 *
 * `queueBackupEveryone` et `queueBackupPersonal` rangeaient la même file sous
 * deux clés selon le mode de diffusion — et l'écriture effaçait l'autre, si
 * bien qu'il n'y en avait jamais qu'une de vivante. Les deux sont donc lues
 * indifféremment, et la première non vide fait foi.
 *
 * @param {object} settings
 * @returns {object[]}
 */
function legacy(settings) {
    const forms = [settings.queueBackupEveryone, settings.queueBackupPersonal];
    for (const backup of forms) {
        if (!backup) continue;
        if (Array.isArray(backup.tracks) && backup.tracks.length) return backup.tracks.filter(Boolean);
        // `pistes` : du temps où ce module portait des noms français.
        if (Array.isArray(backup.pistes) && backup.pistes.length) return backup.pistes.filter(Boolean);
        const flat = [backup.virtualCurrentTrack, ...(backup.virtualTracks || [])].filter(Boolean);
        if (flat.length) return flat;
    }
    return [];
}

/**
 * La file rangée d'un salon, aiguillages compris.
 *
 * @param {object} settings
 * @param {string} [channelId] - Par défaut, le salon en jeu.
 * @returns {object[]}
 */
function read(settings, channelId) {
    if (!settings) return [];
    const key = channelId || keyOf(settings);

    const stored = allOf(settings)[key];
    if (Array.isArray(stored)) return stored.filter(Boolean);

    /*
     * Rien sous cette clé : la sauvegarde d'avant prend le relais, mais
     * seulement pour le salon en jeu. La reverser à chaque salon donnerait la
     * même file à tous, ce qui est précisément ce qu'on vient de défaire.
     */
    if (key === keyOf(settings)) return legacy(settings);
    return [];
}

/**
 * Écrit la file rangée d'un salon.
 *
 * @param {string} guildId
 * @param {object[]} tracks
 * @param {object} [settings] - Réglages déjà lus, s'ils sont sous la main.
 * @param {string} [channelId]
 */
function write(guildId, tracks, settings = null, channelId) {
    const effective = settings || database.getSettings(guildId);
    const key = channelId || keyOf(effective);
    const cleaned = (tracks || []).filter(Boolean);

    const next = Object.assign({}, allOf(effective));
    if (cleaned.length) next[key] = cleaned;
    else delete next[key];   // un salon sans file n'a pas besoin d'une entrée vide

    database.updateSettings(guildId, {
        channelQueues: next,
        // La sauvegarde d'avant a été reversée : la laisser vivante ferait deux
        // sources pour une même file, et l'on ne saurait plus laquelle croire.
        queueBackupEveryone: null,
        queueBackupPersonal: null,
    });
}

/**
 * Recopie l'état du lecteur dans le rangement, sans perdre ce qu'il ignore.
 *
 * Le lecteur fait foi pour la tête, le rangement pour la queue : ce que le
 * lecteur porte encore, suivi de tout ce que le rangement gardait à partir de
 * son premier aiguillage. Photographier le lecteur seul effacerait aiguillages
 * et titres suivants, qui ne lui ont jamais été confiés.
 *
 * @param {string} guildId
 * @param {object[]} live - La file telle que le lecteur la porte.
 * @param {object} settings
 */
function mirror(guildId, live, settings) {
    // Une playlist occupe le lecteur : ce qu'il porte n'est pas la file, et la
    // recopier l'écraserait par des titres qui ne sont pas les siens.
    const source = settings.activePlaybackSource || 'queue';
    if (source !== 'queue') return;

    const stored = read(settings);
    const at = stored.findIndex(transitions.isTransition);
    const tail = at === -1 ? [] : stored.slice(at);

    const next = [...(live || []).filter(Boolean), ...tail];

    // Rien n'a bougé : une écriture par diffusion d'état, soit une par seconde,
    // pour une liste qui ne change qu'aux gestes de l'utilisateur.
    if (sameList(next, stored)) return;

    write(guildId, next, settings);
}

/** Deux listes portent-elles les mêmes éléments, dans le même ordre ? */
function sameList(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
        if ((a[i] && a[i].url) !== (b[i] && b[i].url)) return false;
    }
    return true;
}

/**
 * Ce que le lecteur doit recevoir de la file : jusqu'au premier aiguillage.
 *
 * @param {object} settings
 * @returns {object[]}
 */
function playable(settings) {
    return transitions.upTo(read(settings), 0).tracks;
}

module.exports = {
    NO_CHANNEL,
    keyOf,
    read,
    write,
    mirror,
    playable,
};
