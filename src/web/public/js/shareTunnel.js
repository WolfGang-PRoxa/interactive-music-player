/**
 * shareTunnel — Rendre le tableau de bord joignable de l'extérieur, en guidé.
 *
 * ## Le problème
 *
 * Publier le tableau de bord demande quatre choses que rien n'annonce :
 * installer Tailscale, authentifier la machine, obtenir du tailnet le droit de
 * publier, monter le tunnel. Chacune échoue à sa façon, et l'on ne découvrait
 * l'étape suivante qu'en butant dessus — après avoir cru, à chaque fois, que la
 * précédente avait raté.
 *
 * ## L'approche
 *
 * Une seule zone, qui ne montre jamais qu'une étape : celle où l'on en est. Pas
 * de liste de quatre points dont trois sont barrés — savoir ce qui reste à faire
 * n'aide pas quand on ne peut rien y faire tout de suite. Une phrase pour dire
 * où l'on en est, une pour dire pourquoi, un bouton pour la suite.
 *
 * Ce que la machine peut faire seule, elle le fait : l'authentification par clé
 * et le montage du tunnel sont deux appels. Ce qui lui échappe est nommé sans
 * détour — l'installation demande les droits administrateur, le compte
 * Tailscale ne se crée par aucune API, et le droit de publier s'accorde dans une
 * console qui n'est pas la nôtre.
 *
 * ## Ce que « publier » veut dire, et ce que ça ne veut pas dire
 *
 * Le port devient joignable depuis l'internet. L'accès, lui, ne change pas d'un
 * pouce : un inconnu sans session Discord ne voit que la porte, et un invité
 * authentifié n'obtient rien tant que l'hôte ne l'a pas admis. C'est dit dans la
 * fenêtre, parce qu'une publication qu'on croit ouverte à tous ne se fait jamais.
 */

window.MusicPlayer = window.MusicPlayer || {};

