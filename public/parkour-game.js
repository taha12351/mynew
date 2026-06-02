// ╔══════════════════════════════════════════════════════════════╗
// ║  Diamond Casino — Parkour Game Client                       ║
// ╚══════════════════════════════════════════════════════════════╝
(function(){
'use strict';

const CFG  = window.__PKR;
if(!CFG) return;

const canvas = document.getElementById('parkourCanvas');
const ctx    = canvas.getContext('2d');
const MAP    = CFG.map;

// ── Viewport ─────────────────────────────────────────────────
const VIEW_W = 900, VIEW_H = 540;
canvas.width  = VIEW_W;
canvas.height = VIEW_H;

// ── Physics constants ─────────────────────────────────────────
const GRAVITY  = 0.55;
const JUMP_FORCE = -13.5;
const MOVE_SPEED = 4.2;
const MAX_FALL  = 18;

// ── Audio disabled ────────────────────────────────────────────
function initAudio(){}
function sfxJump(){}
function sfxLand(){}
function sfxDie(){}
function sfxWin(){}
function sfxLose(){}
function sfxStart(){}

// ── Input ─────────────────────────────────────────────────────
const keys = {};
document.addEventListener('keydown', e=>{
  keys[e.code] = true;
  e.preventDefault && ['ArrowLeft','ArrowRight','ArrowUp','Space','KeyR'].includes(e.code) && e.preventDefault();
});
document.addEventListener('keyup', e=>{ keys[e.code] = false; });

// Touch control helper — called from inline handlers in HTML
window.pkrTouch = function(code, down){
  keys[code] = down;
  const map = { ArrowLeft:'btnLeft', ArrowRight:'btnRight', ArrowUp:'btnJump' };
  const el = map[code] ? document.getElementById(map[code]) : null;
  if(el){ down ? el.classList.add('pressed') : el.classList.remove('pressed'); }
};

// Make canvas scale properly inside its container
(function scaleCanvas(){
  const c = document.getElementById('parkourCanvas');
  if(!c) return;
  c.style.width = '100%';
  c.style.height = 'auto';
})();

// ── Moving/animated platform state ────────────────────────────
const movingOffsets = {};
const crumbleState = {}; // index -> { timer, crumbled }
MAP.platforms.forEach((p,i)=>{
  if(p.type==='moving') movingOffsets[i] = { t:0, dir:1 };
  if(p.type==='crumble') crumbleState[i] = { timer:0, crumbled:false };
});

function getPlat(p, i){
  if(p.type==='crumble' && crumbleState[i]?.crumbled) return { x:p.x, y:p.y+2000, w:p.w, h:p.h }; // hide it
  if(p.type!=='moving') return { x:p.x, y:p.y, w:p.w, h:p.h };
  const off = movingOffsets[i] || {t:0};
  if(p.moveAxis==='x') return { x:p.x + off.t, y:p.y, w:p.w, h:p.h };
  return { x:p.x, y:p.y + off.t, w:p.w, h:p.h };
}

function updateMoving(dt){
  MAP.platforms.forEach((p,i)=>{
    if(p.type==='moving'){
      const m = movingOffsets[i];
      m.t += p.moveSpeed * m.dir * dt;
      if(m.t > p.moveRange){ m.t = p.moveRange; m.dir = -1; }
      if(m.t < 0){ m.t = 0; m.dir = 1; }
    }
    if(p.type==='crumble' && crumbleState[i]){
      const cs = crumbleState[i];
      if(cs.timer > 0){ cs.timer -= dt; if(cs.timer <= 0) cs.crumbled = true; }
    }
  });
}

// ── Lava zones ────────────────────────────────────────────────
const LAVA = MAP.lava || [];

// ── Player ────────────────────────────────────────────────────
function makePlayer(spawn, role, color){
  return { x:spawn.x, y:spawn.y, vx:0, vy:0, w:28, h:36,
    onGround:false, facing:1, frame:0, frameTimer:0, state:'idle',
    dead:false, finished:false, role, color,
    jumpBuffer:0, coyoteTime:0 };
}

const myRole  = CFG.myRole;
const isP1    = myRole==='player1';
const mySpawn = isP1 ? MAP.spawn.p1 : MAP.spawn.p2;
const myColor = isP1 ? '#38bdf8' : '#fbbf24';
const opColor = isP1 ? '#fbbf24' : '#38bdf8';

let myPlayer = makePlayer(mySpawn, myRole, myColor);
let opPlayer = null; // remote player position (ghost)

// ── Camera ────────────────────────────────────────────────────
let camX = 0, camY = 0;
function updateCamera(){
  const tx = myPlayer.x - VIEW_W/2;
  const ty = myPlayer.y - VIEW_H/2;
  camX += (tx - camX) * 0.08;
  camY += (ty - camY) * 0.08;
  camX = Math.max(0, Math.min(MAP.width - VIEW_W, camX));
  camY = Math.max(0, Math.min(MAP.height - VIEW_H, camY));
}

// ── Game state ─────────────────────────────────────────────────
let gamePhase = CFG.status; // waiting|active|finished
let startCountdown = -1;
let startAt = null;
let meReady = false;
let opReady = false;
let posSendTimer = 0;
let lastT = performance.now();
let gameResult = CFG.result || null;
let myFinished = false;
let deathTimer = 0;
let deathRespawnAt = 0;

// ── SSE connection ─────────────────────────────────────────────
const sse = new EventSource(`/api/parkour/sse/${CFG.gameId}`);
sse.onmessage = e => {
  try {
    const d = JSON.parse(e.data);
    if(d.type==='pos' && d.role !== (isP1?'p1':'p2')){
      if(!opPlayer) opPlayer = { x:d.x, y:d.y, vx:d.vx, vy:d.vy, facing:d.facing, frame:d.frame, state:d.state };
      else Object.assign(opPlayer, { x:d.x, y:d.y, vx:d.vx, vy:d.vy, facing:d.facing, frame:d.frame, state:d.state });
    }
    if(d.type==='ready'){
      opReady = isP1 ? d.p2 : d.p1;
      meReady = isP1 ? d.p1 : d.p2;
      updateReadyUI();
    }
    if(d.type==='start'){
      startAt = d.startAt;
      gamePhase = 'counting';
      sfxStart();
    }
    if(d.type==='finished' || d.type==='one_finished'){
      if(d.type==='finished'){
        gameResult = d.result;
        gamePhase = 'finished';
        showResult(d.result);
      }
    }
    if(d.type==='player_died'){
      // visual indicator
    }
  } catch(err){}
};

function updateReadyUI(){
  const p1el = document.getElementById('p1status');
  const p2el = document.getElementById('p2status');
  if(p1el) p1el.textContent = (isP1 ? meReady : opReady) ? '✅ جاهز' : '⏳ بانتظار';
  if(p2el) p2el.textContent = (isP1 ? opReady : meReady) ? '✅ جاهز' : '⏳ بانتظار';
}

function showResult(result){
  const banner = document.getElementById('resultBanner');
  const isWin = (result==='player1'&&isP1) || (result==='player2'&&!isP1);
  const isDraw = result==='draw';
  if(banner){
    banner.style.display = 'block';
    if(isDraw){ banner.textContent = '🤝 Draw!'; banner.style.background='linear-gradient(135deg,#f59e0b,#fbbf24)'; }
    else if(isWin){ banner.textContent = '🏆 You Win! 🎉'; banner.style.background='linear-gradient(135deg,#10b981,#34d399)'; sfxWin(); }
    else { banner.textContent = '💀 You Lose!'; banner.style.background='linear-gradient(135deg,#ef4444,#dc2626)'; sfxLose(); }
  }
  const rb = document.getElementById('readyBtn');
  if(rb) rb.style.display='none';
  const status = document.getElementById('gameStatus');
  if(status) status.textContent = '🏁 Game Over';
}

// ── Physics helpers ────────────────────────────────────────────
function rectOverlap(ax,ay,aw,ah, bx,by,bw,bh){
  return ax < bx+bw && ax+aw > bx && ay < by+bh && ay+ah > by;
}

// track ice/boost state per frame
let playerOnIce = false;
let playerOnBoost = false;

function resolveCollisions(player){
  player.onGround = false;
  playerOnIce = false;
  playerOnBoost = false;
  MAP.platforms.forEach((p,i)=>{
    const plat = getPlat(p,i);
    if(!rectOverlap(player.x,player.y,player.w,player.h, plat.x,plat.y,plat.w,plat.h)) return;
    const overlapL = (player.x+player.w) - plat.x;
    const overlapR = (plat.x+plat.w) - player.x;
    const overlapT = (player.y+player.h) - plat.y;
    const overlapB = (plat.y+plat.h) - player.y;
    const minH = Math.min(overlapL,overlapR);
    const minV = Math.min(overlapT,overlapB);
    if(minV < minH){
      if(overlapT < overlapB){
        // Landing on top
        if(p.type==='spring'){
          // Spring: big bounce
          player.y = plat.y - player.h;
          player.vy = -22;
          player.onGround = false;
          player.coyoteTime = 0;
          sfxJump();
          return;
        }
        if(p.type==='boost'){
          // Boost pad: horizontal speed burst
          player.y = plat.y - player.h;
          if(player.vy > 0) player.vy = 0;
          player.onGround = true;
          player.coyoteTime = 8;
          playerOnBoost = true;
          const dir = (p.direction||1);
          player.vx = MOVE_SPEED * 3.5 * dir;
          return;
        }
        if(p.type==='crumble' && crumbleState[i]){
          // Crumble: start countdown, still solid
          if(!crumbleState[i].crumbled && crumbleState[i].timer === 0){
            crumbleState[i].timer = 60; // 1 second at 60fps
          }
        }
        player.y = plat.y - player.h;
        if(player.vy > 0){ player.vy = 0; if(!player.onGround) sfxLand(); }
        player.onGround = true;
        player.coyoteTime = 8;
        if(p.type==='ice') playerOnIce = true;
        // Move with platform
        if(p.type==='moving' && p.moveAxis==='x'){
          player.x += p.moveSpeed * movingOffsets[i].dir;
        }
      } else {
        player.y = plat.y + plat.h;
        if(player.vy < 0) player.vy = 0;
      }
    } else {
      if(overlapL < overlapR){ player.x = plat.x - player.w; if(player.vx>0)player.vx=0; }
      else { player.x = plat.x + plat.w; if(player.vx<0)player.vx=0; }
    }
  });
}

function checkSpikes(player){
  for(const s of MAP.spikes){
    if(rectOverlap(player.x+4,player.y+4,player.w-8,player.h-8, s.x,s.y,s.w,s.h)) return true;
  }
  // Also check lava zones
  for(const l of LAVA){
    if(rectOverlap(player.x+2,player.y+2,player.w-4,player.h-4, l.x,l.y,l.w,l.h)) return true;
  }
  return false;
}

function checkFinish(player){
  const f = MAP.finish;
  return rectOverlap(player.x,player.y,player.w,player.h, f.x,f.y,f.w,f.h);
}

// ── Update ────────────────────────────────────────────────────
function update(dt){
  if(!CFG.isPlayer) return;
  if(gamePhase==='finished' || gamePhase==='waiting') return;

  const now = Date.now();
  if(gamePhase==='counting'){
    const remaining = startAt ? (startAt - now)/1000 : 99;
    if(remaining <= 0) gamePhase = 'playing';
    return;
  }
  if(gamePhase!=='playing') return;
  if(myPlayer.dead){
    deathTimer -= dt;
    if(deathTimer <= 0){
      // Respawn
      myPlayer.x = mySpawn.x; myPlayer.y = mySpawn.y;
      myPlayer.vx = 0; myPlayer.vy = 0;
      myPlayer.dead = false; myPlayer.state = 'idle';
    }
    return;
  }

  // Horizontal (ice = less friction, boost = keep momentum)
  const friction = playerOnIce ? 0.97 : playerOnBoost ? 0.99 : 0.75;
  if(keys['ArrowLeft'] || keys['KeyA']){ myPlayer.vx = playerOnIce ? Math.max(myPlayer.vx-0.8,-MOVE_SPEED) : -MOVE_SPEED; myPlayer.facing = -1; }
  else if(keys['ArrowRight'] || keys['KeyD']){ myPlayer.vx = playerOnIce ? Math.min(myPlayer.vx+0.8, MOVE_SPEED) : MOVE_SPEED; myPlayer.facing = 1; }
  else { myPlayer.vx *= friction; if(Math.abs(myPlayer.vx)<0.1&&!playerOnIce&&!playerOnBoost)myPlayer.vx=0; }

  // Jump
  if(myPlayer.coyoteTime > 0) myPlayer.coyoteTime--;
  if(myPlayer.jumpBuffer > 0) myPlayer.jumpBuffer--;
  if(keys['ArrowUp'] || keys['Space'] || keys['KeyW']){ myPlayer.jumpBuffer = 8; }
  if(myPlayer.jumpBuffer > 0 && myPlayer.coyoteTime > 0){
    myPlayer.vy = JUMP_FORCE; myPlayer.jumpBuffer = 0; myPlayer.coyoteTime = 0;
    sfxJump();
  }
  if(keys['KeyR']){ myPlayer.x=mySpawn.x; myPlayer.y=mySpawn.y; myPlayer.vx=0; myPlayer.vy=0; }

  // Gravity
  myPlayer.vy = Math.min(myPlayer.vy + GRAVITY, MAX_FALL);
  myPlayer.x += myPlayer.vx;
  myPlayer.y += myPlayer.vy;

  // World bounds
  myPlayer.x = Math.max(0, Math.min(MAP.width - myPlayer.w, myPlayer.x));

  resolveCollisions(myPlayer);

  // Animation state
  if(!myPlayer.onGround){ myPlayer.state = myPlayer.vy < 0 ? 'jump' : 'fall'; }
  else if(Math.abs(myPlayer.vx) > 0.5){ myPlayer.state = 'run'; }
  else { myPlayer.state = 'idle'; }
  myPlayer.frameTimer++;
  if(myPlayer.frameTimer > 6){ myPlayer.frame=(myPlayer.frame+1)%4; myPlayer.frameTimer=0; }

  // Death: fell off or spikes
  if(myPlayer.y > MAP.height + 50){
    myPlayer.dead = true; myPlayer.state='dead'; myPlayer.vy=0; myPlayer.vx=0;
    deathTimer = 90;
    sfxDie();
    fetch(`/api/parkour/died`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({gameId:CFG.gameId}) }).catch(()=>{});
  }
  if(checkSpikes(myPlayer)){
    myPlayer.dead = true; myPlayer.state='dead'; myPlayer.vy=0; myPlayer.vx=0;
    deathTimer = 90; sfxDie();
    fetch(`/api/parkour/died`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({gameId:CFG.gameId}) }).catch(()=>{});
  }

  // Finish
  if(!myFinished && checkFinish(myPlayer)){
    myFinished = true; sfxWin();
    fetch(`/api/parkour/finish`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({gameId:CFG.gameId}) }).catch(()=>{});
  }

  updateCamera();
}

