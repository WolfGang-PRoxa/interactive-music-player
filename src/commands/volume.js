/**
 * Commande /volume — Régler le volume de la musique.
 */

const { SlashCommandBuilder } = require('discord.js');
const { useQueue } = require('discord-player');
const embeds = require('../utils/embeds');
const perms = require('../utils/permissions');
const database = require('../database/Database');
const config = require('../config');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Régler le volume de la musique')
    .addIntegerOption((option) =>
      option
        .setName('level')
        .setDescription('Niveau de volume (0-100)')
        .setRequired(true)
        .setMinValue(config.volume.min)
        .setMaxValue(config.volume.max),
    ),

  async execute(interaction) {
    if (!perms.isInVoiceChannel(interaction.member)) {
      return interaction.reply({
        embeds: [embeds.error('Non connecté', 'Vous devez être dans un salon vocal.')],
        ephemeral: true,
      });
    }

    const level = interaction.options.getInteger('level');
    const queue = useQueue(interaction.guildId);

    // Sauvegarder en base
    database.updateSettings(interaction.guildId, { baseVolume: level });

    // Appliquer au player si en cours de lecture
    if (queue && queue.isPlaying()) {
      queue.node.setVolume(level);
    }

    // Mettre à jour le VolumeController si disponible
    const duckingManager = interaction.client.duckingManagers?.get(interaction.guildId);
    if (duckingManager?.volumeController) {
      duckingManager.volumeController.setBaseVolume(level);
    }

    // Informer le Dashboard web de la mise à jour
    try {
      const webServer = require('../web/WebServer');
      webServer.broadcastState(interaction.guildId);
    } catch (err) {
      // Ignorer
    }

    return interaction.reply({
      embeds: [embeds.volume(level)],
    });
  },
};
