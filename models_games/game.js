var _0x1bd6=["\x6D\x6F\x6E\x67\x6F\x6F\x73\x65"];const {Schema,model}=require(_0x1bd6[0])

module.exports = model("Game Database", Schema({
id: { type: String, required: true },
msgID: { type: String, default: null },
coins: { type: String, default: null },
with: { type: String, default: null },
game: { type: String, default: null },
channelID: { type: String, default: null },
time: { type: String, default: null },
}));