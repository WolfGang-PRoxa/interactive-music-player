/**
 * locations — Où vivent le code et les données, et quelle version tourne.
 *
 * Le bot sépare deux racines qui, en développement, se confondent :
 *
 *   - la **racine partagée** (`process.cwd()`) porte `.env`, `data/` et
 *     `node_modules/`. Tous les modules du bot résolvent leurs données depuis
 *     `process.cwd()` — Database, auth, mediaPaths, uploadService : c'est elle
 *     qui décide où sont les playlists, les réglages et le jeton du tableau de
 *     bord ;
 *   - la **racine d'installation** porte le code exécuté. C'est le dépôt
 *     lui-même en développement, ou `versions/<tag>/` pour une release
 *     installée.
 *
 * Changer de version revient donc à exécuter `versions/<tag>/src/index.js` en
 * laissant `cwd` sur la racine partagée : le code change, les données non. Node
 * remontant les dossiers parents à la recherche de `node_modules`, une release
 * imbriquée dans la racine partagée hérite au passage de ses dépendances sans
 * la moindre copie.
 *
 * Ce module est le seul à savoir tout cela, et le seul habilité à dire si un
 * dossier peut être écrasé ou supprimé : `assertTargetInstallable()` et
 * `assertTargetRemovable()` sont les garde-fous qui mettent le dépôt de
 * développement — et la version en cours d'exécution — hors d'atteinte de
 * l'installateur comme de la désinstallation.
 */

const fs = require('fs');
const path = require('path');

/** Nom du fichier déposé à la racine d'une version pour attester son intégrité. */
const MARKER_FILE = '.imp-version.json';

/** Étiquette de la version de développement dans l'interface et les messages. */
const DEV_TAG = 'dev';

/**
 * Racine partagée : `.env`, `data/` et `node_modules/`.
 *
 * `process.cwd()` par cohérence avec tout le reste du bot, qui y résout déjà
 * ses données. Le bot suppose donc — ici comme ailleurs — d'être lancé depuis
 * la racine du dépôt.
 */
const SHARED_ROOT = process.cwd();

/**
 * Racine du code en cours d'exécution : deux niveaux au-dessus de
 * `src/versioning/`.
 */
const INSTALL_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Dossier des releases installées.
 *
 * `IMP_VERSIONS_DIR` permet de le déporter (disque secondaire, dossier hors du
 * dépôt). Le garde-fou vérifie tout de même qu'il ne recouvre pas le dépôt de
 * développement, quelle qu'en soit la valeur.
 */
const VERSIONS_DIR = process.env.IMP_VERSIONS_DIR
  ? path.resolve(process.env.IMP_VERSIONS_DIR)
  : path.join(SHARED_ROOT, 'versions');

/**
 * `enfant` est-il strictement contenu dans `parent` ?
 *
 * Comparer les chaînes ne suffit pas : `..` et les différences de casse de
 * Windows feraient passer un chemin d'apparence sage pour un descendant
 * légitime. `path.relative` normalise les deux côtés, et un résultat qui
 * remonte ou qui repart en absolu dénonce un chemin extérieur.
 *
 * La remontée se teste sur un segment entier, non sur le préfixe de la chaîne :
 * un dossier légitimement nommé `..quelque-chose` — ce que produit
 * l'assainissement d'un tag exotique — n'a rien d'une évasion.
 */
function isSubdirectory(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  if (!relative) return false;
  if (path.isAbsolute(relative)) return false;
  return relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

function isSameDir(a, b) {
  return path.relative(path.resolve(a), path.resolve(b)) === '';
}

/** La version en cours d'exécution est-elle une release installée ? */
function runningOnRelease() {
  return isSubdirectory(VERSIONS_DIR, INSTALL_ROOT);
}

/**
 * Racine du dépôt de développement.
 *
 * Quand c'est lui qui tourne, c'est la racine d'installation. Quand c'est une
 * release, le dépôt est celui qui héberge `versions/` : la racine partagée.
 */
function devRoot() {
  return runningOnRelease() ? SHARED_ROOT : INSTALL_ROOT;
}

/** Point d'entrée Node d'une racine d'installation. */
function entryPointFor(root) {
  return path.join(root, 'src', 'index.js');
}

function readPackage(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  } catch (e) {
    return null;
  }
}

/**
 * Identité de la version en cours d'exécution.
 * @returns {{ type: 'dev'|'release', tag: string, versionPackage: string|null, racine: string }}
 */
