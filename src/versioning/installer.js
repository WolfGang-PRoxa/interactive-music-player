/**
 * installer — Télécharge, installe et inventorie les versions du bot.
 *
 * Règle directrice : **rien de déjà en place n'est jamais écrasé.** Chaque
 * release vit dans son propre dossier `versions/<tag>/`, et une installation ne
 * touche à aucun autre. Concrètement :
 *
 *   - une version déjà installée n'est pas retéléchargée : on se contente de la
 *     relancer, ce qui met la version en cours d'exécution à l'abri de sa propre
 *     réinstallation ;
 *   - le dépôt de développement n'est pas une cible possible — `locations`
 *     le refuse avant la moindre écriture ;
 *   - l'extraction se fait dans un dossier temporaire, renommé vers sa
 *     destination définitive une fois complet. Un téléchargement interrompu ne
 *     laisse donc jamais une version à moitié installée, mais un `.tmp-…` que le
 *     démarrage suivant balaie.
 *
 * Les dépendances suivent la même logique d'économie : le `node_modules` de la
 * racine partagée est visible depuis `versions/<tag>/` par la remontée de
 * dossiers de Node. Il n'est donc rien installé tant que la release réclame les
 * mêmes paquets que la racine ; un `npm install` local n'a lieu que lorsque la
 * liste diverge, et il reste alors confiné au dossier de la version.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const log = require('../utils/logger');
const locations = require('./locations');
const github = require('./github');
const { extractTarGz } = require('./targz');

const TEMP_PREFIX = '.tmp-';

/** Durée au-delà de laquelle un `npm install` est considéré comme perdu. */
const NPM_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Supprime un dossier sans jamais faire échouer l'appelant : le nettoyage n'est
 * qu'un confort, l'erreur qui l'a déclenché prime.
 */
function removeQuietly(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    log.warn(`[Versions] Cleanup impossible for ${dir}: ${e.message}`);
  }
}

/** Balaie les extractions abandonnées par une installation interrompue. */
function cleanTempDirs() {
  let entries;
  try {
    entries = fs.readdirSync(locations.VERSIONS_DIR, { withFileTypes: true });
  } catch (e) {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith(TEMP_PREFIX)) {
      removeQuietly(path.join(locations.VERSIONS_DIR, entry.name));
    }
  }
}

/**
 * Versions installées sur la machine, de la plus récente à la plus ancienne.
 *
 * L'inventaire se lit sur le disque plutôt que dans un registre : supprimer un
 * dossier à la main suffit ainsi à désinstaller une version, sans laisser
 * d'entrée fantôme dans le menu.
 */
function listInstalled() {
  let entries;
  try {
    entries = fs.readdirSync(locations.VERSIONS_DIR, { withFileTypes: true });
  } catch (e) {
    return [];
  }

  const current = locations.currentVersion();

  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => {
      const dir = path.join(locations.VERSIONS_DIR, e.name);
      if (!locations.isInstallComplete(dir)) return null;
      const marker = locations.readMarker(dir) || {};
      return {
        tag: marker.tag || e.name,
        dir,
        installedAt: marker.installedAt || null,
        localDependencies: !!marker.localDependencies,
        current: current.type === 'release' && locations.isSameDir(dir, current.root),
      };
    })
    .filter(Boolean)
    .sort((a, b) => String(b.installedAt || '').localeCompare(String(a.installedAt || '')));
}

/** Dossier d'une release installée, ou null si elle ne l'est pas (ou l'est mal). */
function installedDir(tag) {
  const target = path.join(locations.VERSIONS_DIR, locations.safeFolderName(tag));
  return locations.isInstallComplete(target) ? target : null;
}

/** Sous-ensemble de package.json qui décide du contenu de node_modules. */
function dependencyFingerprint(pkg) {
  if (!pkg) return null;
  const sortEntries = (obj) =>
    Object.keys(obj || {})
      .sort()
      .map((key) => `${key}@${JSON.stringify(obj[key])}`)
      .join(',');
  return [sortEntries(pkg.dependencies), sortEntries(pkg.optionalDependencies), sortEntries(pkg.overrides)].join('|');
}

/**
 * La release peut-elle se contenter du `node_modules` de la racine partagée ?
 *
 * La comparaison se fait avec le package.json de la racine, propriétaire de ce
 * `node_modules` — et non avec celui de la version en cours d'exécution, qui
 * peut elle-même être une release munie de ses propres dépendances.
 */
function dependenciesMatch(versionPkg) {
  const rootPkg = locations.readPackage(locations.SHARED_ROOT);
  if (!rootPkg) return false;
  return dependencyFingerprint(rootPkg) === dependencyFingerprint(versionPkg);
}

/**
 * Lance `npm install` dans le dossier d'une version.
 *
 * Sur Windows, `npm` est un script `.cmd` que Node refuse de lancer directement
 * depuis les versions récentes : le passage par le shell est ici sans risque,
 * la ligne de commande étant entièrement constante.
 */
