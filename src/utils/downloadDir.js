/**
 * downloadDir — Le dossier où atterrissent les fichiers téléchargés.
 *
 * Quatrième destination de la boîte d'ajout, à côté de la file, de la playlist
 * et de la lecture immédiate : celle-ci n'envoie rien au lecteur, elle écrit
 * sur le disque du bot.
 *
 * Deux choses le distinguent des chemins que `mediaPaths.js` garde :
 *
 *  - **Il s'écrit, il ne se lit pas.** `mediaPaths` protège la *lecture* — sans
 *    lui, un « ?trackUrl=…/.env » suffisait à faire servir n'importe quel
 *    fichier. Ici c'est l'inverse : le dossier est une cible, et le risque
 *    n'est pas de divulguer mais d'écrire là où il ne faut pas.
 *
 *  - **Il est choisi, et c'est le sujet.** Enfermer la destination dans une
 *    racine autorisée reviendrait à retirer la fonction : quelqu'un qui range
 *    sa musique dans `D:\Musique` veut l'y télécharger. Le périmètre est donc
 *    ouvert, et ce sont les garde-fous ci-dessous qui portent la sûreté.
 *
 * Ce choix se tient dans le modèle de menace du projet — le bot tourne sur la
 * machine de son propriétaire, et le tableau de bord peut déjà l'éteindre. Il
 * n'ouvre rien qu'un jeton dérobé n'ouvrait pas déjà, mais il mérite d'être
 * énoncé plutôt que subi. Voir docs/fr/technique/07-securite.md.
 */

const fs = require('fs');
const path = require('path');

/** Dossier par défaut, sous `data/` comme le cache et les imports. */
const DEFAULT_DIR = path.join(process.cwd(), 'data', 'downloads');

/**
 * Vérifie qu'un chemin peut servir de destination.
 *
 * Rend une raison plutôt qu'un booléen : l'utilisateur qui désigne un dossier
 * impossible a besoin de savoir lequel des cas il a rencontré, et « chemin
 * invalide » ne le renseigne sur rien.
 *
 * @param {string} candidate
 * @returns {{ ok: boolean, resolved?: string, reason?: string }}
 */
function validate(candidate) {
    if (typeof candidate !== 'string' || !candidate.trim()) {
        return { ok: false, reason: 'empty' };
    }

    // L'octet nul tronque le chemin au niveau des appels système : ce qui est
    // vérifié ici ne serait alors pas ce qui est ouvert plus bas.
    if (candidate.includes('\0')) {
        return { ok: false, reason: 'invalid' };
    }

    let resolved;
    try {
        resolved = path.resolve(candidate.trim());
    } catch (e) {
        return { ok: false, reason: 'invalid' };
    }

    let stat;
    try {
        stat = fs.statSync(resolved);
    } catch (e) {
        return { ok: false, reason: 'missing' };
    }

    if (!stat.isDirectory()) {
        return { ok: false, reason: 'notADirectory' };
    }

    // L'écriture est éprouvée, non supposée : un dossier peut exister, être
    // lisible, et refuser qu'on y crée quoi que ce soit — un point de montage
    // en lecture seule, un dossier système, un partage réseau déconnecté. Le
    // découvrir au moment du téléchargement laisserait l'utilisateur devant un
    // échec sans rapport apparent avec son choix.
    try {
        fs.accessSync(resolved, fs.constants.W_OK);
    } catch (e) {
        return { ok: false, reason: 'notWritable' };
    }

    return { ok: true, resolved };
}

/**
 * Crée le dossier s'il manque, et rend son chemin.
 *
 * Le dossier par défaut n'est pas créé au démarrage : `data/downloads` n'a
 * aucune raison d'exister tant que personne n'a téléchargé. Il naît au premier
 * usage, comme le cache.
 *
 * @param {string} dir
 * @returns {string} Le chemin, prêt à recevoir.
 */
