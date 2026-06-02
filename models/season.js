const { Schema, model } = require("mongoose");

module.exports = model("BattlePassProgress", new Schema({
  userId:   { type: String, required: true, unique: true },
  xp:       { type: Number, default: 0 },
  tier:     { type: Number, default: 0 },
  claimed:  { type: [Number], default: [] },
  season:   { type: String, default: "rezero" },
}));
