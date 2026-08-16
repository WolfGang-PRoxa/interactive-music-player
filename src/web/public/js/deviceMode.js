/**
 * deviceMode — Mode de support du tableau de bord : ordinateur, tablette ou
 * téléphone.
 *
 * ## Pourquoi
 *
 * L'interface a été conçue à la souris. Son glisser-déposer repose sur l'API
 * HTML5 `dataTransfer`, qu'aucun navigateur mobile n'émet au doigt : réordonner
 * la file ou déplacer un titre y était non pas malcommode, mais impossible.
 *
 * Le mode retenu conditionne deux choses : la mise en page, via l'attribut
 * `data-device-mode` posé sur `<html>` et exploité par les feuilles de style,
 * et l'activation de l'adaptateur tactile — voir `touchDragDrop.js`.
 *
 * ## Le choix appartient à l'appareil
 *
 * Il est rangé dans `localStorage`, comme le thème et la disposition des
 * cartes, et non dans les réglages du bot : un mode d'affichage dépend de
 * l'écran qu'on a sous les yeux. Choisir « téléphone » sur le mobile ne doit
 * pas imposer ce mode au PC, qui parle pourtant au même bot.
 *
 * `auto` reste le défaut et se réévalue à chaque changement de taille ou
 * d'orientation ; un choix explicite, lui, ne bouge plus.
 */
