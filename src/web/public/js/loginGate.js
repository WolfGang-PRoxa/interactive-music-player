/**
 * loginGate — La porte du tableau de bord.
 *
 * ## Le problème
 *
 * Le jeton d'accès est anonyme : le porter prouve qu'on est devant la machine,
 * jamais qui l'on est. Le bot, lui, agit sur des serveurs Discord peuplés de
 * gens réels ; il n'a aucune raison d'obéir à quelqu'un qui refuse de se
 * nommer. La connexion Discord devient donc la condition d'entrée.
 *
 * ## L'approche
 *
 * Le serveur seul sait où l'on en est — le cookie de session est `httpOnly`,
 * donc invisible au script, et l'état de l'application Discord ne se devine
 * pas. Ce module lui demande, puis ouvre ou non la porte.
 *
 * Elle ne se ferme pas. Ni croix, ni clic à côté, ni touche d'échappement : ce
 * n'est pas une confirmation qu'on écarte, et une fenêtre qu'on peut faire
 * disparaître d'un geste ne barre rien du tout. Le tableau de bord derrière
 * elle n'obéirait de toute façon à aucune commande — le serveur refuse tout ce
 * qu'un visiteur sans session demande —, mais le laisser croire le contraire
 * serait une interface qui ment.
 *
 * Le clavier est retenu aussi, et pas seulement la souris : sans cela, la
 * tabulation promène le focus dans un tableau de bord inerte posé derrière la
 * fenêtre, ce qui donne exactement l'impression d'une porte contournable.
 *
 * ## Le repli
 *
 * Une installation dont l'application Discord n'est pas configurée ne *peut*
 * pas recevoir de connexion. Barrer la route y enfermerait l'installateur hors
 * de son propre bot pour un secret manquant dans un fichier. La fenêtre dit
 * alors ce qu'il manque, et laisse entrer par le jeton comme avant : le serveur
 * rend d'ailleurs déjà les pleins droits dans ce cas, l'interface ne fait que
 * s'accorder avec lui.
 */

window.MusicPlayer = window.MusicPlayer || {};

(function () {
    'use strict';

    const gate = document.getElementById('login-gate');
    if (!gate) return;

    const fallback = document.getElementById('login-gate-fallback');
    const callbackLine = document.getElementById('login-gate-callback');
    const errorLine = document.getElementById('login-gate-error');
    const loginBtn = document.getElementById('btn-login-discord');
    const bypassBtn = document.getElementById('btn-login-bypass');

    /** Traduction, avec repli sur le texte déjà présent dans le balisage. */
    function t(key, fallbackText) {
        const translated = window.MusicPlayer.t ? window.MusicPlayer.t(key) : key;
        return translated === key ? fallbackText : translated;
    }

    /**
     * Retient le focus dans la fenêtre.
     *
     * Posé en capture sur le document : un écouteur sur la fenêtre elle-même ne
     * verrait jamais les touches frappées pendant que le focus est ailleurs, et
     * c'est précisément ce cas qu'il faut rattraper.
     */
    function trapKeys(event) {
        if (gate.classList.contains('hidden')) return;

        // Échapper ne referme rien : il n'y a rien à refermer.
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            return;
        }

        if (event.key !== 'Tab') return;

        const focusable = gate.querySelectorAll('a[href], button:not([disabled])');
        const visible = [...focusable].filter(el => el.offsetParent !== null);
        if (visible.length === 0) return;

        const first = visible[0];
        const last = visible[visible.length - 1];
        const target = document.activeElement;

        // La tabulation ne sort pas de la fenêtre : elle en fait le tour.
        if (!gate.contains(target)) {
            event.preventDefault();
            first.focus();
        } else if (event.shiftKey && target === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && target === last) {
            event.preventDefault();
            first.focus();
        }
    }

    /** Ferme la porte et bloque la page derrière elle. */
    function open(state) {
        const configured = Boolean(state && state.oauthReady);

        loginBtn.hidden = !configured;
        fallback.classList.toggle('hidden', configured);

        if (!configured && callbackLine) {
            callbackLine.textContent = state && state.callbackUrl ? state.callbackUrl : '';
        }

        gate.classList.remove('hidden');
        document.body.classList.add('login-gate-open');
        document.addEventListener('keydown', trapKeys, true);

        // Le premier élément atteignable prend le focus : un lecteur d'écran
        // annonce alors la porte plutôt que le tableau de bord inerte.
        const target = configured ? loginBtn : bypassBtn;
        if (target) setTimeout(() => { try { target.focus(); } catch (e) {} }, 50);
    }

    /** Rend la page à l'utilisateur. */
    function close() {
        gate.classList.add('hidden');
        document.body.classList.remove('login-gate-open');
        document.removeEventListener('keydown', trapKeys, true);
    }

    /**
     * Demande au serveur où l'on en est, et agit.
     *
     * Une réponse illisible — serveur qui redémarre, réseau coupé — laisse la
     * page ouverte plutôt que barrée : le serveur reste seul juge des droits, et
     * une porte fermée sur un incident réseau empêcherait de travailler sans
     * rien protéger de plus.
     */
    async function check() {
        let state;
        try {
            const res = await fetch('/auth/state', { credentials: 'same-origin' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            state = await res.json();
        } catch (e) {
            console.warn('[LoginGate] État de connexion indisponible :', e.message);
            close();
            return null;
        }

        window.MusicPlayer.authState = state;
        if (state.pendingLogin) open(state);
        else close();
        return state;
    }

    if (loginBtn) {
        loginBtn.addEventListener('click', (e) => {
            // La destination de retour est le tableau de bord tel qu'il est
            // ouvert : l'utilisateur revient là où il en était, et non à la
            // racine, ce qui perdrait le serveur choisi ou la page consultée.
            e.preventDefault();
            const returnTo = window.location.pathname + window.location.search;
            window.location.href = '/auth/discord?returnTo=' + encodeURIComponent(returnTo);
        });
    }

    if (bypassBtn) {
        bypassBtn.addEventListener('click', () => {
            // Sans application Discord configurée, le serveur accorde déjà les
            // pleins droits au porteur du jeton : il n'y a rien à demander, la
            // fenêtre n'a plus qu'à s'effacer.
            close();
        });
    }

    if (errorLine) {
        // Discord renvoie parfois sur le tableau de bord avec une erreur en
        // paramètre plutôt que sur la page d'erreur du trajet.
        const failure = new URLSearchParams(window.location.search).get('authError');
        if (failure) {
            errorLine.textContent = t('login_gate_failed',
                'La connexion Discord n\'a pas abouti. Réessayez.');
            errorLine.classList.remove('hidden');
        }
    }

    window.MusicPlayer.checkLoginGate = check;
    check();
})();
