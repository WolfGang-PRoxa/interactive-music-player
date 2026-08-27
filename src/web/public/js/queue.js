/**
 * Queue, History, Speakers & Drag-and-Drop Controller
 */

window.MusicPlayer.activeDragData = null;

window.MusicPlayer.resetListDisplacement = function(container, itemSelector) {
    if (!container) return;
    const items = container.querySelectorAll(itemSelector);
    items.forEach(item => {
        item.style.transform = '';
        item.classList.remove('drag-over-above', 'drag-over-below');
    });
};

window.MusicPlayer.clearAllDragIndicators = function() {
    window.MusicPlayer.activeDragData = null;
    document.body.classList.remove('is-dragging-active');
    const queueContainer = document.getElementById('playlist-queue-container');
    const playlistContainer = document.getElementById('playlist-tracks-list');
    if (queueContainer) window.MusicPlayer.resetListDisplacement(queueContainer, '.queue-item');
    if (playlistContainer) window.MusicPlayer.resetListDisplacement(playlistContainer, '.playlist-track-item');
    document.querySelectorAll('.is-dragging, .drag-over-above, .drag-over-below, .drag-over, .drag-over-empty')
        .forEach(el => {
            el.classList.remove('is-dragging', 'drag-over-above', 'drag-over-below', 'drag-over', 'drag-over-empty');
            el.style.transform = '';
        });
};

window.MusicPlayer.updateListDisplacementPreview = function(container, itemSelector, draggedData, clientY) {
    if (!container) return null;
    const items = Array.from(container.querySelectorAll(itemSelector));
    if (items.length === 0) return null;

    let targetIndex = items.length;

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const rect = item.getBoundingClientRect();
        const currentTransform = item.style.transform;
        let translateY = 0;
        if (currentTransform && currentTransform.includes('translateY')) {
            const match = currentTransform.match(/translateY\(([-0-9.]+)px\)/);
            if (match) translateY = parseFloat(match[1]);
        }
        const originalTop = rect.top - translateY;
        const originalHeight = rect.height;
        const originalMid = originalTop + (originalHeight / 2);

        if (clientY < originalMid) {
            targetIndex = i;
            break;
        }
    }

    const fromIndex = (draggedData && draggedData.sourceContainerId === container.id && typeof draggedData.fromIndex === 'number')
        ? draggedData.fromIndex
        : null;

    const firstItem = items[0];
    const itemHeight = firstItem ? (firstItem.getBoundingClientRect().height + 10) : 52;

    items.forEach((item, i) => {
        item.classList.remove('drag-over-above', 'drag-over-below');

        if (fromIndex !== null && i === fromIndex) {
            item.style.transform = '';
            return;
        }

        let offsetY = 0;

        if (fromIndex !== null) {
            if (fromIndex < targetIndex && i > fromIndex && i < targetIndex) {
                offsetY = -itemHeight;
            } else if (fromIndex > targetIndex && i >= targetIndex && i < fromIndex) {
                offsetY = itemHeight;
            }
        } else {
            if (i >= targetIndex) {
                offsetY = itemHeight;
            }
        }

        item.style.transform = offsetY ? `translateY(${offsetY}px)` : '';
    });

    if (items.length > 0) {
        if (targetIndex < items.length) {
            items[targetIndex].classList.add('drag-over-above');
        } else {
            items[items.length - 1].classList.add('drag-over-below');
        }
    }

    return targetIndex;
};

window.addEventListener('dragend', () => {
    if (typeof window.MusicPlayer.clearAllDragIndicators === 'function') {
        window.MusicPlayer.clearAllDragIndicators();
    }
});

window.addEventListener('drop', () => {
    if (typeof window.MusicPlayer.clearAllDragIndicators === 'function') {
        window.MusicPlayer.clearAllDragIndicators();
    }
});

window.MusicPlayer.hasDragType = function(e, type) {
    if (!e.dataTransfer || !e.dataTransfer.types) return false;
    return Array.from(e.dataTransfer.types).includes(type);
};

window.MusicPlayer.isFileDrag = function(e) {
    return window.MusicPlayer.hasDragType(e, 'Files');
};

