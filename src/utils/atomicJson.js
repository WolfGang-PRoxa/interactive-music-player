/**
 * atomicJson — Lecture et écriture de fichiers JSON résistantes aux crashs.
 *
 * L'écriture directe par fs.writeFileSync tronque le fichier avant de le
 * réécrire : une coupure au mauvais moment laisse un JSON incomplet, donc
 * illisible et définitivement perdu. Ici, on écrit dans un fichier temporaire,
 * on force son enregistrement sur le disque (fsync), puis on le renomme par
 * dessus la cible. Le renommage est atomique : à tout instant, le fichier
 * cible est soit l'ancienne version complète, soit la nouvelle.
 */

const fs = require('fs');
const path = require('path');
const log = require('./logger');

/**
 * Construit un replacer JSON tolérant aux BigInt et aux références répétées.
 *
 * Doit être appelé pour CHAQUE sérialisation : le replacer retourné conserve un
 * état interne (les objets déjà vus) qui le rend inutilisable une seconde fois.
 *
 * Note : ce replacer écarte tout objet déjà rencontré, et pas seulement les
 * cycles réels. C'est le comportement historique du projet, conservé tel quel.
 */
function createSafeReplacer() {
    const seen = new WeakSet();
    return function replacer(key, value) {
        if (typeof value === 'bigint') {
            return value.toString();
        }
        if (typeof value === 'object' && value !== null) {
            if (seen.has(value)) {
                return;
            }
            seen.add(value);
        }
        return value;
    };
}

/**
 * Écrit un objet en JSON de façon atomique.
 * @param {string} filepath - Chemin cible
 * @param {*} data - Données à sérialiser
 * @throws {Error} Si la sérialisation ou l'écriture échoue (le fichier cible
 *   reste alors intact dans sa version précédente)
 */
function writeJsonAtomic(filepath, data) {
    const dir = path.dirname(filepath);
    fs.mkdirSync(dir, { recursive: true });

    const json = JSON.stringify(data, createSafeReplacer(), 2);

    // Le temporaire doit vivre dans le même dossier que la cible : un renommage
    // n'est atomique qu'à l'intérieur d'un même système de fichiers.
    const tmpPath = path.join(dir, `.${path.basename(filepath)}.${process.pid}.tmp`);

    let fd;
    try {
        fd = fs.openSync(tmpPath, 'w');
        fs.writeFileSync(fd, json, 'utf8');
        // Sans fsync, le renommage peut précéder l'écriture réelle des octets :
        // une coupure de courant laisserait alors un fichier vide.
        fs.fsyncSync(fd);
    } finally {
        if (fd !== undefined) {
            try { fs.closeSync(fd); } catch (e) {}
        }
    }

    try {
        fs.renameSync(tmpPath, filepath);
    } catch (err) {
        try { fs.unlinkSync(tmpPath); } catch (e) {}
        throw err;
    }
}

/**
 * Lit un fichier JSON. Si son contenu est illisible, il est mis de côté au lieu
 * d'être écrasé au prochain enregistrement, afin de rester récupérable.
 *
 * @param {string} filepath
 * @param {string} logPrefix - Préfixe des messages de log, ex. '[Database]'
 * @returns {*|null} Données lues, ou null si absent ou corrompu
 */
function readJsonSafe(filepath, logPrefix = '[atomicJson]') {
    if (!fs.existsSync(filepath)) return null;

    let raw;
    try {
        raw = fs.readFileSync(filepath, 'utf8');
    } catch (err) {
        log.error(`${logPrefix} Cannot read ${path.basename(filepath)}: ${err.message}`);
        return null;
    }

    try {
        return JSON.parse(raw);
    } catch (err) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const quarantine = `${filepath}.corrompu-${stamp}`;
        try {
            fs.renameSync(filepath, quarantine);
            log.error(`${logPrefix} ${path.basename(filepath)} is corrupted: ${err.message}`);
            log.error(`${logPrefix} File kept as ${path.basename(quarantine)}; restarting from default values.`);
        } catch (renameErr) {
            log.error(`${logPrefix} ${path.basename(filepath)} is corrupted and could not be set aside: ${renameErr.message}`);
        }
        return null;
    }
}

/**
 * Supprime les fichiers temporaires laissés par un arrêt brutal survenu en
 * pleine écriture. Sans effet sur le fichier cible, qui reste valide ; il
 * s'agit uniquement d'éviter leur accumulation dans data/.
 * @param {string} filepath - Fichier cible dont on nettoie les temporaires
 */
function cleanStaleTemp(filepath) {
    const dir = path.dirname(filepath);
    const prefix = `.${path.basename(filepath)}.`;
    try {
        for (const name of fs.readdirSync(dir)) {
            if (name.startsWith(prefix) && name.endsWith('.tmp')) {
                try { fs.unlinkSync(path.join(dir, name)); } catch (e) {}
            }
        }
    } catch (e) {
        // Dossier absent ou illisible : rien à nettoyer
    }
}

module.exports = {
    writeJsonAtomic,
    readJsonSafe,
    cleanStaleTemp,
    createSafeReplacer,
};
