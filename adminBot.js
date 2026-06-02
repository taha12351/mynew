'use strict';

// ╔══════════════════════════════════════════════════════════════╗
// ║  Diamond Casino — AdminGuard Bot (Server Control)           ║
// ╚══════════════════════════════════════════════════════════════╝

const Discord = require('discord.js');
const { MessageEmbed, MessageActionRow, MessageButton } = require('discord.js');
const fs   = require('fs');
const path = require('path');
require('dotenv').config();

const ADMIN_TOKEN = process.env.ADMIN_BOT_TOKEN;

// ── Owner IDs ──────────────────────────────────────────────────
const HARDCODED_OWNER = '1206272245417246750';

function getOwners() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(__dirname, 'siteSettings.json'), 'utf8'));
    return s.owners || [HARDCODED_OWNER];
  } catch {
    return [HARDCODED_OWNER];
  }
}

const envOwners = (process.env.OWNER_IDS || HARDCODED_OWNER).split(',').map(s => s.trim());

function isOwner(userId) {
  const owners = getOwners();
  return owners.includes(userId) || envOwners.includes(userId);
}

function ownerOnly(msg) {
  if (!isOwner(msg.author.id)) {
    msg.reply({
      embeds: [
        new MessageEmbed()
          .setColor('#ef4444')
          .setTitle('🚫 محظور')
          .setDescription('❌ هذا الأمر متاح لمالك البوت فقط!'),
      ],
    }).catch(() => {});
    return false;
  }
  return true;
}

// ── Admin Settings (link filter toggle, etc.) ──────────────────
const ADMIN_SETTINGS_FILE = path.join(__dirname, 'adminSettings.json');

function loadAdminSettings() {
  try { return JSON.parse(fs.readFileSync(ADMIN_SETTINGS_FILE, 'utf8')); }
  catch { return { linkFilter: false, linkFilterExemptRoles: [] }; }
}

function saveAdminSettings(data) {
  try { fs.writeFileSync(ADMIN_SETTINGS_FILE, JSON.stringify(data, null, 2)); }
  catch {}
}

// ── Logs ───────────────────────────────────────────────────────
const LOG_FILE = path.join(__dirname, 'adminBotLogs.json');

function loadLogs() {
  try { return JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); }
  catch { return []; }
}

function saveLogs(d) {
  try { fs.writeFileSync(LOG_FILE, JSON.stringify(d.slice(-2000), null, 2)); }
  catch {}
}

function addLog(action, authorTag, authorId, guildId, details) {
  const logs = loadLogs();
  logs.unshift({ ts: Date.now(), action, authorTag, authorId, guildId, details });
  saveLogs(logs);
}

// ── Security violation log (in-memory + file) ──────────────────
const SECURITY_LOG_FILE = path.join(__dirname, 'securityLog.json');

function loadSecurityLog() {
  try { return JSON.parse(fs.readFileSync(SECURITY_LOG_FILE, 'utf8')); }
  catch { return []; }
}

function addSecurityEvent(type, culpritTag, culpritId, guildName, guildId, detail) {
  const log = loadSecurityLog();
  log.unshift({ ts: Date.now(), type, culpritTag, culpritId, guildName, guildId, detail });
  try { fs.writeFileSync(SECURITY_LOG_FILE, JSON.stringify(log.slice(-500), null, 2)); }
  catch {}
}

// ── Whitelisted bots (never auto-ban these) ────────────────────
const WHITELISTED_BOT_IDS = new Set([
  '1322274003049513120', // Diamond Casino main bot
  '1505200605289513120', // AdminGuard bot (self)
  '282859044593598464',  // ProBot
  '716390085896962058',  // MEE6
  '235148962103951360',  // Dyno
  '155149108183695360',  // Dank Memer
]);

// ── URL detection regex ────────────────────────────────────────
const URL_REGEX = /https?:\/\/[^\s]+|discord\.gg\/[^\s]+|discordapp\.com\/[^\s]+/i;

// ── Client ─────────────────────────────────────────────────────
const admin = new Discord.Client({
  intents: [
    Discord.Intents.FLAGS.GUILDS,
    Discord.Intents.FLAGS.GUILD_MEMBERS,
    Discord.Intents.FLAGS.GUILD_BANS,
    Discord.Intents.FLAGS.GUILD_WEBHOOKS,
    Discord.Intents.FLAGS.GUILD_MESSAGES,
    Discord.Intents.FLAGS.GUILD_MESSAGE_REACTIONS,
    Discord.Intents.FLAGS.GUILD_VOICE_STATES,
    Discord.Intents.FLAGS.DIRECT_MESSAGES,
  ],
  partials: ['CHANNEL'],
});

admin.setMaxListeners(50);

// ── Log Channel ────────────────────────────────────────────────
const MAIN_LOG_CHANNEL = '1503103197248487464';

async function botLog(title, desc, color = '#ef4444') {
  try {
    const ch = await admin.channels.fetch(MAIN_LOG_CHANNEL).catch(() => null);
    if (!ch) return;
    await ch.send({
      embeds: [new MessageEmbed().setColor(color).setTitle(title).setDescription(desc).setTimestamp()],
    });
  } catch {}
}

async function dmOwner(title, desc, color = '#ef4444') {
  try {
    const owner = await admin.users.fetch(HARDCODED_OWNER).catch(() => null);
    if (!owner) return;
    await owner.send({
      embeds: [
        new MessageEmbed()
          .setColor(color)
          .setTitle(`🔐 تنبيه أمني — ${title}`)
          .setDescription(desc)
          .setTimestamp()
          .setFooter({ text: 'Diamond Casino Security System' }),
      ],
    });
  } catch {}
}

