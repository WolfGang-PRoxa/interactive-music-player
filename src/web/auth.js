/**
 * auth — Authentification du dashboard (HTTP + WebSocket).
 *
 * Un jeton partagé unique protège l'ensemble du serveur web. Sans lui, toute
 * machine capable d'atteindre le port pouvait piloter le bot, lire des fichiers
 * et éteindre le process.
 *
 * Le jeton provient de DASHBOARD_TOKEN ; à défaut il est généré au premier
 * démarrage et persisté dans data/dashboard-token.
 *
 * Il circule en **cookie**, et non en en-tête Authorization : le dashboard
 * charge ses médias via <audio src>, <video src> et des liens de
 * téléchargement, qui ne peuvent pas porter d'en-tête personnalisé. Le cookie
 * présente un second avantage : le navigateur le transmet aussi lors du
 * handshake WebSocket same-origin, ce qui protège le WS sans toucher au client.
 *
 * Pour éviter d'avoir à saisir le jeton en usage local, le navigateur est ouvert
 * sur une URL contenant ?token=... : le middleware pose alors le cookie et
 * redirige vers l'URL propre.
 *
 * **Le jeton ouvre la porte, il ne dit plus qui entre.** Il fut un temps où le
 * porter suffisait à tout pouvoir, anonymement. Le tableau de bord demande
 * désormais à chacun de se nommer : les droits sont attachés à une session
 * Discord (voir oauth.js et sessions.js), qu'on soit propriétaire de
 * l'installation (owner.js) ou invité pourvu de quelques droits
 * (permissions.js). Un jeton sans session obtient l'accès à la page — il faut
 * bien servir celle qui porte la fenêtre de connexion — et rien d'autre :
 * `pendingLogin` le signale, et l'interface bloque tant qu'il n'a pas répondu.
 *
 * La seule exception est l'installation dont l'application Discord n'est pas
 * configurée : s'y connecter est alors matériellement impossible, et refuser
 * reviendrait à enfermer quelqu'un hors de son propre bot pour un secret
 * manquant dans un fichier. Le jeton y reprend son ancien rôle, et l'interface
 * le dit au lieu de le taire.
 *
 * Ce module ne tranche pas les droits. Il répond seulement à « qui frappe ? »,
 * et refuse ceux qui ne sont ni l'un ni l'autre.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const log = require('../utils/logger');
const sessions = require('./sessions');
const owner = require('./owner');

const COOKIE_NAME = 'dashboard_token';
const TOKEN_FILE = path.join(process.cwd(), 'data', 'dashboard-token');

let token = null;

/**
 * Charge le jeton depuis l'environnement ou le disque, ou en génère un.
 * @returns {string}
 */
function getToken() {
    if (token) return token;

    const fromEnv = (process.env.DASHBOARD_TOKEN || '').trim();
    if (fromEnv) {
        token = fromEnv;
        return token;
    }

    try {
        const stored = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
        if (stored) {
            token = stored;
            return token;
        }
    } catch (e) {
        // Premier démarrage : le fichier n'existe pas encore
    }

    token = crypto.randomBytes(32).toString('hex');
    try {
        fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
        fs.writeFileSync(TOKEN_FILE, token, { encoding: 'utf8', mode: 0o600 });
        log.info(`[Auth] Dashboard token generated and saved in ${TOKEN_FILE}`);
    } catch (err) {
        log.error(`[Auth] Cannot save the token: ${err.message}`);
        log.error('[Auth] A new token will be generated on the next startup.');
    }
    return token;
}

/** Comparaison à temps constant, pour ne pas fuiter le jeton octet par octet. */
function safeEquals(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

function parseCookies(cookieHeader) {
    const jar = {};
    if (!cookieHeader) return jar;
    for (const part of cookieHeader.split(';')) {
        const index = part.indexOf('=');
        if (index === -1) continue;
        const key = part.slice(0, index).trim();
        const value = part.slice(index + 1).trim();
        if (key) {
            try {
                jar[key] = decodeURIComponent(value);
            } catch (e) {
                jar[key] = value;
            }
        }
    }
    return jar;
}

/**
 * Extrait le jeton présenté par une requête, quelle qu'en soit la forme.
 * @param {import('http').IncomingMessage} req
 * @returns {{ value: string|null, source: 'query'|'cookie'|'header'|null }}
 */
function extractToken(req) {
    let queryToken = null;
    try {
        queryToken = new URL(req.url, 'http://localhost').searchParams.get('token');
    } catch (e) {
        // URL malformée : on poursuit avec les autres sources
    }
    if (queryToken) return { value: queryToken, source: 'query' };

    const cookies = parseCookies(req.headers.cookie);
    if (cookies[COOKIE_NAME]) return { value: cookies[COOKIE_NAME], source: 'cookie' };

    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        return { value: authHeader.slice(7).trim(), source: 'header' };
    }

    return { value: null, source: null };
}

