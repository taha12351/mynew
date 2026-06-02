const { Schema, model } = require("mongoose");
module.exports = model("PlayerCustomization", new Schema({
  id:            { type: String, required: true, unique: true },
  theme:         { type: String, default: "diamond" },
  borderStyle:   { type: String, default: "default" },
  bio:           { type: String, default: "", maxlength: 200 },
  showcaseBadges:{ type: [String], default: [] },
  bannerColor:   { type: String, default: "#0ea5e9" },
  profileBg:     { type: String, default: "default" },
  bgPrimaryColor:{ type: String, default: "#0ea5e9" },
  bgTextColor:   { type: String, default: "#ffffff" },
  bgAccentColor: { type: String, default: "#8b5cf6" },
  customBackgroundFormat: { type: String, enum: ['png', 'gif'], default: 'png' },
  backgroundUploadDate: { type: Date, default: Date.now },
  backgroundSizeKB: { type: Number, default: 0 },
}));
