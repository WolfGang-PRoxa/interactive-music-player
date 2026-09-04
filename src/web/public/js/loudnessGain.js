/**
 * Gain de niveau sonore appliqué au lecteur du navigateur.
 *
 * ## Le problème
 *
 * En diffusion commune, le gain de sonie vit dans le bus de mixage du bot.
 * En diffusion personnelle, le son ne passe plus par lui : le navigateur lit le
 * fichier directement, et c'est donc à lui d'appliquer la correction — sinon un
 * même morceau s'entendrait à deux niveaux différents selon le mode.
 *
 * Le volume d'un `<audio>` est écrit depuis une quinzaine d'endroits du tableau
 * de bord : le ducking client, les fondus d'enchaînement, l'extinction, la
 * restauration après reprise. Multiplier le gain à chacun de ces endroits, c'est
 * quinze occasions de l'oublier, et une correction qui saute au premier fondu.
 *
 * ## L'approche
 *
 * La propriété `volume` de l'élément est enveloppée, une fois. Ce que le reste
 * du code écrit reste ce qu'il relit — le volume *voulu*, celui des rampes de
 * fondu — et c'est l'enveloppe qui pose le produit sur l'élément réel. Aucun
 * appelant n'a à connaître ce gain, et aucun ne peut l'écraser.
 *
 * Chaque élément porte le sien : pendant un enchaînement, les deux morceaux
 * superposés n'ont aucune raison d'être corrigés pareil. Le gain est déduit de
 * l'adresse que l'élément est en train de lire, qui porte l'URL de la piste :
 * c'est la seule source qui ne se désynchronise jamais de ce qu'on entend.
 *
 * ## Sa limite
 *
 * Un `<audio>` ne dépasse pas le volume 1. Une atténuation est donc exacte,
 * mais une amplification n'a que la marge que laisse le curseur de volume :
 * +6 dB demandés à 70 % n'en donnent que 3. Lever cette borne supposerait de
 * router l'élément par l'API Web Audio, ce qui, sur iOS, coupe la lecture dès
 * que l'onglet passe en arrière-plan — cher payé pour quelques décibels.
 */

window.MusicPlayer = window.MusicPlayer || {};

(function () {
    'use strict';

    /** Éléments dont la propriété `volume` a été enveloppée. */
    const attached = new Set();

    /**
     * Descripteur natif de `volume`, seul chemin vers le vrai réglage.
     *
     * Lu sur le prototype avant toute enveloppe : c'est lui que l'enveloppe
     * appellera pour poser la valeur corrigée, une fois qu'elle aura pris la
     * place de la propriété sur l'élément.
     */
    const nativeVolume = window.HTMLMediaElement
        ? Object.getOwnPropertyDescriptor(window.HTMLMediaElement.prototype, 'volume')
        : null;

    function clamp01(value) {
        const number = Number(value);
        if (!Number.isFinite(number)) return 0;
        return Math.min(1, Math.max(0, number));
    }

    /**
     * Enveloppe la propriété `volume` d'un élément audio.
     *
     * Sans effet si l'élément est déjà enveloppé, ou si le navigateur ne laisse
     * pas redéfinir la propriété : le tableau de bord fonctionne alors comme
     * avant, sans correction de niveau.
     *
     * @param {HTMLMediaElement} el
     */
    function attach(el) {
        if (!el || attached.has(el) || !nativeVolume || !nativeVolume.set) return;

        let wanted = clamp01(nativeVolume.get.call(el));
        let gain = 1;

        try {
            Object.defineProperty(el, 'volume', {
                configurable: true,
                enumerable: true,
                get() {
                    return wanted;
                },
                set(value) {
                    wanted = clamp01(value);
                    nativeVolume.set.call(this, clamp01(wanted * gain));
                }
            });
        } catch (e) {
            return;
        }

        // Le gain n'est pas une propriété de plus sur l'élément : il n'a de sens
        // que pour cette enveloppe, et le publier inviterait à l'écrire ailleurs.
        el._setLoudnessGain = (value) => {
            const next = Number.isFinite(value) && value > 0 ? value : 1;
            if (next === gain) return;
            gain = next;
            nativeVolume.set.call(el, clamp01(wanted * gain));
        };

        attached.add(el);
    }

    /**
     * URL de piste que lit un élément.
     *
     * Les adresses servies par le bot portent la piste en paramètre ; tout le
     * reste — le WAV de silence utilisé pour amorcer un élément, une source
     * vide — ne désigne aucune piste.
     *
     * @param {HTMLMediaElement} el
     * @returns {string|null}
     */
    function trackUrlOf(el) {
        const src = el && el.currentSrc ? el.currentSrc : (el && el.src) || '';
        const marker = src.indexOf('trackUrl=');
        if (marker === -1) return null;

        const raw = src.slice(marker + 'trackUrl='.length).split('&')[0];
        try {
            return decodeURIComponent(raw);
        } catch (e) {
            return raw;
        }
    }

    /**
     * Retrouve le gain d'une piste dans l'état reçu du serveur.
     *
     * @param {object} state
     * @param {string} url
     * @returns {number} Gain en décibels, zéro par défaut
     */
    function gainDbFor(state, url) {
        if (!state || !url) return 0;

        const pools = [
            state.currentTrack ? [state.currentTrack] : [],
            state.queue || [],
            state.history || []
        ];
        (state.playlists || []).forEach(p => pools.push(p.tracks || []));

        for (const pool of pools) {
            const found = pool.find(t => t && t.url === url);
            if (found) return (found.loudness && found.loudness.gainDb) || 0;
        }
        return 0;
    }

    /**
     * Repose le gain de chaque élément d'après l'état courant.
     *
     * Appelée à chaque diffusion d'état : c'est ce qui rend le réglage immédiat
     * en diffusion personnelle, sans que le morceau ait à repartir.
     *
     * En diffusion commune, tous les gains retombent à un : le bot a déjà
     * corrigé le son qu'il envoie, et le navigateur ne joue rien.
     *
     * @param {object} state
     */
    window.MusicPlayer.applyLoudnessGains = function (state) {
        const personal = state && state.settings && state.settings.broadcastMode === 'personal';

        attached.forEach((el) => {
            if (!el._setLoudnessGain) return;
            const db = personal ? gainDbFor(state, trackUrlOf(el)) : 0;
            el._setLoudnessGain(Math.pow(10, db / 20));
        });
    };

    window.MusicPlayer.attachLoudnessGain = attach;
})();
