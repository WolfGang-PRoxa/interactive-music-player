/**
 * Vérifie la fenêtre qui rend le tableau de bord joignable de l'extérieur.
 *
 * Publier passait par Tailscale, et demandait quatre choses que rien
 * n'annonçait. Le tunnel Cloudflare n'en demande plus que deux, que le bot fait
 * sur un clic : rapporter cloudflared, puis ouvrir le tunnel.
 *
 * Ce que ce test protège :
 *
 *  - **Une étape à la fois.** Montrer les quatre avec trois barrées n'aide pas :
 *    savoir ce qui reste ne sert à rien quand on ne peut rien y faire.
 *
 *  - **Chaque étape porte son geste.** Ce que la machine sait faire, elle le
 *    propose ; ce qui lui échappe part vers la bonne page — et jamais vers une
 *    autre, un lien qui envoie au mauvais endroit coûtant plus cher que pas de
 *    lien du tout.
 *
 *  - **Le bot télécharge lui-même**, après avoir constaté qu'il le faut : le
 *    navigateur ne rapporte rien.
 *
 *  - **Derrière le relais, la déclaration chez Discord se fait une fois** : la
 *    fenêtre le dit, et la propose avant même la publication.
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'js', 'shareTunnel.js'), 'utf8');
const HANDLERS = fs.readFileSync(path.join(ROOT, 'src', 'web', 'websocket', 'handlers', 'tunnelHandlers.js'), 'utf8');

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
 * Un nœud factice : ce que le module écrit, et de quoi le relire.
 *
 * `textContent` y est un accesseur plutôt qu'un simple champ : lui affecter une
 * chaîne vide vide aussi les enfants, comme le fait un vrai DOM. C'est ainsi que
 * le module efface la zone entre deux étapes — sans cela la doublure les
 * empilerait, et l'on croirait en voir deux à la fois là où il n'y en a qu'une.
 */
function makeNode(tag, downloads) {
  let text = '';
  const node = {
    /*
     * Un clic programmé sur une ancre déclenche un téléchargement, sans
     * écouteur : c'est ainsi que le module rapporte l'installateur. La
     * doublure le note plutôt que de le faire.
     */
    click() {
      if (node.tagName === 'A' && node.href && downloads) downloads.push(node.href);
      if (node.listeners.click) node.listeners.click();
    },
    tagName: tag.toUpperCase(),
    className: '',
    get textContent() {
      return text;
    },
    set textContent(value) {
      text = value;
      if (value === '') node.children.length = 0;
    },
    children: [],
    style: {},
    disabled: false,
    listeners: {},
    attributes: {},
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
    },
    addEventListener(type, fn) {
      this.listeners[type] = fn;
    },
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    classList: {
      add(c) {
        node.className += ` ${c}`;
      },
    },
  };
  return node;
}

function mount() {
  const downloads = [];
  const zone = makeNode('div', downloads);
  const body = makeNode('body', downloads);
  const sent = [];

  const sandbox = {
    window: {
      MusicPlayer: {
        sendWS: (m) => sent.push(m),
        // La clé est rendue marquée : le module ne retombe donc pas
        // sur ses textes de repli, et les assertions visent les clés
        // plutôt que des phrases entières.
        t: (k) => 'k#' + k,
      },
    },
    document: {
      body,
      getElementById: (id) => (id === 'share-tunnel' ? zone : null),
      createElement: (tag) => makeNode(tag, downloads),
    },
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox);

  /** Tous les nœuds, à plat, pour interroger le rendu. */
  const flat = (n = zone, out = []) => {
    n.children.forEach((c) => {
      out.push(c);
      flat(c, out);
    });
    return out;
  };

  return {
    zone,
    sent,
    downloads: () => downloads,
    api: sandbox.window.MusicPlayer,
    show: (state) => sandbox.window.MusicPlayer.onTunnelState(state),
    nodes: () => flat(),
    texts: () =>
      flat()
        .map((n) => n.textContent)
        .filter(Boolean),
    links: () =>
      flat()
        .filter((n) => n.tagName === 'A')
        .map((n) => n.href),
    buttons: () => flat().filter((n) => n.tagName === 'BUTTON'),
  };
}

console.log('\n=== La fenêtre du tunnel ===\n');

// ───────────────────── Une étape à la fois ─────────────────────

console.log('Ce que chaque étape montre, et propose\n');

