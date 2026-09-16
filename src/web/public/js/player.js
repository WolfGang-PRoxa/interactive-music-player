/**
 * Main Player UI Update & Timeline Controller
 */

window.MusicPlayer = window.MusicPlayer || {};

/**
 * Formate une durée en `m:ss`, ou `h:mm:ss` au-delà d'une heure.
 * Doit rester aligné sur src/utils/duration.js côté serveur.
 */
window.MusicPlayer.formatMs = function(ms) {
    // `isNaN` laissait passer l'infini — la durée d'un flux dont la fin n'est
    // pas encore connue —, et l'on écrivait « Infinity:NaN:NaN ».
    if (!Number.isFinite(ms) || ms <= 0) return '0:00';
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    const paddedSeconds = String(seconds).padStart(2, '0');
    if (hours > 0) {
        return `${hours}:${String(minutes).padStart(2, '0')}:${paddedSeconds}`;
    }
    return `${minutes}:${paddedSeconds}`;
};

/**
 * Convertit une durée textuelle (`ss`, `m:ss` ou `h:mm:ss`) en millisecondes.
 *
 * Le pendant de `formatMs`, et le miroir de `parseDurationToMs` côté serveur
 * (src/utils/duration.js) : les durées circulent en texte d'un bout à l'autre
 * du tableau de bord, et tout ce qui veut les additionner doit d'abord les
 * relire.
 *
 * Rend 0 pour ce qui ne se lit pas — une durée absente et une durée nulle se
 * confondent déjà en amont, où l'inconnu s'écrit « 0:00 ».
 */
window.MusicPlayer.parseDurationMs = function(text) {
    if (!text) return 0;
    const parts = String(text).split(':').map(Number);
    if (parts.length > 3 || parts.some(n => !Number.isFinite(n) || n < 0)) return 0;
    if (parts.length === 3) return ((parts[0] * 3600) + (parts[1] * 60) + parts[2]) * 1000;
    if (parts.length === 2) return ((parts[0] * 60) + parts[1]) * 1000;
    return parts[0] * 1000;
};

window.MusicPlayer.getAudioBufferPercent = function(audio) {
    if (!audio) return 0;
    if (audio.readyState >= 4) return 100;
    if (audio.duration && !isNaN(audio.duration) && audio.duration > 0 && audio.buffered && audio.buffered.length > 0) {
        try {
            const bufferedEnd = audio.buffered.end(audio.buffered.length - 1);
            return Math.min(100, Math.max(0, (bufferedEnd / audio.duration) * 100));
        } catch (e) {}
    }
    return 0;
};

window.MusicPlayer.updateBufferUI = function() {
    // La carte « En cours de lecture » et la fenêtre vidéo affichent la même
    // barre : le remplissage est calculé une fois et appliqué aux deux.
    const buffers = [
        document.getElementById('progress-buffer'),
        document.getElementById('video-progress-buffer')
    ].filter(Boolean);
    const progressBar = document.getElementById('progress-bar');
    const state = window.MusicPlayer.state;
    if (buffers.length === 0) return;

    const apply = (width) => buffers.forEach(b => { b.style.width = width; });

    if (!state || !state.currentTrack) {
        apply('0%');
        return;
    }

    const isPersonal = state.settings.broadcastMode === 'personal';
    // La barre de lecture est pilotée par son échelle, jamais par sa largeur :
    // c'est le ratio publié qui dit où elle en est. La lire dans `style.width`
    // renvoyait toujours zéro, et le tampon pouvait donc s'afficher en retrait
    // de la lecture elle-même.
    const fillPercent = (window.MusicPlayer.currentProgressRatio || 0) * 100;
    const activeAudio = window.MusicPlayer.activeAudio;

    if (isPersonal && activeAudio && activeAudio.src) {
        // Diffusion personnelle : le son passe par le navigateur, la barre suit
        // donc la mise en mémoire tampon réelle de l'élément audio.
        const bufferPercent = window.MusicPlayer.getAudioBufferPercent(activeAudio);
        apply(`${Math.max(bufferPercent, fillPercent)}%`);
    } else {
        // Diffusion « tout le monde » : rien ne transite par le navigateur, il n'y
        // a aucun tampon local à représenter. Ce que la barre indique alors, c'est
        // le préchargement de la piste côté bot — la même information que la barre
        // verte des éléments de la file d'attente.
        const track = state.currentTrack;
        const preloadPercent = track.isPreloaded
            ? 100
            : (parseFloat(track.preloadProgress) || 0);
        apply(`${Math.max(preloadPercent, fillPercent)}%`);
    }
};

