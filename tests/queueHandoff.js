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
    else { failed++; console.log(`  ECHEC ${label}${detail ? ` — ${detail}` : ''}`); }
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

console.log('\nenchainerSurLaFile — refus\n');

prepare({ activePlaybackSource: 'queue', queueBackupEveryone: { tracks: [A] } });
check('la file qui s\'épuise ne s\'enchaîne pas sur elle-même',
    webServer.advanceToQueue('g1') === false);

prepare({ queueBackupEveryone: null });
check('une file mise de côté vide laisse la lecture s\'arrêter',
    webServer.advanceToQueue('g1') === false);
check('  … et la source reste la playlist',
    settings.activePlaybackSource === 'playlist_1');

// Sans salon, basculer la source rendrait la sauvegarde inatteignable : la file
// paraîtrait effacée alors qu'elle est intacte.
const withoutChannel = prepare({ queueBackupEveryone: { tracks: [A, B] } });
withoutChannel.channel = null;
check('un lecteur sans salon laisse la file où elle est',
    webServer.advanceToQueue('g1') === false);
check('  … et la source reste la playlist',
    settings.activePlaybackSource === 'playlist_1');

// La priorité de la boucle ne tient pas à un test dans `enchainerSurLaFile`,
// mais à l'ordre des deux appels sur les points d'épuisement : la relance est
// consultée d'abord, et rend la main dès qu'elle a repris la playlist.
prepare({ loopPlaylist: true, queueBackupEveryone: { tracks: [A, B] } });
check('une playlist en boucle se relance elle-même, la file attend son tour',
    webServer.restartLoopedPlaylist('g1') === true);
check('  … et la source reste la playlist',
    settings.activePlaybackSource === 'playlist_1');

console.log('\nenchainerSurLaFile — diffusion commune\n');

let queue = prepare({ queueBackupEveryone: { tracks: [A, B] } });
const switched = webServer.advanceToQueue('g1');

check('la bascule est annoncée à l\'appelant', switched === true);
check('la source devient la file d\'attente', settings.activePlaybackSource === 'queue');
check('l\'index de playlist est ramené à zéro', settings.playlistCurrentIndex === 0,
    `index ${settings.playlistCurrentIndex}`);
check('la liste physique est vidée avant la reprise', queue.emptied === true);
check('le premier titre de la file est mis en lecture', queue.played && queue.played.url === A.url,
    queue.played ? queue.played.url : 'aucun');

// `play()` est asynchrone : la suite de la file n'est ajoutée qu'une fois le
// premier titre lancé, pour ne pas se retrouver devant lui.
setTimeout(() => {
    check('la suite est ajoutée derrière lui',
        queue.added.length === 1 && queue.added[0].url === B.url,
        queue.added.map(t => t.url).join(', ') || 'aucune');

    console.log('\nenchainerSurLaFile — diffusion personnelle\n');

    queue = prepare({ broadcastMode: 'personal', queueBackupPersonal: { tracks: [A, B] } });
    const basculePerso = webServer.advanceToQueue('g1', 1500);

    check('la bascule est annoncée à l\'appelant', basculePerso === true);
    check('la source devient la file d\'attente', settings.activePlaybackSource === 'queue');
    check('le premier titre devient la piste courante',
        queue.virtualCurrentTrack && queue.virtualCurrentTrack.url === A.url);
    check('la suite devient la file virtuelle',
        queue.virtualTracks.length === 1 && queue.virtualTracks[0].url === B.url);
    check('la lecture est déclarée en cours', queue.virtualIsPlaying === true && queue.virtualIsPaused === false);
    check('la position déjà jouée par le fondu est reprise', queue.virtualProgressMs === 1500,
        `${queue.virtualProgressMs} ms`);
    check('rien n\'est envoyé au lecteur physique', queue.played === null);

    testNextTrackOf();

    console.log(`\n=== ${passed} réussite(s), ${failed} échec(s) ===`);
    process.exit(failed === 0 ? 0 : 1);
}, 0);

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
    console.log('\npisteSuivante — fin de playlist\n');

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
    check('en cours de playlist, le titre suivant de la playlist',
        next && next.url === 'p/2', next ? next.url : 'aucun');

    next = api.nextTrackOf(makeState({ loopPlaylist: true }));
    check('dernier titre en boucle, le premier de la playlist',
        next && next.url === 'p/1', next ? next.url : 'aucun');

    next = api.nextTrackOf(makeState({}));
    check('dernier titre sans boucle, le premier de la file d\'attente',
        next && next.url === 'f/1', next ? next.url : 'aucun');

    next = api.nextTrackOf(makeState({ queue: [] }));
    check('dernier titre sans boucle et file vide, plus rien à enchaîner',
        next === null, String(next));

    next = api.nextTrackOf({ activePlaybackSource: 'queue', queue: [{ url: 'f/1' }] });
    check('sur la file, son premier titre — inchangé',
        next && next.url === 'f/1', next ? next.url : 'aucun');
}
