/**
 * Client Dashboard JavaScript for Music Bot
 */

(function () {
    let isSeeking = false;
    let lastSyncTime = 0;
    let state = window.MusicPlayer.state;
    let currentGuildId = null;
    let customGuildSelect = null;
    let customBroadcastSelect = null;
    let customImportAudioSelect = null;
    let customImportVideoSelect = null;

    const t = window.MusicPlayer.t;
    const applyLanguage = window.MusicPlayer.applyLanguage;
    const formatMs = window.MusicPlayer.formatMs;
    const showToast = window.MusicPlayer.showToast;

    let dashboardSettings = window.MusicPlayer.dashboardSettings;
    const saveDashboardSettings = window.MusicPlayer.saveDashboardSettings;

    /** Empreinte des serveurs connus, pour ne redessiner leur liste qu'utilement. */
    let guildsSignature = '';

    // DOM Elements
    const statusDot = document.querySelector('.status-dot');
    const statusText = document.querySelector('.status-text');
    const guildSelect = document.getElementById('guild-select');

    const progressBarWrapper = document.getElementById('progress-bar-wrapper');
    const progressBar = document.getElementById('progress-bar');
    const timeCurrent = document.getElementById('time-current');
    const timeTotal = document.getElementById('time-total');

    const btnPlayPause = document.getElementById('btn-play-pause');
    const btnStop = document.getElementById('btn-stop');
    const btnSkip = document.getElementById('btn-skip');
    const btnPrevious = document.getElementById('btn-previous');

    const searchForm = document.getElementById('search-form');
    const searchInput = document.getElementById('search-input');

    const volumeRange = document.getElementById('volume-range');
    const volumeVal = document.getElementById('volume-val');
    const broadcastModeSelect = document.getElementById('broadcast-mode-select');
    let primaryAudio = document.getElementById('personal-audio-player');
    let secondaryAudio = document.getElementById('personal-audio-player-mix');
    if (!secondaryAudio && primaryAudio) {
        secondaryAudio = document.createElement('audio');
        secondaryAudio.id = 'personal-audio-player-mix';
        secondaryAudio.style.display = 'none';
        document.body.appendChild(secondaryAudio);
    }
    let personalAudio = primaryAudio;
    let activeAudio = primaryAudio;
    window.MusicPlayer.activeAudio = activeAudio;

    /*
     * Correction de niveau du lecteur du navigateur, posée avant tout le reste.
     *
     * Elle enveloppe la propriété « volume » des deux éléments : il faut donc
     * qu'aucun volume n'ait encore été écrit dessus, sans quoi la valeur déjà
     * posée échapperait au gain jusqu'à la prochaine écriture.
     */
    if (typeof window.MusicPlayer.attachLoudnessGain === 'function') {
        window.MusicPlayer.attachLoudnessGain(primaryAudio);
        window.MusicPlayer.attachLoudnessGain(secondaryAudio);
    }

    let fadeAudio = null;
    let mixTransitionNextTrack = null;


    /**
     * Les deux morceaux qui sonnent ensemble pendant un enchaînement mix :
     * celui qui s'achève et celui qui démarre. Renseigné le temps du fondu,
     * nul le reste du temps.
     */
    let mixTransition = null;

    /**
     * Morceau que le navigateur joue déjà, mais que le serveur n'a pas encore
     * confirmé.
     *
     * Le fondu terminé, le `skip` part et la réponse met un aller-retour à
     * revenir. Pendant ce court instant l'état porte toujours la piste
     * précédente : sans cette garde, la synchronisation la prendrait pour un
     * changement de morceau et rechargerait par-dessus celle qui joue — une
     * coupure nette, juste après la transition.
     */
    let mixAwaitingConfirmation = null;
    let mixWaitingSinceMs = 0;
    /** Au-delà, l'attente est abandonnée : mieux vaut resynchroniser que se figer. */
    const MAX_CONFIRMATION_WAIT_MS = 5000;

    /**
     * Enchaînement mix en cours côté serveur, en diffusion commune.
     *
     * Le son sort alors du bot et non du navigateur : les deux morceaux qui se
     * superposent n'existent ici que par ce que le serveur en rapporte. La date
     * de réception accompagne les positions, pour pouvoir les prolonger entre
     * deux messages.
     *
     * @type {{outgoing: object|null, incoming: object, receivedAt: number}|null}
     */
    let guildTransition = null;

    /**
     * Progression respective des deux morceaux d'un enchaînement mix.
     *
     * Les listes de lecture s'en servent pour animer les deux lignes à la
     * fois : le titre sortant poursuit sa course jusqu'à sa fin, l'entrant
     * démarre la sienne — ce que l'index de lecture du serveur, qui n'avance
     * qu'au terme du fondu, ne peut à lui seul décrire.
     *
     * `sortante` est nulle une fois le fondu achevé : le morceau précédent
     * s'est tu, mais l'entrant reste à signaler tant que le serveur n'a pas
     * fait avancer son index de lecture.
     *
     * @returns {{sortante: {url: string, ratio: number}|null,
     *            entrante: {url: string, ratio: number}}|null}
     */
    window.MusicPlayer.mixTransitionState = function() {
        const incoming = mixTransition ? mixTransition.incoming : mixAwaitingConfirmation;
        if (incoming) {
            const progressOf = (part) => {
                const el = part.element;
                const mediaDuration = el ? el.duration : NaN;
                const ratio = (el && !isNaN(mediaDuration) && mediaDuration > 0)
                    ? Math.min(1, Math.max(0, el.currentTime / mediaDuration))
                    : 0;
                return { url: part.url, ratio };
            };

            return {
                outgoing: mixTransition ? progressOf(mixTransition.outgoing) : null,
                incoming: progressOf(incoming)
            };
        }

        return guildTransitionState();
    };

    /**
     * Fondu enchaîné mené par le bus de mixage, en diffusion commune.
     *
     * Le serveur en rend compte une fois par seconde ; les positions sont
     * prolongées entre deux messages, sinon les deux lignes de la playlist
     * avanceraient par à-coups d'une seconde là où la diffusion personnelle les
     * anime au rythme de l'écran.
     *
     * @returns {{sortante: {url: string, ratio: number}|null,
     *            entrante: {url: string, ratio: number}}|null}
     */
    function guildTransitionState() {
        if (!guildTransition) return null;

        const speed = parseFloat((state.settings && state.settings.playbackSpeed) || '1.0');
        const elapsedMs = (performance.now() - guildTransition.receivedAt) * speed;

        const progressOf = (part) => {
            if (!part) return null;
            const position = part.positionMs + elapsedMs;
            const ratio = part.durationMs > 0 ? Math.min(1, Math.max(0, position / part.durationMs)) : 0;
            return { url: part.url, ratio };
        };

        return {
            outgoing: progressOf(guildTransition.outgoing),
            incoming: progressOf(guildTransition.incoming)
        };
    }
    /**
     * Le fade-in de démarrage du bot n'est joué qu'une fois par session de page.
     * Le serveur le laisse en attente jusqu'à ce qu'un tableau de bord s'ouvre —
     * en diffusion personnelle le son sort d'ici, pas du bot — et cet indicateur
     * évite de le rejouer sur les diffusions d'état qui suivent, avant que le
     * serveur n'ait pris acte de sa consommation.
     */
    let startupFadeinPlayed = false;
    /**
     * Le navigateur fait-il autorité sur la position de lecture ?
     *
     * Vrai après une reconnexion alors que la lecture n'a pas été interrompue :
     * le serveur reprend alors une position antérieure à la coupure, et c'est
     * lui qu'il faut recaler, pas l'inverse. Retombe dès que les deux horloges
     * concordent ou qu'une nouvelle piste est chargée.
     */
    let clientPositionWins = false;
    const btnRestartBot = document.getElementById('btn-restart-bot');
    const btnSaveDefaultLayout = document.getElementById('btn-save-default-layout');
    const restartOverlay = document.getElementById('restart-overlay');

    const duckingEnableToggle = document.getElementById('ducking-enable-toggle');
    const duckingOptionsContainer = document.getElementById('ducking-options-container');
    const duckingLevelRange = document.getElementById('ducking-level-range');
    const duckingLevelVal = document.getElementById('ducking-level-val');
    const duckingDelayRange = document.getElementById('ducking-delay-range');
    const duckingDelayVal = document.getElementById('ducking-delay-val');
    const duckingFadeRange = document.getElementById('ducking-fade-range');
    const duckingFadeVal = document.getElementById('ducking-fade-val');

    const mixEnableToggle = document.getElementById('mix-enable-toggle');
    const mixOptionsContainer = document.getElementById('mix-options-container');
    const mixDurationRange = document.getElementById('mix-duration-range');
    const mixDurationVal = document.getElementById('mix-duration-val');
    const mixTypeButtons = document.querySelectorAll('.mix-type-btn');
    const lufsSyncToggle = document.getElementById('lufs-sync-toggle');
    const lufsSyncOptions = document.getElementById('lufs-sync-options');
    const lufsSyncRange = document.getElementById('lufs-sync-range');
    const lufsSyncVal = document.getElementById('lufs-sync-val');

    const btnClearHistory = document.getElementById('btn-clear-history');
    const btnClearQueue = document.getElementById('btn-clear-queue');
    const playbackSourceSelect = document.getElementById('playback-source-select');
    const playlistsTabsContainer = document.getElementById('playlists-tabs-container');
    if (playlistsTabsContainer) {
        playlistsTabsContainer.addEventListener('wheel', (e) => {
            if (e.deltaY !== 0) {
                e.preventDefault();
                playlistsTabsContainer.scrollBy({
                    left: e.deltaY,
                    behavior: 'smooth'
                });
            }
        }, { passive: false });
    }
    let customSourceSelect = null;

    // 60 FPS High-Precision Timeline Interpolation Engine
    let animFrameId = null;
    let baseProgressMs = 0;
    let baseTotalMs = 0;
    let lastProgressTimestamp = 0;
    let isTrackPlaying = false;

    /**
     * La position qu'on entend, en millisecondes — ou `null` si ce n'est pas
     * l'élément audio de cette page qui la tient. Voir le commentaire
     * « Qui dit où en est la lecture » juste en dessous.
     *
     * Exposée pour la vidéo, qui doit se caler sur la même référence que la
     * barre de progression — voir `referenceMs` dans js/video.js.
     */
    function heardPositionMs() {
        const isPersonal = state && state.settings && state.settings.broadcastMode === 'personal';
        if (!isPersonal || !audioHoldsPosition()) return null;
        return personalAudio.currentTime * 1000;
    }
    window.MusicPlayer.heardPositionMs = heardPositionMs;

    function audioHoldsPosition() {
        return Boolean(personalAudio
            && !isNaN(personalAudio.duration) && personalAudio.duration > 0
            && (!personalAudio.paused
                || (state.isPaused && personalAudio.currentTime > 0)));
    }

    /**
     * La durée du morceau qu'on entend, en secondes — ou `null` tant qu'aucune
     * n'est connue.
     *
     * ## Le flux dont on ignore la fin
     *
     * Lu avant la fin de son préchargement, un morceau distant arrive transcodé
     * à la volée, sans taille annoncée : l'élément audio ne sait pas où il
     * s'arrête, et sa `duration` vaut `Infinity`. La garde ci-dessus l'accepte —
     * `isNaN` ne refuse pas l'infini —, si bien que la barre restait à zéro et
     * que le total s'écrivait « Infinity:NaN:NaN ».
     *
     * La durée existe pourtant : celle des métadonnées de la piste, que le
     * serveur envoie avec la position. Elle est exacte d'emblée, là où une
     * estimation tirée de ce qui est déjà préchargé ne le deviendrait qu'à la
     * fin, et bougerait sous les yeux d'ici là. Elle sert donc tant que
     * l'élément ignore la sienne.
     */
    function heardDurationSecs() {
        const own = personalAudio ? personalAudio.duration : NaN;
        if (Number.isFinite(own) && own > 0) return own;
        return baseTotalMs > 0 ? baseTotalMs / 1000 : null;
    }

    /**
     * Écrit la durée totale, ou montre qu'elle est en attente.
     *
     * Sans durée connue — ni par l'élément, ni par les métadonnées —, écrire
     * « 0:00 » annoncerait un morceau vide. Le compteur garde alors sa place et
     * s'efface derrière trois points qui respirent (voir `.is-pending` dans
     * css/player.css) : on attend une valeur, on n'en invente pas.
     *
     * @param {number|null} totalMs Durée à l'échelle du morceau, avant vitesse.
     * @param {number} speed
     */
    function paintTotal(totalMs, speed) {
        if (!timeTotal) return;
        const known = Number.isFinite(totalMs) && totalMs > 0;
        timeTotal.classList.toggle('is-pending', !known);
        if (known) timeTotal.removeAttribute('aria-busy');
        else timeTotal.setAttribute('aria-busy', 'true');

        const text = known ? formatMs(Math.round(totalMs / speed)) : '0:00';
        if (timeTotal.textContent !== text) timeTotal.textContent = text;
    }

    function renderSmoothProgress() {
        if (!isSeeking && !(window.MusicPlayer && window.MusicPlayer.isVideoUserInteracting)) {
            const isPersonal = state.settings && state.settings.broadcastMode === 'personal';
            const speed = parseFloat((state.settings && state.settings.playbackSpeed) || window.MusicPlayer.currentSpeed || '1.0');

            /*
             * Qui dit où en est la lecture.
             *
             * En diffusion personnelle, c'est l'élément audio : c'est lui qui
             * joue, sa position est celle qu'on entend. Le serveur, lui, n'en
             * tient qu'une estimation à l'horloge murale, avancée par un tour
             * de boucle chaque seconde — donc en retard d'une fraction de
             * seconde la plupart du temps.
             *
             * Il faut continuer de lire l'élément **pendant la pause**, et pas
             * seulement pendant la lecture. La condition ne retenait ici que
             * `!personalAudio.paused` : au moment précis où l'on appuyait,
             * l'affichage changeait de source et passait de la position réelle
             * à l'estimation, plus ancienne. La barre reculait alors d'une
             * fraction de seconde alors que rien n'avait bougé dans le
             * morceau — un recul qui ne venait pas de la lecture, mais de la
             * question posée pour la mesurer.
             *
             * Deux réserves. L'élément ne fait foi que si l'arrêt vient de
             * l'utilisateur (`state.isPaused`) : arrêté pour un chargement ou
             * une bascule de piste, il porte encore la position du morceau
             * précédent. Et une position nulle est écartée — au rechargement
             * de la page pendant une pause, l'élément repart de zéro, et c'est
             * le serveur qui sait où l'on en était, le temps que le recalage
             * plus bas ait eu lieu.
             */
            if (isPersonal && audioHoldsPosition()) {
                const currentSecs = personalAudio.currentTime;
                const totalSecs = heardDurationSecs();
                const ratio = totalSecs ? Math.min(1, Math.max(0, currentSecs / totalSecs)) : 0;
                if (progressBar) {
                    progressBar.style.transform = `scaleX(${ratio})`;
                    window.MusicPlayer.currentProgressRatio = ratio;
                }

                const formattedCurrent = formatMs(Math.round((currentSecs * 1000) / speed));
                if (timeCurrent && timeCurrent.textContent !== formattedCurrent) {
                    timeCurrent.textContent = formattedCurrent;
                }
                paintTotal(totalSecs ? totalSecs * 1000 : null, speed);
                syncVideoProgress(currentSecs * 1000);
                if (typeof window.MusicPlayer.updateActivePlaylistTrackProgress === 'function') {
                    window.MusicPlayer.updateActivePlaylistTrackProgress(ratio);
                }
            } else if (state.progress && baseTotalMs > 0) {
                let currentMs = baseProgressMs;
                if (isTrackPlaying && lastProgressTimestamp > 0) {
                    const elapsedRealMs = performance.now() - lastProgressTimestamp;
                    currentMs = Math.min(baseTotalMs, baseProgressMs + (elapsedRealMs * speed));
                }
                const ratio = Math.min(1, Math.max(0, currentMs / baseTotalMs));
                if (progressBar) {
                    progressBar.style.transform = `scaleX(${ratio})`;
                    window.MusicPlayer.currentProgressRatio = ratio;
                }

                const formattedCurrent = formatMs(Math.round(currentMs / speed));
                if (timeCurrent && timeCurrent.textContent !== formattedCurrent) {
                    timeCurrent.textContent = formattedCurrent;
                }
                paintTotal(baseTotalMs, speed);
                syncVideoProgress(currentMs);
                if (typeof window.MusicPlayer.updateActivePlaylistTrackProgress === 'function') {
                    window.MusicPlayer.updateActivePlaylistTrackProgress(ratio);
                }
            } else if (!state.currentTrack) {
                if (progressBar) {
                    progressBar.style.transform = 'scaleX(0)';
                    window.MusicPlayer.currentProgressRatio = 0;
                }
                if (timeCurrent && timeCurrent.textContent !== '0:00') timeCurrent.textContent = '0:00';
                // Rien en lecture : « 0:00 » est la vérité, pas une attente.
                if (timeTotal) {
                    timeTotal.classList.remove('is-pending');
                    timeTotal.removeAttribute('aria-busy');
                    if (timeTotal.textContent !== '0:00') timeTotal.textContent = '0:00';
                }
                syncVideoProgress(0);
            }
        }

    }

    /**
     * Un tour de la boucle d'animation, qui se rappelle tant que ça joue.
     *
     * L'enchaînement des images est séparé du rendu : `renderSmoothProgress()`
     * est aussi appelée ponctuellement à chaque message du serveur, et enchaîner
     * depuis là ouvrait une boucle de plus à chaque fois — elles s'accumulaient
     * sans que rien ne les referme.
     */
    function progressLoop() {
        renderSmoothProgress();
        if (isTrackPlaying || (personalAudio && !personalAudio.paused)) {
            animFrameId = requestAnimationFrame(progressLoop);
        } else {
            animFrameId = null;
        }
    }

    function startProgressLoop() {
        if (!animFrameId) {
            animFrameId = requestAnimationFrame(progressLoop);
        }
    }

    // Theme & Style Settings
    const styleSelect = document.getElementById('style-select');
    const btnThemeToggle = document.getElementById('btn-theme-toggle');
    const svgSun = document.getElementById('svg-sun');
    const svgMoon = document.getElementById('svg-moon');

    let currentStyle = localStorage.getItem('appStyle') || 'glassmorphism';
    let currentTheme = localStorage.getItem('appTheme') || 'dark';

    // Apply theme and style settings immediately on startup
    document.documentElement.setAttribute('data-style', currentStyle);
    document.documentElement.setAttribute('data-theme', currentTheme);
    if (styleSelect) {
        styleSelect.value = currentStyle;
    }
    updateThemeIcons(currentTheme);
    updateFavicon(currentStyle);
    updateThemeColor();

    /**
     * Aligne la couleur d'interface du navigateur sur le fond du tableau de
     * bord.
     *
     * Sur un téléphone à découpe tenu couché, le navigateur réserve une bande
     * de chaque côté de la page. `viewport-fit=cover` lui demande de la
     * prolonger dessous ; tous ne l'écoutent pas, et ces bandes restent alors
     * peintes de la couleur de leur propre interface — un gris qui tranche avec
     * le tableau de bord. La couleur déclarée ici est celle qu'ils y appliquent,
     * ainsi qu'à la barre d'adresse : à défaut de prolonger le fond, on le
     * reproduit.
     *
     * La valeur est lue sur la variable plutôt que recopiée : les huit
     * combinaisons de thème et de style ont leur propre `--bg-main`, et une
     * table en double ici finirait par diverger de base.css.
     */
    function updateThemeColor() {
        const meta = document.getElementById('app-theme-color');
        if (!meta) return;
        const background = getComputedStyle(document.documentElement)
            .getPropertyValue('--bg-main')
            .trim();
        if (background) meta.setAttribute('content', background);
    }

    function updateFavicon(style) {
        if (typeof window.MusicPlayer.setAnimatedFaviconStyle === 'function') {
            window.MusicPlayer.setAnimatedFaviconStyle(style);
            window.MusicPlayer.startFaviconAnimation();
        } else {
            const faviconLink = document.getElementById('app-favicon');
            if (faviconLink) {
                faviconLink.href = `favicons/favicon-${style}.svg`;
            }
        }
    }

    function updateThemeIcons(theme) {
        if (!svgSun || !svgMoon) return;
        if (theme === 'light') {
            svgSun.classList.remove('hidden');
            svgMoon.classList.add('hidden');
        } else {
            svgSun.classList.add('hidden');
            svgMoon.classList.remove('hidden');
        }
    }

    /**
     * Rejoue ce qui dépend du pôle courant : l'icône du bouton et la couleur
     * d'interface du navigateur.
     *
     * Exposé parce que le réglage fin (js/themeBlend.js) déplace `data-theme`
     * sans passer par la bascule : sans ce point d'entrée, il lui faudrait
     * réécrire les deux, et l'icône finirait par dire autre chose que le fond.
     */
    window.MusicPlayer.applyThemeAppearance = function (theme) {
        updateThemeIcons(theme);
        updateThemeColor();
    };

    // Throttle helper for slider updates
    function throttle(func, limit) {
        let inThrottle;
        return function () {
            const args = arguments;
            const context = this;
            if (!inThrottle) {
                func.apply(context, args);
                inThrottle = true;
                setTimeout(() => (inThrottle = false), limit);
            }
        };
    }

    let isShuttingDown = false;

    // Connect to WebSocket Server
    function connectWebSocket() {
        window.MusicPlayer.connectWebSocket(handleServerMessage, {
            onOpen: () => {
                isShuttingDown = false;
                if (restartOverlay) restartOverlay.classList.add('hidden');
                if (btnRestartBot) btnRestartBot.disabled = false;

                // Le bot qui revient n'est pas forcément celui qui est parti :
                // une bascule de version passe par un redémarrage.
                if (typeof window.MusicPlayer.refreshVersionBadge === 'function') {
                    window.MusicPlayer.refreshVersionBadge();
                }

                // Un redémarrage du bot ne coupe pas le son : la page est restée
                // ouverte et l'élément audio a continué de jouer pendant que le
                // serveur, lui, était absent. Sa position est donc en retard sur
                // la nôtre — on la lui annonce immédiatement, et on se déclare
                // prioritaire le temps qu'il en tienne compte, sinon le premier
                // état reçu nous ferait revenir en arrière.
                if (personalAudio && personalAudio.src && !personalAudio.paused) {
                    clientPositionWins = true;
                    window.MusicPlayer.sendWS({
                        type: 'syncProgress',
                        data: { progressMs: Math.round(personalAudio.currentTime * 1000) }
                    });
                }

                // Le préchargement est piloté par le serveur mais réglé ici :
                // après un redémarrage du bot, il repartirait sur ses valeurs
                // par défaut tant que l'utilisateur n'a pas touché un curseur.
                // Réglage du serveur, donc de l'administrateur : un invité n'a
                // rien à y recopier, et le refus lui reviendrait en notification.
                const preloading = window.MusicPlayer.dashboardSettings?.preloading;
                const guest = typeof window.MusicPlayer.isGuest === 'function' && window.MusicPlayer.isGuest();
                if (preloading && !guest) {
                    window.MusicPlayer.sendWS({ type: 'updateSettings', data: { preloading } });
                }
            }
        });
    }

    // Send payload to WebSocket
    function sendWS(payload) {
        if (currentGuildId) window.MusicPlayer.currentGuildId = currentGuildId;
        window.MusicPlayer.sendWS(payload);
    }

    let lastPlayPauseClickTime = 0;

    // Handle messages from the server
    function handleServerMessage(payload) {
        const { type, data } = payload;

        if (type === 'state') {
            const now = Date.now();
            const isRecentClick = (now - lastPlayPauseClickTime < 600);

            // Preserver l'état optimiste du bouton Play/Pause si l'utilisateur a cliqué récemment
            if (isRecentClick && state && state.currentTrack && data && data.currentTrack && (state.currentTrack.url === data.currentTrack.url || state.currentTrack.title === data.currentTrack.title)) {
                const optimisticIsPlaying = state.isPlaying;
                const optimisticIsPaused = state.isPaused;
                state = data;
                state.isPlaying = optimisticIsPlaying;
                state.isPaused = optimisticIsPaused;
            } else {
                state = data;
            }

            if (window.MusicPlayer) {
                window.MusicPlayer.state = state;
            }
            updateUI();
            if (typeof window.MusicPlayer.onBotStatsUpdate === 'function') {
                window.MusicPlayer.onBotStatsUpdate(state);
            }
            // Après updateUI : celle-ci reconstruit des commandes, et le grisage
            // doit se reposer sur ce qui vient d'être redessiné.
            if (typeof window.MusicPlayer.applyShareState === 'function') {
                window.MusicPlayer.applyShareState(state);
            }
        } else if (type === 'permissionDenied') {
            if (typeof window.MusicPlayer.onPermissionDenied === 'function') {
                window.MusicPlayer.onPermissionDenied(data);
            }
        } else if (type === 'controlRevoked') {
            if (typeof window.MusicPlayer.onControlRevoked === 'function') {
                window.MusicPlayer.onControlRevoked(data);
            }
        } else if (type === 'rightRequestResult' || type === 'rightRequestAnswered' || type === 'rightRequested') {
            // Les demandes de droit : la réponse à l'invité qui demande, la
            // décision qui lui revient, et la sonnerie chez l'administrateur.
            // Toutes trois vivent dans js/sharedControl.js.
            const handler = {
                rightRequestResult: 'onRightRequestResult',
                rightRequestAnswered: 'onRightRequestAnswered',
                rightRequested: 'onRightRequested',
            }[type];
            if (typeof window.MusicPlayer[handler] === 'function') {
                window.MusicPlayer[handler](data);
            }
        } else if (type === 'trackFormats') {
            // Inventaire des qualités que porte réellement une source,
            // demandé par le menu contextuel à l'ouverture d'un sous-menu.
            if (typeof window.MusicPlayer.onTrackFormats === 'function') {
                window.MusicPlayer.onTrackFormats(data);
            }
        } else if (type === 'tunnelState') {
            // Réponse à une demande de la fenêtre de partage : constater le
            // tunnel lance deux processus, et ne voyage donc pas avec l'état.
            if (typeof window.MusicPlayer.onTunnelState === 'function') {
                window.MusicPlayer.onTunnelState(data);
            }
        } else if (type === 'shareResult') {
            if (typeof window.MusicPlayer.onShareResult === 'function') {
                window.MusicPlayer.onShareResult(data);
            }
        } else if (type === 'progress') {
            // Mise à jour légère émise chaque seconde : seules la position de
            // lecture et les statistiques du bot changent. Le reste de l'état
            // (file, playlists, réglages) arrive par les messages 'state'.
            if (!state) return;

            const now = Date.now();
            const isRecentClick = (now - lastPlayPauseClickTime < 600);

            state.progress = data.progress;
            // Le fondu enchaîné du bus de mixage évolue à la même cadence que
            // la position : l'oublier ici le figerait jusqu'à la prochaine
            // diffusion d'état complète, soit bien après la fin du fondu.
            state.mixTransition = data.mixTransition || null;
            // L'attente d'un auditeur va et vient au rythme de la position :
            // l'omettre ici laisserait l'explication affichée après le retour
            // du bot, ou absente jusqu'à la prochaine diffusion complète.
            state.listenerWait = data.listenerWait || null;
            if (!isRecentClick) {
                state.isPlaying = data.isPlaying;
                state.isPaused = data.isPaused;
            }
            if (data.botStats) state.botStats = data.botStats;

            if (window.MusicPlayer) {
                window.MusicPlayer.state = state;
            }
            updateUI();
            if (typeof window.MusicPlayer.onBotStatsUpdate === 'function') {
                window.MusicPlayer.onBotStatsUpdate(state);
            }
        } else if (type === 'speakers') {
            // Qui parle, et rien d'autre : le serveur l'émet à chaque début et
            // chaque fin de parole, bien trop souvent pour y joindre un état
            // complet. De quoi animer la boîte « Activité vocale » et, en
            // diffusion personnelle, atténuer le son du navigateur — c'est le
            // navigateur qui y tient le rôle du ducking.
            if (!state) return;
            state.speakers = (data && data.speakers) || [];
            if (window.MusicPlayer) window.MusicPlayer.state = state;
            if (typeof window.MusicPlayer.updateSpeakersUI === 'function') {
                window.MusicPlayer.updateSpeakersUI();
            }
            clientDucking.update(state);
        } else if (type === 'memory') {
            // Flux mémoire haute cadence : lots d'échantillons destinés au seul
            // graphique du tiroir, qui les demande quand il est ouvert.
            if (typeof window.MusicPlayer.onMemorySamples === 'function') {
                window.MusicPlayer.onMemorySamples(data);
            }
        } else if (type === 'error') {
            showToast(data.message);
        } else if (type === 'status') {
            if (data.status === 'restarting') {
                if (restartOverlay) {
                    const h2 = restartOverlay.querySelector('h2');
                    const p = restartOverlay.querySelector('p');
                    const spinner = restartOverlay.querySelector('.spinner');
                    if (h2) h2.textContent = t('overlay_restarting_title');
                    if (p) p.textContent = t('overlay_restarting_desc');
                    if (spinner) spinner.classList.remove('hidden');
                    restartOverlay.classList.remove('hidden');
                }
            } else if (data.status === 'shutting_down') {
                isShuttingDown = true;
                const isFadeoutEnabled = data.fadeoutEnabled !== undefined ? !!data.fadeoutEnabled : (dashboardSettings.fadeoutEnabled !== undefined ? !!dashboardSettings.fadeoutEnabled : true);
                const durationSecs = data.fadeoutDuration !== undefined ? parseFloat(data.fadeoutDuration) : (dashboardSettings.fadeoutDuration !== undefined ? parseFloat(dashboardSettings.fadeoutDuration) : 5);
                const fadeDurationMs = isFadeoutEnabled ? Math.round(durationSecs * 1000) : 0;

                if (fadeDurationMs > 0) {
                    fadeOutPersonalAudio(fadeDurationMs);
                }

                if (restartOverlay) {
                    const h2 = restartOverlay.querySelector('h2');
                    const p = restartOverlay.querySelector('p');
                    const spinner = restartOverlay.querySelector('.spinner');
                    if (isFadeoutEnabled && fadeDurationMs > 0) {
                        if (h2) h2.textContent = t('overlay_shutdown_fadeout_title').replace(/5s/g, `${durationSecs}s`);
                        if (p) p.textContent = t('overlay_shutdown_fadeout_desc').replace(/5s/g, `${durationSecs}s`);
                    } else {
                        if (h2) h2.textContent = t('overlay_shutdown_title');
                        if (p) p.textContent = t('overlay_shutdown_desc');
                    }
                    if (spinner) spinner.classList.add('hidden');
                    restartOverlay.classList.remove('hidden');
                }
            }
        } else if (type === 'versionCatalog') {
            // Réponse à l'ouverture du menu des versions : releases publiées sur
            // le dépôt, et lesquelles sont déjà installées sur cette machine.
            if (typeof window.MusicPlayer.onVersionCatalog === 'function') {
                window.MusicPlayer.onVersionCatalog(data);
            }
        } else if (type === 'versionProgress') {
            // Avancement d'une bascule de version, jusqu'au redémarrage — que le
            // message `status: restarting` prend alors en charge.
            if (typeof window.MusicPlayer.onVersionProgress === 'function') {
                window.MusicPlayer.onVersionProgress(data);
            }
        } else if (type === 'versionRemoved') {
            // Verdict d'une désinstallation demandée depuis le menu des
            // versions. Un catalogue frais suit en cas de succès.
            if (typeof window.MusicPlayer.onVersionRemoved === 'function') {
                window.MusicPlayer.onVersionRemoved(data);
            }
        } else if (type === 'log') {
            if (typeof window.MusicPlayer.appendLogEntry === 'function') {
                window.MusicPlayer.appendLogEntry(data);
            }
        } else if (type === 'logsHistory') {
            if (Array.isArray(data) && typeof window.MusicPlayer.appendLogEntry === 'function') {
                data.forEach(logObj => window.MusicPlayer.appendLogEntry(logObj));
            }
        }
    }

    /* ═══════════════════════════════════════════════════════════════
       Floating Video Window Master Synchronization Engine
       (Delegated to js/video.js module)
       ═══════════════════════════════════════════════════════════════ */
    window.MusicPlayer = window.MusicPlayer || {};
    window.MusicPlayer.state = state;
    window.MusicPlayer.t = t;

    /**
     * Redessine l'interface à partir de l'état déjà en mémoire.
     *
     * Utile aux réglages purement locaux — la visibilité d'un serveur, par
     * exemple — qui ne provoquent aucun échange avec le bot : sans cela, leur
     * effet n'apparaîtrait qu'à la prochaine diffusion d'état.
     */
    window.MusicPlayer.refreshInterface = function() {
        if (state) updateUI();
    };

    function syncVideoVolume(volume) {
        if (typeof window.MusicPlayer.syncVideoVolume === 'function') {
            window.MusicPlayer.syncVideoVolume(volume);
        }
    }

    function syncVideoSpeed(speedStr) {
        if (typeof window.MusicPlayer.syncVideoSpeed === 'function') {
            return window.MusicPlayer.syncVideoSpeed(speedStr);
        }
        return speedStr;
    }

    function syncVideoProgress(currentMs, isExplicitSeek = false) {
        if (typeof window.MusicPlayer.syncVideoProgress === 'function') {
            window.MusicPlayer.syncVideoProgress(currentMs, isExplicitSeek);
        }
    }

    function syncVideoPlayState(isPlaying, isPaused) {
        if (typeof window.MusicPlayer.syncVideoPlayState === 'function') {
            window.MusicPlayer.syncVideoPlayState(isPlaying, isPaused);
        }
    }

    function updateVideoPlayer(track) {
        if (typeof window.MusicPlayer.updateVideoPlayer === 'function') {
            window.MusicPlayer.updateVideoPlayer(track);
        }
    }

    function setupFloatingVideoWindow() {
        if (typeof window.MusicPlayer.setupFloatingVideoWindow === 'function') {
            window.MusicPlayer.setupFloatingVideoWindow();
        }
    }

    function syncVideoOverlayButtons(passedState) {
        if (typeof window.MusicPlayer.syncVideoOverlayButtons === 'function') {
            window.MusicPlayer.syncVideoOverlayButtons(passedState);
        }
    }

    // Update the UI fields according to the state object
    function updateUI() {
        if (window.MusicPlayer) {
            window.MusicPlayer.state = state;
        }
        // Sync active guild ID
        currentGuildId = state.guildId;

        // Render Voice Channels list grouped by Guild (Server)
        if (guildSelect) {
            const getChannelOptionText = (c) => {
                let status = '';
                if (c.botConnected) {
                    // « Inactif » se disait aussi d'un morceau simplement mis en
                    // pause, que rien ne distinguait alors d'un salon où le bot
                    // n'a rien à jouer.
                    // Même lecture des deux drapeaux que la carte du lecteur,
                    // où « en pause » se dit d'une lecture entamée puis
                    // suspendue — les deux peuvent donc être levés ensemble.
                    if (c.isPlaying && !c.isPaused) status = t('channel_connected_playing');
                    else if (c.isPaused) status = t('channel_connected_paused');
                    else status = t('channel_connected_idle');
                } else if (c.userCount > 0) {
                    status = `${c.userCount} ${c.userCount > 1 ? t('channel_users_plural') : t('channel_user_singular')}`;
                } else {
                    status = t('channel_empty');
                }
                return `${c.name} (${status})`;
            };

            // Les serveurs masqués depuis les réglages sont écartés d'emblée :
            // leur absence entre ainsi dans la signature ci-dessous, et basculer
            // l'interrupteur reconstruit bien la liste.
            const displayedGuilds = window.MusicPlayer.visibleGuilds(state.guilds);

            const channelStructure = displayedGuilds.map(g => {
                return `${g.id}:${g.defaultVoiceChannelId || 'none'}[${(g.voiceChannels || []).map(c => c.id).join(',')}]`;
            }).join('|');

            const needsRebuild = guildSelect._lastChannelStructure !== channelStructure;

            if (needsRebuild) {
                guildSelect._lastChannelStructure = channelStructure;
                const prevValue = guildSelect.value;
                guildSelect.innerHTML = '';

                if (displayedGuilds.length > 0) {
                    displayedGuilds.forEach(g => {
                        const group = document.createElement('optgroup');
                        group.label = g.name;

                        if (g.voiceChannels && g.voiceChannels.length > 0) {
                            g.voiceChannels.forEach(c => {
                                const opt = document.createElement('option');
                                opt.value = `${g.id}:${c.id}`;
                                opt.id = `opt-${c.id}`;
                                opt.textContent = getChannelOptionText(c);
                                group.appendChild(opt);
                            });
                        } else {
                            const opt = document.createElement('option');
                            opt.value = '';
                            opt.disabled = true;
                            opt.textContent = 'Aucun salon vocal';
                            group.appendChild(opt);
                        }
                        guildSelect.appendChild(group);
                    });
                } else {
                    const opt = document.createElement('option');
                    opt.value = '';
                    opt.textContent = 'Aucun serveur disponible';
                    guildSelect.appendChild(opt);
                }

                if (prevValue) {
                    guildSelect.value = prevValue;
                }
            } else {
                // Just update text contents
                displayedGuilds.forEach(g => {
                    (g.voiceChannels || []).forEach(c => {
                        const opt = document.getElementById(`opt-${c.id}`);
                        if (opt) {
                            const newText = getChannelOptionText(c);
                            if (opt.textContent !== newText) {
                                opt.textContent = newText;
                            }
                        }
                    });
                });
            }

            // Sync selected value to current voice channel
            if (state.guilds && state.selectedVoiceChannelId) {
                const activeVal = `${state.guildId}:${state.selectedVoiceChannelId}`;
                if (guildSelect.value !== activeVal) {
                    guildSelect.value = activeVal;
                }
            }
            if (customGuildSelect) {
                customGuildSelect.sync();
            }
        }

        // La liste des serveurs des réglages n'est dressée qu'à l'ouverture du
        // modal : sans ce rappel, un serveur que le bot vient de quitter y
        // resterait affiché. L'empreinte évite de la reconstruire chaque
        // seconde, ce qui interromprait l'appui prolongé sur une corbeille.
        const fingerprint = (state.guilds || []).map(g => `${g.id}:${g.name}`).join('|');
        if (fingerprint !== guildsSignature) {
            guildsSignature = fingerprint;
            const settingsModal = document.getElementById('settings-modal');
            if (settingsModal && !settingsModal.classList.contains('hidden')
                && typeof window.MusicPlayer.renderConnectedGuildsList === 'function') {
                window.MusicPlayer.renderConnectedGuildsList();
            }
        }

        // Enchaînement mené par le bus de mixage : on retient les positions et
        // l'instant où elles ont été relevées, de quoi les prolonger jusqu'au
        // message suivant.
        guildTransition = state.mixTransition
            ? { ...state.mixTransition, receivedAt: performance.now() }
            : null;

        // --- Now Playing, disque, boutons médias, préc/suivant, mode, volume, broadcast select ---
        // (Délégué à js/player.js)
        //
        // Pendant un fondu, c'est le morceau entrant qui est annoncé, dans les
        // deux modes de diffusion : il est déjà audible, et la file du serveur
        // ne le déclarera courant qu'au terme de la superposition.
        const displayedTrack = mixTransitionNextTrack
            || (guildTransition && guildTransition.incoming.track)
            || state.currentTrack;
        window.MusicPlayer.updatePlayerCard(displayedTrack);

        // Progress & Time (interpolation 60 FPS fluide sans saccades)
        if (guildTransition) {
            baseProgressMs = guildTransition.incoming.positionMs || 0;
            baseTotalMs = guildTransition.incoming.durationMs || 0;
        } else {
            baseProgressMs = (state.progress && state.progress.currentMs) || 0;
            baseTotalMs = (state.progress && state.progress.totalMs) || 0;
        }
        lastProgressTimestamp = performance.now();
        // Une lecture en attente d'auditeur est déclarée en cours — elle
        // reprendra d'elle-même —, mais rien ne progresse tant que le bot n'est
        // pas dans le salon. L'interpoler ferait avancer la barre d'une seconde
        // que la position figée du serveur reprendrait aussitôt, indéfiniment.
        isTrackPlaying = !!(state.isPlaying && !state.isPaused && state.currentTrack
            && !state.listenerWait);

        // Écran de verrouillage et centre de contrôle du système : même piste
        // que la carte du lecteur, et posée après la progression pour que la
        // fiche parte avec sa position.
        if (typeof window.MusicPlayer.updateMediaSession === 'function') {
            window.MusicPlayer.updateMediaSession(displayedTrack);
        }

        renderSmoothProgress();
        if (isTrackPlaying || (personalAudio && !personalAudio.paused)) {
            startProgressLoop();
        }

        /*
         * L'historique du champ d'ajout apprend d'ici ce qu'il ne peut pas
         * savoir seul : le nom et l'image des pistes.
         *
         * Il ne retient que ce qui a été tapé — une adresse ne dit rien de ce
         * qu'elle porte. Tout ce que le bot a résolu passe en revanche par
         * l'état, et c'est la seule source à disposition du navigateur. La
         * fonction s'arrête d'elle-même dès qu'il n'y a plus rien à compléter :
         * l'état arrive chaque seconde, et la liste des pistes n'a pas à être
         * parcourue pour rien.
         */
        if (typeof window.MusicPlayer.enrichSearchHistory === 'function') {
            const known = [state.currentTrack]
                .concat(state.queue || [], state.history || []);
            (state.playlists || []).forEach(p => known.push(...(p.tracks || [])));
            window.MusicPlayer.enrichSearchHistory(known);
        }

        // La barre de préchargement se rafraîchit à chaque diffusion d'état. Elle
        // ne l'était jusqu'ici que sur les événements de l'élément audio, lesquels
        // n'existent qu'en diffusion personnelle : en mode « tout le monde » elle
        // gardait donc sa largeur initiale de 0 et restait invisible.
        window.MusicPlayer.updateBufferUI();

        // Update video player window
        updateVideoPlayer(displayedTrack);

        // Always sync the video window volume with the dashboard volume
        syncVideoVolume(state.volume);

        if (state.settings.playbackSpeed) {
            window.MusicPlayer.updateSpeedPad(state.settings.playbackSpeed);
        }

        // Ducking toggle
        duckingEnableToggle.checked = state.settings.duckingEnabled;
        const duckingEnabled = state.settings.duckingEnabled;
        if (duckingEnabled) {
            duckingOptionsContainer.classList.remove('disabled');
        } else {
            duckingOptionsContainer.classList.add('disabled');
        }
        duckingLevelRange.disabled = !duckingEnabled;
        duckingDelayRange.disabled = !duckingEnabled;
        duckingFadeRange.disabled = !duckingEnabled;

        if (document.activeElement !== duckingLevelRange) {
            duckingLevelRange.value = state.settings.duckingLevel;
            duckingLevelVal.textContent = `${state.settings.duckingLevel}%`;
        }

        if (document.activeElement !== duckingDelayRange) {
            duckingDelayRange.value = state.settings.duckingDelay;
            duckingDelayVal.textContent = `${state.settings.duckingDelay}ms`;
        }

        if (document.activeElement !== duckingFadeRange) {
            duckingFadeRange.value = state.settings.duckingFade;
            duckingFadeVal.textContent = `${state.settings.duckingFade}ms`;
        }

        // Délai de départ d'un salon vide : c'est le serveur qui l'applique et
        // qui le détient. Le curseur, lui, est rejoué depuis le localStorage à
        // l'ouverture du navigateur ; sans cette reprise, un navigateur neuf
        // afficherait la valeur par défaut et la renverrait au premier réglage
        // touché, effaçant celle du serveur.
        if (state.settings.presenceDepartureDelay !== undefined) {
            const seconds = state.settings.presenceDepartureDelay;
            const cursor = document.getElementById('setting-departure-delay');
            const display = document.getElementById('val-setting-departure-delay');
            if (cursor && document.activeElement !== cursor) {
                cursor.value = seconds;
                if (display) display.textContent = `${seconds}s`;
            }
            const settings = window.MusicPlayer.dashboardSettings;
            if (settings) settings.presenceDepartureDelay = seconds;
        }

        // --- Mix settings synchronization ---
        if (state.settings.mixEnabled !== undefined) {
            mixEnableToggle.checked = state.settings.mixEnabled;
            if (state.settings.mixEnabled) {
                mixOptionsContainer.classList.remove('disabled');
            } else {
                mixOptionsContainer.classList.add('disabled');
            }
        }

        if (state.settings.mixDuration !== undefined && document.activeElement !== mixDurationRange) {
            mixDurationRange.value = state.settings.mixDuration;
            mixDurationVal.textContent = `${state.settings.mixDuration}s`;
        }

        if (state.settings.mixType !== undefined) {
            mixTypeButtons.forEach(btn => {
                if (btn.getAttribute('data-type') === state.settings.mixType) {
                    btn.classList.add('active');
                } else {
                    btn.classList.remove('active');
                }
            });
        }

        // --- Synchronisation des niveaux sonores ---
        if (state.settings.lufsSyncEnabled !== undefined && lufsSyncToggle) {
            lufsSyncToggle.checked = state.settings.lufsSyncEnabled;
            lufsSyncOptions.classList.toggle('disabled', !state.settings.lufsSyncEnabled);
        }

        // Le curseur sous le doigt garde la main : l'état qui revient porte la
        // valeur qu'on vient d'envoyer, avec un tour de retard.
        if (state.settings.lufsSyncTarget !== undefined && lufsSyncRange
            && document.activeElement !== lufsSyncRange) {
            lufsSyncRange.value = state.settings.lufsSyncTarget;
            lufsSyncVal.textContent = formatLufsTarget(state.settings.lufsSyncTarget);
        }

        // Qualité d'import : le serveur fait autorité, le sélecteur le reflète
        if (state.settings.importAudioQuality !== undefined && importAudioQualitySelect
            && importAudioQualitySelect.value !== String(state.settings.importAudioQuality)) {
            importAudioQualitySelect.value = String(state.settings.importAudioQuality);
            if (customImportAudioSelect) customImportAudioSelect.sync();
        }
        if (state.settings.importVideoQuality !== undefined && importVideoQualitySelect
            && importVideoQualitySelect.value !== String(state.settings.importVideoQuality)) {
            importVideoQualitySelect.value = String(state.settings.importVideoQuality);
            if (customImportVideoSelect) customImportVideoSelect.sync();
        }

        /*
         * Destination du champ d'ajout : le serveur fait autorité, comme pour
         * les deux menus ci-dessus.
         *
         * Le menu retombait sur « file d'attente » à chaque rechargement, et
         * après chaque redémarrage du bot : le choix ne vivait nulle part
         * ailleurs que dans le `<select>` de la page ouverte.
         *
         * L'instance du menu déroulant est reprise sur l'élément — customSelect
         * s'y dépose lui-même — plutôt que gardée dans une variable : ce menu
         * est construit ailleurs, plus tard, et un état arrivé avant cette
         * construction ne trouverait rien à synchroniser. Le `<select>` natif,
         * lui, porte déjà la bonne valeur quand elle a lieu.
         */
        if (state.settings.importFormat !== undefined && importFormatSelect
            && importFormatSelect.value !== String(state.settings.importFormat)) {
            importFormatSelect.value = String(state.settings.importFormat);
            if (importFormatSelect._customSelect) importFormatSelect._customSelect.sync();
        }

        const addTargetSelect = document.getElementById('add-target-select');
        if (state.settings.addTarget !== undefined && addTargetSelect
            && addTargetSelect.value !== String(state.settings.addTarget)) {
            addTargetSelect.value = String(state.settings.addTarget);
            if (addTargetSelect._customSelect) addTargetSelect._customSelect.sync();

            // La traînée de particules relie la carte d'ajout à sa destination.
            // Elle suit le menu par son événement `change`, qu'une valeur posée
            // en JavaScript n'émet pas : sans cet appel, elle resterait sur la
            // destination lue à son démarrage — la file d'attente — pendant que
            // le menu en affiche une autre.
            if (window.MusicPlayer.ParticlePath
                && typeof window.MusicPlayer.ParticlePath.setTarget === 'function') {
                window.MusicPlayer.ParticlePath.setTarget(addTargetSelect.value);
            }

            // Le menu « Format » suit la destination : elle vient de changer.
            updateFormatFieldVisibility();
        }

        // Le compte connecté, dans les paramètres. Il ne change qu'au retour
        // d'un trajet OAuth, donc jamais en cours de session — mais le premier
        // état est aussi celui qui le fait apparaître.
        if (typeof window.MusicPlayer.refreshAccount === 'function') {
            window.MusicPlayer.refreshAccount(state);
        }

        // La sonie du morceau en cours, affichée à droite de « Volume
        // Principal ». Elle est peinte ici, avec le reste de l'état, pour
        // qu'elle change au même instant que le titre au-dessus d'elle.
        if (typeof window.MusicPlayer.refreshOutputLevel === 'function') {
            window.MusicPlayer.refreshOutputLevel(state);
        }

        // Delegate Speakers, Queue, and History UI rendering to js/queue.js module
        if (typeof window.MusicPlayer.updateSpeakersUI === 'function') {
            window.MusicPlayer.updateSpeakersUI();
        }
        if (typeof window.MusicPlayer.updateQueueUI === 'function') {
            window.MusicPlayer.updateQueueUI();
        }
        if (typeof window.MusicPlayer.updateHistoryUI === 'function') {
            window.MusicPlayer.updateHistoryUI();
        }

        // Synchroniser le lecteur personnel du navigateur
        syncPersonalAudio();

        // Le gain de sonie de chaque élément, relu de l'état : les adresses
        // viennent peut-être d'être posées par la ligne précédente, et c'est
        // l'adresse qui dit quelle piste un élément est en train de lire.
        if (typeof window.MusicPlayer.applyLoudnessGains === 'function') {
            window.MusicPlayer.applyLoudnessGains(state);
        }

        // Mettre à jour l'IHM des playlists
        updatePlaylistsUI();
    }

    function setVolume(vol) {
        const targetVol = Math.max(0, Math.min(100, Math.round(vol)));
        console.log(`[Video Mute Diagnostic] setVolume called with: ${targetVol}% (previous state.volume: ${state.volume}%)`);
        state.volume = targetVol;

        const volumeRange = document.getElementById('volume-range');
        const volumeVal = document.getElementById('volume-val');
        if (volumeRange && document.activeElement !== volumeRange) {
            volumeRange.value = targetVol;
        }
        if (volumeVal) {
            volumeVal.textContent = `${targetVol}%`;
        }

        // Apply immediately to browser audio element
        if (clientDucking && typeof clientDucking.applyVolume === 'function') {
            console.log(`[Video Mute Diagnostic] Calling clientDucking.applyVolume(${targetVol})`);
            clientDucking.applyVolume(targetVol);
        } else if (personalAudio) {
            console.log(`[Video Mute Diagnostic] Setting personalAudio.volume to ${targetVol / 100}`);
            personalAudio.volume = targetVol / 100;
        }

        // Sync video window controls
        syncVideoVolume(targetVol);

        // Send to server
        console.log(`[Video Mute Diagnostic] Sending WS updateSettings: baseVolume=${targetVol}`);
        sendWS({
            type: 'updateSettings',
            data: { baseVolume: targetVol }
        });
    }

    window.MusicPlayer.setVolume = setVolume;

    // Setup Slider interactive listener helpers
    function setupSlider(sliderEl, valueEl, settingKey, unit = '%') {
        const updateSetting = (val) => {
            sendWS({
                type: 'updateSettings',
                data: { [settingKey]: parseInt(val) }
            });
        };
        const throttledUpdate = throttle(updateSetting, 100);

        sliderEl.addEventListener('input', (e) => {
            valueEl.textContent = `${e.target.value}${unit}`;
            if (settingKey === 'baseVolume') {
                const val = parseInt(e.target.value, 10);
                setVolume(val);
                return;
            }
            throttledUpdate(e.target.value);
        });

        sliderEl.addEventListener('change', (e) => {
            valueEl.textContent = `${e.target.value}${unit}`;
            if (settingKey === 'baseVolume') {
                state.volume = parseInt(e.target.value);
                syncVideoVolume(state.volume);
            }
            updateSetting(e.target.value);
        });
    }

    // --- Interactive Control Event Listeners ---

    /**
     * Lance la lecture de la source choisie, le lecteur étant vide.
     *
     * Le bouton lecture ne savait rien faire de cet état : il annonçait
     * « aucune musique en cours » et s'arrêtait là, alors que la file d'attente
     * ou la playlist désignée comme source n'attendait qu'un départ. Le seul
     * cas où il n'y a vraiment rien à jouer est celui d'une source vide — et
     * c'est encore une occasion de proposer l'autre.
     *
     * D'où les quatre issues, dans l'ordre où on les rencontre :
     *
     *   - la source a de quoi jouer : on la lance, et c'est tout ;
     *   - la file est vide : on propose la première playlist qui ne l'est pas ;
     *   - la playlist choisie est vide : on propose la file, ou à défaut la
     *     playlist suivante qui a du contenu ;
     *   - rien nulle part : la notification seule, sans bouton, car il n'y
     *     aurait rien derrière.
     *
     * L'état consulté ici est celui de la dernière diffusion du serveur : il
     * décide de ce qu'on **propose**, jamais de ce qui se joue. Le serveur
     * revérifie tout de son côté — voir handleStartPlaybackSource.
     */
    function startActiveSource() {
        const source = state.activePlaybackSource || 'queue';
        const queue = state.queue || [];
        const playlists = state.playlists || [];
        const filled = playlists.filter(p => (p.tracks || []).length > 0);

        const start = (nextSource) => sendWS({
            type: 'startPlaybackSource',
            data: nextSource ? { source: nextSource } : {}
        });

        /** Bouton « jouer cette playlist », ou rien s'il n'y en a aucune. */
        const playlistAction = (playlist) => (playlist ? {
            label: t('toast_action_play_playlist').replace('{name}', playlist.name),
            onClick: () => start(playlist.id)
        } : null);

        if (source === 'queue') {
            if (queue.length > 0) {
                start(null);
                return;
            }
            showToast(t('toast_queue_empty'), playlistAction(filled[0] || null));
            return;
        }

        const playlist = playlists.find(p => p.id === source) || null;
        if (playlist && (playlist.tracks || []).length > 0) {
            start(null);
            return;
        }

        // La playlist a pu disparaître entre-temps : son nom vaut mieux que son
        // identifiant, mais l'identifiant vaut mieux qu'un trou dans la phrase.
        const name = playlist ? playlist.name : source;
        const action = queue.length > 0
            ? {
                label: t('toast_action_play_queue'),
                onClick: () => start('queue')
            }
            // Sinon la playlist suivante qui a du contenu — celle qu'on vient
            // d'essayer n'en a pas, elle ne peut pas être de celles-là.
            : playlistAction(filled.find(p => p.id !== source) || null);

        showToast(t('toast_playlist_empty').replace('{name}', name), action);
    }

    // Media Controls
    function togglePlayPause() {
        const now = Date.now();
        if (now - lastPlayPauseClickTime < 350) {
            console.log('[PlayPause Debug] togglePlayPause ignored (click too fast < 350ms)');
            return;
        }
        lastPlayPauseClickTime = now;

        console.log('[PlayPause Debug] togglePlayPause fired', {
            hasCurrentTrack: !!state.currentTrack,
            trackTitle: state.currentTrack ? state.currentTrack.title : null,
            currentIsPlaying: state.isPlaying,
            currentIsPaused: state.isPaused,
            broadcastMode: state.settings ? state.settings.broadcastMode : null
        });

        if (!state.currentTrack) {
            console.warn('[PlayPause Debug] No currentTrack: starting the chosen source.');
            startActiveSource();
            return;
        }

        state.isPaused = !state.isPaused;
        state.isPlaying = !state.isPaused;

        console.log('[PlayPause Debug] New target state:', {
            isPlaying: state.isPlaying,
            isPaused: state.isPaused
        });

        if (typeof syncVideoPlayState === 'function') {
            syncVideoPlayState(state.isPlaying, state.isPaused);
        }
        updateUI();

        if (state.isPaused) {
            console.log('[PlayPause Debug] Sending WS type: pause');
            sendWS({ type: 'pause' });
        } else {
            console.log('[PlayPause Debug] Sending WS type: resume');
            sendWS({ type: 'resume' });
        }
    }

    window.MusicPlayer.togglePlayPause = togglePlayPause;

    btnPlayPause.addEventListener('click', togglePlayPause);

    btnStop.addEventListener('click', () => {
        sendWS({ type: 'stop' });
    });

    btnPrevious.addEventListener('click', () => {
        btnPrevious.disabled = true;
        btnPrevious.dataset.tooltip = t('tooltip_loading_track');
        btnSkip.disabled = true;
        btnSkip.dataset.tooltip = t('tooltip_loading_track');
        lastSyncTime = Date.now() + 3000;
        if (personalAudio) {
            try { personalAudio.pause(); personalAudio.currentTime = 0; } catch (e) {}
        }
        sendWS({ type: 'previous' });
    });

    btnSkip.addEventListener('click', () => {
        btnSkip.disabled = true;
        btnSkip.dataset.tooltip = t('tooltip_loading_track');
        btnPrevious.disabled = true;
        btnPrevious.dataset.tooltip = t('tooltip_loading_track');
        lastSyncTime = Date.now() + 3000;
        if (personalAudio) {
            try { personalAudio.pause(); personalAudio.currentTime = 0; } catch (e) {}
        }
        sendWS({ type: 'skip' });
    });

    // Clear History and Queue (dynamic long-press hold)
    function setupClearHoldButton(btn, wsType, progressId) {
        if (!btn) return;
        const progressBar = (progressId ? document.getElementById(progressId) : null) || (btn.parentElement ? btn.parentElement.querySelector('.card-header-progress') : null) || btn.querySelector('.clear-delete-progress');
        let holdTimer = null;
        let startTimestamp = null;

        function startHolding(e) {
            e.preventDefault();
            if (btn.disabled) return;
            stopHolding();
            const key = wsType === 'clearQueue' ? 'queue' : 'history';
            const currentSettings = window.MusicPlayer.dashboardSettings || dashboardSettings || {};
            const holdSec = (currentSettings.holdDuration && currentSettings.holdDuration[key] !== undefined) ? parseFloat(currentSettings.holdDuration[key]) : 1.5;
            const holdDuration = holdSec * 1000;

            // Le tooltip est calculé à l'affichage (data-hold-key) : rien à
            // réécrire ici, sous peine de figer une valeur périmée.

            startTimestamp = Date.now();
            btn.classList.add('holding');

            holdTimer = setInterval(() => {
                const elapsed = Date.now() - startTimestamp;
                const percent = Math.min(100, (elapsed / holdDuration) * 100);

                if (progressBar) {
                    progressBar.style.width = `${percent}%`;
                }

                if (elapsed >= holdDuration) {
                    stopHolding();
                    sendWS({ type: wsType });
                }
            }, 40);
        }

        function stopHolding() {
            if (holdTimer) {
                clearInterval(holdTimer);
                holdTimer = null;
            }
            btn.classList.remove('holding');
            if (progressBar) {
                progressBar.style.width = '0%';
            }
            startTimestamp = null;
        }

        btn.addEventListener('mousedown', startHolding);
        btn.addEventListener('mouseleave', stopHolding);
        btn.addEventListener('mouseup', stopHolding);
        btn.addEventListener('touchstart', startHolding, { passive: false });
        btn.addEventListener('touchend', stopHolding, { passive: true });
        btn.addEventListener('touchcancel', stopHolding, { passive: true });
    }

    setupClearHoldButton(btnClearHistory, 'clearHistory', 'clear-history-progress');
    setupClearHoldButton(btnClearQueue, 'clearQueue', 'clear-queue-progress');

    // Theme & Style Event Listeners
    if (styleSelect) {
        styleSelect.addEventListener('change', (e) => {
            const selectedStyle = e.target.value;
            currentStyle = selectedStyle;
            localStorage.setItem('appStyle', selectedStyle);
            document.documentElement.setAttribute('data-style', selectedStyle);
            updateFavicon(selectedStyle);
            updateThemeColor();
            triggerCardsBounce('style');
        });
    }

    if (btnThemeToggle) {
        btnThemeToggle.addEventListener('click', () => {
            currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
            localStorage.setItem('appTheme', currentTheme);
            document.documentElement.setAttribute('data-theme', currentTheme);
            updateThemeIcons(currentTheme);
            updateThemeColor();
            triggerCardsBounce('theme');
        });
    }

    // Play Mode Switch Event Listeners
    // Le sélecteur existe en deux exemplaires — carte « En cours de lecture » et
    // fenêtre vidéo flottante. L'aperçu optimiste marque donc le mode choisi
    // dans tous les groupes, sans quoi celui qu'on ne touche pas afficherait un
    // mode périmé jusqu'à la prochaine diffusion d'état du serveur.
    document.querySelectorAll('.mode-switch-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const mode = btn.getAttribute('data-mode');
            sendWS({
                type: 'setPlayMode',
                data: { mode }
            });
            document.querySelectorAll('.mode-switch-btn').forEach(b => {
                b.classList.toggle('active', b.getAttribute('data-mode') === mode);
            });
        });
    });

    // Search and Play / Queue / Playlist
    searchForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const query = searchInput.value.trim();
        if (query) {
            const addTargetSelect = document.getElementById('add-target-select');
            const target = (addTargetSelect && addTargetSelect.value) || 'queue';

            if (target === 'playlist') {
                const activePlaylistId = (window.MusicPlayer.getActivePlaylistTabId && window.MusicPlayer.getActivePlaylistTabId()) || '';
                const defaultPlaylistName = t('default_playlist_name') || 'Ma Playlist';
                sendWS({
                    type: 'addPlaylistTrack',
                    data: { playlistId: activePlaylistId, url: query, defaultPlaylistName }
                });
            } else if (target === 'play') {
                sendWS({
                    type: 'playNow',
                    data: { query }
                });
            } else if (target === 'download') {
                // La seule destination qui ne mène pas au lecteur : le bot
                // écrit un fichier dans son dossier de téléchargement et s'en
                // tient là. Le retour se fait en notifications, la résolution
                // puis le transcodage prenant le temps qu'ils prennent.
                sendWS({
                    type: 'downloadTrack',
                    data: { query }
                });
            } else {
                // Default: 'queue' (Vers la file d'attente)
                sendWS({
                    type: 'play',
                    data: { query }
                });
            }
            searchInput.value = '';
        } else {
            /*
             * Rien à envoyer : le curseur revient dans le champ.
             *
             * C'est ce qui remplace la bulle de validation du navigateur, que
             * « novalidate » a fait taire — voir le commentaire du formulaire
             * dans index.html. Sans elle, un clic sur « Ajouter » à vide ne
             * produisait plus rien du tout, et l'absence de réponse se lit
             * comme une panne.
             *
             * Le focus dit la même chose qu'elle, en moins bavard : voilà où
             * l'on attend quelque chose. Il sert aussi le cas où le champ
             * contient des espaces — invisibles, mais que « required » tient
             * pour une valeur, si bien que le navigateur, lui, n'aurait rien
             * signalé du tout.
             */
            searchInput.focus();
        }
    });

    // File selection and Drag & Drop play functionality
    const fileInput = document.getElementById('file-input');
    const btnFileSelect = document.getElementById('btn-file-select');

    if (btnFileSelect && fileInput) {
        btnFileSelect.addEventListener('click', () => {
            fileInput.click();
        });

        fileInput.addEventListener('change', (e) => {
            const files = Array.from(e.target.files || []);
            if (files.length > 0) {
                if (typeof window.MusicPlayer.handleDroppedFiles === 'function') {
                    window.MusicPlayer.handleDroppedFiles(files);
                } else if (typeof window.MusicPlayer.handleFileUpload === 'function') {
                    files.forEach(f => window.MusicPlayer.handleFileUpload(f));
                }
            }
            fileInput.value = '';
        });
    }

    if (typeof window.MusicPlayer.initCardsDragAndDrop === 'function') {
        window.MusicPlayer.initCardsDragAndDrop();
    }

    /* ─── Qualité d'import (sources distantes uniquement) ──────────────── */

    const importAudioQualitySelect = document.getElementById('import-audio-quality-select');
    const importVideoQualitySelect = document.getElementById('import-video-quality-select');
    const importQualityRow = document.getElementById('import-quality-row');
    const importQualityHint = document.getElementById('import-quality-hint');
    const importFormatSelect = document.getElementById('import-format-select');
    const importFormatField = document.getElementById('import-format-field');

    /**
     * Reconnaît une source locale : chemin Windows (C:\…), chemin POSIX (/…),
     * ou protocole file://. Tout le reste — URL http(s) ou simple recherche —
     * sera récupéré à distance, donc transcodé.
     */
    function isLocalSource(value) {
        const v = (value || '').trim().replace(/^["']|["']$/g, '');
        if (!v) return false;
        if (/^https?:\/\//i.test(v)) return false;
        return /^[a-zA-Z]:[\\/]/.test(v) || v.startsWith('\\\\') || v.startsWith('/') || /^file:\/\//i.test(v);
    }

    /** Grise les sélecteurs quand la saisie désigne un fichier local. */
    /**
     * Grise ce qui ne s'applique pas, et dit pourquoi.
     *
     * Trois cas se superposent, du plus large au plus fin :
     *
     *  - **une source locale** est importée telle quelle : aucun des trois
     *    menus n'y change quoi que ce soit, et c'est toute la rangée qui
     *    s'éteint ;
     *  - **le téléchargement vers un dossier** n'écrit que de l'audio — le menu
     *    Format ne propose aucun conteneur vidéo —, donc la définition vidéo y
     *    est sans objet ;
     *  - **un format sans perte** ignore le débit : FLAC et WAV gardent tout ce
     *    qu'on leur donne, et « 320 kbps » n'y voudrait rien dire.
     *
     * Griser la rangée entière dans les deux derniers cas dirait que rien ne
     * s'applique, ce qui serait faux. C'est donc par champ.
     */
    function updateQualityApplicability() {
        if (!importQualityRow) return;

        const local = isLocalSource(searchInput ? searchInput.value : '');
        importQualityRow.classList.toggle('not-applicable', local);

        const targetSelect = document.getElementById('add-target-select');
        const toDisk = !!targetSelect && targetSelect.value === 'download';
        const lossless = !!importFormatSelect
            && LOSSLESS_FORMATS.includes(importFormatSelect.value);

        const audioField = importAudioQualitySelect
            ? importAudioQualitySelect.closest('.import-quality-field') : null;
        const videoField = importVideoQualitySelect
            ? importVideoQualitySelect.closest('.import-quality-field') : null;

        /*
         * La qualité vidéo n'est plus sans objet dès qu'un conteneur vidéo est
         * choisi.
         *
         * Elle était grisée pour toute écriture sur le disque, et à raison tant
         * que celle-ci n'écrivait que du son. Elle sert désormais deux fois : à
         * choisir le flux qu'on va chercher, et — quand la source n'a pas
         * d'image — à dimensionner celle qu'on fabrique.
         *
         * La liste vient du menu lui-même plutôt que d'une copie : ajouter un
         * conteneur au balisage sans y penser ici le laisserait grisé sans
         * raison visible.
         */
        const videoContainers = importFormatSelect
            ? [...importFormatSelect.querySelectorAll('optgroup[data-i18n-label="import_group_video"] option')]
                .map((o) => o.value)
            : [];
        const wantsVideo = !!importFormatSelect
            && videoContainers.includes(importFormatSelect.value);

        if (audioField) audioField.classList.toggle('not-applicable', !local && toDisk && lossless);
        if (videoField) {
            videoField.classList.toggle('not-applicable', !local && toDisk && !wantsVideo);
        }

        if (importQualityHint) {
            // Le message le plus précis l'emporte : une source locale rend tout
            // le reste sans objet, et un format sans perte est plus surprenant
            // qu'une vidéo écartée d'un téléchargement qui n'écrit que du son.
            let notice = t('import_quality_hint');
            if (local) notice = t('import_quality_local_notice');
            else if (toDisk && wantsVideo) notice = t('import_quality_video_notice');
            else if (toDisk && lossless) notice = t('import_quality_lossless_notice');
            else if (toDisk) notice = t('import_quality_download_notice');

            importQualityHint.classList.toggle('highlighted', local || toDisk);
            importQualityHint.textContent = notice;
        }
    }

    /** Formats sans perte : le débit ne les concerne pas. */
    const LOSSLESS_FORMATS = ['flac', 'wav'];

    /**
     * Montre le menu « Format » pour la seule destination qui écrit un fichier,
     * et met à jour ce qui s'applique au choix courant.
     *
     * Les trois autres destinations n'écrivent aucun fichier : un menu
     * d'extension y désignerait quelque chose qui n'existe pas. Il se replie
     * donc, et le repli est animé par la feuille de style.
     *
     * `is-open` n'est posée qu'une fois l'animation finie. L'`overflow: hidden`
     * qui porte le repli rogne aussi le panneau du menu déroulant, lequel
     * descend sous le champ : la liste des formats se trouvait coupée à la
     * hauteur d'une ligne, et seul MP3 était atteignable.
     */
    function updateFormatFieldVisibility() {
        if (!importFormatField) return;

        const select = document.getElementById('add-target-select');
        const toDisk = !!select && select.value === 'download';

        if (toDisk) {
            importFormatField.classList.remove('is-collapsed');
            // Déjà à sa pleine largeur — premier affichage, ou appel répété :
            // aucune transition ne viendra, et l'attendre clouerait le rognage
            // en place.
            if (!formatFieldOpening()) importFormatField.classList.add('is-open');
        } else {
            // Avant de replier : sans quoi le panneau resterait libre de
            // déborder pendant que la largeur revient à zéro.
            importFormatField.classList.remove('is-open');
            importFormatField.classList.add('is-collapsed');
        }

        updateQualityApplicability();
    }
    window.MusicPlayer.updateFormatFieldVisibility = updateFormatFieldVisibility;

    /**
     * Le champ est-il encore en train de s'ouvrir ?
     *
     * Une largeur inférieure à ce que son contenu réclame signe une animation
     * en cours ; c'est alors `transitionend` qui posera `is-open`.
     */
    function formatFieldOpening() {
        if (!importFormatField) return false;
        return importFormatField.getBoundingClientRect().width < importFormatField.scrollWidth;
    }

    if (importFormatField) {
        importFormatField.addEventListener('transitionend', (e) => {
            if (e.target !== importFormatField) return;
            // La largeur en rangée, la hauteur en colonne : la propriété animée
            // dépend du sens de la rangée, les deux sont acceptées.
            if (e.propertyName !== 'max-width' && e.propertyName !== 'max-height') return;
            if (importFormatField.classList.contains('is-collapsed')) return;
            importFormatField.classList.add('is-open');
        });
    }

    if (searchInput) {
        searchInput.addEventListener('input', updateQualityApplicability);
    }

    if (importFormatSelect) {
        importFormatSelect.addEventListener('change', (e) => {
            window.MusicPlayer.sendWS({
                type: 'updateSettings',
                data: { importFormat: e.target.value }
            });
            // Passer en FLAC ou en WAV éteint le débit audio, et en sortir le
            // rallume : l'applicabilité suit le format, pas seulement la
            // destination.
            updateQualityApplicability();
        });
    }

    if (importAudioQualitySelect) {
        importAudioQualitySelect.addEventListener('change', (e) => {
            window.MusicPlayer.sendWS({
                type: 'updateSettings',
                data: { importAudioQuality: e.target.value }
            });
        });
    }

    if (importVideoQualitySelect) {
        importVideoQualitySelect.addEventListener('change', (e) => {
            window.MusicPlayer.sendWS({
                type: 'updateSettings',
                data: { importVideoQuality: e.target.value }
            });
        });
    }

    // Broadcast Mode Select
    //
    // L'enchaînement mix suivait autrefois le mode de diffusion : il était
    // coupé d'office au passage en diffusion globale, faute de pouvoir
    // superposer deux pistes sur Discord. Le bus de mixage du serveur le permet
    // désormais, et le réglage reste donc tel que l'utilisateur l'a laissé.
    broadcastModeSelect.addEventListener('change', (e) => {
        sendWS({
            type: 'updateSettings',
            data: { broadcastMode: e.target.value }
        });
    });

    // Guild and Voice Channel Selector
    guildSelect.addEventListener('change', (e) => {
        const val = e.target.value;
        if (val) {
            const [guildId, channelId] = val.split(':');
            const isNewGuild = currentGuildId !== guildId;
            currentGuildId = guildId;
            sendWS({
                type: 'selectChannel',
                data: { guildId, channelId }
            });
            if (isNewGuild) {
                triggerCardsBounce('guild');
            } else {
                triggerCardsBounce('channel');
            }
        }
    });

    // Ducking toggle checkbox
    duckingEnableToggle.addEventListener('change', (e) => {
        const checked = e.target.checked;
        sendWS({
            type: 'updateSettings',
            data: { duckingEnabled: checked }
        });
        if (checked) {
            duckingOptionsContainer.classList.remove('disabled');
        } else {
            duckingOptionsContainer.classList.add('disabled');
        }
        duckingLevelRange.disabled = !checked;
        duckingDelayRange.disabled = !checked;
        duckingFadeRange.disabled = !checked;
    });

    // Mix toggle checkbox
    mixEnableToggle.addEventListener('change', (e) => {
        const checked = e.target.checked;
        sendWS({
            type: 'updateSettings',
            data: { mixEnabled: checked }
        });
        if (checked) {
            mixOptionsContainer.classList.remove('disabled');
        } else {
            mixOptionsContainer.classList.add('disabled');
        }
        mixDurationRange.disabled = !checked;
    });

    // Mix duration slider
    mixDurationRange.addEventListener('input', (e) => {
        const val = e.target.value;
        mixDurationVal.textContent = `${val}s`;
    });
    mixDurationRange.addEventListener('change', (e) => {
        const val = parseInt(e.target.value);
        sendWS({
            type: 'updateSettings',
            data: { mixDuration: val }
        });
    });

    /**
     * « −14.0 LUFS », avec le vrai signe moins.
     *
     * Le trait d'union du clavier est plus court et plus haut que le signe
     * moins : dans une valeur affichée en gros, à côté d'un curseur, la
     * différence se voit.
     *
     * @param {number|string} value
     * @returns {string}
     */
    function formatLufsTarget(value) {
        const number = parseFloat(value);
        if (!Number.isFinite(number)) return '—';
        return `${number.toFixed(1).replace('-', '−')} LUFS`;
    }

    // --- Synchronisation des niveaux sonores ---
    if (lufsSyncToggle) {
        lufsSyncToggle.addEventListener('change', (e) => {
            const checked = e.target.checked;
            lufsSyncOptions.classList.toggle('disabled', !checked);
            sendWS({ type: 'updateSettings', data: { lufsSyncEnabled: checked } });
        });

        /*
         * Le curseur émet pendant qu'on le déplace, pas seulement au
         * relâchement : le réglage doit s'entendre sur le morceau en cours
         * pendant qu'on cherche le bon niveau. Les envois sont regroupés — un
         * curseur produit une valeur par pixel parcouru, et chacune coûte une
         * diffusion d'état à tous les tableaux de bord connectés.
         */
        let lufsSendTimer = null;
        const pushLufsTarget = (value, immediate) => {
            if (lufsSendTimer) {
                clearTimeout(lufsSendTimer);
                lufsSendTimer = null;
            }
            const emit = () => {
                lufsSendTimer = null;
                sendWS({ type: 'updateSettings', data: { lufsSyncTarget: value } });
            };
            if (immediate) emit();
            else lufsSendTimer = setTimeout(emit, 120);
        };

        lufsSyncRange.addEventListener('input', (e) => {
            const value = parseFloat(e.target.value);
            lufsSyncVal.textContent = formatLufsTarget(value);
            pushLufsTarget(value, false);
        });
        lufsSyncRange.addEventListener('change', (e) => {
            pushLufsTarget(parseFloat(e.target.value), true);
        });
    }

    // Mix type segmented control buttons
    mixTypeButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const mixType = btn.getAttribute('data-type');
            mixTypeButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            sendWS({
                type: 'updateSettings',
                data: { mixType }
            });
        });
    });

    // Sliders init
    setupSlider(volumeRange, volumeVal, 'baseVolume', '%');
    setupSlider(duckingLevelRange, duckingLevelVal, 'duckingLevel', '%');
    setupSlider(duckingDelayRange, duckingDelayVal, 'duckingDelay', 'ms');
    setupSlider(duckingFadeRange, duckingFadeVal, 'duckingFade', 'ms');

    // --- Seek Control (Click & Drag) ---
    function handleSeekEvent(e) {
        if (!state.progress || !state.progress.totalMs) return;
        const rect = progressBarWrapper.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const width = rect.width;
        const percentage = Math.min(Math.max(clickX / width, 0), 1);

        // Update progress bar and time current locally for responsive visual feedback
        if (progressBar) {
            progressBar.style.transform = `scaleX(${percentage})`;
            window.MusicPlayer.currentProgressRatio = percentage;
        }
        const speed = parseFloat(state.settings.playbackSpeed || window.MusicPlayer.currentSpeed || '1.0');
        const currentMs = percentage * state.progress.totalMs;
        timeCurrent.textContent = formatMs(Math.round(currentMs / speed));
        syncVideoProgress(currentMs, true);
    }

    progressBarWrapper.addEventListener('mousedown', (e) => {
        if (state.progress && state.progress.totalMs) {
            isSeeking = true;
            handleSeekEvent(e);
        }
    });

    window.addEventListener('mousemove', (e) => {
        if (isSeeking) {
            handleSeekEvent(e);
        }
    });

    window.addEventListener('mouseup', (e) => {
        if (isSeeking) {
            isSeeking = false;
            if (state.progress && state.progress.totalMs) {
                const rect = progressBarWrapper.getBoundingClientRect();
                const clickX = e.clientX - rect.left;
                const width = rect.width;
                const percentage = Math.min(Math.max(clickX / width, 0), 1);
                const targetMs = Math.round(percentage * state.progress.totalMs);

                sendWS({
                    type: 'seek',
                    data: { time: targetMs }
                });
            }
        }
    });

    function seekRelative(deltaMs) {
        if (!state || !state.progress || !state.progress.totalMs) return;
        const totalMs = state.progress.totalMs;
        const currentMs = (personalAudio && !isNaN(personalAudio.currentTime))
            ? Math.round(personalAudio.currentTime * 1000)
            : (state.progress.currentMs || 0);
        const targetMs = Math.max(0, Math.min(totalMs, currentMs + deltaMs));

        if (personalAudio && state.settings && state.settings.broadcastMode === 'personal') {
            personalAudio.currentTime = targetMs / 1000;
            suspendPreload();
        }
        sendWS({
            type: 'seek',
            data: { time: targetMs }
        });
        syncVideoProgress(targetMs, true);
    }

    function seekPercent(percent) {
        if (!state || !state.progress || !state.progress.totalMs) return;
        const totalMs = state.progress.totalMs;
        const targetMs = Math.max(0, Math.min(totalMs, Math.round((percent / 100) * totalMs)));

        if (personalAudio && state.settings && state.settings.broadcastMode === 'personal') {
            personalAudio.currentTime = targetMs / 1000;
            suspendPreload();
        }
        sendWS({
            type: 'seek',
            data: { time: targetMs }
        });
        syncVideoProgress(targetMs, true);
    }

    function adjustVolumeRelative(delta) {
        const currentVol = (state && state.volume !== undefined) ? state.volume : 70;
        const targetVol = Math.max(0, Math.min(100, currentVol + delta));
        if (volumeRange) {
            volumeRange.value = targetVol;
            volumeRange.dispatchEvent(new Event('input'));
            volumeRange.dispatchEvent(new Event('change'));
        }
    }

    window.MusicPlayer.seekRelative = seekRelative;
    window.MusicPlayer.seekPercent = seekPercent;
    window.MusicPlayer.adjustVolumeRelative = adjustVolumeRelative;

    // --- Contrôleur de Ducking Audio Client ---
    const clientDucking = {
        isDucked: false,
        fadeInterval: null,
        restoreTimer: null,
        currentVolume: 70,
        lastBaseVolume: 70,

        applyVolume(vol) {
            this.currentVolume = vol;
            // Pendant l'extinction, la rampe de fade-out est seule maîtresse du
            // gain. `update()` s'en abstient déjà, mais une descente de ducking
            // ou un timer de restauration lancés juste avant continuent, eux, de
            // s'exécuter : ils feraient remonter le volume au milieu du fondu.
            if (isShuttingDown) return;
            if (personalAudio && !personalAudio.isMixFadingIn && !personalAudio.isMixFadingOut) {
                personalAudio.volume = vol / 100;
            }
        },

        fadeTo(target, duration) {
            if (this.fadeInterval) {
                clearInterval(this.fadeInterval);
                this.fadeInterval = null;
            }

            const startVol = this.currentVolume;
            if (duration <= 0 || Math.abs(startVol - target) < 1) {
                this.applyVolume(target);
                return;
            }

            const stepInterval = 30; // ms
            const steps = Math.max(1, Math.floor(duration / stepInterval));
            const volumeDelta = (target - startVol) / steps;
            let currentStep = 0;

            this.fadeInterval = setInterval(() => {
                currentStep++;
                if (currentStep >= steps) {
                    this.applyVolume(target);
                    clearInterval(this.fadeInterval);
                    this.fadeInterval = null;
                    return;
                }
                const newVol = startVol + (volumeDelta * currentStep);
                this.applyVolume(Math.max(0, Math.min(100, Math.round(newVol))));
            }, stepInterval);
        },

        update(state) {
            if (!personalAudio || isShuttingDown) return;
            const isPersonal = state.settings.broadcastMode === 'personal';
            if (!isPersonal) {
                if (this.fadeInterval) {
                    clearInterval(this.fadeInterval);
                    this.fadeInterval = null;
                }
                if (this.restoreTimer) {
                    clearTimeout(this.restoreTimer);
                    this.restoreTimer = null;
                }
                this.isDucked = false;
                return;
            }

            const baseVolume = state.volume !== undefined ? state.volume : 70;
            const duckingEnabled = state.settings.duckingEnabled;
            const duckingLevel = state.settings.duckingLevel !== undefined ? state.settings.duckingLevel : 20;
            const duckingFade = state.settings.duckingFade !== undefined ? state.settings.duckingFade : 200;
            const duckingDelay = state.settings.duckingDelay !== undefined ? state.settings.duckingDelay : 800;

            // S'assurer que le volume de personalAudio / activeAudio est toujours synchronisé avec la valeur de l'état
            const expectedTargetVol = this.isDucked ? Math.round(baseVolume * (duckingLevel / 100)) : baseVolume;
            const expectedVolRatio = expectedTargetVol / 100;

            if (!isShuttingDown && !this.fadeInterval && personalAudio && !personalAudio.isMixFadingIn && !personalAudio.isMixFadingOut) {
                if (Math.abs(personalAudio.volume - expectedVolRatio) > 0.01 || this.currentVolume !== expectedTargetVol || baseVolume !== this.lastBaseVolume) {
                    this.lastBaseVolume = baseVolume;
                    this.applyVolume(expectedTargetVol);
                }
            }

            // Compter les participants actifs en train de parler et non ignorés
            const ignoredUsers = state.ignoredVoiceUsers || [];
            const activeSpeakersCount = state.members.filter(m =>
                state.speakers.includes(m.id) && !ignoredUsers.includes(m.id)
            ).length;

            if (duckingEnabled && activeSpeakersCount > 0) {
                if (this.restoreTimer) {
                    clearTimeout(this.restoreTimer);
                    this.restoreTimer = null;
                }
                if (!this.isDucked) {
                    this.isDucked = true;
                    const targetVol = Math.round(baseVolume * (duckingLevel / 100));
                    this.fadeTo(targetVol, duckingFade);
                }
            } else {
                if (this.isDucked) {
                    if (!this.restoreTimer) {
                        this.restoreTimer = setTimeout(() => {
                            this.isDucked = false;
                            this.fadeTo(baseVolume, duckingFade);
                            this.restoreTimer = null;
                        }, duckingDelay);
                    }
                } else {
                    if (this.currentVolume !== baseVolume && !this.fadeInterval) {
                        this.applyVolume(baseVolume);
                    }
                }
            }
        }
    };

    function setupAudioListeners(audio) {
        /*
         * Un chargement qui échoue ne se voyait nulle part.
         *
         * L'élément reste alors muet, et le serveur — qui tient la progression
         * du mode personnel de son côté — continue d'avancer : la barre défile
         * sur du silence, sans un mot. C'est ainsi qu'un flux vide servi par
         * `/api/stream` a pu passer des semaines pour une bizarrerie sans
         * logique. L'erreur est désormais dite à l'utilisateur et remontée au
         * journal du bot, seul endroit consultable depuis un téléphone.
         */
        audio.addEventListener('error', () => {
            // Le fragment silencieux du déverrouillage, et la source vidée
            // volontairement à la fin d'un fondu : ni l'un ni l'autre n'est un
            // incident.
            if (audio.unlockInProgress || !audio.getAttribute('src')) return;

            const err = audio.error;
            const title = (state.currentTrack && state.currentTrack.title) || '—';
            const detail = `code ${err ? err.code : '?'}`
                + `${err && err.message ? ` : ${err.message}` : ''}`
                + ` | readyState ${audio.readyState} | networkState ${audio.networkState}`;

            sendWS({
                type: 'clientLog',
                data: {
                    source: 'Audio',
                    message: `ECHEC CHARGEMENT | « ${title} » `
                        + `| element ${audio === primaryAudio ? 'primaire' : 'secondaire'} `
                        + `| actif ${audio === activeAudio ? 'oui' : 'non'} | ${detail}`
                }
            });

            // Une reprise d'abord : la plupart de ces échecs tiennent au
            // transport, et un rechargement à la position atteinte les efface
            // sans que l'utilisateur ait rien à faire.
            if (reloadPersonalAudio(audio, detail)) return;

            // Seul l'élément qui a la charge du son mérite d'interrompre
            // l'utilisateur : l'autre prépare un enchaînement dont l'échec se
            // verra bien assez tôt.
            if (audio === activeAudio && state.settings.broadcastMode === 'personal') {
                showToast(t('toast_track_load_failed').replace('{title}', title));
            }
        });

        audio.addEventListener('progress', () => {
            if (audio === activeAudio) window.MusicPlayer.updateBufferUI();
        });
        audio.addEventListener('canplay', () => {
            if (audio === activeAudio) window.MusicPlayer.updateBufferUI();
        });
        audio.addEventListener('loadedmetadata', () => {
            if (audio === activeAudio) window.MusicPlayer.updateBufferUI();
        });

        audio.addEventListener('timeupdate', () => {
            if (state.settings.broadcastMode !== 'personal' || isSeeking) return;

            // Only the ACTIVE audio element should send sync progress and trigger transition
            if (audio === activeAudio) {
                window.MusicPlayer.updateBufferUI();
            } else {
                return;
            }

            /*
             * Le préchargement est aussi décidé ici, et pas seulement à la
             * réception de l'état.
             *
             * Un téléphone verrouillé, ou dont on a quitté le navigateur, ne
             * garde la page vivante que parce qu'un son y joue : les minuteries
             * y sont bridées et les messages du serveur peuvent s'espacer. Cet
             * événement-ci, en revanche, est émis par la lecture elle-même,
             * plusieurs fois par seconde tant qu'elle dure. C'est le battement
             * le plus fiable dont on dispose dans cet état.
             *
             * L'appel est sans effet tant qu'il n'y a rien à faire : il se
             * contente de comparer ce que la réserve tient à ce qui vient.
             */
            preloadNextTrack();

            // Le serveur prend cette valeur pour argent comptant. Tant que la
            // position restaurée n'a pas été appliquée à l'élément, la remonter
            // reviendrait à lui annoncer un retour au début de la piste.
            //
            // Et seul le pilote la remonte : le serveur n'écoute que lui (voir
            // handleSyncProgress). `!== false` et non `=== true` — tant que le
            // premier état n'est pas arrivé, on ne sait pas encore, et c'est au
            // serveur de trier.
            const now = Date.now();
            if (state.pilot !== false && !audio.pendingInitialPosition && now - lastSyncTime >= 1000) {
                lastSyncTime = now;
                sendWS({
                    type: 'syncProgress',
                    data: { progressMs: Math.round(audio.currentTime * 1000) }
                });
            }

            // Pendant la transition, la barre et le temps suivent l'élément qui
            // joue, sans attendre l'état du serveur.
            //
            // L'échelle est la seule commande de la barre : sa largeur reste à
            // 100 %. Y toucher ici la multipliait par l'échelle appliquée
            // ailleurs, et la laissait ensuite figée à quelques pour cent — la
            // progression paraissait alors cent fois plus lente qu'elle n'était.
            // `Number.isFinite` et non `!isNaN` : un morceau entrant encore
            // transcodé à la volée n'a pas de fin connue, et l'infini passait —
            // barre à zéro, total illisible. On laisse alors la boucle
            // d'affichage, qui connaît la durée des métadonnées.
            if (mixTransitionNextTrack && !isSeeking && Number.isFinite(audio.duration) && audio.duration > 0) {
                const currentSecs = audio.currentTime;
                const totalSecs = audio.duration;
                const ratio = Math.min(1, Math.max(0, currentSecs / totalSecs));
                if (progressBar) {
                    progressBar.style.transform = `scaleX(${ratio})`;
                    window.MusicPlayer.currentProgressRatio = ratio;
                }
                const speed = parseFloat(state.settings.playbackSpeed || window.MusicPlayer.currentSpeed || '1.0');
                timeCurrent.textContent = formatMs(Math.round((currentSecs * 1000) / speed));
                paintTotal(totalSecs * 1000, speed);
            }

            // Client-side Mix transition trigger
            const duration = audio.duration;
            const current = audio.currentTime;
            const remaining = duration - current;
            const mixDuration = state.settings.mixDuration || 5;

            // `pilote === false` : un autre tableau de bord mène la lecture de ce
            // serveur. Enchaîner ici reviendrait à annoncer une fin de piste que
            // le serveur écarterait, et à faire jouer deux morceaux ensemble sur
            // un appareil qui n'a pas la main.
            if (state.pilot === false) {
                // rien : la lecture suit ce que le pilote décide
            } else if (state.settings.mixEnabled && state.repeatMode !== 1 && !isNaN(duration) && duration > 0 && remaining <= mixDuration && remaining > 0 && !audio.isMixFadingOut) {
                audio.isMixFadingOut = true;

                // Identify fade and next audio
                fadeAudio = audio;
                const nextAudio = (audio === primaryAudio) ? secondaryAudio : primaryAudio;

                // Identifiant du fondu : le journal du serveur ne voyait que les
                // sauts d'arrivée, sans pouvoir dire s'ils venaient d'un même
                // enchaînement ou de deux. Ce numéro relie chaque départ à sa fin.
                const fadeId = (window.MusicPlayer._fadeSeq = (window.MusicPlayer._fadeSeq || 0) + 1);
                audio.mixFadeId = fadeId;

                // Piste quittée, relevée ici et non à la fin du fondu.
                //
                // Un autre tableau de bord peut terminer le sien quelques
                // centaines de millisecondes plus tôt : sa propre annonce fait
                // alors avancer la file, et `state.currentTrack` désigne déjà le
                // titre suivant quand celui-ci s'achève. Annoncer cette
                // valeur-là revenait à déclarer terminer la piste qui vient de
                // commencer, ce que le serveur ne pouvait plus distinguer.
                const finishedUrl = audio.currentTrackUrl
                    || (state.currentTrack && state.currentTrack.url) || null;

                console.log(`[Audio Mix] Starting the ${mixDuration}s client-side fade-out...`);
                sendWS({
                    type: 'clientLog',
                    data: {
                        source: 'Mix',
                        message: `DEPART fondu #${fadeId} | element ${audio === primaryAudio ? 'primaire' : 'secondaire'} `
                            + `| « ${(state.currentTrack && state.currentTrack.title) || '—'} » `
                            + `| position ${current.toFixed(2)}s / duree ${duration.toFixed(2)}s `
                            + `| restant ${remaining.toFixed(2)}s | mixDuration ${mixDuration}s`
                    }
                });

                // La piste suivante dépend de la source active : file d'attente
                // ou playlist. Voir MusicPlayer.pisteSuivante.
                const nextTrack = window.MusicPlayer.nextTrackOf(state);
                if (nextTrack) {
                    // Le préchargement l'a peut-être déjà mis là : recharger la
                    // même source repartirait de zéro, et le fondu s'ouvrirait
                    // sur un tampon vide.
                    if (nextAudio.currentTrackUrl !== nextTrack.url) {
                        nextAudio.currentTrackUrl = nextTrack.url;
                        nextAudio.src = streamUrlFor(nextTrack);
                        nextAudio.load();
                    }
                    nextAudio.volume = 0;
                    nextAudio.isMixFadingIn = true;
                    nextAudio.isMixFadingOut = false;

                    nextAudio.play().then(() => {
                        sendWS({
                            type: 'clientLog',
                            data: { source: 'Mix', message: `LECTURE fondu #${fadeId} | l'entrant joue` }
                        });
                    }).catch(err => {
                        console.warn('[Audio Mix] Cannot play the next track:', err);
                        // Remonté au serveur : un échec de `play()` ne laissait
                        // qu'un avertissement dans la console du navigateur,
                        // invisible depuis un téléphone. Le fondu se déroulait
                        // alors sur du silence, sans que rien ne le signale.
                        sendWS({
                            type: 'clientLog',
                            data: {
                                source: 'Mix',
                                message: `ECHEC LECTURE fondu #${fadeId} | ${err && err.name} : ${err && err.message}`
                            }
                        });
                    });

                    // Swap active audio and update UI details immediately
                    activeAudio = nextAudio;
                    window.MusicPlayer.activeAudio = activeAudio;
                    personalAudio = nextAudio; // Make controllers target the new audio
                    mixTransitionNextTrack = nextTrack;
                    // Les deux morceaux jouent désormais ensemble : les listes
                    // de lecture animent leurs deux lignes jusqu'à la fin du fondu.
                    mixTransition = {
                        outgoing: {
                            url: fadeAudio.currentTrackUrl || (state.currentTrack && state.currentTrack.url) || null,
                            element: fadeAudio
                        },
                        incoming: { url: nextTrack.url, element: nextAudio }
                    };
                    updateUI();

                    const startVol = fadeAudio.volume;
                    const targetVol = (state.volume || 100) / 100;
                    const steps = 20;
                    const stepInterval = (remaining * 1000) / steps;
                    let currentStep = 0;

                    const fadeInterval = setInterval(() => {
                        currentStep++;
                        if (currentStep >= steps) {
                            clearInterval(fadeInterval);
                            fadeAudio.volume = 0;
                            fadeAudio.pause();
                            fadeAudio.src = '';
                            fadeAudio.removeAttribute('src');
                            fadeAudio.load();
                            fadeAudio.currentTrackUrl = null;
                            fadeAudio.isMixFadingOut = false;

                            // Sans cette libération, `isMixTransitioning`
                            // resterait vrai pour toujours et plus aucune piste
                            // ne serait chargée hors enchaînement.
                            fadeAudio = null;

                            nextAudio.isMixFadingIn = false;
                            nextAudio.volume = targetVol;

                            // Les deux morceaux ne sonnent plus ensemble, mais
                            // le serveur ignore encore le changement : la piste
                            // entrante reste annoncée — à l'affichage comme aux
                            // gardes — jusqu'à ce qu'il l'ait confirmée.
                            mixTransition = null;
                            mixAwaitingConfirmation = { url: nextTrack.url, element: nextAudio };
                            mixWaitingSinceMs = Date.now();

                            console.log('[Audio Mix] Transition completed, sending skip.');
                            sendWS({
                                type: 'clientLog',
                                data: {
                                    source: 'Mix',
                                    message: `FIN fondu #${fadeId} | envoi du saut `
                                        + `| entrant « ${nextTrack.title || '—'} » a ${nextAudio.currentTime.toFixed(2)}s `
                                        + `| sortant « ${(fadeAudio && fadeAudio.currentTrackUrl) || '—'} »`
                                }
                            });
                            sendWS({
                                type: 'skip',
                                data: {
                                    startProgressMs: Math.round(nextAudio.currentTime * 1000),
                                    // Fin de piste, et non appui sur « suivant ».
                                    // Plusieurs tableaux de bord peuvent être
                                    // ouverts — celui que le bot lance sur le PC
                                    // au démarrage, et le vôtre : chacun mène son
                                    // fondu et annonce la même fin. L'URL quittée
                                    // permet au serveur de n'en retenir qu'une.
                                    auto: true,
                                    finishedUrl
                                }
                            });

                            updateUI();
                            return;
                        }

                        // Fade out
                        fadeAudio.volume = startVol * (1 - (currentStep / steps));
                        // Fade in
                        nextAudio.volume = targetVol * (currentStep / steps);
                    }, stepInterval);
                } else {
                    // No next track, just fade out to end
                    const startVol = fadeAudio.volume;
                    const steps = 20;
                    const stepInterval = (remaining * 1000) / steps;
                    let currentStep = 0;

                    const fadeInterval = setInterval(() => {
                        currentStep++;
                        if (currentStep >= steps) {
                            clearInterval(fadeInterval);
                            fadeAudio.volume = 0;
                            fadeAudio.pause();
                            fadeAudio.src = '';
                            fadeAudio.removeAttribute('src');
                            fadeAudio.load();
                            fadeAudio.currentTrackUrl = null;
                            fadeAudio.isMixFadingOut = false;
                            fadeAudio = null;

                            console.log('[Audio Mix] No next track. skip.');
                            sendWS({ type: 'skip' });
                            return;
                        }
                        fadeAudio.volume = startVol * (1 - (currentStep / steps));
                    }, stepInterval);
                }
            }
        });

        audio.addEventListener('ended', () => {
            // Le fragment silencieux du déverrouillage se termine aussitôt : ni
            // trace ni saut ne doivent en découler.
            if (audio.unlockInProgress) return;

            /*
             * La condition est calculée une fois, et sert aux deux.
             *
             * Elle était écrite deux fois : une pour le journal, une pour
             * l'envoi — et les deux ne disaient pas la même chose, le libellé
             * ayant oublié la clause du pilote. Un tableau de bord qui n'est pas
             * pilote écrivait donc « saut ENVOYE » sans rien envoyer.
             *
             * Le mensonge a coûté cher. Quand l'élection de pilote manquait sur
             * un serveur, la lecture s'y arrêtait en fin de piste, le journal se
             * remplissait d'annonces de sauts que personne n'avait reçues, et
             * rien côté serveur ne pouvait le contredire : il n'avait rien vu
             * passer. Chercher pourquoi un saut « envoyé » n'arrivait pas mène
             * partout sauf à l'endroit.
             */
            const announces = state.settings.broadcastMode === 'personal'
                && audio === activeAudio
                && state.pilot !== false;

            // Tracé même lorsque le garde écarte l'envoi : savoir qu'un élément
            // s'est terminé sans provoquer de saut vaut autant que l'inverse.
            sendWS({
                type: 'clientLog',
                data: {
                    source: 'Mix',
                    message: `ENDED | element ${audio === primaryAudio ? 'primaire' : 'secondaire'} `
                        + `| actif ${audio === activeAudio ? 'oui' : 'non'} `
                        + `| fondu sortant ${audio.isMixFadingOut ? 'oui' : 'non'} `
                        + `| mode ${state.settings.broadcastMode} `
                        + `| pilote ${state.pilot === false ? 'non' : 'oui'} `
                        + `| saut ${announces ? 'ENVOYE' : 'ecarte'}`
                }
            });
            // Seul le pilote annonce les fins de piste — voir le déclenchement du
            // fondu plus haut, et l'élection côté serveur.
            if (announces) {
                console.log('[Audio] ended, skipping to next track');
                sendWS({
                    type: 'skip',
                    data: {
                        auto: true,
                        finishedUrl: audio.currentTrackUrl
                            || (state.currentTrack && state.currentTrack.url) || null
                    }
                });
            }
        });
    }

    if (primaryAudio) setupAudioListeners(primaryAudio);
    if (secondaryAudio) setupAudioListeners(secondaryAudio);

    /**
     * Autorise la lecture des deux éléments audio, à la faveur d'un geste.
     *
     * Les navigateurs mobiles refusent `play()` sur un élément qu'aucune action
     * de l'utilisateur n'a jamais déclenché — `NotAllowedError`. Or en
     * diffusion personnelle, presque tous nos `play()` partent d'un message du
     * serveur, jamais d'un appui : sans autorisation préalable, la piste se
     * charge, la barre de progression avance, et il ne sort aucun son. C'est
     * exactement le symptôme qu'on a mis des jours à cerner.
     *
     * Trois choses ont été corrigées ici, et il fallait les trois :
     *
     *  1. **Le fragment silencieux était illisible.** Son en-tête annonçait un
     *     bloc de données vide, ce que WebKit refuse de charger : la lecture du
     *     fragment échouait, donc l'autorisation avec elle. Le remplaçant porte
     *     vingt millisecondes de vrai silence — 204 octets, PCM 8 bits.
     *
     *  2. **Un échec était définitif.** Le drapeau passait à `vrai` avant même
     *     de savoir si l'autorisation avait été obtenue, et l'écouteur était
     *     posé en `once` : le premier geste consommait l'unique tentative. On
     *     réessaie désormais à chaque geste jusqu'à obtenir gain de cause.
     *
     *  3. **L'élément déjà pourvu d'une source était sauté**, au motif qu'il
     *     jouait donc était déjà autorisé. C'est faux : sur téléphone, l'état
     *     du serveur arrive avant le premier appui et lui pose une source qu'il
     *     n'a jamais eu le droit de jouer. Il est donc lancé pour de bon, puis
     *     remis en pause aussitôt si le serveur ne le jouait pas.
     */
    const SILENCE_WAV = 'data:audio/wav;base64,'
        + 'UklGRsQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YaAAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA';

    const UNLOCK_GESTURES = ['pointerdown', 'touchstart', 'keydown'];
    let audioUnlocked = false;

    /**
     * Obtient de ce navigateur le droit de faire jouer un élément.
     *
     * @param {HTMLAudioElement} el
     * @returns {Promise<boolean>} L'autorisation a-t-elle été accordée.
     */
    function grantPlayback(el) {
        if (el.playbackGranted) return Promise.resolve(true);

        const settle = (granted) => {
            if (granted) el.playbackGranted = true;
            return granted;
        };

        if (el.getAttribute('src')) {
            // Ce que le serveur veut de cet élément : s'il ne doit pas jouer, la
            // lecture est aussitôt refermée. Le geste, lui, aura été dépensé —
            // c'est tout ce qu'on lui demandait.
            const wanted = state.isPlaying && !state.isPaused && el === activeAudio;
            const promise = el.play();
            if (!promise || typeof promise.then !== 'function') return Promise.resolve(settle(true));
            return promise.then(() => {
                if (!wanted) el.pause();
                return settle(true);
            }).catch(() => settle(false));
        }

        el.unlockInProgress = true;
        el.muted = true;
        el.src = SILENCE_WAV;

        const cleanup = () => {
            try { el.pause(); } catch (e) {}
            el.removeAttribute('src');
            el.load();
            el.muted = false;
            el.unlockInProgress = false;
        };

        const promise = el.play();
        if (!promise || typeof promise.then !== 'function') {
            cleanup();
            return Promise.resolve(settle(true));
        }
        return promise
            .then(() => { cleanup(); return settle(true); })
            .catch(() => { cleanup(); return settle(false); });
    }

    function unlockAudio() {
        if (audioUnlocked) return;

        const targets = [primaryAudio, secondaryAudio].filter((el) => el && !el.playbackGranted);
        if (targets.length === 0) {
            audioUnlocked = true;
            clearBlockedPlayback();
            return;
        }

        Promise.all(targets.map(grantPlayback)).then((results) => {
            if (results.every(Boolean)) {
                audioUnlocked = true;
                clearBlockedPlayback();
                UNLOCK_GESTURES.forEach((evt) => {
                    document.removeEventListener(evt, unlockAudio, true);
                });
                return;
            }

            // Une seule fois par élément : le geste suivant réessaiera, et le
            // journal n'a pas besoin d'en tenir le compte.
            targets.forEach((el) => {
                if (el.playbackGranted || el.unlockRefusalReported) return;
                el.unlockRefusalReported = true;
                sendWS({
                    type: 'clientLog',
                    data: {
                        source: 'Audio',
                        message: 'DEVERROUILLAGE refuse pour l\'element '
                            + (el === primaryAudio ? 'primaire' : 'secondaire')
                            + ' — un nouveau geste sera retente'
                    }
                });
            });
        });
    }

    // Sans `once` : tant que l'autorisation n'est pas acquise, chaque geste est
    // une occasion de la demander. Les écouteurs se retirent d'eux-mêmes une
    // fois les deux éléments autorisés.
    UNLOCK_GESTURES.forEach((evt) => {
        document.addEventListener(evt, unlockAudio, { capture: true });
    });

    /**
     * Explique, dans la carte de lecture, que le navigateur retient le son.
     *
     * Le refus est le sien, et sa décision est prise avant que le tableau de
     * bord n'ait son mot à dire : la seule chose utile est de la rendre lisible.
     * Elle tient à ceci — il ne démarre pas le son tout seul sur une adresse
     * qu'il connaît encore mal, et il l'apprend au fil des écoutes. C'est donc
     * un état de passage, ce que le texte dit, pour que le silence ne passe pas
     * pour une panne.
     *
     * Une note posée près de la barre de progression, et non une notification
     * qui passe : la condition dure tant qu'aucun geste n'a porté sur la page,
     * et un message qui s'efface au bout de quatre secondes laisserait ensuite
     * le même silence inexpliqué. Elle voisine avec celle du salon vide, qui
     * répond à la même question — pourquoi rien ne sort alors que l'état se dit
     * en marche.
     */
    let playbackBlocked = false;

    function renderBlockedNotice() {
        const notice = document.getElementById('playback-blocked-notice');
        if (notice) notice.classList.toggle('hidden', !playbackBlocked);
    }

    function announceBlockedPlayback() {
        if (playbackBlocked || audioUnlocked) return;
        playbackBlocked = true;
        renderBlockedNotice();
    }

    /** Le son est acquis : l'explication n'a plus lieu d'être. */
    function clearBlockedPlayback() {
        if (!playbackBlocked) return;
        playbackBlocked = false;
        renderBlockedNotice();
    }

    // Le bouton de la note. N'importe quel clic ferait l'affaire — l'écouteur de
    // déverrouillage les capte tous — mais il faut bien en désigner un.
    const resumeBlockedBtn = document.getElementById('btn-resume-blocked');
    if (resumeBlockedBtn) resumeBlockedBtn.addEventListener('click', unlockAudio);

    /**
     * Place un élément audio fraîchement chargé à la position déjà atteinte côté
     * serveur.
     *
     * Tant que le repositionnement n'a pas eu lieu, l'élément est à 0 : le
     * drapeau `positionInitialeEnAttente` empêche `syncProgress` de renvoyer ce
     * zéro au serveur, ce qui écraserait la position restaurée et ferait
     * repartir la piste de son début.
     *
     * @param {HTMLAudioElement} audio
     * @param {number} secondes Position visée
     * @param {() => void} [whenReady] Appelé une fois la position posée — ou
     *   tout de suite s'il n'y a rien à rattraper, ou en cas d'échec du
     *   chargement, afin qu'aucun traitement en attente ne reste bloqué.
     */
    function applyInitialPosition(audio, seconds, whenReady) {
        const report = () => {
            if (typeof whenReady === 'function') whenReady();
        };

        // En deçà d'une seconde, rien à rattraper : la piste commence à son début.
        if (!(seconds > 1)) {
            audio.pendingInitialPosition = false;
            report();
            return;
        }

        audio.pendingInitialPosition = true;

        const giveUp = () => {
            audio.removeEventListener('loadedmetadata', apply);
            audio.removeEventListener('error', giveUp);
            audio.pendingInitialPosition = false;
            report();
        };

        const apply = () => {
            audio.removeEventListener('error', giveUp);
            audio.removeEventListener('loadedmetadata', apply);
            try {
                audio.currentTime = seconds;
            } catch (e) {
                console.warn('[Audio] Repositionnement impossible :', e);
            }
            audio.pendingInitialPosition = false;
            report();
        };

        // `loadedmetadata` garantit une durée connue ; avant cela, l'affectation
        // de currentTime n'est pas honorée par tous les navigateurs. Si la piste
        // ne charge pas, le drapeau doit retomber : sinon la remontée de position
        // resterait muette jusqu'au prochain morceau.
        if (audio.readyState >= 1) {
            apply();
        } else {
            audio.addEventListener('loadedmetadata', apply);
            audio.addEventListener('error', giveUp);
        }
    }

    /**
     * Coupe le son d'un élément en vue d'un fondu d'entrée.
     *
     * Séparé de l'armement de la rampe : le silence doit être immédiat — sinon
     * la piste démarre à plein volume — alors que la rampe, elle, attend que la
     * lecture soit réellement en cours à la bonne position.
     *
     * @param {HTMLAudioElement} audio
     */
    function prepareFadeIn(audio) {
        audio.volume = 0;
        audio.isMixFadingIn = true;
    }

    /**
     * Lance la montée du volume dès que la lecture est effective.
     *
     * @param {HTMLAudioElement} audio
     * @param {number} durationSecs
     */
    function armFadeIn(audio, durationSecs) {
        let started = false;

        const startFade = () => {
            if (started) return;
            started = true;
            clearTimeout(fallback);
            audio.removeEventListener('playing', startFade);

            const targetVol = (state.volume || 100) / 100;
            const durationMs = durationSecs * 1000;
            const steps = 30;
            const stepInterval = durationMs / steps;
            let currentStep = 0;

            const fadeInterval = setInterval(() => {
                currentStep++;
                if (currentStep >= steps) {
                    audio.volume = targetVol;
                    audio.isMixFadingIn = false;
                    clearInterval(fadeInterval);
                    return;
                }
                const progress = currentStep / steps;
                const curveFactor = Math.pow(progress, 2);
                audio.volume = targetVol * curveFactor;
            }, stepInterval);
        };

        // Filet de sécurité : si `playing` ne survient jamais — lecture
        // automatique refusée par le navigateur, flux en erreur — l'élément
        // resterait muet pour toujours, `isMixFadingIn` gelant au passage la
        // synchronisation du volume par le ducking client.
        const fallback = setTimeout(startFade, 5000);

        if (!audio.paused && audio.readyState >= 3) {
            startFade();
        } else {
            audio.addEventListener('playing', startFade);
        }
    }

    /**
     * Numéro du chargement en cours. Voir `streamUrlFor`.
     *
     * Il ne repart pas de zéro d'un morceau à l'autre : deux chargements
     * successifs de la *même* piste doivent avoir des adresses différentes, et
     * c'est précisément le cas d'une lecture en boucle.
     */
    let streamLoadCounter = 0;

    /**
     * Adresse du flux d'une piste, telle que la sert le bot.
     *
     * ## Pourquoi chaque appel rend une adresse différente
     *
     * Une piste peut être servie sous deux formes : le MP3 du cache de
     * préchargement, ou le fichier d'origine. Le cache apparaît quand le
     * préchargement se termine, disparaît quand il est évincé — deux évènements
     * qui tombent en pleine écoute.
     *
     * Or le navigateur ne retient pas un média par ce qu'il contient mais par
     * son adresse : les octets déjà téléchargés restent en cache sous cette
     * adresse, et le décodeur ouvert sur elle garde le format qu'il a reconnu au
     * premier octet. Redonner la même adresse à un morceau servi entretemps sous
     * l'autre forme mélange donc les deux dans un seul décodage. Le résultat ne
     * s'entend ni comme un silence ni comme une erreur : c'est du bruit blanc à
     * plein niveau, des octets compressés lus comme des échantillons bruts.
     *
     * C'est exactement ce qui se produisait sur une lecture en boucle : le
     * morceau repartait sur la même adresse, le préchargement s'étant terminé
     * pendant le premier passage.
     *
     * Un numéro de chargement rend donc chaque adresse unique. Le navigateur y
     * voit une ressource neuve — rien à mélanger —, et le serveur est libre d'y
     * servir la meilleure forme disponible, qu'il retient ensuite pour toutes
     * les tranches de ce chargement-là.
     *
     * @param {object} track
     * @param {number} [attempt=0] - Numéro de reprise, ajouté pour la lisibilité
     *   des journaux : l'unicité, elle, est déjà acquise.
     * @returns {string}
     */
    function streamUrlFor(track, attempt = 0) {
        const scheme = window.location.protocol === 'https:' ? 'https:' : 'http:';
        const base = `${scheme}//${window.location.host}/api/stream`
            + `?guildId=${state.guildId}&trackUrl=${encodeURIComponent(track.url)}`
            + `&load=${++streamLoadCounter}`;
        return attempt > 0 ? `${base}&retry=${attempt}` : base;
    }

    /** Nombre de rechargements tentés avant de renoncer et de le dire. */
    const MAX_AUDIO_RELOADS = 2;

    /** Délai avant une reprise : voir le commentaire dans reloadPersonalAudio. */
    const RELOAD_DELAY_MS = 400;

    /**
     * Recharge la piste en cours après un échec, à la position déjà atteinte.
     *
     * Un morceau qui ne se charge pas laissait le lecteur muet pour de bon : le
     * serveur, qui tient seul la progression en diffusion personnelle, continue
     * d'avancer, si bien que la barre défile sur du silence jusqu'à la piste
     * suivante. Une reprise coûte une seconde et sauve la plupart des cas —
     * coupure de flux, réponse tronquée, décodage refusé sur des octets
     * incomplets.
     *
     * Le compteur est porté par l'élément et remis à zéro à chaque piste
     * chargée : deux échecs de suite sur le même morceau signent autre chose
     * qu'un incident de transport, et il vaut mieux le dire que de s'acharner.
     *
     * @param {HTMLAudioElement} audio
     * @param {string} reason - Ce qui a motivé la reprise, pour le journal.
     * @returns {boolean} false si la reprise n'a pas lieu.
     */
    function reloadPersonalAudio(audio, reason) {
        if (!state.currentTrack || state.settings.broadcastMode !== 'personal') return false;
        if (audio !== activeAudio) return false;

        // Une reprise déjà engagée : la remise à zéro de l'élément fait
        // elle-même remonter des erreurs, et chacune relancerait une reprise.
        if (audio.reloadPending) return true;

        const attempt = (audio.reloadAttempts || 0) + 1;
        if (attempt > MAX_AUDIO_RELOADS) return false;
        audio.reloadAttempts = attempt;
        audio.reloadPending = true;

        // La position du serveur fait foi : celle de l'élément est retombée à
        // zéro avec l'échec du chargement.
        const positionSecs = ((state.progress && state.progress.currentMs) || 0) / 1000;

        sendWS({
            type: 'clientLog',
            data: {
                source: 'Audio',
                message: `REPRISE ${attempt}/${MAX_AUDIO_RELOADS} | « ${state.currentTrack.title || '—'} » `
                    + `| à ${positionSecs.toFixed(1)} s | ${reason}`
            }
        });

        const url = streamUrlFor(state.currentTrack, attempt);

        /*
         * La reprise est différée, et l'élément remis à zéro avant.
         *
         * Réécrire la source depuis l'écouteur d'erreur, dans l'instant, laissait
         * le lecteur dans un état dont il ne se relevait pas : il répondait
         * aussitôt `code 4 | networkState 3`, soit « aucune source exploitable »,
         * alors que la même adresse servie à la main rend le fichier entier. La
         * sélection de ressource du navigateur est encore en cours pendant cet
         * événement ; on la laisse se terminer, on vide l'élément, puis on lui
         * donne la nouvelle adresse.
         *
         * Le délai sert aussi à autre chose : ces échecs viennent d'une coupure
         * de transport, et redemander dans la milliseconde qui suit revient à
         * frapper à une porte qu'on vient de voir se fermer.
         */
        setTimeout(() => {
            audio.reloadPending = false;
            if (!state.currentTrack || audio.currentTrackUrl !== state.currentTrack.url) return;

            audio.removeAttribute('src');
            audio.load();

            audio.src = url;
            audio.load();
            applyInitialPosition(audio, positionSecs, () => {
                if (state.isPlaying && !state.isPaused) {
                    audio.play().catch(() => {});
                }
            });
        }, RELOAD_DELAY_MS);

        return true;
    }

    /* ── Préchargement du morceau suivant, dans le navigateur ──────────── */

    /**
     * Avance de tampon à partir de laquelle le morceau suivant peut commencer à
     * se charger, en secondes de lecture.
     *
     * Deux téléchargements de front se partagent la bande passante : tant que
     * le morceau en cours n'a pas de quoi tenir, elle lui revient tout entière.
     */
    const PRELOAD_AHEAD_SECS = 25;

    /**
     * Temps restant à partir duquel le morceau suivant se charge, quoi qu'il en
     * soit du tampon.
     *
     * Le critère de tampon ci-dessus ne suffit pas : WebKit met en mémoire avec
     * parcimonie, plus encore sur un réseau mobile, et l'avance de vingt-cinq
     * secondes peut n'être jamais atteinte. Le préchargement n'aurait alors
     * jamais lieu — précisément sur l'appareil qui en a le plus besoin.
     *
     * Cette seconde condition ne dépend d'aucune politique de navigateur : à une
     * minute de la fin, on charge la suite, un point c'est tout. Le morceau en
     * cours est de toute façon presque entièrement descendu à ce moment-là, la
     * bande passante ne lui manquera pas.
     */
    const PRELOAD_LEAD_SECS = 60;

    /**
     * Secondes de lecture déjà en mémoire tampon devant la tête de lecture.
     *
     * @param {HTMLAudioElement} audio
     * @returns {number} Infini quand le fichier est entièrement chargé.
     */
    function bufferedAheadSecs(audio) {
        if (!audio || audio.readyState >= 4) return Infinity;
        if (!audio.buffered || audio.buffered.length === 0) return 0;
        try {
            const end = audio.buffered.end(audio.buffered.length - 1);
            return Math.max(0, end - audio.currentTime);
        } catch (e) {
            return 0;
        }
    }

    /**
     * Le morceau en cours peut-il céder de la bande passante au suivant ?
     *
     * @param {HTMLAudioElement} audio
     * @returns {boolean}
     */
    function readyToPreload(audio) {
        if (!audio) return false;
        if (bufferedAheadSecs(audio) >= PRELOAD_AHEAD_SECS) return true;

        const duration = audio.duration;
        if (!duration || isNaN(duration) || duration <= 0) return false;
        return (duration - audio.currentTime) <= PRELOAD_LEAD_SECS;
    }

    /** L'élément qui ne porte pas la lecture, et peut donc servir de tampon. */
    function spareAudioElement() {
        return activeAudio === primaryAudio ? secondaryAudio : primaryAudio;
    }

    /** Rend l'élément de réserve à son état vide. */
    function releaseSpare(spare) {
        if (!spare || !spare.getAttribute('src')) return;
        try { spare.pause(); } catch (e) {}
        spare.removeAttribute('src');
        spare.load();
        spare.currentTrackUrl = null;
        spare.reloadAttempts = 0;
    }

    /**
     * Interrompt le préchargement en cours, la bande passante étant réclamée
     * ailleurs.
     *
     * Un déplacement dans la piste vide le tampon et oblige le navigateur à
     * redemander le fichier à la nouvelle position. Si le morceau suivant est en
     * train de descendre en même temps, les deux se partagent la ligne et le
     * saut met plusieurs secondes à se voir — sur un téléphone, c'est la
     * différence entre « instantané » et « il ne se passe rien ».
     *
     * Un fichier déjà entièrement chargé est conservé : il ne coûte plus rien.
     */
    function suspendPreload() {
        const spare = spareAudioElement();
        if (!spare || !spare.getAttribute('src')) return;
        if (spare.readyState >= 4) return;
        releaseSpare(spare);
    }

    /**
     * Charge le morceau suivant dans l'élément de réserve, pendant que l'autre
     * joue.
     *
     * Le bot précharge déjà de son côté, mais ce qu'il prépare reste sur son
     * disque : en diffusion personnelle, le son sort du navigateur, et c'est
     * donc le navigateur qui a besoin d'avoir la suite sous la main. Sans cela,
     * chaque changement de piste ouvre un téléchargement depuis zéro — une
     * trentaine de mégaoctets pour un fichier WAV — pendant que la position,
     * elle, avance déjà côté serveur. D'où des débuts de morceau muets, et des
     * coupures en cours de route sur une connexion mobile.
     *
     * L'élément de réserve est celui-là même que l'enchaînement mix emploie :
     * la lecture bascule de l'un à l'autre plutôt que de recharger toujours le
     * même, et le morceau qui commence est déjà en mémoire.
     */
    function preloadNextTrack() {
        if (!personalAudio || !state.settings || state.settings.broadcastMode !== 'personal') return;

        const spare = spareAudioElement();
        if (!spare) return;

        if (!state.currentTrack) {
            releaseSpare(spare);
            return;
        }

        // Pendant un enchaînement, l'élément de réserve joue déjà : il ne faut
        // pas lui retirer sa source sous les doigts.
        if (fadeAudio !== null || activeAudio.isMixFadingIn || mixAwaitingConfirmation !== null) return;

        const next = window.MusicPlayer.nextTrackOf(state);
        if (!next || !next.url) {
            releaseSpare(spare);
            return;
        }

        // Déjà en tampon : rien à faire, surtout pas relancer le téléchargement.
        if (spare.currentTrackUrl === next.url) return;

        // La file a changé : ce que la réserve tenait n'est plus le suivant.
        if (spare.currentTrackUrl) releaseSpare(spare);

        if (!readyToPreload(activeAudio)) return;

        spare.currentTrackUrl = next.url;
        spare.reloadAttempts = 0;
        spare.preload = 'auto';
        spare.muted = false;
        spare.src = streamUrlFor(next);
        spare.load();
    }

    /**
     * Fait passer la lecture sur l'élément de réserve, qui tient déjà le
     * morceau demandé.
     *
     * Rien n'est téléchargé : c'est tout l'intérêt. L'élément qui vient d'être
     * quitté est vidé et deviendra la réserve du morceau d'après.
     *
     * @param {number} resumePositionSecs - Position annoncée par le serveur.
     * @param {number} fadeDuration - Durée du fondu d'ouverture, 0 s'il n'a pas
     *   lieu d'être.
     * @returns {boolean} false si la réserve n'avait pas ce morceau.
     */
    function adoptPreloadedTrack(resumePositionSecs, fadeDuration) {
        const spare = spareAudioElement();
        if (!spare || !state.currentTrack) return false;
        if (spare.currentTrackUrl !== state.currentTrack.url) return false;
        // `HAVE_CURRENT_DATA` : de quoi commencer. En deçà, le chargement n'a
        // rien donné et le chemin ordinaire fera mieux.
        if (spare.readyState < 2) return false;

        const previous = activeAudio;

        spare.volume = previous.volume;
        spare.playbackRate = previous.playbackRate;
        spare.isMixFadingIn = false;
        spare.isMixFadingOut = false;

        activeAudio = spare;
        personalAudio = spare;
        window.MusicPlayer.activeAudio = spare;

        if (previous && previous !== spare) {
            previous.currentTrackUrl = null;
            releaseSpare(previous);
        }

        clientPositionWins = false;

        if (fadeDuration > 0) prepareFadeIn(spare);
        applyInitialPosition(spare, resumePositionSecs, () => {
            if (fadeDuration > 0) armFadeIn(spare, fadeDuration);
        });

        sendWS({
            type: 'clientLog',
            data: {
                source: 'Audio',
                message: `TAMPON | « ${state.currentTrack.title || '—'} » joué depuis la réserve, `
                    + 'sans téléchargement'
            }
        });

        return true;
    }

    function syncPersonalAudio() {
        if (!personalAudio) return;
        const isPersonal = state.settings.broadcastMode === 'personal';

        if (!isPersonal || !state.currentTrack) {
            mixTransitionNextTrack = null;
            mixTransition = null;
            mixAwaitingConfirmation = null;
            fadeAudio = null;
            [primaryAudio, secondaryAudio].forEach(audio => {
                if (audio && (audio.src || !audio.paused)) {
                    audio.pause();
                    audio.src = '';
                    audio.removeAttribute('src');
                    audio.load();
                    audio.currentTrackUrl = null;
                    audio.isMixFadingOut = false;
                    audio.isMixFadingIn = false;
                }
            });
            return;
        }

        const expectedSrc = streamUrlFor(state.currentTrack);

        // Le serveur a-t-il rattrapé la piste que le navigateur joue déjà ?
        // L'attente est bornée : une confirmation qui ne viendrait jamais
        // figerait la synchronisation pour le reste de la session.
        if (mixAwaitingConfirmation) {
            const confirmed = state.currentTrack.url === mixAwaitingConfirmation.url;
            const expired = Date.now() - mixWaitingSinceMs > MAX_CONFIRMATION_WAIT_MS;
            if (confirmed || expired) {
                if (!confirmed) {
                    console.warn('[Audio Mix] Server confirmation not received, resynchronising.');
                }
                mixAwaitingConfirmation = null;
                mixTransitionNextTrack = null;
            }
        }

        // Only load/synchronize the new track source if we are not in the middle of a mix transition
        const isMixTransitioning = (fadeAudio !== null || activeAudio.isMixFadingIn || mixAwaitingConfirmation !== null);
        const isNewTrack = personalAudio.currentTrackUrl !== state.currentTrack.url;
        const resumePositionSecs = ((state.progress && state.progress.currentMs) || 0) / 1000;

        // Fondu d'ouverture du Mix DJ, nul s'il n'a pas lieu d'être.
        // Voir MusicPlayer.dureeFonduOuverture.
        const mixFade = window.MusicPlayer.openingFadeMs(state, resumePositionSecs);

        // Fade-in de démarrage du bot mis en attente par le serveur : en diffusion
        // personnelle le son sort d'ici, il ne pouvait donc pas être joué avant que
        // cette page soit ouverte. On le consomme dès la première piste chargée.
        const startupFadein = (state.startupFadein && !startupFadeinPlayed)
            ? (parseFloat(state.startupFadein.durationMs) || 0) / 1000
            : 0;

        // Le morceau suivant déjà en réserve : la lecture bascule dessus sans
        // rien redemander au serveur. C'est ce que le préchargement prépare.
        if (!isMixTransitioning && isNewTrack
            && adoptPreloadedTrack(resumePositionSecs, startupFadein > 0 ? startupFadein : mixFade)) {
            mixTransitionNextTrack = null;
            mixTransition = null;
            if (startupFadein > 0) {
                startupFadeinPlayed = true;
                sendWS({ type: 'startupFadeinConsumed' });
            }
        } else if (!isMixTransitioning && isNewTrack) {
            mixTransitionNextTrack = null;
            mixTransition = null;
            personalAudio.currentTrackUrl = state.currentTrack.url;
            // Les reprises comptent par piste : celle-ci n'a pas encore échoué.
            personalAudio.reloadAttempts = 0;
            personalAudio.src = expectedSrc;
            personalAudio.load();

            // Piste rechargée depuis zéro : plus rien à faire valoir face au
            // serveur, c'est lui qui dit où reprendre.
            clientPositionWins = false;

            // Reset fading out flag
            personalAudio.isMixFadingOut = false;

            // Le fondu de démarrage du bot prime : il se rapporte au bot et non
            // à la piste, et s'applique donc où qu'elle reprenne.
            const fadeDuration = startupFadein > 0 ? startupFadein : mixFade;

            // Le volume tombe à zéro dès maintenant, mais la rampe n'est armée
            // qu'une fois la position restaurée appliquée : le repositionnement
            // met le flux en tampon, et une rampe lancée avant s'écoulerait
            // pendant ce silence — la piste entrerait alors à plein volume.
            if (fadeDuration > 0) prepareFadeIn(personalAudio);

            if (startupFadein > 0) {
                startupFadeinPlayed = true;
                sendWS({ type: 'startupFadeinConsumed' });
            }

            // Reprise à la position connue du serveur (redémarrage du bot, ou
            // simple réouverture du tableau de bord). Le recalage périodique plus
            // bas ne suffit pas : il est neutralisé pendant un fondu d'entrée,
            // exactement le cas d'un démarrage avec fade-in activé.
            const elementLoaded = personalAudio;
            applyInitialPosition(
                elementLoaded,
                resumePositionSecs,
                () => {
                    if (fadeDuration > 0) armFadeIn(elementLoaded, fadeDuration);
                }
            );
        } else if (startupFadein > 0 && !isMixTransitioning) {
            // La piste est déjà chargée : le tableau de bord était ouvert pendant
            // l'arrêt du bot. Sans ce cas, le fade-in resterait en attente et se
            // déclencherait au prochain changement de piste, longtemps après le
            // démarrage auquel il se rapporte.
            startupFadeinPlayed = true;
            sendWS({ type: 'startupFadeinConsumed' });
            prepareFadeIn(personalAudio);
            armFadeIn(personalAudio, startupFadein);
        }

        // Le morceau suivant se charge pendant que celui-ci joue.
        preloadNextTrack();

        // Volume (Ducking automatique inclus)
        clientDucking.update(state);

        // Vitesse
        const expectedSpeed = parseFloat(state.settings.playbackSpeed || '1.0');
        [primaryAudio, secondaryAudio].forEach(audio => {
            if (audio && audio.playbackRate !== expectedSpeed) {
                audio.playbackRate = expectedSpeed;
            }
        });

        // Play/Pause
        const shouldPlay = state.isPlaying && !state.isPaused;
        [primaryAudio, secondaryAudio].forEach(audio => {
            if (audio) {
                if (!shouldPlay && !audio.paused) {
                    audio.pause();
                } else if (shouldPlay && audio.paused && audio === activeAudio) {
                    audio.play().catch(err => {
                        console.warn('[Audio] Playback blocked or impossible to start:', err);
                        // `AbortError` ne signale pas un échec : la lecture
                        // demandée a été supplantée par le chargement de la
                        // piste suivante, ce qui arrive à chaque passage un peu
                        // vif d'un morceau à l'autre. Le journal du bot n'a rien
                        // à y gagner.
                        if (err && err.name === 'AbortError') return;

                        // Le remède tient dans un clic, et personne ne peut le
                        // deviner : ce refus-là se dit à l'écran.
                        if (err && err.name === 'NotAllowedError') {
                            announceBlockedPlayback();
                        }
                        // Le reste est remonté au serveur : cet avertissement ne
                        // partait que dans la console du navigateur, hors de
                        // portée depuis un téléphone — et c'est le seul indice
                        // qu'un morceau n'a pas démarré.
                        sendWS({
                            type: 'clientLog',
                            data: {
                                source: 'Audio',
                                message: `ECHEC LECTURE | « ${(state.currentTrack && state.currentTrack.title) || '—'} » `
                                    + `| ${(err && err.name) || '?'} : ${(err && err.message) || ''}`
                            }
                        });
                    });
                }
            }
        });

        // Recalage de position — jamais pendant un enchaînement ni tant que le
        // serveur n'a pas confirmé la piste entrante : sa progression est
        // encore celle du morceau précédent, s'y aligner ferait sauter la
        // lecture en cours.
        if (!isSeeking && state.progress && !isMixTransitioning
            && !activeAudio.isMixFadingIn && !activeAudio.isMixFadingOut) {
            const serverSecs = state.progress.currentMs / 1000;
            const clientSecs = personalAudio.currentTime;
            if (Math.abs(clientSecs - serverSecs) > 2) {
                if (clientPositionWins) {
                    // Reconnexion après une coupure du serveur : le navigateur n'a
                    // jamais cessé de jouer, sa position fait foi. Se recaler sur
                    // celle du serveur, figée pendant l'interruption, ferait sauter
                    // la lecture en arrière — c'est lui qu'on recale.
                    //
                    // Sauf si un autre tableau de bord pilote : sa position à lui
                    // fera foi, et la nôtre serait refusée. On ne recule pas pour
                    // autant — le serveur peut encore porter celle d'avant la
                    // coupure, le temps que le pilote se soit annoncé — et
                    // l'accord revenu lèvera la priorité, plus bas.
                    if (state.pilot !== false) {
                        sendWS({
                            type: 'syncProgress',
                            data: { progressMs: Math.round(clientSecs * 1000) }
                        });
                    }
                } else {
                    personalAudio.currentTime = serverSecs;
                    // Le saut vient d'un autre appareil : la ligne revient au
                    // morceau en cours, le suivant attendra.
                    suspendPreload();
                }
            } else {
                // Les deux horloges concordent : le serveur redevient la référence.
                clientPositionWins = false;
            }
        }
    }

    // --- Context Menu (History Actions) ---
    const contextMenu = document.getElementById('history-context-menu');
    const menuPlayNow = document.getElementById('menu-play-now');
    const menuAddQueue = document.getElementById('menu-add-queue');
    const menuDelete = document.getElementById('menu-delete');
    let selectedHistoryTrack = null;
    let selectedHistoryIndex = null;

    function showHistoryContextMenu(e, track, index) {
        selectedHistoryTrack = track;
        selectedHistoryIndex = index;
        contextMenu.style.left = `${e.clientX}px`;
        contextMenu.style.top = `${e.clientY}px`;
        contextMenu.classList.remove('hidden');
    }

    function hideHistoryContextMenu() {
        contextMenu.classList.add('hidden');
        selectedHistoryTrack = null;
        selectedHistoryIndex = null;
    }

    // Fermer le menu lors d'un clic extérieur ou scroll
    document.addEventListener('click', hideHistoryContextMenu);
    window.addEventListener('scroll', hideHistoryContextMenu);

    menuPlayNow.addEventListener('click', () => {
        if (selectedHistoryTrack) {
            sendWS({
                type: 'playNow',
                data: { url: selectedHistoryTrack.url }
            });
        }
    });

    menuAddQueue.addEventListener('click', () => {
        if (selectedHistoryTrack) {
            sendWS({
                type: 'play',
                data: { query: selectedHistoryTrack.url }
            });
        }
    });

    menuDelete.addEventListener('click', () => {
        if (selectedHistoryIndex !== null && selectedHistoryIndex !== undefined) {
            sendWS({
                type: 'removeFromHistory',
                data: { index: selectedHistoryIndex }
            });
        }
    });

    // --- Video Mode Setup ---
    setupFloatingVideoWindow();
    const toggleVideoMode = document.getElementById('toggle-video-mode');
    if (toggleVideoMode) {
        const savedVideoState = localStorage.getItem('dashboardVideoMode') === 'true';
        toggleVideoMode.checked = savedVideoState;
        toggleVideoMode.addEventListener('change', () => {
            localStorage.setItem('dashboardVideoMode', toggleVideoMode.checked);
            const displayedTrack = mixTransitionNextTrack || state.currentTrack;
            updateVideoPlayer(displayedTrack);
            if (toggleVideoMode.checked) {
                const curMs = (personalAudio && !isNaN(personalAudio.currentTime))
                    ? Math.round(personalAudio.currentTime * 1000)
                    : ((state.progress && state.progress.currentMs) || 0);
                syncVideoProgress(curMs, true);
                syncVideoPlayState(state.isPlaying, state.isPaused);
            }
        });
    }

    // Drag & Drop handlers are initialized via window.MusicPlayer.initCardsDragAndDrop() in js/queue.js

    // --- Layout Drag & Drop and Resize Persistence ---
    // (Délégué entièrement à js/layoutPersistence.js)

    // Gestion de la sauvegarde de la configuration par défaut (positions, tailles et curseurs)
    function getScrollableSelectors() {
        return [
            '#playlist-history-container',
            '#playlist-queue-container',
            '#playlist-tracks-container',
            '#guild-members-list',
            '#speakers-list-container',
            '.playlists-tabs'
        ];
    }

    function saveCurrentBoxScrollPositions() {
        const scrolls = {};
        getScrollableSelectors().forEach(sel => {
            const el = document.querySelector(sel);
            if (el) {
                scrolls[sel] = {
                    scrollTop: el.scrollTop,
                    scrollLeft: el.scrollLeft
                };
            }
        });
        return scrolls;
    }

    function restoreBoxScrollPositions() {
        const saved = localStorage.getItem('dashboardScrolls') || localStorage.getItem('dashboardDefaultScrolls');
        if (!saved) return;
        try {
            const scrolls = JSON.parse(saved);
            Object.keys(scrolls).forEach(sel => {
                const el = document.querySelector(sel);
                if (el) {
                    if (scrolls[sel].scrollTop !== undefined) el.scrollTop = scrolls[sel].scrollTop;
                    if (scrolls[sel].scrollLeft !== undefined) el.scrollLeft = scrolls[sel].scrollLeft;
                }
            });
        } catch (e) { }
    }

    function setupBoxScrollTrackers() {
        getScrollableSelectors().forEach(sel => {
            const el = document.querySelector(sel);
            if (el && !el._hasScrollTracker) {
                el._hasScrollTracker = true;
                el.addEventListener('scroll', throttle(() => {
                    const current = JSON.parse(localStorage.getItem('dashboardScrolls') || '{}');
                    current[sel] = { scrollTop: el.scrollTop, scrollLeft: el.scrollLeft };
                    localStorage.setItem('dashboardScrolls', JSON.stringify(current));
                }, 250), { passive: true });
            }
        });
    }

    if (btnSaveDefaultLayout) {
        btnSaveDefaultLayout.addEventListener('click', (e) => {
            e.preventDefault();

            // 1. Enregistrer la disposition actuelle comme disposition par défaut
            localStorage.setItem('dashboardDefaultLayout', JSON.stringify(window.MusicPlayer.cardLayouts));
            localStorage.setItem('dashboardLayout', JSON.stringify(window.MusicPlayer.cardLayouts));

            // 2. Enregistrer l'état de verrouillage des cartes comme verrouillage par défaut
            localStorage.setItem('dashboardDefaultLocked', JSON.stringify(window.MusicPlayer.lockedCards));

            // 3. Capturer et enregistrer la position des curseurs / scrollbars des boîtes comme défilement par défaut
            const scrolls = saveCurrentBoxScrollPositions();
            localStorage.setItem('dashboardDefaultScrolls', JSON.stringify(scrolls));
            localStorage.setItem('dashboardScrolls', JSON.stringify(scrolls));

            // Animation feedback visuel du bouton
            btnSaveDefaultLayout.classList.add('header-save-active');
            setTimeout(() => {
                btnSaveDefaultLayout.classList.remove('header-save-active');
            }, 800);

            showToast(t('toast_layout_saved_default'));
        });
    }

    // Initialisation des sélecteurs personnalisés
    customGuildSelect = new CustomSelect(guildSelect);
    customBroadcastSelect = new CustomSelect(broadcastModeSelect);
    window.MusicPlayer.customBroadcastSelect = customBroadcastSelect;
    if (playbackSourceSelect) {
        customSourceSelect = new CustomSelect(playbackSourceSelect);
        window.MusicPlayer.customSourceSelect = customSourceSelect;
    }
    window.MusicPlayer.initSpeedPad();
    if (typeof window.MusicPlayer.initPlaylists === 'function') {
        window.MusicPlayer.initPlaylists();
    }
    if (styleSelect) {
        new CustomSelect(styleSelect);
    }
    const settingVersionSelect = document.getElementById('setting-version-select');
    if (settingVersionSelect && !settingVersionSelect.dataset.customSelectInit) {
        settingVersionSelect.dataset.customSelectInit = 'true';
        new CustomSelect(settingVersionSelect);
    }
    // Après la construction du CustomSelect : c'est son déclencheur, et non le
    // <select> masqué, qui porte le clic déclenchant la recherche des versions.
    if (typeof window.MusicPlayer.initVersions === 'function') {
        window.MusicPlayer.initVersions();
    }
    const settingLanguageSelect = document.getElementById('setting-language-select');
    if (settingLanguageSelect && !settingLanguageSelect.dataset.customSelectInit) {
        settingLanguageSelect.dataset.customSelectInit = 'true';
        new CustomSelect(settingLanguageSelect);
    }
    const settingDeviceModeSelect = document.getElementById('setting-device-mode-select');
    if (settingDeviceModeSelect && !settingDeviceModeSelect.dataset.customSelectInit) {
        settingDeviceModeSelect.dataset.customSelectInit = 'true';
        new CustomSelect(settingDeviceModeSelect);
        window.MusicPlayer.initDeviceModeSetting(settingDeviceModeSelect);
    }
    const addTargetSelect = document.getElementById('add-target-select');
    if (addTargetSelect && !addTargetSelect.dataset.customSelectInit) {
        addTargetSelect.dataset.customSelectInit = 'true';
        new CustomSelect(addTargetSelect);

        /*
         * La destination choisie est retenue par le bot, comme les qualités
         * d'import qui la voisinent dans la même boîte : elle survit ainsi au
         * rechargement de la page comme au redémarrage du serveur, et suit
         * l'utilisateur d'un appareil à l'autre.
         *
         * L'écouteur est posé ici, et non avec les autres `change` du fichier,
         * parce que c'est ici que ce menu existe : `addTargetSelect` y est
         * déjà déclaré, et le sélecteur de mode d'appareil se branche de la
         * même façon deux lignes plus haut.
         */
        addTargetSelect.addEventListener('change', (e) => {
            window.MusicPlayer.sendWS({
                type: 'updateSettings',
                data: { addTarget: e.target.value }
            });
            updateFormatFieldVisibility();
        });
    }

    if (importFormatSelect && !importFormatSelect.dataset.customSelectInit) {
        importFormatSelect.dataset.customSelectInit = 'true';
        new CustomSelect(importFormatSelect);
    }

    // Au chargement : le balisage part replié, et la destination restaurée peut
    // demander l'inverse avant même le premier état du serveur.
    updateFormatFieldVisibility();
    const downloadFormatSelect = document.getElementById('download-format-select');
    if (downloadFormatSelect && !downloadFormatSelect.dataset.customSelectInit) {
        downloadFormatSelect.dataset.customSelectInit = 'true';
        new CustomSelect(downloadFormatSelect);
    }
    if (importAudioQualitySelect && !importAudioQualitySelect.dataset.customSelectInit) {
        importAudioQualitySelect.dataset.customSelectInit = 'true';
        customImportAudioSelect = new CustomSelect(importAudioQualitySelect);
    }
    if (importVideoQualitySelect && !importVideoQualitySelect.dataset.customSelectInit) {
        importVideoQualitySelect.dataset.customSelectInit = 'true';
        customImportVideoSelect = new CustomSelect(importVideoQualitySelect);
    }
    updateQualityApplicability();

    // Initialisation de la mise en page
    window.MusicPlayer.initLayoutPersistence();
    setupBoxScrollTrackers();
    setTimeout(restoreBoxScrollPositions, 100);

    // Application de la langue sauvegardée au chargement du dashboard
    if (dashboardSettings && dashboardSettings.language) {
        applyLanguage(dashboardSettings.language);
    }

    // Initialisation du système de tooltips personnalisés
    TooltipSystem.init();

    /*
     * Sources et formats de la boîte d'import.
     *
     * Fenêtre purement documentaire : son contenu est écrit dans index.html et
     * ne bouge pas, il n'y a donc rien à peindre à l'ouverture. Ne restent que
     * les trois façons d'en sortir — la croix, le voile, la touche Échap, cette
     * dernière étant prise en charge plus bas avec les autres fenêtres.
     */
    const importInfoModal = document.getElementById('import-info-modal');
    const btnImportInfo = document.getElementById('btn-import-info');
    const btnCloseImportInfo = document.getElementById('btn-close-import-info');

    if (btnImportInfo && importInfoModal) {
        btnImportInfo.addEventListener('click', (e) => {
            // Le titre de la carte porte le glisser-déposer : on arrête
            // l'événement avant qu'il n'y remonte, plutôt que de compter sur le
            // garde de layoutPersistence.js, qui n'écarte que « mousedown ».
            e.preventDefault();
            e.stopPropagation();
            importInfoModal.classList.remove('hidden');
        });
    }

    if (btnCloseImportInfo && importInfoModal) {
        btnCloseImportInfo.addEventListener('click', () => {
            importInfoModal.classList.add('hidden');
        });
    }

    if (importInfoModal) {
        importInfoModal.addEventListener('click', (e) => {
            if (e.target === importInfoModal) importInfoModal.classList.add('hidden');
        });
    }

    // Restart / Shutdown Bot Button Listener (Simple click)
    if (btnRestartBot) {
        const maintModal = document.getElementById('maintenance-modal');
        const btnMaintShutdown = document.getElementById('btn-maint-shutdown');
        const btnMaintRestart = document.getElementById('btn-maint-restart');
        const btnMaintCancel = document.getElementById('btn-maint-cancel');

        function triggerMaintenanceModal() {
            if (maintModal) {
                maintModal.classList.remove('hidden');
            }
        }

        if (btnMaintCancel) {
            btnMaintCancel.addEventListener('click', () => {
                if (maintModal) maintModal.classList.add('hidden');
            });
        }

        /*
         * Le clic à côté referme, comme pour les réglages et le partage.
         *
         * La cible doit être le voile lui-même : l'événement remonte depuis la
         * boîte, et se contenter de l'écouter refermerait la fenêtre au moindre
         * clic sur « Éteindre ». C'est la seule chose que ce test distingue —
         * ce qui a été cliqué, et non ce qui a reçu l'événement au bout de sa
         * course.
         *
         * Refermer ainsi une fenêtre qui propose deux gestes destructeurs n'a
         * rien d'imprudent : sortir sans rien choisir est précisément ce qu'on
         * veut rendre facile.
         */
        if (maintModal) {
            maintModal.addEventListener('click', (e) => {
                if (e.target === maintModal) maintModal.classList.add('hidden');
            });
        }

        /** Rampe d'extinction en cours, s'il y en a une. */
        let fadeOutTimer = null;

        function fadeOutPersonalAudio(durationMs = 5000) {
            isShuttingDown = true;
            if (!activeAudio || activeAudio.paused) return;

            // L'extinction déclenche deux appels : le clic local, puis l'annonce
            // `shutting_down` renvoyée par le serveur. Deux rampes concurrentes
            // partent de volumes relevés à des instants différents et écrivent
            // chacune à son rythme : le gain se met à osciller au lieu de
            // descendre, ce qui s'entend comme un crépitement.
            if (fadeOutTimer) return;

            const startVol = activeAudio.volume;
            // Un pas court évite le bruit de fermeture éclair d'un gain qui
            // descend par sauts audibles.
            const steps = Math.max(20, Math.round(durationMs / 25));
            const stepTime = durationMs / steps;
            let currentStep = 0;

            fadeOutTimer = setInterval(() => {
                currentStep++;
                const linearFactor = 1 - (currentStep / steps);
                const curveFactor = Math.pow(linearFactor, 2.5);
                activeAudio.volume = Math.max(0, startVol * curveFactor);
                if (currentStep >= steps) {
                    clearInterval(fadeOutTimer);
                    fadeOutTimer = null;
                    activeAudio.volume = 0;
                    activeAudio.pause();
                    if (clientDucking) {
                        clientDucking.currentVolume = -1;
                        clientDucking.lastBaseVolume = -1;
                    }
                }
            }, stepTime);
        }

        if (btnMaintRestart) {
            btnMaintRestart.addEventListener('click', () => {
                if (maintModal) maintModal.classList.add('hidden');
                if (restartOverlay) {
                    const h2 = restartOverlay.querySelector('h2');
                    const p = restartOverlay.querySelector('p');
                    const spinner = restartOverlay.querySelector('.spinner');
                    if (h2) h2.textContent = t('overlay_restarting_title');
                    if (p) p.textContent = t('overlay_restart_sync_desc');
                    if (spinner) spinner.classList.remove('hidden');
                    restartOverlay.classList.remove('hidden');
                }
                sendWS({ type: 'restartBot' });
            });
        }

        if (btnMaintShutdown) {
            btnMaintShutdown.addEventListener('click', () => {
                if (maintModal) maintModal.classList.add('hidden');
                const isFadeoutEnabled = dashboardSettings.fadeoutEnabled !== undefined ? !!dashboardSettings.fadeoutEnabled : true;
                const durationSecs = dashboardSettings.fadeoutDuration !== undefined ? parseFloat(dashboardSettings.fadeoutDuration) : 5;
                const fadeDurationMs = isFadeoutEnabled ? Math.round(durationSecs * 1000) : 0;

                if (fadeDurationMs > 0) {
                    fadeOutPersonalAudio(fadeDurationMs);
                }

                if (restartOverlay) {
                    const h2 = restartOverlay.querySelector('h2');
                    const p = restartOverlay.querySelector('p');
                    const spinner = restartOverlay.querySelector('.spinner');
                    if (isFadeoutEnabled && fadeDurationMs > 0) {
                        if (h2) h2.textContent = t('overlay_shutdown_fadeout_title').replace(/5s/g, `${durationSecs}s`);
                        if (p) p.textContent = t('overlay_shutdown_fadeout_desc').replace(/5s/g, `${durationSecs}s`);
                    } else {
                        if (h2) h2.textContent = t('overlay_shutdown_title');
                        if (p) p.textContent = t('overlay_shutdown_desc');
                    }
                    if (spinner) spinner.classList.add('hidden');
                    restartOverlay.classList.remove('hidden');
                }
                sendWS({ type: 'shutdownBot' });
            });
        }

        // Un simple clic ouvre les options de maintenance
        btnRestartBot.addEventListener('click', (e) => {
            e.preventDefault();
            if (!btnRestartBot.disabled) {
                triggerMaintenanceModal();
            }
        });
    }

    function triggerCardsBounce(actionType) {
        if (!dashboardSettings.bounce || !dashboardSettings.bounce[actionType]) return;
        const cards = document.querySelectorAll('.card');
        cards.forEach(card => {
            card.classList.remove('card-bounce');
            void card.offsetWidth; // Force reflow
            card.classList.add('card-bounce');
        });
        setTimeout(() => {
            cards.forEach(card => card.classList.remove('card-bounce'));
        }, 500);
    }

    function initSettingsModal() {
        if (typeof window.MusicPlayer.initSettingsModal === 'function') {
            window.MusicPlayer.initSettingsModal();
        }
    }

    initSettingsModal();
    setTimeout(() => triggerCardsBounce('load'), 300);

    function updatePlaylistsUI() {
        if (typeof window.MusicPlayer.updatePlaylistsUI === 'function') {
            window.MusicPlayer.updatePlaylistsUI();
        }
    }

    if (playbackSourceSelect) {
        playbackSourceSelect.addEventListener('change', (e) => {
            const val = e.target.value;
            sendWS({
                type: 'setActivePlaybackSource',
                data: { source: val }
            });
        });
    }

    // Reconnexion/Synchronisation immédiate lors du retour sur l'onglet
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            console.log('[WebSocket] Tab became visible. Checking the connection...');

            // Le navigateur gèle la boucle d'animation et la décode vidéo d'un
            // onglet masqué, alors que la lecture se poursuit côté serveur : la
            // vidéo revient donc en retard, parfois de plusieurs minutes.
            // Le recalage franc s'appliquera sur la position fraîche.
            if (typeof window.MusicPlayer.requestVideoResync === 'function') {
                window.MusicPlayer.requestVideoResync();
            }
            startProgressLoop();

            const ws = window.MusicPlayer.socket;
            if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
                console.log('[WebSocket] Disconnected. Reconnecting right away...');
                connectWebSocket();
            } else if (ws.readyState === WebSocket.OPEN) {
                console.log('[WebSocket] Connected. Requesting a state sync...');
                sendWS({ type: 'requestState' });
            }
        }
    });

    // Global ESC Key Listener (Close settings, maintenance, playlist, and server delete modals)
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' || e.keyCode === 27) {
            // Les deux lecteurs — la documentation et le journal des
            // modifications — sont les fenêtres les plus hautes : ils prennent
            // la touche avant tout le reste, et la laissent aux autres quand ils
            // ne sont pas ouverts. Ils s'ouvrent tous deux depuis les
            // paramètres, qui sont dessous : ils ne peuvent pas se superposer,
            // et l'ordre entre eux n'a donc pas de conséquence.
            if (typeof window.MusicPlayer.closeDocsModal === 'function') {
                if (window.MusicPlayer.closeDocsModal()) return;
            }

            if (typeof window.MusicPlayer.closeChangelogModal === 'function') {
                if (window.MusicPlayer.closeChangelogModal()) return;
            }

            // Les pop-ups des versions se ferment par leur propre fonction :
            // elle doit remettre le menu déroulant sur la version réellement
            // exécutée, et refuser de disparaître pendant une bascule engagée —
            // la masquer n'annulerait rien, cela ne ferait que dérober
            // l'avancement. Ils se superposent aux paramètres : quand l'un
            // d'eux prend la touche, la fenêtre du dessous reste ouverte.
            if (typeof window.MusicPlayer.closeVersionModal === 'function') {
                if (window.MusicPlayer.closeVersionModal()) return;
            }

            /*
             * De la plus haute à la plus basse, et on s'arrête à la première
             * refermée.
             *
             * La boucle les fermait toutes d'un coup. Le cas se rencontre : la
             * confirmation de retrait d'un serveur se superpose aux paramètres,
             * et Échap emportait les deux — on renonçait à retirer un serveur
             * et on perdait au passage le panneau qu'on n'avait pas demandé à
             * quitter. Le lecteur de documentation et les fenêtres de version,
             * traités juste au-dessus, appliquent déjà cette règle ; celles-ci
             * y échappaient.
             *
             * D'où l'ordre : les paramètres en dernier, puisque c'est la seule
             * qui puisse en porter une autre.
             *
             * Le partage du contrôle, lui, manquait simplement à la liste. Il
             * se refermait au clic à côté comme ses voisines, mais restait
             * sourd à la touche.
             */
            const modalsToClose = [
                'server-confirm-delete-modal',
                'maintenance-modal',
                'playlist-create-modal',
                'import-info-modal',
                'download-dir-modal',
                'share-modal',
                'settings-modal'
            ];
            for (const id of modalsToClose) {
                const modal = document.getElementById(id);
                if (!modal || modal.classList.contains('hidden')) continue;

                // La création de playlist a sa propre fermeture, qui vide aussi
                // le champ de saisie. La masquer d'ici laisserait le nom
                // abandonné réapparaître à la réouverture.
                if (id === 'playlist-create-modal'
                    && typeof window.MusicPlayer.closePlaylistCreateModal === 'function') {
                    window.MusicPlayer.closePlaylistCreateModal();
                } else {
                    modal.classList.add('hidden');
                    if (id === 'settings-modal') {
                        localStorage.setItem('music_player_settings_open', 'false');
                    }
                }
                break;
            }
        }
    });

    // Start WebSocket
    connectWebSocket();
})();