{
  const m = mount();

  const DIRECT = {
    url: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe',
    direct: true,
  };

  m.show({ step: 'absent', installer: DIRECT });
  check(
    "l'étape dit ce qui manque, et pourquoi",
    m.texts().some((x) => x.includes('tunnel_absent_title')) && m.texts().some((x) => x.includes('tunnel_absent_body')),
  );
  const telecharger = () => m.buttons().find((b) => b.textContent === 'k#tunnel_absent_action');

  check(
    '  … et propose le téléchargement comme un vrai bouton',
    !!telecharger(),
    'un lien discret ne se remarquait pas',
  );
  check(
    "  … avec une infobulle qui dit ce qu'il déclenche",
    !!telecharger().attributes['data-tooltip'] && telecharger().attributes['data-i18n-tooltip'] === 'tunnel_absent_tip',
  );

  /*
   * Le bot télécharge lui-même : cloudflared est un exécutable unique, qui
   * se pose dans son dossier sans droits administrateur. Le navigateur n'a
   * donc rien à rapporter — il demande, et le serveur constate avant d'agir.
   */
  telecharger().listeners.click();
  check('  … qui demande au bot de le rapporter', m.sent[m.sent.length - 1].type === 'tunnelInstall');
  check(
    '  … sans que le navigateur télécharge quoi que ce soit',
    m.downloads().length === 0,
    'le fichier va dans le dossier du bot, pas dans Téléchargements',
  );

  m.show({ step: 'downloading' });
  check(
    'pendant le téléchargement, la fenêtre le dit',
    m.texts().some((x) => x.includes('tunnel_downloading_title')),
  );

  // Sans fichier à rapporter — macOS — c'est la page officielle.
  m.show({ step: 'absent', installer: { url: 'https://developers.cloudflare.com/x/', direct: false } });
  check(
    '  … sur une plateforme sans téléchargement direct, un lien vers la page',
    m.links().some((h) => h.startsWith('https://developers.cloudflare.com/')) && !telecharger(),
    'macOS passe par Homebrew',
  );

  m.show({ step: 'absent', installer: DIRECT });

  // Une seule étape est peinte : celle où l'on en est.
  check(
    '  … sans montrer les suivantes',
    !m.texts().some((x) => x.includes('tunnel_ready_title')),
    "savoir ce qui reste n'aide pas quand on ne peut rien y faire",
  );

  m.show({ step: 'needsAddress', mode: 'named' });
  check(
    'un tunnel nommé sans adresse renvoie au tableau de bord Cloudflare',
    m.links().some((h) => h.includes('dash.cloudflare.com')),
    "c'est là que son nom d'hôte est écrit",
  );

  m.show({ step: 'ready', mode: 'quick', publicUrl: null });
  check(
    '« prêt » en partage rapide : le bouton, sans adresse à afficher',
    m.buttons().some((b) => b.textContent === 'k#tunnel_ready_action') &&
      !m.nodes().some((n) => n.className === 'tunnel-url'),
    "elle n'existe pas avant que Cloudflare l'attribue",
  );
  check(
    "  … et l'explication dit qu'elle changera à chaque lancement",
    m.texts().some((x) => x.includes('tunnel_ready_body')),
  );

  m.show({ step: 'ready', mode: 'named', publicUrl: 'https://imp.romainpiau.dev' });
  check(
    "« prêt » sur une adresse fixe : l'adresse à venir et le bouton",
    m.texts().includes('https://imp.romainpiau.dev') && m.texts().some((x) => x.includes('tunnel_ready_named_body')),
  );

  m.show({ step: 'starting', mode: 'quick' });
  check(
    "« en cours » propose d'annuler",
    m.buttons().some((b) => b.textContent === 'k#tunnel_starting_cancel'),
  );

  m.show({ step: 'serving', mode: 'quick', publicUrl: 'https://x.trycloudflare.com' });
  check(
    "« publié » propose de cesser de l'être",
    m.buttons().some((b) => b.textContent === 'k#tunnel_serving_action'),
  );
  check(
    "  … et prévient que l'adresse rapide changera",
    m.texts().some((x) => x.includes('tunnel_serving_quick_body')),
  );

  m.show({ step: 'failed', detail: 'failed to request quick Tunnel' });
  check(
    'un tunnel tombé dit pourquoi, et propose de réessayer',
    m.texts().some((x) => x.includes('failed to request quick Tunnel')) &&
      m.buttons().some((b) => b.textContent === 'k#tunnel_failed_action'),
  );
}

// ───────────────────── Le bouton de reprise ─────────────────────

console.log('\nCe que propose le bouton de reprise\n');

{
  const m = mount();

  /*
   * Il n'apparaît que là où quelque chose se passe sans que le bot puisse le
   * dire de lui-même, et porte le geste accompli plutôt que l'action
   * technique : « Réexaminer » n'apprenait ni ce qui était examiné ni pourquoi.
   */
  const attendus = [
    [
      { step: 'absent', installer: { url: 'https://developers.cloudflare.com/x/', direct: false } },
      'k#tunnel_recheck_installed',
    ],
    [{ step: 'starting' }, 'k#tunnel_recheck_starting'],
  ];

  for (const [state, label] of attendus) {
    m.show(state);
    const bouton = m.buttons().find((b) => b.textContent === label);
    check(`« ${state.step} » nomme le geste accompli`, !!bouton, label);
    check("  … et l'infobulle dit qu'il réexamine", !!bouton && !!bouton.attributes['data-tooltip']);
  }

  // Là où le bot agit et constate lui-même, il n'y a rien à reprendre.
  for (const state of [
    { step: 'absent', installer: { url: 'https://github.com/x', direct: true } },
    { step: 'ready', mode: 'quick' },
    { step: 'serving', mode: 'quick', publicUrl: 'https://x.trycloudflare.com' },
    { step: 'failed' },
  ]) {
    m.show(state);
    const reprise = m.buttons().filter((b) => /recheck/.test(b.textContent));
    check(
      `« ${state.step}${state.installer ? ' (direct)' : ''} » n'en propose aucun`,
      reprise.length === 0,
      "rien ne s'est passé ailleurs",
    );
  }
}

