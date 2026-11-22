/**
 * botConfig — Les variables du `.env` que le tableau de bord sait régler.
 *
 * ## Pourquoi
 *
 * Une fois le bot installé par l'application de bureau, le `.env` se trouve au
 * fond d'un dossier que personne n'ouvre, et le modifier à la main demandait de
 * savoir qu'il existe. La section « Configuration » des paramètres le montre et
 * le règle, réservée au propriétaire. Le fichier reste la seule source : la
 * section l'écrit, sans en changer la forme (voir utils/envFile.js), et qui
 * préfère l'éditer à la main peut continuer.
 *
 * ## Ce qui n'est pas ici
 *
 * Seules les variables que le bot lit vraiment. `DASHBOARD_TOKEN` en est exclu :
 * changer depuis le tableau de bord le jeton qui y donne accès fermerait la
 * porte derrière soi. `AUTO_OPEN_DASHBOARD` aussi : l'application de bureau
 * l'impose, et l'afficher ici promettrait un réglage sans effet.
 *
 * ## Deux règles de prudence
 *
 *  - **Un secret ne repart jamais.** Le jeton du bot, le secret OAuth2, le
 *    jeton du tunnel : le serveur dit s'ils sont renseignés, jamais ce qu'ils
 *    valent. On peut les remplacer ou les effacer, pas les lire. Une session
 *    volée n'en apprend rien.
 *
 *  - **Ce qui peut couper l'accès ou ouvrir le disque ne se change que depuis
 *    l'ordinateur du bot** (`local: true`). Un mauvais jeton, une adresse
 *    publique erronée, un port changé, et le tableau de bord devient
 *    injoignable de l'extérieur : il faudrait alors être devant la machine pour
 *    réparer, autant y être pour casser. Les dossiers de musique décident de ce
 *    que le serveur accepte de lire sur le disque : les élargir à distance
 *    ferait d'une session volée une fuite de fichiers. Le reste — plafonds,
 *    journaux — se règle d'où l'on veut.
 *
 * Tout prend effet au redémarrage : le bot lit son `.env` au lancement, et
 * nombre de ces valeurs sont figées dès le chargement des modules. La section
 * le dit et propose de redémarrer.
 */

const envFile = require('../utils/envFile');

/** La forme d'un jeton de bot : trois segments base64url séparés par des points. */
function looksLikeToken(text) {
  const parts = String(text).trim().split('.');
  const minimums = [16, 5, 20];
  return parts.length === 3 && parts.every((part, i) => part.length >= minimums[i] && /^[A-Za-z0-9_-]+$/.test(part));
}

/**
 * Une origine http(s) sans chemin, ramenée à sa forme normale, ou null.
 * @param {string} value
 * @param {{ httpsOnly?: boolean, allowPath?: boolean }} [options]
 */
function cleanUrl(value, { httpsOnly = false, allowPath = false } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch (e) {
    return null;
  }
  if (url.protocol !== 'https:' && (httpsOnly || url.protocol !== 'http:')) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (!allowPath && url.pathname !== '/' && url.pathname !== '') return null;
  return allowPath ? url.toString().replace(/\/+$/, '') : url.origin;
}

function integer(min, max) {
  return (value) => {
    if (!/^\d+$/.test(value)) return { error: 'invalid_number' };
    const number = Number(value);
    if (number < min || number > max) return { error: 'out_of_range' };
    return { value: String(number) };
  };
}

/**
 * Les champs, dans l'ordre où la section les montre.
 *
 * `validate` reçoit la valeur rognée (jamais vide : un champ vidé efface la
 * variable, sauf `required`) et rend `{ value }` normalisée ou `{ error }`,
 * un code que le tableau de bord traduit.
 */
const FIELDS = [
  {
    key: 'DISCORD_TOKEN',
    group: 'discord',
    kind: 'secret',
    local: true,
    required: true,
    validate: (v) => (looksLikeToken(v) ? { value: v } : { error: 'invalid_token' }),
  },
  {
    key: 'DISCORD_CLIENT_ID',
    group: 'discord',
    kind: 'text',
    local: true,
    validate: (v) => (/^\d{17,21}$/.test(v) ? { value: v } : { error: 'invalid_client_id' }),
  },
  {
    key: 'DISCORD_CLIENT_SECRET',
    group: 'discord',
    kind: 'secret',
    local: true,
    validate: (v) => (/^\S+$/.test(v) ? { value: v } : { error: 'invalid_value' }),
  },
  {
    key: 'PUBLIC_URL',
    group: 'sharing',
    kind: 'url',
    local: true,
    validate: (v) => {
      const url = cleanUrl(v);
      return url ? { value: url } : { error: 'invalid_url' };
    },
  },
  {
    key: 'CLOUDFLARE_TUNNEL_TOKEN',
    group: 'sharing',
    kind: 'secret',
    local: true,
    validate: (v) => (/^[A-Za-z0-9+/=_-]{20,}$/.test(v) ? { value: v } : { error: 'invalid_value' }),
  },
  {
    key: 'OAUTH_RELAY_URL',
    group: 'sharing',
    kind: 'text',
    local: true,
    validate: (v) => {
      if (/^(off|none|false|0)$/i.test(v)) return { value: 'off' };
      const url = cleanUrl(v, { httpsOnly: true, allowPath: true });
      return url ? { value: url } : { error: 'invalid_relay' };
    },
  },
  {
    key: 'HOST',
    group: 'network',
    kind: 'select',
    local: true,
    options: ['127.0.0.1', '0.0.0.0'],
    validate: (v) => (/^[\w.:[\]-]+$/.test(v) ? { value: v } : { error: 'invalid_value' }),
  },
  {
    key: 'PORT',
    group: 'network',
    kind: 'number',
    local: true,
    min: 1024,
    max: 65535,
    placeholder: '3000',
    validate: integer(1024, 65535),
  },
  {
    key: 'MEDIA_ROOTS',
    group: 'media',
    kind: 'text',
    local: true,
    validate: (v) => {
      const roots = v
        .split(/[;,]/)
        .map((s) => s.trim())
        .filter(Boolean);
      return roots.length ? { value: roots.join(';') } : { error: 'invalid_value' };
    },
  },
  {
    key: 'MAX_UPLOAD_MB',
    group: 'media',
    kind: 'number',
    min: 1,
    max: 102400,
    placeholder: '1024',
    validate: integer(1, 102400),
  },
  {
    key: 'MAX_CACHE_MB',
    group: 'media',
    kind: 'number',
    min: 64,
    max: 1048576,
    placeholder: '2048',
    validate: integer(64, 1048576),
  },
  {
    key: 'LOG_LEVEL',
    group: 'logs',
    kind: 'select',
    options: ['debug', 'info', 'warn', 'error'],
    validate: (v) => (['debug', 'info', 'warn', 'error'].includes(v) ? { value: v } : { error: 'invalid_value' }),
  },
  {
    key: 'LOG_RETENTION',
    group: 'logs',
    kind: 'number',
    min: 1,
    max: 1000,
    placeholder: '20',
    validate: integer(1, 1000),
  },
];

