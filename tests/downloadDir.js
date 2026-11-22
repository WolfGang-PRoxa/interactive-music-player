/**
 * Vérifie le dossier de téléchargement — le vrai utils/downloadDir.js, éprouvé
 * sur un dossier temporaire réel.
 *
 * Sur un vrai disque, et non sur un système de fichiers simulé : tout l'intérêt
 * de ce module est de répondre à des questions que seul le système sait
 * trancher — ce dossier existe-t-il, est-ce bien un dossier, accepte-t-il qu'on
 * y écrive. Un simulacre répondrait ce qu'on lui aurait soufflé.
 *
 * Trois choses s'y cassent en silence :
 *
 *  - **Le nom de fichier.** Un titre de morceau contient volontiers « : » ou
 *    « / ». Écrit tel quel, il fait échouer l'écriture sous Windows — mais avec
 *    une erreur système qu'on impute alors au transcodage, jamais au titre.
 *
 *  - **Les collisions.** Retélécharger un morceau ne doit pas écraser le
 *    précédent. La perte est totale, immédiate, et ne laisse aucune trace.
 *
 *  - **L'écriture, éprouvée et non supposée.** Un dossier peut exister, être
 *    lisible, et refuser qu'on y crée quoi que ce soit. Le découvrir au moment
 *    du téléchargement laisserait l'utilisateur devant un échec sans rapport
 *    apparent avec son choix.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const downloadDir = require('../src/utils/downloadDir');

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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-downloaddir-'));

console.log('\n=== Dossier de téléchargement ===\n');

// ─────────────────────────── La validation ───────────────────────────

console.log('La validation d’un dossier\n');

{
  const good = downloadDir.validate(root);
  check('un dossier existant et inscriptible est accepté', good.ok, good.reason || good.resolved);
  check('  … et rendu sous sa forme résolue', good.resolved === path.resolve(root), good.resolved);

  check(
    'un dossier absent est refusé, en le disant',
    downloadDir.validate(path.join(root, 'nulle-part')).reason === 'missing',
  );

  const file = path.join(root, 'un-fichier.txt');
  fs.writeFileSync(file, 'x');
  check('un fichier n’est pas un dossier', downloadDir.validate(file).reason === 'notADirectory');

  check('une chaîne vide est refusée', downloadDir.validate('').reason === 'empty');
  check('un chemin absent est refusé', downloadDir.validate(null).reason === 'empty');

  /*
   * L'octet nul tronque le chemin au niveau des appels système : ce qui est
   * vérifié ici ne serait pas ce qui est ouvert plus bas. Node lève sur ces
   * chaînes, mais le refus doit être explicite plutôt que d'être un effet de
   * bord de l'exception.
   */
  check(
    'un octet nul est refusé avant tout accès disque',
    downloadDir.validate(`${root}\0/ailleurs`).reason === 'invalid',
  );
}

// ─────────────────────────── Les noms de fichiers ───────────────────────────

console.log('\nLes noms de fichiers\n');

