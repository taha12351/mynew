(function(){
'use strict';

var cfg = window.__WR || {};
var ROOM_ID       = cfg.roomId      || '';
var MY_UID        = cfg.uid         || '';
var OWNER_ID      = cfg.ownerId     || '';
var IS_PARTICIPANT= !!cfg.isParticipant;
var IS_OWNER      = !!cfg.isOwner;
var START_AT      = cfg.startAt     || 0;

var state            = null;
var player           = null;
var playerReady      = false;
var lastVideoUrl     = '';
var ignoreNextSync   = false;
var syncSendCooldown = false;

// ── Helpers ───────────────────────────────────────────────────
function escHtml(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ── Billing ───────────────────────────────────────────────────
function updateBilling(){
  var t = document.getElementById('sessionTimer');
  var c = document.getElementById('sessionCost');
  if(!t || !START_AT) return;
  var sec = Math.max(0, Math.floor((Date.now() - START_AT) / 1000));
  var m = Math.floor(sec/60), s = sec%60;
  t.textContent = '\u23f1\ufe0f ' + m + ':' + (s<10?'0':'') + s;
  var intervals = Math.max(1, Math.ceil(sec/30));
  c.textContent = '\ud83d\udcb0 ' + (intervals * 100) + ' \u0643\u0648\u064a\u0646';
}
if(START_AT){ setInterval(updateBilling, 1000); updateBilling(); }

// ── End session ───────────────────────────────────────────────
async function endSession(){
  var sec = START_AT ? Math.max(0, Math.floor((Date.now()-START_AT)/1000)) : 0;
  var cost = Math.max(1,Math.ceil(sec/30)) * 100;
  if(!confirm('\u0625\u0646\u0647\u0627\u0621 \u0627\u0644\u062c\u0644\u0633\u0629\u061f \u0633\u064a\u062a\u0645 \u062e\u0635\u0645 ' + cost + ' \u0643\u0648\u064a\u0646 \u0645\u0646 \u0643\u0644 \u0645\u0634\u0627\u0631\u0643.')) return;
  var btn = document.getElementById('endBtn');
  if(btn){btn.disabled=true;btn.textContent='...';}
  var r = await fetch('/api/watch/end',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({roomId:ROOM_ID})}).catch(function(){return null;});
  var d = r ? await r.json().catch(function(){return null;}) : null;
  if(d&&d.success) appendSystemMsg('\u0627\u0646\u062a\u0647\u062a \u0627\u0644\u062c\u0644\u0633\u0629 \u2022 \u062e\u064f\u0635\u0645 ' + d.totalCost + ' \u0643\u0648\u064a\u0646 \u0645\u0646 \u0643\u0644 \u0645\u0634\u0627\u0631\u0643 \u2022 \u0627\u0644\u0645\u062f\u0629: ' + d.duration + ' \u062f\u0642\u064a\u0642\u0629');
  if(btn) btn.textContent='\u0627\u0646\u062a\u0647\u062a';
}
var _endBtn = document.getElementById('endBtn');
if(_endBtn) _endBtn.addEventListener('click', endSession);

// ── Tab switch ────────────────────────────────────────────────
window.switchTab = function(tab){
  var isUrl = tab==='url';
  var pUrl  = document.getElementById('panelUrl');
  var pImdb = document.getElementById('panelImdb');
  var tUrl  = document.getElementById('tabUrl');
  var tImdb = document.getElementById('tabImdb');
  var res   = document.getElementById('imdbResults');
  if(pUrl)  pUrl.style.display  = isUrl ? 'flex' : 'none';
  if(pImdb) pImdb.style.display = isUrl ? 'none' : 'flex';
  if(tUrl)  tUrl.className  = 'watch-tab-btn' + (isUrl  ? ' active' : '');
  if(tImdb) tImdb.className = 'watch-tab-btn' + (!isUrl ? ' active' : '');
  if(!isUrl && res) res.style.display = 'none';
};

// ── IMDB Search ───────────────────────────────────────────────
window.searchImdb = async function(){
  var inp = document.getElementById('imdbSearch');
  var q   = inp ? inp.value.trim() : '';
  if(!q) return;
  var btn = document.querySelector('#panelImdb button');
  if(btn) btn.textContent = '...';
  var r = await fetch('/api/watch/imdb-search?q='+encodeURIComponent(q))
    .then(function(x){return x.json();})
    .catch(function(){return {results:[]};});
  if(btn) btn.textContent = '\ud83d\udd0d \u0628\u062d\u062b';
  renderImdbResults(r.results||[]);
};

function renderImdbResults(results){
  var el = document.getElementById('imdbResults');
  if(!el) return;
  if(!results.length){ el.style.display='none'; return; }
  el.style.display = 'block';
  el.innerHTML = results.map(function(r){
    var poster = r.poster
      ? '<img src="'+escHtml(r.poster)+'" class="imdb-poster" onerror="this.style.display=\'none\'">'
      : '<div class="imdb-poster-placeholder">\ud83c\udfa6</div>';
    return '<div class="imdb-result" onclick="playImdb(\''+escHtml(r.id)+'\',\''+escHtml(r.title.replace(/'/g,'&apos;'))+'\')">'
      + poster
      + '<div style="flex:1;min-width:0">'
      + '<div class="imdb-title">'+escHtml(r.title)+'</div>'
      + '<div class="imdb-meta">'+escHtml(String(r.year||''))+' \u00b7 '+escHtml(r.type||'')+'</div>'
      + '</div>'
      + '<button class="btn btn-primary btn-sm" style="flex-shrink:0">\u25b6 \u0634\u0627\u0647\u062f</button>'
      + '</div>';
  }).join('');
}

window.playImdb = function(imdbId, title){
  var url = 'https://streamimdb.ru/embed/tv/' + imdbId;
  var res = document.getElementById('imdbResults');
  var inp = document.getElementById('imdbSearch');
  if(res) res.style.display = 'none';
  if(inp) inp.value = title || imdbId;
  setVideoUrl(url);
};

// ── Set video ─────────────────────────────────────────────────
window.setVideo = async function(){
  var inp = document.getElementById('videoUrlInput');
  var url = inp ? inp.value.trim() : '';
  if(!url){ alert('\u064a\u0631\u062c\u0649 \u0625\u062f\u062e\u0627\u0644 \u0631\u0627\u0628\u0637'); return; }
  setVideoUrl(url);
};

async function setVideoUrl(url){
  await fetch('/api/watch/video',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({roomId:ROOM_ID,videoUrl:url})}).catch(function(){});
}

// ── Transfer ownership ────────────────────────────────────────
window.transferTo = async function(newOwnerId, username){
  if(!confirm('\u0646\u0642\u0644 \u0627\u0644\u062a\u062d\u0643\u0645 \u0625\u0644\u0649 ' + username + '\u061f')) return;
  var r = await fetch('/api/watch/transfer',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({roomId:ROOM_ID,newOwnerId:newOwnerId})})
    .then(function(x){return x.json();})
    .catch(function(){return null;});
  if(r&&r.success) appendSystemMsg('\u062a\u0645 \u0646\u0642\u0644 \u0627\u0644\u062a\u062d\u0643\u0645 \u0625\u0644\u0649 ' + username);
  else if(r&&r.error) appendSystemMsg('\u062e\u0637\u0623: ' + r.error);
};

// ── Seek ──────────────────────────────────────────────────────
function seekToTime(){
  var inp = document.getElementById('seekInput');
  var val = inp ? inp.value.trim() : '';
  if(!val) return;
  var sec = 0, p = val.split(':');
  if(p.length===3)      sec = parseInt(p[0]||0)*3600 + parseInt(p[1]||0)*60 + parseInt(p[2]||0);
  else if(p.length===2) sec = parseInt(p[0]||0)*60   + parseInt(p[1]||0);
  else                  sec = parseInt(val)||0;
  if(player && playerReady){
    player.seekTo(sec, true);
    var playing = player.getPlayerState()===YT.PlayerState.PLAYING;
    fetch('/api/watch/sync',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({roomId:ROOM_ID,playing:playing,currentTime:sec})}).catch(function(){});
  }
}
var _seekBtn = document.getElementById('seekBtn');
if(_seekBtn) _seekBtn.addEventListener('click', seekToTime);
var _seekInput = document.getElementById('seekInput');
if(_seekInput) _seekInput.addEventListener('keydown', function(e){ if(e.key==='Enter') seekToTime(); });

// ── Emoji reactions ───────────────────────────────────────────
async function sendReact(emoji){
  await fetch('/api/watch/react',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({roomId:ROOM_ID,emoji:emoji})}).catch(function(){});
  showReaction(emoji);
}
function showReaction(emoji){
  var wrap = document.getElementById('videoWrap');
  if(!wrap) return;
  var el = document.createElement('div');
  el.className = 'emoji-fly';
  el.textContent = emoji;
  el.style.left   = (15 + Math.random()*70) + '%';
  el.style.bottom = (8  + Math.random()*25) + '%';
  wrap.appendChild(el);
  el.addEventListener('animationend', function(){ el.remove(); });
}
document.querySelectorAll('.react-btn').forEach(function(btn){
  btn.addEventListener('click', function(){ sendReact(btn.getAttribute('data-emoji')); });
});

