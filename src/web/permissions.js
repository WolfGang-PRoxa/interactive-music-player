/**
 * permissions — Ce qu'un invité a le droit de faire.
 *
 * Le maître de session — celui qui détient le jeton du tableau de bord, donc
 * celui qui a lancé le bot — peut tout. Les invités reconnus par Discord
 * (voir oauth.js et sessions.js) n'ont que ce qu'il leur a accordé, groupe par
 * groupe.
 *
 * **Le contrôle est ici, et nulle part ailleurs.** Le tableau de bord grise les
 * commandes interdites, mais ce n'est qu'une politesse envers l'invité : rien
 * n'empêche d'ouvrir la console du navigateur et d'envoyer le message à la
 * main. La seule barrière qui compte est celle que le serveur oppose, c'est
 * celle de ce module.
 *
 * Quatre groupes, et un cinquième cas implicite :
 *
 *   - `playback`  — mener la lecture en cours ;
 *   - `queue`     — décider de ce qui passe ensuite ;
 *   - `playlists` — modifier les collections enregistrées ;
 *   - `volume`    — volume, atténuation vocale, diffusion, qualité ;
 *   - le reste appartient au maître seul : éteindre le bot, changer de version,
 *     quitter un serveur, régler le préchargement.
 *
 * Un message inconnu de la table est refusé aux invités. C'est délibéré : une
 * commande ajoutée plus tard sans y penser sera fermée par défaut plutôt
 * qu'ouverte à tous.
 */

/** Les quatre groupes réglables, dans l'ordre où le tableau de bord les montre. */
const GROUPS = ['playback', 'queue', 'playlists', 'volume'];

/** Valeur de `ACTION_GROUPS` pour ce qui n'appartient qu'au maître. */
const MASTER_ONLY = Symbol('master');

/**
 * Valeur de `ACTION_GROUPS` pour les messages qui ne commandent rien.
 *
 * Un invité doit pouvoir demander l'état, remonter une erreur ou annoncer sa
 * progression de lecture : ce sont des messages de synchronisation, pas des
 * ordres. Les refuser ne protégerait rien et laisserait son tableau de bord
 * aveugle.
 */
const ALWAYS = null;

/**
 * Valeur de `ACTION_GROUPS` pour un message dont chaque champ relève d'un
 * groupe différent.
 *
 * `canSend` le laisse passer : ce n'est pas lui qui décide, mais
 * `filterSettings`, qui ne garde que les réglages permis. Un invité sans aucun
 * droit voit donc sa demande vidée de tout contenu, ce que l'appelant traite
 * comme un refus.
 */
const FIELD_FILTERED = Symbol('champs');

/**
 * Type de message WebSocket → groupe requis.
 *
 * `updateSettings` fait exception : il porte des réglages de plusieurs groupes
 * à la fois, et se filtre champ par champ — voir `SETTINGS_FIELDS`.
 */
const ACTION_GROUPS = {
    // Synchronisation et télémétrie
    requestState: ALWAYS,
    clientLog: ALWAYS,
    memoryStream: ALWAYS,
    syncProgress: ALWAYS,
    startupFadeinConsumed: ALWAYS,

    // Lecture
    resume: 'playback',
    pause: 'playback',
    stop: 'playback',
    skip: 'playback',
    previous: 'playback',
    seek: 'playback',
    setPlayMode: 'playback',
    // Choisir entre la file et une playlist, c'est décider de ce qui joue —
    // pas modifier une collection. D'où `playback` plutôt que `playlists`.
    setActivePlaybackSource: 'playback',
    // Le bouton lecture, lecteur vide : il démarre la source choisie, il n'y
    // ajoute rien. Même groupe que `resume`, dont il prend la suite.
    startPlaybackSource: 'playback',
    // Ecrire un fichier sur le disque du bot n'est pas piloter la
    // lecture : c'est ajouter, comme les trois autres destinations de
    // la meme boite. D'ou `queue`, le groupe de l'ajout.
    downloadTrack: 'queue',

    // File d'attente et historique.
    // `play` porte mal son nom : c'est l'ajout d'un résultat de recherche à la
    // file. Le bouton lecture, lui, envoie `resume`.
    play: 'queue',
    playNow: 'queue',
    removeTrack: 'queue',
    moveOrInsertTrack: 'queue',
    clearQueue: 'queue',
    clearHistory: 'queue',
    removeFromHistory: 'queue',

    // Playlists
    createPlaylist: 'playlists',
    renamePlaylist: 'playlists',
    deletePlaylist: 'playlists',
    addPlaylistTrack: 'playlists',
    addTrackToPlaylist: 'playlists',
    removeTrackFromPlaylist: 'playlists',
    movePlaylistTrack: 'playlists',
    // Poser un aiguillage revient à réécrire une playlist : même droit.
    insertTransition: 'playlists',
    // Modifier une transition relève du même droit que la poser, dans une
    // playlist comme dans la file : c'est une seule fonctionnalité.
    setTransitionTarget: 'playlists',
    reorderPlaylists: 'playlists',

    // Réparti champ par champ — voir SETTINGS_FIELDS
    updateSettings: FIELD_FILTERED,

    // Volume, atténuation, diffusion, qualité
    selectChannel: 'volume',
    requestTrackFormats: 'volume',
    setTrackQuality: 'volume',
    setTrackLoudness: 'volume',
    requestTrackLoudness: 'volume',
    toggleVoiceDetection: 'volume',

    // Maître seul
    leaveGuild: MASTER_ONLY,
    setDefaultChannel: MASTER_ONLY,
    restartBot: MASTER_ONLY,
    shutdownBot: MASTER_ONLY,
    listVersions: MASTER_ONLY,
    installVersion: MASTER_ONLY,
    uninstallVersion: MASTER_ONLY,

    // Partage du contrôle : seul le maître distribue les droits, sans quoi un
    // invité s'accorderait les siens.
    admitGuest: MASTER_ONLY,
    tunnelState: MASTER_ONLY,
    tunnelLogin: MASTER_ONLY,
    tunnelMount: MASTER_ONLY,
    tunnelUnmount: MASTER_ONLY,
    shareControl: MASTER_ONLY,
    revokeControl: MASTER_ONLY,
    sendInviteLink: MASTER_ONLY,
};

