/**
 * Menu contextuel de qualité d'une piste.
 *
 * Ouvert au clic droit sur un élément de la file d'attente, de l'historique ou
 * d'une playlist. Il affiche l'état de préchargement puis, sous forme de
 * boutons, la qualité audio et vidéo de la piste ; chacun déplie un sous-menu
 * de choix.
 *
 * La valeur affichée pour l'audio est celle du fichier réellement en cache
 * quand il y en a un, et la qualité souhaitée sinon. La vidéo n'étant jamais
 * mise en cache, elle est toujours une qualité souhaitée, appliquée au
 * prochain démarrage du flux.
 */

window.MusicPlayer = window.MusicPlayer || {};

/**
 * Ce que la source porte réellement, par adresse.
 *
 * `undefined` : jamais demandé. `null` : demandé, réponse en route. Sinon
 * l'inventaire. Ces trois états sont ce que le sous-menu affiche — « recherche »
 * n'est pas la même chose que « rien trouvé », et confondre les deux ferait
 * clignoter une liste grise pendant deux secondes à chaque ouverture.
 */
const formatsByUrl = new Map();

/** Demande l'inventaire d'une piste, une seule fois. */
function askFormats(url) {
    if (!url || formatsByUrl.has(url)) return;
    if (typeof window.MusicPlayer.sendWS !== 'function') return;

    formatsByUrl.set(url, null);
    window.MusicPlayer.sendWS({ type: 'requestTrackFormats', data: { url } });
}

/**
 * Une option est-elle tenable pour cette source ?
 *
 * Trois réponses, et la nuance porte sur l'audio.
 *
 * Pour la **vidéo**, la question est franche : la définition existe ou n'existe
 * pas. Proposer du 4K sur une mise en ligne en 720p promet ce qu'on ne peut pas
 * rendre.
 *
 * Pour l'**audio**, tout débit reste techniquement atteignable — le bot
 * transcode. Mais viser au-dessus de ce que porte la source n'ajoute rien : on
 * réencode 128 kbps vers 320 sans récupérer ce qui n'y est pas, pour un fichier
 * deux fois plus lourd. Ce qui dépasse est donc marqué comme sans objet, pas
 * comme impossible.
 *
 * Tant que rien n'est connu, tout est tenable : le menu d'avant proposait tout,
 * et griser à l'aveugle serait pire que ne rien dire.
 */
function optionAvailable(type, value, formats) {
    if (!formats || !formats.known) return true;

    if (type === 'video') {
        return Array.isArray(formats.heights) && formats.heights.includes(Number(value));
    }

    if (!formats.audioKbps) return true;
    // Une marge : les débits variables flottent sous leur étiquette, et écarter
    // 320 pour une source annoncée à 317 serait une exactitude inutile.
    return Number(value) <= formats.audioKbps * 1.1;
}

/**
 * La définition qu'on obtiendra réellement, pour celle qu'on a demandée.
 *
 * Même règle que côté serveur : la meilleure que la source porte sans dépasser
 * la demande, et à défaut la plus petite qu'elle ait. Tant que l'inventaire
 * n'est pas connu, la demande fait foi — annoncer autre chose sur une supposition
 * serait pire que d'annoncer un vœu.
 *
 * @param {string|number} requested
 * @param {object|null|undefined} formats
 * @returns {number|string}
 */
function effectiveVideo(requested, formats) {
    if (!formats || !formats.known || !Array.isArray(formats.heights)
        || !formats.heights.length) {
        return requested;
    }

    const target = Number(requested);
    const below = formats.heights.filter((h) => h <= target).sort((a, b) => b - a);
    if (below.length) return below[0];

    return [...formats.heights].sort((a, b) => a - b)[0];
}

/** Débits MP3 proposés, du plus élevé au plus faible. */
const AUDIO_BITRATES = [
    { value: '320', label: '320 kbps' },
    { value: '256', label: '256 kbps' },
    { value: '192', label: '192 kbps' },
    { value: '128', label: '128 kbps' },
    { value: '96', label: '96 kbps' }
];

/** Hauteurs vidéo proposées, de la plus élevée à la plus faible. */
const VIDEO_HEIGHTS = [
    { value: '2160', label: '2160p (4K)' },
    { value: '1440', label: '1440p (QHD)' },
    { value: '1080', label: '1080p' },
    { value: '720', label: '720p' },
    { value: '480', label: '480p' },
    { value: '360', label: '360p' }
];

const ICON_AUDIO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>';
const ICON_VIDEO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg>';
const ICON_CHEVRON = '<svg class="quality-menu-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>';
const ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
const ICON_LINK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>';
const FOLDER_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>';
const ICON_COPY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
const ICON_LEVEL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="20" x2="6" y2="13"></line><line x1="12" y1="20" x2="12" y2="4"></line><line x1="18" y1="20" x2="18" y2="9"></line></svg>';
const ICON_RESET = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg>';

/*
 * Bornes du curseur de niveau sonore.
 *
 * Recopiées de `src/audio/loudness.js`, où elles font autorité : le serveur
 * ramène de toute façon dans ses bornes ce qu'on lui envoie. Les tenir
 * identiques évite seulement au curseur d'afficher une position que le réglage
 * n'atteindra jamais. Une divergence est vérifiée par tests/loudness.js.
 */
const LUFS_MIN = -40;
const LUFS_MAX = -3;
const LUFS_STEP = 0.5;

/**
 * Délai de regroupement des envois pendant qu'on déplace le curseur.
 *
 * Le réglage doit s'entendre en direct, mais un curseur émet une valeur par
 * pixel parcouru : sans ce frein, une traversée du rail enverrait une centaine
 * de messages et autant de diffusions d'état.
 */
const LUFS_SEND_INTERVAL_MS = 120;

let menuEl = null;
let submenuEl = null;
/** URL de la piste ouverte : sert à retrouver son état frais à chaque diffusion. */
let openedUrl = null;

/**
 * D'où vient la ligne sur laquelle on a fait un clic droit.
 *
 * `{ container, index }` — `container` vaut `queue` ou l'identifiant d'une
 * playlist. La piste seule ne suffirait pas : le même morceau peut figurer dans
 * trois playlists et dans la file, et un aiguillage se pose à un endroit, pas
 * sur un titre. `null` pour l'historique et la fenêtre vidéo, où rien ne
 * s'insère.
 */
let openedContext = null;

/**
 * Ce que le menu flottant montre en ce moment : une piste, ou un aiguillage.
 *
 * Les deux partagent `menuEl` — et donc le placement et tous les gestes de
 * fermeture —, mais pas leur contenu. Sans ce drapeau, la reconstruction
 * périodique du menu de qualité chercherait une piste à l'adresse d'un
 * aiguillage, n'en trouverait pas, et refermerait le menu au premier état reçu.
 */
let menuKind = 'quality';
/** 'audio' | 'video' | 'loudness' | null — sous-menu actuellement déplié. */
let submenuOpen = null;

function t(key, fallback) {
    const translated = window.MusicPlayer.t ? window.MusicPlayer.t(key) : key;
    return translated === key ? fallback : translated;
}

/**
 * Retrouve la piste dans l'état courant à partir de son URL.
 *
 * Le menu ne conserve pas l'objet reçu au clic droit : il serait figé, alors
 * que la progression d'une requalification doit s'y afficher en direct.
 *
 * @param {string} url
 * @returns {object|null}
 */
function findTrack(url) {
    const state = window.MusicPlayer.state;
    if (!state || !url) return null;

    // La piste en cours d'abord : c'est celle que vise la roue de la fenêtre
    // vidéo, et elle n'appartient plus à la file une fois lancée.
    const pools = [
        state.currentTrack ? [state.currentTrack] : [],
        state.queue || [],
        state.history || []
    ];
    (state.playlists || []).forEach(p => pools.push(p.tracks || []));

    for (const pool of pools) {
        const found = pool.find(t => t && t.url === url);
        if (found) return found;
    }
    return null;
}

/**
 * Conteneur d'accueil des menus.
 *
 * En plein écran natif, seul le sous-arbre de l'élément affiché est rendu :
 * un menu posé sur <body> y serait totalement invisible.
 *
 * @returns {HTMLElement}
 */
