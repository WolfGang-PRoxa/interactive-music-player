/**
 * Vérifie le mode de lecture aléatoire, et l'invitation qui l'accompagne.
 *
 * Le mode s'ajoute aux trois autres — lecture suivie, piste en boucle, playlist
 * en boucle — et s'exclut d'eux. Trois choses le distinguent, et aucune ne se
 * lit dans un diff.
 *
 *  - **Le tirage a lieu à l'enchaînement, jamais d'avance.** Le mélange en
 *    place — battre la file une fois pour toutes — serait irréversible, et la
 *    file cesserait d'annoncer ce qui vient. La diffusion commune s'en remet
 *    donc au mélange dynamique de discord-player, et la diffusion personnelle,
 *    que le navigateur mène, tire elle-même dans `drawNextVirtualTrack`.
 *
 *  - **Ce qui se déduisait de l'ordre cesse d'être vrai.** Le fondu enchaîné du
 *    navigateur prépare le morceau suivant à partir de la liste : en mode
 *    aléatoire il préparerait le mauvais. `nextTrackOf` le dit — elle ne promet
 *    plus rien.
 *
 *  - **Le préchargement devient la seule préparation possible.** Réglé sur
 *    « toutes les pistes », il met la file et les playlists entières en cache,
 *    et le tirage tombe toujours sur un morceau prêt. Ce réglage vit à trois
 *    clics de là, dans la fenêtre des paramètres : le bouton du mode le dit
 *    lui-même — une onde tant qu'il manque — et l'infobulle le règle.
 *
 * Le dernier point tient à ce que l'infobulle devient agissante, ce qu'aucune
 * des cent autres de la page n'est. Le chemin ordinaire ne doit pas changer
 * d'un iota : c'est la dernière section qui l'éprouve.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/*
 * Dans un bac à sable, avant tout `require` — comme dans tests/pilotElection.js.
 * Charger WebServer configure le logger sur `data/logs` du répertoire courant,
 * et écraserait le journal du bot en cours d'exécution.
 */
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'shuffle-mode-'));
process.chdir(SANDBOX);
process.on('exit', () => {
    try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) {}
});

