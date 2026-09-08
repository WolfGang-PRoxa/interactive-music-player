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

// ───────────────────── L'aiguillage dans la file ─────────────────────

console.log('\nLa file, qui se lit autrement qu\'une playlist\n');

{
    const SERVER = fs.readFileSync(path.join(ROOT, 'src', 'web', 'WebServer.js'), 'utf8');
    const HANDLER = fs.readFileSync(
        path.join(ROOT, 'src', 'web', 'websocket', 'handlers', 'playlistHandlers.js'), 'utf8');
    const FILE = fs.readFileSync(
        path.join(ROOT, 'src', 'web', 'public', 'js', 'queue.js'), 'utf8');

    /*
     * Les deux sources ne se lisent pas pareil, et pour une bonne raison.
     *
     * Une playlist est une liste fixe où la lecture avance un curseur :
     * l'aiguillage à consulter est celui qui suit ce curseur. La file, elle, se
     * consomme par la tête — ses titres joués la quittent —, si bien qu'un
     * aiguillage atteint est simplement celui qui s'y trouve en premier.
     */
    check('la file et la playlist ont chacune leur lecture',
        /_queueTransition\(settings\)/.test(SERVER)
        && /_playlistTransition\(settings, source\)/.test(SERVER));
    check('  … la file regarde sa tête',
        /const \[premier\] = channelQueue\.read\(settings\);/.test(SERVER),
        'ses titres joués l\'ont quittée : l\'aiguillage atteint est le premier');
    check('  … la playlist suit son curseur',
        /transitions\.nextAfter\(playlist\.tracks \|\| \[\],/.test(SERVER),
        'sa liste ne bouge pas : c\'est la position de lecture qui avance');

    check('la file accepte désormais un aiguillage',
        /const versPlaylist = String\(container\)\.startsWith\('playlist_'\);/.test(HANDLER)
        && /if \(!versPlaylist && container !== 'queue'\) return;/.test(HANDLER));

    /*
     * Poser un aiguillage reprend au lecteur ce qui le suit.
     *
     * Il porte peut-être déjà des titres qui se trouvent désormais derrière la
     * transition : sans cette reprise, il les jouerait par-dessus la bascule,
     * et l'aiguillage n'arriverait jamais.
     */
    check('  … et le lecteur est renourri jusqu\'à lui',
        /webServer\.loadChannelQueue\(currentGuildId\);/.test(HANDLER),
        'sinon il jouerait par-dessus la bascule ce qu\'il avait déjà reçu');

    check('l\'aiguillage consommé quitte le rangement de la file',
        /channelQueue\.write\(guildId,\s*\n\s*channelQueue\.read\(settings\)\.filter/.test(SERVER),
        'laissé en place, il se redéclencherait au titre suivant');

    check('la file offre le sous-menu comme une playlist',
        /\(\) => \(\{ container: 'queue', index \}\)/.test(FILE));
    check('  … et sait dessiner la ligne',
        /buildTransitionRow\(track, \{ id: 'queue' \}, index\)/.test(FILE));
}

// ───────────────────── Changer la destination ─────────────────────

console.log('\nCe qu\'un clic droit sur un aiguillage permet\n');

{
    const pl = database.createPlaylist('g1', 'Soirée');
    database.addTrackToPlaylist('g1', pl.id, piste('A'));
    const marker = database.insertPlaylistTransition(pl.id, 1, 'queue');

    check('la destination se change',
        database.setPlaylistTransitionTarget(pl.id, marker.id, 'playlist_autre'));
    const relu = database.getGlobalPlaylists().find(p => p.id === pl.id);
    check('  … et c\'est bien la nouvelle qui est rangée',
        relu.tracks[1].target === 'playlist_autre');
    check('  … l\'aiguillage restant le même', relu.tracks[1].id === marker.id,
        'changer de destination ne le déplace ni ne le remplace');

    // Par l'identifiant, comme le retrait : la ligne a pu bouger depuis
    // l'ouverture du menu.
    database.addTrackToPlaylist('g1', pl.id, piste('Z'), 0);
    check('  … désigné par son identifiant, quoi qu\'ait bougé la liste',
        database.setPlaylistTransitionTarget(pl.id, marker.id, 'queue')
        && database.getGlobalPlaylists().find(p => p.id === pl.id).tracks[2].target === 'queue');

    check('un aiguillage inconnu ne change rien',
        database.setPlaylistTransitionTarget(pl.id, 'jamais_vu', 'queue') === false);
}

{
    const MENU = fs.readFileSync(
        path.join(ROOT, 'src', 'web', 'public', 'js', 'qualityMenu.js'), 'utf8');
    const CLIENT = fs.readFileSync(
        path.join(ROOT, 'src', 'web', 'public', 'js', 'transitions.js'), 'utf8');
    const HANDLER = fs.readFileSync(
        path.join(ROOT, 'src', 'web', 'websocket', 'handlers', 'playlistHandlers.js'), 'utf8');
    const DROITS = fs.readFileSync(path.join(ROOT, 'src', 'web', 'permissions.js'), 'utf8');

    check('la ligne d\'aiguillage écoute le clic droit',
        /item\.addEventListener\('contextmenu'/.test(CLIENT)
        && /showTransitionMenu\(e, transition/.test(CLIENT));

    /*
     * Un menu à part, mais la même mécanique flottante.
     *
     * Un aiguillage n'a ni débit, ni définition, ni sonie, ni source à copier :
     * lui présenter ces réglages désactivés ferait une liste morte à quatre
     * lignes pour un seul choix. Il emprunte en revanche `menuEl`, et donc le
     * placement et tous les gestes de fermeture — un quatrième panneau flottant
     * avec ses propres écouteurs finirait par se fermer autrement que les trois
     * autres.
     */
    check('le menu emprunte la mécanique du menu de qualité',
        /menuEl = document\.createElement\('div'\);[\s\S]{0,200}transition-menu/.test(MENU)
        && /placeMenu\(e\.clientX, e\.clientY\);/.test(MENU));

    check('  … mais ne se laisse pas reconstruire comme lui',
        /if \(menuKind !== 'quality'\) return;/.test(MENU),
        'renderMenu chercherait une piste à l\'adresse d\'un aiguillage, et refermerait le menu');

    check('  … et le drapeau revient à sa valeur ordinaire à la fermeture',
        /openedContext = null;\s*\n\s*menuKind = 'quality';/.test(MENU));

    // La liste des destinations est écrite une fois pour les deux usages.
    check('création et modification partagent la même liste',
        /function buildTargetList\(cibles, courante, choisir\)/.test(MENU)
        && (MENU.match(/buildTargetList\(/g) || []).length === 3,
        'sa définition, et ses deux emplois');
    check('  … et le même calcul des destinations possibles',
        /function transitionTargets\(containerId\)/.test(MENU)
        && (MENU.match(/transitionTargets\(/g) || []).length === 3);

    check('la destination courante porte la coche',
        /if \(cible\.id === courante\) opt\.classList\.add\('is-current'\);/.test(MENU));
    check('  … et la recliquer n\'envoie rien',
        /if \(id !== transition\.target\) \{/.test(MENU),
        'un message pour un réglage inchangé ferait clignoter la liste pour rien');

    check('le serveur sait changer une destination dans les deux contenants',
        /function handleSetTransitionTarget\(ctx\)/.test(HANDLER)
        && /if \(container === 'queue'\)/.test(HANDLER)
        && /database\.setPlaylistTransitionTarget\(container, id, target\)/.test(HANDLER));
    check('  … refuse une destination qui n\'existe pas',
        /if \(target !== 'queue' && !\(database\.getGlobalPlaylists\(\) \|\| \[\]\)\.some/.test(HANDLER),
        'elle ne mènerait qu\'à un aiguillage consommé sans effet');
    check('  … et refuse de pointer sur sa propre liste',
        (HANDLER.match(/if \(container === target\) return;/g) || []).length === 2,
        'à la pose comme à la modification');

    check('la modification est soumise à un droit', /setTransitionTarget: '/.test(DROITS));
}

{
    /*
     * La ligne doit se redessiner sans rechargement de page.
     *
     * Les deux listes ne se reconstruisent que lorsque leur signature bouge —
     * titre, adresse, durée, pochette —, sans quoi elles seraient réécrites à
     * chaque état reçu et perdraient le survol sous le curseur. Or un
     * aiguillage n'a rien de tout cela : changer sa destination ne bougeait
     * aucun de ces quatre champs, et la ligne gardait son ancien nom jusqu'au
     * prochain rechargement.
     */
    const vm = require('vm');
    const SRC = fs.readFileSync(
        path.join(ROOT, 'src', 'web', 'public', 'js', 'transitions.js'), 'utf8');

    const bac = { window: {}, console, Number };
    bac.globalThis = bac;
    vm.createContext(bac);
    vm.runInContext(SRC, bac);
    const MP = bac.window.MusicPlayer;

    MP.state = { playlists: [{ id: 'p_a', name: 'Soirée' }, { id: 'p_b', name: 'Calme' }] };
    const T = { isTransition: true, id: 'x', target: 'p_b', url: 'transition:x' };
    const avec = [piste('A'), T];

    const depart = MP.transitionSignature(avec);

    T.target = 'queue';
    check('changer de destination réveille la liste',
        MP.transitionSignature(avec) !== depart,
        'sans quoi la ligne garderait son ancien nom jusqu\'au rechargement');

    // Le nom affiché vient des playlists, pas de l'aiguillage : le renommer
    // change la ligne sans que l'aiguillage, lui, ait bougé.
    T.target = 'p_b';
    MP.state.playlists[1].name = 'Calme du soir';
    check('  … et renommer la playlist visée aussi',
        MP.transitionSignature(avec) !== depart);

    /*
     * Mais seulement quand un aiguillage est en vue.
     *
     * Le champ de renommage envoie à chaque frappe : mêler ces noms à la
     * signature de toutes les listes les ferait reconstruire lettre après
     * lettre, et perdre le survol sous le curseur à chaque caractère.
     */
    check('une liste sans aiguillage n\'y gagne aucune signature',
        MP.transitionSignature([piste('A'), piste('B')]) === '',
        'le renommage envoie à chaque frappe : tout reconstruire serait pire');

    const LISTES = fs.readFileSync(
        path.join(ROOT, 'src', 'web', 'public', 'js', 'playlists.js'), 'utf8');
    const FILE = fs.readFileSync(
        path.join(ROOT, 'src', 'web', 'public', 'js', 'queue.js'), 'utf8');

    check('les deux listes consultent la même signature',
        /transitionSignature\(playlist\.tracks \|\| \[\]\)/.test(LISTES)
        && /transitionSignature\(state\.queue \|\| \[\]\)/.test(FILE),
        'deux calculs séparés finiraient par ne pas réveiller les mêmes lignes');

    // L'état doit porter la destination, sinon rien de tout cela n'arrive.
    const SERVER = fs.readFileSync(path.join(ROOT, 'src', 'web', 'WebServer.js'), 'utf8');
    check('l\'état diffusé porte la destination',
        /return \{ isTransition: true, id: t\.id, target: t\.target, url: t\.url \};/.test(SERVER));
    check('  … et les playlists passent par le même formateur',
        /tracks: \(p\.tracks \|\| \[\]\)\.map\(formatTrackWithPreload\)/.test(SERVER));
}

// ───────────────────── Le fondu enchaîné ─────────────────────

console.log('\nVers quoi le mix croise quand un aiguillage suit\n');

{
    /*
     * Le navigateur monte le titre suivant en fond pour le croiser avec celui
     * qui s'achève. Rendu l'aiguillage lui-même, il prenait son adresse
     * `transition:` pour une source à charger : l'élément restait muet, le
     * fondu se faisait vers du silence, et l'on entendait le morceau sortant se
     * prolonger seul.
     *
     * Le journal en gardait la trace, et c'est elle qui a désigné le coupable :
     *
     *     [Mix] FIN fondu #1 | envoi du saut | entrant « — » a 7.76s
     *
     * Un titre vide — celui qu'un aiguillage porte —, dans un bloc qui ne
     * s'exécute que lorsqu'un suivant a bel et bien été trouvé.
     */
    const vm = require('vm');
    const bac = {
        window: {}, console, Number, JSON, Date,
        document: { createElement: () => ({ style: {}, classList: { add() {}, toggle() {} },
            dataset: {}, appendChild() {}, addEventListener() {}, setAttribute() {},
            getAttribute: () => '0' }) },
        localStorage: { getItem: () => null, setItem() {} },
    };
    bac.globalThis = bac;
    vm.createContext(bac);
    for (const f of ['transitions', 'state']) {
        vm.runInContext(fs.readFileSync(
            path.join(ROOT, 'src', 'web', 'public', 'js', `${f}.js`), 'utf8'), bac);
    }
    const MP = bac.window.MusicPlayer;

    const T = (cible) => ({ isTransition: true, id: 't', target: cible, url: 'transition:t' });
    const etat = () => ({
        activePlaybackSource: 'playlist_a',
        playlistCurrentIndex: 0,
        loopPlaylist: false,
        playlists: [
            { id: 'playlist_a', tracks: [piste('A1'), T('queue'), piste('A2')] },
            { id: 'playlist_b', tracks: [piste('B1'), piste('B2')] },
            { id: 'playlist_c', tracks: [T('queue'), piste('C1')] },
        ],
        queue: [piste('Q1'), piste('Q2')],
    });

    const suivant = (e) => MP.nextTrackOf(e);

    check('un aiguillage n\'est jamais préparé comme un morceau',
        !transitions.isTransition(suivant(etat())),
        'son adresse « transition: » ne charge rien, et le fondu se ferait vers du silence');

    check('  … c\'est la destination qui est croisée',
        suivant(etat()).title === 'Q1',
        'le serveur y basculera : les deux prédisent le même morceau');

    {
        const e = etat();
        e.playlists[0].tracks[1] = T('playlist_b');
        check('  … playlist visée comprise', suivant(e).title === 'B1');
    }

    {
        // Une destination qui commence elle-même par un aiguillage : le serveur
        // le consommerait aussitôt et partirait ailleurs encore. Parier serait
        // croiser un morceau qu'on n'entendra pas.
        const e = etat();
        e.playlists[0].tracks[1] = T('playlist_c');
        check('une destination qui s\'aiguille à son tour n\'est pas devinée',
            suivant(e) === null,
            'mieux vaut ne rien préparer, comme en lecture aléatoire');
    }

    {
        const e = etat();
        e.activePlaybackSource = 'queue';
        e.queue = [T('playlist_b'), piste('Q2')];
        check('la file dont la tête est un aiguillage croise sa destination',
            suivant(e).title === 'B1');
    }

    // Ce qui marchait avant doit continuer de marcher.
    {
        const e = etat();
        e.playlists[0].tracks[1] = piste('A1bis');
        check('sans aiguillage, le titre suivant reste le titre suivant',
            suivant(e).title === 'A1bis');
    }
    {
        const e = etat();
        e.activePlaybackSource = 'playlist_b';
        e.playlistCurrentIndex = 1;
        check('  … et une playlist finie passe toujours le relais à la file',
            suivant(e).title === 'Q1');
    }
    {
        const e = etat();
        e.activePlaybackSource = 'playlist_b';
        e.playlistCurrentIndex = 1;
        e.loopPlaylist = true;
        check('  … une playlist en boucle repartant de son premier titre',
            suivant(e).title === 'B1');
    }
    {
        const e = etat();
        e.playlists[0].tracks = [];
        check('  … et une playlist vide ne prépare rien', suivant(e) === null);
    }
}

// ───────────────────── Les traductions ─────────────────────

console.log('\nCe que les quatre langues doivent dire\n');

{
    const CLES = [
        'transition_menu_label', 'transition_target_label', 'transition_target_queue',
        'transition_target_gone', 'transition_no_target', 'transition_insert_before',
        'transition_insert_after', 'transition_row_label', 'transition_row_tooltip',
        'transition_remove', 'transition_edit_title',
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
