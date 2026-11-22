/**
 * L'IPv6 d'abord, l'IPv4 quand YouTube refuse la première.
 *
 * YouTube peut tenir l'IPv6 de l'hôte pour un robot tout en servant son IPv4 :
 * c'est ce qui est arrivé le 27/09/2026, et plus rien ne se chargeait. L'IPv6
 * reste pourtant la voie normale, et ces cas tiennent les deux bouts : rien ne
 * change tant qu'elle passe, et au premier refus la requête est rejouée par
 * l'IPv4, qui sert ensuite une heure.
 *
 * Deux détecteurs, un par chose qui interroge YouTube — yt-dlp et l'extracteur
 * youtubei —, éprouvés chacun avec un faux : rien ici ne sort sur le réseau.
 *
 * Le dernier bloc lit les sources : un appel de yt-dlp ajouté demain sans
 * passer par le repli ressortirait par l'IPv6 refusée, et rien ne le
 * signalerait tant que YouTube la laisse passer.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const SRC = path.join(__dirname, '..', 'src');

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

const BOT = 'ERROR: [youtube] wBqfzj6CEzI: Sign in to confirm you’re not a bot. Use --cookies-from-browser';
const AGE = 'ERROR: [youtube] abc: Sign in to confirm your age. This video may be inappropriate for some users.';

/*
 * Un faux yt-dlp, posé dans le cache de `require` comme le font les autres
 * tests : le module le requiert à chaque appel, et le trouve donc là.
 * `behaviour(flags)` décide de la réponse ; chaque appel est consigné.
 */
const calls = [];
let behaviour = () => ({ title: 'ok' });
{
  const ytdlPath = require.resolve('youtube-dl-exec');
  const faux = new Module(ytdlPath);
  faux.filename = ytdlPath;
  faux.loaded = true;
  faux.exports = async (url, flags) => {
    calls.push({ url, ipv4: !!flags.forceIpv4 });
    return behaviour(flags);
  };
  require.cache[ytdlPath] = faux;
}

const net = require('../src/utils/youtubeNetwork');
const log = require('../src/utils/logger');

// Les avertissements du module ne doivent pas encombrer la sortie du test.
for (const level of ['info', 'warn', 'error']) log[level] = () => {};

let clock = 0;
net._setClock(() => clock);

function fresh() {
  net._reset();
  calls.length = 0;
  clock = 0;
}

const refuseIpv6 = (flags) => {
  if (!flags.forceIpv4) throw new Error(BOT);
  return { title: 'par IPv4' };
};

