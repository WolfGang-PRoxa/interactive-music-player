/**
 * Floating Video Window & Custom Canvas Rendering Controller
 * 100% Independent Custom Player Engine (No YouTube iFrame Integration)
 */

window.MusicPlayer = window.MusicPlayer || {};

const VIDEO_SUPPORTED_SPEEDS = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0];
let isVideoUserInteracting = false;
let currentVideoTrackUrl = null;
let canvasAnimId = null;
let loadedCoverImage = null;
let loadedCoverUrl = null;

/**
 * Charge la pochette en réclamant le partage d'origine.
 *
 * ## Pourquoi
 *
 * Le visualiseur dessine la pochette sur son canevas, et ces images viennent
 * d'ailleurs — `i.ytimg.com`, `upload.wikimedia.org`, `scdn.co`. Un canevas qui
 * reçoit une image étrangère chargée sans en-tête de partage devient « teinté » :
 * le navigateur refuse alors d'en extraire quoi que ce soit. `getImageData` s'y
 * heurte, et `captureStream()` aussi — c'est-à-dire précisément ce dont dépend
 * le plein écran du système sur une piste audio, où il n'y a pas d'autre vidéo
 * à agrandir. L'appareil le disait sans détour : « Canvas is tainted ».
 *
 * `crossOrigin` suffit à l'éviter, à condition que l'hôte l'autorise. Les trois
 * hôtes de ce projet répondent tous `Access-Control-Allow-Origin: *` — vérifié.
 *
 * ## Le repli
 *
 * Un hôte qui refuserait le partage ferait échouer le chargement tout court, et
 * la pochette disparaîtrait. On réessaie donc sans, et l'image revient : le
 * canevas est teinté, le plein écran du système s'en trouve perdu pour la
 * session, mais une pochette visible vaut mieux qu'une fonction rarement
 * employée. L'échec est de toute façon rapporté quand on l'atteint.
 *
 * Le canevas ne se « détache » jamais : une seule image teintée le condamne pour
 * la vie de l'élément. D'où la demande de partage dès le premier essai.
 *
 * @param {string} url
 * @param {boolean} [withCors=true] Faux au second essai, sans partage.
 */
function loadCoverImage(url, withCors = true) {
    const img = new Image();
    if (withCors) img.crossOrigin = 'anonymous';

    img.onload = () => {
        // Une autre piste a pu passer pendant le chargement : sa pochette a la
        // priorité, celle-ci n'a plus lieu d'être posée.
        if (loadedCoverUrl !== url) return;
        loadedCoverImage = img;
    };

    img.onerror = () => {
        if (loadedCoverUrl !== url) return;
        if (withCors) {
            loadCoverImage(url, false);
            return;
        }
        loadedCoverImage = null;
    };

    img.src = url;
}

/**
 * Surveillance du flux vidéo distant.
 *
 * Un flux que le navigateur ne sait pas décoder ne fait pas avancer
 * `currentTime`. La resynchronisation le voit alors dériver de l'audio et le
 * repositionne sans cesse : chaque saut décode une image isolée, ce qui donne
 * un clignotement à la cadence des resyncs au lieu d'une vidéo. On compte les
 * repositionnements restés sans effet pour basculer sur le visualiseur.
 */
let videoTimeAfterResync = -1;
let lastResyncAt = 0;
let resyncsWithoutProgress = 0;
let videoStreamAbandoned = false;

/** Nombre de resynchronisations infructueuses avant de renoncer au flux. */
const RESYNCS_BEFORE_GIVEUP = 3;

/**
 * Dérive en deçà de laquelle on ne touche à rien.
 *
 * C'est l'écart résiduel auquel la correction se stabilise : il faut donc le
 * garder sous le seuil de perception d'un décalage son/image, de l'ordre de
 * 40 ms. Descendre plus bas ne servirait à rien — la référence de progression
 * est elle-même extrapolée entre deux messages du serveur.
 */
const DRIFT_DEADBAND_S = 0.035;

/**
 * Dérive au-delà de laquelle le saut franc devient inévitable.
 *
 * Un saut vide le décodeur et se voit — c'est exactement la coupure de quelques
 * millisecondes à éviter. En régime normal la correction de vitesse maintient
 * l'écart bien en deçà ; ce seuil ne sert donc qu'aux accidents : mise en
 * mémoire tampon, onglet masqué, changement de piste.
 */
const DRIFT_SEEK_S = 1.0;

/**
 * Écart de vitesse maximal pour rattraper une dérive, en proportion.
 *
 * Le flux vidéo est muet — l'audio vient de Discord ou du lecteur local — donc
 * aucune déformation de hauteur de son n'est à craindre. On peut être bien plus
 * franc que les 5 % habituels d'un lecteur classique : 15 % restent invisibles
 * à l'œil et résorbent une demi-seconde d'écart en trois secondes environ.
 */
const MAX_SPEED_CORRECTION = 0.15;

/** Dérive à laquelle la correction atteint son maximum. */
const DRIFT_FULL_CORRECTION_S = 0.5;

/**
 * Resynchronisation franche réclamée par un événement extérieur — typiquement
 * le retour sur l'onglet, où la vidéo a pu être gelée par le navigateur
 * pendant que l'audio, lui, continuait côté serveur.
 */
let hardResyncRequested = false;

/**
 * Applique une vitesse de lecture au lecteur, avec tolérance.
 *
 * La correction de dérive produit des valeurs fractionnaires : une comparaison
 * stricte réécrirait `playbackRate` à chaque image, ce qui provoque des
 * à-coups sur certains navigateurs.
 *
 * @param {HTMLVideoElement} videoElement
 * @param {number} vitesse
 */
function applyVideoSpeed(videoElement, speed) {
    const target = Math.max(0.0625, Math.min(16, speed));
    if (Math.abs(videoElement.playbackRate - target) > 0.005) {
        videoElement.playbackRate = target;
    }
}

/**
 * Délai minimal entre deux constats d'échec.
 *
 * Deux appels rapprochés — une diffusion d'état qui suit de peu un tic de
 * progression — ne laissent pas à un flux sain le temps d'avancer de façon
 * mesurable. Sans ce garde-fou, une vidéo parfaitement lisible pourrait être
 * écartée sur trois coïncidences.
 */
const MIN_DELAY_BETWEEN_FAILURES_MS = 1000;

/** Réarme la surveillance : appelé à chaque nouvelle source chargée. */
function resetVideoWatch() {
    videoTimeAfterResync = -1;
    lastResyncAt = 0;
    resyncsWithoutProgress = 0;
    videoStreamAbandoned = false;
}

/**
 * Renonce au flux vidéo et repasse au visualiseur audio.
 * @param {HTMLVideoElement} videoElement
 * @param {string} reason
 */
function abandonVideoStream(videoElement, reason) {
    if (videoStreamAbandoned) return;
    videoStreamAbandoned = true;

    console.warn(`[Video] Stream unreadable by the browser (${reason}). Falling back to the audio visualiser.`);

    try {
        videoElement.pause();
        videoElement.classList.add('hidden');
        videoElement.removeAttribute('data-loaded-src');
        videoElement.removeAttribute('data-loaded-quality');
        videoElement.removeAttribute('src');
        videoElement.load();
    } catch (e) {}

    const videoCanvas = document.getElementById('video-canvas');
    if (videoCanvas) {
        videoCanvas.classList.remove('hidden');
        startCanvasLoop();
    }
}

// Particle system for canvas atmosphere
const particles = Array.from({ length: 35 }, () => ({
    x: Math.random(),
    y: Math.random(),
    radius: Math.random() * 2 + 1,
    speedX: (Math.random() - 0.5) * 0.001,
    speedY: -Math.random() * 0.001 - 0.0005,
    alpha: Math.random() * 0.5 + 0.2
}));

window.MusicPlayer.getNearestSupportedVideoSpeed = function(requestedSpeed) {
    const req = parseFloat(requestedSpeed) || 1.0;
    return req.toFixed(2);
};

window.MusicPlayer.syncVideoVolume = function(volume) {
    const targetVol = Math.max(0, Math.min(100, Math.round(volume)));
    const videoElement = document.getElementById('video-element');

    if (videoElement) {
        videoElement.volume = 0;
        videoElement.muted = true;
    }

    const videoVolumeSlider = document.getElementById('video-volume-slider');
    const videoSvgVolHigh = document.getElementById('video-svg-volume-high');
    const videoSvgVolMute = document.getElementById('video-svg-volume-mute');

    if (videoVolumeSlider) videoVolumeSlider.value = targetVol;
    if (videoSvgVolHigh && videoSvgVolMute) {
        if (targetVol === 0) {
            videoSvgVolHigh.classList.add('hidden');
            videoSvgVolMute.classList.remove('hidden');
        } else {
            videoSvgVolHigh.classList.remove('hidden');
            videoSvgVolMute.classList.add('hidden');
        }
    }
};

window.MusicPlayer.syncVideoSpeed = function(speedStr) {
    const speedVal = parseFloat(speedStr) || 1.0;
    const formattedSpeed = speedVal.toFixed(2);

    const videoElement = document.getElementById('video-element');
    if (videoElement && !videoElement.classList.contains('hidden')) {
        applyVideoSpeed(videoElement, speedVal);
    }

    return formattedSpeed;
};

/**
 * Piste visée par la roue de qualité, lue au moment du clic.
 *
 * Volontairement recalculée depuis l'état plutôt que mémorisée par
 * `updateVideoPlayer` : cette fonction comporte plusieurs sorties anticipées,
 * et la moindre d'entre elles laisserait la roue visible mais inerte.
 * L'état, lui, est toujours à jour.
 *
 * @returns {object|null}
 */
