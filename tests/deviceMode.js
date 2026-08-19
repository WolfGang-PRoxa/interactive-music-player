/**
 * Vérifie la logique de deviceMode.js — le vrai fichier, exécuté dans un DOM
 * simulé. Ce module décide de la mise en page et de l'activation du tactile :
 * une erreur de détection y est invisible tant qu'on ne change pas d'appareil.
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const SOURCE = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'web', 'public', 'js', 'deviceMode.js'),
    'utf8'
);

let failed = 0;
let passed = 0;
const check = (label, ok, detail = '') => {
    if (ok) { passed++; console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`); }
    else { failed++; console.log(`  ECHEC ${label}${detail ? ` — ${detail}` : ''}`); }
};

/**
 * Exécute deviceMode.js dans un environnement contrôlé.
 *
 * `height` et `touchPoints` sont dissociés du reste à dessein : la détection
 * repose sur le côté court de la fenêtre, et sur les points de contact quand le
 * navigateur annonce un pointeur fin. Les laisser déduits de `coarse` et de
 * `width` rendrait justement ces deux cas intestables.
 *
 * @param {{coarse: boolean, width: number, height?: number,
 *          touchPoints?: number, stored?: string}} env
 */
function load(env) {
    const attrs = {};
    const storage = new Map();
    if (env.stored !== undefined) storage.set('music_player_device_mode', env.stored);

    const height = env.height === undefined ? 900 : env.height;
    const touchList = env.touchPoints === undefined ? (env.coarse ? 5 : 0) : env.touchPoints;

    const fakeWindow = {
        matchMedia: (q) => ({ matches: q.includes('coarse') ? env.coarse : false }),
        innerWidth: env.width,
        innerHeight: height,
        addEventListener() {},
    };

    const context = {
        window: fakeWindow,
        document: { documentElement: { setAttribute: (k, v) => { attrs[k] = v; } } },
        localStorage: {
            getItem: (k) => (storage.has(k) ? storage.get(k) : null),
            setItem: (k, v) => storage.set(k, String(v)),
        },
        navigator: { maxTouchPoints: touchList },
        screen: { width: env.width, height: height },
        console,
        setTimeout, clearTimeout,
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(SOURCE, context);

    return { api: fakeWindow.MusicPlayer.deviceMode, attrs, storage };
}

console.log('deviceMode — détection automatique\n');

let r = load({ coarse: true, width: 390 });
check('téléphone : pointeur grossier + 390 px', r.api.get() === 'phone', r.api.get());
check('  attribut data-device-mode posé', r.attrs['data-device-mode'] === 'phone');
check('  attribut data-touch-mode à true', r.attrs['data-touch-mode'] === 'true');
check('  isTouch() vrai', r.api.isTouch() === true);

r = load({ coarse: true, width: 1024 });
check('tablette : pointeur grossier + 1024 px', r.api.get() === 'tablet', r.api.get());
check('  isTouch() vrai', r.api.isTouch() === true);

r = load({ coarse: false, width: 1920 });
check('ordinateur : pointeur fin', r.api.get() === 'desktop', r.api.get());
check('  data-touch-mode à false', r.attrs['data-touch-mode'] === 'false');
check('  isTouch() faux', r.api.isTouch() === false);

r = load({ coarse: false, width: 500 });
check('fenêtre étroite mais souris : reste ordinateur', r.api.get() === 'desktop', r.api.get());

console.log('\ndeviceMode — orientation et appareils qui se déclarent mal\n');

// Un téléphone couché est plus large qu'une petite tablette debout : au seul
// critère de largeur il passait en mode tablette, qui n'adapte pas l'en-tête.
r = load({ coarse: true, width: 1200, height: 460 });
check('téléphone couché : 1200 × 460', r.api.get() === 'phone', r.api.get());

r = load({ coarse: true, width: 390, height: 840 });
check('téléphone debout : 390 × 840', r.api.get() === 'phone', r.api.get());

r = load({ coarse: true, width: 820, height: 1180 });
check('tablette debout : 820 × 1180', r.api.get() === 'tablet', r.api.get());

r = load({ coarse: true, width: 1180, height: 820 });
check('tablette couchée : 1180 × 820', r.api.get() === 'tablet', r.api.get());

// Navigateur mobile qui annonce un pointeur fin — mode « site pour ordinateur »
// ou absence de réponse à `pointer`. La fenêtre trahit l'appareil.
r = load({ coarse: false, touchPoints: 5, width: 1200, height: 460 });
check('pointeur fin annoncé mais écran couché et tactile', r.api.get() === 'phone', r.api.get());

// Le garde-fou : un portable à écran tactile a lui aussi des points de contact.
r = load({ coarse: false, touchPoints: 10, width: 1440, height: 780 });
check('portable à écran tactile : reste ordinateur', r.api.get() === 'desktop', r.api.get());

r = load({ coarse: false, touchPoints: 10, width: 1920, height: 620 });
check('  fenêtre basse mais large sur portable tactile', r.api.get() === 'desktop', r.api.get());

console.log('\ndeviceMode — choix explicite\n');

r = load({ coarse: false, width: 1920, stored: 'phone' });
check('choix mémorisé « phone » prime sur la détection', r.api.get() === 'phone', r.api.get());
check('  getChoice() rend le choix, pas le mode', r.api.getChoice() === 'phone');
check('  detected() rend toujours la détection brute', r.api.detected() === 'desktop', r.api.detected());

r = load({ coarse: true, width: 390, stored: 'desktop' });
check('« desktop » forcé sur un téléphone', r.api.get() === 'desktop', r.api.get());
check('  tactile désactivé en conséquence', r.api.isTouch() === false);

r = load({ coarse: true, width: 390, stored: 'valeur-invalide' });
check('valeur illisible ignorée, retour à auto', r.api.getChoice() === 'auto' && r.api.get() === 'phone');

console.log('\ndeviceMode — set() et persistance\n');

r = load({ coarse: false, width: 1920 });
check('set("tablet") accepté', r.api.set('tablet') === true);
check('  mode appliqué', r.api.get() === 'tablet', r.api.get());
check('  écrit dans localStorage', r.storage.get('music_player_device_mode') === 'tablet');
check('set("n_importe_quoi") refusé', r.api.set('n_importe_quoi') === false);
check('  mode inchangé après refus', r.api.get() === 'tablet');
check('retour à auto', r.api.set('auto') === true && r.api.get() === 'desktop', r.api.get());

console.log('\ndeviceMode — abonnement\n');

r = load({ coarse: false, width: 1920 });
let received = [];
r.api.onChange((mode, previous) => received.push(`${previous}->${mode}`));
r.api.set('phone');
r.api.set('phone');
r.api.set('desktop');
check('un événement par changement réel', received.length === 2, received.join(', '));

console.log(`\n=== ${passed} réussite(s), ${failed} échec(s) ===`);
process.exit(failed === 0 ? 0 : 1);
