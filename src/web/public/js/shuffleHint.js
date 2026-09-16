/**
 * shuffleHint — Le menu du mode aléatoire, et l'invitation à tout précharger.
 *
 * ## Pourquoi il existe
 *
 * En lecture aléatoire, le titre suivant est tiré au moment de l'enchaînement :
 * rien ne peut donc être préparé d'avance à partir de l'ordre de la liste, ni le
 * fondu du navigateur (voir `nextTrackOf` dans js/state.js) ni le morceau que le
 * bot garde au chaud. Le préchargement, lui, s'y prête — réglé sur « infini », il
 * met la file ou les playlists entières en cache, et le tirage tombe alors
 * toujours sur un morceau déjà prêt.
 *
 * Ce réglage vit dans la fenêtre des paramètres, à trois clics d'ici. Envoyer
 * l'utilisateur l'y chercher pour un mode qu'il vient d'activer serait lui
 * demander de deviner le lien : le menu le dit, et le règle.
 *
 * ## Ce que le module fait
 *
 * Deux choses, et rien de plus.
 *
 *  - **Il fait respirer les deux boutons du mode** — celui de la carte et celui
 *    de la fenêtre vidéo — tant que le mode est actif et que le préchargement
 *    est à la traîne. La classe est posée ici, l'onde est dans la feuille de
 *    style.
 *
 *  - **Il ouvre le menu au clic qui allume le mode**, avec un bouton par liste
 *    encore à régler. Un bouton disparaît dès que sa liste est faite, et le menu
 *    se ferme quand il ne reste rien à proposer — ou au clic à côté, à la touche
 *    d'échappement, et au second clic sur le bouton du mode, qui éteint le mode
 *    lui-même.
 *
 * Le menu ne s'ouvre jamais tout seul : il naît d'un clic, et c'est pourquoi le
 * geste est intercepté à la capture — l'aperçu optimiste du tableau de bord
 * repeint les boutons avant que le clic n'ait fini de remonter, et on ne saurait
 * plus, après lui, si le mode vient d'être allumé ou éteint.
 */

window.MusicPlayer = window.MusicPlayer || {};

