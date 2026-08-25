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
const log = require('../../utils/logger');

/** Page d'erreur du trajet, dans le style de celle de web/auth.js. */
function errorPage(titre, message, detail) {
    const bloc = detail ? `<p class="detail"><code>${String(detail).slice(0, 300)}</code></p>` : '';
    return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>${titre}</title>
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
  <h1>${titre}</h1>
  <p>${message}</p>
  ${bloc}
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
async function estMembreConnu(client, userId) {
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

    router.get('/discord', (req, res) => {
        if (!oauth.isConfigured()) {
            return res.status(503).type('html').send(errorPage(
                'Partage indisponible',
                'L\'authentification Discord n\'est pas configurée sur ce bot.',
                'DISCORD_CLIENT_ID et DISCORD_CLIENT_SECRET doivent figurer dans .env'
            ));
        }

        const returnTo = typeof req.query.returnTo === 'string' ? req.query.returnTo : '/';
        // Une destination ne peut être qu'un chemin de ce serveur : une URL
        // absolue ferait de cette adresse un tremplin vers n'importe quel site.
        const sur = returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/';

        res.redirect(302, oauth.buildAuthorizeUrl(sur));
    });

    router.get('/discord/callback', async (req, res) => {
        const { code, state, error } = req.query;

        if (error) {
            return res.status(400).type('html').send(errorPage(
                'Autorisation refusée',
                'Vous avez refusé l\'accès, ou Discord l\'a interrompu.',
                error
            ));
        }

        const trajet = oauth.consumeState(typeof state === 'string' ? state : '');
        if (!trajet) {
            // Rappel sans `state` valable : lien périmé, rejoué, ou forgé.
            return res.status(400).type('html').send(errorPage(
                'Lien expiré',
                'Ce lien d\'authentification n\'est plus valable. Relancez la connexion.'
            ));
        }

        if (typeof code !== 'string' || !code) {
            return res.status(400).type('html').send(errorPage(
                'Réponse incomplète',
                'Discord n\'a pas renvoyé de code d\'autorisation.'
            ));
        }

        let user;
        try {
            user = await oauth.identifyFromCode(code);
        } catch (err) {
            log.error(`[OAuth] Authentification échouée : ${err.message}`);
            return res.status(502).type('html').send(errorPage(
                'Authentification impossible',
                'Discord a refusé la demande. L\'URL de rappel déclarée dans le portail '
                + 'développeur doit correspondre exactement à celle-ci :',
                oauth.redirectUri()
            ));
        }

        if (!(await estMembreConnu(webServer?.client, user.id))) {
            log.warn(`[OAuth] Accès refusé à ${user.username} (${user.id}) : membre d'aucun serveur du bot.`);
            return res.status(403).type('html').send(errorPage(
                'Accès refusé',
                'Votre compte Discord ne fait partie d\'aucun serveur où ce bot est présent.'
            ));
        }

        const { id } = sessions.create(user);
        res.cookie(sessions.COOKIE_NAME, id, {
            httpOnly: true,
            sameSite: 'lax',
            maxAge: sessions.MAX_AGE_MS,
        });

        res.redirect(302, trajet.returnTo);
    });

    return router;
}

module.exports = createAuthRouter;
