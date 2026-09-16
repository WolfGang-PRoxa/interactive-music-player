/**
 * Vérifie la disposition des boîtes du tableau de bord — le vrai
 * layoutPersistence.js, exécuté hors navigateur pour son moteur de placement.
 *
 * L'ancien système recalculait tout à chaque mouvement de souris depuis la
 * disposition qu'il venait de bousculer, puis tassait toutes les boîtes vers le
 * haut. Le tableau entier sautait, rien ne revenait en place, et la boîte posée
 * remontait au relâchement. Ce test tient les règles qui l'ont remplacé, dont
 * aucune ne se voit dans un diff :
 *
 *  - **aucun aimant** : une boîte que rien ne heurte ne bouge pas, un espace
 *    vide reste vide ;
 *  - **l'échange** : lâchée sur une autre boîte, la boîte saisie prend sa place
 *    et lui donne la sienne. Deux voisines de tailles différentes s'échangent
 *    sans laisser de trou ; deux boîtes séparées par une troisième la laissent
 *    où elle est ;
 *  - **la place libre la plus proche** quand la cible ne mord qu'un peu sur une
 *    autre boîte — sans rien pousser ;
 *  - **les boîtes verrouillées ne bougent jamais**, et arrêtent un
 *    redimensionnement comme un mur ;
 *  - **la réversibilité** : tout part de la disposition du début du geste.
 *
 * Il surveille aussi le piège qui rendait les déplacements instantanés :
 * `.card` déclare une transition `!important`, qui écrase toute transition
 * posée en ligne. Les animations passent donc par `translate` et `scale`, que
 * cette transition ne doit jamais lister.
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'src', 'web', 'public');
const SOURCE = fs.readFileSync(path.join(PUBLIC, 'js', 'layoutPersistence.js'), 'utf8');

let failed = 0;
let passed = 0;
const check = (label, ok, detail = '') => {
    if (ok) { passed++; console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`); }
    else { failed++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
};

console.log('\n=== Disposition des boîtes ===\n');

/* ════════════════ Chargement du vrai fichier ════════════════ */

const sandbox = {
    localStorage: { getItem: () => null, setItem: () => {} },
    document: { getElementById: () => null },
    console
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(SOURCE, sandbox);

const engine = sandbox.MusicPlayer.layoutEngine;
const { COLUMNS, MIN_COL_SPAN, MIN_ROW_SPAN } = engine;

/** La disposition d'origine, lue dans le fichier plutôt que recopiée. */
const DEFAULT = (() => {
    const match = SOURCE.match(/const defaultLayout = (\{[\s\S]*?\n\s*\});/);
    return vm.runInNewContext(`(${match[1]})`);
})();

/* ════════════════ Outils ════════════════ */

const clone = (value) => JSON.parse(JSON.stringify(value));
const rectText = (r) => `(${r.colStart},${r.rowStart} ${r.colSpan}×${r.rowSpan})`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** Deux dispositions égales, quel que soit l'ordre de leurs clés. */
const sameLayout = (a, b) => Object.keys(a).length === Object.keys(b).length
    && Object.keys(a).every(id => same(a[id], b[id]));

/** Renvoie la première anomalie d'une disposition, ou `null`. */
function flaw(layout) {
    const ids = Object.keys(layout);
    for (const id of ids) {
        const r = layout[id];
        if (r.colStart < 1 || r.rowStart < 1 || r.colStart + r.colSpan - 1 > COLUMNS) return `${id} hors grille ${rectText(r)}`;
        if (r.colSpan < MIN_COL_SPAN || r.rowSpan < MIN_ROW_SPAN) return `${id} sous la taille minimale ${rectText(r)}`;
    }
    for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
            if (engine.overlaps(layout[ids[i]], layout[ids[j]])) return `${ids[i]} chevauche ${ids[j]}`;
        }
    }
    return null;
}

/** Les boîtes, hors celles citées, sont-elles restées où elles étaient ? */
function untouched(start, layout, except) {
    return Object.keys(start)
        .filter(id => !except.includes(id))
        .every(id => same(start[id], layout[id]));
}

const move = (start, id, colStart, rowStart, locked = {}, previous = null) =>
    engine.arrangeMove(clone(start), id, { colStart, rowStart }, locked, previous);

/* ════════════════ La disposition d'origine ════════════════ */

console.log('La disposition d\'origine\n');

check('elle est valide', flaw(DEFAULT) === null, flaw(DEFAULT) || '');
check('la remettre d\'aplomb ne change rien', sameLayout(engine.normalize(clone(DEFAULT), {}), DEFAULT));

