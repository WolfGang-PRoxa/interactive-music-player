const ALL_LEVELS = ['INFO', 'WARN', 'ERROR', 'SUCCESS', 'DEBUG'];

window.MusicPlayer = window.MusicPlayer || {};
window.MusicPlayer.logsHistory = [];
window.MusicPlayer.activeLogFilters = new Set(ALL_LEVELS);
window.MusicPlayer.highestZIndex = window.MusicPlayer.highestZIndex || 9990;

window.MusicPlayer.bringToFront = function(element) {
    if (!element) return;
    window.MusicPlayer.highestZIndex = (window.MusicPlayer.highestZIndex || 9990) + 1;
    element.style.zIndex = window.MusicPlayer.highestZIndex;
};

function normalizeLevel(level) {
    const l = (level || 'INFO').toUpperCase();
    if (l === 'WARNING' || l === 'WARN') return 'WARN';
    if (l === 'ERR' || l === 'ERROR') return 'ERROR';
    if (l === 'OK' || l === 'SUCCESS') return 'SUCCESS';
    if (l === 'TRACE' || l === 'DEBUG') return 'DEBUG';
    return 'INFO';
}

/* ═══════════════════════════════════════════════════════════════
   Sélection et copie des lignes de log

   Reprend le motif universel des explorateurs de fichiers :
     clic          → sélectionne une ligne (et pose l'ancre)
     Maj+clic      → sélectionne la plage depuis l'ancre
     Ctrl/Cmd+clic → ajoute ou retire une ligne isolée
     Ctrl/Cmd+C    → copie la sélection
     Échap         → désélectionne
   La sélection de texte native reste possible : un glissement qui
   sélectionne du texte n'est jamais interprété comme un clic de sélection.
   ═══════════════════════════════════════════════════════════════ */

/** Ligne servant de point de départ aux sélections par plage. */
let logAnchor = null;

function tr(key, fallback) {
    const t = window.MusicPlayer && window.MusicPlayer.t;
    const value = typeof t === 'function' ? t(key) : null;
    return (value && value !== key) ? value : fallback;
}

function notify(message) {
    if (typeof window.MusicPlayer.showToast === 'function') {
        window.MusicPlayer.showToast(message);
    }
}

/**
 * Copie du texte dans le presse-papiers.
 *
 * L'API Clipboard exige un contexte sécurisé : elle est indisponible lorsque le
 * tableau de bord est consulté par son adresse IP en HTTP (HOST=0.0.0.0). Le
 * repli par zone de texte cachée couvre ce cas.
 */
async function copyText(text) {
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch (e) {
        // On tente le repli ci-dessous
    }
    try {
        const zone = document.createElement('textarea');
        zone.value = text;
        zone.setAttribute('readonly', '');
        zone.style.position = 'fixed';
        zone.style.top = '-1000px';
        zone.style.opacity = '0';
        document.body.appendChild(zone);
        zone.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(zone);
        return ok;
    } catch (e) {
        return false;
    }
}

async function copyLines(lines) {
    if (!lines.length) {
        notify(tr('logs_copy_empty', 'Aucune ligne à copier.'));
        return;
    }
    const ok = await copyText(lines.join('\n'));
    if (ok) {
        notify(lines.length === 1
            ? tr('logs_copied_one', 'Ligne copiée.')
            : `${lines.length} ${tr('logs_copied_many', 'lignes copiées.')}`);
    } else {
        notify(tr('logs_copy_failed', 'Copie impossible dans ce navigateur.'));
    }
}

/** Lignes actuellement affichées, filtres actifs pris en compte. */
function visibleEntries() {
    const container = document.getElementById('logs-terminal-container');
    if (!container) return [];
    return [...container.querySelectorAll('.log-entry:not(.filtered-out)')];
}

function selectedEntries() {
    const container = document.getElementById('logs-terminal-container');
    if (!container) return [];
    return [...container.querySelectorAll('.log-entry.log-selected')];
}

function clearSelection() {
    selectedEntries().forEach(el => el.classList.remove('log-selected'));
}

