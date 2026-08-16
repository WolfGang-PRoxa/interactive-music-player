/**
 * scrollLock — Fige la page tant qu'une fenêtre la recouvre.
 *
 * ## Pourquoi
 *
 * Les paramètres, la doc technique, les confirmations et le tiroir des journaux
 * posent tous un voile sur le tableau de bord. Ce voile arrête les clics, mais
 * pas le défilement : la molette ou le doigt le traversaient et emportaient la
 * page en dessous. On refermait alors la fenêtre sur un tableau de bord qui
 * n'était plus là où on l'avait laissé, et sur mobile, où la fenêtre occupe tout
 * l'écran, le déplacement se faisait même à l'aveugle.
 *
 * ## Comment
 *
 * En observant les voiles plutôt qu'en s'insérant dans les fonctions qui les
 * ouvrent. Elles sont une dizaine, dispersées dans autant de fichiers, et
 * chacune referme sa fenêtre à sa manière — un oubli y serait invisible jusqu'à
 * ce qu'un utilisateur le signale. L'état visible du DOM, lui, est la seule
 * source qui ne puisse pas mentir.
 *
 * Deux conventions coexistent pour dire « ouvert », et le module s'accommode des
 * deux : l'absence de `.hidden` pour les fenêtres modales, la présence de
 * `.active` pour le voile du tiroir, qui reste affiché en permanence et ne joue
 * que sur son opacité.
 */
(function () {
    window.MusicPlayer = window.MusicPlayer || {};

    /**
     * Les voiles connus, et ce qui signale qu'ils sont ouverts.
     *
     * Le premier sélecteur sert à trouver les éléments à surveiller, le second
     * à décider s'ils recouvrent la page à cet instant.
     */
    const VOILES = [
        ['.maintenance-overlay', '.maintenance-overlay:not(.hidden)'],
        ['.restart-overlay', '.restart-overlay:not(.hidden)'],
        ['.docs-overlay', '.docs-overlay:not(.hidden)'],
        ['.drawer-backdrop', '.drawer-backdrop.active'],
    ];

    const SELECTEUR_TOUS = VOILES.map((v) => v[0]).join(', ');
    const SELECTEUR_OUVERTS = VOILES.map((v) => v[1]).join(', ');

    /** Position de défilement au moment du verrouillage, à rendre après coup. */
    let positionGelee = 0;
    let verrouille = false;

    /**
     * Un voile recouvre-t-il la page en ce moment ?
     *
     * Le test de style vient en plus des sélecteurs : rien n'interdit à un bout
     * de code de masquer un voile par un style en ligne plutôt que par sa
     * classe, et un voile qu'on croirait ouvert figerait la page pour de bon.
     *
     * @returns {boolean}
     */
    function unVoileEstOuvert() {
        const candidats = document.querySelectorAll(SELECTEUR_OUVERTS);
        for (const el of candidats) {
            if (window.getComputedStyle(el).display !== 'none') return true;
        }
        return false;
    }

    /** Sort la page du flux, à la position où elle se trouve. */
    function verrouiller() {
        if (verrouille) return;
        positionGelee = window.scrollY || document.documentElement.scrollTop || 0;
        document.body.style.top = `-${positionGelee}px`;
        document.body.classList.add('scroll-locked');
        verrouille = true;
    }

    /** Remet la page dans le flux, là où elle était. */
    function deverrouiller() {
        if (!verrouille) return;
        document.body.classList.remove('scroll-locked');
        document.body.style.top = '';
        verrouille = false;
        // Après le retour dans le flux, sans quoi la page n'a pas encore la
        // hauteur qui rend cette position atteignable.
        window.scrollTo(0, positionGelee);
    }

    /**
     * Aligne l'état de la page sur celui des voiles.
     *
     * Verrouiller est volontairement idempotent : deux fenêtres empilées — la
     * doc ouverte depuis les paramètres, une confirmation par-dessus — ne
     * doivent pas écraser la position mémorisée par la première.
     */
    function reevaluer() {
        if (unVoileEstOuvert()) verrouiller();
        else deverrouiller();
    }

    function init() {
        const observateur = new MutationObserver(reevaluer);

        /** Surveille un voile, une seule fois. */
        const surveiller = (el) => {
            if (el.dataset.scrollLockObserve === 'true') return;
            el.dataset.scrollLockObserve = 'true';
            observateur.observe(el, { attributes: true, attributeFilter: ['class', 'style'] });
        };

        document.querySelectorAll(SELECTEUR_TOUS).forEach(surveiller);

        /*
         * Tous les voiles sont aujourd'hui écrits dans index.html, mais rien ne
         * garantit qu'un prochain ne sera pas créé à la volée. Surveiller les
         * arrivées dans le corps du document coûte peu — la liste est courte et
         * n'est reparcourue qu'à l'ajout d'un élément — et évite que ce module
         * ne devienne silencieusement incomplet.
         */
        new MutationObserver(() => {
            document.querySelectorAll(SELECTEUR_TOUS).forEach(surveiller);
            reevaluer();
        }).observe(document.body, { childList: true });

        reevaluer();
    }

    window.MusicPlayer.scrollLock = {
        /** Recalcule l'état, pour un voile que l'observation n'aurait pas vu. */
        refresh: reevaluer,
        estVerrouille() { return verrouille; },
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
