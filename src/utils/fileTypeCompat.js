/**
 * Rend à `AttachmentExtractor` le `file-type` corrigé, sous le nom qu'il connaît.
 *
 * ## Le problème
 *
 * `@discord-player/extractor` 7.2.0 — la dernière publiée — impose
 * `file-type@^16.5.4`, qui boucle indéfiniment sur un ASF malformé à
 * sous-en-tête de taille nulle (GHSA-5v7r-6r5c-r473). L'extracteur appelle
 * `fileType.fromFile()` sur tout fichier local avant même de regarder son
 * extension : une boucle infinie y bloquerait le bot entier.
 *
 * La correction est en 21.3.1, et le paquet du projet l'impose par ses
 * `overrides`. Mais l'API a été renommée entre-temps : `fromFile` est devenu
 * `fileTypeFromFile`, et l'extracteur n'y trouverait plus rien.
 *
 * ## L'approche
 *
 * Poser dans `require.cache`, à l'adresse exacte où l'extracteur ira chercher
 * `file-type`, un module qui expose tout le `file-type` corrigé plus l'ancien
 * nom `fromFile`. Remplir ce cache est une possibilité documentée de Node ;
 * rien n'est réécrit dans `node_modules`.
 *
 * `file-type` 21 est un module ESM : il se charge par `require()` depuis
 * Node 22.12, le minimum du projet.
 *
 * Doit s'exécuter AVANT le premier `require('@discord-player/extractor')`, qui
 * charge `file-type` dès son ouverture.
 */

const path = require('path');
const Module = require('module');

function installFileTypeCompat() {
    const extractorEntry = require.resolve('@discord-player/extractor');
    const requireFromExtractor = Module.createRequire(extractorEntry);
    const resolved = requireFromExtractor.resolve('file-type');
    const fileType = requireFromExtractor('file-type');

    // L'ancienne API est là : l'override a été retiré, rien à faire.
    if (typeof fileType.fromFile === 'function') return false;
    if (typeof fileType.fileTypeFromFile !== 'function') {
        throw new Error(`file-type (${path.dirname(resolved)}) exposes neither fromFile nor fileTypeFromFile`);
    }

    const compat = Object.assign({}, fileType, {
        fromFile: (filePath, options) => fileType.fileTypeFromFile(filePath, options),
    });

    const shim = new Module(resolved, module);
    shim.filename = resolved;
    shim.paths = Module._nodeModulePaths(path.dirname(resolved));
    shim.exports = compat;
    shim.loaded = true;
    require.cache[resolved] = shim;
    return true;
}

module.exports = { installFileTypeCompat };
