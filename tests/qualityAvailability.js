/**
 * Vérifie que le menu ne propose plus des qualités qui n'existent pas.
 *
 * Le menu clic droit offrait les six définitions et les cinq débits sans jamais
 * savoir si le fichier existait dans aucun d'eux. Proposer du 4K sur une vidéo
 * mise en ligne en 720p n'est pas un choix : c'est une promesse qu'on ne tient
 * pas, et qui ne se découvre qu'au fichier obtenu.
 *
 * Quatre choses portent le sens.
 *
 *  - **La vidéo est franche, l'audio ne l'est pas.** Une définition existe ou
 *    n'existe pas. Un débit, lui, reste toujours atteignable — le bot transcode
 *    — mais viser au-dessus de la source n'ajoute que du poids. Les deux ne se
 *    marquent donc pas pour la même raison, et ne se disent pas pareil.
 *
 *  - **Trois états, pas deux.** Jamais demandé, en attente, connu. Confondre les
 *    deux premiers ferait clignoter une liste grise à chaque ouverture.
 *
 *  - **Tant que rien n'est su, tout est offert.** Griser à l'aveugle serait pire
 *    que de ne rien dire : le menu d'avant proposait tout et ne mentait qu'à
 *    moitié.
 *
 *  - **La valeur déjà retenue reste cliquable**, même absente de la source. Elle
 *    a pu être choisie quand la source proposait autre chose, et l'éteindre
 *    laisserait un menu où même la ligne cochée est morte.
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(
    path.join(ROOT, 'src', 'web', 'public', 'js', 'qualityMenu.js'), 'utf8');

let failed = 0;
let passed = 0;
const check = (label, ok, detail = '') => {
    if (ok) { passed++; console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`); }
    else { failed++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
};

/**
 * Extrait `optionAvailable` du module livré et l'exécute seule.
 *
 * Le module entier suppose un DOM, une socket et un état ; cette fonction-ci ne
 * décide que sur deux valeurs. La découper est le seul moyen de l'éprouver sur
 * le fichier réel.
 */
function loadDecider() {
    const start = SOURCE.indexOf('function optionAvailable(');
    const end = SOURCE.indexOf('/** Débits MP3 proposés', start);
    if (start < 0 || end < 0) throw new Error('optionAvailable introuvable');

    const sandbox = { Array, Number, console };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(`${SOURCE.slice(start, end)}\nglobalThis.__f = optionAvailable;`, sandbox);
    return sandbox.__f;
}

const disponible = loadDecider();

console.log('\n=== Les qualités réellement disponibles ===\n');

// ───────────────────── Ce qu'on ignore encore ─────────────────────

console.log('Tant que la source n\'a pas répondu\n');

{
    // Trois états, et les deux premiers ne se traitent pas comme le troisième.
    check('jamais demandé : tout reste offert',
        disponible('video', '2160', undefined) && disponible('audio', '320', undefined));
    check('demandé, sans réponse : tout reste offert aussi',
        disponible('video', '2160', null) && disponible('audio', '320', null),
        'griser à l\'aveugle serait pire que de ne rien dire');
    check('source muette : tout reste offert',
        disponible('video', '2160', { known: false, heights: [], audioKbps: null }),
        'une plateforme que l\'outil ne sait pas lire n\'interdit rien');
}

// ───────────────────── La vidéo, franche ─────────────────────

console.log('\nLa définition existe, ou n\'existe pas\n');

{
    const source = { known: true, heights: [1080, 720, 480, 360], audioKbps: 128 };

    check('une définition présente est offerte',
        disponible('video', '1080', source) && disponible('video', '360', source));
    check('  … une absente ne l\'est pas',
        !disponible('video', '2160', source) && !disponible('video', '1440', source),
        'promettre du 4K sur une mise en ligne en 1080p');

    // Les hauteurs arrivent en nombres, le menu les manipule en chaînes.
    check('la comparaison ne bute pas sur le type',
        disponible('video', 1080, source) && disponible('video', '1080', source));

    const sansImage = { known: true, heights: [], audioKbps: 160 };
    check('une source sans image n\'offre aucune définition',
        !disponible('video', '720', sansImage) && !disponible('video', '360', sansImage),
        'le menu vidéo n\'a alors rien à proposer');
}

