import { Client, GatewayIntentBits, PermissionsBitField, Partials, EmbedBuilder } from 'discord.js';
import dotenv from 'dotenv';
import admin from 'firebase-admin';
import fs from 'fs';
import path from 'path';

dotenv.config();

const PREFIX = '?';
const serviceAccountPath = path.resolve('./serviceAccountKey.json');
const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessages
  ],
  partials: [Partials.GuildMember, Partials.User]
});

let botLocked = false;

const hasAdmin = (member) => member.permissions.has(PermissionsBitField.Flags.Administrator);
const hasMod = (member) => member.permissions.has(PermissionsBitField.Flags.ModerateMembers);

const requireMod = (member, message) => {
  if (!hasMod(member)) {
    message.reply("You need Moderator permissions to use this command.");
    return false;
  }
  return true;
};

const requireAdmin = (member, message) => {
  if (!hasAdmin(member)) {
    message.reply("You need Administrator permissions to use this command.");
    return false;
  }
  return true;
};

const getUserData = async (guildId, userId) => {
  const doc = await db.collection('moderation').doc(`${guildId}_${userId}`).get();
  return doc.exists ? doc.data() : { warnings: [], mutes: [], bans: [], kicks: [] };
};

const setUserData = async (guildId, userId, data) => {
  await db.collection('moderation').doc(`${guildId}_${userId}`).set(data);
};

const addActionData = async (guildId, userId, actionType, entry) => {
  if (!userId || !actionType) return;
  const data = await getUserData(guildId, userId);
  switch (actionType) {
    case 'warn': data.warnings.push({ reason: entry.reason, createdAt: new Date().toISOString() }); break;
    case 'mute': data.mutes.push({ duration: entry.duration, reason: entry.reason, createdAt: new Date().toISOString() }); break;
    case 'ban': data.bans.push({ reason: entry.reason, createdAt: new Date().toISOString() }); break;
    case 'kick': data.kicks.push({ reason: entry.reason, createdAt: new Date().toISOString() }); break;
  }
  await setUserData(guildId, userId, data);
};

const parseDuration = (duration) => {
  const units = { s:1000, m:60000, h:3600000, d:86400000, w:604800000, mo:2592000000, y:31536000000 };
  const regex = /(\d+)(y|mo|w|d|h|m|s)/g;
  let match;
  let total = 0;
  while ((match = regex.exec(duration.toLowerCase())) !== null) {
    total += parseInt(match[1]) * units[match[2]];
  }
  return total || null;
};

const formatDuration = (ms) => {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  return `${days?days+'d ':''}${hours%24?hours%24+'h ':''}${minutes%60?minutes%60+'m ':''}${seconds%60?seconds%60+'s':''}`.trim();
};

const checkBotLock = (message) => {
  if (botLocked && !hasAdmin(message.member)) {
    message.reply("Baritone is locked. Only Administrators can use commands right now.");
    return false;
  }
  return true;
};

const restoreMutes = async () => {
  const snapshot = await db.collection('moderation').get();
  await Promise.all(snapshot.docs.map(async doc => {
    const [guildId, userId] = doc.id.split('_');
    const data = doc.data();
    if (!data.mutes?.length) return;
    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return;
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return;
    let mutedRole = guild.roles.cache.find(r => r.name === 'Muted');
    if (!mutedRole) return;
    for (const m of data.mutes) {
      const remaining = m.duration - Date.now();
      if (remaining > 0 && !m.status) {
        if (!member.roles.cache.has(mutedRole.id)) await member.roles.add(mutedRole);
        setTimeout(async () => {
          if(member.roles.cache.has(mutedRole.id)) await member.roles.remove(mutedRole);
          m.status = 'expired';
          await setUserData(guildId, userId, data);
        }, remaining);
      } else {
        m.status = 'expired';
      }
    }
    await setUserData(guildId, userId, data);
  }));
};

