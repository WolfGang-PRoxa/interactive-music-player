/**
 * Vérifie le fondu du jour à la nuit — les jetons de css/base.css et le vrai
 * js/themeBlend.js, exécuté dans un DOM simulé.
 *
 * Le tableau de bord n'a plus deux thèmes mais un curseur entre les deux, ouvert
 * par un appui long sur le bouton jour/nuit. Quatre choses portent ce réglage,
 * et aucune ne se voit dans un diff.
 *
 *  - **Les pôles ne bougent pas.** Le fondu est une addition : à 0 % et à 100 %,
 *    le tableau de bord doit rendre exactement les deux palettes qu'il rendait
 *    avant. Un jeton recopié de travers ne se verrait qu'à l'usage, et sur un
 *    seul style.
 *
 *  - **Le texte ne se fond pas du tout : il bascule.** Un fond qui va du noir au
 *    blanc croise à mi-course un texte qui va du blanc au noir ; les deux sont
 *    gris au même instant, et le contraste tombe à 1,05. Une bande de
 *    transition étroite n'y change rien — ce n'est pas la vitesse de la
 *    traversée qui pose problème, c'est qu'elle ait lieu pendant celle du fond.
 *    Le texte prend donc franchement le parti du pôle dont le fond se
 *    rapproche, et le contraste mesuré remonte de 1,05 à 3,6.
 *
 *    C'est ce test qui l'a établi, en mesurant le contraste tout au long de la
 *    course : la première version fondait le texte, et passait.
 *
 *  - **Un seul calcul pour quatre styles.** Les propriétés personnalisées se
 *    substituent à l'emploi : le bloc de mélange est écrit une fois et va
 *    chercher la paire du style courant. Le recopier par style ferait quatre
 *    tables à tenir d'accord.
 *
 *  - **L'appui long n'est pas un clic.** Ouvrir le réglage fin ne doit pas
 *    basculer le thème du même geste, et une bascule ordinaire doit au
 *    contraire effacer le réglage fin — sans quoi un clic ferait passer de
 *    « 30 % de jour » à « 30 % de nuit ».
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CSS = fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'css', 'base.css'), 'utf8');
const MODALS = fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'css', 'modals.css'), 'utf8');
const MARKUP = fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'index.html'), 'utf8');
const SOURCE = fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'js', 'themeBlend.js'), 'utf8');

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

console.log('\n=== Le fondu du jour à la nuit ===\n');

/* ═══════════════ Les jetons ═══════════════ */

console.log('Les paires et leur mélange\n');

/** Les déclarations d'un bloc, par sélecteur. */
function blocks(css) {
  const out = {};
  const re = /(^|\n)((?:html\[[^\]]+\](?:\[[^\]]+\])?|:root)[^{]*)\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    const decls = {};
    for (const line of m[3].replace(/\/\*[\s\S]*?\*\//g, '').split(';')) {
      const kv = /^\s*(--[\w-]+)\s*:\s*(.+?)\s*$/.exec(line);
      if (kv) decls[kv[1]] = kv[2];
    }
    out[m[2].trim()] = Object.assign(out[m[2].trim()] || {}, decls);
  }
  return out;
}

const B = blocks(CSS);
const ROOTB = B[':root'] || {};

/** Les jetons de couleur que le bloc de calcul doit produire. */
const COLOUR_TOKENS = [
  'bg-main',
  'bg-card',
  'border-card',
  'border-card-hover',
  'c-primary',
  'c-accent',
  'c-violet',
  'c-success',
  'c-error',
  'bg-dropdown',
  'bg-select',
  'bg-hover',
];
const TEXT_TOKENS = ['text-main', 'text-muted', 'text-dark'];

const STYLES = {
  glassmorphism: ':root',
  'neon-cyberpunk': 'html[data-style="neon-cyberpunk"]',
  minimalist: 'html[data-style="minimalist"]',
  'retro-synthwave': 'html[data-style="retro-synthwave"]',
};

