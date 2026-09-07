/**
 * Vérifie qui frappe, qui entre, et qui n'a rien à faire dans la liste.
 *
 * Un invité qui suit le lien de partage se nomme avec Discord, puis n'obtient
 * rien : les droits ne s'héritent pas d'une authentification. Trois choses
 * devaient être démêlées, et aucune ne se voit dans un diff.
 *
 *  - **Être admis n'est pas avoir des droits.** `setUserPermissions` retire de
 *    la table l'invité qui n'a plus aucun droit — c'est ce qui empêche le
 *    fichier de se remplir de « quatre fois non ». Accepter quelqu'un sans rien
 *    lui accorder le faisait donc disparaître aussitôt, et retomber dans la file
 *    des demandes. D'où une admission qui se range à part.
 *
 *  - **Le maître n'est pas son propre invité.** Il apparaissait dans sa propre
 *    fenêtre dès qu'il était dans le salon vocal, avec des cases pour s'accorder
 *    ce qu'il détient déjà. En ouvrant le tableau de bord depuis un second
 *    poste, on se voyait rangé parmi les auditeurs et l'on croyait être devenu
 *    invité chez soi.
 *
 *  - **Refuser doit tout défaire.** Une révocation qui laisserait l'admission
 *    en place rendrait l'invité invisible des deux côtés : plus dans la file,
 *    et sans aucun droit dans la liste.
 *
 * Le magasin est éprouvé pour de vrai dans un dossier jetable ; la liste
 * affichée l'est sur sa fonction, extraite du module livré.
 */
