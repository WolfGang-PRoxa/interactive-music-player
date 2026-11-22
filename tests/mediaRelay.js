/**
 * Vérifie le relais qui fait passer la vidéo par le bot.
 *
 * Le son passait par le bot depuis toujours ; la vidéo, non. `/api/video-info`
 * rendait l'adresse `*.googlevideo.com` que `yt-dlp` venait de résoudre, et la
 * balise <video> allait la chercher elle-même. Ces adresses sont signées pour le
 * client qui les a demandées : résolue depuis la connexion du bot, celle-là ne
 * vaut que pour le bot. L'invité qui la suivait depuis son réseau se faisait
 * brider ou refuser — d'où une vidéo longue à venir, parfois jamais, parfois au
 * troisième rechargement.
 *
 * Ce que ce test tient, et qui ne se lit pas dans un diff :
 *
 *  - **Safari décide en deux octets.** Il commence par réclamer `bytes=0-1` et
 *    abandonne sans un mot si la réponse n'est pas un 206 portant la taille
 *    totale. C'est le navigateur de l'invité qui a signalé le problème : le
 *    relais qui le corrige ne doit pas échouer sur lui.
 *
 *  - **L'amont est repris par tranches.** YouTube bride une requête continue au
 *    débit de lecture. Relayer une plage ouverte — la forme que tout navigateur
 *    envoie d'abord — en une seule requête vers la source rendrait le relais
 *    plus lent que le lien direct qu'il remplace.
 *
 *  - **Les en-têtes de la source sont rejoués.** La source peut exiger au
 *    moment de servir ceux que `yt-dlp` a présentés en résolvant, et un
 *    navigateur enverra toujours les siens.
 *
 *  - **Le client qui s'en va coupe l'amont.** Sinon, changer de piste laisserait
 *    la boucle de tranches tirer des dizaines de mégaoctets dans le vide.
 *
 *  - **Une source qui ignore les plages reste servie.** Elle répond 200 et
 *    envoie tout ; c'est au relais d'y tailler ce qui a été demandé, et non au
 *    client de recevoir le fichier entier à la place de deux octets.
 *
 * Tout se passe contre deux serveurs locaux — l'un joue la source, l'autre le
 * bot : aucune dépendance au réseau, et les coupures sont provoquées pour de
 * vrai plutôt que simulées.
 */
const http = require('http');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const { parseRange, probeRemote, relayRemote } = require(path.join(ROOT, 'src', 'web', 'mediaRelay.js'));

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

/** Un corps reconnaissable : tout décalage d'un octet se voit. */
const CORPS = crypto.randomBytes(300 * 1024);
const digest = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * La source distante : elle honore les plages, comme googlevideo.
 *
 * @param {object} [options]
 * @param {string} [options.exige] - En-tête sans lequel elle refuse de servir.
 * @param {number} [options.lenteur] - Millisecondes avant de répondre.
 * @param {boolean} [options.ignorePlages] - Répond 200 et envoie tout.
 */
