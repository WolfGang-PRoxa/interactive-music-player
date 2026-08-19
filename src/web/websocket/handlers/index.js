/**
 * Table de routage des messages WebSocket : type de message → handler.
 *
 * Ajouter un message se fait ici et dans le module concerné, sans toucher au
 * routeur lui-même.
 */

const guildHandlers = require('./guildHandlers');
const playbackHandlers = require('./playbackHandlers');
const queueHandlers = require('./queueHandlers');
const playlistHandlers = require('./playlistHandlers');
const qualityHandlers = require('./qualityHandlers');
const shareHandlers = require('./shareHandlers');
const systemHandlers = require('./systemHandlers');
const versionHandlers = require('./versionHandlers');

module.exports = {
    addPlaylistTrack: playlistHandlers.handleAddPlaylistTrack,
    addTrackToPlaylist: playlistHandlers.handleAddTrackToPlaylist,
    clearHistory: queueHandlers.handleClearHistory,
    clearQueue: queueHandlers.handleClearQueue,
    clientLog: systemHandlers.handleClientLog,
    createPlaylist: playlistHandlers.handleCreatePlaylist,
    deletePlaylist: playlistHandlers.handleDeletePlaylist,
    installVersion: versionHandlers.handleInstallVersion,
    leaveGuild: guildHandlers.handleLeaveGuild,
    listVersions: versionHandlers.handleListVersions,
    memoryStream: systemHandlers.handleMemoryStream,
    moveOrInsertTrack: queueHandlers.handleMoveOrInsertTrack,
    movePlaylistTrack: playlistHandlers.handleMovePlaylistTrack,
    pause: playbackHandlers.handlePause,
    play: playbackHandlers.handlePlay,
    playNow: queueHandlers.handlePlayNow,
    previous: playbackHandlers.handlePrevious,
    removeFromHistory: queueHandlers.handleRemoveFromHistory,
    removeTrack: queueHandlers.handleRemoveTrack,
    removeTrackFromPlaylist: playlistHandlers.handleRemoveTrackFromPlaylist,
    renamePlaylist: playlistHandlers.handleRenamePlaylist,
    reorderPlaylists: playlistHandlers.handleReorderPlaylists,
    requestState: systemHandlers.handleRequestState,
    restartBot: systemHandlers.handleRestartBot,
    resume: playbackHandlers.handleResume,
    revokeControl: shareHandlers.handleRevokeControl,
    seek: playbackHandlers.handleSeek,
    selectChannel: guildHandlers.handleSelectChannel,
    sendInviteLink: shareHandlers.handleSendInviteLink,
    setActivePlaybackSource: playlistHandlers.handleSetActivePlaybackSource,
    setDefaultChannel: guildHandlers.handleSetDefaultChannel,
    setPlayMode: playbackHandlers.handleSetPlayMode,
    setTrackQuality: qualityHandlers.handleSetTrackQuality,
    shareControl: shareHandlers.handleShareControl,
    shutdownBot: systemHandlers.handleShutdownBot,
    skip: playbackHandlers.handleSkip,
    startupFadeinConsumed: systemHandlers.handleStartupFadeinConsumed,
    stop: playbackHandlers.handleStop,
    syncProgress: playbackHandlers.handleSyncProgress,
    toggleVoiceDetection: guildHandlers.handleToggleVoiceDetection,
    uninstallVersion: versionHandlers.handleUninstallVersion,
    updateSettings: guildHandlers.handleUpdateSettings,
};
