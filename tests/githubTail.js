/**
 * Vérifie l'ondulation de la queue du chat GitHub — le vrai
 * headerButtonAnimations.js, exécuté dans un DOM simulé.
 *
 * Ce qui sépare un serpent d'un essuie-glace tient en un mot : l'onde
 * **voyage**. Le même sinus appliqué partout fait balayer la queue autour d'un
 * axe, ce qui se reconnaît au premier coup d'œil et n'est pas ce qu'on a
 * demandé. Une onde propagée fait passer chaque portion par où la précédente
 * est passée, et la pointe suit le mouvement de la base avec du retard.
 *
 * Ce retard est la seule preuve qui compte, et c'est aussi la seule chose
 * qu'un signe inversé dans la phase détruirait sans rien casser d'autre :
 * l'onde remonterait alors vers le corps, ce qui s'anime tout aussi bien et ne
 * ressemble à rien. Le test le mesure donc, sur deux points assez proches pour
 * que le décalage soit lisible sans ambiguïté — deux points éloignés donnent un
 * retard voisin d'une demi-période, qu'on ne saurait plus distinguer d'une
 * avance.
 *
 * Le reste tient la queue en place : la base est prise dans le corps du chat et
 * ne doit pas bouger, la pointe est libre et doit balayer, et le logo au repos
 * doit retrouver son tracé d'origine au caractère près plutôt que de garder
 * l'empreinte de l'animation.
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'js', 'headerButtonAnimations.js'), 'utf8');
const MARKUP = fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'index.html'), 'utf8');

/** Le tracé d'origine, tel qu'il était avant d'être coupé en deux. */
const REST_D = 'M9 19c-5 1.5-5-2.5-7-3';

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

/** Élément factice : juste ce que le module touche. */
function makeElement(id) {
  const listeners = {};
  const attrs = {};
  return {
    id,
    style: {
      cssText: '',
      display: 'none',
      setProperty(n, v) {
        this[n] = v;
      },
    },
    addEventListener: (type, fn) => {
      listeners[type] = fn;
    },
    removeEventListener: (type) => {
      delete listeners[type];
    },
    setAttribute: (n, v) => {
      attrs[n] = v;
    },
    getAttribute: (n) => attrs[n],
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 18, height: 18 }),
    querySelector: () => null,
    querySelectorAll: () => [],
    appendChild() {},
    _listeners: listeners,
    _attrs: attrs,
  };
}

/**
 * Points effectivement sur la courbe, extraits du tracé.
 *
 * Le module rend un « M » suivi de cubiques : le point d'arrivée de chaque
 * cubique est un des points d'échantillonnage, les deux autres paires sont des
 * tangentes qui ne passent nulle part.
 */
