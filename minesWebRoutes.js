"use strict";
const crypto = require("crypto");

const TOTAL_TILES = 25;
const HOUSE_EDGE = 0.01;

// ── Multiplier (Stake-style combinatorics) ────────────────
function calcMult(mines, revealed) {
  if (revealed === 0) return 1.0;
  const n = TOTAL_TILES,
    m = mines;
  let p = 1;
  for (let i = 0; i < revealed; i++) {
    p *= (n - m - i) / (n - i);
  }
  return Math.floor((1 / p) * (1 - HOUSE_EDGE) * 100) / 100;
}

function nextMult(mines, revealed) {
  return calcMult(mines, revealed + 1);
}

// ── Sessions ───────────────────────────────────────────────
const sessions = new Map();
const botSessions = new Map();
const recentGames = [];
const userBets = new Map(); // userId → last 15 bets

function createBotSession(userId, amount, discordChannelId) {
  const token = crypto.randomBytes(20).toString("hex");
  botSessions.set(token, {
    userId,
    amount,
    discordChannelId,
    createdAt: Date.now(),
  });
  setTimeout(() => botSessions.delete(token), 15 * 60_000);
  return token;
}

function addUserBet(userId, bet) {
  const arr = userBets.get(userId) || [];
  arr.unshift(bet);
  if (arr.length > 15) arr.length = 15;
  userBets.set(userId, arr);
}

