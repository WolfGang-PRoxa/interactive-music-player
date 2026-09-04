/**
 * owner — Le compte Discord qui possède ce tableau de bord.
 *
 * ## Le problème
 *
 * Le jeton de `auth.js` ouvre tout, mais il est anonyme : il dit « celui qui
 * frappe connaît le secret », jamais « celui qui frappe est Paul ». Tant que le
 * maître restait le seul à ne pas s'identifier, les journaux, le partage du
 * contrôle et la liste des invités parlaient de tout le monde sauf de lui.
 *
 * ## L'approche
 *
 * Le propriétaire est le **premier compte Discord à se connecter en présentant
 * le jeton**. Ce n'est pas un raccourci : le jeton est écrit dans la console de
 * celui qui a lancé le bot, et le lien d'invitation posté aux auditeurs ne le
 * porte pas. Le tenir, c'est être devant la machine — précisément ce que le
 * propriétaire est, et ce qu'un invité n'est pas.
 *
 * Rien à configurer, donc, et rien à documenter de plus : l'installation se
 * nomme elle-même au premier démarrage. Le choix est ensuite définitif tant que
 * `data/owner.json` existe ; le supprimer rend l'installation à qui la relance
 * avec le jeton, ce qui est le geste de reprise en main attendu quand un compte
 * est perdu.
 *
 * Ce module ne connaît aucun droit. Il répond seulement « cette installation
 * appartient à Paul » ; c'est `permissions.js` qui dit ce que Paul peut faire.
 */

const path = require('path');
const fs = require('fs');
const { writeJsonAtomic, readJsonSafe, cleanStaleTemp } = require('../utils/atomicJson');
const log = require('../utils/logger');

const OWNER_FILE = path.join(process.cwd(), 'data', 'owner.json');

/** @type {{ id: string, username: string, avatar: string|null, since: number }|null} */
let owner = null;
let loaded = false;

function load() {
    if (loaded) return;
    loaded = true;

    cleanStaleTemp(OWNER_FILE);
    const stored = readJsonSafe(OWNER_FILE, '[Owner]');
    if (stored && stored.id) {
        owner = stored;
        log.info(`[Owner] Dashboard owned by ${owner.username} (${owner.id}).`);
    }
}

/**
 * Propriétaire enregistré, ou null si l'installation n'a pas encore été
 * revendiquée.
 *
 * @returns {{ id: string, username: string, avatar: string|null, since: number }|null}
 */
function get() {
    load();
    return owner;
}

/** Une installation sans propriétaire attend son premier compte. */
function isClaimed() {
    return get() !== null;
}

/**
 * Enregistre un compte comme propriétaire, s'il n'y en a pas déjà un.
 *
 * N'écrase jamais : la revendication est un acte unique. Un second compte qui
 * se connecterait avec le jeton n'y gagne rien, et c'est voulu — sinon le
 * dernier arrivé déposséderait le premier, et le partage du contrôle
 * n'existerait plus.
 *
 * @param {{ id: string, username: string, avatar?: string|null }} user
 * @returns {boolean} true si ce compte vient d'être fait propriétaire
 */
function claim(user) {
    load();
    if (owner || !user || !user.id) return false;

    owner = {
        id: String(user.id),
        username: user.username || String(user.id),
        avatar: user.avatar || null,
        since: Date.now(),
    };

    try {
        writeJsonAtomic(OWNER_FILE, owner);
        log.success(`[Owner] Dashboard claimed by ${owner.username} (${owner.id}).`);
    } catch (err) {
        // Sans écriture, la revendication ne survit pas au redémarrage : elle
        // vaut pour cette session, et le prochain lancement la redemandera.
        log.error('[Owner] Could not record the owner:', err.message);
    }
    return true;
}

/**
 * Cette session est-elle celle du propriétaire ?
 * @param {{ userId?: string }|null} session
 * @returns {boolean}
 */
function isOwner(session) {
    const current = get();
    return Boolean(current && session && session.userId
        && String(session.userId) === current.id);
}

/**
 * Oublie le propriétaire. Réservé aux tests : en exploitation, la reprise en
 * main passe par la suppression du fichier, geste délibéré et visible.
 */
function forget() {
    owner = null;
    loaded = false;
    try { fs.rmSync(OWNER_FILE, { force: true }); } catch (e) {}
}

module.exports = { get, isClaimed, claim, isOwner, forget, OWNER_FILE };