function menuContainer() {
    return document.fullscreenElement || document.webkitFullscreenElement || document.body;
}

/**
 * Hisse un menu au-dessus des fenêtres flottantes.
 *
 * La fenêtre vidéo et celle des journaux se remettent au premier plan à chaque
 * `mousedown` via `bringToFront()`, qui distribue des z-index en ligne
 * croissants à partir de 9990 — sans commune mesure avec la valeur statique de
 * la feuille de style. Presser la roue hisse donc la fenêtre juste avant que le
 * menu ne s'ouvre, et celui-ci disparaîtrait derrière elle. S'inscrire dans le
 * même compteur est le seul moyen de rester au-dessus de façon fiable.
 *
 * @param {HTMLElement} el
 */
function raiseToFront(el) {
    if (typeof window.MusicPlayer.bringToFront === 'function') {
        window.MusicPlayer.bringToFront(el);
    }
}

/**
 * Construit le squelette de la ligne d'état du préchargement.
 *
 * Son contenu est ensuite entièrement piloté par `majStatut()`, y compris à la
 * construction : la ligne peut ainsi changer d'état sans reconstruire le menu.
 */
function buildStatus(track) {
    const row = document.createElement('div');
    row.className = 'quality-menu-status';

    const badge = document.createElement('span');
    badge.className = 'quality-menu-dot';

    const text = document.createElement('span');
    text.className = 'quality-menu-status-text';

    const value = document.createElement('span');
    value.className = 'quality-menu-status-value';

    row.appendChild(badge);
    row.appendChild(text);
    row.appendChild(value);
    updateStatus(row, track);
    return row;
}

/**
 * Écrit l'état du préchargement dans une ligne existante.
 *
 * Tout passe par des modifications sur place — classes et textes — car cette
 * ligne est la seule partie du menu qui évolue en continu. La reconstruire
 * emporterait les boutons voisins et ferait clignoter le survol.
 *
 * @param {HTMLElement} row
 * @param {object} track
 */
function updateStatus(row, track) {
    if (!row) return;
    const text = row.querySelector('.quality-menu-status-text');
    const value = row.querySelector('.quality-menu-status-value');

    let classes = [];
    let label;
    let digit;

    if (track.isLocal) {
        classes = ['is-local'];
        label = t('quality_menu_local', 'Fichier local');
        digit = t('quality_menu_local_short', 'tel quel');
    } else if (track.requalify) {
        classes = ['is-requalifying', track.requalify.direction === 'down' ? 'is-down' : 'is-up'];
        label = t('quality_menu_requalifying', 'Nouvelle qualité en cours');
        digit = `${Math.round(track.requalify.progress || 0)} %`;
    } else if (track.isPreloaded) {
        classes = ['is-preloaded'];
        label = t('quality_menu_preloaded', 'Préchargé');
        digit = '100 %';
    } else if (track.isPreloading) {
        classes = ['is-preloading'];
        label = t('quality_menu_preloading', 'Préchargement…');
        digit = `${Math.round(track.preloadProgress || 0)} %`;
    } else {
        label = t('quality_menu_not_preloaded', 'Non préchargé');
        digit = '—';
    }

    const target = `quality-menu-status ${classes.join(' ')}`.trim();
    if (row.className !== target) row.className = target;
    if (text && text.textContent !== label) text.textContent = label;
    if (value && value.textContent !== digit) value.textContent = digit;
}

/**
 * Construit un bouton de qualité.
 * @param {'audio'|'video'} type
 * @param {string} valeurAffichee
 * @param {boolean} isReal - true si la valeur décrit le fichier en cache
 */
function buildButton(type, displayedValue, isReal) {
    const btn = document.createElement('button');
    btn.className = 'quality-menu-item';
    btn.dataset.qualityType = type;

    const icon = document.createElement('span');
    icon.className = 'quality-menu-icon';
    icon.innerHTML = type === 'audio' ? ICON_AUDIO : ICON_VIDEO;

    const label = document.createElement('span');
    label.className = 'quality-menu-label';
    label.textContent = type === 'audio'
        ? t('import_audio_quality_label', 'Audio')
        : t('import_video_quality_label', 'Vidéo');

    const value = document.createElement('span');
    value.className = 'quality-menu-value';
    value.textContent = displayedValue;
    // Une valeur simplement souhaitée n'engage rien tant que le fichier n'est
    // pas préchargé : elle est signalée comme telle plutôt que présentée
    // comme la qualité effective du média.
    if (!isReal) value.classList.add('is-desired');
    value.dataset.tooltip = isReal
        ? t('quality_menu_actual_hint', 'Qualité du fichier préchargé')
        : t('quality_menu_desired_hint', 'Qualité souhaitée, appliquée au préchargement');

    const chevron = document.createElement('span');
    chevron.className = 'quality-menu-arrow';
    chevron.innerHTML = ICON_CHEVRON;

    btn.appendChild(icon);
    btn.appendChild(label);
    btn.appendChild(value);
    btn.appendChild(chevron);

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleSubmenu(type, btn);
    });

    return btn;
}

/**
 * La source de la piste est-elle une adresse distante ?
 *
 * `isLocal` ne suffit pas : il vaut aussi pour un fichier téléversé qui n'a
 * jamais été distant, mais il est calculé côté serveur et peut manquer sur une
 * piste reconstruite depuis un état sauvegardé. La forme de l'URL, elle, est
 * toujours là.
 *
 * @param {object} track
 * @returns {boolean}
 */
function sourceIsLink(track) {
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(track?.url || '');
}

/** Aiguillage : deux voies qui divergent. */
const ICON_TRANSITION = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M4 20 L4 12 Q4 8 8 8 L20 8"></path>'
    + '<polyline points="16 4 20 8 16 12"></polyline>'
    + '<path d="M4 12 L4 8"></path></svg>';

/**
 * Construit le bouton qui ouvre le choix d'un aiguillage.
 *
 * @returns {HTMLElement}
 */
function buildTransitionButton() {
    const btn = document.createElement('button');
    btn.className = 'quality-menu-item';
    btn.dataset.qualityType = 'transition';

    const icon = document.createElement('span');
    icon.className = 'quality-menu-icon';
    icon.innerHTML = ICON_TRANSITION;

    const label = document.createElement('span');
    label.className = 'quality-menu-label';
    label.textContent = t('transition_menu_label', 'Insérer une transition');

    const chevron = document.createElement('span');
    chevron.className = 'quality-menu-arrow';
    chevron.innerHTML = ICON_CHEVRON;

    btn.appendChild(icon);
    btn.appendChild(label);
    btn.appendChild(chevron);

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleSubmenu('transition', btn);
    });

    return btn;
}

/**
 * Le panneau de création d'un aiguillage : où l'on va, puis de quel côté.
 *
 * Deux gestes, et dans cet ordre. La destination d'abord, parce qu'un
 * aiguillage sans elle ne veut rien dire ; le côté ensuite, par deux boutons
 * plutôt qu'une liste — il n'y a que deux réponses, et les faire choisir dans
 * un menu déroulant coûterait un clic de plus pour rien.
 *
 * Les deux boutons restent éteints tant qu'aucune destination n'est retenue :
 * c'est ce qui dit, sans phrase, qu'il manque quelque chose.
 *
 * @returns {HTMLElement}
 */
/**
 * Les destinations qu'on peut proposer depuis une liste donnée.
 *
 * Sa propre liste est exclue : un aiguillage vers l'endroit où l'on se trouve
 * déjà ne mènerait nulle part.
 *
 * @param {string} containerId - `queue`, ou l'identifiant d'une playlist.
 * @returns {{ id: string, name: string }[]}
 */
function transitionTargets(containerId) {
    const state = window.MusicPlayer.state || {};
    const cibles = [];

    if (containerId !== 'queue') {
        cibles.push({ id: 'queue', name: t('transition_target_queue', 'File d\'attente') });
    }
    for (const p of state.playlists || []) {
        if (!p || p.id === containerId) continue;
        cibles.push({ id: p.id, name: p.name || '' });
    }
    return cibles;
}

/**
 * La liste des destinations, cochable.
 *
 * Partagée par la création d'un aiguillage et la modification de sa
 * destination : ce sont les mêmes choix, et deux listes finiraient par ne plus
 * proposer la même chose.
 *
 * @param {{ id: string, name: string }[]} cibles
 * @param {string|null} courante - Celle qui porte la coche, s'il y en a une.
 * @param {(id: string) => void} choisir
 * @returns {HTMLElement}
 */