// ── Commands list ──────────────────────────────────────────────
const COMMANDS = {
  '!ag help':             'عرض الأوامر',
  '!ag backup':           'إنشاء نسخة احتياطية',
  '!ag import':           'فتح لوحة الاستيراد',
  '!ag load <file>':      'استعادة كاملة من ملف محدد',
  '!ag kick':             'طرد عضو',
  '!ag ban':              'حظر عضو',
  '!ag unban':            'رفع حظر',
  '!ag mute':             'كتم',
  '!ag unmute':           'إلغاء كتم',
  '!ag clear':            'مسح رسائل',
  '!ag lock':             'قفل قناة',
  '!ag unlock':           'فتح قناة',
  '!ag nuke':             'مسح القناة',
  '!ag deleteall':        'حذف جميع القنوات (يتطلب تأكيد)',
  '!ag bots':             'عرض جميع البوتات في السيرفر',
  '!ag webhooks':         'عرض جميع الويب هوك في السيرفر',
  '!ag security':         'عرض سجل الانتهاكات الأمنية',
  '!ag whitelist add':    'إضافة بوت للقائمة البيضاء',
  '!ag whitelist list':   'عرض القائمة البيضاء',
  '!ag linkfilter on/off':'تفعيل/إيقاف فلتر الروابط',
  '!ag linkfilter status':'عرض حالة فلتر الروابط',
};

// ── Channel Type Helpers ───────────────────────────────────────
const NUMERIC_TO_STRING_TYPE = {
  0: 'GUILD_TEXT', 2: 'GUILD_VOICE', 4: 'GUILD_CATEGORY',
  5: 'GUILD_NEWS', 13: 'GUILD_STAGE_VOICE', 15: 'GUILD_FORUM',
};

function toStringType(type) {
  if (typeof type === 'number') return NUMERIC_TO_STRING_TYPE[type] || 'GUILD_TEXT';
  return type;
}

function isCategory(type) {
  return type === 4 || type === 'GUILD_CATEGORY';
}

// ── Per-guild selected backup store ───────────────────────────
const selectedBackup = new Map();

// ── Pending deleteall confirmations ───────────────────────────
const pendingDeleteAll = new Map(); // guildId → { messageId, timeout }

// ══════════════════════════════════════════════════════════════
// 🔐 SECURITY SYSTEM
// ══════════════════════════════════════════════════════════════

// Track recently processed bot add events to avoid duplicates
const recentBotActions = new Set();

admin.on('guildMemberAdd', async (member) => {
  if (!member.user.bot) return;
  if (WHITELISTED_BOT_IDS.has(member.user.id)) return;
  if (recentBotActions.has(member.user.id)) return;
  recentBotActions.add(member.user.id);
  setTimeout(() => recentBotActions.delete(member.user.id), 10000);

  const guild = member.guild;
  let culpritTag = 'غير معروف';
  let culpritId  = null;
  let culpritMember = null;

  try {
    await new Promise(r => setTimeout(r, 1500));
    const audit = await guild.fetchAuditLogs({ type: 'BOT_ADD', limit: 5 }).catch(() => null);
    if (audit) {
      const entry = audit.entries.find(e =>
        e.target?.id === member.user.id && (Date.now() - e.createdTimestamp) < 15000
      );
      if (entry) {
        culpritTag = entry.executor?.tag || 'غير معروف';
        culpritId  = entry.executor?.id || null;
        if (culpritId) culpritMember = guild.members.cache.get(culpritId) || null;
      }
    }
  } catch {}

  if (culpritId && isOwner(culpritId)) {
    WHITELISTED_BOT_IDS.add(member.user.id);
    return;
  }

  const botTag  = member.user.tag;
  const botId   = member.user.id;
  const detail  = `بوت: **${botTag}** (\`${botId}\`) — أضافه: **${culpritTag}** (\`${culpritId || '?'}\`)`;

  await guild.bans.create(botId, { reason: `[Security] بوت غير مرخص أضافه ${culpritTag}` }).catch(() => {});

  if (culpritMember && !culpritMember.user.bot) {
    await culpritMember.ban({ reason: `[Security] أضاف بوتاً غير مرخص: ${botTag}` }).catch(() => {});
  }

  await dmOwner(
    '⚠️ بوت غير مرخص اكتُشف!',
    `> 🤖 **البوت:** ${botTag} (\`${botId}\`)\n` +
    `> 👤 **أضافه:** ${culpritTag} (\`${culpritId || '?'}\`)\n` +
    `> 🏠 **السيرفر:** ${guild.name} (\`${guild.id}\`)\n` +
    `> ✅ **الإجراء:** تم حظر البوت وحظر المستخدم تلقائياً.`,
    '#ef4444'
  );

  await botLog(
    '🚨 بوت غير مرخص — تم الحظر',
    `${detail}\n> 🏠 السيرفر: **${guild.name}**\n> ✅ تم الحظر تلقائياً`,
    '#ef4444'
  );

  addSecurityEvent('UNAUTHORIZED_BOT', culpritTag, culpritId, guild.name, guild.id, detail);
});

// ── Track processed webhooks to avoid duplicates ──────────────
const recentWebhookActions = new Set();

