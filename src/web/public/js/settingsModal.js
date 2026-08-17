/**
 * Advanced Settings Modal & Connected Servers Controller
 */

window.MusicPlayer = window.MusicPlayer || {};

let targetDeleteGuildId = null;
let targetDeleteGuildName = '';

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const TOAST_DEFAULTS = { inDuration: 0.35, holdDuration: 4, outDuration: 0.35 };

function getToastDurations() {
    const cfg = (window.MusicPlayer.dashboardSettings && window.MusicPlayer.dashboardSettings.toast) || {};
    const pick = (val, fallback) => {
        const num = parseFloat(val);
        return Number.isFinite(num) && num >= 0 ? num : fallback;
    };
    return {
        inDuration: pick(cfg.inDuration, TOAST_DEFAULTS.inDuration),
        holdDuration: pick(cfg.holdDuration, TOAST_DEFAULTS.holdDuration),
        outDuration: pick(cfg.outDuration, TOAST_DEFAULTS.outDuration)
    };
}

// État du cycle de vie de la notification : la mise en pause au survol impose de
// mémoriser le temps restant plutôt que de relancer un simple setTimeout.
const toastCycle = {
    hideTimer: null,
    removeTimer: null,
    remainingMs: 0,
    countdownStartedAt: 0,
    paused: false,
    message: ''
};

function clearToastTimers() {
    if (toastCycle.hideTimer) clearTimeout(toastCycle.hideTimer);
    if (toastCycle.removeTimer) clearTimeout(toastCycle.removeTimer);
    toastCycle.hideTimer = null;
    toastCycle.removeTimer = null;
}

function startToastCountdown(delayMs) {
    if (toastCycle.hideTimer) clearTimeout(toastCycle.hideTimer);
    toastCycle.remainingMs = delayMs;
    toastCycle.countdownStartedAt = Date.now();
    toastCycle.hideTimer = setTimeout(hideToast, delayMs);
}

function hideToast() {
    const toast = document.getElementById('error-toast');
    if (!toast) return;

    const { outDuration } = getToastDurations();
    toast.classList.remove('toast-in', 'toast-paused');
    // Redémarrage forcé de l'animation de sortie (reflow).
    toast.classList.remove('toast-out');
    void toast.offsetWidth;
    toast.classList.add('toast-out');

    if (toastCycle.removeTimer) clearTimeout(toastCycle.removeTimer);
    toastCycle.removeTimer = setTimeout(() => {
        toast.classList.add('hidden');
        toast.classList.remove('toast-out');
    }, Math.max(1, outDuration * 1000));
}

window.MusicPlayer.showToast = function(message) {
    const toast = document.getElementById('error-toast');
    const toastMessage = document.getElementById('error-toast-message');
    if (!toast || !toastMessage) return;

    const { inDuration, outDuration, holdDuration } = getToastDurations();
    toast.style.setProperty('--toast-in-duration', `${inDuration}s`);
    toast.style.setProperty('--toast-out-duration', `${outDuration}s`);

    toastMessage.textContent = message;
    toastCycle.message = message;

    const copyBtn = document.getElementById('btn-copy-toast');
    if (copyBtn) copyBtn.classList.remove('copied');

    clearToastTimers();

    // Rejoue l'animation d'entrée même si un toast est déjà affiché.
    toast.classList.remove('hidden', 'toast-out', 'toast-paused', 'toast-in');
    void toast.offsetWidth;
    toast.classList.add('toast-in');

    // Un nouveau message affiché sous le curseur reste figé : sinon il
    // disparaîtrait alors que la souris n'a jamais quitté la notification.
    const hovered = typeof toast.matches === 'function' && toast.matches(':hover');
    toastCycle.paused = hovered;

    if (hovered) {
        toastCycle.remainingMs = Math.max(1, holdDuration * 1000);
        toastCycle.countdownStartedAt = Date.now();
    } else {
        startToastCountdown(Math.max(1, holdDuration * 1000));
    }
};

/**
 * Garde la notification visible pendant un vrai plein écran.
 *
 * Un élément passé en plein écran est promu dans la « couche supérieure » du
 * navigateur : plus aucun z-index du document ne peut lui passer devant, si
 * haut soit-il. Le seul recours est de déplacer la notification à l'intérieur
 * de cet élément le temps du plein écran, puis de la rendre au document.
 *
 * Elle reste en position fixe : sa place à l'écran ne bouge pas.
 */
let parentToastOrigine = null;

function suivrePleinEcran() {
    const toast = document.getElementById('error-toast');
    if (!toast) return;

    const pleinEcran = document.fullscreenElement
        || document.webkitFullscreenElement
        || document.mozFullScreenElement
        || null;

    // Retour à l'emplacement d'origine, et non au corps du document : la
    // notification est déclarée en dernier dans son conteneur, et c'est de
    // cette place qu'elle tient son avantage sur les calques à z-index égal.
    const parent = pleinEcran || parentToastOrigine || document.body;
    if (toast.parentElement !== parent) {
        parent.appendChild(toast);
    }
}