function onCurvePoints(d) {
  const nums = (d.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
  const pts = [{ x: nums[0], y: nums[1] }];
  for (let i = 2; i + 5 < nums.length; i += 6) {
    pts.push({ x: nums[i + 4], y: nums[i + 5] });
  }
  return pts;
}

/**
 * Générateur pseudo-aléatoire déterministe (mulberry32).
 *
 * Le module tire au sort ses angles et ses attentes, ce qui est tout le sujet —
 * mais une suite de tests ne doit pas dépendre du tirage. Une première version
 * de ce fichier exigeait que quatre angles soient tous distincts au centième :
 * elle est tombée sur une collision au bout de quelques exécutions, et
 * n'éprouvait de toute façon que l'espacement du générateur.
 *
 * La graine rend chaque exécution identique à la précédente ; les propriétés
 * vérifiées plus bas portent sur l'étendue des valeurs, non sur leur unicité.
 */
function makePrng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mountTail({ reduced = false, seed = 20260829 } = {}) {
  const tail = makeElement('gh-tail');
  tail.setAttribute('d', REST_D);
  const head = makeElement('gh-head');
  head.removeAttribute = (n) => {
    delete head._attrs[n];
  };

  const button = makeElement('btn-github');
  button.querySelector = (sel) => {
    if (sel === '.gh-tail') return tail;
    if (sel === '.gh-head') return head;
    return null;
  };

  const rafQueue = [];
  const canvasStub = {
    style: {},
    width: 0,
    height: 0,
    getContext: () => ({
      setTransform() {},
      clearRect() {},
      beginPath() {},
      fill() {},
      arc() {},
      createRadialGradient: () => ({ addColorStop() {} }),
    }),
  };

  const sandbox = {
    window: {
      MusicPlayer: {},
      addEventListener() {},
      matchMedia: () => ({ matches: reduced }),
      devicePixelRatio: 1,
    },
    document: {
      getElementById: (id) => (id === 'btn-github' ? button : null),
      createElement: () => canvasStub,
      documentElement: { getAttribute: () => 'dark' },
      body: { appendChild() {} },
      querySelector: () => null,
    },
    requestAnimationFrame: (fn) => {
      rafQueue.push(fn);
      return rafQueue.length;
    },
    cancelAnimationFrame() {},
    performance: { now: () => 0 },
    Math: Object.assign(Object.create(Math), { random: makePrng(seed) }),
    Uint8Array,
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox);

  let clock = 0;
  /** Joue n images de 16 ms et rend la suite des tracés produits. */
  const advance = (frames) => {
    const out = [];
    for (let i = 0; i < frames; i++) {
      const fn = rafQueue.shift();
      if (!fn) break;
      clock += 16;
      fn(clock);
      out.push(tail.getAttribute('d'));
    }
    return out;
  };

  /** L'angle porté par la tête, en degrés, ou 0 si elle est droite. */
  const headAngle = () => {
    const t = head.getAttribute('transform');
    if (!t) return 0;
    const m = /rotate\(\s*(-?[\d.]+)/.exec(t);
    return m ? Number(m[1]) : 0;
  };

  return {
    tail,
    head,
    headAngle,
    button,
    advance,
    pending: () => rafQueue.length,
    enter: () => button._listeners.mouseenter(),
    leave: () => button._listeners.mouseleave(),
  };
}

/**
 * Instant du premier maximum d'une série, en images.
 *
 * La moyenne est retirée d'abord : seule la forme de l'oscillation nous
 * intéresse, pas la position au repos autour de laquelle elle se fait.
 */
function firstPeakIndex(series) {
  const mean = series.reduce((t, v) => t + v, 0) / series.length;
  const centred = series.map((v) => v - mean);
  for (let i = 1; i < centred.length - 1; i++) {
    if (centred[i] > 0 && centred[i] >= centred[i - 1] && centred[i] > centred[i + 1]) {
      return i;
    }
  }
  return -1;
}

console.log('\n=== La queue du chat GitHub ===\n');

// ───────────────────────── Le découpage du logo ─────────────────────────

console.log('Le découpage du logo\n');

{
  const tailMatch = /<path class="gh-tail" d="([^"]+)"/.exec(MARKUP);
  const legsMatch = /<path class="gh-legs" d="([^"]+)"/.exec(MARKUP);
  const headMatch = /<path class="gh-head" d="([^"]+)"/.exec(MARKUP);

  check('la queue est un tracé à elle seule', !!tailMatch, tailMatch ? tailMatch[1] : 'absente');
  check('les pattes sont un tracé à elles seules', !!legsMatch);
  check('la tête est un tracé à elle seule', !!headMatch);

  if (tailMatch) {
    check('la queue garde son tracé d’origine', tailMatch[1] === REST_D, tailMatch[1]);
  }

  /*
   * Les invariants du découpage. Le tracé d'origine passait par ces points ;
   * chaque morceau doit repartir exactement d'où le précédent s'arrête. C'est
   * très précisément ce qu'une coupure bâclée déplacerait — de quoi décoller
   * la tête des épaules de quelques dixièmes, sans que rien ne le signale
   * puisque le trait est large et que le rendu resterait presque juste.
   */
  if (legsMatch) {
    const tailEnd = { x: 9 - 7, y: 19 - 3 };
    const legsStart = /^M([\d.-]+)\s+([\d.-]+)/.exec(legsMatch[1]);
    check(
      'les pattes repartent d’où le « m 14 6 » relatif tombait',
      !!legsStart && Number(legsStart[1]) === tailEnd.x + 14 && Number(legsStart[2]) === tailEnd.y + 6,
      legsStart ? `M${legsStart[1]} ${legsStart[2]}, attendu M${tailEnd.x + 14} ${tailEnd.y + 6}` : 'illisible',
    );

    // Épaule droite : 16,18.13 plus le déplacement relatif -0.94,-2.61 de
    // l'arc qui la contourne. Épaule gauche : 3.5,8.55 plus le 6.44,7 de la
    // cubique qui remonte le flanc.
    const RIGHT = { x: 15.06, y: 15.52 };
    const LEFT = { x: 9.94, y: 15.55 };

    const legsSecond = /M([\d.-]+)\s+([\d.-]+)A/.exec(legsMatch[1].slice(1));
    check(
      'les pattes reprennent à l’épaule gauche',
      !!legsSecond && Number(legsSecond[1]) === LEFT.x && Number(legsSecond[2]) === LEFT.y,
      legsSecond ? `${legsSecond[1]},${legsSecond[2]}` : 'illisible',
    );

    if (headMatch) {
      const headStart = /^M([\d.-]+)\s+([\d.-]+)/.exec(headMatch[1]);
      check(
        'la tête part de l’épaule droite',
        !!headStart && Number(headStart[1]) === RIGHT.x && Number(headStart[2]) === RIGHT.y,
        headStart ? `${headStart[1]},${headStart[2]}, attendu ${RIGHT.x},${RIGHT.y}` : 'illisible',
      );

      // Elle finit sur la dernière cubique relative, c0 5.42 3.3 6.61 6.44 7,
      // partie de 3.5,8.55 — soit l'épaule gauche.
      check(
        '  … et arrive à l’épaule gauche',
        /c0 5\.42 3\.3 6\.61 6\.44 7$/.test(headMatch[1]),
        headMatch[1].slice(-24),
      );

      // Le pivot doit être à mi-chemin des deux, sans quoi la jointure
      // s'ouvre dès que la tête tourne.
      const PIVOT = { x: 12.5, y: 15.54 };
      check(
        'la nuque est bien au milieu des deux épaules',
        Math.abs((RIGHT.x + LEFT.x) / 2 - PIVOT.x) < 0.01 && Math.abs((RIGHT.y + LEFT.y) / 2 - PIVOT.y) < 0.02,
        `milieu ${((RIGHT.x + LEFT.x) / 2).toFixed(2)},${((RIGHT.y + LEFT.y) / 2).toFixed(3)}`,
      );
    }
  }
}

