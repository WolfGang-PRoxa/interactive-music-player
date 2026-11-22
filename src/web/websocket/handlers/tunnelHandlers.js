/**
 * tunnelHandlers — Ce que le tableau de bord peut demander au tunnel.
 *
 * Le module `cloudflare` constate et agit ; ces quatre messages sont la seule
 * porte par laquelle l'interface y touche. Tous réservés au maître : rendre le
 * tableau de bord joignable de l'extérieur, ou cesser de l'être, n'est pas une
 * commande de lecture qu'on partage — et rapporter un exécutable sur la machine
 * de l'hôte encore moins.
 *
 * L'état n'est pas joint à la diffusion ordinaire : il ne bouge qu'au geste de
 * quelqu'un, et n'intéresse que la fenêtre de partage, qui le demande en
 * s'ouvrant. Chaque geste répond par l'état qui en résulte.
 */

const cloudflare = require('../../cloudflare');
const log = require('../../../utils/logger');

/**
 * Renvoie l'état du tunnel à celui qui l'a demandé.
 *
 * @param {import('ws').WebSocket} ws
 * @param {object} state - Ce que rend `cloudflare.inspect`.
 * @param {string|null} [error] - Ce qui vient d'échouer, le cas échéant.
 */
function send(ws, state, error = null) {
  try {
    ws.send(JSON.stringify({ type: 'tunnelState', data: { ...state, ...discord(), error } }));
  } catch (e) {
    // Socket fermée entre-temps : rien à sauver.
  }
}

/**
 * De quoi aller déclarer l'adresse chez Discord.
 *
 * Deux valeurs que le tableau de bord ne peut pas fabriquer lui-même, et qu'il
 * aurait tort d'essayer.
 *
 *  - **L'URL de rappel**, telle que le serveur la construit. C'est elle, et non
 *    l'adresse publique affichée, que le portail attend dans ses redirections :
 *    l'adresse fixe suivie de `/auth/discord/callback`, ou celle du relais
 *    quand le partage est rapide. La recomposer côté navigateur ferait deux
 *    versions d'une même règle, et un jour l'une des deux aurait tort.
 *
 *  - **Le relais est-il employé ?** Il change ce qu'il faut dire : son adresse
 *    se déclare une fois pour toutes, et ne bougera plus d'un lancement à
 *    l'autre — alors que l'adresse du tunnel, elle, change à chaque fois.
 *
 *  - **L'identifiant de l'application**, qui permet d'ouvrir directement la
 *    page de cette application-là plutôt que la liste. Il n'a rien d'un secret :
 *    il voyage déjà dans l'adresse d'autorisation que le navigateur visite.
 *
 * @returns {{ redirectUri: string, clientId: string, relay: boolean }}
 */
function discord() {
  const oauth = require('../../oauth');
  return {
    redirectUri: oauth.redirectUri(),
    clientId: oauth.clientId(),
    relay: oauth.usesRelay(),
  };
}

/** Le port réellement servi, seul repère fiable de ce qu'il faut publier. */
function dashboardPort(webServer) {
  return webServer?.port || Number(process.env.PORT) || 3000;
}

async function handleTunnelState(ctx) {
  send(ctx.ws, cloudflare.inspect());
}

/**
 * Rapporte `cloudflared` sur la machine.
 *
 * C'est ce que Tailscale ne permettait pas : son installation demandait les
 * droits administrateur, et se faisait donc à la main. `cloudflared` est un
 * exécutable unique, qui se pose dans `data/bin/` sans rien demander.
 */
async function handleTunnelInstall(ctx) {
  const { ws } = ctx;
  const before = cloudflare.inspect();
  // Apparu entre-temps — installé à la main, ou par un autre onglet : rien à
  // rapporter par-dessus.
  if (before.step !== cloudflare.STEP.ABSENT) return send(ws, before);

  // L'état « téléchargement en cours » d'abord : il prend quelques secondes,
  // et la fenêtre doit pouvoir le dire pendant ce temps.
  const pending = cloudflare.download();
  send(ws, cloudflare.inspect());

  const res = await pending;
  send(ws, cloudflare.inspect(), res.ok ? null : res.error);
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

  const res = await cloudflare.mount(port);
  log.info(`[Tunnel] Publishing the dashboard: ${res.ok ? 'done' : 'failed'}.`);
  send(ws, cloudflare.inspect(), res.ok ? null : res.error);
}

/** Retire la publication. */
async function handleTunnelUnmount(ctx) {
  const res = await cloudflare.unmount();
  send(ctx.ws, cloudflare.inspect(), res.ok ? null : res.error);
}

module.exports = {
  handleTunnelState,
  handleTunnelInstall,
  handleTunnelMount,
  handleTunnelUnmount,
};
