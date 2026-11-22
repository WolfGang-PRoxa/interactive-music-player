/**
 * changelog — Le journal des modifications, lu sur le disque et rendu en
 * structure.
 *
 * ## Pourquoi une structure, et non du Markdown brut
 *
 * La documentation embarquée est servie telle qu'elle est écrite : le tableau
 * de bord en rend le Markdown (voir `/api/docs/content` et js/docs.js). Ici
 * c'est l'inverse qui est utile. Le journal n'est pas un texte à lire d'un
 * bout à l'autre : c'est une suite de livraisons datées, chacune découpée en
 * catégories, et ce sont ces deux axes que la fenêtre de lecture donne à
 * parcourir — une frise, un sommaire par mois, des filtres par catégorie, un
 * compte par livraison. Rien de tout cela ne se déduit d'un flux de balises.
 *
 * Le fichier reste donc du Markdown — lisible sur le dépôt, modifiable à la
 * main, sans outil — et c'est ce module qui en extrait la charpente. Le
 * Markdown *à l'intérieur* d'une entrée (code littéral, gras, liens) n'est pas
 * touché : il voyage tel quel et c'est le tableau de bord qui le rend, avec le
 * même code que la documentation.
 *
 * ## Le format
 *
 * Celui de Keep a Changelog :
 *
 *     ## [Unreleased]
 *     ## [X.Y.Z] - AAAA-MM-JJ
 *     Une phrase de résumé, facultative.
 *     ### Added
 *     - Un changement par ligne.
 *
 * Les livraisons d'avant la 0.0.1, notées au jour le jour, gardent leur
 * ancien titre : `## AAAA-MM-JJ — Titre de la livraison`. Les deux formes
 * se lisent ici de la même façon ; une version reçoit pour titre
 * « Version X.Y.Z ».
 *
 * `[Unreleased]` n'est pas une livraison : ses entrées sont rendues à part,
 * sous `unreleased`, et la frise du tableau de bord ne montre que ce qui a été
 * livré. Les définitions de liens de fin de fichier (`[0.0.2]: https://…`) sont
 * sautées.
 *
 * Les rubriques sont écrites dans la langue du fichier — Added ou Ajouts,
 * Fixed ou Corrections — et ramenées ici aux six catégories de `KINDS`, que le
 * tableau de bord affiche traduites.
 *
 * ## Les langues
 *
 * Le journal est écrit à la main en anglais (`CHANGELOG.md`) et traduit en
 * français (`CHANGELOG.fr.md`), et les fichiers font foi : ce qui n'y est pas
 * retombe sur `REFERENCE_LANG`. La documentation, elle,
 * retombe sur le français, et pour une raison qui ne vaut pas ici — c'est sa
 * langue d'écriture, dont les autres sont traduites. Le journal a deux langues
 * d'écriture ; un lecteur dont la langue manque est mieux servi par celle qui
 * voyage le plus loin.
 */

const fs = require('fs');
const path = require('path');

/**
 * Racine de la **version en cours d'exécution**, où vivent `CHANGELOG.md` et
 * ses traductions.
 *
 * Résolue depuis `__dirname` et non depuis `process.cwd()`, pour la même raison
 * que `DOCS_DIR` dans routes/api.js : sur une release installée, le journal lu
 * dans le tableau de bord doit être celui de la version qui tourne.
 */
const CHANGELOG_DIR = path.resolve(__dirname, '..', '..');

/** Langue servie quand celle demandée n'est pas écrite — voir l'en-tête. */
const REFERENCE_LANG = 'en';

/**
 * Nom du fichier d'une langue : `CHANGELOG.md` pour la référence, que tout
 * dépôt lit en premier, `CHANGELOG.<langue>.md` pour ses traductions.
 */
function fileOf(lang) {
  return lang === REFERENCE_LANG ? 'CHANGELOG.md' : `CHANGELOG.${lang}.md`;
}

/**
 * Catégories connues, dans l'ordre où elles paraissent dans une livraison.
 *
 * Cet ordre est celui de Keep a Changelog, et il n'est pas arbitraire : on lit
 * d'abord ce qui est nouveau, puis ce qui a changé de forme, puis ce qui est
 * réparé. Une section inconnue n'est pas refusée — elle est rendue telle quelle,
 * à la fin : un mot-clé mal orthographié doit se voir dans la fenêtre, pas
 * disparaître du journal.
 */
