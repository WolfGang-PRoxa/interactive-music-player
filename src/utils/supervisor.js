/**
 * supervisor — Le bot tourne-t-il sous la garde de l'application de bureau ?
 *
 * Hors application, le bot se redémarre seul : il lance une nouvelle instance
 * détachée, puis sort (voir `systemHandlers.restartProcess`). Sous
 * l'application (desktop/), une instance détachée échapperait à sa
 * surveillance : l'application la croirait morte, et n'aurait plus de prise
 * sur elle pour l'éteindre avec la fenêtre.
 *
 * L'application pose donc `IMP_SUPERVISOR=desktop` dans l'environnement du bot.
 * Le bot y dépose alors le point d'entrée voulu dans
 * `data/desktop-restart.json`, puis sort avec le code 75 ; c'est l'application
 * qui relance, avec `IMP_RESTART=1` comme le faisait le bot lui-même. Le
 * contrat est lu de l'autre côté par `desktop/src-tauri/src/supervisor.rs`.
 *
 * Le code 75 est EX_TEMPFAIL de sysexits.h : « réessayez ». Il ne se confond
 * avec aucune sortie du bot — 0 pour une extinction, 1 pour une erreur fatale.
 */

const fs = require('fs');
const path = require('path');

const RESTART_EXIT_CODE = 75;
const RESTART_REQUEST = 'desktop-restart.json';

function isSupervised(env = process.env) {
  return env.IMP_SUPERVISOR === 'desktop';
}

/**
 * Dépose la demande de relance pour l'application.
 *
 * Le chemin est écrit tel quel : l'application vérifie elle-même qu'il désigne
 * bien un bot avant de le lancer, et retombe sur l'instance courante sinon.
 *
 * @param {string} entryPoint - Script de la prochaine instance
 * @param {string} [root] - Racine partagée, `process.cwd()` par défaut
 * @returns {string} Le fichier écrit
 */
function writeRestartRequest(entryPoint, root = process.cwd()) {
  const dir = path.join(root, 'data');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, RESTART_REQUEST);
  fs.writeFileSync(file, JSON.stringify({ entryPoint: path.resolve(entryPoint) }, null, 2));
  return file;
}

module.exports = {
  RESTART_EXIT_CODE,
  RESTART_REQUEST,
  isSupervised,
  writeRestartRequest,
};
