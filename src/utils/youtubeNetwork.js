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
 * ## Faire le moins de bruit possible
 *
 * Mieux vaut ne pas être signalé que savoir se replier. Ce qui fait passer pour
 * un robot, c'est le nombre de demandes et leur rythme ; trois mesures les
 * réduisent, toutes dans `ytdlp()` :
 *
 *  - **une seule extraction par vidéo.** Le 27/09/2026, un morceau en cours de
 *    préchargement a été extrait cinq fois en trente-cinq secondes : chaque
 *    requête du lecteur du tableau de bord relançait la sienne. Le résultat est
 *    désormais gardé — une heure au plus, et jamais au-delà de l'expiration
 *    des adresses qu'il porte —, et les demandes simultanées se greffent sur
 *    celle en cours. Préchargement, lecture, relais vidéo, menu des qualités et
 *    téléchargements puisent au même endroit ;
 *  - **le travail de fond espacé.** Ce que personne n'attend — le préchargement
 *    des pistes à venir — passe une extraction à la fois, dix à vingt secondes
 *    après la précédente : ce sont les valeurs du mode prudent de yt-dlp
 *    (`-t sleep`). Ce qu'on vient de demander reste immédiat ;
 *  - **le recul après un refus.** Si YouTube refuse par les deux adresses,
 *    insister ne ferait qu'aggraver le signalement : le travail de fond
 *    s'arrête une demi-heure. Chaque geste de l'utilisateur tente encore sa
 *    chance, une fois.
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

/** Durée de vie d'une extraction gardée, au plus. */
const DUMP_TTL_MS = 60 * 60 * 1000;

/** Marge avant l'expiration des adresses : une extraction gardée doit rester utilisable. */
const EXPIRY_MARGIN_MS = 15 * 60 * 1000;

/** Extractions gardées, au plus : une file ordinaire n'en demande pas tant. */
const DUMP_CACHE_SIZE = 100;

/** Écart entre deux extractions de fond, en millisecondes — le `-t sleep` de yt-dlp. */
const BACKGROUND_GAP_MS = { min: 10 * 1000, max: 20 * 1000 };

/** Durée de la pause du travail de fond après un refus par les deux adresses. */
const BACKGROUND_PAUSE_MS = 30 * 60 * 1000;

let now = () => Date.now();
let sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let random = () => Math.random();

/** Extractions gardées : clé → { until, value }. */
const dumps = new Map();

/** Extractions en cours : clé → promesse. */
const running = new Map();

/** Début de la dernière extraction réellement envoyée à YouTube. */
let lastExtractionAt = 0;

/** La file du travail de fond : chaque extraction attend la précédente. */
let backgroundChain = Promise.resolve();

/** Le travail de fond reprend à cette heure-là — 0 : il n'est pas en pause. */
let pausedUntil = 0;

/** La voie en cours : 0 l'IPv6 — celle que choisit le système —, 1 l'IPv4. */
const ROUTE = Object.freeze({ DEFAULT: 0, IPV4: 1 });

let level = ROUTE.DEFAULT;
let levelSince = 0;

/** Toutes les voies ont été refusées pendant ce repli — pour ne le dire qu'une fois. */
let exhausted = false;

let ipv4Dispatcher = null;

/** La voie en cours, après avoir levé un repli dont l'heure est passée. */
function currentLevel() {
    if (level === ROUTE.DEFAULT) return level;
    if (now() - levelSince >= IPV4_WINDOW_MS) {
        level = ROUTE.DEFAULT;
        exhausted = false;
        log.info('[YouTube] One hour has passed: back to IPv6, anonymously.');
        return level;
    }
    return level;
}

/** L'IPv4 est-elle la route ? */
function onIpv4() {
    return currentLevel() >= ROUTE.IPV4;
}

/** Passe à l'IPv4, pour une heure. */
function escalate(to, source) {
    if (currentLevel() >= to) return;
    level = to;
    levelSince = now();
    log.warn(`[YouTube] Refused as a bot over IPv6 (${source}): falling back to IPv4 for one hour.`);
}

