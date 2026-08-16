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
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const log = require('../utils/logger');

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
        log.info(`[Auth] Jeton du dashboard généré et enregistré dans ${TOKEN_FILE}`);
    } catch (err) {
        log.error(`[Auth] Impossible d'enregistrer le jeton : ${err.message}`);
        log.error('[Auth] Un nouveau jeton sera généré au prochain démarrage.');
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
    const { value } = extractToken(req);
    return safeEquals(value, getToken());
}

const UNAUTHORIZED_PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Accès refusé</title>
<style>
  body { font-family: system-ui, sans-serif; background: #16161d; color: #e6e6ec;
         display: grid; place-items: center; height: 100vh; margin: 0; }
  main { max-width: 34rem; padding: 2rem; line-height: 1.6; }
  h1 { font-size: 1.4rem; margin-bottom: 0.5rem; }
  code { background: #26262f; padding: 0.15em 0.4em; border-radius: 4px; }
</style></head>
<body><main>
  <h1>Accès refusé</h1>
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
    const { value, source } = extractToken(req);

    if (!safeEquals(value, getToken())) {
        res.status(401);
        if ((req.headers.accept || '').includes('text/html')) {
            return res.type('html').send(UNAUTHORIZED_PAGE);
        }
        return res.json({ error: 'Jeton d\'accès manquant ou invalide' });
    }

    if (source === 'query') {
        res.cookie(COOKIE_NAME, value, {
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
    const authorized = isAuthorized(info.req);
    if (!authorized) {
        log.warn('[Auth] Handshake WebSocket refusé : jeton manquant ou invalide.');
    }
    return authorized;
}

module.exports = {
    getToken,
    isAuthorized,
    middleware,
    verifyUpgrade,
    COOKIE_NAME,
    TOKEN_FILE,
};
