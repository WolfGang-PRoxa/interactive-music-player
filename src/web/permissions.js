/**
 * permissions — Ce qu'un invité a le droit de faire.
 *
 * Le maître de session — le compte Discord propriétaire de l'installation, voir
 * owner.js — peut tout. Les invités reconnus par Discord (voir oauth.js et
 * sessions.js) n'ont que ce qu'il leur a accordé, geste par geste.
 *
 * **Le contrôle est ici, et nulle part ailleurs.** Le tableau de bord grise les
 * commandes interdites, mais ce n'est qu'une politesse envers l'invité : rien
 * n'empêche d'ouvrir la console du navigateur et d'envoyer le message à la
 * main. La seule barrière qui compte est celle que le serveur oppose, c'est
 * celle de ce module.
 *
 * ## Le grain
 *
 * Les droits furent d'abord quatre — mener la lecture, garnir la file, tenir
 * les playlists, régler le volume — et c'était trop grossier : confier la file
 * d'attente à quelqu'un lui donnait du même geste le droit de la vider, et
 * laisser régler le volume laissait aussi changer de salon vocal. On ne pouvait
 * pas dire « ajoute ce que tu veux, mais n'efface rien », qui est pourtant la
 * chose qu'on veut dire le plus souvent.
 *
 * Un droit correspond donc désormais à un geste, et les quatre groupes ne sont
 * plus qu'un rangement : ils donnent à la fenêtre de partage ses rubriques et
 * ses interrupteurs d'ensemble, ils ne décident plus de rien.
 *
 * Un droit se nomme `rubrique.geste`. Le point n'est pas décoratif : c'est à
 * lui qu'on reconnaît un droit d'aujourd'hui d'un droit d'hier, ce qui permet
 * de relire sans broncher un `settings.json` écrit par une version précédente
 * (voir `sanitize`).
 *
 * ## Ce qui n'est jamais partagé
 *
 * Éteindre le bot, changer sa version, le faire quitter un serveur, ouvrir le
 * tunnel, distribuer les droits eux-mêmes : ces gestes-là restent au maître, et
 * n'apparaissent pas dans la fenêtre de partage. Un message inconnu de la table
 * leur est assimilé. C'est délibéré : une commande ajoutée plus tard sans y
 * penser sera fermée par défaut plutôt qu'ouverte à tous.
 */

/** Les quatre rubriques, dans l'ordre où le tableau de bord les montre. */
const GROUPS = ['playback', 'queue', 'playlists', 'volume'];

/** Valeur de `MESSAGE_RIGHTS` pour ce qui n'appartient qu'au maître. */
const MASTER_ONLY = Symbol('master');

/**
 * Valeur de `MESSAGE_RIGHTS` pour les messages qui ne commandent rien.
 *
 * Un invité doit pouvoir demander l'état, remonter une erreur ou annoncer sa
 * progression de lecture : ce sont des messages de synchronisation, pas des
 * ordres. Les refuser ne protégerait rien et laisserait son tableau de bord
 * aveugle.
 */
const ALWAYS = null;

/**
 * Valeur de `MESSAGE_RIGHTS` pour un message dont chaque champ relève d'un
 * droit différent.
 *
 * `canSend` le laisse passer : ce n'est pas lui qui décide, mais
 * `filterSettings`, qui ne garde que les réglages permis. Un invité sans aucun
 * droit voit donc sa demande vidée de tout contenu, ce que l'appelant traite
 * comme un refus.
 */
const FIELD_FILTERED = Symbol('champs');

/**
 * Le catalogue des droits, dans l'ordre d'affichage.
 *
 * Chaque entrée est un geste que le maître peut confier, avec les messages
 * WebSocket et les champs de `updateSettings` qu'il ouvre. Une entrée sans
 * `messages` ne s'exerce que par les réglages — la vitesse de lecture, par
 * exemple, n'a pas de message à elle.
 *
 * L'ordre compte : c'est celui que suit la fenêtre de partage, et il va du
 * geste le plus courant au plus lourd de conséquences à l'intérieur de chaque
 * rubrique.
 */
