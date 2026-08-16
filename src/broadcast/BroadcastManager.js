/**
 * BroadcastManager — Gestion des modes de diffusion audio.
 * 
 * - 'everyone'  : Le bot joue dans le salon vocal commun (comportement par défaut)
 * - 'personal'  : Crée un salon vocal temporaire privé pour l'utilisateur
 */

const { ChannelType, PermissionFlagsBits } = require('discord.js');
const config = require('../config');
const database = require('../database/Database');
const { retirerMoteur } = require('../audio/mix');
const { convertForMode } = require('../utils/setAsideQueue');
const log = require('../utils/logger');

class BroadcastManager {
    constructor() {
        /** Map<guildId, Map<userId, channelId>> : salons temporaires actifs */
        this.personalChannels = new Map();
    }

    /**
     * Récupère le mode de diffusion pour une guild.
     * @param {string} guildId
     * @returns {'everyone'|'personal'}
     */
    getMode(guildId) {
        const settings = database.getSettings(guildId);
        return settings.broadcastMode;
    }

    /**
     * Change le mode de diffusion (admin uniquement — vérifié dans la commande).
     * @param {string} guildId
     * @param {'everyone'|'personal'} mode
     */
    setMode(guildId, mode) {
        const oldSettings = database.getSettings(guildId);
        database.updateSettings(guildId, { broadcastMode: mode });

        if (mode !== oldSettings.broadcastMode) {
            // La file d'attente ne dépend pas du mode : elle est la même des
            // deux côtés. Sans ce rangement sous la clé du nouveau mode, le
            // tableau de bord irait la chercher dans une sauvegarde que
            // celui-ci n'a jamais écrite, et l'afficherait vide.
            convertForMode(guildId, mode);

            const { useMainPlayer } = require('discord-player');
            const player = useMainPlayer();
            const queue = player?.queues?.get(guildId);

            if (queue) {
                if (mode === 'personal') {
                    // Sauvegarder l'état actuel de lecture pour le lecteur virtuel
                    queue.virtualCurrentTrack = queue.currentTrack ? {
                        title: queue.currentTrack.title,
                        author: queue.currentTrack.author,
                        duration: queue.currentTrack.duration,
                        thumbnail: queue.currentTrack.thumbnail || null,
                        url: queue.currentTrack.url,
                        raw: {},
                        queryType: queue.currentTrack.queryType,
                        extractorName: queue.currentTrack.extractor?.identifier || null
                    } : null;

                    try {
                        queue.virtualProgressMs = queue.node.getTimestamp()?.current?.value || 0;
                    } catch (e) {
                        queue.virtualProgressMs = 0;
                    }
                    queue.virtualIsPlaying = queue.node.isPlaying();
                    queue.virtualIsPaused = queue.node.isPaused();
                    queue.virtualLastUpdated = Date.now();

                    // Sauvegarder la file d'attente et l'historique dans les propriétés virtuelles
                    queue.virtualTracks = queue.tracks.toArray().map(t => ({
                        title: t.title,
                        author: t.author,
                        duration: t.duration,
                        thumbnail: t.thumbnail || null,
                        url: t.url,
                        raw: {},
                        queryType: t.queryType,
                        extractorName: t.extractor?.identifier || null
                    }));
                    queue.virtualHistory = queue.history.tracks.toArray().map(t => ({
                        title: t.title,
                        author: t.author,
                        duration: t.duration,
                        thumbnail: t.thumbnail || null,
                        url: t.url,
                        raw: {},
                        queryType: t.queryType,
                        extractorName: t.extractor?.identifier || null
                    }));

                    // Vider la file et l'historique réels pour arrêter la lecture physique
                    queue.tracks.clear();
                    queue.history.clear();

                    // Refermer le bus de mixage, qui porte la diffusion commune.
                    // Il faut le faire ici et explicitement : le bus s'appuie sur
                    // un flux permanent que la fin de lecture de discord-player
                    // ne concerne pas, et il continuerait donc à décoder — et à
                    // se disputer la connexion avec le diffuseur de silence.
                    retirerMoteur(queue);

                    // Arrêter la lecture en cours sur la connexion Discord sans déconnecter le bot
                    if (queue.dispatcher) {
                        try {
                            queue.dispatcher.end();
                        } catch (err) {
                            log.error('[BroadcastManager] Erreur arrêt dispatcher:', err.message);
                        }
                    }

                    // Le lecteur n'a plus de piste courante : sans le bus, c'est
                    // `__current` que `queue.currentTrack` rend, et la piste
                    // reprise vit désormais dans le lecteur virtuel.
                    queue.__current = null;

                    // Démarrer la diffusion de silence pour maintenir la connexion active
                    if (queue.connection) {
                        queue.guild.client.startSilencePlayer?.(queue);
                    }
                }
            }
        }
    }

