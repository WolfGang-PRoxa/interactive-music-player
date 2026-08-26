/**
 * Dashboard State, Settings, Tooltips & i18n System
 */

window.MusicPlayer = window.MusicPlayer || {};

window.MusicPlayer.state = {
    currentTrack: null,
    progress: null,
    isPlaying: false,
    isPaused: false,
    volume: 70,
    settings: {
        duckingEnabled: true,
        duckingLevel: 20,
        duckingDelay: 800,
        duckingFade: 200,
        broadcastMode: 'everyone'
    },
    queue: [],
    speakers: [],
    members: [],
    playlists: [],
    activePlaybackSource: 'queue',
    playlistCurrentIndex: 0
};

window.MusicPlayer.currentGuildId = null;
window.MusicPlayer.customGuildSelect = null;
window.MusicPlayer.customBroadcastSelect = null;
window.MusicPlayer.customSpeedSelect = null;

const defaultDashboardSettings = {
    language: 'fr',
    tooltipDelay: 0.25,
    toast: {
        inDuration: 0.35,
        holdDuration: 4,
        outDuration: 0.35
    },
    videoDefaultPos: {
        x: 100,
        y: 100
    },
    videoDefaultSize: {
        width: 440,
        height: 280
    },
    fadeoutEnabled: true,
    fadeoutDuration: 5,
    fadeinEnabled: false,
    fadeinDuration: 5,
    /** Secondes d'attente avant que le bot ne quitte un salon vidé. */
    presenceDepartureDelay: 30,
    /** Trace la grille 48 colonnes sous les cartes du tableau de bord. */
    showGrid: false,
    bounce: {
        load: true,
        style: true,
        theme: true,
        guild: true,
        channel: true
    },
    holdDuration: {
        playlist: 1.5,
        queue: 1.5,
        history: 1.5
    },
    preloading: {
        enabled: true,
        queueCount: 3,
        historyCount: 3,
        playlistCount: 3
    },
    guildsActiveState: {}
};

function loadDashboardSettings() {
    try {
        const raw = localStorage.getItem('dashboardAdvancedSettings');
        if (raw) {
            const parsed = JSON.parse(raw);
            return {
                ...defaultDashboardSettings,
                ...parsed,
                toast: { ...defaultDashboardSettings.toast, ...(parsed.toast || {}) },
                videoDefaultPos: { ...defaultDashboardSettings.videoDefaultPos, ...(parsed.videoDefaultPos || {}) },
                videoDefaultSize: { ...defaultDashboardSettings.videoDefaultSize, ...(parsed.videoDefaultSize || {}) },
                bounce: { ...defaultDashboardSettings.bounce, ...(parsed.bounce || {}) },
                holdDuration: { ...defaultDashboardSettings.holdDuration, ...(parsed.holdDuration || {}) },
                preloading: { ...defaultDashboardSettings.preloading, ...(parsed.preloading || {}) },
                guildsActiveState: { ...(parsed.guildsActiveState || {}) }
            };
        }
    } catch (e) {}
    return defaultDashboardSettings;
}

window.MusicPlayer.dashboardSettings = loadDashboardSettings();

window.MusicPlayer.saveDashboardSettings = function() {
    try {
        localStorage.setItem('dashboardAdvancedSettings', JSON.stringify(window.MusicPlayer.dashboardSettings));
    } catch (e) {}
};

