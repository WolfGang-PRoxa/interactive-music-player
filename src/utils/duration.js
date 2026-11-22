/**
 * duration — Conversion et formatage des durées de piste.
 *
 * Ces fonctions existaient en quatre exemplaires légèrement différents
 * (deux dans WebServer, dont une paire masquant l'autre par portée, plus une
 * dans le traitement des uploads). Les variantes retenues ici sont les plus
 * défensives : elles couvrent strictement les cas des versions qu'elles
 * remplacent.
 */

/**
 * Formate une durée en `m:ss`, ou `h:mm:ss` au-delà d'une heure.
 *
 * Une même implémentation sert l'affichage de progression et la durée des
 * pistes importées : un film de 90 minutes s'affiche « 1:30:00 » partout.
 *
 * Le pendant côté client se trouve dans public/js/player.js et doit rester
 * aligné : c'est lui qui rend la timeline à partir des millisecondes.
 *
 * @param {number} ms
 * @returns {string}
 */
function formatMs(ms) {
  // Aligné sur js/player.js : l'infini n'est pas une durée qu'on écrit.
  if (!Number.isFinite(ms) || ms <= 0) return '0:00';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const paddedSeconds = seconds.toString().padStart(2, '0');
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${paddedSeconds}`;
  }
  return `${minutes}:${paddedSeconds}`;
}

/**
 * Convertit une durée textuelle (`ss`, `m:ss` ou `h:mm:ss`) en millisecondes.
 * @param {string} durationStr
 * @returns {number} 0 si le format est inexploitable
 */
function parseDurationToMs(durationStr) {
  if (!durationStr) return 0;
  const parts = durationStr.split(':').map(Number);
  if (parts.length === 3) {
    return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
  } else if (parts.length === 2) {
    return (parts[0] * 60 + parts[1]) * 1000;
  } else if (parts.length === 1) {
    return parts[0] * 1000;
  }
  return 0;
}

module.exports = {
  formatMs,
  parseDurationToMs,
};
