/**
 * wsHandler — Routeur des messages WebSocket du dashboard.
 *
 * Ce module ne contient aucune logique métier : il assemble le contexte d'une
 * requête et délègue au handler enregistré pour le type de message. Les
 * handlers vivent dans handlers/, la table de correspondance dans handlers/index.js.
 */

const routes = require('./handlers');
const log = require('../../utils/logger');
const permissions = require('../permissions');
const database = require('../../database/Database');

/**
 * Messages qui ne visent aucun serveur Discord en particulier.
 *
 * Tous les autres pilotent une file de lecture et n'ont pas de sens sans
 * serveur ; ceux-ci relèvent du process lui-même et doivent rester disponibles
 * même quand le bot n'a rejoint aucun serveur — sans quoi on ne pourrait plus
 * changer de version depuis une installation qui n'en a pas encore.
 */
const GUILDLESS_TYPES = new Set(['listVersions', 'installVersion']);

/**
 * Droits du demandeur, relus à chaque message.
 *
 * Jamais mis en cache sur la socket : le maître peut révoquer un invité pendant
 * qu'il est connecté, et l'onglet resté ouvert doit perdre la main au message
 * suivant, pas à la prochaine reconnexion.
 *
 * @param {import('ws').WebSocket} ws
 * @param {string} guildId
 * @returns {{ master: boolean, userId: string|null, permissions: object }}
 */
function identityOf(ws, guildId) {
    const identity = ws.identity;

    // Une socket sans identité est un cas qui ne devrait pas se produire : le
    // handshake en pose toujours une. Le traiter en invité sans droit plutôt
    // qu'en maître fait pencher l'incident du bon côté.
    if (!identity) return { master: false, userId: null, permissions: permissions.noPermissions() };
    if (identity.master) return { master: true, userId: null, permissions: permissions.allPermissions() };

    const userId = identity.session?.userId || null;
    return {
        master: false,
        userId,
        permissions: userId && guildId
            ? database.getUserPermissions(guildId, userId)
            : permissions.noPermissions(),
    };
}

/**
 * Prévient l'invité que le maître ne lui a pas accordé ce droit.
 *
 * `right` nomme le droit du catalogue en cause, quand il y en a un : c'est ce
 * qui permet au tableau de bord de dire lequel manque et d'offrir de le
 * demander. Il est nul pour ce qui n'appartient qu'au maître.
 */
function denied(ws, type, identity, refusedFields = []) {
    log.warn(`[WebServer] Message « ${type} » refused to guest ${identity.userId || '?'}: right not granted.`);
    try {
        ws.send(JSON.stringify({
            type: 'permissionDenied',
            data: { action: type, right: permissions.rightOf(type, refusedFields) },
        }));
    } catch (e) {
        // La socket vient de se fermer : rien à signaler.
    }
}

/**
 * Traite un message reçu d'un client du dashboard.
 * @param {import('ws').WebSocket} ws - Socket émettrice
 * @param {{ type: string, guildId?: string, data?: object }} payload
 * @param {object} webServer - Instance du WebServer
 * @param {{ internal?: boolean }} [options] - `internal` saute le contrôle des
 *   droits : le message vient d'un handler déjà autorisé qui en réutilise un
 *   autre, et non du réseau.
 */
async function handleMessage(ws, payload, webServer, options = {}) {
    const { type, guildId, data } = payload;

    const currentGuildId = guildId || ws.selectedGuildId || webServer._getFirstGuildId();
    if (!currentGuildId && !GUILDLESS_TYPES.has(type)) return;

    const handler = routes[type];
    if (!handler) {
        log.warn(`[WebServer] WebSocket message of unknown type: ${type}`);
        return;
    }

    // Le tableau de bord grise ce qu'un invité n'a pas le droit de faire, mais
    // ce n'est qu'un confort : la console du navigateur contourne l'affichage.
    // La barrière qui compte est celle-ci.
    let effectiveData = data || {};
    if (!options.internal) {
        const identity = identityOf(ws, currentGuildId);

        if (!permissions.canSend(identity, type)) {
            denied(ws, type, identity);
            return;
        }

        // `updateSettings` porte des réglages de plusieurs groupes : il se filtre
        // champ par champ plutôt que de se refuser en bloc.
        if (type === 'updateSettings') {
            const { allowed, refused } = permissions.filterSettings(identity, effectiveData);
            if (refused.length) {
                log.warn(`[WebServer] Settings dropped for guest ${identity.userId || '?'}: ${refused.join(', ')}.`);
                if (!Object.keys(allowed).length) {
                    denied(ws, type, identity, refused);
                    return;
                }
            }
            effectiveData = allowed;
        }
    }

    const { useMainPlayer } = require('discord-player');
    const player = useMainPlayer();

    await handler({
        ws,
        // Garde centrale : un payload sans `data` ne doit pas faire planter un
        // handler qui déstructure ses champs. Chaque champ reste `undefined`,
        // ce que les handlers traitent déjà (`x !== undefined ? ... : défaut`).
        data: effectiveData,
        webServer,
        player,
        // Créée à la demande en diffusion personnelle, où la lecture n'a pas
        // besoin de salon vocal — voir `ensurePlaybackQueue`. Ailleurs, c'est
        // toujours la file existante, ou `null`.
        queue: webServer.ensurePlaybackQueue(currentGuildId),
        currentGuildId,
        // Permet à un handler d'en réutiliser un autre (playNow délègue à play).
        // Le relais est marqué interne : le droit a été vérifié à l'entrée, et
        // le revérifier refuserait à un invité une délégation qu'il a pourtant
        // le droit de déclencher.
        dispatch: (nextPayload) => handleMessage(ws, nextPayload, webServer, { internal: true }),
    });
}

module.exports = {
    handleMessage
};