window.MusicPlayer.applyLanguage = async function(lang) {
    if (typeof loadLocale === 'function') {
        await loadLocale(lang);
    }
    const translations = window.translations || {};
    const dict = translations[lang] || translations['fr'] || {};
    
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        if (dict[key]) {
            el.textContent = dict[key];
        }
    });

    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        const key = el.getAttribute('data-i18n-placeholder');
        if (dict[key]) {
            el.placeholder = dict[key];
        }
    });

    document.querySelectorAll('[data-i18n-tooltip]').forEach(el => {
        const key = el.getAttribute('data-i18n-tooltip');
        if (dict[key]) {
            el.setAttribute('data-tooltip', dict[key]);
        }
    });

    document.querySelectorAll('[data-i18n-label]').forEach(el => {
        const key = el.getAttribute('data-i18n-label');
        if (dict[key]) {
            el.setAttribute('label', dict[key]);
        }
    });

    // Redessiner les libellés construits en JavaScript, hors de portée des
    // attributs data-i18n : options du sélecteur de source, valeurs du tiroir,
    // et tooltips dont la clé dépend de l'état (verrouillé/déverrouillé,
    // détection activée/désactivée…).
    ['updatePlaylistsUI', 'updateQueueUI', 'updateHistoryUI', 'updateSpeakersUI',
     'refreshDrawerLabels', 'refreshMemoryBreakdown'].forEach(nameOf => {
        if (typeof window.MusicPlayer[nameOf] === 'function') {
            try { window.MusicPlayer[nameOf](); } catch (e) {}
        }
    });

    // Synchroniser tous les menus déroulants personnalisés (CustomSelect)
    document.querySelectorAll('select').forEach(select => {
        if (select._customSelect) {
            select._customSelect._lastSignature = null;
            select._customSelect.sync();
        }
    });

    if (window.MusicPlayer.state && !window.MusicPlayer.state.currentTrack) {
        const titleEl = document.getElementById('track-title');
        const authorEl = document.getElementById('track-author');
        if (titleEl) titleEl.textContent = dict.no_track_playing || 'Aucune musique en cours';
        if (authorEl) authorEl.textContent = dict.play_from_search || 'Lancez un morceau depuis la recherche';
    }

    const speedIndicator = document.getElementById('speed-pad-indicator');
    if (speedIndicator && !speedIndicator.classList.contains('precise-active')) {
        speedIndicator.textContent = (dict.speed_classic || 'Classique').toUpperCase();
    }

    if (typeof window.MusicPlayer.updateUI === 'function') window.MusicPlayer.updateUI();
    if (typeof window.MusicPlayer.renderQueue === 'function') window.MusicPlayer.renderQueue();
    if (typeof window.MusicPlayer.renderHistory === 'function') window.MusicPlayer.renderHistory();
    if (typeof window.MusicPlayer.renderPlaylists === 'function') window.MusicPlayer.renderPlaylists();

    /*
     * La documentation embarquée est livrée dans les mêmes langues que
     * l'interface, et suit donc ce réglage-ci : rien ne justifierait de lire le
     * tableau de bord dans une langue et sa documentation dans une autre.
     *
     * Elle se recharge à part, sans être attendue : ses pages viennent du
     * serveur, et l'aller-retour n'a pas à retarder la traduction du reste, qui
     * est déjà en mémoire. La fenêtre de lecture se repeint quand la réponse
     * arrive ; fermée, elle n'a rien à faire du tout.
     */
    if (typeof window.MusicPlayer.refreshDocsLanguage === 'function') {
        window.MusicPlayer.refreshDocsLanguage().catch(() => {});
    }
};

window.MusicPlayer.t = function(key) {
    const lang = (window.MusicPlayer.dashboardSettings && window.MusicPlayer.dashboardSettings.language) || 'fr';
    const translations = window.translations || {};
    const dict = translations[lang] || translations['fr'] || {};
    return dict[key] || key;
};

/**
 * En deçà de cette position, une piste est considérée comme commençant.
 * Sert à distinguer un morceau qui s'ouvre d'un morceau simplement repris.
 */
const DEBUT_DE_PISTE_SEC = 1.5;

/**
 * Durée du fondu d'ouverture d'un morceau, en secondes — 0 s'il n'a pas lieu
 * d'être.
 *
 * Seul le Mix DJ ouvre un morceau en fondu ; `fadeinEnabled` ne concerne que
 * le démarrage du bot et n'a rien à faire à chaque piste. Encore faut-il que
 * le morceau *commence* : ce fondu appartient à un enchaînement. Une piste
 * reprise en cours de route — page rechargée, tableau de bord rouvert,
 * reconnexion — doit revenir à son volume plein, sans quoi elle repartirait
 * en fondu alors que rien n'enchaînait.
 *
 * @param {object} state - État courant.
 * @param {number} positionSecs - Position à laquelle la piste va reprendre.
 * @returns {number} Durée du fondu en secondes, 0 pour aucun.
 */
window.MusicPlayer.openingFadeMs = function(state, positionSecs) {
    const settings = (state && state.settings) || {};
    if (!settings.mixEnabled) return 0;
    if (!(Number(positionSecs) < DEBUT_DE_PISTE_SEC)) return 0;

    const duration = parseFloat(settings.mixDuration);
    return duration > 0 ? duration : 5;
};

