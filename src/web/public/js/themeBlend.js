/**
 * themeBlend — Le réglage fin entre la nuit et le jour.
 *
 * ## Le problème
 *
 * Le tableau de bord n'avait que deux états : nuit ou jour. Or l'un est souvent
 * trop noir et l'autre trop blanc pour la pièce où l'on est, et le bon réglage
 * se trouve entre les deux — plus près d'un pôle que de l'autre selon l'heure.
 *
 * ## L'approche
 *
 * Un appui long sur le bouton jour/nuit ouvre un curseur : 0 % la nuit, 100 %
 * le jour. Sa valeur ne pilote rien directement — elle pose deux propriétés
 * personnalisées sur la racine, et c'est la feuille de style qui interpole tous
 * ses jetons à partir de là (voir l'en-tête de css/base.css). Le tableau de
 * bord suit donc en entier, y compris ce qui sera écrit demain, du moment que
 * cela s'exprime en jetons.
 *
 * L'appui court garde son ancien rôle : basculer d'un pôle à l'autre. Il efface
 * alors le réglage fin — on a demandé un pôle, on l'obtient franc.
 *
 * ## Ce qui reste discret
 *
 * `data-theme` ne disparaît pas : il suit le pôle le plus proche. Une poignée
 * de choses ne savent pas s'interpoler et ont besoin d'une réponse par oui ou
 * par non — les ombres portées, dont la structure change d'un thème à l'autre,
 * les étoiles filantes du survol, les particules du lecteur. Elles basculent au
 * milieu du curseur, ce qui est le seul endroit où le basculement ne se
 * remarque pas.
 */

window.MusicPlayer = window.MusicPlayer || {};

