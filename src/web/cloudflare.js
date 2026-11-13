/**
 * cloudflare — Le partage du tableau de bord sur l'internet, par un tunnel
 * Cloudflare.
 *
 * ## Ce que ça remplace
 *
 * Le partage passait par un Funnel Tailscale, et demandait quatre gestes que
 * rien n'annonçait : installer Tailscale avec les droits administrateur, créer
 * un compte, obtenir du réseau le droit de publier, monter le Funnel. Chaque
 * utilisateur du bot devait refaire les quatre.
 *
 * ## L'approche
 *
 * `cloudflared` est un exécutable unique : il ne s'installe pas, il se pose
 * quelque part et se lance. Le bot peut donc le télécharger lui-même, dans
 * `data/bin/`, sans droits particuliers. Ensuite, deux modes :
 *
 *  - **Le partage rapide**, par défaut. Aucun compte : `cloudflared` ouvre un
 *    tunnel et Cloudflare lui attribue une adresse `https://….trycloudflare.com`.
 *    Elle change à chaque lancement, ce qui ne gêne pas les invités — le lien
 *    leur est posté par le bot — mais gênerait Discord, qui exige une adresse
 *    de retour fixe. Le relais (oauthRelay.js) s'en charge.
 *
 *  - **L'adresse fixe**, en option. Qui possède un domaine chez Cloudflare crée
 *    un tunnel nommé dans son tableau de bord, colle son jeton dans
 *    `CLOUDFLARE_TUNNEL_TOKEN` et l'adresse dans `PUBLIC_URL`. Le bot fait
 *    tourner ce tunnel-là à la place.
 *
 * ## Ce module constate, et n'agit que sur demande
 *
 * Comme celui qu'il remplace, il répond « voici où tu en es, et voici ce qui
 * manque ». Publier expose le tableau de bord à l'internet entier : ça ne se
 * fait jamais sans un geste du maître. Une fois ce geste fait, il est retenu
 * (`data/tunnel.json`) et le tunnel se rouvre au lancement suivant — c'est ce
 * que faisait le Funnel, qui survivait aux redémarrages du bot.
 *
 * Le tunnel vit avec le processus du bot : il s'arrête avec lui.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const log = require('../utils/logger');

/** États possibles, du plus démuni au plus complet. */
const STEP = {
    /** `cloudflared` est introuvable : il reste à le télécharger. */
    ABSENT: 'absent',
    /** Le téléchargement est en cours. */
    DOWNLOADING: 'downloading',
    /** Adresse fixe demandée (jeton présent), mais aucune adresse déclarée. */
    NEEDS_ADDRESS: 'needsAddress',
    /** Tout est en place ; le tunnel reste à ouvrir. */
    READY: 'ready',
    /** Le tunnel est lancé, Cloudflare n'a pas encore confirmé. */
    STARTING: 'starting',
    /** Le tableau de bord est joignable depuis l'internet. */
    SERVING: 'serving',
    /** Le tunnel s'est arrêté sans qu'on le lui demande. */
    FAILED: 'failed',
};

const MODE = { QUICK: 'quick', NAMED: 'named' };

const DATA_DIR = path.join(process.cwd(), 'data');
const BIN_DIR = path.join(DATA_DIR, 'bin');
const MEMORY_FILE = path.join(DATA_DIR, 'tunnel.json');

const EXE = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';

/**
 * Emplacements où chercher la commande, après `data/bin/`.
 *
 * Quelqu'un qui a déjà installé `cloudflared` — par winget, Homebrew, un
 * paquet — n'a pas à le retélécharger.
 */
const KNOWN_PATHS = {
    win32: [
        'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
        'C:\\Program Files\\cloudflared\\cloudflared.exe',
    ],
    darwin: ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared'],
    linux: ['/usr/bin/cloudflared', '/usr/local/bin/cloudflared'],
};

/** Le temps laissé à Cloudflare pour confirmer un tunnel, avant d'en rendre compte. */
const START_WAIT_MS = 25000;

