/**
 * AttachmentExtractor lit les fichiers locaux avec le file-type corrigé.
 *
 * `@discord-player/extractor` impose `file-type@^16.5.4`, qui boucle sans fin
 * sur un ASF malformé (GHSA-5v7r-6r5c-r473). Le paquet du projet impose la
 * version corrigée par ses `overrides`, et `src/utils/fileTypeCompat.js` lui
 * rend l'ancien nom `fromFile` que l'extracteur appelle.
 *
 * Ces cas tiennent les deux bouts : l'extracteur reconnaît toujours un fichier
 * audio et en refuse un qui n'en est pas un, et l'ASF piégé ne bloque plus rien.
 */

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'src', 'utils', 'fileTypeCompat')).installFileTypeCompat();

const { AttachmentExtractor } = require('@discord-player/extractor');
const { QueryType } = require('discord-player');

const bac = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-filetype-'));

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

/** Un extracteur sans lecteur : seule la branche « fichier local » sert ici. */
function extractor() {
  const e = Object.create(AttachmentExtractor.prototype);
  e.context = { player: { options: {}, debug() {} } };
  e.emptyResponse = () => ({ playlist: null, tracks: [] });
  e.createResponse = (playlist, tracks) => ({ playlist, tracks });
  return e;
}

/**
 * Un en-tête ASF dont le premier sous-objet annonce une taille nulle : c'est
 * l'entrée qui faisait boucler file-type 16.
 */
function malformedAsf() {
  const headerGuid = Buffer.from('3026b2758e66cf11a6d900aa0062ce6c', 'hex');
  const header = Buffer.alloc(30);
  headerGuid.copy(header, 0);
  header.writeBigUInt64LE(BigInt(30 + 24 + 64), 16);
  header.writeUInt32LE(1, 24);
  const subObject = Buffer.alloc(24);
  Buffer.from('b503bf5f2ea9cf118ee300c00c205365', 'hex').copy(subObject, 0);
  subObject.writeBigUInt64LE(0n, 16);
  return Buffer.concat([header, subObject, Buffer.alloc(64)]);
}

(async () => {
  await test("la version de file-type chargée par l'extracteur est corrigée (>= 21.3.1)", () => {
    const extractorEntry = require.resolve('@discord-player/extractor');
    const pkgPath = path.join(
      path.dirname(require('module').createRequire(extractorEntry).resolve('file-type')),
      'package.json',
    );
    const [major, minor, patch] = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version.split('.').map(Number);
    assert.ok(
      major > 21 || (major === 21 && (minor > 3 || (minor === 3 && patch >= 1))),
      `file-type ${major}.${minor}.${patch}`,
    );
  });

  await test('un fichier audio local est toujours reconnu', async () => {
    const mp3 = path.join(bac, 'bip.mp3');
    childProcess.execFileSync(require('ffmpeg-static'), [
      '-y',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=d=1',
      mp3,
    ]);
    const result = await extractor().handle(mp3, { type: QueryType.FILE });
    assert.strictEqual(result.tracks.length, 1);
    assert.strictEqual(result.tracks[0].title, 'bip.mp3');
  });

  await test("un fichier qui n'est pas un média est refusé", async () => {
    const text = path.join(bac, 'notes.mp3');
    fs.writeFileSync(text, 'pas de musique ici\n'.repeat(100));
    const result = await extractor().handle(text, { type: QueryType.FILE });
    assert.strictEqual(result.tracks.length, 0);
  });

  await test('un ASF malformé ne bloque plus le processus', () => {
    const asf = path.join(bac, 'piege.wma');
    fs.writeFileSync(asf, malformedAsf());
    // Dans un processus à part : une boucle infinie ici gèlerait le test lui-même.
    const script = `
            require(${JSON.stringify(path.join(ROOT, 'src', 'utils', 'fileTypeCompat'))}).installFileTypeCompat();
            const { createRequire } = require('module');
            const r = createRequire(require.resolve('@discord-player/extractor'));
            r('file-type').fromFile(${JSON.stringify(asf)}).then(() => process.exit(0), () => process.exit(0));
        `;
    const run = childProcess.spawnSync(process.execPath, ['-e', script], { cwd: ROOT, timeout: 10000 });
    assert.strictEqual(run.signal, null, 'le processus a dû être tué : file-type boucle');
    assert.strictEqual(run.status, 0, String(run.stderr));
  });

  fs.rmSync(bac, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
