/**
 * Restauration de l'historique de lecture d'une file discord-player.
 *
 * `queue.history.tracks` est une file **LIFO** : son `add()` insère en tête, pas
 * en queue. C'est cohérent avec l'usage normal — `history.push()` empile la piste
 * qui vient de se terminer devant les précédentes, si bien que le tableau rendu
 * par `toArray()` va de la plus récente à la plus ancienne.
 *
 * La conséquence est piégeuse pour la restauration : réinsérer un historique
 * déjà dans cet ordre élément par élément l'inverse, puisque chaque insertion
 * repasse devant la précédente. Une sauvegarde et une restauration successives
 * suffisent alors à retourner la liste, et l'aller-retour suivant la remet à
 * l'endroit.
 *
 * `add()` sur un tableau, lui, insère le bloc d'un seul tenant et conserve donc
 * l'ordre relatif des éléments. C'est ce que fait cette fonction.
 */

/**
 * Réinsère un historique sauvegardé sans en inverser l'ordre.
 *
 * @param {import('discord-player').GuildQueue} queue File cible.
 * @param {Array<object>} entries Historique sauvegardé, de la piste la plus
 *   récente à la plus ancienne — l'ordre rendu par `history.tracks.toArray()`.
 * @param {(data: object) => import('discord-player').Track} toTrack
 *   Fabrique une piste depuis une entrée sauvegardée.
 * @param {string|null} [excludeUrl] URL de la piste en cours de lecture. Une
 *   piste qui ne fait que poursuivre sa lecture n'appartient pas à l'historique :
 *   on l'écarte à la source plutôt que de l'en retirer après coup.
 * @returns {number} Nombre de pistes réinsérées.
 */
function restoreHistory(queue, entries, toTrack, excludeUrl = null) {
    if (!queue?.history?.tracks || !Array.isArray(entries) || entries.length === 0) {
        return 0;
    }

    const kept = excludeUrl
        ? entries.filter(data => data && data.url !== excludeUrl)
        : entries;

    const tracks = kept.map(toTrack).filter(Boolean);
    if (tracks.length === 0) return 0;

    // Insertion en bloc : `add(tableau)` déplie le tableau en tête de file et
    // préserve l'ordre. Un `forEach` avec `add(piste)` le retournerait.
    queue.history.tracks.add(tracks);
    return tracks.length;
}

module.exports = { restoreHistory };
