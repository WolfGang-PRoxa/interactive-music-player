/**
 * WebServer — Serveur web intégré avec Express et WebSocket pour le contrôle en temps réel du bot.
 */

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const database = require('../database/Database');
const broadcastManager = require('../broadcast/BroadcastManager');
const playbackStateManager = require('../database/PlaybackStateManager');
const preloadManager = require('../audio/PreloadManager');
const loudness = require('../audio/loudness');
const loudnessAnalyzer = require('../audio/LoudnessAnalyzer');
const { applyLoudness } = require('../audio/playbackSettings');
const { activeEngine } = require('../audio/mix');
const { foldVirtualElapsed } = require('../audio/PlaybackSession');
const auth = require('./auth');
const logVisibility = require('./logVisibility');
const { arePathsOrUrlsEqual } = require('../utils/paths');
const { readSetAsideQueue } = require('../utils/setAsideQueue');
const transitions = require('../audio/transitions');
const channelQueue = require('../audio/channelQueue');
const { formatMs, parseDurationToMs } = require('../utils/duration');
const artwork = require('../utils/artwork');
const log = require('../utils/logger');

/** Le dashboard n'échange que de petits messages JSON ; les fichiers passent par POST /api/upload. */
const WS_MAX_PAYLOAD_BYTES = 1024 * 1024;

/**
 * Flux mémoire haute cadence du tiroir.
 *
 * La mesure embarquée dans `progress` ne tombe qu'une fois par seconde : de
 * quoi tenir un historique, pas de quoi tracer une courbe vivante. Ce flux
 * échantillonne bien plus vite, mais seulement pendant qu'un tableau de bord
 * regarde (tiroir ouvert) — sinon aucun minuteur ne tourne.
 *
 * Les échantillons partent groupés : la résolution temporelle est celle de
 * l'échantillonnage, la charge réseau celle du regroupement.
 */
const MEM_RATE_HZ = 60;
/**
 * Le minuteur est volontairement réglé plus court que la période visée, et
 * c'est l'horloge qui décide de retenir ou non la mesure.
 *
 * Sous Windows la granularité des minuteurs est d'environ 15,6 ms : demander
 * 17 ms y donne un réveil toutes les 31 ms, soit deux fois moins de mesures
 * que prévu. En se réveillant plus souvent et en filtrant sur le temps écoulé,
 * la cadence obtenue est la même quelle que soit la résolution du système.
 */
const MEM_SAMPLE_PERIOD_MS = 8;
const MEM_MIN_GAP_MS = (1000 / MEM_RATE_HZ) * 0.6;
const MEM_SEND_PERIOD_MS = 50;
/** Garde-fou : plafonne le lot si un envoi venait à traîner. */
const MEM_MAX_BATCH = MEM_RATE_HZ * 4;
/**
 * Au-delà de ce que la socket garde en attente, la liaison ne suit plus.
 *
 * `bufferedAmount` ne compte que ce que le système n'a pas encore accepté : les
 * tampons du noyau absorbent d'abord, et la valeur ne monte qu'une fois ceux-ci
 * pleins. Un lot pèse quelques centaines d'octets ; 16 Ko en attente, c'est
 * déjà plusieurs secondes de retard sur un flux censé être vivant.
 */
const MEM_BACKLOG_BYTES = 16 * 1024;
/** Une trace par socket engorgée, pas une par lot. */
const MEM_BACKLOG_LOG_EVERY_MS = 30000;

/**
 * Délai laissé au tableau de bord pour annoncer lui-même une fin de piste, en
 * diffusion personnelle.
 *
 * Le son sort du navigateur : c'est lui qui sait quand un morceau s'achève, et
 * il le signale toujours — sur `ended`, ou à la fin d'un fondu enchaîné.
 * L'horloge du serveur ne fait que suivre, et n'avance d'elle-même que si ce
 * signal n'arrive pas.
 *
 * Deux secondes : largement au-delà d'un aller-retour WebSocket, largement en
 * deçà de ce qui s'entendrait si le navigateur venait réellement à se taire.
 */
const AUTO_END_DELAY_MS = 2000;

// Le logger écrit dans data/logs et applique la rétention ; le serveur web ne
// fait que s'y abonner pour retransmettre les entrées au tableau de bord.
log.configure({
    dir: path.join(process.cwd(), 'data/logs'),
    level: process.env.LOG_LEVEL || 'debug',
    retention: Number(process.env.LOG_RETENTION) || 20,
});

class WebServer {
    constructor() {
        this.app = express();
        this.server = http.createServer(this.app);
        this.wss = new WebSocketServer({
            server: this.server,
            maxPayload: WS_MAX_PAYLOAD_BYTES,
            verifyClient: auth.verifyUpgrade
        });
        this.client = null;
        this.port = 3000;
        this.host = '127.0.0.1';
        /**
         * Tableau de bord pilote de chaque serveur : guildId → WebSocket.
         *
         * En diffusion personnelle, le son sort du navigateur et c'est lui qui
         * sait quand un morceau s'achève. Plusieurs tableaux de bord peuvent
         * être ouverts — un téléphone, un poste fixe —, et chacun mène alors sa
         * propre lecture. Tous annonçaient la fin de la même piste, et la file
         * avançait d'autant de crans qu'il y avait d'appareils.
         *
         * Un seul est donc habilité à émettre les annonces automatiques. Les
         * commandes explicites — lecture, pause, suivant, repositionnement —
         * restent acceptées de n'importe lequel : ce sont des intentions de
         * l'utilisateur, pas des constats de fin de piste.
         */
        this.pilots = new Map();

        /** Lien d'invitation, construit une fois le bot prêt. Voir lienInvitation(). */
        this._inviteLink = null;

        // Flux mémoire haute cadence : voir setFluxMemoire.
        this._memorySubscribers = new Set();
        this._memorySampleTimer = null;
        this._memorySendTimer = null;
        this._memoryBuffer = [];

        WebServer.instance = this;

        /*
         * Retransmission des journaux au tableau de bord. L'abonnement remplace
         * le détournement de console : le logger ignore tout du serveur web.
         *
         * **Chacun selon ce qui le regarde.** Le journal ne décrit pas la
         * lecture en cours : il décrit la machine qui l'héberge — chemins
         * absolus, adresse publique, identifiants des invités admis comme
         * refusés. Il partait jusqu'ici vers chaque socket ouverte, celles des
         * invités comprises, sans que rien ne soit consulté.
         *
         * Le maître le reçoit tel quel. Un invité n'en reçoit que les lignes
         * qui parlent de ce qu'il écoute, caviardées de ce qui nomme l'hôte :
         * voir `logVisibility.js`, qui porte la règle et son pourquoi. Le filtre
         * s'applique par socket, d'où la sérialisation à l'intérieur de la
         * boucle plutôt qu'une charge unique partagée.
         *
         * `identity` est posée au handshake (voir plus bas) : une socket qui
         * n'en aurait pas est traitée en invité, comme partout ailleurs.
         */
        log.subscribe((entry) => {
            if (!this.wss) return;
            this.wss.clients.forEach((client) => {
                if (client.readyState !== 1) return;
                const visible = logVisibility.forClient(client, entry);
                if (!visible) return;
                try {
                    client.send(JSON.stringify({ type: 'log', data: visible }));
                } catch (e) {}
            });
        });

        this._initExpress();
        this._initWebSocket();
    }

    /**
     * Démarre le serveur web.
     * @param {import('discord.js').Client} client - Instance du client Discord
     * @param {number} port - Port d'écoute
     * @param {string} host - Interface d'écoute (127.0.0.1 par défaut ; mettre
     *   HOST=0.0.0.0 pour exposer le dashboard sur le réseau local)
     */
    start(client, port = 3000, host = '127.0.0.1') {
        this.client = client;
        this.port = port;
        this.host = host;

        const token = auth.getToken();

        // Ménage de démarrage : transferts interrompus (les journaux sont
        // purgés par le logger lors de sa configuration)
        try {
            require('./uploadService').cleanIncomingUploads();
        } catch (err) {
            log.error(`[WebServer] Cannot clean up the interrupted transfers: ${err.message}`);
        }

        this.server.listen(port, host, () => {
            const displayHost = (host === '0.0.0.0' || host === '::') ? 'localhost' : host;

            log.info(`[WebServer] Listening on http://${displayHost}:${port}.`);

            /**
             * Annonce l'adresse par laquelle entrer.
             *
             * Elle donnait l'interface d'écoute, qui sert bien la page mais ne
             * portera jamais de session : l'aller-retour Discord revient sur
             * `PUBLIC_URL`, et le cookie s'y pose. Suivre la trace menait donc à
             * une porte de connexion qu'aucun clic ne franchit.
             *
             * Dite après le relevé de partage, et non avant : `PUBLIC_URL` peut
             * se déduire de la machine à cet instant-là, et l'annoncer plus tôt
             * reviendrait à donner l'adresse d'avant la déduction.
             */
            /*
             * L'adresse, jamais le jeton.
             *
             * Cette ligne a longtemps porté `?token=…`, par commodité : elle se
             * copiait dans la barre d'adresse. Le prix en était démesuré. Elle
             * entre dans l'historique du logger, que le tableau de bord sert à
             * quiconque ouvre une WebSocket, et dans `data/logs/`, qui survit
             * aux redémarrages. Le secret qui désigne le propriétaire de
             * l'installation se lisait donc depuis n'importe quel onglet
             * d'invité.
             *
             * Rien n'est perdu au change : le navigateur ouvert juste après
             * emporte le jeton, `tools/start-bot.ps1` le lit dans le fichier, et
             * celui qui en a besoin à la main sait désormais où le prendre.
             */
            const announceEntry = () => {
                const oauth = require('./oauth');
                const entry = oauth.entryUrl();
                log.success(`[WebServer] Dashboard reachable at: ${entry}`);
                const shared = oauth.publicUrl();
                if (shared !== entry) {
                    log.info(`[WebServer] Shared on the internet at: ${shared}`);
                }
                log.info('[WebServer] Access token: data/dashboard-token '
                    + '(the window opened automatically already carries it).');
                // Derrière le relais, toute adresse de la machine porte une
                // session : la mise en garde n'a de sens qu'avec une adresse
                // déclarée.
                if (!oauth.usesRelay() && entry !== `http://${displayHost}:${port}`) {
                    log.info('[WebServer] The listening address serves the page too, '
                        + 'but holds no sign-in session: use the address above.');
                }
            };
            if (host === '0.0.0.0' || host === '::') {
                log.warn(`[WebServer] The dashboard is exposed on every network interface (HOST=${host}).`);
            }

            /*
             * L'état de la configuration OAuth, ici et pas ailleurs.
             *
             * Cette trace existait déjà et n'était appelée de nulle part : elle
             * annonce l'URL de rappel à déclarer dans le portail Discord, et
             * avertit quand PUBLIC_URL manque. Autant dire qu'elle sert
             * précisément au moment où l'on installe le bot sur une machine
             * neuve — le seul moment où personne ne peut la deviner.
             *
             * Elle se lit à la suite de l'adresse du tableau de bord, parce que
             * c'est la ligne que l'on cherche des yeux au démarrage.
             */
            /*
             * Le partage d'abord, la trace OAuth ensuite.
             *
             * Le tunnel se rouvre ici quand le maître l'avait ouvert avant
             * l'arrêt du bot (voir cloudflare.js) : la trace OAuth qui suit,
             * et l'adresse annoncée après elle, décrivent alors la situation
             * réelle plutôt que celle d'avant la réouverture.
             *
             * L'adresse du partage rapide n'est jamais recopiée dans
             * PUBLIC_URL : elle change à chaque lancement, et le relais de
             * retour OAuth rend cette copie inutile (voir oauth.js).
             */
            require('./cloudflare').announce(port).then(() => {
                require('./oauth').logConfiguration();
                announceEntry();
            }).catch((err) => {
                // Le partage est un confort : son diagnostic ne doit jamais
                // empêcher la trace qui suit, ni le démarrage.
                log.warn(`[Tunnel] Sharing state unknown: ${err.message}`);
                require('./oauth').logConfiguration();
                announceEntry();
            });

            // Ouvrir automatiquement le navigateur après 5 secondes si aucun client n'est connecté
            //
            // Débrayable par AUTO_OPEN_DASHBOARD=false. En diffusion personnelle,
            // ce tableau de bord joue la musique et annonce les fins de piste au
            // même titre que celui de l'utilisateur : sur une machine pilotée à
            // distance, il double la lecture sans que personne ne l'entende.
            setTimeout(() => {
                if (String(process.env.AUTO_OPEN_DASHBOARD || '').toLowerCase() === 'false') {
                    log.info('[WebServer] Automatic opening of the dashboard disabled '
                        + '(AUTO_OPEN_DASHBOARD=false).');
                    return;
                }
                if (this.wss.clients.size === 0) {
                    log.success(`[WebServer] No connected client detected. Opening the dashboard automatically.`);
                    const { execFile } = require('child_process');
                    /*
                     * Sur une origine où Discord sait renvoyer.
                     *
                     * Une session vit dans un cookie, et un cookie appartient à
                     * une origine. L'aller-retour de connexion revient sur
                     * `PUBLIC_URL` quand elle est déclarée, et sur l'origine de
                     * départ — `localhost` ici — quand le relais s'en charge.
                     *
                     * Cette fenêtre s'ouvrait sur l'interface d'écoute,
                     * `127.0.0.1`, qui n'en porte aucune et n'en portera jamais.
                     * Elle affichait donc la porte de connexion à chaque
                     * lancement, et s'y connecter n'y changeait rien : le retour
                     * de Discord posait le cookie sur l'autre origine. Même sans
                     * PUBLIC_URL le piège tenait, `localhost` et `127.0.0.1`
                     * étant deux origines distinctes pour un navigateur.
                     *
                     * Le jeton reste passé en query : le middleware pose le
                     * cookie puis nettoie l'URL.
                     */
                    const url = `${require('./oauth').entryUrl()}/?token=${token}`;

                    /*
                     * Un tableau d'arguments, et non une ligne de commande.
                     *
                     * L'adresse était interpolée dans une chaîne remise à
                     * l'interpréteur — `start "" "${url}"`. Elle porte le jeton
                     * et se déduit de `PUBLIC_URL`, valeur écrite par quelqu'un
                     * dans `.env` : un guillemet ou une esperluette qui s'y
                     * glisserait fermerait la chaîne et ferait exécuter la
                     * suite. C'était le dernier `exec` du projet, tout le reste
                     * passant déjà par `spawn` ou `execFile`.
                     *
                     * Sous Windows, `start` n'est pas un exécutable mais une
                     * commande interne de cmd.exe : il faut donc `cmd /c`, dont
                     * le premier argument vide est le titre de fenêtre que
                     * `start` réclame avant l'adresse.
                     */
                    const [command, args] = process.platform === 'win32'
                        ? ['cmd', ['/c', 'start', '', url]]
                        : process.platform === 'darwin'
                            ? ['open', [url]]
                            : ['xdg-open', [url]];

                    execFile(command, args, { windowsHide: true }, (err) => {
                        if (err) {
                            log.error(`[WebServer] Cannot open the browser: ${err.message}`);
                        }
                    });
                } else {
                    log.success(`[WebServer] Existing client detected (${this.wss.clients.size} client(s) connected).`);
                }
            }, 5000);
        });

        preloadManager.onProgress = () => {
            try {
                if (this.wss && this.wss.clients) {
                    this.wss.clients.forEach((c) => {
                        if (c.readyState === 1 && c.selectedGuildId) {
                            try {
                                const state = this.getState(c.selectedGuildId, c.selectedVoiceChannelId);
                                c.send(JSON.stringify({ type: 'state', data: state }));
                            } catch (e) {}
                        }
                    });
                }
            } catch (e) {
                log.error('[WebServer] Preload onProgress error:', e.message);
            }
        };

        /*
         * Une mesure de sonie vient de tomber.
         *
         * Elle arrive après coup — le morceau joue peut-être déjà — et c'est
         * bien pour cela qu'il faut la poser sur les flux en cours : sans ce
         * rappel, un morceau lancé avant sa mesure resterait à son niveau
         * d'origine jusqu'au suivant, alors même que le tableau de bord
         * afficherait la correction comme appliquée.
         */
        loudnessAnalyzer.on('measured', () => {
            try {
                const { useMainPlayer } = require('discord-player');
                const player = useMainPlayer();
                if (player && player.queues) {
                    player.queues.cache.forEach((queue) => applyLoudness(queue));
                }
            } catch (e) {
                log.error('[WebServer] Loudness apply error:', e.message);
            }

            try {
                this.wss?.clients?.forEach((c) => {
                    if (c.readyState !== 1 || !c.selectedGuildId) return;
                    const state = this.getState(c.selectedGuildId, c.selectedVoiceChannelId);
                    c.send(JSON.stringify({ type: 'state', data: state }));
                });
            } catch (e) {
                log.error('[WebServer] Loudness broadcast error:', e.message);
            }
        });

        // Intervalle de mise à jour périodique (progrès de lecture, synco état)
        setInterval(() => {
            try {
                // Mettre à jour la progression de la file d'attente virtuelle en mode personnel
                const { useMainPlayer } = require('discord-player');
                const player = useMainPlayer();
                if (player && player.queues) {
                    player.queues.cache.forEach(queue => {
                        const guildId = queue.guild.id;
                        const settings = database.getSettings(guildId);
                        if (settings.broadcastMode === 'personal' && queue.virtualCurrentTrack) {
                            if (queue.virtualIsPlaying && !queue.virtualIsPaused) {
                                // En diffusion personnelle le son sort du navigateur :
                                // sans tableau de bord connecté, rien n'est joué. Laisser
                                // courir l'horloge dans le vide décalerait la reprise après
                                // un redémarrage du bot, voire enchaînerait des pistes que
                                // personne n'a entendues. On la gèle et on repousse le
                                // repère temporel pour repartir sans à-coup à la reconnexion.
                                if (!this.hasConnectedClient(guildId)) {
                                    queue.virtualLastUpdated = Date.now();
                                } else {
                                    // Le même solde que celui d'une pause, et par la
                                    // même fonction : deux calculs séparés finiraient
                                    // par diverger, et la position n'a qu'un sens.
                                    foldVirtualElapsed(queue, parseFloat(settings.playbackSpeed || '1.0'));

                                    const durationMs = queue.virtualCurrentTrack.durationMS || parseDurationToMs(queue.virtualCurrentTrack.duration);
                                    // Le délai de courtoisie laisse le navigateur annoncer
                                    // lui-même la fin, ce qu'il fait toujours : sur
                                    // l'événement `ended`, ou à l'issue du fondu enchaîné.
                                    //
                                    // Sans lui, les deux avancent pour la même fin de
                                    // piste. En enchaînement mix la collision est
                                    // systématique — le fondu s'achève précisément quand
                                    // cette horloge atteint la durée —, et le serveur
                                    // passait à n+1 juste avant que le saut du navigateur
                                    // n'arrive et ne fasse passer à n+2, à la position
                                    // déjà jouée du fondu.
                                    //
                                    // Cette avance n'est qu'une roue de secours, pour le
                                    // cas où le tableau de bord se tairait. Elle peut donc
                                    // attendre ; lui, non.
                                    if (durationMs > 0 && queue.virtualProgressMs >= durationMs + AUTO_END_DELAY_MS) {
                                        log.warn('[WebServer] End of track not announced by the dashboard: '
                                            + 'advancing the virtual queue automatically.');
                                        this.handleVirtualSkip(queue, guildId);
                                    }
                                }
                            }
                        }

                        // L'enchaînement mix de la diffusion commune était mené
                        // d'ici, à la seconde : faute de pouvoir superposer deux
                        // pistes, il ne pouvait qu'éteindre la sortante et
                        // compter sur le fondu d'entrée de la suivante pour
                        // masquer le trou. Le bus de mixage s'en charge désormais
                        // lui-même, cadencé sur les trames qu'il produit — donc
                        // au millième de seconde et sans blanc entre les deux.
                    });
                }

                if (this.wss.clients.size > 0) {
                    const uniqueGuildIds = new Set();
                    this.wss.clients.forEach(client => {
                        if (client.readyState === 1 && client.selectedGuildId) {
                            uniqueGuildIds.add(client.selectedGuildId);
                        }
                    });
                    uniqueGuildIds.forEach(guildId => {
                        // Seule la progression est diffusée périodiquement.
                        // L'état complet part sur événement (piste, file,
                        // réglages), via broadcastState.
                        try {
                            preloadManager.update(guildId);
                        } catch (err) {
                            log.error('[WebServer] Preload update error:', err.message);
                        }
                        this.broadcastProgress(guildId);
                    });
                }
            } catch (err) {
                // Ignorer
            }
        }, 1000);
    }

