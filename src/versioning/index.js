/**
 * versioning — Façade du système de versions.
 *
 * Rassemble ce que le tableau de bord a besoin de savoir (quelle version tourne,
 * lesquelles existent, lesquelles sont déjà sur le disque) et traduit un choix
 * de l'utilisateur en point d'entrée à lancer.
 *
 * Voir `locations.js` pour la disposition sur le disque et les garde-fous,
 * `installer.js` pour le téléchargement.
 */

const locations = require('./locations');
const github = require('./github');
const installer = require('./installer');

/**
 * État complet du système de versions, tel que consommé par le menu déroulant.
 *
 * L'échec de l'appel à GitHub n'est pas une erreur fatale : il est rapporté
 * dans `erreur` et le catalogue reste utilisable, réduit aux versions déjà
 * présentes sur le disque. Hors ligne, on peut donc toujours revenir à une
 * version installée ou au développement.
 *
 * @returns {Promise<object>}
 */
async function catalog() {
  const current = locations.currentVersion();
  const installedList = installer.listInstalled();
  const byTag = new Map(installedList.map((i) => [i.tag, i]));

  let releases = [];
  let error = null;
  try {
    // `forcer` : le menu doit refléter les releases publiées à l'instant où
    // l'utilisateur l'ouvre, pas celles de sa précédente ouverture.
    releases = await github.listReleases({ force: true });
  } catch (err) {
    error = { message: err.message, status: err.status || null };
  }

  const entries = releases.map((r) => {
    const installed = byTag.get(r.tag);
    return {
      tag: r.tag,
      name: r.name,
      publishedAt: r.publishedAt,
      prerelease: r.prerelease,
      installed: !!installed,
      installedAt: installed ? installed.installedAt : null,
      current: current.type === 'release' && current.tag === r.tag,
      orphan: false,
    };
  });

  // Une version installée dont la release a disparu du dépôt reste lançable :
  // elle est sur le disque, et l'utilisateur doit pouvoir y revenir.
  const knownTags = new Set(entries.map((e) => e.tag));
  for (const installed of installedList) {
    if (knownTags.has(installed.tag)) continue;
    entries.push({
      tag: installed.tag,
      name: installed.tag,
      publishedAt: null,
      prerelease: false,
      installed: true,
      installedAt: installed.installedAt,
      current: current.type === 'release' && current.tag === installed.tag,
      orphan: true,
    });
  }

  return {
    current: {
      type: current.type,
      tag: current.tag,
      packageVersion: current.packageVersion,
    },
    dev: {
      tag: locations.DEV_TAG,
      available: locations.devAvailable(),
      current: current.type === 'dev',
      packageVersion: (locations.readPackage(locations.devRoot()) || {}).version || null,
    },
    releases: entries,
    repository: github.repository(),
    versionsDir: locations.VERSIONS_DIR,
    error,
  };
}

/**
 * Point d'entrée Node à lancer pour une version donnée.
 *
 * @param {string} tag - Tag de release, ou `dev` pour le dépôt de développement
 * @returns {{ entryPoint: string, type: 'dev'|'release', tag: string }}
 * @throws {Error} si la version n'est pas disponible localement
 */
function resolveEntryPoint(tag) {
  if (tag === locations.DEV_TAG) {
    const entryPoint = locations.entryPointFor(locations.devRoot());
    if (!locations.devAvailable()) {
      throw new Error(`Development version not found (${entryPoint}).`);
    }
    return { entryPoint, type: 'dev', tag: locations.DEV_TAG };
  }

  const dir = installer.installedDir(tag);
  if (!dir) throw new Error(`Version ${tag} is not installed.`);
  return { entryPoint: locations.entryPointFor(dir), type: 'release', tag };
}

/** La version demandée est-elle déjà celle qui tourne ? */
function isCurrent(tag) {
  const current = locations.currentVersion();
  return current.tag === tag;
}

module.exports = {
  DEV_TAG: locations.DEV_TAG,
  catalog,
  uninstall: installer.uninstall,
  locations,
  isCurrent,
  github,
  installer,
  install: installer.install,
  cleanTempDirs: installer.cleanTempDirs,
  resolveEntryPoint,
  currentVersion: locations.currentVersion,
};
