/**
 * Point d'entrée du bot Discord — Musique Interactive avec Audio Ducking.
 * 
 * Initialise le client Discord, discord-player, et connecte tous les systèmes :
 * - Chargement dynamique des commandes slash
 * - Gestion du ducking audio via VoiceReceiver
 * - Gestion des événements player (track start, error, etc.)
 */

// --- Windows: empêcher les fenêtres de terminal fantômes ---
// Monkey-patch global de child_process.spawn pour forcer windowsHide: true
// Doit être appliqué AVANT tout autre require pour couvrir toutes les librairies.
if (process.platform === 'win32') {
    const cp = require('child_process');
    const originalSpawn = cp.spawn;
    cp.spawn = function patchedSpawn(command, args, options) {
        if (args && !Array.isArray(args)) {
            // spawn(command, options) signature
            options = args;
            args = [];
        }
        options = { windowsHide: true, ...(options || {}) };
        return originalSpawn.call(this, command, args, options);
    };
}

require('dotenv').config();

const { Client, GatewayIntentBits, Collection, Events } = require('discord.js');
const { Player, AudioFilters } = require('discord-player');

// --- Register Custom Speed Filters ---
// Enregistrement dynamique des filtres de tempo de 0.20 à 3.05 par pas de 0.01
for (let s = 0.20; s <= 3.05; s += 0.01) {
    const rounded = Math.round(s * 100) / 100;
    const filterName = `speed_${String(rounded).replace('.', '_')}`;
    
    let filterString = '';
    if (rounded < 0.5) {
        filterString = `atempo=0.5,atempo=${Math.round((rounded / 0.5) * 100) / 100}`;
    } else if (rounded > 2.0) {
        filterString = `atempo=2.0,atempo=${Math.round((rounded / 2.0) * 100) / 100}`;
    } else {
        filterString = `atempo=${rounded}`;
    }
    AudioFilters.filters[filterName] = filterString;
}
AudioFilters.filters.muffled = 'lowpass=f=400';
const { SpotifyExtractor, SoundCloudExtractor, AppleMusicExtractor, AttachmentExtractor } = require('@discord-player/extractor');
const { YoutubeiExtractor } = require('discord-player-youtubei');
const path = require('path');
const fs = require('fs');

const config = require('./config');
const database = require('./database/Database');
const playbackStateManager = require('./database/PlaybackStateManager');
// Doit être chargé avant toute création de queue : installe les accesseurs
// d'état de lecture sur GuildQueue.prototype.
require('./audio/PlaybackSession');
// Même raison : branche le lecteur de discord-player sur le bus de mixage, qui
// porte la diffusion commune et rend possible la superposition de deux pistes.
require('./audio/mix/playerBridge').installBridge();
const DuckingManager = require('./audio/DuckingManager');
const VolumeController = require('./audio/VolumeController');
const preloadManager = require('./audio/PreloadManager');
const presenceManager = require('./audio/PresenceManager');
const embeds = require('./utils/embeds');
const webServer = require('./web/WebServer');
const versioning = require('./versioning');
const log = require('./utils/logger');

// --- Validate env ---
if (!process.env.DISCORD_TOKEN) {
    log.error('[FATAL] DISCORD_TOKEN manquant dans le fichier .env');
    log.error('Copiez .env.example vers .env et renseignez votre token.');
    process.exit(1);
}

// --- Create Client ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
    ],
});

client.commands = new Collection();
client.duckingManagers = new Map();

// --- Globals ---
let playerInstance = null;

// --- Load Commands ---
function loadCommands() {
    const commandsPath = path.join(__dirname, 'commands');
    const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'));

    for (const file of commandFiles) {
        const filePath = path.join(commandsPath, file);
        const command = require(filePath);

        // queue.js exports multiple commands
        if (file === 'queue.js') {
            const { queueCommand, skipCommand, stopCommand, pauseCommand, resumeCommand } = command;
            client.commands.set(queueCommand.data.name, queueCommand);
            client.commands.set(skipCommand.data.name, skipCommand);
            client.commands.set(stopCommand.data.name, stopCommand);
            client.commands.set(pauseCommand.data.name, pauseCommand);
            client.commands.set(resumeCommand.data.name, resumeCommand);
        } else if (command.data && command.execute) {
            client.commands.set(command.data.name, command);
        }
    }

    log.info(`[Commands] ${client.commands.size} commandes chargées.`);
}