    _initExpress() {
        // L'authentification passe avant tout le reste, fichiers statiques compris.
        // Elle laisse passer le trajet OAuth2, seul chemin par lequel un invité
        // peut se présenter : voir PUBLIC_PATHS dans web/auth.js.
        /*
         * Les en-têtes de sécurité, avant tout le reste.
         *
         * Posés avant l'authentification, et non après : ils doivent couvrir
         * aussi les pages servies *à la place* du tableau de bord — la page de
         * refus, celles du trajet OAuth — qui sont précisément celles qu'un
         * inconnu peut atteindre. C'est sur l'une d'elles qu'une valeur venue
         * de la requête s'est retrouvée interpolée dans du HTML ; l'échappement
         * ferme la porte, la politique ci-dessous ferme la pièce.
         *
         * Ce que chaque directive doit au tableau de bord tel qu'il est :
         *
         *  - `script-src 'self'` sans `unsafe-inline`, parce que la page ne
         *    porte aucun `<script>` en ligne : tout son code vient de `/js/`.
         *    C'est la directive qui compte, et elle peut être stricte.
         *  - `style-src` admet `unsafe-inline` faute de choix : la page compte
         *    une cinquantaine d'attributs `style=`, et le script en pose
         *    d'autres au fil de l'exécution (positions, opacités, dégradés).
         *  - `img-src https:` parce que les pochettes viennent d'où la piste
         *    vient — iTunes, YouTube, Discord — et que la liste ne se ferme pas.
         *  - `media-src https:` pour la même raison, et c'est la ligne qui
         *    manquait à cette liste quand elle a été écrite. Fermée à `'self'`,
         *    la politique bloquait toute vidéo avant même la requête, et le
         *    lecteur retombait sur le visualiseur en annonçant « erreur de
         *    lecture (code 4) » — le code que le navigateur rend pour une source
         *    qu'il n'a pas pu charger.
         *
         *    Ce qui l'exigeait alors n'existe plus : les flux résolus chez la
         *    source passent maintenant par le bot, comme le fait depuis toujours
         *    `/api/stream` pour l'audio — voir src/web/mediaRelay.js. Ce qui la
         *    retient encore est plus modeste : une piste peut être l'adresse
         *    d'un fichier vidéo quelconque, ajoutée telle quelle, et celle-là
         *    est servie au navigateur sans détour.
         *
         *    Élargir ne coûte d'ailleurs pas grand-chose : `img-src https:`
         *    autorise déjà n'importe quel hôte, et une balise média n'exécute
         *    pas de code.
         *  - `connect-src` porte `ws:` et `wss:` : la WebSocket du tableau de
         *    bord, sans laquelle il reste muet.
         *  - `frame-ancestors 'none'` : rien n'encadre ce tableau de bord, et
         *    une page tierce qui le ferait pourrait faire cliquer ses commandes
         *    à l'insu de celui qui croit cliquer ailleurs.
         *  - `base-uri 'none'` : une balise `<base>` injectée détournerait
         *    toutes les URL relatives de la page, `/js/` compris.
         */
        this.app.use((req, res, next) => {
            res.set('Content-Security-Policy', [
                "default-src 'self'",
                "script-src 'self'",
                "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
                "font-src 'self' https://fonts.gstatic.com data:",
                "img-src 'self' data: blob: https:",
                "media-src 'self' blob: data: https:",
                "connect-src 'self' ws: wss:",
                "frame-ancestors 'none'",
                "base-uri 'none'",
                "form-action 'self'",
                "object-src 'none'",
            ].join('; '));
            // Un type MIME deviné est un type MIME choisi par l'attaquant :
            // un fichier envoyé puis servi ne doit pas pouvoir se faire passer
            // pour du script.
            res.set('X-Content-Type-Options', 'nosniff');
            // `frame-ancestors` dit déjà la même chose aux navigateurs récents ;
            // celui-ci couvre les autres.
            res.set('X-Frame-Options', 'DENY');
            // Le jeton a voyagé en query et peut encore le faire sur un lien
            // partagé : aucune adresse d'ici ne doit partir vers un tiers.
            res.set('Referrer-Policy', 'no-referrer');
            next();
        });

        this.app.use(auth.middleware);

        const createAuthRouter = require('./routes/auth');
        this.app.use('/auth', createAuthRouter(this));

        /*
         * Le carnet reprend les invités que cette installation connaissait déjà.
         *
         * Ils ont des droits et des admissions, mais pas de fiche : le carnet
         * n'existait pas quand ils sont arrivés. Sans ce rattrapage, ils n'y
         * entreraient qu'à leur prochaine authentification, et le maître les
         * verrait entre-temps s'effacer de sa fenêtre au premier cookie périmé.
         *
         * Une seule fois, au montage des routes, et sans écraser quoi que ce
         * soit : une fiche déjà là fait foi.
         */
        try {
            require('./guests').adopt(require('./sessions').listUsers());
        } catch (err) {
            log.warn(`[Guests] Takeover from the open sessions failed: ${err.message}`);
        }

        /*
         * Manifeste d'application web, servi et non déposé en fichier.
         *
         * Sur iPhone, aucune page ne peut faire disparaître les barres du
         * navigateur : WebKit n'accorde le plein écran qu'à un `<video>`, jamais
         * à un `<div>`, si bien que le plein écran du lecteur se rabat sur du
         * CSS et reste encadré. Le seul moyen d'obtenir l'écran entier est
         * d'ajouter le tableau de bord à l'écran d'accueil, ce qui demande ce
         * manifeste.
         *
         * Il est calculé à chaque requête pour une raison : tout le site exige
         * le jeton, et un raccourci ouvrant sur `/` tomberait sur un 401 — une
         * application installée n'hérite pas des cookies du navigateur. L'URL de
         * départ emporte donc le jeton que cette requête-ci a présenté. Écrire
         * ce fichier sur le disque l'aurait fait entrer dans le dépôt, ce qu'un
         * secret n'a rien à y faire.
         *
         * `no-store` pour la même raison : un jeton renouvelé ne doit pas
         * survivre dans un manifeste mis en cache.
         */
        this.app.get('/manifest.webmanifest', (req, res) => {
            const identity = auth.identify(req);
            const token = identity.master ? auth.getToken() : null;

            res.set('Cache-Control', 'no-store');
            res.type('application/manifest+json').send(JSON.stringify({
                name: 'Music Dashboard',
                short_name: 'Music',
                description: 'Tableau de bord du lecteur de musique interactif.',
                start_url: token ? `/?token=${encodeURIComponent(token)}` : '/',
                scope: '/',
                display: 'standalone',
                orientation: 'any',
                background_color: '#0a090f',
                theme_color: '#0a090f',
                icons: [
                    { src: '/favicons/app-icon-192.png', sizes: '192x192', type: 'image/png' },
                    { src: '/favicons/app-icon-512.png', sizes: '512x512', type: 'image/png' },
                ],
            }, null, 2));
        });

        // Servir les fichiers statiques du dashboard
        this.app.use(express.static(path.join(__dirname, 'public')));
        // Les corps JSON du dashboard sont petits ; les fichiers passent par /api/upload
        // qui lit le flux brut sans jamais le bufferiser en mémoire.
        this.app.use(express.json({ limit: '1mb' }));
        this.app.use(express.urlencoded({ limit: '1mb', extended: true }));

        const createApiRouter = require('./routes/api');
        this.app.use('/api', createApiRouter(this));
    }

    _initWebSocket() {
        // Heartbeat interval to check alive connections every 30 seconds
        const heartbeatInterval = setInterval(() => {
            this.wss.clients.forEach((ws) => {
                if (ws.isAlive === false) {
                    log.info('[WebServer] Idle WebSocket client, closing...');
                    return ws.terminate();
                }
                ws.isAlive = false;
                ws.ping();
            });
        }, 30000);

        this.wss.on('close', () => {
            clearInterval(heartbeatInterval);
        });

        this.wss.on('connection', (ws, req) => {
            // Qui pilote cet onglet : le maître, ou un invité reconnu par
            // Discord. `verifyUpgrade` l'a déterminé pendant le handshake, seul
            // moment où les en-têtes — donc les cookies — sont encore là.
            //
            // Seule l'identité est retenue, jamais les droits : le maître peut
            // en retirer pendant que l'invité est connecté, et une copie prise
            // ici resterait celle d'avant. Ils sont relus à chaque message.
            //
            // Le repli n'accorde rien. Il fut un temps où une socket arrivée
            // sans identité ne pouvait être que celle du porteur du jeton, donc
            // du maître ; depuis que le jeton ne suffit plus à l'être, ce repli
            // ouvrirait tout à un incident. C'est le même raisonnement que
            // `identityOf()` dans wsHandler.js : faire pencher l'accident du
            // côté qui ne coûte rien.
            ws.identity = req?.identity
                || { authorized: true, master: false, session: null, pendingLogin: true };
            // Retenu ici, seul moment où l'adresse d'origine et les en-têtes
            // du handshake sont encore là : certains réglages ne se changent
            // que devant la machine (voir botConfig.js).
            ws.fromThisMachine = auth.fromThisMachine(req);

            if (!ws.identity.master && ws.identity.session) {
                log.info(`[WebServer] Guest dashboard connected: `
                    + `${ws.identity.session.displayName} (${ws.identity.session.userId}).`);
            }

            // Le carnet retient le passage : c'est de là que vient le « vu il y
            // a… » de la fenêtre de partage, et la session peut porter un nom
            // plus frais que la fiche si le compte a été renommé entre-temps.
            if (ws.identity.session?.userId) {
                try {
                    require('./guests').touch(ws.identity.session.userId, {
                        displayName: ws.identity.session.displayName,
                        avatar: ws.identity.session.avatar,
                    });
                } catch (err) {
                    log.error('[WebServer] Guest book update failed:', err.message);
                }
            }

            // L'initialisation d'un client interroge l'état du lecteur. Sans
            // cette protection, une exception y remonterait comme exception non
            // interceptée et terminerait le processus : une simple connexion au
            // tableau de bord au mauvais moment suffirait à arrêter le bot.
            try {
                this._initClient(ws);
            } catch (err) {
                log.error('[WebServer] WebSocket client initialisation failed:', err);
                try {
                    ws.send(JSON.stringify({
                        type: 'error',
                        data: { message: 'Initialisation impossible, réessayez dans un instant.' }
                    }));
                } catch (e) {}
                try { ws.close(); } catch (e) {}
            }
        });
    }

