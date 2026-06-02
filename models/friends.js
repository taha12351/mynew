const { Schema, model } = require("mongoose");
module.exports = model("FriendsList", new Schema({
  id:       { type: String, required: true, unique: true },
  friends:  { type: [String], default: [] },
  pending:  { type: [String], default: [] },
  sent:     { type: [String], default: [] },
}));
