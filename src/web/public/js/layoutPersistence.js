/**
 * Dashboard Orthonormal Grid Layout (48 Columns, Collisions & Card Locking)
 */

window.MusicPlayer = window.MusicPlayer || {};

window.MusicPlayer.cardLayouts = {};
window.MusicPlayer.lockedCards = JSON.parse(localStorage.getItem('dashboardLockedCards') || '{}');

const defaultLayout = {
    'player-card': { colStart: 1, colSpan: 18, rowStart: 1, rowSpan: 16 },
    'search-card': { colStart: 19, colSpan: 16, rowStart: 1, rowSpan: 6 },
    'settings-card': { colStart: 19, colSpan: 16, rowStart: 7, rowSpan: 10 },
    'speakers-card': { colStart: 35, colSpan: 14, rowStart: 1, rowSpan: 16 },
    'ducking-card': { colStart: 1, colSpan: 18, rowStart: 17, rowSpan: 16 },
    'history-card': { colStart: 19, colSpan: 16, rowStart: 17, rowSpan: 16 },
    'queue-card': { colStart: 35, colSpan: 14, rowStart: 17, rowSpan: 16 },
    'mix-card': { colStart: 1, colSpan: 18, rowStart: 33, rowSpan: 8 },
    'playlists-card': { colStart: 19, colSpan: 16, rowStart: 33, rowSpan: 16 }
};

window.MusicPlayer.applyLayoutToCard = function(card, layout) {
    card.style.gridColumn = `${layout.colStart} / span ${layout.colSpan}`;
    card.style.gridRow = `${layout.rowStart} / span ${layout.rowSpan}`;
};

window.MusicPlayer.updateGridCellSize = function() {
    const dashboardGrid = document.getElementById('dashboard-grid');
    if (!dashboardGrid) return;
    const gridWidth = dashboardGrid.clientWidth;
    const gap = 16;
    const cellWidth = (gridWidth - (47 * gap)) / 48;
    if (cellWidth > 0) {
        dashboardGrid.style.setProperty('--grid-cell-size', `${cellWidth}px`);
    }
};

/**
 * Montre ou cache la grille tracée sous les cartes.
 *
 * Le tracé lui-même est entièrement en CSS (`.dashboard-grid::before`, dans
 * layout.css) : il se cale sur `--grid-cell-size`, la variable que pose
 * `updateGridCellSize()` ci-dessus. Il n'y a donc rien à recalculer au
 * redimensionnement de la fenêtre, ni à redessiner au changement de thème.
 *
 * @param {boolean} visible
 */
window.MusicPlayer.applyGridOverlay = function(visible) {
    const dashboardGrid = document.getElementById('dashboard-grid');
    if (!dashboardGrid) return;
    dashboardGrid.classList.toggle('grid-visible', !!visible);
};

