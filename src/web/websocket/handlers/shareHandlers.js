/**
 * shareHandlers — Partage du contrôle du bot par le maître de session.
 *
 * Quatre messages, tous réservés au maître (voir permissions.js, où ils sont
 * marqués comme tels — un invité qui s'accorderait ses propres droits n'aurait
 * plus grand intérêt) :
 *
 *   - `sendInviteLink`  — poste le lien d'authentification dans le tchat du salon vocal ;
 *   - `admitGuest`      — répond « oui » à qui frappe, sans rien accorder ;
 *   - `shareControl`    — accorde ou retire des droits, un geste à la fois ;
 *   - `revokeControl`   — congédie : plus de droits, plus d'admission, plus de fiche.
 *
 * ## Retirer les droits, ou retirer la personne
 *
 * Les deux derniers se ressemblent et ne disent pas la même chose, et les
 * confondre coûtait cher.
 *
 * `shareControl` avec un jeu vide décoche tout : l'invité reste dans la liste,
 * admis, reconnu, simplement sans pouvoir. C'est le geste courant — « plus
 * maintenant » — et c'est celui qu'il faut pour rendre les droits l'instant
 * d'après.
 *
 * `revokeControl` congédie pour de bon : droits effacés, admission retirée,
 * sessions fermées, fiche du carnet supprimée. L'invité redevient un inconnu
 * qui devra frapper de nouveau. C'est le refus, et le renvoi.
 *
 * Les droits vivent dans les réglages du serveur (Database.setUserPermissions),
 * l'identité dans web/sessions.js, et le souvenir des personnes dans
 * web/guests.js. Congédier touche les trois : sans quoi l'onglet de l'invité
 * garderait une identité valable et son nom resterait dans la fenêtre, ce qui
 * reviendrait à ne l'avoir renvoyé qu'à moitié.
 */

const database = require('../../../database/Database');
const permissions = require('../../permissions');
const sessions = require('../../sessions');
const guests = require('../../guests');
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
function targetChannel(ctx) {
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
        return reply(ws, false, 'oauth_absent');
    }

    const channel = targetChannel(ctx);
    if (!channel) {
        return reply(ws, false, 'channel_missing');
    }

    // Un salon vocal accepte les messages depuis 2022, mais rien ne garantit
    // que celui-ci en soit un, ni que le bot ait le droit d'y écrire.
    if (typeof channel.send !== 'function') {
        return reply(ws, false, 'channel_muted');
    }

    const link = `${oauth.publicUrl()}/auth/discord`;

    try {
        await channel.send(
            '🎛️ **Partage du contrôle du lecteur**\n'
            + `Connectez-vous avec votre compte Discord pour prendre la main : ${link}\n`
            + '_Le maître de la session décide ensuite de ce que chacun peut faire._'
        );
    } catch (err) {
        log.error(`[Share] Cannot post the link in #${channel.name}: ${err.message}`);
        return reply(ws, false, 'send_denied');
    }

    log.info(`[Share] Authentication link posted in #${channel.name}.`);
    reply(ws, true, null, { channelName: channel.name });
    webServer.broadcastState(currentGuildId);
}

/**
 * Accorde ou retire des droits à un compte Discord.
 *
 * L'appelant envoie l'état complet du jeu de droits, pas une différence : c'est
 * ce que produit une fenêtre à interrupteurs, et cela évite qu'un message perdu
 * laisse les deux côtés en désaccord. Un jeu vide décoche donc tout, sans pour
 * autant congédier l'invité — voir l'en-tête du module.
 */
function handleShareControl(ctx) {
    const { ws, data, webServer, currentGuildId } = ctx;
    const { userId } = data;
    if (!userId) return;

    /*
     * Accorder des droits, c'est admettre.
     *
     * Sans cela, cocher une case pour quelqu'un qui figurait encore dans la
     * file des demandes l'y laissait : il devenait un invité pourvu de droits
     * *et* une demande en attente, deux lignes pour une personne. Le maître qui
     * coche a répondu à la question, il n'a plus à cliquer « Accepter ».
     */
    database.admitGuest(currentGuildId, userId);

    const granted = database.setUserPermissions(currentGuildId, userId, data.permissions);
    const names = permissions.granted(granted);

    // Un droit coché à la main répond aussi à la demande qui le réclamait :
    // la laisser en attente ferait proposer d'accorder ce qui l'est déjà.
    for (const action of names) database.removeRightRequests(currentGuildId, userId, action);
    log.info(`[Share] Rights of ${userId}: `
        + (names.length ? `${names.length} — ${names.join(', ')}` : 'none'));

    reply(ws, true, null, { userId, permissions: granted });
    // L'invité concerné doit voir son tableau de bord s'ouvrir ou se fermer sans
    // avoir à recharger : la diffusion d'état le lui apprend.
    webServer.broadcastState(currentGuildId);
}