// ───────────────────── Les demandes ─────────────────────

console.log('\nCe que la fenêtre demande au serveur\n');

{
  const m = mount();

  m.api.refreshTunnel();
  check("l'ouverture demande l'état", m.sent.length === 1 && m.sent[0].type === 'tunnelState');

  m.show({ step: 'ready', mode: 'quick' });
  m.buttons()
    .find((b) => b.textContent === 'k#tunnel_ready_action')
    .listeners.click();
  check('publier envoie tunnelMount', m.sent[m.sent.length - 1].type === 'tunnelMount');

  m.show({ step: 'serving', mode: 'quick', publicUrl: 'https://x.trycloudflare.com' });
  m.buttons()
    .find((b) => b.textContent === 'k#tunnel_serving_action')
    .listeners.click();
  check('retirer envoie tunnelUnmount', m.sent[m.sent.length - 1].type === 'tunnelUnmount');

  m.show({ step: 'failed' });
  m.buttons()
    .find((b) => b.textContent === 'k#tunnel_failed_action')
    .listeners.click();
  check('réessayer rouvre le tunnel', m.sent[m.sent.length - 1].type === 'tunnelMount');

  m.show({ step: 'downloading' });
  check(
    'pendant le téléchargement, rien ne se clique',
    m.buttons().every((b) => b.disabled),
    'un second clic lancerait un second téléchargement',
  );
}

{
  // Un échec se dit sous l'étape, pas à sa place : on doit pouvoir réessayer
  // sans recharger la page.
  const m = mount();
  m.show({ step: 'ready', mode: 'quick', error: 'cloudflared introuvable' });
  check(
    "un échec s'affiche sans effacer l'étape",
    m.texts().some((x) => x.includes('cloudflared introuvable')) &&
      m.buttons().some((b) => b.textContent === 'k#tunnel_ready_action'),
  );
}

// ───────────────────── Le côté serveur ─────────────────────

console.log('\nCe que le serveur vérifie\n');

{
  const install = HANDLERS.slice(
    HANDLERS.indexOf('async function handleTunnelInstall'),
    HANDLERS.indexOf('async function handleTunnelMount'),
  );
  check(
    "le téléchargement constate avant d'agir",
    /if \(before\.step !== cloudflare\.STEP\.ABSENT\) return send\(ws, before\);/.test(install),
    'cloudflared a pu être installé entre-temps',
  );

  const PERMS = fs.readFileSync(path.join(ROOT, 'src', 'web', 'permissions.js'), 'utf8');
  for (const action of ['tunnelState', 'tunnelInstall', 'tunnelMount', 'tunnelUnmount']) {
    check(`${action} est réservé au maître`, new RegExp(`${action}: MASTER_ONLY`).test(PERMS));
  }
}

{
  /*
   * Derrière le relais, l'URL de rappel ne dépend pas du tunnel : la
   * déclarer avant de publier évite un premier invité éconduit par Discord.
   */
  const m = mount();
  m.show({
    step: 'ready',
    mode: 'quick',
    publicUrl: null,
    relay: true,
    redirectUri: 'https://imp-auth.romainpiau.dev/discord/callback',
    clientId: '42',
  });
  const declare = m.buttons().find((b) => b.textContent === 'k#tunnel_declare_action');
  check('derrière le relais, la déclaration se propose avant même la publication', !!declare);
  check(
    "  … avec l'infobulle qui dit qu'elle se fait une seule fois",
    !!declare && declare.attributes['data-i18n-tooltip'] === 'tunnel_declare_relay_tip',
  );

  m.show({
    step: 'ready',
    mode: 'named',
    publicUrl: 'https://imp.romainpiau.dev',
    relay: false,
    redirectUri: 'https://imp.romainpiau.dev/auth/discord/callback',
    clientId: '42',
  });
  const fixe = m.buttons().find((b) => b.textContent === 'k#tunnel_declare_action');
  check(
    "sur une adresse fixe, l'infobulle d'avant",
    !!fixe && fixe.attributes['data-i18n-tooltip'] === 'tunnel_declare_tip',
  );
}

// ───────────────────── Déclarer l'adresse chez Discord ─────────────────────

console.log('\nCe que le bouton de déclaration copie, et où il mène\n');

