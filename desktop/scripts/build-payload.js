/**
 * Prépare la charge utile de l'installeur : Node pour Windows, et le bot avec
 * ses dépendances, dans une seule archive.
 *
 *   node desktop/scripts/build-payload.js
 *
 * Produit `desktop/src-tauri/payload/bot.tar.gz` et son `manifest.json`, que
 * `tauri build` embarque en ressources et que l'application déploie au premier
 * lancement (voir src-tauri/src/payload.rs).
 *
 * Doit tourner sur la plateforme visée : les dépendances du bot comportent des
 * binaires propres à chacune — FFmpeg, yt-dlp, le chiffrement DAVE — que npm
 * télécharge pour la machine qui l'exécute. D'où la construction sur un
 * runner Windows (.github/workflows/desktop.yml).
 *
 * yt-dlp ne vient pas du `postinstall` de youtube-dl-exec mais du lien direct
 * de sa dernière release : voir stageYtDlp.
 *
 * Variables :
 *   IMP_NODE_VERSION  version exacte de Node à embarquer (v24.x.y). Par
 *                     défaut, la dernière de la ligne LTS 24.
 */

'use strict';

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const DESKTOP = path.join(REPO, 'desktop');
const STAGING = path.join(DESKTOP, '.staging');
const OUTPUT = path.join(DESKTOP, 'src-tauri', 'payload');
const NODE_LINE = 24;

/**
 * Ce que le bot n'emporte pas : les tests, l'application elle-même, et le
 * lanceur PowerShell qu'elle remplace. `tools/keep-voice-receiver.js` reste :
 * c'est le `postinstall` du bot, rejoué à chaque installation de version.
 */
function shipped(file) {
    if (file === 'tools/keep-voice-receiver.js') return true;
    const excludedDirs = ['tests/', 'desktop/', '.github/', 'tools/', 'branding/'];
    if (excludedDirs.some((dir) => file.startsWith(dir))) return false;
    const excludedFiles = ['Start bot.vbs', 'Create shortcut.vbs', 'TODO.md', '.gitignore'];
    return !excludedFiles.includes(file);
}

function log(message) {
    console.log(`[payload] ${message}`);
}

function get(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'imp-desktop-build' } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                return resolve(get(new URL(res.headers.location, url).toString()));
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`${url} → HTTP ${res.statusCode}`));
            }
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        }).on('error', reject);
    });
}

async function nodeVersion() {
    if (process.env.IMP_NODE_VERSION) return process.env.IMP_NODE_VERSION;
    const index = JSON.parse((await get('https://nodejs.org/dist/index.json')).toString('utf8'));
    const release = index.find((r) => r.version.startsWith(`v${NODE_LINE}.`) && r.lts);
    if (!release) throw new Error(`no LTS release found on the v${NODE_LINE} line`);
    return release.version;
}

/** Télécharge Node, vérifie son empreinte, et le dépose dans `runtime/`. */
async function stageRuntime(version) {
    const windows = process.platform === 'win32';
    const name = windows ? `node-${version}-win-x64` : `node-${version}-${process.platform}-x64`;
    const file = windows ? `${name}.zip` : `${name}.tar.xz`;
    const base = `https://nodejs.org/dist/${version}`;

    log(`Node ${version} (${file})`);
    const [archive, sums] = await Promise.all([get(`${base}/${file}`), get(`${base}/SHASUMS256.txt`)]);
    const expected = sums.toString('utf8').split('\n')
        .map((line) => line.trim().split(/\s+/))
        .find(([, f]) => f === file)?.[0];
    const actual = crypto.createHash('sha256').update(archive).digest('hex');
    if (!expected || expected !== actual) throw new Error(`checksum mismatch for ${file}`);

    const download = path.join(STAGING, file);
    fs.writeFileSync(download, archive);
    tar(['-xf', download, '-C', STAGING]);
    fs.rmSync(download);
    fs.renameSync(path.join(STAGING, name), path.join(STAGING, 'runtime'));

    // Hors Windows, l'exécutable est dans bin/ ; l'application le cherche à
    // la racine du runtime, comme sous Windows.
    if (!windows) {
        fs.renameSync(path.join(STAGING, 'runtime', 'bin', 'node'), path.join(STAGING, 'runtime', 'node'));
    }
}

