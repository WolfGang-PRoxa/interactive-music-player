/**
 * Permissions — Utilitaires de vérification des permissions.
 */

const { PermissionFlagsBits } = require('discord.js');

const permissions = {
  /**
   * Vérifie si un membre est administrateur du serveur.
   * @param {import('discord.js').GuildMember} member
   * @returns {boolean}
   */
  isAdmin(member) {
    return member.permissions.has(PermissionFlagsBits.Administrator);
  },

  /**
   * Vérifie si un membre est dans un salon vocal.
   * @param {import('discord.js').GuildMember} member
   * @returns {boolean}
   */
  isInVoiceChannel(member) {
    return !!member.voice.channel;
  },

  /**
   * Vérifie si le bot peut rejoindre et parler dans un salon vocal.
   * @param {import('discord.js').VoiceChannel} channel
   * @param {import('discord.js').Guild} guild
   * @returns {{ canJoin: boolean, canSpeak: boolean, missing: string[] }}
   */
  checkBotVoicePermissions(channel, guild) {
    const botMember = guild.members.me;
    const permissions = channel.permissionsFor(botMember);
    const missing = [];

    const canJoin = permissions.has(PermissionFlagsBits.Connect);
    const canSpeak = permissions.has(PermissionFlagsBits.Speak);
    const canView = permissions.has(PermissionFlagsBits.ViewChannel);

    if (!canView) missing.push('Voir le salon');
    if (!canJoin) missing.push('Se connecter');
    if (!canSpeak) missing.push('Parler');

    return {
      canJoin: canJoin && canView,
      canSpeak,
      missing,
    };
  },

  /**
   * Vérifie si le bot peut gérer des salons (pour le mode personnel).
   * @param {import('discord.js').Guild} guild
   * @returns {boolean}
   */
  canManageChannels(guild) {
    return guild.members.me.permissions.has(PermissionFlagsBits.ManageChannels);
  },
};

module.exports = permissions;