for (const [style, selector] of Object.entries(STYLES)) {
  const pairs = Object.assign({}, ROOTB, B[selector] || {});
  const missing = [...COLOUR_TOKENS, ...TEXT_TOKENS].filter(
    (tok) => !pairs['--night-' + tok] || !pairs['--day-' + tok],
  );
  check(
    `« ${style} » déclare ses deux versants`,
    missing.length === 0,
    missing.length ? `manque : ${missing.join(', ')}` : `${COLOUR_TOKENS.length + TEXT_TOKENS.length} paires`,
  );
}

/*
 * Le mélange est écrit une fois, dans `:root`, et va chercher la paire du style
 * courant. Un style qui le récrirait pour lui seul créerait une seconde table à
 * tenir d'accord avec la première.
 */
for (const [style, selector] of Object.entries(STYLES)) {
  if (selector === ':root') continue;
  const own = B[selector] || {};
  const recomputed = COLOUR_TOKENS.filter((tok) => own['--' + tok]);
  check(
    `« ${style} » ne récrit pas le mélange`,
    recomputed.length === 0,
    recomputed.length ? recomputed.join(', ') : 'il hérite du calcul unique',
  );
}

for (const tok of COLOUR_TOKENS) {
  const rule = ROOTB['--' + tok];
  if (!rule) {
    check(`« ${tok} » est calculé`, false, 'absent');
    continue;
  }
  check(
    `« ${tok} » se fond linéairement`,
    rule === `color-mix(in srgb, var(--day-${tok}) var(--blend-pct), var(--night-${tok}))`,
    rule.slice(0, 46) + '…',
  );
}

for (const tok of TEXT_TOKENS) {
  const rule = ROOTB['--' + tok] || '';
  check(`« ${tok} » bascule vite`, rule.includes('var(--text-pct)'), 'le texte ne peut pas croiser le fond au ralenti');
}

check(
  'le texte prend franchement parti à la moitié',
  /--text-pct:\s*clamp\(0%,\s*calc\(\(var\(--blend-pct\) - 50%\) \* 1000\),\s*100%\)/.test(CSS),
  'une bande de transition ne sauverait rien — voir le contraste mesuré plus bas',
);

