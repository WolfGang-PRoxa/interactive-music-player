/**
 * Vérifie la logique de deviceMode.js — le vrai fichier, exécuté dans un DOM
 * simulé. Ce module décide de la mise en page et de l'activation du tactile :
 * une erreur de détection y est invisible tant qu'on ne change pas d'appareil.
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'public', 'js', 'deviceMode.js'), 'utf8');

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

/**
 * Exécute deviceMode.js dans un environnement contrôlé.
 *
 * `height` et `touchPoints` sont dissociés du reste à dessein : la détection
 * repose sur le côté court de la fenêtre, et sur les points de contact quand le
 * navigateur annonce un pointeur fin. Les laisser déduits de `coarse` et de
 * `width` rendrait justement ces deux cas intestables.
 *
 * `orientation` simule `screen.orientation`. Absent, l'objet n'existe pas du
 * tout — c'est le cas des navigateurs qui ne l'exposent pas, et le module doit
 * alors se taire plutôt que de deviner.
 *
 * @param {{coarse: boolean, width: number, height?: number,
 *          touchPoints?: number, stored?: string,
 *          orientation?: {angle: number, type: string}}} env
 */
function load(env) {
  const attrs = {};
  const storage = new Map();
  if (env.stored !== undefined) storage.set('music_player_device_mode', env.stored);

  const height = env.height === undefined ? 900 : env.height;
  const touchList = env.touchPoints === undefined ? (env.coarse ? 5 : 0) : env.touchPoints;

  const fakeScreen = { width: env.width, height };
  if (env.orientation) {
    fakeScreen.orientation = {
      angle: env.orientation.angle,
      type: env.orientation.type,
      addEventListener() {},
    };
  }

  const fakeWindow = {
    matchMedia: (q) => ({ matches: q.includes('coarse') ? env.coarse : false }),
    innerWidth: env.width,
    innerHeight: height,
    addEventListener() {},
    screen: fakeScreen,
  };

  const context = {
    window: fakeWindow,
    document: {
      documentElement: {
        setAttribute: (k, v) => {
          attrs[k] = v;
        },
        removeAttribute: (k) => {
          delete attrs[k];
        },
      },
    },
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
    },
    navigator: { maxTouchPoints: touchList },
    screen: { width: env.width, height: height },
    console,
    setTimeout,
    clearTimeout,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(SOURCE, context);

  return { api: fakeWindow.MusicPlayer.deviceMode, attrs, storage };
}

console.log('deviceMode — automatic detection\n');

let r = load({ coarse: true, width: 390 });
check('phone: coarse pointer + 390 px', r.api.get() === 'phone', r.api.get());
check('  data-device-mode attribute set', r.attrs['data-device-mode'] === 'phone');
check('  data-touch-mode attribute at true', r.attrs['data-touch-mode'] === 'true');
check('  isTouch() vrai', r.api.isTouch() === true);

r = load({ coarse: true, width: 1024 });
check('tablet: coarse pointer + 1024 px', r.api.get() === 'tablet', r.api.get());
check('  isTouch() vrai', r.api.isTouch() === true);

r = load({ coarse: false, width: 1920 });
check('desktop: fine pointer', r.api.get() === 'desktop', r.api.get());
check('  data-touch-mode at false', r.attrs['data-touch-mode'] === 'false');
check('  isTouch() faux', r.api.isTouch() === false);

r = load({ coarse: false, width: 500 });
check('narrow window but a mouse: stays desktop', r.api.get() === 'desktop', r.api.get());

console.log('\ndeviceMode — orientation and devices that misreport themselves\n');

// Un téléphone couché est plus large qu'une petite tablette debout : au seul
// critère de largeur il passait en mode tablette, qui n'adapte pas l'en-tête.
r = load({ coarse: true, width: 1200, height: 460 });
check('phone lying down: 1200 × 460', r.api.get() === 'phone', r.api.get());

r = load({ coarse: true, width: 390, height: 840 });
check('phone upright: 390 × 840', r.api.get() === 'phone', r.api.get());

r = load({ coarse: true, width: 820, height: 1180 });
check('tablette debout : 820 × 1180', r.api.get() === 'tablet', r.api.get());

r = load({ coarse: true, width: 1180, height: 820 });
check('tablet lying down: 1180 × 820', r.api.get() === 'tablet', r.api.get());

