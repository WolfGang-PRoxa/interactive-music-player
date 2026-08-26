const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');
const ffmpeg = require('ffmpeg-static');
const { getSession } = require('./PlaybackSession');
const { readSetAsideQueue } = require('../utils/setAsideQueue');
const { analyzePartial } = require('../utils/mp3');
const log = require('../utils/logger');

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

/** Plafond du cache de préchargement, en octets. */
const MAX_CACHE_BYTES = (Number(process.env.MAX_CACHE_MB) || 2048) * 1024 * 1024;

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
            log.info(`[PreloadManager] Préchargement partiel retrouvé (${parsed.bitrate} kbps) : `
                + `${resumeInfo.seconds.toFixed(0)} s déjà encodées, la reprise s'y raccordera.`);
        }

        if (discarded > 0) {
            log.info(`[PreloadManager] ${discarded} fichier(s) temporaire(s) inexploitable(s) supprimé(s).`);
        }
        if (resumed > 0) {
            log.success(`[PreloadManager] ${resumed} préchargement(s) reprendront là où ils s'étaient arrêtés.`);
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
            log.info(`[PreloadManager] Plafond du cache atteint : ${removed} fichier(s) évincé(s), `
                + `${(total / 1024 / 1024).toFixed(0)} Mo restants sur ${MAX_CACHE_BYTES / 1024 / 1024} Mo.`);
        } else {
            log.warn('[PreloadManager] Plafond du cache dépassé mais aucun fichier évinçable '
                + '(toutes les pistes sont en cours de lecture).');
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

        log.info(`[PreloadManager] Requalification de ${track.title} : ${entry.bitrate || 'inconnu'} → ${newBitrate} kbps.`);
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
            log.error('[PreloadManager] Erreur tri des fichiers temporaires au démarrage:', e.message);
        }

        this._buildCacheIndex();

        // Intercepter la méthode stream de tous les extracteurs enregistrés
        player.extractors.store.forEach((extractor) => {
            if (typeof extractor.stream === 'function') {
                const originalStream = extractor.stream;
                extractor.stream = async (track, ...args) => {
                    const cachedPath = this.getCachedPath(track);
                    if (cachedPath) {
                        log.info(`[PreloadManager] Stream cached de ${track.title} servi depuis le disque local.`);
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

        log.info('[PreloadManager] Initialisé et extracteurs de flux interceptés.');
    }

    /**
     * Calcule la clé unique pour une piste.
     * @param {object} track - La piste discord-player
     * @returns {string|null} - Hash SHA-256 de l'URL ou null si c'est un fichier local
     */
    getTrackKey(track) {
        if (!track || !track.url) return null;
        // Ne pas précharger ou cacher si c'est déjà un fichier local sur le disque.
        // Une URL http(s) ne peut pas désigner un fichier local : on évite alors
        // l'appel disque, qui serait fait pour chaque piste distante.
        if (track.queryType === 'file') return null;
        if (!/^https?:\/\//i.test(track.url) && fs.existsSync(track.url)) {
            return null;
        }
        return crypto.createHash('sha256').update(track.url).digest('hex');
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

        const historyLimit = Math.min(5, Math.max(0, parseInt(preloading.historyCount ?? 3, 10)));
        const queueLimit = Math.min(5, Math.max(0, parseInt(preloading.queueCount ?? 3, 10)));
        const playlistLimit = Math.min(5, Math.max(0, parseInt(preloading.playlistCount ?? 3, 10)));

        const sourceIsPlaylist = !!settings.activePlaybackSource
            && settings.activePlaybackSource.startsWith('playlist_');

        const targets = [];

        if (current) {
            targets.push(current);
        }

        if (queueLimit > 0) {
            if (nextTracks.length > 0) {
                targets.push(...nextTracks.slice(0, queueLimit));
            }

            // Le lecteur n'a qu'une liste de pistes : quand une playlist
            // l'occupe, c'est elle que `getTracks()` rend, et la file d'attente
            // de l'utilisateur est mise de côté dans les réglages. Sans ce
            // détour, elle perdrait son préchargement dès qu'une playlist
            // démarre — et y revenir se ferait sur une coupure.
            if (sourceIsPlaylist) {
                targets.push(...this._setAsideQueue(settings).slice(0, queueLimit));
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

        return targets;
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
            log.info(`[PreloadManager] Cibles de préchargement mises à jour pour la guild ${guildId} (${urls.length} pistes).`);
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
                log.info(`[PreloadManager] Annulation du préchargement obsolète pour la clé : ${dlKey}`);
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
                        log.info(`[PreloadManager] Préchargement partiel inutile supprimé : ${file}`);
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
                    log.info(`[PreloadManager] Fichier cache inutilisé supprimé : ${file}`);
                } catch (e) {
                    log.error(`[PreloadManager] Échec suppression fichier cache ${file} :`, e.message);
                }
            });
        } catch (err) {
            log.error('[PreloadManager] Erreur lecture dossier cache pour nettoyage :', err.message);
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
            this.startDownload(track, key, bitrate);
        }
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
     * @param {string} [libelle] - Titre à journaliser
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
            log.warn(`[PreloadManager] Pont mémorisé de ${name} devenu irrésolvable, nouvelle recherche.`);
            database.clearBridge(track.url);
        }

        let candidates = [];
        try {
            const query = `${track.author || ''} ${track.title}`.trim();
            const res = await this.player.search(query, { requestedBy: null });
            candidates = (res && res.tracks) || [];
        } catch (e) {
            log.error(`[PreloadManager] Échec de la recherche du pont pour ${name} :`, e.message);
            return null;
        }

        if (candidates.length === 0) {
            log.warn(`[PreloadManager] Aucun candidat trouvé pour ponter ${name}.`);
            return null;
        }

        const { match, verified, gapMs } = pickByDuration(candidates, trackDurationMs(track));
        if (!match || !match.url) return null;

        database.setBridge(track.url, match.url);

        if (verified) {
            log.success(`[PreloadManager] Pont établi pour ${name} : ${match.url} `
                + `(écart de durée ${(gapMs / 1000).toFixed(1)} s).`);
        } else {
            // Mémorisé quand même : un enregistrement approximatif mais stable
            // vaut mieux qu'un titre qui change à chaque lecture.
            log.warn(`[PreloadManager] Pont établi pour ${name} sans correspondance de durée `
                + `${gapMs !== null ? `(meilleur écart ${(gapMs / 1000).toFixed(1)} s) ` : ''}`
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

            log.info(`[PreloadManager] ${track.title} lu via le pont mémorisé : ${bridged.url}`);
            // L'extracteur cible est lui aussi intercepté : sa piste étant une
            // source normale, il retombera sur son flux d'origine sans repasser
            // par ici.
            return await bridged.extractor.stream(bridged);
        } catch (e) {
            log.error(`[PreloadManager] Pont indisponible pour ${track.title}, `
                + `repli sur l'extracteur :`, e.message);
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
    async startDownload(track, key, audioBitrate, requalifyFrom = null) {
        // Débit choisi dans la box « Ajouter un fichier » ou dans le menu de la
        // piste. Ne concerne que les sources distantes : un fichier local
        // n'est jamais transcodé.
        const bitrate = audioBitrate || resolveAudioBitrate(track);
        const dlKey = this._downloadKey(key, bitrate);
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
            log.info(`[PreloadManager] Reprise du préchargement de : ${track.title} (${bitrate} kbps) `
                + `à ${resumeInfo.seconds.toFixed(0)} s (${percentOf(resumeInfo.bytes)} %)`);
        } else {
            log.info(`[PreloadManager] Début du préchargement de : ${track.title} (${bitrate} kbps)`);
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
        let refusReseau = null;

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

        let targetTrack = track;
        if (this.player && (!targetTrack.extractor || typeof targetTrack.extractor.stream !== 'function')) {
            try {
                const searchRes = await this.player.search(track.url);
                if (searchRes && searchRes.tracks.length > 0) {
                    targetTrack = searchRes.tracks[0];
                    log.info(`[PreloadManager] Piste hydratée dynamiquement via player.search pour : ${targetTrack.title}`);
                }
            } catch (e) {}
        }

        // Une source sans audio doit être pontée avant la suite : youtube-dl-exec,
        // plus bas, se verrait sinon remettre une URL protégée et échouerait sur
        // le DRM. Le pont est désormais vérifié par la durée et mémorisé, pour
        // que le fichier mis en cache soit celui que la lecture directe emploie.
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
                        log.info(`[PreloadManager] Extractor résolu dynamiquement pour ${targetTrack.title} : ${ext.constructor.name}`);
                        break;
                    }
                } catch (e) {}
            }
        }

        if (isCancelled) {
            log.info(`[PreloadManager] Préchargement annulé pour ${track.title}.`);
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
                log.info(`[PreloadManager] Partiel de ${track.title} écarté : `
                    + `source ${partialSource ? 'différente' : 'inconnue'}, réencodage complet.`);
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
            let rawStreamObj = null;
            if (this.player && this.player.extractors) {
                try {
                    const streamInfo = await this.player.extractors.run(async (ext) => {
                        if (targetTrack.extractor && ext.identifier !== targetTrack.extractor.identifier) {
                            return false;
                        }
                        if (await ext.validate(targetUrl, targetTrack.queryType)) {
                            return await ext.stream(targetTrack);
                        }
                        return false;
                    });
                    if (streamInfo && streamInfo.result) {
                        rawStreamObj = streamInfo.result;
                        log.info(`[PreloadManager Debug] Stream extrait via player.extractors.run (Extracteur: ${streamInfo.extractor?.constructor?.name})`);
                    }
                } catch (e) {
                    log.error(`[PreloadManager Debug] Échec player.extractors.run:`, e.message);
                }
            }

            if (!rawStreamObj) {
                if (targetTrack.extractor && typeof targetTrack.extractor.stream === 'function') {
                    rawStreamObj = await targetTrack.extractor.stream(targetTrack);
                } else if (this.player && typeof this.player.extractors.stream === 'function') {
                    rawStreamObj = await this.player.extractors.stream(targetTrack);
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

            // Si ffmpegInput n'est pas encore une URL directe et que la piste provient du web/YouTube
            if ((!ffmpegInput || ffmpegInput === 'pipe:0') && /^https?:\/\//i.test(targetUrl)) {
                try {
                    const youtubedl = require('youtube-dl-exec');
                    log.info(`[PreloadManager] Résolution URL audio directe via youtube-dl-exec pour : ${targetTrack.title}`);
                    const info = await youtubedl(targetUrl, {
                        dumpSingleJson: true,
                        noCheckCertificates: true,
                        noWarnings: true,
                        preferFreeFormats: true,
                        addHeader: ['referer:youtube.com', 'user-agent:googlebot']
                    }, { windowsHide: true });

                    const entry = (info.entries && info.entries[0]) ? info.entries[0] : info;
                    if (entry && entry.formats) {
                        const audioFormats = entry.formats.filter(f => f.acodec !== 'none');
                        const bestAudio = audioFormats.find(f => f.vcodec === 'none') || audioFormats[0];
                        if (bestAudio && bestAudio.url) {
                            ffmpegInput = bestAudio.url;
                            inputStream = null;
                            log.success(`[PreloadManager] URL directe extraite avec succès pour : ${targetTrack.title}`);
                        }
                    } else if (entry && entry.url) {
                        ffmpegInput = entry.url;
                        inputStream = null;
                    }
                } catch (ytdlErr) {
                    log.error(`[PreloadManager] Avertissement résolution youtube-dl-exec pour ${targetTrack.title}:`, ytdlErr.message);
                }
            }

            if (!ffmpegInput && inputStream) {
                ffmpegInput = 'pipe:0';
            }

            if (isCancelled) return;

            if (!ffmpegInput && !inputStream) {
                throw new Error(`Flux de préchargement invalide/null pour ${track.title}`);
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
            ffmpegArgs.push('-i', ffmpegInput || 'pipe:0', '-acodec', 'libmp3lame', '-ab', `${bitrate}k`);
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
                        log.error(`[PreloadManager Debug] Erreur stdin ffmpeg pour ${track.title}:`, err.message);
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
                    const refus = /(?:HTTP error|Server returned)\s+(\d{3}[^\n]*)/i.exec(msg);
                    if (refus && !refusReseau) refusReseau = refus[1].trim();
                });
            }
            ffmpegProcess.on('close', (code) => {
                if (code !== 0) {
                    log.error(`[PreloadManager FFmpeg Error] Code de sortie ${code}:`, ffmpegLogs.slice(-10).join('\n'));
                } else {
                    log.success(`[PreloadManager FFmpeg] Transcodage terminé avec succès (code 0).`);
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
                    log.info(`[PreloadManager Debug] Écriture en cours pour ${track.title}: ${bytesWritten} octets (${pct}%)`);
                    lastReportedPct = pct;
                    downloadObj.progress = pct;
                    this.notifyProgress();
                }
            });

            ffmpegProcess.stdout.pipe(outStream);
            if (inputStream) inputStream.pipe(ffmpegProcess.stdin);

            await new Promise((resolve, reject) => {
                ffmpegProcess.on('error', (err) => {
                    log.error(`[PreloadManager Debug] FFmpeg process error pour ${track.title}:`, err.message);
                    reject(err);
                });
                if (inputStream && typeof inputStream.on === 'function') {
                    inputStream.on('error', (err) => {
                        log.error(`[PreloadManager Debug] InputStream error pour ${track.title}:`, err.message);
                        reject(err);
                    });
                }
                outStream.on('error', (err) => {
                    log.error(`[PreloadManager Debug] OutStream error pour ${track.title}:`, err.message);
                    reject(err);
                });
                outStream.on('finish', () => {
                    log.info(`[PreloadManager Debug] OutStream finish déclenché pour ${track.title}. Octets écrits au total: ${bytesWritten}`);
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
                            + `sur ${expected.toFixed(0)} s annoncées.`);
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

                    if (previous && previous.file !== cacheFileName(key, bitrate)) {
                        this._deleteCacheFile(key, previous.file);
                        log.success(`[PreloadManager] Requalification terminée pour ${track.title} : `
                            + `${previous.bitrate || 'inconnu'} → ${bitrate} kbps, ancien fichier retiré.`);
                    } else {
                        log.success(`[PreloadManager] Préchargement réussi et validé pour : ${track.title} (${bitrate} kbps)`);
                    }
                } else if (refusReseau) {
                    // Zéro octet parce que rien n'est arrivé : le disque n'y est
                    // pour rien, et le dire évite de chercher du côté du cache.
                    throw new Error(`La source a refusé la connexion (${refusReseau}) — `
                        + `${stat.size} octet(s) reçu(s). Sur une piste YouTube, c'est le `
                        + `symptôme habituel d'un yt-dlp périmé : « npm run update-ytdlp ».`);
                } else {
                    throw new Error(`Fichier trop petit (${stat.size} octets), considéré comme corrompu.`);
                }
            } else if (refusReseau) {
                throw new Error(`La source a refusé la connexion (${refusReseau}) — rien n'a été écrit. `
                    + `Sur une piste YouTube, c'est le symptôme habituel d'un yt-dlp périmé : `
                    + `« npm run update-ytdlp ».`);
            } else {
                throw new Error("Le fichier temporaire n'existe pas.");
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
                log.info(`[PreloadManager] Partiel conservé pour ${track.title} : `
                    + `${leftover.seconds.toFixed(0)} s encodées, reprise à la prochaine tentative.`);
            } else {
                this._deleteTemp(tmpPath);
            }

            if (isCancelled) {
                // La piste n'est plus une cible : rien à retenter, et la
                // mémoire d'un échec antérieur n'a plus lieu d'être.
                this.failures.delete(key);
                log.info(`[PreloadManager] Préchargement annulé pour ${track.title}.`);
            } else {
                const attempts = (this.failures.get(key)?.attempts || 0) + 1;
                this.failures.set(key, { at: Date.now(), attempts });
                const retryIn = Math.round(this._retryDelayMs(attempts) / 1000);
                log.error(`[PreloadManager] Échec du préchargement pour ${track.title} `
                    + `(tentative ${attempts}, nouvel essai dans ${retryIn} s) :`, err.message);
            }
            this.notifyProgress();
        }
    }
}

module.exports = new PreloadManager();