function isAuthorized(req) {
    return identify(req).authorized;
}

/**
 * Chemins ouverts sans authentification.
 *
 * Le lien d'invitation est posté dans le tchat du salon vocal et cliqué par
 * quelqu'un qui n'a encore ni jeton ni session : la porte d'entrée du trajet
 * OAuth2 ne peut pas être fermée, sans quoi personne ne pourrait jamais
 * s'authentifier. Ces deux chemins ne donnent accès à rien d'autre qu'à
 * Discord et au retour de Discord.
 */
const PUBLIC_PATHS = new Set(['/auth/discord', '/auth/discord/callback']);

function isPublicPath(url) {
    try {
        return PUBLIC_PATHS.has(new URL(url, 'http://localhost').pathname);
    } catch (e) {
        return false;
    }
}

/**
 * Qui est derrière cette requête ?
 *
 * @param {import('http').IncomingMessage} req
 * @returns {{ authorized: boolean, master: boolean, session: object|null, tokenSource: string|null }}
 */
function identify(req) {
    const { value, source } = extractToken(req);
    const holdsToken = safeEquals(value, getToken());

    const cookies = parseCookies(req.headers.cookie);
    const session = sessions.touch(cookies[sessions.COOKIE_NAME]);

    /*
     * La session Discord passe avant le jeton, et l'ordre compte.
     *
     * Le tableau de bord ne s'ouvre plus à un porteur de jeton anonyme : il lui
     * demande d'abord de dire qui il est. Le propriétaire est donc reconnu à sa
     * session, pas à son cookie de jeton — sans quoi il resterait le seul de
     * toute l'installation à ne pas avoir de nom, et la fenêtre de connexion
     * n'aurait aucun effet sur lui.
     *
     * Le jeton n'a pas pour autant disparu : il reste ce qui distingue celui
     * qui est devant la machine de celui qui a cliqué sur un lien
     * d'invitation, et c'est à ce titre qu'il désigne le propriétaire lors de
     * la toute première connexion (voir owner.js).
     */
    if (session) {
        /*
         * La revendication de dernier recours.
         *
         * Elle a normalement lieu au retour de Discord, où le compte vient
         * d'être reconnu. Mais une session peut très bien exister sans que
         * l'installation ait été revendiquée : c'est le cas de celles ouvertes
         * avant que cette règle n'existe, et de celles dont le rappel est
         * arrivé sur une autre origine que le tableau de bord.
         *
         * Sans ce rattrapage, ces comptes-là sont coincés : la fenêtre de
         * connexion ne s'ouvre plus, puisqu'ils sont connectés, et rien ne leur
         * offre plus l'occasion de revendiquer quoi que ce soit. Il faudrait
         * effacer le cookie de session à la main pour s'en sortir.
         *
         * La condition reste la même — être connecté *et* porter le jeton —,
         * seul le moment change.
         */
        if (holdsToken && !owner.isClaimed()) {
            owner.claim({
                id: session.userId,
                username: session.displayName || session.username,
                avatar: session.avatar,
            });
        }

        return {
            authorized: true,
            master: owner.isOwner(session),
            session,
            holdsToken,
            pendingLogin: false,
            tokenSource: holdsToken ? source : null,
        };
    }

    if (holdsToken) {
        /*
         * Le jeton sans session. Deux situations, et une seule porte ouverte.
         *
         * Application Discord configurée : l'accès est accordé — il faut bien
         * servir la page qui porte la fenêtre de connexion — mais sans aucun
         * droit, et `pendingLogin` dit au tableau de bord de la présenter.
         *
         * Application non configurée : la connexion Discord est matériellement
         * impossible, et refuser serait enfermer quelqu'un hors de son propre
         * bot pour un secret manquant dans un fichier. Le jeton reprend alors
         * son rôle d'avant, et l'interface le signale au lieu de le taire.
         */
        const canLogIn = oauthConfigured();
        return {
            authorized: true,
            master: !canLogIn,
            session: null,
            holdsToken: true,
            pendingLogin: canLogIn,
            tokenSource: source,
        };
    }

    return {
        authorized: false,
        master: false,
        session: null,
        holdsToken: false,
        pendingLogin: false,
        tokenSource: null,
    };
}

