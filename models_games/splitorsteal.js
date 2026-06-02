const { Schema, model } = require("mongoose");

module.exports = model("Split Or Steal Game", Schema({
  msgID: { type: String, required: true },
  player1: { type: String, default: null },
  player2: { type: String, default: null },
  coins: { type: String, default: null },
  channelID: { type: String, default: null },
  choice1: { type: String, default: null },
  choice2: { type: String, default: null },
  time: { type: String, default: null },
}));
