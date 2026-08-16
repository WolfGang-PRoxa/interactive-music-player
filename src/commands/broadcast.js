/**
 * Commande /broadcast — Changer le mode de diffusion (admin uniquement).
 */

const { SlashCommandBuilder } = require('discord.js');
const embeds = require('../utils/embeds');
const perms = require('../utils/permissions');
const broadcastManager = require('../broadcast/BroadcastManager');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('broadcast')
        .setDescription('Configurer le mode de diffusion (admin uniquement)')
        .addStringOption(option =>
            option
                .setName('mode')
                .setDescription('Mode de diffusion')
                .setRequired(true)
                .addChoices(
                    { name: '🔊 Tout le monde — Musique pour tous', value: 'everyone' },
                    { name: '🎧 Personnel — Salon privé temporaire', value: 'personal' },
                ),
        ),

    async execute(interaction) {
        // Vérifier les permissions admin
        if (!perms.isAdmin(interaction.member)) {
            return interaction.reply({
                embeds: [embeds.error('Permission refusée', 'Seuls les administrateurs peuvent modifier le mode de diffusion.')],
                ephemeral: true,
            });
        }

        const mode = interaction.options.getString('mode');

        // Pour le mode personnel, vérifier que le bot peut gérer les salons
        if (mode === 'personal' && !perms.canManageChannels(interaction.guild)) {
            return interaction.reply({
                embeds: [embeds.error(
                    'Permission bot manquante',
                    'J\'ai besoin de la permission **Gérer les salons** pour créer des salons vocaux temporaires.',
                )],
                ephemeral: true,
            });
        }

        broadcastManager.setMode(interaction.guildId, mode);

        // Informer le Dashboard web de la mise à jour
        try {
            const webServer = require('../web/WebServer');
            webServer.broadcastState(interaction.guildId);
        } catch (err) {
            // Ignorer
        }

        return interaction.reply({
            embeds: [embeds.broadcast(mode)],
        });
    },
};
