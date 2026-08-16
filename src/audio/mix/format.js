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
const FREQUENCE = 48000;

/** Nombre de canaux. */
const CANAUX = 2;

/** Taille d'un échantillon mono, en octets. */
const OCTETS_PAR_ECHANTILLON = 2;

/** Durée d'une trame, en millisecondes. */
const DUREE_TRAME_MS = 20;

/** Échantillons par canal et par trame. */
const ECHANTILLONS_PAR_TRAME = (FREQUENCE * DUREE_TRAME_MS) / 1000; // 960

/** Valeurs entrelacées dans une trame (échantillons × canaux). */
const VALEURS_PAR_TRAME = ECHANTILLONS_PAR_TRAME * CANAUX; // 1920

/** Taille d'une trame, en octets. */
const OCTETS_PAR_TRAME = VALEURS_PAR_TRAME * OCTETS_PAR_ECHANTILLON; // 3840

/** Octets de PCM correspondant à une milliseconde de son. */
const OCTETS_PAR_MS = (FREQUENCE * CANAUX * OCTETS_PAR_ECHANTILLON) / 1000; // 192

/** Trame muette, réutilisable : elle n'est jamais modifiée en place. */
const TRAME_SILENCE = Buffer.alloc(OCTETS_PAR_TRAME);

/** Bornes d'un échantillon 16 bits signé. */
const MIN_16 = -32768;
const MAX_16 = 32767;

/**
 * Durée d'un volume d'octets de PCM, en millisecondes.
 * @param {number} octets
 * @returns {number}
 */
function octetsVersMs(octets) {
    return octets / OCTETS_PAR_MS;
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
function msVersOctets(ms) {
    const brut = Math.round(ms * OCTETS_PAR_MS);
    return brut - (brut % (CANAUX * OCTETS_PAR_ECHANTILLON));
}

module.exports = {
    FREQUENCE,
    CANAUX,
    OCTETS_PAR_ECHANTILLON,
    DUREE_TRAME_MS,
    ECHANTILLONS_PAR_TRAME,
    VALEURS_PAR_TRAME,
    OCTETS_PAR_TRAME,
    OCTETS_PAR_MS,
    TRAME_SILENCE,
    MIN_16,
    MAX_16,
    octetsVersMs,
    msVersOctets,
};
