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
    let signatureServeurs = '';

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
    let mixEnAttenteConfirmation = null;
    let mixAttenteDepuisMs = 0;
    /** Au-delà, l'attente est abandonnée : mieux vaut resynchroniser que se figer. */
    const ATTENTE_CONFIRMATION_MAX_MS = 5000;

    /**
     * Enchaînement mix en cours côté serveur, en diffusion commune.
     *
     * Le son sort alors du bot et non du navigateur : les deux morceaux qui se
     * superposent n'existent ici que par ce que le serveur en rapporte. La date
     * de réception accompagne les positions, pour pouvoir les prolonger entre
     * deux messages.
     *
     * @type {{sortante: object|null, entrante: object, recuLe: number}|null}
     */
    let transitionServeur = null;

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
    window.MusicPlayer.etatTransitionMix = function() {
        const entrante = mixTransition ? mixTransition.entrante : mixEnAttenteConfirmation;
        if (entrante) {
            const progression = (part) => {
                const el = part.element;
                const duree = el ? el.duration : NaN;
                const ratio = (el && !isNaN(duree) && duree > 0)
                    ? Math.min(1, Math.max(0, el.currentTime / duree))
                    : 0;
                return { url: part.url, ratio };
            };

            return {
                sortante: mixTransition ? progression(mixTransition.sortante) : null,
                entrante: progression(entrante)
            };
        }

        return etatTransitionServeur();
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
    function etatTransitionServeur() {
        if (!transitionServeur) return null;

        const speed = parseFloat((state.settings && state.settings.playbackSpeed) || '1.0');
        const ecouleMs = (performance.now() - transitionServeur.recuLe) * speed;

        const progression = (part) => {
            if (!part) return null;
            const position = part.positionMs + ecouleMs;
            const ratio = part.dureeMs > 0 ? Math.min(1, Math.max(0, position / part.dureeMs)) : 0;
            return { url: part.url, ratio };
        };

        return {
            sortante: progression(transitionServeur.sortante),
            entrante: progression(transitionServeur.entrante)
        };
    }
    /**
     * Le fade-in de démarrage du bot n'est joué qu'une fois par session de page.
     * Le serveur le laisse en attente jusqu'à ce qu'un tableau de bord s'ouvre —
     * en diffusion personnelle le son sort d'ici, pas du bot — et cet indicateur
     * évite de le rejouer sur les diffusions d'état qui suivent, avant que le
     * serveur n'ait pris acte de sa consommation.
     */
    let startupFadeinJoue = false;
    /**
     * Le navigateur fait-il autorité sur la position de lecture ?
     *
     * Vrai après une reconnexion alors que la lecture n'a pas été interrompue :
     * le serveur reprend alors une position antérieure à la coupure, et c'est
     * lui qu'il faut recaler, pas l'inverse. Retombe dès que les deux horloges
     * concordent ou qu'une nouvelle piste est chargée.
     */
    let positionClientPrioritaire = false;
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

    function renderSmoothProgress() {
        if (!isSeeking && !(window.MusicPlayer && window.MusicPlayer.isVideoUserInteracting)) {
            const isPersonal = state.settings && state.settings.broadcastMode === 'personal';
            const speed = parseFloat((state.settings && state.settings.playbackSpeed) || window.MusicPlayer.currentSpeed || '1.0');

            if (isPersonal && personalAudio && !isNaN(personalAudio.duration) && personalAudio.duration > 0 && !personalAudio.paused) {
                const currentSecs = personalAudio.currentTime;
                const totalSecs = personalAudio.duration;
                const ratio = Math.min(1, Math.max(0, currentSecs / totalSecs));
                if (progressBar) {
                    progressBar.style.transform = `scaleX(${ratio})`;
                    window.MusicPlayer.currentProgressRatio = ratio;
                }

                const formattedCurrent = formatMs(Math.round((currentSecs * 1000) / speed));
                if (timeCurrent && timeCurrent.textContent !== formattedCurrent) {
                    timeCurrent.textContent = formattedCurrent;
                }
                const formattedTotal = formatMs(Math.round((totalSecs * 1000) / speed));
                if (timeTotal && timeTotal.textContent !== formattedTotal) {
                    timeTotal.textContent = formattedTotal;
                }
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
                const formattedTotal = formatMs(Math.round(baseTotalMs / speed));
                if (timeTotal && timeTotal.textContent !== formattedTotal) {
                    timeTotal.textContent = formattedTotal;
                }
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
                if (timeTotal && timeTotal.textContent !== '0:00') timeTotal.textContent = '0:00';
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
    function boucleProgression() {
        renderSmoothProgress();
        if (isTrackPlaying || (personalAudio && !personalAudio.paused)) {
            animFrameId = requestAnimationFrame(boucleProgression);
        } else {
            animFrameId = null;
        }
    }

    function startProgressLoop() {
        if (!animFrameId) {
            animFrameId = requestAnimationFrame(boucleProgression);
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
        const fond = getComputedStyle(document.documentElement)
            .getPropertyValue('--bg-main')
            .trim();
        if (fond) meta.setAttribute('content', fond);
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
                    positionClientPrioritaire = true;
                    window.MusicPlayer.sendWS({
                        type: 'syncProgress',
                        data: { progressMs: Math.round(personalAudio.currentTime * 1000) }
                    });
                }

                // Le préchargement est piloté par le serveur mais réglé ici :
                // après un redémarrage du bot, il repartirait sur ses valeurs
                // par défaut tant que l'utilisateur n'a pas touché un curseur.
                const preloading = window.MusicPlayer.dashboardSettings?.preloading;
                if (preloading) {
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
            state.attenteAuditeur = data.attenteAuditeur || null;
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
    window.MusicPlayer.rafraichirInterface = function() {
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
            const serveursAffiches = window.MusicPlayer.serveursVisibles(state.guilds);

            const channelStructure = serveursAffiches.map(g => {
                return `${g.id}:${g.defaultVoiceChannelId || 'none'}[${(g.voiceChannels || []).map(c => c.id).join(',')}]`;
            }).join('|');

            const needsRebuild = guildSelect._lastChannelStructure !== channelStructure;

            if (needsRebuild) {
                guildSelect._lastChannelStructure = channelStructure;
                const prevValue = guildSelect.value;
                guildSelect.innerHTML = '';

                if (serveursAffiches.length > 0) {
                    serveursAffiches.forEach(g => {
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
                serveursAffiches.forEach(g => {
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
        const empreinte = (state.guilds || []).map(g => `${g.id}:${g.name}`).join('|');
        if (empreinte !== signatureServeurs) {
            signatureServeurs = empreinte;
            const modalReglages = document.getElementById('settings-modal');
            if (modalReglages && !modalReglages.classList.contains('hidden')
                && typeof window.MusicPlayer.renderConnectedGuildsList === 'function') {
                window.MusicPlayer.renderConnectedGuildsList();
            }
        }

        // Enchaînement mené par le bus de mixage : on retient les positions et
        // l'instant où elles ont été relevées, de quoi les prolonger jusqu'au
        // message suivant.
        transitionServeur = state.mixTransition
            ? { ...state.mixTransition, recuLe: performance.now() }
            : null;

        // --- Now Playing, disque, boutons médias, préc/suivant, mode, volume, broadcast select ---
        // (Délégué à js/player.js)
        //
        // Pendant un fondu, c'est le morceau entrant qui est annoncé, dans les
        // deux modes de diffusion : il est déjà audible, et la file du serveur
        // ne le déclarera courant qu'au terme de la superposition.
        const displayedTrack = mixTransitionNextTrack
            || (transitionServeur && transitionServeur.entrante.track)
            || state.currentTrack;
        window.MusicPlayer.updatePlayerCard(displayedTrack);

        // Progress & Time (interpolation 60 FPS fluide sans saccades)
        if (transitionServeur) {
            baseProgressMs = transitionServeur.entrante.positionMs || 0;
            baseTotalMs = transitionServeur.entrante.dureeMs || 0;
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
            && !state.attenteAuditeur);

        renderSmoothProgress();
        if (isTrackPlaying || (personalAudio && !personalAudio.paused)) {
            startProgressLoop();
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
            const secondes = state.settings.presenceDepartureDelay;
            const curseur = document.getElementById('setting-departure-delay');
            const affichage = document.getElementById('val-setting-departure-delay');
            if (curseur && document.activeElement !== curseur) {
                curseur.value = secondes;
                if (affichage) affichage.textContent = `${secondes}s`;
            }
            const reglages = window.MusicPlayer.dashboardSettings;
            if (reglages) reglages.presenceDepartureDelay = secondes;
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

    // Media Controls
    function togglePlayPause() {
        const now = Date.now();
        if (now - lastPlayPauseClickTime < 350) {
            console.log('[PlayPause Debug] togglePlayPause ignoré (clic trop rapide < 350ms)');
            return;
        }
        lastPlayPauseClickTime = now;

        console.log('[PlayPause Debug] togglePlayPause declenché', {
            hasCurrentTrack: !!state.currentTrack,
            trackTitle: state.currentTrack ? state.currentTrack.title : null,
            currentIsPlaying: state.isPlaying,
            currentIsPaused: state.isPaused,
            broadcastMode: state.settings ? state.settings.broadcastMode : null
        });

        if (!state.currentTrack) {
            console.warn('[PlayPause Debug] Toggle ignored: no currentTrack in state.');
            showToast(t('tooltip_no_track_playing') || 'Aucune musique en cours');
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
            } else {
                // Default: 'queue' (Vers la file d'attente)
                sendWS({
                    type: 'play',
                    data: { query }
                });
            }
            searchInput.value = '';
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

    /**
     * Reconnaît une source locale : chemin Windows (C:\…), chemin POSIX (/…),
     * ou protocole file://. Tout le reste — URL http(s) ou simple recherche —
     * sera récupéré à distance, donc transcodé.
     */
    function estSourceLocale(valeur) {
        const v = (valeur || '').trim().replace(/^["']|["']$/g, '');
        if (!v) return false;
        if (/^https?:\/\//i.test(v)) return false;
        return /^[a-zA-Z]:[\\/]/.test(v) || v.startsWith('\\\\') || v.startsWith('/') || /^file:\/\//i.test(v);
    }

    /** Grise les sélecteurs quand la saisie désigne un fichier local. */
    function majApplicabiliteQualite() {
        if (!importQualityRow) return;
        const local = estSourceLocale(searchInput ? searchInput.value : '');
        importQualityRow.classList.toggle('not-applicable', local);
        if (importQualityHint) {
            importQualityHint.classList.toggle('highlighted', local);
            importQualityHint.textContent = local
                ? t('import_quality_local_notice')
                : t('import_quality_hint');
        }
    }

    if (searchInput) {
        searchInput.addEventListener('input', majApplicabiliteQualite);
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

            // Le serveur prend cette valeur pour argent comptant. Tant que la
            // position restaurée n'a pas été appliquée à l'élément, la remonter
            // reviendrait à lui annoncer un retour au début de la piste.
            const now = Date.now();
            if (!audio.positionInitialeEnAttente && now - lastSyncTime >= 1000) {
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
            if (mixTransitionNextTrack && !isSeeking && !isNaN(audio.duration) && audio.duration > 0) {
                const currentSecs = audio.currentTime;
                const totalSecs = audio.duration;
                const ratio = Math.min(1, Math.max(0, currentSecs / totalSecs));
                if (progressBar) {
                    progressBar.style.transform = `scaleX(${ratio})`;
                    window.MusicPlayer.currentProgressRatio = ratio;
                }
                const speed = parseFloat(state.settings.playbackSpeed || window.MusicPlayer.currentSpeed || '1.0');
                timeCurrent.textContent = formatMs(Math.round((currentSecs * 1000) / speed));
                timeTotal.textContent = formatMs(Math.round((totalSecs * 1000) / speed));
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
            if (state.pilote === false) {
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

                console.log(`[Audio Mix] Démarrage fade-out client de ${mixDuration}s...`);
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
                const nextTrack = window.MusicPlayer.pisteSuivante(state);
                if (nextTrack) {
                    const nextUrl = `${window.location.protocol === 'https:' ? 'https:' : 'http:'}//${window.location.host}/api/stream?guildId=${state.guildId}&trackUrl=${encodeURIComponent(nextTrack.url)}`;
                    nextAudio.currentTrackUrl = nextTrack.url;
                    nextAudio.src = nextUrl;
                    nextAudio.load();
                    nextAudio.volume = 0;
                    nextAudio.isMixFadingIn = true;
                    nextAudio.isMixFadingOut = false;

                    nextAudio.play().then(() => {
                        sendWS({
                            type: 'clientLog',
                            data: { source: 'Mix', message: `LECTURE fondu #${fadeId} | l'entrant joue` }
                        });
                    }).catch(err => {
                        console.warn('[Audio Mix] Impossible de lire le morceau suivant :', err);
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
                        sortante: {
                            url: fadeAudio.currentTrackUrl || (state.currentTrack && state.currentTrack.url) || null,
                            element: fadeAudio
                        },
                        entrante: { url: nextTrack.url, element: nextAudio }
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
                            mixEnAttenteConfirmation = { url: nextTrack.url, element: nextAudio };
                            mixAttenteDepuisMs = Date.now();

                            console.log('[Audio Mix] Transition complétée, envoi skip.');
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

                            console.log('[Audio Mix] Aucun morceau suivant. skip.');
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
            if (audio.deverrouillageEnCours) return;

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
                        + `| saut ${(state.settings.broadcastMode === 'personal' && audio === activeAudio) ? 'ENVOYE' : 'ecarte'}`
                }
            });
            // Seul le pilote annonce les fins de piste — voir le déclenchement du
            // fondu plus haut, et l'élection côté serveur.
            if (state.settings.broadcastMode === 'personal' && audio === activeAudio && state.pilote !== false) {
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
     * Autorise la lecture des deux éléments audio dès le premier geste.
     *
     * Les navigateurs mobiles refusent `play()` sur un élément qu'aucune action
     * de l'utilisateur n'a jamais déclenché. Le second élément n'entre en jeu
     * qu'au premier fondu enchaîné, longtemps après l'appui sur « lecture » :
     * sa mise en route était alors rejetée — `NotAllowedError` — et
     * l'enchaînement se déroulait sur du silence, l'erreur ne partant que dans
     * la console du navigateur.
     *
     * Un fragment silencieux, joué puis retiré à l'intérieur du geste, suffit à
     * lever la restriction pour toute la session. L'élément déjà pourvu d'une
     * source n'est pas touché : il joue, donc il est déjà autorisé.
     */
    const SILENCE_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=';
    let audioDeverrouille = false;

    function deverrouillerAudio() {
        if (audioDeverrouille) return;
        audioDeverrouille = true;

        [primaryAudio, secondaryAudio].forEach((el) => {
            if (!el || el.src) return;
            el.deverrouillageEnCours = true;
            el.muted = true;
            el.src = SILENCE_WAV;
            const promesse = el.play();
            const nettoyer = () => {
                try { el.pause(); } catch (e) {}
                el.removeAttribute('src');
                el.load();
                el.muted = false;
                el.deverrouillageEnCours = false;
            };
            if (promesse && typeof promesse.then === 'function') {
                promesse.then(nettoyer).catch(() => {
                    nettoyer();
                    sendWS({
                        type: 'clientLog',
                        data: { source: 'Mix', message: 'DEVERROUILLAGE refuse pour un element audio' }
                    });
                });
            } else {
                nettoyer();
            }
        });
    }

    ['pointerdown', 'touchstart', 'keydown'].forEach((evt) => {
        document.addEventListener(evt, deverrouillerAudio, { once: true, capture: true });
    });

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
     * @param {() => void} [quandPret] Appelé une fois la position posée — ou
     *   tout de suite s'il n'y a rien à rattraper, ou en cas d'échec du
     *   chargement, afin qu'aucun traitement en attente ne reste bloqué.
     */
    function appliquerPositionInitiale(audio, secondes, quandPret) {
        const signaler = () => {
            if (typeof quandPret === 'function') quandPret();
        };

        // En deçà d'une seconde, rien à rattraper : la piste commence à son début.
        if (!(secondes > 1)) {
            audio.positionInitialeEnAttente = false;
            signaler();
            return;
        }

        audio.positionInitialeEnAttente = true;

        const abandonner = () => {
            audio.removeEventListener('loadedmetadata', appliquer);
            audio.removeEventListener('error', abandonner);
            audio.positionInitialeEnAttente = false;
            signaler();
        };

        const appliquer = () => {
            audio.removeEventListener('error', abandonner);
            audio.removeEventListener('loadedmetadata', appliquer);
            try {
                audio.currentTime = secondes;
            } catch (e) {
                console.warn('[Audio] Repositionnement impossible :', e);
            }
            audio.positionInitialeEnAttente = false;
            signaler();
        };

        // `loadedmetadata` garantit une durée connue ; avant cela, l'affectation
        // de currentTime n'est pas honorée par tous les navigateurs. Si la piste
        // ne charge pas, le drapeau doit retomber : sinon la remontée de position
        // resterait muette jusqu'au prochain morceau.
        if (audio.readyState >= 1) {
            appliquer();
        } else {
            audio.addEventListener('loadedmetadata', appliquer);
            audio.addEventListener('error', abandonner);
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
    function preparerFonduEntree(audio) {
        audio.volume = 0;
        audio.isMixFadingIn = true;
    }

    /**
     * Lance la montée du volume dès que la lecture est effective.
     *
     * @param {HTMLAudioElement} audio
     * @param {number} durationSecs
     */
    function armerFonduEntree(audio, durationSecs) {
        let demarree = false;

        const startFade = () => {
            if (demarree) return;
            demarree = true;
            clearTimeout(secours);
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
        const secours = setTimeout(startFade, 5000);

        if (!audio.paused && audio.readyState >= 3) {
            startFade();
        } else {
            audio.addEventListener('playing', startFade);
        }
    }

    function syncPersonalAudio() {
        if (!personalAudio) return;
        const isPersonal = state.settings.broadcastMode === 'personal';

        if (!isPersonal || !state.currentTrack) {
            mixTransitionNextTrack = null;
            mixTransition = null;
            mixEnAttenteConfirmation = null;
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

        const expectedSrc = `${window.location.protocol === 'https:' ? 'https:' : 'http:'}//${window.location.host}/api/stream?guildId=${state.guildId}&trackUrl=${encodeURIComponent(state.currentTrack.url)}`;

        // Le serveur a-t-il rattrapé la piste que le navigateur joue déjà ?
        // L'attente est bornée : une confirmation qui ne viendrait jamais
        // figerait la synchronisation pour le reste de la session.
        if (mixEnAttenteConfirmation) {
            const confirmee = state.currentTrack.url === mixEnAttenteConfirmation.url;
            const expiree = Date.now() - mixAttenteDepuisMs > ATTENTE_CONFIRMATION_MAX_MS;
            if (confirmee || expiree) {
                if (!confirmee) {
                    console.warn('[Audio Mix] Confirmation du serveur non reçue, resynchronisation.');
                }
                mixEnAttenteConfirmation = null;
                mixTransitionNextTrack = null;
            }
        }

        // Only load/synchronize the new track source if we are not in the middle of a mix transition
        const isMixTransitioning = (fadeAudio !== null || activeAudio.isMixFadingIn || mixEnAttenteConfirmation !== null);
        const isNewTrack = personalAudio.currentTrackUrl !== state.currentTrack.url;
        const positionRepriseSecs = ((state.progress && state.progress.currentMs) || 0) / 1000;

        // Fondu d'ouverture du Mix DJ, nul s'il n'a pas lieu d'être.
        // Voir MusicPlayer.dureeFonduOuverture.
        const fonduMix = window.MusicPlayer.dureeFonduOuverture(state, positionRepriseSecs);

        // Fade-in de démarrage du bot mis en attente par le serveur : en diffusion
        // personnelle le son sort d'ici, il ne pouvait donc pas être joué avant que
        // cette page soit ouverte. On le consomme dès la première piste chargée.
        const fadeinDemarrage = (state.startupFadein && !startupFadeinJoue)
            ? (parseFloat(state.startupFadein.durationMs) || 0) / 1000
            : 0;

        if (!isMixTransitioning && isNewTrack) {
            mixTransitionNextTrack = null;
            mixTransition = null;
            personalAudio.currentTrackUrl = state.currentTrack.url;
            personalAudio.src = expectedSrc;
            personalAudio.load();

            // Piste rechargée depuis zéro : plus rien à faire valoir face au
            // serveur, c'est lui qui dit où reprendre.
            positionClientPrioritaire = false;

            // Reset fading out flag
            personalAudio.isMixFadingOut = false;

            // Le fondu de démarrage du bot prime : il se rapporte au bot et non
            // à la piste, et s'applique donc où qu'elle reprenne.
            const dureeFondu = fadeinDemarrage > 0 ? fadeinDemarrage : fonduMix;

            // Le volume tombe à zéro dès maintenant, mais la rampe n'est armée
            // qu'une fois la position restaurée appliquée : le repositionnement
            // met le flux en tampon, et une rampe lancée avant s'écoulerait
            // pendant ce silence — la piste entrerait alors à plein volume.
            if (dureeFondu > 0) preparerFonduEntree(personalAudio);

            if (fadeinDemarrage > 0) {
                startupFadeinJoue = true;
                sendWS({ type: 'startupFadeinConsumed' });
            }

            // Reprise à la position connue du serveur (redémarrage du bot, ou
            // simple réouverture du tableau de bord). Le recalage périodique plus
            // bas ne suffit pas : il est neutralisé pendant un fondu d'entrée,
            // exactement le cas d'un démarrage avec fade-in activé.
            const elementCharge = personalAudio;
            appliquerPositionInitiale(
                elementCharge,
                positionRepriseSecs,
                () => {
                    if (dureeFondu > 0) armerFonduEntree(elementCharge, dureeFondu);
                }
            );
        } else if (fadeinDemarrage > 0 && !isMixTransitioning) {
            // La piste est déjà chargée : le tableau de bord était ouvert pendant
            // l'arrêt du bot. Sans ce cas, le fade-in resterait en attente et se
            // déclencherait au prochain changement de piste, longtemps après le
            // démarrage auquel il se rapporte.
            startupFadeinJoue = true;
            sendWS({ type: 'startupFadeinConsumed' });
            preparerFonduEntree(personalAudio);
            armerFonduEntree(personalAudio, fadeinDemarrage);
        }

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
                        console.warn('[Audio] Lecture bloquée ou impossible à démarrer :', err);
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
                if (positionClientPrioritaire) {
                    // Reconnexion après une coupure du serveur : le navigateur n'a
                    // jamais cessé de jouer, sa position fait foi. Se recaler sur
                    // celle du serveur, figée pendant l'interruption, ferait sauter
                    // la lecture en arrière — c'est lui qu'on recale.
                    sendWS({
                        type: 'syncProgress',
                        data: { progressMs: Math.round(clientSecs * 1000) }
                    });
                } else {
                    personalAudio.currentTime = serverSecs;
                }
            } else {
                // Les deux horloges concordent : le serveur redevient la référence.
                positionClientPrioritaire = false;
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
    }
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
    majApplicabiliteQualite();

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
            console.log('[WebSocket] Onglet devenu visible. Vérification de la connexion...');

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
                console.log('[WebSocket] Déconnecté. Reconnexion immédiate...');
                connectWebSocket();
            } else if (ws.readyState === WebSocket.OPEN) {
                console.log('[WebSocket] Connecté. Demande de synchronisation d\'état...');
                sendWS({ type: 'requestState' });
            }
        }
    });

    // Global ESC Key Listener (Close settings, maintenance, playlist, and server delete modals)
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' || e.keyCode === 27) {
            // Le lecteur de documentation est la fenêtre la plus haute : il
            // prend la touche avant tout le reste, et la laisse aux autres
            // quand il n'est pas ouvert.
            if (typeof window.MusicPlayer.closeDocsModal === 'function') {
                if (window.MusicPlayer.closeDocsModal()) return;
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

            const modalsToClose = [
                'settings-modal',
                'maintenance-modal',
                'playlist-create-modal',
                'server-confirm-delete-modal'
            ];
            modalsToClose.forEach(id => {
                const modal = document.getElementById(id);
                if (modal && !modal.classList.contains('hidden')) {
                    modal.classList.add('hidden');
                    if (id === 'settings-modal') {
                        localStorage.setItem('music_player_settings_open', 'false');
                    }
                }
            });
        }
    });

    // Start WebSocket
    connectWebSocket();
})();

