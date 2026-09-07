/**
 * Qualité d'import et niveau sonore par piste : réglages du menu contextuel
 * d'un élément de la file, de l'historique ou d'une playlist.
 *
 * Chaque handler reçoit le contexte assemblé par wsHandler :
 * { ws, data, webServer, player, queue, currentGuildId, dispatch }.
 */
const database = require('../../../database/Database');
const preloadManager = require('../../../audio/PreloadManager');
const loudness = require('../../../audio/loudness');
const videoSource = require('../../../audio/videoSource');
const loudnessAnalyzer = require('../../../audio/LoudnessAnalyzer');
const { applyLoudness } = require('../../../audio/playbackSettings');
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
            log.error('[WebServer] Preload requalification error:', err.message);
        }
    }

    log.info(`[WebServer] Track quality updated (${Object.entries(patch).map(([k, v]) => `${k}=${v}`).join(', ')}) for ${url}`);
    webServer.broadcastState(currentGuildId);
}

/**
 * Change — ou retire — la cible de sonie d'une piste.
 *
 * Deux effets, dont le second est le moins évident : régler une piste alors que
 * la synchronisation globale est active *décroche* cette synchronisation. C'est
 * la seule lecture cohérente du geste. Synchroniser veut dire « toutes au même
 * niveau » ; en sortir une du rang, c'est dire qu'on ne veut plus de cet
 * alignement. Le réglage retomberait d'ailleurs sous la cible commune à la
 * trame suivante, et l'utilisateur verrait son curseur revenir tout seul.
 *
 * Les cibles individuelles, elles, n'ont jamais été effacées par la
 * synchronisation : chaque piste retrouve donc la sienne, et celle qu'on vient
 * de régler garde la nouvelle.
 */
function handleSetTrackLoudness(ctx) {
    const { data, webServer, queue, currentGuildId } = ctx;

    const { url } = data;
    if (!url) return;

    const settings = database.getSettings(currentGuildId);

    // « Valeur initiale » : la piste retrouve sa sonie d'origine, sans cible.
    const cleared = data.target === null || data.target === 'reset';
    const target = cleared ? null : loudness.clampTarget(data.target);

    if (!cleared && !Number.isFinite(target)) return;

    database.setTrackLoudnessTarget(url, target);

    if (settings.lufsSyncEnabled) {
        database.updateSettings(currentGuildId, { lufsSyncEnabled: false });
        log.info('[WebServer] LUFS synchronization released: a track was set by hand.');
    }

    applyLoudness(queue);

    // Une piste jamais mesurée n'a pas de gain à recevoir : la demande de
    // réglage vaut demande de mesure.
    loudnessAnalyzer.forget(url);
    loudnessAnalyzer.ensure(findTrack(ctx, url));

    log.info(`[WebServer] Track loudness ${cleared ? 'reset' : `set to ${target} LUFS`} for ${url}`);
    webServer.broadcastState(currentGuildId);
}

/**
 * Engage la mesure d'une piste, à l'ouverture de son menu de niveau.
 *
 * Le tableau de bord ne peut pas la déclencher lui-même : mesurer suppose de
 * lire le fichier, qui n'est que sur le disque du bot.
 */
function handleRequestTrackLoudness(ctx) {
    const { data, webServer, currentGuildId } = ctx;
    if (!data || !data.url) return;

    const track = findTrack(ctx, data.url);
    if (!track) return;

    // Une nouvelle demande vaut nouvelle chance : le fichier a pu arriver en
    // cache depuis l'échec précédent.
    loudnessAnalyzer.forget(data.url);
    if (loudnessAnalyzer.ensure(track)) webServer.broadcastState(currentGuildId);
}

/**
 * Retrouve une piste à partir de son URL, où qu'elle se trouve.
 *
 * Le menu de niveau s'ouvre aussi bien sur la lecture en cours que sur un
 * élément de la file, de l'historique ou d'une playlist ; l'analyse, elle, n'a
 * besoin que de l'URL, mais `ensure()` attend une piste — c'est elle qui porte
 * la clé de cache sous laquelle le fichier a été rangé.
 *
 * @param {object} ctx
 * @param {string} url
 * @returns {object|null}
 */
function findTrack(ctx, url) {
    const { queue } = ctx;
    if (!url) return null;

    const pools = [];
    if (queue) {
        if (queue.currentTrack) pools.push([queue.currentTrack]);
        try { pools.push(queue.tracks.toArray()); } catch (e) {}
        try { pools.push(queue.history.tracks.toArray()); } catch (e) {}
    }
    for (const playlist of database.getGlobalPlaylists()) {
        pools.push(playlist.tracks || []);
    }

    for (const pool of pools) {
        const found = (pool || []).find(t => t && t.url === url);
        if (found) return found;
    }

    // Introuvable dans l'état courant — une playlist qu'aucun serveur n'a
    // chargée, par exemple : l'URL suffit à la mesure, c'est elle qui donne le
    // chemin du fichier local comme la clé du cache.
    return { url, title: url };
}

/**
 * Dit quelles définitions et quel débit la source porte réellement.
 *
 * Le menu contextuel proposait les six définitions et les cinq débits sans
 * jamais savoir si le fichier existait dans aucun d'eux. Offrir du 4K sur une
 * vidéo mise en ligne en 720p n'est pas un choix, c'est une promesse qu'on ne
 * tient pas — et l'utilisateur ne le découvrait qu'au fichier obtenu.
 *
 * La piste est d'abord **pontée**. Une adresse Spotify ou Deezer ne porte aucun
 * flux : c'est la vidéo vers laquelle le bot la fait pointer qui en porte, et
 * c'est donc elle qu'il faut interroger. Le pont étant celui qu'emploie la
 * lecture, les définitions annoncées sont exactement celles qu'on obtiendra.
 *
 * L'appel prend une à trois secondes ; il ne part qu'à l'ouverture d'un
 * sous-menu, et son résultat est retenu dix minutes.
 */
async function handleRequestTrackFormats(ctx) {
    const { ws, data } = ctx;
    const url = data && typeof data.url === 'string' ? data.url.trim() : '';
    if (!url) return;

    const send = (payload) => {
        try {
            ws.send(JSON.stringify({ type: 'trackFormats', data: { url, ...payload } }));
        } catch (e) {
            // Socket fermée : le menu qui attendait n'existe plus non plus.
        }
    };

    // Un fichier du disque n'a qu'une forme, la sienne : rien à inventorier, et
    // l'interroger lancerait un processus pour rien.
    if (!/^https?:\/\//i.test(url)) {
        return send({ known: false, local: true, heights: [], audioKbps: null });
    }

    try {
        const playable = await preloadManager.resolvePlayableTrack({ url, title: url });
        const target = (playable && playable.url) ? playable.url : url;
        const found = await videoSource.inventory(target);
        send({ ...found, local: false });
    } catch (err) {
        // Rien trouvé n'est pas une erreur d'interface : le menu retombe alors
        // sur son comportement d'avant, qui propose tout.
        log.debug(`[Quality] No format list for ${url}: ${err.message}`);
        send({ known: false, local: false, heights: [], audioKbps: null });
    }
}

module.exports = {
    handleRequestTrackFormats,
    handleSetTrackQuality,
    handleSetTrackLoudness,
    handleRequestTrackLoudness,
};
