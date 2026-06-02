'use strict';
const { Schema, model } = require('mongoose');

const adminLogSchema = new Schema({
  adminId:        { type: String, default: '' },
  adminUsername:  { type: String, default: '' },
  action:         { type: String, default: '' },
  collectionName: { type: String, default: '' },
  docId:          { type: String, default: '' },
  notes:          { type: String, default: '' },
  createdAt:     { type: Date, default: Date.now },
});

module.exports = model('AdminLog', adminLogSchema);
