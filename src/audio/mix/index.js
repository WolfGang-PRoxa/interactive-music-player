/**
 * Registre des bus de mixage, un par serveur.
 *
 * Le moteur est associé à la file par une `WeakMap`, comme l'est déjà la
 * session de lecture : une file détruite emporte son bus, sans qu'aucun ménage
 * explicite ne soit à faire.
 *
 * Le point d'entrée est `ensureEngine()` : le pont posé sur le lecteur
 * l'appelle au moment de jouer, et c'est là que le bus se monte, une fois la
 * connexion vocale établie. Partout ailleurs, `activeEngine()` suffit — il rend
 * `null` quand la diffusion ne passe pas par le bus, et l'appelant retombe
 * alors sur le chemin d'origine de discord-player.
 */

const MixEngine = require('./MixEngine');
const database = require('../../database/Database');
const log = require('../../utils/logger');

/** @type {WeakMap<object, MixEngine>} file → moteur */
const engines = new WeakMap();

/**
 * La diffusion de ce serveur passe-t-elle par le bus ?
 *
 * En diffusion personnelle, le son sort du navigateur : le bot ne joue rien
 * dans le salon, et monter un bus n'aurait pas d'objet.
 *
 * @param {object} queue
 * @returns {boolean}
 */
function expectedBus(queue) {
    const guildId = queue?.guild?.id;
    if (!guildId) return false;
    try {
        return database.getSettings(guildId).broadcastMode !== 'personal';
    } catch (e) {
        return false;
    }
}

/**
 * Moteur en place pour cette file, s'il diffuse effectivement.
 *
 * Seule l'existence du bus fait foi, pas le mode de diffusion enregistré : au
 * moment de basculer en diffusion personnelle, le réglage change avant que
 * l'état de lecture ne soit relevé, et consulter le réglage ici ferait répondre
 * l'ancien chemin — avec une position de lecture qui n'a plus de sens. C'est
 * `removeEngine()` qui met fin au bus, explicitement.
 *
 * @param {object} queue
 * @returns {MixEngine|null}
 */
function activeEngine(queue) {
    if (!queue) return null;
    const engine = engines.get(queue);
    return engine && engine.active ? engine : null;
}

/**
 * Monte le bus si les conditions sont réunies, et le rend.
 *
 * @param {object} queue
 * @returns {MixEngine|null} null si la diffusion ne doit pas passer par le bus
 *   — l'appelant reprend alors le chemin d'origine.
 */
function ensureEngine(queue) {
    if (!queue || !expectedBus(queue)) return null;
    if (!queue.dispatcher?.voiceConnection) return null;

    const existing = engines.get(queue);
    if (existing && existing.active) {
        existing.checkSubscription();
        return existing;
    }

    const engine = new MixEngine(queue);
    try {
        if (!engine.start()) return null;
    } catch (err) {
        log.error('[MixEngine] Le bus de mixage n\'a pas pu être monté :', err.message);
        return null;
    }

    engines.set(queue, engine);
    return engine;
}

/**
 * Referme le bus d'une file, s'il y en a un.
 * @param {object} queue
 */
function removeEngine(queue) {
    const engine = queue && engines.get(queue);
    if (!engine) return;
    engine.stop();
    engines.delete(queue);
}

module.exports = { ensureEngine, activeEngine, removeEngine, expectedBus };