// ─────────────────────────── L'onde voyage ───────────────────────────

console.log('\nL’onde\n');

{
  const s = mountTail();
  s.enter();

  // L'amplitude s'installe d'abord : mesurer pendant sa montée mêlerait
  // l'enflement au déplacement, et les maximums s'en trouveraient décalés.
  s.advance(140);

  const frames = s.advance(220).map(onCurvePoints);
  check(
    'la queue est réécrite à chaque image',
    frames.length === 220 && frames[0].length === 14,
    `${frames.length} images, ${frames[0] ? frames[0].length : 0} points`,
  );

  // La normale de la queue est majoritairement verticale — sa tangente va
  // vers la gauche —, si bien que l'ordonnée d'un point suit fidèlement son
  // déplacement perpendiculaire.
  const seriesAt = (k) => frames.map((f) => f[k].y);

  const nearBase = firstPeakIndex(seriesAt(9));
  const nearTip = firstPeakIndex(seriesAt(12));

  check('un point proche de la base atteint son maximum', nearBase > 0, `image ${nearBase}`);
  check('un point plus loin l’atteint aussi', nearTip > 0, `image ${nearTip}`);

  /*
   * Le retard attendu : les deux points sont séparés de 3/13 de la longueur,
   * l'onde compte 0,85 longueur d'onde sur la queue et met 3 s à la parcourir.
   * Soit 0,85 × 3/13 × 3 s ≈ 0,59 s, ou 37 images de 16 ms.
   */
  const lag = nearTip - nearBase;
  check('la pointe suit la base, elle ne la devance pas', lag > 0, `${lag} images de retard`);
  check('  … du retard qu’une onde qui voyage impose', lag > 22 && lag < 52, `${lag} images, attendu ~37`);
}