function isLocalFile(track) {
    if (!track) return false;
    if (track.queryType === 'file') return true;
    const url = (track.url || '').toLowerCase();
    if (url.includes('/uploads/') || url.includes('data\\uploads') || url.includes('data/uploads')) return true;
    if (/^[a-z]:[\\\/]/i.test(url)) return true;
    if (url.startsWith('file://')) return true;
    return false;
}

/**
 * Explique une lecture qui n'avance pas parce que le salon vocal est désert.
 *
 * Le bot ne s'installe pas dans un salon que personne n'écoute : la lecture est
 * alors mise de côté, position figée, jusqu'à ce que quelqu'un s'y connecte.
 * Vu du tableau de bord, cela ressemblait à un lecteur bloqué — d'autant que
 * l'état renvoyé reste « en cours de lecture ».
 *
 * @param {{enLecture: boolean, salon: string|null}|null} attente
 * @param {(key: string) => string} t
 */
function showListenerWait(wait, t) {
    const notice = document.getElementById('playback-wait-notice');
    const text = document.getElementById('playback-wait-text');
    if (!notice || !text) return;

    if (!wait) {
        notice.classList.add('hidden');
        return;
    }

    const channelName = wait.channelName || t('wait_listener_channel_fallback');
    const key = wait.playing ? 'wait_listener_playing' : 'wait_listener_paused';
    const message = t(key).replace('{salon}', channelName);
    if (text.textContent !== message) text.textContent = message;
    notice.classList.remove('hidden');
}

