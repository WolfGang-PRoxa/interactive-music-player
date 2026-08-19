/**
 * Vérifie la barrière du contrôle partagé.
 *
 * Le maître de session peut confier une partie du bot à des membres du salon
 * vocal : mener la lecture, garnir la file, tenir les playlists, régler le
 * volume. Le tableau de bord d'un invité grise ce qu'il n'a pas le droit de
 * faire, mais cet affichage ne protège rien — la console du navigateur envoie
 * le message qu'elle veut. La seule barrière est celle du serveur, et c'est
 * elle que ce test surveille.
 *
 * Les garanties à ne jamais reperdre :
 *
 *   - le maître peut tout, y compris ce qui éteint le bot ;
 *   - un invité ne peut que ce qui lui a été explicitement accordé ;
 *   - une commande absente de la table est refusée, et non permise : une
 *     fonctionnalité ajoutée sans y penser doit être fermée par défaut ;
 *   - `updateSettings` mêle des réglages de plusieurs groupes et se filtre
 *     champ par champ, sans jamais laisser passer un réglage du maître ;
 *   - un invité ne peut pas s'accorder de droits à lui-même ;
 *   - retirer le dernier droit efface l'invité de la table plutôt que d'y
 *     laisser quatre `false`.
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

stub('../src/utils/logger', {
    info() {}, warn() {}, error() {}, success() {}, debug() {}, getHistory: () => [],
});

// La vraie base, mais coupée du disque : sans ce double elle lirait — et
// réécrirait — le settings.json de l'utilisateur.
stub('../src/utils/atomicJson', {
    readJsonSafe: () => null,
    writeJsonAtomic: () => {},
    cleanStaleTemp: () => {},
});

const permissions = require('../src/web/permissions');
const database = require('../src/database/Database');
const routes = require('../src/web/websocket/handlers');

const GUILD = 'guilde-test';
const PAUL = '111111111111111111';

const MAITRE = { master: true };
const invite = (droits) => ({ master: false, permissions: permissions.sanitize(droits) });

console.log('Contrôle partagé — barrière des droits\n');

// ───────────────────── 1. Le maître n'est bridé par rien ─────────────────────

console.log('=== 1. Le maître ===\n');

check('le maître peut éteindre le bot', permissions.canSend(MAITRE, 'shutdownBot'));
check('le maître peut changer de version', permissions.canSend(MAITRE, 'installVersion'));
check('le maître peut partager le contrôle', permissions.canSend(MAITRE, 'shareControl'));
check('le maître garde tous ses réglages',
    Object.keys(permissions.filterSettings(MAITRE, { baseVolume: 20, preloading: {} }).allowed).length === 2);

// ─────────────────── 2. Un invité n'a que ce qu'on lui donne ───────────────────

console.log('\n=== 2. Les groupes ===\n');

const lecteur = invite({ playback: true });
check('lecture accordée : mettre en pause', permissions.canSend(lecteur, 'pause'));
check('lecture accordée : chercher dans la piste', permissions.canSend(lecteur, 'seek'));
check('lecture seule : pas de vidage de file', !permissions.canSend(lecteur, 'clearQueue'));
check('lecture seule : pas de suppression de playlist', !permissions.canSend(lecteur, 'deletePlaylist'));
check('lecture seule : pas de changement de salon', !permissions.canSend(lecteur, 'selectChannel'));

const fileur = invite({ queue: true });
check('file accordée : ajouter depuis la recherche', permissions.canSend(fileur, 'play'));
check('file accordée : jouer immédiatement', permissions.canSend(fileur, 'playNow'));
check('file accordée : vider l\'historique', permissions.canSend(fileur, 'clearHistory'));
check('file seule : pas de pause', !permissions.canSend(fileur, 'pause'));

const listeur = invite({ playlists: true });
check('playlists accordées : créer', permissions.canSend(listeur, 'createPlaylist'));
check('playlists accordées : y ajouter un titre', permissions.canSend(listeur, 'addTrackToPlaylist'));
check('playlists seules : pas de retrait de la file', !permissions.canSend(listeur, 'removeTrack'));

const sondier = invite({ volume: true });
check('volume accordé : changer de salon', permissions.canSend(sondier, 'selectChannel'));
check('volume accordé : couper la détection d\'un membre', permissions.canSend(sondier, 'toggleVoiceDetection'));
check('volume seul : pas de saut de piste', !permissions.canSend(sondier, 'skip'));

const rien = invite({});
check('sans droit : rien de tout cela',
    !['pause', 'play', 'createPlaylist', 'selectChannel'].some((t) => permissions.canSend(rien, t)));

// ─────────────────────── 3. Ce qui reste au maître seul ───────────────────────

console.log('\n=== 3. Réservé au maître ===\n');

const toutPuissant = invite({ playback: true, queue: true, playlists: true, volume: true });
for (const interdit of ['shutdownBot', 'restartBot', 'installVersion', 'uninstallVersion',
    'listVersions', 'leaveGuild', 'setDefaultChannel']) {
    check(`un invité comblé ne peut pas « ${interdit} »`, !permissions.canSend(toutPuissant, interdit));
}
check('un invité ne s\'accorde pas de droits', !permissions.canSend(toutPuissant, 'shareControl'));
check('un invité ne révoque personne', !permissions.canSend(toutPuissant, 'revokeControl'));
check('un invité ne poste pas le lien d\'invitation', !permissions.canSend(toutPuissant, 'sendInviteLink'));

// ──────────────────────── 4. Fermé par défaut ────────────────────────

console.log('\n=== 4. Commande inconnue ===\n');

check('une commande absente de la table est refusée',
    !permissions.canSend(toutPuissant, 'commandeAjouteePlusTard'));
check('toute route déclarée a un droit associé',
    Object.keys(routes).every((type) =>
        Object.prototype.hasOwnProperty.call(permissions.ACTION_GROUPS, type)),
    `${Object.keys(routes).length} routes`);
check('tout droit déclaré correspond à une route',
    Object.keys(permissions.ACTION_GROUPS).every((type) => Boolean(routes[type])));

// ─────────────────── 5. updateSettings, champ par champ ───────────────────

console.log('\n=== 5. Filtrage des réglages ===\n');

const melange = {
    baseVolume: 20,          // groupe volume
    duckingLevel: 35,        // groupe volume
    playbackSpeed: 1.5,      // groupe playback
    preloading: { enabled: false },   // maître seul
    presenceDepartureDelay: 0,        // maître seul
};

const filtreVolume = permissions.filterSettings(sondier, melange);
check('volume accordé : baseVolume passe', filtreVolume.allowed.baseVolume === 20);
check('volume accordé : duckingLevel passe', filtreVolume.allowed.duckingLevel === 35);
check('volume accordé : playbackSpeed écarté', filtreVolume.allowed.playbackSpeed === undefined);
check('volume accordé : préchargement écarté', filtreVolume.allowed.preloading === undefined);
check('volume accordé : délai de départ écarté', filtreVolume.allowed.presenceDepartureDelay === undefined);
check('les champs refusés sont nommés', filtreVolume.refused.includes('preloading'));

const filtreRien = permissions.filterSettings(rien, melange);
check('sans droit : plus rien ne passe', Object.keys(filtreRien.allowed).length === 0);

check('la porte laisse entrer updateSettings, le filtre tranche',
    permissions.canSend(rien, 'updateSettings'));

// ─────────────────── 6. Enregistrement et révocation ───────────────────

console.log('\n=== 6. Stockage des droits ===\n');

check('inconnu : aucun droit',
    !permissions.hasAny(database.getUserPermissions(GUILD, PAUL)));

database.setUserPermissions(GUILD, PAUL, { playback: true, queue: true });
const relus = database.getUserPermissions(GUILD, PAUL);
check('droits relus après enregistrement', relus.playback === true && relus.queue === true);
check('les groupes non accordés restent faux', relus.playlists === false && relus.volume === false);
check('l\'invité figure dans les partages',
    Object.prototype.hasOwnProperty.call(database.getSharedControl(GUILD), PAUL));

database.setUserPermissions(GUILD, PAUL, { playback: false, queue: false });
check('retirer le dernier droit efface l\'entrée',
    !Object.prototype.hasOwnProperty.call(database.getSharedControl(GUILD), PAUL));

database.setUserPermissions(GUILD, PAUL, { volume: true });
database.revokeUserPermissions(GUILD, PAUL);
check('la révocation vide les droits',
    !permissions.hasAny(database.getUserPermissions(GUILD, PAUL)));

// Une charge utile venue du réseau n'a pas à être crue sur parole.
const salies = database.setUserPermissions(GUILD, PAUL, {
    playback: 'oui', queue: 1, playlists: {}, volume: true, master: true, admin: true,
});
check('seul un vrai booléen accorde un droit',
    salies.playback === false && salies.queue === false && salies.playlists === false);
check('un groupe inventé n\'est pas retenu', salies.master === undefined && salies.admin === undefined);
check('le droit légitime survit à l\'assainissement', salies.volume === true);

// ─────────────────────────────── Bilan ───────────────────────────────

console.log(`\n=== ${passed} réussite(s), ${failed} échec(s) ===`);
process.exit(failed > 0 ? 1 : 0);