/**
 * Piste qui suivra celle en cours, selon la source de lecture active.
 *
 * `state.queue` ne peut pas servir de raccourci : lorsqu'une playlist joue, il
 * expose la file d'attente de l'utilisateur, mise de côté le temps de la
 * lecture (voir WebServer.getChannelPlaybackState). S'y fier revenait, playlist
 * en cours, soit à ne rien trouver — l'enchaînement mix s'achevait alors dans
 * le silence — soit à enchaîner sur un morceau de la file sans aucun rapport.
 *
 * La règle reprend celle du serveur (WebServer.handleVirtualSkip) : le titre
 * suivant de la playlist, le retour au premier quand la lecture en boucle est
 * demandée, et à défaut la file d'attente — c'est-à-dire, précisément, ce
 * `state.queue` dont il fallait se méfier tant que la playlist durait.
 *
 * @param {object} [state] - État courant ; celui du lecteur par défaut.
 * @returns {object|null} La piste suivante, ou null s'il n'y en a pas.
 */
window.MusicPlayer.nextTrackOf = function(state) {
    const snapshot = state || window.MusicPlayer.state || {};
    const source = snapshot.activePlaybackSource;

    if (source && source !== 'queue') {
        const playlist = (snapshot.playlists || []).find(p => p.id === source);
        const tracks = (playlist && playlist.tracks) || [];
        if (tracks.length === 0) return null;

        const index = typeof snapshot.playlistCurrentIndex === 'number' ? snapshot.playlistCurrentIndex : 0;
        if (index + 1 < tracks.length) return tracks[index + 1];

        // Dernier titre : la lecture en boucle enchaîne sur le premier. Sinon
        // la playlist est finie, et la file d'attente prend le relais — le
        // serveur bascule alors la source (WebServer.enchainerSurLaFile), si
        // bien que le titre préparé ici est bien celui qu'il jouera.
        if (snapshot.loopPlaylist) return tracks[0];
    }

    return (snapshot.queue && snapshot.queue[0]) || null;
};

/**
 * Un serveur masqué depuis les réglages doit disparaître partout.
 *
 * L'interrupteur n'agissait que sur sa propre liste : le serveur restait
 * proposé dans le sélecteur de salons, y compris après un rechargement, ce qui
 * rendait le réglage inopérant. Le masquage est un choix d'affichage propre à
 * cet appareil — il vit dans le localStorage et ne touche pas au bot, qui reste
 * membre du serveur et continue d'y jouer si on l'y a laissé.
 *
 * @param {string} guildId
 * @returns {boolean}
 */
window.MusicPlayer.isGuildVisible = function(guildId) {
    const states = (window.MusicPlayer.dashboardSettings || {}).guildsActiveState || {};
    return states[guildId] !== false;
};

/** Filtre une liste de serveurs sur leur visibilité. */
window.MusicPlayer.visibleGuilds = function(guilds) {
    return (guilds || []).filter(g => window.MusicPlayer.isGuildVisible(g.id));
};

window.MusicPlayer.checkIsDefaultChannel = function(guildId, channelId) {
    const state = window.MusicPlayer.state;
    if (!state || !state.guilds) return false;
    const targetGuild = state.guilds.find(g => g.id === guildId);
    return targetGuild && targetGuild.defaultVoiceChannelId === channelId;
};

/**
 * Copie un texte dans le presse-papier.
 *
 * L'API `navigator.clipboard` n'existe que dans un contexte sécurisé. Le
 * tableau de bord tourne bien souvent en HTTP simple, et si `127.0.0.1` reste
 * considéré comme sûr par les navigateurs, une consultation depuis une autre
 * machine du réseau ne l'est pas. D'où le repli sur `execCommand('copy')`,
 * obsolète mais seul disponible dans ce cas.
 *
 * @param {string} texte
 * @returns {Promise<boolean>} true si la copie a abouti
 */
window.MusicPlayer.copyToClipboard = async function(text) {
    if (!text) return false;

    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch (err) {}

    try {
        const helper = document.createElement('textarea');
        helper.value = text;
        helper.setAttribute('readonly', '');
        helper.style.position = 'fixed';
        helper.style.opacity = '0';
        document.body.appendChild(helper);
        helper.select();
        const copie = document.execCommand('copy');
        document.body.removeChild(helper);
        return copie;
    } catch (err) {}

    return false;
};