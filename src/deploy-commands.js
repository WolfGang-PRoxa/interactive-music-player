/**
 * Script d'enregistrement des slash commands auprès de l'API Discord.
 * 
 * Usage : node src/deploy-commands.js
 * 
 * Enregistre toutes les commandes globalement (disponibles dans tous les serveurs).
 * Note : Les commandes globales peuvent prendre jusqu'à 1h pour se propager.
 * Pour un test rapide, ajoutez GUILD_ID dans .env pour un enregistrement par serveur (instantané).
 */

require('dotenv').config();

const { REST, Routes } = require('discord.js');
const path = require('path');
const fs = require('fs');
const log = require('./utils/logger');

// --- Validate env ---
if (!process.env.DISCORD_TOKEN || !process.env.DISCORD_CLIENT_ID) {
    log.error('[FATAL] DISCORD_TOKEN and DISCORD_CLIENT_ID are required in .env');
    process.exit(1);
}

// --- Collect commands ---
const commands = [];
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'));

for (const file of commandFiles) {
    const command = require(path.join(commandsPath, file));

    // queue.js exports multiple commands
    if (file === 'queue.js') {
        const { queueCommand, skipCommand, stopCommand, pauseCommand, resumeCommand } = command;
        commands.push(queueCommand.data.toJSON());
        commands.push(skipCommand.data.toJSON());
        commands.push(stopCommand.data.toJSON());
        commands.push(pauseCommand.data.toJSON());
        commands.push(resumeCommand.data.toJSON());
    } else if (command.data) {
        commands.push(command.data.toJSON());
    }
}

log.info(`[Deploy] ${commands.length} commands found:`);
commands.forEach(cmd => log.info(`  • /${cmd.name} — ${cmd.description}`));

// --- Deploy ---
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
    try {
        const guildId = process.env.GUILD_ID;

        if (guildId) {
            // Guild-specific deployment (instantané, pour les tests)
            log.info(`\n[Deploy] Registering for guild ${guildId}...`);
            const data = await rest.put(
                Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, guildId),
                { body: commands },
            );
            log.info(`[Deploy] ✅ ${data.length} commands registered (guild).`);
        } else {
            // Global deployment (peut prendre jusqu'à 1h)
            log.info('\n[Deploy] Enregistrement global...');
            log.info('[Deploy] ⚠ Global commands can take up to an hour to propagate.');
            log.info('[Deploy] 💡 Tip: add GUILD_ID=xxx to .env for instant registration.\n');
            const data = await rest.put(
                Routes.applicationCommands(process.env.DISCORD_CLIENT_ID),
                { body: commands },
            );
            log.info(`[Deploy] ✅ ${data.length} commands registered (global).`);
        }
    } catch (error) {
        log.error('[Deploy] ❌ Error:', error);
    }
})();
