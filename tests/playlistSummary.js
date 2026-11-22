/**
 * Vérifie le résumé d'une playlist — combien de morceaux, et pour combien de
 * temps —, avec les vrais modules du tableau de bord exécutés dans un DOM
 * simulé.
 *
 * Quatre choses s'y jouent, et aucune ne se lit dans un diff.
 *
 *  - **Les aiguillages ne sont pas des morceaux.** Ils occupent une ligne dans
 *    la même liste, mais ne se jouent pas et n'ont pas de durée. Les compter
 *    ferait mentir les deux nombres d'un coup.
 *
 *  - **Une durée inconnue s'écrit « 0:00 »** d'un bout à l'autre du tableau de
 *    bord, et rien ne la distingue d'un morceau qui durerait vraiment zéro
 *    seconde — sauf qu'un tel morceau n'existe pas. Le total devient alors un
 *    minimum, et doit le dire plutôt que de sous-compter en silence.
 *
 *  - **Le singulier n'est employé qu'à un.** Une playlist vide n'affiche pas de
 *    résumé du tout : c'est ce qui évite d'avoir à trancher entre « 0 morceau »
 *    et « 0 tracks », que les quatre langues n'écrivent pas de la même façon.
 *
 *  - **Le total se relit depuis du texte.** Les durées circulent en « m:ss » et
 *    « h:mm:ss », jamais en nombre : les additionner suppose un analyseur, et
 *    celui du navigateur doit rendre exactement ce que rend celui du serveur.
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const QUEUE_CSS = fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'css', 'queue.css'), 'utf8');
const LISTES = fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'js', 'playlists.js'), 'utf8');
const { parseDurationToMs } = require(path.join(ROOT, 'src', 'utils', 'duration.js'));

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

console.log("\n=== Le résumé d'une playlist ===\n");

/* ═══════════════ Les vrais modules ═══════════════ */

/** Le strict nécessaire pour que les trois modules se chargent. */
function stub() {
  return {
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild() {},
    addEventListener() {},
    setAttribute() {},
    getAttribute: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

const sandbox = {
  window: { addEventListener() {} },
  document: {
    getElementById: () => null,
    createElement: stub,
    addEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    body: stub(),
  },
  localStorage: { getItem: () => null, setItem() {} },
  console: { log() {}, warn() {}, error() {} },
  Number,
  String,
  JSON,
  Date,
  Math,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const mod of ['transitions', 'player', 'playlists']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'js', `${mod}.js`), 'utf8'), sandbox);
}
const MP = sandbox.window.MusicPlayer;

/* ═══════════════ Relire une durée ═══════════════ */

console.log('Relire ce que le serveur a écrit\n');

for (const [text, ms] of [
  ['3:45', 225000],
  ['0:07', 7000],
  ['1:02:03', 3723000],
  ['90', 90000],
]) {
  check(`« ${text} » vaut ${ms} ms`, MP.parseDurationMs(text) === ms, String(MP.parseDurationMs(text)));
  check(
    `  … comme côté serveur`,
    MP.parseDurationMs(text) === parseDurationToMs(text),
    'les deux analyseurs lisent le même texte, ils doivent rendre le même nombre',
  );
}

for (const bad of ['', null, undefined, 'inconnue', '1:2:3:4', '-5:00']) {
  check(
    `« ${String(bad)} » ne vaut rien`,
    MP.parseDurationMs(bad) === 0,
    'une durée illisible est une durée inconnue, pas une durée nulle',
  );
}

/* ═══════════════ Le résumé ═══════════════ */

console.log('\nCe que le résumé annonce\n');

/** Une pastille de résumé, réduite à ce que le peintre touche. */
function pastille() {
  return { hidden: false, textContent: '', dataset: {} };
}

const morceau = (titre, duree) => ({ title: titre, url: `http://x/${titre}`, duration: duree });
const aiguillage = (cible) => ({ isTransition: true, url: 'transition:1', target: cible });

/** Repeint et rend la pastille. */
function resume(tracks, dict = null) {
  MP.t = dict ? (k) => dict[k] || k : (k) => k;
  const el = pastille();
  MP.paintPlaylistSummary(el, { id: 'p', tracks });
  return el;
}

{
  const el = resume([morceau('A', '3:45'), morceau('B', '2:15')]);
  check('deux morceaux et leur total', el.textContent === '2 morceaux · 6:00', el.textContent);
  check('  … et la pastille se montre', el.hidden === false);
}

{
  const el = resume([morceau('A', '3:45')]);
  check('un seul morceau se dit au singulier', el.textContent === '1 morceau · 3:45', el.textContent);
}

