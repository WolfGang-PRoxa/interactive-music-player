/**
 * Vérifie l'armement des curseurs des réglages — la molette ne règle qu'un
 * curseur qui a le focus.
 *
 * Elle le réglait dès qu'elle passait dessus. Le panneau des réglages est long :
 * descendre vers une section modifiait au passage tout ce qui se trouvait sous
 * le pointeur, sans que rien ne l'annonce. Trois choses tiennent la réparation,
 * et aucune ne se lit dans un diff.
 *
 *  - **Le focus arme, et rien d'autre.** Sans le contrôle, le
 *    `preventDefault()` reprend la molette au panneau, qui ne défile plus dès
 *    que le pointeur touche une piste. C'est l'ordre des deux lignes qui compte,
 *    et il ne se voit pas à l'exécution : un panneau qui ne défile pas ressemble
 *    à un panneau qui n'a rien à montrer.
 *
 *  - **L'état armé doit se voir.** `.scroll-range` porte `outline: none` : sans
 *    règle de focus, le curseur armé est indiscernable des vingt autres, et la
 *    molette paraît en panne. Les flèches du clavier, elles, sont natives et
 *    n'ont jamais demandé une ligne de code — c'est de savoir lequel des
 *    vingt-et-un curseurs les recevra qui manquait.
 *
 *  - **L'arithmétique d'un cran.** Un pas de 0,2 ajouté en virgule flottante
 *    donne « 1.3000000000000003 », que l'attribut `value` retient tel quel et
 *    que la pastille affiche. Le formatage n'est donc pas cosmétique.
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MARKUP = fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'css', 'modals.css'), 'utf8');
const SETTINGS = fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'js', 'settingsModal.js'), 'utf8');
const ARM = fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'js', 'rangeArm.js'), 'utf8');

/** Langues du tableau de bord, dans l'ordre du sélecteur des réglages. */
const LANGS = ['fr', 'en', 'es', 'de'];