    /**
     * Prépare un client fraîchement connecté : historique des journaux,
     * sélection du serveur et du salon, envoi de l'état initial.
     * @param {import('ws').WebSocket} ws
     */
    _initClient(ws) {
        ws.isAlive = true;
        ws.on('pong', () => {
            ws.isAlive = true;
        });
        // L'historique part AVANT de journaliser la connexion. Dans l'ordre
        // inverse, la ligne « Client connecté » était diffusée en direct au
        // client qui venait de s'ouvrir, donc affichée avant l'historique — puis
        // une seconde fois à sa place chronologique, l'historique la contenant
        // déjà.
        //
        // Filtré selon qui écoute, pour la raison qui gouverne l'abonnement du
        // constructeur : le journal décrit la machine hôte autant que la lecture
        // en cours. C'était ici la fuite la plus large — ce `send` était le tout
        // premier geste envers une socket fraîche, avant même qu'on sache quel
        // serveur elle regarde.
        try {
            ws.send(JSON.stringify({
                type: 'logsHistory',
                data: logVisibility.historyForClient(ws, log.getHistory()),
            }));
        } catch (err) {}

        log.success('[WebServer] Client connected over WebSocket.');

        let selectedGuildId = null;
        let selectedChannelId = null;

        // 1. Le dernier salon visité. Le salon favori n'est plus consulté ici :
        //    il est appliqué une fois au démarrage du bot
        //    (`Database.applyStartupChannel`), ce qui en fait précisément ce
        //    dernier salon visité tant que personne n'en a choisi d'autre. Le
        //    lire à chaque connexion en faisait tout autre chose : un tableau de
        //    bord rouvert — ou simplement reconnecté après une coupure réseau —
        //    revenait au favori, effaçant le salon que l'utilisateur venait de
        //    sélectionner.
        const lastChannelInfo = database.getLastVoiceChannel();
        if (lastChannelInfo.guildId && lastChannelInfo.channelId) {
            const guild = this.client.guilds.cache.get(lastChannelInfo.guildId);
            if (guild && guild.channels.cache.has(lastChannelInfo.channelId)) {
                selectedGuildId = lastChannelInfo.guildId;
                selectedChannelId = lastChannelInfo.channelId;
            }
        }

        // 2. Fallback standard s'il n'y a pas de dernier salon disponible
        if (!selectedGuildId) {
            selectedGuildId = this._getFirstGuildId();
            if (selectedGuildId) {
                const settings = database.getSettings(selectedGuildId);
                const { useMainPlayer } = require('discord-player');
                const player = useMainPlayer();
                const queue = player.queues.get(selectedGuildId);
                selectedChannelId = queue?.channel?.id || settings.lastVoiceChannelId;
                if (!selectedChannelId) {
                    const guild = this.client.guilds.cache.get(selectedGuildId);
                    if (guild) {
                        const voiceChannels = guild.channels.cache.filter(c => c.type === 2);
                        const withUsers = voiceChannels.filter(c => c.members.filter(m => !m.user.bot).size > 0);
                        if (withUsers.size > 0) {
                            selectedChannelId = withUsers.first().id;
                        } else if (voiceChannels.size > 0) {
                            selectedChannelId = voiceChannels.first().id;
                        }
                    }
                }
                if (queue && !queue.activeChannelId && selectedChannelId) {
                    queue.activeChannelId = selectedChannelId;
                }
            }
        }

        ws.selectedGuildId = selectedGuildId;
        ws.selectedVoiceChannelId = selectedChannelId;

        // Le premier connecté prend les commandes ; les suivants observent.
        this._ensurePilot(selectedGuildId);

        // Envoyer l'état actuel lors de la connexion
        if (selectedGuildId) {
            ws.send(JSON.stringify({
                type: 'state',
                data: {
                    ...this.getState(selectedGuildId, ws.selectedVoiceChannelId),
                    pilot: this.isPilot(ws, selectedGuildId),
                    ...this._shareStateFor(ws, selectedGuildId),
                }
            }));

            /*
             * Et prévenir les autres qu'il y a quelqu'un de plus.
             *
             * La fenêtre de partage montre qui est en ligne ; cette liste vient
             * des connexions ouvertes, et rien d'autre ne la fait bouger. Sans
             * cette diffusion, la pastille d'un invité qui arrive ne verdissait
             * qu'au prochain événement de lecture — c'est-à-dire, un bot à
             * l'arrêt, jamais.
             *
             * `_ensurePilot` ne suffisait pas : il ne diffuse que lorsqu'il
             * désigne un nouveau pilote, c'est-à-dire à la première connexion.
             * Or l'arrivée qui intéresse le maître est précisément la seconde —
             * celle de son invité, alors que lui est déjà là.
             *
             * Différée d'un tour, pour laisser la connexion s'achever avant de
             * peindre quoi que ce soit chez les autres.
             */
            setImmediate(() => this.broadcastState(selectedGuildId));
        }

        ws.on('message', async (message) => {
            try {
                // require différé : wsHandler dépend indirectement de ce module
                const wsHandler = require('./websocket/wsHandler');
                const parsed = JSON.parse(message);
                await wsHandler.handleMessage(ws, parsed, this);
            } catch (err) {
                log.error('[WebServer] WebSocket message error:', err.message);
                // Un handler interrompu n'a pas atteint son broadcastState : sans
                // ce renvoi, l'IHM resterait sur son état optimiste (interrupteur
                // coché, curseur déplacé…) jusqu'au prochain événement, en
                // désaccord avec le réglage réellement enregistré.
                if (ws.readyState === 1 && ws.selectedGuildId) {
                    try {
                        ws.send(JSON.stringify({
                            type: 'state',
                            data: this.getState(ws.selectedGuildId, ws.selectedVoiceChannelId)
                        }));
                    } catch (e) {}
                }
            }
        });

        // Un client parti ne doit pas maintenir le flux mémoire en vie, ni
        // laisser la lecture sans pilote.
        ws.on('close', () => {
            this.setMemoryStream(ws, false);
            this._removeClient(ws);
        });
    }

    /**
     * Diffuse l'état actuel à tous les clients connectés.
     * @param {string} guildId
     */
    broadcastState(guildId) {
        try {
            preloadManager.update(guildId);
        } catch (err) {
            log.error('[WebServer] Preload update error:', err.message);
        }

        this.wss.clients.forEach((client) => {
            if (client.readyState === 1 && client.selectedGuildId === guildId) {
                const state = this.getState(guildId, client.selectedVoiceChannelId);

                // Chaque tableau de bord doit savoir s'il pilote : lui seul mène
                // les enchaînements et annonce les fins de piste. La valeur entre
                // dans la signature ci-dessous, de sorte qu'une réélection soit
                // transmise même si rien d'autre n'a bougé.
                state.pilot = this.isPilot(client, guildId);

                // Les droits varient d'un tableau de bord à l'autre : ils entrent
                // dans la signature ci-dessous, de sorte qu'une révocation parte
                // même quand rien d'autre n'a bougé.
                Object.assign(state, this._shareStateFor(client, guildId));

                // Mettre à jour le canal vocal sélectionné sur le client pour rester synchronisé avec l'état réel du bot
                if (state.selectedVoiceChannelId) {
                    client.selectedVoiceChannelId = state.selectedVoiceChannelId;
                }

                // botStats change à chaque appel (horodatage, mémoire) : l'exclure
                // de la comparaison, sinon aucun état ne serait jamais identique.
                const { botStats, ...withoutStats } = state;
                const signature = JSON.stringify(withoutStats);
                if (client._lastStateSignature === signature) return;
                client._lastStateSignature = signature;

                client.send(JSON.stringify({ type: 'state', data: state }));
            }
        });
    }

    /**
     * Diffuse la seule liste des locuteurs d'une guilde.
     *
     * La parole va et vient plusieurs fois par seconde et par personne. Y
     * répondre par un état complet ferait resérialiser à chaque fois la file,
     * l'historique et toutes les playlists — pour un tableau qui ne change pas.
     * Message léger, donc, sur le modèle de `progress`.
     *
     * @param {string} guildId
     */
    broadcastSpeakers(guildId) {
        if (!this.wss) return;

        const duckingManager = this.client?.duckingManagers?.get(guildId);
        if (!duckingManager) return;

        let queue = null;
        try {
            const { useMainPlayer } = require('discord-player');
            queue = useMainPlayer()?.queues?.get(guildId) || null;
        } catch (e) {}

        // Le bot n'écoute qu'un salon : la connexion fait foi. Un tableau de
        // bord qui en consulte un autre ne doit voir personne parler, sans quoi
        // il animerait des membres qu'il n'écoute pas.
        const listeningChannel = queue?.channel?.id || duckingManager.channelId || null;
        const speakerList = Array.from(duckingManager.activeSpeakers);

        this.wss.clients.forEach((client) => {
            if (client.readyState !== 1 || client.selectedGuildId !== guildId) return;
            const matches = !!listeningChannel && client.selectedVoiceChannelId === listeningChannel;
            try {
                client.send(JSON.stringify({
                    type: 'speakers',
                    data: { speakers: matches ? speakerList : [] },
                }));
            } catch (e) {}
        });
    }

    /**
     * Ce que ce tableau de bord a le droit de faire, tel qu'il doit l'afficher.
     *
     * Le client s'en sert pour griser ce qui lui est interdit ; le serveur ne
     * s'y fie pas — il revérifie tout à l'arrivée, dans websocket/wsHandler.js.
     *
     * Le maître reçoit en plus la liste des partages en vigueur et l'état de la
     * configuration OAuth : c'est de quoi remplir sa fenêtre de partage.
     *
     * @param {import('ws').WebSocket} ws
     * @param {string} guildId
     * @returns {object}
     */
    _shareStateFor(ws, guildId) {
        const permissions = require('./permissions');
        const oauth = require('./oauth');

        const identity = ws.identity || { master: false };

        if (identity.master) {
            return {
                role: 'master',
                /*
                 * Le maître reçoit son identité comme les invités.
                 *
                 * Il était le seul dont le tableau de bord ignorait le nom : ses
                 * droits ne dépendent de personne, la question ne se posait donc
                 * pas. Elle se pose depuis qu'on peut changer de compte — il faut
                 * bien montrer duquel on part.
                 */
                identity: {
                    userId: identity.session?.userId || null,
                    displayName: identity.session?.displayName || '',
                    avatar: identity.session?.avatar || null,
                },
                /*
                 * Être maître et tenir le jeton ne sont pas la même chose.
                 *
                 * Le premier se lit sur le compte Discord, et vaut donc depuis
                 * n'importe quel poste ; le second dit qu'on est devant la
                 * machine, le jeton s'écrivant dans la console de celui qui
                 * lance le bot. Le changement de compte n'emporte la propriété
                 * qu'au second, et l'interface doit pouvoir annoncer laquelle
                 * des deux situations est la sienne.
                 */
                holdsToken: Boolean(identity.holdsToken),
                permissions: permissions.allPermissions(),
                sharing: {
                    oauthReady: oauth.isConfigured(),
                    publicUrl: oauth.publicUrl(),
                    // L'URL de rappel telle que le serveur la construit : celle
                    // du relais quand aucune adresse n'est déclarée, et non
                    // l'adresse publique suivie du chemin de rappel.
                    callbackUrl: oauth.redirectUri(),
                    grants: database.getSharedControl(guildId),
                    knownUsers: this._knownGuests(),
                    pending: this._pendingGuests(guildId),
                    admitted: database.getAdmittedGuests(guildId),
                    // userId → droit → horodatage : ce que chacun a demandé.
                    requests: database.getRightRequests(guildId),
                    // Les invités dont les demandes sont en sourdine.
                    mutedRequests: database.getMutedRightRequests(guildId),
                    /*
                     * Le catalogue des droits voyage avec l'état.
                     *
                     * La fenêtre de partage dessine un interrupteur par droit,
                     * rangés par rubrique : elle a donc besoin de la liste, et
                     * la recopier dans le script du navigateur ferait deux
                     * tables à tenir d'accord. Celle-ci est la seule, et c'est
                     * celle qui refuse pour de bon.
                     */
                    catalogue: {
                        groups: permissions.GROUPS,
                        actions: permissions.GROUP_ACTIONS,
                        presets: permissions.PRESETS,
                    },
                },
            };
        }

        const userId = identity.session?.userId || null;
        return {
            role: 'guest',
            identity: {
                userId,
                displayName: identity.session?.displayName || '',
                avatar: identity.session?.avatar || null,
            },
            permissions: userId
                ? database.getUserPermissions(guildId, userId)
                : permissions.noPermissions(),
            // Ce qu'il a déjà demandé, pour que son bouton dise « envoyée »
            // plutôt que d'offrir de redemander ; et s'il peut encore demander.
            rightRequests: userId
                ? Object.keys(database.getRightRequests(guildId)[userId] || {})
                : [],
            requestsMuted: userId
                ? database.getMutedRightRequests(guildId).includes(String(userId))
                : false,
        };
    }

    /**
     * Les invités qui se sont nommés et attendent une réponse.
     *
     * Un invité qui suit le lien se connecte avec son compte Discord, puis
     * n'obtient rien : les droits ne s'héritent pas d'une authentification, il
     * faut que l'hôte les accorde. Jusqu'ici il disparaissait purement — la
     * fenêtre de partage n'affiche un compte absent du salon vocal que s'il a
     * déjà des droits, si bien que celui qui attend n'était visible nulle part.
     * Il patientait devant un tableau de bord inerte, et l'hôte ne savait même
     * pas qu'on frappait à la porte.
     *
     * Le propriétaire est écarté de sa propre file : il ne s'accorde rien.
     *
     * @param {string} guildId
     * @returns {Array<{userId: string, displayName: string, avatar: string|null, since: number}>}
     */
    _pendingGuests(guildId) {
        const guests = require('./guests');
        const owner = require('./owner');
        const grants = database.getSharedControl(guildId) || {};

        const admitted = new Set(database.getAdmittedGuests(guildId));
        const online = this._onlineGuestIds();

        return guests.list()
            .filter((u) => !grants[u.userId]
                && !admitted.has(String(u.userId))
                && !owner.isOwner({ userId: u.userId }))
            .map((u) => ({
                userId: u.userId,
                displayName: u.displayName || u.userId,
                avatar: u.avatar || null,
                since: u.lastSeenAt || 0,
                online: online.has(u.userId),
            }));
    }

