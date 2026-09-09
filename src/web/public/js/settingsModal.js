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

/**
 * Suspend le compte à rebours et retient ce qu'il en restait.
 *
 * Deux gestes le demandent : la souris posée sur la notification, et le doigt
 * qui la saisit pour la balayer. Sans compte à rebours en cours — le survol
 * intervient pendant la disparition —, le reliquat est remis à zéro pour que la
 * reprise reparte d'un délai plein.
 */
function holdToastCountdown() {
    if (toastCycle.hideTimer) {
        const elapsed = Date.now() - toastCycle.countdownStartedAt;
        toastCycle.remainingMs = Math.max(0, toastCycle.remainingMs - elapsed);
    } else {
        toastCycle.remainingMs = 0;
    }
    clearToastTimers();
    toastCycle.paused = true;
}

/** Reprend le compte à rebours là où `holdToastCountdown` l'a laissé. */
function releaseToastCountdown() {
    if (!toastCycle.paused) return;
    toastCycle.paused = false;

    const { holdDuration } = getToastDurations();
    // Un reliquat quasi nul ferait clignoter la notification : elle disparaîtrait
    // dans l'instant où on la relâche. On lui redonne alors un délai complet.
    const remaining = toastCycle.remainingMs > 150
        ? toastCycle.remainingMs
        : Math.max(1, holdDuration * 1000);
    startToastCountdown(remaining);
}