let failed = 0;
let passed = 0;
const check = (label, ok, detail = '') => {
  if (ok) {
    passed++;
    console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

console.log("\n=== L'armement des curseurs des réglages ===\n");

/* ══════════════════ Un cran de molette ══════════════════ */

console.log("L'arithmétique d'un cran\n");

/**
 * Extrait `wheelValue` de settingsModal.js et l'exécute seule.
 *
 * Le module entier suppose un DOM, une socket et des réglages ; cette
 * fonction-ci ne fait que calculer un nombre. La découper est le seul moyen de
 * l'éprouver sur le fichier réel — même procédé que tests/preloadInfinity.js
 * pour `preloadPosition`.
 */
const start = SETTINGS.indexOf('function wheelValue(');
const end = SETTINGS.indexOf('\n        const rangeInputs', start);
if (start < 0 || end < 0) {
  console.log('  FAIL wheelValue introuvable dans settingsModal.js');
  process.exit(1);
}

const sandbox = { console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(SETTINGS.slice(start, end), sandbox);
const wheelValue = sandbox.wheelValue;

/** Un curseur réduit à ce que la fonction lui demande. */
const slider = (value, extra = {}) => ({ min: '1', max: '15', step: '0.5', value: String(value), ...extra });
const up = { deltaY: -1, deltaX: 0 };
const down = { deltaY: 1, deltaX: 0 };

check('un cran vers le haut ajoute un pas', wheelValue(slider(5), up) === '5.5', wheelValue(slider(5), up));
check('un cran vers le bas retire un pas', wheelValue(slider(5), down) === '4.5', wheelValue(slider(5), down));

// Pavé tactile et souris à molette inclinable : le geste horizontal compte dans
// le même sens que le vertical.
check(
  'un cran horizontal compte comme un cran vers le haut',
  wheelValue(slider(5), { deltaY: 0, deltaX: 1 }) === '5.5',
);
check("  … et dans l'autre sens comme un cran vers le bas", wheelValue(slider(5), { deltaY: 0, deltaX: -1 }) === '4.5');

check("la course s'arrête au maximum", wheelValue(slider(15), up) === '15', wheelValue(slider(15), up));
check('  … et au minimum', wheelValue(slider(1), down) === '1', wheelValue(slider(1), down));

// Un pas de 0,2 ajouté en virgule flottante donne 1.3000000000000003.
check(
  'la poussière de la virgule flottante ne remonte pas dans la valeur',
  wheelValue(slider(1.1, { min: '0', max: '5', step: '0.2' }), up) === '1.3',
  wheelValue(slider(1.1, { min: '0', max: '5', step: '0.2' }), up),
);

check("les zéros de queue s'en vont", wheelValue(slider(5.5), up) === '6', wheelValue(slider(5.5), up));

check(
  'un curseur sans pas déclaré avance de un',
  wheelValue(slider(30, { min: '0', max: '300', step: '' }), up) === '31',
  wheelValue(slider(30, { min: '0', max: '300', step: '' }), up),
);

/* ══════════════════ L'armement ══════════════════ */

console.log('\nCe qui arme la molette\n');

/*
 * Les deux gestes vivent dans js/rangeArm.js, et ensemble : ils doivent
 * s'accorder sur ce qu'est la zone. Écrits séparément, l'un pourrait armer
 * depuis un endroit que l'autre ignore, et le curseur se retrouverait armé sans
 * répondre.
 */
const clickFrom = ARM.indexOf("zone.addEventListener('mousedown'");
const wheelFrom = ARM.indexOf("zone.addEventListener('wheel'");
check(
  'les deux gestes sont posés sur la zone, pas sur la piste',
  clickFrom > 0 && wheelFrom > 0,
  clickFrom < 0 ? "le clic n'est pas sur la zone" : wheelFrom < 0 ? 'la molette non plus' : '',
);

// La zone est le parent : les conteneurs ne portent pas le même nom d'un endroit
// à l'autre, et une liste de classes serait à tenir à jour.
check(
  'la zone est la boîte qui contient le curseur',
  /function zoneOf\(range\) \{[\s\S]*?range\.parentElement/.test(ARM),
);

const wheelHandler = (() => {
  const to = ARM.indexOf('{ passive: false }', wheelFrom);
  return wheelFrom < 0 || to < 0 ? '' : ARM.slice(wheelFrom, to);
})();

/*
 * L'ordre compte : le contrôle du focus doit précéder le `preventDefault()`.
 * Inversé, le panneau perdrait son défilement dès que le pointeur entre dans la
 * zone, ce qui était la moitié du défaut d'origine.
 */
const focusGuard = wheelHandler.indexOf('document.activeElement !== range');
const prevented = wheelHandler.indexOf('preventDefault()');
check(
  'le focus est exigé avant toute chose',
  focusGuard > 0 && prevented > focusGuard,
  focusGuard > 0 ? 'le contrôle précède le preventDefault' : 'contrôle absent',
);
check(
  '  … et la molette est rendue au panneau quand il manque',
  /if \(document\.activeElement !== range\) return;/.test(wheelHandler),
);

/*
 * L'écouteur ne peut pas être passif : il refuse la molette dans un cas et la
 * laisse dans l'autre, ce qu'un écouteur passif n'a pas le droit de faire.
 */
check("l'écouteur de molette reste non passif", /'wheel'[\s\S]*?\{ passive: false \}/.test(ARM));

/*
 * Le module ne décide que du *quand* : appliquer un cran n'est pas son affaire.
 * Chaque curseur le fait à sa façon — l'un émet un « input », un autre écrit dans
 * le localStorage —, et ces différences n'ont pas à remonter là-haut.
 */
check("l'application d'un cran est laissée à l'appelant", /applyNotch\(e\);/.test(wheelHandler));

/*
 * Côté réglages, ce cran emprunte le chemin des flèches plutôt que de repeindre
 * lui-même : les deux ne peuvent alors pas afficher des états différents.
 */
check(
  "un cran de molette passe par l'événement « input », comme les flèches",
  /armRange\(range, \(e\) => \{[\s\S]*?range\.dispatchEvent\(new Event\('input', \{ bubbles: true \}\)\)/.test(
    SETTINGS,
  ),
);

/* ══════════════════ Les curseurs du reste de la page ══════════════════ */

console.log('\nLes quatre curseurs hors du panneau\n');

/*
 * Quatre curseurs portent `.scroll-range` sans vivre dans le panneau des
 * réglages : les deux opacités — journal et vidéo — et les deux du tiroir
 * d'activité. Ils reçoivent l'anneau de focus de css/modals.css, qui vaut pour
 * la classe : sans le même armement, cet anneau mentirait chez eux, en
 * annonçant une commande qui répondrait déjà sans lui.
 */
const OUTSIDE = [
  ['js/logs.js', 'opacitySlider', 'setting-logs-opacity'],
  ['js/video.js', 'videoOpacitySlider', 'setting-video-opacity'],
  ['js/drawer.js', 'blurRange', 'drawer-blur-range'],
  ['js/drawer.js', 'durationRange', 'graph-duration-range'],
];

for (const [file, variable, id] of OUTSIDE) {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', ...file.split('/')), 'utf8');

  // Le curseur doit être celui qu'on croit : l'appel nomme une variable, et
  // c'est l'identifiant du balisage qui dit de quel curseur il s'agit.
  check(
    `${file} : « ${id} » passe par les deux gestes de la zone`,
    source.includes(`getElementById('${id}')`) && source.includes(`armRange(${variable}, (e) => {`),
    !source.includes(`getElementById('${id}')`) ? 'identifiant absent' : '',
  );

  /*
   * Et plus par un écouteur de son cru : deux molettes sur la même zone
   * appliqueraient deux crans pour un, et celle-ci n'aurait pas la garde du
   * focus.
   */
  check(`  … et n'a plus d'écouteur de molette à lui`, !source.includes(`${variable}.addEventListener('wheel'`));
}

/*
 * Le module de l'armement doit être chargé avant ceux qui l'appellent : ils
 * l'invoquent à leur mise en place, et un appel manquant ne casse rien de
 * visible — le curseur retomberait simplement sur le geste natif, qui règle en
 * armant.
 */
const scriptOrder = (file) => MARKUP.indexOf(`src="js/${file}"`);
check(
  "la page charge le module d'armement avant le panneau des réglages",
  scriptOrder('rangeArm.js') > 0 && scriptOrder('rangeArm.js') < scriptOrder('settingsModal.js'),
);
check(
  '  … et avant le tiroir, le journal et la vidéo',
  scriptOrder('rangeArm.js') < scriptOrder('drawer.js') &&
    scriptOrder('rangeArm.js') < scriptOrder('logs.js') &&
    scriptOrder('rangeArm.js') < scriptOrder('video.js'),
);

// Le compte, pour que l'ajout d'un curseur ne passe pas inaperçu : dix-sept dans
// le panneau, quatre au-dehors.
const inMarkup = (MARKUP.match(/class="scroll-range/g) || []).length;
check('la page compte les vingt-et-un curseurs attendus', inMarkup === 21, `${inMarkup} curseurs`);

/* ══════════════════ L'état armé, à l'écran ══════════════════ */

console.log("\nCe qui rend l'armement visible\n");

const rule = (selector) => {
  const at = CSS.indexOf(selector);
  if (at < 0) return null;
  const open = CSS.indexOf('{', at);
  const close = CSS.indexOf('}', open);
  return open < 0 || close < 0 ? null : CSS.slice(open + 1, close);
};

// C'est ce qui rend les deux contrôles suivants nécessaires : sans eux, le
// curseur armé n'aurait aucune marque.
check(
  "les curseurs n'ont pas de contour de focus du navigateur",
  /\.scroll-range,\s*\ninput\[type="range"\] \{[^}]*outline: none;/.test(CSS),
);

const webkitFocus = rule('.scroll-range:focus::-webkit-slider-thumb');
const mozFocus = rule('.scroll-range:focus::-moz-range-thumb');
check(
  'la pastille prend un halo sous focus, dans les deux moteurs',
  Boolean(webkitFocus) &&
    Boolean(mozFocus) &&
    /box-shadow:[\s\S]*var\(--c-primary\)/.test(webkitFocus) &&
    /box-shadow:[\s\S]*var\(--c-primary\)/.test(mozFocus),
);

/*
 * Le cadre suit le focus du curseur, et non celui de la ligne : celle-ci porte
 * aussi le bouton de remise par défaut, dont le focus n'arme rien.
 */
const frame = rule('.scroll-input-wrapper:has(.scroll-range:focus)');
check(
  "le cadre de la ligne s'éclaire, et suit le curseur seul",
  Boolean(frame) && /border-color/.test(frame) && !CSS.includes('.scroll-input-wrapper:focus-within'),
  frame ? frame.trim() : 'règle absente',
);

// La règle en `:has()` suppose cette imbrication ; le balisage doit la porter.
check(
  'le curseur est bien un enfant de la ligne',
  /<div class="scroll-input-wrapper">\s*\n\s*<input type="range"/.test(MARKUP),
);

/* ══════════════════ L'indication ══════════════════ */

console.log("\nCe qui l'annonce\n");

check(
  "l'infobulle est posée sur chaque curseur",
  /range\.dataset\.tooltip = window\.MusicPlayer\.t\('settings_range_hint'\)/.test(SETTINGS),
);

// Sans la clé portée par l'élément, `applyLanguage()` n'a aucun moyen de
// retrouver cette infobulle : elle resterait dans la langue précédente.
check(
  '  … avec sa clé, pour que le changement de langue la retrouve',
  /range\.setAttribute\('data-i18n-tooltip', 'settings_range_hint'\)/.test(SETTINGS),
);

for (const lang of LANGS) {
  const dict = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'locales', `${lang}.json`), 'utf8'));
  const text = dict.settings_range_hint;
  check(`${lang} : l'indication est traduite`, typeof text === 'string' && text.length > 0, text || '(absente)');
}

/* ══════════════════ La molette, pour de vrai ══════════════════ */

/*
 * Les contrôles ci-dessus lisent le fichier ; celui-ci le fait tourner. C'est le
 * seul qui constate ce que la molette produit — la garde du focus est un `if`
 * qu'un remaniement peut laisser tomber sans que rien d'autre s'en aperçoive.
 *
 * `jsdom` n'est pas une dépendance déclarée du projet : il arrive avec
 * `discord-player-youtubei`. La section se retire donc d'elle-même s'il n'est pas
 * là, plutôt que de faire échouer une suite pour un outil qui n'a jamais été
 * demandé.
 */
console.log('\nUn cran de molette, dans un DOM simulé\n');

let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch (e) {
  JSDOM = null;
  console.log('  passé — jsdom absent de cette installation');
}

if (JSDOM) {
  // Une origine réelle, et non `about:blank` : le module lit le localStorage à
  // l'ouverture, que jsdom refuse aux origines opaques.
  const dom = new JSDOM(MARKUP, { runScripts: 'outside-only', url: 'http://localhost:3000/' });
  const win = dom.window;
  const dict = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'locales', 'fr.json'), 'utf8'));

  /** Le strict nécessaire pour que le module s'initialise et enregistre. */
  win.MusicPlayer = {
    t: (key) => dict[key] || key,
    dashboardSettings: {},
    socket: { readyState: 1, send() {} },
    saveDashboardSettings() {},
    showToast() {},
    sendWS() {},
  };
  win.WebSocket = { OPEN: 1 };

  // Les deux modules, dans l'ordre de la page : le panneau appelle
  // `armRange`, qui doit donc être en place avant lui.
  for (const file of ['rangeArm.js', 'settingsModal.js']) {
    const source = fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'js', file), 'utf8');
    vm.runInContext(source, dom.getInternalVMContext(), { filename: file });
  }
  win.MusicPlayer.initSettingsModal();

  const range = win.document.getElementById('setting-fadeout-duration');
  const badge = win.document.getElementById('val-fadeout-duration');

  /**
   * Un cran de molette, et ce que le navigateur en a fait.
   *
   * L'événement part par défaut de la piste, comme sous un pointeur posé
   * dessus ; `on` permet de le faire partir d'ailleurs dans la zone, ce qui est
   * le cas que la piste seule ne couvrait pas.
   */
  const notch = (deltaY, on) => {
    const event = new win.WheelEvent('wheel', { deltaY, deltaX: 0, bubbles: true, cancelable: true });
    (on || range).dispatchEvent(event);
    return event.defaultPrevented;
  };

  check(
    "l'infobulle est posée à l'ouverture des réglages",
    range.dataset.tooltip === dict.settings_range_hint,
    range.dataset.tooltip,
  );

  /* ── Le clic qui arme ── */

  /*
   * Ce que jsdom peut dire, et ce qu'il ne peut pas.
   *
   * Il ne met rien en page : l'appui sur une piste n'y déplace aucune pastille,
   * et constater que la valeur n'a pas bougé ne prouverait donc rien. Ce qui se
   * vérifie ici est le mécanisme même qui retient le navigateur — l'action par
   * défaut refusée —, et le focus donné à la main pour la remplacer.
   */
  const zone = range.parentElement;
  const press = (target) => {
    const event = new win.MouseEvent('mousedown', { bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };

  range.blur();
  const firstOnBar = press(range);
  check('le premier clic sur la piste ne la laisse pas se régler', firstOnBar === true, 'action par défaut refusée');
  check('  … et arme le curseur', win.document.activeElement === range);

  // Une fois armé, le clic reprend son office natif — sans quoi il n'y aurait
  // aucun moyen de viser une valeur à la souris.
  check('le second clic rend la main au navigateur', press(range) === false);

  // Toute la ligne arme : viser une piste de six pixels de haut pour cela
  // serait un travail d'horloger.
  range.blur();
  const fromZone = press(zone);
  check('un clic ailleurs dans la ligne arme aussi', fromZone === true && win.document.activeElement === range);

  // La remise à la valeur par défaut est une commande à part entière.
  range.blur();
  const resetBtn = zone.querySelector('.btn-default-reset');
  const onReset = press(resetBtn);
  check(
    'un clic sur la remise par défaut garde son geste',
    Boolean(resetBtn) && onReset === false && win.document.activeElement !== range,
  );

  const before = range.value;
  const preventedIdle = notch(-100);
  check('sans focus, la valeur ne bouge pas', range.value === before, `${before} → ${range.value}`);
  // La moitié du défaut d'origine : le panneau ne défilait plus du tout.
  check('  … et la molette est laissée au panneau', preventedIdle === false);

  range.focus();
  check('un curseur peut prendre le focus', win.document.activeElement === range);

  const preventedArmed = notch(-100);
  check('armé, un cran vers le haut ajoute un pas', range.value === '5.5', `${before} → ${range.value}`);
  check('  … et la molette est prise au panneau', preventedArmed === true);

  notch(100);
  notch(100);
  check('deux crans vers le bas retirent deux pas', range.value === '4.5', range.value);

  // La preuve que la molette emprunte le chemin des flèches : la pastille est
  // peinte par l'écouteur d'« input », que rien d'autre n'a appelé.
  check(
    "la pastille a suivi, par le chemin de l'événement « input »",
    badge && badge.textContent === '4.5s',
    badge ? badge.textContent : '(absente)',
  );

  /* ── La molette depuis toute la zone ── */

  /*
   * Le cas que la piste seule ne couvrait pas. Six pixels de haut : le pointeur
   * se trouve le plus souvent à côté, sur la marge du cadre ou sur la pastille
   * de valeur, et le geste doit répondre là aussi.
   */
  // `badge` est la pastille de valeur de cette ligne, déjà retrouvée plus haut.
  const fromBadge = range.value;
  const preventedOnBadge = notch(-100, badge);
  check(
    'armé, un cran depuis la pastille de valeur règle aussi',
    badge.classList.contains('scroll-val') && range.value === '5' && preventedOnBadge === true,
    `${fromBadge} → ${range.value}`,
  );

  notch(-100, zone);
  check('  … et depuis la marge du cadre', range.value === '5.5', range.value);

  range.blur();
  const idle = range.value;
  notch(-100, badge);
  check('sans focus, la zone laisse passer la molette', range.value === idle, `${idle} → ${range.value}`);

  range.focus();
  const armed = range.value;
  range.blur();
  notch(-100);
  check('le focus perdu, la molette redevient inerte', range.value === armed, `${armed} → ${range.value}`);
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
