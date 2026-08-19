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
    const enVol = new Map();

    function el(id) {
        return document.getElementById(id);
    }

    function t(key, fallback) {
        const traduit = typeof window.MusicPlayer.t === 'function' ? window.MusicPlayer.t(key) : key;
        return traduit && traduit !== key ? traduit : fallback;
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
    function marquer(element, refuse, motif) {
        if (!element) return;

        if (!refuse) {
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
        element.dataset.tooltip = motif;
    }

    /** Repasse sur toutes les commandes et accorde le voile aux droits courants. */
    function appliquerDroits() {
        const estMaitre = role === 'master';
        const motif = t('perm_denied_tooltip', 'Droit non accordé par le maître de la session');
        const motifMaitre = t('perm_master_only_tooltip', 'Réservé au maître de la session');

        for (const [groupe, selecteurs] of Object.entries(CONTROLS)) {
            const refuse = estMaitre
                ? false
                : groupe === 'master' || !(permissions && permissions[groupe]);

            for (const selecteur of selecteurs) {
                document.querySelectorAll(selecteur).forEach((element) => {
                    marquer(element, refuse, groupe === 'master' ? motifMaitre : motif);
                });
            }
        }

        // Le bouton de partage n'a de sens que pour qui a quelque chose à
        // partager. `hidden` plutôt qu'une classe : rien à styler pour cela.
        const wrapper = el('share-controls-wrapper');
        if (wrapper) wrapper.hidden = !estMaitre;

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
    function brancherBlocage() {
        const gestes = ['click', 'mousedown', 'pointerdown', 'keydown', 'input', 'change'];

        for (const geste of gestes) {
            document.addEventListener(geste, (e) => {
                const refuse = e.target && e.target.closest && e.target.closest('.perm-denied');
                if (!refuse) return;

                e.preventDefault();
                e.stopPropagation();
                // Un seul avertissement par geste : `click` suit `mousedown`, et
                // deux notifications pour un même clic seraient de trop.
                if (geste === 'click' || geste === 'change') window.MusicPlayer.onPermissionDenied();
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
    function auditeurs() {
        const state = window.MusicPlayer.state || {};
        const connus = new Map((sharing?.knownUsers || []).map((u) => [u.userId, u]));
        const grants = sharing?.grants || {};
        const liste = [];
        const vus = new Set();

        for (const membre of state.members || []) {
            vus.add(membre.id);
            liste.push({
                userId: membre.id,
                displayName: membre.displayName,
                avatar: membre.avatar || connus.get(membre.id)?.avatar || null,
                authentifie: connus.has(membre.id),
                droits: grants[membre.id] || null,
                dansLeSalon: true,
            });
        }

        for (const [userId, connu] of connus) {
            if (vus.has(userId)) continue;
            // Un compte authentifié mais parti : on ne le montre que s'il garde
            // des droits, sans quoi la liste s'allongerait de tous les passages.
            if (!grants[userId]) continue;
            liste.push({
                userId,
                displayName: connu.displayName || userId,
                avatar: connu.avatar,
                authentifie: true,
                droits: grants[userId],
                dansLeSalon: false,
            });
        }

        return liste;
    }

    function initiale(nom) {
        return (nom || '?').trim().charAt(0).toUpperCase() || '?';
    }

    /** Construit la ligne d'un auditeur. */
    function ligneAuditeur(personne) {
        const droits = enVol.get(personne.userId) || personne.droits || {};
        const pourvu = GROUPS.some((g) => droits[g]);

        const ligne = document.createElement('div');
        ligne.className = 'share-person'
            + (pourvu ? ' has-grants' : '')
            + (personne.authentifie ? '' : ' pending');
        ligne.dataset.userId = personne.userId;

        const tete = document.createElement('div');
        tete.className = 'share-person-head';

        if (personne.avatar) {
            const img = document.createElement('img');
            img.className = 'share-person-avatar';
            img.src = personne.avatar;
            img.alt = '';
            tete.appendChild(img);
        } else {
            const rond = document.createElement('div');
            rond.className = 'share-person-avatar';
            rond.textContent = initiale(personne.displayName);
            tete.appendChild(rond);
        }

        const nom = document.createElement('span');
        nom.className = 'share-person-name';
        nom.textContent = personne.displayName
            + (personne.dansLeSalon ? '' : ` ${t('share_away', '(absent)')}`);
        tete.appendChild(nom);

        const etat = document.createElement('span');
        etat.className = 'share-person-state' + (personne.authentifie ? ' connected' : '');
        etat.textContent = personne.authentifie
            ? t('share_state_connected', 'authentifié')
            : t('share_state_pending', 'pas encore connecté');
        tete.appendChild(etat);

        if (pourvu) {
            const revoquer = document.createElement('button');
            revoquer.className = 'btn-share-revoke';
            revoquer.dataset.tooltip = t('share_revoke', 'Tout retirer');
            revoquer.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" '
                + 'stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"></line>'
                + '<line x1="6" y1="6" x2="18" y2="18"></line></svg>';
            revoquer.addEventListener('click', () => {
                enVol.delete(personne.userId);
                window.MusicPlayer.sendWS({ type: 'revokeControl', data: { userId: personne.userId } });
            });
            tete.appendChild(revoquer);
        }

        ligne.appendChild(tete);

        const cases = document.createElement('div');
        cases.className = 'share-grants';

        for (const groupe of GROUPS) {
            const rangee = document.createElement('div');
            rangee.className = 'share-grant';

            const libelle = document.createElement('span');
            libelle.textContent = t(`share_group_${groupe}`, GROUP_FALLBACK[groupe]);
            rangee.appendChild(libelle);

            const etiquette = document.createElement('label');
            etiquette.className = 'switch switch-mini';

            const entree = document.createElement('input');
            entree.type = 'checkbox';
            entree.checked = Boolean(droits[groupe]);
            entree.disabled = !personne.authentifie;
            entree.addEventListener('change', () => {
                const suivant = {};
                ligne.querySelectorAll('.share-grant input').forEach((boite, index) => {
                    suivant[GROUPS[index]] = boite.checked;
                });
                // Retenu localement : l'état renvoyé par le serveur arrive après
                // un aller-retour, et un rendu entre-temps remettrait la case
                // dans sa position d'avant.
                enVol.set(personne.userId, suivant);
                window.MusicPlayer.sendWS({
                    type: 'shareControl',
                    data: { userId: personne.userId, permissions: suivant },
                });
            });

            const rail = document.createElement('span');
            rail.className = 'switch-slider';

            etiquette.appendChild(entree);
            etiquette.appendChild(rail);
            rangee.appendChild(etiquette);
            cases.appendChild(rangee);
        }

        ligne.appendChild(cases);
        return ligne;
    }

    /** Redessine la fenêtre de partage. */
    function rendreFenetre() {
        const modal = el('share-modal');
        if (!modal || modal.classList.contains('hidden')) return;

        const avertissement = el('share-oauth-warning');
        if (avertissement) {
            const manquant = !sharing?.oauthReady;
            avertissement.classList.toggle('hidden', !manquant);
            const rappel = el('share-callback-url');
            if (rappel && sharing?.publicUrl) {
                rappel.textContent = `${sharing.publicUrl}/auth/discord/callback`;
            }
        }

        const envoyer = el('btn-send-invite');
        if (envoyer) envoyer.disabled = !sharing?.oauthReady;

        const liste = el('share-people-list');
        if (!liste) return;

        const personnes = auditeurs();
        liste.innerHTML = '';

        if (!personnes.length) {
            const vide = document.createElement('div');
            vide.className = 'share-empty';
            vide.textContent = t('share_empty', 'Personne dans le salon vocal.');
            liste.appendChild(vide);
            return;
        }

        personnes.forEach((personne) => liste.appendChild(ligneAuditeur(personne)));
    }

    /** Nombre d'invités pourvus, affiché sur le bouton de l'en-tête. */
    function rendrePastille() {
        const pastille = el('share-badge');
        if (!pastille) return;

        const total = Object.keys(sharing?.grants || {}).length;
        pastille.textContent = String(total);
        pastille.classList.toggle('hidden', total === 0);
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

        appliquerDroits();
        rendrePastille();
        rendreFenetre();
    };

    /** Le serveur a refusé une commande : le dire plutôt que de rester muet. */
    window.MusicPlayer.onPermissionDenied = function () {
        toast(t('perm_denied_toast', 'Le maître de la session ne vous a pas accordé ce droit.'));
    };

    /** Le maître vient de tout retirer : l'invité doit le savoir. */
    window.MusicPlayer.onControlRevoked = function () {
        toast(t('perm_revoked_toast', 'Votre accès au lecteur a été retiré.'));
        permissions = { playback: false, queue: false, playlists: false, volume: false };
        appliquerDroits();
    };

    /** Réponse à une action de partage. */
    window.MusicPlayer.onShareResult = function (data) {
        if (!data) return;

        if (data.ok && data.channelName) {
            toast(t('share_invite_sent', 'Lien envoyé dans le tchat du salon vocal.'));
            return;
        }

        if (data.ok) return;

        const motifs = {
            oauth_absent: t('share_err_oauth', 'Authentification Discord non configurée.'),
            salon_absent: t('share_err_channel', 'Aucun salon vocal actif.'),
            salon_muet: t('share_err_mute', 'Ce salon n\'accepte pas les messages.'),
            envoi_refuse: t('share_err_send', 'Le bot n\'a pas pu écrire dans ce salon.'),
        };
        toast(motifs[data.reason] || t('share_err_generic', 'Le partage a échoué.'));
    };

    function initShare() {
        const ouvrir = el('btn-open-share');
        const fermer = el('btn-close-share');
        const modal = el('share-modal');

        if (ouvrir && modal) {
            ouvrir.addEventListener('click', () => {
                modal.classList.remove('hidden');
                rendreFenetre();
            });
        }

        if (fermer && modal) {
            fermer.addEventListener('click', () => modal.classList.add('hidden'));
        }

        if (modal) {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) modal.classList.add('hidden');
            });
        }

        const envoyer = el('btn-send-invite');
        if (envoyer) {
            envoyer.addEventListener('click', () => {
                window.MusicPlayer.sendWS({ type: 'sendInviteLink', data: {} });
            });
        }

        brancherBlocage();
        appliquerDroits();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initShare);
    } else {
        initShare();
    }
})();
