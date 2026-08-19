/**
 * Format d'échange du bus de mixage.
 *
 * Tout ce qui circule entre les sources et le bus est du PCM signé 16 bits,
 * petit-boutiste, 48 kHz, deux canaux entrelacés — le format que l'encodeur
 * Opus de Discord attend en entrée. Ramener chaque source à ce format commun
 * dès sa sortie de FFmpeg est ce qui permet de superposer un MP3 128 kbps et
 * un Opus 48 kHz sans se soucier de leurs formats d'origine : à partir de là,
 * ce ne sont plus que des entiers alignés sur la même horloge.
 *
 * Le découpage en trames de 20 ms n'est pas arbitraire : c'est la cadence à
 * laquelle Discord réclame un paquet. Produire exactement une trame par tour
 * évite d'avoir à ré-aligner quoi que ce soit plus loin dans la chaîne, et
 * c'est ce qui garantit que deux sources mixées restent échantillon pour
 * échantillon en phase du début à la fin d'un fondu.
 */

/** Fréquence d'échantillonnage, en Hz. */
const SAMPLE_RATE = 48000;

/** Nombre de canaux. */
const CHANNELS = 2;

/** Taille d'un échantillon mono, en octets. */
const BYTES_PER_SAMPLE = 2;

/** Durée d'une trame, en millisecondes. */
const FRAME_DURATION_MS = 20;

/** Échantillons par canal et par trame. */
const SAMPLES_PER_FRAME = (SAMPLE_RATE * FRAME_DURATION_MS) / 1000; // 960

/** Valeurs entrelacées dans une trame (échantillons × canaux). */
const VALUES_PER_FRAME = SAMPLES_PER_FRAME * CHANNELS; // 1920

/** Taille d'une trame, en octets. */
const BYTES_PER_FRAME = VALUES_PER_FRAME * BYTES_PER_SAMPLE; // 3840

/** Octets de PCM correspondant à une milliseconde de son. */
const BYTES_PER_MS = (SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE) / 1000; // 192

/** Trame muette, réutilisable : elle n'est jamais modifiée en place. */
const SILENCE_FRAME = Buffer.alloc(BYTES_PER_FRAME);

/** Bornes d'un échantillon 16 bits signé. */
const MIN_16 = -32768;
const MAX_16 = 32767;

/**
 * Durée d'un volume d'octets de PCM, en millisecondes.
 * @param {number} octets
 * @returns {number}
 */
function bytesToMs(bytes) {
    return bytes / BYTES_PER_MS;
}

/**
 * Volume d'octets couvrant une durée, aligné sur une frontière d'échantillon.
 *
 * L'alignement importe : un décalage d'un seul octet inverserait les octets de
 * poids fort et faible de tous les échantillons suivants, et le son se
 * changerait en bruit blanc.
 *
 * @param {number} ms
 * @returns {number}
 */
function msToBytes(ms) {
    const raw = Math.round(ms * BYTES_PER_MS);
    return raw - (raw % (CHANNELS * BYTES_PER_SAMPLE));
}

module.exports = {
    SAMPLE_RATE,
    CHANNELS,
    BYTES_PER_SAMPLE,
    FRAME_DURATION_MS,
    SAMPLES_PER_FRAME,
    VALUES_PER_FRAME,
    BYTES_PER_FRAME,
    BYTES_PER_MS,
    SILENCE_FRAME,
    MIN_16,
    MAX_16,
    bytesToMs,
    msToBytes,
};