    /**
     * Crée un salon vocal temporaire privé pour un utilisateur.
     * @param {import('discord.js').Guild} guild
     * @param {import('discord.js').GuildMember} member
     * @returns {Promise<import('discord.js').VoiceChannel>}
     */
    async createPersonalChannel(guild, member) {
        const channelName = `${config.broadcast.personalChannelPrefix} ${member.displayName}`;

        const channel = await guild.channels.create({
            name: channelName,
            type: ChannelType.GuildVoice,
            permissionOverwrites: [
                {
                    // Deny everyone by default
                    id: guild.id,
                    deny: [PermissionFlagsBits.Connect, PermissionFlagsBits.ViewChannel],
                },
                {
                    // Allow the specific user
                    id: member.id,
                    allow: [PermissionFlagsBits.Connect, PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Speak],
                },
                {
                    // Allow the bot
                    id: guild.members.me.id,
                    allow: [PermissionFlagsBits.Connect, PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Speak],
                },
            ],
        });

        // Track the personal channel
        if (!this.personalChannels.has(guild.id)) {
            this.personalChannels.set(guild.id, new Map());
        }
        this.personalChannels.get(guild.id).set(member.id, channel.id);

        return channel;
    }

    /**
     * Déplace un membre dans son salon personnel.
     * @param {import('discord.js').GuildMember} member
     * @param {import('discord.js').VoiceChannel} channel
     */
    async moveMemberToPersonal(member, channel) {
        if (member.voice.channel) {
            await member.voice.setChannel(channel);
        }
    }

    /**
     * Supprime le salon temporaire d'un utilisateur.
     * @param {import('discord.js').Guild} guild
     * @param {string} userId
     */
    async cleanupPersonalChannel(guild, userId) {
        const guildChannels = this.personalChannels.get(guild.id);
        if (!guildChannels) return;

        const channelId = guildChannels.get(userId);
        if (!channelId) return;

        try {
            const channel = await guild.channels.fetch(channelId);
            if (channel) {
                await channel.delete('Session musicale personnelle terminée.');
            }
        } catch {
            // Channel may already be deleted
        }

        guildChannels.delete(userId);
        if (guildChannels.size === 0) {
            this.personalChannels.delete(guild.id);
        }
    }

    /**
     * Vérifie si un utilisateur a un salon personnel actif.
     * @param {string} guildId
     * @param {string} userId
     * @returns {boolean}
     */
    hasPersonalChannel(guildId, userId) {
        const guildChannels = this.personalChannels.get(guildId);
        return guildChannels?.has(userId) || false;
    }

    /**
     * Nettoie tous les salons personnels d'une guild.
     * @param {import('discord.js').Guild} guild
     */
    async cleanupAllForGuild(guild) {
        const guildChannels = this.personalChannels.get(guild.id);
        if (!guildChannels) return;

        for (const [userId] of guildChannels) {
            await this.cleanupPersonalChannel(guild, userId);
        }
    }
}

// Singleton
module.exports = new BroadcastManager();