window.MusicPlayer.setupToastInteractions = function() {
    const toast = document.getElementById('error-toast');
    if (!toast || toast.dataset.interactionsInit === 'true') return;
    toast.dataset.interactionsInit = 'true';

    parentToastOrigine = toast.parentElement;
    ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange'].forEach(evt => {
        document.addEventListener(evt, suivrePleinEcran);
    });

    toast.addEventListener('mouseenter', () => {
        if (toast.classList.contains('hidden')) return;
        toastCycle.paused = true;

        // Décompte du temps déjà écoulé pour le reprendre à la sortie du survol.
        // Sans compte à rebours actif, le survol intervient pendant la
        // disparition : le reliquat est remis à zéro pour repartir d'un délai plein.
        if (toastCycle.hideTimer) {
            const elapsed = Date.now() - toastCycle.countdownStartedAt;
            toastCycle.remainingMs = Math.max(0, toastCycle.remainingMs - elapsed);
        } else {
            toastCycle.remainingMs = 0;
        }
        clearToastTimers();

        // Une sortie déjà entamée est annulée : le toast redevient pleinement
        // visible tant que la souris reste dessus.
        toast.classList.remove('toast-in', 'toast-out');
        toast.classList.add('toast-paused');
    });

    toast.addEventListener('mouseleave', () => {
        if (!toastCycle.paused) return;
        toastCycle.paused = false;
        toast.classList.remove('toast-paused');

        const { holdDuration } = getToastDurations();
        // Si le survol a commencé pendant la disparition, on redonne un délai
        // complet plutôt qu'un reliquat nul qui ferait clignoter la notification.
        const remaining = toastCycle.remainingMs > 150
            ? toastCycle.remainingMs
            : Math.max(1, holdDuration * 1000);
        startToastCountdown(remaining);
    });

    const copyBtn = document.getElementById('btn-copy-toast');
    if (copyBtn) {
        copyBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const text = toastCycle.message || document.getElementById('error-toast-message')?.textContent || '';
            if (!text) return;

            const copied = await window.MusicPlayer.copierDansPressePapier(text);

            if (copied) {
                copyBtn.classList.add('copied');
                setTimeout(() => copyBtn.classList.remove('copied'), 1500);
            }
        });
    }
};

/**
 * Renseigne l'adresse du bouton « Inviter le bot ».
 *
 * Elle porte l'identifiant de l'application réellement connectée, que seul le
 * bot connaît : écrite en dur dans la page, elle a fini par désigner une autre
 * application et Discord répondait « application inconnue ».
 *
 * Elle est demandée à `/api/invite` plutôt que lue dans l'état diffusé : tant
 * que le bot n'a rejoint aucun serveur, aucun état n'est envoyé — or c'est
 * exactement la situation où ce bouton est le seul recours.
 */
window.MusicPlayer.chargerLienInvitation = async function() {
    const lien = document.getElementById('link-invite-bot');
    if (!lien || !lien.classList.contains('is-unavailable')) return;

    try {
        const reponse = await fetch('/api/invite', { credentials: 'same-origin' });
        if (!reponse.ok) return;
        const donnees = await reponse.json();
        if (!donnees || !donnees.inviteUrl) return;

        lien.href = donnees.inviteUrl;
        lien.classList.remove('is-unavailable');
    } catch (e) {
        // Bot pas encore prêt : la prochaine ouverture des réglages réessaiera.
    }
};

