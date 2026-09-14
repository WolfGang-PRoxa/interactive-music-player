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
 *     ## AAAA-MM-JJ — Titre de la livraison
 *     Une phrase de résumé, facultative.
 *     ### Added
 *     - Un changement par ligne.
 *
 * Les mots des sections restent en anglais dans toutes les langues : ce sont
 * les mots-clés de Keep a Changelog, reconnus ici et affichés traduits par le
 * tableau de bord. Les traduire dans les fichiers demanderait une table de
 * correspondance par langue, qui se désaccorderait au premier synonyme.
 *
 * ## Les langues
 *
 * Le journal est écrit à la main en français et en anglais, et le dossier fait
 * foi : ce qui n'y est pas retombe sur `REFERENCE_LANG`. La documentation, elle,
 * retombe sur le français, et pour une raison qui ne vaut pas ici — c'est sa
 * langue d'écriture, dont les autres sont traduites. Le journal a deux langues
 * d'écriture ; un lecteur dont la langue manque est mieux servi par celle qui
 * voyage le plus loin.
 */

const fs = require('fs');
const path = require('path');

/**
 * Dossier `changelog/` de la **version en cours d'exécution**.
 *
 * Résolu depuis `__dirname` et non depuis `process.cwd()`, pour la même raison
 * que `DOCS_DIR` dans routes/api.js : sur une release installée, le journal lu
 * dans le tableau de bord doit être celui de la version qui tourne.
 */
const CHANGELOG_DIR = path.resolve(__dirname, '..', '..', 'changelog');

/** Langue servie quand celle demandée n'est pas écrite — voir l'en-tête. */
const REFERENCE_LANG = 'en';

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
 * Langues effectivement écrites, lues sur le disque à chaque appel.
 *
 * Une liste en dur devrait être tenue à jour à la main, et se tromperait sur une
 * version installée qui n'en embarque pas autant. Le dossier fait foi.
 *
 * Le filtre sur deux lettres minuscules n'est pas de la validation d'entrée —
 * rien de ce qui vient du client n'arrive ici — mais une garde contre les
 * fichiers annexes qu'on pourrait déposer à côté.
 */
function availableLangs() {
    try {
        return fs
            .readdirSync(CHANGELOG_DIR, { withFileTypes: true })
            .filter((entry) => entry.isFile() && /^[a-z]{2}\.md$/.test(entry.name))
            .map((entry) => entry.name.slice(0, 2))
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

/** Une date de livraison, et rien d'autre : `## 2026-09-14 — Titre`. */
const RELEASE_LINE = /^##\s+(\d{4}-\d{2}-\d{2})\s*(?:[—–-]\s*(.*))?$/;

/**
 * Extrait la charpente d'un journal.
 *
 * Analyseur par lignes, une passe. Il ne cherche que quatre marques — le titre,
 * une livraison, une catégorie, une entrée — et laisse passer le reste : le
 * fichier porte un commentaire HTML qui décrit son propre format, et ce genre de
 * prose ne doit ni compter comme une entrée ni interrompre la lecture.
 *
 * @param {string} source Markdown du journal
 * @returns {{title: string, intro: string, releases: Array, count: number}}
 */
function parse(source) {
    const lines = String(source).replace(/\r\n?/g, '\n').split('\n');

    let title = '';
    const intro = [];
    const releases = [];
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
        if (!line) continue;

        const releaseLine = RELEASE_LINE.exec(line);
        if (releaseLine) {
            release = {
                date: releaseLine[1],
                title: (releaseLine[2] || '').trim(),
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
            const kind = kindLine[1].trim().toLowerCase();
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
            release.summary = release.summary ? `${release.summary} ${line}` : line;
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
    for (const entry of releases) {
        entry.groups.sort((a, b) => rank(a.kind) - rank(b.kind));
    }

    return {
        title,
        intro: intro.join(' '),
        releases,
        count: releases.reduce((total, entry) => total + entry.count, 0),
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
 * @returns {{lang: string, title: string, intro: string, releases: Array, count: number}}
 * @throws {Error} si le fichier de la langue retenue est illisible
 */
function read(requested) {
    const lang = resolveLang(requested);
    const source = fs.readFileSync(path.join(CHANGELOG_DIR, `${lang}.md`), 'utf8');
    return { lang, ...parse(source) };
}

module.exports = {
    CHANGELOG_DIR,
    REFERENCE_LANG,
    KINDS,
    availableLangs,
    resolveLang,
    parse,
    read,
};