/**
 * Admet un invité sans rien lui accorder.
 *
 * Répondre à quelqu'un qui frappe et lui ouvrir des droits sont deux gestes
 * distincts : celui-ci ne fait que le premier. L'invité quitte la file des
 * demandes et rejoint la liste ordinaire, où ses droits se cochent ensuite un
 * par un — et où il reste visible même sans en avoir aucun.
 */
function handleAdmitGuest(ctx) {
    const { ws, data, webServer, currentGuildId } = ctx;
    const { userId } = data;
    if (!userId) return;

    database.admitGuest(currentGuildId, userId);
    log.info(`[Share] Guest ${userId} admitted, with no rights granted.`);

    reply(ws, true, null, { userId });
    webServer.broadcastState(currentGuildId);
}

/**
 * Congédie un invité : droits, admission, sessions et fiche du carnet.
 *
 * La session part avec les droits. La garder ne donnerait accès à rien, mais
 * laisserait l'invité devant un tableau de bord inerte sans lui dire pourquoi ;
 * fermée, il retombe sur la page d'authentification, qui est explicite.
 *
 * À ne pas confondre avec un `shareControl` vide, qui décoche tout sans
 * renvoyer personne — voir l'en-tête du module.
 */
function handleRevokeControl(ctx) {
    const { ws, data, webServer, currentGuildId } = ctx;
    const { userId } = data;
    if (!userId) return;

    database.revokeUserPermissions(currentGuildId, userId);
    database.dismissGuest(currentGuildId, userId);
    // Ses demandes et sa mise en sourdine partent avec lui : il redevient un
    // inconnu, et un inconnu n'a rien demandé.
    database.removeRightRequests(currentGuildId, userId);
    database.setRightRequestsMuted(currentGuildId, userId, false);
    const closed = sessions.revokeUser(userId);
    /*
     * Le carnet oublie aussi.
     *
     * Il retient les personnes qu'on veut retrouver — c'est ce qui évite à un
     * invité admis de se reconnecter à chaque venue. Y laisser celui qu'on
     * vient de refuser le ferait réapparaître à la ligne suivante, hors ligne
     * mais toujours là : exactement le contraire du geste qu'on vient de faire.
     *
     * Rien ne lui interdit de revenir. Il frappera de nouveau à la porte, ce
     * qui est la situation d'un inconnu, et c'est bien ce qu'il est redevenu.
     */
    guests.forget(userId);

    log.info(`[Share] Control revoked for ${userId} (${closed} session(s) closed).`);

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

    reply(ws, true, null, { userId });
    webServer.broadcastState(currentGuildId);
}

/* ═════════════════════ Les demandes de droit ═════════════════════ */

/**
 * Délai minimal entre deux demandes d'un même invité.
 *
 * Chaque demande sonne chez l'administrateur. Rien n'empêcherait sinon un invité
 * de faire défiler vingt-neuf notifications en autant de clics — ni la console
 * du navigateur d'en envoyer mille.
 */
const REQUEST_COOLDOWN_MS = 3000;

/** userId → horodatage de la dernière demande acceptée. En mémoire seulement. */
const lastRequestAt = new Map();

/** Envoie un message à chaque onglet d'un compte, sur ce serveur. */
function tellUser(webServer, guildId, userId, type, data) {
    for (const client of webServer.wss?.clients || []) {
        if (client.readyState !== 1 || client.selectedGuildId !== guildId) continue;
        if (client.identity?.session?.userId !== String(userId)) continue;
        try { client.send(JSON.stringify({ type, data })); } catch (e) {}
    }
}

/** Envoie un message à chaque onglet de l'administrateur, sur ce serveur. */
function tellMaster(webServer, guildId, type, data) {
    for (const client of webServer.wss?.clients || []) {
        if (client.readyState !== 1 || client.selectedGuildId !== guildId) continue;
        if (!client.identity?.master) continue;
        try { client.send(JSON.stringify({ type, data })); } catch (e) {}
    }
}

/**
 * Un invité demande un droit qui lui a été refusé.
 *
 * Ouvert à tous par la table des messages — c'est précisément celui qui n'a
 * pas le droit qui demande —, le tri se fait donc ici :
 *
 *  - il faut être un invité reconnu : l'administrateur n'a rien à demander, et
 *    un porteur de jeton sans compte n'a pas de nom sous lequel être notifié ;
 *  - et déjà admis : pour qui attend encore à la porte, la question en cours
 *    est son admission, pas un droit ;
 *  - le droit doit exister au catalogue, et ne pas être déjà accordé ;
 *  - l'invité ne doit pas avoir été mis en sourdine ;
 *  - une demande déjà en attente n'en crée pas une seconde ;
 *  - deux demandes se suivent d'au moins `REQUEST_COOLDOWN_MS`.
 *
 * L'invité reçoit toujours une réponse, `rightRequestResult`, qui dit ce qu'il
 * en est : son bouton ne doit pas rester sur un « Envoi… » que rien ne lève.
 */
