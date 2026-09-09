/**
 * Versions — Affichage de la version en cours et bascule vers une autre.
 *
 * Trois points de contact dans l'interface :
 *   - le pied du tiroir, qui affiche en permanence la version exécutée ;
 *   - le menu déroulant en tête des Paramètres Généraux, dont l'ouverture
 *     relance une recherche des releases publiées sur le dépôt ;
 *   - le pop-up de confirmation, qui rend compte du téléchargement puis laisse
 *     la main au voile de redémarrage.
 *
 * Le serveur fait tout le travail (voir src/versioning/) ; ce module ne fait
 * qu'exposer son état et lui transmettre le choix de l'utilisateur.
 */

window.MusicPlayer = window.MusicPlayer || {};

(function () {
    'use strict';

    const DEV_TAG = 'dev';

    /** Version en cours d'exécution, telle que servie par /api/version. */
    let currentVersion = null;
    /** Dernier catalogue reçu, pour retrouver une release à partir de son tag. */
    let catalog = null;
    /** Tag en attente de confirmation dans le pop-up. */
    let pendingTag = null;
    /** Une bascule est engagée : les boutons du pop-up sont neutralisés. */
    let toggleEngaged = false;
    /** Tag en attente de confirmation dans le pop-up de désinstallation. */
    let tagToUninstall = null;
    /** Une désinstallation est engagée : sa confirmation est neutralisée. */
    let uninstallStarted = false;

    function t(key, fallback) {
        const translated = typeof window.MusicPlayer.t === 'function' ? window.MusicPlayer.t(key) : key;
        // `t()` renvoie la clé elle-même quand la traduction manque.
        return translated && translated !== key ? translated : (fallback !== undefined ? fallback : key);
    }

    function el(id) {
        return document.getElementById(id);
    }

    function formatBytes(bytes) {
        if (!Number.isFinite(bytes) || bytes <= 0) return '';
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} Ko`;
        return `${(bytes / 1024 / 1024).toFixed(1)} Mo`;
    }

    /** Libellé lisible d'une version, DEV compris. */
    function versionLabel(version) {
        if (!version) return '—';
        if (version.type === 'dev' || version.tag === DEV_TAG) {
            return version.packageVersion
                ? `${t('version_dev_short', 'DEV')} (${version.packageVersion})`
                : t('version_dev_short', 'DEV');
        }
        return version.tag;
    }

    /* ───────────────────────── Pied du tiroir ───────────────────────── */

    function paintCurrentVersion() {
        const value = el('drawer-version-value');
        if (value) {
            value.textContent = versionLabel(currentVersion);
            value.classList.toggle('is-dev', !!currentVersion && currentVersion.type === 'dev');
            // Tant qu'on ne connaît pas la version, le bouton n'affiche qu'un
            // tiret : le copier ne rendrait service à personne.
            value.disabled = !currentVersion;
        }

        const index = el('version-current-hint');
        if (index) {
            index.textContent = currentVersion
                ? `${t('version_current_prefix', 'Actuelle :')} ${versionLabel(currentVersion)}`
                : '';
        }
    }

    /* ─────────────────── Copier la version d'un clic ───────────────────
     *
     * Le numéro affiché finit toujours par être recopié à la main — dans un
     * message, un rapport de bug, une question au dépôt. Le rendre cliquable
     * supprime la transcription, et avec elle la faute de frappe qui fait
     * chercher un bug dans la mauvaise version.
     *
     * **C'est le texte affiché qui part**, pas une valeur reconstruite en
     * coulisses. On copie ce qu'on voit : « v1.4.0 » pour une release, « DEV
     * (1.0.0) » pour du code en cours d'écriture — cette dernière forme dit à
     * la fois qu'il ne s'agit pas d'une release et de quelle base elle part,
     * ce qui est exactement ce qu'un rapport doit porter.
     *
     * L'animation dit ce que copier veut dire : rien n'est déplacé, un
     * exemplaire de plus est pris. Un décalque de la valeur se détache donc et
     * monte en se dissolvant, tandis que l'original ne bouge pas d'un pixel.
     * Le bouton s'enfonce sous le doigt, puis passe au vert le temps que le
     * double achève sa montée.
     */

    /** Durée de la confirmation verte, en millisecondes. */
    const COPY_FEEDBACK_MS = 900;

    const copyReducedMotion = () => (window.matchMedia
        ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
        : false);

    /**
     * Détache un décalque de la valeur et le laisse monter.
     *
     * Le double est un enfant du bouton, et non un élément flottant posé dans
     * la page : il hérite ainsi de sa police, de son interlignage et de son
     * remplissage, et part donc exactement de l'endroit où le regard se trouve.
     *
     * **Un seul à la fois.** Laisser les doubles s'accumuler semblait dire « on
     * a pris plusieurs copies » ; à l'écran, deux calques superposés à des
     * phases différentes ne donnent qu'une image dédoublée. Un clic répété
     * relance donc le vol au lieu d'en ajouter un second.
     *
     * @param {HTMLElement} button
     * @param {string} label Le texte à faire monter, pris au modèle et non au
     *   bouton — voir `copyCurrentVersion`.
     */
    function flyCopy(button, label) {
        if (copyReducedMotion()) return;

        const previous = button.querySelector('.version-ghost');
        if (previous && previous.parentNode) previous.parentNode.removeChild(previous);

        const ghost = document.createElement('span');
        ghost.className = 'version-ghost';
        ghost.setAttribute('aria-hidden', 'true');
        ghost.textContent = label;
        button.appendChild(ghost);

        const drop = () => { if (ghost.parentNode) ghost.parentNode.removeChild(ghost); };
        ghost.addEventListener('animationend', drop);
        // Filet : un navigateur qui n'animerait rien ne déclencherait jamais
        // `animationend`, et le double resterait posé sur la valeur.
        setTimeout(drop, 1200);
    }

    /** Copie la version affichée, et le fait savoir. */
    async function copyCurrentVersion() {
        const button = el('drawer-version-value');
        if (!button || button.disabled) return;

        /*
         * Le libellé vient du modèle, jamais du bouton.
         *
         * `textContent` rend le texte de l'élément **et de tous ses
         * descendants**, et le double en vol en est un. Lu sur le bouton, il
         * valait donc « DEV (1.0.0) » au premier clic, puis
         * « DEV (1.0.0)DEV (1.0.0) » au deuxième s'il tombait avant la fin du
         * vol — chaîne aussitôt copiée telle quelle dans le presse-papier, puis
         * recopiée dans le double suivant, qui grossissait à chaque clic.
         *
         * `versionLabel` est la source dont `paintCurrentVersion` tire déjà ce
         * qu'il affiche : la lire ici, c'est copier ce que l'on voit sans
         * dépendre de ce que le bouton contient à cet instant.
         */
        const label = versionLabel(currentVersion);

        // L'enfoncement répond au geste avant même que la copie n'aboutisse :
        // c'est le clic qu'il accuse, pas son résultat.
        button.classList.add('is-pressed');
        setTimeout(() => button.classList.remove('is-pressed'), 110);

        const copier = window.MusicPlayer.copyToClipboard;
        const done = typeof copier === 'function' ? await copier(label) : false;

        if (!done) {
            /*
             * Le refus se dit, et il arrive pour de bon : hors contexte
             * sécurisé, `execCommand` est le seul recours et certains
             * navigateurs le refusent désormais. Rester muet laisserait coller
             * le contenu d'avant en croyant tenir la version.
             */
            if (typeof window.MusicPlayer.showToast === 'function') {
                window.MusicPlayer.showToast(
                    t('version_copy_failed', 'Copie impossible : sélectionnez le numéro à la main.'));
            }
            return;
        }

        flyCopy(button, label);
        button.classList.add('is-copied');
        clearTimeout(button._copyBack);
        button._copyBack = setTimeout(() => button.classList.remove('is-copied'), COPY_FEEDBACK_MS);
    }

    function bindVersionCopy() {
        const button = el('drawer-version-value');
        if (!button || button._copyBound) return;
        button._copyBound = true;
        button.addEventListener('click', copyCurrentVersion);
    }

    /**
     * Relit la version exécutée.
     *
     * Servie en HTTP plutôt que par l'état WebSocket : elle ne dépend d'aucun
     * serveur Discord sélectionné, et le tiroir doit pouvoir l'afficher dès le
     * chargement de la page.
     */
    async function refreshCurrentVersion() {
        try {
            const response = await fetch('/api/version', { credentials: 'same-origin' });
            if (!response.ok) return;
            currentVersion = await response.json();
            paintCurrentVersion();
        } catch (e) {
            // Serveur injoignable : le pied garde sa dernière valeur connue.
        }
    }

    /* ─────────────────────── Menu déroulant ─────────────────────── */

    function selectEl() {
        return el('setting-version-select');
    }

    function syncMenu() {
        const select = selectEl();
        if (select && select._customSelect) select._customSelect.sync(true);
    }

    function addOption(select, value, text, options = {}) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = text;
        if (options.disabled) option.disabled = true;
        if (options.selected) option.selected = true;
        // `data-removable` fait naître une corbeille sur l'entrée du menu
        // personnalisé, qui émet `option-remove` sans rien savoir de ce qu'elle
        // retire (voir js/customSelect.js).
        if (options.removable) {
            option.dataset.removable = 'true';
            option.dataset.removeTooltip = t('version_tooltip_uninstall', 'Désinstaller cette version');
        }
        select.appendChild(option);
        return option;
    }

    /** Menu réduit à la version courante, le temps d'interroger le dépôt. */
    function showSearching() {
        const select = selectEl();
        if (!select) return;

        select.innerHTML = '';
        const currentTag = currentVersion ? currentVersion.tag : DEV_TAG;
        addOption(select, currentTag, versionLabel(currentVersion), { selected: true });
        addOption(select, '__recherche__', t('version_searching', 'Recherche des versions…'), { disabled: true });
        syncMenu();
    }

    /** Suffixes d'une entrée : état d'installation, préversion, version active. */
    function describeRelease(entry) {
        const parts = [];
        if (entry.current) parts.push(t('version_tag_current', 'actuelle'));
        parts.push(
            entry.installed
                ? t('version_tag_installed', 'installée')
                : t('version_tag_downloadable', 'à télécharger')
        );
        if (entry.prerelease) parts.push(t('version_tag_prerelease', 'préversion'));
        return `${entry.tag} · ${parts.join(' · ')}`;
    }

    function paintCatalog() {
        const select = selectEl();
        if (!select || !catalog) return;

        const currentTag = catalog.current ? catalog.current.tag : DEV_TAG;
        select.innerHTML = '';

        if (catalog.dev && catalog.dev.available) {
            const suffix = catalog.dev.current ? ` · ${t('version_tag_current', 'actuelle')}` : '';
            addOption(
                select,
                DEV_TAG,
                `${t('version_option_dev', 'DEV — code local')}${
                    catalog.dev.packageVersion ? ` (${catalog.dev.packageVersion})` : ''
                }${suffix}`,
                { selected: currentTag === DEV_TAG }
            );
        }

        (catalog.releases || []).forEach((entry) => {
            addOption(select, entry.tag, describeRelease(entry), {
                selected: entry.tag === currentTag,
                // Seule une version présente sur le disque se désinstalle, et
                // jamais celle qui tourne : le serveur refuserait de toute
                // façon, autant ne pas proposer le geste.
                removable: entry.installed && !entry.current,
            });
        });

        // Ni release ni erreur : le dépôt n'a simplement rien publié.
        if (!(catalog.releases || []).length && !catalog.error) {
            addOption(select, '__vide__', t('version_none_published', 'Aucune release publiée sur le dépôt'), {
                disabled: true,
            });
        }

        // L'échec de la consultation est affiché dans le menu lui-même : c'est
        // là que l'utilisateur attend une réponse, et une liste vide sans
        // explication passerait pour un dépôt sans release.
        if (catalog.error) {
            addOption(select, '__erreur__', `⚠ ${catalog.error.message}`, { disabled: true });
        }

        syncMenu();
    }

    function requestCatalog() {
        if (toggleEngaged) return;

        // `sendWS` ignore silencieusement un envoi hors connexion : sans cette
        // vérification, le menu resterait bloqué sur « Recherche… » sans que
        // rien n'explique pourquoi.
        const socket = window.MusicPlayer.socket;
        if (!socket || socket.readyState !== WebSocket.OPEN) {
            catalog = {
                current: currentVersion,
                dev: { tag: DEV_TAG, available: true, current: !currentVersion || currentVersion.type === 'dev' },
                releases: [],
                error: { message: t('version_offline', 'Bot injoignable : impossible de consulter les versions.') },
            };
            paintCatalog();
            return;
        }

        showSearching();
        window.MusicPlayer.sendWS({ type: 'listVersions' });
    }

    /** Ramène la sélection sur la version exécutée, après annulation. */
    function reselectCurrent() {
        const select = selectEl();
        if (!select) return;
        const currentTag = currentVersion ? currentVersion.tag : DEV_TAG;
        if (Array.from(select.options).some((o) => o.value === currentTag)) {
            select.value = currentTag;
        }
        syncMenu();
    }

    /* ──────────────────────────── Pop-up ──────────────────────────── */

    function showProgress(visible) {
        const block = el('version-progress');
        if (block) block.classList.toggle('hidden', !visible);
    }

    function updateProgress(phase, percent, detail, isError = false) {
        const phaseEl = el('version-progress-phase');
        const fill = el('version-progress-fill');
        const detailEl = el('version-progress-detail');

        if (phaseEl) phaseEl.textContent = phase;
        if (fill) {
            const hasNumber = Number.isFinite(percent);
            fill.classList.toggle('indeterminate', !hasNumber && !isError);
            fill.style.width = hasNumber ? `${Math.max(0, Math.min(100, percent))}%` : '';
            if (isError) fill.style.width = '0';
        }
        if (detailEl) {
            detailEl.textContent = detail || '';
            detailEl.classList.toggle('is-error', !!isError);
        }
    }

    function openPopup(tag) {
        const modal = el('version-modal');
        if (!modal) return;

        pendingTag = tag;
        toggleEngaged = false;

        const entry = (catalog && (catalog.releases || []).find((r) => r.tag === tag)) || null;
        const toDev = tag === DEV_TAG;
        const alreadyInstalled = toDev || (entry && entry.installed);

        const startPoint = el('version-target-from');
        const endPoint = el('version-target-to');
        if (startPoint) startPoint.textContent = versionLabel(currentVersion);
        if (endPoint) {
            endPoint.textContent = toDev
                ? t('version_option_dev', 'DEV — code local')
                : tag;
        }

        const description = el('version-modal-desc');
        if (description) {
            description.textContent = alreadyInstalled
                ? t('version_modal_desc_installed', 'Cette version est déjà présente sur votre PC : le bot va simplement redémarrer dessus.')
                : t('version_modal_desc', "Le bot va télécharger cette version, l'installer à côté des autres, puis redémarrer dessus.");
        }

        const note = el('version-modal-note');
        if (note) {
            note.textContent = toDev
                ? t('version_note_dev', "La version de développement n'est jamais modifiée ni écrasée par ce système.")
                : t('version_note_keep', 'Votre version actuelle est conservée intacte : rien n\'est jamais écrasé.');
            note.classList.toggle('is-warning', toDev);
        }

        const buttonLabel = el('btn-version-confirm-label');
        if (buttonLabel) {
            buttonLabel.textContent = alreadyInstalled
                ? t('version_btn_switch', 'Redémarrer sur cette version')
                : t('version_btn_install', 'Télécharger et installer');
        }

        const confirmBtn = el('btn-version-confirm');
        const cancelBtn = el('btn-version-cancel');
        if (confirmBtn) confirmBtn.disabled = false;
        if (cancelBtn) cancelBtn.disabled = false;

        showProgress(false);
        updateProgress('', null, '');
        modal.classList.remove('hidden');
    }

    function closePopup(restoreSelection = true) {
        const modal = el('version-modal');
        if (modal) modal.classList.add('hidden');
        pendingTag = null;
        toggleEngaged = false;
        if (restoreSelection) reselectCurrent();
    }

    function confirmToggle() {
        if (!pendingTag || toggleEngaged) return;

        toggleEngaged = true;
        const confirmBtn = el('btn-version-confirm');
        const cancelBtn = el('btn-version-cancel');
        if (confirmBtn) confirmBtn.disabled = true;
        // L'annulation n'a plus de sens une fois la bascule lancée : elle se
        // termine par un redémarrage que le tableau de bord ne peut pas retenir.
        if (cancelBtn) cancelBtn.disabled = true;

        showProgress(true);
        updateProgress(t('version_phase_search', 'Recherche de la version…'), null, '');

        if (typeof window.MusicPlayer.sendWS === 'function') {
            window.MusicPlayer.sendWS({ type: 'installVersion', data: { tag: pendingTag } });
        }
    }

    /* ─────────────────────── Désinstallation ─────────────────────── */

    function openUninstallPopup(tag) {
        const modal = el('version-uninstall-modal');
        if (!modal || !tag || tag === DEV_TAG) return;
        // Une bascule en cours se termine par un redémarrage : rien d'autre ne
        // doit toucher au dossier des versions entre-temps.
        if (toggleEngaged) return;

        tagToUninstall = tag;
        uninstallStarted = false;

        const targetEl = el('version-uninstall-tag');
        if (targetEl) targetEl.textContent = tag;

        const confirmBtn = el('btn-version-uninstall-confirm');
        const cancelBtn = el('btn-version-uninstall-cancel');
        if (confirmBtn) confirmBtn.disabled = false;
        if (cancelBtn) cancelBtn.disabled = false;

        modal.classList.remove('hidden');
    }

    function closeUninstallPopup() {
        const modal = el('version-uninstall-modal');
        if (modal) modal.classList.add('hidden');
        tagToUninstall = null;
        uninstallStarted = false;
    }

    function confirmUninstall() {
        if (!tagToUninstall || uninstallStarted) return;

        uninstallStarted = true;
        const confirmBtn = el('btn-version-uninstall-confirm');
        const cancelBtn = el('btn-version-uninstall-cancel');
        // La suppression est brève : plutôt qu'une barre de progression, les
        // boutons se neutralisent le temps de la réponse du serveur.
        if (confirmBtn) confirmBtn.disabled = true;
        if (cancelBtn) cancelBtn.disabled = true;

        if (typeof window.MusicPlayer.sendWS === 'function') {
            window.MusicPlayer.sendWS({ type: 'uninstallVersion', data: { tag: tagToUninstall } });
        }
    }

    /* ──────────────────── Messages du serveur ──────────────────── */

    window.MusicPlayer.onVersionCatalog = function (data) {
        catalog = data || null;
        if (catalog && catalog.current) currentVersion = catalog.current;
        paintCurrentVersion();
        paintCatalog();
    };

    /**
     * Verdict d'une désinstallation.
     *
     * Diffusé à tous les onglets : celui qui n'a rien demandé n'a pas de
     * pop-up ouvert, et `fermerPopupDesinstallation()` y est sans effet. Le
     * catalogue frais qui suit se charge de retirer l'entrée de son menu.
     */
    window.MusicPlayer.onVersionRemoved = function (data) {
        const failed = !(data && data.ok);
        const message = (data && data.message) || '';

        if (failed) {
            uninstallStarted = false;
            const confirmBtn = el('btn-version-uninstall-confirm');
            const cancelBtn = el('btn-version-uninstall-cancel');
            if (confirmBtn) confirmBtn.disabled = false;
            if (cancelBtn) cancelBtn.disabled = false;
            if (typeof window.MusicPlayer.showToast === 'function') {
                window.MusicPlayer.showToast(message || t('version_uninstall_failed', 'La désinstallation a échoué.'));
            }
            return;
        }

        closeUninstallPopup();
        if (typeof window.MusicPlayer.showToast === 'function') {
            window.MusicPlayer.showToast(
                t('version_uninstalled', 'Version désinstallée.').replace('{tag}', (data && data.tag) || '')
            );
        }
    };

    window.MusicPlayer.onVersionProgress = function (data) {
        const phase = (data && data.phase) || '';

        if (phase === 'error') {
            toggleEngaged = false;
            showProgress(true);
            updateProgress(t('version_phase_error', 'Échec'), null, (data && data.message) || '', true);
            const confirmBtn = el('btn-version-confirm');
            const cancelBtn = el('btn-version-cancel');
            if (confirmBtn) confirmBtn.disabled = false;
            if (cancelBtn) cancelBtn.disabled = false;
            if (typeof window.MusicPlayer.showToast === 'function') {
                window.MusicPlayer.showToast((data && data.message) || t('version_phase_error', 'Échec'));
            }
            return;
        }

        if (phase === 'already') {
            closePopup();
            if (typeof window.MusicPlayer.showToast === 'function') {
                window.MusicPlayer.showToast(t('version_already_running', 'Cette version est déjà celle qui tourne.'));
            }
            return;
        }

        showProgress(true);

        if (phase === 'search') {
            updateProgress(t('version_phase_search', 'Recherche de la version…'), null, '');
        } else if (phase === 'download') {
            const percent = Number.isFinite(data.percent) ? data.percent : null;
            const received = formatBytes(data.bytes);
            const total = formatBytes(data.total);
            const detail = received ? (total ? `${received} / ${total}` : received) : '';
            updateProgress(
                `${t('version_phase_download', 'Téléchargement')}${percent !== null ? ` ${percent} %` : ''}`,
                percent,
                detail
            );
        } else if (phase === 'extraction') {
            updateProgress(t('version_phase_extract', 'Extraction des fichiers…'), null, '');
        } else if (phase === 'dependencies') {
            updateProgress(
                t('version_phase_deps', 'Installation des dépendances…'),
                null,
                (data && data.message) || ''
            );
        } else if (phase === 'restart') {
            updateProgress(t('version_phase_restart', 'Redémarrage du bot…'), 100, '');
        }
    };

    /* ──────────────────────── Initialisation ──────────────────────── */

    /**
     * Branche le menu déroulant. Appelée par app.js une fois le CustomSelect
     * construit : c'est lui qui porte le déclencheur cliquable, le `<select>`
     * natif étant masqué.
     */
    window.MusicPlayer.initVersions = function () {
        const select = selectEl();
        if (!select || select.dataset.versionsInit) return;
        select.dataset.versionsInit = 'true';

        const container = select._customSelect && select._customSelect.container;
        if (container) {
            // Chaque ouverture du menu relance la recherche : une release
            // publiée à l'instant doit apparaître sans recharger la page.
            const trigger = container.querySelector('.custom-select-trigger');
            if (trigger) {
                trigger.addEventListener('click', () => {
                    // Le CustomSelect a déjà basculé son état au moment où ce
                    // gestionnaire s'exécute : ne relancer la recherche que si le
                    // clic vient d'ouvrir le menu, et non de le refermer.
                    if (container.classList.contains('open')) requestCatalog();
                });
            }
        }

        select.addEventListener('change', () => {
            const tag = select.value;
            if (!tag || tag.startsWith('__')) return reselectCurrent();
            if (currentVersion && tag === currentVersion.tag) return;
            openPopup(tag);
        });

        const confirmBtn = el('btn-version-confirm');
        if (confirmBtn) confirmBtn.addEventListener('click', confirmToggle);

        const cancelBtn = el('btn-version-cancel');
        if (cancelBtn) cancelBtn.addEventListener('click', () => closePopup());

        // Corbeille d'une entrée du menu : le composant ne sait que signaler le
        // geste, c'est ici qu'il prend le sens d'une désinstallation.
        select.addEventListener('option-remove', (e) => {
            openUninstallPopup(e.detail && e.detail.value);
        });

        const uninstallBtn = el('btn-version-uninstall-confirm');
        if (uninstallBtn) uninstallBtn.addEventListener('click', confirmUninstall);

        const cancelUninstall = el('btn-version-uninstall-cancel');
        if (cancelUninstall) {
            cancelUninstall.addEventListener('click', closeUninstallPopup);
        }

        /*
         * Le clic à côté referme, comme partout ailleurs — mais en passant par
         * `closeVersionModal`, et non en posant la classe soi-même.
         *
         * Ces deux fenêtres-ci ne sont pas de simples voiles. Elles refusent de
         * disparaître pendant une bascule ou une désinstallation engagée :
         * masquer la fenêtre n'annulerait rien, cela ne ferait que dérober à
         * l'utilisateur l'avancement de ce qu'il a lancé. Et la fermeture
         * ordinaire remet le menu déroulant sur la version réellement exécutée,
         * sans quoi il resterait sur celle qu'on a renoncé à installer.
         *
         * Toute cette logique vit déjà dans `closeVersionModal`, appelée par la
         * touche Échap. Le clic emprunte le même chemin plutôt que d'en ouvrir
         * un second, qui aurait divergé au premier changement de règle.
         *
         * La cible doit être le voile lui-même : l'événement remonte depuis la
         * boîte, et l'écouter sans ce test annulerait la bascule au moment même
         * où l'on clique « Confirmer ».
         */
        [el('version-modal'), el('version-uninstall-modal')].forEach((overlay) => {
            if (!overlay) return;
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) window.MusicPlayer.closeVersionModal();
            });
        });

        paintCurrentVersion();
    };

    /**
     * Le bot est joignable : on relit la version exécutée — après un
     * redémarrage, elle a pu changer.
     *
     * C'est aussi le seul signal fiable de fin d'une bascule : le pop-up était
     * resté ouvert sous le voile de redémarrage, il n'a plus lieu d'être une
     * fois la nouvelle instance en ligne. Au chargement de la page, où rien
     * n'est ouvert, ce nettoyage est sans effet.
     */
    window.MusicPlayer.refreshVersionBadge = async function () {
        await refreshCurrentVersion();
        toggleEngaged = false;
        const modal = el('version-modal');
        if (modal && !modal.classList.contains('hidden')) closePopup();
        closeUninstallPopup();
    };

    /**
     * Fermeture depuis l'extérieur (touche Échap du gestionnaire global).
     * Sans effet tant qu'une bascule ou une désinstallation est engagée.
     *
     * @returns {boolean} `true` si un pop-up a été fermé — le gestionnaire
     *   global s'arrête alors là, plutôt que de fermer du même coup la fenêtre
     *   des paramètres qui se trouve juste derrière.
     */
    window.MusicPlayer.closeVersionModal = function () {
        const uninstallModal = el('version-uninstall-modal');
        if (uninstallModal && !uninstallModal.classList.contains('hidden')) {
            if (uninstallStarted) return true;
            closeUninstallPopup();
            return true;
        }

        const modal = el('version-modal');
        if (!modal || modal.classList.contains('hidden')) return false;
        if (toggleEngaged) return true;
        closePopup();
        return true;
    };

    function startVersions() {
        bindVersionCopy();
        refreshCurrentVersion();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startVersions);
    } else {
        startVersions();
    }
})();
