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
const locations = require('./locations');

const API = 'https://api.github.com';
const AGENT = 'interactive-music-player';

/** Dépôt par défaut, si ni l'environnement ni package.json ne renseignent mieux. */
const DEFAULT_REPO = { owner: 'WolfGang-PRoxa', repo: 'interactive_music_player' };

/** Taille maximale acceptée pour une archive, garde-fou mémoire. */
const MAX_ARCHIVE_BYTES = 300 * 1024 * 1024;

/** Cache court : le menu déroulant interroge l'API à chaque ouverture. */
const CACHE_TTL_MS = 20 * 1000;
let releasesCache = null;

let resolvedToken;

/**
 * Extrait `owner/repo` d'une URL de dépôt GitHub, quelle qu'en soit la forme
 * (`https://`, `git+https://`, `git@github.com:`, avec ou sans `.git`).
 */
function parseRepoUrl(url) {
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
function repository() {
    const raw = (process.env.IMP_REPO || '').trim();
    if (raw) {
        const direct = /^([^/\s]+)\/([^/\s]+)$/.exec(raw);
        if (direct) return { owner: direct[1], repo: direct[2] };
        const parsed = parseRepoUrl(raw);
        if (parsed) return parsed;
    }

    const pkg = locations.readPackage(locations.INSTALL_ROOT);
    const fromPackage = pkg && pkg.repository
        ? parseRepoUrl(typeof pkg.repository === 'string' ? pkg.repository : pkg.repository.url)
        : null;

    return fromPackage || DEFAULT_REPO;
}

/**
 * Jeton d'accès, ou null si le dépôt doit être lu anonymement.
 *
 * Résolu une seule fois : interroger `gh` coûte le lancement d'un process, et
 * le résultat ne change pas en cours d'exécution.
 */
function token() {
    if (resolvedToken !== undefined) return resolvedToken;

    const fromEnv = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();
    if (fromEnv) {
        resolvedToken = fromEnv;
        return resolvedToken;
    }

    try {
        const output = execFileSync('gh', ['auth', 'token'], {
            encoding: 'utf8',
            timeout: 5000,
            stdio: ['ignore', 'pipe', 'ignore'],
            windowsHide: true,
        }).trim();
        resolvedToken = output || null;
        if (resolvedToken) log.info('[Versions] GitHub token picked up from the gh CLI.');
    } catch (e) {
        // `gh` absent ou déconnecté : lecture anonyme, suffisante sur un dépôt public.
        resolvedToken = null;
    }
    return resolvedToken;
}

function headers(withToken = true) {
    const h = {
        'User-Agent': AGENT,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
    };
    const t = withToken ? token() : null;
    if (t) h.Authorization = `Bearer ${t}`;
    return h;
}

/**
 * Erreur portant le code HTTP, pour que l'appelant traduise 404 et 403 en
 * messages compréhensibles plutôt qu'en trace technique.
 */
class GitHubError extends Error {
    constructor(message, status) {
        super(message);
        this.name = 'GitHubError';
        this.status = status;
    }
}

/**
 * GET suivant les redirections, avec report de progression.
 *
 * L'en-tête `Authorization` est retiré dès que la redirection change d'hôte :
 * l'API renvoie vers un stockage d'objets signé qui rejette une seconde
 * authentification, et le jeton n'a de toute façon rien à faire chez un tiers.
 *
 * @param {(received: number, total: number|null) => void} [onProgress]
 * @returns {Promise<{ status: number, body: Buffer, headers: object }>}
 */
function request(url, options = {}, onProgress = null, redirectsLeft = 5) {
    return new Promise((resolve, reject) => {
        const target = new URL(url);
        const req = https.request(
            target,
            { method: 'GET', headers: options.headers || headers(), timeout: options.timeout || 30000 },
            (res) => {
                const status = res.statusCode || 0;

                if (status >= 300 && status < 400 && res.headers.location) {
                    res.resume();
                    if (redirectsLeft <= 0) {
                        return reject(new GitHubError('Trop de redirections.', status));
                    }
                    const next = new URL(res.headers.location, target);
                    const sameHost = next.host === target.host;
                    const nextHeaders = { ...(options.headers || headers()) };
                    if (!sameHost) delete nextHeaders.Authorization;
                    return resolve(
                        request(
                            next.toString(),
                            { ...options, headers: nextHeaders },
                            onProgress,
                            redirectsLeft - 1
                        )
                    );
                }

                const total = Number(res.headers['content-length']) || null;
                if (total && total > MAX_ARCHIVE_BYTES) {
                    res.destroy();
                    return reject(new GitHubError(`Archive trop volumineuse (${total} octets).`, status));
                }

                const chunks = [];
                let received = 0;
                res.on('data', (c) => {
                    received += c.length;
                    if (received > MAX_ARCHIVE_BYTES) {
                        res.destroy();
                        return reject(new GitHubError('Archive trop volumineuse.', status));
                    }
                    chunks.push(c);
                    if (onProgress) onProgress(received, total);
                });
                res.on('end', () => resolve({ status, body: Buffer.concat(chunks), headers: res.headers }));
                res.on('error', reject);
            }
        );

        req.on('timeout', () => req.destroy(new GitHubError('Délai dépassé.', 0)));
        req.on('error', (err) => reject(new GitHubError(err.message, 0)));
        req.end();
    });
}

/** Traduit un statut d'erreur de l'API en message affichable tel quel. */
function apiErrorMessage(status, body) {
    if (status === 404) {
        return token()
            ? 'Dépôt ou releases introuvables. Vérifiez que le jeton GitHub donne accès à ce dépôt.'
            : 'Dépôt introuvable. S\'il est privé, renseignez GITHUB_TOKEN dans le fichier .env.';
    }
    if (status === 401) return 'Jeton GitHub refusé (expiré ou révoqué).';
    if (status === 403 || status === 429) {
        return token()
            ? 'Quota GitHub atteint. Réessayez dans quelques minutes.'
            : 'Quota GitHub atteint (60 requêtes/heure sans jeton). Renseignez GITHUB_TOKEN dans le .env pour le relever.';
    }
    let detail = '';
    try {
        const j = JSON.parse(body.toString('utf8'));
        if (j && j.message) detail = ` — ${j.message}`;
    } catch (e) {}
    return `GitHub a répondu ${status}${detail}.`;
}

/**
 * Releases publiées, de la plus récente à la plus ancienne.
 *
 * Les brouillons sont écartés : ils ne sont visibles que du mainteneur et leur
 * archive n'est pas servie. Les préversions sont conservées, signalées par leur
 * drapeau pour que l'interface les distingue.
 *
 * @param {{ forcer?: boolean }} [options] - `forcer` court-circuite le cache
 * @returns {Promise<Array<{ tag, name, publishedAt, prerelease, tarballUrl, htmlUrl }>>}
 */
async function listReleases(options = {}) {
    if (!options.force && releasesCache && Date.now() - releasesCache.date < CACHE_TTL_MS) {
        return releasesCache.value;
    }

    const { owner, repo } = repository();
    const { status, body } = await request(`${API}/repos/${owner}/${repo}/releases?per_page=100`);

    if (status !== 200) {
        throw new GitHubError(apiErrorMessage(status, body), status);
    }

    let raw;
    try {
        raw = JSON.parse(body.toString('utf8'));
    } catch (e) {
        throw new GitHubError('Réponse GitHub illisible.', status);
    }
    if (!Array.isArray(raw)) throw new GitHubError('Réponse GitHub inattendue.', status);

    const releases = raw
        .filter((r) => r && !r.draft && r.tag_name)
        .map((r) => ({
            tag: String(r.tag_name),
            name: r.name ? String(r.name) : String(r.tag_name),
            publishedAt: r.published_at || r.created_at || null,
            prerelease: !!r.prerelease,
            tarballUrl: r.tarball_url || `${API}/repos/${owner}/${repo}/tarball/${encodeURIComponent(r.tag_name)}`,
            htmlUrl: r.html_url || null,
        }));

    releasesCache = { date: Date.now(), value: releases };
    return releases;
}

/**
 * Télécharge l'archive `.tar.gz` du code source d'une release.
 *
 * @param {string} tarballUrl
 * @param {(received: number, total: number|null) => void} [onProgress]
 * @returns {Promise<Buffer>}
 */
async function downloadArchive(tarballUrl, onProgress) {
    const { status, body } = await request(tarballUrl, {}, onProgress);
    if (status !== 200) {
        throw new GitHubError(apiErrorMessage(status, body), status);
    }
    if (!body.length) throw new GitHubError('Archive vide reçue de GitHub.', status);
    log.info(`[Versions] Archive downloaded: ${(body.length / 1024 / 1024).toFixed(1)} MB.`);
    return body;
}

/** Vide le cache des releases (après une installation, pour rafraîchir l'état). */
function clearCache() {
    releasesCache = null;
}

module.exports = {
    GitHubError,
    repository,
    token,
    listReleases,
    downloadArchive,
    clearCache,
};
