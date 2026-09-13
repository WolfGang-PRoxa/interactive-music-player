/**
 * httpGuards — Les droits, portés jusqu'aux routes HTTP.
 *
 * ## Le problème
 *
 * `permissions.js` est le seul endroit qui tranche ce qu'un invité peut faire,
 * et il le fait bien : un droit par geste, relu à chaque message, fermé par
 * défaut sur ce qu'il ne connaît pas. Mais il n'était branché que sur le
 * routeur WebSocket. Le routeur `/api` était monté derrière `auth.middleware`
 * seul, qui répond à « qui frappe ? » et jamais à « que peut-il faire ? ».
 *
 * Un invité sans le moindre droit coché pouvait donc parcourir l'arborescence
 * du disque de l'hôte, détourner le dossier où le bot écrit ses
 * téléchargements, et y déposer des fichiers — trois gestes que le même
 * invité se voyait refuser sur la WebSocket, où ils relèvent du maître.
 *
 * ## L'approche
 *
 * Une garde par route, posée à la déclaration, qui lit la même table que le
 * WebSocket. Rien n'est réinventé : `local` et `right` ne font que porter
 * jusqu'à Express ce que `wsHandler.identityOf` fait déjà pour les messages.
 *
 * Trois niveaux, et le choix de l'un d'eux est un acte délibéré :
 *
 *  - **`local`** — être devant la machine. Le jeton en est la preuve, comme
 *    dans `owner.js` : il s'écrit au démarrage et ne circule pas dans le lien
 *    d'invitation. Réservé à ce qui touche l'hôte lui-même — parcourir ses
 *    dossiers, choisir où il écrit.
 *  - **`right('x')`** — le droit nommé, tel que le maître l'a coché.
 *  - **aucune garde** — la route ne commande rien : elle décrit l'état, sert
 *    la documentation ou laisse écouter. La laisser ouverte est alors un choix
 *    motivé route par route dans `api.js`, pas un oubli.
 *
 * ## Ce que `local` n'est pas
 *
 * Ce n'est pas `master`. Le lanceur (`tools/start-bot.ps1`) interroge
 * `/api/clients` avec le jeton et sans session Discord : sur une installation
 * où l'application OAuth est configurée, `identify()` lui rend `master: false`
 * et `pendingLogin: true`. Exiger `master` l'aurait donc mis à la porte de son
 * propre bot. `holdsToken` est la question qu'on voulait poser depuis le
 * début — « est-ce quelqu'un qui est devant la machine ? » — et c'est celle-ci
 * qui y répond.
 */

const auth = require('./auth');
const database = require('../database/Database');
const permissions = require('./permissions');
const log = require('../utils/logger');

/**
 * Refus, en JSON et jamais en HTML.
 *
 * Le tableau de bord lit `res.json()` avant même de regarder le code de
 * statut — voir `js/downloadTarget.js`. Une page d'erreur HTML y lèverait une
 * exception au lieu d'un refus lisible.
 */
function deny(res, what) {
    return res.status(403).json({
        error: 'Droit refusé',
        // Le tableau de bord grise ce qui est interdit ; quand il ne l'a pas
        // fait, cette clé lui dit quoi.
        action: what,
    });
}

/**
 * Identité du demandeur, et ses droits sur le serveur visé.
 *
 * `req.identity` est posée par `auth.middleware`. Le repli n'accorde rien : il
 * relit la requête plutôt que de supposer, exactement comme `identityOf` dans
 * wsHandler.js.
 *
 * @param {import('express').Request} req
 * @param {object} webServer
 * @returns {{ master: boolean, userId: string|null, permissions: object }}
 */
function identityOf(req, webServer) {
    const identity = req.identity || auth.identify(req);

    if (identity.master) {
        return { master: true, userId: null, permissions: permissions.allPermissions() };
    }

    const userId = identity.session?.userId || null;

    /*
     * Les droits sont attachés à un serveur Discord, pas au compte seul : le
     * même invité peut mener la lecture ici et n'avoir rien là-bas. La route
     * dit lequel elle vise, comme le font déjà ses autres paramètres ; à
     * défaut, c'est le premier serveur, qui est aussi ce que fait `getState`.
     */
    const guildId = (typeof req.query.guildId === 'string' && req.query.guildId)
        // Appelé avec un serveur réduit dans les tests, qui montent le routeur
        // seul : l'absence de serveur vaut absence de droits, pas une exception.
        || (typeof webServer?._getFirstGuildId === 'function'
            ? webServer._getFirstGuildId()
            : null);

    return {
        master: false,
        userId,
        permissions: userId && guildId
            ? database.getUserPermissions(guildId, userId)
            : permissions.noPermissions(),
    };
}

/**
 * Construit les gardes pour une instance de serveur.
 *
 * En fabrique, et non en module figé : `_getFirstGuildId` appartient au
 * serveur, comme pour `createApiRouter`.
 *
 * @param {object} webServer
 */
function createGuards(webServer) {
    /**
     * Réservé à qui est devant la machine — voir l'en-tête du module.
     */
    function local(req, res, next) {
        const identity = req.identity || auth.identify(req);
        if (identity.master || identity.holdsToken) return next();

        log.warn(`[HTTP] ${req.method} ${req.path} refused to guest `
            + `${identity.session?.userId || '?'}: reserved to the machine's holder.`);
        return deny(res, 'local');
    }

    /**
     * Exige un droit nommé du catalogue de `permissions.js`.
     * @param {string} key Par exemple `queue.add`.
     */
    function right(key) {
        return (req, res, next) => {
            const identity = identityOf(req, webServer);
            if (identity.master) return next();
            if (identity.permissions && identity.permissions[key] === true) return next();

            log.warn(`[HTTP] ${req.method} ${req.path} refused to guest `
                + `${identity.userId || '?'}: right « ${key} » not granted.`);
            return deny(res, key);
        };
    }

    return { local, right };
}

module.exports = { createGuards, identityOf };
