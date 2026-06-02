const { Schema, model } = require("mongoose");

module.exports = model("Inventory", Schema({
  id: { type: String, required: true },
  items: { type: Array, default: [] },
}));
