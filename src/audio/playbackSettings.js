/**
 * Réglages de lecture applicables au son en cours — vitesse et effets de mix.
 *
 * Ces deux réglages sont les seuls que le bus de mixage n'a pas pu reprendre
 * derrière un simple pont de méthode : ils passaient par la chaîne de filtres
 * FFmpeg de discord-player, que le bus ne monte plus. Les rassembler ici évite
 * que chaque site d'appel — gestionnaire WebSocket, démarrage de piste — ait à
 * savoir quel chemin audio est en vigueur.
 */

const { activeEngine } = require('./mix');
const log = require('../utils/logger');

/**
 * Applique une vitesse de lecture au morceau en cours.
 *
 * Sur le bus, la vitesse est celle du décodeur : le changer relance FFmpeg à la
 * position atteinte. Sur la chaîne de discord-player, elle passe par les
 * filtres `speed_*` déclarés au démarrage du bot.
 *
 * @param {import('discord-player').GuildQueue} queue
 * @param {number|string} vitesse
 */
function applySpeed(queue, speed) {
  if (!queue) return;

  const engine = activeEngine(queue);
  if (engine) {
    const value = parseFloat(speed) || 1;
    engine.applySpeed(value).catch((err) => {
      log.error('[PlaybackSettings] Speed change impossible:', err.message);
    });
    return;
  }

  try {
    const enabledFilters = queue.filters.ffmpeg.getFiltersEnabled();
    const withoutSpeed = enabledFilters.filter((f) => !f.startsWith('speed_'));

    const rounded = Math.round((parseFloat(speed) || 1) * 100) / 100;
    const filter = `speed_${String(rounded).replace('.', '_')}`;
    if (filter !== 'speed_1' && filter !== 'speed_1_0' && filter !== 'speed_1_00') {
      withoutSpeed.push(filter);
    }
    queue.filters.ffmpeg.setFilters(withoutSpeed);
  } catch (err) {
    log.error('[PlaybackSettings] Error applying the speed filter:', err.message);
  }
}

/**
 * Rend au morceau en cours son timbre et son niveau nominaux.
 *
 * Appelé quand l'enchaînement mix est désactivé alors qu'il était peut-être en
 * train d'agir : sans cela, un morceau resterait étouffé ou à mi-volume pour le
 * reste de sa durée.
 *
 * @param {import('discord-player').GuildQueue} queue
 */
function cancelMixEffects(queue) {
  if (!queue) return;

  const engine = activeEngine(queue);
  if (engine) {
    engine.cancelCrossfade();
    return;
  }

  try {
    const enabledFilters = queue.filters.ffmpeg.getFiltersEnabled();
    queue.filters.ffmpeg.setFilters(enabledFilters.filter((f) => f !== 'muffled'));
  } catch (err) {
    // Aucune chaîne de filtres montée : il n'y a rien à retirer
  }
}

/**
 * Réaligne le niveau sonore du morceau en cours sur les réglages courants.
 *
 * Sans effet hors du bus de mixage : la chaîne de discord-player passe son gain
 * à FFmpeg, qu'il faudrait relancer pour le changer — donc rompre le flux, là
 * où ce réglage doit s'entendre pendant qu'on déplace le curseur. En diffusion
 * personnelle, c'est le navigateur qui applique le gain, sur les mêmes valeurs
 * reçues dans l'état.
 *
 * @param {import('discord-player').GuildQueue} queue
 */
function applyLoudness(queue) {
  if (!queue) return;

  const engine = activeEngine(queue);
  if (!engine) return;

  try {
    engine.applyLoudness();
  } catch (err) {
    log.error('[PlaybackSettings] Loudness change impossible:', err.message);
  }
}

module.exports = { applySpeed, cancelMixEffects, applyLoudness };
