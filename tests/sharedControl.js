/**
 * Vérifie la barrière du contrôle partagé.
 *
 * Le maître de session peut confier une partie du bot à des membres du salon
 * vocal : mener la lecture, garnir la file, tenir les playlists, régler le
 * volume. Le tableau de bord d'un invité grise ce qu'il n'a pas le droit de
 * faire, mais cet affichage ne protège rien — la console du navigateur envoie
 * le message qu'elle veut. La seule barrière est celle du serveur, et c'est
 * elle que ce test surveille.
 *
 * Les garanties à ne jamais reperdre :
 *
 *   - le maître peut tout, y compris ce qui éteint le bot ;
 *   - un invité ne peut que ce qui lui a été explicitement accordé ;
 *   - une commande absente de la table est refusée, et non permise : une
 *     fonctionnalité ajoutée sans y penser doit être fermée par défaut ;
 *   - `updateSettings` mêle des réglages de plusieurs groupes et se filtre
 *     champ par champ, sans jamais laisser passer un réglage du maître ;
 *   - un invité ne peut pas s'accorder de droits à lui-même ;
 *   - retirer le dernier droit efface l'invité de la table plutôt que d'y
 *     laisser quatre `false`.
 */

let failed = 0;
let passed = 0;
const check = (label, ok, detail = '') => {
    if (ok) { passed++; console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`); }
    else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

/** Remplace un module par un double avant que quiconque ne le charge. */
function stub(filePath, exports) {
    const resolved = require.resolve(filePath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

stub('../src/utils/logger', {
    info() {}, warn() {}, error() {}, success() {}, debug() {}, getHistory: () => [],
});

// La vraie base, mais coupée du disque : sans ce double elle lirait — et
// réécrirait — le settings.json de l'utilisateur.
stub('../src/utils/atomicJson', {
    readJsonSafe: () => null,
    writeJsonAtomic: () => {},
    cleanStaleTemp: () => {},
});

const permissions = require('../src/web/permissions');
const database = require('../src/database/Database');
const routes = require('../src/web/websocket/handlers');

const GUILD = 'guilde-test';
const PAUL = '111111111111111111';

const MASTER = { master: true };
const invite = (rights) => ({ master: false, permissions: permissions.sanitize(rights) });

console.log('Shared control — the rights barrier\n');

// ───────────────────── 1. Le maître n'est bridé par rien ─────────────────────

console.log('=== 1. The master ===\n');

check('the master can shut the bot down', permissions.canSend(MASTER, 'shutdownBot'));
check('the master can change version', permissions.canSend(MASTER, 'installVersion'));
check('the master can share control', permissions.canSend(MASTER, 'shareControl'));
check('the master keeps all their settings',
    Object.keys(permissions.filterSettings(MASTER, { baseVolume: 20, preloading: {} }).allowed).length === 2);

// ─────────────────── 2. Un invité n'a que ce qu'on lui donne ───────────────────

console.log('\n=== 2. The groups ===\n');

const player = invite({ playback: true });
check('playback granted: pause', permissions.canSend(player, 'pause'));
check('playback granted: seek within the track', permissions.canSend(player, 'seek'));
check('playback only: no clearing the queue', !permissions.canSend(player, 'clearQueue'));
check('playback only: no deleting a playlist', !permissions.canSend(player, 'deletePlaylist'));
check('playback only: no changing channel', !permissions.canSend(player, 'selectChannel'));

const queueGuest = invite({ queue: true });
check('queue granted: add from the search', permissions.canSend(queueGuest, 'play'));
check('queue granted: play immediately', permissions.canSend(queueGuest, 'playNow'));
check('queue granted: clear the history', permissions.canSend(queueGuest, 'clearHistory'));
check('queue only: no pausing', !permissions.canSend(queueGuest, 'pause'));

const playlistGuest = invite({ playlists: true });
check('playlists granted: create', permissions.canSend(playlistGuest, 'createPlaylist'));
check('playlists granted: add a track to one', permissions.canSend(playlistGuest, 'addTrackToPlaylist'));
check('playlists only: no removing from the queue', !permissions.canSend(playlistGuest, 'removeTrack'));

const volumeGuest = invite({ volume: true });
check('volume granted: change channel', permissions.canSend(volumeGuest, 'selectChannel'));
check('volume granted: mute detection for a member', permissions.canSend(volumeGuest, 'toggleVoiceDetection'));
check('volume only: no skipping a track', !permissions.canSend(volumeGuest, 'skip'));

const none = invite({});
check('without any right: none of this',
    !['pause', 'play', 'createPlaylist', 'selectChannel'].some((t) => permissions.canSend(none, t)));

// ─────────────────────── 3. Ce qui reste au maître seul ───────────────────────

console.log('\n=== 3. Master only ===\n');

const allPowerful = invite({ playback: true, queue: true, playlists: true, volume: true });
for (const forbidden of ['shutdownBot', 'restartBot', 'installVersion', 'uninstallVersion',
    'listVersions', 'leaveGuild', 'setDefaultChannel']) {
    check(`a fully granted guest still cannot « ${forbidden} »`, !permissions.canSend(allPowerful, forbidden));
}
check('a guest does not grant themselves rights', !permissions.canSend(allPowerful, 'shareControl'));
check('a guest revokes nobody', !permissions.canSend(allPowerful, 'revokeControl'));
check('a guest does not post the invitation link', !permissions.canSend(allPowerful, 'sendInviteLink'));

// ──────────────────────── 4. Fermé par défaut ────────────────────────

console.log('\n=== 4. Commande inconnue ===\n');

check('a command absent from the table is refused',
    !permissions.canSend(allPowerful, 'commandAddedLater'));
check('every declared route has a matching right',
    Object.keys(routes).every((type) =>
        Object.prototype.hasOwnProperty.call(permissions.ACTION_GROUPS, type)),
    `${Object.keys(routes).length} routes`);
check('every declared right matches a route',
    Object.keys(permissions.ACTION_GROUPS).every((type) => Boolean(routes[type])));

// ─────────────────── 5. updateSettings, champ par champ ───────────────────

console.log('\n=== 5. Filtering the settings ===\n');

const mixed = {
    baseVolume: 20,          // groupe volume
    duckingLevel: 35,        // groupe volume
    playbackSpeed: 1.5,      // groupe playback
    preloading: { enabled: false },   // maître seul
    presenceDepartureDelay: 0,        // maître seul
};

const volumeFilter = permissions.filterSettings(volumeGuest, mixed);
check('volume granted: baseVolume goes through', volumeFilter.allowed.baseVolume === 20);
check('volume granted: duckingLevel goes through', volumeFilter.allowed.duckingLevel === 35);
check('volume granted: playbackSpeed dropped', volumeFilter.allowed.playbackSpeed === undefined);
check('volume granted: preloading dropped', volumeFilter.allowed.preloading === undefined);
check('volume granted: start delay dropped', volumeFilter.allowed.presenceDepartureDelay === undefined);
check('the refused fields are named', volumeFilter.refused.includes('preloading'));

const emptyFilter = permissions.filterSettings(none, mixed);
check('without any right: nothing goes through at all', Object.keys(emptyFilter.allowed).length === 0);

check('the gate lets updateSettings in, the filter decides',
    permissions.canSend(none, 'updateSettings'));

// ─────────────────── 6. Enregistrement et révocation ───────────────────

console.log('\n=== 6. Storing the rights ===\n');

check('unknown: no rights',
    !permissions.hasAny(database.getUserPermissions(GUILD, PAUL)));

database.setUserPermissions(GUILD, PAUL, { playback: true, queue: true });
const reloaded = database.getUserPermissions(GUILD, PAUL);
check('rights read back after being saved', reloaded.playback === true && reloaded.queue === true);
check('groups not granted stay false', reloaded.playlists === false && reloaded.volume === false);
check('the guest appears among the shares',
    Object.prototype.hasOwnProperty.call(database.getSharedControl(GUILD), PAUL));

database.setUserPermissions(GUILD, PAUL, { playback: false, queue: false });
check('removing the last right erases the entry',
    !Object.prototype.hasOwnProperty.call(database.getSharedControl(GUILD), PAUL));

database.setUserPermissions(GUILD, PAUL, { volume: true });
database.revokeUserPermissions(GUILD, PAUL);
check('revocation empties the rights',
    !permissions.hasAny(database.getUserPermissions(GUILD, PAUL)));

// Une charge utile venue du réseau n'a pas à être crue sur parole.
const revoked = database.setUserPermissions(GUILD, PAUL, {
    playback: 'oui', queue: 1, playlists: {}, volume: true, master: true, admin: true,
});
check('only a real boolean grants a right',
    revoked.playback === false && revoked.queue === false && revoked.playlists === false);
check('a made-up group is not kept', revoked.master === undefined && revoked.admin === undefined);
check('the legitimate right survives the sanitising', revoked.volume === true);

// ─────────────────────────────── Bilan ───────────────────────────────

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
