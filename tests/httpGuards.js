/**
 * Les droits sur les routes HTTP.
 *
 * `permissions.js` n'était branché que sur le WebSocket : un invité sans un
 * seul droit coché parcourait l'arborescence du disque de l'hôte et détournait
 * le dossier des téléchargements, deux gestes que le même invité se voyait
 * refuser sur la socket. Ces cas tiennent la règle des deux côtés — ce qui doit
 * passer passe, ce qui ne doit pas est refusé — et gardent surtout les deux
 * portes qu'il ne faut pas refermer par mégarde : le lanceur, qui interroge le
 * bot avec le jeton et sans session Discord, et l'invité admis, qui doit garder
 * ce que le maître lui a accordé.
 */

const assert = require('assert');
const express = require('express');
const http = require('http');

const { createGuards } = require('../src/web/httpGuards');

let passed = 0;
let failed = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  ok    ${name}`);
      passed++;
    })
    .catch((err) => {
      console.log(`  FAIL  ${name}`);
      console.log(`        ${err.message}`);
      failed++;
    });
}

/* ── Un banc minimal ─────────────────────────────────────────────────────
 *
 * Les droits d'un invité sont lus dans la base ; on la remplace par une table
 * en mémoire pour n'éprouver que la garde. `require` est détourné avant que
 * httpGuards ne soit chargé par la route, donc au chargement du module.
 */
const database = require('../src/database/Database');
const realGetUserPermissions = database.getUserPermissions;

/** userId → jeu de droits rendu par la base. */
let grants = {};
database.getUserPermissions = (guildId, userId) => grants[userId] || {};

const webServer = { _getFirstGuildId: () => 'G1' };
const { local, right } = createGuards(webServer);

const app = express();

/** L'identité est injectée par l'en-tête, pour changer de rôle d'un appel à l'autre. */
app.use((req, res, next) => {
  const role = req.headers['x-role'];
  if (role === 'master') {
    req.identity = { authorized: true, master: true, holdsToken: true, session: null };
  } else if (role === 'token') {
    // Le lanceur : le jeton, aucune session Discord.
    req.identity = {
      authorized: true,
      master: false,
      holdsToken: true,
      session: null,
      pendingLogin: true,
    };
  } else if (role === 'guest') {
    req.identity = {
      authorized: true,
      master: false,
      holdsToken: false,
      session: { userId: req.headers['x-user'] || 'U1' },
    };
  } else {
    req.identity = { authorized: true, master: false, holdsToken: false, session: null };
  }
  next();
});

app.get('/local', local, (req, res) => res.json({ ok: true }));
app.get('/add', right('queue.add'), (req, res) => res.json({ ok: true }));
app.get('/dl', right('queue.download'), (req, res) => res.json({ ok: true }));

const server = http.createServer(app);

function call(route, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: route, headers }, (res) => {
      let body = '';
      res.on('data', (c) => {
        body += c;
      });
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(body);
        } catch (e) {
          /* pas du JSON */
        }
        resolve({ status: res.statusCode, body, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

server.listen(0, '127.0.0.1', async () => {
  console.log('\n=== Droits sur les routes HTTP ===\n');

  /* ── `local` : être devant la machine ─────────────────────────────── */

  await test('le maître passe', async () => {
    assert.strictEqual((await call('/local', { 'x-role': 'master' })).status, 200);
  });

  await test("le porteur du jeton passe — c'est le lanceur", async () => {
    assert.strictEqual((await call('/local', { 'x-role': 'token' })).status, 200);
  });

  await test("l'invité est refusé", async () => {
    assert.strictEqual((await call('/local', { 'x-role': 'guest' })).status, 403);
  });

  await test('le refus est du JSON, jamais du HTML', async () => {
    const res = await call('/local', { 'x-role': 'guest' });
    assert.ok(res.json, `corps non analysable : ${res.body.slice(0, 80)}`);
    assert.strictEqual(res.json.error, 'Droit refusé');
  });

  /* ── `right` : le droit nommé ─────────────────────────────────────── */

  await test('un invité sans aucun droit est refusé', async () => {
    grants = {};
    assert.strictEqual((await call('/add', { 'x-role': 'guest' })).status, 403);
  });

  await test('un invité pourvu du droit passe', async () => {
    grants = { U1: { 'queue.add': true } };
    assert.strictEqual((await call('/add', { 'x-role': 'guest' })).status, 200);
  });

  await test("le droit accordé n'en ouvre pas un autre", async () => {
    grants = { U1: { 'queue.add': true } };
    assert.strictEqual((await call('/dl', { 'x-role': 'guest' })).status, 403);
  });

  await test('un droit à false vaut un droit absent', async () => {
    grants = { U1: { 'queue.add': false } };
    assert.strictEqual((await call('/add', { 'x-role': 'guest' })).status, 403);
  });

  await test("le maître n'a besoin d'aucun droit coché", async () => {
    grants = {};
    assert.strictEqual((await call('/add', { 'x-role': 'master' })).status, 200);
    assert.strictEqual((await call('/dl', { 'x-role': 'master' })).status, 200);
  });

  await test("le porteur du jeton seul n'a pas les droits d'un invité admis", async () => {
    // `local` lui est ouvert, `right` non : il n'a pas de compte Discord, donc
    // aucun jeu de droits à consulter. Le tableau de bord lui demande d'abord
    // de se nommer (pendingLogin).
    grants = {};
    assert.strictEqual((await call('/add', { 'x-role': 'token' })).status, 403);
  });

  await test('une session sans identité ne vaut rien', async () => {
    assert.strictEqual((await call('/local', { 'x-role': 'none' })).status, 403);
    assert.strictEqual((await call('/add', { 'x-role': 'none' })).status, 403);
  });

  await test('le refus nomme le droit manquant', async () => {
    grants = {};
    const res = await call('/dl', { 'x-role': 'guest' });
    assert.strictEqual(res.json.action, 'queue.download');
  });

  database.getUserPermissions = realGetUserPermissions;
  server.close();
  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
});