(function () {
    'use strict';

    const zone = document.getElementById('share-tunnel');
    if (!zone) return;

    /** Dernier état reçu, pour redessiner sans redemander. */
    let current = null;
    let busy = false;

    function t(key, fallback) {
        const value = typeof window.MusicPlayer.t === 'function'
            ? window.MusicPlayer.t(key) : key;
        return value && value !== key ? value : fallback;
    }

    function ask(type, data) {
        if (typeof window.MusicPlayer.sendWS !== 'function') return;
        busy = true;
        render();
        window.MusicPlayer.sendWS({ type, data: data || {} });
    }

    /* ═════════════════════ Fabriques ═════════════════════ */

    function line(className, text) {
        const el = document.createElement('p');
        el.className = className;
        el.textContent = text;
        return el;
    }

    function button(label, onClick, variant) {
        const el = document.createElement('button');
        el.className = `tunnel-btn${variant ? ` ${variant}` : ''}`;
        el.textContent = label;
        el.disabled = busy;
        el.addEventListener('click', onClick);
        return el;
    }

    /** Un lien qui s'ouvre ailleurs : ce que le bot ne peut pas faire pour vous. */
    function link(label, href) {
        const el = document.createElement('a');
        el.className = 'tunnel-btn link';
        el.textContent = label;
        el.href = href;
        el.target = '_blank';
        el.rel = 'noreferrer noopener';
        return el;
    }

    function actions(...items) {
        const row = document.createElement('div');
        row.className = 'tunnel-actions';
        items.filter(Boolean).forEach((item) => row.appendChild(item));
        return row;
    }

    /* ═════════════════════ Les étapes ═════════════════════ */

    /**
     * Ce que chaque état affiche.
     *
     * Un titre, une explication, des gestes. L'explication dit *pourquoi* c'est
     * bloqué, jamais seulement *que* c'est bloqué : « Tailscale n'est pas
     * installé » n'apprend rien à qui vient d'ouvrir cette fenêtre.
     */
    const STEPS = {
        absent: () => ({
            title: t('tunnel_absent_title', 'Tailscale n\'est pas installé'),
            body: t('tunnel_absent_body',
                'Le tableau de bord ne sort pas de cette machine. Tailscale lui donne une '
                + 'adresse joignable de partout, sans ouvrir de port sur votre box. '
                + 'L\'installation demande les droits administrateur : elle se fait à la main, '
                + 'puis cette fenêtre reprend la suite.'),
            gestes: [link(t('tunnel_absent_action', 'Télécharger Tailscale'),
                'https://tailscale.com/download')],
        }),

        unreachable: () => ({
            title: t('tunnel_unreachable_title', 'Tailscale ne répond pas'),
            body: t('tunnel_unreachable_body',
                'La commande est là, mais le service ne répond pas. Il est sans doute arrêté : '
                + 'lancez l\'application Tailscale, puis réessayez.'),
            gestes: [],
        }),

        needsLogin: () => ({
            title: t('tunnel_login_title', 'Cette machine n\'est rattachée à aucun compte'),
            body: t('tunnel_login_body',
                'Tailscale a besoin d\'un compte pour donner une adresse à cette machine. '
                + 'Aucun ne se crée automatiquement. Créez le vôtre, générez une clé '
                + 'd\'authentification, et collez-la ici : le bot fera le reste.'),
            gestes: [link(t('tunnel_login_key', 'Générer une clé'),
                'https://login.tailscale.com/admin/settings/keys')],
            saisie: {
                placeholder: t('tunnel_login_placeholder', 'tskey-auth-...'),
                label: t('tunnel_login_submit', 'Connecter cette machine'),
                onSubmit: (value) => ask('tunnelLogin', { authKey: value }),
            },
        }),

        needsCapability: () => ({
            title: t('tunnel_capability_title', 'Ce compte n\'autorise pas encore la publication'),
            body: t('tunnel_capability_body',
                'La machine est rattachée, mais votre réseau Tailscale n\'accorde pas le droit '
                + 'de publier. Il s\'active une fois pour toutes dans la console : les '
                + 'certificats HTTPS, puis Funnel. Revenez ensuite ici.'),
            gestes: [link(t('tunnel_capability_action', 'Ouvrir la console'),
                'https://login.tailscale.com/admin/dns')],
        }),

        ready: (state) => ({
            title: t('tunnel_ready_title', 'Prêt à publier'),
            body: t('tunnel_ready_body',
                'Publier rend l\'adresse joignable depuis l\'internet. L\'accès, lui, ne change '
                + 'pas : sans compte Discord accepté par vous, on ne voit que la page de '
                + 'connexion.'),
            gestes: [button(t('tunnel_ready_action', 'Publier le tableau de bord'),
                () => ask('tunnelMount'), 'primary')],
            url: state.publicUrl,
        }),

        serving: (state) => ({
            title: t('tunnel_serving_title', 'Publié'),
            body: t('tunnel_serving_body',
                'Cette adresse mène au tableau de bord depuis n\'importe où. Elle sert aussi '
                + 'de lien d\'invitation.'),
            gestes: [button(t('tunnel_serving_action', 'Ne plus publier'),
                () => ask('tunnelUnmount'))],
            url: state.publicUrl,
        }),

        otherTarget: (state) => ({
            title: t('tunnel_other_title', 'Un autre service occupe l\'adresse'),
            body: t('tunnel_other_body',
                'Un tunnel publie déjà autre chose sur cette machine. Il n\'y sera pas touché : '
                + 'quelqu\'un s\'en sert peut-être. Retirez-le vous-même si vous voulez cette '
                + 'adresse pour le tableau de bord.') + ` (${state.proxy || '?'})`,
            gestes: [],
        }),
    };

    /* ═════════════════════ Le dessin ═════════════════════ */

    function render() {
        zone.textContent = '';

        if (!current) {
            zone.appendChild(line('tunnel-body', t('tunnel_checking', 'Vérification…')));
            return;
        }

        const build = STEPS[current.step];
        if (!build) return;
        const step = build(current);

        zone.appendChild(line('tunnel-title', step.title));
        zone.appendChild(line('tunnel-body', step.body));

        if (step.url) {
            const url = document.createElement('p');
            url.className = 'tunnel-url';
            url.textContent = step.url;
            zone.appendChild(url);
        }

        if (step.saisie) {
            const row = document.createElement('div');
            row.className = 'tunnel-actions';

            const input = document.createElement('input');
            input.type = 'password';
            input.className = 'tunnel-input';
            input.placeholder = step.saisie.placeholder;
            input.autocomplete = 'off';
            row.appendChild(input);

            const submit = button(step.saisie.label, () => {
                const value = input.value.trim();
                if (value) step.saisie.onSubmit(value);
            }, 'primary');
            row.appendChild(submit);
            zone.appendChild(row);
        }

        if (step.gestes.length) zone.appendChild(actions(...step.gestes));

        // Ce qui vient d'échouer se dit sous le geste qui l'a provoqué, et non
        // à la place de l'étape : on doit pouvoir réessayer sans recharger.
        if (current.error) {
            zone.appendChild(line('tunnel-error',
                t('tunnel_error', 'Échec :') + ' ' + current.error));
        }

        const again = button(t('tunnel_refresh', 'Réexaminer'), () => ask('tunnelState'));
        again.classList.add('discreet');
        zone.appendChild(actions(again));
    }

    /* ═════════════════════ Entrées ═════════════════════ */

    /** Appelé par le routeur de messages à chaque réponse du serveur. */
    window.MusicPlayer.onTunnelState = function (data) {
        busy = false;
        current = data || null;
        render();
    };

    /**
     * Demandé à l'ouverture de la fenêtre de partage, jamais en continu.
     *
     * Constater lance deux processus : le faire à chaque état reçu coûterait
     * cher pour une valeur qui ne bouge qu'au geste de quelqu'un.
     */
    window.MusicPlayer.refreshTunnel = function () {
        ask('tunnelState');
    };

    render();
})();