// Navigateur mobile qui annonce un pointeur fin — mode « site pour ordinateur »
// ou absence de réponse à `pointer`. La fenêtre trahit l'appareil.
r = load({ coarse: false, touchPoints: 5, width: 1200, height: 460 });
check('fine pointer announced but screen lying down and touch-capable', r.api.get() === 'phone', r.api.get());

// Le garde-fou : un portable à écran tactile a lui aussi des points de contact.
r = load({ coarse: false, touchPoints: 10, width: 1440, height: 780 });
check('laptop with a touch screen: stays desktop', r.api.get() === 'desktop', r.api.get());

r = load({ coarse: false, touchPoints: 10, width: 1920, height: 620 });
check('  short but wide window on a touch laptop', r.api.get() === 'desktop', r.api.get());

console.log('\ndeviceMode — choix explicite\n');

r = load({ coarse: false, width: 1920, stored: 'phone' });
check('remembered choice « phone » wins over detection', r.api.get() === 'phone', r.api.get());
check('  getChoice() returns the choice, not the mode', r.api.getChoice() === 'phone');
check('  detected() always returns the raw detection', r.api.detected() === 'desktop', r.api.detected());

r = load({ coarse: true, width: 390, stored: 'desktop' });
check('« desktop » forced on a phone', r.api.get() === 'desktop', r.api.get());
check('  touch disabled accordingly', r.api.isTouch() === false);

r = load({ coarse: true, width: 390, stored: 'valeur-invalide' });
check('unreadable value ignored, back to auto', r.api.getChoice() === 'auto' && r.api.get() === 'phone');

console.log('\ndeviceMode — set() and persistence\n');

r = load({ coarse: false, width: 1920 });
check('set("tablet") accepted', r.api.set('tablet') === true);
check('  mode applied', r.api.get() === 'tablet', r.api.get());
check('  written to localStorage', r.storage.get('music_player_device_mode') === 'tablet');
check('set("anything_at_all") refused', r.api.set('n_importe_quoi') === false);
check('  mode unchanged after refusal', r.api.get() === 'tablet');
check('back to auto', r.api.set('auto') === true && r.api.get() === 'desktop', r.api.get());

console.log('\ndeviceMode — abonnement\n');

r = load({ coarse: false, width: 1920 });
let received = [];
r.api.onChange((mode, previous) => received.push(`${previous}->${mode}`));
r.api.set('phone');
r.api.set('phone');
r.api.set('desktop');
check('one event per real change', received.length === 2, received.join(', '));

/*
 * Côté de l'encoche.
 *
 * La déduction repose sur deux hypothèses — appareil né en portrait, encoche
 * sur son bord haut — et sert à *réduire* une marge de sécurité. Se tromper
 * découvrirait donc l'encoche : mieux vaut ne rien dire que dire faux, et c'est
 * ce silence-là que ces cas vérifient d'abord.
 */
console.log('\ndeviceMode — notch side\n');

r = load({ coarse: true, width: 390 });
check('without screen.orientation, no deduction', r.attrs['data-notch'] === undefined, String(r.attrs['data-notch']));

r = load({ coarse: true, width: 390, orientation: { angle: 0, type: 'portrait-primary' } });
check('upright portrait: notch at the top', r.attrs['data-notch'] === 'top', r.attrs['data-notch']);

r = load({ coarse: true, width: 390, orientation: { angle: 180, type: 'portrait-secondary' } });
check('upside-down portrait: notch at the bottom', r.attrs['data-notch'] === 'bottom', r.attrs['data-notch']);

r = load({ coarse: true, width: 844, height: 390, orientation: { angle: 90, type: 'landscape-primary' } });
check('lying at 90°: notch on one side edge', r.attrs['data-notch'] === 'left', r.attrs['data-notch']);

r = load({ coarse: true, width: 844, height: 390, orientation: { angle: 270, type: 'landscape-secondary' } });
check('lying at 270°: notch on the opposite edge', r.attrs['data-notch'] === 'right', r.attrs['data-notch']);

// Une tablette née en paysage est droite à 0° tout en étant couchée. L'hypothèse
// « encoche en haut du portrait » n'y a plus de sens : le module doit se taire.
r = load({ coarse: true, width: 1180, height: 820, orientation: { angle: 0, type: 'landscape-primary' } });
check('device born in landscape: no deduction', r.attrs['data-notch'] === undefined, String(r.attrs['data-notch']));

r = load({ coarse: true, width: 390, orientation: { angle: 45, type: 'portrait-primary' } });
check(
  'angle outside the four quarters: no deduction',
  r.attrs['data-notch'] === undefined,
  String(r.attrs['data-notch']),
);

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
