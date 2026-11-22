/**
 * Commande /queue, /skip, /stop, /pause, /resume — Contrôle de la file d'attente.
 */

const { SlashCommandBuilder } = require('discord.js');
const { useQueue } = require('discord-player');
const embeds = require('../utils/embeds');
const perms = require('../utils/permissions');

// --- /queue ---
const queueCommand = {
  data: new SlashCommandBuilder()
    .setName('queue')
    .setDescription("Afficher la file d'attente")
    .addIntegerOption((option) =>
      option.setName('page').setDescription('Numéro de page').setRequired(false).setMinValue(1),
    ),

  async execute(interaction) {
    const queue = useQueue(interaction.guildId);

    if (!queue || !queue.isPlaying()) {
      return interaction.reply({
        embeds: [embeds.warning('File vide', "Aucune musique n'est en cours de lecture.")],
        ephemeral: true,
      });
    }

    const currentTrack = queue.currentTrack;
    const tracks = queue.tracks.toArray();
    const page = Math.max(0, (interaction.options.getInteger('page') || 1) - 1);
    const totalPages = Math.max(1, Math.ceil(tracks.length / 10));
    const clampedPage = Math.min(page, totalPages - 1);

    return interaction.reply({
      embeds: [
        embeds.queue(
          currentTrack ? { title: currentTrack.title, duration: currentTrack.duration } : null,
          tracks.map((t) => ({ title: t.title, duration: t.duration })),
          clampedPage,
          totalPages,
        ),
      ],
    });
  },
};

// --- /skip ---
const skipCommand = {
  data: new SlashCommandBuilder().setName('skip').setDescription('Passer au morceau suivant'),

  async execute(interaction) {
    if (!perms.isInVoiceChannel(interaction.member)) {
      return interaction.reply({
        embeds: [embeds.error('Non connecté', 'Vous devez être dans un salon vocal.')],
        ephemeral: true,
      });
    }

    const queue = useQueue(interaction.guildId);

    if (!queue || !queue.isPlaying()) {
      return interaction.reply({
        embeds: [embeds.warning('Rien à passer', 'Aucune musique en cours.')],
        ephemeral: true,
      });
    }

    const currentTitle = queue.currentTrack?.title || 'Inconnu';
    queue.node.skip();

    return interaction.reply({
      embeds: [embeds.success('Morceau passé', `⏭️ **${currentTitle}** a été passé.`)],
    });
  },
};

// --- /stop ---
const stopCommand = {
  data: new SlashCommandBuilder().setName('stop').setDescription("Arrêter la musique et vider la file d'attente"),

  async execute(interaction) {
    if (!perms.isInVoiceChannel(interaction.member)) {
      return interaction.reply({
        embeds: [embeds.error('Non connecté', 'Vous devez être dans un salon vocal.')],
        ephemeral: true,
      });
    }

    const queue = useQueue(interaction.guildId);

    if (!queue) {
      return interaction.reply({
        embeds: [embeds.warning('Rien à arrêter', 'Aucune musique en cours.')],
        ephemeral: true,
      });
    }

    queue.delete();

    return interaction.reply({
      embeds: [embeds.success('Musique arrêtée', '⏹️ La lecture a été arrêtée et la file vidée.')],
    });
  },
};

// --- /pause ---
const pauseCommand = {
  data: new SlashCommandBuilder().setName('pause').setDescription('Mettre la musique en pause'),

  async execute(interaction) {
    if (!perms.isInVoiceChannel(interaction.member)) {
      return interaction.reply({
        embeds: [embeds.error('Non connecté', 'Vous devez être dans un salon vocal.')],
        ephemeral: true,
      });
    }

    const queue = useQueue(interaction.guildId);

    if (!queue || !queue.isPlaying()) {
      return interaction.reply({
        embeds: [embeds.warning('Rien à pauser', 'Aucune musique en cours.')],
        ephemeral: true,
      });
    }

    if (queue.node.isPaused()) {
      return interaction.reply({
        embeds: [embeds.warning('Déjà en pause', 'La musique est déjà en pause. Utilisez `/resume` pour reprendre.')],
        ephemeral: true,
      });
    }

    queue.node.pause();

    return interaction.reply({
      embeds: [embeds.success('Pause', `⏸️ **${queue.currentTrack?.title || 'Musique'}** est en pause.`)],
    });
  },
};

// --- /resume ---
const resumeCommand = {
  data: new SlashCommandBuilder().setName('resume').setDescription('Reprendre la musique'),

  async execute(interaction) {
    if (!perms.isInVoiceChannel(interaction.member)) {
      return interaction.reply({
        embeds: [embeds.error('Non connecté', 'Vous devez être dans un salon vocal.')],
        ephemeral: true,
      });
    }

    const queue = useQueue(interaction.guildId);

    if (!queue) {
      return interaction.reply({
        embeds: [embeds.warning('Rien à reprendre', 'Aucune musique en cours.')],
        ephemeral: true,
      });
    }

    if (!queue.node.isPaused()) {
      return interaction.reply({
        embeds: [embeds.warning('Pas en pause', "La musique n'est pas en pause.")],
        ephemeral: true,
      });
    }

    queue.node.resume();

    return interaction.reply({
      embeds: [embeds.success('Reprise', `▶️ **${queue.currentTrack?.title || 'Musique'}** reprend.`)],
    });
  },
};

module.exports = { queueCommand, skipCommand, stopCommand, pauseCommand, resumeCommand };