// ── YouTube IFrame API ────────────────────────────────────────
function getYTId(url){
  try{
    var u = new URL(url);
    if(u.hostname.includes('youtube.com')) return u.searchParams.get('v');
    if(u.hostname==='youtu.be')            return u.pathname.slice(1);
  }catch(e){}
  return null;
}

window.onYouTubeIframeAPIReady = function(){
  if(state && state.videoUrl) loadPlayer(state.videoUrl);
};

function loadPlayer(url){
  var vid = getYTId(url);
  if(!vid){ showRawEmbed(url); return; }
  var noVid  = document.getElementById('noVideoMsg');
  var pWrap  = document.getElementById('playerWrap');
  if(noVid)  noVid.style.display  = 'none';
  if(pWrap)  pWrap.style.display  = 'block';
  if(player){ player.loadVideoById(vid); return; }
  player = new YT.Player('playerWrap',{
    videoId: vid,
    playerVars:{ autoplay:0, rel:0, modestbranding:1 },
    events:{
      onReady:       function(){ playerReady=true; },
      onStateChange: onStateChange
    }
  });
}

function showRawEmbed(url){
  var noVid = document.getElementById('noVideoMsg');
  var pWrap = document.getElementById('playerWrap');
  if(noVid) noVid.style.display = 'none';
  if(pWrap){
    pWrap.style.display = 'block';
    pWrap.innerHTML = '<iframe src="' + url + '" width="100%" height="100%" allowfullscreen frameborder="0" allow="autoplay; encrypted-media; fullscreen"></iframe>';
  }
  playerReady = false;
}

