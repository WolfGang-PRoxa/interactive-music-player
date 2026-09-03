window.MusicPlayer = window.MusicPlayer || {};

/**
 * downloadTarget — La quatrième destination de la boîte d'ajout, et son dossier.
 *
 * Les trois autres mènent au lecteur ; celle-ci écrit un fichier sur le disque
 * du bot et s'arrête là. Elle a donc besoin d'une chose que les autres n'ont
 * pas : savoir où.
 *
 * Ce dossier est retenu **par le bot**, et non dans le navigateur. C'est une
 * propriété de la machine qui héberge, pas de l'onglet qui regarde : deux
 * appareils pilotant le même bot doivent voir la même destination, et un
 * changement d'appareil ne doit pas la faire oublier. Le stockage local n'aurait
 * su tenir ni l'une ni l'autre de ces deux exigences.
 *
 * Le libellé de l'option suit le dossier, ce qui évite d'avoir à l'ouvrir pour
 * savoir où les fichiers tombent — la question qu'on se pose au moment de
 * cliquer, pas trois écrans plus loin.
 */
(function () {
    /** Ce que le bot rapporte du dossier courant. */
    let current = { dir: '', defaultDir: '', isDefault: true };

    /** Dossier affiché par l'explorateur, qui n'est pas encore le choix. */
    let browsing = null;

    let select = null;
    let modal = null;

    const el = (id) => document.getElementById(id);
    const t = (key, fallback) => {
        const translate = window.MusicPlayer.t;
        const value = typeof translate === 'function' ? translate(key) : null;
        return value && value !== key ? value : fallback;
    };

    // ─────────────────────── Libellé de l'option ───────────────────────

    /**
     * Réécrit « Vers … » avec le dossier courant.
     *
     * Le chemin par défaut est montré sous sa forme relative — « data/downloads/ »
     * plutôt que « C:\Users\…\data\downloads » : c'est ainsi qu'il est nommé
     * partout ailleurs, et l'absolu n'apprendrait rien à qui n'a rien choisi.
     */
    function paintOption() {
        if (!select) return;
        const option = select.querySelector('option[value="download"]');
        if (!option) return;

        const shown = current.isDefault ? 'data/downloads/' : current.dir;
        option.textContent = t('add_target_download', 'Vers {path}').replace('{path}', shown);

        /*
         * L'infobulle du bouton est posée ici, et non dans le balisage.
         *
         * js/customSelect.js la lit sur `data-action-tooltip` au moment de
         * construire le bouton — un attribut brut, hors de portée du système de
         * traduction, qui ne connaît que `data-i18n-tooltip` et ne visite que
         * les éléments présents dans le document. Le bouton, lui, n'existe que
         * le temps que le menu est déployé.
         */
        option.dataset.actionTooltip = t('tooltip_pick_download_dir',
            'Choisir le dossier de téléchargement');
        // Le menu déroulant du tableau de bord ne relit pas le <select> tout
        // seul : sa signature interne inclut le texte des options, et `sync`
        // est ce qui la recalcule.
        if (select._customSelect) select._customSelect.sync();
    }

    async function loadCurrent() {
        try {
            const res = await fetch('/api/download-dir');
            if (!res.ok) return;
            current = await res.json();
            paintOption();
        } catch (e) {
            // Le bot ne répond pas : l'option garde son libellé de repli, et le
            // reste du tableau de bord n'a pas à en souffrir.
        }
    }

    // ─────────────────────── Explorateur ───────────────────────

    function renderList(payload) {
        const list = el('dir-browser-list');
        const pathLabel = el('dir-browser-path');
        const upBtn = el('btn-dir-up');
        const warning = el('dir-browser-warning');
        if (!list) return;

        browsing = payload;
        if (pathLabel) pathLabel.textContent = payload.path || '';
        if (upBtn) upBtn.disabled = !payload.parent;

        renderRoots(payload);

        if (warning) {
            /*
             * Deux avertissements pour un même emplacement, dans l'ordre où ils
             * comptent.
             *
             * Le dossier disparu vient en premier : il explique pourquoi on ne
             * se trouve pas là où l'on croyait, et sans lui l'utilisateur
             * ouvrirait le sélecteur sur un dossier qu'il n'a pas demandé sans
             * comprendre ce qui s'est passé.
             *
             * L'écriture refusée vient ensuite. Elle se signale ici et non au
             * moment de valider : découvrir le refus après avoir cliqué
             * « Choisir » ferait chercher la faute ailleurs.
             */
            if (payload.requested) {
                warning.classList.remove('hidden');
                warning.textContent = t('download_dir_gone',
                    'Ce dossier n’est plus accessible : {path}').replace('{path}', payload.requested);
            } else if (payload.writable === false) {
                warning.classList.remove('hidden');
                warning.textContent = t('download_dir_not_writable',
                    'Ce dossier ne peut pas recevoir de fichiers.');
            } else {
                warning.classList.add('hidden');
            }
        }

        list.textContent = '';
        if (payload.dirs.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'dir-browser-empty';
            empty.textContent = t('download_dir_empty', 'Aucun sous-dossier.');
            list.appendChild(empty);
            return;
        }

        payload.dirs.forEach((entry) => {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'dir-browser-row';
            // `textContent` : ces noms viennent du disque, pas de nous.
            row.textContent = entry.name;
            row.addEventListener('click', () => browse(entry.path));
            list.appendChild(row);
        });
    }

    /**
     * Les racines, en pastilles au-dessus de la liste.
     *
     * Celle qui contient le dossier courant est mise en évidence : sur une
     * machine à quatre disques, savoir où l'on est vaut mieux que de le
     * déduire du chemin affiché en dessous.
     */
    function renderRoots(payload) {
        const bar = el('dir-browser-roots');
        if (!bar) return;

        bar.textContent = '';
        const roots = payload.roots || [];

        // Une seule racine — tout système autre que Windows — : la montrer
        // n'apprendrait rien, puisqu'il n'y a nulle part ailleurs où aller.
        if (roots.length < 2) return;

        const currentPath = (payload.path || '').toLowerCase();
        roots.forEach((root) => {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'dir-root-chip';
            if (currentPath.startsWith(root.toLowerCase())) chip.classList.add('is-current');
            chip.textContent = root.replace(/\$/, '');
            chip.addEventListener('click', () => browse(root));
            bar.appendChild(chip);
        });
    }

    async function browse(target) {
        try {
            const res = await fetch(`/api/browse-dirs?path=${encodeURIComponent(target || '')}`);
            const payload = await res.json();
            if (!res.ok) {
                // Le serveur remonte désormais lui-même au premier dossier
                // lisible : n'arrivent ici que les refus francs, chemin
                // malformé en tête.
                if (typeof window.MusicPlayer.showToast === 'function') {
                    window.MusicPlayer.showToast(t('download_dir_err_invalid', 'Chemin invalide.'));
                }
                return;
            }
            renderList(payload);
            const manual = el('input-download-dir');
            if (manual) manual.value = payload.path;
        } catch (e) {
            // Réseau coupé : la liste reste sur son dernier état, qui est
            // encore la meilleure information disponible.
        }
    }

    async function commit(dir) {
        try {
            const res = await fetch('/api/download-dir', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ dir }),
            });
            const payload = await res.json();

            if (!res.ok) {
                const reasons = {
                    missing: t('download_dir_err_missing', 'Ce dossier n’existe pas.'),
                    notADirectory: t('download_dir_err_not_dir', 'Ce chemin n’est pas un dossier.'),
                    notWritable: t('download_dir_err_not_writable', 'Ce dossier refuse l’écriture.'),
                    invalid: t('download_dir_err_invalid', 'Chemin invalide.'),
                };
                const message = reasons[payload.error] || reasons.invalid;
                if (typeof window.MusicPlayer.showToast === 'function') {
                    window.MusicPlayer.showToast(message);
                }
                return;
            }

            current = { ...current, dir: payload.dir, isDefault: payload.isDefault };
            paintOption();
            if (modal) modal.classList.add('hidden');
        } catch (e) {
            if (typeof window.MusicPlayer.showToast === 'function') {
                window.MusicPlayer.showToast(t('download_dir_err_invalid', 'Chemin invalide.'));
            }
        }
    }

    // ─────────────────────── Branchement ───────────────────────

    function init() {
        select = el('add-target-select');
        modal = el('download-dir-modal');
        if (!select) return;

        loadCurrent();

        /*
         * Le bouton vit dans l'option elle-même, à droite de sa ligne : c'est
         * js/customSelect.js qui le pose, à partir du `data-action` du
         * balisage, et qui émet cet événement quand on le presse. Rien à
         * chercher dans le document — le bouton n'existe que le temps que le
         * menu est déployé, et le viser par son identifiant obligerait à le
         * retrouver après chaque redessin.
         */
        if (modal) {
            select.addEventListener('option-action', (e) => {
                if (!e.detail || e.detail.action !== 'folder') return;
                modal.classList.remove('hidden');
                browse(current.isDefault ? current.defaultDir : current.dir);
            });
        }

        const closeBtn = el('btn-close-download-dir');
        if (closeBtn && modal) {
            closeBtn.addEventListener('click', () => modal.classList.add('hidden'));
        }

        if (modal) {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) modal.classList.add('hidden');
            });
        }

        const upBtn = el('btn-dir-up');
        if (upBtn) {
            upBtn.addEventListener('click', () => {
                if (browsing && browsing.parent) browse(browsing.parent);
            });
        }

        const saveBtn = el('btn-download-dir-save');
        if (saveBtn) {
            saveBtn.addEventListener('click', () => {
                // Le champ prime sur la liste : c'est le dernier geste de
                // l'utilisateur, et c'est par lui qu'on désigne un disque que
                // l'explorateur ne sait pas atteindre.
                const manual = el('input-download-dir');
                const typed = manual ? manual.value.trim() : '';
                commit(typed || (browsing ? browsing.path : ''));
            });
        }

        const resetBtn = el('btn-download-dir-reset');
        if (resetBtn) resetBtn.addEventListener('click', () => commit(''));

        const manual = el('input-download-dir');
        if (manual) {
            manual.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                browse(manual.value.trim());
            });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    /**
     * Repeint l'option — appelé au changement de langue par js/state.js.
     *
     * Sans requête : le dossier n'a pas changé, seuls les mots qui l'entourent.
     * Aller le redemander au bot à chaque bascule de langue serait un
     * aller-retour pour rien.
     */
    window.MusicPlayer.refreshDownloadTarget = paintOption;

    /** Relit le dossier auprès du bot, quand il a pu changer ailleurs. */
    window.MusicPlayer.reloadDownloadTarget = loadCurrent;
})();
