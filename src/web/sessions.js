/**
 * sessions — Identités Discord reconnues par le tableau de bord.
 *
 * Le jeton de `auth.js` protège le serveur, mais ne dit pas *qui* est derrière
 * le navigateur : il est unique et partagé, donc anonyme. Le partage du
 * contrôle a besoin du contraire — savoir que cet onglet-ci est Paul, pour ne
 * lui laisser que ce que le maître de session lui a accordé.
 *
 * Une session naît d'un aller-retour OAuth2 (voir oauth.js) et vit dans un
 * cookie propre, distinct de celui du jeton maître. Elle est écrite sur disque :
 * l'invité ne doit pas avoir à se réauthentifier parce que le bot a redémarré,
 * ce qui arrive à chaque changement de version.
 *
 * Ce module ne connaît aucun droit. Il répond seulement « ce cookie est Paul,
 * identifiant 123… » ; c'est `permissions.js` qui dit ce que Paul peut faire.
 */

const crypto = require('crypto');
const path = require('path');
const { writeJsonAtomic, readJsonSafe, cleanStaleTemp } = require('../utils/atomicJson');
const log = require('../utils/logger');

const COOKIE_NAME = 'dashboard_session';
const SESSIONS_FILE = path.join(process.cwd(), 'data', 'sessions.json');

/**
 * Durée de vie d'une session, en millisecondes.
 *
 * Trente jours sans se montrer et l'accès retombe : un lien ouvert une fois sur
 * le téléphone d'un invité de passage ne doit pas rester valable indéfiniment.
 * Chaque requête repousse l'échéance, une session en usage régulier ne s'éteint
 * donc jamais.
 */
const MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30;

/**
 * Écriture différée.
 *
 * `touch()` est appelé à chaque requête HTTP et à chaque message WebSocket —
 * plusieurs fois par seconde pendant une lecture. Réécrire le fichier à chaque
 * fois n'apporterait rien : seul l'horodatage change, et sa précision à la
 * seconde près n'intéresse personne.
 */
const SAVE_DEBOUNCE_MS = 5000;

/** sessionId → { userId, username, displayName, avatar, createdAt, lastSeenAt } */
let store = null;
let saveTimer = null;

function load() {
    if (store) return store;

    cleanStaleTemp(SESSIONS_FILE);
    const raw = readJsonSafe(SESSIONS_FILE, '[Sessions]');
    store = raw && typeof raw === 'object' ? raw : {};

    const before = Object.keys(store).length;
    purgeExpired();
    const after = Object.keys(store).length;
    if (before !== after) {
        log.info(`[Sessions] ${before - after} expired session(s) dropped at load time.`);
    }

    return store;
}

function save() {
    if (!store) return;
    try {
        writeJsonAtomic(SESSIONS_FILE, store);
    } catch (err) {
        log.error(`[Sessions] Enregistrement impossible : ${err.message}`);
    }
}

/** Programme une écriture, en repoussant celle déjà prévue. */
function saveSoon() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        saveTimer = null;
        save();
    }, SAVE_DEBOUNCE_MS);
    // Une écriture en attente ne doit pas retenir le process au moment de sortir.
    if (typeof saveTimer.unref === 'function') saveTimer.unref();
}

function purgeExpired() {
    const now = Date.now();
    let touched = false;
    for (const [id, session] of Object.entries(store)) {
        if (!session || typeof session !== 'object' || now - (session.lastSeenAt || 0) > MAX_AGE_MS) {
            delete store[id];
            touched = true;
        }
    }
    return touched;
}

/**
 * Ouvre une session pour un compte Discord.
 *
 * Un compte en tient plusieurs à la fois, et il le faut : la même personne
 * ouvre le tableau de bord sur son ordinateur, sur celui du bureau, sur son
 * téléphone. N'en garder qu'une les faisait s'expulser mutuellement — se
 * connecter ici fermait la session de là-bas, dont le rechargement suivant
 * renvoyait à la porte, ce qui fermait celle d'ici à son tour. Une boucle sans
 * fin, et l'impression que la connexion ne tient jamais.
 *
 * Deux craintes avaient motivé la session unique, et une seule tenait :
 *
 *  - « révoquer un invité en oublierait » — non : `revokeUser` parcourt tout le
 *    magasin et ferme chaque session du compte, quel qu'en soit le nombre.
 *  - « chaque passage en laisserait une de plus » — celle-là est réelle, d'où un
 *    plafond : au-delà, les plus anciennes s'effacent d'elles-mêmes.
 *
 * @param {{ id: string, username: string, global_name?: string, avatar?: string }} user
 *   Réponse de `GET /users/@me`, telle que Discord la rend.
 * @returns {{ id: string, session: object }}
 */
