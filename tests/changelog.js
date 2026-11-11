/**
 * Vérifie le journal des modifications — son format, son service, et la parité
 * de ses deux langues.
 *
 * Trois choses s'y cassent en silence, et aucune ne se voit à la relecture.
 *
 *  - **Le format.** Le fichier est du Markdown, mais tout n'y est pas libre :
 *    une date mal écrite, un mot-clé de section mal orthographié, un tiret
 *    oublié, et l'entrée disparaît de la fenêtre sans que rien ne le signale.
 *    Le parseur est donc éprouvé sur une source de laboratoire, qui porte
 *    exactement les pièges du vrai fichier : un commentaire HTML qui décrit le
 *    format — et qui ne doit être compté ni comme livraison ni comme entrée —,
 *    une entrée sur deux lignes, un résumé sur deux lignes, une livraison sans
 *    titre, une catégorie inconnue.
 *
 *  - **La parité des langues.** Le journal est écrit à la main en français et en
 *    anglais. Une livraison ajoutée d'un côté et pas de l'autre, une entrée
 *    oubliée dans la traduction : le lecteur anglais lit alors une histoire
 *    incomplète, et rien ne le dit. Même discipline que `docsIntegrity.js` pour
 *    la documentation, et même méthode — on compare les charpentes, pas la prose.
 *
 *  - **Le repli de langue.** Les deux autres langues du tableau de bord n'ont pas
 *    de journal ; elles doivent recevoir l'anglais, et non une erreur ni un
 *    fichier pris ailleurs sur le disque.
 */
const express = require('express');
const http = require('http');
const path = require('path');

const createApiRouter = require(path.join(__dirname, '..', 'src', 'web', 'routes', 'api.js'));
const changelog = require(path.join(__dirname, '..', 'src', 'web', 'changelog.js'));

/** Langues du tableau de bord, dans l'ordre du sélecteur des réglages. */
const LANGS = ['fr', 'en', 'es', 'de'];

/** Langues dans lesquelles le journal est écrit à la main. */
const WRITTEN = ['fr', 'en'];

