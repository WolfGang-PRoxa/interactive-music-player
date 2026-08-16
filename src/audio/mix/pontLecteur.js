/**
 * Pont entre le lecteur de discord-player et le bus de mixage.
 *
 * ## Le problème
 *
 * Le bot appelle `queue.node.play()`, `setVolume()`, `seek()` depuis une
 * centaine d'endroits — commandes, gestionnaires WebSocket, restauration
 * d'état, gestion de présence. Faire passer la diffusion par le bus de mixage
 * en réécrivant tous ces appels serait long, risqué, et rendrait chaque site
 * d'appel responsable de savoir quel chemin audio est en vigueur.
 *
 * ## L'approche
 *
 * Les méthodes concernées sont enveloppées sur le prototype de
 * `GuildQueuePlayerNode`. Chacune commence par demander s'il existe un bus pour
 * cette file : si oui, elle s'adresse à lui ; sinon, elle appelle l'implémentation
 * d'origine. Les appelants sont inchangés, et le repli sur discord-player reste
 * entier — en diffusion personnelle, ou si le bus n'a pas pu se monter.
 *
 * C'est le même procédé que celui qui installe l'état de lecture sur
 * `GuildQueue.prototype` (cf. PlaybackSession) : passer par le prototype couvre
 * toutes les files, y compris celles que discord-player instancie lui-même.
 */

const { GuildQueue, GuildQueuePlayerNode, GuildQueueEvent, TrackSkipReason } = require('discord-player');

const { assurerMoteur, moteurActif } = require('./index');
const { formatMs } = require('../../utils/duration');
const log = require('../../utils/logger');

/**
 * Durée annoncée d'une piste, en millisecondes.
 * @param {object} piste
 * @returns {number}
 */
function dureeAnnonceeMs(piste) {
    if (!piste) return 0;
    if (piste.durationMS) return piste.durationMS;
    if (typeof piste.duration === 'string') {
        const parts = piste.duration.split(':').map(Number);
        if (parts.some(isNaN)) return 0;
        if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
        if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
    }
    return 0;
}

/**
 * Remplace une méthode du prototype par une version qui interroge d'abord le bus.
 *
 * @param {object} prototype
 * @param {string} nom
 * @param {(original: Function) => Function} fabrique
 */
function envelopper(prototype, nom, fabrique) {
    const original = prototype[nom];
    if (typeof original !== 'function') {
        log.warn(`[MixPont] Méthode « ${nom} » absente : le pont ne peut pas s'y greffer.`);
        return;
    }
    Object.defineProperty(prototype, nom, {
        value: fabrique(original),
        writable: true,
        configurable: true,
        enumerable: false,
    });
}

/**
 * Installe le pont. Sans effet s'il est déjà en place.
 */
