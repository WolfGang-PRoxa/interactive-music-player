/**
 * Vérifie l'élection du tableau de bord pilote, et ce que le journal en dit.
 *
 * En diffusion personnelle, la lecture est menée par le navigateur : c'est lui
 * qui constate la fin d'un morceau et l'annonce au serveur pour que la file
 * avance. Plusieurs tableaux de bord peuvent être ouverts sur le même serveur
 * et constateraient la même fin — d'où un pilote unique, seul entendu.
 *
 * Deux défauts se sont ligués le 2026-09-05, et le second rendait le premier
 * illisible.
 *
 *  - **L'élection ne suivait pas le tableau de bord.** Elle n'avait lieu qu'à la
 *    connexion et à la déconnexion d'un client. Changer de serveur depuis
 *    l'interface amenait donc sur une guilde sans pilote : plus personne n'y
 *    annonçait les fins de piste, la lecture s'arrêtait au bout du morceau, et
 *    la roue de secours du serveur ne rattrapait qu'une demi-minute plus tard.
 *
 *  - **Le journal du navigateur mentait.** Le libellé « saut ENVOYE » était
 *    calculé sans la clause du pilote, alors que l'envoi l'exigeait. Un tableau
 *    de bord non pilote écrivait donc qu'il avait annoncé une fin sans rien
 *    envoyer — et le serveur, qui n'avait rien reçu, ne pouvait pas le
 *    contredire. Chercher pourquoi un saut « envoyé » n'arrivait pas mène
 *    partout sauf à l'endroit.
 *
 * Le troisième point tient à la garde d'un pilote en place : sa connexion ne
 * suffit pas à le confirmer, encore faut-il qu'il regarde toujours cette
 * guilde-là. Sans quoi un tableau de bord parti ailleurs reste inscrit, et la
 * guilde paraît pourvue alors que personne ne l'écoute.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/*
 * Dans un bac à sable, avant tout `require`.
 *
 * Charger WebServer configure le logger sur `data/logs` du répertoire courant :
 * lancé depuis le projet, ce test écrasait `latest.log` du bot en cours
 * d'exécution et supprimait ses plus anciens journaux. La base et le carnet des
 * invités lisent eux aussi `data/` au chargement.
 */
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-election-'));
process.chdir(SANDBOX);
process.on('exit', () => {
  try {
    fs.rmSync(SANDBOX, { recursive: true, force: true });
  } catch (e) {}
});

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

console.log("\n=== L'élection du tableau de bord pilote ===\n");

// ───────────────────── L'élection elle-même ─────────────────────

console.log('Ce qui déclenche une élection\n');

/**
 * Le vrai `_ensurePilot`, celui de WebServer, exercé sur des sockets factices.
 *
 * L'instance exportée est réutilisée telle quelle : seules la table des pilotes
 * et la liste des clients sont remplacées, et la diffusion d'état est neutralisée
 * — elle irait chercher une file de lecture et un bot Discord, dont l'élection
 * n'a que faire. Ce qui est mesuré est donc la méthode livrée, pas une copie de
 * son algorithme qui pourrait s'en écarter sans que rien ne le dise.
 */
const webServer = require(path.join(ROOT, 'src', 'web', 'WebServer.js'));

function makeServer() {
  const clients = new Set();
  webServer.pilots = new Map();
  webServer.wss = { clients };

  const elections = [];
  webServer.broadcastState = (guildId) => {
    elections.push(guildId);
  };

  return {
    pilots: webServer.pilots,
    wss: webServer.wss,
    isPilot: (ws, guildId) => webServer.isPilot(ws, guildId),
    _ensurePilot: (guildId) => webServer._ensurePilot(guildId),
    elections,
  };
}

const socket = (guildId) => ({ readyState: 1, selectedGuildId: guildId });

