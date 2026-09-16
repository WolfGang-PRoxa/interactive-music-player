/**
 * Vérifie le mode de lecture aléatoire, et le menu qui l'accompagne.
 *
 * Le mode n'est pas un quatrième parcours : c'est un interrupteur posé à côté
 * des trois autres. Quatre choses le distinguent, et aucune ne se lit dans un
 * diff.
 *
 *  - **Il tient avec le bouclage de playlist.** Relire une playlist en la
 *    rebattant à chaque tour est une demande courante, et les deux réglages
 *    vivent ensemble. Il ne tient pas, en revanche, avec la répétition de la
 *    piste, qui ne fait jamais avancer la file : il n'y aurait aucun titre
 *    suivant à tirer, et deux boutons allumés dont l'un n'agit pas
 *    laisseraient croire le contraire. Son bouton allume et n'éteint pas, comme
 *    les trois autres : recliquer dessus ne referme que le menu.
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
 *  - **Le préchargement devient la seule préparation possible.** Réglé sans
 *    limite, il met la file ou les playlists entières en cache, et le tirage
 *    tombe toujours sur un morceau prêt. Ce réglage vit à trois clics de là :
 *    le bouton ondule tant qu'il manque, et le menu qu'il ouvre le règle, liste
 *    par liste, sans toucher à l'historique — on ne revient pas en arrière au
 *    hasard.
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
database.updateSettings = (guildId, champs) => { Object.assign(settings, champs); };

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

/* ══════════════════ Trois modes, et un quatrième par-dessus ══════════════════ */

console.log('\nCe qu\'un clic sur un bouton de mode change\n');

/**
 * Le vrai `handleSetPlayMode`, exercé sur une file factice.
 *
 * Les réglages sont ceux tenus en mémoire plus haut, et la file ne retient que
 * le mode de répétition qu'on lui pose : ce qui est mesuré est donc la règle
 * livrée, et non une copie qui pourrait s'en écarter sans que rien ne le dise.
 */
const { handleSetPlayMode } = require(
    path.join(ROOT, 'src', 'web', 'websocket', 'handlers', 'playbackHandlers.js'));
const playbackStateManager = require(path.join(ROOT, 'src', 'database', 'PlaybackStateManager.js'));
playbackStateManager.saveState = () => {};

const { QueueRepeatMode } = require('discord-player');

function clic(mode, depart) {
    settings = { loopPlaylist: false, shuffle: false, ...depart };
    const queue = {
        repeatMode: depart && depart.repeatMode !== undefined ? depart.repeatMode : QueueRepeatMode.OFF,
        isShuffling: false,
        setRepeatMode(m) { this.repeatMode = m; },
        enableShuffle() { this.isShuffling = true; },
        disableShuffle() { this.isShuffling = false; },
    };
    handleSetPlayMode({
        data: { mode },
        webServer: { applyShuffle: (q, g) => webServer.applyShuffle(q, g), broadcastState: () => {} },
        player: {},
        currentGuildId: 'G1',
        queue,
    });
    return { queue, ...settings };
}

{
    const apres = clic('shuffle', { shuffle: false });
    check('cliquer sur l\'aléatoire l\'allume', apres.shuffle === true);
    check('  … et met la file en mélange dynamique', apres.queue.isShuffling === true);
}

{
    const apres = clic('shuffle', { shuffle: true });
    check('recliquer dessus ne l\'éteint pas', apres.shuffle === true,
        'son bouton allume, comme les trois autres ; c\'est le menu que ce clic referme');
}

{
    const apres = clic('shuffle', { shuffle: false, loopPlaylist: true });
    check('il n\'éteint pas le bouclage de playlist',
        apres.shuffle === true && apres.loopPlaylist === true,
        'relire une playlist en la rebattant est une demande courante');
}

{
    const apres = clic('loop_playlist', { shuffle: true });
    check('et le bouclage de playlist ne l\'éteint pas non plus',
        apres.loopPlaylist === true && apres.shuffle === true);
}

{
    const apres = clic('shuffle', { shuffle: false, repeatMode: QueueRepeatMode.TRACK });
    check('il éteint la répétition de la piste',
        apres.queue.repeatMode === QueueRepeatMode.OFF,
        'une piste répétée ne fait jamais avancer la file : rien à tirer');
}

{
    const apres = clic('loop_track', { shuffle: true, loopPlaylist: true });
    check('la répétition de la piste l\'éteint en retour',
        apres.shuffle === false && apres.loopPlaylist === false,
        apres.queue.repeatMode === QueueRepeatMode.TRACK ? 'piste en boucle' : 'mode inattendu');
}

{
    const apres = clic('default', { shuffle: true, loopPlaylist: true });
    check('la lecture suivie éteint tout',
        apres.shuffle === false && apres.loopPlaylist === false
        && apres.queue.repeatMode === QueueRepeatMode.OFF);
}