/* ════════════════ Aucun aimant ════════════════ */

console.log('\nAucun aimant\n');

{
    const lonely = { a: { colStart: 1, colSpan: 8, rowStart: 1, rowSpan: 6 }, b: { colStart: 1, colSpan: 8, rowStart: 40, rowSpan: 6 } };
    check('une boîte isolée loin sous les autres y reste',
        engine.normalize(clone(lonely), {}).b.rowStart === 40);

    const decision = move(DEFAULT, 'mix-card', 1, 45);
    check('poser une boîte dans le vide ne déplace personne',
        decision.kind === 'free' && untouched(DEFAULT, decision.layout, ['mix-card']), decision.kind);
    check('  … et elle se pose exactement là, sans remonter',
        same(decision.layout['mix-card'], { colStart: 1, colSpan: 18, rowStart: 45, rowSpan: 8 }),
        rectText(decision.layout['mix-card']));

    const shrink = engine.arrangeResize(clone(DEFAULT), 'ducking-card', { colSpan: 18, rowSpan: 8 }, {});
    check('rétrécir une boîte ne fait rien remonter sous elle',
        untouched(DEFAULT, shrink.layout, ['ducking-card']));

    const overlapping = {
        a: { colStart: 1, colSpan: 10, rowStart: 1, rowSpan: 10 },
        b: { colStart: 5, colSpan: 10, rowStart: 5, rowSpan: 10 },
        c: { colStart: 30, colSpan: 10, rowStart: 20, rowSpan: 10 }
    };
    const fixed = engine.normalize(clone(overlapping), {});
    check('une disposition abîmée se répare en descendant ce qui gêne',
        flaw(fixed) === null && fixed.b.rowStart === 11 && fixed.b.colStart === 5, rectText(fixed.b));
    check('  … sans toucher à ce qui ne gênait pas', same(fixed.c, overlapping.c));
}

/* ════════════════ L'échange ════════════════ */

console.log('\nL\'échange\n');

{
    const d = move(DEFAULT, 'ducking-card', 1, 1);
    check('deux voisines de même taille échangent leur place',
        d.kind === 'swap' && d.partner === 'player-card'
        && same(d.layout['ducking-card'], DEFAULT['player-card'])
        && same(d.layout['player-card'], DEFAULT['ducking-card']),
        `${d.kind} ${rectText(d.layout['ducking-card'])} ${rectText(d.layout['player-card'])}`);
    check('  … et personne d\'autre ne bouge', untouched(DEFAULT, d.layout, ['ducking-card', 'player-card']));

    const e = move(DEFAULT, 'mix-card', 1, 17);
    check('deux voisines de tailles différentes s\'échangent sans trou',
        e.kind === 'swap'
        && e.layout['mix-card'].rowStart === 17
        && e.layout['ducking-card'].rowStart === 17 + 8,
        `mix ${rectText(e.layout['mix-card'])}, ducking ${rectText(e.layout['ducking-card'])}`);
    check('  … dans l\'espace qu\'elles couvraient à elles deux',
        e.layout['ducking-card'].rowStart + e.layout['ducking-card'].rowSpan === 41);
    check('  … sans rien pousser', untouched(DEFAULT, e.layout, ['mix-card', 'ducking-card']));

    const f = move(DEFAULT, 'mix-card', 1, 1);
    check('deux boîtes séparées par une troisième s\'échangent',
        f.kind === 'swap' && f.layout['mix-card'].rowStart === 1 && f.layout['player-card'].rowStart === 33,
        `mix ${rectText(f.layout['mix-card'])}, player ${rectText(f.layout['player-card'])}`);
    check('  … et laissent la troisième où elle est',
        same(f.layout['ducking-card'], DEFAULT['ducking-card']));

    const row = {
        a: { colStart: 1, colSpan: 8, rowStart: 1, rowSpan: 6 },
        b: { colStart: 9, colSpan: 12, rowStart: 1, rowSpan: 6 }
    };
    const g = move(row, 'a', 9, 1);
    check('côte à côte, l\'échange se fait aussi en largeur, sans trou',
        g.kind === 'swap' && g.layout.b.colStart === 1 && g.layout.a.colStart === 13,
        `a ${rectText(g.layout.a)}, b ${rectText(g.layout.b)}`);

    const h = move(DEFAULT, 'search-card', 35, 1);
    check('un échange entre tailles très différentes reste valide',
        h.kind === 'swap' && flaw(h.layout) === null, flaw(h.layout) || h.kind);
    check('  … la boîte saisie se pose là où l\'emplacement le montrait',
        same(h.layout['search-card'], h.placeholder));
}