    /**
     * Les comptes dont un tableau de bord est ouvert en ce moment.
     *
     * « En ligne » ne se déduit ni d'une session valable — un cookie dure trente
     * jours et ne dit rien de la présence — ni de l'appartenance au salon vocal :
     * on peut écouter sans tableau de bord, et tenir le tableau de bord sans
     * être dans le salon. La seule mesure honnête est la connexion elle-même.
     *
     * Le battement de cœur de `wss` ferme les sockets muettes au bout de trente
     * secondes ; un onglet fermé brutalement disparaît donc de cette liste dans
     * ce délai, sans qu'il y ait rien de plus à faire.
     *
     * @returns {Set<string>}
     */
    _onlineGuestIds() {
        const ids = new Set();
        for (const client of this.wss?.clients || []) {
            if (client.readyState !== 1) continue;
            const userId = client.identity?.session?.userId;
            if (userId) ids.add(String(userId));
        }
        return ids;
    }

    /**
     * Le carnet des invités, augmenté de qui est là en ce moment.
     *
     * Le carnet (web/guests.js) survit aux sessions : un invité pourvu de droits
     * mais dont le cookie a expiré reste donc nommé et illustré dans la fenêtre
     * de partage, simplement marqué hors ligne. C'était l'inverse auparavant —
     * la liste venait des sessions, et l'invité s'effaçait avec la sienne.
     *
     * @returns {Array<{ userId: string, displayName: string, avatar: string|null,
     *   lastSeenAt: number, firstSeenAt: number, online: boolean }>}
     */
    _knownGuests() {
        const guests = require('./guests');
        const online = this._onlineGuestIds();

        return guests.list().map((guest) => ({
            userId: guest.userId,
            displayName: guest.displayName || guest.userId,
            avatar: guest.avatar || null,
            firstSeenAt: guest.firstSeenAt || 0,
            /*
             * L'horodatage reste celui du carnet, figé.
             *
             * Il serait tentant d'y mettre l'instant présent pour quelqu'un de
             * connecté, puisqu'on le voit à l'instant. Ce serait ruineux :
             * `broadcastState` ne renvoie l'état que s'il a changé, et une date
             * recalculée à chaque appel le ferait paraître différent à chaque
             * fois — tous les tableaux de bord recevraient tout, en continu.
             *
             * La fenêtre n'en a d'ailleurs pas besoin : elle annonce « en
             * ligne » pour les présents, et ne se sert de la date que pour les
             * absents, à qui elle dit « vu il y a… ».
             */
            lastSeenAt: guest.lastSeenAt || 0,
            online: online.has(guest.userId),
        }));
    }

    /**
     * La file de lecture du serveur, créée à la demande en diffusion personnelle.
     *
     * ## Pourquoi
     *
     * La file de discord-player n'existe qu'une fois le bot entré dans un salon
     * vocal. Or elle ne sert pas qu'à la voix : c'est elle qui héberge tout
     * l'état de lecture, `virtualCurrentTrack` compris — celui du mode
     * personnel, où le son sort du navigateur et où Discord n'a rien à faire.
     *
     * Loin de chez soi, personne n'est dans le salon, le gardien de présence
     * l'y fait sortir, et la file s'en va avec la connexion. Tout ce qui touche
     * à la lecture repartait alors sur `if (!queue) return` : le bouton de
     * lecture écrivait bien l'index en base puis ne jouait rien, un dépôt dans
     * la file d'attente était annoncé au journal sans jamais y apparaître, et
     * rien — ni erreur, ni ligne de journal, ni message à l'écran — ne disait
     * pourquoi.
     *
     * `queues.create()` ne rejoint aucun salon ; c'est `queue.connect()`, appelé
     * séparément, qui branche la voix. Créer le contenant sans le brancher rend
     * donc au mode personnel l'indépendance qu'il aurait toujours dû avoir.
     *
     * En diffusion « everyone », rien n'est créé : là, le son sort du bot, et
     * une file sans connexion ne jouerait pas davantage. L'appelant retrouve son
     * `null` et le comportement d'avant.
     *
     * @param {string} guildId
     * @returns {import('discord-player').GuildQueue|null}
     */
    ensurePlaybackQueue(guildId) {
        // Un onglet qui n'a pas encore choisi de serveur passe ici à chaque
        // message : sans cette garde, la lecture des réglages porterait sur
        // `undefined`.
        if (!guildId) return null;

        const { useMainPlayer } = require('discord-player');
        const player = useMainPlayer();

        const existing = player.queues.get(guildId);
        if (existing) return existing;

        const settings = database.getSettings(guildId);
        if (settings.broadcastMode !== 'personal') return null;

        const guild = this.client?.guilds?.cache?.get(guildId);
        if (!guild) return null;

        try {
            const queue = player.queues.create(guild, {
                nodeOptions: {
                    selfDeaf: false,
                    leaveOnEmpty: false,
                    leaveOnEmptyCooldown: 30000,
                    leaveOnEnd: false,
                    leaveOnEndCooldown: 60000,
                    volume: settings.baseVolume,
                }
            });
            /*
             * Le salon que le tableau de bord regarde, sans y entrer.
             *
             * `getChannelPlaybackState` ne renvoie l'état vivant — dont
             * `virtualCurrentTrack` — que si le salon demandé est celui de la
             * file. Sans cette ligne, le contenant existait, la piste s'y
             * posait, et l'état diffusé restait vide : on avait déplacé le
             * silence d'un cran sans le lever. Le champ ne branche aucune voix,
             * il ne fait que désigner ; `_initClient` le pose déjà ainsi sur une
             * file sans connexion.
             */
            queue.activeChannelId = settings.lastVoiceChannelId
                || settings.defaultVoiceChannelId
                || null;

            log.info(`[WebServer] Playback container created without a voice connection `
                + `(personal broadcast, guild ${guildId}, channel ${queue.activeChannelId || 'none'}).`);
            return queue;
        } catch (err) {
            log.error('[WebServer] Could not create the playback container:', err.message);
            return null;
        }
    }

    /**
     * Ce tableau de bord est-il celui qui pilote la lecture de ce serveur ?
     * @param {import('ws').WebSocket} ws
     * @param {string} guildId
     * @returns {boolean}
     */
    isPilot(ws, guildId) {
        return this.pilots.get(guildId) === ws;
    }

    /**
     * Désigne un pilote si le serveur n'en a pas, ou si le sien a disparu.
     *
     * Rien ne permet de deviner lequel des appareils connectés l'utilisateur
     * écoute réellement. Ce qui importe est qu'il n'y en ait qu'un, et qu'il
     * soit remplacé s'il s'en va — sans quoi la lecture ne s'enchaînerait plus
     * du tout.
     *
     * ## Le maître d'abord
     *
     * Le premier arrivé l'emportait, quel qu'il soit. Or le pilote ne fait pas
     * qu'annoncer les fins de piste : c'est sa position qui fait foi pour tous
     * (voir `handleSyncProgress`). Un invité connecté avant l'hôte — ce qui
     * arrive à chaque redémarrage du bot, son onglet se reconnectant le
     * premier — menait donc la lecture de l'hôte, avec le retard de sa liaison.
     *
     * Le tableau de bord du maître prend donc la place dès qu'il regarde cette
     * guilde, y compris à un invité déjà en place. Entre plusieurs onglets du
     * maître, ou en son absence, le premier arrivé l'emporte comme avant.
     *
     * @param {string} guildId
     * @returns {import('ws').WebSocket|null}
     */
    _ensurePilot(guildId) {
        if (!guildId) return null;

        const watching = [...this.wss.clients]
            .filter((client) => client.readyState === 1 && client.selectedGuildId === guildId);
        const isMaster = (client) => Boolean(client.identity && client.identity.master);
        const master = watching.find(isMaster);

        /*
         * Le pilote en place n'est gardé que s'il est encore sur cette guilde.
         *
         * Sa seule connexion ne suffit pas : un tableau de bord qui change de
         * serveur reste ouvert, et resterait donc inscrit comme pilote d'une
         * guilde qu'il ne regarde plus. Elle n'aurait alors plus personne pour
         * annoncer ses fins de piste, tout en paraissant pourvue.
         *
         * Et un invité ne le reste que tant que le maître n'est pas là.
         */
        const currentPilot = this.pilots.get(guildId);
        if (currentPilot && watching.includes(currentPilot)
            && (isMaster(currentPilot) || !master)) {
            return currentPilot;
        }

        const chosen = master || watching[0];
        if (chosen) {
            this.pilots.set(guildId, chosen);
            log.info(`[WebServer] Pilot dashboard designated for guild ${guildId}: `
                + `${isMaster(chosen) ? 'the owner' : `guest ${chosen.identity?.session?.userId || '?'}`} `
                + `(${this._countClients(guildId)} connected).`);
            this.broadcastState(guildId);
            return chosen;
        }

        this.pilots.delete(guildId);
        return null;
    }

    /** Nombre de tableaux de bord connectés sur une guilde. */
    _countClients(guildId) {
        let n = 0;
        for (const client of this.wss.clients) {
            if (client.readyState === 1 && client.selectedGuildId === guildId) n++;
        }
        return n;
    }

    /**
     * Retire un tableau de bord et réélit un pilote s'il l'était.
     * @param {import('ws').WebSocket} ws
     */
    _removeClient(ws) {
        for (const [guildId, pilot] of this.pilots.entries()) {
            if (pilot !== ws) continue;
            this.pilots.delete(guildId);
            log.info(`[WebServer] The pilot dashboard of guild ${guildId} disconnected.`);
            // Différé : à cet instant la connexion figure encore parmi les
            // clients, et se réélirait elle-même.
            setImmediate(() => this._ensurePilot(guildId));
        }

        /*
         * Le départ d'un invité éteint sa pastille chez le maître.
         *
         * Même raison que le différé ci-dessus : la socket qui se ferme est
         * encore comptée parmi les clients à cet instant, et `_onlineGuestIds`
         * la verrait toujours en ligne. Un tour plus tard, elle a disparu.
         *
         * Seules les connexions nommées valent la peine : une socket sans
         * session ne figure dans aucune liste, et rien ne changerait à l'écran.
         */
        if (ws.identity?.session?.userId && ws.selectedGuildId) {
            const guildId = ws.selectedGuildId;
            setImmediate(() => this.broadcastState(guildId));
        }
    }

    /**
     * Un tableau de bord est-il connecté sur cette guilde ?
     *
     * En diffusion personnelle, c'est la condition pour que quelque chose soit
     * réellement audible : le lecteur vit dans le navigateur, pas dans le bot.
     *
     * @param {string} guildId
     * @returns {boolean}
     */
    hasConnectedClient(guildId) {
        if (!this.wss || !this.wss.clients) return false;
        for (const client of this.wss.clients) {
            if (client.readyState === 1 && client.selectedGuildId === guildId) return true;
        }
        return false;
    }

    /**
     * Abonne ou désabonne un client du flux mémoire haute cadence.
     *
     * Le tableau de bord ne le demande que tiroir ouvert : tant que personne
     * ne regarde, aucun minuteur ne tourne et la mesure d'une fois par seconde
     * embarquée dans `progress` suffit à entretenir l'historique.
     *
     * @param {import('ws').WebSocket} ws
     * @param {boolean} actif
     */
    setMemoryStream(ws, active) {
        if (active) {
            this._memorySubscribers.add(ws);
            this._startMemoryStream();
        } else {
            this._memorySubscribers.delete(ws);
            this._stopMemoryStreamIfIdle();
        }
    }

    _startMemoryStream() {
        if (this._memorySampleTimer) return;
        this._memoryBuffer = [];

        let lastSample = 0;
        this._memorySampleTimer = setInterval(() => {
            const t = Date.now();
            if (t - lastSample < MEM_MIN_GAP_MS) return;
            lastSample = t;

            const m = process.memoryUsage();
            // Tableau compact plutôt qu'objet nommé : à cette cadence, les noms
            // de champs pèseraient plus lourd que les valeurs elles-mêmes.
            this._memoryBuffer.push([t, m.rss, m.heapUsed, m.heapTotal]);
            if (this._memoryBuffer.length > MEM_MAX_BATCH) {
                this._memoryBuffer.splice(0, this._memoryBuffer.length - MEM_MAX_BATCH);
            }
        }, MEM_SAMPLE_PERIOD_MS);

        this._memorySendTimer = setInterval(() => {
            if (this._memoryBuffer.length === 0) {
                this._stopMemoryStreamIfIdle();
                return;
            }
            const batch = this._memoryBuffer;
            this._memoryBuffer = [];
            const payload = JSON.stringify({ type: 'memory', data: { samples: batch } });

            for (const ws of Array.from(this._memorySubscribers)) {
                if (ws.readyState !== 1) {
                    this._memorySubscribers.delete(ws);
                    continue;
                }
                /*
                 * Une socket qui n'écoule plus ce qu'on lui confie.
                 *
                 * Lui ajouter des lots n'arrangerait rien : ils s'entasseraient
                 * derrière les précédents et arriveraient d'un bloc, en retard —
                 * exactement la courbe qui avance par à-coups. On saute donc son
                 * tour ; l'historique d'une seconde, porté par `progress`,
                 * comble le trou. Et on le dit : c'est la signature d'une
                 * liaison qui ne suit pas, à distinguer d'un navigateur qui
                 * reçoit bien mais peint mal (voir js/drawer.js).
                 */
                if (ws.bufferedAmount > MEM_BACKLOG_BYTES) {
                    const now = Date.now();
                    if (!ws._memoryBacklogLoggedAt || now - ws._memoryBacklogLoggedAt > MEM_BACKLOG_LOG_EVERY_MS) {
                        ws._memoryBacklogLoggedAt = now;
                        const who = ws.identity?.master
                            ? 'the owner'
                            : `guest ${ws.identity?.session?.userId || '?'}`;
                        log.warn(`[WebServer] Memory feed held back for ${who}: `
                            + `${Math.round(ws.bufferedAmount / 1024)} KB still waiting on the socket.`);
                    }
                    continue;
                }
                try { ws.send(payload); } catch (e) {}
            }
            this._stopMemoryStreamIfIdle();
        }, MEM_SEND_PERIOD_MS);

        log.debug(`[WebServer] High-rate memory feed started (${MEM_RATE_HZ} Hz).`);
    }

    _stopMemoryStreamIfIdle() {
        if (this._memorySubscribers.size > 0) return;
        if (this._memorySampleTimer) {
            clearInterval(this._memorySampleTimer);
            this._memorySampleTimer = null;
        }
        if (this._memorySendTimer) {
            clearInterval(this._memorySendTimer);
            this._memorySendTimer = null;
        }
        this._memoryBuffer = [];
    }

