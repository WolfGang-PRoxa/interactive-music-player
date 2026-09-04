/**
 * Niveau sonore perçu d'une piste — la mesure, la cible, et le gain qui mène
 * de l'une à l'autre.
 *
 * ## Le problème
 *
 * Deux morceaux au même volume ne s'entendent pas au même niveau. Un master
 * moderne compressé sort autour de −7 LUFS, un enregistrement classique autour
 * de −25 : quinze décibels d'écart, que le curseur de volume ne rattrape pas
 * puisqu'il agit sur les deux à la fois. C'est l'utilisateur qui rattrape, à
 * chaque changement de titre.
 *
 * ## L'approche
 *
 * Le LUFS (norme EBU R128) mesure la sonie *perçue*, pas l'amplitude : deux
 * fichiers de même LUFS s'entendent au même niveau, quelle que soit leur
 * dynamique. Chaque piste est donc mesurée une fois (cf. LoudnessAnalyzer), et
 * ce qu'on règle ensuite n'est pas un volume mais une cible : l'écart entre la
 * cible et la mesure donne un gain en décibels, appliqué à la lecture.
 *
 * Un gain positif finit par écrêter — on ne fabrique pas de la marge là où il
 * n'y en a plus. Le pic réel (« true peak », relevé par la même analyse) dit
 * combien de décibels restent avant le plafond numérique : au-delà, le son est
 * rogné, et c'est ce que `degradation()` traduit pour l'interface.
 *
 * Ce module ne connaît ni FFmpeg ni le chemin audio : il ne fait que la
 * conversion, et sert de référence commune au bus de mixage, aux gestionnaires
 * WebSocket et au tableau de bord.
 */

const database = require('../database/Database');

/**
 * Bornes du curseur, en LUFS.
 *
 * Elles sont plus larges que la musique ne l'exige, et pour une raison précise :
 * le curseur doit toujours pouvoir atteindre la mesure du fichier, seule
 * position où le gain est nul. Une plage qui n'engloberait pas les mesures
 * extrêmes rendrait le « niveau d'origine » inatteignable au curseur, sur les
 * fichiers-mêmes où l'on a le plus envie d'y revenir.
 *
 * −40 couvre les enregistrements les plus discrets — musique de chambre non
 * masterisée, ambiances. −3 couvre l'autre bout, qui n'est pas celui qu'on
 * croit : ce ne sont pas les masters compressés (−5 LUFS au plus fort) mais les
 * fichiers courts, bruitages et jingles, dont la sonie intégrée grimpe faute
 * d'assez de silence pour la faire redescendre.
 */
const TARGET_MIN = -40;
const TARGET_MAX = -3;

/** Pas du curseur, en LU. Un demi-décibel est le plus petit écart audible ici. */
const TARGET_STEP = 0.5;

/**
 * Cible de synchronisation par défaut.
 *
 * −14 LUFS est le niveau de référence des plateformes de diffusion (Spotify,
 * YouTube, Amazon) : la valeur pour laquelle la plupart des catalogues ont été
 * pensés, donc celle qui demande le moins de correction en moyenne.
 */
const DEFAULT_SYNC_TARGET = -14;

/**
 * Bornes du gain effectivement appliqué, en dB.
 *
 * La cible étant déjà bornée, ces limites ne servent qu'à contenir le cas
 * extrême — une cible haute sur un fichier très discret — où le gain
 * dépasserait 30 dB et ne produirait plus que de la distorsion.
 */
const GAIN_MIN_DB = -30;
const GAIN_MAX_DB = 18;

/**
 * Dépassement du plafond numérique, en dB, au-delà duquel l'indicateur de
 * qualité est au rouge plein.
 *
 * Douze décibels d'écrêtage ne laissent plus grand-chose du signal d'origine :
 * c'est le point où prévenir davantage n'apporte rien.
 */
const CLIP_SPAN_DB = 12;

/** Ramène une cible dans les bornes du curseur, arrondie au pas. */
function clampTarget(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return DEFAULT_SYNC_TARGET;
    const stepped = Math.round(number / TARGET_STEP) * TARGET_STEP;
    return Math.min(TARGET_MAX, Math.max(TARGET_MIN, stepped));
}