(function () {
    window.MusicPlayer = window.MusicPlayer || {};

    const STORAGE_KEY = 'music_player_device_mode';

    /** Choix possibles dans les paramètres. `auto` laisse la détection décider. */
    const CHOICES = ['auto', 'desktop', 'tablet', 'phone'];

    /** Modes effectifs : ce que `auto` peut valoir une fois résolu. */
    const MODES = ['desktop', 'tablet', 'phone'];

    /**
     * Côté court en deçà duquel un appareil est traité en téléphone.
     *
     * Le côté court, et non la largeur. Couché, un téléphone est plus large
     * qu'une petite tablette debout : au seul critère de largeur, il passait en
     * mode tablette, qui n'adapte pas l'en-tête et laisse les commandes à leur
     * largeur de bureau. Or c'est le même appareil, avec la même place et les
     * mêmes doigts, quel que soit le sens dans lequel on le tient.
     *
     * 600 px sépare nettement les deux familles : le côté court d'un téléphone
     * dépasse rarement 450 px, celui de la plus petite tablette part de 740.
     */
    const PHONE_MAX_SHORT_SIDE = 600;

    const listeners = new Set();
    let choice = 'auto';
    let effective = 'desktop';

    /**
     * Le pointeur principal est-il grossier — un doigt plutôt qu'une souris ?
     *
     * `pointer` interroge le dispositif principal, là où `any-pointer` répondrait
     * vrai sur un portable à écran tactile piloté au pavé, qui n'a rien à faire
     * en mode tactile.
     *
     * @returns {boolean}
     */
    function hasCoarsePointer() {
        if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) return true;
        // Repli pour les navigateurs sans `pointer` : la présence de points de
        // contact ne prouve rien à elle seule, mais c'est tout ce qui reste.
        return !window.matchMedia && navigator.maxTouchPoints > 0;
    }

    /**
     * Plus petite dimension de la fenêtre, en pixels CSS.
     *
     * `screen` sert de repli quand `innerWidth`/`innerHeight` ne sont pas encore
     * renseignés, ce qui arrive au tout premier rendu sur certains navigateurs.
     *
     * @returns {number} 0 si rien n'est mesurable
     */
    function viewportShortSide() {
        const width = window.innerWidth || (screen && screen.width) || 0;
        const height = window.innerHeight || (screen && screen.height) || 0;
        if (!width || !height) return width || height;
        return Math.min(width, height);
    }

    /**
     * Mode déduit de l'appareil, quand le choix est `auto`.
     * @returns {'desktop'|'tablet'|'phone'}
     */
    function detect() {
        const shortSide = viewportShortSide();
        if (hasCoarsePointer()) {
            return shortSide < PHONE_MAX_SHORT_SIDE ? 'phone' : 'tablet';
        }

        /*
         * Pointeur annoncé fin, alors que l'écran a des points de contact et que
         * la fenêtre est trop basse pour un ordinateur.
         *
         * Des navigateurs mobiles se déclarent ainsi — c'est le cas du mode
         * « site pour ordinateur », mais pas seulement : certains ne répondent
         * simplement pas à `pointer`. La page se croit alors sur un écran de
         * bureau large de 1200 px et déploie la grille 48 colonnes sur un écran
         * de six pouces.
         *
         * La condition de hauteur est ce qui rend ce rattrapage sûr. Un portable
         * à écran tactile a lui aussi des points de contact, et le commentaire
         * de `hasCoarsePointer` rappelle qu'il n'a rien à faire en mode tactile :
         * sa fenêtre ne descend jamais sous 600 px de haut, il reste donc en
         * mode ordinateur. Seul un appareil tenu couché franchit les deux
         * conditions à la fois.
         */
        if (navigator.maxTouchPoints > 0 && shortSide && shortSide < PHONE_MAX_SHORT_SIDE) {
            return 'phone';
        }

        return 'desktop';
    }

    /** Choix mémorisé, `auto` si rien de valable n'est enregistré. */
    function readStoredChoice() {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            return CHOICES.includes(stored) ? stored : 'auto';
        } catch (e) {
            // Navigation privée, stockage refusé : on repart sur la détection
            return 'auto';
        }
    }

    /**
     * Pose le mode effectif sur `<html>` et prévient les abonnés s'il a changé.
     * @param {boolean} [notify=true]
     */
    function apply(notify = true) {
        const previous = effective;
        effective = choice === 'auto' ? detect() : choice;
        if (!MODES.includes(effective)) effective = 'desktop';

        const root = document.documentElement;
        root.setAttribute('data-device-mode', effective);
        root.setAttribute('data-device-choice', choice);
        // Les deux modes tactiles partagent la même logique d'interaction ; les
        // styles n'ont pas à répéter le test à chaque règle.
        root.setAttribute('data-touch-mode', effective === 'desktop' ? 'false' : 'true');

        if (notify && previous !== effective) {
            listeners.forEach((fn) => {
                try { fn(effective, previous); } catch (e) {
                    console.error('[deviceMode] Abonné en erreur :', e);
                }
            });
        }
    }

    const deviceMode = {
        /** Mode effectivement appliqué : desktop, tablet ou phone. */
        get() { return effective; },

        /** Choix de l'utilisateur, `auto` compris. */
        getChoice() { return choice; },

        /** Le mode courant demande-t-il les interactions tactiles ? */
        isTouch() { return effective !== 'desktop'; },

        /** Ce que la détection donnerait, indépendamment du choix en vigueur. */
        detected() { return detect(); },

        /**
         * Change le mode et le mémorise.
         * @param {'auto'|'desktop'|'tablet'|'phone'} next
         * @returns {boolean} false si la valeur n'est pas reconnue
         */
        set(next) {
            if (!CHOICES.includes(next)) return false;
            choice = next;
            try {
                localStorage.setItem(STORAGE_KEY, next);
            } catch (e) {
                // Le mode reste appliqué pour la session, simplement pas retenu
            }
            apply();
            return true;
        },

        /**
         * S'abonne aux changements de mode effectif.
         * @param {(mode: string, previous: string) => void} fn
         * @returns {() => void} Désabonnement
         */
        onChange(fn) {
            if (typeof fn !== 'function') return () => {};
            listeners.add(fn);
            return () => listeners.delete(fn);
        },

        CHOICES,
        STORAGE_KEY,
    };

    choice = readStoredChoice();
    apply(false);

    // En `auto` seulement : une rotation ou un redimensionnement peut faire
    // basculer d'un mode à l'autre. Un choix explicite ne doit jamais bouger.
    let resizeTimer = null;
    const reevaluate = () => {
        if (choice !== 'auto') return;
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => apply(), 150);
    };
    window.addEventListener('resize', reevaluate);
    window.addEventListener('orientationchange', reevaluate);

    window.MusicPlayer.deviceMode = deviceMode;
})();
