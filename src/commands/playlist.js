/**
 * Commande /playlist — Charger un dossier local comme playlist.
 */

const { SlashCommandBuilder } = require('discord.js');
const { useMainPlayer } = require('discord-player');
const embeds = require('../utils/embeds');
const perms = require('../utils/permissions');
const LocalFilePlayer = require('../audio/LocalFilePlayer');
const log = require('../utils/logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('playlist')
        .setDescription('Charger un dossier de fichiers audio comme playlist')
        .addStringOption(option =>
            option
                .setName('path')
                .setDescription('Chemin vers le dossier contenant les fichiers audio')
                .setRequired(true),
        )
        .addBooleanOption(option =>
            option
                .setName('shuffle')
                .setDescription('Mélanger l\'ordre des morceaux')
                .setRequired(false),
        ),

    async execute(interaction) {
        const dirPath = interaction.options.getString('path');
        const shuffle = interaction.options.getBoolean('shuffle') ?? false;
        const member = interaction.member;

        // Vérifier que l'utilisateur est dans un salon vocal
        if (!perms.isInVoiceChannel(member)) {
            return interaction.reply({
                embeds: [embeds.error('Non connecté', 'Vous devez être dans un salon vocal pour utiliser cette commande.')],
                ephemeral: true,
            });
        }

        const voiceChannel = member.voice.channel;

        // Vérifier les permissions du bot
        const botPerms = perms.checkBotVoicePermissions(voiceChannel, interaction.guild);
        if (!botPerms.canJoin || !botPerms.canSpeak) {
            return interaction.reply({
                embeds: [embeds.error('Permissions manquantes', `Je n'ai pas les permissions nécessaires :\n${botPerms.missing.join(', ')}`)],
                ephemeral: true,
            });
        }

        await interaction.deferReply();

        try {
            // Scanner le dossier
            let audioFiles = LocalFilePlayer.scanDirectory(dirPath);

            if (audioFiles.length === 0) {
                return interaction.followUp({
                    embeds: [embeds.warning('Aucun fichier audio', `Aucun fichier audio trouvé dans :\n\`${dirPath}\``)],
                });
            }

            // Shuffle si demandé
            if (shuffle) {
                audioFiles = LocalFilePlayer.shuffle([...audioFiles]);
            }

            const player = useMainPlayer();

            // Ajouter chaque fichier à la file d'attente
            let addedCount = 0;
            for (const filePath of audioFiles) {
                try {
                    await player.play(voiceChannel, filePath, {
                        nodeOptions: {
                            metadata: interaction,
                            selfDeaf: false,
                            leaveOnEmpty: false,
                            leaveOnEmptyCooldown: 30000,
                            leaveOnEnd: false,
                            leaveOnEndCooldown: 60000,
                        },
                        searchEngine: 'file',
                    });
                    addedCount++;
                } catch (err) {
                    log.warn(`[Playlist] Cannot load: ${filePath}`, err.message);
                }
            }

            return interaction.followUp({
                embeds: [embeds.playlistAdded(addedCount, dirPath)],
            });

        } catch (error) {
            log.error('[Playlist] Error:', error);
            return interaction.followUp({
                embeds: [embeds.error('Erreur', `Impossible de charger le dossier.\n\`${error.message}\``)],
            });
        }
    },
};