function installerPont() {
    if (GuildQueuePlayerNode.prototype.__pontMixInstalle) return;

    const proto = GuildQueuePlayerNode.prototype;

    // ─── Lecture ──────────────────────────────────────────────────────────

    /**
     * Toute mise en lecture passe par ici, y compris celle que discord-player
     * déclenche lui-même en fin de morceau. C'est ce qui permet au moteur de
     * reconnaître le titre qu'il a déjà mis en route pour le fondu enchaîné et
     * de le promouvoir au lieu de le relancer.
     */
    envelopper(proto, 'play', (original) => async function play(res, options) {
        const moteur = assurerMoteur(this.queue);
        if (!moteur) return original.call(this, res, options);

        const opts = Object.assign({}, {
            queue: this.queue.currentTrack != null,
            transitionMode: false,
            seek: 0,
        }, options);

        // Même sémantique que l'implémentation d'origine : une piste fournie
        // alors qu'un morceau joue déjà part en file d'attente.
        if (res && opts.queue) return this.queue.addTrack(res);

        const piste = res || this.queue.tracks.dispatch();
        if (!piste) {
            this.queue.emit(GuildQueueEvent.Error, this.queue,
                new Error('Demande de lecture reçue sans piste à jouer.'));
            return;
        }

        this.queue.setTransitioning(!!opts.transitionMode);
        await moteur.jouer(piste, { seek: typeof opts.seek === 'number' ? opts.seek : 0 });
    });

    envelopper(proto, 'skip', (original) => function skip(options) {
        const moteur = moteurActif(this.queue);
        if (!moteur) return original.call(this, options);

        const piste = this.queue.currentTrack;
        if (!piste) return false;

        this.queue.setTransitioning(false);
        moteur.passer();

        const { reason, description } = options || {
            reason: TrackSkipReason.Manual,
            description: 'The track was skipped manually',
        };
        this.queue.emit(GuildQueueEvent.PlayerSkip, this.queue, piste, reason, description);
        return true;
    });

    /**
     * `stop()` s'en remettait à la fin de la ressource de discord-player pour
     * faire taire le son. Celle du bus est permanente : il faut lui retirer ses
     * sources, sans quoi la musique continuerait après un arrêt demandé.
     */
    envelopper(proto, 'stop', (original) => function stop(force = false) {
        const moteur = moteurActif(this.queue);
        if (!moteur) return original.call(this, force);

        this.queue.tracks.clear();
        this.queue.history.clear();
        moteur.taire();

        if (force) {
            this.queue.dispatcher?.destroy();
            return true;
        }
        if (this.queue.options.leaveOnStop) {
            const minuteur = setTimeout(() => {
                if (this.queue.tracks.size) return clearTimeout(minuteur);
                this.queue.dispatcher?.destroy();
            }, this.queue.options.leaveOnStopCooldown).unref();
        }
        return true;
    });

    envelopper(proto, 'seek', (original) => async function seek(duration) {
        const moteur = moteurActif(this.queue);
        if (!moteur) return original.call(this, duration);

        const piste = this.queue.currentTrack;
        if (!piste) return false;

        const total = dureeAnnonceeMs(piste);
        if (total && duration > total) {
            return this.skip({
                reason: TrackSkipReason.SEEK_OVER_THRESHOLD,
                description: `Position demandée (${duration}ms) au-delà de la durée du morceau.`,
            });
        }

        const cible = Math.max(0, duration);
        const avant = moteur.positionMs();
        const abouti = await moteur.repositionner(cible);

        if (abouti) {
            this.queue.emit(GuildQueueEvent.PlayerSeek, this.queue, {
                currentPosition: avant,
                seekTarget: cible,
                totalDuration: total,
            });
        }
        return abouti;
    });

    // ─── Volume ───────────────────────────────────────────────────────────

    envelopper(proto, 'setVolume', (original) => function setVolume(vol) {
        const moteur = moteurActif(this.queue);
        if (!moteur) return original.call(this, vol);

        const abouti = moteur.definirVolume(vol);
        if (abouti) this.queue.filters._lastFiltersCache.volume = vol;
        return abouti;
    });

    const descripteurVolume = Object.getOwnPropertyDescriptor(proto, 'volume');
    if (descripteurVolume?.get) {
        const lireOriginal = descripteurVolume.get;
        Object.defineProperty(proto, 'volume', {
            get() {
                const moteur = moteurActif(this.queue);
                return moteur ? moteur.volume : lireOriginal.call(this);
            },
            configurable: true,
            enumerable: false,
        });
    }

    // ─── Pause et état ────────────────────────────────────────────────────

    // `pause()` et `resume()` délèguent à `setPaused()` : les envelopper toutes
    // les trois ferait passer deux fois par le pont.
    envelopper(proto, 'setPaused', (original) => function setPaused(state) {
        const moteur = moteurActif(this.queue);
        if (!moteur) return original.call(this, state);
        return moteur.definirPause(!!state);
    });

    envelopper(proto, 'isPlaying', (original) => function isPlaying() {
        const moteur = moteurActif(this.queue);
        if (!moteur) return original.call(this);
        return moteur.enLecture();
    });

    envelopper(proto, 'isPaused', (original) => function isPaused() {
        const moteur = moteurActif(this.queue);
        if (!moteur) return original.call(this);
        return moteur.enPause();
    });

    envelopper(proto, 'isIdle', (original) => function isIdle() {
        const moteur = moteurActif(this.queue);
        if (!moteur) return original.call(this);
        return !this.queue.currentTrack;
    });

    envelopper(proto, 'isBuffering', (original) => function isBuffering() {
        const moteur = moteurActif(this.queue);
        if (!moteur) return original.call(this);
        return false;
    });

    // ─── Position ─────────────────────────────────────────────────────────

    /**
     * La position est désormais comptée en échantillons rendus au lecteur, et
     * non plus estimée. La forme du résultat est inchangée : le tableau de bord
     * et les commandes la lisent telle quelle.
     */
    envelopper(proto, 'getTimestamp', (original) => function getTimestamp(ignoreFilters = false) {
        const moteur = moteurActif(this.queue);
        if (!moteur) return original.call(this, ignoreFilters);

        const piste = this.queue.currentTrack;
        if (!piste) return null;

        const multiplicateur = this.getDurationMultiplier?.() || 1;
        const courant = moteur.positionMs();
        const brut = dureeAnnonceeMs(piste);
        const total = ignoreFilters ? brut : Math.round(brut / multiplicateur);

        return {
            current: { label: formatMs(courant), value: courant },
            total: { label: formatMs(total), value: total },
            progress: total > 0 ? Math.round((courant / total) * 100) : 0,
        };
    });

    /**
     * Multiplicateur de durée : la vitesse est appliquée par le décodeur du bus
     * et non plus par un filtre FFmpeg de la chaîne de discord-player, que
     * l'implémentation d'origine inspectait.
     */
    envelopper(proto, 'getDurationMultiplier', (original) => function getDurationMultiplier() {
        const moteur = moteurActif(this.queue);
        if (!moteur) return original.call(this);
        return moteur.vitesse;
    });

    // ─── File ─────────────────────────────────────────────────────────────

    /**
     * `queue.isPlaying()` répond « un morceau occupe le lecteur », pause
     * comprise — c'est ainsi que les appelants s'en servent pour décider s'il
     * faut démarrer la file.
     */
    envelopper(GuildQueue.prototype, 'isPlaying', (original) => function isPlaying() {
        const moteur = moteurActif(this);
        if (!moteur) return original.call(this);
        return this.currentTrack != null;
    });

    Object.defineProperty(proto, '__pontMixInstalle', {
        value: true,
        enumerable: false,
    });

    log.info('[MixPont] Le lecteur est branché sur le bus de mixage.');
}

module.exports = { installerPont };
