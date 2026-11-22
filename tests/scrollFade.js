/**
 * Vérifie l'effacement des bords des listes qui défilent.
 *
 * Une liste qui défile se terminait sur une arête franche : rien ne distinguait
 * une piste coupée par le cadre d'une piste simplement finie. Un masque en
 * dégradé le dit désormais — mais la valeur du geste tient à quatre choses qui
 * ne se lisent pas dans un diff.
 *
 *  - **Le dégradé mesure ce qu'il cache.** Sa hauteur est celle de la partie
 *    hors champ, plafonnée. C'est ce qui le fait naître de rien et grandir avec
 *    ce qu'il annonce, sans qu'aucune transition n'ait à être écrite.
 *
 *  - **Une liste courte n'a aucun dégradé.** Ce serait le défaut le plus visible
 *    de tous : une première piste estompée alors que rien n'est caché au-dessus
 *    d'elle. Il tombe tout seul de la règle précédente.
 *
 *  - **Rien n'est retenu par conteneur.** La liste d'une playlist est
 *    reconstruite à chaque rendu ; un observateur posé une fois au chargement
 *    aurait disparu avec elle. D'où le défilement capté à la racine, en phase
 *    de capture — seule façon d'entendre un événement qui ne remonte pas.
 *
 *  - **Un masque efface tout ce que peint l'élément**, bordure comprise. Pendant
 *    un glisser-déposer, le liseré qui désigne la cible s'effacerait justement à
 *    ses deux extrémités : le cadre reprend alors ses arêtes.
 *
 * Le module est exécuté tel quel sur un DOM simulé : ce qui est mesuré est le
 * fichier livré.
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'js', 'scrollFade.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'css', 'queue.css'), 'utf8');
const MARKUP = fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'index.html'), 'utf8');

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

/** Une liste factice : ses trois mesures, et ce qu'on lui écrit. */
function makeList(id, { clientHeight = 100, scrollHeight = 100, scrollTop = 0 } = {}) {
  const props = new Map();
  let writes = 0;
  return {
    id,
    clientHeight,
    scrollHeight,
    scrollTop,
    style: {
      setProperty(name, value) {
        props.set(name, value);
        writes += 1;
      },
      getPropertyValue: (name) => props.get(name) || '',
    },
    top: () => props.get('--scroll-fade-top'),
    bottom: () => props.get('--scroll-fade-bottom'),
    writes: () => writes,
  };
}

function mount(lists) {
  const roots = {};
  for (const id of ['playlist-queue-container', 'playlist-history-container', 'active-playlist-content']) {
    roots[id] = { id };
  }

  const events = [];
  const frames = [];
  const sizeObserved = [];
  const contentObserved = [];

  const sandbox = {
    window: {
      MusicPlayer: {},
      addEventListener: (type, fn) => events.push({ on: 'window', type, fn }),
    },
    document: {
      getElementById: (id) => roots[id] || null,
      querySelectorAll: () => lists,
      addEventListener: (type, fn, capture) => events.push({ on: 'document', type, fn, capture }),
    },
    requestAnimationFrame: (fn) => frames.push(fn),
    ResizeObserver: function (callback) {
      this.callback = callback;
      this.observe = (el) => sizeObserved.push(el);
    },
    MutationObserver: function (callback) {
      this.callback = callback;
      this.observe = (el, options) => contentObserved.push({ el, options });
    },
    Math,
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox);

  const fire = (on, type) => {
    const found = events.find((e) => e.on === on && e.type === type);
    if (found) found.fn();
  };

  return {
    lists,
    events,
    sizeObserved,
    contentObserved,
    api: sandbox.window.MusicPlayer,
    fire,
    /** Déroule les images en attente : c'est là que le dessin a lieu. */
    flush: () => {
      while (frames.length) frames.shift()();
    },
    pending: () => frames.length,
    capture: (type) => events.find((e) => e.on === 'document' && e.type === type),
  };
}

console.log('\n=== Les bords des listes qui défilent ===\n');

// ───────────────────── Ce que le dégradé mesure ─────────────────────

console.log("La hauteur du dégradé, et ce qu'elle dit\n");

{
  // Une liste courte : tout tient à l'écran, rien n'est caché.
  const court = makeList('court', { clientHeight: 200, scrollHeight: 200 });
  mount([court]);
  check(
    "une liste qui ne défile pas n'a aucun dégradé",
    court.top() === '0px' && court.bottom() === '0px',
    "estomper sa première piste alors que rien n'est caché au-dessus",
  );
}

{
  // Tout en haut d'une liste qui déborde : rien au-dessus, beaucoup en dessous.
  const haut = makeList('haut', { clientHeight: 200, scrollHeight: 600, scrollTop: 0 });
  mount([haut]);
  check('en haut de liste, le bord haut reste franc', haut.top() === '0px', haut.top());
  check("  … et le bord bas s'efface", haut.bottom() === '18px', haut.bottom());
}

{
  const bas = makeList('bas', { clientHeight: 200, scrollHeight: 600, scrollTop: 400 });
  mount([bas]);
  check('en butée basse, le bord bas redevient franc', bas.bottom() === '0px', bas.bottom());
  check("  … car plus rien n'est caché en dessous", bas.top() === '18px');
}

{
  const milieu = makeList('milieu', { clientHeight: 200, scrollHeight: 600, scrollTop: 200 });
  mount([milieu]);
  check("au milieu, les deux bords s'effacent", milieu.top() === '18px' && milieu.bottom() === '18px');
}

