const { Schema, model } = require("mongoose");

module.exports = model("MafiaPlayer", new Schema({
  id:           { type: String, required: true, unique: true },
  famiglia_id:  { type: String, default: null },
  totalEarned:  { type: Number, default: 0 },
  wins:         { type: Number, default: 0 },
  losses:       { type: Number, default: 0 },
  draws:        { type: Number, default: 0 },
  challenges:   { type: Number, default: 0 },
  totalDeposit: { type: Number, default: 0 },
  totalWithdraw:{ type: Number, default: 0 },
  sabotaged:    { type: Boolean, default: false },
  sabotagedBy:  { type: String, default: null },
  exiledUntil:  { type: Number, default: 0 },
}));
