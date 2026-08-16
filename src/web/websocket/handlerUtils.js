/**
 * handlerUtils — Fonctions partagées par les handlers WebSocket.
 *
 * Ne contient que ce qui est propre aux handlers ; les utilitaires génériques
 * (comparaison de chemins, durées) vivent dans src/utils/.
 */

const database = require('../../database/Database');
const { getCleanFilename } = require('../../utils/paths');
const { readSetAsideQueue, writeSetAsideQueue } = require('../../utils/setAsideQueue');
const log = require('../../utils/logger');

/**
 * Recherche une piste en distinguant fichiers locaux et sources distantes,
 * avec repli youtube-dl pour YouTube Music et les albums non résolus.
 */
async function searchLocalAwareTrack(player, url) {
    const path = require('path');
    const fs = require('fs');
    const { QueryType } = require('discord-player');

    let isLocalFile = false;
    let queryTarget = url;
    try {
        if (typeof url === 'string' && url.includes('music.youtube.com')) {
            queryTarget = url.replace('music.youtube.com', 'www.youtube.com');
        } else {
            isLocalFile = fs.existsSync(path.resolve(url));
        }
    } catch (e) {
        // Pas un chemin local valide
    }

    let searchResult = await player.search(queryTarget, {
        requestedBy: null,
        ...(isLocalFile ? { searchEngine: QueryType.FILE } : {})
    });

    // Fallback pour YouTube Music & playlists d'albums (ex: OLAK5uy_...) non résolues par l'extracteur par défaut
    if ((!searchResult || !searchResult.tracks || searchResult.tracks.length === 0) && typeof url === 'string' && (url.includes('youtube') || url.includes('youtu.be'))) {
        try {
            const youtubedl = require('youtube-dl-exec');
            const info = await youtubedl(url, { dumpSingleJson: true, noCheckCertificates: true, noWarnings: true, flatPlaylist: true }, { windowsHide: true });
            const entries = Array.isArray(info.entries) ? info.entries : (info ? [info] : []);
            const resolvedTracks = [];
            for (const entry of entries) {
                const videoUrl = entry.url || entry.webpage_url || (entry.id ? `https://www.youtube.com/watch?v=${entry.id}` : null);
                if (videoUrl) {
                    const sr = await player.search(videoUrl, { requestedBy: null });
                    if (sr && sr.tracks && sr.tracks.length > 0) {
                        resolvedTracks.push(sr.tracks[0]);
                    }
                }
            }
            if (resolvedTracks.length > 0) {
                searchResult = {
                    tracks: resolvedTracks,
                    playlist: resolvedTracks.length > 1 ? { title: info.title || 'Playlist YouTube Music', tracks: resolvedTracks } : null
                };
            }
        } catch (e) {
            log.error('[YTM Fallback Error]:', e.message);
        }
    }

    // Restaurer le nom propre du fichier (sans le préfixe timestamp d'upload)
    if (isLocalFile && searchResult && searchResult.tracks && searchResult.tracks.length > 0) {
        searchResult.tracks[0].title = getCleanFilename(url);
    }

    return searchResult;
}

/**
 * Une playlist occupe-t-elle le lecteur ?
 *
 * Le lecteur n'a qu'une liste de pistes physique. Quand une playlist est la
 * source de lecture, c'est elle qui l'occupe, et la file d'attente de
 * l'utilisateur est mise de côté dans les réglages (voir
 * [setAsideQueue](../../utils/setAsideQueue.js)) — c'est d'ailleurs cette
 * sauvegarde que le tableau de bord affiche alors dans son panneau « file
 * d'attente ».
 *
 * @param {object} settings
 * @returns {boolean}
 */
function playlistEstLaSource(settings) {
    return !!settings.activePlaybackSource && settings.activePlaybackSource !== 'queue';
}

