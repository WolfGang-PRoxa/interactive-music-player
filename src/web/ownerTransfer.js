/**
 * ownerTransfer — Reprendre l'installation demande d'être devant la machine.
 *
 * ## Le problème
 *
 * `owner.js` pose une règle juste : la propriété revient à qui est devant la
 * machine. Elle en déduisait une preuve qui a cessé de l'être — tenir le jeton.
 *
 * Le jeton s'écrivait dans la console, et rien d'autre ne le portait ; le tenir
 * voulait alors bien dire ce qu'on croyait. Il voyage depuis en `?token=` dans
 * la barre d'adresse, se dépose dans l'historique du navigateur, entre dans le
 * manifeste de l'application installée, et s'est même retrouvé dans les
 * journaux du bot. Le porter ne prouve plus qu'on est devant la machine ;
 * seulement qu'on l'a vu passer quelque part.
 *
 * Or `transfer()` écrase `data/owner.json` sans autre condition. Qui récupérait
 * le jeton devenait propriétaire, donc obtenait `allPermissions()` : éteindre le
 * bot, installer une version arbitraire, révoquer le propriétaire légitime.
 *
 * ## L'approche
 *
 * La preuve redevient la console. Une demande de transfert y fait écrire un
 * code à usage unique, que le demandeur doit recopier dans le tableau de bord.
 * Le lire suppose l'accès à la fenêtre où le bot tourne — c'est-à-dire, cette
 * fois pour de bon, être devant la machine.
 *
 * Le jeton n'est pas pour autant congédié : il reste ce qui ouvre la demande.
 * Il faut donc les deux, et ils ne se trouvent pas au même endroit.
 *
 * ## Ce qui n'est pas concerné
 *
 * La **revendication initiale** — `owner.claim()` sur une installation neuve —
 * garde son fonctionnement. Elle n'écrase personne, n'a lieu qu'une fois, et
 * l'exiger d'un code ferait buter le premier démarrage sur une étape que rien
 * n'annonce. Ce module ne traite que la reprise d'une installation qui a déjà
 * un propriétaire.
 */

const crypto = require('crypto');
const owner = require('./owner');
const log = require('../utils/logger');

/**
 * Durée de vie d'une demande, en millisecondes.
 *
 * Assez pour basculer sur la fenêtre du bot, lire six caractères et revenir ;
 * assez peu pour qu'un code aperçu par-dessus une épaule ne serve plus le
 * lendemain.
 */
const TTL_MS = 2 * 60 * 1000;

/**
 * Essais autorisés avant qu'une demande ne soit close.
 *
 * Le code tient sur 32 bits d'entropie ; trois essais rendent la devinette sans
 * objet, et suffisent largement à corriger une faute de frappe.
 */
const MAX_ATTEMPTS = 3;

/** id → { code, userId, username, avatar, createdAt, attempts } */
const pending = new Map();

function purge(now = Date.now()) {
  for (const [id, demande] of pending.entries()) {
    if (now - demande.createdAt > TTL_MS) pending.delete(id);
  }
}

/**
 * Code lisible à voix haute et sans ambiguïté.
 *
 * L'alphabet écarte `O`, `I`, `0` et `1`, qu'on confond en les recopiant depuis
 * une console. Le tiret ne sert qu'à découper : il est ignoré à la lecture.
 *
 * @returns {string} Par exemple « 4F2A-9K ».
 */
function makeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const octets = crypto.randomBytes(6);
  const chars = [...octets].map((b) => alphabet[b % alphabet.length]);
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}

/** Retire ce qui n'est pas signifiant : tirets, espaces, casse. */
function normalise(code) {
  return String(code || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/** Comparaison à temps constant, comme celle du jeton dans web/auth.js. */
function safeEquals(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Ouvre une demande de transfert et écrit son code dans la console.
 *
 * @param {{ id: string, username?: string, avatar?: string|null }} user
 *   Le compte qui demande à reprendre l'installation.
 * @returns {string} L'identifiant de la demande, à porter jusqu'au formulaire.
 *   Le code, lui, ne sort que par la console.
 */
function open(user) {
  purge();

  const id = crypto.randomBytes(16).toString('hex');
  const code = makeCode();

  pending.set(id, {
    code: normalise(code),
    userId: String(user.id),
    username: user.username || String(user.id),
    avatar: user.avatar || null,
    createdAt: Date.now(),
    attempts: 0,
  });

  /*
   * Écrit en évidence, et pour la console seule.
   *
   * Ces lignes passent par le logger, donc par l'historique que le tableau de
   * bord sert — au maître, et filtré pour les autres (voir logVisibility.js,
   * où `[Owner]` ne figure pas dans les étiquettes ouvertes aux invités). Le
   * code reste ainsi sous les yeux de qui est devant la machine.
   */
  log.warn('');
  log.warn('  ╔══════════════════════════════════════════════════╗');
  log.warn("  ║  DEMANDE DE REPRISE DE L'INSTALLATION             ║");
  log.warn('  ╚══════════════════════════════════════════════════╝');
  log.warn(`  Compte demandeur : ${user.username || user.id} (${user.id})`);
  log.warn(`  Code à recopier  : ${code}`);
  log.warn(
    `  Valable ${Math.round(TTL_MS / 1000)} secondes. Ignorez ce message si ` +
      "vous n'êtes pas à l'origine de cette demande.",
  );
  log.warn('');

  return id;
}

/**
 * Une demande est-elle encore ouverte sous cet identifiant ?
 * @param {string} id
 * @returns {{ username: string, userId: string }|null}
 */
function peek(id) {
  purge();
  const demande = pending.get(id);
  if (!demande) return null;
  return { username: demande.username, userId: demande.userId };
}

/**
 * Vérifie un code et, s'il répond, transfère la propriété.
 *
 * @param {string} id Identifiant de la demande.
 * @param {string} code Ce que le demandeur a recopié.
 * @param {string} sessionUserId Compte réellement connecté dans ce navigateur.
 * @returns {{ ok: true } | { ok: false, reason: 'unknown'|'mismatch'|'wrong', left?: number }}
 */
function confirm(id, code, sessionUserId) {
  purge();

  const demande = pending.get(id);
  if (!demande) return { ok: false, reason: 'unknown' };

  /*
   * Le code ne vaut que pour celui qui l'a demandé.
   *
   * Sans cette vérification, un code aperçu dans la console servirait à
   * n'importe quel compte connecté : il suffirait d'ouvrir le formulaire
   * depuis une autre session pour s'approprier une demande faite par un autre.
   */
  if (String(sessionUserId) !== demande.userId) {
    return { ok: false, reason: 'mismatch' };
  }

  demande.attempts++;
  if (!safeEquals(normalise(code), demande.code)) {
    const left = MAX_ATTEMPTS - demande.attempts;
    if (left <= 0) {
      pending.delete(id);
      log.warn(`[Owner] Transfer request closed: ${MAX_ATTEMPTS} wrong codes.`);
      return { ok: false, reason: 'unknown' };
    }
    log.warn(`[Owner] Wrong transfer code (${left} attempt(s) left).`);
    return { ok: false, reason: 'wrong', left };
  }

  pending.delete(id);
  owner.transfer({
    id: demande.userId,
    username: demande.username,
    avatar: demande.avatar,
  });
  return { ok: true };
}

/** Ferme toutes les demandes. Réservé aux tests. */
function reset() {
  pending.clear();
}

module.exports = { TTL_MS, MAX_ATTEMPTS, open, peek, confirm, reset, makeCode, normalise };
