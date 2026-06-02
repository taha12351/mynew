const { Schema, model } = require("mongoose");
module.exports = model("UserCache", new Schema({
  id:        { type: String, required: true, unique: true },
  username:  { type: String, default: "" },
  avatar:    { type: String, default: "" },
  updatedAt: { type: Date, default: Date.now },
}));
