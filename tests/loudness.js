/**
 * Vérifie le réglage de niveau sonore — le LUFS par piste, et sa
 * synchronisation depuis la boîte « Enchaînement Mix ».
 *
 * Cinq choses s'y jouent, dont aucune ne se voit à la relecture :
 *
 *  - **La conversion.** Une cible n'est pas un gain : c'est l'écart à la mesure
 *    qui en est un, et sans mesure il n'y a pas de gain du tout. Confondre les
 *    deux ferait appliquer −14 dB à un morceau qu'on voulait à −14 LUFS.
 *
 *  - **La dégradation.** L'indicateur doit décrire ce que le réglage *ajoute*,
 *    pas ce que le fichier porte déjà. Beaucoup de masters récents dépassent
 *    0 dBTP à la lecture : compter cette marge négative afficherait du rouge
 *    sur un morceau auquel on n'a rien fait.
 *
 *  - **La synchronisation.** Elle recouvre les cibles individuelles sans les
 *    effacer. C'est cette distinction, et elle seule, qui permet de décocher
 *    l'option et de retrouver chaque piste où on l'avait laissée. Une
 *    implémentation qui écrirait la cible commune sur chaque piste passerait
 *    tous les tests d'affichage et perdrait les réglages pour de bon.
 *
 *  - **Le gain dans le mixage.** Il vit à côté de l'enveloppe de fondu, pas à
 *    sa place : un fondu enchaîné doit traverser un morceau remonté de 6 dB
 *    sans effacer ni le fondu ni les 6 dB.
 *
 *  - **Les bornes du curseur.** Elles sont écrites trois fois — le module
 *    serveur, le menu contextuel, le balisage de la boîte Mix. Une divergence
 *    donne un curseur qui affiche une position que le réglage n'atteint pas.
 *
 * La base est déplacée dans un dossier temporaire avant tout `require` : le
 * module de persistance écrit dans `<cwd>/data/settings.json`, et ce test pose
 * des cibles sur des pistes fictives.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'loudness-test-'));
fs.mkdirSync(path.join(SANDBOX, 'data'), { recursive: true });
process.chdir(SANDBOX);

let failed = 0;
let passed = 0;
const check = (label, ok, detail = '') => {
    if (ok) { passed++; console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`); }
    else { failed++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
};

const near = (a, b, tolerance = 0.001) => Math.abs(a - b) <= tolerance;

const database = require(path.join(ROOT, 'src/database/Database'));
const loudness = require(path.join(ROOT, 'src/audio/loudness'));
const { parseLoudnorm } = require(path.join(ROOT, 'src/audio/LoudnessAnalyzer'));

console.log('\n=== Niveau sonore (LUFS) ===\n');

// ────────────────── De la cible au gain ──────────────────

console.log('Ce qu\'une cible vaut en décibels\n');

const LOUD = 'https://example.invalid/loud';     // master compressé
const QUIET = 'https://example.invalid/quiet';   // enregistrement discret
const RAW = 'https://example.invalid/raw';       // jamais mesuré

database.setTrackLoudnessMeasure(LOUD, { measured: -8, peak: -0.5 });
database.setTrackLoudnessMeasure(QUIET, { measured: -22, peak: -6 });

const noSync = { lufsSyncEnabled: false };

check('sans cible, aucun gain',
    loudness.gainDb(LOUD, noSync) === 0);

database.setTrackLoudnessTarget(LOUD, -14);
check('cible sous la mesure → gain négatif',
    near(loudness.gainDb(LOUD, noSync), -6), `${loudness.gainDb(LOUD, noSync)} dB`);

database.setTrackLoudnessTarget(QUIET, -14);
check('cible au-dessus de la mesure → gain positif',
    near(loudness.gainDb(QUIET, noSync), 8), `${loudness.gainDb(QUIET, noSync)} dB`);

check('une piste jamais mesurée reste intouchée',
    loudness.gainDb(RAW, noSync) === 0 && loudness.linearGain(RAW, noSync) === 1);

// Une cible posée sur une piste sans mesure ne doit rien déclencher : le point
// de départ manque, et corriger au jugé serait pire que ne rien faire.
database.setTrackLoudnessTarget(RAW, -14);
check('une cible sans mesure ne fabrique pas de gain',
    loudness.gainDb(RAW, noSync) === 0);

check('−6 dB vaut la moitié de l\'amplitude',
    near(loudness.linear(-6), 0.5012, 0.0005), loudness.linear(-6).toFixed(4));
check('0 dB laisse le signal tel quel', loudness.linear(0) === 1);

check('la cible est arrondie au pas du curseur',
    loudness.clampTarget(-13.7) === -13.5, String(loudness.clampTarget(-13.7)));
check('une cible hors bornes est ramenée dedans',
    loudness.clampTarget(-99) === loudness.TARGET_MIN
    && loudness.clampTarget(0) === loudness.TARGET_MAX);
check('une cible illisible retombe sur la référence de diffusion',
    loudness.clampTarget('bruit') === loudness.DEFAULT_SYNC_TARGET);

// ────────────────── L'indicateur de dégradation ──────────────────

console.log('\nCe que l\'indicateur coloré promet\n');

check('atténuer ne dégrade rien', loudness.degradation(-6, -0.5) === 0);
check('un gain qui tient dans la marge ne dégrade rien',
    loudness.degradation(0.4, -0.5) === 0);
check('au-delà de la marge, la dégradation démarre',
    loudness.degradation(6.5, -0.5) > 0);
check('douze décibels de dépassement saturent l\'indicateur',
    loudness.degradation(12.5, -0.5) === 1);

// Le cas qui motive le plancher à zéro : un fichier dont le pic dépasse déjà le
// plein niveau. L'écrêtage est dans le fichier, pas dans le réglage.
check('un fichier déjà au-dessus du plafond reste au vert sans gain',
    loudness.degradation(0, 3.9) === 0, 'pic +3.9 dBTP, gain nul');
check('mais le moindre gain le fait sortir du vert',
    loudness.degradation(1, 3.9) > 0);

// ────────────────── La synchronisation ──────────────────

console.log('\nCe que la synchronisation recouvre, et ce qu\'elle rend\n');

const synced = { lufsSyncEnabled: true, lufsSyncTarget: -18 };

check('activée, elle impose sa cible à toutes les pistes',
    loudness.effectiveTarget(LOUD, synced) === -18
    && loudness.effectiveTarget(QUIET, synced) === -18);

check('elle corrige chaque piste selon sa propre mesure',
    near(loudness.gainDb(LOUD, synced), -10)
    && near(loudness.gainDb(QUIET, synced), 4),
    `${loudness.gainDb(LOUD, synced)} dB / ${loudness.gainDb(QUIET, synced)} dB`);

check('elle vaut aussi pour une piste qui n\'avait aucune cible',
    (() => {
        database.setTrackLoudnessTarget(QUIET, null);
        return loudness.effectiveTarget(QUIET, synced) === -18;
    })());

check('les cibles individuelles survivent sous la synchronisation',
    database.getTrackLoudness(LOUD).target === -14);

check('décochée, chaque piste retrouve la sienne',
    loudness.effectiveTarget(LOUD, noSync) === -14
    && loudness.effectiveTarget(QUIET, noSync) === null,
    'la piste sans cible reste sans cible');

check('la mesure n\'est jamais emportée par un changement de cible',
    database.getTrackLoudness(LOUD).measured === -8
    && database.getTrackLoudness(LOUD).peak === -0.5);

// Retirer la cible n'est pas la ramener sur la mesure : c'est dire qu'il n'y a
// plus rien à corriger. Les deux donnent un gain nul, un seul se laisse
// recouvrir sans trace par la synchronisation.
database.setTrackLoudnessTarget(LOUD, null);
check('une cible retirée disparaît de la base',
    database.getTrackLoudness(LOUD).target === undefined);

// ────────────────── Le gain dans le mixage ──────────────────

console.log('\nCe que le bus fait du gain\n');

const MixSource = require(path.join(ROOT, 'src/audio/mix/MixSource'));
const { BYTES_PER_FRAME } = require(path.join(ROOT, 'src/audio/mix/format'));

/** Source amorcée à la main : le décodeur ne sert à rien pour vérifier un gain. */
function fakeSource(options) {
    const source = new MixSource({ url: 'x', title: 'x' }, options);
    source._buffer = [Buffer.alloc(BYTES_PER_FRAME * 24)];
    source._available = BYTES_PER_FRAME * 24;
    return source;
}

