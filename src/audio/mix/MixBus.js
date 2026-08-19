/**
 * MixBus — le flux artificiel diffusé dans le salon vocal.
 *
 * ## Le problème
 *
 * Une connexion vocale Discord ne porte qu'un flux à la fois : demander au bot
 * de jouer un second morceau interrompt le premier. Un fondu enchaîné, lui,
 * suppose exactement le contraire — deux morceaux qui sonnent ensemble le temps
 * de la transition.
 *
 * ## L'approche
 *
 * Le bot ne diffuse plus les morceaux : il diffuse ce bus, un flux unique et
 * permanent, ouvert tant qu'il reste dans le salon. Les morceaux n'en sont que
 * les sources, et le bus les additionne. Un seul flux part vers Discord, comme
 * il se doit, mais son contenu peut porter un morceau, deux, ou aucun.
 *
 * Permanent est le mot important : le flux ne s'interrompt pas entre deux
 * morceaux, il n'est jamais remplacé, et rien n'est donc à raccorder au passage
 * d'un titre au suivant. C'est ce qui supprime la coupure qu'on entendait
 * jusqu'ici à chaque enchaînement.
 *
 * ## L'horloge
 *
 * Le bus ne s'appuie sur aucun minuteur : c'est le lecteur audio de Discord qui
 * vient puiser une trame toutes les 20 ms, et le bus n'en produit qu'à mesure
 * qu'on lui en demande. Toutes les sources avancent donc du même nombre exact
 * d'échantillons à chaque tour, et aucune dérive ne peut s'installer entre
 * elles, même sur un fondu de trente secondes.
 *
 * Si une source vient à manquer de données, le bus s'arrête plutôt que de
 * combler avec du silence : le lecteur émet alors ses propres trames muettes et
 * la lecture reprend exactement là où elle en était. Un accroc réseau coûte un
 * blanc, jamais un décalage entre les morceaux superposés.
 */

const { Readable } = require('stream');

const {
    BYTES_PER_FRAME,
    VALUES_PER_FRAME,
    SAMPLES_PER_FRAME,
    MIN_16,
    MAX_16,
} = require('./format');

/**
 * Avance conservée en sortie du bus, en trames.
 *
 * Volontairement courte : tout ce qui est déjà mixé ne peut plus être repris,
 * et le ducking comme le volume doivent se faire entendre sans délai. La marge
 * contre les à-coups réseau est prise en amont, dans le tampon des sources.
 */
const LEAD_FRAMES = 4;

class MixBus extends Readable {
    constructor() {
        super({ highWaterMark: BYTES_PER_FRAME * LEAD_FRAMES });

        /** @type {import('./MixSource')[]} Sources actuellement mixées */
        this.sources = [];

        /** Gain appliqué à la somme, 0 à 1. */
        this._masterGain = 1;

        /** Gain de la trame précédente, pour interpoler et éviter les paliers. */
        this._previousMasterGain = 1;

        /** Appelé après chaque trame produite : l'horloge du moteur. */
        this._onFrame = null;

        /**
         * Trames fabriquées depuis l'ouverture du bus.
         *
         * Fabriquer n'est pas diffuser : la chaîne qui suit — encodeur Opus,
         * ressource audio — garde plusieurs trames d'avance. Comparer ce compte
         * à ce que le lecteur a réellement émis donne cette avance, et c'est la
         * seule façon de savoir où en est vraiment ce qu'on entend.
         */
        this.framesProduced = 0;

        /**
         * Le lecteur accepte-t-il encore des trames ?
         *
         * L'état appartient au bus et non à un appel de `_produire()` : c'est
         * un refus qui doit tenir jusqu'à ce que le lecteur redemande, pas
         * jusqu'au prochain paquet décodé. Reparti de `true` à chaque appel, il
         * laissait passer une trame par événement de source — et une source qui
         * décode depuis un fichier en cache en émet des milliers d'affilée. Le
         * tampon montait alors à des dizaines de secondes malgré son plafond,
         * et tout ce qui est déjà mixé étant hors de portée, un
         * repositionnement ne s'entendait qu'au bout de ce délai.
         */
        this._slot = true;

        this._closed = false;
    }

    // ─── Sources ──────────────────────────────────────────────────────────

    /**
     * Verse une source dans le mixage.
     *
     * Elle prend effet à la trame suivante : la trame en cours de fabrication
     * est déjà figée, et l'y insérer à mi-parcours produirait un craquement.
     *
     * @param {import('./MixSource')} source
     */
    add(source) {
        if (this._closed || this.sources.includes(source)) return;
        this.sources.push(source);
        source.on('donnees', this._restart);
        this._produce();
    }

    /** Le bus mixe-t-il déjà cette source ? */
    contains(source) {
        return this.sources.includes(source);
    }

    /**
     * Retire une source du mixage, sans la fermer.
     * @param {import('./MixSource')} source
     */
    remove(source) {
        const index = this.sources.indexOf(source);
        if (index === -1) return;
        this.sources.splice(index, 1);
        source.removeListener('donnees', this._restart);
    }

    /** Une source vient de recevoir du son : de quoi débloquer une famine. */
    _restart = () => {
        this._produce();
    };

    // ─── Réglages ─────────────────────────────────────────────────────────

    /**
     * Gain appliqué à la somme des sources.
     * @param {number} valeur - 0 à 1
     */
    setMasterGain(value) {
        this._masterGain = Math.max(0, Math.min(1, value));
    }

