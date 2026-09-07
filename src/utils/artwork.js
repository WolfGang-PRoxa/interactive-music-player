/**
 * artwork — La pochette de repli, servie par le bot plutôt que par un tiers.
 *
 * ## D'où vient le problème
 *
 * Un fichier déposé sur le disque n'a pas de pochette. `@discord-player/extractor`
 * lui en attribue une d'office, et c'est une adresse **distante** : le logo
 * iTunes hébergé sur Wikimedia. Chaque `.wav` téléversé repartait donc avec elle,
 * et elle finissait recopiée dans les playlists, la file, l'état de lecture — le
 * fichier de réglages en porte des dizaines.
 *
 * Trois choses en découlent, et aucune n'est souhaitable.
 *
 * Le tableau de bord s'utilise en réseau local, parfois sans accès à l'extérieur :
 * la pochette manque alors, et une carte de lecture montre un cadre vide pour un
 * fichier qui est pourtant sur le disque, à un mètre de là.
 *
 * Chaque affichage sollicite Wikimedia, qui décourage explicitement ce genre de
 * lien direct — et le fait pour toutes les pistes locales de la bibliothèque, à
 * chaque rendu.
 *
 * Enfin l'adresse peut mourir : un fichier renommé ou retiré là-bas, et des
 * années de bibliothèque se retrouvent sans image, sans que rien ici n'ait bougé.
 *
 * ## Ce que fait ce module
 *
 * Une substitution, et rien d'autre. Il ne fabrique pas de pochette, ne devine
 * rien : il reconnaît celle que la bibliothèque impose et lui substitue la nôtre,
 * servie depuis `public/img`.
 *
 * Elle est appliquée à la lecture comme à l'écriture. À l'écriture pour que les
 * nouvelles données cessent de porter l'adresse distante ; à la lecture parce que
 * les anciennes la portent déjà, et qu'une bibliothèque constituée ne se réécrit
 * pas sous les pieds de son propriétaire.
 */

/**
 * L'adresse que `@discord-player/extractor` attribue aux fichiers locaux.
 *
 * Codée en dur dans la bibliothèque — voir `dist/index.js` — donc ni
 * configurable ni évitable en amont. La reconnaître ici est le seul point où
 * l'on puisse s'en défaire.
 */
const REMOTE_PLACEHOLDER =
    'https://upload.wikimedia.org/wikipedia/commons/2/2a/ITunes_12.2_logo.png';

/** La même image, servie par le bot. Chemin absolu : elle est demandée depuis
 *  des pages et des contextes qui n'ont pas la même base. */
const LOCAL_PLACEHOLDER = '/img/itunes-fallback.png';

/**
 * Rend la pochette à afficher pour une piste.
 *
 * @param {string|null|undefined} thumbnail
 * @returns {string|null} `null` quand il n'y en a pas — l'interface a ses propres
 *   icônes pour ce cas, et inventer une image ici les court-circuiterait.
 */
function localise(thumbnail) {
    if (!thumbnail) return null;
    return thumbnail === REMOTE_PLACEHOLDER ? LOCAL_PLACEHOLDER : thumbnail;
}

module.exports = { localise, REMOTE_PLACEHOLDER, LOCAL_PLACEHOLDER };