    /**
     * Diffuse uniquement ce qui évolue en continu : position de lecture et
     * statistiques du processus.
     *
     * Utilisé par la boucle périodique à la place de broadcastState, dont la
     * charge utile — file d'attente, historique et playlists reformatés —
     * croît avec le nombre de pistes alors que rien n'y change entre deux
     * secondes.
     *
     * @param {string} guildId
     */
    broadcastProgress(guildId) {
        if (this.wss.clients.size === 0) return;

        const { useMainPlayer } = require('discord-player');
        const player = useMainPlayer();
        const queue = player.queues.get(guildId);
        const settings = database.getSettings(guildId);

        const memory = process.memoryUsage();
        const botStats = {
            memory: {
                rss: memory.rss,
                heapUsed: memory.heapUsed,
                heapTotal: memory.heapTotal,
                external: memory.external
            },
            uptime: Math.floor(process.uptime()),
            timestamp: Date.now()
        };

        this.wss.clients.forEach((client) => {
            if (client.readyState !== 1 || client.selectedGuildId !== guildId) return;
            const position = this.getPlaybackPosition(queue, client.selectedVoiceChannelId, settings);
            try {
                client.send(JSON.stringify({ type: 'progress', data: { ...position, botStats } }));
            } catch (e) {}
        });
    }

    /**
     * Calcule la position de lecture d'un salon, sans toucher aux pistes.
     *
     * Séparé de getChannelPlaybackState pour que la diffusion périodique
     * n'ait pas à reformater toute la file d'attente et l'historique alors que
     * seule la progression évolue.
     *
     * @returns {{ progress: object|null, isPlaying: boolean, isPaused: boolean,
     *   attenteAuditeur: object|null }}
     */
    getPlaybackPosition(queue, channelId, settings) {
        const isPersonal = settings.broadcastMode === 'personal';
        const activeChannelId = queue?.activeChannelId || queue?.channel?.id;

        // Bot retiré d'un salon vide : son lecteur est démonté et ne rendrait
        // que des zéros. La session a relevé la position avant le départ.
        if (queue && channelId && channelId === activeChannelId && queue.session.isFrozen()) {
            const wait = queue.session.listenerWait();
            return {
                progress: buildProgress(queue.frozenPositionMs, queue.currentTrack),
                isPlaying: queue.session.getIsPlaying(),
                isPaused: queue.session.getIsPaused(),
                // Le tableau de bord annoncerait sinon une lecture en cours sur
                // une barre qui n'avance pas, sans rien qui l'explique.
                listenerWait: wait
                    ? { ...wait, channelName: this._channelName(queue.guild?.id, channelId) }
                    : null,
            };
        }

        if (queue && channelId && channelId === activeChannelId) {
            let timestamp = null;
            if (queue.currentTrack) {
                try {
                    timestamp = queue.node.getTimestamp();
                } catch (err) {}
            }

            return {
                // Fondu enchaîné du bus de mixage : deux morceaux sonnent
                // ensemble, et le tableau de bord doit pouvoir les montrer tous
                // les deux. En diffusion personnelle, le navigateur tient cette
                // information lui-même — ses deux éléments audio sont sous sa
                // main —, et le serveur n'a rien à en dire.
                mixTransition: isPersonal ? null : crossfadeState(queue),
                // La durée passe par `buildProgress` comme dans les autres
                // branches, et non par `timestamp.total` : le lecteur y divise
                // déjà la durée par la vitesse de lecture, alors que la position
                // qu'il rend reste comptée dans le temps du fichier. Le tableau
                // de bord, lui, applique la vitesse lui-même à l'affichage — la
                // durée s'y retrouvait donc divisée deux fois, et la barre de
                // progression rapportait une position du fichier à une durée
                // qui ne l'était plus. Il attend des repères bruts, ici comme
                // pour les demandes de repositionnement.
                progress: isPersonal
                    ? buildProgress(queue.virtualProgressMs, queue.virtualCurrentTrack)
                    : (queue.transitioningToEveryone && queue.transitionTrack
                        ? buildProgress(queue.transitionTargetProgress, queue.transitionTrack)
                        : (timestamp ? buildProgress(timestamp.current.value, queue.currentTrack) : null)),
                // La session porte la même logique de branchement, testée
                isPlaying: queue.session.getIsPlaying(),
                isPaused: queue.session.getIsPaused(),
                listenerWait: null,
            };
        }

        const savedState = queue?.channelStates?.[channelId];
        if (savedState) {
            return {
                progress: buildProgress(savedState.currentProgress, savedState.currentTrack),
                isPlaying: !!savedState.isPlaying,
                isPaused: !!savedState.isPaused,
                listenerWait: null,
            };
        }

        return { progress: null, isPlaying: false, isPaused: false, listenerWait: null };
    }

    /**
     * Nom lisible d'un salon vocal, pour les messages du tableau de bord.
     * @returns {string|null}
     */
    _channelName(guildId, channelId) {
        if (!guildId || !channelId) return null;
        const guild = this.client?.guilds?.cache?.get(guildId);
        return guild?.channels?.cache?.get(channelId)?.name || null;
    }

    /**
     * Récupère l'état de lecture spécifique à un salon vocal (actif ou en cache).
     */
    getChannelPlaybackState(queue, channelId, settings) {
        const isPersonal = settings.broadcastMode === 'personal';
        const activeChannelId = queue?.activeChannelId || queue?.channel?.id;
        const position = this.getPlaybackPosition(queue, channelId, settings);

        if (queue && channelId && channelId === activeChannelId) {
            /*
             * Le lecteur vient d'avancer : le rangement s'aligne sur lui.
             *
             * Ici plutôt qu'aux dix endroits qui touchent la file — ajout,
             * retrait, déplacement, vidage, passage au titre suivant. Un
             * onzième oublierait la recopie, et le rangement mentirait sans
             * que rien ne le dise. L'écriture de la base est différée : ces
             * appels répétés se fondent en une seule.
             *
             * Le miroir ne photographie pas : il recolle ce que le lecteur
             * porte avec ce que le rangement gardait après son premier
             * aiguillage, que le lecteur n'a jamais reçu. Voir `channelQueue`.
             */
            channelQueue.mirror(queue.guild.id, isPersonal
                ? (queue.virtualTracks || [])
                : (queue.tracks ? queue.tracks.toArray() : []), settings);

            // Salon actif : renvoyer l'état en direct du lecteur
            return {
                currentTrack: isPersonal
                    ? formatTrackWithPreload(queue.virtualCurrentTrack)
                    : (queue.transitioningToEveryone && queue.transitionTrack
                        ? formatTrackWithPreload(queue.transitionTrack)
                        : formatTrackWithPreload(queue.currentTrack)),
                ...position,
                /*
                 * Le panneau montre le rangement, et non le lecteur.
                 *
                 * Les deux disent la même chose de la tête de file — le miroir
                 * vient de les aligner —, mais le lecteur ignore tout de ce qui
                 * suit le premier aiguillage. Le lire directement escamoterait
                 * la transition et les titres d'après, qui existent pourtant.
                 *
                 * Une playlist occupe-t-elle le lecteur ? Alors ce rangement est
                 * exactement ce que la file gardait en attendant son tour : le
                 * même chemin sert les deux cas.
                 */
                queue: channelQueue.read(settings)
                    .map(formatTrackWithPreload)
                    .filter(t => !t || !queue.transitioningToEveryone || !queue.transitionTrack
                        || t.url !== queue.transitionTrack.url),
                // Historique : la piste la plus récente en tête, dans les deux modes.
                // C'est l'ordre naturel de `history.tracks`, une file LIFO — et celui
                // que `virtualHistory` respecte désormais aussi.
                history: isPersonal
                    ? (queue.virtualHistory || []).map(formatTrackWithPreload)
                    : (queue.history ? queue.history.tracks.toArray().map(formatTrackWithPreload) : [])
            };
        } else {
            // Salon inactif : charger les données depuis queue.channelStates s'il y a un cache
            const savedState = queue?.channelStates?.[channelId];
            if (savedState) {
                return {
                    currentTrack: savedState.currentTrack ? formatTrackWithPreload(savedState.currentTrack) : null,
                    ...position,
                    queue: (savedState.queue || []).map(formatTrackWithPreload),
                    history: (savedState.history || []).map(formatTrackWithPreload)
                };
            }
        }

        return {
            currentTrack: null,
            ...position,
            queue: [],
            history: []
        };
    }

    /**
     * Génère l'état complet du bot pour une guild.
     * @param {string} guildId
     * @param {string|null} selectedVoiceChannelId
     * @returns {object}
     */
    getState(guildId, selectedVoiceChannelId = null) {
        const settings = database.getSettings(guildId);
        const { useMainPlayer } = require('discord-player');
        const player = useMainPlayer();
        const queue = player.queues.get(guildId);

        // Prioriser la sélection client, puis le salon actif de la queue, puis
        // le salon connecté, puis le dernier salon utilisé. Le favori n'entre
        // pas dans cette liste : appliqué au démarrage, il est déjà le dernier
        // salon utilisé tant que rien d'autre n'a été choisi — et l'y consulter
        // en propre le ferait ressurgir bien après, à la moindre absence de
        // rattachement.
        let activeVoiceChannelId = selectedVoiceChannelId || queue?.activeChannelId || queue?.channel?.id || settings.lastVoiceChannelId;
        if (!activeVoiceChannelId) {
            const lastChannelInfo = database.getLastVoiceChannel();
            if (lastChannelInfo.guildId === guildId && lastChannelInfo.channelId) {
                activeVoiceChannelId = lastChannelInfo.channelId;
            }
        }
        if (!activeVoiceChannelId && this.client) {
            const guild = this.client.guilds.cache.get(guildId);
            if (guild) {
                const voiceChannels = guild.channels.cache.filter(c => c.type === 2); // GuildVoice
                const withUsers = voiceChannels.filter(c => c.members.filter(m => !m.user.bot).size > 0);
                if (withUsers.size > 0) {
                    activeVoiceChannelId = withUsers.first().id;
                } else if (voiceChannels.size > 0) {
                    activeVoiceChannelId = voiceChannels.first().id;
                }
            }
        }

        // Locuteurs du salon que le tableau de bord affiche, et de lui seul :
        // l'écoute suit le bot, qui peut se trouver ailleurs que le salon
        // consulté. La connexion fait foi plutôt que le salon mémorisé par le
        // gestionnaire, qui ne serait qu'un reflet de plus à tenir à jour.
        let activeSpeakers = [];
        const duckingManager = this.client?.duckingManagers?.get(guildId);
        const listeningChannel = queue?.channel?.id || duckingManager?.channelId || null;
        if (duckingManager && listeningChannel && listeningChannel === activeVoiceChannelId) {
            activeSpeakers = Array.from(duckingManager.activeSpeakers);
        }

        const guildsList = this.client ? this.client.guilds.cache.map(g => {
            const q = player.queues.get(g.id);
            const voiceChannels = g.channels.cache
                .filter(c => c.type === 2) // GuildVoice
                .sort((a, b) => a.position - b.position)
                .map(c => {
                    const botConnected = q?.channel?.id === c.id;
                    const nonBotMembers = c.members.filter(m => !m.user.bot);
                    return {
                        id: c.id,
                        name: c.name,
                        userCount: nonBotMembers.size,
                        botConnected: botConnected,
                        // La session plutôt que `q.node` : en diffusion
                        // personnelle le lecteur de discord-player ne porte
                        // rien — le son sort du navigateur —, et le salon était
                        // annoncé « inactif » pendant qu'un morceau jouait.
                        isPlaying: botConnected && q ? q.session.getIsPlaying() : false,
                        // Une lecture en pause n'est pas une absence de lecture :
                        // la liste des salons annonçait « inactif » là où un
                        // morceau attend simplement d'être repris.
                        isPaused: botConnected && q ? q.session.getIsPaused() : false
                    };
                });

            return {
                id: g.id,
                name: g.name,
                defaultVoiceChannelId: database.getSettings(g.id).defaultVoiceChannelId || null,
                currentVoiceChannelId: q?.channel?.id || null,
                voiceChannels: voiceChannels
            };
        }) : [];

        const channelPlaybackState = this.getChannelPlaybackState(queue, activeVoiceChannelId, settings);

        return {
            guildId,
            selectedVoiceChannelId: activeVoiceChannelId,
            guilds: guildsList,
            currentTrack: channelPlaybackState.currentTrack,
            progress: channelPlaybackState.progress,
            isPlaying: channelPlaybackState.isPlaying,
            isPaused: channelPlaybackState.isPaused,
            // Lecture immobile faute d'auditeur : de quoi l'expliquer plutôt
            // que de laisser le tableau de bord passer pour en panne.
            listenerWait: channelPlaybackState.listenerWait || null,
            isTransitioning: !!queue?.isPendingTransition,
            repeatMode: queue ? queue.repeatMode : 0,
            volume: settings.baseVolume,
            settings: {
                duckingEnabled: settings.duckingEnabled,
                duckingLevel: settings.duckingLevel,
                duckingDelay: settings.duckingDelay,
                duckingFade: settings.duckingFade,
                broadcastMode: settings.broadcastMode,
                playbackSpeed: settings.playbackSpeed || '1.0',
                defaultVoiceChannelId: settings.defaultVoiceChannelId || null,
                mixEnabled: !!settings.mixEnabled,
                mixDuration: settings.mixDuration !== undefined ? settings.mixDuration : 5,
                mixType: settings.mixType || 'volume',
                lufsSyncEnabled: !!settings.lufsSyncEnabled,
                lufsSyncTarget: settings.lufsSyncTarget !== undefined
                    ? settings.lufsSyncTarget
                    : loudness.DEFAULT_SYNC_TARGET,
                importAudioQuality: settings.importAudioQuality || '320',
                importVideoQuality: settings.importVideoQuality || '720',
                // Destination du champ d'ajout. Sa valeur par défaut vit dans
                // `_defaults()` de la base, d'où elle arrive déjà fusionnée.
                addTarget: settings.addTarget,
                importFormat: settings.importFormat,
                // Secondes. Zéro est un choix, pas une absence de valeur : le
                // `??` est donc de rigueur ici.
                presenceDepartureDelay: settings.presenceDepartureDelay ?? 30
            },
            queue: channelPlaybackState.queue,
            history: channelPlaybackState.history,
            playlists: (database.getGlobalPlaylists() || []).map(p => ({
                ...p,
                tracks: (p.tracks || []).map(formatTrackWithPreload)
            })),
            // Fade-in de démarrage laissé en attente parce que le son sort du
            // navigateur : le client le joue à sa connexion, puis le consomme.
            startupFadein: queue?.pendingStartupFadein || null,
            activePlaybackSource: settings.activePlaybackSource || 'queue',
            playlistCurrentIndex: settings.playlistCurrentIndex || 0,
            loopPlaylist: !!settings.loopPlaylist,
            shuffle: !!settings.shuffle,
            speakers: activeSpeakers,
            ignoredVoiceUsers: (() => {
                if (activeVoiceChannelId) {
                    const ignored = settings.ignoredVoiceUsers?.[activeVoiceChannelId];
                    return ignored || [];
                }
                return [];
            })(),
            members: (() => {
                if (activeVoiceChannelId && this.client) {
                    const guild = this.client.guilds.cache.get(guildId);
                    if (guild) {
                        const channel = guild.channels.cache.get(activeVoiceChannelId);
                        if (channel) {
                            return channel.members.filter(m => !m.user.bot).map(m => ({
                                id: m.id,
                                displayName: m.displayName,
                                avatar: m.user.displayAvatarURL({ size: 64 }),
                                /*
                                 * Micro coupé, et par qui.
                                 *
                                 * Les deux voyagent séparément plutôt que
                                 * réduits à un seul booléen : le tableau de
                                 * bord ne dit pas la même chose de quelqu'un
                                 * qui s'est tu et de quelqu'un qu'un modérateur
                                 * a fait taire, et c'est une distinction que le
                                 * serveur ne doit pas trancher à sa place.
                                 *
                                 * `m.voice` existe toujours ici — ces membres
                                 * sont ceux d'un salon vocal —, mais le lire
                                 * prudemment coûte moins qu'un tableau de bord
                                 * vide le jour où le cache prend du retard.
                                 */
                                selfMute: Boolean(m.voice?.selfMute),
                                serverMute: Boolean(m.voice?.serverMute)
                            }));
                        }
                    }
                }
                return [];
            })(),
            botStats: {
                memory: {
                    rss: process.memoryUsage().rss,
                    heapUsed: process.memoryUsage().heapUsed,
                    heapTotal: process.memoryUsage().heapTotal,
                    external: process.memoryUsage().external
                },
                uptime: Math.floor(process.uptime()),
                timestamp: Date.now()
            }
        };
    }

