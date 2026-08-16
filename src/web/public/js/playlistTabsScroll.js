/**
 * playlistTabsScroll — Défilement horizontal de la bande d'onglets de
 * playlists, et repères de bord.
 *
 * ## Pourquoi
 *
 * La bande tient sur une seule ligne et déborde ; c'est ici qu'elle se déplace.
 *
 * Le navigateur ne s'en charge pas, et c'est délibéré : une boîte réellement
 * défilable est peinte sur mobile dans un calque séparé, borné à la hauteur de
 * fenêtre d'avant la rétractation de la barre d'adresse, et cesse d'être peinte
 * au-delà — la bande d'onglets disparaissait purement et simplement en bas de
 * page. `.playlists-tabs` est donc en `overflow: hidden`, ce qui laisse
 * `scrollLeft` inscriptible tout en rendant la boîte inerte aux yeux du
 * navigateur. Voir le commentaire de cette règle dans css/queue.css, et la
 * section « Plus de défilement dans le défilement » de css/device.css.
 *
 * Ce module lui rend donc les trois choses que ce renoncement lui a coûtées.
 *
 * Le glissement au doigt, avec l'élan qui va avec : sans lui, une bande inerte
 * le serait pour de bon.
 *
 * La molette ensuite. Elle manquait de toute façon : une souris n'émet que du
 * défilement vertical, qu'aucun navigateur ne redirige vers un débordement
 * horizontal, et les onglets hors cadre étaient inatteignables sur ordinateur.
 *
 * La position enfin. Rien ne distingue une bande qui tient tout entière d'une
 * bande dont la moitié est hors cadre — l'onglet coupé au bord ressemble à un
 * onglet mal dimensionné. Ce module estompe donc le bord du côté où il reste
 * quelque chose, et seulement de ce côté-là.
 *
 * ## Ce qui n'est pas fait ici
 *
 * Aucune position n'est mémorisée, et aucun onglet n'est ramené dans le cadre à
 * la sélection. Les onglets sont reconstruits à chaque mise à jour d'état, et
 * le navigateur conserve de lui-même `scrollLeft` tant que le conteneur reste
 * le même élément — ce qui est le cas ici, seuls ses enfants changent.
 */
