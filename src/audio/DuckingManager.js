/**
 * DuckingManager — Gestion de l'audio ducking (réduction du volume quand quelqu'un parle).
 *
 * Algorithme :
 * 1. Écoute les événements speaking 'start' et 'end' du VoiceReceiver
 * 2. Maintient un Set<userId> des speakers actifs
 * 3. Quand le Set passe de vide → non-vide : fade-down (baisser le volume)
 * 4. Quand le Set redevient vide : démarre un timer de délai
 * 5. Après le délai (debounce) : fade-up (restaurer le volume)
 */

const database = require('../database/Database');
const log = require('../utils/logger');

class DuckingManager {
  /**
   * @param {string} guildId - ID de la guild
   * @param {string} channelId - ID du salon vocal actif
   * @param {import('@discordjs/voice').VoiceConnection} connection - Connexion vocale
   * @param {import('./VolumeController')} volumeController - Contrôleur de volume
   */
  constructor(guildId, channelId, connection, volumeController) {
    this.guildId = guildId;
    this.channelId = channelId;
    this.connection = connection;
    this.volumeController = volumeController;

    /** Set des user IDs en train de parler */
    this.activeSpeakers = new Set();

    /** Timer de restauration du volume */
    this._restoreTimer = null;

    /** Listeners references pour cleanup */
    this._onSpeakingStart = null;
    this._onSpeakingEnd = null;

    /** Est-ce que le ducking est actif ? */
    this._active = false;

    this._setupListeners();
  }

  /**
   * Configure les listeners sur les événements speaking du VoiceReceiver.
   */
  _setupListeners() {
    this._active = true;

    /*
     * Une connexion sans oreille.
     *
     * Le ducking suppose que la connexion vocale sache *recevoir*, ce qui
     * n'a rien d'acquis : discord-player s'appuie sur `discord-voip`, un
     * embranchement de `@discordjs/voice` réduit à la diffusion, dont les
     * connexions n'ont pas de `receiver` du tout. Le paquet de dépendances
     * du projet redirige ce nom vers `@discordjs/voice`, mais npm range
     * volontiers une copie propre à discord-player sous son dossier, où
     * cette redirection ne s'applique pas.
     *
     * Le cas est donc réel, et il coûtait cher : la lecture de
     * `receiver.speaking` levait une exception qui remontait à travers
     * `setupDucking`, emportant avec elle tout ce qui la suivait — le
     * contrôleur de volume et le diffuseur de silence. Le journal ne
     * montrait qu'un « Cannot read properties of undefined » sans rapport
     * apparent avec le son, et le ducking paraissait simplement inerte.
     *
     * Mieux vaut le dire, et laisser le reste s'installer.
     */
    const receiver = this.connection?.receiver;
    if (!receiver?.speaking) {
      log.warn(
        '[Ducking] Voice connection without a receiver: nobody can be heard ' +
          'speaking, so ducking stays inert. The « discord-voip » package resolved ' +
          'by discord-player must be « @discordjs/voice » for this to work.',
      );
      // `_active` reste levé : le gestionnaire est bien en place, et une
      // connexion ultérieure pourvue d'un receiver doit pouvoir être
      // écoutée. L'abaisser ici ferait renoncer `updateConnection()`.
      return;
    }

    this._onSpeakingStart = (userId) => {
      this._handleSpeakingStart(userId);
    };

    this._onSpeakingEnd = (userId) => {
      this._handleSpeakingEnd(userId);
    };

    receiver.speaking.on('start', this._onSpeakingStart);
    receiver.speaking.on('end', this._onSpeakingEnd);
  }