function buildTargetList(cibles, courante, choisir) {
    const liste = document.createElement('div');
    liste.className = 'transition-target-list';
    const boutons = [];

    for (const cible of cibles) {
        const opt = document.createElement('button');
        opt.className = 'quality-submenu-item';
        opt.dataset.targetId = cible.id;
        if (cible.id === courante) opt.classList.add('is-current');

        const check = document.createElement('span');
        check.className = 'quality-submenu-check';
        check.innerHTML = ICON_CHECK;

        const nom = document.createElement('span');
        nom.className = 'quality-submenu-text';
        nom.textContent = cible.name;

        opt.appendChild(check);
        opt.appendChild(nom);
        opt.addEventListener('click', (e) => {
            e.stopPropagation();
            for (const b of boutons) b.classList.toggle('is-current', b === opt);
            choisir(cible.id);
        });

        boutons.push(opt);
        liste.appendChild(opt);
    }
    return liste;
}

function buildTransitionPanel() {
    const panel = document.createElement('div');
    panel.className = 'quality-submenu glass-card transition-panel';
    panel.addEventListener('click', (e) => e.stopPropagation());
    panel.addEventListener('contextmenu', (e) => e.preventDefault());

    const context = openedContext;
    const cibles = transitionTargets(context.container);

    if (cibles.length === 0) {
        const vide = document.createElement('div');
        vide.className = 'quality-submenu-pending';
        vide.textContent = t('transition_no_target', 'Aucune autre source où aller.');
        panel.appendChild(vide);
        return panel;
    }

    const titre = document.createElement('div');
    titre.className = 'transition-panel-title';
    titre.textContent = t('transition_target_label', 'Aller vers');
    panel.appendChild(titre);

    let retenue = null;
    panel.appendChild(buildTargetList(cibles, null, (id) => {
        retenue = id;
        panel.classList.add('has-target');
    }));

    const actions = document.createElement('div');
    actions.className = 'transition-actions';

    const poser = (avant) => {
        if (!retenue) return;
        window.MusicPlayer.sendWS({
            type: 'insertTransition',
            data: {
                container: context.container,
                // L'aiguillage se range devant la ligne cliquée, ou juste
                // derrière : c'est la seule différence entre les deux boutons.
                index: avant ? context.index : context.index + 1,
                target: retenue,
            },
        });
        closeFloating();
    };

    for (const [cle, defaut, avant] of [
        ['transition_insert_before', 'Avant', true],
        ['transition_insert_after', 'Après', false],
    ]) {
        const btn = document.createElement('button');
        btn.className = 'transition-action';
        btn.textContent = t(cle, defaut);
        btn.addEventListener('click', (e) => { e.stopPropagation(); poser(avant); });
        actions.appendChild(btn);
    }

    panel.appendChild(actions);
    return panel;
}

/**
 * Construit le bouton de copie de la source.
 *
 * Une piste distante n'a qu'une adresse, une piste locale qu'un chemin disque :
 * le bouton s'annonce donc différemment selon le cas, mais copie dans les deux
 * la valeur exacte de `track.url` — celle qui permet de relancer la piste.
 *
 * @param {object} track
 * @returns {HTMLElement}
 */
function buildSourceButton(track) {
    const isLink = sourceIsLink(track);

    const btn = document.createElement('button');
    btn.className = 'quality-menu-item quality-menu-source';

    const icon = document.createElement('span');
    icon.className = 'quality-menu-icon';
    icon.innerHTML = isLink ? ICON_LINK : FOLDER_ICON;

    const label = document.createElement('span');
    label.className = 'quality-menu-label';
    label.textContent = isLink
        ? t('quality_menu_copy_link', 'Copier le lien')
        : t('quality_menu_copy_path', 'Copier le chemin d\'accès');

    // La source complète en infobulle : le menu est trop étroit pour l'afficher,
    // et c'est pourtant elle qu'on s'apprête à copier.
    btn.dataset.tooltip = track.url || '';

    const markEl = document.createElement('span');
    markEl.className = 'quality-menu-arrow quality-menu-copy-mark';
    markEl.innerHTML = ICON_COPY;

    btn.appendChild(icon);
    btn.appendChild(label);
    btn.appendChild(markEl);

    btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const copy = await window.MusicPlayer.copyToClipboard(track.url);

        // Le menu reste ouvert : la coche confirme sur place, sans chasser
        // l'utilisateur d'un menu où il a peut-être encore à faire.
        btn.classList.toggle('is-copied', copy);
        label.textContent = copy
            ? t('quality_menu_copied', 'Copié')
            : t('quality_menu_copy_failed', 'Copie impossible');
        markEl.innerHTML = copy ? ICON_CHECK : ICON_COPY;

        clearTimeout(btn._retour);
        btn._retour = setTimeout(() => {
            btn.classList.remove('is-copied');
            label.textContent = isLink
                ? t('quality_menu_copy_link', 'Copier le lien')
                : t('quality_menu_copy_path', 'Copier le chemin d\'accès');
            markEl.innerHTML = ICON_COPY;
        }, 1500);
    });

    return btn;
}

// ─── Niveau sonore (LUFS) ─────────────────────────────────────────────────

/**
 * Sonie d'une piste, avec des valeurs de repli.
 *
 * L'état peut arriver d'un serveur qui ne connaît pas encore ce champ — le
 * temps d'un rechargement après mise à jour, notamment. Le menu doit alors
 * s'afficher sans ce réglage plutôt que de refuser de s'ouvrir.
 *
 * @param {object} track
 * @returns {object}
 */
function loudnessOf(track) {
    const raw = (track && track.loudness) || {};
    return {
        status: raw.status || 'unavailable',
        measured: Number.isFinite(raw.measured) ? raw.measured : null,
        peak: Number.isFinite(raw.peak) ? raw.peak : null,
        target: Number.isFinite(raw.target) ? raw.target : null,
        customized: !!raw.customized,
        synced: !!raw.synced,
        gainDb: Number.isFinite(raw.gainDb) ? raw.gainDb : 0,
        degradation: Number.isFinite(raw.degradation) ? raw.degradation : 0
    };
}

/** « −14.0 LUFS », avec le vrai signe moins plutôt que le trait d'union. */
function formatLufs(value) {
    if (!Number.isFinite(value)) return '—';
    return `${value.toFixed(1).replace('-', '−')} LUFS`;
}

/** « +3.2 dB », « −1.5 dB », « 0 dB ». */
function formatGain(db) {
    if (!Number.isFinite(db) || Math.abs(db) < 0.05) return '0 dB';
    const sign = db > 0 ? '+' : '−';
    return `${sign}${Math.abs(db).toFixed(1)} dB`;
}

/**
 * Dégradation attendue, en clair.
 *
 * Reprend le calcul du serveur — la marge sous le plafond, bornée à zéro — pour
 * que la barre suive le curseur sans attendre l'aller-retour, puis se recale
 * sur la valeur reçue à la diffusion d'état suivante.
 *
 * @param {number} db - Gain qu'on s'apprête à appliquer
 * @param {number|null} peak - Pic réel du fichier, en dBTP
 * @returns {number} 0 à 1
 */
function degradationFor(db, peak) {
    const headroom = Math.max(0, -(Number.isFinite(peak) ? peak : 0));
    const overshoot = db - headroom;
    if (overshoot <= 0) return 0;
    return Math.min(1, overshoot / 12);
}

/**
 * Libellé de l'état de la dégradation.
 * @param {number} ratio - 0 à 1
 */
function degradationLabel(ratio) {
    if (ratio <= 0) return t('loudness_quality_intact', 'Qualité préservée');
    if (ratio < 0.34) return t('loudness_quality_slight', 'Léger écrêtage');
    if (ratio < 0.67) return t('loudness_quality_marked', 'Écrêtage marqué');
    return t('loudness_quality_severe', 'Saturation importante');
}