    /**
     * @param {number} [startProgressMs=0] - Position de départ dans le titre
     *   chargé. Sans effet en diffusion « everyone », où la lecture est menée
     *   par le lecteur du bot et non par le navigateur.
     */
    async _syncPlaylistToPlayer(guildId, playlistId, startIndex = 0, forceRestart = false, startProgressMs = 0) {
        const { useMainPlayer, Track } = require('discord-player');
        const player = useMainPlayer();
        const queue = this.ensurePlaybackQueue(guildId);
        if (!queue) return;

        const globalPlaylists = database.getGlobalPlaylists();
        const playlist = globalPlaylists.find(p => p.id === playlistId);
        if (!playlist) return;

        const settings = database.getSettings(guildId);
        const isPersonal = settings.broadcastMode === 'personal';

        /*
         * Le lecteur ne reçoit la playlist que jusqu'à son premier aiguillage.
         *
         * Rien au-delà, et c'est ce qui fait tenir la fonctionnalité : il tombe
         * en panne sèche exactement sur la transition, et le chemin qui traite
         * déjà les fins de playlist décide alors de la suite. Lui laisser la
         * liste entière obligerait à l'arrêter en vol, entre l'annonce de fin
         * d'un titre et l'attaque du suivant — course qu'on ne gagnerait pas
         * toujours. Voir `transitions`.
         *
         * La liste rendue commence au titre demandé : les indices qui suivent
         * sont donc relatifs à elle, et non plus à la playlist rangée.
         */
        const tracks = transitions.upTo(playlist.tracks || [], startIndex).tracks;

        if (isPersonal) {
            if (tracks.length === 0) {
                queue.virtualCurrentTrack = null;
                queue.virtualTracks = [];
                queue.virtualIsPlaying = false;
                queue.virtualIsPaused = false;
                queue.virtualProgressMs = 0;
            } else {
                const targetTrack = tracks[0] || null;
                const isSameTrack = !forceRestart && queue.virtualCurrentTrack && targetTrack && arePathsOrUrlsEqual(queue.virtualCurrentTrack.url, targetTrack.url);

                if (isSameTrack) {
                    queue.virtualTracks = tracks.slice(1).map(t => ({
                        title: t.title,
                        author: t.author || 'Inconnu',
                        duration: t.duration || '0:00',
                        thumbnail: t.thumbnail || null,
                        url: t.url,
                        queryType: t.queryType || (t.url && (t.url.startsWith('http') ? 'youtube' : 'file')),
                        raw: {},
                        extractorName: t.extractorName || null
                    }));
                } else {
                    queue.virtualCurrentTrack = targetTrack ? {
                        title: targetTrack.title,
                        author: targetTrack.author || 'Inconnu',
                        duration: targetTrack.duration || '0:00',
                        thumbnail: targetTrack.thumbnail || null,
                        url: targetTrack.url,
                        queryType: targetTrack.queryType || (targetTrack.url && (targetTrack.url.startsWith('http') ? 'youtube' : 'file')),
                        raw: {},
                        extractorName: targetTrack.extractorName || null
                    } : null;
                    queue.virtualTracks = tracks.slice(1).map(t => ({
                        title: t.title,
                        author: t.author || 'Inconnu',
                        duration: t.duration || '0:00',
                        thumbnail: t.thumbnail || null,
                        url: t.url,
                        queryType: t.queryType || (t.url && (t.url.startsWith('http') ? 'youtube' : 'file')),
                        raw: {},
                        extractorName: t.extractorName || null
                    }));
                    queue.virtualProgressMs = startProgressMs;
                    queue.virtualIsPlaying = !!queue.virtualCurrentTrack;
                    queue.virtualIsPaused = false;
                    queue.virtualLastUpdated = Date.now();
                }
            }
        } else {
            const targetTrackData = tracks[0];
            const hasCurrentTrack = queue.currentTrack;
            const isSameTrack = !forceRestart && hasCurrentTrack && targetTrackData && arePathsOrUrlsEqual(hasCurrentTrack.url, targetTrackData.url);

            if (isSameTrack) {
                queue.tracks.clear();
                const subsequentTracksData = tracks.slice(1);
                if (subsequentTracksData.length > 0) {
                    const resolvedSubsequent = subsequentTracksData.map(t => {
                        const track = new Track(player, {
                            title: t.title,
                            author: t.author || 'Inconnu',
                            duration: t.duration || '0:00',
                            thumbnail: t.thumbnail || null,
                            url: t.url,
                            queryType: t.queryType || (t.url && (t.url.startsWith('http') ? 'youtube' : 'file')),
                            raw: t.raw || {}
                        });
                        if (t.extractorName) {
                            track.extractor = player.extractors.store.get(t.extractorName) || null;
                        }
                        return track;
                    });
                    queue.addTrack(resolvedSubsequent);
                }
            } else {
                queue.tracks.clear();
                if (tracks.length > 0 && targetTrackData) {
                    const resolvedTracks = tracks.map(t => {
                        const track = new Track(player, {
                            title: t.title,
                            author: t.author || 'Inconnu',
                            duration: t.duration || '0:00',
                            thumbnail: t.thumbnail || null,
                            url: t.url,
                            queryType: t.queryType || (t.url && (t.url.startsWith('http') ? 'youtube' : 'file')),
                            raw: t.raw || {}
                        });
                        if (t.extractorName) {
                            track.extractor = player.extractors.store.get(t.extractorName) || null;
                        }
                        return track;
                    });

                    const targetTrack = resolvedTracks[0];

                    // Lecture figée : aucun lecteur où lancer la piste. Elle est
                    // posée comme piste courante, et démarrera vraiment quand
                    // l'arrivée d'un auditeur ramènera le bot dans le salon.
                    if (queue.session.isFrozen()) {
                        queue.__current = targetTrack;
                        queue.frozenPositionMs = 0;
                        const rest = resolvedTracks.slice(1);
                        if (rest.length > 0) queue.addTrack(rest);
                        this.broadcastState(guildId);
                        playbackStateManager.saveState(player);
                        return;
                    }

                    const oldVol = queue.node.volume;
                    queue.node.setVolume(0);

                    try {
                        await queue.play(targetTrack, {
                            nodeOptions: {
                                metadata: { channel: null },
                                selfDeaf: false,
                                volume: 0
                            }
                        });
                    } catch (e) {
                        log.error('[WebServer] play track playlist everyone error:', e);
                    }

                    setTimeout(() => {
                        try { queue.node.setVolume(oldVol); } catch (e) {}
                    }, 100);

                    const subsequent = resolvedTracks.slice(1);
                    if (subsequent.length > 0) {
                        queue.addTrack(subsequent);
                    }
                } else {
                    if (queue.currentTrack) {
                        queue.node.skip();
                    }
                }
            }
        }
    }

    _getFirstGuildId() {
        return this.client?.guilds?.cache?.first()?.id || null;
    }

    /**
     * Lien d'invitation du bot sur un nouveau serveur Discord.
     *
     * Construit à partir de l'application réellement connectée : un identifiant
     * écrit en dur dans la page finit par désigner une autre application que
     * celle dont on tient le jeton, et Discord répond alors « application
     * inconnue ». `generateInvite` n'appelle rien à distance, il assemble
     * l'URL — le résultat est néanmoins retenu, la portée étant fixe pour toute
     * la durée de vie du process.
     *
     * La portée `applications.commands` accompagne `bot` : sans elle, le
     * serveur invité n'accepterait pas l'enregistrement des commandes slash que
     * `npm run deploy` y publie.
     *
     * @returns {string|null} null tant que le bot n'est pas prêt
     */
    inviteLink() {
        if (this._inviteLink) return this._inviteLink;
        if (!this.client || !this.client.application?.id) return null;

        try {
            const { OAuth2Scopes, PermissionsBitField } = require('discord.js');
            this._inviteLink = this.client.generateInvite({
                scopes: [OAuth2Scopes.Bot, OAuth2Scopes.ApplicationsCommands],
                permissions: [PermissionsBitField.Flags.Administrator]
            });
        } catch (err) {
            log.warn(`[WebServer] Invitation link unavailable: ${err.message}`);
            return null;
        }

        return this._inviteLink;
    }

    /**
     * Rebascule les tableaux de bord restés sur un serveur que le bot a quitté.
     *
     * `broadcastState` ne s'adresse qu'aux clients dont c'est le serveur
     * courant : sans ce rattachement, ceux qui regardaient le serveur disparu
     * ne recevraient plus rien et resteraient sur un affichage figé.
     *
     * @param {string} guildIdQuitte
     */
    reassignClients(leftGuildId) {
        const replacement = this._getFirstGuildId();
        const guild = replacement ? this.client.guilds.cache.get(replacement) : null;
        const activeChannel = guild ? this._findActiveVoiceChannel(guild) : null;

        // Sans serveur de repli, l'état est demandé sur celui qui vient d'être
        // quitté : il n'existe plus dans le cache Discord, la liste des serveurs
        // part donc vide — ce qu'il faut afficher — sans créer d'entrée de
        // réglages pour un identifiant nul.
        const stateId = replacement || leftGuildId;

        this.wss.clients.forEach(client => {
            if (client.readyState !== 1 || client.selectedGuildId !== leftGuildId) return;

            client.selectedGuildId = replacement;
            client.selectedVoiceChannelId = activeChannel ? activeChannel.id : null;
            client._lastStateSignature = null;

            try {
                client.send(JSON.stringify({
                    type: 'state',
                    data: {
                        ...this.getState(stateId, client.selectedVoiceChannelId),
                        pilot: replacement ? this.isPilot(client, replacement) : false
                    }
                }));
            } catch (e) {}
        });

        this.pilots.delete(leftGuildId);
        if (replacement) this._ensurePilot(replacement);
    }

    _findActiveVoiceChannel(guild) {
        // 1. Chercher un salon avec des utilisateurs non-bot dedans
        const voiceChannels = guild.channels.cache.filter(c => c.type === 2); // GuildVoice
        for (const [_, channel] of voiceChannels) {
            const humans = channel.members.filter(m => !m.user.bot);
            if (humans.size > 0) {
                return channel;
            }
        }
        // 2. Sinon, prendre le premier salon vocal
        return voiceChannels.first();
    }

    _sendError(message) {
        const payload = JSON.stringify({ type: 'error', data: { message } });
        this.wss.clients.forEach((client) => {
            if (client.readyState === 1) {
                client.send(payload);
            }
        });
    }

    async _addVirtualTracks(guildId, tracks, isPlaylist = false) {
        const { useMainPlayer } = require('discord-player');
        const player = useMainPlayer();
        const queue = player.queues.get(guildId);
        if (!queue) return;


        const mapTrack = (track) => {
            const dMs = track.durationMS || parseDurationToMs(track.duration);
            return {
                title: track.title,
                author: track.author || 'Inconnu',
                duration: track.duration || '0:00',
                durationMS: dMs,
                thumbnail: track.thumbnail || null,
                url: track.url,
                queryType: track.queryType || 'youtube',
                extractorName: track.extractor?.identifier || null
            };
        };

        if (isPlaylist) {
            tracks.forEach(track => {
                const trackData = mapTrack(track);
                if (!queue.virtualCurrentTrack) {
                    queue.virtualCurrentTrack = trackData;
                    queue.virtualIsPlaying = true;
                    queue.virtualIsPaused = false;
                    queue.virtualProgressMs = 0;
                    queue.virtualLastUpdated = Date.now();
                } else {
                    queue.virtualTracks.push(trackData);
                }
            });
        } else {
            const track = tracks[0];
            if (track) {
                const trackData = mapTrack(track);
                if (!queue.virtualCurrentTrack) {
                    queue.virtualCurrentTrack = trackData;
                    queue.virtualIsPlaying = true;
                    queue.virtualIsPaused = false;
                    queue.virtualProgressMs = 0;
                    queue.virtualLastUpdated = Date.now();
                } else {
                    queue.virtualTracks.push(trackData);
                }
            }
        }
        this.broadcastState(guildId);
        playbackStateManager.saveState(player);
    }

    /**
     * La piste suivante de la file virtuelle : la première, ou une au hasard.
     *
     * En lecture aléatoire, le titre est tiré au moment de l'enchaînement et
     * retiré de la file comme l'aurait été le premier. La file garde donc son
     * ordre — ce qui reste s'y lit toujours —, et seul le chemin qu'on y trace
     * devient imprévisible.
     *
     * Le pendant commun de ce tirage est le mélange dynamique de
     * discord-player, posé par `applyShuffle` : lui aussi choisit à la fin du
     * morceau, et ne touche pas à l'ordre de la file.
     *
     * @param {object} queue
     * @param {string} guildId
     * @returns {object|undefined}
     */
    drawNextVirtualTrack(queue, guildId) {
        const tracks = (queue && queue.virtualTracks) || [];
        if (tracks.length === 0) return undefined;
        if (!database.getSettings(guildId).shuffle) return tracks.shift();

        const index = Math.floor(Math.random() * tracks.length);
        return tracks.splice(index, 1)[0];
    }

    /**
     * Accorde le mélange de discord-player au réglage du serveur.
     *
     * `enableShuffle(true)` est le mélange *dynamique* : la file garde son
     * ordre, et c'est à la fin de chaque morceau que le suivant est tiré. Le
     * mélange en place, lui, serait irréversible — et la file cesserait
     * d'annoncer ce qui vient.
     *
     * Appelé au changement de mode et à chaque démarrage de piste : une file
     * recréée — reprise d'état, changement de salon — naîtrait sinon sans le
     * mode que le serveur croit actif.
     *
     * @param {object} queue
     * @param {string} guildId
     */
    applyShuffle(queue, guildId) {
        if (!queue || typeof queue.enableShuffle !== 'function') return;
        const wanted = !!database.getSettings(guildId).shuffle;
        try {
            if (wanted && !queue.isShuffling) queue.enableShuffle(true);
            else if (!wanted && queue.isShuffling) queue.disableShuffle();
        } catch (err) {
            log.debug(`[WebServer] Shuffle mode unchanged for guild ${guildId}: ${err.message}`);
        }
    }

