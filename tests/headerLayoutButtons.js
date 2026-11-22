/**
 * Vérifie les deux boutons de disposition de l'en-tête — le vrai
 * headerButtonAnimations.js, exécuté dans un DOM simulé.
 *
 * Ces deux boutons décident de la forme du tableau de bord : l'un relève la
 * disposition courante et en fait celle du prochain démarrage, l'autre fige
 * toutes les boîtes d'un coup. Leur animation ne décore pas — elle dit ce que
 * le clic va faire, avant qu'on le fasse.
 *
 * ## Le relevé de la disposition
 *
 * Une barre claire parcourt la disquette comme la vitre d'un scanner, et laisse
 * derrière elle une maquette de ce qu'elle vient de relever. Trois choses
 * portent le sens, et aucune ne se voit dans un diff :
 *
 *  - **rien ne s'allume avant le passage de la barre.** Montrer la maquette
 *    d'emblée ferait de la barre un ornement qui passe devant un dessin déjà
 *    là ; c'est le relevé qui fait exister ce qu'il relève ;
 *  - **la rangée du haut s'allume avant celle du bas**, faute de quoi la barre
 *    ne balaie rien du tout ;
 *  - **le clic reprend le même geste, en plus vif**, et s'achève par un sursaut
 *    de la maquette. Ce n'est pas une seconde animation : c'est la promesse du
 *    survol, tenue.
 *
 * ## Le cadenas
 *
 * Au survol il penche vers son autre état **sans y aller** — ouvert, l'anse
 * s'incline vers la fermeture ; fermé, elle tire vers le haut. Au clic elle
 * claque, dépasse sa cible et revient en s'amortissant.
 *
 * Deux pièges que ce test surveille et qu'aucune relecture ne montre :
 *
 *  - **la charnière est en (7, 11)**, le pied de la branche gauche. Toute autre
 *    origine fait flotter l'anse au-dessus de sa serrure ;
 *  - **le glyphe change sous l'animation.** Les deux états sont deux `<svg>` que
 *    le tableau de bord échange dans un autre écouteur, dont l'ordre n'est pas
 *    garanti. Le claquement est différé d'une trame et s'applique à l'anse qui
 *    vient d'apparaître ; s'il partait de l'ancienne, on animerait un dessin
 *    que personne ne voit.
 *
 * Le repos, enfin : les deux animations rendent leurs déclarations à la feuille
 * de style au lieu de reposer des valeurs à la main. Un bouton qui garderait
 * une `opacity` ou un `transform` en ligne emporterait l'empreinte de son
 * animation dans son état de repos.
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'js', 'headerButtonAnimations.js'), 'utf8');
const MARKUP = fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'css', 'modals.css'), 'utf8');

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

console.log('\n=== Les deux boutons de disposition ===\n');

/* ════════════════ Le balisage, lu une fois pour toutes ════════════════ */

console.log('Ce que le balisage déclare\n');

/** Les rectangles du relevé, tels qu'ils sont écrits dans index.html. */
function readSaveShots() {
  const button = MARKUP.slice(MARKUP.indexOf('id="btn-save-default-layout"'), MARKUP.indexOf('id="btn-open-settings"'));

  const shots = [];
  const re = /<rect class="save-shot ([^"]+)"([^>]*)>/g;
  let m;
  while ((m = re.exec(button)) !== null) {
    const attrs = {};
    const attrRe = /(\w+)="([^"]*)"/g;
    let a;
    while ((a = attrRe.exec(m[2])) !== null) attrs[a[1]] = a[2];
    shots.push({ role: m[1], attrs });
  }
  return shots;
}

const SHOTS = readSaveShots();
const CARDS = SHOTS.filter((s) => s.role === 'save-card');
const SCAN = SHOTS.find((s) => s.role === 'save-scan');

check('la maquette compte trois rectangles', CARDS.length === 3, 'deux boîtes côte à côte, une plus large en dessous');
check('  … et la barre de balayage est là', Boolean(SCAN));

