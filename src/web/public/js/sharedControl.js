/**
 * sharedControl — Partage du contrôle du bot, côté tableau de bord.
 *
 * Deux rôles, deux moitiés de ce module :
 *
 *   - **le maître** — le compte propriétaire de l'installation — voit un bouton
 *     dans l'en-tête et une fenêtre où il confie, auditeur par auditeur et geste
 *     par geste, ce qu'il veut bien laisser faire ;
 *   - **l'invité** — reconnu par son compte Discord — ne voit pas ce bouton, et
 *     trouve grisé ce qu'on ne lui a pas accordé.
 *
 * **Le grisage ne protège rien.** Il dit à l'invité ce qu'il peut faire, et lui
 * évite de cliquer dans le vide. La barrière est côté serveur, dans
 * src/web/permissions.js, et c'est elle qui refuse pour de bon : la console du
 * navigateur contourne l'une, jamais l'autre.
 *
 * L'état reçu du serveur porte `role`, `permissions`, et pour le maître seul un
 * bloc `sharing` — configuration OAuth, partages en vigueur, carnet des invités
 * avec leur présence, et le catalogue des droits lui-même. Voir `_shareStateFor`
 * dans src/web/WebServer.js.
 *
 * ## Le catalogue ne vit pas ici
 *
 * La liste des droits et leur rangement arrivent du serveur. Les recopier ici
 * ferait deux tables à tenir d'accord, dont une seule refuse réellement : le
 * jour où elles divergeraient, la fenêtre montrerait des cases sans effet, ou
 * tairait des droits bel et bien accordés. Seuls restent en dur les sélecteurs
 * des commandes à griser — eux ne décrivent pas les droits, mais cette page-ci.
 */

window.MusicPlayer = window.MusicPlayer || {};