/**
 * L'application Discord est-elle en état de recevoir une connexion ?
 *
 * Chargé à l'appel et non en tête de fichier : `oauth.js` n'a de sens que pour
 * l'identification par Discord, et l'exiger au chargement ferait dépendre
 * l'authentification de base d'un module qui peut très bien rester inerte.
 */
function oauthConfigured() {
    try {
        return require('./oauth').isConfigured();
    } catch (e) {
        return false;
    }
}

function unauthorizedPage() {
    // Chargé ici et non en tête de fichier : oauth.js ne sert qu'au moment du
    // refus, et l'exiger au chargement ferait dépendre l'authentification de
    // base d'un module qui n'a de sens que pour le partage.
    let button = '';
    try {
        const oauth = require('./oauth');
        if (oauth.isConfigured()) {
            button = `<p><a class="bouton" href="/auth/discord">Se connecter avec Discord</a></p>
     <p class="note">Si le maître de la session vous a partagé le contrôle, c'est par ici.</p>`;
        }
    } catch (e) {
        // Sans OAuth, la page reste celle du jeton seul.
    }
    return UNAUTHORIZED_PAGE.replace('<!--connexion-->', button);
}

const UNAUTHORIZED_PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Accès refusé</title>
<style>
  body { font-family: system-ui, sans-serif; background: #16161d; color: #e6e6ec;
         display: grid; place-items: center; height: 100vh; margin: 0; }
  main { max-width: 34rem; padding: 2rem; line-height: 1.6; }
  h1 { font-size: 1.4rem; margin-bottom: 0.5rem; }
  code { background: #26262f; padding: 0.15em 0.4em; border-radius: 4px; }
  .bouton { display: inline-block; background: #5865F2; color: #fff; padding: 0.6em 1.1em;
            border-radius: 8px; text-decoration: none; font-weight: 600; }
  .note { opacity: 0.7; font-size: 0.9em; }
  hr { border: none; border-top: 1px solid #2e2e38; margin: 1.6rem 0; }
</style></head>
<body><main>
  <h1>Accès refusé</h1>
  <!--connexion-->
  <hr>
  <p>Ce tableau de bord requiert un jeton d'accès.</p>
  <p>Ouvrez-le avec <code>?token=VOTRE_JETON</code>, ou récupérez le jeton dans
     <code>data/dashboard-token</code> (il est également affiché dans la console
     au démarrage du bot).</p>
</main></body></html>`;

/**
 * Middleware Express : refuse toute requête non authentifiée.
 *
 * Un jeton valide passé en query pose le cookie puis redirige vers l'URL
 * nettoyée, afin que le jeton ne reste ni dans la barre d'adresse ni dans le
 * Referer envoyé aux domaines tiers.
 */
function middleware(req, res, next) {
    // Le trajet OAuth2 précède toute identité : voir PUBLIC_PATHS.
    if (isPublicPath(req.originalUrl || req.url)) return next();

    const identity = identify(req);

    if (!identity.authorized) {
        res.status(401);
        if ((req.headers.accept || '').includes('text/html')) {
            return res.type('html').send(unauthorizedPage());
        }
        return res.json({ error: 'Jeton d\'accès manquant ou invalide' });
    }

    // Les routes lisent l'identité plutôt que de la redemander.
    req.identity = identity;

    if (identity.tokenSource === 'query') {
        res.cookie(COOKIE_NAME, extractToken(req).value, {
            httpOnly: true,
            sameSite: 'lax',
            maxAge: 1000 * 60 * 60 * 24 * 365,
        });

        if (req.method === 'GET') {
            const url = new URL(req.originalUrl, 'http://localhost');
            url.searchParams.delete('token');
            return res.redirect(302, url.pathname + url.search);
        }
    }

    next();
}

/**
 * Vérification du handshake WebSocket (option verifyClient de `ws`).
 * @param {{ req: import('http').IncomingMessage }} info
 * @returns {boolean}
 */
function verifyUpgrade(info) {
    const identity = identify(info.req);
    if (!identity.authorized) {
        log.warn('[Auth] WebSocket handshake refused: token missing or invalid.');
        return false;
    }
    // Rangée sur la requête, elle sera relue à l'ouverture de la connexion :
    // c'est le seul endroit où les en-têtes du handshake sont encore là.
    info.req.identity = identity;
    return true;
}

module.exports = {
    getToken,
    parseCookies,
    isAuthorized,
    identify,
    isPublicPath,
    middleware,
    verifyUpgrade,
    COOKIE_NAME,
    TOKEN_FILE,
};
