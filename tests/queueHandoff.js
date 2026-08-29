/**
 * Vérifie l'enchaînement playlist → file d'attente.
 *
 * Une playlist met la file d'attente de côté le temps de sa lecture. Sa
 * dernière piste finie, la lecture s'arrêtait sur une file pourtant pleine, que
 * le tableau de bord continuait d'afficher. Deux moitiés se répondent
 * désormais, et aucune ne se voit tant qu'on ne joue pas une playlist jusqu'au
 * bout :
 *
 *   - le serveur (`WebServer.enchainerSurLaFile`) bascule la source et remet la
 *     file en lecture, dans les deux modes de diffusion ;
 *   - le navigateur (`MusicPlayer.pisteSuivante`) prépare le fondu enchaîné sur
 *     le premier titre de cette file, faute de quoi la diffusion personnelle
 *     s'achèverait dans le silence avant que le serveur ne bascule.
 *
 * Les garanties à ne jamais reperdre : la boucle garde la priorité, une file
 * vide laisse la lecture s'arrêter comme avant, et la bascule n'a lieu que
 * depuis une playlist.
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

let failed = 0;
let passed = 0;
const check = (label, ok, detail = '') => {
    if (ok) { passed++; console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`); }
    else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

// ─────────────────────────── Côté serveur ───────────────────────────

/**
 * Remplace un module par un double avant que quiconque ne le charge.
 *
 * WebServer tient à `database` et à `discord-player` ; les charger pour de vrai
 * demanderait une base sur disque et un bot connecté. Le reste de ses
 * dépendances se charge normalement — c'est le meilleur moyen de s'assurer que
 * le fichier testé est bien celui qui tourne en production.
 */
