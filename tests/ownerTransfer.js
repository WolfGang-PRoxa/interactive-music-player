/**
 * Reprendre l'installation demande d'être devant la machine.
 *
 * `owner.js` pose une règle juste — la propriété revient à qui est devant la
 * machine — et en déduisait une preuve qui a cessé de l'être : tenir le jeton.
 * Celui-ci voyage en `?token=`, se dépose dans l'historique du navigateur,
 * entre dans le manifeste de l'application installée. Qui le récupérait
 * devenait propriétaire, donc pouvait éteindre le bot, installer une version
 * arbitraire, et révoquer le propriétaire légitime.
 *
 * La preuve redevient la console : un code à usage unique y est écrit, et il
 * faut aller l'y lire. Ces cas tiennent la règle des deux côtés, et vérifient
 * surtout que la revendication initiale — celle d'une installation neuve —
 * n'est pas prise dans le même filet.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

/*
 * Un dossier de travail à soi, avant tout `require`.
 *
 * `owner.js` fixe le chemin de `data/owner.json` d'après `process.cwd()` au
 * chargement du module, et ces cas appellent `owner.forget()`, qui efface ce
 * fichier. Lancés depuis le projet, ils emportaient donc la propriété réelle de
 * l'installation — `npm test` déconnectait son propriétaire.
 *
 * On déménage donc avant de charger quoi que ce soit : le module fixe alors son
 * chemin dans un dossier temporaire, et le vrai fichier n'est jamais ouvert.
 */
const bac = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-owner-'));
fs.mkdirSync(path.join(bac, 'data'), { recursive: true });
process.chdir(bac);

const owner = require(path.join(__dirname, '..', 'src', 'web', 'owner'));
const transfer = require(path.join(__dirname, '..', 'src', 'web', 'ownerTransfer'));

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

/*
 * Le code ne sort que par la console : on l'y capte, comme le ferait celui qui
 * est devant la machine. C'est aussi ce qui prouve qu'il n'emprunte aucun
 * autre chemin.
 */
const log = require(path.join(__dirname, '..', 'src', 'utils', 'logger'));
let capture = [];
const realWarn = log.warn.bind(log);
log.warn = (...args) => {
  capture.push(args.join(' '));
};

function ouvrir(user) {
  capture = [];
  const id = transfer.open(user);
  const ligne = capture.find((l) => l.includes('Code à recopier'));
  const code = ligne ? ligne.split(':').pop().trim() : null;
  return { id, code };
}

const ALICE = { id: '111', username: 'alice' };
const BOB = { id: '222', username: 'bob' };

console.log("\n=== Reprise de l'installation ===\n");

/* ── Le code passe par la console, et par elle seule ─────────────────── */

test('le code est écrit dans la console', () => {
  const { code } = ouvrir(ALICE);
  assert.ok(code, 'aucun code trouvé dans la console');
  assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{2}$/, `forme inattendue : ${code}`);
});

test("le code n'est pas rendu à l'appelant", () => {
  const { id, code } = ouvrir(ALICE);
  assert.notStrictEqual(id, code);
  assert.ok(!String(id).includes(code.replace('-', '')), "le code transparaît dans l'identifiant de la demande");
});

test("l'alphabet écarte les caractères qu'on confond", () => {
  for (let i = 0; i < 200; i++) {
    assert.ok(!/[OI01]/.test(transfer.makeCode()), 'caractère ambigu tiré');
  }
});

/* ── Le bon code transfère, et rien d'autre ──────────────────────────── */

test('le bon code transfère la propriété', () => {
  owner.forget();
  owner.claim(BOB);
  assert.ok(owner.isOwner({ userId: '222' }), 'bob devrait être propriétaire');

  const { id, code } = ouvrir(ALICE);
  const verdict = transfer.confirm(id, code, '111');
  assert.strictEqual(verdict.ok, true, `refusé : ${verdict.reason}`);
  assert.ok(owner.isOwner({ userId: '111' }), 'alice aurait dû devenir propriétaire');
});