window.MusicPlayer.renderConnectedGuildsList = function() {
    const container = document.getElementById('settings-guilds-list');
    if (!container) return;
    container.innerHTML = '';

    const dashboardSettings = window.MusicPlayer.dashboardSettings;
    const translations = window.translations || {};
    const dict = translations[dashboardSettings.language] || translations['fr'] || {};
    // Une instance qui n'a rejoint aucun serveur ne reçoit aucun état : la liste
    // doit tout de même s'afficher, vide, avec le bouton d'invitation au-dessus.
    const state = window.MusicPlayer.state || {};

    if (!state.guilds || state.guilds.length === 0) {
        container.innerHTML = `<div style="text-align: center; color: var(--text-muted); font-size: 0.85rem; padding: 0.5rem;">${dict.no_connected_servers || 'Aucun serveur disponible'}</div>`;
        return;
    }

    state.guilds.forEach(guild => {
        const item = document.createElement('div');
        item.className = 'setting-guild-item';

        const isGuildActive = dashboardSettings.guildsActiveState[guild.id] !== false;

        item.innerHTML = `
            <div class="setting-guild-info">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 18px; height: 18px; color: var(--c-primary);"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"></rect><rect x="2" y="14" width="20" height="8" rx="2" ry="2"></rect><line x1="6" y1="6" x2="6.01" y2="6"></line><line x1="6" y1="18" x2="6.01" y2="18"></line></svg>
                <span>${escapeHtml(guild.name)}</span>
            </div>
            <div class="setting-guild-actions">
                <label class="switch">
                    <input type="checkbox" class="guild-active-toggle" data-guild-id="${guild.id}" ${isGuildActive ? 'checked' : ''}>
                    <span class="switch-slider"></span>
                </label>
                <button class="guild-trash-btn" data-guild-id="${guild.id}" data-guild-name="${escapeHtml(guild.name)}" data-tooltip="${window.MusicPlayer.t('tooltip_hold_delete_server')}">
                    <div class="guild-trash-progress"></div>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                </button>
            </div>
        `;

        const chk = item.querySelector('.guild-active-toggle');
        chk.addEventListener('change', () => {
            dashboardSettings.guildsActiveState[guild.id] = chk.checked;
            window.MusicPlayer.saveDashboardSettings();
            // Le sélecteur de salons doit suivre sur-le-champ : ce réglage est
            // local, aucun état ne sera diffusé pour l'y pousser.
            if (typeof window.MusicPlayer.rafraichirInterface === 'function') {
                window.MusicPlayer.rafraichirInterface();
            }
            const statusStr = chk.checked ? (dict.server_enabled || 'activé') : (dict.server_disabled || 'désactivé');
            window.MusicPlayer.showToast(window.MusicPlayer.t('toast_server_status_updated').replace('{name}', guild.name).replace('{status}', statusStr));
        });

        const trashBtn = item.querySelector('.guild-trash-btn');
        const progress = trashBtn.querySelector('.guild-trash-progress');
        let pressTimer = null;
        let startTime = 0;
        const holdDurationMs = 3000;

        function startHold(e) {
            e.preventDefault();
            startTime = Date.now();
            progress.style.width = '0%';
            
            pressTimer = setInterval(() => {
                const elapsed = Date.now() - startTime;
                const pct = Math.min(100, (elapsed / holdDurationMs) * 100);
                progress.style.width = `${pct}%`;

                if (elapsed >= holdDurationMs) {
                    cancelHold();
                    window.MusicPlayer.openServerDeleteConfirmModal(guild.id, guild.name);
                }
            }, 40);
        }

        function cancelHold() {
            if (pressTimer) {
                clearInterval(pressTimer);
                pressTimer = null;
            }
            progress.style.width = '0%';
        }

        trashBtn.addEventListener('mousedown', startHold);
        trashBtn.addEventListener('touchstart', startHold, { passive: false });
        trashBtn.addEventListener('mouseup', cancelHold);
        trashBtn.addEventListener('mouseleave', cancelHold);
        trashBtn.addEventListener('touchend', cancelHold);
        trashBtn.addEventListener('touchcancel', cancelHold);

        container.appendChild(item);
    });
};

window.MusicPlayer.openServerDeleteConfirmModal = function(guildId, guildName) {
    targetDeleteGuildId = guildId;
    targetDeleteGuildName = guildName;

    const confirmModal = document.getElementById('server-confirm-delete-modal');
    const modalTitle = confirmModal ? confirmModal.querySelector('h2') : null;
    const promptText = document.getElementById('server-delete-prompt-text');
    const inputName = document.getElementById('input-confirm-server-name');
    const btnConfirm = document.getElementById('btn-confirm-server-delete');
    const btnCancel = document.getElementById('btn-cancel-server-delete');

    const t = (key) => window.MusicPlayer.t ? window.MusicPlayer.t(key) : key;

    if (modalTitle) {
        modalTitle.textContent = t('server_delete_modal_title');
    }
    if (promptText) {
        promptText.innerHTML = t('server_delete_prompt').replace('{name}', escapeHtml(guildName));
    }
    if (inputName) {
        inputName.value = '';
        inputName.placeholder = t('server_name_placeholder');
    }
    if (btnConfirm) {
        btnConfirm.textContent = t('btn_confirm_deletion');
        btnConfirm.disabled = true;
    }
    if (btnCancel) {
        btnCancel.textContent = t('btn_cancel');
    }

    if (confirmModal) {
        confirmModal.classList.remove('hidden');
    }

    if (inputName && btnConfirm) {
        inputName.oninput = () => {
            btnConfirm.disabled = (inputName.value.trim() !== targetDeleteGuildName);
        };
    }

    if (btnConfirm) {
        btnConfirm.onclick = () => {
            if (inputName.value.trim() !== targetDeleteGuildName) return;
            if (confirmModal) confirmModal.classList.add('hidden');

            // Le bot quitte réellement le serveur : le masquer dans un coin du
            // localStorage le laissait membre, et il réapparaissait au premier
            // rechargement ou sur un autre appareil. Le serveur disparaîtra de
            // lui-même des listes au prochain état diffusé.
            if (typeof window.MusicPlayer.sendWS === 'function') {
                window.MusicPlayer.sendWS({ type: 'leaveGuild', data: { guildId: targetDeleteGuildId } });
            }

            // La préférence de visibilité n'a plus d'objet : la conserver
            // masquerait d'emblée le serveur s'il était réinvité un jour.
            delete window.MusicPlayer.dashboardSettings.guildsActiveState[targetDeleteGuildId];
            window.MusicPlayer.saveDashboardSettings();

            window.MusicPlayer.showToast(window.MusicPlayer.t('toast_server_removed').replace('{name}', targetDeleteGuildName));
            window.MusicPlayer.renderConnectedGuildsList();
        };
    }

    if (btnCancel) {
        btnCancel.onclick = () => {
            if (confirmModal) confirmModal.classList.add('hidden');
        };
    }
};

