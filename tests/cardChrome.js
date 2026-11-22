/**
 * Vérifie les commandes du titre d'une carte : la poignée et ses deux boutons.
 *
 * Un titre de carte porte trois choses côte à côte — la poignée de déplacement,
 * le cadenas, le « i » — et toutes trois s'éclairent au survol. Elles partagent
 * un parent, ce qui suffit à les faire réagir les unes pour les autres si on
 * les accroche au survol de ce parent : survoler le cadenas allumait la
 * poignée, et survoler la poignée allumait le cadenas.
 *
 * Cela ne se voit pas dans un diff, ni dans une capture d'écran prise au repos.
 * Ce test lit donc la feuille et vérifie à quoi chaque règle s'accroche.
 *
 * Il tient aussi ce que le doublon avait laissé s'installer : `.card-lock-btn`
 * était défini deux fois, à deux endroits éloignés, et un jeu de règles portait
 * sur une classe — `is-locked` — que rien ne pose jamais. Le second bloc
 * l'emportait sur le premier pour les propriétés communes, et l'on ne pouvait
 * plus lire le style du bouton à un seul endroit.
 */
const fs = require('fs');
const path = require('path');

let failed = 0;
let passed = 0;
const check = (label, ok, detail = '') => {
  if (ok) {
    passed++;
    console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const CSS = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'public', 'css', 'components.css'), 'utf8');

/**
 * Les règles d'une feuille, réduites à { selector, body }.
 *
 * Découpage volontairement naïf — pas d'imbrication ni de media query à
 * traverser ici —, mais suffisant pour dire à quoi une règle s'accroche.
 */
function rules(css) {
  /*
   * Les commentaires sont retirés d'abord, et c'est indispensable : ils
   * précèdent les règles et se retrouveraient collés à leur sélecteur. Le
   * premier essai s'en est chargé lui-même — un commentaire qui citait
   * `.card-title:hover .card-lock-btn` pour dire qu'on l'avait supprimée
   * faisait échouer la vérification de son absence.
   */
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, ' ');

  const found = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(bare)) !== null) {
    found.push({ selector: m[1].trim().replace(/\s+/g, ' '), body: m[2] });
  }
  return found;
}

const ALL = rules(CSS);
const selectorsFor = (subject) =>
  ALL.map((r) => r.selector).filter((sel) => sel.split(',').some((part) => part.trim().endsWith(subject)));

console.log('\n=== Les commandes du titre d’une carte ===\n');

// ─────────────────── Chacun ne réagit qu'à son survol ───────────────────

console.log('À quoi chaque animation s’accroche\n');

/*
 * Une règle qui vise le cadenas depuis le survol du titre : c'est exactement le
 * défaut. Le cadenas doit s'allumer parce qu'on le survole lui, pas parce qu'on
 * survole la rangée qui le porte.
 */
const lockFromTitle = selectorsFor('.card-lock-btn').filter((sel) => /\.card-title:hover/.test(sel));
check(
  'le cadenas ne s’allume pas au survol du titre',
  lockFromTitle.length === 0,
  lockFromTitle.join(' | ') || 'aucune règle de ce genre',
);

const handleHover = selectorsFor('.icon-drag-handle').filter(
  (sel) => /\.card-title:hover/.test(sel) && !/card-locked/.test(sel),
);
check('la poignée s’allume bien au survol du titre', handleHover.length === 1, handleHover.join(' | ') || 'aucune');

// La poignée, elle, garde le titre pour déclencheur — c'est par le titre entier
// qu'on saisit la carte —, mais doit s'exclure des boutons qu'il porte.
check(
  '  … sauf quand le pointeur est sur le cadenas',
  handleHover.every((sel) => /:not\([^)]*\.card-lock-btn:hover/.test(sel)),
  handleHover.join(' | '),
);
check(
  '  … ni sur le « i », qui avait le même défaut',
  handleHover.every((sel) => /\.card-info-btn:hover/.test(sel)),
  handleHover.join(' | '),
);

// ─────────────────── Un seul style, à un seul endroit ───────────────────

console.log('\nUn bouton, une définition\n');

const lockBase = ALL.filter((r) => r.selector === '.card-lock-btn');
check('`.card-lock-btn` n’est défini qu’une fois', lockBase.length === 1, `${lockBase.length} définition(s)`);

const deadLocked = ALL.filter((r) => /\.card\.is-locked/.test(r.selector));
check(
  'plus aucune règle sur `is-locked`, que rien ne pose',
  deadLocked.length === 0,
  deadLocked.map((r) => r.selector).join(' | ') || 'aucune',
);

// ─────────────────── La forme d'un vrai bouton ───────────────────

console.log('\nLe cadenas a la forme d’un bouton\n');

const lockBody = lockBase.length === 1 ? lockBase[0].body : '';
const infoBody = (ALL.find((r) => r.selector === '.card-info-btn') || { body: '' }).body;

/*
 * Le gabarit du « i » de la même rangée : marge intérieure et coin arrondi.
 * C'est ce qui donne au cadenas une surface cliquable plus large que son
 * dessin, et ce qui fait que les deux boutons d'un titre se ressemblent.
 */
[
  ['padding', /padding:\s*2px/],
  ['border-radius', /border-radius:\s*4px/],
].forEach(([name, re]) => {
  check(
    `il reprend le ${name} du « i »`,
    re.test(lockBody) && re.test(infoBody),
    lockBody.trim().replace(/\s+/g, ' ').slice(0, 70),
  );
});

const lockHover = ALL.find((r) => r.selector === '.card-lock-btn:hover');
check(
  'son survol pose un fond, comme celui du « i »',
  !!lockHover && /background:/.test(lockHover.body),
  lockHover ? lockHover.body.trim().replace(/\s+/g, ' ') : 'aucune règle de survol',
);

/*
 * Le `!important` d'avant rattrapait un ordre de cascade : les règles de la
 * carte verrouillée viennent après celles du survol et les égalent en
 * spécificité. La règle de survol du cadenas verrouillé rend au survol ce qui
 * lui revient, sans forcer la main.
 */
const lockedRules = ALL.filter((r) => /card-locked .*\.card-lock-btn/.test(r.selector));
check(
  'aucun `!important` sur le cadenas verrouillé',
  lockedRules.every((r) => !/!important/.test(r.body)),
  lockedRules.map((r) => r.selector).join(' | '),
);
check(
  '  … et son survol reste distingué',
  lockedRules.some((r) => r.selector.endsWith(':hover')),
  lockedRules.map((r) => r.selector).join(' | '),
);

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed === 0 ? 0 : 1);