// ──────────────────────── L'enveloppe de la queue ────────────────────────

console.log('\nL’amplitude le long de la queue\n');

{
  const s = mountTail();
  s.enter();
  s.advance(140);

  const frames = s.advance(200).map(onCurvePoints);
  const swing = (k) => {
    const ys = frames.map((f) => f[k].y);
    const xs = frames.map((f) => f[k].x);
    return Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  };

  check('la base reste prise dans le corps du chat', swing(0) < 0.05, `${swing(0).toFixed(3)} unité(s) de débattement`);
  check('la pointe balaye', swing(13) > 1.5, `${swing(13).toFixed(2)} unité(s)`);
  check(
    'le débattement croît vers la pointe',
    swing(4) < swing(9) && swing(9) < swing(13),
    `${swing(4).toFixed(2)} < ${swing(9).toFixed(2)} < ${swing(13).toFixed(2)}`,
  );
}

// ─────────────────────────── Le penchement de tête ───────────────────────────

console.log('\nLe penchement de tête\n');

/**
 * Relève les penchements d'une session : angle maximal et instant de chacun.
 *
 * Un penchement se reconnaît à un angle qui monte puis retombe à zéro. On les
 * sépare donc aux retours à la verticale.
 */
function collectTilts(session, frames) {
  const tilts = [];
  let cur = null;
  for (let i = 0; i < frames; i++) {
    session.advance(1);
    const a = session.headAngle();
    if (a > 0.01) {
      if (!cur) cur = { onset: i, peak: 0, at: -1, lastHigh: i };
      if (a > cur.peak) {
        cur.peak = a;
        cur.at = i;
      }
      // Dernière image encore au sommet : c'est de là que part le
      // redressement, le maintien s'y tenant à l'angle exact.
      if (a >= cur.peak * 0.98) cur.lastHigh = i;
      cur.end = i;
    } else if (cur) {
      cur.rise = cur.at - cur.onset;
      cur.fall = cur.end - cur.lastHigh;
      tilts.push(cur);
      cur = null;
    }
  }
  return tilts;
}

