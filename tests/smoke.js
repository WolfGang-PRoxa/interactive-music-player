/**
 * Test de fumée — vérifie qu'une modification transversale n'a rien cassé.
 *
 * Écrit pour accompagner le passage des identifiants du français à l'anglais :
 * un renommage ne lève aucune erreur tant que le code n'est pas exécuté, et ce
 * projet n'a pas de suite de tests. Deux étages, du moins cher au plus cher :
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

const RACINE = path.join(__dirname, '..');
require(path.join(RACINE, 'node_modules', 'dotenv')).config({ path: path.join(RACINE, '.env') });

/** Entrées qui démarrent le bot : à ne surtout pas charger en étage 1. */
const POINTS_ENTREE = ['src/index.js', 'src/deploy-commands.js'];

/**
 * Champs de premier niveau que le serveur place dans le message `state` et que
 * le tableau de bord lit.
 *
 * À METTRE À JOUR sciemment lorsqu'un champ du protocole est renommé — c'est
 * précisément le genre d'oubli que ce test existe pour attraper, un renommage
 * fait d'un seul côté ne produisant aucune erreur, juste un affichage vide.
 */
const CHAMPS_ETAT = [
    'guildId', 'selectedVoiceChannelId', 'guilds', 'currentTrack', 'progress',
    'isPlaying', 'isPaused', 'attenteAuditeur', 'repeatMode', 'volume',
    'settings', 'queue', 'history', 'playlists', 'speakers', 'members', 'botStats',
];

/**
 * Champs propres au message WebSocket, absents de la réponse HTTP.
 *
 * `pilote` dépend de la connexion qui le reçoit — il dit à ce tableau de bord
 * s'il est celui qui mène la lecture — et n'a donc aucun sens sur une requête
 * HTTP sans état.
 */
const CHAMPS_ETAT_WS = [...CHAMPS_ETAT, 'pilote'];

const PORT = Number(process.env.PORT) || 3000;
const DELAI_DEMARRAGE_MS = 60000;

let echecs = 0;
let reussites = 0;
const verifier = (libelle, ok, detail = '') => {
    if (ok) { reussites++; console.log(`  ok   ${libelle}${detail ? ` — ${detail}` : ''}`); }
    else { echecs++; console.log(`  ECHEC ${libelle}${detail ? ` — ${detail}` : ''}`); }
    return ok;
};

/** Tous les .js sous src/, chemins relatifs à la racine du projet, en POSIX. */
function listerModules() {
    const trouves = [];
    (function marcher(dossier) {
        for (const entree of fs.readdirSync(dossier, { withFileTypes: true })) {
            const complet = path.join(dossier, entree.name);
            if (entree.isDirectory()) marcher(complet);
            else if (entree.name.endsWith('.js')) {
                trouves.push(path.relative(RACINE, complet).split(path.sep).join('/'));
            }
        }
    })(path.join(RACINE, 'src'));
    return trouves.sort();
}

/** Jeton du tableau de bord, lu sur place — il ne transite par rien d'autre. */
function jeton() {
    const env = (process.env.DASHBOARD_TOKEN || '').trim();
    if (env) return env;
    return fs.readFileSync(path.join(RACINE, 'data', 'dashboard-token'), 'utf8').trim();
}

function requete(chemin, entetes = {}) {
    return new Promise((resolve, reject) => {
        const req = http.get(
            { host: '127.0.0.1', port: PORT, path: chemin, headers: entetes },
            (res) => {
                let corps = '';
                res.on('data', (c) => { corps += c; });
                res.on('end', () => resolve({ code: res.statusCode, corps, entetes: res.headers }));
            }
        );
        req.on('error', reject);
        req.setTimeout(15000, () => req.destroy(new Error('délai dépassé')));
    });
}