/** Sélectionne toutes les lignes visibles entre deux bornes, incluses. */
function selectRange(since, until) {
    const visibleOnes = visibleEntries();
    const i = visibleOnes.indexOf(since);
    const j = visibleOnes.indexOf(until);
    if (i === -1 || j === -1) return;

    clearSelection();
    const [start, endIdx] = i <= j ? [i, j] : [j, i];
    for (let k = start; k <= endIdx; k++) {
        visibleOnes[k].classList.add('log-selected');
    }
}

window.MusicPlayer.updateLogsSelectionBar = function() {
    const bar = document.getElementById('logs-selection-bar');
    const counter = document.getElementById('logs-selection-count');
    if (!bar) return;

    const count = selectedEntries().length;
    if (count === 0) {
        bar.classList.add('hidden');
        return;
    }
    bar.classList.remove('hidden');
    if (counter) {
        counter.textContent = count === 1
            ? `1 ${tr('logs_selected_one', 'ligne sélectionnée')}`
            : `${count} ${tr('logs_selected_many', 'lignes sélectionnées')}`;
    }
};

window.MusicPlayer.setupLogsSelection = function() {
    const container = document.getElementById('logs-terminal-container');
    if (!container || container.dataset.selectionReady) return;
    container.dataset.selectionReady = '1';

    const updateBar = window.MusicPlayer.updateLogsSelectionBar;

    // Maj+clic étendrait la sélection de texte native : on la neutralise ici,
    // au moment du mousedown, avant que le navigateur ne s'en saisisse.
    container.addEventListener('mousedown', (e) => {
        if (e.shiftKey && e.target.closest('.log-entry')) e.preventDefault();
    });

    container.addEventListener('click', async (e) => {
        const copyButton = e.target.closest('.log-copy-btn');
        if (copyButton) {
            e.stopPropagation();
            const entryEl = copyButton.closest('.log-entry');
            if (entryEl) await copyLines([entryEl.dataset.copy || entryEl.textContent.trim()]);
            return;
        }

        const entryEl = e.target.closest('.log-entry');
        if (!entryEl) return;

        // Un glissement ayant sélectionné du texte n'est pas un clic de sélection
        const textSelection = window.getSelection();
        if (textSelection && textSelection.toString().trim().length > 0) return;

        if (e.shiftKey && logAnchor && logAnchor.isConnected) {
            selectRange(logAnchor, entryEl);
        } else if (e.ctrlKey || e.metaKey) {
            entryEl.classList.toggle('log-selected');
            logAnchor = entryEl;
        } else {
            const onlyAndAlreadySelected = entryEl.classList.contains('log-selected')
                && selectedEntries().length === 1;
            clearSelection();
            if (!onlyAndAlreadySelected) {
                entryEl.classList.add('log-selected');
                logAnchor = entryEl;
            }
        }
        updateBar();
    });

    // Raccourcis clavier
    document.addEventListener('keydown', async (e) => {
        if (e.key === 'Escape' && selectedEntries().length > 0) {
            clearSelection();
            updateBar();
            return;
        }
        if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
            const selection = selectedEntries();
            if (selection.length === 0) return;
            // Une sélection de texte native reste prioritaire
            const nativeText = window.getSelection();
            if (nativeText && nativeText.toString().trim().length > 0) return;
            e.preventDefault();
            await copyLines(selection.map(el => el.dataset.copy || el.textContent.trim()));
        }
    });

    const btnCopySelection = document.getElementById('btn-copy-selection');
    if (btnCopySelection) {
        btnCopySelection.addEventListener('click', async () => {
            await copyLines(selectedEntries().map(el => el.dataset.copy || el.textContent.trim()));
        });
    }

    const btnClearSelection = document.getElementById('btn-clear-selection');
    if (btnClearSelection) {
        btnClearSelection.addEventListener('click', () => {
            clearSelection();
            updateBar();
        });
    }

    const btnCopyAll = document.getElementById('btn-copy-logs');
    if (btnCopyAll) {
        btnCopyAll.addEventListener('click', async () => {
            await copyLines(visibleEntries().map(el => el.dataset.copy || el.textContent.trim()));
        });
    }
};