(function () {
    window.MusicPlayer = window.MusicPlayer || {};

    /**
     * Tolérance, en pixels, sur la comparaison des positions de défilement.
     *
     * `scrollLeft` est fractionnaire dès que l'affichage n'est pas à 100 % —
     * facteur système, zoom du navigateur — et n'atteint alors jamais exactement
     * sa borne. Sans cette marge, le repère de droite resterait allumé en bout
     * de course sur la moitié des configurations.
     */
    const TOLERANCE_PX = 2;

    /**
     * Déplacement, en pixels, au-delà duquel un contact devient un glissement.
     *
     * Aligné sur la tolérance de js/touchDragDrop.js, qui abandonne son appui
     * long au même seuil : en deçà le doigt cherche encore, au-delà les deux
     * gestes sont départagés sans jamais se disputer le contact.
     */
    const SEUIL_GLISSEMENT_PX = 10;

    /** Part de vitesse conservée à chaque image pendant l'élan. */
    const FROTTEMENT = 0.94;

    /** En deçà, l'élan ne se voit plus et n'a plus qu'à s'arrêter. */
    const VITESSE_MORTE = 0.4;

    /**
     * Écrit une position en la ramenant dans les bornes.
     * @param {HTMLElement} bande
     * @param {number} cible
     */
    function placer(bande, cible) {
        const debordement = bande.scrollWidth - bande.clientWidth;
        bande.scrollLeft = Math.max(0, Math.min(debordement, cible));
    }

    /**
     * Allume ou éteint les repères selon ce qui dépasse de part et d'autre.
     * @param {HTMLElement} bande
     */
    function majReperes(bande) {
        const debordement = bande.scrollWidth - bande.clientWidth;
        bande.classList.toggle('can-scroll-left', bande.scrollLeft > TOLERANCE_PX);
        bande.classList.toggle(
            'can-scroll-right',
            bande.scrollLeft < debordement - TOLERANCE_PX
        );
    }

    /**
     * Convertit la molette en défilement horizontal.
     *
     * La bande ne capte l'événement que si elle peut réellement avancer dans le
     * sens demandé. Arrivée en bout de course, elle le laisse repartir vers la
     * page : sans cela, la roue bloquerait sur la bande et le tableau de bord
     * refuserait de défiler dès que le pointeur passe dessus.
     *
     * @param {HTMLElement} bande
     * @param {WheelEvent} e
     */
    function surMolette(bande, e) {
        const debordement = bande.scrollWidth - bande.clientWidth;
        if (debordement <= TOLERANCE_PX) return;

        // Les pavés tactiles et les souris à roue inclinable émettent aussi du
        // déplacement horizontal ; on prend le plus franc des deux axes.
        const pas = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        if (!pas) return;

        const enButee = pas < 0
            ? bande.scrollLeft <= TOLERANCE_PX
            : bande.scrollLeft >= debordement - TOLERANCE_PX;
        if (enButee) return;

        e.preventDefault();
        placer(bande, bande.scrollLeft + pas);
    }

    /**
     * Glissement au doigt, avec élan à la relâche.
     *
     * Il remplace le défilement natif, auquel la bande a renoncé pour ne plus
     * être peinte dans un calque à part — voir le commentaire de
     * `.playlists-tabs` dans css/queue.css. `scrollLeft` reste inscriptible sur
     * une boîte en `overflow: hidden` ; c'est seulement le geste que le
     * navigateur ne relaie plus, et qu'on lui reprend ici.
     *
     * La souris en est exclue : elle a la molette, et son glisser sert déjà à
     * réordonner les onglets.
     *
     * @param {HTMLElement} bande
     */
    function brancherGlissement(bande) {
        let contact = null;
        let departX = 0;
        let departScroll = 0;
        let dernierX = 0;
        let dernierInstant = 0;
        let vitesse = 0;
        let glisse = false;
        let animation = null;
        /*
         * Un glissement se termine par un `click` sur l'onglet resté sous le
         * doigt, que rien ne distingue d'une sélection délibérée : sans ce
         * témoin, faire défiler la bande changeait de playlist.
         */
        let vientDeGlisser = false;

        const arreterElan = () => {
            if (animation === null) return;
            cancelAnimationFrame(animation);
            animation = null;
        };

        const lancerElan = () => {
            let v = vitesse;
            const pas = () => {
                v *= FROTTEMENT;
                if (Math.abs(v) < VITESSE_MORTE) { animation = null; return; }
                const avant = bande.scrollLeft;
                placer(bande, avant + v);
                // Butée atteinte : insister ne ferait qu'occuper une image sur
                // deux jusqu'à extinction de la vitesse.
                if (bande.scrollLeft === avant) { animation = null; return; }
                animation = requestAnimationFrame(pas);
            };
            animation = requestAnimationFrame(pas);
        };

        bande.addEventListener('pointerdown', (e) => {
            if (e.pointerType === 'mouse') return;
            arreterElan();
            contact = e.pointerId;
            departX = e.clientX;
            dernierX = e.clientX;
            dernierInstant = e.timeStamp;
            departScroll = bande.scrollLeft;
            vitesse = 0;
            glisse = false;
        });

        bande.addEventListener('pointermove', (e) => {
            if (e.pointerId !== contact) return;
            const ecart = e.clientX - departX;

            if (!glisse) {
                if (Math.abs(ecart) < SEUIL_GLISSEMENT_PX) return;
                glisse = true;
                // Le doigt peut sortir de la bande sans que le geste s'arrête.
                bande.setPointerCapture(contact);
            }

            const duree = e.timeStamp - dernierInstant;
            // Ramenée à l'image de 16 ms, unité dans laquelle l'élan avance.
            if (duree > 0) vitesse = ((dernierX - e.clientX) / duree) * 16;
            dernierX = e.clientX;
            dernierInstant = e.timeStamp;

            placer(bande, departScroll - ecart);
        });

        const relacher = (e) => {
            if (e.pointerId !== contact) return;
            if (glisse && bande.hasPointerCapture(contact)) {
                bande.releasePointerCapture(contact);
            }
            contact = null;
            if (!glisse) return;
            glisse = false;
            vientDeGlisser = true;
            lancerElan();
        };

        bande.addEventListener('pointerup', relacher);
        bande.addEventListener('pointercancel', relacher);

        // En capture : le clic doit être intercepté avant d'atteindre l'onglet,
        // pas après. Le témoin ne vaut que pour ce clic-ci.
        bande.addEventListener('click', (e) => {
            if (!vientDeGlisser) return;
            vientDeGlisser = false;
            e.preventDefault();
            e.stopPropagation();
        }, true);
    }

    /**
     * Branche la bande d'onglets. Sans effet si elle l'est déjà.
     * @returns {boolean} false si la bande n'est pas encore dans le document
     */
    function init() {
        const bande = document.getElementById('playlists-tabs-container');
        if (!bande) return false;
        if (bande.dataset.scrollInit === 'true') return true;
        bande.dataset.scrollInit = 'true';

        const rafraichir = () => majReperes(bande);

        bande.addEventListener('scroll', rafraichir, { passive: true });
        // `passive: false` est indispensable : sans lui, `preventDefault` est
        // ignoré et la page défilerait en même temps que la bande.
        bande.addEventListener('wheel', (e) => surMolette(bande, e), { passive: false });
        brancherGlissement(bande);

        /*
         * Deux sources de changement, toutes deux hors de notre contrôle : la
         * largeur disponible — rotation de l'écran, redimensionnement de la
         * carte dans la grille — et la liste des onglets, reconstruite à chaque
         * mise à jour d'état par updatePlaylistsUI. Les observer dispense d'un
         * point d'accroche dans js/playlists.js, qui n'aurait aucune raison de
         * connaître ce module.
         */
        if (window.ResizeObserver) {
            new ResizeObserver(rafraichir).observe(bande);
        } else {
            window.addEventListener('resize', rafraichir);
        }
        if (window.MutationObserver) {
            new MutationObserver(rafraichir).observe(bande, { childList: true, subtree: true });
        }

        rafraichir();
        return true;
    }

    window.MusicPlayer.initPlaylistTabsScroll = init;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
