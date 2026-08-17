const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const database = require('../../database/Database');
const preloadManager = require('../../audio/PreloadManager');
const { resolveMediaPath, isAllowedMediaFilename } = require('../../utils/mediaPaths');
const { arePathsOrUrlsEqual } = require('../../utils/paths');
const log = require('../../utils/logger');

/** Taille maximale d'un fichier uploadé (Mo). */
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 1024;

/**
 * Dossier `docs/` de la **version en cours d'exécution**.
 *
 * Résolu depuis `__dirname` et non depuis `process.cwd()` : sur une release
 * installée, la documentation lue dans le tableau de bord doit être celle de la
 * version qui tourne, pas celle du dépôt qui l'héberge.
 */
const DOSSIER_DOCS = path.resolve(__dirname, '..', '..', '..', 'docs');

/** Profondeur d'exploration : `docs/` et ses sous-dossiers immédiats. */
const PROFONDEUR_DOCS = 2;

const MIME_TYPES = {
    mp4: 'video/mp4',
    webm: 'video/webm',
    mkv: 'video/x-matroska',
    avi: 'video/x-msvideo',
    mov: 'video/quicktime',
    flv: 'video/x-flv',
    m4v: 'video/x-m4v',
    '3gp': 'video/3gpp',
    ogv: 'video/ogg',
    wmv: 'video/x-ms-wmv',
    mp3: 'audio/mpeg',
    flac: 'audio/flac',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    m4a: 'audio/mp4',
};

function mimeFor(filePath) {
    return MIME_TYPES[path.extname(filePath).slice(1).toLowerCase()] || 'application/octet-stream';
}

/**
 * Analyse un en-tête Range.
 * @returns {{start: number, end: number}|{invalid: true}|null} null si absent ou illisible
 */
function parseRange(rangeHeader, size) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader || '').trim());
    if (!m) return null;

    const [, debutBrut, finBrut] = m;
    if (debutBrut === '' && finBrut === '') return null;

    let start;
    let end;
    if (debutBrut === '') {
        // Forme suffixe : les N derniers octets
        const n = parseInt(finBrut, 10);
        if (!Number.isFinite(n) || n <= 0) return null;
        start = Math.max(0, size - n);
        end = size - 1;
    } else {
        start = parseInt(debutBrut, 10);
        end = finBrut === '' ? size - 1 : parseInt(finBrut, 10);
    }

    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    if (start >= size || start > end) return { invalid: true };

    return { start, end: Math.min(end, size - 1) };
}

/**
 * Sert un fichier en honorant les requêtes Range.
 *
 * Indispensable au déplacement dans la piste : sans réponse 206, le navigateur
 * doit télécharger depuis le début pour atteindre la position demandée. C'est
 * ce qui retardait la reprise de lecture au rechargement du tableau de bord.
 */
