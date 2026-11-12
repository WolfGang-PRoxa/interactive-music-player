/**
 * shareTunnel — Rendre le tableau de bord joignable de l'extérieur, en guidé.
 *
 * ## Le problème
 *
 * Publier le tableau de bord passait par Tailscale, et demandait quatre choses
 * que rien n'annonçait : l'installer avec les droits administrateur, créer un
 * compte, obtenir du réseau le droit de publier, monter le tunnel. On ne
 * découvrait l'étape suivante qu'en butant dessus.
 *
 * ## L'approche
 *
 * Un tunnel Cloudflare, qui n'en demande plus que deux, toutes deux faites par
 * le bot sur un clic : rapporter `cloudflared`, puis ouvrir le tunnel. Aucun
 * compte n'est nécessaire — c'est le partage rapide, dont l'adresse change à
 * chaque lancement. Qui veut une adresse fixe la configure dans `.env` (voir
 * cloudflare.js), et la fenêtre s'y adapte.
 *
 * Une seule zone, qui ne montre jamais qu'une étape : celle où l'on en est. Une
 * phrase pour dire où l'on en est, une pour dire pourquoi, un bouton pour la
 * suite.
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

    /**
     * Un bouton, avec son infobulle.
     *
     * Elle n'est pas décorative : l'étiquette dit le geste, l'infobulle dit ce
     * qu'il déclenche. « J'ai installé cloudflared » ne laisse pas deviner que
     * la machine sera réexaminée, et sans cela on clique sans savoir sur quoi.
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

        /*
         * L'étiquette nomme ce qui est copié.
         *
         * « Déclarer chez Discord », posé à côté d'une adresse, laisse croire
         * que c'est celle-là qu'on emporte. Ce n'en est pas une nuance : coller
         * l'adresse de partage dans les redirections donne une déclaration que
         * Discord acceptera et qui ne servira jamais — l'aller-retour cherche le
         * chemin de rappel, qu'elle n'a pas.
         */
        return button(t('tunnel_declare_action',
            'Copier l\'URL de rappel et ouvrir Discord'), () => {
            /*
             * L'URL de rappel, et non l'adresse affichée juste à côté.
             *
             * Celle-ci mène au tableau de bord et sert de lien d'invitation ;
             * le portail, lui, attend l'adresse à laquelle Discord renverra —
             * la même, suivie de « /auth/discord/callback ». Copier ce qui est
             * affiché serait copier une adresse que le portail refusera.
             */
            window.MusicPlayer.copyToClipboard(current.redirectUri);

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
        }, current.relay ? {
            /*
             * Derrière le relais, l'URL de rappel n'a plus rien à voir avec
             * l'adresse affichée : c'est celle du relais, fixe. Le dire évite
             * de croire qu'il faudra revenir ici à chaque lancement, alors que
             * la déclaration est faite une fois pour toutes.
             */
            variant: 'primary',
            tooltip: t('tunnel_declare_relay_tip',
                'Ce n\'est pas l\'adresse ci-dessous : c\'est l\'adresse fixe du relais, où '
                + 'Discord renvoie après la connexion. Elle se déclare une seule fois, même '
                + 'si l\'adresse du tunnel change.'),
            i18nTooltip: 'tunnel_declare_relay_tip',
        } : {
            variant: 'primary',
            tooltip: t('tunnel_declare_tip',
                'Ce n\'est pas l\'adresse ci-dessous : l\'URL de rappel est la même, '
                + 'suivie du chemin où Discord renvoie. Ouvre la page OAuth2 de votre '
                + 'application.'),
            i18nTooltip: 'tunnel_declare_tip',
        });
    }

    /**
     * Le bouton qui copie l'adresse de partage.
     *
     * Elle était posée là en simple paragraphe, sélectionnable d'un triple clic
     * — un geste que personne ne devine, et que le moindre glissement rate. Elle
     * garde son allure de champ, en chasse fixe : c'est encore une adresse qu'on
     * lit, et non un bouton de plus dans une fenêtre qui en compte déjà.
     *
     * La copie confirme sur place, et non par un message qui passe : le regard
     * est sur l'adresse au moment du clic, et c'est là qu'il faut lui répondre.
     *
     * @param {string} adresse
     * @returns {HTMLElement}
     */
    function urlButton(adresse) {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'tunnel-url';
        el.textContent = adresse;
        el.setAttribute('data-tooltip', t('tunnel_url_copy_tip', 'Copier cette adresse'));
        el.setAttribute('data-i18n-tooltip', 'tunnel_url_copy_tip');

        el.addEventListener('click', async () => {
            const ok = await window.MusicPlayer.copyToClipboard(adresse);
            if (!ok) return;

            el.textContent = t('tunnel_url_copied', 'Adresse copiée');
            el.classList.add('is-copied');

            // Le temps de le lire, puis l'adresse revient : c'est elle qu'on
            // vient consulter, pas la confirmation.
            clearTimeout(el._back);
            el._back = setTimeout(() => {
                el.textContent = adresse;
                el.classList.remove('is-copied');
            }, 1600);
        });

        return el;
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
     * bloqué, jamais seulement *que* c'est bloqué.
     */
    const STEPS = {
        absent: (state) => {
            const direct = Boolean(state.installer && state.installer.direct);
            return {
                title: t('tunnel_absent_title', 'Le partage n\'est pas encore prêt'),
                body: t('tunnel_absent_body',
                    'Pour sortir de cette machine, le tableau de bord passe par un tunnel '
                    + 'Cloudflare, sans ouvrir de port sur votre box. Il lui faut un petit '
                    + 'programme, cloudflared, que le bot rapporte lui-même : aucun compte, '
                    + 'aucun droit administrateur.'),
                gestes: [direct
                    ? button(t('tunnel_absent_action', 'Télécharger cloudflared'),
                        () => ask('tunnelInstall'), {
                            variant: 'primary',
                            tooltip: t('tunnel_absent_tip',
                                'Rapporte cloudflared depuis la page officielle de Cloudflare, '
                                + 'dans le dossier du bot'),
                            i18nTooltip: 'tunnel_absent_tip',
                        })
                    : link(t('tunnel_absent_page', 'Ouvrir la page de téléchargement'),
                        state.installer ? state.installer.url : '#')],
                // Sur un système sans téléchargement direct, l'installation se
                // fait ailleurs : il faut pouvoir dire au bot de regarder à
                // nouveau. Ailleurs, le bot télécharge et constate lui-même.
                recheck: direct ? null : {
                    label: t('tunnel_recheck_installed', 'J\'ai installé cloudflared'),
                    tooltip: t('tunnel_recheck_installed_tip',
                        'Réexamine cette machine pour passer à l\'étape suivante'),
                    key: 'tunnel_recheck_installed_tip',
                },
            };
        },

        downloading: () => ({
            title: t('tunnel_downloading_title', 'Téléchargement de cloudflared…'),
            body: t('tunnel_downloading_body',
                'Quelques dizaines de Mo, depuis la page officielle de Cloudflare. La suite '
                + 's\'affiche ici dès qu\'il est arrivé.'),
            gestes: [],
        }),

        needsAddress: () => ({
            title: t('tunnel_address_title', 'Il manque l\'adresse du tunnel'),
            body: t('tunnel_address_body',
                'Un tunnel nommé est configuré (CLOUDFLARE_TUNNEL_TOKEN), mais pas l\'adresse '
                + 'que vous lui avez donnée dans le tableau de bord Cloudflare. Écrivez-la '
                + 'dans PUBLIC_URL, puis redémarrez le bot.'),
            gestes: [link(t('tunnel_address_action', 'Ouvrir le tableau de bord Cloudflare'),
                'https://one.dash.cloudflare.com/')],
        }),

        ready: (state) => ({
            title: t('tunnel_ready_title', 'Prêt à publier'),
            body: state.mode === 'named'
                ? t('tunnel_ready_named_body',
                    'Publier ouvre votre tunnel Cloudflare sur l\'adresse ci-dessous. L\'accès, '
                    + 'lui, ne change pas : sans compte Discord accepté par vous, on ne voit que '
                    + 'la page de connexion.')
                : t('tunnel_ready_body',
                    'Publier ouvre un tunnel Cloudflare : le tableau de bord reçoit une adresse '
                    + 'joignable de partout, qui change à chaque lancement. L\'accès, lui, ne '
                    + 'change pas : sans compte Discord accepté par vous, on ne voit que la page '
                    + 'de connexion.'),
            gestes: [button(t('tunnel_ready_action', 'Publier le tableau de bord'),
                () => ask('tunnelMount'), { variant: 'primary' })],
            url: state.publicUrl,
            declare: true,
        }),

        starting: (state) => ({
            title: t('tunnel_starting_title', 'Ouverture du tunnel…'),
            body: t('tunnel_starting_body',
                'Cloudflare prépare l\'adresse. Cela prend d\'ordinaire quelques secondes.'),
            gestes: [button(t('tunnel_starting_cancel', 'Annuler'), () => ask('tunnelUnmount'))],
            url: state.publicUrl,
            recheck: {
                label: t('tunnel_recheck_starting', 'Voir où ça en est'),
                tooltip: t('tunnel_recheck_starting_tip',
                    'Redemande au bot si Cloudflare a confirmé le tunnel'),
                key: 'tunnel_recheck_starting_tip',
            },
        }),

        serving: (state) => ({
            title: t('tunnel_serving_title', 'Publié'),
            body: state.mode === 'named'
                ? t('tunnel_serving_body',
                    'Cette adresse mène au tableau de bord depuis n\'importe où. Elle sert aussi '
                    + 'de lien d\'invitation.')
                : t('tunnel_serving_quick_body',
                    'Cette adresse mène au tableau de bord depuis n\'importe où, et sert de lien '
                    + 'd\'invitation. Elle change à chaque lancement du bot : après un '
                    + 'redémarrage, renvoyez le lien d\'invitation.'),
            gestes: [button(t('tunnel_serving_action', 'Ne plus publier'),
                () => ask('tunnelUnmount'))],
            url: state.publicUrl,
            declare: true,
        }),

        failed: (state) => ({
            title: t('tunnel_failed_title', 'Le tunnel s\'est arrêté'),
            body: t('tunnel_failed_body',
                'Cloudflare a coupé le tunnel, ou cloudflared s\'est arrêté de lui-même. La '
                + 'cause est ci-dessous ; vous pouvez réessayer.')
                + (state.detail ? ` (${state.detail})` : ''),
            gestes: [button(t('tunnel_failed_action', 'Réessayer'),
                () => ask('tunnelMount'), { variant: 'primary' })],
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

        if (step.url || step.declare) {
            /*
             * Le bouton au-dessus de l'adresse, et non à côté.
             *
             * Son étiquette doit nommer ce qu'il copie — l'URL de rappel —,
             * faute de quoi on croit qu'il copie l'adresse affichée juste là.
             * Nommée, elle ne tient plus dans la place laissée à droite du
             * champ : elle s'y serrerait sur deux lignes ou tronquerait le
             * champ. Au-dessus, elle a toute la largeur, et l'ordre de lecture
             * dit la même chose que le geste — d'abord ce qu'on va faire,
             * ensuite l'adresse dont il ne s'agit pas.
             *
             * Il paraît aussi avant la publication quand le relais est employé :
             * son adresse ne dépend pas du tunnel, et la déclarer d'avance
             * évite un premier invité éconduit par Discord.
             */
            const declare = (step.url || current.relay) ? declareButton() : null;
            if (declare) {
                const row = document.createElement('div');
                row.className = 'tunnel-declare-row';
                row.appendChild(declare);
                zone.appendChild(row);
            }

            if (step.url) zone.appendChild(urlButton(step.url));

            // Ce qu'il reste à faire dans l'onglet qui vient de s'ouvrir. Il ne
            // paraît qu'après le clic : avant, il décrirait un onglet qui
            // n'existe pas.
            if (declared) zone.appendChild(declareSteps());
        }

        if (step.gestes.length) zone.appendChild(actions(...step.gestes));

        // Ce qui vient d'échouer se dit sous le geste qui l'a provoqué, et non
        // à la place de l'étape : on doit pouvoir réessayer sans recharger.
        if (current.error) {
            zone.appendChild(line('tunnel-error',
                t('tunnel_error', 'Échec :') + ' ' + current.error));
        }

        /*
         * Le bouton de reprise n'apparaît que là où quelque chose se passe
         * sans que le bot puisse le dire de lui-même — une installation faite
         * à la main, un tunnel que Cloudflare tarde à confirmer. Il faut bien
         * un moyen de lui demander de regarder à nouveau.
         *
         * Il porte le geste accompli plutôt que l'action technique : « J'ai
         * installé cloudflared » se comprend sans rien savoir, là où « Réexaminer »
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
        current = data || null;
        // Le téléchargement répond en deux temps — « en cours », puis le
        // résultat : la fenêtre reste occupée tant que le second n'est pas là.
        busy = Boolean(current && current.step === 'downloading');
        render();
    };

    /**
     * Demandé à l'ouverture de la fenêtre de partage, jamais en continu.
     *
     * L'état ne bouge qu'au geste de quelqu'un, et chaque geste répond par le
     * sien : le redemander en continu n'apprendrait rien.
     */
    window.MusicPlayer.refreshTunnel = function () {
        // La marche à suivre ne survit pas à la fermeture de la fenêtre : elle
        // décrit un onglet du portail qu'on a depuis longtemps refermé.
        declared = false;
        ask('tunnelState');
    };

    render();
})();
