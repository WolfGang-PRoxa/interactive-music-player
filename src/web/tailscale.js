/**
 * tailscale — Le partage du tableau de bord sur l'internet, constaté et non deviné.
 *
 * ## Le problème
 *
 * Ouvrir le tableau de bord à l'extérieur demande aujourd'hui quatre gestes que
 * rien n'annonce : installer Tailscale, authentifier la machine, obtenir du
 * tailnet le droit de publier, puis monter le Funnel. Chacun échoue à sa façon,
 * et aucun ne dit ce qui manque — on découvre l'étape suivante en butant dessus.
 *
 * Pire : l'adresse publique qui en résulte doit être recopiée à la main dans
 * `PUBLIC_URL`, et cette copie voyage avec le dépôt. Une installation sur une
 * seconde machine hérite ainsi de l'adresse de la première, et l'aller-retour
 * de connexion Discord renvoie l'utilisateur sur l'ordinateur d'à côté.
 *
 * ## L'approche
 *
 * Ce module ne fait rien tout seul : il **constate**. Il répond « voici où tu en
 * es, et voici ce qui manque », dans un vocabulaire que l'interface peut
 * traduire en une phrase. Les gestes qui s'automatisent lui sont demandés
 * explicitement, un par un.
 *
 * Trois choses ne s'automatisent pas, et il vaut mieux le dire que le
 * contourner :
 *
 *  - **L'installation** exige les droits administrateur. Un service en compte
 *    utilisateur ne les prend pas sans une invite du système.
 *  - **Le compte Tailscale** ne se crée par aucune API. Une clé d'authentifi-
 *    cation lève l'interactivité, mais il faut déjà un compte pour l'émettre.
 *  - **Le droit de publier** (`funnel`, `https`) est accordé par la politique du
 *    tailnet, donc depuis la console d'administration.
 *
 * ## Ce que le Funnel fait, et pourquoi il ne se monte pas tout seul
 *
 * Il expose le tableau de bord à l'internet entier, pas au réseau local. Le
 * monter sans l'avoir demandé publierait le lecteur de quelqu'un à son insu :
 * c'est la seule étape que ce module refuse de faire par défaut, même quand tout
 * est prêt. `mount()` existe, il faut l'appeler.
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const log = require('../utils/logger');

/**
 * États possibles, du plus démuni au plus complet.
 *
 * Ils sont ordonnés : chacun suppose le précédent acquis, et l'interface peut
 * donc les présenter comme une progression plutôt que comme un diagnostic.
 */
const STEP = {
    /** La commande `tailscale` est introuvable. */
    ABSENT: 'absent',
    /** Installée, mais le démon ne répond pas. */
    UNREACHABLE: 'unreachable',
    /** Installée, machine non authentifiée sur un tailnet. */
    NEEDS_LOGIN: 'needsLogin',
    /** Authentifiée, mais le tailnet ne lui accorde pas le droit de publier. */
    NEEDS_CAPABILITY: 'needsCapability',
    /** Tout est en place ; le Funnel reste à monter. */
    READY: 'ready',
    /** Le Funnel publie bien ce tableau de bord. */
    SERVING: 'serving',
    /** Le Funnel publie autre chose : ne pas l'écraser sans le dire. */
    OTHER_TARGET: 'otherTarget',
};

/**
 * Emplacements où chercher la commande, quand le PATH ne la porte pas encore.
 *
 * Une installation fraîche ne met pas à jour le PATH des processus déjà lancés :
 * le bot démarré avant elle ne verrait rien, et l'utilisateur croirait
 * l'installation ratée. Chercher aux emplacements connus évite ce faux négatif.
 */
const KNOWN_PATHS = {
    win32: [
        'C:\\Program Files\\Tailscale\\tailscale.exe',
        'C:\\Program Files (x86)\\Tailscale\\tailscale.exe',
    ],
    darwin: [
        '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
        '/usr/local/bin/tailscale',
        '/opt/homebrew/bin/tailscale',
    ],
    linux: ['/usr/bin/tailscale', '/usr/local/bin/tailscale'],
};

/** Une commande qui traîne vaut une commande absente : le démon peut être figé. */
const TIMEOUT_MS = 8000;

let cachedPath;

/**
 * Chemin de la commande, ou null.
 *
 * Le résultat est retenu, mais l'échec ne l'est pas : on peut installer
 * Tailscale pendant que le bot tourne, et c'est même le cas nominal quand
 * l'utilisateur suit les instructions sans redémarrer.
 */
function cliPath() {
    if (cachedPath) return cachedPath;

    for (const candidate of KNOWN_PATHS[process.platform] || []) {
        if (fs.existsSync(candidate)) {
            cachedPath = candidate;
            return cachedPath;
        }
    }

    // Le PATH en dernier : un chemin connu est plus sûr qu'un homonyme.
    const name = process.platform === 'win32' ? 'tailscale.exe' : 'tailscale';
    const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    for (const dir of dirs) {
        const candidate = path.join(dir, name);
        try {
            if (fs.existsSync(candidate)) {
                cachedPath = candidate;
                return cachedPath;
            }
        } catch (e) { /* un PATH peut contenir n'importe quoi */ }
    }

    return null;
}

