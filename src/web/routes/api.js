const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const database = require('../../database/Database');
const preloadManager = require('../../audio/PreloadManager');
const loudnessAnalyzer = require('../../audio/LoudnessAnalyzer');
const videoSource = require('../../audio/videoSource');
const { resolveMediaPath, isAllowedMediaFilename } = require('../../utils/mediaPaths');
const { arePathsOrUrlsEqual } = require('../../utils/paths');
const downloadDir = require('../../utils/downloadDir');
const changelog = require('../changelog');
const log = require('../../utils/logger');
const { ytdlp } = require('../../utils/youtubeNetwork');

/** Taille maximale d'un fichier uploadé (Mo). */
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 1024;

/**
 * Dossier `docs/` de la **version en cours d'exécution**.
 *
 * Résolu depuis `__dirname` et non depuis `process.cwd()` : sur une release
 * installée, la documentation lue dans le tableau de bord doit être celle de la
 * version qui tourne, pas celle du dépôt qui l'héberge.
 */
const DOCS_DIR = path.resolve(__dirname, '..', '..', '..', 'docs');

/** Profondeur d'exploration : la racine d'une langue et ses sous-dossiers immédiats. */
const DOCS_DEPTH = 2;

/**
 * Langue servie quand celle demandée n'est pas livrée.
 *
 * C'est le français qui est écrit à la main ; les autres en sont traduites. Il
 * n'intervient qu'à ce titre : une langue absente de `docs/` retombe sur lui.
 * Une langue livrée, elle, est servie telle quelle — son dossier est le seul
 * inventaire, et le sommaire n'est rien d'autre que ce qu'il contient.
 */
const DOCS_DEFAULT_LANG = 'fr';

/**
 * Langues effectivement livrées, lues sur le disque à chaque appel.
 *
 * Une liste en dur devrait être tenue à jour à la main à chaque langue ajoutée,
 * et se tromperait sur une version installée qui n'en embarque pas autant. Le
 * dossier `docs/` fait foi.
 *
 * Le filtre sur deux lettres minuscules n'est pas de la validation d'entrée —
 * rien de ce qui vient du client n'arrive ici — mais une garde contre les
 * dossiers annexes qu'on pourrait déposer à côté des langues.
 */
function availableDocsLangs() {
    try {
        return fs
            .readdirSync(DOCS_DIR, { withFileTypes: true })
            .filter((e) => e.isDirectory() && /^[a-z]{2}$/.test(e.name))
            .map((e) => e.name);
    } catch (e) {
        return [];
    }
}

/**
 * Langue à servir pour une demande du tableau de bord.
 *
 * La valeur reçue n'est jamais assemblée en chemin : elle est comparée aux noms
 * que le serveur a lui-même lus dans `docs/`, et c'est l'un de ces noms qui est
 * retourné. Une valeur inconnue — langue non traduite, ou chaîne arbitraire —
 * ne correspond simplement à aucune entrée et retombe sur la référence.
 */
function resolveDocsLang(requested) {
    const available = availableDocsLangs();
    const wanted = String(requested || '');
    const match = available.find((lang) => lang === wanted);
    if (match) return match;
    return available.find((lang) => lang === DOCS_DEFAULT_LANG) || available[0] || DOCS_DEFAULT_LANG;
}

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

// La lecture des plages est partie auprès de son lecteur le plus exigeant : le
// relais vidéo, qui doit satisfaire Safari. Voir src/web/mediaRelay.js.
const { parseRange, probeRemote, relayRemote } = require('../mediaRelay');

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
function documentTitle(docPath, fallback) {
    let head;
    try {
        const buffer = Buffer.alloc(2048);
        const fd = fs.openSync(docPath, 'r');
        try {
            const readBytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
            head = buffer.slice(0, readBytes).toString('utf8');
        } finally {
            fs.closeSync(fd);
        }
    } catch (e) {
        return fallback;
    }

    const titleMatch = /^#\s+(.+)$/m.exec(head);
    return titleMatch ? titleMatch[1].trim() : fallback;
}

/**
 * Inventaire des documents Markdown d'une langue donnée.
 *
 * L'inventaire est reconstruit à chaque appel : la documentation d'une version
 * installée ne bouge pas, mais celle du dépôt de développement s'écrit pendant
 * que le bot tourne, et le lecteur doit pouvoir la relire sans redémarrage.
 *
 * Les identifiants renvoyés sont des chemins relatifs à la racine de la langue —
 * `GUIDE.md`, `technique/01-architecture.md` — et sont donc les mêmes d'une
 * langue à l'autre. C'est ce qui permet de changer de langue sans quitter le
 * document qu'on lisait, et aux liens d'un document vers l'autre de se résoudre
 * à l'identique partout.
 *
 * Ils forment la liste blanche du service de contenu : aucune valeur venue du
 * client n'est jamais assemblée en chemin de fichier.
 *
 * @returns {Array<{id: string, title: string, group: string, bytes: number}>}
 */
