/**
 * Vérifie que mettre en pause ne perd pas de temps de lecture.
 *
 * En diffusion personnelle, le son sort du navigateur : le serveur ne compte
 * pas d'échantillons, il tient la position à l'horloge murale par un tour de
 * boucle chaque seconde. Entre deux tours, la position enregistrée est donc en
 * retard de ce qui s'est écoulé depuis le dernier — jusqu'à une seconde.
 *
 * Ce retard était invisible tant qu'il se rattrapait au tour suivant. Une pause
 * l'arrêtait au contraire en l'état : l'intervalle en cours n'était jamais
 * compté, et chaque pause reculait le morceau d'autant. L'erreur s'accumulant
 * d'une pause à l'autre, elle finissait par dépasser les deux secondes de
 * tolérance du navigateur, qui se recalait alors sur la position du serveur —
 * un saut en arrière audible, sans rapport apparent avec le bouton pressé.
 *
 * Le solde est donc fait avant de figer l'horloge. Ce qui est vérifié ici :
 *
 *   - une pause ne perd rien, quel que soit le moment où elle tombe ;
 *   - l'erreur ne s'accumule pas sur une suite de pauses ;
 *   - une pause sur une lecture déjà en pause n'avance rien ;
 *   - la vitesse de lecture est respectée, et une horloge qui recule ignorée.
 */
const path = require('path');

