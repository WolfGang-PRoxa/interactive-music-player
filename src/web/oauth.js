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
 * Relais de retour employé par défaut.
 *
 * Un Worker Cloudflare déployé une fois pour toutes les installations (voir
 * oauthRelay.js et tools/oauth-relay/). Chaque installation peut désigner le
 * sien par `OAUTH_RELAY_URL`, ou s'en passer avec `OAUTH_RELAY_URL=off`.
 */
const DEFAULT_RELAY_URL = 'https://imp-auth.romainpiau.dev/discord/callback';

/** L'adresse écrite à la main dans `.env`, sans barre oblique finale, ou ''. */
function declaredUrl() {
    return (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
}

/** L'adresse locale du tableau de bord, celle qui marche sans rien déclarer. */
function localUrl() {
    const port = process.env.PORT || 3000;
    return `http://localhost:${port}`;
}

/**
 * Le relais de retour, ou null s'il est écarté.
 * @returns {string|null}
 */
function relayUrl() {
    const raw = (process.env.OAUTH_RELAY_URL || '').trim();
    if (!raw) return DEFAULT_RELAY_URL;
    if (/^(off|none|false|0)$/i.test(raw)) return null;
    return raw;
}

/**
 * Le retour de Discord passe-t-il par le relais ?
 *
 * Oui dès qu'aucune adresse fixe n'est déclarée : c'est le cas du partage
 * rapide, dont l'adresse change à chaque lancement, et celui de l'usage purement
 * local. Une adresse fixe — un domaine derrière un tunnel nommé, une IP de
 * réseau local — se déclare directement chez Discord, comme avant, et le relais
 * n'a plus rien à faire.
 *
 * @returns {boolean}
 */
function usesRelay() {
    return !declaredUrl() && Boolean(relayUrl());
}

/**
 * L'adresse du partage rapide, quand il est en ligne.
 *
 * Demandée au module du tunnel au moment de l'appel, et jamais recopiée dans
 * `PUBLIC_URL` : elle change à chaque lancement, et l'écrire là ferait passer
 * une adresse de passage pour une adresse déclarée — les cookies se poseraient
 * en `Secure`, et la session de celui qui est devant la machine, en
 * `http://localhost`, ne tiendrait plus.
 *
 * @returns {string|null}
 */
function sharedUrl() {
    try {
        return require('./cloudflare').sharedUrl();
    } catch (e) {
        return null;
    }
}

/**
 * Adresse publique du tableau de bord, sans barre oblique finale.
 *
 * Celle qu'on donne aux invités : le lien posté dans le salon vocal, l'adresse
 * affichée dans la fenêtre de partage. Dans l'ordre : l'adresse déclarée, qui
 * l'emporte toujours ; celle du partage rapide quand il tourne ; l'adresse
 * locale à défaut, qui ne mène qu'à cette machine.
 *
 * @returns {string}
 */
function publicUrl() {
    return declaredUrl() || sharedUrl() || localUrl();
}

/**
 * L'adresse où ouvrir le tableau de bord sur cette machine.
 *
 * Elle diffère de `publicUrl()` quand le partage rapide tourne : s'ouvrir sur
 * l'adresse du tunnel ferait faire à la page un aller-retour par Cloudflare
 * pour atteindre un serveur posé à côté d'elle. Grâce au relais, la connexion
 * Discord revient sur l'origine d'où elle est partie, et `localhost` porte donc
 * une session aussi bien que le tunnel.
 *
 * Une adresse déclarée reste la règle quand il y en a une : le retour de Discord
 * y revient, et c'est la seule origine qui portera une session.
 *
 * @returns {string}
 */
function entryUrl() {
    return declaredUrl() || localUrl();
}

/** URL de rappel, telle qu'elle doit être déclarée dans le portail développeur. */
function redirectUri() {
    if (usesRelay()) return relayUrl();
    return `${declaredUrl() || localUrl()}/auth/discord/callback`;
}

/**
 * L'origine où renvoyer cette connexion-ci, quand le relais s'en charge.
 *
 * Celle par laquelle la requête est arrivée : c'est là que vivent les cookies
 * du navigateur — le jeton, le `nonce` de la connexion —, et donc là que le
 * retour doit revenir pour les retrouver. Le schéma ne se lit pas sur la
 * requête : derrière le tunnel elle arrive en clair, sur `127.0.0.1`. Il se
 * déduit de l'hôte — HTTPS pour le tunnel, HTTP pour la machine elle-même.
 *
 * @param {import('express').Request} req
 * @returns {string|null} null si le relais ne saurait pas y revenir — une IP de
 *   réseau local, par exemple, qui demande une adresse déclarée.
 */
function returnOrigin(req) {
    const host = String(req.headers.host || '').toLowerCase();
    if (!host) return null;
    const relay = require('./oauthRelay');
    return relay.acceptedTarget(`https://${host}`) || relay.acceptedTarget(`http://${host}`);
}

function purgeStates() {
    const now = Date.now();
    for (const [value, entry] of pendingStates.entries()) {
        if (now - entry.createdAt > STATE_TTL_MS) pendingStates.delete(value);
    }
}

/**
 * Ouvre un trajet d'authentification.
 *
 * Le `state` ne sert pas qu'à se prémunir de la falsification : il transporte
 * aussi ce que le rappel ne pourra pas redécouvrir tout seul.
 *
 * Le cas qui l'impose est celui du porteur du jeton. Le tableau de bord
 * s'ouvre sur `127.0.0.1`, où le cookie du jeton est posé, tandis que Discord
 * renvoie sur `PUBLIC_URL` — un nom de domaine, un tunnel, une adresse de
 * réseau local. Deux hôtes différents, donc deux bocaux à cookies : le rappel
 * arrive sans jeton, et rien ne permettrait plus de reconnaître celui qui est
 * devant la machine. La question est donc posée ici, sur l'origine du tableau
 * de bord où le cookie existe, et la réponse voyage dans le `state`.
 *
 * Elle y voyage sans risque : le `state` est tiré au hasard, gardé côté
 * serveur, valable cinq minutes et consommé une fois. Le navigateur n'en
 * connaît que la valeur, jamais ce qu'elle recouvre.
 *
 * @param {string} [returnTo] Chemin à rouvrir une fois l'invité reconnu.
 * Derrière le relais, le `state` porte en plus l'origine où revenir (voir
 * oauthRelay.js) : c'est le seul champ que Discord rende tel quel, et donc le
 * seul où le relais puisse la lire.
 *
 * @param {{ holdsToken?: boolean, claim?: boolean, silent?: boolean,
 *   nonce?: string, origin?: string }} [carried]
 *   Ce que le rappel devra savoir, et l'origine où revenir.
 * @returns {string} L'URL vers laquelle rediriger le navigateur.
 */
function buildAuthorizeUrl(returnTo = '/', carried = {}) {
    purgeStates();

    const state = usesRelay()
        ? require('./oauthRelay').encodeState(carried.origin || localUrl())
        : crypto.randomBytes(16).toString('hex');
    pendingStates.set(state, {
        createdAt: Date.now(),
        returnTo,
        holdsToken: Boolean(carried.holdsToken),
        claim: Boolean(carried.claim),
        /*
         * La tentative muette, celle que personne n'a demandée.
         *
         * La porte du tableau de bord essaie de reconnaître son visiteur avant
         * de lui montrer un bouton : c'est ce qui évite à un invité déjà admis
         * de se reconnecter à chaque venue. Discord peut très bien répondre
         * « je ne peux pas répondre sans lui parler », et ce n'est pas une
         * erreur — c'est la réponse attendue une fois sur deux.
         *
         * Le rappel doit donc savoir d'où vient la demande : d'un clic, auquel
         * un échec doit répondre par une page d'erreur, ou de cet essai-ci,
         * auquel il doit répondre en rendant la main sans un mot.
         */
        silent: Boolean(carried.silent),
        /*
         * L'empreinte du navigateur qui a demandé ce trajet.
         *
         * Le `state` se prémunissait de la falsification par son seul
         * caractère imprévisible, ce qui ne suffit pas : un attaquant peut en
         * demander un pour lui-même, puis faire charger le rappel à sa victime
         * avec son propre `code`. La victime se retrouvait alors connectée sous
         * le compte de l'attaquant, et tout ce qu'elle faisait ensuite lui était
         * imputé.
         *
         * Le `state` dit désormais *à qui* il a été remis. La valeur voyage dans
         * un cookie que seul ce navigateur-là possède ; le rappel exige que les
         * deux correspondent. Un `state` obtenu ailleurs ne vaut plus rien
         * ailleurs.
         */
        nonce: carried.nonce || null,
    });

    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('client_id', clientId());
    url.searchParams.set('redirect_uri', redirectUri());
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'identify');
    url.searchParams.set('state', state);
    /*
     * Discord ne montre son sélecteur de comptes que si on le lui demande.
     *
     * `none` reconnecte en silence celui qui est déjà ouvert : c'est ce qu'il
     * faut d'ordinaire — l'invité a déjà dit oui une fois, et le bot ne
     * demande que son nom — et exactement ce qu'il ne faut pas quand on vient
     * précisément pour en changer. Sans ce détour, « changer de compte »
     * rouvrirait la session du même compte, sans rien dire.
     */
    url.searchParams.set('prompt', carried.claim ? 'consent' : 'none');

    return url.toString();
}