/**
 * Construit le bouton « Niveau sonore » du menu principal.
 *
 * Sa valeur est le gain appliqué, pas la cible : c'est le seul des deux chiffres
 * qui dise quelque chose sans ouvrir le sous-menu — « ce morceau est remonté de
 * 3 dB » se lit, « ce morceau vise −11 LUFS » ne se lit qu'en connaissant sa
 * mesure.
 *
 * @param {object} track
 * @returns {HTMLElement}
 */
function buildLoudnessButton(track) {
    const level = loudnessOf(track);

    const btn = document.createElement('button');
    btn.className = 'quality-menu-item';
    btn.dataset.qualityType = 'loudness';

    const icon = document.createElement('span');
    icon.className = 'quality-menu-icon';
    icon.innerHTML = ICON_LEVEL;

    const label = document.createElement('span');
    label.className = 'quality-menu-label';
    label.textContent = t('loudness_menu_label', 'Niveau sonore');

    const value = document.createElement('span');
    value.className = 'quality-menu-value quality-menu-loudness-value';
    btn.appendChild(icon);
    btn.appendChild(label);
    btn.appendChild(value);

    const chevron = document.createElement('span');
    chevron.className = 'quality-menu-arrow';
    chevron.innerHTML = ICON_CHEVRON;
    btn.appendChild(chevron);

    writeLoudnessValue(value, level);

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleSubmenu('loudness', btn);
    });

    return btn;
}

/**
 * Écrit, sur place, la valeur affichée par le bouton « Niveau sonore ».
 * @param {HTMLElement} value
 * @param {object} level
 */
function writeLoudnessValue(value, level) {
    if (!value) return;

    let text;
    let desired = false;

    if (level.status === 'analyzing') {
        text = t('loudness_analyzing_short', 'analyse…');
        desired = true;
    } else if (level.status !== 'measured') {
        text = t('loudness_unmeasured_short', 'non mesuré');
        desired = true;
    } else {
        text = formatGain(level.gainDb);
        // Un gain nul n'est pas un réglage : c'est l'absence de correction.
        desired = Math.abs(level.gainDb) < 0.05;
    }

    if (value.textContent !== text) value.textContent = text;
    value.classList.toggle('is-desired', desired);
}

/**
 * Construit le panneau de réglage du niveau sonore.
 *
 * Ce sous-menu n'est pas une liste de choix comme les deux autres : c'est un
 * réglage continu, qui s'entend pendant qu'on le déplace. Trois repères y sont
 * tenus visibles en permanence, parce que le curseur seul ne dit rien —
 * la valeur visée, la mesure d'origine (le point où le morceau est rendu tel
 * qu'il est), et ce que le gain coûte au son.
 *
 * @param {object} track
 * @returns {HTMLElement}
 */
function buildLoudnessPanel(track) {
    const level = loudnessOf(track);

    const panel = document.createElement('div');
    panel.className = 'quality-submenu loudness-panel glass-card';
    panel.addEventListener('click', (e) => e.stopPropagation());
    panel.addEventListener('contextmenu', (e) => e.preventDefault());

    if (level.status !== 'measured') {
        panel.appendChild(buildLoudnessNotice(level.status));
        return panel;
    }

    // --- En-tête : la valeur visée, et le retour à l'origine ---
    const head = document.createElement('div');
    head.className = 'loudness-head';

    const reading = document.createElement('span');
    reading.className = 'loudness-reading';
    reading.textContent = formatLufs(level.target);

    const reset = document.createElement('button');
    reset.className = 'loudness-reset';
    reset.innerHTML = ICON_RESET;
    reset.dataset.tooltip = t('loudness_reset_hint', 'Revenir au niveau d\'origine du fichier');

    head.appendChild(reading);
    head.appendChild(reset);
    panel.appendChild(head);

    // --- Le curseur ---
    const rail = document.createElement('div');
    rail.className = 'loudness-rail';

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'loudness-slider';
    slider.min = String(LUFS_MIN);
    slider.max = String(LUFS_MAX);
    slider.step = String(LUFS_STEP);
    slider.value = String(level.target);

    /*
     * Repère de la mesure d'origine, posé sur le rail.
     *
     * « La valeur initiale doit rester visible » : elle l'est en toutes lettres
     * plus bas, mais c'est ici qu'elle se lit d'un coup d'œil — le curseur
     * ramené sur ce trait, le morceau sort tel qu'il a été enregistré.
     */
    const mark = document.createElement('span');
    mark.className = 'loudness-origin-mark';
    positionOriginMark(mark, level.measured);

    rail.appendChild(slider);
    rail.appendChild(mark);
    panel.appendChild(rail);

    const bounds = document.createElement('div');
    bounds.className = 'loudness-bounds';
    bounds.innerHTML = `<span>${String(LUFS_MIN).replace('-', '−')}</span>`
        + `<span>${String(LUFS_MAX).replace('-', '−')}</span>`;
    panel.appendChild(bounds);

    // --- Mesure d'origine et gain appliqué ---
    const facts = document.createElement('div');
    facts.className = 'loudness-facts';

    const origin = document.createElement('span');
    origin.className = 'loudness-origin';
    origin.textContent = `${t('loudness_measured', 'Mesuré')} ${formatLufs(level.measured)}`;

    const gain = document.createElement('span');
    gain.className = 'loudness-gain';
    gain.textContent = formatGain(level.gainDb);

    facts.appendChild(origin);
    facts.appendChild(gain);
    panel.appendChild(facts);

    // --- Indicateur de dégradation ---
    const meter = document.createElement('div');
    meter.className = 'loudness-meter';
    const fill = document.createElement('span');
    fill.className = 'loudness-meter-fill';
    meter.appendChild(fill);
    panel.appendChild(meter);

    const verdict = document.createElement('div');
    verdict.className = 'loudness-verdict';
    panel.appendChild(verdict);

    // La synchronisation commune recouvre ce réglage : le dire évite de laisser
    // croire à un réglage propre à la piste, et annonce ce que toucher au
    // curseur va faire.
    if (level.synced) {
        const note = document.createElement('div');
        note.className = 'loudness-synced-note';
        note.textContent = t('loudness_synced_note',
            'Synchronisation active — la régler ici la désactive.');
        panel.appendChild(note);
    }

    panel._track = track;
    panel._peak = level.peak;
    panel._measured = level.measured;
    panel._slider = slider;
    panel._reading = reading;
    panel._gain = gain;
    panel._fill = fill;
    panel._verdict = verdict;

    paintLoudness(panel, level.target);

    slider.addEventListener('input', () => {
        const wanted = parseFloat(slider.value);
        paintLoudness(panel, wanted);
        sendLoudness(track.url, wanted, false);
    });
    // Le relâchement force l'envoi de la dernière position, que le
    // regroupement aurait pu retenir.
    slider.addEventListener('change', () => {
        sendLoudness(track.url, parseFloat(slider.value), true);
    });

    reset.addEventListener('click', (e) => {
        e.stopPropagation();
        slider.value = String(level.measured);
        paintLoudness(panel, level.measured);
        sendLoudness(track.url, null, true);
    });

    return panel;
}

/**
 * Message affiché quand il n'y a rien à régler.
 * @param {string} status
 * @returns {HTMLElement}
 */
function buildLoudnessNotice(status) {
    const notice = document.createElement('div');
    notice.className = 'loudness-notice';

    if (status === 'analyzing' || status === 'pending') {
        notice.classList.add('is-working');
        notice.textContent = t('loudness_analyzing',
            'Analyse du niveau sonore en cours…');
    } else if (status === 'failed') {
        notice.textContent = t('loudness_failed',
            'Le niveau de ce fichier n\'a pas pu être mesuré.');
    } else {
        notice.textContent = t('loudness_unavailable',
            'Niveau réglable une fois le morceau préchargé.');
    }

    return notice;
}

/**
 * Place le repère de la mesure d'origine sur le rail.
 *
 * Le pouce d'un `input[type=range]` fait 16 px et ne sort jamais du rail : sa
 * course utile est donc plus courte que la largeur, de la moitié d'un pouce à
 * chaque bout. Sans cette correction, le repère et le pouce ne coïncideraient
 * qu'au milieu — l'écart atteignant huit pixels aux extrémités, soit près d'un
 * décibel et demi.
 *
 * @param {HTMLElement} mark
 * @param {number} measured
 */
