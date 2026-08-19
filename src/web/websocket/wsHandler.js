/**
 * wsHandler — Routeur des messages WebSocket du dashboard.
 *
 * Ce module ne contient aucune logique métier : il assemble le contexte d'une
 * requête et délègue au handler enregistré pour le type de message. Les
 * handlers vivent dans handlers/, la table de correspondance dans handlers/index.js.
 */

const routes = require('./handlers');
const log = require('../../utils/logger');

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
 * Traite un message reçu d'un client du dashboard.
 * @param {import('ws').WebSocket} ws - Socket émettrice
 * @param {{ type: string, guildId?: string, data?: object }} payload
 * @param {object} webServer - Instance du WebServer
 */
async function handleMessage(ws, payload, webServer) {
    const { type, guildId, data } = payload;

    const currentGuildId = guildId || ws.selectedGuildId || webServer._getFirstGuildId();
    if (!currentGuildId && !GUILDLESS_TYPES.has(type)) return;

    const handler = routes[type];
    if (!handler) {
        log.warn(`[WebServer] Message WebSocket de type inconnu : ${type}`);
        return;
    }

    const { useMainPlayer } = require('discord-player');
    const player = useMainPlayer();

    await handler({
        ws,
        // Garde centrale : un payload sans `data` ne doit pas faire planter un
        // handler qui déstructure ses champs. Chaque champ reste `undefined`,
        // ce que les handlers traitent déjà (`x !== undefined ? ... : défaut`).
        data: data || {},
        webServer,
        player,
        queue: player.queues.get(currentGuildId),
        currentGuildId,
        // Permet à un handler d'en réutiliser un autre (playNow délègue à play)
        dispatch: (nextPayload) => handleMessage(ws, nextPayload, webServer),
    });
}

module.exports = {
    handleMessage
};