const BY_KEY = new Map(FIELDS.map((field) => [field.key, field]));

/**
 * Les valeurs de démonstration de `.env.example`. Un fichier recopié tel quel
 * les garde : les montrer comme réglées ferait croire qu'il y a un jeton là
 * où il n'y en a pas.
 */
const PLACEHOLDERS = {
  DISCORD_TOKEN: 'your_bot_token_here',
  DISCORD_CLIENT_ID: 'your_client_id_here',
};

/**
 * Ce que la section affiche. Les secrets n'y figurent que par `set`.
 *
 * `restartNeeded` compare le fichier à ce que le processus a chargé au
 * lancement : tant qu'ils diffèrent, le bot ne tourne pas avec ce qu'on voit.
 *
 * @param {{ fromThisMachine: boolean }} context
 */
function snapshot({ fromThisMachine }) {
  const values = envFile.read();
  let restartNeeded = false;
  const fields = FIELDS.map((field) => {
    const raw = values[field.key] ?? '';
    if (raw !== (process.env[field.key] ?? '')) restartNeeded = true;
    const value = raw === PLACEHOLDERS[field.key] ? '' : raw;
    const out = {
      key: field.key,
      group: field.group,
      kind: field.kind,
      local: Boolean(field.local),
      required: Boolean(field.required),
    };
    if (field.options) out.options = field.options;
    if (field.min !== undefined) out.min = field.min;
    if (field.max !== undefined) out.max = field.max;
    if (field.placeholder) out.placeholder = field.placeholder;
    if (field.kind === 'secret') out.set = value.trim() !== '';
    else out.value = value;
    return out;
  });
  return { fields, fromThisMachine: Boolean(fromThisMachine), restartNeeded, file: envFile.envPath() };
}

/**
 * Vérifie puis écrit des changements.
 *
 * Tout ou rien : une seule valeur refusée, et rien n'est écrit. Enregistrer la
 * moitié d'un formulaire laisserait un `.env` que personne n'a voulu.
 *
 * @param {Record<string, unknown>} changes - Clé → nouvelle valeur ('' efface).
 * @param {{ fromThisMachine: boolean }} context
 * @returns {{ ok: boolean, errors: Record<string, string>, saved: string[] }}
 */
function apply(changes, { fromThisMachine }) {
  const errors = {};
  const values = {};
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    return { ok: false, errors: { _: 'invalid_value' }, saved: [] };
  }
  for (const [key, raw] of Object.entries(changes)) {
    const field = BY_KEY.get(key);
    if (!field) {
      errors[key] = 'unknown';
      continue;
    }
    if (field.local && !fromThisMachine) {
      errors[key] = 'local_only';
      continue;
    }
    if (raw !== null && raw !== undefined && typeof raw !== 'string' && typeof raw !== 'number') {
      errors[key] = 'invalid_value';
      continue;
    }
    const text = raw === null || raw === undefined ? '' : String(raw).trim();
    if (/[\r\n]/.test(text)) {
      errors[key] = 'invalid_value';
      continue;
    }
    if (!text) {
      if (field.required) errors[key] = 'required';
      else values[key] = '';
      continue;
    }
    const verdict = field.validate(text);
    if (verdict.error) errors[key] = verdict.error;
    else values[key] = verdict.value;
  }

  if (Object.keys(errors).length) return { ok: false, errors, saved: [] };
  if (!Object.keys(values).length) return { ok: true, errors: {}, saved: [] };

  try {
    envFile.update(values);
  } catch (err) {
    return { ok: false, errors: { _: 'write_failed' }, saved: [], detail: err.message };
  }
  return { ok: true, errors: {}, saved: Object.keys(values) };
}

module.exports = { FIELDS, snapshot, apply, looksLikeToken };