(function () {
    'use strict';

    /** Clé de persistance. Absente = aucun réglage fin, on suit les pôles. */
    const STORE_KEY = 'appThemeBlend';

    /** Millisecondes d'appui avant que le curseur ne s'ouvre. */
    const HOLD_MS = 450;

    /**
     * Déplacement du doigt qui annule l'appui long, en pixels.
     *
     * Un pointeur ne tient jamais parfaitement immobile, et sur écran tactile
     * un début de défilement passerait sinon pour un appui maintenu.
     */
    const HOLD_SLOP = 8;

    /** Au-delà, on est du côté du jour. Voir l'en-tête. */
    const POLE = 50;

    function el(id) {
        return document.getElementById(id);
    }

    function t(key, fallback) {
        const translated = typeof window.MusicPlayer.t === 'function' ? window.MusicPlayer.t(key) : key;
        return translated && translated !== key ? translated : fallback;
    }

    const button = el('btn-theme-toggle');
    const pop = el('theme-blend-pop');
    const range = el('theme-blend-range');
    const readout = el('theme-blend-readout');

    if (!button || !pop || !range) return;

    let holdTimer = null;
    let holdOrigin = null;
    /** Vrai entre l'ouverture par appui long et le clic qu'il faut avaler. */
    let opened = false;

    /* ═════════════════════ Le réglage lui-même ═════════════════════ */

    /** Le réglage enregistré, ou null si l'on suit les pôles. */
    function stored() {
        try {
            const raw = localStorage.getItem(STORE_KEY);
            if (raw === null) return null;
            const value = Number(raw);
            return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : null;
        } catch (e) {
            // Stockage refusé : le réglage ne survivra pas au rechargement, ce
            // qui est un moindre mal comparé à un tableau de bord qui refuse
            // de s'afficher.
            return null;
        }
    }

    /** Position du curseur pour l'état courant, réglage fin ou pôle. */
    function current() {
        const fine = stored();
        if (fine !== null) return fine;
        return document.documentElement.getAttribute('data-theme') === 'light' ? 100 : 0;
    }

    /**
     * Pose le mélange sur la racine.
     *
     * En style en ligne, donc au-dessus de la feuille de style : c'est ce qui
     * permet à `html[data-theme]` de garder ses valeurs de pôle pour le cas
     * ordinaire, et au réglage fin de passer devant quand il existe.
     *
     * @param {number|null} value 0 à 100, ou null pour rendre la main aux pôles.
     */
    function apply(value) {
        const root = document.documentElement;

        if (value === null) {
            root.style.removeProperty('--blend-pct');
            root.style.removeProperty('--blend');
        } else {
            root.style.setProperty('--blend-pct', `${value}%`);
            root.style.setProperty('--blend', String(value / 100));

            /*
             * Le pôle le plus proche, pour ce qui ne sait pas s'interpoler.
             *
             * Écrit sans passer par `appTheme` : l'utilisateur n'a pas changé de
             * thème, il a déplacé un curseur. Ce que le prochain démarrage
             * rouvrira est le réglage fin, et `data-theme` s'en déduira.
             */
            root.setAttribute('data-theme', value >= POLE ? 'light' : 'dark');
        }

        if (typeof window.MusicPlayer.applyThemeAppearance === 'function') {
            window.MusicPlayer.applyThemeAppearance(root.getAttribute('data-theme'));
        }
    }

    function save(value) {
        try {
            if (value === null) localStorage.removeItem(STORE_KEY);
            else localStorage.setItem(STORE_KEY, String(value));
        } catch (e) {
            // Voir `stored()` : le réglage vaut alors pour cette session.
        }
    }

    function paintReadout(value) {
        if (!readout) return;
        readout.textContent = t('theme_blend_mix', '{n} % de jour').replace('{n}', String(value));
    }

    /**
     * Efface le réglage fin.
     *
     * Appelé par la bascule ordinaire : demander un pôle doit le donner franc,
     * sans quoi un clic sur le bouton ferait passer de « 30 % de jour » à
     * « 30 % de nuit », ce que personne n'a demandé.
     */
    window.MusicPlayer.clearThemeBlend = function () {
        save(null);
        apply(null);
        range.value = String(current());
        paintReadout(Number(range.value));
    };

    /* ═════════════════════ Ouvrir et fermer ═════════════════════ */

    function open() {
        if (!pop.hidden) return;

        const value = current();
        range.value = String(value);
        paintReadout(value);

        pop.classList.remove('is-closing');
        pop.hidden = false;
        opened = true;

        // Le focus part sur le curseur : ouvert au clavier, il doit pouvoir s'y
        // régler sans avoir à le retrouver à la tabulation.
        try { range.focus({ preventScroll: true }); } catch (e) { range.focus(); }
    }

    function close() {
        if (pop.hidden || pop.classList.contains('is-closing')) return;

        pop.classList.add('is-closing');
        const done = () => {
            pop.removeEventListener('animationend', done);
            pop.classList.remove('is-closing');
            pop.hidden = true;
            /*
             * Le clic à avaler ne survit pas à la fermeture.
             *
             * Ouvrir puis cliquer ailleurs laissait ce drapeau levé : le clic
             * suivant sur le bouton était avalé à son tour, et la bascule
             * ordinaire paraissait ne rien faire une fois sur deux.
             */
            opened = false;
        };
        pop.addEventListener('animationend', done);
        // Filet : un moteur qui n'animerait rien ne déclencherait jamais
        // `animationend`, et le panneau resterait ouvert pour toujours.
        setTimeout(done, 400);
    }

    /* ═════════════════════ L'appui long ═════════════════════ */

    function cancelHold() {
        if (holdTimer) clearTimeout(holdTimer);
        holdTimer = null;
        holdOrigin = null;
    }

    button.addEventListener('pointerdown', (e) => {
        // Le bouton droit et le milieu n'ouvrent rien : ils ont leurs propres
        // usages, et le menu contextuel du navigateur passerait par-dessus.
        if (e.button !== undefined && e.button !== 0) return;

        holdOrigin = { x: e.clientX, y: e.clientY };
        holdTimer = setTimeout(() => {
            holdTimer = null;
            open();
        }, HOLD_MS);
    });

    button.addEventListener('pointermove', (e) => {
        if (!holdOrigin) return;
        if (Math.hypot(e.clientX - holdOrigin.x, e.clientY - holdOrigin.y) > HOLD_SLOP) cancelHold();
    });

    for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
        button.addEventListener(type, cancelHold);
    }

    /*
     * Le clic qui suit un appui long est avalé.
     *
     * En capture, donc avant l'écouteur de bascule d'app.js : sans cela, ouvrir
     * le réglage fin changerait de thème du même geste, et l'on verrait le
     * tableau de bord basculer au moment précis où l'on vient demander à ne
     * plus basculer.
     */
    button.addEventListener('click', (e) => {
        // Le clic qui clôt le geste d'ouverture : avalé, et rien d'autre.
        if (opened) {
            opened = false;
            e.preventDefault();
            e.stopPropagation();
            return;
        }

        // Panneau déjà ouvert : le bouton le referme. Sans cela il n'y avait
        // aucun moyen de s'en défaire depuis le bouton lui-même — le clic était
        // pris pour une bascule, et l'on changeait de thème en croyant ranger
        // le curseur.
        if (!pop.hidden) {
            close();
            e.preventDefault();
            e.stopPropagation();
            return;
        }

        // Bascule ordinaire : le réglage fin n'a plus lieu d'être. Différé
        // d'un tour, le temps qu'app.js ait posé le nouveau `data-theme` —
        // c'est de lui que se déduit la position du curseur.
        setTimeout(() => window.MusicPlayer.clearThemeBlend(), 0);
    }, true);

    /* ═════════════════════ Le curseur ═════════════════════ */

    range.addEventListener('input', () => {
        const value = Number(range.value);
        apply(value);
        save(value);
        paintReadout(value);
    });

    // Fermer en cliquant ailleurs, sans compter le geste qui vient d'ouvrir.
    document.addEventListener('pointerdown', (e) => {
        if (pop.hidden) return;
        if (pop.contains(e.target) || button.contains(e.target)) return;
        close();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !pop.hidden) {
            close();
            try { button.focus(); } catch (err) {}
        }
    });

    /* ═════════════════════ Au chargement ═════════════════════ */

    /**
     * L'infobulle dit que le réglage existe.
     *
     * Un appui long ne se devine pas : sans cette phrase, la fonctionnalité
     * n'existerait que pour qui l'a codée. Ajoutée au libellé traduit plutôt
     * qu'écrite en dur, et reposée après chaque changement de langue.
     */
    function paintHint() {
        const base = t('tooltip_theme_toggle', 'Changer de mode Jour/Nuit');
        const hint = t('tooltip_theme_blend_hint', 'Appui long pour un réglage plus précis');
        button.dataset.tooltip = `${base}\n${hint}`;
    }

    window.MusicPlayer.repaintThemeBlendHint = paintHint;

    const fine = stored();
    if (fine !== null) apply(fine);
    range.value = String(current());
    paintReadout(Number(range.value));
    paintHint();
})();