let failed = 0;
let passed = 0;
const check = (label, ok, detail = '') => {
    if (ok) { passed++; console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`); }
    else { failed++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
};

const PUBLIC = path.join(ROOT, 'src', 'web', 'public');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

console.log('\n=== Le mode de lecture aléatoire ===\n');

/* ══════════════════ Le tirage, côté serveur ══════════════════ */

console.log('Le titre suivant se tire à l\'enchaînement\n');

const webServer = require(path.join(ROOT, 'src', 'web', 'WebServer.js'));
const database = require(path.join(ROOT, 'src', 'database', 'Database.js'));

// Le réglage de la guilde, tenu en mémoire : la vraie base écrirait dans le bac
// à sable, ce qui ne dit rien de plus et coûte un fichier par cas.
let settings = { shuffle: false };
database.getSettings = () => settings;

const fileDe = (...noms) => ({ virtualTracks: noms.map(nom => ({ title: nom })) });

{
    settings = { shuffle: false };
    const queue = fileDe('A', 'B', 'C');
    const draw = webServer.drawNextVirtualTrack(queue, 'G1');
    check('sans le mode, la file se dépile dans l\'ordre', draw.title === 'A', draw.title);
    check('  … et le titre tiré quitte l\'attente',
        queue.virtualTracks.map(t => t.title).join('') === 'BC');
}

{
    settings = { shuffle: true };
    const vus = new Set();
    let toujoursUn = true;

    // Deux cents tirages sur trois pistes : voir les trois est quasi certain,
    // et ne jamais les voir toutes signalerait un tirage qui n'en est pas un.
    for (let i = 0; i < 200; i++) {
        const queue = fileDe('A', 'B', 'C');
        const draw = webServer.drawNextVirtualTrack(queue, 'G1');
        vus.add(draw.title);
        if (queue.virtualTracks.length !== 2
            || queue.virtualTracks.some(t => t.title === draw.title)) {
            toujoursUn = false;
        }
    }

    check('avec le mode, le tirage visite toute la file', vus.size === 3,
        [...vus].sort().join(''));
    check('  … et n\'en retire jamais qu\'une piste, celle qui part', toujoursUn);
}

{
    settings = { shuffle: true };
    check('une file vide ne tire rien',
        webServer.drawNextVirtualTrack({ virtualTracks: [] }, 'G1') === undefined);
    check('  … et une file absente non plus',
        webServer.drawNextVirtualTrack(null, 'G1') === undefined,
        'le lecteur peut n\'avoir jamais démarré');
}

console.log('\nLe mélange de discord-player suit le réglage\n');

{
    const gestes = [];
    const queue = {
        isShuffling: false,
        enableShuffle(dynamique) { gestes.push(`on:${dynamique}`); this.isShuffling = true; },
        disableShuffle() { gestes.push('off'); this.isShuffling = false; },
    };

    settings = { shuffle: true };
    webServer.applyShuffle(queue, 'G1');
    check('le mélange demandé est le mélange dynamique', gestes.join() === 'on:true',
        'le mélange en place serait irréversible, et la file n\'annoncerait plus rien');

    webServer.applyShuffle(queue, 'G1');
    check('  … et ne se redemande pas quand il est déjà en cours',
        gestes.length === 1, gestes.join());

    settings = { shuffle: false };
    webServer.applyShuffle(queue, 'G1');
    check('quitter le mode l\'annule', gestes.join() === 'on:true,off');

    webServer.applyShuffle(queue, 'G1');
    check('  … une seule fois de même', gestes.length === 2, gestes.join());
}

check('une file qui ne sait pas mélanger est laissée tranquille',
    (() => { try { webServer.applyShuffle({}, 'G1'); return true; } catch (e) { return false; } })(),
    'la file de discord-player n\'existe pas toujours');

/* ══════════════════ Les quatre modes s'excluent ══════════════════ */

console.log('\nUn seul mode actif à la fois\n');

const HANDLERS = read('src', 'web', 'websocket', 'handlers', 'playbackHandlers.js');
const setPlayMode = HANDLERS.slice(
    HANDLERS.indexOf('function handleSetPlayMode'),
    HANDLERS.indexOf('async function handleStop'));

for (const [mode, loop, shuffle] of [
    ['loop_track', 'false', 'false'],
    ['loop_playlist', 'true', 'false'],
    ['shuffle', 'false', 'true'],
    ['default', 'false', 'false'],
]) {
    const branche = setPlayMode.slice(setPlayMode.indexOf(`mode === '${mode}'`));
    const ecrit = /updateSettings\(currentGuildId, \{ loopPlaylist: (\w+), shuffle: (\w+) \}\)/
        .exec(branche);
    check(`« ${mode} » écrit les deux réglages`,
        Boolean(ecrit) && ecrit[1] === loop && ecrit[2] === shuffle,
        ecrit ? `loopPlaylist: ${ecrit[1]}, shuffle: ${ecrit[2]}` : 'écriture introuvable');
}

check('le changement de mode accorde la file au réglage',
    /webServer\.applyShuffle\(queue, currentGuildId\)/.test(setPlayMode),
    'sans quoi le mélange ne prendrait qu\'au morceau suivant');

check('un démarrage de piste le refait',
    /webServer\.applyShuffle\(queue, guildId\)/.test(read('src', 'audio', 'PlayerEvents.js')),
    'une file recréée naîtrait sinon sans le mode que le serveur croit actif');

check('le réglage part dans l\'état diffusé',
    /shuffle: !!settings\.shuffle/.test(read('src', 'web', 'WebServer.js')));

check('et la base le connaît, éteint',
    /shuffle: false/.test(read('src', 'database', 'Database.js')));

check('lancer une file en personnel passe par le même tirage',
    !/queue\.virtualTracks\.shift\(\)/.test(HANDLERS)
    && /webServer\.drawNextVirtualTrack\(queue, currentGuildId\)/.test(HANDLERS),
    'sinon une file relancée s\'ouvrirait toujours sur la même piste');

/* ══════════════════ Ce que le navigateur cesse de promettre ══════════════════ */

console.log('\nLe fondu enchaîné ne devine plus\n');

const STATE = read('src', 'web', 'public', 'js', 'state.js');
const nextTrackOf = STATE.slice(STATE.indexOf('window.MusicPlayer.nextTrackOf ='));
check('`nextTrackOf` ne promet rien en mode aléatoire',
    /if \(snapshot\.shuffle\) return null;/.test(nextTrackOf.slice(0, 900)),
    'le morceau préparé d\'avance serait le mauvais');

const MARKUP = read('src', 'web', 'public', 'index.html');
check('les deux sélecteurs de mode portent le bouton',
    (MARKUP.match(/class="mode-switch-btn mode-shuffle" data-mode="shuffle"/g) || []).length === 2,
    'la carte « En cours de lecture » et la fenêtre vidéo flottante');

const PLAYER = read('src', 'web', 'public', 'js', 'player.js');
check('la lecture suivie n\'est allumée que si aucun autre mode ne l\'est',
    /repeatMode !== 1 && !loopActive && !shuffleActive/.test(PLAYER));

/* ══════════════════ L'invitation à tout précharger ══════════════════ */

/**
 * L'onde sur le bouton, l'infobulle agissante, et le bouton qu'elle porte —
 * avec les vrais tooltipSystem.js et shuffleHint.js dans jsdom.
 *
 * `jsdom` n'est pas une dépendance déclarée : la section se retire d'elle-même
 * s'il manque, comme dans tests/rightRequests.js.
 */
async function browserSide() {
    let JSDOM;
    try {
        ({ JSDOM } = require('jsdom'));
    } catch (e) {
        console.log('\n  passé — jsdom absent de cette installation');
        return;
    }

    const fr = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'locales', 'fr.json'), 'utf8'));

    const BOUTON = '<button class="mode-switch-btn mode-shuffle" data-mode="shuffle"'
        + ' data-tooltip="Lire les musiques dans un ordre aléatoire"'
        + ' data-i18n-tooltip="tooltip_mode_shuffle"><svg></svg></button>';

    const mount = async (etat, preloading) => {
        const dom = new JSDOM('<!doctype html><html><body>'
            + `<div class="play-mode-switch">${BOUTON}</div>`
            + `<div class="play-mode-switch video-play-mode-switch">${BOUTON}</div>`
            + '<button id="ordinaire" data-tooltip="Une infobulle comme les autres"></button>'
            + '</body></html>', { runScripts: 'outside-only', url: 'http://localhost:3000/' });

        const win = dom.window;
        win.MusicPlayer = {
            state: etat,
            dashboardSettings: { tooltipDelay: 0, preloading },
            t: (key) => fr[key] || key,
        };
        const reglages = [];
        win.MusicPlayer.setPreloadAll = () => {
            reglages.push('réglé');
            win.MusicPlayer.dashboardSettings.preloading =
                { enabled: true, queueCount: -1, playlistCount: -1, historyCount: 3 };
        };
        const toasts = [];
        win.MusicPlayer.showToast = (message) => toasts.push(message);

        win.eval(read('src', 'web', 'public', 'js', 'tooltipSystem.js'));
        win.eval(read('src', 'web', 'public', 'js', 'shuffleHint.js'));
        win.TooltipSystem.init();
        win.MusicPlayer.refreshShuffleHint();

        const boutons = [...win.document.querySelectorAll('.mode-shuffle')];
        const survole = async (el) => {
            el.dispatchEvent(new win.MouseEvent('mouseover', { bubbles: true }));
            await new Promise(r => setTimeout(r, 30));
        };
        const quitte = async (el, vers) => {
            el.dispatchEvent(new win.MouseEvent('mouseout', { bubbles: true, relatedTarget: vers }));
            await new Promise(r => setTimeout(r, 30));
        };

        return { win, boutons, reglages, toasts, survole, quitte,
            bulle: () => win.document.getElementById('custom-tooltip') };
    };

    const COURT = { enabled: true, queueCount: 3, playlistCount: 3, historyCount: 3 };
    const TOUT = { enabled: true, queueCount: -1, playlistCount: -1, historyCount: 3 };

    console.log('\nQuand l\'invitation a lieu d\'être\n');

    {
        const { boutons } = await mount({ shuffle: false }, COURT);
        check('mode éteint, préchargement court : rien ne bouge',
            boutons.every(b => !b.classList.contains('needs-preload')
                && !b.hasAttribute('data-tooltip-action')),
            'l\'expliquer avant d\'activer le mode n\'apprendrait rien');
    }

    {
        const { boutons } = await mount({ shuffle: true }, TOUT);
        check('mode actif, tout préchargé : rien non plus',
            boutons.every(b => !b.classList.contains('needs-preload')
                && !b.hasAttribute('data-tooltip-action')),
            'il n\'y a plus rien à proposer');
    }

    {
        const { boutons } = await mount({ shuffle: true }, { enabled: false, queueCount: -1, playlistCount: -1 });
        check('le préchargement éteint compte comme absent',
            boutons.every(b => b.classList.contains('needs-preload')),
            'deux infinis dans un réglage désactivé ne préchargent rien');
    }

    {
        const { boutons } = await mount({ shuffle: true }, { enabled: true, queueCount: -1, playlistCount: 3 });
        check('une seule des deux listes ne suffit pas',
            boutons.every(b => b.classList.contains('needs-preload')),
            'le tirage puise dans les deux');
    }

    {
        const { boutons } = await mount({ shuffle: true }, COURT);
        check('mode actif, préchargement à la traîne : les deux boutons ondulent',
            boutons.length === 2 && boutons.every(b => b.classList.contains('needs-preload')));
        check('  … et annoncent la seconde ligne de l\'infobulle',
            boutons.every(b => b.getAttribute('data-tooltip-hint') === 'shuffle_preload_hint'));
        check('  … et le bouton qu\'elle porte',
            boutons.every(b => b.getAttribute('data-tooltip-action') === 'shuffle_preload_action'
                && b.getAttribute('data-tooltip-action-call') === 'preloadAllForShuffle'));
    }

    console.log('\nL\'infobulle agissante\n');

    {
        const s = await mount({ shuffle: true }, COURT);
        await s.survole(s.boutons[0]);

        const bulle = s.bulle();
        check('le survol ouvre l\'infobulle', bulle.classList.contains('visible'));
        check('  … qui dit toujours ce qu\'est le mode',
            bulle.textContent.includes(fr.tooltip_mode_shuffle));
        check('  … et pourquoi le préchargement compte ici',
            bulle.textContent.includes(fr.shuffle_preload_hint.slice(0, 40)));

        const action = bulle.querySelector('.tooltip-action');
        check('  … et elle porte le bouton', Boolean(action)
            && action.textContent === fr.shuffle_preload_action,
            action ? action.textContent : 'bouton absent');
        check('  … que le pointeur peut atteindre',
            bulle.classList.contains('has-action'),
            'la feuille de style n\'ouvre `pointer-events` qu\'à cette classe');

        // Le trajet du bouton vers l'infobulle : sans le pont, elle se fermerait
        // en chemin et le bouton n'existerait que pour l'œil.
        await s.quitte(s.boutons[0], bulle);
        check('quitter le bouton pour l\'infobulle ne la ferme pas',
            s.bulle().classList.contains('visible'));

        action.dispatchEvent(new s.win.MouseEvent('click', { bubbles: true, cancelable: true }));
        check('le bouton règle le préchargement', s.reglages.length === 1);
        check('  … le dit', s.toasts.length === 1 && s.toasts[0] === fr.shuffle_preload_done,
            s.toasts[0]);
        check('  … et se referme derrière lui', !s.bulle().classList.contains('visible'));
        check('  … après quoi il n\'y a plus rien à proposer',
            s.boutons.every(b => !b.classList.contains('needs-preload')
                && !b.hasAttribute('data-tooltip-action')));

        await s.survole(s.boutons[0]);
        check('le survol suivant n\'ouvre qu\'une infobulle ordinaire',
            !s.bulle().classList.contains('has-action')
            && !s.bulle().querySelector('.tooltip-action'));
    }

    {
        // La centaine d'infobulles de la page ne doit rien sentir de tout cela :
        // leur chemin reste `textContent`, qui n'interprète rien.
        const s = await mount({ shuffle: true }, COURT);
        await s.survole(s.win.document.getElementById('ordinaire'));
        const bulle = s.bulle();
        check('une infobulle ordinaire reste du texte nu',
            bulle.textContent === 'Une infobulle comme les autres'
            && bulle.children.length === 0
            && !bulle.classList.contains('has-action'));

        await s.quitte(s.win.document.getElementById('ordinaire'), null);
        check('  … et se ferme en quittant, sans sursis',
            !s.bulle().classList.contains('visible'));
    }

    console.log('\nCe que le réglage écrit\n');

    {
        const SETTINGS = read('src', 'web', 'public', 'js', 'settingsModal.js');
        const setPreloadAll = SETTINGS.slice(
            SETTINGS.indexOf('window.MusicPlayer.setPreloadAll = function'),
            SETTINGS.indexOf('/** Du réglage enregistré vers la position du curseur. */'));

        check('les deux listes passent à « toutes les pistes »',
            /queueCount: PRELOAD_ALL/.test(setPreloadAll)
            && /playlistCount: PRELOAD_ALL/.test(setPreloadAll));
        check('  … et l\'historique garde la sienne',
            /historyCount: previous\.historyCount/.test(setPreloadAll),
            'on ne revient pas en arrière au hasard');
        check('  … avec le préchargement rallumé s\'il ne l\'était pas',
            /enabled: true/.test(setPreloadAll));
        check('l\'invité le garde pour lui',
            /window\.MusicPlayer\.isGuest\(\)/.test(setPreloadAll),
            'le préchargement est un réglage du serveur, refusé côté serveur');
    }

    console.log('\nLes quatre langues\n');

    for (const lang of ['fr', 'en', 'es', 'de']) {
        const dict = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'locales', `${lang}.json`), 'utf8'));
        const clefs = ['tooltip_mode_shuffle', 'shuffle_preload_hint',
            'shuffle_preload_action', 'shuffle_preload_done'];
        const manquantes = clefs.filter(k => !dict[k]);
        check(`« ${lang} » dit le mode et son invitation`, manquantes.length === 0,
            manquantes.join(', '));
    }
}

browserSide().then(() => {
    console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
    process.exit(failed === 0 ? 0 : 1);
});
