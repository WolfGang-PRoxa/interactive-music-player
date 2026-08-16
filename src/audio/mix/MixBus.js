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
    OCTETS_PAR_TRAME,
    VALEURS_PAR_TRAME,
    ECHANTILLONS_PAR_TRAME,
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
const TRAMES_AVANCE = 4;

class MixBus extends Readable {
    constructor() {
        super({ highWaterMark: OCTETS_PAR_TRAME * TRAMES_AVANCE });

        /** @type {import('./MixSource')[]} Sources actuellement mixées */
        this.sources = [];

        /** Gain appliqué à la somme, 0 à 1. */
        this._gainMaitre = 1;

        /** Gain de la trame précédente, pour interpoler et éviter les paliers. */
        this._gainMaitrePrecedent = 1;

        /** Appelé après chaque trame produite : l'horloge du moteur. */
        this._surTrame = null;

        /**
         * Trames fabriquées depuis l'ouverture du bus.
         *
         * Fabriquer n'est pas diffuser : la chaîne qui suit — encodeur Opus,
         * ressource audio — garde plusieurs trames d'avance. Comparer ce compte
         * à ce que le lecteur a réellement émis donne cette avance, et c'est la
         * seule façon de savoir où en est vraiment ce qu'on entend.
         */
        this.tramesProduites = 0;

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
        this._place = true;

        this._ferme = false;
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
    ajouter(source) {
        if (this._ferme || this.sources.includes(source)) return;
        this.sources.push(source);
        source.on('donnees', this._relancer);
        this._produire();
    }

    /** Le bus mixe-t-il déjà cette source ? */
    contient(source) {
        return this.sources.includes(source);
    }

    /**
     * Retire une source du mixage, sans la fermer.
     * @param {import('./MixSource')} source
     */
    retirer(source) {
        const index = this.sources.indexOf(source);
        if (index === -1) return;
        this.sources.splice(index, 1);
        source.removeListener('donnees', this._relancer);
    }

    /** Une source vient de recevoir du son : de quoi débloquer une famine. */
    _relancer = () => {
        this._produire();
    };

    // ─── Réglages ─────────────────────────────────────────────────────────

    /**
     * Gain appliqué à la somme des sources.
     * @param {number} valeur - 0 à 1
     */
    definirGainMaitre(valeur) {
        this._gainMaitre = Math.max(0, Math.min(1, valeur));
    }

    /** @returns {number} */
    get gainMaitre() {
        return this._gainMaitre;
    }

    /**
     * Enregistre l'horloge du moteur : appelée après chaque trame produite.
     * @param {Function|null} rappel
     */
    surTrame(rappel) {
        this._surTrame = rappel;
    }

    // ─── Production ───────────────────────────────────────────────────────

    /** Le lecteur redemande : la place rouvre, et la production reprend. */
    _read() {
        this._place = true;
        this._produire();
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
    _produire() {
        if (this._ferme) return;
        if (this._enProduction) {
            this._relanceDemandee = true;
            return;
        }
        this._enProduction = true;

        try {
            let reprendre = true;
            while (reprendre) {
                reprendre = false;
                this._relanceDemandee = false;

                while (this._place) {
                    const trame = this._melanger();
                    if (!trame) break;
                    this.tramesProduites++;
                    this._place = this.push(trame);

                    if (this._surTrame) {
                        try {
                            this._surTrame();
                        } catch (err) {
                            this.emit('erreurMoteur', err);
                        }
                    }
                }

                // Le lecteur en accepte encore, et une source est arrivée entre
                // temps : il y a de nouveau de quoi produire.
                if (this._place && this._relanceDemandee && !this._ferme) reprendre = true;
            }
        } finally {
            this._enProduction = false;
        }
    }

    /**
     * Assemble une trame à partir des sources actives.
     *
     * @returns {Buffer|null} `null` si une source n'est pas prête — il faut
     *   alors attendre plutôt que de produire une trame incomplète.
     */
    _melanger() {
        if (this.sources.length === 0) return null;

        // Toutes les sources sont interrogées avant qu'aucune ne soit lue : une
        // seule d'entre elles qui ne serait pas prête, et la trame ne peut pas
        // être fabriquée. Consommer les autres en attendant les décalerait
        // définitivement d'une trame par rapport à la retardataire.
        for (const source of this.sources) {
            if (!source.peutAvancer) return null;
        }

        const trames = [];
        const epuisees = [];

        for (const source of this.sources) {
            const trame = source.lireTrame();
            if (trame) trames.push(trame);
            else epuisees.push(source);
        }

        for (const source of epuisees) {
            this.retirer(source);
            this.emit('sourceEpuisee', source);
        }
        if (trames.length === 0) return null;

        const gainDebut = this._gainMaitrePrecedent;
        const gainFin = this._gainMaitre;
        this._gainMaitrePrecedent = gainFin;

        // Chemin rapide : une seule source à plein gain, volume nominal, aucun
        // fondu. Les octets sont alors transmis tels quels — le son diffusé est
        // exactement celui que FFmpeg a décodé, sans un arrondi de plus.
        if (trames.length === 1
            && gainDebut === 1 && gainFin === 1
            && trames[0].gainDebut === 1 && trames[0].gainFin === 1) {
            return trames[0].pcm;
        }

        return this._sommer(trames, gainDebut, gainFin);
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
    _sommer(trames, maitreDebut, maitreFin) {
        const sortie = Buffer.allocUnsafe(OCTETS_PAR_TRAME);
        const nombre = trames.length;

        for (let i = 0; i < VALEURS_PAR_TRAME; i++) {
            const octet = i << 1;
            // Une position par échantillon, partagée par les deux canaux : les
            // rampes gauche et droite restent ainsi rigoureusement identiques.
            const t = (i >> 1) / ECHANTILLONS_PAR_TRAME;

            let somme = 0;
            for (let s = 0; s < nombre; s++) {
                const trame = trames[s];
                const gain = trame.gainDebut + (trame.gainFin - trame.gainDebut) * t;
                if (gain === 0) continue;
                somme += trame.pcm.readInt16LE(octet) * gain;
            }

            somme *= maitreDebut + (maitreFin - maitreDebut) * t;

            const valeur = Math.round(somme);
            sortie.writeInt16LE(valeur < MIN_16 ? MIN_16 : (valeur > MAX_16 ? MAX_16 : valeur), octet);
        }

        return sortie;
    }

    // ─── Fermeture ────────────────────────────────────────────────────────

    /**
     * Referme le bus.
     *
     * Le flux est terminé proprement plutôt que détruit : le lecteur joue ce
     * qui reste en tampon avant de se déclarer inactif.
     */
    fermer() {
        if (this._ferme) return;
        this._ferme = true;
        for (const source of [...this.sources]) this.retirer(source);
        this._surTrame = null;
        this.push(null);
    }
}

module.exports = MixBus;
