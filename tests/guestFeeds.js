/**
 * Vérifie ce qu'un invité distant reçoit et en fait : l'image calée sur ce
 * qu'il entend, et un flux mémoire qui ne s'entasse pas sur une liaison lente.
 *
 * ## Ce qui n'allait pas
 *
 *  - **La vidéo tirée entre deux horloges.** La boucle d'affichage d'app.js la
 *    recalait sur l'élément audio de la page ; `updateVideoPlayer`, à chaque
 *    message `progress`, sur la position du serveur — celle du tableau de bord
 *    pilote. Chez un invité, les deux s'écartent de près d'une seconde, et
 *    l'image sautait ou changeait de vitesse chaque seconde sur un son intact.
 *
 *  - **Le tiroir par à-coups.** Rien, côté serveur, ne distinguait l'invité de
 *    l'hôte : le soupçon porte sur la liaison. Une socket qui n'écoule plus ses
 *    lots ne doit pas en recevoir d'autres, qui arriveraient d'un bloc en
 *    retard ; et le fait doit se lire dans le journal.
 *
 * `jsdom` n'est pas une dépendance déclarée : la partie qui l'exige se retire
 * d'elle-même s'il manque, comme dans tests/rangeFocus.js.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'src', 'web', 'public');
const read = (...parts) => fs.readFileSync(path.join(PUBLIC, ...parts), 'utf8');

let failed = 0;
let passed = 0;
const check = (label, ok, detail = '') => {
    if (ok) { passed++; console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`); }
    else { failed++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
};

async function main() {
    console.log('\n=== Ce qu\'un invité distant reçoit ===\n');

    // ───────── L'image et le son ─────────

    console.log('La vidéo suit ce qu\'on entend\n');

    const VIDEO = read('js', 'video.js');
    const APP = read('app.js');
    const player = VIDEO.slice(VIDEO.indexOf('window.MusicPlayer.updateVideoPlayer = '));

    check('updateVideoPlayer ne recale plus sur la position du serveur',
        !/syncVideoProgress\(state\.progress\.currentMs\)/.test(player)
        && !/syncVideoProgress\(currentMs, false\)/.test(player));
    check('  … mais sur la référence commune, à ses deux passages',
        (player.match(/syncVideoProgress\(referenceMs\(state\)/g) || []).length === 2);
    check('app.js expose la position entendue',
        /window\.MusicPlayer\.heardPositionMs = heardPositionMs;/.test(APP));
    check('  … que la barre de progression lit elle aussi',
        /if \(isPersonal && audioHoldsPosition\(\)\)/.test(APP));

    let JSDOM;
    try {
        ({ JSDOM } = require('jsdom'));
    } catch (e) {
        JSDOM = null;
        console.log('  passé — jsdom absent de cette installation');
    }

    if (JSDOM) {
        const dom = new JSDOM('<!doctype html><html><body></body></html>',
            { runScripts: 'outside-only', url: 'http://localhost:3000/' });
        const win = dom.window;
        win.MusicPlayer = {};
        // Le module dessine sur un canevas au chargement : jsdom n'en a pas,
        // et ce n'est pas ce qu'on éprouve ici.
        win.HTMLCanvasElement.prototype.getContext = () => null;
        win.eval(VIDEO);
        const referenceMs = win.eval('referenceMs');
        const state = { progress: { currentMs: 10000 } };

        win.MusicPlayer.heardPositionMs = () => 13000;
        check('la position entendue l\'emporte sur celle du serveur', referenceMs(state) === 13000,
            `${referenceMs(state)} ms`);

        win.MusicPlayer.heardPositionMs = () => null;
        check('à défaut, le serveur fait foi', referenceMs(state) === 10000, `${referenceMs(state)} ms`);

        delete win.MusicPlayer.heardPositionMs;
        check('  … et sans app.js non plus', referenceMs(state) === 10000);
        check('  … et sans position du tout, zéro', referenceMs({}) === 0);
        win.close();
    }

    // ───────── Le flux mémoire ─────────

    console.log('\nUne socket engorgée n\'est pas encombrée davantage\n');

    /*
     * Dans un bac à sable, et avant tout `require`.
     *
     * Charger WebServer configure le logger sur `data/logs` du répertoire
     * courant : il y écrase `latest.log` et applique la rétention. Lancé depuis
     * le projet, le test tronquait donc le journal du bot en cours d'exécution
     * et supprimait ses plus anciens. Database et le carnet des invités lisent
     * eux aussi `data/` au chargement.
     */
    const os = require('os');
    const CWD = process.cwd();
    const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'guest-feeds-'));
    process.chdir(SANDBOX);

    const log = require(path.join(ROOT, 'src', 'utils', 'logger'));
    const warnings = [];
    const originalWarn = log.warn;
    log.warn = (message) => warnings.push(String(message));

    // Le module exporte une instance : ses méthodes s'éprouvent sur un serveur
    // de fortune, sans port ni client Discord.
    const webServer = require(path.join(ROOT, 'src', 'web', 'WebServer'));
    const proto = Object.getPrototypeOf(webServer);

    const sent = { healthy: 0, jammed: 0 };
    const healthy = { readyState: 1, bufferedAmount: 0, identity: { master: true }, send: () => sent.healthy++ };
    const jammed = {
        readyState: 1,
        bufferedAmount: 40 * 1024,
        identity: { master: false, session: { userId: 'U1' } },
        send: () => sent.jammed++,
    };
    const fake = {
        _memorySubscribers: new Set([healthy, jammed]),
        _stopMemoryStreamIfIdle: proto._stopMemoryStreamIfIdle,
    };

    proto._startMemoryStream.call(fake);
    await new Promise((resolve) => setTimeout(resolve, 600));
    clearInterval(fake._memorySampleTimer);
    clearInterval(fake._memorySendTimer);
    log.warn = originalWarn;

    check('la socket saine reçoit ses lots', sent.healthy >= 5, `${sent.healthy} lot(s)`);
    check('la socket engorgée n\'en reçoit aucun', sent.jammed === 0, `${sent.jammed} lot(s)`);
    const backlog = warnings.filter((w) => w.includes('Memory feed held back'));
    check('le fait est dit, une fois et pas à chaque lot', backlog.length === 1,
        `${backlog.length} avertissement(s)`);
    check('  … en nommant l\'invité', backlog.length === 1 && backlog[0].includes('guest U1'));

    process.chdir(CWD);
    try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) {}

    // ───────── Le tiroir ─────────

    console.log('\nLe tiroir dit ce qu\'il reçoit\n');

    const DRAWER = read('js', 'drawer.js');
    check('la mesure est rapportée par clientLog, sous « Drawer »',
        /type: 'clientLog'[\s\S]{0,80}source: 'Drawer'/.test(DRAWER));
    check('  … jamais depuis un onglet caché',
        /document\.visibilityState === 'visible'\s*&& \(maxGap > RECEPTION_GAP_ALERT_MS/.test(DRAWER));
    check('  … et pas plus d\'une fois par fenêtre de rapport',
        /now - reception\.lastReport > RECEPTION_REPORT_EVERY_MS/.test(DRAWER));

    console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
