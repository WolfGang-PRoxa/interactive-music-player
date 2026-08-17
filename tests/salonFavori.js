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

let echecs = 0;
let reussites = 0;
const verifier = (libelle, ok, detail = '') => {
    if (ok) { reussites++; console.log(`  ok    ${libelle}${detail ? ` — ${detail}` : ''}`); }
    else { echecs++; console.log(`  ECHEC ${libelle}${detail ? ` — ${detail}` : ''}`); }
};

/** Remplace un module par un double avant que quiconque ne le charge. */
function doubler(chemin, exports) {
    const resolu = require.resolve(chemin);
    require.cache[resolu] = { id: resolu, filename: resolu, loaded: true, exports };
}

// `config` est lu au chargement de PresenceManager : la règle doit être active,
// sans quoi `connexionAutorisee` laisserait tout passer et les cas ci-dessous ne
// prouveraient rien.
doubler('../src/config', {
    presence: { enabled: true, departureDelay: 30000 },
    ducking: { enabled: true, level: 20, restoreDelay: 800, fadeDuration: 200 },
    volume: { defaultBase: 70 },
    broadcast: { defaultMode: 'everyone' },
});

doubler('../src/utils/logger', {
    info() {}, warn() {}, error() {}, success() {}, getHistory: () => [],
});

// ─────────────────── Database : l'application du favori ───────────────────

const GUILDE = 'g1';
const FAVORI = 'salon_favori';
const AUTRE = 'salon_autre';

// La vraie base, mais coupée du disque : sans ce double elle lirait — et
// réécrirait — le settings.json de l'utilisateur. `readJsonSafe` rendant null,
// elle démarre sur un cache vide, que le test remplit lui-même.
doubler('../src/utils/atomicJson', {
    readJsonSafe: () => null,
    writeJsonAtomic: () => {},
    cleanStaleTemp: () => {},
});

const base = require('../src/database/Database');
base.cache.set(GUILDE, { guildId: GUILDE, defaultVoiceChannelId: FAVORI, lastVoiceChannelId: null });

console.log('\nappliquerSalonFavori — le démarrage\n');

const applique = base.appliquerSalonFavori();

verifier('le favori est retourné à l\'appelant',
    applique && applique.guildId === GUILDE && applique.channelId === FAVORI,
    applique ? `${applique.guildId}:${applique.channelId}` : 'aucun');
verifier('il devient le salon courant global',
    base.getLastVoiceChannel().channelId === FAVORI, base.getLastVoiceChannel().channelId);
verifier('  … et le dernier salon du serveur',
    base.getSettings(GUILDE).lastVoiceChannelId === FAVORI);

// Le geste de l'utilisateur, en pleine session : `handleSelectChannel` inscrit
// le salon choisi. Le favori, lui, ne bouge pas — il vaudra au prochain
// démarrage.
base.setLastVoiceChannel(GUILDE, AUTRE);
verifier('une sélection en session prend la main',
    base.getLastVoiceChannel().channelId === AUTRE, base.getLastVoiceChannel().channelId);
verifier('  … sans effacer le favori, qui resservira au démarrage',
    base.getSettings(GUILDE).defaultVoiceChannelId === FAVORI);
verifier('  … et rien ne le rappelle avant : seul un nouveau démarrage l\'applique',
    base.appliquerSalonFavori().channelId === FAVORI
    && base.getLastVoiceChannel().channelId === FAVORI);

// ──────────────── PresenceManager : le favori n'y a plus cours ────────────────

console.log('\nsalonAssigne — le rattachement, jamais le favori\n');

const presenceManager = require('../src/audio/PresenceManager');

/** Salon vocal minimal : ce que `salonAssigne` en consulte. */
const salon = (id, humains = 0) => ({
    id,
    isVoiceBased: () => true,
    members: {
        filter: () => ({ size: humains }),
    },
});

/**
 * Installe un serveur, ses salons et sa file, puis rend le salon retenu.
 * @param {{ actif?: string, connecte?: string, dernier?: string, favori?: string }} etat
 */
function assigne(etat) {
    const salons = new Map([
        [FAVORI, salon(FAVORI, 1)],
        [AUTRE, salon(AUTRE, 1)],
    ]);

    base.cache.set(GUILDE, {
        guildId: GUILDE,
        defaultVoiceChannelId: etat.favori || null,
        lastVoiceChannelId: etat.dernier || null,
    });

    presenceManager.client = {
        guilds: { cache: { get: (id) => (id === GUILDE ? { channels: { cache: salons } } : null) } },
    };
    presenceManager.player = {
        queues: {
            get: () => ({
                activeChannelId: etat.actif || null,
                channel: etat.connecte ? { id: etat.connecte } : null,
            }),
        },
    };

    const retenu = presenceManager.salonAssigne(GUILDE);
    return retenu ? retenu.id : null;
}

verifier('le rattachement en cours prime',
    assigne({ actif: AUTRE, favori: FAVORI }) === AUTRE,
    assigne({ actif: AUTRE, favori: FAVORI }));

verifier('sans rattachement, le salon où le bot se trouve — pas le favori',
    assigne({ connecte: AUTRE, favori: FAVORI }) === AUTRE,
    assigne({ connecte: AUTRE, favori: FAVORI }));

verifier('puis le dernier salon visité — pas le favori',
    assigne({ dernier: AUTRE, favori: FAVORI }) === AUTRE,
    assigne({ dernier: AUTRE, favori: FAVORI }));

verifier('un favori seul ne rattache plus rien',
    assigne({ favori: FAVORI }) === null,
    String(assigne({ favori: FAVORI })));

verifier('au démarrage, le favori est retrouvé — comme salon courant',
    assigne({ dernier: FAVORI, favori: FAVORI }) === FAVORI,
    assigne({ dernier: FAVORI, favori: FAVORI }));

console.log(`\n=== ${reussites} réussite(s), ${echecs} échec(s) ===`);
process.exit(echecs === 0 ? 0 : 1);
