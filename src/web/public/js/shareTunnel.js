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
    /** Un téléchargement demandé, en attente du constat qui le confirmera. */
    let pendingDownload = false;

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

    /**
     * Un bouton, avec son infobulle.
     *
     * Elle n'est pas décorative : l'étiquette dit le geste, l'infobulle dit ce
     * qu'il déclenche. « J'ai installé Tailscale » ne laisse pas deviner que la
     * machine sera réexaminée, et sans cela on clique sans savoir sur quoi.
     */
    function button(label, onClick, options) {
        const { variant, tooltip, i18nTooltip } = options || {};
        const el = document.createElement('button');
        el.className = `tunnel-btn${variant ? ` ${variant}` : ''}`;
        el.textContent = label;
        el.disabled = busy;
        if (tooltip) el.setAttribute('data-tooltip', tooltip);
        if (i18nTooltip) el.setAttribute('data-i18n-tooltip', i18nTooltip);
        el.addEventListener('click', onClick);
        return el;
    }

    /* ═════════════════════ Déclarer l'adresse chez Discord ═════════════════════ */

    /**
     * Le geste a-t-il été fait ? Porte la marche à suivre, une fois l'onglet
     * du portail ouvert.
     */
    let declared = false;

    /**
     * Le bouton qui prépare la déclaration.
     *
     * Une adresse publiée ne sert à rien tant que Discord ne la connaît pas :
     * l'aller-retour de connexion revient dessus, et le portail refuse toute
     * redirection qu'on ne lui a pas déclarée. C'est l'étape que rien ne
     * signalait, et qu'il fallait deviner en lisant un journal.
     *
     * Deux choses en un clic, parce qu'elles ne valent rien séparément : le
     * presse-papiers reçoit l'URL de rappel, et le portail s'ouvre à l'endroit
     * où la coller.
     *
     * @returns {HTMLElement|null} null si l'application n'est pas configurée —
     *   il n'y a alors aucun portail où aller.
     */
    function declareButton() {
        if (!current || !current.redirectUri) return null;

        return button(t('tunnel_declare_action', 'Déclarer chez Discord'), () => {
            /*
             * L'URL de rappel, et non l'adresse affichée juste à côté.
             *
             * Celle-ci mène au tableau de bord et sert de lien d'invitation ;
             * le portail, lui, attend l'adresse à laquelle Discord renverra —
             * la même, suivie de « /auth/discord/callback ». Copier ce qui est
             * affiché serait copier une adresse que le portail refusera.
             */
            copy(current.redirectUri);

            /*
             * La page de l'application, pas la liste.
             *
             * L'identifiant vient du serveur : sans lui, on ne peut qu'ouvrir
             * l'index et laisser l'utilisateur retrouver son application parmi
             * les autres.
             */
            const portal = current.clientId
                ? `https://discord.com/developers/applications/${current.clientId}/oauth2`
                : 'https://discord.com/developers/applications';
            window.open(portal, '_blank', 'noreferrer,noopener');

            declared = true;
            render();
        }, {
            variant: 'primary',
            tooltip: t('tunnel_declare_tip',
                'Copie l\'URL de rappel et ouvre la page OAuth2 de votre application Discord'),
            i18nTooltip: 'tunnel_declare_tip',
        });
    }

    /**
     * Copie sans dépendre du presse-papiers moderne.
     *
     * `navigator.clipboard` exige une origine sûre. Le tableau de bord en est
     * une lorsqu'il est publié — c'est du HTTPS —, mais pas toujours en local :
     * `http://127.0.0.1` y passe, un nom de machine en clair non. Le repli par
     * `execCommand` couvre ces cas-là, où le bouton serait sinon muet.
     */
    function copy(text) {
        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
            return;
        }
        fallbackCopy(text);
    }

    function fallbackCopy(text) {
        const zone = document.createElement('textarea');
        zone.value = text;
        zone.setAttribute('readonly', '');
        zone.style.cssText = 'position:fixed;top:-1000px;opacity:0';
        document.body.appendChild(zone);
        zone.select();
        try { document.execCommand('copy'); } catch (e) {}
        document.body.removeChild(zone);
    }

    /**
     * La marche à suivre, une fois le portail ouvert.
     *
     * Trois gestes, dans l'ordre où le portail les présente. Sans eux, on
     * arrive sur une page dense et l'on cherche « Redirects » parmi une dizaine
     * de réglages — et surtout, rien ne dit qu'il faut enregistrer à la fin,
     * ce que le portail ne fait pas tout seul.
     *
     * L'adresse copiée est répétée : le presse-papiers a pu servir entre-temps,
     * et l'on doit pouvoir la relire sans revenir ici.
     */
    function declareSteps() {
        const bloc = document.createElement('div');
        bloc.className = 'tunnel-declare-steps';

        bloc.appendChild(line('tunnel-declare-lead',
            t('tunnel_declare_copied', 'URL de rappel copiée. Dans l\'onglet qui vient de '
                + 's\'ouvrir :')));

        const list = document.createElement('ol');
        for (const [key, fallback] of [
            ['tunnel_declare_step1', 'Section « Redirects », bouton « Add Redirect »'],
            ['tunnel_declare_step2', 'Collez l\'adresse dans le champ'],
            ['tunnel_declare_step3', 'Enregistrez avec « Save Changes » en bas de page'],
        ]) {
            const li = document.createElement('li');
            li.textContent = t(key, fallback);
            list.appendChild(li);
        }
        bloc.appendChild(list);

        const rappel = line('tunnel-declare-uri', current.redirectUri);
        rappel.setAttribute('data-tooltip', t('tunnel_declare_uri_tip',
            'L\'adresse à coller, si le presse-papiers a servi entre-temps'));
        bloc.appendChild(rappel);

        return bloc;
    }

    /**
     * Vérifie avant de télécharger.
     *
     * Tailscale a pu être installé depuis l'ouverture de cette fenêtre — c'est
     * même le cas ordinaire, puisqu'on vient d'aller le faire. Rapporter un
     * installateur par-dessus une installation qui existe déjà ferait perdre du
     * temps à qui n'avait qu'à cliquer sur « J'ai installé Tailscale ».
     *
     * Le téléchargement ne part donc qu'après le constat, et seulement si la
     * commande manque toujours.
     */
    function checkThenDownload() {
        pendingDownload = true;
        ask('tunnelState');
    }

    /**
     * Lance le téléchargement sans quitter la page.
     *
     * Le fichier est servi en pièce jointe : le navigateur l'enregistre au lieu
     * d'y naviguer, et le tableau de bord reste ouvert derrière — avec l'étape
     * suivante déjà affichée.
     */
    function startDownload(url) {
        const a = document.createElement('a');
        a.href = url;
        a.rel = 'noreferrer noopener';
        if (document.body) {
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        }
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
        absent: (state) => ({
            title: t('tunnel_absent_title', 'Tailscale n\'est pas installé'),
            body: t('tunnel_absent_body',
                'Le tableau de bord ne sort pas de cette machine. Tailscale lui donne une '
                + 'adresse joignable de partout, sans ouvrir de port sur votre box. '
                + 'L\'installation demande les droits administrateur : elle se fait à la main, '
                + 'puis cette fenêtre reprend la suite.'),
            gestes: [button(
                state.installer && state.installer.direct
                    ? t('tunnel_absent_action', 'Télécharger l\'installateur')
                    : t('tunnel_absent_page', 'Ouvrir la page de téléchargement'),
                checkThenDownload,
                {
                    variant: 'primary',
                    tooltip: t('tunnel_absent_tip',
                        'Vérifie d\'abord que Tailscale n\'a pas été installé entre-temps, '
                        + 'puis lance le téléchargement'),
                    i18nTooltip: 'tunnel_absent_tip',
                })],
            recheck: {
                label: t('tunnel_recheck_installed', 'J\'ai installé Tailscale'),
                tooltip: t('tunnel_recheck_installed_tip',
                    'Réexamine cette machine pour passer à l\'étape suivante'),
                key: 'tunnel_recheck_installed_tip',
            },
        }),

        unreachable: () => ({
            title: t('tunnel_unreachable_title', 'Tailscale ne répond pas'),
            body: t('tunnel_unreachable_body',
                'La commande est là, mais le service ne répond pas. Il est sans doute arrêté : '
                + 'lancez l\'application Tailscale, puis réessayez.'),
            gestes: [],
            recheck: {
                label: t('tunnel_recheck_started', 'J\'ai lancé Tailscale'),
                tooltip: t('tunnel_recheck_started_tip',
                    'Réexamine cette machine pour voir si le service répond'),
                key: 'tunnel_recheck_started_tip',
            },
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
            recheck: {
                label: t('tunnel_recheck_enabled', 'C\'est activé dans la console'),
                tooltip: t('tunnel_recheck_enabled_tip',
                    'Réexamine les droits que ce réseau Tailscale accorde à la machine'),
                key: 'tunnel_recheck_enabled_tip',
            },
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
            const row = document.createElement('div');
            row.className = 'tunnel-url-row';

            const url = document.createElement('p');
            url.className = 'tunnel-url';
            url.textContent = step.url;
            row.appendChild(url);

            const declare = declareButton();
            if (declare) row.appendChild(declare);

            zone.appendChild(row);

            // Ce qu'il reste à faire dans l'onglet qui vient de s'ouvrir. Il ne
            // paraît qu'après le clic : avant, il décrirait un onglet qui
            // n'existe pas.
            if (declared) zone.appendChild(declareSteps());
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

        /*
         * Le bouton de reprise n'apparaît que là où l'on part faire quelque
         * chose ailleurs — installer, démarrer, activer un droit dans une
         * console. Ces gestes-là ne parviennent pas au bot, et il faut bien un
         * moyen de lui dire de regarder à nouveau.
         *
         * Il porte le geste accompli plutôt que l'action technique : « J'ai
         * installé Tailscale » se comprend sans rien savoir, là où « Réexaminer »
         * n'apprenait ni ce qui était examiné ni pourquoi. Ailleurs — prêt,
         * publié, adresse occupée — il n'y a rien à reprendre, et il disparaît.
         */
        if (step.recheck) {
            zone.appendChild(actions(button(step.recheck.label, () => ask('tunnelState'), {
                tooltip: step.recheck.tooltip,
                i18nTooltip: step.recheck.key,
            })));
        }
    }

    /* ═════════════════════ Entrées ═════════════════════ */

    /** Appelé par le routeur de messages à chaque réponse du serveur. */
    window.MusicPlayer.onTunnelState = function (data) {
        busy = false;
        current = data || null;
        render();

        // Le téléchargement demandé attendait ce constat : il ne part que si la
        // commande manque toujours. Installée entre-temps, l'étape affichée est
        // déjà la suivante, et rapporter un installateur n'aurait plus de sens.
        if (pendingDownload) {
            pendingDownload = false;
            if (current && current.step === 'absent' && current.installer) {
                startDownload(current.installer.url);
            }
        }
    };

    /**
     * Demandé à l'ouverture de la fenêtre de partage, jamais en continu.
     *
     * Constater lance deux processus : le faire à chaque état reçu coûterait
     * cher pour une valeur qui ne bouge qu'au geste de quelqu'un.
     */
    window.MusicPlayer.refreshTunnel = function () {
        // La marche à suivre ne survit pas à la fermeture de la fenêtre : elle
        // décrit un onglet du portail qu'on a depuis longtemps refermé.
        declared = false;
        ask('tunnelState');
    };

    render();
})();
