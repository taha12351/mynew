'use strict';
const { Schema, model } = require('mongoose');
const ParkourGameSchema = new Schema({
  gameId:           { type: String, required: true, unique: true },
  player1:          { type: String, required: true },
  player2:          { type: String, required: true },
  player1Username:  { type: String, default: '' },
  player2Username:  { type: String, default: '' },
  betAmount:        { type: Number, default: 0 },
  status:           { type: String, default: 'waiting' }, // waiting|active|finished|abandoned
  result:           { type: String, default: null },       // player1|player2|draw
  resultReason:     { type: String, default: null },
  channelId:        { type: String, default: null },
  messageId:        { type: String, default: null },
  payoutDone:       { type: Boolean, default: false },
  player1FinishedAt:{ type: Number, default: null },
  player2FinishedAt:{ type: Number, default: null },
  player1ReadyAt:   { type: Number, default: null },
  player2ReadyAt:   { type: Number, default: null },
  createdAt:        { type: Number, default: Date.now },
});
module.exports = model('ParkourGame', ParkourGameSchema);
