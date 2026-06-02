'use strict';
const { Schema, model } = require('mongoose');

const watchLogSchema = new Schema({
  roomId:           { type: String, default: '' },
  ownerId:          { type: String, default: '' },
  ownerUsername:    { type: String, default: '' },
  title:            { type: String, default: '' },
  participants:     [{ userId: String, username: String }],
  videoLog:         [{ url: String, loadedAt: Number, loadedByUsername: String }],
  startedAt:        { type: Number, default: null },
  endedAt:          { type: Number, default: null },
  durationSec:      { type: Number, default: 0 },
  costPerPerson:    { type: Number, default: 0 },
  participantCount: { type: Number, default: 0 },
  createdAt:        { type: Date, default: Date.now },
});

module.exports = model('WatchLog', watchLogSchema);
