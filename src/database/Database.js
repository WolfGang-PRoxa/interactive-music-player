/**
 * Database — Persistance des préférences guild via un fichier JSON local.
 * Remplaçant de SQLite pour éviter les erreurs de compilation natives sur Windows.
 */

const path = require('path');
const fs = require('fs');
const config = require('../config');
const { writeJsonAtomic, readJsonSafe, cleanStaleTemp } = require('../utils/atomicJson');
const log = require('../utils/logger');

/**
 * Délai de regroupement des écritures. Une rafale de modifications ne provoque
 * qu'un seul passage sur le disque ; au-delà, la latence resterait perceptible
 * en cas d'arrêt brutal non intercepté.
 */
const SAVE_DEBOUNCE_MS = 120;

class GuildDatabase {
    constructor() {
        this.filepath = path.join(process.cwd(), 'data', 'settings.json');
        this.cache = new Map();
        /** Stockage global des playlists (commun a tous les salons) */
        this.globalData = { playlists: [], trackQuality: {}, bridges: {} };
        this._saveTimer = null;
        this._init();

        // Filet de sécurité : couvre aussi les process.exit() de redémarrage et
        // d'extinction, qui ne passent pas par close().
        this._onExit = () => this.flush();
        process.on('exit', this._onExit);
    }

    _init() {
        const dataDir = path.dirname(this.filepath);
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }

        cleanStaleTemp(this.filepath);

        const data = readJsonSafe(this.filepath, '[Database]');
        if (!data) return;

        // Charger les donnees globales
        if (data.__global__) {
            this.globalData = { playlists: [], trackQuality: {}, bridges: {}, ...data.__global__ };
        }

        for (const [key, settings] of Object.entries(data)) {
            if (key === '__global__') continue;
            this.cache.set(key, settings);
        }

        // Migration : deplacer les playlists par guild vers le stockage global
        this._migratePerGuildPlaylists();