// --- Initialize discord-player ---
async function initPlayer() {
    const ffmpegPath = require('ffmpeg-static');

    const player = new Player(client, {
        ytdlOptions: {
            quality: 'highestaudio',
            highWaterMark: 1 << 25,
        },
        skipFFmpeg: false,
        ffmpegPath: ffmpegPath,
    });
    playerInstance = player;

    // Load extractors individually
    await player.extractors.register(YoutubeiExtractor, { useYoutubeDL: false });
    await player.extractors.register(SpotifyExtractor, {});
    await player.extractors.register(SoundCloudExtractor, {});
    await player.extractors.register(AppleMusicExtractor, {});
    await player.extractors.register(AttachmentExtractor, {});

    // Enregistrer les écouteurs d'événements du lecteur
    const { registerPlayerEvents } = require('./audio/PlayerEvents');
    registerPlayerEvents(player, client);

    log.info('[Player] discord-player initialisé avec les extracteurs par défaut.');

    // Initialiser le PreloadManager
    preloadManager.init(player);

    // Le gestionnaire de présence prend au passage la main sur le traitement
    // des états vocaux de discord-player (cf. l'en-tête de PresenceManager).
    presenceManager.init(client, player);

    return player;
}

// --- Ducking Setup ---
// --- Ducking Setup ---
function setupDucking(guildId) {
    if (!playerInstance) return;
    const queue = playerInstance.queues.get(guildId);
    log.debug(`[Ducking Debug] setupDucking call - queue found: ${!!queue}`);
    if (!queue) return;

    const settings = database.getSettings(guildId);

    // Démarrer le diffuseur de silence en mode personnel pour maintenir le flux UDP actif
    if (settings.broadcastMode === 'personal' && queue.connection) {
        startSilencePlayer(queue);
    }

    // If manager already exists, update its connection and queue node
    const existingManager = client.duckingManagers.get(guildId);
    log.debug(`[Ducking Debug] existingManager found: ${!!existingManager}`);
    if (existingManager) {
        if (queue.connection) {
            existingManager.updateConnection(queue.connection);
        }
        // Le salon suit le bot. Sans cela, le gestionnaire gardait celui de sa
        // création : la liste des utilisateurs dont la détection vocale est
        // désactivée — tenue par salon — était consultée pour un salon que le
        // bot avait quitté, et l'interrupteur du tableau de bord ne
        // correspondait plus à ce que le ducking appliquait.
        existingManager.setChannelId(queue.channel?.id || null);
        if (existingManager.volumeController) {
            existingManager.volumeController.updateQueueNode(queue.node);
            if (queue.restorePaused || queue.transitioningToEveryone) {
                try {
                    queue.node.setVolume(0);
                } catch (err) {}
            }
            log.info(`[Ducking] Node de la queue et connexion mis à jour pour guild ${guildId}`);
        }
        return;
    }

    const connection = queue.connection;
    log.debug(`[Ducking Debug] connection found: ${!!connection}`);
    if (!connection) return;

    const volumeController = new VolumeController(queue.node);
    volumeController.setBaseVolume(settings.baseVolume);
    if (queue.restorePaused || queue.transitioningToEveryone) {
        try {
            queue.node.setVolume(0);
        } catch (err) {}
    }

    const channelId = queue.channel?.id || null;
    const duckingManager = new DuckingManager(guildId, channelId, connection, volumeController);

    client.duckingManagers.set(guildId, duckingManager);
    // Store volumeController reference on the duckingManager for commands access
    duckingManager.volumeController = volumeController;

    log.info(`[Ducking] Ducking configuré pour guild ${guildId} (enabled: ${settings.duckingEnabled})`);
}