let failed = 0;
let passed = 0;
const check = (label, ok, detail = '') => {
    if (ok) { passed++; console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`); }
    else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

/* ═════════════════════════ Le format ═════════════════════════ */

console.log('\n=== Format du fichier ===\n');

const LAB = [
    '# Titre du journal',
    '',
    'Une introduction.',
    '',
    '<!--',
    '    ## 2020-01-01 — Ceci n\'est pas une livraison',
    '    - et ceci n\'est pas une entrée',
    '-->',
    '',
    '## 2026-02-02 — Deuxième',
    'Résumé sur',
    'deux lignes.',
    '',
    '### Added',
    '- Une entrée',
    '  qui continue à la ligne.',
    '',
    '### Wobble',
    '- Catégorie inconnue.',
    '',
    '## 2026-01-01',
    '',
    '### Fixed',
    '- Sans titre de livraison.',
    '',
    '### Added',
    '- Rangée après « Fixed » dans le fichier.',
    '',
].join('\n');

const lab = changelog.parse(LAB);

check('le titre du journal est lu', lab.title === 'Titre du journal', lab.title);
check('l\'introduction est lue', lab.intro === 'Une introduction.', lab.intro);
check('deux livraisons, quatre entrées',
    lab.releases.length === 2 && lab.count === 4,
    `${lab.releases.length} livraison(s), ${lab.count} entrée(s)`);

// Le commentaire HTML porte une fausse date et une fausse entrée : ni l'une ni
// l'autre ne doit avoir franchi le parseur.
check('le commentaire HTML ne produit ni livraison ni entrée',
    !lab.releases.some((r) => r.date === '2020-01-01'),
    lab.releases.map((r) => r.date).join(', '));

const second = lab.releases[0];
check('la première livraison est la première du fichier', second.date === '2026-02-02', second.date);
check('le titre de livraison est lu', second.title === 'Deuxième', second.title);
check('un résumé sur deux lignes est recollé',
    second.summary === 'Résumé sur deux lignes.', second.summary);
check('une entrée sur deux lignes est recollée',
    second.groups[0].entries[0] === 'Une entrée qui continue à la ligne.',
    second.groups[0].entries[0]);

// Un mot-clé inconnu doit se voir dans la fenêtre — donc survivre au parseur —
// et passer après les catégories connues.
check('une catégorie inconnue survit, et passe en dernier',
    second.groups.length === 2 && second.groups[1].kind === 'wobble',
    second.groups.map((g) => g.kind).join(' → '));

const first = lab.releases[1];
check('une livraison sans titre reste une livraison',
    first.date === '2026-01-01' && first.title === '',
    `« ${first.title} »`);
check('les catégories sont rendues dans l\'ordre de KINDS, pas dans celui du fichier',
    first.groups.map((g) => g.kind).join(' ') === 'added fixed',
    first.groups.map((g) => g.kind).join(' → '));

/* ═════════════════════════ Le service ═════════════════════════ */

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

    const journal = (lang) => get(`/api/changelog?lang=${encodeURIComponent(lang)}`);

    console.log('\n=== Service et parité des langues ===\n');

    const reference = await journal('fr');
    check('le journal de référence répond',
        reference.status === 200 && reference.json && reference.json.releases.length > 0,
        `${reference.json ? reference.json.releases.length : 0} livraison(s)`);

    /** Charpente d'un journal : dates, catégories, nombres — jamais la prose. */
    const skeleton = (payload) =>
        payload.releases
            .map((release) => `${release.date} [${release.groups.map((g) => `${g.kind}:${g.entries.length}`).join(' ')}]`)
            .join('\n');

    const referenceSkeleton = skeleton(reference.json);

    for (const lang of WRITTEN) {
        const res = await journal(lang);
        const payload = res.json;

        check(`${lang} : le journal est servi dans la langue demandée`,
            res.status === 200 && payload.lang === lang,
            payload ? payload.lang : String(res.status));

        check(`${lang} : mêmes dates, mêmes catégories, mêmes nombres d'entrées`,
            skeleton(payload) === referenceSkeleton,
            `${payload.releases.length} livraison(s), ${payload.count} entrée(s)`);

        check(`${lang} : le journal annonce les deux langues écrites`,
            Array.isArray(payload.langs) && payload.langs.join(' ') === [...WRITTEN].sort().join(' '),
            (payload.langs || []).join(', '));

        // Une livraison vide n'a rien à annoncer, et une entrée vide est une
        // ligne de tiret oubliée dans le fichier.
        const hollow = payload.releases.filter((r) => r.count === 0);
        check(`${lang} : aucune livraison vide`, hollow.length === 0,
            hollow.map((r) => r.date).join(', '));

        const blank = payload.releases.filter((r) =>
            r.groups.some((g) => g.entries.some((entry) => !entry.trim())));
        check(`${lang} : aucune entrée vide`, blank.length === 0,
            blank.map((r) => r.date).join(', '));

        // Une date mal écrite ne serait pas reconnue comme livraison — mais une
        // date valable et fantaisiste, si : le sommaire la rangerait dans un mois
        // qui n'existe pas dans l'histoire du dépôt.
        const badDate = payload.releases.filter((r) => !/^\d{4}-\d{2}-\d{2}$/.test(r.date));
        check(`${lang} : toutes les dates sont au format ISO`, badDate.length === 0,
            badDate.map((r) => r.date).join(', '));

        // Le journal se lit du plus récent au plus ancien, et la fenêtre s'y fie :
        // elle marque la première livraison comme la dernière livrée, et groupe
        // les dates par mois dans l'ordre où elles viennent.
        const dates = payload.releases.map((r) => r.date);
        const descending = [...dates].sort().reverse();
        check(`${lang} : les livraisons vont de la plus récente à la plus ancienne`,
            dates.join(' ') === descending.join(' '),
            `${dates[0]} → ${dates[dates.length - 1]}`);

        // Un mot-clé mal orthographié passe le parseur — c'est voulu, il doit se
        // voir — mais n'aurait ni libellé traduit ni couleur dans la fenêtre.
        const unknown = new Set();
        for (const release of payload.releases) {
            for (const group of release.groups) {
                if (!changelog.KINDS.includes(group.kind)) unknown.add(group.kind);
            }
        }
        check(`${lang} : toutes les catégories sont connues du tableau de bord`,
            unknown.size === 0, [...unknown].join(', '));
    }

    console.log('\n=== Repli de langue ===\n');

    /*
     * Les deux autres langues du tableau de bord n'ont pas de journal : elles
     * reçoivent celui de la référence. Les chaînes qui suivent ne sont pas de la
     * validation d'entrée — la langue n'est jamais assemblée en chemin, elle est
     * comparée aux fichiers que le serveur a lui-même lus — mais la preuve que
     * rien d'autre ne peut être ouvert par ce paramètre.
     */
    for (const bad of ['es', 'de', 'zz', '', '..', '../..', 'fr/../..', '../../package']) {
        const res = await journal(bad);
        check(`langue « ${bad} » → repli sur ${changelog.REFERENCE_LANG}`,
            res.status === 200 && res.json.lang === changelog.REFERENCE_LANG
                && res.json.releases.length > 0,
            res.json ? res.json.lang : String(res.status));
    }

    // Vu du tableau de bord : une langue non écrite doit pouvoir être signalée,
    // donc se distinguer de celle qui a été demandée.
    const spanish = await journal('es');
    check('une langue non écrite se reconnaît à la réponse',
        spanish.json.lang !== 'es' && spanish.json.langs.includes(spanish.json.lang),
        `servi en ${spanish.json.lang}`);

    await checkRendering();

    console.log(`\n=== ${passed} passed, ${failed} failed ===`);
    server.close();
    process.exit(failed === 0 ? 0 : 1);
});

