window.MusicPlayer = window.MusicPlayer || {};

/**
 * searchHistory — L'historique du champ d'ajout, tenu par le tableau de bord.
 *
 * Le navigateur en proposait déjà un, et c'est ce qui posait problème : il est
 * rendu par le système, dans sa police et ses couleurs, sans rapport avec le
 * thème choisi — un rectangle blanc sous un tableau de bord sombre. Il retenait
 * en outre tout ce qui avait été tapé dans un champ portant cet identifiant,
 * quel que soit l'onglet, et n'offrait aucun moyen d'en retirer une entrée.
 *
 * Celui-ci est écrit à partir des variables de thème. Elles sont définies pour
 * les huit combinaisons de style et de teinte, si bien que le panneau suit les
 * quatre habillages sans une seule règle qui les nomme.
 *
 * Deux gestes le parcourent, et ils partagent le même index :
 *
 *  - **les flèches**, qui remplissent le champ à chaque déplacement — c'est la
 *    demande d'origine, et c'est aussi ce que fait la liste du navigateur ;
 *  - **le clic**, qui choisit directement.
 *
 * Remonter au-dessus de la première entrée ne laisse pas le champ dans l'état
 * de la dernière : il retrouve la saisie en cours, mise de côté au premier
 * déplacement. Sans cela, une frappe interrompue par une flèche serait perdue.
 */