    handleVirtualSkip(queue, guildId, data = {}) {

        const startProgressMs = (data && typeof data.startProgressMs === 'number') ? data.startProgressMs : 0;

        // Une fin de piste n'avance la file qu'une fois, quel que soit le nombre
        // de tableaux de bord ouverts.
        //
        // En diffusion personnelle, chaque tableau de bord mène sa propre lecture
        // et son propre fondu enchaîné : le navigateur que le bot ouvre sur le PC
        // au démarrage, et celui de l'utilisateur. Tous annoncent la même fin, à
        // quelques millisecondes d'intervalle, et la file avançait d'autant de
        // crans qu'il y avait de clients — d'où un titre sauté à chaque
        // enchaînement.
        //
        // L'annonce déclare la piste qu'elle termine : celles qui arrivent après
        // la première portent une piste que la file a déjà quittée, et sont
        // écartées. Un appui sur « suivant » ne porte pas ce marquage et reste
        // donc toujours honoré, y compris deux fois de suite.
        if (data && data.auto && data.finishedUrl) {
            const currentUrl = queue.virtualCurrentTrack?.url || null;
            if (!currentUrl || !arePathsOrUrlsEqual(currentUrl, data.finishedUrl)) {
                log.debug('[WebServer] End of track already handled, announcement ignored: '
                    + `« ${data.finishedUrl} » is no longer the current track.`);
                return;
            }
        }

        // Le doublon est désormais écarté à la source, par l'élection du
        // tableau de bord pilote : un anti-rebond temporel n'a plus lieu d'être,
        // et il aurait fini par écarter une fin légitime — un morceau plus court
        // que sa fenêtre, ou deux titres très brefs qui s'enchaînent.

        // Trace de l'avance de la file virtuelle.
        //
        // Deux mécanismes peuvent la faire avancer pour une même fin de piste —
        // l'annonce du navigateur et la roue de secours du serveur —, et seul un
        // relevé horodaté dit lequel a joué, combien de fois, et sur quelle file.
        // Le déduire du seul état final s'est révélé impossible.
        log.debug(`[WebServer] Virtual skip: « ${queue.virtualCurrentTrack?.title || '—'} » → `
            + `« ${queue.virtualTracks?.[0]?.title || '—'} » | queue of ${queue.virtualTracks?.length ?? 0} `
            + `| start ${startProgressMs} ms | source ${database.getSettings(guildId).activePlaybackSource || 'queue'}`);

        // Repeat mode TRACK check
        const repeatMode = queue.repeatMode;
        if (repeatMode === 1 && queue.virtualCurrentTrack) {
            queue.virtualProgressMs = startProgressMs;
            queue.virtualLastUpdated = Date.now();
            this.broadcastState(guildId);
            const { useMainPlayer } = require('discord-player');
            playbackStateManager.saveState(useMainPlayer());
            return;
        }

        if (queue.virtualCurrentTrack) {
            // En tête : `virtualHistory` suit la même convention que history.tracks,
            // la piste la plus récente d'abord.
            queue.virtualHistory.unshift(queue.virtualCurrentTrack);
        }
        const nextTrack = this.drawNextVirtualTrack(queue, guildId);
        if (nextTrack) {
            queue.virtualCurrentTrack = nextTrack;
            queue.virtualIsPlaying = true;
            queue.virtualIsPaused = false;
            queue.virtualProgressMs = startProgressMs;
            queue.virtualLastUpdated = Date.now();

            // Synchroniser playlistCurrentIndex
            const settings = database.getSettings(guildId);
            if (settings.activePlaybackSource && settings.activePlaybackSource !== 'queue') {
                const globalPlaylists = database.getGlobalPlaylists();
                const playlist = globalPlaylists.find(p => p.id === settings.activePlaybackSource);
                if (playlist) {
                    const idx = playlist.tracks.findIndex(t => arePathsOrUrlsEqual(t.url, nextTrack.url));
                    if (idx !== -1) {
                        database.updateSettings(guildId, { playlistCurrentIndex: idx });
                    }
                }
            }
        } else if (this.consumeTransition(guildId, startProgressMs)) {
            // Un aiguillage attendait là : la lecture continue ailleurs. Avant
            // les deux suivantes — une playlist qui s'aiguille n'est ni une
            // playlist qui reboucle, ni une playlist terminée.
            return;
        } else if (this.restartLoopedPlaylist(guildId, startProgressMs)) {
            // La playlist a été rechargée depuis son premier titre : rien à
            // arrêter, la lecture se poursuit.
            return;
        } else if (this.advanceToQueue(guildId, startProgressMs)) {
            // La file d'attente a repris la main : la lecture se poursuit
            // également, sur son premier titre.
            return;
        } else {
            queue.virtualCurrentTrack = null;
            queue.virtualIsPlaying = false;
            queue.virtualIsPaused = false;
            queue.virtualProgressMs = 0;
            queue.virtualLastUpdated = Date.now();
        }
        this.broadcastState(guildId);
        const { useMainPlayer } = require('discord-player');
        playbackStateManager.saveState(useMainPlayer());
    }

    /**
     * Range la file du salon qu'on s'apprête à quitter.
     *
     * À appeler **avant** que `lastVoiceChannelId` ne change : le rangement se
     * fait sous la clé du salon courant, et l'ordre est donc tout ce qui
     * distingue « ranger ce qu'on quitte » de « écraser ce qu'on rejoint ».
     *
     * @param {string} guildId
     */
    stowChannelQueue(guildId) {
        const settings = database.getSettings(guildId);
        if ((settings.activePlaybackSource || 'queue') !== 'queue') return;

        const { useMainPlayer } = require('discord-player');
        const queue = useMainPlayer().queues.get(guildId);
        if (!queue) return;

        const isPersonal = settings.broadcastMode === 'personal';
        channelQueue.mirror(guildId, isPersonal
            ? (queue.virtualTracks || [])
            : (queue.tracks ? queue.tracks.toArray() : []), settings);
    }

    /**
     * Charge dans le lecteur la file du salon qu'on vient de rejoindre.
     *
     * Chaque salon garde la sienne : un salon « soirée » et un salon « calme »
     * ne se disputent plus la même liste, et la retrouvent au retour. Le lecteur
     * n'en reçoit que la tête, jusqu'au premier aiguillage — le reste vit dans
     * le rangement, et c'est ce qui permet à une transition d'y attendre son
     * tour sans que le lecteur ne l'enjambe.
     *
     * Rien n'est fait si une playlist occupe le lecteur : la file du nouveau
     * salon attendra son tour, comme celle de l'ancien l'attendait.
     *
     * @param {string} guildId
     */
    loadChannelQueue(guildId) {
        const settings = database.getSettings(guildId);
        if ((settings.activePlaybackSource || 'queue') !== 'queue') return;

        const { useMainPlayer, Track } = require('discord-player');
        const player = useMainPlayer();
        const queue = player.queues.get(guildId);
        if (!queue) return;

        const attendus = channelQueue.playable(settings);

        if (settings.broadcastMode === 'personal') {
            queue.virtualTracks = attendus;
            return;
        }

        queue.tracks.clear();
        if (!attendus.length) return;

        queue.addTrack(attendus.map((t) => {
            const track = new Track(player, {
                title: t.title,
                author: t.author || 'Inconnu',
                duration: t.duration || '0:00',
                thumbnail: t.thumbnail || null,
                url: t.url,
                queryType: t.queryType || (t.url && t.url.startsWith('http') ? 'youtube' : 'file'),
                raw: t.raw || {},
            });
            if (t.extractorName) {
                track.extractor = player.extractors.store.get(t.extractorName) || null;
            }
            return track;
        }));
    }

    /**
     * Bascule vers la destination d'un aiguillage, si la lecture vient d'en
     * atteindre un.
     *
     * Appelée aux deux points d'épuisement — la file virtuelle du mode
     * personnel et l'événement `emptyQueue` du mode commun — et **avant**
     * `restartLoopedPlaylist` comme `advanceToQueue` : une playlist qui
     * s'aiguille n'est ni une playlist qui reboucle, ni une playlist terminée.
     * C'est cet ordre qui porte la règle.
     *
     * La transition est retirée avant la bascule, et non après. La bascule
     * relit la playlist pour la nourrir au lecteur ; l'aiguillage encore en
     * place s'y retrouverait, et une transition vers la playlist où l'on est
     * déjà se redéclencherait aussitôt.
     *
     * @param {string} guildId
     * @param {number} [startProgressMs=0] - Position déjà atteinte dans le
     *   premier titre de la destination.
     *
     *   Elle n'est pas nulle, contrairement à ce qu'on pourrait croire du fait
     *   que le lecteur n'a rien reçu au-delà de l'aiguillage. C'est le
     *   navigateur qui enchaîne, et il sait franchir un aiguillage pour
     *   deviner ce qui vient après (voir `nextTrackOf`) : quand il annonce la
     *   fin du fondu, il joue déjà ce titre depuis plusieurs secondes. Lui
     *   répondre zéro le ferait repartir du début sous l'oreille de
     *   l'auditeur — ce qu'il faisait.
     * @returns {boolean} true si un aiguillage a pris la main
     */
    consumeTransition(guildId, startProgressMs = 0) {
        const settings = database.getSettings(guildId);
        const source = settings.activePlaybackSource || 'queue';

        /*
         * Les deux sources se lisent différemment, et pour une bonne raison.
         *
         * Une playlist est une liste fixe où la lecture avance un curseur :
         * l'aiguillage à consulter est celui qui suit ce curseur. La file, elle,
         * se consomme par la tête — ses titres joués la quittent —, si bien
         * qu'un aiguillage atteint est simplement celui qui s'y trouve en
         * premier.
         */
        const found = source === 'queue'
            ? this._queueTransition(settings)
            : this._playlistTransition(settings, source);
        if (!found) return false;

        const { transition } = found;
        const playlist = source === 'queue'
            ? { name: 'the pending queue' }
            : (database.getGlobalPlaylists() || []).find(p => p.id === source);
        const nom = transitions.targetName(transition, database.getGlobalPlaylists());
        log.info(`[WebServer] Transition reached in « ${playlist.name} »: `
            + `switching to ${transition.target === 'queue' ? 'the pending queue' : `« ${nom} »`}.`);

        // Consommée : elle a servi, et ne doit pas se retrouver dans la liste
        // que la bascule va relire.
        if (source === 'queue') {
            channelQueue.write(guildId,
                channelQueue.read(settings).filter(t => t.id !== transition.id), settings);
        } else {
            database.removePlaylistTransition(source, transition.id);
        }

        /*
         * Une destination vide n'annule pas l'aiguillage.
         *
         * Elle a bel et bien été atteinte, et la laisser en place la ferait se
         * redéclencher indéfiniment. On la consomme donc, on le dit, et la
         * lecture suit le cours qu'elle aurait eu sans elle — bouclage de la
         * playlist, ou reprise de la file.
         */
        if (!this._transitionHasSomethingToPlay(guildId, transition, settings)) {
            log.warn('[WebServer] The transition destination is empty or gone: '
                + 'consumed all the same, playback carries on where it was.');
            this.broadcastState(guildId);
            return false;
        }

        this.applyPlaybackSource(guildId, transition.target, 0, startProgressMs)
            .catch(err => log.error('[WebServer] Transition switch error:', err.message));

        return true;
    }

    /**
     * Bascule la lecture vers une source, par le chemin du tableau de bord.
     *
     * Le même code, et non une seconde version : cette bascule range la file
     * d'attente de côté, distingue les deux modes de diffusion, et rattrape la
     * piste qu'une playlist interrompt. En réécrire l'équivalent ici garantirait
     * qu'un jour l'un des deux sache faire ce que l'autre ne sait plus — ce que
     * ce dépôt a déjà payé quatre fois avec le choix des flux.
     *
     * @param {string} guildId
     * @param {string} source - `queue`, ou l'identifiant d'une playlist.
     * @param {number} [index=0]
     * @param {number} [startProgressMs=0] - Position déjà atteinte dans le
     *   premier titre, quand un enchaînement l'a lancé en avance.
     */
    async applyPlaybackSource(guildId, source, index = 0, startProgressMs = 0) {
        const { useMainPlayer } = require('discord-player');
        const player = useMainPlayer();
        const { handleSetActivePlaybackSource } = require('./websocket/handlers/playlistHandlers');

        await handleSetActivePlaybackSource({
            data: { source, index, startProgressMs },
            webServer: this,
            player,
            queue: player.queues.get(guildId) || null,
            currentGuildId: guildId,
        });
    }

    /**
     * L'aiguillage qu'une playlist épuisée vient d'atteindre.
     *
     * Le curseur de lecture désigne le dernier titre joué ; l'aiguillage est
     * celui qui le suit immédiatement, et pas plus loin — voir `nextAfter`.
     *
     * @returns {{ transition: object, at: number }|null}
     */
    _playlistTransition(settings, source) {
        if (!source.startsWith('playlist_')) return null;

        const playlist = (database.getGlobalPlaylists() || []).find(p => p.id === source);
        if (!playlist) return null;

        return transitions.nextAfter(playlist.tracks || [],
            typeof settings.playlistCurrentIndex === 'number' ? settings.playlistCurrentIndex : 0);
    }

    /**
     * L'aiguillage qu'une file épuisée vient d'atteindre.
     *
     * Aucun curseur ici : la file se consomme par la tête, ses titres joués la
     * quittent. Le lecteur n'ayant reçu que ce qui précédait l'aiguillage, une
     * file épuisée est une file dont l'aiguillage est désormais en première
     * position — et s'il ne l'est pas, il n'y en avait pas.
     *
     * @returns {{ transition: object, at: number }|null}
     */
    _queueTransition(settings) {
        const [premier] = channelQueue.read(settings);
        if (!transitions.isTransition(premier)) return null;
        return { transition: premier, at: 0 };
    }

    /**
     * La destination d'un aiguillage a-t-elle de quoi jouer ?
     *
     * Une playlist supprimée entre-temps, ou vidée de ses titres, ne peut pas
     * prendre la main : basculer dessus laisserait un silence que rien
     * n'expliquerait.
     *
     * @returns {boolean}
     */
    _transitionHasSomethingToPlay(guildId, transition, settings) {
        if (transition.target === 'queue') {
            return readSetAsideQueue(settings).length > 0;
        }
        const cible = (database.getGlobalPlaylists() || []).find(p => p.id === transition.target);
        if (!cible) return false;
        return transitions.withoutTransitions(cible.tracks).length > 0;
    }

