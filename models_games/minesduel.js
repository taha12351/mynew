const { Schema, model } = require("mongoose");

module.exports = model("Mines Duel Game", Schema({
  msgID: { type: String, required: true },
  player1: { type: String, default: null },
  player2: { type: String, default: null },
  coins: { type: String, default: null },
  channelID: { type: String, default: null },
  board: { type: Array, default: [] },
  mines: { type: Array, default: [] },
  revealed1: { type: Array, default: [] },
  revealed2: { type: Array, default: [] },
  turn: { type: String, default: null },
  time: { type: String, default: null },
}));
