/**
 * Vérifie les drapeaux du menu de langue.
 *
 * ## Ce qui n'allait pas
 *
 * Les options portaient un émoji : « 🇫🇷 Français ». Un drapeau Unicode n'est
 * pourtant pas un caractère mais une **paire d'indicateurs régionaux** — « F »
 * et « R » écrits dans un alphabet à part —, que chaque système est libre de
 * dessiner ou non. Windows ne le fait pas : sa police d'émojis n'embarque aucun
 * drapeau, et le navigateur retombe alors sur les deux lettres.
 *
 * Le même code montrait donc de vrais drapeaux sur téléphone et « FR Français »,
 * « GB English » sur l'ordinateur qui fait tourner le bot. Vérifié en rendant
 * la chaîne dans le navigateur de cette machine.
 *
 * ## Ce que ce test tient
 *
 *  - **Un dessin, jamais un caractère.** C'est la seule façon d'obtenir le même
 *    affichage partout, et l'émoji ne doit pas revenir dans le balisage.
 *
 *  - **Les quatre langues en ont un.** Une option qui n'en déclarerait pas
 *    laisserait un trou dans la colonne, et l'on remarquerait l'absence bien
 *    plus que la présence.
 *
 *  - **Le déclencheur montre le même que la ligne cliquée**, et il est
 *    reconstruit à deux endroits — au rendu, et au clic. L'oublier au clic
 *    faisait disparaître le drapeau dès qu'on changeait de langue.
 *
 *  - **Une même boîte pour tous.** Les proportions réelles vont du 2:3 français
 *    au 1:2 britannique : les respecter donnerait une colonne en dents de scie.
 *
 * `buildFlag` est exécutée telle qu'elle est livrée, sur un DOM de fortune.
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'js', 'customSelect.js'), 'utf8');
const MARKUP = fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'css', 'modals.css'), 'utf8');

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

/** Élément factice : ce que `buildFlag` écrit, et rien de plus. */
function makeElement() {
  return { className: '', innerHTML: '', appendChild() {}, addEventListener() {} };
}

function load() {
  const sandbox = {
    window: { MusicPlayer: {} },
    document: { createElement: makeElement, addEventListener() {} },
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox);
  return sandbox;
}

const bac = load();
const buildFlag = bac.buildFlag;

console.log('\n=== Les drapeaux du menu de langue ===\n');

// ───────────────────── Le dessin ─────────────────────

console.log('Ce qui est posé dans la liste\n');

{
  check('la fabrique est bien celle du fichier livré', typeof buildFlag === 'function');

  const drapeau = buildFlag({ dataset: { flag: 'fr' } });
  check('une option qui déclare un drapeau en reçoit un', !!drapeau);
  check(
    "  … et c'est un dessin, non un caractère",
    drapeau.innerHTML.includes('<svg') && !/[\u{1F1E6}-\u{1F1FF}]/u.test(drapeau.innerHTML),
    "un émoji dépendrait d'une police que Windows n'a pas",
  );
  check(
    '  … porté par une classe que la feuille de style connaît',
    drapeau.className === 'option-flag' && /\.option-flag/.test(CSS),
  );

  /*
   * Il ne se lit pas : le libellé le dit déjà, en toutes lettres et dans la
   * langue concernée. Un lecteur d'écran annoncerait « France, Français ».
   */
  check("  … et se tait pour un lecteur d'écran", /aria-hidden="true"/.test(drapeau.innerHTML));

  // Un liseré, sinon le jaune espagnol et l'or allemand se fondent dans le
  // fond sombre du menu.
  check(
    '  … avec un liseré, faute de quoi les clairs se fondent',
    /stroke="rgba\(0,0,0,0\.35\)"/.test(drapeau.innerHTML),
  );

  /*
   * Les coins sont arrondis par la feuille de style : un `<svg>` masque ce
   * qui déborde de sa boîte, et l'arrondi rogne donc le dessin lui-même —
   * les bandes s'adoucissent jusqu'aux angles sans qu'on touche au tracé.
   *
   * Mais la découpe rogne aussi le liseré. Sans le même rayon sur lui, il
   * s'interromprait aux quatre coins. Les deux valeurs se comptent dans la
   * même monnaie — la boîte fait 20 × 14 unités pour 20 × 14 pixels — et
   * doivent rester égales.
   */
  const rxDessin = /rx="([\d.]+)"/.exec(drapeau.innerHTML);
  const rxFeuille = /\.option-flag svg[\s\S]{0,200}?border-radius: ([\d.]+)px;/.exec(CSS);

  check(
    'les coins sont arrondis',
    !!rxFeuille && parseFloat(rxFeuille[1]) > 0,
    rxFeuille ? `${rxFeuille[1]}px` : 'aucun arrondi',
  );
  check(
    '  … légèrement, non en pastille',
    !!rxFeuille && parseFloat(rxFeuille[1]) <= 5,
    'au-delà, la vignette cesse de se lire comme un drapeau',
  );
  check(
    '  … et le liseré épouse la même courbe',
    !!rxDessin && !!rxFeuille && parseFloat(rxDessin[1]) === parseFloat(rxFeuille[1]),
    rxDessin && rxFeuille ? `rx ${rxDessin[1]} / radius ${rxFeuille[1]}px` : 'valeur absente',
  );
}

