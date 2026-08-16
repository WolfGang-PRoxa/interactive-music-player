/**
 * Résolution d'une piste en entrée FFmpeg.
 *
 * Le bus de mixage a besoin de quelque chose que FFmpeg sache décoder : un
 * chemin de fichier, une URL, ou un flux à lui pousser sur l'entrée standard.
 * Ce module ramène n'importe quelle piste à l'une de ces trois formes.
 *
 * L'ordre des tentatives suit le coût : le cache de préchargement d'abord —
 * c'est le cas courant, puisque le bot précharge la piste en cours et les
 * suivantes —, puis le fichier local, puis seulement l'extracteur, qui suppose
 * un aller-retour réseau. Cet ordre est ce qui rend l'entrée du morceau
 * suivant disponible instantanément au moment d'amorcer un fondu enchaîné.
 */

const fs = require('fs');
const crypto = require('crypto');
const preloadManager = require('../PreloadManager');
const log = require('../../utils/logger');

/**
 * Une chaîne désigne-t-elle une adresse réseau ?
 * @param {string} valeur
 * @returns {boolean}
 */
function estUrl(valeur) {
    return typeof valeur === 'string' && /^https?:\/\//i.test(valeur);
}

/**
 * Extrait de ce que rend un extracteur la forme exploitable par FFmpeg.
 *
 * Les extracteurs ne s'accordent pas sur un type de retour : URL nue, objet
 * portant une `url`, flux lisible, ou objet enveloppant un flux.
 *
 * @param {*} brut
 * @returns {{ entree: string, flux: import('stream').Readable|null }|null}
 */
function normaliserSortieExtracteur(brut) {
    if (!brut) return null;

    if (estUrl(brut)) return { entree: brut, flux: null };
    if (estUrl(brut?.url)) return { entree: brut.url, flux: null };

    if (typeof brut?.pipe === 'function') return { entree: 'pipe:0', flux: brut };
    if (typeof brut?.stream?.pipe === 'function') return { entree: 'pipe:0', flux: brut.stream };

    return null;
}

/**
 * Chemin d'un fichier audio présent sur le disque, s'il y en a un.
 *
 * Une piste importée depuis le tableau de bord porte directement le chemin du
 * fichier dans son `url` ; une piste distante peut avoir été mise en cache par
 * le préchargement. Dans les deux cas, FFmpeg lira le disque, ce qui rend le
 * démarrage immédiat et le repositionnement exact.
 *
 * @param {object} piste
 * @returns {string|null}
 */
function cheminLocal(piste) {
    try {
        const cache = preloadManager.getCachedPath(piste);
        if (cache) return cache;
    } catch (e) {}

    const url = piste?.url;
    if (!url || estUrl(url)) return null;
    try {
        return fs.existsSync(url) ? url : null;
    } catch (e) {
        return null;
    }
}

/**
 * Interroge les extracteurs enregistrés pour obtenir le flux d'une piste.
 *
 * Le contexte d'extraction est fourni explicitement : plusieurs extracteurs le
 * lisent pour éviter de se rappeler eux-mêmes en boucle, et son absence les
 * fait échouer. C'est le même échafaudage que celui du préchargement.
 *
 * @param {object} piste
 * @param {import('discord-player').Player} player
 * @returns {Promise<{ entree: string, flux: import('stream').Readable|null }|null>}
 */
async function viaExtracteurs(piste, player) {
    if (!player?.extractors) return null;

    const tenter = async () => {
        try {
            const resultat = await player.extractors.run(async (extracteur) => {
                if (piste.extractor && extracteur.identifier !== piste.extractor.identifier) return false;
                if (await extracteur.validate(piste.url, piste.queryType)) {
                    return await extracteur.stream(piste);
                }
                return false;
            });
            return normaliserSortieExtracteur(resultat?.result);
        } catch (err) {
            log.error(`[MixEntree] Échec de l'extraction pour ${piste?.title} :`, err.message);
            return null;
        }
    };

    if (player.extractors.context?.provide) {
        let sortie = null;
        await player.extractors.context.provide({
            id: crypto.randomUUID(),
            attemptedExtractors: new Set(),
            bridgeAttemptedExtractors: new Set()
        }, async () => { sortie = await tenter(); });
        return sortie;
    }

    return tenter();
}

/**
 * Ramène une piste à une entrée que FFmpeg saura décoder.
 *
 * @param {object} piste
 * @param {import('discord-player').Player} player
 * @returns {Promise<{ entree: string, flux: import('stream').Readable|null, local: boolean }>}
 * @throws {Error} Si aucune entrée n'a pu être obtenue.
 */
async function resoudreEntree(piste, player) {
    const local = cheminLocal(piste);
    if (local) return { entree: local, flux: null, local: true };

    const distant = await viaExtracteurs(piste, player);
    if (distant) return { ...distant, local: false };

    // Dernier recours : l'URL de la piste elle-même. FFmpeg sait ouvrir une
    // adresse HTTP directe, ce qui couvre les fichiers hébergés en clair.
    if (estUrl(piste?.url)) return { entree: piste.url, flux: null, local: false };

    throw new Error(`Aucune entrée audio exploitable pour « ${piste?.title || '?'} »`);
}

module.exports = { resoudreEntree, estUrl };
