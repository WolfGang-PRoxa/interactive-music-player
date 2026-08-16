/**
 * paths — Utilitaires de comparaison et de nommage de chemins de pistes.
 *
 * À ne pas confondre avec mediaPaths.js, qui décide si un chemin peut être
 * servi au client. Ici, il ne s'agit que de comparer et de nettoyer.
 */

const path = require('path');

/**
 * Compare deux chemins de fichiers ou URLs en tolérant les différences
 * d'encodage, de séparateur et de casse.
 *
 * @param {string} p1
 * @param {string} p2
 * @returns {boolean}
 */
function arePathsOrUrlsEqual(p1, p2) {
    if (!p1 || !p2) return false;
    try {
        const norm1 = decodeURIComponent(p1).replace(/\\/g, '/').toLowerCase();
        const norm2 = decodeURIComponent(p2).replace(/\\/g, '/').toLowerCase();
        return norm1 === norm2;
    } catch (e) {
        return p1.replace(/\\/g, '/').toLowerCase() === p2.replace(/\\/g, '/').toLowerCase();
    }
}

/**
 * Retire le préfixe technique ajouté au stockage pour retrouver le nom
 * d'origine du fichier.
 *
 * Deux formes coexistent :
 *   - `3f2a9b1c4d5e-titre.mp3` : empreinte de contenu (stockage actuel) ;
 *   - `1712345678901-titre.mp3` : horodatage (fichiers importés avant la
 *     déduplication, toujours référencés par les playlists existantes).
 *
 * @param {string} filePath
 * @returns {string}
 */
function getCleanFilename(filePath) {
    const base = path.basename(filePath);
    return base.replace(/^(?:[0-9a-f]{12}|\d+)-/i, '');
}

module.exports = {
    arePathsOrUrlsEqual,
    getCleanFilename,
};