// Gère l'identité de la piste, le disque, les boutons médias et les réglages liés —
// PAS la progression/temps ni le buffer (gérés par app.js car dépendants du seek/mix/vidéo)
window.MusicPlayer.updatePlayerCard = function(displayedTrack) {
    const trackTitle = document.getElementById('track-title');
    const trackAuthor = document.getElementById('track-author');
    const trackThumbnail = document.getElementById('track-thumbnail');
    const placeholderCover = document.getElementById('placeholder-cover');
    const iconDisc = document.querySelector('.icon-disc');
    const svgPlay = document.getElementById('svg-play');
    const svgPause = document.getElementById('svg-pause');
    const videoSvgPlay = document.getElementById('video-svg-play');
    const videoSvgPause = document.getElementById('video-svg-pause');
    const btnPrevious = document.getElementById('btn-previous');
    const btnSkip = document.getElementById('btn-skip');
    const volumeRange = document.getElementById('volume-range');
    const volumeVal = document.getElementById('volume-val');
    const broadcastModeSelect = document.getElementById('broadcast-mode-select');
    const downloadWrapper = document.getElementById('download-track-wrapper');
    const state = window.MusicPlayer.state;
    const t = window.MusicPlayer.t;

    // Bouton & Format de Téléchargement (Visibles uniquement si la musique ne provient pas du PC local)
    if (downloadWrapper) {
        if (displayedTrack && !isLocalFile(displayedTrack)) {
            downloadWrapper.classList.remove('hidden');
            
            const videoGroup = document.getElementById('download-format-group-video');
            const formatSelect = document.getElementById('download-format-select');
            
            if (videoGroup) {
                const isVideo = displayedTrack.queryType === 'youtubeVideo' || 
                                (displayedTrack.url && displayedTrack.url.includes('youtu'));
                
                if (isVideo) {
                    videoGroup.style.display = '';
                    videoGroup.disabled = false;
                } else {
                    videoGroup.style.display = 'none';
                    videoGroup.disabled = true;
                    if (formatSelect && (formatSelect.value === 'mp4' || formatSelect.value.startsWith('mp4_'))) {
                        formatSelect.value = 'mp3_320';
                    }
                }
                
                if (formatSelect && formatSelect._lastIsVideo !== isVideo) {
                    formatSelect._lastIsVideo = isVideo;
                    if (formatSelect._customSelect) {
                        formatSelect._customSelect.sync();
                    }
                }
            }
        } else {
            downloadWrapper.classList.add('hidden');
        }
    }

    // Now Playing
    if (displayedTrack) {
        if (trackTitle && trackTitle.textContent !== displayedTrack.title) trackTitle.textContent = displayedTrack.title;
        if (trackAuthor && trackAuthor.textContent !== displayedTrack.author) trackAuthor.textContent = displayedTrack.author;
        if (displayedTrack.thumbnail) {
            if (trackThumbnail && trackThumbnail.src !== displayedTrack.thumbnail) trackThumbnail.src = displayedTrack.thumbnail;
            if (trackThumbnail) trackThumbnail.classList.remove('hidden');
            if (placeholderCover) placeholderCover.classList.add('hidden');
        } else {
            if (trackThumbnail) trackThumbnail.classList.add('hidden');
            if (placeholderCover) placeholderCover.classList.remove('hidden');
        }
    } else {
        const idleTitle = t('no_track_playing');
        const idleAuthor = t('play_from_search');
        if (trackTitle && trackTitle.textContent !== idleTitle) trackTitle.textContent = idleTitle;
        if (trackAuthor && trackAuthor.textContent !== idleAuthor) trackAuthor.textContent = idleAuthor;
        if (trackThumbnail) trackThumbnail.classList.add('hidden');
        if (placeholderCover) placeholderCover.classList.remove('hidden');
    }

    // Lecture immobile faute d'auditeur dans le salon vocal : elle est bien
    // déclarée en cours — elle repartira toute seule —, mais rien n'avance. Le
    // dire, et suspendre ce qui figure le mouvement : une pochette qui tourne
    // au-dessus d'une barre arrêtée ne laisse imaginer qu'une panne.
    const listenerWait = state.listenerWait || null;
    showListenerWait(listenerWait, t);
    const playbackVisible = state.isPlaying && !state.isPaused && !listenerWait;

    // Disc rotation & Thumbnail animation state
    const nowPlayingThumbnail = document.getElementById('now-playing-thumbnail');
    if (nowPlayingThumbnail) {
        if (playbackVisible) nowPlayingThumbnail.classList.add('playing');
        else nowPlayingThumbnail.classList.remove('playing');
    }
    if (iconDisc) {
        if (playbackVisible) iconDisc.classList.add('playing');
        else iconDisc.classList.remove('playing');
    }

    // Media buttons (dashboard + fenêtre vidéo flottante)
    if (state.isPlaying && !state.isPaused) {
        if (svgPlay) svgPlay.classList.add('hidden');
        if (svgPause) svgPause.classList.remove('hidden');
        if (videoSvgPlay) videoSvgPlay.classList.add('hidden');
        if (videoSvgPause) videoSvgPause.classList.remove('hidden');
    } else {
        if (svgPlay) svgPlay.classList.remove('hidden');
        if (svgPause) svgPause.classList.add('hidden');
        if (videoSvgPlay) videoSvgPlay.classList.remove('hidden');
        if (videoSvgPause) videoSvgPause.classList.add('hidden');
    }

    // Boutons Précédent / Suivant (traduits)
    if (btnPrevious && btnSkip) {
        if (state.isTransitioning) {
            btnPrevious.disabled = true;
            btnPrevious.dataset.tooltip = t('tooltip_loading_track');
            btnSkip.disabled = true;
            btnSkip.dataset.tooltip = t('tooltip_loading_track');
        } else {
            // Le bouton doit annoncer ce que le serveur fera, et lui ne
            // consulte qu'une source à la fois : l'index de la playlist quand
            // c'en est une, l'historique quand la lecture vient de la file.
            // Les additionner promettait un retour en arrière que la playlist
            // ne pouvait pas tenir — le clic ne faisait alors rien de visible.
            const sourceIsPlaylist = typeof state.activePlaybackSource === 'string'
                && state.activePlaybackSource.startsWith('playlist_');

            const canGoBack = sourceIsPlaylist
                ? (typeof state.playlistCurrentIndex === 'number'
                    && (state.playlistCurrentIndex > 0 || !!state.loopPlaylist))
                : !!(state.history && state.history.length > 0);

            if (canGoBack) {
                btnPrevious.disabled = false;
                btnPrevious.dataset.tooltip = t('tooltip_previous');
            } else {
                btnPrevious.disabled = true;
                // Même libellé que celui déclaré dans le HTML : deux clés pour
                // un même état laissaient croire à deux situations distinctes.
                btnPrevious.dataset.tooltip = t('tooltip_previous_disabled');
            }
            if (state.currentTrack) {
                btnSkip.disabled = false;
                btnSkip.dataset.tooltip = t('tooltip_video_next');
            } else {
                btnSkip.disabled = true;
                btnSkip.dataset.tooltip = t('tooltip_no_track_playing');
            }
        }
    }

    if (typeof window.MusicPlayer.syncVideoOverlayButtons === 'function') {
        window.MusicPlayer.syncVideoOverlayButtons(state);
    }

    // Boutons de mode de lecture
    const repeatMode = state.repeatMode || 0;
    // Le bouclage de playlist n'a de sens que si la source en est une : sur la
    // file d'attente, l'option n'est pas seulement inutile, elle n'aurait
    // aucun effet observable. Le réglage est conservé mais tenu pour inactif,
    // de sorte qu'un aller-retour vers la file laisse toujours un mode actif.
    const sourceIsPlaylist = typeof state.activePlaybackSource === 'string'
        && state.activePlaybackSource.startsWith('playlist_');
    const loopActive = !!state.loopPlaylist && sourceIsPlaylist;
    // La lecture aléatoire, elle, vaut pour les deux sources : une file et une
    // playlist se parcourent au hasard de la même façon.
    const shuffleActive = !!state.shuffle;

    document.querySelectorAll('.mode-switch-btn').forEach(btn => {
        const btnMode = btn.getAttribute('data-mode');

        if (btnMode === 'loop_playlist') {
            btn.classList.toggle('hidden', !sourceIsPlaylist);
        }

        if (btnMode === 'loop_track') btn.classList.toggle('active', repeatMode === 1);
        else if (btnMode === 'loop_playlist') btn.classList.toggle('active', loopActive);
        else if (btnMode === 'shuffle') btn.classList.toggle('active', shuffleActive);
        else if (btnMode === 'default') {
            btn.classList.toggle('active', repeatMode !== 1 && !loopActive && !shuffleActive);
        } else btn.classList.remove('active');
    });

    // Le mode aléatoire tire le titre suivant au moment de l'enchaînement :
    // le bouton invite alors à tout précharger. Voir js/shuffleHint.js.
    if (typeof window.MusicPlayer.refreshShuffleHint === 'function') {
        window.MusicPlayer.refreshShuffleHint();
    }

    // Slider de volume
    if (volumeRange && volumeVal && document.activeElement !== volumeRange) {
        volumeRange.value = state.volume;
        volumeVal.textContent = `${state.volume}%`;
    }

    // Sélecteur de mode de diffusion (natif + custom)
    if (broadcastModeSelect && document.activeElement !== broadcastModeSelect) {
        broadcastModeSelect.value = state.settings.broadcastMode;
        if (window.MusicPlayer.customBroadcastSelect) {
            window.MusicPlayer.customBroadcastSelect.sync();
        }
    }
};