(function () {
    /** Clé de stockage. Les entrées vivent dans le navigateur, pas sur le bot. */
    const STORAGE_KEY = 'searchInputHistory';

    /** Entrées conservées. Au-delà, les plus anciennes tombent. */
    const MAX_ENTRIES = 25;

    /**
     * Longueur maximale d'une entrée.
     *
     * Une URL de playlist avec ses paramètres de suivi dépasse allègrement le
     * millier de caractères. Vingt-cinq de cette taille rempliraient le
     * stockage pour un gain nul : au-delà de quelques centaines de signes,
     * l'entrée n'est de toute façon plus lisible dans le panneau.
     */
    const MAX_LENGTH = 400;

    /** Entrées, de la plus récente à la plus ancienne. */
    let entries = [];

    /** Entrées effectivement affichées, filtrées par la saisie. */
    let shown = [];

    /**
     * Entrée mise en évidence dans le panneau.
     * `-1` : aucune — le champ porte alors la saisie de l'utilisateur.
     */
    let highlighted = -1;

    /** La saisie mise de côté le temps d'un parcours aux flèches. */
    let draft = '';

    let input = null;
    let box = null;
    let panel = null;

    // ─────────────────────────── Stockage ───────────────────────────

    function load() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            const parsed = raw ? JSON.parse(raw) : [];
            entries = Array.isArray(parsed)
                ? parsed.filter((e) => typeof e === 'string' && e).slice(0, MAX_ENTRIES)
                : [];
        } catch (e) {
            // Stockage illisible ou refusé (navigation privée stricte) :
            // l'historique n'est pas une fonction dont l'absence doit empêcher
            // le champ de fonctionner.
            entries = [];
        }
    }

    function save() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
        } catch (e) {
            // Idem : un quota atteint ne doit rien interrompre.
        }
    }

    /**
     * Retient une saisie validée.
     *
     * Une entrée déjà connue remonte en tête au lieu d'être ajoutée deux fois :
     * un historique où le même lien figure douze fois n'aide personne.
     *
     * @param {string} value
     */
    function remember(value) {
        const clean = (value || '').trim();
        if (!clean || clean.length > MAX_LENGTH) return;

        const existing = entries.findIndex((e) => e === clean);
        if (existing !== -1) entries.splice(existing, 1);

        entries.unshift(clean);
        if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
        save();
    }

    function forget(value) {
        const at = entries.indexOf(value);
        if (at === -1) return;
        entries.splice(at, 1);
        save();
    }

    // ─────────────────────────── Panneau ───────────────────────────

    /**
     * Entrées correspondant à la saisie en cours.
     *
     * La recherche porte sur le contenu et non sur le début : on retrouve un
     * lien par le nom du morceau qu'il porte, ce qu'un filtre par préfixe
     * interdirait sur une URL, qui commence toujours pareil.
     */
    function matching(value) {
        const needle = (value || '').trim().toLowerCase();
        if (!needle) return entries.slice();
        return entries.filter((e) => e.toLowerCase().includes(needle));
    }

    /**
     * Place le panneau sous le champ.
     *
     * Les décalages sont lus sur le champ lui-même plutôt que d'être devinés :
     * la rangée se replie sur téléphone — le bouton « Ajouter » passe à la
     * ligne et le champ change alors de largeur —, et rien dans une feuille de
     * style ne saurait suivre cela sans dupliquer le point de rupture.
     *
     * `.search-box` est le parent positionné : les décalages du champ et ceux
     * du panneau se lisent donc dans le même repère.
     */
    function place() {
        panel.style.left = `${input.offsetLeft}px`;
        panel.style.top = `${input.offsetTop + input.offsetHeight + 6}px`;
        panel.style.width = `${input.offsetWidth}px`;
    }

    function isOpen() {
        return !panel.classList.contains('hidden');
    }

    function render() {
        panel.textContent = '';

        shown.forEach((value, index) => {
            const row = document.createElement('div');
            row.className = 'search-history-row';
            if (index === highlighted) row.classList.add('is-highlighted');

            const label = document.createElement('span');
            label.className = 'search-history-label';
            // `textContent`, jamais `innerHTML` : ces chaînes viennent de
            // l'utilisateur, et une recherche contenant des chevrons ne doit
            // pas se retrouver interprétée comme du balisage.
            label.textContent = value;
            row.appendChild(label);

            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'search-history-remove';
            remove.setAttribute('aria-label', 'Retirer');
            remove.textContent = '×';
            row.appendChild(remove);

            // `mousedown` plutôt que `click` : le champ perdrait le focus
            // avant que le clic n'aboutisse, et le panneau se serait déjà
            // refermé sous le doigt.
            row.addEventListener('mousedown', (e) => {
                e.preventDefault();
                if (e.target === remove) {
                    forget(value);
                    refresh(input.value);
                    if (shown.length === 0) close();
                    return;
                }
                apply(value);
                close();
                input.focus();
            });

            panel.appendChild(row);
        });
    }

    /** Recalcule la liste affichée pour une saisie donnée. */
    function refresh(value) {
        shown = matching(value);
        if (highlighted >= shown.length) highlighted = shown.length - 1;
        render();
    }

    function open() {
        if (shown.length === 0) return;
        panel.classList.remove('hidden');
        place();
    }

    function close() {
        panel.classList.add('hidden');
        highlighted = -1;
    }

    /** Porte une entrée dans le champ, curseur en fin de texte. */
    function apply(value) {
        input.value = value;
        try {
            input.setSelectionRange(value.length, value.length);
        } catch (e) {
            // Certains navigateurs refusent sur un champ non focalisé.
        }
    }

    /**
     * Déplace la mise en évidence, et porte l'entrée dans le champ.
     *
     * `-1` ramène la saisie mise de côté : c'est ce qui rend le parcours
     * réversible, et c'est la seule raison pour laquelle `draft` existe.
     *
     * @param {number} next
     */
    function moveTo(next) {
        highlighted = Math.max(-1, Math.min(shown.length - 1, next));
        apply(highlighted === -1 ? draft : shown[highlighted]);
        render();

        const row = panel.children[highlighted];
        if (row && typeof row.scrollIntoView === 'function') {
            row.scrollIntoView({ block: 'nearest' });
        }
    }

    // ─────────────────────────── Branchement ───────────────────────────

    function init() {
        input = document.getElementById('search-input');
        const form = document.getElementById('search-form');
        if (!input || !form) return;

        box = input.closest('.search-box');
        if (!box) return;

        load();

        panel = document.createElement('div');
        panel.id = 'search-history-panel';
        panel.className = 'search-history-panel hidden';
        box.appendChild(panel);

        /*
         * À la capture, depuis le document — et c'est tout le sujet.
         *
         * Poser l'écouteur sur le formulaire ne marchait pas, pour une raison
         * que l'ordre des balises `<script>` cachait bien : ce fichier est bien
         * chargé avant app.js, mais il attend `DOMContentLoaded` pour se
         * brancher, quand app.js le fait dès son exécution. Le sien passait donc
         * en premier, et son écouteur vide le champ après envoi — on lisait une
         * chaîne vide, et rien n'était jamais retenu.
         *
         * La phase de capture descend du document vers la cible : elle passe
         * avant tout écouteur posé sur le formulaire lui-même, quel que soit
         * l'ordre d'enregistrement et quel que soit l'endroit où l'on déplacerait
         * la balise. C'est la seule façon de lire la valeur à coup sûr.
         */
        document.addEventListener('submit', (e) => {
            if (e.target !== form) return;
            remember(input.value);
            close();
        }, true);

        input.addEventListener('input', () => {
            draft = input.value;
            highlighted = -1;
            refresh(draft);
            if (shown.length > 0) open();
            else close();
        });

        input.addEventListener('focus', () => {
            draft = input.value;
            refresh(draft);
            open();
        });

        input.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                if (!isOpen()) {
                    draft = input.value;
                    refresh(draft);
                    if (shown.length === 0) return;
                    open();
                    // Les deux flèches ouvrent sur l'entrée la plus récente :
                    // c'est celle qu'on cherche neuf fois sur dix, et la faire
                    // dépendre de la touche obligerait à savoir laquelle mène
                    // où avant même d'avoir vu la liste.
                    moveTo(0);
                } else {
                    moveTo(highlighted + (e.key === 'ArrowDown' ? 1 : -1));
                }
                // Sans quoi le curseur file au début ou à la fin du texte, ce
                // qui est le rôle ordinaire de ces touches dans un champ.
                e.preventDefault();
                return;
            }

            if (e.key === 'Escape' && isOpen()) {
                apply(draft);
                close();
                // L'écouteur global d'app.js referme les fenêtres sur cette
                // touche : elle est prise ici, elle ne doit pas servir deux fois.
                e.stopPropagation();
                e.preventDefault();
                return;
            }

            if (e.key === 'Enter') {
                // Le champ porte déjà l'entrée choisie — les flèches l'y ont
                // mise. Il n'y a donc rien à valider de plus : le formulaire
                // part comme d'habitude, et le panneau se retire.
                close();
            }
        });

        input.addEventListener('blur', close);

        // Le repli de la rangée change la largeur du champ : le panneau ouvert
        // le suit plutôt que de rester à ses anciennes mesures.
        window.addEventListener('resize', () => {
            if (isOpen()) place();
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    /** Exposé pour les tests, et pour un éventuel bouton d'effacement. */
    window.MusicPlayer.clearSearchHistory = function () {
        entries = [];
        save();
        close();
    };
})();
