const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');
const ffmpeg = require('ffmpeg-static');
const { getSession } = require('./PlaybackSession');
const { readSetAsideQueue } = require('../utils/setAsideQueue');
const { analyzePartial } = require('../utils/mp3');
const log = require('../utils/logger');
const { ytdlp, isYoutubeUrl } = require('../utils/youtubeNetwork');

/** Taille en deçà de laquelle un fichier de cache est jugé incomplet. */
const MIN_CACHE_BYTES = 1024 * 10;

/** Débits MP3 proposés dans l'interface, en kbps. */
const VALID_AUDIO_BITRATES = ['320', '256', '192', '128', '96'];
const DEFAULT_AUDIO_BITRATE = '320';

/**
 * Réglages d'import de la guild concernée, ou du premier serveur connu si la
 * piste ne permet pas de l'identifier — le tableau de bord est mono-utilisateur,
 * la valeur y est la même.
 *
 * @param {object} track
 * @returns {object|null}
 */
function importSettings(track) {
    const database = require('../database/Database');
    const guildId = track?.queue?.guild?.id || track?.requestedBy?.guildId || null;
    return guildId
        ? database.getSettings(guildId)
        : (database.cache.size > 0 ? database.getSettings([...database.cache.keys()][0]) : null);
}

/**
 * Débit de transcodage à appliquer.
 *
 * La qualité figée sur la piste prime : elle a été retenue au moment de son
 * ajout, ou choisie explicitement depuis son menu contextuel. Les réglages de
 * la box « Ajouter un fichier » ne servent que de repli pour les pistes jamais
 * figées. Une valeur inconnue retombe sur le défaut plutôt que d'être transmise
 * telle quelle à FFmpeg.
 *
 * @param {object} track - Piste préchargée
 * @returns {string} Débit en kbps
 */
function resolveAudioBitrate(track) {
    try {
        const database = require('../database/Database');

        const perTrack = database.getTrackQuality(track?.url)?.audio;
        if (VALID_AUDIO_BITRATES.includes(String(perTrack))) return String(perTrack);

        const settings = importSettings(track);
        const choice = settings && String(settings.importAudioQuality || '');
        return VALID_AUDIO_BITRATES.includes(choice) ? choice : DEFAULT_AUDIO_BITRATE;
    } catch (e) {
        return DEFAULT_AUDIO_BITRATE;
    }
}

/**
 * Ramène le débit demandé à ce que la source porte réellement.
 *
 * Le préchargement transcodait au débit voulu sans jamais regarder ce qu'il
 * avait sous la main : une piste dont la meilleure source fait 130 kbps
 * produisait un fichier nommé « 320 », et le menu l'annonçait ainsi. Le nombre
 * était exact — le transcodage est bien à débit constant — mais il décrivait le
 * contenant, pas le contenu. Monter en débit ne récupère rien : cela pèse deux
 * fois plus pour la même musique, et fait croire à une qualité qu'on n'a pas.
 *
 * Le résultat doit rester un barreau du menu, et non le débit exact de la
 * source : c'est lui qui est inscrit dans le nom du fichier en cache, et
 * l'index n'accepte que les valeurs connues. Une source à 130 devient donc 128.
 *
 * Ne touche à rien quand la source ne se laisse pas inventorier — un fichier
 * local, une plateforme que l'outil ne sait pas lire, un réseau coupé : le
 * comportement d'avant est alors préservé.
 *
 * @param {object} track
 * @param {string} asked - Débit souhaité, déjà validé.
 * @returns {Promise<string>}
 */
