/*
 * clientErrors — Les erreurs du navigateur remontent dans le journal du bot.
 *
 * ## Pourquoi
 *
 * Le tableau de bord s'utilise depuis un téléphone, souvent à distance, et son
 * navigateur n'est pas celui de la machine qui héberge le bot. Quand une
 * exception y survient, elle reste dans une console que personne n'ouvrira :
 * côté serveur on ne voit qu'un client connecté qui n'envoie plus rien, ce qui
 * ressemble à s'y méprendre à un utilisateur inactif.
 *
 * Safari sur iPhone gèle la version du système dans son en-tête d'agent
 * utilisateur, et aucun navigateur de bureau ne reproduit son moteur : un
 * défaut qui n'apparaît que là ne se diagnostique pas par simulation. Il faut
 * que l'appareil lui-même le raconte.
 *
 * ## Comment
 *
 * Ce fichier est chargé dans l'en-tête du document, avant tous les autres. Une
 * erreur survenue pendant le chargement d'un script arriverait sinon avant que
 * quiconque écoute — et c'est précisément le cas qui casse le plus de choses,
 * puisqu'une exception interrompt le reste du fichier qui la lève.
 *
 * La liaison n'existe pas encore à ce moment-là : les messages s'accumulent et
 * partent dès que la WebSocket est ouverte. Ils empruntent `clientLog`, qui
 * n'exige aucun droit et écrit une ligne dans le journal du bot.
 */