{
  const CLIENT = fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'js', 'shareTunnel.js'), 'utf8');
  const HANDLER = fs.readFileSync(path.join(ROOT, 'src', 'web', 'websocket', 'handlers', 'tunnelHandlers.js'), 'utf8');
  const CSS = fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'css', 'modals.css'), 'utf8');

  /*
   * Une adresse publiée ne sert à rien tant que Discord ne la connaît pas :
   * l'aller-retour de connexion revient dessus, et le portail refuse toute
   * redirection qu'on ne lui a pas déclarée. C'était l'étape que rien ne
   * signalait, et qu'il fallait deviner en lisant un journal.
   */
  check(
    "c'est l'URL de rappel qui est copiée, pas l'adresse affichée",
    /copyToClipboard\(current\.redirectUri\);/.test(CLIENT),
    "le portail attend l'adresse suivie de « /auth/discord/callback »",
  );

  /*
   * Et elle vient du serveur.
   *
   * La recomposer côté navigateur ferait deux versions d'une même règle, et
   * un jour l'une des deux aurait tort — ce que ce dépôt a déjà payé quatre
   * fois avec le choix des flux.
   */
  // Le chemin ne doit apparaître dans aucune chaîne du client : l'y écrire
  // serait le reconstruire. Le commentaire qui l'explique, lui, a le droit
  // de le nommer.
  check(
    '  … et elle vient du serveur, qui la construit déjà',
    /redirectUri: oauth\.redirectUri\(\)/.test(HANDLER) && !/['"`][^'"`\n]*auth\/discord\/callback/.test(CLIENT),
    'une seconde version de la règle finirait par diverger',
  );

  check(
    "le portail s'ouvre sur l'application, pas sur la liste",
    /applications\/\$\{current\.clientId\}\/oauth2/.test(CLIENT),
  );
  check(
    "  … et sur la liste faute d'identifiant",
    /'https:\/\/discord\.com\/developers\/applications'/.test(CLIENT),
    "sans lui, on ne peut qu'ouvrir l'index",
  );

  /*
   * L'identifiant d'application n'est pas un secret : il voyage déjà dans
   * l'adresse d'autorisation que le navigateur visite. Le secret, lui, ne
   * doit jamais descendre.
   */
  check(
    "l'identifiant descend, jamais le secret",
    /clientId: oauth\.clientId\(\)/.test(HANDLER) && !/clientSecret/.test(HANDLER),
  );

  check(
    'le bouton disparaît sans application configurée',
    /if \(!current \|\| !current\.redirectUri\) return null;/.test(CLIENT),
    "il n'y a alors aucun portail où aller",
  );

  // La marche à suivre ne paraît qu'après le clic : avant, elle décrirait un
  // onglet qui n'existe pas.
  check(
    "la marche à suivre ne paraît qu'après le clic",
    /if \(declared\) zone\.appendChild\(declareSteps\(\)\);/.test(CLIENT),
  );
  check(
    '  … et ne survit pas à la fermeture de la fenêtre',
    /declared = false;\s*\n\s*ask\('tunnelState'\);/.test(CLIENT),
    'elle décrirait un onglet refermé depuis longtemps',
  );

  /*
   * La copie doit marcher hors origine sûre.
   *
   * `navigator.clipboard` l'exige. Le tableau de bord publié est en HTTPS,
   * mais en local un nom de machine en clair n'en est pas une : le bouton y
   * serait muet.
   */
  /*
   * Le repli vit dans la copie commune, et non ici.
   *
   * `navigator.clipboard` exige une origine sûre. Le tableau de bord publié en
   * est une, mais un nom de machine en clair sur le réseau local, non : le
   * bouton y serait muet. `copyToClipboard` porte ce repli pour toute
   * l'interface — le réécrire ici en aurait fait deux versions.
   */
  const ETAT = fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'js', 'state.js'), 'utf8');
  check(
    'la copie a un repli hors origine sûre',
    /window\.isSecureContext/.test(ETAT) && /execCommand\('copy'\)/.test(ETAT),
    "porté une fois, pour toute l'interface",
  );

  /*
   * L'étiquette nomme ce qui est copié, et cela commande la disposition.
   *
   * « Déclarer chez Discord », posé à côté d'une adresse, laisse croire que
   * c'est celle-là qu'on emporte — et ce n'est pas une nuance : collée dans
   * les redirections, l'adresse de partage donne une déclaration que Discord
   * accepte et qui ne sert jamais, l'aller-retour cherchant le chemin de
   * rappel qu'elle n'a pas.
   *
   * Nommée, l'étiquette ne tient plus à droite du champ. Le bouton passe donc
   * au-dessus, où l'ordre de lecture dit la même chose que le geste : d'abord
   * ce qu'on va faire, ensuite l'adresse dont il ne s'agit pas.
   */
  for (const lang of ['fr', 'en', 'es', 'de']) {
    const dict = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'locales', `${lang}.json`), 'utf8'),
    );
    const label = dict.tunnel_declare_action || '';
    check(`${lang} : l'étiquette nomme l'URL de rappel`, /rappel|callback|retorno|R.ckruf/i.test(label), label);
    check(
      `  … et l'infobulle écarte l'adresse affichée`,
      /ci-dessous|below|de abajo|unten/i.test(dict.tunnel_declare_tip || ''),
      "sans quoi on colle l'adresse de partage, que Discord accepte sans jamais s'en servir",
    );
  }

  check(
    "le bouton est au-dessus de l'adresse, sur toute la largeur",
    /\.tunnel-declare-row \{\s*\n\s*display: flex;/.test(CSS) &&
      /\.tunnel-declare-row \.tunnel-btn \{[\s\S]{0,60}flex: 1 1 auto/.test(CSS),
  );
  check(
    '  … et non plus serré à sa droite',
    !/\.tunnel-url-row/.test(CSS) && !/tunnel-url-row/.test(CLIENT),
    "l'étiquette nommée n'y tenait plus",
  );

  // L'ordre du DOM porte le sens : le geste, puis l'adresse dont il ne
  // s'agit pas.
  const bloc = CLIENT.slice(
    CLIENT.indexOf('if (step.url || step.declare) {'),
    CLIENT.indexOf('if (step.gestes.length)'),
  );
  check(
    "  … et il précède l'adresse dans le document",
    bloc.indexOf('tunnel-declare-row') < bloc.indexOf('urlButton(step.url)'),
    "d'abord ce qu'on va faire, ensuite l'adresse dont il ne s'agit pas",
  );

  const CLES = [
    'tunnel_declare_action',
    'tunnel_declare_tip',
    'tunnel_declare_relay_tip',
    'tunnel_declare_copied',
    'tunnel_declare_step1',
    'tunnel_declare_step2',
    'tunnel_declare_step3',
    'tunnel_declare_uri_tip',
  ];
  for (const lang of ['fr', 'en', 'es', 'de']) {
    const dict = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'locales', `${lang}.json`), 'utf8'),
    );
    const manquantes = CLES.filter((k) => !dict[k] || !String(dict[k]).trim());
    check(
      `${lang} : les ${CLES.length} libellés de la déclaration sont traduits`,
      manquantes.length === 0,
      manquantes.join(', '),
    );
  }
}

