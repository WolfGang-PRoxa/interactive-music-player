/**
 * File d'attente mise de côté pendant qu'une playlist occupe le lecteur.
 *
 * ## Ce que ce module est devenu
 *
 * Une façade. La file n'est plus « mise de côté » nulle part : elle est rangée
 * en permanence, salon vocal par salon vocal, par [channelQueue](../audio/channelQueue.js).
 * « Mise de côté » ne décrit plus un stockage mais un moment — celui où une
 * playlist occupe le lecteur et où la file, rangée comme toujours, n'est
 * simplement pas jouée.
 *
 * ## Pourquoi la façade demeure
 *
 * Une vingtaine d'endroits appellent ces trois fonctions, et leur question n'a
 * pas changé : « que contient la file, et comment l'écrire ». Les réécrire tous
 * pour renommer un concept aurait touché sept fichiers sans rien corriger.
 *
 * ## Ce qui a disparu, et pourquoi ce n'est pas une perte
 *
 * La sauvegarde était rangée sous deux clés selon le mode de diffusion —
 * `queueBackupPersonal` et `queueBackupEveryone`. Mais l'écriture effaçait
 * l'autre clé et la lecture y retombait : il n'y avait jamais qu'une file
 * vivante. La séparation ne portait donc rien, et `channelQueue` lit encore ces
 * deux clés pour reverser ce qu'une version antérieure y avait laissé.
 */

const channelQueue = require('../audio/channelQueue');

/**
 * File rangée du salon en jeu, dans l'ordre où elle sera reprise.
 *
 * @param {object} settings - Réglages de la guild
 * @returns {object[]}
 */
function readSetAsideQueue(settings) {
  return channelQueue.read(settings);
}

/**
 * Écrit la file rangée du salon en jeu.
 *
 * @param {string} guildId
 * @param {object[]} tracks
 * @param {object} [settings] - Réglages déjà lus, s'ils sont sous la main
 */
function writeSetAsideQueue(guildId, tracks, settings = null) {
  channelQueue.write(guildId, tracks, settings);
}

/**
 * Ne fait plus rien, et c'est le but.
 *
 * Ce module rangeait la file sous la clé du mode de diffusion, si bien qu'un
 * changement de mode devait la déménager. Le rangement suit désormais le salon
 * vocal, que le mode de diffusion ne change pas : il n'y a plus rien à
 * déplacer. La fonction demeure pour que `BroadcastManager` n'ait pas à savoir
 * qu'un problème a cessé d'exister.
 */
function convertForMode() {}

module.exports = {
  readSetAsideQueue,
  writeSetAsideQueue,
  convertForMode,
};
