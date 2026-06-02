const mongoose = require('mongoose');

const devtoolsLogSchema = new mongoose.Schema({
  ip: { type: String, required: true },
  userId: { type: String },
  username: { type: String },
  userAgent: { type: String },
  timestamp: { type: Date, default: Date.now }
});

module.exports = mongoose.model('DevtoolsLog', devtoolsLogSchema);