/** Plafond d'un téléchargement : l'exécutable pèse quelques dizaines de Mo. */
const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;

/**
 * L'adresse d'un tunnel rapide, telle que `cloudflared` l'écrit.
 *
 * `api.trycloudflare.com` est le service qui les attribue : il paraît dans les
 * erreurs, et n'est jamais l'adresse du tunnel.
 */
const QUICK_URL = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/i;

/** La ligne qui dit qu'une connexion vers Cloudflare est établie. */
const CONNECTED = /Registered tunnel connection|Connection [0-9a-f-]+ registered/i;

/* ═════════════════════ Où est la commande ═════════════════════ */

/**
 * Chemin de la commande, ou null.
 *
 * Rien n'est retenu : on peut la télécharger, ou l'installer à la main, pendant
 * que le bot tourne.
 *
 * @returns {string|null}
 */
function cliPath() {
    const forced = (process.env.CLOUDFLARED_PATH || '').trim();
    const candidates = [
        ...(forced ? [forced] : []),
        path.join(BIN_DIR, EXE),
        ...(KNOWN_PATHS[process.platform] || []),
    ];
    for (const candidate of candidates) {
        try {
            if (fs.statSync(candidate).isFile()) return candidate;
        } catch (e) { /* absent */ }
    }

    // Le PATH en dernier : un chemin connu est plus sûr qu'un homonyme.
    for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
        const candidate = path.join(dir, EXE);
        try {
            if (fs.statSync(candidate).isFile()) return candidate;
        } catch (e) { /* un PATH peut contenir n'importe quoi */ }
    }
    return null;
}

/**
 * Où prendre l'exécutable, pour cette machine-ci.
 *
 * Windows et Linux ont un fichier unique, publié par Cloudflare sur GitHub : le
 * bot le rapporte lui-même. macOS ne le distribue qu'en archive, et passe par
 * Homebrew : la page officielle reste le bon endroit.
 *
 * @param {string} [platform]
 * @param {string} [arch]
 * @returns {{ url: string, direct: boolean }}
 */
function installer(platform = process.platform, arch = process.arch) {
    const base = 'https://github.com/cloudflare/cloudflared/releases/latest/download/';
    if (platform === 'win32') {
        // Pas de version ARM pour Windows : l'émulation fait tourner celle-ci.
        return { url: `${base}cloudflared-windows-${arch === 'ia32' ? '386' : 'amd64'}.exe`, direct: true };
    }
    if (platform === 'linux') {
        const name = { x64: 'amd64', arm64: 'arm64', arm: 'arm', ia32: '386' }[arch];
        if (name) return { url: `${base}cloudflared-linux-${name}`, direct: true };
    }
    return {
        url: 'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/',
        direct: false,
    };
}

/* ═════════════════════ Le mode ═════════════════════ */

/** Le jeton d'un tunnel nommé, ou ''. Il ne quitte jamais ce module. */
function tunnelToken() {
    return (process.env.CLOUDFLARE_TUNNEL_TOKEN || '').trim();
}

function declaredUrl() {
    return (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
}

function currentMode() {
    return tunnelToken() ? MODE.NAMED : MODE.QUICK;
}

/* ═════════════════════ Le souvenir du geste ═════════════════════ */

function remembered() {
    try {
        return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8')).published === true;
    } catch (e) {
        return false;
    }
}

function remember(published) {
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(MEMORY_FILE, JSON.stringify({ published }, null, 2));
    } catch (err) {
        log.warn(`[Tunnel] Cannot remember the sharing choice: ${err.message}`);
    }
}

/* ═════════════════════ Le processus ═════════════════════ */

/**
 * Ce que l'on sait du tunnel en cours.
 *
 * `phase` : idle (rien ne tourne), starting, up, exited (arrêté de lui-même).
 */
const run = {
    phase: 'idle',
    mode: null,
    url: null,
    connected: false,
    error: null,
    child: null,
    stopping: false,
};