// Filet de sécurité global : sans ceci, le curseur bascule sur l'icône "dépôt
// interdit" dès qu'on survole une zone sans gestionnaire dragover dédié, ce qui
// casse l'effet de main persistante pendant tout le drag.
window.addEventListener('dragover', (e) => {
    if (e.defaultPrevented) return; // une zone de dépôt plus spécifique gère déjà l'évènement
    if (!window.MusicPlayer.activeDragData && !window.MusicPlayer.isFileDrag(e)) return;
    e.preventDefault();
    if (e.dataTransfer) {
        e.dataTransfer.dropEffect = window.MusicPlayer.activeDragData ? 'move' : 'copy';
    }
});

window.MusicPlayer.handleFileUpload = function(file, extraData = {}) {
    const mediaExtensions = ['mp3', 'flac', 'wav', 'ogg', 'm4a', 'opus', 'aac', 'wma', 'mp4', 'webm', 'mkv', 'avi', 'mov', 'flv', 'm4v', '3gp', 'ogv', 'wmv'];
    const extension = file.name.split('.').pop().toLowerCase();
    if (!file.type.startsWith('audio/') && !file.type.startsWith('video/') && !mediaExtensions.includes(extension)) {
        if (typeof window.MusicPlayer.showToast === 'function') {
            window.MusicPlayer.showToast("Format de fichier non supporté. Veuillez sélectionner un fichier audio ou vidéo.");
        }
        return;
    }

    const sizeMb = (file.size / (1024 * 1024)).toFixed(1);
    if (typeof window.MusicPlayer.showToast === 'function') {
        window.MusicPlayer.showToast(`Envoi de "${file.name}" (${sizeMb} Mo)...`);
    }

    const xhr = new XMLHttpRequest();
    const state = window.MusicPlayer.state || {};
    const guildId = state.guildId || '';
    const guildSelectEl = document.getElementById('guild-select');
    const voiceChannelId = (guildSelectEl ? guildSelectEl.value : '') || window.MusicPlayer.selectedVoiceChannelId || state.voiceChannelId || '';

    const addTargetSelect = document.getElementById('add-target-select');
    const chosenTarget = (extraData.target || (addTargetSelect ? addTargetSelect.value : 'queue'));

    let playlistId = extraData.playlistId || '';
    let target = extraData.target || 'queue';

    if (!extraData.playlistId && !extraData.target) {
        if (chosenTarget === 'playlist') {
            target = 'playlist';
            playlistId = (window.MusicPlayer.getActivePlaylistTabId && window.MusicPlayer.getActivePlaylistTabId()) || '';
        } else if (chosenTarget === 'play') {
            target = 'play';
        }
    }

    const t = window.MusicPlayer.t || (k => k);
    const defaultPlaylistName = t('default_playlist_name') || 'Ma Playlist';

    const url = `/api/upload?guildId=${encodeURIComponent(guildId)}&voiceChannelId=${encodeURIComponent(voiceChannelId)}&playlistId=${encodeURIComponent(playlistId)}&target=${encodeURIComponent(target)}&defaultPlaylistName=${encodeURIComponent(defaultPlaylistName)}`;

    xhr.open('POST', url, true);
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));

    let lastNotifiedPercent = -1;
    xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && typeof window.MusicPlayer.showToast === 'function') {
            const percent = Math.round((e.loaded / e.total) * 100);
            if (percent % 20 === 0 && percent !== lastNotifiedPercent && percent < 100) {
                lastNotifiedPercent = percent;
                window.MusicPlayer.showToast(`Transfert de "${file.name}" : ${percent}%`);
            }
        }
    };

    xhr.onload = () => {
        if (xhr.status === 200) {
            if (typeof window.MusicPlayer.showToast === 'function') {
                window.MusicPlayer.showToast(`Fichier "${file.name}" envoyé avec succès !`);
            }
        } else {
            if (typeof window.MusicPlayer.showToast === 'function') {
                window.MusicPlayer.showToast("Erreur lors du transfert du fichier");
            }
        }
    };

    xhr.onerror = () => {
        if (typeof window.MusicPlayer.showToast === 'function') {
            window.MusicPlayer.showToast("Erreur réseau lors du transfert du fichier");
        }
    };

    xhr.send(file);
};

window.MusicPlayer.handleDroppedFiles = function(fileList, extraData = {}) {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;
    files.forEach(file => window.MusicPlayer.handleFileUpload(file, extraData));
    if (files.length > 1 && typeof window.MusicPlayer.showToast === 'function') {
        window.MusicPlayer.showToast(`${files.length} fichiers envoyés à la file d'attente.`);
    }
};