function startSilencePlayer(queue) {
    if (queue.silencePlayer) return;

    const { createAudioPlayer, createAudioResource, StreamType } = require('@discordjs/voice');
    const { Readable } = require('stream');

    // Utilisation de objectMode: true pour éviter la concaténation de paquets Opus
    const silenceStream = new Readable({
        objectMode: true,
        read() {}
    });

    const interval = setInterval(() => {
        if (silenceStream.destroyed) {
            clearInterval(interval);
            return;
        }
        try {
            silenceStream.push(Buffer.from([0xF8, 0xFF, 0xFE])); // Opus silence frame
        } catch (e) {
            clearInterval(interval);
        }
    }, 20);

    silenceStream.on('close', () => {
        clearInterval(interval);
        silenceStream.destroyed = true;
    });

    const resource = createAudioResource(silenceStream, { inputType: StreamType.Opus });
    const silencePlayer = createAudioPlayer();

    silencePlayer.on('error', (err) => {
        log.error('[SilencePlayer] Erreur sur le lecteur de silence :', err.message);
    });

    silencePlayer.play(resource);
    queue.connection.subscribe(silencePlayer);

    queue.silencePlayer = silencePlayer;
    queue.silenceStream = silenceStream;
    log.info(`[SilencePlayer] Diffuseur de silence démarré (objectMode: true) pour guild ${queue.guild.id}`);
}

function stopSilencePlayer(queue) {
    if (queue.silencePlayer) {
        try {
            queue.silencePlayer.stop();
        } catch (e) {}
        queue.silencePlayer = null;
    }
    if (queue.silenceStream) {
        try {
            queue.silenceStream.destroy();
        } catch (e) {}
        queue.silenceStream = null;
    }
    log.info(`[SilencePlayer] Diffuseur de silence arrêté pour guild ${queue.guild.id}`);
}

function cleanupDucking(guildId) {
    const manager = client.duckingManagers.get(guildId);
    if (manager) {
        manager.destroy();
        client.duckingManagers.delete(guildId);
        log.info(`[Ducking] Ducking nettoyé pour guild ${guildId}`);
    }
    if (playerInstance) {
        const queue = playerInstance.queues.get(guildId);
        if (queue) {
            stopSilencePlayer(queue);
        }
    }
}

client.startSilencePlayer = startSilencePlayer;
client.stopSilencePlayer = stopSilencePlayer;
client.setupDucking = setupDucking;
client.cleanupDucking = cleanupDucking;

// --- Interaction Handler ---
client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const command = client.commands.get(interaction.commandName);
    if (!command) return;

    try {
        await command.execute(interaction);
    } catch (error) {
        log.error(`[Command] Erreur dans /${interaction.commandName} :`, error);

        const errorEmbed = embeds.error('Erreur', `Une erreur est survenue lors de l'exécution de la commande.\n\`${error.message}\``);

        if (interaction.deferred || interaction.replied) {
            await interaction.followUp({ embeds: [errorEmbed], ephemeral: true }).catch(() => {});
        } else {
            await interaction.reply({ embeds: [errorEmbed], ephemeral: true }).catch(() => {});
        }
    }
});

// --- Voice State Updates (cleanup personal channels on leave & save state on bot/user move) ---
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
    const guildId = newState.guild?.id || oldState.guild?.id;

    // Si l'état vocal du bot lui-même a changé (connexion, déconnexion, déplacement de salon)
    if (newState.id === client.user.id) {
        log.info(`[VoiceStateUpdate] Voice state change detected for bot: ${oldState.channel?.name || 'none'} -> ${newState.channel?.name || 'none'}`);
        if (playerInstance) {
            playbackStateManager.saveState(playerInstance);
        }
    }

    // Quitter le salon en parlant ne produit aucun « fin de parole » : Discord
    // n'annonce que les changements de micro, pas les départs. L'utilisateur
    // restait donc inscrit parmi les locuteurs — halo allumé pour toujours sur
    // le tableau de bord s'il revenait, et volume tenu baissé pour un silence.
    if (guildId && oldState.channelId && oldState.channelId !== newState.channelId) {
        const manager = client.duckingManagers.get(guildId);
        if (manager && manager.channelId === oldState.channelId) {
            manager.forgetSpeaker(oldState.id);
        }
    }

    // Arrivée ou départ d'un humain : le bot rejoint le salon s'il vient de
    // s'habiter, et le quitte s'il vient de se vider. L'écouteur du player ne
    // suffirait pas — il ne se déclenche que si le bot est déjà connecté,
    // c'est-à-dire jamais dans le cas de l'arrivée.
    if (guildId) {
        presenceManager.evaluate(guildId);
    }

    // Si un utilisateur quitte un salon vocal, vérifier s'il faut nettoyer un salon personnel
    if (oldState.channel && !newState.channel) {
        const broadcastManager = require('./broadcast/BroadcastManager');
        if (broadcastManager.hasPersonalChannel(oldState.guild.id, oldState.member.id)) {
            await broadcastManager.cleanupPersonalChannel(oldState.guild, oldState.member.id);
        }
    }

    // Actualiser l'état du dashboard pour rafraîchir la liste des membres vocaux
    if (guildId && webServer) {
        webServer.broadcastState(guildId);
    }
});

