/**
 * Vérifie que le menu ne propose plus des qualités qui n'existent pas.
 *
 * Le menu clic droit offrait les six définitions et les cinq débits sans jamais
 * savoir si le fichier existait dans aucun d'eux. Proposer du 4K sur une vidéo
 * mise en ligne en 720p n'est pas un choix : c'est une promesse qu'on ne tient
 * pas, et qui ne se découvre qu'au fichier obtenu.
 *
 * Quatre choses portent le sens.
 *
 *  - **La vidéo est franche, l'audio ne l'est pas.** Une définition existe ou
 *    n'existe pas. Un débit, lui, reste toujours atteignable — le bot transcode
 *    — mais viser au-dessus de la source n'ajoute que du poids. Les deux ne se
 *    marquent donc pas pour la même raison, et ne se disent pas pareil.
 *
 *  - **Trois états, pas deux.** Jamais demandé, en attente, connu. Confondre les
 *    deux premiers ferait clignoter une liste grise à chaque ouverture.
 *
 *  - **Tant que rien n'est su, tout est offert.** Griser à l'aveugle serait pire
 *    que de ne rien dire : le menu d'avant proposait tout et ne mentait qu'à
 *    moitié.
 *
 *  - **La valeur déjà retenue reste cliquable**, même absente de la source. Elle
 *    a pu être choisie quand la source proposait autre chose, et l'éteindre
 *    laisserait un menu où même la ligne cochée est morte.
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'js', 'qualityMenu.js'), 'utf8');

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

/**
 * Extrait `optionAvailable` du module livré et l'exécute seule.
 *
 * Le module entier suppose un DOM, une socket et un état ; cette fonction-ci ne
 * décide que sur deux valeurs. La découper est le seul moyen de l'éprouver sur
 * le fichier réel.
 */