const plain = fakeSource({ levelGain: 1 });
check('sans correction, la trame sort à gain un',
    (() => {
        const frame = plain.readFrame();
        return frame.startGain === 1 && frame.endGain === 1;
    })());

const boosted = fakeSource({ levelGain: 2 });
check('une correction s\'applique dès la première trame',
    (() => {
        const frame = boosted.readFrame();
        return frame.startGain === 2 && frame.endGain === 2;
    })(), 'le gain de départ est posé sans transition');

// Le chemin rapide du bus — octets transmis tels quels — reconnaît une trame à
// ses gains exactement égaux à un. Une correction doit donc l'écarter, sinon
// elle serait calculée puis ignorée.
check('une trame corrigée n\'emprunte pas le chemin rapide du bus',
    (() => {
        const frame = fakeSource({ levelGain: 1.5 }).readFrame();
        return !(frame.startGain === 1 && frame.endGain === 1);
    })());

const slewed = fakeSource({ levelGain: 1 });
slewed.setLevelGain(2);
const first = slewed.readFrame();
check('un changement en cours de lecture est étalé, jamais appliqué d\'un coup',
    first.startGain === 1 && first.endGain > 1 && first.endGain < 2,
    `${first.startGain} → ${first.endGain.toFixed(3)}`);

check('il finit par atteindre exactement la valeur demandée',
    (() => {
        for (let i = 0; i < 12; i++) slewed.readFrame();
        const frame = slewed.readFrame();
        return !!frame && frame.endGain === 2;
    })());