/**
 * Champs de `updateSettings` → groupe requis.
 *
 * Ce message est le seul chemin du tableau de bord vers les réglages du
 * serveur, et il mélange les genres : le volume principal y côtoie le délai de
 * départ du bot. Un invité ne voit donc pas sa demande refusée en bloc — les
 * champs qu'il a le droit de changer passent, les autres sont retirés.
 *
 * Tout champ absent de cette table revient au maître.
 */
const SETTINGS_FIELDS = {
    baseVolume: 'volume',
    duckingEnabled: 'volume',
    duckingLevel: 'volume',
    duckingDelay: 'volume',
    duckingFade: 'volume',
    broadcastMode: 'volume',
    importAudioQuality: 'volume',
    importVideoQuality: 'volume',

    playbackSpeed: 'playback',
    mixEnabled: 'playback',
    mixDuration: 'playback',
    mixType: 'playback',
    lufsSyncEnabled: 'playback',
    lufsSyncTarget: 'playback',
};

/** Droits d'un invité à qui rien n'a été accordé. */
function noPermissions() {
    return GROUPS.reduce((acc, group) => {
        acc[group] = false;
        return acc;
    }, {});
}

/** Droits du maître : tout, sans exception. */
function allPermissions() {
    return GROUPS.reduce((acc, group) => {
        acc[group] = true;
        return acc;
    }, {});
}

/**
 * Ramène une valeur venue du réseau à un jeu de droits sûr.
 *
 * Le maître envoie ce que son interface produit ; on ne s'y fie pas plus qu'au
 * reste. Seules les clés connues survivent, et seules des valeurs booléennes.
 *
 * @param {any} raw
 * @returns {{ playback: boolean, queue: boolean, playlists: boolean, volume: boolean }}
 */
function sanitize(raw) {
    const clean = noPermissions();
    if (!raw || typeof raw !== 'object') return clean;
    for (const group of GROUPS) {
        clean[group] = raw[group] === true;
    }
    return clean;
}

/** Cet invité a-t-il au moins un droit ? */
function hasAny(permissions) {
    return GROUPS.some((group) => permissions && permissions[group] === true);
}

/**
 * Ce demandeur peut-il envoyer ce message ?
 *
 * @param {{ master: boolean, permissions?: object }} identity
 * @param {string} type Type du message WebSocket.
 * @returns {boolean}
 */
function canSend(identity, type) {
    if (identity && identity.master) return true;

    const required = Object.prototype.hasOwnProperty.call(ACTION_GROUPS, type)
        ? ACTION_GROUPS[type]
        // Message inconnu : fermé par défaut. Voir l'en-tête du module.
        : MASTER_ONLY;

    if (required === ALWAYS) return true;
    if (required === FIELD_FILTERED) return true;
    if (required === MASTER_ONLY) return false;

    return Boolean(identity && identity.permissions && identity.permissions[required]);
}

/**
 * Ne garde d'un `updateSettings` que les réglages permis au demandeur.
 *
 * @param {{ master: boolean, permissions?: object }} identity
 * @param {object} data Charge utile du message.
 * @returns {{ allowed: object, refused: string[] }}
 */
function filterSettings(identity, data) {
    if (identity && identity.master) return { allowed: data || {}, refused: [] };

    const allowed = {};
    const refused = [];
    const permissions = (identity && identity.permissions) || noPermissions();

    for (const [field, value] of Object.entries(data || {})) {
        const group = SETTINGS_FIELDS[field];
        if (group && permissions[group]) allowed[field] = value;
        else refused.push(field);
    }

    return { allowed, refused };
}

module.exports = {
    GROUPS,
    MASTER_ONLY,
    FIELD_FILTERED,
    ACTION_GROUPS,
    SETTINGS_FIELDS,
    noPermissions,
    allPermissions,
    sanitize,
    hasAny,
    canSend,
    filterSettings,
};