function stub(filePath, exports) {
    const resolved = require.resolve(filePath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

/** Réglages d'un serveur, que le test manipule directement. */
const settings = {};

stub('../src/database/Database', {
    getSettings: () => settings,
    updateSettings: (_guildId, patch) => Object.assign(settings, patch),
    getGlobalPlaylists: () => [
        { id: 'playlist_1', name: 'Essai', tracks: [{ title: 'P1', url: 'http://p/1' }] },
    ],
});

/** File de lecture minimale : ce que `enchainerSurLaFile` en attend. */
function fakeQueue() {
    const queue = {
        guild: { id: 'g1' },
        // Salon où jouer : son absence signe un lecteur démonté, et retient la
        // bascule.
        channel: { id: 'c1' },
        played: null,
        added: [],
        emptied: false,
        tracks: {
            clear() { queue.emptied = true; },
        },
        addTrack(tracks) { queue.added.push(...(Array.isArray(tracks) ? tracks : [tracks])); },
        async play(track) { queue.played = track; },
        // Consultés par `_syncPlaylistToPlayer`, que la relance en boucle
        // emprunte : sans eux, le cas de priorité ne tiendrait qu'au hasard
        // d'une exception avalée par son `.catch()`.
        session: { isFrozen: () => false },
        node: { volume: 80, setVolume() {} },
    };
    return queue;
}

let currentQueue = fakeQueue();

stub('discord-player', {
    // `new Track(player, données)` ne sert qu'à reconstruire une piste depuis sa
    // sauvegarde : le double en garde les champs, seuls consultés ensuite.
    Track: class Track {
        constructor(_player, data) { Object.assign(this, data); }
    },
    useMainPlayer: () => ({
        queues: { get: () => currentQueue, cache: new Map() },
        extractors: { store: { get: () => null } },
    }),
    // Destructurés au chargement par le pont du bus de mixage ; jamais appelés
    // ici, mais leur absence casserait le require.
    GuildQueue: { prototype: {} },
    GuildQueuePlayerNode: { prototype: {} },
    GuildQueueEvent: {},
    TrackSkipReason: {},
});

const webServer = require('../src/web/WebServer');
webServer.broadcastState = () => {};

/** Réinitialise les réglages et la file avant chaque cas. */
function prepare(overrides) {
    Object.keys(settings).forEach(k => delete settings[k]);
    Object.assign(settings, {
        broadcastMode: 'everyone',
        activePlaybackSource: 'playlist_1',
        playlistCurrentIndex: 7,
        loopPlaylist: false,
        baseVolume: 80,
    }, overrides);
    currentQueue = fakeQueue();
    return currentQueue;
}

const A = { title: 'A', author: 'X', duration: '3:00', url: 'http://a' };
const B = { title: 'B', author: 'Y', duration: '4:00', url: 'http://b' };

console.log('\nadvanceToQueue — refusal\n');

prepare({ activePlaybackSource: 'queue', queueBackupEveryone: { tracks: [A] } });
check('a queue that runs dry does not hand off to itself',
    webServer.advanceToQueue('g1') === false);

prepare({ queueBackupEveryone: null });
check('an empty set-aside queue lets playback stop',
    webServer.advanceToQueue('g1') === false);
check('  … and the source stays the playlist',
    settings.activePlaybackSource === 'playlist_1');

// Sans salon, basculer la source rendrait la sauvegarde inatteignable : la file
// paraîtrait effacée alors qu'elle est intacte.
const withoutChannel = prepare({ queueBackupEveryone: { tracks: [A, B] } });
withoutChannel.channel = null;
check('a player without a channel leaves the queue where it is',
    webServer.advanceToQueue('g1') === false);
check('  … and the source stays the playlist',
    settings.activePlaybackSource === 'playlist_1');

// La priorité de la boucle ne tient pas à un test dans `enchainerSurLaFile`,
// mais à l'ordre des deux appels sur les points d'épuisement : la relance est
// consultée d'abord, et rend la main dès qu'elle a repris la playlist.
prepare({ loopPlaylist: true, queueBackupEveryone: { tracks: [A, B] } });
check('a looping playlist restarts itself, the queue waits its turn',
    webServer.restartLoopedPlaylist('g1') === true);
check('  … and the source stays the playlist',
    settings.activePlaybackSource === 'playlist_1');

console.log('\nenchainerSurLaFile — diffusion commune\n');

let queue = prepare({ queueBackupEveryone: { tracks: [A, B] } });
const switched = webServer.advanceToQueue('g1');

check('the handoff is announced to the caller', switched === true);
check('the source becomes the pending queue', settings.activePlaybackSource === 'queue');
check('the playlist index is reset to zero', settings.playlistCurrentIndex === 0,
    `index ${settings.playlistCurrentIndex}`);
check('the physical list is emptied before resuming', queue.emptied === true);
check('the first track of the queue starts playing', queue.played && queue.played.url === A.url,
    queue.played ? queue.played.url : 'aucun');

// `play()` est asynchrone : la suite de la file n'est ajoutée qu'une fois le
// premier titre lancé, pour ne pas se retrouver devant lui.
setTimeout(() => {
    check('the rest is appended behind it',
        queue.added.length === 1 && queue.added[0].url === B.url,
        queue.added.map(t => t.url).join(', ') || 'none');

    console.log('\nenchainerSurLaFile — diffusion personnelle\n');

    queue = prepare({ broadcastMode: 'personal', queueBackupPersonal: { tracks: [A, B] } });
    const togglePersonal = webServer.advanceToQueue('g1', 1500);

    check('the handoff is announced to the caller', togglePersonal === true);
    check('the source becomes the pending queue', settings.activePlaybackSource === 'queue');
    check('the first track becomes the current track',
        queue.virtualCurrentTrack && queue.virtualCurrentTrack.url === A.url);
    check('the rest becomes the virtual queue',
        queue.virtualTracks.length === 1 && queue.virtualTracks[0].url === B.url);
    check('playback is declared to be running', queue.virtualIsPlaying === true && queue.virtualIsPaused === false);
    check('the position already played by the crossfade is carried over', queue.virtualProgressMs === 1500,
        `${queue.virtualProgressMs} ms`);
    check('nothing is sent to the physical player', queue.played === null);

    testNextTrackOf();
    testClearQueue();

    console.log(`\n=== ${passed} passed, ${failed} failed ===`);
    process.exit(failed === 0 ? 0 : 1);
}, 0);

/**
 * Le bouton « vider la file » agit sur la liste que le panneau montre.
 *
 * Une playlist qui occupe le lecteur met la file d'attente de côté, et c'est
 * elle que le tableau de bord affiche pendant ce temps. Le bouton vidait la
 * liste du lecteur — celle de la playlist, invisible alors : rien ne bougeait à
 * l'écran, et il passait pour cassé. Le retrait d'un titre et le déplacement,
 * ses deux voisins, faisaient déjà la différence.
 */
function testClearQueue() {
    console.log('\nclearQueue — the list emptied is the one on screen\n');

    const queueHandlers = require('../src/web/websocket/handlers/queueHandlers');
    const call = (queue) => queueHandlers.handleClearQueue({
        webServer, player: null, currentGuildId: 'g1', queue,
    });
    const setAside = (field) => ((settings[field] && (settings[field].tracks
        || settings[field].virtualTracks)) || []).length;

    // Playlist en cours : la file mise de côté est la seule visible.
    let queue = prepare({ queueBackupEveryone: { tracks: [A, B] } });
    call(queue);
    check('a playlist playing, the set-aside queue is the one emptied',
        setAside('queueBackupEveryone') === 0,
        `${setAside('queueBackupEveryone')} track(s) left`);
    check('  … and the playlist keeps its own list',
        queue.emptied === false, 'emptying it would have cut the playlist short');

    // La file mise de côté ne dépend pas du mode de diffusion.
    queue = prepare({ broadcastMode: 'personal', queueBackupPersonal: { virtualTracks: [A, B] } });
    queue.virtualTracks = [];
    call(queue);
    check('personal broadcast, the set-aside queue too',
        setAside('queueBackupPersonal') === 0,
        `${setAside('queueBackupPersonal')} track(s) left`);

    // Source « file d'attente » : c'est bien la liste du lecteur qu'on vide.
    queue = prepare({ activePlaybackSource: 'queue', queueBackupEveryone: { tracks: [A] } });
    call(queue);
    check('on the queue source, the player list is the one emptied', queue.emptied === true);

    queue = prepare({ activePlaybackSource: 'queue', broadcastMode: 'personal' });
    queue.virtualTracks = [A, B];
    call(queue);
    check('  … and its virtual counterpart in personal broadcast',
        queue.virtualTracks.length === 0, `${queue.virtualTracks.length} track(s) left`);

    // Aucun lecteur monté : la file mise de côté vit dans les réglages, elle se
    // vide tout de même.
    prepare({ queueBackupEveryone: { tracks: [A, B] } });
    call(null);
    check('with no player at all, the set-aside queue still empties',
        setAside('queueBackupEveryone') === 0,
        `${setAside('queueBackupEveryone')} track(s) left`);
}

// ────────────────────────── Côté navigateur ──────────────────────────

/** Charge state.js dans un environnement minimal et rend son API. */
function loadState() {
    const source = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'web', 'public', 'js', 'state.js'),
        'utf8'
    );

    const fakeWindow = { addEventListener() {} };
    const context = {
        window: fakeWindow,
        document: {
            documentElement: { setAttribute() {}, style: { setProperty() {} } },
            addEventListener() {},
            querySelectorAll: () => [],
            querySelector: () => null,
            getElementById: () => null,
            body: { classList: { add() {}, remove() {}, contains: () => false } },
        },
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        navigator: { language: 'fr', maxTouchPoints: 0 },
        console,
        setTimeout, clearTimeout, setInterval, clearInterval,
        fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }),
    };
    context.globalThis = context;

    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'state.js' });

    return fakeWindow.MusicPlayer;
}

