/**
 * Vérifie que le salon favori ne vaut qu'au démarrage.
 *
 * Le favori désigne le salon sur lequel le bot et le tableau de bord se posent
 * quand le process démarre. Il était pourtant relu en pleine session — par la
 * règle de présence à chaque mouvement vocal, par le tableau de bord à chaque
 * connexion —, si bien qu'un salon marqué d'une étoile ramenait sans cesse tout
 * le monde sur lui : on ne pouvait plus s'installer ailleurs.
 *
 * Le favori est désormais appliqué une fois, au démarrage
 * (`Database.appliquerSalonFavori`), où il devient le salon courant. Tout le
 * reste ne suit plus que ce salon courant.
 *
 * Les garanties à ne jamais reperdre :
 *
 *   - au démarrage, le favori l'emporte et devient le salon courant ;
 *   - une sélection ultérieure l'emporte sur le favori, et le reste ;
 *   - la règle de présence ne connaît plus le favori.
 */

let failed = 0;
let passed = 0;
const check = (label, ok, detail = '') => {
    if (ok) { passed++; console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`); }
    else { failed++; console.log(`  ECHEC ${label}${detail ? ` — ${detail}` : ''}`); }
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
    info() {}, warn() {}, error() {}, success() {}, getHistory: () => [],
});

// ─────────────────── Database : l'application du favori ───────────────────

const GUILD = 'g1';
const FAVORITE = 'salon_favori';
const OTHER = 'salon_autre';

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

console.log('\nappliquerSalonFavori — le démarrage\n');

const applied = base.applyFavoriteChannel();

check('le favori est retourné à l\'appelant',
    applied && applied.guildId === GUILD && applied.channelId === FAVORITE,
    applied ? `${applied.guildId}:${applied.channelId}` : 'aucun');
check('il devient le salon courant global',
    base.getLastVoiceChannel().channelId === FAVORITE, base.getLastVoiceChannel().channelId);
check('  … et le dernier salon du serveur',
    base.getSettings(GUILD).lastVoiceChannelId === FAVORITE);

// Le geste de l'utilisateur, en pleine session : `handleSelectChannel` inscrit
// le salon choisi. Le favori, lui, ne bouge pas — il vaudra au prochain
// démarrage.
base.setLastVoiceChannel(GUILD, OTHER);
check('une sélection en session prend la main',
    base.getLastVoiceChannel().channelId === OTHER, base.getLastVoiceChannel().channelId);
check('  … sans effacer le favori, qui resservira au démarrage',
    base.getSettings(GUILD).defaultVoiceChannelId === FAVORITE);
check('  … et rien ne le rappelle avant : seul un nouveau démarrage l\'applique',
    base.applyFavoriteChannel().channelId === FAVORITE
    && base.getLastVoiceChannel().channelId === FAVORITE);

// ──────────────── PresenceManager : le favori n'y a plus cours ────────────────

console.log('\nsalonAssigne — le rattachement, jamais le favori\n');

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
 * @param {{ actif?: string, connecte?: string, dernier?: string, favori?: string }} etat
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

check('le rattachement en cours prime',
    assigned({ active: OTHER, favorite: FAVORITE }) === OTHER,
    assigned({ active: OTHER, favorite: FAVORITE }));

check('sans rattachement, le salon où le bot se trouve — pas le favori',
    assigned({ connected: OTHER, favorite: FAVORITE }) === OTHER,
    assigned({ connected: OTHER, favorite: FAVORITE }));

check('puis le dernier salon visité — pas le favori',
    assigned({ last: OTHER, favorite: FAVORITE }) === OTHER,
    assigned({ last: OTHER, favorite: FAVORITE }));

check('un favori seul ne rattache plus rien',
    assigned({ favorite: FAVORITE }) === null,
    String(assigned({ favorite: FAVORITE })));

check('au démarrage, le favori est retrouvé — comme salon courant',
    assigned({ last: FAVORITE, favorite: FAVORITE }) === FAVORITE,
    assigned({ last: FAVORITE, favorite: FAVORITE }));

console.log(`\n=== ${passed} réussite(s), ${failed} échec(s) ===`);
process.exit(failed === 0 ? 0 : 1);