const ACTION_DEFS = [
  /* ── Mener la lecture en cours ────────────────────────────────────── */
  {
    key: 'playback.transport',
    group: 'playback',
    messages: ['resume', 'pause', 'stop'],
  },
  {
    key: 'playback.skip',
    group: 'playback',
    messages: ['skip', 'previous'],
  },
  {
    key: 'playback.seek',
    group: 'playback',
    messages: ['seek'],
  },
  {
    key: 'playback.mode',
    group: 'playback',
    messages: ['setPlayMode'],
  },
  {
    // Choisir entre la file et une playlist, c'est décider de ce qui joue —
    // pas modifier une collection. D'où `playback` plutôt que `playlists`.
    // Le bouton lecture d'un lecteur vide démarre la source choisie sans
    // rien y ajouter : il relève du même geste.
    key: 'playback.source',
    group: 'playback',
    messages: ['setActivePlaybackSource', 'startPlaybackSource'],
  },
  {
    key: 'playback.speed',
    group: 'playback',
    settings: ['playbackSpeed'],
  },
  {
    key: 'playback.mix',
    group: 'playback',
    settings: ['mixEnabled', 'mixDuration', 'mixType'],
  },
  {
    key: 'playback.loudness',
    group: 'playback',
    settings: ['lufsSyncEnabled', 'lufsSyncTarget'],
  },

  /* ── Décider de ce qui passe ensuite ──────────────────────────────── */
  {
    // `play` porte mal son nom : c'est l'ajout d'un résultat de recherche à
    // la file. Le bouton lecture, lui, envoie `resume`.
    key: 'queue.add',
    group: 'queue',
    messages: ['play'],
  },
  {
    // Passer devant tout le monde n'est pas ajouter : celui à qui l'on
    // permet de proposer une piste n'a pas forcément le droit d'interrompre
    // celle qui joue.
    key: 'queue.playNow',
    group: 'queue',
    messages: ['playNow'],
  },
  {
    key: 'queue.remove',
    group: 'queue',
    messages: ['removeTrack'],
  },
  {
    key: 'queue.reorder',
    group: 'queue',
    messages: ['moveOrInsertTrack'],
  },
  {
    key: 'queue.history',
    group: 'queue',
    messages: ['clearHistory', 'removeFromHistory'],
  },
  {
    // Écrire un fichier sur le disque du bot n'est pas piloter la lecture :
    // c'est ajouter, comme les autres destinations de la même boîte.
    key: 'queue.download',
    group: 'queue',
    messages: ['downloadTrack'],
  },
  {
    // Tout effacer d'un geste se coche à part de « retirer une piste » :
    // c'est la même rubrique, ce n'est pas la même portée.
    key: 'queue.clear',
    group: 'queue',
    messages: ['clearQueue'],
  },

  /* ── Tenir les collections enregistrées ───────────────────────────── */
  {
    key: 'playlists.create',
    group: 'playlists',
    messages: ['createPlaylist'],
  },
  {
    key: 'playlists.addTrack',
    group: 'playlists',
    messages: ['addPlaylistTrack', 'addTrackToPlaylist'],
  },
  {
    key: 'playlists.removeTrack',
    group: 'playlists',
    messages: ['removeTrackFromPlaylist'],
  },
  {
    key: 'playlists.reorderTracks',
    group: 'playlists',
    messages: ['movePlaylistTrack'],
  },
  {
    key: 'playlists.rename',
    group: 'playlists',
    messages: ['renamePlaylist'],
  },
  {
    key: 'playlists.organise',
    group: 'playlists',
    messages: ['reorderPlaylists'],
  },
  {
    // Poser un aiguillage revient à réécrire une playlist, et le modifier
    // relève du même droit que le poser — dans une playlist comme dans la
    // file : c'est une seule fonctionnalité.
    key: 'playlists.transitions',
    group: 'playlists',
    messages: ['insertTransition', 'setTransitionTarget'],
  },
  {
    // Détruire une collection se coche à part du reste : c'est le seul
    // geste de cette rubrique qu'on ne peut pas défaire.
    key: 'playlists.delete',
    group: 'playlists',
    messages: ['deletePlaylist'],
  },

  /* ── Volume, atténuation, diffusion, qualité ──────────────────────── */
  {
    key: 'volume.level',
    group: 'volume',
    settings: ['baseVolume'],
  },
  {
    key: 'volume.ducking',
    group: 'volume',
    messages: ['toggleVoiceDetection'],
    settings: ['duckingEnabled', 'duckingLevel', 'duckingDelay', 'duckingFade'],
  },
  {
    key: 'volume.quality',
    group: 'volume',
    messages: ['requestTrackFormats', 'setTrackQuality'],
    settings: ['importAudioQuality', 'importVideoQuality'],
  },
  {
    key: 'volume.trackGain',
    group: 'volume',
    messages: ['requestTrackLoudness', 'setTrackLoudness'],
  },
  {
    key: 'volume.broadcast',
    group: 'volume',
    settings: ['broadcastMode'],
  },
  {
    // Déplacer le bot d'un salon à l'autre s'entend de tous ceux qui y
    // sont : le geste le plus visible de la rubrique, et le dernier qu'on
    // confie.
    key: 'volume.channel',
    group: 'volume',
    messages: ['selectChannel'],
  },
];

