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

    const TAG_DEV = 'dev';

    /** Version en cours d'exécution, telle que servie par /api/version. */
    let versionCourante = null;
    /** Dernier catalogue reçu, pour retrouver une release à partir de son tag. */
    let catalogue = null;
    /** Tag en attente de confirmation dans le pop-up. */
    let tagEnAttente = null;
    /** Une bascule est engagée : les boutons du pop-up sont neutralisés. */
    let basculeEngagee = false;
    /** Tag en attente de confirmation dans le pop-up de désinstallation. */
    let tagADesinstaller = null;
    /** Une désinstallation est engagée : sa confirmation est neutralisée. */
    let desinstallationEngagee = false;

    function t(cle, defaut) {
        const traduit = typeof window.MusicPlayer.t === 'function' ? window.MusicPlayer.t(cle) : cle;
        // `t()` renvoie la clé elle-même quand la traduction manque.
        return traduit && traduit !== cle ? traduit : (defaut !== undefined ? defaut : cle);
    }

    function el(id) {
        return document.getElementById(id);
    }

    function formaterOctets(octets) {
        if (!Number.isFinite(octets) || octets <= 0) return '';
        if (octets < 1024 * 1024) return `${(octets / 1024).toFixed(0)} Ko`;
        return `${(octets / 1024 / 1024).toFixed(1)} Mo`;
    }

    /** Libellé lisible d'une version, DEV compris. */
    function libelleVersion(version) {
        if (!version) return '—';
        if (version.type === 'dev' || version.tag === TAG_DEV) {
            return version.versionPackage
                ? `${t('version_dev_short', 'DEV')} (${version.versionPackage})`
                : t('version_dev_short', 'DEV');
        }
        return version.tag;
    }

    /* ───────────────────────── Pied du tiroir ───────────────────────── */

    function peindreVersionCourante() {
        const valeur = el('drawer-version-value');
        if (valeur) {
            valeur.textContent = libelleVersion(versionCourante);
            valeur.classList.toggle('is-dev', !!versionCourante && versionCourante.type === 'dev');
        }

        const indice = el('version-current-hint');
        if (indice) {
            indice.textContent = versionCourante
                ? `${t('version_current_prefix', 'Actuelle :')} ${libelleVersion(versionCourante)}`
                : '';
        }
    }

    /**
     * Relit la version exécutée.
     *
     * Servie en HTTP plutôt que par l'état WebSocket : elle ne dépend d'aucun
     * serveur Discord sélectionné, et le tiroir doit pouvoir l'afficher dès le
     * chargement de la page.
     */
    async function rafraichirVersionCourante() {
        try {
            const reponse = await fetch('/api/version', { credentials: 'same-origin' });
            if (!reponse.ok) return;
            versionCourante = await reponse.json();
            peindreVersionCourante();
        } catch (e) {
            // Serveur injoignable : le pied garde sa dernière valeur connue.
        }
    }

    /* ─────────────────────── Menu déroulant ─────────────────────── */

    function selecteur() {
        return el('setting-version-select');
    }

    function synchroniserMenu() {
        const select = selecteur();
        if (select && select._customSelect) select._customSelect.sync(true);
    }

    function ajouterOption(select, valeur, texte, options = {}) {
        const option = document.createElement('option');
        option.value = valeur;
        option.textContent = texte;
        if (options.disabled) option.disabled = true;
        if (options.selected) option.selected = true;
        // `data-removable` fait naître une corbeille sur l'entrée du menu
        // personnalisé, qui émet `option-remove` sans rien savoir de ce qu'elle
        // retire (voir js/customSelect.js).
        if (options.retirable) {
            option.dataset.removable = 'true';
            option.dataset.removeTooltip = t('version_tooltip_uninstall', 'Désinstaller cette version');
        }
        select.appendChild(option);
        return option;
    }

    /** Menu réduit à la version courante, le temps d'interroger le dépôt. */
    function afficherRecherche() {
        const select = selecteur();
        if (!select) return;

        select.innerHTML = '';
        const tagCourant = versionCourante ? versionCourante.tag : TAG_DEV;
        ajouterOption(select, tagCourant, libelleVersion(versionCourante), { selected: true });
        ajouterOption(select, '__recherche__', t('version_searching', 'Recherche des versions…'), { disabled: true });
        synchroniserMenu();
    }

    /** Suffixes d'une entrée : état d'installation, préversion, version active. */
    function decrireRelease(entree) {
        const parts = [];
        if (entree.courante) parts.push(t('version_tag_current', 'actuelle'));
        parts.push(
            entree.installee
                ? t('version_tag_installed', 'installée')
                : t('version_tag_downloadable', 'à télécharger')
        );
        if (entree.prerelease) parts.push(t('version_tag_prerelease', 'préversion'));
        return `${entree.tag} · ${parts.join(' · ')}`;
    }

    function peindreCatalogue() {
        const select = selecteur();
        if (!select || !catalogue) return;

        const tagCourant = catalogue.courante ? catalogue.courante.tag : TAG_DEV;
        select.innerHTML = '';

        if (catalogue.dev && catalogue.dev.disponible) {
            const suffixe = catalogue.dev.courante ? ` · ${t('version_tag_current', 'actuelle')}` : '';
            ajouterOption(
                select,
                TAG_DEV,
                `${t('version_option_dev', 'DEV — code local')}${
                    catalogue.dev.versionPackage ? ` (${catalogue.dev.versionPackage})` : ''
                }${suffixe}`,
                { selected: tagCourant === TAG_DEV }
            );
        }

        (catalogue.releases || []).forEach((entree) => {
            ajouterOption(select, entree.tag, decrireRelease(entree), {
                selected: entree.tag === tagCourant,
                // Seule une version présente sur le disque se désinstalle, et
                // jamais celle qui tourne : le serveur refuserait de toute
                // façon, autant ne pas proposer le geste.
                retirable: entree.installee && !entree.courante,
            });
        });

        // Ni release ni erreur : le dépôt n'a simplement rien publié.
        if (!(catalogue.releases || []).length && !catalogue.erreur) {
            ajouterOption(select, '__vide__', t('version_none_published', 'Aucune release publiée sur le dépôt'), {
                disabled: true,
            });
        }

        // L'échec de la consultation est affiché dans le menu lui-même : c'est
        // là que l'utilisateur attend une réponse, et une liste vide sans
        // explication passerait pour un dépôt sans release.
        if (catalogue.erreur) {
            ajouterOption(select, '__erreur__', `⚠ ${catalogue.erreur.message}`, { disabled: true });
        }

        synchroniserMenu();
    }

    function demanderCatalogue() {
        if (basculeEngagee) return;

        // `sendWS` ignore silencieusement un envoi hors connexion : sans cette
        // vérification, le menu resterait bloqué sur « Recherche… » sans que
        // rien n'explique pourquoi.
        const socket = window.MusicPlayer.socket;
        if (!socket || socket.readyState !== WebSocket.OPEN) {
            catalogue = {
                courante: versionCourante,
                dev: { tag: TAG_DEV, disponible: true, courante: !versionCourante || versionCourante.type === 'dev' },
                releases: [],
                erreur: { message: t('version_offline', 'Bot injoignable : impossible de consulter les versions.') },
            };
            peindreCatalogue();
            return;
        }

        afficherRecherche();
        window.MusicPlayer.sendWS({ type: 'listVersions' });
    }

    /** Ramène la sélection sur la version exécutée, après annulation. */
    function reselectionnerCourante() {
        const select = selecteur();
        if (!select) return;
        const tagCourant = versionCourante ? versionCourante.tag : TAG_DEV;
        if (Array.from(select.options).some((o) => o.value === tagCourant)) {
            select.value = tagCourant;
        }
        synchroniserMenu();
    }

    /* ──────────────────────────── Pop-up ──────────────────────────── */

    function afficherProgression(visible) {
        const bloc = el('version-progress');
        if (bloc) bloc.classList.toggle('hidden', !visible);
    }

    function majProgression(phase, pourcent, detail, estErreur = false) {
        const phaseEl = el('version-progress-phase');
        const fill = el('version-progress-fill');
        const detailEl = el('version-progress-detail');

        if (phaseEl) phaseEl.textContent = phase;
        if (fill) {
            const chiffrable = Number.isFinite(pourcent);
            fill.classList.toggle('indetermine', !chiffrable && !estErreur);
            fill.style.width = chiffrable ? `${Math.max(0, Math.min(100, pourcent))}%` : '';
            if (estErreur) fill.style.width = '0';
        }
        if (detailEl) {
            detailEl.textContent = detail || '';
            detailEl.classList.toggle('is-error', !!estErreur);
        }
    }

    function ouvrirPopup(tag) {
        const modal = el('version-modal');
        if (!modal) return;

        tagEnAttente = tag;
        basculeEngagee = false;

        const entree = (catalogue && (catalogue.releases || []).find((r) => r.tag === tag)) || null;
        const versDev = tag === TAG_DEV;
        const dejaInstallee = versDev || (entree && entree.installee);

        const depart = el('version-target-from');
        const arrivee = el('version-target-to');
        if (depart) depart.textContent = libelleVersion(versionCourante);
        if (arrivee) {
            arrivee.textContent = versDev
                ? t('version_option_dev', 'DEV — code local')
                : tag;
        }

        const description = el('version-modal-desc');
        if (description) {
            description.textContent = dejaInstallee
                ? t('version_modal_desc_installed', 'Cette version est déjà présente sur votre PC : le bot va simplement redémarrer dessus.')
                : t('version_modal_desc', "Le bot va télécharger cette version, l'installer à côté des autres, puis redémarrer dessus.");
        }

        const note = el('version-modal-note');
        if (note) {
            note.textContent = versDev
                ? t('version_note_dev', "La version de développement n'est jamais modifiée ni écrasée par ce système.")
                : t('version_note_keep', 'Votre version actuelle est conservée intacte : rien n\'est jamais écrasé.');
            note.classList.toggle('is-warning', versDev);
        }

        const libelleBouton = el('btn-version-confirm-label');
        if (libelleBouton) {
            libelleBouton.textContent = dejaInstallee
                ? t('version_btn_switch', 'Redémarrer sur cette version')
                : t('version_btn_install', 'Télécharger et installer');
        }

        const confirmer = el('btn-version-confirm');
        const annuler = el('btn-version-cancel');
        if (confirmer) confirmer.disabled = false;
        if (annuler) annuler.disabled = false;

        afficherProgression(false);
        majProgression('', null, '');
        modal.classList.remove('hidden');
    }

    function fermerPopup(retablirSelection = true) {
        const modal = el('version-modal');
        if (modal) modal.classList.add('hidden');
        tagEnAttente = null;
        basculeEngagee = false;
        if (retablirSelection) reselectionnerCourante();
    }

    function confirmerBascule() {
        if (!tagEnAttente || basculeEngagee) return;

        basculeEngagee = true;
        const confirmer = el('btn-version-confirm');
        const annuler = el('btn-version-cancel');
        if (confirmer) confirmer.disabled = true;
        // L'annulation n'a plus de sens une fois la bascule lancée : elle se
        // termine par un redémarrage que le tableau de bord ne peut pas retenir.
        if (annuler) annuler.disabled = true;

        afficherProgression(true);
        majProgression(t('version_phase_search', 'Recherche de la version…'), null, '');

        if (typeof window.MusicPlayer.sendWS === 'function') {
            window.MusicPlayer.sendWS({ type: 'installVersion', data: { tag: tagEnAttente } });
        }
    }

    /* ─────────────────────── Désinstallation ─────────────────────── */

    function ouvrirPopupDesinstallation(tag) {
        const modal = el('version-uninstall-modal');
        if (!modal || !tag || tag === TAG_DEV) return;
        // Une bascule en cours se termine par un redémarrage : rien d'autre ne
        // doit toucher au dossier des versions entre-temps.
        if (basculeEngagee) return;

        tagADesinstaller = tag;
        desinstallationEngagee = false;

        const cible = el('version-uninstall-tag');
        if (cible) cible.textContent = tag;

        const confirmer = el('btn-version-uninstall-confirm');
        const annuler = el('btn-version-uninstall-cancel');
        if (confirmer) confirmer.disabled = false;
        if (annuler) annuler.disabled = false;

        modal.classList.remove('hidden');
    }

    function fermerPopupDesinstallation() {
        const modal = el('version-uninstall-modal');
        if (modal) modal.classList.add('hidden');
        tagADesinstaller = null;
        desinstallationEngagee = false;
    }

    function confirmerDesinstallation() {
        if (!tagADesinstaller || desinstallationEngagee) return;

        desinstallationEngagee = true;
        const confirmer = el('btn-version-uninstall-confirm');
        const annuler = el('btn-version-uninstall-cancel');
        // La suppression est brève : plutôt qu'une barre de progression, les
        // boutons se neutralisent le temps de la réponse du serveur.
        if (confirmer) confirmer.disabled = true;
        if (annuler) annuler.disabled = true;

        if (typeof window.MusicPlayer.sendWS === 'function') {
            window.MusicPlayer.sendWS({ type: 'uninstallVersion', data: { tag: tagADesinstaller } });
        }
    }

    /* ──────────────────── Messages du serveur ──────────────────── */

    window.MusicPlayer.onVersionCatalog = function (data) {
        catalogue = data || null;
        if (catalogue && catalogue.courante) versionCourante = catalogue.courante;
        peindreVersionCourante();
        peindreCatalogue();
    };

    /**
     * Verdict d'une désinstallation.
     *
     * Diffusé à tous les onglets : celui qui n'a rien demandé n'a pas de
     * pop-up ouvert, et `fermerPopupDesinstallation()` y est sans effet. Le
     * catalogue frais qui suit se charge de retirer l'entrée de son menu.
     */
    window.MusicPlayer.onVersionRemoved = function (data) {
        const echec = !(data && data.ok);
        const message = (data && data.message) || '';

        if (echec) {
            desinstallationEngagee = false;
            const confirmer = el('btn-version-uninstall-confirm');
            const annuler = el('btn-version-uninstall-cancel');
            if (confirmer) confirmer.disabled = false;
            if (annuler) annuler.disabled = false;
            if (typeof window.MusicPlayer.showToast === 'function') {
                window.MusicPlayer.showToast(message || t('version_uninstall_failed', 'La désinstallation a échoué.'));
            }
            return;
        }

        fermerPopupDesinstallation();
        if (typeof window.MusicPlayer.showToast === 'function') {
            window.MusicPlayer.showToast(
                t('version_uninstalled', 'Version désinstallée.').replace('{tag}', (data && data.tag) || '')
            );
        }
    };

    window.MusicPlayer.onVersionProgress = function (data) {
        const phase = (data && data.phase) || '';

        if (phase === 'erreur') {
            basculeEngagee = false;
            afficherProgression(true);
            majProgression(t('version_phase_error', 'Échec'), null, (data && data.message) || '', true);
            const confirmer = el('btn-version-confirm');
            const annuler = el('btn-version-cancel');
            if (confirmer) confirmer.disabled = false;
            if (annuler) annuler.disabled = false;
            if (typeof window.MusicPlayer.showToast === 'function') {
                window.MusicPlayer.showToast((data && data.message) || t('version_phase_error', 'Échec'));
            }
            return;
        }

        if (phase === 'deja') {
            fermerPopup();
            if (typeof window.MusicPlayer.showToast === 'function') {
                window.MusicPlayer.showToast(t('version_already_running', 'Cette version est déjà celle qui tourne.'));
            }
            return;
        }

        afficherProgression(true);

        if (phase === 'recherche') {
            majProgression(t('version_phase_search', 'Recherche de la version…'), null, '');
        } else if (phase === 'telechargement') {
            const pourcent = Number.isFinite(data.pourcent) ? data.pourcent : null;
            const recus = formaterOctets(data.octets);
            const total = formaterOctets(data.total);
            const detail = recus ? (total ? `${recus} / ${total}` : recus) : '';
            majProgression(
                `${t('version_phase_download', 'Téléchargement')}${pourcent !== null ? ` ${pourcent} %` : ''}`,
                pourcent,
                detail
            );
        } else if (phase === 'extraction') {
            majProgression(t('version_phase_extract', 'Extraction des fichiers…'), null, '');
        } else if (phase === 'dependances') {
            majProgression(
                t('version_phase_deps', 'Installation des dépendances…'),
                null,
                (data && data.message) || ''
            );
        } else if (phase === 'redemarrage') {
            majProgression(t('version_phase_restart', 'Redémarrage du bot…'), 100, '');
        }
    };

    /* ──────────────────────── Initialisation ──────────────────────── */

    /**
     * Branche le menu déroulant. Appelée par app.js une fois le CustomSelect
     * construit : c'est lui qui porte le déclencheur cliquable, le `<select>`
     * natif étant masqué.
     */
    window.MusicPlayer.initVersions = function () {
        const select = selecteur();
        if (!select || select.dataset.versionsInit) return;
        select.dataset.versionsInit = 'true';

        const conteneur = select._customSelect && select._customSelect.container;
        if (conteneur) {
            // Chaque ouverture du menu relance la recherche : une release
            // publiée à l'instant doit apparaître sans recharger la page.
            const declencheur = conteneur.querySelector('.custom-select-trigger');
            if (declencheur) {
                declencheur.addEventListener('click', () => {
                    // Le CustomSelect a déjà basculé son état au moment où ce
                    // gestionnaire s'exécute : ne relancer la recherche que si le
                    // clic vient d'ouvrir le menu, et non de le refermer.
                    if (conteneur.classList.contains('open')) demanderCatalogue();
                });
            }
        }

        select.addEventListener('change', () => {
            const tag = select.value;
            if (!tag || tag.startsWith('__')) return reselectionnerCourante();
            if (versionCourante && tag === versionCourante.tag) return;
            ouvrirPopup(tag);
        });

        const confirmer = el('btn-version-confirm');
        if (confirmer) confirmer.addEventListener('click', confirmerBascule);

        const annuler = el('btn-version-cancel');
        if (annuler) annuler.addEventListener('click', () => fermerPopup());

        // Corbeille d'une entrée du menu : le composant ne sait que signaler le
        // geste, c'est ici qu'il prend le sens d'une désinstallation.
        select.addEventListener('option-remove', (e) => {
            ouvrirPopupDesinstallation(e.detail && e.detail.value);
        });

        const desinstaller = el('btn-version-uninstall-confirm');
        if (desinstaller) desinstaller.addEventListener('click', confirmerDesinstallation);

        const annulerDesinstallation = el('btn-version-uninstall-cancel');
        if (annulerDesinstallation) {
            annulerDesinstallation.addEventListener('click', fermerPopupDesinstallation);
        }

        peindreVersionCourante();
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
        await rafraichirVersionCourante();
        basculeEngagee = false;
        const modal = el('version-modal');
        if (modal && !modal.classList.contains('hidden')) fermerPopup();
        fermerPopupDesinstallation();
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
        const desinstallation = el('version-uninstall-modal');
        if (desinstallation && !desinstallation.classList.contains('hidden')) {
            if (desinstallationEngagee) return true;
            fermerPopupDesinstallation();
            return true;
        }

        const modal = el('version-modal');
        if (!modal || modal.classList.contains('hidden')) return false;
        if (basculeEngagee) return true;
        fermerPopup();
        return true;
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', rafraichirVersionCourante);
    } else {
        rafraichirVersionCourante();
    }
})();