{
  check(
    'un titre ordinaire passe tel quel',
    downloadDir.safeFilename('Daft Punk - One More Time', '.mp3') === 'Daft Punk - One More Time.mp3',
    downloadDir.safeFilename('Daft Punk - One More Time', '.mp3'),
  );

  const slashes = downloadDir.safeFilename('AC/DC : Back in Black', '.mp3');
  check('les caractères interdits sont remplacés, non retirés', slashes === 'AC-DC - Back in Black.mp3', slashes);
  check('  … si bien que le nom reste lisible', slashes.includes('AC-DC'), slashes);

  const all = downloadDir.safeFilename('a\\b/c:d*e?f"g<h>i|j', '.mp3');
  check('les dix caractères refusés par Windows sont couverts', !/[\\/:*?"<>|]/.test(all), all);

  const control = downloadDir.safeFilename('titre\x07avec\x00controle', '.mp3');
  check('les caractères de contrôle disparaissent', !/[\x00-\x1f]/.test(control), JSON.stringify(control));

  const dotted = downloadDir.safeFilename('Fin de phrase...', '.mp3');
  check('un point final est retiré', dotted === 'Fin de phrase.mp3', dotted);

  const long = downloadDir.safeFilename('x'.repeat(400), '.mp3');
  check('un titre démesuré est écourté', long.length <= 124, `${long.length} caractères`);

  /*
   * Un titre qui ne laisse rien. « /// » ne convenait pas : les barres sont
   * remplacées, pas retirées, si bien qu'il reste « --- » et que le repli
   * n'était jamais éprouvé. Trois points, eux, disparaissent entièrement —
   * un point final est ôté parce que Windows l'ignore.
   */
  const empty = downloadDir.safeFilename('...', '.mp3');
  check('un titre qui ne laisse rien retombe sur un nom par défaut', empty === 'piste.mp3', empty);
}

// ─────────────────────────── Les collisions ───────────────────────────

console.log('\nLes collisions\n');

{
  const dir = path.join(root, 'collisions');
  fs.mkdirSync(dir);

  const first = downloadDir.uniquePath(dir, 'morceau.mp3');
  check('un dossier vide rend le nom demandé', path.basename(first) === 'morceau.mp3', path.basename(first));

  fs.writeFileSync(first, 'x');
  const second = downloadDir.uniquePath(dir, 'morceau.mp3');
  check(
    'un nom déjà pris est numéroté plutôt qu’écrasé',
    path.basename(second) === 'morceau (2).mp3',
    path.basename(second),
  );

  fs.writeFileSync(second, 'x');
  const third = downloadDir.uniquePath(dir, 'morceau.mp3');
  check('la numérotation se poursuit', path.basename(third) === 'morceau (3).mp3', path.basename(third));

  check('l’extension reste à la fin, jamais au milieu', path.extname(third) === '.mp3', path.basename(third));

  // Le fichier d'origine est toujours là : c'est tout l'objet de la
  // numérotation, et une régression le supprimerait sans rien dire.
  check('le fichier d’origine n’a pas bougé', fs.existsSync(first));
}

// ─────────────────────────── La création ───────────────────────────

console.log('\nLa création du dossier\n');

{
  const deep = path.join(root, 'a', 'b', 'c');
  check('un dossier absent est créé, avec ses parents', downloadDir.ensure(deep) === deep && fs.existsSync(deep), deep);

  // Idempotent : le dossier est créé au premier téléchargement, puis
  // retrouvé à chaque suivant.
  check('un dossier déjà là est simplement rendu', downloadDir.ensure(deep) === deep && fs.existsSync(deep));

  check(
    'le dossier par défaut vit sous data/',
    downloadDir.DEFAULT_DIR.endsWith(path.join('data', 'downloads')),
    downloadDir.DEFAULT_DIR,
  );
}

// ─────────────────────────── Les racines ───────────────────────────

console.log('\nLes racines de l’arborescence\n');

{
  const roots = downloadDir.listRoots();
  check('au moins une racine est trouvée', roots.length >= 1, roots.join('  '));
  check(
    'chacune existe réellement',
    roots.every((r) => fs.existsSync(r)),
    roots.join('  '),
  );

  if (process.platform === 'win32') {
    check(
      'elles ont la forme d’une lettre de lecteur',
      roots.every((r) => /^[C-Z]:\\$/.test(r)),
      roots.join('  '),
    );
  } else {
    check(
      'un seul système de fichiers, donc une seule racine',
      roots.length === 1 && roots[0] === '/',
      roots.join('  '),
    );
  }

  // Le second appel passe par le cache : il doit rendre la même chose, faute
  // de quoi l'explorateur changerait de racines d'une requête à l'autre.
  check('le cache rend la même liste', downloadDir.listRoots().join('|') === roots.join('|'));
}

// ────────────────────── Le premier ancêtre lisible ──────────────────────

console.log('\nLe repli sur un dossier lisible\n');

{
  /*
   * C'est la panne qu'a connue la première version : le dossier par défaut
   * n'existe pas tant que rien n'a été téléchargé, la route répondait
   * « illisible », et le sélecteur s'ouvrait entièrement vide — sans contenu
   * ni moyen d'aller ailleurs. La pire des réponses : ni ce qu'on demandait,
   * ni de quoi aller le chercher.
   */
  const missing = path.join(root, 'jamais', 'cree', 'ici');
  check(
    'un dossier inexistant remonte à son premier ancêtre lisible',
    downloadDir.nearestReadable(missing) === path.resolve(root),
    String(downloadDir.nearestReadable(missing)),
  );

  check('un dossier existant se rend lui-même', downloadDir.nearestReadable(root) === path.resolve(root));

  // La remontée s'arrête à la racine plutôt que de boucler : `dirname` d'une
  // racine rend la racine, et sans garde on tournerait indéfiniment.
  const roots = downloadDir.listRoots();
  check('la remontée depuis une racine ne boucle pas', downloadDir.nearestReadable(roots[0]) !== null, roots[0]);
}

// ────────────────────── Le dossier du système ──────────────────────

/*
 * Le raccourci « Téléchargements » du sélecteur.
 *
 * Ce que rend cette recherche dépend de la machine qui exécute le test : on ne
 * vérifie donc pas un chemin, mais le contrat — un dossier qui existe pour de
 * bon, ou rien du tout. Une pastille menant à un dossier absent vaudrait moins
 * que pas de pastille.
 */
console.log('\nLe dossier de téléchargement du système\n');

{
  const found = downloadDir.userDownloadsDir();
  check(
    'la recherche répond un chemin, ou rien',
    found === null || (typeof found === 'string' && found.length > 0),
    String(found),
  );

  if (found) {
    check('  … un chemin absolu', path.isAbsolute(found), found);

    let isDir = false;
    try {
      isDir = fs.statSync(found).isDirectory();
    } catch (e) {}
    check('  … qui existe et qui est bien un dossier', isDir, found);

    check('  … et qui ne change pas d’un appel à l’autre', downloadDir.userDownloadsDir() === found);
  }

  // Le repli minimal. Sur une machine où `~/Downloads` existe, ne rien rendre
  // signalerait une recherche cassée — le registre mal lu, par exemple.
  const home = path.join(os.homedir(), 'Downloads');
  let homeExists = false;
  try {
    homeExists = fs.statSync(home).isDirectory();
  } catch (e) {}
  if (homeExists) {
    check('un ~/Downloads existant n’est jamais laissé de côté', found !== null, home);
  }
}

// ────────────────────── Le pied du sélecteur ──────────────────────

/*
 * « Choisir ce dossier » ne doit pas s'étaler sur toute la largeur.
 *
 * Il est seul depuis que le retour au dossier par défaut est passé en pastille,
 * et `.maintenance-actions` — la classe que le pied partage avec les autres
 * fenêtres — empile ses boutons d'un bord à l'autre. Il faut donc la contredire,
 * et c'est là que le piège s'est refermé une première fois : à spécificité
 * égale, c'est la feuille importée en dernier qui l'emporte, et `modals.css`
 * vient après `player.css`.
 *
 * Le test n'exige pas une solution en particulier — une règle plus spécifique,
 * ou un ordre d'import favorable — mais que l'une des deux tienne. Il tombe si
 * l'on perd les deux, ce qui est exactement ce qui s'était produit.
 */
console.log('\nLe pied du sélecteur\n');

{
  const readCss = (file) => fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'public', file), 'utf8');

  const aggregate = readCss('style.css');
  const modals = readCss(path.join('css', 'modals.css'));
  const player = readCss(path.join('css', 'player.css'));

  check(
    '`.maintenance-actions` empile bien ses boutons',
    /\.maintenance-actions\s*\{[^}]*flex-direction:\s*column/s.test(modals),
  );

  const rule = player.match(/([^\r\n{]*dir-browser-actions\s*\{)([^}]*)\}/);
  check(
    'le pied du sélecteur les remet en rangée',
    !!rule && /flex-direction:\s*row/.test(rule[2]),
    rule ? rule[1].replace('{', '').trim() : 'règle introuvable',
  );
  check('  … et centre son bouton, seule action de ce pied', !!rule && /justify-content:\s*center/.test(rule[2]));

  // Un plancher de largeur, sans valeur imposée : le libellé change de
  // longueur d'une langue à l'autre, la valeur juste est affaire de goût.
  check('le bouton a une largeur minimale', /\.dir-browser-actions\s+\.maint-btn\s*\{[^}]*min-width:/s.test(player));

  const outranks = !!rule && rule[1].includes('.maintenance-actions') && rule[1].includes('.dir-browser-actions');
  const playerImportedLast = aggregate.indexOf('player.css') > aggregate.indexOf('modals.css');

  check(
    '  … et l’emporte : soit par la spécificité, soit par l’ordre d’import',
    outranks || playerImportedLast,
    `spécificité : ${outranks} — player.css en dernier : ${playerImportedLast}`,
  );
}