{
  // Une trentaine de secondes : un cycle complet dure entre 3,9 et 9 s, on en
  // voit donc plusieurs, ce qu'il faut pour parler de hasard.
  const s = mountTail();
  s.enter();
  const tilts = collectTilts(s, 1900);

  check('la tête se penche plusieurs fois', tilts.length >= 3, `${tilts.length} penchement(s)`);

  const angles = tilts.map((t) => t.peak);
  check(
    'elle penche toujours vers la droite',
    angles.every((a) => a > 0),
    `angles : ${angles.map((a) => a.toFixed(1)).join(', ')}`,
  );
  check(
    'légèrement, et jamais au-delà de la butée',
    angles.every((a) => a <= 11),
    `maximum ${Math.max(...angles).toFixed(2)}°, butée 9° plus le dépassement`,
  );
  check(
    '  … ni en deçà du seuil visible',
    angles.every((a) => a >= 4.5),
    `minimum ${Math.min(...angles).toFixed(2)}°`,
  );

  // Le hasard : ni deux angles identiques, ni deux attentes identiques.
  const spread = Math.max(...angles) - Math.min(...angles);
  check(
    'les penchements n’ont pas tous le même angle',
    spread > 0.5,
    `${spread.toFixed(2)}° entre le plus et le moins incliné`,
  );

  const gaps = tilts.slice(1).map((t, i) => t.at - tilts[i].at);
  const gapSpread = gaps.length ? Math.max(...gaps) - Math.min(...gaps) : 0;
  check(
    'ils ne reviennent pas à intervalle fixe',
    gaps.length > 1 && gapSpread > 20,
    `intervalles : ${gaps.join(', ')} images`,
  );

  /*
   * La signature d'un geste vivant : on se penche vite, on se redresse
   * lentement. Les deux durées symétriques donneraient un va-et-vient de
   * machine, et rien d'autre dans le code ne l'empêcherait.
   *
   * La montée est mesurée de l'amorce au sommet, le retour de la dernière
   * image encore au sommet — fin du maintien — jusqu'à la verticale.
   */
  const rises = tilts.map((t) => t.rise).filter((v) => v > 0);
  const falls = tilts.map((t) => t.fall).filter((v) => v > 0);
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  check(
    'elle se penche plus vite qu’elle ne se redresse',
    rises.length > 0 && falls.length > 0 && mean(falls) > mean(rises) * 1.5,
    `${mean(rises).toFixed(0)} images pour se pencher, ${mean(falls).toFixed(0)} pour se redresser`,
  );
}

{
  // Le pivot doit être la nuque à chaque image : pivoter ailleurs ouvrirait
  // la jointure des épaules, ce qu'aucune capture d'écran ne montrerait
  // clairement à cette taille.
  const s = mountTail();
  s.enter();

  // Une image où la tête est effectivement penchée : la vérification n'aurait
  // aucune valeur sur un « rotate(0 …) », que n'importe quel pivot satisfait.
  let tilted = null;
  for (let i = 0; i < 1900 && !tilted; i++) {
    s.advance(1);
    if (s.headAngle() > 1) tilted = s.head.getAttribute('transform');
  }

  check(
    'la rotation a la nuque pour centre',
    !!tilted && /rotate\([^)]*\s12\.5\s15\.54\)/.test(tilted),
    tilted || 'aucune inclinaison observée',
  );
}

// ────────────────────────── Le retour au repos ──────────────────────────

console.log('\nLe retour au repos\n');

{
  const s = mountTail();
  s.enter();
  s.advance(140);
  const moving = s.tail.getAttribute('d');
  check('la queue ne porte plus son tracé d’origine pendant l’animation', moving !== REST_D);

  s.leave();
  const settling = s.advance(20);
  check('elle ne s’immobilise pas net', settling[settling.length - 1] !== REST_D, 'elle s’apaise encore');

  s.advance(900);
  check(
    'elle retrouve son tracé d’origine au caractère près',
    s.tail.getAttribute('d') === REST_D,
    s.tail.getAttribute('d'),
  );
  check(
    'la tête ne porte plus aucune transformation',
    s.head.getAttribute('transform') === undefined,
    s.head.getAttribute('transform') || 'aucune',
  );
  check('  … et la boucle s’arrête', s.pending() === 0, `${s.pending()} image(s) programmée(s)`);
}

// ────────────────────────── Le mouvement réduit ──────────────────────────

console.log('\nLe mouvement réduit\n');

{
  const s = mountTail({ reduced: true });
  check(
    'aucun écouteur n’est posé sur le bouton',
    Object.keys(s.button._listeners).length === 0,
    Object.keys(s.button._listeners).join(', ') || 'aucun',
  );
  check('la queue garde son tracé d’origine', s.tail.getAttribute('d') === REST_D);
  check(
    'la tête reste droite',
    s.head.getAttribute('transform') === undefined,
    s.head.getAttribute('transform') || 'aucune',
  );
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed === 0 ? 0 : 1);