admin.on('webhooksUpdate', async (channel) => {
  const guild = channel.guild;
  if (recentWebhookActions.has(`${guild.id}-${channel.id}`)) return;
  recentWebhookActions.add(`${guild.id}-${channel.id}`);
  setTimeout(() => recentWebhookActions.delete(`${guild.id}-${channel.id}`), 8000);

  let culpritTag = 'غير معروف';
  let culpritId  = null;
  let culpritMember = null;
  let webhookName   = 'مجهول';

  try {
    await new Promise(r => setTimeout(r, 2000)); // wait for audit log propagation
    // Try numeric type 50 first (WEBHOOK_CREATE), fallback to string
    const audit = await guild.fetchAuditLogs({ type: 50, limit: 8 }).catch(() => null)
      || await guild.fetchAuditLogs({ type: 'WEBHOOK_CREATE', limit: 8 }).catch(() => null);
    if (audit) {
      const entry = audit.entries.find(e =>
        (Date.now() - e.createdTimestamp) < 20000
      );
      if (entry) {
        culpritTag  = entry.executor?.tag || 'غير معروف';
        culpritId   = entry.executor?.id || null;
        webhookName = entry.target?.name || 'مجهول';
        if (culpritId) {
          culpritMember = guild.members.cache.get(culpritId) ||
            await guild.members.fetch(culpritId).catch(() => null);
        }
      }
    }
  } catch {}

  if (culpritId && isOwner(culpritId)) return;
  if (!culpritId) return;

  const detail = `ويب هوك: **${webhookName}** في <#${channel.id}> — أنشأه: **${culpritTag}** (\`${culpritId}\`)`;

  // Delete ALL non-owner webhooks in that channel
  try {
    await new Promise(r => setTimeout(r, 500));
    const hooks = await channel.fetchWebhooks().catch(() => null);
    if (hooks) {
      for (const hook of hooks.values()) {
        if (!isOwner(hook.owner?.id)) {
          await hook.delete(`[Security] ويب هوك غير مرخص أنشأه ${culpritTag}`).catch(() => {});
        }
      }
    }
  } catch {}

  // Ban the creator
  if (culpritMember && !culpritMember.user.bot) {
    await culpritMember.ban({ reason: `[Security] أنشأ ويب هوك غير مرخص` }).catch(() => {});
  } else if (culpritId) {
    // Try to ban by ID even if not in cache
    await guild.bans.create(culpritId, { reason: `[Security] أنشأ ويب هوك غير مرخص` }).catch(() => {});
  }

  await dmOwner(
    '⚠️ ويب هوك غير مرخص اكتُشف!',
    `> 🔗 **الويب هوك:** ${webhookName}\n` +
    `> 📢 **القناة:** <#${channel.id}>\n` +
    `> 👤 **أنشأه:** ${culpritTag} (\`${culpritId}\`)\n` +
    `> 🏠 **السيرفر:** ${guild.name} (\`${guild.id}\`)\n` +
    `> ✅ **الإجراء:** تم حذف الويب هوك وحظر المستخدم تلقائياً.`,
    '#f97316'
  );

  await botLog(
    '🚨 ويب هوك غير مرخص — تم الحذف والحظر',
    `${detail}\n> 🏠 السيرفر: **${guild.name}**\n> ✅ تم الحذف والحظر تلقائياً`,
    '#f97316'
  );

  addSecurityEvent('UNAUTHORIZED_WEBHOOK', culpritTag, culpritId, guild.name, guild.id, detail);
});

// ══════════════════════════════════════════════════════════════
// 🔐 UNAUTHORIZED BAN/KICK DETECTION — Strip Roles + Notify
// ══════════════════════════════════════════════════════════════

const recentBanActions  = new Set();
const recentKickActions = new Set();

// Detect unauthorized bans
admin.on('guildBanAdd', async (ban) => {
  const guild = ban.guild;
  const key   = `${guild.id}-ban-${ban.user.id}`;
  if (recentBanActions.has(key)) return;
  recentBanActions.add(key);
  setTimeout(() => recentBanActions.delete(key), 10000);

  try {
    await new Promise(r => setTimeout(r, 1500));
    const audit = await guild.fetchAuditLogs({ type: 'MEMBER_BAN_ADD', limit: 5 }).catch(() => null);
    if (!audit) return;
    const entry = audit.entries.find(e =>
      e.target?.id === ban.user.id && (Date.now() - e.createdTimestamp) < 15000
    );
    if (!entry?.executor) return;
    const culpritId  = entry.executor.id;
    const culpritTag = entry.executor.tag;

    // Owner action — ignore
    if (isOwner(culpritId)) return;
    // Bot action — ignore (bots acting on behalf of the system)
    if (entry.executor.bot) return;

    const culpritMember = guild.members.cache.get(culpritId) ||
      await guild.members.fetch(culpritId).catch(() => null);

    // Strip ALL roles from the violator
    let strippedRoles = [];
    if (culpritMember) {
      strippedRoles = culpritMember.roles.cache
        .filter(r => r.id !== guild.id)
        .map(r => r.name);
      await culpritMember.roles.set([], '[Security] حظر غير مصرح به').catch(() => {});
    }

    const detail =
      `> 👤 **من نفّذ الحظر:** ${culpritTag} (\`${culpritId}\`)\n` +
      `> 🔨 **المحظور:** ${ban.user.tag} (\`${ban.user.id}\`)\n` +
      `> 🏠 **السيرفر:** ${guild.name}\n` +
      `> 🗑️ **الأدوار المحذوفة:** ${strippedRoles.length ? strippedRoles.join(', ') : 'لا يوجد'}`;

    await dmOwner('🚨 حظر غير مصرح به!', detail, '#ef4444');
    await botLog('🚨 حظر غير مصرح — تم سحب الأدوار', detail, '#ef4444');
    addSecurityEvent('UNAUTHORIZED_BAN', culpritTag, culpritId, guild.name, guild.id, detail);
  } catch {}
});