window.MusicPlayer.applyDefaultLogsWindowGeometry = function() {
    const logsWindow = document.getElementById('logs-floating-window');
    if (!logsWindow) return;

    const settings = (window.MusicPlayer.dashboardSettings) || {};
    const defaultPos = settings.logsDefaultPos || { x: 120, y: 120 };
    const defaultSize = settings.logsDefaultSize || { width: 520, height: 320 };

    logsWindow.style.left = `${defaultPos.x}px`;
    logsWindow.style.top = `${defaultPos.y}px`;
    logsWindow.style.width = `${defaultSize.width}px`;
    logsWindow.style.height = `${defaultSize.height}px`;
    logsWindow.style.right = 'auto';
};

window.MusicPlayer.setupFloatingLogsWindow = function() {
    const logsWindow = document.getElementById('logs-floating-window');
    const logsHeader = document.getElementById('logs-window-header');
    const resizeHandle = document.getElementById('logs-window-resize-handle');
    const btnClose = document.getElementById('btn-close-logs-window');
    const btnClear = document.getElementById('btn-clear-logs');
    const logsContainer = document.getElementById('logs-terminal-container');

    if (!logsWindow || !logsHeader) return;

    // Load saved geometry
    try {
        const savedPos = JSON.parse(localStorage.getItem('dashboardLogsWindowPos') || 'null');
        if (savedPos && savedPos.left !== undefined) {
            logsWindow.style.left = `${savedPos.left}px`;
            logsWindow.style.top = `${savedPos.top}px`;
            logsWindow.style.width = `${savedPos.width}px`;
            logsWindow.style.height = `${savedPos.height}px`;
            logsWindow.style.right = 'auto';
        } else {
            window.MusicPlayer.applyDefaultLogsWindowGeometry();
        }
    } catch (e) {
        window.MusicPlayer.applyDefaultLogsWindowGeometry();
    }

    // Close button
    if (btnClose) {
        btnClose.addEventListener('click', () => {
            const toggleLogsSetting = document.getElementById('setting-logs-enable');
            if (toggleLogsSetting) {
                toggleLogsSetting.checked = false;
                toggleLogsSetting.dispatchEvent(new Event('change'));
            } else {
                logsWindow.classList.add('hidden');
            }
        });
    }

    const btnScrollBottom = document.getElementById('btn-scroll-logs-bottom');

    window.MusicPlayer.logsUserScrolledUp = false;

    if (logsContainer) {
        logsContainer.addEventListener('scroll', () => {
            const distanceToBottom = logsContainer.scrollHeight - logsContainer.scrollTop - logsContainer.clientHeight;
            if (distanceToBottom <= 35) {
                window.MusicPlayer.logsUserScrolledUp = false;
                if (btnScrollBottom) btnScrollBottom.classList.add('hidden');
            } else {
                window.MusicPlayer.logsUserScrolledUp = true;
            }
        });
    }

    if (btnScrollBottom && logsContainer) {
        btnScrollBottom.addEventListener('click', () => {
            window.MusicPlayer.logsUserScrolledUp = false;
            logsContainer.scrollTop = logsContainer.scrollHeight;
            btnScrollBottom.classList.add('hidden');
        });
    }

    window.MusicPlayer.setupLogsSelection();

    // Clear logs button
    if (btnClear && logsContainer) {
        btnClear.addEventListener('click', () => {
            logsContainer.innerHTML = '';
            window.MusicPlayer.logsHistory = [];
            window.MusicPlayer.logsUserScrolledUp = false;
            window.MusicPlayer.updateLogsSelectionBar();
            if (btnScrollBottom) btnScrollBottom.classList.add('hidden');
            const emptyDiv = document.createElement('div');
            emptyDiv.className = 'logs-empty';
            emptyDiv.textContent = 'Aucun log enregistré.';
            logsContainer.appendChild(emptyDiv);
        });
    }

    // Multi-Select Filter Buttons Logic
    const filterBtns = logsHeader.querySelectorAll('.log-filter-btn');
    const btnAll = logsHeader.querySelector('.log-filter-btn[data-filter="ALL"]');

    // Make all filter buttons active by default
    filterBtns.forEach(btn => btn.classList.add('active'));

    filterBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const filter = btn.getAttribute('data-filter');

            if (filter === 'ALL') {
                // Master button clicked: activate all levels
                ALL_LEVELS.forEach(lvl => window.MusicPlayer.activeLogFilters.add(lvl));
                filterBtns.forEach(b => b.classList.add('active'));
            } else {
                // Individual toggle level button clicked
                if (window.MusicPlayer.activeLogFilters.has(filter)) {
                    window.MusicPlayer.activeLogFilters.delete(filter);
                    btn.classList.remove('active');
                } else {
                    window.MusicPlayer.activeLogFilters.add(filter);
                    btn.classList.add('active');
                }

                // Update Tous (ALL) button active state
                const allSelected = ALL_LEVELS.every(lvl => window.MusicPlayer.activeLogFilters.has(lvl));
                if (allSelected) {
                    if (btnAll) btnAll.classList.add('active');
                } else {
                    if (btnAll) btnAll.classList.remove('active');
                }
            }

            window.MusicPlayer.applyLogFilters();
        });
    });

    // Opacity Slider Logic
    const opacitySlider = document.getElementById('setting-logs-opacity');
    const opacityVal = document.getElementById('val-setting-logs-opacity');

    function applyOpacity(val) {
        const opacityNum = Math.max(20, Math.min(100, parseInt(val, 10) || 100));
        const alphaRatio = (opacityNum / 100).toFixed(2);
        logsWindow.style.setProperty('--logs-bg-opacity', alphaRatio);
        if (opacitySlider) opacitySlider.value = opacityNum;
        if (opacityVal) opacityVal.textContent = `${opacityNum}%`;
        try {
            localStorage.setItem('dashboardLogsOpacity', opacityNum);
        } catch (e) {}
    }

    try {
        const savedOpacity = localStorage.getItem('dashboardLogsOpacity');
        if (savedOpacity !== null) {
            applyOpacity(savedOpacity);
        } else {
            applyOpacity(100);
        }
    } catch (e) {
        applyOpacity(100);
    }

    if (opacitySlider) {
        opacitySlider.addEventListener('input', (e) => {
            applyOpacity(e.target.value);
        });

        // Un clic dans la zone arme le curseur sans le régler, la molette le
        // règle ensuite depuis tout son cadre — voir js/rangeArm.js.
        if (typeof window.MusicPlayer.armRange === 'function') {
            window.MusicPlayer.armRange(opacitySlider, (e) => {
                // La fenêtre du journal flotte au-dessus du tableau de bord : un
                // cran consommé ici n'a rien à faire remonter à la page, qui
                // défilerait sous elle.
                e.stopPropagation();

                const step = parseInt(opacitySlider.step, 10) || 5;
                const min = parseInt(opacitySlider.min, 10) || 20;
                const max = parseInt(opacitySlider.max, 10) || 100;
                let current = parseInt(opacitySlider.value, 10) || 100;

                if (e.deltaY < 0 || e.deltaX > 0) {
                    current = Math.min(max, current + step);
                } else {
                    current = Math.max(min, current - step);
                }
                applyOpacity(current);
            });
        }
    }

    // Bring to front on click / interaction
    logsWindow.addEventListener('mousedown', () => {
        if (typeof window.MusicPlayer.bringToFront === 'function') {
            window.MusicPlayer.bringToFront(logsWindow);
        }
    });

    // Dragging Logic
    let isDragging = false;
    let dragStartX = 0, dragStartY = 0;
    let windowStartX = 0, windowStartY = 0;

    /**
     * Le glissement et le redimensionnement n'ont pas cours en mode tactile : la
     * fenêtre y est un tiroir ancré au bord droit, que css/touchDrawers.css
     * dimensionne lui-même.
     *
     * Il ne suffit pas de les laisser sans effet visible. Un navigateur mobile
     * simule `mousedown` puis `mouseup` sur un simple appui, et l'appui sur
     * l'en-tête aurait ouvert puis clos un glissement de longueur nulle — au
     * terme duquel la géométrie plein écran du tiroir aurait été enregistrée à
     * la place de celle, patiemment réglée, du bureau.
     */
    function isTouchMode() {
        const deviceMode = window.MusicPlayer.deviceMode;
        return !!(deviceMode && deviceMode.isTouch());
    }

    logsHeader.addEventListener('mousedown', (e) => {
        if (typeof window.MusicPlayer.bringToFront === 'function') {
            window.MusicPlayer.bringToFront(logsWindow);
        }
        if (isTouchMode()) return;
        if (e.target.closest('.logs-control-btn') || e.target.closest('.log-filter-btn') || e.target.closest('.logs-header-opacity')) return;
        isDragging = true;
        dragStartX = e.clientX;
        dragStartY = e.clientY;

        const rect = logsWindow.getBoundingClientRect();
        windowStartX = rect.left;
        windowStartY = rect.top;

        logsWindow.style.right = 'auto';
        logsWindow.style.left = `${windowStartX}px`;
        logsWindow.style.top = `${windowStartY}px`;

        document.body.style.userSelect = 'none';
    });

    // Resizing Logic
    let isResizing = false;
    let resizeStartX = 0, resizeStartY = 0;
    let windowStartW = 0, windowStartH = 0;

    if (resizeHandle) {
        resizeHandle.addEventListener('mousedown', (e) => {
            if (isTouchMode()) return;
            e.preventDefault();
            e.stopPropagation();
            isResizing = true;
            resizeStartX = e.clientX;
            resizeStartY = e.clientY;

            const rect = logsWindow.getBoundingClientRect();
            windowStartW = rect.width;
            windowStartH = rect.height;

            document.body.style.userSelect = 'none';
        });
    }

    window.addEventListener('mousemove', (e) => {
        if (isDragging) {
            const dx = e.clientX - dragStartX;
            const dy = e.clientY - dragStartY;

            const newLeft = Math.max(0, Math.min(window.innerWidth - logsWindow.offsetWidth, windowStartX + dx));
            const newTop = Math.max(0, Math.min(window.innerHeight - logsWindow.offsetHeight, windowStartY + dy));

            logsWindow.style.left = `${newLeft}px`;
            logsWindow.style.top = `${newTop}px`;
        } else if (isResizing) {
            const dx = e.clientX - resizeStartX;
            const dy = e.clientY - resizeStartY;

            const newW = Math.max(300, Math.min(window.innerWidth * 0.9, windowStartW + dx));
            const newH = Math.max(180, Math.min(window.innerHeight * 0.9, windowStartH + dy));

            logsWindow.style.width = `${newW}px`;
            logsWindow.style.height = `${newH}px`;
        }
    });

    window.addEventListener('mouseup', () => {
        if (isDragging || isResizing) {
            isDragging = false;
            isResizing = false;
            document.body.style.userSelect = '';

            try {
                const rect = logsWindow.getBoundingClientRect();
                localStorage.setItem('dashboardLogsWindowPos', JSON.stringify({
                    left: Math.round(rect.left),
                    top: Math.round(rect.top),
                    width: Math.round(rect.width),
                    height: Math.round(rect.height)
                }));
            } catch (err) {}
        }
    });
};

