var _0xe8b3=["\x6D\x6F\x6E\x67\x6F\x6F\x73\x65"];const {Schema,model}=require(_0xe8b3[0])

module.exports = model("Database Users", Schema({
id: { type: String, required: true },
coins: { type: String, default: 0},
status_playing: { type: String, default: "no"},
hasJoinedServer: { type: Boolean, default: false},
customBackground: { type: String, default: "" },
customBackgroundStatus: { type: String, default: "inactive" },
customTitle: { type: String, default: "" },
profileColor: { type: String, default: "#032943" },
backNumberCount: { type: Number, default: 0 },
luckyReduceCount: { type: Number, default: 0 },
replayCount: { type: Number, default: 0 },
changeMaxCount: { type: Number, default: 0 },
spyCount: { type: Number, default: 0 },
freezeCount: { type: Number, default: 0 },
blockCount: { type: Number, default: 0 },
customTitleCount: { type: Number, default: 0 },
profileColorCount: { type: Number, default: 0 }
}));