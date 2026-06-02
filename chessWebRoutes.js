'use strict';
// ╔══════════════════════════════════════════════════════════════╗
// ║  Diamond Casino — Chess Web Routes                          ║
// ╚══════════════════════════════════════════════════════════════╝

const { initGameState, makeMove, getValidMovesForSquare } = require('./chessLogic');
const ChessGame = require('./models_games/chessGame');
const { v4: uuidv4 } = require('uuid');

function parseTimeControl(tcStr){
  const parts=(tcStr||'10+0').split('+');
  const mins=parseInt(parts[0])||10;
  const inc=parseInt(parts[1])||0;
  return {
    label: `${mins}+${inc}`,
    timeMs: mins*60*1000,
    incrementMs: inc*1000,
  };
}

function colorOf(game, userId){
  if(game.player1===userId) return 'white';
  if(game.player2===userId) return 'black';
  return null;
}

function fmtMs(ms){
  if(ms==null||ms<0) ms=0;
  const s=Math.floor(ms/1000);
  const m=Math.floor(s/60);
  const ss=s%60;
  return `${m}:${ss<10?'0':''}${ss}`;
}

// ─── Rate limiter (in-memory per IP, per path family) ─────────────────────
const _rl = new Map();
function rateLimit(maxPerMin){
  return function(req,res,next){
    const key=`${req.ip}_${req.path}`;
    const now=Date.now();
    const entry=_rl.get(key)||{count:0,reset:now+60000};
    if(now>entry.reset){ entry.count=0; entry.reset=now+60000; }
    entry.count++;
    _rl.set(key,entry);
    if(entry.count>maxPerMin) return res.status(429).json({error:'Too many requests — slow down.'});
    next();
  };
}

