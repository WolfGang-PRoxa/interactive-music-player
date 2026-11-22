/**
 * mp3 — Analyse d'un fichier MP3 partiel, trame par trame.
 *
 * Un préchargement interrompu (arrêt du bot, coupure réseau) laisse sur le
 * disque un `.tmp` dont la fin est presque toujours une trame incomplète : le
 * processus a été tué au milieu d'une écriture. Pour reprendre l'encodage là
 * où il s'était arrêté, il faut deux informations que seule la lecture des
 * en-têtes donne : jusqu'à quel octet le fichier est intègre, et à quelle
 * position temporelle de la piste cet octet correspond.
 *
 * Le format s'y prête : un MP3 est une simple succession de trames, chacune
 * précédée d'un en-tête de 4 octets qui porte sa propre longueur. On avance de
 * trame en trame jusqu'à tomber sur un en-tête invalide ou une trame tronquée.
 *
 * Volontairement limité au Layer III, le seul que produise libmp3lame.
 */

const fs = require('fs');

/** Débits Layer III en kbps, indexés par les 4 bits de l'en-tête. */
const BITRATES_MPEG1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const BITRATES_MPEG2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];

/** Fréquences d'échantillonnage, indexées par les bits de version puis de fréquence. */
const SAMPLE_RATES = {
  3: [44100, 48000, 32000], // MPEG 1
  2: [22050, 24000, 16000], // MPEG 2
  0: [11025, 12000, 8000], // MPEG 2.5
};

/** Taille du tampon de lecture : environ 60 trames à 320 kbps. */
const BUFFER_SIZE = 64 * 1024;

/**
 * Longueur de l'étiquette ID3v2 en tête de fichier, s'il y en a une.
 *
 * FFmpeg en écrit une par défaut, remplie des métadonnées du conteneur source.
 * Elle n'est pas une trame audio et ferait échouer le décodage du premier
 * en-tête si on ne la sautait pas.
 *
 * @param {Buffer} buffer - Au moins les 10 premiers octets du fichier
 * @returns {number} Nombre d'octets à ignorer, 0 s'il n'y a pas d'étiquette
 */
function id3Size(buffer) {
  if (buffer.length < 10) return 0;
  if (buffer[0] !== 0x49 || buffer[1] !== 0x44 || buffer[2] !== 0x33) return 0; // « ID3 »

  // Taille sur 4 octets « synchsafe » : le bit de poids fort de chacun est
  // toujours nul, pour ne jamais imiter un motif de synchronisation.
  const size = ((buffer[6] & 0x7f) << 21) | ((buffer[7] & 0x7f) << 14) | ((buffer[8] & 0x7f) << 7) | (buffer[9] & 0x7f);

  const footer = buffer[5] & 0x10 ? 10 : 0;
  return 10 + size + footer;
}

/**
 * Décode un en-tête de trame Layer III.
 *
 * @param {Buffer} buffer
 * @param {number} offset - Décalage de l'en-tête dans le tampon
 * @returns {{ size: number, samples: number, sampleRate: number }|null}
 *   null si les 4 octets ne forment pas un en-tête Layer III exploitable
 */
function decodeHeader(buffer, offset) {
  if (offset + 4 > buffer.length) return null;

  // Synchronisation : 11 bits à 1
  if (buffer[offset] !== 0xff || (buffer[offset + 1] & 0xe0) !== 0xe0) return null;

  const version = (buffer[offset + 1] >> 3) & 0x03;
  const layer = (buffer[offset + 1] >> 1) & 0x03;
  if (version === 1) return null; // Version réservée
  if (layer !== 1) return null; // 1 = Layer III

  const bitrateIndex = (buffer[offset + 2] >> 4) & 0x0f;
  const sampleRateIndex = (buffer[offset + 2] >> 2) & 0x03;
  if (bitrateIndex === 0 || bitrateIndex === 15) return null; // Libre ou invalide
  if (sampleRateIndex === 3) return null;

  const mpeg1 = version === 3;
  const bitrate = (mpeg1 ? BITRATES_MPEG1 : BITRATES_MPEG2)[bitrateIndex] * 1000;
  const sampleRate = SAMPLE_RATES[version][sampleRateIndex];
  const padding = (buffer[offset + 2] >> 1) & 0x01;
  const samples = mpeg1 ? 1152 : 576;

  // La trame porte toujours le même nombre d'échantillons ; sa longueur en
  // octets découle donc directement du débit et de la fréquence.
  const size = Math.floor(((samples / 8) * bitrate) / sampleRate) + padding;
  if (size <= 4) return null;

  return { size, samples, sampleRate };
}

/**
 * Mesure la partie exploitable d'un fichier MP3, éventuellement tronqué.
 *
 * @param {string} filePath
 * @returns {{ bytes: number, seconds: number, sampleRate: number, frames: number }}
 *   `bytes` vaut 0 si aucune trame complète n'a pu être lue — fichier vide,
 *   absent, ou d'un format inattendu.
 */
function analyzePartial(filePath) {
  const empty = { bytes: 0, seconds: 0, sampleRate: 0, frames: 0 };

  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch (e) {
    return empty;
  }

  try {
    const fileSize = fs.fstatSync(fd).size;
    const buffer = Buffer.alloc(BUFFER_SIZE);

    let bufferBase = -1;
    let bufferBytes = 0;

    /** Garantit que `needed` octets à partir de `offset` sont dans le tampon. */
    const load = (offset, needed) => {
      if (bufferBase >= 0 && offset >= bufferBase && offset + needed <= bufferBase + bufferBytes) {
        return true;
      }
      bufferBytes = fs.readSync(fd, buffer, 0, buffer.length, offset);
      bufferBase = offset;
      return bufferBytes >= needed;
    };

    let cursor = 0;
    if (load(0, 10)) {
      cursor = id3Size(buffer);
    }

    let samples = 0;
    let sampleRate = 0;
    let frames = 0;

    while (cursor < fileSize) {
      if (!load(cursor, 4)) break;

      const header = decodeHeader(buffer, cursor - bufferBase);
      if (!header) break;

      // Trame amputée par l'interruption : elle ne compte pas, et le
      // fichier s'arrête pour nous à l'octet qui la précède.
      if (cursor + header.size > fileSize) break;

      cursor += header.size;
      samples += header.samples;
      sampleRate = header.sampleRate;
      frames++;
    }

    if (!frames || !sampleRate) return empty;

    return {
      bytes: cursor,
      seconds: samples / sampleRate,
      sampleRate,
      frames,
    };
  } catch (e) {
    return empty;
  } finally {
    try {
      fs.closeSync(fd);
    } catch (e) {}
  }
}

module.exports = {
  analyzePartial,
};
