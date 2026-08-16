/**
 * installateur — Télécharge, installe et inventorie les versions du bot.
 *
 * Règle directrice : **rien de déjà en place n'est jamais écrasé.** Chaque
 * release vit dans son propre dossier `versions/<tag>/`, et une installation ne
 * touche à aucun autre. Concrètement :
 *
 *   - une version déjà installée n'est pas retéléchargée : on se contente de la
 *     relancer, ce qui met la version en cours d'exécution à l'abri de sa propre
 *     réinstallation ;
 *   - le dépôt de développement n'est pas une cible possible — `emplacements`
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
const emplacements = require('./emplacements');
const github = require('./github');
const { extraireTarGz } = require('./targz');

const PREFIXE_TEMPORAIRE = '.tmp-';

/** Durée au-delà de laquelle un `npm install` est considéré comme perdu. */
const DELAI_NPM_MS = 10 * 60 * 1000;

/**
 * Supprime un dossier sans jamais faire échouer l'appelant : le nettoyage n'est
 * qu'un confort, l'erreur qui l'a déclenché prime.
 */
function supprimerSansBruit(dossier) {
    try {
        fs.rmSync(dossier, { recursive: true, force: true });
    } catch (e) {
        log.warn(`[Versions] Nettoyage impossible pour ${dossier} : ${e.message}`);
    }
}

