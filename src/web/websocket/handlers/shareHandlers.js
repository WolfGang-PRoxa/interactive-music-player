/**
 * shareHandlers — Partage du contrôle du bot par le maître de session.
 *
 * Trois messages, tous réservés au maître (voir permissions.js, où ils sont
 * marqués comme tels — un invité qui s'accorderait ses propres droits n'aurait
 * plus grand intérêt) :
 *
 *   - `sendInviteLink`  — poste le lien d'authentification dans le tchat du salon vocal ;
 *   - `shareControl`    — accorde ou retire des droits à un compte Discord ;
 *   - `revokeControl`   — retire tout, et ferme les sessions ouvertes.
 *
 * Les droits vivent dans les réglages du serveur (Database.setUserPermissions),
 * l'identité dans web/sessions.js. Révoquer touche les deux : sans quoi l'onglet
 * de l'invité garderait une identité valable, sans droits — ce qui reviendrait
 * au même, mais laisserait une session ouverte pour rien.
 */

const database = require('../../../database/Database');
const permissions = require('../../permissions');
const sessions = require('../../sessions');
const oauth = require('../../oauth');
const log = require('../../../utils/logger');

/**
 * Salon vocal auquel s'adresse le tableau de bord.
 *
 * Celui qu'il affiche d'abord — c'est celui dont il montre les membres, donc
 * celui où le maître croit poster. Le salon du bot ne vient qu'ensuite.
 *
 * @returns {import('discord.js').VoiceBasedChannel|null}
 */
function salonVise(ctx) {
    const { ws, webServer, currentGuildId } = ctx;
    const guild = webServer.client?.guilds?.cache?.get(currentGuildId);
    if (!guild) return null;

    const channelId = ws?.selectedVoiceChannelId
        || ctx.queue?.channel?.id
        || webServer._findActiveVoiceChannel(guild)?.id;

    if (!channelId) return null;
    return guild.channels.cache.get(channelId) || null;
}

/**
 * Poste le lien d'authentification dans le tchat du salon vocal.
 *
 * Les salons vocaux de Discord portent leur propre fil de discussion : le lien
 * arrive donc sous les yeux de ceux qui écoutent, et de personne d'autre.
 */
async function handleSendInviteLink(ctx) {
    const { ws, webServer, currentGuildId } = ctx;

    if (!oauth.isConfigured()) {
        return repondre(ws, false, 'oauth_absent');
    }

    const channel = salonVise(ctx);
    if (!channel) {
        return repondre(ws, false, 'salon_absent');
    }

    // Un salon vocal accepte les messages depuis 2022, mais rien ne garantit
    // que celui-ci en soit un, ni que le bot ait le droit d'y écrire.
    if (typeof channel.send !== 'function') {
        return repondre(ws, false, 'salon_muet');
    }

    const lien = `${oauth.publicUrl()}/auth/discord`;

    try {
        await channel.send(
            '🎛️ **Partage du contrôle du lecteur**\n'
            + `Connectez-vous avec votre compte Discord pour prendre la main : ${lien}\n`
            + '_Le maître de la session décide ensuite de ce que chacun peut faire._'
        );
    } catch (err) {
        log.error(`[Partage] Envoi du lien impossible dans #${channel.name} : ${err.message}`);
        return repondre(ws, false, 'envoi_refuse');
    }

    log.info(`[Partage] Lien d'authentification posté dans #${channel.name}.`);
    repondre(ws, true, null, { channelName: channel.name });
    webServer.broadcastState(currentGuildId);
}

/**
 * Accorde ou retire des droits à un compte Discord.
 *
 * L'appelant envoie l'état complet des quatre cases, pas une différence : c'est
 * ce que produit une fenêtre à interrupteurs, et cela évite qu'un message perdu
 * laisse les deux côtés en désaccord.
 */
function handleShareControl(ctx) {
    const { ws, data, webServer, currentGuildId } = ctx;
    const { userId } = data;
    if (!userId) return;

    const accordes = database.setUserPermissions(currentGuildId, userId, data.permissions);
    log.info(`[Partage] Droits de ${userId} : `
        + (permissions.hasAny(accordes)
            ? permissions.GROUPS.filter((g) => accordes[g]).join(', ')
            : 'aucun'));

    repondre(ws, true, null, { userId, permissions: accordes });
    // L'invité concerné doit voir son tableau de bord s'ouvrir ou se fermer sans
    // avoir à recharger : la diffusion d'état le lui apprend.
    webServer.broadcastState(currentGuildId);
}

/**
 * Retire tous les droits d'un invité et ferme ses sessions.
 *
 * La session part avec les droits. La garder ne donnerait accès à rien, mais
 * laisserait l'invité devant un tableau de bord inerte sans lui dire pourquoi ;
 * fermée, il retombe sur la page d'authentification, qui est explicite.
 */
function handleRevokeControl(ctx) {
    const { ws, data, webServer, currentGuildId } = ctx;
    const { userId } = data;
    if (!userId) return;

    database.revokeUserPermissions(currentGuildId, userId);
    const fermees = sessions.revokeUser(userId);

    log.info(`[Partage] Contrôle révoqué pour ${userId} (${fermees} session(s) fermée(s)).`);

    // L'onglet de l'invité perd son identité : sa prochaine requête le renverra
    // vers l'authentification. Le prévenir tout de suite évite qu'il continue à
    // cliquer dans le vide.
    for (const client of webServer.wss.clients) {
        if (client.identity?.session?.userId === String(userId)) {
            try {
                client.send(JSON.stringify({ type: 'controlRevoked', data: {} }));
            } catch (e) {}
        }
    }

    repondre(ws, true, null, { userId });
    webServer.broadcastState(currentGuildId);
}

/** Réponse au tableau de bord du maître, pour qu'il sache quoi afficher. */
function repondre(ws, ok, raison, extra = {}) {
    try {
        ws.send(JSON.stringify({
            type: 'shareResult',
            data: { ok, reason: raison, ...extra },
        }));
    } catch (e) {
        // Socket fermée entre-temps.
    }
}

module.exports = {
    handleSendInviteLink,
    handleShareControl,
    handleRevokeControl,
};