        log.info('[Database] Data loaded from settings.json.');
    }

    /**
     * Migration unique : deplace les playlists stockees par guild vers le stockage global.
     * Les doublons (meme id) sont ignores.
     */
    _migratePerGuildPlaylists() {
        let migrated = false;
        const existingIds = new Set(this.globalData.playlists.map(p => p.id));

        for (const [guildId, settings] of this.cache.entries()) {
            if (settings.playlists && settings.playlists.length > 0) {
                for (const pl of settings.playlists) {
                    if (!existingIds.has(pl.id)) {
                        this.globalData.playlists.push(pl);
                        existingIds.add(pl.id);
                    }
                }
                delete settings.playlists;
                this.cache.set(guildId, settings);
                migrated = true;
            }
        }

        if (migrated) {
            log.info('[Database] Migration of per-guild playlists to global storage done.');
            this._save();
        }
    }

    /** Programme un enregistrement ; les appels rapprochés sont regroupés. */
    _save() {
        if (this._saveTimer) return;
        this._saveTimer = setTimeout(() => {
            this._saveTimer = null;
            this._writeNow();
        }, SAVE_DEBOUNCE_MS);
        // Ne pas retenir la boucle d'événements pour un simple enregistrement
        if (typeof this._saveTimer.unref === 'function') this._saveTimer.unref();
    }

    /**
     * Force l'écriture immédiate de toute modification en attente.
     * Appelée à l'arrêt du process et par close().
     */
    flush() {
        if (!this._saveTimer) return;
        clearTimeout(this._saveTimer);
        this._saveTimer = null;
        this._writeNow();
    }

    _writeNow() {
        try {
            const data = { __global__: this.globalData };
            for (const [guildId, settings] of this.cache.entries()) {
                data[guildId] = settings;
            }
            writeJsonAtomic(this.filepath, data);
        } catch (err) {
            log.error('[Database] Error while writing settings.json', err.message);
        }
    }

    /**
     * Récupère les paramètres d'une guild, avec cache.
     * @param {string} guildId
     * @returns {object} Settings
     */
    getSettings(guildId) {
        const defaults = this._defaults();
        if (this.cache.has(guildId)) {
            return { ...defaults, ...this.cache.get(guildId) };
        }

        // Pas d'enregistrement ici : une simple lecture ne doit pas déclencher
        // d'écriture disque. Cette méthode est appelée en boucle (toutes les
        // secondes, pour chaque guild) ; les valeurs par défaut sont de toute
        // façon réappliquées à chaque lecture, et la première modification
        // réelle persistera l'entrée.
        const settings = { ...defaults, guildId };
        this.cache.set(guildId, settings);
        return { ...settings };
    }

    /**
     * Met à jour un ou plusieurs paramètres pour une guild.
     * @param {string} guildId
     * @param {object} updates - { duckingEnabled, duckingLevel, duckingDelay, duckingFade, baseVolume, broadcastMode }
     */
    updateSettings(guildId, updates) {
        // Si on définit un salon par défaut (non null), on le désactive sur tous les autres serveurs
        if (updates.defaultVoiceChannelId) {
            for (const [otherGuildId, settings] of this.cache.entries()) {
                if (otherGuildId !== guildId && settings.defaultVoiceChannelId) {
                    settings.defaultVoiceChannelId = null;
                    this.cache.set(otherGuildId, settings);
                }
            }
        }

        const current = this.getSettings(guildId);
        const merged = { ...current, ...updates, guildId };

        this.cache.set(guildId, merged);
        this._save();
    }

    _defaults() {
        return {
            guildId: null,
            duckingEnabled: config.ducking.enabled,
            duckingLevel: config.ducking.level,
            duckingDelay: config.ducking.restoreDelay,
            duckingFade: config.ducking.fadeDuration,
            baseVolume: config.volume.defaultBase,
            broadcastMode: config.broadcast.defaultMode,
            playbackSpeed: '1.0',
            defaultVoiceChannelId: null,
            lastVoiceChannelId: null,
            mixEnabled: false,
            mixDuration: 5,
            mixType: 'volume',
            fadeinEnabled: false,
            fadeinDuration: 5,
            fadeoutEnabled: true,
            fadeoutDuration: 5,

            /**
             * Délai de grâce avant que le bot ne quitte un salon vidé de ses
             * humains, **en secondes** — l'unité du curseur du tableau de bord,
             * et celle des réglages voisins.
             *
             * `config.presence.departureDelay` est en millisecondes : c'est la
             * valeur de repli du code, convertie ici une fois pour toutes.
             * `PresenceManager` refait la conversion en sens inverse au moment
             * d'armer le minuteur.
             *
             * Zéro est recevable : le bot s'en va dès le départ du dernier
             * auditeur, sans délai.
             */
            presenceDepartureDelay: Math.round(config.presence.departureDelay / 1000),
            /** Par salon : { channelId: [userId, ...] } — utilisateurs dont la détection vocale est désactivée */
            ignoredVoiceUsers: {},

            /**
             * Contrôle partagé : droits accordés aux invités, par compte Discord.
             *
             * `{ "<userId>": { playback, queue, playlists, volume } }`, les quatre
             * groupes de src/web/permissions.js. Un compte absent de la table n'a
             * aucun droit — c'est aussi ce qui reste après révocation.
             *
             * Par serveur, et non par salon : le maître accorde à une personne,
             * pas à une personne dans un salon donné.
             */
            sharedControl: {},

            /**
             * Qualité appliquée aux médias récupérés depuis une source distante.
             * Sans effet sur les fichiers locaux, importés tels quels.
             */
            importAudioQuality: '320',   // débit MP3 du préchargement, en kbps
            importVideoQuality: '720',   // hauteur cible du flux vidéo, en pixels

            /**
             * Préchargement audio. Réglé depuis le tableau de bord, mais
             * consommé côté serveur par le PreloadManager : la valeur doit
             * vivre ici et non seulement dans le localStorage du navigateur.
             */
            preloading: {
                enabled: true,
                queueCount: 3,
                historyCount: 3,
                playlistCount: 3
            },

            activePlaybackSource: 'queue',
            playlistCurrentIndex: 0,

            /**
             * Relecture de la playlist active depuis le début une fois arrivée
             * à sa dernière piste.
             *
             * Distinct du mode de répétition de discord-player, qui ne connaît
             * que la file d'attente réellement chargée : rejouer « la
             * playlist » suppose de la recharger depuis son premier titre,
             * même si la lecture avait démarré en plein milieu.
             */
            loopPlaylist: false,
            queueBackupPersonal: null,
            queueBackupEveryone: null,
        };
    }

    getLastVoiceChannel() {
        return {
            guildId: this.globalData.lastGuildId || null,
            channelId: this.globalData.lastVoiceChannelId || null
        };
    }

    setLastVoiceChannel(guildId, channelId) {
        if (guildId && channelId) {
            this.globalData.lastGuildId = guildId;
            this.globalData.lastVoiceChannelId = channelId;
            const settings = this.getSettings(guildId);
            settings.lastVoiceChannelId = channelId;
            this.cache.set(guildId, settings);
            this._save();
        }
    }

    /**
     * Fait du salon favori le salon courant. À n'appeler qu'au démarrage.
     *
     * C'est là tout le rôle du favori : désigner le salon sur lequel le bot et
     * le tableau de bord se posent quand le process démarre ou redémarre. Passé
     * ce point il ne vaut plus rien de particulier, et tout le monde ne suit
     * plus que le dernier salon choisi.
     *
     * L'écrire ici plutôt que de le consulter partout est ce qui rend cette
     * règle tenable : chaque lecture du favori ailleurs dans le code en faisait
     * une préférence permanente, qui ramenait sans fin le bot et le tableau de
     * bord sur lui — impossible alors de s'installer durablement ailleurs.
     *
     * Il n'y a qu'un favori, tous serveurs confondus (cf. `updateSettings`).
     *
     * @returns {{ guildId: string, channelId: string }|null} Le salon appliqué.
     */
    applyFavoriteChannel() {
        for (const [guildId, settings] of this.cache.entries()) {
            if (!settings.defaultVoiceChannelId) continue;
            this.setLastVoiceChannel(guildId, settings.defaultVoiceChannelId);
            return { guildId, channelId: settings.defaultVoiceChannelId };
        }
        return null;
    }

    // --- Qualite souhaitee par piste (commune a tous les salons) ---

    /**
     * Qualite d'import retenue pour une piste, ou null si jamais figee.
     *
     * Indexee par URL : une meme piste apparait dans la file, l'historique et
     * les playlists, et doit y afficher la meme valeur.
     *
     * @param {string} url
     * @returns {{ audio: string, video: string }|null}
     */
    getTrackQuality(url) {
        if (!url) return null;
        return this.globalData.trackQuality?.[url] || null;
    }

    /**
     * Fige la qualite d'une piste si elle ne l'est pas encore.
     *
     * Les reglages de la box « Ajouter un fichier » sont globaux et changent au
     * gre des ajouts suivants : sans instantane a la premiere rencontre, une
     * piste ajoutee en 192 kbps afficherait 320 des que le menu deroulant
     * bougerait. Ne reecrit jamais une valeur deja figee.
     *
     * @param {string} url
     * @param {{ audio: string, video: string }} defauts - Reglages courants de la guild
     * @returns {{ audio: string, video: string }}
     */
    ensureTrackQuality(url, defaults) {
        if (!url) return defaults;
        if (!this.globalData.trackQuality) this.globalData.trackQuality = {};

        const existing = this.globalData.trackQuality[url];
        if (existing && existing.audio && existing.video) return existing;

        const pinned = {
            audio: existing?.audio || defaults.audio,
            video: existing?.video || defaults.video
        };
        this.globalData.trackQuality[url] = pinned;
        this._save();
        return pinned;
    }

    /**
     * Change la qualite souhaitee d'une piste.
     * @param {string} url
     * @param {{ audio?: string, video?: string }} patch
     * @param {{ audio: string, video: string }} defaults - Repli si la piste n'etait pas figee
     */
    setTrackQuality(url, patch, defaults) {
        if (!url) return;
        if (!this.globalData.trackQuality) this.globalData.trackQuality = {};

        const currentQuality = this.globalData.trackQuality[url] || { ...defaults };
        this.globalData.trackQuality[url] = {
            audio: patch.audio || currentQuality.audio,
            video: patch.video || currentQuality.video
        };
        this._save();
    }

    // --- Pont des sources sans audio diffusable (commun a tous les salons) ---

    /**
     * URL reellement diffusable retenue pour une piste dont la source ne sert
     * que des metadonnees — un titre Spotify, notamment.
     *
     * Spotify est protege : son extracteur ne rend jamais de flux et delegue a
     * un autre extracteur, qui va chercher l'enregistrement ailleurs. Cette
     * resolution passe par une recherche textuelle, dont le premier resultat
     * n'est stable ni dans le temps ni d'un chemin de lecture a l'autre : le
     * prechargement et la lecture directe pouvaient ainsi retenir deux videos
     * differentes pour un meme titre, de durees differentes.
     *
     * Memoriser le choix une fois pour toutes rend la piste identique dans les
     * deux modes de diffusion, apres une eviction de cache comme apres un
     * redemarrage.
     *
     * @param {string} url - URL de la source (Spotify)
     * @returns {string|null} URL diffusable, ou null si aucune n'a ete retenue
     */
    getBridge(url) {
        if (!url) return null;
        return this.globalData.bridges?.[url] || null;
    }

    /**
     * Retient l'URL diffusable d'une piste, sans jamais ecraser un choix deja
     * fait : la stabilite est tout l'interet de ce stockage.
     *
     * @param {string} url - URL de la source (Spotify)
     * @param {string} resolue - URL diffusable retenue
     * @returns {string} L'URL effectivement retenue, ancienne ou nouvelle
     */
    setBridge(url, resolvedUrl) {
        if (!url || !resolvedUrl) return resolvedUrl;
        if (!this.globalData.bridges) this.globalData.bridges = {};

        const existing = this.globalData.bridges[url];
        if (existing) return existing;

        this.globalData.bridges[url] = resolvedUrl;
        this._save();
        return resolvedUrl;
    }

    /**
     * Oublie le pont d'une piste, pour qu'une prochaine lecture le resolve a
     * nouveau. Utile lorsque la video retenue a ete supprimee a la source.
     *
     * @param {string} url
     */
    clearBridge(url) {
        if (!url || !this.globalData.bridges?.[url]) return;
        delete this.globalData.bridges[url];
        this._save();
    }

    // --- Methodes globales pour les playlists (communes a tous les salons) ---

    /**
     * Retourne la liste globale des playlists.
     * @returns {Array}
     */
    getGlobalPlaylists() {
        return this.globalData.playlists || [];
    }

    createPlaylist(_guildId, name) {
        const newPlaylist = {
            id: 'playlist_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
            name: name || 'Nouvelle Playlist',
            tracks: []
        };
        this.globalData.playlists.push(newPlaylist);
        this._save();
        return newPlaylist;
    }

    reorderPlaylists(fromIndex, toIndex, playlistOrder) {
        if (!this.globalData.playlists) this.globalData.playlists = [];
        if (Array.isArray(playlistOrder) && playlistOrder.length > 0) {
            const map = new Map(this.globalData.playlists.map(p => [p.id, p]));
            const newPlaylists = [];
            for (const id of playlistOrder) {
                if (map.has(id)) {
                    newPlaylists.push(map.get(id));
                    map.delete(id);
                }
            }
            for (const p of map.values()) {
                newPlaylists.push(p);
            }
            this.globalData.playlists = newPlaylists;
            this._save();
            return true;
        } else if (typeof fromIndex === 'number' && typeof toIndex === 'number' &&
            fromIndex >= 0 && fromIndex < this.globalData.playlists.length &&
            toIndex >= 0 && toIndex < this.globalData.playlists.length) {
            const [moved] = this.globalData.playlists.splice(fromIndex, 1);
            this.globalData.playlists.splice(toIndex, 0, moved);
            this._save();
            return true;
        }
        return false;
    }

    renamePlaylist(_guildId, playlistId, newName) {
        const playlist = this.globalData.playlists.find(p => p.id === playlistId);
        if (playlist) {
            playlist.name = newName || 'Sans nom';
            this._save();
        }
    }

    deletePlaylist(guildId, playlistId) {
        this.globalData.playlists = this.globalData.playlists.filter(p => p.id !== playlistId);
        // Remettre la source de lecture sur 'queue' pour tous les guilds qui utilisaient cette playlist
        for (const [gId, settings] of this.cache.entries()) {
            if (settings.activePlaybackSource === playlistId) {
                settings.activePlaybackSource = 'queue';
                settings.playlistCurrentIndex = 0;
                this.cache.set(gId, settings);
            }
        }
        this._save();
    }

    addTrackToPlaylist(_guildId, playlistId, track, targetIndex) {
        const playlist = this.globalData.playlists.find(p => p.id === playlistId);
        if (playlist) {
            const trackData = {
                title: track.title,
                author: track.author || 'Inconnu',
                duration: track.duration || '0:00',
                thumbnail: track.thumbnail || null,
                url: track.url || null,
                queryType: track.queryType || null
            };
            if (typeof targetIndex === 'number' && targetIndex >= 0 && targetIndex <= playlist.tracks.length) {
                playlist.tracks.splice(targetIndex, 0, trackData);
            } else {
                playlist.tracks.push(trackData);
            }
            this._save();
        }
    }

    removeTrackFromPlaylist(_guildId, playlistId, index) {
        const playlist = this.globalData.playlists.find(p => p.id === playlistId);
        if (playlist && index >= 0 && index < playlist.tracks.length) {
            playlist.tracks.splice(index, 1);
            this._save();
        }
    }

    movePlaylistTrack(_guildId, playlistId, fromIndex, toIndex) {
        const playlist = this.globalData.playlists.find(p => p.id === playlistId);
        if (playlist && fromIndex >= 0 && fromIndex < playlist.tracks.length && toIndex >= 0 && toIndex < playlist.tracks.length) {
            const [track] = playlist.tracks.splice(fromIndex, 1);
            playlist.tracks.splice(toIndex, 0, track);
            this._save();
        }
    }

    /**
     * Active ou désactive la détection vocale d'un utilisateur dans un salon donné.
     * @param {string} guildId
     * @param {string} channelId
     * @param {string} userId
     * @param {boolean} enabled - true = détection activée, false = désactivée
     */
    toggleVoiceDetection(guildId, channelId, userId, enabled) {
        const settings = this.getSettings(guildId);
        if (!settings.ignoredVoiceUsers) {
            settings.ignoredVoiceUsers = {};
        }
        if (!settings.ignoredVoiceUsers[channelId]) {
            settings.ignoredVoiceUsers[channelId] = [];
        }

        const list = settings.ignoredVoiceUsers[channelId];
        const idx = list.indexOf(userId);

        if (!enabled && idx === -1) {
            // Ajouter à la liste d'ignorés
            list.push(userId);
        } else if (enabled && idx !== -1) {
            // Retirer de la liste d'ignorés
            list.splice(idx, 1);
        }

        // Nettoyer les canaux vides
        if (list.length === 0) {
            delete settings.ignoredVoiceUsers[channelId];
        }

        this.cache.set(guildId, settings);
        this._save();
    }

    /**
     * Droits accordés à un invité sur un serveur.
     *
     * Rend toujours les quatre groupes, faux par défaut : les appelants n'ont
     * ainsi jamais à distinguer « jamais invité » de « invité puis tout retiré ».
     *
     * @param {string} guildId
     * @param {string} userId
     * @returns {{ playback: boolean, queue: boolean, playlists: boolean, volume: boolean }}
     */
    getUserPermissions(guildId, userId) {
        const { sanitize } = require('../web/permissions');
        const settings = this.getSettings(guildId);
        return sanitize(settings.sharedControl?.[String(userId)]);
    }

    /**
     * Accorde ou retire des droits à un invité.
     *
     * Un invité qui n'a plus aucun droit sort de la table plutôt que d'y rester
     * avec quatre `false` : le fichier de réglages ne garde ainsi trace que des
     * partages réellement en vigueur.
     *
     * @param {string} guildId
     * @param {string} userId
     * @param {object} permissions Droits bruts, assainis avant enregistrement.
     * @returns {{ playback: boolean, queue: boolean, playlists: boolean, volume: boolean }}
     */
    setUserPermissions(guildId, userId, permissions) {
        const { sanitize, hasAny } = require('../web/permissions');
        const settings = this.getSettings(guildId);
        if (!settings.sharedControl) settings.sharedControl = {};

        const clean = sanitize(permissions);
        if (hasAny(clean)) settings.sharedControl[String(userId)] = clean;
        else delete settings.sharedControl[String(userId)];

        this.cache.set(guildId, settings);
        this._save();
        return clean;
    }

    /**
     * Retire tous les droits d'un invité sur un serveur.
     * @param {string} guildId
     * @param {string} userId
     */
    revokeUserPermissions(guildId, userId) {
        const settings = this.getSettings(guildId);
        if (!settings.sharedControl?.[String(userId)]) return;
        delete settings.sharedControl[String(userId)];
        this.cache.set(guildId, settings);
        this._save();
    }

    /**
     * Tous les partages en vigueur sur un serveur.
     * @param {string} guildId
     * @returns {Object<string, object>} userId → droits.
     */
    getSharedControl(guildId) {
        return this.getSettings(guildId).sharedControl || {};
    }

    /**
     * Vérifie si la détection vocale est désactivée pour un utilisateur dans un salon.
     * @param {string} guildId
     * @param {string} channelId
     * @param {string} userId
     * @returns {boolean} true si l'utilisateur est ignoré (détection OFF)
     */
    isVoiceDetectionDisabled(guildId, channelId, userId) {
        const settings = this.getSettings(guildId);
        const ignored = settings.ignoredVoiceUsers?.[channelId];
        return ignored ? ignored.includes(userId) : false;
    }

    close() {
        this.flush();
        process.removeListener('exit', this._onExit);
    }
}

module.exports = new GuildDatabase();
