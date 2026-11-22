/**
 * Commande /play — Jouer de la musique depuis une recherche, URL ou fichier local.
 */

const { SlashCommandBuilder } = require('discord.js');
const { useMainPlayer, QueryType } = require('discord-player');
const fs = require('fs');
const path = require('path');
const embeds = require('../utils/embeds');
const perms = require('../utils/permissions');
const LocalFilePlayer = require('../audio/LocalFilePlayer');
const database = require('../database/Database');
const log = require('../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Jouer un morceau (recherche, URL, ou fichier local)')
    .addStringOption((option) =>
      option
        .setName('query')
        .setDescription('Recherche, URL (YouTube/Spotify/Deezer) ou chemin de fichier local')
        .setRequired(true),
    ),

  async execute(interaction) {
    let query = interaction.options.getString('query').trim();
    // Supprimer les guillemets encadrants (fréquents lors du copier-coller de chemin sous Windows)
    if ((query.startsWith('"') && query.endsWith('"')) || (query.startsWith("'") && query.endsWith("'"))) {
      query = query.slice(1, -1).trim();
    }
    const member = interaction.member;

    const broadcastManager = require('../broadcast/BroadcastManager');
    const settings = database.getSettings(interaction.guildId);

    // Si le mode de diffusion est "personal", ajouter le morceau à la queue virtuelle
    if (broadcastManager.getMode(interaction.guildId) === 'personal') {
      await interaction.deferReply();
      try {
        const player = useMainPlayer();
        let queue = player.queues.get(interaction.guildId);
        if (!queue) {
          queue = player.queues.create(interaction.guild, {
            nodeOptions: {
              metadata: { channel: null },
              selfDeaf: false,
              volume: settings.baseVolume,
            },
          });
        }

        const searchResult = await player.search(query, { requestedBy: interaction.user });
        if (searchResult.tracks.length === 0) {
          return interaction.followUp({
            embeds: [embeds.error('Aucun morceau trouvé', `Aucun morceau trouvé pour : \`${query}\``)],
          });
        }

        const tracks = searchResult.tracks;
        const isPlaylist = searchResult.playlist;
        const firstTrack = tracks[0];

        const mapTrack = (t) => ({
          title: t.title,
          author: t.author || 'Inconnu',
          duration: t.duration || '0:00',
          thumbnail: t.thumbnail || null,
          url: t.url,
          queryType: t.queryType || 'youtube',
          extractorName: t.extractor?.identifier || null,
        });

        if (isPlaylist) {
          tracks.forEach((track) => {
            const trackData = mapTrack(track);
            if (!queue.virtualCurrentTrack) {
              queue.virtualCurrentTrack = trackData;
              queue.virtualIsPlaying = true;
              queue.virtualIsPaused = false;
              queue.virtualProgressMs = 0;
              queue.virtualLastUpdated = Date.now();
            } else {
              queue.virtualTracks.push(trackData);
            }
          });
        } else {
          const trackData = mapTrack(firstTrack);
          if (!queue.virtualCurrentTrack) {
            queue.virtualCurrentTrack = trackData;
            queue.virtualIsPlaying = true;
            queue.virtualIsPaused = false;
            queue.virtualProgressMs = 0;
            queue.virtualLastUpdated = Date.now();
          } else {
            queue.virtualTracks.push(trackData);
          }
        }

        // Sauvegarder l'état et notifier les clients web
        const webServer = require('../web/WebServer');
        webServer.broadcastState(interaction.guildId);
        const playbackStateManager = require('../database/PlaybackStateManager');
        playbackStateManager.saveState(player);

        return interaction.followUp({
          embeds: [
            embeds.success(
              '🎧 Ajouté (Mode Personnel)',
              `**${firstTrack.title}** a été ajouté à votre file d'attente virtuelle.\n*Écoutez-le sur le tableau de bord web.*`,
            ),
          ],
        });
      } catch (error) {
        log.error('[Play personal] Error:', error);
        return interaction.followUp({
          embeds: [embeds.error('Erreur', `Impossible d'ajouter en mode personnel : ${error.message}`)],
        });
      }
    }

    // --- Mode de diffusion Tout le monde (everyone) ---
    // Vérifier que l'utilisateur est dans un salon vocal
    if (!perms.isInVoiceChannel(member)) {
      return interaction.reply({
        embeds: [embeds.error('Non connecté', 'Vous devez être dans un salon vocal pour utiliser cette commande.')],
        ephemeral: true,
      });
    }

    const userChannel = member.voice.channel;

    // Vérifier les permissions du bot sur le salon initial de l'utilisateur
    const botPerms = perms.checkBotVoicePermissions(userChannel, interaction.guild);
    if (!botPerms.canJoin || !botPerms.canSpeak) {
      return interaction.reply({
        embeds: [
          embeds.error(
            'Permissions manquantes',
            `Je n'ai pas les permissions nécessaires :\n${botPerms.missing.join(', ')}`,
          ),
        ],
        ephemeral: true,
      });
    }

    let voiceChannel = userChannel;
    await interaction.deferReply();

    try {
      const player = useMainPlayer();

      const settings = database.getSettings(interaction.guildId);

      // Vérifier si c'est un fichier local
      const resolvedPath = path.resolve(query);
      if (fs.existsSync(resolvedPath) && LocalFilePlayer.isAudioFile(resolvedPath)) {
        const trackInfo = LocalFilePlayer.getTrackInfo(resolvedPath);
        log.info(`[Play] Local file detected: ${resolvedPath}`);

        // Utiliser discord-player avec le type Attachment pour les fichiers locaux
        const result = await player.play(voiceChannel, resolvedPath, {
          nodeOptions: {
            metadata: interaction,
            selfDeaf: false,
            leaveOnEmpty: false,
            leaveOnEmptyCooldown: 30000,
            leaveOnEnd: false,
            leaveOnEndCooldown: 60000,
            volume: settings.baseVolume,
          },
          searchEngine: QueryType.FILE,
        });

        log.debug(`[Play] Result: track=${result.track?.title}, searchResult=${result.searchResult?.hasPlaylist()}`);

        return interaction.followUp({
          embeds: [embeds.success('▶️ En lecture', `**${trackInfo.title}**\n*Source : fichier local*`)],
        });
      }

      // Recherche via discord-player (YouTube, Spotify, Deezer, etc.)
      const result = await player.play(voiceChannel, query, {
        nodeOptions: {
          metadata: interaction,
          selfDeaf: false,
          leaveOnEmpty: false,
          leaveOnEmptyCooldown: 30000,
          leaveOnEnd: false,
          leaveOnEndCooldown: 60000,
          volume: settings.baseVolume,
        },
      });

      const track = result.track;

      const embed = embeds.nowPlaying({
        title: track.title,
        author: track.author,
        duration: track.duration,
        thumbnail: track.thumbnail,
        source: track.source || track.extractor?.identifier || 'Inconnu',
      });

      return interaction.followUp({ embeds: [embed] });
    } catch (error) {
      log.error('[Play] Error:', error);
      return interaction.followUp({
        embeds: [embeds.error('Erreur de lecture', `Impossible de jouer ce morceau.\n\`${error.message}\``)],
      });
    }
  },
};
