const mongoose = require('mongoose');

const ipBanSchema = new mongoose.Schema({
  ip: { type: String, required: true, unique: true },
  reason: { type: String, default: 'DevTools detected' },
  bannedAt: { type: Date, default: Date.now },
  expiresAt: { type: Date },
  userAgent: { type: String },
  userId: { type: String }, // إذا كان المستخدم مسجل الدخول
  username: { type: String }
});

module.exports = mongoose.model('IpBan', ipBanSchema);