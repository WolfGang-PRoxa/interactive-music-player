/**
 * VolumeController — Abstraction du contrôle de volume avec transitions progressives (fade).
 * Wraps le node de la queue de discord-player (queue.node) pour fournir des fades smooth.
 */

const config = require('../config');
const log = require('../utils/logger');

class VolumeController {
  /**
   * @param {object} queueNode - Le node de la queue discord-player (queue.node)
   */
  constructor(queueNode) {
    /** @type {object} */
    this.queueNode = queueNode;

    /** Volume de base (0-100) */
    this.baseVolume = config.volume.defaultBase;

    /** Volume actuel ciblé (0-100) */
    this.targetVolume = this.baseVolume;

    /** Timer du fade en cours */
    this._fadeInterval = null;

    /** Est-ce qu'on est en mode ducké ? */
    this.isDucked = false;

    /**
     * Dernier volume appliqué, faisant foi.
     *
     * `queue.node.volume` ne peut pas servir de référence : il retombe sur
     * 100 dès que la file n'a pas de dispatcher — donc entre deux pistes, et
     * surtout au moment de la restauration au démarrage. Un fade qui lisait
     * cette valeur croyait partir de 100 % alors que le son était coupé, et
     * concluait qu'il n'y avait rien à faire.
     */
    this.currentVolume = 0;

    /**
     * Fade prioritaire en cours (démarrage ou extinction du bot).
     *
     * Tant qu'il est levé, ni le ducking ni un changement de volume de base
     * ne peuvent écraser la rampe : ce sont précisément ces interventions
     * qui empêchaient les fades d'atteindre le silence.
     */
    this._exclusiveFade = false;

    // Si la queue est en transition ou en restauration, commencer à volume 0
    const queue = queueNode?.queue;
    const initialVol = queue?.restorePaused || queue?.transitioningToEveryone ? 0 : this.baseVolume;
    this._setVolumeImmediate(initialVol);
  }

  /**
   * Définit le volume de base (celui utilisé quand personne ne parle).
   * @param {number} percent - Volume 0-100
   */
  setBaseVolume(percent) {
    this.baseVolume = Math.max(0, Math.min(100, percent));

    // Si on n'est pas ducké et qu'aucun fade n'est en cours, appliquer immédiatement
    if (!this.isDucked && !this._fadeInterval && !this._exclusiveFade) {
      this._setVolumeImmediate(this.baseVolume);
    }
  }

  /**
   * Lance un fade vers le volume ducké.
   * @param {number} duckLevel - Pourcentage du volume de base (ex: 20 = 20% du base)
   * @param {number} fadeDuration - Durée du fade en ms
   */
  duckDown(duckLevel, fadeDuration) {
    this.isDucked = true;
    const targetVol = Math.round(this.baseVolume * (duckLevel / 100));
    this._fadeTo(targetVol, fadeDuration);
  }

  /**
   * Fade d'entrée depuis le silence complet, au démarrage du bot.
   *
   * Le départ est imposé à 0 plutôt que déduit de l'état du lecteur : c'est la
   * seule façon de garantir qu'on parte bien de −∞ dB, y compris quand la file
   * n'a pas encore de dispatcher et que sa lecture de volume ment.
   *
   * La rampe suit une courbe en puissance : à volume linéaire, une montée
   * régulière s'entend comme un saut immédiat, puisque les premiers pourcents
   * couvrent déjà l'essentiel de la dynamique perçue.
   *
   * @param {number} target Volume final (0-100).
   * @param {number} duration Durée en ms.
   */
  fadeInFromSilence(target, duration) {
    this._fadeTo(target, duration, {
      start: 0,
      exponent: 2,
      exclusive: true,
      // Le ducking reprend la main une fois le volume nominal atteint.
      onComplete: () => this.releaseExclusiveFade(),
    });
  }

  /**
   * Réserve le contrôleur à un fade piloté de l'extérieur.
   *
   * L'extinction descend plusieurs files en parallèle avec sa propre courbe :
   * elle applique les paliers elle-même via `_setVolumeImmediate`, mais doit
   * d'abord neutraliser le ducking, sans quoi celui-ci réécrit le volume
   * par-dessus la descente et le silence final ne tient pas.
   */
  reserveForExternalFade() {
    this._cancelFade();
    this._exclusiveFade = true;
  }

  /** Libère le verrou posé par un fade prioritaire. */
  releaseExclusiveFade() {
    this._exclusiveFade = false;
  }

