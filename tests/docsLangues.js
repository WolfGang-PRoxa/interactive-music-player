/**
 * Vérifie le service de la documentation multilingue — le vrai routeur d'API,
 * monté sur un port éphémère avec un `webServer` factice : les deux routes
 * concernées n'en dépendent pas.
 *
 * Ce qui se joue ici tient en trois points, dont aucun ne se voit à l'œil nu :
 *
 *  - **L'inventaire part de `docs/<langue>/`, jamais de `docs/`.** C'est la
 *    seule chose qui distingue un sommaire de documents d'un sélecteur de
 *    langue : parti de la racine partagée, il y trouve les dossiers de langue et
 *    les affiche comme des groupes — « DE / EN / ES / FR » à la place des
 *    chapitres. La langue ne se choisit que dans les réglages du tableau de
 *    bord ; le tiroir de lecture n'a pas à la proposer.
 *
 *  - **Les identifiants ne portent pas la langue.** `technique/01-architecture.md`
 *    désigne le même chapitre dans les quatre langues. C'est ce qui permet de
 *    changer de langue sans quitter sa page, et aux liens d'un document vers
 *    l'autre de se résoudre partout. Un préfixe qui reviendrait dans les
 *    identifiants casserait les deux d'un coup, sans rien casser de visible.
 *
 *  - **Rien de ce qui vient du client n'est assemblé en chemin.** La langue est
 *    comparée aux dossiers que le serveur a lui-même lus, l'identifiant à
 *    l'inventaire qu'il a lui-même construit.
 */
const express = require('express');
const http = require('http');
const path = require('path');

const createApiRouter = require(path.join(__dirname, '..', 'src', 'web', 'routes', 'api.js'));

/** Langues du tableau de bord, dans l'ordre du sélecteur des réglages. */
const LANGS = ['fr', 'en', 'es', 'de'];

/** Langue de référence : celle qui est écrite à la main, et le repli. */
const REFERENCE = 'fr';

let failed = 0;
let passed = 0;
const check = (label, ok, detail = '') => {
    if (ok) { passed++; console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`); }
    else { failed++; console.log(`  ECHEC ${label}${detail ? ` — ${detail}` : ''}`); }
};

const app = express();
app.use('/api', createApiRouter({ client: null, wss: null, inviteLink: () => null }));

const server = http.createServer(app);

server.listen(0, '127.0.0.1', async () => {
    const { port } = server.address();

    const get = (route) =>
        new Promise((resolve, reject) => {
            http.get({ host: '127.0.0.1', port, path: route }, (res) => {
                let body = '';
                res.on('data', (chunk) => (body += chunk));
                res.on('end', () => {
                    let json = null;
                    try { json = JSON.parse(body); } catch (e) {}
                    resolve({ status: res.statusCode, json });
                });
            }).on('error', reject);
        });

    const inventory = (lang) => get(`/api/docs?lang=${encodeURIComponent(lang)}`);
    const content = (id, lang) =>
        get(`/api/docs/contenu?id=${encodeURIComponent(id)}&lang=${encodeURIComponent(lang)}`);

    console.log('\n=== Inventaire par langue ===\n');

    const reference = await inventory(REFERENCE);
    check('la langue de référence répond',
        reference.status === 200 && reference.json.documents.length > 0,
        `${reference.json ? reference.json.documents.length : 0} documents`);

    const referenceIds = reference.json.documents.map((d) => d.id);

    /**
     * Groupes attendus dans le tiroir du lecteur : la racine de la langue, puis
     * son sous-dossier `technique`.
     *
     * C'est le contrôle qui manquait quand `docs/` est passé au rangement par
     * langue. L'inventaire partait encore de la racine partagée, y trouvait les
     * quatre dossiers de langue et les prenait pour des groupes : le sommaire
     * proposait « DE / EN / ES / FR » au lieu des documents, et se muait en
     * sélecteur de langue alors que la langue ne se choisit que dans les
     * réglages.
     */
    const GROUPES = ['', 'technique'];

    for (const lang of LANGS) {
        const res = await inventory(lang);
        const docs = res.json ? res.json.documents : [];
        const ids = docs.map((d) => d.id);

        check(`${lang} : le sommaire est complet`,
            res.status === 200 && ids.join(' ') === referenceIds.join(' '),
            `${ids.length} documents`);

        // Un identifiant qui recommencerait par un code de langue signalerait
        // que l'inventaire est reparti de `docs/` au lieu de `docs/<langue>/`.
        check(`${lang} : les identifiants ne portent pas la langue`,
            !ids.some((id) => LANGS.some((l) => id.startsWith(`${l}/`))),
            ids[0]);

        // Le même symptôme, vu du tiroir : aucun groupe ne doit être une langue.
        const groupes = [...new Set(docs.map((d) => d.group))].sort();
        check(`${lang} : les groupes sont ceux du sommaire, pas des langues`,
            groupes.join(' ') === GROUPES.join(' '),
            `groupes : ${groupes.map((g) => g || '(racine)').join(', ')}`);

        // Chaque document doit s'ouvrir, dans la langue demandée.
        let unreadable = 0;
        let mismatched = 0;
        for (const doc of docs) {
            const res2 = await content(doc.id, lang);
            if (res2.status !== 200 || !res2.json || !res2.json.source) unreadable++;
            else if (res2.json.lang !== lang) mismatched++;
        }
        check(`${lang} : tous les documents s'ouvrent`, unreadable === 0,
            unreadable ? `${unreadable} illisible(s)` : `${docs.length} documents`);
        check(`${lang} : la langue servie est celle demandée`, mismatched === 0);
    }

    console.log('\n=== Repli et refus ===\n');

    // Une langue que le tableau de bord ne connaît pas, une chaîne vide, et deux
    // tentatives de sortie du dossier : toutes retombent sur la référence.
    for (const bad of ['zz', '', '..', '../..', 'fr/../..']) {
        const res = await inventory(bad);
        check(`langue « ${bad} » → repli sur ${REFERENCE}`,
            res.status === 200 && res.json.lang === REFERENCE,
            res.json ? res.json.lang : String(res.status));
    }

    // L'identifiant n'est pas davantage transformé en chemin : il doit
    // correspondre à une entrée de l'inventaire, ou rien.
    for (const bad of ['../../../package.json', '../fr/GUIDE.md', '/etc/passwd', 'GUIDE.md.bak']) {
        const res = await content(bad, REFERENCE);
        check(`identifiant « ${bad} » refusé`, res.status === 404, String(res.status));
    }

    console.log(`\n=== ${passed} réussite(s), ${failed} échec(s) ===`);
    server.close();
    process.exit(failed === 0 ? 0 : 1);
});