const fs = require('fs');
const os = require('os');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let failed = 0;
let passed = 0;
const check = (label, ok, detail = '') => {
    if (ok) { passed++; console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`); }
    else { failed++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
};

// Dossier jetable choisi avant tout require : Database écrit dans data/ du
// répertoire courant, et un test n'a rien à faire près des réglages réels.
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'invites-'));
fs.mkdirSync(path.join(SANDBOX, 'data'));
const CWD = process.cwd();
process.chdir(SANDBOX);
const database = require(path.join(ROOT, 'src', 'database', 'Database.js'));

console.log('\n=== Qui frappe, qui entre ===\n');

// ───────────────────── Admettre sans accorder ─────────────────────

console.log('Admettre n\'est pas accorder\n');

{
    const G = 'guilde-1';

    database.setUserPermissions(G, '111', { playback: true });
    check('un droit accordé se retient', database.getSharedControl(G)['111']);

    /*
     * Le comportement qui rendait l'admission nécessaire : tout décocher retire
     * l'invité de la table. Sans magasin à part, « accepté sans droits » et
     * « jamais vu » seraient le même état.
     */
    database.setUserPermissions(G, '111', {});
    check('tout décocher le retire de la table',
        database.getSharedControl(G)['111'] === undefined,
        'd\'où une admission rangée ailleurs');

    database.admitGuest(G, '222');
    check('une admission tient sans le moindre droit',
        database.getAdmittedGuests(G).includes('222')
        && database.getSharedControl(G)['222'] === undefined);

    database.admitGuest(G, '222');
    check('  … et ne se dédouble pas',
        database.getAdmittedGuests(G).filter((u) => u === '222').length === 1);

    database.dismissGuest(G, '222');
    check('la retirer la retire vraiment',
        !database.getAdmittedGuests(G).includes('222'));

    check('retirer une admission absente ne casse rien',
        (database.dismissGuest(G, 'jamais-vu'), true));

    // Les identifiants Discord voyagent tantôt en nombre, tantôt en chaîne.
    database.admitGuest(G, 333);
    check('un identifiant numérique est rangé comme une chaîne',
        database.getAdmittedGuests(G).includes('333'));
}

process.chdir(CWD);
fs.rmSync(SANDBOX, { recursive: true, force: true });

// ───────────────────── La liste affichée ─────────────────────

console.log('\nQui figure dans la fenêtre de partage\n');

/**
 * Extrait `listeners()` du module livré et l'exécute seule.
 *
 * Le module entier suppose un DOM et une socket ; cette fonction-ci ne lit que
 * l'état. La découper est le seul moyen de l'éprouver sur le fichier réel.
 */
function listenersOf(state, sharing) {
    const SOURCE = fs.readFileSync(
        path.join(ROOT, 'src', 'web', 'public', 'js', 'sharedControl.js'), 'utf8');
    const start = SOURCE.indexOf('    function listeners() {');
    const end = SOURCE.indexOf('    function initial(', start);
    if (start < 0 || end < 0) throw new Error('listeners() introuvable');

    const sandbox = { window: { MusicPlayer: { state } }, sharing, console };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(`${SOURCE.slice(start, end)}\nglobalThis.__out = listeners();`, sandbox);
    return sandbox.__out;
}

{
    const moi = '999';
    const state = {
        role: 'master',
        identity: { userId: moi },
        members: [
            { id: moi, displayName: 'L\'hôte' },
            { id: '111', displayName: 'Marie' },
        ],
    };

    const rows = listenersOf(state, { knownUsers: [], grants: {}, admitted: [] });
    const ids = rows.map((r) => r.userId);

    check('le maître ne figure pas dans sa propre liste', !ids.includes(moi),
        's\'accorder à soi-même ce qu\'on détient déjà n\'a pas de sens');
    check('  … mais les autres du salon vocal, oui', ids.includes('111'));
}

{
    // Le cas qui a mis la puce à l'oreille : l'hôte rejoint son tableau de bord
    // depuis un second poste, par le lien de partage. Même compte, même
    // propriété — il ne doit pas se découvrir invité chez lui.
    const moi = '999';
    const rows = listenersOf(
        { role: 'master', identity: { userId: moi }, members: [] },
        { knownUsers: [{ userId: moi, displayName: 'L\'hôte' }], grants: {}, admitted: [moi] });

    check('l\'hôte connecté depuis un autre poste ne s\'y range pas non plus',
        rows.length === 0, `${rows.length} ligne(s)`);
}

{
    const state = { role: 'master', identity: { userId: '999' }, members: [] };
    const connus = [{ userId: '111', displayName: 'Marie' }];

    const sans = listenersOf(state, { knownUsers: connus, grants: {}, admitted: [] });
    check('un compte connu, ni admis ni pourvu, reste hors de la liste',
        sans.length === 0, 'sinon elle s\'allongerait de tous les passages');

    const admis = listenersOf(state, { knownUsers: connus, grants: {}, admitted: ['111'] });
    check('  … mais un admis sans droits y figure',
        admis.length === 1 && admis[0].userId === '111',
        'c\'est là, et nulle part ailleurs, qu\'on lui en accordera');

    const pourvu = listenersOf(state,
        { knownUsers: connus, grants: { 111: { playback: true } }, admitted: [] });
    check('  … et un pourvu aussi, même sans admission explicite',
        pourvu.length === 1 && pourvu[0].rights.playback === true);
}

// ───────────────────── Le raccordement ─────────────────────

console.log('\nCe qui tient les deux bouts\n');

{
    const SHARE = fs.readFileSync(
        path.join(ROOT, 'src', 'web', 'websocket', 'handlers', 'shareHandlers.js'), 'utf8');
    const CLIENT = fs.readFileSync(
        path.join(ROOT, 'src', 'web', 'public', 'js', 'sharedControl.js'), 'utf8');
    const PERMS = fs.readFileSync(path.join(ROOT, 'src', 'web', 'permissions.js'), 'utf8');

    check('accepter n\'accorde aucun droit',
        /type: 'admitGuest'/.test(CLIENT) && !/permissions: \{ playback: true \}/.test(CLIENT),
        'la gestion des droits par défaut viendra plus tard');

    check('refuser défait aussi l\'admission',
        /revokeUserPermissions\(currentGuildId, userId\);\s*\n\s*database\.dismissGuest/.test(SHARE),
        'sinon l\'invité serait invisible des deux côtés');

    check('admettre est réservé au maître',
        /admitGuest: MASTER_ONLY/.test(PERMS));
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
