/**
 * sharedControl — Partage du contrôle du bot, côté tableau de bord.
 *
 * Deux rôles, deux moitiés de ce module :
 *
 *   - **le maître** — celui qui détient le jeton — voit un bouton dans l'en-tête
 *     et une fenêtre où il coche, auditeur par auditeur, ce qu'il lui confie ;
 *   - **l'invité** — reconnu par son compte Discord — ne voit pas ce bouton, et
 *     trouve grisé ce qu'on ne lui a pas accordé.
 *
 * **Le grisage ne protège rien.** Il dit à l'invité ce qu'il peut faire, et lui
 * évite de cliquer dans le vide. La barrière est côté serveur, dans
 * src/web/permissions.js, et c'est elle qui refuse pour de bon : la console du
 * navigateur contourne l'une, jamais l'autre.
 *
 * L'état reçu du serveur porte `role`, `permissions`, et pour le maître seul un
 * bloc `sharing` — configuration OAuth, partages en vigueur, comptes déjà
 * authentifiés. Voir `_shareStateFor` dans src/web/WebServer.js.
 */

window.MusicPlayer = window.MusicPlayer || {};

(function () {
    'use strict';

    /**
     * Commandes du tableau de bord, rangées par groupe de droits.
     *
     * Volontairement limitée aux commandes principales : ce qui reste joignable
     * malgré le grisage — un menu contextuel, un glisser-déposer — se heurte au
     * refus du serveur, dont l'invité est averti par une notification. Étendre
     * cette carte améliore le confort, jamais la sécurité.
     */
    const CONTROLS = {
        playback: [
            '#btn-play-pause', '#btn-skip', '#btn-previous', '#btn-stop',
            '#progress-bar-wrapper', '.play-mode-switch', '#speed-pad-container',
            '#playback-source-select', '#mix-enable-toggle', '#mix-options-container',
            '#lufs-sync-toggle', '#lufs-sync-options',
        ],
        queue: [
            '#search-form', '#add-target-select', '#btn-clear-queue', '#btn-clear-history',
        ],
        playlists: [
            '#btn-add-playlist',
        ],
        volume: [
            '#volume-range', '#guild-select', '#broadcast-mode-select',
            '#ducking-enable-toggle', '#ducking-options-container',
            '#import-audio-quality-select', '#import-video-quality-select',
            '#btn-player-quality', '#btn-video-quality',
        ],
        /*
         * Réservé au maître. Ces commandes-là ne sont jamais partagées : elles
         * éteignent le bot, changent sa version, ou le font quitter un serveur.
         */
        master: [
            '#btn-restart-bot',
        ],
    };

    /** Groupes réglables, dans l'ordre d'affichage de la fenêtre. */
    const GROUPS = ['playback', 'queue', 'playlists', 'volume'];

    /** Libellés de repli, quand la traduction n'est pas encore chargée. */
    const GROUP_FALLBACK = {
        playback: 'Lecture',
        queue: 'File d\'attente',
        playlists: 'Playlists',
        volume: 'Volume et diffusion',
    };

    let role = 'master';
    let permissions = null;
    let sharing = null;
    /** Droits en cours de modification, pour ne pas les perdre au prochain état. */
    const inFlight = new Map();

    function el(id) {
        return document.getElementById(id);
    }

    function t(key, fallback) {
        const translated = typeof window.MusicPlayer.t === 'function' ? window.MusicPlayer.t(key) : key;
        return translated && translated !== key ? translated : fallback;
    }

    function toast(message) {
        if (typeof window.MusicPlayer.showToast === 'function') window.MusicPlayer.showToast(message);
    }

    /* ═════════════════════ Grisage chez l'invité ═════════════════════ */

    /**
     * Applique — ou retire — le voile sur une commande.
     *
     * L'infobulle du refus remplace celle d'origine, qui est mise de côté pour
     * être restituée si le droit est accordé plus tard. L'élément reste
     * survolable — c'est `brancherBlocage()` qui arrête les gestes, pas un
     * `pointer-events: none` qui emporterait l'infobulle avec le clic.
     */
    function mark(element, denied, reason) {
        if (!element) return;

        if (!denied) {
            if (element.classList.contains('perm-denied')) {
                element.classList.remove('perm-denied');
                // Ne restituer que ce qu'on avait soi-même remplacé.
                if (element.dataset.permTooltipAvant !== undefined) {
                    if (element.dataset.permTooltipAvant) element.dataset.tooltip = element.dataset.permTooltipAvant;
                    else delete element.dataset.tooltip;
                    delete element.dataset.permTooltipAvant;
                }
            }
            return;
        }

        if (!element.classList.contains('perm-denied')) {
            element.dataset.permTooltipAvant = element.dataset.tooltip || '';
            element.classList.add('perm-denied');
        }
        element.dataset.tooltip = reason;
    }

    /** Repasse sur toutes les commandes et accorde le voile aux droits courants. */
    function applyRights() {
        const isMaster = role === 'master';
        const reason = t('perm_denied_tooltip', 'Droit non accordé par le maître de la session');
        const masterReason = t('perm_master_only_tooltip', 'Réservé au maître de la session');

        for (const [group, selectors] of Object.entries(CONTROLS)) {
            const denied = isMaster
                ? false
                : group === 'master' || !(permissions && permissions[group]);

            for (const selector of selectors) {
                document.querySelectorAll(selector).forEach((element) => {
                    mark(element, denied, group === 'master' ? masterReason : reason);
                });
            }
        }

        // Le bouton de partage n'a de sens que pour qui a quelque chose à
        // partager. `hidden` plutôt qu'une classe : rien à styler pour cela.
        const wrapper = el('share-controls-wrapper');
        if (wrapper) wrapper.hidden = !isMaster;

        document.documentElement.dataset.role = role;
    }

    /**
     * Arrête les gestes visant une commande refusée.
     *
     * En phase de capture, donc avant que le bouton concerné n'entende quoi que
     * ce soit. `pointer-events: none` aurait été plus simple, mais aurait aussi
     * emporté l'infobulle qui explique le refus — l'élément doit rester
     * survolable tout en étant inerte.
     *
     * Le serveur refuserait de toute façon : ce blocage évite seulement à
     * l'invité de croire son geste passé, et au tableau de bord de se peindre
     * un état qu'il n'obtiendra pas.
     */
    function bindLock() {
        const blockedEvents = ['click', 'mousedown', 'pointerdown', 'keydown', 'input', 'change'];

        for (const evtName of blockedEvents) {
            document.addEventListener(evtName, (e) => {
                const denied = e.target && e.target.closest && e.target.closest('.perm-denied');
                if (!denied) return;

                e.preventDefault();
                e.stopPropagation();
                // Un seul avertissement par geste : `click` suit `mousedown`, et
                // deux notifications pour un même clic seraient de trop.
                if (evtName === 'click' || evtName === 'change') window.MusicPlayer.onPermissionDenied();
            }, true);
        }
    }

    /* ═════════════════════ Fenêtre du maître ═════════════════════ */

    /**
     * Auditeurs à présenter, et ce qu'on sait d'eux.
     *
     * Les membres du salon vocal d'abord — ce sont eux qu'on veut inviter. Les
     * comptes déjà authentifiés ensuite, même absents du salon : leurs droits
     * restent en vigueur, et il faut pouvoir les leur retirer sans attendre
     * qu'ils reviennent.
     */
    function listeners() {
        const state = window.MusicPlayer.state || {};
        const knownMembers = new Map((sharing?.knownUsers || []).map((u) => [u.userId, u]));
        const grants = sharing?.grants || {};
        const list = [];
        const seen = new Set();

        for (const member of state.members || []) {
            seen.add(member.id);
            list.push({
                userId: member.id,
                displayName: member.displayName,
                avatar: member.avatar || knownMembers.get(member.id)?.avatar || null,
                authenticated: knownMembers.has(member.id),
                rights: grants[member.id] || null,
                inChannel: true,
            });
        }

        for (const [userId, known] of knownMembers) {
            if (seen.has(userId)) continue;
            // Un compte authentifié mais parti : on ne le montre que s'il garde
            // des droits, sans quoi la liste s'allongerait de tous les passages.
            if (!grants[userId]) continue;
            list.push({
                userId,
                displayName: known.displayName || userId,
                avatar: known.avatar,
                authenticated: true,
                rights: grants[userId],
                inChannel: false,
            });
        }

        return list;
    }

    function initial(name) {
        return (name || '?').trim().charAt(0).toUpperCase() || '?';
    }

    /** Construit la ligne d'un auditeur. */
    function listenerRow(person) {
        const rights = inFlight.get(person.userId) || person.rights || {};
        const filled = GROUPS.some((g) => rights[g]);

        const row = document.createElement('div');
        row.className = 'share-person'
            + (filled ? ' has-grants' : '')
            + (person.authenticated ? '' : ' pending');
        row.dataset.userId = person.userId;

        const head = document.createElement('div');
        head.className = 'share-person-head';

        if (person.avatar) {
            const img = document.createElement('img');
            img.className = 'share-person-avatar';
            img.src = person.avatar;
            img.alt = '';
            head.appendChild(img);
        } else {
            const circle = document.createElement('div');
            circle.className = 'share-person-avatar';
            circle.textContent = initial(person.displayName);
            head.appendChild(circle);
        }

        const name = document.createElement('span');
        name.className = 'share-person-name';
        name.textContent = person.displayName
            + (person.inChannel ? '' : ` ${t('share_away', '(absent)')}`);
        head.appendChild(name);

        const stateEl = document.createElement('span');
        stateEl.className = 'share-person-state' + (person.authenticated ? ' connected' : '');
        stateEl.textContent = person.authenticated
            ? t('share_state_connected', 'authentifié')
            : t('share_state_pending', 'pas encore connecté');
        head.appendChild(stateEl);

        if (filled) {
            const revoke = document.createElement('button');
            revoke.className = 'btn-share-revoke';
            revoke.dataset.tooltip = t('share_revoke', 'Tout retirer');
            revoke.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" '
                + 'stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"></line>'
                + '<line x1="6" y1="6" x2="18" y2="18"></line></svg>';
            revoke.addEventListener('click', () => {
                inFlight.delete(person.userId);
                window.MusicPlayer.sendWS({ type: 'revokeControl', data: { userId: person.userId } });
            });
            head.appendChild(revoke);
        }

        row.appendChild(head);

        const cases = document.createElement('div');
        cases.className = 'share-grants';

        for (const group of GROUPS) {
            const row = document.createElement('div');
            row.className = 'share-grant';

            const label = document.createElement('span');
            label.textContent = t(`share_group_${group}`, GROUP_FALLBACK[group]);
            row.appendChild(label);

            const tagEl = document.createElement('label');
            tagEl.className = 'switch switch-mini';

            const entry = document.createElement('input');
            entry.type = 'checkbox';
            entry.checked = Boolean(rights[group]);
            entry.disabled = !person.authenticated;
            entry.addEventListener('change', () => {
                const next = {};
                row.querySelectorAll('.share-grant input').forEach((box, index) => {
                    next[GROUPS[index]] = box.checked;
                });
                // Retenu localement : l'état renvoyé par le serveur arrive après
                // un aller-retour, et un rendu entre-temps remettrait la case
                // dans sa position d'avant.
                inFlight.set(person.userId, next);
                window.MusicPlayer.sendWS({
                    type: 'shareControl',
                    data: { userId: person.userId, permissions: next },
                });
            });

            const rail = document.createElement('span');
            rail.className = 'switch-slider';

            tagEl.appendChild(entry);
            tagEl.appendChild(rail);
            row.appendChild(tagEl);
            cases.appendChild(row);
        }

        row.appendChild(cases);
        return row;
    }

    /** Redessine la fenêtre de partage. */
    function renderModal() {
        const modal = el('share-modal');
        if (!modal || modal.classList.contains('hidden')) return;

        const warning = el('share-oauth-warning');
        if (warning) {
            const missing = !sharing?.oauthReady;
            warning.classList.toggle('hidden', !missing);
            const reminder = el('share-callback-url');
            if (reminder && sharing?.publicUrl) {
                reminder.textContent = `${sharing.publicUrl}/auth/discord/callback`;
            }
        }

        const send = el('btn-send-invite');
        if (send) send.disabled = !sharing?.oauthReady;

        const list = el('share-people-list');
        if (!list) return;

        const people = listeners();
        list.innerHTML = '';

        if (!people.length) {
            const empty = document.createElement('div');
            empty.className = 'share-empty';
            empty.textContent = t('share_empty', 'Personne dans le salon vocal.');
            list.appendChild(empty);
            return;
        }

        people.forEach((person) => list.appendChild(listenerRow(person)));
    }

    /** Nombre d'invités pourvus, affiché sur le bouton de l'en-tête. */
    function renderBadge() {
        const badge = el('share-badge');
        if (!badge) return;

        const total = Object.keys(sharing?.grants || {}).length;
        badge.textContent = String(total);
        badge.classList.toggle('hidden', total === 0);
    }

    /* ═════════════════════ Entrées du module ═════════════════════ */

    /**
     * Appelé à chaque état reçu du serveur.
     * @param {object} state
     */
    window.MusicPlayer.applyShareState = function (state) {
        if (!state) return;

        if (state.role) role = state.role;
        if (state.permissions) permissions = state.permissions;
        if (state.sharing) sharing = state.sharing;

        applyRights();
        renderBadge();
        renderModal();
    };

    /** Le serveur a refusé une commande : le dire plutôt que de rester muet. */
    window.MusicPlayer.onPermissionDenied = function () {
        toast(t('perm_denied_toast', 'Le maître de la session ne vous a pas accordé ce droit.'));
    };

    /** Le maître vient de tout retirer : l'invité doit le savoir. */
    window.MusicPlayer.onControlRevoked = function () {
        toast(t('perm_revoked_toast', 'Votre accès au lecteur a été retiré.'));
        permissions = { playback: false, queue: false, playlists: false, volume: false };
        applyRights();
    };

    /** Réponse à une action de partage. */
    window.MusicPlayer.onShareResult = function (data) {
        if (!data) return;

        if (data.ok && data.channelName) {
            toast(t('share_invite_sent', 'Lien envoyé dans le tchat du salon vocal.'));
            return;
        }

        if (data.ok) return;

        const reasons = {
            oauth_absent: t('share_err_oauth', 'Authentification Discord non configurée.'),
            channel_missing: t('share_err_channel', 'Aucun salon vocal actif.'),
            channel_muted: t('share_err_mute', 'Ce salon n\'accepte pas les messages.'),
            send_denied: t('share_err_send', 'Le bot n\'a pas pu écrire dans ce salon.'),
        };
        toast(reasons[data.reason] || t('share_err_generic', 'Le partage a échoué.'));
    };

    function initShare() {
        const openBtn = el('btn-open-share');
        const closeBtn = el('btn-close-share');
        const modal = el('share-modal');

        if (openBtn && modal) {
            openBtn.addEventListener('click', () => {
                modal.classList.remove('hidden');
                renderModal();
            });
        }

        if (closeBtn && modal) {
            closeBtn.addEventListener('click', () => modal.classList.add('hidden'));
        }

        if (modal) {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) modal.classList.add('hidden');
            });
        }

        const send = el('btn-send-invite');
        if (send) {
            send.addEventListener('click', () => {
                window.MusicPlayer.sendWS({ type: 'sendInviteLink', data: {} });
            });
        }

        bindLock();
        applyRights();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initShare);
    } else {
        initShare();
    }
})();