  /**
   * Appelé quand un utilisateur commence à parler.
   * @param {string} userId
   */
  _handleSpeakingStart(userId) {
    log.debug(`[Ducking Debug] Speech detected — start for user: ${userId}`);
    this.activeSpeakers.add(userId);

    // Vérifier si cet utilisateur est ignoré pour le ducking
    const isIgnored = database.isVoiceDetectionDisabled(this.guildId, this.channelId, userId);

    const settings = database.getSettings(this.guildId);
    if (settings.duckingEnabled && !isIgnored) {
      // Compter les speakers actifs non-ignorés
      const activeNonIgnored = this._countActiveNonIgnored();

      // Cancel any pending restore
      this._cancelRestoreTimer();

      // Si c'est le premier speaker non-ignoré, déclencher le duck down
      if (activeNonIgnored === 1) {
        log.debug(`[Ducking Debug] Lowering volume (duckDown) to ${settings.duckingLevel}%`);
        this.volumeController.duckDown(settings.duckingLevel, settings.duckingFade);
      }
    }

    // Informer le serveur web en temps réel
    this._notifyDashboard();
  }

  /**
   * Appelé quand un utilisateur arrête de parler.
   * @param {string} userId
   */
  _handleSpeakingEnd(userId) {
    log.debug(`[Ducking Debug] Speech detected — end for user: ${userId}`);
    this.activeSpeakers.delete(userId);

    const settings = database.getSettings(this.guildId);
    if (settings.duckingEnabled) {
      // Compter les speakers actifs non-ignorés
      const activeNonIgnored = this._countActiveNonIgnored();

      // Si plus aucun speaker non-ignoré ne parle, restaurer le volume
      if (activeNonIgnored === 0) {
        log.debug(`[Ducking Debug] Volume restore scheduled in ${settings.duckingDelay}ms`);
        this._scheduleRestore(settings.duckingDelay, settings.duckingFade);
      }
    }

    // Informer le serveur web en temps réel
    this._notifyDashboard();
  }

  /**
   * Programme la restauration du volume avec un délai (debounce).
   * @param {number} delay - Délai en ms
   * @param {number} fadeDuration - Durée du fade en ms
   */
  _scheduleRestore(delay, fadeDuration) {
    this._cancelRestoreTimer();

    this._restoreTimer = setTimeout(() => {
      // Double-check : personne ne parle encore ?
      if (this.activeSpeakers.size === 0) {
        this.volumeController.duckUp(fadeDuration);
      }
      this._restoreTimer = null;
    }, delay);
  }

  /**
   * Annule le timer de restauration en cours.
   */
  _cancelRestoreTimer() {
    if (this._restoreTimer) {
      clearTimeout(this._restoreTimer);
      this._restoreTimer = null;
    }
  }

  /**
   * Active le ducking (reconnecte les listeners).
   */
  enable() {
    if (this._active) return;
    this._removeListeners();
    this._setupListeners();
  }

  /**
   * Désactive le ducking (déconnecte les listeners et restaure le volume).
   */
  disable() {
    this._active = false;
    this._removeListeners();
    this._cancelRestoreTimer();
    this.activeSpeakers.clear();

    // Restaurer le volume immédiatement
    this.volumeController.duckUp(0);
  }

  /**
   * Rafraîchit la configuration (appelé après changement de settings).
   */
  refresh() {
    const settings = database.getSettings(this.guildId);

    if (!settings.duckingEnabled) {
      this._cancelRestoreTimer();
      // Restaurer le volume immédiatement
      this.volumeController.duckUp(0);
    } else {
      // Si quelqu'un parle déjà (non-ignoré), on applique immédiatement la réduction
      const activeNonIgnored = this._countActiveNonIgnored();
      if (activeNonIgnored > 0) {
        this._cancelRestoreTimer();
        this.volumeController.duckDown(settings.duckingLevel, 0);
      } else {
        // Plus aucun speaker non-ignoré, restaurer
        this.volumeController.duckUp(0);
      }
    }

    // Mettre à jour la baseVolume dans le contrôleur de volume
    if (this.volumeController) {
      this.volumeController.setBaseVolume(settings.baseVolume);
    }

    // Informer le serveur web en temps réel
    try {
      const webServer = require('../web/WebServer');
      webServer.broadcastState(this.guildId);
    } catch (err) {
      // Ignorer
    }
  }

  /**
   * Compte le nombre de speakers actifs dont la détection n'est pas désactivée.
   * @returns {number}
   */
  _countActiveNonIgnored() {
    let count = 0;
    for (const userId of this.activeSpeakers) {
      if (!database.isVoiceDetectionDisabled(this.guildId, this.channelId, userId)) {
        count++;
      }
    }
    return count;
  }