window.MusicPlayer.initSettingsModal = function() {
    const btnOpenSettings = document.getElementById('btn-open-settings');
    const settingsModal = document.getElementById('settings-modal');
    const btnCloseSettings = document.getElementById('btn-close-settings');
    const languageSelect = document.getElementById('setting-language-select');
    const dashboardSettings = window.MusicPlayer.dashboardSettings;

    if (typeof window.MusicPlayer.applyLanguage === 'function') {
        window.MusicPlayer.applyLanguage(dashboardSettings.language || 'fr');
    }

    window.MusicPlayer.setupToastInteractions();
    window.MusicPlayer.chargerLienInvitation();

    if (btnOpenSettings && settingsModal) {
        btnOpenSettings.addEventListener('click', (e) => {
            e.preventDefault();
            try {
                window.MusicPlayer.renderConnectedGuildsList();
            } catch (gErr) {
                console.error('[SettingsModal] Erreur render connected guilds :', gErr);
            }
            // Nouvelle tentative si le bot n'était pas encore prêt au chargement.
            window.MusicPlayer.chargerLienInvitation();
            settingsModal.classList.remove('hidden');
            localStorage.setItem('music_player_settings_open', 'true');
        });
    }

    if (btnCloseSettings && settingsModal) {
        btnCloseSettings.addEventListener('click', (e) => {
            e.preventDefault();
            settingsModal.classList.add('hidden');
            localStorage.setItem('music_player_settings_open', 'false');
        });
    }

    if (settingsModal) {
        settingsModal.addEventListener('click', (e) => {
            if (e.target === settingsModal) {
                settingsModal.classList.add('hidden');
                localStorage.setItem('music_player_settings_open', 'false');
            }
        });
    }

    if (localStorage.getItem('music_player_settings_open') === 'true' && settingsModal) {
        try {
            window.MusicPlayer.renderConnectedGuildsList();
        } catch (gErr) {}
        settingsModal.classList.remove('hidden');
    }

    try {
        if (languageSelect) {
            languageSelect.value = (dashboardSettings && dashboardSettings.language) || 'fr';
            try {
                const CustomSelectClass = window.CustomSelect || window.MusicPlayer.CustomSelect || (typeof CustomSelect === 'function' ? CustomSelect : null);
                if (CustomSelectClass && !languageSelect.dataset.customSelectInit) {
                    languageSelect.dataset.customSelectInit = 'true';
                    new CustomSelectClass(languageSelect);
                }
            } catch (csErr) {}
            languageSelect.addEventListener('change', () => {
                const newLang = languageSelect.value;
                dashboardSettings.language = newLang;
                window.MusicPlayer.saveDashboardSettings();
                if (typeof window.MusicPlayer.applyLanguage === 'function') {
                    window.MusicPlayer.applyLanguage(newLang);
                }
                window.MusicPlayer.renderConnectedGuildsList();
                const translations = window.translations || {};
                const dict = translations[newLang] || translations['fr'] || {};
                window.MusicPlayer.showToast(dict.lang_updated || 'Langue mise à jour');
            });
        }

        const rangeInputs = settingsModal ? settingsModal.querySelectorAll('.scroll-range') : [];
        rangeInputs.forEach(range => {
            const valSpan = document.getElementById(`val-${range.id}`) || range.nextElementSibling;
            
            if (range.id === 'setting-fadeout-duration') range.value = dashboardSettings.fadeoutDuration ?? 5;
            else if (range.id === 'setting-fadein-duration') range.value = dashboardSettings.fadeinDuration ?? 5;
            else if (range.id === 'setting-departure-delay') range.value = dashboardSettings.presenceDepartureDelay ?? 30;
            else if (range.id === 'setting-tooltip-delay') range.value = dashboardSettings.tooltipDelay ?? 0.25;
            else if (range.id === 'setting-toast-in') range.value = (dashboardSettings.toast && dashboardSettings.toast.inDuration) ?? 0.35;
            else if (range.id === 'setting-toast-hold') range.value = (dashboardSettings.toast && dashboardSettings.toast.holdDuration) ?? 4;
            else if (range.id === 'setting-toast-out') range.value = (dashboardSettings.toast && dashboardSettings.toast.outDuration) ?? 0.35;
            else if (range.id === 'setting-video-pos-x') range.value = (dashboardSettings.videoDefaultPos && dashboardSettings.videoDefaultPos.x) ?? 100;
            else if (range.id === 'setting-video-pos-y') range.value = (dashboardSettings.videoDefaultPos && dashboardSettings.videoDefaultPos.y) ?? 100;
            else if (range.id === 'setting-video-width') range.value = (dashboardSettings.videoDefaultSize && dashboardSettings.videoDefaultSize.width) ?? 440;
            else if (range.id === 'setting-video-height') range.value = (dashboardSettings.videoDefaultSize && dashboardSettings.videoDefaultSize.height) ?? 280;
            else if (range.id === 'hold-playlist') range.value = (dashboardSettings.holdDuration && dashboardSettings.holdDuration.playlist) ?? 1.5;
            else if (range.id === 'hold-queue') range.value = (dashboardSettings.holdDuration && dashboardSettings.holdDuration.queue) ?? 1.5;
            else if (range.id === 'hold-history') range.value = (dashboardSettings.holdDuration && dashboardSettings.holdDuration.history) ?? 1.5;
            else if (range.id === 'preload-queue-count') range.value = (dashboardSettings.preloading && dashboardSettings.preloading.queueCount) ?? 3;
            else if (range.id === 'preload-history-count') range.value = (dashboardSettings.preloading && dashboardSettings.preloading.historyCount) ?? 3;
            else if (range.id === 'preload-playlist-count') range.value = (dashboardSettings.preloading && dashboardSettings.preloading.playlistCount) ?? 3;

            const unit = (range.id.includes('duration') || range.id.includes('hold') || range.id.includes('delay') || range.id.startsWith('setting-toast-')) ? 's' : (range.id.includes('video') ? 'px' : '');
            if (valSpan) valSpan.textContent = `${range.value}${unit}`;

            range.addEventListener('input', () => {
                if (valSpan) valSpan.textContent = `${range.value}${unit}`;
                updateSettingsFromUI();
                if (range.id.includes('video') && typeof window.MusicPlayer.applyDefaultVideoWindowGeometry === 'function') {
                    window.MusicPlayer.applyDefaultVideoWindowGeometry();
                }
            });

            range.addEventListener('wheel', (e) => {
                e.preventDefault();
                const step = parseFloat(range.step) || 1;
                const min = parseFloat(range.min);
                const max = parseFloat(range.max);
                let val = parseFloat(range.value);
                if (e.deltaY < 0 || e.deltaX > 0) {
                    val = Math.min(max, val + step);
                } else {
                    val = Math.max(min, val - step);
                }
                range.value = val.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
                if (valSpan) valSpan.textContent = `${range.value}${unit}`;
                updateSettingsFromUI();
                if (range.id.includes('video') && typeof window.MusicPlayer.applyDefaultVideoWindowGeometry === 'function') {
                    window.MusicPlayer.applyDefaultVideoWindowGeometry();
                }
            }, { passive: false });
        });

        const resetBtns = settingsModal ? settingsModal.querySelectorAll('.btn-default-reset') : [];
        resetBtns.forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                const targetId = btn.getAttribute('data-target');
                const valId = btn.getAttribute('data-val-id');
                const defaultVal = btn.getAttribute('data-default');
                const unit = btn.getAttribute('data-unit') || '';

                const targetInput = document.getElementById(targetId);
                const valDisplay = document.getElementById(valId);

                if (targetInput) {
                    targetInput.value = defaultVal;
                    if (valDisplay) valDisplay.textContent = `${defaultVal}${unit}`;
                    updateSettingsFromUI();
                    if (targetId && targetId.includes('video') && typeof window.MusicPlayer.applyDefaultVideoWindowGeometry === 'function') {
                        window.MusicPlayer.applyDefaultVideoWindowGeometry();
                    }
                }
            });
        });

        const fadeoutCheck = document.getElementById('setting-fadeout-enable');
        const fadeinCheck = document.getElementById('setting-fadein-enable');
        const bounceLoad = document.getElementById('bounce-load');
        const bounceStyle = document.getElementById('bounce-style');
        const bounceTheme = document.getElementById('bounce-theme');
        const bounceGuild = document.getElementById('bounce-guild');
        const bounceChannel = document.getElementById('bounce-channel');
        const preloadEnable = document.getElementById('preload-enable');

        if (fadeoutCheck) fadeoutCheck.checked = !!dashboardSettings.fadeoutEnabled;
        if (fadeinCheck) fadeinCheck.checked = !!dashboardSettings.fadeinEnabled;
        const settingLogsEnable = document.getElementById('setting-logs-enable');
        if (settingLogsEnable) settingLogsEnable.checked = !!dashboardSettings.showLogsWindow;

        const logsWindow = document.getElementById('logs-floating-window');
        if (logsWindow && dashboardSettings.showLogsWindow) {
            logsWindow.classList.remove('hidden');
        }

        if (typeof window.MusicPlayer.setupFloatingLogsWindow === 'function') {
            window.MusicPlayer.setupFloatingLogsWindow();
        }

        if (bounceLoad) bounceLoad.checked = !!(dashboardSettings.bounce && dashboardSettings.bounce.load);
        if (bounceStyle) bounceStyle.checked = !!(dashboardSettings.bounce && dashboardSettings.bounce.style);
        if (bounceTheme) bounceTheme.checked = !!(dashboardSettings.bounce && dashboardSettings.bounce.theme);
        if (bounceGuild) bounceGuild.checked = !!(dashboardSettings.bounce && dashboardSettings.bounce.guild);
        if (bounceChannel) bounceChannel.checked = !!(dashboardSettings.bounce && dashboardSettings.bounce.channel);
        if (preloadEnable) preloadEnable.checked = !!(dashboardSettings.preloading && dashboardSettings.preloading.enabled);

        const allCheckboxes = settingsModal ? settingsModal.querySelectorAll('input[type="checkbox"]') : [];
        allCheckboxes.forEach(chk => {
            chk.addEventListener('change', () => {
                updateSettingsFromUI();
            });
        });

        function updateSettingsFromUI() {
            dashboardSettings.showLogsWindow = settingLogsEnable ? settingLogsEnable.checked : false;
            if (logsWindow) {
                if (dashboardSettings.showLogsWindow) {
                    logsWindow.classList.remove('hidden');
                } else {
                    logsWindow.classList.add('hidden');
                }
            }

            dashboardSettings.fadeoutEnabled = fadeoutCheck ? fadeoutCheck.checked : true;
            dashboardSettings.fadeoutDuration = parseFloat(document.getElementById('setting-fadeout-duration')?.value || 5);
            dashboardSettings.fadeinEnabled = fadeinCheck ? fadeinCheck.checked : false;
            dashboardSettings.fadeinDuration = parseFloat(document.getElementById('setting-fadein-duration')?.value || 5);
            // Zéro est un réglage valide — départ immédiat —, que le `||`
            // employé au-dessus effacerait au profit de la valeur par défaut.
            const delaiDepart = parseFloat(document.getElementById('setting-departure-delay')?.value);
            dashboardSettings.presenceDepartureDelay = Number.isFinite(delaiDepart) ? delaiDepart : 30;
            dashboardSettings.tooltipDelay = parseFloat(document.getElementById('setting-tooltip-delay')?.value || 0.25);

            dashboardSettings.toast = {
                inDuration: parseFloat(document.getElementById('setting-toast-in')?.value ?? 0.35),
                holdDuration: parseFloat(document.getElementById('setting-toast-hold')?.value ?? 4),
                outDuration: parseFloat(document.getElementById('setting-toast-out')?.value ?? 0.35)
            };

            dashboardSettings.videoDefaultPos = {
                x: parseInt(document.getElementById('setting-video-pos-x')?.value || 100, 10),
                y: parseInt(document.getElementById('setting-video-pos-y')?.value || 100, 10)
            };
            dashboardSettings.videoDefaultSize = {
                width: parseInt(document.getElementById('setting-video-width')?.value || 440, 10),
                height: parseInt(document.getElementById('setting-video-height')?.value || 280, 10)
            };

            dashboardSettings.bounce = {
                load: bounceLoad ? bounceLoad.checked : true,
                style: bounceStyle ? bounceStyle.checked : true,
                theme: bounceTheme ? bounceTheme.checked : true,
                guild: bounceGuild ? bounceGuild.checked : true,
                channel: bounceChannel ? bounceChannel.checked : true,
            };

            dashboardSettings.holdDuration = {
                playlist: parseFloat(document.getElementById('hold-playlist')?.value || 1.5),
                queue: parseFloat(document.getElementById('hold-queue')?.value || 1.5),
                history: parseFloat(document.getElementById('hold-history')?.value || 1.5)
            };

            dashboardSettings.preloading = {
                enabled: preloadEnable ? preloadEnable.checked : true,
                queueCount: Math.min(5, Math.max(0, parseInt(document.getElementById('preload-queue-count')?.value || 3, 10))),
                historyCount: Math.min(5, Math.max(0, parseInt(document.getElementById('preload-history-count')?.value || 3, 10))),
                playlistCount: Math.min(5, Math.max(0, parseInt(document.getElementById('preload-playlist-count')?.value || 3, 10)))
            };

            window.MusicPlayer.saveDashboardSettings();

            if (typeof window.MusicPlayer.sendWS === 'function') {
                window.MusicPlayer.sendWS({
                    type: 'updateSettings',
                    data: {
                        fadeinEnabled: dashboardSettings.fadeinEnabled,
                        fadeinDuration: dashboardSettings.fadeinDuration,
                        fadeoutEnabled: dashboardSettings.fadeoutEnabled,
                        fadeoutDuration: dashboardSettings.fadeoutDuration,
                        // La règle de présence est tenue par le serveur : le
                        // délai doit lui parvenir, le localStorage ne servant
                        // qu'à remettre le curseur en place à l'ouverture.
                        presenceDepartureDelay: dashboardSettings.presenceDepartureDelay,
                        // Le préchargement est appliqué par le serveur : sans cet
                        // envoi, les curseurs ne changeraient que le localStorage.
                        preloading: dashboardSettings.preloading
                    }
                });
            }
        }

        const btnResetAll = document.getElementById('btn-reset-all-settings');
        if (btnResetAll) {
            const progressEl = btnResetAll.querySelector('.btn-reset-progress');
            let resetHoldTimer = null;
            let resetStartTime = 0;
            const holdDurationMs = 1500;

            function startResetHold(e) {
                if (e.button !== undefined && e.button !== 0) return;
                e.preventDefault();
                resetStartTime = Date.now();
                if (progressEl) progressEl.style.width = '0%';
                btnResetAll.classList.add('holding');

                resetHoldTimer = setInterval(() => {
                    const elapsed = Date.now() - resetStartTime;
                    const pct = Math.min(100, (elapsed / holdDurationMs) * 100);
                    if (progressEl) progressEl.style.width = `${pct}%`;

                    if (elapsed >= holdDurationMs) {
                        cancelResetHold();
                        resetAllSettingsToDefault();
                    }
                }, 30);
            }

            function cancelResetHold() {
                if (resetHoldTimer) {
                    clearInterval(resetHoldTimer);
                    resetHoldTimer = null;
                }
                btnResetAll.classList.remove('holding');
                if (progressEl) progressEl.style.width = '0%';
            }

            btnResetAll.addEventListener('mousedown', startResetHold);
            btnResetAll.addEventListener('touchstart', startResetHold, { passive: false });
            btnResetAll.addEventListener('mouseup', cancelResetHold);
            btnResetAll.addEventListener('mouseleave', cancelResetHold);
            btnResetAll.addEventListener('touchend', cancelResetHold);
            btnResetAll.addEventListener('touchcancel', cancelResetHold);
            btnResetAll.addEventListener('click', (e) => e.preventDefault());
        }

        function resetAllSettingsToDefault() {
            const currentLang = dashboardSettings.language || 'fr';

            dashboardSettings.fadeoutEnabled = true;
            dashboardSettings.fadeoutDuration = 5;
            dashboardSettings.fadeinEnabled = false;
            dashboardSettings.fadeinDuration = 5;
            dashboardSettings.presenceDepartureDelay = 30;
            dashboardSettings.showLogsWindow = false;
            dashboardSettings.tooltipDelay = 0.25;
            dashboardSettings.toast = { ...TOAST_DEFAULTS };
            dashboardSettings.videoDefaultPos = { x: 100, y: 100 };
            dashboardSettings.videoDefaultSize = { width: 440, height: 280 };
            dashboardSettings.bounce = { load: true, style: true, theme: true, guild: true, channel: true };
            dashboardSettings.holdDuration = { playlist: 1.5, queue: 1.5, history: 1.5 };
            dashboardSettings.preloading = { enabled: true, queueCount: 3, historyCount: 3, playlistCount: 3 };
            dashboardSettings.language = currentLang;

            if (fadeoutCheck) fadeoutCheck.checked = true;
            if (fadeinCheck) fadeinCheck.checked = false;
            if (settingLogsEnable) settingLogsEnable.checked = false;
            if (logsWindow) logsWindow.classList.add('hidden');
            if (bounceLoad) bounceLoad.checked = true;
            if (bounceStyle) bounceStyle.checked = true;
            if (bounceTheme) bounceTheme.checked = true;
            if (bounceGuild) bounceGuild.checked = true;
            if (bounceChannel) bounceChannel.checked = true;
            if (preloadEnable) preloadEnable.checked = true;

            const setRange = (id, val, unit = '') => {
                const el = document.getElementById(id);
                const valSpan = document.getElementById(`val-${id}`) || el?.nextElementSibling;
                if (el) el.value = val;
                if (valSpan) valSpan.textContent = `${val}${unit}`;
            };

            setRange('setting-fadeout-duration', 5, 's');
            setRange('setting-fadein-duration', 5, 's');
            setRange('setting-departure-delay', 30, 's');
            setRange('setting-tooltip-delay', 0.25, 's');
            setRange('setting-toast-in', TOAST_DEFAULTS.inDuration, 's');
            setRange('setting-toast-hold', TOAST_DEFAULTS.holdDuration, 's');
            setRange('setting-toast-out', TOAST_DEFAULTS.outDuration, 's');
            setRange('setting-video-pos-x', 100, 'px');
            setRange('setting-video-pos-y', 100, 'px');
            setRange('setting-video-width', 440, 'px');
            setRange('setting-video-height', 280, 'px');
            setRange('hold-playlist', 1.5, 's');
            setRange('hold-queue', 1.5, 's');
            setRange('hold-history', 1.5, 's');
            setRange('preload-queue-count', 3, '');
            setRange('preload-history-count', 3, '');
            setRange('preload-playlist-count', 3, '');

            window.MusicPlayer.saveDashboardSettings();

            if (typeof window.MusicPlayer.applyDefaultVideoWindowGeometry === 'function') {
                window.MusicPlayer.applyDefaultVideoWindowGeometry();
            }

            if (typeof window.MusicPlayer.sendWS === 'function') {
                window.MusicPlayer.sendWS({
                    type: 'updateSettings',
                    data: {
                        fadeinEnabled: false,
                        fadeinDuration: 5,
                        fadeoutEnabled: true,
                        fadeoutDuration: 5,
                        presenceDepartureDelay: 30,
                        preloading: { enabled: true, queueCount: 3, historyCount: 3, playlistCount: 3 }
                    }
                });
            }

            const translations = window.translations || {};
            const dict = translations[currentLang] || translations['fr'] || {};
            if (typeof window.MusicPlayer.showToast === 'function') {
                window.MusicPlayer.showToast(dict.settings_reset_success || 'Tous les paramètres ont été réinitialisés aux valeurs par défaut');
            }
        }
    } catch (err) {
        console.error('[SettingsModal] Erreur initialisation des contrôles :', err);
    }
};