function positionOriginMark(mark, measured) {
    if (!Number.isFinite(measured)) {
        mark.style.display = 'none';
        return;
    }
    const clamped = Math.min(LUFS_MAX, Math.max(LUFS_MIN, measured));
    const ratio = (clamped - LUFS_MIN) / (LUFS_MAX - LUFS_MIN);
    mark.style.left = `calc(8px + ${(ratio * 100).toFixed(2)}% - ${(ratio * 16).toFixed(2)}px)`;
    mark.style.display = '';
}

/**
 * Met à jour les affichages du panneau pour une cible donnée.
 *
 * Calculé ici plutôt qu'attendu du serveur : le curseur doit répondre sous le
 * doigt, et un aller-retour réseau par cran se verrait.
 *
 * @param {HTMLElement} panel
 * @param {number} target
 */
function paintLoudness(panel, target) {
    if (!panel || !panel._reading) return;

    const db = target - panel._measured;
    const ratio = degradationFor(db, panel._peak);

    panel._reading.textContent = formatLufs(target);
    panel._gain.textContent = formatGain(db);
    panel._fill.style.width = `${(ratio * 100).toFixed(1)}%`;
    panel._verdict.textContent = degradationLabel(ratio);
    panel.classList.toggle('is-degraded', ratio > 0);
    panel.classList.toggle('is-severe', ratio >= 0.67);
}

/** Dernier envoi de niveau, pour n'en émettre qu'un par intervalle. */
let loudnessSentAt = 0;
let loudnessPending = null;

/**
 * Envoie une cible de niveau au serveur, au plus une fois par intervalle.
 *
 * @param {string} url
 * @param {number|null} target - null remet la piste à son niveau d'origine
 * @param {boolean} immediate - Fin de geste : passe outre le regroupement
 */
function sendLoudness(url, target, immediate) {
    if (typeof window.MusicPlayer.sendWS !== 'function') return;

    const emit = () => {
        loudnessSentAt = Date.now();
        loudnessPending = null;
        window.MusicPlayer.sendWS({ type: 'setTrackLoudness', data: { url, target } });
    };

    if (loudnessPending) {
        clearTimeout(loudnessPending);
        loudnessPending = null;
    }

    const waited = Date.now() - loudnessSentAt;
    if (immediate || waited >= LUFS_SEND_INTERVAL_MS) {
        emit();
        return;
    }
    loudnessPending = setTimeout(emit, LUFS_SEND_INTERVAL_MS - waited);
}

/**
 * Recale le panneau ouvert sur l'état reçu, sans le reconstruire.
 *
 * Le curseur sous le doigt est laissé tranquille : l'état qui revient porte la
 * valeur qu'on vient d'envoyer, mais avec un tour de retard — la réappliquer
 * ferait reculer le pouce d'un cran à chaque diffusion.
 *
 * @param {object} track
 */
function refreshLoudnessPanel(track) {
    if (submenuEl && submenuOpen === 'loudness') recalePanel(submenuEl, track);
}

/**
 * Recale un panneau donné, d'où qu'il vienne.
 *
 * Séparé de ce qui le trouve : le même panneau s'ouvre depuis le menu contextuel
 * et depuis la carte « Volume et diffusion », et l'un ne doit pas cesser de se
 * mettre à jour parce que l'autre est fermé.
 *
 * @param {HTMLElement} panel
 * @param {object} track
 */
function recalePanel(panel, track) {
    if (!panel || !panel._slider) return;

    const level = loudnessOf(track);
    panel._peak = level.peak;
    panel._measured = level.measured;

    const slider = panel._slider;
    if (document.activeElement === slider || slider.matches(':active')) return;
    if (parseFloat(slider.value) === level.target) return;

    slider.value = String(level.target);
    paintLoudness(panel, level.target);
}

/** Ouvre (ou referme) le sous-menu de choix rattaché à un bouton. */
function toggleSubmenu(type, btn) {
    if (submenuOpen === type) {
        closeSubmenu();
        return;
    }
    closeSubmenu();
    submenuOpen = type;
    btn.classList.add('is-open');

    const track = findTrack(openedUrl);
    if (!track) return;

    if (type === 'transition') {
        submenuEl = buildTransitionPanel();
        menuContainer().appendChild(submenuEl);
        raiseToFront(submenuEl);
        positionSubmenu(btn);
        return;
    }

    if (type === 'loudness') {
        submenuEl = buildLoudnessPanel(track);
        menuContainer().appendChild(submenuEl);
        raiseToFront(submenuEl);
        positionSubmenu(btn);

        // Le fichier est peut-être mesurable sans l'avoir jamais été : le bot
        // seul peut le lire, et ouvrir ce panneau est le moment où la mesure
        // devient utile.
        if (loudnessOf(track).status !== 'measured'
            && typeof window.MusicPlayer.sendWS === 'function') {
            window.MusicPlayer.sendWS({
                type: 'requestTrackLoudness',
                data: { url: track.url }
            });
        }
        return;
    }

    const options = type === 'audio' ? AUDIO_BITRATES : VIDEO_HEIGHTS;
    const current = type === 'audio'
        ? (track.cachedAudioQuality || track.desiredAudioQuality)
        : track.desiredVideoQuality;

    submenuEl = document.createElement('div');
    submenuEl.className = 'quality-submenu glass-card';
    // Posé sur <body> pour échapper au découpage du menu : ses clics doivent
    // donc être retenus ici, sinon ils remonteraient à la fermeture globale.
    submenuEl.addEventListener('click', (e) => e.stopPropagation());
    submenuEl.addEventListener('contextmenu', (e) => e.preventDefault());

    /*
     * L'inventaire de la source, demandé ici et nulle part ailleurs.
     *
     * Il coûte un appel réseau d'une à trois secondes : le lancer à l'ouverture
     * du menu principal, ou pire à chaque diffusion d'état, le paierait pour des
     * pistes qu'on ne règle jamais. Ouvrir ce sous-menu est en revanche le seul
     * moment où la question se pose.
     */
    askFormats(track.url);
    const formats = formatsByUrl.get(track.url);

    // Demandé, sans réponse encore : le dire, plutôt que de griser une liste
    // qui redeviendra normale deux secondes plus tard.
    if (formats === null) {
        const pending = document.createElement('div');
        pending.className = 'quality-submenu-pending';
        pending.textContent = t('quality_formats_pending', 'Recherche des qualités…');
        submenuEl.appendChild(pending);
    }

    options.forEach(opt => {
        const choice = document.createElement('button');
        choice.className = 'quality-submenu-item';
        if (String(opt.value) === String(current)) choice.classList.add('is-current');

        /*
         * Ce que la source ne porte pas est montré, mais éteint.
         *
         * Retirer les lignes ferait sauter la liste d'une piste à l'autre, et
         * l'on ne saurait pas si le 4K manque parce qu'il n'existe pas ou parce
         * qu'on a mal regardé. Grisé, il dit les deux : le choix existe, cette
         * source ne l'a pas.
         *
         * La valeur déjà retenue échappe à la règle. Elle peut avoir été choisie
         * quand la source proposait autre chose, et l'éteindre laisserait un
         * menu où rien n'est cochable — dont la ligne cochée.
         */
        const usable = optionAvailable(type, opt.value, formats)
            || String(opt.value) === String(current);
        if (!usable) {
            choice.classList.add('is-unavailable');
            choice.disabled = true;
            choice.setAttribute('data-tooltip', type === 'video'
                ? t('quality_video_absent', 'Cette définition n\'existe pas pour ce média')
                : t('quality_audio_capped', 'Au-delà de ce que porte la source : '
                    + 'le fichier serait plus lourd, pas meilleur'));
        }

        const markEl = document.createElement('span');
        markEl.className = 'quality-submenu-check';
        markEl.innerHTML = String(opt.value) === String(current) ? ICON_CHECK : '';

        const text = document.createElement('span');
        text.textContent = opt.label;

        choice.appendChild(markEl);
        choice.appendChild(text);

        choice.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!usable) return;
            applyQuality(type, opt.value);
        });

        submenuEl.appendChild(choice);
    });

    menuContainer().appendChild(submenuEl);
    // Ouvert après le menu : le compteur lui donne naturellement le dessus.
    raiseToFront(submenuEl);
    positionSubmenu(btn);
}

