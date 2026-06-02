const { Schema, model } = require("mongoose");

module.exports = model("Poker Game", Schema({
  msgID: { type: String, required: true },
  player1: { type: String, default: null },
  player2: { type: String, default: null },
  coins: { type: String, default: null },
  channelID: { type: String, default: null },
  hand1: { type: Array, default: [] },
  hand2: { type: Array, default: [] },
  community: { type: Array, default: [] },
  deck: { type: Array, default: [] },
  pot: { type: Number, default: 0 },
  stage: { type: String, default: "preflop" },
  turn: { type: String, default: null },
  time: { type: String, default: null },
}));
