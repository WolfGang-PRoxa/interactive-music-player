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

const { ensureEngine, activeEngine } = require('./index');
const { formatMs } = require('../../utils/duration');
const log = require('../../utils/logger');

/**
 * Durée annoncée d'une piste, en millisecondes.
 * @param {object} piste
 * @returns {number}
 */
function announcedDurationMs(track) {
    if (!track) return 0;
    if (track.durationMS) return track.durationMS;
    if (typeof track.duration === 'string') {
        const parts = track.duration.split(':').map(Number);
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
 * @param {string} name
 * @param {(original: Function) => Function} factory
 */
function wrap(prototype, name, factory) {
    const original = prototype[name];
    if (typeof original !== 'function') {
        log.warn(`[MixBridge] Method « ${name} » missing: the bridge cannot graft onto it.`);
        return;
    }
    Object.defineProperty(prototype, name, {
        value: factory(original),
        writable: true,
        configurable: true,
        enumerable: false,
    });
}

/**
 * Installe le pont. Sans effet s'il est déjà en place.
 */
function installBridge() {
    if (GuildQueuePlayerNode.prototype.__mixBridgeInstalled) return;

    const proto = GuildQueuePlayerNode.prototype;

    // ─── Lecture ──────────────────────────────────────────────────────────

    /**
     * Toute mise en lecture passe par ici, y compris celle que discord-player
     * déclenche lui-même en fin de morceau. C'est ce qui permet au moteur de
     * reconnaître le titre qu'il a déjà mis en route pour le fondu enchaîné et
     * de le promouvoir au lieu de le relancer.
     */
    wrap(proto, 'play', (original) => async function play(res, options) {
        const engine = ensureEngine(this.queue);
        if (!engine) return original.call(this, res, options);

        const opts = Object.assign({}, {
            queue: this.queue.currentTrack != null,
            transitionMode: false,
            seek: 0,
        }, options);

        // Même sémantique que l'implémentation d'origine : une piste fournie
        // alors qu'un morceau joue déjà part en file d'attente.
        if (res && opts.queue) return this.queue.addTrack(res);

        const track = res || this.queue.tracks.dispatch();
        if (!track) {
            this.queue.emit(GuildQueueEvent.Error, this.queue,
                new Error('Playback request received with no track to play.'));
            return;
        }

        this.queue.setTransitioning(!!opts.transitionMode);
        await engine.play(track, { seek: typeof opts.seek === 'number' ? opts.seek : 0 });
    });

    wrap(proto, 'skip', (original) => function skip(options) {
        const engine = activeEngine(this.queue);
        if (!engine) return original.call(this, options);

        const track = this.queue.currentTrack;
        if (!track) return false;

        this.queue.setTransitioning(false);
        engine.skip();

        const { reason, description } = options || {
            reason: TrackSkipReason.Manual,
            description: 'The track was skipped manually',
        };
        this.queue.emit(GuildQueueEvent.PlayerSkip, this.queue, track, reason, description);
        return true;
    });

    /**
     * `stop()` s'en remettait à la fin de la ressource de discord-player pour
     * faire taire le son. Celle du bus est permanente : il faut lui retirer ses
     * sources, sans quoi la musique continuerait après un arrêt demandé.
     */
    wrap(proto, 'stop', (original) => function stop(force = false) {
        const engine = activeEngine(this.queue);
        if (!engine) return original.call(this, force);

        this.queue.tracks.clear();
        this.queue.history.clear();
        engine.mute();

        if (force) {
            this.queue.dispatcher?.destroy();
            return true;
        }
        if (this.queue.options.leaveOnStop) {
            const timer = setTimeout(() => {
                if (this.queue.tracks.size) return clearTimeout(timer);
                this.queue.dispatcher?.destroy();
            }, this.queue.options.leaveOnStopCooldown).unref();
        }
        return true;
    });

    wrap(proto, 'seek', (original) => async function seek(duration) {
        const engine = activeEngine(this.queue);
        if (!engine) return original.call(this, duration);

        const track = this.queue.currentTrack;
        if (!track) return false;

        const total = announcedDurationMs(track);
        if (total && duration > total) {
            return this.skip({
                reason: TrackSkipReason.SEEK_OVER_THRESHOLD,
                description: `Requested position (${duration}ms) is past the end of the track.`,
            });
        }

        const target = Math.max(0, duration);
        const before = engine.positionMs();
        const succeeded = await engine.seek(target);

        if (succeeded) {
            this.queue.emit(GuildQueueEvent.PlayerSeek, this.queue, {
                currentPosition: before,
                seekTarget: target,
                totalDuration: total,
            });
        }
        return succeeded;
    });

    // ─── Volume ───────────────────────────────────────────────────────────

    wrap(proto, 'setVolume', (original) => function setVolume(vol) {
        const engine = activeEngine(this.queue);
        if (!engine) return original.call(this, vol);

        const succeeded = engine.setVolume(vol);
        if (succeeded) this.queue.filters._lastFiltersCache.volume = vol;
        return succeeded;
    });

    const volumeDescriptor = Object.getOwnPropertyDescriptor(proto, 'volume');
    if (volumeDescriptor?.get) {
        const readOriginal = volumeDescriptor.get;
        Object.defineProperty(proto, 'volume', {
            get() {
                const engine = activeEngine(this.queue);
                return engine ? engine.volume : readOriginal.call(this);
            },
            configurable: true,
            enumerable: false,
        });
    }

    // ─── Pause et état ────────────────────────────────────────────────────

    // `pause()` et `resume()` délèguent à `setPaused()` : les envelopper toutes
    // les trois ferait passer deux fois par le pont.
    wrap(proto, 'setPaused', (original) => function setPaused(state) {
        const engine = activeEngine(this.queue);
        if (!engine) return original.call(this, state);
        return engine.setPaused(!!state);
    });

    wrap(proto, 'isPlaying', (original) => function isPlaying() {
        const engine = activeEngine(this.queue);
        if (!engine) return original.call(this);
        return engine.playing();
    });

    wrap(proto, 'isPaused', (original) => function isPaused() {
        const engine = activeEngine(this.queue);
        if (!engine) return original.call(this);
        return engine.paused();
    });

    wrap(proto, 'isIdle', (original) => function isIdle() {
        const engine = activeEngine(this.queue);
        if (!engine) return original.call(this);
        return !this.queue.currentTrack;
    });

    wrap(proto, 'isBuffering', (original) => function isBuffering() {
        const engine = activeEngine(this.queue);
        if (!engine) return original.call(this);
        return false;
    });

    // ─── Position ─────────────────────────────────────────────────────────

    /**
     * La position est désormais comptée en échantillons rendus au lecteur, et
     * non plus estimée. La forme du résultat est inchangée : le tableau de bord
     * et les commandes la lisent telle quelle.
     */
    wrap(proto, 'getTimestamp', (original) => function getTimestamp(ignoreFilters = false) {
        const engine = activeEngine(this.queue);
        if (!engine) return original.call(this, ignoreFilters);

        const track = this.queue.currentTrack;
        if (!track) return null;

        const multiplier = this.getDurationMultiplier?.() || 1;
        const current = engine.positionMs();
        const raw = announcedDurationMs(track);
        const total = ignoreFilters ? raw : Math.round(raw / multiplier);

        return {
            current: { label: formatMs(current), value: current },
            total: { label: formatMs(total), value: total },
            progress: total > 0 ? Math.round((current / total) * 100) : 0,
        };
    });

    /**
     * Multiplicateur de durée : la vitesse est appliquée par le décodeur du bus
     * et non plus par un filtre FFmpeg de la chaîne de discord-player, que
     * l'implémentation d'origine inspectait.
     */
    wrap(proto, 'getDurationMultiplier', (original) => function getDurationMultiplier() {
        const engine = activeEngine(this.queue);
        if (!engine) return original.call(this);
        return engine.speed;
    });

    // ─── File ─────────────────────────────────────────────────────────────

    /**
     * `queue.isPlaying()` répond « un morceau occupe le lecteur », pause
     * comprise — c'est ainsi que les appelants s'en servent pour décider s'il
     * faut démarrer la file.
     */
    wrap(GuildQueue.prototype, 'isPlaying', (original) => function isPlaying() {
        const engine = activeEngine(this);
        if (!engine) return original.call(this);
        return this.currentTrack != null;
    });

    Object.defineProperty(proto, '__mixBridgeInstalled', {
        value: true,
        enumerable: false,
    });

    log.info('[MixBridge] The player is wired to the mix bus.');
}

module.exports = { installBridge };