function listDocuments(lang) {
    const docs = [];

    const walk = (dir, prefix, depth) => {
        let dirEntries;
        try {
            dirEntries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (e) {
            return;
        }

        for (const dirEntry of dirEntries) {
            if (dirEntry.name.startsWith('.')) continue;
            const fullPath = path.join(dir, dirEntry.name);

            if (dirEntry.isDirectory()) {
                if (depth > 1) walk(fullPath, `${prefix}${dirEntry.name}/`, depth - 1);
                continue;
            }
            if (!/\.md$/i.test(dirEntry.name)) continue;

            let bytes = 0;
            try {
                bytes = fs.statSync(fullPath).size;
            } catch (e) {}

            docs.push({
                id: `${prefix}${dirEntry.name}`,
                title: documentTitle(fullPath, dirEntry.name.replace(/\.md$/i, '')),
                group: prefix ? prefix.replace(/\/$/, '') : '',
                bytes,
            });
        }
    };

    walk(path.join(DOCS_DIR, lang), '', DOCS_DEPTH);

    // Racine avant sous-dossiers, et `README` en tête de son groupe : c'est
    // l'ordre dans lequel la documentation se lit, pas l'ordre alphabétique où
    // le sommaire d'un dossier atterrit après les chapitres qu'il annonce.
    const rank = (doc) => {
        if (!doc.group) return 0;
        return /(^|\/)README\.md$/i.test(doc.id) ? 1 : 2;
    };

    return docs.sort((a, b) => {
        if (a.group !== b.group) return a.group.localeCompare(b.group);
        const gap = rank(a) - rank(b);
        if (gap !== 0) return gap;
        return a.id.localeCompare(b.id, 'fr', { numeric: true });
    });
}

/*
 * ─── Stabilité de la source servie à /stream ──────────────────────────────
 *
 * Une même adresse de flux peut désigner deux fichiers très différents : le
 * MP3 du cache de préchargement, ou le fichier d'origine sur le disque. Le
 * premier n'existe pas encore pendant que le préchargement l'écrit, et il peut
 * disparaître ensuite, quand le cache fait le ménage.
 *
 * Or un navigateur ne télécharge pas un média d'un seul tenant : il en demande
 * des tranches au fil de la lecture, sur la même adresse, pendant plusieurs
 * minutes. Si le choix est refait à chaque requête, une tranche de MP3 finit
 * dans un décodage de WAV commencé sans lui — et cela ne s'entend pas comme un
 * silence ou une erreur, mais comme un énorme bruit blanc : des octets
 * compressés interprétés comme des échantillons bruts sont du bruit aléatoire.
 *
 * La représentation est donc retenue au premier octet servi, et resservie telle
 * quelle à toutes les tranches du même chargement.
 *
 * ## Ce qui identifie un chargement
 *
 * Le paramètre `load` de l'adresse, posé par le tableau de bord, et lui seul.
 * Surtout pas la position demandée : une plage repartant de zéro ressemble à un
 * nouveau départ, mais c'est aussi ce qu'envoie une lecture en boucle — et là,
 * le navigateur n'a rien oublié. Il garde ses octets déjà téléchargés sous cette
 * adresse et le décodeur ouvert sur le format reconnu au premier passage.
 * Rechoisir à ce moment-là est précisément ce qui produisait le bruit blanc, à
 * la seconde boucle d'un morceau préchargé entretemps.
 *
 * Une adresse sans `load` — un onglet resté sur une version antérieure du
 * tableau de bord — retombe sur la piste comme identifiant : la source y est
 * alors figée pour de bon, ce qui est moins efficace mais jamais faux.
 */

/** @type {Map<string, {file: string, mime: string, at: number}>} chargement → source */
const servedSources = new Map();

/**
 * Nombre de chargements dont on garde la source retenue.
 *
 * Un chargement par mise en lecture, et deux éléments audio qui se relaient :
 * la soixantaine couvre une longue session d'écoute. La borne n'existe que pour
 * qu'une session de plusieurs jours ne fasse pas grossir la table indéfiniment.
 */
const MAX_SERVED_SOURCES = 64;

/**
 * Choisit la représentation d'une piste : le cache s'il est prêt, le fichier
 * d'origine sinon.
 *
 * @param {object} track
 * @returns {{file: string, mime: string}|null}
 */
function pickStreamSource(track) {
    const cachedPath = preloadManager.getCachedPath(track);
    if (cachedPath) return { file: cachedPath, mime: 'audio/mpeg' };

    // Fichier local : servi uniquement s'il est sous une racine autorisée.
    const localPath = resolveMediaPath(track.url);
    if (localPath) return { file: localPath, mime: mimeFor(localPath) };

    return null;
}

/**
 * Source à servir pour cette requête.
 *
 * @param {object} track
 * @param {string|undefined} load - Identifiant du chargement, paramètre `load`
 *   de l'adresse. Absent, la piste sert d'identifiant de repli.
 * @returns {{file: string, mime: string, gone: boolean}|null} `gone` est vrai
 *   lorsque la source retenue a disparu en pleine lecture : l'appelant doit
 *   alors interrompre plutôt que de livrer des octets d'un autre format.
 */
function streamSourceFor(track, load) {
    const key = load ? `${track.url}#${load}` : track.url;
    const pinned = servedSources.get(key);

    if (pinned) {
        // Toujours sur le disque : on s'y tient, même si le cache vient
        // d'apparaître et proposerait mieux. Changer maintenant casserait le
        // décodage en cours ; le prochain chargement, lui, en profitera.
        if (fs.existsSync(pinned.file)) {
            pinned.at = Date.now();
            return { ...pinned, gone: false };
        }

        // Le fichier retenu a été supprimé sous nos pieds — une éviction de
        // cache. Rien ne peut être servi sans rompre le décodage en cours.
        servedSources.delete(key);
        return { file: null, mime: null, gone: true };
    }

    const chosen = pickStreamSource(track);
    if (!chosen) {
        servedSources.delete(key);
        return null;
    }

    chosen.at = Date.now();
    servedSources.set(key, chosen);

    // Les plus anciennes d'abord : c'est l'ordre d'insertion d'une Map, et
    // `at` remis à jour ne le change pas — d'où la relecture explicite.
    while (servedSources.size > MAX_SERVED_SOURCES) {
        let oldestKey = null;
        let oldest = Infinity;
        for (const [entryKey, entry] of servedSources) {
            if (entry.at < oldest) { oldest = entry.at; oldestKey = entryKey; }
        }
        servedSources.delete(oldestKey);
    }

    return { ...chosen, gone: false };
}

/** Hauteurs vidéo proposées dans l'interface, en pixels. */
const VALID_VIDEO_HEIGHTS = ['2160', '1440', '1080', '720', '480', '360'];
const DEFAULT_VIDEO_HEIGHT = 720;

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
        const perTrack = String(database.getTrackQuality(track?.url)?.video || '');
        if (VALID_VIDEO_HEIGHTS.includes(perTrack)) return Number(perTrack);
    } catch (e) {}

    if (!guildId) return DEFAULT_VIDEO_HEIGHT;
    try {
        const choice = String(database.getSettings(guildId).importVideoQuality || '');
        return VALID_VIDEO_HEIGHTS.includes(choice) ? Number(choice) : DEFAULT_VIDEO_HEIGHT;
    } catch (e) {
        return DEFAULT_VIDEO_HEIGHT;
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
function codecRank(format) {
    const codec = String(format?.vcodec || '').toLowerCase();
    if (codec.startsWith('avc') || codec.startsWith('h264')) return 0;
    if (codec.startsWith('vp9') || codec.startsWith('vp09')) return 1;
    if (codec.startsWith('av01') || codec.startsWith('av1')) return 3;
    if (codec.startsWith('vp8')) return 2;
    return 2;
}

/** Au-delà de ce rang, le flux est jugé trop incertain pour être servi tel quel. */
const MAX_CODEC_RANK = 2;

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
function pickVideoFormat(formats, targetHeight) {
    const withHeight = formats.filter(f => typeof f.height === 'number' && f.height > 0);
    if (withHeight.length === 0) return formats[0];

    // On ne considère que les codecs sûrs tant qu'il en reste ; sinon il vaut
    // mieux tenter un AV1 que ne rien renvoyer du tout.
    const safeCodecs = withHeight.filter(f => codecRank(f) <= MAX_CODEC_RANK);
    const candidates = safeCodecs.length > 0 ? safeCodecs : withHeight;

    const heights = [...new Set(candidates.map(f => f.height))];
    let chosenHeight;

    if (heights.includes(targetHeight)) {
        chosenHeight = targetHeight;
    } else {
        const below = heights.filter(h => h < targetHeight).sort((a, b) => b - a);
        chosenHeight = below.length > 0
            ? below[0]
            : heights.sort((a, b) => a - b)[0];
    }

    return candidates
        .filter(f => f.height === chosenHeight)
        .sort((a, b) => (codecRank(a) - codecRank(b)) || ((b.tbr || 0) - (a.tbr || 0)))[0];
}

function createApiRouter(webServer) {
    /*
     * Les droits, sur les routes comme sur les messages.
     *
     * `auth.middleware` a déjà répondu « qui frappe ? » avant d'arriver ici ;
     * ce qui suit répond à « que peut-il faire ? », en lisant la table de
     * `permissions.js` — la même que le WebSocket. Voir `httpGuards.js` pour
     * ce que `local` et `right` recouvrent.
     *
     * Une route sans garde est un choix, pas un oubli : elle décrit l'état,
     * sert la documentation, ou laisse écouter. Chacune dit laquelle elle est.
     */
    const { local, right } = require('../httpGuards').createGuards(webServer);

    /**
     * Version en cours d'exécution.
     *
     * Servie en HTTP plutôt que dans l'état WebSocket : elle ne change pas de
     * la vie du process, et le pied du tiroir doit pouvoir l'afficher sans
     * attendre qu'un serveur Discord soit sélectionné.
     */
    /**
     * Lien d'invitation du bot sur un nouveau serveur Discord.
     *
     * Route à part, et non un champ de l'état : `/api/state` refuse de répondre
     * tant que le bot n'a rejoint aucun serveur, et c'est précisément là qu'on a
     * besoin de ce lien. Le tableau de bord doit pouvoir inviter le bot depuis
     * une installation qui ne connaît encore aucun serveur.
     */
    router.get('/invite', (req, res) => {
        const url = webServer.inviteLink();
        if (!url) return res.status(503).json({ error: 'Bot non connecté à Discord' });
        res.json({ inviteUrl: url });
    });

    router.get('/version', (req, res) => {
        const versioning = require('../../versioning');
        const current = versioning.currentVersion();
        res.json({
            type: current.type,
            tag: current.tag,
            packageVersion: current.packageVersion,
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
    /*
     * Sans garde : elle ne rend qu'un nombre et une adresse, et le lanceur
     * l'interroge avant qu'aucune session Discord n'existe (voir
     * tools/start-bot.ps1). `auth.middleware` exige tout de même le jeton ou
     * une session, et l'adresse est celle que tout invité a déjà dans son lien.
     */
    /*
     * `entry` : l'adresse où ouvrir le tableau de bord.
     *
     * Le lanceur l'ouvrait sur l'interface d'écoute, `127.0.0.1`, qu'il lisait
     * dans `.env`. Or une session Discord n'existe que sur l'origine où Discord
     * renvoie — `PUBLIC_URL` —, et l'onglet tombait donc sur la porte de
     * connexion alors que le propriétaire était connecté, à un onglet de là.
     * C'est le piège que `WebServer.start` a déjà déjoué pour l'ouverture
     * automatique ; le lanceur y retombait par l'autre porte.
     *
     * Demandée au bot plutôt que relue dans `.env` : c'est lui qui sait si le
     * relais de retour OAuth est employé, et donc si `localhost` porte une
     * session (voir oauth.entryUrl).
     */
    router.get('/clients', (req, res) => {
        res.json({
            count: webServer.wss ? webServer.wss.clients.size : 0,
            entry: require('../oauth').entryUrl(),
        });
    });

    /**
     * Sommaire de la documentation embarquée, pour le lecteur du tableau de
     * bord (voir js/docs.js).
     */
    router.get('/docs', (req, res) => {
        const lang = resolveDocsLang(req.query.lang);
        res.json({ lang, documents: listDocuments(lang) });
    });

    /**
     * Source Markdown d'un document.
     *
     * L'identifiant demandé n'est pas transformé en chemin : il est cherché
     * dans l'inventaire, et c'est le chemin que le serveur a lui-même construit
     * en parcourant `docs/` qui est ouvert. Une remontée de dossier n'a donc
     * rien à contourner — elle ne correspond simplement à aucune entrée.
     *
     * La langue subit le même traitement, et l'inventaire consulté est celui de
     * la langue retenue : un identifiant valable dans une langue non livrée ne
     * peut donc pas servir à lire ailleurs. La réponse renvoie la langue, pour
     * que le lecteur sache dans laquelle il lit.
     */
    router.get('/docs/content', (req, res) => {
        const requestedId = String(req.query.id || '');
        const lang = resolveDocsLang(req.query.lang);
        const document = listDocuments(lang).find((d) => d.id === requestedId);
        if (!document) return res.status(404).json({ error: 'Document introuvable' });

        const docPath = path.join(DOCS_DIR, lang, ...document.id.split('/'));
        let source;
        try {
            source = fs.readFileSync(docPath, 'utf8');
        } catch (err) {
            log.error(`[WebServer Docs] Cannot read ${lang}/${document.id}:`, err.message);
            return res.status(500).json({ error: 'Document illisible' });
        }

        res.json({
            id: document.id,
            title: document.title,
            group: document.group,
            lang,
            source,
        });
    });

    /**
     * Journal des modifications, pour sa fenêtre de lecture (voir
     * js/changelog.js).
     *
     * Le Markdown n'est pas servi tel quel comme celui de la documentation : il
     * arrive découpé en livraisons datées et en catégories, parce que c'est cela
     * que la fenêtre donne à parcourir. Le pourquoi est dans src/web/changelog.js.
     *
     * `langs` accompagne la réponse : le journal n'est écrit qu'en deux langues,
     * et un tableau de bord réglé sur une troisième doit pouvoir dire dans
     * laquelle il l'affiche au lieu de laisser croire à une traduction manquante.
     *
     * Sans garde, comme `/api/docs` : la route ne commande rien, elle raconte ce
     * qui a déjà été livré. Voir l'en-tête de httpGuards.js, où l'absence de
     * garde est un choix motivé route par route.
     */
    router.get('/changelog', (req, res) => {
        try {
            res.json({ ...changelog.read(req.query.lang), langs: changelog.availableLangs() });
        } catch (err) {
            log.error('[WebServer Changelog] Cannot read the changelog:', err.message);
            res.status(500).json({ error: 'Journal illisible' });
        }
    });

    router.get('/state', (req, res) => {
        let targetGuildId = null;
        // Nommé `defaultChannelId` tant qu'il portait le salon favori. Il porte
        // désormais le salon courant, ce qui n'est pas la même chose : le favori
        // n'est plus lu qu'au démarrage du bot, où il devient précisément ce
        // salon courant. Le relire ici le ferait primer sur toute sélection
        // ultérieure — un tableau de bord ne pourrait plus en changer.
        let currentChannelId = null;

        // Le dernier salon visité, comme à l'ouverture d'un tableau de bord
        // (cf. `WebServer._initClient`).
        const lastChannelInfo = database.getLastVoiceChannel();
        if (lastChannelInfo.guildId && lastChannelInfo.channelId) {
            const guild = webServer.client.guilds.cache.get(lastChannelInfo.guildId);
            if (guild && guild.channels.cache.has(lastChannelInfo.channelId)) {
                targetGuildId = lastChannelInfo.guildId;
                currentChannelId = lastChannelInfo.channelId;
            }
        }

        if (!targetGuildId) {
            targetGuildId = webServer._getFirstGuildId();
        }

        if (!targetGuildId) return res.status(400).json({ error: 'Bot non connecté aux serveurs Discord' });
        res.json(webServer.getState(targetGuildId, currentChannelId));
    });

    /*
     * Sans garde, et c'est délibéré.
     *
     * C'est par ici que le son arrive à l'oreille : la fermer derrière un droit
     * rendrait muet un invité qu'on vient d'admettre. Elle ne divulgue rien de
     * plus que ce que le tableau de bord montre déjà — la piste est dans la
     * file, l'invité en lit le titre —, et le seul vrai risque qu'elle portait,
     * servir un fichier arbitraire du disque, est fermé par `resolveMediaPath`
     * et non par un droit.
     */
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
            log.info(`[WebServer Stream] Starting the stream for: ${track.title}`);
        }

        // Le navigateur applique lui-même le gain de sonie, mais il lui faut
        // la mesure : c'est ici qu'un morceau commence à jouer en diffusion
        // personnelle, et le seul endroit du chemin qui voie passer le fichier.
        loudnessAnalyzer.ensure(track);

        const source = streamSourceFor(track, req.query.load);

        if (source && source.gone) {
            // La source retenue a disparu en pleine lecture. Servir l'autre
            // fichier livrerait un format que le décodage en cours ne sait pas
            // interpréter — le fameux bruit blanc. Mieux vaut couper : le
            // tableau de bord recharge la piste à la position atteinte, sous une
            // adresse neuve, et la reprise ne coûte qu'un blanc de quelques
            // centaines de millisecondes.
            log.warn('[WebServer Stream] Source vanished mid-playback, '
                + `reload requested for: ${track.title}`);
            return res.status(404).send('Source du flux renouvelée, rechargement nécessaire');
        }

        if (source) {
            try {
                serveFileWithRange(req, res, source.file, source.mime);
            } catch (err) {
                log.error('[WebServer Stream] Error reading the audio file:', err.message);
                res.status(500).send(err.message);
            }
            return;
        }

        // La piste désigne un fichier disque, mais hors des racines autorisées.
        if (track.queryType === 'file' || !/^https?:\/\//i.test(track.url || '')) {
            log.warn(`[WebServer Stream] Access denied, path outside the allowed roots: ${track.url}`);
            return res.status(403).send('Chemin de fichier non autorisé');
        }

        /*
         * Flux distant : YouTube et consorts, transcodés à la volée.
         *
         * La piste est d'abord rendue jouable par le préchargeur, qui tient la
         * recette : une piste venue d'une playlist enregistrée n'est qu'un objet
         * nu relu du disque, et l'extracteur à qui on la remettait telle quelle
         * rendait un flux qui ne produisait rien — sans erreur, sans un octet.
         * Le tableau de bord recevait alors un `audio/mpeg` vide : la barre de
         * progression avançait, et rien ne sortait. La même résolution sert au
         * préchargement, ce qui explique qu'un morceau déjà mis en cache
         * s'entendait quand le même morceau joué en direct restait muet.
         *
         * Le contexte d'extraction enveloppe la seule résolution : le flux qu'il
         * rend continue d'être lu longtemps après, et le refermer plus tard ne
         * lui apporterait rien.
         */
        try {
            const crypto = require('crypto');

            const resolveInput = async () => {
                const playable = await preloadManager.resolvePlayableTrack(track);
                const input = await preloadManager.resolveAudioInput(playable.track, playable.url);
                return { ...input, title: playable.track.title || track.title };
            };

            const context = player && player.extractors && player.extractors.context;
            const { ffmpegInput, inputStream, title } = context
                ? await context.provide({
                    id: crypto.randomUUID(),
                    attemptedExtractors: new Set(),
                    bridgeAttemptedExtractors: new Set(),
                }, resolveInput)
                : await resolveInput();

            if (!ffmpegInput && !inputStream) {
                log.error(`[WebServer Stream] No playable source for: ${title}`);
                return res.status(502).send('Source audio introuvable pour ce morceau');
            }

            const cp = require('child_process');
            const ffmpeg = require('ffmpeg-static');

            const args = [];
            // Une URL directe peut se rompre en cours de route : ffmpeg reprend
            // la connexion plutôt que de rendre un fichier tronqué.
            if (ffmpegInput && /^https?:\/\//i.test(ffmpegInput)) {
                args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
            }
            // `-vn` : la source peut porter une image — pochette d'un fichier
            // téléversé, piste vidéo d'un flux distant. Le muxer MP3 n'en veut
            // pas et s'arrête sans écrire un octet. Voir PreloadManager.
            args.push('-i', ffmpegInput || 'pipe:0', '-vn',
                '-acodec', 'libmp3lame', '-ab', '128k', '-f', 'mp3', 'pipe:1');

            const ffmpegProcess = cp.spawn(ffmpeg, args, {
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true,
            });

            // Dernières lignes de ffmpeg, gardées pour le seul cas où il ne
            // produit rien : son diagnostic est alors la seule explication
            // disponible, et il partait jusqu'ici dans le vide.
            let stderrTail = '';
            if (ffmpegProcess.stderr) {
                ffmpegProcess.stderr.on('data', (chunk) => {
                    stderrTail = (stderrTail + chunk.toString()).slice(-800);
                });
            }

            if (inputStream) {
                // Sans ces deux gardes, une source qui se coupe fait remonter un
                // `error` sur un flux qui n'en écoute pas : Node abat alors le
                // processus entier, bot compris.
                inputStream.on('error', (err) => {
                    log.error(`[WebServer Stream] Source stream error for ${title}:`, err.message);
                    try { ffmpegProcess.kill(); } catch (e) {}
                });
                if (ffmpegProcess.stdin) {
                    ffmpegProcess.stdin.on('error', (err) => {
                        // EPIPE attendu : ffmpeg a fermé son entrée en premier.
                        if (err.code !== 'EPIPE') {
                            log.error(`[WebServer Stream] ffmpeg stdin error for ${title}:`, err.message);
                        }
                    });
                }
                inputStream.pipe(ffmpegProcess.stdin);
            }

            /*
             * L'en-tête n'est écrite qu'au premier octet reçu.
             *
             * Annoncée d'avance, elle engageait la réponse avant de savoir s'il y
             * aurait quelque chose à envoyer : un échec ne pouvait plus être
             * signalé, et le navigateur recevait un `200 OK` parfaitement vide,
             * qu'il traite comme un morceau sans son plutôt que comme une erreur.
             */
            let headerSent = false;
            ffmpegProcess.stdout.once('data', (chunk) => {
                headerSent = true;
                res.writeHead(200, {
                    'Content-Type': 'audio/mpeg',
                    'Transfer-Encoding': 'chunked',
                });
                res.write(chunk);
                ffmpegProcess.stdout.pipe(res);
            });

            ffmpegProcess.on('error', (err) => {
                log.error(`[WebServer Stream] ffmpeg could not be started for ${title}:`, err.message);
                if (!headerSent && !res.headersSent) res.status(500).send(err.message);
            });

            ffmpegProcess.on('close', (code) => {
                if (headerSent) return;
                log.error(`[WebServer Stream] ffmpeg produced nothing for ${title} `
                    + `(code ${code}) — ${stderrTail.trim().split('\n').slice(-3).join(' | ') || 'no output'}`);
                if (!res.headersSent) res.status(502).send('Transcodage impossible pour ce morceau');
            });

            req.on('close', () => {
                try { ffmpegProcess.kill(); } catch (e) {}
                try { if (inputStream) inputStream.destroy(); } catch (e) {}
            });
            return;
        } catch (err) {
            log.error('[WebServer Stream] Remote stream extraction/transcoding error:', err.message);
            if (!res.headersSent) res.status(500).send(err.message);
            return;
        }
    });

    router.get('/download', right('queue.download'), async (req, res) => {
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

        // Fichier local : accepté uniquement s'il est sous une racine autorisée.
        //
        // Il passe **avant** le cache, à l'inverse du flux : ce que le cache
        // contient est une copie compressée, faite pour être écoutée sur un
        // téléphone. Un téléchargement, lui, doit repartir de l'original —
        // sans quoi un export en WAV rendrait un WAV réencodé depuis un MP3.
        const localPath = resolveMediaPath(track.url);
        if (localPath) {
            ffmpegInput = localPath;
        } else if (track.queryType === 'file' || !/^https?:\/\//i.test(track.url || '')) {
            log.warn(`[WebServer Download] Access denied, path outside the allowed roots: ${track.url}`);
            return res.status(403).send('Chemin de fichier non autorisé');
        } else if (cachedPath && fs.existsSync(cachedPath) && !(reqFormat || '').toLowerCase().startsWith('mp4')) {
            ffmpegInput = cachedPath;
        }

        // 2. Sinon, résolution de l'URL directe via youtube-dl-exec
        const targetUrl = (track.url && track.url.includes('music.youtube.com')) ? track.url.replace('music.youtube.com', 'www.youtube.com') : track.url;

        /*
         * L'adresse doit mener hors de chez l'hôte.
         *
         * `yt-dlp` et `ffmpeg` s'exécutent sur la machine du propriétaire, donc
         * à l'intérieur de son réseau, et suivent l'adresse qu'on leur donne
         * sans se poser de question. Celle-ci vient de la piste, donc de qui l'a
         * ajoutée : un invité pourvu du seul droit d'ajouter à la file faisait
         * ainsi frapper à des portes qu'il n'atteint pas lui-même — l'interface
         * du routeur, un service sur la boucle locale, un point de métadonnées.
         *
         * Le nom est résolu et non seulement lu : `interne.exemple.fr` n'a l'air
         * de rien et peut pointer sur `10.0.0.1`. Voir utils/outbound.js.
         */
        if (!ffmpegInput && /^https?:\/\//i.test(targetUrl)) {
            const verdict = await require('../../utils/outbound').isFetchable(targetUrl);
            if (!verdict.ok) {
                log.warn(`[WebServer Download] Outbound address refused: ${verdict.reason}`);
                return res.status(403).send('Adresse non autorisée');
            }
        }

        if (!ffmpegInput && /^https?:\/\//i.test(targetUrl)) {
            try {
                const info = await ytdlp(targetUrl, {
                    dumpSingleJson: true,
                    noCheckCertificates: true,
                    noWarnings: true,
                    preferFreeFormats: true,
                }, { windowsHide: true });

                const entry = (info.entries && info.entries[0]) ? info.entries[0] : info;
                if (entry && entry.formats) {
                    if (reqFormat && (reqFormat.toLowerCase() === 'mp4' || reqFormat.toLowerCase().startsWith('mp4_'))) {
                        const targetRes = reqFormat.toLowerCase() === 'mp4_1080' ? 1080 : (reqFormat.toLowerCase() === 'mp4_720' ? 720 : (reqFormat.toLowerCase() === 'mp4_480' ? 480 : 1080));
                        
                        // Les manifestes sont écartés en amont : leur adresse est
                        // signée pour le client qui l'a demandée, et ffmpeg s'y
                        // voit refuser l'entrée. Voir `videoSource`.
                        const videoFormats = videoSource.videoTracks(entry);
                        const suitableVideo = videoFormats.filter(f => f.height <= targetRes).sort((a, b) => b.height - a.height)[0]
                                           || videoFormats.sort((a, b) => a.height - b.height)[0];

                        if (suitableVideo) {
                            ffmpegVideoUrl = suitableVideo.url;
                            if (!suitableVideo.acodec || suitableVideo.acodec === 'none') {
                                // Direct, et dans la langue d'origine : un tri au
                                // meilleur débit prenait le doublage automatique
                                // le mieux servi, langue au hasard.
                                const son = videoSource.bestAudio(entry);
                                if (son) {
                                    ffmpegAudioUrl = son.url;
                                }
                            }
                        }
                    }
                    if (!ffmpegVideoUrl) {
                        const bestAudio = videoSource.bestAudio(entry);
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
            log.info(`[WebServer Download] Starting the transcoded download (${fileExt.toUpperCase()}) for: ${track.title}`);

            req.on('close', () => {
                try { ffmpegProcess.kill(); } catch (e) {}
                try { if (inputStream) inputStream.destroy(); } catch (e) {}
            });
            return;
        }

        res.status(500).send('Échec du téléchargement du morceau');
    });

    /*
     * Résolutions vidéo déjà obtenues — et déjà refusées.
     *
     * Le tableau de bord redemande l'adresse du flux à chaque rafraîchissement
     * d'état, soit une fois par seconde et par onglet ouvert. Tant que la
     * résolution aboutit, le cache absorbe tout. Mais un échec n'y laissait
     * aucune trace : une vidéo protégée par DRM, retirée, ou simplement
     * introuvable, relançait donc un processus yt-dlp par seconde et par
     * onglet, indéfiniment, pour rapporter chaque fois la même erreur.
     *
     * Six de ces processus tournaient de front sur la machine, chacun pesant
     * son démarrage de Python : la boucle d'événements s'en ressentait, et les
     * WebSocket des tableaux de bord se faisaient couper — d'où des clients qui
     * n'en finissaient plus de se reconnecter, symptôme sans rapport apparent
     * avec la vidéo.
     *
     * L'échec est donc retenu comme le succès, moins longtemps : une vidéo peut
     * redevenir disponible, et rien ne presse de le découvrir.
     */
    const videoCache = new Map();
    const VIDEO_CACHE_TTL_MS = 3600000;
    const VIDEO_FAILURE_TTL_MS = 300000;

    /**
     * Résolutions en cours, par clé de cache.
     *
     * Deux onglets ouverts sur le même morceau demandaient chacun le leur, et
     * les deux processus faisaient le même travail. Le second attend désormais
     * le premier.
     */
    const videoInFlight = new Map();

    /**
     * Résout le flux vidéo d'un morceau, sans rien mettre en cache.
     *
     * Rend toujours une issue, jamais une exception : un échec est une réponse
     * comme une autre, et c'est ce qui permet de le retenir aussi longtemps
     * qu'un succès.
     *
     * @param {string} query - URL du morceau, ou titre à rechercher.
     * @param {number} height - Définition demandée.
     * @param {{ title?: string, author?: string }} fallback - Métadonnées de
     *   repli, quand la source n'en rapporte pas.
     * @returns {Promise<{ data?: object, status?: number, error?: string }>}
     */
    async function resolveVideoStream(query, height, fallback = {}) {
        try {
            const isUrl = /^https?:\/\//i.test(query);
            const queryArg = isUrl ? query : `ytsearch1:${query}`;

            const output = await ytdlp(queryArg, {
                dumpSingleJson: true,
                noCheckCertificates: true,
                noWarnings: true,
                preferFreeFormats: true,
            }, { windowsHide: true });

            const entry = (output.entries && output.entries[0]) ? output.entries[0] : output;
            if (!entry || !entry.formats) {
                return { status: 404, error: 'Aucun format vidéo disponible' };
            }

            /*
             * Les manifestes sont écartés avant tout le reste.
             *
             * Un `.m3u8` n'est pas un flux mais une liste de morceaux, et une
             * balise <video> ne sait pas la lire hors de Safari. Pire : son
             * adresse est signée pour le client qui l'a demandée et répond 404 à
             * tout autre. Or les manifestes annoncent le plus haut débit de la
             * liste — 4107 contre 1666 en 720p —, si bien que le classement par
             * débit de `pickVideoFormat` les retenait à tout coup. La vidéo ne
             * se chargeait alors jamais, et le navigateur redemandait dix fois
             * la même adresse morte.
             */
            const jouables = videoSource.videoTracks(entry);
            const videoFormats = jouables.filter(f => f.acodec === 'none' && (f.ext === 'mp4' || f.container === 'mp4'));
            const fallbackVideoFormats = jouables.filter(f => f.acodec === 'none');
            const anyVideoFormats = jouables;

            const formats = videoFormats.length > 0 ? videoFormats : (fallbackVideoFormats.length > 0 ? fallbackVideoFormats : anyVideoFormats);
            if (formats.length === 0) {
                return { status: 404, error: 'Aucun flux vidéo trouvé' };
            }

            const optimal = pickVideoFormat(formats, height);

            if (optimal.height && optimal.height !== height) {
                log.info(`[WebServer Video-Info] ${height}p unavailable in a readable codec for `
                    + `« ${entry.title || query} »: ${optimal.height}p (${optimal.vcodec || '?'}) served instead.`);
            }

            return {
                /*
                 * L'adresse résolue et ses en-têtes restent ici.
                 *
                 * Ils ne sont d'aucun usage au tableau de bord, qui ne va plus
                 * chercher la vidéo lui-même — c'est tout l'objet du relais. Les
                 * lui envoyer quand même ferait sortir une adresse signée par
                 * une porte qui n'a plus de raison de s'ouvrir.
                 */
                source: {
                    url: optimal.url,
                    // Ceux que la source a exigés à la résolution, qu'elle peut
                    // réclamer à nouveau au moment de servir les octets.
                    headers: optimal.http_headers || {},
                },
                data: {
                    height: optimal.height,
                    // Hauteur demandée : le client peut ainsi signaler l'écart sans
                    // relire les réglages.
                    requestedHeight: height,
                    codec: optimal.vcodec || null,
                    format: optimal.ext || 'mp4',
                    title: entry.title || fallback.title || '',
                    author: entry.uploader || entry.artist || fallback.author || ''
                }
            };
        } catch (err) {
            log.error('[WebServer Video-Info] Video extraction error:', err.message);
            return { status: 500, error: err.message };
        }
    }

    /**
     * Ce qu'une requête vidéo désigne, ou pourquoi elle ne désigne rien.
     *
     * Les deux routes vidéo partent du même point : la même cible, la même
     * hauteur, donc la même clé de cache. Les séparer les aurait fait diverger
     * au premier changement — et une résolution que le relais ne retrouve pas,
     * c'est une vidéo qui ne vient jamais.
     *
     * @returns {{ error: string, status: number } | { targetQuery: string, targetHeight: number, cacheKey: string }}
     */
    function videoTarget(req) {
        const { trackUrl, title, author, guildId } = req.query;
        const targetQuery = trackUrl || `${title || ''} ${author || ''}`.trim();
        if (!targetQuery) return { status: 400, error: 'trackUrl ou titre requis' };

        // Reject local files or uploads directly (audio visualizer canvas will be used client-side)
        if (!/^https?:\/\//i.test(targetQuery) || targetQuery.includes('/uploads/') || targetQuery.includes('data\\uploads') || /^[a-zA-Z]:[\\\/]/.test(targetQuery)) {
            return { status: 404, error: 'Local audio file, no video extraction needed' };
        }

        /*
         * La hauteur vient de l'adresse quand elle y est.
         *
         * `/api/video-info` la calcule d'après les réglages du salon et l'inscrit
         * dans l'adresse du relais ; celui-ci la relit telle quelle. Sans cela, un
         * réglage changé entre la résolution et la lecture enverrait le relais
         * chercher une autre entrée de cache que celle qui vient d'être annoncée,
         * et la vidéo se rechargerait en plein milieu.
         */
        const demandee = Number(req.query.height);
        const targetHeight = Number.isFinite(demandee) && demandee > 0
            ? demandee
            : resolveVideoHeight(guildId || webServer._getFirstGuildId(), { url: trackUrl });

        // La hauteur entre dans la clé : changer de qualité doit relancer une
        // résolution, pas resservir l'entrée mise en cache pour l'ancienne.
        return { targetQuery, targetHeight, cacheKey: `${targetQuery.toLowerCase()}|${targetHeight}` };
    }

    /**
     * La résolution d'une cible, du cache si elle y est, d'une extraction sinon.
     *
     * @returns {Promise<{ data?: object, source?: object, status?: number, error?: string }>}
     */
    async function videoOutcome({ targetQuery, targetHeight, cacheKey }, fallback) {
        const cached = videoCache.get(cacheKey);
        if (cached) {
            const ttl = cached.error ? VIDEO_FAILURE_TTL_MS : VIDEO_CACHE_TTL_MS;
            if (Date.now() - cached.timestamp < ttl) return cached;
            videoCache.delete(cacheKey);
        }

        let pending = videoInFlight.get(cacheKey);
        if (!pending) {
            pending = resolveVideoStream(targetQuery, targetHeight, fallback)
                .then((outcome) => {
                    const entry = { timestamp: Date.now(), ...outcome };
                    videoCache.set(cacheKey, entry);
                    return entry;
                })
                .finally(() => videoInFlight.delete(cacheKey));
            videoInFlight.set(cacheKey, pending);
        }

        return pending;
    }

    router.get('/video-info', async (req, res) => {
        const target = videoTarget(req);
        if (target.error) return res.status(target.status).json({ error: target.error });

        const { trackUrl, title, author, guildId } = req.query;
        const outcome = await videoOutcome(target, { title, author });
        if (outcome.error) return res.status(outcome.status || 500).json({ error: outcome.error });

        /*
         * L'adresse rendue est celle du bot, jamais celle de la source.
         *
         * C'est tout le sujet : voir l'en-tête de src/web/mediaRelay.js. Elle ne
         * dépend que de la piste et de la hauteur, donc elle ne bouge plus d'une
         * résolution à l'autre — le tableau de bord compare `data-loaded-src`
         * pour décider s'il recharge, et une adresse signée fraîchement renouvelée
         * lui faisait recharger la vidéo en pleine lecture, à chaque expiration
         * du cache.
         */
        const params = new URLSearchParams({
            guildId: guildId || '',
            trackUrl: trackUrl || '',
            title: title || '',
            author: author || '',
            height: String(target.targetHeight),
        });

        res.json({ ...outcome.data, videoUrl: `/api/video-stream?${params}` });
    });

    router.get('/video-stream', async (req, res) => {
        const target = videoTarget(req);
        if (target.error) return res.status(target.status).send(target.error);

        const { title, author } = req.query;
        const outcome = await videoOutcome(target, { title, author });
        if (outcome.error || !outcome.source) {
            return res.status(outcome.status || 500).send(outcome.error || 'Flux vidéo introuvable');
        }

        const { url, headers } = outcome.source;

        try {
            /*
             * Le sondage est retenu sur l'entrée de cache elle-même.
             *
             * Il coûte une requête, et une balise <video> réclame des dizaines de
             * plages pour une seule vidéo. Le poser là plutôt que dans une table à
             * part lui donne la durée de vie qu'il faut sans rien à purger : il
             * décrit cette adresse-ci, et disparaît avec elle.
             *
             * Le garde-fou des adresses sortantes précède le sondage, et c'est ce
             * relais qui le rend nécessaire. Tant que le tableau de bord allait
             * chercher la vidéo lui-même, une adresse interne ne menait nulle
             * part — le navigateur d'un invité n'atteint pas le réseau de l'hôte.
             * Maintenant que le bot va la chercher *et* rend le corps au client,
             * la piste ajoutée par un invité pourrait servir de longue-vue sur ce
             * réseau. Voir utils/outbound.js, et le même contrôle sur /download.
             */
            if (!outcome.probe) {
                outcome.probe = (async () => {
                    const verdict = await require('../../utils/outbound').isFetchable(url);
                    if (!verdict.ok) throw new Error(`adresse non autorisée — ${verdict.reason}`);
                    return probeRemote(url, headers);
                })();
            }
            const { size, contentType } = await outcome.probe;

            if (!size) {
                // Sans taille, aucune plage ne peut être annoncée, et une balise
                // <video> ne lit pas ce qu'elle ne peut pas parcourir.
                log.warn('[WebServer Video-Stream] Source announces no size, video unplayable');
                return res.status(502).send('Taille du flux vidéo inconnue');
            }

            relayRemote(req, res, {
                url,
                headers,
                size,
                contentType,
                onError: (message) => log.warn(`[WebServer Video-Stream] Relay interrupted: ${message}`),
            });
        } catch (err) {
            /*
             * Une adresse résolue peut avoir expiré depuis : elles ne valent que
             * quelques heures. L'entrée est jetée pour que la requête suivante
             * reparte d'une extraction neuve plutôt que de buter cent fois sur la
             * même adresse morte.
             */
            videoCache.delete(target.cacheKey);
            log.warn(`[WebServer Video-Stream] Unreachable source, resolution dropped: ${err.message}`);
            if (!res.headersSent) res.status(502).send('Source vidéo injoignable');
        }
    });

    router.post('/upload', right('queue.add'), async (req, res) => {
        const { useMainPlayer } = require('discord-player');
        const uploadService = require('../uploadService');

        const { guildId, voiceChannelId, playlistId, target, defaultPlaylistName } = req.query;
        const rawFileName = req.headers['x-file-name'] ? decodeURIComponent(req.headers['x-file-name']) : `file-${Date.now()}`;
        // basename() neutralise toute tentative de remontée de dossier via le nom
        const name = path.basename(rawFileName);

        const currentGuildId = guildId || webServer._getFirstGuildId();
        if (!currentGuildId) return res.status(400).json({ error: 'Guild non spécifiée' });

        if (!isAllowedMediaFilename(name)) {
            log.warn(`[WebServer Upload] Extension refused: ${name}`);
            return res.status(415).json({ error: 'Type de fichier non supporté' });
        }

        /*
         * D'un seul tenant, ou en morceaux.
         *
         * Le navigateur découpe tout fichier qui dépasserait ce qu'un tunnel
         * Cloudflare laisse passer en une requête (voir chunkedUpload.js). Les
         * morceaux arrivent sur cette même route, marqués de `uploadId` ; seul
         * le dernier poursuit jusqu'à la lecture, les autres reçoivent le
         * numéro du suivant.
         */
        const chunked = typeof req.query.uploadId === 'string';

        let stored;
        try {
            if (chunked) {
                const result = await require('../chunkedUpload').receiveChunk(req, {
                    uploadId: req.query.uploadId,
                    index: Number(req.query.chunk),
                    total: Number(req.query.chunks),
                    name,
                    maxBytes: MAX_UPLOAD_MB * 1024 * 1024,
                });
                if (!result.done) return res.json({ success: true, next: result.next });
                stored = result;
            } else {
                stored = await uploadService.receiveUpload(req, {
                    name,
                    maxBytes: MAX_UPLOAD_MB * 1024 * 1024,
                });
            }
        } catch (err) {
            // Un morceau attendu ailleurs n'est pas un échec du transfert : le
            // navigateur reprend au numéro qu'on lui donne.
            if (err.statusCode !== 409) {
                log.warn(`[WebServer Upload] Transfer of "${name}" failed: ${err.message}`);
            }
            if (!res.headersSent) {
                const body = { error: err.message };
                if (Number.isInteger(err.expected)) body.expected = err.expected;
                res.status(err.statusCode || 500).json(body);
            }
            return;
        }

        try {
            const player = useMainPlayer();
            const queue = player.queues.get(currentGuildId);

            await uploadService.processUploadedFile(stored.filePath, name, playlistId, currentGuildId, voiceChannelId, webServer, player, queue, target, defaultPlaylistName);
            res.json({ success: true, filePath: stored.filePath, name, deduplicated: stored.deduplicated });
        } catch (err) {
            log.error('[WebServer Upload] Processing error:', err);
            if (!res.headersSent) {
                res.status(500).json({ error: err.message });
            }
        }
    });

    /* ═════════════ Dossier de téléchargement ═════════════
     *
     * Ces trois routes servent la quatrième destination de la boîte d'ajout :
     * celle qui n'envoie rien au lecteur et écrit sur le disque du bot.
     *
     * Elles laissent le tableau de bord parcourir l'arborescence de la machine
     * hôte. L'enfermer dans les racines de `mediaPaths` reviendrait à retirer
     * la fonction : quelqu'un qui range sa musique dans « D:\Musique » veut
     * l'y télécharger.
     *
     * **D'où la garde `local`.** Ces routes ont longtemps tenu sur un
     * raisonnement qui a cessé d'être vrai : « le bot tourne chez son
     * propriétaire, et l'authentification couvre tout ce qui est monté après
     * elle ». La première moitié a été démentie par le partage du contrôle —
     * l'invité n'est plus quelqu'un qui est déjà dans la maison — et la seconde
     * confondait deux questions, car `auth.middleware` dit qui frappe et jamais
     * ce qu'il peut faire. Un invité sans un seul droit coché parcourait donc
     * le disque de l'hôte, alors que le message WebSocket équivalent lui aurait
     * été refusé.
     *
     * Le jeton, et non la propriété : le lanceur interroge ces routes sans
     * session Discord. Voir `httpGuards.js`.
     */

    router.get('/download-dir', local, (req, res) => {
        const chosen = database.getDownloadDir();
        res.json({
            dir: chosen || downloadDir.DEFAULT_DIR,
            defaultDir: downloadDir.DEFAULT_DIR,
            isDefault: !chosen,
        });
    });

    router.post('/download-dir', local, (req, res) => {
        const wanted = req.body && typeof req.body.dir === 'string' ? req.body.dir : null;

        // Chaîne vide ou absente : retour au dossier par défaut.
        if (!wanted || !wanted.trim()) {
            database.setDownloadDir(null);
            return res.json({ dir: downloadDir.DEFAULT_DIR, isDefault: true });
        }

        const verdict = downloadDir.validate(wanted);
        if (!verdict.ok) {
            log.warn(`[WebServer DownloadDir] Refused: ${wanted} (${verdict.reason})`);
            return res.status(400).json({ error: verdict.reason });
        }

        /*
         * Désigner le dossier par défaut, c'est revenir au défaut.
         *
         * Le sélecteur y mène par une pastille, comme à n'importe quel autre
         * dossier : ce qui arrive ici est alors le chemin absolu de
         * `data/downloads`. L'enregistrer tel quel serait un choix explicite —
         * le menu afficherait « Vers C:\…\data\downloads » au lieu de « Vers
         * data/downloads/ », et un déplacement du projet laisserait le bot
         * écrire dans l'ancien dossier.
         *
         * Le retenir comme nul rend au chemin son caractère relatif, et fait de
         * la pastille l'équivalent exact du bouton de réinitialisation qu'elle
         * remplace. La comparaison ignore la casse sous Windows, où
         * « C:\Data » et « c:\data » sont le même dossier.
         */
        const asDefault = process.platform === 'win32'
            ? verdict.resolved.toLowerCase() === downloadDir.DEFAULT_DIR.toLowerCase()
            : verdict.resolved === downloadDir.DEFAULT_DIR;

        if (asDefault) {
            database.setDownloadDir(null);
            return res.json({ dir: downloadDir.DEFAULT_DIR, isDefault: true });
        }

        database.setDownloadDir(verdict.resolved);
        log.info(`[WebServer DownloadDir] Downloads will now be written to ${verdict.resolved}`);
        res.json({ dir: verdict.resolved, isDefault: false });
    });

    /**
     * Sous-dossiers d'un chemin, pour le sélecteur.
     *
     * Seuls les dossiers sont rendus : le but est de désigner une destination,
     * et faire défiler dix mille fichiers pour choisir leur dossier parent ne
     * sert personne.
     */
    router.get('/browse-dirs', local, (req, res) => {
        const asked = typeof req.query.path === 'string' && req.query.path.trim()
            ? req.query.path.trim()
            : null;

        if (asked && asked.includes('\0')) return res.status(400).json({ error: 'invalid' });

        let wanted;
        try {
            if (asked) {
                wanted = path.resolve(asked);
            } else {
                /*
                 * Premier affichage : le dossier courant.
                 *
                 * Le dossier par défaut est créé au passage s'il manque. Il
                 * naît normalement au premier téléchargement, si bien qu'avant
                 * celui-ci l'explorateur s'ouvrait sur un dossier inexistant —
                 * et n'affichait rien du tout. Le créer ici ne fait
                 * qu'avancer d'un instant ce qui allait arriver, et rend le
                 * point de départ conforme à ce que le menu annonce.
                 */
                const chosen = database.getDownloadDir();
                wanted = chosen || downloadDir.ensure(downloadDir.DEFAULT_DIR);
            }
        } catch (e) {
            return res.status(400).json({ error: 'invalid' });
        }

        const roots = downloadDir.listRoots();
        // Le dossier de téléchargement du système, quand il en a un : la
        // pastille de saisie rapide du sélecteur n'a pas d'autre source.
        const downloads = downloadDir.userDownloadsDir();

        // Un dossier peut avoir disparu depuis qu'il a été choisi. Plutôt que
        // de répondre « illisible » et de laisser l'explorateur vide — sans
        // contenu ni moyen d'aller ailleurs —, on remonte au premier ancêtre
        // qui se laisse lire.
        const target = downloadDir.nearestReadable(wanted);
        if (!target) {
            return res.json({
                path: null, parent: null, requested: wanted, roots, downloads,
                defaultDir: downloadDir.DEFAULT_DIR, dirs: [], writable: false,
            });
        }

        let entries;
        try {
            entries = fs.readdirSync(target, { withFileTypes: true });
        } catch (e) {
            return res.json({
                path: null, parent: null, requested: wanted, roots, downloads,
                defaultDir: downloadDir.DEFAULT_DIR, dirs: [], writable: false,
            });
        }

        const dirs = [];
        for (const entry of entries) {
            // `isDirectory` est faux sur un lien symbolique, même s'il pointe
            // vers un dossier : `statSync` suit le lien, et un dossier de
            // musique atteint par un lien doit pouvoir être parcouru.
            let isDir = entry.isDirectory();
            if (!isDir && entry.isSymbolicLink()) {
                try {
                    isDir = fs.statSync(path.join(target, entry.name)).isDirectory();
                } catch (e) {
                    isDir = false;
                }
            }
            if (!isDir) continue;

            // Les dossiers cachés sont écartés : sous Unix ils portent les
            // réglages des applications, et personne n'y range sa musique.
            if (entry.name.startsWith('.')) continue;
            dirs.push({ name: entry.name, path: path.join(target, entry.name) });
        }
        dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

        const parent = path.dirname(target);
        res.json({
            path: target,
            // À la racine, `dirname` rend le chemin lui-même : il n'y a alors
            // plus de parent où remonter, et le sélecteur éteint le bouton.
            parent: parent === target ? null : parent,
            // Ce qui avait été demandé, quand ce n'est pas ce qu'on a ouvert :
            // le client peut alors dire que le dossier n'est plus là.
            requested: target === wanted ? null : wanted,
            roots,
            downloads,
            defaultDir: downloadDir.DEFAULT_DIR,
            writable: downloadDir.validate(target).ok,
            dirs,
        });
    });

    return router;
}

module.exports = createApiRouter;