{
  // Le point qui fait tout : le dégradé naît de rien et grandit avec ce qu'il
  // annonce. Un dégradé qui s'allumerait d'un coup au premier pixel se
  // remarquerait — celui-ci n'a besoin d'aucune transition.
  const naissant = makeList('naissant', { clientHeight: 200, scrollHeight: 600, scrollTop: 3 });
  mount([naissant]);
  check('trois pixels cachés ne donnent que trois pixels de dégradé', naissant.top() === '3px', naissant.top());

  const plafond = makeList('plafond', { clientHeight: 200, scrollHeight: 5000, scrollTop: 900 });
  mount([plafond]);
  check(
    '  … et au-delà, le dégradé cesse de grandir',
    plafond.top() === '18px' && plafond.bottom() === '18px',
    "il annonce qu'il y a plus, pas combien de plus",
  );
}

// ───────────────────── Ce à quoi il se raccroche ─────────────────────

console.log('\nCe à quoi le module se raccroche\n');

{
  const liste = makeList('liste', { clientHeight: 200, scrollHeight: 600, scrollTop: 100 });
  const m = mount([liste]);

  // Le défilement ne remonte pas la page : sans la phase de capture, la
  // racine n'entendrait jamais celui d'une liste.
  const scroll = m.capture('scroll');
  check(
    'le défilement est capté à la descente',
    !!scroll && scroll.capture === true,
    'un événement de défilement ne remonte pas',
  );

  check(
    'les trois cartes sont observées, sous-arbres compris',
    m.contentObserved.length === 3 && m.contentObserved.every((o) => o.options.childList && o.options.subtree),
    "la liste d'une playlist est reconstruite à chaque rendu",
  );

  check(
    'la taille des conteneurs est suivie à part',
    m.sizeObserved.length === 1 && m.sizeObserved[0] === liste,
    'une carte redimensionnée ne défile ni ne mute',
  );
}

{
  // Un conteneur remplacé doit être repris sans que rien n'ait été enregistré
  // sur lui : le module repart de la page à chaque réveil.
  const ancien = makeList('ancien', { clientHeight: 200, scrollHeight: 600, scrollTop: 100 });
  const listes = [ancien];
  const m = mount(listes);

  const neuf = makeList('neuf', { clientHeight: 200, scrollHeight: 600, scrollTop: 50 });
  listes.length = 0;
  listes.push(neuf);

  m.fire('document', 'scroll');
  m.flush();
  check(
    'une liste reconstruite est reprise au réveil suivant',
    neuf.top() === '18px' && neuf.bottom() === '18px',
    "rien n'est retenu par conteneur",
  );
}

{
  const liste = makeList('liste', { clientHeight: 200, scrollHeight: 600, scrollTop: 100 });
  const m = mount([liste]);
  const apresMontage = liste.writes();

  // Le défilement réveille à chaque image ; réécrire la même valeur
  // invaliderait le style pour rien.
  m.fire('document', 'scroll');
  m.flush();
  check("une valeur inchangée n'est pas réécrite", liste.writes() === apresMontage, `${liste.writes()} écritures`);

  // Au milieu d'une longue liste, les deux bords sont au plafond et défiler
  // n'y change rien : c'est en approchant du bout que la valeur bouge.
  liste.scrollTop = 150;
  m.fire('document', 'scroll');
  m.flush();
  check(
    '  … et défiler loin des deux bouts ne change rien non plus',
    liste.writes() === apresMontage,
    'le dégradé y est au plafond',
  );

  liste.scrollTop = 395;
  m.fire('document', 'scroll');
  m.flush();
  check(
    '  … mais approcher du bout rétrécit le dégradé',
    liste.bottom() === '5px' && liste.writes() > apresMontage,
    liste.bottom(),
  );
}

{
  const liste = makeList('liste', { clientHeight: 200, scrollHeight: 600 });
  const m = mount([liste]);

  // Plusieurs réveils dans la même image ne doivent donner qu'un seul passage.
  m.fire('document', 'scroll');
  m.fire('document', 'scroll');
  m.fire('window', 'resize');
  check("les réveils d'une même image se fondent en un seul", m.pending() === 1, `${m.pending()} images demandées`);
}

// ───────────────────── Le masque lui-même ─────────────────────

console.log("\nCe que le masque efface, et ce qu'il épargne\n");

{
  // La seule règle du masque, sans celle qui le retire pendant un glisser :
  // celle-ci porte aussi les deux propriétés, et fausserait tout comptage.
  const rule = CSS.slice(CSS.indexOf('.playlist-queue,'), CSS.indexOf('body.is-dragging-active .playlist-queue'));

  check(
    'les trois listes portent le masque',
    rule.includes('.playlist-queue,') && rule.includes('.playlist-history,') && rule.includes('.playlist-tracks-list'),
  );

  check(
    'il efface vers le transparent, sans supposer de couleur de fond',
    /mask-image:\s*linear-gradient\(\s*to bottom,\s*transparent 0,/.test(rule),
    'les cartes sont en verre dépoli et changent avec le thème',
  );

  check(
    'les deux bords sont pilotés par les hauteurs calculées',
    rule.includes('#000 var(--scroll-fade-top)') && rule.includes('#000 calc(100% - var(--scroll-fade-bottom))'),
  );

  check(
    'le préfixe WebKit accompagne la forme standard',
    (rule.match(/-webkit-mask-image:/g) || []).length === 1 && (rule.match(/[^-]mask-image:/g) || []).length === 1,
  );

  // Un masque efface tout ce que peint l'élément, bordure comprise.
  check(
    'le cadre reprend ses arêtes pendant un glisser-déposer',
    /body\.is-dragging-active \.playlist-queue[\s\S]{0,240}mask-image: none/.test(CSS),
    "sinon le liseré de la cible s'efface à ses deux extrémités",
  );
}

check('le module est chargé par la page', MARKUP.includes('<script src="js/scrollFade.js"></script>'));

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
