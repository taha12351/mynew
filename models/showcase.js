const { Schema, model } = require("mongoose");

module.exports = model("ProfileShowcase", new Schema({
  userId:  { type: String, required: true, unique: true },
  pins:    { type: [Object], default: [] },
}));
