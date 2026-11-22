/**
 * Vérifie le salon sur lequel on se retrouve, et ce que le favori y pèse.
 *
 * Le favori était relu en pleine session — par la règle de présence à chaque
 * mouvement vocal, par le tableau de bord à chaque connexion —, si bien qu'un
 * salon marqué d'une étoile ramenait sans cesse tout le monde sur lui : on ne
 * pouvait plus s'installer ailleurs. Il ne vaut plus qu'au démarrage.
 *
 * Et même là, il ne vaut qu'à l'allumage. **Lancer un bot éteint ouvre une
 * session** : le favori dit par où commencer, et c'est tout son objet. **Un
 * redémarrage n'en ouvre pas** — le process repart, pas l'écoute — et doit
 * ramener là où l'on était, exactement comme le fait déjà un rechargement de
 * page. Auparavant le favori passait devant dans les deux cas, et rapatriait
 * tout le monde sur lui à chaque redémarrage, y compris après une mise à jour
 * installée en pleine écoute ailleurs.
 *
 * La distinction ne se devine pas : c'est l'instance qui se relance qui la
 * transmet, par `IMP_RESTART`. Sans ce passage de témoin, les deux lancements se
 * ressemblent trait pour trait vus du démarrage.
 *
 * Les garanties à ne jamais reperdre :
 *
 *   - à l'allumage, le favori devient le salon courant, même après une session ;
 *   - au redémarrage, le dernier salon visité prime sur le favori ;
 *   - une sélection en session l'emporte, et survit au redémarrage suivant ;
 *   - la règle de présence ne connaît pas le favori.
 */