/* ════════════════ La place libre la plus proche ════════════════ */

console.log('\nLa place libre la plus proche\n');

{
    const sparse = {
        a: { colStart: 1, colSpan: 8, rowStart: 1, rowSpan: 6 },
        b: { colStart: 20, colSpan: 8, rowStart: 1, rowSpan: 6 }
    };
    const d = move(sparse, 'a', 14, 1);
    check('une cible qui mord un peu sur une boîte glisse à côté',
        d.kind === 'free' && d.layout.a.colStart === 12 && same(d.layout.b, sparse.b),
        `${d.kind} ${rectText(d.layout.a)}`);

    // La cible chevauche le coin où se rejoignent trois boîtes, sans couvrir la
    // moitié d'aucune : ni échange, ni place libre à moins de quatre cellules.
    const packed = {
        a: { colStart: 1, colSpan: 8, rowStart: 1, rowSpan: 6 },
        b: { colStart: 9, colSpan: 40, rowStart: 1, rowSpan: 30 },
        c: { colStart: 1, colSpan: 8, rowStart: 7, rowSpan: 30 },
        d: { colStart: 9, colSpan: 40, rowStart: 31, rowSpan: 30 }
    };
    const previous = move(packed, 'a', 1, 1);
    const e = move(packed, 'a', 6, 28, {}, previous);
    check('sans place libre alentour, l\'emplacement reste où il était',
        e === previous && sameLayout(e.layout, packed), e.kind);
}

/* ════════════════ Les boîtes verrouillées ════════════════ */

console.log('\nLes boîtes verrouillées\n');

{
    const locked = { 'player-card': true };
    const d = move(DEFAULT, 'ducking-card', 1, 1, locked);
    check('viser une boîte verrouillée est refusé',
        d.kind === 'blocked' && d.partner === 'player-card', d.kind);
    check('  … et la disposition reste celle du départ', sameLayout(d.layout, DEFAULT));

    const r = engine.arrangeResize(clone(DEFAULT), 'player-card', { colSpan: 30, rowSpan: 16 }, { 'search-card': true });
    check('une boîte verrouillée arrête un redimensionnement',
        r.placeholder.colSpan === 18 && same(r.layout['search-card'], DEFAULT['search-card']),
        rectText(r.placeholder));

    const wall = {
        a: { colStart: 1, colSpan: 8, rowStart: 1, rowSpan: 6 },
        b: { colStart: 1, colSpan: 8, rowStart: 7, rowSpan: 6 },
        lock: { colStart: 1, colSpan: 8, rowStart: 13, rowSpan: 6 }
    };
    const s = engine.arrangeResize(clone(wall), 'a', { colSpan: 8, rowSpan: 12 }, { lock: true });
    check('une boîte poussée vers une boîte verrouillée saute par-dessus',
        same(s.layout.lock, wall.lock) && s.layout.b.rowStart === 19 && flaw(s.layout) === null,
        rectText(s.layout.b));

    const normalized = engine.normalize({
        free: { colStart: 1, colSpan: 10, rowStart: 1, rowSpan: 10 },
        lock: { colStart: 1, colSpan: 10, rowStart: 5, rowSpan: 10 }
    }, { lock: true });
    check('en réparant une disposition, la boîte verrouillée garde sa place',
        normalized.lock.rowStart === 5 && normalized.free.rowStart === 15, rectText(normalized.free));
}

/* ════════════════ Le redimensionnement ════════════════ */

console.log('\nLe redimensionnement\n');

{
    const taller = engine.arrangeResize(clone(DEFAULT), 'ducking-card', { colSpan: 18, rowSpan: 20 }, {});
    check('ce qu\'une boîte recouvre en grandissant descend juste assez',
        taller.layout['mix-card'].rowStart === 37, rectText(taller.layout['mix-card']));
    check('  … et le reste ne bouge pas', untouched(DEFAULT, taller.layout, ['ducking-card', 'mix-card']));

    const tiny = engine.arrangeResize(clone(DEFAULT), 'queue-card', { colSpan: 1, rowSpan: 1 }, {});
    check('la taille minimale est tenue',
        tiny.placeholder.colSpan === MIN_COL_SPAN && tiny.placeholder.rowSpan === MIN_ROW_SPAN, rectText(tiny.placeholder));

    const wide = engine.arrangeResize(clone(DEFAULT), 'queue-card', { colSpan: 40, rowSpan: 16 }, {});
    check('le bord droit de la grille est tenu',
        wide.placeholder.colStart + wide.placeholder.colSpan - 1 === COLUMNS, rectText(wide.placeholder));
}

