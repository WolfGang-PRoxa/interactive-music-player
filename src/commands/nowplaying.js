/**
 * Commande /nowplaying — Afficher le morceau en cours.
 */

const { SlashCommandBuilder } = require('discord.js');
const { useQueue } = require('discord-player');
const embeds = require('../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder().setName('nowplaying').setDescription('Afficher le morceau en cours de lecture'),

  async execute(interaction) {
    const queue = useQueue(interaction.guildId);

    if (!queue || !queue.isPlaying()) {
      return interaction.reply({
        embeds: [embeds.warning('Rien en cours', "Aucune musique n'est en cours de lecture.")],
        ephemeral: true,
      });
    }

    const track = queue.currentTrack;

    if (!track) {
      return interaction.reply({
        embeds: [embeds.warning('Rien en cours', "Aucune musique n'est en cours de lecture.")],
        ephemeral: true,
      });
    }

    const progressBar = queue.node.createProgressBar({
      timecodes: true,
      queue: false,
      length: 15,
      indicator: '🔵',
      leftChar: '▬',
      rightChar: '▬',
    });

    const embed = embeds.nowPlaying({
      title: track.title,
      author: track.author,
      duration: track.duration,
      thumbnail: track.thumbnail,
      source: track.source || track.extractor?.identifier || 'Inconnu',
    });

    // Ajouter la barre de progression
    if (progressBar) {
      embed.addFields({ name: 'Progression', value: progressBar });
    }

    return interaction.reply({ embeds: [embed] });
  },
};
