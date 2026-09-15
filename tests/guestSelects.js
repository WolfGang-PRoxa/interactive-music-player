/**
 * Vérifie que les menus déroulants refusés à un invité le sont pour de bon.
 *
 * ## Ce qui n'allait pas
 *
 * Le voile des commandes refusées — `.perm-denied`, posé par
 * js/sharedControl.js — visait le `<select>` que désigne sa carte. Or ce
 * `<select>` est masqué : js/customSelect.js insère à côté de lui le menu qu'on
 * voit et qu'on clique. Le voile ne se voyait donc pas, et ne retenait rien,
 * puisque le blocage cherche `.perm-denied` parmi les *ancêtres* de la cible et
 * que le menu visible est un voisin. Un invité sans le moindre droit ouvrait la
 * liste, choisissait, et n'apprenait le refus qu'au retour du serveur.
 *
 * ## Ce que ce test tient
 *
 *  - **Le menu visible porte le voile**, pour chaque menu de la carte des
 *    commandes — et le `<select>` masqué le garde aussi.
 *  - **Le clic n'ouvre rien**, et l'invité est averti.
 *  - **Un droit accordé rend le menu**, et lui seul.
 *  - **Un droit retiré referme une liste ouverte**, sans quoi un dernier choix
 *    passerait encore.
 *
 * Et une garde de feuille de style, pour le déclencheur que Safari peignait en
 * blanc dans la carte « En cours de lecture » : pas de flou d'arrière-plan sur
 * les menus des cartes.
 *
 * `jsdom` n'est pas une dépendance déclarée du projet : il arrive avec
 * `discord-player-youtubei`. La partie DOM se retire donc d'elle-même s'il n'est
 * pas là, comme dans tests/rangeFocus.js.
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

/** Les menus que la carte des commandes désigne, avec le droit dont ils relèvent. */
const MENUS = {
    'playback-source-select': 'playback.source',
    'download-format-select': 'queue.download',
    'add-target-select': 'queue.add',
    'import-audio-quality-select': 'volume.quality',
    'import-video-quality-select': 'volume.quality',
    'broadcast-mode-select': 'volume.broadcast',
    'guild-select': 'volume.channel',
};

async function main() {
    console.log('\n=== Les menus déroulants refusés à un invité ===\n');

    const SHARED = read('js', 'sharedControl.js');
    for (const [id, right] of Object.entries(MENUS)) {
        check(`#${id} figure dans la carte des commandes, sous « ${right} »`,
            new RegExp(`'${right.replace('.', '\\.')}':\\s*\\[[^\\]]*'#${id}'`).test(SHARED));
    }

    let JSDOM;
    try {
        ({ JSDOM } = require('jsdom'));
    } catch (e) {
        JSDOM = null;
        console.log('  passé — jsdom absent de cette installation');
    }

    if (JSDOM) {
        const markup = '<!doctype html><html><body>'
            + Object.keys(MENUS).map((id) =>
                `<select id="${id}"><option value="a" selected>A</option><option value="b">B</option></select>`)
                .join('')
            + '</body></html>';
        const dom = new JSDOM(markup, { runScripts: 'outside-only', url: 'http://localhost:3000/' });
        const win = dom.window;
        const toasts = [];

        win.eval(read('js', 'customSelect.js'));
        win.MusicPlayer.showToast = (message) => toasts.push(message);
        win.MusicPlayer.sendWS = () => {};
        win.eval(read('js', 'sharedControl.js'));

        // Le module s'installe à `DOMContentLoaded`, que jsdom émet après la
        // construction : sans cette attente, le blocage des gestes n'est pas
        // encore posé, et le test mesurerait une page à moitié prête.
        if (win.document.readyState !== 'complete') {
            await new Promise((resolve) => win.addEventListener('load', resolve));
        }

        const menus = Object.keys(MENUS).map((id) => {
            const select = win.document.getElementById(id);
            win.eval(`new CustomSelect(document.getElementById('${id}'))`);
            return { id, select, container: select._customSelect.container };
        });

        // Le voile arrive avec l'état : les menus existent déjà, ou pas encore —
        // app.js les construit après le premier passage de sharedControl.js.
        win.MusicPlayer.applyShareState({ role: 'guest', permissions: {} });

        const click = (menu) => menu.container.querySelector('.custom-select-trigger')
            .dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));

        for (const menu of menus) {
            check(`#${menu.id} : le menu visible est voilé`,
                menu.container.classList.contains('perm-denied'));
            check('  … le <select> masqué aussi', menu.select.classList.contains('perm-denied'));
            click(menu);
            check('  … et le clic ne l\'ouvre pas', !menu.container.classList.contains('open'));
        }
        check('chaque clic refusé avertit l\'invité', toasts.length === menus.length,
            `${toasts.length} avertissement(s) pour ${menus.length} clics`);

        const source = menus.find((m) => m.id === 'playback-source-select');
        const broadcast = menus.find((m) => m.id === 'broadcast-mode-select');

        win.MusicPlayer.applyShareState({ role: 'guest', permissions: { 'playback.source': true } });
        check('un droit accordé lève le voile de son menu',
            !source.container.classList.contains('perm-denied'));
        click(source);
        check('  … qui s\'ouvre de nouveau', source.container.classList.contains('open'));
        check('  … et celui-là seul', broadcast.container.classList.contains('perm-denied'));

        win.MusicPlayer.applyShareState({ role: 'guest', permissions: {} });
        check('un droit retiré referme la liste restée ouverte',
            !source.container.classList.contains('open')
            && source.container.classList.contains('perm-denied'));

        win.MusicPlayer.applyShareState({ role: 'master' });
        check('le maître retrouve tous ses menus',
            menus.every((m) => !m.container.classList.contains('perm-denied')));

        win.close();
    }

    // ───────── La feuille de style ─────────

    const CSS = read('css', 'modals.css');
    check('les menus des cartes n\'ont pas de flou d\'arrière-plan',
        /\.card \.custom-select-trigger \{[^}]*backdrop-filter: none;[^}]*-webkit-backdrop-filter: none;/.test(CSS),
        'Safari peignait le déclencheur en blanc dans « En cours de lecture »');
    check('un menu voilé ne s\'éclaire pas au survol',
        /\.perm-denied \.custom-select-trigger:hover \{[^}]*cursor: not-allowed/.test(CSS)
        || /\.perm-denied \.custom-select-trigger,\s*\.perm-denied \.custom-select-trigger:hover \{[^}]*cursor: not-allowed/.test(CSS));

    console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