window.MusicPlayer.initCardsDragAndDrop = function() {
    const searchCard = document.getElementById('search-card');
    if (searchCard && !searchCard._dragBound) {
        searchCard._dragBound = true;
        searchCard.addEventListener('dragover', (e) => {
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
            searchCard.classList.add('dragover');
        });

        searchCard.addEventListener('dragleave', () => {
            searchCard.classList.remove('dragover');
        });

        searchCard.addEventListener('drop', (e) => {
            e.preventDefault();
            searchCard.classList.remove('dragover');
            if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                window.MusicPlayer.handleDroppedFiles(e.dataTransfer.files);
            }
        });
    }

    const playerCard = document.getElementById('player-card');
    if (playerCard && !playerCard._dragBound) {
        playerCard._dragBound = true;
        playerCard.addEventListener('dragover', (e) => {
            if (window.MusicPlayer.hasDragType(e, 'application/json') || window.MusicPlayer.isFileDrag(e) || window.MusicPlayer.activeDragData) {
                e.preventDefault();
                playerCard.classList.add('dragover');
            }
        });

        playerCard.addEventListener('dragleave', () => {
            playerCard.classList.remove('dragover');
        });

        playerCard.addEventListener('drop', (e) => {
            e.preventDefault();
            playerCard.classList.remove('dragover');

            if (window.MusicPlayer.isFileDrag(e) && e.dataTransfer.files.length > 0) {
                window.MusicPlayer.handleDroppedFiles(e.dataTransfer.files);
                return;
            }

            try {
                let dragDataStr = e.dataTransfer.getData('application/json');
                let dragData = null;
                if (dragDataStr) {
                    try { dragData = JSON.parse(dragDataStr); } catch (err) {}
                }
                if (!dragData) dragData = window.MusicPlayer.activeDragData;
                if (dragData && dragData.url) {
                    window.MusicPlayer.sendWS({ type: 'playNow', data: { url: dragData.url } });
                }
            } catch (err) {
                console.error('[PlayerCardDrop] Error:', err);
            }
        });
    }

    const nowPlayingThumbnail = document.getElementById('now-playing-thumbnail');
    if (nowPlayingThumbnail && !nowPlayingThumbnail._dragBound) {
        nowPlayingThumbnail._dragBound = true;
        nowPlayingThumbnail.addEventListener('dragstart', (e) => {
            const state = window.MusicPlayer.state || {};
            if (state.currentTrack && state.currentTrack.url) {
                nowPlayingThumbnail.classList.add('is-dragging');
                document.body.classList.add('is-dragging-active');
                window.MusicPlayer.activeDragData = {
                    source: 'nowplaying',
                    url: state.currentTrack.url,
                    title: state.currentTrack.title,
                    author: state.currentTrack.author,
                    duration: state.currentTrack.duration,
                    thumbnail: state.currentTrack.thumbnail
                };
                e.dataTransfer.setData('application/json', JSON.stringify(window.MusicPlayer.activeDragData));
                e.dataTransfer.effectAllowed = 'copy';
            }
        });

        nowPlayingThumbnail.addEventListener('dragend', () => {
            nowPlayingThumbnail.classList.remove('is-dragging');
            document.body.classList.remove('is-dragging-active');
            window.MusicPlayer.activeDragData = null;
            if (typeof window.MusicPlayer.clearAllDragIndicators === 'function') {
                window.MusicPlayer.clearAllDragIndicators();
            }
        });
    }
    const queueCard = document.getElementById('queue-card');
    if (queueCard && !queueCard._dragBound) {
        queueCard._dragBound = true;
        queueCard.addEventListener('dragover', (e) => {
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
            queueCard.classList.add('drag-over');
        });

        queueCard.addEventListener('dragleave', (e) => {
            const rect = queueCard.getBoundingClientRect();
            if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) {
                queueCard.classList.remove('drag-over');
            }
        });

        queueCard.addEventListener('drop', (e) => {
            if (e.target.closest('#playlist-queue-container')) return;
            e.preventDefault();
            queueCard.classList.remove('drag-over');

            if (window.MusicPlayer.isFileDrag(e) && e.dataTransfer.files.length > 0) {
                window.MusicPlayer.handleDroppedFiles(e.dataTransfer.files);
                return;
            }

            try {
                let dragDataStr = e.dataTransfer.getData('application/json');
                let dragData = null;
                if (dragDataStr) {
                    try { dragData = JSON.parse(dragDataStr); } catch (err) {}
                }
                if (!dragData) dragData = window.MusicPlayer.activeDragData;

                const logMsg = `[DragDrop QueueCard] Drop received on the pending queue card. Track: "${dragData ? dragData.title : 'unknown'}"`;
                console.log(logMsg);
                if (typeof window.MusicPlayer.sendWS === 'function') {
                    window.MusicPlayer.sendWS({ type: 'clientLog', data: { source: 'DragDrop-QueueCard', message: logMsg } });
                }

                if (!dragData || !dragData.source) return;

                const curState = window.MusicPlayer.state || {};
                const queueLen = curState.queue ? curState.queue.length : 0;

                if (dragData.source === 'history' || dragData.source === 'nowplaying' || dragData.source === 'playlist_track') {
                    if (dragData.url) {
                        window.MusicPlayer.sendWS({
                            type: 'moveOrInsertTrack',
                            data: {
                                source: dragData.source,
                                url: dragData.url,
                                toIndex: queueLen
                            }
                        });
                    }
                }
            } catch (err) {
                console.error('[QueueCardDrop] Error:', err);
            }
        });
    }
};

