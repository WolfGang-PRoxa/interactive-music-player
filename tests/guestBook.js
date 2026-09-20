/**
 * Vérifie qu'on se souvient des invités, et qu'un interrupteur reste où on le
 * pousse.
 *
 * Deux moitiés, et chacune répare quelque chose qu'aucun diff ne montrait.
 *
 * ## L'interrupteur qui revenait sur « off »
 *
 * Accorder un droit ne marchait pas. On poussait l'interrupteur, il sautait, il
 * revenait. La cause tenait en un mot : dans l'ancienne `listenerRow`, la
 * boucle qui bâtissait les cases déclarait un `row` local qui masquait celui de
 * la ligne. Le gestionnaire de changement relisait donc `row.querySelectorAll(
 * '.share-grant input')` sur le `.share-grant` lui-même — qui n'est pas son
 * propre descendant, et ne correspond à rien. Le jeu de droits partait vide,
 * `hasAny` échouait, le serveur effaçait l'invité de la table, et l'état
 * diffusé remettait la case à zéro.
 *
 * Autrement dit : **chaque clic envoyait « retire-lui tout »**. Le symptôme
 * ressemblait à une course entre l'affichage et le réseau ; c'était une portée
 * de variable. Le test ci-dessous lit la charge utile réellement émise, seul
 * endroit où le mensonge se voit.
 *
 * ## L'invité qui disparaissait
 *
 * La fenêtre de partage tirait ses noms des sessions ouvertes. Une session dure
 * trente jours, s'évince au-delà de huit appareils, et part à la révocation :
 * passé ce délai l'invité s'effaçait de l'écran — nom et avatar compris — alors
 * que ses droits, eux, restaient inscrits dans les réglages. Le carnet
 * (web/guests.js) sépare « qui est cette personne » de « cet onglet est-il à
 * elle », ce qui permet de la montrer hors ligne au lieu de l'oublier.
 *
 * Le carnet est éprouvé pour de vrai dans un dossier jetable ; la fenêtre l'est
 * dans un DOM simulé, sur le fichier livré.
 */
