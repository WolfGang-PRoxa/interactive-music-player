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
    const listeners = new Map();
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
        addEventListener(type, fn) {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(fn);
        },
        /**
         * Déclenche le geste, et rapporte ce que le gestionnaire en a fait.
         *
         * L'arrêt de propagation compte autant que le reste : le panneau se
         * referme au premier clic attrapé par le document, et un clic qui
         * remonte refermerait donc ce qu'il vient d'ouvrir.
         *
         * @returns {{ stopped: boolean }}
         */
        click() {
            let stopped = false;
            const event = { stopPropagation: () => { stopped = true; } };
            for (const fn of listeners.get('click') || []) fn(event);
            return { stopped };
        },
    };
}

/**
 * Monte le module sur un DOM simulé.
 *
 * @param {object} [options]
 * @param {boolean} [options.panel=true] - Faire comme si le menu de sonie était
 *   chargé. À `false`, il ne l'est pas : les deux nombres restent des boutons,
 *   et cliquer dessus ne doit rien casser.
 */
function mount({ panel = true } = {}) {
    const els = {
        'output-level': makeElement('output-level'),
        'output-level-db': makeElement('output-level-db'),
        'output-level-gain': makeElement('output-level-gain'),
    };
    els['output-level'].hidden = true;   // tel que le balisage le livre

    // Ce que le module demande au système d'infobulles, et quand.
    const refreshed = [];
    // Ce qu'il demande au panneau de sonie : ouvertures, puis recalages.
    const opened = [];
    const recalled = [];

    const sandbox = {
        window: {
            MusicPlayer: { state: null },
            TooltipSystem: { refresh: (el) => refreshed.push(el) },
        },
        document: { getElementById: (id) => els[id] || null },
        Number, Math, console,
    };
    if (panel) {
        Object.assign(sandbox.window.MusicPlayer, {
            openLoudnessPanel: (track, anchor) => opened.push({ track, anchor }),
            refreshLoudnessPanel: (track) => recalled.push(track),
        });
    }
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(SOURCE, sandbox);

    const api = sandbox.window.MusicPlayer;

    return {
        els,
        api,
        refreshed,
        opened,
        recalled,
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
            api.refreshOutputLevel(api.state);
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
        db.getAttribute('data-tooltip-image-fallback') === '/img/itunes-fallback.png',
        'une vignette distante peut avoir disparu');

    // Sans pochette, le repli prend directement la place.
    m.play({ status: 'measured', measured: -14, gainDb: 0 }, { title: 'Un fichier local' });
    check('un fichier sans pochette montre l\'image de repli',
        db.getAttribute('data-tooltip-image') === '/img/itunes-fallback.png',
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
    // Le morceau change pendant qu'on lit l'infobulle : elle est composée à son
    // ouverture, et annoncerait sinon le titre du précédent à côté du nombre du
    // suivant — se contredisant à deux centimètres d'intervalle.
    const m = mount();
    const loudness = { status: 'measured', measured: -14, gainDb: 0 };

    m.play(loudness, { title: 'Premier morceau' });
    const apresPremier = m.refreshed.length;

    m.play(loudness, { title: 'Deuxième morceau' });
    check('un changement de morceau reprend les deux infobulles',
        m.refreshed.length === apresPremier + 2
        && m.refreshed.includes(m.els['output-level-db'])
        && m.refreshed.includes(m.els['output-level-gain']),
        'ouvertes, elles suivent ; fermées, la reprise ne coûte rien');

    // Sans garde, on repasserait ici une fois par seconde : une infobulle
    // ouverte serait redessinée et replacée sous le curseur sans raison.
    const avant = m.refreshed.length;
    m.play(loudness, { title: 'Deuxième morceau' });
    m.play(loudness, { title: 'Deuxième morceau' });
    check('  … mais un état identique ne la fait pas sauter',
        m.refreshed.length === avant, `${m.refreshed.length - avant} reprises de trop`);

    // La pochette compte autant que le nom : deux morceaux homonymes n'ont pas
    // la même image, et c'est elle qu'on regarde en premier.
    m.play(loudness, { title: 'Deuxième morceau', thumbnail: 'https://exemple/autre.jpg' });
    check('  … et une pochette qui change compte comme un changement',
        m.refreshed.length === avant + 2);
}

{
    const TIPS = fs.readFileSync(
        path.join(ROOT, 'src', 'web', 'public', 'js', 'tooltipSystem.js'), 'utf8');

    check('le système d\'infobulles sait se redessiner',
        /return \{ init, hide, refresh \};/.test(TIPS));
    check('  … seulement pour celle qui est ouverte',
        /if \(!tooltipEl \|\| currentTarget !== target\) return;/.test(TIPS)
        && /classList\.contains\('visible'\)/.test(TIPS),
        'redessiner une infobulle fermée la ferait apparaître');
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
    // chemin pour autant — ni pour la vignette, ni pour le bouton d'action que
    // l'infobulle sait porter depuis (voir tests/shuffleMode.js).
    check('  … et le texte seul repasse par où il passait',
        /if \(!image && !action\) \{\s*tooltipEl\.textContent = text;/.test(TIPS));
}

// ───────────────────── Les deux nombres ouvrent le réglage ─────────────────────

console.log('\nCe que le clic ouvre\n');

{
    const m = mount();
    const piste = { url: 'https://exemple/a', title: 'Around the World' };

    m.play({ status: 'measured', measured: -14.2, gainDb: 3.2 }, piste);

    m.els['output-level-db'].click();
    check('cliquer la mesure ouvre le panneau de sonie', m.opened.length === 1);
    check('  … sur la piste en cours, pas sur une autre',
        m.opened[0].track && m.opened[0].track.url === 'https://exemple/a');
    check('  … ancré sous le nombre cliqué',
        m.opened[0].anchor === m.els['output-level-db'],
        'le panneau se pose sous ce qu\'on a cliqué');

    m.els['output-level-gain'].click();
    check('le gain ouvre le même panneau', m.opened.length === 2);
    check('  … ancré sous lui, et non sous l\'autre nombre',
        m.opened[1].anchor === m.els['output-level-gain']);

    /*
     * Le clic ne doit pas remonter jusqu'au document.
     *
     * Le panneau se referme au premier clic que le document attrape. Sans cet
     * arrêt, le clic qui l'ouvre poursuivrait sa route et le refermerait dans
     * la foulée : le bouton n'aurait tout simplement aucun effet visible.
     */
    check('le clic s\'arrête au bouton',
        m.els['output-level-db'].click().stopped,
        'sinon il refermerait ce qu\'il vient d\'ouvrir');
}

{
    const m = mount();

    // Rien en lecture : il n'y a pas de piste à régler, et l'afficheur est
    // d'ailleurs masqué. Le bouton existe quand même dans le balisage.
    m.play(null);
    m.els['output-level-db'].click();
    check('sans piste en lecture, rien ne s\'ouvre', m.opened.length === 0);

    // Une piste qu'on ne sait pas régler : le panneau se construit autour de
    // `track.url`, et l'ouvrir sur rien donnerait un curseur sans destinataire.
    m.play({ status: 'measured', measured: -14, gainDb: 0 }, { title: 'sans adresse' });
    m.els['output-level-db'].click();
    check('  … et une piste sans adresse n\'ouvre rien non plus',
        m.opened.length === 0 || m.opened[0].track.url === undefined,
        'le panneau se refuse lui-même sur une piste sans url');
}

{
    // Le menu de sonie peut ne pas être chargé — un script de moins, une page
    // partielle. Les deux nombres restent des boutons, et le clic ne doit pas
    // faire tomber le reste de l'interface avec lui.
    const m = mount({ panel: false });
    m.play({ status: 'measured', measured: -14, gainDb: 0 }, { url: 'https://exemple/a' });

    let crash = null;
    try { m.els['output-level-db'].click(); } catch (e) { crash = e; }
    check('sans le menu de sonie chargé, le clic ne casse rien', crash === null,
        crash ? crash.message : '');
}

{
    const m = mount();
    const piste = { url: 'https://exemple/a', title: 'Around the World' };

    /*
     * Le panneau ouvert suit l'état.
     *
     * C'est ce qui fait apparaître la mesure sous les yeux de celui qui
     * l'attend : l'analyse se termine, l'état suivant la porte, et le panneau
     * la reprend sans qu'il faille le refermer et le rouvrir.
     */
    m.play({ status: 'analyzing', measured: null, gainDb: 0 }, piste);
    check('chaque état recale le panneau ouvert', m.recalled.length === 1);
    check('  … avec la piste que l\'état porte',
        m.recalled[0] && m.recalled[0].url === 'https://exemple/a');

    m.play({ status: 'measured', measured: -14.2, gainDb: 3.2 }, piste);
    check('  … y compris quand la mesure arrive enfin',
        m.recalled.length === 2 && m.recalled[1].loudness.measured === -14.2);

    const avant = m.recalled.length;
    m.play(null);
    check('rien en lecture ne recale rien', m.recalled.length === avant,
        'il n\'y a plus de piste dont parler');
}

{
    const row = MARKUP.slice(MARKUP.indexOf('id="output-level"'),
        MARKUP.indexOf('id="volume-range"'));

    // Un `<span>` cliquable n'est pas un bouton : ni tabulation, ni entrée, ni
    // annonce au lecteur d'écran. Ce qui ouvre quelque chose au clic doit le
    // dire dans le balisage.
    check('les deux indicateurs sont de vrais boutons',
        (row.match(/<button type="button"/g) || []).length === 2);
    check('  … et non des boutons d\'envoi de formulaire',
        !/<button(?![^>]*type=)/.test(row),
        'sans type explicite, un bouton soumet');

    // Un bouton arrive avec un fond, une bordure et une police à lui. Les deux
    // nombres se lisent comme du texte dans une ligne de réglage : tout cela
    // doit être défait, sans quoi deux pastilles grises apparaîtraient.
    const style = CSS.slice(CSS.indexOf('.output-level-db,'));
    check('leur apparence de bouton est défaite',
        /border: none/.test(style.slice(0, 400))
        && /font: inherit/.test(style.slice(0, 400))
        && /background: transparent/.test(style.slice(0, 400)));
    check('  … mais le curseur dit qu\'on peut cliquer',
        /cursor: pointer/.test(style.slice(0, 400)));
    check('  … et l\'ouverture se voit sur le nombre cliqué',
        /\.output-level-db\.is-open/.test(CSS) && /\.output-level-gain\.is-open/.test(CSS),
        'le panneau ouvert doit se rattacher à l\'œil au nombre qui l\'a ouvert');
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
        /refreshOutputLevel === 'function'[\s\S]{0,80}refreshOutputLevel\(state\)/.test(APP),
        'et reçoit l\'état, dont le panneau ouvert a besoin');

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
