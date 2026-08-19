/**
 * Qualité d'import par piste : consultation depuis le menu contextuel d'un
 * élément de la file, de l'historique ou d'une playlist.
 *
 * Chaque handler reçoit le contexte assemblé par wsHandler :
 * { ws, data, webServer, player, queue, currentGuildId, dispatch }.
 */
const database = require('../../../database/Database');
const preloadManager = require('../../../audio/PreloadManager');
const log = require('../../../utils/logger');

/** Débits MP3 proposés dans l'interface, en kbps. */
const VALID_AUDIO_BITRATES = ['320', '256', '192', '128', '96'];
/** Hauteurs vidéo proposées dans l'interface, en pixels. */
const VALID_VIDEO_HEIGHTS = ['2160', '1440', '1080', '720', '480', '360'];

/**
 * Change la qualité audio et/ou vidéo retenue pour une piste.
 *
 * Deux effets distincts selon l'état du préchargement :
 * - piste absente du cache : seule la valeur souhaitée bouge, elle servira au
 *   prochain préchargement ;
 * - piste déjà en cache : une requalification est lancée en parallèle, l'ancien
 *   fichier continuant d'alimenter la lecture jusqu'à la bascule.
 *
 * La vidéo n'est jamais mise en cache — elle est résolue à chaque lecture — donc
 * un changement vidéo n'a pas d'équivalent à requalifier.
 */
function handleSetTrackQuality(ctx) {
    const { data, webServer, currentGuildId } = ctx;

    const { url, audio, video } = data;
    if (!url) return;

    const patch = {};
    if (audio !== undefined && VALID_AUDIO_BITRATES.includes(String(audio))) {
        patch.audio = String(audio);
    }
    if (video !== undefined && VALID_VIDEO_HEIGHTS.includes(String(video))) {
        patch.video = String(video);
    }
    if (Object.keys(patch).length === 0) return;

    const settings = database.getSettings(currentGuildId);
    database.setTrackQuality(url, patch, {
        audio: String(settings.importAudioQuality || '320'),
        video: String(settings.importVideoQuality || '720')
    });

    if (patch.audio) {
        try {
            // Objet minimal : startDownload réhydrate la piste via player.search
            // quand elle n'expose pas d'extracteur, comme pour les playlists.
            preloadManager.requalify({ url, title: data.title || url }, patch.audio);
        } catch (err) {
            log.error('[WebServer] Erreur de requalification du préchargement :', err.message);
        }
    }

    log.info(`[WebServer] Qualité de piste mise à jour (${Object.entries(patch).map(([k, v]) => `${k}=${v}`).join(', ')}) pour ${url}`);
    webServer.broadcastState(currentGuildId);
}

module.exports = {
    handleSetTrackQuality,
};