function testNextTrackOf() {
    console.log('\nnextTrackOf — end of playlist\n');

    const api = loadState();
    const playlist = { id: 'playlist_1', tracks: [{ url: 'p/1' }, { url: 'p/2' }] };
    const makeState = (overrides) => Object.assign({
        activePlaybackSource: 'playlist_1',
        playlists: [playlist],
        playlistCurrentIndex: 1,
        loopPlaylist: false,
        queue: [{ url: 'f/1' }, { url: 'f/2' }],
    }, overrides);

    let next = api.nextTrackOf(makeState({ playlistCurrentIndex: 0 }));
    check('mid-playlist, the next track of the playlist',
        next && next.url === 'p/2', next ? next.url : 'aucun');

    next = api.nextTrackOf(makeState({ loopPlaylist: true }));
    check('last track on loop, the first of the playlist',
        next && next.url === 'p/1', next ? next.url : 'aucun');

    next = api.nextTrackOf(makeState({}));
    check('last track without loop, the first of the pending queue',
        next && next.url === 'f/1', next ? next.url : 'aucun');

    next = api.nextTrackOf(makeState({ queue: [] }));
    check('last track without loop and empty queue, nothing left to chain',
        next === null, String(next));

    next = api.nextTrackOf({ activePlaybackSource: 'queue', queue: [{ url: 'f/1' }] });
    check('on the queue, its first track — unchanged',
        next && next.url === 'f/1', next ? next.url : 'aucun');
}