// Fondu et correction décrivent deux choses différentes : le premier dit où en
// est la transition, la seconde à quel niveau le morceau s'entend.
const fading = fakeSource({ levelGain: 2, gain: 1 });
fading.fade(0, 40);
const mid = fading.readFrame();
check('un fondu se multiplie à la correction au lieu de l\'effacer',
    mid.endGain < 2 && mid.endGain > 0,
    `gain de trame ${mid.endGain.toFixed(3)} sur une correction de 2`);

check('un fondu à zéro reste un silence, correction ou pas',
    (() => {
        const silent = fakeSource({ levelGain: 4, gain: 0 });
        return silent.readFrame().startGain === 0;
    })());

[plain, boosted, slewed, fading].forEach(s => s.stop());

// ────────────────── Le rapport de FFmpeg ──────────────────

console.log('\nCe qu\'on tire du rapport de FFmpeg\n');

const REPORT = [
    'Input #0, mp3, from \'x.mp3\':',
    '[Parsed_loudnorm_0 @ 0000021] ',
    '{',
    '\t"input_i" : "-13.86",',
    '\t"input_tp" : "-0.85",',
    '\t"input_lra" : "7.60",',
    '\t"input_thresh" : "-24.25"',
    '}',
].join('\n');

const parsed = parseLoudnorm(REPORT);
check('la sonie et le pic sont lus, arrondis au dixième',
    parsed && parsed.measured === -13.9 && parsed.peak === -0.8,
    JSON.stringify(parsed));

check('un rapport absent ne rend rien', parseLoudnorm('ffmpeg: no such file') === null);
check('un rapport tronqué ne rend rien', parseLoudnorm('{ "input_i" : ') === null);

// Un fichier muet, ou trop court pour remplir la fenêtre d'intégration, sort à
// la borne basse du filtre. La retenir ferait calculer un gain de cinquante
// décibels sur du silence.
check('la borne basse du filtre est écartée',
    parseLoudnorm('{ "input_i" : "-70.00", "input_tp" : "-120.0" }') === null);

// Un avertissement de décodage peut précéder le rapport : c'est le dernier bloc
// accolé qui fait foi, jamais le premier.
check('un bloc parasite avant le rapport n\'égare pas la lecture',
    (() => {
        const noisy = '[mp3 @ 0x1] Header missing {broken}\n'
            + '{ "input_i" : "-9.20", "input_tp" : "0.30" }';
        const value = parseLoudnorm(noisy);
        return value && value.measured === -9.2 && value.peak === 0.3;
    })());

// ────────────────── Les bornes, des deux côtés du réseau ──────────────────

console.log('\nCe que le curseur et le serveur doivent avoir en commun\n');

const menuSource = fs.readFileSync(
    path.join(ROOT, 'src/web/public/js/qualityMenu.js'), 'utf8');