/**
 * Mesure enregistrée pour une piste, ou null si elle n'a jamais été analysée.
 * @param {string} url
 * @returns {{ measured: number, peak: number }|null}
 */
function measurement(url) {
    const entry = url ? database.getTrackLoudness(url) : null;
    if (!entry || !Number.isFinite(entry.measured)) return null;
    return {
        measured: entry.measured,
        peak: Number.isFinite(entry.peak) ? entry.peak : 0,
    };
}

/**
 * Cible en vigueur pour une piste, ou null si son niveau est laissé tel quel.
 *
 * La synchronisation est une couche par-dessus, jamais une écriture : elle
 * impose sa cible à toutes les pistes sans effacer la leur, et c'est ce qui
 * permet de la décocher pour retrouver, piste par piste, les réglages faits à
 * la main.
 *
 * @param {string} url
 * @param {object} settings - Réglages du serveur
 * @returns {number|null}
 */
function effectiveTarget(url, settings) {
    if (settings && settings.lufsSyncEnabled) {
        return clampTarget(settings.lufsSyncTarget !== undefined
            ? settings.lufsSyncTarget
            : DEFAULT_SYNC_TARGET);
    }

    const entry = url ? database.getTrackLoudness(url) : null;
    if (!entry || !Number.isFinite(entry.target)) return null;
    return clampTarget(entry.target);
}

/**
 * Gain à appliquer à une piste, en décibels.
 *
 * Vaut zéro tant que la piste n'a pas été mesurée : sans point de départ, une
 * cible ne veut rien dire, et corriger au jugé serait pire que ne rien faire.
 *
 * @param {string} url
 * @param {object} settings
 * @returns {number}
 */
function gainDb(url, settings) {
    const measure = measurement(url);
    if (!measure) return 0;

    const target = effectiveTarget(url, settings);
    if (target === null) return 0;

    return Math.min(GAIN_MAX_DB, Math.max(GAIN_MIN_DB, target - measure.measured));
}

/** Décibels → facteur multiplicatif. */
function linear(db) {
    return Math.pow(10, (Number(db) || 0) / 20);
}

/**
 * Gain multiplicatif d'une piste, prêt à être appliqué à un flux.
 * @param {string} url
 * @param {object} settings
 * @returns {number}
 */
function linearGain(url, settings) {
    return linear(gainDb(url, settings));
}

/**
 * Dégradation attendue du son, de 0 (intacte) à 1 (écrêtage franc).
 *
 * Le pic réel dit où se trouve le plafond : un fichier qui culmine à −0,8 dBTP
 * accepte 0,8 dB de gain sans qu'un seul échantillon ne soit rogné. Ce qui
 * dépasse est de l'écrêtage, et c'est lui seul qui compte — atténuer ne dégrade
 * rien, et l'indicateur doit rester vert tant qu'on descend.
 *
 * La marge est bornée à zéro par le bas, et c'est important : beaucoup de
 * masters récents dépassent déjà 0 dBTP à la lecture, les pics inter-échantillons
 * d'un MP3 décodé sortant volontiers au-dessus du plein niveau. Cette
 * dégradation-là est dans le fichier, pas dans le réglage — l'imputer au curseur
 * afficherait du rouge sur un morceau auquel on n'a rien fait.
 *
 * @param {number} db - Gain appliqué, en dB
 * @param {number} peakDb - Pic réel du fichier, en dBTP
 * @returns {number}
 */
function degradation(db, peakDb) {
    const headroom = Math.max(0, -(Number.isFinite(peakDb) ? peakDb : 0));
    const overshoot = (Number(db) || 0) - headroom;
    if (overshoot <= 0) return 0;
    return Math.min(1, overshoot / CLIP_SPAN_DB);
}

module.exports = {
    TARGET_MIN,
    TARGET_MAX,
    TARGET_STEP,
    DEFAULT_SYNC_TARGET,
    GAIN_MIN_DB,
    GAIN_MAX_DB,
    CLIP_SPAN_DB,
    clampTarget,
    measurement,
    effectiveTarget,
    gainDb,
    linear,
    linearGain,
    degradation,
};
