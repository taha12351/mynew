'use strict';
const PenaltyGame = require('./models_games/penaltyGame');
const gameEvents  = require('./gameEvents');
const { v4: uuidv4 } = require('uuid');

// ── SSE registry ─────────────────────────────────────────────
const penaltySSE = new Map(); // gameId -> Set<res>

function emitPenaltySSE(gameId, data){
  const clients = penaltySSE.get(gameId);
  if(!clients) return;
  const payload = `data: ${JSON.stringify(data||{type:'update'})}\n\n`;
  for(const res of clients){
    try{ res.write(payload); }catch(e){}
  }
}

gameEvents.on('penalty_update', (gameId) => emitPenaltySSE(gameId, { type:'update' }));

module.exports = function setupPenaltyRoutes(app, { db, discordClient, SERVER_SETTINGS, siteLog, payoutFn, layout }) {

  const BASE_URL = process.env.REPLIT_DEV_DOMAIN
    ? `https://${process.env.REPLIT_DEV_DOMAIN}`
    : 'http://fi11.bot-hosting.net:20407';

  function escH(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  async function penaltyLog(title, desc, color='#1a7a2e'){
    if(siteLog) await siteLog(title, desc, color).catch(()=>{});
  }

  function shooterForRound(r){ return r===1?'player2':'player1'; }

  async function finishGame(pg, result, reason){
    if(pg.status==='finished') return;
    if(pg.payoutDone) return;
    pg.status='finished'; pg.result=result; pg.resultReason=reason;
    pg.payoutDone=true;
    await pg.save();
    emitPenaltySSE(pg.gameId, { type:'finished' });
    if(payoutFn) await payoutFn({ winnerId: result==='player1'?pg.player1:result==='player2'?pg.player2:null, loserId: result==='player1'?pg.player2:result==='player2'?pg.player1:null, betAmount:pg.betAmount, player1:pg.player1, player2:pg.player2 }).catch(()=>{});
    await penaltyLog('⚽ ركلات الترجيح — انتهت',`${pg.player1Username} vs ${pg.player2Username} — ${result==='draw'?'تعادل':result==='player1'?pg.player1Username+' فاز':pg.player2Username+' فاز'}`,result==='draw'?'#FEE75C':'#57F287');
    // Reset player status_playing
    if(db){
      const [p1,p2] = await Promise.all([
        db.findOne({ id: pg.player1 }).catch(()=>null),
        db.findOne({ id: pg.player2 }).catch(()=>null),
      ]);
      if(p1){ p1.status_playing='no'; await p1.save().catch(()=>{}); }
      if(p2){ p2.status_playing='no'; await p2.save().catch(()=>{}); }
    }
    // Generate result image and update Discord embed
    const imgBuffer = await generatePenaltyResultImage(pg).catch(()=>null);
    await updateDiscordOnPenaltyFinish(pg, imgBuffer).catch(()=>{});
  }

  // ─── Generate penalty result image ────────────────────────────────────────
  async function generatePenaltyResultImage(pg){
    const { createCanvas } = require('canvas');
    const W=560, H=320;
    const canvas=createCanvas(W,H), ctx=canvas.getContext('2d');

    // Background
    const bg=ctx.createLinearGradient(0,0,0,H);
    bg.addColorStop(0,'#0d2310'); bg.addColorStop(1,'#071a09');
    ctx.fillStyle=bg; ctx.fillRect(0,0,W,H);

    // Border
    ctx.strokeStyle='#4CAF50'; ctx.lineWidth=2; ctx.strokeRect(1,1,W-2,H-2);

    // Title
    ctx.textAlign='center'; ctx.fillStyle='#4CAF50'; ctx.font='bold 28px Arial';
    ctx.fillText('⚽ ركلات الترجيح', W/2, 40);

    // Score
    ctx.font='bold 72px Arial'; ctx.fillStyle='#fff';
    ctx.fillText(`${pg.player1Goals} : ${pg.player2Goals}`, W/2, 130);

    // Player names
    ctx.font='bold 16px Arial'; ctx.fillStyle='rgba(255,255,255,0.7)';
    ctx.textAlign='left';  ctx.fillText(pg.player1Username, 30, 165);
    ctx.textAlign='right'; ctx.fillText(pg.player2Username, W-30, 165);

    // Result text
    ctx.textAlign='center'; ctx.font='bold 20px Arial';
    if(pg.result==='draw'){ ctx.fillStyle='#FEE75C'; ctx.fillText('🤝 تعادل!', W/2, 200); }
    else if(pg.result==='player1'){ ctx.fillStyle='#57F287'; ctx.fillText(`🏆 ${pg.player1Username} فاز!`, W/2, 200); }
    else { ctx.fillStyle='#57F287'; ctx.fillText(`🏆 ${pg.player2Username} فاز!`, W/2, 200); }

    // Round results
    const rounds=pg.rounds||[];
    const dotSize=28, dotGap=10, dotTotal=(rounds.length)*(dotSize+dotGap);
    let dotX=(W-dotTotal)/2;
    const dotY=230;
    for(const r of rounds){
      ctx.beginPath();
      ctx.arc(dotX+dotSize/2, dotY+dotSize/2, dotSize/2, 0, Math.PI*2);
      ctx.fillStyle=r.isGoal?'#4CAF50':'#e74c3c';
      ctx.fill();
      ctx.fillStyle='#fff'; ctx.font='bold 12px Arial'; ctx.textAlign='center';
      ctx.fillText(r.isGoal?'⚽':'🧤', dotX+dotSize/2, dotY+dotSize/2+5);
      dotX+=dotSize+dotGap;
    }

    // Footer
    ctx.fillStyle='rgba(255,255,255,0.3)'; ctx.font='12px Arial'; ctx.textAlign='center';
    ctx.fillText(`Diamond Casino · Penalty · ${pg.betAmount.toLocaleString('en-US')} كوين`, W/2, H-12);

    return canvas.toBuffer('image/png');
  }

  // ─── Update Discord embed after penalty game finishes ─────────────────────
  async function updateDiscordOnPenaltyFinish(pg, imgBuffer){
    if(!discordClient||!pg.channelId) return;
    try{
      const { MessageEmbed, MessageAttachment } = require('discord.js');
      const ch=await discordClient.channels.fetch(pg.channelId).catch(()=>null);
      if(!ch) return;

      const winnerName=pg.result==='player1'?pg.player1Username:pg.result==='player2'?pg.player2Username:null;
      const loserName=pg.result==='player1'?pg.player2Username:pg.result==='player2'?pg.player1Username:null;

      const embed=new MessageEmbed()
        .setColor(pg.result==='draw'?'#FEE75C':'#57F287')
        .setTitle('⚽ انتهت ركلات الترجيح!')
        .setDescription([
          `> ⚽ **اللاعب 1:** <@${pg.player1}> (${pg.player1Username})`,
          `> 🧤 **اللاعب 2:** <@${pg.player2}> (${pg.player2Username})`,
          `> 💰 **المبلغ:** \`${(pg.betAmount||0).toLocaleString('en-US')}\` كوين`,
          `> ⚽ **النتيجة:** \`${pg.player1Goals} : ${pg.player2Goals}\``,
          `> `,
          pg.result==='draw'
            ?`> 🤝 **تعادل!**`
            :`> 🏆 **الفائز:** <@${pg.result==='player1'?pg.player1:pg.player2}> (${winnerName})`,
          loserName?`> ❌ **الخاسر:** <@${pg.result==='player1'?pg.player2:pg.player1}> (${loserName})`:'',
        ].filter(Boolean).join('\n'))
        .setFooter({text:`Diamond Casino Penalty · ${pg.gameId}`})
        .setTimestamp();

      // Try to edit the existing start message; if gone, send a fresh one
      const msg = pg.messageId ? await ch.messages.fetch(pg.messageId).catch(()=>null) : null;
      if(imgBuffer){
        const att=new MessageAttachment(imgBuffer,'penalty_result.png');
        embed.setImage('attachment://penalty_result.png');
        if(msg) await msg.edit({ embeds:[embed], files:[att], components:[] }).catch(()=>{});
        else    await ch.send({ embeds:[embed], files:[att] }).catch(e=>console.error('[penalty finish send]',e?.message));
      } else {
        if(msg) await msg.edit({ embeds:[embed], components:[] }).catch(()=>{});
        else    await ch.send({ embeds:[embed] }).catch(e=>console.error('[penalty finish send]',e?.message));
      }
    }catch(e){ console.error('[penalty finish discord]',e?.message); }
  }

  // ── SSE endpoint ─────────────────────────────────────────────
  app.get('/api/penalty/sse/:gameId', (req, res) => {
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const { gameId } = req.params;
    if(!penaltySSE.has(gameId)) penaltySSE.set(gameId, new Set());
    penaltySSE.get(gameId).add(res);
    res.write('data: {"type":"connected"}\n\n');
    req.on('close', () => {
      const s = penaltySSE.get(gameId);
      if(s){ s.delete(res); if(!s.size) penaltySSE.delete(gameId); }
    });
  });

  // ── Accept / start game ───────────────────────────────────────
  app.post('/api/penalty/accept', async(req,res)=>{
    if(!req.session?.user) return res.status(401).json({error:'تسجيل الدخول مطلوب'});
    const {gameId}=req.body;
    const pg=await PenaltyGame.findOne({gameId}).catch(()=>null);
    if(!pg) return res.json({error:'اللعبة غير موجودة'});
    if(pg.player2!==req.session.user.id) return res.json({error:'لست اللاعب المدعو'});
    if(pg.status!=='waiting') return res.json({error:'اللعبة بدأت بالفعل'});
    pg.status='active'; pg.currentRound=0; pg.phase='awaiting_shooter'; pg.currentShooter='player1';
    await pg.save();
    emitPenaltySSE(gameId, { type:'started' });
    await penaltyLog('⚽ ركلات الترجيح — بدأت',`${pg.player1Username} vs ${pg.player2Username}  (${pg.betAmount.toLocaleString()} كوين)`);
    res.json({success:true});
  });

  // ── Get game state ────────────────────────────────────────────
  app.get('/api/penalty/game/:gameId', async(req,res)=>{
    const pg=await PenaltyGame.findOne({gameId:req.params.gameId}).lean().catch(()=>null);
    if(!pg) return res.json({error:'اللعبة غير موجودة'});
    const uid=req.session?.user?.id||null;
    const myRole = uid===pg.player1?'player1':uid===pg.player2?'player2':null;
    const shooterThisRound = shooterForRound(pg.currentRound);
    const keeperThisRound = shooterThisRound==='player1'?'player2':'player1';
    res.json({
      gameId:pg.gameId, status:pg.status, result:pg.result, resultReason:pg.resultReason,
      player1:pg.player1, player1Username:pg.player1Username,
      player2:pg.player2, player2Username:pg.player2Username,
      betAmount:pg.betAmount,
      currentRound:pg.currentRound, phase:pg.phase,
      shooterThisRound, keeperThisRound,
      myRole, player1Goals:pg.player1Goals, player2Goals:pg.player2Goals,
      rounds:pg.rounds||[], roundCount:3,
      iAmShooter: myRole===shooterThisRound,
      iAmKeeper: myRole===keeperThisRound,
    });
  });

  // ── Shooter picks direction ───────────────────────────────────
  app.post('/api/penalty/shoot', async(req,res)=>{
    if(!req.session?.user) return res.status(401).json({error:'تسجيل الدخول مطلوب'});
    const {gameId, dir}=req.body;
    if(!['L','C','R'].includes(dir)) return res.json({error:'اتجاه غير صحيح'});
    const pg=await PenaltyGame.findOne({gameId}).catch(()=>null);
    if(!pg||pg.status!=='active') return res.json({error:'اللعبة غير نشطة'});
    if(pg.phase!=='awaiting_shooter') return res.json({error:'ليس دور الضربة الآن'});
    const uid=req.session.user.id;
    const myRole=uid===pg.player1?'player1':uid===pg.player2?'player2':null;
    if(!myRole) return res.json({error:'لست لاعباً في هذه اللعبة'});
    if(myRole!==shooterForRound(pg.currentRound)) return res.json({error:'لست الضارب في هذه الجولة'});
    pg.pendingShootDir=dir; pg.phase='awaiting_keeper';
    pg.markModified('pendingShootDir'); pg.markModified('phase');
    await pg.save();
    emitPenaltySSE(gameId, { type:'update' });
    res.json({success:true});
  });

  // ── Keeper picks direction ────────────────────────────────────
  app.post('/api/penalty/save', async(req,res)=>{
    if(!req.session?.user) return res.status(401).json({error:'تسجيل الدخول مطلوب'});
    const {gameId, dir}=req.body;
    if(!['L','C','R'].includes(dir)) return res.json({error:'اتجاه غير صحيح'});
    const pg=await PenaltyGame.findOne({gameId}).catch(()=>null);
    if(!pg||pg.status!=='active') return res.json({error:'اللعبة غير نشطة'});
    if(pg.phase!=='awaiting_keeper') return res.json({error:'ليس دور الحارس الآن'});
    const uid=req.session.user.id;
    const myRole=uid===pg.player1?'player1':uid===pg.player2?'player2':null;
    if(!myRole) return res.json({error:'لست لاعباً في هذه اللعبة'});
    const shooterRole=shooterForRound(pg.currentRound);
    const keeperRole=shooterRole==='player1'?'player2':'player1';
    if(myRole!==keeperRole) return res.json({error:'لست الحارس في هذه الجولة'});

    const shootDir=pg.pendingShootDir;
    const keepDir=dir;
    const isGoal=shootDir!==keepDir;
    const shooterId=shooterRole==='player1'?pg.player1:pg.player2;
    const keeperId=keeperRole==='player1'?pg.player1:pg.player2;

    pg.rounds.push({ round:pg.currentRound, shooterId, keeperId, shootDir, keepDir, isGoal });
    if(isGoal){
      if(shooterRole==='player1') pg.player1Goals++;
      else pg.player2Goals++;
    }
    pg.pendingShootDir=null;

    if(pg.currentRound>=2){
      const p1g=pg.player1Goals, p2g=pg.player2Goals;
      if(p1g>p2g) await finishGame(pg,'player1','goals');
      else if(p2g>p1g) await finishGame(pg,'player2','goals');
      else await finishGame(pg,'draw','draw');
    } else {
      pg.currentRound++;
      pg.currentShooter=shooterForRound(pg.currentRound);
      pg.phase='awaiting_shooter';
      pg.markModified('rounds'); pg.markModified('phase'); pg.markModified('currentRound');
      await pg.save();
      emitPenaltySSE(gameId, { type:'update' });
    }
    res.json({ success:true, isGoal, shootDir, keepDir, round:pg.currentRound-1, player1Goals:pg.player1Goals, player2Goals:pg.player2Goals });
  });

  // ── Lobby page ────────────────────────────────────────────────
  app.get('/penalty', async(req,res)=>{
    const user=req.session?.user||null;
    res.send(layout('⚽ ركلات الترجيح', buildLobbyContent(), '/matches', user));
  });

  // ── Game page ─────────────────────────────────────────────────
  app.get('/penalty/:gameId', async(req,res)=>{
    const user=req.session?.user||null;
    const pg=await PenaltyGame.findOne({gameId:req.params.gameId}).lean().catch(()=>null);
    if(!pg) return res.status(404).send(layout('لعبة غير موجودة', `
      <div class="empty-state" style="padding:80px 20px">
        <div class="ei" style="font-size:80px">⚽</div>
        <h2 style="font-family:Rajdhani,Cairo,sans-serif;font-size:32px;color:var(--primary);margin-bottom:8px">Game Not Found</h2>
        <p style="margin-bottom:24px">هذه اللعبة غير موجودة أو انتهت صلاحيتها.</p>
        <a href="/penalty" class="btn btn-primary btn-lg">⚽ العودة</a>
      </div>`, '/matches', user));
    res.send(layout(`⚽ ${escH(pg.player1Username)} ضد ${escH(pg.player2Username)}`, buildGameContent(user, pg), '/matches', user));
  });

  // ── HTML content builders ─────────────────────────────────────
  function buildLobbyContent(){
    return `
<div class="page-header animate-slideUp" dir="rtl">
  <h1>⚽ ركلات الترجيح</h1>
  <p>تحدى صديقك في ركلات الترجيح عبر ديسكورد!</p>
</div>
<div style="max-width:600px;margin:0 auto" dir="rtl">
  <div class="card card-glow animate-slideUp" style="margin-bottom:20px">
    <div class="card-header"><span class="icon">🎮</span> كيف تلعب</div>
    <div style="color:var(--text2);line-height:2.2;font-size:14px">
      <div>1️⃣ استخدم أمر <code style="background:var(--bg3);padding:3px 8px;border-radius:6px;color:var(--primary)">تحدي @صديق المبلغ</code> في ديسكورد</div>
      <div>2️⃣ اختر ⚽ <strong style="color:var(--text)">ركلات الترجيح</strong></div>
      <div>3️⃣ يوافق صديقك ← يظهر رابط اللعبة</div>
      <div>4️⃣ 3 جولات — في كل جولة ضارب وحارس</div>
      <div>5️⃣ اختر الاتجاه: ⬅️ يسار — ⬆️ وسط — ➡️ يمين</div>
      <div>6️⃣ هدف إذا اختلف اتجاه الضارب والحارس!</div>
      <div>7️⃣ من يسجّل أكثر في 3 جولات يفوز 🏆</div>
    </div>
  </div>
  <div class="card card-glow animate-slideUp">
    <div class="card-header"><span class="icon">📋</span> قواعد اللعبة</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:4px">
      <div style="background:var(--bg3);border-radius:10px;padding:14px;text-align:center">
        <div style="font-size:28px;margin-bottom:6px">⚽</div>
        <div style="font-size:13px;font-weight:700;color:var(--text)">3 جولات</div>
        <div style="font-size:11px;color:var(--text2)">كل جولة دور ضارب ودور حارس</div>
      </div>
      <div style="background:var(--bg3);border-radius:10px;padding:14px;text-align:center">
        <div style="font-size:28px;margin-bottom:6px">🏆</div>
        <div style="font-size:13px;font-weight:700;color:var(--text)">الفائز</div>
        <div style="font-size:11px;color:var(--text2)">من يسجّل أكثر أهداف</div>
      </div>
      <div style="background:var(--bg3);border-radius:10px;padding:14px;text-align:center">
        <div style="font-size:28px;margin-bottom:6px">💰</div>
        <div style="font-size:13px;font-weight:700;color:var(--text)">الجائزة</div>
        <div style="font-size:11px;color:var(--text2)">المبلغ بعد خصم 4% ضريبة</div>
      </div>
      <div style="background:var(--bg3);border-radius:10px;padding:14px;text-align:center">
        <div style="font-size:28px;margin-bottom:6px">🤝</div>
        <div style="font-size:13px;font-weight:700;color:var(--text)">تعادل</div>
        <div style="font-size:11px;color:var(--text2)">يُسترد المبلغ للطرفين</div>
      </div>
    </div>
  </div>
</div>`;
  }

  function buildGameContent(user, pg){
    const uid=user?.id||null;
    return `
<style>
*{box-sizing:border-box}
.pg-wrap{max-width:780px;margin:0 auto;padding:20px 16px;direction:rtl}
.pg-title{text-align:center;font-size:20px;font-weight:700;margin-bottom:16px;color:#4CAF50}

/* PITCH */
.pitch{position:relative;background:linear-gradient(180deg,#2d5a27 0%,#3a7a32 50%,#2d5a27 100%);border-radius:16px;overflow:hidden;height:320px;border:3px solid #4CAF50;margin-bottom:16px;box-shadow:0 0 40px rgba(76,175,80,0.2)}
.pitch-lines{position:absolute;inset:0;pointer-events:none}
.pitch-center{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:100px;height:100px;border:2px solid rgba(255,255,255,0.15);border-radius:50%}
.pitch-mid{position:absolute;left:0;right:0;top:50%;height:2px;background:rgba(255,255,255,0.15)}
.goal{position:absolute;top:0;left:50%;transform:translateX(-50%);width:260px;height:80px;border:4px solid #fff;border-top:none;border-radius:0 0 8px 8px;background:rgba(255,255,255,0.05)}
.goal-net{position:absolute;inset:0;background:repeating-linear-gradient(90deg,rgba(255,255,255,0.08) 0,rgba(255,255,255,0.08) 1px,transparent 1px,transparent 20px),repeating-linear-gradient(0deg,rgba(255,255,255,0.08) 0,rgba(255,255,255,0.08) 1px,transparent 1px,transparent 20px)}
.keeper-wrap{position:absolute;top:30px;left:50%;transform:translateX(-50%);width:260px;height:50px;display:flex;align-items:center;justify-content:center}
.keeper{font-size:40px;transition:transform 0.4s cubic-bezier(.34,1.56,.64,1);will-change:transform}
.keeper.dive-L{transform:translateX(-90px) rotate(-20deg)}
.keeper.dive-R{transform:translateX(90px) rotate(20deg)}
.ball-wrap{position:absolute;bottom:60px;left:50%;transform:translateX(-50%)}
.ball{font-size:34px;transition:all 0.5s cubic-bezier(.25,.46,.45,.94);will-change:transform}
.ball.kick-L{transform:translate(-110px,-175px) scale(0.7)}
.ball.kick-C{transform:translate(0,-175px) scale(0.7)}
.ball.kick-R{transform:translate(110px,-175px) scale(0.7)}
.shooter-wrap{position:absolute;bottom:16px;left:50%;transform:translateX(-50%)}
.shooter{font-size:42px}
.round-result{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.5);opacity:0;pointer-events:none;transition:opacity 0.3s;border-radius:13px}
.round-result.show{opacity:1}
.round-result-text{font-size:68px;font-weight:900;text-shadow:0 4px 20px rgba(0,0,0,0.8);animation:popIn 0.4s cubic-bezier(.34,1.56,.64,1)}
@keyframes popIn{from{transform:scale(0) rotate(-10deg)}to{transform:scale(1)}}

/* SCORE */
.score-bar{display:flex;justify-content:space-between;align-items:center;background:var(--bg2);border-radius:12px;padding:14px 20px;margin-bottom:12px;border:1px solid var(--border)}
.score-player{text-align:center;flex:1}
.score-name{font-size:11px;color:var(--text2);margin-bottom:4px}
.score-num{font-size:36px;font-weight:900;color:var(--text);line-height:1}
.score-sep{font-size:22px;color:#4CAF50;padding:0 14px;font-weight:700}
.rounds-bar{display:flex;gap:8px;justify-content:center;margin-bottom:12px}
.round-dot{width:30px;height:30px;border-radius:50%;border:2px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;transition:all 0.3s}
.round-dot.pending{border-color:#555;color:#555}
.round-dot.active{border-color:#4CAF50;color:#4CAF50;box-shadow:0 0 10px rgba(76,175,80,0.4)}
.round-dot.done-goal{background:#4CAF50;border-color:#4CAF50;color:#fff}
.round-dot.done-save{background:#e74c3c;border-color:#e74c3c;color:#fff}

/* CONTROLS */
.ctrl-box{background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:18px;margin-bottom:12px;text-align:center}
.ctrl-label{font-size:13px;color:var(--text2);margin-bottom:12px;font-weight:600}
.dir-btns{display:flex;gap:10px;justify-content:center}
.dir-btn{flex:1;max-width:110px;padding:14px 8px;border:2px solid var(--border);background:var(--bg3);color:var(--text);border-radius:12px;font-size:26px;cursor:pointer;transition:all 0.2s;font-family:inherit}
.dir-btn:hover{border-color:#4CAF50;background:rgba(76,175,80,0.1);transform:translateY(-2px)}
.dir-btn:active{transform:translateY(0)}
.dir-btn:disabled{opacity:0.4;cursor:not-allowed;transform:none}

.waiting-box{text-align:center;padding:22px;color:var(--text2);font-size:14px}
.waiting-spinner{font-size:30px;animation:spin 1.5s linear infinite;display:inline-block;margin-bottom:10px}
@keyframes spin{to{transform:rotate(360deg)}}

.result-banner{border-radius:16px;padding:30px 20px;text-align:center;margin-bottom:12px}
.result-banner.win{background:linear-gradient(135deg,#1a3a1a,#2d5a27);border:2px solid #4CAF50}
.result-banner.lose{background:linear-gradient(135deg,#3a1a1a,#5a2020);border:2px solid #e74c3c}
.result-banner.draw{background:linear-gradient(135deg,#1a1a3a,#2a2a5a);border:2px solid #5865F2}
.result-icon{font-size:60px;margin-bottom:10px}
.result-title{font-size:26px;font-weight:900;margin-bottom:6px}
.result-sub{font-size:13px;color:var(--text2)}

@keyframes goalFlash{0%,100%{background-color:rgba(76,175,80,0)}50%{background-color:rgba(76,175,80,0.3)}}
@keyframes saveFlash{0%,100%{background-color:rgba(231,76,60,0)}50%{background-color:rgba(231,76,60,0.3)}}
.goal-flash{animation:goalFlash 0.6s ease 2}
.save-flash{animation:saveFlash 0.6s ease 2}
</style>

<div class="pg-wrap">
  <div class="pg-title">⚽ ركلات الترجيح</div>

  <div class="score-bar">
    <div class="score-player">
      <div class="score-name">⬜ ${escH(pg.player1Username)}</div>
      <div class="score-num" id="s1">${pg.player1Goals}</div>
    </div>
    <div class="score-sep">—</div>
    <div class="score-player">
      <div class="score-name">⬛ ${escH(pg.player2Username)}</div>
      <div class="score-num" id="s2">${pg.player2Goals}</div>
    </div>
  </div>

  <div class="rounds-bar" id="roundDots">
    <div class="round-dot pending" id="rd0">1</div>
    <div class="round-dot pending" id="rd1">2</div>
    <div class="round-dot pending" id="rd2">3</div>
  </div>

  <div class="pitch" id="pitch">
    <div class="pitch-lines">
      <div class="pitch-mid"></div>
      <div class="pitch-center"></div>
    </div>
    <div class="goal"><div class="goal-net"></div></div>
    <div class="keeper-wrap"><div class="keeper" id="keeper">🧤</div></div>
    <div class="ball-wrap"><div class="ball" id="ball">⚽</div></div>
    <div class="shooter-wrap"><div class="shooter" id="shooterEmoji">🏃</div></div>
    <div class="round-result" id="roundResult"><div class="round-result-text" id="roundResultText"></div></div>
  </div>

  <div id="ctrlArea"></div>
</div>

<script>
const GAME_ID='${escH(pg.gameId)}';
const MY_UID='${uid||''}';
const P1='${escH(pg.player1)}', P1N='${escH(pg.player1Username)}';
const P2='${escH(pg.player2)}', P2N='${escH(pg.player2Username)}';
const BET=${pg.betAmount||0};

let state=null, animating=false;

// ── SSE ─────────────────────────────────────────────────────
const es = new EventSource('/api/penalty/sse/'+GAME_ID);
es.onmessage = function(e){
  let d; try{ d=JSON.parse(e.data); }catch{ return; }
  if(d.type==='connected') return;
  fetchState();
};
es.onerror = function(){
  // fallback: poll every 3s if SSE breaks
  setTimeout(fetchState, 3000);
};

async function fetchState(){
  const d=await fetch('/api/penalty/game/'+GAME_ID).then(r=>r.json()).catch(()=>null);
  if(!d||d.error) return;
  const changed=JSON.stringify(d)!==JSON.stringify(state);
  state=d;
  if(changed) render();
}

function render(){
  if(!state) return;
  updateScore();
  updateRoundDots();
  updateShooterEmoji();
  if(state.status==='waiting') renderWaiting();
  else if(state.status==='finished') renderFinished();
  else renderActive();
}

function updateScore(){
  document.getElementById('s1').textContent=state.player1Goals;
  document.getElementById('s2').textContent=state.player2Goals;
}

function updateRoundDots(){
  const rounds=state.rounds||[];
  for(let i=0;i<3;i++){
    const el=document.getElementById('rd'+i);
    el.className='round-dot';
    if(i<rounds.length) el.classList.add(rounds[i].isGoal?'done-goal':'done-save');
    else if(i===state.currentRound&&state.status==='active') el.classList.add('active');
    else el.classList.add('pending');
  }
}

function updateShooterEmoji(){
  const se=document.getElementById('shooterEmoji');
  if(!state) return;
  se.textContent=state.shooterThisRound==='player1'?'🧑':'👤';
}

function renderWaiting(){
  const ctrl=document.getElementById('ctrlArea');
  if(MY_UID===P2){
    ctrl.innerHTML=\`<div class="ctrl-box">
      <div class="ctrl-label">⏳ \${P1N} يتحداك في ركلات الترجيح!</div>
      <div style="font-size:13px;color:var(--text2);margin-bottom:14px">💰 المبلغ: <strong>\${BET.toLocaleString()}</strong> كوين</div>
      <button onclick="acceptGame()" class="btn btn-primary" style="padding:12px 28px;font-size:15px">✅ قبول التحدي</button>
    </div>\`;
  } else {
    ctrl.innerHTML=\`<div class="waiting-box"><div class="waiting-spinner">⚽</div><br>بانتظار قبول <strong>\${P2N}</strong>…</div>\`;
  }
}

function renderActive(){
  const ctrl=document.getElementById('ctrlArea');
  if(animating) return;
  const phase=state.phase;
  const iAmShooter=state.iAmShooter;
  const iAmKeeper=state.iAmKeeper;
  const shooterName=state.shooterThisRound==='player1'?P1N:P2N;
  const keeperName=state.shooterThisRound==='player1'?P2N:P1N;
  const roundNum=state.currentRound+1;

  document.getElementById('keeper').className='keeper';
  document.getElementById('ball').className='ball';

  if(phase==='awaiting_shooter'){
    if(iAmShooter){
      ctrl.innerHTML=\`<div class="ctrl-box">
        <div class="ctrl-label">⚽ جولة \${roundNum}/3 — أنت الضارب! اختر اتجاه التسديد:</div>
        <div class="dir-btns">
          <button class="dir-btn" onclick="shoot('L')">⬅️<br><small>يسار</small></button>
          <button class="dir-btn" onclick="shoot('C')">⬆️<br><small>وسط</small></button>
          <button class="dir-btn" onclick="shoot('R')">➡️<br><small>يمين</small></button>
        </div>
      </div>\`;
    } else {
      ctrl.innerHTML=\`<div class="waiting-box"><div class="waiting-spinner">⚽</div><br>جولة \${roundNum}/3 — <strong>\${shooterName}</strong> يختار اتجاه التسديد…</div>\`;
    }
  } else if(phase==='awaiting_keeper'){
    if(iAmKeeper){
      ctrl.innerHTML=\`<div class="ctrl-box">
        <div class="ctrl-label">🧤 جولة \${roundNum}/3 — أنت الحارس! اختر اتجاه التصدي:</div>
        <div class="dir-btns">
          <button class="dir-btn" onclick="save('L')">⬅️<br><small>يسار</small></button>
          <button class="dir-btn" onclick="save('C')">⬆️<br><small>وسط</small></button>
          <button class="dir-btn" onclick="save('R')">➡️<br><small>يمين</small></button>
        </div>
      </div>\`;
    } else {
      ctrl.innerHTML=\`<div class="waiting-box"><div class="waiting-spinner">🧤</div><br>جولة \${roundNum}/3 — سدّدت! بانتظار <strong>\${keeperName}</strong> للتصدي…</div>\`;
    }
  }
}

function renderFinished(){
  const ctrl=document.getElementById('ctrlArea');
  const myRole=state.myRole;
  const result=state.result;
  const iWin=(result==='player1'&&myRole==='player1')||(result==='player2'&&myRole==='player2');
  const isDraw=result==='draw';
  const winnerName=result==='player1'?P1N:result==='player2'?P2N:'';
  let cls='draw',icon='🤝',title='تعادل!',sub='لا يوجد تغيير في الأرصدة';
  if(!isDraw){
    if(iWin){ cls='win'; icon='🏆'; title='فزت!'; sub=\`+\${Math.floor(BET*0.96).toLocaleString()} كوين (بعد الضريبة)\`; }
    else{ cls='lose'; icon='😔'; title='خسرت!'; sub=\`-\${BET.toLocaleString()} كوين\`; }
    if(!myRole){ cls='draw'; icon='⚽'; title=\`\${winnerName} يفوز!\`; sub=\`\${state.player1Goals} — \${state.player2Goals}\`; }
  }
  ctrl.innerHTML=\`<div class="result-banner \${cls}">
    <div class="result-icon">\${icon}</div>
    <div class="result-title">\${title}</div>
    <div class="result-sub">\${sub}</div>
    <div style="margin-top:14px;font-size:20px;font-weight:700">\${P1N} \${state.player1Goals} — \${state.player2Goals} \${P2N}</div>
  </div>
  <a href="/penalty" class="btn btn-ghost" style="display:block;text-align:center;margin-top:4px">← العودة للوبي</a>\`;

  if(!animating){
    const last=state.rounds&&state.rounds[state.rounds.length-1];
    if(last) animateKick(last.shootDir, last.keepDir, last.isGoal, ()=>{});
  }
  es.close();
  // Backup balance settle via unified API
  if(MY_UID){
    fetch('/api/csrf-token')
      .then(function(r){ return r.json(); })
      .then(function(csrf){
        if(!csrf.token) return null;
        return fetch('/api/game/settle', {
          method:'POST',
          headers:{'Content-Type':'application/json','X-CSRF-Token':csrf.token},
          body:JSON.stringify({gameId:GAME_ID, gameType:'penalty'})
        });
      })
      .then(function(r){ return r ? r.json() : null; })
      .catch(function(){});
  }
}

function animateKick(shootDir, keepDir, isGoal, cb){
  animating=true;
  const ball=document.getElementById('ball');
  const keeper=document.getElementById('keeper');
  const result=document.getElementById('roundResult');
  const resultText=document.getElementById('roundResultText');
  keeper.className='keeper dive-'+keepDir;
  setTimeout(()=>{ ball.className='ball kick-'+shootDir; },100);
  setTimeout(()=>{
    result.classList.add('show');
    resultText.textContent=isGoal?'⚽ هدف!':'🧤 تصدٍّ!';
    resultText.style.color=isGoal?'#4CAF50':'#e74c3c';
    document.getElementById('pitch').classList.add(isGoal?'goal-flash':'save-flash');
  },600);
  setTimeout(()=>{
    result.classList.remove('show');
    document.getElementById('pitch').classList.remove('goal-flash','save-flash');
    ball.className='ball'; keeper.className='keeper';
    animating=false;
    cb();
  },2200);
}

async function acceptGame(){
  const r=await fetch('/api/penalty/accept',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({gameId:GAME_ID})}).then(r=>r.json()).catch(()=>({error:'خطأ'}));
  if(r.error){alert(r.error);return;}
  await fetchState();
}

async function shoot(dir){
  disableButtons();
  const r=await fetch('/api/penalty/shoot',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({gameId:GAME_ID,dir})}).then(r=>r.json()).catch(()=>({error:'خطأ'}));
  if(r.error){enableButtons();alert(r.error);return;}
  document.getElementById('ctrlArea').innerHTML=\`<div class="waiting-box"><div class="waiting-spinner">🧤</div><br>سدّدت إلى \${dir==='L'?'اليسار':dir==='R'?'اليمين':'الوسط'}! بانتظار الحارس…</div>\`;
}

async function save(dir){
  disableButtons();
  const r=await fetch('/api/penalty/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({gameId:GAME_ID,dir})}).then(r=>r.json()).catch(()=>({error:'خطأ'}));
  if(r.error){enableButtons();alert(r.error);return;}
  animateKick(r.shootDir, dir, r.isGoal, ()=>{
    updateScore();
    updateRoundDots();
    fetchState();
  });
}

function disableButtons(){ document.querySelectorAll('.dir-btn').forEach(b=>b.disabled=true); }
function enableButtons(){  document.querySelectorAll('.dir-btn').forEach(b=>b.disabled=false); }

fetchState();
</script>`;
  }
};
