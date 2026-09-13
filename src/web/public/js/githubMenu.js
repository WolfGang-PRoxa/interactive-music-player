/**
 * githubMenu — Le sous-menu du bouton GitHub.
 *
 * ## Le problème
 *
 * Le bouton GitHub ne savait faire qu'une chose : ouvrir le dépôt. Trois autres
 * gestes tournent pourtant autour de lui — mettre le projet en favori, le
 * partager, signaler un problème —, et aucun n'avait sa place dans un en-tête
 * déjà plein. Trois boutons de plus pour trois gestes rares, c'est trois fois
 * le prix en largeur de ce que cela rend.
 *
 * ## L'approche
 *
 * Le même geste que le réglage fin du jour et de la nuit : un appui long
 * déplie un panneau sous le bouton, l'appui court garde son rôle d'origine.
 * C'est délibérément la copie de `js/themeBlend.js` — un appui long qui
 * s'ouvrirait ici en 300 ms et là en 450 ne serait plus un geste, mais deux.
 *
 * ## Ce qui change d'un bouton à l'autre
 *
 * GitHub est un lien, pas un bouton. Deux conséquences, et elles ne se
 * devinent pas :
 *
 *  - **Le clic qui suit l'appui long ouvrirait le dépôt.** Il ne suffit pas de
 *    l'empêcher de se propager, il faut annuler son action par défaut — sans
 *    quoi on demanderait le sous-menu et l'on quitterait la page.
 *
 *  - **Un appui long sur un lien, au doigt, ouvre le menu du navigateur**
 *    (« Ouvrir dans un nouvel onglet », « Copier l'adresse »…). Il passerait
 *    par-dessus le nôtre. Le geste est donc refusé le temps de l'appui, et la
 *    feuille de style coupe en plus la loupe native d'iOS.
 *
 * ## Les adresses
 *
 * Aucune n'est écrite ici : les trois se déduisent de celle que porte déjà le
 * bouton. Un dépôt renommé, ou un fork, n'a ainsi qu'un seul endroit à changer
 * — le `href` du lien, dans index.html.
 *
 * Mettre en favori demanderait une requête authentifiée que GitHub n'accepte
 * pas depuis une autre page : l'entrée ouvre donc le dépôt, et la notification
 * dit où trouver l'étoile. C'est un geste de plus que promis, mais c'est le
 * seul chemin honnête.
 */

window.MusicPlayer = window.MusicPlayer || {};