/* ═════════════════════════ La fenêtre ═════════════════════════ */

/**
 * Éprouve le rendu dans un DOM simulé, avec la vraie page et les vrais modules.
 *
 * Ce que cela attrape et que rien d'autre ne verrait : un identifiant renommé
 * dans la page sans l'être dans le module — les deux fichiers ne se relisent pas
 * l'un l'autre —, une catégorie qui perdrait sa couleur faute d'attribut, un
 * filtre qui laisserait passer ce qu'il doit écarter, une recherche qui
 * surlignerait à l'intérieur d'une balise.
 *
 * `jsdom` n'est pas une dépendance déclarée du projet : il arrive avec
 * `discord-player-youtubei`. La section se retire donc d'elle-même s'il n'est pas
 * là, plutôt que de faire échouer une suite pour un outil qui n'a jamais été
 * demandé.
 */
async function checkRendering() {
    console.log('\n=== La fenêtre, dans un DOM simulé ===\n');

    let JSDOM;
    try {
        ({ JSDOM } = require('jsdom'));
    } catch (e) {
        console.log('  passé — jsdom absent de cette installation');
        return;
    }

    const fs = require('fs');
    const vm = require('vm');
    const ROOT = path.join(__dirname, '..');
    const html = fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'index.html'), 'utf8');

    // La vraie page, sans ses scripts : ils réclameraient tout le tableau de
    // bord. Les deux qui nous intéressent sont injectés à la main, plus bas.
    const dom = new JSDOM(html, { runScripts: 'outside-only' });
    const win = dom.window;

    /*
     * jsdom ne met rien en page : il n'a donc pas de défilement à offrir, et
     * `scrollTo` lui manque. Le module s'en sert pour amener une livraison sous
     * les yeux — un geste qui n'a pas de sens sans géométrie, mais qui ne doit
     * pas lever d'exception ici.
     */
    win.Element.prototype.scrollTo = function () {};
    win.Element.prototype.scrollBy = function () {};

    const dictionary = JSON.parse(
        fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'locales', 'fr.json'), 'utf8'));

    win.MusicPlayer = {
        dashboardSettings: { language: 'fr' },
        // Même résolution que `window.MusicPlayer.t` de js/state.js : la clé
        // elle-même quand la traduction manque.
        t: (key) => dictionary[key] || key,
    };

    /** Le journal, servi au module comme le fait la route. */
    let servedLang = 'fr';
    win.fetch = async () => ({
        ok: true,
        json: async () => ({ ...changelog.read(servedLang), langs: changelog.availableLangs() }),
    });

    for (const file of ['docs.js', 'changelog.js']) {
        const source = fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'js', file), 'utf8');
        vm.runInContext(source, dom.getInternalVMContext(), { filename: file });
    }

    check('le module emprunte le rendu Markdown de la documentation',
        typeof win.MusicPlayer.docsRendu.inline === 'function');

    await win.MusicPlayer.openChangelogModal();

    const $ = (selector) => win.document.querySelectorAll(selector);
    const reference = changelog.read('fr');

    check('la fenêtre s\'ouvre',
        !win.document.getElementById('changelog-modal').classList.contains('hidden'));

    check('une section par livraison, une ligne par entrée',
        $('.changelog-release').length === reference.releases.length
            && $('.changelog-entry').length === reference.count,
        `${$('.changelog-release').length} section(s), ${$('.changelog-entry').length} ligne(s)`);

    const sections = [...$('.changelog-release')];
    check('la livraison la plus récente est la première, et seule marquée',
        sections[0].dataset.date === reference.releases[0].date
            && sections.filter((s) => s.classList.contains('latest')).length === 1
            && sections[0].querySelector('.changelog-release-badge') !== null,
        sections[0].dataset.date);

    check('chaque date est écrite en toutes lettres, dans la langue du tableau de bord',
        sections[0].querySelector('.changelog-release-date').textContent === '11 novembre 2026',
        sections[0].querySelector('.changelog-release-date').textContent);

    // La couleur d'une catégorie est portée par l'attribut, pas par la classe :
    // sans lui, le badge et les puces retombent au gris par défaut.
    const kinds = new Set([...$('.changelog-group')].map((g) => g.dataset.kind));
    check('chaque groupe porte sa catégorie en attribut',
        !kinds.has(undefined) && [...kinds].every((kind) => changelog.KINDS.includes(kind)),
        [...kinds].join(', '));

    check('le sommaire groupe les dates par mois',
        $('.changelog-toc-group').length === 3
            && $('.changelog-toc-entry').length === reference.releases.length,
        `${$('.changelog-toc-group').length} mois, ${$('.changelog-toc-entry').length} dates`);

    check('une seule livraison est désignée comme celle qu\'on lit',
        $('.changelog-toc-entry.current').length === 1);

    check('l\'ouverture du journal paraît en tête de la frise',
        $('.changelog-lead').length === 1
            && $('.changelog-lead')[0].textContent === reference.intro,
        $('.changelog-lead')[0] ? `${$('.changelog-lead')[0].textContent.slice(0, 40)}…` : '(absente)');

    const totalSecurity = reference.releases
        .reduce((n, r) => n + r.groups.filter((g) => g.kind === 'security')
            .reduce((m, g) => m + g.entries.length, 0), 0);

    /* ── Les filtres ── */

    const chip = (kind) => [...$('.changelog-chip')].find((c) => c.dataset.kind === kind);

    check('une pastille par catégorie présente, plus « tout »',
        $('.changelog-chip').length === kinds.size + 1,
        `${$('.changelog-chip').length} pastilles`);

    chip('security').click();
    check('le filtre ne laisse que sa catégorie',
        $('.changelog-entry').length === totalSecurity
            && [...$('.changelog-group')].every((g) => g.dataset.kind === 'security'),
        `${$('.changelog-entry').length} entrée(s) de sécurité`);

    // L'ouverture décrit le journal entier : au-dessus d'une sélection, elle
    // annoncerait autre chose que ce qui suit.
    check('l\'ouverture se retire sous un filtre', $('.changelog-lead').length === 0);

    check('le sommaire suit le filtre',
        $('.changelog-toc-entry').length
            === reference.releases.filter((r) => r.groups.some((g) => g.kind === 'security')).length,
        `${$('.changelog-toc-entry').length} date(s)`);

    // Les comptes des pastilles décrivent le journal, pas la vue : ils ne
    // doivent pas bouger sous un filtre.
    check('les comptes des pastilles ne bougent pas',
        chip('security').querySelector('.changelog-chip-count').textContent === String(totalSecurity),
        chip('security').querySelector('.changelog-chip-count').textContent);

    // Deux catégories cochées valent leur somme : le filtre est un choix
    // multiple, pas un bouton radio.
    const totalRemoved = reference.releases
        .reduce((n, r) => n + r.groups.filter((g) => g.kind === 'removed')
            .reduce((m, g) => m + g.entries.length, 0), 0);
    chip('removed').click();
    check('deux catégories cochées s\'ajoutent',
        $('.changelog-entry').length === totalSecurity + totalRemoved,
        `${$('.changelog-entry').length} = ${totalSecurity} + ${totalRemoved}`);

    [...$('.changelog-chip')].find((c) => !c.dataset.kind).click();
    check('« tout » rend le journal entier, ouverture comprise',
        $('.changelog-entry').length === reference.count && $('.changelog-lead').length === 1,
        `${$('.changelog-entry').length} entrée(s)`);

    /* ── La recherche ── */

    const field = win.document.getElementById('changelog-search-input');
    const search = (text) => {
        field.value = text;
        field.dispatchEvent(new win.Event('input'));
    };

    /** Les entrées qui portent le mot, sans égard pour les titres. */
    const carrying = (word) => reference.releases
        .reduce((n, r) => n + r.groups
            .reduce((m, g) => m + g.entries.filter((e) => e.toLowerCase().includes(word)).length, 0), 0);

    /** Les livraisons dont le titre ou le résumé porte le mot. */
    const announcing = (word) => reference.releases
        .filter((r) => `${r.title} ${r.summary}`.toLowerCase().includes(word));

    /*
     * Un mot qu'aucun titre ne porte : la recherche ne doit alors ramener que
     * les entrées elles-mêmes. « aiguillage » n'aurait pas fait l'affaire — il
     * est dans le titre du 8 septembre, qui remonte donc en entier, et c'est ce
     * que vérifie le contrôle suivant.
     */
    check('le mot choisi n\'est dans aucun titre de livraison',
        announcing('sonie').length === 0 && carrying('sonie') > 0,
        `${carrying('sonie')} entrée(s) le portent`);

    search('sonie');
    check('la recherche ne garde que les entrées qui portent le mot',
        $('.changelog-entry').length === carrying('sonie'),
        `${$('.changelog-entry').length} entrée(s)`);
    check('ce qui est trouvé est surligné',
        $('.changelog-mark').length > 0 && [...$('.changelog-mark')]
            .every((m) => m.textContent.toLowerCase() === 'sonie'),
        `${$('.changelog-mark').length} surlignage(s)`);

    /*
     * Le cas inverse : un mot du titre ramène la livraison entière, et les
     * entrées des autres livraisons qui le portent aussi. Le 8 septembre
     * s'annonce « Aiguillages, tranches et partage » et compte vingt-sept
     * entrées, dont six seulement citent le mot.
     */
    search('aiguillage');
    const announced = announcing('aiguillage');
    check('un titre touché ramène sa livraison entière, sans perdre les autres',
        announced.length === 1
            && $('.changelog-entry').length
                === announced[0].count + carrying('aiguillage')
                    - announced[0].groups.reduce((m, g) =>
                        m + g.entries.filter((e) => e.toLowerCase().includes('aiguillage')).length, 0),
        `${$('.changelog-entry').length} entrée(s) pour ${announced.length} titre(s) touché(s)`);

    // Le surlignage travaille sur les nœuds de texte : le code littéral d'une
    // entrée doit rester une balise, et non devenir du texte.
    search('api');
    check('le surlignage n\'entame pas le balisage',
        $('.changelog-entry code').length > 0
            && [...$('.changelog-entry')].every((e) => !e.innerHTML.includes('&lt;mark')),
        `${$('.changelog-entry code').length} code(s) littéral(aux) intact(s)`);

    // Les accents ne se composent pas dans un champ de recherche.
    search('securite');
    check('la recherche ignore les accents',
        $('.changelog-entry').length > 0,
        `${$('.changelog-entry').length} entrée(s) pour « securite »`);

    // Un mot qui n'est que dans un titre de livraison doit ramener la livraison
    // entière, et non rien du tout.
    search('audit');
    const audit = [...$('.changelog-release')];
    check('un mot du titre d\'une livraison la ramène entière',
        audit.length === 1 && audit[0].dataset.date === '2026-09-13'
            && audit[0].querySelectorAll('.changelog-entry').length
                === reference.releases.find((r) => r.date === '2026-09-13').count,
        `${audit.length} livraison(s), ${audit.length ? audit[0].querySelectorAll('.changelog-entry').length : 0} entrée(s)`);

    search('xyzzy');
    check('une recherche sans réponse le dit',
        $('.changelog-empty').length === 1 && $('.changelog-entry').length === 0,
        $('.changelog-empty')[0] ? $('.changelog-empty')[0].textContent : '');

    win.document.getElementById('btn-changelog-search-clear').click();
    check('effacer la recherche rend le journal entier',
        $('.changelog-entry').length === reference.count && field.value === '',
        `${$('.changelog-entry').length} entrée(s)`);

    /* ── Le tiroir, le voile et les touches ── */

    /*
     * Le tiroir du sommaire n'existe qu'en dessous de 860 px, et jsdom ne met
     * rien en page : ce qui se vérifie ici n'est donc pas son glissement, mais
     * que le bouton, le voile et la classe que la feuille de style attend sont
     * bien reliés. Une classe mal orthographiée ne se verrait autrement que sur
     * un téléphone.
     */
    const body = win.document.getElementById('changelog-body');
    const toggle = win.document.getElementById('btn-changelog-toc');

    toggle.click();
    check('le bouton du sommaire ouvre le tiroir, et l\'annonce',
        body.classList.contains('changelog-toc-open')
            && toggle.getAttribute('aria-expanded') === 'true');

    win.document.getElementById('changelog-toc-scrim').click();
    check('le voile referme le tiroir',
        !body.classList.contains('changelog-toc-open')
            && toggle.getAttribute('aria-expanded') === 'false');

    // Choisir une date referme le tiroir : le choix doit se voir tout de suite.
    toggle.click();
    win.document.querySelector('.changelog-toc-entry').click();
    check('choisir une date referme le tiroir',
        !body.classList.contains('changelog-toc-open'));

    // La barre oblique amène au champ de recherche, comme partout où l'on
    // cherche.
    const press = (key, target) => {
        const event = new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
        (target || win.document.body).dispatchEvent(event);
        return event;
    };

    press('/');
    check('la barre oblique amène au champ de recherche',
        win.document.activeElement === field);

    /*
     * Échap vide le champ plutôt que de fermer la fenêtre — et ne la retient pas
     * quand il n'y a rien à vider.
     *
     * Ce qui est mesuré est la seule chose qui compte pour l'utilisateur : la
     * touche est-elle parvenue au gestionnaire global du tableau de bord, celui
     * d'app.js qui décide quelle fenêtre se referme ? Interroger `cancelBubble`
     * sur l'événement aurait mesuré autre chose — jsdom ne l'expose pas après
     * la distribution, et le tableau de bord ne le consulte pas.
     */
    let reachedDashboard = false;
    win.document.addEventListener('keydown', () => { reachedDashboard = true; });

    field.value = 'quelque chose';
    field.dispatchEvent(new win.Event('input'));
    press('Escape', field);
    check('Échap vide la recherche, et n\'arrive pas au tableau de bord',
        field.value === '' && reachedDashboard === false);

    press('Escape', field);
    check('sur un champ vide, Échap repart au tableau de bord', reachedDashboard === true);

    /* ── La langue servie ── */

    check('en français, le pied ne dit rien de la langue',
        win.document.getElementById('changelog-note').classList.contains('hidden'));

    servedLang = 'en';
    win.MusicPlayer.dashboardSettings.language = 'es';
    await win.MusicPlayer.refreshChangelogLanguage();
    const note = win.document.getElementById('changelog-note');
    check('en espagnol, le pied dit dans quelle langue le journal est affiché',
        !note.classList.contains('hidden') && note.textContent.includes('anglais'),
        note.textContent);

    check('l\'habillage suit malgré tout la langue du tableau de bord',
        $('.changelog-release-date')[0].textContent === '11 de noviembre de 2026',
        $('.changelog-release-date')[0].textContent);

    // La fenêtre se referme, et le dit à qui la ferme — c'est ce que la touche
    // Échap du tableau de bord lit pour savoir si elle a été consommée.
    check('la fermeture se signale une fois, et une seule',
        win.MusicPlayer.closeChangelogModal() === true
            && win.MusicPlayer.closeChangelogModal() === false);

    /*
     * Le clic à côté referme, comme dans les sept autres fenêtres du tableau de
     * bord — et le clic dedans ne referme pas. Les deux vont ensemble : le
     * premier s'écrit en une ligne qui, mal écrite, emporte le second.
     */
    const modal = win.document.getElementById('changelog-modal');
    await win.MusicPlayer.openChangelogModal();
    win.document.querySelector('.changelog-window').dispatchEvent(
        new win.MouseEvent('click', { bubbles: true }));
    check('un clic dans la fenêtre ne la referme pas', !modal.classList.contains('hidden'));

    modal.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    check('un clic sur le voile la referme', modal.classList.contains('hidden'));
}