function onStateChange(e){
  if(!IS_OWNER || ignoreNextSync) return;
  if(syncSendCooldown) return;
  syncSendCooldown = true;
  setTimeout(function(){ syncSendCooldown=false; }, 800);
  var playing = e.data===YT.PlayerState.PLAYING;
  var paused  = e.data===YT.PlayerState.PAUSED;
  if(!playing && !paused) return;
  var ct = player.getCurrentTime()||0;
  fetch('/api/watch/sync',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({roomId:ROOM_ID,playing:playing,currentTime:ct})}).catch(function(){});
}

function applySync(ps){
  if(!player || !playerReady || !ps) return;
  var now    = Date.now(), lag = (now - ps.updatedAt) / 1000;
  var target = (ps.currentTime||0) + (ps.playing ? lag : 0);
  var cur    = player.getCurrentTime()||0;
  if(Math.abs(cur-target) > 2){
    ignoreNextSync = true;
    player.seekTo(target, true);
    setTimeout(function(){ ignoreNextSync=false; }, 1000);
  }
  if(ps.playing){
    if(player.getPlayerState()!==YT.PlayerState.PLAYING){ ignoreNextSync=true; player.playVideo();  setTimeout(function(){ ignoreNextSync=false; },1000); }
  } else {
    if(player.getPlayerState()===YT.PlayerState.PLAYING){ ignoreNextSync=true; player.pauseVideo(); setTimeout(function(){ ignoreNextSync=false; },1000); }
  }
}