/** Les droits, dans l'ordre du catalogue. */
const ACTIONS = ACTION_DEFS.map((def) => def.key);

/** Rubrique → droits qu'elle contient, dans l'ordre. */
const GROUP_ACTIONS = GROUPS.reduce((acc, group) => {
  acc[group] = ACTION_DEFS.filter((def) => def.group === group).map((def) => def.key);
  return acc;
}, {});

/** Droit → rubrique. */
const ACTION_GROUP = ACTION_DEFS.reduce((acc, def) => {
  acc[def.key] = def.group;
  return acc;
}, {});

/**
 * Type de message WebSocket → droit requis.
 *
 * `updateSettings` fait exception : il porte des réglages relevant de plusieurs
 * droits à la fois, et se filtre champ par champ — voir `SETTINGS_RIGHTS`.
 *
 * Les entrées du catalogue s'y ajoutent juste après : les écrire ici une
 * seconde fois à la main serait la garantie qu'un jour les deux tables ne
 * diraient plus la même chose.
 */
const MESSAGE_RIGHTS = {
  // Synchronisation et télémétrie
  requestState: ALWAYS,
  clientLog: ALWAYS,
  memoryStream: ALWAYS,
  syncProgress: ALWAYS,
  startupFadeinConsumed: ALWAYS,

  // Demander un droit ne l'accorde pas : c'est le maître qui répond, et le
  // handler refuse ce qui n'a pas lieu d'être demandé (voir shareHandlers).
  requestRight: ALWAYS,

  // Réparti champ par champ — voir SETTINGS_RIGHTS
  updateSettings: FIELD_FILTERED,

  // Maître seul
  leaveGuild: MASTER_ONLY,
  setDefaultChannel: MASTER_ONLY,
  restartBot: MASTER_ONLY,
  shutdownBot: MASTER_ONLY,
  listVersions: MASTER_ONLY,
  installVersion: MASTER_ONLY,
  uninstallVersion: MASTER_ONLY,

  // Partage du contrôle : seul le maître distribue les droits, sans quoi un
  // invité s'accorderait les siens.
  admitGuest: MASTER_ONLY,
  tunnelState: MASTER_ONLY,

  // Le fichier .env : un invité n'a rien à y lire, encore moins à y écrire.
  configState: MASTER_ONLY,
  configUpdate: MASTER_ONLY,
  tunnelInstall: MASTER_ONLY,
  tunnelMount: MASTER_ONLY,
  tunnelUnmount: MASTER_ONLY,
  shareControl: MASTER_ONLY,
  revokeControl: MASTER_ONLY,
  sendInviteLink: MASTER_ONLY,
  answerRightRequest: MASTER_ONLY,
  muteRightRequests: MASTER_ONLY,
};

for (const def of ACTION_DEFS) {
  for (const type of def.messages || []) MESSAGE_RIGHTS[type] = def.key;
}

/**
 * Champs de `updateSettings` → droit requis.
 *
 * Ce message est le seul chemin du tableau de bord vers les réglages du
 * serveur, et il mélange les genres : le volume principal y côtoie le délai de
 * départ du bot. Un invité ne voit donc pas sa demande refusée en bloc — les
 * champs qu'il a le droit de changer passent, les autres sont retirés.
 *
 * Tout champ absent de cette table revient au maître.
 */
const SETTINGS_RIGHTS = {};
for (const def of ACTION_DEFS) {
  for (const field of def.settings || []) SETTINGS_RIGHTS[field] = def.key;
}