function loadDecider() {
  const start = SOURCE.indexOf('function optionAvailable(');
  const end = SOURCE.indexOf('/** Débits MP3 proposés', start);
  if (start < 0 || end < 0) throw new Error('optionAvailable introuvable');

  const sandbox = { Array, Number, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${SOURCE.slice(start, end)}\nglobalThis.__f = optionAvailable;`, sandbox);
  return sandbox.__f;
}

const disponible = loadDecider();

console.log('\n=== Les qualités réellement disponibles ===\n');

// ───────────────────── Ce qu'on ignore encore ─────────────────────

console.log("Tant que la source n'a pas répondu\n");

{
  // Trois états, et les deux premiers ne se traitent pas comme le troisième.
  check(
    'jamais demandé : tout reste offert',
    disponible('video', '2160', undefined) && disponible('audio', '320', undefined),
  );
  check(
    'demandé, sans réponse : tout reste offert aussi',
    disponible('video', '2160', null) && disponible('audio', '320', null),
    "griser à l'aveugle serait pire que de ne rien dire",
  );
  check(
    'source muette : tout reste offert',
    disponible('video', '2160', { known: false, heights: [], audioKbps: null }),
    "une plateforme que l'outil ne sait pas lire n'interdit rien",
  );
}

// ───────────────────── La vidéo, franche ─────────────────────

console.log("\nLa définition existe, ou n'existe pas\n");

{
  const source = { known: true, heights: [1080, 720, 480, 360], audioKbps: 128 };

  check(
    'une définition présente est offerte',
    disponible('video', '1080', source) && disponible('video', '360', source),
  );
  check(
    "  … une absente ne l'est pas",
    !disponible('video', '2160', source) && !disponible('video', '1440', source),
    'promettre du 4K sur une mise en ligne en 1080p',
  );

  // Les hauteurs arrivent en nombres, le menu les manipule en chaînes.
  check(
    'la comparaison ne bute pas sur le type',
    disponible('video', 1080, source) && disponible('video', '1080', source),
  );

  const sansImage = { known: true, heights: [], audioKbps: 160 };
  check(
    "une source sans image n'offre aucune définition",
    !disponible('video', '720', sansImage) && !disponible('video', '360', sansImage),
    "le menu vidéo n'a alors rien à proposer",
  );
}

// ───────────────────── L'audio, nuancé ─────────────────────

console.log('\nLe débit : atteignable, mais pas toujours utile\n');

{
  const source = { known: true, heights: [720], audioKbps: 128 };

  check(
    'un débit sous la source garde son sens',
    disponible('audio', '128', source) && disponible('audio', '96', source),
  );

  /*
   * Au-dessus, le transcodage n'ajoute rien : on réencode 128 kbps vers 320
   * sans récupérer ce qui n'y est pas, pour un fichier deux fois plus lourd.
   */
  check(
    "  … au-dessus, il n'ajoute que du poids",
    !disponible('audio', '320', source) && !disponible('audio', '256', source),
    'plus lourd, pas meilleur',
  );

  // Les débits variables flottent sous leur étiquette : écarter 320 pour une
  // source annoncée à 317 serait une exactitude inutile.
  const presque = { known: true, heights: [], audioKbps: 317 };
  check(
    "une marge évite d'écarter pour trois kilobits",
    disponible('audio', '320', presque),
    '317 kbps annoncés, 320 offert',
  );

  const inconnu = { known: true, heights: [1080], audioKbps: null };
  check(
    "un débit que la source n'annonce pas n'interdit rien",
    disponible('audio', '320', inconnu),
    "ne rien savoir n'est pas savoir que non",
  );
}

// ───────────────────── Le flux réellement choisi ─────────────────────

console.log('\nCe que la demande va réellement chercher\n');

{
  const source = require(path.join(ROOT, 'src', 'audio', 'videoSource.js'));
  const { stepDown, VIDEO_LADDER, AUDIO_LADDER } = source;

  // Le défaut signalé : la qualité demandée n'était pas celle chargée.
  check(
    'la définition demandée est prise quand elle existe',
    stepDown(VIDEO_LADDER, 1080, [2160, 1440, 1080, 720]) === 1080,
  );

  check(
    '  … sinon on descend, sans sauter de cran',
    stepDown(VIDEO_LADDER, 2160, [1080, 720, 480]) === 1080 && stepDown(VIDEO_LADDER, 1440, [1080, 720]) === 1080,
  );

  /*
   * Le piège d'une échelle prise au pied de la lettre.
   *
   * YouTube sert du 160, du 128, du 70 : un seul de ces débits figure au menu.
   * Marcher sur les barreaux rendrait 128 pour une demande de 320, en
   * laissant le 160 de côté — moins bien que ce qui existe, sans le dire.
   */
  check(
    "un débit hors barreau n'est pas ignoré pour autant",
    stepDown(AUDIO_LADDER, 320, [160, 128, 70]) === 160,
    '160 existe et vaut mieux que le barreau 128',
  );

  check('  … et une demande basse reste basse', stepDown(AUDIO_LADDER, 128, [160, 128, 70]) === 128);

  // Tout ce que porte la source est au-dessus : mieux vaut trop que rien.
  check(
    'quand tout dépasse la demande, on prend le plus petit',
    stepDown(VIDEO_LADDER, 360, [2160, 1440]) === 1440 && stepDown(AUDIO_LADDER, 96, [160]) === 160,
    'un fichier muet ou sans image ne vaut rien du tout',
  );

  check('une source sans rien ne rend rien', stepDown(VIDEO_LADDER, 1080, []) === null);

  const SRC = fs.readFileSync(path.join(ROOT, 'src', 'audio', 'videoSource.js'), 'utf8');

  // Les deux demandes sont satisfaites séparément : une définition absente ne
  // doit pas dégrader le son, ni l'inverse.
  check(
    'image et son sont choisis chacun pour leur compte',
    /stepDown\(VIDEO_LADDER, height/.test(SRC) && /stepDown\(AUDIO_LADDER, audioKbps/.test(SRC),
  );

  const HANDLER = fs.readFileSync(
    path.join(ROOT, 'src', 'web', 'websocket', 'handlers', 'downloadHandlers.js'),
    'utf8',
  );

  check(
    'les deux demandes partent ensemble vers la résolution',
    /resolve\(url, \{ height, audioKbps: Number\(bitrate\) \}\)/.test(HANDLER),
  );

  /*
   * Le défaut le plus trompeur des deux.
   *
   * Le transcodage écrivait bien un fichier au débit demandé, mais depuis le
   * flux que l'extracteur proposait — parfois à 70 kbps. Le nombre inscrit
   * dans le fichier était exact, et la qualité imaginaire.
   */
  check(
    'le débit demandé choisit aussi la source, pas seulement la sortie',
    /videoSource\.resolveAudio\(playable\.url, bitrate\)/.test(HANDLER),
    "un fichier « 320 kbps » tiré d'une source à 70 en portait le nom, pas la qualité",
  );

  check(
    "  … avec repli sur le chemin d'avant",
    /: await preloadManager\.resolveAudioInput\(/.test(HANDLER),
    "une source qui ne s'inventorie pas doit continuer de se télécharger",
  );
}

// ───────────────────── La vidéo verticale ─────────────────────

console.log("\nCe qu'on appelle « 1080p » quand la vidéo est verticale\n");

{
  const SRC = fs.readFileSync(path.join(ROOT, 'src', 'audio', 'videoSource.js'), 'utf8');

  /*
   * Le défaut signalé, et sa cause.
   *
   * https://youtube.com/watch?v=jS0nFxAHkBU est verticale : son « 1080p » fait
   * 1080 de large et 1920 de haut. Lire `height` faisait donc dire 1920 à ce
   * que tout le monde nomme 1080p, et une demande de 2160p y trouvait un
   * « 1920 » inférieur où s'arrêter — un nombre qui ne figure dans aucun menu.
   */
  check(
    'la définition se mesure au petit côté, pas à la hauteur',
    /Math\.min\(w, h\)/.test(SRC),
    "une verticale de 1080×1920 s'appelle 1080p partout",
  );

  check(
    '  … et cette mesure sert partout',
    (SRC.match(/definitionOf/g) || []).length >= 4,
    'inventaire, choix du flux, et valeur rendue',
  );

  // Les formats réels de la vidéo signalée.
  const reels = [
    [144, 256],
    [240, 426],
    [360, 640],
    [480, 854],
    [608, 1080],
    [720, 1280],
    [1080, 1920],
  ];
  const definitions = reels.map(([w, h]) => Math.min(w, h));
  const source = require(path.join(ROOT, 'src', 'audio', 'videoSource.js'));

  check(
    '2160p demandé sur cette vidéo donne 1080p',
    source.stepDown(source.VIDEO_LADDER, 2160, definitions) === 1080,
    "et non 1920, qui n'est le nom de rien",
  );

  check(
    '  … et non la hauteur brute, qui aurait donné 1920',
    source.stepDown(
      source.VIDEO_LADDER,
      2160,
      reels.map(([, h]) => h),
    ) === 1920,
    "ce que faisait le code d'avant",
  );
}

// ───────────────────── Le préchargement ─────────────────────

console.log('\nLe débit inscrit dans le cache\n');

{
  const PRE = fs.readFileSync(path.join(ROOT, 'src', 'audio', 'PreloadManager.js'), 'utf8');

  /*
   * L'autre moitié du défaut signalé.
   *
   * Le préchargement transcodait au débit voulu sans regarder ce qu'il avait
   * sous la main : une source à 130 kbps produisait un fichier nommé « 320 »,
   * et le menu l'annonçait ainsi. Le nombre était exact — le transcodage est à
   * débit constant — mais il décrivait le contenant, pas le contenu.
   */
  check('le débit demandé est ramené à ce que la source porte', /clampBitrateToSource\(track, asked\)/.test(PRE));

  check(
    '  … et le repli est dit au journal',
    /kbps unavailable for/.test(PRE),
    "un fichier arrivé en 128 au lieu de 320 doit s'expliquer",
  );

  // Le nom du fichier en cache porte le débit, et l'index n'accepte que les
  // valeurs du menu : une source à 130 doit donner 128, pas 130.
  check(
    'la valeur retenue reste un barreau du menu',
    /VALID_AUDIO_BITRATES\s*\n?\s*\.map\(Number\)/.test(PRE),
    "le cache n'indexe que les débits qu'il connaît",
  );

  check(
    'une source non inventoriable ne change rien',
    /if \(!found\.known \|\| !found\.audioKbps\) return asked;/.test(PRE),
    'un fichier local, une plateforme inconnue, un réseau coupé',
  );

  // Le repli change la clé du téléchargement : celle que l'appelant avait
  // vérifiée n'est plus la bonne.
  check(
    'le doublon est écarté après le repli',
    /if \(this\.activeDownloads\.has\(dlKey\)\) return;/.test(PRE),
    "l'appelant avait vérifié l'autre clé",
  );

  const MENU = fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'js', 'qualityMenu.js'), 'utf8');

  check(
    'le menu annonce la définition obtenue, pas celle demandée',
    /effectiveVideo\(track\.desiredVideoQuality, formats\)/.test(MENU),
    '« 2160p » sur une source qui plafonne à 1080p était un chiffre creux',
  );

  check("  … et se repeint quand l'inventaire arrive", /renderMenu\(\);\s*\n\s*if \(!type\) return;/.test(MENU));
}

// ───────────────────── Le raccordement ─────────────────────

console.log('\nCe qui tient les deux bouts\n');

{
  /*
   * L'inventaire part au clic droit, et nulle part ailleurs.
   *
   * Il l'était d'abord à l'ouverture du seul sous-menu, pour n'en payer le
   * coût que si l'on venait régler quelque chose. Mais le menu lui-même en
   * dépend depuis qu'il annonce la définition réellement obtenue : la question
   * est posée dès le clic droit, et c'est là que la réponse doit partir.
   *
   * Ce qu'il ne faut surtout pas, c'est qu'il parte d'un chemin emprunté à
   * chaque diffusion d'état — un appel réseau par piste et par seconde.
   */
  check("l'inventaire est demandé à l'ouverture du menu", /askFormats\(track\.url\);/.test(SOURCE));

  check(
    "  … et jamais depuis la mise à jour de l'état",
    !/askFormats\(/.test(
      SOURCE.slice(
        SOURCE.indexOf('function refreshOpenMenu') >= 0 ? SOURCE.indexOf('function refreshOpenMenu') : SOURCE.length,
      ),
    ),
    'un appel réseau par piste à chaque état serait payé pour rien',
  );

  check('  … et une seule fois par adresse', /if \(!url \|\| formatsByUrl\.has\(url\)\) return;/.test(SOURCE));

  check(
    "l'attente se dit, au lieu de griser par défaut",
    /formats === null/.test(SOURCE) && /quality_formats_pending/.test(SOURCE),
  );

  check(
    'la valeur déjà retenue reste cliquable',
    /\|\| String\(opt\.value\) === String\(current\)/.test(SOURCE),
    "sinon le menu n'aurait plus une seule ligne vivante",
  );

  check(
    "un choix éteint ne s'applique pas au clic",
    /if \(!usable\) return;/.test(SOURCE),
    'désactiver un bouton ne suffit pas toujours',
  );

  const HANDLER = fs.readFileSync(path.join(ROOT, 'src', 'web', 'websocket', 'handlers', 'qualityHandlers.js'), 'utf8');

  /*
   * Spotify et Deezer ne portent aucun flux : c'est la vidéo vers laquelle le
   * bot les fait pointer qui en porte. Interroger l'adresse d'origine ne
   * rendrait rien, et le menu proposerait tout comme avant.
   */
  check(
    "la piste est pontée avant d'être interrogée",
    /resolvePlayableTrack\(\{ url, title: url \}\)/.test(HANDLER),
    "une adresse Spotify n'a pas de formats à elle",
  );

  check(
    "un fichier local n'est pas interrogé du tout",
    /if \(!\/\^https\?:\\\/\\\/\/i\.test\(url\)\)/.test(HANDLER),
    'lancer un processus pour un fichier du disque ne rendrait rien',
  );

  const SRC = fs.readFileSync(path.join(ROOT, 'src', 'audio', 'videoSource.js'), 'utf8');
  check(
    "l'inventaire est retenu quelques minutes",
    /INVENTORY_TTL_MS/.test(SRC) && /inventoryCache/.test(SRC),
    'une à trois secondes par ouverture serait insupportable',
  );

  check(
    'les définitions sont dédoublonnées et ordonnées',
    /\[\.\.\.new Set\(videoTracks\(entry\)/.test(SRC) && /sort\(\(a, b\) => b - a\)/.test(SRC),
    'la même hauteur revient en plusieurs codecs',
  );

  /*
   * Et elles ne viennent que des flux qu'on saura aller chercher.
   *
   * Les manifestes annoncent des définitions comme les autres, mais leur
   * adresse refuse l'entrée à ffmpeg. En offrir une qui n'existe que sous
   * cette forme serait promettre un fichier qu'on ne sait pas obtenir.
   */
  check(
    '  … et ne comptent que les flux directs',
    /DIRECT_PROTOCOLS\.has\(String\(f\.protocol\)\)/.test(SRC),
    'le menu ne promet que ce qui se télécharge',
  );
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