function hideToast() {
    const toast = document.getElementById('error-toast');
    if (!toast) return;

    const { outDuration } = getToastDurations();
    // `toast-settling` est retiré ici et non au relâchement du doigt : il coupe
    // les animations le temps du retour en place, et une notification qu'on
    // aurait touchée sans la chasser s'en irait ensuite d'un coup, sans son
    // fondu de sortie.
    toast.classList.remove('toast-in', 'toast-paused', 'toast-settling');
    toast.style.transform = '';
    toast.style.opacity = '';
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

/**
 * Affiche une notification, éventuellement accompagnée d'une action.
 *
 * L'action est un bouton posé dans la notification elle-même : c'est le seul
 * endroit où l'on puisse répondre à ce qu'elle annonce sans avoir à retrouver
 * la commande ailleurs dans la page. Elle est facultative, et la grande
 * majorité des appels n'en passe pas.
 *
 * Le bouton est unique et resservi d'une notification à l'autre : son écouteur
 * précédent porte l'action de la précédente, et doit partir avec elle — sans
 * quoi un clic déclencherait toutes celles qui l'ont précédé.
 *
 * @param {string} message
 * @param {{ label: string, onClick: function }} [action] - Bouton d'action.
 */
window.MusicPlayer.showToast = function(message, action) {
    const toast = document.getElementById('error-toast');
    const toastMessage = document.getElementById('error-toast-message');
    if (!toast || !toastMessage) return;

    const actionBtn = document.getElementById('btn-toast-action');
    if (actionBtn) {
        if (actionBtn._toastHandler) {
            actionBtn.removeEventListener('click', actionBtn._toastHandler);
            actionBtn._toastHandler = null;
        }

        const usable = action && action.label && typeof action.onClick === 'function';
        actionBtn.classList.toggle('hidden', !usable);
        actionBtn.textContent = usable ? action.label : '';

        if (usable) {
            actionBtn._toastHandler = () => {
                // La notification se retire d'elle-même : son message ne vaut
                // plus rien une fois qu'on a répondu à ce qu'il proposait.
                hideToast();
                action.onClick();
            };
            actionBtn.addEventListener('click', actionBtn._toastHandler);
        }
    }

    const { inDuration, outDuration, holdDuration } = getToastDurations();
    toast.style.setProperty('--toast-in-duration', `${inDuration}s`);
    toast.style.setProperty('--toast-out-duration', `${outDuration}s`);

    toastMessage.textContent = message;
    toastCycle.message = message;

    const copyBtn = document.getElementById('btn-copy-toast');
    if (copyBtn) copyBtn.classList.remove('copied');

    clearToastTimers();

    // Un balayage laisse la notification déplacée et transparente ; le message
    // suivant s'afficherait à sa place et dans son état. Le geste en cours est
    // abandonné du même coup : il visait le message qu'on vient de remplacer.
    toastSwipe = null;
    toast.style.transform = '';
    toast.style.opacity = '';

    // Rejoue l'animation d'entrée même si un toast est déjà affiché.
    toast.classList.remove('hidden', 'toast-out', 'toast-paused', 'toast-in', 'toast-swiping', 'toast-settling');
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
let toastOriginParent = null;

function watchFullscreen() {
    const toast = document.getElementById('error-toast');
    if (!toast) return;

    const fullscreen = document.fullscreenElement
        || document.webkitFullscreenElement
        || document.mozFullScreenElement
        || null;

    // Retour à l'emplacement d'origine, et non au corps du document : la
    // notification est déclarée en dernier dans son conteneur, et c'est de
    // cette place qu'elle tient son avantage sur les calques à z-index égal.
    const parent = fullscreen || toastOriginParent || document.body;
    if (toast.parentElement !== parent) {
        parent.appendChild(toast);
    }
}

/* ── Balayage : la notification se chasse du doigt ────────────── */

/**
 * En deçà, le doigt n'a pas encore dit ce qu'il voulait : c'est peut-être un
 * appui sur le bouton d'action, ou un défilement de la page.
 */
const SWIPE_DEADZONE_PX = 10;

/** Course au-delà de laquelle le relâchement chasse la notification. */
const SWIPE_DISMISS_PX = 64;

/** Course à laquelle la notification est devenue tout à fait transparente. */
const SWIPE_FADE_PX = 180;

/** Geste en cours, ou null. */
let toastSwipe = null;

const isTouchMode = () => {
    const dm = window.MusicPlayer.deviceMode;
    return dm ? dm.isTouch() : false;
};

/**
 * Chasse la notification dans la direction du balayage.
 *
 * Elle ne reprend pas l'animation de sortie : celle-ci retombe vers le bas
 * droit quelle que soit la manière dont on l'a congédiée, et le mouvement
 * partirait à contresens du doigt qui vient de la pousser. Elle prolonge donc
 * la course entamée, puis se retire.
 *
 * @param {HTMLElement} toast
 * @param {number} dx Course horizontale atteinte, en pixels.
 * @param {number} dy Course verticale atteinte.
 */
function flingToast(toast, dx, dy) {
    clearToastTimers();
    toastCycle.paused = false;

    const { outDuration } = getToastDurations();
    const ms = Math.max(120, Math.round(outDuration * 1000));

    toast.classList.remove('toast-in', 'toast-out', 'toast-paused', 'toast-swiping');
    toast.classList.add('toast-settling');
    toast.style.setProperty('--toast-settle-duration', `${ms}ms`);

    // Recalcul forcé : sans lui, la suppression de `toast-swiping` — qui coupe
    // toute transition — et le déplacement qui suit tomberaient dans la même
    // passe de style, et la notification sauterait à sa position finale.
    void toast.offsetWidth;

    // Assez loin pour sortir de l'écran par le bord qu'elle longe déjà.
    toast.style.transform = `translate(${dx > 0 ? '120vw' : '0px'}, ${dy > 0 ? '120vh' : '0px'})`;
    toast.style.opacity = '0';

    toastCycle.removeTimer = setTimeout(() => {
        toast.classList.add('hidden');
        toast.classList.remove('toast-settling');
        toast.style.transform = '';
        toast.style.opacity = '';
    }, ms);
}

/** Ramène la notification à sa place, le balayage n'ayant pas abouti. */
function settleToast(toast) {
    toast.classList.remove('toast-swiping');
    toast.classList.add('toast-settling');
    // La durée posée par une sortie précédente resterait sur l'élément : le
    // retour en place reprend la sienne, plus vive, celle de la feuille.
    toast.style.removeProperty('--toast-settle-duration');
    void toast.offsetWidth;
    toast.style.transform = '';
    toast.style.opacity = '';
}

/**
 * Balayage vers la droite ou vers le bas pour chasser la notification.
 *
 * Ces deux directions ne sont pas un choix arbitraire : la notification est
 * posée en bas à droite, ce sont les deux bords qu'elle longe et les seuls par
 * lesquels elle sorte sans traverser la page. Vers la gauche ou vers le haut,
 * le geste n'accroche rien — elle ne bouge pas, et le défilement de la page
 * reste disponible.
 *
 * Le doigt suspend le compte à rebours dès qu'il se pose, exactement comme la
 * souris qui survole : on ne chasse pas une notification qui vient de
 * disparaître d'elle-même sous le doigt.
 *
 * Les écouteurs sont posés dans tous les cas, et c'est le mode de support qui
 * décide à la volée : un appareil peut passer du tactile au bureau sans
 * recharger la page — voir js/deviceMode.js.
 *
 * @param {HTMLElement} toast
 */
function setupToastSwipe(toast) {
    toast.addEventListener('touchstart', (e) => {
        if (!isTouchMode() || toast.classList.contains('hidden')) return;
        // À deux doigts, c'est un pincement : il ne s'adresse pas à nous.
        if (e.touches.length !== 1) return;

        const touch = e.touches[0];
        toastSwipe = { startX: touch.clientX, startY: touch.clientY, dx: 0, dy: 0, axis: null };

        holdToastCountdown();
        toast.classList.remove('toast-in', 'toast-out', 'toast-paused', 'toast-settling');
        toast.classList.add('toast-swiping');
    }, { passive: true });

    toast.addEventListener('touchmove', (e) => {
        if (!toastSwipe) return;
        const touch = e.touches[0];
        if (!touch) return;

        const dx = touch.clientX - toastSwipe.startX;
        const dy = touch.clientY - toastSwipe.startY;

        // L'axe se fixe à la sortie de la zone morte et ne change plus : un
        // geste diagonal doit choisir, faute de quoi la notification louvoierait
        // entre les deux directions pendant toute la course.
        if (!toastSwipe.axis) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_DEADZONE_PX) return;
            toastSwipe.axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
        }

        toastSwipe.dx = toastSwipe.axis === 'x' ? Math.max(0, dx) : 0;
        toastSwipe.dy = toastSwipe.axis === 'y' ? Math.max(0, dy) : 0;

        const travel = Math.max(toastSwipe.dx, toastSwipe.dy);
        if (travel <= 0) return;

        // Le défilement de la page ne cède la place qu'une fois la notification
        // réellement en mouvement : un balayage vers la gauche ou vers le haut
        // ne la concerne pas et doit rester au doigt de l'utilisateur.
        e.preventDefault();

        toast.style.transform = `translate(${toastSwipe.dx}px, ${toastSwipe.dy}px)`;
        toast.style.opacity = String(Math.max(0, 1 - travel / SWIPE_FADE_PX));
    }, { passive: false });

    /**
     * @param {boolean} dismissible - Faux quand le geste a été interrompu.
     */
    const endSwipe = (dismissible) => {
        if (!toastSwipe) return;
        const { dx, dy } = toastSwipe;
        toastSwipe = null;

        if (dismissible && Math.max(dx, dy) >= SWIPE_DISMISS_PX) {
            flingToast(toast, dx, dy);
            return;
        }

        settleToast(toast);
        releaseToastCountdown();
    };

    toast.addEventListener('touchend', () => endSwipe(true), { passive: true });
    // Appel entrant, geste repris par le système : la notification revient à sa
    // place, quelle que soit la course parcourue. La course dit ce que le doigt
    // a fait, pas ce que l'utilisateur voulait — et personne n'a relâché ici.
    toast.addEventListener('touchcancel', () => endSwipe(false), { passive: true });
}