async function clampBitrateToSource(track, asked) {
    try {
        const url = track && track.url;
        if (!url || !/^https?:\/\//i.test(url)) return asked;

        const found = await require('./videoSource').inventory(url);
        if (!found.known || !found.audioKbps) return asked;
        if (Number(asked) <= found.audioKbps) return asked;

        const rung = VALID_AUDIO_BITRATES
            .map(Number)
            .sort((a, b) => b - a)
            .find((r) => r <= found.audioKbps);

        // Sous le plus bas barreau, on garde le plus bas : descendre plus n'est
        // pas proposé, et refuser de précharger serait pire.
        return String(rung || VALID_AUDIO_BITRATES[VALID_AUDIO_BITRATES.length - 1]);
    } catch (e) {
        return asked;
    }
}

/**
 * Chemin du fichier que cette piste désigne sur le disque du bot, ou null.
 *
 * Un fichier téléversé n'est local que pour le bot : le navigateur d'un
 * téléphone, lui, doit le télécharger comme n'importe quoi d'autre — et un WAV
 * de trente mégaoctets sur un réseau mobile se coupe en route. C'est pourquoi
 * ces fichiers sont désormais transcodés et mis en cache comme les pistes
 * distantes ; voir `getTrackKey`.
 *
 * L'existence est vérifiée : un chemin qui ne mène nulle part ne doit surtout
 * pas être pris pour une recherche textuelle, qui rapporterait un morceau au
 * hasard portant à peu près ce nom.
 *
 * @param {object} track
 * @returns {string|null}
 */
function localFilePath(track) {
    if (!track || !track.url || typeof track.url !== 'string') return null;
    if (/^https?:\/\//i.test(track.url)) return null;
    try {
        return fs.existsSync(track.url) ? track.url : null;
    } catch (e) {
        return null;
    }
}

/**
 * Échecs consécutifs d'une même piste distante avant d'aller voir si yt-dlp a
 * pris une ride.
 *
 * Trois : en deçà, c'est du réseau qui hoquette ; au-delà, on aurait cherché
 * longtemps avant de soupçonner le binaire.
 */
const FAILURES_BEFORE_VERSION_CHECK = 3;

/** Dernière version publiée de yt-dlp. */
const YTDLP_LATEST_URL = 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest';

/** Une vérification par heure au plus : l'API de GitHub compte les appels. */
const VERSION_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/** Plafond du cache de préchargement, en octets. */
const MAX_CACHE_BYTES = (Number(process.env.MAX_CACHE_MB) || 2048) * 1024 * 1024;

/**
 * Téléchargements de préchargement menés de front, au plus.
 *
 * Il n'y en avait aucun besoin tant qu'une section plafonnait à cinq pistes :
 * la boucle de planification lançait tout ce qu'elle trouvait, et elle ne
 * trouvait jamais grand-chose. Le cran « tout » des curseurs change cela — une
 * bibliothèque de deux cents titres demanderait deux cents ffmpeg simultanés,
 * c'est-à-dire une machine à genoux et une source qui commence à refuser les
 * connexions.
 *
 * Trois : assez pour que le réseau ne dorme pas pendant qu'un transcodage
 * occupe le processeur, assez peu pour que la lecture en cours ne se batte pas
 * avec son propre préchargement.
 *
 * Ce qui dépasse n'est pas perdu : la planification reprend dès qu'une place se
 * libère — voir `_schedulePump`.
 */
const MAX_PARALLEL_PRELOADS = 3;

/**
 * Décompose un nom de fichier du cache en clé de piste et débit.
 *
 * Deux formes coexistent : `<clé>.<débit>.mp3` depuis l'introduction du choix
 * de qualité, et `<clé>.mp3` pour les fichiers antérieurs, dont le débit est
 * inconnu. Ces derniers restent servis tels quels — les re-télécharger pour la
 * seule beauté du nommage gaspillerait de la bande passante.
 *
 * @param {string} fichier - Nom de fichier, extension comprise
 * @returns {{ key: string, bitrate: string|null }|null}
 */
function parseCacheName(fileName) {
    if (!fileName.endsWith('.mp3')) return null;
    const base = fileName.slice(0, -4);
    const sep = base.lastIndexOf('.');
    if (sep === -1) return { key: base, bitrate: null };

    const bitrate = base.slice(sep + 1);
    if (!VALID_AUDIO_BITRATES.includes(bitrate)) return { key: base, bitrate: null };
    return { key: base.slice(0, sep), bitrate: bitrate };
}

/** Nom de fichier de cache pour une clé et un débit donnés. */
function cacheFileName(key, bitrate) {
    return bitrate ? `${key}.${bitrate}.mp3` : `${key}.mp3`;
}

/**
 * Décompose le nom d'un fichier de préchargement en cours, `<clé>.<débit>.tmp`.
 *
 * Ces fichiers survivent désormais à l'arrêt du bot : leur nom est la seule
 * chose qui relie les octets déjà écrits à la piste et au débit qu'ils
 * concernent. Un nom qui ne suit pas cette forme désigne un temporaire d'une
 * version antérieure, inexploitable pour une reprise.
 *
 * @param {string} fichier
 * @returns {{ key: string, bitrate: string }|null}
 */
function parseTempName(fileName) {
    if (!fileName.endsWith('.tmp')) return null;
    const base = fileName.slice(0, -4);
    const sep = base.lastIndexOf('.');
    if (sep === -1) return null;

    const bitrate = base.slice(sep + 1);
    if (!VALID_AUDIO_BITRATES.includes(bitrate)) return null;
    return { key: base.slice(0, sep), bitrate: bitrate };
}

/**
 * Durée d'une piste en millisecondes, 0 si elle est inconnue.
 * @param {object} track
 * @returns {number}
 */
function trackDurationMs(track) {
    if (!track) return 0;
    if (track.durationMS) return track.durationMS;
    if (track.duration && typeof track.duration === 'string') {
        const parts = track.duration.split(':').map(Number);
        if (parts.some(isNaN)) return 0;
        if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
        if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
    }
    return 0;
}

/**
 * Écart maximal toléré entre la durée annoncée par la source et celle du
 * candidat retenu par le pont, en millisecondes.
 *
 * Un même enregistrement varie de quelques secondes d'une plateforme à
 * l'autre — silence de fin, encodage. Un remix, un live ou une version
 * étendue s'en écartent d'un tout autre ordre de grandeur.
 */
const BRIDGE_TOLERANCE_MS = 5000;

/**
 * La source de cette piste ne sert-elle que des métadonnées ?
 *
 * Spotify est protégé : son extracteur ne rend jamais de flux et délègue à un
 * autre extracteur (`SpotifyExtractor.stream` → `context.requestBridge`).
 * L'audio doit donc être trouvé ailleurs, et c'est ce détour qui doit être
 * rendu reproductible.
 *
 * @param {object} track
 * @returns {boolean}
 */
function isAudioLessSource(track) {
    if (!track || !track.url) return false;
    return track.url.includes('spotify.com')
        || track.queryType === 'spotifySong'
        || track.queryType === 'spotifyAlbum';
}

/**
 * Candidat dont la durée colle le mieux à celle annoncée par la source.
 *
 * Prendre le premier résultat d'une recherche textuelle ramenait
 * indifféremment le bon titre, un remix ou une version live. La durée est le
 * seul critère dont on dispose des deux côtés.
 *
 * Sans durée de référence, ou si aucun candidat n'entre dans la tolérance, le
 * premier résultat est rendu tout de même : c'est le comportement antérieur,
 * et une piste approximative vaut mieux qu'un préchargement qui échoue.
 *
 * @param {object[]} candidats
 * @param {number} attendueMs - Durée annoncée, 0 si inconnue
 * @returns {{ piste: object, verifie: boolean, ecartMs: number|null }}
 */
function pickByDuration(candidates, expectedMs) {
    if (!expectedMs) return { match: candidates[0], verified: false, gapMs: null };

    let bestCandidate = null;
    let bestGapMs = Infinity;
    for (const candidate of candidates) {
        const duration = trackDurationMs(candidate);
        if (!duration) continue;
        const gap = Math.abs(duration - expectedMs);
        if (gap < bestGapMs) {
            bestCandidate = candidate;
            bestGapMs = gap;
        }
    }

    if (bestCandidate && bestGapMs <= BRIDGE_TOLERANCE_MS) {
        return { match: bestCandidate, verified: true, gapMs: bestGapMs };
    }
    return {
        match: candidates[0],
        verified: false,
        gapMs: bestCandidate ? bestGapMs : null
    };
}

/**
 * Pistes à précharger après celle en cours dans une playlist.
 *
 * En lecture bouclée, la fin de la playlist n'est pas une fin de lecture :
 * les titres qui suivent la dernière piste sont ceux du début. Sans ce
 * repliement, les trois derniers morceaux se joueraient avec un préchargement
 * qui s'amenuise, et le retour au premier titre se ferait sans cache — soit
 * exactement le moment où la coupure s'entendrait.
 *
 * Une piste n'est jamais retenue deux fois : sur une playlist plus courte que
 * la fenêtre de préchargement, le repliement la ramènerait sinon en boucle.
 *
 * @param {object[]} pistes
 * @param {number} indexCourant
 * @param {number} limite - Nombre de pistes à précharger
 * @param {boolean} boucle
 * @returns {object[]}
 */
/**
 * Combien de pistes précharger pour une section, d'après le réglage enregistré.
 *
 * Le tableau de bord offre six crans par section : zéro à cinq pistes, puis un
 * dernier qui les prend toutes. « Toutes » n'étant pas un nombre, il s'enregistre
 * comme `-1` — un compte négatif n'existe dans aucun monde, là où un `6` aurait
 * cessé de vouloir dire « tout » le jour où les curseurs gagneraient un cran.
 *
 * Rendu comme `Infinity`, et non comme un très grand nombre : les trois usages
 * en aval sont des `slice(0, limite)` et un `Math.min(limite, …)`, qui le
 * traitent déjà correctement. C'est ce qui permet de ne rien changer ailleurs.
 *
 * @param {any} raw Valeur enregistrée, telle quelle.
 * @param {number} [fallback=3] Réglage par défaut, si la valeur est illisible.
 * @returns {number} Un entier de 0 à 5, ou `Infinity`.
 */
function preloadLimit(raw, fallback = 3) {
    const value = parseInt(raw ?? fallback, 10);
    if (!Number.isFinite(value)) return fallback;
    if (value < 0) return Infinity;
    return Math.min(5, value);
}

/**
 * Un flux sans adresse s'annonce à ffmpeg comme son entrée standard.
 *
 * @param {{ ffmpegInput: string|null, inputStream: object|null }} input
 */
function pipeIfStream(input) {
    if (!input.ffmpegInput && input.inputStream) return { ...input, ffmpegInput: 'pipe:0' };
    return input;
}

function upcomingTracks(tracks, currentIndex, limit, loop) {
    if (!loop) {
        return tracks.slice(currentIndex + 1, currentIndex + 1 + limit);
    }

    const upcoming = [];
    const maxCount = Math.min(limit, Math.max(0, tracks.length - 1));
    for (let i = 1; i <= maxCount; i++) {
        upcoming.push(tracks[(currentIndex + i) % tracks.length]);
    }
    return upcoming;
}

/**
 * Sens d'une requalification, pour que l'interface anime des flèches montantes
 * ou descendantes. Un débit de départ inconnu ne permet pas de trancher.
 *
 * @param {string|null} depuis
 * @param {string} vers
 * @returns {'up'|'down'|null}
 */
function qualityDirection(from, to) {
    const a = Number(from);
    const b = Number(to);
    if (!a || !b || a === b) return null;
    return b > a ? 'up' : 'down';
}

class PreloadManager {
    constructor() {
        this.player = null;
        this.cacheDir = path.join(process.cwd(), 'data', 'cache');
        this.activeDownloads = new Map(); // key -> { cancel: Function }
        this.lastTargets = new Map(); // guildId -> array of urls
        this.onProgress = null;
        this._notifyTimeout = null;

        /**
         * Suspend `update()` tant que les files ne sont pas restaurées.
         *
         * Le serveur web démarre avant `restoreAll()`, et un dashboard rouvert
         * déclenche l'évaluation des cibles toutes les secondes. Sans ce
         * verrou, un passage pendant la restauration verrait une file
         * partiellement remplie et supprimerait du cache les pistes pas encore
         * réinjectées — le préchargement de la file d'attente serait perdu à
         * chaque redémarrage. Levé par `setSuspended(false)`.
         */
        this.suspended = true;

        /**
         * Index des pistes disponibles en cache :
         * clé → { size, mtime, bitrate, file }.
         *
         * Évite de relire le disque pour chaque piste à chaque diffusion
         * d'état — le statut de préchargement est demandé une fois par seconde
         * et par piste — et permet d'appliquer le plafond de taille sans
         * réinterroger le système de fichiers.
         */
        this.cacheIndex = new Map();

        /**
         * Cibles dont le préchargement a échoué : clé → { at, tentatives }.
         *
         * Une cible manquante est retentée alors même que les files n'ont pas
         * bougé, sinon un échec réseau la laisserait absente jusqu'au prochain
         * remaniement de la file. L'espacement croissant évite qu'une URL
         * définitivement morte soit reprise à chaque seconde.
         */
        this.failures = new Map();

        /**
         * Serveurs dont la planification s'est arrêtée sur le plafond de
         * parallélisme, et qu'il faudra reprendre — voir `_schedulePump`.
         * @type {Set<string>}
         */
        this.pendingGuilds = new Set();
        /** Une reprise est déjà programmée pour le prochain tour de boucle. */
        this.pumpScheduled = false;

        /** Horodatage de la dernière vérification de version de yt-dlp. */
        this._lastVersionCheckAt = 0;
    }

    /**
     * Va voir si yt-dlp a une version plus récente, après plusieurs échecs.
     *
     * YouTube change ses défenses toutes les quelques semaines, et yt-dlp suit
     * en publiant presque aussi souvent. Un binaire vieux de dix jours suffit à
     * faire échouer toutes les pistes distantes — « Sign in to confirm you're
     * not a bot », « Streaming data not available » — pendant que les fichiers
     * locaux, eux, continuent de fonctionner. Rien dans ces messages ne désigne
     * la version comme coupable, et on cherche ailleurs.
     *
     * La vérification n'a lieu qu'après plusieurs échecs de la même piste : un
     * réseau qui hoquette ne mérite pas qu'on interroge GitHub. Elle ne
     * s'adresse qu'aux sources distantes — un fichier du disque n'a jamais eu
     * besoin de yt-dlp — et une fois l'heure au plus, l'API de GitHub comptant
     * les appels anonymes.
     *
     * Elle ne met rien à jour : elle dit ce qu'elle voit. Remplacer un binaire
     * sous les pieds d'un bot qui joue est une décision qui revient à
     * l'utilisateur, et le projet lui donne déjà « npm run update-ytdlp ».
     *
     * Aucune erreur ne remonte : un diagnostic qui échoue ne doit pas ajouter sa
     * panne à celle qu'il cherchait à expliquer.
     *
     * @param {object} track - Piste dont le préchargement vient d'échouer.
     * @param {number} attempts - Nombre d'échecs essuyés par cette piste.
     */
    async _checkYtdlpFreshness(track, attempts) {
        if (attempts !== FAILURES_BEFORE_VERSION_CHECK) return;
        if (!track || !/^https?:\/\//i.test(track.url || '')) return;

        const now = Date.now();
        if (this._lastVersionCheckAt && now - this._lastVersionCheckAt < VERSION_CHECK_INTERVAL_MS) return;
        this._lastVersionCheckAt = now;

        try {
            const installed = await this._installedYtdlpVersion();
            const latest = await this._latestYtdlpVersion();
            if (!installed || !latest) return;

            // Les versions de yt-dlp sont des dates — « 2026.08.19 » : l'ordre
            // lexicographique est l'ordre chronologique.
            if (latest > installed) {
                log.warn(`[PreloadManager] ${attempts} failed preloads in a row for a remote track. `
                    + `yt-dlp installed: ${installed}, latest published: ${latest} — a newer version exists. `
                    + `YouTube changes its defences often; « npm run update-ytdlp » is usually what unblocks this.`);
            } else {
                log.info(`[PreloadManager] ${attempts} failed preloads in a row for a remote track, `
                    + `but yt-dlp is up to date (${installed}): the cause lies elsewhere — `
                    + `throttling by the source, or a track that is no longer available.`);
            }
        } catch (e) {
            // Diagnostic muet : voir l'en-tête.
        }
    }

    /**
     * Version du binaire yt-dlp réellement installé.
     * @returns {Promise<string|null>}
     */
    _installedYtdlpVersion() {
        return new Promise((resolve) => {
            let binary;
            try {
                binary = require('youtube-dl-exec').constants.YOUTUBE_DL_PATH;
            } catch (e) {
                return resolve(null);
            }

            let output = '';
            let child;
            try {
                child = cp.spawn(binary, ['--version'], { windowsHide: true });
            } catch (e) {
                return resolve(null);
            }

            const done = (value) => {
                try { child.kill(); } catch (e) {}
                resolve(value);
            };

            const timer = setTimeout(() => done(null), 10000);
            child.stdout.on('data', (chunk) => { output += chunk.toString(); });
            child.on('error', () => { clearTimeout(timer); resolve(null); });
            child.on('close', () => {
                clearTimeout(timer);
                resolve(output.trim() || null);
            });
        });
    }

    /**
     * Dernière version publiée de yt-dlp, d'après GitHub.
     * @returns {Promise<string|null>}
     */
    async _latestYtdlpVersion() {
        try {
            const response = await fetch(YTDLP_LATEST_URL, {
                headers: {
                    Accept: 'application/vnd.github+json',
                    // GitHub refuse les requêtes anonymes sans en-tête d'agent.
                    'User-Agent': 'interactive-music-player',
                },
                signal: AbortSignal.timeout(8000),
            });
            if (!response.ok) return null;
            const data = await response.json();
            return (data && typeof data.tag_name === 'string') ? data.tag_name.trim() : null;
        } catch (e) {
            return null;
        }
    }

    /**
     * Délai à respecter avant de retenter une cible, en millisecondes.
     * @param {number} tentatives - Échecs déjà essuyés
     * @returns {number}
     */
    _retryDelayMs(attempts) {
        return Math.min(15 * 60 * 1000, 30 * 1000 * 2 ** Math.max(0, attempts - 1));
    }

    /**
     * Une cible attend-elle un téléchargement qui pourrait démarrer maintenant ?
     *
     * @param {Map<string, object>} cibles - Clé → piste
     * @returns {boolean}
     */
    _hasTargetToRetry(targetMap) {
        const nowMs = Date.now();
        for (const key of targetMap.keys()) {
            if (this.cacheIndex.has(key)) continue;
            if (this._activeDownloadFor(key)) continue;
            const failure = this.failures.get(key);
            if (!failure || nowMs - failure.at >= this._retryDelayMs(failure.attempts)) {
                return true;
            }
        }
        return false;
    }

    /** Reconstruit l'index du cache à partir du contenu du dossier. */
    _buildCacheIndex() {
        this.cacheIndex.clear();
        try {
            for (const file of fs.readdirSync(this.cacheDir)) {
                const parsed = parseCacheName(file);
                if (!parsed) continue;
                try {
                    const stat = fs.statSync(path.join(this.cacheDir, file));
                    if (stat.size <= MIN_CACHE_BYTES) continue;

                    // Une requalification interrompue peut laisser deux fichiers
                    // pour la même piste : on retient le plus récent, qui est le
                    // seul que la bascule aurait conservé.
                    const known = this.cacheIndex.get(parsed.key);
                    if (known && known.mtime >= stat.mtimeMs) continue;

                    this.cacheIndex.set(parsed.key, {
                        size: stat.size,
                        mtime: stat.mtimeMs,
                        bitrate: parsed.bitrate,
                        file
                    });
                } catch (e) {}
            }
        } catch (e) {
            // Dossier absent : index vide
        }
    }

    /**
     * Supprime du disque le fichier de cache d'une piste.
     * @param {string} key
     * @param {string} [fichier] - Nom précis ; sinon celui de l'index
     * @returns {boolean} true si un fichier a bien été retiré
     */
    _deleteCacheFile(key, fileName) {
        const name = fileName || this.cacheIndex.get(key)?.file;
        if (!name) return false;
        try {
            fs.unlinkSync(path.join(this.cacheDir, name));
            return true;
        } catch (e) {
            return false;
        }
    }

    /** Identifiant d'un téléchargement : une piste peut en avoir deux, à des débits différents. */
    _downloadKey(key, bitrate) {
        return `${key}@${bitrate}`;
    }

    /** Chemin du fichier partiel d'un préchargement en cours. */
    _tempPath(key, bitrate) {
        return path.join(this.cacheDir, `${key}.${bitrate}.tmp`);
    }

    /**
     * Mémorise la source réellement encodée dans un fichier partiel.
     *
     * La clé de piste dérive de l'URL demandée, pas de celle qui a fini par
     * être encodée : un titre Spotify est ponté vers YouTube, et rien ne
     * garantit que la recherche retombe sur la même vidéo au redémarrage
     * suivant. Reprendre un partiel sans cette vérification recollerait la
     * seconde moitié d'un morceau à la première moitié d'un autre.
     *
     * @param {string} tmpPath
     * @param {string} source - URL résolue
     */
    _writeSource(tmpPath, source) {
        try {
            fs.writeFileSync(`${tmpPath}.src`, source, 'utf8');
        } catch (e) {
            // Sans ce fichier, le partiel sera simplement réencodé de zéro
        }
    }

    /** Source mémorisée pour un fichier partiel, null si elle est inconnue. */
    _readSource(tmpPath) {
        try {
            return fs.readFileSync(`${tmpPath}.src`, 'utf8').trim() || null;
        } catch (e) {
            return null;
        }
    }

    /** Supprime un fichier partiel et la source qui l'accompagne. */
    _deleteTemp(tmpPath) {
        for (const entryPath of [tmpPath, `${tmpPath}.src`]) {
            try { fs.unlinkSync(entryPath); } catch (e) {}
        }
    }

    /**
     * Mesure ce qui est déjà encodé dans un fichier partiel.
     *
     * @param {string} tmpPath
     * @returns {{ octets: number, secondes: number }|null} null si le partiel
     *   est absent, illisible, ou trop court pour valoir une reprise
     */
    _resumableFrom(tmpPath) {
        const parsed = analyzePartial(tmpPath);
        if (parsed.bytes <= MIN_CACHE_BYTES) return null;
        return parsed;
    }

    /**
     * Fait le tri dans les fichiers partiels laissés par la session précédente.
     *
     * Ils étaient auparavant tous supprimés au démarrage : un préchargement
     * interrompu à 95 % repartait de zéro à chaque redémarrage du bot, et un
     * arrêt régulier suffisait à ce que les longues pistes ne se cachent
     * jamais. Ne sont désormais écartés que ceux dont il n'y a rien à tirer.
     */
    _sortTempFiles() {
        let resumed = 0;
        let discarded = 0;

        let dirFiles;
        try {
            dirFiles = fs.readdirSync(this.cacheDir);
        } catch (e) {
            return;
        }

        for (const fileName of dirFiles) {
            const entryPath = path.join(this.cacheDir, fileName);

            // Source orpheline : son partiel a disparu, elle ne sert plus à rien
            if (fileName.endsWith('.tmp.src')) {
                if (!fs.existsSync(entryPath.slice(0, -4))) {
                    try { fs.unlinkSync(entryPath); } catch (e) {}
                }
                continue;
            }

            if (!fileName.endsWith('.tmp')) continue;

            const parsed = parseTempName(fileName);
            const resumeInfo = parsed ? this._resumableFrom(entryPath) : null;
            if (!resumeInfo) {
                this._deleteTemp(entryPath);
                discarded++;
                continue;
            }

            resumed++;
            log.info(`[PreloadManager] Partial preload found again (${parsed.bitrate} kbps): `
                + `${resumeInfo.seconds.toFixed(0)} s already encoded, the resume will pick up from there.`);
        }

        if (discarded > 0) {
            log.info(`[PreloadManager] ${discarded} unusable temporary file(s) deleted.`);
        }
        if (resumed > 0) {
            log.success(`[PreloadManager] ${resumed} preload(s) will resume where they left off.`);
        }
    }

    /**
     * Téléchargement en cours pour une piste, quel que soit son débit.
     * @param {string} key
     * @returns {object|null}
     */
    _activeDownloadFor(key) {
        for (const [dlKey, dl] of this.activeDownloads.entries()) {
            if (dlKey.startsWith(`${key}@`)) return dl;
        }
        return null;
    }

    /** Taille totale du cache, en octets. */
    getCacheSize() {
        let total = 0;
        for (const entry of this.cacheIndex.values()) total += entry.size;
        return total;
    }

    /**
     * Ramène le cache sous son plafond en supprimant les fichiers les plus
     * anciens.
     *
     * La purge par pertinence de `update()` ne suffit pas : elle ne retire que
     * les pistes qui ne sont cibles pour aucun serveur. Avec plusieurs
     * playlists volumineuses, l'ensemble des cibles peut à lui seul dépasser
     * toute limite raisonnable.
     *
     * @param {Set<string>} protectedKeys - Clés à ne jamais évincer (pistes en cours)
     * @returns {number} Nombre de fichiers supprimés
     */
    enforceCacheLimit(protectedKeys = new Set()) {
        let total = this.getCacheSize();
        if (total <= MAX_CACHE_BYTES) return 0;

        // Les plus anciens d'abord : approximation raisonnable du moins utile
        const candidates = [...this.cacheIndex.entries()]
            .filter(([key]) => !protectedKeys.has(key))
            .sort((a, b) => a[1].mtime - b[1].mtime);

        let removed = 0;
        for (const [key, entry] of candidates) {
            if (total <= MAX_CACHE_BYTES) break;
            if (this._deleteCacheFile(key, entry.file)) {
                this.cacheIndex.delete(key);
                total -= entry.size;
                removed++;
            }
        }

        if (removed > 0) {
            log.info(`[PreloadManager] Cache ceiling reached: ${removed} file(s) evicted, `
                + `${(total / 1024 / 1024).toFixed(0)} MB left out of ${MAX_CACHE_BYTES / 1024 / 1024} MB.`);
        } else {
            log.warn('[PreloadManager] Cache ceiling exceeded but no file can be evicted '
                + '(every track is currently playing).');
        }
        return removed;
    }

    /**
     * Active ou lève la suspension des mises à jour de préchargement.
     * @param {boolean} suspended
     */
    setSuspended(suspended) {
        this.suspended = !!suspended;
    }

    notifyProgress() {
        if (this._notifyTimeout) return;
        this._notifyTimeout = setTimeout(() => {
            this._notifyTimeout = null;
            if (typeof this.onProgress === 'function') {
                try { this.onProgress(); } catch (e) {}
            }
        }, 150);
    }

    getPreloadStatus(track) {
        const empty = { isPreloaded: false, isPreloading: false, preloadProgress: 0, cachedAudioQuality: null, requalify: null };
        if (!track) return empty;
        const key = this.getTrackKey(track);
        if (!key) return empty;

        // Index mémoire plutôt que disque : ce chemin est emprunté pour chaque
        // piste à chaque diffusion d'état.
        const entry = this.cacheIndex.get(key);
        const dl = this._activeDownloadFor(key);

        if (entry) {
            return {
                isPreloaded: true,
                isPreloading: false,
                preloadProgress: 100,
                cachedAudioQuality: entry.bitrate,
                // Requalification : l'ancien fichier reste servi pendant que le
                // nouveau se télécharge, d'où un état « préchargé » ET « en
                // cours » que l'interface superpose.
                requalify: dl ? {
                    progress: dl.progress !== undefined ? dl.progress : 5,
                    from: dl.requalifyFrom || entry.bitrate,
                    to: dl.bitrate,
                    direction: qualityDirection(dl.requalifyFrom || entry.bitrate, dl.bitrate)
                } : null
            };
        }

        if (dl) {
            return {
                isPreloaded: false,
                isPreloading: true,
                preloadProgress: dl.progress !== undefined ? dl.progress : 10,
                cachedAudioQuality: null,
                requalify: null
            };
        }

        return empty;
    }

    /**
     * Relance le préchargement d'une piste à un autre débit.
     *
     * L'ancien fichier n'est pas supprimé : il continue d'alimenter la lecture
     * jusqu'à ce que le nouveau soit complet et validé, la bascule se faisant
     * alors en une seule opération. Une coupure réseau laisse donc la piste
     * jouable à son débit précédent.
     *
     * @param {object} track
     * @param {string} nouveauDebit
     * @returns {boolean} true si une requalification a bien été lancée
     */
    requalify(track, newBitrate) {
        if (!VALID_AUDIO_BITRATES.includes(String(newBitrate))) return false;
        const key = this.getTrackKey(track);
        if (!key) return false;

        const entry = this.cacheIndex.get(key);
        if (!entry) return false;                       // Pas en cache : rien à requalifier
        if (entry.bitrate === String(newBitrate)) return false;
        if (this.activeDownloads.has(this._downloadKey(key, newBitrate))) return false;

        log.info(`[PreloadManager] Requalifying ${track.title}: ${entry.bitrate || 'unknown'} → ${newBitrate} kbps.`);
        this.startDownload(track, key, String(newBitrate), entry.bitrate);
        return true;
    }

    /**
     * Initialise le PreloadManager.
     * @param {import('discord-player').Player} player - L'instance de discord-player
     */
    init(player) {
        this.player = player;

        // Assurer que le dossier cache existe
        if (!fs.existsSync(this.cacheDir)) {
            fs.mkdirSync(this.cacheDir, { recursive: true });
        }

        // Conserver les préchargements interrompus par la session précédente,
        // écarter ceux qui ne sont pas exploitables
        try {
            this._sortTempFiles();
        } catch (e) {
            log.error('[PreloadManager] Error sorting the temporary files at startup:', e.message);
        }

        this._buildCacheIndex();

        // Intercepter la méthode stream de tous les extracteurs enregistrés
        player.extractors.store.forEach((extractor) => {
            if (typeof extractor.stream === 'function') {
                const originalStream = extractor.stream;
                extractor.stream = async (track, ...args) => {
                    // Le cache sert les navigateurs, à qui il épargne un
                    // téléchargement. Le bot, lui, a le fichier d'origine sous
                    // la main : lui servir la copie compressée retirerait de la
                    // qualité à la diffusion Discord sans rien faire gagner.
                    const cachedPath = localFilePath(track) ? null : this.getCachedPath(track);
                    if (cachedPath) {
                        log.info(`[PreloadManager] Cached stream of ${track.title} served from the local disk.`);
                        return fs.createReadStream(cachedPath);
                    }

                    // Hors cache, une source sans audio serait pontée par
                    // l'extracteur lui-même, avec sa propre recherche : c'est
                    // par là que les deux modes de diffusion divergeaient. Le
                    // pont mémorisé les remet d'accord ; null laisse le
                    // comportement d'origine reprendre la main.
                    const bridgedStream = await this._streamFromBridge(track);
                    if (bridgedStream) return bridgedStream;

                    return originalStream.apply(extractor, [track, ...args]);
                };
            }
        });

        log.info('[PreloadManager] Initialised, stream extractors intercepted.');
    }

    /**
     * Calcule la clé unique pour une piste.
     * @param {object} track - La piste discord-player
     * @returns {string|null} - Hash SHA-256 de l'URL ou null si c'est un fichier local
     */
    getTrackKey(track) {
        if (!track || !track.url) return null;

        // Les fichiers du disque entrent dans le cache comme les autres. Ils en
        // étaient exclus au motif qu'ils sont « déjà locaux » — ce qui est vrai
        // pour le bot, et faux pour le navigateur qui les écoute : en diffusion
        // personnelle, un WAV de trente mégaoctets traverse le réseau à chaque
        // lecture. Transcodés une fois, ils en font cinq.
        //
        // Reste à écarter ce qui ne mène nulle part : ni URL, ni fichier.
        if (!/^https?:\/\//i.test(track.url) && !localFilePath(track)) return null;

        return crypto.createHash('sha256').update(track.url).digest('hex');
    }

    /**
     * Rend une piste réellement jouable : hydratée, pontée, extracteur en main.
     *
     * Une piste venue d'une playlist enregistrée n'est qu'un objet nu — titre,
     * auteur, URL —, relu du disque et jamais passé par le lecteur. Aucun
     * extracteur ne sait quoi en faire : appeler `stream()` dessus rend un flux
     * qui ne produit rien, sans lever la moindre erreur. C'est `player.search`
     * qui la ramène à une vraie piste, avec son extracteur et ses métadonnées.
     *
     * Le pont vient ensuite : une source sans audio — Spotify et consorts —
     * doit être renvoyée vers une source qui en a, faute de quoi la résolution
     * suivante buterait sur le DRM.
     *
     * @param {object} track - Piste, éventuellement réduite à son URL.
     * @returns {Promise<{ track: object, url: string }>}
     */
    async resolvePlayableTrack(track) {
        let targetTrack = track;
        if (this.player && (!targetTrack.extractor || typeof targetTrack.extractor.stream !== 'function')) {
            try {
                // Un chemin disque doit être annoncé comme tel : livré à la
                // recherche ordinaire, il partirait pour une requête textuelle
                // sur YouTube et rapporterait un tout autre morceau.
                const { QueryType } = require('discord-player');
                const searchRes = await this.player.search(track.url,
                    localFilePath(track) ? { searchEngine: QueryType.FILE } : {});
                if (searchRes && searchRes.tracks.length > 0) {
                    targetTrack = searchRes.tracks[0];
                    log.info(`[PreloadManager] Track hydrated on the fly through player.search for: ${targetTrack.title}`);
                }
            } catch (e) {}
        }

        // Le pont est vérifié par la durée et mémorisé, pour que le fichier mis
        // en cache soit celui que la lecture directe emploie.
        const bridgedTrack = await this._resolveBridge(targetTrack, track.title);
        if (bridgedTrack) targetTrack = bridgedTrack;

        let targetUrl = targetTrack && targetTrack.url ? targetTrack.url : (track.url || '');
        if (targetUrl.includes('music.youtube.com')) {
            targetUrl = targetUrl.replace('music.youtube.com', 'www.youtube.com');
        }

        if (!targetTrack.extractor && this.player) {
            for (const [_, ext] of this.player.extractors.store.entries()) {
                try {
                    if (await ext.validate(targetUrl, targetTrack.queryType)) {
                        targetTrack.extractor = ext;
                        log.info(`[PreloadManager] Extractor resolved on the fly for ${targetTrack.title}: ${ext.constructor.name}`);
                        break;
                    }
                } catch (e) {}
            }
        }

        return { track: targetTrack, url: targetUrl };
    }

    /**
     * De quoi alimenter ffmpeg pour une piste distante : une URL directe, ou un
     * flux à pousser dans son entrée standard.
     *
     * Un extracteur rend l'un ou l'autre selon sa nature, et parfois un objet
     * qui enveloppe l'un des deux. Les quatre formes sont ramenées ici aux deux
     * seules que ffmpeg connaisse. Quand aucune ne se dégage — cas courant de
     * YouTube, dont le flux direct se refuse ou expire —, youtube-dl-exec est
     * interrogé pour une URL audio directe.
     *
     * L'appelant fournit le contexte d'extraction s'il en faut un : la méthode
     * n'en pose pas, pour ne pas le refermer avant que le flux qu'elle rend ait
     * fini d'être lu.
     *
     * @param {object} track - Piste jouable, telle que rendue par
     *   `resolvePlayableTrack`.
     * @param {string} url - URL résolue de cette piste.
     * @returns {Promise<{ ffmpegInput: string|null, inputStream: object|null }>}
     *   `ffmpegInput` vaut `pipe:0` lorsque c'est `inputStream` qui alimente.
     *   Les deux sont nuls quand rien n'a pu être résolu.
     */
    async resolveAudioInput(track, url, { background = false } = {}) {
        // Fichier du disque : ffmpeg le lit à même le chemin. Rien à extraire,
        // et il peut s'y déplacer — ce qu'un flux poussé dans son entrée
        // standard ne permet pas, et dont la reprise d'un encodage interrompu a
        // besoin.
        const local = localFilePath(track);
        if (local) return { ffmpegInput: local, inputStream: null };

        const web = /^https?:\/\//i.test(url);

        /*
         * YouTube : yt-dlp d'abord, l'extracteur en secours seulement.
         *
         * L'ordre des autres sources — l'extracteur, puis yt-dlp s'il n'a pas
         * rendu d'adresse directe — ouvrait pour YouTube un flux par youtubei,
         * interrogeait ensuite yt-dlp, et jetait le premier flux. Chaque
         * préchargement coûtait ainsi deux descriptions de la vidéo et une
         * connexion à googlevideo ouverte pour rien : autant de demandes qui
         * font passer pour un robot. Voir utils/youtubeNetwork.
         */
        if (web && isYoutubeUrl(url)) {
            const direct = await this._inputFromYtdlp(track, url, { background });
            if (direct) return direct;
            log.info(`[PreloadManager] yt-dlp found nothing usable for ${track.title}: `
                + 'falling back to the extractor stream.');
            return pipeIfStream(await this._inputFromExtractor(track, url));
        }

        const fromExtractor = await this._inputFromExtractor(track, url);

        // Pas d'URL directe, et la piste vient du web : youtube-dl en sait plus
        // que l'extracteur sur les formats réellement servis.
        if (!fromExtractor.ffmpegInput && web) {
            const direct = await this._inputFromYtdlp(track, url, { background });
            if (direct) {
                // Le flux de l'extracteur ne sera pas lu : le laisser ouvert
                // retiendrait sa connexion et ses tampons jusqu'à la fin du
                // préchargement.
                const stale = fromExtractor.inputStream;
                if (stale && typeof stale.destroy === 'function') stale.destroy();
                return direct;
            }
            if (fromExtractor.inputStream) {
                // Rien d'utilisable, mais l'extracteur avait fourni un flux : on
                // le garde plutôt que de repartir les mains vides — c'est lui
                // qui alimentait avant ce détour.
                log.info(`[PreloadManager] No direct audio format for ${track.title}: `
                    + `keeping the extractor stream.`);
            }
        }

        return pipeIfStream(fromExtractor);
    }

    /**
     * Ce que l'extracteur de la piste sait en tirer : une adresse directe, ou
     * un flux. Les quatre formes qu'il peut rendre sont ramenées à ces deux-là.
     *
     * @returns {Promise<{ ffmpegInput: string|null, inputStream: object|null }>}
     */
    async _inputFromExtractor(track, url) {
        let rawStreamObj = null;
        if (this.player && this.player.extractors) {
            try {
                const streamInfo = await this.player.extractors.run(async (ext) => {
                    if (track.extractor && ext.identifier !== track.extractor.identifier) {
                        return false;
                    }
                    if (await ext.validate(url, track.queryType)) {
                        return await ext.stream(track);
                    }
                    return false;
                });
                if (streamInfo && streamInfo.result) {
                    rawStreamObj = streamInfo.result;
                    log.info(`[PreloadManager Debug] Stream extracted through player.extractors.run (Extractor: ${streamInfo.extractor?.constructor?.name})`);
                }
            } catch (e) {
                log.error(`[PreloadManager Debug] player.extractors.run failed:`, e.message);
            }
        }

        if (!rawStreamObj) {
            if (track.extractor && typeof track.extractor.stream === 'function') {
                rawStreamObj = await track.extractor.stream(track);
            } else if (this.player && typeof this.player.extractors.stream === 'function') {
                rawStreamObj = await this.player.extractors.stream(track);
            }
        }

        let ffmpegInput = null;
        let inputStream = null;

        if (rawStreamObj) {
            if (typeof rawStreamObj === 'string' && (rawStreamObj.startsWith('http://') || rawStreamObj.startsWith('https://'))) {
                ffmpegInput = rawStreamObj;
            } else if (rawStreamObj.url && typeof rawStreamObj.url === 'string' && (rawStreamObj.url.startsWith('http://') || rawStreamObj.url.startsWith('https://'))) {
                ffmpegInput = rawStreamObj.url;
            } else if (typeof rawStreamObj.pipe === 'function') {
                inputStream = rawStreamObj;
            } else if (rawStreamObj.stream && typeof rawStreamObj.stream.pipe === 'function') {
                inputStream = rawStreamObj.stream;
            }
        }

        return { ffmpegInput, inputStream };
    }

    /**
     * Ce que yt-dlp en tire : le meilleur flux audio, téléchargé par tranches,
     * ou à défaut l'adresse unique qu'il rend. Null quand il n'en tire rien.
     *
     * Une pause du travail de fond remonte telle quelle, au lieu d'être prise
     * pour un échec ordinaire : l'appelant se rabattrait sinon sur l'extracteur,
     * c'est-à-dire sur une autre demande à YouTube au moment précis où il ne
     * faut plus lui en faire.
     *
     * @param {{ background?: boolean }} [how] - Voir `ytdlp()`.
     * @returns {Promise<{ ffmpegInput: string|null, inputStream: object|null }|null>}
     */
    async _inputFromYtdlp(track, url, { background = false } = {}) {
        try {
            log.info(`[PreloadManager] Resolving a direct audio URL through youtube-dl-exec for: ${track.title}`
                + (background ? ' (background, paced)' : ''));
            const info = await ytdlp(url, {
                dumpSingleJson: true,
                noCheckCertificates: true,
                noWarnings: true,
                preferFreeFormats: true,
            }, { windowsHide: true }, { background });

            const entry = (info.entries && info.entries[0]) ? info.entries[0] : info;
            if (entry && entry.formats) {
                /*
                 * Le choix se fait dans `videoSource`, avec celui des
                 * téléchargements.
                 *
                 * Ici, on prenait le premier format sonore de la liste. Or
                 * yt-dlp ordonne du pire au meilleur et place les variantes HLS
                 * en tête : le premier était un manifeste `.m3u8`, dans un
                 * doublage automatique tiré au hasard, sans débit annoncé.
                 * L'adresse était bien « extraite » — le journal l'annonçait en
                 * succès — et ffmpeg se prenait un 404 sur un manifeste signé
                 * pour un autre client.
                 */
                const chosen = require('./videoSource').bestAudio(entry);
                if (!chosen || !chosen.url) return null;

                /*
                 * L'adresse est téléchargée par tranches, et non tendue telle
                 * quelle à ffmpeg.
                 *
                 * YouTube bride un téléchargement progressif continu au débit
                 * de lecture : ffmpeg, qui ouvre une requête et la garde
                 * ouverte, écrivait 32 Ko/s — deux fois le temps réel, douze
                 * minutes pour un morceau de vingt-cinq. La même adresse
                 * demandée par tranches se sert à 38 Mo/s. Voir `rangeStream`.
                 */
                const inputStream = require('./rangeStream').chunkedFetch(chosen.url, {
                    // Ceux que yt-dlp a employés pour obtenir l'adresse.
                    headers: chosen.http_headers || {},
                });

                const langue = chosen.language ? `, ${chosen.language}` : '';
                log.success(`[PreloadManager] Direct URL extracted successfully for: `
                    + `${track.title} (${chosen.format_id}, `
                    + `${Math.round(Number(chosen.abr) || 0) || '?'} kbps${langue})`);
                return { ffmpegInput: 'pipe:0', inputStream };
            }
            if (entry && entry.url) return { ffmpegInput: entry.url, inputStream: null };
            return null;
        } catch (ytdlErr) {
            if (ytdlErr && ytdlErr.code === 'YOUTUBE_PAUSED') throw ytdlErr;
            log.error(`[PreloadManager] youtube-dl-exec resolution warning for ${track.title}:`,
                (ytdlErr && ytdlErr.message) || ytdlErr);
            return null;
        }
    }

    /**
     * Renvoie le chemin d'accès au fichier cache si la piste est entièrement stockée localement.
     * @param {object} track - La piste
     * @returns {string|null} - Le chemin absolu du fichier MP3 ou null
     */
    getCachedPath(track) {
        const key = this.getTrackKey(track);
        if (!key) return null;

        // L'index donne le nom exact, qui porte le débit du fichier. On repasse
        // tout de même par le disque : une suppression externe ne doit pas
        // faire échouer la lecture plus loin.
        const name = this.cacheIndex.get(key)?.file;
        const candidates = name ? [name, cacheFileName(key, null)] : [cacheFileName(key, null)];

        for (const candidate of candidates) {
            const filePath = path.join(this.cacheDir, candidate);
            try {
                const stat = fs.statSync(filePath);
                if (stat.size > MIN_CACHE_BYTES) return filePath;
            } catch (e) {}
        }
        return null;
    }

    /**
     * File d'attente mise de côté pendant qu'une playlist occupe le lecteur.
     *
     * En diffusion personnelle, la sauvegarde distingue une piste courante de
     * la suite ; c'est pourtant un seul et même ensemble du point de vue du
     * préchargement, et la piste courante en est le premier titre — celui qui
     * repartirait en premier au retour à la file.
     *
     * C'est une simple liste, la même dans les deux modes de diffusion et la
     * même que celle affichée par le panneau : la fenêtre réglée par
     * `queueCount` porte donc exactement sur les titres annoncés.
     *
     * @param {object} settings
     * @returns {object[]} Pistes, de la première à la dernière
     */
    _setAsideQueue(settings) {
        return readSetAsideQueue(settings);
    }

    /**
     * Récupère la liste des pistes qui doivent être préchargées pour une guild donnée.
     * @param {object} queue - La queue discord-player de la guild
     * @param {object} settings - Les réglages de la guild
     * @returns {object[]} - Tableau de pistes
     */
    getActivePreloadTracks(queue, settings) {
        // La session masque la distinction entre lecteur réel et lecteur virtuel
        const session = getSession(queue);
        const current = session.getCurrentTrack();
        const nextTracks = session.getTracks();
        const prevTracks = session.getHistory();

        const preloading = settings.preloading || { enabled: true, queueCount: 3, historyCount: 3, playlistCount: 3 };
        if (preloading.enabled === false) return [];

        const historyLimit = preloadLimit(preloading.historyCount);
        const queueLimit = preloadLimit(preloading.queueCount);
        const playlistLimit = preloadLimit(preloading.playlistCount);

        const sourceIsPlaylist = !!settings.activePlaybackSource
            && settings.activePlaybackSource.startsWith('playlist_');

        const targets = [];

        if (current) {
            targets.push(current);
        }

        if (queueLimit > 0) {
            /*
             * Où se trouve la file d'attente de l'utilisateur, au juste.
             *
             * Le lecteur n'a qu'une liste de pistes. Quand une playlist
             * l'occupe, c'est **elle** que `getTracks()` rend, et la file de
             * l'utilisateur est mise de côté dans les réglages.
             *
             * Les deux cas étaient servis à la suite, si bien que la liste du
             * lecteur passait sous `queueCount` quoi qu'elle contienne : régler
             * la file d'attente sur « tout » préchargeait alors toute la
             * playlist en cours, file vide comprise. Les tranches de la playlist
             * relèvent de `playlistCount`, et le bloc plus bas s'en charge déjà
             * à partir de la base — d'où un choix, et non deux ajouts.
             */
            const userQueue = sourceIsPlaylist
                ? this._setAsideQueue(settings)
                : nextTracks;

            if (userQueue.length > 0) {
                targets.push(...userQueue.slice(0, queueLimit));
            }
        }

        if (historyLimit > 0 && prevTracks.length > 0) {
            // `getHistory()` rend la piste la plus récente en tête — c'est
            // l'ordre d'une file LIFO, et celui du panneau « historique ». Ce
            // sont ses premiers titres qu'il faut précharger : ce sont les
            // seuls qu'un retour en arrière atteindra.
            targets.push(...prevTracks.slice(0, historyLimit));
        }

        if (playlistLimit > 0) {
            try {
                const database = require('../database/Database');
                const globalPlaylists = database.getGlobalPlaylists() || [];

                // La playlist en cours de lecture d'abord : ce sont ses titres
                // à venir qu'il faut avoir sous la main en premier, sous peine
                // d'entendre la coupure au changement de morceau.
                if (sourceIsPlaylist) {
                    const activePlaylist = globalPlaylists.find(p => p.id === settings.activePlaybackSource);
                    if (activePlaylist && activePlaylist.tracks && activePlaylist.tracks.length > 0) {
                        const currentIdx = typeof settings.playlistCurrentIndex === 'number' ? settings.playlistCurrentIndex : 0;
                        targets.push(...upcomingTracks(
                            activePlaylist.tracks, currentIdx, playlistLimit, !!settings.loopPlaylist
                        ));
                    }
                }

                // Puis les premiers titres de chaque playlist, celle en cours
                // comprise. Le préchargement d'une playlist ne dépend pas de ce
                // qui joue : lancer une playlist ne doit pas vider le cache des
                // autres, sans quoi les rejoindre coûterait un rechargement
                // complet — et la lecture démarrerait sur une coupure.
                globalPlaylists.forEach(pl => {
                    if (pl.tracks && pl.tracks.length > 0) {
                        targets.push(...pl.tracks.slice(0, playlistLimit));
                    }
                });
            } catch (e) {
                log.error('[PreloadManager] Error getting playlist preload targets:', e.message);
            }
        }

        /*
         * Les aiguillages ne se préchargent pas.
         *
         * Ils voyagent dans les playlists comme des éléments ordinaires, et
         * c'est ce qui leur permet de se déplacer et de se supprimer comme les
         * titres. Mais ils ne désignent aucun flux : les laisser passer ici
         * lancerait un ffmpeg sur une adresse `transition:` à chaque
         * recalcul des cibles, pour un échec chaque fois.
         *
         * Filtré une fois en sortie plutôt qu'à chacune des trois provenances :
         * une quatrième oublierait le filtre.
         */
        return require('./transitions').withoutTransitions(targets);
    }

    /**
     * Met à jour la file de préchargement pour un serveur (démarre/annule les téléchargements et nettoie le cache).
     * @param {string} guildId
     */
    update(guildId) {
        if (this.suspended) return;
        if (!this.player) return;
        const queue = this.player.queues.get(guildId);
        if (!queue) return;

        const database = require('../database/Database');
        const settings = database.getSettings(guildId);

        const activeTracks = this.getActivePreloadTracks(queue, settings);
        const targetKeys = new Map(); // key -> track

        activeTracks.forEach(track => {
            const key = this.getTrackKey(track);
            if (key) {
                targetKeys.set(key, track);
            }
        });

        const urls = Array.from(targetKeys.values()).map(t => t.url);
        const last = this.lastTargets.get(guildId) || [];
        const unchanged = urls.length === last.length && urls.every((url, i) => url === last[i]);

        // Une liste inchangée ne dispense pas d'un passage : elle peut contenir
        // une cible ni cachée ni en cours, laissée par un échec ou une
        // annulation. Sans cette relance, elle resterait manquante jusqu'au
        // prochain remaniement de la file — soit, sur une file stable, jamais.
        if (unchanged && !this._hasTargetToRetry(targetKeys)) return;

        this.lastTargets.set(guildId, urls);

        if (!unchanged) {
            log.info(`[PreloadManager] Preload targets updated for guild ${guildId} (${urls.length} tracks).`);
        }

        // 1. Annuler les téléchargements actifs obsolètes (qui ne sont cibles pour AUCUNE guild active)
        const allGuildTargetKeys = new Set();
        for (const [_, gUrls] of this.lastTargets.entries()) {
            gUrls.forEach(url => {
                const key = crypto.createHash('sha256').update(url).digest('hex');
                allGuildTargetKeys.add(key);
            });
        }

        const now = Date.now();
        for (const [dlKey, download] of this.activeDownloads.entries()) {
            if (!allGuildTargetKeys.has(download.key)) {
                // Protection contre les annulations prématurées : ne pas annuler un téléchargement démarré il y a moins de 5 secondes
                if (download.startTime && (now - download.startTime < 5000)) {
                    continue;
                }
                log.info(`[PreloadManager] Cancelling the stale preload for key: ${dlKey}`);
                download.cancel();
            }
        }

        // 2. Supprimer les fichiers caches inutilisés (qui ne sont plus cibles pour AUCUNE guild active)
        try {
            const files = fs.readdirSync(this.cacheDir);
            files.forEach(file => {
                // Les partiels sont conservés d'un démarrage à l'autre : sans
                // purge ici, celui d'une piste retirée de la file resterait sur
                // le disque indéfiniment. Un partiel devenu inutile est aussi
                // celui dont la piste est désormais entièrement cachée, la
                // requalification en cours mise à part.
                const tmp = parseTempName(file);
                if (tmp) {
                    const isTarget = allGuildTargetKeys.has(tmp.key);
                    const isActive = this.activeDownloads.has(this._downloadKey(tmp.key, tmp.bitrate));
                    if (!isActive && (!isTarget || this.cacheIndex.has(tmp.key))) {
                        this._deleteTemp(path.join(this.cacheDir, file));
                        log.info(`[PreloadManager] Useless partial preload deleted: ${file}`);
                    }
                    return;
                }
                if (file.endsWith('.tmp.src')) return; // Suit le sort de son partiel

                const parsed = parseCacheName(file);
                if (!parsed || allGuildTargetKeys.has(parsed.key)) return;

                const filePath = path.join(this.cacheDir, file);
                try {
                    fs.unlinkSync(filePath);
                    // Seulement si l'index désigne bien ce fichier : une
                    // requalification en cours a pu en référencer un autre.
                    if (this.cacheIndex.get(parsed.key)?.file === file) {
                        this.cacheIndex.delete(parsed.key);
                    }
                    log.info(`[PreloadManager] Unused cache file deleted: ${file}`);
                } catch (e) {
                    log.error(`[PreloadManager] Failed to delete cache file ${file}:`, e.message);
                }
            });
        } catch (err) {
            log.error('[PreloadManager] Error reading the cache folder for cleanup:', err.message);
        }

        // 3. Ramener le cache sous son plafond de taille. La purge par
        // pertinence ci-dessus ne retire que les pistes hors cible ; l'ensemble
        // des cibles peut à lui seul dépasser toute limite raisonnable.
        const nowPlayingKeys = new Set();
        try {
            this.player.queues.cache.forEach((q) => {
                const playing = getSession(q).getCurrentTrack();
                const cacheKey = playing ? this.getTrackKey(playing) : null;
                if (cacheKey) nowPlayingKeys.add(cacheKey);
            });
        } catch (e) {}
        this.enforceCacheLimit(nowPlayingKeys);

        // 4. Lancer le préchargement des nouvelles cibles non encore cachées ou en cours de téléchargement.
        // Une piste déjà en cache à un autre débit n'est pas retouchée ici : le
        // changement de qualité est une action explicite de l'utilisateur, via
        // requalify(), et ne doit pas se déclencher en masse au fil des cycles.
        for (const [key, track] of targetKeys.entries()) {
            if (this.cacheIndex.has(key)) continue;

            const bitrate = resolveAudioBitrate(track);
            if (this.activeDownloads.has(this._downloadKey(key, bitrate))) continue;

            /*
             * Le reste attendra qu'une place se libère.
             *
             * `break` et non `continue` : les cibles sont rangées par urgence —
             * la piste en cours, puis la file, puis l'historique, puis les
             * playlists — et sauter par-dessus celle-ci pour en essayer une
             * plus lointaine reviendrait à précharger à l'envers.
             */
            if (this.activeDownloads.size >= MAX_PARALLEL_PRELOADS) {
                this.pendingGuilds.add(guildId);
                break;
            }

            // Personne n'attend les pistes à venir : leur extraction prend son
            // tour dans la file espacée. Celle qu'on écoute passe devant.
            this.startDownload(track, key, bitrate, null, { background: !nowPlayingKeys.has(key) });
        }
    }

    /**
     * Reprend la planification là où le plafond de parallélisme l'a arrêtée.
     *
     * Appelé quand un préchargement **aboutit**, et seulement alors. Le faire
     * aussi après un échec donnerait une boucle serrée : la piste fautive
     * repartirait aussitôt, échouerait de nouveau, et relancerait la reprise —
     * le délai de reprise après échec ne s'appliquant qu'au choix des cibles,
     * pas au rythme des tentatives. Un échec laisse donc le reliquat au
     * prochain `update()`, que le moindre changement d'état déclenche.
     *
     * Différé d'un tour de boucle, et non exécuté sur place : `update()` peut
     * annuler des téléchargements devenus hors cible, ce qui passe par le même
     * point de sortie, et se rappellerait alors lui-même en pleine exécution.
     */
    _schedulePump() {
        if (this.pumpScheduled) return;
        this.pumpScheduled = true;

        setImmediate(() => {
            this.pumpScheduled = false;
            if (this.suspended) return;
            if (this.activeDownloads.size >= MAX_PARALLEL_PRELOADS) return;

            const guilds = [...this.pendingGuilds];
            this.pendingGuilds.clear();
            for (const id of guilds) {
                try {
                    this.update(id);
                } catch (err) {
                    log.error(`[PreloadManager] Resuming the preload of guild ${id} failed:`, err.message);
                }
            }
        });
    }

    /** Piste jouable correspondant à une URL, null si elle est irrésolvable. */
    async _hydrate(url) {
        try {
            const res = await this.player.search(url);
            return (res && res.tracks && res.tracks[0]) || null;
        } catch (e) {
            return null;
        }
    }

    /**
     * Piste réellement diffusable correspondant à une source qui n'en fournit
     * pas — un titre Spotify, dont l'extracteur ne rend que des métadonnées.
     *
     * Le choix est arrêté une seule fois puis mémorisé. La recherche textuelle
     * qui le produit n'est stable ni dans le temps, ni d'un chemin de lecture à
     * l'autre : le préchargement et la lecture directe menaient chacun la leur,
     * avec des requêtes différentes, et pouvaient retenir deux enregistrements
     * distincts du même titre — d'où des durées qui ne concordaient pas d'un
     * mode de diffusion à l'autre.
     *
     * @param {object} track - Piste à ponter
     * @param {string} [label] - Titre à journaliser
     * @returns {Promise<object|null>} Piste diffusable, ou null si le pont
     *   n'est pas nécessaire ou n'a pas abouti — l'appelant garde alors la
     *   piste d'origine et son propre repli.
     */
    async _resolveBridge(track, label) {
        if (!this.player || !isAudioLessSource(track)) return null;

        const database = require('../database/Database');
        const name = label || track.title;

        const remembered = database.getBridge(track.url);
        if (remembered) {
            const match = await this._hydrate(remembered);
            if (match) return match;

            // Vidéo supprimée à la source depuis : le pont est refait, sans
            // quoi la piste resterait injouable indéfiniment.
            log.warn(`[PreloadManager] Remembered bridge for ${name} no longer resolves, searching again.`);
            database.clearBridge(track.url);
        }

        let candidates = [];
        try {
            const query = `${track.author || ''} ${track.title}`.trim();
            const res = await this.player.search(query, { requestedBy: null });
            candidates = (res && res.tracks) || [];
        } catch (e) {
            log.error(`[PreloadManager] Bridge search failed for ${name}:`, e.message);
            return null;
        }

        if (candidates.length === 0) {
            log.warn(`[PreloadManager] No candidate found to bridge ${name}.`);
            return null;
        }

        const { match, verified, gapMs } = pickByDuration(candidates, trackDurationMs(track));
        if (!match || !match.url) return null;

        database.setBridge(track.url, match.url);

        if (verified) {
            log.success(`[PreloadManager] Bridge established for ${name}: ${match.url} `
                + `(duration gap ${(gapMs / 1000).toFixed(1)} s).`);
        } else {
            // Mémorisé quand même : un enregistrement approximatif mais stable
            // vaut mieux qu'un titre qui change à chaque lecture.
            log.warn(`[PreloadManager] Bridge established for ${name} without a duration match `
                + `${gapMs !== null ? `(best gap ${(gapMs / 1000).toFixed(1)} s) ` : ''}`
                + `: ${match.url}`);
        }
        return match;
    }

    /**
     * Flux d'une piste dont la source ne fournit pas d'audio, obtenu par le
     * pont mémorisé plutôt que par celui de l'extracteur.
     *
     * Hors cache, `SpotifyExtractor.stream` délègue à `requestBridge`, dont la
     * recherche est indépendante de celle du préchargement. La lecture directe
     * et le fichier mis en cache portaient donc potentiellement deux
     * enregistrements différents, et le mode de diffusion décidait lequel on
     * entendait. Passer par le même pont aligne les deux.
     *
     * @param {object} track
     * @returns {Promise<object|null>} Flux, ou null pour laisser l'extracteur
     *   procéder à sa manière
     */
    async _streamFromBridge(track) {
        if (!isAudioLessSource(track)) return null;

        try {
            const bridged = await this._resolveBridge(track);
            if (!bridged || !bridged.url || bridged.url === track.url) return null;
            if (!bridged.extractor || typeof bridged.extractor.stream !== 'function') return null;

            log.info(`[PreloadManager] ${track.title} read through the remembered bridge: ${bridged.url}`);
            // L'extracteur cible est lui aussi intercepté : sa piste étant une
            // source normale, il retombera sur son flux d'origine sans repasser
            // par ici.
            return await bridged.extractor.stream(bridged);
        } catch (e) {
            log.error(`[PreloadManager] Bridge unavailable for ${track.title}, `
                + `falling back to the extractor:`, e.message);
            return null;
        }
    }

    /**
     * Lance le téléchargement et le transcodage asynchrone d'une piste.
     *
     * Le débit fait partie des noms de fichiers : deux téléchargements de la
     * même piste à des qualités différentes peuvent donc coexister sans se
     * marcher dessus, ce dont dépend la requalification sans interruption.
     *
     * Un fichier partiel déjà présent est repris plutôt que réécrit : seule la
     * portion manquante est encodée, puis ajoutée à sa suite. Le raccord est
     * exact à l'échantillon près, le MP3 n'étant qu'une suite de trames
     * indépendantes.
     *
     * @param {object} track
     * @param {string} key
     * @param {string} [debitAudio] - Débit cible ; sinon celui résolu pour la piste
     * @param {string|null} [requalifyFrom] - Débit du fichier déjà en cache, s'il s'agit d'une requalification
     */
    async startDownload(track, key, audioBitrate, requalifyFrom = null, { background = false } = {}) {
        // Débit choisi dans la box « Ajouter un fichier » ou dans le menu de la
        // piste. Ne concerne que les sources distantes : un fichier local
        // n'est jamais transcodé.
        const asked = audioBitrate || resolveAudioBitrate(track);
        // Le débit inscrit dans le cache doit décrire le contenu, pas le vœu.
        const bitrate = await clampBitrateToSource(track, asked);
        if (bitrate !== asked) {
            log.info(`[PreloadManager] ${asked} kbps unavailable for "${track.title}"; `
                + `falling back to ${bitrate} kbps, the best the source carries.`);
        }

        const dlKey = this._downloadKey(key, bitrate);
        // Le repli a pu désigner un téléchargement déjà lancé sous ce
        // débit-là : l'appelant, lui, avait vérifié l'autre clé.
        if (this.activeDownloads.has(dlKey)) return;
        const tmpPath = this._tempPath(key, bitrate);
        const mp3Path = path.join(this.cacheDir, cacheFileName(key, bitrate));

        // Le débit du fichier vaut exactement celui demandé, le transcodage
        // étant à débit constant : la taille finale se déduit de la durée, et
        // la progression n'a pas besoin d'estimation grossière.
        const bytesPerSecond = Number(bitrate) * 1000 / 8;
        let estTotalBytes = Math.max(100 * 1024, ((trackDurationMs(track) || 180000) / 1000) * bytesPerSecond);
        const percentOf = (bytes) => Math.min(98, Math.max(5, Math.round((bytes / estTotalBytes) * 100)));

        // Évalué avant toute résolution réseau : la barre de progression doit
        // repartir de son niveau d'avant l'interruption, pas de zéro. La
        // vérification de la source, elle, attend l'URL résolue.
        let resumeInfo = this._resumableFrom(tmpPath);

        if (resumeInfo) {
            log.info(`[PreloadManager] Resuming the preload of: ${track.title} (${bitrate} kbps) `
                + `at ${resumeInfo.seconds.toFixed(0)} s (${percentOf(resumeInfo.bytes)} %)`);
        } else {
            log.info(`[PreloadManager] Starting the preload of: ${track.title} (${bitrate} kbps)`);
        }

        let stream = null;
        let ffmpegProcess = null;
        let outStream = null;
        let finished = false;
        let isCancelled = false;

        /**
         * Refus réseau relevé dans la sortie de ffmpeg, s'il y en a eu un.
         *
         * Quand la source refuse la connexion, ffmpeg n'écrit rien et le
         * fichier obtenu fait zéro octet. L'échec était alors annoncé comme
         * « fichier trop petit, considéré comme corrompu » — un diagnostic qui
         * désigne le disque alors que rien n'est jamais arrivé du réseau. La
         * vraie cause partait dans une entrée de journal séparée, noyée sous
         * quarante lignes de bannière ffmpeg.
         *
         * Le motif est retenu ici pour être rendu au moment de l'échec.
         */
        let networkRefusal = null;

        const cleanup = () => {
            if (finished) return;
            finished = true;
            try { if (ffmpegProcess) ffmpegProcess.kill(); } catch (e) {}
            try { if (stream) stream.destroy(); } catch (e) {}
            try { if (outStream) outStream.close(); } catch (e) {}
            this.activeDownloads.delete(dlKey);
        };

        // Une annulation vient d'une piste devenue hors cible : son partiel n'a
        // pas plus de raison d'être conservé que son fichier de cache, que la
        // purge de update() retire dans la foulée.
        const cancel = () => {
            isCancelled = true;
            cleanup();
            this._deleteTemp(tmpPath);
        };

        const downloadObj = {
            cancel,
            progress: resumeInfo ? percentOf(resumeInfo.bytes) : 5,
            startTime: Date.now(),
            key,
            bitrate: bitrate,
            requalifyFrom
        };
        this.activeDownloads.set(dlKey, downloadObj);
        this.notifyProgress();

        const { track: targetTrack, url: targetUrl } = await this.resolvePlayableTrack(track);

        if (isCancelled) {
            log.info(`[PreloadManager] Preload cancelled for ${track.title}.`);
            cleanup();
            return;
        }

        // La reprise n'est valable que si l'on s'apprête à encoder la même
        // source qu'à l'interruption. Un pont Spotify → YouTube, ou une simple
        // vidéo supprimée depuis, peut faire aboutir la résolution ailleurs.
        if (resumeInfo) {
            // À défaut de source mémorisée — partiel écrit par une version
            // antérieure —, l'égalité entre la clé du fichier et le condensat
            // de l'URL résolue suffit : la résolution n'a rien détourné, et
            // seule une résolution détournée peut faire diverger le contenu.
            const partialSource = this._readSource(tmpPath)
                || (crypto.createHash('sha256').update(targetUrl).digest('hex') === key ? targetUrl : null);

            if (partialSource !== targetUrl) {
                log.info(`[PreloadManager] Partial file of ${track.title} discarded: `
                    + `${partialSource ? 'different' : 'unknown'} source, full re-encode.`);
                this._deleteTemp(tmpPath);
                resumeInfo = null;
                downloadObj.progress = 5;
            }
        }
        this._writeSource(tmpPath, targetUrl);

        // La durée de la piste hydratée est plus fiable que celle de l'entrée
        // de file, qui peut venir d'une playlist enregistrée sans métadonnées.
        const resolvedDurationMs = trackDurationMs(targetTrack) || trackDurationMs(track);
        if (resolvedDurationMs) estTotalBytes = Math.max(100 * 1024, (resolvedDurationMs / 1000) * bytesPerSecond);

        const runPipeline = async () => {
            const resolved = await this.resolveAudioInput(targetTrack, targetUrl, { background });
            const ffmpegInput = resolved.ffmpegInput;
            const inputStream = resolved.inputStream;

            // Confié au nettoyage, qui l'attendait depuis toujours sans que rien
            // ne le lui donne. Une annulation tuait ffmpeg et laissait la source
            // tourner : anodin pour un flux que la rupture du tuyau finissait par
            // faire tomber, mais le téléchargement par tranches, lui, continue de
            // remplir un tampon que plus personne ne vide.
            stream = inputStream;

            if (isCancelled) return;

            if (!ffmpegInput && !inputStream) {
                throw new Error(`Invalid/null preload stream for ${track.title}`);
            }

            const ffmpegArgs = [];
            if (ffmpegInput && (ffmpegInput.startsWith('http://') || ffmpegInput.startsWith('https://'))) {
                ffmpegArgs.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
            }
            // Placé avant -i : le décodage démarre à la seconde demandée, sans
            // réencoder ce que le fichier partiel contient déjà. Sur une URL
            // directe, ffmpeg n'en télécharge même pas le début.
            if (resumeInfo) {
                ffmpegArgs.push('-ss', resumeInfo.seconds.toFixed(6));
            }
            ffmpegArgs.push('-i', ffmpegInput || 'pipe:0');
            /*
             * L'image seule est écartée, et il le faut.
             *
             * Un fichier téléversé porte souvent sa pochette en flux vidéo — du
             * MJPEG à l'intérieur d'un WAV. Le muxer MP3 ne sait la ranger que
             * dans une étiquette ID3v2, que l'on désactive juste après pour ne
             * pas semer d'étiquette au milieu d'un encodage repris. ffmpeg
             * s'arrêtait alors net sur « nothing was written into output file »,
             * sans un octet, et le préchargement de ces fichiers échouait
             * toujours. Seul le son nous intéresse ici.
             */
            ffmpegArgs.push('-vn');
            ffmpegArgs.push('-acodec', 'libmp3lame', '-ab', `${bitrate}k`);
            // Sans ces deux options, chaque segment encodé s'ouvre sur une
            // étiquette ID3, qui se retrouverait en plein milieu du fichier au
            // moment du raccord.
            ffmpegArgs.push('-id3v2_version', '0', '-write_xing', '0', '-f', 'mp3', 'pipe:1');

            ffmpegProcess = cp.spawn(ffmpeg, ffmpegArgs, {
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true
            });

            if (ffmpegProcess.stdin) {
                ffmpegProcess.stdin.on('error', (err) => {
                    // EPIPE attendu si ffmpeg a déjà fermé son entrée après une erreur amont
                    if (err.code !== 'EPIPE') {
                        log.error(`[PreloadManager Debug] ffmpeg stdin error for ${track.title}:`, err.message);
                    }
                });
            }

            let ffmpegLogs = [];
            if (ffmpegProcess.stderr) {
                ffmpegProcess.stderr.on('data', (d) => {
                    const msg = d.toString().trim();
                    if (!msg) return;
                    ffmpegLogs.push(msg);

                    // `HTTP error 403 Forbidden` chez ffmpeg, `Server returned
                    // 403 Forbidden` selon le protocole : les deux formes
                    // désignent le même refus.
                    const refusal = /(?:HTTP error|Server returned)\s+(\d{3}[^\n]*)/i.exec(msg);
                    if (refusal && !networkRefusal) networkRefusal = refusal[1].trim();
                });
            }
            ffmpegProcess.on('close', (code) => {
                if (code !== 0) {
                    log.error(`[PreloadManager FFmpeg Error] Exit code ${code}:`, ffmpegLogs.slice(-10).join('\n'));
                } else {
                    log.success(`[PreloadManager FFmpeg] Transcoding finished successfully (code 0).`);
                }
            });

            // La trame incomplète que l'interruption a laissée en fin de
            // fichier est retirée : le nouveau segment doit s'ajouter sur une
            // frontière de trame, sinon les deux moitiés ne se recollent pas.
            if (resumeInfo) {
                fs.truncateSync(tmpPath, resumeInfo.bytes);
            }
            outStream = fs.createWriteStream(tmpPath, { flags: resumeInfo ? 'a' : 'w' });

            let bytesWritten = resumeInfo ? resumeInfo.bytes : 0;
            let lastReportedPct = downloadObj.progress;

            ffmpegProcess.stdout.on('data', (chunk) => {
                bytesWritten += chunk.length;
                const pct = percentOf(bytesWritten);
                if (pct > lastReportedPct + 2) {
                    log.info(`[PreloadManager Debug] Writing in progress for ${track.title}: ${bytesWritten} bytes (${pct}%)`);
                    lastReportedPct = pct;
                    downloadObj.progress = pct;
                    this.notifyProgress();
                }
            });

            ffmpegProcess.stdout.pipe(outStream);
            if (inputStream) inputStream.pipe(ffmpegProcess.stdin);

            await new Promise((resolve, reject) => {
                ffmpegProcess.on('error', (err) => {
                    log.error(`[PreloadManager Debug] FFmpeg process error for ${track.title}:`, err.message);
                    reject(err);
                });
                if (inputStream && typeof inputStream.on === 'function') {
                    inputStream.on('error', (err) => {
                        log.error(`[PreloadManager Debug] InputStream error for ${track.title}:`, err.message);
                        reject(err);
                    });
                }
                outStream.on('error', (err) => {
                    log.error(`[PreloadManager Debug] OutStream error for ${track.title}:`, err.message);
                    reject(err);
                });
                outStream.on('finish', () => {
                    log.info(`[PreloadManager Debug] OutStream finish fired for ${track.title}. Total bytes written: ${bytesWritten}`);
                    resolve();
                });
            });
        };

        try {
            if (this.player?.extractors?.context) {
                await this.player.extractors.context.provide({
                    id: crypto.randomUUID(),
                    attemptedExtractors: new Set(),
                    bridgeAttemptedExtractors: new Set()
                }, runPipeline);
            } else {
                await runPipeline();
            }

            if (fs.existsSync(tmpPath)) {
                const stat = fs.statSync(tmpPath);
                if (stat.size > MIN_CACHE_BYTES) {
                    // Un flux qui se rompt en cours de route laisse ffmpeg
                    // terminer proprement sur ce qu'il a reçu : la taille seule
                    // ne dit donc pas si la piste est entière. Depuis que les
                    // partiels sont conservés, elle ne le dit même plus du
                    // tout — un fichier repris fait forcément plus que le
                    // minimum. On compare donc à la durée annoncée.
                    const encode = analyzePartial(tmpPath);
                    const expected = resolvedDurationMs / 1000;
                    if (expected && encode.seconds < expected * 0.95) {
                        throw new Error(`Encodage incomplet : ${encode.seconds.toFixed(0)} s `
                            + `out of the ${expected.toFixed(0)} s announced.`);
                    }

                    // Bascule : le fichier précédent n'est retiré qu'ici, une
                    // fois le nouveau complet et validé. Jusqu'à cet instant, la
                    // lecture continuait d'être servie à l'ancienne qualité.
                    const previous = this.cacheIndex.get(key);

                    fs.renameSync(tmpPath, mp3Path);
                    this._deleteTemp(tmpPath);
                    this.cacheIndex.set(key, {
                        size: stat.size,
                        mtime: Date.now(),
                        bitrate: bitrate,
                        file: cacheFileName(key, bitrate)
                    });

                    this.failures.delete(key);

                    // Une place vient de se libérer : s'il restait des cibles
                    // en attente du plafond, elles repartent maintenant.
                    this._schedulePump();

                    if (previous && previous.file !== cacheFileName(key, bitrate)) {
                        this._deleteCacheFile(key, previous.file);
                        log.success(`[PreloadManager] Requalification finished for ${track.title}: `
                            + `${previous.bitrate || 'unknown'} → ${bitrate} kbps, old file removed.`);
                    } else {
                        log.success(`[PreloadManager] Preload succeeded and validated for: ${track.title} (${bitrate} kbps)`);
                    }
                } else if (networkRefusal) {
                    // Zéro octet parce que rien n'est arrivé : le disque n'y est
                    // pour rien, et le dire évite de chercher du côté du cache.
                    throw new Error(`The source refused the connection (${networkRefusal}) — `
                        + `${stat.size} byte(s) received. On a YouTube track this is the `
                        + `usual symptom of an outdated yt-dlp: « npm run update-ytdlp ».`);
                } else {
                    throw new Error(`File too small (${stat.size} bytes), treated as corrupted.`);
                }
            } else if (networkRefusal) {
                throw new Error(`The source refused the connection (${networkRefusal}) — nothing was written. `
                    + `On a YouTube track this is the usual symptom of an outdated yt-dlp: `
                    + `« npm run update-ytdlp ».`);
            } else {
                throw new Error("The temporary file does not exist.");
            }
            cleanup();
            this.notifyProgress();
        } catch (err) {
            cleanup();

            // Ce qui a été encodé avant l'échec est gardé : la tentative
            // suivante, dans cette session ou après un redémarrage, repartira
            // de là. Une annulation vaut en revanche abandon de la piste, et
            // cancel() a déjà fait le ménage.
            const leftover = isCancelled ? null : this._resumableFrom(tmpPath);
            if (leftover) {
                log.info(`[PreloadManager] Partial file kept for ${track.title}: `
                    + `${leftover.seconds.toFixed(0)} s encoded, resuming on the next attempt.`);
            } else {
                this._deleteTemp(tmpPath);
            }

            if (isCancelled) {
                // La piste n'est plus une cible : rien à retenter, et la
                // mémoire d'un échec antérieur n'a plus lieu d'être.
                this.failures.delete(key);
                log.info(`[PreloadManager] Preload cancelled for ${track.title}.`);
            } else {
                const attempts = (this.failures.get(key)?.attempts || 0) + 1;
                this.failures.set(key, { at: Date.now(), attempts });
                const retryIn = Math.round(this._retryDelayMs(attempts) / 1000);
                if (err && err.code === 'YOUTUBE_PAUSED') {
                    // Voulu : YouTube vient de refuser, et le travail de fond
                    // attend. Ni erreur à signaler, ni version à soupçonner.
                    log.info(`[PreloadManager] Preload of ${track.title} postponed: `
                        + `YouTube refused recently (retrying in ${retryIn} s).`);
                } else {
                    log.error(`[PreloadManager] Preload failed for ${track.title} `
                        + `(attempt ${attempts}, retrying in ${retryIn} s):`, err.message);

                    // Lancé sans être attendu : le diagnostic ne doit pas retenir
                    // la boucle de préchargement, qui a d'autres cibles à servir.
                    this._checkYtdlpFreshness(track, attempts);
                }
            }
            this.notifyProgress();
        }
    }
}

module.exports = new PreloadManager();
