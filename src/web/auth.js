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
 * **On demande son nom au visiteur avant de lui fermer la porte.** Un invité
 * qui revient n'a ni jeton ni session : il n'est donc pas autorisé, et tombait
 * sur la page de refus — où il devait recliquer « Se connecter avec Discord » à
 * chaque venue, son cookie ne durant que trente jours. Le middleware tente
 * d'abord une reconnaissance muette (voir `shouldTrySilentLogin`), qui ne
 * dérange personne : Discord répond sans rien afficher, ou refuse, auquel cas
 * la page de refus est servie comme avant. Le trajet n'accorde aucun droit — il
 * répond à « qui êtes-vous », jamais à « pouvez-vous entrer ».
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
            // Les installations d'avant ce correctif ont un fichier ouvert :
            // le refermer ici les rattrape, une fois, au premier démarrage.
            hardenTokenFile();
            return token;
        }
    } catch (e) {
        // Premier démarrage : le fichier n'existe pas encore
    }

    token = crypto.randomBytes(32).toString('hex');
    try {
        fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
        fs.writeFileSync(TOKEN_FILE, token, { encoding: 'utf8', mode: 0o600 });
        // `mode` ne vaut que sur les systèmes POSIX ; Windows demande une ACL.
        hardenTokenFile();
        log.info(`[Auth] Dashboard token generated and saved in ${TOKEN_FILE}`);
    } catch (err) {
        log.error(`[Auth] Cannot save the token: ${err.message}`);
        log.error('[Auth] A new token will be generated on the next startup.');
    }
    return token;
}

/**
 * Referme les droits du fichier de jeton sur son seul propriétaire.
 *
 * `writeFileSync` reçoit bien `mode: 0o600`, et Windows n'en fait rien : les
 * bits POSIX n'y ont pas cours, le fichier hérite des droits de son dossier, et
 * `data/dashboard-token` se retrouvait lisible par tout compte que cette
 * héritage désigne. Le secret qui ouvre le tableau de bord traînait donc à la
 * portée de n'importe quelle session ouverte sur la machine.
 *
 * `icacls /inheritance:r` coupe l'héritage et `/grant:r` réattribue à zéro : ne
 * subsistent que le compte qui fait tourner le bot, les administrateurs et le
 * système — les deux derniers pouvant de toute façon reprendre le fichier.
 *
 * **Les groupes sont désignés par leur identifiant, pas par leur nom.** Ce
 * dernier est traduit : « Administrators » sur un Windows anglais est
 * « Administrateurs » sur un Windows français, et la commande échouait sur
 * « le mappage entre les noms de compte et les ID de sécurité n'a pas été
 * effectué ». Les SID bien connus, eux, sont les mêmes partout.
 *
 * L'échec n'interrompt rien. Sur un partage réseau, un système de fichiers sans
 * ACL ou un Windows bridé, la commande peut refuser ; le bot doit démarrer
 * quand même, en le disant.
 */