    /** @returns {number} */
    get masterGain() {
        return this._masterGain;
    }

    /**
     * Enregistre l'horloge du moteur : appelée après chaque trame produite.
     * @param {Function|null} rappel
     */
    onFrame(callback) {
        this._onFrame = callback;
    }

    // ─── Production ───────────────────────────────────────────────────────

    /** Le lecteur redemande : la place rouvre, et la production reprend. */
    _read() {
        this._slot = true;
        this._produce();
    }

    /**
     * Fabrique des trames tant que le lecteur en accepte et que les sources
     * peuvent en fournir.
     *
     * La fabrication d'une trame peut elle-même faire entrer une source : c'est
     * ce qui se produit à chaque enchaînement, puisque c'est l'épuisement du
     * morceau courant qui amène le suivant. La réentrance est interdite — deux
     * productions concurrentes mélangeraient l'ordre des trames — mais la
     * demande est retenue et servie au tour suivant. Sans cela, le bus
     * s'arrêterait précisément à l'instant du passage d'un morceau à l'autre.
     */
    _produce() {
        if (this._closed) return;
        if (this._producing) {
            this._restartRequested = true;
            return;
        }
        this._producing = true;

        try {
            let resume = true;
            while (resume) {
                resume = false;
                this._restartRequested = false;

                while (this._slot) {
                    const frame = this._mix();
                    if (!frame) break;
                    this.framesProduced++;
                    this._slot = this.push(frame);

                    if (this._onFrame) {
                        try {
                            this._onFrame();
                        } catch (err) {
                            this.emit('erreurMoteur', err);
                        }
                    }
                }

                // Le lecteur en accepte encore, et une source est arrivée entre
                // temps : il y a de nouveau de quoi produire.
                if (this._slot && this._restartRequested && !this._closed) resume = true;
            }
        } finally {
            this._producing = false;
        }
    }

    /**
     * Assemble une trame à partir des sources actives.
     *
     * @returns {Buffer|null} `null` si une source n'est pas prête — il faut
     *   alors attendre plutôt que de produire une trame incomplète.
     */
    _mix() {
        if (this.sources.length === 0) return null;

        // Toutes les sources sont interrogées avant qu'aucune ne soit lue : une
        // seule d'entre elles qui ne serait pas prête, et la trame ne peut pas
        // être fabriquée. Consommer les autres en attendant les décalerait
        // définitivement d'une trame par rapport à la retardataire.
        for (const source of this.sources) {
            if (!source.canAdvance) return null;
        }

        const frames = [];
        const exhaustedSources = [];

        for (const source of this.sources) {
            const frame = source.readFrame();
            if (frame) frames.push(frame);
            else exhaustedSources.push(source);
        }

        for (const source of exhaustedSources) {
            this.remove(source);
            this.emit('sourceEpuisee', source);
        }
        if (frames.length === 0) return null;

        const startGain = this._previousMasterGain;
        const endGain = this._masterGain;
        this._previousMasterGain = endGain;

        // Chemin rapide : une seule source à plein gain, volume nominal, aucun
        // fondu. Les octets sont alors transmis tels quels — le son diffusé est
        // exactement celui que FFmpeg a décodé, sans un arrondi de plus.
        if (frames.length === 1
            && startGain === 1 && endGain === 1
            && frames[0].startGain === 1 && frames[0].endGain === 1) {
            return frames[0].pcm;
        }

        return this._sum(frames, startGain, endGain);
    }

    /**
     * Somme les trames en interpolant les gains sur toute leur longueur.
     *
     * L'interpolation est ce qui rend le fondu continu : appliquer un gain
     * constant par trame reviendrait à monter le volume par marches de 20 ms,
     * et chaque marche s'entendrait comme un clic.
     *
     * @param {{pcm: Buffer, gainDebut: number, gainFin: number}[]} trames
     * @param {number} maitreDebut
     * @param {number} maitreFin
     * @returns {Buffer}
     */
    _sum(frames, masterStart, masterEnd) {
        const output = Buffer.allocUnsafe(BYTES_PER_FRAME);
        const count = frames.length;

        for (let i = 0; i < VALUES_PER_FRAME; i++) {
            const byte = i << 1;
            // Une position par échantillon, partagée par les deux canaux : les
            // rampes gauche et droite restent ainsi rigoureusement identiques.
            const t = (i >> 1) / SAMPLES_PER_FRAME;

            let sum = 0;
            for (let s = 0; s < count; s++) {
                const frame = frames[s];
                const gain = frame.startGain + (frame.endGain - frame.startGain) * t;
                if (gain === 0) continue;
                sum += frame.pcm.readInt16LE(byte) * gain;
            }

            sum *= masterStart + (masterEnd - masterStart) * t;

            const value = Math.round(sum);
            output.writeInt16LE(value < MIN_16 ? MIN_16 : (value > MAX_16 ? MAX_16 : value), byte);
        }

        return output;
    }

    // ─── Fermeture ────────────────────────────────────────────────────────

    /**
     * Referme le bus.
     *
     * Le flux est terminé proprement plutôt que détruit : le lecteur joue ce
     * qui reste en tampon avant de se déclarer inactif.
     */
    close() {
        if (this._closed) return;
        this._closed = true;
        for (const source of [...this.sources]) this.remove(source);
        this._onFrame = null;
        this.push(null);
    }
}

module.exports = MixBus;
