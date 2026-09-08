/**
 * rangeStream — Télécharger en tranches, parce qu'un flux continu est bridé.
 *
 * ## Le problème
 *
 * Un préchargement mettait douze minutes pour un fichier de vingt-cinq. Le
 * journal montrait ffmpeg écrire environ 32 Ko/s, soit à peine deux fois le
 * temps réel, là où un transcodage MP3 tourne à cent fois.
 *
 * Ce n'était ni le disque, ni le processeur, ni le codec. La même adresse,
 * demandée par tranches, se sert à 38 Mo/s :
 *
 * ```
 *   GET simple, sans en-tête Range   →     32 754 o/s
 *   la même URL par tranches de 4 Mo → 38 000 000 o/s
 * ```
 *
 * YouTube bride un téléchargement progressif continu au débit de lecture. Ce
 * n'est pas une panne : c'est ce qu'il faut pour qu'un navigateur qui lit une
 * vidéo ne tire pas cent fois plus vite qu'il ne consomme. Mais nous ne lisons
 * pas, nous archivons — et ffmpeg, qui ouvre une seule requête et la garde
 * ouverte du début à la fin, tombe pile dans ce cas.
 *
 * ## Ce que ce module fait
 *
 * Il redemande la même adresse morceau par morceau, avec un en-tête `Range`,
 * et recoud les réponses en un flux unique. Chaque requête est courte, aucune
 * ne reste ouverte assez longtemps pour être bridée, et ffmpeg reçoit le tout
 * sur son entrée standard sans savoir d'où cela vient.
 *
 * ## Pourquoi pas simplement un fichier temporaire
 *
 * Parce que le flux permet de commencer à encoder avant la fin du
 * téléchargement, et surtout parce que le pipeline en place sait déjà recevoir
 * un flux : `resolveAudioInput` rend depuis toujours « une URL ou un flux ». Il
 * n'y a rien à réorganiser, et rien à nettoyer après coup.
 *
 * ## Ce qui est perdu, et pourquoi ce n'est pas grave
 *
 * Sur une URL, ffmpeg peut sauter au milieu du fichier sans en télécharger le
 * début — ce dont la reprise d'un encodage interrompu tirait parti. Sur une
 * entrée standard, il doit lire et jeter. Mais lire et jeter vingt-cinq mégas à
 * 38 Mo/s prend moins d'une seconde, contre les douze minutes que coûtait le
 * bridage : le compte est vite fait.
 *
 * ## Un serveur qui ne sait pas découper
 *
 * Il répond 200 au lieu de 206 et envoie tout. C'est parfaitement valide, et le
 * module s'en accommode : il verse cette réponse-là et s'arrête. Aucun appelant
 * n'a donc à savoir si la source gère les plages.
 */

const http = require('http');
const https = require('https');
const { PassThrough } = require('stream');


/**
 * Taille d'une tranche.
 *
 * Quatre mégas tiennent en mémoire sans y penser, et représentent une requête
 * d'un dixième de seconde : assez court pour passer sous le bridage, assez long
 * pour que le coût d'établissement de la connexion se noie dedans.
 */
const CHUNK_BYTES = 4 * 1024 * 1024;

/** Redirections suivies avant d'abandonner. */
const MAX_REDIRECTS = 5;

/** Reprises d'une tranche qui a échoué, avant de renoncer au flux entier. */
const RETRIES = 2;

/** Au-delà, la source ne répond plus : mieux vaut le dire que rester pendu. */
const TIMEOUT_MS = 30 * 1000;

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Une requête GET, redirections suivies.
 *
 * @param {string} url
 * @param {object} headers
 * @returns {Promise<import('http').IncomingMessage>}
 */
function request(url, headers) {
    return new Promise((resolve, reject) => {
        let restantes = MAX_REDIRECTS;

        const aller = (cible) => {
            const module = cible.startsWith('http:') ? http : https;
            const req = module.get(cible, { headers }, (res) => {
                const code = res.statusCode;

                if (code >= 300 && code < 400 && res.headers.location && restantes > 0) {
                    restantes -= 1;
                    res.resume();   // la réponse d'une redirection n'a pas de corps utile
                    aller(new URL(res.headers.location, cible).toString());
                    return;
                }
                if (code >= 400) {
                    res.resume();
                    reject(new Error(`HTTP ${code}`));
                    return;
                }
                resolve(res);
            });

            req.on('error', reject);
            req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('délai dépassé')));
        };

        aller(url);
    });
}

