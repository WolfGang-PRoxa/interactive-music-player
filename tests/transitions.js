/**
 * Vérifie les aiguillages — ces éléments de playlist qui changent la source.
 *
 * Une transition n'est pas un morceau : c'est une consigne posée entre deux
 * titres. Quand la lecture l'atteint, elle bascule vers la source désignée —
 * une autre playlist, ou la file d'attente — et disparaît, consommée.
 *
 * Cinq choses portent le sens, et aucune ne se lit dans un diff.
 *
 *  - **Le lecteur n'en voit jamais une.** On pourrait la laisser descendre
 *    dans sa liste et l'intercepter au moment où elle allait jouer ; mais le
 *    lecteur enchaîne tout seul, et entre l'annonce de fin d'un titre et
 *    l'attaque du suivant il n'y a pas de place pour changer de source sans
 *    risquer que l'un des deux gagne. On lui donne donc la liste **jusqu'à**
 *    l'aiguillage, et rien au-delà : il tombe en panne sèche exactement là.
 *
 *  - **L'ordre des trois issues.** À l'épuisement, l'aiguillage est consulté
 *    avant le bouclage et avant la reprise de la file : une playlist qui
 *    s'aiguille n'est ni une playlist qui reboucle, ni une playlist terminée.
 *    C'est cet ordre, et non un test supplémentaire, qui porte la règle.
 *
 *  - **Elle est retirée avant la bascule, pas après.** La bascule relit la
 *    playlist pour la nourrir au lecteur ; l'aiguillage encore en place s'y
 *    retrouverait, et une transition vers la playlist où l'on est déjà se
 *    redéclencherait aussitôt.
 *
 *  - **Une destination vide n'annule rien.** Elle a bel et bien été atteinte,
 *    et la laisser en place la ferait se redéclencher indéfiniment.
 *
 *  - **Elle ne sort pas de sa liste.** Elle y désigne une position entre deux
 *    titres ; la glisser vers la file ou l'historique la priverait de tout ce
 *    qui lui donne un sens. Le refus se fait au dépôt et non au départ, sans
 *    quoi le déplacement légitime — à l'intérieur de sa playlist — serait
 *    interdit lui aussi.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// La base écrit dans `<cwd>/data/settings.json` : on la déplace avant tout
// `require`, ce test posant des playlists fictives.
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'transitions-test-'));
fs.mkdirSync(path.join(SANDBOX, 'data'), { recursive: true });
const CWD = process.cwd();
process.chdir(SANDBOX);

const transitions = require(path.join(ROOT, 'src', 'audio', 'transitions.js'));
const database = require(path.join(ROOT, 'src', 'database', 'Database.js'));

let failed = 0;
let passed = 0;
const check = (label, ok, detail = '') => {
    if (ok) { passed++; console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`); }
    else { failed++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
};

const piste = (nom) => ({ title: nom, url: `https://exemple/${nom}` });

console.log('\n=== Les aiguillages de lecture ===\n');

// ───────────────────── Ce qu'on reconnaît ─────────────────────

console.log('Distinguer un aiguillage d\'un morceau\n');

{
    const t = transitions.create('playlist_b');

    check('un aiguillage se reconnaît', transitions.isTransition(t));
    check('  … et porte sa destination', t.target === 'playlist_b');
    check('  … et une adresse qui n\'appartient qu\'à lui',
        t.url.startsWith(transitions.PREFIX) && t.url.includes(t.id),
        t.url);

    // Deux aiguillages vers la même playlist doivent rester distincts : le
    // code compare les pistes par leur adresse un peu partout — la file mise
    // de côté, l'index de lecture, le cache.
    const autre = transitions.create('playlist_b');
    check('  … différente de celle d\'un autre vers la même cible', t.url !== autre.url);

    check('un morceau n\'en est pas un', !transitions.isTransition(piste('A')));
    check('rien du tout non plus',
        !transitions.isTransition(null) && !transitions.isTransition(undefined));

    /*
     * Le drapeau ne survit pas à tout.
     *
     * Les pistes traversent plusieurs recopies champ par champ avant d'arriver
     * au lecteur — `toData`, la synchronisation de playlist, la file mise de
     * côté — et aucune ne connaît `isTransition`. L'adresse, elle, est recopiée
     * partout : c'est sur elle qu'on peut compter.
     */
    check('reconnu même après une recopie qui perd le drapeau',
        transitions.isTransition({ title: t.title, url: t.url, duration: t.duration }),
        'les recopies champ par champ ne connaissent pas le drapeau');
}