window.MusicPlayer.resolveCollisions = function(activeId) {
    const dashboardGrid = document.getElementById('dashboard-grid');
    const cardLayouts = window.MusicPlayer.cardLayouts;
    if (!dashboardGrid) return;

    const firstRects = {};
    dashboardGrid.querySelectorAll('.card').forEach(card => {
        if (card.id !== activeId) {
            firstRects[card.id] = card.getBoundingClientRect();
        }
    });

    const layoutArray = Object.keys(cardLayouts).map(id => ({
        id,
        ...cardLayouts[id]
    }));

    const activeBlock = activeId ? layoutArray.find(b => b.id === activeId) : null;
    const otherBlocks = activeId ? layoutArray.filter(b => b.id !== activeId) : [...layoutArray];

    otherBlocks.sort((a, b) => a.rowStart - b.rowStart);

    function checkCollision(rect1, rect2) {
        return !(
            rect1.colStart + rect1.colSpan <= rect2.colStart ||
            rect2.colStart + rect2.colSpan <= rect1.colStart ||
            rect1.rowStart + rect1.rowSpan <= rect2.rowStart ||
            rect2.rowStart + rect2.rowSpan <= rect1.rowStart
        );
    }

    function checkCollisionsForBlock(block, list) {
        return list.some(item => item.id !== block.id && checkCollision(block, item));
    }

    const resolvedBlocks = activeBlock ? [activeBlock] : [];
    
    otherBlocks.forEach(block => {
        while (checkCollisionsForBlock(block, resolvedBlocks)) {
            const collider = resolvedBlocks.find(item => checkCollision(block, item));
            if (collider) {
                block.rowStart = collider.rowStart + collider.rowSpan;
            }
        }
        resolvedBlocks.push(block);
    });

    resolvedBlocks.sort((a, b) => a.rowStart - b.rowStart);
    const compacted = [];

    resolvedBlocks.forEach(block => {
        if (block.id !== activeId) {
            while (block.rowStart > 1) {
                block.rowStart--;
                if (checkCollisionsForBlock(block, compacted.concat(activeBlock ? [activeBlock] : []))) {
                    block.rowStart++;
                    break;
                }
            }
        }
        compacted.push(block);
    });

    compacted.forEach(item => {
        cardLayouts[item.id].colStart = item.colStart;
        cardLayouts[item.id].rowStart = item.rowStart;
        cardLayouts[item.id].colSpan = item.colSpan;
        cardLayouts[item.id].rowSpan = item.rowSpan;

        const card = document.getElementById(item.id);
        if (card && card.id !== activeId) {
            window.MusicPlayer.applyLayoutToCard(card, cardLayouts[item.id]);
        }
    });

    dashboardGrid.querySelectorAll('.card').forEach(card => {
        if (card.id !== activeId && firstRects[card.id]) {
            const first = firstRects[card.id];
            const last = card.getBoundingClientRect();
            const dx = first.left - last.left;
            const dy = first.top - last.top;

            if (dx !== 0 || dy !== 0) {
                card.style.transition = 'none';
                card.style.transform = `translate(${dx}px, ${dy}px)`;
                card.offsetHeight;
                card.style.transition = 'transform 0.5s cubic-bezier(0.34, 1.56, 0.64, 1)';
                card.style.transform = '';
            }
        }
    });
};

function saveLayout() {
    localStorage.setItem('dashboardLayout', JSON.stringify(window.MusicPlayer.cardLayouts));
}

function getCardCleanTitle(card) {
    const titleEl = card.querySelector('.card-title');
    if (!titleEl) return "Boîte";
    const clone = titleEl.cloneNode(true);
    clone.querySelectorAll('.icon-drag-handle, .card-lock-btn, .card-info-btn').forEach(el => el.remove());
    return clone.textContent.trim();
}

window.MusicPlayer.updateHeaderLockAllButton = function() {
    const btnLockAll = document.getElementById('btn-lock-all');
    const dashboardGrid = document.getElementById('dashboard-grid');
    if (!btnLockAll || !dashboardGrid) return;

    const cards = dashboardGrid.querySelectorAll('.card');
    const totalCards = cards.length;
    if (totalCards === 0) return;

    let lockedCount = 0;
    cards.forEach(card => {
        if (window.MusicPlayer.lockedCards[card.id]) {
            lockedCount++;
        }
    });

    const svgUnlocked = btnLockAll.querySelector('#svg-lock-all-unlocked');
    const svgLocked = btnLockAll.querySelector('#svg-lock-all-locked');

    if (lockedCount === totalCards) {
        if (svgUnlocked) svgUnlocked.classList.add('hidden');
        if (svgLocked) svgLocked.classList.remove('hidden');
        btnLockAll.dataset.tooltip = (window.MusicPlayer.t && window.MusicPlayer.t('tooltip_unlock_all')) || "Déverrouiller toutes les boîtes";
        btnLockAll.classList.add('header-lock-active');
    } else {
        if (svgUnlocked) svgUnlocked.classList.remove('hidden');
        if (svgLocked) svgLocked.classList.add('hidden');
        btnLockAll.dataset.tooltip = (window.MusicPlayer.t && window.MusicPlayer.t('tooltip_lock_all')) || "Verrouiller toutes les boîtes";
        btnLockAll.classList.remove('header-lock-active');
    }
};

