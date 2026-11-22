/**
 * Embeds Discord stylisés pour le bot de musique.
 *
 * Les titres n'utilisent pas d'émoji : la distinction visuelle repose sur la
 * couleur de l'encadré, définie dans config.colors.
 */

const { EmbedBuilder } = require('discord.js');
const config = require('../config');

const embeds = {
  /**
   * Embed "Now Playing" avec barre de progression.
   */
  nowPlaying(track, queue) {
    const embed = new EmbedBuilder()
      .setColor(config.colors.music)
      .setTitle('En cours de lecture')
      .setDescription(`**${track.title}**`)
      .setTimestamp();

    if (track.author) {
      embed.addFields({ name: 'Artiste', value: track.author, inline: true });
    }
    if (track.duration) {
      embed.addFields({ name: 'Durée', value: track.duration, inline: true });
    }
    if (track.source) {
      embed.addFields({ name: 'Source', value: track.source, inline: true });
    }
    if (track.thumbnail) {
      embed.setThumbnail(track.thumbnail);
    }
    if (queue) {
      embed.setFooter({ text: `${queue.tracks.size} morceau(x) dans la file d'attente` });
    }

    return embed;
  },

  /**
   * Embed pour la file d'attente.
   */
  queue(currentTrack, tracks, page = 0, totalPages = 1) {
    const embed = new EmbedBuilder().setColor(config.colors.primary).setTitle("File d'attente");

    let description = '';

    if (currentTrack) {
      description += `**En cours :** ${currentTrack.title}\n\n`;
    }

    if (tracks.length === 0) {
      description += "*La file d'attente est vide.*";
    } else {
      const startIndex = page * 10;
      const pageItems = tracks.slice(startIndex, startIndex + 10);

      description += pageItems
        .map((track, i) => {
          const idx = startIndex + i + 1;
          return `**${idx}.** ${track.title}${track.duration ? ` (${track.duration})` : ''}`;
        })
        .join('\n');
    }

    embed.setDescription(description);
    embed.setFooter({ text: `Page ${page + 1}/${totalPages} • ${tracks.length} morceau(x) au total` });

    return embed;
  },

  /**
   * Embed pour la configuration du ducking.
   */
  duckingStatus(settings) {
    const statusText = settings.duckingEnabled ? 'Activé' : 'Désactivé';

    return new EmbedBuilder()
      .setColor(config.colors.ducking)
      .setTitle('Configuration du Ducking')
      .addFields(
        { name: 'État', value: statusText, inline: true },
        { name: 'Niveau de réduction', value: `${settings.duckingLevel}%`, inline: true },
        { name: 'Volume de base', value: `${settings.baseVolume}%`, inline: true },
        { name: 'Délai de restauration', value: `${settings.duckingDelay}ms`, inline: true },
        { name: 'Durée du fondu', value: `${settings.duckingFade}ms`, inline: true },
      )
      .setFooter({ text: 'Utilisez /ducking pour modifier ces paramètres' })
      .setTimestamp();
  },

  /**
   * Embed de succès générique.
   */
  success(title, description) {
    return new EmbedBuilder()
      .setColor(config.colors.success)
      .setTitle(title)
      .setDescription(description || null)
      .setTimestamp();
  },

  /**
   * Embed d'erreur générique.
   */
  error(title, description) {
    return new EmbedBuilder()
      .setColor(config.colors.error)
      .setTitle(title)
      .setDescription(description || null)
      .setTimestamp();
  },

  /**
   * Embed d'avertissement générique.
   */
  warning(title, description) {
    return new EmbedBuilder()
      .setColor(config.colors.warning)
      .setTitle(title)
      .setDescription(description || null)
      .setTimestamp();
  },

  /**
   * Embed pour le volume.
   */
  volume(level) {
    return new EmbedBuilder()
      .setColor(config.colors.primary)
      .setTitle('Volume')
      .setDescription(`Volume réglé à **${level}%**`)
      .setTimestamp();
  },

  /**
   * Embed pour le mode broadcast.
   */
  broadcast(mode) {
    const modeText =
      mode === 'everyone'
        ? '**Tout le monde** — La musique est diffusée à tous les participants du salon.'
        : '**Personnel** — Chaque utilisateur reçoit la musique dans un salon privé temporaire.';

    return new EmbedBuilder()
      .setColor(config.colors.primary)
      .setTitle('Mode de diffusion')
      .setDescription(modeText)
      .setTimestamp();
  },

  /**
   * Embed pour les morceaux ajoutés (playlist locale).
   */
  playlistAdded(count, dirPath) {
    return new EmbedBuilder()
      .setColor(config.colors.success)
      .setTitle('Playlist chargée')
      .setDescription(`**${count}** morceau(x) ajouté(s) depuis :\n\`${dirPath}\``)
      .setTimestamp();
  },
};

module.exports = embeds;