// ───────────────────── L'adresse, qui se copie ─────────────────────

console.log("\nCe que l'adresse elle-même permet\n");

{
  const CLIENT = fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'js', 'shareTunnel.js'), 'utf8');
  const CSS = fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'css', 'modals.css'), 'utf8');

  /*
   * Elle était posée là en simple paragraphe, sélectionnable d'un triple clic
   * — un geste que personne ne devine, et que le moindre glissement rate.
   */
  check(
    "l'adresse est un bouton, plus un paragraphe",
    /function urlButton\(adresse\)/.test(CLIENT) &&
      /zone\.appendChild\(urlButton\(step\.url\)\);/.test(CLIENT) &&
      !/const url = document\.createElement\('p'\)/.test(CLIENT),
  );

  /*
   * Une seule façon de copier dans tout le tableau de bord.
   *
   * `copyToClipboard` existait déjà, avec son repli hors origine sûre et son
   * compte rendu de réussite. En écrire une seconde ici, c'était deux
   * comportements pour un même geste — et un jour l'un des deux aurait perdu
   * son repli.
   */
  check(
    '  … et elle passe par la copie commune du tableau de bord',
    /window\.MusicPlayer\.copyToClipboard\(/.test(CLIENT) && !/execCommand\('copy'\)/.test(CLIENT),
    'une seconde version aurait un jour perdu son repli',
  );

  check(
    "la copie se confirme sur l'adresse même",
    /el\.classList\.add\('is-copied'\)/.test(CLIENT) && /tunnel_url_copied/.test(CLIENT),
    'le regard est là au moment du clic',
  );
  check(
    "  … puis l'adresse revient",
    /el\.textContent = adresse;\s*\n\s*el\.classList\.remove\('is-copied'\);/.test(CLIENT),
    "c'est elle qu'on vient consulter, pas la confirmation",
  );
  check('  … et deux clics rapides ne laissent pas un minuteur derrière', /clearTimeout\(el\._back\);/.test(CLIENT));

  // Elle garde son allure de champ : un bouton de plus, dans une fenêtre qui
  // en compte déjà trois, disperserait le regard.
  {
    const regle = CSS.slice(CSS.indexOf('.tunnel-url {'), CSS.indexOf('}', CSS.indexOf('.tunnel-url {')));
    check(
      "elle ne prend pas l'allure d'un bouton",
      /font-family: var\(--font-mono/.test(regle) && /cursor: pointer/.test(regle),
      "la chasse fixe d'une adresse, et le curseur d'un geste",
    );
  }
  check('  … mais répond au survol', /\.tunnel-url:hover \{/.test(CSS));

  const CLES = ['tunnel_url_copy_tip', 'tunnel_url_copied'];
  for (const lang of ['fr', 'en', 'es', 'de']) {
    const dict = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'locales', `${lang}.json`), 'utf8'),
    );
    check(
      `${lang} : les ${CLES.length} libellés de la copie sont traduits`,
      CLES.every((k) => dict[k] && String(dict[k]).trim()),
    );
  }
}

