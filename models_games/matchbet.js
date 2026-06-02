const { Schema, model } = require("mongoose");

const betEntrySchema = new Schema({
  userId:    { type: String, required: true },
  amount:    { type: Number, required: true },
  side:      { type: Number, required: true }, // 1 = team1, 2 = team2
  placedAt:  { type: Date, default: Date.now },
});

module.exports = model("Match Bet", new Schema({
  matchId:     { type: String, required: true, unique: true },
  team1:       { type: String, required: true },
  team2:       { type: String, required: true },
  description: { type: String, default: "" },
  channelId:   { type: String, required: true },
  msgId:       { type: String, default: null },
  status:      { type: String, default: "open" }, // open | closed | finished | cancelled
  deadline:    { type: Number, default: 0 },       // unix ms, 0 = no deadline
  bets:        { type: [betEntrySchema], default: [] },
  result:      { type: Number, default: null },    // 1 | 2 | 0 (draw) | null
  createdAt:   { type: Date, default: Date.now },
  createdBy:   { type: String, default: null },
}));