(function () {
    window.MusicPlayer = window.MusicPlayer || {};

    /*
     * Une page qui part en boucle peut lever des milliers d'exceptions. Au-delà
     * de ce plafond on ne retient qu'un compte : le journal du bot doit rester
     * lisible, et les premières erreurs sont celles qui expliquent les suivantes.
     */
    const MAX_REPORTS = 30;

    const queue = [];
    let sent = 0;
    let dropped = 0;
    let timer = null;
    let reporting = false;

    /** Chemin seul : l'origine est la même pour toutes les lignes. */
    function shorten(url) {
        if (!url) return '';
        try { return new URL(url, location.href).pathname; } catch (e) { return String(url); }
    }

    /** Les deux premières lignes d'une pile suffisent à situer l'erreur. */
    function topFrames(stack) {
        return String(stack).split('\n').slice(0, 3).map((l) => l.trim()).join(' <- ');
    }

    /*
     * Une même erreur ne se signale qu'une fois.
     *
     * Elles se répètent — une image qui manque est redemandée à chaque rendu,
     * un état reçu chaque seconde relève chaque seconde le même défaut. Sans
     * ce filtre, la première boucle venue consommait le plafond à elle seule et
     * masquait tout ce qui aurait suivi, c'est-à-dire exactement ce qu'on
     * cherche. Le compte est retenu, et une ligne le rappelle quand la
     * répétition devient un fait en soi.
     */
    const seen = new Map();
    const REPEAT_NOTICE = 10;

    function enqueue(message) {
        const text = String(message).replace(/\s+/g, ' ').slice(0, 400);
        const count = (seen.get(text) || 0) + 1;
        seen.set(text, count);
        if (count !== 1 && count !== REPEAT_NOTICE) return;

        if (sent + queue.length >= MAX_REPORTS) { dropped++; return; }
        queue.push(count === 1 ? text : `${text} — se répète (${count} fois)`);
        flush();
    }

    /** @returns {boolean} vrai si la liaison a pu tout écouler */
    function flush() {
        const socket = window.MusicPlayer.socket;
        const send = window.MusicPlayer.sendWS;
        if (typeof send !== 'function' || !socket || socket.readyState !== 1) {
            // Pas encore de liaison : on repassera.
            if (!timer) timer = setInterval(flush, 1000);
            return false;
        }

        while (queue.length) {
            send({ type: 'clientLog', data: { source: 'Client Error', message: queue.shift() } });
            sent++;
        }
        if (dropped) {
            send({ type: 'clientLog', data: { source: 'Client Error', message: `... et ${dropped} autre(s), non transmise(s)` } });
            dropped = 0;
        }
        if (timer) { clearInterval(timer); timer = null; }
        return true;
    }

    /*
     * `error` sert deux choses : les exceptions non rattrapées, et l'échec de
     * chargement d'une ressource. Les secondes n'arrivent qu'en phase de
     * capture, et ne portent ni message ni pile — seulement leur cible.
     */
    window.addEventListener('error', (event) => {
        if (reporting) return;
        reporting = true;
        try {
            const target = event.target;
            if (target && target !== window && target.getAttribute) {
                /*
                 * L'attribut, et non la propriété. Un `<audio>` dont on a
                 * retiré la source — ce que fait le déverrouillage audio après
                 * son fragment de silence — renvoie l'URL du document sur
                 * `.src`, jamais une chaîne vide : on signalait « ressource non
                 * chargée : / » à chaque `load()`, une fois par seconde.
                 */
                const source = target.getAttribute('src') || target.getAttribute('href');
                if (source) enqueue(`ressource non chargée : ${shorten(source)}`);
                // Un élément média sans source n'a rien à charger : il n'y a
                // pas d'échec à rapporter.
                if (target.tagName) return;
            }
            const where = event.filename ? ` (${shorten(event.filename)}:${event.lineno}:${event.colno})` : '';
            const stack = event.error && event.error.stack ? ` | ${topFrames(event.error.stack)}` : '';
            enqueue(`${event.message || 'erreur sans message'}${where}${stack}`);
        } finally {
            reporting = false;
        }
    }, true);

    window.addEventListener('unhandledrejection', (event) => {
        if (reporting) return;
        reporting = true;
        try {
            const reason = event.reason;
            const text = reason && reason.stack ? topFrames(reason.stack)
                : (reason && reason.message) || String(reason);
            enqueue(`promesse rejetée sans traitement : ${text}`);
        } finally {
            reporting = false;
        }
    });

    /*
     * `console.error` par-dessus le marché : le tableau de bord s'en sert pour
     * ses propres échecs — un message WebSocket illisible, un abonné qui lève.
     * Ces lignes-là n'ont jamais quitté l'appareil non plus.
     */
    const originalConsoleError = console.error;
    console.error = function (...args) {
        if (!reporting) {
            reporting = true;
            try {
                enqueue('console.error : ' + args.map((a) => {
                    if (a instanceof Error) return a.message + (a.stack ? ' | ' + topFrames(a.stack) : '');
                    if (typeof a === 'object') { try { return JSON.stringify(a); } catch (e) { return '[objet]'; } }
                    return String(a);
                }).join(' '));
            } finally {
                reporting = false;
            }
        }
        return originalConsoleError.apply(console, args);
    };

    /*
     * Une trace d'ouverture, pour distinguer « aucune erreur » de « le
     * rapporteur n'était pas là ». Elle porte aussi l'agent utilisateur complet,
     * que le journal du bot tronque à la connexion.
     */
    window.addEventListener('load', () => {
        /*
         * Le mode d'affichage part avec la trace d'ouverture.
         *
         * Sur iPhone, les barres du navigateur ne disparaissent que si la page a
         * été ajoutée à l'écran d'accueil : aucune page web ne peut les retirer
         * elle-même, WebKit n'accordant le plein écran qu'à un `<video>`. Savoir
         * depuis le journal si un lancement vient de l'écran d'accueil ou d'un
         * onglet évite d'avoir à le demander, et distingue « l'installation n'a
         * pas pris » de « le plein écran ne fait pas ce qu'on croit ».
         *
         * Les deux sources se complètent : `navigator.standalone` est propre à
         * iOS, la requête de média est la voie standard, honorée ailleurs.
         */
        const standalone = navigator.standalone === true
            || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
        const lancement = standalone ? 'écran d\'accueil' : 'onglet de navigateur';

        /*
         * Ce que l'appareil accorde en matière de plein écran.
         *
         * La question n'a qu'une réponse utile : un élément ordinaire peut-il
         * passer en plein écran ? Si oui, le lecteur garde ses commandes ; si
         * non, il ne reste que celui d'un `<video>`, où le lecteur du système
         * prend la main. Historiquement, l'iPhone refuse le premier et l'iPad
         * l'accorde — mais cela se vérifie par version d'iOS, et se demander à
         * l'appareil coûte moins cher que de s'en remettre à une mémoire.
         *
         * `fullscreenEnabled` est la réponse qui fait autorité : la méthode peut
         * exister et le document refuser malgré tout.
         */
        const root = document.documentElement;
        const probe = document.createElement('video');
        const capacites = [
            root.requestFullscreen ? 'element.requestFullscreen' : null,
            root.webkitRequestFullscreen ? 'element.webkitRequestFullscreen' : null,
            document.fullscreenEnabled ? 'document.fullscreenEnabled' : null,
            document.webkitFullscreenEnabled ? 'document.webkitFullscreenEnabled' : null,
            probe.webkitEnterFullscreen ? 'video.webkitEnterFullscreen' : null,
        ].filter(Boolean);

        enqueue(`rapporteur actif — lancement : ${lancement}`
            + ` — plein écran : ${capacites.length ? capacites.join(', ') : 'aucune API'}`
            + ` — ${navigator.userAgent}`);
    });
})();
