/**
 * Vérifie l'affichage de la sonie du fichier en cours, et de son gain.
 *
 * Le curseur de volume ne dit rien du morceau. Deux fichiers lus au même
 * réglage ne s'entendent pas au même niveau : un master moderne sort autour de
 * −7 LUFS, un enregistrement classique autour de −25. Quinze décibels d'écart,
 * invisibles jusqu'ici, alors que ce sont eux qui font tendre la main vers le
 * curseur à chaque changement de titre.
 *
 * Quatre choses portent le sens, et aucune ne se voit dans un diff.
 *
 *  - **Deux unités, pas une.** La mesure est en LUFS, le gain en dB. Côte à
 *    côte, deux nombres en décibels se liraient comme une seule valeur coupée
 *    en deux, alors que l'une décrit le fichier et l'autre ce qu'on lui fait.
 *
 *  - **La source est l'état, et rien d'autre.** Ces deux nombres ne bougent
 *    qu'au changement de titre ; un flux dédié à dix hertz rafraîchirait
 *    dix fois par seconde une valeur qui tient plusieurs minutes. Les prendre
 *    dans l'état les fait changer au même instant que le titre affiché
 *    au-dessus — ce qu'un flux séparé n'aurait pas garanti.
 *
 *  - **La sonie ne dépend pas du mode de diffusion.** Elle est une propriété du
 *    fichier, pas de l'endroit d'où sort le son : commune ou personnelle, la
 *    même valeur.
 *
 *  - **Ce qui n'est pas mesuré ne s'invente pas.** Une piste dont l'analyse
 *    tourne encore montre son attente ; une piste hors de portée de l'analyse
 *    ne montre rien du tout.
 *
 * Le module est exécuté tel quel sur un DOM simulé, comme les animations
 * d'en-tête : ce qui est mesuré est le fichier livré.
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(
    path.join(ROOT, 'src', 'web', 'public', 'js', 'outputLevel.js'), 'utf8');
const MARKUP = fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'css', 'player.css'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'app.js'), 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'src', 'web', 'WebServer.js'), 'utf8');

let failed = 0;
let passed = 0;
const check = (label, ok, detail = '') => {
    if (ok) { passed++; console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`); }
    else { failed++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
};

/** Élément factice : ce que le module lit et écrit, et rien de plus. */
function makeElement(id) {
    const classes = new Set();
    return {
        id,
        hidden: false,
        textContent: '',
        classList: {
            add: (name) => classes.add(name),
            remove: (name) => classes.delete(name),
            toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
            contains: (name) => classes.has(name),
        },
    };
}

