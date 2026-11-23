/**
 * Le tableau de bord s'ouvre avant que le bot soit connecté à Discord.
 *
 * L'application de bureau s'affiche aussitôt lancée : le serveur web écoute
 * donc dès le début du process (`WebServer.listen`), et `WebServer.start` ne
 * fait plus que lever la barrière une fois le client Discord prêt. Entre les
 * deux, rien de ce qui demande un serveur Discord, une file ou le lecteur ne
 * doit s'exécuter, et l'état de lecture de la session précédente — pas encore
 * restauré — ne doit jamais être écrasé.
 *
 * Ces cas tiennent cette barrière : les messages WebSocket, les routes HTTP, le
 * redémarrage, et l'ordre de démarrage de src/index.js.
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

// Un dossier de travail à soi, avant tout `require` : plusieurs modules fixent
// leurs chemins d'après `process.cwd()` au chargement.
const bac = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-startup-'));
fs.mkdirSync(path.join(bac, 'data'), { recursive: true });
process.chdir(bac);

const SRC = path.join(__dirname, '..', 'src');

// Des gestionnaires factices, posés dans le cache avant que wsHandler ne
// charge les vrais : on veut savoir lesquels il appelle, pas les exécuter.
const calls = [];
const handlersPath = require.resolve(path.join(SRC, 'web', 'websocket', 'handlers'));
const fakeHandler = (type) => (ctx) => calls.push({ type, queue: ctx.queue });
require.cache[handlersPath] = {
  id: handlersPath,
  filename: handlersPath,
  loaded: true,
  exports: {
    play: fakeHandler('play'),
    requestState: fakeHandler('requestState'),
    shutdownBot: fakeHandler('shutdownBot'),
    restartBot: fakeHandler('restartBot'),
  },
};

const wsHandler = require(path.join(SRC, 'web', 'websocket', 'wsHandler'));

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
    failed++;
  }
}

const master = () => ({ identity: { master: true }, selectedGuildId: null, send() {} });

/** Un serveur web factice : ni client Discord, ni serveur connu. */
function startingServer(ready = false) {
  return {
    ready,
    client: null,
    wss: { clients: new Set(), close() {} },
    server: { close() {} },
    _getFirstGuildId: () => null,
    ensurePlaybackQueue: () => {
      throw new Error('ensurePlaybackQueue ne doit pas être appelé pendant le démarrage');
    },
  };
}

function get(server, pathname) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    http
      .get({ host: '127.0.0.1', port, path: pathname }, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      })
      .on('error', reject);
  });
}

(async () => {
  console.log('\nTableau de bord ouvert pendant le démarrage\n');

  await test('pendant le démarrage, un message de lecture est écarté sans appeler son gestionnaire', async () => {
    calls.length = 0;
    await wsHandler.handleMessage(master(), { type: 'play', guildId: '123', data: {} }, startingServer());
    await wsHandler.handleMessage(master(), { type: 'requestState' }, startingServer());
    assert.deepStrictEqual(calls, []);
  });

  await test("l'extinction et le redémarrage passent, même sans aucun serveur Discord", async () => {
    calls.length = 0;
    await wsHandler.handleMessage(master(), { type: 'shutdownBot' }, startingServer());
    await wsHandler.handleMessage(master(), { type: 'restartBot' }, startingServer());
    assert.deepStrictEqual(
      calls.map((c) => c.type),
      ['shutdownBot', 'restartBot'],
    );
    assert.ok(calls.every((c) => c.queue === null));
  });

  await test('un invité ne peut toujours pas éteindre le bot pendant le démarrage', async () => {
    calls.length = 0;
    const guest = { identity: { master: false, session: { userId: '42' } }, selectedGuildId: null, send() {} };
    await wsHandler.handleMessage(guest, { type: 'shutdownBot' }, startingServer());
    assert.deepStrictEqual(calls, []);
  });

  await test("redémarrer pendant le démarrage n'écrase pas l'état de lecture sauvegardé", () => {
    const managerPath = require.resolve(path.join(SRC, 'database', 'PlaybackStateManager'));
    const manager = require(managerPath);
    const realSave = manager.saveState;
    const realExit = process.exit;
    let saved = 0;
    let exitCode = null;
    manager.saveState = () => saved++;
    process.env.IMP_SUPERVISOR = 'desktop';
    process.exit = (code) => {
      if (exitCode === null) exitCode = code;
      throw new Error('__exit__');
    };
    try {
      const { restartProcess } = require(path.join(SRC, 'web', 'websocket', 'handlers', 'systemHandlers'));
      try {
        restartProcess(startingServer(), { entryPoint: path.join(bac, 'src', 'index.js') });
      } catch (err) {
        if (err.message !== '__exit__') throw err;
      }
      assert.strictEqual(saved, 0);
      assert.strictEqual(exitCode, 75);
    } finally {
      manager.saveState = realSave;
      process.exit = realExit;
      delete process.env.IMP_SUPERVISOR;
    }
  });

  await test('les routes HTTP qui demandent le bot répondent 503, la version et la documentation non', async () => {
    const express = require('express');
    const createApiRouter = require(path.join(SRC, 'web', 'routes', 'api'));
    const webServer = startingServer();
    const app = express();
    app.use('/api', createApiRouter(webServer));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const state = await get(server, '/api/state');
      assert.strictEqual(state.status, 503);
      assert.strictEqual(JSON.parse(state.body).starting, true);

      const version = await get(server, '/api/version');
      assert.strictEqual(version.status, 200);

      // La barrière levée, la route répond selon ses propres règles.
      webServer.ready = true;
      const after = await get(server, '/api/state');
      assert.notStrictEqual(after.status, 503);
    } finally {
      server.close();
    }
  });

  await test('src/index.js ouvre le serveur avant de charger le lecteur et de se connecter à Discord', () => {
    const source = fs.readFileSync(path.join(SRC, 'index.js'), 'utf8');
    const listen = source.indexOf('webServer.listen(');
    const player = source.indexOf('await initPlayer()');
    const login = source.indexOf('await client.login(');
    assert.ok(listen > 0, 'webServer.listen() introuvable');
    assert.ok(listen < player && listen < login, "le serveur doit s'ouvrir avant le lecteur et la connexion");
  });

  // Windows refuse d'effacer le dossier courant d'un processus : on en sort d'abord.
  process.chdir(__dirname);
  fs.rmSync(bac, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
