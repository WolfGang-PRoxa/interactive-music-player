/**
 * Vérifie l'envoi d'un fichier en morceaux.
 *
 * Derrière un tunnel Cloudflare, une requête ne passe pas au-delà de 100 Mo.
 * Le navigateur découpe donc les gros fichiers, et le serveur les recolle.
 *
 * Ce que ce test protège :
 *
 *  - **Le fichier recollé est le fichier envoyé**, et il se range sous le même
 *    nom qu'envoyé d'un seul tenant : le nom dérive de l'empreinte du contenu.
 *
 *  - **Un morceau coupé en route se renvoie sans laisser de trace.** S'il avait
 *    nourri le fichier et l'empreinte, le contenu final porterait deux fois son
 *    début.
 *
 *  - **Le serveur dit toujours quel morceau il attend**, pour que le navigateur
 *    reprenne au lieu de tout renvoyer.
 *
 *  - **`MAX_UPLOAD_MB` porte sur le total**, pas sur chaque morceau.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');

const ROOT = path.join(__dirname, '..');
const chunked = require(path.join(ROOT, 'src', 'web', 'chunkedUpload.js'));

let failed = 0;
let passed = 0;
const check = (label, ok, detail = '') => {
  if (ok) {
    passed++;
    console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-chunks-'));
const id = () => crypto.randomBytes(16).toString('hex');

/** Une requête factice qui porte ces octets. */
function body(buffer) {
  return Readable.from([buffer]);
}

/** Une requête qui se coupe après avoir livré une partie de ses octets. */
function cut(buffer) {
  const stream = new Readable({ read() {} });
  stream.push(buffer.subarray(0, Math.floor(buffer.length / 2)));
  setImmediate(() => {
    stream.emit('aborted');
    stream.destroy();
  });
  return stream;
}

const send = (uploadId, index, total, buffer, extra = {}) =>
  chunked.receiveChunk(buffer instanceof Readable ? buffer : body(buffer), {
    uploadId,
    index,
    total,
    name: 'concert.mkv',
    maxBytes: 1024 * 1024,
    dir: DIR,
    ...extra,
  });

const fails = async (promise) => {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
};

(async () => {
  console.log("\n=== L'envoi en morceaux ===\n");

  const parts = [crypto.randomBytes(1000), crypto.randomBytes(1000), crypto.randomBytes(500)];
  const whole = Buffer.concat(parts);
  const digest = crypto.createHash('sha256').update(whole).digest('hex').slice(0, 12);

  {
    const upload = id();
    const first = await send(upload, 0, 3, parts[0]);
    check('un morceau reçu annonce le suivant', first.done === false && first.next === 1);

    const skipped = await fails(send(upload, 2, 3, parts[2]));
    check(
      "un morceau sauté est refusé, avec celui qu'on attend",
      skipped && skipped.statusCode === 409 && skipped.expected === 1,
    );

    const broken = await fails(send(upload, 1, 3, cut(parts[1])));
    check('un morceau coupé en route échoue', broken && broken.expected === 1, broken ? broken.message : '');

    await send(upload, 1, 3, parts[1]);
    const last = await send(upload, 2, 3, parts[2]);
    check('le dernier morceau range le fichier', last.done === true && fs.existsSync(last.filePath));
    check(
      '  … identique, octet pour octet, malgré le morceau coupé',
      fs.readFileSync(last.filePath).equals(whole),
      'il aurait sinon porté deux fois le début du morceau coupé',
    );
    check(
      "  … sous le nom tiré de son empreinte, comme d'un seul tenant",
      path.basename(last.filePath) === `${digest}-concert.mkv`,
    );
    check('  … et sans fichier provisoire qui traîne', !fs.readdirSync(DIR).some((n) => n.startsWith('.incoming-')));

    const again = id();
    await send(again, 0, 3, parts[0]);
    await send(again, 1, 3, parts[1]);
    const dup = await send(again, 2, 3, parts[2]);
    check("le même contenu renvoyé réutilise l'existant", dup.deduplicated === true);
  }

  {
    const lost = await fails(send(id(), 1, 3, parts[1]));
    check(
      'un transfert inconnu fait repartir du premier morceau',
      lost && lost.statusCode === 409 && lost.expected === 0,
      "un redémarrage du bot l'a oublié",
    );

    const upload = id();
    await send(upload, 0, 2, parts[0]);
    const mixed = await fails(send(upload, 1, 2, parts[1], { name: 'autre.mkv' }));
    check("un morceau d'un autre fichier est refusé", mixed && mixed.statusCode === 400);

    const bad = await fails(send('../../etc', 0, 1, parts[0]));
    check('un identifiant fabriqué est refusé', bad && bad.statusCode === 400);
  }

  {
    const upload = id();
    const big = crypto.randomBytes(600 * 1024);
    await send(upload, 0, 2, big);
    const over = await fails(send(upload, 1, 2, big));
    check(
      'la limite porte sur le total, pas sur chaque morceau',
      over && over.statusCode === 413,
      over ? over.message : '',
    );
    check('  … et le transfert dépassé est abandonné', !chunked._sessions.has(upload));
  }

  {
    const upload = id();
    await send(upload, 0, 2, parts[0]);
    chunked._sessions.get(upload).updatedAt = Date.now() - chunked.IDLE_MS - 1;
    chunked._purgeIdle();
    check('un transfert resté muet trente minutes est abandonné', !chunked._sessions.has(upload));
  }

  {
    check('un morceau reste sous le plafond de Cloudflare', chunked.MAX_CHUNK_BYTES < 100 * 1024 * 1024);
    const CLIENT = fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'js', 'queue.js'), 'utf8');
    const size = /const CHUNK_BYTES = (\d+) \* 1024 \* 1024;/.exec(CLIENT);
    check(
      '  … et le navigateur découpe en dessous de ce que le serveur tolère',
      size && Number(size[1]) * 1024 * 1024 <= chunked.MAX_CHUNK_BYTES,
      size ? `${size[1]} Mo` : '',
    );
    check(
      '  … en reprenant au morceau que le serveur attend',
      /status === 409 && data && Number\.isInteger\(data\.expected\)/.test(CLIENT),
    );
  }

  fs.rmSync(DIR, { recursive: true, force: true });
  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed ? 1 : 0);
})();