/** Pour qui attend la confirmation d'un lancement. */
let waiters = [];

/** Le téléchargement en cours, s'il y en a un. */
let downloading = null;

function settleWaiters() {
    const pending = waiters;
    waiters = [];
    pending.forEach((resolve) => resolve());
}

/**
 * Lit ce que `cloudflared` raconte.
 *
 * Il écrit tout sur la sortie d'erreur, au fil de l'eau : l'adresse attribuée
 * au tunnel rapide, puis une ligne par connexion établie. La dernière erreur
 * est retenue pour dire pourquoi, si le tunnel tombe.
 *
 * @param {string} text
 */
function readOutput(text) {
    for (const line of String(text).split(/\r?\n/)) {
        if (!line.trim()) continue;

        if (run.mode === MODE.QUICK && !run.url) {
            const found = QUICK_URL.exec(line);
            if (found) run.url = found[0].toLowerCase();
        }
        if (CONNECTED.test(line)) run.connected = true;
        if (/\bERR\b|error=|failed to/i.test(line)) {
            // Sans l'horodatage ni le niveau : c'est la cause qu'on veut lire.
            run.error = line.replace(/^\S+\s+(ERR|WRN|INF)\s+/, '').trim().slice(0, 300);
        }
    }

    const ready = run.connected && (run.mode === MODE.NAMED || run.url);
    if (ready && run.phase === 'starting') {
        run.phase = 'up';
        run.error = null;
        log.success(`[Tunnel] Dashboard published on the internet at ${sharedUrl()}`);
        settleWaiters();
    }
}

/**
 * Les arguments de la commande, sans le jeton.
 *
 * Le jeton passe par l'environnement (`TUNNEL_TOKEN`, que `cloudflared` lit
 * de lui-même) : sur la ligne de commande, n'importe quel processus de la
 * machine le lirait dans la liste des tâches.
 *
 * @param {string} mode
 * @param {number} port
 * @returns {string[]}
 */