function closeSubmenu() {
    if (submenuEl) {
        submenuEl.remove();
        submenuEl = null;
    }
    submenuOpen = null;
    if (menuEl) {
        menuEl.querySelectorAll('.quality-menu-item.is-open').forEach(b => b.classList.remove('is-open'));
    }
}

/** Place le sous-menu à droite du bouton, en basculant à gauche si l'écran manque. */
function positionSubmenu(btn) {
    if (!submenuEl) return;
    const rectBtn = btn.getBoundingClientRect();
    const rectMenu = menuEl.getBoundingClientRect();
    const size = submenuEl.getBoundingClientRect();

    let left = rectMenu.right + 6;
    if (left + size.width > window.innerWidth - 8) {
        left = rectMenu.left - size.width - 6;
    }
    if (left < 8) left = 8;

    let top = rectBtn.top;
    if (top + size.height > window.innerHeight - 8) {
        top = window.innerHeight - size.height - 8;
    }
    if (top < 8) top = 8;

    submenuEl.style.left = `${left}px`;
    submenuEl.style.top = `${top}px`;
}

function applyQuality(type, value) {
    const track = findTrack(openedUrl);
    if (!track) return;

    const data = { url: track.url, title: track.title };
    data[type] = value;

    if (typeof window.MusicPlayer.sendWS === 'function') {
        window.MusicPlayer.sendWS({ type: 'setTrackQuality', data });
    }

    closeSubmenu();
    // Le menu reste ouvert : l'utilisateur voit la nouvelle valeur s'inscrire
    // et, en cas de requalification, la progression démarrer.
    window.MusicPlayer.refreshTrackQualityMenu();
}

/**
 * Empreinte de la *structure* du menu.
 *
 * Volontairement réduite à ce qui change la composition du menu : son titre,
 * la présence des boutons, et les valeurs qu'ils affichent. Tout ce qui évolue
 * en continu — état et pourcentage du préchargement — en est exclu et se met à
 * jour sur place, faute de quoi le menu serait reconstruit chaque seconde et
 * le bouton sous le curseur, détruit puis recréé, ferait clignoter son
 * rectangle de survol.
 */
function signature(track) {
    return [
        track.title, track.isLocal, track.hasVideo,
        track.cachedAudioQuality, track.desiredAudioQuality, track.desiredVideoQuality,
        // L'état de la mesure, jamais la cible : celle-ci change à chaque cran
        // du curseur, et reconstruire le menu à ce rythme arracherait le pouce
        // de sous le doigt. Le passage de « en analyse » à « mesuré », lui,
        // change bien la composition du panneau.
        loudnessOf(track).status
    ].join('|');
}

/**
 * Met à jour les parties mouvantes du menu, sans toucher à sa structure.
 * @param {object} track
 */
function updateMenuValues(track) {
    if (!menuEl) return;
    updateStatus(menuEl.querySelector('.quality-menu-status'), track);
    writeLoudnessValue(menuEl.querySelector('.quality-menu-loudness-value'), loudnessOf(track));
    refreshLoudnessPanel(track);
}

/**
 * Reconstruit le contenu du menu à partir de l'état courant de la piste.
 * @param {boolean} [force] - Rebâtit même si rien n'a changé
 */
function renderMenu(force) {
    const track = findTrack(openedUrl);
    if (!menuEl) return;
    if (!track) {
        window.MusicPlayer.hideTrackQualityMenu();
        return;
    }

    // L'état est diffusé chaque seconde : sans ce garde-fou, le menu serait
    // reconstruit en permanence et perdrait le survol sous le curseur.
    const fingerprint = signature(track);
    if (!force && menuEl._signature === fingerprint) {
        updateMenuValues(track);
        return;
    }
    menuEl._signature = fingerprint;

    menuEl.innerHTML = '';

    const title = document.createElement('div');
    title.className = 'quality-menu-title';
    title.textContent = track.title || '';
    menuEl.appendChild(title);

    menuEl.appendChild(buildStatus(track));

    if (track.isLocal) {
        const note = document.createElement('div');
        note.className = 'quality-menu-note';
        note.textContent = t('import_quality_hint', 'Sans effet sur les fichiers locaux, importés tels quels.');
        menuEl.appendChild(note);
    }

    const separator = document.createElement('div');
    separator.className = 'quality-menu-separator';
    menuEl.appendChild(separator);

    // Au-dessus des réglages de qualité : la source décrit la piste, elle ne se
    // règle pas. Elle vaut aussi pour un fichier local, dont c'est même le seul
    // bouton — sa qualité, elle, n'est pas négociable.
    menuEl.appendChild(buildSourceButton(track));

    // Le niveau sonore vaut pour tout ce qui s'écoute, fichier local compris —
    // c'est même là qu'il sert le plus, un enregistrement personnel n'ayant
    // traversé aucune normalisation de plateforme.
    menuEl.appendChild(buildLoudnessButton(track));

    // L'aiguillage se pose entre deux titres d'une liste rangée : la file
    // d'attente et les playlists. L'historique n'en accueille pas — on ne
    // bascule pas la lecture vers ce qui est déjà joué —, ni la fenêtre vidéo,
    // qui ne désigne aucune position.
    if (openedContext) menuEl.appendChild(buildTransitionButton());

    if (track.isLocal) return;

    const realAudio = !!track.cachedAudioQuality;
    menuEl.appendChild(buildButton(
        'audio',
        `${track.cachedAudioQuality || track.desiredAudioQuality} kbps`,
        realAudio
    ));

    if (track.hasVideo) {
        /*
         * La définition annoncée est celle qu'on obtiendra, pas celle qu'on a
         * demandée.
         *
         * Une piste réglée sur 2160p dont la source s'arrête à 1080p affichait
         * « 2160p » — un chiffre que rien ne viendrait honorer, et qui laissait
         * croire le contraire jusqu'au fichier obtenu. L'inventaire est
         * demandé ici plutôt qu'à l'ouverture du sous-menu : c'est le clic droit
         * qui pose la question, et la réponse est gardée dix minutes.
         */
        askFormats(track.url);
        const formats = formatsByUrl.get(track.url);
        const effective = effectiveVideo(track.desiredVideoQuality, formats);

        menuEl.appendChild(buildButton('video', `${effective}p`, false));
    }
}

/**
 * Construit et insère le menu pour une piste, sans le positionner.
 * @param {object} track
 * @returns {boolean} false si la piste n'est pas exploitable
 */
function openMenu(track, context) {
    if (!track || !track.url) return false;
    window.MusicPlayer.hideTrackQualityMenu();

    openedUrl = track.url;
    openedContext = context || null;
    menuEl = document.createElement('div');
    menuEl.className = 'quality-menu glass-card';
    // Un clic à l'intérieur ne doit pas déclencher la fermeture globale
    menuEl.addEventListener('click', (ev) => ev.stopPropagation());
    menuEl.addEventListener('contextmenu', (ev) => ev.preventDefault());

    menuContainer().appendChild(menuEl);
    raiseToFront(menuEl);
    renderMenu();
    return true;
}

/** Place le menu en le maintenant dans la fenêtre. */
function placeMenu(left, top) {
    const size = menuEl.getBoundingClientRect();
    if (left + size.width > window.innerWidth - 8) left = window.innerWidth - size.width - 8;
    if (top + size.height > window.innerHeight - 8) top = window.innerHeight - size.height - 8;
    menuEl.style.left = `${Math.max(8, left)}px`;
    menuEl.style.top = `${Math.max(8, top)}px`;
}

/**
 * Ouvre le menu de qualité pour une piste, au pointeur.
 * @param {MouseEvent} e - Événement contextmenu, pour le positionnement
 * @param {object} track - Piste telle que reçue dans l'état
 */
window.MusicPlayer.showTrackQualityMenu = function(e, track, context) {
    if (!track || !track.url) return;
    e.preventDefault();
    e.stopPropagation();

    menuKind = 'quality';
    if (openMenu(track, context)) placeMenu(e.clientX, e.clientY);
};