// ───────────────────── Ce que le lecteur reçoit ─────────────────────

console.log('\nLa liste s\'arrête à l\'aiguillage\n');

{
    const T = transitions.create('playlist_b');
    const liste = [piste('A'), T, piste('B'), piste('C')];

    const depuis0 = transitions.upTo(liste, 0);
    check('le lecteur ne reçoit rien au-delà de l\'aiguillage',
        depuis0.tracks.map(t => t.title).join(',') === 'A',
        depuis0.tracks.map(t => t.title).join(',') || '(rien)');
    check('  … et l\'aiguillage lui-même n\'y est pas',
        depuis0.tracks.every(t => !transitions.isTransition(t)),
        'il n\'a pas de flux à extraire');
    check('  … mais il est rendu à part, avec sa place',
        depuis0.transition === T && depuis0.at === 1);

    // Partir d'après l'aiguillage : il ne concerne plus rien, et la fin de la
    // playlist se joue normalement.
    const depuis2 = transitions.upTo(liste, 2);
    check('démarrer après lui donne le reste de la playlist',
        depuis2.tracks.map(t => t.title).join(',') === 'B,C'
        && depuis2.transition === null);

    // Démarrer sur l'aiguillage lui-même : rien à jouer, et il attend là.
    const depuis1 = transitions.upTo(liste, 1);
    check('démarrer dessus ne donne aucun titre',
        depuis1.tracks.length === 0 && depuis1.transition === T,
        'la bascule se fera au premier épuisement, c\'est-à-dire tout de suite');

    check('une playlist sans aiguillage passe entière',
        transitions.upTo([piste('A'), piste('B')], 0).tracks.length === 2);

    // Un indice hors liste ne doit rien casser : la position de lecture peut
    // avoir dérivé pendant qu'on supprimait des titres depuis le tableau de bord.
    check('un indice hors liste ne rend rien plutôt que de jeter',
        transitions.upTo(liste, 99).tracks.length === 0
        && transitions.upTo(null, 0).tracks.length === 0);
}

// ───────────────────── Ce qui se déclenche ─────────────────────

console.log('\nCe que l\'épuisement trouve juste après\n');

{
    const T = transitions.create('queue');
    const liste = [piste('A'), piste('B'), T, piste('C')];

    check('l\'aiguillage qui suit le dernier titre joué est trouvé',
        transitions.nextAfter(liste, 1).transition === T);

    /*
     * Immédiatement après, et pas plus loin.
     *
     * Quand le lecteur s'épuise, c'est qu'il a joué tout ce qu'on lui avait
     * donné — c'est-à-dire jusqu'à l'aiguillage, qui est donc à l'indice
     * suivant. En chercher un plus loin voudrait dire que la position a dérivé,
     * et l'on ne devinera pas lequel l'utilisateur visait.
     */
    check('  … mais pas un qui se trouve deux rangs plus loin',
        transitions.nextAfter(liste, 0) === null,
        'une position qui a dérivé ne doit pas déclencher au hasard');

    check('rien après le dernier titre', transitions.nextAfter(liste, 3) === null);
    check('rien dans une playlist sans aiguillage',
        transitions.nextAfter([piste('A'), piste('B')], 0) === null);
}

// ───────────────────── Les destinations ─────────────────────

console.log('\nOù l\'on peut aller\n');

