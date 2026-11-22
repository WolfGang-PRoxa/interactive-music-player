/**
 * Vérifie le cran « tout » des curseurs de préchargement.
 *
 * Les trois curseurs — file d'attente, historique, playlists — comptaient de
 * zéro à cinq pistes. Ils gagnent un dernier cran qui ne compte plus : il prend
 * toute la section. Quatre choses portent ce cran, et aucune ne se voit dans un
 * diff.
 *
 *  - **« Tout » s'enregistre comme `-1`, jamais comme la position du curseur.**
 *    Celle-ci ne vaut que par rapport au maximum du jour : le jour où les
 *    curseurs gagneraient un cran, un « 6 » enregistré cesserait de vouloir dire
 *    « tout » sans que rien ne le signale. Un compte négatif, lui, n'en est un
 *    dans aucun monde.
 *
 *  - **Il se relit comme `Infinity`**, et non comme un très grand nombre. Les
 *    usages en aval sont des `slice(0, limite)` et un `Math.min(limite, …)`,
 *    qui le traitent déjà correctement — c'est ce qui permet de ne rien changer
 *    ailleurs, et c'est exactement ce qu'il faut éprouver.
 *
 *  - **La piste reste nue, et sa fin se dégrade.** Un glyphe y avait d'abord été
 *    posé, à l'endroit exact où la pastille se range au maximum ; il s'y
 *    retrouvait dessous, où il encombrait plus qu'il n'annonçait. Le dernier
 *    sixième de la course — six intervalles entre sept crans — prend donc la
 *    teinte du lecteur, et le symbole s'écrit dans la pastille de valeur, là où
 *    l'œil va déjà lire le nombre.
 *
 *  - **Le préchargement se plafonne.** Sans cela, « tout » sur une bibliothèque
 *    de deux cents titres lancerait deux cents ffmpeg d'un coup. Le reliquat
 *    n'est pas perdu pour autant : il repart quand une place se libère — mais
 *    seulement après un succès, sous peine de boucler sur une source qui refuse.
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MARKUP = fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'css', 'modals.css'), 'utf8');
const SETTINGS = fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'js', 'settingsModal.js'), 'utf8');
const PRELOAD = fs.readFileSync(path.join(ROOT, 'src', 'audio', 'PreloadManager.js'), 'utf8');

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

console.log('\n=== Le cran « tout » du préchargement ===\n');

/* ══════════════════ Les trois curseurs ══════════════════ */

console.log('Les curseurs et leur dernier cran\n');

const SLIDERS = ['preload-queue-count', 'preload-history-count', 'preload-playlist-count'];

for (const id of SLIDERS) {
  const tag = new RegExp(`<input\\s+type="range"\\s+id="${id}"([^>]*)>`).exec(MARKUP);
  check(
    `« ${id} » va jusqu'au cran de l'infini`,
    Boolean(tag) && /max="6"/.test(tag[1]) && /min="0"/.test(tag[1]),
    tag ? (/max="(\d+)"/.exec(tag[1]) || [])[0] : 'curseur introuvable',
  );
}

check(
  'chacun se signale à la feuille de style',
  (MARKUP.match(/class="scroll-range has-infinity-end"/g) || []).length === 3,
);

/*
 * Rien n'est dessiné sur la piste elle-même. Un glyphe y avait d'abord été posé,
 * à l'endroit exact où la pastille se range au maximum ; il s'y retrouvait
 * dessous, où il encombrait plus qu'il n'annonçait.
 */
check(
  'la piste ne porte aucun glyphe',
  !MARKUP.includes('range-infinity') && !MARKUP.includes('range-with-infinity'),
  'il finissait caché sous la pastille du curseur',
);

/*
 * Les curseurs comptent six intervalles entre leurs sept crans : le dernier
 * occupe donc le dernier sixième de la course, soit 83,33 %. Un dégradé qui
 * partirait d'ailleurs désignerait un cran qui n'est pas là.
 */
