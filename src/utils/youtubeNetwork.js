/**
 * youtubeNetwork — L'IPv6 d'abord, l'IPv4 quand YouTube refuse la première.
 *
 * ## Le problème
 *
 * YouTube juge une adresse, pas une machine. Quand il en tient une pour un
 * robot, il cesse d'y décrire ses vidéos : l'API interne répond
 * `LOGIN_REQUIRED`, et yt-dlp « Sign in to confirm you're not a bot », quel que
 * soit le client qu'il imite. Le bot n'a alors plus rien à lire — aucun titre,
 * aucun flux, et le lien collé retombe sur « Aucun résultat ».
 *
 * Une connexion domestique a deux adresses, une IPv4 et une IPv6, et YouTube
 * les juge séparément. Le 27/09/2026, seule l'IPv6 était signalée : tous les
 * clients de yt-dlp refusés par elle, tous acceptés par l'IPv4, et de même pour
 * l'API interne. Or c'est l'IPv6 que le système choisit dès qu'elle existe.
 *
 * ## L'approche
 *
 * L'IPv6 reste la voie normale : rien ne change tant que YouTube l'accepte.
 * L'IPv4 n'est qu'un repli, pris au premier refus, et la requête refusée est
 * aussitôt rejouée par elle — l'utilisateur ne voit pas la bascule.
 *
 * Deux choses interrogent YouTube sans se voir, et chacune a son détecteur :
 *
 *  - **yt-dlp**, un autre processus : son message d'erreur. Voir `ytdlp()`,
 *    par où passe chacun de ses appels ;
 *  - **l'extracteur youtubei** de discord-player : la réponse de `/player`,
 *    lue au passage. Il échoue sinon sans rien dire — discord-player n'en
 *    retient que « aucun résultat ». Voir `installYoutubeiFallback()`.
 *
 * Le repli vaut ensuite pour tout ce qui touche YouTube, flux compris
 * (`familyFor()`, lu par rangeStream) : une adresse googlevideo obtenue par
 * l'IPv4 est signée pour elle, et la redemander par l'IPv6 coûterait une
 * redirection à chaque tranche.
 *
 * ## Le retour à l'IPv6
 *
 * Un signalement ne dure pas : au bout d'une heure, l'IPv6 est retentée. Si
 * elle est encore refusée, cela coûte une requête, rejouée comme la première —
 * le prix d'un retour qui se fait seul.
 *
 * ## Ce que ce module ne règle pas
 *
 * Que l'IPv4 soit signalée à son tour, et plus rien ne passe : le journal le
 * dit, et il reste à attendre ou à donner à yt-dlp les cookies d'un compte.
 * Sur une machine sans IPv6, la voie normale *est* l'IPv4, et le repli n'y
 * change rien — il ne fait alors que le constater.
 */

const log = require('./logger');

/** Durée du repli, avant de retenter l'IPv6. */
const IPV4_WINDOW_MS = 60 * 60 * 1000;

/** Les hôtes que le repli concerne : l'API, les flux et les images de YouTube. */
const YOUTUBE_HOST = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com|googlevideo\.com|ytimg\.com)$/i;

/**
 * Le message de refus, en anglais — celui de yt-dlp et de l'API par défaut —
 * comme en français, si la session youtubei est un jour réglée sur cette
 * langue. « Sign in to confirm your age » n'en est pas un : c'est une vidéo
 * réservée aux adultes, et aucune adresse n'y changerait rien.
 */
const BOT_CHECK = /not a bot|pas un robot/i;

let now = () => Date.now();

/** Début du repli en cours, ou null quand l'IPv6 est la voie. */
let ipv4Since = null;

/** L'IPv4 a-t-elle été refusée aussi pendant ce repli — pour ne le dire qu'une fois. */
let ipv4Refused = false;

let ipv4Dispatcher = null;

/**
 * Le repli est-il en cours ? Le lève quand son heure est passée.
 */
function onIpv4() {
    if (ipv4Since === null) return false;
    if (now() - ipv4Since < IPV4_WINDOW_MS) return true;

    ipv4Since = null;
    ipv4Refused = false;
    log.info('[YouTube] One hour on IPv4 is over: trying IPv6 again.');
    return false;
}

function fallBack(source) {
    if (ipv4Since !== null) return;
    ipv4Since = now();
    log.warn(`[YouTube] Refused as a bot over IPv6 (${source}): falling back to IPv4 for one hour.`);
}

function refusedOverIpv4(source) {
    if (ipv4Refused) return;
    ipv4Refused = true;
    log.error(`[YouTube] Refused as a bot over IPv4 as well (${source}): nothing will load until `
        + 'YouTube lifts the flag, or until yt-dlp is given account cookies.');
}

function isBotCheck(text) {
    return BOT_CHECK.test(String(text || ''));
}

/**
 * La famille à imposer pour cette adresse : 4 pendant un repli si elle mène à
 * YouTube, sinon rien — le système choisit.
 *
 * @param {string} url
 * @returns {4|undefined}
 */