window.MusicPlayer.setupCardLocking = function() {
    const dashboardGrid = document.getElementById('dashboard-grid');
    const btnLockAll = document.getElementById('btn-lock-all');
    if (!dashboardGrid) return;
    const cards = dashboardGrid.querySelectorAll('.card');

    cards.forEach(card => {
        const lockBtn = card.querySelector('.card-lock-btn');
        if (!lockBtn) return;

        const iconUnlocked = lockBtn.querySelector('.icon-unlocked');
        const iconLocked = lockBtn.querySelector('.icon-locked');

        if (window.MusicPlayer.lockedCards[card.id]) {
            card.classList.add('card-locked');
            if (iconUnlocked) iconUnlocked.classList.add('hidden');
            if (iconLocked) iconLocked.classList.remove('hidden');
            lockBtn.dataset.tooltip = (window.MusicPlayer.t && window.MusicPlayer.t('tooltip_unlock_card')) || "Déverrouiller la taille et la position";
        } else {
            card.classList.remove('card-locked');
            if (iconUnlocked) iconUnlocked.classList.remove('hidden');
            if (iconLocked) iconLocked.classList.add('hidden');
            lockBtn.dataset.tooltip = (window.MusicPlayer.t && window.MusicPlayer.t('tooltip_lock_card')) || "Verrouiller la taille et la position";
        }

        lockBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();

            const isLocked = !window.MusicPlayer.lockedCards[card.id];
            window.MusicPlayer.lockedCards[card.id] = isLocked;
            localStorage.setItem('dashboardLockedCards', JSON.stringify(window.MusicPlayer.lockedCards));

            const cleanTitle = getCardCleanTitle(card);

            if (isLocked) {
                card.classList.add('card-locked');
                if (iconUnlocked) iconUnlocked.classList.add('hidden');
                if (iconLocked) iconLocked.classList.remove('hidden');
                lockBtn.dataset.tooltip = (window.MusicPlayer.t && window.MusicPlayer.t('tooltip_unlock_card')) || "Déverrouiller la taille et la position";
                if (typeof window.MusicPlayer.showToast === 'function') {
                    window.MusicPlayer.showToast(window.MusicPlayer.t('toast_box_now_locked').replace('{title}', cleanTitle));
                }
            } else {
                card.classList.remove('card-locked');
                if (iconUnlocked) iconUnlocked.classList.remove('hidden');
                if (iconLocked) iconLocked.classList.add('hidden');
                lockBtn.dataset.tooltip = (window.MusicPlayer.t && window.MusicPlayer.t('tooltip_lock_card')) || "Verrouiller la taille et la position";
                if (typeof window.MusicPlayer.showToast === 'function') {
                    window.MusicPlayer.showToast(window.MusicPlayer.t('toast_box_unlocked').replace('{title}', cleanTitle));
                }
            }
            window.MusicPlayer.updateHeaderLockAllButton();
        });
    });

    window.MusicPlayer.updateHeaderLockAllButton();

    if (btnLockAll) {
        btnLockAll.addEventListener('click', (e) => {
            e.preventDefault();
            const totalCards = cards.length;
            if (totalCards === 0) return;

            let lockedCount = 0;
            cards.forEach(card => {
                if (window.MusicPlayer.lockedCards[card.id]) {
                    lockedCount++;
                }
            });

            const shouldLockAll = lockedCount < totalCards;

            cards.forEach(card => {
                window.MusicPlayer.lockedCards[card.id] = shouldLockAll;
                const lockBtn = card.querySelector('.card-lock-btn');
                if (lockBtn) {
                    const iconUnlocked = lockBtn.querySelector('.icon-unlocked');
                    const iconLocked = lockBtn.querySelector('.icon-locked');
                    if (shouldLockAll) {
                        card.classList.add('card-locked');
                        if (iconUnlocked) iconUnlocked.classList.add('hidden');
                        if (iconLocked) iconLocked.classList.remove('hidden');
                        lockBtn.dataset.tooltip = (window.MusicPlayer.t && window.MusicPlayer.t('tooltip_unlock_card')) || "Déverrouiller la taille et la position";
                    } else {
                        card.classList.remove('card-locked');
                        if (iconUnlocked) iconUnlocked.classList.remove('hidden');
                        if (iconLocked) iconLocked.classList.add('hidden');
                        lockBtn.dataset.tooltip = (window.MusicPlayer.t && window.MusicPlayer.t('tooltip_lock_card')) || "Verrouiller la taille et la position";
                    }
                }
            });

            localStorage.setItem('dashboardLockedCards', JSON.stringify(window.MusicPlayer.lockedCards));
            window.MusicPlayer.updateHeaderLockAllButton();

            if (typeof window.MusicPlayer.showToast === 'function') {
                if (shouldLockAll) {
                    window.MusicPlayer.showToast(window.MusicPlayer.t('toast_all_boxes_locked'));
                } else {
                    window.MusicPlayer.showToast(window.MusicPlayer.t('toast_all_boxes_unlocked'));
                }
            }
        });
    }
};

