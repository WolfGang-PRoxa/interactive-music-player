/**
 * MixSource — une piste décodée, prête à être versée dans le bus de mixage.
 *
 * ## Le problème
 *
 * Superposer deux morceaux suppose de les avoir tous deux sous une forme
 * additionnable. Or les sources d'origine n'ont ni le même format de conteneur,
 * ni la même fréquence d'échantillonnage, ni le même nombre de canaux : un MP3
 * 44,1 kHz et un flux Opus 48 kHz ne s'additionnent pas.
 *
 * ## L'approche
 *
 * Chaque source ouvre son propre FFmpeg, qui décode et rééchantillonne vers le
 * format unique du bus (cf. `format.js`). Le PCM produit s'accumule dans un
 * tampon, où le bus vient puiser trame par trame. Un décodeur par source, une
 * horloge unique — celle du bus —, donc aucune dérive possible entre deux
 * morceaux qui jouent ensemble : ils avancent du même nombre d'échantillons à
 * chaque tour.
 *
 * Le gain vit ici plutôt que dans le bus, parce qu'il est propre à la source :
 * pendant un fondu enchaîné, le morceau sortant descend tandis que l'entrant
 * monte, sur la même trame. Il est interpolé à l'intérieur de chaque trame,
 * sans quoi un palier de 20 ms tous les 20 ms s'entendrait comme un
 * grésillement — le défaut classique des fondus appliqués par paquets.
 *
 * Le tampon est volontairement généreux : une source peut être ouverte
 * plusieurs secondes avant d'être versée dans le bus, de sorte que le fondu
 * démarre sur du son déjà décodé et non sur l'aléa d'un démarrage de FFmpeg.
 */

const { EventEmitter } = require('events');
const cp = require('child_process');
const ffmpeg = require('ffmpeg-static');

const {
    SAMPLE_RATE,
    CHANNELS,
    BYTES_PER_FRAME,
    BYTES_PER_MS,
    bytesToMs,
} = require('./format');
const { resolveInput, isUrl } = require('./input');
const log = require('../../utils/logger');

/**
 * Son décodé conservé d'avance au maximum, en millisecondes.
 *
 * Assez large pour qu'un accroc réseau passe inaperçu, et pour que la fin du
 * décodage — qui donne le temps restant au millième près, là où la durée
 * annoncée dans les métadonnées se trompe parfois — survienne avant le point de
 * fondu des durées d'enchaînement courantes.
 */
const MAX_BUFFER_MS = 12000;

/** Son décodé exigé avant de considérer la source prête à jouer. */
const PRIMING_BUFFER_MS = 400;

/**
 * Délai au-delà duquel un décodeur muet est déclaré perdu.
 *
 * Sans cette borne, une source réseau qui accepte la connexion puis ne répond
 * plus laisserait la mise en lecture attendre indéfiniment : la file ne
 * repartirait jamais, et rien ne signalerait pourquoi.
 */
const MAX_PRIMING_DELAY_MS = 20000;

/**
 * Trames sur lesquelles s'étale un changement de gain de mise à niveau.
 *
 * Dix trames font 200 ms. Assez court pour que le curseur de LUFS réponde sous
 * le doigt, assez long pour qu'un saut de gain ne s'entende pas comme un clic —
 * ce que produirait, à chaque cran du curseur, une application immédiate.
 */
const LEVEL_SLEW_FRAMES = 10;

/** Fréquence de coupure au plus bas du balayage de filtre, en Hz. */
const LOW_CUTOFF_HZ = 400;

/** Au-delà, le filtre est jugé transparent et n'est plus appliqué. */
const TRANSPARENT_CUTOFF_HZ = 16000;

/**
 * Chaîne `atempo` couvrant une vitesse quelconque.
 *
 * FFmpeg n'accepte le filtre qu'entre 0,5 et 2 ; au-delà, il faut l'enchaîner.
 * C'est la même décomposition que celle des filtres déclarés au démarrage du
 * bot, pour que la vitesse sonne pareil des deux côtés.
 *
 * @param {number} vitesse
 * @returns {string|null}
 */