// ────────────────────── Les groupes de réglages ──────────────────────

/*
 * Un groupe s'ouvrait sans se refermer.
 *
 * Le trait pointillé, la marge et le remplissage détachaient `.setting-item-group`
 * de ce qui le précède ; en dessous, rien. Le réglage suivant venait se coller
 * au dernier élément du groupe, et les deux sections se lisaient comme une
 * seule — la liste des serveurs et le fondu d'extinction se touchaient
 * presque.
 *
 * Deux choses tiennent la correction, et la seconde est celle qu'on oublie :
 * l'espace de fermeture appartient au groupe, pas à ce qu'il contient. Son
 * dernier élément est tantôt une ligne de réglage — qui porte sa propre marge —
 * tantôt un encadré qui n'en a aucune, et les sept groupes se fermeraient sinon
 * de deux façons.
 */
console.log('\nLes groupes de réglages\n');

{
  const modals = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'public', 'css', 'modals.css'), 'utf8');

  const at = modals.indexOf('\n.setting-item-group {');
  const regle = at === -1 ? '' : modals.slice(at, modals.indexOf('}', at));

  check(
    'un groupe de réglages se referme',
    /margin-bottom:\s*1\.4rem/.test(regle),
    'rien ne le séparait de la section suivante',
  );

  // Plus large que l'espace entre deux réglages ordinaires : en haut, le
  // trait dit déjà la coupure ; en bas, il n'y a que le vide pour la dire.
  const entreLignes = /\.setting-item-row \{[^}]*margin-bottom:\s*([\d.]+)rem/s.exec(modals);
  check(
    '  … plus nettement que deux réglages voisins',
    !!entreLignes && 1.4 > parseFloat(entreLignes[1]),
    entreLignes ? `1.4rem contre ${entreLignes[1]}rem` : 'règle introuvable',
  );

  check(
    "  … et c'est lui qui décide, non son dernier élément",
    /\.setting-item-group > :last-child \{\s*\n\s*margin-bottom: 0;/.test(modals),
    'ligne de réglage ou encadré, les sept se ferment pareil',
  );
}

