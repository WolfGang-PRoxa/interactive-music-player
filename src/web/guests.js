/**
 * guests — Le carnet des personnes déjà venues.
 *
 * ## Le problème
 *
 * Le maître ne voyait ses invités qu'à travers `sessions.js`, c'est-à-dire à
 * travers les cookies encore valables. Une session dure trente jours, se fait
 * évincer au-delà de huit appareils, et disparaît dès qu'on la révoque : passé
 * ce délai, l'invité s'effaçait de la fenêtre de partage — nom et avatar
 * compris — alors que ses droits, eux, étaient toujours inscrits dans les
 * réglages du serveur. Restait une ligne portant un identifiant numérique, ou
 * pas de ligne du tout.
 *
 * Le carnet répare cela en séparant deux questions qui n'avaient pas à être
 * mêlées :
 *
 *   - *qui est cette personne ?* — ici, durablement, indépendamment de tout
 *     cookie ;
 *   - *cet onglet-ci est-il à elle ?* — dans `sessions.js`, avec la durée de
 *     vie courte que cela mérite.
 *
 * ## Ce qu'il n'est pas
 *
 * Ce carnet n'accorde rien et ne prouve rien. Y figurer signifie « ce compte
 * s'est authentifié auprès de ce bot au moins une fois », jamais « ce compte a
 * le droit de… » — les droits vivent par serveur dans les réglages, et
 * l'admission dans `admittedGuests`. Il ne contient donc aucun secret : ni
 * jeton, ni jeton d'accès Discord, rien qui permette de se faire passer pour
 * quelqu'un.
 *
 * Un invité révoqué en sort (voir `forget`) : le carnet est la mémoire des
 * personnes qu'on veut retrouver, pas un journal de tous les passages.
 *
 * ## Il ne périme pas, et c'est voulu
 *
 * Une session s'éteint au bout de trente jours ; une fiche, non. C'est tout
 * l'intérêt — un invité accepté l'an dernier doit rester nommé et illustré dans
 * la fenêtre du maître, sans quoi on retombe exactement sur le défaut qu'on
 * vient de corriger.
 *
 * La contrepartie est que quelqu'un qui suit le lien sans jamais être accepté
 * reste dans la file des demandes tant qu'on ne lui a pas répondu. C'est le
 * comportement voulu — une question posée ne s'efface pas d'elle-même au bout
 * d'un mois —, et « Refuser » est la réponse qui l'efface. Si un jour le lien
 * circulait assez loin pour que la file devienne encombrante, c'est un plafond
 * sur les fiches *ni admises ni pourvues* qu'il faudrait poser, et non une
 * péremption générale qui reprendrait le défaut par l'autre bout.
 */

const path = require('path');
const { writeJsonAtomic, readJsonSafe, cleanStaleTemp } = require('../utils/atomicJson');
const log = require('../utils/logger');

const GUESTS_FILE = path.join(process.cwd(), 'data', 'guests.json');

/**
 * Écriture différée.
 *
 * `touch()` est appelé à chaque connexion WebSocket et à chaque retour de
 * Discord. Réécrire le fichier à chaque fois n'apporterait rien : seul
 * l'horodatage change, et sa précision à la seconde près n'intéresse personne.
 */
const SAVE_DEBOUNCE_MS = 5000;

/** userId → { userId, username, displayName, avatar, firstSeenAt, lastSeenAt } */
let store = null;
let saveTimer = null;

function load() {
  if (store) return store;

  cleanStaleTemp(GUESTS_FILE);
  const raw = readJsonSafe(GUESTS_FILE, '[Guests]');
  store = raw && typeof raw === 'object' ? raw : {};

  const count = Object.keys(store).length;
  if (count) log.info(`[Guests] ${count} known account(s) loaded.`);

  return store;
}

