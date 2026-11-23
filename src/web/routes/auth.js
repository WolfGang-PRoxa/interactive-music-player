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
const ownerTransfer = require('../ownerTransfer');
const auth = require('../auth');
const log = require('../../utils/logger');
const crypto = require('crypto');

/**
 * Cookie qui lie un trajet d'authentification au navigateur qui l'a ouvert.
 *
 * Éphémère : il ne vit que le temps d'aller chez Discord et d'en revenir, et
 * le rappel l'efface. Voir le `nonce` dans oauth.js pour ce qu'il ferme.
 */
const OAUTH_COOKIE = 'dashboard_oauth';

/** Comparaison à temps constant, comme celle du jeton dans web/auth.js. */
function safeEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

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
  return String(valeur).replace(
    /[&<>"']/g,
    (caractere) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[caractere],
  );
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
 * Page de saisie du code de reprise, dans le style des autres pages du trajet.
 *
 * Le nom du demandeur y figure pour qu'on sache de quel compte il s'agit avant
 * de recopier quoi que ce soit : c'est aussi ce qui permet de s'apercevoir
 * qu'une demande n'est pas la sienne.
 */
function confirmPage(id, username, erreur) {
  const bloc = erreur ? `<p class="erreur">${echapperHtml(erreur)}</p>` : '';
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Reprendre l'installation</title>
<style>
  body { font-family: system-ui, sans-serif; background: #16161d; color: #e6e6ec;
         display: grid; place-items: center; height: 100vh; margin: 0; }
  main { max-width: 34rem; padding: 2rem; line-height: 1.6; }
  h1 { font-size: 1.4rem; margin-bottom: 0.5rem; }
  code { background: #26262f; padding: 0.15em 0.4em; border-radius: 4px; }
  .erreur { color: #ff6b70; }
  input { font-family: ui-monospace, monospace; font-size: 1.2rem; letter-spacing: .12em;
          padding: .6em .8em; border-radius: 8px; border: 1px solid #2e2e38;
          background: #26262f; color: #e6e6ec; width: 11ch; text-transform: uppercase; }
  button { background: #5865F2; color: #fff; padding: .7em 1.2em; border: 0;
           border-radius: 8px; font-weight: 600; font-size: 1rem; cursor: pointer; }
  form { display: flex; gap: .6rem; align-items: center; margin-top: 1.2rem; }
  .note { opacity: .7; font-size: .9em; }
</style></head>
<body><main>
  <h1>Reprendre l'installation</h1>
  <p>Le bot vient d'écrire un code dans sa console, sur la machine où il tourne.
     Recopiez-le pour que <strong>${echapperHtml(username)}</strong> en devienne
     le propriétaire.</p>
  ${bloc}
  <form method="post" action="/auth/owner/confirm">
    <input type="hidden" name="id" value="${echapperHtml(id)}">
    <input name="code" placeholder="XXXX-XX" autocomplete="off" autofocus
           maxlength="10" aria-label="Code de reprise">
    <button type="submit">Confirmer</button>
  </form>
  <p class="note">Le code est valable deux minutes. Si vous n'êtes pas à l'origine
     de cette demande, fermez cette page : rien ne change tant qu'aucun code
     n'est saisi.</p>
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

  /*
   * Un plafond sur les deux chemins ouverts sans authentification.
   *
   * Ils ne donnent accès à rien, mais ils font travailler le bot :
   * `/discord` fait grossir la table des trajets en attente, et le rappel
   * déclenche un échange chez Discord puis un `members.fetch` par serveur —
   * des appels dont le quota est celui du bot, pas celui du visiteur.
   *
   * Trente tentatives par minute et par adresse : se connecter en coûte deux,
   * et une rafale s'arrête avant d'épuiser quoi que ce soit. Voir
   * web/rateLimit.js pour ce que « par adresse » veut dire derrière un tunnel.
   */
  const porte = require('../rateLimit').createLimiter({
    name: 'oauth',
    limit: 30,
    windowMs: 60 * 1000,
  });

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
      user: session
        ? {
            id: session.userId,
            displayName: session.displayName || '',
            avatar: session.avatar || null,
          }
        : null,
      callbackUrl: oauth.redirectUri(),
    });
  });

  router.get('/discord', porte, (req, res) => {
    if (!oauth.isConfigured()) {
      return res
        .status(503)
        .type('html')
        .send(
          errorPage(
            'Partage indisponible',
            "L'authentification Discord n'est pas configurée sur ce bot.",
            'DISCORD_CLIENT_ID et DISCORD_CLIENT_SECRET doivent figurer dans .env',
          ),
        );
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

    /*
     * Le trajet est marqué du navigateur qui l'ouvre.
     *
     * Sans cela, un `state` valable obtenu par n'importe qui valait pour
     * n'importe qui : il suffisait d'en demander un, puis de faire charger
     * le rappel à sa victime avec son propre `code` pour la connecter sous
     * un compte qui n'est pas le sien.
     *
     * Le cookie ne franchit pas la frontière d'origine, et il n'a pas à le
     * faire : le tableau de bord ne s'ouvre que sur `PUBLIC_URL`, qui est
     * aussi l'adresse où Discord renvoie — c'est la raison pour laquelle la
     * fenêtre de démarrage s'y ouvre et nulle part ailleurs (voir
     * WebServer.start). L'aller et le retour partagent donc le même bocal.
     */
    /*
     * Derrière le relais, le retour revient là où la connexion est partie.
     *
     * C'est ce qui garde l'aller et le retour dans le même bocal à cookies
     * quand aucune adresse n'est déclarée : ouvert sur `localhost`, le
     * tableau de bord y retrouve sa session ; ouvert par le lien du partage
     * rapide, il la retrouve sur le tunnel. Une origine que le relais ne
     * sait pas servir — une IP de réseau local — est dite ici, avant
     * Discord, plutôt qu'au bout d'un trajet qui ne pouvait pas aboutir.
     */
    let origin;
    if (oauth.usesRelay()) {
      origin = oauth.returnOrigin(req);
      if (!origin) {
        return res
          .status(400)
          .type('html')
          .send(
            errorPage(
              'Adresse non déclarée',
              'Discord ne peut renvoyer ici que par une adresse fixe. Ouvrez le tableau ' +
                'de bord sur cette machine (localhost) ou par le lien de partage, ou ' +
                'déclarez cette adresse dans PUBLIC_URL.',
              String(req.headers.host || ''),
            ),
          );
      }
    }

    const nonce = crypto.randomBytes(16).toString('hex');
    res.cookie(OAUTH_COOKIE, nonce, auth.cookieOptions(oauth.STATE_TTL_MS));

    res.redirect(
      302,
      oauth.buildAuthorizeUrl(safeReturnTo, {
        holdsToken: auth.identify(req).holdsToken,
        claim: switching,
        silent,
        nonce,
        origin,
      }),
    );
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

  router.get('/discord/callback', porte, async (req, res) => {
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
      return res
        .status(400)
        .type('html')
        .send(errorPage('Autorisation refusée', "Vous avez refusé l'accès, ou Discord l'a interrompu.", error));
    }

    if (!route) {
      // Rappel sans `state` valable : lien périmé, rejoué, ou forgé.
      return res
        .status(400)
        .type('html')
        .send(errorPage('Lien expiré', "Ce lien d'authentification n'est plus valable. Relancez la connexion."));
    }

    /*
     * Ce trajet a-t-il bien été ouvert par ce navigateur-ci ?
     *
     * Le `state` seul ne répondait pas : imprévisible, certes, mais valable
     * pour quiconque le présente. Un attaquant en demandait un, obtenait un
     * `code` pour son propre compte, puis faisait charger le rappel à sa
     * victime — qui se retrouvait connectée sous le compte de l'attaquant
     * sans l'avoir demandé ni s'en apercevoir.
     *
     * Le cookie posé à l'aller répond à la question. Il est comparé à temps
     * constant, comme le jeton : la valeur est un secret de même nature.
     *
     * `nonce` absent du `state` : celui-ci a été émis par une version
     * antérieure à ce correctif, encore dans sa fenêtre de cinq minutes au
     * moment d'une bascule de version. On le laisse passer plutôt que
     * d'éconduire quelqu'un en pleine connexion pour un champ qui n'existait
     * pas quand il a cliqué.
     */
    if (route.nonce) {
      const presente = auth.parseCookies(req.headers.cookie || '')[OAUTH_COOKIE];
      if (!safeEquals(presente, route.nonce)) {
        log.warn('[OAuth] Callback refused: this sign-in was opened by another browser.');
        res.clearCookie(OAUTH_COOKIE, auth.cookieOptions(undefined));
        if (route.silent) return giveUpSilently(res, route.returnTo);
        return res
          .status(400)
          .type('html')
          .send(
            errorPage(
              'Connexion interrompue',
              'Cette connexion a été ouverte depuis un autre navigateur. ' + 'Relancez-la depuis celui-ci.',
            ),
          );
      }
    }

    // Consommé : il n'a plus d'usage, et rien ne doit traîner d'un trajet.
    res.clearCookie(OAUTH_COOKIE, auth.cookieOptions(undefined));

    if (typeof code !== 'string' || !code) {
      if (route.silent) return giveUpSilently(res, route.returnTo);
      return res
        .status(400)
        .type('html')
        .send(errorPage('Réponse incomplète', "Discord n'a pas renvoyé de code d'autorisation."));
    }

    let user;
    try {
      user = await oauth.identifyFromCode(code);
    } catch (err) {
      log.error(`[OAuth] Authentication failed: ${err.message}`);
      if (route.silent) return giveUpSilently(res, route.returnTo);
      return res
        .status(502)
        .type('html')
        .send(
          errorPage(
            'Authentification impossible',
            "Discord a refusé la demande. L'URL de rappel déclarée dans le portail " +
              'développeur doit correspondre exactement à celle-ci :',
            oauth.redirectUri(),
          ),
        );
    }

    // Le serveur s'ouvre avant la connexion à Discord : tant que le bot n'est
    // pas prêt, il ne connaît encore aucun serveur, et refuserait à tort
    // quelqu'un qui en est membre.
    if (webServer && webServer.ready === false) {
      return res
        .status(503)
        .type('html')
        .send(
          errorPage(
            'Le bot finit de démarrer',
            "Il n'est pas encore connecté à Discord. Réessayez de vous connecter dans quelques secondes.",
          ),
        );
    }

    if (!(await isKnownMember(webServer?.client, user.id))) {
      log.warn(`[OAuth] Access denied to ${user.username} (${user.id}): member of no guild the bot is in.`);
      // Le refus se dit, même au terme d'un essai muet : celui-ci portait
      // sur « qui êtes-vous », pas sur « avez-vous le droit d'entrer ». Le
      // taire laisserait le visiteur devant une porte qui se rouvre sans
      // jamais dire pourquoi elle ne cède pas.
      return res
        .status(403)
        .type('html')
        .send(errorPage('Accès refusé', "Votre compte Discord ne fait partie d'aucun serveur où ce bot est présent."));
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

    /*
     * Une demande de reprise, jamais une reprise.
     *
     * La propriété revient à qui est devant la machine — la règle n'a pas
     * changé —, mais le jeton a cessé d'en être la preuve : il voyage en
     * `?token=`, se dépose dans l'historique du navigateur et entre dans le
     * manifeste de l'application. Le transfert demande donc maintenant un
     * code que le bot écrit dans sa console, et qu'il faut y aller lire.
     *
     * Le jeton reste ce qui ouvre la demande : il en faut deux, et ils ne
     * se trouvent pas au même endroit. Voir ownerTransfer.js.
     *
     * La revendication initiale, elle, ne change pas : elle n'écrase
     * personne, et l'encombrer d'un code ferait buter le premier démarrage
     * sur une étape que rien n'annonce.
     */
    let transferId = null;
    if (!owner.isClaimed() && holdsToken) {
      owner.claim(user);
    } else if (route.claim && holdsToken && !owner.isOwner({ userId: user.id })) {
      transferId = ownerTransfer.open(user);
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
    res.cookie(sessions.COOKIE_NAME, id, auth.cookieOptions(sessions.MAX_AGE_MS));

    // Repassé au filtre, et non repris tel quel : le `state` a été émis par
    // ce serveur, mais rien n'oblige à ce que la version qui l'a écrit ait
    // filtré comme celle qui le lit — une release installée peut être plus
    // ancienne que le correctif.
    // La session est ouverte dans les deux cas : le demandeur est connecté,
    // il lui manque seulement la propriété. S'il renonce à saisir le code, il
    // reste ce qu'il était avant — un invité, ou le maître déchu de rien.
    if (transferId) {
      return res.redirect(302, `/auth/owner/confirm?id=${encodeURIComponent(transferId)}`);
    }

    res.redirect(302, cheminInterne(route.returnTo));
  });

  /**
   * La saisie du code de reprise.
   *
   * Page rendue par le serveur, comme les autres pages de ce trajet : elle
   * s'affiche au retour de Discord, avant que le tableau de bord n'ait la
   * main. La faire porter par l'interface aurait demandé de lui apprendre un
   * état qu'elle ne connaît que deux minutes par an.
   *
   * Ces deux adresses ne sont pas publiques : elles arrivent après le rappel,
   * donc avec la session que celui-ci vient d'ouvrir. C'est cette session qui
   * dit qui saisit le code, et `ownerTransfer.confirm` refuse un code
   * présenté par un autre compte que le demandeur.
   */
  router.get('/owner/confirm', (req, res) => {
    const demande = ownerTransfer.peek(String(req.query.id || ''));
    if (!demande) {
      return res
        .status(400)
        .type('html')
        .send(
          errorPage(
            'Demande expirée',
            "Cette demande de reprise n'est plus valable. Relancez le changement " +
              'de compte depuis le tableau de bord.',
          ),
        );
    }
    res.type('html').send(confirmPage(String(req.query.id), demande.username, null));
  });

  router.post('/owner/confirm', express.urlencoded({ extended: false, limit: '4kb' }), (req, res) => {
    /*
     * Le corps est analysé ici et non globalement : le routeur de
     * `/auth` est monté avant `express.urlencoded` dans WebServer, et
     * c'est le seul formulaire du trajet.
     */
    const id = String((req.body && req.body.id) || '');
    const code = String((req.body && req.body.code) || '');

    const identity = req.identity || auth.identify(req);
    const sessionUserId = identity.session?.userId || null;
    if (!sessionUserId) {
      return res
        .status(401)
        .type('html')
        .send(errorPage('Session absente', "Reconnectez-vous avant de reprendre l'installation."));
    }

    const verdict = ownerTransfer.confirm(id, code, sessionUserId);

    if (verdict.ok) {
      log.success('[Owner] Transfer confirmed by console code.');
      return res.redirect(302, '/');
    }

    if (verdict.reason === 'wrong') {
      const demande = ownerTransfer.peek(id);
      return res
        .status(400)
        .type('html')
        .send(
          confirmPage(id, demande ? demande.username : '', `Code incorrect. Il vous reste ${verdict.left} essai(s).`),
        );
    }

    return res
      .status(400)
      .type('html')
      .send(
        errorPage(
          'Demande close',
          verdict.reason === 'mismatch'
            ? 'Cette demande a été ouverte par un autre compte que celui connecté ici.'
            : "Cette demande n'est plus valable. Relancez le changement de compte.",
        ),
      );
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

    // Les mêmes attributs qu'à la pose : un navigateur n'efface un cookie
    // que si `Secure`, `SameSite` et le chemin correspondent. Sans cela la
    // déconnexion répondait « ok » en laissant la session dans le bocal.
    res.clearCookie(sessions.COOKIE_NAME, auth.cookieOptions(undefined));
    res.json({ ok: true, closed });
  });

  return router;
}

module.exports = createAuthRouter;
