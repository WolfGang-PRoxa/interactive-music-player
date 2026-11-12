/**
 * Vérifie la porte du tableau de bord — la connexion Discord obligatoire.
 *
 * Le jeton d'accès est anonyme : le porter prouve qu'on est devant la machine,
 * jamais qui l'on est. Le bot agit pourtant sur des serveurs peuplés de gens
 * réels, et n'a aucune raison d'obéir à quelqu'un qui refuse de se nommer.
 *
 * Quatre choses tiennent tout, et aucune ne se voit dans un diff.
 *
 *  - **Le jeton ouvre la page, il ne donne plus les droits.** Il faut bien
 *    servir celle qui porte la fenêtre de connexion, mais l'accorder comme
 *    avant viderait la porte de son sens. C'est le renversement de tout ce
 *    fichier, et le plus facile à défaire par inadvertance.
 *
 *  - **L'installation se revendique une fois.** Le premier compte Discord qui
 *    revient *en présentant le jeton* en devient le propriétaire. Un second ne
 *    le déposséderait pas, et un compte sans jeton — arrivé par un lien
 *    d'invitation — ne peut pas revendiquer quoi que ce soit.
 *
 *  - **Le repli existe.** Une installation sans application Discord configurée
 *    ne peut recevoir aucune connexion : barrer la route y enfermerait
 *    l'installateur hors de son propre bot pour un secret manquant dans un
 *    fichier.
 *
 *  - **La fenêtre ne se ferme pas.** Ni croix, ni clic à côté, ni échappement :
 *    une porte qu'un geste fait disparaître ne barre rien.
 *
 * Le serveur est monté sur un port éphémère avec le vrai routeur et le vrai
 * middleware, dans un bac à sable : jeton et propriétaire vivent sous `data/`
 * du répertoire courant, qui est donc déplacé avant tout `require`.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'login-gate-'));
fs.mkdirSync(path.join(SANDBOX, 'data'), { recursive: true });
process.chdir(SANDBOX);

// L'application Discord est réputée configurée : c'est le cas nominal, celui
// où la porte doit être fermée. Le repli est éprouvé plus bas, en la retirant.
process.env.DISCORD_CLIENT_ID = '000000000000000000';
process.env.DISCORD_CLIENT_SECRET = 'secret-de-test';
process.env.PUBLIC_URL = 'http://127.0.0.1:3000';

let failed = 0;
let passed = 0;
const check = (label, ok, detail = '') => {
    if (ok) { passed++; console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`); }
    else { failed++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
};

const express = require(path.join(ROOT, 'node_modules', 'express'));
const auth = require(path.join(ROOT, 'src', 'web', 'auth.js'));
const owner = require(path.join(ROOT, 'src', 'web', 'owner.js'));
const sessions = require(path.join(ROOT, 'src', 'web', 'sessions.js'));
const oauth = require(path.join(ROOT, 'src', 'web', 'oauth.js'));
const createAuthRouter = require(path.join(ROOT, 'src', 'web', 'routes', 'auth.js'));
const createApiRouter = require(path.join(ROOT, 'src', 'web', 'routes', 'api.js'));

const TOKEN = auth.getToken();

const app = express();
app.use(auth.middleware);
app.use('/auth', createAuthRouter({ client: null }));
app.use('/api', createApiRouter({ client: null, wss: null, inviteLink: () => null }));
app.get('/', (req, res) => res.type('html').send('<html>tableau de bord</html>'));

const server = http.createServer(app);

/** Une requête, avec les cookies qu'on choisit de présenter. */
function ask(port, route, cookies) {
    return new Promise((resolve, reject) => {
        const headers = { Accept: 'application/json' };
        if (cookies) headers.Cookie = cookies;
        http.get({ host: '127.0.0.1', port, path: route, headers }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(body); } catch (e) {}
                resolve({ status: res.statusCode, json, body });
            });
        }).on('error', reject);
    });
}

const withToken = `${auth.COOKIE_NAME}=${TOKEN}`;

