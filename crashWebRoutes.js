'use strict';
const crypto = require('crypto');

// ══════════════════════════════════════════════════════════
//  CRASH GAME ENGINE
// ══════════════════════════════════════════════════════════

const WAIT_MS    = 8000;
const CRASH_SHOW = 3000;
const TICK_MS    = 80;   // faster server ticks

// Server-side multiplier — reaches 15x in ~50s, fast & exciting
function calcMult(elapsedMs) {
  return Math.floor(100 * Math.pow(1.005, elapsedMs / 100)) / 100;
}

// Custom crash distribution:
//   20% → crash 1.01x – 1.99x
//   50% → crash 2.00x – 3.99x
//   30% → crash 4.00x – 14.99x  (hard cap: 15x)
function genCrashPoint(seed) {
  const hash = crypto.createHash('sha256').update(seed).digest('hex');
  // Uniform float 0–1 from first 8 hex chars
  const h = parseInt(hash.slice(0, 8), 16) / 0xFFFFFFFF;

  let cp;
  if (h < 0.50) {
    // 20 % — low tier  1.01 – 1.99
    cp = 1.01 + (h / 0.20) * (1.99 - 1.01);
  } else if (h < 0.70) {
    // 50 % — mid tier  2.00 – 3.99
    cp = 2.00 + ((h - 0.20) / 0.50) * (3.99 - 2.00);
  } else {
    // 30 % — high tier  4.00 – 14.99
    cp = 4.00 + ((h - 0.70) / 0.30) * (14.99 - 4.00);
  }
  return Math.floor(cp * 100) / 100;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── SSE registry ──────────────────────────────────────────
const sseClients = new Set();
function broadcast(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) { try { res.write(payload); } catch (_) {} }
}

// ── Global game state ─────────────────────────────────────
const G = {
  phase: 'waiting', roundId: 1, seed: '', crashPoint: 1.00,
  multiplier: 1.00, startTime: null, waitUntil: Date.now() + WAIT_MS,
  bets: new Map(),   // userId → bet obj
  history: [],
};

// ── Game loop ─────────────────────────────────────────────
async function gameLoop(db) {
  while (true) {
    G.phase = 'waiting'; G.bets = new Map(); G.multiplier = 1.00;
    G.seed = crypto.randomBytes(16).toString('hex');
    G.crashPoint = genCrashPoint(G.seed);
    G.waitUntil = Date.now() + WAIT_MS;
    broadcast({ type: 'waiting', countdown: Math.ceil(WAIT_MS / 1000), roundId: G.roundId });
    for (let i = Math.ceil(WAIT_MS / 1000) - 1; i >= 0; i--) {
      await sleep(1000);
      broadcast({ type: 'countdown', countdown: i, roundId: G.roundId });
    }

    G.phase = 'flying'; G.startTime = Date.now();
    broadcast({ type: 'start', roundId: G.roundId });

    while (true) {
      await sleep(TICK_MS);
      const elapsed = Date.now() - G.startTime;
      const mult = calcMult(elapsed);
      G.multiplier = mult;
      if (mult >= G.crashPoint) { G.multiplier = G.crashPoint; break; }

      // ── Server-side auto-cashout ───────────────────────
      for (const [uid, bet] of G.bets) {
        if (!bet.cashedOut && bet.autoCashout && mult >= bet.autoCashout) {
          const acMult  = Math.floor(Math.min(bet.autoCashout, mult) * 100) / 100;
          const payout  = Math.floor(bet.amount * acMult);
          bet.cashedOut = true; bet.cashoutMult = acMult;
          if (db) {
            try {
              const u = await db.findOne({ id: uid });
              if (u) { u.coins = Number(u.coins || 0) + payout; u.status_playing = 'no'; await u.save(); }
            } catch (_) {}
          }
          broadcast({ type: 'cashout', userId: uid, username: bet.username, avatar: bet.avatar, cashoutMult: acMult, payout, profit: payout - bet.amount, auto: true });
        }
      }

      const liveBets = [...G.bets.values()].map(b => ({
        username: b.username, avatar: b.avatar, userId: b.userId,
        amount: b.amount, cashedOut: b.cashedOut, cashoutMult: b.cashoutMult,
      }));
      broadcast({ type: 'tick', multiplier: mult, bets: liveBets });
    }

    G.phase = 'crashed';
    const roundBets = [];
    for (const [userId, b] of G.bets) {
      if (!b.cashedOut && db) {
        try {
          const u = await db.findOne({ id: userId });
          if (u) { u.coins = Math.max(0, Number(u.coins || 0) - b.amount); u.status_playing = 'no'; await u.save(); }
        } catch (_) {}
      }
      roundBets.push({
        username: b.username, avatar: b.avatar, userId: b.userId,
        amount: b.amount, cashedOut: b.cashedOut,
        cashoutMult: b.cashoutMult || G.crashPoint,
        profit: b.cashedOut ? Math.floor(b.amount * b.cashoutMult - b.amount) : -b.amount,
      });
    }
    G.history.unshift({ roundId: G.roundId, crashPoint: G.crashPoint });
    if (G.history.length > 25) G.history.pop();
    broadcast({ type: 'crashed', multiplier: G.crashPoint, roundId: G.roundId, bets: roundBets });
    G.roundId++;
    await sleep(CRASH_SHOW);
  }
}

