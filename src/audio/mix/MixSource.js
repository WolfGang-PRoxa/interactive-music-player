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
    FREQUENCE,
    CANAUX,
    OCTETS_PAR_TRAME,
    OCTETS_PAR_MS,
    octetsVersMs,
} = require('./format');
const { resoudreEntree, estUrl } = require('./entree');
const log = require('../../utils/logger');

/**
 * Son décodé conservé d'avance au maximum, en millisecondes.
 *
 * Assez large pour qu'un accroc réseau passe inaperçu, et pour que la fin du
 * décodage — qui donne le temps restant au millième près, là où la durée
 * annoncée dans les métadonnées se trompe parfois — survienne avant le point de
 * fondu des durées d'enchaînement courantes.
 */
const TAMPON_MAX_MS = 12000;

/** Son décodé exigé avant de considérer la source prête à jouer. */
const TAMPON_AMORCAGE_MS = 400;

/**
 * Délai au-delà duquel un décodeur muet est déclaré perdu.
 *
 * Sans cette borne, une source réseau qui accepte la connexion puis ne répond
 * plus laisserait la mise en lecture attendre indéfiniment : la file ne
 * repartirait jamais, et rien ne signalerait pourquoi.
 */
const DELAI_AMORCAGE_MAX_MS = 20000;

/** Fréquence de coupure au plus bas du balayage de filtre, en Hz. */
const COUPURE_BASSE_HZ = 400;