/**
 * Rôles tout faits, pour n'avoir pas à cocher vingt-neuf cases.
 *
 * Ils ne sont pas un niveau de plus dans le modèle : un préréglage n'est qu'une
 * poignée de cases posée d'un coup, et l'instant d'après le maître peut en
 * décocher une seule. La fenêtre affiche alors « personnalisé », qui n'est pas
 * un quatrième rôle mais l'absence de rôle — voir `matchPreset`.
 *
 * Le fil conducteur : l'auditeur propose, le DJ mène, le co-hôte administre.
 */
const PRESETS = {
  /*
   * Celui qui écoute avec vous.
   *
   * Il glisse une piste dans la file et l'y retrouve. Il ne coupe pas ce qui
   * joue, ne double personne, n'efface rien : c'est le droit d'être entendu,
   * pas celui de décider.
   */
  listener: ['queue.add'],

  /*
   * Celui qui tient la musique.
   *
   * Tout ce qui touche à ce qui sort des enceintes — mener, enchaîner,
   * garnir, ajuster le niveau et la qualité —, et rien de ce qui touche à
   * l'installation : ni le salon vocal, ni le mode de diffusion, ni la
   * destruction des collections.
   */
  dj: [
    ...GROUP_ACTIONS.playback,
    ...GROUP_ACTIONS.queue,
    'playlists.addTrack',
    'playlists.removeTrack',
    'playlists.reorderTracks',
    'playlists.transitions',
    'volume.level',
    'volume.quality',
    'volume.trackGain',
  ],

  /*
   * Celui qui remplace le maître quand il n'est pas là.
   *
   * Tout ce qui se partage. Ce qui ne se partage pas — éteindre, changer de
   * version, distribuer les droits — reste hors de portée : voir l'en-tête.
   */
  cohost: [...ACTIONS],
};

/** Droits d'un invité à qui rien n'a été accordé. */
function noPermissions() {
  return ACTIONS.reduce((acc, key) => {
    acc[key] = false;
    return acc;
  }, {});
}

/** Droits du maître : tout ce qui se partage, sans exception. */
function allPermissions() {
  return ACTIONS.reduce((acc, key) => {
    acc[key] = true;
    return acc;
  }, {});
}

/**
 * Ramène une valeur venue du réseau — ou du disque — à un jeu de droits sûr.
 *
 * Le maître envoie ce que son interface produit ; on ne s'y fie pas plus qu'au
 * reste. Seules les clés connues survivent, et seules des valeurs booléennes.
 *
 * **Les quatre droits d'hier sont relus comme les vingt-neuf d'aujourd'hui.**
 * Un `settings.json` écrit par une version antérieure porte `{ playback: true,
 * queue: false, … }` ; le lire comme un jeu vide dépouillerait sans un mot tous
 * les invités d'une installation qui se met à jour. Un nom de rubrique posé à
 * vrai ouvre donc tous les gestes de la rubrique, ce qui est très exactement ce
 * qu'il voulait dire à l'époque où il fut écrit. Les deux formes peuvent même
 * se mêler : la migration est appliquée d'abord, les droits nommés un par un
 * ont donc le dernier mot.
 *
 * @param {any} raw
 * @returns {Object<string, boolean>} Un booléen par droit du catalogue.
 */
function sanitize(raw) {
  const clean = noPermissions();
  if (!raw || typeof raw !== 'object') return clean;

  for (const group of GROUPS) {
    if (raw[group] !== true) continue;
    for (const key of GROUP_ACTIONS[group]) clean[key] = true;
  }

  for (const key of ACTIONS) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) clean[key] = raw[key] === true;
  }

  return clean;
}

/** Cet invité a-t-il au moins un droit ? */
function hasAny(permissions) {
  return ACTIONS.some((key) => permissions && permissions[key] === true);
}

/** Les droits accordés, nommés, dans l'ordre du catalogue. */
function granted(permissions) {
  return ACTIONS.filter((key) => permissions && permissions[key] === true);
}

/**
 * Où en est une rubrique : rien, une partie, ou tout.
 *
 * Sert à l'interrupteur d'ensemble de chaque rubrique, qui doit pouvoir montrer
 * un état intermédiaire plutôt que de mentir dans un sens ou dans l'autre.
 *
 * @param {object} permissions
 * @param {string} group
 * @returns {'none'|'partial'|'all'}
 */
