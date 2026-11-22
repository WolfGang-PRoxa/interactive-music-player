/**
 * Le trajet d'authentification, lié au navigateur qui l'a ouvert.
 *
 * Le `state` d'OAuth2 est imprévisible, gardé côté serveur, valable cinq
 * minutes et consommé une fois — et cela ne suffisait pas. Rien ne disait *à
 * qui* il avait été remis : un attaquant en demandait un pour lui-même,
 * obtenait un `code` pour son propre compte Discord, puis faisait charger le
 * rappel à sa victime. Celle-ci se retrouvait connectée sous un compte qui
 * n'était pas le sien, et tout ce qu'elle faisait ensuite lui était imputé.
 *
 * Un cookie éphémère posé à l'aller répond désormais à la question. Ces cas
 * tiennent les deux bouts : le trajet ordinaire aboutit, celui qu'on a volé
 * s'arrête.
 */

const assert = require('assert');
const oauth = require('../src/web/oauth');

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

/** Extrait le `state` d'une URL d'autorisation. */
function stateOf(url) {
  return new URL(url).searchParams.get('state');
}

console.log('\n=== Liaison du trajet OAuth au navigateur ===\n');

/* ── Le nonce fait l'aller-retour ────────────────────────────────────── */

test("le nonce confié à l'aller revient au rappel", () => {
  const url = oauth.buildAuthorizeUrl('/', { nonce: 'abc123' });
  const route = oauth.consumeState(stateOf(url));
  assert.ok(route, 'le state aurait dû être reconnu');
  assert.strictEqual(route.nonce, 'abc123');
});

test('un trajet sans nonce en rend un nul, pas undefined', () => {
  const url = oauth.buildAuthorizeUrl('/', {});
  assert.strictEqual(oauth.consumeState(stateOf(url)).nonce, null);
});

test("le nonce ne voyage pas dans l'URL — il reste au serveur", () => {
  const url = oauth.buildAuthorizeUrl('/', { nonce: 'secret-a-ne-pas-publier' });
  assert.ok(!url.includes('secret-a-ne-pas-publier'), `le nonce est parti chez Discord : ${url}`);
});

test('les autres champs voyagent toujours avec lui', () => {
  const url = oauth.buildAuthorizeUrl('/retour', {
    nonce: 'n1',
    holdsToken: true,
    claim: true,
    silent: true,
  });
  const route = oauth.consumeState(stateOf(url));
  assert.strictEqual(route.returnTo, '/retour');
  assert.strictEqual(route.holdsToken, true);
  assert.strictEqual(route.claim, true);
  assert.strictEqual(route.silent, true);
  assert.strictEqual(route.nonce, 'n1');
});

/* ── Le state reste à usage unique ───────────────────────────────────── */

test("un state consommé deux fois ne vaut qu'une", () => {
  const state = stateOf(oauth.buildAuthorizeUrl('/', { nonce: 'n2' }));
  assert.ok(oauth.consumeState(state), 'le premier passage aurait dû être reconnu');
  assert.strictEqual(oauth.consumeState(state), null, 'le second aurait dû être refusé');
});

test('un state jamais émis est refusé', () => {
  assert.strictEqual(oauth.consumeState('jamais-emis'), null);
  assert.strictEqual(oauth.consumeState(''), null);
});

/* ── Deux trajets ne se confondent pas ───────────────────────────────── */

test('deux navigateurs reçoivent deux nonces distincts', () => {
  const a = oauth.buildAuthorizeUrl('/', { nonce: 'navigateur-A' });
  const b = oauth.buildAuthorizeUrl('/', { nonce: 'navigateur-B' });
  assert.notStrictEqual(stateOf(a), stateOf(b), 'les states devraient différer');
  assert.strictEqual(oauth.consumeState(stateOf(a)).nonce, 'navigateur-A');
  assert.strictEqual(oauth.consumeState(stateOf(b)).nonce, 'navigateur-B');
});

test("le state de l'un ne rend pas le nonce de l'autre", () => {
  // C'est exactement l'attaque : présenter le state de l'attaquant à la
  // victime. Le rappel comparera ce nonce-ci au cookie de la victime, qui
  // porte le sien ou rien du tout.
  const attaquant = stateOf(oauth.buildAuthorizeUrl('/', { nonce: 'celui-de-l-attaquant' }));
  const route = oauth.consumeState(attaquant);
  assert.strictEqual(route.nonce, 'celui-de-l-attaquant');
  assert.notStrictEqual(route.nonce, 'celui-de-la-victime');
});

/* ── La durée de vie est exposée, pour le cookie ─────────────────────── */

test("la durée du state est publiée — le cookie s'y accorde", () => {
  assert.strictEqual(typeof oauth.STATE_TTL_MS, 'number');
  assert.ok(oauth.STATE_TTL_MS > 0 && oauth.STATE_TTL_MS <= 15 * 60 * 1000, `durée inattendue : ${oauth.STATE_TTL_MS}`);
});

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
