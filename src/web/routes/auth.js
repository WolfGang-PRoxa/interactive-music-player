/**
 * routes/auth — Le trajet d'authentification d'un invité.
 *
 * Deux adresses seulement, et toutes deux ouvertes sans jeton — voir
 * `PUBLIC_PATHS` dans web/auth.js : celui qui clique le lien posté dans le
 * tchat du salon vocal n'a encore rien pour s'authentifier, c'est précisément
 * ce qu'il vient chercher.
 *
 *   GET /auth/discord            → renvoie vers discord.com
 *   GET /auth/discord/callback   → reçoit le code, ouvre la session, revient au tableau de bord
 *
 * Une fois le compte reconnu, l'invité n'a encore aucun droit : il voit un
 * tableau de bord inerte jusqu'à ce que le maître lui en accorde. C'est
 * l'ordre voulu — le maître ne peut cocher des cases que pour des gens qui se
 * sont présentés.
 */

const express = require('express');
const oauth = require('../oauth');
const sessions = require('../sessions');
const guests = require('../guests');
const owner = require('../owner');
const auth = require('../auth');
const log = require('../../utils/logger');

/**
 * Échappe ce qui va être interpolé dans du HTML.
 *
 * Le `detail` de la page d'erreur porte la cause du refus, et cette cause vient
 * parfois de la requête elle-même : Discord renvoie `?error=…` au rappel, dont
 * la valeur atterrissait telle quelle dans le document. Le chemin étant public
 * — il faut bien recevoir le retour de Discord avant de savoir qui revient — et
 * aucune CSP ne couvrant encore ces pages, il suffisait d'un lien à faire
 * cliquer pour exécuter du script sur l'origine du tableau de bord.
 *
 * Les trois arguments y passent, pas seulement celui-là. Les titres et messages
 * sont aujourd'hui des littéraux de ce fichier, mais rien ne le garantit
 * demain, et échapper une phrase écrite à la main ne change rien à son rendu.
 */