const KINDS = ['added', 'changed', 'fixed', 'removed', 'deprecated', 'security'];

/**
 * Les mots de rubrique de chaque langue écrite, ramenés à leur catégorie.
 *
 * En minuscules : la comparaison se fait sur le mot du fichier mis en
 * minuscules. Un mot absent de la table passe tel quel — voir `KINDS`.
 */
const KIND_WORDS = {
  added: 'added',
  changed: 'changed',
  fixed: 'fixed',
  removed: 'removed',
  deprecated: 'deprecated',
  security: 'security',
  ajouts: 'added',
  améliorations: 'changed',
  corrections: 'fixed',
  suppressions: 'removed',
  dépréciations: 'deprecated',
  sécurité: 'security',
};

/**
 * Langues effectivement écrites, lues sur le disque à chaque appel.
 *
 * Une liste en dur devrait être tenue à jour à la main, et se tromperait sur une
 * version installée qui n'en embarque pas autant. Les fichiers font foi.
 *
 * Le filtre sur deux lettres minuscules n'est pas de la validation d'entrée —
 * rien de ce qui vient du client n'arrive ici — mais une garde contre les
 * fichiers annexes qu'on pourrait déposer à côté.
 */
function availableLangs() {
  try {
    return fs
      .readdirSync(CHANGELOG_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => /^CHANGELOG(?:\.([a-z]{2}))?\.md$/.exec(entry.name))
      .filter(Boolean)
      .map((match) => match[1] || REFERENCE_LANG)
      .sort();
  } catch (e) {
    return [];
  }
}

/**
 * Langue à servir pour une demande du tableau de bord.
 *
 * La valeur reçue n'est jamais assemblée en chemin : elle est comparée aux noms
 * que le serveur a lui-même lus, et c'est l'un de ces noms qui est retourné. Une
 * valeur inconnue — langue non écrite, ou chaîne arbitraire — ne correspond
 * simplement à aucune entrée et retombe sur la référence.
 */
function resolveLang(requested) {
  const available = availableLangs();
  const wanted = String(requested || '');
  const match = available.find((lang) => lang === wanted);
  if (match) return match;
  return available.find((lang) => lang === REFERENCE_LANG) || available[0] || REFERENCE_LANG;
}

/** Une version livrée : `## [0.0.2] - 2026-11-21`. */
const VERSION_LINE = /^##\s+\[(\d+\.\d+\.\d+)\]\s*-\s*(\d{4}-\d{2}-\d{2})\s*$/;

/** Ce qui attend la prochaine version : `## [Unreleased]`. */
const UNRELEASED_LINE = /^##\s+\[unreleased\]\s*$/i;

/** Une livraison d'avant les versions, à sa date : `## 2026-09-14 — Titre`. */
const RELEASE_LINE = /^##\s+(\d{4}-\d{2}-\d{2})\s*(?:[—–-]\s*(.*))?$/;

/** Une définition de lien, en fin de fichier : `[0.0.2]: https://…`. */
const LINK_DEFINITION = /^\[[^\]]+\]:\s+\S+$/;

/**
 * Extrait la charpente d'un journal.
 *
 * Analyseur par lignes, une passe. Il ne cherche que quatre marques — le titre,
 * une livraison, une catégorie, une entrée — et laisse passer le reste : le
 * fichier porte un commentaire HTML qui décrit son propre format, et ce genre de
 * prose ne doit ni compter comme une entrée ni interrompre la lecture.
 *
 * @param {string} source Markdown du journal
 * @returns {{title: string, intro: string, releases: Array, count: number,
 *   unreleased: {groups: Array, count: number}}}
 */