/**
 * Exécute la commande et rend sa sortie, sans jamais rejeter.
 *
 * Les échecs sont des états, pas des accidents : « non authentifié » sort en
 * code d'erreur, et le traiter comme une exception obligerait chaque appelant à
 * rattraper ce qui est une réponse ordinaire.
 *
 * @returns {Promise<{ ok: boolean, stdout: string, stderr: string }>}
 */
function run(args) {
    const bin = cliPath();
    if (!bin) return Promise.resolve({ ok: false, stdout: '', stderr: 'tailscale introuvable' });

    return new Promise((resolve) => {
        execFile(bin, args, { timeout: TIMEOUT_MS, windowsHide: true },
            (err, stdout, stderr) => resolve({
                ok: !err,
                stdout: String(stdout || ''),
                stderr: String(stderr || ''),
            }));
    });
}

function parseJson(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
}

/**
 * Où prendre l'installateur, pour cette machine-ci.
 *
 * Windows a un fichier qu'on peut tendre directement : servi en pièce jointe, le
 * clic lance le téléchargement sans quitter le tableau de bord. C'est une étape
 * de moins qu'une page où il faut encore trouver le bon bouton, et surtout le
 * bon processeur — l'ARM et l'x86 n'ont pas le même paquet, et se tromper mène à
 * une installation qui refuse de démarrer sans dire pourquoi.
 *
 * macOS passe par l'App Store et Linux par un script à coller dans un terminal :
 * il n'y a là aucun fichier à tendre, et la page officielle reste le bon endroit.
 *
 * @returns {{ url: string, direct: boolean }}
 */
function installer() {
    if (process.platform === 'win32') {
        return {
            url: process.arch === 'arm64'
                ? 'https://pkgs.tailscale.com/stable/tailscale-setup-latest-arm64.msi'
                : 'https://pkgs.tailscale.com/stable/tailscale-setup-latest.exe',
            direct: true,
        };
    }
    return { url: 'https://tailscale.com/download', direct: false };
}

/** `machine.tailnet.ts.net.` → `https://machine.tailnet.ts.net` */
function publicUrlFrom(dnsName) {
    const host = String(dnsName || '').replace(/\.$/, '');
    return host ? `https://${host}` : null;
}

/**
 * La décision, séparée de ce qui la nourrit.
 *
 * Toute la logique tient ici, sur deux objets déjà lus : c'est ce qui permet de
 * l'éprouver sur les six états sans installer Tailscale, ni le déconnecter, ni
 * retirer un droit au tailnet pour voir ce que ça donne. `inspect()` ne fait
 * plus que porter les seaux.
 *
 * @param {object|null} state - `tailscale status --json`, déjà analysé.
 * @param {object|null} funnel - `tailscale funnel status --json`, déjà analysé.
 * @param {number} port
 * @returns {object}
 */
