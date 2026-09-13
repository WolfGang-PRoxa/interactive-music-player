/**
 * logVisibility — Ce qu'un invité a le droit de lire du journal.
 *
 * ## Le problème
 *
 * Le terminal de logs du tableau de bord partait vers chaque socket ouverte,
 * invités compris. Il ne décrit pourtant pas la lecture en cours : il décrit la
 * machine qui l'héberge. On y lit les chemins absolus du disque, l'adresse
 * publique de l'installation, les identifiants des invités admis comme
 * refusés — et, jusqu'à ce qu'on l'en retire, le jeton qui désigne le
 * propriétaire.
 *
 * Le fermer entièrement aux invités réglait la fuite et coûtait la fonction :
 * l'onglet s'ouvrait sur une fenêtre vide, sans que rien l'explique.
 *
 * ## L'approche
 *
 * Un invité voit les lignes qui parlent de ce qu'il écoute, et rien d'autre.
 * Deux filtres en série, parce qu'aucun des deux ne suffit seul :
 *
 *  1. **l'étiquette de module** décide du sujet. `[Player]` raconte la file,
 *     `[Owner]` raconte l'installation : le premier regarde l'invité, le second
 *     non. La table est une liste blanche — une étiquette inconnue est refusée,
 *     comme un message inconnu l'est dans `permissions.js`. Un module ajouté
 *     plus tard sera donc muet pour les invités jusqu'à ce que quelqu'un l'ait
 *     relu, plutôt que bavard par accident ;
 *  2. **le caviardage** décide du contenu. Même un module autorisé verse des
 *     chemins dans ses branches d'erreur — `ENOENT ... 'C:\\Users\\…'` remonte
 *     tel quel depuis Node. L'étiquette dit le sujet de la ligne, jamais ce que
 *     l'interpolation y a mis.
 *
 * Ce module ne décide de rien d'autre. Il ne dit pas qui est maître — c'est
 * `auth.js` — ni ce qu'un invité peut commander — c'est `permissions.js`. Il
 * répond seulement à « cette ligne-ci peut-elle être montrée ? ».
 */

/**
 * Modules dont les lignes concernent la lecture, et elle seule.
 *
 * Le critère retenu : la ligne parlerait-elle encore si le bot tournait sur la
 * machine de quelqu'un d'autre ? Une piste ajoutée, un fondu enchaîné, un
 * canard qui baisse le volume — oui. Une version installée, un invité admis,
 * un tunnel monté — non, cela regarde l'installation.
 *
 * Deux absences méritent d'être dites, car elles semblent appartenir à la
 * lecture et n'en sont pas :
 *
 *  - `[Download]` annonce « ${title} written to ${written} », où `written` est
 *    un chemin du disque de l'hôte. La ligne existe pour dire *où*, c'est tout
 *    son propos : la caviarder n'en laisserait rien.
 *  - `[Play]` trace « Local file detected: ${resolvedPath} » au fil normal de
 *    son travail, pas seulement en cas d'erreur.
 *
 *  - `[PreloadManager]` mêle la progression du préchargement aux diagnostics de
 *    yt-dlp, qui citent des URL signées et des chemins de cache.
 */
const GUEST_TAGS = new Set([
    'Player',
    'MixEngine',
    'MixSource',
    'Ducking',
    'PlaybackState',
    'PlaybackSettings',
    'SilencePlayer',
]);

/**
 * Étiquette de tête d'une ligne, si elle en porte une.
 *
 * Toutes les traces du projet s'ouvrent sur `[Module]`, parfois suivi d'une
 * précision — `[WebServer Stream]`. Seul le premier mot est retenu : c'est lui
 * qui nomme le module, et faire entrer « WebServer Stream » dans la table
 * obligerait à l'y tenir à jour variante par variante.
 *
 * @param {string} text
 * @returns {string|null} L'étiquette, ou null si la ligne n'en porte pas.
 */
function tagOf(text) {
    const match = /^\[([A-Za-z0-9_-]+)(?:\s[^\]]*)?\]/.exec(String(text || ''));
    return match ? match[1] : null;
}

/**
 * Motifs caviardés avant toute sortie vers un invité.
 *
 * Ils ne cherchent pas l'exhaustivité — aucun caviardage ne l'atteint — mais
 * les deux formes qui remontent réellement : le chemin absolu, que Node place
 * dans ses messages d'erreur système, et le jeton, qui n'a plus rien à faire
 * dans une trace mais dont la disparition ne se vérifie qu'ici.
 */
const REDACTIONS = [
    // Chemin Windows : « C:\Users\… » jusqu'au prochain blanc ou guillemet.
    [/[A-Za-z]:\\[^\s"'`)]+/g, '<chemin>'],
    // Chemin UNC : « \\serveur\partage\… »
    [/\\\\[^\s"'`)]+/g, '<chemin>'],
    // Chemin POSIX, restreint aux racines qui nomment quelqu'un ou le système.
    [/\/(?:home|Users|root|etc|var|opt|srv)\/[^\s"'`)]*/g, '<chemin>'],
    // Jeton, sous la forme où il voyageait dans l'adresse d'entrée.
    [/token=[A-Za-z0-9_-]{8,}/gi, 'token=<masqué>'],
];

/**
 * Retire d'une ligne ce qui nomme la machine hôte.
 * @param {string} text
 * @returns {string}
 */
function redact(text) {
    let out = String(text || '');
    for (const [pattern, replacement] of REDACTIONS) {
        out = out.replace(pattern, replacement);
    }
    return out;
}

/**
 * Cette entrée peut-elle être montrée à un invité, et sous quelle forme ?
 *
 * @param {{ timestamp: string, level: string, text: string }} entry
 * @returns {{ timestamp: string, level: string, text: string }|null}
 *   L'entrée caviardée, ou null si elle ne le regarde pas.
 */
function forGuest(entry) {
    if (!entry || typeof entry.text !== 'string') return null;

    const tag = tagOf(entry.text);
    if (!tag || !GUEST_TAGS.has(tag)) return null;

    return { ...entry, text: redact(entry.text) };
}

/**
 * Ce qu'une socket donnée doit recevoir d'une entrée.
 *
 * Le maître lit le journal tel quel ; tout le reste passe par le filtre, y
 * compris une socket sans identité — l'incident penche alors du côté qui ne
 * coûte rien, comme dans `wsHandler.identityOf`.
 *
 * @param {{ identity?: { master?: boolean } }} client
 * @param {object} entry
 * @returns {object|null}
 */
function forClient(client, entry) {
    return client?.identity?.master ? entry : forGuest(entry);
}

/**
 * L'historique, tel que cette socket doit le recevoir.
 * @param {{ identity?: { master?: boolean } }} client
 * @param {object[]} history
 * @returns {object[]}
 */
function historyForClient(client, history) {
    const entries = Array.isArray(history) ? history : [];
    if (client?.identity?.master) return entries;

    const visible = [];
    for (const entry of entries) {
        const kept = forGuest(entry);
        if (kept) visible.push(kept);
    }
    return visible;
}

module.exports = {
    GUEST_TAGS,
    tagOf,
    redact,
    forGuest,
    forClient,
    historyForClient,
};