{
  const el = resume([]);
  check(
    "une playlist vide n'a pas de résumé",
    el.hidden === true,
    "la liste annonce déjà qu'elle est vide — et « 0 morceau » ne s'écrit pas pareil partout",
  );
}

{
  const el = resume([morceau('A', '45:00'), morceau('B', '20:30')]);
  check("le total passe l'heure sans se tromper", el.textContent === '2 morceaux · 1:05:30', el.textContent);
}

{
  const el = resume([morceau('A', '3:00'), aiguillage('queue'), morceau('B', '2:00')]);
  check('un aiguillage ne compte pas pour un morceau', el.textContent === '2 morceaux · 5:00', el.textContent);
}

{
  const el = resume([aiguillage('queue')]);
  check("  … et une playlist qui n'a que lui n'a rien à résumer", el.hidden === true);
}

{
  const el = resume([morceau('A', '3:00'), morceau('B', '0:00')]);
  check('une durée inconnue rend le total minimal', el.textContent === '2 morceaux · ≥ 3:00', el.textContent);
  check(
    "  … et l'infobulle le dit sur une seconde ligne",
    el.dataset.tooltipHint === 'playlist_summary_unknown',
    'sous-compter en silence serait pire que de compter approximativement',
  );
}

{
  const el = pastille();
  el.dataset.tooltipHint = 'playlist_summary_unknown';
  MP.t = (k) => k;
  MP.paintPlaylistSummary(el, { id: 'p', tracks: [morceau('A', '3:00')] });
  check(
    "la seconde ligne s'efface quand tout est connu",
    el.dataset.tooltipHint === undefined,
    "une durée résolue depuis laisserait sinon l'avertissement derrière elle",
  );
}

{
  const el = resume([morceau('A', '1:00'), morceau('B', '1:00'), morceau('C', '1:00')], {
    playlist_summary_many: '{n} tracks',
  });
  check('le libellé traduit garde sa place pour le nombre', el.textContent === '3 tracks · 3:00', el.textContent);
}

/* ═══════════════ La place dans l'en-tête ═══════════════ */

console.log('\nLà où il se range\n');

check(
  "le résumé s'intercale entre le nom et la corbeille",
  /headerDiv\.appendChild\(nameContainer\);\s*\n\s*headerDiv\.appendChild\(summary\);\s*\n\s*headerDiv\.appendChild\(deleteBtn\);/.test(
    LISTES,
  ),
  "c'est la seule place libre de l'en-tête, et celle que désigne la maquette",
);
/*
 * L'en-tête n'est bâti qu'au changement de playlist ; le repeint, lui, doit
 * avoir lieu à chaque passage. On le vérifie à sa place dans le fichier : après
 * la branche qui retrouve une liste déjà montée, donc sur le chemin commun.
 */
check(
  '  … et il est repeint à chaque passage, pas au seul changement de playlist',
  LISTES.indexOf('window.MusicPlayer.paintPlaylistSummary(') >
    LISTES.indexOf("tracksListDiv = activePlaylistContent.querySelector('#playlist-tracks-list')"),
  'un morceau ajouté ne change pas la playlist affichée',
);

check(
  'le nom cède la place avant lui',
  /\.playlist-name-container \{[^}]*min-width: 0;/s.test(QUEUE_CSS),
  'un champ de saisie refuse sinon de descendre sous sa largeur intrinsèque',
);
check(
  'le résumé, lui, ne se comprime pas',
  /\.playlist-summary \{[^}]*flex-shrink: 0;/s.test(QUEUE_CSS),
  'sans quoi « 12 morceaux » se couperait en deux',
);
check(
  "`hidden` l'emporte sur son propre display",
  /\.playlist-summary\[hidden\] \{[^}]*display: none;/s.test(QUEUE_CSS),
  'sans quoi une playlist vide afficherait une pastille vide',
);

/* ═══════════════ Les libellés ═══════════════ */

console.log('\nLes libellés\n');

for (const lang of ['fr', 'en', 'es', 'de']) {
  const dict = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'locales', `${lang}.json`), 'utf8'));
  const keys = [
    'playlist_summary_one',
    'playlist_summary_many',
    'tooltip_playlist_summary',
    'playlist_summary_unknown',
  ];
  const missing = keys.filter((k) => !dict[k]);
  check(
    `${lang} : les libellés du résumé sont traduits`,
    missing.length === 0,
    missing.length ? missing.join(', ') : dict.playlist_summary_many,
  );

  const noPlace = keys.slice(0, 2).filter((k) => dict[k] && !dict[k].includes('{n}'));
  check(`  … et gardent la place du nombre`, noPlace.length === 0, noPlace.length ? noPlace.join(', ') : '{n}');
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
