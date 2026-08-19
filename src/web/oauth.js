/**
 * oauth — Authentification des invités par leur compte Discord.
 *
 * Le maître de session partage le contrôle du bot avec des membres du salon
 * vocal. Encore faut-il savoir qui frappe à la porte : le jeton du tableau de
 * bord est unique et partagé, il ne distingue personne. Discord, lui, sait déjà
 * qui est qui — autant le lui demander.
 *
 * Le trajet est le flux OAuth2 « code d'autorisation », dans sa forme la plus
 * courte : on ne demande que la portée `identify`, c'est-à-dire le strict
 * nécessaire — identifiant, nom, avatar. Ni les serveurs, ni le courriel, ni
 * quoi que ce soit d'autre.
 *
 *   1. l'invité ouvre `/auth/discord`   → redirigé vers discord.com
 *   2. il autorise l'application        → Discord le renvoie sur `/auth/discord/callback?code=…`
 *   3. le serveur échange le code       → jeton d'accès, puis `GET /users/@me`
 *   4. une session s'ouvre (sessions.js) → le cookie identifie l'onglet
 *
 * Le jeton d'accès Discord ne sert qu'à l'étape 3 et n'est jamais conservé : ce
 * qu'on retient tient dans la session, et l'application n'a rien à faire au nom
 * de l'invité une fois qu'elle sait qui il est.
 *
 * **Ce module reste inerte tant que l'application n'est pas configurée.**
 * `DISCORD_CLIENT_SECRET` et une URL de rappel déclarée dans le portail
 * développeur sont indispensables ; `isConfigured()` permet au reste du serveur
 * de le dire clairement plutôt que d'échouer au milieu du trajet.
 */

const crypto = require('crypto');
const log = require('../utils/logger');

const DISCORD_API = 'https://discord.com/api/v10';
const AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';

/**
 * Durée de validité d'un `state`, en millisecondes.
 *
 * Le `state` ferme la porte à la falsification de requête : le rappel doit
 * présenter une valeur que ce serveur a lui-même émise. Cinq minutes suffisent
 * largement à cliquer « Autoriser », et bornent la table.
 */
const STATE_TTL_MS = 5 * 60 * 1000;

/** state → { createdAt, returnTo } */
const pendingStates = new Map();

function clientId() {
    return (process.env.DISCORD_CLIENT_ID || '').trim();
}

function clientSecret() {
    return (process.env.DISCORD_CLIENT_SECRET || '').trim();
}

/**
 * L'application peut-elle authentifier un invité ?
 * @returns {boolean}
 */
function isConfigured() {
    return Boolean(clientId() && clientSecret());
}

/**
 * Adresse publique du tableau de bord, sans barre oblique finale.
 *
 * Elle ne se devine pas : le serveur écoute sur `127.0.0.1` par défaut, et
 * l'adresse par laquelle un invité l'atteint — IP du réseau local, tunnel,
 * nom de domaine — n'est connue que de celui qui l'a installé. Discord exige
 * en outre que l'URL de rappel corresponde *exactement* à celle déclarée dans
 * le portail : la deviner à partir de l'en-tête `Host` donnerait une valeur
 * changeante, donc refusée une fois sur deux.
 *
 * @returns {string}
 */
function publicUrl() {
    const declared = (process.env.PUBLIC_URL || '').trim();
    if (declared) return declared.replace(/\/+$/, '');

    const port = process.env.PORT || 3000;
    return `http://localhost:${port}`;
}

/** URL de rappel, telle qu'elle doit être déclarée dans le portail développeur. */
function redirectUri() {
    return `${publicUrl()}/auth/discord/callback`;
}

function purgeStates() {
    const now = Date.now();
    for (const [value, entry] of pendingStates.entries()) {
        if (now - entry.createdAt > STATE_TTL_MS) pendingStates.delete(value);
    }
}

/**
 * Ouvre un trajet d'authentification.
 * @param {string} [returnTo] Chemin à rouvrir une fois l'invité reconnu.
 * @returns {string} L'URL vers laquelle rediriger le navigateur.
 */