// ───────────────────── Le salon qui recevra le lien ─────────────────────

console.log('\nCe que « le salon vocal » désigne\n');

{
  const SHARED = fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'js', 'sharedControl.js'), 'utf8');
  const MARKUP = fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'index.html'), 'utf8');

  /*
   * « Dans le tchat du salon vocal » désigne un salon sans le dire, et le bot
   * en fréquente plusieurs : on envoyait donc un lien en croyant savoir où.
   */
  check(
    'le nom du salon suit la phrase',
    /id="share-invite-channel"/.test(MARKUP) && /function writeInviteChannel\(\)/.test(SHARED),
  );

  check(
    "  … et il vient de l'état, qui le porte déjà",
    /state\.selectedVoiceChannelId/.test(SHARED) && /\(serveur\?\.voiceChannels \|\| \[\]\)\.find/.test(SHARED),
    'aucun message de plus à inventer',
  );

  /*
   * Sans salon actif, la phrase s'arrête plutôt que d'inventer un nom — et le
   * bouton d'envoi échouerait de toute façon.
   */
  check(
    '  … et reste vide faute de salon actif',
    /cible\.textContent = salon\?\.name \? ` « \$\{salon\.name\} »` : '';/.test(SHARED),
  );

  // Écrit à chaque rendu de la fenêtre, elle-même redessinée à chaque état :
  // le salon change sous une fenêtre ouverte, le nom doit suivre.
  check(
    'il se réécrit à chaque état reçu',
    /writeInviteChannel\(\);/.test(SHARED) &&
      SHARED.indexOf('writeInviteChannel();') > SHARED.indexOf('function renderModal()'),
    'le salon peut changer sous une fenêtre ouverte',
  );

  check(
    'le nom se détache de la phrase',
    /\.share-invite-channel \{[\s\S]{0,120}font-weight: 600/.test(
      fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'css', 'modals.css'), 'utf8'),
    ),
    "c'est la seule chose qu'on relit avant de cliquer",
  );
}

// ───────────────────── Une seule taille de geste ─────────────────────

console.log('\nCe que les boutons de la fenêtre ont en commun\n');

{
  const CSS = fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'css', 'modals.css'), 'utf8');

  // Ancré en début de ligne : « .tunnel-btn { » se retrouve aussi dans
  // « .tunnel-declare-row .tunnel-btn { », et l'on lirait la mauvaise règle.
  const regle = (selecteur) => {
    const at = CSS.indexOf('\n' + selecteur + ' {');
    return at === -1 ? '' : CSS.slice(at, CSS.indexOf('}', at));
  };

  /*
   * La même fenêtre proposait des gestes de deux tailles selon la section où
   * ils tombaient, alors qu'ils ont tous le même poids. Les valeurs sont
   * celles de `.maint-btn` une fois l'ajustement de `.share-invite-btn`
   * appliqué — l'envoi du lien sert d'étalon.
   */
  const etalon = { padding: '0.55rem 1.1rem', rayon: '12px', police: '0.95rem' };

  check(
    "le bouton d'envoi garde ses marges d'origine",
    regle('.share-invite-btn').includes(`padding: ${etalon.padding} !important`),
    "c'est lui l'étalon",
  );

  for (const cible of ['.tunnel-btn', '.tunnel-url']) {
    const bloc = regle(cible);
    check(`${cible} a les marges de l'étalon`, bloc.includes(`padding: ${etalon.padding}`), etalon.padding);
    check(`  … et son arrondi`, bloc.includes(`border-radius: ${etalon.rayon}`));
  }

  check('.tunnel-btn a aussi sa police', regle('.tunnel-btn').includes(`font-size: ${etalon.police}`));

  /*
   * La hauteur ne suit pas des marges égales.
   *
   * L'étiquette du voisin vit dans un `<span>` en `inline-flex`, ce qui
   * resserre sa boîte de ligne ; un texte nu reprend les trois pixels
   * d'interlignage du modèle par défaut. Deux boutons voisins de 40 et 37
   * pixels, cela se voit.
   */
  check(
    '  … et une interligne réglée, faute de quoi elle dépasse de trois pixels',
    /line-height: 1\.15/.test(regle('.tunnel-btn')),
    'des marges égales ne suffisent pas à égaliser la hauteur',
  );
  check(
    "  … l'adresse aussi, sans passer au modèle flex",
    /line-height: 1\.28/.test(regle('.tunnel-url')) && /display: block/.test(regle('.tunnel-url')),
    'une adresse longue doit pouvoir revenir à la ligne',
  );

  // L'adresse reste un peu en deçà : à taille égale, une chasse fixe paraît
  // plus grosse qu'une proportionnelle.
  check(
    "l'adresse est en chasse fixe, un cran en dessous",
    /font-size: 0\.85rem/.test(regle('.tunnel-url')) && /font-family: var\(--font-mono/.test(regle('.tunnel-url')),
  );
}