function tempoChain(speed) {
    const v = Math.round(speed * 100) / 100;
    if (!v || v === 1) return null;
    if (v < 0.5) return `atempo=0.5,atempo=${Math.round((v / 0.5) * 100) / 100}`;
    if (v > 2) return `atempo=2.0,atempo=${Math.round((v / 2) * 100) / 100}`;
    return `atempo=${v}`;
}

/**
 * Coefficient d'un passe-bas à un pôle pour une fréquence de coupure donnée.
 * @param {number} coupureHz
 * @returns {number}
 */
function lowPassCoefficient(cutoffHz) {
    return 1 - Math.exp((-2 * Math.PI * cutoffHz) / SAMPLE_RATE);
}

class MixSource extends EventEmitter {
    /**
     * @param {object} piste - Piste discord-player
     * @param {object} options
     * @param {import('discord-player').Player} options.player
     * @param {number} [options.departMs] - Position de départ dans le morceau
     * @param {number} [options.vitesse] - Multiplicateur de vitesse
     * @param {number} [options.gain] - Gain initial, 0 à 1
     * @param {number} [options.levelGain] - Gain de mise à niveau (LUFS)
     */
    constructor(track, { player, startMs = 0, speed = 1, gain = 1, levelGain = 1 } = {}) {
        super();

        this.track = track;
        this.player = player;
        this.startMs = Math.max(0, startMs || 0);
        this.speed = speed > 0 ? speed : 1;

        /** Morceaux de PCM décodé en attente d'être lus. */
        this._buffer = [];
        this._available = 0;

        /** Octets déjà rendus au bus : c'est ce qui donne la position exacte. */
        this._bytesEmitted = 0;

        this._process = null;
        this._inputStream = null;
        this._streamEnded = false;
        this._exhausted = false;
        this._halted = false;
        this._paused = false;

        // --- Enveloppe de gain ---
        this._gain = gain;
        this._startGain = gain;
        this._targetGain = gain;
        this._fadeFrames = 0;
        this._fadeFrame = 0;
        this._fadeCurve = 'puissance';
        this._onFadeComplete = null;

        /*
         * --- Gain de mise à niveau (LUFS) ---
         *
         * Séparé de l'enveloppe, et pour deux raisons. Il peut dépasser 1,
         * quand l'enveloppe ne le peut pas : monter le niveau d'un morceau
         * discret est précisément ce qu'on lui demande. Et il ne décrit pas le
         * même phénomène : l'enveloppe dit où en est un fondu, celui-ci dit à
         * quel niveau le morceau doit s'entendre — un fondu enchaîné doit
         * pouvoir traverser le second sans effacer le premier.
         */
        this._levelGain = levelGain > 0 ? levelGain : 1;
        this._levelStart = this._levelGain;
        this._levelTarget = this._levelGain;
        this._levelFrames = 0;
        this._levelFrame = 0;

        // --- Balayage de filtre (enchaînement « effets ») ---
        this._filterActive = false;
        this._startCutoff = TRANSPARENT_CUTOFF_HZ;
        this._targetCutoff = TRANSPARENT_CUTOFF_HZ;
        this._filterState = [[0, 0], [0, 0]];

        this._primed = null;
    }

    // ─── Cycle de vie ─────────────────────────────────────────────────────

    /**
     * Ouvre le décodeur et attend d'avoir de quoi jouer sans à-coup.
     *
     * L'attente d'amorçage est ce qui distingue une source prête d'une source
     * simplement ouverte : verser dans le bus un FFmpeg qui n'a encore rien
     * produit ferait patiner la trame suivante, et le silence se propagerait à
     * l'ensemble du mixage.
     *
     * @returns {Promise<void>}
     */
    async start() {
        const { input, stream } = await resolveInput(this.track, this.player);
        if (this._halted) {
            try { stream?.destroy(); } catch (e) {}
            return;
        }

        this._spawnFfmpeg(input, stream);
        await this._awaitPriming();
    }