// ── Send position ─────────────────────────────────────────────
function sendPosition(){
  if(!CFG.isPlayer || gamePhase!=='playing') return;
  fetch(`/api/parkour/position`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ gameId:CFG.gameId,
      x:myPlayer.x, y:myPlayer.y, vx:myPlayer.vx, vy:myPlayer.vy,
      facing:myPlayer.facing, frame:myPlayer.frame, state:myPlayer.state })
  }).catch(()=>{});
}

// ── Draw helpers ───────────────────────────────────────────────
function drawCharacter(cx, cy, facing, frame, state, color, label, dead){
  ctx.save();
  ctx.translate(cx, cy);
  if(facing < 0) ctx.scale(-1,1);

  // Shadow
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath(); ctx.ellipse(14, 38, 12, 4, 0, 0, Math.PI*2); ctx.fill();

  if(dead){
    // Dead X eyes
    ctx.fillStyle = color;
    ctx.fillRect(2, 10, 24, 22); // body
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(5, 12, 20, 14); // body inner
    ctx.fillStyle = color;
    ctx.fillRect(6, 2, 16, 12); // head
    // X eyes
    ctx.strokeStyle = '#ef4444'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(8,4); ctx.lineTo(12,8); ctx.moveTo(12,4); ctx.lineTo(8,8); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(16,4); ctx.lineTo(20,8); ctx.moveTo(20,4); ctx.lineTo(16,8); ctx.stroke();
  } else {
    // Body
    const bobY = state==='run' ? Math.sin(frame*1.6)*2 : 0;
    // Legs
    const legPhase = state==='run' ? frame : 0;
    ctx.fillStyle = color === '#38bdf8' ? '#0369a1' : '#b45309';
    ctx.fillRect(3, 24+bobY, 8, 14 + (legPhase%2===0?2:0)); // left leg
    ctx.fillRect(17, 24+bobY, 8, 14 + (legPhase%2===1?2:0)); // right leg
    // Body
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.roundRect(2, 10+bobY, 24, 16, 4); ctx.fill();
    // Arms
    const armSwing = state==='run' ? Math.sin(frame*1.6)*6 : (state==='jump'?-8:0);
    ctx.fillStyle = color;
    ctx.fillRect(-3, 14+bobY+armSwing, 6, 10); // left arm
    ctx.fillRect(25, 14+bobY-armSwing, 6, 10); // right arm
    // Head
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.roundRect(4, 0+bobY, 20, 14, 6); ctx.fill();
    // Eyes
    ctx.fillStyle = '#1a1a2e';
    ctx.beginPath(); ctx.ellipse(11, 6+bobY, 3, 3.5, 0, 0, Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(20, 6+bobY, 3, 3.5, 0, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.ellipse(12, 5.5+bobY, 1.2, 1.5, 0, 0, Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(21, 5.5+bobY, 1.2, 1.5, 0, 0, Math.PI*2); ctx.fill();
    // Jump trail
    if(state==='jump'){
      ctx.fillStyle = 'rgba(255,255,255,0.15)';
      ctx.fillRect(5, 32, 18, 8);
    }
  }

  ctx.restore();

  // Name label
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.beginPath();
  const lw = ctx.measureText(label).width + 10;
  ctx.roundRect(cx + 14 - lw/2, cy - 20, lw, 18, 4);
  ctx.fill();
  ctx.fillStyle = dead ? '#ef4444' : color;
  ctx.font = 'bold 11px Cairo, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(label, cx + 14, cy - 7);
}

function drawBackground(){
  // Sky gradient
  const skyGrad = ctx.createLinearGradient(0,0,0,VIEW_H);
  skyGrad.addColorStop(0,'#0c0c2e');
  skyGrad.addColorStop(0.6,'#1a1a3e');
  skyGrad.addColorStop(1,'#0d1117');
  ctx.fillStyle = skyGrad;
  ctx.fillRect(0,0,VIEW_W,VIEW_H);

  // Stars
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  const starSeed = 42;
  for(let i=0;i<80;i++){
    const sx = ((i*373+starSeed)%4800-camX)*0.2 % VIEW_W;
    const sy = ((i*131+starSeed)%600-camY)*0.15 % VIEW_H;
    if(sx<0||sx>VIEW_W||sy<0||sy>VIEW_H) continue;
    ctx.fillRect(sx,sy,1.5,1.5);
  }

  // Mountains (parallax)
  ctx.fillStyle = '#1a1a35';
  for(let m=0;m<8;m++){
    const mx = (m*600 - camX*0.3) % (MAP.width*0.3);
    const mh = 160 + (m%3)*60;
    ctx.beginPath();
    ctx.moveTo(mx-camX*0.1, VIEW_H);
    ctx.lineTo(mx - camX*0.1 + 120, VIEW_H - mh);
    ctx.lineTo(mx - camX*0.1 + 240, VIEW_H);
    ctx.closePath(); ctx.fill();
  }
}

function drawPlatform(p, i){
  const plat = getPlat(p, i);
  const sx = plat.x - camX, sy = plat.y - camY;
  if(sx > VIEW_W+50 || sx+plat.w < -50) return;
  if(sy > VIEW_H+20 || sy+plat.h < -20) return;

  if(p.type==='ground'){
    // Ground: brick-style
    ctx.fillStyle = '#2d2d4a';
    ctx.fillRect(sx, sy, plat.w, plat.h);
    ctx.fillStyle = '#3d3d5c';
    ctx.fillRect(sx, sy, plat.w, 4);
    // Grass top
    ctx.fillStyle = '#1e5c2a';
    ctx.fillRect(sx, sy-4, plat.w, 6);
    ctx.fillStyle = '#22703a';
    for(let bx=sx;bx<sx+plat.w;bx+=6){
      ctx.fillRect(bx, sy-6, 4, 4);
    }
  } else if(p.type==='platform') {
    // Platform: wooden
    const grad = ctx.createLinearGradient(sx, sy, sx, sy+plat.h);
    grad.addColorStop(0,'#8b6914');
    grad.addColorStop(1,'#5c450d');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.roundRect(sx, sy, plat.w, plat.h, 4); ctx.fill();
    ctx.strokeStyle = '#a07820'; ctx.lineWidth = 1.5;
    ctx.stroke();
    // Wood grain lines
    ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth=1;
    for(let wx=sx+8;wx<sx+plat.w-4;wx+=8){
      ctx.beginPath(); ctx.moveTo(wx,sy+2); ctx.lineTo(wx,sy+plat.h-2); ctx.stroke();
    }
  } else if(p.type==='moving'){
    // Moving: glowing purple
    const grad = ctx.createLinearGradient(sx, sy, sx, sy+plat.h);
    grad.addColorStop(0,'#7c3aed');
    grad.addColorStop(1,'#4c1d95');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.roundRect(sx, sy, plat.w, plat.h, 5); ctx.fill();
    ctx.strokeStyle = '#a78bfa'; ctx.lineWidth=1.5; ctx.stroke();
    ctx.shadowColor='#8b5cf6'; ctx.shadowBlur=10;
    ctx.beginPath(); ctx.roundRect(sx, sy, plat.w, plat.h, 5); ctx.stroke();
    ctx.shadowBlur=0;
  } else if(p.type==='spring'){
    // Spring: green coil pad
    const grad = ctx.createLinearGradient(sx, sy, sx, sy+plat.h);
    grad.addColorStop(0,'#22c55e');
    grad.addColorStop(1,'#15803d');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.roundRect(sx, sy+plat.h*0.5, plat.w, plat.h*0.5, [0,0,4,4]); ctx.fill();
    // Coil lines
    ctx.strokeStyle = '#4ade80'; ctx.lineWidth = 2;
    const coils = 4;
    for(let c=0;c<coils;c++){
      const cy = sy + plat.h * 0.5 + (c / coils) * plat.h * 0.5;
      ctx.beginPath(); ctx.moveTo(sx+4, cy); ctx.lineTo(sx+plat.w-4, cy); ctx.stroke();
    }
    // Top bounce pad
    ctx.fillStyle = '#4ade80';
    ctx.beginPath(); ctx.roundRect(sx, sy, plat.w, plat.h*0.5, 4); ctx.fill();
    ctx.strokeStyle = '#86efac'; ctx.lineWidth=1.5; ctx.stroke();
    // Glow
    ctx.shadowColor='#22c55e'; ctx.shadowBlur=8;
    ctx.strokeStyle='#4ade80'; ctx.lineWidth=1;
    ctx.beginPath(); ctx.roundRect(sx, sy, plat.w, plat.h, 4); ctx.stroke();
    ctx.shadowBlur=0;
    // Label
    ctx.fillStyle='#fff'; ctx.font='bold 10px Rajdhani,sans-serif'; ctx.textAlign='center';
    ctx.fillText('SPRING', sx+plat.w/2, sy+plat.h/2+4);
  } else if(p.type==='ice'){
    // Ice: icy blue translucent
    const grad = ctx.createLinearGradient(sx, sy, sx, sy+plat.h);
    grad.addColorStop(0,'rgba(147,210,255,0.9)');
    grad.addColorStop(1,'rgba(59,130,246,0.8)');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.roundRect(sx, sy, plat.w, plat.h, 4); ctx.fill();
    ctx.strokeStyle = 'rgba(191,219,254,0.8)'; ctx.lineWidth=1.5; ctx.stroke();
    // Ice shine
    ctx.fillStyle='rgba(255,255,255,0.35)';
    ctx.beginPath(); ctx.roundRect(sx+4, sy+2, plat.w-8, plat.h*0.4, 3); ctx.fill();
    // Snowflakes
    ctx.fillStyle='rgba(255,255,255,0.7)'; ctx.font='10px sans-serif'; ctx.textAlign='center';
    for(let fi=0;fi<Math.floor(plat.w/30);fi++){
      ctx.fillText('❄', sx + 15 + fi*30, sy+plat.h-3);
    }
    ctx.shadowColor='#60a5fa'; ctx.shadowBlur=6;
    ctx.beginPath(); ctx.roundRect(sx, sy, plat.w, plat.h, 4); ctx.stroke();
    ctx.shadowBlur=0;
  } else if(p.type==='boost'){
    // Boost: yellow arrow pad
    const dir = p.direction||1;
    const grad = ctx.createLinearGradient(sx, sy, sx, sy+plat.h);
    grad.addColorStop(0,'#fbbf24');
    grad.addColorStop(1,'#d97706');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.roundRect(sx, sy, plat.w, plat.h, 4); ctx.fill();
    ctx.strokeStyle = '#fde68a'; ctx.lineWidth=1.5; ctx.stroke();
    // Arrows
    ctx.fillStyle='rgba(255,255,255,0.9)'; ctx.font='bold 14px sans-serif'; ctx.textAlign='center';
    const arrowCount = Math.max(1, Math.floor(plat.w/28));
    for(let ai=0;ai<arrowCount;ai++){
      ctx.fillText(dir>0?'→':'←', sx + (ai+0.5)*(plat.w/arrowCount), sy+plat.h/2+5);
    }
    ctx.shadowColor='#fbbf24'; ctx.shadowBlur=8;
    ctx.beginPath(); ctx.roundRect(sx, sy, plat.w, plat.h, 4); ctx.stroke();
    ctx.shadowBlur=0;
  } else if(p.type==='crumble'){
    // Crumble: brown platform that shakes when stood on
    const cs = crumbleState[Object.keys(crumbleState).find(k=>MAP.platforms[k]===p)] || {timer:0};
    const shake = cs.timer>0 ? Math.sin(Date.now()*0.08)*(cs.timer/60)*3 : 0;
    const alpha = cs.crumbled ? 0 : (cs.timer>0 ? 0.5+0.5*(cs.timer/60) : 1);
    ctx.globalAlpha = alpha;
    const grad = ctx.createLinearGradient(sx, sy+shake, sx, sy+shake+plat.h);
    grad.addColorStop(0,'#a16207');
    grad.addColorStop(1,'#713f12');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.roundRect(sx+shake, sy+shake, plat.w, plat.h, 3); ctx.fill();
    ctx.strokeStyle='#ca8a04'; ctx.lineWidth=1.5; ctx.stroke();
    // Crack lines if crumbling
    if(cs.timer>0){
      ctx.strokeStyle='rgba(0,0,0,0.4)'; ctx.lineWidth=1;
      ctx.beginPath(); ctx.moveTo(sx+plat.w*0.3,sy); ctx.lineTo(sx+plat.w*0.4,sy+plat.h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(sx+plat.w*0.7,sy); ctx.lineTo(sx+plat.w*0.6,sy+plat.h); ctx.stroke();
    }
    ctx.globalAlpha=1;
  }
}

function drawLava(){
  const t = Date.now() * 0.002;
  for(const l of LAVA){
    const sx = l.x - camX, sy = l.y - camY;
    if(sx > VIEW_W+50 || sx+l.w < -50) continue;
    // Lava base
    const grad = ctx.createLinearGradient(sx, sy, sx, sy+l.h);
    grad.addColorStop(0,'#ef4444');
    grad.addColorStop(0.5,'#dc2626');
    grad.addColorStop(1,'#7f1d1d');
    ctx.fillStyle = grad;
    ctx.fillRect(sx, sy, l.w, l.h);
    // Bubble animation
    ctx.fillStyle='#f97316';
    for(let b=0;b<Math.floor(l.w/20);b++){
      const bx = sx + 10 + b*20 + Math.sin(t+b)*4;
      const by = sy + l.h*0.3 + Math.sin(t*1.5+b*0.7)*6;
      ctx.beginPath(); ctx.arc(bx, by, 5, 0, Math.PI*2); ctx.fill();
    }
    // Glow
    ctx.shadowColor='#ef4444'; ctx.shadowBlur=20;
    ctx.strokeStyle='#fca5a5'; ctx.lineWidth=2;
    ctx.strokeRect(sx, sy, l.w, l.h);
    ctx.shadowBlur=0;
    // Label
    ctx.fillStyle='rgba(255,255,255,0.6)'; ctx.font='bold 11px Rajdhani,sans-serif'; ctx.textAlign='center';
    ctx.fillText('⚠ LAVA', sx+l.w/2, sy+l.h/2+4);
  }
}

function drawSpikes(){
  for(const s of MAP.spikes){
    const sx = s.x - camX, sy = s.y - camY;
    if(sx > VIEW_W+20 || sx+s.w < -20) continue;
    ctx.fillStyle = '#ef4444';
    const n = Math.floor(s.w/12);
    for(let i=0;i<n;i++){
      const tx = sx + i*12 + 6;
      ctx.beginPath();
      ctx.moveTo(tx-5, sy+s.h);
      ctx.lineTo(tx+5, sy+s.h);
      ctx.lineTo(tx,   sy);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle='#ff6b6b'; ctx.lineWidth=0.8; ctx.stroke();
    }
  }
}

function drawFinish(){
  const f = MAP.finish;
  const fx = f.x - camX, fy = f.y - camY;
  if(fx > VIEW_W+60 || fx+f.w < -60) return;

  // Pole
  ctx.fillStyle = '#94a3b8';
  ctx.fillRect(fx + f.w/2 - 3, fy, 6, f.h);
  // Flag
  const wave = Math.sin(Date.now()*0.003)*8;
  ctx.fillStyle = '#f59e0b';
  ctx.beginPath();
  ctx.moveTo(fx + f.w/2 + 3, fy + 5);
  ctx.lineTo(fx + f.w/2 + 40 + wave, fy + 15);
  ctx.lineTo(fx + f.w/2 + 3, fy + 30);
  ctx.closePath(); ctx.fill();
  // Glow
  ctx.shadowColor = '#f59e0b'; ctx.shadowBlur = 20;
  ctx.strokeStyle = '#fbbf24'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.rect(fx, fy, f.w, f.h); ctx.stroke();
  ctx.shadowBlur = 0;

  // "FINISH" text
  ctx.fillStyle = '#fbbf24';
  ctx.font = 'bold 16px Rajdhani, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('FINISH', fx+f.w/2, fy-8);
}

function drawHUD(){
  // Progress bar
  const progressW = VIEW_W - 40;
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.beginPath(); ctx.roundRect(20, 10, progressW, 12, 6); ctx.fill();

  // My progress
  const myProg = Math.min(1, myPlayer.x / (MAP.finish.x + MAP.finish.w));
  ctx.fillStyle = myColor;
  ctx.beginPath(); ctx.roundRect(20, 10, progressW * myProg, 12, 6); ctx.fill();

  // Op progress
  if(opPlayer){
    const opProg = Math.min(1, opPlayer.x / (MAP.finish.x + MAP.finish.w));
    ctx.fillStyle = opColor;
    ctx.fillRect(20 + progressW*opProg - 2, 8, 4, 16);
  }

  // My dot
  ctx.fillStyle = myColor;
  ctx.beginPath(); ctx.arc(20 + progressW*myProg, 16, 7, 0, Math.PI*2); ctx.fill();
  ctx.strokeStyle='#fff'; ctx.lineWidth=1.5; ctx.stroke();

  // Labels
  ctx.fillStyle = myColor; ctx.font='bold 10px Cairo,sans-serif'; ctx.textAlign='left';
  ctx.fillText(CFG.myRole==='player1'?CFG.player1Username:CFG.player2Username, 20, 36);
  ctx.fillStyle = opColor; ctx.textAlign='right';
  ctx.fillText(CFG.myRole==='player1'?CFG.player2Username:CFG.player1Username, VIEW_W-20, 36);

  // Countdown
  if(gamePhase==='counting' && startAt){
    const now = Date.now();
    const secs = Math.ceil((startAt - now) / 1000);
    if(secs > 0){
      ctx.fillStyle='rgba(0,0,0,0.7)';
      ctx.fillRect(0,0,VIEW_W,VIEW_H);
      ctx.fillStyle='#fff';
      ctx.font='bold 80px Rajdhani,sans-serif';
      ctx.textAlign='center';
      ctx.fillText(secs, VIEW_W/2, VIEW_H/2+30);
      ctx.font='20px Rajdhani,sans-serif';
      ctx.fillText('GET READY!', VIEW_W/2, VIEW_H/2+70);
    }
  }

  if(gamePhase==='waiting'){
    ctx.fillStyle='rgba(0,0,0,0.6)';
    ctx.fillRect(0,0,VIEW_W,VIEW_H);
    ctx.fillStyle='#94a3b8';
    ctx.font='18px Rajdhani,sans-serif'; ctx.textAlign='center';
    ctx.fillText('⏳ Waiting for challenge acceptance...', VIEW_W/2, VIEW_H/2);
  }

  if(gamePhase==='active' || gamePhase==='playing'){
    if(!meReady && CFG.isPlayer){
      ctx.fillStyle='rgba(0,0,0,0.6)';
      ctx.fillRect(0,0,VIEW_W,VIEW_H);
      ctx.fillStyle='#f1f5f9';
      ctx.font='bold 22px Rajdhani,sans-serif'; ctx.textAlign='center';
      ctx.fillText('Click "Ready to Play!" to start', VIEW_W/2, VIEW_H/2);
    }
    if(meReady && !opReady && CFG.isPlayer){
      ctx.fillStyle='rgba(0,0,0,0.5)';
      ctx.fillRect(0,0,VIEW_W,VIEW_H);
      ctx.fillStyle='#94a3b8';
      ctx.font='18px Rajdhani,sans-serif'; ctx.textAlign='center';
      ctx.fillText('✅ Ready! Waiting for opponent...', VIEW_W/2, VIEW_H/2);
    }
  }

  if(!CFG.isPlayer){
    ctx.fillStyle='rgba(139,92,246,0.15)';
    ctx.fillRect(0,VIEW_H-28,VIEW_W,28);
    ctx.fillStyle='#a78bfa'; ctx.font='12px Rajdhani,sans-serif'; ctx.textAlign='center';
    ctx.fillText('👁️ Spectator Mode — you cannot play', VIEW_W/2, VIEW_H-10);
  }

  if(myPlayer.dead && deathTimer > 0){
    ctx.fillStyle='rgba(239,68,68,0.3)';
    ctx.fillRect(0,0,VIEW_W,VIEW_H);
    ctx.fillStyle='#fca5a5'; ctx.font='bold 24px Rajdhani,sans-serif'; ctx.textAlign='center';
    ctx.fillText('💀 Dead! Respawning...', VIEW_W/2, VIEW_H/2);
  }
}

// ── Main loop ─────────────────────────────────────────────────
let animId;
function loop(t){
  animId = requestAnimationFrame(loop);
  const dt = Math.min((t - lastT)/16.67, 3);
  lastT = t;

  updateMoving(dt);
  update(dt);

  // Draw
  ctx.clearRect(0,0,VIEW_W,VIEW_H);
  drawBackground();

  ctx.save();
  // Draw map elements
  drawLava();
  MAP.platforms.forEach((p,i)=>drawPlatform(p,i));
  drawSpikes();
  drawFinish();

  // Draw ghost (opponent)
  if(opPlayer){
    const opName = CFG.myRole==='player1' ? CFG.player2Username : CFG.player1Username;
    drawCharacter(opPlayer.x-camX, opPlayer.y-camY, opPlayer.facing||1, opPlayer.frame||0, opPlayer.state||'idle', opColor+'aa', opName, false);
  }

  // Draw my character (spectators see nothing)
  if(CFG.isPlayer){
    const myName = CFG.myRole==='player1' ? CFG.player1Username : CFG.player2Username;
    drawCharacter(myPlayer.x-camX, myPlayer.y-camY, myPlayer.facing, myPlayer.frame, myPlayer.state, myColor, myName, myPlayer.dead);
  }
  ctx.restore();

  drawHUD();

  // Send position every ~100ms
  posSendTimer += dt;
  if(posSendTimer > 6){ posSendTimer=0; sendPosition(); }
}
requestAnimationFrame(loop);

// Poll game state when not active yet
let pollInterval = null;
if(CFG.status !== 'active'){
  pollInterval = setInterval(()=>{
    fetch(`/api/parkour/game/${CFG.gameId}`).then(r=>r.json()).then(d=>{
      if(d.status==='active' && gamePhase==='waiting'){
        gamePhase = 'active';
        document.getElementById('gameStatus').textContent = '⏳ بانتظار جهوزية اللاعبين';
        if(pollInterval){ clearInterval(pollInterval); pollInterval=null; }
      }
      if(d.status==='finished' && gamePhase!=='finished'){
        gamePhase='finished';
        gameResult = d.result;
        showResult(d.result);
        if(pollInterval){ clearInterval(pollInterval); pollInterval=null; }
      }
      if(d.player1ReadyAt && d.player2ReadyAt && gamePhase==='active'){
        // Both ready but we missed the SSE - start the countdown now
        const latestReadyAt = Math.max(d.player1ReadyAt, d.player2ReadyAt);
        startAt = latestReadyAt + 3000;
        gamePhase = 'counting';
        if(pollInterval){ clearInterval(pollInterval); pollInterval=null; }
      }
      // Update op ready from poll
      const opIsP1 = CFG.myRole==='player2';
      opReady = opIsP1 ? !!d.player1ReadyAt : !!d.player2ReadyAt;
      meReady = opIsP1 ? !!d.player2ReadyAt : !!d.player1ReadyAt;
      updateReadyUI();
    }).catch(()=>{});
  }, 3000);
}

// ── Global functions ──────────────────────────────────────────
window.pkrReady = function(){
  initAudio();
  if(!CFG.isPlayer) return;
  meReady = true;
  const rb = document.getElementById('readyBtn');
  if(rb){ rb.disabled=true; rb.textContent='✅ Ready!'; }
  fetch('/api/parkour/ready', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({gameId:CFG.gameId}) }).catch(()=>{});
};

window.pkrForfeit = function(){
  if(!confirm('Are you sure you want to forfeit? You will lose the bet.')) return;
  fetch('/api/parkour/forfeit', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({gameId:CFG.gameId}) })
    .then(()=>{ gamePhase='finished'; showResult(CFG.myRole==='player1'?'player2':'player1'); })
    .catch(()=>{});
};
})();
