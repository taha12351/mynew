const { Schema, model } = require("mongoose");

const missionProgressSchema = new Schema({
  id:       { type: String, required: true },
  progress: { type: Number, default: 0 },
  claimed:  { type: Boolean, default: false },
}, { _id: false });

module.exports = model("DailyMission", new Schema({
  userId: { type: String, required: true },
  date:   { type: String, required: true },
  missions: { type: [missionProgressSchema], default: [] },
}));