    /**
     * Relance le décodage à une autre position, ou à une autre vitesse.
     *
     * Le tampon est vidé : ce qu'il contient appartient à l'ancienne position,
     * et le rendre après le repositionnement ferait entendre un fragment du
     * passage qu'on vient de quitter.
     *
     * @param {number} positionMs
     * @param {number} [vitesse]
     * @returns {Promise<void>}
     */
    async seek(positionMs, speed = this.speed) {
        this._closeProcess();

        this.startMs = Math.max(0, positionMs);
        this.speed = speed > 0 ? speed : 1;
        this._buffer = [];
        this._available = 0;
        this._bytesEmitted = 0;
        this._streamEnded = false;
        this._exhausted = false;
        this._paused = false;
        this._primed = null;
        this._filterState = [[0, 0], [0, 0]];

        await this.start();
    }

    /** Ferme le décodeur et libère tout ce qui en dépend. */
    stop() {
        this._halted = true;
        this._closeProcess();
        this._buffer = [];
        this._available = 0;
        this._exhausted = true;
    }

    _closeProcess() {
        if (this._process) {
            try { this._process.stdout?.removeAllListeners(); } catch (e) {}
            try { this._process.kill('SIGKILL'); } catch (e) {}
            this._process = null;
        }
        if (this._inputStream) {
            try { this._inputStream.destroy(); } catch (e) {}
            this._inputStream = null;
        }
    }

    /**
     * @param {string} input
     * @param {import('stream').Readable|null} stream
     */
    _spawnFfmpeg(input, stream) {
        const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];

        if (isUrl(input)) {
            args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
        }

        // Placé avant `-i`, le repositionnement est traité par le démultiplexeur :
        // FFmpeg ne décode pas ce qui précède, et sur une adresse réseau il ne le
        // télécharge même pas. `-accurate_seek`, actif par défaut sous cette
        // forme, ramène ensuite la coupure à l'échantillon près.
        if (this.startMs > 0) {
            args.push('-ss', (this.startMs / 1000).toFixed(6));
        }

        args.push('-i', input, '-vn');

        const tempo = tempoChain(this.speed);
        if (tempo) args.push('-af', tempo);

        args.push('-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', String(CHANNELS), 'pipe:1');