function save() {
  if (!store) return;
  try {
    writeJsonAtomic(GUESTS_FILE, store);
  } catch (err) {
    log.error(`[Guests] Cannot save the guest book: ${err.message}`);
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

/**
 * L'adresse d'un avatar Discord, ou null pour un compte qui n'en a pas.
 *
 * Discord ne rend qu'un condensé ; l'URL complète se reconstruit. La taille est
 * fixée ici plutôt qu'à l'affichage : c'est elle qui décide du poids de
 * l'image, et 64 pixels suffisent à une pastille.
 */
function avatarUrl(user) {
  if (!user || !user.avatar) return null;
  return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64`;
}

/**
 * Inscrit — ou rafraîchit — un compte revenu de Discord.
 *
 * Le nom et l'avatar sont réécrits à chaque passage : quelqu'un qui change de
 * pseudonyme doit apparaître sous le nouveau dans la fenêtre de partage, sans
 * quoi le maître chercherait une personne qui ne s'appelle plus ainsi.
 *
 * `firstSeenAt` ne bouge jamais : c'est la date de la première venue, et elle
 * dit au maître s'il a affaire à un habitué ou à un inconnu.
 *
 * @param {{ id: string, username?: string, global_name?: string, avatar?: string }} user
 *   Réponse de `GET /users/@me`, telle que Discord la rend.
 * @returns {object} La fiche enregistrée.
 */
function remember(user) {
  load();
  if (!user || !user.id) return null;

  const id = String(user.id);
  const now = Date.now();
  const known = store[id];

  store[id] = {
    userId: id,
    username: user.username || known?.username || '',
    displayName: user.global_name || user.username || known?.displayName || id,
    avatar: avatarUrl(user) || known?.avatar || null,
    firstSeenAt: known?.firstSeenAt || now,
    lastSeenAt: now,
  };

  save();
  if (!known) log.info(`[Guests] New account known: ${store[id].displayName} (${id}).`);
  return store[id];
}

/**
 * La fiche d'un compte, ou null s'il n'est jamais venu.
 * @param {string} userId
 * @returns {object|null}
 */
function get(userId) {
  load();
  return store[String(userId)] || null;
}

/** Ce compte s'est-il déjà authentifié auprès de ce bot ? */
function isKnown(userId) {
  return get(userId) !== null;
}

/**
 * Note qu'un compte vient de se manifester.
 *
 * Appelé à l'ouverture d'une connexion WebSocket, et non à chaque message : ce
 * qui nous intéresse est « quand cette personne est-elle venue pour la dernière
 * fois », pas la seconde exacte de son dernier clic.
 *
 * @param {string} userId
 * @param {{ displayName?: string, avatar?: string }} [refresh] Ce que la session
 *   sait de plus frais, pour les fiches d'avant le carnet.
 */
function touch(userId, refresh = {}) {
  load();
  const id = String(userId || '');
  const known = store[id];
  if (!known) return null;

  known.lastSeenAt = Date.now();
  if (refresh.displayName) known.displayName = refresh.displayName;
  if (refresh.avatar) known.avatar = refresh.avatar;
  saveSoon();
  return known;
}

/**
 * Efface un compte du carnet.
 *
 * C'est le geste du refus : le maître ne veut plus voir cette personne dans sa
 * fenêtre, et la retrouver à la ligne suivante serait exactement le contraire
 * de ce qu'il vient de demander. Elle pourra revenir — rien ne l'interdit — mais
 * en frappant de nouveau à la porte, ce qui est la situation d'un inconnu.
 *
 * @param {string} userId
 * @returns {boolean} La fiche existait-elle.
 */
function forget(userId) {
  load();
  const id = String(userId || '');
  if (!store[id]) return false;
  delete store[id];
  save();
  log.info(`[Guests] Account ${id} dropped from the guest book.`);
  return true;
}

/**
 * Tout le carnet, du plus récemment vu au plus ancien.
 *
 * @returns {Array<{ userId: string, displayName: string, avatar: string|null,
 *   firstSeenAt: number, lastSeenAt: number }>}
 */
function list() {
  load();
  return Object.values(store)
    .filter(Boolean)
    .sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0));
}

/**
 * Reprend au vol les comptes que seules les sessions connaissent encore.
 *
 * Une installation mise à jour possède déjà des invités : ils ont des droits,
 * des admissions, et des sessions ouvertes — mais pas de fiche, le carnet
 * n'existant pas quand ils sont arrivés. Sans ce rattrapage ils n'entreraient
 * dans le carnet qu'à leur prochaine authentification, et le maître les verrait
 * entre-temps disparaître de sa fenêtre au premier cookie périmé.
 *
 * Appelé une fois au démarrage. N'écrase rien : une fiche déjà là fait foi.
 *
 * @param {Array<{ userId: string, displayName: string, avatar: string|null, lastSeenAt: number }>} known
 * @returns {number} Nombre de fiches créées.
 */
function adopt(known) {
  load();
  let created = 0;

  for (const entry of known || []) {
    if (!entry || !entry.userId) continue;
    const id = String(entry.userId);
    if (store[id]) continue;

    store[id] = {
      userId: id,
      username: '',
      displayName: entry.displayName || id,
      avatar: entry.avatar || null,
      firstSeenAt: entry.lastSeenAt || Date.now(),
      lastSeenAt: entry.lastSeenAt || Date.now(),
    };
    created++;
  }

  if (created) {
    save();
    log.info(`[Guests] ${created} account(s) taken over from the open sessions.`);
  }
  return created;
}

/** Écrit sans attendre le délai — à l'extinction du process. */
function flush() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  save();
}

/** Repart de zéro. Réservé aux tests. */
function reset() {
  store = null;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
}

module.exports = {
  GUESTS_FILE,
  remember,
  get,
  isKnown,
  touch,
  forget,
  list,
  adopt,
  flush,
  reset,
};