    /**
     * Recharge la playlist active depuis son début lorsqu'elle vient de
     * s'achever et que la lecture en boucle est demandée.
     *
     * Appelée aux deux points d'épuisement — la file virtuelle du mode
     * personnel et l'événement `emptyQueue` du mode everyone — car les deux
     * moteurs de lecture n'ont rien en commun.
     *
     * @param {string} guildId
     * @param {number} [startProgressMs=0] - Position déjà atteinte dans le
     *   premier titre. Non nulle quand l'enchaînement mix a commencé à le
     *   jouer avant la fin du précédent : repartir de zéro ferait alors
     *   reculer la lecture du navigateur, que le serveur recale sur lui.
     * @returns {boolean} true si un rebouclage a été enclenché
     */
    restartLoopedPlaylist(guildId, startProgressMs = 0) {
        const settings = database.getSettings(guildId);
        if (!settings.loopPlaylist) return false;

        const source = settings.activePlaybackSource;
        if (!source || !source.startsWith('playlist_')) return false;

        const playlist = (database.getGlobalPlaylists() || []).find(p => p.id === source);
        if (!playlist || !playlist.tracks || playlist.tracks.length === 0) return false;

        log.info(`[WebServer] End of playlist « ${playlist.name} »: restarting from the top (loop playback).`);
        database.updateSettings(guildId, { playlistCurrentIndex: 0 });

        // forceRestart : sans lui, une playlist d'un seul titre serait vue
        // comme « déjà en cours » et ne repartirait jamais.
        this._syncPlaylistToPlayer(guildId, source, 0, true, startProgressMs)
            .then(() => {
                this.broadcastState(guildId);
                const { useMainPlayer } = require('discord-player');
                playbackStateManager.saveState(useMainPlayer());
            })
            .catch(err => log.error('[WebServer] Playlist restart error:', err.message));

        return true;
    }

    /**
     * Passe à la file d'attente lorsqu'une playlist vient de s'achever.
     *
     * Une playlist qui prend le lecteur y met la file d'attente de côté le
     * temps de sa lecture (voir [setAsideQueue](../utils/setAsideQueue.js)).
     * Sa dernière piste finie, la lecture s'arrêtait : ce qui patientait dans
     * la file y restait jusqu'à ce qu'on revienne l'y chercher à la main, alors
     * même que le tableau de bord continuait de l'afficher. Elle reprend
     * désormais la main d'elle-même, exactement comme si la source avait été
     * rebasculée sur « file d'attente ».
     *
     * Appelée aux deux mêmes points d'épuisement que
     * `restartLoopedPlaylist()` — la file virtuelle du mode personnel et
     * l'événement `emptyQueue` du mode commun — et toujours **après** elle :
     * une playlist qui reboucle n'est pas une playlist terminée. C'est cet
     * ordre, et non un second test sur `loopPlaylist`, qui porte la règle. Une
     * playlist supprimée en cours de route retombe ainsi ici plutôt que de
     * laisser le lecteur muet, alors qu'elle était pourtant en boucle.
     *
     * @param {string} guildId
     * @param {number} [startProgressMs=0] - Position déjà atteinte dans le
     *   premier titre de la file. Non nulle quand l'enchaînement mix l'a lancé
     *   avant la fin du dernier titre de la playlist.
     * @returns {boolean} true si la file a pris la main
     */
    advanceToQueue(guildId, startProgressMs = 0) {
        const settings = database.getSettings(guildId);

        const source = settings.activePlaybackSource;
        if (!source || !source.startsWith('playlist_')) return false;

        // Lue avant la bascule : `readSetAsideQueue()` choisit sa sauvegarde
        // d'après le mode de diffusion, que rien ne change ici, mais la source
        // ne doit plus être une playlist une fois la file reprise.
        const pending = readSetAsideQueue(settings);
        if (pending.length === 0) return false;

        const { useMainPlayer, Track } = require('discord-player');
        const player = useMainPlayer();
        const queue = player.queues.get(guildId);
        if (!queue) return false;

        // Basculer la source rend la sauvegarde inatteignable : elle n'est plus
        // consultée dès que la source vaut « queue ». Si le lecteur n'a plus de
        // salon où jouer — bot retiré d'un salon désert —, la file passerait
        // donc pour vide et l'utilisateur la verrait disparaître. Mieux vaut
        // laisser la lecture s'arrêter sur la playlist : il retrouvera sa file,
        // et pourra y revenir lui-même.
        if (settings.broadcastMode !== 'personal' && !queue.channel) {
            log.info('[WebServer] End of playlist: the pending queue keeps its place, '
                + 'the player no longer has a channel to play it in.');
            return false;
        }

        log.info(`[WebServer] End of playlist: the pending queue takes over `
            + `(${pending.length} track(s)).`);

        // `playlistCurrentIndex` est ramené à zéro comme le fait la bascule
        // manuelle : laissé sur la dernière piste, il ferait repartir la
        // playlist par sa fin au prochain retour vers elle.
        database.updateSettings(guildId, {
            activePlaybackSource: 'queue',
            playlistCurrentIndex: 0,
        });

        const [first, ...rest] = pending;

        if (settings.broadcastMode === 'personal') {
            queue.virtualCurrentTrack = first;
            queue.virtualTracks = rest;
            queue.virtualProgressMs = startProgressMs;
            queue.virtualIsPlaying = true;
            queue.virtualIsPaused = false;
            queue.virtualLastUpdated = Date.now();

            this.broadcastState(guildId);
            playbackStateManager.saveState(player);
            return true;
        }

        const toTrack = (t) => {
            const newTrack = new Track(player, {
                title: t.title,
                author: t.author || 'Inconnu',
                duration: t.duration || '0:00',
                thumbnail: t.thumbnail || null,
                url: t.url,
                queryType: t.queryType || (t.url && t.url.startsWith('http') ? 'youtube' : 'file'),
                raw: t.raw || {},
            });
            if (t.extractorName) {
                newTrack.extractor = player.extractors.store.get(t.extractorName) || null;
            }
            return newTrack;
        };

        // La playlist a vidé la liste physique en s'achevant ; ce nettoyage
        // couvre le cas où l'un de ses titres y aurait survécu, faute de quoi
        // il se glisserait devant la file qu'on vient de rappeler.
        queue.tracks.clear();

        queue.play(toTrack(first), {
            nodeOptions: {
                metadata: { channel: null },
                selfDeaf: false,
                volume: settings.baseVolume,
            },
        })
            .then(() => {
                if (rest.length > 0) queue.addTrack(rest.map(toTrack));
                this.broadcastState(guildId);
                playbackStateManager.saveState(player);
            })
            .catch(err => log.error('[WebServer] Error handing over to the queue:', err.message));

        return true;
    }
}

module.exports = new WebServer();

/**
 * Construit le bloc de progression d'une piste.
 *
 * Remplace trois variantes qui recalculaient la durée jusqu'à quatre fois par
 * appel.
 *
 * @param {number} positionMs - Position courante
 * @param {object|null} track - Piste concernée
 * @returns {object|null}
 */
/**
 * Fondu enchaîné en cours sur le bus de mixage, mis en forme pour le client.
 *
 * La piste entrante est formatée comme n'importe quelle piste affichée : le
 * tableau de bord la présente pendant la superposition, exactement comme la
 * diffusion personnelle présente celle que son second élément audio a lancée.
 *
 * @param {object} queue
 * @returns {object|null}
 */
function crossfadeState(queue) {
    const engine = activeEngine(queue);
    const fade = engine?.fadeState();
    if (!fade) return null;

    const describe = (part) => ({
        url: part.url,
        positionMs: part.positionMs,
        durationMs: part.durationMs,
        ratio: part.ratio,
    });

    return {
        outgoing: describe(fade.outgoing),
        incoming: { ...describe(fade.incoming), track: formatTrackWithPreload(fade.incoming.track) },
    };
}

function buildProgress(positionMs, track) {
    if (!track) return null;
    const totalMs = track.durationMS || parseDurationToMs(track.duration);
    const current = positionMs || 0;
    return {
        current: formatMs(current),
        currentMs: current,
        total: track.duration || formatMs(totalMs),
        totalMs,
        percent: totalMs > 0 ? Math.min(100, Math.max(0, (current / totalMs) * 100)) : 0,
    };
}

function getTrackPreloadInfo(t) {
    const empty = { isPreloaded: false, isPreloading: false, preloadProgress: 0, cachedAudioQuality: null, requalify: null };
    if (!t) return empty;
    if (t.queryType === 'file' || (t.url && fs.existsSync(t.url))) {
        // Fichier local : lu tel quel, jamais transcodé ni mis en cache.
        return { ...empty, isPreloaded: true, preloadProgress: 100, isLocal: true };
    }
    if (typeof preloadManager.getPreloadStatus === 'function') {
        return preloadManager.getPreloadStatus(t);
    }
    return { ...empty, isPreloaded: !!preloadManager.getCachedPath(t) };
}

/**
 * Réglages d'import du premier serveur connu. Le tableau de bord est
 * mono-utilisateur : la box « Ajouter un fichier » y affiche la même valeur
 * quel que soit le serveur sélectionné.
 *
 * @returns {{ audio: string, video: string }}
 */
function currentImportSettings() {
    const firstGuildId = database.cache.size > 0 ? [...database.cache.keys()][0] : null;
    const settings = firstGuildId ? database.getSettings(firstGuildId) : {};
    return {
        audio: String(settings.importAudioQuality || '320'),
        video: String(settings.importVideoQuality || '720')
    };
}

/**
 * Une piste distante peut porter une vidéo ; un fichier local ou un envoi
 * passent par le visualiseur audio et n'ont pas de réglage vidéo à proposer.
 */
function trackHasVideo(t) {
    const url = t?.url || '';
    if (!/^https?:\/\//i.test(url)) return false;
    return !url.includes('/uploads/');
}

function formatTrackWithPreload(t) {
    if (!t) return null;

    /*
     * Un aiguillage traverse tel quel.
     *
     * Il n'a ni pochette, ni durée, ni qualité à figer — et `ensureTrackQuality`
     * inscrirait une entrée dans la base pour chaque adresse `transition:`,
     * qui s'y accumuleraient sans que rien ne les relise jamais. L'interface,
     * elle, le reconnaît à son adresse et lui dessine sa propre ligne.
     */
    if (transitions.isTransition(t)) {
        return { isTransition: true, id: t.id, target: t.target, url: t.url };
    }

    const pInfo = getTrackPreloadInfo(t);

    // Qualité figée à la première rencontre de la piste, sur la base des
    // réglages d'import du moment. Sans cet instantané, déplacer le menu
    // déroulant de la box d'ajout réécrirait après coup la qualité affichée
    // pour tout l'historique.
    // Ce chemin est emprunté pour chaque piste à chaque diffusion d'état : on
    // ne calcule les réglages de repli que lorsque la piste n'est pas déjà figée.
    let desired = t.url ? database.getTrackQuality(t.url) : null;
    if (!desired || !desired.audio || !desired.video) {
        desired = t.url
            ? database.ensureTrackQuality(t.url, currentImportSettings())
            : { audio: '320', video: '720' };
    }

    return {
        title: t.title,
        author: t.author || null,
        duration: t.duration,
        /*
         * La pochette de repli des fichiers locaux, ramenée à la maison.
         *
         * `@discord-player/extractor` attribue d'office aux pistes du disque une
         * image hébergée chez Wikimedia. Le tableau de bord s'utilise en réseau
         * local, parfois sans accès à l'extérieur : la pochette d'un fichier
         * pourtant posé à un mètre de là manquait alors à l'écran.
         *
         * La substitution est faite ici, et ici seulement : c'est le passage
         * obligé de tout ce que le tableau de bord affiche. Les embeds Discord,
         * eux, gardent l'adresse distante — Discord ne sait pas joindre le bot,
         * et lui tendre un chemin local ne lui montrerait rien du tout.
         */
        thumbnail: artwork.localise(t.thumbnail),
        url: t.url || null,
        isPreloaded: pInfo.isPreloaded,
        isPreloading: pInfo.isPreloading,
        preloadProgress: pInfo.preloadProgress,
        isLocal: !!pInfo.isLocal,
        hasVideo: trackHasVideo(t),
        // Qualité réellement présente en cache, quand elle est connue ; sinon
        // l'interface se rabat sur la qualité souhaitée.
        cachedAudioQuality: pInfo.cachedAudioQuality || null,
        desiredAudioQuality: desired.audio,
        desiredVideoQuality: desired.video,
        requalify: pInfo.requalify || null,
        loudness: trackLoudness(t, pInfo)
    };
}

/**
 * Niveau sonore d'une piste, tel que le menu contextuel l'affiche.
 *
 * Quatre choses distinctes, qu'il ne faut pas confondre :
 * - `measured` est ce que vaut le fichier, et ne change jamais ;
 * - `target` est ce que l'utilisateur en veut, curseur compris ;
 * - `gainDb` est l'écart effectivement appliqué, bornes comprises ;
 * - `synced` dit que la cible vient du réglage commun et non de la piste.
 *
 * `target` est rendue même quand rien n'a été réglé : le curseur doit bien
 * s'ouvrir quelque part, et c'est la mesure qui fait ce point de départ — la
 * position où le gain est nul.
 *
 * @param {object} t
 * @param {object} pInfo - État de préchargement déjà calculé pour cette piste
 * @returns {object}
 */
function trackLoudness(t, pInfo) {
    const url = t && t.url;
    const settings = t ? currentLoudnessSettings() : {};
    const measure = url ? loudness.measurement(url) : null;
    const explicit = url ? loudness.effectiveTarget(url, settings) : null;
    const db = url ? loudness.gainDb(url, settings) : 0;

    // Un fichier est mesurable dès qu'il est sur le disque du bot — en cache,
    // ou déposé par l'utilisateur. L'état de préchargement le dit déjà, et le
    // redemander coûterait un accès disque par piste et par seconde.
    const measurable = !!(pInfo && (pInfo.isPreloaded || pInfo.isLocal));

    return {
        status: loudnessAnalyzer.statusFor(t, measurable),
        measured: measure ? measure.measured : null,
        peak: measure ? measure.peak : null,
        target: explicit !== null ? explicit
            : (measure ? loudness.clampTarget(measure.measured) : null),
        // Une cible héritée du réglage commun s'affiche, mais ne se présente
        // pas comme un choix fait sur cette piste-là.
        customized: explicit !== null && !settings.lufsSyncEnabled,
        synced: !!settings.lufsSyncEnabled,
        gainDb: Math.round(db * 10) / 10,
        degradation: loudness.degradation(db, measure ? measure.peak : 0)
    };
}

/**
 * Réglages de synchronisation du premier serveur connu.
 *
 * Même raison que pour `currentImportSettings()` : le tableau de bord est
 * mono-utilisateur, et une piste doit s'entendre pareil quel que soit le
 * serveur affiché au moment où on la regarde.
 */
function currentLoudnessSettings() {
    // L'entrée brute du cache plutôt que `getSettings()` : celui-ci refabrique
    // le jeu complet des valeurs par défaut à chaque appel, et cette fonction
    // est appelée pour chaque piste de chaque diffusion d'état. Les deux seuls
    // champs lus ici portent leur propre repli.
    const firstGuildId = database.cache.size > 0 ? database.cache.keys().next().value : null;
    const settings = (firstGuildId && database.cache.get(firstGuildId)) || {};
    return {
        lufsSyncEnabled: !!settings.lufsSyncEnabled,
        lufsSyncTarget: Number.isFinite(settings.lufsSyncTarget)
            ? settings.lufsSyncTarget
            : loudness.DEFAULT_SYNC_TARGET
    };
}