function ensure(dir) {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/**
 * Nom de fichier sûr, dérivé d'un titre de piste.
 *
 * Un titre de morceau contient volontiers « : », « / », « ? » — tout ce qu'un
 * système de fichiers refuse, et sous Windows la liste est plus longue.
 * Remplacés plutôt que retirés : « AC/DC » doit rester lisible, pas devenir
 * « ACDC ».
 *
 * @param {string} title
 * @param {string} extension - Avec son point.
 * @returns {string}
 */
function safeFilename(title, extension) {
    const base = String(title || 'piste')
        .replace(/[\\/:*?"<>|]/g, '-')
        // Les caractères de contrôle ne se voient pas et cassent les outils qui
        // liront ce dossier ensuite.
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x1f\x7f]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        // Un point final est ignoré par Windows, ce qui ferait deux fichiers
        // impossibles à distinguer.
        .replace(/\.+$/, '')
        .slice(0, 120);

    return `${base || 'piste'}${extension}`;
}

/**
 * Chemin libre dans un dossier, en numérotant si besoin.
 *
 * Retélécharger un morceau ne doit pas écraser le précédent sans le dire : on
 * ne sait pas si l'ancien était le bon, et une bibliothèque musicale n'est pas
 * un endroit où l'on perd des fichiers en silence.
 *
 * @param {string} dir
 * @param {string} filename
 * @returns {string}
 */
function uniquePath(dir, filename) {
    const extension = path.extname(filename);
    const base = filename.slice(0, filename.length - extension.length);

    let candidate = path.join(dir, filename);
    let index = 2;
    while (fs.existsSync(candidate)) {
        candidate = path.join(dir, `${base} (${index})${extension}`);
        index++;
        // Garde-fou : un dossier contenant mille homonymes signale autre chose
        // qu'un besoin de numéroter.
        if (index > 1000) break;
    }
    return candidate;
}

/**
 * Racines de l'arborescence : les disques sous Windows, « / » ailleurs.
 *
 * Sans elles, l'explorateur est prisonnier de son point de départ. Remonter
 * depuis `C:\Users\…\data\downloads` mène à `C:\`, dont le parent est
 * lui-même : on n'atteint jamais `D:`. Sur un système de fichiers unique — Linux,
 * macOS — la question ne se pose pas, tout pend sous une seule racine.
 *
 * Les lettres sont sondées une par une, faute d'API portable. A et B sont
 * sautées : elles étaient réservées aux lecteurs de disquettes, et les sonder
 * ne rapporte jamais rien.
 */
let rootsCache = null;
let rootsCachedAt = 0;
const ROOTS_TTL_MS = 30000;

function listRoots() {
    if (process.platform !== 'win32') return ['/'];

    // Un disque réseau déconnecté fait attendre `existsSync` de longues
    // secondes. Le résultat est donc gardé un moment : parcourir une
    // arborescence enchaîne les requêtes, et les vingt-quatre sondages n'ont
    // pas à être refaits à chacune.
    const now = Date.now();
    if (rootsCache && now - rootsCachedAt < ROOTS_TTL_MS) return rootsCache;

    const found = [];
    for (let code = 'C'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code++) {
        const root = `${String.fromCharCode(code)}:\\`;
        try {
            if (fs.existsSync(root)) found.push(root);
        } catch (e) {
            // Disque protégé ou injoignable : il n'a pas sa place dans la liste.
        }
    }

    rootsCache = found;
    rootsCachedAt = now;
    return found;
}

/**
 * Premier dossier lisible en remontant depuis un chemin.
 *
 * Un dossier peut avoir disparu depuis qu'il a été choisi, ou n'avoir jamais
 * existé — c'est le cas du dossier par défaut tant que rien n'a été téléchargé.
 * Répondre « illisible » et s'arrêter là laisse l'explorateur vide, ce qui est
 * la pire des réponses : l'utilisateur n'a alors ni contenu ni moyen d'aller
 * ailleurs. On remonte donc jusqu'à trouver de quoi afficher.
 *
 * @param {string} start
 * @returns {string|null} null si même la racine se refuse.
 */
function nearestReadable(start) {
    let current = path.resolve(start);

    for (let depth = 0; depth < 64; depth++) {
        try {
            fs.readdirSync(current);
            return current;
        } catch (e) {
            const parent = path.dirname(current);
            if (parent === current) return null;
            current = parent;
        }
    }
    return null;
}

module.exports = {
    DEFAULT_DIR,
    validate,
    ensure,
    safeFilename,
    uniquePath,
    listRoots,
    nearestReadable,
};