/** Refusé par la dernière voie : on arrête d'insister. */
function refusedEverywhere(source) {
    // Le travail de fond s'arrête à chaque refus, même déjà signalé : c'est
    // la preuve que le signalement tient toujours.
    pausedUntil = now() + BACKGROUND_PAUSE_MS;
    if (exhausted) return;
    exhausted = true;
    log.error(`[YouTube] Refused as a bot over IPv4 as well (${source}): nothing will load until `
        + 'YouTube lifts the flag. Background extractions paused for 30 minutes.');
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

/** L'adresse mène-t-elle à YouTube ? */
function isYoutubeUrl(url) {
    try {
        return YOUTUBE_HOST.test(new URL(url).hostname);
    } catch (e) {
        return false;
    }
}

/**
 * Ce qui désigne la vidéo dans une adresse YouTube, quelle qu'en soit la forme ;
 * l'adresse elle-même pour tout le reste.
 *
 * `youtube.com/watch?v=…` que rend l'extracteur et `www.youtube.com/watch?v=…`
 * qu'on a collé sont la même vidéo, et ne doivent coûter qu'une extraction.
 */
function videoKey(url) {
    try {
        const u = new URL(url);
        const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
        if (host === 'youtu.be') return `youtube:${u.pathname.slice(1)}`;
        if (host === 'youtube.com') {
            const id = u.searchParams.get('v')
                || (u.pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)/) || [])[1];
            // Une liste de lecture n'est pas une vidéo : elle garde son adresse.
            if (id && !u.pathname.startsWith('/playlist')) return `youtube:${id}`;
        }
    } catch (e) {
        // Une recherche (`ytsearch1:…`) n'est pas une adresse : elle se garde telle quelle.
    }
    return url;
}

/**
 * La clé d'une extraction à garder, ou null si elle ne se garde pas.
 *
 * Seules les descriptions complètes (`dumpSingleJson`) se gardent : c'est ce
 * que tout le monde demande, et le reste n'a rien à resservir. Les options de
 * route — famille d'adresses — n'y entrent pas : la vidéo est la même.
 */
function dumpKey(url, flags) {
    if (!flags || !flags.dumpSingleJson) return null;
    const { forceIpv4, ...rest } = flags;
    const stable = Object.keys(rest).sort().map((name) => `${name}=${JSON.stringify(rest[name])}`);
    return `${videoKey(url)}|${stable.join('&')}`;
}

/**
 * Jusqu'à quand une extraction reste bonne à resservir.
 *
 * Les adresses qu'elle porte expirent — quelques heures chez googlevideo,
 * `expire=` en secondes. La plus proche décide, moins une marge.
 */
function keepUntil(value) {
    let until = now() + DUMP_TTL_MS;
    const formats = (value && Array.isArray(value.formats)) ? value.formats : [];
    for (const format of formats) {
        const match = /[?&/]expire[=/](\d+)/.exec((format && format.url) || '');
        if (match) until = Math.min(until, Number(match[1]) * 1000 - EXPIRY_MARGIN_MS);
    }
    return until;
}

function keep(key, value) {
    const until = keepUntil(value);
    if (until <= now()) return;
    dumps.delete(key);
    dumps.set(key, { until, value });
    // La plus ancienne s'en va : l'ordre d'insertion d'une Map est celui-là.
    while (dumps.size > DUMP_CACHE_SIZE) dumps.delete(dumps.keys().next().value);
}

function kept(key) {
    const entry = key && dumps.get(key);
    if (!entry) return null;
    if (entry.until > now()) return entry.value;
    dumps.delete(key);
    return null;
}

/**
 * Une copie : plusieurs appelants reçoivent la même extraction, et aucun ne
 * doit pouvoir modifier celle des autres en triant ses formats.
 */
function copy(value) {
    return value && typeof value === 'object' ? structuredClone(value) : value;
}

/**
 * L'extraction elle-même : de la voie en cours jusqu'à l'IPv4.
 *
 * `youtube-dl-exec` est requis à chaque appel et non une fois pour toutes :
 * les tests le remplacent dans le cache de `require`, et c'est ainsi qu'ils
 * continuent de le trouver.
 */
async function extract(url, flags, options) {
    const youtubedl = require('youtube-dl-exec');

    const routes = [ROUTE.DEFAULT, ROUTE.IPV4].filter((r) => r >= currentLevel());

    let refusal = null;
    for (let i = 0; i < routes.length; i++) {
        const routeFlags = routes[i] === ROUTE.DEFAULT ? flags : { ...flags, forceIpv4: true };
        try {
            lastExtractionAt = now();
            return await youtubedl(url, routeFlags, options);
        } catch (err) {
            if (!isBotCheck(err && err.message)) throw err;
            refusal = err;
            if (i < routes.length - 1) escalate(routes[i + 1], 'yt-dlp');
        }
    }

    refusedEverywhere('yt-dlp');
    throw refusal;
}

