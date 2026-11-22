/**
 * Vérifie le relais de retour OAuth, des deux côtés.
 *
 * Discord exige une URL de rappel fixe ; le partage rapide a une adresse neuve
 * à chaque lancement. Le relais (tools/oauth-relay/) est l'adresse fixe qu'on
 * déclare, et renvoie chaque connexion là d'où elle est partie.
 *
 * Ce que ce test protège :
 *
 *  - **Le relais ne renvoie pas n'importe où.** Seulement vers un tunnel rapide
 *    ou vers la machine elle-même. Un relais ouvert ferait porter les codes
 *    d'autorisation chez qui l'on veut.
 *
 *  - **La règle est la même des deux côtés.** Elle est écrite deux fois — le
 *    Worker n'importe rien du dépôt — et le bot doit savoir d'avance ce que le
 *    relais acceptera. Les deux versions sont éprouvées sur les mêmes cas.
 *
 *  - **Le retour revient sur l'origine de départ**, là où vivent les cookies de
 *    la connexion. C'est ce qui garde le `nonce` et le jeton au rendez-vous.
 *
 *  - **Une adresse déclarée se passe du relais**, comme avant.
 */
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const relay = require(path.join(ROOT, 'src', 'web', 'oauthRelay.js'));
const oauthPath = path.join(ROOT, 'src', 'web', 'oauth.js');

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

const CASES = [
  ['https://soft-lake-river.trycloudflare.com', 'https://soft-lake-river.trycloudflare.com'],
  ['https://Soft-Lake-River.trycloudflare.com/', 'https://soft-lake-river.trycloudflare.com'],
  ['http://localhost:3000', 'http://localhost:3000'],
  ['http://127.0.0.1:3100', 'http://127.0.0.1:3100'],
  ['http://[::1]:3000', 'http://[::1]:3000'],
  // Refusés.
  ['http://soft-lake-river.trycloudflare.com', null],
  ['https://soft-lake-river.trycloudflare.com:8443', null],
  ['https://a.b.trycloudflare.com', null],
  ['https://trycloudflare.com', null],
  ['https://trycloudflare.com.evil.example', null],
  ['https://evil.example/?x=.trycloudflare.com', null],
  ['https://localhost:3000', null],
  ['http://192.168.1.20:3000', null],
  ['https://imp.romainpiau.dev', null],
  ['https://x.trycloudflare.com/autre/chemin', null],
  ['https://user:pw@x.trycloudflare.com', null],
  ['javascript:alert(1)', null],
  ['', null],
];

