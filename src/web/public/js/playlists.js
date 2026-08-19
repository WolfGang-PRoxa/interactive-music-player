/**
 * Playlists Tab & Track Management Controller
 */

window.MusicPlayer = window.MusicPlayer || {};

let activePlaylistTabId = null;
let lastPlaylistsCount = -1;
let isFirstPlaylistsLoad = true;

function areUrlsEqual(url1, url2) {
    if (!url1 || !url2) return false;
    try {
        const norm1 = decodeURIComponent(url1).replace(/\\/g, '/').toLowerCase();
        const norm2 = decodeURIComponent(url2).replace(/\\/g, '/').toLowerCase();
        return norm1 === norm2;
    } catch (e) {
        return url1.replace(/\\/g, '/').toLowerCase() === url2.replace(/\\/g, '/').toLowerCase();
    }
}

function getSortedPlaylists(playlists) {
    if (!playlists || !Array.isArray(playlists)) return [];
    const savedOrderStr = localStorage.getItem('playlistOrder');
    if (!savedOrderStr) return playlists;
    try {
        const savedOrder = JSON.parse(savedOrderStr);
        if (!Array.isArray(savedOrder) || savedOrder.length === 0) return playlists;
        const map = new Map(playlists.map(p => [p.id, p]));
        const sorted = [];
        for (const id of savedOrder) {
            if (map.has(id)) {
                sorted.push(map.get(id));
                map.delete(id);
            }
        }
        for (const p of map.values()) {
            sorted.push(p);
        }
        return sorted;
    } catch (e) {
        return playlists;
    }
}

window.MusicPlayer.handleTrackDropOnPlaylist = function(playlistId, dragData, targetIndex) {
    const state = window.MusicPlayer.state;
    const t = window.MusicPlayer.t || (k => k);
    const defaultPlaylistName = t('default_playlist_name') || 'Ma Playlist';
    let trackInfo = null;

    if (!dragData) return;

    if (dragData.source === 'nowplaying') {
        if (state.currentTrack && (areUrlsEqual(state.currentTrack.url, dragData.url) || !dragData.url)) {
            trackInfo = state.currentTrack;
        }
    } else if (dragData.source === 'queue') {
        if (state.queue && typeof dragData.fromIndex === 'number' && state.queue[dragData.fromIndex]) {
            trackInfo = state.queue[dragData.fromIndex];
        } else if (state.queue && dragData.url) {
            trackInfo = state.queue.find(t => areUrlsEqual(t.url, dragData.url));
        }
    } else if (dragData.source === 'history') {
        if (state.history && dragData.url) {
            trackInfo = state.history.find(t => areUrlsEqual(t.url, dragData.url));
        }
    } else if (dragData.source === 'playlist_track') {
        const sourcePlaylist = state.playlists ? state.playlists.find(p => p.id === dragData.playlistId) : null;
        if (sourcePlaylist && sourcePlaylist.tracks) {
            trackInfo = sourcePlaylist.tracks[dragData.fromIndex];
        }
    }

    if (!trackInfo && (dragData.url || dragData.title)) {
        trackInfo = {
            title: dragData.title || 'Morceau',
            author: dragData.author || 'Inconnu',
            duration: dragData.duration || '0:00',
            thumbnail: dragData.thumbnail || null,
            url: dragData.url
        };
    }

    if (trackInfo) {
        window.MusicPlayer.sendWS({
            type: 'addTrackToPlaylist',
            data: {
                playlistId: playlistId || null,
                defaultPlaylistName: defaultPlaylistName,
                targetIndex: typeof targetIndex === 'number' ? targetIndex : undefined,
                track: {
                    title: trackInfo.title,
                    author: trackInfo.author || 'Inconnu',
                    duration: trackInfo.duration || '0:00',
                    thumbnail: trackInfo.thumbnail || null,
                    url: trackInfo.url,
                    queryType: trackInfo.queryType || (trackInfo.url && trackInfo.url.startsWith('http') ? 'youtube' : 'file')
                }
            }
        });
    }
};