(function () {
    'use strict';

    /** Valeur du réglage pour « toutes les pistes » — voir js/settingsModal.js. */
    const ALL = -1;

    /** Les deux listes que le tirage parcourt, et leur clé de réglage. */
    const LISTES = [
        { nom: 'queue', reglage: 'queueCount', libelle: 'shuffle_menu_queue', defaut: 'La file d’attente' },
        { nom: 'playlist', reglage: 'playlistCount', libelle: 'shuffle_menu_playlists', defaut: 'Les playlists' },
    ];

    let menu = null;
    let ancre = null;
    /** Le clic en cours vient-il d'allumer le mode ? Posé à la capture. */
    let ouvrirAuProchainEtat = false;
    /** Le bouton touché : la page en a deux, le menu naît sous le bon. */
    let boutonTouche = null;

    function t(key, defaut) {
        const traduit = typeof window.MusicPlayer.t === 'function' ? window.MusicPlayer.t(key) : key;
        return traduit && traduit !== key ? traduit : defaut;
    }

    function boutons() {
        return document.querySelectorAll('.mode-switch-btn.mode-shuffle');
    }

    /** Les listes dont le préchargement n'est pas encore sans limite. */
    function listesATraiter() {
        const preloading = (window.MusicPlayer.dashboardSettings || {}).preloading || {};
        // Le préchargement éteint ne précharge rien, quelles que soient les
        // valeurs que ses curseurs ont gardées.
        if (preloading.enabled === false) return LISTES.slice();
        return LISTES.filter(l => Number(preloading[l.reglage]) !== ALL);
    }

    /**
     * Le mode est-il actif, et reste-t-il quelque chose à régler ?
     *
     * @param {{shuffle: boolean}} [apercu] L'état qu'un clic vient de peindre,
     *     avant que celui du serveur ne revienne.
     */
    function applique(apercu) {
        const actif = apercu ? Boolean(apercu.shuffle) : Boolean((window.MusicPlayer.state || {}).shuffle);
        return actif && listesATraiter().length > 0;
    }

    /* ───────────────────────────── Le menu ───────────────────────────── */

    function bati() {
        if (menu) return menu;

        menu = document.createElement('div');
        menu.id = 'shuffle-menu';
        menu.className = 'shuffle-menu';
        menu.hidden = true;
        menu.setAttribute('role', 'dialog');
        document.body.appendChild(menu);

        // Le clic à l'intérieur ne doit pas être pris pour un clic à côté.
        menu.addEventListener('click', (e) => e.stopPropagation());

        return menu;
    }

    /**
     * Recompose le contenu : le texte, et un bouton par liste restante.
     *
     * Refait seulement s'il a changé — `refresh` passe ici à chaque état
     * diffusé, et rebâtir le menu sous le pointeur ferait perdre le survol du
     * bouton qu'on s'apprêtait à cliquer.
     *
     * @returns {number} Le nombre de listes encore à régler.
     */
    function remplir() {
        const restantes = listesATraiter();
        const signature = restantes.map(l => l.nom).join(',') + '|' + ((window.MusicPlayer.dashboardSettings || {}).language || '');
        if (menu.dataset.signature === signature) return restantes.length;
        menu.dataset.signature = signature;

        menu.textContent = '';

        const titre = document.createElement('p');
        titre.className = 'shuffle-menu-title';
        titre.textContent = t('shuffle_menu_title', 'Lecture aléatoire activée');
        menu.appendChild(titre);

        const texte = document.createElement('p');
        texte.className = 'shuffle-menu-text';
        texte.textContent = t('shuffle_menu_text',
            'Le titre suivant est tiré au sort : seul un préchargement sans limite le fait '
            + 'démarrer sans attente. Réglez sur « infini » :');
        menu.appendChild(texte);

        for (const liste of restantes) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'shuffle-menu-btn';
            btn.dataset.liste = liste.nom;
            btn.textContent = t(liste.libelle, liste.defaut);
            btn.addEventListener('click', () => {
                if (typeof window.MusicPlayer.setPreloadAll === 'function') {
                    // `setPreloadAll` rappelle `refresh`, qui recompose le menu
                    // et le ferme s'il ne reste plus rien.
                    window.MusicPlayer.setPreloadAll(liste.nom);
                }
            });
            menu.appendChild(btn);
        }

        return restantes.length;
    }

    /** Place le menu sous son bouton, ou au-dessus s'il n'y a pas la place. */
    function placer() {
        if (!menu || !ancre) return;

        const rect = ancre.getBoundingClientRect();
        const marge = 8;
        const ecart = 10;

        menu.style.left = '0px';
        menu.style.top = '0px';
        const boite = menu.getBoundingClientRect();

        const dessous = rect.bottom + ecart + boite.height <= window.innerHeight - marge;
        const top = dessous ? rect.bottom + ecart : Math.max(marge, rect.top - ecart - boite.height);
        const centre = rect.left + rect.width / 2;
        const left = Math.min(window.innerWidth - marge - boite.width,
            Math.max(marge, centre - boite.width / 2));

        menu.style.left = `${Math.round(left)}px`;
        menu.style.top = `${Math.round(top)}px`;
        menu.dataset.cote = dessous ? 'dessous' : 'dessus';
        menu.style.setProperty('--shuffle-menu-fleche', `${Math.round(centre - left)}px`);
    }

    function ouvrir(bouton) {
        bati();
        ancre = bouton;
        menu.hidden = false;
        if (remplir() === 0) return fermer();
        placer();
        // Le cadre est posé avant la transition, sans quoi elle n'aurait rien à
        // jouer : un élément qui naît visible n'entre pas.
        requestAnimationFrame(() => menu.classList.add('is-open'));
    }

    function fermer() {
        if (!menu) return;
        menu.classList.remove('is-open');
        menu.hidden = true;
        menu.dataset.signature = '';
        ancre = null;
    }

    function estOuvert() {
        return Boolean(menu) && !menu.hidden;
    }

    /* ─────────────────────────── La mise à jour ─────────────────────────── */

    /**
     * Met les boutons à jour, et le menu avec eux.
     *
     * Appelée à chaque peinture de l'interface — c'est l'état qui porte le
     * mode —, après chaque modification des réglages, et au changement de
     * langue, qui recompose les libellés.
     *
     * @param {{shuffle: boolean}} [apercu] Voir `applique`.
     */
    function refresh(apercu) {
        const vaut = applique(apercu);

        for (const bouton of boutons()) {
            bouton.classList.toggle('needs-preload', vaut);
        }

        if (!vaut) {
            ouvrirAuProchainEtat = false;
            fermer();
            return;
        }

        if (ouvrirAuProchainEtat) {
            ouvrirAuProchainEtat = false;
            ouvrir(boutonTouche || document.querySelector('.mode-switch-btn.mode-shuffle'));
            return;
        }

        if (estOuvert()) {
            if (remplir() === 0) fermer();
            else placer();
        }
    }

    window.MusicPlayer.refreshShuffleHint = refresh;

    /* ────────────────────────────── Les gestes ────────────────────────────── */

    function init() {
        /*
         * À la capture, avant l'aperçu optimiste : c'est le seul moment où l'on
         * sait encore si le clic allume le mode ou l'éteint. Après lui, le
         * bouton porte déjà son nouvel état et la question n'a plus de réponse.
         */
        document.addEventListener('click', (e) => {
            const bouton = e.target.closest && e.target.closest('.mode-switch-btn.mode-shuffle');
            if (!bouton) return;

            if (bouton.classList.contains('active')) {
                // Le mode s'éteint : le menu n'a plus lieu d'être ouvert.
                ouvrirAuProchainEtat = false;
                fermer();
            } else {
                ouvrirAuProchainEtat = true;
                boutonTouche = bouton;
            }
        }, true);

        // Le clic à côté referme, celui du menu ayant été retenu à la source.
        document.addEventListener('click', (e) => {
            if (!estOuvert()) return;
            if (e.target.closest && e.target.closest('.mode-switch-btn.mode-shuffle')) return;
            fermer();
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && estOuvert()) fermer();
        });

        // Le menu est posé en coordonnées de fenêtre : il suit son bouton tant
        // que la page ne bouge pas, et se retire dès qu'elle bouge.
        window.addEventListener('scroll', () => { if (estOuvert()) fermer(); }, true);
        window.addEventListener('resize', () => { if (estOuvert()) placer(); });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
