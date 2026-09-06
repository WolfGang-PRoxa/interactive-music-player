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
    const attributes = new Map();
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
        setAttribute: (name, value) => attributes.set(name, value),
        removeAttribute: (name) => attributes.delete(name),
        getAttribute: (name) => (attributes.has(name) ? attributes.get(name) : null),
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
        /**
         * Pose un état et repeint, comme le fait `updateUI`.
         *
         * @param {object|null} loudness - `null` pour « rien en lecture ».
         * @param {object} [track] - De quoi compléter la piste : titre, vignette.
         */
        play: (loudness, track = {}) => {
            api.state = {
                settings: { broadcastMode: 'everyone' },
                currentTrack: loudness === null
                    ? null
                    : Object.assign({ title: 'x' }, track, { loudness }),
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

// ───────────────────── Ce que les infobulles situent ─────────────────────

console.log('\nCe que les infobulles ajoutent aux deux nombres\n');

{
    const m = mount();
    const db = m.els['output-level-db'];
    const gain = m.els['output-level-gain'];

    m.play({ status: 'measured', measured: -14, gainDb: 2 },
        { title: 'Daft Punk — Around the World', thumbnail: 'https://exemple/pochette.jpg' });

    // Les deux nombres la portent : chacun ne commente qu'une valeur, et une
    // valeur ne dit rien tant qu'on ignore de quel morceau elle parle.
    check('les deux indicateurs nomment le morceau',
        db.getAttribute('data-tooltip-title') === 'Daft Punk — Around the World'
        && gain.getAttribute('data-tooltip-title') === 'Daft Punk — Around the World');

    check('  … et montrent sa pochette',
        db.getAttribute('data-tooltip-image') === 'https://exemple/pochette.jpg'
        && gain.getAttribute('data-tooltip-image') === 'https://exemple/pochette.jpg');

    // Une adresse reçue il y a une minute peut ne plus rien servir.
    check('  … en gardant un repli sous la main',
        db.getAttribute('data-tooltip-image-fallback') === 'img/itunes-fallback.png',
        'une vignette distante peut avoir disparu');

    // Sans pochette, le repli prend directement la place.
    m.play({ status: 'measured', measured: -14, gainDb: 0 }, { title: 'Un fichier local' });
    check('un fichier sans pochette montre l\'image de repli',
        db.getAttribute('data-tooltip-image') === 'img/itunes-fallback.png',
        db.getAttribute('data-tooltip-image'));

    check('le repli est servi par le bot, pas par un site tiers',
        !/^https?:/.test(db.getAttribute('data-tooltip-image')),
        'le tableau de bord s\'utilise en réseau local');

    // Un titre vide ne doit pas laisser l'attribut de la piste précédente.
    m.play({ status: 'measured', measured: -14, gainDb: 0 }, { title: '' });
    check('un morceau sans nom n\'hérite pas de celui d\'avant',
        db.getAttribute('data-tooltip-title') === null);
}

{
    const row = MARKUP.slice(MARKUP.indexOf('id="output-level"'),
        MARKUP.indexOf('id="volume-range"'));

    // Sans `data-tooltip`, la délégation ne reconnaît même pas la cible.
    check('les deux indicateurs se déclarent survolables',
        (row.match(/data-tooltip=/g) || []).length === 2,
        'la délégation cherche [data-tooltip], et rien d\'autre');
    check('  … et sont traduits comme le reste de la page',
        row.includes('data-i18n-tooltip="tooltip_output_lufs"')
        && row.includes('data-i18n-tooltip="tooltip_output_gain"'));

    for (const lang of ['fr', 'en', 'es', 'de']) {
        const dict = JSON.parse(fs.readFileSync(
            path.join(ROOT, 'src', 'web', 'public', 'locales', `${lang}.json`), 'utf8'));
        const both = ['tooltip_output_lufs', 'tooltip_output_gain']
            .every(k => typeof dict[k] === 'string' && dict[k].trim());
        check(`${lang}.json explique les deux nombres`, both);
    }

    check('l\'image de repli est bien dans le dépôt',
        fs.existsSync(path.join(ROOT, 'src', 'web', 'public', 'img', 'itunes-fallback.png')));
}

{
    const TIPS = fs.readFileSync(
        path.join(ROOT, 'src', 'web', 'public', 'js', 'tooltipSystem.js'), 'utf8');

    // Le nom affiché vient du fichier en cours, donc d'ailleurs : une balise
    // glissée dans un titre ne doit pas devenir du balisage.
    // L'affectation, et non le mot : il figure aussi dans le commentaire qui
    // explique pourquoi on s'en passe.
    check('l\'infobulle illustrée est bâtie nœud par nœud',
        /name\.textContent = title;/.test(TIPS) && !/\.innerHTML\s*=/.test(TIPS),
        'le titre vient d\'un fichier, pas de nous');

    // La centaine d'infobulles textuelles de la page ne doit pas changer de
    // chemin pour autant.
    check('  … et le texte seul repasse par où il passait',
        /if \(!image\) \{\s*tooltipEl\.textContent = text;/.test(TIPS));
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
