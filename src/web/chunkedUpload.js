/**
 * chunkedUpload — Un fichier envoyé en plusieurs morceaux, recollé ici.
 *
 * ## Le problème
 *
 * Derrière un tunnel Cloudflare, une requête ne peut pas dépasser 100 Mo : c'est
 * le plafond du plan gratuit, et Cloudflare répond 413 au-delà, sans que le bot
 * n'en voie rien. Or le tableau de bord accepte des fichiers jusqu'à
 * `MAX_UPLOAD_MB` — 1 Go par défaut —, et un film ou un concert dépasse vite les
 * 100 Mo. Baisser `MAX_UPLOAD_MB` aurait retiré la fonction à qui partage son
 * tableau de bord, c'est-à-dire précisément à qui l'utilise à plusieurs.
 *
 * ## L'approche
 *
 * Le navigateur découpe le fichier (voir `handleFileUpload`, js/queue.js) et
 * envoie les morceaux l'un après l'autre, chacun bien sous le plafond. Le
 * serveur les ajoute au même fichier provisoire, dans l'ordre, et ne lui donne
 * son nom qu'une fois le dernier arrivé — exactement comme l'envoi d'un seul
 * tenant : un transfert interrompu ne laisse pas de média tronqué dans la
 * bibliothèque, et le nom dérive toujours de l'empreinte du contenu.
 *
 * La limite de `MAX_UPLOAD_MB` porte sur le total, pas sur chaque morceau : elle
 * garde son sens, quelle que soit la façon dont le fichier arrive.
 *
 * ## Ce que le découpage apporte en plus
 *
 * Une coupure ne coûte plus que le morceau en cours. Le serveur dit toujours
 * quel morceau il attend (409 avec `expected`), si bien que le navigateur
 * reprend là où il en était au lieu de tout renvoyer.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const log = require('../utils/logger');

const DEFAULT_DIR = path.join(process.cwd(), 'data', 'uploads');

/** Préfixe des transferts en cours, commun avec uploadService. */
const INCOMING_PREFIX = '.incoming-';

/** Longueur du préfixe d'empreinte apposé aux fichiers stockés (voir uploadService). */
const HASH_PREFIX_LENGTH = 12;

/**
 * Taille maximale d'un morceau.
 *
 * Sous les 100 Mo de Cloudflare, avec une marge pour les en-têtes : un morceau
 * qui frôlerait la limite serait refusé par le tunnel avant d'arriver ici. Le
 * navigateur envoie des morceaux de 64 Mo ; le serveur en tolère un peu plus.
 */
const MAX_CHUNK_BYTES = 95 * 1024 * 1024;

/** Un transfert dont aucun morceau n'arrive plus est abandonné au bout de ce délai. */
const IDLE_MS = 30 * 60 * 1000;

/** Un identifiant tiré au hasard par le navigateur : 128 bits en hexadécimal. */
const UPLOAD_ID = /^[a-f0-9]{32}$/;

/** uploadId → transfert en cours */
const sessions = new Map();

function httpError(message, statusCode, extra = {}) {
    const err = new Error(message);
    err.statusCode = statusCode;
    Object.assign(err, extra);
    return err;
}

function drop(id) {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    fs.promises.unlink(session.tmpPath).catch(() => {});
}

function purgeIdle(now = Date.now()) {
    for (const [id, session] of sessions.entries()) {
        if (!session.busy && now - session.updatedAt > IDLE_MS) {
            log.info(`[Upload] Transfer of "${session.name}" abandoned after 30 minutes of silence.`);
            drop(id);
        }
    }
}

/**
 * Donne au fichier provisoire son nom définitif, ou le jette s'il existe déjà.
 *
 * Partagé avec l'envoi d'un seul tenant : les deux chemins doivent ranger un
 * fichier de la même façon, sans quoi le même contenu prendrait deux noms
 * selon la manière dont il est arrivé.
 *
 * @param {string} tmpPath
 * @param {{ dir: string, name: string, digest: string, bytes: number }} info
 * @returns {{ filePath: string, deduplicated: boolean, bytes: number }}
 */
function settleIncoming(tmpPath, { dir, name, digest, bytes }) {
    const filePath = path.join(dir, `${digest.slice(0, HASH_PREFIX_LENGTH)}-${name}`);

    if (fs.existsSync(filePath)) {
        // Contenu déjà présent : on garde l'exemplaire existant
        fs.unlinkSync(tmpPath);
        log.info(`[Upload] "${name}" is already there, copy avoided.`);
        return { filePath, deduplicated: true, bytes };
    }

    fs.renameSync(tmpPath, filePath);
    return { filePath, deduplicated: false, bytes };
}

