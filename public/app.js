/* ── Theme ─────────────────────────────────────────────────── */
(function() {
  const theme = localStorage.getItem('theme') || 'dark';
  localStorage.setItem('lang', 'en');
  if (theme === 'light') document.documentElement.classList.add('light-pre');
})();

document.addEventListener('DOMContentLoaded', () => {
  /* apply saved preferences */
  const theme = localStorage.getItem('theme') || 'dark';
  if (theme === 'light') document.body.classList.add('light');
  document.documentElement.dir = 'ltr';

  /* active nav links */
  const path = window.location.pathname;
  document.querySelectorAll('.sidebar a, .nav-links a').forEach(a => {
    const href = a.getAttribute('href');
    if (href === path || (href !== '/' && path.startsWith(href))) a.classList.add('active');
  });

  /* hamburger */
  const burger  = document.getElementById('hamburger');
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('overlay');
  if (burger && sidebar) {
    burger.addEventListener('click', () => {
      sidebar.classList.toggle('open');
      overlay?.classList.toggle('show');
    });
    overlay?.addEventListener('click', () => {
      sidebar.classList.remove('open');
      overlay.classList.remove('show');
    });
  }

  /* theme toggle */
  const themeBtn = document.getElementById('themeToggle');
  if (themeBtn) {
    themeBtn.textContent = theme === 'light' ? '🌙' : '☀️';
    themeBtn.addEventListener('click', () => {
      const isLight = document.body.classList.toggle('light');
      localStorage.setItem('theme', isLight ? 'light' : 'dark');
      themeBtn.textContent = isLight ? '🌙' : '☀️';
    });
  }

  /* lang toggle — English only, Arabic disabled */
  localStorage.setItem('lang', 'en');
  document.body.classList.remove('rtl');
  document.documentElement.dir = 'ltr';

  /* tabs */
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      const container = btn.closest('[data-tabs]') || document;
      container.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      container.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      const panel = container.querySelector(`[data-panel="${target}"]`);
      if (panel) panel.classList.add('active');
    });
  });

  /* help accordions */
  document.querySelectorAll('.help-card').forEach(card => {
    const hdr = card.querySelector('.help-card-header');
    if (hdr) hdr.addEventListener('click', () => card.classList.toggle('open'));
  });

  /* nav search */
  const navSearch = document.getElementById('navSearch');
  if (navSearch) {
    navSearch.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        const v = navSearch.value.trim();
        if (v) window.location.href = `/search?q=${encodeURIComponent(v)}`;
      }
    });
  }
  const navSearchBtn = document.getElementById('navSearchBtn');
  if (navSearchBtn) {
    navSearchBtn.addEventListener('click', () => {
      const v = navSearch?.value.trim();
      if (v) window.location.href = `/search?q=${encodeURIComponent(v)}`;
    });
  }

  /* counter animation */
  document.querySelectorAll('[data-count]').forEach(el => {
    const target = parseInt(el.dataset.count, 10);
    if (!isNaN(target)) {
      let current = 0;
      const step = Math.ceil(target / 40);
      const timer = setInterval(() => {
        current = Math.min(current + step, target);
        el.textContent = current.toLocaleString();
        if (current >= target) clearInterval(timer);
      }, 30);
    }
  });

  /* particles */
  generateParticles();

  /* animate on scroll */
  const obs = new IntersectionObserver((entries) => {
    entries.forEach(e => { if (e.isIntersecting) { e.target.style.opacity = '1'; e.target.style.transform = 'translateY(0)'; } });
  }, { threshold: 0.1 });
  document.querySelectorAll('.stat-card, .card, .news-card, .item-card, .vip-card').forEach(el => {
    el.style.transition = 'opacity 0.5s ease, transform 0.5s ease';
    obs.observe(el);
  });

  /* live leaderboard refresh */
  const lbRefresh = document.querySelector('[data-live]');
  if (lbRefresh) setTimeout(() => window.location.reload(), 60000);
});

/* ── Particles (overridden by enhanced version at bottom) ─── */

