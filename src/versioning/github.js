/**
 * github — Lecture des releases du dépôt et téléchargement de leur archive.
 *
 * Le dépôt public se consulte sans identifiant : c'est le mode nominal, et rien
 * n'est à configurer. Un jeton reste accepté et utilisé s'il est trouvé, ce qui
 * couvre le dépôt encore privé et relève au passage le quota horaire de l'API
 * (60 requêtes par heure sans jeton, 5 000 avec).
 *
 * Le jeton est cherché dans `GITHUB_TOKEN`, puis `GH_TOKEN`, puis auprès du CLI
 * `gh` s'il est installé et connecté — de sorte qu'une machine de développement
 * déjà authentifiée n'a rien à renseigner.
 */

const https = require('https');
const { execFileSync } = require('child_process');
const log = require('../utils/logger');
const emplacements = require('./emplacements');

const API = 'https://api.github.com';
const AGENT = 'interactive-music-player';

/** Dépôt par défaut, si ni l'environnement ni package.json ne renseignent mieux. */
const DEPOT_DEFAUT = { owner: 'WolfGang-PRoxa', repo: 'interactive_music_player' };

/** Taille maximale acceptée pour une archive, garde-fou mémoire. */
const TAILLE_MAX_ARCHIVE = 300 * 1024 * 1024;

/** Cache court : le menu déroulant interroge l'API à chaque ouverture. */
const DUREE_CACHE_MS = 20 * 1000;
let cacheReleases = null;

let jetonResolu;

/**
 * Extrait `owner/repo` d'une URL de dépôt GitHub, quelle qu'en soit la forme
 * (`https://`, `git+https://`, `git@github.com:`, avec ou sans `.git`).
 */
function analyserUrlDepot(url) {
    const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(String(url || ''));
    return m ? { owner: m[1], repo: m[2] } : null;
}

/**
 * Dépôt à interroger.
 *
 * `IMP_REPO` prime, puis le champ `repository` du package.json de la version en
 * cours — il voyage avec chaque archive, donc une release installée sait d'où
 * elle vient sans dépendre du dépôt Git local (que l'archive ne contient pas).
 */
function depot() {
    const brut = (process.env.IMP_REPO || '').trim();
    if (brut) {
        const direct = /^([^/\s]+)\/([^/\s]+)$/.exec(brut);
        if (direct) return { owner: direct[1], repo: direct[2] };
        const parse = analyserUrlDepot(brut);
        if (parse) return parse;
    }

    const pkg = emplacements.lirePackage(emplacements.RACINE_INSTALLATION);
    const depuisPackage = pkg && pkg.repository
        ? analyserUrlDepot(typeof pkg.repository === 'string' ? pkg.repository : pkg.repository.url)
        : null;

    return depuisPackage || DEPOT_DEFAUT;
}

/**
 * Jeton d'accès, ou null si le dépôt doit être lu anonymement.
 *
 * Résolu une seule fois : interroger `gh` coûte le lancement d'un process, et
 * le résultat ne change pas en cours d'exécution.
 */
function jeton() {
    if (jetonResolu !== undefined) return jetonResolu;

    const depuisEnv = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();
    if (depuisEnv) {
        jetonResolu = depuisEnv;
        return jetonResolu;
    }

    try {
        const sortie = execFileSync('gh', ['auth', 'token'], {
            encoding: 'utf8',
            timeout: 5000,
            stdio: ['ignore', 'pipe', 'ignore'],
            windowsHide: true,
        }).trim();
        jetonResolu = sortie || null;
        if (jetonResolu) log.info('[Versions] Jeton GitHub repris du CLI gh.');
    } catch (e) {
        // `gh` absent ou déconnecté : lecture anonyme, suffisante sur un dépôt public.
        jetonResolu = null;
    }
    return jetonResolu;
}

function enTetes(avecJeton = true) {
    const h = {
        'User-Agent': AGENT,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
    };
    const t = avecJeton ? jeton() : null;
    if (t) h.Authorization = `Bearer ${t}`;
    return h;
}

/**
 * Erreur portant le code HTTP, pour que l'appelant traduise 404 et 403 en
 * messages compréhensibles plutôt qu'en trace technique.
 */
class ErreurGitHub extends Error {
    constructor(message, statut) {
        super(message);
        this.name = 'ErreurGitHub';
        this.statut = statut;
    }
}

/**
 * GET suivant les redirections, avec report de progression.
 *
 * L'en-tête `Authorization` est retiré dès que la redirection change d'hôte :
 * l'API renvoie vers un stockage d'objets signé qui rejette une seconde
 * authentification, et le jeton n'a de toute façon rien à faire chez un tiers.
 *
 * @param {(recus: number, total: number|null) => void} [onProgression]
 * @returns {Promise<{ statut: number, corps: Buffer, enTetes: object }>}
 */
