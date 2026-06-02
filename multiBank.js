// multiBank.js
const fs = require('fs');
const path = require('path');
const Discord = require('discord.js');
const { readBanks, writeBanks, getTotalDeposits, getRecentDeposits } = require('./banks');

const DEPOSIT_MODE_PATH = path.join(__dirname, 'depositMode.json');

let currentMode = 'single'; // 'single' أو 'multi'

// تحميل وضع الشحن المحفوظ
function loadDepositMode() {
  try {
    const config = JSON.parse(fs.readFileSync(DEPOSIT_MODE_PATH, 'utf8'));
    currentMode = config.mode === 'multi' ? 'multi' : 'single';
  } catch {
    currentMode = 'single';
  }
  return currentMode;
}

// حفظ وضع الشحن
function saveDepositMode(mode) {
  currentMode = mode;
  fs.writeFileSync(DEPOSIT_MODE_PATH, JSON.stringify({ mode }, null, 2));
}

// تبديل وضع الشحن
function toggleDepositMode(mode) {
  if (mode === 'single' || mode === 'multi') {
    saveDepositMode(mode);
    return true;
  }
  return false;
}

// الحصول على البنوك النشطة
function getActiveBanks() {
  const banks = readBanks();
  return banks.filter(b => b.active);
}

// الحصول على بنك عشوائي
function getRandomBank() {
  const activeBanks = getActiveBanks();
  if (activeBanks.length === 0) return null;
  return activeBanks[Math.floor(Math.random() * activeBanks.length)];
}

// إنشاء رابط دعوة للسيرفر
async function createInviteLink(client, serverId) {
  try {
    const guild = await client.guilds.fetch(serverId).catch(() => null);
    if (!guild) return null;
    
    const channels = guild.channels.cache;
    let inviteChannel = channels.find(c => 
      c.type === 'GUILD_TEXT' && 
      c.permissionsFor(guild.me)?.has('CREATE_INSTANT_INVITE')
    );
    
    if (!inviteChannel) {
      inviteChannel = channels.find(c => c.type === 'GUILD_TEXT');
    }
    
    if (inviteChannel) {
      const invite = await inviteChannel.createInvite({
        maxAge: 86400,
        maxUses: 0,
        reason: 'Bank deposit invite'
      });
      return invite.url;
    }
    return null;
  } catch (err) {
    console.error(`Error creating invite for ${serverId}:`, err.message);
    return null;
  }
}

// إرسال معلومات الشحن للمستخدم
async function sendDepositInfo(user, mainClient) {
  const activeBanks = getActiveBanks();
  
  if (currentMode === 'single' || activeBanks.length === 0) {
    // الوضع الأحادي
    const ownerId = '1206272245417246750';
    const embed = new Discord.MessageEmbed()
      .setColor('#032943')
      .setTitle('💰 معلومات الشحن')
      .setDescription(
        `> استخدم الأمر التالي للتحويل:\n` +
        `> \`#credit ${ownerId} المبلغ\`\n\n` +
        `> **مثال:**\n` +
        `> \`#credit ${ownerId} 1000000\``
      )
      .setFooter({ text: 'Diamond Casino — شحن مباشر' })
      .setTimestamp();
    
    return { embed, bank: null };
  }
  
  // الوضع المتعدد - اختيار بنك عشوائي
  const bank = getRandomBank();
  if (!bank) {
    const embed = new Discord.MessageEmbed()
      .setColor('#ff0000')
      .setTitle('⚠️ لا توجد بنوك متاحة')
      .setDescription('> لا توجد بنوك مفعلة حالياً. تواصل مع الإدارة.');
    return { embed, bank: null };
  }
  
  // إنشاء روابط الدعوة للسيرفرات
  const serverIds = bank.serverIds || [];
  const invites = [];
  
  for (const serverId of serverIds) {
    const inviteLink = await createInviteLink(mainClient, serverId);
    if (inviteLink) {
      invites.push(`> 🖥️ **رابط السيرفر:** ${inviteLink}`);
    } else {
      invites.push(`> 🖥️ **Server ID:** \`${serverId}\` (لا يمكن إنشاء رابط)`);
    }
  }
  
  const embed = new Discord.MessageEmbed()
    .setColor('#032943')
    .setTitle(`💰 شحن رصيدك — بنك ${bank.name}`)
    .setDescription(
      `> 🏦 **اسم البنك:** ${bank.name}\n` +
      `> 👤 **ID البنك:** \`${bank.bankUserId}\`\n` +
      `> ━━━━━━━━━━━━━━━━━━━━\n` +
      `> **📍 خطوات الشحن:**\n` +
      `> 1️⃣ انضم إلى السيرفر عبر الرابط أدناه\n` +
      `> 2️⃣ اذهب إلى قناة الشحن المخصصة\n` +
      `> 3️⃣ أرسل الأمر التالي:\n` +
      `> \`#credit ${bank.bankUserId} المبلغ\`\n` +
      `> ━━━━━━━━━━━━━━━━━━━━\n` +
      invites.join('\n') +
      `\n> ━━━━━━━━━━━━━━━━━━━━\n` +
      `> ⚠️ **سيتم حذف هذه الرسالة بعد 20 ثانية**`
    )
    .setFooter({ text: 'Diamond Casino — نظام شحن آمن' })
    .setTimestamp();
  
  return { embed, bank };
}