{
  check(
    "une option sans drapeau n'en reçoit aucun",
    buildFlag({ dataset: {} }) === null,
    "les autres menus déroulants n'en veulent pas",
  );
  check(
    "  … pas plus qu'un code inconnu",
    buildFlag({ dataset: { flag: 'zz' } }) === null,
    "plutôt qu'un rectangle vide",
  );
  check('  … ni rien du tout', buildFlag(null) === null);
}

// ───────────────────── Une même boîte ─────────────────────

console.log('\nCe qui aligne la colonne\n');

{
  /*
   * Les proportions réelles vont du 2:3 français au 1:2 britannique. Les
   * respecter donnerait des vignettes de largeurs différentes, et une colonne
   * en dents de scie là où l'œil descend une liste.
   */
  for (const code of ['fr', 'gb', 'es', 'de']) {
    const html = buildFlag({ dataset: { flag: code } }).innerHTML;
    check(`${code} tient dans la boîte commune`, html.includes('viewBox="0 0 20 14"'));
  }

  check(
    '  … et la feuille de style leur donne la même taille',
    /\.option-flag svg[\s\S]{0,160}width: 20px;[\s\S]{0,40}height: 14px;/.test(CSS),
  );
}

// ───────────────────── Le balisage ─────────────────────

console.log('\nCe que les options déclarent\n');

{
  const bloc = MARKUP.slice(
    MARKUP.indexOf('id="setting-language-select"'),
    MARKUP.indexOf('</select>', MARKUP.indexOf('id="setting-language-select"')),
  );

  for (const [valeur, code] of [
    ['fr', 'fr'],
    ['en', 'gb'],
    ['es', 'es'],
    ['de', 'de'],
  ]) {
    check(
      `la langue « ${valeur} » déclare son drapeau`,
      new RegExp(`value="${valeur}" data-flag="${code}"`).test(bloc),
      code,
    );
  }

  check(
    "l'émoji a disparu du balisage",
    !/[\u{1F1E6}-\u{1F1FF}]/u.test(bloc),
    "c'est lui qui s'affichait « FR » sous Windows",
  );

  // Le `<select>` natif reste sous le composant : son libellé doit rester
  // lisible seul, sans le drapeau qui ne s'y affiche pas.
  check(
    '  … et le libellé se suffit à lui-même',
    /<option value="fr" data-flag="fr" selected>Français<\/option>/.test(bloc),
  );
}

// ───────────────────── Les deux rendus du déclencheur ─────────────────────

console.log('\nCe que le déclencheur montre\n');

{
  /*
   * Il est reconstruit à deux endroits : au rendu complet, et au clic sur une
   * option. L'oublier au second faisait disparaître le drapeau dès qu'on
   * changeait de langue, jusqu'au prochain rendu.
   */
  const poses = (SOURCE.match(/buildFlag\(/g) || []).length;
  check(
    'le drapeau est posé partout où il se pose',
    poses === 4,
    'sa définition, la ligne, le déclencheur au rendu, le déclencheur au clic',
  );

  const auClic = SOURCE.slice(SOURCE.indexOf('this.nativeSelect.value = option.value;'));
  check(
    "  … y compris quand on vient d'en choisir une",
    /const clickedFlag = buildFlag\(option\);/.test(auClic),
    'sinon il disparaît au changement de langue',
  );

  // La ligne réserve sa droite à l'étoile du salon favori : la marge
  // automatique ramène drapeau et libellé l'un contre l'autre, à gauche.
  check(
    'le drapeau et le libellé restent côte à côte',
    /\.option-flag \+ \.option-text,[\s\S]{0,80}margin-right: auto;/.test(CSS),
    'la ligne est en space-between',
  );
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
