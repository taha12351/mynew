/* ═══════════════════════════════════════════════════════════════════
   💹 BitTrade — منصة تداول الأسهم
   Arabic RTL Trading Platform — Connected to Discord Bot StockMarket
═══════════════════════════════════════════════════════════════════ */

const fs            = require('fs');
const path          = require('path');
const crypto        = require('crypto');

const StockPortfolio = require('./models/stockPortfolio');
const stockMarket    = require('./stockMarket');

/* ── الأسهم المتاحة (مرآة من stockMarket.js) ────────────────── */
const REAL_STOCKS = {
  'AAPL':    { name: 'Apple',        nameAr: 'آبل',           emoji: '🍎', type: 'real',   color: '#6366f1' },
  'TSLA':    { name: 'Tesla',        nameAr: 'تيسلا',          emoji: '⚡', type: 'real',   color: '#f59e0b' },
  'NVDA':    { name: 'NVIDIA',       nameAr: 'إنفيديا',        emoji: '🟢', type: 'real',   color: '#22c55e' },
  'AMZN':    { name: 'Amazon',       nameAr: 'أمازون',         emoji: '📦', type: 'real',   color: '#f97316' },
  'GOOGL':   { name: 'Google',       nameAr: 'جوجل',           emoji: '🔍', type: 'real',   color: '#0ea5e9' },
  'BTC-USD': { name: 'Bitcoin',      nameAr: 'بيتكوين',        emoji: '₿',  type: 'real',   color: '#eab308' },
};
const CASINO_STOCKS = {
  'CHAIN':   { name: 'Chainsaw Corp',    nameAr: 'شركة المنشار',   emoji: '🪚', type: 'casino', color: '#ef4444', basePrice: 5000  },
  'BLOOD':   { name: 'Blood Fiend Corp', nameAr: 'شركة الدم',      emoji: '🩸', type: 'casino', color: '#dc2626', basePrice: 3000  },
  'DIAMOND': { name: 'Diamond Casino',   nameAr: 'كازينو ألماس',   emoji: '💎', type: 'casino', color: '#8b5cf6', basePrice: 10000 },
  'REZERO':  { name: 'Re:Zero Fund',     nameAr: 'صندوق ريزيرو',   emoji: '❄️', type: 'casino', color: '#06b6d4', basePrice: 4000  },
};
const ALL_DEFS = { ...REAL_STOCKS, ...CASINO_STOCKS };

/* ── Auto-Sell Orders (in-memory, per userId) ────────────────── */
const autoSellOrders = new Map(); // userId -> [{ symbol, type:'stop'|'take', price }]

function getOrders(userId) {
  if (!autoSellOrders.has(userId)) autoSellOrders.set(userId, []);
  return autoSellOrders.get(userId);
}

/* ── SSE Clients ─────────────────────────────────────────────── */
const sseClients = new Set();
function broadcastSSE(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch {}
  }
}

/* ── Auto-sell checker (runs every 30s) ─────────────────────── */
let _db;
function startAutoSellChecker() {
  setInterval(async () => {
    for (const [userId, orders] of autoSellOrders.entries()) {
      if (!orders.length) continue;
      const toRemove = [];
      for (const order of orders) {
        const p = stockMarket.getPrice(order.symbol);
        if (!p) continue;
        let triggered = false;
        let reason = '';
        if (order.type === 'stop' && p.price <= order.price) {
          triggered = true; reason = 'وقف الخسارة';
        } else if (order.type === 'take' && p.price >= order.price) {
          triggered = true; reason = 'جني الأرباح';
        }
        if (!triggered) continue;

        try {
          const portfolio = await StockPortfolio.findOne({ userId });
          const holding   = portfolio?.holdings?.find(h => h.symbol === order.symbol);
          if (!holding || holding.shares <= 0) { toRemove.push(order); continue; }

          const def = ALL_DEFS[order.symbol] || {};
          const grossRevenue = p.price * holding.shares;
          const costBasis    = holding.avgBuyPrice * holding.shares;
          const grossProfit  = grossRevenue - costBasis;
          const taxRate      = getTaxRate();
          const taxAmount    = grossProfit > 0 ? Math.floor(grossProfit * taxRate) : 0;
          const revenue      = grossRevenue - taxAmount;

          holding.shares = 0;
          portfolio.holdings = portfolio.holdings.filter(h => h.symbol !== order.symbol);
          portfolio.realizedProfit = (portfolio.realizedProfit || 0) + (grossProfit - taxAmount);
          portfolio.totalTrades    = (portfolio.totalTrades || 0) + 1;
          portfolio.markModified('holdings');
          await portfolio.save();

          const userData = await _db.findOne({ id: userId });
          if (userData) {
            userData.coins = (parseInt(userData.coins || 0) + revenue).toString();
            await userData.save();
          }

          broadcastSSE({ type: 'autosell', userId, symbol: order.symbol, reason, price: p.price, revenue });
          toRemove.push(order);
          console.log(`[AutoSell] ${userId} — ${order.symbol} (${reason}) @ ${p.price}`);
        } catch (e) {
          console.error('[AutoSell] Error:', e.message);
        }
      }
      const updated = orders.filter(o => !toRemove.includes(o));
      autoSellOrders.set(userId, updated);
    }
  }, 30_000);
}

function getTaxRate() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
    return typeof cfg.taxRate === 'number' ? cfg.taxRate : 0.04;
  } catch { return 0.04; }
}

function fmt(n) { return Math.round(Number(n)).toLocaleString('en-US'); }
function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function avatarUrl(userId, avatarHash) {
  if (avatarHash) return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.png?size=80`;
  return `https://cdn.discordapp.com/embed/avatars/${Number(userId||0)%5}.png`;
}