window.MusicPlayer.updateQueueUI = function() {
    const playlistQueueContainer = document.getElementById('playlist-queue-container');
    const btnClearQueue = document.getElementById('btn-clear-queue');
    const state = window.MusicPlayer.state;
    if (!playlistQueueContainer) return;

    window.MusicPlayer.initCardsDragAndDrop();

    if (!playlistQueueContainer._dragListenersAttached) {
        playlistQueueContainer._dragListenersAttached = true;

        playlistQueueContainer.addEventListener('dragover', (e) => {
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';

            window.MusicPlayer.updateListDisplacementPreview(
                playlistQueueContainer,
                '.queue-item',
                window.MusicPlayer.activeDragData,
                e.clientY
            );
        });

        playlistQueueContainer.addEventListener('dragleave', (e) => {
            const rect = playlistQueueContainer.getBoundingClientRect();
            if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) {
                window.MusicPlayer.resetListDisplacement(playlistQueueContainer, '.queue-item');
                playlistQueueContainer.classList.remove('drag-over', 'drag-over-empty');
            }
        });

        playlistQueueContainer.addEventListener('drop', (e) => {
            e.preventDefault();
            const rawInsertionIndex = window.MusicPlayer.updateListDisplacementPreview(
                playlistQueueContainer,
                '.queue-item',
                window.MusicPlayer.activeDragData,
                e.clientY
            );

            window.MusicPlayer.resetListDisplacement(playlistQueueContainer, '.queue-item');
            if (typeof window.MusicPlayer.clearAllDragIndicators === 'function') {
                window.MusicPlayer.clearAllDragIndicators();
            }

            if (window.MusicPlayer.isFileDrag(e) && e.dataTransfer.files.length > 0) {
                window.MusicPlayer.handleDroppedFiles(e.dataTransfer.files);
                return;
            }

            try {
                let dragDataStr = e.dataTransfer.getData('application/json');
                let dragData = null;
                if (dragDataStr) {
                    try { dragData = JSON.parse(dragDataStr); } catch (err) {}
                }
                if (!dragData) dragData = window.MusicPlayer.activeDragData;

                const logMsg = `[DragDrop Queue] Drop received on the pending queue. Track: "${dragData ? dragData.title : 'unknown'}" (source: ${dragData ? dragData.source : 'none'})`;
                console.log(logMsg);
                if (typeof window.MusicPlayer.sendWS === 'function') {
                    window.MusicPlayer.sendWS({ type: 'clientLog', data: { source: 'DragDrop-Queue', message: logMsg } });
                }

                if (!dragData || !dragData.source) return;

                const curState = window.MusicPlayer.state || {};
                const queueLen = curState.queue ? curState.queue.length : 0;
                
                const finalTargetIdx = (typeof rawInsertionIndex === 'number') ? rawInsertionIndex : queueLen;

                if (dragData.source === 'queue') {
                    const fromIndex = dragData.fromIndex;
                    const finalIndex = finalTargetIdx > fromIndex ? finalTargetIdx - 1 : finalTargetIdx;
                    if (finalIndex !== fromIndex && typeof fromIndex === 'number') {
                        window.MusicPlayer.sendWS({
                            type: 'moveOrInsertTrack',
                            data: {
                                source: 'queue',
                                fromIndex: fromIndex,
                                toIndex: finalIndex
                            }
                        });
                    }
                } else if (dragData.source === 'history' || dragData.source === 'nowplaying' || dragData.source === 'playlist_track') {
                    if (dragData.url) {
                        window.MusicPlayer.sendWS({
                            type: 'moveOrInsertTrack',
                            data: {
                                source: dragData.source,
                                url: dragData.url,
                                toIndex: finalTargetIdx
                            }
                        });
                    }
                }
            } catch (err) {
                console.error('[QueueDrop] Error:', err);
            }
        });
    }

    const queueStructJson = JSON.stringify((state.queue || []).map(t => ({ title: t.title, url: t.url, duration: t.duration, thumbnail: t.thumbnail })));
    if (playlistQueueContainer._lastQueueStructJson !== queueStructJson) {
        playlistQueueContainer._lastQueueStructJson = queueStructJson;
        playlistQueueContainer.innerHTML = '';
        if (state.queue && state.queue.length > 0) {
            state.queue.forEach((track, index) => {
                const item = document.createElement('div');
                item.className = 'queue-item';
                item.setAttribute('draggable', 'true');
                item.setAttribute('data-index', index);

                const fillBar = document.createElement('div');
                fillBar.className = 'preload-fill-bar';
                fillBar.style.width = '100%';
                fillBar.style.transform = 'scaleX(0)';
                item.appendChild(fillBar);

                const playbackBar = document.createElement('div');
                playbackBar.className = 'playback-fill-bar';
                playbackBar.style.width = '100%';
                playbackBar.style.transform = 'scaleX(0)';
                item.appendChild(playbackBar);

                window.MusicPlayer.setupRequalifyLayer(item);
                window.MusicPlayer.attachQualityMenu(item, () => (window.MusicPlayer.state.queue || [])[index]);

                item.addEventListener('dragstart', (e) => {
                    item.classList.add('is-dragging');
                    document.body.classList.add('is-dragging-active');
                    window.MusicPlayer.activeDragData = {
                        sourceContainerId: 'playlist-queue-container',
                        fromIndex: index,
                        source: 'queue',
                        url: track.url,
                        title: track.title,
                        author: track.author,
                        duration: track.duration,
                        thumbnail: track.thumbnail
                    };
                    e.dataTransfer.setData('application/json', JSON.stringify(window.MusicPlayer.activeDragData));
                    if (track.url) {
                        e.dataTransfer.setData('text/plain', track.url);
                    }
                    e.dataTransfer.effectAllowed = 'copyMove';
                });

                item.addEventListener('dragend', () => {
                    item.classList.remove('is-dragging');
                    document.body.classList.remove('is-dragging-active');
                    window.MusicPlayer.activeDragData = null;
                    if (typeof window.MusicPlayer.clearAllDragIndicators === 'function') {
                        window.MusicPlayer.clearAllDragIndicators();
                    }
                });

                const leftArea = document.createElement('div');
                leftArea.className = 'queue-item-left';

                const idxSpan = document.createElement('span');
                idxSpan.className = 'queue-index';
                idxSpan.textContent = `#${index + 1}`;
                leftArea.appendChild(idxSpan);

                if (track.thumbnail) {
                    const thumbImg = document.createElement('img');
                    thumbImg.className = 'queue-thumbnail';
                    thumbImg.src = track.thumbnail;
                    thumbImg.alt = 'Cover';
                    thumbImg.setAttribute('draggable', 'false');
                    leftArea.appendChild(thumbImg);
                }

                const titleSpan = document.createElement('span');
                titleSpan.className = 'queue-title';
                titleSpan.textContent = track.title;
                titleSpan.dataset.tooltip = track.title;
                leftArea.appendChild(titleSpan);

                const rightArea = document.createElement('div');
                rightArea.className = 'queue-item-right';

                const durSpan = document.createElement('span');
                durSpan.className = 'queue-duration';
                durSpan.textContent = track.duration;
                rightArea.appendChild(durSpan);

                const playNowBtn = document.createElement('button');
                playNowBtn.className = 'queue-play-now-btn';
                playNowBtn.dataset.tooltip = (window.MusicPlayer.t && window.MusicPlayer.t('tooltip_play_now')) || 'Jouer maintenant';
        playNowBtn.dataset.i18nTooltip = 'tooltip_play_now';
                playNowBtn.innerHTML = `
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <polygon points="5 3 19 12 5 21 5 3"></polygon>
                    </svg>
                `;
                playNowBtn.addEventListener('click', () => {
                    window.MusicPlayer.sendWS({
                        type: 'playNow',
                        data: { url: track.url }
                    });
                });
                rightArea.appendChild(playNowBtn);

                const deleteBtn = document.createElement('button');
                deleteBtn.className = 'queue-remove-btn';
                deleteBtn.dataset.tooltip = (window.MusicPlayer.t && window.MusicPlayer.t('tooltip_delete_from_queue')) || 'Supprimer de la file';
        deleteBtn.dataset.i18nTooltip = 'tooltip_delete_from_queue';
                deleteBtn.innerHTML = `
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon-trash">
                        <polyline points="3 6 5 6 21 6"></polyline>
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                    </svg>
                `;
                deleteBtn.addEventListener('click', () => {
                    window.MusicPlayer.sendWS({
                        type: 'removeTrack',
                        data: { index }
                    });
                });
                rightArea.appendChild(deleteBtn);

                item.appendChild(leftArea);
                item.appendChild(rightArea);
                playlistQueueContainer.appendChild(item);
            });
        } else {
            const emptyDiv = document.createElement('div');
            emptyDiv.className = 'no-tracks';
            emptyDiv.textContent = window.MusicPlayer.t('queue_empty') || 'File d\'attente vide';
            emptyDiv.setAttribute('data-i18n', 'queue_empty');
            playlistQueueContainer.appendChild(emptyDiv);
        }

        if (btnClearQueue) {
            btnClearQueue.disabled = !(state.queue && state.queue.length > 0);
        }
    }

    // Mise à jour en place des barres de préchargement (sans reconstruction du DOM)
    if (state.queue && state.queue.length > 0) {
        const items = playlistQueueContainer.querySelectorAll('.queue-item');
        state.queue.forEach((track, i) => {
            const item = items[i];
            if (!item) return;
            const fillBar = item.querySelector('.preload-fill-bar');
            const isPreloaded = !!track.isPreloaded;
            const isPreloading = !!track.isPreloading;
            const fillPct = isPreloaded ? 100 : (track.preloadProgress || 0);

            if (fillBar) {
                const safeScale = Math.max(0.0001, fillPct / 100);
                fillBar.style.width = '100%';
                fillBar.style.transform = `scaleX(${fillPct / 100})`;
                fillBar.style.setProperty('--progress-scale', safeScale);
            }
            item.classList.toggle('is-preloaded', isPreloaded);
            item.classList.toggle('is-preloading', isPreloading);
            window.MusicPlayer.applyRequalifyState(item, track);
        });
    }

    window.MusicPlayer.refreshTrackQualityMenu();
};

