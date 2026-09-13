/**
 * Test de fumée — vérifie qu'une modification transversale n'a rien cassé.
 *
 * Écrit pour accompagner le passage des identifiants du français à l'anglais :
 * un renommage ne lève aucune erreur tant que le code n'est pas exécuté, et
 * aucune des autres suites ne charge le projet en entier. C'est resté sa raison
 * d'être — les quarante-neuf autres éprouvent chacune un point précis, celle-ci
 * est la seule à vérifier que le tout tient encore debout. Deux étages, du
 * moins cher au plus cher :
 *
 *   1. Chargement — chaque module de src/ est requis. Attrape les require()
 *      cassés, les exports disparus et les erreurs de syntaxe.
 *   2. Intégration — le bot est démarré pour de vrai, puis interrogé en HTTP
 *      et en WebSocket. Attrape ce que le chargement ne voit pas : un champ du
 *      protocole renommé d'un seul côté, une route qui ne répond plus.
 *
 * Usage : npm run smoke
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'node_modules', 'dotenv')).config({ path: path.join(ROOT, '.env') });

/** Entrées qui démarrent le bot : à ne surtout pas charger en étage 1. */
const ENTRY_POINTS = ['src/index.js', 'src/deploy-commands.js'];

/**
 * Champs de premier niveau que le serveur place dans le message `state` et que
 * le tableau de bord lit.
 *
 * À METTRE À JOUR sciemment lorsqu'un champ du protocole est renommé — c'est
 * précisément le genre d'oubli que ce test existe pour attraper, un renommage
 * fait d'un seul côté ne produisant aucune erreur, juste un affichage vide.
 */
const STATE_FIELDS = [
    'guildId', 'selectedVoiceChannelId', 'guilds', 'currentTrack', 'progress',
    'isPlaying', 'isPaused', 'listenerWait', 'repeatMode', 'volume',
    'settings', 'queue', 'history', 'playlists', 'speakers', 'members', 'botStats',
];

/**
 * Champs propres au message WebSocket, absents de la réponse HTTP.
 *
 * `pilote` dépend de la connexion qui le reçoit — il dit à ce tableau de bord
 * s'il est celui qui mène la lecture — et n'a donc aucun sens sur une requête
 * HTTP sans état.
 */
const WS_STATE_FIELDS = [...STATE_FIELDS, 'pilot'];

const PORT = Number(process.env.PORT) || 3000;
const STARTUP_TIMEOUT_MS = 60000;

let failed = 0;
let passed = 0;
const check = (label, ok, detail = '') => {
    if (ok) { passed++; console.log(`  ok   ${label}${detail ? ` — ${detail}` : ''}`); }
    else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
    return ok;
};

/** Tous les .js sous src/, chemins relatifs à la racine du projet, en POSIX. */
function listModules() {
    const found = [];
    (function walk(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(fullPath);
            else if (entry.name.endsWith('.js')) {
                found.push(path.relative(ROOT, fullPath).split(path.sep).join('/'));
            }
        }
    })(path.join(ROOT, 'src'));
    return found.sort();
}

/** Jeton du tableau de bord, lu sur place — il ne transite par rien d'autre. */
function token() {
    const env = (process.env.DASHBOARD_TOKEN || '').trim();
    if (env) return env;
    return fs.readFileSync(path.join(ROOT, 'data', 'dashboard-token'), 'utf8').trim();
}

function request(filePath, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = http.get(
            { host: '127.0.0.1', port: PORT, path: filePath, headers: headers },
            (res) => {
                let fakeBody = '';
                res.on('data', (c) => { fakeBody += c; });
                res.on('end', () => resolve({ code: res.statusCode, fakeBody, headers: res.headers }));
            }
        );
        req.on('error', reject);
        req.setTimeout(15000, () => req.destroy(new Error('timed out')));
    });
}

