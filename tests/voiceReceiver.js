/**
 * Vérifie le rangement qui rend au bot son oreille.
 *
 * Le ducking a besoin qu'une connexion vocale sache *recevoir*. discord-player 7
 * s'appuie sur `discord-voip`, un embranchement réduit à la diffusion sans
 * `VoiceReceiver` ; le projet redirige ce nom vers `@discordjs/voice`, qui en a
 * un. Mais npm range malgré tout une copie propre à discord-player sous son
 * dossier, où Node la trouve en premier — et les `overrides` n'y peuvent rien.
 *
 * `tools/keep-voice-receiver.js` écarte cette copie après chaque installation.
 * Ce qui compte n'est pas qu'il sache supprimer un dossier, mais qu'il sache
 * **quand ne pas le faire** :
 *
 *  - **La copie imbriquée sait déjà écouter.** Le jour où discord-voip aura son
 *    propre receiver, il n'y aura plus rien à ranger, et l'écarter reviendrait à
 *    remplacer une dépendance par une autre sans raison.
 *
 *  - **Rien ne peut la remplacer.** Sans paquet pourvu d'un receiver au niveau
 *    du dessus, la suppression ne substituerait rien : elle priverait
 *    discord-player de sa dépendance, et casserait la lecture pour réparer le
 *    ducking. C'est le pire des échanges, et le plus facile à écrire.
 *
 * Enfin, il ne doit jamais faire échouer une installation : une dépendance mal
 * rangée ne vaut pas d'interrompre tout le reste.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..');
const { keepVoiceReceiver } = require(path.join(ROOT, 'tools', 'keep-voice-receiver.js'));

let failed = 0;
let passed = 0;
const check = (label, ok, detail = '') => {
    if (ok) { passed++; console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`); }
    else { failed++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
};

const sandboxes = [];

/**
 * Fabrique un paquet minuscule, réellement chargeable.
 * @param {string} dir
 * @param {boolean} withReceiver
 */
function makePackage(dir, withReceiver) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'),
        JSON.stringify({ name: 'discord-voip', version: '1.0.0', main: 'index.js' }));
    fs.writeFileSync(path.join(dir, 'index.js'),
        withReceiver
            ? 'exports.VoiceReceiver = function VoiceReceiver() {};\nexports.joinVoiceChannel = function () {};\n'
            : 'exports.joinVoiceChannel = function () {};\n');
}

/**
 * Monte une arborescence de test.
 * @param {{ nested?: boolean, nestedHears?: boolean, outer?: boolean, outerHears?: boolean }} shape
 * @returns {string} La racine du bac à sable
 */
function tree(shape) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-receiver-'));
    sandboxes.push(root);

    if (shape.outer) {
        makePackage(path.join(root, 'node_modules', 'discord-voip'), shape.outerHears !== false);
    }
    if (shape.nested) {
        makePackage(
            path.join(root, 'node_modules', 'discord-player', 'node_modules', 'discord-voip'),
            shape.nestedHears === true);
    }
    return root;
}

const nestedPath = (root) =>
    path.join(root, 'node_modules', 'discord-player', 'node_modules', 'discord-voip');

console.log('\n=== Le rangement qui rend son oreille au bot ===\n');

// ───────────────────── Le cas nominal ─────────────────────

console.log('Une copie imbriquée qui n\'entend pas\n');

{
    const root = tree({ nested: true, outer: true });
    const verdict = keepVoiceReceiver(root);
    check('elle est écartée', verdict === 'removed', verdict);
    check('et le dossier a bien disparu', !fs.existsSync(nestedPath(root)));
    check('celle du dessus est intacte',
        fs.existsSync(path.join(root, 'node_modules', 'discord-voip')),
        'c\'est elle qui prend le relais');

    // Le script tourne après chaque installation : la deuxième fois, il n'a
    // plus rien à faire et doit le dire sans s'agiter.
    check('un second passage ne trouve plus rien',
        keepVoiceReceiver(root) === 'absent');
}

// ───────────────────── Ce qu'il refuse de faire ─────────────────────

console.log('\nCe qu\'il se garde de toucher\n');

{
    // Le jour où discord-voip aura son propre receiver.
    const root = tree({ nested: true, nestedHears: true, outer: true });
    const verdict = keepVoiceReceiver(root);
    check('une copie imbriquée qui entend est laissée en place',
        verdict === 'still-useful' && fs.existsSync(nestedPath(root)),
        'il n\'y a plus rien à ranger');
}

{
    // La substitution n'aurait rien à substituer.
    const root = tree({ nested: true, outer: false });
    const verdict = keepVoiceReceiver(root);
    check('sans remplaçante, rien n\'est supprimé',
        verdict === 'no-replacement' && fs.existsSync(nestedPath(root)),
        'priver discord-player de sa dépendance casserait la lecture');
}

{
    // Une remplaçante qui n'entend pas davantage ne remplace rien.
    const root = tree({ nested: true, outer: true, outerHears: false });
    const verdict = keepVoiceReceiver(root);
    check('une remplaçante sourde ne vaut pas mieux',
        verdict === 'no-replacement' && fs.existsSync(nestedPath(root)));
}

{
    const root = tree({});
    check('un projet sans dépendances installées ne l\'émeut pas',
        keepVoiceReceiver(root) === 'absent');
}

// ───────────────────── Il ne casse jamais l'installation ─────────────────────

console.log('\nCe qu\'il ne fait jamais échouer\n');

{
    // Un dossier présent mais illisible : ni `package.json`, ni point d'entrée.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-receiver-'));
    sandboxes.push(root);
    fs.mkdirSync(nestedPath(root), { recursive: true });

    let threw = false;
    let verdict = null;
    try { verdict = keepVoiceReceiver(root); } catch (e) { threw = true; }
    check('un paquet imbriqué illisible ne lève rien', !threw, `verdict : ${verdict}`);
    check('et il est laissé en place, faute de savoir',
        verdict === 'no-replacement' && fs.existsSync(nestedPath(root)));
}

{
    // Le vrai script, lancé comme npm le lance, dans un dossier vide.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-receiver-'));
    sandboxes.push(root);
    const run = cp.spawnSync(process.execPath,
        [path.join(ROOT, 'tools', 'keep-voice-receiver.js')],
        { cwd: root, encoding: 'utf8', windowsHide: true });
    check('lancé pour de vrai, il sort en réussite', run.status === 0,
        `code ${run.status}`);
}

// ───────────────────── Le branchement ─────────────────────

console.log('\nCe qui le fait tourner\n');

{
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    check('il est branché sur postinstall',
        manifest.scripts.postinstall === 'node tools/keep-voice-receiver.js',
        manifest.scripts.postinstall || 'absent');

    // C'est ce qui le fait jouer aussi quand le bot s'installe une nouvelle
    // version tout seul : l'installateur lance `npm install` dans le dossier de
    // la version, et npm y déclenche le postinstall du paquet qu'il installe.
    const installer = fs.readFileSync(
        path.join(ROOT, 'src', 'versioning', 'installer.js'), 'utf8');
    check('les installations que le bot déclenche passent par npm',
        /spawn\([^)]*\[\s*'install'/.test(installer),
        'donc par ce postinstall');

    // Le paquet garde ses `overrides` : ils disent l'intention, même si npm ne
    // les honore pas pour une dépendance imbriquée. Les retirer ferait croire
    // que ce script est un caprice.
    check('la redirection reste déclarée dans le paquet',
        manifest.overrides
        && String(manifest.overrides['discord-voip']).includes('@discordjs/voice'),
        'ce script ne fait qu\'obtenir ce qu\'elle demande');
}

for (const dir of sandboxes) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
