/**
 * Vérifie les demandes de droit : un invité réclame ce qui lui est refusé,
 * l'administrateur accorde ou refuse, et peut mettre un invité en sourdine.
 *
 * ## Ce que ce test tient
 *
 *  - **Demander n'accorde rien.** Le message est ouvert à tous — c'est celui qui
 *    n'a pas le droit qui demande —, le tri se fait donc dans le handler : un
 *    invité reconnu et admis, un droit du catalogue qu'il n'a pas encore, pas
 *    de sourdine, pas de doublon, pas de rafale.
 *  - **Chaque demande sonne une fois** chez l'administrateur, et l'invité reçoit
 *    toujours une réponse — son bouton ne doit pas rester en « Envoi… ».
 *  - **Répondre est réservé à l'administrateur**, et accorder n'ajoute que le
 *    droit demandé à ceux déjà en place.
 *  - **La sourdine efface ce qui attendait**, et un invité congédié repart sans
 *    demandes ni sourdine.
 *  - **Le refus nomme le droit en cause**, et rien pour ce qui ne se demande pas.
 *  - **L'état porte tout cela** : les demandes et la sourdine chez
 *    l'administrateur, ses propres demandes chez l'invité.
 *
 * Le serveur de fortune ne tient qu'une liste de sockets factices : ce sont les
 * vrais handlers, la vraie table des droits et la vraie base qui sont exercés,
 * dans un bac à sable — la base lit et écrit `data/` du répertoire courant.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'right-requests-'));
fs.mkdirSync(path.join(SANDBOX, 'data'), { recursive: true });
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

const log = require(path.join(ROOT, 'src', 'utils', 'logger'));
log.info = () => {};
log.warn = () => {};
const database = require(path.join(ROOT, 'src', 'database', 'Database'));
const permissions = require(path.join(ROOT, 'src', 'web', 'permissions'));
const share = require(path.join(ROOT, 'src', 'web', 'websocket', 'handlers', 'shareHandlers'));

const GUILD = 'G1';

/** Une socket factice qui retient ce qu'on lui envoie. */
function socket(identity) {
  const sent = [];
  return {
    readyState: 1,
    selectedGuildId: GUILD,
    identity,
    sent,
    send: (raw) => sent.push(JSON.parse(raw)),
    last: (type) => sent.filter((m) => m.type === type).pop(),
    count: (type) => sent.filter((m) => m.type === type).length,
  };
}

const master = socket({ master: true, session: { userId: 'OWNER' } });
const guest = socket({ master: false, session: { userId: 'U1', displayName: 'Yoohyeonz' } });
const stranger = socket({ master: false, session: { userId: 'U9', displayName: 'Inconnu' } });

let broadcasts = 0;
const webServer = {
  wss: { clients: new Set([master, guest, stranger]) },
  broadcastState: () => {
    broadcasts++;
  },
};

const ctx = (ws, data) => ({ ws, data, webServer, currentGuildId: GUILD });
const ask = (ws, action) => share.handleRequestRight(ctx(ws, { action }));

