/* ═══════════════════════════════════════════════════════════════
   Custom Tooltip System
   ═══════════════════════════════════════════════════════════════ */
const TooltipSystem = (() => {
    let tooltipEl = null;
    let showTimer = null;
    let hideTimer = null;
    let currentTarget = null;
    let mouseX = 0;
    let mouseY = 0;

    function init() {
        // Create the tooltip element once
        tooltipEl = document.createElement('div');
        tooltipEl.id = 'custom-tooltip';
        document.body.appendChild(tooltipEl);

        // Convert all existing title attributes to data-tooltip
        convertAllTitles();

        // Global mouse tracking for tooltip positioning
        document.addEventListener('mousemove', onMouseMove, { passive: true });

        // Delegate hover events on the entire document
        document.addEventListener('mouseover', onMouseOver, { passive: true });
        document.addEventListener('mouseout', onMouseOut, { passive: true });
        document.addEventListener('mousedown', hideUnlessInside, { passive: true });
        document.addEventListener('wheel', hideUnlessInside, { passive: true });
        document.addEventListener('keydown', hide, { passive: true });

        /*
         * L'infobulle qui porte un bouton se garde sous le pointeur : sans
         * cela, quitter l'élément pour aller la cliquer la ferait disparaître
         * en chemin, et le bouton n'existerait que pour l'œil.
         */
        tooltipEl.addEventListener('mouseenter', () => clearTimeout(hideTimer));
        tooltipEl.addEventListener('mouseleave', () => { hide(); currentTarget = null; });

        // Observe DOM for dynamically-added title attributes → convert them
        const observer = new MutationObserver(mutations => {
            for (const mutation of mutations) {
                // New nodes added
                if (mutation.type === 'childList') {
                    for (const node of mutation.addedNodes) {
                        if (node.nodeType === 1) convertNodeTitles(node);
                    }
                }
                // Attribute changed to 'title'
                if (mutation.type === 'attributes' && mutation.attributeName === 'title') {
                    const el = mutation.target;
                    const titleVal = el.getAttribute('title');
                    if (titleVal) {
                        el.setAttribute('data-tooltip', titleVal);
                        el.removeAttribute('title');
                    }
                }
            }
        });
        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['title']
        });
    }

    function convertAllTitles() {
        document.querySelectorAll('[title]').forEach(el => {
            const val = el.getAttribute('title');
            if (val) {
                el.setAttribute('data-tooltip', val);
                el.removeAttribute('title');
            }
        });
    }

    function convertNodeTitles(node) {
        if (node.hasAttribute && node.hasAttribute('title')) {
            const val = node.getAttribute('title');
            if (val) {
                node.setAttribute('data-tooltip', val);
                node.removeAttribute('title');
            }
        }
        if (node.querySelectorAll) {
            node.querySelectorAll('[title]').forEach(child => {
                const val = child.getAttribute('title');
                if (val) {
                    child.setAttribute('data-tooltip', val);
                    child.removeAttribute('title');
                }
            });
        }
    }

    function onMouseMove(e) {
        mouseX = e.clientX;
        mouseY = e.clientY;
    }

    function onMouseOver(e) {
        const target = e.target.closest('[data-tooltip]');
        if (!target || target === currentTarget) return;
        // Cancel any pending show
        clearTimeout(showTimer);
        hide();
        currentTarget = target;
        const currentSettings = (window.MusicPlayer && window.MusicPlayer.dashboardSettings) || (typeof dashboardSettings !== 'undefined' ? dashboardSettings : {});
        const delaySec = parseFloat(currentSettings.tooltipDelay ?? 0.25);
        showTimer = setTimeout(() => {
            show(target);
        }, Math.round(delaySec * 1000));
    }

    function onMouseOut(e) {
        const target = e.target.closest('[data-tooltip]');
        if (!target) return;
        const related = e.relatedTarget;
        // Check if we moved into a child of the same tooltip target
        if (related && target.contains(related)) return;
        clearTimeout(showTimer);
        if (currentTarget !== target) return;

        if (tooltipEl && tooltipEl.classList.contains('has-action')) {
            // Déjà entré dans l'infobulle : il n'y a rien à fermer.
            if (related && tooltipEl.contains(related)) return;
            // Sinon un court sursis, le temps de l'atteindre en diagonale.
            clearTimeout(hideTimer);
            hideTimer = setTimeout(() => { hide(); currentTarget = null; }, 180);
            return;
        }

        hide();
        currentTarget = null;
    }

    /** Ferme, sauf si le geste vient de l'infobulle elle-même. */
    function hideUnlessInside(e) {
        if (e && e.target && tooltipEl && tooltipEl.contains(e.target)) return;
        hide();
        currentTarget = null;
    }

    /**
     * Le bouton que l'infobulle doit porter, s'il y en a un.
     *
     * Il est déclaré par l'élément survolé : `data-tooltip-action` nomme la
     * clé de traduction du libellé, `data-tooltip-action-call` la fonction de
     * `window.MusicPlayer` à appeler. Les deux sont exigées, et la fonction
     * doit exister — un bouton qui ne fait rien vaut moins que pas de bouton.
     *
     * Relu à chaque affichage, comme le reste : celui qui pose ces attributs
     * les retire quand l'action n'a plus lieu d'être, et l'infobulle suivante
     * s'ouvre sans bouton sans que personne ait à la prévenir.
     */
    function actionOf(target) {
        const labelKey = target.getAttribute('data-tooltip-action');
        const callName = target.getAttribute('data-tooltip-action-call');
        if (!labelKey || !callName) return null;

        const label = translate(labelKey);
        if (!label) return null;

        const run = window.MusicPlayer && window.MusicPlayer[callName];
        if (typeof run !== 'function') return null;

        return { label, run };
    }

    /** La traduction d'une clé, ou rien si le dictionnaire ne la connaît pas. */
    function translate(key) {
        if (typeof window.MusicPlayer?.t === 'function') {
            const translated = window.MusicPlayer.t(key);
            if (translated && translated !== key) return translated;
        } else if (typeof t === 'function') {
            const translated = t(key);
            if (translated && translated !== key) return translated;
        }
        return '';
    }

    function show(target) {
        let text = target.getAttribute('data-tooltip');
        const i18nKey = target.getAttribute('data-i18n-tooltip');
        if (i18nKey) {
            const translated = translate(i18nKey);
            if (translated) text = translated;
        }

        /*
         * La seconde ligne, pour les boutons qui cachent un geste : l'appui
         * long du jour/nuit, celui de GitHub. Une fonctionnalité qu'on ne
         * devine pas n'existe que pour qui l'a codée.
         *
         * Ajoutée ici, à l'affichage, et non collée d'avance dans
         * `data-tooltip` : la traduction ci-dessus remplace le libellé entier à
         * chaque affichage, et `applyLanguage` le récrit à chaque changement de
         * langue. Une phrase composée en amont ne survivait ni à l'une ni à
         * l'autre — elle s'écrivait bien, et ne s'affichait jamais.
         */
        const hintKey = target.getAttribute('data-tooltip-hint');
        if (hintKey) {
            const hint = translate(hintKey);
            if (hint) text = text ? `${text}\n${hint}` : hint;
        }

        const action = actionOf(target);
        if (!text && !action) return;

        // La durée de maintien annoncée est recalculée à chaque affichage : le
        // réglage peut changer sans que la page soit rechargée.
        //
        // Le bouton se déclare via data-hold-key, plutôt que d'être reconnu par
        // son id ou sa classe — un identifiant renommé cassait silencieusement
        // la substitution, ce qui était le cas des boutons de playlist.
        try {
            const holdKey = target.getAttribute('data-hold-key');
            if (holdKey) {
                const ds = (window.MusicPlayer && window.MusicPlayer.dashboardSettings) || {};
                const holds = ds.holdDuration || {};
                const duration = holds[holdKey] !== undefined ? parseFloat(holds[holdKey]) : 1.5;
                if (!isNaN(duration)) {
                    // \b en fin de motif : « 3 secondes » ne doit pas être pris
                    // pour une durée en secondes abrégée.
                    text = text.replace(/\d+(?:[.,]\d+)?\s*s\b/gi, `${duration}s`);
                }
            }
        } catch (e) {}

        renderTooltip(target, text, action);
        // Position near cursor
        positionTooltip();
        // Trigger the CSS transition
        tooltipEl.classList.add('visible');
    }

    /**
     * Compose le contenu de l'infobulle.
     *
     * Le cas courant — du texte seul — repasse par `textContent`, qui vide
     * l'élément et n'interprète rien. C'est ce qui protège la centaine
     * d'infobulles de la page : leur chemin ne change pas d'un iota.
     *
     * L'entête illustrée et le bouton d'action sont deux options, demandées
     * par `data-tooltip-image` et `data-tooltip-action`. Elles sont bâties
     * nœud par nœud plutôt que par `innerHTML` : le nom qui s'y affiche est
     * celui d'un fichier venu d'ailleurs — une balise glissée dans un titre ne
     * doit pas devenir du balisage.
     */
    function renderTooltip(target, text, action) {
        const image = target.getAttribute('data-tooltip-image');
        const title = target.getAttribute('data-tooltip-title');

        tooltipEl.classList.toggle('has-media', !!image);
        tooltipEl.classList.toggle('has-action', !!action);

        if (!image && !action) {
            tooltipEl.textContent = text;
            return;
        }

        tooltipEl.textContent = '';

        if (image) {
            const header = document.createElement('div');
            header.className = 'tooltip-media';

            const img = document.createElement('img');
            img.src = image;
            img.alt = '';

            // Une vignette distante peut avoir disparu depuis qu'on en a reçu
            // l'adresse. Le repli reprend alors la main, plutôt que de laisser
            // l'icône d'image brisée du navigateur au milieu de l'infobulle.
            const fallback = target.getAttribute('data-tooltip-image-fallback');
            if (fallback) {
                img.addEventListener('error', () => { img.src = fallback; }, { once: true });
            }
            header.appendChild(img);

            if (title) {
                const name = document.createElement('span');
                name.className = 'tooltip-media-title';
                name.textContent = title;
                header.appendChild(name);
            }

            tooltipEl.appendChild(header);
        }

        if (text) {
            const body = document.createElement('div');
            body.className = 'tooltip-text';
            body.textContent = text;
            tooltipEl.appendChild(body);
        }

        if (action) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'tooltip-action';
            btn.textContent = action.label;
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                try { action.run(); } catch (err) {}
                hide();
                currentTarget = null;
            });
            tooltipEl.appendChild(btn);
        }
    }

    function positionTooltip() {
        const gap = 12;
        const padding = 8;
        const vpW = window.innerWidth;
        const vpH = window.innerHeight;

        // Temporarily show to measure
        tooltipEl.style.left = '0px';
        tooltipEl.style.top = '0px';
        const rect = tooltipEl.getBoundingClientRect();
        const tw = rect.width;
        const th = rect.height;

        let x = mouseX + gap;
        let y = mouseY + gap;

        // Clamp to viewport right
        if (x + tw + padding > vpW) {
            x = mouseX - tw - gap;
        }
        // Clamp to viewport bottom
        if (y + th + padding > vpH) {
            y = mouseY - th - gap;
        }
        // Clamp left/top
        if (x < padding) x = padding;
        if (y < padding) y = padding;

        tooltipEl.style.left = x + 'px';
        tooltipEl.style.top = y + 'px';
    }

    /**
     * Redessine l'infobulle affichée, si c'est bien celle de cet élément.
     *
     * Le contenu est composé à l'ouverture et n'était jamais repris : une
     * infobulle survolée au moment où le morceau change gardait le nom et la
     * pochette du précédent, et se contredisait donc avec le nombre qu'elle
     * commentait, juste à côté.
     *
     * Elle est replacée du même mouvement : un titre plus long la fait grandir,
     * et une infobulle qui grandit sans être replacée déborde de la fenêtre.
     *
     * L'appelant ne doit la réclamer que sur un vrai changement — repasser ici à
     * chaque état la ferait sauter au curseur une fois par seconde.
     */
    function refresh(target) {
        if (!tooltipEl || currentTarget !== target) return;
        if (!tooltipEl.classList.contains('visible')) return;
        show(target);
    }

    function hide() {
        if (tooltipEl) {
            tooltipEl.classList.remove('visible');
        }
        clearTimeout(showTimer);
        clearTimeout(hideTimer);
    }

    return { init, hide, refresh };
})();

if (typeof window !== 'undefined') {
    window.TooltipSystem = TooltipSystem;
}
