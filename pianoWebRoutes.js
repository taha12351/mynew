'use strict';
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const GAME_MS     = 60_000;
const PAYOUT_MULT = 2.0;
const SONGS_FILE  = path.join(__dirname, 'pianoSongs.json');

function loadSongs() {
  try { return JSON.parse(fs.readFileSync(SONGS_FILE, 'utf8')); }
  catch (_) { return [{ id: 'classic', name: 'بيانو كلاسيكي', emoji: '🎹', audioSrc: null }]; }
}
function saveSongs(arr) {
  fs.writeFileSync(SONGS_FILE, JSON.stringify(arr, null, 2), 'utf8');
}

const sessions = new Map();

function genTiles(bpm = 120) {
  const tiles = [];
  const beat  = 60000 / Math.max(40, Math.min(300, bpm));
  let   t     = 1000;
  while (t < GAME_MS - 800) {
    tiles.push({ lane: Math.floor(Math.random() * 4), hitTime: Math.round(t) });
    t += beat * (Math.random() < 0.3 ? 0.5 : 1);
  }
  return tiles;
}

function createSession(userId, amount, songId) {
  const songs = loadSongs();
  const song  = songs.find(s => s.id === songId) || songs[0] || { id: 'classic', audioSrc: null, name: 'بيانو', bpm: 120 };
  const sid   = crypto.randomBytes(16).toString('hex');
  sessions.set(sid, {
    userId,
    amount,
    song,
    tiles:     genTiles(song.bpm || 120),
    started:   false,
    finished:  false,
    createdAt: Date.now(),
  });
  setTimeout(() => sessions.delete(sid), 30 * 60_000);
  return sid;
}

const botPianoSessions = new Map();

function createBotSession(userId, amount, songId, discordChannelId) {
  const token = crypto.randomBytes(20).toString('hex');
  botPianoSessions.set(token, { userId, amount, songId, discordChannelId, createdAt: Date.now() });
  setTimeout(() => botPianoSessions.delete(token), 15 * 60_000);
  return token;
}