/**
 * Marque tout de suite le mode qu'on vient de choisir, avant la réponse du serveur.
 *
 * Les règles sont celles de `handleSetPlayMode` (websocket/handlers/playbackHandlers.js),
 * et l'écart entre les deux ne durerait qu'un aller-retour : c'est l'état diffusé
 * qui fait foi, et il repeint tout quelques millisecondes plus tard. L'aperçu
 * n'existe que pour que le bouton réponde au doigt sans attendre.
 *
 * Trois modes s'excluent — suivie, piste en boucle, playlist en boucle — et
 * l'aléatoire s'ajoute par-dessus le bouclage de playlist. Son bouton allume et
 * n'éteint pas, comme les trois autres : on le quitte par « lecture suivie » ou
 * par la répétition de la piste, avec laquelle il ne tient pas.
 *
 * Les deux sélecteurs de la page sont peints ensemble, celui de la carte comme
 * celui de la fenêtre vidéo : on n'en touche qu'un, ils disent tous les deux la
 * même chose.
 *
 * @param {string} mode Le `data-mode` du bouton cliqué.
 */
window.MusicPlayer.previewPlayMode = function(mode) {
    const etait = (nom) => {
        const btn = document.querySelector(`.mode-switch-btn[data-mode="${nom}"]`);
        return Boolean(btn && btn.classList.contains('active'));
    };

    let aleatoire = etait('shuffle');
    let parcours = etait('loop_track') ? 'loop_track'
        : (etait('loop_playlist') ? 'loop_playlist' : 'default');

    if (mode === 'shuffle') {
        aleatoire = true;
        if (parcours === 'loop_track') parcours = 'default';
    } else {
        parcours = mode;
        if (mode === 'loop_track' || mode === 'default') aleatoire = false;
    }

    document.querySelectorAll('.mode-switch-btn').forEach(btn => {
        const nom = btn.getAttribute('data-mode');
        if (nom === 'shuffle') btn.classList.toggle('active', aleatoire);
        // « Lecture suivie » n'est allumée que lorsque rien d'autre ne l'est :
        // elle nomme l'absence de mode, et l'aléatoire en est un. Cette clause
        // est celle de la peinture d'après l'état, quelques lignes plus haut —
        // sans elle, le bouton restait allumé le temps de l'aller-retour, et
        // clignotait.
        else if (nom === 'default') btn.classList.toggle('active', parcours === 'default' && !aleatoire);
        else btn.classList.toggle('active', nom === parcours);
    });

    if (typeof window.MusicPlayer.refreshShuffleHint === 'function') {
        window.MusicPlayer.refreshShuffleHint({ shuffle: aleatoire });
    }
};