function echapperHtml(valeur) {
    return String(valeur).replace(/[&<>"']/g, (caractere) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    })[caractere]);
}

/**
 * Ramène une destination de retour à un chemin de ce serveur.
 *
 * Une destination ne peut être qu'un chemin d'ici : une URL absolue ferait de
 * cette adresse un tremplin vers n'importe quel site, et le trajet est d'autant
 * plus convaincant que la victime vient de traverser une authentification
 * Discord authentique avant d'atterrir ailleurs.
 *
 * Le filtre écartait `//evil.com` et laissait passer `/\evil.com`. La norme
 * WHATWG assimile la barre inverse à une barre oblique dans les schémas
 * spéciaux : le navigateur résolvait donc l'en-tête `Location` vers un autre
 * domaine. Compléter la liste des caractères refusés n'aurait fait que déplacer
 * la question — c'est l'analyseur d'URL qui connaît ces équivalences, pas nous.
 *
 * On lui donne donc la valeur avec une base quelconque, et on ne garde que ce
 * qui ne peut pas désigner un autre hôte : le chemin et sa requête. `//evil`,
 * `/\evil`, `https://evil` et `javascript:` retombent tous sur un chemin d'ici.
 *
 * @param {unknown} valeur
 * @returns {string} Un chemin absolu de ce serveur, `/` à défaut.
 */
function cheminInterne(valeur) {
    try {
        const url = new URL(String(valeur ?? '/'), 'http://localhost');
        const chemin = (url.pathname || '/') + url.search;
        // Un schéma que l'analyseur ne tient pas pour « spécial » — `javascript:`
        // en tête — rend un chemin sans barre oblique de tête, donc relatif à la
        // page courante. Inoffensif, mais ce n'est pas ce que cette fonction
        // promet : elle rend un chemin absolu de ce serveur, toujours.
        return chemin.startsWith('/') ? chemin : `/${chemin}`;
    } catch (e) {
        return '/';
    }
}

/** Page d'erreur du trajet, dans le style de celle de web/auth.js. */
function errorPage(rawTitle, rawMessage, rawDetail) {
    const title = echapperHtml(rawTitle);
    const message = echapperHtml(rawMessage);
    // Tronqué avant l'échappement, dans cet ordre : couper après trancherait
    // une entité en deux et laisserait un `&quo` orphelin dans la page. La
    // borne porte donc sur le texte reçu, comme avant ce correctif ;
    // l'échappement vient en dernier, ce qui est tout ce que la sûreté exige.
    const detail = rawDetail ? echapperHtml(String(rawDetail).slice(0, 300)) : '';
    const block = detail ? `<p class="detail"><code>${detail}</code></p>` : '';
    return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>${title}</title>
<style>
  body { font-family: system-ui, sans-serif; background: #16161d; color: #e6e6ec;
         display: grid; place-items: center; height: 100vh; margin: 0; }
  main { max-width: 34rem; padding: 2rem; line-height: 1.6; }
  h1 { font-size: 1.4rem; margin-bottom: 0.5rem; }
  code { background: #26262f; padding: 0.15em 0.4em; border-radius: 4px;
         word-break: break-all; }
  .detail { opacity: 0.7; font-size: 0.85em; }
  a { color: #8ea1ff; }
</style></head>
<body><main>
  <h1>${title}</h1>
  <p>${message}</p>
  ${block}
  <p><a href="/auth/discord">Réessayer</a></p>
</main></body></html>`;
}

/**
 * Cet utilisateur est-il membre d'un serveur que le bot dessert ?
 *
 * Sans cette vérification, n'importe quel compte Discord atteignant l'adresse
 * obtiendrait une session. Le lien ne circule que dans le salon vocal, mais une
 * URL se recopie : le vrai garde-fou est l'appartenance au serveur.
 *
 * Le cache d'abord, car il répond sans rien demander à Discord. Mais il ne
 * suffit pas : l'intent `GuildMembers` n'étant pas activé — le bot n'en a pas
 * l'usage ailleurs, et c'est une intention privilégiée qu'il vaut mieux ne pas
 * réclamer — ce cache ne retient que les membres croisés en route, ceux qu'un
 * état vocal ou un message a fait passer. Un membre parfaitement légitime mais
 * silencieux et hors du vocal en est absent, et se voyait refuser l'entrée.
 * Pire, la liste repart vide à chaque redémarrage : le même compte était admis
 * la veille et éconduit le lendemain, sans que rien ait changé de son côté.
 *
 * On demande donc à Discord quand le cache se tait. `members.fetch(id)` passe
 * par l'API REST, qui ne réclame aucune intention privilégiée pour un membre
 * nommément désigné — l'intent ne conditionne que la réception des événements
 * et le listage en masse. Un membre inconnu s'y solde par une erreur, qui est
 * ici une réponse comme une autre : ce serveur-là ne le connaît pas.
 *
 * @param {object} client Client discord.js.
 * @param {string} userId
 * @returns {Promise<boolean>}
 */
async function isKnownMember(client, userId) {
    if (!client || !client.guilds) return false;

    for (const guild of client.guilds.cache.values()) {
        if (guild.members?.cache?.has(userId)) return true;
    }

    for (const guild of client.guilds.cache.values()) {
        try {
            if (await guild.members.fetch(userId)) return true;
        } catch (e) {
            // Membre inconnu de ce serveur : on poursuit avec le suivant.
        }
    }

    return false;
}

/**
 * @param {object} webServer Instance de WebServer, pour joindre le client Discord.
 * @returns {import('express').Router}
 */
function createAuthRouter(webServer) {
    const router = express.Router();

    /**
     * Ce que le tableau de bord a besoin de savoir avant de s'afficher.
     *
     * Il ne peut pas le déduire seul : le cookie de session est `httpOnly` —
     * donc invisible au script — et l'état de l'application Discord n'est connu
     * que du serveur. Cette adresse n'est pas publique, contrairement aux deux
     * suivantes : elle décrit l'installation, et ne se répond qu'à qui a déjà
     * passé la porte.
     */
    router.get('/state', (req, res) => {
        const identity = req.identity || auth.identify(req);
        const session = identity.session;

        res.json({
            loggedIn: Boolean(session),
            master: Boolean(identity.master),
            // Vrai quand il ne manque plus que la connexion : c'est ce seul
            // champ qui décide de l'affichage de la fenêtre bloquante.
            pendingLogin: Boolean(identity.pendingLogin),
            holdsToken: Boolean(identity.holdsToken),
            oauthReady: oauth.isConfigured(),
            claimed: owner.isClaimed(),
            // Le nom du propriétaire n'est rendu qu'à lui-même : un invité n'a
            // pas à savoir de quel compte dépend l'installation.
            owner: identity.master ? owner.get() : null,
            user: session ? {
                id: session.userId,
                displayName: session.displayName || '',
                avatar: session.avatar || null,
            } : null,
            callbackUrl: oauth.redirectUri(),
        });
    });

    router.get('/discord', (req, res) => {
        if (!oauth.isConfigured()) {
            return res.status(503).type('html').send(errorPage(
                'Partage indisponible',
                'L\'authentification Discord n\'est pas configurée sur ce bot.',
                'DISCORD_CLIENT_ID et DISCORD_CLIENT_SECRET doivent figurer dans .env'
            ));
        }

        const safeReturnTo = cheminInterne(req.query.returnTo);

        /*
         * Le jeton est constaté ici, et non au rappel.
         *
         * Cette adresse-ci est ouverte depuis le tableau de bord, sur l'origine
         * où son cookie existe. Le rappel, lui, arrive sur `PUBLIC_URL` — un
         * autre hôte dès que le tableau de bord est ouvert sur `127.0.0.1`, ce
         * qui est le cas ordinaire — et n'y verrait aucun cookie. La réponse
         * voyage donc dans le `state`, que ce serveur a lui-même émis.
         *
         * `req.identity` est absent : ce chemin est public, le middleware n'y
         * pose rien.
         */
        /*
         * Changer de compte, plutôt que rouvrir le même.
         *
         * Demandé par le tableau de bord, et constaté ici avec le jeton : les
         * deux voyagent ensemble dans le `state`, car le rappel arrive sur une
         * origine où aucun de ces cookies n'existe. Le drapeau fait deux choses
         * — il demande à Discord de proposer ses comptes, et il autorisera la
         * propriété à suivre.
         */
        const switching = req.query.switch === '1';

        /*
         * L'essai muet, celui que la porte tente d'elle-même.
         *
         * Un invité déjà admis ne devrait pas avoir à cliquer « Se connecter »
         * chaque fois qu'il revient : son cookie de session ne dure que trente
         * jours, et se perd d'un navigateur à l'autre. La porte demande donc
         * d'abord à Discord, en silence, s'il reconnaît le visiteur — voir
         * `js/loginGate.js`. Le drapeau dit au rappel de rendre la main sans
         * page d'erreur si la réponse est non.
         */
        const silent = req.query.silent === '1';

        res.redirect(302, oauth.buildAuthorizeUrl(safeReturnTo, {
            holdsToken: auth.identify(req).holdsToken,
            claim: switching,
            silent,
        }));
    });

    /**
     * Rend la main à la porte du tableau de bord après un essai muet manqué.
     *
     * Le visiteur n'a rien demandé et ne doit rien voir : ni page d'erreur, ni
     * explication. Le paramètre dit seulement à `loginGate.js` de ne pas
     * retenter — sans quoi la porte relancerait l'essai, qui échouerait de
     * nouveau, indéfiniment.
     */
    function giveUpSilently(res, returnTo) {
        const url = new URL(returnTo || '/', 'http://localhost');
        url.searchParams.set('login', 'manual');
        return res.redirect(302, url.pathname + url.search);
    }

    router.get('/discord/callback', async (req, res) => {
        const { code, state, error } = req.query;

        /*
         * Le `state` est consommé avant toute chose, y compris avant l'examen
         * d'une erreur.
         *
         * Discord renvoie `error` et `state` ensemble quand il refuse, et c'est
         * le `state` qui dit si quelqu'un a cliqué ou si la porte tentait sa
         * chance. Dans l'ordre inverse — l'erreur d'abord — un essai muet
         * s'achevait sur « Autorisation refusée » en pleine page, alors que
         * personne n'avait rien demandé.
         */
        const route = oauth.consumeState(typeof state === 'string' ? state : '');

        if (error) {
            /*
             * `login_required`, `consent_required`, `interaction_required` : la
             * réponse normale de Discord à une demande muette quand le visiteur
             * n'a pas de session chez lui, ou n'a jamais autorisé cette
             * application. Ce n'est pas un incident, c'est un « non ».
             */
            if (route && route.silent) {
                log.info(`[OAuth] Silent reconnection declined by Discord (${error}).`);
                return giveUpSilently(res, route.returnTo);
            }
            return res.status(400).type('html').send(errorPage(
                'Autorisation refusée',
                'Vous avez refusé l\'accès, ou Discord l\'a interrompu.',
                error
            ));
        }

        if (!route) {
            // Rappel sans `state` valable : lien périmé, rejoué, ou forgé.
            return res.status(400).type('html').send(errorPage(
                'Lien expiré',
                'Ce lien d\'authentification n\'est plus valable. Relancez la connexion.'
            ));
        }

        if (typeof code !== 'string' || !code) {
            if (route.silent) return giveUpSilently(res, route.returnTo);
            return res.status(400).type('html').send(errorPage(
                'Réponse incomplète',
                'Discord n\'a pas renvoyé de code d\'autorisation.'
            ));
        }

        let user;
        try {
            user = await oauth.identifyFromCode(code);
        } catch (err) {
            log.error(`[OAuth] Authentication failed: ${err.message}`);
            if (route.silent) return giveUpSilently(res, route.returnTo);
            return res.status(502).type('html').send(errorPage(
                'Authentification impossible',
                'Discord a refusé la demande. L\'URL de rappel déclarée dans le portail '
                + 'développeur doit correspondre exactement à celle-ci :',
                oauth.redirectUri()
            ));
        }

        if (!(await isKnownMember(webServer?.client, user.id))) {
            log.warn(`[OAuth] Access denied to ${user.username} (${user.id}): member of no guild the bot is in.`);
            // Le refus se dit, même au terme d'un essai muet : celui-ci portait
            // sur « qui êtes-vous », pas sur « avez-vous le droit d'entrer ». Le
            // taire laisserait le visiteur devant une porte qui se rouvre sans
            // jamais dire pourquoi elle ne cède pas.
            return res.status(403).type('html').send(errorPage(
                'Accès refusé',
                'Votre compte Discord ne fait partie d\'aucun serveur où ce bot est présent.'
            ));
        }

        /*
         * La revendication de l'installation, s'il y a lieu.
         *
         * Le premier compte à revenir de Discord **en présentant le jeton** en
         * devient le propriétaire. Le jeton est écrit dans la console de celui
         * qui a lancé le bot, et le lien d'invitation posté aux auditeurs ne le
         * porte pas : le tenir, c'est être devant la machine.
         *
         * Le fait est lu dans le `state`, constaté à l'aller sur l'origine du
         * tableau de bord : ici, sur `PUBLIC_URL`, le cookie du jeton n'existe
         * pas. La requête est tout de même interrogée en second recours, pour
         * le cas où les deux adresses n'en font qu'une.
         */
        const holdsToken = route.holdsToken || auth.identify(req).holdsToken;

        if (!owner.isClaimed() && holdsToken) {
            owner.claim(user);
        } else if (route.claim && holdsToken && !owner.isOwner({ userId: user.id })) {
            /*
             * La propriété suit le compte, parce que la personne est devant la
             * machine — c'est ce que tenir le jeton veut dire, ici comme dans
             * `owner.js`. Aucun pouvoir n'est accordé au passage : qui tient le
             * jeton pouvait déjà supprimer `data/owner.json` et relancer. Le
             * geste devient seulement visible, et réversible sans toucher au
             * disque.
             */
            owner.transfer(user);
        }

        /*
         * Le carnet, avant la session.
         *
         * La session dit « cet onglet est à Paul » et s'éteint au bout de trente
         * jours ; le carnet dit « Paul est déjà venu » et ne s'éteint pas. Sans
         * lui, un invité pourvu de droits mais dont le cookie a expiré
         * disparaissait de la fenêtre de partage, nom et avatar compris, alors
         * que ses droits étaient toujours inscrits dans les réglages.
         */
        guests.remember(user);

        const { id } = sessions.create(user);
        res.cookie(sessions.COOKIE_NAME, id, {
            httpOnly: true,
            sameSite: 'lax',
            maxAge: sessions.MAX_AGE_MS,
        });

        // Repassé au filtre, et non repris tel quel : le `state` a été émis par
        // ce serveur, mais rien n'oblige à ce que la version qui l'a écrit ait
        // filtré comme celle qui le lit — une release installée peut être plus
        // ancienne que le correctif.
        res.redirect(302, cheminInterne(route.returnTo));
    });

    /**
     * Ferme la session de ce navigateur.
     *
     * Ni le jeton ni le propriétaire ne sont touchés : on ne quitte que son
     * identité Discord, et la page qui suit rouvre donc sur la porte d'entrée.
     * Les autres onglets du même compte gardent la leur — un téléphone posé
     * ailleurs n'a pas à tomber parce qu'on change de compte sur le PC.
     *
     * En POST, et non par un lien : une adresse qui déconnecte au simple
     * chargement se déclenche depuis n'importe quelle image d'une autre page.
     */
    router.post('/logout', (req, res) => {
        const cookies = auth.parseCookies(req.headers.cookie || '');
        const closed = sessions.destroy(cookies[sessions.COOKIE_NAME]);

        res.clearCookie(sessions.COOKIE_NAME, { httpOnly: true, sameSite: 'lax' });
        res.json({ ok: true, closed });
    });

    return router;
}

module.exports = createAuthRouter;
