/**
 * Configuration centralisée du bot.
 * Valeurs par défaut pour le ducking, le volume et les constantes.
 */

module.exports = {
  // --- Audio Ducking Defaults ---
  ducking: {
    /** Activer le ducking par défaut */
    enabled: true,
    /** Volume cible quand quelqu'un parle (0-100, pourcentage du volume de base) */
    level: 20,
    /** Délai (ms) avant de restaurer le volume après que tout le monde a arrêté de parler */
    restoreDelay: 800,
    /** Durée (ms) de la transition de volume (fade in/out) */
    fadeDuration: 200,
    /** Intervalle (ms) entre chaque étape du fade */
    fadeStepInterval: 20,
  },

  // --- Volume Defaults ---
  volume: {
    /** Volume de base par défaut (0-100) */
    defaultBase: 70,
    /** Volume minimum autorisé */
    min: 0,
    /** Volume maximum autorisé */
    max: 100,
  },

  // --- Présence dans les salons vocaux ---
  presence: {
    /**
     * Le bot ne rejoint un salon vocal que s'il est habité, et le quitte
     * dès qu'il se vide. Passer à `false` pour qu'il reste connecté en
     * permanence, comme avant.
     */
    enabled: true,
    /**
     * Délai de grâce (ms) avant de quitter un salon devenu vide.
     *
     * Une déconnexion Discord passagère, ou quelqu'un qui change de salon
     * en deux temps, ne doit pas faire partir le bot pour le rappeler dans
     * la seconde.
     *
     * Valeur de repli : chaque serveur peut fixer la sienne depuis le
     * tableau de bord (`presenceDepartureDelay`, en secondes), et celle-ci
     * ne s'applique qu'à défaut.
     */
    departureDelay: 30000,
  },

  // --- Broadcast ---
  broadcast: {
    /** Mode de diffusion par défaut : 'everyone' ou 'personal' */
    defaultMode: 'everyone',
    /** Nom du salon temporaire pour le mode personnel */
    personalChannelPrefix: '🎵',
  },

  // --- Fichiers Audio Supportés ---
  supportedExtensions: ['.mp3', '.flac', '.wav', '.ogg', '.m4a', '.opus', '.aac', '.wma'],

  // --- Fichiers Vidéo Supportés ---
  supportedVideoExtensions: ['.mp4', '.webm', '.mkv', '.avi', '.mov', '.flv', '.m4v', '.3gp', '.ogv', '.wmv'],

  // --- Embeds ---
  colors: {
    primary: 0x5865f2, // Bleu Discord (blurple)
    success: 0x57f287, // Vert
    warning: 0xfee75c, // Jaune
    error: 0xed4245, // Rouge
    music: 0xeb459e, // Rose/Fuchsia
    ducking: 0xe67e22, // Orange
  },
};