test('la casse et le tiret sont sans importance', () => {
  owner.forget();
  owner.claim(BOB);
  const { id, code } = ouvrir(ALICE);
  assert.strictEqual(transfer.confirm(id, code.toLowerCase().replace('-', ' '), '111').ok, true);
});

test('un mauvais code ne transfère rien', () => {
  owner.forget();
  owner.claim(BOB);
  const { id } = ouvrir(ALICE);
  const verdict = transfer.confirm(id, 'AAAA-AA', '111');
  assert.strictEqual(verdict.ok, false);
  assert.strictEqual(verdict.reason, 'wrong');
  assert.ok(owner.isOwner({ userId: '222' }), 'bob aurait dû rester propriétaire');
});

test('trois mauvais codes closent la demande', () => {
  owner.forget();
  owner.claim(BOB);
  const { id, code } = ouvrir(ALICE);
  transfer.confirm(id, 'AAAA-AA', '111');
  transfer.confirm(id, 'BBBB-BB', '111');
  transfer.confirm(id, 'CCCC-CC', '111');
  // Le bon code lui-même ne vaut plus rien : la demande n'existe plus.
  assert.strictEqual(transfer.confirm(id, code, '111').reason, 'unknown');
  assert.ok(owner.isOwner({ userId: '222' }), 'bob aurait dû rester propriétaire');
});

/* ── Le code appartient à celui qui l'a demandé ──────────────────────── */

test("un autre compte ne peut pas s'approprier la demande", () => {
  owner.forget();
  owner.claim(BOB);
  const { id, code } = ouvrir(ALICE);
  // Le code a été aperçu, mais c'est une autre session qui le présente.
  const verdict = transfer.confirm(id, code, '333');
  assert.strictEqual(verdict.ok, false);
  assert.strictEqual(verdict.reason, 'mismatch');
  assert.ok(owner.isOwner({ userId: '222' }), 'bob aurait dû rester propriétaire');
});

test("une tentative d'un autre compte ne consomme pas d'essai", () => {
  owner.forget();
  owner.claim(BOB);
  const { id, code } = ouvrir(ALICE);
  transfer.confirm(id, 'AAAA-AA', '333');
  transfer.confirm(id, 'BBBB-BB', '333');
  transfer.confirm(id, 'CCCC-CC', '333');
  // Le demandeur légitime doit toujours pouvoir aboutir.
  assert.strictEqual(transfer.confirm(id, code, '111').ok, true);
});

/* ── Une demande ne sert qu'une fois ─────────────────────────────────── */

test('une demande consommée ne se rejoue pas', () => {
  owner.forget();
  owner.claim(BOB);
  const { id, code } = ouvrir(ALICE);
  assert.strictEqual(transfer.confirm(id, code, '111').ok, true);
  assert.strictEqual(transfer.confirm(id, code, '111').reason, 'unknown');
});

test('un identifiant inventé ne vaut rien', () => {
  assert.strictEqual(transfer.confirm('jamais-emis', 'AAAA-AA', '111').reason, 'unknown');
});

test('peek décrit la demande sans livrer le code', () => {
  transfer.reset();
  const { id, code } = ouvrir(ALICE);
  const vue = transfer.peek(id);
  assert.strictEqual(vue.username, 'alice');
  assert.strictEqual(vue.userId, '111');
  assert.ok(!JSON.stringify(vue).includes(code.replace('-', '')), 'le code fuite par peek()');
});

/* ── La revendication initiale n'est pas concernée ───────────────────── */

test('une installation neuve se revendique sans code', () => {
  owner.forget();
  assert.strictEqual(owner.isClaimed(), false);
  owner.claim(ALICE);
  assert.ok(owner.isOwner({ userId: '111' }), 'la première revendication ne doit rien demander de plus');
});

log.warn = realWarn;
owner.forget();

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
