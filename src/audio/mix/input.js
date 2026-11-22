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
function isUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

/**
 * Extrait de ce que rend un extracteur la forme exploitable par FFmpeg.
 *
 * Les extracteurs ne s'accordent pas sur un type de retour : URL nue, objet
 * portant une `url`, flux lisible, ou objet enveloppant un flux.
 *
 * @param {*} raw
 * @returns {{ input: string, stream: import('stream').Readable|null }|null}
 */
function normalizeExtractorOutput(raw) {
  if (!raw) return null;

  if (isUrl(raw)) return { input: raw, stream: null };
  if (isUrl(raw?.url)) return { input: raw.url, stream: null };

  if (typeof raw?.pipe === 'function') return { input: 'pipe:0', stream: raw };
  if (typeof raw?.stream?.pipe === 'function') return { input: 'pipe:0', stream: raw.stream };

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
function localPath(track) {
  try {
    const cache = preloadManager.getCachedPath(track);
    if (cache) return cache;
  } catch (e) {}

  const url = track?.url;
  if (!url || isUrl(url)) return null;
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
 * @returns {Promise<{ input: string, stream: import('stream').Readable|null }|null>}
 */
async function viaExtractors(track, player) {
  if (!player?.extractors) return null;

  const attempt = async () => {
    try {
      const result = await player.extractors.run(async (extractor) => {
        if (track.extractor && extractor.identifier !== track.extractor.identifier) return false;
        if (await extractor.validate(track.url, track.queryType)) {
          return await extractor.stream(track);
        }
        return false;
      });
      return normalizeExtractorOutput(result?.result);
    } catch (err) {
      log.error(`[MixInput] Extraction failed for ${track?.title}:`, err.message);
      return null;
    }
  };

  if (player.extractors.context?.provide) {
    let output = null;
    await player.extractors.context.provide(
      {
        id: crypto.randomUUID(),
        attemptedExtractors: new Set(),
        bridgeAttemptedExtractors: new Set(),
      },
      async () => {
        output = await attempt();
      },
    );
    return output;
  }

  return attempt();
}

/**
 * Ramène une piste à une entrée que FFmpeg saura décoder.
 *
 * @param {object} piste
 * @param {import('discord-player').Player} player
 * @returns {Promise<{ input: string, stream: import('stream').Readable|null, local: boolean }>}
 * @throws {Error} Si aucune entrée n'a pu être obtenue.
 */
async function resolveInput(track, player) {
  const local = localPath(track);
  if (local) return { input: local, stream: null, local: true };

  const remote = await viaExtractors(track, player);
  if (remote) return { ...remote, local: false };

  // Dernier recours : l'URL de la piste elle-même. FFmpeg sait ouvrir une
  // adresse HTTP directe, ce qui couvre les fichiers hébergés en clair.
  if (isUrl(track?.url)) return { input: track.url, stream: null, local: false };

  throw new Error(`No usable audio input for « ${track?.title || '?'} »`);
}

module.exports = { resolveInput, isUrl };