(function () {
    'use strict';

    /** Millisecondes d'appui avant que le menu ne s'ouvre. Celles de themeBlend. */
    const HOLD_MS = 450;

    /** Déplacement du doigt qui annule l'appui long, en pixels. */
    const HOLD_SLOP = 8;

    function el(id) {
        return document.getElementById(id);
    }

    function t(key, fallback) {
        const translated = typeof window.MusicPlayer.t === 'function' ? window.MusicPlayer.t(key) : key;
        return translated && translated !== key ? translated : fallback;
    }

    function toast(message) {
        if (typeof window.MusicPlayer.showToast === 'function') {
            window.MusicPlayer.showToast(message);
        }
    }

    const button = el('btn-github');
    const pop = el('gh-menu-pop');
    const star = el('gh-menu-star');
    const share = el('gh-menu-share');
    const issue = el('gh-menu-issue');

    if (!button || !pop) return;

    let holdTimer = null;
    let holdOrigin = null;
    /** Vrai entre l'ouverture par appui long et le clic qu'il faut avaler. */
    let opened = false;

    /* ═════════════════════ Les trois adresses ═════════════════════ */

    /**
     * Le dépôt, tel que le bouton le désigne.
     *
     * La barre finale et le `.git` sont retirés : un `href` peut les porter, et
     * « …/interactive-music-player.git/issues/new » ne mène nulle part. Dans cet
     * ordre, parce que l'adresse de clonage porte souvent les deux — « .git/ »,
     * dont un `.git$` seul ne verrait rien.
     */
    function repo() {
        const raw = button.getAttribute('href') || '';
        return raw.trim().replace(/\/+$/, '').replace(/\.git$/, '');
    }

    if (star) star.setAttribute('href', repo());
    if (issue) issue.setAttribute('href', repo() + '/issues/new');

    /* ═════════════════════ Ouvrir et fermer ═════════════════════ */

    /** Les entrées, dans l'ordre où le clavier les parcourt. */
    function items() {
        return [star, share, issue].filter(Boolean);
    }

    function open() {
        if (!pop.hidden) return;

        pop.classList.remove('is-closing');
        pop.hidden = false;
        opened = true;

        // Le focus part sur la première entrée : ouvert au clavier, le menu
        // doit pouvoir se parcourir sans avoir à le retrouver à la tabulation.
        const first = items()[0];
        if (first) {
            try { first.focus({ preventScroll: true }); } catch (e) { first.focus(); }
        }
    }

    function close() {
        if (pop.hidden || pop.classList.contains('is-closing')) return;

        pop.classList.add('is-closing');
        const done = () => {
            pop.removeEventListener('animationend', done);
            pop.classList.remove('is-closing');
            pop.hidden = true;
            /*
             * Le clic à avaler ne survit pas à la fermeture : ouvrir puis
             * cliquer ailleurs laissait ce drapeau levé, et le clic suivant sur
             * le bouton était avalé à son tour — le dépôt ne s'ouvrait plus
             * qu'une fois sur deux.
             */
            opened = false;
        };
        pop.addEventListener('animationend', done);
        // Filet : un moteur qui n'animerait rien ne déclencherait jamais
        // `animationend`, et le menu resterait ouvert pour toujours.
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
        // usages — le menu contextuel, l'ouverture dans un nouvel onglet.
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
     * Le menu du navigateur ne s'invite pas par-dessus le nôtre.
     *
     * Au doigt, un appui maintenu sur un lien ouvre la feuille « Ouvrir dans un
     * nouvel onglet / Copier l'adresse » : elle apparaîtrait pile au moment où
     * le sous-menu se déplie, et c'est elle qu'on verrait. Refusée pendant
     * l'appui et tant que le menu est ouvert ; ailleurs, le clic droit garde
     * tous ses droits.
     */
    button.addEventListener('contextmenu', (e) => {
        if (holdOrigin || !pop.hidden) e.preventDefault();
    });

    /*
     * Le clic qui suit un appui long est avalé.
     *
     * `preventDefault` est ici l'essentiel — sans lui, demander le sous-menu
     * ferait quitter la page pour GitHub. En capture, et `stopPropagation` avec :
     * rien ne justifie de réveiller le reste de l'en-tête pour un clic qui n'en
     * est pas un.
     */
    button.addEventListener('click', (e) => {
        // Le clic qui clôt le geste d'ouverture : avalé, et rien d'autre.
        if (opened) {
            opened = false;
            e.preventDefault();
            e.stopPropagation();
            return;
        }

        // Menu déjà ouvert : le bouton le referme. Sans cela, le seul moyen de
        // s'en défaire depuis le bouton lui-même était de partir sur GitHub.
        if (!pop.hidden) {
            close();
            e.preventDefault();
            e.stopPropagation();
            return;
        }

        // Appui court : le lien fait ce qu'il a toujours fait, ouvrir le dépôt.
    }, true);

    /* ═════════════════════ Les trois entrées ═════════════════════ */

    /**
     * Le repli du partage : l'adresse dans le presse-papier, et on le dit.
     *
     * @param {string} url
     */
    async function copyInstead(url) {
        let copied = false;
        if (typeof window.MusicPlayer.copyToClipboard === 'function') {
            copied = await window.MusicPlayer.copyToClipboard(url);
        }
        toast(copied
            ? t('toast_github_link_copied', 'Lien du projet copié dans le presse-papier.')
            : t('toast_github_link_failed', 'Copie impossible. Adresse du projet : {url}')
                .replace('{url}', url));
    }

    /*
     * Mettre en favori.
     *
     * Le lien mène au dépôt — voir l'en-tête : l'étoile ne se pose pas depuis
     * ici. La notification dit où elle se trouve, faute de quoi l'entrée
     * paraîtrait n'avoir rien fait d'autre que rouvrir la même page.
     */
    if (star) {
        star.addEventListener('click', () => {
            toast(t('toast_github_star_hint',
                'Dépôt ouvert : l’étoile « Star » se trouve en haut à droite de la page.'));
            close();
        });
    }

    /*
     * Partager.
     *
     * `navigator.share` ouvre la feuille de partage du système — c'est elle
     * qu'on veut sur téléphone, où l'adresse part vers une conversation en deux
     * touches. Elle n'existe ni sur la plupart des navigateurs de bureau, ni
     * hors contexte sécurisé, et le tableau de bord tourne souvent en HTTP
     * simple : le repli copie l'adresse et le dit.
     *
     * Appelée sans rien attendre auparavant : la feuille de partage exige un
     * geste encore frais, et un `await` glissé avant l'appel suffirait à la
     * faire refuser.
     */
    if (share) {
        share.addEventListener('click', () => {
            const url = repo();
            close();

            if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
                const shared = navigator.share({ title: document.title, url });
                if (shared && typeof shared.catch === 'function') {
                    shared.catch((err) => {
                        // Un partage abandonné n'est pas un échec : l'utilisateur
                        // a refermé la feuille, il n'a pas besoin qu'on le lui
                        // rappelle.
                        if (err && err.name === 'AbortError') return;
                        copyInstead(url);
                    });
                }
                return;
            }

            copyInstead(url);
        });
    }

    // Signaler un problème : le lien suffit, il ne reste qu'à ranger le menu.
    if (issue) issue.addEventListener('click', () => close());

    /* ═════════════ Le clavier, et le reste de la page ═════════════ */

    // Fermer en cliquant ailleurs, sans compter le geste qui vient d'ouvrir.
    document.addEventListener('pointerdown', (e) => {
        if (pop.hidden) return;
        if (pop.contains(e.target) || button.contains(e.target)) return;
        close();
    });

    document.addEventListener('keydown', (e) => {
        if (pop.hidden) return;

        if (e.key === 'Escape') {
            close();
            try { button.focus(); } catch (err) {}
            return;
        }

        /*
         * Les flèches parcourent les entrées en boucle.
         *
         * Un menu ouvert au clavier perdrait sinon son focus dès la première
         * flèche : elle ferait défiler la page derrière lui, et l'on ne verrait
         * plus où l'on en est.
         */
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            const list = items();
            if (!list.length) return;
            e.preventDefault();
            const from = list.indexOf(document.activeElement);
            const step = e.key === 'ArrowDown' ? 1 : -1;
            const next = from === -1
                ? (step === 1 ? 0 : list.length - 1)
                : (from + step + list.length) % list.length;
            try { list[next].focus({ preventScroll: true }); } catch (err) { list[next].focus(); }
        }
    });
})();