/**
 * Reçoit un morceau.
 *
 * @param {import('http').IncomingMessage} req
 * @param {{ uploadId: string, index: number, total: number, name: string,
 *   maxBytes: number, dir?: string }} options
 * @returns {Promise<{ done: false, next: number }
 *   | { done: true, filePath: string, deduplicated: boolean, bytes: number }>}
 * @throws {Error} avec `statusCode`, et `expected` sur un 409.
 */
async function receiveChunk(req, { uploadId, index, total, name, maxBytes, dir = DEFAULT_DIR }) {
    purgeIdle();

    if (!UPLOAD_ID.test(String(uploadId || ''))) {
        throw httpError('Identifiant de transfert invalide', 400);
    }
    if (!Number.isInteger(total) || total < 1 || total > 10000
        || !Number.isInteger(index) || index < 0 || index >= total) {
        throw httpError('Numéro de morceau invalide', 400);
    }

    let session = sessions.get(uploadId);

    if (!session) {
        // Perdu — un redémarrage du bot, un abandon pour silence — ou jamais
        // commencé : seul le premier morceau peut l'ouvrir.
        if (index !== 0) throw httpError('Transfert inconnu', 409, { expected: 0 });

        fs.mkdirSync(dir, { recursive: true });
        session = {
            name,
            total,
            dir,
            tmpPath: path.join(dir,
                `${INCOMING_PREFIX}${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`),
            hash: crypto.createHash('sha256'),
            received: 0,
            next: 0,
            busy: false,
            updatedAt: Date.now(),
        };
        fs.writeFileSync(session.tmpPath, '');
        sessions.set(uploadId, session);
    }

    if (session.name !== name || session.total !== total) {
        throw httpError('Ce morceau n\'appartient pas à ce transfert', 400);
    }
    if (session.busy) {
        throw httpError('Un morceau est déjà en cours d\'envoi', 409, { expected: session.next });
    }
    if (index !== session.next) {
        throw httpError('Morceau inattendu', 409, { expected: session.next });
    }

    session.busy = true;
    session.updatedAt = Date.now();

    /*
     * L'empreinte n'avance qu'avec un morceau complet.
     *
     * Un morceau coupé en route est renvoyé en entier : s'il avait déjà nourri
     * l'empreinte et le fichier, le contenu final porterait deux fois son
     * début. La copie de l'empreinte et la longueur d'avant permettent de
     * revenir exactement à l'état précédent.
     */
    const hash = session.hash.copy();
    const before = session.received;
    let bytes = 0;

    try {
        await new Promise((resolve, reject) => {
            const out = fs.createWriteStream(session.tmpPath, { flags: 'a' });
            let settled = false;
            const fail = (err) => {
                if (settled) return;
                settled = true;
                req.unpipe(out);
                // Attendre que le fichier soit fermé : une écriture encore en
                // vol atterrirait sinon après le retour en arrière.
                out.once('close', () => reject(err));
                out.destroy();
            };

            req.on('data', (chunk) => {
                bytes += chunk.length;
                hash.update(chunk);
                if (bytes > MAX_CHUNK_BYTES) {
                    fail(httpError('Morceau trop volumineux', 413));
                    req.destroy();
                } else if (before + bytes > maxBytes) {
                    fail(httpError(`Fichier trop volumineux (max ${Math.round(maxBytes / 1024 / 1024)} Mo)`, 413,
                        { fatal: true }));
                    req.destroy();
                }
            });
            req.on('aborted', () => fail(httpError('Transfert interrompu par le client', 400)));
            req.on('error', (err) => fail(httpError(err.message, 400)));
            out.on('error', (err) => fail(httpError(err.message, 500)));
            out.on('finish', () => {
                if (settled) return;
                settled = true;
                resolve();
            });
            req.pipe(out);
        });

        if (bytes === 0) throw httpError('Morceau vide', 400);
    } catch (err) {
        session.busy = false;
        if (err.fatal) {
            drop(uploadId);
        } else {
            // Revenir à l'état d'avant ce morceau : il sera renvoyé en entier.
            try { fs.truncateSync(session.tmpPath, before); } catch (e) { drop(uploadId); }
        }
        err.expected = sessions.has(uploadId) ? session.next : 0;
        throw err;
    }

    session.hash = hash;
    session.received = before + bytes;
    session.next += 1;
    session.busy = false;
    session.updatedAt = Date.now();

    if (session.next < session.total) return { done: false, next: session.next };

    sessions.delete(uploadId);
    try {
        const stored = settleIncoming(session.tmpPath, {
            dir: session.dir,
            name,
            digest: session.hash.digest('hex'),
            bytes: session.received,
        });
        return { done: true, ...stored };
    } catch (err) {
        fs.promises.unlink(session.tmpPath).catch(() => {});
        throw httpError(err.message, 500);
    }
}

module.exports = {
    MAX_CHUNK_BYTES,
    IDLE_MS,
    receiveChunk,
    settleIncoming,
    // Pour les tests.
    _sessions: sessions,
    _purgeIdle: purgeIdle,
};
