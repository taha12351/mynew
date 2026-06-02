var _0x62b9=["\x6D\x6F\x6E\x67\x6F\x6F\x73\x65"];const {Schema,model}=require(_0x62b9[0])

module.exports = model("Takribi Game Database", Schema({
msgID: { type: String, default: null },
idstusr: { type: String, default: null },
role: { type: String, default: null },
notrole: { type: String, default: null },
number_smaller1 : { type: String, default: 0 },
number_smaller2: { type: String, default: 0 },
number_greater1: { type: String, default: 0} ,
number_greater2: { type: String, default: 0 },
max_number: { type: String, default: 0 },
number_players_done: { type: String, default: 0}
}));