function buildAuthorizeUrl(returnTo = '/') {
    purgeStates();

    const state = crypto.randomBytes(16).toString('hex');
    pendingStates.set(state, { createdAt: Date.now(), returnTo });

    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('client_id', clientId());
    url.searchParams.set('redirect_uri', redirectUri());
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'identify');
    url.searchParams.set('state', state);
    // Redemander l'accord à chaque fois n'apporte rien : l'invité a déjà dit oui
    // une fois, et le bot ne demande que son nom.
    url.searchParams.set('prompt', 'none');

    return url.toString();
}

/**
 * Vérifie un `state` reçu au rappel et le consomme.
 *
 * Un `state` ne sert qu'une fois : sans cela, un rappel rejoué ouvrirait une
 * seconde session.
 *
 * @param {string} state
 * @returns {{ returnTo: string }|null} null si inconnu, déjà servi ou périmé.
 */
function consumeState(state) {
    purgeStates();
    if (!state) return null;

    const entry = pendingStates.get(state);
    if (!entry) return null;

    pendingStates.delete(state);
    return { returnTo: entry.returnTo || '/' };
}

/**
 * Échange le code d'autorisation contre un jeton d'accès.
 * @param {string} code
 * @returns {Promise<string>} Le jeton d'accès.
 * @throws {Error} Si Discord refuse l'échange.
 */
async function exchangeCode(code) {
    const body = new URLSearchParams({
        client_id: clientId(),
        client_secret: clientSecret(),
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri(),
    });

    const response = await fetch(`${DISCORD_API}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
    });

    if (!response.ok) {
        // Le corps d'erreur de Discord nomme la cause — le plus souvent une URL
        // de rappel qui ne correspond pas à celle déclarée. Il mérite le journal.
        const detail = await response.text().catch(() => '');
        throw new Error(`échange du code refusé (HTTP ${response.status}) ${detail}`.trim());
    }

    const payload = await response.json();
    if (!payload.access_token) throw new Error('réponse sans jeton d\'accès');
    return payload.access_token;
}

/**
 * Lit l'identité derrière un jeton d'accès.
 * @param {string} accessToken
 * @returns {Promise<{ id: string, username: string, global_name?: string, avatar?: string }>}
 */
async function fetchUser(accessToken) {
    const response = await fetch(`${DISCORD_API}/users/@me`, {
        headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
        throw new Error(`lecture de l'identité refusée (HTTP ${response.status})`);
    }

    const user = await response.json();
    if (!user || !user.id) throw new Error('identité incomplète');
    return user;
}

/**
 * Trajet complet, du code reçu au rappel jusqu'à l'identité.
 * @param {string} code
 * @returns {Promise<{ id: string, username: string, global_name?: string, avatar?: string }>}
 */
async function identifyFromCode(code) {
    const accessToken = await exchangeCode(code);
    return fetchUser(accessToken);
}

/** Trace au démarrage l'état de la configuration, pour éviter la chasse au bug. */
function logConfiguration() {
    if (!isConfigured()) {
        log.warn('[OAuth] Partage du contrôle indisponible : DISCORD_CLIENT_ID ou '
            + 'DISCORD_CLIENT_SECRET manquant dans .env.');
        return;
    }
    log.info(`[OAuth] Authentification Discord active. URL de rappel à déclarer dans le `
        + `portail développeur : ${redirectUri()}`);
    if (!process.env.PUBLIC_URL) {
        log.warn('[OAuth] PUBLIC_URL n\'est pas défini : l\'URL de rappel pointe sur '
            + 'localhost, et ne vaudra que pour un invité assis devant cette machine.');
    }
}

module.exports = {
    isConfigured,
    publicUrl,
    redirectUri,
    buildAuthorizeUrl,
    consumeState,
    exchangeCode,
    fetchUser,
    identifyFromCode,
    logConfiguration,
};
