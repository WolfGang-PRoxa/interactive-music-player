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

let echecs = 0;
let reussites = 0;
const verifier = (libelle, ok, detail = '') => {
    if (ok) { reussites++; console.log(`  ok    ${libelle}${detail ? ` — ${detail}` : ''}`); }
    else { echecs++; console.log(`  ECHEC ${libelle}${detail ? ` — ${detail}` : ''}`); }
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
function charger(env) {
    const attributs = {};
    const stockage = new Map();
    if (env.stored !== undefined) stockage.set('music_player_device_mode', env.stored);

    const hauteur = env.height === undefined ? 900 : env.height;
    const contacts = env.touchPoints === undefined ? (env.coarse ? 5 : 0) : env.touchPoints;

    const fenetre = {
        matchMedia: (q) => ({ matches: q.includes('coarse') ? env.coarse : false }),
        innerWidth: env.width,
        innerHeight: hauteur,
        addEventListener() {},
    };

    const contexte = {
        window: fenetre,
        document: { documentElement: { setAttribute: (k, v) => { attributs[k] = v; } } },
        localStorage: {
            getItem: (k) => (stockage.has(k) ? stockage.get(k) : null),
            setItem: (k, v) => stockage.set(k, String(v)),
        },
        navigator: { maxTouchPoints: contacts },
        screen: { width: env.width, height: hauteur },
        console,
        setTimeout, clearTimeout,
    };
    contexte.globalThis = contexte;
    vm.createContext(contexte);
    vm.runInContext(SOURCE, contexte);

    return { api: fenetre.MusicPlayer.deviceMode, attributs, stockage };
}

console.log('deviceMode — détection automatique\n');

let r = charger({ coarse: true, width: 390 });
verifier('téléphone : pointeur grossier + 390 px', r.api.get() === 'phone', r.api.get());
verifier('  attribut data-device-mode posé', r.attributs['data-device-mode'] === 'phone');
verifier('  attribut data-touch-mode à true', r.attributs['data-touch-mode'] === 'true');
verifier('  isTouch() vrai', r.api.isTouch() === true);

r = charger({ coarse: true, width: 1024 });
verifier('tablette : pointeur grossier + 1024 px', r.api.get() === 'tablet', r.api.get());
verifier('  isTouch() vrai', r.api.isTouch() === true);

r = charger({ coarse: false, width: 1920 });
verifier('ordinateur : pointeur fin', r.api.get() === 'desktop', r.api.get());
verifier('  data-touch-mode à false', r.attributs['data-touch-mode'] === 'false');
verifier('  isTouch() faux', r.api.isTouch() === false);

r = charger({ coarse: false, width: 500 });
verifier('fenêtre étroite mais souris : reste ordinateur', r.api.get() === 'desktop', r.api.get());

console.log('\ndeviceMode — orientation et appareils qui se déclarent mal\n');

// Un téléphone couché est plus large qu'une petite tablette debout : au seul
// critère de largeur il passait en mode tablette, qui n'adapte pas l'en-tête.
r = charger({ coarse: true, width: 1200, height: 460 });
verifier('téléphone couché : 1200 × 460', r.api.get() === 'phone', r.api.get());

r = charger({ coarse: true, width: 390, height: 840 });
verifier('téléphone debout : 390 × 840', r.api.get() === 'phone', r.api.get());

r = charger({ coarse: true, width: 820, height: 1180 });
verifier('tablette debout : 820 × 1180', r.api.get() === 'tablet', r.api.get());

r = charger({ coarse: true, width: 1180, height: 820 });
verifier('tablette couchée : 1180 × 820', r.api.get() === 'tablet', r.api.get());

// Navigateur mobile qui annonce un pointeur fin — mode « site pour ordinateur »
// ou absence de réponse à `pointer`. La fenêtre trahit l'appareil.
r = charger({ coarse: false, touchPoints: 5, width: 1200, height: 460 });
verifier('pointeur fin annoncé mais écran couché et tactile', r.api.get() === 'phone', r.api.get());

// Le garde-fou : un portable à écran tactile a lui aussi des points de contact.
r = charger({ coarse: false, touchPoints: 10, width: 1440, height: 780 });
verifier('portable à écran tactile : reste ordinateur', r.api.get() === 'desktop', r.api.get());

r = charger({ coarse: false, touchPoints: 10, width: 1920, height: 620 });
verifier('  fenêtre basse mais large sur portable tactile', r.api.get() === 'desktop', r.api.get());

console.log('\ndeviceMode — choix explicite\n');

r = charger({ coarse: false, width: 1920, stored: 'phone' });
verifier('choix mémorisé « phone » prime sur la détection', r.api.get() === 'phone', r.api.get());
verifier('  getChoice() rend le choix, pas le mode', r.api.getChoice() === 'phone');
verifier('  detected() rend toujours la détection brute', r.api.detected() === 'desktop', r.api.detected());

r = charger({ coarse: true, width: 390, stored: 'desktop' });
verifier('« desktop » forcé sur un téléphone', r.api.get() === 'desktop', r.api.get());
verifier('  tactile désactivé en conséquence', r.api.isTouch() === false);

r = charger({ coarse: true, width: 390, stored: 'valeur-invalide' });
verifier('valeur illisible ignorée, retour à auto', r.api.getChoice() === 'auto' && r.api.get() === 'phone');

console.log('\ndeviceMode — set() et persistance\n');

r = charger({ coarse: false, width: 1920 });
verifier('set("tablet") accepté', r.api.set('tablet') === true);
verifier('  mode appliqué', r.api.get() === 'tablet', r.api.get());
verifier('  écrit dans localStorage', r.stockage.get('music_player_device_mode') === 'tablet');
verifier('set("n_importe_quoi") refusé', r.api.set('n_importe_quoi') === false);
verifier('  mode inchangé après refus', r.api.get() === 'tablet');
verifier('retour à auto', r.api.set('auto') === true && r.api.get() === 'desktop', r.api.get());

console.log('\ndeviceMode — abonnement\n');

r = charger({ coarse: false, width: 1920 });
let recus = [];
r.api.onChange((mode, precedent) => recus.push(`${precedent}->${mode}`));
r.api.set('phone');
r.api.set('phone');
r.api.set('desktop');
verifier('un événement par changement réel', recus.length === 2, recus.join(', '));

console.log(`\n=== ${reussites} réussite(s), ${echecs} échec(s) ===`);
process.exit(echecs === 0 ? 0 : 1);