check(
  "les longueurs et opacités s'interpolent, sans mélange de couleur",
  /--blur-val:\s*calc\(/.test(CSS) && /--decor-opacity:\s*calc\(/.test(CSS),
);
check(
  "l'ombre portée ne se mélange pas",
  !/--shadow-card:\s*color-mix/.test(CSS),
  "sa structure change d'un thème à l'autre : elle bascule au pôle",
);

check(
  "le repos suit l'interrupteur",
  ROOTB['--blend-pct'] === '0%' &&
    ROOTB['--blend'] === '0' &&
    (B['html[data-theme="light"]'] || {})['--blend-pct'] === '100%',
  'nuit à 0 %, jour à 100 %',
);

/* ═══════════════ Le contraste, tout au long de la course ═══════════════ */

console.log("\nCe que l'œil doit pouvoir lire\n");

function parseColour(value) {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const rgb = /rgba?\(([^)]+)\)/.exec(value);
  if (rgb) {
    const parts = rgb[1].split(',').map((p) => parseFloat(p));
    return [parts[0], parts[1], parts[2]];
  }
  return null;
}

const mix = (a, b, t) => a.map((v, i) => v * (1 - t) + b[i] * t);

/** Luminance relative, au sens de WCAG. */
function luminance([r, g, b]) {
  const f = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(fg, bg) {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** La bascule du texte, telle que la feuille de style la calcule. */
const textRatio = (blend) => Math.min(1, Math.max(0, ((blend * 100 - 50) * 1000) / 100));

for (const [style, selector] of Object.entries(STYLES)) {
  const pairs = Object.assign({}, ROOTB, B[selector] || {});
  const nightBg = parseColour(pairs['--night-bg-main']);
  const dayBg = parseColour(pairs['--day-bg-main']);
  const nightText = parseColour(pairs['--night-text-main']);
  const dayText = parseColour(pairs['--day-text-main']);
  if (!nightBg || !dayBg || !nightText || !dayText) {
    check(`« ${style} » : couleurs lisibles`, false, 'palette illisible');
    continue;
  }

  let worst = Infinity;
  let worstAt = 0;
  for (let i = 0; i <= 100; i++) {
    const blend = i / 100;
    const bg = mix(nightBg, dayBg, blend);
    const text = mix(nightText, dayText, textRatio(blend));
    const c = contrast(text, bg);
    if (c < worst) {
      worst = c;
      worstAt = i;
    }
  }

  /*
   * Le pire instant de toute la course, et il est transitoire : on le
   * traverse en déplaçant le curseur, on ne s'y arrête pas. Les deux pôles,
   * eux, gardent les contrastes d'origine.
   *
   * 2,8 plutôt que le 4,5 du seuil AA : à mi-chemin le fond est gris moyen,
   * et aucun texte ne peut y tenir 4,5 tout en restant celui d'un des deux
   * thèmes. Le cyberpunk est le plus juste des quatre — son texte de nuit est
   * un cyan saturé, clair par nature, qui se détache mal d'un gris.
   *
   * Ce chiffre valait 1,05 avant que le texte ne bascule franchement : c'est
   * cette mesure-là qui a montré qu'un fondu continu du texte était
   * intenable, quelle que soit sa vitesse.
   */
  check(
    `« ${style} » reste lisible d'un bout à l'autre`,
    worst >= 2.8,
    `contraste minimal ${worst.toFixed(2)} à ${worstAt} %`,
  );
}

/* ═══════════════ Les particules ═══════════════ */

console.log('\nLes teintes du chemin de particules\n');

/*
 * Elles ont leurs propres jetons plutôt que d'emprunter les accents de
 * l'interface : une couleur lisible sous un libellé ne fait pas forcément un
 * point de trois pixels visible sur le fond de la page.
 */
for (const [style, selector] of Object.entries(STYLES)) {
  const pairs = Object.assign({}, ROOTB, B[selector] || {});
  const missing = ['a', 'b', 'c'].filter((k) => !pairs[`--night-particle-${k}`] || !pairs[`--day-particle-${k}`]);
  check(
    `« ${style} » a ses trois teintes`,
    missing.length === 0,
    missing.length ? `manque : ${missing.join(', ')}` : 'nuit et jour',
  );
}

check(
  'elles se fondent comme le reste',
  ['a', 'b', 'c'].every(
    (k) =>
      ROOTB[`--particle-${k}`] ===
      `color-mix(in srgb, var(--day-particle-${k}) var(--blend-pct), var(--night-particle-${k}))`,
  ),
);

/*
 * Une particule doit se voir. Deux, ce n'est pas le seuil d'un texte — ce sont
 * des points décoratifs, pas des mots — mais c'est franchement au-dessus de
 * l'invisibilité, et cela suffit à condamner le gris que le minimaliste
 * empruntait autrefois à son propre fond.
 */
for (const [style, selector] of Object.entries(STYLES)) {
  const pairs = Object.assign({}, ROOTB, B[selector] || {});
  let worst = Infinity;
  let where = '';

  for (const pole of ['night', 'day']) {
    const bg = parseColour(pairs[`--${pole}-bg-main`]);
    for (const k of ['a', 'b', 'c']) {
      const tint = parseColour(pairs[`--${pole}-particle-${k}`]);
      if (!bg || !tint) continue;
      const c = contrast(tint, bg);
      if (c < worst) {
        worst = c;
        where = `${pole}/${k}`;
      }
    }
  }

  check(`  … et toutes se détachent du fond de « ${style} »`, worst >= 2, `au pire ${worst.toFixed(2)} (${where})`);
}

const PARTICLES = fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'js', 'particlePath.js'), 'utf8');

/*
 * Le défaut qui a fait disparaître les couleurs : `getPropertyValue` sur une
 * propriété personnalisée rend le texte sans l'évaluer, et depuis le fondu ce
 * texte est un `color-mix(…)`. Le canevas ne sait pas le lire — les quatre
 * styles retombaient donc tous sur les mêmes couleurs de repli.
 */
check(
  'les teintes sont résolues par une propriété typée',
  /colorProbe\.style\.color = expression;/.test(PARTICLES) && /getComputedStyle\(colorProbe\)\.color/.test(PARTICLES),
  '`color` évalue color-mix ; une propriété personnalisée, non',
);
check(
  '  … et non lues telles quelles sur la racine',
  !/styles\.getPropertyValue\('--c-/.test(PARTICLES),
  "c'est ce qui renvoyait les quatre styles sur le même repli",
);
check(
  '  … avec un repli qui reste coloré',
  /var\(\$\{name\}, var\(\$\{legacy\}, \$\{fallback\}\)\)/.test(PARTICLES),
  'une feuille de style en retard garde des particules, pas des points noirs',
);

check(
  "le minimaliste n'est plus amputé d'une teinte",
  /colors: \[a, b, c\]/.test(PARTICLES) && !/muted \? \[/.test(PARTICLES),
  'ses gris propres se voient, là où son violet se confondait avec le fond',
);
check('  … mais garde son absence de halo', /glow: muted \? 0 :/.test(PARTICLES));

/*
 * Et le défaut qui a réellement blanchi les particules.
 *
 * Un `color-mix` ne se calcule pas en `rgb()` mais dans l'espace nommé : le
 * navigateur en rend la notation moderne, `color(srgb 0.34 0.4 0.95)` —
 * composantes de 0 à 1, séparées par des espaces. La lecture de `toRGB`
 * attendait des virgules et des entiers ; elle n'y trouvait rien, et son repli
 * de dernier recours est le blanc.
 *
 * La fonction est extraite du fichier livré et éprouvée sur les formes qu'un
 * navigateur rend vraiment. C'est le seul endroit où ce bogue était visible :
 * ni la feuille de style ni le balisage n'en portent la trace.
 */
{
  const from = PARTICLES.indexOf('    function clamp(');
  const to = PARTICLES.indexOf('    function rgba(');
  const box = {
    document: {
      createElement: () => ({
        getContext: () => {
          let value = '#000000';
          return {
            // Le canevas garde sa valeur pour ce qu'il ne comprend
            // pas, et normalise le reste.
            set fillStyle(v) {
              if (/^#[0-9a-f]{6}$/i.test(v)) value = v.toLowerCase();
              else if (/^color\(|^rgba?\(/i.test(v)) value = v;
            },
            get fillStyle() {
              return value;
            },
          };
        },
      }),
    },
    Math,
    parseInt,
    console,
  };
  box.globalThis = box;
  vm.createContext(box);
  vm.runInContext(PARTICLES.slice(from, to), box);

  const CASES = [
    ['color(srgb 0.345098 0.396078 0.949020)', [88, 101, 242], "la forme d'un color-mix"],
    ['color(srgb 0 0.941176 1)', [0, 240, 255], 'le cyan du cyberpunk'],
    ['rgb(88 101 242)', [88, 101, 242], 'rgb() moderne, sans virgule'],
    ['rgb(88, 101, 242)', [88, 101, 242], 'rgb() à virgules'],
    ['#5865F2', [88, 101, 242], 'hex ordinaire'],
    ['color-mix(in srgb, #fff 50%, #000)', [88, 101, 242], 'texte non évalué : on retombe sur le repli'],
  ];

  for (const [input, expected, label] of CASES) {
    const got = box.toRGB(input, '#5865F2');
    const near = ['r', 'g', 'b'].every((k, i) => Math.abs(got[k] - expected[i]) <= 1);
    check(`toRGB lit ${label}`, near, `${Math.round(got.r)}, ${Math.round(got.g)}, ${Math.round(got.b)}`);
  }
}

/* ═══════════════ Le curseur, côté page ═══════════════ */

console.log('\nLe réglage fin dans la page\n');

check(
  'le bouton et son réglage partagent un ancrage',
  /<div class="theme-blend-anchor"/.test(MARKUP) &&
    MARKUP.indexOf('theme-blend-anchor') < MARKUP.indexOf('id="btn-theme-toggle"'),
  'un <input type="range"> dans un <button> verrait ses gestes pris pour des clics',
);
check(
  'le panneau est replié au repos',
  /<div class="header-pop theme-blend-pop" id="theme-blend-pop" hidden>/.test(MARKUP),
  '`hidden` : ni affiché, ni focalisable, ni lu',
);

/*
 * Le piège qui a fait rester le panneau ouvert en permanence.
 *
 * `hidden` ne vaut qu'un `display: none` de la feuille de style du navigateur,
 * que le moindre `display` d'auteur écrase — et celui-ci en a un. L'attribut
 * s'écrivait donc sans rien cacher, dès le chargement de la page.
 *
 * Le DOM simulé plus bas ne pouvait pas le voir : il traite `hidden` comme une
 * propriété, sans cascade. C'est une vérification de feuille de style, et elle
 * ne peut être que là.
 */
check(
  "  … et `hidden` l'emporte sur son propre display",
  /\.header-pop\[hidden\] \{[^}]*display: none;/.test(MODALS),
  'sans quoi le panneau ne se referme jamais',
);
check('le curseur va de la nuit au jour', /id="theme-blend-range"[\s\S]{0,120}?min="0" max="100"/.test(MARKUP));
check('le module est chargé', /<script src="js\/themeBlend\.js"><\/script>/.test(MARKUP));

/*
 * Le ressort n'est plus écrit ici : il appartient à `.header-pop`, que ce
 * panneau partage avec le sous-menu de GitHub — deux panneaux ouverts par le
 * même appui long doivent s'ouvrir de la même façon. Voir tests/githubMenu.js,
 * qui vérifie que ni l'un ni l'autre ne s'en refait une copie.
 */
check(
  "l'apparition rebondit",
  /animation: header-pop-in [\d.]+s cubic-bezier\(0\.34, 1\.56, 0\.64, 1\)/.test(MODALS),
  'le dépassement du ressort tient dans la courbe',
);
check(
  '  … depuis le bouton, pas depuis son propre centre',
  /\.header-pop \{[^}]*transform-origin: 50% 0;/.test(MODALS),
);
/*
 * Les images clés contiennent des accolades imbriquées : « [^}]* » s'arrête à
 * la première, c'est-à-dire au bout de l'image « 0 % ». Le bloc entier est donc
 * découpé, puis on compte.
 */
const popIn = (/@keyframes header-pop-in \{[\s\S]*?\n\}/.exec(MODALS) || [''])[0];
check(
  '  … en gardant son centrage à chaque image',
  popIn.split('translateX(-50%)').length - 1 === 2,
  "sans quoi le panneau se recentre d'un bond à la fin",
);
check(
  "la piste du curseur montre le trajet qu'elle commande",
  /\.theme-blend-range \{[^}]*linear-gradient\(to right, var\(--night-bg-main\), var\(--day-bg-main\)\)/.test(MODALS),
);

/* ═══════════════ Le comportement ═══════════════ */

function makeElement(tag) {
  const listeners = {};
  const classes = new Set();
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    hidden: false,
    value: '0',
    textContent: '',
    dataset: {},
    style: {
      _props: {},
      setProperty(k, v) {
        this._props[k] = v;
      },
      removeProperty(k) {
        delete this._props[k];
      },
      getPropertyValue(k) {
        return this._props[k] || '';
      },
    },
    _attrs: {},
    _classes: classes,
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      contains: (c) => classes.has(c),
    },
    setAttribute: (k, v) => {
      el._attrs[k] = String(v);
    },
    getAttribute: (k) => (k in el._attrs ? el._attrs[k] : null),
    /*
     * La phase est retenue : le module avale le clic qui suit un appui long
     * en écoutant *en capture*, donc avant l'écouteur de bascule d'app.js.
     * Un double qui ignorerait la phase et `stopPropagation` ne saurait pas
     * dire si le clic a bel et bien été arrêté — il verrait les deux
     * écouteurs se déclencher dans tous les cas.
     */
    addEventListener: (t, fn, opts) => {
      const capture = opts === true || (opts && opts.capture === true);
      (listeners[t] = listeners[t] || []).push({ fn, capture });
    },
    removeEventListener: (t, fn) => {
      if (listeners[t]) listeners[t] = listeners[t].filter((e) => e.fn !== fn);
    },
    appendChild: (c) => {
      el.children.push(c);
      return c;
    },
    contains: (n) => n === el || el.children.includes(n),
    focus: () => {
      el._focused = true;
    },
    fire: (t, ev = {}) => {
      let stopped = false;
      const event = Object.assign(
        {
          preventDefault() {},
          stopPropagation() {
            stopped = true;
          },
          target: el,
          clientX: 0,
          clientY: 0,
          button: 0,
        },
        ev,
      );

      const queue = (listeners[t] || []).slice().sort((a, b) => Number(b.capture) - Number(a.capture));
      for (const entry of queue) {
        if (stopped && !entry.capture) break;
        entry.fn(event);
      }
    },
    _listeners: listeners,
  };
  return el;
}

/** Monte le vrai module avec une horloge et un stockage sous la main. */
function mount({ theme = 'dark', saved = null } = {}) {
  const button = makeElement('button');
  const pop = makeElement('div');
  const range = makeElement('input');
  const readout = makeElement('span');
  pop.hidden = true;
  pop.appendChild(range);

  const root = makeElement('html');
  root.setAttribute('data-theme', theme);

  const store = new Map();
  if (saved !== null) store.set('appThemeBlend', String(saved));

  const known = {
    'btn-theme-toggle': button,
    'theme-blend-pop': pop,
    'theme-blend-range': range,
    'theme-blend-readout': readout,
  };

  const timers = [];
  const docListeners = {};
  const appearance = [];

  const sandbox = {
    window: {
      MusicPlayer: {
        t: (k) => k,
        applyThemeAppearance: (v) => appearance.push(v),
      },
    },
    document: {
      documentElement: root,
      getElementById: (id) => known[id] || null,
      addEventListener: (t, fn) => {
        (docListeners[t] = docListeners[t] || []).push(fn);
      },
    },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimeout: (id) => {
      if (timers[id - 1]) timers[id - 1].fn = null;
    },
    Math,
    Number,
    String,
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox);

  return {
    button,
    pop,
    range,
    readout,
    root,
    store,
    appearance,
    /** Déclenche les minuteries dont le délai est atteint. */
    runTimers: (upTo = Infinity) => {
      for (const timer of timers.slice()) {
        if (timer.fn && timer.ms <= upTo) {
          const f = timer.fn;
          timer.fn = null;
          f();
        }
      }
    },
    doc: (type, ev) =>
      (docListeners[type] || []).forEach((fn) =>
        fn(
          Object.assign(
            {
              target: makeElement('div'),
              preventDefault() {},
            },
            ev,
          ),
        ),
      ),
    blend: () => root.style.getPropertyValue('--blend-pct'),
    theme: () => root.getAttribute('data-theme'),
  };
}

console.log("\nL'appui long, et le clic qui ne l'est pas\n");

{
  const s = mount();
  check('le panneau est fermé au départ', s.pop.hidden === true);

  s.button.fire('pointerdown');
  check("  … et le reste tant qu'on n'a pas attendu", s.pop.hidden === true);

  s.runTimers();
  check("l'appui long l'ouvre", s.pop.hidden === false);

  // Le clic qui suit l'appui long est avalé : ouvrir ne doit pas basculer.
  let reached = false;
  s.button.addEventListener('click', () => {
    reached = true;
  });
  s.button.fire('click');
  check(
    '  … et le clic qui suit ne bascule rien',
    reached === false,
    "sinon le thème changerait au moment où l'on vient demander à ne plus basculer",
  );
}

{
  const s = mount({ saved: 30 });
  check(
    'un réglage enregistré est repris au chargement',
    s.blend() === '30%' && s.root.style.getPropertyValue('--blend') === '0.3',
    `${s.blend()} / ${s.root.style.getPropertyValue('--blend')}`,
  );
  check('  … et le pôle le plus proche suit', s.theme() === 'dark', "30 % de jour, c'est encore la nuit");

  // Un clic ordinaire efface le réglage fin : on a demandé un pôle.
  s.button.fire('pointerdown');
  s.button.fire('pointerup');
  s.button.fire('click');
  s.runTimers();
  check(
    'une bascule ordinaire rend les pôles francs',
    s.blend() === '' && s.store.get('appThemeBlend') === undefined,
    'sinon un clic ferait passer de « 30 % de jour » à « 30 % de nuit »',
  );
}

{
  const s = mount();
  s.button.fire('pointerdown');
  s.runTimers();

  for (const [value, pole] of [
    [0, 'dark'],
    [49, 'dark'],
    [50, 'light'],
    [100, 'light'],
  ]) {
    s.range.value = String(value);
    s.range.fire('input');
    check(`${value} % → ${pole}`, s.theme() === pole && s.blend() === `${value}%`, `${s.blend()}, ${s.theme()}`);
  }

  check('le réglage est retenu', s.store.get('appThemeBlend') === '100');
  check(
    "  … et l'habillage rejoué",
    s.appearance.includes('light'),
    "l'icône du bouton doit dire la même chose que le fond",
  );
}

{
  // Un doigt qui glisse n'est pas un appui maintenu : c'est un défilement.
  const s = mount();
  s.button.fire('pointerdown');
  s.button.fire('pointermove', { clientX: 40, clientY: 0 });
  s.runTimers();
  check(
    "un doigt qui glisse n'ouvre rien",
    s.pop.hidden === true,
    'sur écran tactile, ce serait un début de défilement',
  );
}

{
  const s = mount();
  s.button.fire('pointerdown');
  s.runTimers();
  check('ouvert', s.pop.hidden === false);

  s.doc('keydown', { key: 'Escape' });
  s.pop.fire('animationend');
  check('échap le referme', s.pop.hidden === true);
}

{
  // Un clic ailleurs referme, et ne laisse rien derrière lui.
  const s = mount();
  s.button.fire('pointerdown');
  s.runTimers();
  s.doc('pointerdown');
  s.pop.fire('animationend');
  check('un clic ailleurs referme', s.pop.hidden === true);

  /*
   * Et la bascule qui suit bascule pour de bon. Le drapeau qui sert à avaler
   * le clic d'ouverture restait levé après une fermeture par l'extérieur : le
   * clic suivant sur le bouton était avalé à son tour, et le thème ne
   * changeait pas.
   */
  let toggled = false;
  s.button.addEventListener('click', () => {
    toggled = true;
  });
  s.button.fire('pointerdown');
  s.button.fire('pointerup');
  s.button.fire('click');
  check(
    '  … et le clic suivant bascule vraiment',
    toggled === true,
    'le clic à avaler ne doit pas survivre à la fermeture',
  );
}

{
  // Le bouton referme ce qu'il a ouvert.
  const s = mount();
  s.button.fire('pointerdown');
  s.runTimers();

  // Le clic qui clôt l'appui long est avalé…
  s.button.fire('click');
  check("le panneau reste ouvert après le geste d'ouverture", s.pop.hidden === false);

  // …et le suivant referme, sans changer de thème.
  let toggled = false;
  s.button.addEventListener('click', () => {
    toggled = true;
  });
  s.button.fire('pointerdown');
  s.button.fire('pointerup');
  s.button.fire('click');
  s.pop.fire('animationend');
  check('un second clic sur le bouton le referme', s.pop.hidden === true);
  check(
    '  … sans basculer le thème au passage',
    toggled === false,
    "on rangeait le curseur et l'on changeait de thème",
  );
}

console.log("\nCe que l'infobulle annonce\n");

{
  /*
   * L'indice se déclare sur le bouton, et c'est l'infobulle qui l'ajoute au
   * libellé traduit au moment de s'afficher.
   *
   * Il était composé ici, dans `data-tooltip`, et n'atteignait jamais l'écran :
   * l'infobulle relit `data-i18n-tooltip` à chaque affichage et remplace le
   * libellé entier, `applyLanguage` le récrit à chaque changement de langue.
   * La phrase s'écrivait bien, et disparaissait deux fois plutôt qu'une.
   */
  check(
    "l'appui long est annoncé",
    /id="btn-theme-toggle"[^>]*data-tooltip-hint="tooltip_theme_blend_hint"/.test(MARKUP),
    "une fonctionnalité qu'on ne devine pas n'existe que pour qui l'a codée",
  );

  for (const lang of ['fr', 'en', 'es', 'de']) {
    const dict = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'locales', `${lang}.json`), 'utf8'),
    );
    const keys = ['tooltip_theme_blend_hint', 'theme_blend_night', 'theme_blend_day', 'theme_blend_mix'];
    const missing = keys.filter((k) => !dict[k]);
    check(
      `${lang} : les libellés du réglage sont traduits`,
      missing.length === 0,
      missing.length ? missing.join(', ') : dict.tooltip_theme_blend_hint,
    );
  }
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