if (CARDS.length === 3 && SCAN) {
  const rows = [...new Set(CARDS.map((c) => Number(c.attrs.y)))].sort((a, b) => a - b);
  check('  … sur deux rangées', rows.length === 2, rows.join(' puis '));

  const wide = CARDS.reduce((a, b) => (Number(a.attrs.width) > Number(b.attrs.width) ? a : b));
  check(
    '  … la plus large étant celle du bas',
    Number(wide.attrs.y) === rows[1],
    'sinon la maquette ne ressemble pas à un tableau de bord',
  );

  /*
   * L'étiquette de la disquette est le tracé « 17 21 17 13 7 13 7 21 »,
   * dessiné à deux unités d'épaisseur : son intérieur commence donc une unité
   * plus loin de chaque côté. Un rectangle qui déborderait viendrait mordre le
   * trait, et la maquette ne serait plus posée sur l'étiquette mais dessus.
   */
  const inside = CARDS.every(
    (c) =>
      Number(c.attrs.x) >= 8 &&
      Number(c.attrs.x) + Number(c.attrs.width) <= 16 &&
      Number(c.attrs.y) >= 14 &&
      Number(c.attrs.y) + Number(c.attrs.height) <= 20,
  );
  check("  … et tous tiennent dans l'étiquette", inside, 'intérieur du tracé : x de 8 à 16, y de 14 à 20');
}

check(
  'les deux glyphes du cadenas nomment leurs pièces',
  (MARKUP.match(/class="lock-shackle"/g) || []).length === 2 && (MARKUP.match(/class="lock-body"/g) || []).length === 2,
  'le script anime celle des deux anses qui est visible',
);

check(
  'le repos du relevé est écrit dans la feuille de style',
  /#btn-save-default-layout \.save-shot \{[^}]*opacity: 0;/.test(CSS),
);
check(
  '  … et nulle part dans le balisage',
  !/save-shot[^>]*opacity=/.test(MARKUP),
  'un attribut de présentation passerait sous la feuille de style',
);
check(
  '  … le contour du <svg> parent étant repris',
  /#btn-save-default-layout \.save-shot \{[^}]*stroke: none;/.test(CSS),
  'sans quoi trois rectangles pleins prendraient un contour de deux unités',
);