// Detect unauthorized kicks
admin.on('guildMemberRemove', async (member) => {
  if (member.user.bot) return;
  const guild = member.guild;
  const key   = `${guild.id}-kick-${member.id}`;
  if (recentKickActions.has(key)) return;
  recentKickActions.add(key);
  setTimeout(() => recentKickActions.delete(key), 10000);

  try {
    await new Promise(r => setTimeout(r, 1500));
    const audit = await guild.fetchAuditLogs({ type: 'MEMBER_KICK', limit: 5 }).catch(() => null);
    if (!audit) return;
    const entry = audit.entries.find(e =>
      e.target?.id === member.id && (Date.now() - e.createdTimestamp) < 10000
    );
    if (!entry?.executor) return;
    const culpritId  = entry.executor.id;
    const culpritTag = entry.executor.tag;

    if (isOwner(culpritId)) return;
    if (entry.executor.bot) return;

    const culpritMember = guild.members.cache.get(culpritId) ||
      await guild.members.fetch(culpritId).catch(() => null);

    let strippedRoles = [];
    if (culpritMember) {
      strippedRoles = culpritMember.roles.cache
        .filter(r => r.id !== guild.id)
        .map(r => r.name);
      await culpritMember.roles.set([], '[Security] طرد غير مصرح به').catch(() => {});
    }

    const detail =
      `> 👤 **من نفّذ الطرد:** ${culpritTag} (\`${culpritId}\`)\n` +
      `> 🥾 **المطرود:** ${member.user.tag} (\`${member.id}\`)\n` +
      `> 🏠 **السيرفر:** ${guild.name}\n` +
      `> 🗑️ **الأدوار المحذوفة:** ${strippedRoles.length ? strippedRoles.join(', ') : 'لا يوجد'}`;

    await dmOwner('🚨 طرد غير مصرح به!', detail, '#f97316');
    await botLog('🚨 طرد غير مصرح — تم سحب الأدوار', detail, '#f97316');
    addSecurityEvent('UNAUTHORIZED_KICK', culpritTag, culpritId, guild.name, guild.id, detail);
  } catch {}
});

// ══════════════════════════════════════════════════════════════
// 🔗 LINK FILTER — Auto-delete links from non-permitted users
// ══════════════════════════════════════════════════════════════

admin.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.guild) return;
  if (message.content.startsWith('!ag')) return; // let command handler handle it
  if (isOwner(message.author.id)) return;

  const settings = loadAdminSettings();
  if (!settings.linkFilter) return;

  if (URL_REGEX.test(message.content)) {
    try {
      await message.delete();
      const warn = await message.channel.send({
        embeds: [
          new MessageEmbed()
            .setColor('#ef4444')
            .setDescription(`🚫 ${message.author} **لا يُسمح بإرسال الروابط في هذا السيرفر.**`)
            .setFooter({ text: 'Diamond Casino — Link Filter' }),
        ],
      });
      setTimeout(() => warn.delete().catch(() => {}), 5000);
      addSecurityEvent('LINK_BLOCKED', message.author.tag, message.author.id, message.guild.name, message.guild.id,
        `رابط محذوف: ${message.content.slice(0, 100)}`);
    } catch {}
  }
});

