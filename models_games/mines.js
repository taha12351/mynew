const { Schema, model } = require("mongoose");

module.exports = model("Mines", Schema({
bombs: { type: String, default: 0 },
buttons: { type: Array, default: [] },
buttons_count: { type: String, default: 0 },
msgID: { type: String, default: null },
idstusr: { type: String, default: null},
role: { type: String, default: null},
notrole: { type: String, default: null},
attempt: { type: String, default: 0 }
}))