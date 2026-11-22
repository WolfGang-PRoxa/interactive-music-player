/**
 * Vérifie le format des fichiers écrits sur le disque du bot.
 *
 * Le menu « Format » de la boîte d'ajout ne choisit qu'une extension ; le débit
 * reste celui du menu « Audio » voisin. `utils/downloadFormats.js` fait la
 * jonction, et le handler de téléchargement s'en sert au lieu du MP3 qu'il
 * écrivait en dur.
 *
 * Ce qui est vérifié ici :
 *
 *   - chaque conteneur rend son extension, son codec et son muxer ;
 *   - le débit s'applique aux formats avec perte et jamais aux autres, où
 *     ffmpeg l'ignorerait de toute façon ;
 *   - un conteneur inconnu retombe sur MP3 plutôt que de produire une ligne de
 *     commande sans muxer ;
 *   - le menu du balisage et la liste du module proposent les mêmes ;
 *   - le serveur écarte une extension qu'il ne sait pas écrire ;
 *   - le défaut est MP3 ;
 *   - un format qui échoue à l'encodage est réessayé en MP3, sur une entrée
 *     fraîchement résolue, et l'utilisateur en est averti — la composition de la
 *     source ne se découvre qu'au moment de l'encoder ;
 *   - MP3 qui échoue n'est pas réessayé à l'identique.
 */
const fs = require('fs');
const path = require('path');

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

const formats = require('../src/utils/downloadFormats');

console.log('\n=== Format des téléchargements ===\n');

// ────────────────────── Les conteneurs ──────────────────────

console.log('Ce que chaque conteneur demande à ffmpeg\n');

const EXPECTED = {
  mp3: { ext: '.mp3', codec: 'libmp3lame', mux: 'mp3', lossy: true },
  m4a: { ext: '.m4a', codec: 'aac', mux: 'ipod', lossy: true },
  flac: { ext: '.flac', codec: 'flac', mux: 'flac', lossy: false },
  wav: { ext: '.wav', codec: 'pcm_s16le', mux: 'wav', lossy: false },
  ogg: { ext: '.ogg', codec: 'libvorbis', mux: 'ogg', lossy: true },
  opus: { ext: '.opus', codec: 'libopus', mux: 'opus', lossy: true },
  webm: { ext: '.webm', codec: 'libopus', mux: 'webm', lossy: true },
};

for (const [container, want] of Object.entries(EXPECTED)) {
  const { ext, args } = formats.encodeArgs(container, 192);
  const line = args.join(' ');

  const ok =
    ext === want.ext && args[args.indexOf('-acodec') + 1] === want.codec && args[args.indexOf('-f') + 1] === want.mux;
  check(`${container} → ${want.ext}, ${want.codec}, muxer ${want.mux}`, ok, line);

  // Le débit : présent pour ce qui compresse, absent pour le reste. Un `-ab`
  // sur du FLAC ne casserait rien, mais laisserait croire à un réglage qui
  // n'en est pas un.
  check(
    want.lossy ? '  … avec le débit demandé' : '  … et sans débit, qui n’aurait pas de sens',
    want.lossy ? line.includes('-ab 192k') : !line.includes('-ab'),
    line,
  );
}

console.log('\nCe qui est refusé\n');

const fallback = formats.encodeArgs('exe', 320);
check(
  'un conteneur inconnu retombe sur MP3',
  fallback.ext === '.mp3' && fallback.args.includes('libmp3lame'),
  fallback.args.join(' '),
);

const noBitrate = formats.encodeArgs('mp3', 'beaucoup');
check(
  'un débit illisible ne produit pas « -ab NaNk »',
  noBitrate.args.join(' ').includes('-ab 320k'),
  noBitrate.args.join(' '),
);

// ────────────────────── Les deux bouts du fil ──────────────────────

console.log('\nLe menu et le module\n');

const markup = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'public', 'index.html'), 'utf8');
const select = (markup.match(/<select id="import-format-select"[\s\S]*?<\/select>/) || [''])[0];
const options = [...select.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);

check(
  'le menu propose les conteneurs du module, et rien d’autre',
  options.length === formats.EXTENSIONS.length && options.every((v) => formats.EXTENSIONS.includes(v)),
  options.join(', ') || 'aucune option trouvée',
);

/*
 * Les deux familles sont séparées dans le menu, et il le faut.
 *
 * Elles ne promettent pas la même chose : un conteneur vidéo demande une image,
 * et en fabrique une noire quand la source n'en porte pas. Mêlés à la même liste,
 * MP4 et MP3 se choisiraient comme deux variantes d'un même geste.
 */