{
    const pls = [
        { id: 'playlist_a', name: 'Soirée' },
        { id: 'playlist_b', name: 'Calme' },
    ];

    const depuisA = transitions.destinations(pls, 'playlist_a');
    check('sa propre playlist n\'est pas proposée',
        depuisA.every(d => d.id !== 'playlist_a'),
        'un aiguillage vers l\'endroit où l\'on est ne mène nulle part');
    check('  … la file d\'attente l\'est', depuisA.some(d => d.id === 'queue'));
    check('  … et les autres playlists aussi',
        depuisA.some(d => d.id === 'playlist_b' && d.name === 'Calme'));

    const depuisFile = transitions.destinations(pls, 'queue');
    check('depuis la file, la file n\'est pas proposée',
        depuisFile.every(d => d.id !== 'queue') && depuisFile.length === 2);

    check('le nom de la destination se retrouve',
        transitions.targetName({ target: 'playlist_b' }, pls) === 'Calme');
    check('  … et la file n\'en a pas ici',
        transitions.targetName({ target: 'queue' }, pls) === null,
        'son nom est traduit : le choisir ici imposerait une langue au stockage');
    check('  … une playlist supprimée non plus',
        transitions.targetName({ target: 'playlist_disparue' }, pls) === null);
}

// ───────────────────── Le rangement ─────────────────────

console.log('\nCe que la base en fait\n');

{
    const pl = database.createPlaylist('g1', 'Soirée');
    database.addTrackToPlaylist('g1', pl.id, piste('A'));
    database.addTrackToPlaylist('g1', pl.id, piste('B'));

    const marker = database.insertPlaylistTransition(pl.id, 1, 'queue');
    const relu = database.getGlobalPlaylists().find(p => p.id === pl.id);

    check('l\'aiguillage se range à la position demandée',
        transitions.isTransition(relu.tracks[1]) && relu.tracks.length === 3);
    check('  … avec sa destination intacte', relu.tracks[1].target === 'queue',
        'passé par addTrackToPlaylist, il l\'aurait perdue en chemin');

    // Retiré par son identifiant : il est consommé depuis le moteur de lecture,
    // à un moment où la liste a pu bouger sous lui.
    database.addTrackToPlaylist('g1', pl.id, piste('C'), 0);
    check('il se retire par son identifiant, quoi qu\'ait bougé la liste',
        database.removePlaylistTransition(pl.id, marker.id));
    const apres = database.getGlobalPlaylists().find(p => p.id === pl.id);
    check('  … et seuls les titres restent',
        apres.tracks.length === 3 && apres.tracks.every(t => !transitions.isTransition(t)));

    check('retirer deux fois ne casse rien',
        database.removePlaylistTransition(pl.id, marker.id) === false);

    check('une playlist inconnue n\'en accueille pas',
        database.insertPlaylistTransition('playlist_inconnue', 0, 'queue') === null);
}

{
    // Le filtre, pour tout ce qui attend une liste de morceaux.
    const T = transitions.create('queue');
    check('une liste se débarrasse de ses aiguillages',
        transitions.withoutTransitions([piste('A'), T, piste('B')]).length === 2);
    check('  … et rien du tout reste rien',
        transitions.withoutTransitions(null).length === 0);
}

// ───────────────────── L'ordre des trois issues ─────────────────────

console.log('\nCe que l\'épuisement essaie, et dans quel ordre\n');