(function () {
    'use strict';

    /**
     * Commandes du tableau de bord, rangées par droit.
     *
     * Volontairement limitée aux commandes principales : ce qui reste joignable
     * malgré le grisage — un menu contextuel, un glisser-déposer — se heurte au
     * refus du serveur, dont l'invité est averti par une notification. Étendre
     * cette carte améliore le confort, jamais la sécurité.
     */
    const CONTROLS = {
        'playback.transport': ['#btn-play-pause', '#btn-stop'],
        'playback.skip': ['#btn-skip', '#btn-previous'],
        'playback.seek': ['#progress-bar-wrapper'],
        'playback.mode': ['.play-mode-switch'],
        'playback.source': ['#playback-source-select'],
        'playback.speed': ['#speed-pad-container'],
        'playback.mix': ['#mix-enable-toggle', '#mix-options-container'],
        'playback.loudness': ['#lufs-sync-toggle', '#lufs-sync-options'],

        'queue.add': ['#search-form', '#add-target-select'],
        'queue.clear': ['#btn-clear-queue'],
        'queue.history': ['#btn-clear-history'],
        // Le bouton de la carte « En cours de lecture » et son format : tous
        // deux mènent à /api/download, que le serveur garde derrière ce droit.
        'queue.download': ['#download-format-select', '#btn-download-track'],

        'playlists.create': ['#btn-add-playlist'],

        'volume.level': ['#volume-range'],
        'volume.ducking': ['#ducking-enable-toggle', '#ducking-options-container'],
        'volume.quality': [
            '#import-audio-quality-select', '#import-video-quality-select',
            '#btn-player-quality', '#btn-video-quality',
        ],
        'volume.broadcast': ['#broadcast-mode-select'],
        'volume.channel': ['#guild-select'],
    };

    /**
     * Réservé au maître. Ces commandes-là ne sont jamais partagées : elles
     * éteignent le bot, changent sa version, ou le font quitter un serveur.
     */
    const MASTER_CONTROLS = ['#btn-restart-bot'];

    /**
     * Rangement de repli, quand l'état n'est pas encore arrivé.
     *
     * Le catalogue vient du serveur — voir l'en-tête. Celui-ci ne sert qu'à
     * l'instant où la page s'ouvre et où rien n'a encore été reçu : il donne aux
     * rubriques leur ordre, et rien de plus.
     */
    const FALLBACK_GROUPS = ['playback', 'queue', 'playlists', 'volume'];

    /** Libellés de repli, quand la traduction n'est pas encore chargée. */
    const GROUP_FALLBACK = {
        playback: 'Lecture',
        queue: 'File d\'attente',
        playlists: 'Playlists',
        volume: 'Volume et diffusion',
    };

    /** Libellés de repli des droits, dans la langue du fichier source. */
    const ACTION_FALLBACK = {
        'playback.transport': 'Lire, mettre en pause, arrêter',
        'playback.skip': 'Piste suivante et précédente',
        'playback.seek': 'Se déplacer dans la piste',
        'playback.mode': 'Mode de lecture (boucle, aléatoire)',
        'playback.source': 'Choisir la source à jouer',
        'playback.speed': 'Vitesse de lecture',
        'playback.mix': 'Enchaînements et transitions',
        'playback.loudness': 'Harmonisation du volume',

        'queue.add': 'Ajouter une piste',
        'queue.playNow': 'Lire immédiatement',
        'queue.remove': 'Retirer une piste',
        'queue.reorder': 'Réordonner la file',
        'queue.history': 'Effacer l\'historique',
        'queue.download': 'Télécharger sur le disque du bot',
        'queue.clear': 'Vider la file',

        'playlists.create': 'Créer une playlist',
        'playlists.addTrack': 'Ajouter une piste à une playlist',
        'playlists.removeTrack': 'Retirer une piste d\'une playlist',
        'playlists.reorderTracks': 'Réordonner les pistes',
        'playlists.rename': 'Renommer une playlist',
        'playlists.organise': 'Réordonner les playlists',
        'playlists.transitions': 'Aiguillages et transitions',
        'playlists.delete': 'Supprimer une playlist',

        'volume.level': 'Volume principal',
        'volume.ducking': 'Atténuation vocale',
        'volume.quality': 'Qualité audio et vidéo',
        'volume.trackGain': 'Gain par piste',
        'volume.broadcast': 'Mode de diffusion',
        'volume.channel': 'Changer de salon vocal',
    };

    /** Libellés de repli des rôles tout faits. */
    const PRESET_FALLBACK = {
        listener: 'Auditeur',
        dj: 'DJ',
        cohost: 'Co-hôte',
    };

    let role = 'master';
    let permissions = null;
    let sharing = null;

    /**
     * Ce que le maître vient de cocher, en attendant que le serveur le confirme.
     *
     * Un aller-retour dure quelques dizaines de millisecondes, pendant
     * lesquelles l'état diffusé porte encore les droits d'avant : redessiner
     * sans mémoire remettrait l'interrupteur dans sa position initiale, sous le
     * doigt de celui qui vient de le pousser.
     *
     * L'entrée est effacée dès que le serveur répond la même chose — voir
     * `settle`. Sans cela, elle recouvrirait indéfiniment l'état réel, et une
     * modification faite depuis un autre onglet ne s'afficherait jamais ici.
     *
     * @type {Map<string, object>}
     */
    const inFlight = new Map();

    /** Rubriques dépliées, par personne : « userId » ou « userId:groupe ». */
    const unfolded = new Set();

    function el(id) {
        return document.getElementById(id);
    }

    function t(key, fallback) {
        const translated = typeof window.MusicPlayer.t === 'function' ? window.MusicPlayer.t(key) : key;
        return translated && translated !== key ? translated : fallback;
    }

    function toast(message) {
        if (typeof window.MusicPlayer.showToast === 'function') window.MusicPlayer.showToast(message);
    }

    /* ═════════════════════ Le catalogue reçu du serveur ═════════════════════ */

    /** Les rubriques, dans l'ordre du serveur. */
    function groups() {
        return sharing?.catalogue?.groups || FALLBACK_GROUPS;
    }

    /** Les droits d'une rubrique, dans l'ordre du serveur. */
    function actionsOf(group) {
        return sharing?.catalogue?.actions?.[group] || [];
    }

    /** Tous les droits, toutes rubriques confondues. */
    function allActions() {
        return groups().reduce((acc, group) => acc.concat(actionsOf(group)), []);
    }

    /** Les rôles tout faits, dans l'ordre du serveur. */
    function presets() {
        return sharing?.catalogue?.presets || {};
    }

    /** Le nom du libellé d'un droit : `queue.add` → `share_action_queue_add`. */
    function actionKey(action) {
        return `share_action_${action.replace(/\./g, '_')}`;
    }

    /**
     * Ce jeu de droits est-il exactement un rôle tout fait ?
     *
     * Le même raisonnement que `matchPreset` côté serveur, et pour la même
     * raison : rallumer la pastille du rôle quand la fenêtre rouvre, plutôt que
     * d'annoncer « personnalisé » pour un invité qu'on venait de nommer DJ.
     */
    function presetOf(rights) {
        const actions = allActions();
        if (!actions.some((a) => rights[a])) return null;

        for (const [name, keys] of Object.entries(presets())) {
            const reference = new Set(keys);
            if (actions.every((a) => Boolean(rights[a]) === reference.has(a))) return name;
        }
        return null;
    }

    /* ═════════════════════ Grisage chez l'invité ═════════════════════ */

    /**
     * Applique — ou retire — le voile sur une commande.
     *
     * L'infobulle du refus remplace celle d'origine, qui est mise de côté pour
     * être restituée si le droit est accordé plus tard. L'élément reste
     * survolable — c'est `bindLock()` qui arrête les gestes, pas un
     * `pointer-events: none` qui emporterait l'infobulle avec le clic.
     */
    function mark(element, denied, reason) {
        if (!element) return;

        if (!denied) {
            if (element.classList.contains('perm-denied')) {
                element.classList.remove('perm-denied');
                // Ne restituer que ce qu'on avait soi-même remplacé.
                if (element.dataset.permTooltipAvant !== undefined) {
                    if (element.dataset.permTooltipAvant) element.dataset.tooltip = element.dataset.permTooltipAvant;
                    else delete element.dataset.tooltip;
                    delete element.dataset.permTooltipAvant;
                }
            }
            return;
        }

        if (!element.classList.contains('perm-denied')) {
            element.dataset.permTooltipAvant = element.dataset.tooltip || '';
            element.classList.add('perm-denied');
        }
        element.dataset.tooltip = reason;
    }

    /**
     * Ce qu'il faut voiler pour qu'une commande le soit vraiment.
     *
     * Un menu déroulant n'est pas le `<select>` que désigne la carte : celui-ci
     * est masqué par js/customSelect.js, qui insère à côté de lui le menu qu'on
     * voit et qu'on clique. Le voile posé sur le seul `<select>` ne se voyait
     * donc pas, et ne retenait rien — `bindLock` cherche `.perm-denied` parmi
     * les ancêtres de la cible, et le menu visible est un voisin. Un invité
     * sans droit ouvrait la liste, choisissait, et n'apprenait le refus qu'au
     * retour du serveur.
     *
     * Le menu est cherché à chaque passage plutôt qu'une fois pour toutes : il
     * est construit par app.js, qui peut passer après le premier voile.
     */
    function targetsOf(element) {
        const custom = element._customSelect && element._customSelect.container;
        return custom ? [element, custom] : [element];
    }

    /** Repasse sur toutes les commandes et accorde le voile aux droits courants. */
    function applyRights() {
        const isMaster = role === 'master';
        const reason = t('perm_denied_tooltip', 'Droit non accordé par le maître de la session');
        const masterReason = t('perm_master_only_tooltip', 'Réservé au maître de la session');

        for (const [action, selectors] of Object.entries(CONTROLS)) {
            const denied = isMaster ? false : !(permissions && permissions[action]);
            for (const selector of selectors) {
                document.querySelectorAll(selector).forEach((element) => {
                    for (const target of targetsOf(element)) {
                        mark(target, denied, reason);
                        // Un droit retiré pendant que la liste est ouverte : elle
                        // se referme, sans quoi un dernier choix passerait encore.
                        if (denied) target.classList.remove('open');
                    }
                });
            }
        }

        for (const selector of MASTER_CONTROLS) {
            document.querySelectorAll(selector).forEach((element) => {
                mark(element, !isMaster, masterReason);
            });
        }

        // Le bouton de partage n'a de sens que pour qui a quelque chose à
        // partager. `hidden` plutôt qu'une classe : rien à styler pour cela.
        const wrapper = el('share-controls-wrapper');
        if (wrapper) wrapper.hidden = !isMaster;

        document.documentElement.dataset.role = role;
    }

    /**
     * Arrête les gestes visant une commande refusée.
     *
     * En phase de capture, donc avant que le bouton concerné n'entende quoi que
     * ce soit. `pointer-events: none` aurait été plus simple, mais aurait aussi
     * emporté l'infobulle qui explique le refus — l'élément doit rester
     * survolable tout en étant inerte.
     *
     * Le serveur refuserait de toute façon : ce blocage évite seulement à
     * l'invité de croire son geste passé, et au tableau de bord de se peindre
     * un état qu'il n'obtiendra pas.
     */
    function bindLock() {
        const blockedEvents = ['click', 'mousedown', 'pointerdown', 'keydown', 'input', 'change'];

        for (const evtName of blockedEvents) {
            document.addEventListener(evtName, (e) => {
                const denied = e.target && e.target.closest && e.target.closest('.perm-denied');
                if (!denied) return;

                e.preventDefault();
                e.stopPropagation();
                // Un seul avertissement par geste : `click` suit `mousedown`, et
                // deux notifications pour un même clic seraient de trop.
                if (evtName === 'click' || evtName === 'change') window.MusicPlayer.onPermissionDenied();
            }, true);
        }
    }

    /* ═════════════════════ Fenêtre du maître ═════════════════════ */

    /**
     * Auditeurs à présenter, et ce qu'on sait d'eux.
     *
     * Les membres du salon vocal d'abord — ce sont eux qu'on veut inviter. Les
     * invités du carnet ensuite, même absents du salon et même déconnectés :
     * leurs droits restent en vigueur, et il faut pouvoir les leur retirer sans
     * attendre qu'ils reviennent.
     */
    function listeners() {
        const state = window.MusicPlayer.state || {};
        const knownMembers = new Map((sharing?.knownUsers || []).map((u) => [u.userId, u]));
        const grants = sharing?.grants || {};
        const admitted = new Set(sharing?.admitted || []);
        const list = [];
        const seen = new Set();

        /*
         * Le maître ne figure pas dans sa propre liste.
         *
         * Il y apparaissait dès qu'il était dans le salon vocal, avec des cases
         * à cocher pour s'accorder à lui-même des droits qu'il détient déjà.
         * Plus trompeur encore en ouvrant le tableau de bord depuis un second
         * poste : on s'y voit rangé parmi les auditeurs, et l'on croit être
         * devenu son propre invité alors que rien n'a changé.
         */
        const self = state.role === 'master' && state.identity ? state.identity.userId : null;

        for (const member of state.members || []) {
            if (self && member.id === self) continue;
            seen.add(member.id);
            const known = knownMembers.get(member.id);
            list.push({
                userId: member.id,
                displayName: member.displayName,
                avatar: member.avatar || known?.avatar || null,
                authenticated: Boolean(known),
                online: Boolean(known?.online),
                lastSeenAt: known?.lastSeenAt || 0,
                rights: grants[member.id] || null,
                inChannel: true,
            });
        }

        for (const [userId, known] of knownMembers) {
            if (seen.has(userId) || (self && userId === self)) continue;
            // Un invité du carnet absent du salon : on ne le montre que s'il a
            // été admis ou pourvu, sans quoi la liste s'allongerait de tous les
            // passages. Un admis sans droits doit rester visible — c'est là, et
            // nulle part ailleurs, qu'on lui en accordera.
            if (!grants[userId] && !admitted.has(userId)) continue;
            list.push({
                userId,
                displayName: known.displayName || userId,
                avatar: known.avatar,
                authenticated: true,
                online: Boolean(known.online),
                lastSeenAt: known.lastSeenAt || 0,
                rights: grants[userId],
                inChannel: false,
            });
        }

        return list;
    }

    function initial(name) {
        return (name || '?').trim().charAt(0).toUpperCase() || '?';
    }

    /**
     * « il y a douze minutes », en gros.
     *
     * La précision n'a aucun intérêt ici : ce que le maître veut savoir, c'est
     * si la personne est passée tout à l'heure ou le mois dernier. Une minute
     * près ne changerait rien à ce qu'il en fait.
     */
    function sinceLabel(timestamp) {
        if (!timestamp) return '';
        const minutes = Math.floor((Date.now() - timestamp) / 60000);

        if (minutes < 1) return t('share_seen_now', 'à l\'instant');
        if (minutes < 60) return t('share_seen_minutes', 'il y a {n} min').replace('{n}', minutes);

        const hours = Math.floor(minutes / 60);
        if (hours < 24) return t('share_seen_hours', 'il y a {n} h').replace('{n}', hours);

        const days = Math.floor(hours / 24);
        if (days < 30) return t('share_seen_days', 'il y a {n} j').replace('{n}', days);

        return t('share_seen_long', 'il y a longtemps');
    }

    /** La pastille d'avatar d'une personne, image ou initiale. */
    function avatarOf(person, extraClass = '') {
        const className = `share-person-avatar${extraClass ? ` ${extraClass}` : ''}`;

        if (person.avatar) {
            const img = document.createElement('img');
            img.className = className;
            img.src = person.avatar;
            img.alt = '';
            return img;
        }

        const circle = document.createElement('div');
        circle.className = className;
        circle.textContent = initial(person.displayName);
        return circle;
    }

    /**
     * Les invités qui attendent une réponse, en tête de liste.
     *
     * Un invité qui suit le lien se nomme avec Discord, puis n'obtient rien : les
     * droits ne s'héritent pas d'une authentification. Il disparaissait alors de
     * l'écran — la liste n'affiche un compte absent du salon vocal que s'il a
     * déjà des droits — et patientait devant un tableau de bord inerte pendant
     * que l'hôte ignorait qu'on frappait à la porte.
     *
     * Deux boutons, et rien d'autre : ce n'est pas le moment de choisir des
     * droits un par un, c'est le moment de dire oui ou non. Le réglage fin vient
     * après, dans la ligne ordinaire où l'invité accepté rejoint les autres.
     */
    function pendingRow(person) {
        const row = document.createElement('div');
        row.className = 'share-pending-row';

        row.appendChild(avatarOf(person));

        const text = document.createElement('div');
        text.className = 'share-pending-text';

        const name = document.createElement('span');
        name.className = 'share-pending-name';
        name.textContent = person.displayName;
        text.appendChild(name);

        const hint = document.createElement('span');
        hint.className = 'share-pending-hint';
        hint.textContent = t('share_pending_hint', 'demande le contrôle du bot');
        text.appendChild(hint);

        row.appendChild(text);

        const accept = document.createElement('button');
        accept.className = 'share-pending-btn accept';
        accept.textContent = t('share_pending_accept', 'Accepter');
        accept.addEventListener('click', () => {
            // Accepter répond à la demande, sans rien accorder : l'invité
            // rejoint la liste ordinaire, où ses droits se cochent ensuite un
            // par un. Ouvrir des droits d'un clic déciderait à la place de
            // l'hôte, et c'est précisément ce qu'on lui demande de faire.
            window.MusicPlayer.sendWS({
                type: 'admitGuest',
                data: { userId: person.userId },
            });
            // La rubrique s'ouvre sur l'invité qu'on vient d'accepter : c'est
            // là qu'on va, et l'y conduire évite un clic de plus pour retrouver
            // quelqu'un dont on vient justement de s'occuper.
            unfolded.add(person.userId);
        });
        row.appendChild(accept);

        const refuse = document.createElement('button');
        refuse.className = 'share-pending-btn refuse';
        refuse.textContent = t('share_pending_refuse', 'Refuser');
        refuse.addEventListener('click', () => {
            // Refuser congédie : droits, admission, sessions et fiche du carnet.
            // L'invité retombe sur la porte d'entrée, qui est explicite, au lieu
            // de rester devant un tableau de bord qui ne répond à rien.
            window.MusicPlayer.sendWS({ type: 'revokeControl', data: { userId: person.userId } });
        });
        row.appendChild(refuse);

        return row;
    }

    /**
     * Envoie un jeu de droits complet, et le retient en attendant la réponse.
     *
     * Toujours l'état entier, jamais une différence : c'est ce que le serveur
     * attend, et cela évite qu'un message perdu laisse les deux côtés en
     * désaccord.
     */
    function grant(userId, rights) {
        inFlight.set(userId, rights);
        window.MusicPlayer.sendWS({
            type: 'shareControl',
            data: { userId, permissions: rights },
        });
        renderModal();
    }

    /**
     * Oublie ce qui est en vol dès que le serveur dit la même chose.
     *
     * Sans cela, la mémoire d'attente recouvrirait l'état réel pour toujours :
     * un droit modifié depuis un autre onglet — ou retiré par le serveur — ne
     * s'afficherait jamais dans celui-ci.
     */
    function settle() {
        const grants = sharing?.grants || {};
        const actions = allActions();

        for (const [userId, wanted] of inFlight) {
            const actual = grants[userId] || {};
            if (actions.every((a) => Boolean(wanted[a]) === Boolean(actual[a]))) {
                inFlight.delete(userId);
            }
        }
    }

    /** Les droits à afficher pour quelqu'un : ce qui est en vol, sinon l'état. */
    function rightsOf(person) {
        return inFlight.get(person.userId) || person.rights || {};
    }

    /** Un interrupteur, du même modèle que ceux du reste du tableau de bord. */
    function toggle(checked, disabled, onChange) {
        const label = document.createElement('label');
        label.className = 'switch switch-mini';

        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = checked;
        box.disabled = disabled;
        box.addEventListener('change', () => onChange(box.checked));

        const rail = document.createElement('span');
        rail.className = 'switch-slider';

        label.appendChild(box);
        label.appendChild(rail);
        return label;
    }

    /**
     * Les trois rôles tout faits, et la mention « personnalisé ».
     *
     * Un rôle n'est pas un niveau de plus dans le modèle : c'est une poignée de
     * cases posée d'un coup. Décocher l'une d'elles l'instant d'après fait
     * passer la ligne en « personnalisé », qui n'est pas un quatrième rôle mais
     * l'absence de rôle.
     */
    function presetRow(person, rights) {
        const bar = document.createElement('div');
        bar.className = 'share-presets';

        const current = presetOf(rights);
        const names = Object.keys(presets());

        for (const name of names) {
            const btn = document.createElement('button');
            btn.className = 'share-preset' + (current === name ? ' is-current' : '');
            btn.textContent = t(`share_preset_${name}`, PRESET_FALLBACK[name] || name);
            btn.disabled = !person.authenticated;
            btn.dataset.tooltip = t(`share_preset_${name}_hint`, '');
            btn.addEventListener('click', () => {
                const next = {};
                for (const action of presets()[name] || []) next[action] = true;
                grant(person.userId, next);
            });
            bar.appendChild(btn);
        }

        const custom = document.createElement('span');
        custom.className = 'share-preset-custom'
            + (current === null && Object.values(rights).some(Boolean) ? ' is-current' : '');
        custom.textContent = t('share_preset_custom', 'personnalisé');
        bar.appendChild(custom);

        return bar;
    }

    /**
     * Une rubrique de droits : son en-tête, son compte, et ses interrupteurs.
     *
     * L'interrupteur de l'en-tête vaut pour toute la rubrique. Il porte trois
     * états et non deux : « rien », « une partie », « tout ». Le laisser mentir
     * dans un sens ou dans l'autre — coché dès le premier droit, ou décoché tant
     * qu'il en manque un — était le plus sûr moyen de croire avoir tout accordé
     * alors qu'il restait une case.
     */
    function groupBlock(person, group, rights) {
        const actions = actionsOf(group);
        const on = actions.filter((a) => rights[a]).length;
        const foldKey = `${person.userId}:${group}`;
        const open = unfolded.has(foldKey);

        const block = document.createElement('div');
        block.className = 'share-group' + (open ? ' is-open' : '');

        const head = document.createElement('div');
        head.className = 'share-group-head';

        const fold = document.createElement('button');
        fold.className = 'share-group-fold';
        fold.setAttribute('aria-expanded', open ? 'true' : 'false');

        const chevron = document.createElement('span');
        chevron.className = 'share-group-chevron';
        chevron.setAttribute('aria-hidden', 'true');
        fold.appendChild(chevron);

        const title = document.createElement('span');
        title.className = 'share-group-name';
        title.textContent = t(`share_group_${group}`, GROUP_FALLBACK[group] || group);
        fold.appendChild(title);

        const count = document.createElement('span');
        count.className = 'share-group-count'
            + (on === 0 ? ' is-none' : (on === actions.length ? ' is-all' : ' is-partial'));
        count.textContent = `${on}/${actions.length}`;
        fold.appendChild(count);

        fold.addEventListener('click', () => {
            if (open) unfolded.delete(foldKey);
            else unfolded.add(foldKey);
            renderModal();
        });
        head.appendChild(fold);

        // Tout ou rien pour la rubrique entière. Une rubrique à moitié accordée
        // bascule vers « tout » : c'est le geste qu'on attend d'un clic sur un
        // interrupteur partiellement rempli.
        const all = on === actions.length;
        const bulk = toggle(all, !person.authenticated, () => {
            const next = { ...rights };
            for (const action of actions) next[action] = !all;
            grant(person.userId, next);
        });
        bulk.classList.add('share-group-bulk');
        if (on > 0 && !all) bulk.classList.add('is-partial');
        head.appendChild(bulk);

        block.appendChild(head);

        if (!open) return block;

        const body = document.createElement('div');
        body.className = 'share-group-body';

        for (const action of actions) {
            const line = document.createElement('div');
            line.className = 'share-action';

            const label = document.createElement('span');
            label.className = 'share-action-name';
            label.textContent = t(actionKey(action), ACTION_FALLBACK[action] || action);
            line.appendChild(label);

            line.appendChild(toggle(Boolean(rights[action]), !person.authenticated, (checked) => {
                grant(person.userId, { ...rights, [action]: checked });
            }));

            body.appendChild(line);
        }

        block.appendChild(body);
        return block;
    }

    /** Construit la ligne d'un auditeur. */
    function listenerRow(person) {
        const rights = rightsOf(person);
        const actions = allActions();
        const total = actions.filter((a) => rights[a]).length;
        const open = unfolded.has(person.userId);

        const row = document.createElement('div');
        row.className = 'share-person'
            + (total ? ' has-grants' : '')
            + (person.authenticated ? '' : ' pending')
            + (open ? ' is-open' : '');
        row.dataset.userId = person.userId;

        /* ── L'en-tête : qui, où, et combien de droits ──────────────── */

        const head = document.createElement('div');
        head.className = 'share-person-head';

        const avatar = avatarOf(person);
        avatar.classList.add(person.online ? 'is-online' : 'is-offline');
        head.appendChild(avatar);

        const identity = document.createElement('div');
        identity.className = 'share-person-identity';

        const name = document.createElement('span');
        name.className = 'share-person-name';
        name.textContent = person.displayName;
        identity.appendChild(name);

        /*
         * Une seule ligne d'état, et trois choses à y dire.
         *
         * « en ligne » l'emporte sur tout : c'est la seule information qui
         * appelle une action tout de suite. Vient ensuite « vu il y a… », pour
         * quelqu'un que l'on connaît mais qui n'est pas là — c'était le trou de
         * l'ancienne fenêtre, où un invité déconnecté disparaissait purement.
         * En dernier « pas encore connecté », pour un membre du salon vocal qui
         * n'a jamais suivi le lien.
         */
        const stateEl = document.createElement('span');
        stateEl.className = 'share-person-state';
        if (person.online) {
            stateEl.classList.add('is-online');
            stateEl.textContent = t('share_state_online', 'en ligne');
        } else if (person.authenticated) {
            stateEl.classList.add('is-offline');
            stateEl.textContent = `${t('share_state_offline', 'hors ligne')}`
                + (person.lastSeenAt ? ` · ${sinceLabel(person.lastSeenAt)}` : '');
        } else {
            stateEl.classList.add('is-stranger');
            stateEl.textContent = t('share_state_pending', 'pas encore connecté');
        }
        identity.appendChild(stateEl);

        if (person.inChannel) {
            const here = document.createElement('span');
            here.className = 'share-person-here';
            here.textContent = t('share_in_channel', 'dans le salon');
            identity.appendChild(here);
        }

        head.appendChild(identity);

        // Regroupés pour passer ensemble à la ligne quand la largeur manque,
        // plutôt que de laisser le chevron seul sous le reste.
        const tools = document.createElement('div');
        tools.className = 'share-person-tools';

        /*
         * Tout retirer, ou tout accorder, sans déplier.
         *
         * Le bouton vivait au pied du détail : hors d'atteinte tant que la ligne
         * restait repliée, si bien que couper les droits de quelqu'un obligeait
         * d'abord à ouvrir ses vingt-neuf interrupteurs. Il remonte ici, et
         * change de sens quand il n'y a plus rien à retirer — grisé, il n'aurait
         * plus servi à rien.
         */
        const none = total === 0;
        const bulk = document.createElement('button');
        bulk.className = 'share-person-btn bulk' + (none ? ' is-grant' : '');
        bulk.textContent = none
            ? t('share_check_all', 'Tout cocher')
            : t('share_clear_rights', 'Tout décocher');
        bulk.dataset.tooltip = none
            ? t('share_check_all_tooltip', 'Accorde tous les droits partageables')
            : t('share_clear_rights_tooltip', 'Retire tous ses droits, sans le retirer de la liste');
        bulk.disabled = !person.authenticated;
        bulk.addEventListener('click', () => {
            const next = {};
            if (none) for (const action of actions) next[action] = true;
            grant(person.userId, next);
        });
        tools.appendChild(bulk);

        const tally = document.createElement('span');
        tally.className = 'share-person-tally' + (total ? ' has-grants' : '');
        tally.textContent = `${total}/${actions.length}`;
        tally.dataset.tooltip = t('share_tally_tooltip', 'Droits accordés');
        tools.appendChild(tally);

        const fold = document.createElement('button');
        fold.className = 'share-person-fold';
        fold.setAttribute('aria-expanded', open ? 'true' : 'false');
        fold.dataset.tooltip = open
            ? t('share_fold', 'Replier')
            : t('share_unfold', 'Régler les droits');
        fold.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" '
            + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
            + '<polyline points="6 9 12 15 18 9"></polyline></svg>';
        fold.addEventListener('click', () => {
            if (open) unfolded.delete(person.userId);
            else unfolded.add(person.userId);
            renderModal();
        });
        tools.appendChild(fold);

        head.appendChild(tools);
        row.appendChild(head);

        if (!open) return row;

        /* ── Le détail, une fois déplié ─────────────────────────────── */

        const panel = document.createElement('div');
        panel.className = 'share-person-panel';

        if (!person.authenticated) {
            // Un membre du salon vocal qui n'a jamais suivi le lien : rien à
            // cocher pour lui, le serveur n'aurait personne à qui accorder quoi
            // que ce soit. Le dire vaut mieux que d'offrir des cases inertes.
            const note = document.createElement('p');
            note.className = 'share-person-note';
            note.textContent = t('share_not_connected_note',
                'Cette personne doit d\'abord se connecter avec son compte Discord. '
                + 'Envoyez-lui le lien ci-dessus.');
            panel.appendChild(note);
        }

        panel.appendChild(presetRow(person, rights));

        const list = document.createElement('div');
        list.className = 'share-groups';
        for (const group of groups()) list.appendChild(groupBlock(person, group, rights));
        panel.appendChild(list);

        /* ── Retirer la personne, pas seulement ses droits ───────────── */

        const footer = document.createElement('div');
        footer.className = 'share-person-actions';

        /*
         * Congédier n'est pas décocher.
         *
         * « Tout décocher », dans l'en-tête, laisse la personne dans la liste,
         * admise et reconnue, prête à recevoir de nouveau des droits d'un clic.
         * « Retirer l'invité » l'efface : droits, admission, sessions ouvertes
         * et fiche du carnet. Elle redevient un inconnu qui devra frapper.
         *
         * L'ancienne fenêtre n'avait qu'une croix pour les deux, et c'était la
         * seconde qu'elle faisait — on croyait décocher, on renvoyait.
         */
        const dismiss = document.createElement('button');
        dismiss.className = 'share-person-btn dismiss';
        dismiss.textContent = t('share_dismiss', 'Retirer l\'invité');
        dismiss.dataset.tooltip = t('share_dismiss_tooltip',
            'Efface ses droits, ferme ses sessions et l\'oublie');
        dismiss.addEventListener('click', () => {
            inFlight.delete(person.userId);
            unfolded.delete(person.userId);
            window.MusicPlayer.sendWS({ type: 'revokeControl', data: { userId: person.userId } });
        });
        footer.appendChild(dismiss);

        panel.appendChild(footer);
        row.appendChild(panel);
        return row;
    }

    /**
     * Nomme le salon qui recevra le lien.
     *
     * « Dans le tchat du salon vocal » désigne un salon sans le dire, et le bot
     * en fréquente plusieurs : on envoyait donc un lien en croyant savoir où.
     * Le nom vient de l'état, où le salon actif et la liste des salons du
     * serveur voyagent déjà — aucun message de plus à inventer.
     *
     * Vide lorsqu'aucun salon n'est actif : mieux vaut une phrase qui s'arrête
     * qu'un nom inventé, et le bouton d'envoi échouerait de toute façon.
     */
    function writeInviteChannel() {
        const cible = el('share-invite-channel');
        if (!cible) return;

        const state = window.MusicPlayer.state || {};
        const salonId = state.selectedVoiceChannelId;
        const serveur = (state.guilds || []).find(g => g.id === state.guildId);
        const salon = salonId
            ? (serveur?.voiceChannels || []).find(c => c.id === salonId)
            : null;

        cible.textContent = salon?.name ? ` « ${salon.name} »` : '';
    }

    /** Redessine la fenêtre de partage. */
    function renderModal() {
        const modal = el('share-modal');
        if (!modal || modal.classList.contains('hidden')) return;

        const warning = el('share-oauth-warning');
        if (warning) {
            const missing = !sharing?.oauthReady;
            warning.classList.toggle('hidden', !missing);
            const reminder = el('share-callback-url');
            if (reminder && sharing?.publicUrl) {
                reminder.textContent = `${sharing.publicUrl}/auth/discord/callback`;
            }
        }

        writeInviteChannel();

        const send = el('btn-send-invite');
        if (send) send.disabled = !sharing?.oauthReady;

        const list = el('share-people-list');
        if (!list) return;

        const people = listeners();
        const waiting = sharing?.pending || [];
        list.innerHTML = '';

        /*
         * Les demandes d'abord, et séparées du reste.
         *
         * Elles appellent une réponse, quand la liste en dessous ne fait que
         * rendre compte. Les mêler ferait passer une question pour un état.
         */
        if (waiting.length) {
            const block = document.createElement('div');
            block.className = 'share-pending-block';

            const title = document.createElement('div');
            title.className = 'share-pending-title';
            title.textContent = t('share_pending_title', 'Demandes en attente');
            block.appendChild(title);

            waiting.forEach((person) => block.appendChild(pendingRow(person)));
            list.appendChild(block);
        }

        if (!people.length && !waiting.length) {
            const empty = document.createElement('div');
            empty.className = 'share-empty';
            empty.textContent = t('share_empty', 'Personne dans le salon vocal.');
            list.appendChild(empty);
            return;
        }

        people.forEach((person) => list.appendChild(listenerRow(person)));
    }

    /**
     * Ce que le bouton de l'en-tête annonce.
     *
     * Deux nombres se disputent la place, et l'un des deux appelle un geste :
     * les invités qui attendent une réponse passent donc devant ceux qui sont
     * déjà pourvus. Un décompte tranquille peut attendre ; quelqu'un derrière la
     * porte, non.
     *
     * La couleur change avec le sens, sans quoi le nombre passerait de « trois
     * personnes ont le contrôle » à « trois personnes le demandent » sans que
     * rien ne le signale.
     */
    function renderBadge() {
        const badge = el('share-badge');
        if (!badge) return;

        const waiting = (sharing?.pending || []).length;
        const granted = Object.keys(sharing?.grants || {}).length;
        const total = waiting || granted;

        badge.textContent = String(total);
        badge.classList.toggle('hidden', total === 0);
        badge.classList.toggle('is-knocking', waiting > 0);
    }

    /* ═════════════════════ Entrées du module ═════════════════════ */

    /**
     * Appelé à chaque état reçu du serveur.
     * @param {object} state
     */
    window.MusicPlayer.applyShareState = function (state) {
        if (!state) return;

        if (state.role) role = state.role;
        if (state.permissions) permissions = state.permissions;
        if (state.sharing) {
            sharing = state.sharing;
            // Ce que le serveur confirme n'a plus à être retenu à part.
            settle();
        }

        applyRights();
        renderBadge();
        renderModal();
    };

    /** Le serveur a refusé une commande : le dire plutôt que de rester muet. */
    window.MusicPlayer.onPermissionDenied = function () {
        toast(t('perm_denied_toast', 'Le maître de la session ne vous a pas accordé ce droit.'));
    };

    /** Le maître vient de tout retirer : l'invité doit le savoir. */
    window.MusicPlayer.onControlRevoked = function () {
        toast(t('perm_revoked_toast', 'Votre accès au lecteur a été retiré.'));
        permissions = {};
        applyRights();
    };

    /**
     * Le bouton dit lui-même que le lien est parti.
     *
     * Le toast répond en haut de l'écran, alors que le regard vient de cliquer
     * ici : un message qui paraît loin du geste laisse un doute — a-t-il
     * seulement pris ? —, et l'on reclique. Le bouton confirme donc sur place,
     * et le toast garde son rôle, dire dans quel salon.
     *
     * Déclenché sur la réponse du serveur, jamais sur le clic : c'est l'envoi
     * qu'on annonce, et il peut échouer. Une confirmation posée au clic
     * mentirait une fois sur deux quand le bot n'a pas le droit d'écrire.
     */
    function flashInviteSent() {
        const btn = el('btn-send-invite');
        if (!btn) return;

        // Relancé alors qu'il s'affiche encore : on repart de zéro, sinon la
        // classe déjà posée ne rejouerait aucune animation.
        btn.classList.remove('is-sent');
        void btn.offsetWidth;
        btn.classList.add('is-sent');

        clearTimeout(btn._sentBack);
        btn._sentBack = setTimeout(() => btn.classList.remove('is-sent'), 1800);
    }

    /** Réponse à une action de partage. */
    window.MusicPlayer.onShareResult = function (data) {
        if (!data) return;

        if (data.ok && data.channelName) {
            flashInviteSent();
            toast(t('share_invite_sent', 'Lien envoyé dans le tchat du salon vocal.'));
            return;
        }

        if (data.ok) return;

        const reasons = {
            oauth_absent: t('share_err_oauth', 'Authentification Discord non configurée.'),
            channel_missing: t('share_err_channel', 'Aucun salon vocal actif.'),
            channel_muted: t('share_err_mute', 'Ce salon n\'accepte pas les messages.'),
            send_denied: t('share_err_send', 'Le bot n\'a pas pu écrire dans ce salon.'),
        };
        toast(reasons[data.reason] || t('share_err_generic', 'Le partage a échoué.'));
    };

    function initShare() {
        const openBtn = el('btn-open-share');
        const closeBtn = el('btn-close-share');
        const modal = el('share-modal');

        if (openBtn && modal) {
            openBtn.addEventListener('click', () => {
                modal.classList.remove('hidden');
                renderModal();
                // L'état du tunnel se demande en ouvrant, jamais en continu.
                if (typeof window.MusicPlayer.refreshTunnel === 'function') {
                    window.MusicPlayer.refreshTunnel();
                }
            });
        }

        if (closeBtn && modal) {
            closeBtn.addEventListener('click', () => modal.classList.add('hidden'));
        }

        if (modal) {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) modal.classList.add('hidden');
            });
        }

        const send = el('btn-send-invite');
        if (send) {
            send.addEventListener('click', () => {
                window.MusicPlayer.sendWS({ type: 'sendInviteLink', data: {} });
            });
        }

        bindLock();
        applyRights();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initShare);
    } else {
        initShare();
    }
})();