{
  const s = makeServer();
  const a = socket('G1');
  s.wss.clients.add(a);

  s._ensurePilot('G1');
  check('le premier connecté prend les commandes', s.isPilot(a, 'G1'));

  // Le geste que le tableau de bord fait en changeant de serveur.
  const previous = a.selectedGuildId;
  a.selectedGuildId = 'G2';
  s._ensurePilot(previous);
  s._ensurePilot('G2');

  check(
    'changer de serveur élit un pilote sur le nouveau',
    s.isPilot(a, 'G2'),
    "sans cela, plus personne n'y annonce les fins de piste",
  );
  check("et libère l'ancien", !s.pilots.has('G1'), "il n'y reste plus aucun client");
}

{
  // Un pilote resté inscrit sur une guilde qu'il ne regarde plus la ferait
  // paraître pourvue : c'est la garde qui vérifie qu'il y est encore.
  const s = makeServer();
  const a = socket('G1');
  const b = socket('G1');
  s.wss.clients.add(a);
  s.wss.clients.add(b);

  s._ensurePilot('G1');
  check('deux tableaux de bord, un seul pilote', s.isPilot(a, 'G1') && !s.isPilot(b, 'G1'));

  a.selectedGuildId = 'G2';
  s._ensurePilot('G1');
  check(
    'le pilote parti ailleurs est remplacé sur place',
    s.isPilot(b, 'G1'),
    'sa connexion ne suffit pas à le confirmer',
  );

  s._ensurePilot('G2');
  check('et il prend les commandes là où il va', s.isPilot(a, 'G2'));
}

{
  const s = makeServer();
  const a = socket('G1');
  s.wss.clients.add(a);
  s._ensurePilot('G1');

  // Une élection déjà tranchée ne se rejoue pas : le pilote resterait le même,
  // mais chaque appel diffuserait un état pour rien.
  const before = s.elections.length;
  s._ensurePilot('G1');
  check('une guilde déjà pourvue ne réélit personne', s.elections.length === before);

  a.readyState = 3;
  check('un pilote déconnecté ne tient plus la place', s._ensurePilot('G1') === null && !s.pilots.has('G1'));
}

// ───────────────────── Le maître d'abord ─────────────────────

console.log("\nQui l'emporte\n");

/*
 * Le pilote ne fait pas qu'annoncer les fins de piste : sa position fait foi
 * pour tous. Un invité connecté avant l'hôte — l'ordre ordinaire après un
 * redémarrage du bot — menait donc la lecture de l'hôte, avec le retard de sa
 * liaison.
 */
{
  const owner = (guildId) => ({ ...socket(guildId), identity: { master: true } });
  const guest = (guildId, userId = 'U1') => ({ ...socket(guildId), identity: { master: false, session: { userId } } });

  const s = makeServer();
  const g = guest('G1');
  s.wss.clients.add(g);
  s._ensurePilot('G1');
  check('seul, un invité pilote', s.isPilot(g, 'G1'), "la lecture doit s'enchaîner même sans l'hôte");

  const m = owner('G1');
  s.wss.clients.add(m);
  s._ensurePilot('G1');
  check('le maître qui arrive prend la place', s.isPilot(m, 'G1') && !s.isPilot(g, 'G1'));

  const before = s.elections.length;
  const m2 = owner('G1');
  s.wss.clients.add(m2);
  s._ensurePilot('G1');
  check('un second onglet du maître ne la lui reprend pas', s.isPilot(m, 'G1') && s.elections.length === before);

  m.readyState = 3;
  m2.readyState = 3;
  s._ensurePilot('G1');
  check("le maître parti, l'invité reprend", s.isPilot(g, 'G1'));

  const late = guest('G1', 'U2');
  s.wss.clients.add(late);
  s._ensurePilot('G1');
  check('entre invités, le premier arrivé garde sa place', s.isPilot(g, 'G1'));
}

// ───────────────────── La position ─────────────────────

console.log('\nQui fait foi pour la position\n');

