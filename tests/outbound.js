/**
 * Les adresses que le bot accepte d'aller chercher.
 *
 * Une piste porte l'URL que lui a donnée celui qui l'a ajoutée, et le bot la
 * confie à `yt-dlp` puis `ffmpeg` — deux outils qui s'exécutent sur la machine
 * du propriétaire, donc à l'intérieur de son réseau. Un invité pourvu du seul
 * droit d'ajouter à la file faisait ainsi frapper à des portes qu'il
 * n'atteint pas lui-même.
 *
 * Ces cas tiennent les deux bouts : le web public passe, le réseau de la
 * maison est refusé — y compris quand il se cache derrière un nom ou derrière
 * une écriture inhabituelle.
 */

const assert = require('assert');
const outbound = require('../src/utils/outbound');

let passed = 0;
let failed = 0;

function test(name, fn) {
    return Promise.resolve()
        .then(fn)
        .then(() => { console.log(`  ok    ${name}`); passed++; })
        .catch((err) => {
            console.log(`  FAIL  ${name}`);
            console.log(`        ${err.message}`);
            failed++;
        });
}

const refuse = async (url) => {
    const v = await outbound.isFetchable(url);
    assert.strictEqual(v.ok, false, `${url} aurait dû être refusée`);
    return v.reason;
};
const accepte = async (url) => {
    const v = await outbound.isFetchable(url);
    assert.strictEqual(v.ok, true, `${url} aurait dû passer (${v.reason})`);
};

(async () => {
    console.log('\n=== Adresses sortantes ===\n');

    /* ── La boucle locale et le réseau privé ─────────────────────────── */

    await test('la boucle locale est refusée', async () => {
        await refuse('http://127.0.0.1:3000/');
        await refuse('http://localhost/');
        await refuse('http://[::1]/');
    });

    await test('les plages privées sont refusées', async () => {
        await refuse('http://10.0.0.1/');
        await refuse('http://192.168.1.1/admin');
        await refuse('http://172.16.0.1/');
        await refuse('http://172.31.255.255/');
    });

    await test('le lien-local et les métadonnées sont refusés', async () => {
        await refuse('http://169.254.169.254/latest/meta-data/');
    });

    await test('172.32 n\'est pas privée — la plage s\'arrête à 31', async () => {
        // Une borne fausse d'un côté refuserait du trafic légitime, de l'autre
        // laisserait passer le réseau de la maison.
        assert.strictEqual(outbound.isPrivateV4('172.32.0.1'), false);
        assert.strictEqual(outbound.isPrivateV4('172.15.0.1'), false);
        assert.strictEqual(outbound.isPrivateV4('172.16.0.1'), true);
        assert.strictEqual(outbound.isPrivateV4('172.31.0.1'), true);
    });

    /* ── Les écritures détournées ────────────────────────────────────── */

    await test('une IPv4 mappée en IPv6 ne contourne pas le test', async () => {
        // L'écriture pointée, celle qu'on tape…
        assert.strictEqual(outbound.isPrivateV6('::ffff:10.0.0.1'), true);
        assert.strictEqual(outbound.isPrivateV6('::ffff:127.0.0.1'), true);
        // …et l'hexadécimale, celle que l'analyseur d'URL rend.
        assert.strictEqual(outbound.isPrivateV6('::ffff:c0a8:1'), true);   // 192.168.0.1
        assert.strictEqual(outbound.isPrivateV6('::ffff:7f00:1'), true);   // 127.0.0.1
        assert.strictEqual(outbound.isPrivateV6('::ffff:0808:0808'), false); // 8.8.8.8
        await refuse('http://[::ffff:192.168.0.1]/');
        await refuse('http://[::ffff:127.0.0.1]/');
    });

    await test('les adresses uniques locales IPv6 sont refusées', async () => {
        assert.strictEqual(outbound.isPrivateV6('fd00::1'), true);
        assert.strictEqual(outbound.isPrivateV6('fc00::1'), true);
        assert.strictEqual(outbound.isPrivateV6('fe80::1'), true);
    });

    await test('les noms du réseau domestique sont refusés', async () => {
        await refuse('http://nas.local/');
        await refuse('http://routeur.lan/');
        await refuse('http://machine.internal/');
    });

    /* ── Ce qui n'est pas une adresse web ────────────────────────────── */

    await test('les schémas autres que http(s) sont refusés', async () => {
        await refuse('file:///C:/Users/piaur/.env');
        await refuse('ftp://exemple.fr/x');
        await refuse('data:text/plain,bonjour');
    });

    await test('une adresse illisible est refusée', async () => {
        await refuse('pas une url');
        await refuse('');
    });

    /* ── Le web public passe ─────────────────────────────────────────── */

    await test('une adresse publique littérale passe', async () => {
        await accepte('https://8.8.8.8/');
        await accepte('http://1.1.1.1/');
    });

    await test('un nom public passe', async () => {
        // Résolu pour de vrai : c'est tout l'intérêt du garde-fou. Sauté si la
        // machine n'a pas de réseau, pour ne pas rendre la suite dépendante.
        const dns = require('dns').promises;
        try {
            await dns.lookup('example.com');
        } catch (e) {
            console.log('        (réseau absent : cas sauté)');
            return;
        }
        await accepte('https://example.com/chanson.mp3');
    });

    console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
    process.exit(failed > 0 ? 1 : 0);
})();
