/**
 * Vérifie le téléchargement par tranches, celui qui a débridé le préchargement.
 *
 * Un préchargement mettait douze minutes pour un morceau de vingt-cinq. Ce
 * n'était ni le disque, ni le processeur, ni le codec : la même adresse,
 * demandée par tranches, se sert mille fois plus vite.
 *
 *     GET simple, sans en-tête Range   →     32 754 o/s
 *     la même URL par tranches de 4 Mo → 38 000 000 o/s
 *
 * YouTube bride un téléchargement progressif continu au débit de lecture — ce
 * qu'il faut pour qu'un navigateur qui lit ne tire pas cent fois plus vite
 * qu'il ne consomme. ffmpeg, qui ouvre une requête et la garde ouverte du début
 * à la fin, tombait pile dedans.
 *
 * Quatre choses portent le sens, et aucune ne se voit dans un diff.
 *
 *  - **Le recollement doit être exact.** Un octet perdu ou redoublé entre deux
 *    tranches ne se verrait pas à l'œil : le fichier ferait la bonne taille et
 *    le son craquerait quelque part au milieu.
 *
 *  - **Une coupure en cours de tranche reprend où elle s'est arrêtée**, et non
 *    au début de la tranche. Redemander une plage déjà à moitié versée
 *    doublerait ces octets-là dans le fichier obtenu.
 *
 *  - **La contre-pression est respectée.** Sans elle, les tranches arriveraient
 *    bien plus vite que ffmpeg ne les consomme et s'empileraient en mémoire.
 *    Et l'attendre naïvement — une course entre deux `once` — laisse un
 *    écouteur accroché par tranche, ce que Node finit par signaler.
 *
 *  - **Un serveur qui ignore les plages reste servi.** Il répond 200 et envoie
 *    tout : c'est valide, et aucun appelant n'a à savoir lequel des deux cas
 *    il a en face.
 *
 * Tout se passe contre un serveur HTTP local : aucune dépendance au réseau, et
 * les cas de coupure sont provoqués pour de vrai plutôt que simulés.
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const { chunkedFetch } = require(path.join(ROOT, 'src', 'audio', 'rangeStream.js'));

let failed = 0;
let passed = 0;
const check = (label, ok, detail = '') => {
    if (ok) { passed++; console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`); }
    else { failed++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
};

/** Un corps reconnaissable : toute permutation ou répétition se voit. */
const CORPS = crypto.randomBytes(300 * 1024);
const EMPREINTE = crypto.createHash('sha256').update(CORPS).digest('hex');

const digest = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * Ouvre un serveur local et rend son adresse.
 *
 * @param {function} handler
 * @returns {Promise<{ url: string, close: function, demandes: string[] }>}
 */
function servir(handler) {
    const demandes = [];
    const server = http.createServer((req, res) => {
        demandes.push(req.headers.range || '(aucune plage)');
        handler(req, res, demandes.length);
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve({
                url: `http://127.0.0.1:${server.address().port}/f.bin`,
                demandes,
                close: () => new Promise((ok) => server.close(ok)),
            });
        });
    });
}

/** Le comportement normal : plages honorées. */
function parPlages(req, res) {
    const plage = /bytes=(\d+)-(\d+)?/.exec(req.headers.range || '');
    if (!plage) {
        res.writeHead(200, { 'content-length': CORPS.length });
        res.end(CORPS);
        return;
    }
    const debut = Number(plage[1]);
    const fin = Math.min(plage[2] ? Number(plage[2]) : CORPS.length - 1, CORPS.length - 1);

    if (debut >= CORPS.length) {
        res.writeHead(416, { 'content-range': `bytes */${CORPS.length}` });
        res.end();
        return;
    }
    res.writeHead(206, {
        'content-range': `bytes ${debut}-${fin}/${CORPS.length}`,
        'content-length': fin - debut + 1,
    });
    res.end(CORPS.slice(debut, fin + 1));
}

/** Vide un flux en mémoire. */
function recueillir(flux) {
    return new Promise((resolve, reject) => {
        const bouts = [];
        flux.on('data', (c) => bouts.push(c));
        flux.on('end', () => resolve(Buffer.concat(bouts)));
        flux.on('error', reject);
    });
}