// --- Ready ---
client.once(Events.ClientReady, async (readyClient) => {
    const version = versioning.currentVersion();
    const versionLabel = version.type === 'dev'
        ? `DEV (${version.packageVersion || '?'})`
        : version.tag;

    log.success('╔══════════════════════════════════════════════════╗');
    log.success('║   🎵 Bot Musique Interactive — Prêt !            ║');
    log.success(`║   Connecté : ${readyClient.user.tag.padEnd(31)}     ║`);
    log.success(`║   Serveurs : ${String(readyClient.guilds.cache.size).padEnd(31)}     ║`);
    log.success(`║   Version  : ${versionLabel.padEnd(31)}     ║`);
    log.success('╚══════════════════════════════════════════════════╝');

    // Une installation interrompue laisse une extraction partielle. Elle n'a
    // jamais servi — le marqueur d'intégrité manque —, et le disque n'a aucune
    // raison de la garder.
    versioning.cleanTempDirs();

    // Le salon favori vaut ici, et nulle part ailleurs : il devient le salon
    // courant le temps d'un démarrage, puis s'efface derrière les choix de
    // l'utilisateur. C'est ce qui lui permet de désigner le salon d'ouverture
    // sans pour autant retenir le bot — et le tableau de bord — prisonniers de
    // ce salon pour le reste de la session.
    const favorite = database.applyFavoriteChannel();
    if (favorite) {
        log.info(`[Startup] Salon favori appliqué : ${favorite.channelId} (serveur ${favorite.guildId}).`);
    }

    // Démarrer le serveur Web intégré pour le Dashboard
    const port = process.env.PORT || 3000;
    const host = process.env.HOST || '127.0.0.1';
    webServer.start(readyClient, port, host);

    // Restaurer l'état de lecture sauvegardé. Le préchargement reste suspendu
    // jusqu'au bout : il purge du cache toute piste absente des files, et
    // celles-ci ne sont complètes qu'une fois la restauration terminée.
    try {
        await playbackStateManager.restoreAll(readyClient, playerInstance);
    } finally {
        preloadManager.setSuspended(false);
    }

    // Quelqu'un a pu entrer dans un salon pendant la restauration : aucun
    // événement vocal ne le signalera après coup.
    for (const guildId of readyClient.guilds.cache.keys()) {
        presenceManager.evaluate(guildId);
    }

    // Sauvegarde périodique toutes les 5 secondes (pour la progression/timestamp)
    setInterval(() => {
        playbackStateManager.saveState(playerInstance);
    }, 5000);

    // Filet de sécurité de la règle de présence : un événement vocal manqué —
    // redémarrage de la passerelle, connexion établie hors des chemins prévus —
    // laisserait sinon le bot seul dans un salon vide indéfiniment.
    setInterval(() => {
        for (const guildId of readyClient.guilds.cache.keys()) {
            presenceManager.evaluate(guildId);
        }
    }, 30000);
});

// --- Graceful Shutdown ---
process.on('SIGINT', async () => {
    log.info('\n[Shutdown] Arrêt en cours avec fade-out...');

    // Sauvegarder l'état de lecture avec fade-out avant l'arrêt
    if (playerInstance) {
        try {
            await playbackStateManager.fadeOutAndSaveState(playerInstance, 3000);
        } catch (err) {
            log.error('[Shutdown] Erreur fade-out :', err.message);
        }
    }

    // Cleanup all ducking managers
    for (const [guildId, manager] of client.duckingManagers) {
        manager.destroy();
    }
    client.duckingManagers.clear();

    // Close database
    database.close();

    // Destroy client
    client.destroy();

    log.info('[Shutdown] Bot arrêté proprement.');
    process.exit(0);
});

// --- Start ---
(async () => {
    loadCommands();
    await initPlayer();
    await client.login(process.env.DISCORD_TOKEN);
})();