let isLayoutPersistenceInit = false;

window.MusicPlayer.initLayoutPersistence = function() {
    if (isLayoutPersistenceInit) return;
    const dashboardGrid = document.getElementById('dashboard-grid');
    if (!dashboardGrid) return;
    isLayoutPersistenceInit = true;

    const customDefaultLayout = localStorage.getItem('dashboardDefaultLayout');
    if (customDefaultLayout) {
        try {
            const parsed = JSON.parse(customDefaultLayout);
            Object.keys(parsed).forEach(key => {
                defaultLayout[key] = { ...parsed[key] };
            });
        } catch (err) {}
    }

    const savedLayout = localStorage.getItem('dashboardLayout') || localStorage.getItem('dashboardDefaultLayout');
    if (savedLayout) {
        try {
            window.MusicPlayer.cardLayouts = JSON.parse(savedLayout);

            if (window.MusicPlayer.cardLayouts['player-card'] && window.MusicPlayer.cardLayouts['player-card'].colSpan <= 9) {
                Object.keys(window.MusicPlayer.cardLayouts).forEach(key => {
                    window.MusicPlayer.cardLayouts[key].colStart = (window.MusicPlayer.cardLayouts[key].colStart - 1) * 2 + 1;
                    window.MusicPlayer.cardLayouts[key].colSpan = window.MusicPlayer.cardLayouts[key].colSpan * 2;
                    window.MusicPlayer.cardLayouts[key].rowStart = (window.MusicPlayer.cardLayouts[key].rowStart - 1) * 2 + 1;
                    window.MusicPlayer.cardLayouts[key].rowSpan = window.MusicPlayer.cardLayouts[key].rowSpan * 2;
                });
                saveLayout();
            }

            Object.keys(defaultLayout).forEach(key => {
                if (!window.MusicPlayer.cardLayouts[key]) {
                    window.MusicPlayer.cardLayouts[key] = { ...defaultLayout[key] };
                }
            });
        } catch (err) {
            window.MusicPlayer.cardLayouts = JSON.parse(JSON.stringify(defaultLayout));
        }
    } else {
        window.MusicPlayer.cardLayouts = JSON.parse(JSON.stringify(defaultLayout));
    }

    window.MusicPlayer.resolveCollisions(null);
    window.MusicPlayer.updateGridCellSize();
    window.addEventListener('resize', window.MusicPlayer.updateGridCellSize);

    setupCardDragging();
    setupCardResizing();
    window.MusicPlayer.setupCardLocking();
};

