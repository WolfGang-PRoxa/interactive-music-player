/**
 * versioning — Façade du système de versions.
 *
 * Rassemble ce que le tableau de bord a besoin de savoir (quelle version tourne,
 * lesquelles existent, lesquelles sont déjà sur le disque) et traduit un choix
 * de l'utilisateur en point d'entrée à lancer.
 *
 * Voir `emplacements.js` pour la disposition sur le disque et les garde-fous,
 * `installateur.js` pour le téléchargement.
 */

const emplacements = require('./emplacements');
const github = require('./github');
const installateur = require('./installateur');

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
async function catalogue() {
    const courante = emplacements.versionCourante();
    const installees = installateur.listerInstallees();
    const parTag = new Map(installees.map((i) => [i.tag, i]));

    let releases = [];
    let erreur = null;
    try {
        // `forcer` : le menu doit refléter les releases publiées à l'instant où
        // l'utilisateur l'ouvre, pas celles de sa précédente ouverture.
        releases = await github.listerReleases({ forcer: true });
    } catch (err) {
        erreur = { message: err.message, statut: err.statut || null };
    }

    const entrees = releases.map((r) => {
        const installee = parTag.get(r.tag);
        return {
            tag: r.tag,
            nom: r.nom,
            publieeLe: r.publieeLe,
            prerelease: r.prerelease,
            installee: !!installee,
            installeeLe: installee ? installee.installeeLe : null,
            courante: courante.type === 'release' && courante.tag === r.tag,
            orpheline: false,
        };
    });

    // Une version installée dont la release a disparu du dépôt reste lançable :
    // elle est sur le disque, et l'utilisateur doit pouvoir y revenir.
    const tagsConnus = new Set(entrees.map((e) => e.tag));
    for (const installee of installees) {
        if (tagsConnus.has(installee.tag)) continue;
        entrees.push({
            tag: installee.tag,
            nom: installee.tag,
            publieeLe: null,
            prerelease: false,
            installee: true,
            installeeLe: installee.installeeLe,
            courante: courante.type === 'release' && courante.tag === installee.tag,
            orpheline: true,
        });
    }

    return {
        courante: {
            type: courante.type,
            tag: courante.tag,
            versionPackage: courante.versionPackage,
        },
        dev: {
            tag: emplacements.TAG_DEV,
            disponible: emplacements.devDisponible(),
            courante: courante.type === 'dev',
            versionPackage: (emplacements.lirePackage(emplacements.racineDev()) || {}).version || null,
        },
        releases: entrees,
        depot: github.depot(),
        dossierVersions: emplacements.DOSSIER_VERSIONS,
        erreur,
    };
}

/**
 * Point d'entrée Node à lancer pour une version donnée.
 *
 * @param {string} tag - Tag de release, ou `dev` pour le dépôt de développement
 * @returns {{ entree: string, type: 'dev'|'release', tag: string }}
 * @throws {Error} si la version n'est pas disponible localement
 */
function pointEntree(tag) {
    if (tag === emplacements.TAG_DEV) {
        const entree = emplacements.entreePour(emplacements.racineDev());
        if (!emplacements.devDisponible()) {
            throw new Error(`Version de développement introuvable (${entree}).`);
        }
        return { entree, type: 'dev', tag: emplacements.TAG_DEV };
    }

    const dossier = installateur.dossierInstalle(tag);
    if (!dossier) throw new Error(`La version ${tag} n'est pas installée.`);
    return { entree: emplacements.entreePour(dossier), type: 'release', tag };
}

/** La version demandée est-elle déjà celle qui tourne ? */
function estCourante(tag) {
    const courante = emplacements.versionCourante();
    return courante.tag === tag;
}

module.exports = {
    TAG_DEV: emplacements.TAG_DEV,
    catalogue,
    desinstaller: installateur.desinstaller,
    emplacements,
    estCourante,
    github,
    installateur,
    installer: installateur.installer,
    nettoyerTemporaires: installateur.nettoyerTemporaires,
    pointEntree,
    versionCourante: emplacements.versionCourante,
};