function mount() {
    const els = {
        'output-level': makeElement('output-level'),
        'output-level-db': makeElement('output-level-db'),
        'output-level-gain': makeElement('output-level-gain'),
    };
    els['output-level'].hidden = true;   // tel que le balisage le livre

    const sandbox = {
        window: { MusicPlayer: { state: null } },
        document: { getElementById: (id) => els[id] || null },
        Number, Math, console,
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(SOURCE, sandbox);

    const api = sandbox.window.MusicPlayer;

    return {
        els,
        api,
        /** Pose un état et repeint, comme le fait `updateUI`. */
        play: (loudness, extra = {}) => {
            api.state = {
                settings: { broadcastMode: 'everyone' },
                currentTrack: loudness === null ? null : { title: 'x', loudness },
                ...extra,
            };
            api.refreshOutputLevel();
        },
    };
}

const dbOf = (m) => m.els['output-level-db'].textContent;
const gainOf = (m) => m.els['output-level-gain'].textContent;

console.log('\n=== La sonie du fichier en cours, et son gain ===\n');

// ───────────────────── La mesure ─────────────────────

console.log('Ce que la mesure affiche\n');

{
    const m = mount();

    m.play({ status: 'measured', measured: -14.2, gainDb: 0 });
    check('la sonie mesurée s\'affiche en LUFS', dbOf(m) === '−14.2 LUFS', dbOf(m));
    check('  … et l\'afficheur sort de l\'ombre', m.els['output-level'].hidden === false);
    check('le signe moins est le vrai, pas un trait d\'union',
        dbOf(m).charCodeAt(0) === 0x2212, `U+${dbOf(m).charCodeAt(0).toString(16)}`);

    // Un master compressé et un enregistrement discret : les deux bouts de
    // l'écart que cet afficheur existe pour rendre visible.
    m.play({ status: 'measured', measured: -7, gainDb: 0 });
    check('un master compressé se lit tel quel', dbOf(m) === '−7.0 LUFS', dbOf(m));
    m.play({ status: 'measured', measured: -25.4, gainDb: 0 });
    check('  … et un enregistrement discret aussi', dbOf(m) === '−25.4 LUFS', dbOf(m));

    // La sonie d'un fichier très court peut passer au-dessus de zéro.
    m.play({ status: 'measured', measured: 1.5, gainDb: 0 });
    check('une sonie positive ne perd pas son chiffre', dbOf(m) === '1.5 LUFS', dbOf(m));
}

// ───────────────────── Le gain, à côté ─────────────────────

console.log('\nLe gain, distinct de la mesure\n');

{
    const m = mount();

    m.play({ status: 'measured', measured: -14, gainDb: 0 });
    check('un gain nul n\'est pas un réglage : rien ne s\'affiche',
        gainOf(m) === '' && m.els['output-level-gain'].classList.contains('hidden'));

    m.play({ status: 'measured', measured: -14, gainDb: -1.5 });
    check('une atténuation s\'annonce signée', gainOf(m) === '−1.5 dB', gainOf(m));
    check('  … sans passer pour une amplification',
        !m.els['output-level-gain'].classList.contains('is-boost'));

    m.play({ status: 'measured', measured: -14, gainDb: 3.2 });
    check('une amplification aussi', gainOf(m) === '+3.2 dB', gainOf(m));
    check('  … et se distingue à l\'œil',
        m.els['output-level-gain'].classList.contains('is-boost'),
        'deux valeurs voisines se liraient comme une seule');

    // Les deux unités ne se confondent pas : l'une décrit le fichier, l'autre
    // ce qu'on lui fait.
    check('la mesure et le gain ne portent pas la même unité',
        dbOf(m).endsWith('LUFS') && gainOf(m).endsWith('dB'),
        `${dbOf(m)} / ${gainOf(m)}`);
}

// ───────────────────── Ce qui n'est pas connu ─────────────────────

console.log('\nCe qui n\'est pas encore mesuré\n');

{
    const m = mount();

    m.play({ status: 'analyzing', measured: null, gainDb: 0 });
    check('une analyse en cours montre son attente', dbOf(m) === '…', dbOf(m));
    check('  … sans mot, l\'interface étant traduite',
        m.els['output-level'].hidden === false
        && m.els['output-level-db'].classList.contains('is-pending'));
    check('  … et sans gain, qui ne voudrait rien dire sans mesure',
        gainOf(m) === '');

    // Un flux distant, que l'analyse ne peut pas atteindre : il n'y a pas de
    // valeur à taire, il n'y en a pas.
    m.play({ status: 'unavailable', measured: null, gainDb: 0 });
    check('un fichier hors de portée n\'affiche rien',
        m.els['output-level'].hidden === true);

    m.play(null);
    check('sans piste en lecture non plus', m.els['output-level'].hidden === true);

    // Et l'attente se referme quand la mesure arrive.
    m.play({ status: 'measured', measured: -9.8, gainDb: 0 });
    check('la mesure venue, l\'attente s\'efface',
        dbOf(m) === '−9.8 LUFS'
        && !m.els['output-level-db'].classList.contains('is-pending'));
}

// ───────────────────── Le mode de diffusion ─────────────────────

console.log('\nCe que le mode de diffusion n\'y change pas\n');

{
    const m = mount();
    const loudness = { status: 'measured', measured: -18.3, gainDb: 2 };

    m.play(loudness);
    const commune = dbOf(m);

    m.api.state = {
        settings: { broadcastMode: 'personal' },
        currentTrack: { title: 'x', loudness },
    };
    m.api.refreshOutputLevel();

    check('la sonie est la même en diffusion personnelle', dbOf(m) === commune,
        'elle est une propriété du fichier, pas de sa destination');
}

// ───────────────────── Le raccordement ─────────────────────

console.log('\nCe qui tient les deux bouts\n');

{
    const row = MARKUP.slice(MARKUP.indexOf('data-i18n="main_volume"'),
        MARKUP.indexOf('id="volume-range"'));
    check('les deux valeurs sont à droite du libellé, pas du curseur',
        row.includes('id="output-level"'),
        'le curseur se règle, celles-ci se constatent');
    check('elles sont masquées tant que rien n\'est mesuré',
        /id="output-level"[^>]*hidden/.test(row));

    check('elles ne bougent pas de largeur d\'un titre à l\'autre',
        /\.output-level \{[^}]*font-variant-numeric: tabular-nums/.test(CSS)
        && /\.output-level-db \{[^}]*min-width/.test(CSS));

    // La peinture voyage avec l'état : c'est ce qui met la mesure au même
    // instant que le titre affiché au-dessus d'elle.
    check('l\'afficheur est repeint avec le reste de l\'état',
        /refreshOutputLevel === 'function'[\s\S]{0,80}refreshOutputLevel\(\)/.test(APP));

    /*
     * Le flux dédié a été retiré, et c'est le fond de l'affaire.
     *
     * Il avait été bâti pour suivre le volume après atténuation vocale, qui
     * bouge en continu. Ce n'est plus ce qui est affiché : deux propriétés de
     * la piste ne justifient pas un minuteur, des abonnés, une permission et
     * un réabonnement à chaque reconnexion.
     */
    check('aucun flux dédié ne subsiste côté serveur',
        !/levelStream|LEVEL_RATE_HZ|_levelSubscribers/.test(SERVER),
        'deux valeurs par titre ne valent pas un minuteur');
    check('  … ni côté tableau de bord',
        !/levelStream|onLevelSnapshot|resubscribeLevelStream/.test(APP)
        && !/levelStream/.test(SOURCE));
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
