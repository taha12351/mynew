'use strict';
// ╔══════════════════════════════════════════════════════════════╗
// ║  Diamond Casino — Parkour Web Routes + Game                 ║
// ╚══════════════════════════════════════════════════════════════╝

const ParkourGame = require('./models_games/parkourGame');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const PARKOUR_MAP_FILE = path.join(__dirname, 'parkourMap.json');
function loadSavedMap() {
  try { return JSON.parse(fs.readFileSync(PARKOUR_MAP_FILE, 'utf8')); } catch { return null; }
}

// ── In-memory position store for real-time sync ──────────────
const parkourPositions = new Map(); // gameId -> { p1:{x,y,vx,vy,facing,frame,state,dead}, p2:... }
const parkourSSE = new Map();       // gameId -> Set<{res, role}>

function emitParkourSSE(gameId, data) {
  const clients = parkourSSE.get(gameId);
  if (!clients) return;
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try { client.res.write(payload); } catch (e) {}
  }
}

// ── Game map definition (shared by all games) ─────────────────
const DEFAULT_MAP = {
  width: 4800,
  height: 600,
  platforms: [
    // [x, y, w, h, moving?, moveRange?, moveSpeed?]
    // Ground sections
    { x:0,   y:520, w:400, h:20, type:'ground' },
    { x:460, y:520, w:300, h:20, type:'ground' },
    { x:820, y:520, w:200, h:20, type:'ground' },
    { x:1100, y:520, w:250, h:20, type:'ground' },
    { x:1420, y:520, w:200, h:20, type:'ground' },
    { x:1700, y:520, w:300, h:20, type:'ground' },
    { x:2070, y:520, w:200, h:20, type:'ground' },
    { x:2340, y:520, w:250, h:20, type:'ground' },
    { x:2660, y:520, w:200, h:20, type:'ground' },
    { x:2940, y:520, w:300, h:20, type:'ground' },
    { x:3320, y:520, w:200, h:20, type:'ground' },
    { x:3600, y:520, w:200, h:20, type:'ground' },
    { x:3880, y:520, w:200, h:20, type:'ground' },
    { x:4200, y:520, w:600, h:20, type:'ground' },
    // Floating platforms
    { x:200,  y:430, w:120, h:14, type:'platform' },
    { x:380,  y:360, w:100, h:14, type:'platform' },
    { x:600,  y:420, w:130, h:14, type:'platform' },
    { x:780,  y:350, w:100, h:14, type:'platform' },
    { x:960,  y:430, w:110, h:14, type:'platform' },
    { x:1140, y:380, w:120, h:14, type:'platform' },
    { x:1300, y:440, w:100, h:14, type:'platform' },
    { x:1520, y:380, w:130, h:14, type:'platform' },
    { x:1680, y:310, w:100, h:14, type:'platform' },
    { x:1870, y:420, w:120, h:14, type:'platform' },
    { x:2020, y:360, w:100, h:14, type:'platform' },
    { x:2190, y:440, w:120, h:14, type:'platform' },
    { x:2410, y:380, w:100, h:14, type:'platform' },
    { x:2580, y:300, w:130, h:14, type:'platform' },
    { x:2750, y:420, w:100, h:14, type:'platform' },
    { x:2880, y:350, w:120, h:14, type:'platform' },
    { x:3080, y:430, w:110, h:14, type:'platform' },
    { x:3250, y:370, w:100, h:14, type:'platform' },
    { x:3450, y:440, w:120, h:14, type:'platform' },
    { x:3620, y:380, w:130, h:14, type:'platform' },
    { x:3820, y:300, w:100, h:14, type:'platform' },
    { x:4000, y:420, w:120, h:14, type:'platform' },
    { x:4100, y:340, w:100, h:14, type:'platform' },
    // Moving platforms
    { x:450,  y:400, w:100, h:14, type:'moving', moveAxis:'x', moveRange:80, moveSpeed:1.2 },
    { x:1050, y:430, w:100, h:14, type:'moving', moveAxis:'y', moveRange:80, moveSpeed:0.8 },
    { x:1800, y:380, w:110, h:14, type:'moving', moveAxis:'x', moveRange:100, moveSpeed:1.5 },
    { x:2500, y:380, w:100, h:14, type:'moving', moveAxis:'x', moveRange:90, moveSpeed:1.0 },
    { x:3160, y:400, w:100, h:14, type:'moving', moveAxis:'y', moveRange:70, moveSpeed:1.2 },
    { x:3900, y:370, w:100, h:14, type:'moving', moveAxis:'x', moveRange:80, moveSpeed:1.4 },
  ],
  spikes: [
    { x:405, y:510, w:50, h:12 },
    { x:815, y:510, w:50, h:12 },
    { x:1095, y:510, w:50, h:12 },
    { x:1415, y:510, w:50, h:12 },
    { x:1695, y:510, w:50, h:12 },
    { x:2065, y:510, w:50, h:12 },
    { x:2335, y:510, w:50, h:12 },
    { x:2655, y:510, w:50, h:12 },
    { x:2935, y:510, w:50, h:12 },
    { x:3315, y:510, w:50, h:12 },
    { x:3595, y:510, w:50, h:12 },
    { x:3875, y:510, w:50, h:12 },
  ],
  finish: { x:4700, y:380, w:60, h:140 },
  spawn: { p1:{x:40, y:460}, p2:{x:80, y:460} },
};

