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

    /**
     * Entrées, de la plus récente à la plus ancienne.
     *
     * Chacune vaut `{ q, title, thumb }` : la saisie telle qu'elle a été
     * validée, et ce que le tableau de bord a fini par en apprendre. `title` et
     * `thumb` restent nuls tant que la piste n'a pas été reconnue — une adresse
     * collée à l'instant ne dit encore rien de ce qu'elle porte.
     */
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
                // Les entrées d'avant étaient de simples chaînes : elles sont
                // relues comme des saisies sans métadonnées, que la première
                // reconnaissance viendra compléter. Rien à migrer à la main.
                ? parsed.map(normalise).filter(Boolean).slice(0, MAX_ENTRIES)
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
     * Ramène ce qui sort du stockage à la forme attendue.
     *
     * Rend `null` sur ce qui n'a pas de saisie exploitable : une entrée sans
     * `q` ne pourrait ni être rejouée, ni même s'afficher.
     */
    function normalise(raw) {
        if (typeof raw === 'string') {
            return raw ? { q: raw, title: null, thumb: null } : null;
        }
        if (!raw || typeof raw.q !== 'string' || !raw.q) return null;
        return {
            q: raw.q,
            title: typeof raw.title === 'string' ? raw.title : null,
            thumb: typeof raw.thumb === 'string' ? raw.thumb : null,
        };
    }

    /**
     * Retient une saisie validée.
     *
     * Une entrée déjà connue remonte en tête au lieu d'être ajoutée deux fois :
     * un historique où le même lien figure douze fois n'aide personne. Ce
     * qu'on sait déjà d'elle la suit — la reconnaissance a pu avoir lieu au
     * premier passage, et la refaire ne servirait à rien.
     *
     * @param {string} value
     */
    function remember(value) {
        const clean = (value || '').trim();
        if (!clean || clean.length > MAX_LENGTH) return;

        const existing = entries.findIndex((e) => e.q === clean);
        const known = existing !== -1 ? entries.splice(existing, 1)[0] : null;

        entries.unshift(known || { q: clean, title: null, thumb: null });
        if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
        save();
    }

    function forget(query) {
        const at = entries.findIndex((e) => e.q === query);
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
     *
     * Elle porte aussi sur le titre reconnu, et pas seulement sur ce qui a été
     * tapé : c'est ce que la ligne affiche, et chercher autre chose que ce
     * qu'on lit serait déroutant. Une adresse qui ne porte pas le nom du
     * morceau — un identifiant opaque, comme en produisent la plupart des
     * plateformes — n'était sinon retrouvable par ce nom d'aucune façon.
     */
    function matching(value) {
        const needle = (value || '').trim().toLowerCase();
        if (!needle) return entries.slice();
        return entries.filter((e) => e.q.toLowerCase().includes(needle)
            || (e.title || '').toLowerCase().includes(needle));
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

    /** Une adresse distante, par opposition à un chemin ou à une recherche. */
    function isLink(text) {
        return /^https?:\/\//i.test(text || '');
    }

    /**
     * Un chemin de fichier sur la machine du bot.
     *
     * Les deux formes que le champ accepte : une lettre de disque de Windows,
     * ou un chemin absolu POSIX. Reconnaître un chemin relatif reviendrait à
     * prendre toute recherche pour un fichier.
     */
    function isPath(text) {
        return /^[a-zA-Z]:[\\/]/.test(text || '') || /^\//.test(text || '');
    }

    /**
     * Le nom à afficher sur la ligne.
     *
     * Le titre reconnu s'il est connu ; sinon le nom du fichier pour un chemin,
     * qui vaut mieux que quatre dossiers suivis de ce nom ; sinon la saisie
     * telle quelle — pour une recherche en toutes lettres, c'est déjà le nom.
     */
    function displayName(entry) {
        if (entry.title) return entry.title;
        if (isPath(entry.q)) {
            const parts = entry.q.split(/[\\/]/);
            return parts[parts.length - 1] || entry.q;
        }
        return entry.q;
    }

    /** La note de musique, quand aucune image n'est disponible. */
    function noteIcon() {
        const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        icon.setAttribute('viewBox', '0 0 24 24');
        icon.setAttribute('fill', 'none');
        icon.setAttribute('stroke', 'currentColor');
        icon.setAttribute('stroke-width', '2');
        icon.setAttribute('stroke-linecap', 'round');
        icon.setAttribute('stroke-linejoin', 'round');
        icon.setAttribute('class', 'search-history-note');

        const stem = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        stem.setAttribute('d', 'M9 18V5l12-2v13');
        const left = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        left.setAttribute('cx', '6'); left.setAttribute('cy', '18'); left.setAttribute('r', '3');
        const right = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        right.setAttribute('cx', '18'); right.setAttribute('cy', '16'); right.setAttribute('r', '3');

        icon.appendChild(stem);
        icon.appendChild(left);
        icon.appendChild(right);
        return icon;
    }

    /**
     * La vignette d'une entrée, ou la note de musique à défaut.
     *
     * L'image est posée par `src`, jamais par du balisage assemblé : elle vient
     * d'une plateforme distante, et rien de ce qui vient de dehors ne doit
     * pouvoir se faire interpréter. Une adresse qui ne répond pas — vignette
     * expirée, réseau coupé — laisse la place à la note plutôt qu'au cadre vide
     * des images cassées.
     */
    function thumbnail(entry) {
        const holder = document.createElement('span');
        holder.className = 'search-history-thumb';

        if (!entry.thumb) {
            holder.appendChild(noteIcon());
            return holder;
        }

        const img = document.createElement('img');
        img.alt = '';
        img.loading = 'lazy';
        img.addEventListener('error', () => {
            holder.textContent = '';
            holder.appendChild(noteIcon());
        });
        img.src = entry.thumb;
        holder.appendChild(img);
        return holder;
    }

    function render() {
        panel.textContent = '';

        shown.forEach((entry, index) => {
            const row = document.createElement('div');
            row.className = 'search-history-row';
            if (index === highlighted) row.classList.add('is-highlighted');

            row.appendChild(thumbnail(entry));

            const label = document.createElement('span');
            label.className = 'search-history-label';
            // `textContent`, jamais `innerHTML` : ces chaînes viennent de
            // l'utilisateur, et une recherche contenant des chevrons ne doit
            // pas se retrouver interprétée comme du balisage.
            label.textContent = displayName(entry);
            row.appendChild(label);

            // L'adresse complète au survol, puisque la ligne ne la montre plus.
            // Sur un chemin aussi : le nom du fichier seul ne dit pas d'où il
            // vient. L'infobulle native, et non celle du tableau de bord : le
            // panneau se referme à la perte du focus, et une infobulle qui lui
            // survivrait resterait seule à l'écran.
            if (entry.title || isLink(entry.q) || isPath(entry.q)) {
                row.title = entry.q;
            }

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
                    forget(entry.q);
                    refresh(input.value);
                    if (shown.length === 0) close();
                    return;
                }
                apply(entry.q);
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
        // La saisie, et non le nom affiché : c'est elle qui sera renvoyée, et
        // le titre d'un morceau ne rejouerait pas le lien dont il vient.
        apply(highlighted === -1 ? draft : shown[highlighted].q);
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

    /**
     * Complète les entrées avec ce que le tableau de bord sait des pistes.
     *
     * L'historique ne retient que ce qui a été tapé : une adresse ne dit ni le
     * nom du morceau ni son image. Ceux-ci n'existent qu'une fois la piste
     * résolue par le bot, et c'est l'état qui les rapporte — file d'attente,
     * historique, playlists, lecture en cours. On y puise plutôt que d'ajouter
     * un aller-retour dont le serveur n'a pas besoin.
     *
     * Deux rapprochements, du plus sûr au plus large :
     *
     *  - **l'adresse**, pour un lien ou un chemin : la saisie est alors très
     *    exactement l'`url` de la piste ;
     *  - **le titre**, pour une recherche en toutes lettres : on a tapé un nom,
     *    et c'est ce nom qui est revenu.
     *
     * Une saisie qu'aucun des deux ne retrouve — une adresse que le bot a
     * réécrite en la résolvant, une recherche approximative — garde son texte
     * et la note de musique. C'est le repli, pas une panne.
     *
     * @param {object[]} tracks Pistes connues, dans n'importe quel ordre.
     */
    window.MusicPlayer.enrichSearchHistory = function (tracks) {
        if (!Array.isArray(tracks) || tracks.length === 0) return;

        // L'état arrive chaque seconde : on ne parcourt les pistes que s'il
        // reste quelque chose à apprendre.
        const pending = entries.filter((e) => !e.title && !e.thumb);
        if (pending.length === 0) return;

        const byUrl = new Map();
        const byTitle = new Map();
        tracks.forEach((track) => {
            if (!track) return;
            if (track.url) byUrl.set(String(track.url).toLowerCase(), track);
            if (track.title) byTitle.set(String(track.title).toLowerCase(), track);
        });

        let changed = false;
        pending.forEach((entry) => {
            const key = entry.q.toLowerCase();
            const found = byUrl.get(key) || byTitle.get(key);
            if (!found) return;
            entry.title = found.title || null;
            entry.thumb = found.thumbnail || null;
            // Une piste sans titre ni image n'apprend rien : ne pas le compter
            // comme un changement évite d'écrire le stockage pour rien.
            if (entry.title || entry.thumb) changed = true;
        });

        if (!changed) return;
        save();
        // Le panneau ouvert montre l'ancienne ligne : il la refait.
        if (panel && isOpen()) refresh(input.value);
    };

    /** Exposé pour les tests, et pour un éventuel bouton d'effacement. */
    window.MusicPlayer.clearSearchHistory = function () {
        entries = [];
        save();
        close();
    };
})();