function commandArgs(mode, port) {
    if (mode === MODE.NAMED) return ['tunnel', '--no-autoupdate', 'run'];
    return ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`];
}

/**
 * Ouvre le tunnel, et attend que Cloudflare le confirme.
 *
 * Cet appel doit rester déclenché par un geste : il publie sur l'internet.
 *
 * @param {number} port
 * @param {{ waitMs?: number }} [options]
 * @returns {Promise<{ ok: boolean, error: string|null }>}
 */
async function mount(port, { waitMs = START_WAIT_MS } = {}) {
    if (run.phase === 'starting' || run.phase === 'up') return { ok: true, error: null };

    const bin = cliPath();
    if (!bin) return { ok: false, error: 'cloudflared introuvable' };

    const mode = currentMode();
    if (mode === MODE.NAMED && !declaredUrl()) {
        return { ok: false, error: 'PUBLIC_URL manquante pour le tunnel nommé' };
    }

    Object.assign(run, {
        phase: 'starting', mode, url: null, connected: false, error: null, stopping: false,
    });

    const env = { ...process.env };
    if (mode === MODE.NAMED) env.TUNNEL_TOKEN = tunnelToken();
    else delete env.TUNNEL_TOKEN;

    let child;
    try {
        child = spawn(bin, commandArgs(mode, port), {
            env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        });
    } catch (err) {
        Object.assign(run, { phase: 'exited', error: err.message, child: null });
        return { ok: false, error: err.message };
    }
    run.child = child;

    child.stdout.on('data', readOutput);
    child.stderr.on('data', readOutput);
    child.on('error', (err) => {
        run.error = err.message;
    });
    child.on('exit', (code) => {
        if (run.child !== child) return;
        const deliberate = run.stopping;
        Object.assign(run, {
            phase: deliberate ? 'idle' : 'exited',
            child: null,
            url: null,
            connected: false,
            error: deliberate ? null : (run.error || `cloudflared stopped (code ${code})`),
        });
        if (!deliberate) log.warn(`[Tunnel] The tunnel stopped by itself: ${run.error}`);
        settleWaiters();
    });

    remember(true);

    await new Promise((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, waitMs).unref?.();
    });

    if (run.phase === 'up') return { ok: true, error: null };
    if (run.phase === 'exited') return { ok: false, error: run.error };
    // Toujours en attente : ce n'est pas un échec, Cloudflare peut être lent.
    return { ok: true, error: null };
}

/**
 * Ferme le tunnel, et oublie qu'il fallait le rouvrir.
 * @returns {Promise<{ ok: boolean, error: string|null }>}
 */
async function unmount() {
    remember(false);
    const child = run.child;
    if (!child) {
        Object.assign(run, { phase: 'idle', url: null, connected: false, error: null });
        return { ok: true, error: null };
    }

    run.stopping = true;
    await new Promise((resolve) => {
        child.once('exit', resolve);
        child.kill();
        // Un processus figé ne doit pas tenir la fenêtre en otage.
        setTimeout(() => {
            try { child.kill('SIGKILL'); } catch (e) { /* déjà parti */ }
            resolve();
        }, 5000).unref?.();
    });
    log.info('[Tunnel] Dashboard withdrawn from the internet.');
    return { ok: true, error: null };
}

/** Le tunnel meurt avec le bot : rien ne doit survivre à son propriétaire. */
process.on('exit', () => {
    if (run.child) {
        try { run.child.kill(); } catch (e) { /* déjà parti */ }
    }
});

/* ═════════════════════ Le téléchargement ═════════════════════ */

/**
 * Rapporte `cloudflared` dans `data/bin/`.
 *
 * Le fichier ne prend son nom qu'une fois complet : un téléchargement coupé ne
 * laisse pas un exécutable tronqué que le constat suivant prendrait pour bon.
 *
 * @returns {Promise<{ ok: boolean, error: string|null }>}
 */
function download() {
    if (downloading) return downloading;

    const source = installer();
    if (!source.direct) {
        return Promise.resolve({ ok: false, error: 'pas de téléchargement direct sur ce système' });
    }

    downloading = (async () => {
        const target = path.join(BIN_DIR, EXE);
        const partial = `${target}.part`;
        try {
            fs.mkdirSync(BIN_DIR, { recursive: true });
            const response = await fetch(source.url, { redirect: 'follow' });
            if (!response.ok || !response.body) {
                throw new Error(`HTTP ${response.status}`);
            }

            const out = fs.createWriteStream(partial);
            let received = 0;
            try {
                for await (const chunk of response.body) {
                    received += chunk.length;
                    if (received > MAX_DOWNLOAD_BYTES) throw new Error('fichier anormalement gros');
                    if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
                }
            } finally {
                await new Promise((r) => out.end(r));
            }
            if (received === 0) throw new Error('fichier vide');

            fs.chmodSync(partial, 0o755);
            fs.renameSync(partial, target);
            log.success(`[Tunnel] cloudflared downloaded (${Math.round(received / 1024 / 1024)} MB).`);
            return { ok: true, error: null };
        } catch (err) {
            try { fs.unlinkSync(partial); } catch (e) { /* rien à effacer */ }
            log.warn(`[Tunnel] Cannot download cloudflared: ${err.message}`);
            return { ok: false, error: err.message };
        } finally {
            downloading = null;
        }
    })();
    return downloading;
}

/* ═════════════════════ Le constat ═════════════════════ */

/**
 * L'adresse du partage en cours, ou null.
 *
 * Celle du tunnel rapide quand il est confirmé ; l'adresse déclarée pour un
 * tunnel nommé, qui ne la connaît pas lui-même — elle vit dans le tableau de
 * bord Cloudflare.
 *
 * @returns {string|null}
 */
function sharedUrl() {
    if (run.phase !== 'up') return null;
    if (run.mode === MODE.NAMED) return declaredUrl() || null;
    return run.url;
}

/**
 * La décision, séparée de ce qui la nourrit.
 *
 * Une fonction pure de ce qui a été constaté : c'est ce qui permet d'éprouver
 * chaque état sans télécharger `cloudflared`, ni ouvrir de tunnel.
 *
 * @param {{ cli: string|null, downloading?: boolean, mode: string,
 *   declaredUrl?: string, run: { phase: string, url?: string|null, error?: string|null } }} seen
 * @returns {object}
 */
function decide(seen) {
    const mode = seen.mode;
    const fixed = seen.declaredUrl || null;

    if (!seen.cli) {
        return { step: seen.downloading ? STEP.DOWNLOADING : STEP.ABSENT, mode };
    }
    if (mode === MODE.NAMED && !fixed) return { step: STEP.NEEDS_ADDRESS, mode };

    const current = seen.run || { phase: 'idle' };
    const publicUrl = mode === MODE.NAMED ? fixed : (current.url || null);

    switch (current.phase) {
        case 'starting':
            return { step: STEP.STARTING, mode, publicUrl: mode === MODE.NAMED ? fixed : null };
        case 'up':
            return { step: STEP.SERVING, mode, publicUrl };
        case 'exited':
            return { step: STEP.FAILED, mode, detail: current.error || null };
        default:
            return { step: STEP.READY, mode, publicUrl: mode === MODE.NAMED ? fixed : null };
    }
}

/**
 * Où en est cette machine, et que lui manque-t-il.
 *
 * Rien n'est lancé pour le savoir : tout est déjà dans ce processus. La
 * fenêtre peut donc le demander aussi souvent qu'elle veut.
 *
 * @returns {object}
 */
function inspect() {
    const cli = cliPath();
    const state = decide({
        cli,
        downloading: Boolean(downloading),
        mode: currentMode(),
        declaredUrl: declaredUrl(),
        run,
    });
    if (state.step === STEP.ABSENT) state.installer = installer();
    return state;
}

/**
 * Dit au journal où en est le partage, et rouvre le tunnel si le maître l'avait
 * ouvert avant l'arrêt du bot.
 *
 * Une ligne par état, qui porte l'action plutôt que le constat.
 *
 * @param {number} port
 * @returns {Promise<object>} L'état après l'éventuelle réouverture.
 */
async function announce(port) {
    const state = inspect();

    if (remembered() && (state.step === STEP.READY || state.step === STEP.FAILED)) {
        log.info('[Tunnel] The dashboard was shared before the restart: reopening the tunnel.');
        const res = await mount(port);
        if (!res.ok) log.warn(`[Tunnel] Cannot reopen the tunnel: ${res.error}`);
        return inspect();
    }

    switch (state.step) {
        case STEP.ABSENT:
            log.info('[Tunnel] The dashboard stays on this machine. To share it from outside, '
                + 'open the sharing window of the dashboard: it downloads cloudflared and '
                + 'opens the tunnel, no account needed.');
            break;
        case STEP.NEEDS_ADDRESS:
            log.warn('[Tunnel] CLOUDFLARE_TUNNEL_TOKEN is set but PUBLIC_URL is not: write in '
                + 'PUBLIC_URL the address given to this tunnel in the Cloudflare dashboard.');
            break;
        case STEP.READY:
            log.info('[Tunnel] Everything is in place to share the dashboard; the tunnel is not '
                + 'open. Opening it publishes the dashboard on the public internet, so it '
                + 'waits for a deliberate go-ahead.');
            break;
        default:
            break;
    }
    return state;
}

module.exports = {
    STEP,
    MODE,
    cliPath,
    installer,
    commandArgs,
    decide,
    inspect,
    announce,
    download,
    mount,
    unmount,
    sharedUrl,
    // Pour les tests : lire la sortie de cloudflared sans le lancer.
    _readOutput: readOutput,
    _run: run,
};
