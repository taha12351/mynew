var _0x62b9=["\x6D\x6F\x6E\x67\x6F\x6F\x73\x65"];const {Schema,model}=require(_0x62b9[0])

module.exports = model("Takribi Users Game Database", Schema({
id: { type: String, default: null },
with: { type: String, default: null },
msgID: { type: String, default: null},
numbers: { type: Array, default: [] },
result: { type: String, default: 0}
}));