const routeSetup = function setupPianoRoutes(app, { db, siteLog, layout, SERVER_SETTINGS }) {

  app.get('/piano/csrf', (req, res) => {
    if (!req.session) return res.status(403).json({ error: 'no session' });
    if (!req.session.pianoCsrf) req.session.pianoCsrf = crypto.randomBytes(32).toString('hex');
    res.json({ token: req.session.pianoCsrf });
  });

  function verifyCsrf(req, res, next) {
    const token = req.headers['x-csrf-token'] || req.body?.csrfToken;
    if (!req.session?.pianoCsrf || !token || token !== req.session.pianoCsrf)
      return res.status(403).json({ error: 'CSRF token invalid' });
    req.session.pianoCsrf = crypto.randomBytes(32).toString('hex');
    next();
  }

  // ── Bot entry link ─────────────────────────────────────────
  app.get('/piano/bot/:token', async (req, res) => {
    const info = botPianoSessions.get(req.params.token);
    if (!info) return res.status(404).send('رابط اللعبة غير صالح أو انتهت صلاحيته.');
    botPianoSessions.delete(req.params.token);

    const user = req.session?.user;
    if (!user) return res.redirect(`/auth/discord`);
    if (user.id !== info.userId) return res.status(403).send('هذا الرابط ليس لك.');

    const sid = createSession(user.id, info.amount, info.songId);
    res.redirect(`/piano/play/${sid}`);
  });

  // ── Lobby page ─────────────────────────────────────────────
  app.get('/piano', (req, res) => {
    const user = req.session?.user || null;
    const songs = loadSongs();

    const extraHead = `<style>
.piano-lobby{max-width:520px;margin:50px auto;text-align:center;padding:36px;background:var(--card,#151d2f);border-radius:20px;border:1px solid rgba(139,92,246,.2);}
.piano-lobby h1{font-size:28px;font-weight:900;margin-bottom:8px;color:#a78bfa;}
.piano-lobby p{color:rgba(255,255,255,.5);margin-bottom:20px;font-size:14px;}
.piano-song-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;margin-bottom:20px;}
.piano-song-card{padding:14px 10px;border-radius:12px;border:1px solid rgba(139,92,246,.2);background:rgba(139,92,246,.05);cursor:pointer;transition:all .15s;user-select:none;}
.piano-song-card:hover{background:rgba(139,92,246,.18);border-color:#8b5cf6;}
.piano-song-card.selected{background:rgba(139,92,246,.3);border-color:#a78bfa;box-shadow:0 0 0 2px rgba(139,92,246,.4);}
.piano-song-card .sc-emoji{font-size:26px;margin-bottom:6px;}
.piano-song-card .sc-name{font-size:13px;font-weight:700;color:#c4b5fd;}
.piano-form{display:flex;flex-direction:column;gap:12px;}
.piano-form input{width:100%;padding:12px;border-radius:10px;border:1px solid rgba(139,92,246,.3);background:rgba(0,0,0,.35);color:#fff;font-size:20px;font-weight:800;text-align:center;box-sizing:border-box;outline:none;}
.piano-form input:focus{border-color:#8b5cf6;}
.piano-q{display:flex;gap:8px;}
.piano-q button{flex:1;padding:9px;border-radius:8px;border:1px solid rgba(139,92,246,.25);background:rgba(139,92,246,.08);color:#a78bfa;font-weight:700;cursor:pointer;font-size:13px;}
.piano-q button:hover{background:rgba(139,92,246,.2);}
.piano-form .start-btn{padding:14px;border-radius:12px;border:none;background:linear-gradient(135deg,#8b5cf6,#6d28d9);color:#fff;font-size:16px;font-weight:800;cursor:pointer;letter-spacing:.5px;opacity:.5;pointer-events:none;transition:all .2s;}
.piano-form .start-btn.active{opacity:1;pointer-events:auto;}
.piano-form .start-btn.active:hover{transform:translateY(-1px);}
</style>`;

    if (!user) {
      const content = `<div class="piano-lobby">
  <h1>🎹 بيانو ماجيك</h1>
  <p>سجّل دخولك للعب وربح العملات</p>
  <a href="/auth/discord" style="display:inline-block;padding:12px 28px;background:linear-gradient(135deg,#8b5cf6,#6d28d9);border-radius:10px;color:#fff;font-weight:700;text-decoration:none">تسجيل الدخول</a>
</div>`;
      return res.send(layout('بيانو ماجيك', content, '/piano', user, extraHead));
    }

    const songCards = songs.map(s =>
      `<div class="piano-song-card" data-id="${s.id}" onclick="selectSong(this)">
        <div class="sc-emoji">${s.emoji}</div>
        <div class="sc-name">${s.name}</div>
      </div>`
    ).join('');

    const content = `<div class="piano-lobby">
  <h1>🎹 بيانو ماجيك</h1>
  <p>اختر أغنية، ضع رهانك، ثم اصمد 60 ثانية لتضاعف رهانك!</p>
  <div class="piano-song-grid">${songCards}</div>
  <form class="piano-form" onsubmit="startPiano(event)">
    <input type="number" id="pianoAmt" placeholder="المبلغ" min="100" required>
    <div class="piano-q">
      <button type="button" onclick="setAmt('half')">نص</button>
      <button type="button" onclick="setAmt('full')">فل</button>
    </div>
    <button type="submit" class="start-btn" id="startBtn">اختر أغنية أولاً ▲</button>
  </form>
</div>
<script>
let selectedSong = null;
async function loadBal() {
  try { const r=await fetch('/api/balance',{credentials:'same-origin'}); const d=await r.json(); window._bal=d.coins||0; } catch(_){ window._bal=0; }
}
loadBal();
function setAmt(type) {
  document.getElementById('pianoAmt').value = type === 'half' ? Math.floor((window._bal||0)/2) : (window._bal||0);
}
function selectSong(el) {
  document.querySelectorAll('.piano-song-card').forEach(c=>c.classList.remove('selected'));
  el.classList.add('selected');
  selectedSong = el.dataset.id;
  const btn = document.getElementById('startBtn');
  btn.textContent = '▶ ابدأ اللعب';
  btn.classList.add('active');
}
async function startPiano(e) {
  e.preventDefault();
  if (!selectedSong) return alert('اختر أغنية أولاً!');
  const amount = parseInt(document.getElementById('pianoAmt').value);
  if (!amount || amount < 100) return alert('الحد الأدنى 100 عملة');
  const csrf = await fetch('/piano/csrf',{credentials:'same-origin'}).then(r=>r.json()).then(d=>d.token);
  const r = await fetch('/piano/new', {
    method:'POST', credentials:'same-origin',
    headers:{'Content-Type':'application/json','x-csrf-token':csrf},
    body:JSON.stringify({ amount, songId: selectedSong }),
  });
  const d = await r.json();
  if (d.error) return alert(d.error);
  window.location.href = '/piano/play/' + d.sid;
}
</script>`;

    res.send(layout('بيانو ماجيك', content, '/piano', user, extraHead));
  });

  // ── Create session endpoint ────────────────────────────────
  app.post('/piano/new', verifyCsrf, async (req, res) => {
    const user = req.session?.user;
    if (!user) return res.status(401).json({ error: 'تسجيل الدخول مطلوب' });
    const amount = parseInt(req.body.amount);
    const songId = req.body.songId || 'classic';
    if (!amount || amount < 100) return res.status(400).json({ error: 'الحد الأدنى 100 عملة' });
    try {
      const dbUser = await db.findOne({ id: user.id });
      if (!dbUser) return res.status(400).json({ error: 'لم يتم العثور على حسابك' });
      if (dbUser.status_playing === 'yes') return res.status(400).json({ error: 'لا يمكنك اللعب، لديك جلسة نشطة' });
      if (Number(dbUser.coins || 0) < amount) return res.status(400).json({ error: 'رصيدك غير كافٍ' });
      dbUser.status_playing = 'yes';
      await dbUser.save();
      const sid = createSession(user.id, amount, songId);
      res.json({ sid });
    } catch (e) {
      console.error('[Piano/new]', e);
      res.status(500).json({ error: 'خطأ في الخادم' });
    }
  });

  // ── Play page ──────────────────────────────────────────────
  app.get('/piano/play/:sid', async (req, res) => {
    const user = req.session?.user || null;
    const sid  = req.params.sid;
    const sess = sessions.get(sid);

    if (!sess) return res.status(404).send('جلسة اللعب غير موجودة أو انتهت صلاحيتها.');
    if (user && user.id !== sess.userId) return res.status(403).send('هذه الجلسة ليست لك.');
    if (sess.finished) return res.redirect('/piano');

    const tilesJson = JSON.stringify(sess.tiles);
    const audioSrc  = sess.song?.audioSrc || null;
    const songName  = sess.song?.name || 'بيانو ماجيك';
    const songEmoji = sess.song?.emoji || '🎹';
    const songBpm   = sess.song?.bpm   || 120;

    const extraHead = `<style>
.pgh-wrap{position:relative;width:100%;height:calc(100vh - 120px);min-height:500px;display:flex;flex-direction:column;overflow:hidden;}
#pgCanvasWrap{flex:1;position:relative;overflow:hidden;}
#pgCanvas{width:100%;height:100%;display:block;}
.pgh-hud{display:flex;align-items:center;gap:16px;padding:10px 16px;background:rgba(6,3,15,.8);border-bottom:1px solid rgba(139,92,246,.15);backdrop-filter:blur(6px);}
.pgh-score-label{font-size:11px;text-transform:uppercase;letter-spacing:2px;color:rgba(139,92,246,.6);font-weight:700;}
.pgh-score{font-size:22px;font-weight:900;color:#a78bfa;}
.pgh-timer-wrap{flex:1;height:6px;background:rgba(139,92,246,.15);border-radius:3px;overflow:hidden;}
.pgh-timer-fill{height:100%;background:linear-gradient(90deg,#8b5cf6,#a78bfa);border-radius:3px;transition:width .1s linear;}
.pgh-timer{font-size:20px;font-weight:900;color:#a78bfa;min-width:32px;text-align:right;}
.pgh-timer.danger{color:#ef4444;animation:blink .5s infinite;}
@keyframes blink{0%,100%{opacity:1;}50%{opacity:.4;}}
.pgh-overlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(6,3,15,.9);flex-direction:column;gap:16px;z-index:10;}
.pgh-overlay.hidden{display:none;}
.pgh-overlay h2{font-size:30px;font-weight:900;color:#a78bfa;margin:0;}
.pgh-overlay p{color:rgba(255,255,255,.55);font-size:14px;margin:0;}
.pgh-overlay button{padding:13px 38px;border-radius:12px;border:none;background:linear-gradient(135deg,#8b5cf6,#6d28d9);color:#fff;font-size:16px;font-weight:800;cursor:pointer;letter-spacing:.5px;}
.pgh-overlay button:hover{transform:translateY(-1px);opacity:.9;}
.key-hints{display:flex;gap:10px;margin-top:4px;}
.key-hint{display:flex;flex-direction:column;align-items:center;gap:4px;}
.key-hint .kb{width:44px;height:44px;border-radius:8px;border:2px solid rgba(139,92,246,.5);background:rgba(139,92,246,.12);display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:900;color:#a78bfa;}
.key-hint .lane-num{font-size:10px;color:rgba(255,255,255,.35);font-weight:600;}
.song-badge{font-size:13px;color:rgba(255,255,255,.45);background:rgba(139,92,246,.1);padding:5px 14px;border-radius:20px;border:1px solid rgba(139,92,246,.2);}
</style>`;

    const content = `<div class="pgh-wrap">
  <div class="pgh-hud">
    <div>
      <div class="pgh-score-label">النقاط</div>
      <div class="pgh-score" id="pgScore">0</div>
    </div>
    <div class="pgh-timer-wrap"><div class="pgh-timer-fill" id="pgTimerFill" style="width:100%"></div></div>
    <div class="pgh-timer" id="pgTimer">60</div>
  </div>
  <div id="pgCanvasWrap">
    <canvas id="pgCanvas"></canvas>

    <div class="pgh-overlay" id="ovStart">
      <div class="song-badge">${songEmoji} ${songName}</div>
      <h2>🎹 بيانو ماجيك</h2>
      <p>اضغط على البلاطات الصحيحة بمجرد وصولها للمنطقة المضيئة</p>
      <div class="key-hints">
        <div class="key-hint"><div class="kb">A</div><div class="lane-num">مسار 1</div></div>
        <div class="key-hint"><div class="kb">S</div><div class="lane-num">مسار 2</div></div>
        <div class="key-hint"><div class="kb">D</div><div class="lane-num">مسار 3</div></div>
        <div class="key-hint"><div class="kb">F</div><div class="lane-num">مسار 4</div></div>
      </div>
      <p style="margin-top:4px;font-size:12px;">أو اضغط على المسار مباشرة باللمس/الماوس</p>
      <button onclick="startGame()">▶ ابدأ اللعبة</button>
    </div>

    <div class="pgh-overlay hidden" id="ovWon">
      <h2>🏆 فزتَ!</h2>
      <p id="wonMsg"></p>
      <button onclick="location.href='/piano'">العب مجدداً</button>
    </div>
    <div class="pgh-overlay hidden" id="ovLost">
      <h2>💀 خسرتَ!</h2>
      <p id="lostMsg"></p>
      <button onclick="location.href='/piano'">حاول مجدداً</button>
    </div>
  </div>
</div>

<script>
const SID        = ${JSON.stringify(sid)};
const TILES_DATA = ${tilesJson};
const AUDIO_SRC  = ${JSON.stringify(audioSrc)};
const GAME_MS    = ${GAME_MS};
const SONG_BPM   = ${songBpm};
const canvas     = document.getElementById('pgCanvas');
const ctx        = canvas.getContext('2d');
  let W, H;
  let HIT_Y, TILE_W, TILE_H;

  function resize() {
    const wrap = document.getElementById('pgCanvasWrap');
    W = canvas.width  = wrap.clientWidth;
    H = canvas.height = wrap.clientHeight;
    HIT_Y  = H * 0.80;
    TILE_W = (W - 16) / 4 - 8;
    TILE_H = Math.max(60, H * 0.12);
  }
  window.addEventListener('resize', () => { resize(); });
  resize();

  const TILE_BORDER = ['#a78bfa','#818cf8','#6366f1','#8b5cf6'];
  const MISS_GRACE  = 350;
  const HIT_WINDOW  = 280;

  let phase     = 'ready';
  let startTime = null;
  let elapsed   = 0;
  let score     = 0;
  let combo     = 0;
  let tiles     = [];
  let tileIdx   = 0;
  let laneFlash = [0,0,0,0];
  let laneColor = ['','','',''];
  let missFlash = -1;
  let missTimer = 0;

  let audio = null;
  if (AUDIO_SRC) { audio = new Audio(AUDIO_SRC); audio.loop = false; }

  function getFallMs(ms) {
    // BPM 60 → slow notes (~1900ms fall), BPM 180 → fast notes (~750ms fall)
    const bpmFactor = Math.max(0.5, Math.min(2.5, SONG_BPM / 120));
    const base      = Math.round(1900 / bpmFactor);
    return Math.max(450, base - Math.min(6, Math.floor(ms / 10000)) * Math.round(150 * bpmFactor));
  }

  function spawnDue() {
    if (phase !== 'playing') return;
    const fallMs = getFallMs(elapsed);
    while (tileIdx < TILES_DATA.length) {
      const t = TILES_DATA[tileIdx];
      if (t.hitTime - elapsed > fallMs + 200) break;
      tiles.push({ ...t, hit: false, missed: false });
      tileIdx++;
    }
  }

  function pressLane(lane) {
    if (phase !== 'playing') return;
    laneFlash[lane] = 1;
    let best = null, bestDist = Infinity;
    for (const t of tiles) {
      if (t.lane !== lane || t.hit || t.missed) continue;
      const dist = Math.abs(t.hitTime - elapsed);
      if (dist < HIT_WINDOW && dist < bestDist) { best = t; bestDist = dist; }
    }
    if (best) {
      best.hit = true;
      score += 10 + Math.min(combo * 2, 40);
      combo++;
      laneColor[lane] = '#22c55e';
      document.getElementById('pgScore').textContent = score;
    } else {
      laneColor[lane] = '#ef4444';
      combo = 0;
    }
  }

  document.addEventListener('keydown', e => {
    const map = { KeyA:0, KeyS:1, KeyD:2, KeyF:3 };
    if (map[e.code] !== undefined && !e.repeat) pressLane(map[e.code]);
    if (e.code === 'Space' && phase === 'ready') startGame();
  });
  canvas.addEventListener('touchstart', e => {
    e.preventDefault();
    for (const touch of e.changedTouches) {
      const rect = canvas.getBoundingClientRect();
      pressLane(Math.floor((touch.clientX - rect.left) / (W / 4)));
    }
  }, { passive: false });
  canvas.addEventListener('mousedown', e => {
    if (phase !== 'playing') return;
    pressLane(Math.floor((e.clientX - canvas.getBoundingClientRect().left) / (W / 4)));
  });

  async function startGame() {
    document.getElementById('ovStart').classList.add('hidden');
    phase = 'playing';
    try {
      const csrf = await fetch('/piano/csrf',{credentials:'same-origin'}).then(r=>r.json()).then(d=>d.token);
      await fetch('/piano/'+SID+'/start',{
        method:'POST', credentials:'same-origin',
        headers:{'Content-Type':'application/json','x-csrf-token':csrf},
        body:'{}',
      });
    } catch(_){}
    if (audio) { audio.currentTime = 0; audio.play().catch(()=>{}); }
    startTime = performance.now();
    loop();
  }

  function loop() {
    if (phase !== 'playing') return;
    elapsed = performance.now() - startTime;
    spawnDue();
    checkMisses();
    if (elapsed >= GAME_MS) { finishGame('won'); return; }
    render();
    requestAnimationFrame(loop);
  }

  function checkMisses() {
    for (const t of tiles) {
      if (t.hit || t.missed) continue;
      if (elapsed > t.hitTime + MISS_GRACE) {
        t.missed = true; missFlash = t.lane; missTimer = elapsed;
        finishGame('lost'); return;
      }
    }
  }

  function render() {
    ctx.clearRect(0, 0, W, H);
    const bg = ctx.createLinearGradient(0,0,0,H);
    bg.addColorStop(0,'#06030f'); bg.addColorStop(1,'#0a0420');
    ctx.fillStyle=bg; ctx.fillRect(0,0,W,H);
    const laneW = W / 4;
    for (let l = 0; l < 4; l++) {
      ctx.fillStyle='rgba(10,4,32,0.6)'; ctx.fillRect(l*laneW,0,laneW,H);
      if (l>0){ ctx.strokeStyle='rgba(139,92,246,.12)';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(l*laneW,0);ctx.lineTo(l*laneW,H);ctx.stroke(); }
    }
    ctx.fillStyle='rgba(255,255,255,.1)';
    for(let i=0;i<40;i++){ ctx.beginPath();ctx.arc((i*137.5+7)%W,(i*73.1+13)%H,.8,0,Math.PI*2);ctx.fill(); }

    const fallMs = getFallMs(elapsed);
    for (const t of tiles) {
      if (t.hit || t.missed) continue;
      const tileY = HIT_Y - (t.hitTime - elapsed)*(HIT_Y/fallMs) - TILE_H/2;
      if (tileY > H + TILE_H || tileY < -TILE_H*2) continue;
      const x=t.lane*laneW+6, w=laneW-12, dist=Math.abs(t.hitTime-elapsed), inZone=dist<HIT_WINDOW;
      if(inZone){ ctx.shadowColor=TILE_BORDER[t.lane]; ctx.shadowBlur=18; }
      const grad=ctx.createLinearGradient(x,tileY,x,tileY+TILE_H);
      grad.addColorStop(0,inZone?'#4c1d95':'#2d1b69'); grad.addColorStop(1,inZone?'#6d28d9':'#1e1350');
      ctx.fillStyle=grad; ctx.beginPath(); ctx.roundRect(x,tileY,w,TILE_H,8); ctx.fill();
      ctx.strokeStyle=inZone?TILE_BORDER[t.lane]:'rgba(139,92,246,.35)'; ctx.lineWidth=inZone?2.5:1.5;
      ctx.beginPath(); ctx.roundRect(x,tileY,w,TILE_H,8); ctx.stroke(); ctx.shadowBlur=0;
    }

    ctx.fillStyle='rgba(139,92,246,.08)'; ctx.fillRect(0,HIT_Y-4,W,TILE_H+8);
    ctx.strokeStyle='rgba(139,92,246,.25)'; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(0,HIT_Y); ctx.lineTo(W,HIT_Y); ctx.stroke();

    const keyLabels=['A','S','D','F'];
    for (let l=0;l<4;l++) {
      const x=l*laneW;
      if(laneFlash[l]>0){
        ctx.fillStyle=laneColor[l]==='#22c55e'?'rgba(34,197,94,'+(laneFlash[l]*0.35)+')':'rgba(239,68,68,'+(laneFlash[l]*0.35)+')';
        ctx.fillRect(x,0,laneW,H); laneFlash[l]=Math.max(0,laneFlash[l]-0.12);
      }
      if(missFlash===l&&elapsed-missTimer<600){
        ctx.fillStyle='rgba(239,68,68,'+(0.4*(1-(elapsed-missTimer)/600))+')'; ctx.fillRect(x,0,laneW,H);
      }
      const kx=x+laneW/2, ky=HIT_Y+TILE_H+12;
      ctx.fillStyle='rgba(139,92,246,.15)'; ctx.beginPath(); ctx.roundRect(kx-22,ky,44,36,8); ctx.fill();
      ctx.strokeStyle='rgba(139,92,246,.3)'; ctx.lineWidth=1; ctx.beginPath(); ctx.roundRect(kx-22,ky,44,36,8); ctx.stroke();
      ctx.fillStyle='#a78bfa'; ctx.font='bold 16px sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.fillText(keyLabels[l],kx,ky+18);
    }

    const remaining=Math.max(0,GAME_MS-elapsed), secs=Math.ceil(remaining/1000);
    const timerEl=document.getElementById('pgTimer');
    timerEl.textContent=secs; timerEl.className='pgh-timer'+(secs<=10?' danger':'');
    document.getElementById('pgTimerFill').style.width=(Math.max(0,remaining/GAME_MS)*100)+'%';
  }

  async function finishGame(result) {
    phase = result;
    if (audio) audio.pause();
    try {
      const csrf = await fetch('/piano/csrf',{credentials:'same-origin'}).then(r=>r.json()).then(d=>d.token);
      const r = await fetch('/piano/'+SID+'/finish',{
        method:'POST', credentials:'same-origin',
        headers:{'Content-Type':'application/json','x-csrf-token':csrf},
        body:JSON.stringify({result}),
      });
      const d = await r.json();
      if (result === 'won') {
        document.getElementById('wonMsg').textContent = 'أكملت 60 ثانية! ربحت ' + (d.payout?d.payout.toLocaleString():'—') + ' عملة 🎉';
        document.getElementById('ovWon').classList.remove('hidden');
      } else {
        document.getElementById('lostMsg').textContent = 'فاتتك بلاطة في مسار ' + (missFlash>=0?['A','S','D','F'][missFlash]:'?') + ' !';
        document.getElementById('ovLost').classList.remove('hidden');
      }
    } catch(_) {
      document.getElementById(result==='won'?'ovWon':'ovLost').classList.remove('hidden');
    }
  }

  if (!CanvasRenderingContext2D.prototype.roundRect) {
    CanvasRenderingContext2D.prototype.roundRect = function(x,y,w,h,r){
      if(w<2*r)r=w/2; if(h<2*r)r=h/2;
      this.moveTo(x+r,y);this.lineTo(x+w-r,y);this.quadraticCurveTo(x+w,y,x+w,y+r);
      this.lineTo(x+w,y+h-r);this.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
      this.lineTo(x+r,y+h);this.quadraticCurveTo(x,y+h,x,y+h-r);
      this.lineTo(x,y+r);this.quadraticCurveTo(x,y,x+r,y);
      return this;
    };
  }
</script>`;

    res.send(layout('Piano Tiles - Play', content, '/piano', user, extraHead));
  });

  // ── Start session ──────────────────────────────────────────
  app.post('/piano/:sid/start', verifyCsrf, async (req, res) => {
    const sess = sessions.get(req.params.sid);
    if (!sess) return res.status(404).json({ error: 'session not found' });
    const user = req.session?.user;
    if (!user || user.id !== sess.userId) return res.status(403).json({ error: 'forbidden' });
    if (sess.started) return res.json({ ok: true });
    sess.started = true;
    sess.startedAt = Date.now();
    try {
      const dbUser = await db.findOne({ id: user.id });
      if (dbUser) {
        dbUser.coins = Math.max(0, Number(dbUser.coins || 0) - sess.amount);
        await dbUser.save();
      }
    } catch (_) {}
    res.json({ ok: true });
  });

  // ── Finish session ─────────────────────────────────────────
  app.post('/piano/:sid/finish', verifyCsrf, async (req, res) => {
    const sess = sessions.get(req.params.sid);
    if (!sess) return res.status(404).json({ error: 'session not found' });
    const user = req.session?.user;
    if (!user || user.id !== sess.userId) return res.status(403).json({ error: 'forbidden' });
    if (sess.finished) return res.json({ ok: true, payout: sess.payout || 0 });

    const { result } = req.body;
    sess.finished = true;
    sessions.delete(req.params.sid);

    let payout = 0;
    try {
      const dbUser = await db.findOne({ id: user.id });
      if (result === 'won') {
        payout = Math.floor(sess.amount * PAYOUT_MULT);
        if (dbUser) { dbUser.coins = Number(dbUser.coins || 0) + payout; dbUser.status_playing = 'no'; await dbUser.save(); }
        if (siteLog) siteLog('🎹 بيانو ماجيك', `**${user.username}** أتم التحدي وربح **${payout.toLocaleString()}** عملة`, '#22c55e').catch(() => {});
      } else {
        if (dbUser) { dbUser.status_playing = 'no'; await dbUser.save(); }
      }
    } catch (_) {}
    res.json({ ok: true, payout });
  });

  // ── Songs API (owner use) ──────────────────────────────────
  app.get('/piano/songs', (req, res) => {
    res.json(loadSongs());
  });

};

routeSetup.createSession    = createSession;
routeSetup.createBotSession = createBotSession;
routeSetup.botPianoSessions = botPianoSessions;
routeSetup.sessions         = sessions;
routeSetup.loadSongs        = loadSongs;
routeSetup.saveSongs        = saveSongs;
module.exports = routeSetup;
