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
const DEBITS_AUDIO = [
    { value: '320', label: '320 kbps' },
    { value: '256', label: '256 kbps' },
    { value: '192', label: '192 kbps' },
    { value: '128', label: '128 kbps' },
    { value: '96', label: '96 kbps' }
];

/** Hauteurs vidéo proposées, de la plus élevée à la plus faible. */
const HAUTEURS_VIDEO = [
    { value: '2160', label: '2160p (4K)' },
    { value: '1440', label: '1440p (QHD)' },
    { value: '1080', label: '1080p' },
    { value: '720', label: '720p' },
    { value: '480', label: '480p' },
    { value: '360', label: '360p' }
];

const ICONE_AUDIO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>';
const ICONE_VIDEO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg>';
const ICONE_CHEVRON = '<svg class="quality-menu-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>';
const ICONE_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
const ICONE_LIEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>';
const ICONE_DOSSIER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>';
const ICONE_COPIE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';

let menuEl = null;
let sousMenuEl = null;
/** URL de la piste ouverte : sert à retrouver son état frais à chaque diffusion. */
let urlOuverte = null;
/** 'audio' | 'video' | null — sous-menu actuellement déplié. */
let sousMenuOuvert = null;

function t(cle, defaut) {
    const traduit = window.MusicPlayer.t ? window.MusicPlayer.t(cle) : cle;
    return traduit === cle ? defaut : traduit;
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
function retrouverPiste(url) {
    const state = window.MusicPlayer.state;
    if (!state || !url) return null;

    // La piste en cours d'abord : c'est celle que vise la roue de la fenêtre
    // vidéo, et elle n'appartient plus à la file une fois lancée.
    const viviers = [
        state.currentTrack ? [state.currentTrack] : [],
        state.queue || [],
        state.history || []
    ];
    (state.playlists || []).forEach(p => viviers.push(p.tracks || []));

    for (const vivier of viviers) {
        const trouve = vivier.find(t => t && t.url === url);
        if (trouve) return trouve;
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
function conteneurMenu() {
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
function hisserAuPremierPlan(el) {
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
function construireStatut(track) {
    const ligne = document.createElement('div');
    ligne.className = 'quality-menu-status';

    const pastille = document.createElement('span');
    pastille.className = 'quality-menu-dot';

    const texte = document.createElement('span');
    texte.className = 'quality-menu-status-text';

    const valeur = document.createElement('span');
    valeur.className = 'quality-menu-status-value';

    ligne.appendChild(pastille);
    ligne.appendChild(texte);
    ligne.appendChild(valeur);
    majStatut(ligne, track);
    return ligne;
}

/**
 * Écrit l'état du préchargement dans une ligne existante.
 *
 * Tout passe par des modifications sur place — classes et textes — car cette
 * ligne est la seule partie du menu qui évolue en continu. La reconstruire
 * emporterait les boutons voisins et ferait clignoter le survol.
 *
 * @param {HTMLElement} ligne
 * @param {object} track
 */
function majStatut(ligne, track) {
    if (!ligne) return;
    const texte = ligne.querySelector('.quality-menu-status-text');
    const valeur = ligne.querySelector('.quality-menu-status-value');

    let classes = [];
    let libelle;
    let chiffre;

    if (track.isLocal) {
        classes = ['is-local'];
        libelle = t('quality_menu_local', 'Fichier local');
        chiffre = t('quality_menu_local_short', 'tel quel');
    } else if (track.requalify) {
        classes = ['is-requalifying', track.requalify.direction === 'down' ? 'is-down' : 'is-up'];
        libelle = t('quality_menu_requalifying', 'Nouvelle qualité en cours');
        chiffre = `${Math.round(track.requalify.progress || 0)} %`;
    } else if (track.isPreloaded) {
        classes = ['is-preloaded'];
        libelle = t('quality_menu_preloaded', 'Préchargé');
        chiffre = '100 %';
    } else if (track.isPreloading) {
        classes = ['is-preloading'];
        libelle = t('quality_menu_preloading', 'Préchargement…');
        chiffre = `${Math.round(track.preloadProgress || 0)} %`;
    } else {
        libelle = t('quality_menu_not_preloaded', 'Non préchargé');
        chiffre = '—';
    }

    const cible = `quality-menu-status ${classes.join(' ')}`.trim();
    if (ligne.className !== cible) ligne.className = cible;
    if (texte && texte.textContent !== libelle) texte.textContent = libelle;
    if (valeur && valeur.textContent !== chiffre) valeur.textContent = chiffre;
}

/**
 * Construit un bouton de qualité.
 * @param {'audio'|'video'} type
 * @param {string} valeurAffichee
 * @param {boolean} estReelle - true si la valeur décrit le fichier en cache
 */
function construireBouton(type, valeurAffichee, estReelle) {
    const btn = document.createElement('button');
    btn.className = 'quality-menu-item';
    btn.dataset.qualityType = type;

    const icone = document.createElement('span');
    icone.className = 'quality-menu-icon';
    icone.innerHTML = type === 'audio' ? ICONE_AUDIO : ICONE_VIDEO;

    const libelle = document.createElement('span');
    libelle.className = 'quality-menu-label';
    libelle.textContent = type === 'audio'
        ? t('import_audio_quality_label', 'Audio')
        : t('import_video_quality_label', 'Vidéo');

    const valeur = document.createElement('span');
    valeur.className = 'quality-menu-value';
    valeur.textContent = valeurAffichee;
    // Une valeur simplement souhaitée n'engage rien tant que le fichier n'est
    // pas préchargé : elle est signalée comme telle plutôt que présentée
    // comme la qualité effective du média.
    if (!estReelle) valeur.classList.add('is-desired');
    valeur.dataset.tooltip = estReelle
        ? t('quality_menu_actual_hint', 'Qualité du fichier préchargé')
        : t('quality_menu_desired_hint', 'Qualité souhaitée, appliquée au préchargement');

    const chevron = document.createElement('span');
    chevron.className = 'quality-menu-arrow';
    chevron.innerHTML = ICONE_CHEVRON;

    btn.appendChild(icone);
    btn.appendChild(libelle);
    btn.appendChild(valeur);
    btn.appendChild(chevron);

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        basculerSousMenu(type, btn);
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
function sourceEstUnLien(track) {
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
function construireBoutonSource(track) {
    const estLien = sourceEstUnLien(track);

    const btn = document.createElement('button');
    btn.className = 'quality-menu-item quality-menu-source';

    const icone = document.createElement('span');
    icone.className = 'quality-menu-icon';
    icone.innerHTML = estLien ? ICONE_LIEN : ICONE_DOSSIER;

    const libelle = document.createElement('span');
    libelle.className = 'quality-menu-label';
    libelle.textContent = estLien
        ? t('quality_menu_copy_link', 'Copier le lien')
        : t('quality_menu_copy_path', 'Copier le chemin d\'accès');

    // La source complète en infobulle : le menu est trop étroit pour l'afficher,
    // et c'est pourtant elle qu'on s'apprête à copier.
    btn.dataset.tooltip = track.url || '';

    const marque = document.createElement('span');
    marque.className = 'quality-menu-arrow quality-menu-copy-mark';
    marque.innerHTML = ICONE_COPIE;

    btn.appendChild(icone);
    btn.appendChild(libelle);
    btn.appendChild(marque);

    btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const copie = await window.MusicPlayer.copierDansPressePapier(track.url);

        // Le menu reste ouvert : la coche confirme sur place, sans chasser
        // l'utilisateur d'un menu où il a peut-être encore à faire.
        btn.classList.toggle('is-copied', copie);
        libelle.textContent = copie
            ? t('quality_menu_copied', 'Copié')
            : t('quality_menu_copy_failed', 'Copie impossible');
        marque.innerHTML = copie ? ICONE_CHECK : ICONE_COPIE;

        clearTimeout(btn._retour);
        btn._retour = setTimeout(() => {
            btn.classList.remove('is-copied');
            libelle.textContent = estLien
                ? t('quality_menu_copy_link', 'Copier le lien')
                : t('quality_menu_copy_path', 'Copier le chemin d\'accès');
            marque.innerHTML = ICONE_COPIE;
        }, 1500);
    });

    return btn;
}

/** Ouvre (ou referme) le sous-menu de choix rattaché à un bouton. */
function basculerSousMenu(type, btn) {
    if (sousMenuOuvert === type) {
        fermerSousMenu();
        return;
    }
    fermerSousMenu();
    sousMenuOuvert = type;
    btn.classList.add('is-open');

    const track = retrouverPiste(urlOuverte);
    if (!track) return;

    const options = type === 'audio' ? DEBITS_AUDIO : HAUTEURS_VIDEO;
    const courante = type === 'audio'
        ? (track.cachedAudioQuality || track.desiredAudioQuality)
        : track.desiredVideoQuality;

    sousMenuEl = document.createElement('div');
    sousMenuEl.className = 'quality-submenu glass-card';
    // Posé sur <body> pour échapper au découpage du menu : ses clics doivent
    // donc être retenus ici, sinon ils remonteraient à la fermeture globale.
    sousMenuEl.addEventListener('click', (e) => e.stopPropagation());
    sousMenuEl.addEventListener('contextmenu', (e) => e.preventDefault());

    options.forEach(opt => {
        const choix = document.createElement('button');
        choix.className = 'quality-submenu-item';
        if (String(opt.value) === String(courante)) choix.classList.add('is-current');

        const marque = document.createElement('span');
        marque.className = 'quality-submenu-check';
        marque.innerHTML = String(opt.value) === String(courante) ? ICONE_CHECK : '';

        const texte = document.createElement('span');
        texte.textContent = opt.label;

        choix.appendChild(marque);
        choix.appendChild(texte);

        choix.addEventListener('click', (e) => {
            e.stopPropagation();
            appliquerQualite(type, opt.value);
        });

        sousMenuEl.appendChild(choix);
    });

    conteneurMenu().appendChild(sousMenuEl);
    // Ouvert après le menu : le compteur lui donne naturellement le dessus.
    hisserAuPremierPlan(sousMenuEl);
    positionnerSousMenu(btn);
}

function fermerSousMenu() {
    if (sousMenuEl) {
        sousMenuEl.remove();
        sousMenuEl = null;
    }
    sousMenuOuvert = null;
    if (menuEl) {
        menuEl.querySelectorAll('.quality-menu-item.is-open').forEach(b => b.classList.remove('is-open'));
    }
}

/** Place le sous-menu à droite du bouton, en basculant à gauche si l'écran manque. */
function positionnerSousMenu(btn) {
    if (!sousMenuEl) return;
    const rectBtn = btn.getBoundingClientRect();
    const rectMenu = menuEl.getBoundingClientRect();
    const taille = sousMenuEl.getBoundingClientRect();

    let left = rectMenu.right + 6;
    if (left + taille.width > window.innerWidth - 8) {
        left = rectMenu.left - taille.width - 6;
    }
    if (left < 8) left = 8;

    let top = rectBtn.top;
    if (top + taille.height > window.innerHeight - 8) {
        top = window.innerHeight - taille.height - 8;
    }
    if (top < 8) top = 8;

    sousMenuEl.style.left = `${left}px`;
    sousMenuEl.style.top = `${top}px`;
}

function appliquerQualite(type, valeur) {
    const track = retrouverPiste(urlOuverte);
    if (!track) return;

    const data = { url: track.url, title: track.title };
    data[type] = valeur;

    if (typeof window.MusicPlayer.sendWS === 'function') {
        window.MusicPlayer.sendWS({ type: 'setTrackQuality', data });
    }

    fermerSousMenu();
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
function majValeursMenu(track) {
    if (!menuEl) return;
    majStatut(menuEl.querySelector('.quality-menu-status'), track);
}

/**
 * Reconstruit le contenu du menu à partir de l'état courant de la piste.
 * @param {boolean} [forcer] - Rebâtit même si rien n'a changé
 */
function rendreMenu(forcer) {
    const track = retrouverPiste(urlOuverte);
    if (!menuEl) return;
    if (!track) {
        window.MusicPlayer.hideTrackQualityMenu();
        return;
    }

    // L'état est diffusé chaque seconde : sans ce garde-fou, le menu serait
    // reconstruit en permanence et perdrait le survol sous le curseur.
    const empreinte = signature(track);
    if (!forcer && menuEl._signature === empreinte) {
        majValeursMenu(track);
        return;
    }
    menuEl._signature = empreinte;

    menuEl.innerHTML = '';

    const titre = document.createElement('div');
    titre.className = 'quality-menu-title';
    titre.textContent = track.title || '';
    menuEl.appendChild(titre);

    menuEl.appendChild(construireStatut(track));

    if (track.isLocal) {
        const note = document.createElement('div');
        note.className = 'quality-menu-note';
        note.textContent = t('import_quality_hint', 'Sans effet sur les fichiers locaux, importés tels quels.');
        menuEl.appendChild(note);
    }

    const separateur = document.createElement('div');
    separateur.className = 'quality-menu-separator';
    menuEl.appendChild(separateur);

    // Au-dessus des réglages de qualité : la source décrit la piste, elle ne se
    // règle pas. Elle vaut aussi pour un fichier local, dont c'est même le seul
    // bouton — sa qualité, elle, n'est pas négociable.
    menuEl.appendChild(construireBoutonSource(track));

    if (track.isLocal) return;

    const audioReelle = !!track.cachedAudioQuality;
    menuEl.appendChild(construireBouton(
        'audio',
        `${track.cachedAudioQuality || track.desiredAudioQuality} kbps`,
        audioReelle
    ));

    if (track.hasVideo) {
        menuEl.appendChild(construireBouton('video', `${track.desiredVideoQuality}p`, false));
    }
}

/**
 * Construit et insère le menu pour une piste, sans le positionner.
 * @param {object} track
 * @returns {boolean} false si la piste n'est pas exploitable
 */
function ouvrirMenu(track) {
    if (!track || !track.url) return false;
    window.MusicPlayer.hideTrackQualityMenu();

    urlOuverte = track.url;
    menuEl = document.createElement('div');
    menuEl.className = 'quality-menu glass-card';
    // Un clic à l'intérieur ne doit pas déclencher la fermeture globale
    menuEl.addEventListener('click', (ev) => ev.stopPropagation());
    menuEl.addEventListener('contextmenu', (ev) => ev.preventDefault());

    conteneurMenu().appendChild(menuEl);
    hisserAuPremierPlan(menuEl);
    rendreMenu();
    return true;
}

/** Place le menu en le maintenant dans la fenêtre. */
function placerMenu(left, top) {
    const taille = menuEl.getBoundingClientRect();
    if (left + taille.width > window.innerWidth - 8) left = window.innerWidth - taille.width - 8;
    if (top + taille.height > window.innerHeight - 8) top = window.innerHeight - taille.height - 8;
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

    if (ouvrirMenu(track)) placerMenu(e.clientX, e.clientY);
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
window.MusicPlayer.showTrackQualityMenuForElement = function(ancre, track) {
    if (!ancre || !track || !track.url) return;

    // Second clic sur la roue : on referme, comme tout menu de ce genre.
    if (menuEl && urlOuverte === track.url && menuEl._ancre === ancre) {
        window.MusicPlayer.hideTrackQualityMenu();
        return;
    }

    if (!ouvrirMenu(track)) return;
    menuEl._ancre = ancre;
    ancre.classList.add('is-open');

    const rect = ancre.getBoundingClientRect();
    const taille = menuEl.getBoundingClientRect();
    placerMenu(rect.right - taille.width, rect.bottom + 6);
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
    fermerSousMenu();
    if (menuEl) {
        // L'ancre reflète l'état ouvert/fermé (roue mise en évidence)
        if (menuEl._ancre) menuEl._ancre.classList.remove('is-open');
        menuEl.remove();
        menuEl = null;
    }
    urlOuverte = null;
};

/**
 * Réaffiche le menu ouvert avec les données fraîches de l'état.
 * Appelée à chaque mise à jour de la file, de l'historique ou des playlists.
 */
window.MusicPlayer.refreshTrackQualityMenu = function() {
    if (!menuEl || !urlOuverte) return;

    const avant = menuEl._signature;
    const typeOuvert = sousMenuOuvert;
    rendreMenu();
    if (menuEl._signature === avant) return; // Rien n'a bougé, sous-menu intact

    // Le sous-menu déplié a été emporté par la reconstruction : on le rouvre
    // pour qu'il reflète la nouvelle sélection.
    if (typeOuvert) {
        const btn = menuEl.querySelector(`.quality-menu-item[data-quality-type="${typeOuvert}"]`);
        if (btn) {
            sousMenuOuvert = null;
            basculerSousMenu(typeOuvert, btn);
        }
    }
};

/** Nombre de flèches animées le long d'un élément en cours de requalification. */
const NB_FLECHES = 5;

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

    const barre = document.createElement('div');
    barre.className = 'requalify-fill-bar';
    item.appendChild(barre);

    const calque = document.createElement('div');
    calque.className = 'requalify-arrows';
    for (let i = 0; i < NB_FLECHES; i++) {
        const fleche = document.createElement('span');
        fleche.className = 'requalify-arrow';
        // Réparties sur la largeur, décalées dans le temps : le flux paraît
        // continu sans qu'aucune flèche n'en double une autre.
        fleche.style.left = `${8 + (i * 84 / NB_FLECHES) + (i % 2 ? 6 : 0)}%`;
        fleche.style.animationDelay = `${(i * 2.2 / NB_FLECHES).toFixed(2)}s`;
        calque.appendChild(fleche);
    }
    item.appendChild(calque);
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

    const barre = item.querySelector('.requalify-fill-bar');
    if (!barre) return;

    if (!requalify) {
        barre.style.transform = 'scaleX(0)';
        return;
    }

    const pct = Math.min(100, Math.max(0, requalify.progress || 0));
    const echelle = Math.max(0.0001, pct / 100);
    barre.style.transform = `scaleX(${pct / 100})`;
    barre.style.setProperty('--requalify-scale', echelle);

    // Distance de vol des flèches : la hauteur de l'élément, pour qu'elles le
    // traversent exactement de bord à bord quelle que soit la liste.
    const hauteur = item.offsetHeight || 46;
    item.style.setProperty('--requalify-travel', `${hauteur + 12}px`);
};

/**
 * Branche le clic droit d'un élément de liste sur le menu de qualité.
 * @param {HTMLElement} item
 * @param {() => object} resoudrePiste - Relit la piste à l'ouverture, pas au branchement
 */
window.MusicPlayer.attachQualityMenu = function(item, resoudrePiste) {
    if (!item) return;
    item.addEventListener('contextmenu', (e) => {
        const track = typeof resoudrePiste === 'function' ? resoudrePiste() : null;
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
    if (sousMenuEl && sousMenuEl.contains(e.target)) return;
    window.MusicPlayer.hideTrackQualityMenu();
}, { passive: true, capture: true });