check(
  "l'onde du clic prend la couleur du bouton",
  /\.theme-toggle-btn\.header-pulse::after \{[^}]*border: 1\.5px solid currentColor;/.test(CSS),
  "verte à l'enregistrement, rose au verrouillage, sans rien coder deux fois",
);
check(
  '  … et se tait quand les animations sont refusées',
  /@media \(prefers-reduced-motion: reduce\) \{\s*\.theme-toggle-btn\.header-pulse::after \{ animation: none; \}/.test(
    CSS,
  ),
);

/* ════════════════════════ Un DOM juste assez vrai ════════════════════════ */

/**
 * Élément factice : attributs, style en ligne, classes, écouteurs.
 *
 * Ni jsdom ni navigateur. Ce qu'on éprouve tient dans les attributs et le style
 * que le script pose lui-même, et rien d'autre n'a besoin d'exister.
 */
function makeElement(tag, className = '', attrs = {}) {
  const listeners = {};
  const attributes = Object.assign({}, attrs);
  const classes = new Set(String(className).split(/\s+/).filter(Boolean));

  const style = {
    removeProperty(name) {
      delete style[name.replace(/-([a-z])/g, (m, c) => c.toUpperCase())];
    },
  };

  const el = {
    tagName: tag.toUpperCase(),
    children: [],
    style,
    offsetWidth: 38,
    _listeners: listeners,
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      contains: (c) => classes.has(c),
      toggle: (c, force) => {
        const on = force === undefined ? !classes.has(c) : force;
        if (on) classes.add(c);
        else classes.delete(c);
        return on;
      },
    },
    getAttribute: (n) => (Object.prototype.hasOwnProperty.call(attributes, n) ? attributes[n] : null),
    setAttribute: (n, v) => {
      attributes[n] = String(v);
    },
    removeAttribute: (n) => {
      delete attributes[n];
    },
    addEventListener: (type, fn) => {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    removeEventListener: () => {},
    appendChild: (c) => {
      el.children.push(c);
      return c;
    },
    fire: (type) =>
      (listeners[type] || []).forEach((fn) =>
        fn({
          preventDefault() {},
          stopPropagation() {},
        }),
      ),
    _classes: classes,
  };

  el.querySelectorAll = (sel) =>
    sel
      .split(',')
      .map((s) => s.trim())
      .reduce((out, simple) => {
        for (const node of descendants(el)) {
          if (matches(node, simple) && !out.includes(node)) out.push(node);
        }
        return out;
      }, []);
  el.querySelector = (sel) => el.querySelectorAll(sel)[0] || null;

  return el;
}

function descendants(root, out = []) {
  for (const child of root.children) {
    out.push(child);
    descendants(child, out);
  }
  return out;
}

function matches(el, simple) {
  if (simple.startsWith('.')) return el._classes.has(simple.slice(1));
  return el.tagName === simple.toUpperCase();
}

/**
 * Monte le vrai module sur les deux boutons, avec une horloge que l'on avance
 * à la main.
 */
function mount({ reduced = false, locked = false } = {}) {
  const save = makeElement('button', 'theme-toggle-btn');
  const saveSvg = makeElement('svg');
  save.appendChild(saveSvg);

  // Les rectangles viennent du balisage réel : si quelqu'un les déplace, le
  // test se déplace avec eux plutôt que de mesurer un décor inventé ici.
  const cardEls = CARDS.map((c) => makeElement('rect', `save-shot save-card`, c.attrs));
  const scanEl = makeElement('rect', 'save-shot save-scan', SCAN ? SCAN.attrs : {});
  cardEls.forEach((c) => saveSvg.appendChild(c));
  saveSvg.appendChild(scanEl);

  const lock = makeElement('button', `theme-toggle-btn${locked ? ' header-lock-active' : ''}`);
  const openSvg = makeElement('svg', locked ? 'hidden' : '');
  const openBody = makeElement('rect', 'lock-body');
  const openShackle = makeElement('path', 'lock-shackle');
  openSvg.appendChild(openBody);
  openSvg.appendChild(openShackle);

  const shutSvg = makeElement('svg', locked ? '' : 'hidden');
  const shutBody = makeElement('rect', 'lock-body');
  const shutShackle = makeElement('path', 'lock-shackle');
  shutSvg.appendChild(shutBody);
  shutSvg.appendChild(shutShackle);

  lock.appendChild(openSvg);
  lock.appendChild(shutSvg);

  const known = {
    'btn-save-default-layout': save,
    'btn-lock-all': lock,
  };

  const frames = [];
  let clock = 0;

  const sandbox = {
    window: {
      MusicPlayer: {},
      addEventListener() {},
      matchMedia: () => ({ matches: reduced }),
      devicePixelRatio: 1,
    },
    document: {
      getElementById: (id) => known[id] || null,
      createElement: () => makeElement('div'),
      documentElement: { getAttribute: () => 'dark' },
      body: { appendChild() {} },
      querySelector: () => null,
    },
    requestAnimationFrame: (fn) => {
      frames.push(fn);
      return frames.length;
    },
    cancelAnimationFrame() {},
    performance: { now: () => clock },
    setTimeout: () => 0,
    clearTimeout() {},
    Math,
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox);

  /** Avance l'horloge et exécute les trames en attente à cet instant. */
  const advance = (ms) => {
    clock += ms;
    const due = frames.splice(0, frames.length);
    due.forEach((fn) => fn(clock));
  };

  return {
    save,
    lock,
    advance,
    cards: cardEls,
    scan: scanEl,
    shackle: () => (locked ? shutShackle : openShackle),
    body: () => (locked ? shutBody : openBody),
    openShackle,
    shutShackle,
    openBody,
    shutBody,
    /**
     * Ce que fait `updateHeaderLockAllButton` au clic : échanger les deux
     * glyphes et marquer le bouton.
     *
     * Sans cette bascule, le script continue d'animer l'anse ouverte —
     * celle qui vient de disparaître — et l'on ne verrait jamais rien. Le
     * simuler ici est la seule façon d'éprouver le report d'une trame.
     */
    applyLockState: (isLocked) => {
      openSvg.classList.toggle('hidden', isLocked);
      shutSvg.classList.toggle('hidden', !isLocked);
      lock.classList.toggle('header-lock-active', isLocked);
    },
    pending: () => frames.length,
    at: () => clock,
    /** L'angle posé sur une anse, en degrés, ou null. */
    angleOf: (el) => {
      const t = el.getAttribute('transform');
      if (!t) return null;
      const m = /rotate\((-?[\d.]+) ([\d.]+) ([\d.]+)\)/.exec(t);
      return m ? { deg: Number(m[1]), cx: Number(m[2]), cy: Number(m[3]) } : null;
    },
  };
}

/* ════════════════════════ Le relevé de la disposition ════════════════════════ */

console.log('\nLa barre balaie, et la maquette apparaît derrière elle\n');

{
  const s = mount();
  const top = s.cards.filter((c) => Number(c.getAttribute('y')) < 16);
  const bottom = s.cards.filter((c) => Number(c.getAttribute('y')) >= 16);

  s.save.fire('mouseenter');
  s.advance(16);

  const startY = Number(s.scan.getAttribute('y'));
  check('la barre part du haut de la disquette', startY < 6, `y = ${startY}`);
  check("  … et s'allume en entrant", Number(s.scan.style.opacity) > 0);
  check(
    "  … rien n'est encore relevé",
    s.cards.every((c) => Number(c.style.opacity) === 0),
    "la maquette n'existe pas avant le passage de la barre",
  );

  // Milieu du balayage : la rangée du haut est passée, celle du bas non.
  s.advance(430);
  const midY = Number(s.scan.getAttribute('y'));
  check('elle descend', midY > startY, `${startY} → ${midY.toFixed(2)}`);
  check(
    "  … la rangée du haut s'allume la première",
    top.every((c) => Number(c.style.opacity) > 0.4) && bottom.every((c) => Number(c.style.opacity) < 0.4),
    `haut ${Number(top[0].style.opacity).toFixed(2)}, ` + `bas ${Number(bottom[0].style.opacity).toFixed(2)}`,
  );

  s.advance(500);
  check(
    'au bout de la course, toute la maquette est là',
    s.cards.every((c) => Number(c.style.opacity) > 0.75),
  );
  check("  … et la barre s'est effacée", Number(s.scan.style.opacity) === 0);

  // Une fois relevée, la maquette respire au lieu de rester figée.
  const readings = [];
  for (let i = 0; i < 40; i++) {
    s.advance(40);
    readings.push(Number(s.cards[0].style.opacity));
  }
  const min = Math.min(...readings);
  const max = Math.max(...readings);
  check('la maquette respire', max - min > 0.03, `de ${min.toFixed(3)} à ${max.toFixed(3)}`);
  check("  … sans jamais s'éteindre", min > 0.6, `minimum ${min.toFixed(3)}`);
  check("  … et l'animation continue de tourner", s.pending() > 0);
}

console.log("\nQuand le pointeur s'en va\n");

{
  const s = mount();
  s.save.fire('mouseenter');
  s.advance(16);
  s.advance(1000);

  s.save.fire('mouseleave');
  // Une trame pour constater le départ, la suivante pour éteindre : le script
  // ne lit `saveHeld` qu'au moment où il peint.
  s.advance(16);
  s.advance(90);
  const fading = Number(s.cards[0].style.opacity);
  check("la maquette s'efface progressivement", fading > 0 && fading < 0.9, `opacité ${fading.toFixed(3)}`);

  for (let i = 0; i < 12; i++) s.advance(30);
  check(
    'le repos est rendu à la feuille de style',
    s.cards.every((c) => c.style.opacity === undefined && c.getAttribute('transform') === null),
    'aucune déclaration en ligne ne subsiste',
  );
  check(
    '  … et la barre revient à son point de départ',
    s.scan.getAttribute('y') === (SCAN ? SCAN.attrs.y : ''),
    s.scan.getAttribute('y'),
  );
  check('  … et plus rien ne tourne', s.pending() === 0);

  // Repartir doit relancer proprement, sans reprendre l'extinction.
  s.save.fire('mouseenter');
  s.advance(16);
  check('un nouveau survol repart du haut', Number(s.scan.getAttribute('y')) < 6);
}

console.log('\nLe clic tient la promesse du survol\n');

{
  const hover = mount();
  hover.save.fire('mouseenter');
  hover.advance(16);
  hover.advance(300);
  const hoverY = Number(hover.scan.getAttribute('y'));

  const click = mount();
  click.save.fire('mouseenter');
  click.save.fire('click');
  click.advance(16);
  click.advance(300);
  const clickY = Number(click.scan.getAttribute('y'));

  check(
    'le relevé cliqué va plus vite que le survol',
    clickY > hoverY,
    `${hoverY.toFixed(2)} au survol contre ${clickY.toFixed(2)} au clic`,
  );
  check("  … et l'onde part du bouton", click.save.classList.contains('header-pulse'));

  /*
   * La fin du balayage cliqué : la maquette sursaute. Le sommet du sursaut
   * est à mi-course d'une demi-sinusoïde — on suit donc plusieurs trames et
   * l'on retient la plus grande échelle vue, plutôt que de parier sur l'une
   * d'elles.
   */
  let biggest = 1;
  let centred = true;
  for (let i = 0; i < 14; i++) {
    click.advance(20);
    for (const c of click.cards) {
      const t = c.getAttribute('transform');
      if (!t) continue;
      const s = /scale\(([\d.]+)\)/.exec(t);
      if (s) biggest = Math.max(biggest, Number(s[1]));

      /*
       * Le sursaut agrandit autour du centre de chaque rectangle. Un
       * `transform` SVG part sinon de l'origine du repère, et les
       * enverrait en diagonale hors de l'étiquette au lieu de les gonfler
       * sur place.
       */
      const m = /^translate\(([\d.]+) ([\d.]+)\)/.exec(t);
      const cx = Number(c.getAttribute('x')) + Number(c.getAttribute('width')) / 2;
      const cy = Number(c.getAttribute('y')) + Number(c.getAttribute('height')) / 2;
      if (!m || Math.abs(Number(m[1]) - cx) > 0.01 || Math.abs(Number(m[2]) - cy) > 0.01) {
        centred = false;
      }
    }
  }

  check('  … la maquette sursaute une fois le relevé fini', biggest > 1.05, `échelle maximale ${biggest.toFixed(3)}`);
  check('  … chacun autour de son propre centre', centred);

  for (let i = 0; i < 20; i++) click.advance(30);
  check(
    '  … puis il se repose',
    click.cards.every((c) => c.getAttribute('transform') === null),
  );
}

{
  // Cliquer puis retirer le pointeur : le relevé va tout de même à son terme.
  // C'est la réponse à un geste ; l'interrompre laisserait croire à un échec.
  const s = mount();
  s.save.fire('mouseenter');
  s.save.fire('click');
  s.advance(16);
  s.save.fire('mouseleave');
  s.advance(200);
  s.advance(200);

  check(
    "un relevé cliqué s'achève même si le pointeur part",
    s.cards.every((c) => Number(c.style.opacity) > 0.75),
    "c'est la réponse à un geste, pas un décor de survol",
  );
}

/* ════════════════════════ Le cadenas ════════════════════════ */

console.log('\nLe cadenas penche vers ce que le clic ferait\n');

{
  const ouvert = mount({ locked: false });
  ouvert.lock.fire('mouseenter');
  ouvert.advance(16);
  ouvert.advance(200);

  const a = ouvert.angleOf(ouvert.shackle());
  check("ouvert, l'anse s'incline vers la fermeture", a && a.deg > 2, a ? `${a.deg.toFixed(2)}°` : 'aucune rotation');
  check('  … autour de la charnière, en (7, 11)', a && a.cx === 7 && a.cy === 11, a ? `${a.cx}, ${a.cy}` : '—');

  const ferme = mount({ locked: true });
  ferme.lock.fire('mouseenter');
  ferme.advance(16);
  ferme.advance(200);

  const b = ferme.angleOf(ferme.shackle());
  check(
    "fermé, elle tire au contraire vers l'ouverture",
    b && b.deg < -2,
    b ? `${b.deg.toFixed(2)}°` : 'aucune rotation',
  );

  check(
    "seule l'anse visible est animée",
    ferme.angleOf(ferme.openShackle) === null,
    'animer le glyphe caché ne se verrait jamais',
  );

  /*
   * Le penchant s'arrête avant l'autre état : il annonce le geste, il ne le
   * fait pas. Une anse qui irait au bout dirait que c'est déjà fait.
   */
  for (let i = 0; i < 30; i++) ouvert.advance(40);
  const held = ouvert.angleOf(ouvert.shackle());
  check("le penchant n'atteint jamais l'autre état", held && held.deg < 20, `${held.deg.toFixed(2)}° au repos tenu`);

  const sway = [];
  for (let i = 0; i < 40; i++) {
    ouvert.advance(40);
    sway.push(ouvert.angleOf(ouvert.shackle()).deg);
  }
  check(
    "  … et l'anse balance au lieu de rester figée",
    Math.max(...sway) - Math.min(...sway) > 0.5,
    `de ${Math.min(...sway).toFixed(2)}° à ${Math.max(...sway).toFixed(2)}°`,
  );
}

{
  const s = mount({ locked: false });
  s.lock.fire('mouseenter');
  s.advance(16);
  s.advance(400);
  s.lock.fire('mouseleave');

  for (let i = 0; i < 20; i++) s.advance(30);
  check(
    "le pointeur parti, l'anse revient et rend son repos",
    s.shackle().getAttribute('transform') === null && s.body().getAttribute('transform') === null,
  );
  check('  … et plus rien ne tourne', s.pending() === 0);
}

console.log("\nAu clic, l'anse claque\n");

{
  const s = mount({ locked: false });

  // Le tableau de bord échange les deux glyphes dans son propre écouteur ;
  // on le simule ici, puisque c'est exactement ce qui se passe au clic.
  s.lock.fire('click');
  s.applyLockState(true);

  check(
    "rien ne bouge avant que le glyphe n'ait changé",
    s.shutShackle.getAttribute('transform') === null,
    "le claquement est différé d'une trame",
  );

  // Une trame pour le report, la suivante pour la première image du ressort.
  s.advance(16);
  s.advance(16);

  const start = s.angleOf(s.shutShackle);
  check(
    "l'anse fermée part de la position de l'anse ouverte",
    start && start.deg < -15,
    start ? `${start.deg.toFixed(2)}°` : 'aucune rotation',
  );
  check("  … et l'onde part du bouton", s.lock.classList.contains('header-pulse'));
  check(
    "  … tandis que l'anse ouverte, désormais cachée, est rendue au repos",
    s.openShackle.getAttribute('transform') === null,
  );

  // Le ressort : elle traverse zéro, dépasse, et revient.
  const trace = [start.deg];
  let recoil = 0;
  for (let i = 0; i < 26; i++) {
    s.advance(16);
    const a = s.angleOf(s.shutShackle);
    if (a) trace.push(a.deg);
    const t = s.shutBody.getAttribute('transform');
    const m = t && /translate\(0 (-?[\d.]+)\)/.exec(t);
    if (m) recoil = Math.max(recoil, Math.abs(Number(m[1])));
  }

  check(
    "elle dépasse sa cible avant de s'y ranger",
    Math.max(...trace) > 1,
    `dépassement de ${Math.max(...trace).toFixed(2)}°`,
  );
  check(
    "  … en s'amortissant",
    Math.abs(trace[trace.length - 1]) < Math.abs(trace[0]) / 3,
    `${trace[0].toFixed(2)}° puis ${trace[trace.length - 1].toFixed(2)}°`,
  );
  check('  … et le corps encaisse le choc', recoil > 0.2, `contrecoup de ${recoil.toFixed(2)} unité(s)`);
}

{
  // Le pointeur est resté sur le bouton : le cadenas reprend son penchant,
  // mais dans l'autre sens — il annonce désormais le geste inverse.
  const s = mount({ locked: false });
  s.lock.fire('mouseenter');
  s.advance(16);
  s.lock.fire('click');
  s.applyLockState(true);
  for (let i = 0; i < 50; i++) s.advance(16);

  const after = s.angleOf(s.shutShackle);
  check(
    "une fois fermé, il annonce l'ouverture",
    after && after.deg < 0,
    after ? `${after.deg.toFixed(2)}°` : 'aucune rotation',
  );
}

{
  // Et dans l'autre sens : verrouillé, un clic déverrouille, et l'anse doit
  // partir de la position fermée pour paraître s'ouvrir.
  const s = mount({ locked: true });
  s.lock.fire('click');
  s.applyLockState(false);
  s.advance(16);
  s.advance(16);

  const start = s.angleOf(s.openShackle);
  check(
    "déverrouiller fait partir l'anse de la position fermée",
    start && start.deg > 15,
    start ? `${start.deg.toFixed(2)}°` : 'aucune rotation',
  );
}

/* ════════════════════════ Animations refusées ════════════════════════ */

console.log('\nQuand les animations sont refusées\n');

{
  const s = mount({ reduced: true });
  check(
    'le relevé ne pose aucun écouteur',
    s.save._listeners.mouseenter === undefined,
    'prefers-reduced-motion: reduce',
  );
  check('le cadenas non plus', s.lock._listeners.mouseenter === undefined);
  check(
    "  … et rien n'est peint",
    s.scan.style.opacity === undefined && s.shackle().getAttribute('transform') === null,
  );
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
