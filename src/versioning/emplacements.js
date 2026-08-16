/**
 * emplacements — Où vivent le code et les données, et quelle version tourne.
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
 * dossier peut être écrasé ou supprimé : `verifierCibleInstallable()` et
 * `verifierCibleSupprimable()` sont les garde-fous qui mettent le dépôt de
 * développement — et la version en cours d'exécution — hors d'atteinte de
 * l'installateur comme de la désinstallation.
 */

const fs = require('fs');
const path = require('path');

/** Nom du fichier déposé à la racine d'une version pour attester son intégrité. */
const FICHIER_MARQUEUR = '.imp-version.json';

/** Étiquette de la version de développement dans l'interface et les messages. */
const TAG_DEV = 'dev';

/**
 * Racine partagée : `.env`, `data/` et `node_modules/`.
 *
 * `process.cwd()` par cohérence avec tout le reste du bot, qui y résout déjà
 * ses données. Le bot suppose donc — ici comme ailleurs — d'être lancé depuis
 * la racine du dépôt.
 */
const RACINE_PARTAGEE = process.cwd();

/**
 * Racine du code en cours d'exécution : deux niveaux au-dessus de
 * `src/versioning/`.
 */
const RACINE_INSTALLATION = path.resolve(__dirname, '..', '..');

/**
 * Dossier des releases installées.
 *
 * `IMP_VERSIONS_DIR` permet de le déporter (disque secondaire, dossier hors du
 * dépôt). Le garde-fou vérifie tout de même qu'il ne recouvre pas le dépôt de
 * développement, quelle qu'en soit la valeur.
 */
const DOSSIER_VERSIONS = process.env.IMP_VERSIONS_DIR
    ? path.resolve(process.env.IMP_VERSIONS_DIR)
    : path.join(RACINE_PARTAGEE, 'versions');

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
function estSousDossier(parent, enfant) {
    const relatif = path.relative(path.resolve(parent), path.resolve(enfant));
    if (!relatif) return false;
    if (path.isAbsolute(relatif)) return false;
    return relatif !== '..' && !relatif.startsWith(`..${path.sep}`);
}

function memeDossier(a, b) {
    return path.relative(path.resolve(a), path.resolve(b)) === '';
}

/** La version en cours d'exécution est-elle une release installée ? */
function tourneSurUneRelease() {
    return estSousDossier(DOSSIER_VERSIONS, RACINE_INSTALLATION);
}

/**
 * Racine du dépôt de développement.
 *
 * Quand c'est lui qui tourne, c'est la racine d'installation. Quand c'est une
 * release, le dépôt est celui qui héberge `versions/` : la racine partagée.
 */
function racineDev() {
    return tourneSurUneRelease() ? RACINE_PARTAGEE : RACINE_INSTALLATION;
}

/** Point d'entrée Node d'une racine d'installation. */
function entreePour(racine) {
    return path.join(racine, 'src', 'index.js');
}

function lirePackage(racine) {
    try {
        return JSON.parse(fs.readFileSync(path.join(racine, 'package.json'), 'utf8'));
    } catch (e) {
        return null;
    }
}

/**
 * Identité de la version en cours d'exécution.
 * @returns {{ type: 'dev'|'release', tag: string, versionPackage: string|null, racine: string }}
 */
function versionCourante() {
    const pkg = lirePackage(RACINE_INSTALLATION);
    const versionPackage = pkg && pkg.version ? String(pkg.version) : null;

    if (tourneSurUneRelease()) {
        // Le dossier porte le nom de la release ; le marqueur garde le tag
        // d'origine, que l'assainissement du nom de dossier a pu altérer.
        const marqueur = lireMarqueur(RACINE_INSTALLATION);
        return {
            type: 'release',
            tag: (marqueur && marqueur.tag) || path.basename(RACINE_INSTALLATION),
            versionPackage,
            racine: RACINE_INSTALLATION,
        };
    }

    return { type: 'dev', tag: TAG_DEV, versionPackage, racine: RACINE_INSTALLATION };
}

/** Le dépôt de développement est-il lançable depuis cette machine ? */
function devDisponible() {
    return fs.existsSync(entreePour(racineDev()));
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
function nomDossierSur(tag) {
    const brut = String(tag || '').trim();
    if (!brut) throw new Error('Tag de version vide.');

    const nom = brut.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '');
    if (!nom || nom === '.' || nom === '..' || /^\.+$/.test(nom)) {
        throw new Error(`Tag de version inexploitable : ${brut}`);
    }
    return nom;
}

function lireMarqueur(dossier) {
    try {
        return JSON.parse(fs.readFileSync(path.join(dossier, FICHIER_MARQUEUR), 'utf8'));
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
function installationComplete(dossier) {
    const marqueur = lireMarqueur(dossier);
    if (!marqueur || marqueur.complete !== true) return false;
    return fs.existsSync(entreePour(dossier));
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
 * @param {string} refus - Début du message d'erreur, p. ex. `Installation refusée`
 * @throws {Error} si l'opération doit être refusée
 */
function verifierCibleModifiable(cible, refus) {
    const dev = racineDev();

    if (memeDossier(DOSSIER_VERSIONS, dev) || estSousDossier(DOSSIER_VERSIONS, dev)) {
        throw new Error(
            `${refus} : le dossier des versions (${DOSSIER_VERSIONS}) contient le dépôt de développement.`
        );
    }

    if (!estSousDossier(DOSSIER_VERSIONS, cible)) {
        throw new Error(`${refus} : ${cible} est hors du dossier des versions.`);
    }

    if (memeDossier(cible, RACINE_INSTALLATION)) {
        throw new Error(`${refus} : cette version est celle en cours d'exécution.`);
    }

    if (memeDossier(cible, dev) || estSousDossier(cible, dev)) {
        throw new Error(`${refus} : cette cible recouvre le dépôt de développement.`);
    }
}

/** `cible` peut-elle accueillir une installation ? @throws {Error} sinon */
function verifierCibleInstallable(cible) {
    verifierCibleModifiable(cible, 'Installation refusée');
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
function verifierCibleSupprimable(cible) {
    verifierCibleModifiable(cible, 'Désinstallation refusée');
}

module.exports = {
    FICHIER_MARQUEUR,
    TAG_DEV,
    RACINE_PARTAGEE,
    RACINE_INSTALLATION,
    DOSSIER_VERSIONS,
    devDisponible,
    entreePour,
    estSousDossier,
    installationComplete,
    lireMarqueur,
    lirePackage,
    memeDossier,
    nomDossierSur,
    racineDev,
    tourneSurUneRelease,
    verifierCibleInstallable,
    verifierCibleSupprimable,
    versionCourante,
};