const groupes = [...select.matchAll(/<optgroup label="([^"]+)"[\s\S]*?<\/optgroup>/g)];
check(
  '  … rangés en deux groupes, audio et vidéo',
  groupes.length === 2,
  groupes.map((g) => g[1]).join(' / ') || 'aucun groupe',
);

const groupeVideo = groupes.find((g) => /vid/i.test(g[1]));
const optionsVideo = groupeVideo ? [...groupeVideo[0].matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]) : [];

check(
  '  … et le groupe vidéo porte exactement les conteneurs vidéo du module',
  optionsVideo.length === Object.keys(formats.VIDEO_CONTAINERS).length && optionsVideo.every((v) => formats.isVideo(v)),
  optionsVideo.join(', ') || 'aucun',
);

check(
  "  … qu'aucun ne se retrouve du côté audio",
  !groupes.filter((g) => !/vid/i.test(g[1])).some((g) => /<option value="(mp4|mkv)"/.test(g[0])),
  'deux entrées homonymes ne se distinguent pas dans un menu',
);

// ────────────────────── Le refus côté serveur ──────────────────────

console.log('\nCe que le serveur accepte d’enregistrer\n');

function stub(moduleName, exports) {
  const resolved = require.resolve(moduleName);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const written = [];
let settings = {};
stub('../src/database/Database', {
  getSettings: () => ({ ...settings }),
  updateSettings: (guildId, updates) => {
    written.push({ ...updates });
    settings = { ...settings, ...updates };
  },
});
stub('../src/broadcast/BroadcastManager', { setMode() {} });
stub('../src/audio/PresenceManager', { rescheduleDeparture() {} });
stub('../src/database/PlaybackStateManager', { saveState() {} });
stub('../src/utils/historyOrder', { restoreHistory: () => [] });
stub('../src/audio/mix', { ensureEngine() {}, activeEngine: () => null });
stub('../src/audio/playbackSettings', { applySpeed() {}, cancelMixEffects() {} });

const logged = [];
stub('../src/utils/logger', {
  info() {},
  error() {},
  debug() {},
  success() {},
  warn: (m) => logged.push(String(m)),
});

const guildHandlers = require('../src/web/websocket/handlers/guildHandlers');
const context = (data) => ({
  ws: {},
  data,
  player: null,
  queue: null,
  currentGuildId: 'g-essai',
  webServer: { broadcastState() {}, client: null },
});

// ────────────────────── Le repli quand l'encodage échoue ──────────────────────

/*
 * On ne sait pas d'avance ce qu'on télécharge.
 *
 * Le débit de la source, son nombre de canaux, sa fréquence d'échantillonnage
 * ne se découvrent qu'à l'encodage, et tel encodeur refuse ce que tel autre
 * accepte. Le handler réessaie donc en MP3 — le format que rien ne refuse — au
 * lieu de rendre un échec là où un fichier était possible.
 *
 * ffmpeg est remplacé par un double : le test décide quel conteneur échoue, et
 * observe ce que le handler fait ensuite.
 */
const os = require('os');
const { EventEmitter } = require('events');

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-formats-'));

/** Les conteneurs pour lesquels le faux ffmpeg refusera d'écrire. */
let failFor = [];
/** Les fichiers de sortie demandés, dans l'ordre des tentatives. */
const attempts = [];

stub('child_process', {
  spawn: (bin, args) => {
    const out = args[args.length - 1];
    attempts.push(out);

    const child = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.write = () => true;
    child.stdin.end = () => {};
    child.stderr = new EventEmitter();
    child.kill = () => {};

    const container = path.extname(out.replace(/\.incomplete$/, '')).slice(1);
    setImmediate(() => {
      if (failFor.includes(container)) {
        child.stderr.emit('data', Buffer.from(`Encoder refuses ${container}`));
        child.emit('close', 1);
      } else {
        // Un encodage qui aboutit laisse son fichier provisoire, que le
        // handler renomme.
        fs.writeFileSync(out, 'son');
        child.emit('close', 0);
      }
    });
    return child;
  },
});

let resolveCalls = 0;
stub('../src/audio/PreloadManager', {
  resolvePlayableTrack: async (track) => ({ track, url: track.url }),
  resolveAudioInput: async () => {
    resolveCalls++;
    return { ffmpegInput: 'https://exemple/piste.webm', inputStream: null };
  },
});
/*
 * La recherche de source, écartée : ce fichier éprouve le choix du conteneur et
 * son repli, pas la sélection du flux.
 *
 * Sans ce double, `resolveAudio` lancerait youtube-dl sur une adresse inventée à
 * chaque téléchargement d'essai, et ses arguments se mêleraient à ceux de ffmpeg
 * dans ce que le test observe. Rendre `null` fait retomber le gestionnaire sur
 * la résolution du préchargeur, doublée juste au-dessus — c'est le chemin que ce
 * fichier veut suivre. Le choix du flux a son propre test.
 */
stub('../src/audio/videoSource', {
  resolveAudio: async () => null,
  resolve: async () => ({ videoUrl: null, audioUrl: null, audioOnly: true }),
});
stub('../src/web/websocket/handlerUtils', {
  searchLocalAwareTrack: async () => ({
    tracks: [{ title: 'Essai', url: 'https://exemple/piste' }],
  }),
});
stub('../src/utils/downloadDir', {
  DEFAULT_DIR: workDir,
  ensure: (d) => {
    fs.mkdirSync(d, { recursive: true });
    return d;
  },
  safeFilename: (title, ext) => `${title}${ext}`,
  uniquePath: (d, name) => path.join(d, name),
});

let chosenFormat = 'flac';
require.cache[require.resolve('../src/database/Database')].exports = {
  getSettings: () => ({ importFormat: chosenFormat, importAudioQuality: '192' }),
  getDownloadDir: () => workDir,
  updateSettings: () => {},
};

const downloadHandlers = require('../src/web/websocket/handlers/downloadHandlers');

async function runFallback() {
  console.log('\nLe repli sur MP3\n');

  const notices = [];
  const ctx = () => ({
    data: { query: 'une chanson' },
    webServer: { _sendError: (m) => notices.push(String(m)) },
    player: null,
    currentGuildId: 'g-essai',
  });

  // 1. Le format demandé passe : aucun repli.
  failFor = [];
  attempts.length = 0;
  resolveCalls = 0;
  await downloadHandlers.handleDownloadTrack(ctx());
  check(
    'un format qui aboutit est écrit tel quel',
    attempts.length === 1 && attempts[0].includes('.flac'),
    attempts.join(', '),
  );

  // 2. Le format demandé échoue : on réessaie en MP3.
  failFor = ['flac'];
  attempts.length = 0;
  resolveCalls = 0;
  notices.length = 0;
  await downloadHandlers.handleDownloadTrack(ctx());

  check(
    'un format qui échoue est réessayé en MP3',
    attempts.length === 2 && attempts[1].includes('.mp3'),
    attempts.join(', '),
  );
  check(
    "  … et l'utilisateur en est averti",
    notices.some((m) => m.includes('FLAC') && m.includes('MP3')),
    notices.join(' | '),
  );

  // L'entrée est redemandée à chaque essai : `resolveAudioInput` peut rendre
  // un flux, qu'une première tentative a consommé. Le réutiliser écrirait un
  // fichier vide.
  check('  … sur une entrée fraîchement résolue', resolveCalls === 2, String(resolveCalls));

  // 3. MP3 lui-même échoue : rien à réessayer.
  chosenFormat = 'mp3';
  failFor = ['mp3'];
  attempts.length = 0;
  notices.length = 0;
  await downloadHandlers.handleDownloadTrack(ctx());
  check("MP3 qui échoue n'est pas réessayé à l'identique", attempts.length === 1, attempts.join(', '));
  check(
    "  … et l'échec est rapporté",
    notices.some((m) => m.toLowerCase().includes('impossible')),
    notices.join(' | '),
  );

  fs.rmSync(workDir, { recursive: true, force: true });
}

async function run() {
  written.length = 0;
  await guildHandlers.handleUpdateSettings(context({ importFormat: 'flac' }));
  const kept = written[written.length - 1];
  check(
    'une extension connue est retenue',
    !!kept && kept.importFormat === 'flac',
    kept ? String(kept.importFormat) : 'rien écrit',
  );

  written.length = 0;
  logged.length = 0;
  await guildHandlers.handleUpdateSettings(context({ importFormat: 'exe', importAudioQuality: '128' }));
  const filtered = written[written.length - 1];
  check(
    'une extension inconnue est écartée',
    !!filtered && filtered.importFormat === undefined,
    filtered ? JSON.stringify(filtered) : 'rien écrit',
  );
  check('  … sans emporter ce qui l’accompagnait', !!filtered && filtered.importAudioQuality === '128');
  check(
    '  … et le journal le dit',
    logged.some((l) => l.includes('exe')),
    logged.join(' | ') || 'silence',
  );

  // La vraie base, en lecture seule : `getSettings` n'écrit rien sur le disque.
  delete require.cache[require.resolve('../src/database/Database')];
  const realDatabase = require('../src/database/Database');
  const fresh = realDatabase.getSettings(`test-format-${Date.now()}`);
  check(
    'un serveur inconnu part sur MP3',
    fresh.importFormat === formats.DEFAULT_CONTAINER,
    String(fresh.importFormat),
  );

  await runFallback();

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed === 0 ? 0 : 1);
}

run();