function npmInstall(dir, onLine) {
  return new Promise((resolve, reject) => {
    const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const child = spawn(command, ['install', '--omit=dev', '--no-audit', '--no-fund'], {
      cwd: dir,
      shell: process.platform === 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('npm install ran past its time limit.'));
    }, NPM_TIMEOUT_MS);

    const relay = (stream) => {
      stream.setEncoding('utf8');
      stream.on('data', (block) => {
        const line = String(block).trim().split('\n').pop();
        if (line && onLine) onLine(line.slice(0, 200));
      });
    };
    relay(child.stdout);
    relay(child.stderr);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`npm not found or not runnable: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      reject(new Error(`npm install failed (code ${code}).`));
    });
  });
}

/**
 * Installe une release, ou reconnaît qu'elle l'est déjà.
 *
 * @param {string} tag - Tag de la release, tel que publié sur GitHub
 * @param {(etape: { phase: string, message?: string, pourcent?: number|null }) => void} [onEtape]
 * @returns {Promise<{ dossier: string, tag: string, dejaInstallee: boolean }>}
 */
async function install(tag, onStep = () => {}) {
  const folderName = locations.safeFolderName(tag);
  const target = path.join(locations.VERSIONS_DIR, folderName);

  // Refus avant toute écriture : dépôt de développement, version en cours
  // d'exécution, ou cible hors du dossier des versions.
  locations.assertTargetInstallable(target);

  if (locations.isInstallComplete(target)) {
    log.info(`[Versions] ${tag} is already installed: reusing ${target}.`);
    return { dir: target, tag, alreadyInstalled: true };
  }

  // Le dossier existe mais son marqueur manque : extraction interrompue,
  // jamais démarrée. Il n'a donc jamais servi et peut céder la place.
  if (fs.existsSync(target)) {
    log.warn(`[Versions] Incomplete install detected for ${tag}, starting it over from scratch.`);
    removeQuietly(target);
  }

  onStep({ phase: 'search' });
  const releases = await github.listReleases({ force: true });
  const release = releases.find((r) => r.tag === tag);
  if (!release) {
    throw new Error(`Release ${tag} cannot be found on the repository.`);
  }

  onStep({ phase: 'download', percent: 0 });
  let lastPercent = -1;
  const archive = await github.downloadArchive(release.tarballUrl, (received, total) => {
    const percent = total ? Math.floor((received / total) * 100) : null;
    // Une notification par point de pourcentage : le tableau de bord n'a
    // rien à faire d'un message par paquet TCP.
    if (percent === null || percent !== lastPercent) {
      lastPercent = percent;
      onStep({ phase: 'download', percent, bytes: received, total });
    }
  });

  fs.mkdirSync(locations.VERSIONS_DIR, { recursive: true });
  const tempDir = path.join(
    locations.VERSIONS_DIR,
    `${TEMP_PREFIX}${folderName}-${process.pid}-${Date.now().toString(36)}`,
  );

  try {
    onStep({ phase: 'extraction' });
    const result = extractTarGz(archive, tempDir);
    log.info(`[Versions] ${tag}: ${result.files} files extracted.`);

    const pkg = locations.readPackage(tempDir);
    if (!pkg) throw new Error('Archive invalide : package.json absent.');
    if (!fs.existsSync(locations.entryPointFor(tempDir))) {
      throw new Error('Archive invalide : src/index.js absent.');
    }

    let localDependencies = false;
    if (dependenciesMatch(pkg)) {
      log.info('[Versions] Dependencies identical to the root: shared node_modules reused.');
    } else {
      log.info('[Versions] Dependencies differ from the root: local npm install.');
      onStep({ phase: 'dependencies', message: 'npm install' });
      await npmInstall(tempDir, (line) => onStep({ phase: 'dependencies', message: line }));
      localDependencies = true;
    }

    fs.writeFileSync(
      path.join(tempDir, locations.MARKER_FILE),
      JSON.stringify(
        {
          tag,
          version: pkg.version || null,
          installedAt: new Date().toISOString(),
          localDependencies: localDependencies,
          complete: true,
        },
        null,
        2,
      ),
      'utf8',
    );

    // Bascule finale. Le renommage est atomique sur un même volume : la
    // version apparaît complète ou pas du tout.
    fs.renameSync(tempDir, target);
    github.clearCache();
    log.info(`[Versions] ${tag} installed in ${target}.`);
    return { dir: target, tag, alreadyInstalled: false };
  } catch (err) {
    removeQuietly(tempDir);
    throw err;
  }
}

/**
 * Retire une version du disque.
 *
 * L'inverse exact de `installer()` : le dossier `versions/<tag>/` disparaît
 * entièrement, et rien d'autre n'est touché — ni les données de la racine
 * partagée, qui n'ont jamais appartenu à la version, ni les autres releases.
 *
 * Deux refus, prononcés avant la moindre écriture :
 *   - le garde-fou de `locations` écarte le dépôt de développement et la
 *     version en cours d'exécution ;
 *   - une version qui n'est pas sur le disque n'a rien à désinstaller.
 *
 * La suppression, elle, est bruyante : contrairement au nettoyage d'un dossier
 * temporaire, l'utilisateur a demandé celle-ci et doit savoir si elle a échoué
 * — un dossier verrouillé par l'explorateur Windows, par exemple.
 *
 * @param {string} tag - Tag de la release à retirer
 * @returns {{ dossier: string, tag: string }}
 * @throws {Error} si la désinstallation est refusée ou impossible
 */
function uninstall(tag) {
  const target = path.join(locations.VERSIONS_DIR, locations.safeFolderName(tag));

  locations.assertTargetRemovable(target);

  if (!fs.existsSync(target)) {
    throw new Error(`Version ${tag} is not installed.`);
  }

  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (err) {
    throw new Error(`Deletion impossible for ${tag}: ${err.message}`);
  }

  log.info(`[Versions] ${tag} uninstalled (${target} deleted).`);
  return { dir: target, tag };
}

module.exports = {
  uninstall,
  installedDir,
  install,
  listInstalled,
  cleanTempDirs,
};
