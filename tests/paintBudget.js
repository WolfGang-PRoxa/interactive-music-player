/**
 * Vérifie ce qui empêche le navigateur de cesser de peindre.
 *
 * Un élément promu en calque de composition est peint à part, et cette peinture
 * occupe de la mémoire que le navigateur reprend quand elle vient à manquer. Il
 * cesse alors simplement de dessiner : le cadre reste, le contenu disparaît. Le
 * symptôme est le même partout, la cause diffère.
 *
 *  - Sur Firefox mobile, la pénurie venait du nombre : trois barres par ligne de
 *    liste, soixante calques pour vingt titres, et la pénurie débordait jusque
 *    sur le texte des menus déroulants.
 *
 *  - Sur Safari, sur un Mac de bureau, WebKit détache la mémoire de peinture des
 *    calques éloignés de la fenêtre et ne la rattache pas toujours : un invité a
 *    vu disparaître les chiffres de la roulette de vitesse après un aller-retour
 *    vers le bas de la page.
 *
 * Aucune des règles écrites pour le premier cas ne se voyait dans le second :
 * toutes sont conditionnées au mode tactile, et un Mac de bureau est en mode
 * ordinateur. Le moteur est devenu un second déclencheur.
 *
 * Ce que ce test tient, et qu'aucune relecture ne rattrape :
 *
 *  - **Le moteur est reconnu sans lire la chaîne d'agent.** Elle se déguise ;
 *    `GestureEvent` non, et il répond vrai pour tout navigateur sur iOS, qui
 *    sont tous WebKit quelle que soit leur marque.
 *
 *  - **Aucune promotion permanente n'échappe à la règle.** Le test relit les
 *    feuilles de style et exige que chaque `will-change: transform` durable y
 *    soit désamorcé. Une barre ajoutée demain sans son pendant ici ferait
 *    revenir le symptôme chez un seul navigateur, des mois plus tard.
 *
 *  - **Ce qui coûte un mouvement reste au seul mode tactile.** Retirer
 *    l'animation de la pochette ou le flou des menus se voit ; ces règles-là ne
 *    sont pas étendues tant que rien ne prouve qu'il le faille. Le test le
 *    retient, pour qu'on ne l'étende pas par inadvertance.
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CSS_DIR = path.join(ROOT, 'src', 'web', 'public', 'css');

let failed = 0;
let passed = 0;
const check = (label, ok, detail = '') => {
    if (ok) { passed++; console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`); }
    else { failed++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
};

const lire = (f) => fs.readFileSync(path.join(CSS_DIR, f), 'utf8');

/** Les feuilles où un calque peut naître. */
const FEUILLES = ['base.css', 'components.css', 'device.css', 'drawer.css', 'layout.css',
    'modals.css', 'player.css', 'quality.css', 'queue.css', 'video.css'];

/**
 * Découpe une feuille en règles, commentaires ôtés des sélecteurs.
 *
 * Suffisant ici : ces feuilles n'imbriquent pas, hors `@media` et `@supports`
 * dont l'ouverture ne porte pas de déclaration et ressort donc avec un corps
 * vide.
 *
 * @returns {{ selecteurs: string[], corps: string }[]}
 */
function regles(source) {
    const sansCommentaires = source.replace(/\/\*[\s\S]*?\*\//g, '');
    const out = [];
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(sansCommentaires))) {
        out.push({
            selecteurs: m[1].split(',').map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean),
            corps: m[2],
        });
    }
    return out;
}

/**
 * Exécute deviceMode.js dans un DOM simulé, et rend les attributs posés.
 * @param {{ gestures?: boolean }} env
 */
function charger({ gestures = false } = {}) {
    const attrs = {};
    const fakeWindow = {
        matchMedia: () => ({ matches: false }),
        innerWidth: 1600,
        innerHeight: 900,
        addEventListener() {},
        screen: { width: 1600, height: 900 },
    };
    // Safari expose cette interface — les gestes de pincement —, et elle seule
    // le distingue sans passer par la chaîne d'agent.
    if (gestures) fakeWindow.GestureEvent = function GestureEvent() {};

    const context = {
        window: fakeWindow,
        document: {
            documentElement: {
                setAttribute: (k, v) => { attrs[k] = v; },
                removeAttribute: (k) => { delete attrs[k]; },
            },
        },
        localStorage: { getItem: () => null, setItem: () => {} },
        navigator: { maxTouchPoints: 0 },
        screen: { width: 1600, height: 900 },
        console,
        setTimeout,
        clearTimeout,
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(
        path.join(ROOT, 'src', 'web', 'public', 'js', 'deviceMode.js'), 'utf8'), context);

    return attrs;
}

console.log('\n=== Le budget de composition ===\n');

// ───────────────────── Reconnaître le moteur ─────────────────────

console.log('Le moteur est nommé sur la racine\n');