/**
 * Une extraction gardée, en cours, ou lancée — dans cet ordre.
 */
function fetchDump(key, url, flags, options) {
    const hit = kept(key);
    if (hit) return Promise.resolve(hit);
    if (key && running.has(key)) return running.get(key);

    const pending = extract(url, flags, options)
        .then((value) => {
            if (key) keep(key, value);
            return value;
        })
        .finally(() => {
            if (key) running.delete(key);
        });
    if (key) running.set(key, pending);
    return pending;
}

/**
 * Attend son tour dans la file du travail de fond.
 *
 * Refuse d'emblée pendant une pause, plutôt que d'attendre qu'elle finisse :
 * le préchargement tient une place pour chaque piste qu'il prépare, et la
 * garder une demi-heure bloquerait tout le reste.
 */
function paced(task) {
    const turn = backgroundChain.then(async () => {
        const refuse = () => {
            if (now() < pausedUntil) {
                const err = new Error('YouTube refused recently: background extractions are paused.');
                // Reconnu par le préchargement, qui ne doit ni se rabattre sur
                // une autre demande à YouTube, ni soupçonner yt-dlp.
                err.code = 'YOUTUBE_PAUSED';
                throw err;
            }
        };
        refuse();
        const gap = BACKGROUND_GAP_MS.min + random() * (BACKGROUND_GAP_MS.max - BACKGROUND_GAP_MS.min);
        const wait = lastExtractionAt + gap - now();
        if (wait > 0) await sleep(wait);
        refuse();
        return task();
    });
    // La file continue même si une extraction échoue : la suivante n'y est pour rien.
    backgroundChain = turn.catch(() => {});
    return turn;
}

/**
 * Appelle yt-dlp : une extraction par vidéo, le fond espacé, l'IPv4 en repli.
 *
 * Même signature que `youtube-dl-exec`, plus une quatrième.
 *
 * @param {string} url
 * @param {object} flags
 * @param {object} [options]
 * @param {{ background?: boolean }} [how] - `background` : personne n'attend
 *   le résultat — préchargement des pistes à venir. L'extraction prend alors
 *   son tour dans la file espacée, et se refuse pendant une pause.
 */
async function ytdlp(url, flags, options, { background = false } = {}) {
    const key = dumpKey(url, flags);

    // Déjà là : ni file, ni attente — ce qu'on sert sans rien demander à
    // YouTube n'a rien à espacer.
    const hit = kept(key);
    if (hit) return copy(hit);
    if (key && running.has(key)) return copy(await running.get(key));

    const value = background
        ? await paced(() => fetchDump(key, url, flags, options))
        : await fetchDump(key, url, flags, options);
    return key ? copy(value) : value;
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

        const player = isPlayerCall(input);
        let route = currentLevel();

        if (route === ROUTE.DEFAULT) {
            const response = await original(input, init);
            if (!player || !(await refusedAsBot(response))) return response;
            escalate(ROUTE.IPV4, 'youtubei');
            route = ROUTE.IPV4;
        }

        // Rejouable : youtubei passe le corps dans `init`, sous forme de texte,
        // et non dans la requête — il n'a pas été consommé.
        const ipv4 = { ...init, dispatcher: await agentFor4() };

        const response = await original(input, ipv4);
        if (player && await refusedAsBot(response)) refusedEverywhere('youtubei');
        return response;
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
    isYoutubeUrl,
    installYoutubeiFallback,
    wrapFetch,
    isBotCheck,
    /** Pour les tests : horloge, attente et hasard factices, et retour à l'état de départ. */
    _setClock(fn) { now = fn; },
    _setTiming({ sleep: s, random: r } = {}) {
        if (s) sleep = s;
        if (r) random = r;
    },
    _reset() {
        level = ROUTE.DEFAULT;
        levelSince = 0;
        exhausted = false;
        dumps.clear();
        running.clear();
        lastExtractionAt = 0;
        backgroundChain = Promise.resolve();
        pausedUntil = 0;
    },
};