window.MusicPlayer.updateHistoryUI = function() {
    const playlistHistoryContainer = document.getElementById('playlist-history-container');
    const btnClearHistory = document.getElementById('btn-clear-history');
    const state = window.MusicPlayer.state;
    if (!playlistHistoryContainer) return;

    const historyStructJson = JSON.stringify((state.history || []).map(t => ({ title: t.title, url: t.url, duration: t.duration, thumbnail: t.thumbnail })));
    if (playlistHistoryContainer._lastHistoryStructJson !== historyStructJson) {
        playlistHistoryContainer._lastHistoryStructJson = historyStructJson;
        playlistHistoryContainer.innerHTML = '';
        if (state.history && state.history.length > 0) {
            state.history.forEach((track, index) => {
                const item = document.createElement('div');
                item.className = 'history-item';
                item.setAttribute('draggable', 'true');

                const fillBar = document.createElement('div');
                fillBar.className = 'preload-fill-bar';
                fillBar.style.width = '100%';
                fillBar.style.transform = 'scaleX(0)';
                item.appendChild(fillBar);

                window.MusicPlayer.setupRequalifyLayer(item);
                window.MusicPlayer.attachQualityMenu(item, () => (window.MusicPlayer.state.history || [])[index]);

                item.addEventListener('dragstart', (e) => {
                    item.classList.add('is-dragging');
                    document.body.classList.add('is-dragging-active');
                    window.MusicPlayer.activeDragData = {
                        source: 'history',
                        url: track.url,
                        title: track.title,
                        author: track.author,
                        duration: track.duration,
                        thumbnail: track.thumbnail
                    };
                    e.dataTransfer.setData('application/json', JSON.stringify(window.MusicPlayer.activeDragData));
                    if (track.url) {
                        e.dataTransfer.setData('text/plain', track.url);
                    }
                    e.dataTransfer.effectAllowed = 'copy';

                    const logMsg = `[DragStart History] Drag started: "${track.title}" (${track.url})`;
                    console.log(logMsg);
                    if (typeof window.MusicPlayer.sendWS === 'function') {
                        window.MusicPlayer.sendWS({ type: 'clientLog', data: { source: 'DragDrop-History', message: logMsg } });
                    }
                });

                item.addEventListener('dragend', () => {
                    item.classList.remove('is-dragging');
                    document.body.classList.remove('is-dragging-active');
                    window.MusicPlayer.activeDragData = null;
                    if (typeof window.MusicPlayer.clearAllDragIndicators === 'function') {
                        window.MusicPlayer.clearAllDragIndicators();
                    }
                });

                const leftArea = document.createElement('div');
                leftArea.className = 'history-item-left';

                if (track.thumbnail) {
                    const thumbImg = document.createElement('img');
                    thumbImg.className = 'history-thumbnail';
                    thumbImg.src = track.thumbnail;
                    thumbImg.alt = 'Cover';
                    thumbImg.setAttribute('draggable', 'false');
                    leftArea.appendChild(thumbImg);
                }

                const titleSpan = document.createElement('span');
                titleSpan.className = 'history-title';
                titleSpan.textContent = track.title;
                titleSpan.dataset.tooltip = track.title;
                leftArea.appendChild(titleSpan);

                const rightArea = document.createElement('div');
                rightArea.className = 'history-item-right';

                const durSpan = document.createElement('span');
                durSpan.className = 'history-duration';
                durSpan.textContent = track.duration;
                rightArea.appendChild(durSpan);

                const playNowBtn = document.createElement('button');
                playNowBtn.className = 'queue-play-now-btn';
                playNowBtn.dataset.tooltip = (window.MusicPlayer.t && window.MusicPlayer.t('tooltip_play_now')) || 'Jouer maintenant';
        playNowBtn.dataset.i18nTooltip = 'tooltip_play_now';
                playNowBtn.innerHTML = `
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <polygon points="5 3 19 12 5 21 5 3"></polygon>
                    </svg>
                `;
                playNowBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    window.MusicPlayer.sendWS({
                        type: 'playNow',
                        data: { url: track.url }
                    });
                });
                rightArea.appendChild(playNowBtn);

                const deleteBtn = document.createElement('button');
                deleteBtn.className = 'queue-remove-btn';
                deleteBtn.dataset.tooltip = (window.MusicPlayer.t && window.MusicPlayer.t('tooltip_delete_from_history')) || 'Supprimer de l\'historique';
        deleteBtn.dataset.i18nTooltip = 'tooltip_delete_from_history';
                deleteBtn.innerHTML = `
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon-trash">
                        <polyline points="3 6 5 6 21 6"></polyline>
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                    </svg>
                `;
                deleteBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    window.MusicPlayer.sendWS({
                        type: 'removeFromHistory',
                        data: { index }
                    });
                });
                rightArea.appendChild(deleteBtn);

                item.appendChild(leftArea);
                item.appendChild(rightArea);
                playlistHistoryContainer.appendChild(item);
            });
        } else {
            const emptyDiv = document.createElement('div');
            emptyDiv.className = 'no-tracks';
            emptyDiv.textContent = window.MusicPlayer.t('no_history_tracks') || 'Historique vide';
            emptyDiv.setAttribute('data-i18n', 'no_history_tracks');
            playlistHistoryContainer.appendChild(emptyDiv);
        }

        if (btnClearHistory) {
            btnClearHistory.disabled = !(state.history && state.history.length > 0);
        }
    }

    // Mise à jour en place des barres de préchargement (sans reconstruction du DOM)
    if (state.history && state.history.length > 0) {
        const items = playlistHistoryContainer.querySelectorAll('.history-item');
        state.history.forEach((track, i) => {
            const item = items[i];
            if (!item) return;
            const fillBar = item.querySelector('.preload-fill-bar');
            const isPreloaded = !!track.isPreloaded;
            const isPreloading = !!track.isPreloading;
            const fillPct = isPreloaded ? 100 : (track.preloadProgress || 0);

            if (fillBar) {
                const safeScale = Math.max(0.0001, fillPct / 100);
                fillBar.style.width = '100%';
                fillBar.style.transform = `scaleX(${fillPct / 100})`;
                fillBar.style.setProperty('--progress-scale', safeScale);
            }
            item.classList.toggle('is-preloaded', isPreloaded);
            item.classList.toggle('is-preloading', isPreloading);
            window.MusicPlayer.applyRequalifyState(item, track);
        });
    }

    window.MusicPlayer.refreshTrackQualityMenu();
};

