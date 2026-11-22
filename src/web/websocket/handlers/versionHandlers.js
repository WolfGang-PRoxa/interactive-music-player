/**
 * Consultation des versions publiées et bascule de l'une à l'autre.
 *
 * Le catalogue est relu sur GitHub à chaque ouverture du menu déroulant : une
 * release publiée entre-temps y apparaît sans avoir à redémarrer le bot.
 *
 * L'installation, elle, est une opération longue qui se termine par un
 * redémarrage. Elle rend compte de son avancement au fil de l'eau
 * (`versionProgress`) pour que le tableau de bord montre autre chose qu'un
 * écran figé pendant le téléchargement.
 */

const versioning = require('../../../versioning');
const { restartProcess } = require('./systemHandlers');
const log = require('../../../utils/logger');

/**
 * Une installation à la fois. Deux téléchargements concurrents viseraient le
 * même dossier temporaire de destination et se disputeraient le redémarrage.
 */
let installInProgress = null;

/** Diffuse à tous les onglets ouverts : l'opération concerne le bot entier. */
function broadcast(webServer, type, data) {
  const payload = JSON.stringify({ type, data });
  webServer.wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      try {
        client.send(payload);
      } catch (e) {}
    }
  });
}

async function handleListVersions(ctx) {
  const { ws } = ctx;

  let payload;
  try {
    payload = await versioning.catalog();
  } catch (err) {
    log.error('[Versions] Cannot read the catalog:', err.message);
    payload = { releases: [], error: { message: err.message, status: null } };
  }

  // Une installation lancée depuis un autre onglet doit apparaître ici aussi.
  payload.installInProgress = installInProgress;

  try {
    ws.send(JSON.stringify({ type: 'versionCatalog', data: payload }));
  } catch (e) {}
}

/**
 * Installe si nécessaire la version demandée, puis redémarre dessus.
 *
 * Une version déjà présente sur le disque n'est jamais retéléchargée : on passe
 * directement au redémarrage. C'est ce qui garantit qu'une version installée —
 * à commencer par celle en cours d'exécution — ne peut pas être écrasée par une
 * bascule.
 */
async function handleInstallVersion(ctx) {
  const { webServer, data } = ctx;

  const tag = String((data && data.tag) || '').trim();
  if (!tag) {
    return broadcast(webServer, 'versionProgress', {
      phase: 'error',
      message: 'Aucune version sélectionnée.',
    });
  }

  if (installInProgress) {
    return broadcast(webServer, 'versionProgress', {
      phase: 'error',
      tag,
      message: `Une installation est déjà en cours (${installInProgress}).`,
    });
  }

  if (versioning.isCurrent(tag)) {
    return broadcast(webServer, 'versionProgress', {
      phase: 'already',
      tag,
      message: 'Cette version est déjà celle qui tourne.',
    });
  }

  installInProgress = tag;
  try {
    if (tag !== versioning.DEV_TAG) {
      const result = await versioning.install(tag, (step) => {
        broadcast(webServer, 'versionProgress', { tag, ...step });
      });
      log.info(
        `[Versions] Switching to ${tag} (${result.alreadyInstalled ? 'already installed' : 'freshly installed'}).`,
      );
    }

    const target = versioning.resolveEntryPoint(tag);

    broadcast(webServer, 'versionProgress', { phase: 'restart', tag });
    // Le tableau de bord sait déjà afficher le voile de redémarrage sur ce
    // message : la bascule de version réutilise le même chemin que le
    // redémarrage ordinaire.
    broadcast(webServer, 'status', { status: 'restarting' });

    log.info(`[Versions] Restarting on ${target.type === 'dev' ? 'the development version' : tag}.`);
    // Laisse aux sockets le temps d'écouler les deux messages ci-dessus
    // avant que le serveur ne se ferme sous eux.
    setTimeout(() => restartProcess(webServer, { entryPoint: target.entryPoint }), 250);
  } catch (err) {
    installInProgress = null;
    log.error(`[Versions] Failed to install ${tag}:`, err.message);
    broadcast(webServer, 'versionProgress', { phase: 'error', tag, message: err.message });
  }
}

/**
 * Retire du disque une version installée.
 *
 * Opération courte et sans redémarrage : elle n'a donc pas besoin du rapport
 * d'avancement de l'installation. Elle diffuse en revanche un catalogue frais à
 * tous les onglets, pour que l'entrée disparaisse de leur menu déroulant sans
 * qu'ils aient à le rouvrir.
 *
 * Les refus qui comptent — dépôt de développement, version en cours
 * d'exécution — sont prononcés par `versioning` lui-même ; ceux d'ici ne font
 * qu'éviter un travail inutile et rendre le message plus clair.
 */
async function handleUninstallVersion(ctx) {
  const { webServer, data } = ctx;

  const tag = String((data && data.tag) || '').trim();
  if (!tag) {
    return broadcast(webServer, 'versionRemoved', { tag, message: 'Aucune version sélectionnée.' });
  }

  if (installInProgress) {
    return broadcast(webServer, 'versionRemoved', {
      tag,
      message: `Une installation est en cours (${installInProgress}) : réessayez ensuite.`,
    });
  }

  if (tag === versioning.DEV_TAG) {
    return broadcast(webServer, 'versionRemoved', {
      tag,
      message: "La version de développement ne s'installe ni ne se désinstalle.",
    });
  }

  if (versioning.isCurrent(tag)) {
    return broadcast(webServer, 'versionRemoved', {
      tag,
      message: "Impossible de désinstaller la version en cours d'exécution.",
    });
  }

  try {
    versioning.uninstall(tag);
  } catch (err) {
    log.error(`[Versions] Failed to uninstall ${tag}:`, err.message);
    return broadcast(webServer, 'versionRemoved', { tag, message: err.message });
  }

  broadcast(webServer, 'versionRemoved', { tag, ok: true });

  try {
    const payload = await versioning.catalog();
    payload.installInProgress = installInProgress;
    broadcast(webServer, 'versionCatalog', payload);
  } catch (err) {
    // Le catalogue n'est qu'un rafraîchissement de confort : la
    // désinstallation, elle, a bien eu lieu et a déjà été annoncée.
    log.warn(`[Versions] Catalog unreadable after the uninstall: ${err.message}`);
  }
}

module.exports = {
  handleListVersions,
  handleInstallVersion,
  handleUninstallVersion,
};