function hardenTokenFile() {
    if (process.platform !== 'win32') return;

    let user;
    try {
        user = require('os').userInfo().username;
    } catch (e) {
        return;
    }
    if (!user) return;

    try {
        require('child_process').execFileSync('icacls', [
            TOKEN_FILE,
            '/inheritance:r',
            '/grant:r', `${user}:(F)`,
            // S-1-5-32-544 : groupe Administrateurs. S-1-5-18 : compte Système.
            '/grant:r', '*S-1-5-32-544:(F)',
            '/grant:r', '*S-1-5-18:(F)',
        ], { stdio: 'ignore', timeout: 5000, windowsHide: true });
    } catch (err) {
        log.warn('[Auth] Could not restrict the permissions of '
            + `${TOKEN_FILE}: ${err.message}`);
        log.warn('[Auth] Any account on this machine may be able to read it.');
    }
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

/**
 * Faut-il tenter de reconnaître ce visiteur sans rien lui demander ?
 *
 * Quatre conditions, et chacune écarte un cas où le détour nuirait :
 *
 *  - **une navigation, pas une ressource.** Une balise `<audio src>` ou un appel
 *    de l'interface qui recevrait une redirection vers discord.com n'en ferait
 *    rien de bon ; seule une page que le navigateur affiche peut suivre le
 *    trajet. D'où la méthode `GET` et l'entête `Accept` porteur de `text/html`.
 *  - **l'application Discord configurée.** Sans elle, la redirection ne mènerait
 *    qu'à une page d'erreur, là où la page de refus explique au moins quoi faire.
 *  - **un seul essai.** `login=manual` est posé par le rappel après un échec :
 *    sans cette marque, un refus de Discord renverrait ici, qui redemanderait,
 *    et le navigateur tournerait en rond jusqu'à ce qu'il s'en plaigne.
 *
 * @param {import('http').IncomingMessage} req
 * @returns {boolean}
 */
function shouldTrySilentLogin(req) {
    if (req.method !== 'GET') return false;
    if (!(req.headers.accept || '').includes('text/html')) return false;
    if (!oauthConfigured()) return false;

    try {
        const url = new URL(req.originalUrl || req.url, 'http://localhost');
        if (url.searchParams.get('login') === 'manual') return false;
    } catch (e) {
        // URL illisible : mieux vaut la page de refus qu'une redirection bâtie
        // sur une adresse qu'on n'a pas su lire.
        return false;
    }

    return true;
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
        /*
         * La reconnaissance muette, avant la porte close.
         *
         * C'est ici que passe l'invité qui revient, et nulle part ailleurs : il
         * n'a ni jeton ni session, donc `pendingLogin` est faux et la fenêtre de
         * connexion du tableau de bord ne le verra jamais — il tombe sur cette
         * page-ci. Sans ce détour, quelqu'un d'accepté la semaine dernière
         * devait recliquer « Se connecter avec Discord » à chaque venue, son
         * cookie de session ne durant que trente jours et ne franchissant pas la
         * frontière entre deux navigateurs.
         *
         * On lui demande donc son nom sans le déranger : `silent=1` pose
         * `prompt=none` sur la demande, ce qui interdit à Discord d'afficher
         * quoi que ce soit. Ou bien il reconnaît le visiteur et le renvoie
         * identifié — la page s'ouvre, ses droits retrouvés —, ou bien il répond
         * « je ne peux pas sans lui parler », et le rappel revient ici avec
         * `login=manual`, qui fait servir la page ci-dessous comme avant.
         *
         * Rien n'est accordé au passage : l'essai répond à « qui êtes-vous »,
         * jamais à « pouvez-vous entrer ». Un compte membre d'aucun serveur du
         * bot est refusé au rappel, comme il l'a toujours été.
         */
        if (shouldTrySilentLogin(req)) {
            const returnTo = req.originalUrl || req.url || '/';
            return res.redirect(302,
                `/auth/discord?silent=1&returnTo=${encodeURIComponent(returnTo)}`);
        }

        res.status(401);
        if ((req.headers.accept || '').includes('text/html')) {
            return res.type('html').send(unauthorizedPage());
        }
        return res.json({ error: 'Jeton d\'accès manquant ou invalide' });
    }

    // Les routes lisent l'identité plutôt que de la redemander.
    req.identity = identity;

    if (identity.tokenSource === 'query') {
        res.cookie(COOKIE_NAME, extractToken(req).value,
            cookieOptions(1000 * 60 * 60 * 24 * 365));

        if (req.method === 'GET') {
            const url = new URL(req.originalUrl, 'http://localhost');
            url.searchParams.delete('token');
            return res.redirect(302, url.pathname + url.search);
        }
    }

    next();
}

/**
 * Faut-il poser `Secure` sur les cookies de cette installation ?
 *
 * L'attribut interdit au navigateur de renvoyer le cookie sur une connexion en
 * clair. C'est exactement ce qu'on veut derrière un tunnel — le tableau de bord
 * y est en HTTPS, et rien ne justifie que le jeton reparte autrement — et
 * exactement ce qu'il ne faut pas en local, où l'installation est servie en
 * `http://127.0.0.1` : le cookie y serait posé puis jamais renvoyé, et la
 * session ne tiendrait pas d'une requête à l'autre.
 *
 * La question se tranche donc sur l'adresse publique déclarée, qui est celle où
 * les cookies se posent réellement — le retour de Discord y revient, et c'est
 * la seule origine qui porte une session (voir WebServer.start).
 *
 * @returns {boolean}
 */
function useSecureCookies() {
    const declared = (process.env.PUBLIC_URL || '').trim();
    if (!declared) return false;
    try {
        return new URL(declared).protocol === 'https:';
    } catch (e) {
        return false;
    }
}

/**
 * Options communes aux deux cookies du tableau de bord.
 *
 * `httpOnly` les rend invisibles au script de la page : une injection ne peut
 * pas les lire, seulement agir dans la page. `sameSite: 'lax'` les retient sur
 * les requêtes inter-sites sans casser le retour de Discord, qui est une
 * navigation de premier niveau.
 *
 * @param {number} maxAge
 * @returns {object}
 */