/* ════════════════════════════════════════════════════════════════
   HTML PAGE
════════════════════════════════════════════════════════════════ */
function buildPage(user) {
  const isLoggedIn = !!user;
  const username   = isLoggedIn ? esc(user.username) : '';
  const avatar     = isLoggedIn ? avatarUrl(user.id, user.avatar) : '';

  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BitTrade — منصة التداول</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='16' fill='%2300c076'/><text y='.72em' x='12' font-size='58' font-weight='900' fill='%23000' font-family='Arial'>BT</text></svg>">
<style>
  /* ── Reset & Base ─────────────────────────────── */
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg:        #050505;
    --bg2:       #0a0a0a;
    --bg3:       #0f0f0f;
    --card:      #111111;
    --card2:     #161616;
    --border:    #1f1f1f;
    --border2:   #2a2a2a;
    --green:     #00c076;
    --green2:    #009960;
    --red:       #e6334a;
    --red2:      #b82238;
    --gold:      #d4af37;
    --blue:      #3b82f6;
    --blue2:     #2563eb;
    --purple:    #8b5cf6;
    --text:      #e0e0e0;
    --text2:     #888888;
    --text3:     #444444;
    --glow-g:    none;
    --glow-r:    none;
    --glow-b:    none;
    --radius:    6px;
    --transition: .15s ease;
  }
  html { scroll-behavior: smooth; }
  body { font-family: 'Segoe UI', 'Arial', sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; direction: rtl; }
  a { color: inherit; text-decoration: none; }
  button { cursor: pointer; font-family: inherit; }
  input, select { font-family: inherit; }

  /* ── Scrollbar ────────────────────────────────── */
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: var(--bg2); }
  ::-webkit-scrollbar-thumb { background: var(--border2); border-radius: 3px; }

  /* ── Topbar ───────────────────────────────────── */
  .topbar {
    position: fixed; top: 0; left: 0; right: 0; z-index: 100;
    height: 56px;
    background: #000;
    border-bottom: 1px solid var(--border);
    display: flex; align-items: center; justify-content: space-between;
    padding: 0 20px; gap: 16px;
  }
  .topbar-logo {
    display: flex; align-items: center; gap: 10px;
    font-size: 1.1rem; font-weight: 700;
    color: var(--text);
    white-space: nowrap; letter-spacing: .05em;
  }
  .topbar-logo .logo-mark {
    width: 28px; height: 28px; background: var(--green); border-radius: 4px;
    display: flex; align-items: center; justify-content: center;
    font-size: .75rem; font-weight: 900; color: #000; letter-spacing: 0;
  }
  .topbar-logo .logo-sub { font-size: .65rem; color: var(--text3); font-weight: 400; margin-top: -2px; }
  .topbar-ticker {
    flex: 1; overflow: hidden; min-width: 0;
    display: flex; align-items: center; gap: 0;
    mask-image: linear-gradient(to right, transparent, black 10%, black 90%, transparent);
  }
  .ticker-inner {
    display: flex; gap: 28px; animation: ticker 40s linear infinite;
    white-space: nowrap; padding: 0 28px;
  }
  .ticker-inner:hover { animation-play-state: paused; }
  @keyframes ticker { from { transform: translateX(0); } to { transform: translateX(-50%); } }
  .ticker-item { display: flex; align-items: center; gap: 6px; font-size: .82rem; font-weight: 600; }
  .ticker-sym { color: var(--text2); }
  .ticker-price { color: var(--text); }
  .ticker-chg.up  { color: var(--green); }
  .ticker-chg.dn  { color: var(--red); }
  .topbar-actions { display: flex; align-items: center; gap: 10px; }
  .user-pill {
    display: flex; align-items: center; gap: 8px;
    background: var(--card2); border: 1px solid var(--border2);
    border-radius: 40px; padding: 4px 14px 4px 6px;
    font-size: .85rem;
  }
  .user-pill img { width: 28px; height: 28px; border-radius: 50%; }
  .btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 16px; border-radius: 8px; border: none; font-size: .85rem; font-weight: 600; transition: var(--transition); }
  .btn-discord { background: #5865F2; color: #fff; }
  .btn-discord:hover { background: #4752c4; }
  .btn-ghost { background: transparent; border: 1px solid var(--border2); color: var(--text2); }
  .btn-ghost:hover { background: var(--card2); color: var(--text); }
  .btn-green { background: var(--green); color: #000; font-weight: 700; }
  .btn-green:hover { background: var(--green2); }
  .btn-red { background: var(--red); color: #fff; font-weight: 700; }
  .btn-red:hover { background: var(--red2); }
  .btn-gold { background: var(--gold); color: #000; font-weight: 700; }
  .btn-gold:hover { filter: brightness(1.1); }
  .btn-sm { padding: 6px 12px; font-size: .8rem; }
  .btn-back { background: var(--card); border: 1px solid var(--border); color: var(--text2); padding: 6px 14px; border-radius: 8px; font-size: .82rem; }
  .btn-back:hover { color: var(--text); border-color: var(--border2); }

  /* ── Layout ───────────────────────────────────── */
  .layout { display: flex; min-height: 100vh; padding-top: 60px; }
  .sidebar {
    width: 220px; flex-shrink: 0;
    background: var(--bg2);
    border-left: 1px solid var(--border);
    padding: 20px 0;
    position: sticky; top: 60px; height: calc(100vh - 60px);
    overflow-y: auto; display: flex; flex-direction: column; gap: 4px;
  }
  .sidebar a {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 18px; font-size: .88rem; color: var(--text2);
    border-radius: 8px; margin: 0 8px;
    transition: var(--transition);
  }
  .sidebar a:hover, .sidebar a.active { background: var(--card2); color: var(--text); }
  .sidebar a.active { border-right: 3px solid var(--green); }
  .sidebar-label { padding: 16px 18px 6px; font-size: .72rem; color: var(--text3); text-transform: uppercase; letter-spacing: .08em; }
  .main { flex: 1; min-width: 0; padding: 24px; display: flex; flex-direction: column; gap: 24px; }

  /* ── Market Status Banner ─────────────────────── */
  .market-banner {
    border-radius: var(--radius);
    padding: 14px 20px;
    display: flex; align-items: center; justify-content: space-between;
    font-weight: 700;
    gap: 16px; flex-wrap: wrap;
  }
  .market-banner.bull { background: var(--card); border: 1px solid rgba(0,192,118,.25); border-right: 3px solid var(--green); }
  .market-banner.bear { background: var(--card); border: 1px solid rgba(230,51,74,.25); border-right: 3px solid var(--red); }
  .market-banner.neutral { background: var(--card); border: 1px solid var(--border); }
  .market-banner .market-status { display: flex; align-items: center; gap: 10px; font-size: 1.05rem; }
  .market-banner .market-info { display: flex; gap: 20px; flex-wrap: wrap; }
  .market-banner .stat { font-size: .8rem; font-weight: 400; color: var(--text2); }
  .market-banner .stat span { color: var(--text); font-weight: 600; }
  .pulse { display: inline-block; width: 10px; height: 10px; border-radius: 50%; animation: pulse 1.5s ease-in-out infinite; }
  .pulse.green { background: var(--green); }
  .pulse.red   { background: var(--red); }
  @keyframes pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.5;transform:scale(1.3)} }

  /* ── Crash Alert ──────────────────────────────── */
  .crash-alert {
    display: none;
    background: var(--card);
    border: 1px solid var(--red);
    border-right: 3px solid var(--red);
    border-radius: var(--radius);
    padding: 14px 20px;
    font-weight: 700;
    color: var(--red);
  }
  .crash-alert.show { display: flex; align-items: center; gap: 14px; justify-content: space-between; flex-wrap: wrap; }
  @keyframes flashRed { 0%,100%{border-color:var(--red)} 50%{border-color:#ff6666} }

  /* ── Tabs ─────────────────────────────────────── */
  .tabs { display: flex; gap: 4px; background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); padding: 4px; width: fit-content; }
  .tab { padding: 8px 20px; border-radius: 8px; font-size: .88rem; font-weight: 600; color: var(--text2); background: none; border: none; transition: var(--transition); }
  .tab.active { background: var(--card2); color: var(--text); }
  .tab:hover:not(.active) { color: var(--text); }
  .tab-panel { display: none; }
  .tab-panel.active { display: block; }

  /* ── Stock Grid ───────────────────────────────── */
  .stocks-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px; }
  .stock-card {
    background: var(--card); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 18px;
    transition: var(--transition); position: relative; overflow: hidden;
  }
  .stock-card::before {
    content: ''; position: absolute; top: 0; right: 0; width: 4px; height: 100%;
    background: var(--accent-color, var(--border2));
  }
  .stock-card:hover { border-color: var(--border2); transform: translateY(-2px); box-shadow: 0 8px 24px rgba(0,0,0,.3); }
  .stock-card.up::before { background: var(--green); }
  .stock-card.dn::before { background: var(--red); }
  .sc-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
  .sc-sym { display: flex; align-items: center; gap: 8px; }
  .sc-icon { width: 36px; height: 36px; border-radius: 4px; display: flex; align-items: center; justify-content: center; font-size: .7rem; font-weight: 900; color: #000; letter-spacing: 0; }
  .sc-name { font-size: .95rem; font-weight: 700; }
  .sc-name-ar { font-size: .78rem; color: var(--text2); }
  .sc-badge { font-size: .68rem; padding: 2px 7px; border-radius: 3px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
  .sc-badge.real   { background: rgba(59,130,246,.1); color: #5b9cf6; border: 1px solid rgba(59,130,246,.2); }
  .sc-badge.casino { background: rgba(139,92,246,.1); color: #a78bfa; border: 1px solid rgba(139,92,246,.2); }
  .sc-price { font-size: 1.5rem; font-weight: 800; margin: 8px 0 4px; }
  .sc-price .coin-label { font-size: .8rem; color: var(--text2); font-weight: 400; }
  .sc-usd { font-size: .78rem; color: var(--text3); }
  .sc-change { display: flex; align-items: center; gap: 6px; font-size: .88rem; font-weight: 700; margin-bottom: 14px; }
  .sc-change.up { color: var(--green); }
  .sc-change.dn { color: var(--red); }
  .sc-mini-chart { height: 50px; margin-bottom: 14px; position: relative; overflow: hidden; }
  .sc-mini-chart canvas { width: 100% !important; height: 50px !important; }
  .sc-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .sc-actions .btn { justify-content: center; font-size: .82rem; }

  /* ── Portfolio ────────────────────────────────── */
  .portfolio-header { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; margin-bottom: 20px; }
  .pf-summary { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px; margin-bottom: 20px; }
  .pf-stat {
    background: var(--card); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 14px 16px;
  }
  .pf-stat-label { font-size: .75rem; color: var(--text2); margin-bottom: 6px; }
  .pf-stat-value { font-size: 1.25rem; font-weight: 800; }
  .pf-stat-value.up { color: var(--green); }
  .pf-stat-value.dn { color: var(--red); }
  .pf-table { width: 100%; border-collapse: collapse; }
  .pf-table th { padding: 10px 14px; font-size: .78rem; color: var(--text3); text-align: right; border-bottom: 1px solid var(--border); }
  .pf-table td { padding: 14px 14px; font-size: .88rem; border-bottom: 1px solid var(--border); vertical-align: middle; }
  .pf-table tr:last-child td { border-bottom: none; }
  .pf-table tr:hover td { background: var(--card2); }
  .holding-sym { display: flex; align-items: center; gap: 8px; font-weight: 700; }
  .pnl.up { color: var(--green); }
  .pnl.dn { color: var(--red); }

  /* ── Auto-Sell ────────────────────────────────── */
  .autosell-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }
  .as-card {
    background: var(--card); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 16px;
  }
  .as-card .as-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
  .as-type { font-size: .72rem; padding: 2px 8px; border-radius: 40px; font-weight: 700; }
  .as-type.stop { background: rgba(255,59,92,.2); color: var(--red); border: 1px solid rgba(255,59,92,.3); }
  .as-type.take { background: rgba(0,208,132,.2); color: var(--green); border: 1px solid rgba(0,208,132,.3); }
  .as-price { font-size: 1.15rem; font-weight: 800; }
  .as-sym { color: var(--text2); font-size: .82rem; }

  /* ── History Table ────────────────────────────── */
  .history-empty { text-align: center; padding: 60px 20px; color: var(--text3); font-size: .95rem; }

  /* ── Modal ────────────────────────────────────── */
  .modal-bg {
    position: fixed; inset: 0; z-index: 500;
    background: rgba(0,0,0,.75); backdrop-filter: blur(6px);
    display: flex; align-items: center; justify-content: center;
    padding: 20px; opacity: 0; pointer-events: none;
    transition: opacity .25s;
  }
  .modal-bg.open { opacity: 1; pointer-events: all; }
  .modal {
    background: var(--card); border: 1px solid var(--border2);
    border-radius: 16px; width: 100%; max-width: 440px;
    padding: 28px; position: relative;
    transform: scale(.95); transition: transform .25s;
    box-shadow: 0 24px 64px rgba(0,0,0,.5);
  }
  .modal-bg.open .modal { transform: scale(1); }
  .modal-close { position: absolute; top: 16px; left: 16px; background: none; border: none; color: var(--text3); font-size: 1.3rem; cursor: pointer; }
  .modal-close:hover { color: var(--text); }
  .modal-title { font-size: 1.15rem; font-weight: 800; margin-bottom: 20px; }
  .modal-stock-info { display: flex; align-items: center; gap: 12px; background: var(--bg3); border-radius: 10px; padding: 14px; margin-bottom: 20px; }
  .modal-stock-info .ms-icon { width: 42px; height: 42px; border-radius: 6px; display: flex; align-items: center; justify-content: center; font-size: .75rem; font-weight: 900; color: #000; }
  .modal-stock-info .ms-name { font-weight: 700; font-size: 1rem; }
  .modal-stock-info .ms-price { color: var(--text2); font-size: .85rem; margin-top: 2px; }
  .form-group { margin-bottom: 16px; }
  .form-label { display: block; font-size: .82rem; color: var(--text2); margin-bottom: 6px; font-weight: 600; }
  .form-input {
    width: 100%; padding: 10px 14px;
    background: var(--bg3); border: 1px solid var(--border2);
    border-radius: 8px; color: var(--text); font-size: .95rem;
    transition: var(--transition); outline: none;
  }
  .form-input:focus { border-color: var(--blue); box-shadow: 0 0 0 3px rgba(59,130,246,.15); }
  .form-input::placeholder { color: var(--text3); }
  .form-summary {
    background: var(--bg3); border-radius: 10px; padding: 14px;
    font-size: .85rem; display: flex; flex-direction: column; gap: 8px; margin-bottom: 20px;
  }
  .form-summary .fs-row { display: flex; justify-content: space-between; }
  .form-summary .fs-row span:last-child { font-weight: 700; }
  .form-summary .fs-total { border-top: 1px solid var(--border); padding-top: 8px; font-weight: 700; font-size: .92rem; }
  .modal-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .modal-actions .btn { justify-content: center; padding: 11px; }
  .alert { padding: 10px 14px; border-radius: 8px; font-size: .85rem; margin-bottom: 16px; display: none; }
  .alert.show { display: block; }
  .alert.err { background: rgba(255,59,92,.15); border: 1px solid rgba(255,59,92,.3); color: #ff6b82; }
  .alert.ok  { background: rgba(0,208,132,.15); border: 1px solid rgba(0,208,132,.3); color: #00d084; }

  /* ── Autosell Modal ───────────────────────────── */
  .as-type-btns { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 16px; }
  .as-type-btn { padding: 10px; border-radius: 8px; border: 2px solid var(--border2); background: var(--bg3); color: var(--text2); font-weight: 600; font-size: .85rem; transition: var(--transition); }
  .as-type-btn.selected.stop { border-color: var(--red); color: var(--red); background: rgba(255,59,92,.1); }
  .as-type-btn.selected.take { border-color: var(--green); color: var(--green); background: rgba(0,208,132,.1); }

  /* ── Login Gate ───────────────────────────────── */
  .login-gate {
    flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 20px; text-align: center; padding: 60px 20px;
  }
  .login-gate .lg-mark { width: 56px; height: 56px; background: var(--green); border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 1.1rem; font-weight: 900; color: #000; margin: 0 auto; }
  .login-gate h1 { font-size: 1.6rem; font-weight: 700; letter-spacing: .02em; }
  .login-gate p { color: var(--text2); max-width: 380px; line-height: 1.6; font-size: .9rem; }
  .login-gate .btn { padding: 12px 28px; font-size: .95rem; }

  /* ── Section Title ────────────────────────────── */
  .sec-title { font-size: 1.1rem; font-weight: 800; margin-bottom: 16px; display: flex; align-items: center; gap: 8px; }
  .sec-title .st-count { font-size: .75rem; padding: 2px 8px; background: var(--card2); border: 1px solid var(--border2); border-radius: 20px; color: var(--text2); font-weight: 400; }

  /* ── Spinner ──────────────────────────────────── */
  .spinner { width: 24px; height: 24px; border: 3px solid var(--border2); border-top-color: var(--green); border-radius: 50%; animation: spin .7s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .loading-wrap { display: flex; justify-content: center; padding: 60px; }

  /* ── Toast ────────────────────────────────────── */
  #toast-area { position: fixed; bottom: 24px; right: 24px; z-index: 9999; display: flex; flex-direction: column; gap: 10px; }
  .toast {
    background: var(--card2); border: 1px solid var(--border2);
    border-radius: 10px; padding: 12px 18px;
    font-size: .88rem; font-weight: 600; min-width: 240px;
    box-shadow: 0 8px 24px rgba(0,0,0,.4);
    animation: toastIn .3s ease; display: flex; align-items: center; gap: 10px;
  }
  .toast.ok  { border-left: 4px solid var(--green); }
  .toast.err { border-left: 4px solid var(--red); }
  .toast.warn { border-left: 4px solid var(--gold); }
  @keyframes toastIn { from { opacity:0; transform: translateY(16px); } to { opacity:1; transform: translateY(0); } }

  /* ── Responsive ───────────────────────────────── */
  @media(max-width: 1024px) {
    .sidebar { width: 180px; }
    .main { padding: 16px; }
    .stocks-grid { grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 12px; }
  }
  @media(max-width: 900px) {
    .sidebar { display: none; }
    .main { padding: 12px; }
    .stocks-grid { grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
    .topbar { padding: 0 12px; }
    .topbar-logo { font-size: 1rem; }
    .topbar-ticker { flex: 1; min-width: 0; }
  }
  @media(max-width: 768px) {
    .stocks-grid { grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); }
    .topbar-actions { gap: 6px; }
    .user-pill { padding: 4px 10px 4px 4px; font-size: .75rem; }
    .user-pill img { width: 24px; height: 24px; }
    .btn-sm { padding: 5px 10px; font-size: .75rem; }
    .modal { max-width: 90vw; padding: 20px; }
    .pf-summary { grid-template-columns: 1fr 1fr; gap: 8px; }
    .pf-table th, .pf-table td { padding: 8px 6px; font-size: .75rem; }
  }
  @media(max-width: 600px) {
    .stocks-grid { grid-template-columns: 1fr; gap: 10px; }
    .topbar { height: 50px; padding: 0 8px; }
    .topbar-ticker { display: none; }
    .topbar-logo { font-size: .9rem; gap: 6px; }
    .topbar-logo .logo-mark { width: 24px; height: 24px; font-size: .65rem; }
    .topbar-actions { gap: 4px; }
    .btn { padding: 6px 12px; font-size: .75rem; }
    .btn-discord, .btn-ghost, .btn-green, .btn-red { padding: 6px 12px; }
    .main { padding: 8px; padding-top: 60px; gap: 12px; }
    .tabs { width: 100%; overflow-x: auto; }
    .tab { padding: 6px 16px; font-size: .8rem; }
    .modal { max-width: 95vw; padding: 16px; }
    .modal-title { font-size: 1rem; }
    .form-input, .form-label { font-size: .85rem; }
    .pf-summary { grid-template-columns: 1fr; gap: 6px; }
    .pf-stat { padding: 10px 12px; }
    .pf-stat-label { font-size: .7rem; }
    .pf-stat-value { font-size: 1.1rem; }
    .pf-table { font-size: .7rem; }
    .pf-table th, .pf-table td { padding: 6px 4px; }
    .sc-header { gap: 6px; }
    .sc-icon { width: 28px; height: 28px; font-size: .6rem; }
    .sc-price { font-size: 1.2rem; }
    .sc-actions { grid-template-columns: 1fr 1fr; gap: 4px; }
    .sc-actions .btn { font-size: .7rem; padding: 6px 8px; }
    .balance-bar { font-size: .75rem; gap: 4px; }
    .sec-title { font-size: .95rem; }
    .spinner { width: 20px; height: 20px; border-width: 2px; }
    .loading-wrap { padding: 40px; }
    .as-card { padding: 12px; }
  }
  @media(max-width: 480px) {
    .stocks-grid { grid-template-columns: 1fr; }
    .topbar { height: 48px; }
    .main { padding: 6px; gap: 8px; }
    .btn { padding: 5px 10px; font-size: .7rem; }
    .modal { max-width: 98vw; padding: 12px; margin: 10px; }
    .form-input { font-size: .8rem; padding: 8px 10px; }
    .pf-table th, .pf-table td { padding: 4px 2px; font-size: .65rem; }
    .sc-price { font-size: 1.1rem; margin: 4px 0 2px; }
    .sc-name { font-size: .85rem; }
    .sec-title { font-size: .9rem; margin-bottom: 12px; }
    .modal-stock-info { padding: 10px; margin-bottom: 12px; }
    .form-summary { padding: 10px; gap: 4px; }
  }

  /* ── No holdings ──────────────────────────────── */
  .empty-state { text-align: center; padding: 60px 20px; color: var(--text3); }
  .empty-state .es-icon { font-size: 1rem; margin-bottom: 12px; text-transform: uppercase; letter-spacing: .1em; font-weight: 700; color: var(--text3); }
  .empty-state p { margin-top: 6px; font-size: .85rem; }

  /* ── Balance bar ──────────────────────────────── */
  .balance-bar {
    display: flex; align-items: center; gap: 8px;
    background: var(--card2); border: 1px solid var(--border2);
    border-radius: 4px; padding: 6px 12px;
    font-size: .85rem; font-weight: 700;
  }
  .balance-bar .bb-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--gold); display: inline-block; }
</style>
</head>
<body>

<!-- ═══ TOPBAR ══════════════════════════════════════════════════ -->
<header class="topbar">
  <div class="topbar-logo">
    <div class="logo-mark">BT</div>
    <div>
      <div>BitTrade</div>
      <div class="logo-sub">منصة التداول</div>
    </div>
  </div>
  <div class="topbar-ticker">
    <div class="ticker-inner" id="tickerInner">
      ${Object.entries(ALL_DEFS).map(([sym, d]) =>
        `<span class="ticker-item">
          <span class="ticker-sym">${sym}</span>
          <span class="ticker-price" id="tick-price-${sym}">—</span>
          <span class="ticker-chg" id="tick-chg-${sym}">—</span>
        </span>`
      ).join('')}
      ${Object.entries(ALL_DEFS).map(([sym, d]) =>
        `<span class="ticker-item">
          <span class="ticker-sym">${sym}</span>
          <span class="ticker-price" id="tick-price2-${sym}">—</span>
          <span class="ticker-chg" id="tick-chg2-${sym}">—</span>
        </span>`
      ).join('')}
    </div>
  </div>
  <div class="topbar-actions">
    ${isLoggedIn
      ? `<div class="balance-bar"><span class="bb-dot"></span><span id="topBalanceVal">…</span> كوين</div>
         <div class="user-pill">
           <img src="${avatar}" alt="" onerror="this.src='https://cdn.discordapp.com/embed/avatars/0.png'">
           <span>${username}</span>
         </div>
         <a href="/auth/logout" class="btn btn-ghost btn-sm">خروج</a>`
      : `<a href="/auth/discord" class="btn btn-discord">
           <svg width="16" height="16" viewBox="0 0 24 24" fill="white"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057.1 18.08.11 18.1.12 18.116a19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z"/></svg>
           تسجيل الدخول
         </a>`
    }
    <a href="/" class="btn btn-back">← الرئيسية</a>
  </div>
</header>

<!-- ═══ LAYOUT ══════════════════════════════════════════════════ -->
<div class="layout">
  <!-- Sidebar -->
  <nav class="sidebar">
    <div class="sidebar-label">التداول</div>
    <a href="#" onclick="switchTab('market');return false" class="active" id="sb-market">السوق</a>
    <a href="#" onclick="switchTab('portfolio');return false" id="sb-portfolio">محفظتي</a>
    <a href="#" onclick="switchTab('autosell');return false" id="sb-autosell">بيع تلقائي</a>
    <a href="#" onclick="switchTab('history');return false" id="sb-history">السجل</a>
    <div class="sidebar-label">الأسهم</div>
    ${Object.entries(ALL_DEFS).map(([sym, d]) =>
      `<a href="#" onclick="openBuyModal('${sym}');return false">${sym}</a>`
    ).join('')}
    <div class="sidebar-label">الموقع</div>
    <a href="/">الرئيسية</a>
    <a href="/market">السوق</a>
    <a href="/leaderboard">المتصدرون</a>
  </nav>

  <!-- Main Content -->
  <main class="main">

    <!-- Crash Alert -->
    <div class="crash-alert" id="crashAlert">
      <div>
        <div id="crashAlertText">تحذير: انهيار وشيك!</div>
        <div id="crashAlertSub" style="font-size:.82rem;font-weight:400;margin-top:2px;opacity:.8"></div>
      </div>
      <div id="crashCountdown" style="font-size:1rem;font-weight:700"></div>
    </div>

    <!-- Market Status Banner -->
    <div class="market-banner neutral" id="marketBanner">
      <div class="market-status">
        <span class="pulse green" id="marketPulse"></span>
        <span id="marketStatusText">جاري تحميل السوق...</span>
      </div>
      <div class="market-info" id="marketInfo"></div>
    </div>

    ${!isLoggedIn ? `
    <!-- Login Gate -->
    <div class="login-gate">
      <div class="lg-mark">BT</div>
      <h1>BitTrade</h1>
      <p>سجّل دخولك عبر Discord للوصول إلى منصة التداول وابدأ في شراء وبيع الأسهم.</p>
      <a href="/auth/discord" class="btn btn-discord">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="white"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057.1 18.08.11 18.1.12 18.116a19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z"/></svg>
        تسجيل الدخول بـ Discord
      </a>
    </div>
    ` : `
    <!-- Tabs -->
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px">
      <div class="tabs">
        <button class="tab active" onclick="switchTab('market')" id="tab-market">السوق</button>
        <button class="tab" onclick="switchTab('portfolio')" id="tab-portfolio">محفظتي</button>
        <button class="tab" onclick="switchTab('autosell')" id="tab-autosell">بيع تلقائي</button>
        <button class="tab" onclick="switchTab('history')" id="tab-history">السجل</button>
      </div>
    </div>

    <!-- ─── TAB: Market ─────────────────────────── -->
    <div class="tab-panel active" id="panel-market">
      <div class="sec-title">أسهم حقيقية <span class="st-count">${Object.keys(REAL_STOCKS).length}</span></div>
      <div class="stocks-grid" id="realGrid">
        <div class="loading-wrap"><div class="spinner"></div></div>
      </div>
      <div class="sec-title" style="margin-top:24px">أسهم الكازينو <span class="st-count">${Object.keys(CASINO_STOCKS).length}</span></div>
      <div class="stocks-grid" id="casinoGrid">
        <div class="loading-wrap"><div class="spinner"></div></div>
      </div>
    </div>

    <!-- ─── TAB: Portfolio ──────────────────────── -->
    <div class="tab-panel" id="panel-portfolio">
      <div class="portfolio-header">
        <div class="sec-title">محفظتي الاستثمارية</div>
        <button class="btn btn-ghost btn-sm" onclick="loadPortfolio()">تحديث</button>
      </div>
      <div id="pfSummary" class="pf-summary"></div>
      <div id="pfContent"><div class="loading-wrap"><div class="spinner"></div></div></div>
    </div>

    <!-- ─── TAB: Auto-Sell ──────────────────────── -->
    <div class="tab-panel" id="panel-autosell">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:20px">
        <div class="sec-title">أوامر البيع التلقائي</div>
        <button class="btn btn-gold btn-sm" onclick="openAutoSellModal()">+ إضافة أمر</button>
      </div>
      <div id="asContent"><div class="loading-wrap"><div class="spinner"></div></div></div>
    </div>

    <!-- ─── TAB: History ────────────────────────── -->
    <div class="tab-panel" id="panel-history">
      <div class="sec-title">سجل التداول</div>
      <div id="historyContent">
        <div class="history-empty">
          <div>سيظهر سجل صفقاتك هنا قريباً</div>
          <div style="font-size:.8rem;color:var(--text3);margin-top:6px">كل عملية شراء وبيع تُسجَّل هنا تلقائياً</div>
        </div>
      </div>
    </div>
    `}

  </main>
</div>

<!-- ═══ MODALS ═══════════════════════════════════════════════════ -->
${isLoggedIn ? `
<!-- Buy Modal -->
<div class="modal-bg" id="buyModal">
  <div class="modal">
    <button class="modal-close" onclick="closeModal('buyModal')">✕</button>
    <div class="modal-title" id="buyModalTitle">شراء أسهم</div>
    <div class="modal-stock-info" id="buyModalInfo"></div>
    <div class="alert err" id="buyAlert"></div>
    <div class="alert ok" id="buyAlertOk"></div>
    <div class="form-group">
      <label class="form-label">الكمية</label>
      <input type="number" class="form-input" id="buyAmount" min="1" max="10000" placeholder="أدخل الكمية">
    </div>
    <div class="form-summary" id="buySummary">
      <div class="fs-row"><span>سعر السهم الواحد</span><span id="bs-price">—</span></div>
      <div class="fs-row"><span>الكمية</span><span id="bs-qty">—</span></div>
      <div class="fs-row fs-total"><span>التكلفة الإجمالية</span><span id="bs-total" style="color:var(--gold)">—</span></div>
      <div class="fs-row"><span>رصيدك بعد الشراء</span><span id="bs-after">—</span></div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="closeModal('buyModal')">إلغاء</button>
      <button class="btn btn-green" id="buyConfirmBtn" onclick="confirmBuy()">تأكيد الشراء</button>
    </div>
  </div>
</div>

<!-- Sell Modal -->
<div class="modal-bg" id="sellModal">
  <div class="modal">
    <button class="modal-close" onclick="closeModal('sellModal')">✕</button>
    <div class="modal-title" id="sellModalTitle">بيع أسهم</div>
    <div class="modal-stock-info" id="sellModalInfo"></div>
    <div class="alert err" id="sellAlert"></div>
    <div class="alert ok" id="sellAlertOk"></div>
    <div class="form-group">
      <label class="form-label">الكمية (لديك: <span id="sellMaxShares">0</span> سهم)</label>
      <input type="number" class="form-input" id="sellAmount" min="1" placeholder="أدخل الكمية">
      <div style="display:flex;gap:6px;margin-top:8px">
        <button class="btn btn-ghost btn-sm" onclick="setSellPct(25)">25%</button>
        <button class="btn btn-ghost btn-sm" onclick="setSellPct(50)">50%</button>
        <button class="btn btn-ghost btn-sm" onclick="setSellPct(75)">75%</button>
        <button class="btn btn-ghost btn-sm" onclick="setSellPct(100)">كل شيء</button>
      </div>
    </div>
    <div class="form-summary" id="sellSummary">
      <div class="fs-row"><span>سعر البيع الحالي</span><span id="ss-price">—</span></div>
      <div class="fs-row"><span>متوسط سعر الشراء</span><span id="ss-avg">—</span></div>
      <div class="fs-row"><span>الكمية</span><span id="ss-qty">—</span></div>
      <div class="fs-row"><span>الإيراد الإجمالي</span><span id="ss-gross">—</span></div>
      <div class="fs-row"><span>الضريبة (${Math.round(getTaxRate()*100)}% على الربح)</span><span id="ss-tax" style="color:var(--red)">—</span></div>
      <div class="fs-row fs-total"><span>الصافي المستلم</span><span id="ss-net" style="color:var(--gold)">—</span></div>
      <div class="fs-row"><span id="ss-pnl-label">الربح/الخسارة</span><span id="ss-pnl">—</span></div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="closeModal('sellModal')">إلغاء</button>
      <button class="btn btn-red" id="sellConfirmBtn" onclick="confirmSell()">تأكيد البيع</button>
    </div>
  </div>
</div>

<!-- Auto-Sell Modal -->
<div class="modal-bg" id="autoSellModal">
  <div class="modal">
    <button class="modal-close" onclick="closeModal('autoSellModal')">✕</button>
    <div class="modal-title">إضافة أمر بيع تلقائي</div>
    <div class="alert err" id="asAlert"></div>
    <div class="form-group">
      <label class="form-label">اختر السهم</label>
      <select class="form-input" id="asSymbol">
        ${Object.entries(ALL_DEFS).map(([sym, d]) => `<option value="${sym}">${sym} — ${d.nameAr}</option>`).join('')}
      </select>
    </div>
    <div class="as-type-btns">
      <button class="as-type-btn stop selected" id="asTypeStop" onclick="selectAsType('stop')">وقف الخسارة<br><small>بيع إذا انخفض السعر لـ</small></button>
      <button class="as-type-btn take" id="asTypeTake" onclick="selectAsType('take')">جني الأرباح<br><small>بيع إذا ارتفع السعر لـ</small></button>
    </div>
    <div class="form-group">
      <label class="form-label">السعر المستهدف (كوين)</label>
      <input type="number" class="form-input" id="asPrice" min="1" placeholder="أدخل السعر بالكوين">
    </div>
    <div id="asCurrentPrice" style="font-size:.82rem;color:var(--text2);margin-bottom:16px"></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="closeModal('autoSellModal')">إلغاء</button>
      <button class="btn btn-gold" onclick="confirmAutoSell()">تفعيل الأمر</button>
    </div>
  </div>
</div>
` : ''}

<!-- Toast Area -->
<div id="toast-area"></div>

<script>
/* ═══════════════════════════════════════════════════════════
   BitTrade — Client JS
═══════════════════════════════════════════════════════════ */
const LOGGED_IN = ${isLoggedIn ? 'true' : 'false'};
const USER_ID   = ${isLoggedIn ? `"${user.id}"` : 'null'};
const TAX_RATE  = ${getTaxRate()};

const ALL_DEFS = ${JSON.stringify(ALL_DEFS)};

let priceData  = {};
let portfolio  = null;
let balance    = 0;
let csrfToken  = null;
let asType     = 'stop';
let chartHistories = {};  // sym -> price[]

/* ── Price History for Mini Charts ─────────────── */
function pushHistory(sym, price) {
  if (!chartHistories[sym]) chartHistories[sym] = [];
  chartHistories[sym].push(price);
  if (chartHistories[sym].length > 30) chartHistories[sym].shift();
}

/* ── Mini sparkline on canvas ───────────────────── */
function drawSparkline(canvas, prices, color) {
  if (!canvas || !prices || prices.length < 2) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.offsetWidth || 200;
  const H = canvas.offsetHeight || 50;
  canvas.width  = W * window.devicePixelRatio;
  canvas.height = H * window.devicePixelRatio;
  ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
  ctx.clearRect(0, 0, W, H);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;
  const step = W / (prices.length - 1);
  const points = prices.map((p, i) => [i * step, H - ((p - min) / range) * (H - 6) - 3]);
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, color + '55');
  grad.addColorStop(1, color + '00');
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) {
    const mx = (points[i-1][0] + points[i][0]) / 2;
    ctx.bezierCurveTo(mx, points[i-1][1], mx, points[i][1], points[i][0], points[i][1]);
  }
  ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) {
    const mx = (points[i-1][0] + points[i][0]) / 2;
    ctx.bezierCurveTo(mx, points[i-1][1], mx, points[i][1], points[i][0], points[i][1]);
  }
  ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
}

/* ── Tabs ───────────────────────────────────────── */
function switchTab(name) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.sidebar a').forEach(a => a.classList.remove('active'));
  const panel = document.getElementById('panel-' + name);
  const tab   = document.getElementById('tab-' + name);
  const sb    = document.getElementById('sb-' + name);
  if (panel) panel.classList.add('active');
  if (tab)   tab.classList.add('active');
  if (sb)    sb.classList.add('active');
  if (name === 'portfolio') loadPortfolio();
  if (name === 'autosell')  loadAutoSell();
}

/* ── Number formatting ──────────────────────────── */
function fmtN(n) { return Math.round(Number(n)).toLocaleString('en-US'); }
function sign(n) { return parseFloat(n) >= 0 ? '+' : ''; }

/* ── Toast ──────────────────────────────────────── */
function toast(msg, type = 'ok') {
  const area = document.getElementById('toast-area');
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.innerHTML = msg;
  area.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

/* ── CSRF ───────────────────────────────────────── */
async function getCSRF() {
  if (csrfToken) return csrfToken;
  const r = await fetch('/api/csrf-token');
  if (!r.ok) return null;
  const d = await r.json();
  csrfToken = d.token;
  return csrfToken;
}

/* ── Fetch Prices ───────────────────────────────── */
async function fetchPrices() {
  try {
    const r = await fetch('/api/trade/prices');
    if (!r.ok) return;
    const data = await r.json();
    priceData = data.prices || {};
    if (LOGGED_IN) balance = data.balance || 0;
    updateTicker();
    updateMarketBanner();
    if (LOGGED_IN) {
      document.getElementById('topBalanceVal').textContent = fmtN(balance);
      if (document.getElementById('panel-market').classList.contains('active')) {
        renderMarket();
      }
    }
  } catch (e) { console.error('fetchPrices:', e); }
}

/* ── Ticker bar ─────────────────────────────────── */
function updateTicker() {
  for (const [sym, d] of Object.entries(ALL_DEFS)) {
    const p = priceData[sym];
    if (!p) continue;
    const isUp = parseFloat(p.change) >= 0;
    const chgStr = (isUp?'+':'') + p.change + '%';
    for (const sfx of ['', '2']) {
      const pe = document.getElementById('tick-price'+sfx+'-'+sym);
      const ce = document.getElementById('tick-chg'+sfx+'-'+sym);
      if (pe) pe.textContent = fmtN(p.price) + ' كوين';
      if (ce) { ce.textContent = chgStr; ce.className = 'ticker-chg ' + (isUp?'up':'dn'); }
    }
    pushHistory(sym, p.price);
  }
}

/* ── Market Banner ──────────────────────────────── */
function updateMarketBanner() {
  const prices = Object.values(priceData);
  if (!prices.length) return;
  const ups   = prices.filter(p => parseFloat(p.change) > 0).length;
  const downs = prices.filter(p => parseFloat(p.change) < 0).length;
  const total = prices.length;
  const bullPct = Math.round(ups / total * 100);
  const banner = document.getElementById('marketBanner');
  const status = document.getElementById('marketStatusText');
  const pulse  = document.getElementById('marketPulse');
  const info   = document.getElementById('marketInfo');

  if (bullPct >= 60) {
    banner.className = 'market-banner bull';
    status.textContent = 'BULL — سوق صاعد';
    pulse.className = 'pulse green';
  } else if (bullPct <= 40) {
    banner.className = 'market-banner bear';
    status.textContent = 'BEAR — سوق هابط';
    pulse.className = 'pulse red';
  } else {
    banner.className = 'market-banner neutral';
    status.textContent = 'NEUTRAL — السوق متعادل';
    pulse.className = 'pulse green';
  }

  info.innerHTML = [
    \`<div class="stat">صاعد: <span>\${ups}/\${total}</span></div>\`,
    \`<div class="stat">هابط: <span>\${downs}/\${total}</span></div>\`,
    \`<div class="stat">نسبة الصعود: <span>\${bullPct}%</span></div>\`,
  ].join('');
}

/* ── Render Market ──────────────────────────────── */
function renderMarket() {
  const realGrid   = document.getElementById('realGrid');
  const casinoGrid = document.getElementById('casinoGrid');
  if (!realGrid) return;

  const realSym   = ['AAPL','TSLA','NVDA','AMZN','GOOGL','BTC-USD'];
  const casinoSym = ['CHAIN','BLOOD','DIAMOND','REZERO'];

  function cardHtml(sym) {
    const def  = ALL_DEFS[sym];
    const p    = priceData[sym];
    if (!p) return '';
    const isUp = parseFloat(p.change) >= 0;
    const chg  = (isUp?'+':'') + p.change + '%';
    const symShort = sym.replace('-USD','').slice(0,4);
    return \`
    <div class="stock-card \${isUp?'up':'dn'}" id="card-\${sym}" style="--accent-color:\${def.color}">
      <div class="sc-header">
        <div class="sc-sym">
          <div class="sc-icon" style="background:\${def.color}">\${symShort}</div>
          <div>
            <div class="sc-name">\${sym}</div>
            <div class="sc-name-ar">\${def.nameAr}</div>
          </div>
        </div>
        <span class="sc-badge \${def.type}">\${def.type==='real'?'LIVE':'SIM'}</span>
      </div>
      <div class="sc-price">\${fmtN(p.price)} <span class="coin-label">كوين</span></div>
      \${p.usdPrice ? \`<div class="sc-usd">≈ $\${p.usdPrice}</div>\` : ''}
      <div class="sc-change \${isUp?'up':'dn'}">\${isUp?'▲':'▼'} \${chg}</div>
      <div class="sc-mini-chart">
        <canvas id="chart-\${sym}"></canvas>
      </div>
      <div class="sc-actions">
        <button class="btn btn-green btn-sm" onclick="openBuyModal('\${sym}')">شراء</button>
        <button class="btn btn-red btn-sm" onclick="openSellModal('\${sym}')">بيع</button>
      </div>
    </div>
    \`;
  }

  realGrid.innerHTML   = realSym.map(cardHtml).join('') || '<div style="color:var(--text3);padding:20px">لا توجد بيانات</div>';
  casinoGrid.innerHTML = casinoSym.map(cardHtml).join('') || '<div style="color:var(--text3);padding:20px">لا توجد بيانات</div>';

  // Draw sparklines after DOM update
  requestAnimationFrame(() => {
    for (const sym of [...realSym, ...casinoSym]) {
      const canvas = document.getElementById('chart-' + sym);
      const hist   = chartHistories[sym] || [];
      if (canvas && hist.length >= 2) {
        const def  = ALL_DEFS[sym];
        const p    = priceData[sym];
        const isUp = p && parseFloat(p.change) >= 0;
        drawSparkline(canvas, hist, isUp ? '#00d084' : '#ff3b5c');
      }
    }
  });
}

/* ── Portfolio ──────────────────────────────────── */
async function loadPortfolio() {
  const content = document.getElementById('pfContent');
  const summary = document.getElementById('pfSummary');
  if (!content) return;
  content.innerHTML = '<div class="loading-wrap"><div class="spinner"></div></div>';
  try {
    const r = await fetch('/api/trade/portfolio');
    if (!r.ok) throw new Error();
    const d = await r.json();
    portfolio = d;

    // Summary stats
    const isUp = (d.totalPnl || 0) >= 0;
    summary.innerHTML = \`
      <div class="pf-stat"><div class="pf-stat-label">القيمة الحالية</div><div class="pf-stat-value">\${fmtN(d.totalValue)} كوين</div></div>
      <div class="pf-stat"><div class="pf-stat-label">\${isUp?'الربح الكلي':'الخسارة الكلية'}</div><div class="pf-stat-value \${isUp?'up':'dn'}">\${sign(d.totalPnl)}\${fmtN(d.totalPnl)} كوين</div></div>
      <div class="pf-stat"><div class="pf-stat-label">أرباح محققة</div><div class="pf-stat-value up">\${fmtN(d.realizedProfit)} كوين</div></div>
      <div class="pf-stat"><div class="pf-stat-label">إجمالي الصفقات</div><div class="pf-stat-value">\${d.totalTrades}</div></div>
      <div class="pf-stat"><div class="pf-stat-label">رصيدي</div><div class="pf-stat-value" style="color:var(--gold)">\${fmtN(d.balance)} كوين</div></div>
    \`;

    if (!d.holdings || !d.holdings.length) {
      content.innerHTML = \`<div class="empty-state"><div class="es-icon">NO HOLDINGS</div><div>لا تمتلك أي أسهم حالياً</div><p>اذهب إلى السوق وابدأ بالشراء!</p></div>\`;
      return;
    }

    let rows = '';
    for (const h of d.holdings) {
      const def  = ALL_DEFS[h.symbol] || { nameAr: h.symbol, color: '#888' };
      const p    = priceData[h.symbol];
      const cur  = p?.price || h.avgBuyPrice;
      const val  = cur * h.shares;
      const cost = h.avgBuyPrice * h.shares;
      const pnl  = val - cost;
      const pnlPct = cost > 0 ? ((pnl / cost) * 100).toFixed(2) : '0.00';
      const isUp = pnl >= 0;
      const symShort2 = h.symbol.replace('-USD','').slice(0,4);
      rows += \`
        <tr>
          <td><div class="holding-sym"><div class="sc-icon" style="background:\${def.color};width:28px;height:28px;font-size:.6rem">\${symShort2}</div><div><div style="font-weight:700">\${h.symbol}</div><div style="font-size:.75rem;color:var(--text2)">\${def.nameAr}</div></div></div></td>
          <td>\${fmtN(h.shares)} سهم</td>
          <td>\${fmtN(h.avgBuyPrice)} كوين</td>
          <td>\${fmtN(cur)} كوين</td>
          <td class="pnl \${isUp?'up':'dn'}">\${sign(pnl)}\${fmtN(pnl)} كوين<br><small>\${sign(pnlPct)}\${pnlPct}%</small></td>
          <td>
            <button class="btn btn-red btn-sm" onclick="openSellModal('\${h.symbol}')">بيع</button>
          </td>
        </tr>
      \`;
    }

    content.innerHTML = \`
      <div style="overflow-x:auto">
        <table class="pf-table">
          <thead>
            <tr>
              <th>السهم</th>
              <th>الكمية</th>
              <th>متوسط الشراء</th>
              <th>السعر الحالي</th>
              <th>الربح/الخسارة</th>
              <th>إجراء</th>
            </tr>
          </thead>
          <tbody>\${rows}</tbody>
        </table>
      </div>
    \`;
  } catch(e) {
    content.innerHTML = '<div class="empty-state"><div class="es-icon">ERROR</div><div>فشل تحميل المحفظة</div></div>';
  }
}

/* ── Auto-Sell ──────────────────────────────────── */
async function loadAutoSell() {
  const content = document.getElementById('asContent');
  if (!content) return;
  content.innerHTML = '<div class="loading-wrap"><div class="spinner"></div></div>';
  try {
    const r = await fetch('/api/trade/autosell');
    if (!r.ok) throw new Error();
    const d = await r.json();
    const orders = d.orders || [];
    if (!orders.length) {
      content.innerHTML = \`<div class="empty-state"><div class="es-icon">NO ORDERS</div><div>لا توجد أوامر بيع تلقائي نشطة</div><p>أضف أوامر وقف الخسارة وجني الأرباح لحماية استثماراتك</p></div>\`;
      return;
    }
    let html = '<div class="autosell-grid">';
    for (const o of orders) {
      const def = ALL_DEFS[o.symbol] || { nameAr: o.symbol, color: '#888' };
      const cur = priceData[o.symbol]?.price;
      const diff = cur ? (o.price - cur) : null;
      const symShort3 = o.symbol.replace('-USD','').slice(0,4);
      html += \`
        <div class="as-card">
          <div class="as-header">
            <div style="display:flex;align-items:center;gap:8px;font-size:.95rem;font-weight:700"><div class="sc-icon" style="background:\${def.color};width:28px;height:28px;font-size:.6rem">\${symShort3}</div>\${o.symbol}</div>
            <span class="as-type \${o.type}">\${o.type==='stop'?'STOP':'TAKE'}</span>
          </div>
          <div class="as-sym">\${def.nameAr}</div>
          <div class="as-price" style="margin:10px 0">\${fmtN(o.price)} كوين</div>
          \${cur ? \`<div style="font-size:.8rem;color:var(--text2)">السعر الحالي: \${fmtN(cur)} كوين (\${diff>=0?'يحتاج':''} \${fmtN(Math.abs(diff))} كوين \${diff>=0?'ارتفاع':'انخفاض'})</div>\` : ''}
          <button class="btn btn-ghost btn-sm" style="margin-top:12px;width:100%" onclick="cancelAutoSell('\${o.symbol}','\${o.type}')">إلغاء</button>
        </div>
      \`;
    }
    html += '</div>';
    content.innerHTML = html;
  } catch(e) {
    content.innerHTML = '<div class="empty-state"><div class="es-icon">ERROR</div><div>فشل التحميل</div></div>';
  }
}

/* ── Buy Modal ──────────────────────────────────── */
let currentBuySym = null;
function openBuyModal(sym) {
  if (!LOGGED_IN) { window.location.href='/auth/discord'; return; }
  currentBuySym = sym;
  const def = ALL_DEFS[sym];
  const p   = priceData[sym];
  if (!p) { toast('السعر غير متاح حالياً', 'warn'); return; }

  document.getElementById('buyModalTitle').textContent = 'شراء ' + def.nameAr;
  const bsym = sym.replace('-USD','').slice(0,4);
  document.getElementById('buyModalInfo').innerHTML = \`
    <div class="ms-icon" style="background:\${def.color}">\${bsym}</div>
    <div>
      <div class="ms-name">\${sym} — \${def.nameAr}</div>
      <div class="ms-price">السعر الحالي: \${fmtN(p.price)} كوين\${p.usdPrice ? ' ≈ $'+p.usdPrice : ''}</div>
    </div>
  \`;
  document.getElementById('buyAmount').value = '';
  document.getElementById('buyAlert').classList.remove('show');
  document.getElementById('buyAlertOk').classList.remove('show');
  updateBuySummary();
  openModal('buyModal');
}

function updateBuySummary() {
  const sym = currentBuySym;
  if (!sym) return;
  const p    = priceData[sym];
  const qty  = parseInt(document.getElementById('buyAmount')?.value) || 0;
  const total = p ? p.price * qty : 0;
  document.getElementById('bs-price').textContent = p ? fmtN(p.price) + ' كوين' : '—';
  document.getElementById('bs-qty').textContent   = qty > 0 ? fmtN(qty) + ' سهم' : '—';
  document.getElementById('bs-total').textContent = total > 0 ? fmtN(total) + ' كوين' : '—';
  document.getElementById('bs-after').textContent = (total > 0 && balance > 0) ? fmtN(balance - total) + ' كوين' : '—';
}

async function confirmBuy() {
  const qty  = parseInt(document.getElementById('buyAmount').value);
  const sym  = currentBuySym;
  const errEl = document.getElementById('buyAlert');
  const okEl  = document.getElementById('buyAlertOk');
  errEl.classList.remove('show'); okEl.classList.remove('show');

  if (!qty || qty < 1) { errEl.textContent = 'أدخل كمية صحيحة'; errEl.classList.add('show'); return; }
  if (qty > 10000) { errEl.textContent = 'الحد الأقصى 10,000 سهم'; errEl.classList.add('show'); return; }

  const btn = document.getElementById('buyConfirmBtn');
  btn.disabled = true; btn.textContent = 'جاري الشراء...';

  const csrf = await getCSRF();
  try {
    const r = await fetch('/api/trade/buy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({ symbol: sym, amount: qty }),
    });
    const d = await r.json();
    csrfToken = null;
    if (!r.ok) { errEl.textContent = d.error || 'فشل الشراء'; errEl.classList.add('show'); }
    else {
      balance = d.newBalance;
      document.getElementById('topBalanceVal').textContent = fmtN(balance);
      okEl.textContent = \`تم شراء \${fmtN(qty)} سهم بنجاح! رصيدك الجديد: \${fmtN(balance)} كوين\`;
      okEl.classList.add('show');
      toast(\`تم شراء \${fmtN(qty)} سهم من \${sym}\`, 'ok');
      setTimeout(() => closeModal('buyModal'), 2000);
    }
  } catch(e) {
    errEl.textContent = 'خطأ في الاتصال'; errEl.classList.add('show');
  }
  btn.disabled = false; btn.textContent = 'تأكيد الشراء';
}

/* ── Sell Modal ─────────────────────────────────── */
let currentSellSym = null;
let currentSellAvg = 0;
let currentSellMax = 0;

function openSellModal(sym) {
  if (!LOGGED_IN) { window.location.href='/auth/discord'; return; }
  currentSellSym = sym;
  const def = ALL_DEFS[sym];
  const p   = priceData[sym];

  // Get current holding from portfolio
  const holding = portfolio?.holdings?.find(h => h.symbol === sym);
  currentSellAvg = holding?.avgBuyPrice || 0;
  currentSellMax = holding?.shares || 0;

  document.getElementById('sellModalTitle').textContent = 'بيع ' + def.nameAr;
  const ssym = sym.replace('-USD','').slice(0,4);
  document.getElementById('sellModalInfo').innerHTML = \`
    <div class="ms-icon" style="background:\${def.color}">\${ssym}</div>
    <div>
      <div class="ms-name">\${sym} — \${def.nameAr}</div>
      <div class="ms-price">السعر الحالي: \${p ? fmtN(p.price) + ' كوين' : '—'}</div>
    </div>
  \`;
  document.getElementById('sellMaxShares').textContent = fmtN(currentSellMax);
  document.getElementById('sellAmount').value = '';
  document.getElementById('sellAlert').classList.remove('show');
  document.getElementById('sellAlertOk').classList.remove('show');
  updateSellSummary();
  openModal('sellModal');
}

function setSellPct(pct) {
  const qty = Math.floor(currentSellMax * pct / 100);
  document.getElementById('sellAmount').value = qty > 0 ? qty : 1;
  updateSellSummary();
}

function updateSellSummary() {
  const sym  = currentSellSym;
  if (!sym) return;
  const p    = priceData[sym];
  const qty  = parseInt(document.getElementById('sellAmount')?.value) || 0;
  if (!p || qty <= 0) return;
  const gross  = p.price * qty;
  const cost   = currentSellAvg * qty;
  const profit = gross - cost;
  const tax    = profit > 0 ? Math.floor(profit * TAX_RATE) : 0;
  const net    = gross - tax;
  const isUp   = profit >= 0;
  document.getElementById('ss-price').textContent  = fmtN(p.price) + ' كوين';
  document.getElementById('ss-avg').textContent    = fmtN(currentSellAvg) + ' كوين';
  document.getElementById('ss-qty').textContent    = fmtN(qty) + ' سهم';
  document.getElementById('ss-gross').textContent  = fmtN(gross) + ' كوين';
  document.getElementById('ss-tax').textContent    = '-' + fmtN(tax) + ' كوين';
  document.getElementById('ss-net').textContent    = fmtN(net) + ' كوين';
  const pnlLabel = document.getElementById('ss-pnl-label');
  const pnlVal   = document.getElementById('ss-pnl');
  pnlLabel.textContent = isUp ? 'الربح الصافي' : 'الخسارة';
  pnlVal.textContent   = (isUp?'+':'') + fmtN(profit - tax) + ' كوين';
  pnlVal.style.color   = isUp ? 'var(--green)' : 'var(--red)';
}

async function confirmSell() {
  const qty  = parseInt(document.getElementById('sellAmount').value);
  const sym  = currentSellSym;
  const errEl = document.getElementById('sellAlert');
  const okEl  = document.getElementById('sellAlertOk');
  errEl.classList.remove('show'); okEl.classList.remove('show');

  if (!qty || qty < 1) { errEl.textContent = 'أدخل كمية صحيحة'; errEl.classList.add('show'); return; }

  const btn = document.getElementById('sellConfirmBtn');
  btn.disabled = true; btn.textContent = 'جاري البيع...';

  const csrf = await getCSRF();
  try {
    const r = await fetch('/api/trade/sell', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({ symbol: sym, amount: qty }),
    });
    const d = await r.json();
    csrfToken = null;
    if (!r.ok) { errEl.textContent = d.error || 'فشل البيع'; errEl.classList.add('show'); }
    else {
      balance = d.newBalance;
      document.getElementById('topBalanceVal').textContent = fmtN(balance);
      okEl.textContent = \`تم بيع \${fmtN(qty)} سهم! رصيدك: \${fmtN(balance)} كوين\`;
      okEl.classList.add('show');
      toast(\`تم بيع \${fmtN(qty)} سهم من \${sym}\`, 'ok');
      setTimeout(() => closeModal('sellModal'), 2000);
    }
  } catch(e) {
    errEl.textContent = 'خطأ في الاتصال'; errEl.classList.add('show');
  }
  btn.disabled = false; btn.textContent = 'تأكيد البيع';
}

/* ── Auto-Sell Modal ────────────────────────────── */
function selectAsType(type) {
  asType = type;
  document.getElementById('asTypeStop').classList.toggle('selected', type==='stop');
  document.getElementById('asTypeStop').classList.toggle('stop', type==='stop');
  document.getElementById('asTypeTake').classList.toggle('selected', type==='take');
  document.getElementById('asTypeTake').classList.toggle('take', type==='take');
  updateAsCurrentPrice();
}

function updateAsCurrentPrice() {
  const sym = document.getElementById('asSymbol')?.value;
  const p   = priceData[sym];
  const el  = document.getElementById('asCurrentPrice');
  if (!el) return;
  el.textContent = p ? \`السعر الحالي: \${fmtN(p.price)} كوين\` : '';
}

function openAutoSellModal(sym) {
  if (sym) document.getElementById('asSymbol').value = sym;
  document.getElementById('asPrice').value = '';
  document.getElementById('asAlert').classList.remove('show');
  selectAsType('stop');
  updateAsCurrentPrice();
  openModal('autoSellModal');
}

async function confirmAutoSell() {
  const sym   = document.getElementById('asSymbol').value;
  const price = parseInt(document.getElementById('asPrice').value);
  const errEl = document.getElementById('asAlert');
  errEl.classList.remove('show');

  if (!sym)  { errEl.textContent = 'اختر سهماً'; errEl.classList.add('show'); return; }
  if (!price || price < 1) { errEl.textContent = 'أدخل سعراً صحيحاً'; errEl.classList.add('show'); return; }

  const csrf = await getCSRF();
  try {
    const r = await fetch('/api/trade/autosell', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({ symbol: sym, type: asType, price }),
    });
    const d = await r.json();
    csrfToken = null;
    if (!r.ok) { errEl.textContent = d.error || 'فشل الإضافة'; errEl.classList.add('show'); return; }
    toast(\`تم إضافة أمر \${asType==='stop'?'وقف الخسارة':'جني الأرباح'} لـ \${sym}\`, 'ok');
    closeModal('autoSellModal');
    loadAutoSell();
  } catch(e) {
    errEl.textContent = 'خطأ في الاتصال'; errEl.classList.add('show');
  }
}

async function cancelAutoSell(sym, type) {
  if (!confirm(\`هل تريد إلغاء أمر \${type==='stop'?'وقف الخسارة':'جني الأرباح'} لـ \${sym}؟\`)) return;
  const csrf = await getCSRF();
  await fetch(\`/api/trade/autosell/\${sym}?type=\${type}\`, { method:'DELETE', headers:{'X-CSRF-Token':csrf} });
  csrfToken = null;
  toast(\`تم إلغاء الأمر لـ \${sym}\`, 'warn');
  loadAutoSell();
}

/* ── Modal helpers ──────────────────────────────── */
function openModal(id) { document.getElementById(id)?.classList.add('open'); }
function closeModal(id) { document.getElementById(id)?.classList.remove('open'); }
document.addEventListener('click', e => {
  if (e.target.classList.contains('modal-bg')) closeModal(e.target.id);
});

/* ── SSE (real-time events) ─────────────────────── */
if (LOGGED_IN) {
  const es = new EventSource('/api/trade/events');
  es.onmessage = e => {
    try {
      const d = JSON.parse(e.data);
      if (d.type === 'price_update') {
        priceData = d.prices;
        updateTicker();
        updateMarketBanner();
        if (document.getElementById('panel-market').classList.contains('active')) renderMarket();
      }
      if (d.type === 'crash_warning') {
        const el = document.getElementById('crashAlert');
        document.getElementById('crashAlertText').textContent = \`تحذير: انهيار وشيك في \${d.symbol}!\`;
        document.getElementById('crashAlertSub').textContent  = \`انخفاض متوقع ~40% — اتخذ قرارك قبل: \${d.crashAt}\`;
        el.classList.add('show');
      }
      if (d.type === 'crash') {
        document.getElementById('crashAlert').classList.remove('show');
        toast(\`انهار سهم \${d.symbol} — انخفض بـ 40%\`, 'err');
      }
      if (d.type === 'autosell' && d.userId === USER_ID) {
        toast(\`تم البيع التلقائي لـ \${d.symbol} (\${d.reason}) — استلمت \${fmtN(d.revenue)} كوين\`, 'ok');
      }
    } catch {}
  };
}

/* ── Input listeners ────────────────────────────── */
document.getElementById('buyAmount')?.addEventListener('input', updateBuySummary);
document.getElementById('sellAmount')?.addEventListener('input', updateSellSummary);
document.getElementById('asSymbol')?.addEventListener('change', updateAsCurrentPrice);

/* ── Init ───────────────────────────────────────── */
async function init() {
  await fetchPrices();
  if (LOGGED_IN) {
    renderMarket();
    // Pre-populate history for sparklines
    for (let i = 0; i < 5; i++) {
      for (const sym of Object.keys(ALL_DEFS)) {
        const p = priceData[sym];
        if (p) pushHistory(sym, p.price * (1 + (Math.random()-.5)*.02));
      }
    }
    setInterval(fetchPrices, 30_000);
  }
}
init();
</script>
</body>
</html>`;
}

/* ════════════════════════════════════════════════════════════════
   ROUTES SETUP
════════════════════════════════════════════════════════════════ */
module.exports = function setupStockWebRoutes(app, { db }) {
  _db = db;
  startAutoSellChecker();

  const crypto2 = require('crypto');

  /* ── Auth helper ─────────────────────────────── */
  function requireLogin(req, res, next) {
    if (!req.session?.user) return res.status(401).json({ error: 'تسجيل الدخول مطلوب' });
    next();
  }

  /* ── CSRF helper ─────────────────────────────── */
  function verifyCsrf(req, res, next) {
    const token = req.headers['x-csrf-token'] || req.body?.csrfToken;
    if (!req.session?.csrfToken || !token || token !== req.session.csrfToken) {
      return res.status(403).json({ error: 'رمز CSRF غير صالح' });
    }
    req.session.csrfToken = crypto2.randomBytes(32).toString('hex');
    next();
  }

  /* ── Rate Limiter ────────────────────────────── */
  const tradeLimits = new Map();
  function tradeRateLimit(req, res, next) {
    const uid = req.session?.user?.id;
    if (!uid) return next();
    const now    = Date.now();
    const record = tradeLimits.get(uid) || { count: 0, reset: now + 60_000 };
    if (now > record.reset) { record.count = 0; record.reset = now + 60_000; }
    record.count++;
    tradeLimits.set(uid, record);
    if (record.count > 30) return res.status(429).json({ error: 'طلبات كثيرة، انتظر دقيقة' });
    next();
  }

  /* ════════════════════════════════════════════
     GET /trade — Main page
  ════════════════════════════════════════════ */
  app.get('/trade', (req, res) => {
    if (!req.session?.user) return res.redirect('/auth/discord');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.send(buildPage(req.session?.user || null));
  });

  /* ════════════════════════════════════════════
     GET /api/trade/prices — Live prices + balance
  ════════════════════════════════════════════ */
  app.get('/api/trade/prices', async (req, res) => {
    const prices = {};
    for (const sym of Object.keys(ALL_DEFS)) {
      const p = stockMarket.getPrice(sym);
      if (p) prices[sym] = p;
    }
    let balance = 0;
    if (req.session?.user) {
      try {
        const u = await db.findOne({ id: req.session.user.id });
        balance = parseInt(u?.coins || 0);
      } catch {}
    }
    res.json({ prices, balance });
  });

  /* ════════════════════════════════════════════
     GET /api/trade/portfolio
  ════════════════════════════════════════════ */
  app.get('/api/trade/portfolio', requireLogin, async (req, res) => {
    try {
      const userId    = req.session.user.id;
      const portfolio = await StockPortfolio.findOne({ userId });
      const userData  = await db.findOne({ id: userId });
      const balance   = parseInt(userData?.coins || 0);

      if (!portfolio) {
        return res.json({ holdings: [], totalValue: 0, totalPnl: 0, realizedProfit: 0, totalTrades: 0, balance });
      }

      let totalValue = 0, totalCost = 0;
      const holdings = [];
      for (const h of (portfolio.holdings || [])) {
        const p   = stockMarket.getPrice(h.symbol);
        const cur = p?.price || h.avgBuyPrice;
        const val = cur * h.shares;
        const cos = h.avgBuyPrice * h.shares;
        totalValue += val;
        totalCost  += cos;
        holdings.push({ symbol: h.symbol, shares: h.shares, avgBuyPrice: h.avgBuyPrice, currentPrice: cur, value: val });
      }

      res.json({
        holdings,
        totalValue:      Math.round(totalValue),
        totalPnl:        Math.round(totalValue - totalCost),
        realizedProfit:  portfolio.realizedProfit || 0,
        totalTrades:     portfolio.totalTrades    || 0,
        balance,
      });
    } catch (e) {
      res.status(500).json({ error: 'خطأ في الخادم' });
    }
  });

  /* ════════════════════════════════════════════
     POST /api/trade/buy
  ════════════════════════════════════════════ */
  app.post('/api/trade/buy', requireLogin, tradeRateLimit, verifyCsrf, async (req, res) => {
    try {
      const userId = req.session.user.id;
      const { symbol, amount } = req.body;
      const sym = String(symbol || '').toUpperCase();
      const qty = parseInt(amount);

      if (!sym || !ALL_DEFS[sym])            return res.status(400).json({ error: 'رمز السهم غير صحيح' });
      if (!qty || qty < 1 || isNaN(qty))     return res.status(400).json({ error: 'الكمية يجب أن تكون رقماً صحيحاً موجباً' });
      if (qty > 10000)                        return res.status(400).json({ error: 'الحد الأقصى للشراء 10,000 سهم لكل صفقة' });

      const p = stockMarket.getPrice(sym);
      if (!p) return res.status(503).json({ error: 'بيانات السهم غير متاحة حالياً، حاول لاحقاً' });

      const totalCost = p.price * qty;
      const userData  = await db.findOne({ id: userId });
      if (!userData)  return res.status(404).json({ error: 'المستخدم غير موجود' });

      if (userData.status_playing === 'yes') return res.status(403).json({ error: 'لا يمكنك التداول أثناء لعب لعبة نشطة' });

      const balance = parseInt(userData.coins || 0);
      if (balance < totalCost) return res.status(400).json({ error: `رصيدك غير كافٍ. التكلفة: ${totalCost.toLocaleString()} كوين، رصيدك: ${balance.toLocaleString()} كوين` });

      userData.coins = (balance - totalCost).toString();
      await userData.save();

      let portfolio = await StockPortfolio.findOne({ userId });
      if (!portfolio) portfolio = new StockPortfolio({ userId, holdings: [] });

      const existing = portfolio.holdings.find(h => h.symbol === sym);
      if (existing) {
        const prevTotal    = existing.shares * existing.avgBuyPrice;
        existing.shares   += qty;
        existing.avgBuyPrice = Math.round((prevTotal + totalCost) / existing.shares);
      } else {
        portfolio.holdings.push({ symbol: sym, shares: qty, avgBuyPrice: p.price });
      }
      portfolio.totalInvested = (portfolio.totalInvested || 0) + totalCost;
      portfolio.totalTrades   = (portfolio.totalTrades   || 0) + 1;
      portfolio.markModified('holdings');
      await portfolio.save();

      res.json({ ok: true, newBalance: parseInt(userData.coins), symbol: sym, qty, price: p.price, total: totalCost });
    } catch (e) {
      console.error('[BitTrade /buy]', e.message);
      res.status(500).json({ error: 'خطأ في الخادم' });
    }
  });

  /* ════════════════════════════════════════════
     POST /api/trade/sell
  ════════════════════════════════════════════ */
  app.post('/api/trade/sell', requireLogin, tradeRateLimit, verifyCsrf, async (req, res) => {
    try {
      const userId = req.session.user.id;
      const { symbol, amount } = req.body;
      const sym = String(symbol || '').toUpperCase();
      const qty = parseInt(amount);

      if (!sym || !ALL_DEFS[sym])        return res.status(400).json({ error: 'رمز السهم غير صحيح' });
      if (!qty || qty < 1 || isNaN(qty)) return res.status(400).json({ error: 'الكمية يجب أن تكون رقماً صحيحاً موجباً' });

      const userData = await db.findOne({ id: userId });
      if (!userData) return res.status(404).json({ error: 'المستخدم غير موجود' });
      if (userData.status_playing === 'yes') return res.status(403).json({ error: 'لا يمكنك التداول أثناء لعب لعبة نشطة' });

      const portfolio = await StockPortfolio.findOne({ userId });
      const holding   = portfolio?.holdings?.find(h => h.symbol === sym);
      if (!holding || holding.shares < qty) {
        return res.status(400).json({ error: `لا تملك ${qty} سهم في ${sym}. رصيدك: ${holding?.shares || 0} سهم` });
      }

      const p = stockMarket.getPrice(sym);
      if (!p) return res.status(503).json({ error: 'بيانات السهم غير متاحة حالياً' });

      const taxRate     = getTaxRate();
      const grossRevenue = p.price * qty;
      const costBasis    = holding.avgBuyPrice * qty;
      const grossProfit  = grossRevenue - costBasis;
      const taxAmount    = grossProfit > 0 ? Math.floor(grossProfit * taxRate) : 0;
      const revenue      = grossRevenue - taxAmount;
      const netProfit    = grossProfit - taxAmount;

      holding.shares -= qty;
      if (holding.shares <= 0) portfolio.holdings = portfolio.holdings.filter(h => h.symbol !== sym);
      portfolio.realizedProfit = (portfolio.realizedProfit || 0) + netProfit;
      portfolio.totalTrades    = (portfolio.totalTrades    || 0) + 1;
      portfolio.markModified('holdings');
      await portfolio.save();

      const oldBal    = parseInt(userData.coins || 0);
      userData.coins  = (oldBal + revenue).toString();
      await userData.save();

      res.json({ ok: true, newBalance: parseInt(userData.coins), symbol: sym, qty, price: p.price, grossRevenue, taxAmount, revenue, netProfit });
    } catch (e) {
      console.error('[BitTrade /sell]', e.message);
      res.status(500).json({ error: 'خطأ في الخادم' });
    }
  });

  /* ════════════════════════════════════════════
     GET /api/trade/autosell
  ════════════════════════════════════════════ */
  app.get('/api/trade/autosell', requireLogin, (req, res) => {
    const userId = req.session.user.id;
    const orders = getOrders(userId);
    res.json({ orders });
  });

  /* ════════════════════════════════════════════
     POST /api/trade/autosell
  ════════════════════════════════════════════ */
  app.post('/api/trade/autosell', requireLogin, verifyCsrf, (req, res) => {
    const userId = req.session.user.id;
    const { symbol, type, price } = req.body;
    const sym   = String(symbol || '').toUpperCase();
    const pr    = parseInt(price);
    const tp    = String(type || '');

    if (!sym || !ALL_DEFS[sym])       return res.status(400).json({ error: 'رمز غير صحيح' });
    if (!['stop','take'].includes(tp)) return res.status(400).json({ error: 'النوع يجب أن يكون stop أو take' });
    if (!pr || pr < 1)                 return res.status(400).json({ error: 'السعر يجب أن يكون موجباً' });

    const orders = getOrders(userId);
    // Remove existing same symbol+type
    const filtered = orders.filter(o => !(o.symbol === sym && o.type === tp));
    filtered.push({ symbol: sym, type: tp, price: pr });
    autoSellOrders.set(userId, filtered);
    res.json({ ok: true });
  });

  /* ════════════════════════════════════════════
     DELETE /api/trade/autosell/:symbol
  ════════════════════════════════════════════ */
  app.delete('/api/trade/autosell/:symbol', requireLogin, verifyCsrf, (req, res) => {
    const userId = req.session.user.id;
    const sym    = req.params.symbol?.toUpperCase();
    const tp     = req.query.type;
    const orders = getOrders(userId).filter(o => !(o.symbol === sym && o.type === tp));
    autoSellOrders.set(userId, orders);
    res.json({ ok: true });
  });

  /* ════════════════════════════════════════════
     GET /api/trade/events — SSE stream
  ════════════════════════════════════════════ */
  app.get('/api/trade/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    sseClients.add(res);
    const hb = setInterval(() => { try { res.write(':heartbeat\n\n'); } catch {} }, 20_000);

    req.on('close', () => {
      sseClients.delete(res);
      clearInterval(hb);
    });
  });

  /* ── Price-push loop (every 30s) ─────────────── */
  setInterval(() => {
    if (!sseClients.size) return;
    const prices = {};
    for (const sym of Object.keys(ALL_DEFS)) {
      const p = stockMarket.getPrice(sym);
      if (p) prices[sym] = p;
    }
    broadcastSSE({ type: 'price_update', prices });
  }, 30_000);

  console.log('[💹 BitTrade] Routes registered → /trade');
};
