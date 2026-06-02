var _0x62b9=["\x6D\x6F\x6E\x67\x6F\x6F\x73\x65"];const {Schema,model}=require(_0x62b9[0])

module.exports = model("Nrd Game Database", Schema({
msgID: { type: String, default: null },
players: { type: Array, default: []},
idstusr: { type: String, defualt: null},
role: { type: String, default: null},
notrole: { type: String, default: null}
}));