// Controller de mode d'animation de la pochette "En cours de lecture"
(function() {
    const MODES = ['pulse', 'spin', 'none'];
    const MODE_ICONS = {
        'pulse': `<svg class="anim-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline></svg>`,
        'spin': `<svg class="anim-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M12 3a9 9 0 0 1 9 9"></path></svg>`,
        'none': `<svg class="anim-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect></svg>`
    };

    let currentMode = localStorage.getItem('nowPlayingAnimMode') || 'pulse';

    function applyThumbnailAnimMode(mode) {
        currentMode = mode;
        localStorage.setItem('nowPlayingAnimMode', mode);

        const thumbnailWrapper = document.getElementById('now-playing-thumbnail');
        if (thumbnailWrapper) {
            thumbnailWrapper.classList.remove('anim-mode-spin', 'anim-mode-pulse', 'anim-mode-none');
            thumbnailWrapper.classList.add(`anim-mode-${mode}`);
        }

        const btn = document.getElementById('btn-toggle-thumbnail-anim');
        if (btn) {
            btn.setAttribute('data-mode', mode);
            const t = window.MusicPlayer.t || (k => k);
            const labelKey = `anim_mode_${mode}`;
            const tooltipKey = `tooltip_anim_${mode}`;
            btn.setAttribute('data-tooltip', t(tooltipKey));
            btn.setAttribute('data-i18n-tooltip', tooltipKey);
            btn.innerHTML = `${MODE_ICONS[mode] || MODE_ICONS['spin']}<span class="anim-mode-label" data-i18n="${labelKey}">${t(labelKey)}</span>`;
        }
    }

    function initThumbnailAnimToggle() {
        const btn = document.getElementById('btn-toggle-thumbnail-anim');
        if (btn && !btn._bound) {
            btn._bound = true;
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                const idx = MODES.indexOf(currentMode);
                const nextMode = MODES[(idx + 1) % MODES.length];
                applyThumbnailAnimMode(nextMode);
            });
        }
        applyThumbnailAnimMode(currentMode);
    }

    window.MusicPlayer.applyThumbnailAnimMode = applyThumbnailAnimMode;
    window.MusicPlayer.initThumbnailAnimToggle = initThumbnailAnimToggle;

    function initDownloadTrackBtn() {
        const btnDownload = document.getElementById('btn-download-track');
        if (btnDownload && !btnDownload._bound) {
            btnDownload._bound = true;
            btnDownload.addEventListener('click', (e) => {
                e.preventDefault();
                const state = window.MusicPlayer.state;
                if (!state || !state.currentTrack || !state.currentTrack.url) return;

                const formatSelect = document.getElementById('download-format-select');
                const selectedFormat = formatSelect ? (formatSelect.value || 'mp3') : 'mp3';

                const downloadUrl = `/api/download?guildId=${state.guildId}&trackUrl=${encodeURIComponent(state.currentTrack.url)}&format=${encodeURIComponent(selectedFormat)}`;
                const a = document.createElement('a');
                a.href = downloadUrl;
                a.download = `${state.currentTrack.title || 'morceau'}.${selectedFormat}`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
            });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            initThumbnailAnimToggle();
            initDownloadTrackBtn();
        });
    } else {
        initThumbnailAnimToggle();
        initDownloadTrackBtn();
    }
})();