function waitFor(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

// --- Étage 1 : chargement de tous les modules -------------------------------

function stageLoading() {
    console.log('\n=== 1. Loading the modules ===\n');
    const modules = listModules();
    let loaded = 0;

    for (const relative of modules) {
        if (ENTRY_POINTS.includes(relative)) continue;
        // Le code du navigateur n'est pas du CommonJS : il n'a rien à faire ici.
        if (relative.startsWith('src/web/public/')) continue;

        try {
            const mod = require(path.join(ROOT, relative));
            if (mod === undefined || mod === null) {
                check(relative, false, 'empty export');
            } else loaded++;
        } catch (err) {
            check(relative, false, err.message.split('\n')[0]);
        }
    }
    check(`${loaded} modules loaded without error`, failed === 0);
    return loaded;
}

// --- Étage 2 : le bot démarré pour de vrai ----------------------------------

async function stageIntegration() {
    console.log('\n=== 2. Starting the bot and querying it ===\n');

    const bot = cp.spawn(process.execPath, ['src/index.js'], {
        cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });

    let output = '';
    bot.stdout.on('data', (d) => { output += d.toString(); });
    bot.stderr.on('data', (d) => { output += d.toString(); });

    const stop = () => { try { bot.kill(); } catch (e) {} };

    try {
        // Prêt = le serveur web répond. Attendre le journal serait plus fragile.
        const limit = Date.now() + STARTUP_TIMEOUT_MS;
        let alive = false;
        while (Date.now() < limit) {
            try {
                await request('/');
                alive = true;
                break;
            } catch (e) { await waitFor(500); }
        }
        if (!check('the web server answers', alive, `port ${PORT}`)) return;

        check('the bot announces it is ready', /Ready!/.test(output));
        check('the commands are loaded', /commands loaded/.test(output));
        check('no extractor error at startup', !/\[ERROR\s*\].*[Ee]xtractor/.test(output));

        /*
         * Sans jeton ni session, le tableau de bord ne part pas. Deux réponses
         * le disent, et il faut les accepter toutes deux.
         *
         * La porte tente d'abord de reconnaître son visiteur sans le déranger —
         * voir `shouldTrySilentLogin` dans web/auth.js : un invité déjà accepté
         * n'a pas à recliquer « Se connecter » à chaque venue. Elle ne sert sa
         * page de refus qu'une fois cet essai manqué. Une installation dont
         * l'application Discord n'est pas configurée n'a rien à tenter et refuse
         * tout de suite.
         *
         * Ce qui ne doit jamais arriver, dans un cas comme dans l'autre, c'est
         * que la page du tableau de bord soit servie. C'est cela, le contrat —
         * le code de retour n'en est que la forme.
         */
        const withoutToken = await request('/', { Accept: 'text/html' });
        const bounced = withoutToken.code === 302
            && /^\/auth\/discord\?silent=1/.test(withoutToken.headers.location || '');
        check('no dashboard without a token',
            (withoutToken.code === 401 || bounced)
            && !withoutToken.fakeBody.includes('id="dashboard-grid"'),
            `HTTP ${withoutToken.code}`
            + (bounced ? ` → ${withoutToken.headers.location}` : ''));

        /*
         * Et l'essai muet ne se retente pas. Le rappel revient marqué de
         * `login=manual` après un refus de Discord ; cette marque doit donner la
         * page de refus, et non une seconde redirection — sans quoi le
         * navigateur tournerait en rond entre les deux.
         */
        const retried = await request('/?login=manual', { Accept: 'text/html' });
        check('  … and a failed silent attempt lands on the refusal page',
            retried.code === 401, `HTTP ${retried.code}`);

        const t = token();
        const withToken = await request(`/?token=${encodeURIComponent(t)}`, { Accept: 'text/html' });
        check('token accepted', withToken.code === 302 || withToken.code === 200, `HTTP ${withToken.code}`);

        const page = await request('/', { Cookie: `dashboard_token=${t}` });
        check('the dashboard is served', page.code === 200 && page.fakeBody.includes('<title>'),
            `${page.fakeBody.length} octets`);

        const state = await request('/api/state', { Cookie: `dashboard_token=${t}` });
        check('/api/state answers', state.code === 200, `HTTP ${state.code}`);

        if (state.code === 200) {
            let data = null;
            try { data = JSON.parse(state.fakeBody); } catch (e) {}
            if (check('/api/state returns JSON', !!data)) {
                const missing = STATE_FIELDS.filter((c) => !(c in data));
                check('every protocol field is present',
                    missing.length === 0,
                    missing.length ? `missing: ${missing.join(', ')}` : `${STATE_FIELDS.length} fields`);

                // La destination du champ d'ajout traverse l'état : c'est par là
                // qu'elle revient au tableau de bord après un rechargement, et
                // le seul endroit où l'on constate qu'elle y arrive vraiment.
                check('the add destination travels with the settings',
                    !!data.settings && typeof data.settings.addTarget === 'string',
                    String(data.settings && data.settings.addTarget));
            }
        }

        await stageWebSocket(t);
    } finally {
        stop();
        await waitFor(1500);
    }
}

async function stageWebSocket(t) {
    const { WebSocket } = require(path.join(ROOT, 'node_modules', 'ws'));

    const message = await new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, {
            headers: { Cookie: `dashboard_token=${t}` },
        });
        const timer = setTimeout(() => { try { ws.close(); } catch (e) {} resolve(null); }, 20000);

        ws.on('message', (raw) => {
            try {
                const parse = JSON.parse(raw.toString());
                if (parse.type === 'state') {
                    clearTimeout(timer);
                    try { ws.close(); } catch (e) {}
                    resolve(parse);
                }
            } catch (e) {}
        });
        ws.on('error', () => { clearTimeout(timer); resolve(null); });
    });

    if (!check('the WebSocket delivers a state message', !!message)) return;

    const missing = WS_STATE_FIELDS.filter((c) => !(c in message.data));
    check('the WebSocket state carries every field',
        missing.length === 0,
        missing.length ? `missing: ${missing.join(', ')}` : `${WS_STATE_FIELDS.length} fields`);

    // Un tableau de bord seul connecté est nécessairement le pilote : c'est la
    // garantie que l'élection a bien lieu, et non que le champ existe.
    check('the only connected dashboard is designated pilot',
        message.data.pilot === true, String(message.data.pilot));
}

// --- Exécution --------------------------------------------------------------

(async () => {
    console.log('Smoke test — interactive-music-player');

    stageLoading();
    if (failed > 0) {
        console.log('\nLoading failed: starting up is pointless until this is fixed.');
    } else {
        await stageIntegration();
    }

    console.log(`\n=== ${passed} passed, ${failed} failed ===`);
    process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
    console.error('\nThe smoke test itself failed:', err);
    process.exit(1);
});
