/**
 * outbound — Les adresses que le bot accepte d'aller chercher lui-même.
 *
 * ## Le problème
 *
 * Une piste porte une URL, et cette URL vient de celui qui l'a ajoutée. Le bot
 * la confie ensuite à `yt-dlp` puis à `ffmpeg`, qui la suivent sans se poser de
 * question — c'est leur travail. Or ces deux-là s'exécutent sur la machine de
 * l'hôte, donc *à l'intérieur* de son réseau.
 *
 * Un invité pourvu du seul droit d'ajouter à la file pouvait ainsi faire
 * frapper à des portes qu'il n'atteint pas lui-même : l'interface
 * d'administration du routeur, une imprimante, un service qui n'écoute que sur
 * la boucle locale, le point de métadonnées d'une machine virtuelle. Il ne voit
 * pas la réponse — rien de tout cela ne ressemble à de la musique — mais une
 * requête suffit à déclencher ce qui est au bout.
 *
 * ## L'approche
 *
 * Une adresse n'est acceptée que si elle désigne quelque chose de publiquement
 * routable. Le nom est résolu avant d'être accepté, parce que c'est là qu'est
 * la question : `interne.exemple.fr` ne ressemble à rien de suspect et peut
 * pointer sur `10.0.0.1`. On regarde donc ce vers quoi le nom mène, pas ce à
 * quoi il ressemble.
 *
 * ## Ce que ce module ne ferme pas
 *
 * Entre la vérification et la requête, le nom peut changer de réponse — c'est
 * la réattribution de nom, et elle demanderait de tenir soi-même la résolution
 * jusqu'au connecteur, ce que `yt-dlp` ne permet pas. Le garde-fou vise
 * l'usage ordinaire : l'URL posée à la main dans la boîte d'ajout, pas
 * l'infrastructure montée exprès.
 */

const dns = require('dns').promises;
const net = require('net');

/**
 * Cette adresse IPv4 sort-elle du réseau public ?
 *
 * Les plages sont celles de la RFC 1918 pour le privé, plus la boucle locale,
 * le lien-local — dont `169.254.169.254`, l'adresse de métadonnées de la
 * plupart des hébergeurs — et les quelques réservées qui traînent.
 *
 * @param {string} ip
 * @returns {boolean}
 */
function isPrivateV4(ip) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
        return true; // Illisible : on ne parie pas dessus.
    }
    const [a, b] = parts;

    if (a === 0) return true;                      // « cet hôte »
    if (a === 10) return true;                     // privé
    if (a === 127) return true;                    // boucle locale
    if (a === 169 && b === 254) return true;       // lien-local, métadonnées
    if (a === 172 && b >= 16 && b <= 31) return true; // privé
    if (a === 192 && b === 168) return true;       // privé
    if (a === 192 && b === 0) return true;         // réservé (RFC 5736/6598 voisins)
    if (a === 100 && b >= 64 && b <= 127) return true; // NAT de fournisseur
    if (a >= 224) return true;                     // multicast et réservé

    return false;
}

/**
 * Cette adresse IPv6 sort-elle du réseau public ?
 *
 * Les adresses « mappées IPv4 » — `::ffff:10.0.0.1` — sont renvoyées au test
 * IPv4, sans quoi elles feraient le tour du garde-fou par la porte de derrière.
 *
 * @param {string} ip
 * @returns {boolean}
 */
function isPrivateV6(ip) {
    const value = ip.toLowerCase().split('%')[0]; // « %eth0 » : portée d'interface

    if (value === '::' || value === '::1') return true;

    /*
     * Les deux écritures d'une IPv4 mappée, et il faut les deux.
     *
     * `::ffff:192.168.0.1` est celle qu'on écrit ; `::ffff:c0a8:1` est celle
     * que l'analyseur d'URL de Node rend, car il normalise en hexadécimal. Ne
     * connaître que la première laissait donc passer par la seconde tout le
     * réseau privé — c'est le test qui l'a montré, pas la relecture.
     */
    const pointee = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
    if (pointee) return isPrivateV4(pointee[1]);

    const hexa = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(value);
    if (hexa) {
        const haut = parseInt(hexa[1], 16);
        const bas = parseInt(hexa[2], 16);
        return isPrivateV4(`${haut >> 8}.${haut & 255}.${bas >> 8}.${bas & 255}`);
    }

    if (value.startsWith('fe80:')) return true;  // lien-local
    if (/^f[cd]/.test(value)) return true;       // unique local (fc00::/7)
    if (value.startsWith('ff')) return true;     // multicast

    return false;
}

/**
 * Cette adresse littérale est-elle hors du réseau public ?
 * @param {string} ip
 * @returns {boolean}
 */
function isPrivateAddress(ip) {
    const version = net.isIP(ip);
    if (version === 4) return isPrivateV4(ip);
    if (version === 6) return isPrivateV6(ip);
    return true; // Pas une adresse : on ne parie pas dessus.
}

/**
 * Noms qui ne sortent jamais de la machine ou du réseau local.
 *
 * La résolution les écarterait de toute façon — ils mènent à la boucle locale
 * ou à une adresse privée — mais les nommer ici évite une requête DNS, et dit
 * lisiblement ce qu'on refuse.
 */
const LOCAL_SUFFIXES = ['.local', '.localhost', '.internal', '.home', '.lan'];

/**
 * Le bot peut-il aller chercher cette adresse ?
 *
 * @param {string} rawUrl
 * @returns {Promise<{ ok: true } | { ok: false, reason: string }>}
 */
async function isFetchable(rawUrl) {
    let url;
    try {
        url = new URL(String(rawUrl));
    } catch (e) {
        return { ok: false, reason: 'adresse illisible' };
    }

    // Ni `file:`, ni `data:`, ni rien d'autre : le bot va chercher de la
    // musique sur le web, et le disque a son propre chemin (voir mediaPaths).
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return { ok: false, reason: `schéma refusé (${url.protocol})` };
    }

    // Les crochets d'une adresse IPv6 littérale ne font pas partie de l'adresse.
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!host) return { ok: false, reason: 'hôte absent' };

    if (host === 'localhost' || LOCAL_SUFFIXES.some((s) => host.endsWith(s))) {
        return { ok: false, reason: `hôte local (${host})` };
    }

    // Adresse écrite en clair : pas de résolution à faire.
    if (net.isIP(host)) {
        return isPrivateAddress(host)
            ? { ok: false, reason: `adresse non publique (${host})` }
            : { ok: true };
    }

    let resolved;
    try {
        resolved = await dns.lookup(host, { all: true });
    } catch (e) {
        // Un nom qui ne se résout pas ne mènera nulle part de toute façon ;
        // refuser ici évite seulement de le découvrir plus tard.
        return { ok: false, reason: `nom introuvable (${host})` };
    }

    // *Toutes* les réponses, et non la première : un nom qui rend une adresse
    // publique et une privée servirait sinon de passe-partout.
    for (const { address } of resolved) {
        if (isPrivateAddress(address)) {
            return { ok: false, reason: `${host} mène à ${address}` };
        }
    }

    return { ok: true };
}

module.exports = { isFetchable, isPrivateAddress, isPrivateV4, isPrivateV6 };
