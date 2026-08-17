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

let echecs = 0;
let reussites = 0;
const verifier = (libelle, ok, detail = '') => {
    if (ok) { reussites++; console.log(`  ok    ${libelle}${detail ? ` — ${detail}` : ''}`); }
    else { echecs++; console.log(`  ECHEC ${libelle}${detail ? ` — ${detail}` : ''}`); }
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
function doubler(chemin, exports) {
    const resolu = require.resolve(chemin);
    require.cache[resolu] = { id: resolu, filename: resolu, loaded: true, exports };
}

/** Réglages d'un serveur, que le test manipule directement. */
const reglages = {};

doubler('../src/database/Database', {
    getSettings: () => reglages,
    updateSettings: (_guildId, patch) => Object.assign(reglages, patch),
    getGlobalPlaylists: () => [
        { id: 'playlist_1', name: 'Essai', tracks: [{ title: 'P1', url: 'http://p/1' }] },
    ],
});

/** File de lecture minimale : ce que `enchainerSurLaFile` en attend. */
function fausseFile() {
    const file = {
        guild: { id: 'g1' },
        // Salon où jouer : son absence signe un lecteur démonté, et retient la
        // bascule.
        channel: { id: 'c1' },
        jouee: null,
        ajoutees: [],
        videe: false,
        tracks: {
            clear() { file.videe = true; },
        },
        addTrack(pistes) { file.ajoutees.push(...(Array.isArray(pistes) ? pistes : [pistes])); },
        async play(piste) { file.jouee = piste; },
        // Consultés par `_syncPlaylistToPlayer`, que la relance en boucle
        // emprunte : sans eux, le cas de priorité ne tiendrait qu'au hasard
        // d'une exception avalée par son `.catch()`.
        session: { estGelee: () => false },
        node: { volume: 80, setVolume() {} },
    };
    return file;
}

let fileCourante = fausseFile();

doubler('discord-player', {
    // `new Track(player, données)` ne sert qu'à reconstruire une piste depuis sa
    // sauvegarde : le double en garde les champs, seuls consultés ensuite.
    Track: class Track {
        constructor(_player, donnees) { Object.assign(this, donnees); }
    },
    useMainPlayer: () => ({
        queues: { get: () => fileCourante, cache: new Map() },
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
function preparer(surcharges) {
    Object.keys(reglages).forEach(k => delete reglages[k]);
    Object.assign(reglages, {
        broadcastMode: 'everyone',
        activePlaybackSource: 'playlist_1',
        playlistCurrentIndex: 7,
        loopPlaylist: false,
        baseVolume: 80,
    }, surcharges);
    fileCourante = fausseFile();
    return fileCourante;
}

const A = { title: 'A', author: 'X', duration: '3:00', url: 'http://a' };
const B = { title: 'B', author: 'Y', duration: '4:00', url: 'http://b' };

console.log('\nenchainerSurLaFile — refus\n');

preparer({ activePlaybackSource: 'queue', queueBackupEveryone: { tracks: [A] } });
verifier('la file qui s\'épuise ne s\'enchaîne pas sur elle-même',
    webServer.enchainerSurLaFile('g1') === false);

preparer({ queueBackupEveryone: null });
verifier('une file mise de côté vide laisse la lecture s\'arrêter',
    webServer.enchainerSurLaFile('g1') === false);
verifier('  … et la source reste la playlist',
    reglages.activePlaybackSource === 'playlist_1');

// Sans salon, basculer la source rendrait la sauvegarde inatteignable : la file
// paraîtrait effacée alors qu'elle est intacte.
const sansSalon = preparer({ queueBackupEveryone: { tracks: [A, B] } });
sansSalon.channel = null;
verifier('un lecteur sans salon laisse la file où elle est',
    webServer.enchainerSurLaFile('g1') === false);
verifier('  … et la source reste la playlist',
    reglages.activePlaybackSource === 'playlist_1');

// La priorité de la boucle ne tient pas à un test dans `enchainerSurLaFile`,
// mais à l'ordre des deux appels sur les points d'épuisement : la relance est
// consultée d'abord, et rend la main dès qu'elle a repris la playlist.
preparer({ loopPlaylist: true, queueBackupEveryone: { tracks: [A, B] } });
verifier('une playlist en boucle se relance elle-même, la file attend son tour',
    webServer.relancerPlaylistBouclee('g1') === true);
verifier('  … et la source reste la playlist',
    reglages.activePlaybackSource === 'playlist_1');

console.log('\nenchainerSurLaFile — diffusion commune\n');

let file = preparer({ queueBackupEveryone: { tracks: [A, B] } });
const bascule = webServer.enchainerSurLaFile('g1');

verifier('la bascule est annoncée à l\'appelant', bascule === true);
verifier('la source devient la file d\'attente', reglages.activePlaybackSource === 'queue');
verifier('l\'index de playlist est ramené à zéro', reglages.playlistCurrentIndex === 0,
    `index ${reglages.playlistCurrentIndex}`);
verifier('la liste physique est vidée avant la reprise', file.videe === true);
verifier('le premier titre de la file est mis en lecture', file.jouee && file.jouee.url === A.url,
    file.jouee ? file.jouee.url : 'aucun');

// `play()` est asynchrone : la suite de la file n'est ajoutée qu'une fois le
// premier titre lancé, pour ne pas se retrouver devant lui.
setTimeout(() => {
    verifier('la suite est ajoutée derrière lui',
        file.ajoutees.length === 1 && file.ajoutees[0].url === B.url,
        file.ajoutees.map(t => t.url).join(', ') || 'aucune');

    console.log('\nenchainerSurLaFile — diffusion personnelle\n');

    file = preparer({ broadcastMode: 'personal', queueBackupPersonal: { tracks: [A, B] } });
    const basculePerso = webServer.enchainerSurLaFile('g1', 1500);

    verifier('la bascule est annoncée à l\'appelant', basculePerso === true);
    verifier('la source devient la file d\'attente', reglages.activePlaybackSource === 'queue');
    verifier('le premier titre devient la piste courante',
        file.virtualCurrentTrack && file.virtualCurrentTrack.url === A.url);
    verifier('la suite devient la file virtuelle',
        file.virtualTracks.length === 1 && file.virtualTracks[0].url === B.url);
    verifier('la lecture est déclarée en cours', file.virtualIsPlaying === true && file.virtualIsPaused === false);
    verifier('la position déjà jouée par le fondu est reprise', file.virtualProgressMs === 1500,
        `${file.virtualProgressMs} ms`);
    verifier('rien n\'est envoyé au lecteur physique', file.jouee === null);

    testerPisteSuivante();

    console.log(`\n=== ${reussites} réussite(s), ${echecs} échec(s) ===`);
    process.exit(echecs === 0 ? 0 : 1);
}, 0);

// ────────────────────────── Côté navigateur ──────────────────────────

/** Charge state.js dans un environnement minimal et rend son API. */
function chargerEtat() {
    const source = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'web', 'public', 'js', 'state.js'),
        'utf8'
    );

    const fenetre = { addEventListener() {} };
    const contexte = {
        window: fenetre,
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
    contexte.globalThis = contexte;

    vm.createContext(contexte);
    vm.runInContext(source, contexte, { filename: 'state.js' });

    return fenetre.MusicPlayer;
}

function testerPisteSuivante() {
    console.log('\npisteSuivante — fin de playlist\n');

    const api = chargerEtat();
    const playlist = { id: 'playlist_1', tracks: [{ url: 'p/1' }, { url: 'p/2' }] };
    const etat = (surcharges) => Object.assign({
        activePlaybackSource: 'playlist_1',
        playlists: [playlist],
        playlistCurrentIndex: 1,
        loopPlaylist: false,
        queue: [{ url: 'f/1' }, { url: 'f/2' }],
    }, surcharges);

    let suivante = api.pisteSuivante(etat({ playlistCurrentIndex: 0 }));
    verifier('en cours de playlist, le titre suivant de la playlist',
        suivante && suivante.url === 'p/2', suivante ? suivante.url : 'aucun');

    suivante = api.pisteSuivante(etat({ loopPlaylist: true }));
    verifier('dernier titre en boucle, le premier de la playlist',
        suivante && suivante.url === 'p/1', suivante ? suivante.url : 'aucun');

    suivante = api.pisteSuivante(etat({}));
    verifier('dernier titre sans boucle, le premier de la file d\'attente',
        suivante && suivante.url === 'f/1', suivante ? suivante.url : 'aucun');

    suivante = api.pisteSuivante(etat({ queue: [] }));
    verifier('dernier titre sans boucle et file vide, plus rien à enchaîner',
        suivante === null, String(suivante));

    suivante = api.pisteSuivante({ activePlaybackSource: 'queue', queue: [{ url: 'f/1' }] });
    verifier('sur la file, son premier titre — inchangé',
        suivante && suivante.url === 'f/1', suivante ? suivante.url : 'aucun');
}
