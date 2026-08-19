/**
 * État, journalisation client et cycle de vie du process.
 *
 * Chaque handler reçoit le contexte assemblé par wsHandler :
 * { ws, data, webServer, player, queue, currentGuildId, dispatch }.
 */
const database = require('../../../database/Database');
const playbackStateManager = require('../../../database/PlaybackStateManager');
const log = require('../../../utils/logger');

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
            log.info('[WebServer] Fade-in de démarrage joué par le tableau de bord.');
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
 * @param {{ entree?: string }} [options]
 */
function restartProcess(webServer, options = {}) {
    const entryPoint = options.entryPoint || process.argv[1];

        try {
            const { useMainPlayer } = require('discord-player');
            const player = useMainPlayer();
            playbackStateManager.saveState(player);
            log.info('[WebServer] État de lecture sauvegardé instantanément avant redémarrage.');
        } catch (saveErr) {
            log.error('[WebServer] Erreur sauvegarde état avant redémarrage :', saveErr.message);
        }

        try {
            webServer.wss.close();
            webServer.server.close();

            log.info(`[WebServer] Serveur arrêté. Démarrage de la nouvelle instance : ${entryPoint}`);

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
                windowsHide: true
            });
            child.unref();

            process.exit(0);
        } catch (err) {
            log.error('[WebServer] Erreur lors du redémarrage :', err.message);
            process.exit(1);
        }
}

function handleRestartBot(ctx) {
    const { webServer } = ctx;

        log.info('[WebServer] Requête de redémarrage reçue. Sauvegarde instantanée de l\'état (musique continue sans fade-out)...');

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

        log.info(`[WebServer] Requête d'extinction reçue. Démarrage du fade-out de ${fadeDurationMs / 1000}s...`);

        const payload = JSON.stringify({
            type: 'status',
            data: {
                status: 'shutting_down',
                fadeoutEnabled,
                fadeoutDuration: fadeoutDurationSecs
            }
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
            log.error('[WebServer] Erreur fade-out avant extinction :', saveErr.message);
        }

        try {
            if (webServer.wss) {
                webServer.wss.clients.forEach((c) => {
                    try { c.close(); } catch (e) {}
                });
                try { webServer.wss.close(); } catch (e) {}
            }
            if (webServer.server) {
                try { webServer.server.close(); } catch (e) {}
            }
            if (webServer.client) {
                const cl = webServer.client;
                if (cl.duckingManagers) {
                    for (const [gId, manager] of cl.duckingManagers) {
                        try { manager.destroy(); } catch (e) {}
                    }
                    cl.duckingManagers.clear();
                }
                try { cl.destroy(); } catch (e) {}
            }

            log.info('[WebServer] Serveur arrêté après fade-out. Extinction complète du bot.');
            setTimeout(() => process.exit(0), 100);
            process.exit(0);
        } catch (err) {
            log.error('[WebServer] Erreur lors de l\'extinction :', err.message);
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
