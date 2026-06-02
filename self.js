// self.js - حسابات البنوك المتعددة (تنتظر رسالة ProBot التأكيدية)
const { Client } = require('discord.js-selfbot-v13');
const fs = require('fs');
const path = require('path');
const { addDepositLog } = require('./banks');

// تخزين طلبات الشحن المؤقتة
const pendingConfirmations = new Map();
// تخزين معرفات الرسائل المعالجة لمنع التكرار
const processedTransactions = new Set(); // لتخزين معرف فريد للمعاملة

// قناة اللوج
let DEPOSIT_LOG_CHANNEL_ID = null;

try {
  const logConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'logChannel.json'), 'utf8'));
  DEPOSIT_LOG_CHANNEL_ID = logConfig.channelId;
} catch {
  console.log("⚠️ لم يتم تعيين قناة اللوج - استخدم !setlogchannel لتعيينها");
}

// إضافة رصيد للمستخدم مع تطبيق البونص
async function addUserBalance(userId, amount, db, bankName = null) {
  let userData = await db.findOne({ id: userId });
  if (!userData) {
    userData = await db.create({
      id: userId,
      coins: 0,
      status_playing: 'no',
      deposits: 0,
    });
  }
  
  // تطبيق البونص
  let bonusAmount = 0;
  let bonusPct = 0;
  let finalAmount = amount;
  
  if (global.applyBonus && typeof global.applyBonus === 'function') {
    const bonusResult = await global.applyBonus(userId, amount, null);
    if (bonusResult && bonusResult.bonusAmount) {
      bonusAmount = bonusResult.bonusAmount;
      bonusPct = bonusResult.pct;
      finalAmount = amount + bonusAmount;
    }
  }
  
  userData.coins = parseInt(userData.coins || 0) + finalAmount;
  userData.deposits = (userData.deposits || 0) + amount;
  await userData.save();
  
  return { newBalance: userData.coins, bonusAmount, bonusPct, finalAmount, baseAmount: amount };
}

// إرسال سجل الإيداع إلى قناة اللوج
async function sendToLogChannel(mainClient, data) {
  if (!DEPOSIT_LOG_CHANNEL_ID) return;
  
  try {
    const logChannel = await mainClient.channels.fetch(DEPOSIT_LOG_CHANNEL_ID);
    if (!logChannel) return;
    
    const embed = new Discord.MessageEmbed()
      .setColor('#00ff00')
      .setTitle('💰 عملية شحن جديدة')
      .setDescription(
        `> ━━━━━━━━━━━━━━━━━━━━\n` +
        `> 🏦 **البنك:** ${data.bankName}\n` +
        `> 👤 **المستخدم:** <@${data.userId}> (${data.username})\n` +
        `> 💰 **المبلغ الأساسي:** \`${data.baseAmount.toLocaleString()}\`\n` +
        (data.bonusAmount > 0 ? `> 🎁 **البونص:** +\`${data.bonusAmount.toLocaleString()}\` (${data.bonusPct}%)\n` : '') +
        `> 💎 **الإجمالي المضاف:** \`${data.finalAmount.toLocaleString()}\`\n` +
        `> 💵 **الرصيد الجديد:** \`${data.newBalance.toLocaleString()}\`\n` +
        `> 🆔 **معرف المستخدم:** \`${data.userId}\`\n` +
        `> 🖥️ **السيرفر:** ${data.serverName || 'غير معروف'}\n` +
        `> 📅 **الوقت:** <t:${Math.floor(Date.now() / 1000)}:F>\n` +
        `> ━━━━━━━━━━━━━━━━━━━━`
      )
      .setFooter({ text: 'نظام الشحن المتعدد • Diamond Casino' })
      .setTimestamp();
    
    await logChannel.send({ embeds: [embed] });
    
  } catch (error) {
    console.error("❌ خطأ في إرسال السجل:", error.message);
  }
}

// إنشاء معرف فريد للمعاملة لمنع التكرار
function getTransactionKey(senderId, receiverId, amount, timestamp) {
  // نستخدم حوالي 5 دقائق كنافذة زمنية لمنع التكرار
  const timeWindow = Math.floor(timestamp / (5 * 60 * 1000));
  return `${senderId}_${receiverId}_${amount}_${timeWindow}`;
}