/**
 * Attend que la sortie redemande des octets, ou qu'elle ferme.
 *
 * `close` autant que `drain` : si l'aval a été détruit — ffmpeg qui s'arrête,
 * préchargement annulé —, personne ne viendra vider le tampon et l'attente ne
 * finirait jamais.
 *
 * Les deux écouteurs se retirent l'un l'autre, et c'est le fond de l'affaire.
 * Une course entre deux `events.once` laisse le perdant accroché : sur un
 * fichier de vingt-cinq mégas, une dizaine de tranches suffisent à faire crier
 * Node au fuite de mémoire — et il a raison.
 *
 * @param {import('stream').Writable} out
 */
function placeLibre(out) {
    return new Promise((resolve) => {
        const fini = () => {
            out.off('drain', fini);
            out.off('close', fini);
            resolve();
        };
        out.once('drain', fini);
        out.once('close', fini);
    });
}

/**
 * Verse une réponse dans la sortie, en respectant sa contre-pression.
 *
 * Sans l'attente sur `drain`, les tranches arriveraient bien plus vite que
 * ffmpeg ne les consomme et s'empileraient en mémoire — vingt-cinq mégas pour
 * un morceau, davantage pour une vidéo.
 *
 * Le compteur est passé de l'extérieur : quand la connexion casse en cours de
 * versement, l'appelant a besoin de savoir combien d'octets sont déjà partis
 * pour reprendre à la bonne place, et une valeur de retour serait perdue avec
 * l'exception.
 *
 * @param {import('stream').Readable} res
 * @param {import('stream').Writable} out
 * @param {{ recus: number }} compteur
 */
async function verser(res, out, compteur) {
    for await (const morceau of res) {
        compteur.recus += morceau.length;

        if (!out.write(morceau)) {
            await placeLibre(out);
            if (out.destroyed) {
                res.destroy();
                return;
            }
        }
    }
}

/**
 * Télécharge une adresse par tranches, et rend le tout comme un flux unique.
 *
 * @param {string} url
 * @param {object} [options]
 * @param {object} [options.headers] - En-têtes ajoutés à chaque tranche.
 * @param {number} [options.chunkBytes] - Taille d'une tranche.
 * @returns {import('stream').Readable}
 */
function chunkedFetch(url, { headers = {}, chunkBytes = CHUNK_BYTES } = {}) {
    const out = new PassThrough();

    (async () => {
        let debut = 0;
        let total = null;
        let echecs = 0;

        for (;;) {
            const compteur = { recus: 0 };

            try {
                const res = await request(url, Object.assign({}, headers, {
                    Range: `bytes=${debut}-${debut + chunkBytes - 1}`,
                }));

                // 200 : la source ne sait pas découper et envoie tout. Rien à
                // recoudre, et rien à demander de plus après celle-ci.
                if (res.statusCode === 200) {
                    await verser(res, out, compteur);
                    break;
                }

                // « bytes 0-4194303/24600694 » : le dernier nombre dit où
                // s'arrêter, et évite une requête de trop dans le vide.
                const portee = /bytes \d+-\d+\/(\d+|\*)/.exec(res.headers['content-range'] || '');
                if (portee && portee[1] !== '*') total = Number(portee[1]);

                await verser(res, out, compteur);
                echecs = 0;
            } catch (err) {
                // Ce qui est déjà parti reste acquis : on reprend après, sans
                // le redemander — le renvoyer doublerait ces octets-là dans le
                // fichier obtenu.
                debut += compteur.recus;
                echecs += 1;
                if (echecs > RETRIES) throw err;
                await pause(300 * echecs);
                continue;
            }

            debut += compteur.recus;

            if (out.destroyed) return;
            if (!compteur.recus) break;
            if (total !== null && debut >= total) break;
            // Taille inconnue : une tranche plus courte que demandée est la fin.
            if (total === null && compteur.recus < chunkBytes) break;
        }

        out.end();
    })().catch((err) => out.destroy(err));

    return out;
}

module.exports = { chunkedFetch, CHUNK_BYTES };
