/**
 * Commande /ducking — Configurer l'audio ducking.
 */

const { SlashCommandBuilder } = require('discord.js');
const embeds = require('../utils/embeds');
const database = require('../database/Database');
const config = require('../config');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('ducking')
        .setDescription('Configurer le ducking audio (réduction du volume quand quelqu\'un parle)')
        .addSubcommand(sub =>
            sub.setName('toggle')
                .setDescription('Activer ou désactiver le ducking'),
        )
        .addSubcommand(sub =>
            sub.setName('level')
                .setDescription('Volume quand quelqu\'un parle (% du volume de base)')
                .addIntegerOption(opt =>
                    opt.setName('percent')
                        .setDescription('Pourcentage du volume de base (ex: 20 = volume réduit à 20%)')
                        .setRequired(true)
                        .setMinValue(0)
                        .setMaxValue(100),
                ),
        )
        .addSubcommand(sub =>
            sub.setName('delay')
                .setDescription('Délai avant restauration du volume (en ms)')
                .addIntegerOption(opt =>
                    opt.setName('ms')
                        .setDescription('Délai en millisecondes (ex: 800)')
                        .setRequired(true)
                        .setMinValue(0)
                        .setMaxValue(5000),
                ),
        )
        .addSubcommand(sub =>
            sub.setName('fade')
                .setDescription('Durée de la transition de volume (en ms)')
                .addIntegerOption(opt =>
                    opt.setName('ms')
                        .setDescription('Durée du fondu en millisecondes (ex: 200)')
                        .setRequired(true)
                        .setMinValue(0)
                        .setMaxValue(2000),
                ),
        )
        .addSubcommand(sub =>
            sub.setName('status')
                .setDescription('Afficher la configuration actuelle du ducking'),
        ),

    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();
        const guildId = interaction.guildId;

        switch (subcommand) {
            case 'toggle': {
                const settings = database.getSettings(guildId);
                const newState = !settings.duckingEnabled;
                database.updateSettings(guildId, { duckingEnabled: newState });

                // Rafraîchir le DuckingManager en live
                const duckingManager = interaction.client.duckingManagers?.get(guildId);
                if (duckingManager) {
                    duckingManager.refresh();
                }

                const stateText = newState ? 'activé ✅' : 'désactivé ❌';
                return interaction.reply({
                    embeds: [embeds.success('Ducking', `Le ducking a été **${stateText}**.`)],
                });
            }

            case 'level': {
                const percent = interaction.options.getInteger('percent');
                database.updateSettings(guildId, { duckingLevel: percent });

                const duckingManager = interaction.client.duckingManagers?.get(guildId);
                if (duckingManager) {
                    duckingManager.refresh();
                } else {
                    try {
                        const webServer = require('../web/WebServer');
                        webServer.broadcastState(guildId);
                    } catch {}
                }

                return interaction.reply({
                    embeds: [embeds.success('Ducking — Niveau', `Le volume sera réduit à **${percent}%** quand quelqu'un parle.`)],
                });
            }

            case 'delay': {
                const ms = interaction.options.getInteger('ms');
                database.updateSettings(guildId, { duckingDelay: ms });

                const duckingManager = interaction.client.duckingManagers?.get(guildId);
                if (duckingManager) {
                    duckingManager.refresh();
                } else {
                    try {
                        const webServer = require('../web/WebServer');
                        webServer.broadcastState(guildId);
                    } catch {}
                }

                return interaction.reply({
                    embeds: [embeds.success('Ducking — Délai', `Le volume sera restauré **${ms}ms** après la fin de la parole.`)],
                });
            }

            case 'fade': {
                const ms = interaction.options.getInteger('ms');
                database.updateSettings(guildId, { duckingFade: ms });

                const duckingManager = interaction.client.duckingManagers?.get(guildId);
                if (duckingManager) {
                    duckingManager.refresh();
                } else {
                    try {
                        const webServer = require('../web/WebServer');
                        webServer.broadcastState(guildId);
                    } catch {}
                }

                return interaction.reply({
                    embeds: [embeds.success('Ducking — Fondu', `La transition de volume durera **${ms}ms**.`)],
                });
            }

            case 'status': {
                const settings = database.getSettings(guildId);
                return interaction.reply({
                    embeds: [embeds.duckingStatus(settings)],
                });
            }
        }
    },
};