let failed = 0;
let passed = 0;
const check = (label, ok, detail = '') => {
  if (ok) {
    passed++;
    console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

/** Remplace un module par un double avant que quiconque ne le charge. */
function stub(filePath, exports) {
  const resolved = require.resolve(filePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// `config` est lu au chargement de PresenceManager : la règle doit être active,
// sans quoi `connexionAutorisee` laisserait tout passer et les cas ci-dessous ne
// prouveraient rien.
stub('../src/config', {
  presence: { enabled: true, departureDelay: 30000 },
  ducking: { enabled: true, level: 20, restoreDelay: 800, fadeDuration: 200 },
  volume: { defaultBase: 70 },
  broadcast: { defaultMode: 'everyone' },
});

stub('../src/utils/logger', {
  info() {},
  warn() {},
  error() {},
  success() {},
  getHistory: () => [],
});

// ─────────────────── Database : l'application du favori ───────────────────

const GUILD = 'g1';
const FAVORITE = 'favorite_channel';
const OTHER = 'other_channel';

// La vraie base, mais coupée du disque : sans ce double elle lirait — et
// réécrirait — le settings.json de l'utilisateur. `readJsonSafe` rendant null,
// elle démarre sur un cache vide, que le test remplit lui-même.
stub('../src/utils/atomicJson', {
  readJsonSafe: () => null,
  writeJsonAtomic: () => {},
  cleanStaleTemp: () => {},
});

const base = require('../src/database/Database');
base.cache.set(GUILD, { guildId: GUILD, defaultVoiceChannelId: FAVORITE, lastVoiceChannelId: null });

console.log("\napplyStartupChannel — le salon d'ouverture\n");

/** Un allumage : le bot était éteint, quelqu'un le lance. */
const COLD = { resuming: false };
/** Une reprise : l'instance précédente s'est relancée elle-même. */
const RESUME = { resuming: true };

// Première ouverture : rien n'a jamais été visité, le favori sert de point de
// départ.
const first = base.applyStartupChannel(COLD);
check(
  'sans visite enregistrée, le favori ouvre la session',
  first && first.channelId === FAVORITE && first.source === 'favorite',
  first ? `${first.channelId} (${first.source})` : 'aucun',
);
check('  … et devient le salon courant', base.getLastVoiceChannel().channelId === FAVORITE);
check('  … y compris pour le serveur concerné', base.getSettings(GUILD).lastVoiceChannelId === FAVORITE);

// Le geste de l'utilisateur, en pleine session : `handleSelectChannel` inscrit
// le salon choisi.
base.setLastVoiceChannel(GUILD, OTHER);
check(
  "une sélection en session l'emporte",
  base.getLastVoiceChannel().channelId === OTHER,
  base.getLastVoiceChannel().channelId,
);

/*
 * Le redémarrage, et tout l'objet de ce fichier.
 *
 * Le favori est toujours là, sur ce même serveur, et il ne doit rien rapatrier :
 * on repart d'où l'on écoutait. Le remettre devant ramenait l'utilisateur sur le
 * salon étoilé à chaque redémarrage du bot, alors qu'un simple rechargement de
 * page, lui, le laissait en place. Deux comportements pour une même attente.
 */
const resumed = base.applyStartupChannel(RESUME);
check(
  'au redémarrage, le dernier salon visité prime sur le favori',
  resumed && resumed.channelId === OTHER && resumed.source === 'last',
  resumed ? `${resumed.channelId} (${resumed.source})` : 'aucun',
);
check('  … et le salon courant ne bouge pas', base.getLastVoiceChannel().channelId === OTHER);

/*
 * L'allumage suivant, en revanche, le rappelle.
 *
 * C'est la moitié de la règle qu'une correction trop large ferait perdre : à
 * force de faire primer le dernier salon, le favori ne servirait plus jamais
 * passé la toute première ouverture. Éteindre puis rallumer doit le rendre.
 */
const relit = base.applyStartupChannel(COLD);
check(
  "à l'allumage, le favori reprend la main",
  relit && relit.channelId === FAVORITE && relit.source === 'favorite',
  relit ? `${relit.channelId} (${relit.source})` : 'aucun',
);
check('  … et redevient le salon courant', base.getLastVoiceChannel().channelId === FAVORITE);
check('  … sans jamais être effacé', base.getSettings(GUILD).defaultVoiceChannelId === FAVORITE);

// Sans favori, allumage et reprise se ressemblent : le dernier salon vaut dans
// les deux cas.
base.cache.set(GUILD, { guildId: GUILD, defaultVoiceChannelId: null, lastVoiceChannelId: OTHER });
base.globalData.lastGuildId = GUILD;
base.globalData.lastVoiceChannelId = OTHER;
check(
  "sans favori, l'allumage garde le dernier salon",
  base.applyStartupChannel(COLD).channelId === OTHER,
  'rien ne justifierait de le perdre',
);

// Ni favori ni visite : il n'y a rien à imposer.
base.globalData.lastGuildId = null;
base.globalData.lastVoiceChannelId = null;
base.cache.set(GUILD, { guildId: GUILD, defaultVoiceChannelId: null, lastVoiceChannelId: null });
check(
  "sans favori ni visite, rien n'est imposé",
  base.applyStartupChannel(COLD) === null && base.applyStartupChannel(RESUME) === null,
);

// Le témoin que l'instance relancée transmet, et que le démarrage relit.
{
  const fsRead = (...parts) => require('fs').readFileSync(require('path').join(__dirname, '..', ...parts), 'utf8');
  const handlers = fsRead('src', 'web', 'websocket', 'handlers', 'systemHandlers.js');
  const entry = fsRead('src', 'index.js');

  check("l'instance qui se relance passe le témoin", /IMP_RESTART: '1'/.test(handlers));
  check(
    '  … et le démarrage le relit pour trancher',
    /const resuming = process\.env\.IMP_RESTART === '1'/.test(entry) &&
      /applyStartupChannel\(\{ resuming \}\)/.test(entry),
  );
  check(
    "  … sans le consommer : le fondu d'ouverture en a besoin ensuite",
    !/delete process\.env\.IMP_RESTART/.test(entry),
    'PlaybackStateManager le retire lui-même',
  );
}

// ─────────────── La restauration de lecture suit le même ordre ───────────────

console.log('\nCe que la restauration de lecture choisit\n');

{
  // Ce chemin-là exige un client Discord et une file : c'est l'ordre écrit
  // qui est vérifié, et c'est bien lui qui a changé. Le favori y passait
  // devant les deux autres.
  const restore = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'database', 'PlaybackStateManager.js'),
    'utf8',
  );

  check(
    "une reprise retrouve d'abord ce qui jouait",
    /\? \(activeChannelId \|\| settings\.lastVoiceChannelId \|\| settings\.defaultVoiceChannelId\)/.test(restore),
    "le process est reparti, pas l'écoute",
  );
  check(
    'un allumage suit le salon que le démarrage vient de fixer',
    /: \(settings\.lastVoiceChannelId \|\| settings\.defaultVoiceChannelId \|\| activeChannelId\)/.test(restore),
    "c'est là que le favori a son mot à dire",
  );
  check('et les deux ordres se distinguent par la nature du lancement', /const channelId = isRestart/.test(restore));
}

// ──────────────── PresenceManager : le favori n'y a plus cours ────────────────

console.log('\nassignedChannel — the attachment, never the favorite\n');

const presenceManager = require('../src/audio/PresenceManager');

/** Salon vocal minimal : ce que `salonAssigne` en consulte. */
const channel = (id, humans = 0) => ({
  id,
  isVoiceBased: () => true,
  members: {
    filter: () => ({ size: humans }),
  },
});

/**
 * Installe un serveur, ses salons et sa file, puis rend le salon retenu.
 * @param {{ active?: string, connected?: string, last?: string, favorite?: string }} state
 */
function assigned(state) {
  const channels = new Map([
    [FAVORITE, channel(FAVORITE, 1)],
    [OTHER, channel(OTHER, 1)],
  ]);

  base.cache.set(GUILD, {
    guildId: GUILD,
    defaultVoiceChannelId: state.favorite || null,
    lastVoiceChannelId: state.last || null,
  });

  presenceManager.client = {
    guilds: { cache: { get: (id) => (id === GUILD ? { channels: { cache: channels } } : null) } },
  };
  presenceManager.player = {
    queues: {
      get: () => ({
        activeChannelId: state.active || null,
        channel: state.connected ? { id: state.connected } : null,
      }),
    },
  };

  const retained = presenceManager.assignedChannel(GUILD);
  return retained ? retained.id : null;
}

check(
  'the attachment in progress wins',
  assigned({ active: OTHER, favorite: FAVORITE }) === OTHER,
  assigned({ active: OTHER, favorite: FAVORITE }),
);

check(
  'without an attachment, the channel the bot is in — not the favorite',
  assigned({ connected: OTHER, favorite: FAVORITE }) === OTHER,
  assigned({ connected: OTHER, favorite: FAVORITE }),
);

check(
  'then the last channel visited — not the favorite',
  assigned({ last: OTHER, favorite: FAVORITE }) === OTHER,
  assigned({ last: OTHER, favorite: FAVORITE }),
);

check(
  'a favorite on its own no longer attaches anything',
  assigned({ favorite: FAVORITE }) === null,
  String(assigned({ favorite: FAVORITE })),
);

check(
  'at startup the favorite is found again — as the current channel',
  assigned({ last: FAVORITE, favorite: FAVORITE }) === FAVORITE,
  assigned({ last: FAVORITE, favorite: FAVORITE }),
);

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
