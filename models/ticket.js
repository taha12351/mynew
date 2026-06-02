const { Schema, model } = require("mongoose");

module.exports = model("SupportTicket", new Schema({
  ticketId:  { type: String, required: true, unique: true },
  userId:    { type: String, required: true },
  username:  { type: String, default: "" },
  subject:   { type: String, required: true },
  message:   { type: String, required: true },
  category:  { type: String, default: "general" },
  status:    { type: String, default: "open" },
  reply:     { type: String, default: "" },
  repliedBy: { type: String, default: "" },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
}));
