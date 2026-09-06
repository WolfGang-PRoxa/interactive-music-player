/**
 * Vérifie que le silence du navigateur s'explique, et qu'un clic le lève.
 *
 * En diffusion personnelle, presque tous les `play()` partent d'un message du
 * serveur, jamais d'un appui. Le navigateur les refuse tant qu'aucun geste n'a
 * porté sur la page — `NotAllowedError` — et sa décision est prise avant que le
 * tableau de bord n'ait son mot à dire.
 *
 * Le mécanisme de rattrapage existait déjà et fonctionne : au premier geste,
 * `unlockAudio` obtient l'autorisation et relance l'élément. Ce qui manquait
 * était de le dire. La page écrivait le refus dans la console et l'envoyait au
 * serveur, laissant devant l'écran un silence que rien n'expliquait, et dont le
 * remède — un clic, n'importe où — était indevinable.
 *
 * Quatre choses sont vérifiées ici.
 *
 *  - **Ce refus-là seul se dit à l'écran.** `AbortError` est le refus ordinaire
 *    d'un enchaînement un peu vif ; l'annoncer serait du bruit.
 *
 *  - **Il se dit dans la durée, et se retire seul.** La condition tient tant
 *    qu'aucun geste n'a porté sur la page : une notification qui s'efface au
 *    bout de quatre secondes laisserait ensuite le même silence inexpliqué.
 *    D'où une note posée près de la barre de progression, qui disparaît à
 *    l'instant où le son est acquis — et pas avant, ni après.
 *
 *  - **Les quatre langues le disent.** Une clé absente d'un fichier laisse la
 *    notification vide dans cette langue — donc muette là où elle importe le
 *    plus.
 *
 *  - **Le fragment de silence est lisible.** C'est lui qui achète
 *    l'autorisation. Un en-tête annonçant un bloc de données vide avait déjà
 *    fait échouer tout le déverrouillage, et le défaut ne se voit pas à la
 *    lecture : il se décode.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'app.js'), 'utf8');
const LOCALES = path.join(ROOT, 'src', 'web', 'public', 'locales');

let failed = 0;
let passed = 0;
const check = (label, ok, detail = '') => {
    if (ok) { passed++; console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`); }
    else { failed++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
};

console.log('\n=== Le son qui attend un geste ===\n');

// ───────────────────── Ce qui se dit, et ce qui se tait ─────────────────────

console.log('Ce que la page annonce, et ce qu\'elle garde pour elle\n');

{
    // La branche qui traite un échec de lecture, prise vers l'avant depuis son
    // premier mot : c'est là que se décide ce qui parvient à l'utilisateur.
    // « ECHEC LECTURE » aurait fait une borne trompeuse — un fondu manqué porte
    // déjà ce mot, mille lignes plus haut.
    const start = APP.indexOf('[Audio] Playback blocked');
    const branch = start >= 0 ? APP.slice(start, start + 1200) : '';

    check('un refus faute de geste se dit à l\'écran',
        /NotAllowedError'\)?\s*\)?\s*\{?\s*[\s\S]{0,80}announceBlockedPlayback\(\)/.test(branch),
        'son remède tient dans un clic, et rien ne le laissait deviner');

    // `AbortError` arrive à chaque enchaînement un peu vif : la lecture demandée
    // a simplement été supplantée par le chargement de la suivante.
    const abortIndex = branch.indexOf('AbortError');
    const announceIndex = branch.indexOf('announceBlockedPlayback');
    check('  … mais pas l\'abandon ordinaire d\'un enchaînement',
        abortIndex >= 0 && announceIndex > abortIndex
        && /AbortError'\) return;/.test(branch),
        'il repart avant, sans rien annoncer');

    check('le refus continue d\'être remonté au serveur',
        APP.includes('ECHEC LECTURE'),
        'seul indice depuis un téléphone, où la console est hors de portée');
}

{
    const fn = APP.slice(APP.indexOf('function announceBlockedPlayback'),
        APP.indexOf('function announceBlockedPlayback') + 400);

    check('l\'annonce ne se relève pas deux fois',
        /if \(playbackBlocked \|\| audioUnlocked\) return;/.test(fn),
        'on repasse ici une fois par seconde tant que le blocage dure');

    // Elle dure autant que la condition : c'est tout l'intérêt d'une note
    // plutôt que d'une notification, et elle doit donc savoir se retirer.
    check('  … et se retire dès que le son est acquis',
        (APP.match(/clearBlockedPlayback\(\);/g) || []).length === 2,
        'les deux issues du déverrouillage la lèvent');

    check('elle propose le geste qu\'elle attend',
        /btn-resume-blocked/.test(APP)
        && /resumeBlockedBtn\.addEventListener\('click', unlockAudio\)/.test(APP));

    // Une notification qui passe laisserait ensuite le silence inexpliqué.
    check('  … sans passer par une notification fugace',
        !/toast_audio_blocked|toast_action_resume_audio/.test(APP),
        'la condition dure plus longtemps qu\'un toast');

    // Le bouton n'est qu'une commodité : l'écouteur de déverrouillage capte
    // tous les gestes, et sans `once`, chacun est une nouvelle occasion.
    check('n\'importe quel geste ferait l\'affaire',
        /UNLOCK_GESTURES = \['pointerdown', 'touchstart', 'keydown'\]/.test(APP)
        && /document\.addEventListener\(evt, unlockAudio, \{ capture: true \}\)/.test(APP)
        && !/unlockAudio, \{ once: true/.test(APP));
}

// ───────────────────── Les quatre langues ─────────────────────

console.log('\nCe que les quatre langues en disent\n');

{
    const keys = ['playback_blocked_body', 'playback_blocked_action'];
    const langs = ['fr', 'en', 'es', 'de'];

    for (const lang of langs) {
        let parsed = null;
        let error = '';
        try {
            parsed = JSON.parse(fs.readFileSync(path.join(LOCALES, `${lang}.json`), 'utf8'));
        } catch (e) {
            error = e.message;
        }

        check(`${lang}.json reste lisible`, parsed !== null, error);
        if (!parsed) continue;

        const missing = keys.filter(k => typeof parsed[k] !== 'string' || !parsed[k].trim());
        check(`  … et porte de quoi expliquer le silence`, missing.length === 0,
            missing.length ? `manque : ${missing.join(', ')}`
                : parsed.playback_blocked_action);

        // Les clés du toast d'avant n'ont plus d'appelant : les laisser ferait
        // croire, au prochain passage, qu'un message existe quelque part.
        check(`  … et plus celles du message d'avant`,
            parsed.toast_audio_blocked === undefined
            && parsed.toast_action_resume_audio === undefined);
    }
}

{
    const MARKUP = fs.readFileSync(
        path.join(ROOT, 'src', 'web', 'public', 'index.html'), 'utf8');

    const zone = MARKUP.slice(MARKUP.indexOf('<div class="progress-container">'),
        MARKUP.indexOf('id="progress-bar-wrapper"'));

    // Elle voisine avec la note du salon vide : les deux répondent à la même
    // question — pourquoi rien ne sort alors que l'état se dit en marche.
    check('la note est dans la carte de lecture, près de sa sœur',
        zone.includes('id="playback-blocked-notice"')
        && zone.includes('id="playback-wait-notice"'));

    check('  … masquée tant que rien ne la justifie',
        /class="playback-blocked-notice hidden"/.test(zone));

    check('  … et traduite comme le reste de la page',
        zone.includes('data-i18n="playback_blocked_body"')
        && zone.includes('data-i18n="playback_blocked_action"'));
}

// ───────────────────── Le fragment qui achète l'autorisation ─────────────────

console.log('\nLe fragment de silence, décodé\n');

{
    const match = APP.match(/const SILENCE_WAV = 'data:audio\/wav;base64,'\s*\+\s*'([A-Za-z0-9+/=]+)'/);
    check('le fragment est bien là', !!match);

    if (match) {
        const bytes = Buffer.from(match[1], 'base64');

        check('c\'est un RIFF/WAVE', bytes.slice(0, 4).toString('ascii') === 'RIFF'
            && bytes.slice(8, 12).toString('ascii') === 'WAVE',
            bytes.slice(0, 4).toString('ascii'));

        // La taille annoncée dans l'en-tête doit correspondre à ce qui suit,
        // sans quoi le décodeur s'arrête avant d'avoir lu quoi que ce soit.
        check('la taille annoncée est celle du fichier',
            bytes.readUInt32LE(4) === bytes.length - 8,
            `${bytes.readUInt32LE(4)} annoncés pour ${bytes.length - 8}`);

        const dataAt = bytes.indexOf('data', 12, 'ascii');
        const dataLen = dataAt >= 0 ? bytes.readUInt32LE(dataAt + 4) : 0;

        // Le défaut d'origine : un bloc de données vide, que WebKit refuse de
        // charger. L'autorisation échouait alors sans que rien ne le dise.
        check('le bloc de données n\'est pas vide', dataLen > 0, `${dataLen} octets`);
        check('  … et il tient tout entier dans le fichier',
            dataAt + 8 + dataLen === bytes.length,
            `${bytes.length} octets en tout`);

        const samples = bytes.slice(dataAt + 8);
        const rate = bytes.readUInt32LE(bytes.indexOf('fmt ', 12, 'ascii') + 12);
        check('  … et ne contient que du silence',
            samples.every(b => b === 0x80),
            `${samples.length} échantillons à ${rate} Hz, soit `
            + `${Math.round(samples.length / rate * 1000)} ms`);
    }
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
