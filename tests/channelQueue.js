/**
 * Vérifie la file d'attente rangée, salon vocal par salon vocal.
 *
 * ## Ce qui n'existait pas
 *
 * La file n'était rangée nulle part. Ses titres vivaient dans le lecteur, et
 * n'en étaient recopiés — sous `queueBackupEveryone` ou `queueBackupPersonal` —
 * que le temps qu'une playlist lui prenne la place. D'où trois manques :
 *
 *  - un aiguillage n'avait aucun endroit où s'inscrire, faute de liste rangée
 *    où désigner une position ;
 *  - le bot déplacé d'un salon à l'autre emportait la file du premier ;
 *  - la sauvegarde était par serveur, alors que ce qui écoute est un salon.
 *
 * ## Ce que ce test tient
 *
 *  - **Chaque salon garde la sienne**, et la retrouve au retour. C'est la seule
 *    chose qu'un utilisateur remarquera, et elle ne se voit dans aucun diff.
 *
 *  - **Le lecteur fait foi pour la tête, le rangement pour la queue.** Le
 *    lecteur ne reçoit rien au-delà du premier aiguillage : une recopie qui se
 *    contenterait de le photographier effacerait l'aiguillage et tout ce qui le
 *    suit. Le miroir recolle donc les deux.
 *
 *  - **Une playlist qui occupe le lecteur n'écrase rien.** Ce qu'il porte alors
 *    n'est pas la file, et le photographier la remplacerait par des titres qui
 *    ne sont pas les siens. C'est précisément le sens qu'avait la « file mise
 *    de côté », désormais obtenu sans second stockage.
 *
 *  - **Les sauvegardes d'avant sont reversées**, une fois, et seulement dans le
 *    salon en jeu — les verser à chaque salon donnerait la même file à tous.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// La base écrit dans `<cwd>/data/settings.json`.
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-queue-test-'));
fs.mkdirSync(path.join(SANDBOX, 'data'), { recursive: true });
const CWD = process.cwd();
process.chdir(SANDBOX);

const channelQueue = require(path.join(ROOT, 'src', 'audio', 'channelQueue.js'));
const transitions = require(path.join(ROOT, 'src', 'audio', 'transitions.js'));
const setAside = require(path.join(ROOT, 'src', 'utils', 'setAsideQueue.js'));
const database = require(path.join(ROOT, 'src', 'database', 'Database.js'));

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

const G = 'guilde_test';
const piste = (nom) => ({ title: nom, url: `https://exemple/${nom}` });
const noms = (liste) => liste.map((t) => (transitions.isTransition(t) ? `→${t.target}` : t.title)).join(',');

const dans = (channelId) => {
  database.setLastVoiceChannel(G, channelId);
  return database.getSettings(G);
};

console.log('\n=== La file rangée par salon vocal ===\n');

// ───────────────────── Un salon, une file ─────────────────────

console.log('Chaque salon garde la sienne\n');

{
  channelQueue.write(G, [piste('A'), piste('B')], dans('salon_soiree'));
  check('la file du salon se relit', noms(channelQueue.read(dans('salon_soiree'))) === 'A,B');

  check(
    '  … et un autre salon commence vide',
    channelQueue.read(dans('salon_calme')).length === 0,
    'une file unique par serveur suivait le bot partout',
  );

  channelQueue.write(G, [piste('C')], dans('salon_calme'));
  check(
    '  … chacun garde la sienne',
    noms(channelQueue.read(dans('salon_soiree'))) === 'A,B' && noms(channelQueue.read(dans('salon_calme'))) === 'C',
  );

  // Hors de tout salon, c'est le dernier fréquenté qui répond : le tableau de
  // bord continue ainsi de montrer une file, plutôt que de la faire
  // disparaître sous les yeux de l'utilisateur.
  check(
    'le dernier salon fréquenté sert de repli',
    channelQueue.keyOf({ lastVoiceChannelId: 'salon_calme' }) === 'salon_calme',
  );
  check(
    "  … et un bot qui n'a jamais bougé a tout de même un seau",
    channelQueue.keyOf({}) === channelQueue.NO_CHANNEL,
    "ce qu'on prépare avant la première connexion doit se retrouver quelque part",
  );

  // Une file vidée ne laisse pas d'entrée derrière elle.
  channelQueue.write(G, [], dans('salon_calme'));
  check(
    "un salon vidé ne garde pas d'entrée vide",
    !Object.prototype.hasOwnProperty.call(database.getSettings(G).channelQueues || {}, 'salon_calme'),
  );
}

// ───────────────────── Le miroir ─────────────────────

console.log("\nCe que le lecteur dit, et ce qu'il ignore\n");

{
  dans('salon_miroir');
  database.updateSettings(G, { activePlaybackSource: 'queue' });

  channelQueue.write(G, [piste('A'), transitions.create('playlist_x'), piste('B')], dans('salon_miroir'));

  check(
    'le lecteur ne reçoit que la tête',
    noms(channelQueue.playable(dans('salon_miroir'))) === 'A',
    'rien au-delà du premier aiguillage',
  );

  /*
   * Le lecteur a joué A : il ne porte plus rien. Une recopie qui le
   * photographierait rendrait une file vide, effaçant l'aiguillage et le
   * titre qui le suit — que le lecteur n'a jamais reçus.
   */
  channelQueue.mirror(G, [], dans('salon_miroir'));
  check(
    "le miroir garde ce que le lecteur n'a jamais eu",
    noms(channelQueue.read(dans('salon_miroir'))) === '→playlist_x,B',
    'photographier le lecteur seul aurait tout effacé',
  );

  // Un titre ajouté au lecteur remonte dans le rangement, devant la queue.
  channelQueue.write(G, [piste('A'), transitions.create('playlist_x'), piste('B')], dans('salon_miroir'));
  channelQueue.mirror(G, [piste('A'), piste('Z')], dans('salon_miroir'));
  check(
    '  … et recolle la tête du lecteur devant',
    noms(channelQueue.read(dans('salon_miroir'))) === 'A,Z,→playlist_x,B',
  );
}