{
    const safari = charger({ gestures: true });
    const autre = charger({ gestures: false });

    check('Safari est reconnu', safari['data-engine'] === 'webkit',
        String(safari['data-engine']));
    check('  … et lui seul', autre['data-engine'] === undefined,
        String(autre['data-engine']));
    check('  … sans lire la chaîne d\'agent',
        !fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'js', 'deviceMode.js'), 'utf8')
            .includes('userAgent'),
        'elle se déguise, l\'interface non');
    check('le mode d\'appareil n\'en est pas troublé',
        safari['data-device-mode'] === 'desktop' && safari['data-touch-mode'] === 'false',
        'un Mac de bureau reste un ordinateur');
}

// ───────────────── Aucune promotion durable n'échappe ─────────────────

console.log('\nChaque calque permanent est désamorcé pour WebKit\n');

/*
 * Ces deux-là n'existent que le temps d'un glissement : l'élément porte la
 * classe pendant le geste et la perd en le lâchant. Un calque qui vit deux
 * secondes ne pèse sur aucun budget, et l'indication sert là où elle est.
 */
const TRANSITOIRES = ['.drawer-widget.widget-dragging', '.drag-preview'];

const promus = [];
for (const f of FEUILLES) {
    for (const r of regles(lire(f))) {
        if (!/will-change:\s*transform/.test(r.corps)) continue;
        for (const s of r.selecteurs) promus.push({ feuille: f, selecteur: s });
    }
}

check('des calques permanents existent bien', promus.length >= 6,
    `${promus.length} sélecteurs promus`);

// Ce que device.css rend au calque commun, par sélecteur exact.
const desamorces = { touch: new Set(), webkit: new Set() };
for (const r of regles(lire('device.css'))) {
    if (!/will-change:\s*auto/.test(r.corps)) continue;
    for (const s of r.selecteurs) {
        const touch = s.match(/^\[data-touch-mode="true"\]\s+(.*)$/);
        const webkit = s.match(/^\[data-engine="webkit"\]\s+(.*)$/);
        if (touch) desamorces.touch.add(touch[1]);
        if (webkit) desamorces.webkit.add(webkit[1]);
    }
}

const durables = promus.filter((p) => !TRANSITOIRES.includes(p.selecteur));
const oublies = durables.filter((p) => !desamorces.webkit.has(p.selecteur));

check('tous sont désamorcés sur WebKit', oublies.length === 0,
    oublies.length ? oublies.map((p) => `${p.selecteur} (${p.feuille})`).join(', ')
        : durables.map((p) => p.selecteur).join(', '));
check('  … et le mode tactile garde les siens',
    durables.every((p) => desamorces.touch.has(p.selecteur)),
    'le premier remède ne doit pas partir avec le second');
check('  … tandis que le calque d\'un glissement est laissé tel quel',
    TRANSITOIRES.every((s) => !desamorces.webkit.has(s)),
    'deux secondes de calque ne pèsent sur aucun budget');

// ───────────────── Les deux éléments que l'invité a nommés ─────────────────

console.log('\nCe que l\'invité sur Safari a vu disparaître\n');

{
    const composants = lire('components.css');
    const lecteur = lire('player.css');

    check('la roulette de vitesse porte bien les chiffres',
        /\.speed-pad-track\s*\{[^}]*\}/.test(composants)
        && /\.speed-value\s*\{/.test(composants),
        '.speed-value vit dans .speed-pad-track');
    check('  … et c\'est elle qui était promue',
        desamorces.webkit.has('.speed-pad-track'));

    check('la barre de progression de « En cours de lecture » aussi',
        /\.progress-fill\s*\{[^}]*will-change:\s*transform/.test(lecteur)
        && desamorces.webkit.has('.progress-fill'));
}

// ───────────────── Ce qui coûte un mouvement reste au doigt ─────────────────

console.log('\nCe qui se verrait n\'est pas étendu\n');

{
    const device = lire('device.css');
    const pourWebkit = (motif) => new RegExp(`\\[data-engine="webkit"\\][^,{]*${motif}`).test(device);

    check('l\'animation de la pochette tourne toujours sur Safari',
        !pourWebkit('\\.thumbnail-wrapper'),
        'le disque qui tourne est une fonctionnalité, pas un effet de bord');
    check('  … et l\'icône de repli avec elle', !pourWebkit('\\.icon-disc'));
    check('le flou des menus déroulants est conservé',
        !pourWebkit('\\.custom-select-trigger'),
        'le verre se voit, et rien ne dit encore qu\'il faille le retirer');
    check('les listes gardent leur défilement propre',
        !pourWebkit('\\.playlist-queue'),
        'le supprimer changerait la mise en page d\'un écran de bureau');

    check('ces remèdes-là restent offerts au mode tactile',
        /\[data-touch-mode="true"\] \.thumbnail-wrapper\.anim-mode-spin/.test(device)
        && /\[data-touch-mode="true"\] \.custom-select-trigger/.test(device),
        'rien n\'a été déplacé, seulement ajouté');
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed ? 1 : 0);