function groupState(permissions, group) {
  const keys = GROUP_ACTIONS[group] || [];
  const on = keys.filter((key) => permissions && permissions[key] === true).length;
  if (on === 0) return 'none';
  return on === keys.length ? 'all' : 'partial';
}

/**
 * Les droits d'un rôle tout fait, ou un jeu vide si le rôle est inconnu.
 * @param {string} name
 * @returns {Object<string, boolean>}
 */
function presetPermissions(name) {
  const keys = PRESETS[name];
  if (!keys) return noPermissions();
  return sanitize(
    keys.reduce((acc, key) => {
      acc[key] = true;
      return acc;
    }, {}),
  );
}

/**
 * Ce jeu de droits est-il exactement un rôle tout fait ?
 *
 * Rendre le nom permet à la fenêtre de partage de rallumer la pastille du rôle
 * quand elle rouvre, plutôt que d'annoncer « personnalisé » pour un invité
 * qu'on venait de nommer DJ.
 *
 * Un jeu vide ne correspond à aucun rôle : il vaut « rien accordé », que la
 * fenêtre montre par elle-même.
 *
 * @param {object} permissions
 * @returns {string|null}
 */
function matchPreset(permissions) {
  if (!hasAny(permissions)) return null;
  for (const name of Object.keys(PRESETS)) {
    const reference = presetPermissions(name);
    if (ACTIONS.every((key) => Boolean(permissions[key]) === reference[key])) return name;
  }
  return null;
}

/**
 * Ce demandeur peut-il envoyer ce message ?
 *
 * @param {{ master: boolean, permissions?: object }} identity
 * @param {string} type Type du message WebSocket.
 * @returns {boolean}
 */
function canSend(identity, type) {
  if (identity && identity.master) return true;

  const required = Object.prototype.hasOwnProperty.call(MESSAGE_RIGHTS, type)
    ? MESSAGE_RIGHTS[type]
    : // Message inconnu : fermé par défaut. Voir l'en-tête du module.
      MASTER_ONLY;

  if (required === ALWAYS) return true;
  if (required === FIELD_FILTERED) return true;
  if (required === MASTER_ONLY) return false;

  return Boolean(identity && identity.permissions && identity.permissions[required]);
}

/**
 * Ne garde d'un `updateSettings` que les réglages permis au demandeur.
 *
 * @param {{ master: boolean, permissions?: object }} identity
 * @param {object} data Charge utile du message.
 * @returns {{ allowed: object, refused: string[] }}
 */
function filterSettings(identity, data) {
  if (identity && identity.master) return { allowed: data || {}, refused: [] };

  const allowed = {};
  const refused = [];
  const permissions = (identity && identity.permissions) || noPermissions();

  for (const [field, value] of Object.entries(data || {})) {
    const right = SETTINGS_RIGHTS[field];
    if (right && permissions[right]) allowed[field] = value;
    else refused.push(field);
  }

  return { allowed, refused };
}

/**
 * Le droit du catalogue qu'un refus concerne, s'il en est un.
 *
 * Le tableau de bord de l'invité en a besoin pour nommer ce qui lui manque et
 * lui offrir de le demander. Un message réservé au maître n'en désigne aucun —
 * on ne demande pas d'éteindre le bot —, ni un message inconnu.
 *
 * @param {string} type Type du message refusé.
 * @param {string[]} [refusedFields] Champs retirés d'un `updateSettings`.
 * @returns {string|null}
 */
function rightOf(type, refusedFields = []) {
  if (type === 'updateSettings') {
    const rights = refusedFields.map((field) => SETTINGS_RIGHTS[field]).filter(Boolean);
    return rights.length ? rights[0] : null;
  }
  const required = MESSAGE_RIGHTS[type];
  return typeof required === 'string' ? required : null;
}

module.exports = {
  GROUPS,
  GROUP_ACTIONS,
  ACTION_GROUP,
  ACTIONS,
  ACTION_DEFS,
  PRESETS,
  MASTER_ONLY,
  FIELD_FILTERED,
  MESSAGE_RIGHTS,
  SETTINGS_RIGHTS,
  noPermissions,
  allPermissions,
  sanitize,
  hasAny,
  granted,
  groupState,
  presetPermissions,
  matchPreset,
  canSend,
  filterSettings,
  rightOf,
};
