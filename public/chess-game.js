(function(){
'use strict';

var cfg = window.__CG || {};
var GAME_ID      = cfg.gameId || '';
var MY_COLOR     = cfg.myColor || '';
var IS_PLAYER    = cfg.isPlayer || false;

var PIECE_URLS = {
  wK:'https://lichess1.org/assets/piece/cburnett/wK.svg',
  wQ:'https://lichess1.org/assets/piece/cburnett/wQ.svg',
  wR:'https://lichess1.org/assets/piece/cburnett/wR.svg',
  wB:'https://lichess1.org/assets/piece/cburnett/wB.svg',
  wN:'https://lichess1.org/assets/piece/cburnett/wN.svg',
  wP:'https://lichess1.org/assets/piece/cburnett/wP.svg',
  bK:'https://lichess1.org/assets/piece/cburnett/bK.svg',
  bQ:'https://lichess1.org/assets/piece/cburnett/bQ.svg',
  bR:'https://lichess1.org/assets/piece/cburnett/bR.svg',
  bB:'https://lichess1.org/assets/piece/cburnett/bB.svg',
  bN:'https://lichess1.org/assets/piece/cburnett/bN.svg',
  bP:'https://lichess1.org/assets/piece/cburnett/bP.svg'
};

var board = null, turn = 'w', gameStatus = cfg.status || 'waiting';
var gameResult = cfg.result || null, gameResultReason = cfg.resultReason || null;
var timeWhiteMs = cfg.timeWhiteMs || 0, timeBlackMs = cfg.timeBlackMs || 0;
var lastMoveAt = cfg.lastMoveAt || 0, gracePeriodEnds = cfg.gracePeriodEnds || 0;
var selectedSq = null, validMoves = [], lastMove = null;
var notations = cfg.notations || [], movesArr = cfg.moves || [];
var drawOffer = cfg.drawOffer || null;
var lastBoardHash = '';
var pollInterval = null, clockInterval = null;
var promotionResolve = null;
var flipped = (MY_COLOR === 'black');
var activityLog = [];
var chatMessages = cfg.chat || [];
var suppressNextSound = false;

var RANKS = ['8','7','6','5','4','3','2','1'];
var FILES = ['a','b','c','d','e','f','g','h'];

// ── Audio ─────────────────────────────────────────────────────
var AudioCtx = window.AudioContext || window.webkitAudioContext;
var audioCtx = null;
function getCtx(){ if(!audioCtx && AudioCtx) audioCtx = new AudioCtx(); return audioCtx; }

function playTone(freq, type, dur, gain, delay){
  try{
    var ctx = getCtx(); if(!ctx) return;
    var osc = ctx.createOscillator();
    var g = ctx.createGain();
    osc.connect(g); g.connect(ctx.destination);
    osc.type = type || 'sine';
    osc.frequency.value = freq;
    var t = ctx.currentTime + (delay || 0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain || 0.3, t + 0.01);
    g.gain.linearRampToValueAtTime(0, t + dur);
    osc.start(t); osc.stop(t + dur + 0.05);
  }catch(e){}
}

function playSound(type){
  if(type === 'move'){
    playTone(1200,'square',0.04,0.12);
  } else if(type === 'capture'){
    playTone(600,'square',0.04,0.18);
    playTone(400,'square',0.06,0.14,0.04);
  } else if(type === 'check'){
    playTone(880,'sine',0.12,0.28);
    playTone(660,'sine',0.1,0.2,0.12);
  } else if(type === 'promote'){
    [523,659,784,1047].forEach(function(f,i){ playTone(f,'sine',0.18,0.25,i*0.1); });
  } else if(type === 'win'){
    [523,659,784,1047,1319].forEach(function(f,i){ playTone(f,'sine',0.22,0.3,i*0.09); });
  } else if(type === 'lose'){
    [523,440,392,330].forEach(function(f,i){ playTone(f,'sine',0.22,0.22,i*0.1); });
  }
}

// ── Board helpers ─────────────────────────────────────────────
function rcToSq(r,f){ return FILES[f]+RANKS[r]; }
function sqToRC(sq){ return [8-parseInt(sq[1]), sq.charCodeAt(0)-97]; }

function buildBoard(){
  var boardEl = document.getElementById('chessBoard');
  if(!boardEl) return;
  boardEl.innerHTML = '';

  var dFiles = flipped ? FILES.slice().reverse() : FILES;
  var dRanks = flipped ? RANKS.slice().reverse() : RANKS;

  dRanks.forEach(function(rankLabel, ri){
    var r = flipped ? (7-ri) : ri;
    var row = document.createElement('div');
    row.className = 'cb-row';

    var rl = document.createElement('div');
    rl.className = 'cb-rl';
    rl.textContent = rankLabel;
    row.appendChild(rl);

    for(var fi=0; fi<8; fi++){
      var f = flipped ? (7-fi) : fi;
      var sq = rcToSq(r,f);
      var isLight = (r+f)%2 === 0;
      var sqEl = document.createElement('div');
      sqEl.className = 'cb-sq ' + (isLight?'cb-light':'cb-dark');
      sqEl.dataset.sq = sq;
      sqEl.addEventListener('click', (function(s){ return function(){ handleClick(s); }; })(sq));

      if(fi===7){
        var fl = document.createElement('div');
        fl.className = 'cb-fl';
        fl.textContent = FILES[f];
        sqEl.appendChild(fl);
      }

      if(board && board[r] && board[r][f]){
        var piece = board[r][f];
        var pd = document.createElement('div');
        pd.className = 'cb-piece';
        pd.style.backgroundImage = 'url('+PIECE_URLS[piece]+')';
        sqEl.appendChild(pd);
      }
      row.appendChild(sqEl);
    }
    boardEl.appendChild(row);
  });
  applyHighlights();
}

function applyHighlights(){
  document.querySelectorAll('.cb-sq').forEach(function(el){
    var s = el.dataset.sq;
    el.classList.remove('cb-selected','cb-valid','cb-capture','cb-last','cb-check');
    if(lastMove && (s===lastMove.from || s===lastMove.to)) el.classList.add('cb-last');
    if(selectedSq===s) el.classList.add('cb-selected');
    if(validMoves.indexOf(s)!==-1){
      var rc = sqToRC(s);
      var hasPiece = board && board[rc[0]] && board[rc[0]][rc[1]];
      el.classList.add(hasPiece ? 'cb-capture' : 'cb-valid');
    }
  });
  if((gameStatus==='check'||gameStatus==='checkmate') && board){
    var kingPiece = turn==='w' ? 'wK' : 'bK';
    for(var r=0;r<8;r++) for(var f=0;f<8;f++){
      if(board[r] && board[r][f]===kingPiece){
        var kEl = document.querySelector('.cb-sq[data-sq="'+rcToSq(r,f)+'"]');
        if(kEl) kEl.classList.add('cb-check');
      }
    }
  }
}

// ── Click / move ──────────────────────────────────────────────
function handleClick(sq){
  if(!IS_PLAYER || !board) return;
  if(gameStatus==='finished'||gameStatus==='waiting'||gameStatus==='abandoned') return;
  var myTurn = (turn==='w'&&MY_COLOR==='white')||(turn==='b'&&MY_COLOR==='black');
  if(!myTurn) return;

  var rc = sqToRC(sq);
  var piece = board[rc[0]] && board[rc[0]][rc[1]];

  if(selectedSq===sq){ selectedSq=null; validMoves=[]; applyHighlights(); return; }
  if(validMoves.indexOf(sq)!==-1){ doMove(selectedSq,sq); return; }

  if(piece && piece[0]===(turn==='w'?'w':'b')){
    selectedSq=sq;
    fetch('/api/chess/valid-moves/'+GAME_ID+'/'+sq)
      .then(function(r){return r.json();})
      .catch(function(){return {squares:[]};})
      .then(function(res){ validMoves=res.squares||[]; applyHighlights(); });
  } else {
    selectedSq=null; validMoves=[]; applyHighlights();
  }
}

function doMove(from, to){
  var rc = sqToRC(from);
  var piece = board[rc[0]] && board[rc[0]][rc[1]];
  var trc = sqToRC(to);
  var isCapture = !!(board[trc[0]] && board[trc[0]][trc[1]]);
  var isPromotion = piece && piece[1]==='P' &&
    ((piece[0]==='w' && trc[0]===0)||(piece[0]==='b' && trc[0]===7));

  selectedSq=null; validMoves=[];

  if(isPromotion){
    askPromotion().then(function(promotion){
      sendMove(from,to,promotion,isCapture,true);
    });
  } else {
    sendMove(from,to,null,isCapture,false);
  }
}

function sendMove(from,to,promotion,isCapture,isPromo){
  suppressNextSound = true;
  if(isPromo) playSound('promote');
  else if(isCapture) playSound('capture');
  else playSound('move');

  fetch('/api/chess/move',{
    method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({gameId:GAME_ID,from:from,to:to,promotion:promotion})
  }).then(function(r){return r.json();})
  .catch(function(e){return {error:e.message};})
  .then(function(res){
    if(res.error){ showToast(res.error,'error'); suppressNextSound=false; buildBoard(); applyHighlights(); return; }
    pollGameState();
  });
}

function askPromotion(){
  return new Promise(function(resolve){
    promotionResolve=resolve;
    var m=document.getElementById('promoModal');
    if(m) m.style.display='flex';
  });
}
window.selectPromotion = function(p){
  var m=document.getElementById('promoModal');
  if(m) m.style.display='none';
  if(promotionResolve){promotionResolve(p);promotionResolve=null;}
};

// ── Polling ───────────────────────────────────────────────────
// ── Polling ───────────────────────────────────────────────────
function pollGameState(){
  return fetch('/api/chess/game/'+GAME_ID)
    .then(function(r){return r.json();})
    .catch(function(){return null;})
    .then(function(data){
      if(!data||data.error) return;

      var newHash = JSON.stringify(data.board)+'|'+data.turn+'|'+data.status+'|'+(data.notations||[]).length+'|'+(data.chat||[]).length;
      var changed = newHash !== lastBoardHash;
      lastBoardHash = newHash;

      var prevStatus = gameStatus;
      var prevMovesLen = movesArr.length;

      board = data.board;
      turn = data.turn;
      gameStatus = data.status;
      gameResult = data.result;
      gameResultReason = data.resultReason;
      timeWhiteMs = data.timeWhiteMs;
      timeBlackMs = data.timeBlackMs;
      lastMoveAt = data.lastMoveAt || Date.now();
      gracePeriodEnds = data.gracePeriodEnds || 0;
      drawOffer = data.drawOffer;
      notations = data.notations || [];
      movesArr = data.moves || [];
      chatMessages = data.chat || [];

      if(movesArr.length>0){
        var last = movesArr[movesArr.length-1];
        lastMove = {from:last.slice(0,2), to:last.slice(2,4)};
      }

      if(changed){
        buildBoard();
        updateMoveHistory();
        if(movesArr.length > prevMovesLen){
          for(var i=prevMovesLen; i<movesArr.length; i++){
            var n = notations[i]||'';
            var moveNum = Math.floor(i/2)+1;
            var col = i%2===0?'⬜':'⬛';
            addLog(col+' حركة '+moveNum+': '+n);
          }
          if(!suppressNextSound && gameStatus!=='finished'){
            var lastN = notations[notations.length-1]||'';
            if(lastN.indexOf('x')!==-1) playSound('capture');
            else playSound('move');
          }
          suppressNextSound = false;
        }
        updateChat();
        renderLog();
      }

      updateClocks();
      updateDrawBtn();
      updateStatusBar();

      if(prevStatus!=='active' && gameStatus==='active'){
        addLog('🟢 بدأت اللعبة!');
        if(IS_PLAYER) showToast('بدأت اللعبة!','success');
      }

      if(prevStatus!==gameStatus && gameStatus==='check'){
        playSound('check');
        showToast('كش ملك!','warn');
      }

      // ─── عند انتهاء اللعبة ─────────────────────────────────────
      if(prevStatus !== 'finished' && gameStatus === 'finished'){
        showResult(gameResult, gameResultReason);
        
        if(IS_PLAYER){
          var iWin = (gameResult === MY_COLOR) || 
                     (gameResult === 'white' && MY_COLOR === 'white') || 
                     (gameResult === 'black' && MY_COLOR === 'black');
          
          if(gameResult === 'draw'){
            playSound('win');
          } else if(iWin){
            playSound('win');
          } else {
            playSound('lose');
          }
          
          // ✅ تحديث الرصيد - ضع الـ fetch هنا داخل الشرط
          fetch('/api/chess/settle', {
            method: 'POST',
            headers: { 
              'Content-Type': 'application/json',
              'Authorization': 'Bearer ' + (window.__CG?.token || '')
            },
            body: JSON.stringify({
              gameId: GAME_ID,
              result: gameResult,
              winner: gameResult === 'draw' ? null : gameResult,
              reason: gameResultReason,
              userId: window.__CG?.userId || null  // ✅ هذا مهم
            })
          })
          .then(function(res) { return res.json(); })
          .then(function(resp) {
            if(resp.error) {
              console.error('Settle error:', resp.error);
              showToast(resp.error, 'error');
            } else if(resp.message) {
              showToast(resp.message, 'success');
              addLog('💰 ' + resp.message);
            }
          })
          .catch(function(err) {
            console.error('Settle fetch error:', err);
          });
          
        } else {
          playSound('win');
        }
        
        if(pollInterval){
          clearInterval(pollInterval);
          pollInterval = null;
        }
        if(clockInterval){
          clearInterval(clockInterval);
          clockInterval = null;
        }
      }
    });
}
// ── Status bar ────────────────────────────────────────────────
function updateStatusBar(){
  var bar = document.getElementById('statusBar');
  if(!bar) return;
  if(gameStatus==='waiting'){
    bar.textContent = IS_PLAYER&&MY_COLOR==='black'? 'بانتظار قبولك…' : 'بانتظار '+(cfg.player2Username||'')+'…';
  } else if(gameStatus==='active'){
    var isMyTurn=(turn==='w'&&MY_COLOR==='white')||(turn==='b'&&MY_COLOR==='black');
    if(!IS_PLAYER) bar.textContent='👁️ مشاهدة';
    else bar.textContent = isMyTurn?'🎯 دورك!':'⏳ دور الخصم…';
  } else if(gameStatus==='finished'){
    var rl={checkmate:'كش ملك',resignation:'استسلام',timeout:'نفاد الوقت',stalemate:'جمود',agreement:'تعادل',insufficient:'مواد غير كافية',fifty_move:'قاعدة 50 حركة'};
    var prefix = gameResult==='draw'?'🤝 تعادل':gameResult==='white'?'⬜ الأبيض يفوز':'⬛ الأسود يفوز';
    bar.textContent = prefix+' — '+(rl[gameResultReason]||'');
  }
}

// ── Move history ──────────────────────────────────────────────
function updateMoveHistory(){
  var ml = document.getElementById('tabMoves');
  if(!ml) return;
  if(!notations.length){ml.innerHTML='<span style="color:var(--text3);font-size:12px">لا توجد حركات بعد.</span>';return;}
  var html='<div class="chess-moves-inner">';
  for(var i=0;i<notations.length;i+=2){
    var num=Math.floor(i/2)+1;
    html+='<div class="chess-move-row"><span class="chess-move-num">'+num+'.</span>';
    html+='<span class="chess-move-w">'+escH(notations[i])+'</span>';
    if(notations[i+1]) html+='<span class="chess-move-b">'+escH(notations[i+1])+'</span>';
    html+='</div>';
  }
  html+='</div>';
  ml.innerHTML=html;
  ml.scrollTop=ml.scrollHeight;
}

// ── Activity log ──────────────────────────────────────────────
function addLog(msg){
  activityLog.push({msg:msg, ts:Date.now()});
  renderLog();
}
function renderLog(){
  var el=document.getElementById('tabLog');
  if(!el) return;
  if(!activityLog.length){el.innerHTML='<div style="color:var(--text3);font-size:12px">لا يوجد سجل بعد.</div>';return;}
  el.innerHTML=activityLog.slice().reverse().map(function(l){
    return '<div class="chess-log-entry">'+escH(l.msg)+'</div>';
  }).join('');
}

// ── Chat ──────────────────────────────────────────────────────
function updateChat(){
  var el=document.getElementById('chatMessages');
  if(!el) return;
  if(!chatMessages.length){el.innerHTML='<div style="color:var(--text3);font-size:12px;padding:8px 0">لا توجد رسائل بعد.</div>';return;}
  el.innerHTML=chatMessages.map(function(m){
    return '<div class="chess-chat-msg"><span class="chess-chat-user">'+escH(m.username)+':</span> '+escH(m.text)+'</div>';
  }).join('');
  el.scrollTop=el.scrollHeight;
}
window.sendChat = function(){
  var inp=document.getElementById('chatInput');
  if(!inp||!inp.value.trim()) return;
  var text=inp.value.trim();
  inp.value='';
  fetch('/api/chess/chat',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({gameId:GAME_ID,text:text})
  }).then(function(r){return r.json();})
  .then(function(){ pollGameState(); })
  .catch(function(){});
};

// ── Clocks ────────────────────────────────────────────────────
function updateClocks(){
  var now=Date.now();
  var tW=timeWhiteMs, tB=timeBlackMs;
  if(gameStatus==='active' && lastMoveAt){
    var clockStart=Math.max(lastMoveAt, gracePeriodEnds||0);
    var elapsed=Math.max(0, now-clockStart);
    if(turn==='w') tW=Math.max(0,tW-elapsed);
    else tB=Math.max(0,tB-elapsed);
  }
  var wEl=document.getElementById('clockWhite');
  var bEl=document.getElementById('clockBlack');
  if(wEl){
    wEl.textContent=fmtMs(tW);
    wEl.className='cb-clock'+(turn==='w'&&gameStatus==='active'?' cb-clock-active':'')+(tW<30000&&gameStatus==='active'?' cb-clock-low':'');
  }
  if(bEl){
    bEl.textContent=fmtMs(tB);
    bEl.className='cb-clock'+(turn==='b'&&gameStatus==='active'?' cb-clock-active':'')+(tB<30000&&gameStatus==='active'?' cb-clock-low':'');
  }
}
function fmtMs(ms){
  if(ms==null||ms<0) ms=0;
  var s=Math.floor(ms/1000), m=Math.floor(s/60), ss=s%60;
  return m+':'+(ss<10?'0':'')+ss;
}

// ── Result ────────────────────────────────────────────────────
function showResult(result,reason){
  var banner=document.getElementById('resultBanner');
  if(!banner) return;
  banner.style.display='block';
  var rl={checkmate:'كش ملك',resignation:'استسلام',timeout:'نفاد الوقت',stalemate:'جمود',agreement:'تعادل بالاتفاق',insufficient:'مواد غير كافية',fifty_move:'قاعدة الـ50 حركة'};
  var rlabel=rl[reason]||reason||'';
  if(result==='draw'){banner.textContent='🤝 تعادل — '+rlabel;banner.style.background='linear-gradient(135deg,#4a5568,#718096)';}
  else if(result==='white'){banner.textContent='⬜ الأبيض يفوز — '+rlabel;}
  else if(result==='black'){banner.textContent='⬛ الأسود يفوز — '+rlabel;banner.style.background='linear-gradient(135deg,#2d2d2d,#1a1a2e)';}
  var controls=document.getElementById('gameControls');
  if(controls) controls.style.display='none';
  addLog('🏁 '+(result==='draw'?'تعادل':'فوز '+(result==='white'?'الأبيض':'الأسود'))+' ('+rlabel+')');
  updateStatusBar();
}

// ── Draw button ───────────────────────────────────────────────
function updateDrawBtn(){
  var drawBtn=document.getElementById('drawBtn');
  if(!drawBtn) return;
  if(drawOffer && drawOffer!==MY_COLOR){
    drawBtn.textContent='✅ قبول التعادل';
    drawBtn.onclick=function(){respondDraw('accept');};
  } else {
    drawBtn.textContent=drawOffer===MY_COLOR?'↩️ إلغاء التعادل':'🤝 عرض تعادل';
    drawBtn.onclick=function(){offerDraw();};
  }
}

// ── Tabs ──────────────────────────────────────────────────────
window.switchChessTab = function(name){
  document.querySelectorAll('.chess-tab-btn').forEach(function(b){
    b.classList.toggle('active', b.dataset.tab===name);
  });
  document.querySelectorAll('.chess-tab-panel').forEach(function(p){
    p.style.display = p.dataset.panel===name ? '' : 'none';
  });
};

// ── Actions ───────────────────────────────────────────────────
window.acceptGame = function(){
  fetch('/api/chess/accept',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({gameId:GAME_ID})})
    .then(function(r){return r.json();})
    .then(function(res){
      if(res.error) showToast(res.error,'error');
      else{showToast('بدأت اللعبة!','success');pollGameState();}
    }).catch(function(){});
};
window.resignGame = function(){
  if(!confirm('هل أنت متأكد من الاستسلام؟')) return;
  fetch('/api/chess/resign',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({gameId:GAME_ID})})
    .then(function(r){return r.json();})
    .then(function(res){if(res.error)showToast(res.error,'error');else pollGameState();})
    .catch(function(){});
};
window.offerDraw = function(){
  fetch('/api/chess/draw',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({gameId:GAME_ID,action:'offer'})})
    .then(function(r){return r.json();})
    .then(function(res){if(res.error)showToast(res.error,'error');else{showToast('تم عرض التعادل!','info');pollGameState();}})
    .catch(function(){});
};
window.respondDraw = function(action){
  fetch('/api/chess/draw',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({gameId:GAME_ID,action:action})})
    .then(function(r){return r.json();})
    .then(function(res){if(res.error)showToast(res.error,'error');else pollGameState();})
    .catch(function(){});
};
window.claimTimeout = function(){
  fetch('/api/chess/claim-timeout',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({gameId:GAME_ID})})
    .then(function(r){return r.json();})
    .then(function(res){if(res.error)showToast(res.error,'info');else pollGameState();})
    .catch(function(){});
};
window.flipChessBoard = function(){
  flipped=!flipped;buildBoard();
};

