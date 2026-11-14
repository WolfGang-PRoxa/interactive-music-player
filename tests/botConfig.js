/**
 * Vérifie la section « Configuration du bot » : le .env réglé depuis le
 * tableau de bord.
 *
 * Ce que ce test protège :
 *
 *  - **Le fichier garde sa forme.** Seules les lignes des clés changées
 *    bougent ; les commentaires, l'ordre, les fins de ligne Windows restent.
 *    Ce qui est écrit se relit à l'identique par dotenv, même avec un `#` ou
 *    des blancs.
 *  - **Un secret ne repart jamais** vers le navigateur : seulement « renseigné »
 *    ou non.
 *  - **Ce qui peut couper l'accès ne se change que devant la machine**, et le
 *    tunnel Cloudflare, qui arrive pourtant de la machine elle-même, n'y passe
 *    pas pour local.
 *  - **Tout ou rien** : une valeur refusée, et rien n'est écrit.
 *  - **Réservé au propriétaire** : un invité ne peut ni lire ni écrire.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const dotenv = require(path.join(__dirname, '..', 'node_modules', 'dotenv'));

const ROOT = path.join(__dirname, '..');

let failed = 0;
let passed = 0;
const check = (label, ok, detail = '') => {
    if (ok) { passed++; console.log(`  ok    ${label}`); }
    else { failed++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
};

// Un dossier de travail à soi : envFile écrit dans `process.cwd()/.env`.
const bac = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-config-'));
const home = process.cwd();
process.chdir(bac);

const envFile = require(path.join(ROOT, 'src', 'utils', 'envFile'));
const botConfig = require(path.join(ROOT, 'src', 'web', 'botConfig'));
const permissions = require(path.join(ROOT, 'src', 'web', 'permissions'));
const auth = require(path.join(ROOT, 'src', 'web', 'auth'));
const handlers = require(path.join(ROOT, 'src', 'web', 'websocket', 'handlers'));

const ENV = path.join(bac, '.env');
const TOKEN = 'MTAxMjM0NTY3ODkwMTIzNDU2.GabcDe.abcdefghijklmnopqrstuvwxyz0123';
const local = { fromThisMachine: true };
const remote = { fromThisMachine: false };

try {
    console.log('\n=== Le fichier .env garde sa forme ===');
    {
        fs.writeFileSync(ENV, '# Le jeton\r\nDISCORD_TOKEN=old.token.value\r\n\r\n# Adresse\r\nPUBLIC_URL=\r\nPORT=3000\r\n');
        envFile.update({ PUBLIC_URL: 'https://imp.exemple.fr', MAX_UPLOAD_MB: '50' });
        const text = fs.readFileSync(ENV, 'utf8');
        check('la ligne de la clé est remplacée sur place',
            text.startsWith('# Le jeton\r\nDISCORD_TOKEN=old.token.value\r\n\r\n# Adresse\r\nPUBLIC_URL=https://imp.exemple.fr\r\nPORT=3000\r\n'), JSON.stringify(text));
        check('une clé absente est ajoutée à la fin', text.endsWith('PORT=3000\r\nMAX_UPLOAD_MB=50\r\n'), JSON.stringify(text));
        check('les fins de ligne Windows sont conservées', !/[^\r]\n/.test(text));
    }
    {
        fs.writeFileSync(ENV, '\uFEFFA=1\nA=2\n');
        envFile.update({ A: '3' });
        check('une clé en double est réécrite partout, BOM retiré',
            fs.readFileSync(ENV, 'utf8') === 'A=3\nA=3\n');
    }
    {
        fs.writeFileSync(ENV, '');
        const tricky = {
            HASH: 'abc#def',
            SPACES: '  bordé  ',
            QUOTE: "l'apostrophe #1",
            BOTH: 'a\'b"c #',
            PATHS: 'D:\\Musique;E:\\Films',
        };
        envFile.update(tricky);
        const back = dotenv.parse(fs.readFileSync(ENV, 'utf8'));
        check('ce qui est écrit se relit à l\'identique par dotenv',
            Object.entries(tricky).every(([k, v]) => back[k] === v), JSON.stringify(back));
        let refused = false;
        try { envFile.update({ X: 'deux\nlignes' }); } catch (e) { refused = true; }
        check('une valeur sur deux lignes est refusée', refused);
    }
    {
        fs.unlinkSync(ENV);
        fs.writeFileSync(path.join(bac, '.env.example'), '# Explication\nDISCORD_TOKEN=your_bot_token_here\nPORT=3000\n');
        envFile.update({ PORT: '3100' });
        check('sans .env, le fichier part du modèle et de ses explications',
            fs.readFileSync(ENV, 'utf8') === '# Explication\nDISCORD_TOKEN=your_bot_token_here\nPORT=3100\n');
    }

    console.log('\n=== Ce que la section montre ===');
    {
        fs.writeFileSync(ENV, `DISCORD_TOKEN=${TOKEN}\nDISCORD_CLIENT_SECRET=\nCLOUDFLARE_TUNNEL_TOKEN=eyJhIjoic2VjcmV0In0abcdef\nPUBLIC_URL=https://imp.exemple.fr\n`);
        process.env.DISCORD_TOKEN = TOKEN;
        process.env.PUBLIC_URL = 'https://imp.exemple.fr';
        process.env.CLOUDFLARE_TUNNEL_TOKEN = 'eyJhIjoic2VjcmV0In0abcdef';
        const state = botConfig.snapshot(local);
        const json = JSON.stringify(state);
        const field = (key) => state.fields.find((f) => f.key === key);
        check('aucun secret ne part vers le navigateur',
            !json.includes(TOKEN) && !json.includes('eyJhIjoic2VjcmV0In0abcdef'));
        check('un secret dit seulement s\'il est renseigné',
            field('DISCORD_TOKEN').set === true && field('DISCORD_CLIENT_SECRET').set === false
            && !('value' in field('DISCORD_TOKEN')));
        check('une valeur ordinaire est montrée', field('PUBLIC_URL').value === 'https://imp.exemple.fr');
        check('DASHBOARD_TOKEN et AUTO_OPEN_DASHBOARD ne sont pas réglables ici',
            !field('DASHBOARD_TOKEN') && !field('AUTO_OPEN_DASHBOARD'));
        check('fichier et processus d\'accord : pas de redémarrage demandé', state.restartNeeded === false,
            JSON.stringify(state.fields.filter((f) => f.value !== undefined && f.value !== (process.env[f.key] || ''))));
    }

    {
        const saved = fs.readFileSync(ENV, 'utf8');
        fs.writeFileSync(ENV, 'DISCORD_TOKEN=your_bot_token_here\nDISCORD_CLIENT_ID=your_client_id_here\n');
        const state = botConfig.snapshot(local);
        const field = (key) => state.fields.find((f) => f.key === key);
        check('les valeurs de démonstration de .env.example comptent pour vides',
            field('DISCORD_TOKEN').set === false && field('DISCORD_CLIENT_ID').value === '');
        fs.writeFileSync(ENV, saved);
    }

    console.log('\n=== Ce qui s\'écrit, d\'où, et comment ===');
    {
        const before = fs.readFileSync(ENV, 'utf8');
        const res = botConfig.apply({ PUBLIC_URL: '', LOG_LEVEL: 'info' }, remote);
        check('à distance, l\'adresse publique est refusée', !res.ok && res.errors.PUBLIC_URL === 'local_only');
        check('tout ou rien : le réglage permis n\'est pas écrit pour autant',
            fs.readFileSync(ENV, 'utf8') === before);

        const res2 = botConfig.apply({ LOG_LEVEL: 'info', MAX_UPLOAD_MB: '2048' }, remote);
        check('à distance, plafonds et journaux se règlent', res2.ok && res2.saved.length === 2,
            JSON.stringify(res2));
        check('… et le bot demande alors à redémarrer', botConfig.snapshot(remote).restartNeeded === true);

        for (const key of ['DISCORD_TOKEN', 'DISCORD_CLIENT_SECRET', 'CLOUDFLARE_TUNNEL_TOKEN', 'PORT', 'HOST', 'MEDIA_ROOTS', 'OAUTH_RELAY_URL', 'DISCORD_CLIENT_ID']) {
            const field = botConfig.FIELDS.find((f) => f.key === key);
            check(`${key} ne se change que devant la machine`, field && field.local === true);
        }
    }
    {
        const res = botConfig.apply({ DISCORD_TOKEN: 'pas-un-jeton', PUBLIC_URL: 'https://imp.exemple.fr/chemin' }, local);
        check('un mauvais jeton et une adresse avec chemin sont refusés',
            res.errors.DISCORD_TOKEN === 'invalid_token' && res.errors.PUBLIC_URL === 'invalid_url');
        check('le jeton du bot ne peut pas être vidé', botConfig.apply({ DISCORD_TOKEN: '' }, local).errors.DISCORD_TOKEN === 'required');
        check('un port hors limites est refusé', botConfig.apply({ PORT: '80' }, local).errors.PORT === 'out_of_range');

        const ok = botConfig.apply({
            PUBLIC_URL: 'https://Imp.Exemple.fr/',
            OAUTH_RELAY_URL: 'OFF',
            DISCORD_CLIENT_SECRET: 'nouveau-secret',
            CLOUDFLARE_TUNNEL_TOKEN: '',
            MEDIA_ROOTS: ' D:\\Musique ; E:\\Films ,',
        }, local);
        const back = dotenv.parse(fs.readFileSync(ENV, 'utf8'));
        check('depuis la machine, tout s\'écrit', ok.ok, JSON.stringify(ok.errors));
        check('l\'adresse est ramenée à son origine', back.PUBLIC_URL === 'https://imp.exemple.fr');
        check('« OFF » devient « off »', back.OAUTH_RELAY_URL === 'off');
        check('un secret se remplace, un autre s\'efface',
            back.DISCORD_CLIENT_SECRET === 'nouveau-secret' && back.CLOUDFLARE_TUNNEL_TOKEN === '');
        check('les dossiers sont remis en ordre', back.MEDIA_ROOTS === 'D:\\Musique;E:\\Films');
        check('une clé inconnue est refusée', botConfig.apply({ DASHBOARD_TOKEN: 'x' }, local).errors.DASHBOARD_TOKEN === 'unknown');
    }

    console.log('\n=== Qui peut demander, et d\'où ===');
    {
        const guest = { master: false, permissions: permissions.allPermissions() };
        check('un invité, même avec tous les droits, ne lit pas la configuration',
            !permissions.canSend(guest, 'configState') && !permissions.canSend(guest, 'configUpdate'));
        check('le propriétaire, si', permissions.canSend({ master: true }, 'configUpdate'));
        check('les deux messages sont routés',
            typeof handlers.configState === 'function' && typeof handlers.configUpdate === 'function');

        const req = (address, headers = {}) => ({ socket: { remoteAddress: address }, headers });
        check('une connexion de la machine est locale', auth.fromThisMachine(req('127.0.0.1')) && auth.fromThisMachine(req('::1')));
        check('le tunnel Cloudflare ne passe pas pour local',
            !auth.fromThisMachine(req('127.0.0.1', { 'cf-connecting-ip': '203.0.113.9' })));
        check('le réseau local non plus', !auth.fromThisMachine(req('192.168.1.20')));
    }
    {
        // Le handler s'en remet à la connexion pour savoir d'où elle vient.
        const sent = [];
        const ws = { fromThisMachine: false, send: (m) => sent.push(JSON.parse(m)) };
        handlers.configUpdate({ ws, data: { values: { PORT: '3200' } } });
        const reply = sent.pop();
        check('le handler répond par l\'état et le refus',
            reply.type === 'configState' && reply.data.result.errors.PORT === 'local_only' && Array.isArray(reply.data.fields));
    }
} finally {
    process.chdir(home);
    fs.rmSync(bac, { recursive: true, force: true });
}

/*
 * Les menus de la section sont ceux du reste du tableau de bord : le <select>
 * natif du navigateur y détonnait. Il reste dessous, masqué, et c'est toujours
 * lui que lit l'envoi. `jsdom` arrive avec une dépendance, d'où le repli
 * (comme dans tests/guestSelects.js).
 */
{
    let JSDOM = null;
    try { ({ JSDOM } = require('jsdom')); } catch { console.log('  passé — jsdom absent de cette installation'); }
    if (JSDOM) {
        const pub = (...p) => fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', ...p), 'utf8');
        const dom = new JSDOM('<!doctype html><div id="config-zone"></div>', { runScripts: 'outside-only', url: 'http://localhost:3000/' });
        const win = dom.window;
        const sent = [];
        win.eval(pub('js', 'customSelect.js'));
        win.MusicPlayer.sendWS = (m) => sent.push(m);
        win.eval(pub('js', 'botConfig.js'));

        const state = {
            fromThisMachine: false,
            restartNeeded: false,
            fields: [
                { key: 'HOST', group: 'network', kind: 'select', options: ['127.0.0.1', '0.0.0.0'], value: '127.0.0.1', local: true },
                { key: 'LOG_LEVEL', group: 'logs', kind: 'select', options: ['', 'debug', 'info', 'warn', 'error'], value: '' },
            ],
        };
        win.MusicPlayer.onConfigState(state);
        const doc = win.document;
        const host = doc.getElementById('config-HOST');
        const level = doc.getElementById('config-LOG_LEVEL');
        const menuOf = (select) => select.nextElementSibling;

        check('chaque <select> de la section a le menu du tableau de bord',
            [host, level].every((s) => s.style.display === 'none' && menuOf(s) && menuOf(s).classList.contains('custom-select-container')));
        check('le menu montre le libellé traduit, pas la valeur brute',
            menuOf(level).querySelector('.custom-select-trigger').textContent.trim() === 'Par défaut');

        // Le verrou est une règle de feuille de style (pointer-events), que
        // jsdom n'applique pas : on vérifie qu'elle vise bien ce menu.
        const css = pub('css', 'modals.css');
        check('un réglage grisé à distance garde son menu verrouillé',
            host.disabled && host.closest('.config-field').classList.contains('is-locked')
            && /\.config-field\.is-locked \.custom-select-container\s*\{[^}]*pointer-events:\s*none/.test(css));

        const warn = Array.from(menuOf(level).querySelectorAll('.custom-select-option')).find((o) => o.dataset.value === 'warn'
            || o.textContent.trim() === 'Avertissements');
        if (warn) warn.click();
        doc.querySelector('.config-actions button').click();
        const update = sent.find((m) => m.type === 'configUpdate');
        check('le choix fait dans le menu part à l\'enregistrement',
            update && JSON.stringify(update.data.values) === JSON.stringify({ LOG_LEVEL: 'warn' }), JSON.stringify(update));

        win.MusicPlayer.onConfigState({ ...state, result: { ok: false, errors: { LOG_LEVEL: 'invalid_value' } } });
        const kept = doc.getElementById('config-LOG_LEVEL');
        check('refusé, le choix reste affiché et le menu est signalé',
            kept.value === 'warn'
            && menuOf(kept).querySelector('.custom-select-trigger').classList.contains('has-error')
            && menuOf(kept).querySelector('.custom-select-trigger').textContent.trim() === 'Avertissements');
        win.close();
    }
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