// ── SSE ───────────────────────────────────────────────────────
var es = new EventSource('/api/watch/sse/' + ROOM_ID);
es.onmessage = function(e){
  var d;
  try{ d = JSON.parse(e.data); }catch(err){ return; }
  if(d.type==='connected') return;
  if(d.type==='message'){ appendMessage(d.message); return; }
  if(d.type==='video'){
    if(d.videoUrl !== lastVideoUrl){
      lastVideoUrl = d.videoUrl;
      if(d.videoUrl){
        if(typeof YT!=='undefined' && YT.Player) loadPlayer(d.videoUrl);
        else showRawEmbed(d.videoUrl);
      } else {
        var pw = document.getElementById('playerWrap');
        var nm = document.getElementById('noVideoMsg');
        if(pw) pw.style.display = 'none';
        if(nm) nm.style.display = 'flex';
      }
    }
    return;
  }
  if(d.type==='sync'){
    if(d.updatedAt && state){ state.playbackState=d; applySync(d); }
    return;
  }
  if(d.type==='status'){
    if(d.status==='active') appendSystemMsg('\u0635\u062f\u064a\u0642\u0643 \u0627\u0646\u0636\u0645 \u0644\u0644\u063a\u0631\u0641\u0629! \ud83c\udf89');
    return;
  }
  if(d.type==='joined'){
    appendSystemMsg(d.username + ' \u0627\u0646\u0636\u0645 \u0644\u0644\u063a\u0631\u0641\u0629! \ud83d\udc4b');
    addParticipantBadge(d);
    return;
  }
  if(d.type==='transfer'){
    OWNER_ID = d.newOwnerId;
    appendSystemMsg('\u062a\u0645 \u0646\u0642\u0644 \u0627\u0644\u062a\u062d\u0643\u0645 \u0625\u0644\u0649 ' + d.newOwnerUsername + ' \ud83d\udc51');
    if(MY_UID === d.newOwnerId && !IS_OWNER){
      IS_OWNER = true;
      appendSystemMsg('\u0623\u0646\u062a \u0627\u0644\u0622\u0646 \u062a\u062a\u062d\u0643\u0645 \u0641\u064a \u0627\u0644\u062c\u0644\u0633\u0629! \ud83c\udfae');
      location.reload();
    }
    return;
  }
  if(d.type==='reaction'){ showReaction(d.emoji); return; }
  if(d.type==='ended'){
    appendSystemMsg('\ud83d\udd1a \u0627\u0646\u062a\u0647\u062a \u0627\u0644\u062c\u0644\u0633\u0629 \u2022 \u062e\u064f\u0635\u0645 ' + (d.totalCost||0) + ' \u0643\u0648\u064a\u0646 \u0645\u0646 \u0643\u0644 \u0645\u0634\u0627\u0631\u0643 \u2022 \u0627\u0644\u0645\u062f\u0629: ' + (d.duration||0) + ' \u062f\u0642\u064a\u0642\u0629');
    var eb = document.getElementById('endBtn');
    if(eb){ eb.disabled=true; eb.textContent='\u0627\u0646\u062a\u0647\u062a'; }
    if(player && playerReady){ try{ player.stopVideo(); }catch(err){} }
    var pw2 = document.getElementById('playerWrap');
    var nm2 = document.getElementById('noVideoMsg');
    if(pw2) pw2.style.display = 'none';
    if(nm2) nm2.style.display = 'flex';
    document.querySelectorAll('.react-btn, #seekBtn, #tabUrl, #tabImdb').forEach(function(x){ x.disabled=true; });
    return;
  }
  fetchState();
};