// ── Toast ─────────────────────────────────────────────────────
function showToast(msg,type){
  var c=document.getElementById('toast-container');
  if(!c) return;
  var t=document.createElement('div');
  t.className='toast toast-'+(type||'info');
  t.textContent=msg;
  c.appendChild(t);
  setTimeout(function(){t.remove();},3500);
}

function escH(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

// ── Init ──────────────────────────────────────────────────────
board = cfg.board || null;
turn  = cfg.turn  || 'w';
notations = cfg.notations || [];
movesArr  = cfg.moves || [];
chatMessages = cfg.chat || [];
drawOffer = cfg.drawOffer || null;

if(movesArr.length>0){
  var initLast=movesArr[movesArr.length-1];
  lastMove={from:initLast.slice(0,2),to:initLast.slice(2,4)};
}

addLog('♟️ '+(cfg.player1Username||'')+'  (أبيض) ضد '+(cfg.player2Username||'')+' (أسود)');
addLog('⏱️ وقت اللعبة: '+(cfg.timeControl||''));
if(gameStatus==='active') addLog('🟢 اللعبة نشطة');
if(gameStatus==='finished') addLog('🏁 اللعبة منتهية');

for(var _i=0;_i<notations.length;_i++){
  var _num=Math.floor(_i/2)+1;
  var _col=_i%2===0?'⬜':'⬛';
  activityLog.push({msg:_col+' حركة '+_num+': '+notations[_i],ts:0});
}

buildBoard();
updateMoveHistory();
updateChat();
renderLog();
updateClocks();
updateStatusBar();
switchChessTab('moves');

if(gameStatus==='finished' && gameResult){
  showResult(gameResult,gameResultReason);
}

if(gameStatus!=='finished'&&gameStatus!=='abandoned'){
  var _interval = gameStatus==='active'?1500:2500;
  pollInterval=setInterval(pollGameState,_interval);
  clockInterval=setInterval(updateClocks,250);
} else {
  updateClocks();
}

var chatInp=document.getElementById('chatInput');
if(chatInp){
  chatInp.addEventListener('keydown',function(e){if(e.key==='Enter')window.sendChat();});
}

})();