function handleRequestRight(ctx) {
    const { ws, data, webServer, currentGuildId } = ctx;
    const identity = ws && ws.identity;
    const session = identity && identity.session;
    const userId = session && session.userId ? String(session.userId) : null;
    const action = data && data.action;

    const answer = (ok, reason) => {
        try {
            ws.send(JSON.stringify({ type: 'rightRequestResult', data: { action, ok, reason } }));
        } catch (e) {}
    };

    if (!userId || identity.master) return answer(false, 'not_guest');
    if (!permissions.ACTIONS.includes(action)) return answer(false, 'unknown_right');
    // Un invité qui frappe encore à la porte n'a pas de droit à réclamer : la
    // question posée à l'administrateur est d'abord celle de son admission.
    const current = database.getUserPermissions(currentGuildId, userId);
    if (!permissions.hasAny(current) && !database.getAdmittedGuests(currentGuildId).includes(userId)) {
        return answer(false, 'not_admitted');
    }
    if (database.getMutedRightRequests(currentGuildId).includes(userId)) return answer(false, 'muted');
    if (current[action]) return answer(false, 'already_granted');

    const pending = database.getRightRequests(currentGuildId)[userId] || {};
    if (pending[action]) return answer(true, 'already_pending');

    const now = Date.now();
    if (now - (lastRequestAt.get(userId) || 0) < REQUEST_COOLDOWN_MS) return answer(false, 'too_soon');

    database.addRightRequest(currentGuildId, userId, action);
    lastRequestAt.set(userId, now);
    log.info(`[Share] Guest ${userId} asks for the right « ${action} ».`);

    // L'état diffusé porte la demande ; ce message-ci ne sert qu'à sonner, pour
    // que l'administrateur qui n'a pas la fenêtre ouverte l'apprenne.
    tellMaster(webServer, currentGuildId, 'rightRequested', {
        userId,
        displayName: session.displayName || session.username || userId,
        avatar: session.avatar || null,
        action,
    });

    answer(true, null);
    webServer.broadcastState(currentGuildId);
}

/**
 * L'administrateur répond à une demande : il accorde, ou il refuse.
 *
 * Accorder ajoute ce seul droit à ceux que l'invité a déjà, et l'admet s'il ne
 * l'était pas — comme cocher la case à la main (voir `handleShareControl`).
 * Refuser retire la demande, sans rien retirer d'autre. Dans les deux cas
 * l'invité l'apprend, par `rightRequestAnswered`.
 */
function handleAnswerRightRequest(ctx) {
    const { ws, data, webServer, currentGuildId } = ctx;
    const userId = data && data.userId ? String(data.userId) : null;
    const action = data && data.action;
    if (!userId || !permissions.ACTIONS.includes(action)) return;

    const grant = Boolean(data.grant);
    if (grant) {
        database.admitGuest(currentGuildId, userId);
        const current = database.getUserPermissions(currentGuildId, userId);
        database.setUserPermissions(currentGuildId, userId, { ...current, [action]: true });
    }
    database.removeRightRequests(currentGuildId, userId, action);
    log.info(`[Share] Request of ${userId} for « ${action} »: ${grant ? 'granted' : 'refused'}.`);

    tellUser(webServer, currentGuildId, userId, 'rightRequestAnswered', { action, granted: grant });
    reply(ws, true, null, { userId, action, granted: grant });
    webServer.broadcastState(currentGuildId);
}

/**
 * Met en sourdine, ou rétablit, les demandes d'un invité.
 *
 * L'invité ne l'apprend pas par un message à part : son état porte
 * `requestsMuted`, et c'est lui qui grise le bouton de demande et en dit la
 * raison.
 */
function handleMuteRightRequests(ctx) {
    const { ws, data, webServer, currentGuildId } = ctx;
    const userId = data && data.userId ? String(data.userId) : null;
    if (!userId) return;

    const muted = Boolean(data.muted);
    database.setRightRequestsMuted(currentGuildId, userId, muted);
    log.info(`[Share] Requests of ${userId}: ${muted ? 'muted' : 'allowed'}.`);

    reply(ws, true, null, { userId, muted });
    webServer.broadcastState(currentGuildId);
}

/** Réponse au tableau de bord du maître, pour qu'il sache quoi afficher. */
function reply(ws, ok, reason, extra = {}) {
    try {
        ws.send(JSON.stringify({
            type: 'shareResult',
            data: { ok, reason: reason, ...extra },
        }));
    } catch (e) {
        // Socket fermée entre-temps.
    }
}

module.exports = {
    handleAdmitGuest,
    handleSendInviteLink,
    handleShareControl,
    handleRevokeControl,
    handleRequestRight,
    handleAnswerRightRequest,
    handleMuteRightRequests,
};
