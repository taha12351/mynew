'use strict';
const WatchRoom  = require('./models/watchRoom');
const WatchLog   = require('./models/watchLog');
const gameEvents = require('./gameEvents');
const https      = require('https');

const watchSSE  = new Map();

// ── Anti-exploit constants ────────────────────────────────────────
const MIN_JOIN_BALANCE = 500;   // minimum coins to JOIN a room
const COST_PER_INTERVAL = 100;  // coins per 30 seconds
const INTERVAL_SEC = 30;        // seconds per billing tick

// ── Tracks how many intervals have already been billed per room ──
// (in-memory is fine — resets on restart = safe, rooms are short-lived)
const billedMap = new Map(); // roomId → number of intervals billed

function emitWatchSSE(roomId, data){
  const clients = watchSSE.get(roomId);
  if(!clients) return;
  const payload = 'data: ' + JSON.stringify(data) + '\n\n';
  for(const res of clients){
    try{ res.write(payload); }catch(e){}
  }
}

gameEvents.on('watch_update', (roomId, data) => emitWatchSSE(roomId, data || { type:'update' }));

module.exports = function setupWatchRoutes(app, { db, discordClient, layout, siteLog }){

  function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  function avUrl(id, hash){
    if(hash) return 'https://cdn.discordapp.com/avatars/' + id + '/' + hash + '.png?size=64';
    return 'https://cdn.discordapp.com/embed/avatars/' + (Number(id||0) % 5) + '.png';
  }

  function isPart(wr, uid){
    if(!uid) return false;
    if(wr.ownerId === uid) return true;
    return (wr.participants||[]).some(p => p.userId === uid);
  }

  // ── SSE stream ───────────────────────────────────────────────
  app.get('/api/watch/sse/:roomId', (req, res) => {
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const { roomId } = req.params;
    if(!watchSSE.has(roomId)) watchSSE.set(roomId, new Set());
    watchSSE.get(roomId).add(res);
    res.write('data: {"type":"connected"}\n\n');
    req.on('close', () => {
      const set = watchSSE.get(roomId);
      if(set){ set.delete(res); if(!set.size) watchSSE.delete(roomId); }
    });
  });

  // ── Get room state ────────────────────────────────────────────
  app.get('/api/watch/room/:roomId', async(req, res) => {
    const wr = await WatchRoom.findOne({ roomId: req.params.roomId }).lean().catch(()=>null);
    if(!wr) return res.json({ error:'Room not found' });
    const uid = req.session?.user?.id || null;
    res.json({
      roomId: wr.roomId, title: wr.title, status: wr.status,
      ownerId: wr.ownerId, ownerUsername: wr.ownerUsername,
      participants: wr.participants || [],
      videoUrl: wr.videoUrl, playbackState: wr.playbackState,
      chatMessages: (wr.chatMessages||[]).slice(-100),
      isParticipant: isPart(wr, uid),
      isOwner: uid === wr.ownerId,
      startedAt: wr.startedAt || null,
    });
  });

  // ── IMDB Search ───────────────────────────────────────────────
  app.get('/api/watch/imdb-search', async(req, res) => {
    const q = (req.query.q || '').trim();
    if(!q) return res.json({ results:[] });
    const url = 'https://v3.sg.media-imdb.com/suggestion/x/' + encodeURIComponent(q) + '.json';
    try{
      const data = await new Promise((resolve, reject) => {
        https.get(url, { headers:{ 'User-Agent':'Mozilla/5.0' } }, r => {
          let body = '';
          r.on('data', c => body += c);
          r.on('end', () => { try{ resolve(JSON.parse(body)); }catch{ reject(new Error('parse')); } });
        }).on('error', reject);
      });
      const results = (data.d||[]).filter(x => x.id && x.l).slice(0,8).map(x => ({
        id: x.id, title: x.l, year: x.y||'', type: x.q||'movie', poster: x.i?.imageUrl||''
      }));
      res.json({ results });
    }catch{
      res.json({ results:[] });
    }
  });

  // ── Join room ─────────────────────────────────────────────────
  app.post('/api/watch/join', async(req, res) => {
    if(!req.session?.user) return res.status(401).json({ error:'Login required' });
    const { roomId } = req.body;
    const uid = req.session.user.id;
    const wr = await WatchRoom.findOne({ roomId }).catch(()=>null);
    if(!wr) return res.json({ error:'Room not found' });
    if(wr.status === 'ended') return res.json({ error:'Session ended' });
    if(isPart(wr, uid)) return res.json({ success:true, alreadyIn:true });
    if(!(wr.invitedIds||[]).includes(uid)) return res.json({ error:'Not invited' });
    if((wr.participants||[]).length >= 5) return res.json({ error:'Room full (max 5)' });

    // ── EXPLOIT FIX 1: balance gate ──────────────────────────────
    const userDoc = await db.findOne({ id: uid }).catch(()=>null);
    if(!userDoc || (userDoc.coins||0) < MIN_JOIN_BALANCE){
      return res.json({
        error: `❌ رصيدك غير كافٍ للانضمام — تحتاج على الأقل **${MIN_JOIN_BALANCE.toLocaleString()} كوين** (رصيدك: ${(userDoc?.coins||0).toLocaleString()} كوين)`
      });
    }
    // ─────────────────────────────────────────────────────────────

    wr.participants.push({ userId: uid, username: req.session.user.username, avatar: req.session.user.avatar||'', joinedAt: Date.now() });
    wr.markModified('participants');
    if(wr.status === 'waiting') { wr.status = 'active'; wr.startedAt = wr.startedAt || Date.now(); }
    await wr.save();
    gameEvents.emit('watch_update', roomId, { type:'joined', userId: uid, username: req.session.user.username, avatar: req.session.user.avatar||'' });
    res.json({ success:true });
  });

  // ── Set video URL (owner only) ────────────────────────────────
  app.post('/api/watch/video', async(req, res) => {
    if(!req.session?.user) return res.status(401).json({ error:'Login required' });
    const { roomId, videoUrl } = req.body;
    const wr = await WatchRoom.findOne({ roomId }).catch(()=>null);
    if(!wr) return res.json({ error:'Room not found' });
    if(req.session.user.id !== wr.ownerId) return res.json({ error:'Only the host can change the video' });
    const url = (videoUrl||'').trim();
    wr.videoUrl = url;
    wr.playbackState = { playing: false, currentTime: 0, updatedAt: Date.now() };
    if(url){
      wr.videoLog = wr.videoLog || [];
      wr.videoLog.push({ url, loadedAt: Date.now(), loadedBy: req.session.user.id, loadedByUsername: req.session.user.username });
      if(wr.videoLog.length > 50) wr.videoLog = wr.videoLog.slice(-50);
      wr.markModified('videoLog');
    }
    await wr.save();
    gameEvents.emit('watch_update', roomId, { type:'video', videoUrl: url });
    res.json({ success:true });
  });

  // ── Sync playback (owner only) ────────────────────────────────
  app.post('/api/watch/sync', async(req, res) => {
    if(!req.session?.user) return res.status(401).json({ error:'Login required' });
    const { roomId, playing, currentTime } = req.body;
    const wr = await WatchRoom.findOne({ roomId }).catch(()=>null);
    if(!wr) return res.json({ error:'Room not found' });
    if(req.session.user.id !== wr.ownerId) return res.json({ success:true });
    wr.playbackState = { playing: !!playing, currentTime: Number(currentTime)||0, updatedAt: Date.now() };
    wr.markModified('playbackState');
    await wr.save();
    gameEvents.emit('watch_update', roomId, { type:'sync', playing: !!playing, currentTime: Number(currentTime)||0, updatedAt: wr.playbackState.updatedAt });
    res.json({ success:true });
  });

  // ── Send chat message (any participant) ───────────────────────
  app.post('/api/watch/message', async(req, res) => {
    if(!req.session?.user) return res.status(401).json({ error:'Login required' });
    const { roomId, text } = req.body;
    if(!text||!text.trim()) return res.json({ error:'Empty message' });
    const wr = await WatchRoom.findOne({ roomId }).catch(()=>null);
    if(!wr || wr.status === 'ended') return res.json({ error:'Room not available' });
    if(!isPart(wr, req.session.user.id)) return res.json({ error:'Not a participant' });
    const msg = { userId: req.session.user.id, username: req.session.user.username, avatar: req.session.user.avatar||'', text: text.trim().slice(0,500), timestamp: Date.now() };
    wr.chatMessages.push(msg);
    if(wr.chatMessages.length > 200) wr.chatMessages = wr.chatMessages.slice(-200);
    wr.markModified('chatMessages');
    await wr.save();
    gameEvents.emit('watch_update', roomId, { type:'message', message: msg });
    res.json({ success:true, message: msg });
  });

  // ── Transfer ownership (owner only) ──────────────────────────
  app.post('/api/watch/transfer', async(req, res) => {
    if(!req.session?.user) return res.status(401).json({ error:'Login required' });
    const { roomId, newOwnerId } = req.body;
    const wr = await WatchRoom.findOne({ roomId }).catch(()=>null);
    if(!wr) return res.json({ error:'Room not found' });
    if(req.session.user.id !== wr.ownerId) return res.json({ error:'Only the host can transfer ownership' });
    const newOwner = (wr.participants||[]).find(p => p.userId === newOwnerId);
    if(!newOwner) return res.json({ error:'Target not in room' });
    wr.ownerId = newOwnerId;
    wr.ownerUsername = newOwner.username;
    wr.ownerAvatar = newOwner.avatar || '';
    await wr.save();
    gameEvents.emit('watch_update', roomId, { type:'transfer', newOwnerId, newOwnerUsername: newOwner.username });
    res.json({ success:true });
  });

  // ── Leave room (non-owner participants only) ──────────────────
  // EXPLOIT FIX 4: separate leave vs end — only owner can truly END
  app.post('/api/watch/leave', async(req, res) => {
    if(!req.session?.user) return res.status(401).json({ error:'Login required' });
    const { roomId } = req.body;
    const uid = req.session.user.id;
    const wr = await WatchRoom.findOne({ roomId }).catch(()=>null);
    if(!wr) return res.json({ error:'Room not found' });
    if(wr.ownerId === uid) return res.json({ error:'المضيف لا يمكنه مغادرة الغرفة — استخدم "إنهاء الجلسة" بدلاً من ذلك' });
    if(!isPart(wr, uid)) return res.json({ success:true }); // already gone
    wr.participants = (wr.participants||[]).filter(p => p.userId !== uid);
    wr.markModified('participants');
    await wr.save().catch(()=>{});
    gameEvents.emit('watch_update', roomId, { type:'left', userId: uid, username: req.session.user.username });
    res.json({ success:true });
  });

  // ── End session + billing + delete room (OWNER ONLY) ─────────
  app.post('/api/watch/end', async(req, res) => {
    if(!req.session?.user) return res.status(401).json({ error:'Login required' });
    const { roomId } = req.body;
    const wr = await WatchRoom.findOne({ roomId }).catch(()=>null);
    if(!wr) return res.json({ error:'Room not found' });

    // ── EXPLOIT FIX 3: only owner can end the room ───────────────
    if(req.session.user.id !== wr.ownerId){
      return res.json({ error:'❌ فقط المضيف يستطيع إنهاء الجلسة. استخدم "مغادرة" إذا أردت الخروج.' });
    }
    // ─────────────────────────────────────────────────────────────

    if(wr.status === 'ended') return res.json({ error:'Room already ended', totalCost:0, duration:0 });

    const now = Date.now();
    const sec = wr.startedAt ? Math.floor((now - wr.startedAt) / 1000) : 0;
    const totalIntervals  = Math.max(1, Math.ceil(sec / INTERVAL_SEC));
    const alreadyBilled   = billedMap.get(roomId) || 0;
    // ── EXPLOIT FIX 2: only charge what hasn't been billed yet ───
    const remainingIntervals = Math.max(0, totalIntervals - alreadyBilled);
    const remainingCost = remainingIntervals * COST_PER_INTERVAL;
    const totalCostPerPerson = totalIntervals * COST_PER_INTERVAL;
    const durationMin = Math.ceil(sec / 60);

    const allParts = [
      { userId: wr.ownerId, username: wr.ownerUsername },
      ...(wr.participants||[]).filter(p => p.userId !== wr.ownerId).map(p => ({ userId: p.userId, username: p.username }))
    ];

    await WatchLog.create({
      roomId: wr.roomId, ownerId: wr.ownerId, ownerUsername: wr.ownerUsername,
      title: wr.title, participants: allParts,
      videoLog: (wr.videoLog||[]).map(v => ({ url: v.url, loadedAt: v.loadedAt, loadedByUsername: v.loadedByUsername })),
      startedAt: wr.startedAt, endedAt: now,
      durationSec: sec, costPerPerson: totalCostPerPerson, participantCount: allParts.length,
    }).catch(()=>{});

    const participantIds = [...new Set([wr.ownerId, ...(wr.participants||[]).map(p => p.userId)])];
    if(remainingCost > 0){
      await Promise.all(participantIds.map(async uid => {
        const u = await db.findOne({ id: uid }).catch(()=>null);
        if(u){
          u.coins = Math.max(0, (u.coins||0) - remainingCost);
          await u.save().catch(()=>{});
        }
      }));
    }

    billedMap.delete(roomId);
    gameEvents.emit('watch_update', roomId, { type:'ended', totalCost: totalCostPerPerson, duration: durationMin });
    if(siteLog) siteLog('📺 Watch Session Ended',
      `**${wr.ownerUsername}** ended watch room **${wr.title||roomId}**\n` +
      `Participants: ${allParts.length} · Duration: ${durationMin} min · Total cost/person: ${totalCostPerPerson} coins`,
      '#FEE75C').catch(()=>{});
    await WatchRoom.deleteOne({ roomId }).catch(()=>{});
    res.json({ success:true, totalCost: totalCostPerPerson, duration: durationMin });
  });

  // ── Emoji reactions ───────────────────────────────────────────
  app.post('/api/watch/react', async(req, res) => {
    if(!req.session?.user) return res.status(401).json({ error:'Login required' });
    const { roomId, emoji } = req.body;
    const wr = await WatchRoom.findOne({ roomId }).lean().catch(()=>null);
    if(!wr) return res.json({ error:'Room not found' });
    if(!isPart(wr, req.session.user.id)) return res.json({ error:'Not a participant' });
    const allowed = ['🔥','🤣','😮','👏','💀','❤️','😱','🎉'];
    if(!allowed.includes(emoji)) return res.json({ error:'Invalid emoji' });
    gameEvents.emit('watch_update', roomId, { type:'reaction', emoji, username: req.session.user.username });
    res.json({ success:true });
  });

  // ── Watch room page ───────────────────────────────────────────
  app.get('/watch/:roomId', async(req, res) => {
    const user = req.session?.user || null;
    const wr = await WatchRoom.findOne({ roomId: req.params.roomId }).lean().catch(()=>null);
    if(!wr){
      return res.status(404).send(layout('Watch Party — Not Found', `
        <div class="empty-state" style="padding:80px 20px">
          <div class="ei" style="font-size:80px">🎬</div>
          <h2 style="font-family:Rajdhani,Cairo,sans-serif;font-size:32px;color:var(--primary);margin-bottom:8px">الغرفة غير موجودة</h2>
          <p style="margin-bottom:24px">انتهت هذه الجلسة أو لم تعد موجودة.</p>
          <a href="/" class="btn btn-primary btn-lg">🏠 الرئيسية</a>
        </div>
      `, '', user));
    }
    res.send(layout('🎬 ' + esc(wr.title), buildWatchPage(user, wr), '', user));
  });

  function getYTId(url){
    try{
      const u = new URL(url);
      if(u.hostname.includes('youtube.com')) return u.searchParams.get('v');
      if(u.hostname === 'youtu.be') return u.pathname.slice(1);
    }catch{}
    return null;
  }

  // ── SERVER-SIDE BILLING TICKER ────────────────────────────────
  // EXPLOIT FIX 2 & 4: bills every 30s regardless of client — no tab-close escape
  setInterval(async () => {
    try {
      const activeRooms = await WatchRoom.find({ status: 'active', startedAt: { $ne: null } }).catch(() => []);
      for (const wr of activeRooms) {
        const now           = Date.now();
        const sec           = Math.floor((now - wr.startedAt) / 1000);
        const totalIntervals = Math.floor(sec / INTERVAL_SEC); // only COMPLETED intervals
        const alreadyBilled  = billedMap.get(wr.roomId) || 0;
        const newIntervals   = totalIntervals - alreadyBilled;
        if (newIntervals <= 0) continue;

        const costThisTick = newIntervals * COST_PER_INTERVAL;
        billedMap.set(wr.roomId, totalIntervals);

        const participantIds = [...new Set([wr.ownerId, ...(wr.participants || []).map(p => p.userId)])];
        const toKick = [];

        for (const uid of participantIds) {
          const u = await db.findOne({ id: uid }).catch(() => null);
          if (!u) continue;
          if ((u.coins || 0) < costThisTick) {
            toKick.push(uid);
            u.coins = 0; // take everything they have
          } else {
            u.coins = (u.coins || 0) - costThisTick;
          }
          await u.save().catch(() => {});
        }

        // Handle kicks
        let roomEnded = false;
        for (const uid of toKick) {
          if (uid === wr.ownerId) {
            // Owner can't pay → end the whole room
            gameEvents.emit('watch_update', wr.roomId, {
              type: 'ended', totalCost: totalIntervals * COST_PER_INTERVAL,
              duration: Math.ceil(sec / 60), reason: 'owner_broke'
            });
            await WatchRoom.deleteOne({ roomId: wr.roomId }).catch(() => {});
            billedMap.delete(wr.roomId);
            roomEnded = true;
            break;
          } else {
            // Kick broke participant
            wr.participants = (wr.participants || []).filter(p => p.userId !== uid);
            wr.markModified('participants');
            const kickedUser = wr.participants.find(p => p.userId === uid);
            gameEvents.emit('watch_update', wr.roomId, {
              type: 'kicked', userId: uid,
              username: kickedUser?.username || uid,
              reason: 'insufficient_funds'
            });
          }
        }

        if (!roomEnded && toKick.length > 0) {
          await wr.save().catch(() => {});
        }
      }
    } catch (e) {
      console.error('[📺 WatchBilling] ticker error:', e.message);
    }
  }, INTERVAL_SEC * 1000);

  function buildWatchPage(user, wr){
    const uid = user?.id || '';
    const isParticipant = isPart(wr, uid);
    const isOwner = uid === wr.ownerId;
    const allParts = [
      { userId: wr.ownerId, username: wr.ownerUsername, avatar: wr.ownerAvatar||'', isOwner: true },
      ...(wr.participants||[]).filter(p => p.userId !== wr.ownerId).map(p => ({ userId: p.userId, username: p.username, avatar: p.avatar||'', isOwner: false }))
    ];
    const startedAtJs = wr.startedAt || 0;

    const partBadges = allParts.map(p => {
      const av = avUrl(p.userId, p.avatar);
      const transferBtn = (isOwner && !p.isOwner) ? '<button class="transfer-btn" onclick="transferTo(\'' + esc(p.userId) + '\',\'' + esc(p.username) + '\')">نقل</button>' : '';
      const crown = p.isOwner ? '<span style="font-size:10px">👑</span>' : '';
      return '<div class="watch-viewer" data-uid="' + esc(p.userId) + '">' +
        '<img src="' + av + '" onerror="this.src=\'https://cdn.discordapp.com/embed/avatars/0.png\'" alt="">' +
        crown + '<span>' + esc(p.username) + '</span>' + transferBtn + '</div>';
    }).join('');

    return `
<style>
.watch-container{display:flex;gap:0;height:calc(100vh - 60px);overflow:hidden;background:var(--bg)}
.watch-main{flex:1;min-width:0;display:flex;flex-direction:column;background:#000}
.watch-video-wrap{flex:1;min-height:0;position:relative;background:#000;display:flex;align-items:center;justify-content:center}
.watch-video-wrap iframe{width:100%;height:100%;border:none}
.watch-no-video{display:flex;flex-direction:column;align-items:center;justify-content:center;color:var(--text2);gap:12px;height:100%}
.watch-no-video .big-icon{font-size:72px}
.watch-url-bar{padding:10px 12px;background:var(--bg2);border-top:1px solid var(--border);display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.watch-url-bar input{flex:1;min-width:120px;background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:7px 12px;color:var(--text);font-size:13px}
.watch-url-bar input:focus{outline:none;border-color:var(--primary)}
.watch-tabs{display:flex;gap:4px;flex-shrink:0}
.watch-tab-btn{background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:5px 10px;font-size:12px;cursor:pointer;color:var(--text2);transition:.15s}
.watch-tab-btn.active{background:var(--primary);border-color:var(--primary);color:#fff}
.imdb-results{background:var(--bg2);border:1px solid var(--border);border-top:none;max-height:260px;overflow-y:auto;z-index:50}
.imdb-result{display:flex;gap:10px;padding:10px 12px;align-items:center;cursor:pointer;border-bottom:1px solid var(--border);transition:.12s}
.imdb-result:hover{background:var(--bg3)}
.imdb-poster{width:36px;height:52px;object-fit:cover;border-radius:4px;flex-shrink:0}
.imdb-poster-placeholder{width:36px;height:52px;background:var(--bg3);border-radius:4px;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:18px}
.imdb-title{font-weight:600;font-size:13px;color:var(--text)}
.imdb-meta{font-size:11px;color:var(--text2);margin-top:2px}
.watch-seek-bar{display:flex;gap:6px;padding:6px 12px;border-top:1px solid var(--border);align-items:center;background:var(--bg2)}
.watch-seek-bar label{font-size:12px;color:var(--text2);white-space:nowrap}
.watch-seek-bar input{width:80px;background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:5px 8px;color:var(--text);font-size:12px}
.watch-seek-bar input:focus{outline:none;border-color:var(--primary)}
.watch-sidebar{width:340px;flex-shrink:0;display:flex;flex-direction:column;border-left:1px solid var(--border);background:var(--bg2)}
.watch-sidebar-header{padding:14px 16px;border-bottom:1px solid var(--border);display:flex;flex-direction:column;gap:8px}
.watch-sidebar-title{font-size:15px;font-weight:700;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.watch-viewers{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.watch-viewer{display:flex;align-items:center;gap:5px;background:var(--bg3);border-radius:20px;padding:3px 8px 3px 5px;font-size:12px;color:var(--text2)}
.watch-viewer img{width:20px;height:20px;border-radius:50%;object-fit:cover}
.transfer-btn{background:none;border:1px solid var(--border);border-radius:4px;padding:1px 5px;font-size:10px;cursor:pointer;color:var(--text2);margin-left:3px}
.transfer-btn:hover{background:var(--primary);color:#fff;border-color:var(--primary)}
.watch-chat{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px}
.watch-chat::-webkit-scrollbar{width:4px}
.watch-chat::-webkit-scrollbar-thumb{background:var(--border);border-radius:4px}
.chat-msg{display:flex;gap:8px;align-items:flex-start}
.chat-msg img{width:28px;height:28px;border-radius:50%;flex-shrink:0;margin-top:2px;object-fit:cover}
.chat-msg-body{flex:1;min-width:0}
.chat-msg-header{display:flex;align-items:baseline;gap:6px;margin-bottom:2px}
.chat-msg-name{font-size:12px;font-weight:700;color:var(--primary)}
.chat-msg-time{font-size:10px;color:var(--text2)}
.chat-msg-text{font-size:13px;color:var(--text);word-break:break-word;line-height:1.4}
.chat-msg.system{justify-content:center}
.chat-msg.system .chat-msg-text{font-size:11px;color:var(--text2);font-style:italic;text-align:center}
.watch-input-wrap{padding:12px;border-top:1px solid var(--border);display:flex;gap:8px}
.watch-input-wrap textarea{flex:1;background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:8px 12px;color:var(--text);font-size:13px;font-family:inherit;resize:none;height:40px;line-height:1.4}
.watch-input-wrap textarea:focus{outline:none;border-color:var(--primary);height:72px}
.watch-input-wrap button{align-self:flex-end;flex-shrink:0}
.watch-billing{display:flex;align-items:center;gap:6px;padding:6px 10px;background:var(--bg3);border-radius:8px;font-size:12px;color:var(--text2);flex-wrap:wrap}
.watch-billing .bill-cost{color:var(--primary);font-weight:700}
.watch-billing .bill-rate{font-size:10px;color:var(--text3)}
.watch-reactions{display:flex;gap:4px;padding:8px 12px;border-top:1px solid var(--border);flex-wrap:wrap}
.react-btn{background:var(--bg3);border:1px solid var(--border);border-radius:20px;padding:4px 8px;font-size:18px;cursor:pointer;transition:transform .12s,background .12s;line-height:1.3;user-select:none}
.react-btn:hover{background:var(--border);transform:scale(1.25)}
.react-btn:active{transform:scale(.95)}
.emoji-fly{position:absolute;font-size:42px;pointer-events:none;z-index:60;animation:emojiFly 2.6s ease-out forwards}
@keyframes emojiFly{0%{transform:translateY(0) scale(1);opacity:1}100%{transform:translateY(-260px) scale(.8) rotate(15deg);opacity:0}}
@media(max-width:768px){
  .watch-container{flex-direction:column;height:auto}
  .watch-sidebar{width:100%;border-left:none;border-top:1px solid var(--border);height:400px}
  .watch-main{height:280px}
}
</style>

<div class="watch-container" id="watchContainer">
  <div class="watch-main">
    <div class="watch-video-wrap" id="videoWrap">
      <div class="watch-no-video" id="noVideoMsg">
        <div class="big-icon">🎬</div>
        <div style="font-size:16px;font-weight:600">لا يوجد فيديو</div>
        <div style="font-size:13px;text-align:center;max-width:260px;color:var(--text2)">المُضيف يختار الفيديو أو الفيلم</div>
      </div>
      <div id="playerWrap" style="width:100%;height:100%;display:none"></div>
    </div>
    ${isOwner ? `
    <div class="watch-url-bar" id="urlBar">
      <div class="watch-tabs">
        <button class="watch-tab-btn active" id="tabUrl" onclick="switchTab('url')">🔗 رابط</button>
        <button class="watch-tab-btn" id="tabImdb" onclick="switchTab('imdb')">🎬 بحث IMDB</button>
      </div>
      <div id="panelUrl" style="display:flex;gap:8px;flex:1;align-items:center">
        <input type="text" id="videoUrlInput" placeholder="يوتيوب، streamimdb.ru، أو أي رابط iframe..." />
        <button class="btn btn-primary btn-sm" onclick="setVideo()">▶ تشغيل</button>
      </div>
      <div id="panelImdb" style="display:none;gap:8px;flex:1;align-items:center">
        <input type="text" id="imdbSearch" placeholder="ابحث عن فيلم أو مسلسل بالإنجليزي..." onkeydown="if(event.key==='Enter')searchImdb()" />
        <button class="btn btn-secondary btn-sm" onclick="searchImdb()">🔍 بحث</button>
      </div>
    </div>
    <div id="imdbResults" class="imdb-results" style="display:none"></div>
    <div class="watch-seek-bar">
      <label>⏩ انتقل:</label>
      <input type="text" id="seekInput" placeholder="د:ث مثل 5:30" />
      <button class="btn btn-secondary btn-sm" id="seekBtn">انتقل</button>
    </div>
    ` : ''}
  </div>

  <div class="watch-sidebar">
    <div class="watch-sidebar-header">
      <div class="watch-sidebar-title" title="${esc(wr.title)}">🎬 ${esc(wr.title)}</div>
      <div class="watch-viewers" id="participantsList">
        ${partBadges}
      </div>
      ${isParticipant ? `
      <div class="watch-billing">
        <span id="sessionTimer">⏱️ 0:00</span>
        <span>·</span>
        <span class="bill-cost" id="sessionCost">💰 0 كوين</span>
        <span class="bill-rate">100🪙/30ث</span>
        <span style="flex:1"></span>
        ${isOwner
          ? `<button class="btn btn-danger btn-sm" id="endBtn" style="font-size:11px;padding:3px 10px" title="إنهاء الجلسة للجميع">🔴 إنهاء الجلسة</button>`
          : `<button class="btn btn-secondary btn-sm" id="endBtn" style="font-size:11px;padding:3px 10px" title="مغادرة الغرفة (لن تنهي الجلسة)">🚶 مغادرة</button>`
        }
      </div>` : ''}
    </div>
    <div class="watch-chat" id="chatArea"></div>
    ${isParticipant ? `
    <div class="watch-reactions">
      <button class="react-btn" data-emoji="🔥">🔥</button>
      <button class="react-btn" data-emoji="🤣">🤣</button>
      <button class="react-btn" data-emoji="😮">😮</button>
      <button class="react-btn" data-emoji="👏">👏</button>
      <button class="react-btn" data-emoji="💀">💀</button>
      <button class="react-btn" data-emoji="❤️">❤️</button>
      <button class="react-btn" data-emoji="😱">😱</button>
      <button class="react-btn" data-emoji="🎉">🎉</button>
    </div>
    <div class="watch-input-wrap">
      <textarea id="chatInput" placeholder="اكتب رسالة… (Enter للإرسال)" onkeydown="chatKeydown(event)"></textarea>
      <button class="btn btn-primary btn-sm" onclick="sendMessage()" style="height:40px">إرسال</button>
    </div>` : `<div style="padding:16px;text-align:center;color:var(--text2);font-size:13px">أنت تشاهد كضيف</div>`}
  </div>
</div>

<script>window.__WR=${JSON.stringify({roomId:wr.roomId,uid:uid,ownerId:wr.ownerId,isParticipant:isParticipant,isOwner:isOwner,startAt:startedAtJs}).replace(/</g,'\\u003c').replace(/>/g,'\\u003e')};</script>
<script src="/watch-room.js"></script>
`;
  }
};