{
    const SERVER = fs.readFileSync(path.join(ROOT, 'src', 'web', 'WebServer.js'), 'utf8');
    const EVENTS = fs.readFileSync(path.join(ROOT, 'src', 'audio', 'PlayerEvents.js'), 'utf8');

    /*
     * Les deux moteurs de lecture n'ont rien en commun : la file virtuelle du
     * mode personnel, et l'événement `emptyQueue` du mode commun. Un aiguillage
     * branché d'un seul côté ne se déclencherait que dans un mode sur deux,
     * sans que rien ne le dise.
     */
    for (const [nom, source] of [['le mode personnel', SERVER], ['le mode commun', EVENTS]]) {
        const aiguillage = source.indexOf('consumeTransition(');
        const bouclage = source.indexOf('restartLoopedPlaylist(');
        const file = source.indexOf('advanceToQueue(');

        check(`${nom} consulte l'aiguillage`, aiguillage !== -1);
        check(`  … avant le bouclage`, aiguillage !== -1 && aiguillage < bouclage,
            'une playlist qui s\'aiguille n\'est pas une playlist qui reboucle');
        check(`  … et avant la reprise de la file`, aiguillage !== -1 && aiguillage < file,
            'ni une playlist terminée');
    }

    // Le corps entier de la consommation : de sa signature au début de la
    // méthode suivante.
    const bloc = SERVER.slice(SERVER.indexOf('consumeTransition(guildId'),
        SERVER.indexOf('_transitionHasSomethingToPlay(guildId, transition, settings) {'));

    // Retirée avant la bascule : celle-ci relit la playlist pour la nourrir au
    // lecteur, et l'y retrouverait.
    const retrait = bloc.indexOf('removePlaylistTransition');
    check('la transition est consommée avant la bascule',
        retrait !== -1 && retrait < bloc.indexOf('applyPlaybackSource'),
        'laissée en place, une transition vers là où l\'on est se rejouerait sans fin');

    // Une destination vide : consommée quand même.
    check('une destination vide consomme tout de même l\'aiguillage',
        retrait !== -1 && retrait < bloc.indexOf('_transitionHasSomethingToPlay'),
        'sinon il se redéclencherait indéfiniment');

    // La bascule passe par le chemin du tableau de bord, et non par une copie.
    check('la bascule réemploie le chemin du tableau de bord',
        /handleSetActivePlaybackSource\(\{/.test(SERVER),
        'une seconde version divergerait, comme le choix des flux l\'a fait quatre fois');
}

// ───────────────────── Ce que le lecteur ne doit pas voir ─────────────────────

console.log('\nCe qui ne descend pas jusqu\'au lecteur\n');

{
    const SERVER = fs.readFileSync(path.join(ROOT, 'src', 'web', 'WebServer.js'), 'utf8');
    const PRELOAD = fs.readFileSync(path.join(ROOT, 'src', 'audio', 'PreloadManager.js'), 'utf8');

    check('la playlist est coupée à l\'aiguillage avant d\'être servie',
        /const tracks = transitions\.upTo\(playlist\.tracks \|\| \[\], startIndex\)\.tracks;/
            .test(SERVER),
        'lui donner la suite obligerait à l\'arrêter en vol');

    check('le préchargement ne les prend pas pour des pistes',
        /withoutTransitions\(targets\)/.test(PRELOAD),
        'un ffmpeg lancé sur une adresse « transition: » échouerait à chaque recalcul');
    check('  … filtré une seule fois, en sortie',
        (PRELOAD.match(/withoutTransitions/g) || []).length === 1,
        'à chacune des trois provenances, une quatrième oublierait le filtre');
}

// ───────────────────── Le côté tableau de bord ─────────────────────

console.log('\nCe que l\'interface en montre, et interdit\n');

{
    const CLIENT = fs.readFileSync(
        path.join(ROOT, 'src', 'web', 'public', 'js', 'transitions.js'), 'utf8');
    const MENU = fs.readFileSync(
        path.join(ROOT, 'src', 'web', 'public', 'js', 'qualityMenu.js'), 'utf8');
    const LISTES = fs.readFileSync(
        path.join(ROOT, 'src', 'web', 'public', 'js', 'playlists.js'), 'utf8');
    const FILE = fs.readFileSync(
        path.join(ROOT, 'src', 'web', 'public', 'js', 'queue.js'), 'utf8');
    const MARKUP = fs.readFileSync(
        path.join(ROOT, 'src', 'web', 'public', 'index.html'), 'utf8');

    check('le module client est chargé par la page',
        /<script src="js\/transitions\.js"><\/script>/.test(MARKUP));

    // Les deux côtés partagent le même préfixe d'adresse : deux graphies d'une
    // même convention finissent par diverger.
    check('client et serveur emploient le même préfixe',
        /const PREFIX = 'transition:';/.test(CLIENT)
        && /const PREFIX = 'transition:';/.test(
            fs.readFileSync(path.join(ROOT, 'src', 'audio', 'transitions.js'), 'utf8')));

    check('la ligne d\'aiguillage a son propre dessin',
        /playlist-transition-item/.test(CLIENT),
        'rien ne la distinguerait d\'un titre sans cela');
    check('  … et n\'offre pas de bouton « lire »',
        !/track-play-btn/.test(CLIENT), 'il n\'y a rien à jouer');
    check('  … mais se supprime comme un titre',
        /type: 'removeTrackFromPlaylist'/.test(CLIENT),
        'un aiguillage n\'est jamais qu\'un élément de la liste');

    /*
     * Le menu ne propose l'insertion que là où elle a un sens.
     *
     * Le contexte — quelle liste, à quelle position — est relu au clic droit et
     * non retenu à l'accrochage : la ligne garde son gestionnaire pendant que
     * la liste bouge sous elle, et un indice figé finirait par désigner le
     * voisin.
     */
    check('le menu ne propose l\'insertion qu\'avec un contexte',
        /if \(openedContext\) menuEl\.appendChild\(buildTransitionButton\(\)\);/.test(MENU),
        'l\'historique et la fenêtre vidéo ne désignent aucune position');
    check('  … et le contexte est relu au clic droit',
        /typeof resolveContext === 'function' \? resolveContext\(\) : null/.test(MENU));
    check('  … les playlists le fournissent',
        /\(\) => \(\{ container: playlist\.id, index \}\)/.test(LISTES));

    check('les deux boutons posent avant ou après la ligne cliquée',
        /index: avant \? context\.index : context\.index \+ 1/.test(MENU));

    // Le refus au dépôt, et non au départ.
    check('un aiguillage ne quitte pas sa playlist',
        /transitionLeavingHome/.test(LISTES) && /transitionLeavingHome/.test(FILE));
    // Le module qui dessine la ligne ne fait que *définir* la règle : il ne
    // l'applique nulle part. L'appliquer au `dragstart` interdirait aussi le
    // déplacement légitime, à l'intérieur de la playlist qui porte la ligne.
    const emplois = (CLIENT.match(/transitionLeavingHome/g) || []).length;
    check('  … refusé au dépôt, pas au glissement',
        emplois === 1 && /window\.MusicPlayer\.transitionLeavingHome = function/.test(CLIENT),
        `${emplois} occurrence(s) — la définition, et rien d'autre`);
    check('  … et les trois zones de la file le refusent',
        (FILE.match(/transitionLeavingHome/g) || []).length === 3,
        'la carte du lecteur, celle de la file, et la liste elle-même');
}

// ───────────────────── Les traductions ─────────────────────

console.log('\nCe que les quatre langues doivent dire\n');

{
    const CLES = [
        'transition_menu_label', 'transition_target_label', 'transition_target_queue',
        'transition_target_gone', 'transition_no_target', 'transition_insert_before',
        'transition_insert_after', 'transition_row_label', 'transition_row_tooltip',
        'transition_remove',
    ];

    for (const lang of ['fr', 'en', 'es', 'de']) {
        const dict = JSON.parse(fs.readFileSync(
            path.join(ROOT, 'src', 'web', 'public', 'locales', `${lang}.json`), 'utf8'));
        const manquantes = CLES.filter(k => !dict[k] || !String(dict[k]).trim());
        check(`${lang} : les ${CLES.length} libellés sont traduits`,
            manquantes.length === 0, manquantes.join(', '));
    }
}

// ───────────────────── Fin ─────────────────────

database.flush();
process.chdir(CWD);
try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) {}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