client.once('clientReady', async () => {
  console.log('Hello World');
  await restoreMutes();
});

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.content.startsWith(PREFIX)) return;
  if (!checkBotLock(message)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();
  const guildId = message.guild.id;

  try {
    if (command === 'help') {
      const embed = new EmbedBuilder()
        .setColor('#0099ff')
        .setTitle('Baritone Commands')
        .setDescription('List of commands:')
        .addFields(
          { name: '?warn', value: 'Warn a user.' },
          { name: '?unwarn', value: 'Remove a warning.' },
          { name: '?mute', value: 'Mute a user.' },
          { name: '?unmute', value: 'Unmute a user.' },
          { name: '?kick', value: 'Kick a user.' },
          { name: '?ban', value: 'Ban a user.' },
          { name: '?unban', value: 'Unban a user.' },
          { name: '?view', value: 'View user history.' },
          { name: '?lock', value: 'Lock bot for admins only.' },
          { name: '?unlock', value: 'Unlock bot.' },
          { name: '?serverinfo', value: 'Server info.' },
          { name: '?userinfo', value: 'User info.' },
          { name: '?help', value: 'This message.' }
        );
      return message.channel.send({ embeds: [embed] });
    }

    if (command === 'lock') {
      if (!requireAdmin(message.member, message)) return;
      if (botLocked) return message.reply("Already locked.");
      botLocked = true;
      return message.channel.send('Bot locked for admins only.');
    }

    if (command === 'unlock') {
      if (!requireAdmin(message.member, message)) return;
      if (!botLocked) return message.reply("Not locked.");
      botLocked = false;
      return message.channel.send('Bot unlocked.');
    }

    if (['warn','unwarn','mute','unmute','kick','ban','unban','view'].includes(command)) {
      if (!requireMod(message.member, message)) return;
    }

    if (command === 'warn') {
      const user = message.mentions.members.first();
      if (!user) return message.reply("Mention a user to warn.");
      if (user.id === message.member.id) return message.reply("You cannot warn yourself.");
      if (!user.manageable) return message.reply("Cannot warn this user.");
      const reason = args.slice(1).join(' ') || 'No reason provided';
      await addActionData(guildId, user.id, 'warn', { reason });
      return message.channel.send(`${user.user.tag} warned: ${reason}`);
    }

    if (command === 'unwarn') {
      const user = message.mentions.members.first();
      if (!user) return message.reply("Mention a user to remove a warning.");
      const data = await getUserData(guildId, user.id);
      if (!data.warnings.length) return message.reply('No warnings.');
      data.warnings.pop();
      await setUserData(guildId, user.id, data);
      return message.channel.send(`${user.user.tag}'s last warning removed.`);
    }

if (command === 'mute') {
  const user = message.mentions.members.first();
  const durationStr = args[1];

  if (!user) return message.reply("Mention a user to mute.");
  if (!durationStr) return message.reply("Provide a duration. Example: ?mute @User 10m spamming");
  if (user.id === message.member.id) return message.reply("You cannot mute yourself.");
  if (user.id === client.user.id) return message.reply("Cannot mute the bot.");

  if (user.roles.highest.position >= message.member.roles.highest.position) {
    return message.reply("Cannot mute someone with a higher or equal role than you.");
  }
  if (user.roles.highest.position >= message.guild.members.me.roles.highest.position) {
    return message.reply("Cannot mute this user because their role is higher or equal to the bot.");
  }

  const durationMs = parseDuration(durationStr);
  if (!durationMs) return message.reply("Invalid duration format. Example: 10m, 2h, 1d, or stacked like 1h30m");
  const reason = args.slice(2).join(' ') || 'No reason provided';

  let mutedRole = message.guild.roles.cache.find(r => r.name === 'Muted');
  if (!mutedRole) {
    mutedRole = await message.guild.roles.create({ name: 'Muted', permissions: [] });
    for (const channel of message.guild.channels.cache.values()) {
      await channel.permissionOverwrites.edit(mutedRole, {
        [PermissionsBitField.Flags.SendMessages]: false,
        [PermissionsBitField.Flags.AddReactions]: false
      });
    }
  }

  if (!user.roles.cache.has(mutedRole.id)) await user.roles.add(mutedRole);
  const unmuteTime = Date.now() + durationMs;
  await addActionData(message.guild.id, user.id, 'mute', { duration: unmuteTime, reason });

  setTimeout(async () => {
    if (user.roles.cache.has(mutedRole.id)) await user.roles.remove(mutedRole);
    const data = await getUserData(message.guild.id, user.id);
    data.mutes.forEach(m => { if (!m.status) m.status = 'expired'; });
    await setUserData(message.guild.id, user.id, data);
  }, durationMs);

  return message.channel.send(`${user.user.tag} muted for ${durationStr}: ${reason}`);
}

if (command === 'unmute') {
  const user = message.mentions.members.first();
  if (!user) return message.reply("Mention a user to unmute.");
  if (user.id === client.user.id) return message.reply("Cannot unmute the bot.");

  if (user.roles.highest.position >= message.member.roles.highest.position) {
    return message.reply("Cannot unmute someone with a higher or equal role than you.");
  }
  if (user.roles.highest.position >= message.guild.members.me.roles.highest.position) {
    return message.reply("Cannot unmute this user because their role is higher or equal to the bot.");
  }

  const mutedRole = message.guild.roles.cache.find(r => r.name === 'Muted');
  if (!mutedRole || !user.roles.cache.has(mutedRole.id)) return message.reply("User is not muted.");

  await user.roles.remove(mutedRole);
  const data = await getUserData(message.guild.id, user.id);
  data.mutes.forEach(m => { if (!m.status) m.status = 'expired'; });
  await setUserData(message.guild.id, user.id, data);

  return message.channel.send(`${user.user.tag} unmuted.`);
}

    if (command === 'kick') {
      const user = message.mentions.members.first();
      if (!user) return message.reply("Mention a user to kick.");
      if (user.id === message.member.id) return message.reply("Cannot kick yourself.");
      if (user.id === client.user.id) return message.reply("Cannot kick the bot.");
      if (!user.kickable) return message.reply("Cannot kick this user.");
      const reason = args.slice(1).join(' ') || 'No reason';
      await user.kick(reason);
      await addActionData(guildId, user.id,'kick',{reason});
      return message.channel.send(`${user.user.tag} kicked: ${reason}`);
    }

    if (command === 'ban') {
      const user = message.mentions.members.first();
      if (!user) return message.reply("Mention a user to ban.");
      if (user.id === message.member.id) return message.reply("Cannot ban yourself.");
      if (user.id === client.user.id) return message.reply("Cannot ban the bot.");
      if (!user.bannable) return message.reply("Cannot ban this user.");
      const reason = args.slice(1).join(' ') || 'No reason';
      await user.ban({reason});
      await addActionData(guildId, user.id,'ban',{reason});
      return message.channel.send(`${user.user.tag} banned: ${reason}`);
    }

    if (command === 'unban') {
      const userId = args[0];
      if (!userId) return message.reply("Provide a user ID to unban.");
      if (!/^\d{17,19}$/.test(userId)) return message.reply("Invalid user ID.");
      try {
        const banList = await message.guild.bans.fetch();
        const bannedUser = banList.get(userId);
        if (!bannedUser) return message.reply("That user is not banned.");
        await message.guild.bans.remove(userId);
        return message.channel.send(`${bannedUser.user.tag} has been unbanned.`);
      } catch (err) {}
    }

    if (command === 'view') {
      const user = message.mentions.members.first() || message.member;
      const ua = await getUserData(guildId, user.id);
      if(!ua.warnings.length && !ua.mutes.length && !ua.kicks.length && !ua.bans.length) return message.reply('No actions recorded.');
      const embed = new EmbedBuilder().setColor('0099ff').setTitle(`${user.user.tag}'s History`).setAuthor({name:user.user.tag,iconURL:user.displayAvatarURL()})
        .addFields(
          {name:'Warnings',value:ua.warnings.length ? ua.warnings.map(w => `Reason: ${w.reason}`).join('\n') : 'No warnings'},
          {name:'Mutes',value:ua.mutes.length ? ua.mutes.map(m => {
            const t = m.duration - Date.now();
            return t <= 0 ? `Status: ${m.status || 'Expired'} | Reason: ${m.reason}` : `Status: ${m.status || formatDuration(t)} | Reason: ${m.reason}`;
          }).join('\n') : 'No mutes'},
          {name:'Kicks',value:ua.kicks.length ? ua.kicks.map(k => `Reason: ${k.reason}`).join('\n') : 'No kicks'},
          {name:'Bans',value:ua.bans.length ? ua.bans.map(b => `Reason: ${b.reason}`).join('\n') : 'No bans'}
        );
      return message.channel.send({ embeds: [embed] });
    }

    if (command === 'serverinfo') {
      const embed = new EmbedBuilder().setColor('#0099ff').setTitle('Server Info').setThumbnail(message.guild.iconURL())
        .addFields(
          { name: 'Server Name', value: message.guild.name, inline: true },
          { name: 'Server ID', value: message.guild.id, inline: true },
          { name: 'Owner', value: `<@${message.guild.ownerId}>`, inline: true },
          { name: 'Member Count', value: `${message.guild.memberCount}`, inline: true },
          { name: 'Server Boosts', value: `${message.guild.premiumSubscriptionCount||0}`, inline: true }
        );
      return message.channel.send({ embeds: [embed] });
    }

    if (command === 'userinfo') {
      const user = message.mentions.users.first() || message.author;
      const member = message.guild.members.cache.get(user.id);
      const embed = new EmbedBuilder().setColor('#0099ff')
        .setAuthor({ name: `${user.username}'s Information`, iconURL: user.displayAvatarURL() })
        .addFields(
          { name:'Username', value:user.username, inline:true },
          { name:'User ID', value:user.id, inline:true },
          { name:'Joined Server On', value: new Date(member.joinedTimestamp).toLocaleDateString(), inline:true },
          { name:'Account Created On', value: new Date(user.createdTimestamp).toLocaleDateString(), inline:true },
          { name:'Roles', value: member.roles.cache.filter(r => r.name !== '@everyone').map(r => r.name).join(', ') || 'No roles', inline:true }
        );
      return message.channel.send({ embeds: [embed] });
    }

  } catch (err) {
    console.error(err);
  }
});

client.login(process.env.BOT_TOKEN);