function decide(state, funnel, port) {
    if (!state) return { step: STEP.UNREACHABLE };

    const backend = state.BackendState || 'NoState';
    if (backend !== 'Running') {
        // « NeedsLogin », « Stopped », « NoState » : dans tous les cas la
        // machine n'est pas encore sur un tailnet, et la suite n'a pas de sens.
        return { step: STEP.NEEDS_LOGIN, backendState: backend };
    }

    const self = state.Self || {};
    const caps = (self.Capabilities || []).map(String);
    const canFunnel = caps.includes('funnel');
    const canHttps = caps.includes('https');
    const dnsName = self.DNSName || '';
    const publicUrl = publicUrlFrom(dnsName);

    if (!canFunnel || !canHttps) {
        return {
            step: STEP.NEEDS_CAPABILITY,
            publicUrl, canFunnel, canHttps,
            // Le nom du tailnet sert à composer le lien exact de la console.
            tailnet: state.MagicDNSSuffix || null,
        };
    }

    const open = funnel || {};
    const host = publicUrl ? publicUrl.replace(/^https:\/\//, '') : '';
    const key = `${host}:443`;
    const on = Boolean((open.AllowFunnel || {})[key]);
    const proxy = ((((open.Web || {})[key] || {}).Handlers || {})['/'] || {}).Proxy || null;

    if (!on) return { step: STEP.READY, publicUrl, port };

    // Un Funnel déjà monté vers un autre service n'est pas à nous : l'écraser
    // couperait ce que quelqu'un publie peut-être depuis des mois.
    const mine = proxy && new RegExp(`:${port}(/|$)`).test(proxy);
    if (!mine) return { step: STEP.OTHER_TARGET, publicUrl, port, proxy };

    return { step: STEP.SERVING, publicUrl, port, proxy };
}

/**
 * Où en est cette machine, et que lui manque-t-il.
 *
 * @param {number} port - Le port que sert le tableau de bord.
 * @returns {Promise<object>}
 */
async function inspect(port) {
    const bin = cliPath();
    if (!bin) return { step: STEP.ABSENT, cli: null, installer: installer() };

    const status = await run(['status', '--json']);
    const state = parseJson(status.stdout);
    if (!state) {
        return { step: STEP.UNREACHABLE, cli: bin, detail: status.stderr.trim() };
    }

    // Le second appel n'a de sens qu'une fois le premier concluant : demander
    // l'état du Funnel à une machine déconnectée ne rend qu'une erreur.
    const early = decide(state, null, port);
    if (early.step === STEP.NEEDS_LOGIN || early.step === STEP.NEEDS_CAPABILITY) {
        return { ...early, cli: bin };
    }

    const funnel = parseJson((await run(['funnel', 'status', '--json'])).stdout);
    return { ...decide(state, funnel, port), cli: bin };
}

/**
 * Authentifie la machine avec une clé, sans interaction.
 *
 * La clé s'émet depuis un compte Tailscale existant : c'est ce qui lève
 * l'interactivité, pas ce qui remplace le compte.
 */
async function login(authKey) {
    if (!authKey) return { ok: false, error: 'aucune clé fournie' };
    const res = await run(['up', `--auth-key=${authKey}`]);
    return { ok: res.ok, error: res.ok ? null : (res.stderr || res.stdout).trim() };
}

/**
 * Monte le Funnel sur le port du tableau de bord.
 *
 * `--bg` parce que la forme au premier plan bloquerait le démarrage du bot, et
 * `--yes` parce qu'une invite de confirmation dans un service n'a pas de lecteur.
 * Cet appel doit rester déclenché par un geste : il publie sur l'internet.
 */
async function mount(port) {
    const res = await run(['funnel', '--bg', '--yes', String(port)]);
    return { ok: res.ok, error: res.ok ? null : (res.stderr || res.stdout).trim() };
}

/** Retire ce que `mount` a posé, et rien d'autre. */
async function unmount(port) {
    const res = await run(['funnel', '--https=443', 'off']);
    if (res.ok) return { ok: true, error: null };
    // Les versions récentes préfèrent une remise à zéro explicite.
    const fallback = await run(['funnel', 'reset']);
    return { ok: fallback.ok, error: fallback.ok ? null : (fallback.stderr || '').trim() };
}

/**
 * Dit au journal où en est le partage, et quel est le geste suivant.
 *
 * Une ligne par état, et chacune porte l'action plutôt que le constat : « non
 * installé » n'apprend rien à qui vient d'ouvrir une console, « installez-le
 * ici » si. C'est le pendant de la trace OAuth, et pour la même raison — ce sont
 * les deux seules choses qu'on ne peut pas deviner en installant le bot sur une
 * machine neuve.
 *
 * @param {number} port
 * @returns {Promise<object>} L'inspection, pour qui veut en faire quelque chose.
 */
async function announce(port) {
    const state = await inspect(port);

    switch (state.step) {
        case STEP.ABSENT:
            log.info('[Tailscale] Not installed: the dashboard stays on this machine. '
                + 'To share it from outside, install Tailscale: https://tailscale.com/download');
            break;
        case STEP.UNREACHABLE:
            log.warn('[Tailscale] Installed, but the daemon does not answer. '
                + `Is the Tailscale service running? ${state.detail || ''}`.trim());
            break;
        case STEP.NEEDS_LOGIN:
            log.warn('[Tailscale] This machine is not signed in to a tailnet '
                + `(state: ${state.backendState}). Run "tailscale up", or put an auth key `
                + 'in TAILSCALE_AUTHKEY to have the bot do it.');
            break;
        case STEP.NEEDS_CAPABILITY:
            log.warn('[Tailscale] Signed in, but this tailnet does not grant the right to '
                + 'publish. Enable HTTPS certificates and Funnel in the admin console: '
                + 'https://login.tailscale.com/admin/dns');
            break;
        case STEP.READY:
            log.info('[Tailscale] Everything is in place to share the dashboard; the Funnel '
                + 'is not mounted. Mounting it publishes the dashboard on the public '
                + 'internet, so it waits for a deliberate go-ahead.');
            break;
        case STEP.OTHER_TARGET:
            log.warn(`[Tailscale] A Funnel already publishes ${state.proxy}, not this `
                + 'dashboard. It will not be touched.');
            break;
        case STEP.SERVING:
            log.success(`[Tailscale] Dashboard published on the internet at ${state.publicUrl}`);
            break;
        default:
            break;
    }

    return state;
}

module.exports = {
    STEP,
    cliPath,
    decide,
    installer,
    inspect,
    announce,
    login,
    mount,
    unmount,
    publicUrlFrom,
};