(async () => {
  const worker = await import(pathToFileURL(path.join(ROOT, 'tools', 'oauth-relay', 'src', 'index.js')).href);

  console.log('\n=== Le relais de retour OAuth ===\n');

  // ───────────────────── Les destinations ─────────────────────

  console.log('Où le relais accepte de renvoyer\n');

  for (const [input, expected] of CASES) {
    const bot = relay.acceptedTarget(input);
    const edge = worker.acceptedTarget(input);
    check(
      `${input || '(vide)'} → ${expected || 'refusé'}`,
      bot === expected && edge === expected,
      bot === edge ? '' : `bot ${bot} ≠ Worker ${edge}`,
    );
  }

  // ───────────────────── Le state ─────────────────────

  console.log('\nCe que le state porte\n');

  {
    const state = relay.encodeState('https://soft-lake-river.trycloudflare.com');
    check(
      "l'origine voyage dans le state, après la part tirée au hasard",
      /^[a-f0-9]{32}\.[A-Za-z0-9_-]+$/.test(state),
      state,
    );
    check(
      '  … et les deux côtés la relisent pareil',
      relay.decodeState(state) === 'https://soft-lake-river.trycloudflare.com' &&
        worker.targetFromState(state) === 'https://soft-lake-river.trycloudflare.com',
    );
    check(
      'deux states pour la même origine ne se ressemblent pas',
      relay.encodeState('http://localhost:3000') !== relay.encodeState('http://localhost:3000'),
    );

    let threw = false;
    try {
      relay.encodeState('https://evil.example');
    } catch (e) {
      threw = true;
    }
    check('le bot refuse de composer un state pour une origine refusée', threw);

    const forged = `abc.${Buffer.from('https://evil.example').toString('base64url')}`;
    check(
      'un state forgé vers ailleurs ne mène nulle part',
      relay.decodeState(forged) === null && worker.targetFromState(forged) === null,
    );
    check('un state sans origine non plus', worker.targetFromState('0123456789abcdef0123456789abcdef') === null);
  }

  // ───────────────────── Le Worker ─────────────────────

  console.log('\nCe que le Worker répond\n');

  {
    const call = (url, init) => worker.default.fetch(new Request(url, init));
    const state = relay.encodeState('https://soft-lake-river.trycloudflare.com');

    const ok = await call(`https://imp-auth.romainpiau.dev/discord/callback?code=C0DE&state=${state}`);
    const location = ok.headers.get('Location') || '';
    check(
      "il renvoie sur le rappel du bot, à l'origine de départ",
      ok.status === 302 && location.startsWith('https://soft-lake-river.trycloudflare.com/auth/discord/callback?'),
      location,
    );
    const next = new URL(location);
    check(
      '  … avec le code et le state tels quels',
      next.searchParams.get('code') === 'C0DE' && next.searchParams.get('state') === state,
    );
    check(
      '  … sans cache ni référent',
      ok.headers.get('Cache-Control') === 'no-store' && ok.headers.get('Referrer-Policy') === 'no-referrer',
    );

    const refus = await call(`https://imp-auth.romainpiau.dev/discord/callback?error=access_denied&state=${state}`);
    const refusNext = new URL(refus.headers.get('Location') || 'http://x');
    check(
      'un refus de Discord est relayé aussi, avec son state',
      refus.status === 302 &&
        refusNext.searchParams.get('error') === 'access_denied' &&
        refusNext.searchParams.get('state') === state,
      "c'est le state qui dit au bot si l'essai était muet",
    );

    const extra = await call(
      `https://imp-auth.romainpiau.dev/discord/callback?code=C&state=${state}&redirect=https://evil.example`,
    );
    check(
      "rien d'autre que ce que Discord ajoute ne traverse",
      !(extra.headers.get('Location') || '').includes('evil'),
    );

    const forged = `abc.${Buffer.from('https://evil.example').toString('base64url')}`;
    const bad = await call(`https://imp-auth.romainpiau.dev/discord/callback?code=C&state=${forged}`);
    check(
      'une destination refusée reçoit une page, pas une redirection',
      bad.status === 400 && !bad.headers.get('Location'),
    );

    const post = await call('https://imp-auth.romainpiau.dev/discord/callback', { method: 'POST' });
    check('seul GET est servi', post.status === 405);

    const home = await call('https://imp-auth.romainpiau.dev/');
    check("ailleurs, une page qui dit ce qu'est cette adresse", home.status === 404);
  }

  // ───────────────────── Le côté bot ─────────────────────

  console.log('\nQuand le bot emploie le relais\n');

  {
    const before = { ...process.env };
    const load = (env) => {
      delete process.env.PUBLIC_URL;
      delete process.env.OAUTH_RELAY_URL;
      Object.assign(process.env, env, {
        DISCORD_CLIENT_ID: '123',
        DISCORD_CLIENT_SECRET: 'secret',
        PORT: '3000',
      });
      delete require.cache[require.resolve(oauthPath)];
      return require(oauthPath);
    };

    let oauth = load({});
    check(
      'sans adresse déclarée, le retour passe par le relais par défaut',
      oauth.usesRelay() && oauth.redirectUri() === oauth.DEFAULT_RELAY_URL,
    );

    const authorize = new URL(
      oauth.buildAuthorizeUrl('/', {
        origin: 'https://soft-lake-river.trycloudflare.com',
        nonce: 'n',
      }),
    );
    const state = authorize.searchParams.get('state');
    check(
      "  … Discord reçoit l'adresse du relais",
      authorize.searchParams.get('redirect_uri') === oauth.DEFAULT_RELAY_URL,
    );
    check(
      "  … et le state désigne l'origine de départ",
      relay.decodeState(state) === 'https://soft-lake-river.trycloudflare.com',
    );
    check('  … que le bot reconnaît au retour', oauth.consumeState(state)?.nonce === 'n');

    const req = (host) => ({ headers: { host } });
    check(
      "l'origine de départ se lit sur l'hôte : HTTPS pour le tunnel",
      oauth.returnOrigin(req('soft-lake-river.trycloudflare.com')) === 'https://soft-lake-river.trycloudflare.com',
    );
    check('  … HTTP pour la machine elle-même', oauth.returnOrigin(req('127.0.0.1:3000')) === 'http://127.0.0.1:3000');
    check(
      '  … et rien pour une IP du réseau local, qui demande une adresse déclarée',
      oauth.returnOrigin(req('192.168.1.20:3000')) === null,
    );

    oauth = load({ PUBLIC_URL: 'https://imp.romainpiau.dev/' });
    check(
      'une adresse déclarée se passe du relais',
      !oauth.usesRelay() && oauth.redirectUri() === 'https://imp.romainpiau.dev/auth/discord/callback',
    );
    const plain = new URL(oauth.buildAuthorizeUrl('/', {})).searchParams.get('state');
    check('  … et son state reste une valeur au hasard, sans origine', /^[a-f0-9]{32}$/.test(plain));

    oauth = load({ OAUTH_RELAY_URL: 'https://relais.exemple.org/discord/callback' });
    check(
      'OAUTH_RELAY_URL désigne un autre relais',
      oauth.redirectUri() === 'https://relais.exemple.org/discord/callback',
    );

    oauth = load({ OAUTH_RELAY_URL: 'off' });
    check(
      "  … et « off » l'écarte",
      !oauth.usesRelay() && oauth.redirectUri() === 'http://localhost:3000/auth/discord/callback',
    );

    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before);
    delete require.cache[require.resolve(oauthPath)];
  }

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed ? 1 : 0);
})();