const markup = fs.readFileSync(
    path.join(ROOT, 'src/web/public/index.html'), 'utf8');

const readConst = (name) => {
    const found = menuSource.match(new RegExp(`const ${name} = (-?[\\d.]+);`));
    return found ? parseFloat(found[1]) : NaN;
};

check('le menu contextuel borne comme le serveur',
    readConst('LUFS_MIN') === loudness.TARGET_MIN
    && readConst('LUFS_MAX') === loudness.TARGET_MAX
    && readConst('LUFS_STEP') === loudness.TARGET_STEP,
    `${readConst('LUFS_MIN')} … ${readConst('LUFS_MAX')} par ${readConst('LUFS_STEP')}`);

const syncSlider = markup.match(/id="lufs-sync-range"[^>]*>/);
check('le curseur de la boîte Mix borne comme le serveur',
    !!syncSlider
    && syncSlider[0].includes(`min="${loudness.TARGET_MIN}"`)
    && syncSlider[0].includes(`max="${loudness.TARGET_MAX}"`)
    && syncSlider[0].includes(`step="${loudness.TARGET_STEP}"`),
    syncSlider ? syncSlider[0] : 'curseur introuvable');

check('sa position de départ est la référence de diffusion',
    !!syncSlider && syncSlider[0].includes(`value="${loudness.DEFAULT_SYNC_TARGET}"`));

// ────────────────── Le même panneau, ouvert d'ailleurs ──────────────────

/*
 * Les deux nombres de la carte « Volume et diffusion » ouvrent ce réglage.
 *
 * Ils ne faisaient que constater la sonie du morceau : pour la corriger, il
 * fallait retrouver la piste dans la file ou l'historique et l'ouvrir au clic
 * droit — un détour pour régler ce qu'on est justement en train d'écouter.
 *
 * Ce qui compte ici n'est pas qu'un panneau s'ouvre, c'est que ce soit *le*
 * panneau : une copie divergerait au premier changement, et l'utilisateur
 * verrait deux réglages de la même chose ne pas dire la même valeur.
 */
console.log('\nCe que la carte du volume ouvre\n');

