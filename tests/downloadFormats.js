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
 *   - le défaut est MP3.
 */
const fs = require('fs');
const path = require('path');

let failed = 0;
let passed = 0;
const check = (label, ok, detail = '') => {
    if (ok) { passed++; console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`); }
    else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
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

    const ok = ext === want.ext
        && args[args.indexOf('-acodec') + 1] === want.codec
        && args[args.indexOf('-f') + 1] === want.mux;
    check(`${container} → ${want.ext}, ${want.codec}, muxer ${want.mux}`, ok, line);

    // Le débit : présent pour ce qui compresse, absent pour le reste. Un `-ab`
    // sur du FLAC ne casserait rien, mais laisserait croire à un réglage qui
    // n'en est pas un.
    check(want.lossy ? '  … avec le débit demandé' : '  … et sans débit, qui n’aurait pas de sens',
        want.lossy ? line.includes('-ab 192k') : !line.includes('-ab'), line);
}

console.log('\nCe qui est refusé\n');

const fallback = formats.encodeArgs('exe', 320);
check('un conteneur inconnu retombe sur MP3',
    fallback.ext === '.mp3' && fallback.args.includes('libmp3lame'), fallback.args.join(' '));

const noBitrate = formats.encodeArgs('mp3', 'beaucoup');
check('un débit illisible ne produit pas « -ab NaNk »',
    noBitrate.args.join(' ').includes('-ab 320k'), noBitrate.args.join(' '));

// ────────────────────── Les deux bouts du fil ──────────────────────

console.log('\nLe menu et le module\n');

const markup = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'web', 'public', 'index.html'), 'utf8');
const select = (markup.match(/<select id="import-format-select"[\s\S]*?<\/select>/) || [''])[0];
const options = [...select.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);

check('le menu propose les conteneurs du module, et rien d’autre',
    options.length === formats.EXTENSIONS.length
        && options.every((v) => formats.EXTENSIONS.includes(v)),
    options.join(', ') || 'aucune option trouvée');

// Aucun conteneur vidéo : le téléchargement vers le disque passe par le flux
// audio du préchargeur, et proposer MP4 promettrait une image que rien ne va
// chercher.
check('  … tous audio, aucun conteneur vidéo',
    !options.includes('mp4'), options.join(', '));

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
    info() {}, error() {}, debug() {}, success() {},
    warn: (m) => logged.push(String(m)),
});

const guildHandlers = require('../src/web/websocket/handlers/guildHandlers');
const context = (data) => ({
    ws: {}, data, player: null, queue: null, currentGuildId: 'g-essai',
    webServer: { broadcastState() {}, client: null },
});

async function run() {
    written.length = 0;
    await guildHandlers.handleUpdateSettings(context({ importFormat: 'flac' }));
    const kept = written[written.length - 1];
    check('une extension connue est retenue', !!kept && kept.importFormat === 'flac',
        kept ? String(kept.importFormat) : 'rien écrit');

    written.length = 0;
    logged.length = 0;
    await guildHandlers.handleUpdateSettings(
        context({ importFormat: 'exe', importAudioQuality: '128' }));
    const filtered = written[written.length - 1];
    check('une extension inconnue est écartée',
        !!filtered && filtered.importFormat === undefined,
        filtered ? JSON.stringify(filtered) : 'rien écrit');
    check('  … sans emporter ce qui l’accompagnait',
        !!filtered && filtered.importAudioQuality === '128');
    check('  … et le journal le dit',
        logged.some((l) => l.includes('exe')), logged.join(' | ') || 'silence');

    // La vraie base, en lecture seule : `getSettings` n'écrit rien sur le disque.
    delete require.cache[require.resolve('../src/database/Database')];
    const realDatabase = require('../src/database/Database');
    const fresh = realDatabase.getSettings(`test-format-${Date.now()}`);
    check('un serveur inconnu part sur MP3',
        fresh.importFormat === formats.DEFAULT_CONTAINER, String(fresh.importFormat));

    console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
    process.exit(failed === 0 ? 0 : 1);
}

run();