/** Au-delà, le filtre est jugé transparent et n'est plus appliqué. */
const COUPURE_TRANSPARENTE_HZ = 16000;

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
function chaineTempo(vitesse) {
    const v = Math.round(vitesse * 100) / 100;
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
function coefficientPasseBas(coupureHz) {
    return 1 - Math.exp((-2 * Math.PI * coupureHz) / FREQUENCE);
}

class MixSource extends EventEmitter {
    /**
     * @param {object} piste - Piste discord-player
     * @param {object} options
     * @param {import('discord-player').Player} options.player
     * @param {number} [options.departMs] - Position de départ dans le morceau
     * @param {number} [options.vitesse] - Multiplicateur de vitesse
     * @param {number} [options.gain] - Gain initial, 0 à 1
     */
    constructor(piste, { player, departMs = 0, vitesse = 1, gain = 1 } = {}) {
        super();

        this.piste = piste;
        this.player = player;
        this.departMs = Math.max(0, departMs || 0);
        this.vitesse = vitesse > 0 ? vitesse : 1;

        /** Morceaux de PCM décodé en attente d'être lus. */
        this._tampon = [];
        this._disponible = 0;

        /** Octets déjà rendus au bus : c'est ce qui donne la position exacte. */
        this._octetsEmis = 0;

        this._processus = null;
        this._fluxEntree = null;
        this._fluxTermine = false;
        this._epuisee = false;
        this._arretee = false;
        this._enPause = false;

        // --- Enveloppe de gain ---
        this._gain = gain;
        this._gainDepart = gain;
        this._gainCible = gain;
        this._tramesFondu = 0;
        this._trameFondu = 0;
        this._courbeFondu = 'puissance';
        this._auTermeDuFondu = null;

        // --- Balayage de filtre (enchaînement « effets ») ---
        this._filtreActif = false;
        this._coupureDepart = COUPURE_TRANSPARENTE_HZ;
        this._coupureCible = COUPURE_TRANSPARENTE_HZ;
        this._etatFiltre = [[0, 0], [0, 0]];

        this._amorcee = null;
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
    async demarrer() {
        const { entree, flux } = await resoudreEntree(this.piste, this.player);
        if (this._arretee) {
            try { flux?.destroy(); } catch (e) {}
            return;
        }

        this._lancerFfmpeg(entree, flux);
        await this._attendreAmorcage();
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
    async repositionner(positionMs, vitesse = this.vitesse) {
        this._fermerProcessus();

        this.departMs = Math.max(0, positionMs);
        this.vitesse = vitesse > 0 ? vitesse : 1;
        this._tampon = [];
        this._disponible = 0;
        this._octetsEmis = 0;
        this._fluxTermine = false;
        this._epuisee = false;
        this._enPause = false;
        this._amorcee = null;
        this._etatFiltre = [[0, 0], [0, 0]];

        await this.demarrer();
    }

    /** Ferme le décodeur et libère tout ce qui en dépend. */
    arreter() {
        this._arretee = true;
        this._fermerProcessus();
        this._tampon = [];
        this._disponible = 0;
        this._epuisee = true;
    }

    _fermerProcessus() {
        if (this._processus) {
            try { this._processus.stdout?.removeAllListeners(); } catch (e) {}
            try { this._processus.kill('SIGKILL'); } catch (e) {}
            this._processus = null;
        }
        if (this._fluxEntree) {
            try { this._fluxEntree.destroy(); } catch (e) {}
            this._fluxEntree = null;
        }
    }

    /**
     * @param {string} entree
     * @param {import('stream').Readable|null} flux
     */
    _lancerFfmpeg(entree, flux) {
        const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];

        if (estUrl(entree)) {
            args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
        }

        // Placé avant `-i`, le repositionnement est traité par le démultiplexeur :
        // FFmpeg ne décode pas ce qui précède, et sur une adresse réseau il ne le
        // télécharge même pas. `-accurate_seek`, actif par défaut sous cette
        // forme, ramène ensuite la coupure à l'échantillon près.
        if (this.departMs > 0) {
            args.push('-ss', (this.departMs / 1000).toFixed(6));
        }

        args.push('-i', entree, '-vn');

        const tempo = chaineTempo(this.vitesse);
        if (tempo) args.push('-af', tempo);

        args.push('-f', 's16le', '-ar', String(FREQUENCE), '-ac', String(CANAUX), 'pipe:1');

        const processus = cp.spawn(ffmpeg, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true
        });
        this._processus = processus;
        this._fluxEntree = flux || null;

        const journal = [];
        processus.stderr?.on('data', (d) => {
            const message = d.toString().trim();
            if (message) journal.push(message);
        });

        processus.stdout.on('data', (morceau) => this._recevoir(morceau));
        processus.stdout.on('end', () => this._terminerFlux());

        processus.on('error', (err) => {
            log.error(`[MixSource] FFmpeg n'a pas pu démarrer pour ${this.piste?.title} :`, err.message);
            this._terminerFlux();
            this.emit('erreur', err);
        });

        processus.on('close', (code) => {
            if (code !== 0 && !this._arretee) {
                log.error(`[MixSource] FFmpeg s'est arrêté en ${code} pour ${this.piste?.title} :`,
                    journal.slice(-5).join(' | '));
            }
            this._terminerFlux();
        });

        processus.stdin?.on('error', () => {
            // EPIPE attendu quand FFmpeg referme son entrée avant la fin du flux
        });

        if (flux) {
            flux.on('error', (err) => {
                log.error(`[MixSource] Flux amont interrompu pour ${this.piste?.title} :`, err.message);
                this._terminerFlux();
            });
            flux.pipe(processus.stdin);
        }
    }

    // ─── Tampon ───────────────────────────────────────────────────────────

    _recevoir(morceau) {
        if (this._arretee) return;

        this._tampon.push(morceau);
        this._disponible += morceau.length;

        // Le décodage court plus vite que la lecture : sans ce frein, FFmpeg
        // décoderait un morceau entier en mémoire dès son ouverture.
        if (this._disponible >= TAMPON_MAX_MS * OCTETS_PAR_MS && !this._enPause) {
            this._enPause = true;
            try { this._processus?.stdout?.pause(); } catch (e) {}
        }

        this.emit('donnees');
    }

    _terminerFlux() {
        if (this._fluxTermine) return;
        this._fluxTermine = true;
        if (this._disponible === 0) this._epuisee = true;
        this.emit('donnees');
    }

    _reprendreDecodage() {
        if (!this._enPause) return;
        if (this._disponible >= (TAMPON_MAX_MS / 2) * OCTETS_PAR_MS) return;
        this._enPause = false;
        try { this._processus?.stdout?.resume(); } catch (e) {}
    }

    /** @returns {Promise<void>} */
    _attendreAmorcage() {
        if (this._amorcee) return this._amorcee;

        this._amorcee = new Promise((resolve, rejeter) => {
            const requis = TAMPON_AMORCAGE_MS * OCTETS_PAR_MS;

            const conclure = (erreur) => {
                clearTimeout(echeance);
                this.removeListener('donnees', verifier);
                if (erreur) rejeter(erreur); else resolve();
            };

            const verifier = () => {
                if (this._arretee || this._fluxTermine || this._disponible >= requis) conclure();
            };

            const echeance = setTimeout(() => {
                if (this._disponible > 0) conclure();
                else conclure(new Error(`Aucun son décodé après ${DELAI_AMORCAGE_MAX_MS / 1000} s.`));
            }, DELAI_AMORCAGE_MAX_MS);
            if (echeance.unref) echeance.unref();

            this.on('donnees', verifier);
            verifier();
        });

        return this._amorcee;
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
    lireTrame() {
        if (this._epuisee) return null;

        let pcm;
        if (this._disponible >= OCTETS_PAR_TRAME) {
            pcm = this._prelever(OCTETS_PAR_TRAME);
        } else if (this._fluxTermine) {
            // Dernière trame, complétée de silence : la trame doit rester
            // entière pour que l'encodeur Opus reste aligné.
            pcm = Buffer.alloc(OCTETS_PAR_TRAME);
            if (this._disponible > 0) {
                this._prelever(this._disponible).copy(pcm);
            }
            this._epuisee = true;
        } else {
            return null;
        }

        this._octetsEmis += OCTETS_PAR_TRAME;
        this._reprendreDecodage();

        const gainDebut = this._gain;
        const gainFin = this._avancerEnveloppe();

        if (this._filtreActif) this._appliquerFiltre(pcm);

        return { pcm, gainDebut, gainFin };
    }

    /**
     * Retire des octets en tête de tampon.
     * @param {number} taille
     * @returns {Buffer}
     */
    _prelever(taille) {
        // Cas courant : le premier morceau suffit à lui seul.
        if (this._tampon.length > 0 && this._tampon[0].length >= taille) {
            const premier = this._tampon[0];
            const extrait = premier.subarray(0, taille);
            if (premier.length === taille) this._tampon.shift();
            else this._tampon[0] = premier.subarray(taille);
            this._disponible -= taille;
            return extrait;
        }

        const morceaux = [];
        let restant = taille;
        while (restant > 0 && this._tampon.length > 0) {
            const premier = this._tampon[0];
            if (premier.length <= restant) {
                morceaux.push(premier);
                restant -= premier.length;
                this._tampon.shift();
            } else {
                morceaux.push(premier.subarray(0, restant));
                this._tampon[0] = premier.subarray(restant);
                restant = 0;
            }
        }
        this._disponible -= taille - restant;
        return Buffer.concat(morceaux, taille - restant);
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
    fondre(cible, dureeMs, { courbe = 'puissance', auTerme = null } = {}) {
        const borne = Math.max(0, Math.min(1, cible));
        this._gainDepart = this._gain;
        this._gainCible = borne;
        this._courbeFondu = courbe;
        this._auTermeDuFondu = auTerme;
        this._trameFondu = 0;
        this._tramesFondu = Math.max(0, Math.round(dureeMs / 20));

        if (this._tramesFondu === 0) {
            this._gain = borne;
            if (auTerme) {
                this._auTermeDuFondu = null;
                auTerme();
            }
        }
    }

    /** Fixe le gain sans transition. */
    definirGain(valeur) {
        this._gain = Math.max(0, Math.min(1, valeur));
        this._gainDepart = this._gain;
        this._gainCible = this._gain;
        this._tramesFondu = 0;
        this._auTermeDuFondu = null;
    }

    /** @returns {number} Gain après avancement d'une trame. */
    _avancerEnveloppe() {
        if (this._tramesFondu === 0) return this._gain;

        this._trameFondu++;
        const t = Math.min(1, this._trameFondu / this._tramesFondu);

        if (this._courbeFondu === 'perceptif') {
            this._gain = this._gainDepart + (this._gainCible - this._gainDepart) * t * t;
        } else {
            // Interpolation linéaire de la puissance : deux sources croisées
            // avec cette loi conservent une somme de puissances constante.
            const a = this._gainDepart * this._gainDepart;
            const b = this._gainCible * this._gainCible;
            this._gain = Math.sqrt(Math.max(0, a + (b - a) * t));
        }

        if (t >= 1) {
            this._gain = this._gainCible;
            this._tramesFondu = 0;
            const auTerme = this._auTermeDuFondu;
            this._auTermeDuFondu = null;
            if (auTerme) auTerme();
        }

        return this._gain;
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
    balayerFiltre(sens) {
        this._filtreActif = true;
        if (sens === 'ferme') {
            this._coupureDepart = COUPURE_TRANSPARENTE_HZ;
            this._coupureCible = COUPURE_BASSE_HZ;
        } else {
            this._coupureDepart = COUPURE_BASSE_HZ;
            this._coupureCible = COUPURE_TRANSPARENTE_HZ;
        }
    }

    /** Rend la source transparente au filtre. */
    couperFiltre() {
        this._filtreActif = false;
        this._etatFiltre = [[0, 0], [0, 0]];
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
    _appliquerFiltre(pcm) {
        const t = this._tramesFondu === 0 ? 1 : Math.min(1, this._trameFondu / this._tramesFondu);
        const coupure = this._coupureDepart
            * Math.pow(this._coupureCible / this._coupureDepart, t);

        if (coupure >= COUPURE_TRANSPARENTE_HZ) return;

        const alpha = coefficientPasseBas(coupure);
        const etat = this._etatFiltre;

        for (let i = 0; i < pcm.length; i += 2) {
            const canal = (i >> 1) & 1;
            let valeur = pcm.readInt16LE(i);
            const sections = etat[canal];
            for (let s = 0; s < sections.length; s++) {
                sections[s] += alpha * (valeur - sections[s]);
                valeur = sections[s];
            }
            pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(valeur))), i);
        }
    }

    // ─── Lecture d'état ───────────────────────────────────────────────────

    /** Position atteinte dans le morceau d'origine, en millisecondes. */
    get positionMs() {
        return this.departMs + octetsVersMs(this._octetsEmis) * this.vitesse;
    }

    /** Le tampon est vidé et le décodeur a fini : plus rien à rendre. */
    get epuisee() {
        return this._epuisee;
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
    get peutAvancer() {
        return this._epuisee || this._fluxTermine || this._disponible >= OCTETS_PAR_TRAME;
    }

    /** Le décodeur a fini d'écrire, mais le tampon peut encore contenir du son. */
    get fluxTermine() {
        return this._fluxTermine;
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
    get aDuSon() {
        return this._disponible > 0 || this._octetsEmis > 0 || !this._fluxTermine;
    }

    /** Millisecondes de son déjà décodées et pas encore rendues. */
    get avanceMs() {
        return octetsVersMs(this._disponible);
    }

    /** Gain courant, 0 à 1. */
    get gain() {
        return this._gain;
    }

    /** Un fondu est-il en cours ? */
    get enFondu() {
        return this._tramesFondu > 0;
    }
}

module.exports = MixSource;