function qualityWheelTrack() {
    const state = window.MusicPlayer.state || {};
    const track = state.currentTrack;
    // Un fichier local n'est jamais transcodé : sa qualité ne se règle pas.
    if (!track || !track.url || track.isLocal) return null;
    return track;
}

/**
 * Toutes les roues de qualité de l'interface.
 *
 * Il y en a deux — l'une incrustée sur l'image, l'autre dans la carte « En
 * cours de lecture » — et elles commandent strictement la même chose. Les
 * traiter en bloc évite qu'elles divergent.
 *
 * @returns {HTMLElement[]}
 */
function qualityWheels() {
    return [...document.querySelectorAll('.quality-gear-btn')];
}

/**
 * Actualise les roues de qualité selon la piste affichée.
 * @param {object|null} track
 */
function updateQualityWheel(track) {
    const buttons = qualityWheels();
    if (buttons.length === 0) return;

    const usable = !!(track && track.url && !track.isLocal);
    buttons.forEach(b => b.classList.toggle('hidden', !usable));

    // Une roue qui s'efface emporte le menu qu'elle avait ouvert — il pointerait
    // sinon dans le vide. Mais le menu du clic droit sur un élément de liste
    // vise une tout autre piste et ne dépend en rien de la lecture en cours :
    // le refermer ici le rendait inutilisable tant que rien de réglable n'était
    // en lecture, l'état étant rediffusé toutes les 150 ms pendant qu'un
    // préchargement progresse — soit exactement la situation d'un démarrage.
    if (!usable && typeof window.MusicPlayer.hideAnchoredTrackQualityMenu === 'function') {
        window.MusicPlayer.hideAnchoredTrackQualityMenu();
    }

    // Le menu resté ouvert suit la requalification en cours sur sa piste
    if (typeof window.MusicPlayer.refreshTrackQualityMenu === 'function') {
        window.MusicPlayer.refreshTrackQualityMenu();
    }
}

/**
 * Réclame un recalage franc de la vidéo à la prochaine synchronisation.
 *
 * Le rattrapage progressif suppose un écart de l'ordre de la seconde. Après un
 * retour sur l'onglet, la vidéo peut avoir plusieurs minutes de retard : la
 * corriger à ±8 % de vitesse prendrait un temps déraisonnable. On assume donc
 * un saut, invisible puisque l'utilisateur revient tout juste.
 *
 * Le recalage est différé plutôt qu'immédiat : il utilisera ainsi la position
 * fraîche renvoyée par le serveur, et non celle d'avant la mise en veille.
 */
window.MusicPlayer.requestVideoResync = function() {
    hardResyncRequested = true;
};

window.MusicPlayer.syncVideoProgress = function(currentMs, isExplicitSeek = false) {
    if (isVideoUserInteracting && !isExplicitSeek) return;
    const state = window.MusicPlayer.state || {};
    const speed = parseFloat((state.settings && state.settings.playbackSpeed) || window.MusicPlayer.currentSpeed || '1.0') || 1.0;
    const seconds = Math.max(0, (currentMs !== undefined ? currentMs : ((state.progress && state.progress.currentMs) || 0)) / 1000);
    const videoElement = document.getElementById('video-element');

    if (videoElement && !videoElement.classList.contains('hidden')) {
        // Dérive signée : positive si la vidéo est en avance sur l'audio.
        const derive = videoElement.currentTime - seconds;
        const gap = Math.abs(derive);

        const force = isExplicitSeek || hardResyncRequested;
        // À l'arrêt, la vitesse n'a aucune prise : seul un repositionnement
        // remet la vidéo en place, et il ne se voit pas sur une image figée.
        const seek = force || gap >= DRIFT_SEEK_S || (videoElement.paused && gap > DRIFT_DEADBAND_S);

        if (seek) {
            // Un repositionnement automatique qui n'a rien débloqué au
            // précédent passage signale un flux figé : insister ne ferait
            // qu'entretenir le clignotement image par image.
            const nowMs = Date.now();
            if (!force && !videoElement.paused && videoTimeAfterResync >= 0
                && (nowMs - lastResyncAt) >= MIN_DELAY_BETWEEN_FAILURES_MS) {
                if (videoElement.currentTime <= videoTimeAfterResync + 0.2) {
                    resyncsWithoutProgress++;
                    if (resyncsWithoutProgress >= RESYNCS_BEFORE_GIVEUP) {
                        abandonVideoStream(videoElement, 'playback stuck after several resyncs');
                        return;
                    }
                } else {
                    resyncsWithoutProgress = 0;
                }
            }

            try {
                videoElement.currentTime = seconds;
                videoTimeAfterResync = videoElement.currentTime;
                lastResyncAt = nowMs;
            } catch (err) {}
            hardResyncRequested = false;
            applyVideoSpeed(videoElement, speed);
        } else if (gap <= DRIFT_DEADBAND_S) {
            applyVideoSpeed(videoElement, speed);
        } else {
            // Rattrapage progressif : on joue légèrement plus vite quand la
            // vidéo est en retard, plus lentement quand elle est en avance.
            // L'écart se résorbe sans jamais vider le décodeur, donc sans
            // coupure visible.
            const proportion = Math.max(-1, Math.min(1, derive / DRIFT_FULL_CORRECTION_S));
            applyVideoSpeed(videoElement, speed * (1 - proportion * MAX_SPEED_CORRECTION));
        }
    }

    const videoProgressFill = document.getElementById('video-progress-fill');
    const videoTimeCurrent = document.getElementById('video-time-current');
    const videoTimeTotal = document.getElementById('video-time-total');

    if (state && state.progress) {
        const totalMs = state.progress.totalMs || 0;
        const cMs = currentMs !== undefined ? currentMs : (state.progress.currentMs || 0);
        const ratio = totalMs > 0 ? Math.min(Math.max(cMs / totalMs, 0), 1) : 0;
        if (videoProgressFill) {
            videoProgressFill.style.transform = `scaleX(${ratio})`;
        }
        if (videoTimeCurrent && typeof window.MusicPlayer.formatMs === 'function') {
            const formatted = window.MusicPlayer.formatMs(Math.round(cMs / speed));
            if (videoTimeCurrent.textContent !== formatted) {
                videoTimeCurrent.textContent = formatted;
            }
        }
        if (videoTimeTotal && typeof window.MusicPlayer.formatMs === 'function') {
            const formattedTotal = window.MusicPlayer.formatMs(Math.round(totalMs / speed));
            if (videoTimeTotal.textContent !== formattedTotal) {
                videoTimeTotal.textContent = formattedTotal;
            }
        }
    }
};

window.MusicPlayer.syncVideoPlayState = function(isPlaying, isPaused) {
    const state = window.MusicPlayer.state || {};
    const effectiveIsPaused = (isPaused !== undefined && isPaused !== null) ? isPaused : state.isPaused;
    const shouldPlay = !!state.currentTrack && !effectiveIsPaused;
    const videoElement = document.getElementById('video-element');

    if (videoElement && !videoElement.classList.contains('hidden')) {
        if (shouldPlay) {
            if (videoElement.paused) {
                videoElement.play().catch(() => {});
            }
        } else {
            if (!videoElement.paused) {
                videoElement.pause();
            }
        }
    }

    window.MusicPlayer.syncVideoOverlayButtons(state);

    // Trigger canvas render tick if canvas visualizer is active
    if (typeof window.MusicPlayer.drawCanvasStage === 'function') {
        window.MusicPlayer.drawCanvasStage();
    }
};

window.MusicPlayer.syncVideoOverlayButtons = function(passedState) {
    const state = passedState || window.MusicPlayer.state || {};
    const videoBtnPrev = document.getElementById('video-btn-prev');
    const videoBtnNext = document.getElementById('video-btn-next');
    const videoBtnStop = document.getElementById('video-btn-stop');
    const videoBtnPlayPause = document.getElementById('video-btn-play-pause');
    const videoSvgPlay = document.getElementById('video-svg-play');
    const videoSvgPause = document.getElementById('video-svg-pause');
    const btnPrevious = document.getElementById('btn-previous');
    const btnSkip = document.getElementById('btn-skip');
    const btnStop = document.getElementById('btn-stop');
    const btnPlayPause = document.getElementById('btn-play-pause');
    const t = window.MusicPlayer.t || (x => x);

    if (videoBtnPrev) {
        videoBtnPrev.disabled = btnPrevious ? btnPrevious.disabled : false;
        videoBtnPrev.dataset.tooltip = (btnPrevious && btnPrevious.dataset.tooltip) || t('tooltip_previous');
    }

    if (videoBtnNext) {
        videoBtnNext.disabled = btnSkip ? btnSkip.disabled : false;
        videoBtnNext.dataset.tooltip = (btnSkip && btnSkip.dataset.tooltip) || t('tooltip_video_next');
    }

    if (videoBtnStop) {
        videoBtnStop.disabled = btnStop ? btnStop.disabled : false;
        videoBtnStop.dataset.tooltip = (btnStop && btnStop.dataset.tooltip) || t('tooltip_stop');
    }

    if (videoBtnPlayPause) {
        videoBtnPlayPause.disabled = !state.currentTrack;
        videoBtnPlayPause.dataset.tooltip = (btnPlayPause && btnPlayPause.dataset.tooltip) || t('tooltip_play_pause');
    }

    if (videoSvgPlay && videoSvgPause) {
        if (state.isPlaying && !state.isPaused) {
            videoSvgPlay.classList.add('hidden');
            videoSvgPause.classList.remove('hidden');
        } else {
            videoSvgPlay.classList.remove('hidden');
            videoSvgPause.classList.add('hidden');
        }
    }

    /*
     * Le transport du centre est le reflet de celui de la barre : il en reprend
     * l'état désactivé, l'infobulle et l'icône, plutôt que de refaire le calcul.
     * Les trois boutons de la barre viennent eux-mêmes d'être alignés sur ceux
     * de la carte « En cours de lecture », si bien qu'une seule chaîne mène de
     * l'état du lecteur à ce qui s'affiche, où qu'on regarde.
     */
    const centerTwins = [
        ['video-center-btn-prev', videoBtnPrev],
        ['video-center-btn-next', videoBtnNext],
        ['video-center-btn-play-pause', videoBtnPlayPause],
    ];
    for (const [centerId, twin] of centerTwins) {
        const button = document.getElementById(centerId);
        if (!button || !twin) continue;
        button.disabled = twin.disabled;
        if (twin.dataset.tooltip) button.dataset.tooltip = twin.dataset.tooltip;
    }

    const centerSvgPlay = document.getElementById('video-center-svg-play');
    const centerSvgPause = document.getElementById('video-center-svg-pause');
    if (centerSvgPlay && centerSvgPause) {
        const playing = state.isPlaying && !state.isPaused;
        centerSvgPlay.classList.toggle('hidden', !!playing);
        centerSvgPause.classList.toggle('hidden', !playing);
    }
};