// إنشاء لوحة تحكم البنوك للأدمن
function createAdminBankPanel() {
  const banks = readBanks();
  const activeCount = banks.filter(b => b.active).length;
  const totalDeposits = getTotalDeposits();
  const recentLogs = getRecentDeposits(5);
  
  let recentText = '';
  if (recentLogs.length > 0) {
    recentText = recentLogs.map(log => {
      const date = new Date(log.timestamp).toLocaleString();
      return `> <@${log.userId}> — ${log.amount?.toLocaleString()} — ${date}`;
    }).join('\n');
  } else {
    recentText = '> لا توجد شحنات حديثة';
  }
  
  const embed = new Discord.MessageEmbed()
    .setColor('#032943')
    .setTitle('🏦 لوحة تحكم البنوك')
    .setDescription(
      `> 📊 **الحالة الحالية:**\n` +
      `> ━━━━━━━━━━━━━━━━━━━━\n` +
      `> 🏦 **وضع الشحن:** \`${currentMode === 'multi' ? 'متعدد البنوك 🏦' : 'أحادي (ProBot) 💰'}\`\n` +
      `> 🏛️ **البنوك المفعلة:** \`${activeCount}\`\n` +
      `> 💰 **إجمالي الشحنات:** \`${totalDeposits.toLocaleString()}\`\n\n` +
      `> 📋 **آخر 5 شحنات:**\n${recentText}\n\n` +
      `> ━━━━━━━━━━━━━━━━━━━━\n` +
      `> **الأوامر المتاحة:**\n` +
      `> \`!addbank <BankUser> <BankId> <Token> <ServerID|ServerID2>\`\n` +
      `> \`!listbanks\` — عرض جميع البنوك\n` +
      `> \`!removebank <id>\` — حذف بنك\n` +
      `> \`!togglebank <id>\` — تفعيل/إيقاف بنك\n` +
      `> \`!toggledep <single|multi>\` — تبديل وضع الشحن\n` +
      `> \`!dep\` — عرض معلومات الشحن\n` +
      `> \`شحن\` — استلام تفاصيل بنك عشوائي في الخاص\n` +
      `> \`!depositlogs\` — عرض سجل الشحنات الكامل`
    )
    .setTimestamp();
  
  return embed;
}

// إضافة بنك جديد
function addBank(name, bankUserId, token, serverIds) {
  const banks = readBanks();
  
  const newBank = {
    id: `bank_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name,
    bankUserId,
    token,
    serverIds: serverIds.split('|').map(s => s.trim()),
    channelId: null, // يمكن تحديده لاحقاً
    active: true,
    addedAt: Date.now(),
  };
  
  banks.push(newBank);
  writeBanks(banks);
  return newBank;
}

// حذف بنك
function removeBank(bankId) {
  const banks = readBanks();
  const index = banks.findIndex(b => b.id === bankId);
  if (index === -1) return null;
  const removed = banks.splice(index, 1)[0];
  writeBanks(banks);
  return removed;
}

// تبديل حالة البنك
function toggleBank(bankId) {
  const banks = readBanks();
  const bank = banks.find(b => b.id === bankId);
  if (!bank) return null;
  bank.active = !bank.active;
  writeBanks(banks);
  return bank;
}

// عرض معلومات البنوك
function listBanks() {
  const banks = readBanks();
  if (banks.length === 0) return 'لا توجد بنوك مُضافة.';
  
  return banks.map((b, i) => {
    return `**${i + 1}.** ${b.active ? '🟢' : '🔴'} **${b.name}**\n` +
           `> 🆔 \`${b.id}\`\n` +
           `> 👤 Bank User: \`${b.bankUserId}\`\n` +
           `> 🖥️ السيرفرات: ${(b.serverIds || []).join(', ')}`;
  }).join('\n\n');
}

module.exports = {
  loadDepositMode,
  toggleDepositMode,
  getActiveBanks,
  getRandomBank,
  sendDepositInfo,
  createAdminBankPanel,
  addBank,
  removeBank,
  toggleBank,
  listBanks,
  get currentMode() { return currentMode; },
};