check('le panneau autonome est bâti par la fonction du menu contextuel',
    /loosePanel = buildLoudnessPanel\(track\)/.test(menuSource)
    && (menuSource.match(/function buildLoudnessPanel\(/g) || []).length === 1,
    'deux vues du même réglage qui divergeraient seraient pires qu\'une seule');

check('  … et ne cohabite pas avec le menu contextuel',
    /window\.MusicPlayer\.hideTrackQualityMenu\(\);/
        .test(menuSource.slice(menuSource.indexOf('openLoudnessPanel = function'),
            menuSource.indexOf('loosePanel = buildLoudnessPanel'))),
    'deux panneaux ouverts, dont un seul recevrait les mises à jour');

check('rouvrir sur la même piste referme',
    /if \(loosePanel && looseUrl === track\.url\) \{\s*window\.MusicPlayer\.closeLoudnessPanel\(\);/
        .test(menuSource),
    'c\'est ce qu\'on attend d\'un bouton qui a ouvert quelque chose');

check('une piste sans adresse n\'ouvre rien',
    /if \(!track \|\| !track\.url\) return false;/.test(menuSource),
    'le panneau se construit autour de l\'adresse : sans elle, un curseur sans destinataire');

check('l\'état ne recale que le panneau qui parle de la piste reçue',
    /if \(!track \|\| track\.url !== looseUrl\) return;/.test(menuSource),
    'sinon un changement de morceau réécrirait le panneau ouvert sur l\'ancien');

check('les mêmes gestes le referment que le menu',
    /document\.addEventListener\('click', closeFloating\)/.test(menuSource)
    && /window\.addEventListener\('resize', closeFloating\)/.test(menuSource)
    && /if \(e\.key === 'Escape'\) closeFloating\(\)/.test(menuSource),
    'il flotte au-dessus de la page comme lui, et n\'appartient à aucune carte');

check('  … mais la molette sur son curseur ne l\'emporte pas',
    /if \(loosePanel && loosePanel\.contains\(e\.target\)\) return;/.test(menuSource),
    'le curseur de sonie se règle aussi à la molette');

/*
 * Le placement, sur les seules dimensions en jeu.
 *
 * `panelSpot` est détachée du DOM exprès : c'est la seule partie qui décide
 * quelque chose, et une décision qu'on ne peut atteindre qu'en montant une
 * fenêtre entière finit par n'être vérifiée nulle part.
 */
const panelSpot = (() => {
    const vm = require('vm');
    const start = menuSource.indexOf('function panelSpot(');
    if (start < 0) throw new Error('panelSpot introuvable');
    const end = menuSource.indexOf('\n}\n', start) + 3;

    const sandbox = { console };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(`${menuSource.slice(start, end)}\nglobalThis.__f = panelSpot;`, sandbox);
    return sandbox.__f;
})();

const PANNEAU = { width: 258, height: 144 };
const ECRAN = { width: 1280, height: 800 };

{
    // Le cas ordinaire : sous le nombre cliqué, aligné à son bord gauche.
    const spot = panelSpot(PANNEAU, { left: 300, top: 50, bottom: 68 }, ECRAN);
    check('le panneau se pose sous son ancre', spot.top === 74, `top=${spot.top}`);
    check('  … aligné sur son bord gauche', spot.left === 300, `left=${spot.left}`);
}

{
    /*
     * Sous, et non à côté — contrairement au sous-menu du clic droit.
     *
     * L'ancre est ici un petit nombre au milieu d'une ligne de réglage. Se
     * poser à sa droite recouvrirait le reste de la ligne, dont l'autre
     * nombre, qu'on veut garder sous les yeux pendant qu'on règle.
     */
    const spot = panelSpot(PANNEAU, { left: 300, top: 50, bottom: 68 }, ECRAN);
    check('il ne se pose pas à côté de l\'ancre', spot.left <= 300,
        'la ligne porte deux nombres, et l\'autre doit rester lisible');
}

{
    // Un nombre près du bord droit : le panneau rentre, il ne déborde pas.
    const spot = panelSpot(PANNEAU, { left: 1200, top: 50, bottom: 68 }, ECRAN);
    check('près du bord droit, il rentre dans la fenêtre',
        spot.left + PANNEAU.width <= ECRAN.width - 8, `left=${spot.left}`);
}

{
    // Pas la place en dessous : au-dessus, plutôt que collé au bord où il
    // recouvrirait ce qu'on vient de cliquer.
    const spot = panelSpot(PANNEAU, { left: 300, top: 700, bottom: 718 }, ECRAN);
    check('sans place en dessous, il bascule au-dessus',
        spot.top === 700 - PANNEAU.height - 6, `top=${spot.top}`);
    check('  … sans recouvrir l\'ancre', spot.top + PANNEAU.height < 700);
}

{
    // Une fenêtre plus petite que le panneau : il reste dans le cadre plutôt
    // que de partir en négatif, hors de portée du curseur.
    const spot = panelSpot(PANNEAU, { left: 4, top: 30, bottom: 48 },
        { width: 200, height: 160 });
    check('dans une fenêtre trop petite, il ne sort pas par le haut',
        spot.top >= 8, `top=${spot.top}`);
    check('  … ni par la gauche', spot.left >= 8, `left=${spot.left}`);
}

// ────────────────── Les traductions ──────────────────

console.log('\nCe que les quatre langues doivent dire\n');

const LOCALES = path.join(ROOT, 'src/web/public/locales');
const KEYS = [
    'lufs_sync_label', 'lufs_sync_sub',
    'loudness_menu_label', 'loudness_measured', 'loudness_reset_hint',
    'loudness_analyzing', 'loudness_failed', 'loudness_unavailable',
    'loudness_synced_note', 'loudness_analyzing_short', 'loudness_unmeasured_short',
    'loudness_quality_intact', 'loudness_quality_slight',
    'loudness_quality_marked', 'loudness_quality_severe',
];

for (const lang of ['fr', 'en', 'es', 'de']) {
    const dictionary = JSON.parse(fs.readFileSync(path.join(LOCALES, `${lang}.json`), 'utf8'));
    const missing = KEYS.filter(k => !dictionary[k]);
    check(`${lang} : les ${KEYS.length} libellés du réglage sont traduits`,
        missing.length === 0,
        missing.length ? `manquants : ${missing.join(', ')}` : '');
}

// ────────────────── Fin ──────────────────

database.flush();
try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) {}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