module.exports = function setupChessRoutes(app, { db, discordClient, SERVER_SETTINGS, siteLog, payoutFn, layout }){

  const BASE_URL = process.env.REPLIT_DEV_DOMAIN
    ? `https://${process.env.REPLIT_DEV_DOMAIN}`
    : 'http://fi11.bot-hosting.net:20407';

  // ── helper: chess log ────────────────────────────────────────
  async function chessLog(title, desc, color='#5865F2'){
    if(siteLog) await siteLog(title, desc, color).catch(()=>{});
  }

  async function chessFinishPayout(game){
    if(!payoutFn||game.payoutDone) return;
    if(game.betAmount<=0){ game.payoutDone=true; await game.save().catch(()=>{}); return; }
    const winnerId = game.result==='white'?game.player1:game.result==='black'?game.player2:null;
    const loserId  = game.result==='white'?game.player2:game.result==='black'?game.player1:null;
    game.payoutDone=true;
    await game.save().catch(()=>{});
    await payoutFn({ winnerId, loserId, betAmount:game.betAmount, player1:game.player1, player2:game.player2 }).catch(()=>{});
    // Reset player status_playing
    if(db){
      const [p1,p2] = await Promise.all([
        db.findOne({ id: game.player1 }).catch(()=>null),
        db.findOne({ id: game.player2 }).catch(()=>null),
      ]);
      if(p1){ p1.status_playing='no'; await p1.save().catch(()=>{}); }
      if(p2){ p2.status_playing='no'; await p2.save().catch(()=>{}); }
    }
    // Update Discord embed with board image
    const imgBuffer = await generateChessBoardImage(game).catch(()=>null);
    await updateDiscordOnChessFinish(game, imgBuffer).catch(()=>{});
  }

  // ─── Generate chess board image via canvas ─────────────────────────────
  async function generateChessBoardImage(game){
    const { createCanvas } = require('canvas');
    const CELL=62, BOARD=CELL*8, MARGIN=22, BANNER_H=68, FOOTER_H=48;
    const W=BOARD+MARGIN*2, H=BOARD+MARGIN*2+BANNER_H+FOOTER_H;
    const canvas=createCanvas(W,H), ctx=canvas.getContext('2d');

    // Dark background
    ctx.fillStyle='#0d1117'; ctx.fillRect(0,0,W,H);

    // Result banner gradient
    const bannerGrad=ctx.createLinearGradient(0,0,W,0);
    if(game.result==='draw'){ bannerGrad.addColorStop(0,'#78350f'); bannerGrad.addColorStop(1,'#1c1917'); }
    else { bannerGrad.addColorStop(0,'#065f46'); bannerGrad.addColorStop(1,'#0d1117'); }
    ctx.fillStyle=bannerGrad; ctx.fillRect(0,0,W,BANNER_H);

    // Border
    ctx.strokeStyle='rgba(139,92,246,0.4)'; ctx.lineWidth=2;
    ctx.strokeRect(1,1,W-2,H-2);

    // Winner text
    ctx.fillStyle='#f1f5f9'; ctx.textAlign='center';
    let winLine='';
    if(game.result==='draw') winLine='🤝  تعادل!';
    else if(game.result==='white') winLine=`♔  ${game.player1Username} فاز!`;
    else winLine=`♚  ${game.player2Username} فاز!`;
    ctx.font='bold 24px Arial'; ctx.fillText(winLine, W/2, 30);

    const reasonMap={checkmate:'كش مات ✓',resignation:'استسلام 🏳️',timeout:'نفاد الوقت ⏰',stalemate:'وقف ملك ⚖️',agreement:'اتفاق تعادل 🤝',insufficient:'قطع غير كافية'};
    ctx.font='14px Arial'; ctx.fillStyle='rgba(255,255,255,0.65)';
    ctx.fillText(reasonMap[game.resultReason]||game.resultReason||'', W/2, 56);

    // Board
    const bx=MARGIN, by=BANNER_H+MARGIN;
    for(let r=0;r<8;r++){
      for(let c=0;c<8;c++){
        const light=(r+c)%2===0;
        ctx.fillStyle=light?'#f0d9b5':'#b58863';
        ctx.fillRect(bx+c*CELL, by+r*CELL, CELL, CELL);
      }
    }

    // Coordinate labels
    ctx.fillStyle='rgba(0,0,0,0.55)'; ctx.font='bold 11px Arial';
    for(let i=0;i<8;i++){
      ctx.textAlign='center';
      ctx.fillText(String(8-i), bx-13, by+i*CELL+CELL/2+4);
      ctx.fillText('abcdefgh'[i], bx+i*CELL+CELL/2, by+BOARD+15);
    }

    // Pieces
    const SYMS={'wK':'♔','wQ':'♕','wR':'♖','wB':'♗','wN':'♘','wP':'♙','bK':'♚','bQ':'♛','bR':'♜','bB':'♝','bN':'♞','bP':'♟'};
    if(game.gameState?.board){
      ctx.textAlign='center';
      for(let r=0;r<8;r++){
        for(let c=0;c<8;c++){
          const piece=game.gameState.board[r]?.[c]; if(!piece) continue;
          const sym=SYMS[piece]||''; if(!sym) continue;
          const px=bx+c*CELL+CELL/2, py=by+r*CELL+CELL-6;
          ctx.font=`${CELL-10}px Arial`;
          if(piece.startsWith('w')){
            ctx.fillStyle='#333'; ctx.fillText(sym,px+1,py+1);
            ctx.fillStyle='#fff'; ctx.fillText(sym,px,py);
          } else {
            ctx.fillStyle='#111'; ctx.fillText(sym,px,py);
          }
        }
      }
    }

    // Footer
    const fy=BANNER_H+MARGIN*2+BOARD;
    ctx.fillStyle='rgba(255,255,255,0.45)'; ctx.font='12px Arial'; ctx.textAlign='center';
    ctx.fillText(`♔ ${game.player1Username} (أبيض)  ·  ${(game.betAmount||0).toLocaleString('en-US')} كوين  ·  ♚ ${game.player2Username} (أسود)`, W/2, fy+18);
    ctx.fillStyle='rgba(255,255,255,0.25)'; ctx.font='11px Arial';
    ctx.fillText(`Diamond Casino Chess · ${game.gameId} · ${game.timeControl}`, W/2, fy+36);

    return canvas.toBuffer('image/png');
  }

  // ─── Update Discord embed after chess game finishes ─────────────────────
  async function updateDiscordOnChessFinish(game, imgBuffer){
    if(!discordClient||!game.channelId) return;
    try{
      const { MessageEmbed, MessageAttachment } = require('discord.js');
      const ch=await discordClient.channels.fetch(game.channelId).catch(()=>null);
      if(!ch) return;

      const reasonMap={checkmate:'كش مات ♟️',resignation:'استسلام 🏳️',timeout:'نفاد الوقت ⏰',stalemate:'وقف ملك ⚖️',agreement:'اتفاق تعادل 🤝',insufficient:'قطع غير كافية ⚖️'};
      const reasonAr=reasonMap[game.resultReason]||game.resultReason||'';
      const winnerAr=game.result==='draw'?null:game.result==='white'?game.player1Username:game.player2Username;
      const loserAr=game.result==='draw'?null:game.result==='white'?game.player2Username:game.player1Username;

      const embed=new MessageEmbed()
        .setColor(game.result==='draw'?'#FEE75C':'#57F287')
        .setTitle('♟️ انتهت لعبة الشطرنج!')
        .setDescription([
          `> ⬜ **الأبيض:** <@${game.player1}> (${game.player1Username})`,
          `> ⬛ **الأسود:** <@${game.player2}> (${game.player2Username})`,
          `> ⏱️ **الوقت:** \`${game.timeControl}\``,
          `> 💰 **المبلغ:** \`${(game.betAmount||0).toLocaleString('en-US')}\` كوين`,
          `> `,
          game.result==='draw'
            ?`> 🤝 **تعادل!** — ${reasonAr}`
            :`> 🏆 **الفائز:** <@${game.result==='white'?game.player1:game.player2}> (${winnerAr})`,
          winnerAr?`> ❌ **الخاسر:** <@${game.result==='white'?game.player2:game.player1}> (${loserAr})`:``,
          `> 📋 **السبب:** ${reasonAr}`,
        ].filter(Boolean).join('\n'))
        .setFooter({text:`Diamond Casino Chess · ${game.gameId}`})
        .setTimestamp();

      // Try to edit the existing start message; if gone, send a fresh one
      const msg = game.messageId ? await ch.messages.fetch(game.messageId).catch(()=>null) : null;
      if(imgBuffer){
        const att=new MessageAttachment(imgBuffer,'chess_result.png');
        embed.setImage('attachment://chess_result.png');
        if(msg) await msg.edit({ embeds:[embed], files:[att], components:[] }).catch(()=>{});
        else    await ch.send({ embeds:[embed], files:[att] }).catch(e=>console.error('[chess finish send]',e?.message));
      } else {
        if(msg) await msg.edit({ embeds:[embed], components:[] }).catch(()=>{});
        else    await ch.send({ embeds:[embed] }).catch(e=>console.error('[chess finish send]',e?.message));
      }
    }catch(e){ console.error('[chess finish discord]',e?.message); }
  }

  // ─── Internal bot → site API: create a chess game ────────────
  // Protected: requires either a valid CHESS_INTERNAL_SECRET env var match,
  // or an owner session (so admins can create test games from the site).
  app.post('/api/chess/create', rateLimit(20), async(req,res)=>{
    const secret=req.headers['x-chess-secret']||req.body?.secret;
    const envSecret=process.env.CHESS_INTERNAL_SECRET;
    const isAdmin=req.session?.user&&(SERVER_SETTINGS?.users?.owners||[]).includes(req.session.user.id);
    const validSecret=envSecret&&secret===envSecret;
    if(!validSecret&&!isAdmin)
      return res.status(403).json({error:'Forbidden: valid secret or owner session required'});

    const {player1,player2,timeControl,player1Username,player2Username,channelId}=req.body;
    if(!player1||!player2) return res.json({error:'Missing players'});
    if(player1===player2) return res.json({error:'Cannot play against yourself'});

    const tc=parseTimeControl(timeControl||'10+0');
    const gameId=uuidv4().replace(/-/g,'').slice(0,16);
    const gs=initGameState();

    const game=await ChessGame.create({
      gameId, player1, player2,
      player1Username:player1Username||player1,
      player2Username:player2Username||player2,
      timeControl:tc.label,
      timeWhiteMs:tc.timeMs,
      timeBlackMs:tc.timeMs,
      incrementMs:tc.incrementMs,
      gameState:gs,
      status:'waiting',
    });

    await chessLog('♟️ Chess Game Created',
      `**${player1Username||player1}** (White) vs **${player2Username||player2}** (Black)\nTime: ${tc.label}\nID: \`${gameId}\``,
      '#5865F2');

    res.json({success:true, gameId, url:`${BASE_URL}/chess/${gameId}`});
  });

  // ─── Accept / start a game (player2 clicks Accept) ───────────
  app.post('/api/chess/accept', rateLimit(20), async(req,res)=>{
    if(!req.session?.user) return res.status(401).json({error:'Login required'});
    const {gameId}=req.body;
    if(!gameId) return res.json({error:'Missing gameId'});
    const game=await ChessGame.findOne({gameId}).catch(()=>null);
    if(!game) return res.json({error:'Game not found'});
    if(game.player2!==req.session.user.id) return res.json({error:'Not your game'});
    if(game.status!=='waiting') return res.json({error:'Game already started'});
    game.status='active';
    game.lastMoveAt=Date.now();
    game.gracePeriodEnds=Date.now()+30000;
    await game.save();
    await chessLog('♟️ Chess Game Started',`Game \`${gameId}\` started!`,'#57F287');
    res.json({success:true});
  });

  // ─── Get game state (polling — no rate limit, called every 1.5 s) ──────────
  app.get('/api/chess/game/:gameId', async(req,res)=>{
    const game=await ChessGame.findOne({gameId:req.params.gameId}).lean().catch(()=>null);
    if(!game) return res.json({error:'Game not found'});

    // Calculate current clock (respects 30 s grace period)
    let tW=game.timeWhiteMs, tB=game.timeBlackMs;
    const nowPoll=Date.now();
    if(game.status==='active'&&game.lastMoveAt){
      const clockStart=Math.max(game.lastMoveAt, game.gracePeriodEnds||0);
      const elapsed=Math.max(0, nowPoll-clockStart);
      if(game.gameState?.turn==='w') tW=Math.max(0,tW-elapsed);
      else tB=Math.max(0,tB-elapsed);
      // Auto-abandon: no moves after grace period + 15 s → no-show
      if((game.moves||[]).length===0 && game.gracePeriodEnds && nowPoll>game.gracePeriodEnds+15000){
        await ChessGame.findOneAndUpdate(
          {gameId:game.gameId,status:'active'},
          {$set:{status:'abandoned',resultReason:'no_show'}}
        ).catch(()=>{});
        game.status='abandoned'; game.resultReason='no_show';
      }
    }

    const userId=req.session?.user?.id||null;
    res.json({
      gameId:game.gameId,
      status:game.status,
      result:game.result,
      resultReason:game.resultReason,
      player1:game.player1, player1Username:game.player1Username,
      player2:game.player2, player2Username:game.player2Username,
      timeControl:game.timeControl,
      timeWhiteMs:tW,
      timeBlackMs:tB,
      lastMoveAt:game.lastMoveAt||null,
      board:game.gameState?.board||null,
      turn:game.gameState?.turn||'w',
      moves:game.moves||[],
      notations:game.notations||[],
      myColor:userId?colorOf(game,userId):null,
      drawOffer:game.drawOffer||null,
      enPassant:game.gameState?.enPassant||null,
      castling:game.gameState?.castling||null,
      gracePeriodEnds:game.gracePeriodEnds||null,
      chat:(game.chat||[]).slice(-80),
    });
  });

  // ─── Make a move ─────────────────────────────────────────────
  app.post('/api/chess/move', rateLimit(60), async(req,res)=>{
    if(!req.session?.user) return res.status(401).json({error:'Login required'});
    const {gameId, from, to, promotion}=req.body;
    if(!gameId||!from||!to) return res.json({error:'Missing fields'});

    const game=await ChessGame.findOne({gameId}).catch(()=>null);
    if(!game) return res.json({error:'Game not found'});
    if(game.status!=='active') return res.json({error:'Game not active'});

    const uid=req.session.user.id;
    const myColor=colorOf(game,uid);
    if(!myColor) return res.json({error:'You are not a player'});

    const gs=game.gameState;
    const expectedColor=gs.turn==='w'?'white':'black';
    if(myColor!==expectedColor) return res.json({error:'Not your turn'});

    // Tick the clock (grace period: only count time after grace ends)
    const now=Date.now();
    if(game.lastMoveAt){
      const clockStart=game.gracePeriodEnds&&game.gracePeriodEnds>game.lastMoveAt?game.gracePeriodEnds:game.lastMoveAt;
      const elapsed=Math.max(0,now-clockStart);
      if(gs.turn==='w'){
        game.timeWhiteMs=Math.max(0,(game.timeWhiteMs||0)-elapsed)+game.incrementMs;
        if(game.timeWhiteMs<=0){
          game.status='finished'; game.result='black'; game.resultReason='timeout';
          await game.save();
          await chessFinishPayout(game);
          await chessLog('♟️ Chess — Timeout',`Game \`${gameId}\`: Black wins by timeout`,'#ED4245');
          return res.json({success:true,status:'finished',result:'black',resultReason:'timeout'});
        }
      } else {
        game.timeBlackMs=Math.max(0,(game.timeBlackMs||0)-elapsed)+game.incrementMs;
        if(game.timeBlackMs<=0){
          game.status='finished'; game.result='white'; game.resultReason='timeout';
          await game.save();
          await chessFinishPayout(game);
          await chessLog('♟️ Chess — Timeout',`Game \`${gameId}\`: White wins by timeout`,'#ED4245');
          return res.json({success:true,status:'finished',result:'white',resultReason:'timeout'});
        }
      }
    }

    // Validate and apply move
    const result=makeMove(gs, from, to, promotion||'Q');
    if(result.error) return res.json({error:result.error});

    // Update game state
    const newGs={
      board:result.board,
      turn:result.turn,
      enPassant:result.enPassant,
      castling:result.castling,
      status:result.status,
      halfmoveClock:result.halfmoveClock,
      fullmoveNumber:result.fullmoveNumber,
    };
    game.gameState=newGs;
    game.moves=[...(game.moves||[]),result.move];
    game.notations=[...(game.notations||[]),result.notation];
    game.lastMoveAt=now;
    game.drawOffer=null; // reset draw offer on move

    const gameStatus=result.status;
    if(gameStatus==='checkmate'){
      game.status='finished';
      game.result=myColor==='white'?'white':'black';
      game.resultReason='checkmate';
      await chessLog('♟️ Chess — Checkmate',`Game \`${gameId}\`: ${myColor} wins by checkmate!`,'#57F287');
    } else if(gameStatus==='stalemate'||gameStatus==='insufficient'||gameStatus==='fifty_move'){
      game.status='finished';
      game.result='draw';
      game.resultReason=gameStatus==='stalemate'?'stalemate':gameStatus==='insufficient'?'insufficient':'fifty_move';
      await chessLog('♟️ Chess — Draw',`Game \`${gameId}\`: Draw by ${game.resultReason}`,'#FEE75C');
    }

    game.markModified('gameState');
    game.markModified('moves');
    game.markModified('notations');
    await game.save();
    if(game.status==='finished') await chessFinishPayout(game);

    res.json({success:true, move:result.move, notation:result.notation, status:game.status, result:game.result, resultReason:game.resultReason});
  });

  // ─── Resign ──────────────────────────────────────────────────
  app.post('/api/chess/resign', rateLimit(10), async(req,res)=>{
    if(!req.session?.user) return res.status(401).json({error:'Login required'});
    const {gameId}=req.body;
    const game=await ChessGame.findOne({gameId}).catch(()=>null);
    if(!game) return res.json({error:'Game not found'});
    if(game.status!=='active'&&game.status!=='waiting') return res.json({error:'Game not active'});
    const uid=req.session.user.id;
    const myColor=colorOf(game,uid);
    if(!myColor) return res.json({error:'Not a player'});
    game.status='finished';
    game.result=myColor==='white'?'black':'white';
    game.resultReason='resignation';
    await game.save();
    await chessFinishPayout(game);
    await chessLog('♟️ Chess — Resignation',`Game \`${gameId}\`: ${myColor} resigned`,'#ED4245');
    res.json({success:true, result:game.result, resultReason:'resignation'});
  });

  // ─── Claim timeout ───────────────────────────────────────────
  app.post('/api/chess/claim-timeout', rateLimit(10), async(req,res)=>{
    if(!req.session?.user) return res.status(401).json({error:'Login required'});
    const {gameId}=req.body;
    const game=await ChessGame.findOne({gameId}).catch(()=>null);
    if(!game) return res.json({error:'Game not found'});
    if(game.status!=='active') return res.json({error:'Game not active'});
    const uid=req.session.user.id;
    const myColor=colorOf(game,uid);
    if(!myColor) return res.json({error:'Not a player'});

    const now=Date.now();
    const elapsed=game.lastMoveAt?now-game.lastMoveAt:0;
    let tW=game.timeWhiteMs, tB=game.timeBlackMs;
    if(game.gameState?.turn==='w') tW=Math.max(0,tW-elapsed);
    else tB=Math.max(0,tB-elapsed);

    if(tW<=0){
      game.status='finished'; game.result='black'; game.resultReason='timeout';
      await game.save();
      await chessFinishPayout(game);
      await chessLog('♟️ Chess — Timeout',`Game \`${gameId}\`: Black wins by timeout`,'#ED4245');
      return res.json({success:true,result:'black',resultReason:'timeout'});
    }
    if(tB<=0){
      game.status='finished'; game.result='white'; game.resultReason='timeout';
      await game.save();
      await chessFinishPayout(game);
      await chessLog('♟️ Chess — Timeout',`Game \`${gameId}\`: White wins by timeout`,'#ED4245');
      return res.json({success:true,result:'white',resultReason:'timeout'});
    }
    res.json({error:'No timeout yet'});
  });

  // ─── Draw offer/accept ───────────────────────────────────────
  app.post('/api/chess/draw', rateLimit(10), async(req,res)=>{
    if(!req.session?.user) return res.status(401).json({error:'Login required'});
    const {gameId, action}=req.body; // action: 'offer'|'accept'|'decline'
    const game=await ChessGame.findOne({gameId}).catch(()=>null);
    if(!game) return res.json({error:'Game not found'});
    if(game.status!=='active') return res.json({error:'Game not active'});
    const uid=req.session.user.id;
    const myColor=colorOf(game,uid);
    if(!myColor) return res.json({error:'Not a player'});

    if(action==='offer'){
      if(game.drawOffer===myColor) return res.json({error:'Already offered'});
      game.drawOffer=myColor;
      game.drawOfferMoveCount=(game.moves||[]).length;
      await game.save();
      return res.json({success:true, msg:'Draw offered'});
    }
    if(action==='accept'){
      if(!game.drawOffer||game.drawOffer===myColor) return res.json({error:'No draw offer to accept'});
      game.status='finished'; game.result='draw'; game.resultReason='agreement';
      game.drawOffer=null;
      await game.save();
      await chessFinishPayout(game);
      await chessLog('♟️ Chess — Draw',`Game \`${gameId}\`: Draw by mutual agreement`,'#FEE75C');
      return res.json({success:true,result:'draw',resultReason:'agreement'});
    }
    if(action==='decline'){
      game.drawOffer=null;
      await game.save();
      return res.json({success:true, msg:'Draw declined'});
    }
    res.json({error:'Unknown action'});
  });

  // ─── Chat endpoint ───────────────────────────────────────────
  app.post('/api/chess/chat', rateLimit(20), async(req,res)=>{
    if(!req.session?.user) return res.status(401).json({error:'Login required'});
    const {gameId,text}=req.body;
    if(!gameId||!text||!text.trim()) return res.json({error:'Missing fields'});
    const safeText=String(text).slice(0,200);
    const game=await ChessGame.findOne({gameId}).catch(()=>null);
    if(!game) return res.json({error:'Game not found'});
    const uid=req.session.user.id;
    if(colorOf(game,uid)===null) return res.status(403).json({error:'Only players can chat'});
    if(!['active','waiting','finished'].includes(game.status)) return res.json({error:'Game not available'});
    game.chat=[...(game.chat||[]),{userId:uid,username:req.session.user.username,text:safeText,ts:Date.now()}];
    game.markModified('chat');
    await game.save().catch(()=>{});
    res.json({success:true});
  });

  // ─── Get valid moves for a square (UI helper) ────────────────
  app.get('/api/chess/valid-moves/:gameId/:square', async(req,res)=>{
    if(!req.session?.user) return res.status(401).json({error:'Login required'});
    const game=await ChessGame.findOne({gameId:req.params.gameId}).lean().catch(()=>null);
    if(!game) return res.json({error:'Game not found'});
    if(game.status!=='active') return res.json({squares:[]});
    const uid=req.session.user.id;
    const myColor=colorOf(game,uid);
    if(!myColor) return res.json({squares:[]});
    const gs=game.gameState;
    if((gs.turn==='w'&&myColor!=='white')||(gs.turn==='b'&&myColor!=='black')) return res.json({squares:[]});
    const squares=getValidMovesForSquare(gs, req.params.square);
    res.json({squares});
  });

  // ─── Chess lobby page ────────────────────────────────────────
  app.get('/chess', async(req,res)=>{
    const user=req.session?.user||null;
    const recentGames = user
      ? await ChessGame.find({$or:[{player1:user.id},{player2:user.id}]}).sort({createdAt:-1}).limit(10).lean().catch(()=>[])
      : [];

    const layout=require('./website.js').__layout||null; // will use inline layout
    const {layout:lay}=req._layout||{};

    res.send(buildChessLobbyPage(user, recentGames, BASE_URL));
  });

  // ─── Chess game page ─────────────────────────────────────────
  app.get('/chess/:gameId', async(req,res)=>{
    const user=req.session?.user||null;
    const game=await ChessGame.findOne({gameId:req.params.gameId}).lean().catch(()=>null);
    if(!game){
      return res.status(404).send(buildChessNotFoundPage(user));
    }
    res.send(buildChessGamePage(user, game, BASE_URL));
  });

  // ─────────────────────────────────────────────────────────────
  // HTML builders
  // ─────────────────────────────────────────────────────────────

  function buildChessLobbyPage(user, recentGames, baseUrl){
    const recentHtml=recentGames.length
      ? recentGames.map(g=>{
          const isW=user&&g.player1===user.id;
          const statusLabel=g.status==='finished'
            ?(g.result==='draw'?'🤝 تعادل':g.result==='white'?(isW?'✅ فوز':'❌ خسارة'):(isW?'❌ خسارة':'✅ فوز'))
            :(g.status==='active'?'🟢 نشطة':'⏳ انتظار');
          return `<a href="/chess/${g.gameId}" class="chess-recent-row">
            <span class="chess-color-dot" style="background:${isW?'#f0d9b5':'#2a2a2a'};border:2px solid var(--border)"></span>
            <span style="flex:1;font-size:13px">ضد <strong>${escH(isW?g.player2Username:g.player1Username)}</strong> <span style="color:var(--text3);font-size:11px">(${g.timeControl})</span></span>
            <span class="badge ${g.status==='finished'?'badge-blue':g.status==='active'?'badge-green':'badge-purple'}">${statusLabel}</span>
          </a>`;
        }).join('')
      : '<div style="color:var(--text3);font-size:13px;padding:10px 0">لا توجد ألعاب حديثة.</div>';

    return fullPage('Chess — Diamond Casino', user, '/chess', `
<style>
.chess-recent-row{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:var(--radius-sm);border:1px solid var(--border);margin-bottom:8px;text-decoration:none;color:inherit;transition:border-color 0.2s}
.chess-recent-row:hover{border-color:var(--primary)}
.chess-color-dot{width:16px;height:16px;border-radius:50%;flex-shrink:0}
</style>
<div class="page-header animate-slideUp">
  <h1>♟️ Chess</h1>
  <p>Challenge your friend to a chess match via Discord</p>
</div>
<div class="grid-2" style="gap:20px;align-items:start">
  <div class="card card-glow">
    <div class="card-header"><span class="icon">♟️</span> How to play</div>
    <div style="padding:4px 0">
      <div style="display:flex;gap:12px;padding:10px 0;border-bottom:1px solid var(--border)">
        <span style="font-size:24px">1️⃣</span>
        <div><div style="font-weight:600;font-size:13px">Challenge your friend on Discord</div><div style="font-size:12px;color:var(--text2);margin-top:2px">Use the challenge command in Discord then click ♟️ Chess</div></div>
      </div>
      <div style="display:flex;gap:12px;padding:10px 0;border-bottom:1px solid var(--border)">
        <span style="font-size:24px">2️⃣</span>
        <div><div style="font-weight:600;font-size:13px">Choose time control</div><div style="font-size:12px;color:var(--text2);margin-top:2px">⚡ 1+0 · 3+2 &nbsp;|&nbsp; 🔵 5+0 · 5+3 &nbsp;|&nbsp; 🟢 10+0 · 10+5 &nbsp;|&nbsp; 🟡 15+10 · 30+0</div></div>
      </div>
      <div style="display:flex;gap:12px;padding:10px 0;border-bottom:1px solid var(--border)">
        <span style="font-size:24px">3️⃣</span>
        <div><div style="font-weight:600;font-size:13px">Click the game link</div><div style="font-size:12px;color:var(--text2);margin-top:2px">Both players open the link and log in with Discord</div></div>
      </div>
      <div style="display:flex;gap:12px;padding:10px 0">
        <span style="font-size:24px">4️⃣</span>
        <div><div style="font-weight:600;font-size:13px">Play!</div><div style="font-size:12px;color:var(--text2);margin-top:2px">Full chess rules: castling, en passant, promotion, checkmate</div></div>
      </div>
    </div>
    <div class="alert alert-info" style="margin-top:12px;font-size:12px">♟️ <strong>White</strong> = challenger &nbsp;·&nbsp; <strong>Black</strong> = challenged</div>
  </div>
  <div>
    <div class="card card-glow" style="margin-bottom:16px">
      <div class="card-header"><span class="icon">⏱️</span> Time Controls</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        ${[['1+0','⚡ Bullet'],['3+2','⚡ Bullet'],['5+0','🔵 Blitz'],['5+3','🔵 Blitz'],['10+0','🟢 Rapid'],['10+5','🟢 Rapid'],['15+10','🟡 Classic'],['30+0','🟡 Classic']].map(([tc,cat])=>`
        <div style="background:var(--bg2);border-radius:var(--radius-sm);padding:10px 12px;display:flex;justify-content:space-between;align-items:center">
          <code style="font-size:13px;font-weight:700;color:var(--primary)">${tc}</code>
          <span style="font-size:11px;color:var(--text3)">${cat}</span>
        </div>`).join('')}
      </div>
    </div>
    ${user?`<div class="card card-glow">
      <div class="card-header"><span class="icon">🕐</span> Recent Games</div>
      ${recentHtml}
    </div>`:`<div class="card card-glow"><div class="card-header"><span class="icon">🔐</span> Log in to see your games</div><a href="/auth/discord" class="btn btn-discord" style="width:100%;justify-content:center;margin-top:12px">Login with Discord</a></div>`}
  </div>
</div>`);
  }

  function buildChessNotFoundPage(user){
    return fullPage('Game Not Found — Chess',user,'/chess',`
<div class="empty-state" style="padding:80px 20px">
  <div class="ei" style="font-size:80px">♟️</div>
  <h2 style="font-family:Rajdhani,Cairo,sans-serif;font-size:32px;color:var(--primary);margin-bottom:8px">Game Not Found</h2>
  <p style="margin-bottom:24px">This game doesn't exist or has expired.</p>
  <a href="/chess" class="btn btn-primary btn-lg">♟️ Chess Lobby</a>
</div>`);
  }

  function buildChessGamePage(user, game, baseUrl){
    const uid=user?.id||null;
    const myColor=uid?colorOf(game,uid):null;
    const isPlayer=!!myColor;
    const isWaiting=game.status==='waiting';
    const isFinished=game.status==='finished';

    // Initial clocks (server-adjusted for active games)
    let tW=game.timeWhiteMs, tB=game.timeBlackMs;
    if(game.status==='active'&&game.lastMoveAt){
      const clockStart=Math.max(game.lastMoveAt,game.gracePeriodEnds||0);
      const el=Math.max(0,Date.now()-clockStart);
      if(game.gameState?.turn==='w') tW=Math.max(0,tW-el);
      else tB=Math.max(0,tB-el);
    }

    // Promo piece images for modal
    const promoUrls={Q:'wQ',R:'wR',B:'wB',N:'wN'};
    const promoBase='https://lichess1.org/assets/piece/cburnett/';
    const promoItems=[['Q','وزير'],['R','رخ'],['B','فيل'],['N','حصان']];

    const cgJson=JSON.stringify({
      gameId:game.gameId,
      userId: user?.id || null,
      myColor:myColor||null,
      isPlayer,
      player1:game.player1, player1Username:game.player1Username,
      player2:game.player2, player2Username:game.player2Username,
      timeControl:game.timeControl,
      status:game.status,
      result:game.result||null,
      resultReason:game.resultReason||null,
      timeWhiteMs:tW,
      timeBlackMs:tB,
      lastMoveAt:game.lastMoveAt||null,
      gracePeriodEnds:game.gracePeriodEnds||null,
      board:game.gameState?.board||null,
      turn:game.gameState?.turn||'w',
      moves:game.moves||[],
      notations:game.notations||[],
      drawOffer:game.drawOffer||null,
      chat:(game.chat||[]).slice(-80),
    });

    return fullPage(`Chess — ${escH(game.player1Username)} vs ${escH(game.player2Username)}`, user, '/chess', `
<style>
/* ── Chess.com-style board ── */
.cg-wrap{display:flex;gap:18px;align-items:flex-start;flex-wrap:wrap}
.cg-left{flex-shrink:0}
.cg-right{flex:1;min-width:260px;display:flex;flex-direction:column;gap:12px}
.cb-player-bar{display:flex;align-items:center;justify-content:space-between;padding:8px 4px;gap:8px}
.cb-player-name{font-size:14px;font-weight:600;color:var(--text)}
.cb-player-dot{width:14px;height:14px;border-radius:50%;flex-shrink:0;border:2px solid rgba(255,255,255,.25)}
.cb-clock{font-family:'Rajdhani',monospace;font-size:26px;font-weight:700;color:var(--text3);min-width:75px;text-align:right;background:var(--bg2);border-radius:6px;padding:4px 10px}
.cb-clock-active{color:#97b9a7 !important;background:#1a2e22 !important}
.cb-clock-low{color:#e74c3c !important;background:#2e1a1a !important;animation:pulse 1s infinite}
.cb-board{display:inline-block;direction:ltr;line-height:0;box-shadow:0 4px 24px rgba(0,0,0,.5)}
.cb-row{display:flex;direction:ltr}
.cb-rl{width:20px;font-size:10px;color:#b0b0b0;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;user-select:none}
.cb-sq{width:64px;height:64px;position:relative;cursor:pointer;box-sizing:border-box}
.cb-light{background:#eeeed2}
.cb-dark{background:#769656}
.cb-piece{position:absolute;inset:2px;background-size:contain;background-repeat:no-repeat;background-position:center;pointer-events:none;z-index:2}
.cb-fl{position:absolute;bottom:1px;right:2px;font-size:9px;font-weight:700;color:inherit;opacity:.7;pointer-events:none;z-index:3}
.cb-light .cb-fl{color:#769656}
.cb-dark .cb-fl{color:#eeeed2}
.cb-last{background:#cdd16f !important}
.cb-last.cb-dark{background:#aaa23a !important}
.cb-selected::before{content:'';position:absolute;inset:0;background:rgba(20,85,30,.5);z-index:1}
.cb-valid::after{content:'';position:absolute;top:50%;left:50%;width:28px;height:28px;border-radius:50%;background:rgba(0,0,0,.16);transform:translate(-50%,-50%);z-index:1;pointer-events:none}
.cb-capture::after{content:'';position:absolute;inset:0;border:6px solid rgba(0,0,0,.16);border-radius:50%;z-index:1;pointer-events:none}
.cb-check{background:radial-gradient(ellipse at center,#ff0000,#e70000 25%,rgba(169,0,0,0) 89%,rgba(158,0,0,0)) !important}
/* Tabs */
.chess-tabs{display:flex;gap:4px;border-bottom:1px solid var(--border);padding-bottom:0}
.chess-tab-btn{background:none;border:none;border-bottom:2px solid transparent;padding:7px 14px;font-size:13px;cursor:pointer;color:var(--text3);font-family:Cairo,sans-serif;transition:.15s;margin-bottom:-1px}
.chess-tab-btn.active{color:var(--primary);border-bottom-color:var(--primary)}
.chess-tab-panel{max-height:200px;overflow-y:auto;padding:8px 2px}
/* Moves */
.chess-moves-inner{font-size:12px;font-family:monospace;direction:ltr}
.chess-move-row{display:flex;gap:4px;align-items:center;margin-bottom:2px}
.chess-move-num{color:var(--text3);min-width:26px}
.chess-move-w,.chess-move-b{padding:2px 6px;border-radius:3px;min-width:68px}
.chess-move-w:hover,.chess-move-b:hover{background:var(--border)}
/* Log */
.chess-log-entry{font-size:12px;padding:3px 0;border-bottom:1px solid var(--border);color:var(--text2)}
/* Chat */
.chess-chat-msg{font-size:12px;padding:3px 0;border-bottom:1px solid var(--border)}
.chess-chat-user{font-weight:700;color:var(--primary)}
.chess-chat-input-row{display:flex;gap:6px;margin-top:8px}
.chess-chat-input-row input{flex:1;font-size:12px;padding:5px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg2);color:var(--text)}
/* Result banner */
.chess-result-banner{background:linear-gradient(135deg,var(--primary),var(--gold));color:#fff;border-radius:var(--radius-sm);padding:14px;text-align:center;font-weight:700;font-size:15px}
/* Status bar */
.chess-status-bar{font-size:13px;font-weight:600;color:var(--text2);padding:6px 10px;background:var(--bg2);border-radius:6px;text-align:center}
@media(max-width:640px){.cb-sq{width:44px;height:44px}.cb-valid::after{width:18px;height:18px}.cb-clock{font-size:20px}.cg-wrap{flex-direction:column}.cg-right{min-width:0;width:100%}}
</style>

<div class="page-header animate-slideUp" style="margin-bottom:14px">
  <h1>♟️ ${escH(game.player1Username)} <span style="color:var(--text3);font-size:18px">vs</span> ${escH(game.player2Username)}</h1>
  <p>${escH(game.timeControl)} · <code style="font-size:11px;background:var(--bg2);padding:2px 6px;border-radius:4px">${escH(game.gameId)}</code></p>
</div>

${isWaiting&&isPlayer&&myColor==='black'?`
<div class="alert alert-info" style="margin-bottom:12px">
  ⏳ <strong>${escH(game.player1Username)}</strong> challenged you to Chess (${escH(game.timeControl)})!
  <button class="btn btn-primary btn-sm" style="margin-left:12px" onclick="window.acceptGame()">✅ Accept Challenge</button>
</div>`:''}
${isWaiting&&(!isPlayer||myColor==='white')?`<div class="alert alert-info" style="margin-bottom:12px">⏳ Waiting for <strong>${escH(game.player2Username)}</strong> to accept the challenge…</div>`:''}
${!user?`<div class="alert alert-warn" style="margin-bottom:12px">🔐 <a href="/auth/discord" style="color:var(--gold)">Log in</a> with Discord to play.</div>`:''}

<div class="cg-wrap">
  <div class="cg-left">
    <!-- Opponent bar (top): black on top for white/spectator; white on top for black player -->
    <div class="cb-player-bar">
      <div style="display:flex;align-items:center;gap:8px">
        <div class="cb-player-dot" style="background:${myColor==='black'?'#eeeed2':'#1a1a1a'};border-color:${myColor==='black'?'#aaa':'#555'}"></div>
        <span class="cb-player-name">${myColor==='black'?escH(game.player1Username):escH(game.player2Username)} <span style="font-size:11px;color:var(--text3)">(${myColor==='black'?'White':'Black'})</span></span>
      </div>
      <div class="cb-clock" id="${myColor==='black'?'clockWhite':'clockBlack'}">${fmtMs(myColor==='black'?tW:tB)}</div>
    </div>
    <!-- Board -->
    <div class="cb-board" id="chessBoard"></div>
    <!-- My bar (bottom): white at bottom for white/spectator; black at bottom for black player -->
    <div class="cb-player-bar">
      <div style="display:flex;align-items:center;gap:8px">
        <div class="cb-player-dot" style="background:${myColor==='black'?'#1a1a1a':'#eeeed2'};border-color:${myColor==='black'?'#555':'#aaa'}"></div>
        <span class="cb-player-name">${myColor==='black'?escH(game.player2Username):escH(game.player1Username)} <span style="font-size:11px;color:var(--text3)">(${myColor==='black'?'Black':'White'})</span></span>
      </div>
      <div class="cb-clock" id="${myColor==='black'?'clockBlack':'clockWhite'}">${fmtMs(myColor==='black'?tB:tW)}</div>
    </div>
    <div style="display:flex;gap:6px;margin-top:6px">
      <button class="btn btn-ghost btn-sm" onclick="window.flipChessBoard()" style="font-size:11px">🔄 Flip Board</button>
      <a href="/chess" class="btn btn-ghost btn-sm" style="font-size:11px">← Chess Lobby</a>
    </div>
  </div>

  <div class="cg-right">
    <div class="chess-status-bar" id="statusBar">Loading…</div>
    <div id="resultBanner" style="display:none" class="chess-result-banner"></div>

    <!-- Tabs -->
    <div class="chess-tabs">
      <button class="chess-tab-btn" data-tab="moves" onclick="window.switchChessTab('moves')">📋 Moves</button>
      <button class="chess-tab-btn" data-tab="log"   onclick="window.switchChessTab('log')">📜 Log</button>
      ${isPlayer?`<button class="chess-tab-btn" data-tab="chat" onclick="window.switchChessTab('chat')">💬 Chat</button>`:''}
    </div>
    <div class="chess-tab-panel" data-panel="moves" id="tabMoves" style="display:none"><span style="color:var(--text3);font-size:12px">لا توجد حركات بعد.</span></div>
    <div class="chess-tab-panel" data-panel="log"   id="tabLog"   style="display:none"></div>
    ${isPlayer?`
    <div class="chess-tab-panel" data-panel="chat" id="tabChat" style="display:none">
      <div id="chatMessages" style="max-height:140px;overflow-y:auto"></div>
      <div class="chess-chat-input-row">
        <input id="chatInput" placeholder="Type a message to your opponent…" maxlength="200">
        <button class="btn btn-primary btn-sm" onclick="window.sendChat()">Send</button>
      </div>
    </div>`:''}

    ${isPlayer&&!isFinished&&game.status!=='waiting'?`
    <div id="gameControls" style="display:flex;gap:6px;flex-wrap:wrap">
      <button class="btn btn-danger btn-sm" onclick="window.resignGame()" style="flex:1">🏳️ Resign</button>
      <button class="btn btn-ghost btn-sm" id="drawBtn" onclick="window.offerDraw()" style="flex:1">🤝 Offer Draw</button>
      <button class="btn btn-ghost btn-sm" onclick="window.claimTimeout()" style="flex:1">⏰ Claim Timeout</button>
    </div>`:'<div id="gameControls" style="display:none"></div>'}
  </div>
</div>

<!-- Promotion modal -->
<div id="promoModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.78);z-index:999;align-items:center;justify-content:center">
  <div style="background:var(--bg);border-radius:var(--radius);padding:24px;text-align:center;box-shadow:0 8px 40px rgba(0,0,0,.7)">
    <div style="font-size:15px;font-weight:700;margin-bottom:16px">Choose promotion piece</div>
    <div style="display:flex;gap:10px;justify-content:center">
      ${[['Q','Queen'],['R','Rook'],['B','Bishop'],['N','Knight']].map(([p,label])=>`<button onclick="window.selectPromotion('${p}')" style="display:flex;flex-direction:column;align-items:center;gap:6px;background:var(--bg2);border:2px solid var(--border);border-radius:10px;padding:12px;cursor:pointer;transition:.15s;width:70px" onmouseover="this.style.borderColor='var(--primary)'" onmouseout="this.style.borderColor='var(--border)'"><img src="${promoBase}${promoUrls[p]}.svg" style="width:44px;height:44px"><span style="font-size:11px;font-family:Rajdhani,sans-serif;color:var(--text2)">${label}</span></button>`).join('')}
    </div>
  </div>
</div>

<script>window.__CG=${cgJson};</script>
<script src="/chess-game.js"></script>
`, `<link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@600;700&family=Cairo:wght@400;600;700&display=swap" rel="stylesheet">`);
  }

  // ─── Full-page builder using shared layout from website.js ───────────────
  function escH(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  function fullPage(title, user, active, content, extraHead=''){
    if(layout) return layout(title, content, active, user, extraHead);
    // fallback minimal page (layout not available)
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escH(title)} — Diamond Casino</title><link rel="stylesheet" href="/style.css"><link rel="icon" href="/pfp.png">${extraHead}</head>
<body><div class="particles" id="particles"></div><main class="main" style="padding:20px">${content}</main>
<div id="toast-container"></div><script src="/app.js"></script></body></html>`;
  }
};
