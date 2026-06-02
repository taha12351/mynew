const { Schema, model } = require("mongoose");

module.exports = model("MafiaFamiglia", new Schema({
  name:        { type: String, required: true, unique: true },
  donId:       { type: String, required: true },
  members:     { type: [String], default: [] },
  vault:       { type: Number, default: 0 },
  description: { type: String, default: "لا يوجد وصف" },
  createdAt:   { type: Date, default: Date.now },
}));