/* ════════════════ Réversibilité ════════════════ */

console.log('\nRéversibilité\n');

{
    const start = clone(DEFAULT);
    move(start, 'mix-card', 1, 1);
    move(start, 'mix-card', 19, 17);
    const back = move(start, 'mix-card', 1, 33);
    check('revenir au point de départ remet tout en place',
        back.kind === 'free' && sameLayout(back.layout, DEFAULT), back.kind);
    check('le moteur ne modifie pas la disposition qu\'on lui confie', sameLayout(start, DEFAULT));
}

/* ════════════════ Dispositions tirées au hasard ════════════════ */

console.log('\nDispositions tirées au hasard\n');

{
    let seed = 20260916;
    const random = () => {
        seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const int = (min, max) => min + Math.floor(random() * (max - min + 1));

    const problems = [];
    for (let round = 0; round < 400 && problems.length < 5; round++) {
        const raw = {};
        const count = int(2, 9);
        for (let i = 0; i < count; i++) {
            raw[`c${i}`] = { colStart: int(1, 41), colSpan: int(8, 24), rowStart: int(1, 40), rowSpan: int(6, 20) };
        }
        const ids = Object.keys(raw);
        const locked = {};
        ids.forEach(id => { if (random() < 0.2) locked[id] = true; });
        const start = engine.normalize(raw, locked);

        if (flaw(start)) { problems.push(`normalisation : ${flaw(start)}`); continue; }

        const free = ids.filter(id => !locked[id]);
        if (!free.length) continue;
        const active = free[int(0, free.length - 1)];
        const snapshot = clone(start);

        const d = move(start, active, int(-3, 50), int(-3, 60), locked);
        const r = engine.arrangeResize(clone(start), active, { colSpan: int(1, 50), rowSpan: int(1, 70) }, locked);

        for (const [name, decision] of [['déplacement', d], ['redimensionnement', r]]) {
            const where = `${name} n° ${round}`;
            if (flaw(decision.layout)) problems.push(`${where} : ${flaw(decision.layout)}`);
            if (!Object.keys(locked).every(id => same(decision.layout[id], start[id]))) problems.push(`${where} : une boîte verrouillée a bougé`);
            if (decision.kind !== 'blocked' && !same(decision.layout[active], decision.placeholder)) problems.push(`${where} : la boîte ne se pose pas sur l'emplacement`);
            if (!ids.every(id => id === active && name === 'redimensionnement'
                || (decision.layout[id].colSpan === start[id].colSpan && decision.layout[id].rowSpan === start[id].rowSpan))) {
                problems.push(`${where} : une boîte a changé de taille`);
            }
        }
        if (d.kind === 'free' && !untouched(start, d.layout, [active])) problems.push(`déplacement n° ${round} : une place libre a déplacé une autre boîte`);
        if (d.kind === 'blocked' && !sameLayout(d.layout, start)) problems.push(`déplacement n° ${round} : un refus a changé la disposition`);
        if (!sameLayout(start, snapshot)) problems.push(`n° ${round} : la disposition de départ a été modifiée`);
    }
    check('400 gestes : jamais de chevauchement, les boîtes verrouillées immobiles',
        problems.length === 0, problems.join(' ; '));
}

/* ════════════════ Ce que les animations exigent des feuilles ════════════════ */

console.log('\nCe que les animations exigent des feuilles de style\n');

{
    const cssFiles = fs.readdirSync(path.join(PUBLIC, 'css')).filter(f => f.endsWith('.css'));
    const offending = [];
    for (const file of cssFiles) {
        const bare = fs.readFileSync(path.join(PUBLIC, 'css', file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ');
        const re = /([^{}]+)\{([^{}]*)\}/g;
        let m;
        while ((m = re.exec(bare)) !== null) {
            const selector = m[1].trim().replace(/\s+/g, ' ');
            if (!/\.card(?![\w-])/.test(selector)) continue;
            const transition = (m[2].match(/transition\s*:[^;]*/) || [''])[0];
            if (/\b(translate|scale|all)\b/.test(transition)) offending.push(`${file} ${selector} — ${transition.trim()}`);
            if (/(^|;)\s*(translate|scale)\s*:[^;]*!important/.test(m[2])) offending.push(`${file} ${selector} — translate/scale !important`);
        }
    }
    check('aucune règle de carte ne transitionne ni ne force `translate` ou `scale`',
        offending.length === 0, offending.join(' | '));

    check('le script n\'anime ni par `transform` ni par une transition en ligne',
        !/\.style\.(transform|transition)\s*=/.test(SOURCE));
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed === 0 ? 0 : 1);
