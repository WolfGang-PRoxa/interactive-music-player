/**
 * Relais de retour OAuth — l'adresse fixe que Discord exige, pour un tableau de
 * bord dont l'adresse change à chaque lancement.
 *
 * Discord renvoie ici le visiteur qui vient d'autoriser l'application. Le
 * `state` porte l'origine d'où la connexion est partie (voir
 * src/web/oauthRelay.js, côté bot) ; le relais l'y renvoie, avec le code, sur
 * `/auth/discord/callback`. C'est tout.
 *
 * Ce qu'il ne fait pas, délibérément :
 *
 *  - **Il ne garde rien.** Aucun stockage, aucun journal applicatif. Le code
 *    d'autorisation ne fait que traverser, et il ne vaut rien sans le secret de
 *    l'application, que seul le bot détient.
 *  - **Il ne renvoie pas n'importe où.** Seulement vers un tunnel rapide
 *    Cloudflare (`https://*.trycloudflare.com`) ou vers la machine elle-même
 *    (`http://localhost`). Toute autre destination est refusée : un relais
 *    ouvert servirait à faire porter des codes chez qui l'on veut.
 *
 * La règle des destinations est la même que celle du bot, recopiée parce
 * qu'un Worker n'importe rien du dépôt. `tests/oauthRelay.js` éprouve les deux
 * versions sur les mêmes cas.
 */

const CALLBACK_PATH = '/discord/callback';
const BOT_CALLBACK_PATH = '/auth/discord/callback';

/** Ce que Discord ajoute au retour, et rien de plus. */
const FORWARDED = ['code', 'state', 'error', 'error_description'];

const QUICK_TUNNEL_HOST = /^[a-z0-9-]+\.trycloudflare\.com$/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * L'origine acceptée, normalisée, ou null.
 * @param {string} value
 * @returns {string|null}
 */
export function acceptedTarget(value) {
    let url;
    try {
        url = new URL(String(value || ''));
    } catch (e) {
        return null;
    }

    if (url.username || url.password || url.search || url.hash) return null;
    if (url.pathname !== '/' && url.pathname !== '') return null;

    const host = url.hostname.toLowerCase();
    if (url.protocol === 'https:' && QUICK_TUNNEL_HOST.test(host) && !url.port) {
        return url.origin;
    }
    if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(host)) {
        return url.origin;
    }
    return null;
}

function fromBase64Url(text) {
    try {
        const b64 = String(text).replace(/-/g, '+').replace(/_/g, '/');
        return atob(b64 + '==='.slice((b64.length + 3) % 4));
    } catch (e) {
        return '';
    }
}

/**
 * L'origine que désigne un `state` : `<hasard>.<origine en base64url>`.
 * @param {string} state
 * @returns {string|null}
 */
export function targetFromState(state) {
    const text = String(state || '');
    const dot = text.indexOf('.');
    if (dot <= 0) return null;
    return acceptedTarget(fromBase64Url(text.slice(dot + 1)));
}

const HEADERS = {
    'Cache-Control': 'no-store',
    // Le code est dans l'adresse : il ne doit partir nulle part en référent.
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
};

function page(status, title, body) {
    const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>body{font-family:system-ui,sans-serif;background:#16161d;color:#e6e6ec;display:grid;
place-items:center;min-height:100vh;margin:0}main{max-width:34rem;padding:2rem;line-height:1.6}</style>
</head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;
    return new Response(html, {
        status,
        headers: { ...HEADERS, 'Content-Type': 'text/html; charset=utf-8' },
    });
}

export default {
    async fetch(request) {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            return new Response(null, { status: 405, headers: { ...HEADERS, Allow: 'GET, HEAD' } });
        }

        const url = new URL(request.url);

        if (url.pathname !== CALLBACK_PATH) {
            return page(404, 'Relais de connexion',
                'Cette adresse sert de retour de connexion Discord au lecteur de musique '
                + 'interactif. Il n\'y a rien à voir ici.');
        }

        const target = targetFromState(url.searchParams.get('state'));
        if (!target) {
            return page(400, 'Lien de connexion invalide',
                'Ce retour de Discord ne dit pas vers quel tableau de bord revenir. '
                + 'Relancez la connexion depuis le tableau de bord.');
        }

        const next = new URL(BOT_CALLBACK_PATH, target);
        for (const key of FORWARDED) {
            const value = url.searchParams.get(key);
            if (value !== null) next.searchParams.set(key, value);
        }

        return new Response(null, {
            status: 302,
            headers: { ...HEADERS, Location: next.toString() },
        });
    },
};