function currentVersion() {
  const pkg = readPackage(INSTALL_ROOT);
  const packageVersion = pkg && pkg.version ? String(pkg.version) : null;

  if (runningOnRelease()) {
    // Le dossier porte le nom de la release ; le marqueur garde le tag
    // d'origine, que l'assainissement du nom de dossier a pu altérer.
    const marker = readMarker(INSTALL_ROOT);
    return {
      type: 'release',
      tag: (marker && marker.tag) || path.basename(INSTALL_ROOT),
      packageVersion,
      root: INSTALL_ROOT,
    };
  }

  return { type: 'dev', tag: DEV_TAG, packageVersion, root: INSTALL_ROOT };
}

/** Le dépôt de développement est-il lançable depuis cette machine ? */
function devAvailable() {
  return fs.existsSync(entryPointFor(devRoot()));
}

/**
 * Nom de dossier sûr pour un tag de release.
 *
 * Un tag Git accepte des barres obliques et bien d'autres caractères qu'un nom
 * de dossier ne doit pas recevoir tels quels. Tout ce qui sort de l'alphabet
 * retenu devient un tiret, et les formes qui désignent un parent sont refusées.
 *
 * @throws {Error} si le tag ne laisse aucun nom exploitable
 */
function safeFolderName(tag) {
  const raw = String(tag || '').trim();
  if (!raw) throw new Error('Empty version tag.');

  const name = raw.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '');
  if (!name || name === '.' || name === '..' || /^\.+$/.test(name)) {
    throw new Error(`Unusable version tag: ${raw}`);
  }
  return name;
}

function readMarker(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, MARKER_FILE), 'utf8'));
  } catch (e) {
    return null;
  }
}

/**
 * Une installation n'est complète que si son marqueur est présent **et**
 * accompagné du point d'entrée. Une extraction interrompue laisse un dossier
 * partiel : sans cette vérification, il passerait pour une version installée et
 * le bot refuserait de démarrer après le redémarrage.
 */
function isInstallComplete(dir) {
  const marker = readMarker(dir);
  if (!marker || marker.complete !== true) return false;
  return fs.existsSync(entryPointFor(dir));
}

/**
 * Garde-fou d'écriture : `cible` peut-elle être créée ou détruite ?
 *
 * Quatre interdits, dans l'ordre de gravité :
 *   1. le dossier des versions ne doit pas recouvrir le dépôt de
 *      développement — sans quoi toucher à une release toucherait au code en
 *      cours d'écriture ;
 *   2. la cible doit être strictement à l'intérieur du dossier des versions ;
 *   3. la cible ne doit pas être la version en cours d'exécution, que rien ne
 *      doit remplacer ni retirer sous les pieds du process ;
 *   4. la cible ne doit pas recouvrir le dépôt de développement.
 *
 * Installation et désinstallation partagent exactement ces conditions : dans
 * les deux cas il s'agit d'écrire dans `versions/<tag>/`. Seul le mot qui
 * ouvre le message d'erreur change, d'où `refus`.
 *
 * @param {string} cible - Dossier visé
 * @param {string} refusal - Début du message d'erreur, p. ex. `Installation refusée`
 * @throws {Error} si l'opération doit être refusée
 */
function assertTargetWritable(target, refusal) {
  const dev = devRoot();

  if (isSameDir(VERSIONS_DIR, dev) || isSubdirectory(VERSIONS_DIR, dev)) {
    throw new Error(`${refusal}: the versions folder (${VERSIONS_DIR}) holds the development checkout.`);
  }

  if (!isSubdirectory(VERSIONS_DIR, target)) {
    throw new Error(`${refusal}: ${target} is outside the versions folder.`);
  }

  if (isSameDir(target, INSTALL_ROOT)) {
    throw new Error(`${refusal}: this version is the one currently running.`);
  }

  if (isSameDir(target, dev) || isSubdirectory(target, dev)) {
    throw new Error(`${refusal}: this target overlaps the development checkout.`);
  }
}

/** `cible` peut-elle accueillir une installation ? @throws {Error} sinon */
function assertTargetInstallable(target) {
  assertTargetWritable(target, 'Installation refusée');
}

/**
 * `cible` peut-elle être supprimée du disque ?
 *
 * Mêmes interdits que l'installation : c'est le garde-fou qui met le dépôt de
 * développement et la version en cours d'exécution hors d'atteinte de la
 * désinstallation.
 *
 * @throws {Error} sinon
 */
function assertTargetRemovable(target) {
  assertTargetWritable(target, 'Désinstallation refusée');
}

module.exports = {
  MARKER_FILE,
  DEV_TAG,
  SHARED_ROOT,
  INSTALL_ROOT,
  VERSIONS_DIR,
  devAvailable,
  entryPointFor,
  isSubdirectory,
  isInstallComplete,
  readMarker,
  readPackage,
  isSameDir,
  safeFolderName,
  devRoot,
  runningOnRelease,
  assertTargetInstallable,
  assertTargetRemovable,
  currentVersion,
};
