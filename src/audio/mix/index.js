/**
 * Registre des bus de mixage, un par serveur.
 *
 * Le moteur est associé à la file par une `WeakMap`, comme l'est déjà la
 * session de lecture : une file détruite emporte son bus, sans qu'aucun ménage
 * explicite ne soit à faire.
 *
 * Le point d'entrée est `assurerMoteur()` : le pont posé sur le lecteur
 * l'appelle au moment de jouer, et c'est là que le bus se monte, une fois la
 * connexion vocale établie. Partout ailleurs, `moteurActif()` suffit — il rend
 * `null` quand la diffusion ne passe pas par le bus, et l'appelant retombe
 * alors sur le chemin d'origine de discord-player.
 */

const MixEngine = require('./MixEngine');
const database = require('../../database/Database');
const log = require('../../utils/logger');

/** @type {WeakMap<object, MixEngine>} file → moteur */
const moteurs = new WeakMap();

/**
 * La diffusion de ce serveur passe-t-elle par le bus ?
 *
 * En diffusion personnelle, le son sort du navigateur : le bot ne joue rien
 * dans le salon, et monter un bus n'aurait pas d'objet.
 *
 * @param {object} queue
 * @returns {boolean}
 */
function busAttendu(queue) {
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
 * `retirerMoteur()` qui met fin au bus, explicitement.
 *
 * @param {object} queue
 * @returns {MixEngine|null}
 */
function moteurActif(queue) {
    if (!queue) return null;
    const moteur = moteurs.get(queue);
    return moteur && moteur.actif ? moteur : null;
}

/**
 * Monte le bus si les conditions sont réunies, et le rend.
 *
 * @param {object} queue
 * @returns {MixEngine|null} null si la diffusion ne doit pas passer par le bus
 *   — l'appelant reprend alors le chemin d'origine.
 */
function assurerMoteur(queue) {
    if (!queue || !busAttendu(queue)) return null;
    if (!queue.dispatcher?.voiceConnection) return null;

    const existant = moteurs.get(queue);
    if (existant && existant.actif) {
        existant.verifierAbonnement();
        return existant;
    }

    const moteur = new MixEngine(queue);
    try {
        if (!moteur.demarrer()) return null;
    } catch (err) {
        log.error('[MixEngine] Le bus de mixage n\'a pas pu être monté :', err.message);
        return null;
    }

    moteurs.set(queue, moteur);
    return moteur;
}

/**
 * Referme le bus d'une file, s'il y en a un.
 * @param {object} queue
 */
function retirerMoteur(queue) {
    const moteur = queue && moteurs.get(queue);
    if (!moteur) return;
    moteur.arreter();
    moteurs.delete(queue);
}

module.exports = { assurerMoteur, moteurActif, retirerMoteur, busAttendu };