server.listen(0, '127.0.0.1', async () => {
    const { port } = server.address();

    console.log('\n=== La porte du tableau de bord ===\n');

    // ───────── Le jeton seul ─────────

    console.log('Le jeton, seul\n');

    const bare = await ask(port, '/auth/state', withToken);
    check('il ouvre bien la page', bare.status === 200);
    check('mais la connexion reste à faire', bare.json && bare.json.pendingLogin === true);
    check('et il ne donne aucun droit', bare.json && bare.json.master === false,
        'le renversement : porter le jeton n\'est plus être le maître');
    check('l\'installation n\'a pas encore de propriétaire',
        bare.json && bare.json.claimed === false);

    const anonymous = await ask(port, '/auth/state', null);
    check('sans jeton ni session, rien ne s\'ouvre', anonymous.status === 401,
        `HTTP ${anonymous.status}`);

    // ───────── La revendication ─────────

    console.log('\nLa revendication de l\'installation\n');

    // Un compte arrivé sans le jeton — par un lien d'invitation — ne revendique
    // rien : c'est le jeton, écrit dans la console de qui a lancé le bot, qui
    // distingue celui qui est devant la machine.
    const guest = sessions.create({ id: '111', username: 'Invite', global_name: 'Invité' });
    const guestCookie = `${sessions.COOKIE_NAME}=${guest.id}`;

    const guestState = await ask(port, '/auth/state', guestCookie);
    check('un compte connecté sans jeton entre', guestState.status === 200
        && guestState.json.loggedIn === true);
    check('mais n\'est pas le maître', guestState.json.master === false);
    check('et n\'a rien revendiqué', owner.isClaimed() === false);

    // La revendication elle-même : ce que fait le rappel OAuth une fois le
    // compte reconnu, reproduit ici sans passer par Discord.
    const boss = { id: '222', username: 'Proprio' };
    check('le porteur du jeton peut revendiquer',
        auth.identify({ url: '/', headers: { cookie: withToken } }).holdsToken === true);
    check('la revendication prend', owner.claim(boss) === true
        && owner.get().id === '222');

    check('un second compte ne dépossède pas le premier',
        owner.claim({ id: '333', username: 'Autre' }) === false
        && owner.get().id === '222');

    const bossSession = sessions.create({ id: '222', username: 'Proprio' });
    const bossCookie = `${sessions.COOKIE_NAME}=${bossSession.id}`;
    const bossState = await ask(port, '/auth/state', bossCookie);
    check('le propriétaire est reconnu à sa session seule',
        bossState.json.master === true && bossState.json.loggedIn === true,
        'sans avoir à présenter le jeton');
    check('il n\'a plus rien en attente', bossState.json.pendingLogin === false);

    const stillGuest = await ask(port, '/auth/state', guestCookie);
    check('l\'invité reste invité', stillGuest.json.master === false);
    check('et n\'apprend pas de qui dépend l\'installation',
        stillGuest.json.owner === null,
        'le nom du propriétaire n\'est rendu qu\'à lui-même');

    // Le jeton, maintenant que l'installation est revendiquée, ne rattrape rien.
    const tokenAfter = await ask(port, '/auth/state', withToken);
    check('le jeton seul reste sans droits après la revendication',
        tokenAfter.json.master === false && tokenAfter.json.pendingLogin === true);

    /*
     * ───────── Le rappel arrive sur une autre origine ─────────
     *
     * Le cas qui a empêché la toute première revendication, et que rien ici ne
     * voyait. Le tableau de bord s'ouvre sur `127.0.0.1`, où le cookie du jeton
     * est posé ; `PUBLIC_URL` désigne autre chose — un tunnel, un nom de
     * domaine, une adresse de réseau local —, et c'est là que Discord renvoie.
     * Deux hôtes, deux bocaux à cookies : le rappel n'a pas le jeton, et lire
     * le jeton *au rappel* ne peut donc pas marcher.
     *
     * Le fait est constaté à l'aller, sur l'origine du tableau de bord, et
     * voyage dans le `state` — que ce serveur a lui-même émis, garde chez lui
     * et ne sert qu'une fois.
     */
    console.log('\nQuand Discord renvoie sur une autre origine\n');

    owner.forget();

    const outbound = oauth.buildAuthorizeUrl('/', { holdsToken: true });
    const issued = new URL(outbound).searchParams.get('state');
    check('le trajet emporte ce que le rappel ne pourra pas redécouvrir',
        typeof issued === 'string' && issued.length > 0);

    const returned = oauth.consumeState(issued);
    check('le rappel retrouve le porteur du jeton', returned && returned.holdsToken === true,
        'sans avoir eu besoin du cookie');
    check('et le `state` ne sert qu\'une fois', oauth.consumeState(issued) === null);

    const anonymousTrip = oauth.consumeState(
        new URL(oauth.buildAuthorizeUrl('/', {})).searchParams.get('state'));
    check('un trajet ouvert sans jeton ne le fabrique pas',
        anonymousTrip && anonymousTrip.holdsToken === false,
        'un invité venu du lien d\'invitation ne revendique rien');

    /*
     * ───────── Le rattrapage d'une session déjà ouverte ─────────
     *
     * Une session peut exister sans que l'installation soit revendiquée : celles
     * ouvertes avant que la règle n'existe, et celles dont le rappel est arrivé
     * ailleurs. Sans rattrapage, ces comptes sont coincés — la fenêtre ne
     * s'ouvre plus puisqu'ils sont connectés, et plus rien ne leur offre
     * l'occasion de revendiquer.
     */
    console.log('\nUne session ouverte sur une installation sans propriétaire\n');

    check('l\'installation est bien retombée sans propriétaire', owner.isClaimed() === false);

    const strandedState = await ask(port, '/auth/state', bossCookie);
    check('connecté sans le jeton, on reste sans droits',
        strandedState.json.loggedIn === true && strandedState.json.master === false);
    check('et rien n\'a été revendiqué au passage', owner.isClaimed() === false,
        'la session seule ne suffit pas');

    const rescued = await ask(port, '/auth/state', `${bossCookie}; ${withToken}`);
    check('connecté *et* porteur du jeton, la revendication se rattrape',
        rescued.json.master === true && owner.get().id === '222',
        'sans nouveau passage par Discord');

    // ───────── Le repli ─────────

    console.log('\nQuand l\'application Discord n\'est pas configurée\n');

    const savedSecret = process.env.DISCORD_CLIENT_SECRET;
    delete process.env.DISCORD_CLIENT_SECRET;

    const unconfigured = await ask(port, '/auth/state', withToken);
    check('le jeton retrouve les pleins droits', unconfigured.json.master === true,
        'personne ne s\'enferme hors de son propre bot');
    check('et rien n\'est demandé', unconfigured.json.pendingLogin === false);
    check('l\'interface sait que la connexion est impossible',
        unconfigured.json.oauthReady === false);

    // Le repli ne vaut que pour le jeton : un inconnu reste dehors.
    const strangerWithoutOauth = await ask(port, '/auth/state', null);
    check('un inconnu reste dehors pour autant', strangerWithoutOauth.status === 401);

    process.env.DISCORD_CLIENT_SECRET = savedSecret;
    const reconfigured = await ask(port, '/auth/state', withToken);
    check('la porte se referme dès la configuration revenue',
        reconfigured.json.master === false && reconfigured.json.pendingLogin === true);

    // ───────── La fenêtre elle-même ─────────

    console.log('\nCe que la fenêtre ne permet pas\n');

    const MARKUP = fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'index.html'), 'utf8');
    const SCRIPT = fs.readFileSync(
        path.join(ROOT, 'src', 'web', 'public', 'js', 'loginGate.js'), 'utf8');
    const CSS = fs.readFileSync(
        path.join(ROOT, 'src', 'web', 'public', 'css', 'modals.css'), 'utf8');

    const box = MARKUP.slice(MARKUP.indexOf('id="login-gate"'), MARKUP.indexOf('id="maintenance-modal"'));

    // On cherche de vraies commandes de fermeture — une classe, un identifiant,
    // un libellé —, pas le mot « fermer » qui se promène dans les commentaires.
    const closers = (box.match(/(?:id|class|data-i18n)="[^"]*"/g) || [])
        .filter(a => /close|cancel|dismiss|annul/i.test(a));
    check('aucune commande de fermeture', closers.length === 0,
        closers.length ? closers.join(' | ') : 'ni croix, ni « Annuler »');
    check('aucun clic à côté ne la referme',
        !/login-gate'\)\.addEventListener\('click'/.test(SCRIPT));
    check('la touche d\'échappement est retenue',
        /Escape[\s\S]{0,120}preventDefault/.test(SCRIPT));
    check('la tabulation ne sort pas de la fenêtre',
        /Tab/.test(SCRIPT) && /shiftKey/.test(SCRIPT),
        'sinon le focus se promène dans un tableau de bord inerte');
    check('la page derrière ne défile plus',
        /body\.login-gate-open \{[^}]*overflow: hidden/.test(CSS));
    check('elle passe devant toutes les autres fenêtres',
        /\.login-gate \{[^}]*z-index: 30000/.test(CSS),
        'celles des réglages montent déjà à 20000');
    check('elle est écrite dans le balisage, pas fabriquée au vol',
        MARKUP.includes('id="btn-login-discord"'),
        'elle paraît avec la page, non une seconde après');

    // La demande d'autorisation reste au strict nécessaire.
    const OAUTH = fs.readFileSync(path.join(ROOT, 'src', 'web', 'oauth.js'), 'utf8');
    check('seule la portée « identify » est demandée',
        /scope[^\n]*identify/.test(OAUTH) && !/guilds\.join|email/.test(OAUTH));

    // ───────── L'origine sur laquelle la fenêtre s'ouvre ─────────

    console.log('\nOù le bot ouvre le tableau de bord\n');

    {
        /*
         * Une session vit dans un cookie, et un cookie appartient à une
         * origine. L'aller-retour de connexion revient toujours sur
         * `PUBLIC_URL` — ou sur `localhost` à défaut : c'est donc la seule
         * adresse où une session puisse exister.
         *
         * La fenêtre s'ouvrait sur l'interface d'écoute, `127.0.0.1`, qui n'en
         * porte aucune et n'en portera jamais. Elle montrait donc la porte de
         * connexion à chaque lancement, et s'y connecter n'y changeait rien :
         * le retour de Discord posait le cookie sur l'autre origine.
         *
         * Le piège tenait même sans PUBLIC_URL, `localhost` et `127.0.0.1`
         * étant deux origines distinctes pour un navigateur.
         */
        const oauthPath = path.join(ROOT, 'src', 'web', 'oauth.js');
        const origine = (u) => new URL(u).origin;
        const avant = process.env.PUBLIC_URL;
        process.env.PORT = process.env.PORT || '3000';

        {
            delete require.cache[require.resolve(oauthPath)];
            process.env.PUBLIC_URL = 'https://exemple.romainpiau.dev';
            const oauth = require(oauthPath);

            check('avec PUBLIC_URL : la fenêtre s\'ouvre là où Discord renvoie',
                origine(`${oauth.entryUrl()}/?token=x`) === origine(oauth.redirectUri()),
                oauth.entryUrl());
            check('  … et l\'interface d\'écoute n\'y menait pas',
                origine('http://127.0.0.1:3000/') !== origine(oauth.redirectUri()),
                'deux origines distinctes ne partagent aucun cookie');
        }

        {
            /*
             * Sans adresse déclarée, le relais renvoie chaque connexion sur
             * l'origine d'où elle est partie (voir oauthRelay.js). Le piège
             * disparaît : `localhost` comme `127.0.0.1` portent une session,
             * pourvu que le relais sache y revenir.
             */
            delete require.cache[require.resolve(oauthPath)];
            delete process.env.PUBLIC_URL;
            const oauth = require(oauthPath);
            const relay = require(path.join(ROOT, 'src', 'web', 'oauthRelay.js'));

            check('sans PUBLIC_URL : le retour passe par le relais',
                oauth.usesRelay() && oauth.redirectUri() === oauth.relayUrl(),
                oauth.redirectUri());
            check('  … qui sait revenir là où la fenêtre s\'ouvre',
                relay.acceptedTarget(oauth.entryUrl()) === origine(oauth.entryUrl()),
                oauth.entryUrl());
            check('  … comme sur l\'interface d\'écoute',
                relay.acceptedTarget('http://127.0.0.1:3000') === 'http://127.0.0.1:3000');
        }

        delete require.cache[require.resolve(oauthPath)];
        if (avant) process.env.PUBLIC_URL = avant; else delete process.env.PUBLIC_URL;

        const SERVER = fs.readFileSync(path.join(ROOT, 'src', 'web', 'WebServer.js'), 'utf8');
        check('l\'ouverture automatique suit cette origine',
            /const url = `\$\{require\('\.\/oauth'\)\.entryUrl\(\)\}\/\?token=\$\{token\}`;/.test(SERVER)
            && !/const url = `http:\/\/\$\{displayHost\}/.test(SERVER));
        check('  … et la trace de démarrage annonce la même',
            /Dashboard reachable at: \$\{entry\}/.test(SERVER));

        /*
         * Dite après le relevé de partage : le tunnel peut se rouvrir à cet
         * instant-là, et l'annoncer plus tôt donnerait la situation d'avant.
         */
        check('  … une fois l\'adresse publique déduite',
            SERVER.indexOf('const announceEntry') < SERVER.indexOf('announceEntry();')
            && (SERVER.match(/\n\s*announceEntry\(\);/g) || []).length === 2,
            'les deux issues du relevé de partage');

        /*
         * Le lanceur, qui retombait dans le même piège par l'autre porte.
         *
         * « Ouvrir le tableau de bord », bot déjà lancé, ouvrait l'interface
         * d'écoute lue dans `.env` : la porte de connexion, pour un propriétaire
         * connecté à un onglet de là. Il demande désormais l'adresse au bot, la
         * seul à savoir si le relais de retour OAuth est employé.
         *
         * Et il la demande avec le jeton en en-tête. En query, un GET est
         * redirigé vers l'adresse nettoyée — le cookie posé au passage, que
         * `Invoke-RestMethod` ne garde pas : la question revenait en 401, à
         * chaque fois, sans que rien ne le signale.
         */
        const avantLanceur = process.env.PUBLIC_URL;
        process.env.PUBLIC_URL = 'https://exemple.romainpiau.dev';

        const launcher = await new Promise((resolve, reject) => {
            http.get({
                host: '127.0.0.1', port, path: '/api/clients',
                headers: { Accept: 'application/json', Authorization: `Bearer ${TOKEN}` },
            }, (res) => {
                let body = '';
                res.on('data', (c) => { body += c; });
                res.on('end', () => {
                    let json = null;
                    try { json = JSON.parse(body); } catch (e) {}
                    resolve({ status: res.statusCode, json });
                });
            }).on('error', reject);
        });
        check('le lanceur apprend du bot où ouvrir le tableau de bord',
            launcher.status === 200 && launcher.json && launcher.json.entry === 'https://exemple.romainpiau.dev',
            launcher.json ? launcher.json.entry : String(launcher.status));
        check('  … le jeton en en-tête y obtient une réponse directe',
            launcher.status === 200 && typeof launcher.json.count === 'number');

        const viaQuery = await ask(port, `/api/clients?token=${TOKEN}`);
        check('  … là où le jeton en query est redirigé',
            viaQuery.status === 302, 'Invoke-RestMethod en perdrait le cookie');

        const LAUNCHER = fs.readFileSync(path.join(ROOT, 'tools', 'start-bot.ps1'), 'utf8');
        check('  … et le lanceur s\'en sert',
            /Start-Process \(DashboardUrl -Entry \$info\.Entry\)/.test(LAUNCHER)
            && /\$headers\.Authorization = "Bearer \$token"/.test(LAUNCHER));

        if (avantLanceur) process.env.PUBLIC_URL = avantLanceur; else delete process.env.PUBLIC_URL;
    }

    // ───────── Les traductions ─────────

    console.log('\nCe que les quatre langues doivent dire\n');

    const KEYS = ['login_gate_title', 'login_gate_lead', 'login_gate_action',
        'login_gate_scope', 'login_gate_unconfigured_title', 'login_gate_unconfigured_body',
        'login_gate_continue_token', 'login_gate_failed'];
    for (const lang of ['fr', 'en', 'es', 'de']) {
        const dictionary = JSON.parse(fs.readFileSync(
            path.join(ROOT, 'src', 'web', 'public', 'locales', `${lang}.json`), 'utf8'));
        const missing = KEYS.filter(k => !dictionary[k]);
        check(`${lang} : les ${KEYS.length} libellés de la porte sont traduits`,
            missing.length === 0, missing.join(', '));
    }

    server.close();
    try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) {}

    console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
    process.exit(failed > 0 ? 1 : 0);
});