/* ── Toast notifications ──────────────────────────────────── */
function showToast(msg, type = 'info', duration = 3000) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  const icons = { success:'✅', error:'❌', info:'ℹ️', warn:'⚠️' };
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span>${icons[type]||'ℹ️'}</span><span>${msg}</span>`;
  container.appendChild(toast);
  setTimeout(() => { toast.style.opacity='0'; toast.style.transform='translateX(20px)'; setTimeout(()=>toast.remove(),300); }, duration);
}

/* ── Copy to clipboard ────────────────────────────────────── */
function copyText(text) {
  navigator.clipboard.writeText(text).then(() => showToast('Copied to clipboard!', 'success'));
}

/* ── Provably Fair Verifier ───────────────────────────────── */
async function verifyPF(e) {
  e.preventDefault();
  const serverSeed = document.getElementById('serverSeed').value.trim();
  const clientSeed = document.getElementById('clientSeed').value.trim();
  const nonce      = document.getElementById('nonce').value.trim();
  const resultDiv  = document.getElementById('pfResult');

  if (!serverSeed || !clientSeed || nonce === '') {
    resultDiv.innerHTML = `<div class="alert alert-error">❌ Please fill in all fields</div>`; return;
  }
  resultDiv.innerHTML = `<div class="alert alert-info">⏳ Verifying...</div>`;
  try {
    const res  = await fetch('/api/verify-pf', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({serverSeed,clientSeed,nonce}) });
    const data = await res.json();
    if (data.error) { resultDiv.innerHTML=`<div class="alert alert-error">❌ ${data.error}</div>`; return; }
    resultDiv.innerHTML = `
      <div class="result-card">
        <div class="result-roll">${data.roll}</div>
        <div class="result-row"><span class="result-label">Server Seed Hash</span><span class="result-value">${data.serverSeedHash}</span></div>
        <div class="result-row"><span class="result-label">Payload</span><span class="result-value">${data.payload}</span></div>
        <div class="result-row"><span class="result-label">HMAC-SHA256</span><span class="result-value">${data.hmac}</span></div>
        <div class="result-row"><span class="result-label">Derived Roll (0–99.99)</span><span class="result-value" style="color:var(--green);font-size:15px;font-weight:700">${data.roll}</span></div>
        <div style="text-align:center;margin-top:14px">
          <button class="btn btn-ghost btn-sm" onclick="copyText('${data.serverSeedHash}')">📋 Copy Hash</button>
        </div>
      </div>`;
  } catch { resultDiv.innerHTML=`<div class="alert alert-error">❌ Server error</div>`; }
}

/* ── Modal helpers ────────────────────────────────────────── */
function openModal(id)  { document.getElementById(id)?.classList.add('open'); }
function closeModal(id) { document.getElementById(id)?.classList.remove('open'); }
document.addEventListener('click', e => {
  if (e.target.classList.contains('modal-bg')) e.target.classList.remove('open');
});

/* ── Admin actions ────────────────────────────────────────── */
async function adminAction(url, method, body, confirmMsg) {
  if (confirmMsg && !confirm(confirmMsg)) return;
  try {
    const res  = await fetch(url, { method, headers:{'Content-Type':'application/json'}, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json();
    if (data.success) showToast(data.message || 'Done!', 'success');
    else showToast(data.error || 'Error', 'error');
    if (data.reload) setTimeout(()=>window.location.reload(), 1000);
  } catch { showToast('Network error', 'error'); }
}

/* ── Customization preview ────────────────────────────────── */
function selectSwatch(el, group) {
  document.querySelectorAll(`[data-group="${group}"]`).forEach(s => s.classList.remove('selected'));
  el.classList.add('selected');
  const val = el.dataset.value;
  if (group === 'theme') {
    const banner = document.getElementById('previewBanner');
    if (banner) { banner.className = 'profile-banner theme-'+val; }
    const inp = document.getElementById('themeInput');
    if (inp) inp.value = val;
  }
  if (group === 'border') {
    const avatar = document.getElementById('previewAvatar');
    if (avatar) { avatar.className = 'profile-avatar border-'+val; }
    const inp = document.getElementById('borderInput');
    if (inp) inp.value = val;
  }
  if (group === 'bg') {
    const inp = document.getElementById('bgInput');
    if (inp) inp.value = val;
  }
}

/* ── Comment form ─────────────────────────────────────────── */
async function submitComment(e, profileId) {
  e.preventDefault();
  const input = document.getElementById('commentInput');
  const text  = input?.value.trim();
  if (!text) return;
  const res  = await fetch(`/api/comment/${profileId}`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({text}) });
  const data = await res.json();
  if (data.success) { showToast('Comment posted!','success'); setTimeout(()=>location.reload(),800); }
  else showToast(data.error||'Login required','error');
}

/* ── Friend action ────────────────────────────────────────── */
async function friendAction(targetId, action) {
  const res  = await fetch(`/api/friend/${targetId}/${action}`, { method:'POST' });
  const data = await res.json();
  if (data.success) { showToast(data.message,'success'); setTimeout(()=>location.reload(),800); }
  else showToast(data.error||'Login required','error');
}

/* ── Search ───────────────────────────────────────────────── */
function doSearch(e) {
  if (e) e.preventDefault();
  const v = document.getElementById('searchInput')?.value.trim();
  if (v) window.location.href = `/search?q=${encodeURIComponent(v)}`;
}

/* ── Leaderboard refresh ──────────────────────────────────── */
function refreshLb() { window.location.reload(); }

/* ══════════════════════════════════════════════════════════
   SOUND EFFECTS SYSTEM
══════════════════════════════════════════════════════════ */
const SoundEngine = (function() {
  let ctx = null;
  let enabled = localStorage.getItem('sound') !== 'off';

  function getCtx() {
    if (!ctx) { try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch(e) { return null; } }
    if (ctx.state === 'suspended') ctx.resume().catch(()=>{});
    return ctx;
  }

  function tone(freq, type='sine', duration=0.15, gain=0.18, startGain=0.18, endGain=0) {
    if (!enabled) return;
    const c = getCtx(); if (!c) return;
    try {
      const o = c.createOscillator();
      const g = c.createGain();
      o.connect(g); g.connect(c.destination);
      o.type = type; o.frequency.setValueAtTime(freq, c.currentTime);
      g.gain.setValueAtTime(startGain, c.currentTime);
      g.gain.linearRampToValueAtTime(endGain, c.currentTime + duration);
      o.start(c.currentTime);
      o.stop(c.currentTime + duration);
    } catch(e) {}
  }

  function chord(freqs, type='sine', duration=0.2, gain=0.12) {
    freqs.forEach((f, i) => setTimeout(() => tone(f, type, duration, gain), i * 30));
  }

  return {
    isEnabled: () => enabled,
    setEnabled: (v) => { enabled = v; localStorage.setItem('sound', v ? 'on' : 'off'); },
    click:   () => tone(800, 'sine', 0.08, 0.10),
    success: () => chord([523, 659, 784], 'sine', 0.25, 0.12),
    error:   () => chord([220, 196], 'sawtooth', 0.2, 0.08),
    coin:    () => chord([1046, 1318, 1568], 'sine', 0.3, 0.10),
    notify:  () => chord([698, 880], 'sine', 0.2, 0.12),
    whoosh:  () => {
      if (!enabled) return;
      const c = getCtx(); if (!c) return;
      try {
        const o = c.createOscillator(), g = c.createGain();
        o.connect(g); g.connect(c.destination);
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(600, c.currentTime);
        o.frequency.linearRampToValueAtTime(200, c.currentTime + 0.2);
        g.gain.setValueAtTime(0.08, c.currentTime);
        g.gain.linearRampToValueAtTime(0, c.currentTime + 0.2);
        o.start(c.currentTime); o.stop(c.currentTime + 0.2);
      } catch(e) {}
    },
    jackpot: () => {
      if (!enabled) return;
      [0,80,160,240,320].forEach((d,i) => {
        setTimeout(() => tone(523 + i*100, 'sine', 0.15, 0.10 + i*0.02), d);
      });
    }
  };
})();

/* Wire up sound toggle button */
document.addEventListener('DOMContentLoaded', () => {
  const soundBtn = document.getElementById('soundToggle');
  if (soundBtn) {
    const update = () => {
      soundBtn.textContent = SoundEngine.isEnabled() ? '🔊' : '🔇';
      soundBtn.classList.toggle('muted', !SoundEngine.isEnabled());
    };
    update();
    soundBtn.addEventListener('click', () => {
      SoundEngine.setEnabled(!SoundEngine.isEnabled());
      update();
      if (SoundEngine.isEnabled()) SoundEngine.notify();
    });
  }

  /* Add click sounds to all buttons */
  document.addEventListener('click', e => {
    const el = e.target.closest('button, .btn, a.btn');
    if (el && !el.id?.includes('soundToggle') && !el.id?.includes('themeToggle')) {
      SoundEngine.click();
    }
  }, true);
});

/* Override showToast to play sounds */
const _origShowToast = showToast;
window.showToast = function(msg, type='info', duration=3000) {
  _origShowToast(msg, type, duration);
  if (type === 'success') SoundEngine.success();
  else if (type === 'error') SoundEngine.error();
  else if (type === 'warn') SoundEngine.notify();
};

/* ══════════════════════════════════════════════════════════
   ENHANCED PARTICLES (more varied)
══════════════════════════════════════════════════════════ */
function generateParticles() {
  const container = document.getElementById('particles');
  if (!container) return;
  container.innerHTML = '';
  const count = window.innerWidth < 600 ? 20 : 45;
  const isRezero = document.body.classList.contains('rezero');
  const colors = isRezero
    ? ['#8b5cf6','#a78bfa','#7c3aed','#f472b6','#c4b5fd','#6d28d9']
    : ['#0ea5e9','#8b5cf6','#f59e0b','#10b981','#ec4899','#38bdf8'];
  const shapes = ['circle','diamond','star'];
  for (let i = 0; i < count; i++) {
    const p = document.createElement('div');
    const shape = shapes[Math.floor(Math.random() * shapes.length)];
    const color = colors[Math.floor(Math.random() * colors.length)];
    const size = 1.5 + Math.random() * 3;
    p.className = 'particle';
    p.style.cssText = `
      left: ${Math.random()*100}%;
      animation-duration: ${7 + Math.random()*14}s;
      animation-delay: ${-Math.random()*14}s;
      width: ${size}px;
      height: ${size}px;
      background: ${color};
      opacity: ${0.2 + Math.random()*0.5};
      border-radius: ${shape === 'circle' ? '50%' : shape === 'diamond' ? '2px' : '50%'};
      transform: ${shape === 'diamond' ? 'rotate(45deg)' : 'none'};
    `;
    container.appendChild(p);
  }
}
