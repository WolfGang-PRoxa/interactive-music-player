/**
 * outputLevel — La sonie du fichier en cours, et le gain qu'on lui applique.
 *
 * ## Le problème
 *
 * Le curseur de volume ne dit rien du morceau. Deux fichiers lus au même
 * réglage ne s'entendent pas au même niveau : un master moderne sort autour de
 * −7 LUFS, un enregistrement classique autour de −25. Quinze décibels d'écart,
 * invisibles jusqu'ici, alors que ce sont eux qui font tendre la main vers le
 * curseur à chaque changement de titre.
 *
 * ## L'approche
 *
 * Deux valeurs à droite du libellé, et non près du curseur : celui-ci se règle,
 * celles-ci se constatent. Les mêler laisserait croire qu'on peut agir dessus.
 *
 *  - **La mesure**, en LUFS : la sonie perçue du fichier tel qu'il est, relevée
 *    une fois pour toutes par l'analyse (cf. LoudnessAnalyzer).
 *  - **Le gain**, en dB : ce que le réglage de sonie ajoute ou retire par-dessus.
 *
 * Les deux unités sont volontairement distinctes. Côte à côte, deux nombres en
 * décibels se liraient comme une seule valeur coupée en deux, alors que l'une
 * décrit le fichier et l'autre ce qu'on lui fait.
 *
 * ## Pourquoi rien ne bat la mesure ici
 *
 * Ces deux nombres sont des propriétés de la piste : ils ne bougent qu'au
 * changement de titre ou sur un geste de l'utilisateur. L'état les porte déjà,
 * une fois par seconde — les redemander plus vite reviendrait à rafraîchir dix
 * fois par seconde une valeur qui tient plusieurs minutes.
 *
 * Ils arrivent donc avec l'état, ce qui a un mérite qu'un flux séparé n'aurait
 * pas eu : la mesure change au même instant que le titre affiché au-dessus,
 * jamais une fraction de seconde avant ou après.
 *
 * ## Ce qui n'est pas encore connu
 *
 * Une piste fraîchement ajoutée n'est pas mesurée d'emblée. Plutôt que de faire
 * apparaître un nombre de nulle part une fois l'analyse finie, l'attente se
 * montre — et se montre sans mot, l'interface étant traduite.
 */

window.MusicPlayer = window.MusicPlayer || {};

(function () {
    'use strict';

    const box = document.getElementById('output-level');
    const dbEl = document.getElementById('output-level-db');
    const gainEl = document.getElementById('output-level-gain');
    if (!box || !dbEl || !gainEl) return;

    /** « −14.2 LUFS », avec le vrai signe moins. */
    function formatLufs(value) {
        return `${value.toFixed(1).replace('-', '−')} LUFS`;
    }

    /** « +3.2 dB » ou « −1.5 dB » ; rien du tout quand le gain est nul. */
    function formatGain(db) {
        if (!Number.isFinite(db) || Math.abs(db) < 0.05) return '';
        return `${db > 0 ? '+' : '−'}${Math.abs(db).toFixed(1)} dB`;
    }

    /**
     * Pochette de repli, quand la piste n'en a pas.
     *
     * Servie par le bot, non chargée depuis un site tiers : le tableau de bord
     * s'utilise en réseau local, et une adresse distante laisserait un trou à
     * la première coupure d'accès.
     */
    const FALLBACK_ART = 'img/itunes-fallback.png';

    /**
     * Ce que l'état dit de la piste en cours.
     *
     * Le même objet dans les deux modes de diffusion : la sonie est une
     * propriété du fichier, elle ne dépend pas de l'endroit d'où sort le son.
     *
     * @param {object|null} track
     * @returns {{ status: string, measured: number|null, gainDb: number }|null}
     */
    function reading(track) {
        const loudness = track && track.loudness;
        if (!loudness) return null;

        return {
            status: loudness.status || 'unavailable',
            measured: Number.isFinite(loudness.measured) ? loudness.measured : null,
            gainDb: Number.isFinite(loudness.gainDb) ? loudness.gainDb : 0,
        };
    }

    /**
     * Donne aux deux infobulles de quoi se situer.
     *
     * Les deux la portent, et c'est voulu : chacune ne commente qu'un nombre, et
     * un nombre ne dit rien tant qu'on ignore de quel morceau il parle. Le
     * survol de l'un ou de l'autre doit y répondre sans qu'il faille aller
     * chercher le titre ailleurs dans la page.
     *
     * @param {object|null} track
     */
    function describe(track) {
        const title = (track && track.title) || '';
        const art = (track && track.thumbnail) || FALLBACK_ART;

        for (const el of [dbEl, gainEl]) {
            el.setAttribute('data-tooltip-image', art);
            // Une vignette distante peut avoir disparu depuis qu'on en a reçu
            // l'adresse ; le repli reprend alors la main.
            el.setAttribute('data-tooltip-image-fallback', FALLBACK_ART);
            if (title) el.setAttribute('data-tooltip-title', title);
            else el.removeAttribute('data-tooltip-title');
        }
    }

    function paint() {
        const state = window.MusicPlayer.state;
        const track = (state && state.currentTrack) || null;
        const now = reading(track);

        // Rien en lecture, ou un fichier que l'analyse ne peut pas atteindre :
        // il n'y a pas de valeur à taire, il n'y en a pas.
        if (!now || (now.measured === null && now.status !== 'analyzing')) {
            box.hidden = true;
            return;
        }

        box.hidden = false;
        describe(track);

        if (now.measured === null) {
            // L'analyse tourne. Sans ce point d'attente, le nombre surgirait de
            // nulle part quelques secondes après le début du morceau.
            if (dbEl.textContent !== '…') dbEl.textContent = '…';
            dbEl.classList.add('is-pending');
            gainEl.textContent = '';
            gainEl.classList.add('hidden');
            return;
        }

        dbEl.classList.remove('is-pending');
        const measured = formatLufs(now.measured);
        if (dbEl.textContent !== measured) dbEl.textContent = measured;

        const gain = formatGain(now.gainDb);
        if (gainEl.textContent !== gain) gainEl.textContent = gain;
        gainEl.classList.toggle('hidden', gain === '');
        gainEl.classList.toggle('is-boost', now.gainDb > 0);
    }

    /** Appelé à chaque état reçu : c'est lui qui porte les deux valeurs. */
    window.MusicPlayer.refreshOutputLevel = paint;

    paint();
})();