(async () => {
  console.log('\n=== L’IPv6 d’abord, l’IPv4 en repli ===\n');

  /* ── yt-dlp ─────────────────────────────────────────────────────── */

  await test('tant que l’IPv6 passe, yt-dlp n’est pas contraint', async () => {
    fresh();
    behaviour = () => ({ title: 'par IPv6' });
    const out = await net.ytdlp('https://www.youtube.com/watch?v=x', { dumpSingleJson: true });
    assert.strictEqual(out.title, 'par IPv6');
    assert.deepStrictEqual(
      calls.map((c) => c.ipv4),
      [false],
    );
    assert.strictEqual(net.familyFor('https://rr2---sn-x.googlevideo.com/videoplayback'), undefined);
  });

  await test('un refus en IPv6 est rejoué aussitôt en IPv4', async () => {
    fresh();
    behaviour = refuseIpv6;
    const out = await net.ytdlp('https://www.youtube.com/watch?v=x', { dumpSingleJson: true });
    assert.strictEqual(out.title, 'par IPv4');
    assert.deepStrictEqual(
      calls.map((c) => c.ipv4),
      [false, true],
    );
  });

  await test('  … puis l’IPv4 sert directement, sans repasser par l’IPv6', async () => {
    calls.length = 0;
    clock += 10 * 60 * 1000;
    await net.ytdlp('https://www.youtube.com/watch?v=y', {});
    assert.deepStrictEqual(
      calls.map((c) => c.ipv4),
      [true],
    );
  });

  await test('  … et vaut pour les flux de YouTube, pas pour le reste', async () => {
    assert.strictEqual(net.familyFor('https://rr2---sn-x.googlevideo.com/videoplayback?x=1'), 4);
    assert.strictEqual(net.familyFor('https://i.ytimg.com/vi/x/hq.jpg'), 4);
    assert.strictEqual(net.familyFor('https://cf-media.sndcdn.com/abc'), undefined);
    assert.strictEqual(net.familyFor('http://127.0.0.1:3000/x'), undefined);
  });

  await test('au bout d’une heure, l’IPv6 est retentée', async () => {
    calls.length = 0;
    clock += 60 * 60 * 1000;
    behaviour = () => ({ title: 'par IPv6' });
    await net.ytdlp('https://www.youtube.com/watch?v=z', {});
    assert.deepStrictEqual(
      calls.map((c) => c.ipv4),
      [false],
    );
    assert.strictEqual(net.familyFor('https://rr2---sn-x.googlevideo.com/videoplayback'), undefined);
  });

  await test('une autre erreur n’est ni rejouée ni prise pour un refus', async () => {
    fresh();
    behaviour = () => {
      throw new Error('ERROR: [youtube] x: Video unavailable');
    };
    await assert.rejects(net.ytdlp('https://www.youtube.com/watch?v=x', {}), /unavailable/);
    assert.deepStrictEqual(
      calls.map((c) => c.ipv4),
      [false],
    );
    assert.strictEqual(net.familyFor('https://rr2---sn-x.googlevideo.com/v'), undefined);
  });

  await test('une vidéo réservée aux adultes ne déclenche pas le repli', async () => {
    fresh();
    behaviour = () => {
      throw new Error(AGE);
    };
    await assert.rejects(net.ytdlp('https://www.youtube.com/watch?v=x', {}), /your age/);
    assert.deepStrictEqual(
      calls.map((c) => c.ipv4),
      [false],
    );
  });

  await test('si l’IPv4 est refusée aussi, l’erreur remonte telle quelle', async () => {
    fresh();
    behaviour = () => {
      throw new Error(BOT);
    };
    await assert.rejects(net.ytdlp('https://www.youtube.com/watch?v=x', {}), /not a bot/);
    assert.deepStrictEqual(
      calls.map((c) => c.ipv4),
      [false, true],
    );
  });

  /* ── youtubei ───────────────────────────────────────────────────── */

  const PLAYER = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
  const refused = () =>
    new Response(
      JSON.stringify({
        playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'Sign in to confirm you’re not a bot' },
      }),
    );
  const playable = () =>
    new Response(
      JSON.stringify({
        playabilityStatus: { status: 'OK' },
        videoDetails: { title: 'Titre' },
      }),
    );

  /** Un faux fetch : refuse ce qui ne passe pas par le répartiteur IPv4. */
  function fakeFetch({ refuseIpv6 = true } = {}) {
    const seen = [];
    const IPV4 = { name: 'ipv4' };
    const fetchImpl = async (input, init = {}) => {
      seen.push({ url: String(input), ipv4: init.dispatcher === IPV4, dispatcher: init.dispatcher });
      if (!String(input).includes('/player')) return new Response('{}');
      return refuseIpv6 && init.dispatcher !== IPV4 ? refused() : playable();
    };
    return { seen, IPV4, wrapped: net.wrapFetch(fetchImpl, async () => IPV4) };
  }

  await test('youtubei : une description servie en IPv6 est rendue telle quelle', async () => {
    fresh();
    const f = fakeFetch({ refuseIpv6: false });
    const res = await f.wrapped(PLAYER, { method: 'POST', body: '{}' });
    assert.strictEqual((await res.json()).videoDetails.title, 'Titre');
    assert.deepStrictEqual(
      f.seen.map((s) => s.ipv4),
      [false],
    );
  });

  await test('youtubei : un refus en IPv6 est rejoué en IPv4, sans que youtubei le voie', async () => {
    fresh();
    const f = fakeFetch();
    const res = await f.wrapped(PLAYER, { method: 'POST', body: '{"videoId":"x"}' });
    assert.strictEqual((await res.json()).videoDetails.title, 'Titre');
    assert.deepStrictEqual(
      f.seen.map((s) => s.ipv4),
      [false, true],
    );
  });

  await test('  … et ses requêtes suivantes partent directement en IPv4', async () => {
    const f = fakeFetch();
    await f.wrapped('https://www.youtube.com/youtubei/v1/next', {});
    assert.deepStrictEqual(
      f.seen.map((s) => s.ipv4),
      [true],
    );
  });

  await test('  … le repli vu par youtubei l’est aussi par yt-dlp', async () => {
    calls.length = 0;
    behaviour = () => ({ title: 'x' });
    await net.ytdlp('https://www.youtube.com/watch?v=x', {});
    assert.deepStrictEqual(
      calls.map((c) => c.ipv4),
      [true],
    );
  });

  await test('youtubei : seule la description de vidéo est inspectée', async () => {
    fresh();
    const f = fakeFetch();
    await f.wrapped('https://www.youtube.com/youtubei/v1/search', {});
    assert.deepStrictEqual(
      f.seen.map((s) => s.ipv4),
      [false],
    );
    assert.strictEqual(net.familyFor('https://rr2---sn-x.googlevideo.com/v'), undefined);
  });

  await test('youtubei : un mandataire configuré n’est pas contourné', async () => {
    fresh();
    const f = fakeFetch();
    const proxy = { name: 'proxy' };
    await f.wrapped(PLAYER, { dispatcher: proxy });
    assert.strictEqual(f.seen.length, 1);
    assert.strictEqual(f.seen[0].dispatcher, proxy);
  });

  await test('youtubei : le repli est bien branché sur la bibliothèque, une seule fois', async () => {
    const { Platform } = require('youtubei.js');
    const before = Platform.shim.fetch;
    try {
      net.installYoutubeiFallback();
      const once = Platform.shim.fetch;
      net.installYoutubeiFallback();
      assert.strictEqual(once.name, 'fetchWithIpv4Fallback');
      assert.strictEqual(Platform.shim.fetch, once, 'enveloppé deux fois');
    } finally {
      Platform.shim.fetch = before;
    }
  });

  /* ── Le moins de demandes possible ──────────────────────────────── */

  // Horloge et attente factices : une attente avance l'horloge d'autant, et
  // le hasard de l'écart est au plus court — dix secondes.
  const waits = [];
  net._setTiming({
    sleep: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
    random: () => 0,
  });

  const DUMP = { dumpSingleJson: true, noWarnings: true };
  const expiringIn = (ms) =>
    `https://rr1---sn-x.googlevideo.com/videoplayback?expire=${Math.floor((clock + ms) / 1000)}&id=1`;
  const described =
    (ms = 6 * 3600 * 1000) =>
    () => ({ title: 'Titre', formats: [{ url: expiringIn(ms) }] });

  await test('une vidéo n’est extraite qu’une fois, sous toutes ses adresses', async () => {
    fresh();
    behaviour = described();
    const a = await net.ytdlp('https://www.youtube.com/watch?v=abcDEF12345&pp=xyz', DUMP);
    const b = await net.ytdlp('https://youtube.com/watch?v=abcDEF12345', { noWarnings: true, dumpSingleJson: true });
    const c = await net.ytdlp('https://youtu.be/abcDEF12345?si=q', DUMP);
    assert.strictEqual(calls.length, 1, `${calls.length} extraction(s)`);
    a.title = 'modifié par un appelant';
    assert.strictEqual(b.title, 'Titre', 'les appelants partagent le même objet');
    assert.strictEqual(c.title, 'Titre');
  });

  await test('  … et des demandes simultanées se greffent sur celle en cours', async () => {
    fresh();
    behaviour = described();
    const url = 'https://www.youtube.com/watch?v=zzzZZZ00000';
    await Promise.all([net.ytdlp(url, DUMP), net.ytdlp(url, DUMP), net.ytdlp(url, DUMP)]);
    assert.strictEqual(calls.length, 1, `${calls.length} extraction(s)`);
  });

  await test('  … mais pas au-delà de l’expiration des adresses qu’elle porte', async () => {
    fresh();
    behaviour = described(10 * 60 * 1000);
    await net.ytdlp('https://www.youtube.com/watch?v=exp00000000', DUMP);
    await net.ytdlp('https://www.youtube.com/watch?v=exp00000000', DUMP);
    assert.strictEqual(calls.length, 2, 'une adresse qui expire dans dix minutes ne se resert pas');
  });

  await test('  … ni après un échec, qui se retente', async () => {
    fresh();
    behaviour = () => {
      throw new Error('ERROR: [youtube] x: Video unavailable');
    };
    await assert.rejects(net.ytdlp('https://www.youtube.com/watch?v=gone0000000', DUMP));
    await assert.rejects(net.ytdlp('https://www.youtube.com/watch?v=gone0000000', DUMP));
    assert.strictEqual(calls.length, 2);
  });

  await test('le travail de fond attend dix secondes après la dernière extraction', async () => {
    fresh();
    waits.length = 0;
    behaviour = described();
    await net.ytdlp('https://www.youtube.com/watch?v=vue00000001', DUMP);
    clock += 1000;
    await net.ytdlp('https://www.youtube.com/watch?v=fond0000001', DUMP, {}, { background: true });
    assert.deepStrictEqual(waits, [9000]);
    await net.ytdlp('https://www.youtube.com/watch?v=fond0000002', DUMP, {}, { background: true });
    assert.deepStrictEqual(waits, [9000, 10000], 'une extraction de fond après l’autre');
  });

  await test('  … quand ce qu’on demande soi-même part sans attendre', async () => {
    waits.length = 0;
    await net.ytdlp('https://www.youtube.com/watch?v=vue00000002', DUMP);
    assert.deepStrictEqual(waits, []);
  });

  await test('  … et qu’une vidéo déjà extraite ne fait pas la queue', async () => {
    waits.length = 0;
    calls.length = 0;
    await net.ytdlp('https://www.youtube.com/watch?v=vue00000002', DUMP, {}, { background: true });
    assert.deepStrictEqual(waits, []);
    assert.strictEqual(calls.length, 0);
  });

  await test('après un refus par les deux adresses, le fond s’arrête une demi-heure', async () => {
    fresh();
    behaviour = () => {
      throw new Error(BOT);
    };
    await assert.rejects(net.ytdlp('https://www.youtube.com/watch?v=refus000001', DUMP), /not a bot/);
    calls.length = 0;
    await assert.rejects(
      net.ytdlp('https://www.youtube.com/watch?v=fond0000003', DUMP, {}, { background: true }),
      (err) => err.code === 'YOUTUBE_PAUSED',
    );
    assert.strictEqual(calls.length, 0, 'aucune demande envoyée pendant la pause');
  });

  await test('  … quand un geste de l’utilisateur tente encore sa chance', async () => {
    calls.length = 0;
    await assert.rejects(net.ytdlp('https://www.youtube.com/watch?v=vue00000003', DUMP), /not a bot/);
    assert.strictEqual(calls.length, 1, 'une seule tentative, directement par le repli');
  });

  await test('  … et le fond reprend une fois la demi-heure passée', async () => {
    clock += 30 * 60 * 1000 + 1;
    behaviour = described();
    calls.length = 0;
    const out = await net.ytdlp('https://www.youtube.com/watch?v=fond0000004', DUMP, {}, { background: true });
    assert.strictEqual(out.title, 'Titre');
    assert.strictEqual(calls.length, 1);
  });

  /* ── Le préchargement ───────────────────────────────────────────── */

  const preloadManager = require('../src/audio/PreloadManager');
  const { Readable } = require('stream');
  const YT = 'https://youtube.com/watch?v=pre00000001';
  const audioFormat = () => ({
    formats: [
      {
        url: 'http://127.0.0.1:9/videoplayback?expire=99999999999',
        acodec: 'opus',
        vcodec: 'none',
        protocol: 'https',
        abr: 130,
        format_id: '251',
      },
    ],
  });

  /** Un lecteur factice dont l'extracteur compte ses flux. */
  function fakePlayer() {
    const counts = { stream: 0 };
    const extractor = {
      identifier: 'fake',
      constructor: { name: 'FakeExtractor' },
      validate: async () => true,
      stream: async () => {
        counts.stream++;
        return Readable.from(['x']);
      },
    };
    return {
      counts,
      extractors: {
        run: async (fn) => {
          const result = await fn(extractor);
          return result === false ? null : { result, extractor };
        },
      },
    };
  }

  async function resolveWith(player, how) {
    const previous = preloadManager.player;
    preloadManager.player = player;
    try {
      return await preloadManager.resolveAudioInput({ title: 'Essai', url: YT }, YT, how);
    } finally {
      preloadManager.player = previous;
    }
  }

  const close = (input) => {
    if (input && input.inputStream) {
      input.inputStream.on('error', () => {});
      input.inputStream.destroy();
    }
  };

  await test('préchargement YouTube : yt-dlp seul, sans flux d’extracteur ouvert pour rien', async () => {
    fresh();
    behaviour = audioFormat;
    const player = fakePlayer();
    const input = await resolveWith(player);
    close(input);
    assert.strictEqual(player.counts.stream, 0, `${player.counts.stream} flux ouvert(s) par l’extracteur`);
    assert.strictEqual(input.ffmpegInput, 'pipe:0');
    assert.strictEqual(calls.length, 1);
  });

  await test('  … l’extracteur ne sert qu’en secours, quand yt-dlp ne trouve rien', async () => {
    fresh();
    behaviour = () => ({ formats: [] });
    const player = fakePlayer();
    const input = await resolveWith(player);
    close(input);
    assert.strictEqual(player.counts.stream, 1);
    assert.strictEqual(input.ffmpegInput, 'pipe:0');
  });

  await test('  … et pendant une pause, le fond ne se rabat pas sur lui', async () => {
    fresh();
    behaviour = () => {
      throw new Error(BOT);
    };
    await assert.rejects(net.ytdlp('https://www.youtube.com/watch?v=refus000002', DUMP));
    const player = fakePlayer();
    await assert.rejects(resolveWith(player, { background: true }), (err) => err.code === 'YOUTUBE_PAUSED');
    assert.strictEqual(player.counts.stream, 0, 'le secours aurait été une autre demande à YouTube');
  });

  /* ── Les sources ────────────────────────────────────────────────── */

  function serverSources(dir = SRC) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === 'public' ? [] : serverSources(full);
      return entry.name.endsWith('.js') ? [full] : [];
    });
  }

  const sources = serverSources().map((file) => ({
    rel: path.relative(SRC, file).replace(/\\/g, '/'),
    text: fs.readFileSync(file, 'utf8'),
  }));

  await test('les appels de yt-dlp passent tous par le repli', async () => {
    const through = sources.reduce((n, s) => n + (s.text.match(/\bytdlp\s*\(/g) || []).length, 0);
    // Sans ce compte, un motif cassé laisserait passer la vérification
    // suivante sur une liste vide.
    assert.ok(through >= 5, `${through} appel(s) par ytdlp()`);

    const direct = sources
      .filter((s) => s.rel !== 'utils/youtubeNetwork.js')
      .filter((s) => /\byoutubedl\s*\(|require\(['"]youtube-dl-exec['"]\)\s*\(/.test(s.text))
      .map((s) => s.rel);
    assert.deepStrictEqual(direct, [], `appel direct de youtube-dl-exec : ${direct.join(', ')}`);
  });

  await test('aucune requête ne se fait passer pour le robot de Google', async () => {
    // yt-dlp se présentait en `googlebot` : un robot d'indexation annoncé
    // depuis une adresse domestique, c'est exactement ce que YouTube guette.
    // Sans en-tête forcé, il présente ceux d'un navigateur ordinaire, et
    // les flux se servent de la même façon.
    const found = sources.filter((s) => /googlebot/i.test(s.text)).map((s) => s.rel);
    assert.deepStrictEqual(found, [], `googlebot dans : ${found.join(', ')}`);
  });

  await test('le démarrage branche youtubei avant d’enregistrer les extracteurs', async () => {
    const index = sources.find((s) => s.rel === 'index.js').text;
    const install = index.indexOf("require('./utils/youtubeNetwork').installYoutubeiFallback()");
    const register = index.indexOf('player.extractors.register(');
    assert.ok(install !== -1, 'installYoutubeiFallback() n’est pas appelé dans index.js');
    assert.ok(register !== -1, 'enregistrement des extracteurs introuvable');
    assert.ok(install < register, 'le repli est branché après l’enregistrement des extracteurs');
  });

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