function genGrid(mines) {
  const idx = Array.from({ length: TOTAL_TILES }, (_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  const bombs = new Set(idx.slice(0, mines));
  return Array.from({ length: TOTAL_TILES }, (_, i) => bombs.has(i));
}

// ── Route setup ────────────────────────────────────────────
const routeSetup = function setupMinesRoutes(app, { db, siteLog, layout }) {
  function verifyCsrf(req, res, next) {
    const t = req.headers["x-csrf-token"] || req.body?.csrfToken;
    if (!req.session?.minesCsrf || !t || t !== req.session.minesCsrf)
      return res.status(403).json({ error: "CSRF token invalid" });
    req.session.minesCsrf = crypto.randomBytes(32).toString("hex");
    next();
  }

  // ── GET /mines/csrf ──────────────────────────────────────
  app.get("/mines/csrf", (req, res) => {
    if (!req.session) return res.status(403).json({ error: "no session" });
    if (!req.session.minesCsrf)
      req.session.minesCsrf = crypto.randomBytes(32).toString("hex");
    res.json({ token: req.session.minesCsrf });
  });

  // ── GET /mines/balance ───────────────────────────────────
  app.get("/mines/balance", async (req, res) => {
    if (!req.session?.user) return res.json({ coins: 0 });
    try {
      const u = await db.findOne({ id: req.session.user.id });
      res.json({ coins: Number(u?.coins || 0) });
    } catch (_) {
      res.json({ coins: 0 });
    }
  });

  // ── GET /mines/history ───────────────────────────────────
  app.get("/mines/history", (req, res) => {
    res.json(recentGames.slice(0, 20));
  });

  // ── GET /mines/mybets ────────────────────────────────────
  app.get("/mines/mybets", (req, res) => {
    if (!req.session?.user) return res.json([]);
    res.json(userBets.get(req.session.user.id) || []);
  });

  // ── POST /mines/start ────────────────────────────────────
  app.post("/mines/start", verifyCsrf, async (req, res) => {
    if (!req.session?.user)
      return res.status(401).json({ error: "تسجيل الدخول مطلوب" });
    const userId = req.session.user.id;
    const amount = parseInt(req.body.amount);
    const mines = parseInt(req.body.mines) || 3;

    if (!amount || amount < 100)
      return res.status(400).json({ error: "الحد الأدنى 100 عملة" });
    if (amount > 50_000_000)
      return res.status(400).json({ error: "الحد الأقصى 50,000,000 عملة" });
    if (mines < 1 || mines > 24)
      return res.status(400).json({ error: "الألغام يجب أن تكون بين 1 و 24" });

    try {
      const u = await db.findOne({ id: userId });
      if (!u) return res.status(400).json({ error: "الحساب غير موجود" });
      if (u.status_playing === "yes")
        return res.status(400).json({ error: "لديك لعبة نشطة بالفعل" });
      if (Number(u.coins || 0) < amount)
        return res.status(400).json({ error: "رصيدك غير كافٍ" });

      u.coins = Number(u.coins || 0) - amount;
      u.status_playing = "yes";
      await u.save();

      const sid = crypto.randomBytes(16).toString("hex");
      sessions.set(sid, {
        userId,
        username: req.session.user.username,
        avatar: req.session.user.avatar,
        amount,
        mines,
        grid: genGrid(mines),
        revealed: [],
        multiplier: 1.0,
        started: true,
        finished: false,
        cashedOut: false,
        isBotGame: req.session.minesBotGame === userId,
        createdAt: Date.now(),
      });
      if (req.session.minesBotGame === userId) req.session.minesBotGame = null;
      setTimeout(() => sessions.delete(sid), 30 * 60_000);

      res.json({ ok: true, sid, nextMult: nextMult(mines, 0) });
    } catch (e) {
      console.error("[Mines/start]", e);
      res.status(500).json({ error: "خطأ في الخادم" });
    }
  });

  // ── POST /mines/reveal ───────────────────────────────────
  app.post("/mines/reveal", verifyCsrf, async (req, res) => {
    if (!req.session?.user)
      return res.status(401).json({ error: "تسجيل الدخول مطلوب" });
    const userId = req.session.user.id;
    const sid = req.body.sid;
    const tile = parseInt(req.body.tile);
    const sess = sessions.get(sid);

    if (!sess) return res.status(400).json({ error: "جلسة غير موجودة" });
    if (sess.userId !== userId)
      return res.status(403).json({ error: "غير مصرح" });
    if (sess.finished || sess.cashedOut)
      return res.status(400).json({ error: "اللعبة انتهت" });
    if (tile < 0 || tile > 24)
      return res.status(400).json({ error: "مربع غير صحيح" });
    if (sess.revealed.includes(tile))
      return res.status(400).json({ error: "تم الكشف مسبقاً" });

    const isBomb = sess.grid[tile];
    sess.revealed.push(tile);

    if (isBomb) {
      sess.finished = true;
      try {
        const u = await db.findOne({ id: userId });
        if (u) {
          u.status_playing = "no";
          await u.save();
        }
      } catch (_) {}
      // Reveal all bomb positions
      const allBombs = sess.grid
        .map((b, i) => (b ? i : -1))
        .filter((i) => i >= 0);
      addUserBet(userId, {
        amount: sess.amount,
        mines: sess.mines,
        revealed: sess.revealed.length - 1,
        multiplier: 0,
        profit: -sess.amount,
        won: false,
        ts: Date.now(),
      });
      recentGames.unshift({
        userId: sess.userId,
        username: sess.username,
        avatar: sess.avatar,
        amount: sess.amount,
        mines: sess.mines,
        revealed: sess.revealed.length - 1,
        multiplier: 0,
        profit: -sess.amount,
        won: false,
        ts: Date.now(),
      });
      if (recentGames.length > 20) recentGames.length = 20;
      if (siteLog)
        siteLog(
          "💣 Mines — خسارة",
          `**${sess.username}** خسر **${sess.amount.toLocaleString()}** عملة (${sess.mines} ألغام, كشف ${sess.revealed.length - 1} مربع)`,
          "#ef4444",
        ).catch(() => {});
      return res.json({
        ok: true,
        bomb: true,
        bombTile: tile,
        allBombs,
        grid: sess.grid,
      });
    }

    const revealed = sess.revealed.length;
    const mult = calcMult(sess.mines, revealed);
    const nxt =
      revealed < TOTAL_TILES - sess.mines
        ? nextMult(sess.mines, revealed)
        : null;
    sess.multiplier = mult;

    // Auto-cashout: if all safe tiles revealed
    if (revealed === TOTAL_TILES - sess.mines) {
      sess.finished = true;
      sess.cashedOut = true;
      const payout = Math.floor(sess.amount * mult);
      try {
        const u = await db.findOne({ id: userId });
        if (u) {
          u.coins = Number(u.coins || 0) + payout;
          u.status_playing = "no";
          await u.save();
        }
      } catch (_) {}
      addUserBet(userId, {
        amount: sess.amount,
        mines: sess.mines,
        revealed,
        multiplier: mult,
        profit: payout - sess.amount,
        won: true,
        ts: Date.now(),
      });
      recentGames.unshift({
        userId: sess.userId,
        username: sess.username,
        avatar: sess.avatar,
        amount: sess.amount,
        mines: sess.mines,
        revealed,
        multiplier: mult,
        profit: payout - sess.amount,
        won: true,
        ts: Date.now(),
      });
      if (recentGames.length > 20) recentGames.length = 20;
      return res.json({
        ok: true,
        bomb: false,
        revealed,
        mult,
        nxt,
        autoCashout: true,
        payout,
      });
    }

    res.json({ ok: true, bomb: false, revealed, mult, nxt });
  });

  // ── POST /mines/cashout ──────────────────────────────────
  app.post("/mines/cashout", verifyCsrf, async (req, res) => {
    if (!req.session?.user)
      return res.status(401).json({ error: "تسجيل الدخول مطلوب" });
    const userId = req.session.user.id;
    const sid = req.body.sid;
    const sess = sessions.get(sid);

    if (!sess) return res.status(400).json({ error: "جلسة غير موجودة" });
    if (sess.userId !== userId)
      return res.status(403).json({ error: "غير مصرح" });
    if (sess.finished || sess.cashedOut)
      return res.status(400).json({ error: "اللعبة انتهت" });
    if (sess.revealed.length === 0)
      return res
        .status(400)
        .json({ error: "يجب الكشف عن مربع واحد على الأقل" });

    sess.finished = true;
    sess.cashedOut = true;
    const mult = sess.multiplier;
    const payout = Math.floor(sess.amount * mult);

    try {
      const u = await db.findOne({ id: userId });
      if (u) {
        u.coins = Number(u.coins || 0) + payout;
        u.status_playing = "no";
        await u.save();
      }
    } catch (e) {
      console.error("[Mines/cashout]", e);
      return res.status(500).json({ error: "خطأ في الخادم" });
    }

    const bombPositions = sess.grid
      .map((b, i) => (b ? i : -1))
      .filter((i) => i >= 0);
    addUserBet(userId, {
      amount: sess.amount,
      mines: sess.mines,
      revealed: sess.revealed.length,
      multiplier: mult,
      profit: payout - sess.amount,
      won: true,
      ts: Date.now(),
    });
    recentGames.unshift({
      userId: sess.userId,
      username: sess.username,
      avatar: sess.avatar,
      amount: sess.amount,
      mines: sess.mines,
      revealed: sess.revealed.length,
      multiplier: mult,
      profit: payout - sess.amount,
      won: true,
      ts: Date.now(),
    });
    if (recentGames.length > 20) recentGames.length = 20;
    if (siteLog)
      siteLog(
        "💎 Mines — ربح",
        `**${sess.username}** ربح **${payout.toLocaleString()}** عملة عند **${mult}×** (${sess.mines} ألغام)`,
        "#22c55e",
      ).catch(() => {});

    res.json({
      ok: true,
      mult,
      payout,
      profit: payout - sess.amount,
      bombPositions,
    });
  });

  // ── GET /mines/bot/:token ────────────────────────────────
  app.get("/mines/bot/:token", (req, res) => {
    const bs = botSessions.get(req.params.token);
    if (!bs)
      return res
        .status(404)
        .send(
          '<h2 style="color:red;text-align:center;margin-top:80px">الرابط غير صالح أو انتهت صلاحيته</h2>',
        );
    botSessions.delete(req.params.token);
    if (req.session?.user?.id !== bs.userId) {
      return res.redirect(`/auth/discord?redir=/mines/bot/${req.params.token}`);
    }
    req.session.minesBotGame = bs.userId;
    req.session.minesBotAmount = bs.amount;
    res.redirect("/mines");
  });

  // ── GET /mines ───────────────────────────────────────────
  app.get("/mines", (req, res) => {
    const user = req.session?.user || null;
    const prefillAmt = req.session?.minesBotAmount || 500;
    if (req.session?.minesBotAmount) delete req.session.minesBotAmount;

    const BOMB_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60" style="width:100%;height:100%"><circle cx="30" cy="34" r="20" fill="#1e1b2e" stroke="#4c1d95" stroke-width="2.5"/><rect x="27" y="12" width="6" height="9" rx="2.5" fill="#4c1d95"/><path d="M30 12 Q36 6 42 4" stroke="#f59e0b" stroke-width="3" fill="none" stroke-linecap="round"/><circle cx="43" cy="3.5" r="3" fill="#f59e0b"/><line x1="10" y1="34" x2="5" y2="34" stroke="#4c1d95" stroke-width="2.5" stroke-linecap="round"/><line x1="50" y1="34" x2="55" y2="34" stroke="#4c1d95" stroke-width="2.5" stroke-linecap="round"/><line x1="30" y1="14" x2="30" y2="18" stroke="#4c1d95" stroke-width="2.5" stroke-linecap="round"/><line x1="15" y1="19" x2="12" y2="16" stroke="#4c1d95" stroke-width="2" stroke-linecap="round"/><line x1="45" y1="19" x2="48" y2="16" stroke="#4c1d95" stroke-width="2" stroke-linecap="round"/><line x1="15" y1="49" x2="12" y2="52" stroke="#4c1d95" stroke-width="2" stroke-linecap="round"/><line x1="45" y1="49" x2="48" y2="52" stroke="#4c1d95" stroke-width="2" stroke-linecap="round"/><ellipse cx="24" cy="27" rx="4" ry="2.5" fill="rgba(255,255,255,0.12)" transform="rotate(-30 24 27)"/></svg>`;

    const GEM_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60" style="width:100%;height:100%"><polygon points="30,5 52,20 44,55 16,55 8,20" fill="#5b21b6"/><polygon points="30,5 52,20 30,17" fill="#a78bfa"/><polygon points="8,20 30,17 16,55" fill="#3b0764"/><polygon points="52,20 44,55 30,17" fill="#4c1d95"/><polygon points="16,55 44,55 30,17" fill="#6d28d9"/><polygon points="30,5 42,14 30,17" fill="rgba(255,255,255,0.35)"/><ellipse cx="25" cy="30" rx="4" ry="2" fill="rgba(255,255,255,0.1)" transform="rotate(-20 25 30)"/></svg>`;

    const extraHead = `<style>
:root{--mg:#8b5cf6;--mg2:#6d28d9;--mgc:#a78bfa;--mgg:#22c55e;--mgr:#ef4444;}
.mines-root{display:flex;gap:16px;min-height:calc(100vh - 140px);}
.mines-left{width:260px;flex-shrink:0;display:flex;flex-direction:column;gap:12px;}
.mines-center{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;}
.mines-right{width:270px;flex-shrink:0;display:flex;flex-direction:column;gap:12px;}
.mines-card{background:var(--card,#151d2f);border-radius:16px;border:1px solid rgba(255,255,255,.06);padding:18px;}
.mines-card-title{font-size:11px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:rgba(255,255,255,.3);margin:0 0 14px;}
.mines-bal{font-size:13px;color:rgba(255,255,255,.4);text-align:center;margin-bottom:12px;}
.mines-bal strong{color:var(--mgg);font-size:15px;}
.mines-quick{display:flex;gap:5px;margin-bottom:10px;}
.mines-quick button{flex:1;padding:6px 0;border-radius:8px;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.04);color:#fff;font-size:11px;font-weight:700;cursor:pointer;transition:all .15s;}
.mines-quick button:hover{background:rgba(139,92,246,.25);border-color:var(--mg);}
.mines-input{width:100%;padding:11px;border-radius:10px;border:1px solid rgba(139,92,246,.3);background:rgba(0,0,0,.35);color:#fff;font-size:18px;font-weight:800;text-align:center;box-sizing:border-box;outline:none;}
.mines-input:focus{border-color:var(--mg);box-shadow:0 0 0 3px rgba(139,92,246,.15);}
.mines-mines-row{display:flex;align-items:center;gap:10px;margin:12px 0;}
.mines-mines-row label{font-size:12px;color:rgba(255,255,255,.45);font-weight:600;min-width:58px;}
.mines-mines-slider{flex:1;accent-color:var(--mg);}
.mines-mines-val{font-size:14px;font-weight:800;color:var(--mgc);min-width:28px;text-align:center;}
.mines-main-btn{width:100%;padding:13px;border-radius:12px;border:none;font-size:15px;font-weight:800;cursor:pointer;letter-spacing:.5px;transition:all .2s;margin-top:4px;}
.mines-main-btn.start{background:linear-gradient(135deg,var(--mg),var(--mg2));color:#fff;box-shadow:0 4px 20px rgba(139,92,246,.4);}
.mines-main-btn.start:hover:not(:disabled){transform:translateY(-2px);box-shadow:0 6px 28px rgba(139,92,246,.55);}
.mines-main-btn.cashout{background:linear-gradient(135deg,var(--mgg),#15803d);color:#fff;box-shadow:0 4px 20px rgba(34,197,94,.4);animation:mgPulse 1s infinite;}
.mines-main-btn.cashout:hover:not(:disabled){transform:translateY(-2px);}
.mines-main-btn.new{background:rgba(139,92,246,.15);color:var(--mgc);border:1px solid rgba(139,92,246,.3);}
.mines-main-btn.new:hover{background:rgba(139,92,246,.25);}
.mines-main-btn:disabled{opacity:.4;cursor:not-allowed;transform:none!important;animation:none!important;}
@keyframes mgPulse{0%,100%{box-shadow:0 4px 20px rgba(34,197,94,.4);}50%{box-shadow:0 4px 30px rgba(34,197,94,.7);}}
.mines-mult-box{text-align:center;margin:8px 0 4px;}
.mines-mult-num{font-size:32px;font-weight:900;color:var(--mgc);line-height:1;}
.mines-mult-sub{font-size:11px;color:rgba(255,255,255,.3);letter-spacing:2px;text-transform:uppercase;margin-top:2px;}
.mines-payout-box{background:rgba(139,92,246,.07);border:1px solid rgba(139,92,246,.15);border-radius:10px;padding:10px 14px;display:flex;justify-content:space-between;align-items:center;margin-top:8px;}
.mines-payout-label{font-size:11px;color:rgba(255,255,255,.35);font-weight:600;}
.mines-payout-val{font-size:14px;font-weight:800;color:var(--mgg);}
.mines-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;width:100%;max-width:380px;}
.mines-tile{aspect-ratio:1;border-radius:12px;cursor:pointer;border:none;position:relative;overflow:hidden;transition:transform .15s, box-shadow .15s;background:linear-gradient(135deg,rgba(139,92,246,.18),rgba(109,40,217,.12));border:1px solid rgba(139,92,246,.25);}
.mines-tile:hover:not(.revealed):not(.bomb-tile):not([disabled]){transform:translateY(-3px) scale(1.04);box-shadow:0 6px 20px rgba(139,92,246,.35);border-color:var(--mgc);}
.mines-tile[disabled]{cursor:default;}
.mines-tile .tile-inner{width:100%;height:100%;display:flex;align-items:center;justify-content:center;padding:12%;box-sizing:border-box;}
.mines-tile.idle .tile-inner::before{content:'';position:absolute;inset:0;background:linear-gradient(135deg,rgba(255,255,255,.04),transparent);}
.mines-tile.gem-tile{background:linear-gradient(135deg,rgba(109,40,217,.35),rgba(91,33,182,.25));border-color:var(--mgc);animation:gemPop .35s cubic-bezier(.34,1.56,.64,1);}
.mines-tile.bomb-tile{background:linear-gradient(135deg,rgba(239,68,68,.25),rgba(185,28,28,.18));border-color:var(--mgr);animation:bombShake .4s ease;}
.mines-tile.inactive{background:rgba(15,10,30,.4);border-color:rgba(255,255,255,.06);cursor:default;opacity:.65;}
.mines-tile.inactive.was-safe{background:linear-gradient(135deg,rgba(34,197,94,.15),rgba(21,128,61,.1));border-color:rgba(34,197,94,.3);opacity:.8;}
@keyframes gemPop{0%{transform:scale(.6);opacity:.5;}70%{transform:scale(1.1);}100%{transform:scale(1);opacity:1;}}
@keyframes bombShake{0%,100%{transform:translateX(0);}20%{transform:translateX(-5px)rotate(-3deg);}40%{transform:translateX(5px)rotate(3deg);}60%{transform:translateX(-4px)rotate(-2deg);}80%{transform:translateX(4px);}  }
.mines-status{font-size:13px;text-align:center;min-height:22px;font-weight:600;color:rgba(255,255,255,.4);}
.mines-status.win{color:var(--mgg);} .mines-status.lose{color:var(--mgr);}
.mines-tabs{display:flex;gap:0;border-bottom:1px solid rgba(255,255,255,.08);margin-bottom:12px;}
.mines-tab{flex:1;padding:8px;background:none;border:none;color:rgba(255,255,255,.35);font-size:12px;font-weight:700;cursor:pointer;letter-spacing:1px;text-transform:uppercase;border-bottom:2px solid transparent;transition:all .15s;}
.mines-tab.active{color:var(--mgc);border-bottom-color:var(--mg);}
.mines-feed{flex:1;overflow-y:auto;scrollbar-width:thin;scrollbar-color:rgba(139,92,246,.2) transparent;}
.feed-row{display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.04);font-size:12px;animation:fadeUp .25s ease;}
.feed-row img{width:26px;height:26px;border-radius:50%;flex-shrink:0;object-fit:cover;}
.feed-name{flex:1;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:rgba(255,255,255,.75);}
.feed-info{font-size:11px;color:rgba(255,255,255,.3);}
.feed-mult{font-size:12px;font-weight:800;min-width:50px;text-align:right;}
.feed-mult.win{color:var(--mgg);} .feed-mult.lose{color:var(--mgr);}
@keyframes fadeUp{from{opacity:0;transform:translateY(4px);}to{opacity:1;transform:none;}}
.mines-mines-info{font-size:11px;color:rgba(255,255,255,.25);text-align:center;margin-top:6px;}
.mines-next-mult{font-size:11px;color:rgba(255,255,255,.3);text-align:center;margin-top:4px;}
.mines-next-mult span{color:var(--mgc);font-weight:700;}
@media(max-width:900px){.mines-root{flex-direction:column;}.mines-left,.mines-right{width:100%;}.mines-grid{max-width:100%;}}
@media(max-width:500px){.mines-tile{border-radius:9px;}.mines-tile .tile-inner{padding:10%;}}</style>`;

    const IS_USER = !!user;
    const content = `
<div class="mines-root">

  <!-- LEFT: Controls -->
  <div class="mines-left">
    <div class="mines-card">
      <p class="mines-card-title">الرهان</p>
      ${
        IS_USER
          ? `
      <div class="mines-bal">رصيدك: <strong id="mBal">—</strong></div>
      <div class="mines-quick">
        <button onclick="qAdd(100)">+100</button>
        <button onclick="qAdd(1000)">+1K</button>
        <button onclick="qAdd(5000)">+5K</button>
        <button onclick="qHalf()">½</button>
        <button onclick="qDouble()">×2</button>
      </div>
      <input type="number" id="mBetInput" class="mines-input" value="${prefillAmt}" min="100" style="margin-bottom:12px">
      <div class="mines-mines-row">
        <label>الألغام</label>
        <input type="range" id="mMinesSlider" class="mines-mines-slider" min="1" max="24" value="3" oninput="onSlider(this.value)">
        <span class="mines-mines-val" id="mMinesVal">3</span>
      </div>
      <div class="mines-mines-info" id="mMinesInfo">3 ألغام من أصل 25 مربع</div>
      `
          : `
      <div style="text-align:center;padding:20px 0">
        <p style="color:rgba(255,255,255,.4);font-size:13px;margin-bottom:14px">سجّل دخولك للعب</p>
        <a href="/auth/discord" style="display:inline-block;padding:10px 24px;background:linear-gradient(135deg,#8b5cf6,#6d28d9);border-radius:10px;color:#fff;font-weight:700;text-decoration:none;font-size:14px">تسجيل الدخول</a>
      </div>
      `
      }
    </div>

    ${
      IS_USER
        ? `
    <div class="mines-card">
      <p class="mines-card-title">الإحصاء</p>
      <div class="mines-mult-box">
        <div class="mines-mult-num" id="mMultNum">1.00×</div>
        <div class="mines-mult-sub">المضاعف الحالي</div>
      </div>
      <div class="mines-next-mult" id="mNextMult">التالي: <span>—</span></div>
      <div class="mines-payout-box">
        <span class="mines-payout-label">الربح المحتمل</span>
        <span class="mines-payout-val" id="mPayout">—</span>
      </div>
      <button id="mMainBtn" class="mines-main-btn start" onclick="onMainBtn()">ابدأ اللعبة</button>
    </div>
    `
        : ""
    }
  </div>

  <!-- CENTER: Grid -->
  <div class="mines-center">
    <div class="mines-grid" id="mGrid"></div>
    <div class="mines-status" id="mStatus">اختر المبلغ والألغام ثم ابدأ اللعبة</div>
  </div>

  <!-- RIGHT: Live feed -->
  <div class="mines-right">
    <div class="mines-card" style="flex:1;display:flex;flex-direction:column;min-height:0;overflow:hidden">
      <div class="mines-tabs">
        <button class="mines-tab active" id="tabLive" onclick="switchTab('live')">مباشر</button>
        <button class="mines-tab" id="tabMy"   onclick="switchTab('my')">رهاناتي</button>
      </div>
      <div class="mines-feed" id="mFeed"></div>
    </div>
  </div>

</div>

<script>
const IS_USER  = ${IS_USER};
const BOMB_SVG = ${JSON.stringify(BOMB_SVG).replace(/</g, "\\x3c")};
const GEM_SVG = ${JSON.stringify(GEM_SVG).replace(/</g, "\\x3c")};

let sid = null, gameActive = false, revealed = [], minesCount = 3, betAmount = ${prefillAmt};
let currentMult = 1.00, nextMultiplier = null;

// ── Grid build ─────────────────────────────────────────────
function buildGrid() {
  var g = document.getElementById('mGrid');
  if (!g) return;
  g.innerHTML = '';
  for (var i = 0; i < 25; i++) {
    var t = document.createElement('button');
    t.className = 'mines-tile idle';
    t.setAttribute('data-i', i);
    t.innerHTML = '<div class="tile-inner"></div>';
    t.onclick = (function(idx) { return function() { revealTile(idx); }; })(i);
    t.disabled = !gameActive;
    g.appendChild(t);
  }
}

function getTile(i) { return document.querySelector('.mines-tile[data-i="' + i + '"]'); }

function showGem(i) {
  var t = getTile(i);
  if (!t) return;
  t.className = 'mines-tile gem-tile revealed';
  t.innerHTML = '<div class="tile-inner">' + GEM_SVG + '</div>';
  t.disabled = true;
}

function showBomb(i, main) {
  var t = getTile(i);
  if (!t) return;
  t.className = 'mines-tile bomb-tile revealed';
  t.innerHTML = '<div class="tile-inner">' + BOMB_SVG + '</div>';
  t.disabled = true;
  if (main) t.style.boxShadow = '0 0 24px rgba(239,68,68,.6)';
}

function showInactive(i, safe) {
  var t = getTile(i);
  if (!t || t.classList.contains('revealed')) return;
  t.className = 'mines-tile inactive' + (safe ? ' was-safe' : '');
  t.innerHTML = '<div class="tile-inner">' + (safe ? GEM_SVG : BOMB_SVG) + '</div>';
  t.disabled = true;
}

function setTilesDisabled(dis) {
  var tiles = document.querySelectorAll('.mines-tile:not(.revealed)');
  for (var i = 0; i < tiles.length; i++) {
    var t = tiles[i];
    if (!t.classList.contains('bomb-tile')) t.disabled = dis;
  }
}

// ── Controls ───────────────────────────────────────────────
function qAdd(n) {
  var i = document.getElementById('mBetInput');
  if (!gameActive && i) i.value = Math.max(100, (parseInt(i.value) || 0) + n);
}
function qHalf() {
  var i = document.getElementById('mBetInput');
  if (!gameActive && i) i.value = Math.max(100, Math.floor((parseInt(i.value) || 200) / 2));
}
function qDouble() {
  var i = document.getElementById('mBetInput');
  if (!gameActive && i) i.value = Math.min(50000000, (parseInt(i.value) || 100) * 2);
}

function onSlider(v) {
  if (gameActive) return;
  minesCount = parseInt(v);
  var valSpan = document.getElementById('mMinesVal');
  if (valSpan) valSpan.textContent = v;
  var infoSpan = document.getElementById('mMinesInfo');
  if (infoSpan) infoSpan.textContent = v + ' ألغام من أصل 25 مربع';
  updateMultDisplay(1.00, calcNextMult(parseInt(v), 0));
}

function calcNextMult(mines, revealed) {
  var n = 25, m = mines;
  if (revealed >= n - m) return null;
  var p = 1;
  for (var i = 0; i <= revealed; i++) p *= (n - m - i) / (n - i);
  return Math.floor((1 / p) * 0.99 * 100) / 100;
}

function updateMultDisplay(mult, nxt) {
  var mn = document.getElementById('mMultNum');
  if (mn) mn.textContent = mult.toFixed(2) + '×';
  var nm = document.getElementById('mNextMult');
  if (nm) nm.innerHTML = nxt ? 'التالي: <span>' + nxt.toFixed(2) + '×</span>' : 'كشفت جميع المربعات الآمنة!';
  var pa = document.getElementById('mPayout');
  if (pa) {
    var betInput = document.getElementById('mBetInput');
    var bet = (betInput ? parseInt(betInput.value) : 0) || 0;
    pa.textContent = mult > 1 ? Math.floor(bet * mult).toLocaleString('en-US') + ' عملة' : '—';
  }
}

function setStatus(msg, cls) {
  var s = document.getElementById('mStatus');
  if (s) { s.textContent = msg; s.className = 'mines-status' + (cls ? ' ' + cls : ''); }
}

function setBtn(mode) {
  var b = document.getElementById('mMainBtn');
  if (!b) return;
  b.disabled = false;
  if (mode === 'start') { b.className = 'mines-main-btn start'; b.textContent = 'ابدأ اللعبة'; }
  if (mode === 'cashout') { b.className = 'mines-main-btn cashout'; b.textContent = 'اسحب الآن!'; }
  if (mode === 'new') { b.className = 'mines-main-btn new'; b.textContent = 'لعبة جديدة'; }
  if (mode === 'disabled') { b.className = 'mines-main-btn start'; b.textContent = 'ابدأ اللعبة'; b.disabled = true; }
}

async function onMainBtn() {
  if (!IS_USER) return location.href = '/auth/discord';
  var btn = document.getElementById('mMainBtn');
  if (!gameActive) {
    if (btn && btn.classList.contains('new')) { resetGame(); return; }
    await startGame();
  } else {
    await doCashout();
  }
}

async function getCsrf() {
  var r = await fetch('/mines/csrf', { credentials: 'same-origin' });
  var data = await r.json();
  return data.token;
}

async function startGame() {
  if (!IS_USER) return location.href = '/auth/discord';
  var betInput = document.getElementById('mBetInput');
  betAmount = parseInt(betInput ? betInput.value : 0) || 0;
  var minesSlider = document.getElementById('mMinesSlider');
  minesCount = parseInt(minesSlider ? minesSlider.value : 3) || 3;

  if (betAmount < 100) { toast("الحد الأدنى 100 عملة", 'error'); return; }
  setBtn('disabled');
  setTilesDisabled(true);
  try {
    var token = await getCsrf();
    var r = await fetch('/mines/start', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': token },
      body: JSON.stringify({ amount: betAmount, mines: minesCount })
    });
    var d = await r.json();
    if (d.error) { setBtn('start'); toast(d.error, 'error'); return; }
    sid = d.sid;
    gameActive = true; revealed = [];
    currentMult = 1.00; nextMultiplier = d.nextMult;
    updateMultDisplay(1.00, d.nextMult);
    setTilesDisabled(false);
    setBtn('cashout');
    setStatus("انقر على المربعات للكشف عنها — تجنب الألغام!");
    loadBalance();
  } catch(e) { setBtn('start'); toast("خطأ في الاتصال", 'error'); }
}

async function revealTile(idx) {
  if (!gameActive || !sid) return;
  var tile = getTile(idx);
  if (tile) tile.disabled = true;
  try {
    var token = await getCsrf();
    var r = await fetch('/mines/reveal', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': token },
      body: JSON.stringify({ sid: sid, tile: idx })
    });
    var d = await r.json();
    if (d.error) { if (tile) tile.disabled = false; toast(d.error, 'error'); return; }

    if (d.bomb) {
      showBomb(idx, true);
      for (var bi = 0; bi < d.allBombs.length; bi++) {
        if (d.allBombs[bi] !== idx) showBomb(d.allBombs[bi], false);
      }
      var bombsSet = new Set(d.allBombs);
      for (var i = 0; i < 25; i++) {
        if (!bombsSet.has(i) && revealed.indexOf(i) === -1) showInactive(i, true);
      }
      gameActive = false; sid = null; revealed = [];
      setBtn('new');
      setStatus("انفجرت لغم! خسرت " + betAmount.toLocaleString('en-US') + " عملة", 'lose');
      updateMultDisplay(0, null);
      var multNum = document.getElementById('mMultNum');
      if (multNum) multNum.style.color = '#ef4444';
      loadBalance(); loadFeed();
    } else {
      showGem(idx);
      if (!Array.isArray(d.revealed)) revealed.push(idx);
      currentMult = d.mult;
      nextMultiplier = d.nxt;
      updateMultDisplay(d.mult, d.nxt);
      if (d.autoCashout) {
        gameActive = false; sid = null;
        setBtn('new');
        setStatus("كشفت جميع المربعات الآمنة! ربحت " + d.payout.toLocaleString('en-US') + " عملة", 'win');
        toast("ربحت " + d.payout.toLocaleString('en-US') + " عملة!", 'success');
        loadBalance(); loadFeed();
      }
    }
  } catch(e) { if (tile) tile.disabled = false; toast("خطأ في الاتصال", 'error'); }
}

async function doCashout() {
  if (!gameActive || !sid) return;
  setBtn('disabled');
  setTilesDisabled(true);
  try {
    var token = await getCsrf();
    var r = await fetch('/mines/cashout', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': token },
      body: JSON.stringify({ sid: sid })
    });
    var d = await r.json();
    if (d.error) { setBtn('cashout'); setTilesDisabled(false); toast(d.error, 'error'); return; }

    for (var bi = 0; bi < d.bombPositions.length; bi++) {
      showInactive(d.bombPositions[bi], false);
    }
    var bombsSet = new Set(d.bombPositions);
    for (var i = 0; i < 25; i++) {
      var t = getTile(i);
      if (!bombsSet.has(i) && t && t.className.indexOf('gem-tile') === -1) showInactive(i, true);
    }
    gameActive = false; sid = null;
    setBtn('new');
    var profit = d.profit;
    setStatus(
      (profit >= 0 ? "ربحت " : "خسرت ") +
      Math.abs(profit).toLocaleString('en-US') + " عملة عند " + d.mult + "×",
      profit >= 0 ? 'win' : 'lose'
    );
    toast("ربحت " + d.payout.toLocaleString('en-US') + " عملة عند " + d.mult + "×!", 'success');
    loadBalance(); loadFeed();
  } catch(e) { setBtn('cashout'); setTilesDisabled(false); toast("خطأ في الاتصال", 'error'); }
}

function resetGame() {
  gameActive = false; sid = null; revealed = [];
  currentMult = 1.00;
  var multNum = document.getElementById('mMultNum');
  if (multNum) multNum.style.color = 'var(--mgc)';
  buildGrid();
  updateMultDisplay(1.00, calcNextMult(minesCount, 0));
  setBtn('start');
  setStatus("اختر المبلغ والألغام ثم ابدأ اللعبة");
  var slider = document.getElementById('mMinesSlider');
  if (slider) slider.disabled = false;
  var betInput = document.getElementById('mBetInput');
  if (betInput) betInput.disabled = false;
}

async function loadBalance() {
  if (!IS_USER) return;
  try {
    var d = await fetch('/mines/balance', { credentials: 'same-origin' }).then(function(r) { return r.json(); });
    var e = document.getElementById('mBal');
    if (e) e.textContent = Number(d.coins || 0).toLocaleString('en-US') + " عملة";
  } catch(e){}
}

var activeTab = 'live';
function switchTab(t) {
  activeTab = t;
  var tabLive = document.getElementById('tabLive');
  var tabMy = document.getElementById('tabMy');
  if (tabLive) tabLive.className = 'mines-tab' + (t === 'live' ? ' active' : '');
  if (tabMy) tabMy.className = 'mines-tab' + (t === 'my' ? ' active' : '');
  loadFeed();
}

async function loadFeed() {
  var url = activeTab === 'live' ? '/mines/history' : '/mines/mybets';
  try {
    var data = await fetch(url, { credentials: 'same-origin' }).then(function(r){ return r.json(); });
    var feed = document.getElementById('mFeed');
    if (!feed) return;
    if (!data.length) {
      feed.innerHTML = '<div style="color:rgba(255,255,255,.25);font-size:13px;text-align:center;padding:24px 0">لا توجد رهانات بعد</div>';
      return;
    }
    var html = '';
    for (var j = 0; j < data.length; j++) {
      var b = data[j];
      var fallback = 'https://cdn.discordapp.com/embed/avatars/0.png';
      var avatarHtml = '';
      if (b.userId && b.avatar) {
        var src = 'https://cdn.discordapp.com/avatars/' + b.userId + '/' + b.avatar + '.png';
        avatarHtml = '<img src="' + src + '" alt="" style="width:26px;height:26px;border-radius:50%;flex-shrink:0;object-fit:cover;" onerror="this.src=&quot;' + fallback + '&quot;">';
      } else {
        var letter = (b.username || '?')[0].toUpperCase();
        avatarHtml = '<div style="width:26px;height:26px;border-radius:50%;background:rgba(139,92,246,.3);flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#a78bfa;">' + letter + '</div>';
      }
      var prof = (b.profit >= 0 ? '+' : '') + Math.abs(b.profit).toLocaleString('en-US');
      var cls = b.won ? 'win' : 'lose';
      html += '<div class="feed-row">' +
        avatarHtml +
        '<div style="flex:1;min-width:0">' +
          '<div class="feed-name">' + (b.username || "لاعب") + '</div>' +
          '<div class="feed-info">' + b.mines + ' ألغام &middot; ' + b.amount.toLocaleString('en-US') + ' عملة</div>' +
        '</div>' +
        '<div class="feed-mult ' + cls + '">' + prof + '</div>' +
        '</div>';
    }
    feed.innerHTML = html;
  } catch(e){}
}

function toast(msg, type) {
  var c = document.getElementById('toast-container');
  if (!c) {
    var container = document.createElement('div');
    container.id = 'toast-container';
    container.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:9999;';
    document.body.appendChild(container);
    c = container;
  }
  var t = document.createElement('div');
  t.className = 'toast ' + (type === 'error' ? 'toast-error' : 'toast-success');
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(function() { if (t && t.remove) t.remove(); }, 3500);
}

(function addToastStyles() {
  if (document.getElementById('mines-toast-styles')) return;
  var style = document.createElement('style');
  style.id = 'mines-toast-styles';
  style.textContent = '.toast{background:#1e1b2e;border-radius:12px;padding:12px 20px;margin-top:10px;color:#fff;font-size:14px;font-weight:600;box-shadow:0 4px 20px rgba(0,0,0,.3);animation:slideIn 0.3s ease;}.toast-success{border-right:4px solid #22c55e;}.toast-error{border-right:4px solid #ef4444;}@keyframes slideIn{from{transform:translateX(100%);opacity:0;}to{transform:translateX(0);opacity:1;}}';
  document.head.appendChild(style);
})();

buildGrid();
if (IS_USER) {
  loadBalance();
  loadFeed();
  setInterval(loadFeed, 6000);
  updateMultDisplay(1.00, calcNextMult(3, 0));

  var betInput = document.getElementById('mBetInput');
  if (betInput) {
    betInput.addEventListener('input', function() {
      if (!gameActive) updateMultDisplay(currentMult, nextMultiplier);
    });
  }
}
</script>`;

    res.send(layout("Mines", content, "/mines", user, extraHead));
  });
};

routeSetup.createBotSession = createBotSession;
routeSetup.getRecentGames  = () => recentGames.slice(0, 10);
module.exports = routeSetup;