/** Balaie les extractions abandonnées par une installation interrompue. */
function nettoyerTemporaires() {
    let entrees;
    try {
        entrees = fs.readdirSync(emplacements.DOSSIER_VERSIONS, { withFileTypes: true });
    } catch (e) {
        return;
    }
    for (const entree of entrees) {
        if (entree.isDirectory() && entree.name.startsWith(PREFIXE_TEMPORAIRE)) {
            supprimerSansBruit(path.join(emplacements.DOSSIER_VERSIONS, entree.name));
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
function listerInstallees() {
    let entrees;
    try {
        entrees = fs.readdirSync(emplacements.DOSSIER_VERSIONS, { withFileTypes: true });
    } catch (e) {
        return [];
    }

    const courante = emplacements.versionCourante();

    return entrees
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => {
            const dossier = path.join(emplacements.DOSSIER_VERSIONS, e.name);
            if (!emplacements.installationComplete(dossier)) return null;
            const marqueur = emplacements.lireMarqueur(dossier) || {};
            return {
                tag: marqueur.tag || e.name,
                dossier,
                installeeLe: marqueur.installeeLe || null,
                dependancesLocales: !!marqueur.dependancesLocales,
                courante: courante.type === 'release' && emplacements.memeDossier(dossier, courante.racine),
            };
        })
        .filter(Boolean)
        .sort((a, b) => String(b.installeeLe || '').localeCompare(String(a.installeeLe || '')));
}

/** Dossier d'une release installée, ou null si elle ne l'est pas (ou l'est mal). */
function dossierInstalle(tag) {
    const cible = path.join(emplacements.DOSSIER_VERSIONS, emplacements.nomDossierSur(tag));
    return emplacements.installationComplete(cible) ? cible : null;
}

/** Sous-ensemble de package.json qui décide du contenu de node_modules. */
function empreinteDependances(pkg) {
    if (!pkg) return null;
    const trier = (objet) =>
        Object.keys(objet || {})
            .sort()
            .map((cle) => `${cle}@${JSON.stringify(objet[cle])}`)
            .join(',');
    return [
        trier(pkg.dependencies),
        trier(pkg.optionalDependencies),
        trier(pkg.overrides),
    ].join('|');
}

/**
 * La release peut-elle se contenter du `node_modules` de la racine partagée ?
 *
 * La comparaison se fait avec le package.json de la racine, propriétaire de ce
 * `node_modules` — et non avec celui de la version en cours d'exécution, qui
 * peut elle-même être une release munie de ses propres dépendances.
 */
function dependancesCompatibles(pkgVersion) {
    const pkgRacine = emplacements.lirePackage(emplacements.RACINE_PARTAGEE);
    if (!pkgRacine) return false;
    return empreinteDependances(pkgRacine) === empreinteDependances(pkgVersion);
}

/**
 * Lance `npm install` dans le dossier d'une version.
 *
 * Sur Windows, `npm` est un script `.cmd` que Node refuse de lancer directement
 * depuis les versions récentes : le passage par le shell est ici sans risque,
 * la ligne de commande étant entièrement constante.
 */
function npmInstall(dossier, onLigne) {
    return new Promise((resolve, reject) => {
        const commande = process.platform === 'win32' ? 'npm.cmd' : 'npm';
        const enfant = spawn(commande, ['install', '--omit=dev', '--no-audit', '--no-fund'], {
            cwd: dossier,
            shell: process.platform === 'win32',
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        const minuterie = setTimeout(() => {
            enfant.kill();
            reject(new Error('npm install a dépassé le délai imparti.'));
        }, DELAI_NPM_MS);

        const relayer = (flux) => {
            flux.setEncoding('utf8');
            flux.on('data', (bloc) => {
                const ligne = String(bloc).trim().split('\n').pop();
                if (ligne && onLigne) onLigne(ligne.slice(0, 200));
            });
        };
        relayer(enfant.stdout);
        relayer(enfant.stderr);

        enfant.on('error', (err) => {
            clearTimeout(minuterie);
            reject(new Error(`npm introuvable ou non lançable : ${err.message}`));
        });
        enfant.on('close', (code) => {
            clearTimeout(minuterie);
            if (code === 0) return resolve();
            reject(new Error(`npm install a échoué (code ${code}).`));
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
async function installer(tag, onEtape = () => {}) {
    const nomDossier = emplacements.nomDossierSur(tag);
    const cible = path.join(emplacements.DOSSIER_VERSIONS, nomDossier);

    // Refus avant toute écriture : dépôt de développement, version en cours
    // d'exécution, ou cible hors du dossier des versions.
    emplacements.verifierCibleInstallable(cible);

    if (emplacements.installationComplete(cible)) {
        log.info(`[Versions] ${tag} est déjà installée : réutilisation de ${cible}.`);
        return { dossier: cible, tag, dejaInstallee: true };
    }

    // Le dossier existe mais son marqueur manque : extraction interrompue,
    // jamais démarrée. Il n'a donc jamais servi et peut céder la place.
    if (fs.existsSync(cible)) {
        log.warn(`[Versions] Installation incomplète détectée pour ${tag}, elle est reprise à zéro.`);
        supprimerSansBruit(cible);
    }

    onEtape({ phase: 'recherche' });
    const releases = await github.listerReleases({ forcer: true });
    const release = releases.find((r) => r.tag === tag);
    if (!release) {
        throw new Error(`La release ${tag} est introuvable sur le dépôt.`);
    }

    onEtape({ phase: 'telechargement', pourcent: 0 });
    let dernierPourcent = -1;
    const archive = await github.telechargerArchive(release.tarballUrl, (recus, total) => {
        const pourcent = total ? Math.floor((recus / total) * 100) : null;
        // Une notification par point de pourcentage : le tableau de bord n'a
        // rien à faire d'un message par paquet TCP.
        if (pourcent === null || pourcent !== dernierPourcent) {
            dernierPourcent = pourcent;
            onEtape({ phase: 'telechargement', pourcent, octets: recus, total });
        }
    });

    fs.mkdirSync(emplacements.DOSSIER_VERSIONS, { recursive: true });
    const temporaire = path.join(
        emplacements.DOSSIER_VERSIONS,
        `${PREFIXE_TEMPORAIRE}${nomDossier}-${process.pid}-${Date.now().toString(36)}`
    );

    try {
        onEtape({ phase: 'extraction' });
        const resultat = extraireTarGz(archive, temporaire);
        log.info(`[Versions] ${tag} : ${resultat.fichiers} fichiers extraits.`);

        const pkg = emplacements.lirePackage(temporaire);
        if (!pkg) throw new Error('Archive invalide : package.json absent.');
        if (!fs.existsSync(emplacements.entreePour(temporaire))) {
            throw new Error('Archive invalide : src/index.js absent.');
        }

        let dependancesLocales = false;
        if (dependancesCompatibles(pkg)) {
            log.info('[Versions] Dépendances identiques à la racine : node_modules partagé réutilisé.');
        } else {
            log.info('[Versions] Dépendances différentes de la racine : npm install local.');
            onEtape({ phase: 'dependances', message: 'npm install' });
            await npmInstall(temporaire, (ligne) => onEtape({ phase: 'dependances', message: ligne }));
            dependancesLocales = true;
        }

        fs.writeFileSync(
            path.join(temporaire, emplacements.FICHIER_MARQUEUR),
            JSON.stringify(
                {
                    tag,
                    version: pkg.version || null,
                    installeeLe: new Date().toISOString(),
                    dependancesLocales,
                    complete: true,
                },
                null,
                2
            ),
            'utf8'
        );

        // Bascule finale. Le renommage est atomique sur un même volume : la
        // version apparaît complète ou pas du tout.
        fs.renameSync(temporaire, cible);
        github.viderCache();
        log.info(`[Versions] ${tag} installée dans ${cible}.`);
        return { dossier: cible, tag, dejaInstallee: false };
    } catch (err) {
        supprimerSansBruit(temporaire);
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
 *   - le garde-fou d'`emplacements` écarte le dépôt de développement et la
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
function desinstaller(tag) {
    const cible = path.join(emplacements.DOSSIER_VERSIONS, emplacements.nomDossierSur(tag));

    emplacements.verifierCibleSupprimable(cible);

    if (!fs.existsSync(cible)) {
        throw new Error(`La version ${tag} n'est pas installée.`);
    }

    try {
        fs.rmSync(cible, { recursive: true, force: true });
    } catch (err) {
        throw new Error(`Suppression impossible pour ${tag} : ${err.message}`);
    }

    log.info(`[Versions] ${tag} désinstallée (${cible} supprimé).`);
    return { dossier: cible, tag };
}

module.exports = {
    desinstaller,
    dossierInstalle,
    installer,
    listerInstallees,
    nettoyerTemporaires,
};