  /**
   * Met à jour le channelId (ex: si le bot change de salon).
   * @param {string} channelId
   */
  setChannelId(channelId) {
    this.channelId = channelId;
  }

  /**
   * Met à jour la connexion vocale et réenregistre les écouteurs d'événements.
   * @param {import('@discordjs/voice').VoiceConnection} connection
   */
  updateConnection(connection) {
    if (this.connection === connection) return;
    log.info(`[Ducking] Updating the voice connection for guild ${this.guildId}`);
    this._removeListeners();
    this.connection = connection;
    // Ce que l'ancienne connexion avait vu ne vaut plus rien : un « fin de
    // parole » ne viendra jamais par un canal qui n'existe plus. Les
    // locuteurs restés inscrits animeraient indéfiniment le tableau de bord,
    // et tiendraient le volume baissé sans que personne ne parle.
    this.forgetSpeakers();
    if (this._active) {
      this._setupListeners();
    }
  }

  /**
   * Oublie tout le monde et remonte le volume s'il était baissé pour rien.
   *
   * Discord n'annonce pas la fin d'une parole interrompue par un départ du
   * salon ou par une coupure de connexion : sans ce ménage, un locuteur reste
   * inscrit pour toujours.
   */
  forgetSpeakers() {
    if (this.activeSpeakers.size === 0) return;
    this.activeSpeakers.clear();
    this._cancelRestoreTimer();

    const settings = database.getSettings(this.guildId);
    if (settings.duckingEnabled && this.volumeController) {
      this.volumeController.duckUp(settings.duckingFade);
    }
    this._notifyDashboard();
  }

  /**
   * Retire un utilisateur des locuteurs, et relève le volume si c'était le
   * dernier. Appelé quand quelqu'un quitte le salon — micro ouvert compris.
   *
   * @param {string} userId
   * @returns {boolean} true si l'utilisateur y figurait
   */
  forgetSpeaker(userId) {
    if (!this.activeSpeakers.delete(userId)) return false;
    log.debug(`[Ducking Debug] Speaker ${userId} dropped: they left the channel while speaking.`);

    const settings = database.getSettings(this.guildId);
    if (settings.duckingEnabled && this._countActiveNonIgnored() === 0) {
      this._scheduleRestore(settings.duckingDelay, settings.duckingFade);
    }
    this._notifyDashboard();
    return true;
  }

  /**
   * Pousse l'état au tableau de bord.
   *
   * Le module exporte l'instance du serveur, pas la classe : le
   * `WebServer.instance` qu'on lisait ici était une propriété statique posée
   * sur la classe, invisible depuis l'instance — donc toujours `undefined`.
   * Chaque début et chaque fin de parole retombait ainsi dans le vide, et le
   * tableau de bord n'apprenait qui parlait qu'au prochain état diffusé pour
   * une autre raison. C'est ce qui privait d'animation la boîte « Activité
   * vocale », et de toute atténuation la diffusion personnelle, où c'est le
   * navigateur qui baisse le son sur la foi de cet état.
   */
  _notifyDashboard() {
    try {
      const webServer = require('../web/WebServer');
      webServer.broadcastSpeakers(this.guildId);
    } catch (err) {
      // Serveur web non démarré : rien à notifier.
    }
  }

  /**
   * Supprime les listeners du receiver.
   */
  _removeListeners() {
    // Même prudence qu'à la pose : sans receiver, aucun écouteur n'a été
    // posé, et le retrait n'a rien à défaire.
    const speaking = this.connection?.receiver?.speaking;
    if (speaking && this._onSpeakingStart) {
      speaking.removeListener('start', this._onSpeakingStart);
    }
    if (speaking && this._onSpeakingEnd) {
      speaking.removeListener('end', this._onSpeakingEnd);
    }
    this._onSpeakingStart = null;
    this._onSpeakingEnd = null;
  }

  /**
   * Nettoie toutes les ressources.
   */
  destroy() {
    this._removeListeners();
    this._cancelRestoreTimer();
    this.activeSpeakers.clear();
    this.connection = null;
    this.volumeController = null;
  }
}

module.exports = DuckingManager;