async function main() {
  console.log('\n=== Les demandes de droit ===\n');

  // ───────── La table des messages ─────────

  console.log('Qui peut envoyer quoi\n');

  const guestIdentity = { master: false, permissions: permissions.noPermissions() };
  check('un invité sans droit peut demander', permissions.canSend(guestIdentity, 'requestRight'));
  check('mais pas répondre', !permissions.canSend(guestIdentity, 'answerRightRequest'));
  check('ni mettre en sourdine', !permissions.canSend(guestIdentity, 'muteRightRequests'));
  check(
    "le refus nomme le droit d'un geste",
    permissions.rightOf('seek') === 'playback.seek',
    String(permissions.rightOf('seek')),
  );
  check('  … et rien pour ce qui ne se demande pas', permissions.rightOf('restartBot') === null);
  check('  … ni pour un message inconnu', permissions.rightOf('nImporteQuoi') === null);

  // ───────── Demander ─────────

  console.log('\nDemander\n');

  ask(stranger, 'playback.seek');
  check(
    "qui n'est pas admis ne peut rien demander",
    stranger.last('rightRequestResult')?.data.reason === 'not_admitted',
  );
  check("  … et l'administrateur n'est pas dérangé", master.count('rightRequested') === 0);

  database.admitGuest(GUILD, 'U1');

  ask(master, 'playback.seek');
  check("l'administrateur n'a rien à demander", master.last('rightRequestResult')?.data.reason === 'not_guest');

  ask(guest, 'volume.inexistant');
  check('un droit hors catalogue est écarté', guest.last('rightRequestResult')?.data.reason === 'unknown_right');

  broadcasts = 0;
  ask(guest, 'playback.seek');
  const result = guest.last('rightRequestResult')?.data;
  check('une demande légitime est acceptée', result?.ok === true && result.reason === null);
  check('  … enregistrée', Boolean(database.getRightRequests(GUILD).U1?.['playback.seek']));
  check(
    "  … sonne chez l'administrateur, avec le nom de l'invité",
    master.count('rightRequested') === 1 &&
      master.last('rightRequested').data.displayName === 'Yoohyeonz' &&
      master.last('rightRequested').data.action === 'playback.seek',
  );
  check("  … et l'état est rediffusé", broadcasts === 1);

  ask(guest, 'playback.seek');
  check(
    'la redemander ne la double pas',
    guest.last('rightRequestResult')?.data.reason === 'already_pending' &&
      guest.last('rightRequestResult').data.ok === true &&
      master.count('rightRequested') === 1,
  );

  ask(guest, 'playback.skip');
  check(
    'deux demandes coup sur coup : la seconde attend',
    guest.last('rightRequestResult')?.data.reason === 'too_soon' &&
      !database.getRightRequests(GUILD).U1['playback.skip'],
  );

  // ───────── L'état ─────────

  console.log("\nCe que l'état porte\n");

  const webServerModule = require(path.join(ROOT, 'src', 'web', 'WebServer'));
  const guestState = webServerModule._shareStateFor(guest, GUILD);
  check(
    "l'invité sait ce qu'il a demandé",
    Array.isArray(guestState.rightRequests) && guestState.rightRequests.includes('playback.seek'),
  );
  check("  … et qu'il n'est pas en sourdine", guestState.requestsMuted === false);

  // `_knownGuests` et `_pendingGuests` lisent le carnet et les connexions :
  // hors de propos ici, ils sont neutralisés le temps de l'appel.
  const known = webServerModule._knownGuests;
  const pending = webServerModule._pendingGuests;
  webServerModule._knownGuests = () => [];
  webServerModule._pendingGuests = () => [];
  const masterState = webServerModule._shareStateFor(master, GUILD);
  webServerModule._knownGuests = known;
  webServerModule._pendingGuests = pending;
  check("l'administrateur voit les demandes", Boolean(masterState.sharing?.requests?.U1?.['playback.seek']));
  check('  … et la liste des sourdines', Array.isArray(masterState.sharing?.mutedRequests));

  // ───────── Répondre ─────────

  console.log('\nRépondre\n');

  database.setUserPermissions(GUILD, 'U1', { 'queue.add': true });
  share.handleAnswerRightRequest(ctx(master, { userId: 'U1', action: 'playback.seek', grant: true }));
  const rights = database.getUserPermissions(GUILD, 'U1');
  check('accorder ajoute le droit demandé', rights['playback.seek'] === true);
  check('  … sans retirer ceux déjà en place', rights['queue.add'] === true);
  check(
    "  … sans en ouvrir d'autres",
    permissions.granted(rights).length === 2,
    permissions.granted(rights).join(', '),
  );
  check('  … retire la demande', !database.getRightRequests(GUILD).U1);
  check(
    "  … et l'invité l'apprend",
    guest.last('rightRequestAnswered')?.data.granted === true &&
      guest.last('rightRequestAnswered').data.action === 'playback.seek',
  );

  // Passé le délai entre deux demandes.
  await new Promise((resolve) => setTimeout(resolve, 3100));
  ask(guest, 'playback.skip');
  share.handleAnswerRightRequest(ctx(master, { userId: 'U1', action: 'playback.skip', grant: false }));
  check('refuser retire la demande', !database.getRightRequests(GUILD).U1);
  check('  … sans rien accorder', !database.getUserPermissions(GUILD, 'U1')['playback.skip']);
  check("  … et l'invité l'apprend aussi", guest.last('rightRequestAnswered')?.data.granted === false);

  ask(guest, 'playback.seek');
  check(
    'un droit déjà accordé ne se redemande pas',
    guest.last('rightRequestResult')?.data.reason === 'already_granted',
  );

  // ───────── Cocher à la main ─────────

  await new Promise((resolve) => setTimeout(resolve, 3100));
  ask(guest, 'volume.level');
  share.handleShareControl(
    ctx(master, {
      userId: 'U1',
      permissions: { ...database.getUserPermissions(GUILD, 'U1'), 'volume.level': true },
    }),
  );
  check('cocher la case répond aussi à la demande', !database.getRightRequests(GUILD).U1);

  // ───────── La sourdine ─────────

  console.log('\nLa sourdine\n');

  await new Promise((resolve) => setTimeout(resolve, 3100));
  ask(guest, 'queue.clear');
  share.handleMuteRightRequests(ctx(master, { userId: 'U1', muted: true }));
  check('mettre en sourdine efface ce qui attendait', !database.getRightRequests(GUILD).U1);
  check('  … et se retient', database.getMutedRightRequests(GUILD).includes('U1'));
  check("  … l'état de l'invité le porte", webServerModule._shareStateFor(guest, GUILD).requestsMuted === true);

  const before = master.count('rightRequested');
  await new Promise((resolve) => setTimeout(resolve, 3100));
  ask(guest, 'queue.clear');
  check(
    'en sourdine, rien ne part',
    guest.last('rightRequestResult')?.data.reason === 'muted' && master.count('rightRequested') === before,
  );

  share.handleMuteRightRequests(ctx(master, { userId: 'U1', muted: false }));
  check('la sourdine se lève', !database.getMutedRightRequests(GUILD).includes('U1'));

  // ───────── Congédier ─────────

  console.log('\nCongédier\n');

  // Une sourdine et une demande à la fois : un état que les handlers ne
  // produisent pas — la sourdine vide les demandes —, posé directement en base
  // pour voir le renvoi effacer l'une et l'autre.
  database.setRightRequestsMuted(GUILD, 'U1', true);
  database.addRightRequest(GUILD, 'U1', 'queue.clear');
  share.handleRevokeControl(ctx(master, { userId: 'U1' }));
  check('un invité congédié repart sans demandes', !database.getRightRequests(GUILD).U1);
  check('  … ni sourdine', !database.getMutedRightRequests(GUILD).includes('U1'));

  database.flush();

  // ───────── Dans le navigateur ─────────

  await browserSide();

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

/**
 * La bulle de refus chez l'invité, et la ligne de demandes chez l'administrateur,
 * avec les vrais customSelect.js et sharedControl.js dans jsdom.
 *
 * `jsdom` n'est pas une dépendance déclarée : la section se retire d'elle-même
 * s'il manque, comme dans tests/rangeFocus.js.
 */
async function browserSide() {
  let JSDOM;
  try {
    ({ JSDOM } = require('jsdom'));
  } catch (e) {
    console.log('\n  passé — jsdom absent de cette installation');
    return;
  }

  const PUBLIC = path.join(ROOT, 'src', 'web', 'public');
  const read = (...parts) => fs.readFileSync(path.join(PUBLIC, ...parts), 'utf8');

  const mount = async (markup) => {
    const dom = new JSDOM(`<!doctype html><html><body>${markup}</body></html>`, {
      runScripts: 'outside-only',
      url: 'http://localhost:3000/',
    });
    const win = dom.window;
    const sent = [];
    const toasts = [];
    win.eval(read('js', 'customSelect.js'));
    win.MusicPlayer.sendWS = (payload) => sent.push(payload);
    win.MusicPlayer.showToast = (message, action) => toasts.push({ message, action });
    win.eval(read('js', 'sharedControl.js'));
    if (win.document.readyState !== 'complete') {
      await new Promise((resolve) => win.addEventListener('load', resolve));
    }
    return { win, sent, toasts };
  };

  console.log("\nChez l'invité\n");
  {
    const { win, sent, toasts } = await mount(
      '<select id="playback-source-select"><option selected>File</option></select>' +
        '<button id="btn-restart-bot">Redémarrer</button>',
    );
    const doc = win.document;
    win.eval('new CustomSelect(document.getElementById("playback-source-select"))');
    win.MusicPlayer.applyShareState({ role: 'guest', permissions: {}, rightRequests: [], requestsMuted: false });

    const trigger = doc.querySelector('.custom-select-container .custom-select-trigger');
    trigger.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));

    const bubble = doc.getElementById('perm-refusal');
    const q = (s) => bubble.querySelector(s);
    check('le clic ouvre la bulle de refus', bubble && !bubble.hidden);
    check(
      "  … qui dit ce qu'est la commande",
      q('.perm-refusal-title').textContent.includes('ce menu'),
      q('.perm-refusal-title').textContent,
    );
    check(
      '  … et ce qui manque',
      q('.perm-refusal-feature').textContent.includes('Choisir la source'),
      q('.perm-refusal-feature').textContent,
    );
    check(
      'la notification dit la même chose, bouton compris',
      toasts.length === 1 &&
        toasts[0].message.includes('ce menu') &&
        toasts[0].message.includes('Choisir la source') &&
        toasts[0].action &&
        toasts[0].action.label === q('.perm-refusal-btn').textContent,
    );

    q('.perm-refusal-btn').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    check(
      'le bouton demande le droit en cause',
      sent.length === 1 && sent[0].type === 'requestRight' && sent[0].data.action === 'playback.source',
    );
    check(
      '  … une seule fois',
      (q('.perm-refusal-btn').dispatchEvent(new win.MouseEvent('click', { bubbles: true })), sent.length === 1),
    );

    win.MusicPlayer.applyShareState({
      role: 'guest',
      permissions: {},
      rightRequests: ['playback.source'],
      requestsMuted: false,
    });
    check(
      'une demande en attente grise le bouton',
      q('.perm-refusal-btn').disabled && q('.perm-refusal-hint').textContent.includes('attend'),
    );

    win.MusicPlayer.applyShareState({ role: 'guest', permissions: {}, rightRequests: [], requestsMuted: true });
    check(
      'en sourdine, le bouton est grisé et la raison dite',
      q('.perm-refusal-btn').disabled && q('.perm-refusal-hint').textContent.includes('sourdine'),
    );

    win.MusicPlayer.applyShareState({
      role: 'guest',
      permissions: { 'playback.source': true },
      rightRequests: [],
      requestsMuted: false,
    });
    check('le droit accordé referme la bulle', bubble.hidden);

    doc
      .getElementById('btn-restart-bot')
      .dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
    check(
      "ce qui est réservé à l'administrateur ne se demande pas",
      !bubble.hidden &&
        q('.perm-refusal-btn').hidden &&
        q('.perm-refusal-title').textContent.includes('administrateur'),
    );
    win.close();
  }

  console.log('\nLes commandes qui se déclarent\n');
  {
    const { win, sent, toasts } = await mount(
      '<div class="scroll-input-wrapper" data-perm="master"><input type="range" id="reserved" value="30"></div>',
    );
    const doc = win.document;
    win.MusicPlayer.applyShareState({ role: 'guest', permissions: {}, rightRequests: [], requestsMuted: false });

    // Construite après l'état, comme une ligne de file ou un menu contextuel.
    const late = doc.createElement('button');
    late.dataset.perm = 'queue.remove';
    let clicks = 0;
    late.addEventListener('click', () => {
      clicks++;
    });
    doc.body.appendChild(late);

    const sheet = doc.getElementById('perm-declared-style');
    check(
      'le grisage vaut pour ce qui sera construit après',
      sheet &&
        sheet.textContent.includes('[data-perm="queue.remove"]') &&
        sheet.textContent.includes('[data-perm="master"]'),
    );

    late.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
    const bubble = doc.getElementById('perm-refusal');
    check("une commande construite après l'état est retenue", clicks === 0);
    check(
      "  … et sa bulle nomme le droit qu'elle déclare",
      !bubble.hidden && bubble.querySelector('.perm-refusal-feature').textContent.includes('Retirer une piste'),
    );

    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    late.focus();
    late.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
    late.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    check('Échap ferme la bulle même quand le focus est sur la commande refusée', bubble.hidden);

    const touch = new win.Event('touchstart', { bubbles: true, cancelable: true });
    late.dispatchEvent(touch);
    check("l'appui du doigt est refusé aussi, et ouvre la bulle", touch.defaultPrevented && !bubble.hidden);

    doc.getElementById('reserved').dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    doc.getElementById('reserved').dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
    check(
      'un réglage réservé se dit réservé, sans bouton de demande',
      bubble.querySelector('.perm-refusal-title').textContent.includes('administrateur') &&
        bubble.querySelector('.perm-refusal-btn').hidden,
    );

    win.MusicPlayer.applyShareState({
      role: 'guest',
      permissions: { 'queue.remove': true },
      rightRequests: [],
      requestsMuted: false,
    });
    late.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
    check('le droit accordé, la commande répond', clicks === 1 && !sheet.textContent.includes('"queue.remove"'));

    win.MusicPlayer.applyShareState({ role: 'master' });
    check("l'administrateur ne voit rien de grisé", sheet.textContent === '');
    check(
      'isGuest dit qui regarde',
      win.MusicPlayer.isGuest() === false &&
        (win.MusicPlayer.applyShareState({ role: 'guest', permissions: {} }), win.MusicPlayer.isGuest() === true),
    );
    void sent;
    void toasts;
    win.close();

    // Les envois d'habitude — pas de geste derrière — ne partent pas de chez
    // un invité : ils revenaient en refus, donc en notifications.
    const SETTINGS = read('js', 'settingsModal.js');
    const APP = read('app.js');
    /*
     * Comptés l'un par l'autre, et non contre un nombre écrit ici : un envoi
     * de réglages ajouté sans sa garde doit faire échouer ce test, et un
     * envoi ajouté avec la sienne ne doit rien demander à personne.
     */
    const envois = (SETTINGS.match(/type: 'updateSettings'/g) || []).length;
    const gardes = (
      SETTINGS.match(
        /&& !\(typeof window\.MusicPlayer\.isGuest === 'function' && window\.MusicPlayer\.isGuest\(\)\)\)/g,
      ) || []
    ).length;
    check(
      'les paramètres ne recopient pas les réglages du serveur chez un invité',
      envois >= 3 && gardes === envois,
      `${gardes} gardes pour ${envois} envois`,
    );
    check('  … ni la reconnexion le préchargement', /if \(preloading && !guest\)/.test(APP));
  }

  {
    // Les constructeurs déclarent ce qu'ils bâtissent.
    const declared = {
      'js/queue.js': [
        "playNowBtn.dataset.perm = 'queue.playNow'",
        "deleteBtn.dataset.perm = 'queue.remove'",
        "deleteBtn.dataset.perm = 'queue.history'",
        "switchLabel.dataset.perm = 'volume.ducking'",
      ],
      'js/playlists.js': [
        "nameInput.dataset.perm = 'playlists.rename'",
        "deleteBtn.dataset.perm = 'playlists.delete'",
        "playBtn.dataset.perm = 'playback.source'",
        "removeBtn.dataset.perm = 'playlists.removeTrack'",
      ],
      'js/transitions.js': ["remove.dataset.perm = dansLaFile ? 'queue.remove' : 'playlists.removeTrack'"],
      'js/qualityMenu.js': [
        "btn.dataset.perm = 'volume.quality'",
        "btn.dataset.perm = 'playlists.transitions'",
        "btn.dataset.perm = 'volume.trackGain'",
        "menuEl.dataset.perm = 'playlists.transitions'",
      ],
      'js/settingsModal.js': ["trashBtn.dataset.perm = 'master'"],
    };
    const missing = [];
    for (const [file, needles] of Object.entries(declared)) {
      const source = read(...file.split('/'));
      for (const needle of needles) if (!source.includes(needle)) missing.push(`${file} : ${needle}`);
    }
    check('les lignes, onglets, menus et réglages déclarent leur droit', missing.length === 0, missing.join(' | '));

    const MARKUP = read('index.html');
    check(
      'les neuf réglages du serveur sont réservés dans le balisage',
      (MARKUP.match(/data-perm="master"/g) || []).length === 9,
    );

    const permsKnown = new Set([...permissions.ACTIONS, 'master']);
    const all = [
      ...Object.values(declared)
        .flat()
        .join(' ')
        .matchAll(/'([a-zA-Z.]+)'/g),
    ].map((m) => m[1]);
    const unknown = all.filter((perm) => !permsKnown.has(perm));
    check('  … et tous ces droits existent au catalogue', unknown.length === 0, unknown.join(', '));
  }

  console.log("\nChez l'administrateur\n");
  {
    const { win, sent, toasts } = await mount(
      '<div id="share-modal" class="hidden"><div id="share-people-list"></div></div>' +
        '<span id="share-presence"></span><span id="share-knock-dot" class="hidden"></span>',
    );
    const doc = win.document;
    win.MusicPlayer.state = { role: 'master', identity: { userId: 'OWNER' }, members: [] };
    const sharingState = (requests, muted = []) => ({
      role: 'master',
      sharing: {
        oauthReady: true,
        grants: {},
        admitted: ['U1'],
        pending: [],
        knownUsers: [{ userId: 'U1', displayName: 'Yoohyeonz', online: true }],
        requests,
        mutedRequests: muted,
        catalogue: { groups: permissions.GROUPS, actions: permissions.GROUP_ACTIONS, presets: permissions.PRESETS },
      },
    });
    win.MusicPlayer.applyShareState(sharingState({ U1: { 'playback.source': 1 } }));

    const face = doc.querySelector('#share-presence .share-presence-item[data-key="user:U1"]');
    check(
      'une demande cercle la photo de son auteur sur le bouton de partage',
      face &&
        face.classList.contains('is-knocking') &&
        doc.getElementById('share-knock-dot').classList.contains('hidden'),
    );

    win.MusicPlayer.onRightRequested({ userId: 'U1', displayName: 'Yoohyeonz', action: 'playback.source' });
    check(
      'fenêtre fermée, la demande sonne',
      toasts.length === 1 && toasts[0].message.includes('Yoohyeonz') && toasts[0].action.label === 'Voir',
    );

    toasts[0].action.onClick();
    const row = doc.querySelector('.share-person[data-user-id="U1"]');
    check(
      "« Voir » ouvre la fenêtre sur l'invité",
      !doc.getElementById('share-modal').classList.contains('hidden') && row && row.classList.contains('is-open'),
    );
    check('  … où la demande attend, visible', row.querySelectorAll('.share-request').length === 1);

    win.MusicPlayer.onRightRequested({ userId: 'U1', displayName: 'Yoohyeonz', action: 'volume.level' });
    check('fenêtre ouverte, pas de notification par-dessus', toasts.length === 1);

    row
      .querySelector('.share-request .share-pending-btn.accept')
      .dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    check(
      '« Accorder » répond à la demande',
      sent.some((m) => m.type === 'answerRightRequest' && m.data.grant === true && m.data.action === 'playback.source'),
    );

    doc
      .querySelector('.share-person[data-user-id="U1"] .share-person-btn.mute')
      .dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    check(
      'la sourdine se règle par invité',
      sent.some((m) => m.type === 'muteRightRequests' && m.data.userId === 'U1' && m.data.muted === true),
    );

    win.MusicPlayer.applyShareState(sharingState({}, ['U1']));
    check(
      '  … et se lit sans déplier',
      Boolean(doc.querySelector('.share-person[data-user-id="U1"] .share-person-muted')),
    );
    win.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