/** Copie le code du bot suivi par Git, puis installe ses dépendances. */
function stageBot() {
    const bot = path.join(STAGING, 'bot');
    const files = execFileSync('git', ['ls-files', '-z'], { cwd: REPO })
        .toString('utf8').split('\0').filter(Boolean).filter(shipped);
    for (const file of files) {
        const target = path.join(bot, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(REPO, file), target);
    }
    log(`${files.length} files of the bot copied`);

    const major = Number(process.versions.node.split('.')[0]);
    if (major !== NODE_LINE) {
        log(`warning: npm runs on Node ${process.versions.node}, the app embeds Node ${NODE_LINE}; `
            + 'a native module could be built for the wrong version.');
    }
    log('npm ci --omit=dev');
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    execFileSync(npm, ['ci', '--omit=dev', '--no-audit', '--no-fund'], {
        cwd: bot,
        stdio: 'inherit',
        shell: process.platform === 'win32',
        // yt-dlp est rapporté à part, voir stageYtDlp.
        env: { ...process.env, YOUTUBE_DL_SKIP_DOWNLOAD: 'true' },
    });
}

/**
 * Rapporte yt-dlp à la place du `postinstall` de youtube-dl-exec.
 *
 * Celui-ci interroge l'API GitHub sans s'authentifier — il prévoit bien un
 * jeton, mais le passe à `fetch` hors de ses en-têtes —, et les runners
 * partagent leurs adresses : le quota de 60 requêtes par heure y est souvent
 * déjà épuisé, et la construction échouait au hasard (« API rate limit
 * exceeded »). Le lien de téléchargement direct de la dernière release ne
 * passe pas par l'API, donc par aucun quota. L'empreinte publiée avec la
 * release est vérifiée, comme pour Node.
 */
async function stageYtDlp(bot) {
    const file = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
    const base = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            log(`yt-dlp (${file})`);
            const [binary, sums] = await Promise.all([get(`${base}/${file}`), get(`${base}/SHA2-256SUMS`)]);
            const expected = sums.toString('utf8').split('\n')
                .map((line) => line.trim().split(/\s+/))
                .find(([, f]) => f === file)?.[0];
            const actual = crypto.createHash('sha256').update(binary).digest('hex');
            if (!expected || expected !== actual) throw new Error(`checksum mismatch for ${file}`);

            const dir = path.join(bot, 'node_modules', 'youtube-dl-exec', 'bin');
            fs.mkdirSync(dir, { recursive: true });
            const target = path.join(dir, file);
            fs.writeFileSync(target, binary);
            if (process.platform !== 'win32') fs.chmodSync(target, 0o755);
            log(`yt-dlp: ${(binary.length / 1048576).toFixed(1)} MB`);
            return;
        } catch (err) {
            lastError = err;
            log(`yt-dlp, attempt ${attempt} failed: ${err.message}`);
            await new Promise((resolve) => setTimeout(resolve, attempt * 5000));
        }
    }
    throw lastError;
}

/**
 * Le `tar` du système. Sous Windows, celui de System32 (bsdtar) : il lit les
 * .zip, et le `tar` de Git qui le précède souvent dans le PATH prend `C:` pour
 * un hôte distant.
 */
function tar(args) {
    const command = process.platform === 'win32'
        ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
        : 'tar';
    execFileSync(command, args, { stdio: 'inherit' });
}

function countEntries(dir) {
    let count = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        count++;
        if (entry.isDirectory()) count += countEntries(path.join(dir, entry.name));
    }
    return count;
}

async function main() {
    fs.rmSync(STAGING, { recursive: true, force: true });
    fs.mkdirSync(STAGING, { recursive: true });

    const version = await nodeVersion();
    await stageRuntime(version);
    stageBot();
    await stageYtDlp(path.join(STAGING, 'bot'));

    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
    const commit = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: REPO }).toString('utf8').trim();
    const manifest = {
        id: `${pkg.version}+${commit}+node-${version}+${process.platform}`,
        version: pkg.version,
        node: version,
        entries: fs.readdirSync(path.join(STAGING, 'bot')).sort(),
        files: countEntries(STAGING) + 2,
    };

    fs.mkdirSync(OUTPUT, { recursive: true });
    const archive = path.join(OUTPUT, 'bot.tar.gz');
    fs.rmSync(archive, { force: true });
    log('archive');
    tar(['-czf', archive, '-C', STAGING, 'runtime', 'bot']);
    fs.writeFileSync(path.join(OUTPUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    fs.rmSync(STAGING, { recursive: true, force: true });

    const size = (fs.statSync(archive).size / 1024 / 1024).toFixed(1);
    log(`${manifest.id} — ${manifest.files} entries, ${size} MB`);
}

main().catch((err) => {
    console.error(`[payload] ${err.stack || err.message}`);
    process.exit(1);
});