{
  // Une playlist occupe le lecteur : ce qu'il porte n'est pas la file.
  channelQueue.write(G, [piste('A'), piste('B')], dans('salon_playlist'));
  database.updateSettings(G, { activePlaybackSource: 'playlist_x' });

  channelQueue.mirror(G, [piste('Autre chose')], dans('salon_playlist'));
  check(
    "une playlist qui joue n'écrase pas la file",
    noms(channelQueue.read(dans('salon_playlist'))) === 'A,B',
    "c'est le sens qu'avait la « file mise de côté », sans second stockage",
  );

  database.updateSettings(G, { activePlaybackSource: 'queue' });
}

{
  // Rien n'a bougé : pas d'écriture. Le miroir tourne à chaque diffusion
  // d'état, soit une fois par seconde, pour une liste qui ne change qu'aux
  // gestes de l'utilisateur.
  channelQueue.write(G, [piste('A')], dans('salon_stable'));
  const avant = JSON.stringify(database.getSettings(G).channelQueues);
  channelQueue.mirror(G, [piste('A')], dans('salon_stable'));
  check("un état inchangé n'écrit rien", JSON.stringify(database.getSettings(G).channelQueues) === avant);
}

// ───────────────────── Les sauvegardes d'avant ─────────────────────

console.log("\nCe qu'une version antérieure avait laissé\n");

{
  dans('salon_ancien');
  database.updateSettings(G, {
    channelQueues: {},
    queueBackupEveryone: { tracks: [piste('Ancien A'), piste('Ancien B')] },
    queueBackupPersonal: null,
  });

  check("la sauvegarde d'avant est relue", noms(channelQueue.read(database.getSettings(G))) === 'Ancien A,Ancien B');

  // Les deux clés portaient la même file — l'écriture effaçait l'autre —, et
  // sont donc lues indifféremment.
  database.updateSettings(G, {
    queueBackupEveryone: null,
    queueBackupPersonal: { virtualCurrentTrack: piste('Tête'), virtualTracks: [piste('Suite')] },
  });
  check(
    "  … sous l'une comme sous l'autre clé",
    noms(channelQueue.read(database.getSettings(G))) === 'Tête,Suite',
    "l'écriture effaçait l'autre : il n'y en a jamais eu qu'une de vivante",
  );

  // Elle n'appartient qu'au salon en jeu : la reverser partout donnerait la
  // même file à tous les salons.
  check(
    '  … et seulement dans le salon en jeu',
    channelQueue.read(database.getSettings(G), 'un_autre_salon').length === 0,
  );

  // Une écriture la solde définitivement.
  channelQueue.write(G, [piste('Neuf')], database.getSettings(G));
  const apres = database.getSettings(G);
  check(
    '  … puis elle est soldée',
    apres.queueBackupEveryone === null &&
      apres.queueBackupPersonal === null &&
      noms(channelQueue.read(apres)) === 'Neuf',
    "deux sources pour une même file, et l'on ne saurait plus laquelle croire",
  );
}