(async () => {
    console.log('\n=== Le téléchargement par tranches ===\n');

    // ───────────────────── Le recollement ─────────────────────

    console.log('Ce qui sort doit être ce qui est entré\n');

    {
        const s = await servir(parPlages);
        const recu = await recueillir(chunkedFetch(s.url, { chunkBytes: 64 * 1024 }));
        await s.close();

        check('le fichier arrive entier', recu.length === CORPS.length,
            `${recu.length} octets sur ${CORPS.length}`);
        check('  … et octet pour octet', digest(recu) === EMPREINTE,
            'un octet perdu entre deux tranches ne se verrait pas à la taille');
        check('il a bien été demandé par morceaux', s.demandes.length >= 4,
            `${s.demandes.length} requêtes`);
        check('  … chacune avec sa plage',
            s.demandes.every((d) => d.startsWith('bytes=')),
            'c\'est la plage, et elle seule, qui échappe au bridage');

        // Les plages doivent s'enchaîner sans trou ni recouvrement.
        const debuts = s.demandes.map((d) => Number(/bytes=(\d+)/.exec(d)[1]));
        check('  … et les plages s\'enchaînent sans se recouvrir',
            debuts.every((v, i) => i === 0 ? v === 0 : v === debuts[i - 1] + 64 * 1024),
            debuts.join(', '));
    }

    {
        // Une tranche plus grande que le fichier : une seule requête, et la fin
        // doit être reconnue sans en demander une de plus dans le vide.
        const s = await servir(parPlages);
        const recu = await recueillir(chunkedFetch(s.url, { chunkBytes: 4 * 1024 * 1024 }));
        await s.close();

        check('une tranche plus large que le fichier suffit',
            digest(recu) === EMPREINTE && s.demandes.length === 1,
            `${s.demandes.length} requête(s)`);
    }

    // ───────────────────── Le serveur qui ignore les plages ─────────────────────

    console.log('\nUne source qui ne sait pas découper\n');

    {
        const s = await servir((req, res) => {
            res.writeHead(200, { 'content-length': CORPS.length });
            res.end(CORPS);
        });
        const recu = await recueillir(chunkedFetch(s.url, { chunkBytes: 64 * 1024 }));
        await s.close();

        check('un 200 est servi tel quel', digest(recu) === EMPREINTE);
        check('  … et rien n\'est redemandé après lui', s.demandes.length === 1,
            'la réponse contenait déjà tout');
    }

    // ───────────────────── La coupure ─────────────────────

    console.log('\nQuand la connexion casse au milieu\n');

    {
        let coupee = false;
        const s = await servir((req, res) => {
            const debut = Number(/bytes=(\d+)/.exec(req.headers.range)[1]);

            // La deuxième tranche est tranchée en deux : en-têtes annoncés, la
            // moitié envoyée, puis la prise arrachée.
            if (debut === 64 * 1024 && !coupee) {
                coupee = true;
                res.writeHead(206, {
                    'content-range': `bytes ${debut}-${debut + 65535}/${CORPS.length}`,
                    'content-length': 65536,
                });
                // La prise n'est arrachée qu'une fois ces octets réellement
                // partis. Les détruire avant les laisserait dans le tampon du
                // serveur : le client n'en verrait aucun, redemanderait la
                // tranche entière, et le test ne prouverait rien.
                res.write(CORPS.slice(debut, debut + 30000), () => {
                    setTimeout(() => res.socket.destroy(), 30);
                });
                return;
            }
            parPlages(req, res);
        });

        const recu = await recueillir(chunkedFetch(s.url, { chunkBytes: 64 * 1024 }));
        await s.close();

        check('la coupure ne perd pas d\'octets', recu.length === CORPS.length,
            `${recu.length} sur ${CORPS.length}`);
        check('  … et n\'en redouble aucun', digest(recu) === EMPREINTE,
            'reprendre au début de la tranche doublerait ce qui était déjà versé');

        const reprise = s.demandes.find((d, i) => i > 1 && d === `bytes=${64 * 1024 + 30000}-${64 * 1024 + 30000 + 65535}`);
        check('  … la reprise repart de l\'octet suivant', !!reprise,
            reprise || s.demandes.join(' | '));
    }

    {
        // Une source qui ne répond jamais correctement : l'échec doit remonter,
        // et non laisser un flux ouvert que personne ne terminera.
        const s = await servir((req, res) => {
            res.writeHead(500);
            res.end();
        });

        let erreur = null;
        try { await recueillir(chunkedFetch(s.url, { chunkBytes: 64 * 1024 })); }
        catch (e) { erreur = e; }
        await s.close();

        check('une source en panne fait échouer le flux', !!erreur,
            erreur ? erreur.message : 'aucune erreur');
        check('  … après avoir réessayé', s.demandes.length === 3,
            `${s.demandes.length} tentatives`);
    }

    // ───────────────────── La contre-pression ─────────────────────

    console.log('\nCe qui empêche la mémoire de gonfler\n');

    {
        const avertissements = [];
        const surAvertissement = (w) => avertissements.push(w.name);
        process.on('warning', surAvertissement);

        const s = await servir(parPlages);
        const flux = chunkedFetch(s.url, { chunkBytes: 8 * 1024 });

        /*
         * Un consommateur lent, qui force une attente à presque chaque tranche.
         *
         * C'est le cas réel : ffmpeg encode moins vite que le réseau ne sert.
         * C'est aussi celui qui révélait la fuite — une course entre deux
         * `once` laissait un écouteur accroché par tranche.
         */
        const bouts = [];
        const compter = () => flux.listenerCount('drain') + flux.listenerCount('close');
        const depart = compter();
        let maxEcouteurs = 0;
        let tranches = 0;
        for await (const morceau of flux) {
            bouts.push(morceau);
            tranches += 1;
            maxEcouteurs = Math.max(maxEcouteurs, compter());
            await new Promise((r) => setTimeout(r, 1));
        }
        const arrivee = compter();
        await s.close();

        // Le temps que Node émette ce qu'il a à émettre.
        await new Promise((r) => setImmediate(r));
        process.off('warning', surAvertissement);

        check('le fichier passe entier malgré un lecteur lent',
            digest(Buffer.concat(bouts)) === EMPREINTE);
        /*
         * Ce qui compte n'est pas le nombre, c'est qu'il ne suive pas les
         * tranches. Une fuite d'un écouteur par tranche donnerait ici la
         * quarantaine de morceaux échangés ; une poignée constante, non.
         */
        check('les écouteurs ne suivent pas le nombre de tranches',
            maxEcouteurs < tranches / 4,
            `${maxEcouteurs} au plus, sur ${tranches} tranches`);
        check('  … et rien ne reste accroché à la fin', arrivee <= depart + 1,
            `${depart} au départ, ${arrivee} à l'arrivée`);
        check('  … et Node ne crie pas à la fuite',
            !avertissements.includes('MaxListenersExceededWarning'),
            avertissements.join(', ') || 'aucun avertissement');
    }

    {
        // L'aval détruit — ffmpeg qui s'arrête, préchargement annulé : la boucle
        // doit s'arrêter, et non continuer d'appeler un serveur pour un tampon
        // que plus personne ne vide.
        const s = await servir(parPlages);
        const flux = chunkedFetch(s.url, { chunkBytes: 8 * 1024 });

        flux.once('data', () => flux.destroy());
        await new Promise((r) => setTimeout(r, 250));
        const apresDestruction = s.demandes.length;
        await new Promise((r) => setTimeout(r, 250));
        await s.close();

        check('un flux détruit cesse de demander',
            s.demandes.length === apresDestruction,
            `${s.demandes.length} requêtes, stables`);
    }

    // ───────────────────── Le raccordement ─────────────────────

    console.log('\nCe qui tient les deux bouts\n');

    {
        const PRELOAD = fs.readFileSync(
            path.join(ROOT, 'src', 'audio', 'PreloadManager.js'), 'utf8');

        check('le préchargement passe par les tranches',
            /require\('\.\/rangeStream'\)\.chunkedFetch\(chosen\.url/.test(PRELOAD));
        check('  … et ne tend plus l\'adresse à ffmpeg',
            /ffmpegInput = null;/.test(PRELOAD)
            && !/ffmpegInput = chosen\.url/.test(PRELOAD),
            'une requête continue est bridée au débit de lecture');

        /*
         * Le flux de l'extracteur est abandonné au profit des tranches : le
         * laisser ouvert retiendrait sa connexion et ses tampons jusqu'à la fin
         * du préchargement.
         */
        check('le flux remplacé est refermé',
            /inputStream\.destroy\(\);/.test(PRELOAD));

        /*
         * `stream` existait, `cleanup` le détruisait, et rien ne le lui donnait
         * jamais. Anodin pour un flux que la rupture du tuyau faisait tomber ;
         * pas pour une boucle de tranches, qui continuerait de remplir un
         * tampon que plus personne ne vide.
         */
        check('l\'annulation atteint la source',
            /stream = inputStream;/.test(PRELOAD)
            && /if \(stream\) stream\.destroy\(\);/.test(PRELOAD),
            'sinon la boucle de tranches survivrait à ffmpeg');
    }

    console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
    process.exit(failed > 0 ? 1 : 0);
})();