// ══════════════════════════════════════════════════════════════
// 📨 MESSAGE HANDLER — !ag Commands
// ══════════════════════════════════════════════════════════════
admin.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;
  if (!message.content.startsWith('!ag')) return;

  // 🔐 Hard-check: every single !ag command is owner-only
  if (!isOwner(message.author.id)) {
    return message.reply({
      embeds: [
        new MessageEmbed()
          .setColor('#ef4444')
          .setTitle('🚫 محظور — Owner Only')
          .setDescription('❌ جميع أوامر AdminGuard مخصصة لمالك البوت فقط!\nرقمك غير موجود في قائمة المالكين.'),
      ],
    }).catch(() => {});
  }

  const args    = message.content.trim().split(/\s+/);
  const cmd     = args[0] + ' ' + (args[1] || '');
  const restArgs = args.slice(2);

  // ─── HELP ─────────────────────────────────────────────────
  if (cmd === '!ag help') {
    const embed = new MessageEmbed()
      .setTitle('🛡️ AdminGuard — قائمة الأوامر')
      .setColor('#8b5cf6')
      .setDescription(
        Object.entries(COMMANDS).map(([k, v]) => `**${k}** — ${v}`).join('\n')
      )
      .setFooter({ text: '🔐 جميع الأوامر متاحة للمالك فقط' });
    return message.channel.send({ embeds: [embed] });
  }

  // ─── BOTS ─────────────────────────────────────────────────
  if (cmd === '!ag bots') {
    await message.guild.members.fetch().catch(() => {});
    const bots = message.guild.members.cache.filter(m => m.user.bot);

    if (!bots.size) {
      return message.channel.send({
        embeds: [new MessageEmbed().setColor('#22c55e').setDescription('✅ لا يوجد أي بوت في السيرفر.')],
      });
    }

    const lines = bots.map(m => {
      const trusted = WHITELISTED_BOT_IDS.has(m.user.id) ? '✅' : '⚠️';
      return `${trusted} **${m.user.tag}** — \`${m.user.id}\``;
    });

    const chunks = [];
    let cur = '';
    for (const l of lines) {
      if ((cur + '\n' + l).length > 3900) { chunks.push(cur); cur = l; }
      else cur = cur ? cur + '\n' + l : l;
    }
    if (cur) chunks.push(cur);

    for (let i = 0; i < chunks.length; i++) {
      await message.channel.send({
        embeds: [
          new MessageEmbed()
            .setColor('#8b5cf6')
            .setTitle(i === 0 ? `🤖 البوتات في السيرفر (${bots.size})` : '🤖 تابع...')
            .setDescription(chunks[i])
            .setFooter({ text: '✅ موثوق  ⚠️ غير موجود في القائمة البيضاء' }),
        ],
      });
    }
    return;
  }

  // ─── WEBHOOKS ─────────────────────────────────────────────
  if (cmd === '!ag webhooks') {
    const allHooks = [];
    for (const ch of message.guild.channels.cache.values()) {
      if (!ch.isText?.()) continue;
      try {
        const hooks = await ch.fetchWebhooks().catch(() => null);
        if (hooks) hooks.forEach(h => allHooks.push({ ch: ch.name, chId: ch.id, name: h.name, id: h.id, owner: h.owner?.tag || '?' }));
      } catch {}
    }

    if (!allHooks.length) {
      return message.channel.send({
        embeds: [new MessageEmbed().setColor('#22c55e').setDescription('✅ لا توجد أي ويب هوك في السيرفر.')],
      });
    }

    const lines = allHooks.map(h => `🔗 **${h.name}** (\`${h.id}\`) — <#${h.chId}> — أُنشئ بواسطة: ${h.owner}`);
    await message.channel.send({
      embeds: [
        new MessageEmbed()
          .setColor('#f97316')
          .setTitle(`🔗 الويب هوك في السيرفر (${allHooks.length})`)
          .setDescription(lines.join('\n').slice(0, 4000)),
      ],
    });
    return;
  }

  // ─── SECURITY LOG ─────────────────────────────────────────
  if (cmd === '!ag security') {
    const log = loadSecurityLog().slice(0, 15);
    if (!log.length) {
      return message.channel.send({
        embeds: [new MessageEmbed().setColor('#22c55e').setDescription('✅ لا توجد انتهاكات أمنية مسجلة.')],
      });
    }

    const lines = log.map(e => {
      const time = `<t:${Math.floor(e.ts / 1000)}:R>`;
      const icons = {
        UNAUTHORIZED_BOT: '🤖', UNAUTHORIZED_WEBHOOK: '🔗',
        UNAUTHORIZED_BAN: '🔨', UNAUTHORIZED_KICK: '🥾', LINK_BLOCKED: '🌐',
      };
      const icon = icons[e.type] || '⚠️';
      return `${icon} ${time} — ${e.detail || e.type}`;
    });

    return message.channel.send({
      embeds: [
        new MessageEmbed()
          .setColor('#ef4444')
          .setTitle('🔐 سجل الانتهاكات الأمنية (آخر 15)')
          .setDescription(lines.join('\n').slice(0, 4000))
          .setTimestamp(),
      ],
    });
  }

  // ─── WHITELIST ADD ────────────────────────────────────────
  if (message.content.startsWith('!ag whitelist add')) {
    const botId = restArgs[0];
    if (!botId || !/^\d{15,20}$/.test(botId)) {
      return message.reply('❌ استخدام: `!ag whitelist add <bot_id>`');
    }
    WHITELISTED_BOT_IDS.add(botId);
    return message.channel.send({
      embeds: [
        new MessageEmbed()
          .setColor('#22c55e')
          .setDescription(`✅ تم إضافة \`${botId}\` للقائمة البيضاء. لن يتم حظره تلقائياً.`),
      ],
    });
  }

  // ─── WHITELIST LIST ───────────────────────────────────────
  if (message.content.startsWith('!ag whitelist list')) {
    const list = [...WHITELISTED_BOT_IDS].map(id => `\`${id}\``).join('\n');
    return message.channel.send({
      embeds: [
        new MessageEmbed()
          .setColor('#8b5cf6')
          .setTitle('✅ القائمة البيضاء للبوتات')
          .setDescription(list || 'فارغة'),
      ],
    });
  }

  // ─── LINK FILTER ──────────────────────────────────────────
  if (message.content.startsWith('!ag linkfilter')) {
    const sub = (args[2] || '').toLowerCase();
    const settings = loadAdminSettings();

    if (sub === 'on') {
      settings.linkFilter = true;
      saveAdminSettings(settings);
      return message.channel.send({
        embeds: [new MessageEmbed().setColor('#22c55e').setDescription('✅ **فلتر الروابط مفعّل** — سيتم حذف أي رابط يرسله غير المالك تلقائياً.')],
      });
    }
    if (sub === 'off') {
      settings.linkFilter = false;
      saveAdminSettings(settings);
      return message.channel.send({
        embeds: [new MessageEmbed().setColor('#f97316').setDescription('⭕ **فلتر الروابط موقف** — الروابط مسموح بها الآن.')],
      });
    }
    // status
    return message.channel.send({
      embeds: [
        new MessageEmbed()
          .setColor('#8b5cf6')
          .setTitle('🌐 حالة فلتر الروابط')
          .setDescription(settings.linkFilter
            ? '✅ **مفعّل** — الروابط من غير المالك تُحذف تلقائياً.'
            : '⭕ **موقف** — الروابط مسموح بها.')
          .addFields({ name: 'التفعيل', value: '`!ag linkfilter on`' }, { name: 'الإيقاف', value: '`!ag linkfilter off`' }),
      ],
    });
  }

  // ─── DELETE ALL CHANNELS ──────────────────────────────────
  if (cmd === '!ag deleteall') {
    const guildId = message.guild.id;
    const channelCount = message.guild.channels.cache.size;

    const row = new MessageActionRow().addComponents(
      new MessageButton()
        .setCustomId(`confirm_deleteall_${guildId}`)
        .setLabel(`⚠️ تأكيد — حذف ${channelCount} قناة`)
        .setStyle('DANGER'),
      new MessageButton()
        .setCustomId(`cancel_deleteall_${guildId}`)
        .setLabel('❌ إلغاء')
        .setStyle('SECONDARY'),
    );

    const confirmMsg = await message.channel.send({
      embeds: [
        new MessageEmbed()
          .setColor('#ef4444')
          .setTitle('⚠️ تحذير — حذف جميع القنوات')
          .setDescription(
            `هل أنت متأكد أنك تريد **حذف ${channelCount} قناة** في السيرفر؟\n\n` +
            `⚠️ هذا الإجراء **لا يمكن التراجع عنه!**\n` +
            `⏳ ينتهي هذا التأكيد خلال **30 ثانية**.`
          )
          .setTimestamp(),
      ],
      components: [row],
    });

    // Auto-expire after 30 seconds
    const timeout = setTimeout(async () => {
      pendingDeleteAll.delete(guildId);
      await confirmMsg.edit({
        embeds: [new MessageEmbed().setColor('#6b7280').setDescription('⏰ انتهت مهلة التأكيد.')],
        components: [],
      }).catch(() => {});
    }, 30000);

    pendingDeleteAll.set(guildId, { messageId: confirmMsg.id, timeout });
    return;
  }

  // ─── BACKUP ───────────────────────────────────────────────
  if (cmd === '!ag backup') {
    const backup   = createBackup(message.guild);
    const dir      = './backups';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    const fileName = `${message.guild.id}-${Date.now()}.json`;
    const filePath = path.join(dir, fileName);
    fs.writeFileSync(filePath, JSON.stringify(backup, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2));
    addLog('backup', message.author.tag, message.author.id, message.guild.id, fileName);
    return message.channel.send({
      embeds: [new MessageEmbed().setColor('#8b5cf6').setTitle('💾 Backup Created').setDescription(`Saved: \`${fileName}\``)],
    });
  }

  // ─── IMPORT ───────────────────────────────────────────────
  if (cmd === '!ag import') {
    const dir   = './backups';
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')) : [];
    if (!files.length) {
      return message.channel.send({
        embeds: [new MessageEmbed().setColor('#ef4444').setTitle('📥 Backup Panel').setDescription('❌ No backup files found.')],
      });
    }
    const sorted  = [...files].sort((a, b) => (parseInt(b.split('-').pop()) || 0) - (parseInt(a.split('-').pop()) || 0));
    const display = sorted.slice(0, 5);
    const embed   = new MessageEmbed()
      .setColor('#0ea5e9').setTitle('📥 Backup Panel')
      .setDescription(
        display.map((f, i) => `\`${i + 1}.\` ${f}`).join('\n') +
        '\n\nClick **Load Latest** or use `!ag load <filename>`.'
      );
    const row = new MessageActionRow().addComponents(
      new MessageButton().setCustomId('load_backup').setLabel('📂 Load Latest Backup').setStyle('PRIMARY'),
      new MessageButton().setCustomId('list_backups').setLabel('🗂️ List All Files').setStyle('SECONDARY'),
    );
    return message.channel.send({ embeds: [embed], components: [row] });
  }

  // ─── LOAD ─────────────────────────────────────────────────
  if (cmd === '!ag load') {
    const fileName = restArgs[0];
    if (!fileName) return message.reply('❌ Usage: `!ag load <filename>`');
    const filePath = `./backups/${fileName}`;
    if (!fs.existsSync(filePath)) return message.reply('❌ File not found.');
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    await message.channel.send({
      embeds: [new MessageEmbed().setColor('#f59e0b').setTitle('⚠️ Full Restore Starting').setDescription(`Restoring from \`${fileName}\`...`)],
    });
    await restoreGuild(message.guild, data);
    addLog('full_restore', message.author.tag, message.author.id, message.guild.id, fileName);
    return message.channel.send({
      embeds: [new MessageEmbed().setColor('#22c55e').setTitle('✅ Full Restore Complete').setDescription(`Restored from \`${fileName}\``)],
    });
  }

  // ─── KICK ─────────────────────────────────────────────────
  if (cmd === '!ag kick') {
    const member = message.mentions.members.first();
    if (!member) return message.reply('Mention a user');
    await member.kick().catch(() => {});
    return message.channel.send('✅ تم الطرد');
  }

  // ─── BAN ──────────────────────────────────────────────────
  if (cmd === '!ag ban') {
    const member = message.mentions.members.first();
    if (!member) return message.reply('Mention a user');
    await member.ban().catch(() => {});
    return message.channel.send('✅ تم الحظر');
  }

  // ─── UNBAN ────────────────────────────────────────────────
  if (cmd === '!ag unban') {
    const userId = restArgs[0];
    if (!userId) return message.reply('❌ Usage: `!ag unban <user_id>`');
    await message.guild.bans.remove(userId).catch(() => {});
    return message.channel.send(`✅ تم رفع الحظر عن \`${userId}\``);
  }

  // ─── CLEAR ────────────────────────────────────────────────
  if (cmd === '!ag clear') {
    const count = Math.min(parseInt(restArgs[0]) || 10, 100);
    await message.channel.bulkDelete(count).catch(() => {});
    return message.channel.send(`✅ تم مسح ${count} رسالة`);
  }

  // ─── LOCK ─────────────────────────────────────────────────
  if (cmd === '!ag lock') {
    await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, { SEND_MESSAGES: false });
    const m = await message.channel.send('🔒 القناة مقفلة');
    setTimeout(() => m.delete().catch(() => {}), 2000);
    return;
  }

  // ─── HIDE ─────────────────────────────────────────────────
  if (cmd === '!ag hide') {
    await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, { VIEW_CHANNEL: false });
    const m = await message.channel.send('👁️ القناة مخفية');
    setTimeout(() => m.delete().catch(() => {}), 2000);
    return;
  }

  // ─── UNLOCK ───────────────────────────────────────────────
  if (cmd === '!ag unlock') {
    await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, { SEND_MESSAGES: null });
    return message.channel.send('🔓 القناة مفتوحة');
  }

  // ─── NUKE ─────────────────────────────────────────────────
  if (cmd === '!ag nuke') {
    const newChannel = await message.channel.clone();
    await message.channel.delete();
    return newChannel.send('💥 تم نيوك القناة');
  }

  if (message.content.startsWith('!ag')) {
    return message.reply('❌ أمر غير معروف. استخدم `!ag help`');
  }
});