/**
 * Custom Canvas Audio Stage Renderer (Cyberpunk / Glassmorphism Audio Stage)
 */
window.MusicPlayer.drawCanvasStage = function() {
    const canvas = document.getElementById('video-canvas');
    if (!canvas || canvas.classList.contains('hidden')) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== rect.width * dpr || canvas.height !== rect.height * dpr) {
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
    }

    const W = canvas.width;
    const H = canvas.height;
    ctx.scale(dpr, dpr);
    const w = W / dpr;
    const h = H / dpr;

    const state = window.MusicPlayer.state || {};
    const track = state.currentTrack || {};
    const isPlaying = state.isPlaying && !state.isPaused;

    // Load cover image if available
    if (track.thumbnail && loadedCoverUrl !== track.thumbnail) {
        loadedCoverUrl = track.thumbnail;
        loadCoverImage(track.thumbnail);
    } else if (!track.thumbnail) {
        loadedCoverImage = null;
        loadedCoverUrl = null;
    }

    const time = Date.now() * 0.0015;

    // 1. Dynamic Gradient Background
    const bgGrad = ctx.createLinearGradient(0, 0, w, h);
    bgGrad.addColorStop(0, '#0a090f');
    bgGrad.addColorStop(0.5, '#160d28');
    bgGrad.addColorStop(1, '#090812');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, h);

    // Ambient Glowing Orbs
    const orb1X = w * 0.3 + Math.sin(time * 0.8) * 30;
    const orb1Y = h * 0.4 + Math.cos(time * 0.6) * 20;
    const gradOrb1 = ctx.createRadialGradient(orb1X, orb1Y, 10, orb1X, orb1Y, w * 0.4);
    gradOrb1.addColorStop(0, 'rgba(235, 69, 158, 0.35)');
    gradOrb1.addColorStop(1, 'transparent');
    ctx.fillStyle = gradOrb1;
    ctx.fillRect(0, 0, w, h);

    const orb2X = w * 0.7 + Math.cos(time * 0.7) * 35;
    const orb2Y = h * 0.6 + Math.sin(time * 0.9) * 25;
    const gradOrb2 = ctx.createRadialGradient(orb2X, orb2Y, 10, orb2X, orb2Y, w * 0.45);
    gradOrb2.addColorStop(0, 'rgba(99, 102, 241, 0.3)');
    gradOrb2.addColorStop(1, 'transparent');
    ctx.fillStyle = gradOrb2;
    ctx.fillRect(0, 0, w, h);

    // 2. Animated Particle Atmosphere
    particles.forEach(p => {
        if (isPlaying) {
            p.y += p.speedY;
            p.x += p.speedX;
            if (p.y < 0) p.y = 1;
            if (p.x < 0) p.x = 1;
            if (p.x > 1) p.x = 0;
        }
        ctx.beginPath();
        ctx.arc(p.x * w, p.y * h, p.radius, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 255, 255, ${p.alpha * 0.6})`;
        ctx.fill();
    });

    const centerX = w / 2;
    /*
     * Le disque au centre exact de l'image, et non à 48 % de sa hauteur.
     *
     * Ces deux pour cent le remontaient de quelques pixels — quatre sur une
     * image de 219 px de haut, celle d'un téléphone debout. Assez peu pour
     * passer inaperçu tant que rien ne servait de repère, assez pour se voir
     * depuis que le transport se pose dessus : le bouton de lecture, lui, est
     * au centre géométrique, et le disque flottait juste au-dessus de lui.
     *
     * Rien ne réclamait ce relèvement. La vague du bas est tracée à `h - 35`,
     * indépendamment du reste ; le disque en occupe 48 de rayon et s'arrête à
     * 26 px d'elle une fois recentré — il ne l'a jamais approchée.
     */
    const centerY = h / 2;
    const baseRadius = Math.max(10, Math.min(w, h) * 0.22);
    const innerRadius = Math.max(1, baseRadius - 2);

    // 3. Radial Frequency Spectrum Bars (64 Bars)
    const numBars = 64;
    for (let i = 0; i < numBars; i++) {
        const angle = (i / numBars) * Math.PI * 2 + (isPlaying ? time * 0.2 : 0);
        const freqVal = isPlaying
            ? Math.abs(Math.sin(i * 0.2 + time * 3.5)) * 25 + Math.cos(i * 0.5 + time * 2) * 15 + 8
            : 4;

        const innerR = baseRadius + 6;
        const outerR = innerR + Math.max(3, freqVal);

        const x1 = centerX + Math.cos(angle) * innerR;
        const y1 = centerY + Math.sin(angle) * innerR;
        const x2 = centerX + Math.cos(angle) * outerR;
        const y2 = centerY + Math.sin(angle) * outerR;

        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.lineWidth = 2.5;
        const barHue = 280 + (i / numBars) * 90;
        ctx.strokeStyle = `hsla(${barHue}, 90%, 65%, 0.85)`;
        ctx.lineCap = 'round';
        ctx.stroke();
    }

    // 4. Central Glowing Ring & Cover Stage
    ctx.save();
    ctx.beginPath();
    ctx.arc(centerX, centerY, baseRadius, 0, Math.PI * 2);
    ctx.shadowColor = 'rgba(235, 69, 158, 0.6)';
    ctx.shadowBlur = isPlaying ? 25 : 10;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.restore();

    // Draw Album Cover Image inside Circle
    ctx.save();
    ctx.beginPath();
    ctx.arc(centerX, centerY, innerRadius, 0, Math.PI * 2);
    ctx.clip();

    if (loadedCoverImage) {
        ctx.drawImage(loadedCoverImage, centerX - baseRadius, centerY - baseRadius, baseRadius * 2, baseRadius * 2);
    } else {
        const defaultGrad = ctx.createLinearGradient(centerX - baseRadius, centerY - baseRadius, centerX + baseRadius, centerY + baseRadius);
        defaultGrad.addColorStop(0, '#eb459e');
        defaultGrad.addColorStop(1, '#6366f1');
        ctx.fillStyle = defaultGrad;
        ctx.fillRect(centerX - baseRadius, centerY - baseRadius, baseRadius * 2, baseRadius * 2);

        // Music Note Icon
        ctx.fillStyle = '#ffffff';
        ctx.font = `${baseRadius * 0.8}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('🎵', centerX, centerY);
    }
    ctx.restore();

    // 5. Glass Reflection Overlay on Cover
    ctx.save();
    ctx.beginPath();
    ctx.arc(centerX, centerY, innerRadius, 0, Math.PI * 2);
    ctx.clip();
    const glassGrad = ctx.createLinearGradient(centerX - baseRadius, centerY - baseRadius, centerX + baseRadius, centerY + baseRadius);
    glassGrad.addColorStop(0, 'rgba(255, 255, 255, 0.25)');
    glassGrad.addColorStop(0.4, 'rgba(255, 255, 255, 0.05)');
    glassGrad.addColorStop(1, 'transparent');
    ctx.fillStyle = glassGrad;
    ctx.fill();
    ctx.restore();

    // 6. Bottom Audio Waveform Spectrum
    const waveY = h - 35;
    ctx.beginPath();
    ctx.moveTo(0, waveY);
    for (let x = 0; x <= w; x += 6) {
        const waveH = isPlaying
            ? Math.sin(x * 0.03 + time * 4) * 8 + Math.cos(x * 0.05 - time * 3) * 6
            : 0;
        ctx.lineTo(x, waveY + waveH);
    }
    ctx.strokeStyle = 'rgba(235, 69, 158, 0.5)';
    ctx.lineWidth = 2;
    ctx.stroke();
};

function startCanvasLoop() {
    if (canvasAnimId) cancelAnimationFrame(canvasAnimId);
    function loop() {
        if (typeof window.MusicPlayer.drawCanvasStage === 'function') {
            window.MusicPlayer.drawCanvasStage();
        }
        canvasAnimId = requestAnimationFrame(loop);
    }
    canvasAnimId = requestAnimationFrame(loop);
}

