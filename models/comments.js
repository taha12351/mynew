const { Schema, model } = require("mongoose");
module.exports = model("ProfileComment", new Schema({
  profileId: { type: String, required: true },
  authorId:  { type: String, required: true },
  text:      { type: String, required: true, maxlength: 300 },
  createdAt: { type: Date, default: Date.now },
}));