function source({ exige = null, lenteur = 0, ignorePlages = false } = {}) {
  const demandes = [];
  const server = http.createServer(async (req, res) => {
    demandes.push({ range: req.headers.range || null, headers: req.headers });

    if (exige && !req.headers[exige.toLowerCase()]) {
      res.writeHead(403);
      return res.end();
    }
    if (lenteur) await new Promise((r) => setTimeout(r, lenteur));

    if (ignorePlages) {
      res.writeHead(200, { 'content-length': CORPS.length, 'content-type': 'video/mp4' });
      return res.end(CORPS);
    }

    const plage = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (!plage) {
      res.writeHead(200, { 'content-length': CORPS.length, 'content-type': 'video/mp4' });
      return res.end(CORPS);
    }

    const debut = Number(plage[1]);
    const fin = Math.min(plage[2] ? Number(plage[2]) : CORPS.length - 1, CORPS.length - 1);
    if (debut >= CORPS.length) {
      res.writeHead(416, { 'content-range': `bytes */${CORPS.length}` });
      return res.end();
    }
    res.writeHead(206, {
      'content-range': `bytes ${debut}-${fin}/${CORPS.length}`,
      'content-length': fin - debut + 1,
      'content-type': 'video/mp4',
    });
    res.end(CORPS.subarray(debut, fin + 1));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}/v.mp4`,
        demandes,
        close: () => new Promise((ok) => server.close(ok)),
      }),
    );
  });
}

/** Le bot : il ne fait que relayer ce que la source lui donne. */
function relais(amont, options = {}) {
  const server = http.createServer((req, res) => {
    relayRemote(
      req,
      res,
      Object.assign(
        {
          url: amont.url,
          size: CORPS.length,
          contentType: 'video/mp4',
          chunkBytes: 64 * 1024,
        },
        options,
      ),
    );
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: server.address().port,
        close: () => new Promise((ok) => server.close(ok)),
      }),
    );
  });
}

/**
 * Une requête au relais, corps compris.
 *
 * @returns {Promise<{ status: number, headers: object, corps: Buffer }>}
 */
function demander(port, { range = null, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/v.mp4',
        method,
        headers: range ? { Range: range } : {},
      },
      (res) => {
        const bouts = [];
        res.on('data', (c) => bouts.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            corps: Buffer.concat(bouts),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  console.log('\n=== La vidéo passe par le bot ===\n');

  // ───────────────── Ce que Safari exige ─────────────────

  console.log('Les deux octets par lesquels Safari commence\n');

  {
    const amont = await source();
    const bot = await relais(amont);
    const r = await demander(bot.port, { range: 'bytes=0-1' });
    await bot.close();
    await amont.close();

    check('la sonde de Safari reçoit un 206', r.status === 206, `HTTP ${r.status}`);
    check(
      '  … qui dit la taille totale',
      r.headers['content-range'] === `bytes 0-1/${CORPS.length}`,
      r.headers['content-range'] || '(aucun)',
    );
    check('  … et exactement deux octets', r.corps.length === 2, `${r.corps.length} octet(s)`);
    check('  … qui sont les bons', r.corps.equals(CORPS.subarray(0, 2)));
    check(
      'le relais annonce savoir découper',
      r.headers['accept-ranges'] === 'bytes',
      r.headers['accept-ranges'] || '(aucun)',
    );
  }

  // ───────────────── Les formes de plage ─────────────────

  console.log('\nLes plages, dans toutes leurs formes\n');

  {
    const amont = await source();
    const bot = await relais(amont);

    const entier = await demander(bot.port);
    check('sans plage, le fichier entier en 200', entier.status === 200, `HTTP ${entier.status}`);
    check('  … octet pour octet', digest(entier.corps) === digest(CORPS), `${entier.corps.length} sur ${CORPS.length}`);
    check('  … et la longueur annoncée est la sienne', Number(entier.headers['content-length']) === CORPS.length);
    check("  … sans Content-Range, qui n'aurait pas de sens ici", !entier.headers['content-range']);

    const ouverte = await demander(bot.port, { range: 'bytes=200000-' });
    check(
      "une plage ouverte va jusqu'au bout",
      ouverte.status === 206 && ouverte.corps.equals(CORPS.subarray(200000)),
      `${ouverte.corps.length} octets depuis 200000`,
    );
    check(
      '  … et le dit',
      ouverte.headers['content-range'] === `bytes 200000-${CORPS.length - 1}/${CORPS.length}`,
      ouverte.headers['content-range'] || '(aucun)',
    );

    const bornee = await demander(bot.port, { range: 'bytes=1000-1999' });
    check(
      'une plage bornée rend exactement ses octets',
      bornee.corps.equals(CORPS.subarray(1000, 2000)),
      `${bornee.corps.length} octets`,
    );

    const suffixe = await demander(bot.port, { range: 'bytes=-500' });
    check(
      'la forme suffixe rend les derniers octets',
      suffixe.corps.equals(CORPS.subarray(CORPS.length - 500)),
      `${suffixe.corps.length} octets`,
    );

    const dehors = await demander(bot.port, { range: `bytes=${CORPS.length + 10}-` });
    check('une plage hors du fichier est refusée', dehors.status === 416, `HTTP ${dehors.status}`);
    check(
      '  … en disant où sont les bornes',
      dehors.headers['content-range'] === `bytes */${CORPS.length}`,
      dehors.headers['content-range'] || '(aucun)',
    );

    const illisible = await demander(bot.port, { range: 'bytes=abc-def' });
    check(
      'une plage illisible est ignorée, pas refusée',
      illisible.status === 200,
      "le navigateur reçoit le tout, ce qu'il sait toujours lire",
    );

    await bot.close();
    await amont.close();
  }

  {
    const amont = await source();
    const bot = await relais(amont);
    const r = await demander(bot.port, { range: 'bytes=0-1', method: 'HEAD' });
    const requetesAmont = amont.demandes.length;
    await bot.close();
    await amont.close();

    check(
      'un HEAD reçoit les en-têtes',
      r.status === 206 && r.headers['content-range'] === `bytes 0-1/${CORPS.length}`,
    );
    check('  … sans corps', r.corps.length === 0);
    check('  … et sans déranger la source', requetesAmont === 0, `${requetesAmont} requête(s) en amont`);
  }

  // ───────────────── Ce qui déjoue le bridage ─────────────────

  console.log("\nL'amont est repris par tranches\n");

  {
    const amont = await source();
    const bot = await relais(amont);
    const r = await demander(bot.port, { range: 'bytes=0-' });
    await bot.close();
    await amont.close();

    check(
      "l'aval ne voit qu'une réponse continue",
      r.status === 206 && digest(r.corps) === digest(CORPS),
      `${r.corps.length} octets sur ${CORPS.length}`,
    );
    check(
      "  … mais l'amont a été demandé par morceaux",
      amont.demandes.length >= 4,
      `${amont.demandes.length} requêtes de 64 Ko`,
    );
    check(
      '  … chacune bornée des deux côtés',
      amont.demandes.every((d) => /^bytes=\d+-\d+$/.test(d.range || '')),
      'une plage ouverte en amont retomberait dans le bridage',
    );

    const debuts = amont.demandes.map((d) => Number(/bytes=(\d+)/.exec(d.range)[1]));
    check(
      "  … et elles s'enchaînent sans trou ni recouvrement",
      debuts.every((d, i) => (i === 0 ? d === 0 : d === debuts[i - 1] + 64 * 1024)),
      debuts.slice(0, 4).join(', ') + '…',
    );
  }

  {
    const amont = await source({ exige: 'user-agent' });
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/148.0.0.0';
    const bot = await relais(amont, { headers: { 'User-Agent': UA } });
    const r = await demander(bot.port, { range: 'bytes=0-99' });
    await bot.close();
    await amont.close();

    check(
      'les en-têtes que la source exige sont rejoués',
      r.status === 206 && r.corps.equals(CORPS.subarray(0, 100)),
      'la source peut exiger ceux que yt-dlp a présentés en résolvant',
    );
    check(
      '  … tels que le relais les porte',
      amont.demandes[0].headers['user-agent'] === UA,
      amont.demandes[0].headers['user-agent'] || '(aucun)',
    );
  }

  // ───────────────── Quand le client s'en va ─────────────────

  console.log("\nLe client qui part coupe l'amont\n");

  {
    const amont = await source({ lenteur: 60 });
    const bot = await relais(amont);

    const req = http.request({
      host: '127.0.0.1',
      port: bot.port,
      path: '/v.mp4',
      headers: { Range: 'bytes=0-' },
    });
    req.on('error', () => {});
    req.end();

    await new Promise((r) => setTimeout(r, 200));
    const avant = amont.demandes.length;
    req.destroy();
    await new Promise((r) => setTimeout(r, 400));
    const apres = amont.demandes.length;

    await bot.close();
    await amont.close();

    check('la source était bien sollicitée', avant >= 1, `${avant} requête(s)`);
    check(
      '  … et plus rien ne part après le départ du client',
      apres <= avant + 1,
      `${avant} avant, ${apres} après — sinon des mégaoctets tirés dans le vide`,
    );
  }

  // ───────────────── Sonder la source ─────────────────

  console.log("\nCe qu'un seul octet apprend de la source\n");

  {
    const amont = await source();
    const sonde = await probeRemote(amont.url);
    const demande = amont.demandes[0];
    await amont.close();

    check('le sondage rend la taille totale', sonde.size === CORPS.length, `${sonde.size} octets`);
    check('  … et le type, que la balise <video> réclame', sonde.contentType === 'video/mp4', sonde.contentType);
    check('  … en notant que la source sait découper', sonde.ranges === true);
    check("  … pour le prix d'un octet", demande.range === 'bytes=0-0', demande.range);
  }

  {
    const amont = await source({ ignorePlages: true });
    const sonde = await probeRemote(amont.url);

    check('une source qui ignore les plages est reconnue', sonde.ranges === false);
    check('  … et sa taille lue sur la longueur annoncée', sonde.size === CORPS.length, `${sonde.size} octets`);

    const bot = await relais(amont);
    const r = await demander(bot.port, { range: 'bytes=1000-1999' });
    await bot.close();
    await amont.close();

    check(
      '  … et le relais y taille tout de même la plage demandée',
      r.status === 206 && r.corps.equals(CORPS.subarray(1000, 2000)),
      `${r.corps.length} octets, sans quoi le client recevrait le fichier entier`,
    );
  }

  // ───────────────── La lecture des plages ─────────────────

  console.log("\nLa lecture d'un en-tête Range\n");

  {
    check(
      'une plage bornée se lit',
      JSON.stringify(parseRange('bytes=10-20', 100)) === JSON.stringify({ start: 10, end: 20 }),
    );
    check(
      "une plage ouverte va jusqu'à la fin",
      JSON.stringify(parseRange('bytes=10-', 100)) === JSON.stringify({ start: 10, end: 99 }),
    );
    check(
      'une fin au-delà du fichier est ramenée à la dernière position',
      JSON.stringify(parseRange('bytes=10-500', 100)) === JSON.stringify({ start: 10, end: 99 }),
    );
    check(
      'la forme suffixe compte depuis la fin',
      JSON.stringify(parseRange('bytes=-30', 100)) === JSON.stringify({ start: 70, end: 99 }),
    );
    check(
      'un suffixe plus long que le fichier part de zéro',
      JSON.stringify(parseRange('bytes=-500', 100)) === JSON.stringify({ start: 0, end: 99 }),
    );
    check('un début hors du fichier est hors bornes', parseRange('bytes=100-', 100).invalid === true);
    check('un début après la fin est hors bornes', parseRange('bytes=50-10', 100).invalid === true);
    check('une plage absente ne dit rien', parseRange(undefined, 100) === null);
    check('une plage illisible ne dit rien non plus', parseRange('bytes=a-b', 100) === null);
    check(
      'les plages multiples ne sont pas servies',
      parseRange('bytes=0-10,20-30', 100) === null,
      'une réponse multipart ne sert à aucun lecteur vidéo',
    );
  }

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