/**
 * Ouvre le menu d'un aiguillage : sa destination, et rien d'autre.
 *
 * Un menu à part, et non une entrée du menu de qualité : un aiguillage n'a ni
 * débit, ni définition, ni sonie, ni source à copier. Lui présenter ces
 * réglages désactivés serait une liste morte à quatre lignes pour un seul choix.
 *
 * Il emprunte en revanche toute la mécanique flottante du menu de qualité —
 * même variable, même placement, mêmes gestes de fermeture. Un quatrième
 * panneau flottant avec ses propres écouteurs finirait par se fermer autrement
 * que les trois autres.
 *
 * @param {MouseEvent} e
 * @param {object} transition - Telle que l'état la porte : `id`, `target`.
 * @param {{ container: string, index: number }} context
 */
window.MusicPlayer.showTransitionMenu = function (e, transition, context) {
    if (!transition || !context) return;
    e.preventDefault();
    e.stopPropagation();

    window.MusicPlayer.hideTrackQualityMenu();
    menuKind = 'transition';
    openedUrl = transition.url;
    openedContext = context;

    menuEl = document.createElement('div');
    menuEl.className = 'quality-menu glass-card transition-menu';
    menuEl.addEventListener('click', (ev) => ev.stopPropagation());
    menuEl.addEventListener('contextmenu', (ev) => ev.preventDefault());

    const titre = document.createElement('div');
    titre.className = 'quality-menu-title';
    titre.textContent = t('transition_edit_title', 'Destination de la transition');
    menuEl.appendChild(titre);

    const cibles = transitionTargets(context.container);

    if (cibles.length === 0) {
        const vide = document.createElement('div');
        vide.className = 'quality-submenu-pending';
        vide.textContent = t('transition_no_target', 'Aucune autre source où aller.');
        menuEl.appendChild(vide);
    } else {
        menuEl.appendChild(buildTargetList(cibles, transition.target, (id) => {
            // Rien à envoyer si c'est déjà là qu'elle mène : la coche a
            // simplement été recliquée.
            if (id !== transition.target) {
                window.MusicPlayer.sendWS({
                    type: 'setTransitionTarget',
                    data: { container: context.container, id: transition.id, target: id },
                });
            }
            closeFloating();
        }));
    }

    menuContainer().appendChild(menuEl);
    raiseToFront(menuEl);
    placeMenu(e.clientX, e.clientY);
};

/**
 * Ouvre le menu de qualité sous un bouton — la roue de la fenêtre vidéo.
 *
 * Aligné à droite de l'ancre : le bouton étant lui-même en haut à droite, un
 * alignement à gauche ferait déborder le menu hors de la fenêtre.
 *
 * @param {HTMLElement} ancre
 * @param {object} track
 */
window.MusicPlayer.showTrackQualityMenuForElement = function(anchorEl, track) {
    if (!anchorEl || !track || !track.url) return;

    // Second clic sur la roue : on referme, comme tout menu de ce genre.
    if (menuEl && openedUrl === track.url && menuEl._ancre === anchorEl) {
        window.MusicPlayer.hideTrackQualityMenu();
        return;
    }

    if (!openMenu(track)) return;
    menuEl._ancre = anchorEl;
    anchorEl.classList.add('is-open');

    const rect = anchorEl.getBoundingClientRect();
    const size = menuEl.getBoundingClientRect();
    placeMenu(rect.right - size.width, rect.bottom + 6);
};

/**
 * Referme le menu, mais seulement s'il a été ouvert depuis une ancre — la roue
 * de qualité de la piste en cours.
 *
 * Cette roue disparaît dès que la lecture ne se prête pas au réglage : rien en
 * cours, ou un fichier local. Le menu qu'elle a ouvert doit partir avec elle,
 * sans quoi il flotterait sans point d'accroche. Celui ouvert au clic droit sur
 * un élément de liste, lui, vise une piste choisie par l'utilisateur et n'a
 * aucune raison de subir le sort de la lecture en cours.
 */
window.MusicPlayer.hideAnchoredTrackQualityMenu = function() {
    if (menuEl && menuEl._ancre) window.MusicPlayer.hideTrackQualityMenu();
};

window.MusicPlayer.hideTrackQualityMenu = function() {
    closeSubmenu();
    if (menuEl) {
        // L'ancre reflète l'état ouvert/fermé (roue mise en évidence)
        if (menuEl._ancre) menuEl._ancre.classList.remove('is-open');
        menuEl.remove();
        menuEl = null;
    }
    openedUrl = null;
    openedContext = null;
    menuKind = 'quality';
};

/**
 * Réaffiche le menu ouvert avec les données fraîches de l'état.
 * Appelée à chaque mise à jour de la file, de l'historique ou des playlists.
 */
window.MusicPlayer.refreshTrackQualityMenu = function() {
    if (!menuEl || !openedUrl) return;

    // Le menu d'un aiguillage ne se reconstruit pas : il ne montre qu'une
    // destination, qui ne change qu'au geste de l'utilisateur. Le passer à
    // renderMenu ferait chercher une piste à son adresse, et le refermerait.
    if (menuKind !== 'quality') return;

    const before = menuEl._signature;
    const openType = submenuOpen;
    renderMenu();
    if (menuEl._signature === before) return; // Rien n'a bougé, sous-menu intact

    // Le sous-menu déplié a été emporté par la reconstruction : on le rouvre
    // pour qu'il reflète la nouvelle sélection.
    if (openType) {
        const btn = menuEl.querySelector(`.quality-menu-item[data-quality-type="${openType}"]`);
        if (btn) {
            submenuOpen = null;
            toggleSubmenu(openType, btn);
        }
    }
};

/** Nombre de flèches animées le long d'un élément en cours de requalification. */
const ARROW_COUNT = 5;

/**
 * Ajoute à un élément de liste les calques de requalification : une barre de
 * progression posée sur le vert du préchargement, et les flèches animées.
 *
 * Construits une fois à la création de l'élément et laissés masqués : les
 * afficher revient à poser une classe, sans toucher au DOM en pleine animation.
 *
 * @param {HTMLElement} item
 */
window.MusicPlayer.setupRequalifyLayer = function(item) {
    if (!item || item.querySelector('.requalify-fill-bar')) return;

    const bar = document.createElement('div');
    bar.className = 'requalify-fill-bar';
    item.appendChild(bar);

    const layer = document.createElement('div');
    layer.className = 'requalify-arrows';
    for (let i = 0; i < ARROW_COUNT; i++) {
        const arrow = document.createElement('span');
        arrow.className = 'requalify-arrow';
        // Réparties sur la largeur, décalées dans le temps : le flux paraît
        // continu sans qu'aucune flèche n'en double une autre.
        arrow.style.left = `${8 + (i * 84 / ARROW_COUNT) + (i % 2 ? 6 : 0)}%`;
        arrow.style.animationDelay = `${(i * 2.2 / ARROW_COUNT).toFixed(2)}s`;
        layer.appendChild(arrow);
    }
    item.appendChild(layer);
};

/**
 * Reflète l'état de requalification d'une piste sur son élément de liste.
 * @param {HTMLElement} item
 * @param {object} track
 */
window.MusicPlayer.applyRequalifyState = function(item, track) {
    if (!item) return;
    const requalify = track && track.requalify;

    item.classList.toggle('is-requalifying', !!requalify);
    item.classList.toggle('requalify-up', !!requalify && requalify.direction !== 'down');
    item.classList.toggle('requalify-down', !!requalify && requalify.direction === 'down');

    const bar = item.querySelector('.requalify-fill-bar');
    if (!bar) return;

    if (!requalify) {
        bar.style.transform = 'scaleX(0)';
        return;
    }

    const pct = Math.min(100, Math.max(0, requalify.progress || 0));
    const scale = Math.max(0.0001, pct / 100);
    bar.style.transform = `scaleX(${pct / 100})`;
    bar.style.setProperty('--requalify-scale', scale);

    // Distance de vol des flèches : la hauteur de l'élément, pour qu'elles le
    // traversent exactement de bord à bord quelle que soit la liste.
    const height = item.offsetHeight || 46;
    item.style.setProperty('--requalify-travel', `${height + 12}px`);
};

/**
 * Branche le clic droit d'un élément de liste sur le menu de qualité.
 * @param {HTMLElement} item
 * @param {() => object} resolveTrack - Relit la piste à l'ouverture, pas au branchement
 */
