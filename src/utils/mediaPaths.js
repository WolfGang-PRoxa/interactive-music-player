/**
 * mediaPaths — Résolution sécurisée des chemins de fichiers média.
 *
 * Toute requête cliente qui désigne un fichier sur le disque (/api/stream,
 * /api/download) doit passer par resolveMediaPath(). Sans ce filtre, un simple
 * ?trackUrl=...\.env suffit à faire servir n'importe quel fichier du disque.
 *
 * Un chemin n'est accepté que s'il remplit les trois conditions :
 *   1. il porte une extension média connue ;
 *   2. il existe réellement (realpath, ce qui neutralise les liens symboliques) ;
 *   3. il se trouve à l'intérieur d'une racine autorisée.
 *
 * Racines autorisées : data/uploads, data/cache, plus les dossiers listés dans
 * la variable d'environnement MEDIA_ROOTS (séparés par ';' ou ',') pour les
 * bibliothèques musicales locales.
 */

const path = require('path');
const fs = require('fs');
const config = require('../config');

const DATA_DIR = path.join(process.cwd(), 'data');

const MEDIA_EXTENSIONS = new Set(
  [...config.supportedExtensions, ...config.supportedVideoExtensions].map((ext) => ext.toLowerCase()),
);

function buildAllowedRoots() {
  const roots = [path.join(DATA_DIR, 'uploads'), path.join(DATA_DIR, 'cache')];

  const extra = process.env.MEDIA_ROOTS;
  if (extra) {
    for (const entry of extra.split(/[;,]/)) {
      const trimmed = entry.trim();
      if (trimmed) roots.push(trimmed);
    }
  }

  return roots.map((root) => {
    const resolved = path.resolve(root);
    // realpath pour que la comparaison se fasse sur le chemin canonique des
    // deux côtés — sinon un lien symbolique sur la racine ferait tout échouer.
    try {
      return fs.realpathSync(resolved);
    } catch (e) {
      return resolved;
    }
  });
}

const allowedRoots = buildAllowedRoots();

/** Windows compare les chemins sans tenir compte de la casse. */
function normalizeForCompare(p) {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

function hasMediaExtension(filePath) {
  return MEDIA_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function isUnderAllowedRoot(absolutePath) {
  const target = normalizeForCompare(absolutePath);
  return allowedRoots.some((root) => {
    const rel = path.relative(normalizeForCompare(root), target);
    // rel vide = le chemin EST la racine ; '..' = en dehors ; absolu = autre volume.
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  });
}

/**
 * Résout un chemin fourni par le client en chemin absolu sûr.
 * @param {string} input - Chemin brut ou encodé reçu du client
 * @returns {string|null} Chemin absolu canonique, ou null si non autorisé
 */
function resolveMediaPath(input) {
  if (!input || typeof input !== 'string') return null;

  let decoded = input;
  try {
    decoded = decodeURIComponent(input);
  } catch (e) {
    // Séquence d'échappement invalide : on garde la valeur brute
  }

  // Un octet nul tronque le chemin au niveau des appels système sous-jacents.
  if (decoded.includes('\0')) return null;

  // Une URL distante n'est pas un chemin disque : ce n'est pas notre rôle ici.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(decoded)) return null;

  if (!hasMediaExtension(decoded)) return null;

  let real;
  try {
    real = fs.realpathSync(path.resolve(decoded));
  } catch (e) {
    return null; // Fichier inexistant ou illisible
  }

  if (!isUnderAllowedRoot(real)) return null;

  return real;
}

/**
 * Indique si un nom de fichier porte une extension média acceptée.
 * Utilisé à l'upload, avant que le fichier n'existe sur le disque.
 * @param {string} fileName
 * @returns {boolean}
 */
function isAllowedMediaFilename(fileName) {
  return typeof fileName === 'string' && hasMediaExtension(fileName);
}

/**
 * Ce chemin est-il une racine autorisée, ou quelque chose qu'elle contient ?
 *
 * Exposé en plus de `resolveMediaPath` parce que celui-ci exige un *fichier*
 * média existant : il refuse un dossier, et c'est justement ce qu'il faut
 * savoir avant de parcourir une bibliothèque locale. Le chemin est rendu
 * canonique ici, sans quoi un lien symbolique ou un `..` répondrait à côté.
 *
 * La racine elle-même est acceptée, à la différence de `isUnderAllowedRoot` :
 * demander à jouer « data/uploads » désigne un dossier légitime, et le refuser
 * au prétexte qu'il n'est pas *sous* lui-même n'aurait aucun sens ici.
 *
 * @param {string} input Chemin, absolu ou relatif.
 * @returns {boolean} Faux aussi quand le chemin n'existe pas.
 */
function isInsideAllowedRoots(input) {
  if (!input || typeof input !== 'string') return false;
  // Un octet nul tronque le chemin au niveau des appels systeme sous-jacents.
  if (input.indexOf('\0') !== -1) return false;

  let real;
  try {
    real = fs.realpathSync(path.resolve(input));
  } catch (e) {
    return false;
  }

  const target = normalizeForCompare(real);
  return allowedRoots.some((root) => {
    const rel = path.relative(normalizeForCompare(root), target);
    // rel vide = le chemin EST la racine, ce qui convient ici.
    return !rel.startsWith('..') && !path.isAbsolute(rel);
  });
}

module.exports = {
  resolveMediaPath,
  isAllowedMediaFilename,
  isInsideAllowedRoots,
  allowedRoots,
};
