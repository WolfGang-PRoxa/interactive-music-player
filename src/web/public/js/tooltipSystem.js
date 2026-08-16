/* ═══════════════════════════════════════════════════════════════
   Custom Tooltip System
   ═══════════════════════════════════════════════════════════════ */
const TooltipSystem = (() => {
    let tooltipEl = null;
    let showTimer = null;
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
        document.addEventListener('mousedown', hide, { passive: true });
        document.addEventListener('wheel', hide, { passive: true });
        document.addEventListener('keydown', hide, { passive: true });

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
        if (currentTarget === target) {
            hide();
            currentTarget = null;
        }
    }

    function show(target) {
        let text = target.getAttribute('data-tooltip');
        const i18nKey = target.getAttribute('data-i18n-tooltip');
        if (i18nKey) {
            if (typeof window.MusicPlayer?.t === 'function') {
                const translated = window.MusicPlayer.t(i18nKey);
                if (translated && translated !== i18nKey) text = translated;
            } else if (typeof t === 'function') {
                const translated = t(i18nKey);
                if (translated && translated !== i18nKey) text = translated;
            }
        }
        if (!text) return;

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
                const duree = holds[holdKey] !== undefined ? parseFloat(holds[holdKey]) : 1.5;
                if (!isNaN(duree)) {
                    // \b en fin de motif : « 3 secondes » ne doit pas être pris
                    // pour une durée en secondes abrégée.
                    text = text.replace(/\d+(?:[.,]\d+)?\s*s\b/gi, `${duree}s`);
                }
            }
        } catch (e) {}

        tooltipEl.textContent = text;
        // Position near cursor
        positionTooltip();
        // Trigger the CSS transition
        tooltipEl.classList.add('visible');
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

    function hide() {
        if (tooltipEl) {
            tooltipEl.classList.remove('visible');
        }
        clearTimeout(showTimer);
    }

    return { init, hide };
})();

if (typeof window !== 'undefined') {
    window.TooltipSystem = TooltipSystem;
}