/**
 * Vérifie un `state` reçu au rappel et le consomme.
 *
 * Un `state` ne sert qu'une fois : sans cela, un rappel rejoué ouvrirait une
 * seconde session.
 *
 * @param {string} state
 * @returns {{ returnTo: string, holdsToken: boolean, claim: boolean, silent: boolean,
 *   nonce: string|null }|null}
 *   null si inconnu, déjà servi ou périmé.
 */
function consumeState(state) {
    purgeStates();
    if (!state) return null;

    const entry = pendingStates.get(state);
    if (!entry) return null;

    pendingStates.delete(state);
    return {
        returnTo: entry.returnTo || '/',
        holdsToken: Boolean(entry.holdsToken),
        claim: Boolean(entry.claim),
        silent: Boolean(entry.silent),
        nonce: entry.nonce || null,
    };
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
        throw new Error(`code exchange refused (HTTP ${response.status}) ${detail}`.trim());
    }

    const payload = await response.json();
    if (!payload.access_token) throw new Error('response without an access token');
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
        throw new Error(`identity read refused (HTTP ${response.status})`);
    }

    const user = await response.json();
    if (!user || !user.id) throw new Error('incomplete identity');
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
        log.warn('[OAuth] Control sharing unavailable: DISCORD_CLIENT_ID or '
            + 'DISCORD_CLIENT_SECRET missing from .env.');
        return;
    }
    log.info(`[OAuth] Discord authentication active. Callback URL to declare in the `
        + `developer portal: ${redirectUri()}`);
    if (usesRelay()) {
        log.info('[OAuth] No fixed address declared: Discord returns through the relay, '
            + 'which sends each sign-in back to the address it started from '
            + '(this machine, or the quick share).');
    } else if (!declaredUrl()) {
        log.warn('[OAuth] PUBLIC_URL is not set and the relay is off: the callback URL '
            + 'points at localhost, and will only work for a guest sitting at this machine.');
    }
}

module.exports = {
    STATE_TTL_MS,
    DEFAULT_RELAY_URL,
    isConfigured,
    clientId,
    declaredUrl,
    publicUrl,
    entryUrl,
    relayUrl,
    usesRelay,
    redirectUri,
    returnOrigin,
    buildAuthorizeUrl,
    consumeState,
    exchangeCode,
    fetchUser,
    identifyFromCode,
    logConfiguration,
};