// ══════════════════════════════════════════════════════════
//  ROUTES
// ══════════════════════════════════════════════════════════
const setupCrashRoutes = function setupCrashRoutes(app, { db, siteLog, layout }) {

  gameLoop(db).catch(e => {
    console.error('[Crash] Loop error:', e.message);
    setTimeout(() => gameLoop(db), 5000);
  });

  // Dedicated CSRF for crash — isolated from main site's csrf key
  function verifyCsrf(req, res, next) {
    const token = req.headers['x-csrf-token'] || req.body?.csrfToken;
    if (!req.session?.crashCsrf || !token || token !== req.session.crashCsrf)
      return res.status(403).json({ error: 'CSRF token invalid' });
    req.session.crashCsrf = crypto.randomBytes(32).toString('hex');
    next();
  }

  // ── GET /crash ────────────────────────────────────────────
  app.get('/crash', (req, res) => {
    const user = req.session?.user || null;

    const extraHead = `
<style>
:root{--cp:#8b5cf6;--cg:#22c55e;--cr:#ef4444;--cy:#eab308;}
.crash-root{display:flex;gap:16px;min-height:calc(100vh - 140px);}
.crash-main{flex:1;display:flex;flex-direction:column;gap:12px;min-width:0;}
.crash-canvas-wrap{
  position:relative;flex:1;min-height:320px;
  background:#06030f;border-radius:16px;
  border:1px solid rgba(139,92,246,.2);overflow:hidden;
}
#cCnv{width:100%;height:100%;display:block;}
.crash-overlay{
  position:absolute;top:50%;left:50%;
  transform:translate(-50%,-50%);
  text-align:center;pointer-events:none;
}
.crash-mult{
  font-size:80px;font-weight:900;line-height:1;
  letter-spacing:-3px;text-shadow:0 0 50px currentColor;
  transition:color .1s;
}
.crash-mult-label{font-size:12px;font-weight:700;letter-spacing:4px;text-transform:uppercase;opacity:.55;margin-top:6px;}
.crash-round-tag{position:absolute;top:14px;left:14px;font-size:11px;color:rgba(255,255,255,.2);font-weight:600;letter-spacing:1px;}
.crash-phase-tag{
  position:absolute;top:14px;right:14px;
  padding:4px 14px;border-radius:20px;
  font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;
}
.crash-phase-tag.waiting{background:rgba(234,179,8,.15);color:#eab308;border:1px solid rgba(234,179,8,.35);}
.crash-phase-tag.flying{background:rgba(139,92,246,.15);color:#a78bfa;border:1px solid rgba(139,92,246,.4);}
.crash-phase-tag.crashed{background:rgba(239,68,68,.15);color:#ef4444;border:1px solid rgba(239,68,68,.4);}
.crash-hist-bar{display:flex;gap:6px;overflow-x:auto;padding:6px 0;scrollbar-width:thin;scrollbar-color:rgba(139,92,246,.3) transparent;}
.crash-hist-badge{padding:4px 10px;border-radius:20px;font-size:12px;font-weight:700;white-space:nowrap;border:1px solid;flex-shrink:0;animation:chFade .3s ease;}
.crash-hist-badge.low{background:rgba(239,68,68,.12);border-color:#ef4444;color:#ef4444;}
.crash-hist-badge.mid{background:rgba(234,179,8,.12);border-color:#eab308;color:#eab308;}
.crash-hist-badge.high{background:rgba(34,197,94,.12);border-color:#22c55e;color:#22c55e;}
.crash-hist-badge.mega{background:rgba(139,92,246,.12);border-color:#8b5cf6;color:#8b5cf6;}
.crash-side{width:290px;flex-shrink:0;display:flex;flex-direction:column;gap:12px;}
.crash-panel{background:var(--card,#151d2f);border-radius:16px;border:1px solid rgba(255,255,255,.06);padding:20px;}
.crash-panel-title{font-size:11px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:rgba(255,255,255,.35);margin:0 0 16px;}
.crash-bal{font-size:13px;color:rgba(255,255,255,.4);text-align:center;margin-bottom:12px;}
.crash-bal strong{color:#22c55e;font-size:16px;}
.crash-quick{display:flex;gap:5px;margin-bottom:10px;}
.crash-quick button{flex:1;padding:6px 0;border-radius:8px;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.04);color:#fff;font-size:11px;font-weight:700;cursor:pointer;transition:all .15s;}
.crash-quick button:hover{background:rgba(139,92,246,.25);border-color:#8b5cf6;}
#cBetInput{width:100%;padding:12px;border-radius:10px;border:1px solid rgba(139,92,246,.3);background:rgba(0,0,0,.35);color:#fff;font-size:20px;font-weight:800;text-align:center;box-sizing:border-box;margin-bottom:10px;outline:none;}
#cBetInput:focus{border-color:#8b5cf6;box-shadow:0 0 0 3px rgba(139,92,246,.15);}
#cBetBtn{width:100%;padding:14px;border-radius:12px;border:none;font-size:16px;font-weight:800;cursor:pointer;letter-spacing:.5px;transition:all .2s;}
#cBetBtn.bet{background:linear-gradient(135deg,#8b5cf6,#6d28d9);color:#fff;box-shadow:0 4px 24px rgba(139,92,246,.4);}
#cBetBtn.bet:hover:not(:disabled){transform:translateY(-2px);box-shadow:0 6px 30px rgba(139,92,246,.55);}
#cBetBtn.cashout{background:linear-gradient(135deg,#22c55e,#15803d);color:#fff;box-shadow:0 4px 24px rgba(34,197,94,.4);animation:pGreen 1s infinite;}
#cBetBtn.cashout:hover:not(:disabled){transform:translateY(-2px);}
#cBetBtn.placed{background:rgba(34,197,94,.12);color:#22c55e;border:1px solid rgba(34,197,94,.3);cursor:default;}
#cBetBtn:disabled{opacity:.4;cursor:not-allowed;transform:none!important;animation:none!important;box-shadow:none!important;}
@keyframes pGreen{0%,100%{box-shadow:0 4px 24px rgba(34,197,94,.4);}50%{box-shadow:0 4px 36px rgba(34,197,94,.7);}}
.crash-cashout-hint{text-align:center;font-size:12px;color:rgba(255,255,255,.35);min-height:18px;margin-top:8px;}
.crash-auto-wrap{display:flex;align-items:center;gap:8px;margin-bottom:10px;background:rgba(0,0,0,.2);border:1px solid rgba(255,255,255,.06);border-radius:10px;padding:8px 12px;}
.crash-auto-wrap label{font-size:11px;color:rgba(255,255,255,.35);font-weight:600;white-space:nowrap;flex:1;}
#cAutoInput{width:72px;padding:5px 8px;border-radius:7px;border:1px solid rgba(139,92,246,.3);background:rgba(0,0,0,.4);color:#fff;font-size:13px;font-weight:700;text-align:center;outline:none;}
#cAutoInput:focus{border-color:#8b5cf6;}
.crash-auto-badge{font-size:10px;padding:2px 7px;border-radius:10px;background:rgba(234,179,8,.12);color:#eab308;border:1px solid rgba(234,179,8,.3);font-weight:700;white-space:nowrap;}
.crash-cashout-hint.live{color:#22c55e;font-weight:700;font-size:13px;}
.crash-bets-wrap{flex:1;overflow-y:auto;scrollbar-width:thin;scrollbar-color:rgba(139,92,246,.2) transparent;}
.crash-bet-row{display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.04);font-size:13px;}
.crash-bet-row.new-row{animation:chFade .25s ease;}
.crash-bet-row img{width:28px;height:28px;border-radius:50%;object-fit:cover;flex-shrink:0;}
.crash-bet-name{flex:1;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.crash-bet-amt{font-size:12px;color:rgba(255,255,255,.45);font-weight:600;flex-shrink:0;}
.crash-bet-st{font-size:12px;font-weight:800;min-width:52px;text-align:right;flex-shrink:0;}
.crash-bet-st.won{color:#22c55e;} .crash-bet-st.lost{color:#ef4444;} .crash-bet-st.live{color:#eab308;} .crash-bet-st.wait{color:rgba(255,255,255,.3);}
@keyframes chFade{from{opacity:0;transform:translateY(4px);}to{opacity:1;transform:none;}}
@media(max-width:800px){.crash-root{flex-direction:column;}.crash-side{width:100%;}.crash-mult{font-size:56px;}}
</style>`;

    const histHtml = G.history.map(h => {
      const cls = h.crashPoint >= 10 ? 'mega' : h.crashPoint >= 3 ? 'high' : h.crashPoint >= 2 ? 'mid' : 'low';
      return `<div class="crash-hist-badge ${cls}">${h.crashPoint.toFixed(2)}×</div>`;
    }).join('');

    const content = `
<div class="crash-root">
  <div class="crash-main">
    <div class="crash-canvas-wrap">
      <canvas id="cCnv"></canvas>
      <div class="crash-round-tag" id="cRound">جولة #${G.roundId}</div>
      <div class="crash-phase-tag waiting" id="cPhase">انتظار</div>
      <div class="crash-overlay">
        <div class="crash-mult" id="cMult" style="color:#a78bfa">1.00×</div>
        <div class="crash-mult-label" id="cMultLbl">جاري الانتظار...</div>
      </div>
    </div>
    <div class="crash-hist-bar" id="cHistBar">${histHtml}</div>
  </div>
  <div class="crash-side">
    <div class="crash-panel">
      <p class="crash-panel-title">المراهنة</p>
      ${user ? `
      <div class="crash-bal">رصيدك: <strong id="cBal">—</strong></div>
      <div class="crash-quick">
        <button onclick="qAdd(100)">+100</button>
        <button onclick="qAdd(1000)">+1K</button>
        <button onclick="qAdd(5000)">+5K</button>
        <button onclick="qHalf()">½</button>
        <button onclick="qDouble()">×2</button>
      </div>
      <input type="number" id="cBetInput" value="500" min="100">
      <div class="crash-auto-wrap">
        <label>خروج تلقائي عند</label>
        <input type="number" id="cAutoInput" placeholder="1.50" min="1.01" max="14.99" step="0.01">
        <span class="crash-auto-badge">×</span>
      </div>
      <button id="cBetBtn" class="bet" onclick="onBetBtn()">راهن الآن</button>
      <div class="crash-cashout-hint" id="cHint"></div>
      ` : `
      <div style="text-align:center;padding:24px 0">
        <p style="color:rgba(255,255,255,.4);font-size:14px;margin-bottom:16px">سجّل دخولك للمراهنة</p>
        <a href="/auth/discord" style="display:inline-block;padding:11px 26px;background:linear-gradient(135deg,#8b5cf6,#6d28d9);border-radius:10px;color:#fff;font-weight:700;text-decoration:none">تسجيل الدخول</a>
      </div>
      `}
    </div>
    <div class="crash-panel" style="flex:1;display:flex;flex-direction:column;min-height:0;overflow:hidden">
      <p class="crash-panel-title">الرهانات الحية</p>
      <div class="crash-bets-wrap" id="cBetsList">
        <div class="empty-bets" style="color:rgba(255,255,255,.25);font-size:13px;text-align:center;padding:20px 0">لا توجد رهانات بعد</div>
      </div>
    </div>
  </div>
</div>

<script>
// ── Constants ──────────────────────────────────────────────
const IS_USER = ${user ? 'true' : 'false'};

// Client-side multiplier — MUST match server formula exactly
function clientCalcMult(elapsedMs) {
  return Math.pow(1.005, elapsedMs / 100);
}

// ── State ──────────────────────────────────────────────────
let phase    = '${G.phase}';
let myBet    = null;        // { amount, cashedOut, cashoutMult }
let liveBets = new Map();   // userId → bet
let gameStart = null;
let curMult  = 1.00;
let multRafId = null;       // rAF id for 60fps counter

// ── Canvas ─────────────────────────────────────────────────
const cnv = document.getElementById('cCnv');
const ctx  = cnv.getContext('2d');
let W, H, raf;
const trail = [];
let explodeF = 0;

function resize() { const w = cnv.parentElement; W = cnv.width = w.clientWidth; H = cnv.height = w.clientHeight; }
window.addEventListener('resize', resize);
resize();

function multToY(m) {
  // Log scale capped at 15x so the curve fills the canvas nicely
  const logMax = Math.log(16);
  return H - 60 - Math.min(H - 100, (Math.log(Math.max(1, m)) / logMax) * (H - 90));
}
function elapsedToX(ms) {
  // 15x reached in ~50s → use 55s as full-width reference
  const MAX = 55000;
  return 55 + Math.min(W - 80, (ms / MAX) * (W - 80));
}

// ── Draw Plane ─────────────────────────────────────────────
function drawPlane(x, y, crashed) {
  ctx.save();
  if (crashed) {
    for (let i = 0; i < 12; i++) {
      const ang = (i/12)*Math.PI*2, r = explodeF*3.5;
      const alpha = Math.max(0, 1 - explodeF/18);
      ctx.beginPath();
      ctx.arc(x+Math.cos(ang)*r, y+Math.sin(ang)*r, 9-explodeF*0.4, 0, Math.PI*2);
      ctx.fillStyle = \`rgba(239,68,68,\${alpha})\`;
      ctx.fill();
    }
    ctx.restore(); return;
  }
  const last2 = trail.slice(-2);
  let ang = -0.4;
  if (last2.length===2) ang = Math.atan2(last2[1].y-last2[0].y, last2[1].x-last2[0].x);
  ctx.translate(x,y); ctx.rotate(ang); ctx.scale(1.5,1.5);
  ctx.fillStyle='#c4b5fd'; ctx.beginPath(); ctx.ellipse(0,0,22,8,0,0,Math.PI*2); ctx.fill();
  ctx.fillStyle='#a78bfa'; ctx.beginPath(); ctx.moveTo(22,0); ctx.lineTo(32,-3); ctx.lineTo(32,3); ctx.closePath(); ctx.fill();
  ctx.fillStyle='#8b5cf6'; ctx.beginPath(); ctx.moveTo(0,-8); ctx.lineTo(-14,-24); ctx.lineTo(-18,-8); ctx.closePath(); ctx.fill();
  ctx.fillStyle='#7c3aed'; ctx.beginPath(); ctx.moveTo(0,8); ctx.lineTo(-10,16); ctx.lineTo(-14,8); ctx.closePath(); ctx.fill();
  ctx.fillStyle='#6d28d9'; ctx.beginPath(); ctx.moveTo(-22,0); ctx.lineTo(-30,-10); ctx.lineTo(-22,-3); ctx.closePath(); ctx.fill();
  ctx.fillStyle='rgba(125,211,252,.85)'; ctx.beginPath(); ctx.ellipse(10,-2,6,4,0,0,Math.PI*2); ctx.fill();
  const eg=ctx.createLinearGradient(-22,0,-55,0); eg.addColorStop(0,'rgba(167,139,250,.9)'); eg.addColorStop(1,'transparent');
  ctx.fillStyle=eg; ctx.beginPath(); ctx.ellipse(-38,0,16,4,0,0,Math.PI*2); ctx.fill();
  ctx.restore();
}

// ── Render loop ────────────────────────────────────────────
function render() {
  ctx.clearRect(0,0,W,H);
  const bg=ctx.createLinearGradient(0,0,0,H); bg.addColorStop(0,'#06030f'); bg.addColorStop(1,'#0a0420');
  ctx.fillStyle=bg; ctx.fillRect(0,0,W,H);
  ctx.strokeStyle='rgba(139,92,246,.06)'; ctx.lineWidth=1;
  for(let gx=55;gx<W;gx+=70){ctx.beginPath();ctx.moveTo(gx,0);ctx.lineTo(gx,H);ctx.stroke();}
  for(let gy=0;gy<H;gy+=55){ctx.beginPath();ctx.moveTo(0,gy);ctx.lineTo(W,gy);ctx.stroke();}
  for(let i=0;i<55;i++){
    const sx=(i*137.5)%W,sy=(i*89.3)%H;
    ctx.fillStyle=\`rgba(255,255,255,\${.1+(i%3)*.1})\`;
    ctx.beginPath();ctx.arc(sx,sy,.9,0,Math.PI*2);ctx.fill();
  }
  if(phase==='waiting'){drawPlane(60,H-80,false);raf=requestAnimationFrame(render);return;}
  if(trail.length>1){
    const isCr=(phase==='crashed');
    ctx.beginPath();ctx.moveTo(trail[0].x,H-40);trail.forEach(p=>ctx.lineTo(p.x,p.y));ctx.lineTo(trail[trail.length-1].x,H-40);ctx.closePath();
    const fill=ctx.createLinearGradient(0,0,0,H);fill.addColorStop(0,isCr?'rgba(239,68,68,.18)':'rgba(139,92,246,.18)');fill.addColorStop(1,'transparent');
    ctx.fillStyle=fill;ctx.fill();
    ctx.beginPath();ctx.moveTo(trail[0].x,trail[0].y);trail.forEach(p=>ctx.lineTo(p.x,p.y));
    const sg=ctx.createLinearGradient(trail[0].x,0,trail[trail.length-1].x,0);
    sg.addColorStop(0,isCr?'rgba(239,68,68,.3)':'rgba(139,92,246,.3)');sg.addColorStop(1,isCr?'#ef4444':'#a78bfa');
    ctx.strokeStyle=sg;ctx.lineWidth=3;ctx.lineJoin='round';ctx.lineCap='round';ctx.stroke();
  }
  if(trail.length>0){
    const last=trail[trail.length-1];
    if(phase==='crashed'){explodeF++;drawPlane(last.x,last.y,true);if(explodeF<22)raf=requestAnimationFrame(render);}
    else{drawPlane(last.x,last.y,false);raf=requestAnimationFrame(render);}
  }else{raf=requestAnimationFrame(render);}
}
cancelAnimationFrame(raf); render();

// ── 60fps multiplier counter ───────────────────────────────
function startMultRaf() {
  cancelAnimationFrame(multRafId);
  function frame() {
    if (phase !== 'flying' || !gameStart) return;
    const elapsed = Date.now() - gameStart;
    const m = clientCalcMult(elapsed);
    curMult = m;
    const mv = el('cMult');
    if (mv) {
      // speed up decimal places shown as it gets bigger
      const decimals = m < 10 ? 2 : m < 100 ? 1 : 0;
      mv.textContent = m.toFixed(decimals) + '×';
      mv.style.color = m < 2 ? '#a78bfa' : m < 5 ? '#eab308' : '#22c55e';
    }
    updateHint();
    updateBetStatuses();
    multRafId = requestAnimationFrame(frame);
  }
  multRafId = requestAnimationFrame(frame);
}

// ── SSE ─────────────────────────────────────────────────────
function connectSSE() {
  const es = new EventSource('/crash/sse');
  es.onmessage = e => { try { handle(JSON.parse(e.data)); } catch(_){} };
  es.onerror   = () => { es.close(); setTimeout(connectSSE, 3000); };
}

function handle(d) {
  switch (d.type) {
    case 'waiting':   return onWaiting(d);
    case 'countdown': return onCountdown(d);  // ← separate! does NOT clear bet
    case 'start':     return onStart(d);
    case 'tick':      return onTick(d);
    case 'crashed':   return onCrashed(d);
    case 'bet':       return onBetEvent(d);
    case 'cashout':   return onCashoutEvent(d);
  }
}

// ── Phase handlers ──────────────────────────────────────────
function onWaiting(d) {
  phase = 'waiting'; curMult = 1.00;
  trail.length = 0; explodeF = 0;
  liveBets = new Map(); myBet = null; gameStart = null;
  cancelAnimationFrame(multRafId); multRafId = null;
  cancelAnimationFrame(raf); render();
  setPhase('waiting', d.countdown);
  setMult(1.00, 'waiting');
  renderBets();
  syncBtn(); setHint('');
  el('cRound').textContent = 'جولة #' + d.roundId;
}

function onCountdown(d) {
  // Only update the countdown display — do NOT clear myBet or reset game state
  setPhase('waiting', d.countdown);
}

function onStart(d) {
  phase = 'flying'; gameStart = Date.now();
  trail.length = 0; explodeF = 0;
  cancelAnimationFrame(raf); render();
  setPhase('flying', null);
  setMult(1.00, 'flying');
  syncBtn();   // ← switches button to cashout if myBet is set
  el('cRound').textContent = 'جولة #' + d.roundId;
  startMultRaf();  // ← 60fps smooth counter
}

function onTick(d) {
  // Update trail position from server multiplier (for canvas curve accuracy)
  if (gameStart) {
    const elapsed = Date.now() - gameStart;
    const x = elapsedToX(elapsed), y = multToY(d.multiplier);
    if (!trail.length || x > trail[trail.length-1].x) {
      trail.push({x,y});
      if (trail.length > 800) trail.shift();
    }
  }
  // Sync bet list WITHOUT re-rendering DOM (avoids bounce animation)
  if (d.bets) {
    let changed = false;
    d.bets.forEach(b => {
      const existing = liveBets.get(b.userId);
      if (!existing) { liveBets.set(b.userId, b); changed = true; }
      else if (existing.cashedOut !== b.cashedOut) {
        liveBets.set(b.userId, { ...existing, ...b });
        changed = true;
      }
    });
    if (changed) renderBets();
    // else just update status text in-place (no DOM rebuild, no animation)
  }
}

function onCrashed(d) {
  phase = 'crashed'; explodeF = 0;
  cancelAnimationFrame(multRafId); multRafId = null;
  cancelAnimationFrame(raf); render();
  setPhase('crashed', null);
  setMult(d.multiplier, 'crashed');
  if (d.bets) {
    liveBets = new Map();
    d.bets.forEach(b => liveBets.set(b.userId, b));
    renderBets();
  }
  if (myBet && !myBet.cashedOut) myBet = null;
  syncBtn(); setHint('');
  addHistBadge(d.roundId, d.multiplier);
  loadBalance();
}

function onBetEvent(d) {
  // Another player placed a bet — add to list with animation
  if (!liveBets.has(d.userId)) {
    liveBets.set(d.userId, d);
    renderBets();
  }
}

function onCashoutEvent(d) {
  const b = liveBets.get(d.userId);
  if (b) {
    b.cashedOut = true; b.cashoutMult = d.cashoutMult;
    // Update just the status cell in-place
    const row = document.querySelector(\`.crash-bet-row[data-uid="\${d.userId}"]\`);
    if (row) {
      const st = row.querySelector('.crash-bet-st');
      if (st) { st.className='crash-bet-st won'; st.textContent=d.cashoutMult.toFixed(2)+'×'; }
    }
  }
}

// ── In-place status update (no re-render, no bounce) ───────
function updateBetStatuses() {
  document.querySelectorAll('.crash-bet-row').forEach(row => {
    const uid = row.dataset.uid;
    const b   = liveBets.get(uid);
    const st  = row.querySelector('.crash-bet-st');
    if (!st || !b || b.cashedOut) return; // won rows stay fixed
    if (phase === 'flying') {
      st.className = 'crash-bet-st live';
      const decimals = curMult < 10 ? 2 : 1;
      st.textContent = curMult.toFixed(decimals) + '×';
    }
  });
}

// ── UI helpers ─────────────────────────────────────────────
function el(id) { return document.getElementById(id); }

function setMult(m, p) {
  const mv=el('cMult'), ml=el('cMultLbl');
  const decimals = m < 10 ? 2 : m < 100 ? 1 : 0;
  mv.textContent = m.toFixed(decimals) + '×';
  if (p==='crashed'){mv.style.color='#ef4444';ml.textContent='CRASHED!';}
  else if(p==='waiting'){mv.style.color='#a78bfa';ml.textContent='جاري الانتظار...';}
  else{mv.style.color=m<2?'#a78bfa':m<5?'#eab308':'#22c55e';ml.textContent='في الطيران ✈';}
}

function setPhase(p, cd) {
  const badge=el('cPhase');
  badge.className='crash-phase-tag '+p;
  badge.textContent=p==='waiting'?(cd>0?cd+'s':'انتظار'):p==='flying'?'طائر ✈':'CRASHED!';
}

function renderBets() {
  const list=el('cBetsList');
  if(!liveBets.size){
    list.innerHTML='<div class="empty-bets" style="color:rgba(255,255,255,.25);font-size:13px;text-align:center;padding:20px 0">لا توجد رهانات بعد</div>';
    return;
  }
  // Build HTML — rows only get the new-row animation class on first appearance
  let html='';
  for(const[,b] of liveBets){
    let cls='wait',txt='...';
    if(b.cashedOut){cls='won';txt=(b.cashoutMult||1).toFixed(2)+'×';}
    else if(phase==='crashed'){cls='lost';txt='خسر';}
    else if(phase==='flying'){cls='live';txt=curMult.toFixed(2)+'×';}
    const av=b.avatar?\`https://cdn.discordapp.com/avatars/\${b.userId}/\${b.avatar}.png?size=32\`:'/pfp.png';
    const isNew=!document.querySelector(\`.crash-bet-row[data-uid="\${b.userId}"]\`);
    html+=\`<div class="crash-bet-row\${isNew?' new-row':''}" data-uid="\${b.userId}">
      <img src="\${av}" onerror="this.src='/pfp.png'">
      <span class="crash-bet-name">\${b.username}</span>
      <span class="crash-bet-amt">\${Number(b.amount).toLocaleString()}</span>
      <span class="crash-bet-st \${cls}">\${txt}</span>
    </div>\`;
  }
  list.innerHTML=html;
}

function addHistBadge(roundId, cp) {
  const bar=el('cHistBar');
  const cls=cp>=10?'mega':cp>=3?'high':cp>=2?'mid':'low';
  const d=document.createElement('div');
  d.className='crash-hist-badge '+cls; d.textContent=cp.toFixed(2)+'×';
  bar.prepend(d);
  while(bar.children.length>25) bar.removeChild(bar.lastChild);
}

function syncBtn() {
  const btn=el('cBetBtn'); if(!btn) return;
  if(phase==='flying' && myBet && !myBet.cashedOut){
    btn.className='cashout'; btn.textContent='اخرج الآن!'; btn.disabled=false;
  } else if(phase==='flying' && myBet && myBet.cashedOut){
    btn.className='placed'; btn.textContent='تم الخروج ✓'; btn.disabled=true;
  } else if(phase==='waiting' && myBet){
    btn.className='placed'; btn.textContent='رهانك مسجل ✓'; btn.disabled=true;
  } else if(phase==='flying'){
    btn.className='bet'; btn.textContent='راهن الآن'; btn.disabled=true;
  } else {
    btn.className='bet'; btn.textContent='راهن الآن'; btn.disabled=false;
  }
}

function updateHint() {
  if(!myBet||myBet.cashedOut||phase!=='flying'){setHint('');return;}
  const payout=Math.floor(myBet.amount*curMult);
  setHint(payout.toLocaleString()+' عملة إذا خرجت الآن',true);
}
function setHint(txt,live){
  const h=el('cHint'); if(!h) return;
  h.textContent=txt; h.className='crash-cashout-hint'+(live?' live':'');
}

// ── Balance ────────────────────────────────────────────────
async function loadBalance() {
  if(!IS_USER) return;
  try{
    const r=await fetch('/crash/balance',{credentials:'same-origin'});
    const d=await r.json();
    const e=el('cBal'); if(e) e.textContent=Number(d.coins||0).toLocaleString('en-US')+' عملة';
  }catch(_){}
}

// ── Dedicated crash CSRF — isolated from main site ─────────
async function getCsrf() {
  const r=await fetch('/crash/csrf-token',{credentials:'same-origin'});
  const d=await r.json();
  return d.token;
}

// ── Quick-bet helpers ──────────────────────────────────────
function qAdd(n){const i=el('cBetInput');i.value=Math.max(100,(parseInt(i.value)||0)+n);}
function qHalf(){const i=el('cBetInput');i.value=Math.max(100,Math.floor((parseInt(i.value)||200)/2));}
function qDouble(){const i=el('cBetInput');i.value=Math.min(50000000,(parseInt(i.value)||100)*2);}

// ── Bet/cashout handlers ───────────────────────────────────
async function onBetBtn() {
  if(!IS_USER) return location.href='/auth/discord';
  const btn=el('cBetBtn');
  if(btn.classList.contains('cashout')){await doCashout();return;}
  if(phase!=='waiting'||myBet) return;
  const amount=parseInt(el('cBetInput').value);
  if(!amount||amount<100) return toast('الحد الأدنى للرهان 100 عملة','error');
  btn.disabled=true;
  try{
    const token=await getCsrf();
    const autoVal=parseFloat(el('cAutoInput')?.value)||null;
    const r=await fetch('/crash/bet',{
      method:'POST',credentials:'same-origin',
      headers:{'Content-Type':'application/json','x-csrf-token':token},
      body:JSON.stringify({amount, autoCashout: autoVal}),
    });
    const d=await r.json();
    if(d.error){btn.disabled=false;return toast(d.error,'error');}
    myBet={amount,cashedOut:false};
    syncBtn(); loadBalance();
    toast('رهانك مسجل!','success');
  }catch(_){btn.disabled=false;toast('خطأ في الاتصال','error');}
}

async function doCashout() {
  if(phase!=='flying'||!myBet||myBet.cashedOut) return;
  const btn=el('cBetBtn'); btn.disabled=true;
  try{
    const token=await getCsrf();
    const r=await fetch('/crash/cashout',{
      method:'POST',credentials:'same-origin',
      headers:{'Content-Type':'application/json','x-csrf-token':token},
      body:JSON.stringify({}),
    });
    const d=await r.json();
    if(d.error){btn.disabled=false;return toast(d.error,'error');}
    myBet.cashedOut=true; myBet.cashoutMult=d.cashoutMult;
    syncBtn(); setHint(''); loadBalance();
    toast('ربحت '+Math.floor(d.payout).toLocaleString()+' عملة عند '+d.cashoutMult+'×!','success');
  }catch(_){btn.disabled=false;toast('خطأ في الاتصال','error');}
}

function toast(msg,type){
  const c=document.getElementById('toast-container'); if(!c) return;
  const t=document.createElement('div');
  t.className='toast '+(type==='error'?'toast-error':'toast-success');
  t.textContent=msg; c.appendChild(t);
  setTimeout(()=>t.remove(),3500);
}

// ── Boot ───────────────────────────────────────────────────
connectSSE();
loadBalance();
</script>`;

    res.send(layout('Crash', content, '/crash', user, extraHead));
  });

  // ── GET /crash/csrf-token — dedicated, isolated ───────────
  app.get('/crash/csrf-token', (req, res) => {
    if (!req.session) return res.status(500).json({ error: 'No session' });
    if (!req.session.crashCsrf) {
      req.session.crashCsrf = crypto.randomBytes(32).toString('hex');
    }
    res.json({ token: req.session.crashCsrf });
  });

  // ── GET /crash/sse ────────────────────────────────────────
  app.get('/crash/sse', (req, res) => {
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.flushHeaders();
    sseClients.add(res);
    const snapshot = {
      type:       G.phase === 'waiting' ? 'waiting' : G.phase === 'flying' ? 'tick' : 'crashed',
      countdown:  G.phase === 'waiting' ? Math.max(0, Math.ceil((G.waitUntil - Date.now()) / 1000)) : undefined,
      multiplier: G.multiplier,
      roundId:    G.roundId,
      bets:       [...G.bets.values()].map(b => ({
        username: b.username, avatar: b.avatar, userId: b.userId,
        amount: b.amount, cashedOut: b.cashedOut, cashoutMult: b.cashoutMult,
      })),
    };
    try { res.write(`data: ${JSON.stringify(snapshot)}\n\n`); } catch (_) {}
    req.on('close', () => sseClients.delete(res));
  });

  // ── GET /crash/balance ────────────────────────────────────
  app.get('/crash/balance', async (req, res) => {
    if (!req.session?.user) return res.json({ coins: 0 });
    try {
      const u = await db.findOne({ id: req.session.user.id });
      res.json({ coins: Number(u?.coins || 0) });
    } catch (_) { res.json({ coins: 0 }); }
  });

  // ── POST /crash/bet ───────────────────────────────────────
  app.post('/crash/bet', verifyCsrf, async (req, res) => {
    if (!req.session?.user) return res.status(401).json({ error: 'تسجيل الدخول مطلوب' });
    if (G.phase !== 'waiting') return res.status(400).json({ error: 'لا يمكن المراهنة الآن، انتظر الجولة التالية' });
    const userId = req.session.user.id;
    if (G.bets.has(userId)) return res.status(400).json({ error: 'لقد راهنت في هذه الجولة بالفعل' });
    const amount = parseInt(req.body.amount);
    if (!amount || amount < 100) return res.status(400).json({ error: 'الحد الأدنى للرهان 100 عملة' });
    if (amount > 50_000_000)     return res.status(400).json({ error: 'الحد الأقصى للرهان 50,000,000 عملة' });
    const autoCashout = parseFloat(req.body.autoCashout) || null;
    const validAuto   = autoCashout && autoCashout >= 1.01 && autoCashout <= 14.99 ? autoCashout : null;

    try {
      const u = await db.findOne({ id: userId });
      if (!u) return res.status(400).json({ error: 'لم يتم العثور على حسابك' });
      if (u.status_playing === 'yes') return res.status(400).json({ error: 'لديك لعبة أخرى نشطة الآن' });
      const bal = Number(u.coins || 0);
      if (bal < amount) return res.status(400).json({ error: 'رصيدك غير كافٍ' });
      u.coins = bal - amount;
      u.status_playing = 'yes';
      await u.save();
      const user = req.session.user;
      G.bets.set(userId, { userId, username: user.username, avatar: user.avatar || null, amount, cashedOut: false, cashoutMult: null, autoCashout: validAuto });
      broadcast({ type: 'bet', userId, username: user.username, avatar: user.avatar || null, amount });
      res.json({ ok: true });
    } catch (e) {
      console.error('[Crash/bet]', e);
      res.status(500).json({ error: 'خطأ في الخادم' });
    }
  });

  // ── POST /crash/cashout ───────────────────────────────────
  app.post('/crash/cashout', verifyCsrf, async (req, res) => {
    if (!req.session?.user) return res.status(401).json({ error: 'تسجيل الدخول مطلوب' });
    if (G.phase !== 'flying')    return res.status(400).json({ error: 'لا يمكن الخروج الآن' });
    const userId = req.session.user.id;
    const bet    = G.bets.get(userId);
    if (!bet)          return res.status(400).json({ error: 'لا يوجد رهان لك في هذه الجولة' });
    if (bet.cashedOut) return res.status(400).json({ error: 'لقد خرجت من الجولة بالفعل' });
    const cashoutMult = G.multiplier;
    const payout      = Math.floor(bet.amount * cashoutMult);
    bet.cashedOut = true; bet.cashoutMult = cashoutMult;
    try {
      const u = await db.findOne({ id: userId });
      if (u) { u.coins = Number(u.coins || 0) + payout; u.status_playing = 'no'; await u.save(); }
      broadcast({ type: 'cashout', userId, username: bet.username, avatar: bet.avatar, cashoutMult, payout, profit: payout - bet.amount });
      if (siteLog) siteLog('✈ Crash — خروج', `**${bet.username}** خرج عند **${cashoutMult}×** وربح **${payout.toLocaleString()}** عملة`, '#22c55e').catch(() => {});
      res.json({ ok: true, cashoutMult, payout });
    } catch (e) {
      console.error('[Crash/cashout]', e);
      res.status(500).json({ error: 'خطأ في الخادم' });
    }
  });

  // ── GET /crash/history ────────────────────────────────────
  app.get('/crash/history', (req, res) => { res.json(G.history); });
};

setupCrashRoutes.getState = function () {
  return {
    phase:      G.phase,
    multiplier: G.multiplier,
    bets:       G.bets.size,
    history:    G.history.slice(0, 5),
    crashPoint: G.phase === 'crashed' ? G.crashPoint : null,
  };
};

module.exports = setupCrashRoutes;