// ══════════════════════════════════════════════════════════════
// 🔘 INTERACTION (Button) HANDLER
// ══════════════════════════════════════════════════════════════
admin.on('interactionCreate', async (i) => {
  if (!i.isButton()) return;

  if (!isOwner(i.user.id)) {
    return i.reply({ content: '🚫 Owner only.', ephemeral: true });
  }

  // ─── DELETE ALL — Confirm ──────────────────────────────────
  if (i.customId.startsWith('confirm_deleteall_')) {
    const guildId = i.customId.replace('confirm_deleteall_', '');
    const pending = pendingDeleteAll.get(guildId);
    if (pending) {
      clearTimeout(pending.timeout);
      pendingDeleteAll.delete(guildId);
    }

    await i.deferUpdate().catch(() => {});
    await i.message.edit({
      embeds: [new MessageEmbed().setColor('#f97316').setDescription('⏳ جارٍ حذف جميع القنوات...')],
      components: [],
    }).catch(() => {});

    const guild = i.guild;
    let deleted = 0;
    for (const ch of [...guild.channels.cache.values()]) {
      await ch.delete('[Security] Owner: deleteall command').catch(() => {});
      deleted++;
      await new Promise(r => setTimeout(r, 300)); // rate-limit safety
    }

    // Create a new log channel since all channels were deleted
    try {
      const newCh = await guild.channels.create('🔐-admin-log', {
        type: 'GUILD_TEXT',
        topic: 'AdminGuard — تم إنشاء هذه القناة تلقائياً بعد deleteall',
      });
      await newCh.send({
        embeds: [
          new MessageEmbed()
            .setColor('#22c55e')
            .setTitle('✅ تم حذف جميع القنوات')
            .setDescription(`🗑️ تم حذف **${deleted}** قناة بواسطة المالك.\n📅 ${new Date().toLocaleString('ar-SA')}`)
            .setTimestamp(),
        ],
      });
    } catch {}

    addLog('deleteall', i.user.tag, i.user.id, guildId, `Deleted ${deleted} channels`);
    addSecurityEvent('DELETEALL', i.user.tag, i.user.id, guild.name, guildId, `المالك حذف ${deleted} قناة`);
    return;
  }

  // ─── DELETE ALL — Cancel ───────────────────────────────────
  if (i.customId.startsWith('cancel_deleteall_')) {
    const guildId = i.customId.replace('cancel_deleteall_', '');
    const pending = pendingDeleteAll.get(guildId);
    if (pending) {
      clearTimeout(pending.timeout);
      pendingDeleteAll.delete(guildId);
    }
    await i.update({
      embeds: [new MessageEmbed().setColor('#22c55e').setDescription('✅ تم إلغاء الأمر — لم يُحذف أي شيء.')],
      components: [],
    }).catch(() => {});
    return;
  }

  if (i.customId === 'list_backups') {
    const dir   = './backups';
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')) : [];
    const sorted = [...files].sort((a, b) => (parseInt(b.split('-').pop()) || 0) - (parseInt(a.split('-').pop()) || 0));
    return i.reply({
      content: sorted.length
        ? '**All backup files (newest first):**\n' + sorted.map((f, idx) => `\`${idx + 1}.\` ${f}`).join('\n')
        : 'No backups found.',
      ephemeral: true,
    });
  }

  if (i.customId === 'load_backup') {
    const dir   = './backups';
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')) : [];
    if (!files.length) return i.reply({ content: '❌ No backup files found.', ephemeral: true });

    const sorted = [...files].sort((a, b) => (parseInt(b.split('-').pop()) || 0) - (parseInt(a.split('-').pop()) || 0));
    const latest = sorted[0];
    selectedBackup.set(i.guild.id, latest);

    const data = JSON.parse(fs.readFileSync(`./backups/${latest}`, 'utf8'));
    const row  = new MessageActionRow().addComponents(
      new MessageButton().setCustomId('restore_roles').setLabel('👑 Restore Roles').setStyle('PRIMARY'),
      new MessageButton().setCustomId('restore_channels').setLabel('📁 Restore Channels').setStyle('PRIMARY'),
      new MessageButton().setCustomId('restore_settings').setLabel('⚙️ Restore Server Info').setStyle('SECONDARY'),
      new MessageButton().setCustomId('restore_full').setLabel('♻️ Full Restore').setStyle('DANGER'),
    );
    return i.reply({
      embeds: [
        new MessageEmbed()
          .setColor('#0ea5e9').setTitle('📂 Backup Loaded')
          .setDescription(
            `**File:** \`${latest}\`\n**Server:** ${data.name}\n` +
            `**Roles:** ${data.roles?.length || 0}\n**Channels:** ${data.channels?.length || 0}\n\n` +
            'Choose what to restore below. **Full Restore** will wipe everything first.'
          ),
      ],
      components: [row],
      ephemeral: true,
    });
  }

  if (i.customId === 'restore_roles') {
    await i.deferReply({ ephemeral: true });
    const data = loadSelectedBackup(i.guild.id);
    if (!data) return i.editReply({ content: '❌ No backup loaded.' });
    await restoreRoles(i.guild, data);
    addLog('restore_roles', i.user.tag, i.user.id, i.guild.id, selectedBackup.get(i.guild.id) || 'latest');
    return i.editReply({ content: '✅ Roles restored.' });
  }

  if (i.customId === 'restore_channels') {
    await i.deferReply({ ephemeral: true });
    const data = loadSelectedBackup(i.guild.id);
    if (!data) return i.editReply({ content: '❌ No backup loaded.' });
    await restoreChannels(i.guild, data);
    addLog('restore_channels', i.user.tag, i.user.id, i.guild.id, selectedBackup.get(i.guild.id) || 'latest');
    return i.editReply({ content: '✅ Channels restored.' });
  }

  if (i.customId === 'restore_settings') {
    await i.deferReply({ ephemeral: true });
    const data = loadSelectedBackup(i.guild.id);
    if (!data) return i.editReply({ content: '❌ No backup loaded.' });
    await restoreSettings(i.guild, data);
    addLog('restore_settings', i.user.tag, i.user.id, i.guild.id, selectedBackup.get(i.guild.id) || 'latest');
    return i.editReply({ content: '✅ Server settings restored.' });
  }

  if (i.customId === 'restore_full') {
    await i.deferReply({ ephemeral: true });
    const data = loadSelectedBackup(i.guild.id);
    if (!data) return i.editReply({ content: '❌ No backup loaded.' });
    await restoreGuild(i.guild, data);
    addLog('full_restore', i.user.tag, i.user.id, i.guild.id, selectedBackup.get(i.guild.id) || 'latest');
    return i.editReply({ content: '✅ Full restore complete.' });
  }
});

