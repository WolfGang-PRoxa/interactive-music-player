/**
 * Ce qu'un invité lit du journal, et ce qu'il n'en lit pas.
 *
 * Le terminal de logs partait entier vers chaque socket ouverte. Il porte les
 * chemins du disque de l'hôte, son adresse publique et les identifiants des
 * invités : le fermer aux invités réglait la fuite mais vidait la fenêtre. Le
 * filtre de `web/logVisibility.js` garde les lignes qui parlent de la lecture
 * et caviarde ce qui nomme la machine.
 *
 * Ces cas tiennent la règle des deux côtés : ce qui doit passer passe, ce qui
 * ne doit pas est refusé, et une étiquette inconnue est refusée par défaut.
 */

const assert = require('assert');
const vis = require('../src/web/logVisibility');

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  ok    ${name}`);
        passed++;
    } catch (err) {
        console.log(`  FAIL  ${name}`);
        console.log(`        ${err.message}`);
        failed++;
    }
}

const entry = (text, level = 'INFO') => ({ timestamp: '12:00:00', level, text });

console.log('\n=== Visibilité du journal pour un invité ===\n');

/* ── L'étiquette décide du sujet ─────────────────────────────────────── */

test('une ligne de lecture passe', () => {
    const kept = vis.forGuest(entry('[Player] + Added: Dracula'));
    assert.ok(kept, 'la ligne aurait dû être retenue');
    assert.strictEqual(kept.text, '[Player] + Added: Dracula');
});

test('le fondu enchaîné passe', () => {
    assert.ok(vis.forGuest(entry('[MixEngine] Crossfade of 4s: Deja Vu')));
});

test('le ducking passe', () => {
    assert.ok(vis.forGuest(entry('[Ducking] Ducking configured for guild 123')));
});

test('la propriété de l\'installation est refusée', () => {
    assert.strictEqual(vis.forGuest(entry('[Owner] Dashboard claimed by paul (42).')), null);
});

test('l\'admission des invités est refusée', () => {
    assert.strictEqual(vis.forGuest(entry('[Guests] 3 known account(s) loaded.')), null);
});

test('le trajet OAuth est refusé', () => {
    assert.strictEqual(vis.forGuest(entry('[OAuth] Access denied to bob (7).')), null);
});

test('le tunnel est refusé', () => {
    assert.strictEqual(vis.forGuest(entry('[Tunnel] Dashboard published on the internet at https://x.trycloudflare.com')), null);
});

test('le serveur web est refusé', () => {
    assert.strictEqual(vis.forGuest(entry('[WebServer] Dashboard reachable at: https://x')), null);
});

test('le téléchargement est refusé — sa ligne existe pour dire où', () => {
    assert.strictEqual(vis.forGuest(entry('[Download] Dracula written to D:\\Musique')), null);
});

test('une étiquette inconnue est refusée par défaut', () => {
    assert.strictEqual(vis.forGuest(entry('[ModuleFutur] quoi que ce soit')), null);
});

test('une ligne sans étiquette est refusée', () => {
    assert.strictEqual(vis.forGuest(entry('texte nu sans crochets')), null);
});

test('une étiquette composée retient son premier mot', () => {
    assert.strictEqual(vis.tagOf('[WebServer Stream] ...'), 'WebServer');
    assert.strictEqual(vis.tagOf('[Player] ...'), 'Player');
});

/* ── Le caviardage décide du contenu ─────────────────────────────────── */

test('un chemin Windows est caviardé dans une ligne autorisée', () => {
    const kept = vis.forGuest(entry(
        "[MixEngine] Cannot decode: ENOENT, open 'C:\\Users\\piaur\\Music\\a.mp3'"));
    assert.ok(kept, 'la ligne aurait dû être retenue');
    assert.ok(!kept.text.includes('piaur'), `nom d'utilisateur resté : ${kept.text}`);
    assert.ok(kept.text.includes('<chemin>'), `caviardage absent : ${kept.text}`);
});

test('un chemin POSIX nommant quelqu\'un est caviardé', () => {
    const kept = vis.forGuest(entry('[Player] error at /home/romain/bot/src/x.js'));
    assert.ok(!kept.text.includes('romain'), kept.text);
});

test('un chemin UNC est caviardé', () => {
    const kept = vis.forGuest(entry('[Ducking] read \\\\NAS\\musique\\x.flac failed'));
    assert.ok(!kept.text.includes('NAS'), kept.text);
});

test('un jeton est masqué même dans une ligne autorisée', () => {
    const kept = vis.forGuest(entry('[Player] ?token=abcdef0123456789abcdef'));
    assert.ok(!kept.text.includes('abcdef0123456789'), kept.text);
    assert.ok(kept.text.includes('<masqué>'), kept.text);
});

test('un titre de piste ordinaire traverse intact', () => {
    const kept = vis.forGuest(entry('[Player] + Added: AC/DC — Back in Black'));
    assert.strictEqual(kept.text, '[Player] + Added: AC/DC — Back in Black');
});

test('le caviardage ne touche pas l\'horodatage ni le niveau', () => {
    const kept = vis.forGuest(entry('[Player] x', 'WARN'));
    assert.strictEqual(kept.level, 'WARN');
    assert.strictEqual(kept.timestamp, '12:00:00');
});

/* ── Par socket ──────────────────────────────────────────────────────── */

const master = { identity: { master: true } };
const guest = { identity: { master: false, session: { userId: '9' } } };
const orphan = {};

test('le maître reçoit la ligne telle quelle', () => {
    const e = entry('[Owner] claimed by paul');
    assert.strictEqual(vis.forClient(master, e), e);
});

test('l\'invité ne reçoit pas la ligne du maître', () => {
    assert.strictEqual(vis.forClient(guest, entry('[Owner] claimed by paul')), null);
});

test('une socket sans identité est traitée en invité', () => {
    assert.strictEqual(vis.forClient(orphan, entry('[WebServer] secret')), null);
    assert.ok(vis.forClient(orphan, entry('[Player] + Added: x')));
});

test('l\'historique du maître est rendu intact', () => {
    const history = [entry('[Owner] a'), entry('[Player] b')];
    assert.strictEqual(vis.historyForClient(master, history), history);
});

test('l\'historique de l\'invité ne garde que ce qui le regarde', () => {
    const history = [
        entry('[Owner] a'),
        entry('[Player] + Added: b'),
        entry('[WebServer] c'),
        entry('[Ducking] d'),
    ];
    const seen = vis.historyForClient(guest, history);
    assert.strictEqual(seen.length, 2, `attendu 2 lignes, reçu ${seen.length}`);
    assert.ok(seen[0].text.includes('Added'));
    assert.ok(seen[1].text.includes('Ducking'));
});

test('un historique absent ne fait pas tomber le filtre', () => {
    assert.deepStrictEqual(vis.historyForClient(guest, null), []);
    assert.deepStrictEqual(vis.historyForClient(guest, undefined), []);
});

test('une entrée malformée est refusée sans lever', () => {
    assert.strictEqual(vis.forGuest(null), null);
    assert.strictEqual(vis.forGuest({}), null);
    assert.strictEqual(vis.forGuest({ text: 42 }), null);
});

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
