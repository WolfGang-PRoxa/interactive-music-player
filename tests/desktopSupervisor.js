/**
 * Sous l'application de bureau, le bot ne se relance pas lui-même.
 *
 * Hors application, un redémarrage lance une instance détachée puis sort.
 * Sous l'application, cette instance lui échapperait : elle croirait le bot
 * mort, et n'aurait plus de prise sur lui pour l'éteindre avec la fenêtre. Le
 * bot dépose donc le point d'entrée voulu et sort avec le code 75 ; c'est
 * l'application qui relance (desktop/src-tauri/src/supervisor.rs).
 *
 * Ces cas tiennent le contrat des deux côtés : le fichier et le code de sortie
 * attendus par l'application, et l'absence de tout processus détaché.
 */

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Un dossier de travail à soi, avant tout `require` : plusieurs modules fixent
// leurs chemins d'après `process.cwd()` au chargement, et la demande de relance
// s'écrit dans `data/` de la racine partagée.
const bac = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-supervisor-'));
fs.mkdirSync(path.join(bac, 'data'), { recursive: true });
process.chdir(bac);

const supervisor = require(path.join(__dirname, '..', 'src', 'utils', 'supervisor'));
const systemHandlers = require(path.join(__dirname, '..', 'src', 'web', 'websocket', 'handlers', 'systemHandlers'));

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  ok    ${name}`);
        passed++;
    } catch (err) {
        console.log(`  FAIL  ${name}`);
        console.log(`        ${err.message}`);
        failed++;
    }
}

/** Un serveur web factice : restartProcess ne fait que le fermer. */
function fakeWebServer() {
    return { wss: { close() {} }, server: { close() {} } };
}

/**
 * Exécute `fn` en interceptant `process.exit` et `child_process.spawn`.
 * La sortie lève, pour couper court au reste de la fonction comme le ferait
 * la vraie.
 */
function intercept(fn) {
    const realExit = process.exit;
    const realSpawn = childProcess.spawn;
    const seen = { exitCode: null, spawned: 0 };
    // Seule la première sortie compte : la vraie ne rend pas la main, et le
    // `catch` de la fonction, qui rattrape l'exception levée ici pour imiter
    // cette coupure, appellerait sinon une seconde sortie en erreur.
    process.exit = (code) => {
        if (seen.exitCode === null) seen.exitCode = code;
        throw new Error('__exit__');
    };
    childProcess.spawn = () => {
        seen.spawned++;
        return { unref() {} };
    };
    try {
        fn();
    } catch (err) {
        if (err.message !== '__exit__') throw err;
    } finally {
        process.exit = realExit;
        childProcess.spawn = realSpawn;
    }
    return seen;
}

console.log('\nSupervision par l\'application de bureau\n');

test('la supervision se lit dans IMP_SUPERVISOR=desktop, et nulle part ailleurs', () => {
    assert.strictEqual(supervisor.isSupervised({ IMP_SUPERVISOR: 'desktop' }), true);
    assert.strictEqual(supervisor.isSupervised({ IMP_SUPERVISOR: '1' }), false);
    assert.strictEqual(supervisor.isSupervised({}), false);
});

test('le code de relance est 75, distinct des sorties ordinaires du bot', () => {
    assert.strictEqual(supervisor.RESTART_EXIT_CODE, 75);
});

test('la demande de relance porte un chemin absolu, dans data/', () => {
    const file = supervisor.writeRestartRequest(path.join('versions', 'v2', 'src', 'index.js'), bac);
    assert.strictEqual(file, path.join(bac, 'data', supervisor.RESTART_REQUEST));
    const request = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(path.isAbsolute(request.entryPoint));
    assert.ok(request.entryPoint.endsWith(path.join('versions', 'v2', 'src', 'index.js')));
    fs.unlinkSync(file);
});

test('supervisé, un redémarrage dépose sa demande et sort en 75, sans rien détacher', () => {
    process.env.IMP_SUPERVISOR = 'desktop';
    try {
        const target = path.join(bac, 'versions', 'v3', 'src', 'index.js');
        const seen = intercept(() => systemHandlers.restartProcess(fakeWebServer(), { entryPoint: target }));
        assert.strictEqual(seen.exitCode, 75);
        assert.strictEqual(seen.spawned, 0);
        const request = JSON.parse(fs.readFileSync(path.join(bac, 'data', supervisor.RESTART_REQUEST), 'utf8'));
        assert.strictEqual(request.entryPoint, target);
    } finally {
        delete process.env.IMP_SUPERVISOR;
        fs.rmSync(path.join(bac, 'data', supervisor.RESTART_REQUEST), { force: true });
    }
});

test('hors application, le redémarrage se fait comme avant : instance détachée, sortie en 0', () => {
    const seen = intercept(() => systemHandlers.restartProcess(fakeWebServer(), { entryPoint: __filename }));
    assert.strictEqual(seen.exitCode, 0);
    assert.strictEqual(seen.spawned, 1);
    assert.ok(!fs.existsSync(path.join(bac, 'data', supervisor.RESTART_REQUEST)));
});

fs.rmSync(bac, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
