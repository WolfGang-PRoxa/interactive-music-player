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
    else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
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

console.log('\napplyFavoriteChannel — startup\n');

const applied = base.applyFavoriteChannel();

check('the favorite is returned to the caller',
    applied && applied.guildId === GUILD && applied.channelId === FAVORITE,
    applied ? `${applied.guildId}:${applied.channelId}` : 'aucun');
check('it becomes the global current channel',
    base.getLastVoiceChannel().channelId === FAVORITE, base.getLastVoiceChannel().channelId);
check('  … and the last channel of the guild',
    base.getSettings(GUILD).lastVoiceChannelId === FAVORITE);

// Le geste de l'utilisateur, en pleine session : `handleSelectChannel` inscrit
// le salon choisi. Le favori, lui, ne bouge pas — il vaudra au prochain
// démarrage.
base.setLastVoiceChannel(GUILD, OTHER);
check('a selection made during the session takes over',
    base.getLastVoiceChannel().channelId === OTHER, base.getLastVoiceChannel().channelId);
check('  … without erasing the favorite, which will serve again at startup',
    base.getSettings(GUILD).defaultVoiceChannelId === FAVORITE);
check('  … and nothing recalls it before: only a new startup applies it',
    base.applyFavoriteChannel().channelId === FAVORITE
    && base.getLastVoiceChannel().channelId === FAVORITE);

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

check('the attachment in progress wins',
    assigned({ active: OTHER, favorite: FAVORITE }) === OTHER,
    assigned({ active: OTHER, favorite: FAVORITE }));

check('without an attachment, the channel the bot is in — not the favorite',
    assigned({ connected: OTHER, favorite: FAVORITE }) === OTHER,
    assigned({ connected: OTHER, favorite: FAVORITE }));

check('then the last channel visited — not the favorite',
    assigned({ last: OTHER, favorite: FAVORITE }) === OTHER,
    assigned({ last: OTHER, favorite: FAVORITE }));

check('a favorite on its own no longer attaches anything',
    assigned({ favorite: FAVORITE }) === null,
    String(assigned({ favorite: FAVORITE })));

check('at startup the favorite is found again — as the current channel',
    assigned({ last: FAVORITE, favorite: FAVORITE }) === FAVORITE,
    assigned({ last: FAVORITE, favorite: FAVORITE }));

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
