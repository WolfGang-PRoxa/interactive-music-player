/**
 * botConfig — La section « Configuration du bot » des paramètres.
 *
 * Montre et règle le fichier `.env` du bot sans avoir à le chercher sur le
 * disque. Les règles sont côté serveur (src/web/botConfig.js) et ne se
 * discutent pas ici : ce module affiche ce qu'on lui envoie, et grise ce que
 * le serveur refuserait.
 *
 * Trois choses à savoir en le lisant :
 *
 *  - **Les secrets ne reviennent jamais.** Le serveur dit seulement s'ils sont
 *    renseignés. Le champ reste vide ; y écrire remplace, « Effacer » vide.
 *
 *  - **Seuls les champs touchés partent.** Renvoyer tout le formulaire ferait
 *    réécrire des lignes qu'on n'a pas voulu changer — et échouer sur un champ
 *    resté grisé parce qu'on n'est pas devant la machine.
 *
 *  - **Rien ne s'applique avant le redémarrage.** Le bot lit son `.env` au
 *    lancement. La section le dit tant que le fichier et le bot divergent, et
 *    propose de redémarrer.
 */

window.MusicPlayer = window.MusicPlayer || {};

(function () {
    'use strict';

    const zone = document.getElementById('config-zone');
    if (!zone) return;

    /** Dernier état reçu du serveur. */
    let current = null;
    /** Champs en cours d'édition : clé → { input, field, cleared }. */
    let controls = new Map();
    /** Message affiché sous le bouton, et sa nature. */
    let status = null;
    /** Le port choisi, quand il change : l'adresse du tableau de bord suivra. */
    let pendingPort = null;
    let submittedPort = null;
    let busy = false;

    const FALLBACK = {
        config_intro: 'Le contenu du fichier .env du bot. Les changements s\'appliquent au prochain redémarrage.',
        config_remote_note: 'Les réglages grisés ne se changent que depuis l\'ordinateur où tourne le bot : ils peuvent couper l\'accès au tableau de bord ou ouvrir des dossiers du disque.',
        config_loading: 'Chargement…',
        config_group_discord: 'Application Discord',
        config_group_sharing: 'Partage et connexion',
        config_group_network: 'Serveur web',
        config_group_media: 'Fichiers',
        config_group_logs: 'Journaux',
        config_DISCORD_TOKEN_label: 'Jeton du bot',
        config_DISCORD_TOKEN_hint: 'Portail développeur Discord, onglet « Bot ».',
        config_DISCORD_CLIENT_ID_label: 'Identifiant de l\'application',
        config_DISCORD_CLIENT_ID_hint: 'Portail développeur Discord, onglet « Informations générales ».',
        config_DISCORD_CLIENT_SECRET_label: 'Secret OAuth2',
        config_DISCORD_CLIENT_SECRET_hint: 'Onglet « OAuth2 » du portail. Sans lui, personne ne peut se connecter avec son compte Discord.',
        config_PUBLIC_URL_label: 'Adresse fixe',
        config_PUBLIC_URL_hint: 'Laissez vide pour le partage rapide. Renseignée, déclarez cette adresse suivie de /auth/discord/callback dans le portail Discord.',
        config_CLOUDFLARE_TUNNEL_TOKEN_label: 'Jeton du tunnel nommé',
        config_CLOUDFLARE_TUNNEL_TOKEN_hint: 'Pour une adresse fixe sur votre propre domaine, avec l\'adresse fixe ci-dessus.',
        config_OAUTH_RELAY_URL_label: 'Relais de connexion',
        config_OAUTH_RELAY_URL_hint: 'Vide : le relais par défaut. « off » : la connexion Discord ne marche que depuis cet ordinateur.',
        config_HOST_label: 'Accès au tableau de bord',
        config_HOST_hint: 'Ouvert au réseau local, il est joignable depuis un téléphone ou un autre ordinateur de la maison.',
        'config_HOST_option_127.0.0.1': 'Cet ordinateur seulement',
        'config_HOST_option_0.0.0.0': 'Tout le réseau local',
        config_PORT_label: 'Port',
        config_PORT_hint: '3000 par défaut. Après le redémarrage, le tableau de bord change d\'adresse.',
        config_MEDIA_ROOTS_label: 'Dossiers de musique',
        config_MEDIA_ROOTS_hint: 'Les dossiers que le bot a le droit de lire, séparés par « ; ». Exemple : D:\\Musique;E:\\Films',
        config_MAX_UPLOAD_MB_label: 'Taille maximale d\'un envoi (Mo)',
        config_MAX_UPLOAD_MB_hint: '1024 par défaut.',
        config_MAX_CACHE_MB_label: 'Cache de préchargement (Mo)',
        config_MAX_CACHE_MB_hint: '2048 par défaut.',
        config_LOG_LEVEL_label: 'Niveau de détail',
        config_LOG_LEVEL_hint: 'Ce que les journaux retiennent.',
        config_LOG_LEVEL_option_debug: 'Tout (débogage)',
        config_LOG_LEVEL_option_info: 'Informations',
        config_LOG_LEVEL_option_warn: 'Avertissements',
        config_LOG_LEVEL_option_error: 'Erreurs seulement',
        config_LOG_RETENTION_label: 'Journaux conservés',
        config_LOG_RETENTION_hint: 'Un par démarrage, 20 par défaut.',
        config_option_default: 'Par défaut',
        config_secret_set: 'Renseigné — saisir pour remplacer',
        config_secret_unset: 'Non renseigné',
        config_secret_clear: 'Effacer',
        config_secret_cleared: 'Sera effacé à l\'enregistrement',
        config_secret_keep: 'Garder',
        config_save: 'Enregistrer',
        config_saved: 'Enregistré dans le fichier .env.',
        config_nothing: 'Aucun changement à enregistrer.',
        config_fix_errors: 'Rien n\'a été enregistré : corrigez les champs signalés.',
        config_restart_needed: 'Le bot tourne encore avec l\'ancienne configuration.',
        config_restart: 'Redémarrer maintenant',
        config_file: 'Fichier',
        config_error_invalid_token: 'Ce n\'est pas un jeton de bot.',
        config_error_invalid_client_id: 'Un identifiant d\'application est un nombre de 17 à 21 chiffres.',
        config_error_invalid_url: 'Une adresse http ou https sans chemin, par exemple https://musique.exemple.fr.',
        config_error_invalid_relay: '« off », ou une adresse https.',
        config_error_invalid_number: 'Un nombre entier.',
        config_error_out_of_range: 'Hors des limites permises.',
        config_error_required: 'Ce réglage ne peut pas être vide.',
        config_error_local_only: 'Ne se change que depuis l\'ordinateur du bot.',
        config_error_invalid_value: 'Valeur refusée.',
        config_error_write_failed: 'Le fichier .env n\'a pas pu être écrit.',
        config_error_unknown: 'Réglage inconnu.',
    };

    function t(key) {
        const value = typeof window.MusicPlayer.t === 'function' ? window.MusicPlayer.t(key) : key;
        return value && value !== key ? value : (FALLBACK[key] || key);
    }

    function isMaster() {
        const role = document.documentElement.dataset.role;
        return !role || role === 'master';
    }

    function make(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    /* ═════════════════════ Champs ═════════════════════ */

    function inputFor(field, locked) {
        let input;
        if (field.kind === 'select') {
            input = make('select', 'styled-select header-select config-input');
            const options = field.options.slice();
            if (!options.includes(field.value)) options.unshift(field.value);
            for (const value of options) {
                const option = make('option');
                option.value = value;
                const key = `config_${field.key}_option_${value}`;
                const label = t(key);
                option.textContent = value === '' ? t('config_option_default') : (label === key ? value : label);
                input.appendChild(option);
            }
            input.value = field.value;
        } else {
            input = make('input', 'modal-input config-input');
            input.autocomplete = 'off';
            input.spellcheck = false;
            if (field.kind === 'secret') {
                input.type = 'password';
                input.placeholder = field.set ? t('config_secret_set') : t('config_secret_unset');
            } else if (field.kind === 'number') {
                input.type = 'text';
                input.inputMode = 'numeric';
                input.value = field.value;
                if (field.placeholder) input.placeholder = field.placeholder;
            } else {
                input.type = field.kind === 'url' ? 'url' : 'text';
                input.value = field.value;
            }
        }
        input.id = `config-${field.key}`;
        input.disabled = locked;
        return input;
    }

    function row(field) {
        const locked = field.local && !current.fromThisMachine;
        const wrap = make('div', 'config-field');
        if (locked) wrap.classList.add('is-locked');

        const label = make('label', 'config-label', t(`config_${field.key}_label`));
        const input = inputFor(field, locked);
        label.htmlFor = input.id;
        wrap.appendChild(label);

        const line = make('div', 'config-line');
        line.appendChild(input);
        const entry = { input, field, cleared: false };

        // Le menu du tableau de bord plutôt que celui du système, comme les
        // autres listes des paramètres. Construit une fois le <select> en
        // place : CustomSelect se pose juste après lui, et reste branché sur
        // lui — c'est sa valeur qu'on relit à l'enregistrement.
        if (field.kind === 'select' && typeof window.MusicPlayer.CustomSelect === 'function') {
            new window.MusicPlayer.CustomSelect(input);
        }

        // Effacer un secret : on ne peut pas le vider à la main, le champ
        // l'est déjà. Un bouton dit ce qui va se passer, et se reprend.
        if (field.kind === 'secret' && field.set && !field.required && !locked) {
            const clear = make('button', 'config-clear', t('config_secret_clear'));
            clear.type = 'button';
            clear.addEventListener('click', () => {
                entry.cleared = !entry.cleared;
                input.value = '';
                input.disabled = entry.cleared;
                input.placeholder = entry.cleared ? t('config_secret_cleared') : t('config_secret_set');
                clear.textContent = entry.cleared ? t('config_secret_keep') : t('config_secret_clear');
            });
            line.appendChild(clear);
        }
        wrap.appendChild(line);

        let hint = t(`config_${field.key}_hint`);
        if (field.kind === 'number' && field.min !== undefined) hint += ` (${field.min}–${field.max})`;
        wrap.appendChild(make('span', 'setting-item-hint config-hint', hint));
        const error = make('span', 'config-error');
        error.hidden = true;
        wrap.appendChild(error);
        entry.error = error;

        controls.set(field.key, entry);
        return wrap;
    }

    /** Ce qui a changé, clé → valeur ('' pour effacer). */
    function changes() {
        const out = {};
        for (const [key, entry] of controls) {
            const { input, field } = entry;
            if (input.disabled && !entry.cleared) continue;
            if (field.kind === 'secret') {
                if (entry.cleared) out[key] = '';
                else if (input.value.trim()) out[key] = input.value.trim();
            } else if (input.value.trim() !== String(field.value).trim()) {
                out[key] = input.value.trim();
            }
        }
        return out;
    }

    function showErrors(errors) {
        for (const [key, entry] of controls) {
            const code = errors && errors[key];
            entry.error.hidden = !code;
            entry.error.textContent = code ? t(`config_error_${code}`) : '';
            entry.input.classList.toggle('has-error', Boolean(code));
        }
    }

    /* ═════════════════════ Rendu ═════════════════════ */

    function render() {
        zone.textContent = '';
        controls = new Map();

        if (!current) {
            zone.appendChild(make('p', 'setting-item-hint', t('config_loading')));
            return;
        }

        zone.appendChild(make('p', 'config-intro', t('config_intro')));
        if (!current.fromThisMachine && current.fields.some((f) => f.local)) {
            zone.appendChild(make('p', 'config-note', t('config_remote_note')));
        }

        let group = null;
        let box = null;
        for (const field of current.fields) {
            if (field.group !== group) {
                group = field.group;
                box = make('div', 'setting-item-group config-group');
                box.appendChild(make('h4', 'setting-sub-title', t(`config_group_${group}`)));
                zone.appendChild(box);
            }
            box.appendChild(row(field));
        }

        const actions = make('div', 'maintenance-actions config-actions');
        const save = make('button', 'maint-btn primary', t('config_save'));
        save.type = 'button';
        save.disabled = busy;
        save.addEventListener('click', submit);
        actions.appendChild(save);
        zone.appendChild(actions);

        if (status) {
            zone.appendChild(make('p', `config-status is-${status.kind}`, status.text));
        }

        if (current.restartNeeded) {
            const banner = make('div', 'config-restart');
            banner.appendChild(make('span', '', t('config_restart_needed')));
            const restart = make('button', 'maint-btn', t('config_restart'));
            restart.type = 'button';
            restart.addEventListener('click', restartBot);
            banner.appendChild(restart);
            zone.appendChild(banner);
        }

        if (current.file) {
            const file = make('p', 'setting-item-hint config-file');
            file.appendChild(document.createTextNode(`${t('config_file')} : `));
            file.appendChild(make('code', '', current.file));
            zone.appendChild(file);
        }
    }

    /* ═════════════════════ Gestes ═════════════════════ */

    function submit() {
        const values = changes();
        if (!Object.keys(values).length) {
            status = { kind: 'info', text: t('config_nothing') };
            showErrors({});
            render();
            return;
        }
        submittedPort = values.PORT || null;
        busy = true;
        window.MusicPlayer.sendWS({ type: 'configUpdate', data: { values } });
    }

    /**
     * Redémarre le bot, et suit le tableau de bord s'il change de port.
     *
     * L'écran de redémarrage est celui de toujours : le serveur prévient tous
     * les onglets. Seul le changement de port demande quelque chose de plus —
     * l'onglet guetterait sinon l'ancienne adresse indéfiniment.
     */
    function restartBot() {
        window.MusicPlayer.sendWS({ type: 'restartBot' });
        if (!pendingPort || String(pendingPort) === (window.location.port || '')) return;

        const target = `${window.location.protocol}//${window.location.hostname}:${pendingPort}`;
        const started = Date.now();
        const probe = () => {
            fetch(`${target}/favicons/favicon-glassmorphism.svg`, { mode: 'no-cors', cache: 'no-store' })
                .then(() => { window.location.href = `${target}${window.location.pathname}`; })
                .catch(() => {
                    if (Date.now() - started < 120000) setTimeout(probe, 1500);
                });
        };
        setTimeout(probe, 2500);
    }

    /* ═════════════════════ Entrées ═════════════════════ */

    /** Appelé par le routeur de messages à chaque réponse du serveur. */
    window.MusicPlayer.onConfigState = function (data) {
        busy = false;
        const result = data && data.result;

        // Refusé : on garde ce que l'utilisateur a saisi, et on lui montre où.
        if (result && !result.ok && controls.size) {
            current = { ...current, restartNeeded: data.restartNeeded };
            status = {
                kind: 'error',
                text: result.errors && result.errors._ ? t(`config_error_${result.errors._}`) : t('config_fix_errors'),
            };
            const errors = result.errors;
            const kept = new Map(controls);
            render();
            for (const [key, entry] of controls) {
                const before = kept.get(key);
                if (before && !before.input.disabled) entry.input.value = before.input.value;
            }
            showErrors(errors);
            return;
        }

        current = data || null;
        if (result && result.ok) {
            status = result.saved.length ? { kind: 'ok', text: t('config_saved') } : { kind: 'info', text: t('config_nothing') };
            if (submittedPort && result.saved.includes('PORT')) pendingPort = submittedPort;
        }
        render();
    };

    /** Demandé à chaque ouverture des paramètres : le fichier a pu changer à la main. */
    window.MusicPlayer.refreshConfig = function () {
        if (!isMaster() || typeof window.MusicPlayer.sendWS !== 'function') return;
        status = null;
        window.MusicPlayer.sendWS({ type: 'configState' });
    };

    const opener = document.getElementById('btn-open-settings');
    if (opener) opener.addEventListener('click', () => window.MusicPlayer.refreshConfig());

    render();
})();