function requete(url, options = {}, onProgression = null, redirectionsRestantes = 5) {
    return new Promise((resolve, reject) => {
        const cible = new URL(url);
        const req = https.request(
            cible,
            { method: 'GET', headers: options.headers || enTetes(), timeout: options.timeout || 30000 },
            (res) => {
                const statut = res.statusCode || 0;

                if (statut >= 300 && statut < 400 && res.headers.location) {
                    res.resume();
                    if (redirectionsRestantes <= 0) {
                        return reject(new ErreurGitHub('Trop de redirections.', statut));
                    }
                    const suivante = new URL(res.headers.location, cible);
                    const memeHote = suivante.host === cible.host;
                    const enTetesSuivants = { ...(options.headers || enTetes()) };
                    if (!memeHote) delete enTetesSuivants.Authorization;
                    return resolve(
                        requete(
                            suivante.toString(),
                            { ...options, headers: enTetesSuivants },
                            onProgression,
                            redirectionsRestantes - 1
                        )
                    );
                }

                const total = Number(res.headers['content-length']) || null;
                if (total && total > TAILLE_MAX_ARCHIVE) {
                    res.destroy();
                    return reject(new ErreurGitHub(`Archive trop volumineuse (${total} octets).`, statut));
                }

                const morceaux = [];
                let recus = 0;
                res.on('data', (c) => {
                    recus += c.length;
                    if (recus > TAILLE_MAX_ARCHIVE) {
                        res.destroy();
                        return reject(new ErreurGitHub('Archive trop volumineuse.', statut));
                    }
                    morceaux.push(c);
                    if (onProgression) onProgression(recus, total);
                });
                res.on('end', () => resolve({ statut, corps: Buffer.concat(morceaux), enTetes: res.headers }));
                res.on('error', reject);
            }
        );

        req.on('timeout', () => req.destroy(new ErreurGitHub('Délai dépassé.', 0)));
        req.on('error', (err) => reject(new ErreurGitHub(err.message, 0)));
        req.end();
    });
}

/** Traduit un statut d'erreur de l'API en message affichable tel quel. */
function messageErreurApi(statut, corps) {
    if (statut === 404) {
        return jeton()
            ? 'Dépôt ou releases introuvables. Vérifiez que le jeton GitHub donne accès à ce dépôt.'
            : 'Dépôt introuvable. S\'il est privé, renseignez GITHUB_TOKEN dans le fichier .env.';
    }
    if (statut === 401) return 'Jeton GitHub refusé (expiré ou révoqué).';
    if (statut === 403 || statut === 429) {
        return jeton()
            ? 'Quota GitHub atteint. Réessayez dans quelques minutes.'
            : 'Quota GitHub atteint (60 requêtes/heure sans jeton). Renseignez GITHUB_TOKEN dans le .env pour le relever.';
    }
    let detail = '';
    try {
        const j = JSON.parse(corps.toString('utf8'));
        if (j && j.message) detail = ` — ${j.message}`;
    } catch (e) {}
    return `GitHub a répondu ${statut}${detail}.`;
}

/**
 * Releases publiées, de la plus récente à la plus ancienne.
 *
 * Les brouillons sont écartés : ils ne sont visibles que du mainteneur et leur
 * archive n'est pas servie. Les préversions sont conservées, signalées par leur
 * drapeau pour que l'interface les distingue.
 *
 * @param {{ forcer?: boolean }} [options] - `forcer` court-circuite le cache
 * @returns {Promise<Array<{ tag, nom, publieeLe, prerelease, tarballUrl, htmlUrl }>>}
 */
async function listerReleases(options = {}) {
    if (!options.forcer && cacheReleases && Date.now() - cacheReleases.date < DUREE_CACHE_MS) {
        return cacheReleases.valeur;
    }

    const { owner, repo } = depot();
    const { statut, corps } = await requete(`${API}/repos/${owner}/${repo}/releases?per_page=100`);

    if (statut !== 200) {
        throw new ErreurGitHub(messageErreurApi(statut, corps), statut);
    }

    let brut;
    try {
        brut = JSON.parse(corps.toString('utf8'));
    } catch (e) {
        throw new ErreurGitHub('Réponse GitHub illisible.', statut);
    }
    if (!Array.isArray(brut)) throw new ErreurGitHub('Réponse GitHub inattendue.', statut);

    const releases = brut
        .filter((r) => r && !r.draft && r.tag_name)
        .map((r) => ({
            tag: String(r.tag_name),
            nom: r.name ? String(r.name) : String(r.tag_name),
            publieeLe: r.published_at || r.created_at || null,
            prerelease: !!r.prerelease,
            tarballUrl: r.tarball_url || `${API}/repos/${owner}/${repo}/tarball/${encodeURIComponent(r.tag_name)}`,
            htmlUrl: r.html_url || null,
        }));

    cacheReleases = { date: Date.now(), valeur: releases };
    return releases;
}

/**
 * Télécharge l'archive `.tar.gz` du code source d'une release.
 *
 * @param {string} tarballUrl
 * @param {(recus: number, total: number|null) => void} [onProgression]
 * @returns {Promise<Buffer>}
 */
async function telechargerArchive(tarballUrl, onProgression) {
    const { statut, corps } = await requete(tarballUrl, {}, onProgression);
    if (statut !== 200) {
        throw new ErreurGitHub(messageErreurApi(statut, corps), statut);
    }
    if (!corps.length) throw new ErreurGitHub('Archive vide reçue de GitHub.', statut);
    log.info(`[Versions] Archive téléchargée : ${(corps.length / 1024 / 1024).toFixed(1)} Mo.`);
    return corps;
}

/** Vide le cache des releases (après une installation, pour rafraîchir l'état). */
function viderCache() {
    cacheReleases = null;
}

module.exports = {
    ErreurGitHub,
    depot,
    jeton,
    listerReleases,
    telechargerArchive,
    viderCache,
};