        const ffmpegProcess = cp.spawn(ffmpeg, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true
        });
        this._process = ffmpegProcess;
        this._inputStream = stream || null;

        // Nom distinct de celui du module de journalisation, importé plus haut :
        // `const log = []` le masquerait dans toute cette fonction, et les
        // `log.error` ci-dessous s'adresseraient à un tableau.
        const ffmpegLog = [];
        ffmpegProcess.stderr?.on('data', (d) => {
            const message = d.toString().trim();
            if (message) ffmpegLog.push(message);
        });

        ffmpegProcess.stdout.on('data', (track) => this._receive(track));
        ffmpegProcess.stdout.on('end', () => this._endStream());

        ffmpegProcess.on('error', (err) => {
            log.error(`[MixSource] FFmpeg could not start for ${this.track?.title}:`, err.message);
            this._endStream();
            this.emit('sourceError', err);
        });

        ffmpegProcess.on('close', (code) => {
            if (code !== 0 && !this._halted) {
                log.error(`[MixSource] FFmpeg stopped with ${code} for ${this.track?.title}:`,
                    ffmpegLog.slice(-5).join(' | '));
            }
            this._endStream();
        });

        ffmpegProcess.stdin?.on('error', () => {
            // EPIPE attendu quand FFmpeg referme son entrée avant la fin du flux
        });

        if (stream) {
            stream.on('error', (err) => {
                log.error(`[MixSource] Upstream feed interrupted for ${this.track?.title}:`, err.message);
                this._endStream();
            });
            stream.pipe(ffmpegProcess.stdin);
        }
    }

    // ─── Tampon ───────────────────────────────────────────────────────────

    _receive(track) {
        if (this._halted) return;

        this._buffer.push(track);
        this._available += track.length;

        // Le décodage court plus vite que la lecture : sans ce frein, FFmpeg
        // décoderait un morceau entier en mémoire dès son ouverture.
        if (this._available >= MAX_BUFFER_MS * BYTES_PER_MS && !this._paused) {
            this._paused = true;
            try { this._process?.stdout?.pause(); } catch (e) {}
        }

        this.emit('donnees');
    }

    _endStream() {
        if (this._streamEnded) return;
        this._streamEnded = true;
        if (this._available === 0) this._exhausted = true;
        this.emit('donnees');
    }

    _resumeDecoding() {
        if (!this._paused) return;
        if (this._available >= (MAX_BUFFER_MS / 2) * BYTES_PER_MS) return;
        this._paused = false;
        try { this._process?.stdout?.resume(); } catch (e) {}
    }

    /** @returns {Promise<void>} */
    _awaitPriming() {
        if (this._primed) return this._primed;

        this._primed = new Promise((resolve, reject) => {
            const required = PRIMING_BUFFER_MS * BYTES_PER_MS;

            const finish = (error) => {
                clearTimeout(deadline);
                this.removeListener('donnees', check);
                if (error) reject(error); else resolve();
            };

            const check = () => {
                if (this._halted || this._streamEnded || this._available >= required) finish();
            };

            const deadline = setTimeout(() => {
                if (this._available > 0) finish();
                else finish(new Error(`No sound decoded after ${MAX_PRIMING_DELAY_MS / 1000} s.`));
            }, MAX_PRIMING_DELAY_MS);
            if (deadline.unref) deadline.unref();

            this.on('donnees', check);
            check();
        });

        return this._primed;
    }

    // ─── Lecture par le bus ───────────────────────────────────────────────

    /**
     * Rend la prochaine trame, gain compris.
     *
     * Rendre `null` sans être épuisée signale une famine : le bus doit alors
     * patienter plutôt que de combler avec du silence, sinon les sources d'un
     * fondu se décaleraient l'une par rapport à l'autre.
     *
     * @returns {{ pcm: Buffer, gainDebut: number, gainFin: number }|null}
     */
    readFrame() {
        if (this._exhausted) return null;

        let pcm;
        if (this._available >= BYTES_PER_FRAME) {
            pcm = this._take(BYTES_PER_FRAME);
        } else if (this._streamEnded) {
            // Dernière trame, complétée de silence : la trame doit rester
            // entière pour que l'encodeur Opus reste aligné.
            pcm = Buffer.alloc(BYTES_PER_FRAME);
            if (this._available > 0) {
                this._take(this._available).copy(pcm);
            }
            this._exhausted = true;
        } else {
            return null;
        }

        this._bytesEmitted += BYTES_PER_FRAME;
        this._resumeDecoding();

        const startGain = this._gain;
        const startLevel = this._levelGain;
        const endGain = this._advanceEnvelope();
        const endLevel = this._advanceLevel();

        if (this._filterActive) this._applyFilter(pcm);

        // Les deux gains sont remis au bus déjà multipliés : il interpole entre
        // le début et la fin de la trame, et c'est bien leur produit qui doit
        // suivre cette rampe — un fondu sur un morceau remonté de 6 dB reste un
        // fondu, pas un fondu suivi d'un saut de niveau.
        return { pcm, startGain: startGain * startLevel, endGain: endGain * endLevel };
    }

    /**
     * Retire des octets en tête de tampon.
     * @param {number} taille
     * @returns {Buffer}
     */
    _take(size) {
        // Cas courant : le premier morceau suffit à lui seul.
        if (this._buffer.length > 0 && this._buffer[0].length >= size) {
            const first = this._buffer[0];
            const extracted = first.subarray(0, size);
            if (first.length === size) this._buffer.shift();
            else this._buffer[0] = first.subarray(size);
            this._available -= size;
            return extracted;
        }

        const tracks = [];
        let remaining = size;
        while (remaining > 0 && this._buffer.length > 0) {
            const first = this._buffer[0];
            if (first.length <= remaining) {
                tracks.push(first);
                remaining -= first.length;
                this._buffer.shift();
            } else {
                tracks.push(first.subarray(0, remaining));
                this._buffer[0] = first.subarray(remaining);
                remaining = 0;
            }
        }
        this._available -= size - remaining;
        return Buffer.concat(tracks, size - remaining);
    }

    // ─── Enveloppe de gain ────────────────────────────────────────────────

    /**
     * Programme un fondu vers un gain cible.
     *
     * @param {number} cible - Gain final, 0 à 1
     * @param {number} dureeMs
     * @param {object} [options]
     * @param {'puissance'|'perceptif'} [options.courbe] - `puissance` maintient
     *   la puissance totale constante lorsque deux sources se croisent, ce qui
     *   évite le creux sonore au milieu d'un fondu enchaîné. `perceptif` suit
     *   une courbe carrée, mieux adaptée à une entrée en fondu isolée.
     * @param {Function} [options.auTerme]
     */
    fade(target, durationMs, { curve = 'puissance', atEnd = null } = {}) {
        const clamp = Math.max(0, Math.min(1, target));
        this._startGain = this._gain;
        this._targetGain = clamp;
        this._fadeCurve = curve;
        this._onFadeComplete = atEnd;
        this._fadeFrame = 0;
        this._fadeFrames = Math.max(0, Math.round(durationMs / 20));

        if (this._fadeFrames === 0) {
            this._gain = clamp;
            if (atEnd) {
                this._onFadeComplete = null;
                atEnd();
            }
        }
    }

    /** Fixe le gain sans transition. */
    setGain(value) {
        this._gain = Math.max(0, Math.min(1, value));
        this._startGain = this._gain;
        this._targetGain = this._gain;
        this._fadeFrames = 0;
        this._onFadeComplete = null;
    }

    /** @returns {number} Gain après avancement d'une trame. */
    _advanceEnvelope() {
        if (this._fadeFrames === 0) return this._gain;

        this._fadeFrame++;
        const t = Math.min(1, this._fadeFrame / this._fadeFrames);

        if (this._fadeCurve === 'perceptif') {
            this._gain = this._startGain + (this._targetGain - this._startGain) * t * t;
        } else {
            // Interpolation linéaire de la puissance : deux sources croisées
            // avec cette loi conservent une somme de puissances constante.
            const a = this._startGain * this._startGain;
            const b = this._targetGain * this._targetGain;
            this._gain = Math.sqrt(Math.max(0, a + (b - a) * t));
        }

        if (t >= 1) {
            this._gain = this._targetGain;
            this._fadeFrames = 0;
            const atEnd = this._onFadeComplete;
            this._onFadeComplete = null;
            if (atEnd) atEnd();
        }

        return this._gain;
    }

    // ─── Gain de mise à niveau ────────────────────────────────────────────

    /**
     * Amène le morceau au niveau demandé.
     *
     * Le changement est étalé sur quelques trames plutôt qu'appliqué d'un coup :
     * le curseur du tableau de bord émet une valeur par cran, et chaque saut de
     * gain non lissé s'entendrait comme un craquement.
     *
     * @param {number} value - Facteur multiplicatif, 1 pour laisser tel quel
     * @param {boolean} [immediate] - Applique sans transition, à la création
     */
    setLevelGain(value, immediate = false) {
        const target = Number.isFinite(value) && value > 0 ? value : 1;
        if (target === this._levelTarget) return;

        this._levelTarget = target;
        if (immediate) {
            this._levelGain = target;
            this._levelStart = target;
            this._levelFrames = 0;
            return;
        }

        this._levelStart = this._levelGain;
        this._levelFrame = 0;
        this._levelFrames = LEVEL_SLEW_FRAMES;
    }

    /** @returns {number} Gain de niveau après avancement d'une trame. */
    _advanceLevel() {
        if (this._levelFrames === 0) return this._levelGain;

        this._levelFrame++;
        const t = Math.min(1, this._levelFrame / this._levelFrames);
        this._levelGain = this._levelStart + (this._levelTarget - this._levelStart) * t;

        if (t >= 1) {
            this._levelGain = this._levelTarget;
            this._levelFrames = 0;
        }

        return this._levelGain;
    }

    // ─── Balayage de filtre ───────────────────────────────────────────────

    /**
     * Ouvre ou referme progressivement un passe-bas sur la source.
     *
     * L'enchaînement « effets » veut entendre le morceau sortant s'étouffer
     * pendant que l'entrant s'éclaircit. Le filtre est calculé ici plutôt que
     * confié à FFmpeg : changer la chaîne de filtres d'un FFmpeg en cours
     * suppose de le relancer, donc de rompre le flux — précisément ce qu'un
     * fondu enchaîné ne peut pas se permettre.
     *
     * @param {'ferme'|'ouvre'} sens
     */
    sweepFilter(direction) {
        this._filterActive = true;
        if (direction === 'ferme') {
            this._startCutoff = TRANSPARENT_CUTOFF_HZ;
            this._targetCutoff = LOW_CUTOFF_HZ;
        } else {
            this._startCutoff = LOW_CUTOFF_HZ;
            this._targetCutoff = TRANSPARENT_CUTOFF_HZ;
        }
    }

    /** Rend la source transparente au filtre. */
    cutFilter() {
        this._filterActive = false;
        this._filterState = [[0, 0], [0, 0]];
    }

    /**
     * Applique le passe-bas en place, sur toute la trame.
     *
     * La coupure suit l'avancement du fondu, sur une échelle logarithmique :
     * l'oreille entend les hauteurs en rapports, pas en écarts, et un balayage
     * linéaire semblerait s'écrouler d'un coup puis traîner.
     *
     * @param {Buffer} pcm
     */
    _applyFilter(pcm) {
        const t = this._fadeFrames === 0 ? 1 : Math.min(1, this._fadeFrame / this._fadeFrames);
        const cutoff = this._startCutoff
            * Math.pow(this._targetCutoff / this._startCutoff, t);

        if (cutoff >= TRANSPARENT_CUTOFF_HZ) return;

        const alpha = lowPassCoefficient(cutoff);
        const state = this._filterState;

        for (let i = 0; i < pcm.length; i += 2) {
            const channel = (i >> 1) & 1;
            let value = pcm.readInt16LE(i);
            const sections = state[channel];
            for (let s = 0; s < sections.length; s++) {
                sections[s] += alpha * (value - sections[s]);
                value = sections[s];
            }
            pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value))), i);
        }
    }

    // ─── Lecture d'état ───────────────────────────────────────────────────

    /** Position atteinte dans le morceau d'origine, en millisecondes. */
    get positionMs() {
        return this.startMs + bytesToMs(this._bytesEmitted) * this.speed;
    }

    /** Le tampon est vidé et le décodeur a fini : plus rien à rendre. */
    get exhausted() {
        return this._exhausted;
    }

    /**
     * La source peut-elle fournir sa prochaine trame sans faire attendre ?
     *
     * Le bus s'en assure pour toutes ses sources avant d'en lire aucune : c'est
     * la condition pour que deux morceaux superposés avancent du même nombre
     * d'échantillons, y compris quand l'un des deux vient à manquer de données.
     *
     * @returns {boolean}
     */
    get canAdvance() {
        return this._exhausted || this._streamEnded || this._available >= BYTES_PER_FRAME;
    }

    /** Le décodeur a fini d'écrire, mais le tampon peut encore contenir du son. */
    get streamEnded() {
        return this._streamEnded;
    }

    /**
     * Le décodage a-t-il produit quoi que ce soit ?
     *
     * Une piste dont la source a disparu — vidéo retirée, fichier effacé — fait
     * sortir FFmpeg immédiatement et sans un octet. La reconnaître évite
     * d'annoncer une lecture qui ne se produira pas.
     *
     * @returns {boolean}
     */
    get hasSound() {
        return this._available > 0 || this._bytesEmitted > 0 || !this._streamEnded;
    }

    /** Millisecondes de son déjà décodées et pas encore rendues. */
    get leadMs() {
        return bytesToMs(this._available);
    }

    /** Gain courant, 0 à 1. */
    get gain() {
        return this._gain;
    }

    /** Un fondu est-il en cours ? */
    get isFading() {
        return this._fadeFrames > 0;
    }
}

module.exports = MixSource;