function familyFor(url) {
    let host;
    try {
        host = new URL(url).hostname;
    } catch (e) {
        return undefined;
    }
    return YOUTUBE_HOST.test(host) && onIpv4() ? 4 : undefined;
}

/**
 * Appelle yt-dlp, par l'IPv4 si l'IPv6 est refusée.
 *
 * Même signature que `youtube-dl-exec`, qui est requis ici à chaque appel et
 * non une fois pour toutes : les tests le remplacent dans le cache de
 * `require`, et c'est ainsi qu'ils continuent de le trouver.
 *
 * @param {string} url
 * @param {object} flags
 * @param {object} [options]
 */
async function ytdlp(url, flags, options) {
    const youtubedl = require('youtube-dl-exec');

    if (!onIpv4()) {
        try {
            return await youtubedl(url, flags, options);
        } catch (err) {
            if (!isBotCheck(err && err.message)) throw err;
            fallBack('yt-dlp');
        }
    }

    try {
        return await youtubedl(url, { ...flags, forceIpv4: true }, options);
    } catch (err) {
        if (isBotCheck(err && err.message)) refusedOverIpv4('yt-dlp');
        throw err;
    }
}

/** L'appel est-il celui qui décrit une vidéo — le seul que YouTube refuse ainsi ? */
function isPlayerCall(input) {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    return /\/youtubei\/v1\/player\b/.test(url);
}

/** Lit la réponse sur une copie : l'original reste entier pour youtubei. */
async function refusedAsBot(response) {
    try {
        const data = await response.clone().json();
        const status = data && data.playabilityStatus;
        return !!status && status.status === 'LOGIN_REQUIRED' && isBotCheck(status.reason);
    } catch (e) {
        return false;
    }
}

/**
 * Un répartiteur de `fetch` qui ne sort que par l'IPv4.
 *
 * Construit sur la classe du répartiteur global, et non sur le paquet
 * `undici` : Node embarque son propre undici, qu'on ne peut pas importer, et
 * celui du dossier node_modules — tiré par discord.js — n'est pas de la même
 * version. Le répartiteur global est par construction celui dont le `fetch` de
 * Node se sert ; sa classe est donc la bonne. Il n'existe qu'après un premier
 * `fetch`, qu'une adresse `data:` suffit à provoquer sans toucher au réseau.
 *
 * Ses connexions lui sont propres : une connexion IPv6 restée ouverte dans le
 * répartiteur global ne peut pas être reprise par erreur pour la requête
 * rejouée.
 *
 * @param {Function} fetchImpl
 */
async function ipv4Agent(fetchImpl) {
    if (ipv4Dispatcher) return ipv4Dispatcher;
    const key = Symbol.for('undici.globalDispatcher.1');
    if (!globalThis[key]) await fetchImpl('data:,');
    ipv4Dispatcher = new globalThis[key].constructor({ connect: { family: 4 } });
    return ipv4Dispatcher;
}

/**
 * Enveloppe un `fetch` du repli vers l'IPv4.
 *
 * Exposé pour les tests, qui lui passent un faux `fetch` et un faux
 * répartiteur.
 *
 * @param {Function} original
 * @param {Function} [agentFor4]
 */
function wrapFetch(original, agentFor4 = () => ipv4Agent(original)) {
    return async function fetchWithIpv4Fallback(input, init = {}) {
        // Un mandataire configuré décide seul de la route.
        if (init.dispatcher) return original(input, init);

        if (onIpv4()) return original(input, { ...init, dispatcher: await agentFor4() });

        const response = await original(input, init);
        if (!isPlayerCall(input) || !(await refusedAsBot(response))) return response;

        fallBack('youtubei');
        // Rejouable : youtubei passe le corps dans `init`, sous forme de texte,
        // et non dans la requête — il n'a pas été consommé.
        const retry = await original(input, { ...init, dispatcher: await agentFor4() });
        if (await refusedAsBot(retry)) refusedOverIpv4('youtubei');
        return retry;
    };
}

/**
 * Branche le repli sur les requêtes de youtubei.
 *
 * L'extracteur appelle `Platform.shim.fetch` à chaque requête, sans en garder
 * de référence : remplacer la fonction sur l'objet suffit, et vaut pour les
 * sessions déjà ouvertes comme pour les suivantes.
 */
function installYoutubeiFallback() {
    const { Platform } = require('youtubei.js');
    const shim = Platform.shim;
    if (shim.fetch && shim.fetch.name === 'fetchWithIpv4Fallback') return;
    shim.fetch = wrapFetch(shim.fetch);
}

module.exports = {
    ytdlp,
    familyFor,
    installYoutubeiFallback,
    wrapFetch,
    isBotCheck,
    /** Pour les tests : horloge factice, et retour à l'état de départ. */
    _setClock(fn) { now = fn; },
    _reset() { ipv4Since = null; ipv4Refused = false; },
};