{
  const { handleSyncProgress } = require(path.join(ROOT, 'src', 'web', 'websocket', 'handlers', 'playbackHandlers.js'));

  const s = makeServer();
  const pilot = { ...socket('G1'), identity: { master: true } };
  const other = { ...socket('G1'), identity: { master: false, session: { userId: 'U1' } } };
  s.wss.clients.add(other);
  s.wss.clients.add(pilot);
  s._ensurePilot('G1');

  const queue = { virtualProgressMs: 0, virtualLastUpdated: 0 };
  const report = (ws, progressMs) =>
    handleSyncProgress({
      ws,
      webServer,
      queue,
      currentGuildId: 'G1',
      data: { progressMs },
    });

  report(pilot, 61000);
  check('la position du pilote est retenue', queue.virtualProgressMs === 61000);

  report(other, 59800);
  check(
    "celle d'un autre tableau de bord ne l'est pas",
    queue.virtualProgressMs === 61000,
    `${queue.virtualProgressMs} ms`,
  );

  const app = fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'app.js'), 'utf8');
  check(
    "le navigateur ne la remonte plus s'il se sait non pilote",
    /if \(state\.pilot !== false && !audio\.pendingInitialPosition/.test(app),
  );
  check(
    '  … pas même pour se déclarer prioritaire après une coupure',
    /if \(clientPositionWins\) \{[\s\S]{0,900}if \(state\.pilot !== false\) \{\s*sendWS\(\{\s*type: 'syncProgress'/.test(
      app,
    ),
  );
}

// ───────────────────── Ce que le code appelle vraiment ─────────────────────

console.log("\nCe qui l'appelle\n");

{
  const guildHandlers = fs.readFileSync(
    path.join(ROOT, 'src', 'web', 'websocket', 'handlers', 'guildHandlers.js'),
    'utf8',
  );

  check(
    'le changement de serveur élit un pilote',
    /_ensurePilot\(targetGuildId\)/.test(guildHandlers),
    "c'est le chemin qui manquait",
  );
  check(
    'et réélit sur la guilde quittée',
    /_ensurePilot\(previousGuildId\)/.test(guildHandlers),
    'un autre tableau de bord y est peut-être resté',
  );

  const server = fs.readFileSync(path.join(ROOT, 'src', 'web', 'WebServer.js'), 'utf8');
  // Le pilote n'est gardé que s'il figure parmi ceux qui regardent la guilde,
  // et ceux-là se trient sur la guilde choisie, pas sur la connexion.
  check(
    "un pilote n'est gardé que s'il regarde encore cette guilde",
    /client\.readyState === 1 && client\.selectedGuildId === guildId/.test(server) &&
      /currentPilot && watching\.includes\(currentPilot\)/.test(server),
    'sa seule connexion ne prouve rien',
  );
}

// ───────────────────── Le journal ne ment plus ─────────────────────

console.log('\nCe que le navigateur écrit dans le journal\n');

{
  const app = fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'app.js'), 'utf8');
  const block = app.slice(
    app.indexOf("audio.addEventListener('ended'"),
    app.indexOf("audio.addEventListener('ended'") + 2600,
  );

  check(
    'la condition est calculée une seule fois',
    /const announces = /.test(block),
    "le libellé et l'envoi ne peuvent plus diverger",
  );
  check("et le libellé s'en sert", /saut \$\{announces \? 'ENVOYE' : 'ecarte'\}/.test(block));
  check("comme l'envoi", /if \(announces\) \{/.test(block));

  // La clause qui manquait au libellé. Elle doit rester dans la condition
  // commune, et n'y figurer qu'une fois.
  const pilotClauses = (block.match(/state\.pilot !== false/g) || []).length;
  check('la clause du pilote y est, une seule fois', pilotClauses === 1, `${pilotClauses} occurrence(s)`);

  // Et le journal dit désormais si ce tableau de bord pilote : c'est ce qui
  // aurait mis sur la voie du premier coup.
  check("le journal annonce s'il est pilote", /pilote \$\{state\.pilot === false \? 'non' : 'oui'\}/.test(block));
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