function addParticipantBadge(data){
  var list = document.getElementById('participantsList');
  if(!list || list.querySelector('[data-uid="'+data.userId+'"]')) return;
  var av = data.avatar
    ? 'https://cdn.discordapp.com/avatars/'+data.userId+'/'+data.avatar+'.png?size=64'
    : 'https://cdn.discordapp.com/embed/avatars/0.png';
  var div = document.createElement('div');
  div.className = 'watch-viewer';
  div.setAttribute('data-uid', data.userId);
  div.innerHTML = '<img src="'+av+'" onerror="this.src=\'https://cdn.discordapp.com/embed/avatars/0.png\'" alt=""><span>'+escHtml(data.username)+'</span>';
  list.appendChild(div);
}

// ── Fetch state ───────────────────────────────────────────────
async function fetchState(){
  var d = await fetch('/api/watch/room/'+ROOM_ID)
    .then(function(r){ return r.json(); })
    .catch(function(){ return null; });
  if(!d || d.error) return;
  state = d;
  renderChat(d.chatMessages||[]);
  if(d.videoUrl && d.videoUrl !== lastVideoUrl){
    lastVideoUrl = d.videoUrl;
    if(typeof YT!=='undefined' && YT.Player) loadPlayer(d.videoUrl);
    else showRawEmbed(d.videoUrl);
    var inp = document.getElementById('videoUrlInput');
    if(inp) inp.value = d.videoUrl;
  }
  if(d.playbackState && d.playbackState.updatedAt) applySync(d.playbackState);
}

// ── Chat ──────────────────────────────────────────────────────
function renderChat(msgs){
  var ca = document.getElementById('chatArea');
  if(!ca) return;
  var atBottom = ca.scrollHeight - ca.clientHeight <= ca.scrollTop + 40;
  ca.innerHTML = '';
  msgs.forEach(function(m){ appendMessage(m, false); });
  if(atBottom) ca.scrollTop = ca.scrollHeight;
}

function appendMessage(msg, scroll){
  if(scroll===undefined) scroll=true;
  var ca  = document.getElementById('chatArea');
  if(!ca) return;
  var div  = document.createElement('div'); div.className = 'chat-msg';
  var time = new Date(msg.timestamp).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  var fb   = 'https://cdn.discordapp.com/embed/avatars/0.png';
  var av   = msg.avatar ? 'https://cdn.discordapp.com/avatars/'+msg.userId+'/'+msg.avatar+'.png?size=64' : fb;
  var img  = document.createElement('img'); img.src=av; img.alt='';
  img.onerror = function(){ this.onerror=null; this.src=fb; };
  var body = document.createElement('div'); body.className='chat-msg-body';
  body.innerHTML =
    '<div class="chat-msg-header"><span class="chat-msg-name">'+escHtml(msg.username)+'</span>'
    +'<span class="chat-msg-time">'+time+'</span></div>'
    +'<div class="chat-msg-text">'+escHtml(msg.text)+'</div>';
  div.appendChild(img);
  div.appendChild(body);
  ca.appendChild(div);
  if(scroll) ca.scrollTop = ca.scrollHeight;
}

function appendSystemMsg(text){
  var ca = document.getElementById('chatArea');
  if(!ca) return;
  var div = document.createElement('div'); div.className='chat-msg system';
  div.innerHTML = '<div class="chat-msg-text">'+escHtml(text)+'</div>';
  ca.appendChild(div);
  ca.scrollTop = ca.scrollHeight;
}

window.chatKeydown = function(e){
  if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); window.sendMessage(); }
};

window.sendMessage = async function(){
  var inp  = document.getElementById('chatInput');
  var text = inp ? inp.value.trim() : '';
  if(!text) return;
  if(inp) inp.value = '';
  await fetch('/api/watch/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({roomId:ROOM_ID,text:text})}).catch(function(){});
};

// ── Init ─────────────────────────────────────────────────────
fetchState();
var ytScript = document.createElement('script');
ytScript.src = 'https://www.youtube.com/iframe_api';
document.head.appendChild(ytScript);

})();