/**
 * Câble le sélecteur de mode de support des paramètres généraux.
 *
 * Le mode ne passe pas par le serveur : c'est une préférence d'appareil, rangée
 * dans le localStorage par js/deviceMode.js au même titre que le thème. Un
 * téléphone et un ordinateur qui pilotent le même bot gardent donc chacun le
 * sien.
 *
 * @param {HTMLSelectElement} select
 */
window.MusicPlayer.initDeviceModeSetting = function(select) {
    const deviceMode = window.MusicPlayer.deviceMode;
    if (!select || !deviceMode) return;

    const hint = document.getElementById('device-mode-hint');

    /**
     * En mode automatique, affiche ce que la détection a conclu : sans cela,
     * « Automatique » ne dit pas quelle mise en page est réellement appliquée.
     *
     * Les dimensions de la fenêtre suivent, quel que soit le choix. Elles sont
     * la seule chose que l'appareil ne peut pas travestir : c'est sur elles que
     * reposent le repli en une colonne et le classement téléphone / tablette,
     * et sur un téléphone on n'a aucun inspecteur pour les lire. Un tableau de
     * bord qui s'affiche de travers se diagnostique alors d'un coup d'œil.
     */
    const refreshHint = () => {
        if (!hint) return;

        const taille = `${window.innerWidth} × ${window.innerHeight}`;

        if (deviceMode.getChoice() !== 'auto') {
            hint.textContent = taille;
            return;
        }
        const t = window.MusicPlayer.t;
        const libelle = typeof t === 'function'
            ? t(`device_mode_${deviceMode.get()}`)
            : deviceMode.get();
        const gabarit = typeof t === 'function' ? t('device_mode_detected') : '';
        const detecte = gabarit && gabarit !== 'device_mode_detected'
            ? gabarit.replace('{mode}', libelle)
            : `→ ${libelle}`;
        hint.textContent = `${detecte} — ${taille}`;
    };

    select.value = deviceMode.getChoice();
    if (select._customSelect) select._customSelect._lastSignature = null;
    refreshHint();

    /*
     * Une rotation change les dimensions sans forcément changer le mode : sans
     * cette écoute, l'indication resterait celle de l'orientation précédente.
     * L'attente évite de la recalculer à chaque étape du redimensionnement.
     */
    let minuterieTaille = null;
    window.addEventListener('resize', () => {
        clearTimeout(minuterieTaille);
        minuterieTaille = setTimeout(refreshHint, 200);
    });

    select.addEventListener('change', () => {
        if (!deviceMode.set(select.value)) return;
        refreshHint();

        const t = window.MusicPlayer.t;
        if (typeof window.MusicPlayer.showToast === 'function' && typeof t === 'function') {
            const libelle = t(`device_mode_${deviceMode.get()}`);
            const gabarit = t('device_mode_applied');
            window.MusicPlayer.showToast(
                gabarit && gabarit !== 'device_mode_applied'
                    ? gabarit.replace('{mode}', libelle)
                    : libelle
            );
        }
    });

    // Une rotation d'écran en mode automatique change le mode effectif sans
    // toucher au choix : l'indication doit suivre.
    deviceMode.onChange(refreshHint);
};