// ───────────────────── La façade ─────────────────────

console.log("\nCe que les vingt appelants continuent d'obtenir\n");

{
  channelQueue.write(G, [piste('X')], dans('salon_facade'));
  check('readSetAsideQueue lit le rangement', noms(setAside.readSetAsideQueue(dans('salon_facade'))) === 'X');

  setAside.writeSetAsideQueue(G, [piste('Y')], dans('salon_facade'));
  check('  … et writeSetAsideQueue y écrit', noms(channelQueue.read(dans('salon_facade'))) === 'Y');

  // Le mode de diffusion ne range plus rien : il n'y a plus de déménagement
  // à faire au changement de mode.
  let crash = null;
  try {
    setAside.convertForMode(G, 'personal');
  } catch (e) {
    crash = e;
  }
  check(
    "  … et le changement de mode n'a plus rien à déplacer",
    crash === null,
    'le rangement suit le salon, que le mode ne change pas',
  );
}

// ───────────────────── Le raccordement ─────────────────────

console.log('\nCe qui tient les deux bouts\n');

{
  const SERVER = fs.readFileSync(path.join(ROOT, 'src', 'web', 'WebServer.js'), 'utf8');
  const GUILD = fs.readFileSync(path.join(ROOT, 'src', 'web', 'websocket', 'handlers', 'guildHandlers.js'), 'utf8');
  const FILE = fs.readFileSync(path.join(ROOT, 'src', 'web', 'websocket', 'handlers', 'queueHandlers.js'), 'utf8');

  /*
   * L'ordre du rangement au changement de salon.
   *
   * Le rangement se fait sous la clé du salon courant : ranger après le
   * changement écrirait la file de l'ancien salon dans le nouveau, et
   * l'écraserait. C'est l'ordre, et rien d'autre, qui distingue les deux.
   */
  check(
    'la file est rangée avant que le salon ne change',
    GUILD.indexOf('stowChannelQueue') !== -1 &&
      GUILD.indexOf('stowChannelQueue') < GUILD.indexOf('database.setLastVoiceChannel'),
    "ranger après écrirait l'ancienne file dans le nouveau salon",
  );

  // Le miroir est posé à un seul endroit, celui que toutes les mutations
  // traversent : dix points d'appel en auraient laissé un onzième oublier.
  check(
    "le miroir vit au passage obligé de l'état",
    (SERVER.match(/channelQueue\.mirror\(/g) || []).length === 2,
    "la diffusion d'état, et le rangement au départ d'un salon",
  );

  // Les mutations de la file portent sur le rangement : les indices affichés
  // sont les siens, et le lecteur n'en connaît qu'une partie.
  for (const [nom, motif] of [
    ['le retrait', /const stored = channelQueue\.read\(settings\);\s*\n\s*if \(index >= 0/],
    ['le déplacement', /const stored = channelQueue\.read\(settings\);\s*\n\s*if \(fromIndex >= 0/],
    ['le vidage', /channelQueue\.write\(currentGuildId, \[\], settings\);/],
  ]) {
    check(`${nom} porte sur le rangement`, motif.test(FILE), 'compter dans le lecteur désignerait le mauvais titre');
  }

  check(
    'le tableau de bord affiche le rangement, pas le lecteur',
    /queue: channelQueue\s*\.read\(settings\)/.test(SERVER),
    'le lecteur ignore tout de ce qui suit le premier aiguillage',
  );

  check(
    'un aiguillage traverse le formateur sans être pris pour une piste',
    /if \(transitions\.isTransition\(t\)\) \{/.test(SERVER),
    'ensureTrackQuality inscrirait une entrée par adresse « transition: »',
  );
}

// ───────────────────── Fin ─────────────────────

database.flush();
process.chdir(CWD);
try {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
} catch (e) {}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
