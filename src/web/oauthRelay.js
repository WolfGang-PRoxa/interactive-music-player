/**
 * oauthRelay — L'adresse de retour fixe que Discord exige, pour une adresse qui
 * ne l'est pas.
 *
 * ## Le problème
 *
 * Discord n'accepte de renvoyer un visiteur que sur une URL de rappel déclarée
 * à l'avance, au caractère près, dans le portail de l'application. Or le
 * partage rapide (voir cloudflare.js) reçoit une adresse neuve à chaque
 * lancement — `https://<mots-au-hasard>.trycloudflare.com` — et rien ne permet
 * de la déclarer d'avance. Il faudrait retourner au portail à chaque démarrage.
 *
 * ## L'approche
 *
 * Une étape fixe entre Discord et le bot : un relais (un Worker Cloudflare,
 * `tools/oauth-relay/`) dont l'adresse, elle, ne change jamais. C'est elle qu'on
 * déclare, une fois pour toutes. Discord y renvoie le visiteur ; le relais lit
 * dans le `state` l'origine d'où la connexion est partie, et l'y renvoie avec
 * le code.
 *
 * Le relais ne voit passer qu'un code d'autorisation à usage unique. Il ne peut
 * rien en faire : l'échanger exige le secret de l'application, que seul le bot
 * détient. Il ne garde rien, ne journalise rien, et n'a besoin d'aucun réglage.
 *
 * ## Pourquoi la liste des destinations est fermée
 *
 * Un relais qui renverrait n'importe où servirait à faire porter des codes chez
 * n'importe qui. Il n'accepte donc que les deux seules destinations dont il a
 * l'usage : un tunnel rapide Cloudflare, et la machine elle-même (`localhost`).
 * Une adresse fixe — un domaine, une IP de réseau local — n'a pas besoin de
 * lui : elle se déclare directement dans le portail, comme avant.
 *
 * **Cette règle est écrite deux fois** : ici, pour que le bot sache d'avance si
 * le relais acceptera une origine, et dans le Worker, qui ne peut rien importer
 * du dépôt. `tests/oauthRelay.js` éprouve les deux sur les mêmes cas.
 */

const crypto = require('crypto');

/** Les tunnels rapides : un seul niveau de sous-domaine, en HTTPS, sans port. */
const QUICK_TUNNEL_HOST = /^[a-z0-9-]+\.trycloudflare\.com$/;

/** La machine elle-même, telle qu'un navigateur la nomme. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * L'origine qu'accepte le relais, normalisée, ou null.
 *
 * Une origine et rien d'autre : ni chemin, ni requête, ni identifiants. Le
 * relais compose lui-même le chemin de rappel, et une destination qui en
 * apporterait un serait une destination qu'on n'a pas vérifiée.
 *
 * @param {string} value
 * @returns {string|null}
 */
function acceptedTarget(value) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch (e) {
    return null;
  }

  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== '/' && url.pathname !== '') return null;

  const host = url.hostname.toLowerCase();
  if (url.protocol === 'https:' && QUICK_TUNNEL_HOST.test(host) && !url.port) {
    return url.origin;
  }
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(host)) {
    return url.origin;
  }
  return null;
}

function toBase64Url(text) {
  return Buffer.from(text, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text) {
  try {
    return Buffer.from(String(text).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch (e) {
    return '';
  }
}

/**
 * Compose un `state` qui porte sa destination.
 *
 * La partie tirée au hasard reste ce qu'elle était — la clé que le bot garde
 * de son côté, imprévisible et consommée une fois. L'origine s'y ajoute en
 * clair (encodée, pas chiffrée) : elle n'a rien de secret, c'est l'adresse
 * même où le visiteur se trouve.
 *
 * @param {string} origin - Une origine que `acceptedTarget` accepte.
 * @returns {string}
 */
function encodeState(origin) {
  const target = acceptedTarget(origin);
  if (!target) throw new Error(`origin not accepted by the relay: ${origin}`);
  return `${crypto.randomBytes(16).toString('hex')}.${toBase64Url(target)}`;
}

/**
 * L'origine qu'un `state` désigne, si le relais l'accepte.
 * @param {string} state
 * @returns {string|null}
 */
function decodeState(state) {
  const text = String(state || '');
  const dot = text.indexOf('.');
  if (dot <= 0) return null;
  return acceptedTarget(fromBase64Url(text.slice(dot + 1)));
}

module.exports = {
  acceptedTarget,
  encodeState,
  decodeState,
};
