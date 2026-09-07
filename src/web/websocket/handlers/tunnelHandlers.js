/**
 * tunnelHandlers — Ce que le tableau de bord peut demander au tunnel.
 *
 * Le module `tailscale` constate et agit ; ces quatre messages sont la seule
 * porte par laquelle l'interface y touche. Tous réservés au maître : rendre le
 * tableau de bord joignable de l'extérieur, ou cesser de l'être, n'est pas une
 * commande de lecture qu'on partage.
 *
 * L'état n'est pas joint à la diffusion ordinaire, et c'est délibéré : le
 * constater lance deux processus, et le faire chaque seconde pour une valeur qui
 * ne bouge qu'au geste de quelqu'un serait payer cher un affichage que personne
 * ne regarde la plupart du temps. La fenêtre le demande en s'ouvrant.
 */

const tailscale = require('../../tailscale');
const log = require('../../../utils/logger');

/**
 * Renvoie l'état du tunnel à celui qui l'a demandé.
 *
 * @param {import('ws').WebSocket} ws
 * @param {object} state - Ce que rend `tailscale.inspect`.
 * @param {string|null} [error] - Ce qui vient d'échouer, le cas échéant.
 */
function send(ws, state, error = null) {
    try {
        ws.send(JSON.stringify({ type: 'tunnelState', data: { ...state, error } }));
    } catch (e) {
        // Socket fermée entre-temps : rien à sauver.
    }
}

/** Le port réellement servi, seul repère fiable de ce qu'il faut publier. */
function dashboardPort(webServer) {
    return webServer?.port || Number(process.env.PORT) || 3000;
}

async function handleTunnelState(ctx) {
    const { ws, webServer } = ctx;
    send(ws, await tailscale.inspect(dashboardPort(webServer)));
}

/**
 * Authentifie la machine avec une clé fournie par l'utilisateur.
 *
 * La clé n'est ni journalisée ni retenue : elle traverse pour être remise à la
 * commande, et disparaît avec l'appel. Elle vaut un mot de passe le temps de son
 * emploi, et le journal du bot se lit à plusieurs.
 */
async function handleTunnelLogin(ctx) {
    const { ws, data, webServer } = ctx;
    const key = data && typeof data.authKey === 'string' ? data.authKey.trim() : '';

    if (!key) {
        return send(ws, await tailscale.inspect(dashboardPort(webServer)), 'missingKey');
    }

    const res = await tailscale.login(key);
    log.info(`[Tailscale] Sign-in with a key: ${res.ok ? 'accepted' : 'refused'}.`);
    send(ws, await tailscale.inspect(dashboardPort(webServer)), res.ok ? null : res.error);
}

/**
 * Publie le tableau de bord.
 *
 * Le geste est explicite jusqu'ici, et il le reste : le port devient joignable
 * depuis l'extérieur. L'accès, lui, ne bouge pas — un inconnu sans session
 * Discord ne voit toujours que la porte.
 */
async function handleTunnelMount(ctx) {
    const { ws, webServer } = ctx;
    const port = dashboardPort(webServer);

    const before = await tailscale.inspect(port);
    // Ne jamais écraser un tunnel qui publie autre chose : quelqu'un s'en sert
    // peut-être depuis des mois, et il ne l'apprendrait qu'en le voyant tomber.
    if (before.step === tailscale.STEP.OTHER_TARGET) {
        return send(ws, before, 'otherTarget');
    }

    const res = await tailscale.mount(port);
    log.info(`[Tailscale] Publishing the dashboard: ${res.ok ? 'done' : 'failed'}.`);
    send(ws, await tailscale.inspect(port), res.ok ? null : res.error);
}

/** Retire la publication, sans toucher au reste de la configuration. */
async function handleTunnelUnmount(ctx) {
    const { ws, webServer } = ctx;
    const port = dashboardPort(webServer);

    const res = await tailscale.unmount(port);
    log.info(`[Tailscale] Dashboard withdrawn from the internet: `
        + `${res.ok ? 'done' : 'failed'}.`);
    send(ws, await tailscale.inspect(port), res.ok ? null : res.error);
}

module.exports = {
    handleTunnelState,
    handleTunnelLogin,
    handleTunnelMount,
    handleTunnelUnmount,
};