function create(user) {
    load();
    keepRecent(String(user.id), MAX_PER_USER - 1);

    const id = crypto.randomBytes(32).toString('hex');
    const now = Date.now();

    store[id] = {
        userId: String(user.id),
        username: user.username || '',
        displayName: user.global_name || user.username || '',
        avatar: user.avatar
            ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64`
            : null,
        createdAt: now,
        lastSeenAt: now,
    };

    save();
    log.info(`[Sessions] Session opened for ${store[id].displayName} (${user.id}).`);
    return { id, session: store[id] };
}

/**
 * Retrouve une session valable.
 * @param {string|null|undefined} sessionId
 * @returns {object|null} La session, ou null si inconnue ou expirée.
 */
function get(sessionId) {
    if (!sessionId) return null;
    load();

    const session = store[sessionId];
    if (!session) return null;

    if (Date.now() - (session.lastSeenAt || 0) > MAX_AGE_MS) {
        delete store[sessionId];
        save();
        return null;
    }

    return session;
}

/**
 * Ferme une session, et une seule.
 *
 * Distincte de `revokeUser`, qui ferme les sessions d'un compte désigné :
 * celle-ci ferme celle que porte ce navigateur, sans avoir à savoir de qui elle
 * est. C'est le geste de son propre porteur — quitter son compte — et il ne doit
 * rien devoir à une identité qu'on vient précisément d'abandonner.
 *
 * @param {string} sessionId
 * @returns {boolean} La session existait-elle.
 */
function destroy(sessionId) {
    load();
    if (!sessionId || !store[sessionId]) return false;
    delete store[sessionId];
    save();
    return true;
}

/**
 * Nombre de sessions simultanées par compte.
 *
 * Assez pour les appareils d'une personne — deux ordinateurs, un téléphone, un
 * second navigateur — et assez peu pour qu'une suite de connexions ne laisse pas
 * une traînée indéfinie derrière elle.
 */
const MAX_PER_USER = 8;

/**
 * Ne garde que les `limit` sessions les plus récentes d'un compte.
 *
 * Les plus anciennes partent en premier : c'est celle qu'on vient d'utiliser
 * qu'il faut préserver, jamais celle qu'on a oubliée sur une machine prêtée.
 *
 * @param {string} userId
 * @param {number} limit
 */
function keepRecent(userId, limit) {
    const owned = Object.entries(store)
        .filter(([, session]) => session && session.userId === userId)
        .sort((a, b) => (b[1].lastSeenAt || 0) - (a[1].lastSeenAt || 0));

    for (const [id] of owned.slice(Math.max(0, limit))) delete store[id];
}

/** Repousse l'expiration d'une session encore active. */
function touch(sessionId) {
    const session = get(sessionId);
    if (!session) return null;
    session.lastSeenAt = Date.now();
    saveSoon();
    return session;
}

/**
 * Ferme toutes les sessions d'un compte.
 *
 * C'est ce que fait la révocation d'un invité : les droits disparaissent de la
 * base, et l'onglet resté ouvert perd son identité au message suivant.
 *
 * @param {string} userId
 * @returns {number} Nombre de sessions fermées.
 */
function revokeUser(userId) {
    load();
    let count = 0;
    for (const [id, session] of Object.entries(store)) {
        if (session && session.userId === String(userId)) {
            delete store[id];
            count++;
        }
    }
    if (count) {
        save();
        log.info(`[Sessions] ${count} session(s) closed for user ${userId}.`);
    }
    return count;
}

/**
 * Comptes reconnus au moins une fois, du plus récemment vu au plus ancien.
 *
 * Sert au tableau de bord du maître : un invité déjà authentifié n'a plus
 * besoin du lien, et doit apparaître même s'il a quitté le salon vocal.
 *
 * @returns {Array<{ userId: string, displayName: string, avatar: string|null, lastSeenAt: number }>}
 */
function listUsers() {
    load();

    /*
     * Un compte par ligne, et non une session par ligne.
     *
     * Depuis qu'une personne peut ouvrir le tableau de bord sur plusieurs
     * appareils, compter les sessions la ferait apparaître deux fois dans la
     * fenêtre de partage — deux lignes de droits pour un seul invité, dont on ne
     * saurait laquelle fait foi.
     */
    const byUser = new Map();
    for (const session of Object.values(store)) {
        if (!session) continue;
        const seen = session.lastSeenAt || 0;
        const known = byUser.get(session.userId);
        if (known && known.lastSeenAt >= seen) continue;
        byUser.set(session.userId, {
            userId: session.userId,
            displayName: session.displayName,
            avatar: session.avatar || null,
            lastSeenAt: seen,
        });
    }

    return [...byUser.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

/** Écrit sans attendre le délai — à l'extinction du process. */
function flush() {
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
    save();
}

module.exports = {
    COOKIE_NAME,
    SESSIONS_FILE,
    MAX_AGE_MS,
    create,
    get,
    touch,
    destroy,
    revokeUser,
    listUsers,
    flush,
};