window.MusicPlayer.updateVideoPlayer = async function(track) {
    const toggleVideoMode = document.getElementById('toggle-video-mode');
    const videoContainer = document.getElementById('video-floating-window');
    const videoCanvas = document.getElementById('video-canvas');
    const videoElement = document.getElementById('video-element');
    const videoPlaceholder = document.getElementById('video-placeholder');
    const state = window.MusicPlayer.state || {};

    const videoTopOverlay = document.getElementById('video-top-overlay');
    const videoInfoTitle = document.getElementById('video-info-title');
    const videoInfoAuthor = document.getElementById('video-info-author');

    if (!toggleVideoMode || !videoContainer) return;

    // Les roues de qualité sont mises à jour avant toute sortie anticipée :
    // celle de la carte « En cours de lecture » doit rester utilisable même
    // lorsque le mode vidéo est coupé, ne serait-ce que pour l'audio.
    updateQualityWheel(track || state.currentTrack);

    const isVideoActive = toggleVideoMode.checked;
    if (!isVideoActive) {
        videoContainer.classList.add('hidden');
        if (videoElement) {
            videoElement.pause();
            videoElement.src = '';
            videoElement.removeAttribute('data-loaded-src');
            videoElement.removeAttribute('data-loaded-quality');
        }
        currentVideoTrackUrl = null;
        return;
    }

    // Ouverture du tiroir tactile : les commandes se montrent, puis s'effacent
    // comme après n'importe quel geste. Seulement au passage de caché à
    // affiché — `updateVideoPlayer` est rappelée à chaque état reçu, et la
    // relancer chaque fois les figerait à l'écran.
    const wasHidden = videoContainer.classList.contains('hidden');
    videoContainer.classList.remove('hidden');
    if (wasHidden
        && window.MusicPlayer.deviceMode && window.MusicPlayer.deviceMode.isTouch()
        && typeof window.MusicPlayer.pokeVideoOverlay === 'function') {
        window.MusicPlayer.pokeVideoOverlay();
    }

    const effectiveTrack = track || state.currentTrack;
    const trackUrl = effectiveTrack ? (effectiveTrack.url || effectiveTrack.uri || effectiveTrack.link || '') : '';

    if (!effectiveTrack || (!trackUrl && !effectiveTrack.title)) {
        if (videoCanvas) videoCanvas.classList.add('hidden');
        if (videoElement) {
            videoElement.classList.add('hidden');
            videoElement.removeAttribute('data-loaded-src');
            videoElement.removeAttribute('data-loaded-quality');
            if (videoElement.src) {
                videoElement.pause();
                videoElement.src = '';
            }
        }
        if (videoPlaceholder) videoPlaceholder.classList.remove('hidden');
        if (videoTopOverlay) videoTopOverlay.classList.add('hidden');
        currentVideoTrackUrl = null;
        return;
    }

    if (videoInfoTitle) videoInfoTitle.textContent = effectiveTrack.title || '';
    if (videoInfoAuthor) videoInfoAuthor.textContent = effectiveTrack.author || '';
    if (videoTopOverlay) videoTopOverlay.classList.remove('hidden');

    const trackKey = trackUrl || `${effectiveTrack.title}-${effectiveTrack.author}`;
    const currentMs = (state.progress && state.progress.currentMs) || 0;
    const isSameTrack = (currentVideoTrackUrl === trackKey);
    currentVideoTrackUrl = trackKey;

    // La qualité entre dans le critère de « même piste » : sans cela, le flux
    // déjà chargé serait conservé indéfiniment et un changement de qualité
    // depuis la roue ou le menu contextuel resterait sans effet à l'écran.
    const wantedQuality = String(effectiveTrack.desiredVideoQuality || '');
    const loadedQuality = videoElement ? (videoElement.getAttribute('data-loaded-quality') || '') : '';
    const sameQuality = wantedQuality === loadedQuality;

    if (isSameTrack && sameQuality && videoElement && !videoElement.classList.contains('hidden')
        && videoElement.src && videoElement.readyState >= 1) {
        window.MusicPlayer.syncVideoProgress(currentMs, false);
        window.MusicPlayer.syncVideoPlayState(state.isPlaying, state.isPaused);
        return;
    }

    const startSec = Math.max(0, Math.floor(((state.progress && state.progress.currentMs) || 0) / 1000));

    if (videoPlaceholder) videoPlaceholder.classList.add('hidden');

    // Direct or local video file detection vs audio file
    const videoExts = ['mp4', 'webm', 'ogv', 'm3u8', 'mkv', 'avi', 'mov', 'flv', 'm4v', '3gp', 'wmv'];
    const audioExts = ['mp3', 'wav', 'flac', 'ogg', 'opus', 'm4a', 'aac', 'wma'];
    const trackExt = (trackUrl || '').split('?')[0].split('.').pop().toLowerCase();
    const titleExt = (effectiveTrack.title || '').split('.').pop().toLowerCase();
    const isVideoFile = videoExts.includes(trackExt) ||
        videoExts.includes(titleExt) ||
        videoExts.some(ext => (effectiveTrack.title || '').toLowerCase().endsWith('.' + ext) || trackUrl.toLowerCase().endsWith('.' + ext));

    const isLocalOrAudioFile = !isVideoFile && (
        effectiveTrack.queryType === 'file' ||
        !/^https?:\/\//i.test(trackUrl) ||
        trackUrl.includes('/uploads/') ||
        trackUrl.includes('data\\uploads') ||
        /^[a-zA-Z]:[\\\/]/.test(trackUrl) ||
        audioExts.some(ext => titleExt === ext || trackExt === ext)
    );

    if (isVideoFile || /\.(mp4|webm|ogv|m3u8|mkv|avi|mov|flv|m4v|3gp|wmv)(\?.*)?$/i.test(trackUrl)) {
        if (videoElement) {
            const currentGuildId = state.guildId || (window.MusicPlayer.state && window.MusicPlayer.state.guildId) || '';
            let targetVideoSrc = trackUrl;
            if (effectiveTrack.queryType === 'file' || !/^https?:\/\//i.test(trackUrl)) {
                targetVideoSrc = `/api/stream?guildId=${currentGuildId}&trackUrl=${encodeURIComponent(trackUrl)}`;
            }

            videoElement.muted = true;
            videoElement.playsInline = true;

            if (!videoElement.src || videoElement.getAttribute('data-loaded-src') !== targetVideoSrc) {
                videoElement.setAttribute('data-loaded-src', targetVideoSrc);
                videoElement.src = targetVideoSrc;
                resetVideoWatch();
                videoElement.load();
            }
            // Un fichier direct n'a pas de définition négociée ; on inscrit tout
            // de même la valeur voulue pour que le critère de rechargement
            // ci-dessus reste stable d'un passage à l'autre.
            videoElement.setAttribute('data-loaded-quality', wantedQuality);

            if (videoCanvas) videoCanvas.classList.add('hidden');
            videoElement.classList.remove('hidden');

            if (state.isPlaying && !state.isPaused) {
                videoElement.play().catch(() => {});
            } else {
                videoElement.pause();
            }
        }
    } else if (isLocalOrAudioFile) {
        // Local or uploaded audio file: use cyberpunk audio visualizer canvas stage (no video-info fetch)
        if (videoElement) {
            videoElement.classList.add('hidden');
            videoElement.removeAttribute('data-loaded-src');
            videoElement.removeAttribute('data-loaded-quality');
            if (videoElement.src) {
                videoElement.pause();
                videoElement.src = '';
            }
        }
        if (videoCanvas) {
            videoCanvas.classList.remove('hidden');
            startCanvasLoop();
        }
        window.MusicPlayer.syncVideoPlayState(state.isPlaying, state.isPaused);
    } else {
        // YouTube track: fetch direct video-only stream from /api/video-info
        if (videoCanvas) {
            videoCanvas.classList.remove('hidden');
            startCanvasLoop();
        }
        try {
            // guildId transmis pour que le serveur applique la qualité vidéo choisie
            const guildId = (window.MusicPlayer.state && window.MusicPlayer.state.guildId) || '';
            const apiUrl = `/api/video-info?guildId=${encodeURIComponent(guildId)}&trackUrl=${encodeURIComponent(trackUrl)}&title=${encodeURIComponent(effectiveTrack.title || '')}&author=${encodeURIComponent(effectiveTrack.author || '')}`;
            const res = await fetch(apiUrl);
            if (res.ok) {
                const data = await res.json();
                if (data.videoUrl && currentVideoTrackUrl === trackKey) {
                    if (videoElement) {
                        videoElement.muted = true;
                        videoElement.playsInline = true;
                        if (!videoElement.src || videoElement.getAttribute('data-loaded-src') !== data.videoUrl) {
                            videoElement.setAttribute('data-loaded-src', data.videoUrl);
                            videoElement.src = data.videoUrl;
                            resetVideoWatch();
                            videoElement.load();
                            // Un flux fraîchement chargé repart de zéro alors que
                            // l'audio, lui, n'a pas bougé : il faut le recaler
                            // franchement plutôt que d'attendre le rattrapage
                            // progressif, calibré pour des écarts d'une seconde.
                            window.MusicPlayer.requestVideoResync();
                            if (data.requestedHeight && data.height && data.height !== data.requestedHeight) {
                                console.info(`[Video] ${data.requestedHeight}p unavailable in a readable codec: `
                                    + `${data.height}p (${data.codec || '?'}) served instead.`);
                            }
                        }
                        // Mémorise la définition demandée pour ce flux : c'est ce
                        // qui permet de détecter un changement de qualité et de
                        // relancer une résolution.
                        videoElement.setAttribute('data-loaded-quality', wantedQuality);
                        // Un flux déjà écarté ne doit pas être réaffiché à chaque
                        // passage : le visualiseur reste en place jusqu'à la
                        // piste suivante, qui réarmera la surveillance.
                        if (!videoStreamAbandoned) {
                            if (videoCanvas) videoCanvas.classList.add('hidden');
                            videoElement.classList.remove('hidden');
                            if (state.isPlaying && !state.isPaused) {
                                videoElement.play().catch(() => {});
                            } else {
                                videoElement.pause();
                            }
                        }
                    }
                }
            }
        } catch (err) {
            console.log('[Video] Active canvas scene rendering:', err.message);
        }
    }

    if (state.volume !== undefined) {
        window.MusicPlayer.syncVideoVolume(state.volume);
    }
    if (state.settings && state.settings.playbackSpeed) {
        window.MusicPlayer.syncVideoSpeed(state.settings.playbackSpeed);
    }
    if (state.progress) {
        window.MusicPlayer.syncVideoProgress(state.progress.currentMs);
    }
    window.MusicPlayer.syncVideoPlayState(state.isPlaying, state.isPaused);
};

