/**
 * shuffleHint — L'invitation à tout précharger, sur le bouton du mode aléatoire.
 *
 * ## Pourquoi elle existe
 *
 * En lecture aléatoire, le titre suivant est tiré au moment de l'enchaînement :
 * rien ne peut donc être préparé d'avance à partir de l'ordre de la liste, ni le
 * fondu du navigateur (voir `nextTrackOf` dans js/state.js) ni le morceau que le
 * bot garde au chaud. Le préchargement, lui, s'y prête — réglé sur « toutes les
 * pistes », il met la file et les playlists entières en cache, et le tirage
 * tombe alors toujours sur un morceau déjà prêt.
 *
 * Ce réglage vit dans la fenêtre des paramètres, à trois clics d'ici. Envoyer
 * l'utilisateur l'y chercher pour un mode qu'il vient d'activer serait lui
 * demander de deviner le lien : le bouton le dit lui-même, et le règle.
 *
 * ## Ce que le module fait
 *
 * Il ne dessine rien. Il pose sur les deux boutons du mode aléatoire — celui de
 * la carte et celui de la fenêtre vidéo — de quoi les faire parler :
 *
 * - une classe `needs-preload`, que la feuille de style fait respirer ;
 * - `data-tooltip-hint`, la seconde ligne qui explique le pourquoi ;
 * - `data-tooltip-action`, le bouton que l'infobulle porte alors (voir
 *   `actionOf` dans js/tooltipSystem.js).
 *
 * Et il les retire dès que le préchargement couvre tout, ou que le mode est
 * quitté : il n'y a plus rien à proposer, l'infobulle ordinaire revient.
 */

window.MusicPlayer = window.MusicPlayer || {};

(function () {
    'use strict';

    /** Valeur du réglage pour « toutes les pistes » — voir js/settingsModal.js. */
    const ALL = -1;

    function buttons() {
        return document.querySelectorAll('.mode-switch-btn.mode-shuffle');
    }

    /** Le préchargement couvre-t-il déjà la file et les playlists en entier ? */
    function preloadsEverything() {
        const preloading = (window.MusicPlayer.dashboardSettings || {}).preloading || {};
        if (preloading.enabled === false) return false;
        return Number(preloading.queueCount) === ALL && Number(preloading.playlistCount) === ALL;
    }

    /**
     * L'invitation a-t-elle lieu d'être ?
     *
     * Deux conditions : le mode est actif — l'expliquer avant n'apprendrait
     * rien —, et le préchargement est à la traîne.
     */
    function applies() {
        const state = window.MusicPlayer.state || {};
        return Boolean(state.shuffle) && !preloadsEverything();
    }

    /**
     * Règle le préchargement sur « toutes les pistes », depuis l'infobulle.
     *
     * Le travail est fait par la fenêtre des paramètres, qui tient les curseurs
     * et l'enregistrement ; ici on ne fait qu'annoncer le résultat, parce que le
     * bouton disparaît dans la foulée et qu'un geste sans réponse laisse dans le
     * doute de l'avoir accompli.
     */
    window.MusicPlayer.preloadAllForShuffle = function () {
        if (typeof window.MusicPlayer.setPreloadAll !== 'function') return;

        window.MusicPlayer.setPreloadAll();

        if (typeof window.MusicPlayer.showToast === 'function') {
            const t = window.MusicPlayer.t;
            const said = typeof t === 'function' ? t('shuffle_preload_done') : '';
            window.MusicPlayer.showToast(said && said !== 'shuffle_preload_done'
                ? said
                : 'Préchargement réglé sur toutes les pistes.');
        }

        refresh();
    };

    /**
     * Met les boutons à jour.
     *
     * Appelée à chaque peinture de l'interface — c'est l'état qui porte le
     * mode —, à chaque modification des réglages, et au changement de langue,
     * qui recompose l'infobulle.
     */
    function refresh() {
        const wanted = applies();

        for (const button of buttons()) {
            button.classList.toggle('needs-preload', wanted);

            if (wanted) {
                button.setAttribute('data-tooltip-hint', 'shuffle_preload_hint');
                button.setAttribute('data-tooltip-action', 'shuffle_preload_action');
                button.setAttribute('data-tooltip-action-call', 'preloadAllForShuffle');
            } else {
                button.removeAttribute('data-tooltip-hint');
                button.removeAttribute('data-tooltip-action');
                button.removeAttribute('data-tooltip-action-call');
            }

            // Une infobulle déjà ouverte sur ce bouton garderait son ancien
            // contenu : elle est composée à l'ouverture. Le cas se produit à
            // chaque clic sur le bouton d'action, qui est sous le pointeur.
            if (window.TooltipSystem && typeof window.TooltipSystem.refresh === 'function') {
                try { window.TooltipSystem.refresh(button); } catch (e) {}
            }
        }
    }

    window.MusicPlayer.refreshShuffleHint = refresh;
})();
