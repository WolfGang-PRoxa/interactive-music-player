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

let menuEl = null;
let submenuEl = null;
/** URL de la piste ouverte : sert à retrouver son état frais à chaque diffusion. */
let openedUrl = null;
/** 'audio' | 'video' | null — sous-menu actuellement déplié. */
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
/*
 * ── Le plein écran du système ──────────────────────────────────
 *
 * Le bouton de la barre agrandit la fenêtre du lecteur à la page ; sur iPhone,
 * les barres du navigateur restent, et rien dans une page web ne peut les
 * retirer. Le seul plein écran qu'iOS accorde est celui d'un `<video>`, où son
 * propre lecteur prend la main — nos commandes disparaissent le temps de la
 * séance. Les deux ne se remplacent donc pas : celui-ci vit ici, à côté, et
 * s'annonce pour ce qu'il coûte.
 */

const ICON_EXPAND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
    + 'stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"></path>'
    + '</svg>';

/**
 * Y a-t-il une vraie vidéo à confier au système ?
 *
 * La réponse vit dans js/video.js, auprès de l'appel lui-même : afficher une
 * entrée dans un cas et la refuser dans l'autre serait deux vérités à tenir en
 * phase. Une piste audio est dessinée sur un canevas et n'a pas de vidéo — le
 * lecteur du système n'y montrerait rien.
 */
function nativeFullscreenAvailable() {
    return typeof window.MusicPlayer.canEnterNativeVideoFullscreen === 'function'
        && window.MusicPlayer.canEnterNativeVideoFullscreen();
}

function buildNativeFullscreenButton() {
    const btn = document.createElement('button');
    btn.className = 'quality-menu-item quality-menu-source';

    const icon = document.createElement('span');
    icon.className = 'quality-menu-icon';
    icon.innerHTML = ICON_EXPAND;

    const label = document.createElement('span');
    label.className = 'quality-menu-label';
    label.textContent = t('quality_menu_native_fullscreen', 'Vrai plein écran');

    // Ce que l'entrée coûte, dit avant le clic et non après.
    btn.dataset.tooltip = t(
        'quality_menu_native_fullscreen_hint',
        'Plein écran du système, sans les barres du navigateur. Les commandes du lecteur laissent la place à celles du système.'
    );

    btn.appendChild(icon);
    btn.appendChild(label);

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        // Depuis le geste lui-même : iOS refuse la demande autrement.
        window.MusicPlayer.enterNativeVideoFullscreen();
        window.MusicPlayer.hideTrackQualityMenu();
    });

    return btn;
}

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

    options.forEach(opt => {
        const choice = document.createElement('button');
        choice.className = 'quality-submenu-item';
        if (String(opt.value) === String(current)) choice.classList.add('is-current');

        const markEl = document.createElement('span');
        markEl.className = 'quality-submenu-check';
        markEl.innerHTML = String(opt.value) === String(current) ? ICON_CHECK : '';

        const text = document.createElement('span');
        text.textContent = opt.label;

        choice.appendChild(markEl);
        choice.appendChild(text);

        choice.addEventListener('click', (e) => {
            e.stopPropagation();
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
        track.cachedAudioQuality, track.desiredAudioQuality, track.desiredVideoQuality
    ].join('|');
}

/**
 * Met à jour les parties mouvantes du menu, sans toucher à sa structure.
 * @param {object} track
 */
function updateMenuValues(track) {
    if (!menuEl) return;
    updateStatus(menuEl.querySelector('.quality-menu-status'), track);
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

    /*
     * Avant la sortie réservée aux fichiers locaux, et non après : un `.wav`
     * importé se joue par le visualiseur, et c'est précisément le cas où ce
     * plein écran-ci est le seul à savoir retirer les barres du navigateur.
     * L'entrée n'apparaît que si le lecteur vidéo est ouvert — elle agrandit sa
     * fenêtre, elle n'a pas de sens quand il n'y en a pas.
     */
    if (nativeFullscreenAvailable()) {
        menuEl.appendChild(buildNativeFullscreenButton());
    }

    if (track.isLocal) return;

    const realAudio = !!track.cachedAudioQuality;
    menuEl.appendChild(buildButton(
        'audio',
        `${track.cachedAudioQuality || track.desiredAudioQuality} kbps`,
        realAudio
    ));

    if (track.hasVideo) {
        menuEl.appendChild(buildButton('video', `${track.desiredVideoQuality}p`, false));
    }
}

/**
 * Construit et insère le menu pour une piste, sans le positionner.
 * @param {object} track
 * @returns {boolean} false si la piste n'est pas exploitable
 */
function openMenu(track) {
    if (!track || !track.url) return false;
    window.MusicPlayer.hideTrackQualityMenu();

    openedUrl = track.url;
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
window.MusicPlayer.showTrackQualityMenu = function(e, track) {
    if (!track || !track.url) return;
    e.preventDefault();
    e.stopPropagation();

    if (openMenu(track)) placeMenu(e.clientX, e.clientY);
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
};

/**
 * Réaffiche le menu ouvert avec les données fraîches de l'état.
 * Appelée à chaque mise à jour de la file, de l'historique ou des playlists.
 */
window.MusicPlayer.refreshTrackQualityMenu = function() {
    if (!menuEl || !openedUrl) return;

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
window.MusicPlayer.attachQualityMenu = function(item, resolveTrack) {
    if (!item) return;
    item.addEventListener('contextmenu', (e) => {
        const track = typeof resolveTrack === 'function' ? resolveTrack() : null;
        if (track) window.MusicPlayer.showTrackQualityMenu(e, track);
    });
};

document.addEventListener('click', () => window.MusicPlayer.hideTrackQualityMenu());
window.addEventListener('resize', () => window.MusicPlayer.hideTrackQualityMenu());
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') window.MusicPlayer.hideTrackQualityMenu();
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
    if (!menuEl) return;
    if (menuEl.contains(e.target)) return;
    if (submenuEl && submenuEl.contains(e.target)) return;
    window.MusicPlayer.hideTrackQualityMenu();
}, { passive: true, capture: true });
