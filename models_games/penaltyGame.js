'use strict';
const {Schema,model}=require('mongoose');
const PenaltyGameSchema=new Schema({
  gameId:       {type:String,required:true,unique:true},
  player1:      {type:String,required:true},
  player2:      {type:String,required:true},
  player1Username:{type:String,default:''},
  player2Username:{type:String,default:''},
  betAmount:    {type:Number,default:0},
  status:       {type:String,default:'waiting'},  // waiting|active|finished|abandoned
  currentRound: {type:Number,default:0},          // 0,1,2
  phase:        {type:String,default:'awaiting_shooter'}, // awaiting_shooter|awaiting_keeper|done
  currentShooter:{type:String,default:'player1'}, // player1|player2 (who shoots this round)
  pendingShootDir:{type:String,default:null},      // L|C|R chosen by shooter, hidden
  rounds:       [{
    round:    Number,
    shooterId:String,
    keeperId: String,
    shootDir: String,
    keepDir:  String,
    isGoal:   Boolean,
  }],
  player1Goals: {type:Number,default:0},
  player2Goals: {type:Number,default:0},
  result:       {type:String,default:null},       // player1|player2|draw
  resultReason: {type:String,default:null},
  payoutDone:   {type:Boolean,default:false},
  channelId:    {type:String,default:null},
  messageId:    {type:String,default:null},
  createdAt:    {type:Number,default:Date.now},
});
module.exports=model('PenaltyGame',PenaltyGameSchema);