const trackRule = /\.scroll-range\.has-infinity-end \{([^}]*)\}/.exec(CSS);
check('la fin de la piste porte un dégradé', Boolean(trackRule) && /linear-gradient\(\s*to right/.test(trackRule[1]));
check(
  '  … qui démarre au dernier cran',
  Boolean(trackRule) && /83\.33%/.test(trackRule[1]),
  'six intervalles entre sept crans : le dernier sixième',
);
check(
  "  … et s'affirme une fois le cran atteint",
  /\.scroll-range\.has-infinity-end\.is-infinite \{[^}]*var\(--c-primary\)/.test(CSS),
);
/*
 * Le rail suivait le thème par une surcharge de jour ; il suit désormais le
 * curseur jour/nuit, dont les deux pôles sont ces mêmes valeurs — voir
 * css/base.css et tests/themeBlend.js.
 */
check(
  '  … et le rail se fond avec le reste du tableau de bord',
  Boolean(trackRule) && /var\(--blend-pct\)/.test(trackRule[1]),
  'le gris de la piste va du sombre au clair comme les autres surfaces',
);

/*
 * Le symbole est un tracé, plus un caractère : le « ∞ » de la police, bas et
 * sans hampe, se perdait dans une rangée de chiffres et dépendait de la police.
 */
check(
  'le symbole est dessiné, pas écrit',
  /const INFINITY_PATH =\s*'M20\.288 9\.463/.test(SETTINGS) &&
    /createElementNS\(ns, 'svg'\)/.test(SETTINGS) &&
    !/'∞'/.test(SETTINGS),
  "le tracé fourni, construit dans l'espace de noms SVG",
);
check(
  '  … dans la teinte de la pastille',
  /setAttribute\('fill', 'currentColor'\)/.test(SETTINGS),
  'il suit le thème et le mode jour/nuit',
);
check('  … avec un nom pour qui ne le voit pas', /setAttribute\(\s*'aria-label'/.test(SETTINGS));

const iconRule = /\.scroll-val-infinity \{([^}]*)\}/.exec(CSS);
const badgeRule = /\.scroll-val\.is-infinity \{([^}]*)\}/.exec(CSS);
check(
  '  … à la hauteur des chiffres voisins',
  Boolean(iconRule) && /width: 1\.7em/.test(iconRule[1]),
  "le tracé n'occupe qu'une bande de sa boîte carrée",
);
check(
  '  … sans faire grandir la rangée',
  Boolean(badgeRule) &&
    /line-height: 1;/.test(badgeRule[1]) &&
    Boolean(iconRule) &&
    /margin: -0\.45em/.test(iconRule[1]),
  'la boîte, plus haute que la ligne, déborde en marges négatives',
);

/*
 * Un seul peintre pour la pastille, partout où elle est écrite : ouverture,
 * glissement, remise d'un curseur, remise générale, et le réglage d'un coup que
 * demande le mode aléatoire (`setPreloadAll`, voir tests/shuffleMode.js). La
 * remise générale écrivait le nombre à la main, et un curseur ramené de l'infini
 * à trois gardait sa piste teintée.
 */