let failed = 0;
let passed = 0;
const check = (label, ok, detail = '') => {
    if (ok) { passed++; console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`); }
    else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

/**
 * Remplace un module par un double avant que quiconque ne le charge.
 *
 * PlaybackSession tient à `discord-player`, dont le seul usage utile ici est le
 * prototype sur lequel il pose ses accesseurs. Le charger pour de vrai
 * demanderait un bot connecté ; la fonction éprouvée, elle, ne travaille que
 * sur les propriétés de la session.
 */
function stub(moduleName, exports) {
    const resolved = require.resolve(moduleName);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

stub('discord-player', { GuildQueue: function GuildQueue() {} });
stub(path.join(__dirname, '..', 'src', 'database', 'Database.js'), { getSettings: () => ({}) });

const { foldVirtualElapsed } = require('../src/audio/PlaybackSession');

/**
 * Une horloge que le test avance à la main.
 *
 * `Date.now` est remplacé le temps du fichier : mesurer de vraies
 * millisecondes rendrait les comparaisons approximatives, alors que la
 * propriété à vérifier — ne rien perdre — est exacte.
 */
let clock = 1_000_000;
Date.now = () => clock;
const advance = (ms) => { clock += ms; };

/** Une file en cours de lecture, telle que la voit le mode personnel. */
function playing(extra = {}) {
    return {
        virtualIsPlaying: true,
        virtualIsPaused: false,
        virtualProgressMs: 0,
        virtualLastUpdated: Date.now(),
        ...extra,
    };
}

/** Le tour de boucle du serveur, une fois par seconde. */
function tick(queue, speed = 1) {
    advance(1000);
    foldVirtualElapsed(queue, speed);
}

/** Ce que fait le gestionnaire de pause. */
function pause(queue, speed = 1) {
    foldVirtualElapsed(queue, speed);
    queue.virtualIsPlaying = false;
    queue.virtualIsPaused = true;
}

/** Ce que fait le gestionnaire de reprise. */
function resume(queue) {
    queue.virtualIsPlaying = true;
    queue.virtualIsPaused = false;
    queue.virtualLastUpdated = Date.now();
}

console.log('\n=== Précision de la pause — mode personnel ===\n');

// ─────────────────── Une pause entre deux tours ───────────────────

{
    const queue = playing();
    tick(queue);            // 1 000 ms comptées par la boucle
    advance(400);           // puis 400 ms qu'aucun tour n'a encore vues
    pause(queue);

    check('la fraction de seconde en cours est comptée',
        queue.virtualProgressMs === 1400, `${queue.virtualProgressMs} ms`);
}

{
    // Le pire cas : la pause tombe juste avant le tour suivant.
    const queue = playing();
    tick(queue);
    advance(999);
    pause(queue);

    check('  … même à 999 ms du dernier tour',
        queue.virtualProgressMs === 1999, `${queue.virtualProgressMs} ms`);
}

{
    // Et le cas limite inverse : la pause suit immédiatement un tour.
    const queue = playing();
    tick(queue);
    pause(queue);

    check('  … et rien n’est compté deux fois quand elle suit un tour',
        queue.virtualProgressMs === 1000, `${queue.virtualProgressMs} ms`);
}

// ─────────────────── L'erreur ne s'accumule pas ───────────────────

{
    /*
     * Dix pauses, chacune à 700 ms du dernier tour. Avec l'ancien calcul la
     * position perdait sept secondes en tout — bien au-delà des deux secondes
     * au bout desquelles le navigateur se recale, ce qui produisait le saut.
     */
    const queue = playing();
    let real = 0;

    for (let i = 0; i < 10; i++) {
        tick(queue);   real += 1000;
        advance(700);  real += 700;
        pause(queue);

        advance(5000); // le temps passé à l'arrêt ne compte pas
        resume(queue);
    }

    check('dix pauses ne dérivent pas d’une milliseconde',
        queue.virtualProgressMs === real, `${queue.virtualProgressMs} ms pour ${real} ms jouées`);
    check('  … donc en deçà des 2 s au-delà desquelles le navigateur saute',
        Math.abs(queue.virtualProgressMs - real) < 2000);
}

// ─────────────────── Ce qui ne doit rien compter ───────────────────

{
    const queue = playing();
    tick(queue);
    pause(queue);

    advance(30000);
    foldVirtualElapsed(queue);   // un tour de boucle pendant la pause
    check('le temps passé en pause n’avance pas le morceau',
        queue.virtualProgressMs === 1000, `${queue.virtualProgressMs} ms`);

    pause(queue);                // une seconde pause, sur une lecture arrêtée
    check('  … et une pause sur une pause n’avance rien non plus',
        queue.virtualProgressMs === 1000, `${queue.virtualProgressMs} ms`);
}

{
    const queue = playing({ virtualIsPlaying: false });
    advance(4000);
    foldVirtualElapsed(queue);
    check('une file à l’arrêt ne compte rien',
        queue.virtualProgressMs === 0, `${queue.virtualProgressMs} ms`);
    check('  … mais son repère est repoussé, sans dette à solder plus tard',
        queue.virtualLastUpdated === Date.now());
}

// ─────────────────── Vitesse et horloge ───────────────────

{
    // Le morceau est étiré par le décodeur : une seconde d'horloge ne vaut plus
    // une seconde de morceau.
    const queue = playing();
    advance(1000);
    foldVirtualElapsed(queue, 2);
    check('à vitesse double, une seconde d’horloge vaut deux secondes de morceau',
        queue.virtualProgressMs === 2000, `${queue.virtualProgressMs} ms`);

    advance(1000);
    foldVirtualElapsed(queue, 0.5);
    check('  … et une demie à vitesse moitié',
        queue.virtualProgressMs === 2500, `${queue.virtualProgressMs} ms`);
}

{
    const queue = playing();
    advance(1000);
    foldVirtualElapsed(queue, 0);
    check('une vitesse nulle est ignorée plutôt que de figer le morceau',
        queue.virtualProgressMs === 1000, `${queue.virtualProgressMs} ms`);
}

{
    // Reprise de veille, ajustement d'horloge : le temps peut reculer.
    const queue = playing();
    advance(2000);
    foldVirtualElapsed(queue);
    clock -= 5000;
    foldVirtualElapsed(queue);
    check('une horloge qui recule ne fait pas reculer le morceau',
        queue.virtualProgressMs === 2000, `${queue.virtualProgressMs} ms`);
}

{
    const queue = playing({ virtualLastUpdated: 0 });
    advance(3000);
    foldVirtualElapsed(queue);
    check('un repère jamais posé ne compte pas depuis 1970',
        queue.virtualProgressMs === 0, `${queue.virtualProgressMs} ms`);
}

check('une file absente ne fait pas tomber le serveur',
    foldVirtualElapsed(null) === 0);

// ═════════ Côté navigateur : l'affichage ne change pas de source ═════════

/*
 * La seconde moitié du même défaut, et celle qui se voyait vraiment.
 *
 * `renderSmoothProgress` lit deux horloges. En diffusion personnelle, tant que
 * l'élément audio joue, elle lit l'élément — la position vraie, celle qui
 * s'entend. Sinon elle lit l'estimation du serveur, avancée une fois par
 * seconde et donc presque toujours en retard.
 *
 * L'ancienne condition n'admettait l'élément que « non en pause ». Appuyer sur
 * pause faisait alors changer de source au moment précis du clic : la barre
 * passait de la position réelle à une estimation plus ancienne, et reculait
 * d'une fraction de seconde sans que rien n'ait bougé dans le morceau.
 *
 * La fonction est extraite de app.js et exécutée telle quelle : c'est celle qui
 * tourne en production, et non une copie qui pourrait en diverger.
 */
const fs = require('fs');
const vm = require('vm');

/** Extrait une fonction de app.js, par équilibrage des accolades. */
function extractFunction(source, name) {
    const start = source.indexOf(`function ${name}()`);
    if (start === -1) throw new Error(`${name} introuvable dans app.js`);

    let depth = 0;
    for (let end = source.indexOf('{', start); end < source.length; end++) {
        if (source[end] === '{') depth++;
        else if (source[end] === '}' && --depth === 0) return source.slice(start, end + 1);
    }
    throw new Error(`accolades non refermées pour ${name}`);
}

const appSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'web', 'public', 'app.js'), 'utf8'
);

const SERVER_RATIO = 99400 / 200000;

/**
 * Un banc minimal autour de la fonction de rendu.
 *
 * Les variables libres de `renderSmoothProgress` — l'état, l'élément audio, la
 * barre — deviennent les globales du bac à sable : la fonction les lit sans
 * savoir qu'elles ne viennent plus de sa fermeture.
 */
function mountRenderer({ personal = true, totalMs = 200000 } = {}) {
    const context = {
        isSeeking: false,
        state: {
            settings: { broadcastMode: personal ? 'personal' : 'everyone', playbackSpeed: '1.0' },
            isPaused: false,
            currentTrack: { title: 'Essai' },
            progress: { currentMs: 99400, totalMs },
        },
        // L'élément est à 100 s ; le serveur, lui, en est encore à 99,4 s.
        personalAudio: { duration: totalMs / 1000, currentTime: 100, paused: false },
        progressBar: { style: {} },
        timeCurrent: { textContent: '' },
        timeTotal: { textContent: '' },
        baseProgressMs: 99400,
        baseTotalMs: totalMs,
        lastProgressTimestamp: 1000,
        isTrackPlaying: true,
        window: { MusicPlayer: { currentSpeed: '1.0' } },
        // Figée : l'extrapolation de la branche serveur doit être reproductible.
        performance: { now: () => 1000 },
        formatMs: (ms) => String(Math.round(ms)),
        syncVideoProgress: () => {},
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(extractFunction(appSource, 'renderSmoothProgress'), context,
        { filename: 'app.js:renderSmoothProgress' });

    return {
        context,
        render() {
            vm.runInContext('renderSmoothProgress()', context);
            return context.window.MusicPlayer.currentProgressRatio;
        },
        /** Ce que devient l'affichage une fois la pause confirmée par le serveur. */
        pause() {
            context.state.isPaused = true;
            context.personalAudio.paused = true;
            context.isTrackPlaying = false;
        },
    };
}

console.log('=== Précision de la pause — affichage du navigateur ===\n');

{
    const bench = mountRenderer();
    const playing = bench.render();
    check('en lecture, la barre suit l’élément audio',
        playing === 0.5, String(playing));

    bench.pause();
    const paused = bench.render();
    check('la pause ne fait pas reculer la barre',
        paused === playing, `${playing} puis ${paused}`);
    check('  … elle ne retombe pas sur l’estimation du serveur',
        paused !== SERVER_RATIO, `celle-ci vaut ${SERVER_RATIO}`);
}

{
    // L'élément est arrêté sans que l'utilisateur l'ait demandé — chargement,
    // bascule de piste. Il porte encore la position d'avant ; le serveur sait.
    const bench = mountRenderer();
    bench.context.personalAudio.paused = true;   // sans state.isPaused
    check('un élément arrêté pour un chargement ne fait pas foi',
        bench.render() === SERVER_RATIO, String(bench.render()));
}

{
    // Rechargement de la page pendant une pause : l'élément repart de zéro, et
    // c'est le serveur qui sait où l'on en était.
    const bench = mountRenderer();
    bench.pause();
    bench.context.personalAudio.currentTime = 0;
    check('une position nulle laisse la main au serveur',
        bench.render() === SERVER_RATIO, String(bench.render()));
}

{
    // En diffusion commune, le son ne sort pas du navigateur : son élément
    // audio n'a rien à dire de la position.
    const bench = mountRenderer({ personal: false });
    bench.pause();
    check('en diffusion commune, le serveur reste la référence',
        bench.render() === SERVER_RATIO, String(bench.render()));
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed === 0 ? 0 : 1);