  /**
   * Lance un fade pour restaurer le volume de base.
   * @param {number} fadeDuration - Durée du fade en ms
   */
  duckUp(fadeDuration) {
    this.isDucked = false;
    this._fadeTo(this.baseVolume, fadeDuration);
  }

  /**
   * Transition progressive vers un volume cible.
   *
   * @param {number} target Volume cible (0-100).
   * @param {number} duration Durée en ms.
   * @param {object} [options]
   * @param {number} [options.depart] Volume de départ imposé. Sans lui, on
   *   repart du dernier volume appliqué.
   * @param {number} [options.exposant] Exposant de la courbe de progression.
   *   1 (défaut) donne une rampe linéaire, adaptée au ducking sur de courtes
   *   durées ; au-delà, la rampe colle davantage à la perception.
   * @param {boolean} [options.exclusif] Interdit au ducking d'écraser la rampe
   *   jusqu'à son terme.
   * @param {Function} [options.auTerme] Appelé une fois la cible atteinte.
   */
  _fadeTo(target, duration, options = {}) {
    const { start, exponent = 1, exclusive = false, onComplete = null } = options;

    // Un fade prioritaire en cours ne se laisse pas interrompre par le ducking.
    if (this._exclusiveFade && !exclusive) return;

    this._cancelFade();

    const currentVol = typeof start === 'number' ? start : this.currentVolume;
    this.targetVolume = target;
    if (exclusive) this._exclusiveFade = true;

    // Un départ imposé doit être appliqué même si l'écart est nul : c'est ce
    // qui coupe réellement le son avant une entrée en fondu.
    if (typeof start === 'number') this._setVolumeImmediate(start);

    const finish = () => {
      this._setVolumeImmediate(target);
      this._cancelFade();
      if (onComplete) onComplete();
    };

    // Si la durée est très courte ou le changement est minime, appliquer immédiatement
    if (duration <= 0 || Math.abs(currentVol - target) < 1) {
      finish();
      return;
    }

    const stepInterval = config.ducking.fadeStepInterval;
    const steps = Math.max(1, Math.floor(duration / stepInterval));
    let currentStep = 0;

    this._fadeInterval = setInterval(() => {
      currentStep++;
      if (currentStep >= steps) {
        finish();
        return;
      }

      const progress = Math.pow(currentStep / steps, exponent);
      const newVol = currentVol + (target - currentVol) * progress;
      this._setVolumeImmediate(Math.max(0, Math.min(100, Math.round(newVol))));
    }, stepInterval);
  }

  /**
   * Applique un volume immédiatement sur la queue.
   *
   * La valeur est mémorisée même si le lecteur ne peut pas l'appliquer tout de
   * suite — faute de dispatcher, `setVolume` échoue silencieusement. Elle sera
   * réappliquée par `updateQueueNode` dès qu'un flux existe, et sert entretemps
   * de référence aux fades.
   *
   * @param {number} vol - Volume 0-100
   */
  _setVolumeImmediate(vol) {
    this.currentVolume = Math.max(0, Math.min(100, vol));
    if (this.queueNode) {
      try {
        this.queueNode.setVolume(this.currentVolume);
      } catch (err) {
        log.error('[VolumeController] setVolume error:', err.message);
      }
    }
  }

  /**
   * Annule un fade en cours.
   */
  _cancelFade() {
    if (this._fadeInterval) {
      clearInterval(this._fadeInterval);
      this._fadeInterval = null;
    }
  }

  /**
   * Met à jour le node de la queue lors d'un enchaînement de piste.
   * @param {object} queueNode - Nouveau node de la queue
   */
  updateQueueNode(queueNode) {
    // Un fade de démarrage ou d'extinction survit au changement de node : il
    // est déclenché précisément au moment où les pistes s'enchaînent, et
    // l'interrompre ici le faisait sauter à plein volume.
    if (this._exclusiveFade) {
      this.queueNode = queueNode;
      this._setVolumeImmediate(this.currentVolume);
      return;
    }

    this._cancelFade();
    this.queueNode = queueNode;

    // Si la queue est en transition ou en restauration, forcer à volume 0
    const queue = queueNode?.queue;
    if (queue?.restorePaused || queue?.transitioningToEveryone) {
      this._setVolumeImmediate(0);
    } else {
      const targetVol = this.isDucked ? this.targetVolume : this.baseVolume;
      this._setVolumeImmediate(targetVol);
    }
  }

  /**
   * Nettoie les resources.
   */
  destroy() {
    this._cancelFade();
    this.queueNode = null;
  }
}

module.exports = VolumeController;