window.MusicPlayer.setupToastInteractions = function() {
    const toast = document.getElementById('error-toast');
    if (!toast || toast.dataset.interactionsInit === 'true') return;
    toast.dataset.interactionsInit = 'true';

    toastOriginParent = toast.parentElement;
    ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange'].forEach(evt => {
        document.addEventListener(evt, watchFullscreen);
    });

    toast.addEventListener('mouseenter', () => {
        if (toast.classList.contains('hidden')) return;
        holdToastCountdown();

        // Une sortie déjà entamée est annulée : le toast redevient pleinement
        // visible tant que la souris reste dessus.
        toast.classList.remove('toast-in', 'toast-out');
        toast.classList.add('toast-paused');
    });

    toast.addEventListener('mouseleave', () => {
        if (!toastCycle.paused) return;
        toast.classList.remove('toast-paused');
        releaseToastCountdown();
    });

    setupToastSwipe(toast);

    const copyBtn = document.getElementById('btn-copy-toast');
    if (copyBtn) {
        copyBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const text = toastCycle.message || document.getElementById('error-toast-message')?.textContent || '';
            if (!text) return;

            const copied = await window.MusicPlayer.copyToClipboard(text);

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
window.MusicPlayer.loadInviteLink = async function() {
    const link = document.getElementById('link-invite-bot');
    if (!link || !link.classList.contains('is-unavailable')) return;

    try {
        const response = await fetch('/api/invite', { credentials: 'same-origin' });
        if (!response.ok) return;
        const data = await response.json();
        if (!data || !data.inviteUrl) return;

        link.href = data.inviteUrl;
        link.classList.remove('is-unavailable');
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
            if (typeof window.MusicPlayer.refreshInterface === 'function') {
                window.MusicPlayer.refreshInterface();
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
    window.MusicPlayer.loadInviteLink();

    if (btnOpenSettings && settingsModal) {
        btnOpenSettings.addEventListener('click', (e) => {
            e.preventDefault();
            try {
                window.MusicPlayer.renderConnectedGuildsList();
            } catch (gErr) {
                console.error('[SettingsModal] Error rendering connected guilds:', gErr);
            }
            // Nouvelle tentative si le bot n'était pas encore prêt au chargement.
            window.MusicPlayer.loadInviteLink();
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

    /*
     * Le clic à côté referme la confirmation de retrait d'un serveur.
     *
     * Branché ici, et non dans `openServerDeleteConfirmModal` : cette
     * fonction-là est rappelée à chaque ouverture — elle repeint les libellés
     * et repose ses gestes par affectation de `onclick`, qui écrase le
     * précédent. Un `addEventListener` posé dans ce chemin empilerait au
     * contraire un écouteur par ouverture, et la fenêtre finirait par se
     * refermer plusieurs fois pour un seul clic. L'initialisation ne passe
     * qu'une fois, c'est sa place.
     *
     * Elle se superpose aux paramètres, mais les deux voiles sont frères dans
     * le document : l'événement remonte vers le corps de la page, jamais à
     * travers la fenêtre du dessous, qui reste donc ouverte.
     */
    const serverDeleteModal = document.getElementById('server-confirm-delete-modal');
    if (serverDeleteModal) {
        serverDeleteModal.addEventListener('click', (e) => {
            if (e.target === serverDeleteModal) serverDeleteModal.classList.add('hidden');
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

        /* ─────────────── Le cran de l'infini ───────────────
         *
         * Les trois curseurs de préchargement ont un dernier cran qui ne compte
         * plus des pistes : il les prend toutes. « Tout » n'étant pas un
         * nombre, il s'enregistre comme `-1` plutôt qu'avec la position du
         * curseur : celle-ci ne vaut que par rapport au maximum du jour, et le
         * jour où l'on porterait les curseurs à huit crans, un « 6 » enregistré
         * cesserait de vouloir dire « tout » sans que rien ne le signale. Un
         * nombre négatif, lui, n'est un compte dans aucun monde.
         */
        const PRELOAD_RANGES = new Set([
            'preload-queue-count', 'preload-history-count', 'preload-playlist-count',
        ]);

        /** Valeur enregistrée pour « toutes les pistes de la section ». */
        const PRELOAD_ALL = -1;

        /** Ce curseur est-il posé sur son cran d'infini ? */
        function atInfinity(range) {
            return PRELOAD_RANGES.has(range.id) && Number(range.value) >= Number(range.max);
        }

        /**
         * Ce qu'affiche la pastille d'un curseur.
         *
         * Centralisé : la valeur est peinte à l'ouverture, au glissement, à la
         * molette et à la remise par défaut. Écrire le symbole à trois de ces
         * quatre endroits donnerait un curseur qui affiche « 6 » selon la façon
         * dont on l'a atteint.
         */
        function rangeDisplay(range, unit) {
            return atInfinity(range) ? '∞' : `${range.value}${unit}`;
        }

        /**
         * Marque le cran d'infini là où il se voit : la fin de la piste, et la
         * pastille de valeur.
         *
         * La pastille est retrouvée par son identifiant plutôt que reçue en
         * argument : cette fonction est appelée depuis quatre endroits, dont la
         * remise par défaut, qui ne travaille pas sur les mêmes variables que
         * les trois autres.
         */
        function paintInfinity(range) {
            if (!PRELOAD_RANGES.has(range.id)) return;

            const infinite = atInfinity(range);
            range.classList.toggle('is-infinite', infinite);

            const badge = document.getElementById(`val-${range.id}`);
            if (badge) badge.classList.toggle('is-infinity', infinite);
        }

        /** Du réglage enregistré vers la position du curseur. */
        function preloadPosition(stored, range) {
            const max = Number(range.max);
            const n = parseInt(stored ?? 3, 10);
            if (!Number.isFinite(n)) return 3;
            return n < 0 ? max : Math.min(max - 1, Math.max(0, n));
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
            else if (range.id === 'preload-queue-count') range.value = preloadPosition(dashboardSettings.preloading && dashboardSettings.preloading.queueCount, range);
            else if (range.id === 'preload-history-count') range.value = preloadPosition(dashboardSettings.preloading && dashboardSettings.preloading.historyCount, range);
            else if (range.id === 'preload-playlist-count') range.value = preloadPosition(dashboardSettings.preloading && dashboardSettings.preloading.playlistCount, range);

            const unit = (range.id.includes('duration') || range.id.includes('hold') || range.id.includes('delay') || range.id.startsWith('setting-toast-')) ? 's' : (range.id.includes('video') ? 'px' : '');
            if (valSpan) valSpan.textContent = rangeDisplay(range, unit);
            paintInfinity(range);

            range.addEventListener('input', () => {
                if (valSpan) valSpan.textContent = rangeDisplay(range, unit);
                paintInfinity(range);
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
                if (valSpan) valSpan.textContent = rangeDisplay(range, unit);
                paintInfinity(range);
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
                    // Passé par le même formateur que les autres peintures : la
                    // valeur par défaut d'un curseur de préchargement pourrait
                    // un jour être son cran d'infini, et elle s'afficherait
                    // « 6 » ici alors qu'elle vaut « ∞ » partout ailleurs.
                    if (valDisplay) valDisplay.textContent = rangeDisplay(targetInput, unit);
                    paintInfinity(targetInput);
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

        const settingGridEnable = document.getElementById('setting-grid-enable');
        if (settingGridEnable) settingGridEnable.checked = !!dashboardSettings.showGrid;
        applyGridOverlay(dashboardSettings.showGrid);

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

        /**
         * La grille est dessinée par js/layoutPersistence.js, chargé avant ce
         * fichier mais pas garanti initialisé : l'appel est donc protégé, comme
         * les autres passerelles de ce module.
         */
        function applyGridOverlay(visible) {
            if (typeof window.MusicPlayer.applyGridOverlay === 'function') {
                window.MusicPlayer.applyGridOverlay(visible);
            }
        }

        function updateSettingsFromUI() {
            dashboardSettings.showLogsWindow = settingLogsEnable ? settingLogsEnable.checked : false;

            dashboardSettings.showGrid = settingGridEnable ? settingGridEnable.checked : false;
            applyGridOverlay(dashboardSettings.showGrid);
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
            const departureDelay = parseFloat(document.getElementById('setting-departure-delay')?.value);
            dashboardSettings.presenceDepartureDelay = Number.isFinite(departureDelay) ? departureDelay : 30;
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

            /**
             * De la position du curseur vers le réglage enregistré.
             *
             * Le dernier cran vaut « toutes les pistes » et s'écrit `-1` : voir
             * `PRELOAD_ALL` plus haut, et `preloadLimit` dans
             * audio/PreloadManager.js, qui le relit.
             */
            const preloadCount = (id) => {
                const range = document.getElementById(id);
                if (!range) return 3;
                const max = Number(range.max);
                const pos = parseInt(range.value, 10);
                if (!Number.isFinite(pos)) return 3;
                return pos >= max ? PRELOAD_ALL : Math.min(max - 1, Math.max(0, pos));
            };

            dashboardSettings.preloading = {
                enabled: preloadEnable ? preloadEnable.checked : true,
                queueCount: preloadCount('preload-queue-count'),
                historyCount: preloadCount('preload-history-count'),
                playlistCount: preloadCount('preload-playlist-count')
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
            dashboardSettings.showGrid = false;
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
            if (settingGridEnable) settingGridEnable.checked = false;
            applyGridOverlay(false);
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
        console.error('[SettingsModal] Error initialising the controls:', err);
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

        const size = `${window.innerWidth} × ${window.innerHeight}`;

        if (deviceMode.getChoice() !== 'auto') {
            hint.textContent = size;
            return;
        }
        const t = window.MusicPlayer.t;
        const label = typeof t === 'function'
            ? t(`device_mode_${deviceMode.get()}`)
            : deviceMode.get();
        const template = typeof t === 'function' ? t('device_mode_detected') : '';
        const detected = template && template !== 'device_mode_detected'
            ? template.replace('{mode}', label)
            : `→ ${label}`;
        hint.textContent = `${detected} — ${size}`;
    };

    select.value = deviceMode.getChoice();
    if (select._customSelect) select._customSelect._lastSignature = null;
    refreshHint();

    /*
     * Une rotation change les dimensions sans forcément changer le mode : sans
     * cette écoute, l'indication resterait celle de l'orientation précédente.
     * L'attente évite de la recalculer à chaque étape du redimensionnement.
     */
    let sizeTimer = null;
    window.addEventListener('resize', () => {
        clearTimeout(sizeTimer);
        sizeTimer = setTimeout(refreshHint, 200);
    });

    select.addEventListener('change', () => {
        if (!deviceMode.set(select.value)) return;
        refreshHint();

        const t = window.MusicPlayer.t;
        if (typeof window.MusicPlayer.showToast === 'function' && typeof t === 'function') {
            const label = t(`device_mode_${deviceMode.get()}`);
            const template = t('device_mode_applied');
            window.MusicPlayer.showToast(
                template && template !== 'device_mode_applied'
                    ? template.replace('{mode}', label)
                    : label
            );
        }
    });

    // Une rotation d'écran en mode automatique change le mode effectif sans
    // toucher au choix : l'indication doit suivre.
    deviceMode.onChange(refreshHint);
};
