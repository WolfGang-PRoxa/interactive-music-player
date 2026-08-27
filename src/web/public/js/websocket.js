/**
 * WebSocket Connection & Network Helper
 */

window.MusicPlayer = window.MusicPlayer || {};

window.MusicPlayer.socket = null;
window.MusicPlayer.reconnectTimeout = null;

window.MusicPlayer.sendWS = function(payload) {
    if (window.MusicPlayer.socket && window.MusicPlayer.socket.readyState === WebSocket.OPEN) {
        if (window.MusicPlayer.currentGuildId && !payload.guildId) {
            payload.guildId = window.MusicPlayer.currentGuildId;
        }
        window.MusicPlayer.socket.send(JSON.stringify(payload));
    }
};

window.MusicPlayer.connectWebSocket = function(onMessageCallback, hooks = {}) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;

    if (window.MusicPlayer.socket) {
        try { window.MusicPlayer.socket.close(); } catch(e) {}
    }

    window.MusicPlayer.socket = new WebSocket(wsUrl);

    window.MusicPlayer.socket.onopen = function () {
        console.log('[Dashboard] Connected to the WebSocket server.');
        const statusDot = document.querySelector('.status-dot');
        const statusText = document.querySelector('.status-text');
        if (statusDot) statusDot.className = 'status-dot green';
        if (statusText) statusText.textContent = window.MusicPlayer.t('status_connected') || 'Connecté';

        window.MusicPlayer.sendWS({ type: 'requestState' });
        if (typeof hooks.onOpen === 'function') hooks.onOpen();
    };

    window.MusicPlayer.socket.onmessage = function (event) {
        try {
            if (event.data && typeof event.data.length === 'number') {
                if (typeof window.MusicPlayer.trackNetworkBytes === 'function') {
                    window.MusicPlayer.trackNetworkBytes(event.data.length);
                }
            }
            const data = JSON.parse(event.data);
            if (typeof onMessageCallback === 'function') onMessageCallback(data);
        } catch (e) {
            console.error('[Dashboard] Error parsing WS message:', e);
        }
    };

    window.MusicPlayer.socket.onclose = function () {
        console.warn('[Dashboard] WebSocket connection closed. Attempting to reconnect...');
        const statusDot = document.querySelector('.status-dot');
        const statusText = document.querySelector('.status-text');
        if (statusDot) statusDot.className = 'status-dot red';
        if (statusText) statusText.textContent = window.MusicPlayer.t('status_disconnected') || 'Déconnecté';

        clearTimeout(window.MusicPlayer.reconnectTimeout);
        window.MusicPlayer.reconnectTimeout = setTimeout(() => {
            window.MusicPlayer.connectWebSocket(onMessageCallback, hooks);
        }, 3000);
        if (typeof hooks.onClose === 'function') hooks.onClose();
    };

    window.MusicPlayer.socket.onerror = function (err) {
        console.error('[Dashboard] WebSocket error:', err);
    };
};