// ───────────────────── L'envoi, dit par le bouton ─────────────────────

console.log("\nCe que le bouton d'envoi répond\n");

{
  const SHARED = fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'js', 'sharedControl.js'), 'utf8');
  const MARKUP = fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'index.html'), 'utf8');
  const CSS = fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'css', 'modals.css'), 'utf8');

  /*
   * Le toast répond en haut de l'écran, alors que le regard vient de cliquer
   * sur le bouton : un message qui paraît loin du geste laisse un doute — a-t-il
   * seulement pris ? —, et l'on reclique.
   */
  check(
    'le bouton confirme sur place, en plus du toast',
    /function flashInviteSent\(\)/.test(SHARED) && /flashInviteSent\(\);\s*\n\s*toast\(/.test(SHARED),
    'le toast garde son rôle : dire dans quel salon',
  );

  /*
   * Sur la réponse du serveur, jamais sur le clic : c'est l'envoi qu'on
   * annonce, et il peut échouer — le bot n'a pas toujours le droit d'écrire
   * dans le salon.
   */
  const bloc = SHARED.slice(SHARED.indexOf('onShareResult'), SHARED.indexOf('const reasons'));
  check(
    "  … seulement quand l'envoi a réellement abouti",
    /if \(data\.ok && data\.channelName\) \{\s*\n\s*flashInviteSent\(\);/.test(bloc),
    'une confirmation posée au clic mentirait quand le bot ne peut pas écrire',
  );

  // Les deux étiquettes sont écrites d'avance : en fabriquer une au moment de
  // l'envoi ferait sauter la largeur du bouton en pleine animation.
  check(
    'les deux étiquettes coexistent dans le balisage',
    /class="share-invite-label"/.test(MARKUP) && /class="share-invite-done"/.test(MARKUP),
  );
  check(
    "  … et la confirmation ne se lit qu'à l'œil",
    /class="share-invite-done" aria-hidden="true"/.test(MARKUP),
    "le lecteur d'écran a déjà le toast, et l'entendrait deux fois",
  );

  check(
    "l'animation se rejoue si l'on renvoie aussitôt",
    /classList\.remove\('is-sent'\);\s*\n\s*void btn\.offsetWidth;/.test(SHARED),
    'une classe déjà posée ne rejouerait rien',
  );
  check('  … et ne laisse pas un minuteur derrière elle', /clearTimeout\(btn\._sentBack\);/.test(SHARED));

  /*
   * Le vert de réussite est un vert de pastille : il signale un état sur un
   * fond sombre, où il doit trancher. En aplat sous un libellé blanc il ne
   * donnait que 1,45 de contraste — le mot se lisait mal, et le bouton
   * paraissait délavé au milieu d'une fenêtre par ailleurs sombre.
   *
   * Assombri de moitié, il passe à 4,6 : le seuil AA du texte courant, quelle
   * que soit la taille. Mélangé plutôt qu'écrit en dur, pour que les sept
   * thèmes gardent chacun le leur.
   */
  check(
    'le vert du bouton est assombri pour porter du blanc',
    /background: color-mix\(in srgb, var\(--c-success[^)]*\) 55%, #000\) !important/.test(CSS),
    'le vert de pastille sous du blanc ne donne que 1,45 de contraste',
  );
  check(
    "  … en partant du vert du thème, pas d'une teinte imposée",
    !/background: #[0-9a-f]{6} !important/i.test(
      CSS.slice(CSS.indexOf('.share-invite-btn.is-sent {'), CSS.indexOf('@keyframes share-invite-leave')),
    ),
    'les sept thèmes redéfinissent --c-success',
  );

  {
    // Le calcul, refait ici : une valeur qui dérive doit faire échouer le
    // test, pas seulement changer d'aspect.
    const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const lum = (rgb) => {
      const c = rgb.map((v) => {
        const x = v / 255;
        return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const contraste = (a, b) => {
      const [h, l] = lum(a) > lum(b) ? [lum(a), lum(b)] : [lum(b), lum(a)];
      return (h + 0.05) / (l + 0.05);
    };

    const base = hex('#57F287'); // --c-success du thème par défaut
    const fondu = base.map((v) => Math.round(v * 0.55));
    const ratio = contraste(fondu, [255, 255, 255]);

    check(
      '  … et le blanc y passe le seuil AA du texte courant',
      ratio >= 4.5,
      `${ratio.toFixed(2)} contre 1,45 auparavant`,
    );
  }

  /*
   * Trois temps, et c'est leur enchaînement qui raconte : l'élan, le départ,
   * l'arrivée. Chacun a ses images clés, et le nom de chacune dit ce qu'elle
   * fait — un mouvement dont on ne peut plus nommer les morceaux ne se relit
   * pas.
   */
  for (const [temps, image] of [
    ["l'élan", 'share-invite-press'],
    ["le départ de l'étiquette", 'share-invite-leave'],
    ['le vol', 'share-invite-fly'],
    ['son sillage', 'share-invite-trail'],
    ['le balayage', 'share-invite-sweep'],
    ["l'arrivée", 'share-invite-land'],
    ['le tracé de la coche', 'share-invite-draw'],
  ]) {
    check(`${temps} a ses images clés`, new RegExp(`@keyframes ${image} \\{`).test(CSS));
  }

  /*
   * Tout est animation, rien n'est transition pendant la séquence.
   *
   * Les deux modèles mêlés donnaient des instants qu'on ne pouvait plus caler
   * les uns sur les autres — ni figer pour les relire. C'est ainsi qu'un creux
   * s'était glissé au milieu : l'étiquette partie, l'avion éteint, et la coche
   * pas encore là.
   */
  const joue = CSS.slice(CSS.indexOf('.share-invite-btn.is-sent {'), CSS.indexOf('@keyframes share-invite-leave'));
  check(
    'la séquence entière est jouée en animations',
    !/transition:/.test(joue) && (joue.match(/animation:/g) || []).length >= 5,
    "deux modèles mêlés ne se calent pas l'un sur l'autre",
  );

  // La coche se trace : le trait est masqué sur toute sa longueur, et le
  // masque recule.
  check(
    '  … et la coche se dessine au lieu de paraître',
    /stroke-dasharray: 24;/.test(CSS) &&
      /@keyframes share-invite-draw \{\s*to \{\s*stroke-dashoffset: 0;\s*\}/.test(CSS),
  );

  // L'arrivée recouvre la fin du vol : deux gestes qui s'attendent poliment
  // donnent une saynète, deux gestes qui se recouvrent donnent un mouvement.
  const retard = (nom) => {
    const m = new RegExp(`animation: ${nom} [\\d.]+s [^;]*?([\\d.]+)s both`).exec(CSS);
    return m ? parseFloat(m[1]) : NaN;
  };
  check(
    "  … et l'arrivée commence avant la fin du vol",
    retard('share-invite-land') < 0.1 + 0.5,
    `l'arrivée à ${retard('share-invite-land')}s, le vol jusqu'à 0.6s`,
  );

  /*
   * Le mouvement est un agrément, jamais le message : réduit, la couleur, la
   * coche et le mot disent encore tout — seul ce qui n'était que déplacement
   * s'efface.
   */
  /**
   * Le contenu de **toutes** les règles « prefers-reduced-motion » du fichier.
   *
   * Ce test prenait la dernière, à une époque où il n'y en avait qu'une. Une
   * autre a depuis été écrite plus bas, pour un curseur sans rapport, et
   * « la dernière » a cessé de désigner celle-ci — les deux vérifications
   * échouaient alors sur une feuille de style parfaitement correcte.
   *
   * Ce qui compte n'a jamais été la position du bloc, mais que ces règles-là
   * soient bien sous une réduction de mouvement. On les rassemble donc tous,
   * en comptant les accolades : une règle imbriquée en contient, et couper au
   * premier « } » rendrait un bloc tronqué.
   */
  const reducedMotionRules = (css) => {
    const marker = '@media (prefers-reduced-motion: reduce) {';
    const blocks = [];
    let from = 0;

    for (;;) {
      const start = css.indexOf(marker, from);
      if (start < 0) break;

      let depth = 0;
      let i = start + marker.length - 1;
      for (; i < css.length; i++) {
        if (css[i] === '{') depth++;
        else if (css[i] === '}' && --depth === 0) break;
      }

      blocks.push(css.slice(start, i + 1));
      from = i + 1;
    }

    return blocks.join('\n');
  };

  const reduit = reducedMotionRules(CSS);
  check(
    '  … et se tait quand le mouvement est refusé',
    /\.is-sent \.share-invite-plane,\s*\n\s*\.share-invite-btn\.is-sent \.plane-trail \{\s*animation: none;\s*opacity: 0;\s*\}/.test(
      reduit,
    ),
    'le vol et son sillage ne portaient rien à eux seuls',
  );
  check(
    '  … sans emporter ce qui porte le message',
    /\.is-sent \.share-invite-done \{[\s\S]{0,120}opacity: 1;/.test(reduit) &&
      /\.share-invite-check \{\s*stroke-dashoffset: 0;\s*\}/.test(reduit),
    'la coche entière, le mot, le fond vert',
  );

  for (const lang of ['fr', 'en', 'es', 'de']) {
    const dict = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'locales', `${lang}.json`), 'utf8'),
    );
    check(
      `${lang} : la confirmation du bouton est traduite`,
      !!(dict.share_invite_done && dict.share_invite_done.trim()),
      dict.share_invite_done || '',
    );
  }
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
