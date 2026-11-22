/**
 * Vérifie que la destination du champ d'ajout est retenue.
 *
 * Le menu déroulant « Vers la file d'attente / la playlist / la lecture / le
 * dossier » ne vivait que dans le `<select>` de la page ouverte. Un
 * rechargement, un redémarrage du bot, un autre appareil : il retombait sur la
 * file d'attente, et le choix précédent n'avait laissé aucune trace.
 *
 * Il est désormais retenu par serveur, comme les deux menus de qualité d'import
 * qui le voisinent dans la même boîte — trois de ses quatre valeurs désignant
 * d'ailleurs des choses propres au serveur : sa file, sa playlist active, sa
 * lecture en cours.
 *
 * Ce qui est vérifié ici :
 *
 *   - une destination connue est écrite dans les réglages du bon serveur ;
 *   - une valeur inconnue est écartée plutôt que retenue, sans quoi le menu
 *     rouvrirait sur une option qui n'existe pas — donc vide ;
 *   - le reste du message passe malgré tout : écarter la destination ne doit
 *     pas faire tomber les réglages qui l'accompagnent ;
 *   - la liste du serveur et les options du balisage disent la même chose ;
 *   - la valeur par défaut est bien la file d'attente.
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

/** Remplace un module par un double avant que quiconque ne le charge. */
function stub(moduleName, exports) {
  const resolved = require.resolve(moduleName);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

/*
 * Toutes les dépendances du routeur sont doublées.
 *
 * La base en premier lieu : le test écrit des réglages, et sur la vraie base il
 * changerait ceux de la personne qui le lance. Les autres suivent parce que les
 * charger pour de bon demanderait un bot connecté — ce qui est éprouvé ici est
 * le handler, pas ce qu'il y a autour.
 */
const written = [];
let settings = {};

stub('../src/database/Database', {
  getSettings: () => ({ ...settings }),
  updateSettings: (guildId, updates) => {
    written.push({ guildId, updates: { ...updates } });
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
  warn: (message) => logged.push(String(message)),
});

const guildHandlers = require('../src/web/websocket/handlers/guildHandlers');

/** Le contexte que wsHandler assemble, réduit à ce que ce chemin touche. */
function context(data) {
  return {
    ws: {},
    data,
    webServer: { broadcastState() {}, client: null },
    player: null,
    queue: null,
    currentGuildId: 'g-essai',
  };
}

console.log('\n=== Destination du champ d’ajout ===\n');

async function run() {
  console.log('Ce qui est retenu\n');

  for (const target of ['queue', 'playlist', 'play', 'download']) {
    written.length = 0;
    await guildHandlers.handleUpdateSettings(context({ addTarget: target }));
    const last = written[written.length - 1];
    check(
      `« ${target} » est écrit dans les réglages`,
      !!last && last.updates.addTarget === target && last.guildId === 'g-essai',
      last ? `${last.guildId} → ${last.updates.addTarget}` : 'rien écrit',
    );
  }

  console.log('\nCe qui est écarté\n');

  written.length = 0;
  logged.length = 0;
  await guildHandlers.handleUpdateSettings(context({ addTarget: 'vers-la-lune' }));
  const rejected = written[written.length - 1];
  check(
    'une destination inconnue n’est pas retenue',
    !rejected || rejected.updates.addTarget === undefined,
    rejected ? String(rejected.updates.addTarget) : 'rien écrit',
  );
  check(
    '  … et le journal le dit',
    logged.some((line) => line.includes('vers-la-lune')),
    logged.join(' | ') || 'silence',
  );

  // Le message porte souvent plusieurs réglages d'un coup : écarter la
  // destination ne doit pas emporter ses voisins.
  written.length = 0;
  await guildHandlers.handleUpdateSettings(context({ addTarget: 'nimporte-quoi', importAudioQuality: '192' }));
  const mixed = written[written.length - 1];
  check(
    'les réglages qui l’accompagnent passent quand même',
    !!mixed && mixed.updates.importAudioQuality === '192' && mixed.updates.addTarget === undefined,
    mixed ? JSON.stringify(mixed.updates) : 'rien écrit',
  );

  console.log('\nLes deux bouts du fil\n');

  /*
   * La liste du serveur et les options du balisage sont écrites des deux
   * côtés : ajouter une destination d'un seul côté la rendrait soit
   * inatteignable, soit refusée à l'enregistrement.
   */
  const source = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

  const handlers = source(path.join('src', 'web', 'websocket', 'handlers', 'guildHandlers.js'));
  const listed = (handlers.match(/const ADD_TARGETS = \[([^\]]*)\]/) || [, ''])[1]
    .split(',')
    .map((s) => s.trim().replace(/^'|'$/g, ''))
    .filter(Boolean);

  const markup = source(path.join('src', 'web', 'public', 'index.html'));
  const select = (markup.match(/<select id="add-target-select"[\s\S]*?<\/select>/) || [''])[0];
  const options = [...select.matchAll(/<option\s+value="([^"]+)"/g)].map((m) => m[1]);

  check('le serveur connaît quatre destinations', listed.length === 4, listed.join(', '));
  check(
    'le menu en propose autant, et les mêmes',
    options.length === listed.length && options.every((v) => listed.includes(v)),
    options.join(', ') || 'aucune option trouvée',
  );

  console.log('\nLa valeur par défaut\n');

  // La vraie base, en lecture seule : `getSettings` n'écrit rien sur le
  // disque, elle ne fait que réappliquer les valeurs par défaut.
  delete require.cache[require.resolve('../src/database/Database')];
  const realDatabase = require('../src/database/Database');
  const fresh = realDatabase.getSettings(`test-add-target-${Date.now()}`);
  check('un serveur inconnu part sur la file d’attente', fresh.addTarget === 'queue', String(fresh.addTarget));

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed === 0 ? 0 : 1);
}

run();
