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

    /* ═══════════════════════ Côté de l'encoche ═══════════════════════ */

    /*
     * `env(safe-area-inset-*)` dit **combien** rogner de chaque côté, jamais
     * **pourquoi**. Couché, un téléphone à encoche rapporte volontiers la même
     * réserve à gauche et à droite : d'un côté pour l'encoche, de l'autre pour
     * le coin arrondi. La seconde est bien plus large que nécessaire, et c'est
     * autant de page perdue.
     *
     * On déduit donc le côté de l'encoche pour rendre au côté opposé ce qu'il
     * n'utilise pas. Cette déduction n'est qu'une hypothèse — la feuille de
     * style ne s'en sert que pour **réduire** une marge, jamais pour en poser
     * une. Quand l'attribut manque, ou que l'appareil sort du cas courant, il
     * ne se passe rien : les valeurs du système s'appliquent telles quelles.
     *
     * Deux hypothèses la portent, et toutes deux peuvent tomber :
     *   - l'appareil est né en portrait — faux pour beaucoup de tablettes ;
     *   - son encoche est sur le bord haut de cette orientation — faux pour les
     *     perforations latérales et les pliables.
     * La première est vérifiable et l'est ci-dessous. La seconde ne l'est pas :
     * aucune interface web ne dit où le matériel est creusé.
     */

    /**
     * Côté de l'écran vers lequel bascule l'encoche à 90° et à 270°.
     *
     * La spécification de l'angle d'orientation ne permet pas d'en déduire le
     * sens avec certitude, et les moteurs ne s'accordent pas tous. Ces deux
     * constantes sont donc à vérifier sur un appareil réel : si le dégagement
     * se réduit du mauvais côté — du texte qui passe sous l'encoche —, il
     * suffit de les échanger.
     */
    const NOTCH_AT_90 = 'left';
    const NOTCH_AT_270 = 'right';

    /**
     * Où se trouve l'encoche, si on peut l'établir.
     * @returns {'top'|'bottom'|'left'|'right'|null} null si indéterminable.
     */
    function probableNotch() {
        const o = window.screen && window.screen.orientation;
        // Absent avant iOS 16.4, entre autres. `window.orientation`, déprécié,
        // porte une convention de signe différente : mieux vaut ne rien dire
        // que de dire le contraire.
        if (!o || typeof o.angle !== 'number' || typeof o.type !== 'string') return null;

        const angle = ((o.angle % 360) + 360) % 360;
        if (angle % 90 !== 0) return null;

        // L'orientation naturelle est celle qu'on retrouve à 0°. Née en
        // paysage, l'hypothèse de l'encoche en haut du portrait ne tient plus.
        const isPortrait = o.type.indexOf('portrait') === 0;
        const upright = angle === 0 || angle === 180;
        if (!(upright ? isPortrait : !isPortrait)) return null;

        if (angle === 0) return 'top';
        if (angle === 180) return 'bottom';
        return angle === 90 ? NOTCH_AT_90 : NOTCH_AT_270;
    }

    /** Reporte le côté déduit sur `<html>`, ou retire l'attribut. */
    function setNotch() {
        const root = document.documentElement;
        const side = probableNotch();
        if (side) root.setAttribute('data-notch', side);
        else root.removeAttribute('data-notch');
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
                    console.error('[deviceMode] Subscriber threw:', e);
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
    setNotch();

    // Une rotation ou un redimensionnement peut faire basculer d'un mode à
    // l'autre — mais en `auto` seulement, un choix explicite ne devant jamais
    // bouger. Le côté de l'encoche, lui, suit la rotation dans tous les cas :
    // il ne décrit pas une préférence mais la position de l'appareil.
    let resizeTimer = null;
    const reevaluate = () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            setNotch();
            if (choice === 'auto') apply();
        }, 150);
    };
    window.addEventListener('resize', reevaluate);
    window.addEventListener('orientationchange', reevaluate);
    // Plus fiable que `orientationchange`, déprécié : il émet après que l'angle
    // a réellement changé, là où l'autre peut devancer la bascule.
    if (window.screen && window.screen.orientation
        && typeof window.screen.orientation.addEventListener === 'function') {
        window.screen.orientation.addEventListener('change', reevaluate);
    }

    window.MusicPlayer.deviceMode = deviceMode;
})();