// ────────────────────── La route, de bout en bout ──────────────────────

console.log('\nLa route /api/browse-dirs\n');

/*
 * La base est remplacée avant que la route ne la charge.
 *
 * Ces essais écrivent le dossier choisi : sur la vraie base, ils changeraient
 * le réglage de la personne qui lance les tests, et un plantage à mi-course le
 * lui laisserait modifié.
 */
let storedDir = null;
{
  const resolved = require.resolve('../src/database/Database');
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: {
      getDownloadDir: () => storedDir,
      setDownloadDir: (value) => {
        storedDir = value || null;
      },
    },
  };
}

const express = require('express');
const http = require('http');
const createApiRouter = require('../src/web/routes/api.js');

const app = express();
// Le même analyseur de corps que WebServer monte devant ses routes : sans lui
// `req.body` reste indéfini, et tout POST se lirait comme un corps vide.
app.use(express.json({ limit: '1mb' }));
/*
 * L'identité que `auth.middleware` poserait, posée à la main.
 *
 * Ce banc monte le routeur seul, sans la porte d'entrée : ce qu'il éprouve est
 * le sélecteur de dossiers, pas le contrôle d'accès. Depuis que ces routes
 * portent la garde `local` (voir web/httpGuards.js), il faut donc lui dire qui
 * frappe, sans quoi chaque appel se solderait par un 403 qui ne dit rien du
 * sujet du test. Le refus, lui, est éprouvé à part dans tests/httpGuards.js.
 */
app.use((req, res, next) => {
  req.identity = { authorized: true, master: true, holdsToken: true, session: null };
  next();
});
app.use('/api', createApiRouter({ client: null, wss: null, inviteLink: () => null }));
const server = http.createServer(app);

