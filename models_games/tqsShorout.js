var _0x62b9=["\x6D\x6F\x6E\x67\x6F\x6F\x73\x65"];const {Schema,model}=require(_0x62b9[0])

module.exports = model("TqsShorout Game Database", Schema({
  msgID:        { type: String, default: null },
  player1:      { type: String, default: null },
  player2:      { type: String, default: null },
  channelID:    { type: String, default: null },
  maxNum:       { type: Number, default: 0 },
  rangeA1:      { type: Number, default: 0 },
  rangeA2:      { type: Number, default: 0 },
  rangeB1:      { type: Number, default: 0 },
  rangeB2:      { type: Number, default: 0 },
  p1Total:      { type: Number, default: 0 },
  p2Total:      { type: Number, default: 0 },
  p1Numbers:    { type: Array,  default: [] },
  p2Numbers:    { type: Array,  default: [] },
  p1Done:       { type: Boolean, default: false },
  p2Done:       { type: Boolean, default: false },
  p1Exceeded:   { type: Boolean, default: false },
  controlPhase: { type: Boolean, default: false },
  phase:        { type: String,  default: "p1" },
}));