check(
  "la pastille n'a qu'un peintre",
  (SETTINGS.match(/paintRangeValue\(/g) || []).length === 6,
  `${(SETTINGS.match(/paintRangeValue\(/g) || []).length} occurrence(s), définition comprise`,
);
check(
  '  … que la remise générale emprunte aussi',
  /const setRange = [\s\S]{0,500}paintRangeValue\(valSpan, el, unit\);\s*paintInfinity\(el\);/.test(SETTINGS),
);

/* ══════════════════ La conversion, dans les deux sens ══════════════════ */

console.log('\nDe la position au réglage, et retour\n');

/**
 * Extrait une fonction de settingsModal.js et l'exécute seule.
 *
 * Le module entier suppose un DOM, une socket et des réglages ; ces deux
 * fonctions-ci ne font que convertir un nombre. Les découper est le seul moyen
 * de les éprouver sur le fichier réel.
 */
function extract(signature, endMarker) {
  const start = SETTINGS.indexOf(signature);
  if (start < 0) throw new Error(`${signature} introuvable`);
  const end = SETTINGS.indexOf(endMarker, start);
  if (end < 0) throw new Error(`fin de ${signature} introuvable`);
  return SETTINGS.slice(start, end);
}

const sandbox = { console, PRELOAD_ALL: -1 };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(extract('function preloadPosition(', 'const rangeInputs'), sandbox);

const range = { max: '6' };

check(
  'un réglage ordinaire se retrouve tel quel',
  sandbox.preloadPosition(0, range) === 0 &&
    sandbox.preloadPosition(3, range) === 3 &&
    sandbox.preloadPosition(5, range) === 5,
);
check(
  '« tout » se pose sur le dernier cran',
  sandbox.preloadPosition(-1, range) === 6,
  String(sandbox.preloadPosition(-1, range)),
);
check(
  'un réglage absent retombe sur le défaut',
  sandbox.preloadPosition(undefined, range) === 3 && sandbox.preloadPosition(null, range) === 3,
);
check(
  "un réglage aberrant ne dépasse pas l'avant-dernier cran",
  sandbox.preloadPosition(99, range) === 5,
  'le dernier cran est réservé à « tout »',
);
check('  … et une valeur illisible retombe sur le défaut', sandbox.preloadPosition('beaucoup', range) === 3);

/*
 * Le sens inverse vit dans `updateSettingsFromUI`, trop lié au DOM pour être
 * découpé. Sa règle est vérifiée sur le texte : le dernier cran doit s'écrire
 * `PRELOAD_ALL`, et rien d'autre.
 */
check(
  "la position maximale s'enregistre comme « tout »",
  /return pos >= max \? PRELOAD_ALL : Math\.min\(max - 1, Math\.max\(0, pos\)\);/.test(SETTINGS),
);
check(
  '  … et « tout » vaut un nombre négatif',
  /const PRELOAD_ALL = -1;/.test(SETTINGS),
  'aucun compte de pistes ne peut le prendre pour lui',
);

/* ══════════════════ La limite, côté serveur ══════════════════ */

console.log('\nCe que le serveur en fait\n');

const limitSandbox = { console, Number, Math, parseInt };
limitSandbox.globalThis = limitSandbox;
vm.createContext(limitSandbox);
{
  const start = PRELOAD.indexOf('function preloadLimit(');
  const end = PRELOAD.indexOf('\n}', start) + 2;
  vm.runInContext(PRELOAD.slice(start, end), limitSandbox);
}
const limit = limitSandbox.preloadLimit;

check("un compte ordinaire reste ce qu'il est", limit(0) === 0 && limit(3) === 3 && limit(5) === 5);
check("« tout » devient l'infini", limit(-1) === Infinity);
check(
  '  … et non un très grand nombre',
  !Number.isFinite(limit(-1)),
  "les usages en aval savent déjà traiter l'infini",
);
check('un compte hors bornes reste plafonné à cinq', limit(42) === 5);
check(
  'une valeur absente ou illisible retombe sur le défaut',
  limit(undefined) === 3 && limit(null) === 3 && limit('trois') === 3,
);

/*
 * Les trois usages en aval. C'est là que le choix de `Infinity` se paie ou se
 * rembourse : s'ils le traitaient mal, le cran « tout » ne préchargerait rien.
 */
const tracks = ['a', 'b', 'c', 'd', 'e'];
check('une tranche infinie prend toute la liste', tracks.slice(0, limit(-1)).join('') === 'abcde');
check("  … et une tranche finie s'arrête où il faut", tracks.slice(0, limit(2)).join('') === 'ab');

const upcomingSandbox = { console, Math };
upcomingSandbox.globalThis = upcomingSandbox;
vm.createContext(upcomingSandbox);
{
  const start = PRELOAD.indexOf('function upcomingTracks(');
  const end = PRELOAD.indexOf('\n}', start) + 2;
  vm.runInContext(PRELOAD.slice(start, end), upcomingSandbox);
}
const upcoming = upcomingSandbox.upcomingTracks;

check('la playlist entière suit la piste en cours', upcoming(tracks, 1, limit(-1), false).join('') === 'cde');
check(
  '  … et en boucle, elle en fait le tour sans se répéter',
  upcoming(tracks, 3, limit(-1), true).join('') === 'eabc',
  'toute la playlist sauf la piste en cours',
);
check("  … tandis qu'une limite finie borne toujours", upcoming(tracks, 0, limit(2), false).join('') === 'bc');

/* ══════════════════ À qui s'applique quel curseur ══════════════════ */

console.log('\nChaque curseur gouverne sa propre section\n');

/*
 * Le défaut relevé à l'usage : régler la file d'attente sur « tout »
 * préchargeait toute la playlist en cours, file vide comprise.
 *
 * Le lecteur n'a qu'une liste de pistes. Quand une playlist l'occupe, c'est elle
 * que `getTracks()` rend, et la file de l'utilisateur est mise de côté dans les
 * réglages. Les deux cas étaient servis à la suite, si bien que la liste du
 * lecteur passait sous `queueCount` quoi qu'elle contînt.
 */
// The block ends at the brace back at the `if`'s own indentation.
const queueBlock = /\n([ \t]*)if \(queueLimit > 0\) \{([\s\S]*?)\n\1\}/.exec(PRELOAD);

check(
  "la file d'attente est choisie, pas cumulée",
  Boolean(queueBlock) &&
    /const userQueue = sourceIsPlaylist\s*\?\s*this\._setAsideQueue\(settings\)\s*:\s*nextTracks;/.test(queueBlock[2]),
  'une playlist en lecture occupe la liste du lecteur',
);

check(
  "  … et la liste du lecteur ne passe plus sous « queueCount » quoi qu'elle contienne",
  Boolean(queueBlock) && !/targets\.push\(\.\.\.nextTracks\.slice\(0, queueLimit\)\)/.test(queueBlock[2]),
  "c'était là que la playlist se faisait précharger par le curseur de la file",
);

check(
  '  … une seule poussée sous ce curseur',
  Boolean(queueBlock) && (queueBlock[2].match(/targets\.push\(/g) || []).length === 1,
  "deux ajouts, c'était deux sections servies par un seul réglage",
);

/*
 * La playlist en cours reste servie — mais par son propre curseur, et depuis la
 * base plutôt que depuis la liste du lecteur.
 */
check(
  'la playlist en cours relève de « playlistCount »',
  /if \(playlistLimit > 0\) \{[\s\S]*?upcomingTracks\(\s*activePlaylist\.tracks, currentIdx, playlistLimit/.test(
    PRELOAD,
  ),
);
check(
  '  … et les autres playlists aussi',
  /globalPlaylists\.forEach\(\(?pl\)? => \{[\s\S]{0,200}?pl\.tracks\.slice\(0, playlistLimit\)/.test(PRELOAD),
);
check("l'historique garde le sien", /prevTracks\.slice\(0, historyLimit\)/.test(PRELOAD));

/* ══════════════════ Le plafond de parallélisme ══════════════════ */

console.log("\nCe qui empêche « tout » de tout lancer d'un coup\n");

check(
  'les téléchargements simultanés sont plafonnés',
  /const MAX_PARALLEL_PRELOADS = \d+;/.test(PRELOAD),
  (/const MAX_PARALLEL_PRELOADS = (\d+);/.exec(PRELOAD) || [])[1] + ' à la fois',
);

check(
  "la planification s'arrête au plafond",
  /if \(this\.activeDownloads\.size >= MAX_PARALLEL_PRELOADS\) \{[\s\S]{0,120}?break;/.test(PRELOAD),
  'et par un « break » : les cibles sont rangées par urgence',
);
check(
  '  … en retenant le serveur à reprendre',
  /this\.pendingGuilds\.add\(guildId\);/.test(PRELOAD),
  "le reliquat n'est pas perdu",
);

/*
 * La reprise ne part qu'après un succès. Après un échec, la piste fautive
 * repartirait aussitôt et relancerait la reprise — une boucle serrée, le délai
 * de reprise ne s'appliquant qu'au choix des cibles, pas au rythme des essais.
 */
const successBlock = /this\.failures\.delete\(key\);[\s\S]{0,240}?this\._schedulePump\(\);/.test(PRELOAD);
check('la reprise suit un préchargement abouti', successBlock);
check(
  '  … et jamais un échec',
  !/failures\.set\(key,[\s\S]{0,400}?_schedulePump/.test(PRELOAD),
  'sinon une source qui refuse ferait tourner la boucle à vide',
);
check(
  "  … et elle est différée d'un tour de boucle",
  /_schedulePump\(\) \{[\s\S]{0,200}?setImmediate\(/.test(PRELOAD),
  'update() annule des téléchargements par le même point de sortie',
);
check('  … sans se programmer deux fois', /if \(this\.pumpScheduled\) return;/.test(PRELOAD));

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
