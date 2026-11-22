/**
 * État, journalisation client et cycle de vie du process.
 *
 * Chaque handler reçoit le contexte assemblé par wsHandler :
 * { ws, data, webServer, player, queue, currentGuildId, dispatch }.
 */
const database = require('../../../database/Database');
const playbackStateManager = require('../../../database/PlaybackStateManager');
const log = require('../../../utils/logger');
const supervisor = require('../../../utils/supervisor');

function handleRequestState(ctx) {
  const { webServer, currentGuildId } = ctx;

  webServer.broadcastState(currentGuildId);
}

/**
 * Le client a joué le fade-in de démarrage laissé en attente.
 *
 * En diffusion personnelle, le son sort du navigateur : le fade-in ne peut pas
 * être appliqué au démarrage du bot, faute d'auditeur. Il reste donc en attente
 * sur la file jusqu'à l'ouverture du tableau de bord, qui le joue puis le
 * consomme ici — une seule fois, même si plusieurs onglets sont ouverts.
 */
function handleStartupFadeinConsumed(ctx) {
  const { queue, webServer, currentGuildId } = ctx;

  if (queue && queue.pendingStartupFadein) {
    queue.pendingStartupFadein = null;
    log.info('[WebServer] Startup fade-in played by the dashboard.');
    webServer.broadcastState(currentGuildId);
  }
}

/**
 * Le tiroir du tableau de bord s'ouvre ou se ferme : (dés)abonnement au flux
 * mémoire haute cadence, qui n'a de sens que tant qu'il est affiché.
 * Voir WebServer.setFluxMemoire.
 */
function handleMemoryStream(ctx) {
  const { ws, data, webServer } = ctx;

  webServer.setMemoryStream(ws, !!(data && data.enabled));
}

function handleClientLog(ctx) {
  const { data } = ctx;

  if (data && data.message) {
    const tag = data.source ? `[${data.source}]` : '[Client Log]';
    log.info(`${tag} ${data.message}`);
  }
}

/**
 * Sauvegarde l'état de lecture, arrête le serveur et relance le process.
 *
 * `options.entree` permet de repartir sur un autre script que celui en cours :
 * c'est ainsi qu'on bascule d'une version à l'autre. Le reste des arguments et
 * surtout le répertoire de travail sont conservés — la racine partagée porte
 * `.env` et `data/`, que la nouvelle instance doit retrouver quel que soit le
 * dossier d'où son code est chargé. Voir src/versioning/emplacements.js.
 *
 * @param {object} webServer
 * @param {{ entryPoint?: string }} [options]
 */
function restartProcess(webServer, options = {}) {
  const entryPoint = options.entryPoint || process.argv[1];

  try {
    const { useMainPlayer } = require('discord-player');
    const player = useMainPlayer();
    playbackStateManager.saveState(player);
    log.info('[WebServer] Playback state saved instantly before the restart.');
  } catch (saveErr) {
    log.error('[WebServer] Error saving the state before the restart:', saveErr.message);
  }

  try {
    webServer.wss.close();
    webServer.server.close();

    // Sous l'application de bureau, c'est elle qui relance : une
    // instance détachée échapperait à sa surveillance. Voir
    // src/utils/supervisor.js.
    if (supervisor.isSupervised()) {
      supervisor.writeRestartRequest(entryPoint);
      log.info(`[WebServer] Server stopped. The desktop app restarts: ${entryPoint}`);
      process.exit(supervisor.RESTART_EXIT_CODE);
      return;
    }

    log.info(`[WebServer] Server stopped. Starting the new instance: ${entryPoint}`);

    const spawn = require('child_process').spawn;
    const args = [entryPoint, ...process.argv.slice(2)];
    const executor = process.argv[0];

    const child = spawn(executor, args, {
      // Le redémarrage se veut transparent : l'état est sauvegardé sans
      // fade-out, la musique n'est pas coupée. La nouvelle instance doit
      // donc s'abstenir du fade-in de démarrage, qui en est la
      // contrepartie et trahirait la coupure.
      env: { ...process.env, IMP_RESTART: '1' },
      cwd: process.cwd(),
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();

    process.exit(0);
  } catch (err) {
    log.error('[WebServer] Error during the restart:', err.message);
    process.exit(1);
  }
}

function handleRestartBot(ctx) {
  const { webServer } = ctx;

  log.info('[WebServer] Restart request received. Instant state save (the music keeps going, no fade-out)...');

  const payload = JSON.stringify({ type: 'status', data: { status: 'restarting' } });
  webServer.wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(payload);
    }
  });

  restartProcess(webServer);
}

async function handleShutdownBot(ctx) {
  const { ws, data, webServer, player } = ctx;

  const guildId = ws.guildId || webServer.client?.guilds?.cache?.first()?.id;
  const settings = database.getSettings(guildId);
  const fadeoutEnabled = settings.fadeoutEnabled !== undefined ? !!settings.fadeoutEnabled : true;
  const fadeoutDurationSecs = settings.fadeoutDuration !== undefined ? parseFloat(settings.fadeoutDuration) : 5;
  const fadeDurationMs = fadeoutEnabled ? Math.round(fadeoutDurationSecs * 1000) : 0;

  log.info(`[WebServer] Shutdown request received. Starting the ${fadeDurationMs / 1000}s fade-out...`);

  const payload = JSON.stringify({
    type: 'status',
    data: {
      status: 'shutting_down',
      fadeoutEnabled,
      fadeoutDuration: fadeoutDurationSecs,
    },
  });
  webServer.wss.clients.forEach((cClient) => {
    if (cClient.readyState === 1) {
      cClient.send(payload);
    }
  });

  try {
    const { useMainPlayer } = require('discord-player');
    const player = useMainPlayer();
    await playbackStateManager.fadeOutAndSaveState(player, fadeDurationMs);
  } catch (saveErr) {
    log.error('[WebServer] Fade-out error before shutdown:', saveErr.message);
  }

  try {
    if (webServer.wss) {
      webServer.wss.clients.forEach((c) => {
        try {
          c.close();
        } catch (e) {}
      });
      try {
        webServer.wss.close();
      } catch (e) {}
    }
    if (webServer.server) {
      try {
        webServer.server.close();
      } catch (e) {}
    }
    if (webServer.client) {
      const cl = webServer.client;
      if (cl.duckingManagers) {
        for (const [gId, manager] of cl.duckingManagers) {
          try {
            manager.destroy();
          } catch (e) {}
        }
        cl.duckingManagers.clear();
      }
      try {
        cl.destroy();
      } catch (e) {}
    }

    log.info('[WebServer] Server stopped after the fade-out. Bot fully shut down.');
    setTimeout(() => process.exit(0), 100);
    process.exit(0);
  } catch (err) {
    log.error('[WebServer] Error during the shutdown:', err.message);
    process.exit(1);
  }
}

module.exports = {
  handleRequestState,
  handleStartupFadeinConsumed,
  handleMemoryStream,
  handleClientLog,
  handleRestartBot,
  handleShutdownBot,
  restartProcess,
};