/**
 * Range des pistes dans la file d'attente pendant qu'une playlist joue.
 *
 * Ajouter à la file ne dit rien de ce qu'on veut écouter maintenant : la
 * playlist en cours poursuit sa lecture, et les pistes rejoignent la file mise
 * de côté, où l'utilisateur les retrouvera en y revenant. C'est la règle que
 * suivent déjà la suppression et le réordonnancement d'une piste de la file.
 *
 * @param {string} currentGuildId
 * @param {object} settings
 * @param {object|object[]} tracks - Piste(s) résolue(s)
 * @returns {boolean} true si les pistes ont été rangées — il n'y a alors rien
 *   à jouer, ni à ajouter au lecteur
 */
function ajouterALaFileEnAttente(currentGuildId, settings, tracks) {
    if (!playlistEstLaSource(settings)) return false;

    const aRanger = (Array.isArray(tracks) ? tracks : [tracks]).filter(t => t && t.url);
    if (aRanger.length === 0) return true;

    const versDonnees = (t) => ({
        title: t.title,
        author: t.author || 'Inconnu',
        duration: t.duration || '0:00',
        durationMS: t.durationMS || 0,
        thumbnail: t.thumbnail || null,
        url: t.url,
        queryType: t.queryType || 'youtube',
        extractorName: t.extractor?.identifier || t.extractorName || null
    });

    // Une seule liste, quel que soit le mode : rien n'y joue tant que la
    // playlist occupe le lecteur, et c'est au retour à la file que son premier
    // titre reprendra la lecture.
    const pistes = readSetAsideQueue(settings);
    aRanger.forEach(t => pistes.push(versDonnees(t)));
    writeSetAsideQueue(currentGuildId, pistes, settings);

    log.info(`[Queue] ${aRanger.length} piste(s) ajoutée(s) à la file d'attente ; `
        + 'la playlist en cours reste la source de lecture.');
    return true;
}

/**
 * Bascule la source de lecture sur la file d'attente et restaure la sauvegarde
 * correspondante lorsqu'une playlist était active.
 *
 * Réservé aux actions qui demandent explicitement d'écouter autre chose —
 * « Jouer maintenant ». Un simple ajout à la file ne doit pas y passer : voir
 * `ajouterALaFileEnAttente()`.
 */
function switchToQueueSourceIfNeeded(currentGuildId, queue, settings) {
    const oldSource = settings.activePlaybackSource || 'queue';
    if (oldSource !== 'queue') {
        const isPersonal = settings.broadcastMode === 'personal';

        database.updateSettings(currentGuildId, {
            activePlaybackSource: 'queue'
        });

        // La file mise de côté est une simple liste : c'est ici, au moment de
        // reprendre, que son premier titre redevient la piste courante.
        const misDeCote = readSetAsideQueue(settings);

        if (isPersonal) {
            if (queue && misDeCote.length > 0) {
                const [premiere, ...suite] = misDeCote;
                queue.virtualCurrentTrack = premiere;
                queue.virtualTracks = suite;
                queue.virtualProgressMs = 0;
                queue.virtualIsPlaying = true;
                queue.virtualIsPaused = false;
            }
        } else {
            if (queue && misDeCote.length > 0) {
                const { Track, useMainPlayer } = require('discord-player');
                const player = useMainPlayer();
                queue.tracks.clear();
                const resolved = misDeCote.map(t => {
                    const track = new Track(player, {
                        title: t.title,
                        author: t.author || 'Inconnu',
                        duration: t.duration || '0:00',
                        thumbnail: t.thumbnail || null,
                        url: t.url,
                        queryType: t.queryType || 'youtube',
                        raw: {}
                    });
                    if (t.extractorName) {
                        track.extractor = player.extractors.store.get(t.extractorName) || null;
                    }
                    return track;
                });
                queue.addTrack(resolved);
            }
        }
    }
}

module.exports = {
    searchLocalAwareTrack,
    playlistEstLaSource,
    ajouterALaFileEnAttente,
    switchToQueueSourceIfNeeded,
};