window.MusicPlayer.applyDefaultVideoWindowGeometry = function() {
    const videoWindow = document.getElementById('video-floating-window');
    if (!videoWindow) return;

    const dashboardSettings = window.MusicPlayer.dashboardSettings || {};
    const defaultPos = dashboardSettings.videoDefaultPos || { x: 100, y: 100 };
    const defaultSize = dashboardSettings.videoDefaultSize || { width: 440, height: 280 };

    videoWindow.style.left = `${defaultPos.x}px`;
    videoWindow.style.top = `${defaultPos.y}px`;
    videoWindow.style.width = `${defaultSize.width}px`;
    videoWindow.style.height = `${defaultSize.height}px`;
    videoWindow.style.right = 'auto';
};

window.MusicPlayer.setupFloatingVideoWindow = function() {
    const videoWindow = document.getElementById('video-floating-window');
    const videoHeader = document.getElementById('video-window-header');
    const resizeHandle = document.getElementById('video-window-resize-handle');
    const btnClose = document.getElementById('btn-close-video-window');

    if (videoWindow.dataset.floatingVideoSetupBound === 'true') return;
    videoWindow.dataset.floatingVideoSetupBound = 'true';

    // Codec refusé d'emblée : inutile d'attendre les trois resynchronisations
    // de la détection par dérive, le navigateur a déjà tranché.
    const watchedVideoElement = document.getElementById('video-element');
    if (watchedVideoElement) {
        watchedVideoElement.addEventListener('error', () => {
            if (!watchedVideoElement.getAttribute('data-loaded-src')) return;
            const code = watchedVideoElement.error && watchedVideoElement.error.code;
            abandonVideoStream(watchedVideoElement, `erreur de lecture (code ${code || '?'})`);
        });
    }

    try {
        const savedPos = JSON.parse(localStorage.getItem('dashboardVideoWindowPos') || 'null');
        if (savedPos && savedPos.left !== undefined) {
            videoWindow.style.left = `${savedPos.left}px`;
            videoWindow.style.top = `${savedPos.top}px`;
            videoWindow.style.width = `${savedPos.width}px`;
            videoWindow.style.height = `${savedPos.height}px`;
            videoWindow.style.right = 'auto';
        } else {
            window.MusicPlayer.applyDefaultVideoWindowGeometry();
        }
    } catch (e) {
        window.MusicPlayer.applyDefaultVideoWindowGeometry();
    }

    let overlayInactivityTimeout = null;

    /*
     * Ce qui retient les incrustations à l'écran.
     *
     * La minuterie d'inactivité compte le temps sans mouvement de souris. Au
     * doigt, il n'y en a jamais : un réglage qui dure plus que le délai voyait
     * donc la barre s'effacer sous la main qui s'en servait — le curseur de
     * volume qu'on fait glisser, le menu de la roue qu'on parcourt. Le pad de
     * vitesse avait déjà son garde ; il lui manquait des semblables.
     *
     * Deux signaux suffisent. Un pointeur maintenu sur une commande qui se
     * règle par glissement — les curseurs, la barre de progression — et un menu
     * ouvert, que sa roue signale d'une classe.
     */
    const SUSTAINED_CONTROLS = 'input[type="range"], .progress-bar-wrapper, .speed-pad-container';
    let pointerHeldOnControl = false;

    videoWindow.addEventListener('pointerdown', (e) => {
        if (e.target.closest && e.target.closest(SUSTAINED_CONTROLS)) pointerHeldOnControl = true;
    }, true);

    // Le relâchement est écouté sur la fenêtre du navigateur, et non sur la
    // commande : un glissement se termine souvent en dehors d'elle, et l'appui
    // serait resté « en cours » indéfiniment.
    ['pointerup', 'pointercancel'].forEach((evt) => {
        window.addEventListener(evt, () => { pointerHeldOnControl = false; }, true);
    });

    /** @returns {boolean} vrai tant qu'une commande est en main. */
    function overlayHeldOpen() {
        if (window.MusicPlayer.isSpeedPadDragging) return true;
        if (pointerHeldOnControl) return true;
        const gear = document.getElementById('btn-video-quality');
        return !!(gear && gear.classList.contains('is-open'));
    }

    function resetOverlayActivity() {
        videoWindow.classList.add('user-active');
        videoWindow.classList.remove('user-inactive');
        document.body.classList.add('user-active');
        document.body.classList.remove('user-inactive');

        if (overlayInactivityTimeout) {
            clearTimeout(overlayInactivityTimeout);
        }

        const isFullscreen = document.body.classList.contains('video-fullscreen-active') ||
            videoWindow.classList.contains('is-fullscreen') ||
            !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement);

        const delay = isFullscreen ? 1500 : 2500;

        /*
         * Retenue : on repousse d'un délai entier, on n'abandonne pas.
         *
         * L'ancien garde se contentait de sortir sans réarmer. La barre restait
         * alors affichée pour de bon — jusqu'au prochain mouvement, qui au doigt
         * n'arrive pas. Un délai plein après le relâchement est aussi ce qu'on
         * attend : lâcher le curseur de volume ne doit pas faire disparaître la
         * barre dans la seconde.
         */
        overlayInactivityTimeout = setTimeout(function tick() {
            if (overlayHeldOpen()) {
                overlayInactivityTimeout = setTimeout(tick, delay);
                return;
            }
            hideOverlayNow();
        }, delay);
    }

    /** Efface les incrustations sans attendre la minuterie, et la désarme. */
    function hideOverlayNow() {
        if (overlayInactivityTimeout) {
            clearTimeout(overlayInactivityTimeout);
            overlayInactivityTimeout = null;
        }
        videoWindow.classList.remove('user-active');
        videoWindow.classList.add('user-inactive');
        document.body.classList.remove('user-active');
        document.body.classList.add('user-inactive');
    }

    /**
     * Montre les incrustations et relance leur minuterie, de l'extérieur.
     *
     * Le tiroir tactile s'ouvre sans qu'aucune souris n'ait traversé la
     * fenêtre : ni `mousemove` ni `mouseenter`, donc aucune des deux classes
     * d'activité, et des commandes invisibles jusqu'au premier appui. On les
     * annonce donc à l'ouverture, comme le ferait le curseur au bureau, et
     * elles s'effacent ensuite d'elles-mêmes.
     */
    window.MusicPlayer.pokeVideoOverlay = resetOverlayActivity;

    document.addEventListener('mousemove', (e) => {
        const isFullscreen = document.body.classList.contains('video-fullscreen-active') ||
            videoWindow.classList.contains('is-fullscreen') ||
            !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement);

        if (isFullscreen || videoWindow.contains(e.target)) {
            resetOverlayActivity();
        }
    });

    videoWindow.addEventListener('mouseenter', () => {
        resetOverlayActivity();
        if (typeof window.MusicPlayer.updateSpeedPad === 'function') {
            window.MusicPlayer.updateSpeedPad(window.MusicPlayer.currentSpeed, true);
        }
    });

    videoWindow.addEventListener('mouseleave', () => {
        const isFullscreen = document.body.classList.contains('video-fullscreen-active') ||
            videoWindow.classList.contains('is-fullscreen') ||
            !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement);

        // Même retenue qu'à la minuterie : un glissement de curseur mène souvent
        // le pointeur hors de la fenêtre, et la barre ne doit pas s'effacer sous
        // la main qui s'en sert.
        if (!isFullscreen && !overlayHeldOpen()) {
            hideOverlayNow();
        }
    });

    if (btnClose) {
        btnClose.addEventListener('click', () => {
            const toggleVideoMode = document.getElementById('toggle-video-mode');
            if (toggleVideoMode) {
                toggleVideoMode.checked = false;
                toggleVideoMode.dispatchEvent(new Event('change'));
            }
        });
    }

    // --- Single Click (Play/Pause) and Double Click (+10s / -10s) Handler on Video Window ---
    let videoClickTimer = null;
    let lastVideoClickTime = 0;

    function showVideoSeekIndicator(text, isRight) {
        /*
         * La pastille se pose sur l'image, et non sur le cadre.
         *
         * Ses `top: 50%` et `left/right: 15%` se lisent dans le parent. Accrochée
         * au corps de la fenêtre, elle se plaçait donc au milieu de celui-ci —
         * commandes comprises — alors que l'image occupe désormais le haut,
         * remontée de la hauteur de la barre. Elle apparaissait à cheval sur le
         * bord bas de l'image, moitié dans le noir.
         *
         * L'accrocher au cadre de l'image remet les mêmes pourcentages sur ce
         * qu'ils désignaient : le geste vise l'image, le repère y répond. Aucune
         * constante à régler, et la mise en page peut encore bouger sans le
         * décaler à nouveau.
         */
        const picture = document.querySelector('#video-floating-window .video-aspect-wrapper');
        const host = picture
            || document.querySelector('#video-floating-window .video-window-body')
            || videoWindow;
        if (!host) return;

        const indicator = document.createElement('div');
        indicator.className = `video-seek-ripple ${isRight ? 'right' : 'left'}`;
        indicator.innerHTML = `<span>${text}</span>`;
        host.appendChild(indicator);

        setTimeout(() => {
            if (indicator.parentNode) {
                indicator.parentNode.removeChild(indicator);
            }
        }, 600);
    }

    const videoBodyElement = document.querySelector('#video-floating-window .video-window-body') || videoWindow;

    /*
     * Hauteur de la barre du bas, relevée pour le transport du centre.
     *
     * Il se centre sur ce que la barre laisse, pas sur le cadre entier — voir
     * `.video-center-controls` dans css/video.css. Cette hauteur dépend du
     * repli des onze commandes sur une, deux ou trois rangées, donc de la
     * largeur : aucune valeur écrite d'avance ne conviendrait, et le CSS ne
     * sait pas mesurer un frère. On la mesure ici, et on retire le cluster
     * quand la place restante ne suffit plus à le poser.
     *
     * Aucune boucle à craindre : la propriété déplace le cluster, la classe
     * joue sur son opacité, et ni l'une ni l'autre ne change la taille des deux
     * éléments observés.
     */
    (function trackControlsHeight() {
        const centerControls = document.getElementById('video-center-controls');
        const customControls = document.getElementById('video-custom-controls');
        if (!centerControls || !customControls || !videoBodyElement) return;

        const fit = () => {
            const bodyTop = videoBodyElement.getBoundingClientRect().top;
            const bar = customControls.getBoundingClientRect();
            videoWindow.style.setProperty('--video-controls-height', `${Math.round(bar.height)}px`);
            const free = bar.top - bodyTop;
            videoWindow.classList.toggle(
                'center-controls-cramped',
                free < centerControls.offsetHeight + 16
            );
        };

        if (typeof ResizeObserver === 'function') {
            const observer = new ResizeObserver(fit);
            observer.observe(videoBodyElement);
            observer.observe(customControls);
        } else {
            window.addEventListener('resize', fit);
        }
        fit();
    })();

    if (videoBodyElement && !videoBodyElement.dataset.clickBound) {
        videoBodyElement.dataset.clickBound = 'true';

        /*
         * Au doigt, l'appui sur l'image commande l'affichage des incrustations,
         * et rien d'autre : caché, il révèle ; visible, il efface.
         *
         * Elles s'effacent seules après quelques secondes, pour dégager l'image.
         * Mais un doigt ne survole pas : le seul geste qui les ramenait était
         * l'appui, celui-là même qui bascule la lecture. On tapait pour revoir
         * la barre et on mettait la musique en pause au passage — puis, la barre
         * revenue, plus rien ne permettait de la renvoyer avant la fin du délai.
         * L'appui devient donc l'interrupteur des deux sens, comme sur les
         * lecteurs mobiles, et la lecture reste au bouton qu'elle a dans la
         * barre. À la souris, rien ne change : un clic bascule toujours la
         * lecture, le survol suffisant à montrer les commandes.
         *
         * L'état est relevé sur `touchstart`, et pas dans le gestionnaire de
         * clic : un navigateur mobile émet un `mousemove` simulé entre les deux,
         * lequel a déjà rappelé les commandes. Au moment du clic, la réponse à
         * « étaient-elles visibles ? » a donc toujours changé.
         */
        let tapCameFromTouch = false;
        let controlsShownAtTouch = false;

        videoBodyElement.addEventListener('touchstart', () => {
            tapCameFromTouch = true;
            controlsShownAtTouch = videoWindow.classList.contains('user-active');
        }, { passive: true });

        videoBodyElement.addEventListener('click', (e) => {
            /*
             * Un clic sans appui qui le précède vient d'une souris. Le drapeau
             * se consomme ici, avant tout renvoi : un appui sur un bouton de la
             * barre sort juste en dessous, et le laisserait armé pour le clic
             * suivant — celui d'une souris, sur un appareil qui a les deux.
             */
            const fromTouch = tapCameFromTouch;
            const wasShown = controlsShownAtTouch;
            tapCameFromTouch = false;

            // Ignore clicks on interactive controls (buttons, volume slider, progress bar, header drag area)
            if (e.target.closest('.video-custom-controls') ||
                e.target.closest('.video-window-header') ||
                e.target.closest('button') ||
                e.target.closest('input') ||
                e.target.closest('.speed-pad-overlay')) {
                return;
            }

            const now = Date.now();
            const rect = videoBodyElement.getBoundingClientRect();
            const clickX = e.clientX - rect.left;
            const isRightHalf = clickX >= (rect.width / 2);

            if (now - lastVideoClickTime < 300) {
                // Double Click
                clearTimeout(videoClickTimer);
                videoClickTimer = null;
                lastVideoClickTime = 0;

                if (isRightHalf) {
                    if (typeof window.MusicPlayer.seekRelative === 'function') {
                        window.MusicPlayer.seekRelative(10000);
                    }
                    showVideoSeekIndicator('+10s', true);
                } else {
                    if (typeof window.MusicPlayer.seekRelative === 'function') {
                        window.MusicPlayer.seekRelative(-10000);
                    }
                    showVideoSeekIndicator('-10s', false);
                }
            } else {
                /*
                 * Simple clic — mais on attend 250 ms, le temps de savoir si un
                 * second suit. C'est ce délai qui rend le double appui possible,
                 * et il vaut pour l'effacement comme pour la lecture : sans lui,
                 * la barre se serait déjà retirée quand le second appui arrive
                 * pour reculer de dix secondes.
                 *
                 * L'appui qui vient de révéler les commandes n'a, lui, plus rien
                 * à faire : le `mousemove` simulé les a déjà rappelées.
                 */
                lastVideoClickTime = now;
                clearTimeout(videoClickTimer);
                videoClickTimer = setTimeout(() => {
                    lastVideoClickTime = 0;
                    if (fromTouch) {
                        if (wasShown) hideOverlayNow();
                        return;
                    }
                    if (typeof window.MusicPlayer.togglePlayPause === 'function') {
                        window.MusicPlayer.togglePlayPause();
                    }
                }, 250);
            }
        });
    }

    const videoBtnPlayPause = document.getElementById('video-btn-play-pause');
    const videoBtnPrev = document.getElementById('video-btn-prev');
    const videoBtnNext = document.getElementById('video-btn-next');
    const videoBtnStop = document.getElementById('video-btn-stop');
    const videoVolumeSlider = document.getElementById('video-volume-slider');
    const videoBtnMute = document.getElementById('video-btn-mute');
    const videoProgressWrapper = document.getElementById('video-progress-wrapper');
    const videoSpeedBtn = document.getElementById('video-speed-btn');
    const videoSpeedDropdown = document.getElementById('video-speed-dropdown');
    const videoBtnPip = document.getElementById('video-btn-pip');

    window.MusicPlayer.lastNonMuteVolume = window.MusicPlayer.lastNonMuteVolume || 70;
    window.MusicPlayer.lastMuteClickTime = window.MusicPlayer.lastMuteClickTime || 0;

    function handleVideoMuteClick(e) {
        if (e && typeof e.stopPropagation === 'function') {
            e.stopPropagation();
        }
        const now = Date.now();
        if (now - window.MusicPlayer.lastMuteClickTime < 500) {
            console.log('[Video Mute Diagnostic] Ignored by the global debounce (< 500ms)');
            return;
        }
        window.MusicPlayer.lastMuteClickTime = now;

        const state = window.MusicPlayer.state || {};
        const currentVol = (state.volume !== undefined && state.volume !== null) ? state.volume : 70;
        console.log('[Video Mute Diagnostic] Mute button (#video-btn-mute) TRIGGERED!', {
            currentVol,
            lastNonMuteVolume: window.MusicPlayer.lastNonMuteVolume
        });

        let newVol = 0;
        if (currentVol > 0) {
            window.MusicPlayer.lastNonMuteVolume = currentVol;
            newVol = 0;
        } else {
            newVol = window.MusicPlayer.lastNonMuteVolume || 70;
        }

        const logMsg = `Click on the mute button (#video-btn-mute). Current volume: ${currentVol}%, new computed volume: ${newVol}%`;
        console.log(`[Video Mute Diagnostic] ${logMsg}`);
        if (typeof window.MusicPlayer.sendWS === 'function') {
            window.MusicPlayer.sendWS({
                type: 'clientLog',
                data: { source: 'Video Mute', message: logMsg }
            });
        }

        if (typeof window.MusicPlayer.setVolume === 'function') {
            window.MusicPlayer.setVolume(newVol);
        } else {
            console.warn('[Video Mute Diagnostic] window.MusicPlayer.setVolume not found, using syncVideoVolume');
            window.MusicPlayer.syncVideoVolume(newVol);
        }
    }

    window.MusicPlayer.handleVideoMuteClick = handleVideoMuteClick;

    if (videoBtnPlayPause) {
        videoBtnPlayPause.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            console.log('[Video PlayPause Debug] #video-btn-play-pause clicked');
            if (typeof window.MusicPlayer.togglePlayPause === 'function') {
                console.log('[Video PlayPause Debug] Executing window.MusicPlayer.togglePlayPause()');
                window.MusicPlayer.togglePlayPause();
            } else {
                console.log('[Video PlayPause Debug] Fallback clicking #btn-play-pause');
                const btnPlayPause = document.getElementById('btn-play-pause');
                if (btnPlayPause) btnPlayPause.click();
            }
        });
    }

    if (videoBtnPrev) {
        videoBtnPrev.addEventListener('click', (e) => {
            e.stopPropagation();
            const btnPrev = document.getElementById('btn-previous');
            if (btnPrev && !btnPrev.disabled) {
                btnPrev.click();
            }
        });
    }

    if (videoBtnNext) {
        videoBtnNext.addEventListener('click', (e) => {
            e.stopPropagation();
            const btnSkip = document.getElementById('btn-skip');
            if (btnSkip && !btnSkip.disabled) {
                btnSkip.click();
            }
        });
    }

    /*
     * Le transport du centre délègue à son jumeau de la barre, qui délègue à
     * son tour à la carte « En cours de lecture ». Rien n'est réémis ici : la
     * commande garde une seule source, et un bouton désactivé ne fait rien —
     * `click()` sur un bouton inerte ne déclenche pas son écouteur.
     */
    for (const [centerId, twinId] of [
        ['video-center-btn-prev', 'video-btn-prev'],
        ['video-center-btn-play-pause', 'video-btn-play-pause'],
        ['video-center-btn-next', 'video-btn-next'],
    ]) {
        const button = document.getElementById(centerId);
        if (!button) continue;
        button.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const twin = document.getElementById(twinId);
            if (twin && !twin.disabled) twin.click();
        });
    }

    // L'arrêt est délégué au bouton de la carte « En cours de lecture » plutôt
    // que réémis ici : une seule source pour la commande, donc aucun risque de
    // divergence si son comportement évolue.
    if (videoBtnStop) {
        videoBtnStop.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const btnStop = document.getElementById('btn-stop');
            if (btnStop && !btnStop.disabled) {
                btnStop.click();
            }
        });
    }

    if (videoVolumeSlider) {
        videoVolumeSlider.addEventListener('input', (e) => {
            const val = parseInt(e.target.value, 10);
            console.log('[Video Volume Debug] videoVolumeSlider input:', val);
            if (typeof window.MusicPlayer.setVolume === 'function') {
                window.MusicPlayer.setVolume(val);
            } else {
                window.MusicPlayer.syncVideoVolume(val);
            }
        });
    }

    if (videoBtnMute && !videoBtnMute.dataset.muteListenerAttached) {
        videoBtnMute.dataset.muteListenerAttached = 'true';
        videoBtnMute.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            handleVideoMuteClick(e);
        });
    }

    if (videoProgressWrapper) {
        let isVideoProgressSeeking = false;

        function handleVideoSeekEvent(e) {
            const state = window.MusicPlayer.state;
            if (!state || !state.progress || !state.progress.totalMs) return;
            const rect = videoProgressWrapper.getBoundingClientRect();
            const clickX = e.clientX - rect.left;
            const width = rect.width;
            const percentage = Math.min(Math.max(clickX / width, 0), 1);
            const targetMs = Math.round(percentage * state.progress.totalMs);

            // Update video progress bar & labels
            window.MusicPlayer.syncVideoProgress(targetMs, true);

            // Synchronize main dashboard progress bar & time in real time
            const progressBar = document.getElementById('progress-bar');
            const timeCurrent = document.getElementById('time-current');
            if (progressBar) {
                progressBar.style.transform = `scaleX(${percentage})`;
                window.MusicPlayer.currentProgressRatio = percentage;
            }
            if (timeCurrent && typeof window.MusicPlayer.formatMs === 'function') {
                const speed = parseFloat((state.settings && state.settings.playbackSpeed) || '1.0');
                timeCurrent.textContent = window.MusicPlayer.formatMs(Math.round(targetMs / speed));
            }
            return targetMs;
        }

        videoProgressWrapper.addEventListener('mousedown', (e) => {
            const state = window.MusicPlayer.state;
            if (state && state.progress && state.progress.totalMs) {
                isVideoProgressSeeking = true;
                isVideoUserInteracting = true;
                window.MusicPlayer.isVideoUserInteracting = true;
                handleVideoSeekEvent(e);
            }
        });

        window.addEventListener('mousemove', (e) => {
            if (isVideoProgressSeeking) {
                handleVideoSeekEvent(e);
            }
        });

        window.addEventListener('mouseup', (e) => {
            if (isVideoProgressSeeking) {
                isVideoProgressSeeking = false;
                isVideoUserInteracting = false;
                window.MusicPlayer.isVideoUserInteracting = false;
                const targetMs = handleVideoSeekEvent(e);
                if (typeof targetMs === 'number' && typeof window.MusicPlayer.sendWS === 'function') {
                    window.MusicPlayer.sendWS({
                        type: 'seek',
                        data: { time: targetMs }
                    });
                }
            }
        });
    }

    // Speed Pad in video window is automatically initialized and synchronized via js/speedPad.js

    if (videoBtnPip) {
        videoBtnPip.addEventListener('click', async () => {
            const videoElement = document.getElementById('video-element');
            if (videoElement && !videoElement.classList.contains('hidden')) {
                try {
                    if (document.pictureInPictureElement) {
                        await document.exitPictureInPicture();
                    } else if (document.pictureInPictureEnabled) {
                        await videoElement.requestPictureInPicture();
                    }
                } catch (err) {}
            }
        });
    }

    // --- Fullscreen Toggle Logic (YouTube Web Architecture) ---
    const videoBtnFullscreen = document.getElementById('video-btn-fullscreen');
    const svgFsEnter = document.getElementById('video-svg-fullscreen-enter');
    const svgFsExit = document.getElementById('video-svg-fullscreen-exit');

    async function toggleVideoFullscreen() {
        if (!videoWindow) return;

        const isCurrentlyFs = document.body.classList.contains('video-fullscreen-active') ||
            videoWindow.classList.contains('is-fullscreen') ||
            !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement);

        if (isCurrentlyFs) {
            exitVideoFullscreen();
        } else {
            enterVideoFullscreen();
        }
    }

    async function enterVideoFullscreen() {
        if (!videoWindow) return;
        document.body.classList.add('video-fullscreen-active');
        videoWindow.classList.add('is-fullscreen');

        try {
            if (videoWindow.requestFullscreen) {
                await videoWindow.requestFullscreen();
            } else if (videoWindow.webkitRequestFullscreen) {
                await videoWindow.webkitRequestFullscreen();
            } else if (videoWindow.mozRequestFullScreen) {
                await videoWindow.mozRequestFullScreen();
            }
        } catch (err) {
            console.log('[Video] CSS fullscreen mode active');
        }
        updateFullscreenIcons();
    }

    async function exitVideoFullscreen() {
        document.body.classList.remove('video-fullscreen-active');
        if (videoWindow) videoWindow.classList.remove('is-fullscreen');

        try {
            if (document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement) {
                if (document.exitFullscreen) {
                    await document.exitFullscreen();
                } else if (document.webkitExitFullscreen) {
                    await document.webkitExitFullscreen();
                } else if (document.mozCancelFullScreen) {
                    await document.mozCancelFullScreen();
                }
            }
        } catch (err) {}

        restoreVideoWindowGeometry();
        updateFullscreenIcons();
    }

    function restoreVideoWindowGeometry() {
        if (!videoWindow) return;
        try {
            const savedPos = JSON.parse(localStorage.getItem('dashboardVideoWindowPos') || 'null');
            if (savedPos && savedPos.left !== undefined) {
                videoWindow.style.left = `${savedPos.left}px`;
                videoWindow.style.top = `${savedPos.top}px`;
                videoWindow.style.width = `${savedPos.width}px`;
                videoWindow.style.height = `${savedPos.height}px`;
                videoWindow.style.right = 'auto';
            } else if (typeof window.MusicPlayer.applyDefaultVideoWindowGeometry === 'function') {
                window.MusicPlayer.applyDefaultVideoWindowGeometry();
            }
        } catch (e) {
            if (typeof window.MusicPlayer.applyDefaultVideoWindowGeometry === 'function') {
                window.MusicPlayer.applyDefaultVideoWindowGeometry();
            }
        }
    }

    if (videoBtnFullscreen) {
        videoBtnFullscreen.addEventListener('click', toggleVideoFullscreen);
    }

    function updateFullscreenIcons() {
        const isFs = document.body.classList.contains('video-fullscreen-active') ||
            (videoWindow && videoWindow.classList.contains('is-fullscreen')) ||
            !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement);

        if (svgFsEnter && svgFsExit) {
            if (isFs) {
                svgFsEnter.classList.add('hidden');
                svgFsExit.classList.remove('hidden');
            } else {
                svgFsEnter.classList.remove('hidden');
                svgFsExit.classList.add('hidden');
            }
        }

        if (resizeHandle) {
            if (isFs) {
                resizeHandle.style.setProperty('display', 'none', 'important');
                resizeHandle.classList.add('hidden');
            } else {
                resizeHandle.style.removeProperty('display');
                resizeHandle.classList.remove('hidden');
            }
        }
    }

    function handleFullscreenChange() {
        const isNativeFs = !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement);
        if (!isNativeFs) {
            document.body.classList.remove('video-fullscreen-active');
            if (videoWindow) videoWindow.classList.remove('is-fullscreen');
            restoreVideoWindowGeometry();
        } else {
            document.body.classList.add('video-fullscreen-active');
            if (videoWindow) videoWindow.classList.add('is-fullscreen');
        }
        updateFullscreenIcons();
    }

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    document.addEventListener('mozfullscreenchange', handleFullscreenChange);

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' || e.keyCode === 27) {
            const isFs = document.body.classList.contains('video-fullscreen-active') ||
                (videoWindow && videoWindow.classList.contains('is-fullscreen')) ||
                !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement);

            if (isFs) {
                e.preventDefault();
                exitVideoFullscreen();
            }
        }
    });

    // --- YouTube Keyboard Shortcuts Listener ---
    document.addEventListener('keydown', (e) => {
        const tag = (e.target && e.target.tagName) ? e.target.tagName.toUpperCase() : '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) {
            return;
        }

        const toggleVideoMode = document.getElementById('toggle-video-mode');
        const isVideoActive = (toggleVideoMode && toggleVideoMode.checked) || (videoWindow && !videoWindow.classList.contains('hidden'));
        if (!isVideoActive) return;

        const key = e.key.toLowerCase();

        if (key === 'k' || key === ' ') {
            e.preventDefault();
            const btnPlayPause = document.getElementById('btn-play-pause');
            if (btnPlayPause) btnPlayPause.click();
        } else if (key === 'f') {
            e.preventDefault();
            toggleVideoFullscreen();
        } else if (key === 'm') {
            e.preventDefault();
            if (videoBtnMute) videoBtnMute.click();
        } else if (key === 'j') {
            e.preventDefault();
            if (typeof window.MusicPlayer.seekRelative === 'function') {
                window.MusicPlayer.seekRelative(-10000);
            }
        } else if (key === 'l') {
            e.preventDefault();
            if (typeof window.MusicPlayer.seekRelative === 'function') {
                window.MusicPlayer.seekRelative(10000);
            }
        } else if (e.key === 'ArrowLeft') {
            e.preventDefault();
            if (typeof window.MusicPlayer.seekRelative === 'function') {
                window.MusicPlayer.seekRelative(-10000);
            }
        } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            if (typeof window.MusicPlayer.seekRelative === 'function') {
                window.MusicPlayer.seekRelative(10000);
            }
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (typeof window.MusicPlayer.adjustVolumeRelative === 'function') {
                window.MusicPlayer.adjustVolumeRelative(5);
            }
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (typeof window.MusicPlayer.adjustVolumeRelative === 'function') {
                window.MusicPlayer.adjustVolumeRelative(-5);
            }
        } else if (/^[0-9]$/.test(e.key)) {
            e.preventDefault();
            if (typeof window.MusicPlayer.seekPercent === 'function') {
                window.MusicPlayer.seekPercent(parseInt(e.key, 10) * 10);
            }
        } else if (e.key === 'Home') {
            e.preventDefault();
            if (typeof window.MusicPlayer.seekPercent === 'function') {
                window.MusicPlayer.seekPercent(0);
            }
        } else if (e.key === 'End') {
            e.preventDefault();
            if (typeof window.MusicPlayer.seekPercent === 'function') {
                window.MusicPlayer.seekPercent(100);
            }
        } else if (e.key === '>' || (e.shiftKey && e.key === '.')) {
            e.preventDefault();
            if (typeof window.MusicPlayer.stepSpeed === 'function') {
                window.MusicPlayer.stepSpeed(1);
            }
        } else if (e.key === '<' || (e.shiftKey && e.key === ',')) {
            e.preventDefault();
            if (typeof window.MusicPlayer.stepSpeed === 'function') {
                window.MusicPlayer.stepSpeed(-1);
            }
        } else if (key === 'i') {
            e.preventDefault();
            if (videoBtnPip) videoBtnPip.click();
        } else if (e.shiftKey && key === 'n') {
            e.preventDefault();
            const btnSkip = document.getElementById('btn-skip');
            if (btnSkip && !btnSkip.disabled) btnSkip.click();
        } else if (e.shiftKey && key === 'p') {
            e.preventDefault();
            const btnPrev = document.getElementById('btn-previous');
            if (btnPrev && !btnPrev.disabled) btnPrev.click();
        }
    });

    // Video Opacity Slider Logic
    const videoOpacitySlider = document.getElementById('setting-video-opacity');
    const videoOpacityVal = document.getElementById('val-setting-video-opacity');

    function applyVideoOpacity(val) {
        const opacityNum = Math.max(20, Math.min(100, parseInt(val, 10) || 100));
        const alphaRatio = (opacityNum / 100).toFixed(2);
        videoWindow.style.setProperty('--video-bg-opacity', alphaRatio);
        if (videoOpacitySlider) videoOpacitySlider.value = opacityNum;
        if (videoOpacityVal) videoOpacityVal.textContent = `${opacityNum}%`;
        try {
            localStorage.setItem('dashboardVideoOpacity', opacityNum);
        } catch (e) {}
    }

    try {
        const savedOpacity = localStorage.getItem('dashboardVideoOpacity');
        if (savedOpacity !== null) {
            applyVideoOpacity(savedOpacity);
        } else {
            applyVideoOpacity(100);
        }
    } catch (e) {
        applyVideoOpacity(100);
    }

    if (videoOpacitySlider) {
        videoOpacitySlider.addEventListener('input', (e) => {
            applyVideoOpacity(e.target.value);
        });

        videoOpacitySlider.addEventListener('wheel', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const step = parseInt(videoOpacitySlider.step, 10) || 5;
            const min = parseInt(videoOpacitySlider.min, 10) || 20;
            const max = parseInt(videoOpacitySlider.max, 10) || 100;
            let current = parseInt(videoOpacitySlider.value, 10) || 100;

            if (e.deltaY < 0 || e.deltaX > 0) {
                current = Math.min(max, current + step);
            } else {
                current = Math.max(min, current - step);
            }
            applyVideoOpacity(current);
        }, { passive: false });
    }

    // Bring to front on click / interaction
    videoWindow.addEventListener('mousedown', () => {
        if (typeof window.MusicPlayer.bringToFront === 'function') {
            window.MusicPlayer.bringToFront(videoWindow);
        }
    });

    // Dragging Logic
    let isDragging = false;
    let dragStartX = 0, dragStartY = 0;
    let windowStartX = 0, windowStartY = 0;

    /**
     * Le glissement et le redimensionnement n'ont pas cours en mode tactile : la
     * fenêtre y est un tiroir ancré au bord droit, que css/touchDrawers.css
     * dimensionne lui-même.
     *
     * Il ne suffit pas de les laisser sans effet visible. Un navigateur mobile
     * simule `mousedown` puis `mouseup` sur un simple appui, et l'appui sur
     * l'en-tête aurait ouvert puis clos un glissement de longueur nulle — au
     * terme duquel la géométrie plein écran du tiroir aurait été enregistrée à
     * la place de celle, patiemment réglée, du bureau.
     */
    function isTouchMode() {
        const deviceMode = window.MusicPlayer.deviceMode;
        return !!(deviceMode && deviceMode.isTouch());
    }

    videoHeader.addEventListener('mousedown', (e) => {
        if (typeof window.MusicPlayer.bringToFront === 'function') {
            window.MusicPlayer.bringToFront(videoWindow);
        }
        if (isTouchMode()) return;
        if (e.target.closest('.video-control-btn') || e.target.closest('.video-header-opacity')) return;
        isDragging = true;
        dragStartX = e.clientX;
        dragStartY = e.clientY;

        const rect = videoWindow.getBoundingClientRect();
        windowStartX = rect.left;
        windowStartY = rect.top;

        videoWindow.style.right = 'auto';
        videoWindow.style.left = `${windowStartX}px`;
        videoWindow.style.top = `${windowStartY}px`;

        document.body.style.userSelect = 'none';
    });

    // Resizing Logic
    let isResizing = false;
    let resizeStartX = 0, resizeStartY = 0;
    let windowStartW = 0, windowStartH = 0;

    if (resizeHandle) {
        resizeHandle.addEventListener('mousedown', (e) => {
            if (isTouchMode()) return;
            e.preventDefault();
            e.stopPropagation();
            isResizing = true;
            resizeStartX = e.clientX;
            resizeStartY = e.clientY;

            const rect = videoWindow.getBoundingClientRect();
            windowStartW = rect.width;
            windowStartH = rect.height;

            document.body.style.userSelect = 'none';
        });
    }

    window.addEventListener('mousemove', (e) => {
        if (isDragging) {
            const dx = e.clientX - dragStartX;
            const dy = e.clientY - dragStartY;

            const newLeft = Math.max(0, Math.min(window.innerWidth - videoWindow.offsetWidth, windowStartX + dx));
            const newTop = Math.max(0, Math.min(window.innerHeight - videoWindow.offsetHeight, windowStartY + dy));

            videoWindow.style.left = `${newLeft}px`;
            videoWindow.style.top = `${newTop}px`;
        } else if (isResizing) {
            const dx = e.clientX - resizeStartX;
            const dy = e.clientY - resizeStartY;

            const newW = Math.max(300, Math.min(window.innerWidth * 0.9, windowStartW + dx));
            const newH = Math.max(200, Math.min(window.innerHeight * 0.9, windowStartH + dy));

            videoWindow.style.width = `${newW}px`;
            videoWindow.style.height = `${newH}px`;
        }
    });

    window.addEventListener('mouseup', () => {
        if (isDragging || isResizing) {
            isDragging = false;
            isResizing = false;
            document.body.style.userSelect = '';

            try {
                const rect = videoWindow.getBoundingClientRect();
                const pos = {
                    left: rect.left,
                    top: rect.top,
                    width: rect.width,
                    height: rect.height
                };
                localStorage.setItem('dashboardVideoWindowPos', JSON.stringify(pos));
            } catch (e) {}
        }
    });
};

/**
 * Branche la roue de qualité.
 *
 * Câblage à part de `setupFloatingVideoWindow`, qui se protège d'un double
 * appel par un drapeau : si cette fonction a déjà été exécutée ailleurs, tout
 * ce qu'on y ajouterait ne serait jamais branché. La roue a sa propre garde,
 * posée sur le bouton lui-même.
 */
function bindQualityWheel() {
    qualityWheels().forEach((button) => {
        if (button.dataset.qualityBound === 'true') return;
        button.dataset.qualityBound = 'true';

        button.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();

            const track = qualityWheelTrack();
            if (!track) {
                console.warn('[Video] Quality wheel with no usable track '
                    + '(nothing playing, or a local file).');
                return;
            }
            // Le menu s'ancre sur la roue pressée : ouvrir depuis l'une alors
            // que l'autre le tenait le déplace simplement, sans le refermer.
            window.MusicPlayer.showTrackQualityMenuForElement(button, track);
        });
    });
}

// Initialize floating video window setup on DOM ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        window.MusicPlayer.setupFloatingVideoWindow();
        bindQualityWheel();
    });
} else {
    window.MusicPlayer.setupFloatingVideoWindow();
    bindQualityWheel();
}