/**
 * L'inventaire arrive : le sous-menu ouvert le prend en compte séance tenante.
 *
 * Il s'est peint en « recherche… » une ou deux secondes plus tôt ; le laisser
 * ainsi jusqu'à la prochaine ouverture ferait de la réponse une chose qu'on ne
 * voit jamais. Rouvrir au même endroit remplace la liste sans la déplacer.
 */
window.MusicPlayer.onTrackFormats = function (data) {
    if (!data || !data.url) return;
    formatsByUrl.set(data.url, data);

    if (openedUrl !== data.url || !menuEl) return;

    // Le menu lui-même en dépend désormais : son bouton vidéo annonce la
    // définition qu'on obtiendra, laquelle vient d'être apprise.
    const type = submenuOpen;
    renderMenu();
    if (!type) return;

    const bouton = menuEl.querySelector(`[data-quality-type="${type}"]`);
    if (!bouton) return;

    // `toggleSubmenu` referme quand on lui redonne le type ouvert : on remet le
    // drapeau à zéro pour qu'il rouvre au lieu de fermer.
    submenuOpen = null;
    toggleSubmenu(type, bouton);
};

/* ═════════════ Le même panneau, ouvert hors du menu contextuel ═════════════ */

/**
 * Panneau de sonie ouvert depuis ailleurs que le clic droit.
 *
 * Les deux nombres de la carte « Volume et diffusion » disent la sonie du
 * morceau et le gain qu'on lui applique. Ils ne faisaient que la dire : pour
 * changer ce gain, il fallait retrouver la piste dans la file ou l'historique et
 * l'ouvrir au clic droit — un détour pour régler ce qu'on est justement en train
 * d'écouter.
 *
 * C'est le panneau du menu contextuel qui s'ouvre, pas une copie : le curseur,
 * la mesure d'origine, le repère d'écrêtage et l'envoi groupé sont les mêmes.
 * Deux vues du même réglage qui divergeraient seraient pires qu'une seule.
 */
let loosePanel = null;
let looseUrl = null;
let looseAnchor = null;

/**
 * Ouvre le panneau de sonie sous un élément quelconque.
 *
 * @param {object} track - La piste à régler, telle que l'état la porte.
 * @param {HTMLElement} anchor - Ce sous quoi le panneau se place.
 * @returns {boolean} false si la piste n'est pas réglable.
 */
window.MusicPlayer.openLoudnessPanel = function (track, anchor) {
    if (!track || !track.url) return false;

    // Un clic sur le même bouton referme : c'est ce qu'on attend d'un bouton
    // qui a ouvert quelque chose.
    if (loosePanel && looseUrl === track.url) {
        window.MusicPlayer.closeLoudnessPanel();
        return false;
    }

    window.MusicPlayer.closeLoudnessPanel();
    // Le menu contextuel et ce panneau ne cohabitent pas : deux réglages de la
    // même chose ouverts en même temps, dont un seul recevrait les mises à jour.
    window.MusicPlayer.hideTrackQualityMenu();

    loosePanel = buildLoudnessPanel(track);
    looseUrl = track.url;
    looseAnchor = anchor || null;

    menuContainer().appendChild(loosePanel);
    raiseToFront(loosePanel);
    placeLoosePanel();

    if (looseAnchor) looseAnchor.classList.add('is-open');
    return true;
};

/** Referme le panneau autonome, s'il y en a un. */
window.MusicPlayer.closeLoudnessPanel = function () {
    if (!loosePanel) return;
    loosePanel.remove();
    loosePanel = null;
    looseUrl = null;
    if (looseAnchor) looseAnchor.classList.remove('is-open');
    looseAnchor = null;
};

/**
 * Place le panneau sous son ancre, sans sortir de la fenêtre.
 *
 * Sous et non à côté, contrairement au sous-menu : l'ancre est ici un petit
 * nombre au milieu d'une ligne, et se poser à sa droite recouvrirait le reste de
 * la ligne — dont l'autre nombre, qu'on veut garder sous les yeux.
 */
function placeLoosePanel() {
    if (!loosePanel) return;

    const size = loosePanel.getBoundingClientRect();
    const rect = looseAnchor
        ? looseAnchor.getBoundingClientRect()
        : { left: 40, bottom: 40, top: 40 };

    const spot = panelSpot(size, rect,
        { width: window.innerWidth, height: window.innerHeight });

    loosePanel.style.left = `${spot.left}px`;
    loosePanel.style.top = `${spot.top}px`;
}

/**
 * Où poser le panneau, sur les seules dimensions en jeu.
 *
 * Détachée du DOM parce que c'est la seule partie qui décide quelque chose :
 * autour d'elle, il n'y a que deux mesures à prendre et deux valeurs à écrire
 * dans un style. Une décision qu'on ne peut atteindre qu'en montant une fenêtre
 * entière finit par n'être vérifiée nulle part.
 *
 * @param {{ width: number, height: number }} size - Le panneau, déjà mesuré.
 * @param {{ left: number, top: number, bottom: number }} rect - L'ancre.
 * @param {{ width: number, height: number }} view - La fenêtre visible.
 * @returns {{ left: number, top: number }}
 */
function panelSpot(size, rect, view) {
    let left = rect.left;
    if (left + size.width > view.width - 8) left = view.width - size.width - 8;
    if (left < 8) left = 8;

    let top = rect.bottom + 6;
    // Pas la place en dessous : au-dessus, plutôt que collé au bord où il
    // recouvrirait ce qu'on vient de cliquer.
    if (top + size.height > view.height - 8) top = rect.top - size.height - 6;
    if (top < 8) top = 8;

    return { left, top };
}

/**
 * Recale le panneau autonome sur l'état reçu.
 *
 * Appelé à chaque diffusion : c'est ce qui fait apparaître la mesure quand
 * l'analyse se termine pendant que le panneau est ouvert.
 */
window.MusicPlayer.refreshLoudnessPanel = function (track) {
    if (!loosePanel || !looseUrl) return;
    if (!track || track.url !== looseUrl) return;
    recalePanel(loosePanel, track);
};


window.MusicPlayer.attachQualityMenu = function(item, resolveTrack, resolveContext) {
    if (!item) return;
    item.addEventListener('contextmenu', (e) => {
        const track = typeof resolveTrack === 'function' ? resolveTrack() : null;
        // Relu au clic droit, et non retenu à l'accrochage : la ligne garde son
        // gestionnaire pendant que la liste bouge sous elle, et un indice figé
        // finirait par désigner le voisin.
        const context = typeof resolveContext === 'function' ? resolveContext() : null;
        if (track) window.MusicPlayer.showTrackQualityMenu(e, track, context);
    });
};

/*
 * Le panneau autonome se ferme par les mêmes gestes que le menu.
 *
 * Il flotte au-dessus de la page comme lui, et n'appartient à aucune carte :
 * cliquer ailleurs, redimensionner ou appuyer sur Échap doit l'emporter aussi,
 * sans quoi il resterait posé sur une interface qui a changé sous lui.
 */
function closeFloating() {
    window.MusicPlayer.hideTrackQualityMenu();
    window.MusicPlayer.closeLoudnessPanel();
}

document.addEventListener('click', closeFloating);
window.addEventListener('resize', closeFloating);
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeFloating();
});

/*
 * Fermeture au défilement : sur la molette, pas sur l'événement `scroll`.
 *
 * Un écouteur `scroll` en phase de capture voit le défilement de n'importe
 * quel conteneur — y compris celui, purement technique, que provoque la
 * reconstruction d'une liste quand son `scrollTop` retombe à zéro. Le menu se
 * refermait alors tout seul au premier rafraîchissement d'état.
 *
 * La molette, elle, traduit une intention : l'utilisateur va ailleurs. On
 * ignore celle qui vient du menu lui-même, un sous-menu pouvant déborder.
 */
window.addEventListener('wheel', (e) => {
    if (!menuEl && !loosePanel) return;
    if (menuEl && menuEl.contains(e.target)) return;
    if (submenuEl && submenuEl.contains(e.target)) return;
    // Le curseur de sonie se règle aussi à la molette : défiler dessus ne doit
    // pas emporter le panneau qu'on est en train d'utiliser.
    if (loosePanel && loosePanel.contains(e.target)) return;
    closeFloating();
}, { passive: true, capture: true });