// ══════════════════════════════════════════════════════════════
// 💾 Backup / Restore Functions
// ══════════════════════════════════════════════════════════════
function createBackup(guild) {
  return {
    name: guild.name,
    icon: guild.iconURL({ extension: 'png', size: 4096 }),
    roles: guild.roles.cache
      .filter(r => r.id !== guild.id)
      .sort((a, b) => b.position - a.position)
      .map(r => ({
        id: r.id, name: r.name, color: r.color,
        permissions: r.permissions.bitfield.toString(),
        hoist: r.hoist, mentionable: r.mentionable, position: r.position,
      })),
    channels: guild.channels.cache
      .sort((a, b) => a.position - b.position)
      .map(c => ({
        id: c.id, name: c.name, type: c.type, parentId: c.parentId || null,
        position: c.position, topic: c.topic || null, nsfw: c.nsfw || false,
        rateLimitPerUser: c.rateLimitPerUser || 0, bitrate: c.bitrate || null,
        userLimit: c.userLimit || null,
        permissionOverwrites: c.permissionOverwrites.cache.map(p => ({
          id: p.id, allow: p.allow.bitfield.toString(),
          deny: p.deny.bitfield.toString(), type: p.type,
        })),
      })),
  };
}

function loadSelectedBackup(guildId) {
  const dir   = './backups';
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')) : [];
  if (!files.length) return null;
  const fileName = selectedBackup.get(guildId);
  const filePath = fileName ? `./backups/${fileName}` : null;
  if (filePath && fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const sorted = [...files].sort((a, b) => (parseInt(b.split('-').pop()) || 0) - (parseInt(a.split('-').pop()) || 0));
  return JSON.parse(fs.readFileSync(`./backups/${sorted[0]}`, 'utf8'));
}

async function restoreSettings(guild, data) {
  if (data.name) await guild.setName(data.name).catch(() => {});
  if (data.icon) await guild.setIcon(data.icon).catch(() => {});
}

async function restoreRoles(guild, data) {
  if (!data.roles?.length) return;
  for (const role of data.roles) {
    await guild.roles.create({
      name: role.name, color: role.color, permissions: BigInt(role.permissions),
      hoist: role.hoist, mentionable: role.mentionable, position: role.position,
      reason: 'AdminGuard restore',
    }).catch(() => {});
  }
}

async function restoreChannels(guild, data) {
  if (!data.channels?.length) return;
  const categoryMap = new Map();

  for (const cat of data.channels.filter(c => isCategory(c.type))) {
    const newCat = await guild.channels.create(cat.name, {
      type: 'GUILD_CATEGORY', position: cat.position, reason: 'AdminGuard restore',
    }).catch(() => null);
    if (newCat) {
      categoryMap.set(cat.id, newCat.id);
      for (const perm of (cat.permissionOverwrites || [])) {
        await newCat.permissionOverwrites.create(perm.id, {
          allow: BigInt(perm.allow), deny: BigInt(perm.deny),
        }).catch(() => {});
      }
    }
  }

  for (const ch of data.channels.filter(c => !isCategory(c.type))) {
    const stringType = toStringType(ch.type);
    if (!stringType) continue;
    const parentId = ch.parentId ? categoryMap.get(ch.parentId) : null;
    const options  = { type: stringType, position: ch.position, reason: 'AdminGuard restore' };
    if (parentId)          options.parent            = parentId;
    if (ch.topic)          options.topic             = ch.topic;
    if (ch.nsfw)           options.nsfw              = ch.nsfw;
    if (ch.rateLimitPerUser) options.rateLimitPerUser = ch.rateLimitPerUser;
    if (ch.bitrate && (stringType === 'GUILD_VOICE' || stringType === 'GUILD_STAGE_VOICE')) options.bitrate    = ch.bitrate;
    if (ch.userLimit && (stringType === 'GUILD_VOICE' || stringType === 'GUILD_STAGE_VOICE')) options.userLimit = ch.userLimit;
    const newCh = await guild.channels.create(ch.name, options).catch(() => null);
    if (!newCh) continue;
    for (const perm of (ch.permissionOverwrites || [])) {
      await newCh.permissionOverwrites.create(perm.id, {
        allow: BigInt(perm.allow), deny: BigInt(perm.deny),
      }).catch(() => {});
    }
  }
}

async function restoreGuild(guild, data) {
  await wipeGuild(guild);
  await restoreSettings(guild, data);
  if (data.roles?.length) {
    for (const role of data.roles) {
      await guild.roles.create({
        name: role.name, color: role.color, permissions: BigInt(role.permissions),
        hoist: role.hoist, mentionable: role.mentionable, position: role.position,
        reason: 'AdminGuard full restore',
      }).catch(() => {});
    }
  }
  await restoreChannels(guild, data);
}

async function wipeGuild(guild) {
  for (const ch of [...guild.channels.cache.values()]) {
    await ch.delete().catch(() => {});
  }
  for (const role of [...guild.roles.cache.values()]) {
    if (role.id !== guild.id && role.managed === false) {
      await role.delete().catch(() => {});
    }
  }
}

// ── Ready ──────────────────────────────────────────────────────
admin.on('ready', () => {
  console.log(`[AdminGuard] Logged in as ${admin.user.tag}`);
  admin.user.setActivity('Diamond Casino 💎 — Security Active 🔐', { type: 'WATCHING' });
});

// ── Start ──────────────────────────────────────────────────────
function startAdminBot() {
  if (!ADMIN_TOKEN) {
    console.error('Missing ADMIN_BOT_TOKEN in .env');
    return;
  }
  admin.login(ADMIN_TOKEN).catch((e) => {
    console.error('[AdminGuard] Login failed:', e.message);
  });
}

module.exports = { startAdminBot, admin };