function attendre(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

// --- Étage 1 : chargement de tous les modules -------------------------------

function etageChargement() {
    console.log('\n=== 1. Chargement des modules ===\n');
    const modules = listerModules();
    let charges = 0;

    for (const relatif of modules) {
        if (POINTS_ENTREE.includes(relatif)) continue;
        // Le code du navigateur n'est pas du CommonJS : il n'a rien à faire ici.
        if (relatif.startsWith('src/web/public/')) continue;

        try {
            const mod = require(path.join(RACINE, relatif));
            if (mod === undefined || mod === null) {
                verifier(relatif, false, 'export vide');
            } else charges++;
        } catch (err) {
            verifier(relatif, false, err.message.split('\n')[0]);
        }
    }
    verifier(`${charges} modules chargés sans erreur`, echecs === 0);
    return charges;
}

// --- Étage 2 : le bot démarré pour de vrai ----------------------------------

async function etageIntegration() {
    console.log('\n=== 2. Démarrage du bot et interrogation ===\n');

    const bot = cp.spawn(process.execPath, ['src/index.js'], {
        cwd: RACINE, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });

    let sortie = '';
    bot.stdout.on('data', (d) => { sortie += d.toString(); });
    bot.stderr.on('data', (d) => { sortie += d.toString(); });

    const arreter = () => { try { bot.kill(); } catch (e) {} };

    try {
        // Prêt = le serveur web répond. Attendre le journal serait plus fragile.
        const limite = Date.now() + DELAI_DEMARRAGE_MS;
        let debout = false;
        while (Date.now() < limite) {
            try {
                await requete('/');
                debout = true;
                break;
            } catch (e) { await attendre(500); }
        }
        if (!verifier('le serveur web répond', debout, `port ${PORT}`)) return;

        verifier('le bot annonce être prêt', /Prêt !/.test(sortie));
        verifier('les commandes sont chargées', /commandes chargées/.test(sortie));
        verifier("aucune erreur d'extracteur au démarrage", !/\[ERROR\s*\].*[Ee]xtractor/.test(sortie));

        const sansJeton = await requete('/', { Accept: 'text/html' });
        verifier('accès refusé sans jeton', sansJeton.code === 401, `HTTP ${sansJeton.code}`);

        const t = jeton();
        const avecJeton = await requete(`/?token=${encodeURIComponent(t)}`, { Accept: 'text/html' });
        verifier('jeton accepté', avecJeton.code === 302 || avecJeton.code === 200, `HTTP ${avecJeton.code}`);

        const page = await requete('/', { Cookie: `dashboard_token=${t}` });
        verifier('le tableau de bord est servi', page.code === 200 && page.corps.includes('<title>'),
            `${page.corps.length} octets`);

        const etat = await requete('/api/state', { Cookie: `dashboard_token=${t}` });
        verifier('/api/state répond', etat.code === 200, `HTTP ${etat.code}`);

        if (etat.code === 200) {
            let donnees = null;
            try { donnees = JSON.parse(etat.corps); } catch (e) {}
            if (verifier('/api/state rend du JSON', !!donnees)) {
                const manquants = CHAMPS_ETAT.filter((c) => !(c in donnees));
                verifier('tous les champs du protocole sont présents',
                    manquants.length === 0,
                    manquants.length ? `manquants : ${manquants.join(', ')}` : `${CHAMPS_ETAT.length} champs`);
            }
        }

        await etageWebSocket(t);
    } finally {
        arreter();
        await attendre(1500);
    }
}

async function etageWebSocket(t) {
    const { WebSocket } = require(path.join(RACINE, 'node_modules', 'ws'));

    const message = await new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, {
            headers: { Cookie: `dashboard_token=${t}` },
        });
        const minuteur = setTimeout(() => { try { ws.close(); } catch (e) {} resolve(null); }, 20000);

        ws.on('message', (brut) => {
            try {
                const parse = JSON.parse(brut.toString());
                if (parse.type === 'state') {
                    clearTimeout(minuteur);
                    try { ws.close(); } catch (e) {}
                    resolve(parse);
                }
            } catch (e) {}
        });
        ws.on('error', () => { clearTimeout(minuteur); resolve(null); });
    });

    if (!verifier('le WebSocket délivre un message state', !!message)) return;

    const manquants = CHAMPS_ETAT_WS.filter((c) => !(c in message.data));
    verifier('le state du WebSocket porte tous les champs',
        manquants.length === 0,
        manquants.length ? `manquants : ${manquants.join(', ')}` : `${CHAMPS_ETAT_WS.length} champs`);

    // Un tableau de bord seul connecté est nécessairement le pilote : c'est la
    // garantie que l'élection a bien lieu, et non que le champ existe.
    verifier('le seul tableau de bord connecté est désigné pilote',
        message.data.pilote === true, String(message.data.pilote));
}

// --- Exécution --------------------------------------------------------------

(async () => {
    console.log('Test de fumée — interactive_music_player');

    etageChargement();
    if (echecs > 0) {
        console.log('\nChargement en échec : le démarrage est inutile tant que ce n\'est pas réglé.');
    } else {
        await etageIntegration();
    }

    console.log(`\n=== ${reussites} réussite(s), ${echecs} échec(s) ===`);
    process.exit(echecs === 0 ? 0 : 1);
})().catch((err) => {
    console.error('\nLe test de fumée a lui-même échoué :', err);
    process.exit(1);
});