function setupParkourRoutes(app, { db, discordClient, SERVER_SETTINGS, siteLog, payoutFn, layout }) {
  // Load map from saved file if available, otherwise use DEFAULT_MAP
  function getGameMap() { return loadSavedMap() || DEFAULT_MAP; }

  const BASE_URL = process.env.REPLIT_DEV_DOMAIN
    ? `https://${process.env.REPLIT_DEV_DOMAIN}`
    : 'http://fi11.bot-hosting.net:20407';

  function escH(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  async function parkourLog(title, desc, color = '#8b5cf6') {
    if (siteLog) await siteLog(title, desc, color).catch(() => {});
  }

  async function finishGame(pg, result, reason) {
    if (pg.status === 'finished') return;
    if (pg.payoutDone) return;
    pg.status = 'finished';
    pg.result = result;
    pg.resultReason = reason;
    pg.payoutDone = true;
    await pg.save();
    parkourPositions.delete(pg.gameId);
    emitParkourSSE(pg.gameId, { type: 'finished', result, reason });

    if (payoutFn) {
      const winnerId = result === 'player1' ? pg.player1 : result === 'player2' ? pg.player2 : null;
      const loserId  = result === 'player1' ? pg.player2 : result === 'player2' ? pg.player1 : null;
      await payoutFn({ winnerId, loserId, betAmount: pg.betAmount, player1: pg.player1, player2: pg.player2 }).catch(() => {});
    }

    const winnerName = result === 'player1' ? pg.player1Username : result === 'player2' ? pg.player2Username : 'Draw';
    await parkourLog('🏃 Parkour — Finished', `**${pg.player1Username}** vs **${pg.player2Username}**\n🏆 Winner: **${winnerName}**\n💰 Amount: ${pg.betAmount.toLocaleString()} coins`, '#8b5cf6');

    // Generate result canvas image + send new embed to channel
    if (discordClient && pg.channelId) {
      try {
        const { MessageEmbed, MessageAttachment } = require('discord.js');
        const { createCanvas } = require('canvas');

        // ── Draw result image ────────────────────────────────────
        const W = 700, H = 280;
        const canvas = createCanvas(W, H);
        const c = canvas.getContext('2d');

        // Background gradient (dark purple)
        const bg = c.createLinearGradient(0, 0, W, H);
        bg.addColorStop(0, '#0f0a1e');
        bg.addColorStop(0.5, '#1a0d33');
        bg.addColorStop(1, '#0f0a1e');
        c.fillStyle = bg;
        c.fillRect(0, 0, W, H);

        // Subtle grid overlay
        c.strokeStyle = 'rgba(139,92,246,0.07)';
        c.lineWidth = 1;
        for(let gx=0;gx<W;gx+=30){ c.beginPath(); c.moveTo(gx,0); c.lineTo(gx,H); c.stroke(); }
        for(let gy=0;gy<H;gy+=30){ c.beginPath(); c.moveTo(0,gy); c.lineTo(W,gy); c.stroke(); }

        // Top accent bar
        const topBar = c.createLinearGradient(0,0,W,0);
        topBar.addColorStop(0,'#7c3aed');
        topBar.addColorStop(0.5,'#a78bfa');
        topBar.addColorStop(1,'#7c3aed');
        c.fillStyle = topBar;
        c.fillRect(0,0,W,4);

        // Title
        c.fillStyle = '#a78bfa';
        c.font = 'bold 14px sans-serif';
        c.textAlign = 'center';
        c.fillText('🏃 PARKOUR RACE — RESULT', W/2, 32);

        // Draw player characters
        function drawChar(cx, cy, color, label, isWinner){
          const scale = isWinner ? 1.15 : 0.85;
          const alpha = isWinner ? 1 : 0.6;
          c.globalAlpha = alpha;

          // Glow
          if(isWinner){
            c.shadowColor = color;
            c.shadowBlur = 20;
          }

          // Body
          c.fillStyle = color;
          const bw = 32*scale, bh = 40*scale;
          c.beginPath();
          c.roundRect(cx - bw/2, cy - bh, bw, bh, 6);
          c.fill();

          // Head
          const hw = 28*scale, hh = 28*scale;
          c.fillStyle = '#fcd5ae';
          c.beginPath();
          c.arc(cx, cy - bh - hh/2 + 4, hw/2, 0, Math.PI*2);
          c.fill();

          // Eyes
          c.fillStyle = '#1a1a2e';
          c.beginPath(); c.arc(cx-5*scale, cy-bh-hh/2+2, 3*scale, 0, Math.PI*2); c.fill();
          c.beginPath(); c.arc(cx+5*scale, cy-bh-hh/2+2, 3*scale, 0, Math.PI*2); c.fill();

          c.shadowBlur = 0;
          c.globalAlpha = 1;

          // Winner crown
          if(isWinner){
            c.fillStyle = '#fbbf24';
            c.font = `bold ${Math.round(22*scale)}px sans-serif`;
            c.textAlign = 'center';
            c.fillText('👑', cx, cy - bh - hh + 2);
          }

          // Name label
          c.fillStyle = isWinner ? '#ffffff' : 'rgba(255,255,255,0.5)';
          c.font = `bold ${Math.round(15*scale)}px sans-serif`;
          c.textAlign = 'center';
          c.fillText(label.length>14 ? label.slice(0,13)+'…' : label, cx, cy + 22);

          // Rank label
          c.fillStyle = isWinner ? '#fbbf24' : '#6b7280';
          c.font = `bold ${Math.round(12*scale)}px sans-serif`;
          c.fillText(isWinner ? '🏆 WINNER' : '💀 LOSER', cx, cy + 38);
        }

        if(result === 'draw'){
          drawChar(W*0.3, H*0.72, '#0ea5e9', pg.player1Username, true);
          drawChar(W*0.7, H*0.72, '#f59e0b', pg.player2Username, true);
          // Draw banner
          c.fillStyle = '#fbbf24';
          c.font = 'bold 28px sans-serif';
          c.textAlign = 'center';
          c.fillText('🤝  DRAW!', W/2, H/2 - 10);
        } else {
          const winnerIsP1 = result === 'player1';
          drawChar(W*0.3, H*0.72, '#0ea5e9', pg.player1Username, winnerIsP1);
          drawChar(W*0.7, H*0.72, '#f59e0b', pg.player2Username, !winnerIsP1);
        }

        // VS divider
        c.fillStyle = 'rgba(139,92,246,0.4)';
        c.fillRect(W/2 - 1, 60, 2, H - 100);
        c.fillStyle = 'rgba(139,92,246,0.8)';
        c.font = 'bold 14px sans-serif';
        c.textAlign = 'center';
        c.fillText('VS', W/2, H*0.5);

        // Bet amount pill
        const pillW = 200, pillX = W/2 - pillW/2, pillY = H - 44;
        c.fillStyle = 'rgba(16,185,129,0.15)';
        c.beginPath(); c.roundRect(pillX, pillY, pillW, 28, 14); c.fill();
        c.strokeStyle = '#10b981'; c.lineWidth = 1.5;
        c.beginPath(); c.roundRect(pillX, pillY, pillW, 28, 14); c.stroke();
        c.fillStyle = '#10b981';
        c.font = 'bold 14px sans-serif';
        c.textAlign = 'center';
        c.fillText(`💰 ${pg.betAmount.toLocaleString('en-US')} coins`, W/2, pillY + 18);

        // Footer
        c.fillStyle = 'rgba(139,92,246,0.5)';
        c.font = '11px sans-serif';
        c.textAlign = 'center';
        c.fillText('Diamond Casino · Parkour', W/2, H - 8);

        const imgBuffer = canvas.toBuffer('image/png');
        const attachment = new MessageAttachment(imgBuffer, 'parkour_result.png');

        const winnerId = result === 'player1' ? pg.player1 : pg.player2;
        const loserId  = result === 'player1' ? pg.player2 : pg.player1;
        const resultEmbed = new MessageEmbed()
          .setColor(result === 'draw' ? '#FEE75C' : '#57F287')
          .setTitle('🏃 Parkour Race Finished!')
          .setDescription([
            `> 🔵 **Player 1:** <@${pg.player1}> (${pg.player1Username})`,
            `> 🟡 **Player 2:** <@${pg.player2}> (${pg.player2Username})`,
            `> 💰 **Bet:** \`${pg.betAmount.toLocaleString('en-US')}\` coins`,
            `> `,
            result === 'draw'
              ? `> 🤝 **Draw!** The bet is refunded.`
              : `> 🏆 **Winner:** <@${winnerId}> (${winnerName})`,
            result !== 'draw'
              ? `> ❌ **Loser:** <@${loserId}>` : '',
            `> 🎯 **Reason:** ${reason === 'finish' ? 'Reached the finish line' : reason === 'forfeit' ? 'Opponent forfeited' : reason}`,
          ].filter(Boolean).join('\n'))
          .setImage('attachment://parkour_result.png')
          .setFooter({ text: `Diamond Casino · Parkour · ${pg.gameId}` })
          .setTimestamp();

        const ch = await discordClient.channels.fetch(pg.channelId).catch(() => null);
        if (ch) {
          // Send brand new message with image
          await ch.send({ embeds: [resultEmbed], files: [attachment] }).catch(e => console.error('[parkour finish embed]', e?.message));
          // Also try to edit/delete the original game start message
          if (pg.messageId) {
            const msg = await ch.messages.fetch(pg.messageId).catch(() => null);
            if (msg) await msg.delete().catch(() => {});
          }
        }
      } catch (e) {
        console.error('[parkour finishGame embed error]', e?.message);
      }
    }

    // Reset player status
    if (db) {
      const p1 = await db.findOne({ id: pg.player1 }).catch(() => null);
      const p2 = await db.findOne({ id: pg.player2 }).catch(() => null);
      if (p1) { p1.status_playing = 'no'; await p1.save().catch(() => {}); }
      if (p2) { p2.status_playing = 'no'; await p2.save().catch(() => {}); }
    }
  }

  // ── SSE endpoint ─────────────────────────────────────────────
  app.get('/api/parkour/sse/:gameId', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const { gameId } = req.params;
    const uid = req.session?.user?.id || null;
    if (!parkourSSE.has(gameId)) parkourSSE.set(gameId, new Set());
    const client = { res, uid };
    parkourSSE.get(gameId).add(client);
    res.write('data: {"type":"connected"}\n\n');
    req.on('close', () => {
      const s = parkourSSE.get(gameId);
      if (s) { s.delete(client); if (!s.size) parkourSSE.delete(gameId); }
    });
  });

  // ── Get game state ────────────────────────────────────────────
  app.get('/api/parkour/game/:gameId', async (req, res) => {
    const pg = await ParkourGame.findOne({ gameId: req.params.gameId }).lean().catch(() => null);
    if (!pg) return res.json({ error: 'اللعبة غير موجودة' });
    const uid = req.session?.user?.id || null;
    const myRole = uid === pg.player1 ? 'player1' : uid === pg.player2 ? 'player2' : null;
    const positions = parkourPositions.get(pg.gameId) || {};
    res.json({
      gameId: pg.gameId, status: pg.status, result: pg.result, resultReason: pg.resultReason,
      player1: pg.player1, player1Username: pg.player1Username,
      player2: pg.player2, player2Username: pg.player2Username,
      betAmount: pg.betAmount, myRole,
      positions,
      player1ReadyAt: pg.player1ReadyAt,
      player2ReadyAt: pg.player2ReadyAt,
    });
  });

  // ── Position update ───────────────────────────────────────────
  app.post('/api/parkour/position', async (req, res) => {
    if (!req.session?.user) return res.status(401).json({ error: 'تسجيل الدخول مطلوب' });
    const { gameId, x, y, vx, vy, facing, frame, state } = req.body;
    const pg = await ParkourGame.findOne({ gameId }).catch(() => null);
    if (!pg || pg.status !== 'active') return res.json({ ok: false });
    const uid = req.session.user.id;
    const role = uid === pg.player1 ? 'p1' : uid === pg.player2 ? 'p2' : null;
    if (!role) return res.json({ ok: false });
    if (!parkourPositions.has(gameId)) parkourPositions.set(gameId, {});
    parkourPositions.get(gameId)[role] = { x, y, vx, vy, facing, frame, state, ts: Date.now() };
    emitParkourSSE(gameId, { type: 'pos', role, x, y, vx, vy, facing, frame, state });
    res.json({ ok: true });
  });

  // ── Player ready ──────────────────────────────────────────────
  app.post('/api/parkour/ready', async (req, res) => {
    if (!req.session?.user) return res.status(401).json({ error: 'تسجيل الدخول مطلوب' });
    const { gameId } = req.body;
    const pg = await ParkourGame.findOne({ gameId }).catch(() => null);
    if (!pg || pg.status !== 'active') return res.json({ ok: false });
    const uid = req.session.user.id;
    const now = Date.now();
    if (uid === pg.player1 && !pg.player1ReadyAt) { pg.player1ReadyAt = now; }
    else if (uid === pg.player2 && !pg.player2ReadyAt) { pg.player2ReadyAt = now; }
    else return res.json({ ok: true });
    await pg.save();
    emitParkourSSE(gameId, { type: 'ready', p1: !!pg.player1ReadyAt, p2: !!pg.player2ReadyAt });
    if (pg.player1ReadyAt && pg.player2ReadyAt) {
      emitParkourSSE(gameId, { type: 'start', startAt: Date.now() + 3000 });
    }
    res.json({ ok: true });
  });

  // ── Player finished the level ─────────────────────────────────
  app.post('/api/parkour/finish', async (req, res) => {
    if (!req.session?.user) return res.status(401).json({ error: 'تسجيل الدخول مطلوب' });
    const { gameId } = req.body;
    const pg = await ParkourGame.findOne({ gameId }).catch(() => null);
    if (!pg || pg.status !== 'active') return res.json({ ok: false });
    const uid = req.session.user.id;
    const now = Date.now();
    let changed = false;
    if (uid === pg.player1 && !pg.player1FinishedAt) { pg.player1FinishedAt = now; changed = true; }
    else if (uid === pg.player2 && !pg.player2FinishedAt) { pg.player2FinishedAt = now; changed = true; }
    if (!changed) return res.json({ ok: true });
    await pg.save();

    if (pg.player1FinishedAt && pg.player2FinishedAt) {
      const result = pg.player1FinishedAt < pg.player2FinishedAt ? 'player1' : 'player2';
      await finishGame(pg, result, 'finish');
    } else {
      // First player to reach the finish wins immediately — no need to wait
      const winner = uid === pg.player1 ? 'player1' : 'player2';
      await finishGame(pg, winner, 'finish');
    }
    res.json({ ok: true });
  });

  // ── Player died (fell off) → give opponent 30s to finish ──────
  app.post('/api/parkour/died', async (req, res) => {
    if (!req.session?.user) return res.status(401).json({ error: 'تسجيل الدخول مطلوب' });
    const { gameId } = req.body;
    const pg = await ParkourGame.findOne({ gameId }).catch(() => null);
    if (!pg || pg.status !== 'active') return res.json({ ok: false });
    const uid = req.session.user.id;
    // If other player already finished → finish game
    const myRole = uid === pg.player1 ? 'player1' : 'player2';
    const otherFinished = myRole === 'player1' ? pg.player2FinishedAt : pg.player1FinishedAt;
    if (otherFinished) {
      const result = myRole === 'player1' ? 'player2' : 'player1';
      await finishGame(pg, result, 'opponent_finished');
    } else {
      emitParkourSSE(gameId, { type: 'player_died', who: myRole });
    }
    res.json({ ok: true });
  });

  // ── Forfeit ───────────────────────────────────────────────────
  app.post('/api/parkour/forfeit', async (req, res) => {
    if (!req.session?.user) return res.status(401).json({ error: 'تسجيل الدخول مطلوب' });
    const { gameId } = req.body;
    const pg = await ParkourGame.findOne({ gameId }).catch(() => null);
    if (!pg || !['waiting','active'].includes(pg.status)) return res.json({ ok: false });
    const uid = req.session.user.id;
    const myRole = uid === pg.player1 ? 'player1' : uid === pg.player2 ? 'player2' : null;
    if (!myRole) return res.json({ ok: false });
    const result = myRole === 'player1' ? 'player2' : 'player1';
    await finishGame(pg, result, 'forfeit');
    res.json({ ok: true });
  });

  // ── Parkour game page ─────────────────────────────────────────
  app.get('/parkour/:gameId', async (req, res) => {
    const user = req.session?.user || null;
    const pg = await ParkourGame.findOne({ gameId: req.params.gameId }).lean().catch(() => null);
    if (!pg) return res.status(404).send(buildNotFoundPage(user));
    res.send(buildParkourGamePage(user, pg, BASE_URL));
  });

  // ── Lobby ─────────────────────────────────────────────────────
  app.get('/parkour', async (req, res) => {
    const user = req.session?.user || null;
    const recent = user
      ? await ParkourGame.find({ $or: [{ player1: user.id }, { player2: user.id }] }).sort({ createdAt: -1 }).limit(10).lean().catch(() => [])
      : [];
    res.send(buildLobbyPage(user, recent));
  });

  // ─── HTML builders ────────────────────────────────────────────

  function buildNotFoundPage(user) {
    return fullPage('Game Not Found — Parkour', user, '/parkour', `
<div style="text-align:center;padding:80px 20px">
  <div style="font-size:80px">🏃</div>
  <h2 style="font-family:Rajdhani,Cairo,sans-serif;font-size:32px;color:var(--primary);margin-bottom:8px">Game Not Found</h2>
  <p style="margin-bottom:24px;color:var(--text2)">This game doesn't exist or has expired.</p>
  <a href="/parkour" class="btn btn-primary btn-lg">🏃 Parkour Lobby</a>
</div>`);
  }

  function buildLobbyPage(user, recent) {
    const recentHtml = recent.length
      ? recent.map(g => {
          const isp1 = user && g.player1 === user.id;
          const vs = isp1 ? g.player2Username : g.player1Username;
          const status = g.status === 'finished'
            ? (g.result === 'draw' ? '🤝 Draw' : g.result === (isp1 ? 'player1' : 'player2') ? '✅ Win' : '❌ Loss')
            : g.status === 'active' ? '🟢 Active' : '⏳ Waiting';
          return `<a href="/parkour/${g.gameId}" class="pkr-recent-row">
            <span style="font-size:20px">🏃</span>
            <span style="flex:1;font-size:13px">vs <strong>${escH(vs)}</strong></span>
            <span class="badge ${g.status==='finished'?'badge-purple':g.status==='active'?'badge-green':'badge-blue'}">${status}</span>
          </a>`;
        }).join('')
      : '<div style="color:var(--text3);font-size:13px;padding:10px 0">No recent games.</div>';

    return fullPage('Parkour — Diamond Casino', user, '/parkour', `
<style>
.pkr-recent-row{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:var(--radius-sm);border:1px solid var(--border);margin-bottom:8px;text-decoration:none;color:inherit;transition:border-color 0.2s}
.pkr-recent-row:hover{border-color:var(--purple)}
.pkr-obstacle-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px;margin-top:8px}
.pkr-obstacle-card{background:var(--bg2);border-radius:var(--radius-sm);padding:12px;border:1px solid var(--border)}
.pkr-obstacle-card .ob-icon{font-size:28px;margin-bottom:6px}
.pkr-obstacle-card .ob-name{font-size:12px;font-weight:700;color:var(--text);margin-bottom:3px}
.pkr-obstacle-card .ob-desc{font-size:11px;color:var(--text2);line-height:1.4}
</style>
<div class="page-header animate-slideUp">
  <h1>🏃 Parkour</h1>
  <p>Two-player parkour race — first to reach the finish wins!</p>
</div>
<div class="grid-2" style="gap:20px;align-items:start">
  <div>
    <div class="card card-glow" style="margin-bottom:16px">
      <div class="card-header"><span class="icon">🏃</span> How to play</div>
      <div style="padding:4px 0">
        <div style="display:flex;gap:12px;padding:10px 0;border-bottom:1px solid var(--border)">
          <span style="font-size:24px">1️⃣</span>
          <div><div style="font-weight:600;font-size:13px">Challenge your friend on Discord</div><div style="font-size:12px;color:var(--text2);margin-top:2px">Use the challenge command then click 🏃 Parkour</div></div>
        </div>
        <div style="display:flex;gap:12px;padding:10px 0;border-bottom:1px solid var(--border)">
          <span style="font-size:24px">2️⃣</span>
          <div><div style="font-weight:600;font-size:13px">Click the game link in Discord</div><div style="font-size:12px;color:var(--text2);margin-top:2px">After accepting the challenge the game link appears publicly</div></div>
        </div>
        <div style="display:flex;gap:12px;padding:10px 0;border-bottom:1px solid var(--border)">
          <span style="font-size:24px">3️⃣</span>
          <div><div style="font-weight:600;font-size:13px">Press "Ready!" when both players join</div><div style="font-size:12px;color:var(--text2);margin-top:2px">A 3-second countdown starts once both players are ready</div></div>
        </div>
        <div style="display:flex;gap:12px;padding:10px 0">
          <span style="font-size:24px">4️⃣</span>
          <div><div style="font-weight:600;font-size:13px">Race to the finish!</div><div style="font-size:12px;color:var(--text2);margin-top:2px">First to complete the course wins the bet amount</div></div>
        </div>
      </div>
      <div class="card" style="margin-top:12px;background:var(--bg2);border:1px solid rgba(139,92,246,0.2)">
        <div style="font-size:13px;color:var(--text2)">🎮 <strong>Controls:</strong> ← → Move · ↑ or Space Jump · R Reset to start</div>
      </div>
    </div>
    <div class="card card-glow">
      <div class="card-header"><span class="icon">🗺️</span> Map Obstacles Guide</div>
      <div class="pkr-obstacle-grid">
        <div class="pkr-obstacle-card"><div class="ob-icon">🟫</div><div class="ob-name">Ground</div><div class="ob-desc">Solid ground with grass on top. Safe to run on.</div></div>
        <div class="pkr-obstacle-card"><div class="ob-icon">🟧</div><div class="ob-name">Platform</div><div class="ob-desc">Wooden floating platform. Jump to reach higher areas.</div></div>
        <div class="pkr-obstacle-card" style="border-color:rgba(139,92,246,0.4)"><div class="ob-icon">🟣</div><div class="ob-name">Moving Platform</div><div class="ob-desc">Glowing purple platform that slides back and forth. Time your jump!</div></div>
        <div class="pkr-obstacle-card" style="border-color:rgba(34,197,94,0.4)"><div class="ob-icon">🟢</div><div class="ob-name">Spring</div><div class="ob-desc">Green pad that launches you super high. Land on it to bounce!</div></div>
        <div class="pkr-obstacle-card" style="border-color:rgba(96,165,250,0.4)"><div class="ob-icon">🔵</div><div class="ob-name">Ice Platform</div><div class="ob-desc">Slippery icy platform. Your character slides — hard to stop!</div></div>
        <div class="pkr-obstacle-card" style="border-color:rgba(239,68,68,0.4)"><div class="ob-icon">🔴</div><div class="ob-name">Lava Zone</div><div class="ob-desc">Glowing red lava area. Instant death on contact — avoid it!</div></div>
        <div class="pkr-obstacle-card" style="border-color:rgba(239,68,68,0.4)"><div class="ob-icon">🔺</div><div class="ob-name">Spikes</div><div class="ob-desc">Red spike traps. Touching them kills you and resets to spawn.</div></div>
        <div class="pkr-obstacle-card" style="border-color:rgba(251,191,36,0.4)"><div class="ob-icon">🟡</div><div class="ob-name">Boost Pad</div><div class="ob-desc">Yellow arrow pad. Gives you a horizontal speed burst forward.</div></div>
      </div>
      <div style="margin-top:12px;padding:10px;background:var(--bg2);border-radius:var(--radius-sm);font-size:12px;color:var(--text2)">
        📋 <strong>Map JSON Schema:</strong> platforms array supports types: <code>ground</code>, <code>platform</code>, <code>moving</code> (add moveAxis:"x"/"y", moveRange, moveSpeed), <code>spring</code>, <code>ice</code>, <code>boost</code> (add direction: 1 or -1). Spikes array for death zones. Lava array for instant-kill areas.
      </div>
    </div>
  </div>
  <div>
    ${user ? `<div class="card card-glow">
      <div class="card-header"><span class="icon" style="color:var(--purple)">🕐</span> Recent Games</div>
      ${recentHtml}
    </div>` : `<div class="card card-glow"><div class="card-header"><span class="icon">🔐</span> Log in</div><a href="/auth/discord" class="btn btn-discord" style="width:100%;justify-content:center;margin-top:12px">Login with Discord</a></div>`}
  </div>
</div>`);
  }

  function buildParkourGamePage(user, pg, baseUrl) {
    const uid = user?.id || null;
    const myRole = uid === pg.player1 ? 'player1' : uid === pg.player2 ? 'player2' : null;
    const isPlayer = !!myRole;
    const isFinished = pg.status === 'finished';
    const isWaiting = pg.status === 'waiting';

    const cgJson = JSON.stringify({
      gameId: pg.gameId, myRole, isPlayer,
      player1: pg.player1, player1Username: pg.player1Username,
      player2: pg.player2, player2Username: pg.player2Username,
      betAmount: pg.betAmount, status: pg.status,
      result: pg.result || null,
      map: getGameMap(),
    });

    return fullPage(`Parkour — ${escH(pg.player1Username)} vs ${escH(pg.player2Username)}`, user, '/parkour', `
<style>
#parkourCanvas{display:block;background:#1a1a2e;border-radius:var(--radius);border:2px solid rgba(139,92,246,0.4);box-shadow:0 0 40px rgba(139,92,246,0.2);cursor:none;image-rendering:pixelated;width:100%;height:auto}
.pkr-hud{display:flex;align-items:center;justify-content:space-between;padding:10px 16px;background:var(--card2);border-radius:var(--radius-sm);border:1px solid var(--border);margin-bottom:10px}
.pkr-player{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600}
.pkr-dot{width:12px;height:12px;border-radius:50%;flex-shrink:0}
.pkr-status{text-align:center;font-size:13px;font-weight:600;color:var(--text2)}
.pkr-result{background:linear-gradient(135deg,var(--purple),var(--primary));color:#fff;border-radius:var(--radius-sm);padding:14px;text-align:center;font-weight:700;font-size:16px;margin-bottom:12px;display:none}
.pkr-controls{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;align-items:center}
.pkr-touch{display:none;gap:10px;margin-top:12px;justify-content:space-between;align-items:center;user-select:none;-webkit-user-select:none}
.pkr-touch-group{display:flex;gap:8px}
.pkr-btn{width:64px;height:64px;border-radius:14px;background:rgba(139,92,246,0.18);border:2px solid rgba(139,92,246,0.5);color:#fff;font-size:26px;display:flex;align-items:center;justify-content:center;cursor:pointer;touch-action:none;transition:background 0.1s;-webkit-tap-highlight-color:transparent}
.pkr-btn:active,.pkr-btn.pressed{background:rgba(139,92,246,0.55);border-color:#a78bfa}
.pkr-btn-jump{width:72px;height:72px;border-radius:50%;background:rgba(16,185,129,0.18);border:2px solid rgba(16,185,129,0.5);font-size:28px}
.pkr-btn-jump:active,.pkr-btn-jump.pressed{background:rgba(16,185,129,0.55);border-color:#10b981}
@media(max-width:640px){
  .pkr-hud{flex-direction:column;gap:6px;text-align:center}
  .pkr-player{flex-direction:column;align-items:center;gap:3px}
  .pkr-touch{display:flex}
  .pkr-controls .kb-hint{display:none}
}
@media(max-width:400px){
  .pkr-btn{width:56px;height:56px;font-size:22px}
  .pkr-btn-jump{width:62px;height:62px;font-size:24px}
}
</style>

<div class="page-header animate-slideUp" style="margin-bottom:12px">
  <h1>🏃 ${escH(pg.player1Username)} <span style="color:var(--text3);font-size:18px">vs</span> ${escH(pg.player2Username)}</h1>
  <p>Parkour · ${pg.betAmount.toLocaleString('en-US')} coins</p>
</div>

<div id="resultBanner" class="pkr-result"></div>

<div class="pkr-hud">
  <div class="pkr-player">
    <div class="pkr-dot" style="background:#0ea5e9"></div>
    <span>${escH(pg.player1Username)}</span>
    <span id="p1status" style="font-size:11px;color:var(--text3)">Waiting to join</span>
  </div>
  <div class="pkr-status" id="gameStatus">
    ${isFinished ? '🏁 Finished' : isWaiting ? '⏳ Waiting for challenge acceptance' : '⏳ Waiting for players'}
  </div>
  <div class="pkr-player" style="flex-direction:row-reverse">
    <div class="pkr-dot" style="background:#f59e0b"></div>
    <span>${escH(pg.player2Username)}</span>
    <span id="p2status" style="font-size:11px;color:var(--text3)">Waiting to join</span>
  </div>
</div>

<div style="position:relative;width:100%;overflow:hidden">
  <canvas id="parkourCanvas"></canvas>
</div>

${isPlayer && !isFinished ? `
<div class="pkr-controls">
  <button class="btn btn-primary" id="readyBtn" onclick="window.pkrReady()">✅ Ready to Play!</button>
  <button class="btn btn-danger btn-sm" onclick="window.pkrForfeit()">🏳️ Forfeit</button>
  <span class="kb-hint" style="font-size:12px;color:var(--text3);margin-left:auto;align-self:center">← → Move · ↑ / Space Jump</span>
</div>
<div class="pkr-touch" id="touchControls">
  <div class="pkr-touch-group">
    <div class="pkr-btn" id="btnLeft" ontouchstart="pkrTouch('ArrowLeft',true)" ontouchend="pkrTouch('ArrowLeft',false)" onmousedown="pkrTouch('ArrowLeft',true)" onmouseup="pkrTouch('ArrowLeft',false)">◀</div>
    <div class="pkr-btn" id="btnRight" ontouchstart="pkrTouch('ArrowRight',true)" ontouchend="pkrTouch('ArrowRight',false)" onmousedown="pkrTouch('ArrowRight',true)" onmouseup="pkrTouch('ArrowRight',false)">▶</div>
  </div>
  <div class="pkr-btn pkr-btn-jump" id="btnJump" ontouchstart="pkrTouch('ArrowUp',true)" ontouchend="pkrTouch('ArrowUp',false)" onmousedown="pkrTouch('ArrowUp',true)" onmouseup="pkrTouch('ArrowUp',false)">↑</div>
</div>` : ''}

${!user ? `<div style="margin-top:10px;padding:10px;background:var(--card2);border-radius:var(--radius-sm);font-size:13px">🔐 <a href="/auth/discord" style="color:var(--gold)">Log in</a> to play — or watch as a spectator</div>` : ''}

<script>
window.__PKR = ${cgJson};
</script>
<script src="/parkour-game.js"></script>
`, `<link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@600;700&family=Cairo:wght@400;600;700&display=swap" rel="stylesheet">`);
  }

  function fullPage(title, user, active, content, extraHead = '') {
    if(layout) return layout(title, content, active, user, extraHead);
    // fallback minimal page (layout not available)
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escH(title)} — Diamond Casino</title><link rel="stylesheet" href="/style.css"><link rel="icon" href="/pfp.png">${extraHead}</head>
<body><div class="particles" id="particles"></div><main class="main" style="padding:20px">${content}</main>
<div id="toast-container"></div><script src="/app.js"></script></body></html>`;
  }
}

setupParkourRoutes.DEFAULT_MAP = DEFAULT_MAP;
module.exports = setupParkourRoutes;