function cookieOptions(maxAge) {
    return {
        httpOnly: true,
        sameSite: 'lax',
        secure: useSecureCookies(),
        maxAge,
    };
}

/**
 * Cette WebSocket vient-elle bien de ce tableau de bord ?
 *
 * ## Pourquoi la question se pose
 *
 * Les WebSockets échappent à la politique d'origine croisée : une page tierce
 * peut en ouvrir une vers n'importe quelle adresse, et le navigateur la laisse
 * faire. Ce qui protégeait ce serveur jusqu'ici n'était pas une décision de sa
 * part mais un effet de bord — les cookies `SameSite=Lax` ne partent pas sur
 * une requête inter-site — c'est-à-dire une garantie empruntée au navigateur,
 * qui tombe dès que le jeton circule autrement qu'en cookie.
 *
 * ## Pourquoi une origine absente est acceptée
 *
 * Seuls les navigateurs posent `Origin`. Le lanceur (`tools/start-bot.ps1`)
 * ouvre une WebSocket pour savoir si un tableau de bord est déjà là, et le test
 * de fumée en ouvre une pour s'assurer que l'état arrive : ni l'un ni l'autre
 * n'envoie cet en-tête. Les refuser reviendrait à casser le démarrage du bot
 * pour se prémunir d'une attaque qui, par définition, passe par un navigateur —
 * et un navigateur pose toujours `Origin`.
 *
 * L'absence d'origine n'ouvre donc rien de plus : la requête doit de toute
 * façon avoir franchi `identify()` juste avant, donc porter le jeton ou une
 * session valable.
 *
 * @param {import('http').IncomingMessage} req
 * @param {{ holdsToken?: boolean }} identity
 * @returns {boolean}
 */
function originAllowed(req, identity) {
    const origin = req.headers.origin;
    // Pas de navigateur derrière : voir plus haut.
    if (!origin) return true;

    let host;
    try {
        host = new URL(origin).host;
    } catch (e) {
        // Origine illisible : un navigateur n'en produit pas de telles.
        return false;
    }

    // L'hôte par lequel la requête est arrivée. C'est la comparaison qui tient
    // quelle que soit l'adresse d'entrée — 127.0.0.1, le nom de la machine sur
    // le réseau local, le tunnel — sans avoir à les énumérer.
    if (req.headers.host && host === req.headers.host) return true;

    // L'adresse publique déclarée, quand elle diffère de l'hôte d'arrivée :
    // c'est le cas derrière un tunnel, qui présente son propre `Host`.
    try {
        const declared = (process.env.PUBLIC_URL || '').trim();
        if (declared && new URL(declared).host === host) return true;
    } catch (e) {
        // PUBLIC_URL illisible : on s'en tient à l'hôte d'arrivée.
    }

    return false;
}

/** Adresses par lesquelles la machine se parle à elle-même. */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * La requête vient-elle de l'ordinateur du bot lui-même ?
 *
 * Une connexion locale qui ne porte pas `CF-Connecting-IP`. Le tunnel
 * Cloudflare se connecte lui aussi depuis la machine, mais Cloudflare pose
 * toujours cet en-tête, et un visiteur ne peut pas l'en retirer : ce qui
 * arrive par le tunnel n'est donc jamais pris pour local. Depuis le réseau
 * local (`HOST=0.0.0.0`), l'adresse d'origine n'est pas une boucle locale.
 *
 * Ne vaut que tant qu'aucun autre relais n'est posé devant le serveur sur la
 * machine même : un proxy local qui n'ajoute pas cet en-tête ferait passer ses
 * visiteurs pour locaux.
 *
 * @param {import('http').IncomingMessage} req
 * @returns {boolean}
 */
function fromThisMachine(req) {
    const address = req?.socket?.remoteAddress;
    if (!LOOPBACK.has(address)) return false;
    return !req.headers?.['cf-connecting-ip'];
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

    if (!originAllowed(info.req, identity)) {
        log.warn(`[Auth] WebSocket handshake refused: origin « ${info.req.headers.origin} » `
            + 'is not this dashboard.');
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
    originAllowed,
    useSecureCookies,
    cookieOptions,
    isAuthorized,
    identify,
    isPublicPath,
    middleware,
    verifyUpgrade,
    fromThisMachine,
    COOKIE_NAME,
    TOKEN_FILE,
};
