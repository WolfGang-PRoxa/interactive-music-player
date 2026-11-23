/**
 * WebSocket Connection & Network Helper
 */

window.MusicPlayer = window.MusicPlayer || {};

window.MusicPlayer.socket = null;
window.MusicPlayer.reconnectTimeout = null;

/**
 * Le bot finit-il de démarrer ?
 *
 * Le serveur s'ouvre avant la connexion à Discord, et le dit par le statut
 * `starting` ; `ready`, ou le premier état reçu, lève la barrière (voir
 * app.js). Entre les deux, seuls passent les messages que le serveur accepte
 * pendant le démarrage — la même liste que `STARTUP_TYPES` dans
 * src/web/websocket/wsHandler.js. Les autres sont retenus ici, et
 * l'utilisateur apprend qu'il faut attendre la fin du lancement.
 */
window.MusicPlayer.botStarting = false;

const WS_STARTUP_TYPES = new Set(['shutdownBot', 'restartBot', 'listVersions', 'clientLog', 'memoryStream']);

/** Envoyés d'eux-mêmes par la page : leur refus n'a rien à dire à personne. */
const WS_SILENT_DURING_STARTUP = new Set(['requestState', 'syncProgress', 'startupFadeinConsumed']);

let wsLastStartupNotice = 0;

function wsNoticeStartupPending() {
  const now = Date.now();
  if (now - wsLastStartupNotice < 2500) return;
  wsLastStartupNotice = now;
  const message =
    (window.MusicPlayer.t && window.MusicPlayer.t('toast_bot_starting')) ||
    'Le bot finit de démarrer : cette action sera disponible dans un instant.';
  if (typeof window.MusicPlayer.showToast === 'function') window.MusicPlayer.showToast(message);
}

window.MusicPlayer.sendWS = function (payload) {
  if (window.MusicPlayer.botStarting && payload && !WS_STARTUP_TYPES.has(payload.type)) {
    if (!WS_SILENT_DURING_STARTUP.has(payload.type)) wsNoticeStartupPending();
    return;
  }
  if (window.MusicPlayer.socket && window.MusicPlayer.socket.readyState === WebSocket.OPEN) {
    if (window.MusicPlayer.currentGuildId && !payload.guildId) {
      payload.guildId = window.MusicPlayer.currentGuildId;
    }
    window.MusicPlayer.socket.send(JSON.stringify(payload));
  }
};

window.MusicPlayer.connectWebSocket = function (onMessageCallback, hooks = {}) {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;

  if (window.MusicPlayer.socket) {
    try {
      window.MusicPlayer.socket.close();
    } catch (e) {}
  }

  window.MusicPlayer.socket = new WebSocket(wsUrl);

  window.MusicPlayer.socket.onopen = function () {
    console.log('[Dashboard] Connected to the WebSocket server.');
    // Le serveur dira tout de suite s'il démarre encore.
    window.MusicPlayer.botStarting = false;
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