function serveFileWithRange(req, res, filePath, contentType) {
    const stat = fs.statSync(filePath);
    const range = parseRange(req.headers.range, stat.size);

    if (range && range.invalid) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        return res.end();
    }

    if (range) {
        res.writeHead(206, {
            'Content-Range': `bytes ${range.start}-${range.end}/${stat.size}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': range.end - range.start + 1,
            'Content-Type': contentType,
        });
        fs.createReadStream(filePath, { start: range.start, end: range.end }).pipe(res);
        return;
    }

    res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': stat.size,
        'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(filePath).pipe(res);
}

/**
 * Résout la piste ciblée par une requête /stream ou /download.
 *
 * Un chemin disque n'est retenu que s'il passe le garde-fou mediaPaths ; une
 * valeur qui désigne un fichier hors des racines autorisées est ignorée, et la
 * recherche se poursuit sur les pistes réellement connues du lecteur.
 *
 * @param {string|undefined} trackUrl - Paramètre brut reçu du client
 * @param {object|null} queue - Queue discord-player de la guild
 * @returns {object|null}
 */
function findTrackForRequest(trackUrl, queue) {
    if (trackUrl) {
        const safePath = resolveMediaPath(trackUrl);
        if (safePath) {
            return { url: safePath, queryType: 'file', title: path.basename(safePath) };
        }

        let decodedUrl = trackUrl;
        try {
            decodedUrl = decodeURIComponent(trackUrl);
        } catch (e) {
            // Séquence d'échappement invalide : on compare la valeur brute
        }

        if (queue) {
            if (queue.virtualCurrentTrack && arePathsOrUrlsEqual(queue.virtualCurrentTrack.url, decodedUrl)) {
                return queue.virtualCurrentTrack;
            }
            if (queue.currentTrack && arePathsOrUrlsEqual(queue.currentTrack.url, decodedUrl)) {
                return queue.currentTrack;
            }

            const pools = [
                queue.virtualTracks,
                Array.isArray(queue.tracks) ? queue.tracks : queue.tracks?.data,
                queue.virtualHistory,
            ];
            for (const pool of pools) {
                if (!Array.isArray(pool)) continue;
                const found = pool.find(t => arePathsOrUrlsEqual(t.url, decodedUrl));
                if (found) return found;
            }
        }
    }

    if (queue) {
        return queue.virtualCurrentTrack || queue.currentTrack || null;
    }
    return null;
}

/**
 * Titre lisible d'un document : son premier titre de niveau 1, à défaut son nom
 * de fichier. Seul le début est lu — le titre d'un Markdown bien tenu s'y
 * trouve, et il n'y a pas de raison de charger 20 Ko pour l'apprendre.
 */
function titreDocument(chemin, secours) {
    let debut;
    try {
        const tampon = Buffer.alloc(2048);
        const fd = fs.openSync(chemin, 'r');
        try {
            const lus = fs.readSync(fd, tampon, 0, tampon.length, 0);
            debut = tampon.slice(0, lus).toString('utf8');
        } finally {
            fs.closeSync(fd);
        }
    } catch (e) {
        return secours;
    }

    const titre = /^#\s+(.+)$/m.exec(debut);
    return titre ? titre[1].trim() : secours;
}

/**
 * Inventaire des documents Markdown livrés avec le bot.
 *
 * L'inventaire est reconstruit à chaque appel : la documentation d'une version
 * installée ne bouge pas, mais celle du dépôt de développement s'écrit pendant
 * que le bot tourne, et le lecteur doit pouvoir la relire sans redémarrage.
 *
 * Les identifiants renvoyés sont des chemins relatifs à `docs/`. Ils forment la
 * liste blanche du service de contenu : aucune valeur venue du client n'est
 * jamais assemblée en chemin de fichier.
 *
 * @returns {Array<{id: string, titre: string, groupe: string, octets: number}>}
 */
function inventaireDocs() {
    const trouves = [];

    const explorer = (dossier, prefixe, profondeur) => {
        let entrees;
        try {
            entrees = fs.readdirSync(dossier, { withFileTypes: true });
        } catch (e) {
            return;
        }

        for (const entree of entrees) {
            if (entree.name.startsWith('.')) continue;
            const complet = path.join(dossier, entree.name);

            if (entree.isDirectory()) {
                if (profondeur > 1) explorer(complet, `${prefixe}${entree.name}/`, profondeur - 1);
                continue;
            }
            if (!/\.md$/i.test(entree.name)) continue;

            let octets = 0;
            try {
                octets = fs.statSync(complet).size;
            } catch (e) {}

            trouves.push({
                id: `${prefixe}${entree.name}`,
                titre: titreDocument(complet, entree.name.replace(/\.md$/i, '')),
                groupe: prefixe ? prefixe.replace(/\/$/, '') : '',
                octets,
            });
        }
    };

    explorer(DOSSIER_DOCS, '', PROFONDEUR_DOCS);

    // Racine avant sous-dossiers, et `README` en tête de son groupe : c'est
    // l'ordre dans lequel la documentation se lit, pas l'ordre alphabétique où
    // le sommaire d'un dossier atterrit après les chapitres qu'il annonce.
    const rang = (doc) => {
        if (!doc.groupe) return 0;
        return /(^|\/)README\.md$/i.test(doc.id) ? 1 : 2;
    };

    return trouves.sort((a, b) => {
        if (a.groupe !== b.groupe) return a.groupe.localeCompare(b.groupe);
        const ecart = rang(a) - rang(b);
        if (ecart !== 0) return ecart;
        return a.id.localeCompare(b.id, 'fr', { numeric: true });
    });
}

/** Hauteurs vidéo proposées dans l'interface, en pixels. */
const HAUTEURS_VIDEO_VALIDES = ['2160', '1440', '1080', '720', '480', '360'];
const HAUTEUR_VIDEO_DEFAUT = 720;

/**
 * Hauteur vidéo cible.
 *
 * La qualité figée sur la piste prime, comme pour l'audio ; le réglage « Vidéo »
 * de la box d'ajout ne sert que de repli. Contrairement à l'audio, la vidéo
 * n'est jamais mise en cache : la valeur est donc appliquée à chaque lecture,
 * et un changement prend effet au prochain démarrage du flux.
 *
 * @param {string|null} guildId
 * @param {object|null} [track]
 * @returns {number}
 */
function resolveVideoHeight(guildId, track = null) {
    try {
        const parPiste = String(database.getTrackQuality(track?.url)?.video || '');
        if (HAUTEURS_VIDEO_VALIDES.includes(parPiste)) return Number(parPiste);
    } catch (e) {}

    if (!guildId) return HAUTEUR_VIDEO_DEFAUT;
    try {
        const choix = String(database.getSettings(guildId).importVideoQuality || '');
        return HAUTEURS_VIDEO_VALIDES.includes(choix) ? Number(choix) : HAUTEUR_VIDEO_DEFAUT;
    } catch (e) {
        return HAUTEUR_VIDEO_DEFAUT;
    }
}

/**
 * Classe un codec vidéo par sa fiabilité de décodage dans un <video> alimenté
 * par une URL directe.
 *
 * H.264 est lu partout ; VP9 l'est très largement ; AV1 dépend du matériel et
 * échoue silencieusement sur nombre de configurations — la fenêtre n'affiche
 * alors que quelques images figées. Le rang sert à écarter ces flux plutôt
 * qu'à les servir en espérant qu'ils passent.
 *
 * @param {object} format
 * @returns {number} 0 = le plus sûr
 */
function rangCodec(format) {
    const codec = String(format?.vcodec || '').toLowerCase();
    if (codec.startsWith('avc') || codec.startsWith('h264')) return 0;
    if (codec.startsWith('vp9') || codec.startsWith('vp09')) return 1;
    if (codec.startsWith('av01') || codec.startsWith('av1')) return 3;
    if (codec.startsWith('vp8')) return 2;
    return 2;
}

/** Au-delà de ce rang, le flux est jugé trop incertain pour être servi tel quel. */
const RANG_CODEC_MAX = 2;

/**
 * Choisit le format vidéo le plus proche de la hauteur demandée, parmi ceux
 * que le navigateur sait effectivement décoder.
 *
 * La compatibilité prime sur la définition : YouTube ne propose H.264 que
 * jusqu'à 1080p, et réserve le 1440p/2160p à VP9 et AV1. Demander du 4K sur une
 * vidéo qui n'en a qu'en AV1 doit donc donner un 1080p qui s'affiche, pas un
 * 2160p qui reste figé.
 *
 * À définition égale, on retient le codec le plus sûr puis le débit le plus
 * élevé.
 *
 * @param {object[]} formats
 * @param {number} hauteurCible
 * @returns {object}
 */
function pickVideoFormat(formats, hauteurCible) {
    const avecHauteur = formats.filter(f => typeof f.height === 'number' && f.height > 0);
    if (avecHauteur.length === 0) return formats[0];

    // On ne considère que les codecs sûrs tant qu'il en reste ; sinon il vaut
    // mieux tenter un AV1 que ne rien renvoyer du tout.
    const surs = avecHauteur.filter(f => rangCodec(f) <= RANG_CODEC_MAX);
    const candidats = surs.length > 0 ? surs : avecHauteur;

    const hauteurs = [...new Set(candidats.map(f => f.height))];
    let hauteurRetenue;

    if (hauteurs.includes(hauteurCible)) {
        hauteurRetenue = hauteurCible;
    } else {
        const enDessous = hauteurs.filter(h => h < hauteurCible).sort((a, b) => b - a);
        hauteurRetenue = enDessous.length > 0
            ? enDessous[0]
            : hauteurs.sort((a, b) => a - b)[0];
    }

    return candidats
        .filter(f => f.height === hauteurRetenue)
        .sort((a, b) => (rangCodec(a) - rangCodec(b)) || ((b.tbr || 0) - (a.tbr || 0)))[0];
}

function createApiRouter(webServer) {
    /**
     * Version en cours d'exécution.
     *
     * Servie en HTTP plutôt que dans l'état WebSocket : elle ne change pas de
     * la vie du process, et le pied du tiroir doit pouvoir l'afficher sans
     * attendre qu'un serveur Discord soit sélectionné.
     */
    router.get('/version', (req, res) => {
        const versioning = require('../../versioning');
        const courante = versioning.versionCourante();
        res.json({
            type: courante.type,
            tag: courante.tag,
            versionPackage: courante.versionPackage,
        });
    });

    /**
     * Nombre de tableaux de bord actuellement connectés.
     *
     * Seul le serveur sait si une page est ouverte quelque part : le compte des
     * clients WebSocket est le même signal que celui utilisé au démarrage pour
     * décider d'ouvrir ou non le navigateur (voir WebServer.start). Il est
     * exposé ici pour que la fenêtre de lancement (tools/start-bot.ps1) puisse
     * poser la question avant d'ouvrir un onglet de plus.
     *
     * Un onglet dont la WebSocket est tombée n'est pas compté : c'est la même
     * approximation que celle du démarrage, et elle penche du bon côté — au
     * pire on ouvre un onglet, jamais on n'en cache un vivant.
     */
    router.get('/clients', (req, res) => {
        res.json({ count: webServer.wss ? webServer.wss.clients.size : 0 });
    });

    /**
     * Sommaire de la documentation embarquée, pour le lecteur du tableau de
     * bord (voir js/docs.js).
     */
    router.get('/docs', (req, res) => {
        res.json({ documents: inventaireDocs() });
    });

    /**
     * Source Markdown d'un document.
     *
     * L'identifiant demandé n'est pas transformé en chemin : il est cherché
     * dans l'inventaire, et c'est le chemin que le serveur a lui-même construit
     * en parcourant `docs/` qui est ouvert. Une remontée de dossier n'a donc
     * rien à contourner — elle ne correspond simplement à aucune entrée.
     */
    router.get('/docs/contenu', (req, res) => {
        const demande = String(req.query.id || '');
        const document = inventaireDocs().find((d) => d.id === demande);
        if (!document) return res.status(404).json({ error: 'Document introuvable' });

        const chemin = path.join(DOSSIER_DOCS, ...document.id.split('/'));
        let source;
        try {
            source = fs.readFileSync(chemin, 'utf8');
        } catch (err) {
            log.error(`[WebServer Docs] Lecture impossible pour ${document.id} :`, err.message);
            return res.status(500).json({ error: 'Document illisible' });
        }

        res.json({ id: document.id, titre: document.titre, groupe: document.groupe, source });
    });

    router.get('/state', (req, res) => {
        let targetGuildId = null;
        // Nommé `defaultChannelId` tant qu'il portait le salon favori. Il porte
        // désormais le salon courant, ce qui n'est pas la même chose : le favori
        // n'est plus lu qu'au démarrage du bot, où il devient précisément ce
        // salon courant. Le relire ici le ferait primer sur toute sélection
        // ultérieure — un tableau de bord ne pourrait plus en changer.
        let salonCourantId = null;

        // Le dernier salon visité, comme à l'ouverture d'un tableau de bord
        // (cf. `WebServer._initClient`).
        const lastChannelInfo = database.getLastVoiceChannel();
        if (lastChannelInfo.guildId && lastChannelInfo.channelId) {
            const guild = webServer.client.guilds.cache.get(lastChannelInfo.guildId);
            if (guild && guild.channels.cache.has(lastChannelInfo.channelId)) {
                targetGuildId = lastChannelInfo.guildId;
                salonCourantId = lastChannelInfo.channelId;
            }
        }

        if (!targetGuildId) {
            targetGuildId = webServer._getFirstGuildId();
        }

        if (!targetGuildId) return res.status(400).json({ error: 'Bot non connecté aux serveurs Discord' });
        res.json(webServer.getState(targetGuildId, salonCourantId));
    });

    router.get('/stream', async (req, res) => {
        const { guildId, trackUrl } = req.query;
        const targetGuildId = guildId || webServer._getFirstGuildId();
        if (!targetGuildId) return res.status(400).send('Guild ID requis');

        const { useMainPlayer } = require('discord-player');
        const player = useMainPlayer();
        const queue = player.queues.get(targetGuildId);

        const track = findTrackForRequest(trackUrl, queue);

        if (!track) {
            return res.status(404).send('Piste introuvable pour le stream');
        }

        if (!req.headers.range || req.headers.range.startsWith('bytes=0-')) {
            log.info(`[WebServer Stream] Démarrage du stream pour: ${track.title}`);
        }

        // Si la piste est déjà dans le cache de préchargement
        const cachedPath = preloadManager.getCachedPath(track);
        if (cachedPath) {
            try {
                serveFileWithRange(req, res, cachedPath, 'audio/mpeg');
            } catch (err) {
                log.error('[WebServer Stream] Erreur lecture fichier cache de préchargement:', err.message);
                res.status(500).send(err.message);
            }
            return;
        }
        // Si c'est un fichier local : servi uniquement s'il est sous une racine autorisée
        const localPath = resolveMediaPath(track.url);
        if (localPath) {
            try {
                serveFileWithRange(req, res, localPath, mimeFor(localPath));
            } catch (err) {
                log.error('[WebServer Stream] Erreur lecture fichier local:', err.message);
                res.status(500).send(err.message);
            }
            return;
        }

        // La piste désigne un fichier disque, mais hors des racines autorisées.
        if (track.queryType === 'file' || !/^https?:\/\//i.test(track.url || '')) {
            log.warn(`[WebServer Stream] Accès refusé, chemin hors racines autorisées : ${track.url}`);
            return res.status(403).send('Chemin de fichier non autorisé');
        }

        // Si c'est un flux distant (YouTube, etc.)
        if (!track.extractor) {
            for (const [_, ext] of player.extractors.store.entries()) {
                try {
                    if (await ext.validate(track.url, track.queryType)) {
                        track.extractor = ext;
                        log.info(`[WebServer Stream] Extractor résolu dynamiquement pour ${track.title} : ${ext.constructor.name}`);
                        break;
                    }
                } catch (e) {}
            }
        }

        if (track.extractor) {
            try {
                let stream = null;
                if (typeof track.extractor.stream === 'function') {
                    stream = await track.extractor.stream(track);
                } else if (typeof track.extractor.bridge === 'function') {
                    stream = await track.extractor.bridge(track);
                } else if (typeof track.extractor.getStream === 'function') {
                    stream = await track.extractor.getStream(track);
                } else if (player && typeof player.extractors.stream === 'function') {
                    stream = await player.extractors.stream(track);
                }
                if (stream) {
                    const cp = require('child_process');
                    const ffmpeg = require('ffmpeg-static');

                    const ffmpegProcess = cp.spawn(ffmpeg, [
                        '-i', 'pipe:0',
                        '-acodec', 'libmp3lame',
                        '-ab', '128k',
                        '-f', 'mp3',
                        'pipe:1'
                    ], {
                        stdio: ['pipe', 'pipe', 'ignore'],
                        windowsHide: true
                    });

                    res.writeHead(200, {
                        'Content-Type': 'audio/mpeg',
                        'Transfer-Encoding': 'chunked'
                    });

                    stream.pipe(ffmpegProcess.stdin);
                    ffmpegProcess.stdout.pipe(res);

                    req.on('close', () => {
                        try {
                            ffmpegProcess.kill();
                        } catch (e) {}
                        try {
                            stream.destroy();
                        } catch (e) {}
                    });
                    return;
                }
            } catch (err) {
                log.error('[WebServer Stream] Erreur extraction/transcodage flux distant:', err.message);
                res.status(500).send(err.message);
                return;
            }
        }

        res.status(400).send('Format non supporté pour le stream personnel');
    });

    router.get('/download', async (req, res) => {
        const { guildId, trackUrl, format: reqFormat } = req.query;
        const targetGuildId = guildId || webServer._getFirstGuildId();
        if (!targetGuildId) return res.status(400).send('Guild ID requis');

        const { useMainPlayer } = require('discord-player');
        const player = useMainPlayer();
        const queue = player.queues.get(targetGuildId);

        const track = findTrackForRequest(trackUrl, queue);

        if (!track) {
            return res.status(404).send('Piste introuvable pour le téléchargement');
        }

        const formatMap = {
            // MP3
            'mp3': { mime: 'audio/mpeg', ext: 'mp3', ffmpegArgs: ['-acodec', 'libmp3lame', '-ab', '320k', '-f', 'mp3'] },
            'mp3_320': { mime: 'audio/mpeg', ext: 'mp3', ffmpegArgs: ['-acodec', 'libmp3lame', '-ab', '320k', '-f', 'mp3'] },
            'mp3_192': { mime: 'audio/mpeg', ext: 'mp3', ffmpegArgs: ['-acodec', 'libmp3lame', '-ab', '192k', '-f', 'mp3'] },
            'mp3_128': { mime: 'audio/mpeg', ext: 'mp3', ffmpegArgs: ['-acodec', 'libmp3lame', '-ab', '128k', '-f', 'mp3'] },
            // M4A
            'm4a': { mime: 'audio/mp4', ext: 'm4a', ffmpegArgs: ['-acodec', 'aac', '-ab', '192k', '-f', 'ipod'] },
            'm4a_320': { mime: 'audio/mp4', ext: 'm4a', ffmpegArgs: ['-acodec', 'aac', '-ab', '320k', '-f', 'ipod'] },
            'm4a_192': { mime: 'audio/mp4', ext: 'm4a', ffmpegArgs: ['-acodec', 'aac', '-ab', '192k', '-f', 'ipod'] },
            'm4a_128': { mime: 'audio/mp4', ext: 'm4a', ffmpegArgs: ['-acodec', 'aac', '-ab', '128k', '-f', 'ipod'] },
            // FLAC
            'flac': { mime: 'audio/flac', ext: 'flac', ffmpegArgs: ['-acodec', 'flac', '-f', 'flac'] },
            'flac_high': { mime: 'audio/flac', ext: 'flac', ffmpegArgs: ['-acodec', 'flac', '-sample_fmt', 's32', '-ar', '96000', '-f', 'flac'] },
            'flac_medium': { mime: 'audio/flac', ext: 'flac', ffmpegArgs: ['-acodec', 'flac', '-sample_fmt', 's16', '-ar', '44100', '-f', 'flac'] },
            'flac_low': { mime: 'audio/flac', ext: 'flac', ffmpegArgs: ['-acodec', 'flac', '-sample_fmt', 's16', '-ar', '22050', '-f', 'flac'] },
            // WAV
            'wav': { mime: 'audio/wav', ext: 'wav', ffmpegArgs: ['-acodec', 'pcm_s16le', '-f', 'wav'] },
            'wav_high': { mime: 'audio/wav', ext: 'wav', ffmpegArgs: ['-acodec', 'pcm_s24le', '-ar', '96000', '-f', 'wav'] },
            'wav_medium': { mime: 'audio/wav', ext: 'wav', ffmpegArgs: ['-acodec', 'pcm_s16le', '-ar', '44100', '-f', 'wav'] },
            'wav_low': { mime: 'audio/wav', ext: 'wav', ffmpegArgs: ['-acodec', 'pcm_u8', '-ar', '22050', '-f', 'wav'] },
            // OGG
            'ogg': { mime: 'audio/ogg', ext: 'ogg', ffmpegArgs: ['-acodec', 'libvorbis', '-ab', '192k', '-f', 'ogg'] },
            'ogg_320': { mime: 'audio/ogg', ext: 'ogg', ffmpegArgs: ['-acodec', 'libvorbis', '-ab', '320k', '-f', 'ogg'] },
            'ogg_192': { mime: 'audio/ogg', ext: 'ogg', ffmpegArgs: ['-acodec', 'libvorbis', '-ab', '192k', '-f', 'ogg'] },
            'ogg_128': { mime: 'audio/ogg', ext: 'ogg', ffmpegArgs: ['-acodec', 'libvorbis', '-ab', '128k', '-f', 'ogg'] },
            // OPUS
            'opus': { mime: 'audio/opus', ext: 'opus', ffmpegArgs: ['-acodec', 'libopus', '-ab', '160k', '-f', 'opus'] },
            'opus_256': { mime: 'audio/opus', ext: 'opus', ffmpegArgs: ['-acodec', 'libopus', '-ab', '256k', '-f', 'opus'] },
            'opus_160': { mime: 'audio/opus', ext: 'opus', ffmpegArgs: ['-acodec', 'libopus', '-ab', '160k', '-f', 'opus'] },
            'opus_96': { mime: 'audio/opus', ext: 'opus', ffmpegArgs: ['-acodec', 'libopus', '-ab', '96k', '-f', 'opus'] },
            // WEBM
            'webm': { mime: 'audio/webm', ext: 'webm', ffmpegArgs: ['-acodec', 'libopus', '-ab', '160k', '-f', 'webm'] },
            'webm_256': { mime: 'audio/webm', ext: 'webm', ffmpegArgs: ['-acodec', 'libopus', '-ab', '256k', '-f', 'webm'] },
            'webm_160': { mime: 'audio/webm', ext: 'webm', ffmpegArgs: ['-acodec', 'libopus', '-ab', '160k', '-f', 'webm'] },
            'webm_96': { mime: 'audio/webm', ext: 'webm', ffmpegArgs: ['-acodec', 'libopus', '-ab', '96k', '-f', 'webm'] },
            // MP4 (Vidéo)
            'mp4': { mime: 'video/mp4', ext: 'mp4', ffmpegArgs: ['-c', 'copy', '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov'] },
            'mp4_1080': { mime: 'video/mp4', ext: 'mp4', ffmpegArgs: ['-c', 'copy', '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov'] },
            'mp4_720': { mime: 'video/mp4', ext: 'mp4', ffmpegArgs: ['-c', 'copy', '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov'] },
            'mp4_480': { mime: 'video/mp4', ext: 'mp4', ffmpegArgs: ['-c', 'copy', '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov'] }
        };

        const targetFormat = (reqFormat && formatMap[reqFormat.toLowerCase()]) ? formatMap[reqFormat.toLowerCase()] : formatMap['mp3_320'];
        const fileExt = targetFormat.ext;

        const safeTitle = (track.title || 'audio').replace(/[\r\n"\\\/]/g, '_');
        res.setHeader('Content-Type', targetFormat.mime);
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(safeTitle)}.${fileExt}"; filename*=UTF-8''${encodeURIComponent(safeTitle)}.${fileExt}`);

        const cp = require('child_process');
        const ffmpeg = require('ffmpeg-static');

        // Si le fichier est déjà préchargé ou local mais qu'un format spécifique est demandé, on l'utilise comme entrée FFmpeg ultra-rapide
        const cachedPath = preloadManager.getCachedPath(track);
        let ffmpegInput = null;
        let ffmpegVideoUrl = null;
        let ffmpegAudioUrl = null;
        let inputStream = null;

        if (cachedPath && fs.existsSync(cachedPath) && !(reqFormat || '').toLowerCase().startsWith('mp4')) {
            ffmpegInput = cachedPath;
        } else {
            // Fichier local : accepté uniquement s'il est sous une racine autorisée
            const localPath = resolveMediaPath(track.url);
            if (localPath) {
                ffmpegInput = localPath;
            } else if (track.queryType === 'file' || !/^https?:\/\//i.test(track.url || '')) {
                log.warn(`[WebServer Download] Accès refusé, chemin hors racines autorisées : ${track.url}`);
                return res.status(403).send('Chemin de fichier non autorisé');
            }
        }

        // 2. Sinon, résolution de l'URL directe via youtube-dl-exec
        const targetUrl = (track.url && track.url.includes('music.youtube.com')) ? track.url.replace('music.youtube.com', 'www.youtube.com') : track.url;
        if (!ffmpegInput && /^https?:\/\//i.test(targetUrl)) {
            try {
                const youtubedl = require('youtube-dl-exec');
                const info = await youtubedl(targetUrl, {
                    dumpSingleJson: true,
                    noCheckCertificates: true,
                    noWarnings: true,
                    preferFreeFormats: true,
                    addHeader: ['referer:youtube.com', 'user-agent:googlebot']
                }, { windowsHide: true });

                const entry = (info.entries && info.entries[0]) ? info.entries[0] : info;
                if (entry && entry.formats) {
                    if (reqFormat && (reqFormat.toLowerCase() === 'mp4' || reqFormat.toLowerCase().startsWith('mp4_'))) {
                        const targetRes = reqFormat.toLowerCase() === 'mp4_1080' ? 1080 : (reqFormat.toLowerCase() === 'mp4_720' ? 720 : (reqFormat.toLowerCase() === 'mp4_480' ? 480 : 1080));
                        
                        const videoFormats = entry.formats.filter(f => f.vcodec && f.vcodec !== 'none' && f.height);
                        const suitableVideo = videoFormats.filter(f => f.height <= targetRes).sort((a, b) => b.height - a.height)[0] 
                                           || videoFormats.sort((a, b) => a.height - b.height)[0];

                        if (suitableVideo) {
                            ffmpegVideoUrl = suitableVideo.url;
                            if (!suitableVideo.acodec || suitableVideo.acodec === 'none') {
                                const audioFormats = entry.formats.filter(f => f.acodec && f.acodec !== 'none').sort((a, b) => (b.tbr || 0) - (a.tbr || 0));
                                if (audioFormats[0]) {
                                    ffmpegAudioUrl = audioFormats[0].url;
                                }
                            }
                        }
                    }
                    if (!ffmpegVideoUrl) {
                        const audioFormats = entry.formats.filter(f => f.acodec && f.acodec !== 'none');
                        const bestAudio = audioFormats.find(f => f.vcodec === 'none') || audioFormats[0];
                        if (bestAudio && bestAudio.url) {
                            ffmpegInput = bestAudio.url;
                        }
                    }
                } else if (entry && entry.url) {
                    ffmpegInput = entry.url;
                }
            } catch (e) {}
        }

        // 3. Fallback extraction directe via discord-player
        if (!ffmpegInput && !ffmpegVideoUrl && !inputStream) {
            if (!track.extractor) {
                for (const [_, ext] of player.extractors.store.entries()) {
                    try {
                        if (await ext.validate(track.url, track.queryType)) {
                            track.extractor = ext;
                            break;
                        }
                    } catch (e) {}
                }
            }

            if (player && player.extractors?.context) {
                try {
                    await player.extractors.context.provide({
                        id: require('crypto').randomUUID(),
                        attemptedExtractors: new Set(),
                        bridgeAttemptedExtractors: new Set()
                    }, async () => {
                        let rawStreamObj = null;
                        if (track.extractor && typeof track.extractor.stream === 'function') {
                            rawStreamObj = await track.extractor.stream(track);
                        } else if (player && typeof player.extractors.stream === 'function') {
                            rawStreamObj = await player.extractors.stream(track);
                        }
                        if (rawStreamObj) {
                            if (typeof rawStreamObj === 'string') ffmpegInput = rawStreamObj;
                            else if (rawStreamObj.url) ffmpegInput = rawStreamObj.url;
                            else if (typeof rawStreamObj.pipe === 'function') inputStream = rawStreamObj;
                            else if (rawStreamObj.stream && typeof rawStreamObj.stream.pipe === 'function') inputStream = rawStreamObj.stream;
                        }
                    });
                } catch (e) {}
            }
        }

        if (ffmpegVideoUrl || ffmpegInput || inputStream) {
            const ffmpegArgs = [];

            if (ffmpegVideoUrl) {
                ffmpegArgs.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
                ffmpegArgs.push('-i', ffmpegVideoUrl);
                if (ffmpegAudioUrl) {
                    ffmpegArgs.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
                    ffmpegArgs.push('-i', ffmpegAudioUrl);
                    ffmpegArgs.push('-c:v', 'copy', '-c:a', 'aac', '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov');
                } else {
                    ffmpegArgs.push('-c', 'copy', '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov');
                }
            } else {
                if (ffmpegInput && (ffmpegInput.startsWith('http://') || ffmpegInput.startsWith('https://'))) {
                    ffmpegArgs.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
                }
                ffmpegArgs.push('-i', ffmpegInput || 'pipe:0', ...targetFormat.ffmpegArgs);
            }
            ffmpegArgs.push('pipe:1');

            const ffmpegProcess = cp.spawn(ffmpeg, ffmpegArgs, {
                stdio: ['pipe', 'pipe', 'ignore'],
                windowsHide: true
            });

            if (inputStream) {
                inputStream.pipe(ffmpegProcess.stdin);
            }

            ffmpegProcess.stdout.pipe(res);
            log.info(`[WebServer Download] Démarrage du téléchargement transcodé (${fileExt.toUpperCase()}) pour: ${track.title}`);

            req.on('close', () => {
                try { ffmpegProcess.kill(); } catch (e) {}
                try { if (inputStream) inputStream.destroy(); } catch (e) {}
            });
            return;
        }

        res.status(500).send('Échec du téléchargement du morceau');
    });

    const videoCache = new Map();

    router.get('/video-info', async (req, res) => {
        const { trackUrl, title, author, guildId } = req.query;
        const targetQuery = trackUrl || `${title || ''} ${author || ''}`.trim();
        if (!targetQuery) return res.status(400).json({ error: 'trackUrl ou titre requis' });

        // Reject local files or uploads directly (audio visualizer canvas will be used client-side)
        if (!/^https?:\/\//i.test(targetQuery) || targetQuery.includes('/uploads/') || targetQuery.includes('data\\uploads') || /^[a-zA-Z]:[\\\/]/.test(targetQuery)) {
            return res.status(404).json({ error: 'Local audio file, no video extraction needed' });
        }

        const hauteurCible = resolveVideoHeight(guildId || webServer._getFirstGuildId(), { url: trackUrl });
        // La hauteur entre dans la clé : changer de qualité doit relancer une
        // résolution, pas resservir l'entrée mise en cache pour l'ancienne.
        const cacheKey = `${targetQuery.toLowerCase()}|${hauteurCible}`;
        if (videoCache.has(cacheKey)) {
            const cached = videoCache.get(cacheKey);
            if (Date.now() - cached.timestamp < 3600000) {
                return res.json(cached.data);
            }
        }

        try {
            const youtubedl = require('youtube-dl-exec');
            const isUrl = /^https?:\/\//i.test(targetQuery);
            const queryArg = isUrl ? targetQuery : `ytsearch1:${targetQuery}`;

            const output = await youtubedl(queryArg, {
                dumpSingleJson: true,
                noCheckCertificates: true,
                noWarnings: true,
                preferFreeFormats: true,
                addHeader: ['referer:youtube.com', 'user-agent:googlebot']
            }, { windowsHide: true });

            const entry = (output.entries && output.entries[0]) ? output.entries[0] : output;
            if (!entry || !entry.formats) {
                return res.status(404).json({ error: 'Aucun format vidéo disponible' });
            }

            const videoFormats = entry.formats.filter(f => f.vcodec !== 'none' && f.acodec === 'none' && (f.ext === 'mp4' || f.container === 'mp4'));
            const fallbackVideoFormats = entry.formats.filter(f => f.vcodec !== 'none' && f.acodec === 'none');
            const anyVideoFormats = entry.formats.filter(f => f.vcodec !== 'none');

            const formats = videoFormats.length > 0 ? videoFormats : (fallbackVideoFormats.length > 0 ? fallbackVideoFormats : anyVideoFormats);
            if (formats.length === 0) {
                return res.status(404).json({ error: 'Aucun flux vidéo trouvé' });
            }

            const optimal = pickVideoFormat(formats, hauteurCible);

            if (optimal.height && optimal.height !== hauteurCible) {
                log.info(`[WebServer Video-Info] ${hauteurCible}p indisponible dans un codec lisible pour `
                    + `« ${entry.title || targetQuery} » : ${optimal.height}p (${optimal.vcodec || '?'}) servi à la place.`);
            }

            const data = {
                videoUrl: optimal.url,
                height: optimal.height,
                // Hauteur demandée : le client peut ainsi signaler l'écart sans
                // relire les réglages.
                requestedHeight: hauteurCible,
                codec: optimal.vcodec || null,
                format: optimal.ext || 'mp4',
                title: entry.title || title || '',
                author: entry.uploader || entry.artist || author || ''
            };

            videoCache.set(cacheKey, { timestamp: Date.now(), data });
            res.json(data);
        } catch (err) {
            log.error('[WebServer Video-Info] Erreur extraction vidéo:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/upload', async (req, res) => {
        const { useMainPlayer } = require('discord-player');
        const uploadService = require('../uploadService');

        const { guildId, voiceChannelId, playlistId, target, defaultPlaylistName } = req.query;
        const rawFileName = req.headers['x-file-name'] ? decodeURIComponent(req.headers['x-file-name']) : `file-${Date.now()}`;
        // basename() neutralise toute tentative de remontée de dossier via le nom
        const name = path.basename(rawFileName);

        const currentGuildId = guildId || webServer._getFirstGuildId();
        if (!currentGuildId) return res.status(400).json({ error: 'Guild non spécifiée' });

        if (!isAllowedMediaFilename(name)) {
            log.warn(`[WebServer Upload] Extension refusée : ${name}`);
            return res.status(415).json({ error: 'Type de fichier non supporté' });
        }

        let stored;
        try {
            stored = await uploadService.receiveUpload(req, {
                name,
                maxBytes: MAX_UPLOAD_MB * 1024 * 1024,
            });
        } catch (err) {
            log.warn(`[WebServer Upload] Transfert de "${name}" échoué : ${err.message}`);
            if (!res.headersSent) {
                res.status(err.statusCode || 500).json({ error: err.message });
            }
            return;
        }

        try {
            const player = useMainPlayer();
            const queue = player.queues.get(currentGuildId);

            await uploadService.processUploadedFile(stored.filePath, name, playlistId, currentGuildId, voiceChannelId, webServer, player, queue, target, defaultPlaylistName);
            res.json({ success: true, filePath: stored.filePath, name, deduplicated: stored.deduplicated });
        } catch (err) {
            log.error('[WebServer Upload] Erreur traitement :', err);
            if (!res.headersSent) {
                res.status(500).json({ error: err.message });
            }
        }
    });

    return router;
}

module.exports = createApiRouter;
