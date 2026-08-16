/**
 * File d'attente mise de côté pendant qu'une playlist occupe le lecteur.
 *
 * ## Le problème
 *
 * Le lecteur n'a qu'une liste de pistes physique : quand une playlist en prend
 * la place, la file d'attente de l'utilisateur est rangée dans les réglages.
 * Elle y était écrite sous **deux formes** selon le mode de diffusion —
 * `queueBackupPersonal` `{ virtualCurrentTrack, virtualTracks }` d'un côté,
 * `queueBackupEveryone` `{ tracks }` de l'autre.
 *
 * Changer de mode faisait donc lire l'interface dans la sauvegarde de l'autre
 * mode, restée vide : la file paraissait effacée alors qu'elle dormait à côté.
 * Les deux formes divergeaient de surcroît d'un titre — la première réservait
 * son premier élément à `virtualCurrentTrack`, que le panneau n'affichait pas —,
 * si bien que le même contenu ne montrait pas le même nombre de pistes d'un mode
 * à l'autre.
 *
 * ## L'approche
 *
 * Une seule liste, à plat, dans les deux modes. Rien n'y est « courant » : rien
 * de cette file ne joue tant que la playlist occupe le lecteur. C'est au retour
 * à la file que son premier titre reprend la lecture, et ce choix appartient à
 * ce moment-là, pas au stockage.
 *
 * La lecture accepte encore les formes antérieures : une sauvegarde écrite par
 * une version plus ancienne est mise à plat à la volée, `virtualCurrentTrack` en
 * tête puisque c'est le titre qui repartait en premier. La clé `pistes`, écrite
 * lorsque ce module portait des noms français, est lue au même titre.
 */

const database = require('../database/Database');

/** Clé de réglage portant la sauvegarde d'un mode. */
const KEYS = {
    personal: 'queueBackupPersonal',
    everyone: 'queueBackupEveryone',
};

/**
 * Mode de diffusion sous sa forme canonique.
 * @param {object} settings
 * @returns {'personal'|'everyone'}
 */
function modeOf(settings) {
    return settings?.broadcastMode === 'personal' ? 'personal' : 'everyone';
}

/**
 * Met une sauvegarde à plat, quelle que soit la forme sous laquelle elle a été
 * écrite.
 *
 * @param {object|null} backup
 * @returns {object[]}
 */
function flatten(backup) {
    if (!backup) return [];
    if (Array.isArray(backup.tracks)) return backup.tracks.filter(Boolean);

    // Formes antérieures : `{ pistes }`, du temps où ce module portait des noms
    // français, et `{ virtualCurrentTrack, virtualTracks }` en diffusion
    // personnelle, dont le premier champ portait le titre qui aurait repris la
    // lecture.
    if (Array.isArray(backup.pistes)) return backup.pistes.filter(Boolean);
    return [backup.virtualCurrentTrack, ...(backup.virtualTracks || [])].filter(Boolean);
}

/**
 * File mise de côté d'un serveur, dans l'ordre où elle sera reprise.
 *
 * Les deux sauvegardes sont consultées, celle du mode courant d'abord : un
 * changement de mode antérieur à cette unification a pu laisser la file dans
 * l'autre.
 *
 * @param {object} settings - Réglages de la guild
 * @returns {object[]}
 */
function readSetAsideQueue(settings) {
    if (!settings) return [];
    const mode = modeOf(settings);
    const current = flatten(settings[KEYS[mode]]);
    if (current.length > 0) return current;
    return flatten(settings[KEYS[mode === 'personal' ? 'everyone' : 'personal']]);
}

/**
 * Écrit la file mise de côté d'un serveur.
 *
 * Elle est rangée sous la clé du mode courant, et celle de l'autre mode est
 * effacée : deux sauvegardes vivantes en même temps, et l'on ne saurait plus
 * laquelle fait foi.
 *
 * @param {string} guildId
 * @param {object[]} tracks
 * @param {object} [settings] - Réglages déjà lus, s'ils sont sous la main
 */
function writeSetAsideQueue(guildId, tracks, settings = null) {
    const effective = settings || database.getSettings(guildId);
    const mode = modeOf(effective);
    const cleaned = (tracks || []).filter(Boolean);

    database.updateSettings(guildId, {
        [KEYS[mode]]: cleaned.length > 0 ? { tracks: cleaned } : null,
        [KEYS[mode === 'personal' ? 'everyone' : 'personal']]: null,
    });
}

/**
 * Range la file mise de côté sous la clé du nouveau mode.
 *
 * Appelée au changement de mode de diffusion : sans elle, l'interface irait
 * chercher la file dans une sauvegarde que ce mode-là n'a jamais écrite.
 *
 * @param {string} guildId
 * @param {'personal'|'everyone'} newMode
 */
function convertForMode(guildId, newMode) {
    const settings = database.getSettings(guildId);
    const tracks = readSetAsideQueue(settings);
    writeSetAsideQueue(guildId, tracks, { ...settings, broadcastMode: newMode });
}

module.exports = {
    readSetAsideQueue,
    writeSetAsideQueue,
    convertForMode,
};