// ───────────────────── L'audio, nuancé ─────────────────────

console.log('\nLe débit : atteignable, mais pas toujours utile\n');

{
    const source = { known: true, heights: [720], audioKbps: 128 };

    check('un débit sous la source garde son sens',
        disponible('audio', '128', source) && disponible('audio', '96', source));

    /*
     * Au-dessus, le transcodage n'ajoute rien : on réencode 128 kbps vers 320
     * sans récupérer ce qui n'y est pas, pour un fichier deux fois plus lourd.
     */
    check('  … au-dessus, il n\'ajoute que du poids',
        !disponible('audio', '320', source) && !disponible('audio', '256', source),
        'plus lourd, pas meilleur');

    // Les débits variables flottent sous leur étiquette : écarter 320 pour une
    // source annoncée à 317 serait une exactitude inutile.
    const presque = { known: true, heights: [], audioKbps: 317 };
    check('une marge évite d\'écarter pour trois kilobits',
        disponible('audio', '320', presque), '317 kbps annoncés, 320 offert');

    const inconnu = { known: true, heights: [1080], audioKbps: null };
    check('un débit que la source n\'annonce pas n\'interdit rien',
        disponible('audio', '320', inconnu),
        'ne rien savoir n\'est pas savoir que non');
}

// ───────────────────── Le raccordement ─────────────────────

console.log('\nCe qui tient les deux bouts\n');

{
    check('l\'inventaire n\'est demandé qu\'à l\'ouverture d\'un sous-menu',
        /askFormats\(track\.url\);/.test(SOURCE)
        && !/askFormats\([^)]*\)/.test(SOURCE.slice(SOURCE.indexOf('function renderMenu'),
            SOURCE.indexOf('function openMenu'))),
        'un appel réseau par piste à chaque état serait payé pour rien');

    check('  … et une seule fois par adresse',
        /if \(!url \|\| formatsByUrl\.has\(url\)\) return;/.test(SOURCE));

    check('l\'attente se dit, au lieu de griser par défaut',
        /formats === null/.test(SOURCE) && /quality_formats_pending/.test(SOURCE));

    check('la valeur déjà retenue reste cliquable',
        /\|\| String\(opt\.value\) === String\(current\)/.test(SOURCE),
        'sinon le menu n\'aurait plus une seule ligne vivante');

    check('un choix éteint ne s\'applique pas au clic',
        /if \(!usable\) return;/.test(SOURCE),
        'désactiver un bouton ne suffit pas toujours');

    const HANDLER = fs.readFileSync(
        path.join(ROOT, 'src', 'web', 'websocket', 'handlers', 'qualityHandlers.js'), 'utf8');

    /*
     * Spotify et Deezer ne portent aucun flux : c'est la vidéo vers laquelle le
     * bot les fait pointer qui en porte. Interroger l'adresse d'origine ne
     * rendrait rien, et le menu proposerait tout comme avant.
     */
    check('la piste est pontée avant d\'être interrogée',
        /resolvePlayableTrack\(\{ url, title: url \}\)/.test(HANDLER),
        'une adresse Spotify n\'a pas de formats à elle');

    check('un fichier local n\'est pas interrogé du tout',
        /if \(!\/\^https\?:\\\/\\\/\/i\.test\(url\)\)/.test(HANDLER),
        'lancer un processus pour un fichier du disque ne rendrait rien');

    const SRC = fs.readFileSync(path.join(ROOT, 'src', 'audio', 'videoSource.js'), 'utf8');
    check('l\'inventaire est retenu quelques minutes',
        /INVENTORY_TTL_MS/.test(SRC) && /inventoryCache/.test(SRC),
        'une à trois secondes par ouverture serait insupportable');

    check('les définitions sont dédoublonnées et ordonnées',
        /\[\.\.\.new Set\(formats/.test(SRC) && /sort\(\(a, b\) => b - a\)/.test(SRC),
        'la même hauteur revient en plusieurs codecs');
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