window.MusicPlayer.updateSpeakersUI = function() {
    const speakersListContainer = document.getElementById('speakers-list-container');
    const state = window.MusicPlayer.state;
    if (!speakersListContainer) return;

    if (!state.members || state.members.length === 0) {
        speakersListContainer.innerHTML = `<div class="no-speakers" data-i18n="no_speakers">${window.MusicPlayer.t('no_speakers') || 'Aucun membre dans le salon vocal'}</div>`;
    } else {
        const emptyMsg = speakersListContainer.querySelector('.no-speakers');
        if (emptyMsg) {
            emptyMsg.remove();
        }

        const ignoredUsers = state.ignoredVoiceUsers || [];
        const activeUserIds = new Set(state.members.map(m => m.id));

        Array.from(speakersListContainer.children).forEach(child => {
            const userId = child.getAttribute('data-user-id');
            if (userId && !activeUserIds.has(userId)) {
                child.remove();
            }
        });

        state.members.forEach((member, index) => {
            const isSpeaking = (state.speakers || []).includes(member.id);
            const isDetectionEnabled = !ignoredUsers.includes(member.id);
            
            let item = speakersListContainer.querySelector(`[data-user-id="${member.id}"]`);
            
            if (!item) {
                item = document.createElement('div');
                item.className = 'speaker-item';
                item.setAttribute('data-user-id', member.id);
                
                const profile = document.createElement('div');
                profile.className = 'speaker-profile';
                
                if (member.avatar) {
                    const avatarImg = document.createElement('img');
                    avatarImg.src = member.avatar;
                    avatarImg.alt = member.displayName;
                    avatarImg.className = 'avatar-mock';
                    avatarImg.style.objectFit = 'cover';
                    profile.appendChild(avatarImg);
                } else {
                    const avatarDiv = document.createElement('div');
                    avatarDiv.className = 'avatar-mock';
                    avatarDiv.textContent = member.displayName.charAt(0).toUpperCase();
                    profile.appendChild(avatarDiv);
                }
                
                const name = document.createElement('span');
                name.className = 'speaker-name';
                name.textContent = member.displayName;
                profile.appendChild(name);

                const controls = document.createElement('div');
                controls.className = 'speaker-controls';
                
                const switchLabel = document.createElement('label');
                switchLabel.className = 'switch switch-mini';
                
                const switchInput = document.createElement('input');
                switchInput.type = 'checkbox';
                switchInput.addEventListener('change', (e) => {
                    window.MusicPlayer.sendWS({
                        type: 'toggleVoiceDetection',
                        data: {
                            userId: member.id,
                            enabled: e.target.checked
                        }
                    });
                });
                
                const switchSlider = document.createElement('span');
                switchSlider.className = 'switch-slider';
                
                switchLabel.appendChild(switchInput);
                switchLabel.appendChild(switchSlider);

                const glow = document.createElement('div');
                glow.className = 'speaking-glow';
                
                controls.appendChild(switchLabel);
                controls.appendChild(glow);

                item.appendChild(profile);
                item.appendChild(controls);
                
                speakersListContainer.appendChild(item);
            }

            item.className = `speaker-item ${isSpeaking ? 'active-speaking' : ''} ${!isDetectionEnabled ? 'voice-disabled' : ''}`;
            
            const nameSpan = item.querySelector('.speaker-name');
            if (nameSpan && nameSpan.textContent !== member.displayName) {
                nameSpan.textContent = member.displayName;
            }
            
            const switchLabel = item.querySelector('.switch-mini');
            if (switchLabel) {
                switchLabel.dataset.tooltip = isDetectionEnabled ? ((window.MusicPlayer.t && window.MusicPlayer.t('tooltip_voice_det_on')) || 'Détection vocale activée') : ((window.MusicPlayer.t && window.MusicPlayer.t('tooltip_voice_det_off')) || 'Détection vocale désactivée');
            }

            const switchInput = item.querySelector('.switch-mini input');
            if (switchInput && switchInput.checked !== isDetectionEnabled) {
                switchInput.checked = isDetectionEnabled;
            }
            
            if (speakersListContainer.children[index] !== item) {
                speakersListContainer.insertBefore(item, speakersListContainer.children[index]);
            }
        });
    }
};
