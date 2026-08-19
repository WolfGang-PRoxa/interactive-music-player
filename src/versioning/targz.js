/**
 * targz — Extraction d'une archive `.tar.gz` sans dépendance externe.
 *
 * Les archives de code source de GitHub tiennent en quelques mégaoctets : elles
 * sont décompressées en mémoire d'un bloc, puis parcourues bloc de 512 octets
 * par bloc de 512 octets. Cela évite d'ajouter une bibliothèque d'extraction au
 * projet, et surtout de dépendre d'un `tar` système dont ni la présence ni le
 * dialecte ne sont garantis d'une machine à l'autre.
 *
 * Deux points méritent l'attention :
 *
 *   - **les noms longs.** Le format ustar loge un nom sur 100 octets, complétés
 *     par un préfixe de 155. Au-delà, l'archiveur émet une entrée porteuse du
 *     nom réel juste avant l'entrée qu'elle décrit : `L` chez GNU, `x`
 *     (en-tête pax) chez les autres. GitHub emploie les deux selon les dépôts,
 *     donc les deux sont gérés ;
 *   - **la traversée de chemin.** Une entrée nommée `../../autre` sortirait du
 *     dossier de destination. Chaque chemin est donc résolu puis vérifié comme
 *     descendant strict de la destination avant la moindre écriture.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BLOCK_SIZE = 512;

/** Le bloc est-il entièrement nul ? Deux de suite marquent la fin de l'archive. */
function isEmptyBlock(block) {
    for (let i = 0; i < block.length; i++) {
        if (block[i] !== 0) return false;
    }
    return true;
}

/** Chaîne terminée par un octet nul, telle que stockée dans un en-tête tar. */
function readString(block, start, length) {
    const slice = block.subarray(start, start + length);
    const end = slice.indexOf(0);
    return slice.toString('utf8', 0, end === -1 ? slice.length : end).trim();
}

/**
 * Champ numérique d'un en-tête tar.
 *
 * Octal ASCII dans le cas courant. Les archiveurs basculent en base 256 —
 * signalée par le bit de poids fort du premier octet — pour les valeurs qui ne
 * tiennent plus en octal ; le cas ne se présente pas sur une archive de code
 * source, mais l'ignorer donnerait une taille nulle et décalerait silencieusement
 * la lecture de toute la suite de l'archive.
 */
function readNumber(block, start, length) {
    const slice = block.subarray(start, start + length);
    if (slice.length && (slice[0] & 0x80) !== 0) {
        let value = 0;
        for (let i = 1; i < slice.length; i++) value = value * 256 + slice[i];
        return value;
    }
    const text = readString(block, start, length).replace(/[^0-7]/g, '');
    if (!text) return 0;
    return parseInt(text, 8) || 0;
}

/**
 * Lit les enregistrements d'un en-tête pax et en retire le chemin, seul champ
 * qui nous intéresse. Format : `<longueur totale> <clé>=<valeur>\n`.
 */
function paxPath(data) {
    const text = data.toString('utf8');
    let position = 0;
    while (position < text.length) {
        const space = text.indexOf(' ', position);
        if (space === -1) break;
        const length = parseInt(text.slice(position, space), 10);
        if (!Number.isFinite(length) || length <= 0) break;
        const record = text.slice(space + 1, position + length - 1);
        const eq = record.indexOf('=');
        if (eq !== -1 && record.slice(0, eq) === 'path') {
            return record.slice(eq + 1);
        }
        position += length;
    }
    return null;
}

/**
 * Retire les `n` premiers segments d'un chemin d'archive.
 *
 * GitHub enveloppe tout le contenu dans un dossier `owner-repo-<sha>` : sans ce
 * retrait, la version installée serait imbriquée d'un niveau et son point
 * d'entrée introuvable.
 */
function stripComponents(entryPath, n) {
    const segments = entryPath.split('/').filter((s) => s !== '' && s !== '.');
    if (segments.length <= n) return null;
    return segments.slice(n).join('/');
}

/**
 * Décompresse et extrait une archive tar.gz.
 *
 * @param {Buffer} archive - Contenu `.tar.gz`
 * @param {string} destination - Dossier d'accueil, créé si absent
 * @param {{ retirerComposants?: number }} [options]
 * @returns {{ fichiers: number, octets: number }}
 */
function extractTarGz(archive, destination, options = {}) {
    const stripCount = options.stripComponents !== undefined ? options.stripComponents : 1;
    const root = path.resolve(destination);
    fs.mkdirSync(root, { recursive: true });

    const tar = zlib.gunzipSync(archive);

    let position = 0;
    let pendingName = null;
    let files = 0;
    let bytes = 0;

    while (position + BLOCK_SIZE <= tar.length) {
        const header = tar.subarray(position, position + BLOCK_SIZE);
        if (isEmptyBlock(header)) break;

        const typeFlag = String.fromCharCode(header[156]);
        const size = readNumber(header, 124, 12);
        position += BLOCK_SIZE;

        const data = tar.subarray(position, position + size);
        // Le contenu est complété jusqu'au bloc suivant.
        position += Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;

        // Entrées porteuses du nom de l'entrée suivante : mémorisées, jamais écrites.
        if (typeFlag === 'L') {
            pendingName = data.toString('utf8').replace(/\0+$/, '');
            continue;
        }
        if (typeFlag === 'x') {
            const entryPath = paxPath(data);
            if (entryPath) pendingName = entryPath;
            continue;
        }
        // En-tête pax global et noms de liens longs : sans objet ici.
        if (typeFlag === 'g' || typeFlag === 'K') continue;

        const prefix = readString(header, 345, 155);
        const shortName = readString(header, 0, 100);
        const rawName = pendingName || (prefix ? `${prefix}/${shortName}` : shortName);
        pendingName = null;

        // Liens matériels et symboliques : ignorés. Une archive de code source
        // n'en contient pas, et Windows exige des privilèges pour les recréer.
        if (typeFlag === '1' || typeFlag === '2') continue;
        // Périphériques et FIFO : hors sujet pour du code source.
        if (typeFlag === '3' || typeFlag === '4' || typeFlag === '6') continue;

        const relative = stripComponents(rawName, stripCount);
        if (!relative) continue;

        const target = path.resolve(root, relative);
        const insideTarget = path.relative(root, target);
        const escapes =
            !insideTarget ||
            path.isAbsolute(insideTarget) ||
            insideTarget === '..' ||
            insideTarget.startsWith(`..${path.sep}`);
        if (escapes) {
            throw new Error(`Entrée d'archive hors du dossier de destination : ${rawName}`);
        }

        if (typeFlag === '5') {
            fs.mkdirSync(target, { recursive: true });
            continue;
        }

        if (typeFlag === '0' || typeFlag === '\0' || header[156] === 0) {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, data);
            files++;
            bytes += size;
        }
    }

    if (files === 0) {
        throw new Error('Archive vide ou illisible : aucun fichier extrait.');
    }

    return { files, bytes };
}

module.exports = { extractTarGz };
