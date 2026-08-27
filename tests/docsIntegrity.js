/**
 * Vérifie la cohérence du corpus de documentation, toutes langues confondues.
 *
 * La documentation est écrite en français et traduite en anglais, espagnol et
 * allemand. Trois choses s'y cassent en silence, et aucune ne se voit à la
 * relecture d'une traduction :
 *
 *  - **Les ancres.** Un lien vers `05-tableau-de-bord.md#robustesse` désigne un
 *    titre. Traduire le titre sans traduire l'ancre, ou l'inverse, donne un lien
 *    qui ne mène nulle part — dans cette langue-là seulement. Le calcul de
 *    l'ancre reprend ici celui de js/docs.js, qui suit la convention de GitHub.
 *
 *  - **La charpente.** Une traduction doit avoir autant de titres, de blocs de
 *    code et de lignes de tableau que son original. Un écart signale une section
 *    oubliée ou un tableau tronqué, ce qu'un fichier de 15 Ko ne montre pas.
 *
 *  - **Les liens vers le code.** Ils traversent `docs/<langue>/technique/` pour
 *    remonter à `src/`. Déplacer la documentation d'un niveau les casse tous à
 *    la fois, sans que rien ne le signale : ce sont des liens de dépôt, que le
 *    lecteur du tableau de bord n'ouvre même pas.
 */
const fs = require('fs');
const path = require('path');

const DOCS = path.join(__dirname, '..', 'docs');

/** Langue écrite à la main : les autres en sont traduites et s'y mesurent. */
const REFERENCE = 'fr';

let failed = 0;
let passed = 0;
const check = (label, ok, detail = '') => {
    if (ok) { passed++; }
    else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

/**
 * Identifiant d'ancre d'un titre.
 *
 * Doit rester identique à `anchor()` de js/docs.js : c'est ce calcul-là que le
 * lecteur applique, et un écart entre les deux ferait passer ce test sur des
 * liens que la fenêtre de lecture ne résoudrait pas.
 */
function anchor(text) {
    return String(text)
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]/gu, '')
        .trim()
        .replace(/\s+/g, '-');
}

/** Chemins Markdown d'une racine, relatifs à celle-ci. */
function walk(dir, prefix = '') {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full, `${prefix}${entry.name}/`));
        else if (/\.md$/i.test(entry.name)) out.push(`${prefix}${entry.name}`);
    }
    return out.sort();
}

/**
 * Ancres des titres d'un document.
 *
 * Les blocs de code sont sautés : un `# commentaire` shell y ressemble à un
 * titre de niveau 1, et les documents en contiennent.
 */
function headings(source) {
    const out = [];
    let inFence = false;
    for (const line of source.split('\n')) {
        if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
        if (inFence) continue;
        const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
        if (m) out.push(anchor(m[2].replace(/`/g, '')));
    }
    return out;
}

/** Ce qu'une traduction doit conserver de son original. */
function skeleton(source) {
    let fences = 0;
    let tables = 0;
    let titles = 0;
    let inFence = false;
    for (const line of source.split('\n')) {
        if (/^\s*```/.test(line)) { fences++; inFence = !inFence; continue; }
        if (inFence) continue;
        if (/^\s*\|.*\|\s*$/.test(line)) tables++;
        if (/^#{1,6}\s+/.test(line)) titles++;
    }
    return { fences, tables, titles };
}

const langs = fs.readdirSync(DOCS, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^[a-z]{2}$/.test(e.name))
    .map((e) => e.name);

console.log(`\n=== Documentation corpus — languages: ${langs.join(', ')} ===\n`);

check(`reference language « ${REFERENCE} » is present`, langs.includes(REFERENCE));
if (!langs.includes(REFERENCE)) {
    console.log(`\n=== ${passed} passed, ${failed} failed ===`);
    process.exit(1);
}

const referenceFiles = walk(path.join(DOCS, REFERENCE));
const referenceSkeletons = {};
for (const file of referenceFiles) {
    referenceSkeletons[file] = skeleton(
        fs.readFileSync(path.join(DOCS, REFERENCE, file), 'utf8')
    );
}

for (const lang of langs) {
    const base = path.join(DOCS, lang);
    const files = walk(base);

    const missing = referenceFiles.filter((f) => !files.includes(f));
    const extra = files.filter((f) => !referenceFiles.includes(f));
    check(`${lang}: same files as ${REFERENCE}`,
        missing.length === 0 && extra.length === 0,
        [missing.length ? `missing: ${missing.join(', ')}` : '',
         extra.length ? `extra: ${extra.join(', ')}` : ''].filter(Boolean).join(' ; '));

    const headingsOf = {};
    for (const file of files) {
        headingsOf[file] = headings(fs.readFileSync(path.join(base, file), 'utf8'));
    }

    for (const file of files) {
        const source = fs.readFileSync(path.join(base, file), 'utf8');
        const dir = path.posix.dirname(file) === '.' ? '' : path.posix.dirname(file);

        if (referenceSkeletons[file]) {
            const ref = referenceSkeletons[file];
            const own = skeleton(source);
            check(`${lang}/${file}: structure preserved`,
                ref.fences === own.fences && ref.titles === own.titles && ref.tables === own.tables,
                `fences ${own.fences}/${ref.fences}, headings ${own.titles}/${ref.titles}, `
                + `table rows ${own.tables}/${ref.tables}`);
        }

        for (const raw of [...source.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1])) {
            if (/^https?:|^mailto:/i.test(raw)) continue;

            const [target, fragment] = raw.split('#');

            // Ancre dans le document courant.
            if (!target) {
                check(`${lang}/${file}: anchor #${fragment}`,
                    headingsOf[file].includes(fragment),
                    `headings: ${headingsOf[file].slice(0, 5).join(', ')}…`);
                continue;
            }

            const resolved = path.posix.normalize(dir ? `${dir}/${target}` : target);

            // Lien vers le code source : il sort de docs/ et vise le dépôt.
            if (resolved.startsWith('../')) {
                check(`${lang}/${file} : source ${target}`,
                    fs.existsSync(path.resolve(base, dir, target)));
                continue;
            }

            check(`${lang}/${file} : document ${resolved}`, files.includes(resolved));
            if (fragment && files.includes(resolved)) {
                check(`${lang}/${file}: anchor ${resolved}#${fragment}`,
                    headingsOf[resolved].includes(fragment),
                    `headings: ${headingsOf[resolved].slice(0, 5).join(', ')}…`);
            }
        }
    }
}

console.log(`=== ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