const fs = require('fs');
const os = require('os');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let failed = 0;
let passed = 0;
const check = (label, ok, detail = '') => {
    if (ok) { passed++; console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`); }
    else { failed++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
};

console.log('\n=== Se souvenir des invités, et leur confier des droits ===\n');

/* ════════════════════════ 1. Le carnet ════════════════════════ */

console.log('Le carnet des invités\n');

// Dossier jetable choisi avant tout require : le carnet écrit dans data/ du
// répertoire courant, et un test n'a rien à faire près des fichiers réels.
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'carnet-'));
fs.mkdirSync(path.join(SANDBOX, 'data'));
const CWD = process.cwd();
process.chdir(SANDBOX);

const guests = require(path.join(ROOT, 'src', 'web', 'guests.js'));

{
    const marie = { id: '111', username: 'marie', global_name: 'Marie', avatar: 'abc' };

    guests.remember(marie);
    const fiche = guests.get('111');
    check('un compte revenu de Discord entre au carnet', Boolean(fiche));
    check('  … sous son nom d\'affichage', fiche.displayName === 'Marie');
    check('  … avec l\'adresse complète de son avatar',
        fiche.avatar === 'https://cdn.discordapp.com/avatars/111/abc.png?size=64');

    const premiere = fiche.firstSeenAt;
    guests.remember({ ...marie, global_name: 'Marie B.' });
    check('un second passage rafraîchit le nom',
        guests.get('111').displayName === 'Marie B.',
        'quelqu\'un qui se renomme doit rester trouvable');
    check('  … sans toucher à la date de première venue',
        guests.get('111').firstSeenAt === premiere);

    check('le carnet survit à l\'écriture sur disque',
        JSON.parse(fs.readFileSync(path.join(SANDBOX, 'data', 'guests.json'), 'utf8'))['111']
            .displayName === 'Marie B.',
        'un redémarrage ne doit pas effacer les invités');

    /*
     * Le geste du refus. Y laisser la fiche ferait réapparaître à la ligne
     * suivante celui qu'on vient de congédier, hors ligne mais toujours là.
     */
    guests.forget('111');
    check('congédier efface la fiche', guests.get('111') === null);
    check('  … et oublier un inconnu ne casse rien', guests.forget('jamais-vu') === false);
}

{
    // Le rattrapage d'une installation mise à jour : les invités existent déjà,
    // mais seulement dans les sessions. Sans reprise, ils n'entreraient au
    // carnet qu'à leur prochaine authentification.
    const repris = guests.adopt([
        { userId: '222', displayName: 'Paul', avatar: null, lastSeenAt: 1000 },
        { userId: '333', displayName: 'Zoé', avatar: null, lastSeenAt: 5000 },
    ]);
    check('les invités des sessions ouvertes sont repris', repris === 2);

    guests.adopt([{ userId: '222', displayName: 'Autre nom', avatar: null, lastSeenAt: 9000 }]);
    check('  … et une fiche déjà là fait foi',
        guests.get('222').displayName === 'Paul',
        'la reprise n\'écrase jamais');

    const noms = guests.list().map((g) => g.userId);
    check('le carnet se lit du plus récent au plus ancien',
        noms[0] === '333' && noms[1] === '222', noms.join(' → '));
}

process.chdir(CWD);
fs.rmSync(SANDBOX, { recursive: true, force: true });

/* ════════════════════ 2. Un DOM juste assez vrai ════════════════════ */

/**
 * Le strict nécessaire pour faire tourner js/sharedControl.js.
 *
 * Ni jsdom ni navigateur : ce qu'on veut éprouver est la charge utile émise au
 * clic, et elle ne dépend que de l'arbre que le module construit lui-même.
 */
function makeDom() {
    const byId = new Map();

    function makeEl(tag) {
        const el = {
            tagName: String(tag).toUpperCase(),
            children: [],
            parent: null,
            dataset: {},
            style: {},
            _classes: new Set(),
            _listeners: {},
            _text: '',
            checked: false,
            disabled: false,
            type: '',
        };

        el.classList = {
            add: (...c) => c.forEach((x) => el._classes.add(x)),
            remove: (...c) => c.forEach((x) => el._classes.delete(x)),
            contains: (c) => el._classes.has(c),
            toggle: (c, force) => {
                const on = force === undefined ? !el._classes.has(c) : force;
                if (on) el._classes.add(c); else el._classes.delete(c);
                return on;
            },
        };

        Object.defineProperty(el, 'className', {
            get: () => [...el._classes].join(' '),
            set: (v) => { el._classes = new Set(String(v).split(/\s+/).filter(Boolean)); },
        });
        Object.defineProperty(el, 'textContent', {
            get: () => el._text,
            set: (v) => { el._text = String(v); el.children = []; },
        });
        Object.defineProperty(el, 'innerHTML', {
            get: () => '',
            // Le module s'en sert pour vider la liste avant de la repeindre, et
            // pour poser une icône. Dans les deux cas seul le vidage compte.
            set: () => { el.children = []; },
        });

        el.appendChild = (child) => { child.parent = el; el.children.push(child); return child; };
        el.setAttribute = (name, value) => { el.dataset[`attr_${name}`] = value; };
        el.addEventListener = (type, fn) => {
            (el._listeners[type] = el._listeners[type] || []).push(fn);
        };
        el.removeEventListener = () => {};
        el.fire = (type) => (el._listeners[type] || []).forEach((fn) => fn({
            target: el, preventDefault() {}, stopPropagation() {},
        }));
        el.querySelectorAll = (sel) => matchAll(el, sel);
        el.querySelector = (sel) => matchAll(el, sel)[0] || null;
        el.closest = () => null;

        return el;
    }

    /** Tous les descendants, en profondeur. */
    function walk(root, out = []) {
        for (const child of root.children) {
            out.push(child);
            walk(child, out);
        }
        return out;
    }

    /** `.classe`, `#id`, `tag` — le seul vocabulaire dont le module se sert. */
    function matches(el, simple) {
        if (simple.startsWith('.')) return el._classes.has(simple.slice(1));
        if (simple.startsWith('#')) return el.dataset._id === simple.slice(1);
        return el.tagName === simple.toUpperCase();
    }

    function matchAll(root, selector) {
        const chain = selector.trim().split(/\s+/);
        let current = [root];
        for (const simple of chain) {
            const next = [];
            for (const node of current) {
                for (const candidate of walk(node)) {
                    if (matches(candidate, simple) && !next.includes(candidate)) next.push(candidate);
                }
            }
            current = next;
        }
        return current;
    }

    const document = {
        readyState: 'complete',
        documentElement: makeEl('html'),
        body: makeEl('body'),
        createElement: makeEl,
        getElementById: (id) => byId.get(id) || null,
        querySelectorAll: () => [],
        addEventListener: () => {},
    };

    /** Déclare un élément du balisage que le module ira chercher par son id. */
    function mount(id) {
        const el = makeEl('div');
        el.dataset._id = id;
        byId.set(id, el);
        return el;
    }

    return { document, mount, walk, makeEl };
}

/**
 * Monte le vrai js/sharedControl.js dans ce DOM, fenêtre de partage ouverte.
 *
 * @returns {{ apply: Function, sent: Array, list: object, dom: object }}
 */
function mountShare() {
    const SOURCE = fs.readFileSync(
        path.join(ROOT, 'src', 'web', 'public', 'js', 'sharedControl.js'), 'utf8');

    const dom = makeDom();
    for (const id of ['share-modal', 'share-people-list', 'btn-open-share',
        'btn-close-share', 'btn-send-invite', 'share-oauth-warning', 'share-callback-url',
        'share-invite-channel', 'share-controls-wrapper']) {
        dom.mount(id);
    }

    const sent = [];
    const sandbox = {
        window: { MusicPlayer: { sendWS: (msg) => sent.push(msg), state: {} } },
        document: dom.document,
        console,
        setTimeout, clearTimeout,
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(SOURCE, sandbox);

    // La fenêtre ne se peint que si elle est ouverte : le module s'arrête net
    // sur `classList.contains('hidden')`.
    dom.document.getElementById('share-modal').classList.remove('hidden');

    return {
        dom,
        sent,
        player: sandbox.window.MusicPlayer,
        apply: (state) => {
            sandbox.window.MusicPlayer.state = state;
            sandbox.window.MusicPlayer.applyShareState(state);
        },
        list: () => dom.document.getElementById('share-people-list'),
        all: () => dom.walk(dom.document.getElementById('share-people-list')),
    };
}

/** Le catalogue tel que le serveur l'envoie, pris à la source. */
const permissions = require(path.join(ROOT, 'src', 'web', 'permissions.js'));
const CATALOGUE = {
    groups: permissions.GROUPS,
    actions: permissions.GROUP_ACTIONS,
    presets: permissions.PRESETS,
};

/** Un état de maître, avec Marie connue et en ligne. */
function masterState(overrides = {}) {
    return {
        role: 'master',
        identity: { userId: '999' },
        members: [],
        permissions: permissions.allPermissions(),
        sharing: {
            oauthReady: true,
            publicUrl: 'http://exemple',
            grants: {},
            admitted: ['111'],
            pending: [],
            knownUsers: [{
                userId: '111', displayName: 'Marie', avatar: null,
                online: true, lastSeenAt: Date.now(), firstSeenAt: 0,
            }],
            catalogue: CATALOGUE,
            ...overrides,
        },
    };
}

/**
 * Déplie la ligne d'une personne, puis la rubrique demandée.
 *
 * Idempotent, et il le faut : la fenêtre retient ce qui est déplié d'un rendu à
 * l'autre. Cliquer sans regarder replierait ce qu'un appel précédent venait
 * d'ouvrir, et la rubrique cherchée ne serait plus là.
 */
function unfold(share, group) {
    const row = share.all().find((el) => el._classes.has('share-person'));
    if (!row._classes.has('is-open')) {
        share.all().find((el) => el._classes.has('share-person-fold')).fire('click');
    }

    if (!group) return;

    const fold = share.all().find((el) => el._classes.has('share-group-fold')
        && el.children.some((c) => c._text === group));
    if (!fold) throw new Error(`rubrique « ${group} » introuvable`);
    // fold → .share-group-head → .share-group
    if (!fold.parent.parent._classes.has('is-open')) fold.fire('click');
}

/** L'interrupteur d'un droit, retrouvé par son libellé. */
function switchFor(share, label) {
    const line = share.all().find((el) => el._classes.has('share-action')
        && el.children.some((c) => c._text === label));
    if (!line) throw new Error(`droit « ${label} » introuvable`);
    return line.querySelector('INPUT');
}

/* ═══════════ 3. L'interrupteur qui revenait sur « off » ═══════════ */

console.log('\nL\'interrupteur reste où on le pousse\n');

{
    const share = mountShare();
    share.apply(masterState());

    check('l\'invité connu figure dans la liste',
        share.all().some((el) => el._text === 'Marie'));

    unfold(share, 'File d\'attente');

    const box = switchFor(share, 'Ajouter une piste');
    box.checked = true;
    box.fire('change');

    const message = share.sent[share.sent.length - 1];
    check('cocher un droit envoie bien un partage',
        message && message.type === 'shareControl',
        message ? message.type : 'rien n\'a été envoyé');

    /*
     * Le cœur du bogue. L'ancienne version envoyait `{}` — un jeu vide, que le
     * serveur lit comme « retire-lui tout » —, d'où l'interrupteur qui revenait.
     */
    const accorde = permissions.granted(permissions.sanitize(message.data.permissions));
    check('  … et le droit coché s\'y trouve',
        accorde.includes('queue.add'),
        accorde.length ? accorde.join(', ') : 'JEU VIDE : le serveur retirerait tout');
    check('  … et lui seul', accorde.length === 1);
    check('  … pour la bonne personne', message.data.userId === '111');
}

{
    // Le second clic doit conserver le premier droit : c'est l'état complet qui
    // part, pas une différence, et un envoi qui oublierait l'acquis le
    // retirerait aussi sûrement qu'un jeu vide.
    const share = mountShare();
    share.apply(masterState({ grants: { 111: { 'queue.add': true } } }));
    unfold(share, 'Lecture');

    const box = switchFor(share, 'Se déplacer dans la piste');
    box.checked = true;
    box.fire('change');

    const accorde = permissions.granted(
        permissions.sanitize(share.sent[share.sent.length - 1].data.permissions));
    check('un second droit s\'ajoute au premier',
        accorde.includes('queue.add') && accorde.includes('playback.seek'),
        accorde.join(', '));
}

{
    // Et décocher doit décocher, sans emporter le reste.
    const share = mountShare();
    share.apply(masterState({
        grants: { 111: { 'queue.add': true, 'playback.seek': true } },
    }));
    unfold(share, 'File d\'attente');

    const box = switchFor(share, 'Ajouter une piste');
    box.checked = false;
    box.fire('change');

    const accorde = permissions.granted(
        permissions.sanitize(share.sent[share.sent.length - 1].data.permissions));
    check('décocher n\'enlève que ce qu\'on décoche',
        !accorde.includes('queue.add') && accorde.includes('playback.seek'),
        accorde.join(', ') || 'vide');
}

/* ═══════════ 4. Les rôles tout faits ═══════════ */

console.log('\nLes rôles posent une poignée de cases d\'un coup\n');

{
    const share = mountShare();
    share.apply(masterState());
    unfold(share);

    const dj = share.all().find((el) => el._classes.has('share-preset') && el._text === 'DJ');
    check('le rôle « DJ » est proposé', Boolean(dj));
    dj.fire('click');

    const accorde = permissions.granted(
        permissions.sanitize(share.sent[share.sent.length - 1].data.permissions));
    check('  … et l\'envoi correspond exactement au rôle',
        permissions.matchPreset(permissions.sanitize(
            share.sent[share.sent.length - 1].data.permissions)) === 'dj',
        `${accorde.length} droits`);
}

/* ═══════════ 5. L'attente, et sa fin ═══════════ */

console.log('\nCe qui est en vol, et ce qui retombe\n');

{
    const share = mountShare();
    share.apply(masterState());
    unfold(share, 'File d\'attente');

    const box = switchFor(share, 'Ajouter une piste');
    box.checked = true;
    box.fire('change');

    /*
     * Le serveur n'a pas encore répondu : l'état diffusé porte toujours les
     * droits d'avant. La case doit rester cochée — la remettre à zéro sous le
     * doigt de celui qui vient de la pousser était l'autre moitié du symptôme.
     */
    share.apply(masterState());
    unfold(share, 'File d\'attente');
    check('la case tient pendant l\'aller-retour',
        switchFor(share, 'Ajouter une piste').checked === true);

    // Le serveur confirme : la mémoire d'attente doit se vider, sans quoi elle
    // recouvrirait à jamais les changements venus d'ailleurs.
    share.apply(masterState({ grants: { 111: { 'queue.add': true } } }));
    // Puis un autre onglet retire le droit. Si l'attente n'a pas été purgée,
    // l'écran garde la case cochée et ne montre jamais le retrait.
    share.apply(masterState({ grants: {} }));
    unfold(share, 'File d\'attente');
    check('  … puis cède la place à ce que dit le serveur',
        switchFor(share, 'Ajouter une piste').checked === false,
        'un retrait fait ailleurs doit finir par s\'afficher');
}

/* ═══════════ 6. En ligne, hors ligne ═══════════ */

console.log('\nQui est là, qui ne l\'est plus\n');

{
    const share = mountShare();
    share.apply(masterState());

    const online = share.all().find((el) => el._classes.has('share-person-state'));
    check('un invité connecté est annoncé en ligne',
        online._text === 'en ligne' && online._classes.has('is-online'), online._text);

    share.apply(masterState({
        knownUsers: [{
            userId: '111', displayName: 'Marie', avatar: null,
            online: false, lastSeenAt: Date.now() - 3 * 3600 * 1000, firstSeenAt: 0,
        }],
    }));

    const offline = share.all().find((el) => el._classes.has('share-person-state'));
    check('  … et le même, déconnecté, reste dans la liste',
        offline._classes.has('is-offline'), offline._text);
    check('  … avec la date de sa dernière venue',
        /il y a 3 h/.test(offline._text), offline._text,
    );

    /*
     * Le trou que le carnet comble : avant lui, cette ligne disparaissait
     * purement dès la session expirée, alors que les droits, eux, restaient.
     */
    const avatar = share.all().find((el) => el._classes.has('share-person-avatar'));
    check('  … et sa pastille s\'éteint', avatar._classes.has('is-offline'));
}

/* ═══════════ 7. Le raccordement ═══════════ */

console.log('\nCe qui tient les deux bouts\n');

{
    const SHARE = fs.readFileSync(
        path.join(ROOT, 'src', 'web', 'websocket', 'handlers', 'shareHandlers.js'), 'utf8');
    const CLIENT = fs.readFileSync(
        path.join(ROOT, 'src', 'web', 'public', 'js', 'sharedControl.js'), 'utf8');
    const GATE = fs.readFileSync(
        path.join(ROOT, 'src', 'web', 'public', 'js', 'loginGate.js'), 'utf8');

    check('congédier oublie aussi la fiche du carnet',
        /guests\.forget\(userId\)/.test(SHARE),
        'sinon le refusé revient à la ligne suivante');

    check('accorder un droit vaut admission',
        /database\.admitGuest\(currentGuildId, userId\);[\s\S]{0,80}setUserPermissions/.test(SHARE),
        'sinon l\'invité serait pourvu et toujours dans la file des demandes');

    /*
     * Le catalogue vient du serveur. Le recopier dans le navigateur ferait deux
     * tables à tenir d'accord, dont une seule refuse réellement.
     */
    check('le client ne redéfinit pas le catalogue des droits',
        /sharing\?\.catalogue\?\.actions/.test(CLIENT));

    check('la porte ne tente la reconnaissance muette qu\'une fois',
        /alreadyTried\(\)/.test(GATE) && /login.*===.*'manual'/.test(GATE),
        'sans quoi un échec relancerait un essai, indéfiniment');
}

/* ═══════════ 8. Le chemin qu'emprunte l'invité qui revient ═══════════ */

console.log('\nLa reconnaissance muette, là où elle sert vraiment\n');

/*
 * Le piège, et la raison de cette section.
 *
 * `pendingLogin` n'est vrai que pour le porteur du jeton : l'invité qui revient
 * sans cookie n'est pas *autorisé* du tout, la fenêtre de connexion du tableau
 * de bord ne le voit donc jamais et il tombe sur la page de refus. Corriger la
 * seule porte du tableau de bord n'aurait servi qu'au propriétaire — l'essai
 * doit avoir lieu dans le middleware, avant le 401.
 */
{
    const auth = require(path.join(ROOT, 'src', 'web', 'auth.js'));

    /** Une requête factice, et la réponse qu'on lui rend. */
    function visit(headers, url = '/', method = 'GET') {
        const req = { method, url, originalUrl: url, headers };
        const res = {
            statusCode: 200,
            redirectedTo: null,
            payload: null,
            status(code) { this.statusCode = code; return this; },
            type() { return this; },
            send(body) { this.payload = body; return this; },
            json(body) { this.payload = body; return this; },
            cookie() { return this; },
            redirect(code, to) { this.redirectedTo = to; return this; },
        };
        let passed = false;
        auth.middleware(req, res, () => { passed = true; });
        return { res, passed };
    }

    const page = { accept: 'text/html,application/xhtml+xml' };

    // Sans application Discord configurée, rien à tenter : la page de refus
    // explique au moins quoi faire, la redirection ne mènerait qu'à une erreur.
    delete process.env.DISCORD_CLIENT_ID;
    delete process.env.DISCORD_CLIENT_SECRET;
    check('sans OAuth, la page de refus est servie telle quelle',
        visit(page).res.redirectedTo === null);

    process.env.DISCORD_CLIENT_ID = 'test-client';
    process.env.DISCORD_CLIENT_SECRET = 'test-secret';

    const first = visit(page, '/?guild=42');
    check('un visiteur inconnu est reconnu en silence d\'abord',
        String(first.res.redirectedTo).startsWith('/auth/discord?silent=1'),
        first.res.redirectedTo || 'aucune redirection');
    check('  … et reviendra là où il allait',
        String(first.res.redirectedTo).includes(encodeURIComponent('/?guild=42')));

    // La seconde fois — l'essai a échoué, le rappel a posé la marque — la porte
    // s'arrête. Sans cette borne, le navigateur tournerait en rond.
    const second = visit(page, '/?login=manual');
    check('un essai déjà manqué ne se retente pas',
        second.res.redirectedTo === null && second.res.statusCode === 401,
        'sinon la redirection boucle indéfiniment');

    /*
     * Une balise `<audio src>` ou un appel de l'interface ne sait pas suivre un
     * trajet OAuth : les rediriger casserait la lecture et les requêtes au lieu
     * de rendre service.
     */
    check('une ressource non-HTML n\'est jamais redirigée',
        visit({ accept: 'audio/webm,audio/*' }, '/media/x.mp3').res.redirectedTo === null);
    check('  … ni un appel qui attend du JSON',
        visit({ accept: 'application/json' }, '/api/state').res.redirectedTo === null);
    check('  … ni une écriture',
        visit(page, '/api/upload', 'POST').res.redirectedTo === null);
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