function parse(source) {
  const lines = String(source).replace(/\r\n?/g, '\n').split('\n');

  let title = '';
  const intro = [];
  const releases = [];
  /** Ce qui attend la prochaine version : lu comme une livraison, rendu à part. */
  const unreleased = { groups: [], count: 0 };
  /** Livraison en cours de lecture, et sa catégorie en cours. */
  let release = null;
  let group = null;
  /** Dans un commentaire HTML : tout est sauté jusqu'à sa fermeture. */
  let inComment = false;

  for (const raw of lines) {
    const line = raw.trim();

    if (inComment) {
      if (line.includes('-->')) inComment = false;
      continue;
    }
    if (line.startsWith('<!--')) {
      // Un commentaire d'une seule ligne se referme sur place.
      if (!line.includes('-->')) inComment = true;
      continue;
    }
    if (!line || LINK_DEFINITION.test(line)) continue;

    if (UNRELEASED_LINE.test(line)) {
      release = unreleased;
      group = null;
      continue;
    }

    const versionLine = VERSION_LINE.exec(line);
    const releaseLine = versionLine ? null : RELEASE_LINE.exec(line);
    if (versionLine || releaseLine) {
      release = {
        version: versionLine ? versionLine[1] : '',
        date: versionLine ? versionLine[2] : releaseLine[1],
        title: versionLine ? `Version ${versionLine[1]}` : (releaseLine[2] || '').trim(),
        summary: '',
        groups: [],
        count: 0,
      };
      group = null;
      releases.push(release);
      continue;
    }

    const kindLine = /^###\s+(.+?)\s*$/.exec(line);
    if (kindLine && release) {
      const word = kindLine[1].trim().toLowerCase();
      const kind = KIND_WORDS[word] || word;
      // Une catégorie citée deux fois dans la même livraison est une
      // seule liste : on reprend celle qui existe plutôt que d'afficher
      // deux fois le même en-tête.
      group = release.groups.find((g) => g.kind === kind);
      if (!group) {
        group = { kind, entries: [] };
        release.groups.push(group);
      }
      continue;
    }

    const titleLine = /^#\s+(.+?)\s*$/.exec(line);
    if (titleLine && !release) {
      if (!title) title = titleLine[1].trim();
      continue;
    }

    const entryLine = /^[-*]\s+(.+)$/.exec(line);
    if (entryLine && release) {
      // Des entrées posées avant toute catégorie restent lisibles : elles
      // tombent dans un groupe sans nom, que la fenêtre rend sans badge.
      if (!group) {
        group = { kind: '', entries: [] };
        release.groups.push(group);
      }
      group.entries.push(entryLine[1].trim());
      release.count++;
      continue;
    }

    // Prose ordinaire. Avant la première livraison c'est l'introduction du
    // journal ; sous une date et avant toute catégorie, le résumé de la
    // livraison ; ailleurs, la suite de l'entrée qui précède — une entrée
    // peut tenir sur plusieurs lignes dans le fichier sans en faire deux.
    if (!release) {
      intro.push(line);
    } else if (!group) {
      if (release !== unreleased) release.summary = release.summary ? `${release.summary} ${line}` : line;
    } else if (group.entries.length) {
      group.entries[group.entries.length - 1] += ` ${line}`;
    }
  }

  // Les catégories connues d'abord, dans l'ordre de `KINDS`, et les autres
  // ensuite : le fichier décide du contenu, pas de l'ordre de lecture.
  const rank = (kind) => {
    const index = KINDS.indexOf(kind);
    return index === -1 ? KINDS.length : index;
  };
  for (const entry of [...releases, unreleased]) {
    entry.groups.sort((a, b) => rank(a.kind) - rank(b.kind));
  }

  return {
    title,
    intro: intro.join(' '),
    releases,
    count: releases.reduce((total, entry) => total + entry.count, 0),
    unreleased,
  };
}

/**
 * Lit et analyse le journal d'une langue.
 *
 * Relu à chaque appel, sans cache : celui du dépôt de développement s'écrit
 * pendant que le bot tourne, et le lecteur doit pouvoir le relire sans
 * redémarrage. Un fichier de trente kilo-octets analysé en une passe ne mérite
 * pas qu'on tienne un cache à jour.
 *
 * @param {string} requested Langue demandée par le tableau de bord
 * @returns {{lang: string, title: string, intro: string, releases: Array, count: number,
 *   unreleased: {groups: Array, count: number}}}
 * @throws {Error} si le fichier de la langue retenue est illisible
 */
function read(requested) {
  const lang = resolveLang(requested);
  const source = fs.readFileSync(path.join(CHANGELOG_DIR, fileOf(lang)), 'utf8');
  return { lang, ...parse(source) };
}

module.exports = {
  CHANGELOG_DIR,
  REFERENCE_LANG,
  KINDS,
  KIND_WORDS,
  fileOf,
  availableLangs,
  resolveLang,
  parse,
  read,
};