/**
 * Parses and appends a log line to the floating terminal logs window.
 * @param {Object|string} logData - Log object { timestamp, level, text } or string
 */
window.MusicPlayer.appendLogEntry = function(logData) {
    const logsContainer = document.getElementById('logs-terminal-container');
    if (!logsContainer) return;

    // Remove empty placeholder if present
    const emptyDiv = logsContainer.querySelector('.logs-empty');
    if (emptyDiv) emptyDiv.remove();

    let timestamp = '';
    let level = 'INFO';
    let rawText = '';

    if (typeof logData === 'string') {
        rawText = logData;
        timestamp = new Date().toLocaleTimeString('fr-FR', { hour12: false });
    } else if (logData && typeof logData === 'object') {
        timestamp = logData.timestamp || new Date().toLocaleTimeString('fr-FR', { hour12: false });
        level = (logData.level || 'INFO').toUpperCase();
        rawText = logData.text || '';
    }

    // Le niveau est fixé au point d'appel côté serveur (voir src/utils/logger.js).
    // L'ancienne détection par sous-chaînes est retirée : elle reclassait en
    // WARN tout message contenant « attention », y compris à bon escient.
    const normLevel = normalizeLevel(level);

    // Create entry row
    const entryDiv = document.createElement('div');
    entryDiv.className = 'log-entry';
    entryDiv.setAttribute('data-level', normLevel);
    // Texte exact utilisé à la copie, indépendant de la mise en forme HTML
    entryDiv.dataset.copy = `[${timestamp}] [${normLevel}] ${rawText}`;

    // 1. Timestamp
    const timeSpan = document.createElement('span');
    timeSpan.className = 'log-timestamp';
    timeSpan.textContent = `[${timestamp}]`;
    entryDiv.appendChild(timeSpan);

    // 2. Tag (INFO, WARN, ERROR, SUCCESS, DEBUG)
    const tagSpan = document.createElement('span');
    const tagClassMap = {
        'INFO': 'tag-info',
        'WARN': 'tag-warn',
        'ERROR': 'tag-error',
        'SUCCESS': 'tag-success',
        'DEBUG': 'tag-debug'
    };
    tagSpan.className = `log-tag ${tagClassMap[normLevel] || 'tag-info'}`;
    tagSpan.textContent = normLevel;
    entryDiv.appendChild(tagSpan);

    // 3. Formatted Content with bracket module highlighting
    const contentSpan = document.createElement('span');
    contentSpan.className = 'log-content';

    // Regex to format bracketed modules like [WebServer], [Player], etc.
    const formattedText = rawText.replace(/(\[[A-Za-z0-9 _-]+\])/g, '<span class="log-module">$1</span>');
    contentSpan.innerHTML = formattedText;
    entryDiv.appendChild(contentSpan);

    // 4. Bouton de copie, révélé au survol. Le clic est traité par délégation
    //    sur le conteneur : aucun écouteur n'est posé sur les 300 lignes.
    const copyBtn = document.createElement('button');
    copyBtn.className = 'log-copy-btn';
    copyBtn.type = 'button';
    copyBtn.tabIndex = -1;
    copyBtn.setAttribute('aria-label', 'Copier cette ligne');
    copyBtn.setAttribute('data-tooltip', 'Copier cette ligne');
    copyBtn.setAttribute('data-i18n-tooltip', 'tooltip_copy_log_line');
    copyBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">'
        + '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>'
        + '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
    entryDiv.appendChild(copyBtn);

    // Apply active multi-select filters to the new log entry
    const activeSet = window.MusicPlayer.activeLogFilters || new Set(ALL_LEVELS);
    if (!activeSet.has(normLevel)) {
        entryDiv.classList.add('filtered-out');
    }

    // Store in history
    window.MusicPlayer.logsHistory.push({ timestamp, level: normLevel, text: rawText });
    if (window.MusicPlayer.logsHistory.length > 300) {
        window.MusicPlayer.logsHistory.shift();
    }

    const btnScrollBottom = document.getElementById('btn-scroll-logs-bottom');
    const wasScrolledUp = !!window.MusicPlayer.logsUserScrolledUp;

    logsContainer.appendChild(entryDiv);

    // Maintain max 300 elements in DOM
    let pruned = false;
    while (logsContainer.children.length > 300) {
        const removed = logsContainer.firstChild;
        if (removed.classList && removed.classList.contains('log-selected')) pruned = true;
        logsContainer.removeChild(removed);
    }
    // Une ligne sélectionnée a pu disparaître : le compteur doit suivre
    if (pruned) window.MusicPlayer.updateLogsSelectionBar();

    if (!wasScrolledUp) {
        logsContainer.scrollTop = logsContainer.scrollHeight;
        if (btnScrollBottom) btnScrollBottom.classList.add('hidden');
    } else {
        if (btnScrollBottom) btnScrollBottom.classList.remove('hidden');
    }
};

/**
 * Filters visible log entries based on the multi-select active LogFilters set.
 */
window.MusicPlayer.applyLogFilters = function() {
    const logsContainer = document.getElementById('logs-terminal-container');
    if (!logsContainer) return;

    const activeSet = window.MusicPlayer.activeLogFilters || new Set(ALL_LEVELS);

    const entries = logsContainer.querySelectorAll('.log-entry');
    entries.forEach(entry => {
        const rawLevel = entry.getAttribute('data-level') || 'INFO';
        const normLevel = normalizeLevel(rawLevel);

        if (activeSet.has(normLevel)) {
            entry.classList.remove('filtered-out');
        } else {
            entry.classList.add('filtered-out');
            // Une ligne masquée ne doit pas rester dans la sélection : sinon
            // une copie embarquerait des lignes invisibles à l'écran.
            entry.classList.remove('log-selected');
        }
    });

    window.MusicPlayer.updateLogsSelectionBar();

    if (!window.MusicPlayer.logsUserScrolledUp) {
        logsContainer.scrollTop = logsContainer.scrollHeight;
    }
};
