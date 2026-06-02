// banks.js
const fs = require('fs');
const path = require('path');

const BANKS_PATH = path.join(__dirname, 'banks.json');
const DEPOSIT_LOGS_PATH = path.join(__dirname, 'depositLogs.json');

// قراءة البنوك
function readBanks() {
  try {
    return JSON.parse(fs.readFileSync(BANKS_PATH, 'utf8'));
  } catch {
    return [];
  }
}

// حفظ البنوك
function writeBanks(banks) {
  fs.writeFileSync(BANKS_PATH, JSON.stringify(banks, null, 2));
}

// إضافة سجل شحن
function addDepositLog(userId, username, amount, bankName, status, serverId, channelId) {
  let logs = [];
  try {
    logs = JSON.parse(fs.readFileSync(DEPOSIT_LOGS_PATH, 'utf8'));
  } catch {}
  
  logs.unshift({
    userId,
    username,
    amount,
    bankName,
    status,
    serverId,
    channelId,
    timestamp: Date.now(),
  });
  
  // الاحتفاظ بآخر 500 سجل فقط
  if (logs.length > 500) logs = logs.slice(0, 500);
  fs.writeFileSync(DEPOSIT_LOGS_PATH, JSON.stringify(logs, null, 2));
}

// الحصول على إجمالي الشحنات
function getTotalDeposits() {
  try {
    const logs = JSON.parse(fs.readFileSync(DEPOSIT_LOGS_PATH, 'utf8'));
    return logs.filter(l => l.status === 'completed').reduce((sum, l) => sum + (l.amount || 0), 0);
  } catch {
    return 0;
  }
}

// الحصول على آخر الشحنات
function getRecentDeposits(limit = 20) {
  try {
    const logs = JSON.parse(fs.readFileSync(DEPOSIT_LOGS_PATH, 'utf8'));
    return logs.slice(0, limit);
  } catch {
    return [];
  }
}

// الحصول على إجمالي السحب (من سجل الرسائل في القاعة)
function getTotalWithdrawals() {
  try {
    const logs = JSON.parse(fs.readFileSync(DEPOSIT_LOGS_PATH, 'utf8'));
    // تتبع السحب بحثاً عن حالة السحب المعتمد
    const withdrawals = logs.filter(l => l.status === 'withdrawal_approved').reduce((sum, l) => sum + (l.amount || 0), 0);
    return withdrawals;
  } catch {
    return 0;
  }
}

module.exports = {
  readBanks,
  writeBanks,
  addDepositLog,
  getTotalDeposits,
  getRecentDeposits,
  getTotalWithdrawals,
};