server.listen(0, '127.0.0.1', async () => {
  const { port } = server.address();
  const get = (route) =>
    new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port, path: route }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(body);
          } catch (e) {}
          resolve({ status: res.statusCode, json });
        });
      });
    });

  // Sans paramètre : le point de départ doit être utilisable, que le dossier
  // par défaut existe déjà ou non.
  const start = await get('/api/browse-dirs');
  check('un premier appel sans chemin répond', start.status === 200, `HTTP ${start.status}`);
  check(
    '  … sur un dossier réellement ouvert',
    !!(start.json && start.json.path),
    start.json ? String(start.json.path) : 'aucun',
  );
  check(
    '  … et rapporte les racines de la machine',
    !!(start.json && Array.isArray(start.json.roots) && start.json.roots.length >= 1),
    start.json ? (start.json.roots || []).join('  ') : '',
  );

  // La pastille de saisie rapide n'a pas d'autre source que cette clé : si
  // elle disparaît de la réponse, le raccourci disparaît de la fenêtre sans
  // que rien d'autre ne bronche.
  // Les deux pastilles de raccourci n'ont pas d'autre source que ces clés :
  // si l'une disparaît de la réponse, le raccourci disparaît de la fenêtre
  // sans que rien d'autre ne bronche.
  check(
    '  … ainsi que le dossier de téléchargement du système',
    !!start.json && 'downloads' in start.json && start.json.downloads === downloadDir.userDownloadsDir(),
    String(start.json && start.json.downloads),
  );
  check(
    '  … et le dossier par défaut du bot',
    !!start.json && start.json.defaultDir === downloadDir.DEFAULT_DIR,
    String(start.json && start.json.defaultDir),
  );

  // Le cas exact qui laissait la fenêtre vide.
  const gone = await get(`/api/browse-dirs?path=${encodeURIComponent(path.join(root, 'parti'))}`);
  check(
    'un dossier inexistant ne rend pas une fenêtre vide',
    gone.status === 200 && !!(gone.json && gone.json.path),
    `HTTP ${gone.status}`,
  );
  check(
    '  … et dit ce qui avait été demandé',
    !!(gone.json && gone.json.requested),
    String(gone.json && gone.json.requested),
  );

  const nul = await get('/api/browse-dirs?path=%00evil');
  check('un octet nul est refusé', nul.status === 400, `HTTP ${nul.status}`);

  const listed = await get(`/api/browse-dirs?path=${encodeURIComponent(root)}`);
  const names = ((listed.json && listed.json.dirs) || []).map((d) => d.name);
  check(
    'seuls les dossiers sont listés',
    names.includes('collisions') && !names.includes('un-fichier.txt'),
    names.join(', ') || 'aucun',
  );
  check('le parent est indiqué', !!(listed.json && listed.json.parent), String(listed.json && listed.json.parent));

  /*
   * Le choix du dossier, et le retour au défaut par la pastille.
   *
   * C'est ce qui remplace le bouton de réinitialisation : la pastille mène au
   * dossier par défaut comme à n'importe quel autre, et « Choisir ce dossier »
   * envoie alors son chemin absolu. Retenu tel quel, ce serait un choix
   * explicite — le menu afficherait le chemin complet plutôt que
   * « data/downloads/ », et déplacer le projet laisserait le bot écrire dans
   * l'ancien dossier.
   */
  console.log('\nLe choix du dossier\n');

  const post = (dir) =>
    new Promise((resolve) => {
      const body = JSON.stringify({ dir });
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/api/download-dir',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        },
        (res) => {
          let text = '';
          res.on('data', (c) => (text += c));
          res.on('end', () => {
            let json = null;
            try {
              json = JSON.parse(text);
            } catch (e) {}
            resolve({ status: res.statusCode, json });
          });
        },
      );
      req.end(body);
    });

  const chosen = await post(root);
  check(
    'un dossier ordinaire est retenu tel quel',
    chosen.status === 200 && chosen.json.dir === root && chosen.json.isDefault === false,
    `${chosen.json && chosen.json.dir}`,
  );
  check('  … et la base le garde', storedDir === root, String(storedDir));

  const back = await post(downloadDir.DEFAULT_DIR);
  check(
    'désigner le dossier par défaut vaut retour au défaut',
    back.status === 200 && back.json.isDefault === true,
    `isDefault : ${back.json && back.json.isDefault}`,
  );
  check('  … la base ne retient donc aucun chemin', storedDir === null, String(storedDir));

  // Sous Windows, « C:\Data » et « c:\data » sont le même dossier : la
  // pastille ne doit pas se laisser prendre à la casse du chemin.
  if (process.platform === 'win32') {
    await post(root);
    const cased = await post(downloadDir.DEFAULT_DIR.toUpperCase());
    check(
      '  … quelle que soit la casse du chemin',
      cased.json && cased.json.isDefault === true && storedDir === null,
      String(storedDir),
    );
  }

  const empty = await post('');
  check(
    'un chemin vide reste le retour au défaut',
    empty.status === 200 && empty.json.isDefault === true,
    String(empty.status),
  );

  server.close();
  fs.rmSync(root, { recursive: true, force: true });

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed === 0 ? 0 : 1);
});
