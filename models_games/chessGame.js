const {Schema,model}=require('mongoose');
const ChessGameSchema=new Schema({
  gameId:    {type:String,required:true,unique:true},
  player1:   {type:String,required:true},   // Discord user ID → white
  player2:   {type:String,required:true},   // Discord user ID → black
  player1Username:{type:String,default:''},
  player2Username:{type:String,default:''},
  timeControl:    {type:String,default:'10+0'},
  timeWhiteMs:    {type:Number,default:600000},
  timeBlackMs:    {type:Number,default:600000},
  incrementMs:    {type:Number,default:0},
  lastMoveAt:     {type:Number,default:null},
  status:    {type:String,default:'waiting'},   // waiting|active|finished|abandoned
  result:    {type:String,default:null},         // white|black|draw
  resultReason:{type:String,default:null},       // checkmate|resignation|timeout|stalemate|agreement|insufficient|fifty_move
  gameState: {type:Schema.Types.Mixed,default:null},
  moves:     [{type:String}],
  notations: [{type:String}],
  createdAt: {type:Number,default:Date.now},
  channelId: {type:String,default:null},
  messageId: {type:String,default:null},
  drawOffer: {type:String,default:null},        // 'white'|'black'
  drawOfferMoveCount:{type:Number,default:0},
  betAmount: {type:Number,default:0},
  payoutDone:{type:Boolean,default:false},
  gracePeriodEnds:{type:Number,default:null},
  chat:[{userId:String,username:String,text:String,ts:Number}],
  activityLog:[{msg:String,ts:Number}],
});
module.exports=model('ChessGame',ChessGameSchema);