window.MusicPlayer.updatePlaylistsUI = function() {
    const playlistsTabsContainer = document.getElementById('playlists-tabs-container');
    const activePlaylistContent = document.getElementById('active-playlist-content');
    const playbackSourceSelect = document.getElementById('playback-source-select');
    const state = window.MusicPlayer.state;

    if (!playlistsTabsContainer || !activePlaylistContent) return;

    if (state.playlists && state.playlists.length > 0) {
        state.playlists = getSortedPlaylists(state.playlists);
        const existingIds = state.playlists.map(p => p.id);
        const savedTabId = localStorage.getItem('activePlaylistTabId');

        if (isFirstPlaylistsLoad) {
            isFirstPlaylistsLoad = false;
            if (savedTabId && existingIds.includes(savedTabId)) {
                activePlaylistTabId = savedTabId;
            } else if (state.activePlaybackSource && state.activePlaybackSource.startsWith('playlist_') && existingIds.includes(state.activePlaybackSource)) {
                activePlaylistTabId = state.activePlaybackSource;
            } else {
                activePlaylistTabId = existingIds[0];
            }
            if (activePlaylistTabId) {
                localStorage.setItem('activePlaylistTabId', activePlaylistTabId);
            }
        } else {
            if (!activePlaylistTabId || !existingIds.includes(activePlaylistTabId)) {
                if (savedTabId && existingIds.includes(savedTabId)) {
                    activePlaylistTabId = savedTabId;
                } else {
                    activePlaylistTabId = existingIds[0];
                }
                if (activePlaylistTabId) {
                    localStorage.setItem('activePlaylistTabId', activePlaylistTabId);
                }
            } else if (lastPlaylistsCount !== -1 && state.playlists.length > lastPlaylistsCount) {
                // Switch to newly created playlist tab
                activePlaylistTabId = state.playlists[state.playlists.length - 1].id;
                if (activePlaylistTabId) {
                    localStorage.setItem('activePlaylistTabId', activePlaylistTabId);
                }
            }
        }
        lastPlaylistsCount = state.playlists.length;
    } else {
        // Liste vide : c'est aussi bien « aucune playlist » que l'état initial
        // affiché avant la première réponse du serveur (applyLanguage redessine
        // la boîte au chargement). On oublie l'onglet courant pour l'affichage,
        // mais surtout PAS la mémoire : l'effacer ici reviendrait à perdre la
        // playlist choisie à chaque rechargement de page, avant même que
        // l'état WebSocket n'arrive. Si la playlist mémorisée a réellement
        // disparu, la restauration ci-dessus s'en aperçoit et bascule sur la
        // première playlist existante.
        activePlaylistTabId = null;
        lastPlaylistsCount = 0;
        isFirstPlaylistsLoad = true;
    }

    if (playbackSourceSelect) {
        const playlistsStateKey = (state.playlists || []).map(p => `${p.id}:${p.name}`).join('|');
        const activeSource = state.activePlaybackSource || 'queue';
        // La langue entre dans la clé : l'option « File d'attente » est
        // construite ici, elle doit donc être reconstruite quand la langue
        // change — sinon elle reste figée jusqu'au rechargement de la page.
        const langue = (window.MusicPlayer.dashboardSettings && window.MusicPlayer.dashboardSettings.language) || 'fr';
        const selectStateKey = `${playlistsStateKey}|${activeSource}|${langue}`;
        
        if (playbackSourceSelect._lastSelectStateKey !== selectStateKey) {
            playbackSourceSelect._lastSelectStateKey = selectStateKey;
            playbackSourceSelect.innerHTML = '';
            
            const t = window.MusicPlayer.t || (k => k);
            const optQueue = document.createElement('option');
            optQueue.value = 'queue';
            optQueue.textContent = t('source_queue') || "File d'attente";
            playbackSourceSelect.appendChild(optQueue);
            
            if (state.playlists && state.playlists.length > 0) {
                state.playlists.forEach(pl => {
                    const opt = document.createElement('option');
                    opt.value = pl.id;
                    opt.textContent = pl.name;
                    playbackSourceSelect.appendChild(opt);
                });
            }
            
            playbackSourceSelect.value = activeSource;
            const customSel = playbackSourceSelect._customSelect || window.MusicPlayer.customSourceSelect;
            if (customSel) {
                customSel.sync(true);
            }
        }
    }

    const playlistsStateKey = (state.playlists || []).map((p, i) => `${p.id}:${p.name}:${i}`).join('|') + '|active:' + activePlaylistTabId;
    if (playlistsTabsContainer._lastPlaylistsStateKey !== playlistsStateKey) {
        playlistsTabsContainer._lastPlaylistsStateKey = playlistsStateKey;
        playlistsTabsContainer.querySelectorAll('.playlist-tab').forEach(el => el.remove());
        
        if (state.playlists && state.playlists.length > 0) {
            state.playlists.forEach((pl, index) => {
                const tab = document.createElement('button');
                tab.className = `playlist-tab ${activePlaylistTabId === pl.id ? 'active' : ''}`;
                tab.setAttribute('data-id', pl.id);
                tab.setAttribute('data-index', index);
                tab.setAttribute('draggable', 'true');

                tab.addEventListener('dragstart', (e) => {
                    tab.classList.add('is-dragging');
                    document.body.classList.add('is-dragging-active');
                    window.MusicPlayer.activeDragData = {
                        source: 'playlist_tab',
                        playlistId: pl.id,
                        fromIndex: index
                    };
                    e.dataTransfer.setData('application/json', JSON.stringify(window.MusicPlayer.activeDragData));
                    e.dataTransfer.setData('text/plain', pl.name || pl.id);
                    e.dataTransfer.effectAllowed = 'move';

                    const logMsg = `[DragStart PlaylistTab] Début de réorganisation d'onglet : "${pl.name}" (index: ${index})`;
                    console.log(logMsg);
                    if (typeof window.MusicPlayer.sendWS === 'function') {
                        window.MusicPlayer.sendWS({ type: 'clientLog', data: { source: 'DragDrop-PlaylistTabReorder', message: logMsg } });
                    }
                });

                tab.addEventListener('dragend', () => {
                    tab.classList.remove('is-dragging');
                    document.body.classList.remove('is-dragging-active');
                    window.MusicPlayer.activeDragData = null;
                    if (typeof window.MusicPlayer.clearAllDragIndicators === 'function') {
                        window.MusicPlayer.clearAllDragIndicators();
                    }
                });
                
                const nameWrapper = document.createElement('div');
                nameWrapper.className = 'playlist-tab-name-wrapper';
                
                const nameSpan = document.createElement('span');
                nameSpan.className = 'playlist-tab-name';
                nameSpan.textContent = pl.name;
                
                nameWrapper.appendChild(nameSpan);
                tab.appendChild(nameWrapper);
                
                tab.addEventListener('dragover', (e) => {
                    e.preventDefault();
                    const dragData = window.MusicPlayer.activeDragData;
                    if (dragData && dragData.source === 'playlist_tab') {
                        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
                        const rect = tab.getBoundingClientRect();
                        const mid = rect.left + rect.width / 2;
                        if (e.clientX < mid) {
                            tab.classList.add('drag-over-left');
                            tab.classList.remove('drag-over-right', 'drag-over', 'drag-over-tab');
                        } else {
                            tab.classList.add('drag-over-right');
                            tab.classList.remove('drag-over-left', 'drag-over', 'drag-over-tab');
                        }
                    } else {
                        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
                        tab.classList.add('drag-over');
                        tab.classList.remove('drag-over-left', 'drag-over-right');
                    }
                });

                tab.addEventListener('dragleave', () => {
                    tab.classList.remove('drag-over', 'drag-over-tab', 'drag-over-left', 'drag-over-right');
                });

                tab.addEventListener('drop', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    tab.classList.remove('drag-over', 'drag-over-tab', 'drag-over-left', 'drag-over-right');

                    let dragDataStr = e.dataTransfer.getData('application/json');
                    let dragData = null;
                    if (dragDataStr) {
                        try { dragData = JSON.parse(dragDataStr); } catch (err) {}
                    }
                    if (!dragData) dragData = window.MusicPlayer.activeDragData;

                    if (dragData && dragData.source === 'playlist_tab') {
                        const fromIndex = dragData.fromIndex;
                        const toIndex = index;

                        if (typeof fromIndex === 'number' && typeof toIndex === 'number' && fromIndex !== toIndex) {
                            if (state.playlists && state.playlists[fromIndex]) {
                                const [moved] = state.playlists.splice(fromIndex, 1);
                                state.playlists.splice(toIndex, 0, moved);
                                const newOrder = state.playlists.map(p => p.id);
                                localStorage.setItem('playlistOrder', JSON.stringify(newOrder));
                                playlistsTabsContainer._lastPlaylistsStateKey = null;
                                window.MusicPlayer.updatePlaylistsUI();

                                const logMsg = `[DragDrop PlaylistTabReorder] Réorganisation des playlists de ${fromIndex} vers ${toIndex}`;
                                console.log(logMsg);
                                if (typeof window.MusicPlayer.sendWS === 'function') {
                                    window.MusicPlayer.sendWS({ type: 'clientLog', data: { source: 'DragDrop-PlaylistTabReorder', message: logMsg } });
                                }
                                window.MusicPlayer.sendWS({
                                    type: 'reorderPlaylists',
                                    data: { fromIndex, toIndex, playlistOrder: newOrder }
                                });
                            }
                        }
                        return;
                    }

                    if (window.MusicPlayer.isFileDrag(e) && e.dataTransfer.files.length > 0) {
                        window.MusicPlayer.handleDroppedFiles(e.dataTransfer.files, { playlistId: pl.id });
                        return;
                    }

                    const logMsg = `[DragDrop PlaylistTab] Dépôt reçu sur onglet playlist "${pl.name}". Morceau: "${dragData ? dragData.title : 'inconnu'}"`;
                    console.log(logMsg);
                    if (typeof window.MusicPlayer.sendWS === 'function') {
                        window.MusicPlayer.sendWS({ type: 'clientLog', data: { source: 'DragDrop-PlaylistTab', message: logMsg } });
                    }

                    if (dragData) {
                        window.MusicPlayer.handleTrackDropOnPlaylist(pl.id, dragData);
                    }
                });
                
                tab.addEventListener('click', () => {
                    activePlaylistTabId = pl.id;
                    localStorage.setItem('activePlaylistTabId', pl.id);
                    window.MusicPlayer.updatePlaylistsUI();
                });
                
                playlistsTabsContainer.appendChild(tab);
                
                const textWidth = nameSpan.scrollWidth;
                const containerWidth = nameWrapper.clientWidth;
                if (textWidth > containerWidth) {
                    const scrollDist = textWidth - containerWidth;
                    tab.style.setProperty('--scroll-dist', `-${scrollDist}px`);
                    tab.classList.add('has-marquee');
                }
            });
        }
    } else {
        playlistsTabsContainer.querySelectorAll('.playlist-tab').forEach(tab => {
            const plId = tab.getAttribute('data-id');
            if (plId === activePlaylistTabId) {
                tab.classList.add('active');
            } else {
                tab.classList.remove('active');
            }
        });
    }

    if (!activePlaylistTabId) {
        activePlaylistContent.innerHTML = `<div class="no-playlists" data-i18n="no_playlists">${window.MusicPlayer.t('no_playlists') || 'Aucune playlist disponible'}</div>`;
        activePlaylistContent.removeAttribute('data-playlist-id');
        return;
    }

    const playlist = state.playlists.find(p => p.id === activePlaylistTabId);
    if (!playlist) {
        activePlaylistContent.innerHTML = `<div class="no-playlists" data-i18n="no_playlists">${window.MusicPlayer.t('no_playlists') || 'Aucune playlist disponible'}</div>`;
        activePlaylistContent.removeAttribute('data-playlist-id');
        return;
    }

    const isDifferentPlaylist = activePlaylistContent.getAttribute('data-playlist-id') !== playlist.id;
    
    let headerDiv;
    let nameInput;
    let deleteBtn;
    let tracksListDiv;

    if (isDifferentPlaylist) {
        activePlaylistContent.innerHTML = '';
        activePlaylistContent.setAttribute('data-playlist-id', playlist.id);

        headerDiv = document.createElement('div');
        headerDiv.className = 'playlist-header';

        const nameContainer = document.createElement('div');
        nameContainer.className = 'playlist-name-container';

        nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.id = `playlist-name-input-${playlist.id}`;
        nameInput.name = `playlist_name_${playlist.id}`;
        nameInput.className = 'playlist-name-input';
        nameInput.value = playlist.name;
        nameInput.placeholder = 'Nom de la playlist';
        nameInput.dataset.tooltip = (window.MusicPlayer.t && window.MusicPlayer.t('tooltip_click_to_rename')) || 'Cliquez pour renommer';
        nameInput.dataset.i18nTooltip = 'tooltip_click_to_rename';
        nameInput.setAttribute('autocomplete', 'off');
        
        const deleteProgressBar = document.createElement('div');
        deleteProgressBar.className = 'playlist-delete-progress';

        nameContainer.appendChild(nameInput);
        nameContainer.appendChild(deleteProgressBar);
        
        const handleSaveName = () => {
            const newName = nameInput.value.trim();
            if (newName && newName !== playlist.name) {
                playlist.name = newName;
                const tabSpan = playlistsTabsContainer.querySelector(`.playlist-tab[data-playlist-id="${playlist.id}"] .playlist-tab-name`);
                if (tabSpan) tabSpan.textContent = newName;

                window.MusicPlayer.sendWS({
                    type: 'renamePlaylist',
                    data: { playlistId: playlist.id, name: newName }
                });
            }
        };

        nameInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.keyCode === 13) {
                e.preventDefault();
                handleSaveName();
                nameInput.blur();
            }
        });
        nameInput.addEventListener('change', handleSaveName);
        nameInput.addEventListener('blur', handleSaveName);

        deleteBtn = document.createElement('button');
        deleteBtn.className = 'delete-playlist-btn';
        // data-hold-key : le système de tooltip y injecte la durée courante.
        // data-i18n-tooltip : le libellé suit aussi les changements de langue.
        deleteBtn.dataset.holdKey = 'playlist';
        deleteBtn.dataset.i18nTooltip = 'tooltip_hold_delete_playlist';
        deleteBtn.dataset.tooltip = (window.MusicPlayer.t && window.MusicPlayer.t('tooltip_hold_delete_playlist')) || 'Maintenir 1.5s pour supprimer la playlist';
        deleteBtn.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon-trash">
                <polyline points="3 6 5 6 21 6"></polyline>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            </svg>
        `;

        let deleteHoldTimer = null;
        let deleteStartTimestamp = null;

        function startDeleteHolding(e) {
            e.preventDefault();
            stopDeleteHolding();

            const currentSettings = window.MusicPlayer.dashboardSettings || {};
            const deleteDurationSec = (currentSettings.holdDuration && currentSettings.holdDuration.playlist !== undefined) ? parseFloat(currentSettings.holdDuration.playlist) : 1.5;
            const deleteDuration = deleteDurationSec * 1000;

            // Le tooltip est calculé à l'affichage (data-hold-key) : rien à
            // réécrire ici, sous peine de figer une valeur périmée.

            deleteStartTimestamp = Date.now();
            deleteBtn.classList.add('holding');

            deleteHoldTimer = setInterval(() => {
                const elapsed = Date.now() - deleteStartTimestamp;
                const percent = Math.min(100, (elapsed / deleteDuration) * 100);

                if (deleteProgressBar) {
                    deleteProgressBar.style.width = `${percent}%`;
                }

                if (elapsed >= deleteDuration) {
                    stopDeleteHolding();
                    window.MusicPlayer.sendWS({
                        type: 'deletePlaylist',
                        data: { playlistId: playlist.id }
                    });
                }
            }, 40);
        }

        function stopDeleteHolding() {
            if (deleteHoldTimer) {
                clearInterval(deleteHoldTimer);
                deleteHoldTimer = null;
            }
            deleteBtn.classList.remove('holding');
            if (deleteProgressBar) {
                deleteProgressBar.style.width = '0%';
            }
            deleteStartTimestamp = null;
        }

        deleteBtn.addEventListener('mousedown', startDeleteHolding);
        deleteBtn.addEventListener('mouseleave', stopDeleteHolding);
        deleteBtn.addEventListener('mouseup', stopDeleteHolding);

        deleteBtn.addEventListener('touchstart', startDeleteHolding, { passive: false });
        deleteBtn.addEventListener('touchend', stopDeleteHolding, { passive: true });
        deleteBtn.addEventListener('touchcancel', stopDeleteHolding, { passive: true });

        deleteBtn.addEventListener('click', (e) => {
            e.preventDefault();
        });

        headerDiv.appendChild(nameContainer);
        headerDiv.appendChild(deleteBtn);
        activePlaylistContent.appendChild(headerDiv);

        tracksListDiv = document.createElement('div');
        tracksListDiv.className = 'playlist-tracks-list';
        tracksListDiv.id = 'playlist-tracks-list';

        tracksListDiv.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';

            window.MusicPlayer.updateListDisplacementPreview(
                tracksListDiv,
                '.playlist-track-item',
                window.MusicPlayer.activeDragData,
                e.clientY
            );
        });

        tracksListDiv.addEventListener('dragleave', (e) => {
            const rect = tracksListDiv.getBoundingClientRect();
            if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) {
                window.MusicPlayer.resetListDisplacement(tracksListDiv, '.playlist-track-item');
                tracksListDiv.classList.remove('drag-over');
            }
        });

        tracksListDiv.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const rawInsertionIndex = window.MusicPlayer.updateListDisplacementPreview(
                tracksListDiv,
                '.playlist-track-item',
                window.MusicPlayer.activeDragData,
                e.clientY
            );

            window.MusicPlayer.resetListDisplacement(tracksListDiv, '.playlist-track-item');
            if (typeof window.MusicPlayer.clearAllDragIndicators === 'function') {
                window.MusicPlayer.clearAllDragIndicators();
            }

            const playlistLen = playlist.tracks ? playlist.tracks.length : 0;
            const finalTargetIdx = (typeof rawInsertionIndex === 'number') ? rawInsertionIndex : playlistLen;

            if (window.MusicPlayer.isFileDrag(e) && e.dataTransfer.files.length > 0) {
                window.MusicPlayer.handleDroppedFiles(e.dataTransfer.files, { playlistId: playlist.id, targetIndex: finalTargetIdx });
                return;
            }

            try {
                const dragDataStr = e.dataTransfer.getData('application/json');
                let dragData = null;
                if (dragDataStr) {
                    try { dragData = JSON.parse(dragDataStr); } catch (err) {}
                }
                if (!dragData) dragData = window.MusicPlayer.activeDragData;
                if (!dragData || !dragData.source) return;

                if (dragData.source === 'playlist_track') {
                    if (dragData.playlistId !== playlist.id) {
                        window.MusicPlayer.handleTrackDropOnPlaylist(playlist.id, dragData, finalTargetIdx);
                        return;
                    }

                    const fromIndex = dragData.fromIndex;
                    const finalIndex = finalTargetIdx > fromIndex ? finalTargetIdx - 1 : finalTargetIdx;

                    if (fromIndex !== finalIndex && typeof fromIndex === 'number') {
                        window.MusicPlayer.sendWS({
                            type: 'movePlaylistTrack',
                            data: {
                                playlistId: playlist.id,
                                fromIndex: fromIndex,
                                toIndex: finalIndex
                            }
                        });
                    }
                } else {
                    window.MusicPlayer.handleTrackDropOnPlaylist(playlist.id, dragData, finalTargetIdx);
                }
            } catch (err) {
                console.error('[PlaylistTracksListDrop] Erreur:', err);
            }
        });

        activePlaylistContent.appendChild(tracksListDiv);
    } else {
        nameInput = activePlaylistContent.querySelector('.playlist-name-input');
        if (nameInput && document.activeElement !== nameInput && nameInput.value !== playlist.name) {
            nameInput.value = playlist.name;
        }
        tracksListDiv = activePlaylistContent.querySelector('#playlist-tracks-list');
    }

    const tracksStructJson = JSON.stringify((playlist.tracks || []).map(t => ({ title: t.title, url: t.url, duration: t.duration, thumbnail: t.thumbnail })));
    const activePlayingSource = state.activePlaybackSource;
    const currentIdx = state.playlistCurrentIndex;
    const tracksStateKey = `${tracksStructJson}|${activePlayingSource}|${currentIdx}`;

    if (tracksListDiv && tracksListDiv._lastTracksStateKey !== tracksStateKey) {
        tracksListDiv._lastTracksStateKey = tracksStateKey;
        tracksListDiv.innerHTML = '';

        if (playlist.tracks && playlist.tracks.length > 0) {
            playlist.tracks.forEach((track, index) => {
                const item = document.createElement('div');
                item.className = 'playlist-track-item';
                
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
                window.MusicPlayer.attachQualityMenu(item, () => {
                    const pl = (window.MusicPlayer.state.playlists || []).find(p => p.id === playlist.id);
                    return pl && (pl.tracks || [])[index];
                });

                const isCurrentPlayingSource = state.activePlaybackSource === playlist.id && state.playlistCurrentIndex === index;
                if (isCurrentPlayingSource) {
                    item.classList.add('playing-active', 'is-playing-now');
                }

                item.setAttribute('draggable', 'true');
                item.setAttribute('data-index', index);
                // L'URL sert à retrouver la ligne d'un morceau sans repasser
                // par l'index : pendant un enchaînement mix, deux titres jouent
                // en même temps et l'index du serveur n'en désigne qu'un.
                item.setAttribute('data-url', track.url || '');

                item.addEventListener('dragstart', (e) => {
                    item.classList.add('is-dragging');
                    document.body.classList.add('is-dragging-active');
                    window.MusicPlayer.activeDragData = {
                        sourceContainerId: 'playlist-tracks-list',
                        source: 'playlist_track',
                        playlistId: playlist.id,
                        fromIndex: index,
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

                    const logMsg = `[DragStart PlaylistTrack] Début de glissement depuis playlist "${playlist.name}" : "${track.title}" (${track.url})`;
                    console.log(logMsg);
                    if (typeof window.MusicPlayer.sendWS === 'function') {
                        window.MusicPlayer.sendWS({ type: 'clientLog', data: { source: 'DragDrop-PlaylistTrack', message: logMsg } });
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

                const leftDiv = document.createElement('div');
                leftDiv.className = 'track-left';

                // Numéro et icône de lecture coexistent dans le DOM ; c'est la
                // classe `is-playing-now` qui décide lequel se montre. Sans
                // cela, allumer une ligne en cours de fondu demanderait de
                // réécrire son contenu image par image.
                const idxSpan = document.createElement('span');
                idxSpan.className = 'track-idx';
                idxSpan.innerHTML = `
                    <span class="track-idx-num">#${index + 1}</span>
                    <svg class="track-idx-play" viewBox="0 0 24 24" fill="currentColor">
                        <polygon points="5 3 19 12 5 21 5 3"></polygon>
                    </svg>
                `;
                leftDiv.appendChild(idxSpan);

                if (track.thumbnail) {
                    const thumbImg = document.createElement('img');
                    thumbImg.className = 'track-thumb';
                    thumbImg.src = track.thumbnail;
                    thumbImg.alt = 'Cover';
                    thumbImg.setAttribute('draggable', 'false');
                    leftDiv.appendChild(thumbImg);
                }

                const titleSpan = document.createElement('span');
                titleSpan.className = 'track-title';
                titleSpan.textContent = track.title;
                titleSpan.dataset.tooltip = track.title;
                leftDiv.appendChild(titleSpan);

                const rightDiv = document.createElement('div');
                rightDiv.className = 'track-right';

                const durSpan = document.createElement('span');
                durSpan.className = 'track-duration';
                durSpan.textContent = track.duration;
                rightDiv.appendChild(durSpan);

                const playBtn = document.createElement('button');
                playBtn.className = 'track-play-btn';
                playBtn.dataset.tooltip = (window.MusicPlayer.t && window.MusicPlayer.t('tooltip_play_from_here')) || 'Jouer maintenant à partir de ce morceau';
        playBtn.dataset.i18nTooltip = 'tooltip_play_from_here';
                playBtn.innerHTML = `
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <polygon points="5 3 19 12 5 21 5 3"></polygon>
                    </svg>
                `;
                playBtn.addEventListener('click', () => {
                    window.MusicPlayer.sendWS({
                        type: 'setActivePlaybackSource',
                        data: {
                            source: playlist.id,
                            index: index
                        }
                    });
                });
                rightDiv.appendChild(playBtn);

                const removeBtn = document.createElement('button');
                removeBtn.className = 'track-remove-btn';
                removeBtn.dataset.tooltip = (window.MusicPlayer.t && window.MusicPlayer.t('tooltip_delete_from_playlist')) || 'Supprimer de la playlist';
        removeBtn.dataset.i18nTooltip = 'tooltip_delete_from_playlist';
                removeBtn.innerHTML = `
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon-trash">
                        <polyline points="3 6 5 6 21 6"></polyline>
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                    </svg>
                `;
                removeBtn.addEventListener('click', () => {
                    window.MusicPlayer.sendWS({
                        type: 'removeTrackFromPlaylist',
                        data: { playlistId: playlist.id, index: index }
                    });
                });
                rightDiv.appendChild(removeBtn);

                item.appendChild(leftDiv);
                item.appendChild(rightDiv);
                tracksListDiv.appendChild(item);
            });
        } else {
            const emptyDiv = document.createElement('div');
            emptyDiv.className = 'no-playlists';
            emptyDiv.textContent = window.MusicPlayer.t('no_playlist_tracks') || 'Playlist vide';
            emptyDiv.setAttribute('data-i18n', 'no_playlist_tracks');
            tracksListDiv.appendChild(emptyDiv);
        }
    }

    // Mise à jour en place des barres de préchargement / de progression (sans reconstruction du DOM)
    if (tracksListDiv && playlist.tracks && playlist.tracks.length > 0) {
        const items = tracksListDiv.querySelectorAll('.playlist-track-item');
        const isCurrentPlaylistActive = state.activePlaybackSource === playlist.id;
        const currentIdx = typeof state.playlistCurrentIndex === 'number' ? state.playlistCurrentIndex : 0;
        const progressPct = state.progress && typeof state.progress.percent === 'number' ? state.progress.percent : 0;

        // Désigner la playlist comme source ne coupe pas ce qui joue : le
        // morceau en cours poursuit sa lecture jusqu'à son terme. L'index de la
        // playlist désigne alors le titre qui prendra la suite, pas celui qu'on
        // entend — et la progression affichée serait celle d'un autre fichier.
        // Seule l'URL réellement en lecture peut donc allumer une ligne.
        const urlEnLecture = state.currentTrack ? state.currentTrack.url : null;

        // Pendant un enchaînement mix, deux titres sonnent ensemble : l'index
        // du serveur, qui n'avance qu'au terme du fondu, ne désigne que le
        // sortant. La transition dit lequel s'achève et lequel démarre.
        const transition = isCurrentPlaylistActive && typeof window.MusicPlayer.mixTransitionState === 'function'
            ? window.MusicPlayer.mixTransitionState()
            : null;

        playlist.tracks.forEach((track, i) => {
            const item = items[i];
            if (!item) return;
            const fillBar = item.querySelector('.preload-fill-bar');
            let playbackBar = item.querySelector('.playback-fill-bar');
            if (!playbackBar) {
                playbackBar = document.createElement('div');
                playbackBar.className = 'playback-fill-bar';
                playbackBar.style.width = '100%';
                item.appendChild(playbackBar);
            }
            
            const isPreloaded = !!track.isPreloaded;
            const isPreloading = !!track.isPreloading;
            const preloadPct = isPreloaded ? 100 : (track.preloadProgress || 0);

            let isPlayed = false;
            let isPlayingNow = false;

            if (fillBar) {
                const safeScale = Math.max(0.0001, preloadPct / 100);
                fillBar.style.width = '100%';
                fillBar.style.transform = `scaleX(${preloadPct / 100})`;
                fillBar.style.setProperty('--progress-scale', safeScale);
            }

            if (isCurrentPlaylistActive) {
                // Ratio de lecture de cette ligne, s'il y en a un : d'abord le
                // fondu en cours, qui en anime deux, sinon l'index du serveur.
                let ratio = null;
                if (transition) {
                    if (areUrlsEqual(track.url, transition.incoming.url)) {
                        ratio = transition.incoming.ratio;
                    } else if (transition.outgoing && areUrlsEqual(track.url, transition.outgoing.url)) {
                        ratio = transition.outgoing.ratio;
                    }
                }
                if (ratio === null && !transition && i === currentIdx
                    && areUrlsEqual(track.url, urlEnLecture)) {
                    ratio = progressPct / 100;
                }

                if (ratio !== null) {
                    isPlayingNow = true;
                    playbackBar.style.transform = `scaleX(${ratio})`;
                    playbackBar.style.setProperty('--playback-scale', Math.max(0.0001, ratio));
                } else {
                    // Le titre entrant d'un rebouclage précède l'index courant
                    // sans être pour autant déjà écouté.
                    isPlayed = i < currentIdx;
                    playbackBar.style.transform = 'scaleX(0)';
                }
            } else {
                playbackBar.style.transform = 'scaleX(0)';
            }

            item.classList.toggle('is-played', isPlayed);
            item.classList.toggle('is-playing-now', isPlayingNow);
            item.classList.toggle('is-preloaded', isPreloaded);
            item.classList.toggle('is-preloading', isPreloading);
            window.MusicPlayer.applyRequalifyState(item, track);
        });
    }

    window.MusicPlayer.refreshTrackQualityMenu();
};

/** Dernier enchaînement mix observé, pour en détecter le début et la fin. */
let lastMixTransition = null;

function appliquerBarreLecture(item, ratio) {
    const clamp = Math.min(1, Math.max(0, ratio));
    let playbackBar = item.querySelector('.playback-fill-bar');
    if (!playbackBar) {
        playbackBar = document.createElement('div');
        playbackBar.className = 'playback-fill-bar';
        playbackBar.style.width = '100%';
        item.appendChild(playbackBar);
    }
    playbackBar.style.transform = `scaleX(${clamp})`;
    playbackBar.style.setProperty('--playback-scale', Math.max(0.0001, clamp));
}

/**
 * Anime la progression dans la playlist affichée, à la cadence de l'écran.
 *
 * Hors transition, une seule ligne avance. Pendant un enchaînement mix, deux
 * morceaux sonnent ensemble : la ligne sortante poursuit sa course jusqu'à sa
 * fin, l'entrante commence la sienne. Le rendu complet ne passant qu'une fois
 * par seconde, c'est ici que les deux lignes s'allument et s'éteignent, à
 * l'instant près.
 */
window.MusicPlayer.updateActivePlaylistTrackProgress = function(ratio) {
    const listEl = document.getElementById('playlist-tracks-list');
    if (!listEl) return;

    const state = window.MusicPlayer.state || {};
    const content = document.getElementById('active-playlist-content');
    const playlistAffichee = content ? content.getAttribute('data-playlist-id') : null;
    const afficheLaSource = !!playlistAffichee && playlistAffichee === state.activePlaybackSource;

    const transition = afficheLaSource && typeof window.MusicPlayer.mixTransitionState === 'function'
        ? window.MusicPlayer.mixTransitionState()
        : null;

    if (!transition) {
        // Fin du fondu : la ligne sortante s'éteint sur-le-champ, sans
        // attendre que le serveur ait fait avancer son index de lecture.
        if (lastMixTransition) {
            const urlEntrante = lastMixTransition.incoming.url;
            listEl.querySelectorAll('.playlist-track-item.is-playing-now').forEach(item => {
                if (!areUrlsEqual(item.getAttribute('data-url'), urlEntrante)) {
                    item.classList.remove('is-playing-now', 'playing-active');
                    appliquerBarreLecture(item, 0);
                }
            });
            lastMixTransition = null;
        }

        const active = listEl.querySelector('.playlist-track-item.is-playing-now');
        if (active) appliquerBarreLecture(active, ratio);
        return;
    }

    // Début du fondu : la ligne entrante s'allume immédiatement.
    const key = (t) => `${t.outgoing ? t.outgoing.url : ''}|${t.incoming.url}`;
    const startIdx = !lastMixTransition || key(lastMixTransition) !== key(transition);
    if (startIdx) {
        listEl.querySelectorAll('.playlist-track-item').forEach(item => {
            const url = item.getAttribute('data-url');
            const concernee = areUrlsEqual(url, transition.incoming.url)
                || (transition.outgoing && areUrlsEqual(url, transition.outgoing.url));
            if (concernee) {
                item.classList.add('playing-active', 'is-playing-now');
                item.classList.remove('is-played');
            }
        });
    }
    lastMixTransition = transition;

    listEl.querySelectorAll('.playlist-track-item.is-playing-now').forEach(item => {
        const url = item.getAttribute('data-url');
        if (areUrlsEqual(url, transition.incoming.url)) {
            appliquerBarreLecture(item, transition.incoming.ratio);
        } else if (transition.outgoing && areUrlsEqual(url, transition.outgoing.url)) {
            appliquerBarreLecture(item, transition.outgoing.ratio);
        } else {
            // Une transition en cours ne laisse jouer que ses deux morceaux :
            // toute autre ligne s'éteint. C'est par là que passe la sortante
            // une fois son fondu achevé, sans attendre le rendu complet.
            item.classList.remove('is-playing-now', 'playing-active');
            appliquerBarreLecture(item, 0);
        }
    });
};

window.MusicPlayer.initPlaylists = function() {
    const btnAddPlaylist = document.getElementById('btn-add-playlist');
    const playlistCreateModal = document.getElementById('playlist-create-modal');
    const inputCreatePlaylistName = document.getElementById('input-create-playlist-name');
    const btnCreatePlaylistConfirm = document.getElementById('btn-create-playlist-confirm');
    const btnCreatePlaylistCancel = document.getElementById('btn-create-playlist-cancel');
    const playbackSourceSelect = document.getElementById('playback-source-select');

    if (playbackSourceSelect) {
        playbackSourceSelect.addEventListener('change', (e) => {
            const val = e.target.value;
            window.MusicPlayer.sendWS({
                type: 'setActivePlaybackSource',
                data: { source: val }
            });
        });
    }

    function closePlaylistCreateModal() {
        if (playlistCreateModal) {
            playlistCreateModal.classList.add('hidden');
        }
        if (inputCreatePlaylistName) {
            inputCreatePlaylistName.value = '';
        }
    }

    if (btnAddPlaylist) {
        btnAddPlaylist.addEventListener('click', () => {
            if (playlistCreateModal) {
                playlistCreateModal.classList.remove('hidden');
                if (inputCreatePlaylistName) {
                    inputCreatePlaylistName.focus();
                }
            }
        });
    }

    if (btnCreatePlaylistCancel) {
        btnCreatePlaylistCancel.addEventListener('click', () => {
            closePlaylistCreateModal();
        });
    }

    function submitNewPlaylist() {
        if (inputCreatePlaylistName) {
            const name = inputCreatePlaylistName.value.trim();
            window.MusicPlayer.sendWS({
                type: 'createPlaylist',
                data: { name: name || 'Nouvelle Playlist' }
            });
            closePlaylistCreateModal();
        }
    }

    if (btnCreatePlaylistConfirm) {
        btnCreatePlaylistConfirm.addEventListener('click', () => {
            submitNewPlaylist();
        });
    }

    if (inputCreatePlaylistName) {
        inputCreatePlaylistName.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                submitNewPlaylist();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                closePlaylistCreateModal();
            }
        });
    }

    const playlistsCard = document.getElementById('playlists-card');
    if (playlistsCard && !playlistsCard._dragBound) {
        playlistsCard._dragBound = true;
        playlistsCard.addEventListener('dragover', (e) => {
            const dragData = window.MusicPlayer.activeDragData;
            if (dragData && dragData.source === 'playlist_tab') {
                return;
            }
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
            playlistsCard.classList.add('drag-over');
        });

        playlistsCard.addEventListener('dragleave', (e) => {
            const rect = playlistsCard.getBoundingClientRect();
            if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) {
                playlistsCard.classList.remove('drag-over');
            }
        });

        playlistsCard.addEventListener('drop', (e) => {
            const dragData = window.MusicPlayer.activeDragData;
            if (dragData && dragData.source === 'playlist_tab') return;
            if (e.target.closest('.playlist-tab') || e.target.closest('#playlist-tracks-list')) return;
            e.preventDefault();
            playlistsCard.classList.remove('drag-over');

            if (window.MusicPlayer.isFileDrag(e) && e.dataTransfer.files.length > 0) {
                const targetPlId = activePlaylistTabId || (window.MusicPlayer.state.playlists?.[0]?.id);
                if (targetPlId) {
                    window.MusicPlayer.handleDroppedFiles(e.dataTransfer.files, { playlistId: targetPlId });
                } else {
                    window.MusicPlayer.handleDroppedFiles(e.dataTransfer.files, { target: 'playlist' });
                }
                return;
            }

            try {
                let dragDataStr = e.dataTransfer.getData('application/json');
                let dragData = null;
                if (dragDataStr) {
                    try { dragData = JSON.parse(dragDataStr); } catch (err) {}
                }
                if (!dragData) dragData = window.MusicPlayer.activeDragData;

                const targetPlId = activePlaylistTabId || (window.MusicPlayer.state.playlists?.[0]?.id);
                const logMsg = `[DragDrop PlaylistsCard] Dépôt reçu sur la carte des playlists (ID: ${targetPlId}). Morceau: "${dragData ? dragData.title : 'inconnu'}"`;
                console.log(logMsg);
                if (typeof window.MusicPlayer.sendWS === 'function') {
                    window.MusicPlayer.sendWS({ type: 'clientLog', data: { source: 'DragDrop-PlaylistsCard', message: logMsg } });
                }

                if (dragData) {
                    window.MusicPlayer.handleTrackDropOnPlaylist(targetPlId || null, dragData);
                }
            } catch (err) {
                console.error('[PlaylistsCardDrop] Erreur:', err);
            }
        });
    }
};

window.MusicPlayer.getActivePlaylistTabId = function() {
    return activePlaylistTabId;
};