// تشغيل حساب بنك واحد
async function startBank(bank, db, mainClient) {
  if (!bank.token || !bank.active) return null;
  
  const client = new Client({ checkUpdate: false });
  
  client.on('ready', () => {
    console.log(`🏦 [Bank] ${bank.name} → Online as ${client.user.tag}`);
  });
  
  client.on('messageCreate', async (message) => {
    if (message.author.id === client.user.id) return;
    
    // التحقق من السيرفر
    if (!bank.serverIds || !bank.serverIds.includes(message.guild?.id)) return;
    if (bank.channelId && message.channel.id !== bank.channelId) return;
    
    const content = message.content;
    
    // ============================================================
    // 1️⃣ الكشف عن أمر #credit من المستخدم (يسجل طلباً)
    // ============================================================
    if (content.startsWith('#credit') || content.startsWith('#credits')) {
      const parts = content.split(' ');
      if (parts.length < 3) return;
      
      const targetUserId = parts[1];
      const amountRaw = parts[2];
      
      // تحويل المبلغ
      let amount = parseInt(amountRaw);
      if (isNaN(amount)) {
        const match = amountRaw.match(/(\d+(?:\.\d+)?)([kKmM])?/);
        if (match) {
          amount = parseInt(match[1]);
          if (match[2] && match[2].toLowerCase() === 'k') amount *= 1000;
          if (match[2] && match[2].toLowerCase() === 'm') amount *= 1000000;
        }
      }
      
      if (isNaN(amount) || amount <= 0) return;
      
      // التحقق من أن المستخدم المستهدف هو بنكنا
      if (targetUserId !== bank.bankUserId) return;
      
      // تسجيل طلب مؤقت
      pendingConfirmations.set(message.author.id, {
        userId: message.author.id,
        username: message.author.username,
        amount: amount,
        bankName: bank.name,
        bankUserId: bank.bankUserId,
        channelId: message.channel.id,
        messageId: message.id,
        guildId: message.guild?.id,
        guildName: message.guild?.name,
        createdAt: Date.now(),
      });
      
      console.log(`⏳ [Bank ${bank.name}] تم تسجيل طلب شحن من ${message.author.username} (${message.author.id}) بمبلغ ${amount.toLocaleString()} - بانتظار تأكيد ProBot`);
      
      return;
    }
    
    // ============================================================
    // 2️⃣ الكشف عن رسالة ProBot التأكيدية (التحويل الناجح)
    // الصيغة: **:moneybag: | igd8, has transferred `$475` to <@!...> **
    // ============================================================
    if (content.includes(':moneybag:') && content.includes('has transferred')) {
      // استخراج اسم المرسل
      const senderMatch = content.match(/\|\s*(.+?),\s*has transferred/i);
      if (!senderMatch) return;
      
      const senderUsername = senderMatch[1].trim();
      
      // استخراج المبلغ
      const amountMatch = content.match(/transferred\s+`?\$?([\d,]+)/i);
      if (!amountMatch) return;
      
      const transferredAmount = parseInt(amountMatch[1].replace(/,/g, ''));
      if (isNaN(transferredAmount)) return;
      
      // استخراج المستلم (بنكنا)
      const receiverMatch = content.match(/to\s+<@!?(\d+)>/i);
      if (!receiverMatch) return;
      
      const receiverId = receiverMatch[1];
      
      // التأكد أن المستلم هو بنكنا
      if (receiverId !== bank.bankUserId) return;
      
      // البحث عن طلب معلق بنفس اسم المستخدم
      let pendingRequest = null;
      for (const [userId, req] of pendingConfirmations.entries()) {
        if (req.username.toLowerCase() === senderUsername.toLowerCase()) {
          pendingRequest = req;
          pendingConfirmations.delete(userId);
          break;
        }
      }
      
      if (!pendingRequest) {
        console.log(`⚠️ [Bank ${bank.name}] استلام تحويل من ${senderUsername} ولكن لا يوجد طلب معلق`);
        return;
      }
      
      // التحقق من تطابق المبلغ (مع السماح بفارق بسيط بسبب الضريبة)
      const expectedAmount = pendingRequest.amount;
      const actualAmount = transferredAmount;
      
      // إنشاء معرف فريد للمعاملة لمنع التكرار
      const transactionKey = getTransactionKey(
        pendingRequest.userId, 
        receiverId, 
        actualAmount, 
        Date.now()
      );
      
      if (processedTransactions.has(transactionKey)) {
        console.log(`⚠️ [Bank ${bank.name}] تم تجاهل معاملة مكررة: ${senderUsername} - ${actualAmount}`);
        return;
      }
      processedTransactions.add(transactionKey);
      setTimeout(() => processedTransactions.delete(transactionKey), 10 * 60 * 1000); // تنظيف بعد 10 دقائق
      
      console.log(`✅ [Bank ${bank.name}] تأكيد ProBot: تم تحويل ${actualAmount} من ${senderUsername} إلى البنك`);
      
      // إضافة الرصيد للمستخدم
      let newBalance = 0;
      let bonusAmount = 0;
      let bonusPct = 0;
      let finalAmount = actualAmount;
      
      if (mainClient && db) {
        const result = await addUserBalance(pendingRequest.userId, actualAmount, db, bank.name);
        newBalance = result.newBalance;
        bonusAmount = result.bonusAmount;
        bonusPct = result.bonusPct;
        finalAmount = result.finalAmount;
        
        // تسجيل السجل
        addDepositLog(
          pendingRequest.userId,
          senderUsername,
          actualAmount,
          bank.name,
          'completed',
          pendingRequest.guildId,
          pendingRequest.channelId
        );
        
        // إرسال السجل إلى قناة اللوج
        await sendToLogChannel(mainClient, {
          userId: pendingRequest.userId,
          username: senderUsername,
          baseAmount: actualAmount,
          bonusAmount: bonusAmount,
          bonusPct: bonusPct,
          finalAmount: finalAmount,
          newBalance: newBalance,
          bankName: bank.name,
          serverName: pendingRequest.guildName,
          channelId: pendingRequest.channelId,
        });
        
        // إشعار المستخدم في الخاص
        try {
          const user = await mainClient.users.fetch(pendingRequest.userId);
          const embed = new Discord.MessageEmbed()
            .setColor('#00ff00')
            .setTitle('✅ تم الشحن بنجاح!')
            .setDescription(
              `> 🏦 **البنك:** ${bank.name}\n` +
              `> 💰 **المبلغ المحول:** \`${actualAmount.toLocaleString()}\`\n` +
              (bonusAmount > 0 ? `> 🎁 **البونص:** +\`${bonusAmount.toLocaleString()}\` (${bonusPct}%)\n` : '') +
              `> 💎 **الإجمالي المضاف:** \`${finalAmount.toLocaleString()}\`\n` +
              `> 💵 **الرصيد الجديد:** \`${newBalance.toLocaleString()}\``
            )
            .setTimestamp();
          await user.send({ embeds: [embed] });
        } catch {}
      }
      
      console.log(`✅ [Bank ${bank.name}] اكتمل شحن ${senderUsername} - المبلغ: ${actualAmount} (+${bonusAmount} بونص) - الرصيد الجديد: ${newBalance}`);
    }
  });
  
  // تنظيف الطلبات القديمة (كل دقيقة)
  setInterval(() => {
    const now = Date.now();
    for (const [userId, req] of pendingConfirmations.entries()) {
      if (now - req.createdAt > 120000) { // 120 ثانية
        console.log(`⏰ [Bank ${bank.name}] انتهت صلاحية طلب شحن ${req.username}`);
        pendingConfirmations.delete(userId);
      }
    }
  }, 60000);
  
  client.on('error', (err) => {
    console.error(`[Bank ${bank.name}] Error:`, err.message);
  });
  
  try {
    await client.login(bank.token);
    console.log(`✅ [Bank] ${bank.name} logged in successfully`);
    return client;
  } catch (err) {
    console.error(`[Bank ${bank.name}] Failed to login:`, err.message);
    return null;
  }
}

// تشغيل جميع البنوك
async function startAllBanks(db, mainClient) {
  const { readBanks } = require('./banks');
  const banks = readBanks();
  const activeClients = [];
  
  console.log(`🏦 Starting ${banks.filter(b => b.active).length} bank accounts...`);
  
  for (const bank of banks) {
    if (bank.active && bank.token) {
      const client = await startBank(bank, db, mainClient);
      if (client) activeClients.push(client);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  
  console.log(`🏦 Started ${activeClients.length} bank accounts successfully`);
  return activeClients;
}

module.exports = { startBank, startAllBanks, addUserBalance };