function setupCardDragging() {
    const dashboardGrid = document.getElementById('dashboard-grid');
    if (!dashboardGrid) return;
    const cards = dashboardGrid.querySelectorAll('.card');

    cards.forEach(card => {
        const title = card.querySelector('.card-title');
        if (!title) return;

        title.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            if (e.target.closest('input') || e.target.closest('button') || e.target.closest('select') || e.target.closest('a')) return;

            if (window.MusicPlayer.lockedCards[card.id]) {
                const cleanTitle = getCardCleanTitle(card);
                if (typeof window.MusicPlayer.showToast === 'function') {
                    window.MusicPlayer.showToast(window.MusicPlayer.t('toast_box_locked_move').replace('{title}', cleanTitle));
                }
                return;
            }

            e.preventDefault();
            const layout = window.MusicPlayer.cardLayouts[card.id];
            if (!layout) return;

            card.classList.add('layout-dragging');

            const gridRect = dashboardGrid.getBoundingClientRect();
            const cardRect = card.getBoundingClientRect();
            const mouseOffsetX = e.clientX - cardRect.left;
            const mouseOffsetY = e.clientY - cardRect.top;

            const gap = 16;
            const cellWidth = (gridRect.width - (47 * gap)) / 48;
            const cellUnit = cellWidth + gap;

            function onMouseMove(moveEvent) {
                const x = moveEvent.clientX - gridRect.left - mouseOffsetX;
                const y = moveEvent.clientY - gridRect.top - mouseOffsetY;

                let col = Math.round(x / cellUnit) + 1;
                let row = Math.round(y / cellUnit) + 1;

                col = Math.min(Math.max(1, col), 49 - layout.colSpan);
                row = Math.max(1, row);

                card.style.gridColumnStart = col;
                card.style.gridRowStart = row;

                layout.colStart = col;
                layout.rowStart = row;

                window.MusicPlayer.resolveCollisions(card.id);
            }

            function onMouseUp() {
                window.removeEventListener('mousemove', onMouseMove);
                window.removeEventListener('mouseup', onMouseUp);

                card.classList.remove('layout-dragging');
                window.MusicPlayer.resolveCollisions(null);

                Object.keys(window.MusicPlayer.cardLayouts).forEach(id => {
                    const el = document.getElementById(id);
                    if (el) {
                        window.MusicPlayer.applyLayoutToCard(el, window.MusicPlayer.cardLayouts[id]);
                    }
                });

                saveLayout();
            }

            window.addEventListener('mousemove', onMouseMove);
            window.addEventListener('mouseup', onMouseUp);
        });
    });
}

function setupCardResizing() {
    const dashboardGrid = document.getElementById('dashboard-grid');
    if (!dashboardGrid) return;
    const cards = dashboardGrid.querySelectorAll('.card');

    cards.forEach(card => {
        const handle = card.querySelector('.card-resize-handle');
        if (!handle) return;

        handle.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;

            if (window.MusicPlayer.lockedCards[card.id]) {
                const cleanTitle = getCardCleanTitle(card);
                if (typeof window.MusicPlayer.showToast === 'function') {
                    window.MusicPlayer.showToast(window.MusicPlayer.t('toast_box_locked_resize').replace('{title}', cleanTitle));
                }
                e.preventDefault();
                e.stopPropagation();
                return;
            }

            e.preventDefault();
            e.stopPropagation();

            const layout = window.MusicPlayer.cardLayouts[card.id];
            if (!layout) return;

            card.classList.add('layout-dragging');

            const gridRect = dashboardGrid.getBoundingClientRect();
            const startMouseX = e.clientX;
            const startMouseY = e.clientY;
            const startColSpan = layout.colSpan;
            const startRowSpan = layout.rowSpan;

            const gap = 16;
            const cellWidth = (gridRect.width - (47 * gap)) / 48;
            const cellUnit = cellWidth + gap;

            function onMouseMove(moveEvent) {
                const dx = moveEvent.clientX - startMouseX;
                const dy = moveEvent.clientY - startMouseY;

                const dCols = Math.round(dx / cellUnit);
                const dRows = Math.round(dy / cellUnit);

                let newColSpan = Math.max(8, startColSpan + dCols);
                let newRowSpan = Math.max(6, startRowSpan + dRows);

                if (layout.colStart + newColSpan - 1 > 48) {
                    newColSpan = 49 - layout.colStart;
                }

                card.style.gridColumnEnd = `span ${newColSpan}`;
                card.style.gridRowEnd = `span ${newRowSpan}`;

                layout.colSpan = newColSpan;
                layout.rowSpan = newRowSpan;

                window.MusicPlayer.resolveCollisions(card.id);
            }

            function onMouseUp() {
                window.removeEventListener('mousemove', onMouseMove);
                window.removeEventListener('mouseup', onMouseUp);

                card.classList.remove('layout-dragging');
                window.MusicPlayer.resolveCollisions(null);

                Object.keys(window.MusicPlayer.cardLayouts).forEach(id => {
                    const el = document.getElementById(id);
                    if (el) {
                        window.MusicPlayer.applyLayoutToCard(el, window.MusicPlayer.cardLayouts[id]);
                    }
                });

                saveLayout();
            }

            window.addEventListener('mousemove', onMouseMove);
            window.addEventListener('mouseup', onMouseUp);
        });
    });
}
