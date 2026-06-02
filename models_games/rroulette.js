const { Schema, model } = require("mongoose");

module.exports = model("Russian Roulette Game", Schema({
  msgID: { type: String, required: true },
  player1: { type: String, default: null },
  player2: { type: String, default: null },
  coins: { type: String, default: null },
  channelID: { type: String, default: null },
  chamber: { type: Number, default: 0 },
  currentShot: { type: Number, default: 0 },
  turn: { type: String, default: null },
  time: { type: String, default: null },
}));
