/**
 * Réglages de lecture applicables au son en cours — vitesse et effets de mix.
 *
 * Ces deux réglages sont les seuls que le bus de mixage n'a pas pu reprendre
 * derrière un simple pont de méthode : ils passaient par la chaîne de filtres
 * FFmpeg de discord-player, que le bus ne monte plus. Les rassembler ici évite
 * que chaque site d'appel — gestionnaire WebSocket, démarrage de piste — ait à
 * savoir quel chemin audio est en vigueur.
 */

const { moteurActif } = require('./mix');
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
function appliquerVitesse(queue, vitesse) {
    if (!queue) return;

    const moteur = moteurActif(queue);
    if (moteur) {
        const valeur = parseFloat(vitesse) || 1;
        moteur.appliquerVitesse(valeur).catch((err) => {
            log.error('[ReglagesLecture] Changement de vitesse impossible :', err.message);
        });
        return;
    }

    try {
        const actifs = queue.filters.ffmpeg.getFiltersEnabled();
        const sansVitesse = actifs.filter(f => !f.startsWith('speed_'));

        const arrondie = Math.round((parseFloat(vitesse) || 1) * 100) / 100;
        const filtre = `speed_${String(arrondie).replace('.', '_')}`;
        if (filtre !== 'speed_1' && filtre !== 'speed_1_0' && filtre !== 'speed_1_00') {
            sansVitesse.push(filtre);
        }
        queue.filters.ffmpeg.setFilters(sansVitesse);
    } catch (err) {
        log.error('[ReglagesLecture] Erreur d\'application du filtre de vitesse :', err.message);
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
function annulerEffetsMix(queue) {
    if (!queue) return;

    const moteur = moteurActif(queue);
    if (moteur) {
        moteur.annulerEnchainement();
        return;
    }

    try {
        const actifs = queue.filters.ffmpeg.getFiltersEnabled();
        queue.filters.ffmpeg.setFilters(actifs.filter(f => f !== 'muffled'));
    } catch (err) {
        // Aucune chaîne de filtres montée : il n'y a rien à retirer
    }
}

module.exports = { appliquerVitesse, annulerEffetsMix };