{
    // Un mode changé sans file de lecture ne doit pas jeter : le lecteur peut
    // n'avoir jamais démarré.
    let jete = false;
    try {
        handleSetPlayMode({
            data: { mode: 'shuffle' }, webServer: {}, player: {}, currentGuildId: 'G1', queue: null,
        });
    } catch (e) { jete = true; }
    check('sans file de lecture, le clic ne casse rien', !jete);
}

console.log('\nCe que le serveur en garde\n');

const HANDLERS = read('src', 'web', 'websocket', 'handlers', 'playbackHandlers.js');

check('le changement de mode accorde la file au réglage',
    /webServer\.applyShuffle\(queue, currentGuildId\)/.test(HANDLERS),
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

check('  … avec le symbole plein, qui suit la couleur du bouton',
    (MARKUP.match(/d="M8\.7,14\.2C8,14\.7/g) || []).length === 2
    && (MARKUP.match(/class="mode-switch-btn mode-shuffle"[\s\S]{0,200}?fill="currentColor"/g) || []).length === 2,
    'reconnu à son tracé : la page compte trente icônes pleines');

check('l\'infobulle est redevenue une infobulle',
    !MARKUP.includes('data-tooltip-action')
    && !read('src', 'web', 'public', 'js', 'tooltipSystem.js').includes('actionOf'),
    'c\'est le menu qui porte le geste, elle n\'a plus à le faire');

/*
 * Le glyphe du mode est plein, et ne remplit pas sa boîte : dix unités de haut
 * sur vingt-quatre, là où les icônes au trait vont d'un bord à l'autre. Sans une
 * taille à lui, il paraît plus petit que ses voisins — ce que l'œil voit, et
 * qu'aucune règle générale ne rattrape.
 */
{
    const tailleDe = (css, prefixe) => new RegExp(
        prefixe + '\\.mode-switch-btn\\.mode-shuffle svg \\{[^}]*width: (\\d+)px').exec(css);

    const carte = tailleDe(read('src', 'web', 'public', 'css', 'modals.css'), '');
    const video = tailleDe(read('src', 'web', 'public', 'css', 'video.css'),
        '\\.video-play-mode-switch ');

    check('le symbole a une taille à lui, dans les deux sélecteurs',
        Boolean(carte) && Boolean(video)
        && Number(carte[1]) > 16 && Number(video[1]) > 15,
        carte && video ? `${carte[1]} px dans la carte, ${video[1]} px dans la vidéo` : 'règle absente');
}

/* ══════════════════ Le menu, dans un vrai document ══════════════════ */

/**
 * L'onde, le menu et ses boutons — avec les vrais player.js et shuffleHint.js
 * dans jsdom.
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
    const SHUFFLE = read('src', 'web', 'public', 'js', 'shuffleHint.js');

    const groupe = (extra = '') => `<div class="play-mode-switch ${extra}">`
        + '<button class="mode-switch-btn" data-mode="default"></button>'
        + '<button class="mode-switch-btn" data-mode="loop_track"></button>'
        + '<button class="mode-switch-btn" data-mode="loop_playlist"></button>'
        + '<button class="mode-switch-btn mode-shuffle" data-mode="shuffle"'
        + ' data-tooltip="Lire les musiques dans un ordre aléatoire"></button>'
        + '</div>';

    const mount = async (preloading, actif = false) => {
        const dom = new JSDOM(`<!doctype html><html><body>${groupe()}${groupe('video-play-mode-switch')}`
            + '<button id="ailleurs">Ailleurs</button></body></html>',
            { runScripts: 'outside-only', url: 'http://localhost:3000/', pretendToBeVisual: true });

        const win = dom.window;
        const reglees = [];
        win.MusicPlayer = {
            state: { shuffle: actif },
            // Copié : le réglage est muté par le menu, et deux cas ne
            // doivent pas se passer le résultat de l'autre.
            dashboardSettings: { language: 'fr', preloading: { ...preloading } },
            t: (key) => fr[key] || key,
            setPreloadAll: (quoi) => {
                reglees.push(quoi);
                const p = win.MusicPlayer.dashboardSettings.preloading;
                p.enabled = true;
                if (!quoi || quoi === 'queue') p.queueCount = -1;
                if (!quoi || quoi === 'playlist') p.playlistCount = -1;
                win.MusicPlayer.refreshShuffleHint();
            },
        };

        win.eval(SHUFFLE);
        // Le module attend le chargement du document pour poser ses écouteurs.
        if (win.document.readyState !== 'complete') {
            await new Promise((resolve) => win.addEventListener('load', resolve));
        }

        /*
         * L'aperçu optimiste du tableau de bord, tel qu'app.js le déclenche :
         * il peint le bouton puis prévient le module, et c'est ce couple que le
         * menu suit. La règle elle-même est celle de js/player.js, chargée ici.
         */
        win.eval(read('src', 'web', 'public', 'js', 'player.js')
            .split('// Controller de mode d\'animation')[0]);
        for (const btn of win.document.querySelectorAll('.mode-switch-btn')) {
            btn.addEventListener('click', () => {
                win.MusicPlayer.previewPlayMode(btn.getAttribute('data-mode'));
            });
        }

        /*
         * Un clic, puis l'état que le serveur diffuserait en retour — c'est lui
         * que le module relit, l'aperçu optimiste ne faisant que peindre. Le
         * tableau de bord repeint alors sa carte, d'où le second appel.
         */
        const clique = async (el) => {
            el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
            await new Promise(r => setTimeout(r, 20));

            if (el.closest && el.closest('.mode-switch-btn')) {
                const shuffle = win.document.querySelector('.mode-shuffle');
                win.MusicPlayer.state = { shuffle: shuffle.classList.contains('active') };
                win.MusicPlayer.refreshShuffleHint();
                await new Promise(r => setTimeout(r, 20));
            }
        };

        return {
            win, reglees, clique,
            boutons: [...win.document.querySelectorAll('.mode-shuffle')],
            menu: () => win.document.getElementById('shuffle-menu'),
            ouvert: () => {
                const m = win.document.getElementById('shuffle-menu');
                return Boolean(m) && !m.hidden;
            },
        };
    };

    const COURT = { enabled: true, queueCount: 3, playlistCount: 3, historyCount: 3 };
    const TOUT = { enabled: true, queueCount: -1, playlistCount: -1, historyCount: 3 };

    console.log('\nQuand le bouton ondule\n');

    {
        const s = await mount(COURT, false);
        s.win.MusicPlayer.refreshShuffleHint();
        check('mode éteint : rien ne bouge',
            s.boutons.every(b => !b.classList.contains('needs-preload')));
    }

    {
        const s = await mount(TOUT, true);
        s.win.MusicPlayer.refreshShuffleHint();
        check('mode actif, tout préchargé : rien non plus',
            s.boutons.every(b => !b.classList.contains('needs-preload')),
            'il n\'y a plus rien à proposer');
    }

    {
        const s = await mount({ enabled: false, queueCount: -1, playlistCount: -1 }, true);
        s.win.MusicPlayer.refreshShuffleHint();
        check('le préchargement éteint compte comme absent',
            s.boutons.every(b => b.classList.contains('needs-preload')),
            'deux infinis dans un réglage désactivé ne préchargent rien');
    }

    {
        const s = await mount(COURT, true);
        s.win.MusicPlayer.refreshShuffleHint();
        check('mode actif, préchargement à la traîne : les deux boutons ondulent',
            s.boutons.length === 2 && s.boutons.every(b => b.classList.contains('needs-preload')));
    }

    console.log('\nLe menu, au clic sur le bouton du mode\n');

    {
        const s = await mount(COURT, false);
        await s.clique(s.boutons[0]);

        check('le clic ouvre le menu', s.ouvert());
        const menu = s.menu();
        check('  … qui dit ce qui vient d\'être activé',
            menu.textContent.includes(fr.shuffle_menu_title));
        check('  … et pourquoi le préchargement compte ici',
            menu.textContent.includes(fr.shuffle_menu_text.slice(0, 40)));

        const btns = [...menu.querySelectorAll('.shuffle-menu-btn')];
        check('  … avec un bouton par liste à régler', btns.length === 2
            && btns[0].dataset.liste === 'queue' && btns[1].dataset.liste === 'playlist',
            btns.map(b => b.textContent).join(' / '));

        await s.clique(btns[0]);
        check('un bouton règle sa liste, et elle seule', s.reglees.join() === 'queue');
        check('  … après quoi il s\'efface',
            [...s.menu().querySelectorAll('.shuffle-menu-btn')].map(b => b.dataset.liste).join() === 'playlist');
        check('  … le menu restant ouvert tant qu\'il reste à faire', s.ouvert());

        await s.clique(s.menu().querySelector('.shuffle-menu-btn'));
        check('la dernière liste réglée ferme le menu', !s.ouvert(),
            'il n\'a plus rien à proposer');
        check('  … et l\'onde s\'arrête',
            s.boutons.every(b => !b.classList.contains('needs-preload')));
    }

    {
        const s = await mount(TOUT, false);
        await s.clique(s.boutons[0]);
        check('tout étant déjà préchargé, le clic n\'ouvre rien', !s.ouvert(),
            'le mode s\'active sans qu\'on ait rien à dire');
        check('  … mais le mode s\'active bien',
            s.boutons.every(b => b.classList.contains('active')));
    }

    {
        const s = await mount(COURT, false);
        await s.clique(s.boutons[1]);
        check('le menu naît sous le bouton touché', s.ouvert(),
            'celui de la fenêtre vidéo comme celui de la carte');

        await s.clique(s.boutons[1]);
        check('un second clic ne referme que le menu', !s.ouvert());
        check('  … le mode restant allumé', s.boutons[1].classList.contains('active'),
            'le bouton allume, il n\'éteint pas');

        await s.clique(s.boutons[1]);
        check('  … et le clic d\'après le rouvre', s.ouvert(),
            'tant qu\'il reste une liste à régler');
    }

    {
        const s = await mount(COURT, false);
        await s.clique(s.boutons[0]);
        await s.clique(s.win.document.getElementById('ailleurs'));
        check('le clic à côté referme', !s.ouvert());

        check('  … sans avoir touché au mode',
            s.boutons[0].classList.contains('active'),
            'refermer le menu n\'éteint rien');

        await s.clique(s.boutons[0]);
        check('  … et le bouton rouvre le menu', s.ouvert());
    }

    {
        const s = await mount(COURT, false);
        await s.clique(s.boutons[0]);
        s.win.document.dispatchEvent(new s.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        check('la touche d\'échappement referme', !s.ouvert());
    }

    console.log('\nL\'aperçu optimiste dit la même chose que le serveur\n');

    {
        const s = await mount(COURT, false);
        const parMode = (nom) => s.win.document.querySelector(`.mode-switch-btn[data-mode="${nom}"]`);

        await s.clique(parMode('loop_playlist'));
        await s.clique(s.boutons[0]);
        check('l\'aléatoire s\'ajoute au bouclage de playlist',
            parMode('loop_playlist').classList.contains('active')
            && parMode('shuffle').classList.contains('active'));

        await s.clique(parMode('default'));
        check('la lecture suivie est la porte de sortie',
            !parMode('shuffle').classList.contains('active')
            && !parMode('loop_playlist').classList.contains('active'),
            'le bouton aléatoire n\'éteignant pas, c\'est par là qu\'on le quitte');

        await s.clique(s.boutons[0]);
        await s.clique(parMode('loop_track'));
        check('la répétition de la piste les éteint tous deux',
            parMode('loop_track').classList.contains('active')
            && !parMode('shuffle').classList.contains('active')
            && !parMode('loop_playlist').classList.contains('active'));

        await s.clique(s.boutons[0]);
        check('et l\'aléatoire éteint la répétition de la piste',
            parMode('shuffle').classList.contains('active')
            && !parMode('loop_track').classList.contains('active'));
    }

    console.log('\nCe que le réglage écrit\n');

    {
        const SETTINGS = read('src', 'web', 'public', 'js', 'settingsModal.js');
        const setPreloadAll = SETTINGS.slice(
            SETTINGS.indexOf('window.MusicPlayer.setPreloadAll = function'),
            SETTINGS.indexOf('/** Du réglage enregistré vers la position du curseur. */'));

        check('chaque liste se règle séparément',
            /listes\.includes\('queue'\) \? PRELOAD_ALL/.test(setPreloadAll)
            && /listes\.includes\('playlist'\) \? PRELOAD_ALL/.test(setPreloadAll));
        check('  … et l\'historique garde sa valeur',
            /historyCount: previous\.historyCount/.test(setPreloadAll),
            'on ne revient pas en arrière au hasard');
        check('  … comme la liste qu\'on n\'a pas réglée',
            /: \(previous\.queueCount \?\? 3\)/.test(setPreloadAll),
            'rallumer le préchargement ne doit pas remettre l\'autre au cran par défaut');
        check('l\'invité le garde pour lui',
            /window\.MusicPlayer\.isGuest\(\)/.test(setPreloadAll),
            'le préchargement est un réglage du serveur, refusé côté serveur');
    }

    console.log('\nLes quatre langues\n');

    for (const lang of ['fr', 'en', 'es', 'de']) {
        const dict = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'locales', `${lang}.json`), 'utf8'));
        const clefs = ['tooltip_mode_shuffle', 'shuffle_menu_title', 'shuffle_menu_text',
            'shuffle_menu_queue', 'shuffle_menu_playlists'];
        const manquantes = clefs.filter(k => !dict[k]);
        check(`« ${lang} » dit le mode et son menu`, manquantes.length === 0,
            manquantes.join(', '));
        check(`  … et ne garde rien de l'infobulle agissante`,
            !['shuffle_preload_hint', 'shuffle_preload_action', 'shuffle_preload_done']
                .some(k => k in dict));
    }
}

browserSide().then(() => {
    console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
    process.exit(failed === 0 ? 0 : 1);
});
