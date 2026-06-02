const crypto  = require("crypto");
const fs       = require("fs");
const path     = require("path");
const session    = require("express-session");
const { MongoStore } = require("connect-mongo");

const fetch = (...a) => import("node-fetch").then(({default:f})=>f(...a));

const NEWS_FILE = path.join(__dirname, "casinoNews.json");
const PF_FILE   = path.join(__dirname, "provablyFair.json");
const PFT_FILE  = path.join(__dirname, "pfGameTracker.json");

/* ── المساعدات ─────────────────────────────────────────────── */
function esc(s){ return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function fmt(n){ return Number(n||0).toLocaleString("en-US"); }
function fmtDate(ts){ if(!ts)return"—"; return new Date(ts).toLocaleDateString("ar-EG",{year:"numeric",month:"short",day:"numeric"}); }
function timeAgo(ts){
  if(!ts)return"—";
  const d=Date.now()-ts, s=Math.floor(d/1000), m=Math.floor(s/60), h=Math.floor(m/60), dy=Math.floor(h/24);
  if(s<60)return`منذ ${s} ثانية`; if(m<60)return`منذ ${m} دقيقة`; if(h<24)return`منذ ${h} ساعة`; return`منذ ${dy} يوم`;
}
function loadNews(){ try{ return JSON.parse(fs.readFileSync(NEWS_FILE,"utf8")); }catch{ return []; } }
function saveNews(d){ fs.writeFileSync(NEWS_FILE,JSON.stringify(d,null,2)); }
function loadPFData(){ try{ return JSON.parse(fs.readFileSync(PF_FILE,"utf8")); }catch{ return {}; } }
function loadPFT(){ try{ return JSON.parse(fs.readFileSync(PFT_FILE,"utf8")); }catch{ return {sessions:{}}; } }

function hashSeedLocal(s){ return crypto.createHash("sha256").update(s).digest("hex"); }
function hmacHexLocal(seed,msg){ return crypto.createHmac("sha256",seed).update(msg).digest("hex"); }
function toRoll100Local(hmac){ return((parseInt(hmac.slice(0,13),16)%10000)/100).toFixed(2); }

const TIER_COLORS = [
  ["#fbbf24","#f59e0b"], // ذهبي علوي
  ["#94a3b8","#64748b"], // فضي
  ["#cd7f32","#92400e"], // برونزي
];
function getTier(coins){
  const c=Number(coins||0);
  if(c>=500_000_000) return {label:"أسطوري",   emoji:"👑",color:"#f59e0b",class:"badge-gold"};
  if(c>=100_000_000) return {label:"ماسي",  emoji:"💎",color:"#0ea5e9",class:"badge-blue"};
  if(c>=50_000_000)  return {label:"بلاتيني", emoji:"🏆",color:"#94a3b8",class:"badge-gold"};
  if(c>=10_000_000)  return {label:"ذهبي",     emoji:"🥇",color:"#f59e0b",class:"badge-gold"};
  if(c>=1_000_000)   return {label:"فضي",   emoji:"🥈",color:"#94a3b8",class:"badge-gold"};
  if(c>=100_000)     return {label:"برونزي",   emoji:"🥉",color:"#cd7f32",class:"badge-gold"};
  return {label:"مبتدئ",   emoji:"🎮",color:"#64748b",class:"badge-purple"};
}
function getBadges(coins, mp, inv){
  const badges=[], c=Number(coins||0);
  if(c>=500_000_000) badges.push({label:"ملياردير",emoji:"💰",cls:"badge-gold"});
  if(c>=100_000_000) badges.push({label:"راهن عالي",emoji:"🎲",cls:"badge-blue"});
  if((mp?.wins||0)>=100)  badges.push({label:"مئوي",emoji:"⚡",cls:"badge-purple"});
  if((mp?.wins||0)>=50)   badges.push({label:"محارب قديم",  emoji:"🏅",cls:"badge-green"});
  if((mp?.challenges||0)>=200) badges.push({label:"بطل",emoji:"👊",cls:"badge-red"});
  const t=(mp?.wins||0)+(mp?.losses||0)+(mp?.draws||0);
  if(t>10&&(mp?.wins||0)/t>=0.7) badges.push({label:"قناص",emoji:"🎯",cls:"badge-red"});
  if(inv?.items?.length>=5) badges.push({label:"جامع",emoji:"🎁",cls:"badge-purple"});
  if((mp?.totalEarned||0)>0) badges.push({label:"كاسب",emoji:"📈",cls:"badge-green"});
  return badges;
}

const PALETTE = ["#ef4444","#f97316","#eab308","#22c55e","#14b8a6","#0ea5e9","#8b5cf6","#ec4899","#84cc16","#06b6d4"];

const DEFAULT_SITE_THEMES = {
  original: {
    key: "original",
    name: "السمة الأصلية",
    primary: "#0ea5e9",
    accent: "#8b5cf6",
    bgStart: "#0b1020",
    bgEnd: "#121a2f",
    card: "#151d2f",
    text: "#e5e7eb",
    bannerFile: "luckbanner.png",
    spinPage: "none",
  },
  rezero: {
    key: "rezero",
    name: "ريزيرو",
    primary: "#7c3aed",
    accent: "#a78bfa",
    bgStart: "#040312",
    bgEnd: "#0c0b22",
    card: "#111226",
    text: "#ede9fe",
    bannerFile: "rezero.png",
    spinPage: "rezero",
  },
  chainsaw: {
    key: "chainsaw",
    name: "تشينسو",
    primary: "#dc2626",
    accent: "#f87171",
    bgStart: "#120909",
    bgEnd: "#1a0f0f",
    card: "#1b1212",
    text: "#f3f4f6",
    bannerFile: "chainsaw.png",
    spinPage: "chainsaw",
  },
};

function mergeThemeWithDefaults(theme = {}) {
  const fallback = DEFAULT_SITE_THEMES.original;
  return {
    key: String(theme.key || fallback.key),
    name: String(theme.name || theme.key || fallback.name),
    primary: String(theme.primary || fallback.primary),
    accent: String(theme.accent || fallback.accent),
    bgStart: String(theme.bgStart || fallback.bgStart),
    bgEnd: String(theme.bgEnd || fallback.bgEnd),
    card: String(theme.card || fallback.card),
    text: String(theme.text || fallback.text),
    bannerFile: String(theme.bannerFile || fallback.bannerFile),
    spinPage: ["none", "rezero", "chainsaw"].includes(theme.spinPage) ? theme.spinPage : "none",
  };
}

function normalizeSiteThemes(settings = {}) {
  const inputThemes = settings.themes && typeof settings.themes === "object" ? settings.themes : {};
  const merged = {};
  for (const [key, baseTheme] of Object.entries(DEFAULT_SITE_THEMES)) {
    merged[key] = mergeThemeWithDefaults({ ...baseTheme, ...(inputThemes[key] || {}), key });
  }
  for (const [key, rawTheme] of Object.entries(inputThemes)) {
    if (!merged[key]) merged[key] = mergeThemeWithDefaults({ ...rawTheme, key });
  }
  return merged;
}

function getThemeContext(settings = {}) {
  const themes = normalizeSiteThemes(settings);
  const activeKey = themes[settings.activeTheme] ? settings.activeTheme : "original";
  const activeTheme = themes[activeKey];
  return { themes, activeKey, activeTheme };
}

function canSeeAdminSection(user) {
  return Boolean(user && (user.isOwner || user.isAdmin));
}

function spinPageInfo(theme) {
  if (!theme || theme.spinPage === "none") return null;
  if (theme.spinPage === "rezero") return { href: "/rezero", icon: "⚔️", label: "دولاب ريزيرو" };
  if (theme.spinPage === "chainsaw") return { href: "/chainsaw", icon: "🪚", label: "دولاب تشينسو" };
  return null;
}

/* ── رابط الصورة الرمزية ───────────────────────────────────────────── */
function avatarUrl(userId, avatarHash){
  if(avatarHash) return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.png?size=80`;
  return `https://cdn.discordapp.com/embed/avatars/${Number(userId||0)%5}.png`;
}

/* ══════════════════════════════════════════════════════════
   مساعدات التخطيط
══════════════════════════════════════════════════════════ */
function navbar(user){
  const settings = user?.siteSettings || {};
  const { activeTheme } = getThemeContext(settings);
  const spinInfo = spinPageInfo(activeTheme);
  const adminLink = canSeeAdminSection(user) ? `<a href="/admin">🛡️ المشرف</a>` : "";
  const spinLink = spinInfo ? `<a href="${spinInfo.href}">${spinInfo.icon} ${spinInfo.label}</a>` : "";
  const lang = "en"; // يتم تحديده من جانب العميل
  const userSection = user
    ? `<div class="nav-user">
        <img class="nav-avatar" src="${avatarUrl(user.id,user.avatar)}" alt="الصورة الرمزية"
          onerror="this.src='https://cdn.discordapp.com/embed/avatars/0.png'"
          onclick="window.location='/profile/${user.id}'">
        <span class="nav-username">${esc(user.username)}</span>
        <a href="/auth/logout" class="btn btn-ghost btn-sm">تسجيل خروج</a>
      </div>`
    : `<a href="/auth/discord" class="btn btn-discord btn-sm">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="white"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057.1 18.08.11 18.1.12 18.116a19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z"/></svg>
        تسجيل الدخول
      </a>`;
  return `<nav class="navbar">
    <button class="hamburger" id="hamburger" aria-label="القائمة">
      <span></span><span></span><span></span>
    </button>
    <a href="/" class="navbar-logo">
      <img src="/pfp.png" alt="الشعار" onerror="this.style.display='none'">
      <span><span class="logo-name">دايموند</span> كازينو</span>
    </a>
    <div class="nav-links">
      <a href="/">🏠 الرئيسية</a>
      <a href="/leaderboard">🏆 المتصدرون</a>
      <a href="/chess">♟️ شطرنج</a>
      <a href="/verify">🔐 التحقق</a>
      <a href="/market">🏪 السوق</a>
      <a href="/trade">📈 BitTrade</a>
      <a href="/news">📰 الأخبار</a>
      <a href="/parkour">🏃 باركور</a>
      <a href="/missions">📋 المهام</a>
      <a href="/matches">⚽ المباريات</a>
      ${spinLink}
      <a href="/vip">⭐ VIP</a>
      ${adminLink}
      <a href="/help">📚 المساعدة</a>
    </div>
    <div class="nav-search-wrap">
      <input class="nav-search" id="navSearch" placeholder="بحث عن لاعب…" autocomplete="off">
      <button class="nav-search-btn" id="navSearchBtn">🔍</button>
    </div>
    <div class="nav-actions">
      <button class="sound-toggle" id="soundToggle" title="تبديل الأصوات">🔊</button>
      <button class="theme-toggle" id="themeToggle" title="تبديل المظهر">☀️</button>
      ${userSection}
    </div>
  </nav>`;
}

function sidebar(active="", user=null){
  const settings = user?.siteSettings || {};
  const { activeTheme } = getThemeContext(settings);
  const spinInfo = spinPageInfo(activeTheme);
  const mainLinks=[
    {href:"/",          icon:"🏠", label:"الرئيسية",          label_ar:"الرئيسية"},
    {href:"/leaderboard",icon:"🏆",label:"المتصدرون",   label_ar:"المتصدرون"},
    {href:"/stats",     icon:"📊", label:"إحصائيات الكازينو",   label_ar:"إحصائيات"},
    {href:"/search",    icon:"🔍", label:"بحث",         label_ar:"بحث"},
  ];
  const casinoLinks=[
    {href:"/crash",     icon:"✈️", label:"Crash",             label_ar:"كراش"},
    {href:"/mines",     icon:"💣", label:"Mines",             label_ar:"ألغام"},
    {href:"/piano",     icon:"🎹", label:"Piano Tiles",       label_ar:"بيانو"},
    {href:"/chess",     icon:"♟️", label:"شطرنج",            label_ar:"شطرنج"},
    {href:"/parkour",   icon:"🏃", label:"باركور",          label_ar:"باركور"},
    {href:"/market",    icon:"🏪", label:"السوق",    label_ar:"السوق"},
    {href:"/trade",     icon:"📈", label:"BitTrade",  label_ar:"بيتريد"},
    {href:"/matches",   icon:"⚽", label:"رهانات المباريات",   label_ar:"رهانات المباريات"},
    {href:"/watch",     icon:"🎬", label:"مشاهدة مشتركة",      label_ar:"مشاهدة مشتركة"},
  ];
  const communityLinks=[
    {href:"/news",      icon:"📰", label:"أخبار الكازينو",    label_ar:"الأخبار"},
    ...(spinInfo ? [{href:spinInfo.href, icon:spinInfo.icon, label:spinInfo.label, label_ar:spinInfo.label}] : []),
    {href:"/vip",       icon:"⭐", label:"أعضاء VIP",    label_ar:"أعضاء VIP"},
  ];
  const accountLinks=[
    {href:"/verify",    icon:"🔐", label:"التحقق من العدالة",  label_ar:"التحقق"},
    {href:"/tickets",   icon:"🎫", label:"تذاكر الدعم", label_ar:"تذاكر الدعم"},
    {href:"/security",  icon:"🛡️", label:"الأمان",       label_ar:"الأمان"},
    {href:"/help",      icon:"📚", label:"مركز المساعدة",    label_ar:"المساعدة"},
  ];
  const adminLinks=[
    {href:"/admin",               icon:"⚙️", label:"لوحة التحكم",      label_ar:"لوحة الإدارة"},
    {href:"/admin/db",            icon:"🗄️", label:"مستعرض قاعدة البيانات",       label_ar:"قاعدة البيانات"},
    {href:"/admin/settings",      icon:"🔧", label:"إعدادات الموقع",     label_ar:"إعدادات الموقع"},
    {href:"/admin/parkour-map",   icon:"🏃", label:"محرر خريطة الباركور",label_ar:"محرر خريطة الباركور"},
  ];
  function renderLinks(links){
    return links.map(l=>`<a href="${l.href}" class="${active===l.href?"active":""}">
      <span class="si">${l.icon}</span>
      <span class="en-label">${l.label}</span>
      <span class="ar-label" style="display:none">${l.label_ar}</span>
    </a>`).join("");
  }
  return `<aside class="sidebar" id="sidebar">
    <div class="sidebar-logo-wrap">
      <img src="/pfp.png" alt="دايموند كازينو" onerror="this.style.display='none'">
      <div class="sidebar-casino-name">💎 دايموند كازينو</div>
    </div>
    <div class="sidebar-section">
      <div class="sidebar-section-title">الرئيسية</div>
      ${renderLinks(mainLinks)}
    </div>
    <div class="sidebar-section">
      <div class="sidebar-section-title">الكازينو</div>
      ${renderLinks(casinoLinks)}
    </div>
    <div class="sidebar-section">
      <div class="sidebar-section-title">المجتمع</div>
      ${renderLinks(communityLinks)}
    </div>
    <div class="sidebar-section">
      <div class="sidebar-section-title">الحساب</div>
      ${renderLinks(accountLinks)}
    </div>
    ${canSeeAdminSection(user) ? `<div class="sidebar-section">
      <div class="sidebar-section-title">المشرف</div>
      ${renderLinks(adminLinks)}
    </div>` : ""}
  </aside>
  <div class="overlay" id="overlay"></div>`;
}

function layout(title, content, active="", user=null, extraHead="", announcement=""){
  const annBanner = announcement
    ? `<div class="ann-banner"><span>${announcement}</span><button onclick="this.parentElement.remove()" style="background:none;border:none;cursor:pointer;color:inherit;font-size:18px;line-height:1;opacity:0.7">×</button></div>`
    : "";
  let _bodyClass = "";
  let _themeVars = "";
  const settingsForLayout = user?.siteSettings || (() => {
    try { return JSON.parse(fs.readFileSync(path.join(__dirname,"siteSettings.json"),"utf8")); } catch { return {}; }
  })();
  try {
    const { activeKey, activeTheme } = getThemeContext(settingsForLayout);
    if(activeKey === "rezero") _bodyClass = " rezero";
    else if(activeKey === "chainsaw") _bodyClass = " chainsaw";
    else _bodyClass = ` theme-${activeKey}`;
    _themeVars = `
      <style>
        body.theme-${activeKey}{
          --primary:${activeTheme.primary};
          --purple:${activeTheme.accent};
          --bg:linear-gradient(135deg,${activeTheme.bgStart},${activeTheme.bgEnd});
          --card:${activeTheme.card};
          --text:${activeTheme.text};
        }
      </style>
    `;
  } catch {}
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — دايموند كازينو</title>
<link rel="stylesheet" href="/style.css">
<link rel="icon" href="/pfp.png">
${_themeVars}
${extraHead}
</head>
<body class="${_bodyClass.trim()}">
${annBanner}
<div class="particles" id="particles"></div>
${navbar(user)}
<div class="layout">
  ${sidebar(active,user)}
  <main class="main">
    ${content}
  </main>
</div>
<div id="toast-container"></div>
<script src="/app.js"></script>
</body>
</html>`;
}

/* ══════════════════════════════════════════════════════════
   التصدير الرئيسي
══════════════════════════════════════════════════════════ */
module.exports = function setupWebsite(app, {
  db, inventory, mafiaPlayer, mafiaFamiglia,
  SERVER_SETTINGS, ABILITY_DEFS, BM_ITEMS, discordClient, payoutFn
}){
  const express = require("express");
  const Comments      = require("./models/comments");
  const Friends       = require("./models/friends");
  const Customization = require("./models/customization");
  const UserCache     = require("./models/userCache");
  const DailyMission  = require("./models/dailyMission");
  const matchBet      = require("./models_games/matchbet");
  const BattlePass    = require("./models/season");
  const Ticket        = require("./models/ticket");
  const Showcase      = require("./models/showcase");

  const SETTINGS_FILE = path.join(__dirname, "siteSettings.json");
  function loadSettings(){
    try {
      const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE,"utf8"));
      const { themes, activeKey } = getThemeContext(raw);
      return { ...raw, themes, activeTheme: activeKey };
    } catch {
      const fallback = { activeTheme: "original", themes: normalizeSiteThemes({}) };
      return fallback;
    }
  }
  function saveSettings(d){
    const normalized = { ...d };
    const { themes, activeKey } = getThemeContext(normalized);
    normalized.themes = themes;
    normalized.activeTheme = activeKey;
    fs.writeFileSync(SETTINGS_FILE,JSON.stringify(normalized,null,2));
  }

  let _ticketCounter = 0;
  function nextTicketId(){ _ticketCounter++; return "TK"+String(Date.now()).slice(-6)+String(_ticketCounter).padStart(3,"0"); }

  const MISSION_DEFS = [
    { id:"play_3",     label:"العب 3 ألعاب",        icon:"🎮", target:3,    reward:500,  type:"play"  },
    { id:"win_2",      label:"اربح لعبتين",          icon:"🏆", target:2,    reward:1000, type:"win"   },
    { id:"bet_5000",   label:"راهن بـ 5,000 عملة",      icon:"💰", target:5000, reward:750,  type:"bet"   },
    { id:"login_site", label:"تسجيل الدخول للموقع", icon:"🌐", target:1,    reward:200,  type:"login" },
  ];

  const LOG_CHANNEL_ID = "1505600232618987731";

  app.use(session({
    secret: process.env.SESSION_SECRET||"diamond-casino-2026",
    resave:false, saveUninitialized:false,
    cookie:{maxAge:7*24*60*60*1000},
    store: MongoStore.create({ mongoUrl: process.env.MONGO_URI, ttl: 7*24*60*60 })
  }));
  app.use(express.json());
  app.use(express.urlencoded({extended:true}));
  app.use(express.static(path.join(__dirname,"public")));
  app.use(express.static(path.join(__dirname,"backgrounds")));
  app.use("/pfp.png",   (req,res)=>res.sendFile(path.join(__dirname,"pfp.png")));
  app.use("/luckbanner.png",(req,res)=>{
    const settings = loadSettings();
    const { activeTheme } = getThemeContext(settings);
    const requested = activeTheme.bannerFile || "luckbanner.png";
    const candidates = [
      path.join(__dirname, requested),
      path.join(__dirname, "public", requested),
      path.join(__dirname, "attached_assets", requested),
    ];
    const found = candidates.find(p => fs.existsSync(p));
    res.sendFile(found || path.join(__dirname,"luckbanner.png"));
  });

  // ── CSRF Token Endpoint ───────────────────────────────────────
  app.get('/api/csrf-token', (req, res) => {
    if (!req.session?.user) return res.status(401).json({ error: 'تسجيل الدخول مطلوب' });
    if (!req.session.csrfToken) {
      req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    }
    res.json({ token: req.session.csrfToken });
  });

  // ── CSRF Validation Helper ────────────────────────────────────
  function verifyCsrf(req, res, next) {
    const token = req.headers['x-csrf-token'] || req.body?.csrfToken;
    if (!req.session?.csrfToken || !token || token !== req.session.csrfToken) {
      return res.status(403).json({ error: 'CSRF token invalid' });
    }
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    next();
  }

  // ── Unified Game Balance Settle API ──────────────────────────
  app.post('/api/game/settle', verifyCsrf, async (req, res) => {
    try {
      if (!req.session?.user) return res.status(401).json({ error: 'تسجيل الدخول مطلوب' });
      const { gameId, gameType } = req.body;
      const userId = req.session.user.id;

      if (!gameId || !gameType) return res.status(400).json({ error: 'Missing gameId or gameType' });

      let game, winnerId, loserId;

      if (gameType === 'chess') {
        const ChessGame = require('./models_games/chessGame');
        game = await ChessGame.findOne({ gameId });
        if (!game) return res.status(404).json({ error: 'Game not found' });
        if (userId !== game.player1 && userId !== game.player2) return res.status(403).json({ error: 'Not a player in this game' });
        if (game.status !== 'finished') return res.status(400).json({ error: 'Game not finished yet' });
        if (game.payoutDone) return res.json({ message: 'Already settled', settled: true });
        winnerId = game.result === 'white' ? game.player1 : game.result === 'black' ? game.player2 : null;
        loserId  = game.result === 'white' ? game.player2 : game.result === 'black' ? game.player1 : null;

      } else if (gameType === 'parkour') {
        const ParkourGame = require('./models_games/parkourGame');
        game = await ParkourGame.findOne({ gameId });
        if (!game) return res.status(404).json({ error: 'Game not found' });
        if (userId !== game.player1 && userId !== game.player2) return res.status(403).json({ error: 'Not a player in this game' });
        if (game.status !== 'finished') return res.status(400).json({ error: 'Game not finished yet' });
        if (game.payoutDone) return res.json({ message: 'Already settled', settled: true });
        winnerId = game.result === 'player1' ? game.player1 : game.result === 'player2' ? game.player2 : null;
        loserId  = game.result === 'player1' ? game.player2 : game.result === 'player2' ? game.player1 : null;

      } else if (gameType === 'penalty') {
        const PenaltyGame = require('./models_games/penaltyGame');
        game = await PenaltyGame.findOne({ gameId });
        if (!game) return res.status(404).json({ error: 'Game not found' });
        if (userId !== game.player1 && userId !== game.player2) return res.status(403).json({ error: 'Not a player in this game' });
        if (game.status !== 'finished') return res.status(400).json({ error: 'Game not finished yet' });
        if (game.payoutDone) return res.json({ message: 'Already settled', settled: true });
        winnerId = game.result === 'player1' ? game.player1 : game.result === 'player2' ? game.player2 : null;
        loserId  = game.result === 'player1' ? game.player2 : game.result === 'player2' ? game.player1 : null;

      } else {
        return res.status(400).json({ error: 'Invalid gameType. Use: chess | parkour | penalty' });
      }

      const betAmount = parseInt(game.betAmount) || 0;

      game.payoutDone = true;
      await game.save();

      if (betAmount <= 0) {
        await db.findOneAndUpdate({ id: game.player1 }, { $set: { status_playing: 'no' } }).catch(() => {});
        await db.findOneAndUpdate({ id: game.player2 }, { $set: { status_playing: 'no' } }).catch(() => {});
        return res.json({ message: 'No bet, no coins transferred', settled: true });
      }

      if (!winnerId || !loserId) {
        // draw
        await db.findOneAndUpdate({ id: game.player1 }, { $set: { status_playing: 'no' } }).catch(() => {});
        await db.findOneAndUpdate({ id: game.player2 }, { $set: { status_playing: 'no' } }).catch(() => {});
        return res.json({ message: '🤝 تعادل! لا تغيير في الرصيد.', settled: true });
      }

      const tax = Math.floor(betAmount * 0.04);
      const prize = betAmount - tax;

      await db.findOneAndUpdate({ id: winnerId }, { $inc: { coins: prize }, $set: { status_playing: 'no' } }).catch(() => {});
      await db.findOneAndUpdate({ id: loserId }, { $inc: { coins: -betAmount }, $set: { status_playing: 'no' } }).catch(() => {});

      console.log(`[game/settle] ${gameType} | winner:${winnerId} +${prize} | loser:${loserId} -${betAmount}`);

      return res.json({
        success: true,
        message: `🏆 فزت بـ ${prize.toLocaleString('en-US')} عملة!`,
        prize,
        tax,
        settled: true
      });

    } catch (err) {
      console.error('[game/settle] ERROR:', err);
      res.status(500).json({ error: err.message });
    }
  });
  async function siteLog(title, description, color="#5865F2"){
    try{
      if(!discordClient) return;
      const ch = await discordClient.channels.fetch(LOG_CHANNEL_ID).catch(()=>null);
      if(!ch) return;
      const { MessageEmbed } = require("discord.js");
      const embed = new MessageEmbed()
        .setTitle(title)
        .setDescription(description)
        .setColor(color)
        .setTimestamp()
        .setFooter({ text:"موقع دايموند كازينو" });
      await ch.send({ embeds:[embed] }).catch(()=>null);
    }catch{}
  }

  function todayDate(){ return new Date().toISOString().slice(0,10); }

  async function getOrCreateDailyMissions(userId){
    const date = todayDate();
    let doc = await DailyMission.findOne({ userId, date }).catch(()=>null);
    if(!doc){
      doc = await DailyMission.create({
        userId, date,
        missions: MISSION_DEFS.map(m=>({ id:m.id, progress:0, claimed:false }))
      }).catch(()=>null);
    }
    if(doc && doc.missions.length < MISSION_DEFS.length){
      const existing = new Set(doc.missions.map(m=>m.id));
      MISSION_DEFS.forEach(m=>{ if(!existing.has(m.id)) doc.missions.push({id:m.id,progress:0,claimed:false}); });
      await doc.save().catch(()=>null);
    }
    return doc;
  }

  const ITEM_ABILITY_MAP=["steal_blade","lucky_coin","shield_of_fortune","mystery_box","whisper_dealer","counter_token","double_or_nothing","insider_info","bomb_redirect","crystal_vision","fortune_favor","tax_shield","jackpot_token","spy_glass"];

  const REZERO_CHARACTERS = [
    { id:"subaru",    name:"سوبارو ناتسوكي",      title:"رسول عودة الموت",     rarity:"legendary", emoji:"⚔️", color:"#dc2626", glowColor:"rgba(220,38,38,0.55)",  bg:"linear-gradient(155deg,#1a0505,#3b0808)",    ability:"return_by_death", abilityType:"rz_return_by_death", abilityName:"العودة بالموت",   abilityDesc:"تراجع عن آخر خسارة لك في اللعبة — يتم استرداد العملات بالكامل",   img:"/rz_subaru.png" },
    { id:"emilia",    name:"إميليا",              title:"ساحرة الروح نصف الجنية",             rarity:"legendary", emoji:"❄️", color:"#a78bfa", glowColor:"rgba(167,139,250,0.55)", bg:"linear-gradient(155deg,#0a0520,#1e0c4b)",    ability:"frozen_forest", abilityType:"rz_frozen_forest", abilityName:"الغابة المتجمدة", abilityDesc:"يتم إلغاء خسارتك التالية بالكامل واسترداد الرهان",    img:"/rz_emilia.png" },
    { id:"satella",   name:"ساحرة الحسد",       title:"الساحرة المنسية",              rarity:"legendary", emoji:"🖤", color:"#7c3aed", glowColor:"rgba(124,58,237,0.65)",  bg:"linear-gradient(155deg,#030309,#14083a)",    ability:"witch_factor", abilityType:"rz_witch_factor", abilityName:"عامل الساحرة",      abilityDesc:"في خسارتك التالية، اسرق 40% من أرباح الخصم",    img:"/rz_satella.png" },
    { id:"rem",       name:"ريم",                 title:"خادمة الشيطان من دماء الأوني",          rarity:"epic",      emoji:"💙", color:"#3b82f6", glowColor:"rgba(59,130,246,0.45)",  bg:"linear-gradient(155deg,#030a1a,#0c1f4a)",    ability:"water_demon_art", abilityType:"rz_water_demon", abilityName:"فن شيطان الماء",   abilityDesc:"فوزك التالي يدفع ضعف المبلغ العادي",            img:"/rz_rem.png" },
    { id:"ram",       name:"رام",                 title:"خادمة الأوني ذات شفرة الريح",              rarity:"epic",      emoji:"🌸", color:"#f472b6", glowColor:"rgba(244,114,182,0.45)", bg:"linear-gradient(155deg,#1a0514,#420f30)",    ability:"wind_blade", abilityType:"rz_wind_blade", abilityName:"شفرة الريح",        abilityDesc:"تقليل جميع الضرائب بنسبة 75% لمدة ساعتين",               img:"/rz_ram.png" },
    { id:"beatrice",  name:"بياتريس",            title:"حارسة المكتبة المحرمة",rarity:"epic",      emoji:"📚", color:"#fbbf24", glowColor:"rgba(251,191,36,0.45)",  bg:"linear-gradient(155deg,#130e00,#3a2800)",    ability:"crystal_magic", abilityType:"rz_crystal_magic", abilityName:"السحر البلوري", abilityDesc:"احجب القدرة التالية التي يستخدمها خصمك ضدك",       img:"/rz_beatrice.png" },
    { id:"roswaal",   name:"روسوال إل ماذرز",  title:"ساحر البلاط ذو السحر العظيم",        rarity:"rare",      emoji:"🎭", color:"#8b5cf6", glowColor:"rgba(139,92,246,0.35)",  bg:"linear-gradient(155deg,#0c0820,#22156a)",    ability:"great_magic", abilityType:"rz_great_magic", abilityName:"السحر العظيم",       abilityDesc:"اضرب فوزك التالي بمقدار 1.5× إضافي",               img:"/rz_roswaal.png" },
    { id:"crusch",    name:"كروش كارستن",       title:"جنرال القبضة الحديدية",        rarity:"rare",      emoji:"🌬️",color:"#22c55e", glowColor:"rgba(34,197,94,0.35)",   bg:"linear-gradient(155deg,#031a0a,#0a3d1a)",    ability:"wind_reading", abilityType:"rz_wind_reading", abilityName:"قراءة الريح",      abilityDesc:"تخطي الضريبة على فوزك التالي تمامًا",               img:"/rz_crusch.png" },
    { id:"priscilla", name:"بريسيلا بارييل",  title:"الجمال القرمزي الأناني",       rarity:"rare",      emoji:"🌹", color:"#f97316", glowColor:"rgba(249,115,22,0.35)",  bg:"linear-gradient(155deg,#1a0800,#3d1800)",    ability:"divine_protection", abilityType:"rz_divine_prot", abilityName:"الحماية الإلهية", abilityDesc:"إجبار التعادل في خسارتك التالية — استرد رهانك",          img:"/rz_priscilla.png" },
    { id:"julius",    name:"يوليوس يوكوليوس",     title:"أعظم فارس في المملكة",  rarity:"rare",      emoji:"⚜️", color:"#eab308", glowColor:"rgba(234,179,8,0.35)",   bg:"linear-gradient(155deg,#131000,#362c00)",    ability:"spirit_knight", abilityType:"rz_spirit_knight", abilityName:"الفارس الروحي", abilityDesc:"تقليل مبلغ خسارتك التالية بنسبة 50%", img:"/rz_julius.png" },
    { id:"felt",      name:"فيلت",                title:"أميرة الأحياء الفقيرة",                rarity:"common",    emoji:"🔴", color:"#ef4444", glowColor:"rgba(239,68,68,0.28)",   bg:"linear-gradient(155deg,#1a0505,#2e0f0f)",    ability:"street_luck",      abilityName:"حظ الشارع",       abilityDesc:"اربح 300 عملة إضافية تضاف إلى رصيدك",       img:null },
    { id:"otto",      name:"أوتو سوين",           title:"تاجر قارئ الرياح",            rarity:"common",    emoji:"🐟", color:"#14b8a6", glowColor:"rgba(20,184,166,0.28)",  bg:"linear-gradient(155deg,#031212,#083a3a)",    ability:"od_laguna",        abilityName:"أود لاغونا",         abilityDesc:"تواصل مع القدر — اربح 200 عملة إضافية مجانًا",      img:null },
  ];

  function parseAbilityDefName(fullName = "") {
    if (!fullName) return null;
    const normalized = String(fullName).replace("â€”", "—");
    const parts = normalized.split("—").map(s => s.trim()).filter(Boolean);
    if (parts.length < 2) return null;
    return { abilityName: parts[0], abilityDesc: parts.slice(1).join(" — ") };
  }

  const REZERO_CHARACTERS_SYNCED = REZERO_CHARACTERS.map((char) => {
    const def = char.abilityType ? ABILITY_DEFS?.[char.abilityType] : null;
    const parsed = parseAbilityDefName(def?.name);
    if (!def || !parsed) return char;
    return {
      ...char,
      abilityName: parsed.abilityName || char.abilityName,
      abilityDesc: parsed.abilityDesc || char.abilityDesc,
    };
  });
  const RZ_RARITY_WEIGHTS = { legendary:5, epic:20, rare:35, common:40 };
  function pickRzCharacter(){
    const roll = Math.random()*100;
    let cumulative = 0;
    for(const rarity of ["legendary","epic","rare","common"]){
      cumulative += RZ_RARITY_WEIGHTS[rarity];
      if(roll < cumulative){
        const pool = REZERO_CHARACTERS_SYNCED.filter(c=>c.rarity===rarity);
        return pool[Math.floor(Math.random()*pool.length)];
      }
    }
    return REZERO_CHARACTERS_SYNCED[REZERO_CHARACTERS_SYNCED.length-1];
  }


  /* ══════════════════════════════════════════════════════════
     وسيط الأمان
  ══════════════════════════════════════════════════════════ */
  // ── رؤوس الأمان ──────────────────────────────────────
  app.use((req,res,next)=>{
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('X-Frame-Options','SAMEORIGIN');
    res.setHeader('X-XSS-Protection','1; mode=block');
    res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
    next();
  });

  // ── محدد المعدل في الذاكرة ─────────────────────────────────
  const _rlStore = new Map();
  function cleanupRl(){ const now=Date.now(); for(const[k,v] of _rlStore){ if(now>v.reset) _rlStore.delete(k); } }
  setInterval(cleanupRl, 60000);

  function siteRateLimit(maxPerMin, keyFn){
    return function(req,res,next){
      const now=Date.now();
      const key=keyFn?keyFn(req):`${req.ip}__${req.path}`;
      const entry=_rlStore.get(key)||{count:0,reset:now+60000};
      if(now>entry.reset){ entry.count=0; entry.reset=now+60000; }
      entry.count++;
      _rlStore.set(key,entry);
      if(entry.count>maxPerMin){
        siteLog('🚨 تم تجاوز حد المعدل',`IP \`${req.ip}\` تجاوز حد المعدل على \`${req.method} ${req.path}\`\nالعدد: **${entry.count}**`,'#ED4245').catch(()=>{});
        return res.status(429).json({error:'عدد الطلبات كبير جدًا — يرجى التباطؤ.'});
      }
      next();
    };
  }

  // ── حماية API البوت الداخلية ─────────────────────────────────
  // واجهات برمجة التطبيقات التي تقوم بتحديث الأرصدة أو تنفيذ إجراءات المسؤول يجب أن تقدم تجزئة رمز البوت
  const BOT_SECRET_HASH = crypto.createHash('sha256').update(process.env.BOT_TOKEN||process.env.DISCORD_TOKEN||'dev-token').digest('hex');
  function requireInternalToken(req,res,next){
    const token=req.headers['x-internal-token']||req.body?._internalToken;
    if(!token) return res.status(403).json({error:'ممنوع: رمز داخلي مفقود'});
    const provided=crypto.createHash('sha256').update(token).digest('hex');
    if(provided!==BOT_SECRET_HASH) return res.status(403).json({error:'ممنوع: رمز غير صالح'});
    next();
  }

  // ── تطبيق تحديد المعدل على جميع مسارات API ──────────────────
  app.use('/api/', siteRateLimit(120));

  // ── حماية إضافية على واجهات برمجة التطبيقات الخاصة بالمشرف/الرصيد ─────────────────
  app.use('/api/admin/', (req,res,next)=>{
    if(!req.session?.user) return res.status(401).json({error:'غير مصرح'});
    if(!OWNERS.includes(req.session.user.id)) return res.status(403).json({error:'ممنوع'});
    next();
  });

  // ── منع الوصول الخارجي المباشر إلى نقاط نهاية البوت الحساسة ─
  // أي مسار يقوم بتعديل أرصدة العملات مباشرة يتطلب جلسة المالك أو رمزًا داخليًا
  app.use('/api/balance-update', requireInternalToken);

  const CLIENT_ID     = process.env.DISCORD_CLIENT_ID||"";
  const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET||"";
  const BASE_URL      = process.env.REPLIT_DEV_DOMAIN
    ? `https://${process.env.REPLIT_DEV_DOMAIN}`
    : "http://fi11.bot-hosting.net:20407";
  const REDIRECT_URI  = `${BASE_URL}/auth/discord/callback`;

  const GUILD_ID   = SERVER_SETTINGS.guild.guildId;
  const OWNERS     = SERVER_SETTINGS.users.owners||[];
  const ADMIN_ROLE = SERVER_SETTINGS.roles.adminRoleId;

  /* المساعدات */
  function isOwner(req){ return req.session.user&&OWNERS.includes(req.session.user.id); }
  function requireOwner(req,res,next){ if(!isOwner(req))return res.status(403).json({error:"ممنوع"}); next(); }
  function requireLogin(req,res,next){ if(!req.session?.user)return res.redirect("/auth/discord"); next(); }
  async function fetchDiscordUser(userId){
    if(!discordClient)return null;
    try{ return await discordClient.users.fetch(userId).catch(()=>null); }catch{ return null; }
  }
  async function isAdminUser(userId){
    if(!discordClient || !userId) return false;
    try{
      const guild = discordClient.guilds.cache.get(GUILD_ID);
      if(!guild) return false;
      const member = await guild.members.fetch(userId).catch(()=>null);
      if(!member) return false;
      return member.roles.cache.has(ADMIN_ROLE);
    }catch{
      return false;
    }
  }

  app.use(async (req,res,next)=>{
    if(!req.session?.user) return next();
    const sessionUser = req.session.user;
    sessionUser.isOwner = OWNERS.includes(sessionUser.id);
    if (typeof sessionUser.isAdmin !== "boolean") {
      sessionUser.isAdmin = sessionUser.isOwner ? true : await isAdminUser(sessionUser.id);
    }
    sessionUser.siteSettings = loadSettings();
    next();
  });
  async function getCachedUser(userId){
    const cached=await UserCache.findOne({id:userId}).lean().catch(()=>null);
    return cached;
  }
  async function getOrFetchUser(userId){
    const cached=await getCachedUser(userId);
    if(cached&&cached.username) return cached;
    const dUser=await fetchDiscordUser(userId);
    if(dUser){
      await UserCache.findOneAndUpdate({id:userId},{username:dUser.username,avatar:dUser.avatar||"",updatedAt:new Date()},{upsert:true}).catch(()=>null);
      return {id:userId,username:dUser.username,avatar:dUser.avatar||""};
    }
    return cached||null;
  }
  async function richSort(limit=100){
    const all=await db.find({}).lean().catch(()=>[]);
    return all.sort((a,b)=>Number(b.coins||0)-Number(a.coins||0)).slice(0,limit);
  }

  /* ── OAuth ديسكورد ───────────────────────────────────────── */
  app.get("/auth/discord",(req,res)=>{
    if(!CLIENT_ID) return res.redirect("/?error=no_client_id");
    const params=new URLSearchParams({client_id:CLIENT_ID,redirect_uri:REDIRECT_URI,response_type:"code",scope:"identify guilds guilds.join"});
    res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
  });

  app.get("/auth/discord/callback",async(req,res)=>{
    const {code}=req.query; if(!code)return res.redirect("/");
    try{
      const tokenRes=await fetch("https://discord.com/api/oauth2/token",{
        method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},
        body:new URLSearchParams({client_id:CLIENT_ID,client_secret:CLIENT_SECRET,grant_type:"authorization_code",code,redirect_uri:REDIRECT_URI})
      });
      const tokenData=await tokenRes.json();
      if(!tokenData.access_token)throw new Error("no token");
      const userRes=await fetch("https://discord.com/api/users/@me",{headers:{Authorization:`Bearer ${tokenData.access_token}`}});
      const ud=await userRes.json();
      req.session.user={id:ud.id,username:ud.username,discriminator:ud.discriminator,avatar:ud.avatar};
      req.session.user.isOwner = OWNERS.includes(ud.id);
      req.session.user.isAdmin = req.session.user.isOwner ? true : await isAdminUser(ud.id);
      req.session.accessToken=tokenData.access_token;
      await UserCache.findOneAndUpdate({id:ud.id},{username:ud.username,avatar:ud.avatar||"",updatedAt:new Date()},{upsert:true}).catch(()=>null);
      req.session.loginAlert=`👋 مرحبًا بعودتك، ${ud.username}!`;
      siteLog("🌐 تسجيل دخول الموقع", `**${ud.username}** قام بتسجيل الدخول عبر ديسكورد\nالمعرف: \`${ud.id}\``, "#57F287");
      const mDoc = await getOrCreateDailyMissions(ud.id);
      if(mDoc){ const lm=mDoc.missions.find(m=>m.id==="login_site"); if(lm&&lm.progress<1){lm.progress=1;mDoc.markModified("missions");await mDoc.save().catch(()=>null);} }
      /* إضافة المستخدم تلقائيًا إلى خادم ديسكورد */
      try{
        const guildId=SERVER_SETTINGS?.guildId||"1507738297496244394";
        const botToken=process.env.BOT_TOKEN||process.env.DISCORD_TOKEN;
        if(botToken&&tokenData.access_token){
          await fetch(`https://discord.com/api/v10/guilds/${guildId}/members/${ud.id}`,{
            method:"PUT",
            headers:{"Authorization":`Bot ${botToken}`,"Content-Type":"application/json"},
            body:JSON.stringify({access_token:tokenData.access_token})
          });
        }
      }catch(e){/* صامت — قد يكون المستخدم موجودًا بالفعل في الخادم */}
      res.redirect("/");
    }catch(err){console.error("oauth:",err.message);res.redirect("/?error=oauth_failed");}
  });

  app.get("/auth/logout",(req,res)=>{ req.session.destroy(()=>res.redirect("/")); });

  /* ── API: التحقق من العدالة ──────────────────────────────────────── */
  app.post("/api/verify-pf",(req,res)=>{
    const{serverSeed,clientSeed,nonce}=req.body;
    if(!serverSeed||!clientSeed||nonce==null||nonce==="")return res.json({error:"حقول مفقودة"});
    if(isNaN(Number(nonce)))return res.json({error:"يجب أن يكون العدد العشوائي رقمًا"});
    const payload=`${clientSeed}:${nonce}`;
    const hmac=hmacHexLocal(serverSeed,payload);
    res.json({serverSeedHash:hashSeedLocal(serverSeed),payload,hmac,roll:toRoll100Local(hmac)});
  });

  /* ── API: تعليق ────────────────────────────────────────── */
  app.post("/api/comment/:id",async(req,res)=>{
    if(!req.session.user)return res.json({error:"تسجيل الدخول مطلوب"});
    const{text}=req.body;
    if(!text||text.trim().length<1)return res.json({error:"تعليق فارغ"});
    if(text.length>300)return res.json({error:"طويل جدًا (الحد الأقصى 300)"});
    await Comments.create({profileId:req.params.id,authorId:req.session.user.id,text:text.trim().slice(0,300)});
    res.json({success:true});
  });

  /* ── API: صديق ─────────────────────────────────────────── */
  app.post("/api/friend/:id/:action",async(req,res)=>{
    if(!req.session.user)return res.json({error:"تسجيل الدخول مطلوب"});
    const me=req.session.user.id, target=req.params.id, action=req.params.action;
    if(me===target)return res.json({error:"لا يمكن إضافة نفسك كصديق"});
    let myF=await Friends.findOne({id:me}).catch(()=>null)||await Friends.create({id:me}).catch(()=>null);
    let thF=await Friends.findOne({id:target}).catch(()=>null)||await Friends.create({id:target}).catch(()=>null);
    if(!myF||!thF)return res.json({error:"خطأ في قاعدة البيانات"});
    const meUser = req.session.user;
    if(action==="add"){
      if(myF.friends.includes(target))return res.json({error:"أصدقاء بالفعل"});
      if(!thF.pending.includes(me)){ thF.pending.push(me); thF.markModified("pending"); await thF.save(); }
      if(!myF.sent.includes(target)){ myF.sent.push(target); myF.markModified("sent"); await myF.save(); }
      try{
        const tDUser = await fetchDiscordUser(target);
        if(tDUser){
          await tDUser.send(`💌 **طلب صداقة — دايموند كازينو**\n**${meUser.username}** أرسل لك طلب صداقة على موقع دايموند كازينو!\nقم بزيارة ملفه الشخصي: ${process.env.REPLIT_DEV_DOMAIN?`https://${process.env.REPLIT_DEV_DOMAIN}`:"http://fi11.bot-hosting.net:20407/"}/profile/${me}`).catch(()=>null);
        }
      }catch{}
      siteLog("👥 تم إرسال طلب صداقة", `**${meUser.username}** → <@${target}>\nمعرف المرسل: \`${me}\``, "#5865F2");
      return res.json({success:true,message:"تم إرسال طلب الصداقة!"});
    }
    if(action==="accept"){
      if(!myF.pending.includes(target))return res.json({error:"لا يوجد طلب"});
      myF.pending=myF.pending.filter(x=>x!==target); myF.friends.push(target); myF.markModified("pending","friends"); await myF.save();
      thF.sent=thF.sent.filter(x=>x!==me); thF.friends.push(me); thF.markModified("sent","friends"); await thF.save();
      siteLog("🤝 تم قبول طلب الصداقة", `**${meUser.username}** قبل طلب صداقة من <@${target}>`, "#57F287");
      return res.json({success:true,message:"تمت إضافة الأصدقاء!"});
    }
    if(action==="remove"){
      myF.friends=myF.friends.filter(x=>x!==target); myF.markModified("friends"); await myF.save();
      thF.friends=thF.friends.filter(x=>x!==me); thF.markModified("friends"); await thF.save();
      return res.json({success:true,message:"تمت إزالة الصديق"});
    }
    res.json({error:"إجراء غير معروف"});
  });

  /* ── API: تخصيص ──────────────────────────────────────── */
  app.post("/api/customize",async(req,res)=>{
    if(!req.session.user)return res.json({error:"تسجيل الدخول مطلوب"});
    const{theme,borderStyle,bio,profileBg}=req.body;
    const validBgs=["default","aurora","galaxy","sunset","neon","ocean","inferno","matrix"];
    await Customization.findOneAndUpdate({id:req.session.user.id},{theme:theme||"diamond",borderStyle:borderStyle||"default",bio:(bio||"").slice(0,200),profileBg:validBgs.includes(profileBg)?profileBg:"default"},{upsert:true});
    res.json({success:true,message:"تم تحديث الملف الشخصي!"});
  });

  /* ── واجهات برمجة التطبيقات الخاصة بالمشرف ──────────────────────────────────────────── */
  app.post("/admin/add-news",requireOwner,async(req,res)=>{
    const{title,body,tag,tagColor}=req.body;
    if(!title||!body)return res.json({error:"العنوان والمحتوى مطلوبان"});
    const news=loadNews();
    news.unshift({id:Date.now(),title:title.slice(0,120),body:body.slice(0,800),tag:tag||"تحديث",tagColor:tagColor||"#0ea5e9",date:new Date().toISOString().slice(0,10)});
    saveNews(news);
    res.json({success:true,message:"تم نشر الخبر!",reload:true});
  });

  app.delete("/admin/news/:id",requireOwner,(req,res)=>{
    const news=loadNews().filter(n=>String(n.id)!==req.params.id);
    saveNews(news);
    res.json({success:true,message:"تم حذف الخبر",reload:true});
  });

  app.post("/admin/reset-balance/:id",requireOwner,async(req,res)=>{
    const{amount}=req.body;
    await db.findOneAndUpdate({id:req.params.id},{coins:String(amount||0)});
    res.json({success:true,message:`تم إعادة تعيين الرصيد إلى ${amount||0}`});
  });

  app.post("/admin/reset-all",requireOwner,async(req,res)=>{
    await db.updateMany({},{coins:"0"});
    res.json({success:true,message:"تم إعادة تعيين جميع الأرصدة إلى 0!",reload:true});
  });

  app.delete("/admin/delete-user/:id",requireOwner,async(req,res)=>{
    await db.deleteOne({id:req.params.id});
    await inventory.deleteOne({id:req.params.id}).catch(()=>null);
    await mafiaPlayer.deleteOne({id:req.params.id}).catch(()=>null);
    res.json({success:true,message:"تم حذف المستخدم"});
  });

  app.delete("/admin/delete-all",requireOwner,async(req,res)=>{
    await db.deleteMany({});
    await inventory.deleteMany({});
    await mafiaPlayer.deleteMany({});
    res.json({success:true,message:"تم حذف جميع البيانات!",reload:true});
  });

  app.post("/admin/give-coins",requireOwner,async(req,res)=>{
    const{userId,amount}=req.body;
    if(!userId||!amount)return res.json({error:"حقول مفقودة"});
    const n=Number(amount);
    if(isNaN(n))return res.json({error:"مبلغ غير صالح"});
    let u=await db.findOne({id:userId});
    if(!u)u=await db.create({id:userId,coins:String(n),status_playing:"no"});
    else{ u.coins=String(Number(u.coins||0)+n); await u.save(); }
    res.json({success:true,message:`تم إعطاء ${fmt(n)} عملة إلى ${userId}`});
  });

  /* ══════════════════════════════════════════════════════════
     الصفحات
  ══════════════════════════════════════════════════════════ */

  /* ── الرئيسية ─────────────────────────────────────────────────── */
  app.get("/",async(req,res)=>{
    const user=req.session.user||null;
    const loginAlert=req.session.loginAlert; if(loginAlert)delete req.session.loginAlert;
    const { announcementBanner:announcement="" } = loadSettings();

    let totalPlayers=0,totalCoins=0,activePlayers=0;
    const all=await db.find({}).lean().catch(()=>[]);
    totalPlayers=all.length;
    totalCoins=all.reduce((s,u)=>s+Number(u.coins||0),0);
    activePlayers=all.filter(u=>u.status_playing==="yes").length;

    const top3=all.sort((a,b)=>Number(b.coins||0)-Number(a.coins||0)).slice(0,3);
    const news=loadNews().slice(0,3);

    const top3html=await Promise.all(top3.map(async(p,i)=>{
      const cached=await getCachedUser(p.id);
      const uname=cached?.username||`لاعب …${p.id.slice(-4)}`;
      const av=avatarUrl(p.id,cached?.avatar);
      const medals=["🥇","🥈","🥉"];
      const tier=getTier(p.coins);
      return `<tr class="lb-row">
        <td><span class="rank-badge rank-${i+1}">${medals[i]}</span></td>
        <td><a href="/profile/${p.id}" class="player-link">
          <img class="player-mini-avatar" src="${av}" onerror="this.src='https://cdn.discordapp.com/embed/avatars/0.png'">
          <span>${esc(uname)}</span>
        </a></td>
        <td style="color:var(--gold);font-family:Rajdhani,sans-serif;font-size:16px;font-weight:700">${fmt(p.coins)}</td>
        <td><span class="badge ${tier.class}">${tier.emoji} ${tier.label}</span></td>
      <tr>`;
    }));

    const newsHtml=news.map(n=>`
      <div class="news-card animate-slideUp" style="grid-column:auto">
        <span class="news-tag" style="background:${n.tagColor}22;color:${n.tagColor};border:1px solid ${n.tagColor}44">${esc(n.tag)}</span>
        <div class="news-title">${esc(n.title)}</div>
        <div class="news-body" style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${esc(n.body)}</div>
        <div class="news-footer"><span>📅 ${esc(n.date)}</span><a href="/news" style="color:var(--primary);font-size:11px">قراءة الكل →</a></div>
      </div>`).join("");

    res.send(layout("الرئيسية",`
      ${loginAlert?`<div class="alert alert-success" style="margin-bottom:16px">${esc(loginAlert)}</div>`:""}

      <div class="hero-banner animate-fadeIn">
        <img src="/luckbanner.png" alt="دايموند كازينو">
        <div class="hero-banner-overlay"></div>
        <div class="hero-banner-content">
          <div>
            <div class="hero-title">💎 دايموند كازينو</div>
            <div class="hero-sub">أكثر منصة قمار موثوقة — عدالة قابلة للإثبات، دائمًا</div>
          </div>
          ${user
            ?`<a href="/profile/${user.id}" class="btn btn-gold">ملفي الشخصي →</a>`
            :`<a href="/auth/discord" class="btn btn-discord">تسجيل الدخول بديسكورد</a>`}
        </div>
      </div>

      <div class="stats-grid">
        <div class="stat-card delay-1"><div class="sc-icon">👥</div><div class="sc-label">إجمالي اللاعبين</div><div class="sc-value blue" data-count="${totalPlayers}">${fmt(totalPlayers)}</div></div>
        <div class="stat-card delay-2"><div class="sc-icon">💰</div><div class="sc-label">العملات المتداولة</div><div class="sc-value gold" data-count="${totalCoins}">${fmt(totalCoins)}</div></div>
        <div class="stat-card delay-3"><div class="sc-icon">🎮</div><div class="sc-label">يلعبون الآن</div><div class="sc-value green" data-count="${activePlayers}">${fmt(activePlayers)}</div></div>
        <div class="stat-card delay-4"><div class="sc-icon">🏪</div><div class="sc-label">عناصر السوق</div><div class="sc-value purple" data-count="${BM_ITEMS?.length||10}">${BM_ITEMS?.length||10}</div></div>
      </div>

      <div class="grid-2">
        <div class="card card-glow">
          <div class="card-header"><span class="icon">🏆</span>أغنى 3 لاعبين <span class="live-dot" style="margin-left:auto">مباشر</span></div>
          <div class="table-wrap home-top3-wrap"><table>
            <thead><tr><th>#</th><th>اللاعب</th><th>الرصيد</th><th>الدرجة</th></tr></thead>
            <tbody>${top3html.join("")||'<tr><td colspan="4" style="text-align:center;padding:24px;color:var(--text3)">لا يوجد لاعبون</td></tr>'}</tbody>
          </table></div>
          <div style="margin-top:12px"><a href="/leaderboard" class="btn btn-ghost btn-sm" style="width:100%;justify-content:center">عرض لوحة المتصدرين كاملة →</a></div>
        </div>
        <div class="card card-glow">
          <div class="card-header"><span class="icon">📰</span>أحدث الأخبار</div>
          <div style="display:flex;flex-direction:column;gap:10px">${newsHtml||'<div class="empty-state"><div class="ei">📰</div><p>لا توجد أخبار بعد</p></div>'}</div>
          <div style="margin-top:12px"><a href="/news" class="btn btn-ghost btn-sm" style="width:100%;justify-content:center">كل الأخبار →</a></div>
        </div>
      </div>

      <div style="margin-top:20px">
        <div class="card-header" style="margin-bottom:14px"><span class="icon">⚡</span>المميزات</div>
        <div class="grid-4">
          ${[
            ["/leaderboard","🏆","المتصدرون","أغنى 100 لاعب مصنفين مباشر"],
            ["/stats","📊","إحصائيات الكازينو","لوحة تحكم إحصائيات الكازينو الكاملة"],
            ["/verify","🔐","العدالة القابلة للإثبات","تحقق من أي نتيجة لعبة تشفيريًا"],
            ["/market","🏪","السوق","تصفح جميع عناصر وعناصر السوق السوداء"],
            ["/mafia","🗺️","خريطة المافيا","السيطرة على الأراضي وتصنيفات العائلات"],
            ["/vip","⭐","منطقة VIP","ملفات تعريف اللاعبين المتميزين الحصرية"],
            ["/tickets","🎫","الدعم","فتح تذكرة دعم مع الموظفين"],
            ["/news","📰","أخبار الكازينو","أحدث التحديثات والأحداث"],
            ["/help","📚","مركز المساعدة","قواعد اللعبة والأدلة"],
          ].map(([href,ico,name,desc])=>`
            <a href="${href}" class="card" style="display:flex;align-items:center;gap:12px;text-decoration:none;padding:16px;transition:all 0.3s" onmouseover="this.style.borderColor='var(--border2)';this.style.transform='translateY(-2px)'" onmouseout="this.style.borderColor='var(--border)';this.style.transform=''">
              <span style="font-size:24px">${ico}</span>
              <div><div style="font-weight:600;font-size:13px;color:var(--text)">${name}</div><div style="font-size:11px;color:var(--text3);margin-top:2px">${desc}</div></div>
            </a>`).join("")}
        </div>
      </div>
    `,"/",user,null,"",announcement));
  });

  /* ── البحث ───────────────────────────────────────────────── */
  app.get("/search",async(req,res)=>{
    const user=req.session.user||null;
    const q=(req.query.q||"").trim();
    let results=[];

    if(q){
      const allDB=await db.find({}).lean().catch(()=>[]);
      const allCache=await UserCache.find({}).lean().catch(()=>[]);
      const cacheMap={};
      for(const c of allCache) cacheMap[c.id]=c;

      const ql=q.toLowerCase();
      const uncachedIds=allDB.filter(u=>!cacheMap[u.id]||!cacheMap[u.id].username).map(u=>u.id);
      if(uncachedIds.length>0){
        await Promise.all(uncachedIds.slice(0,40).map(async id=>{
          const dUser=await fetchDiscordUser(id);
          if(dUser){
            cacheMap[id]={id,username:dUser.username,avatar:dUser.avatar||""};
            await UserCache.findOneAndUpdate({id},{username:dUser.username,avatar:dUser.avatar||"",updatedAt:new Date()},{upsert:true}).catch(()=>null);
          }
        }));
      }

      for(const u of allDB){
        const cached=cacheMap[u.id];
        const uname=(cached?.username||"").toLowerCase();
        if(u.id===q||u.id.includes(q)||uname.includes(ql)){
          results.push({...u,username:cached?.username||null,avatar:cached?.avatar||null});
        }
        if(results.length>=20)break;
      }
    }

    const resultsHtml=results.map(r=>{
      const av=avatarUrl(r.id,r.avatar);
      const tier=getTier(r.coins);
      return `<a href="/profile/${r.id}" class="card" style="display:flex;align-items:center;gap:14px;text-decoration:none;margin-bottom:10px;transition:all 0.2s" onmouseover="this.style.borderColor='var(--border2)'" onmouseout="this.style.borderColor='var(--border)'">
        <img style="width:44px;height:44px;border-radius:50%;border:2px solid var(--primary)" src="${av}" onerror="this.src='https://cdn.discordapp.com/embed/avatars/0.png'">
        <div style="flex:1">
          <div style="font-weight:600;font-size:14px">${esc(r.username||`مستخدم …${r.id.slice(-4)}`)}</div>
          <div style="font-size:11px;color:var(--text3)">${r.id}</div>
        </div>
        <div style="text-align:right">
          <div style="font-family:Rajdhani,sans-serif;font-size:16px;font-weight:700;color:var(--gold)">${fmt(r.coins)}</div>
          <span class="badge ${tier.class}">${tier.emoji} ${tier.label}</span>
        </div>
      </a>`;
    }).join("");

    res.send(layout("بحث",`
      <div class="page-header"><h1>🔍 بحث عن لاعب</h1><p>ابحث بواسطة معرف ديسكورد أو اسم المستخدم</p></div>
      <div class="search-hero">
        <div style="font-size:48px;margin-bottom:12px;animation:float 3s ease-in-out infinite">🔍</div>
        <h2 style="font-family:Rajdhani,Cairo,sans-serif;font-size:24px;font-weight:700;margin-bottom:16px">ابحث عن أي لاعب</h2>
        <form onsubmit="doSearch(event)">
          <input class="search-big" id="searchInput" value="${esc(q)}" placeholder="أدخل معرف ديسكورد أو اسم المستخدم…" autofocus>
          <div style="margin-top:14px"><button type="submit" class="btn btn-primary btn-lg">بحث</button></div>
        </form>
      </div>
      ${q?`<div class="card"><div class="card-header"><span class="icon">📋</span>نتائج لـ "${esc(q)}" (${results.length})</div>${resultsHtml||'<div class="empty-state"><div class="ei">🔍</div><p>لم يتم العثور على لاعبين</p></div>'}</div>`:""}
    `,"/search",user));
  });

  /* ── الملف الشخصي ──────────────────────────────────────────────── */
  app.get("/profile/:id",async(req,res)=>{
    const user=req.session.user||null;
    const tid=req.params.id;
    const isMe=user&&user.id===tid;

    const [dbUser,mp,inv,custom,friends,comments,cached]= await Promise.all([
      db.findOne({id:tid}).lean().catch(()=>null),
      mafiaPlayer.findOne({id:tid}).lean().catch(()=>null),
      inventory.findOne({id:tid}).lean().catch(()=>null),
      Customization.findOne({id:tid}).lean().catch(()=>null),
      Friends.findOne({id:tid}).lean().catch(()=>null),
      Comments.find({profileId:tid}).sort({createdAt:-1}).limit(20).lean().catch(()=>[]),
      getCachedUser(tid),
    ]);

    let dUser=null;
    try{ if(discordClient) dUser=await discordClient.users.fetch(tid).catch(()=>null); }catch{}

    const av=avatarUrl(tid,dUser?.avatar||cached?.avatar);
    const uname=dUser?.username||cached?.username||`مستخدم …${tid.slice(-4)}`;

    const theme=custom?.theme||"diamond";
    const border=custom?.borderStyle||"default";
    const bio=custom?.bio||"";

    const coins=Number(dbUser?.coins||0);
    const wins=mp?.wins||0, losses=mp?.losses||0, draws=mp?.draws||0, challenges=mp?.challenges||0;
    const totalGames=wins+losses+draws;
    const winRate=totalGames>0?((wins/totalGames)*100).toFixed(1):"0.0";
    const tier=getTier(coins);
    const badges=getBadges(coins,mp,inv);

    // المخزون
    const now=Date.now();
    const activeItems=(inv?.items||[]).filter(i=>!i.expiresAt||now<=i.expiresAt);
    const grouped={};
    for(const it of activeItems){ if(!grouped[it.type])grouped[it.type]={...it,count:0}; grouped[it.type].count++; }
    const invItems=Object.values(grouped);

    // سجل المعاملات من PFT
    const pft=loadPFT();
    const myTx=Object.values(pft.sessions||{})
      .filter(s=>s.playerId===tid&&s.status==="closed")
      .sort((a,b)=>b.closedAt-a.closedAt).slice(0,50);

    // حل أسماء المستخدمين للخصوم
    const opponentIds=[...new Set(myTx.filter(s=>s.opponentId).map(s=>s.opponentId))];
    const opponentMap={};
    await Promise.all(opponentIds.map(async id=>{
      const u=await getOrFetchUser(id);
      opponentMap[id]=u?.username||`مستخدم…${id.slice(-4)}`;
    }));

    // التحقق من الأصدقاء
    let myFriends=null;
    if(user) myFriends=await Friends.findOne({id:user.id}).lean().catch(()=>null);
    const isFriend=myFriends?.friends?.includes(tid);
    const hasPending=myFriends?.sent?.includes(tid);
    const hasIncoming=myFriends?.pending?.includes(tid);

    // ذاكرة التخزين المؤقت لمؤلفي التعليقات
    const commentHtml=await Promise.all(comments.map(async c=>{
      const cCached=await getCachedUser(c.authorId);
      const cAv=avatarUrl(c.authorId,cCached?.avatar);
      const cName=cCached?.username||`مستخدم…${c.authorId.slice(-4)}`;
      return `<div class="comment-item">
        <a href="/profile/${c.authorId}"><img class="comment-avatar" src="${cAv}" onerror="this.src='https://cdn.discordapp.com/embed/avatars/0.png'"></a>
        <div class="comment-body">
          <div><a href="/profile/${c.authorId}" class="comment-author">${esc(cName)}</a></div>
          <div class="comment-text">${esc(c.text)}</div>
          <div class="comment-time">${timeAgo(c.createdAt?.getTime?.()||0)}</div>
        </div>
      </div>`;
    }));

    const txSessions=myTx.map((s,idx)=>{
      const oppName=s.opponentId?(opponentMap[s.opponentId]||`مستخدم…${s.opponentId.slice(-4)}`):null;
      const duration=s.startedAt&&s.closedAt?Math.round((s.closedAt-s.startedAt)/1000):null;
      return {idx,id:s.id,gameType:s.gameType||"لعبة",bet:s.bet,opponentId:s.opponentId||null,opponentName:oppName,resultText:s.resultText||"",roll:s.roll||"",nonce:s.nonce,serverSeedHash:s.serverSeedHash||"",hmac:s.hmac||"",startedAt:s.startedAt,closedAt:s.closedAt,duration};
    });
    const txHtml=txSessions.map(s=>{
      const resultLC=s.resultText.toLowerCase();
      let cls="tx-draw",icon="🤝",prefix="";
      if(resultLC.includes("فاز")||resultLC.includes("win")||resultLC.includes("won")){cls="tx-win";icon="✅";prefix="+";}
      else if(resultLC.includes("خسر")||resultLC.includes("lose")||resultLC.includes("lost")){cls="tx-lose";icon="❌";prefix="-";}
      const gLabel=s.gameType.replace("bot-","").replace("pvp-","").replace(/-/g," ");
      const vsType=s.opponentId?"👥 PvP":"🤖 بوت";
      return `<div class="tx-item ${cls}" onclick="openTxModal(${s.idx})" style="cursor:pointer">
        <div class="tx-icon">${icon}</div>
        <div class="tx-info">
          <div class="tx-title" style="text-transform:capitalize">${esc(gLabel)} <span style="font-size:10px;color:var(--text3)">${vsType}</span></div>
          <div class="tx-sub">ضد ${esc(s.opponentName||"البوت")}${s.duration?` · ${s.duration}ث`:""}</div>
        </div>
        <div style="text-align:right;flex-shrink:0">
          <div class="tx-amount">${prefix}${esc(String(s.bet))}</div>
          <div class="tx-time">${timeAgo(s.closedAt)}</div>
        </div>
        <div style="font-size:18px;color:var(--text3);margin-left:4px;flex-shrink:0">›</div>
      </div>`;
    }).join("") || '<div class="empty-state"><div class="ei">📋</div><p>لم يتم العثور على معاملات</p></div>';

    const invHtml=invItems.length?invItems.map(it=>`
      <div class="ability-card">
        <div class="ab-emoji">${esc(it.emoji||"🎁")}</div>
        <div class="ab-info">
          <div class="ab-name">${esc(it.name||it.type)}</div>
          ${it.expiresAt?`<span class="expires-badge">⏳ تنتهي ${timeAgo(it.expiresAt-Date.now())}</span>`:'<span style="font-size:10px;color:var(--green)">♾ دائم</span>'}
        </div>
        <div class="ab-count">×${it.count}</div>
      </div>`).join("")
      :`<div class="empty-state"><div class="ei">📦</div><p>المخزون فارغ</p></div>`;

    const friendBtn=!user||isMe?"":isFriend
      ?`<button class="btn btn-ghost btn-sm" onclick="friendAction('${tid}','remove')">👥 أصدقاء ✓</button>`
      :hasPending
        ?`<button class="btn btn-ghost btn-sm" disabled>⏳ تم إرسال الطلب</button>`
        :hasIncoming
          ?`<button class="btn btn-success btn-sm" onclick="friendAction('${tid}','accept')">✅ قبول الطلب</button>`
          :`<button class="btn btn-primary btn-sm" onclick="friendAction('${tid}','add')">➕ إضافة صديق</button>`;

    const friendsListIds=friends?.friends||[];
    const friendsHtml=friendsListIds.length?`<div style="display:flex;flex-wrap:wrap;gap:8px">
      ${(await Promise.all(friendsListIds.slice(0,8).map(async fid=>{
        const fc=await getCachedUser(fid);
        return `<a href="/profile/${fid}" style="display:flex;flex-direction:column;align-items:center;gap:4px;text-decoration:none;font-size:11px;color:var(--text2)">
          <img style="width:40px;height:40px;border-radius:50%;border:1px solid var(--border)" src="${avatarUrl(fid,fc?.avatar)}" onerror="this.src='https://cdn.discordapp.com/embed/avatars/0.png'">
          <span style="max-width:50px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(fc?.username||fid.slice(-4))}</span>
        </a>`;
      }))).join("")}
      ${friendsListIds.length>8?`<div style="font-size:11px;color:var(--text3);align-self:center">+${friendsListIds.length-8} المزيد</div>`:""}
    </div>`:`<div class="empty-state" style="padding:16px"><div class="ei" style="font-size:28px">👥</div><p>لا يوجد أصدقاء بعد</p></div>`;

    const profileBg=custom?.profileBg||"default";
    const bgPrimaryColor=custom?.bgPrimaryColor||"#0ea5e9";
    const bgTextColor=custom?.bgTextColor||"#ffffff";
    const bgAccentColor=custom?.bgAccentColor||"#8b5cf6";
    const txDataJson=JSON.stringify(txSessions).replace(/</g,"\\u003c").replace(/>/g,"\\u003e");
    
    const bgImageStyle = custom?.customBackground ? `background-image: url('/${path.basename(custom.customBackground)}'); background-size: cover; background-position: center;` : '';

    const customColorStyles = custom?.customBackground ? `
      <style>
        .profile-hero { --custom-primary: ${bgPrimaryColor}; --custom-text: ${bgTextColor}; --custom-accent: ${bgAccentColor}; }
        .profile-hero .profile-name { color: ${bgTextColor}; text-shadow: 0 2px 8px rgba(0,0,0,0.5); }
        .profile-hero .profile-uid { color: ${bgTextColor}; opacity: 0.95; text-shadow: 0 1px 4px rgba(0,0,0,0.5); }
        .profile-hero .profile-bio { color: ${bgTextColor}; opacity: 0.98; text-shadow: 0 1px 4px rgba(0,0,0,0.5); }
        .profile-header a, .profile-header button { color: ${bgTextColor}; }
        .profile-hero .btn-primary { background: ${bgPrimaryColor}; border-color: ${bgPrimaryColor}; color: ${bgTextColor}; }
        .profile-hero .btn-ghost { color: ${bgTextColor}; border-color: ${bgTextColor}; }
        .profile-hero .btn-ghost:hover { background: ${bgAccentColor}; border-color: ${bgAccentColor}; color: ${bgTextColor}; }
        
        /* Stats Section */
        .stats-grid { margin-top: 16px; }
        .stat-card { border: 2px solid ${bgPrimaryColor}; background: rgba(0,0,0,0.3) !important; color: ${bgTextColor}; }
        .sc-icon { color: ${bgPrimaryColor}; font-size: 24px; }
        .sc-label { color: ${bgTextColor}; opacity: 0.9; }
        .sc-value { color: ${bgPrimaryColor} !important; font-weight: bold; }
        
        /* Tabs Section */
        .tab-btn { color: ${bgTextColor}; border-color: ${bgAccentColor}; }
        .tab-btn.active { background: ${bgPrimaryColor}; border-color: ${bgPrimaryColor}; color: ${bgTextColor}; }
        
        /* Tier Badge */
        .tier-badge { box-shadow: 0 2px 8px rgba(0,0,0,0.3); }
        
        /* Profile Body */
        .profile-body { background: rgba(0,0,0,0.7); border: 1px solid ${bgAccentColor}44; }
      </style>
    ` : '';

    res.send(layout(`ملف ${uname} الشخصي`,`
      ${customColorStyles}
      <div class="profile-page-bg profile-page-bg-${esc(profileBg)}" style="${bgImageStyle}">
      <div class="profile-hero animate-slideUp">
        <div class="profile-banner theme-${esc(theme)}"></div>
        <div class="profile-body">
          <div class="profile-header">
            <div>
              <div class="profile-avatar-wrap">
                <img class="profile-avatar border-${esc(border)}" src="${av}" alt="الصورة الرمزية" id="profileAvatar"
                  onerror="this.src='https://cdn.discordapp.com/embed/avatars/0.png'">
              </div>
              <div class="profile-name">${esc(uname)}</div>
              <div class="profile-uid">معرف ديسكورد: ${esc(tid)} <button class="btn btn-ghost btn-sm" style="margin-left:6px" onclick="copyText('${esc(tid)}')">📋</button></div>
              ${bio?`<div class="profile-bio">"${esc(bio)}"</div>`:""}
              <div class="profile-badges">
                <span class="tier-badge" style="background:${tier.color}22;color:${tier.color};border:1px solid ${tier.color}44">${tier.emoji} ${tier.label}</span>
                ${badges.map(b=>`<span class="badge ${b.cls}">${b.emoji} ${esc(b.label)}</span>`).join("")}
              </div>
            </div>
            <div style="display:flex;flex-direction:column;gap:8px;align-items:flex-end">
              ${friendBtn}
              ${isMe?`<a href="/profile/${tid}/customize" class="btn btn-ghost btn-sm">🎨 تخصيص</a>`:""}
              <button class="btn btn-ghost btn-sm" onclick="copyText('https://'+location.host+'/profile/${esc(tid)}')">🔗 مشاركة</button>
            </div>
          </div>
        </div>
      </div>

      <div class="stats-grid">
        <div class="stat-card"><div class="sc-icon">💰</div><div class="sc-label">الرصيد</div><div class="sc-value gold">${fmt(coins)}</div></div>
        <div class="stat-card"><div class="sc-icon">🎯</div><div class="sc-label">نسبة الفوز</div><div class="sc-value ${Number(winRate)>=50?"green":"red"}">${winRate}%</div></div>
        <div class="stat-card"><div class="sc-icon">✅</div><div class="sc-label">الانتصارات</div><div class="sc-value green">${fmt(wins)}</div></div>
        <div class="stat-card"><div class="sc-icon">❌</div><div class="sc-label">الخسائر</div><div class="sc-value red">${fmt(losses)}</div></div>
        <div class="stat-card"><div class="sc-icon">🤝</div><div class="sc-label">التعادلات</div><div class="sc-value blue">${fmt(draws)}</div></div>
        <div class="stat-card"><div class="sc-icon">⚔️</div><div class="sc-label">التحديات</div><div class="sc-value purple">${fmt(challenges)}</div></div>
        <div class="stat-card"><div class="sc-icon">📈</div><div class="sc-label">إجمالي الأرباح</div><div class="sc-value gold">${fmt(mp?.totalEarned||0)}</div></div>
        <div class="stat-card"><div class="sc-icon">🎮</div><div class="sc-label">إجمالي الألعاب</div><div class="sc-value">${fmt(totalGames)}</div></div>
      </div>

      <div data-tabs>
        <div class="tabs">
          <button class="tab-btn active" data-tab="inventory">🎒 المخزون (${invItems.length})</button>
          <button class="tab-btn" data-tab="history">📋 السجل (${myTx.length})</button>
          <button class="tab-btn" data-tab="friends">👥 الأصدقاء (${friendsListIds.length})</button>
          <button class="tab-btn" data-tab="guestbook">💬 سجل الزوار (${comments.length})</button>
        </div>
        <div class="tab-panel active" data-panel="inventory">
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px">${invHtml}</div>
        </div>
        <div class="tab-panel" data-panel="history">${txHtml}</div>
        <div class="tab-panel" data-panel="friends">${friendsHtml}</div>
        <div class="tab-panel" data-panel="guestbook">
          ${user&&!isMe?`<form onsubmit="submitComment(event,'${tid}')" style="margin-bottom:16px;display:flex;gap:8px">
            <input id="commentInput" class="form-input" placeholder="اترك رسالة على هذا الملف الشخصي…" maxlength="300" style="flex:1">
            <button type="submit" class="btn btn-primary">نشر</button>
          </form>`:""}
          ${commentHtml.join("")||'<div class="empty-state"><div class="ei">💬</div><p>لا توجد تعليقات بعد — كن أول من يعلق!</p></div>'}
        </div>
      </div>
      </div>

      <!-- نافذة تفاصيل المعاملة -->
      <div class="modal-bg" id="txModal" onclick="if(event.target===this)closeModal('txModal')">
        <div class="modal-box" style="max-width:520px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
            <div class="modal-title" id="txModalTitle">تفاصيل اللعبة</div>
            <button class="btn btn-ghost btn-sm" onclick="closeModal('txModal')">✕</button>
          </div>
          <div id="txModalBody"></div>
        </div>
      </div>
      <script>
        const _txData=${txDataJson};
        function openTxModal(idx){
          const s=_txData[idx];
          if(!s)return;
          const rl=s.resultText.toLowerCase();
          let outcome="تعادل",oColor="var(--primary)",oIcon="🤝";
          if(rl.includes("فاز")||rl.includes("win")||rl.includes("won")){outcome="فوز";oColor="var(--green)";oIcon="✅";}
          else if(rl.includes("خسر")||rl.includes("lose")||rl.includes("lost")){outcome="خسارة";oColor="var(--red)";oIcon="❌";}
          const gLabel=(s.gameType||"لعبة").replace("bot-","").replace("pvp-","").replace(/-/g," ");
          const vsBot=!s.opponentId;
          const dur=s.duration?s.duration+"ث":"—";
          const started=s.startedAt?new Date(s.startedAt).toLocaleString():"—";
          document.getElementById('txModalTitle').innerHTML=oIcon+" "+gLabel.charAt(0).toUpperCase()+gLabel.slice(1);
          document.getElementById('txModalBody').innerHTML=\`
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px">
              <div style="background:var(--bg2);border-radius:8px;padding:12px;text-align:center">
                <div style="font-size:11px;color:var(--text3);margin-bottom:4px">النتيجة</div>
                <div style="font-size:18px;font-weight:700;color:\${oColor}">\${oIcon} \${outcome}</div>
              </div>
              <div style="background:var(--bg2);border-radius:8px;padding:12px;text-align:center">
                <div style="font-size:11px;color:var(--text3);margin-bottom:4px">مبلغ الرهان</div>
                <div style="font-size:18px;font-weight:700;color:var(--gold);font-family:Rajdhani,sans-serif">\${Number(s.bet||0).toLocaleString()}</div>
              </div>
              <div style="background:var(--bg2);border-radius:8px;padding:12px;text-align:center">
                <div style="font-size:11px;color:var(--text3);margin-bottom:4px">ضد</div>
                <div style="font-size:15px;font-weight:700">\${vsBot?"🤖 بوت":"👥 "+s.opponentName}</div>
              </div>
              <div style="background:var(--bg2);border-radius:8px;padding:12px;text-align:center">
                <div style="font-size:11px;color:var(--text3);margin-bottom:4px">المدة</div>
                <div style="font-size:15px;font-weight:700">\${dur}</div>
              </div>
            </div>
            <div style="background:var(--bg2);border-radius:8px;padding:12px;margin-bottom:10px">
              <div style="font-size:11px;color:var(--text3);margin-bottom:6px">نتيجة اللعبة</div>
              <div style="font-size:12px;color:var(--text2);line-height:1.6;white-space:pre-wrap">\${s.resultText.replace(/\\*\\*/g,"")}</div>
            </div>
            <div style="display:flex;flex-direction:column;gap:6px">
              <div style="display:flex;justify-content:space-between;font-size:12px;padding:6px 0;border-bottom:1px solid var(--border)"><span style="color:var(--text3)">🎲 رمي العدالة</span><span style="color:var(--gold);font-weight:700">\${s.roll||"—"}</span></div>
              <div style="display:flex;justify-content:space-between;font-size:12px;padding:6px 0;border-bottom:1px solid var(--border)"><span style="color:var(--text3)">🔢 العدد العشوائي</span><span style="font-family:monospace">\${s.nonce??'—'}</span></div>
              <div style="display:flex;justify-content:space-between;font-size:12px;padding:6px 0;border-bottom:1px solid var(--border)"><span style="color:var(--text3)">📅 وقت اللعب</span><span>\${started}</span></div>
              <div style="padding:6px 0">
                <div style="font-size:11px;color:var(--text3);margin-bottom:4px">🔐 تجزئة بذرة الخادم</div>
                <div style="font-family:monospace;font-size:10px;word-break:break-all;color:var(--primary);background:var(--bg2);padding:8px;border-radius:6px">\${s.serverSeedHash||"—"}</div>
              </div>
            </div>
          \`;
          openModal('txModal');
        }
      </script>
    `,"",user));
  });

  /* ── تخصيص الملف الشخصي ────────────────────────────────────── */
  app.get("/profile/:id/customize",async(req,res)=>{
    const user=req.session.user||null;
    if(!user||user.id!==req.params.id)return res.redirect(`/profile/${req.params.id}`);
    const custom=await Customization.findOne({id:user.id}).lean().catch(()=>null);
    const theme=custom?.theme||"diamond";
    const border=custom?.borderStyle||"default";
    const bio=custom?.bio||"";
    const profileBg=custom?.profileBg||"default";
    const av=avatarUrl(user.id,user.avatar);

    const themes=[
      {val:"diamond",label:"الماسي",bg:"linear-gradient(135deg,#0ea5e9,#8b5cf6,#f59e0b)"},
      {val:"fire",   label:"الناري",   bg:"linear-gradient(135deg,#ef4444,#f97316,#eab308)"},
      {val:"ocean",  label:"المحيط",  bg:"linear-gradient(135deg,#0ea5e9,#06b6d4,#14b8a6)"},
      {val:"forest", label:"الغابة", bg:"linear-gradient(135deg,#16a34a,#15803d,#84cc16)"},
      {val:"royal",  label:"الملكي",  bg:"linear-gradient(135deg,#7c3aed,#6d28d9,#f59e0b)"},
      {val:"mono",   label:"الأحادي",   bg:"linear-gradient(135deg,#1f2937,#374151,#4b5563)"},
      {val:"rose",   label:"الوردي",   bg:"linear-gradient(135deg,#ec4899,#f43f5e,#fb7185)"},
    ];
    const borders=[
      {val:"default",  label:"أزرق",  emoji:"🔵"},
      {val:"fire",     label:"ناري",  emoji:"🔴"},
      {val:"ice",      label:"جليدي",   emoji:"🧊"},
      {val:"gold",     label:"ذهبي",  emoji:"🟡"},
      {val:"royal",    label:"ملكي", emoji:"💜"},
      {val:"animated", label:"متوهج",  emoji:"✨"},
    ];
    const profileBgs=[
      {val:"default", label:"افتراضي",  preview:"linear-gradient(135deg,var(--bg),var(--bg2))",emoji:"⬛"},
      {val:"aurora",  label:"الشفق القطبي",   preview:"linear-gradient(135deg,#0ea5e9,#10b981,#8b5cf6)",emoji:"🌌"},
      {val:"galaxy",  label:"المجرة",   preview:"linear-gradient(135deg,#0f0c29,#302b63,#24243e)",emoji:"✨"},
      {val:"sunset",  label:"غروب الشمس",   preview:"linear-gradient(135deg,#f97316,#ec4899,#8b5cf6)",emoji:"🌅"},
      {val:"neon",    label:"نيون",     preview:"linear-gradient(135deg,#00ff88,#00b4d8,#ff006e)",emoji:"💡"},
      {val:"ocean",   label:"المحيط",    preview:"linear-gradient(135deg,#0ea5e9,#06b6d4,#0369a1)",emoji:"🌊"},
      {val:"inferno", label:"الجحيم",  preview:"linear-gradient(135deg,#ef4444,#f97316,#eab308)",emoji:"🔥"},
      {val:"matrix",  label:"ماتريكس",   preview:"linear-gradient(135deg,#052e16,#166534,#22c55e)",emoji:"💚"},
    ];

    res.send(layout("تخصيص الملف الشخصي",`
      <div class="page-header"><h1>🎨 تخصيص الملف الشخصي</h1><p>اجعل ملفك الشخصي فريدًا لك</p></div>
      <div class="grid-2">
        <div>
          <div class="card" style="margin-bottom:16px">
            <div class="card-header"><span class="icon">👁️</span>معاينة</div>
            <div style="border-radius:var(--radius);overflow:hidden;border:1px solid var(--border)" id="bgPreviewWrap">
              <div class="profile-banner theme-${esc(theme)}" id="previewBanner" style="height:80px"></div>
              <div style="background:var(--card2);padding:12px 16px;display:flex;align-items:center;gap:12px">
                <img class="profile-avatar border-${esc(border)}" id="previewAvatar" src="${av}"
                  style="width:56px;height:56px" onerror="this.src='https://cdn.discordapp.com/embed/avatars/0.png'">
                <div>
                  <div style="font-weight:700;font-size:14px">${esc(user.username)}</div>
                  <div style="font-size:11px;color:var(--text3)">${esc(user.id)}</div>
                  <div style="font-size:12px;color:var(--text2);margin-top:2px;font-style:italic" id="bioPreview">${bio?`"${esc(bio)}"`:""}</div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div>
          <form onsubmit="saveCustomize(event)" class="card">
            <div class="card-header"><span class="icon">🎨</span>الإعدادات</div>
            <input type="hidden" id="themeInput" name="theme" value="${esc(theme)}">
            <input type="hidden" id="borderInput" name="borderStyle" value="${esc(border)}">
            <input type="hidden" id="bgInput" name="profileBg" value="${esc(profileBg)}">

            <div class="form-group">
              <label>موضوع اللافتة</label>
              <div class="swatch-grid">
                ${themes.map(t=>`<div class="swatch ${t.val===theme?"selected":""}" data-group="theme" data-value="${t.val}" onclick="selectSwatch(this,'theme')" style="background:${t.bg}"><label>${t.label}</label></div>`).join("")}
              </div>
            </div>

            <div class="form-group">
              <label>🌈 خلفية الصفحة <span style="font-size:11px;color:var(--primary)">(متحركة)</span></label>
              <div class="swatch-grid" style="gap:8px">
                ${profileBgs.map(b=>`<div class="swatch ${b.val===profileBg?"selected":""}" data-group="bg" data-value="${b.val}" onclick="selectSwatch(this,'bg')" style="background:${b.preview};height:52px;position:relative">
                  <span style="position:absolute;top:4px;right:6px;font-size:14px">${b.emoji}</span>
                  <label style="font-size:9px">${b.label}</label>
                </div>`).join("")}
              </div>
            </div>

            <div class="form-group">
              <label>حدود الصورة الرمزية</label>
              <div class="swatch-grid">
                ${borders.map(b=>`<div class="border-swatch ${b.val===border?"selected":""}" data-group="border" data-value="${b.val}" onclick="selectSwatch(this,'border')">${b.emoji}<br><span style="font-size:9px;color:var(--text3)">${b.label}</span></div>`).join("")}
              </div>
            </div>

            <div class="form-group">
              <label>السيرة الذاتية (الحد الأقصى 200 حرف)</label>
              <textarea class="form-textarea" name="bio" maxlength="200" placeholder="قل شيئًا عن نفسك…" oninput="document.getElementById('bioPreview').textContent=this.value?'\"'+this.value+'\"':' '">${esc(bio)}</textarea>
            </div>

            <button type="submit" class="btn btn-primary" style="width:100%">💾 حفظ التغييرات</button>
          </form>
        </div>
      </div>
    `,"",user,`<script>
function saveCustomize(e){
  e.preventDefault();
  const data={theme:document.getElementById('themeInput').value,borderStyle:document.getElementById('borderInput').value,bio:e.target.bio.value,profileBg:document.getElementById('bgInput').value};
  fetch('/api/customize',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)})
    .then(r=>r.json()).then(d=>{if(d.success){showToast('تم الحفظ!','success');setTimeout(()=>location.href='/profile/${esc(req.params.id)}',1000);}else showToast(d.error,'error');});
}
</script>`));
  });

  /* ── لوحة المتصدرين ──────────────────────────────────────────── */
  app.get("/leaderboard",async(req,res)=>{
    const user=req.session.user||null;
    const top=await richSort(100);
    let totalCoins=0;
    for(const p of top) totalCoins+=Number(p.coins||0);

    const rows=await Promise.all(top.map(async(p,i)=>{
      const cached=await getOrFetchUser(p.id);
      const uname=cached?.username||`مستخدم …${p.id.slice(-4)}`;
      const av=avatarUrl(p.id,cached?.avatar);
      const tier=getTier(p.coins);
      const pct=totalCoins>0?((Number(p.coins)/totalCoins)*100).toFixed(1):0;
      let rankCell;
      if(i===0) rankCell=`<span class="rank-badge rank-1">🥇</span>`;
      else if(i===1) rankCell=`<span class="rank-badge rank-2">🥈</span>`;
      else if(i===2) rankCell=`<span class="rank-badge rank-3">🥉</span>`;
      else rankCell=`<span style="color:var(--text3);font-size:13px">#${i+1}</span>`;
      return `<tr class="lb-row">
        <td>${rankCell}</td>
        <td><a href="/profile/${p.id}" class="player-link">
          <img class="player-mini-avatar" src="${av}" onerror="this.src='https://cdn.discordapp.com/embed/avatars/0.png'">
          <div><div style="font-weight:600">${esc(uname)}</div><div style="font-size:10px;color:var(--text3)">${p.id}</div></div>
        </a></td>
        <td style="font-family:Rajdhani,sans-serif;font-size:16px;font-weight:700;color:var(--gold)">${fmt(p.coins)}</td>
        <td><span class="badge ${tier.class}">${tier.emoji} ${tier.label}</span></td>
        <td style="min-width:100px">
          <div class="progress-bar"><div class="progress-fill" style="width:${Math.min(pct,100)}%"></div></div>
          <div style="font-size:10px;color:var(--text3);margin-top:2px">${pct}%</div>
        </td>
        <td><a href="/profile/${p.id}" class="btn btn-ghost btn-sm">عرض</a></td>
      </table>`;
    }));

    res.send(layout("المتصدرون",`
      <div class="page-header">
        <h1>🏆 لوحة المتصدرين المباشرة</h1>
        <p>أغنى ${top.length} لاعبًا — <span class="live-dot">مباشر</span> — يتم التحديث تلقائيًا كل 60 ثانية</p>
      </div>
      <div class="stats-grid">
        <div class="stat-card"><div class="sc-icon">👑</div><div class="sc-label">أغنى لاعب</div><div class="sc-value gold">${top[0]?fmt(top[0].coins):"—"}</div></div>
        <div class="stat-card"><div class="sc-icon">👥</div><div class="sc-label">اللاعبون المصنفون</div><div class="sc-value blue">${top.length}</div></div>
        <div class="stat-card"><div class="sc-icon">💰</div><div class="sc-label">الإجمالي (أفضل 100)</div><div class="sc-value">${fmt(totalCoins)}</div></div>
      </div>
      <div class="card" data-live>
        <div class="card-header" style="justify-content:space-between">
          <span><span class="icon">🏆</span>التصنيفات</span>
          <button class="btn btn-ghost btn-sm" onclick="refreshLb()">🔄 تحديث</button>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>#</th><th>اللاعب</th><th>الرصيد</th><th>الدرجة</th><th>الحصة</th><th></th></tr></thead>
            <tbody>${rows.join("")||'<tr><td colspan="6" style="text-align:center;padding:32px;color:var(--text3)">لا يوجد لاعبون</td></tr>'}</tbody>
          </table>
        </div>
      </div>
    `,"/leaderboard",user));
  });

  /* ── التحقق من العدالة ────────────────────────────────────────── */
  app.get("/verify",async(req,res)=>{
    const user=req.session.user||null;
    let currentHash="";
    try{ const d=loadPFData(); currentHash=d.serverSeedHash||""; }catch{}
    res.send(layout("مدقق العدالة القابلة للإثبات",`
      <div class="page-header"><h1>🔐 مدقق العدالة القابلة للإثبات</h1><p>تحقق تشفيريًا من أن كل نتيجة لعبة كانت عادلة</p></div>
      <div class="grid-2" style="margin-bottom:20px">
        <div class="card"><div class="card-header"><span class="icon">🔐</span>كيف يعمل</div>
          <div style="font-size:13px;color:var(--text2);line-height:1.8">
            <p>قبل كل لعبة، يلتزم البوت بـ <strong style="color:var(--primary)">بذرة الخادم</strong> عن طريق نشر تجزئة SHA-256 الخاصة به — مما يضمن عدم إمكانية التلاعب بالنتيجة بعد وقوع الحدث.</p><br>
            <div style="background:var(--bg2);border-radius:8px;padding:12px;font-family:monospace;font-size:12px;color:var(--gold);border:1px solid var(--border)">HMAC-SHA256(بذرة الخادم, بذرة العميل:العدد العشوائي)</div><br>
            <p>بعد انتهاء اللعبة، يتم الكشف عن البذرة الحقيقية حتى تتمكن من التحقق من الرمية هنا.</p>
          </div>
        </div>
        <div class="card"><div class="card-header"><span class="icon">📊</span>تجزئة بذرة الخادم النشطة</div>
          <div style="font-size:13px">
            <div style="color:var(--text3);margin-bottom:8px;font-size:11px">التجزئة الملتزم بها حاليًا (تتغير مع كل دورة):</div>
            <div style="background:var(--bg2);padding:12px;border-radius:8px;font-family:monospace;font-size:11px;word-break:break-all;color:var(--gold);border:1px solid var(--border)">${esc(currentHash)||"غير متوفرة"}</div>
            <button class="btn btn-ghost btn-sm" style="margin-top:10px" onclick="copyText('${esc(currentHash)}')">📋 نسخ التجزئة</button>
          </div>
        </div>
      </div>
      <div class="verify-form">
        <div class="card-header"><span class="icon">🧮</span>تحقق من لعبة</div>
        <form onsubmit="verifyPF(event)" style="margin-top:12px">
          <div class="grid-2">
            <div class="form-group">
              <label>بذرة الخادم (يتم الكشف عنها بعد اللعبة)</label>
              <input id="serverSeed" class="form-input" placeholder="الصق بذرة الخادم المكشوفة…">
            </div>
            <div class="form-group">
              <label>بذرة العميل</label>
              <input id="clientSeed" class="form-input" placeholder="بذرة العميل الخاصة بك">
            </div>
          </div>
          <div class="form-group" style="max-width:200px">
            <label>العدد العشوائي</label>
            <input id="nonce" class="form-input" type="number" placeholder="0" min="0">
          </div>
          <button type="submit" class="btn btn-primary btn-lg">🔍 تحقق من النتيجة</button>
        </form>
        <div id="pfResult" style="margin-top:16px"></div>
      </div>
      <div class="card" style="margin-top:20px">
        <div class="card-header"><span class="icon">📋</span>خطوة بخطوة</div>
        <div style="display:flex;flex-direction:column;gap:10px">
          ${[["1","🎲","بدء لعبة على ديسكورد","يلتزم البوت بتجزئة بذرة الخادم — يتم نشرها قبل أي نتيجة"],["2","🔐","تشغيل اللعبة","النتيجة = HMAC-SHA256(بذرة الخادم, بذرة العميل:العدد العشوائي)"],["3","📢","انتهاء اللعبة","يتم الكشف عن بذرة الخادم الحقيقية في قناة سجل التحقق"],["4","✅","التحقق هنا","الصق البذور والعدد العشوائي — تأكد من تطابق الرمية مع نتيجة اللعبة"]].map(([n,i,t,d])=>`
          <div style="display:flex;gap:12px;padding:12px;background:var(--bg2);border-radius:8px;align-items:flex-start">
            <div style="width:28px;height:28px;border-radius:50%;background:rgba(14,165,233,0.12);color:var(--primary);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;flex-shrink:0">${n}</div>
            <div><div style="font-size:13px;font-weight:600;color:var(--text)">${i} ${t}</div><div style="font-size:12px;color:var(--text3);margin-top:3px">${d}</div></div>
          </div>`).join("")}
        </div>
      </div>
    `,"/verify",user));
  });

  /* ── السوق ──────────────────────────────────────────── */
  app.get("/market",async(req,res)=>{
    const user=req.session.user||null;
    let userInv=null;
    if(user) userInv=await inventory.findOne({id:user.id}).lean().catch(()=>null);
    const now=Date.now();
    const myItems=(userInv?.items||[]).filter(i=>!i.expiresAt||now<=i.expiresAt);
    const myGrouped={};
    for(const it of myItems){ if(!myGrouped[it.type])myGrouped[it.type]={...it,count:0}; myGrouped[it.type].count++; }

    const itemCards=(BM_ITEMS||[]).map((item,i)=>{
      const aType=ITEM_ABILITY_MAP[i]||null;
      const aDef=aType&&ABILITY_DEFS?ABILITY_DEFS[aType]:null;
      const [emoji,...rest]=item.name.split(" ");
      return `<div class="item-card delay-${(i%5)+1}">
        <div class="ie">${emoji}</div>
        <div class="iname">${esc(item.name)}</div>
        <div class="idesc">${esc(item.desc)}</div>
        <div class="iprice">💰 ${fmt(item.min)} — ${fmt(item.max)}</div>
        ${aDef?`<div class="item-ability-tag">${aDef.emoji} ${esc(aDef.name.split("—")[0].trim())}</div>`:""}
      </div>`;
    }).join("");

    const abilityCards=ABILITY_DEFS?Object.entries(ABILITY_DEFS).map(([type,def])=>{
      const owned=myGrouped[type];
      return `<div class="ability-card">
        <div class="ab-emoji">${def.emoji}</div>
        <div class="ab-info">
          <div class="ab-name">${esc(def.name.split("—")[0].trim())}</div>
          <div class="ab-desc">${esc((def.name.split("—")[1]||"").trim())}</div>
        </div>
        ${owned?`<div class="ab-count" style="background:rgba(16,185,129,0.12);color:var(--green)">✅ ×${owned.count}</div>`:``}
      </div>`;
    }).join(""):"";

    const myInvHtml=Object.values(myGrouped).length?Object.values(myGrouped).map(it=>`
      <div class="ability-card">
        <div class="ab-emoji">${esc(it.emoji||"🎁")}</div>
        <div class="ab-info">
          <div class="ab-name">${esc(it.name||it.type)}</div>
          ${it.expiresAt?`<span class="expires-badge">⏳ تنتهي ${timeAgo(it.expiresAt-now)}</span>`:'<span style="font-size:10px;color:var(--green)">♾ دائم</span>'}
        </div><div class="ab-count">×${it.count}</div>
      </div>`).join("")
      :`<div class="empty-state"><div class="ei">📦</div><p>${user?"المخزون فارغ — اربح عناصر من مزادات السوق السوداء!":"تسجيل الدخول لرؤية مخزونك"}</p></div>`;

    res.send(layout("السوق",`
      <div class="page-header"><h1>🏪 السوق والمخزون</h1><p>تصفح جميع عناصر السوق السوداء وقدراتها السرية</p></div>
      ${user?`<div class="card" style="margin-bottom:20px">
        <div class="card-header"><span class="icon">🎒</span>مخزونك (${Object.values(myGrouped).length} نوع)</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px">${myInvHtml}</div>
      </div>`:`<div class="alert alert-info" style="margin-bottom:16px">ℹ️ <a href="/auth/discord" style="color:var(--primary)">تسجيل الدخول بديسكورد</a> لعرض مخزونك الشخصي</div>`}
      <div class="card" style="margin-bottom:20px">
        <div class="card-header"><span class="icon">🏴‍☠️</span>عناصر السوق السوداء (${BM_ITEMS?.length||0})</div>
        <div style="color:var(--text3);font-size:13px;margin-bottom:16px">يخفي كل عنصر قدرة سرية يتم الكشف عنها فقط للفائز في المزاد!</div>
        <div class="grid-3">${itemCards}</div>
      </div>
      <div class="card">
        <div class="card-header"><span class="icon">⚡</span>جميع القدرات (${ABILITY_DEFS?Object.keys(ABILITY_DEFS).length:0})</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:10px">${abilityCards}</div>
      </div>
    `,"/market",user));
  });

  /* ── الأخبار ─────────────────────────────────────────────────── */
  app.get("/news",(req,res)=>{
    const user=req.session.user||null;
    const news=loadNews();
    const newsHtml=news.map(n=>`
      <div class="news-card">
        <span class="news-tag" style="background:${n.tagColor}22;color:${n.tagColor};border:1px solid ${n.tagColor}44">${esc(n.tag)}</span>
        <div class="news-title">${esc(n.title)}</div>
        <div class="news-body">${esc(n.body)}</div>
        <div class="news-footer">
          <span>📅 ${esc(n.date)}</span>
          ${isOwner(req)?`<button class="btn btn-danger btn-sm" onclick="adminAction('/admin/news/${n.id}','DELETE',null,'حذف هذا الخبر؟')">🗑️</button>`:""}
        </div>
      </div>`).join("");
    res.send(layout("أخبار الكازينو",`
      <div class="page-header"><h1>📰 أخبار الكازينو</h1><p>أحدث التحديثات والأحداث والإعلانات من دايموند كازينو</p></div>
      ${isOwner(req)?`<div class="card" style="margin-bottom:20px">
        <div class="card-header"><span class="icon">✏️</span>نشر خبر (للمشرف فقط)</div>
        <form onsubmit="postNews(event)">
          <div class="grid-2">
            <div class="form-group"><label>العنوان</label><input class="form-input" id="newsTitle" placeholder="عنوان الخبر…" maxlength="120"></div>
            <div class="form-group"><label>العلامة</label>
              <select class="form-select" id="newsTag">
                <option value="حدث" style="background:#e94560">حدث</option>
                <option value="تحديث">تحديث</option>
                <option value="لعبة">لعبة</option>
                <option value="أمان">أمان</option>
                <option value="إعلان">إعلان</option>
              </select>
            </div>
          </div>
          <div class="form-group"><label>المحتوى</label><textarea class="form-textarea" id="newsBody" placeholder="محتوى الخبر…" maxlength="800" style="min-height:100px"></textarea></div>
          <button type="submit" class="btn btn-primary">📢 نشر</button>
        </form>
      </div>
      <script>
      async function postNews(e){e.preventDefault();
        const title=document.getElementById('newsTitle').value;
        const body=document.getElementById('newsBody').value;
        const tag=document.getElementById('newsTag').value;
        const colors={'حدث':'#ef4444','تحديث':'#f59e0b','لعبة':'#10b981','أمان':'#8b5cf6','إعلان':'#0ea5e9'};
        await adminAction('/admin/add-news','POST',{title,body,tag,tagColor:colors[tag]||'#0ea5e9'},null);
      }
      </script>`:""}
      <div class="grid-3">${newsHtml||'<div class="empty-state" style="grid-column:1/-1"><div class="ei">📰</div><p>لا توجد أخبار بعد</p></div>'}</div>
    `,"/news",user));
  });

  /* ── VIP ──────────────────────────────────────────────────── */
  app.get("/vip",async(req,res)=>{
    const user=req.session.user||null;
    let vipMembers=[], guildName="خادم دايموند كازينو";
    try{
      if(discordClient&&GUILD_ID){
        const guild=discordClient.guilds.cache.get(GUILD_ID);
        if(guild){
          guildName=guild.name;
          await guild.members.fetch().catch(()=>{});
          const vipRoleIds=[SERVER_SETTINGS.roles.notify_500m_1billion,SERVER_SETTINGS.roles.notify_50_100_million].filter(Boolean);
          for(const[mid,member] of guild.members.cache){
            if(member.user.bot)continue;
            const hasVip=vipRoleIds.some(r=>member.roles.cache.has(r));
            if(!hasVip)continue;
            const du=await db.findOne({id:mid}).lean().catch(()=>null);
            const mp=await mafiaPlayer.findOne({id:mid}).lean().catch(()=>null);
            vipMembers.push({id:mid,username:member.user.username,avatar:member.user.avatar,coins:Number(du?.coins||0),wins:mp?.wins||0,losses:mp?.losses||0});
          }
          vipMembers.sort((a,b)=>b.coins-a.coins);
        }
      }
    }catch(e){console.error("VIP:",e.message);}

    const vipHtml=vipMembers.length?vipMembers.map((m,i)=>{
      const t=getTier(m.coins), total=m.wins+m.losses, wr=total?((m.wins/total)*100).toFixed(0):0;
      return `<a href="/profile/${m.id}" style="text-decoration:none"><div class="vip-card">
        <div style="font-family:Rajdhani,sans-serif;font-size:18px;font-weight:700;color:var(--gold);width:30px;flex-shrink:0">#${i+1}</div>
        <img class="vip-avatar" src="${avatarUrl(m.id,m.avatar)}" onerror="this.src='https://cdn.discordapp.com/embed/avatars/0.png'">
        <div style="flex:1;min-width:0">
          <div class="vip-name">${esc(m.username)}</div>
          <div class="vip-sub">${t.emoji} ${t.label} · نسبة الفوز ${wr}%</div>
        </div>
        <div class="vip-coins">${fmt(m.coins)}</div>
      </div></a>`;
    }).join(""):
    `<div class="empty-state" style="grid-column:1/-1"><div class="ei">⭐</div><p>يظهر أعضاء VIP بمجرد اتصال البوت بالخادم</p></div>`;

    res.send(layout("أعضاء VIP",`
      <div class="page-header"><h1>⭐ أعضاء VIP</h1><p>اللاعبين النخبة من ${esc(guildName)}</p></div>
      <div class="stats-grid" style="margin-bottom:20px">
        ${[["500M–1B","👑","#f59e0b"],["50M–100M","💎","#0ea5e9"],["10M–20M","🏆","#8b5cf6"],["1M–5M","🥇","#f59e0b"]].map(([label,ico,color])=>`
        <div class="stat-card"><div class="sc-icon">${ico}</div><div class="sc-label">${label}</div><div class="sc-value" style="font-size:18px;color:${color}">درجة VIP</div></div>`).join("")}
      </div>
      <div class="card">
        <div class="card-header"><span class="icon">⭐</span>لاعبي VIP (${vipMembers.length})</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px">${vipHtml}</div>
      </div>
    `,"/vip",user));
  });

  /* ── صفحة دوران شخصيات ريزيرو ──────────────────────────── */
  app.get("/rezero", async(req,res)=>{
    const settings = loadSettings();
    const { activeTheme } = getThemeContext(settings);
    if (activeTheme.spinPage !== "rezero") return res.redirect("/");
    const user = req.session.user||null;

    let userInv = null;
    let ownedChars = [];
    if(user){
      userInv = await inventory.findOne({id:user.id}).lean().catch(()=>null);
      if(userInv?.items){
        ownedChars = userInv.items.filter(it=>it.type?.startsWith("rezero_"));
      }
    }

    const charGallery = REZERO_CHARACTERS_SYNCED.map(c=>{
      const ownedCount = ownedChars.filter(it=>it.type===`rezero_${c.id}`).length;
      const imgHtml = c.img
        ? `<div class="rz-char-img-wrap"><img src="${c.img}" class="rz-char-img" alt="${esc(c.name)}" onerror="this.style.display='none';this.nextElementSibling.style.display='block'"><span class="rz-char-card-emoji" style="display:none;animation-delay:${Math.random()*3}s">${c.emoji}</span></div>`
        : `<div class="rz-char-img-wrap"><span class="rz-char-card-emoji" style="animation-delay:${Math.random()*3}s">${c.emoji}</span></div>`;
      return `<div class="rz-char-card animate-slideUp" style="background:${c.bg};border:1px solid ${c.color}33;--rz-accent:${c.color};--rz-glow:${c.glowColor};${ownedCount>0?`box-shadow:0 0 20px ${c.glowColor};border-color:${c.color}88;`:''}">
        ${ownedCount>0?`<div class="rz-inv-count">×${ownedCount}</div>`:""}
        ${imgHtml}
        <div class="rz-char-card-name" style="color:${c.color}">${esc(c.name)}</div>
        <div style="font-size:10px;color:#94a3b8;margin-top:3px;line-height:1.4">${esc(c.title)}</div>
        <span class="rz-char-rarity rz-rarity-${c.rarity}" style="margin-top:8px">${c.rarity === "legendary" ? "أسطوري" : c.rarity === "epic" ? "ملحمي" : c.rarity === "rare" ? "نادر" : "شائع"}</span>
        <div style="margin-top:10px;padding:8px;background:rgba(0,0,0,0.35);border-radius:10px;border:1px solid rgba(255,255,255,0.05)">
          <div class="rz-char-ability">⚡ ${esc(c.abilityName)}</div>
          <div class="rz-char-ability-desc">${esc(c.abilityDesc)}</div>
        </div>
      </div>`;
    }).join("");

    const inventorySection = user ? (()=>{
      if(!ownedChars.length) return `<div class="empty-state"><div class="ei">✨</div><p>لا توجد شخصيات ريزيرو بعد — قم بتدوير البوابة لاستدعائهم!</p></div>`;
      const grouped = {};
      for(const it of ownedChars){
        const cid = it.type.replace("rezero_","");
        if(!grouped[cid]) grouped[cid] = 0;
        grouped[cid]++;
      }
      return Object.entries(grouped).map(([cid,count])=>{
        const c = REZERO_CHARACTERS_SYNCED.find(x=>x.id===cid)||{name:cid,emoji:"❓",color:"#94a3b8",rarity:"common",abilityName:"غير معروف",abilityDesc:"",bg:"linear-gradient(135deg,#1a1a1a,#2a2a2a)",img:null};
        const imgHtml = c.img
          ? `<img src="${c.img}" class="rz-inv-img" alt="${esc(c.name)}" onerror="this.style.display='none';this.nextElementSibling.style.display='block'"><span style="font-size:36px;display:none;filter:drop-shadow(0 0 8px ${c.color})">${c.emoji}</span>`
          : `<span style="font-size:36px;display:block;filter:drop-shadow(0 0 8px ${c.color})">${c.emoji}</span>`;
        return `<div class="rz-inv-card" style="background:${c.bg};border-color:${c.color}33;--rz-glow:${c.glowColor||'rgba(139,92,246,0.3)'}">
          <div class="rz-inv-count">×${count}</div>
          <div style="margin-bottom:8px">${imgHtml}</div>
          <div style="font-weight:700;font-size:13px;color:${c.color}">${esc(c.name)}</div>
          <span class="rz-char-rarity rz-rarity-${c.rarity}" style="margin-top:6px">${c.rarity === "legendary" ? "أسطوري" : c.rarity === "epic" ? "ملحمي" : c.rarity === "rare" ? "نادر" : "شائع"}</span>
          <div style="font-size:11px;color:#a78bfa;margin-top:6px">⚡ ${esc(c.abilityName)}</div>
        </div>`;
      }).join("");
    })() : `<div class="empty-state"><div class="ei">🔐</div><p>تسجيل الدخول لرؤية مجموعتك</p></div>`;

    res.send(layout("ريزيرو — دوران الشخصيات", `
      <!-- لافتة ريزيرو البطولية -->
      <div class="rz-hero animate-fadeIn">
        <div class="rz-hero-butterflies" id="rzButterflies"></div>
        <div class="rz-hero-char-row">
          <div class="rz-hero-char-img" style="--rz-delay:0.2s"><img src="/rz_rem.png" alt="ريم" onerror="this.parentElement.style.display='none'"></div>
          <div class="rz-hero-char-img rz-hero-char-center" style="--rz-delay:0s"><img src="/rz_emilia.png" alt="إميليا" onerror="this.parentElement.style.display='none'"></div>
          <div class="rz-hero-char-img" style="--rz-delay:0.3s"><img src="/rz_subaru.png" alt="سوبارو" onerror="this.parentElement.style.display='none'"></div>
        </div>
        <div class="rz-hero-logo">ريزيرو</div>
        <div class="rz-hero-title">بدء الحياة في عالم آخر</div>
        <div class="rz-hero-sub">قم بتدوير البوابة — استدع شخصيات من عالم آخر إلى مجموعتك</div>
        <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:20px;position:relative;z-index:2">
          <div class="rz-rate-pill" style="background:rgba(220,38,38,0.15);color:#fca5a5;border:1px solid rgba(220,38,38,0.3)">🔥 أسطوري — 5%</div>
          <div class="rz-rate-pill" style="background:rgba(139,92,246,0.15);color:#c4b5fd;border:1px solid rgba(139,92,246,0.3)">💜 ملحمي — 20%</div>
          <div class="rz-rate-pill" style="background:rgba(59,130,246,0.15);color:#93c5fd;border:1px solid rgba(59,130,246,0.3)">💙 نادر — 35%</div>
          <div class="rz-rate-pill" style="background:rgba(100,116,139,0.15);color:#94a3b8;border:1px solid rgba(100,116,139,0.3)">⬛ شائع — 40%</div>
        </div>
      </div>

      <!-- بوابة الدوران -->
      <div class="rz-spin-section animate-slideUp">
        <div style="text-align:center;position:relative;z-index:1">
          <div style="font-family:Rajdhani,sans-serif;font-size:24px;font-weight:700;color:#c4b5fd;margin-bottom:4px;letter-spacing:2px;text-transform:uppercase">بوابة الاستدعاء</div>
          <div style="font-size:13px;color:#7c3aed88">المس البوابة للعبور بين العوالم — <strong style="color:#a78bfa">مجاني تمامًا</strong></div>
        </div>
        <div class="rz-portal-wrap" style="position:relative;z-index:1">
          <div class="rz-portal-wave"></div>
          <div class="rz-portal-wave" style="animation-delay:0.7s"></div>
          <div class="rz-portal-ring"></div>
          <div class="rz-portal-ring"></div>
          <div class="rz-portal-ring"></div>
          <div class="rz-portal-inner" id="rzPortalBtn" onclick="doRzSpin()">
            <div class="rz-portal-eye">👁</div>
          </div>
        </div>
        <div class="rz-spin-btns" style="position:relative;z-index:1">
          ${user ? (ownedChars.length > 0 ?
            `<button class="rz-btn-spin rz-btn-spin-1" disabled style="opacity:0.45;cursor:not-allowed;filter:grayscale(0.5)">
              🔒 تم الاستدعاء بالفعل — دورة واحدة لكل لاعب
            </button>
            <div style="font-size:13px;color:#7c3aed88;text-align:center;margin-top:8px">استخدم <code style="background:rgba(124,58,237,0.2);padding:2px 8px;border-radius:6px;color:#c4b5fd">!use &lt;character&gt;</code> في ديسكورد لتفعيل القدرات</div>` :
            `<button class="rz-btn-spin rz-btn-spin-1" onclick="doRzSpin()" id="rzBtn1">
              ✨ استدعاء — مجاني (مرة واحدة فقط)
            </button>`)
          : `<a href="/auth/discord" class="rz-btn-spin rz-btn-spin-1">🎮 تسجيل الدخول للاستدعاء</a>`}
        </div>
        ${user && ownedChars.length === 0 ? `<div style="font-size:12px;color:#4c1d95;position:relative;z-index:1;text-align:center">⚠️ تحصل على <strong style="color:#a78bfa">دورة مجانية واحدة فقط</strong> — اختر وقتك بحكمة!</div>` : ""}
        ${user && ownedChars.length > 0 ? `<div style="font-size:12px;color:#6d28d9;position:relative;z-index:1;text-align:center">💜 تمنح الشخصيات قدرات في جميع ألعاب الكازينو — استخدم <code style="color:#c4b5fd">!use &lt;name&gt;</code> في ديسكورد</div>` : ""}
      </div>

      <!-- المجموعة -->
      <div class="card animate-slideUp" style="margin-bottom:24px">
        <div class="card-header"><span class="icon">🗃️</span>مجموعتك ${user?`<span style="font-size:12px;color:var(--text3);font-weight:400;margin-left:6px">(${ownedChars.length} إجمالاً)</span>`:""}
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:12px;margin-top:4px">
          ${inventorySection}
        </div>
      </div>

      <!-- معرض الشخصيات -->
      <div class="card animate-slideUp">
        <div class="card-header"><span class="icon">📖</span>جميع الشخصيات — من يمكنك استدعاؤه؟</div>
        <div class="rz-char-grid" style="margin-top:12px">
          ${charGallery}
        </div>
      </div>

      <!-- تراكب دوران آلة القمار -->
      <div class="rz-spinner-overlay" id="rzSpinnerOverlay">
        <div class="rz-spinner-box">
          <div style="font-family:Rajdhani,sans-serif;font-size:22px;font-weight:700;color:#c4b5fd;letter-spacing:3px;text-transform:uppercase;margin-bottom:16px;animation:rzLogoGlow 1s ease-in-out infinite">⚔️ عبور العوالم...</div>
          <div class="rz-slot-window">
            <div class="rz-slot-track" id="rzSlotTrack"></div>
            <div class="rz-slot-highlight"></div>
          </div>
          <div style="margin-top:18px;font-size:13px;color:#7c3aed;animation:pulse 1s ease-in-out infinite">بوابة بين العوالم تفتح...</div>
        </div>
      </div>

      <!-- تراكب النتيجة -->
      <div class="rz-result-overlay" id="rzResultOverlay">
        <div style="width:100%;max-width:960px;display:flex;flex-direction:column;align-items:center;gap:16px">
          <div class="rz-result-title" id="rzResultTitle">✨ تم الاستدعاء!</div>
          <div class="rz-result-cards" id="rzResultCards"></div>
        </div>
        <button class="rz-result-close" onclick="closeRzResult()">🌀 متابعة</button>
      </div>

      <script>
      const RZ_CHARS = ${JSON.stringify(REZERO_CHARACTERS_SYNCED)};
      function closeRzResult(){
        document.getElementById('rzResultOverlay').classList.remove('open');
        document.getElementById('rzResultCards').innerHTML='';
      }
      async function doRzSpin(){
        const btn1 = document.getElementById('rzBtn1');
        const portal = document.getElementById('rzPortalBtn');
        if(btn1) btn1.disabled=true;
        if(portal) portal.classList.add('spinning');

        // بدء رسوم متحركة لدوران آلة القمار على البوابة
        const eye = portal?.querySelector('.rz-portal-eye');
        const allEmojis = RZ_CHARS.map(c=>c.emoji);
        let spinFrame=0, spinInterval=null;
        if(eye){
          spinInterval = setInterval(()=>{
            eye.textContent = allEmojis[spinFrame % allEmojis.length];
            spinFrame++;
          }, 80);
        }

        // إظهار تراكب الدوار
        const spinnerOverlay = document.getElementById('rzSpinnerOverlay');
        if(spinnerOverlay) spinnerOverlay.classList.add('open');

        // التنقل عبر بطاقات الشخصيات في الدوار
        const slotTrack = document.getElementById('rzSlotTrack');
        let slotFrame=0, slotInterval=null;
        if(slotTrack){
          slotTrack.innerHTML='';
          const bigPool = [...RZ_CHARS,...RZ_CHARS,...RZ_CHARS,...RZ_CHARS];
          bigPool.forEach(c=>{
            const el=document.createElement('div');
            el.className='rz-slot-card';
            el.style.cssText=\`background:\${c.bg};border:1px solid \${c.color}55\`;
            el.innerHTML=\`<span style="font-size:28px">\${c.emoji}</span><div style="font-size:10px;color:\${c.color};margin-top:4px;font-weight:700">\${c.name}</div>\`;
            slotTrack.appendChild(el);
          });
          let offset=0;
          const cardH=92;
          slotInterval=setInterval(()=>{
            offset = (offset + cardH*0.35) % (cardH*bigPool.length);
            slotTrack.style.transform=\`translateY(-\${offset}px)\`;
          },16);
        }

        try{
          const r = await fetch('/api/rezero/spin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({count:1})});
          const data = await r.json();

          // إيقاف الدوار بعد توقف درامي
          await new Promise(res=>setTimeout(res,2400));
          clearInterval(spinInterval);
          clearInterval(slotInterval);
          if(spinnerOverlay) spinnerOverlay.classList.remove('open');
          if(portal) portal.classList.remove('spinning');
          if(eye) eye.textContent='👁';

          if(!r.ok){ showToast(data.error||'فشل الدوران','error'); if(btn1){btn1.disabled=false;} return; }
          showRzResults(data.characters);
          setTimeout(()=>location.reload(), 4500);
        } catch(e){
          clearInterval(spinInterval);
          clearInterval(slotInterval);
          if(spinnerOverlay) spinnerOverlay.classList.remove('open');
          if(portal) portal.classList.remove('spinning');
          if(eye) eye.textContent='👁';
          showToast('خطأ في الشبكة','error');
          if(btn1) btn1.disabled=false;
        }
      }
      function showRzResults(chars){
        const container = document.getElementById('rzResultCards');
        const overlay = document.getElementById('rzResultOverlay');
        const titleEl = document.getElementById('rzResultTitle');
        const hasLegendary = chars.some(c=>c.rarity==='legendary');
        const hasEpic = chars.some(c=>c.rarity==='epic');
        titleEl.textContent = hasLegendary ? '🔥 استدعاء أسطوري!' : hasEpic ? '💜 استدعاء ملحمي!' : '✨ تم الاستدعاء!';
        titleEl.style.color = hasLegendary ? '#fca5a5' : hasEpic ? '#c4b5fd' : '#f5f3ff';
        if(hasLegendary) titleEl.style.textShadow = '0 0 30px rgba(220,38,38,0.8)';
        container.innerHTML = '';
        chars.forEach((c, i) => {
          const card = document.createElement('div');
          card.className = 'rz-result-card';
          card.style.cssText = \`background:\${c.bg};border:2px solid \${c.color}66;--rz-glow:\${c.glowColor};animation-delay:\${i*0.12}s\`;
          const imgHtml = c.img ? \`<img src="\${c.img}" class="rz-result-char-img" alt="\${c.name}" onerror="this.style.display='none';this.nextElementSibling.style.display='block'"><span class="rz-char-emoji" style="display:none">\${c.emoji}</span>\` : \`<span class="rz-char-emoji">\${c.emoji}</span>\`;
          card.innerHTML = \`
            \${imgHtml}
            <div class="rz-char-name">\${c.name}</div>
            <div class="rz-char-title">\${c.title}</div>
            <span class="rz-char-rarity rz-rarity-\${c.rarity}">\${c.rarity === "legendary" ? "أسطوري" : c.rarity === "epic" ? "ملحمي" : c.rarity === "rare" ? "نادر" : "شائع"}</span>
            <div class="rz-char-ability">⚡ \${c.abilityName}</div>
            <div class="rz-char-ability-desc">\${c.abilityDesc}</div>
          \`;
          container.appendChild(card);
          if(c.rarity==='legendary'||c.rarity==='epic') spawnStars(card);
        });
        overlay.classList.add('open');
        SoundEngine && (hasLegendary ? SoundEngine.jackpot() : hasEpic ? SoundEngine.success() : SoundEngine.coin());
      }
      function spawnStars(parent){
        for(let i=0;i<10;i++){
          const s=document.createElement('div');
          s.style.cssText = \`position:absolute;font-size:\${10+Math.random()*14}px;left:\${Math.random()*100}%;top:\${Math.random()*80}%;animation:rzStarBurst 1.4s ease-out \${Math.random()*0.6}s both;pointer-events:none;z-index:10\`;
          s.textContent=['🦋','✨','💫','🌟','⭐'][Math.floor(Math.random()*5)];
          parent.appendChild(s);
        }
      }
      // ظهور زخارف الفراشات في البطل
      (function(){
        const cont = document.getElementById('rzButterflies');
        if(!cont) return;
        const icons = ['🦋','🦋','✨','🦋','💜','🦋','✨','🦋','❄️','🦋'];
        icons.forEach((ic,i)=>{
          const el = document.createElement('div');
          el.className='rz-butterfly';
          el.textContent=ic;
          el.style.cssText=\`left:\${5+i*9}%;top:\${5+Math.random()*80}%;animation-delay:\${i*0.7}s;animation-duration:\${5+Math.random()*4}s;font-size:\${12+Math.random()*12}px\`;
          cont.appendChild(el);
        });
      })();
      </script>
    `, "/rezero", user));
  });

  app.get("/chainsaw", async(req,res)=>{
    const settings = loadSettings();
    const { activeTheme } = getThemeContext(settings);
    if (activeTheme.spinPage !== "chainsaw") return res.redirect("/");
    const user = req.session.user||null;
    const ownerId = SERVER_SETTINGS?.users?.ownerId || "OWNER_ID";
    res.send(layout("تشينسو مان — ريزي", `
      <div class="cm-hero card animate-slideUp">
        <div class="cm-badge">🪚 سمة تشينسو مان</div>
        <h1>ريزي</h1>
        <p>الشخصية الرئيسية: ريزي</p>
        <div class="cm-reze">💣</div>
      </div>
      <div class="card animate-slideUp">
        <div class="card-header"><span class="icon">💳</span>تعليمات الشحن</div>
        <p style="color:var(--text2);margin:0 0 10px">اكتب <code>شحن</code> في ديسكورد وستتلقى صيغة الرسالة الخاصة:</p>
        <pre style="background:var(--bg2);padding:12px;border-radius:10px;border:1px solid var(--border);margin:0">#credit ${esc(ownerId)} المبلغ</pre>
      </div>
    `, "/chainsaw", user));
  });

  /* ── API دوران ريزيرو ─────────────────────────────────────── */
  app.post("/api/rezero/spin", requireLogin, siteRateLimit(20), async(req,res)=>{
    const user = req.session.user;
    const settings = loadSettings();
    const { activeTheme } = getThemeContext(settings);
    if (activeTheme.spinPage !== "rezero") return res.status(403).json({error:"دولاب ريزيرو غير مفعل في الثيم الحالي"});
    try{
      // دورة واحدة لكل مستخدم — تحقق مما إذا كان المستخدم يمتلك أي شخصيات ريزيرو بالفعل
      let inv = await inventory.findOne({id:user.id});
      const alreadySpun = inv?.items?.some(i=>i.type?.startsWith("rezero_"));
      if(alreadySpun){
        return res.status(400).json({error:"لقد قمت بالفعل باستدعاء شخصياتك من ريزيرو! كل لاعب يحصل على دورة واحدة فقط."});
      }
      // اختر شخصية واحدة (دورة واحدة فقط — مجانية)
      const pulled = [pickRzCharacter()];
      // أضف إلى المخزون
      if(!inv){ inv = new inventory({id:user.id,items:[]}); }
      for(const c of pulled){
        inv.items.push({ type:`rezero_${c.id}`, name:c.name, ability:c.ability, rarity:c.rarity, obtainedAt:Date.now() });
      }
      await inv.save();
      const legendaryPull = pulled.filter(c=>c.rarity==="legendary");
      if(legendaryPull.length>0) siteLog("⚔️ سحب ريزيرو أسطوري",`**${user.username}** سحب أسطوري: ${legendaryPull.map(c=>c.name).join(", ")}!`,"#7c3aed").catch(()=>{});
      res.json({ characters: pulled });
    }catch(e){
      console.error("[دوران ريزيرو]",e);
      res.status(500).json({error:"خطأ في الخادم أثناء الدوران"});
    }
  });

  /* ── إعادة تعيين جميع شخصيات ريزيرو بواسطة المشرف ───────────────────── */
  app.post("/admin/rezero/reset-all", requireOwner, async(req,res)=>{
    try{
      const result = await inventory.updateMany(
        { "items.type": { $regex: /^rezero_/ } },
        { $pull: { items: { type: { $regex: /^rezero_/ } } } }
      );
      siteLog("⚔️ إعادة تعيين ريزيرو","قام المالك بإعادة تعيين ALL مجموعات شخصيات ريزيرو","#dc2626").catch(()=>{});
      res.json({ success:true, message:`تم مسح شخصيات ريزيرو من ${result.modifiedCount} لاعب` });
    }catch(e){
      console.error("[إعادة تعيين ريزيرو]",e);
      res.status(500).json({error:"خطأ في الخادم"});
    }
  });

  /* ── مركز المساعدة ──────────────────────────────────────────── */
  app.get("/help",(req,res)=>{
    const user=req.session.user||null;
    const games=[
      {title:"🎲 لعبة النرد",ar:"لعبة النرد",body:"تحدى البوت أو لاعب آخر برمي النرد. أعلى رقم يفوز. استخدم `!dice <amount>` للعب ضد البوت، أو `!dice <amount> @player` لـ PvP."},
      {title:"🪙 رمي العملة",ar:"رمي العملة",body:"اقلب عملة — رأس أو كتابة. فرصة 50/50. استخدم `!coin <amount>` واختر جانبك. يقرر البوت النتيجة باستخدام نظام العدالة القابلة للإثبات."},
      {title:"❌⭕ XO (تيك تاك تو)",ar:"إكس أو",body:"تيك تاك تو الكلاسيكية ضد البوت. استخدم `!xo <amount>` للبدء. تفاعل مع أرقام الشبكة لوضع علامتك. 3 في صف يفوز!"},
      {title:"📊 تقريبي (تخمين الرقم)",ar:"الرقم التقريبي",body:"خمن رقمًا بين 1-100. أقرب لاعب يفوز. استخدم `!takribi <amount>` ضد البوت أو `!takribi <amount> @player` لـ PvP."},
      {title:"🃏 بلاك جاك",ar:"بلاك جاك",body:"اقترب من 21 قدر الإمكان دون تجاوزه. اهزم يد الموزع. استخدم `!blackjack <amount>`. اضغط أو توقف باستخدام أزرار التفاعل."},
      {title:"🧠 مطابقة الذاكرة",ar:"مطابقة الذاكرة",body:"لعبة PvP — اقلب البطاقات للعثور على أزواج متطابقة. أكبر عدد من الأزواج يفوز. استخدم `!memory <amount> @player`. تناوب على قلب بطاقتين لكل جولة."},
      {title:"🤝 تقاسم أو سرقة",ar:"تقاسم أو سرقة",body:"يختار كلا اللاعبين سرًا: تقاسم (تقسيم الجائزة بالتساوي) أو سرقة (أخذ كل شيء إذا قاسم الخصم). استخدم `!splitsteal <amount> @player`."},
      {title:"💣 مباراة الألغام",ar:"حقل الألغام",body:"لعبة PvP في حقل الألغام. يتناوب اللاعبون في النقر على البلاط — اضرب لغماً وتخسر. استخدم `!minesduel <amount> @player`. يمكن لقدرة تحويل القنبلة إعادة توجيه لغم!"},
      {title:"🔫 الروليت الروسي",ar:"الروليت الروسي",body:"روليت PvP — رصاصة واحدة في 6 تجاويف. يتناوب اللاعبون في سحب الزناد. آخر لاعب يقف يفوز بكل شيء. استخدم `!roulette <amount> @player`."},
      {title:"🃏 البوكر",ar:"البوكر",body:"تكساس هولدم بوكر PvP. أفضل يد من 5 بطاقات تفوز. استخدم `!poker <amount> @player`. راهن، انسحب، أو اتبع باستخدام الأزرار. يدعم: Royal Flush، Straight، Full House، إلخ."},
      {title:"🏴‍☠️ مزاد السوق السوداء",ar:"السوق السوداء",body:"مزاد لعناصر غامضة نادرة. يخفي كل عنصر قدرة سرية. راهن بالعملات للفوز. إذا فزت، اختر الاحتفاظ بالقدرة أو بيعها مرة أخرى. يستخدم الأمر `!bm`."},
      {title:"⚡ نظام القدرات",ar:"نظام القدرات",body:"اربح قدرات من مزادات السوق السوداء. يتم تفعيلها تلقائيًا أثناء الألعاب: العملة المحظوظة تضمن الفوز بلعبة البوت، درع الحظ يمتص خسارة واحدة، شفرة السرقة تزيل الضرائب لمدة 24 ساعة، والمزيد!"},
    ];
    const faq=[
      {q:"كيف تعمل العدالة القابلة للإثبات؟",q_ar:"كيف يعمل نظام التحقق؟",a:"قبل كل لعبة، يلتزم البوت ببذرة خادم (يُظهر تجزئتها). بعد اللعبة، يتم الكشف عن البذرة الحقيقية حتى تتمكن من التحقق من النتيجة بنفسك باستخدام أداة التحقق الخاصة بنا."},
      {q:"كيف أسحب عملاتي؟",q_ar:"كيف أسحب عملاتي؟",a:"استخدم `!withdraw <amount>` في الخادم. سيتم إنشاء تذكرة وسيقوم مسؤول السحب بمعالجتها. قد تنطبق الحد الأدنى من المبالغ والرسوم."},
      {q:"ما هي نسبة الضريبة؟",q_ar:"ما هي نسبة الضريبة؟",a:"معدل الضريبة الافتراضي هو 4%. يمكنك تقليله باستخدام درع الضريبة (تخفيض 50% لمدة 3 ساعات) أو إزالته تمامًا باستخدام شفرة السرقة (24 ساعة)."},
      {q:"كيف أنضم إلى عائلة مافيا؟",q_ar:"كيف أنضم لعائلة مافيا؟",a:"استخدم `!mafia join <family name>` للتقدم لعائلة موجودة، أو `!mafia create <name>` لتأسيس عائلتك الخاصة. التواجد في عائلة يمنحك الوصول إلى الحروب والخزائن والرتب."},
      {q:"كيف يتم تحديد الرتب؟",q_ar:"كيف تُحدد الرتب؟",a:"تعتمد الرتب في لوحة المتصدرين الرئيسية على رصيدك من العملات. تعتمد رتب المافيا على إجمالي الأرباح في حروب المافيا. تعتمد شارات مستوى الملف الشخصي على رصيدك الحالي."},
      {q:"هل يمكنني تغيير بذرة العميل الخاصة بي؟",q_ar:"هل يمكنني تغيير بذرة العميل؟",a:"نعم! استخدم `!pfseed <your_seed>` في ديسكورد لتعيين بذرة عميل مخصصة. هذا يجعل نتائجك أكثر تخصيصًا وقابلة للتحقق. يؤدي تغيير البذرة إلى إعادة تعيين العدد العشوائي إلى 0."},
    ];

    res.send(layout("مركز المساعدة",`
      <div class="page-header"><h1>📚 مركز المساعدة والدليل</h1><p>كل ما تحتاج لمعرفته حول دايموند كازينو</p></div>
      <div class="grid-2" style="margin-bottom:20px">
        <div style="background:linear-gradient(135deg,rgba(14,165,233,0.08),rgba(139,92,246,0.08));border:1px solid var(--border);border-radius:var(--radius);padding:20px;display:flex;align-items:center;gap:16px">
          <div style="font-size:40px">🎰</div>
          <div><div style="font-family:Rajdhani,Cairo,sans-serif;font-size:18px;font-weight:700;color:var(--primary)">جديد في دايموند كازينو؟</div><div style="font-size:13px;color:var(--text2);margin-top:4px">استخدم <code>!help</code> في خادم ديسكورد للحصول على دليل سريع للبدء. يتم لعب جميع الألعاب باستخدام أوامر تبدأ بـ <code>!</code></div></div>
        </div>
        <div style="background:linear-gradient(135deg,rgba(245,158,11,0.08),rgba(239,68,68,0.08));border:1px solid var(--border);border-radius:var(--radius);padding:20px;display:flex;align-items:center;gap:16px">
          <div style="font-size:40px">🔐</div>
          <div><div style="font-family:Rajdhani,Cairo,sans-serif;font-size:18px;font-weight:700;color:var(--gold)">العدالة القابلة للإثبات</div><div style="font-size:13px;color:var(--text2);margin-top:4px">يمكن التحقق من كل نتيجة لعبة بشكل مستقل. استخدم <a href="/verify" style="color:var(--primary)">أداة التحقق</a> للتحقق من أي لعبة.</div></div>
        </div>
      </div>
      <div class="card" style="margin-bottom:20px">
        <div class="card-header"><span class="icon">🎮</span>دليل الألعاب</div>
        <div style="display:flex;flex-direction:column;gap:8px">
          ${games.map(g=>`<div class="help-card">
            <div class="help-card-header">
              <h3>${g.title}</h3>
              <span style="font-size:11px;color:var(--text3)">${g.ar}</span>
              <span class="help-arrow" style="margin-left:auto">▼</span>
            </div>
            <div class="help-card-body">${g.body}</div>
          </div>`).join("")}
        </div>
      </div>
      <div class="card">
        <div class="card-header"><span class="icon">❓</span>الأسئلة المتداولة</div>
        <div style="display:flex;flex-direction:column;gap:8px">
          ${faq.map(f=>`<div class="help-card">
            <div class="help-card-header">
              <h3>${f.q}</h3>
              <span style="font-size:11px;color:var(--text3)">${f.q_ar}</span>
              <span class="help-arrow" style="margin-left:auto">▼</span>
            </div>
            <div class="help-card-body">${f.a}</div>
          </div>`).join("")}
        </div>
      </div>
    `,"/help",user));
  });

  /* ── لوحة التحكم ────────────────────────────────────────────────── */
  app.get("/admin",async(req,res)=>{
    const user=req.session.user||null;
    const ownerMode=isOwner(req);

    const ownerProfiles=await Promise.all(OWNERS.map(async id=>{
      let du=null; try{if(discordClient)du=await discordClient.users.fetch(id).catch(()=>null);}catch{}
      const db_=await db.findOne({id}).lean().catch(()=>null);
      const cached=await getCachedUser(id).catch(()=>null);
      return {id,username:du?.username||cached?.username||`مالك…${id.slice(-4)}`,avatar:du?.avatar||cached?.avatar,coins:Number(db_?.coins||0)};
    }));

    let admins=[];
    try{
      if(discordClient&&GUILD_ID&&ADMIN_ROLE){
        const guild=discordClient.guilds.cache.get(GUILD_ID);
        if(guild){
          await guild.members.fetch().catch(()=>{});
          for(const[mid,m] of guild.members.cache){
            if(m.user.bot||OWNERS.includes(mid))continue;
            if(!m.roles.cache.has(ADMIN_ROLE))continue;
            admins.push({id:mid,username:m.user.username,avatar:m.user.avatar});
          }
        }
      }
    }catch{}

    const totalUsers=(await db.countDocuments().catch(()=>0));
    const totalCoins=(await db.find({}).lean().catch(()=>[])).reduce((s,u)=>s+Number(u.coins||0),0);

    res.send(layout("لوحة التحكم",`
      <div class="page-header"><h1>🛡️ لوحة الإدارة</h1><p>${ownerMode?"🔓 وصول كامل — أنت مالك":"🔒 عرض فقط — مقيد للمالكين"}</p></div>
      <div class="stats-grid" style="margin-bottom:20px">
        <div class="stat-card"><div class="sc-icon">👑</div><div class="sc-label">المالكون</div><div class="sc-value gold">${OWNERS.length}</div></div>
        <div class="stat-card"><div class="sc-icon">🛡️</div><div class="sc-label">المشرفون</div><div class="sc-value blue">${admins.length}</div></div>
        <div class="stat-card"><div class="sc-icon">👥</div><div class="sc-label">إجمالي اللاعبين</div><div class="sc-value">${totalUsers}</div></div>
        <div class="stat-card"><div class="sc-icon">💰</div><div class="sc-label">إجمالي العملات</div><div class="sc-value gold">${fmt(totalCoins)}</div></div>
      </div>

      ${ownerMode?`
      <div style="margin-bottom:16px;display:flex;gap:10px;flex-wrap:wrap">
        <a href="/admin/db" class="btn btn-primary" style="font-size:14px">🗄️ مستعرض قاعدة البيانات</a>
        <a href="/admin/parkour-map" class="btn btn-secondary" style="font-size:14px">🏃 محرر خريطة الباركور</a>
      </div>
      <div class="card" style="margin-bottom:16px;border-color:rgba(239,68,68,0.2)">
        <div class="card-header" style="color:var(--red)"><span class="icon">⚠️</span>منطقة الخطر — إجراءات المشرف</div>
        <div style="display:flex;flex-direction:column;gap:12px">
          <div class="admin-action-card">
            <div class="aac-icon">💰</div>
            <div><h4>إعطاء عملات للاعب</h4><p>أضف عملات مباشرة إلى رصيد أي لاعب</p></div>
            <div class="aac-actions">
              <input class="form-input" id="giveUserId" placeholder="معرف ديسكورد" style="width:140px">
              <input class="form-input" id="giveAmount" placeholder="المبلغ" type="number" style="width:100px">
              <button class="btn btn-success btn-sm" onclick="adminAction('/admin/give-coins','POST',{userId:document.getElementById('giveUserId').value,amount:document.getElementById('giveAmount').value},'إعطاء عملات لهذا اللاعب؟')">إعطاء</button>
            </div>
          </div>
          <div class="admin-action-card">
            <div class="aac-icon">🔄</div>
            <div><h4>إعادة تعيين رصيد اللاعب</h4><p>تعيين رصيد لاعب معين إلى 0 (أو مبلغ آخر)</p></div>
            <div class="aac-actions">
              <input class="form-input" id="resetUserId" placeholder="معرف ديسكورد" style="width:140px">
              <input class="form-input" id="resetAmount" placeholder="المبلغ الجديد" type="number" value="0" style="width:100px">
              <button class="btn btn-gold btn-sm" onclick="adminAction('/admin/reset-balance/'+document.getElementById('resetUserId').value,'POST',{amount:document.getElementById('resetAmount').value},'إعادة تعيين رصيد هذا اللاعب؟')">إعادة تعيين</button>
            </div>
          </div>
          <div class="admin-action-card">
            <div class="aac-icon">🗑️</div>
            <div><h4>حذف لاعب</h4><p>إزالة لاعب وجميع بياناته بشكل دائم</p></div>
            <div class="aac-actions">
              <input class="form-input" id="deleteUserId" placeholder="معرف ديسكورد" style="width:160px">
              <button class="btn btn-danger btn-sm" onclick="adminAction('/admin/delete-user/'+document.getElementById('deleteUserId').value,'DELETE',null,'⚠️ حذف هذا اللاعب بشكل دائم؟')">حذف</button>
            </div>
          </div>
          <div class="admin-action-card" style="border-color:rgba(239,68,68,0.3)">
            <div class="aac-icon">💣</div>
            <div><h4>إعادة تعيين جميع الأرصدة</h4><p>تعيين رصيد كل لاعب إلى 0 — لا رجعة فيه!</p></div>
            <div class="aac-actions">
              <button class="btn btn-danger" onclick="adminAction('/admin/reset-all','POST',null,'⚠️ إعادة تعيين جميع الأرصدة إلى 0؟ لا يمكن التراجع عن هذا!')">💣 إعادة تعيين جميع الأرصدة</button>
            </div>
          </div>
          <div class="admin-action-card" style="border-color:rgba(124,58,237,0.4)">
            <div class="aac-icon">⚔️</div>
            <div><h4>إعادة تعيين جميع شخصيات ريزيرو</h4><p>مسح مجموعة شخصيات ريزيرو لكل لاعب — مفيد لإعادة تعيين المواسم</p></div>
            <div class="aac-actions">
              <button class="btn btn-danger btn-sm" onclick="adminAction('/admin/rezero/reset-all','POST',null,'⚔️ إعادة تعيين جميع مجموعات شخصيات ريزيرو لكل لاعب؟')">⚔️ إعادة تعيين الشخصيات</button>
            </div>
          </div>
          <div class="admin-action-card" style="border-color:rgba(239,68,68,0.4)">
            <div class="aac-icon">☢️</div>
            <div><h4>حذف قاعدة البيانات بالكامل</h4><p>مسح جميع اللاعبين والمخزون وبيانات المافيا — لا رجعة فيه</p></div>
            <div class="aac-actions">
              <button class="btn btn-danger" onclick="adminAction('/admin/delete-all','DELETE',null,'☢️ حذف قاعدة البيانات بالكامل؟ لا يمكن التراجع عن هذا!')">☢️ مسح قاعدة البيانات</button>
            </div>
          </div>
        </div>
      </div>`:`<div class="alert alert-warn" style="margin-bottom:16px">🔒 إجراءات المشرف مقيدة لمالكي الكازينو فقط</div>`}

      <div class="grid-2">
        <div class="card" style="background:linear-gradient(135deg,var(--card),rgba(239,68,68,0.04));border-color:rgba(239,68,68,0.15)">
          <div class="card-header"><span class="icon">👑</span>المالكون (${OWNERS.length})</div>
          <div style="display:flex;flex-direction:column;gap:10px">
            ${ownerProfiles.map(o=>`<a href="/profile/${o.id}" style="text-decoration:none">
              <div class="admin-action-card">
                <img src="${avatarUrl(o.id,o.avatar)}" style="width:44px;height:44px;border-radius:50%;border:2px solid var(--red)" onerror="this.src='https://cdn.discordapp.com/embed/avatars/0.png'">
                <div style="flex:1"><div style="font-weight:700;font-size:14px">${esc(o.username)}</div><div style="font-size:11px;color:var(--text3)">${o.id}</div><div style="font-size:12px;color:var(--gold);margin-top:2px">💰 ${fmt(o.coins)}</div></div>
                <span class="badge badge-red">👑 مالك</span>
              </div>
            </a>`).join("")||'<div class="empty-state"><p>لم يتم تكوين أي مالكين</p></div>'}
          </div>
        </div>
        <div class="card">
          <div class="card-header"><span class="icon">🛡️</span>المشرفون (${admins.length})</div>
          <div style="display:flex;flex-direction:column;gap:10px">
            ${admins.map(a=>`<a href="/profile/${a.id}" style="text-decoration:none">
              <div class="admin-action-card">
                <img src="${avatarUrl(a.id,a.avatar)}" style="width:44px;height:44px;border-radius:50%;border:2px solid var(--gold)" onerror="this.src='https://cdn.discordapp.com/embed/avatars/0.png'">
                <div style="flex:1"><div style="font-weight:700;font-size:14px">${esc(a.username)}</div><div style="font-size:11px;color:var(--text3)">${a.id}</div></div>
                <span class="badge badge-gold">🛡️ مشرف</span>
              </div>
            </a>`).join("")||'<div class="empty-state"><p>لم يتم العثور على مشرفين<br><small>يظهر المشرفون بمجرد اتصال البوت</small></p></div>'}
          </div>
        </div>
      </div>
    `,"/admin",user));
  });

  /* ── محرر خريطة الباركور للمشرف ──────────────────────────────── */
  {
    const PARKOUR_MAP_FILE = path.join(__dirname, "parkourMap.json");
    function loadParkourMap() {
      try { return JSON.parse(fs.readFileSync(PARKOUR_MAP_FILE, "utf8")); }
      catch { return null; }
    }
    function saveParkourMap(data) { fs.writeFileSync(PARKOUR_MAP_FILE, JSON.stringify(data, null, 2)); }

    app.get("/admin/parkour-map", requireOwner, async (req, res) => {
      const user = req.session.user || null;
      const mapData = loadParkourMap();
      const mapJson = mapData ? JSON.stringify(mapData, null, 2) : "{}";
      res.send(layout("محرر خريطة الباركور", `
        <div class="page-header"><h1>🏃 محرر خريطة الباركور</h1><p>تحرير المنصات، المسامير، خط النهاية ونقاط الظهور للعبة الباركور.</p></div>
        <div class="card" style="margin-bottom:16px">
          <div class="card-header"><span class="icon">ℹ️</span>كيفية الاستخدام</div>
          <div style="font-size:13px;color:var(--text2);line-height:1.8">
            <b>المنصات</b>: كل منصة تحتاج <code>x, y, w, h, type</code>. الأنواع: <code>ground</code>, <code>platform</code>, <code>moving</code>.<br>
            المنصات المتحركة تحتاج أيضًا: <code>moveAxis</code> (x أو y), <code>moveRange</code>, <code>moveSpeed</code>.<br>
            <b>المسامير</b>: كل مسمار يحتاج <code>x, y, w, h</code>.<br>
            <b>النهاية</b>: <code>x, y, w, h</code> — منطقة النهاية.<br>
            <b>الظهور</b>: <code>p1: {x,y}</code> و <code>p2: {x,y}</code> — مواقع بدء اللاعب.<br>
            <b>حجم الخريطة</b>: <code>width</code> و <code>height</code> للوحة الرسم الكاملة للخريطة.
          </div>
        </div>
        <div class="card">
          <div class="card-header"><span class="icon">✏️</span>JSON الخريطة</div>
          <div id="pkrMapMsg" style="margin-bottom:8px;font-size:13px"></div>
          <textarea id="pkrMapEditor" style="width:100%;min-height:420px;font-family:monospace;font-size:12px;background:var(--bg2);color:var(--text);border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px;resize:vertical">${esc(mapJson)}</textarea>
          <div style="margin-top:12px;display:flex;gap:10px;flex-wrap:wrap">
            <button class="btn btn-primary" onclick="savePkrMap()">💾 حفظ الخريطة</button>
            <button class="btn btn-secondary" onclick="formatPkrMap()">🔧 تنسيق JSON</button>
            <button class="btn btn-ghost" onclick="resetPkrMap()">↩️ إعادة تعيين إلى الافتراضي</button>
          </div>
        </div>
        <div class="card" style="margin-top:16px">
          <div class="card-header"><span class="icon">🗺️</span>معاينة مرئية</div>
          <p style="font-size:12px;color:var(--text2);margin-bottom:8px">معاينة مبسطة من أعلى لأسفل للخريطة. أخضر = أرض، بني = منصة، بنفسجي = متحرك، أحمر = مسمار، أصفر = نهاية، أزرق = ظهور.</p>
          <canvas id="pkrPreview" width="900" height="120" style="background:#1a1a2e;border-radius:var(--radius-sm);max-width:100%"></canvas>
        </div>
        <script>
        const DEFAULT_MAP = ${JSON.stringify(require('./parkourWebRoutes').DEFAULT_MAP || loadParkourMap() || {}, null, 2)};
        function savePkrMap(){
          const msg=document.getElementById('pkrMapMsg');
          let d; try{ d=JSON.parse(document.getElementById('pkrMapEditor').value); } catch(e){ msg.innerHTML='<span style="color:var(--red)">❌ JSON غير صالح: '+e.message+'</span>'; return; }
          fetch('/admin/parkour-map/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({map:d})})
            .then(r=>r.json()).then(r=>{ msg.innerHTML=r.ok?'<span style="color:var(--green)">✅ تم حفظ الخريطة! أعد تشغيل الخادم لتطبيق التغييرات.</span>':'<span style="color:var(--red)">❌ '+r.error+'</span>'; drawPreview(d); }).catch(()=>{ msg.innerHTML='<span style="color:var(--red)">❌ خطأ في الشبكة</span>'; });
        }
        function formatPkrMap(){
          try{ document.getElementById('pkrMapEditor').value=JSON.stringify(JSON.parse(document.getElementById('pkrMapEditor').value),null,2); } catch(e){ alert('JSON غير صالح'); }
        }
        function resetPkrMap(){
          if(!confirm('إعادة تعيين إلى الخريطة الافتراضية الحالية؟')) return;
          fetch('/admin/parkour-map/default').then(r=>r.json()).then(d=>{ document.getElementById('pkrMapEditor').value=JSON.stringify(d,null,2); drawPreview(d); });
        }
        function drawPreview(mapData){
          const canvas=document.getElementById('pkrPreview');
          const ctx=canvas.getContext('2d');
          const W=900, H=120;
          const scale=W/(mapData.width||4800);
          const yScale=H/(mapData.height||600);
          ctx.clearRect(0,0,W,H);
          ctx.fillStyle='#1a1a2e'; ctx.fillRect(0,0,W,H);
          (mapData.platforms||[]).forEach(p=>{
            ctx.fillStyle=p.type==='ground'?'#22703a':p.type==='moving'?'#7c3aed':'#8b6914';
            ctx.fillRect(p.x*scale,p.y*yScale,p.w*scale,Math.max(2,p.h*yScale));
          });
          (mapData.spikes||[]).forEach(s=>{ ctx.fillStyle='#ef4444'; ctx.fillRect(s.x*scale,s.y*yScale,s.w*scale,Math.max(2,s.h*yScale)); });
          if(mapData.finish){ const f=mapData.finish; ctx.fillStyle='#f59e0b'; ctx.fillRect(f.x*scale,f.y*yScale,f.w*scale,Math.max(3,f.h*yScale)); }
          if(mapData.spawn){ const sp=mapData.spawn;
            if(sp.p1){ ctx.fillStyle='#38bdf8'; ctx.fillRect(sp.p1.x*scale-3,sp.p1.y*yScale-6,6,6); }
            if(sp.p2){ ctx.fillStyle='#fbbf24'; ctx.fillRect(sp.p2.x*scale-3,sp.p2.y*yScale-6,6,6); }
          }
        }
        try{ drawPreview(JSON.parse(document.getElementById('pkrMapEditor').value)); } catch(e){}
        document.getElementById('pkrMapEditor').addEventListener('input',()=>{
          try{ drawPreview(JSON.parse(document.getElementById('pkrMapEditor').value)); }catch(e){}
        });
        </script>
      `, "/admin/parkour-map", user));
    });

    app.post("/admin/parkour-map/save", requireOwner, (req, res) => {
      const { map } = req.body || {};
      if (!map || typeof map !== "object") return res.json({ ok: false, error: "بيانات خريطة غير صالحة" });
      try { saveParkourMap(map); res.json({ ok: true }); }
      catch (e) { res.json({ ok: false, error: e.message }); }
    });

    app.get("/admin/parkour-map/default", requireOwner, (req, res) => {
      const ParkourRoutes = require("./parkourWebRoutes");
      res.json(ParkourRoutes.DEFAULT_MAP || {});
    });
  }

  /* ── مستعرض قاعدة بيانات المشرف ────────────────────────────────────── */
  {
    const WatchRoomM  = require('./models/watchRoom');
    const WatchLogM   = require('./models/watchLog');
    const AdminLogM   = require('./models/adminLog');
    const ChessGameM  = require('./models_games/chessGame');
    const PenaltyGameM= require('./models_games/penaltyGame');

    function getCollections(){
      return {
        users:       { model: db,           label:'👥 المستخدمون',       sortKey:'createdAt' },
        watchrooms:  { model: WatchRoomM,   label:'🎬 غرف المشاهدة', sortKey:'createdAt' },
        watchlogs:   { model: WatchLogM,    label:'📋 سجلات المشاهدة',  sortKey:'createdAt' },
        chessgames:  { model: ChessGameM,   label:'♟️ ألعاب الشطرنج', sortKey:'createdAt' },
        penaltygames:{ model: PenaltyGameM, label:'⚽ ركلات الجزاء',     sortKey:'createdAt' },
        adminlogs:   { model: AdminLogM,    label:'📝 سجل المشرف',   sortKey:'createdAt' },
      };
    }

    async function logAdminAction(user, action, collection, docId, notes){
      await AdminLogM.create({ adminId:user.id, adminUsername:user.username, action, collectionName:collection, docId:String(docId||''), notes:String(notes||'') }).catch(()=>{});
      if(discordClient){
        try{
          const owner = await discordClient.users.fetch(OWNERS[0]).catch(()=>null);
          if(owner) owner.send(`🛡️ **إجراء مشرف**\n**من:** ${user.username} (${user.id})\n**الإجراء:** ${action}\n**المجموعة:** ${collection}\n**معرف المستند:** ${docId||'—'}\n**ملاحظات:** ${notes||'—'}`).catch(()=>{});
        }catch{}
      }
    }

    // رابط في /admin
    app.get('/admin/db', requireOwner, async(req,res)=>{
      const user = req.session.user;
      const cols = getCollections();
      const col  = req.query.col||'users';
      const page = Math.max(1,parseInt(req.query.page)||1);
      const search = (req.query.search||'').trim();
      const PER = 15;
      const colDef = cols[col];
      if(!colDef) return res.redirect('/admin/db?col=users');

      let query = {};
      if(search){
        query = { $or:[
          { id:          { $regex:search,$options:'i' } },
          { username:    { $regex:search,$options:'i' } },
          { title:       { $regex:search,$options:'i' } },
          { roomId:      { $regex:search,$options:'i' } },
          { ownerId:     { $regex:search,$options:'i' } },
          { gameId:      { $regex:search,$options:'i' } },
          { adminId:     { $regex:search,$options:'i' } },
          { collectionName: { $regex:search,$options:'i' } },
        ]};
      }

      const total = await colDef.model.countDocuments(query).catch(()=>0);
      const docs  = await colDef.model.find(query).lean().sort({createdAt:-1}).skip((page-1)*PER).limit(PER).catch(()=>[]);
      const pages = Math.max(1,Math.ceil(total/PER));

      const colCounts = {};
      for(const [k,c] of Object.entries(cols)){
        colCounts[k] = await c.model.countDocuments().catch(()=>0);
      }

      function cell(v){
        if(v===null||v===undefined) return '<span style="color:var(--text3)">—</span>';
        if(typeof v==='boolean') return v?'<span style="color:#22c55e">✓</span>':'<span style="color:var(--text3)">✗</span>';
        if(typeof v==='object') return '<span style="font-size:10px;color:var(--text3)">' + esc(JSON.stringify(v).slice(0,50)) + '…</span>';
        return esc(String(v).slice(0,80));
      }

      const keys = docs.length ? Object.keys(docs[0]).filter(k=>k!=='__v') : [];
      const theadCells = keys.map(k=>'<th style="white-space:nowrap;padding:6px 10px;font-size:11px;color:var(--text2);text-transform:uppercase">'+esc(k)+'</th>').join('');
      const tbodyRows = docs.map(doc=>{
        const id = doc._id||doc.id||'';
        const tds = keys.map(k=>'<td style="padding:6px 10px;font-size:12px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+cell(doc[k])+'</td>').join('');
        return '<tr style="border-bottom:1px solid var(--border)">' + tds +
          '<td style="padding:4px 6px;white-space:nowrap">' +
          '<button class="btn btn-ghost btn-sm" style="font-size:10px;padding:2px 8px" onclick="editDoc(\''+esc(String(id))+'\',\''+col+'\')">✏️</button> ' +
          '<button class="btn btn-danger btn-sm" style="font-size:10px;padding:2px 8px" onclick="deleteDoc(\''+esc(String(id))+'\',\''+col+'\')">🗑️</button>' +
          '</td></tr>';
      }).join('');

      const tabsHtml = Object.entries(cols).map(([k,c])=>`
        <a href="/admin/db?col=${k}&page=1" class="btn btn-sm ${col===k?'btn-primary':'btn-ghost'}" style="font-size:12px">
          ${c.label} <span class="badge" style="background:var(--bg3);color:var(--text2);margin-left:4px">${colCounts[k]||0}</span>
        </a>`).join('');

      const paginationHtml = pages>1 ? Array.from({length:pages},(_,i)=>`
        <a href="/admin/db?col=${col}&page=${i+1}&search=${encodeURIComponent(search)}"
           class="btn btn-sm ${page===i+1?'btn-primary':'btn-ghost'}" style="font-size:11px;padding:3px 8px">${i+1}</a>`).join('') : '';

      res.send(layout('🗄️ مستعرض قاعدة البيانات', `
        <div class="page-header">
          <h1>🗄️ مستعرض قاعدة البيانات</h1>
          <p>👑 وصول كامل — ${total} مستند في ${esc(colDef.label)}</p>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
          ${tabsHtml}
          <a href="/api/admin/db/${col}/export" class="btn btn-secondary btn-sm" style="font-size:12px;margin-left:auto">⬇️ تصدير JSON</a>
        </div>
        <div class="card" style="margin-bottom:16px">
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:12px">
            <input class="form-input" id="searchBox" value="${esc(search)}" placeholder="بحث في ${esc(colDef.label)}..." style="flex:1;min-width:200px" onkeydown="if(event.key==='Enter')doSearch()">
            <button class="btn btn-primary btn-sm" onclick="doSearch()">🔍 بحث</button>
            ${search?`<a href="/admin/db?col=${col}&page=1" class="btn btn-ghost btn-sm">✕ مسح</a>`:''}
            <button class="btn btn-success btn-sm" onclick="addDoc('${col}')">＋ إضافة</button>
          </div>
          <div style="overflow-x:auto">
            <table style="width:100%;border-collapse:collapse">
              <thead style="background:var(--bg3)"><tr>${theadCells}<th style="padding:6px 10px;font-size:11px">إجراءات</th></tr></thead>
              <tbody>${tbodyRows||'<tr><td colspan="99" style="text-align:center;padding:24px;color:var(--text2)">لا توجد نتائج</td></tr>'}</tbody>
            </table>
          </div>
          ${paginationHtml?`<div style="display:flex;gap:4px;flex-wrap:wrap;padding:12px">${paginationHtml}</div>`:''}
        </div>

        <script>
        var _COL = '${col}';
        function doSearch(){ var q=document.getElementById('searchBox').value; window.location='/admin/db?col='+_COL+'&page=1&search='+encodeURIComponent(q); }
        async function deleteDoc(id,col){
          if(!confirm('حذف هذا السجل نهائياً؟')) return;
          var r=await fetch('/api/admin/db/'+col+'/'+id,{method:'DELETE'}).then(x=>x.json()).catch(()=>null);
          if(r&&r.success){ showToast('تم الحذف','success'); setTimeout(()=>location.reload(),800); }
          else showToast('فشل الحذف','error');
        }
        async function editDoc(id,col){
          var r=await fetch('/api/admin/db/'+col+'/doc/'+id).then(x=>x.json()).catch(()=>null);
          if(!r||r.error){ showToast('لم يُوجد السجل','error'); return; }
          var json=JSON.stringify(r.doc,null,2);
          var modal=document.createElement('div');
          modal.style='position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';
          modal.innerHTML='<div style="background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:20px;width:100%;max-width:600px;max-height:80vh;display:flex;flex-direction:column;gap:12px">'
            +'<div style="font-weight:700;font-size:15px">✏️ تعديل — '+id+'</div>'
            +'<textarea id="editJson" style="flex:1;height:340px;background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:10px;color:var(--text);font-family:monospace;font-size:12px;resize:vertical">'+json.replace(/</g,"&lt;")+'</textarea>'
            +'<div style="display:flex;gap:8px;justify-content:flex-end">'
            +'<button class="btn btn-ghost" onclick="this.closest(\'[style]\').remove()">إلغاء</button>'
            +'<button class="btn btn-primary" onclick="saveEdit(\''+id+'\',\''+col+'\',this)">💾 حفظ</button>'
            +'</div></div>';
          document.body.appendChild(modal);
        }
        async function saveEdit(id,col,btn){
          var ta=document.getElementById('editJson');
          var parsed; try{parsed=JSON.parse(ta.value);}catch{showToast('JSON غير صالح','error');return;}
          btn.disabled=true; btn.textContent='...';
          var r=await fetch('/api/admin/db/'+col+'/doc/'+id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({data:parsed})}).then(x=>x.json()).catch(()=>null);
          if(r&&r.success){showToast('تم الحفظ','success');setTimeout(()=>location.reload(),800);}
          else showToast('فشل الحفظ','error');
          btn.disabled=false; btn.textContent='💾 حفظ';
        }
        async function addDoc(col){
          var modal=document.createElement('div');
          modal.style='position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';
          modal.innerHTML='<div style="background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:20px;width:100%;max-width:600px;max-height:80vh;display:flex;flex-direction:column;gap:12px">'
            +'<div style="font-weight:700;font-size:15px">＋ إضافة سجل جديد</div>'
            +'<textarea id="newDocJson" style="flex:1;height:280px;background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:10px;color:var(--text);font-family:monospace;font-size:12px;resize:vertical">{}</textarea>'
            +'<div style="display:flex;gap:8px;justify-content:flex-end">'
            +'<button class="btn btn-ghost" onclick="this.closest(\'[style]\').remove()">إلغاء</button>'
            +'<button class="btn btn-success" onclick="createDoc(\''+col+'\',this)">＋ إضافة</button>'
            +'</div></div>';
          document.body.appendChild(modal);
        }
        async function createDoc(col,btn){
          var ta=document.getElementById('newDocJson');
          var parsed; try{parsed=JSON.parse(ta.value);}catch{showToast('JSON غير صالح','error');return;}
          btn.disabled=true; btn.textContent='...';
          var r=await fetch('/api/admin/db/'+col+'/doc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({data:parsed})}).then(x=>x.json()).catch(()=>null);
          if(r&&r.success){showToast('تم الإضافة','success');setTimeout(()=>location.reload(),800);}
          else showToast('فشل الإضافة: '+(r?.error||''),'error');
          btn.disabled=false;
        }
        </script>
      `, '/admin', user));
    });

    // تصدير
    app.get('/api/admin/db/:col/export', requireOwner, async(req,res)=>{
      const cols = getCollections();
      const colDef = cols[req.params.col];
      if(!colDef) return res.status(404).json({error:'مجموعة غير معروفة'});
      const docs = await colDef.model.find({}).lean().catch(()=>[]);
      await logAdminAction(req.session.user,'export',req.params.col,'all',docs.length+' docs');
      res.setHeader('Content-Disposition','attachment; filename="'+req.params.col+'.json"');
      res.json(docs);
    });

    // الحصول على مستند واحد
    app.get('/api/admin/db/:col/doc/:id', requireOwner, async(req,res)=>{
      const cols = getCollections();
      const colDef = cols[req.params.col];
      if(!colDef) return res.json({error:'مجموعة غير معروفة'});
      const doc = await colDef.model.findById(req.params.id).lean().catch(()=>null);
      if(!doc) return res.json({error:'غير موجود'});
      res.json({doc});
    });

    // إنشاء مستند
    app.post('/api/admin/db/:col/doc', requireOwner, async(req,res)=>{
      const cols = getCollections();
      const colDef = cols[req.params.col];
      if(!colDef) return res.json({error:'مجموعة غير معروفة'});
      const { data } = req.body;
      if(!data) return res.json({error:'لا توجد بيانات'});
      const doc = await colDef.model.create(data).catch(e=>({_error:e.message}));
      if(doc._error) return res.json({error:doc._error});
      await logAdminAction(req.session.user,'create',req.params.col,String(doc._id||''),JSON.stringify(data).slice(0,200));
      res.json({success:true,id:doc._id});
    });

    // تحديث مستند
    app.put('/api/admin/db/:col/doc/:id', requireOwner, async(req,res)=>{
      const cols = getCollections();
      const colDef = cols[req.params.col];
      if(!colDef) return res.json({error:'مجموعة غير معروفة'});
      const { data } = req.body;
      if(!data) return res.json({error:'لا توجد بيانات'});
      delete data._id; delete data.__v;
      const result = await colDef.model.findByIdAndUpdate(req.params.id, { $set:data }, { new:true }).catch(e=>null);
      if(!result) return res.json({error:'غير موجود أو فشل التحديث'});
      await logAdminAction(req.session.user,'edit',req.params.col,req.params.id,JSON.stringify(data).slice(0,200));
      res.json({success:true});
    });

    // حذف مستند
    app.delete('/api/admin/db/:col/:id', requireOwner, async(req,res)=>{
      const cols = getCollections();
      const colDef = cols[req.params.col];
      if(!colDef) return res.json({error:'مجموعة غير معروفة'});
      await colDef.model.findByIdAndDelete(req.params.id).catch(()=>{});
      await logAdminAction(req.session.user,'delete',req.params.col,req.params.id,'');
      res.json({success:true});
    });
  }

  /* ── صفحة المهام اليومية (تمت إزالتها — إعادة توجيه إلى الرئيسية) ──── */
  app.get("/missions",(req,res)=>res.redirect("/"));
  if(false) app.get("/missions_old",async(req,res)=>{
    // ... تمت إزالة الكود
  });

  /* ── API: المطالبة بمهمة ──────────────────────────────────── */
  app.post("/api/missions/claim/:missionId",async(req,res)=>{
    if(!req.session.user)return res.json({error:"تسجيل الدخول مطلوب"});
    const userId=req.session.user.id;
    const missionId=req.params.missionId;
    const def=MISSION_DEFS.find(m=>m.id===missionId);
    if(!def)return res.json({error:"مهمة غير معروفة"});
    const mDoc=await getOrCreateDailyMissions(userId);
    if(!mDoc)return res.json({error:"خطأ في قاعدة البيانات"});
    const prog=mDoc.missions.find(m=>m.id===missionId);
    if(!prog)return res.json({error:"المهمة غير موجودة"});
    if(prog.progress<def.target)return res.json({error:"المهمة لم تكتمل بعد"});
    if(prog.claimed)return res.json({error:"تم المطالبة بالفعل"});
    prog.claimed=true;
    mDoc.markModified("missions");
    await mDoc.save().catch(()=>null);
    const dbUser=await db.findOne({id:userId}).catch(()=>null)||await db.create({id:userId,coins:0}).catch(()=>null);
    if(dbUser){ dbUser.coins=parseInt(dbUser.coins||0)+def.reward; await dbUser.save().catch(()=>null); }
    siteLog("🎁 تم المطالبة بمهمة",`**${req.session.user.username}** طالب بـ **${def.label}** (+${def.reward} عملة)`, "#FEE75C");
    res.json({success:true,reward:def.reward});
  });

  /* ── صفحة المباريات ────────────────────────────────────────── */
  app.get("/matches",async(req,res)=>{
    const user=req.session?.user||null;
    const allMatches=await matchBet.find({}).sort({createdAt:-1}).limit(50).lean().catch(()=>[]);
    const myBets=new Map();
    if(user){ allMatches.forEach(m=>{ const b=m.bets?.find(b=>b.userId===user.id); if(b)myBets.set(m.matchId,b); }); }

    function statusBadge(s){
      if(s==="open")return`<span class="badge" style="background:#57F287;color:#000">🟢 مفتوح</span>`;
      if(s==="closed")return`<span class="badge" style="background:#FEE75C;color:#000">🔴 إغلاق الرهانات</span>`;
      if(s==="finished")return`<span class="badge" style="background:#5865F2;color:#fff">✅ منتهية</span>`;
      if(s==="cancelled")return`<span class="badge" style="background:#ED4245;color:#fff">❌ ملغية</span>`;
      return`<span class="badge">${s}</span>`;
    }
    function resultLabel(r,t1,t2){
      if(r===1)return`🏆 فاز ${esc(t1)}`;
      if(r===2)return`🏆 فاز ${esc(t2)}`;
      if(r===0)return`🤝 تعادل`;
      return"";
    }

    const open=allMatches.filter(m=>m.status==="open");
    const closed=allMatches.filter(m=>m.status==="closed");
    const finished=allMatches.filter(m=>m.status==="finished");
    const cancelled=allMatches.filter(m=>m.status==="cancelled");

    function renderMatch(m){
      const t1bets=m.bets?.filter(b=>b.side===1)||[];
      const t2bets=m.bets?.filter(b=>b.side===2)||[];
      const t1pool=t1bets.reduce((a,b)=>a+b.amount,0);
      const t2pool=t2bets.reduce((a,b)=>a+b.amount,0);
      const total=t1pool+t2pool;
      const t1pct=total?Math.round(t1pool/total*100):50;
      const t2pct=total?Math.round(t2pool/total*100):50;
      const myBet=myBets.get(m.matchId);
      const dl=m.deadline>0?`<div style="font-size:11px;color:var(--text3);margin-top:2px">⏰ الموعد النهائي: ${new Date(m.deadline).toLocaleString("ar-EG",{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"})}</div>`:"";
      return`<div class="card" style="margin-bottom:12px">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:12px">
          <div>
            <div style="font-size:11px;color:var(--text3);margin-bottom:2px">المباراة #${esc(m.matchId)} ${m.description?`— ${esc(m.description)}`:""}</div>
            <div style="font-size:18px;font-weight:800;font-family:Rajdhani,Cairo,sans-serif">${esc(m.team1)} <span style="color:var(--gold)">ضد</span> ${esc(m.team2)}</div>
            ${dl}
          </div>
          <div style="display:flex;align-items:center;gap:8px">${statusBadge(m.status)}${m.status==="finished"?`<span style="font-size:12px;color:var(--gold);font-weight:700">${resultLabel(m.result,m.team1,m.team2)}</span>`:""}</div>
        </div>
        <div style="display:flex;gap:0;border-radius:99px;overflow:hidden;height:10px;margin-bottom:8px">
          <div style="background:var(--primary);width:${t1pct}%;transition:width 0.4s"></div>
          <div style="background:#ED4245;width:${t2pct}%;transition:width 0.4s"></div>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:10px">
          <span style="color:var(--primary)">🔵 ${esc(m.team1)}: ${fmt(t1pool)} عملة (${t1pct}%) — ${t1bets.length} رهان</span>
          <span style="color:#ED4245">🔴 ${esc(m.team2)}: ${fmt(t2pool)} عملة (${t2pct}%) — ${t2bets.length} رهان</span>
        </div>
        ${myBet?`<div style="background:var(--bg2);border-radius:8px;padding:8px 12px;font-size:12px;border-left:3px solid var(--gold)">
          👤 رهانك: <strong style="color:var(--gold)">${fmt(myBet.amount)} عملة</strong> على <strong>${myBet.side===1?esc(m.team1):esc(m.team2)}</strong>
          ${m.status==="finished"?(myBet.side===m.result?`<span style="color:#57F287;margin-left:8px">✅ فزت!</span>`:m.result===0?`<span style="color:#FEE75C;margin-left:8px">🤝 تم الاسترداد</span>`:`<span style="color:#ED4245;margin-left:8px">❌ خسرت</span>`):""}
        </div>`:""}
        <div style="margin-top:10px;font-size:11px;color:var(--text3)">إجمالي الجائزة: <strong style="color:var(--text)">${fmt(total)} عملة</strong> · استخدم أمر البوت للرهان</div>
      </div>`;
    }

    const sections=[
      {label:"🟢 مباريات مفتوحة", list:open},
      {label:"🔴 إغلاق الرهانات", list:closed},
      {label:"✅ مباريات منتهية", list:finished},
      {label:"❌ ملغية", list:cancelled},
    ].filter(s=>s.list.length>0);

    const content=sections.length?sections.map(s=>`
      <div style="margin-bottom:24px">
        <h2 style="font-family:Rajdhani,Cairo,sans-serif;font-size:18px;margin-bottom:12px;color:var(--primary)">${s.label} (${s.list.length})</h2>
        ${s.list.map(renderMatch).join("")}
      </div>
    `).join(""):
    `<div class="empty-state"><div class="ei">⚽</div><p>لا توجد مباريات بعد<br><small>يقوم المشرفون بإنشاء مباريات باستخدام <code>!addmatch</code> في ديسكورد</small></p></div>`;

    res.send(layout("رهانات المباريات — دايموند كازينو",`
      <div class="page-header">
        <h1>⚽ رهانات المباريات</h1>
        <p style="color:var(--text3);margin-top:4px">راهن على المباريات التي أنشأها المشرفون في ديسكورد. استخدم البوت لوضع رهاناتك.</p>
      </div>
      <div style="background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:12px 16px;margin-bottom:20px;font-size:13px;color:var(--text2)">
        💡 <strong>كيف تراهن:</strong> في ديسكورد، استخدم <code style="background:var(--bg2);padding:2px 6px;border-radius:4px">!bet &lt;معرف المباراة&gt; &lt;1|2&gt; &lt;المبلغ&gt;</code> لوضع رهان على مباراة. يستخدم المشرفون <code style="background:var(--bg2);padding:2px 6px;border-radius:4px">!addmatch</code> لإنشاء مباريات.
      </div>
      ${content}
    `,"/matches",user));
  });

  /* ══════════════════════════════════════════════════════════
     واجهة برمجة تطبيقات إعدادات المشرف
  ══════════════════════════════════════════════════════════ */
  app.post("/api/admin/settings", requireOwner, (req,res)=>{
    const s = loadSettings();
    const { seasonName, seasonEnd, seasonDescription, discordInviteCode, announcementBanner, soundEnabled, battlePassActive } = req.body;
    if(seasonName!==undefined) s.seasonName=seasonName;
    if(seasonEnd!==undefined) s.seasonEnd=seasonEnd;
    if(seasonDescription!==undefined) s.seasonDescription=seasonDescription;
    if(discordInviteCode!==undefined) s.discordInviteCode=discordInviteCode;
    if(announcementBanner!==undefined) s.announcementBanner=announcementBanner;
    if(soundEnabled!==undefined) s.soundEnabled=soundEnabled==="true"||soundEnabled===true;
    if(battlePassActive!==undefined) s.battlePassActive=battlePassActive==="true"||battlePassActive===true;
    saveSettings(s);
    siteLog("⚙️ إعدادات المشرف", `**${req.session.user.username}** قام بتحديث إعدادات الموقع`, "#F59E0B");
    res.json({success:true,message:"تم حفظ الإعدادات!"});
  });

  app.post("/api/admin/shop-item", requireOwner, (req,res)=>{
    const s=loadSettings();
    const {id,label,description,price,roleId,emoji}=req.body;
    if(!id||!label||!price) return res.json({error:"حقول مفقودة"});
    s.coinShopItems = s.coinShopItems||[];
    const idx = s.coinShopItems.findIndex(i=>i.id===id);
    const item = {id,label,description:description||"",price:parseInt(price)||0,roleId:roleId||"",emoji:emoji||"🎁"};
    if(idx>=0) s.coinShopItems[idx]=item; else s.coinShopItems.push(item);
    saveSettings(s);
    res.json({success:true,message:"تم حفظ عنصر المتجر!",reload:true});
  });

  app.delete("/api/admin/shop-item/:id", requireOwner, (req,res)=>{
    const s=loadSettings();
    s.coinShopItems=(s.coinShopItems||[]).filter(i=>i.id!==req.params.id);
    saveSettings(s);
    res.json({success:true,message:"تمت إزالة العنصر!",reload:true});
  });

  /* ══════════════════════════════════════════════════════════
     واجهات برمجة تطبيقات الموسم / معركة الدوري
  ══════════════════════════════════════════════════════════ */
  app.get("/api/season/progress", requireLogin, async(req,res)=>{
    const bp = await BattlePass.findOne({userId:req.session.user.id}) || {xp:0,tier:0,claimed:[]};
    res.json({xp:bp.xp,tier:bp.tier,claimed:bp.claimed||[]});
  });

  app.post("/api/season/claim/:tier", requireLogin, async(req,res)=>{
    const settings=loadSettings(); const tiers=settings.battlePassTiers||[];
    const tierNum=parseInt(req.params.tier);
    const tierDef=tiers.find(t=>t.tier===tierNum);
    if(!tierDef) return res.json({error:"مستوى غير صالح"});
    let bp=await BattlePass.findOne({userId:req.session.user.id});
    if(!bp) bp=new BattlePass({userId:req.session.user.id});
    if((bp.claimed||[]).includes(tierNum)) return res.json({error:"تم المطالبة بالفعل"});
    if(bp.xp<tierDef.xpRequired) return res.json({error:"لا توجد نقاط خبرة كافية"});
    bp.claimed=[...(bp.claimed||[]),tierNum];
    await bp.save();
    await db.findOneAndUpdate({userId:req.session.user.id},{$inc:{coins:tierDef.reward}}).catch(()=>null);
    siteLog("🏆 معركة الدوري", `**${req.session.user.username}** طالب بالمستوى ${tierNum} (${tierDef.label}) — +${tierDef.reward.toLocaleString()} عملة`, "#F59E0B");
    res.json({success:true,message:`تمت المطالبة بـ ${tierDef.icon||"🎁"} ${tierDef.label}! +${tierDef.reward.toLocaleString()} عملة`});
  });

  app.post("/api/season/add-xp", requireOwner, async(req,res)=>{
    const {userId,xp}=req.body;
    if(!userId||!xp) return res.json({error:"حقول مفقودة"});
    let bp=await BattlePass.findOne({userId})||new BattlePass({userId});
    bp.xp=(bp.xp||0)+parseInt(xp);
    const settings=loadSettings(); const tiers=settings.battlePassTiers||[];
    let newTier=0;
    for(const t of tiers){ if(bp.xp>=t.xpRequired) newTier=t.tier; }
    bp.tier=newTier;
    await bp.save();
    res.json({success:true,message:`تمت إضافة ${xp} نقطة خبرة إلى ${userId}`});
  });

  /* ══════════════════════════════════════════════════════════
     واجهات برمجة تطبيقات التذاكر
  ══════════════════════════════════════════════════════════ */
  app.get("/api/tickets/mine", requireLogin, async(req,res)=>{
    const tickets=await Ticket.find({userId:req.session.user.id}).sort({createdAt:-1}).limit(20);
    res.json(tickets);
  });

  app.post("/api/tickets/create", requireLogin, async(req,res)=>{
    const {subject,message,category}=req.body;
    if(!subject||!message) return res.json({error:"حقول مفقودة"});
    const ticketId=nextTicketId();
    const t=new Ticket({ticketId,userId:req.session.user.id,username:req.session.user.username,subject,message,category:category||"general"});
    await t.save();
    siteLog("🎫 تذكرة جديدة",`**${req.session.user.username}** فتح تذكرة \`${ticketId}\`\n**الموضوع:** ${subject}\n**الفئة:** ${category||"عام"}`, "#0EA5E9");
    res.json({success:true,message:`تم إنشاء التذكرة ${ticketId}!`,ticketId});
  });

  app.get("/api/tickets/all", requireOwner, async(req,res)=>{
    const tickets=await Ticket.find().sort({createdAt:-1}).limit(50);
    res.json(tickets);
  });

  app.post("/api/tickets/reply/:id", requireOwner, async(req,res)=>{
    const {reply}=req.body;
    if(!reply) return res.json({error:"رد مفقود"});
    const t=await Ticket.findOne({ticketId:req.params.id});
    if(!t) return res.json({error:"التذكرة غير موجودة"});
    t.reply=reply; t.repliedBy=req.session.user.username; t.status="answered"; t.updatedAt=new Date();
    await t.save();
    siteLog("🎫 رد على التذكرة",`**${req.session.user.username}** رد على التذكرة \`${t.ticketId}\` (${t.username})`, "#10B981");
    res.json({success:true,message:"تم إرسال الرد!",reload:true});
  });

  app.post("/api/tickets/close/:id", requireOwner, async(req,res)=>{
    const t=await Ticket.findOne({ticketId:req.params.id});
    if(!t) return res.json({error:"التذكرة غير موجودة"});
    t.status="closed"; t.updatedAt=new Date();
    await t.save();
    res.json({success:true,message:"تم إغلاق التذكرة!",reload:true});
  });

  /* ══════════════════════════════════════════════════════════
     واجهات برمجة تطبيقات متجر العملات
  ══════════════════════════════════════════════════════════ */
  app.post("/api/shop/buy/:itemId", requireLogin, async(req,res)=>{
    const settings=loadSettings();
    const item=(settings.coinShopItems||[]).find(i=>i.id===req.params.itemId);
    if(!item) return res.json({error:"العنصر غير موجود"});
    const user=await db.findOne({userId:req.session.user.id});
    if(!user) return res.json({error:"المستخدم غير موجود"});
    const coins=Number(user.coins||0);
    if(coins<item.price) return res.json({error:`ليس لديك عملات كافية! تحتاج إلى ${(item.price-coins).toLocaleString()} إضافية.`});
    await db.findOneAndUpdate({userId:req.session.user.id},{$inc:{coins:-item.price}});
    if(item.roleId&&discordClient){
      try{
        const guild=discordClient.guilds.cache.get("1310292274801938553");
        if(guild){
          const member=await guild.members.fetch(req.session.user.id).catch(()=>null);
          if(member) await member.roles.add(item.roleId).catch(()=>null);
        }
      }catch(e){/* فشل تعيين الدور بصمت */}
    }
    siteLog("🛒 شراء من المتجر",`**${req.session.user.username}** اشترى **${item.label}** مقابل ${item.price.toLocaleString()} عملة`, "#8B5CF6");
    res.json({success:true,message:`تم شراء ${item.emoji||"🎁"} ${item.label} بنجاح!`});
  });

  /* ══════════════════════════════════════════════════════════
     واجهات برمجة تطبيقات العرض
  ══════════════════════════════════════════════════════════ */
  app.post("/api/showcase/pin", requireLogin, async(req,res)=>{
    const {type,title,value,icon}=req.body;
    let sc=await Showcase.findOne({userId:req.session.user.id})||new Showcase({userId:req.session.user.id});
    if((sc.pins||[]).length>=6) return res.json({error:"الحد الأقصى 6 عناصر عرض"});
    sc.pins=[...(sc.pins||[]),{type,title,value,icon,pinned:Date.now()}];
    await sc.save();
    res.json({success:true,message:"تم التثبيت في العرض!"});
  });

  app.delete("/api/showcase/pin/:idx", requireLogin, async(req,res)=>{
    let sc=await Showcase.findOne({userId:req.session.user.id});
    if(!sc) return res.json({error:"لا يوجد عرض"});
    sc.pins=(sc.pins||[]).filter((_,i)=>i!==parseInt(req.params.idx));
    sc.markModified("pins"); await sc.save();
    res.json({success:true,message:"تمت الإزالة!",reload:true});
  });

  /* ══════════════════════════════════════════════════════════
     صفحة الإحصائيات
  ══════════════════════════════════════════════════════════ */
  app.get("/stats", async(req,res)=>{
    const user=req.session?.user||null;
    try{
      const allUsers=await db.find({}).lean();
      const totalUsers=allUsers.length;
      const totalCoins=allUsers.reduce((a,u)=>a+Number(u.coins||0),0);
      const richest=allUsers.filter(u=>u.username).sort((a,b)=>Number(b.coins||0)-Number(a.coins||0)).slice(0,5);
      const totalBets=await matchBet.countDocuments();
      const ticketCount=await Ticket.countDocuments();
      const openTickets=await Ticket.countDocuments({status:"open"});
      const topWinners=allUsers.filter(u=>u.username&&Number(u.wins||0)>0).sort((a,b)=>Number(b.wins||0)-Number(a.wins||0)).slice(0,5);
      const richCards=richest.map((u,i)=>{
        const av=u.avatar?`https://cdn.discordapp.com/avatars/${u.userId||u.id}/${u.avatar}.png`:`https://ui-avatars.com/api/?name=${encodeURIComponent(u.username||"U")}&background=0ea5e9&color=fff`;
        return `<div class="vip-card animate-slideUp delay-${i+1}">
          <img class="vip-avatar" src="${av}" onerror="this.src='https://ui-avatars.com/api/?name=${encodeURIComponent(u.username||"U")}&background=0ea5e9&color=fff'" alt="">
          <div style="flex:1;min-width:0">
            <div class="vip-name">${u.username||"غير معروف"}</div>
            <div class="vip-coins">💰 ${Number(u.coins||0).toLocaleString()}</div>
          </div>
          <div class="rank-badge rank-${i+1||""}" style="font-size:18px">${["🥇","🥈","🥉","4️⃣","5️⃣"][i]}</div>
        </div>`;
      }).join("");
      res.send(layout("إحصائيات الكازينو — دايموند كازينو",`
        <div class="page-header animate-slideUp">
          <h1>📊 إحصائيات الكازينو</h1>
          <p>نظرة عامة مباشرة على جميع أنشطة الكازينو</p>
        </div>
        <div class="stats-grid">
          <div class="stat-card delay-1"><div class="sc-icon">👥</div><div class="sc-label">إجمالي اللاعبين</div><div class="sc-value blue" data-count="${totalUsers}">${totalUsers.toLocaleString()}</div></div>
          <div class="stat-card delay-2"><div class="sc-icon">💰</div><div class="sc-label">إجمالي العملات المتداولة</div><div class="sc-value gold" data-count="${totalCoins}">${totalCoins.toLocaleString()}</div></div>
          <div class="stat-card delay-3"><div class="sc-icon">⚽</div><div class="sc-label">إجمالي الرهانات الموضوعة</div><div class="sc-value purple" data-count="${totalBets}">${totalBets.toLocaleString()}</div></div>
          <div class="stat-card delay-4"><div class="sc-icon">🎫</div><div class="sc-label">تذاكر الدعم</div><div class="sc-value" data-count="${ticketCount}">${ticketCount.toLocaleString()}</div></div>
          <div class="stat-card delay-5"><div class="sc-icon">🟢</div><div class="sc-label">التذاكر المفتوحة</div><div class="sc-value green" data-count="${openTickets}">${openTickets.toLocaleString()}</div></div>
          <div class="stat-card delay-1"><div class="sc-icon">💎</div><div class="sc-label">متوسط الثروة</div><div class="sc-value primary" data-count="${totalUsers?Math.floor(totalCoins/totalUsers):0}">${totalUsers?Math.floor(totalCoins/totalUsers).toLocaleString():0}</div></div>
        </div>
        <div class="grid-2" style="gap:20px">
          <div class="card card-glow">
            <div class="card-header"><span class="icon">🏆</span> أغنى اللاعبين</div>
            ${richCards||"<div class='empty-state'><div class='ei'>👥</div><p>لا توجد بيانات بعد</p></div>"}
          </div>
          <div class="card card-glow">
            <div class="card-header"><span class="icon">🎯</span> أفضل الفائزين</div>
            ${topWinners.map((u,i)=>{
              const av=u.avatar?`https://cdn.discordapp.com/avatars/${u.userId||u.id}/${u.avatar}.png`:`https://ui-avatars.com/api/?name=${encodeURIComponent(u.username||"U")}&background=10b981&color=fff`;
              return `<div class="vip-card animate-slideUp delay-${i+1}">
                <img class="vip-avatar" src="${av}" onerror="this.src='https://ui-avatars.com/api/?name=${encodeURIComponent(u.username||"U")}&background=10b981&color=fff'" alt="">
                <div style="flex:1;min-width:0"><div class="vip-name">${u.username||"غير معروف"}</div><div style="font-size:11px;color:var(--text2)">🏆 ${Number(u.wins||0).toLocaleString()} فوز</div></div>
                <div style="font-size:11px;color:var(--green);font-weight:700">${u.wins&&u.losses?Math.round(Number(u.wins)/(Number(u.wins)+Number(u.losses))*100)+"% نسبة الفوز":"—"}</div>
              </div>`;
            }).join("")||"<div class='empty-state'><div class='ei'>🏆</div><p>لا توجد بيانات بعد</p></div>"}
          </div>
        </div>
      `,"/stats",user));
    }catch(e){res.redirect("/?error=stats_error");}
  });

  /* ══════════════════════════════════════════════════════════
     الصفحات التي تمت إزالتها — إعادة توجيه إلى الرئيسية
  ══════════════════════════════════════════════════════════ */
  app.get("/invite",(req,res)=>res.redirect("/"));
  app.get("/widget",(req,res)=>res.redirect("/"));
  app.get("/app",(req,res)=>res.redirect("/"));
  app.get("/season",(req,res)=>res.redirect("/"));
  app.get("/shop",(req,res)=>res.redirect("/"));
  app.get("/missions",(req,res)=>res.redirect("/"));

  /* ══════════════════════════════════════════════════════════
     صفحة دعوة ديسكورد (قديمة — تم الاحتفاظ بها كإعادة توجيه أعلاه)
  ══════════════════════════════════════════════════════════ */
  if(false) app.get("/invite_old",(req,res)=>{
    // ... تمت إزالة الكود
  });

  /* ══════════════════════════════════════════════════════════
     صفحة الموسم / معركة الدوري
  ══════════════════════════════════════════════════════════ */
  app.get("/season", async(req,res)=>{
    const user=req.session?.user||null;
    const settings=loadSettings();
    const tiers=settings.battlePassTiers||[];
    let bp={xp:0,tier:0,claimed:[]};
    if(user) bp=await BattlePass.findOne({userId:user.id}).lean()||bp;
    const claimed=bp.claimed||[];
    const now=new Date();
    const end=settings.seasonEnd?new Date(settings.seasonEnd):null;
    const msLeft=end?Math.max(0,end-now):0;
    const days=Math.floor(msLeft/86400000);
    const hours=Math.floor((msLeft%86400000)/3600000);
    const mins=Math.floor((msLeft%3600000)/60000);
    const tierRows=tiers.map(t=>{
      const pct=Math.min(100,Math.floor((bp.xp/t.xpRequired)*100));
      const done=bp.xp>=t.xpRequired;
      const isClaimed=claimed.includes(t.tier);
      return `<div class="bp-tier ${isClaimed?"bp-claimed":done?"bp-unlocked":"bp-locked"}">
        <div class="bp-tier-num">${t.tier}</div>
        <div class="bp-tier-icon">${t.icon||"🎁"}</div>
        <div class="bp-tier-info">
          <div class="bp-tier-label">${t.label}</div>
          <div class="bp-tier-reward">💰 ${t.reward.toLocaleString()} عملة</div>
          <div class="progress-bar" style="height:4px;margin-top:6px"><div class="progress-fill" style="width:${done?100:pct}%"></div></div>
          <div style="font-size:10px;color:var(--text3);margin-top:3px">${bp.xp.toLocaleString()} / ${t.xpRequired.toLocaleString()} نقطة خبرة</div>
        </div>
        <div class="bp-tier-action">
          ${isClaimed?`<span class="badge badge-gold">✓ تمت المطالبة</span>`:done&&user?`<button class="btn btn-gold btn-sm" onclick="claimTier(${t.tier})">مطالبة!</button>`:`<span class="badge badge-blue">${pct}%</span>`}
        </div>
      </div>`;
    }).join("");
    res.send(layout(`${settings.seasonName||"الموسم"} — دايموند كازينو`,`
      <div class="page-header animate-slideUp">
        <h1>🏆 ${settings.seasonName||"الموسم الحالي"}</h1>
        <p>${settings.seasonDescription||"أكمل التحديات واكسب نقاط الخبرة لفتح مكافآت معركة الدوري!"}</p>
      </div>
      ${end?`<div class="card card-glow" style="margin-bottom:20px;background:linear-gradient(135deg,var(--card),rgba(245,158,11,0.05));border-color:rgba(245,158,11,0.2)">
        <div class="card-header" style="color:var(--gold)"><span class="icon">⏳</span>العد التنازلي للموسم</div>
        <div style="display:flex;gap:16px;flex-wrap:wrap">
          ${[["أيام",days],["ساعات",hours],["دقائق",mins]].map(([l,v])=>`
          <div style="text-align:center;background:var(--bg2);border-radius:var(--radius-sm);padding:16px 24px;min-width:80px">
            <div style="font-family:Rajdhani,Cairo,sans-serif;font-size:36px;font-weight:700;color:var(--gold)">${v}</div>
            <div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:1px">${l}</div>
          </div>`).join("")}
        </div>
      </div>`:""}
      ${user?`<div class="card" style="margin-bottom:20px">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px">
          <div><div style="font-size:12px;color:var(--text3);text-transform:uppercase;letter-spacing:1px">نقاط خبرة معركة الدوري الخاصة بك</div><div style="font-family:Rajdhani,Cairo,sans-serif;font-size:32px;font-weight:700;color:var(--primary)">${bp.xp.toLocaleString()} نقطة خبرة</div></div>
          <div><div style="font-size:12px;color:var(--text3);text-transform:uppercase;letter-spacing:1px">المستوى الحالي</div><div style="font-family:Rajdhani,Cairo,sans-serif;font-size:32px;font-weight:700;color:var(--gold)">المستوى ${bp.tier}</div></div>
          <div><div style="font-size:12px;color:var(--text3);text-transform:uppercase;letter-spacing:1px">تمت المطالبة</div><div style="font-family:Rajdhani,Cairo,sans-serif;font-size:32px;font-weight:700;color:var(--green)">${claimed.length}/${tiers.length}</div></div>
        </div>
      </div>`:`<div class="alert alert-info" style="margin-bottom:20px">🔐 <a href="/auth/discord" style="color:var(--primary);font-weight:700">تسجيل الدخول بديسكورد</a> لتتبع تقدم معركة الدوري!</div>`}
      <div class="card">
        <div class="card-header"><span class="icon">🎁</span>مستويات معركة الدوري</div>
        <div class="bp-tiers">${tierRows||"<div class='empty-state'><div class='ei'>🎁</div><p>لم يتم تكوين مستويات بعد</p></div>"}</div>
      </div>
      <script>
      async function claimTier(tier){
        const res=await fetch('/api/season/claim/'+tier,{method:'POST'});
        const d=await res.json();
        if(d.success){showToast(d.message,'success');setTimeout(()=>location.reload(),1000);}
        else showToast(d.error||'خطأ','error');
      }
      </script>
    `,"/season",user));
  });

  /* ══════════════════════════════════════════════════════════
     صفحة متجر العملات
  ══════════════════════════════════════════════════════════ */
  app.get("/shop", async(req,res)=>{
    const user=req.session?.user||null;
    const settings=loadSettings();
    const items=settings.coinShopItems||[];
    let userCoins=0;
    if(user){const ud=await db.findOne({userId:user.id}).lean();userCoins=Number(ud?.coins||0);}
    const itemCards=items.map(item=>`
      <div class="shop-item-card animate-slideUp">
        <div class="shop-item-emoji">${item.emoji||"🎁"}</div>
        <div class="shop-item-name">${item.label}</div>
        <div class="shop-item-desc">${item.description||""}</div>
        <div class="shop-item-price">💰 ${item.price.toLocaleString()} عملة</div>
        ${user?`<button class="btn btn-gold" style="width:100%;justify-content:center;margin-top:8px" onclick="buyItem('${item.id}','${item.label}',${item.price})" ${userCoins<item.price?"disabled title='ليس لديك عملات كافية'":""}>
          ${userCoins>=item.price?"🛒 اشتر الآن":"🔒 تحتاج "+((item.price-userCoins)).toLocaleString()+" إضافية"}
        </button>`:`<a href="/auth/discord" class="btn btn-discord" style="width:100%;justify-content:center;margin-top:8px">تسجيل الدخول للشراء</a>`}
      </div>
    `).join("");
    res.send(layout("متجر العملات — دايموند كازينو",`
      <div class="page-header animate-slideUp">
        <h1>🛒 متجر العملات</h1>
        <p>أنفق عملاتك التي كسبتها بشق الأنفس على الأدوار والمزايا الحصرية!</p>
      </div>
      ${user?`<div class="card" style="margin-bottom:20px;background:linear-gradient(135deg,var(--card),rgba(245,158,11,0.05));border-color:rgba(245,158,11,0.2);display:flex;align-items:center;gap:16px;flex-wrap:wrap">
        <div style="font-size:36px">💰</div>
        <div><div style="font-size:12px;color:var(--text3);text-transform:uppercase;letter-spacing:1px">رصيدك</div><div style="font-family:Rajdhani,Cairo,sans-serif;font-size:28px;font-weight:700;color:var(--gold)">${userCoins.toLocaleString()} عملة</div></div>
        <a href="/profile/${user.id}" class="btn btn-ghost btn-sm" style="margin-left:auto">عرض الملف الشخصي</a>
      </div>`:""}
      ${items.length?`<div class="shop-grid">${itemCards}</div>`:`<div class="empty-state card"><div class="ei">🛒</div><p>لا توجد عناصر في المتجر بعد.<br><small>يمكن للمشرفين إضافة عناصر من لوحة التحكم.</small></p></div>`}
      <script>
      async function buyItem(id,name,price){
        if(!confirm('شراء '+name+' مقابل '+price.toLocaleString()+' عملة؟'))return;
        const res=await fetch('/api/shop/buy/'+id,{method:'POST'});
        const d=await res.json();
        if(d.success){showToast(d.message,'success');setTimeout(()=>location.reload(),1500);}
        else showToast(d.error||'خطأ','error');
      }
      </script>
    `,"/shop",user));
  });

  /* ══════════════════════════════════════════════════════════
     صفحة تذاكر الدعم
  ══════════════════════════════════════════════════════════ */
  app.get("/tickets", async(req,res)=>{
    const user=req.session?.user||null;
    if(!user) return res.redirect("/auth/discord");
    let tickets=await Ticket.find({userId:user.id}).sort({createdAt:-1}).limit(20).lean();
    const isOwner=SERVER_SETTINGS.users.owners.includes(user.id);
    let adminSection="";
    if(isOwner){
      const allTickets=await Ticket.find().sort({createdAt:-1}).limit(30).lean();
      adminSection=`<div class="card" style="margin-top:24px">
        <div class="card-header" style="color:var(--red)"><span class="icon">🛡️</span> جميع التذاكر (المشرف)</div>
        ${allTickets.length?`<div class="table-wrap"></table><thead><tr><th>المعرف</th><th>المستخدم</th><th>الموضوع</th><th>الفئة</th><th>الحالة</th><th>التاريخ</th><th>الإجراءات</th></tr></thead><tbody>
        ${allTickets.map(t=>`<tr>
          <td><code style="background:var(--bg2);padding:2px 6px;border-radius:4px;font-size:11px">${t.ticketId}</code></td>
          <td>${t.username||t.userId}</td>
          <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${t.subject}</td>
          <td><span class="badge badge-blue">${t.category}</span></td>
          <td><span class="badge ${t.status==="open"?"badge-red":t.status==="answered"?"badge-green":"badge-blue"}">${t.status === "open" ? "مفتوحة" : t.status === "answered" ? "تم الرد" : "مغلقة"}</span></td>
          <td style="font-size:11px;color:var(--text3)">${new Date(t.createdAt).toLocaleDateString()}</td>
          <td style="display:flex;gap:6px;flex-wrap:wrap">
            <button class="btn btn-primary btn-sm" onclick="replyTicket('${t.ticketId}')">رد</button>
            ${t.status!=="closed"?`<button class="btn btn-ghost btn-sm" onclick="adminAction('/api/tickets/close/${t.ticketId}','POST',null,'إغلاق التذكرة؟')">إغلاق</button>`:""}
          </td>
        </tr>`).join("")}
        </tbody></table></div>`:`<div class="empty-state"><div class="ei">🎫</div><p>لا توجد تذاكر بعد</p></div>`}
      </div>
      <div id="replyModal" class="modal-bg">
        <div class="modal-box">
          <div class="modal-title">الرد على التذكرة</div>
          <input type="hidden" id="replyTicketId">
          <div class="form-group"><label>ردك</label><textarea class="form-textarea" id="replyText" rows="4" placeholder="اكتب ردك..."></textarea></div>
          <div style="display:flex;gap:8px;justify-content:flex-end">
            <button class="btn btn-ghost" onclick="closeModal('replyModal')">إلغاء</button>
            <button class="btn btn-primary" onclick="sendReply()">إرسال الرد</button>
          </div>
        </div>
      </div>
      <script>
      function replyTicket(id){document.getElementById('replyTicketId').value=id;document.getElementById('replyText').value='';openModal('replyModal');}
      async function sendReply(){
        const id=document.getElementById('replyTicketId').value;
        const reply=document.getElementById('replyText').value.trim();
        if(!reply)return showToast('أدخل ردًا','تحذير');
        const res=await fetch('/api/tickets/reply/'+id,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reply})});
        const d=await res.json();
        if(d.success){showToast('تم إرسال الرد!','success');closeModal('replyModal');setTimeout(()=>location.reload(),800);}
        else showToast(d.error||'خطأ','error');
      }
      </script>`;
    }
    const statusBadge={open:"badge-red",answered:"badge-green",closed:"badge-blue"};
    res.send(layout("تذاكر الدعم — دايموند كازينو",`
      <div class="page-header animate-slideUp">
        <h1>🎫 تذاكر الدعم</h1>
        <p>أنشئ تذكرة وسيرد فريقنا في أقرب وقت ممكن</p>
      </div>
      <div class="grid-2" style="gap:20px;align-items:start">
        <div>
          <div class="card card-glow" style="margin-bottom:20px">
            <div class="card-header"><span class="icon">➕</span> إنشاء تذكرة جديدة</div>
            <div class="form-group">
              <label>الفئة</label>
              <select class="form-select" id="ticketCategory">
                <option value="general">عام</option>
                <option value="bug">الإبلاغ عن خطأ</option>
                <option value="coins">مشكلة في العملات</option>
                <option value="ban">الاستئناف على الحظر</option>
                <option value="other">أخرى</option>
              </select>
            </div>
            <div class="form-group"><label>الموضوع</label><input class="form-input" id="ticketSubject" placeholder="ملخص موجز لمشكلتك" maxlength="100"></div>
            <div class="form-group"><label>الرسالة</label><textarea class="form-textarea" id="ticketMessage" rows="5" placeholder="صِف مشكلتك بالتفصيل..." maxlength="1000"></textarea></div>
            <button class="btn btn-primary" style="width:100%;justify-content:center" onclick="createTicket()">🎫 إرسال التذكرة</button>
          </div>
        </div>
        <div class="card">
          <div class="card-header"><span class="icon">📋</span> تذاكرك</div>
          ${tickets.length?tickets.map(t=>`
          <div style="border:1px solid var(--border);border-radius:var(--radius-sm);padding:14px;margin-bottom:10px;transition:all 0.2s" onmouseover="this.style.borderColor='var(--border2)'" onmouseout="this.style.borderColor='var(--border)'">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap">
              <code style="font-size:11px;background:var(--bg2);padding:2px 6px;border-radius:4px">${t.ticketId}</code>
              <span class="badge ${statusBadge[t.status]||"badge-blue"}">${t.status === "open" ? "مفتوحة" : t.status === "answered" ? "تم الرد" : "مغلقة"}</span>
              <span class="badge badge-blue">${t.category}</span>
              <span style="font-size:10px;color:var(--text3);margin-left:auto">${new Date(t.createdAt).toLocaleDateString()}</span>
            </div>
            <div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:4px">${t.subject}</div>
            <div style="font-size:12px;color:var(--text2)">${t.message.slice(0,80)}${t.message.length>80?"...":""}</div>
            ${t.reply?`<div style="background:var(--bg2);border-radius:var(--radius-sm);padding:10px;margin-top:10px;border-left:3px solid var(--green)"><div style="font-size:10px;color:var(--text3);margin-bottom:4px">رد الموظفين (${t.repliedBy||"مشرف"})</div><div style="font-size:12px;color:var(--text2)">${t.reply}</div></div>`:""}
          </div>`).join(""):`<div class="empty-state"><div class="ei">🎫</div><p>لا توجد تذاكر بعد.<br>أنشئ واحدة إذا كنت بحاجة إلى مساعدة!</p></div>`}
        </div>
      </div>
      ${adminSection}
      <script>
      async function createTicket(){
        const subject=document.getElementById('ticketSubject').value.trim();
        const message=document.getElementById('ticketMessage').value.trim();
        const category=document.getElementById('ticketCategory').value;
        if(!subject||!message){showToast('يرجى ملء جميع الحقول','تحذير');return;}
        const res=await fetch('/api/tickets/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subject,message,category})});
        const d=await res.json();
        if(d.success){showToast('تم إنشاء التذكرة! المعرف: '+d.ticketId,'success');setTimeout(()=>location.reload(),1200);}
        else showToast(d.error||'خطأ','error');
      }
      </script>
    `,"/tickets",user));
  });

  /* ══════════════════════════════════════════════════════════
     صفحة تنزيل تطبيق الهاتف المحمول
  ══════════════════════════════════════════════════════════ */
  app.get("/app",(req,res)=>{
    const user=req.session?.user||null;
    res.send(layout("تطبيق الهاتف المحمول — دايموند كازينو",`
      <div style="min-height:70vh;display:flex;align-items:center;justify-content:center;padding:40px 0">
        <div style="max-width:600px;width:100%;text-align:center">
          <div style="font-size:80px;animation:float 3s ease-in-out infinite;margin-bottom:16px">📱</div>
          <h1 style="font-family:Rajdhani,Cairo,sans-serif;font-size:40px;font-weight:700;background:linear-gradient(135deg,var(--primary),var(--gold));-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:8px">تطبيق دايموند كازينو</h1>
          <p style="color:var(--text2);font-size:16px;margin-bottom:32px">خذ الكازينو أينما تذهب. تجربة الهاتف المحمول كاملة الميزات قريبًا!</p>
          <div class="card" style="padding:32px;margin-bottom:24px">
            <div class="alert alert-info" style="margin-bottom:24px">🚧 تطبيق الهاتف المحمول قيد التطوير حاليًا. كن أول من يعلم عند إطلاقه!</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:28px">
              ${[["📱","متعدد المنصات","متوفر على iOS و Android"],["🔔","الإشعارات الفورية","احصل على إشعارات حول الألعاب والأحداث"],["💰","الوصول الكامل للكازينو","جميع الألعاب متاحة على الهاتف المحمول"],["🔒","تسجيل دخول آمن","OAuth ديسكورد مع دعم القياسات الحيوية"]].map(([e,t,d])=>`
              <div style="background:var(--bg2);border-radius:var(--radius-sm);padding:16px;text-align:left">
                <div style="font-size:28px;margin-bottom:8px">${e}</div>
                <div style="font-weight:600;font-size:13px;color:var(--text);margin-bottom:4px">${t}</div>
                <div style="font-size:12px;color:var(--text2)">${d}</div>
              </div>`).join("")}
            </div>
            <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap">
              <a href="/invite" class="btn btn-discord btn-lg" style="flex:1;min-width:160px;justify-content:center">انضم إلى ديسكورد للتحديثات</a>
              <a href="/tickets" class="btn btn-ghost btn-lg" style="flex:1;min-width:160px;justify-content:center">طلب الوصول التجريبي</a>
            </div>
          </div>
          <p style="font-size:12px;color:var(--text3)">في غضون ذلك، الموقع محسّن بالكامل لمتصفحات الهاتف المحمول!</p>
        </div>
      </div>
    `,"/app",user));
  });

  /* ══════════════════════════════════════════════════════════
     صفحة أداة ديسكورد المضمنة
  ══════════════════════════════════════════════════════════ */
  app.get("/widget",(req,res)=>{
    const user=req.session?.user||null;
    const settings=loadSettings();
    const guildId=settings.guildId||"1310292274801938553";
    res.send(layout("أداة ديسكورد المضمنة — دايموند كازينو",`
      <div class="page-header animate-slideUp">
        <h1>📡 أداة ديسكورد المضمنة</h1>
        <p>معاينة مباشرة لخادم ديسكورد الخاص بنا — شاهد المتصلين!</p>
      </div>
      <div class="grid-2" style="gap:20px;align-items:start">
        <div class="card card-glow">
          <div class="card-header"><span class="icon">💻</span> أداة الخادم</div>
          <iframe src="https://discord.com/widget?id=${guildId}&theme=dark" width="100%" height="400" allowtransparency="true" frameborder="0" sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts" style="border-radius:var(--radius-sm)"></iframe>
        </div>
        <div>
          <div class="card card-glow" style="margin-bottom:16px">
            <div class="card-header"><span class="icon">🔗</span> تضمين في موقعك</div>
            <p style="font-size:13px;color:var(--text2);margin-bottom:12px">انسخ هذا الرمز لتضمين أداة ديسكورد الخاصة بنا على أي موقع ويب:</p>
            <div style="background:var(--bg2);border-radius:var(--radius-sm);padding:12px;font-family:monospace;font-size:11px;color:var(--primary);word-break:break-all;line-height:1.8">
              &lt;iframe src="https://discord.com/widget?id=${guildId}&theme=dark" width="350" height="500" allowtransparency="true" frameborder="0"&gt;&lt;/iframe&gt;
            </div>
            <button class="btn btn-ghost btn-sm" style="margin-top:10px" onclick="copyText('&lt;iframe src=&quot;https://discord.com/widget?id=${guildId}&amp;theme=dark&quot; width=&quot;350&quot; height=&quot;500&quot; allowtransparency=&quot;true&quot; frameborder=&quot;0&quot;&gt;&lt;/iframe&gt;')">📋 نسخ الرمز</button>
          </div>
          <div class="card card-glow">
            <div class="card-header"><span class="icon">📨</span> انضم إلينا</div>
            <p style="font-size:13px;color:var(--text2);margin-bottom:16px">هل تريد الانضمام إلى الخادم مباشرة؟</p>
            <a href="/invite" class="btn btn-discord" style="width:100%;justify-content:center">🎮 انضم إلى خادم دايموند كازينو</a>
          </div>
        </div>
      </div>
    `,"/widget",user));
  });

  /* ══════════════════════════════════════════════════════════
     صفحة إعدادات الأمان
  ══════════════════════════════════════════════════════════ */
  app.get("/security", requireLogin, async(req,res)=>{
    const user=req.session?.user||null;
    const ud=await db.findOne({userId:user.id}).lean();
    const sessions=req.session?.loginHistory||[];
    res.send(layout("الأمان — دايموند كازينو",`
      <div class="page-header animate-slideUp">
        <h1>🔐 إعدادات الأمان</h1>
        <p>إدارة أمان حسابك وخصوصيتك</p>
      </div>
      <div class="grid-2" style="gap:20px;align-items:start">
        <div>
          <div class="card card-glow" style="margin-bottom:16px">
            <div class="card-header"><span class="icon">👤</span> نظرة عامة على الحساب</div>
            <div style="display:flex;align-items:center;gap:14px;margin-bottom:16px">
              <img src="${user.avatar?`https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`:`https://ui-avatars.com/api/?name=${encodeURIComponent(user.username)}&background=0ea5e9&color=fff`}" style="width:60px;height:60px;border-radius:50%;border:2px solid var(--primary)" alt="">
              <div>
                <div style="font-weight:700;font-size:16px">${user.username}</div>
                <div style="font-size:12px;color:var(--text3)">المعرف: ${user.id}</div>
                <div class="live-dot" style="margin-top:6px">الجلسة نشطة</div>
              </div>
            </div>
            <div style="border-top:1px solid var(--border);padding-top:14px">
              <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)">
                <span style="font-size:13px;color:var(--text2)">مصادقة ديسكورد</span><span class="badge badge-green">✓ تم التحقق</span>
              </div>
              <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0">
                <span style="font-size:13px;color:var(--text2)">رصيد الحساب</span><span style="font-weight:700;color:var(--gold)">💰 ${Number(ud?.coins||0).toLocaleString()}</span>
              </div>
            </div>
          </div>
          <div class="card card-glow">
            <div class="card-header" style="color:var(--red)"><span class="icon">⚠️</span> منطقة الخطر</div>
            <p style="font-size:13px;color:var(--text2);margin-bottom:16px">هذه الإجراءات دائمة ولا يمكن التراجع عنها.</p>
            <a href="/auth/logout" class="btn btn-danger" style="width:100%;justify-content:center;margin-bottom:10px">🚪 تسجيل الخروج</a>
            <button class="btn btn-ghost" style="width:100%;justify-content:center" onclick="showToast('اتصل بمشرف لحذف حسابك','معلومات')">🗑️ طلب حذف الحساب</button>
          </div>
        </div>
        <div>
          <div class="card card-glow" style="margin-bottom:16px">
            <div class="card-header"><span class="icon">🔒</span> نصائح الخصوصية</div>
            ${[["لا تشارك رصيد عملاتك علنًا إذا كنت لا تريد أن تكون هدفًا","💡"],["أبلغ عن السلوك المشبوه للمشرفين عبر نظام التذاكر","🎫"],["حساب ديسكورد الخاص بك هو تسجيل الدخول الخاص بك — احتفظ به آمنًا باستخدام المصادقة الثنائية","🛡️"],["سجل الخروج من الأجهزة المشتركة بعد استخدام موقع الكازينو","🖥️"]].map(([t,e])=>`<div style="display:flex;gap:10px;padding:10px 0;border-bottom:1px solid var(--border)"><span>${e}</span><span style="font-size:13px;color:var(--text2)">${t}</span></div>`).join("")}
          </div>
          <div class="card card-glow">
            <div class="card-header"><span class="icon">📜</span> روابط سريعة</div>
            <div style="display:flex;flex-direction:column;gap:8px">
              <a href="/profile/${user.id}" class="btn btn-ghost" style="justify-content:flex-start">👤 عرض الملف الشخصي</a>
              <a href="/customization" class="btn btn-ghost" style="justify-content:flex-start">🎨 تخصيص الملف الشخصي</a>
              <a href="/tickets" class="btn btn-ghost" style="justify-content:flex-start">🎫 تذاكر الدعم</a>
              <a href="/invite" class="btn btn-discord" style="justify-content:flex-start">خادم ديسكورد</a>
            </div>
          </div>
        </div>
      </div>
    `,"/security",user));
  });

  /* ══════════════════════════════════════════════════════════
     ملحق إعدادات الموقع للمشرف
  ══════════════════════════════════════════════════════════ */
  app.get("/admin/settings", requireOwner, (req,res)=>{
    const user=req.session?.user||null;
    const settings=loadSettings();
    const themeEntries = Object.values(settings.themes || {});
    const shopItems=settings.coinShopItems||[];
    res.send(layout("إعدادات الموقع — مشرف",`
      <div class="page-header animate-slideUp">
        <h1>⚙️ إعدادات الموقع</h1>
        <p>التحكم في جميع ميزات موقع دايموند كازينو من هنا</p>
      </div>
      <div class="grid-2" style="gap:20px;align-items:start">
        <div>
          <div class="card card-glow" style="margin-bottom:16px">
            <div class="card-header"><span class="icon">🏆</span> إعدادات الموسم</div>
            <div class="form-group"><label>اسم الموسم</label><input class="form-input" id="seasonName" value="${settings.seasonName||""}" placeholder="اسم الموسم"></div>
            <div class="form-group"><label>تاريخ انتهاء الموسم</label><input class="form-input" id="seasonEnd" type="datetime-local" value="${settings.seasonEnd?new Date(settings.seasonEnd).toISOString().slice(0,16):""}"></div>
            <div class="form-group"><label>وصف الموسم</label><textarea class="form-textarea" id="seasonDesc" rows="2">${settings.seasonDescription||""}</textarea></div>
            <div class="form-group"><label style="display:flex;align-items:center;gap:10px;cursor:pointer"><input type="checkbox" id="bpActive" ${settings.battlePassActive?"checked":""}> معركة الدوري نشطة</label></div>
            <button class="btn btn-primary" style="width:100%;justify-content:center" onclick="saveSettings()">💾 حفظ إعدادات الموسم</button>
          </div>
          <div class="card card-glow">
            <div class="card-header"><span class="icon">🔗</span> إعدادات ديسكورد والموقع</div>
            <div class="form-group"><label>رمز دعوة ديسكورد (بدون discord.gg/)</label><input class="form-input" id="inviteCode" value="${settings.discordInviteCode||""}" placeholder="مثال: abc123"></div>
            <div class="form-group"><label>لافتة الإعلان (فارغ = إخفاء)</label><input class="form-input" id="annBanner" value="${settings.announcementBanner||""}" placeholder="نص الإعلان الاختياري"></div>
            <div class="form-group"><label style="display:flex;align-items:center;gap:10px;cursor:pointer"><input type="checkbox" id="soundEnabled" ${settings.soundEnabled?"checked":""}> تأثيرات الصوت مفعلة</label></div>
            <button class="btn btn-primary" style="width:100%;justify-content:center" onclick="saveSiteSettings()">💾 حفظ إعدادات الموقع</button>
          </div>
        </div>
        <div>
          <div class="card card-glow" style="margin-bottom:16px">
            <div class="card-header"><span class="icon">🛒</span> عناصر متجر العملات</div>
            ${shopItems.length?shopItems.map(item=>`<div style="background:var(--bg2);border-radius:var(--radius-sm);padding:12px;margin-bottom:8px;display:flex;align-items:center;gap:10px">
              <span style="font-size:24px">${item.emoji||"🎁"}</span>
              <div style="flex:1;min-width:0"><div style="font-weight:600;font-size:13px">${item.label}</div><div style="font-size:11px;color:var(--text2)">${item.price.toLocaleString()} عملة</div></div>
              <button class="btn btn-danger btn-sm" onclick="adminAction('/api/admin/shop-item/${item.id}','DELETE',null,'إزالة عنصر المتجر؟')">✕</button>
            </div>`).join(""):`<div class="empty-state" style="padding:20px"><div class="ei" style="font-size:32px">🛒</div><p style="font-size:12px">لا توجد عناصر بعد</p></div>`}
            <div style="border-top:1px solid var(--border);padding-top:16px;margin-top:8px">
              <div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:12px">إضافة عنصر جديد</div>
              <div class="grid-2" style="gap:10px">
                <div class="form-group" style="margin:0"><input class="form-input" id="shopId" placeholder="المعرف (بدون مسافات)"></div>
                <div class="form-group" style="margin:0"><input class="form-input" id="shopEmoji" placeholder="رمز تعبيري مثل 💎"></div>
                <div class="form-group" style="margin:0"><input class="form-input" id="shopLabel" placeholder="الاسم"></div>
                <div class="form-group" style="margin:0"><input class="form-input" id="shopPrice" type="number" placeholder="السعر بالعملات"></div>
              </div>
              <div class="form-group" style="margin:8px 0"><input class="form-input" id="shopDesc" placeholder="الوصف"></div>
              <div class="form-group"><input class="form-input" id="shopRoleId" placeholder="معرف دور ديسكورد (اختياري — يمنح الدور عند الشراء)"></div>
              <button class="btn btn-gold" style="width:100%;justify-content:center" onclick="addShopItem()">➕ إضافة عنصر</button>
            </div>
          </div>
          <div class="card card-glow" style="margin-bottom:16px">
            <div class="card-header"><span class="icon">🏅</span> إضافة نقاط خبرة معركة الدوري</div>
            <div class="form-group"><label>معرف اللاعب</label><input class="form-input" id="bpUserId" placeholder="معرف مستخدم ديسكورد"></div>
            <div class="form-group"><label>مقدار نقاط الخبرة</label><input class="form-input" id="bpXpAmount" type="number" placeholder="مثال: 100" value="100"></div>
            <button class="btn btn-gold" style="width:100%;justify-content:center" onclick="addBpXp()">⚡ إضافة نقاط خبرة</button>
          </div>
          <div class="card card-glow" style="border-color:rgba(139,92,246,0.3);background:linear-gradient(135deg,var(--card),rgba(139,92,246,0.05))">
            <div class="card-header" style="color:#a78bfa"><span class="icon">🎨</span> سمة الموقع (للمالك فقط)</div>
            <p style="font-size:13px;color:var(--text2);margin-bottom:16px">قم بتبديل الموقع بالكامل بين السمات الأصلية، ريزيرو، وتشينسو مان (ريزي).</p>
            <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-bottom:16px">
              <button class="btn ${settings.activeTheme==='original'||!settings.activeTheme?'btn-primary':'btn-ghost'}" id="themeOrigBtn" onclick="setTheme('original')" style="flex-direction:column;gap:4px;padding:16px;height:auto">
                <div style="font-size:20px">💎</div>
                <div style="font-size:13px;font-weight:700">السمة الأصلية</div>
                <div style="font-size:11px;opacity:0.7">دايموند كازينو الكلاسيكي</div>
                ${settings.activeTheme==='original'||!settings.activeTheme?'<span class="badge badge-green" style="margin-top:4px">✓ نشطة</span>':""}
              </button>
              <button class="btn ${settings.activeTheme==='rezero'?'btn-primary':'btn-ghost'}" id="themeRzBtn" onclick="setTheme('rezero')" style="flex-direction:column;gap:4px;padding:16px;height:auto;${settings.activeTheme==='rezero'?'background:linear-gradient(135deg,#7c3aed,#a855f7);':''}">
                <div style="font-size:20px">⚔️</div>
                <div style="font-size:13px;font-weight:700">سمة ريزيرو</div>
                <div style="font-size:11px;opacity:0.7">بلورية أرجوانية داكنة</div>
                ${settings.activeTheme==='rezero'?'<span class="badge badge-green" style="margin-top:4px">✓ نشطة</span>':""}
              </button>
              <button class="btn ${settings.activeTheme==='chainsaw'?'btn-primary':'btn-ghost'}" id="themeCmBtn" onclick="setTheme('chainsaw')" style="flex-direction:column;gap:4px;padding:16px;height:auto;${settings.activeTheme==='chainsaw'?'background:linear-gradient(135deg,#991b1b,#ef4444);':''}">
                <div style="font-size:20px">💣</div>
                <div style="font-size:13px;font-weight:700">سمة تشينسو</div>
                <div style="font-size:11px;opacity:0.7">أحمر/أسود ريزي</div>
                ${settings.activeTheme==='chainsaw'?'<span class="badge badge-green" style="margin-top:4px">✓ نشطة</span>':""}
              </button>
            </div>
            <div style="font-size:11px;color:var(--text3);text-align:center">تغيير السمة يسري فورًا لجميع المستخدمين — لا حاجة لإعادة التشغيل</div>
          </div>
          <div class="card card-glow" style="margin-top:16px">
            <div class="card-header"><span class="icon">🧩</span> إدارة الثيمات والبنرات</div>
            <div style="font-size:12px;color:var(--text2);margin-bottom:10px">يمكنك إضافة ثيم جديد وتحديد ألوانه والبنر الخاص به و صفحة الدولاب المرتبطة به.</div>
            <div style="max-height:220px;overflow:auto;margin-bottom:14px">
              ${themeEntries.map(t=>`
                <div style="border:1px solid var(--border);border-radius:10px;padding:10px;margin-bottom:8px">
                  <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
                    <div style="font-weight:700">${esc(t.name)} <span style="font-size:11px;color:var(--text3)">(${esc(t.key)})</span></div>
                    <button class="btn btn-sm ${settings.activeTheme===t.key?'btn-primary':'btn-ghost'}" onclick="setTheme('${esc(t.key)}')">تفعيل</button>
                  </div>
                  <div style="font-size:11px;color:var(--text3);margin-top:4px">Banner: <code>${esc(t.bannerFile||'luckbanner.png')}</code> · Spin: <code>${esc(t.spinPage||'none')}</code></div>
                </div>
              `).join("")}
            </div>
            <div class="grid-2" style="gap:10px">
              <div class="form-group" style="margin:0"><input class="form-input" id="thKey" placeholder="theme_key (مثال: neon)"></div>
              <div class="form-group" style="margin:0"><input class="form-input" id="thName" placeholder="اسم الثيم"></div>
              <div class="form-group" style="margin:0"><input class="form-input" id="thPrimary" value="#0ea5e9" placeholder="#0ea5e9"></div>
              <div class="form-group" style="margin:0"><input class="form-input" id="thAccent" value="#8b5cf6" placeholder="#8b5cf6"></div>
              <div class="form-group" style="margin:0"><input class="form-input" id="thBgStart" value="#0b1020" placeholder="#0b1020"></div>
              <div class="form-group" style="margin:0"><input class="form-input" id="thBgEnd" value="#121a2f" placeholder="#121a2f"></div>
              <div class="form-group" style="margin:0"><input class="form-input" id="thCard" value="#151d2f" placeholder="#151d2f"></div>
              <div class="form-group" style="margin:0"><input class="form-input" id="thText" value="#e5e7eb" placeholder="#e5e7eb"></div>
              <div class="form-group" style="margin:0"><input class="form-input" id="thBanner" placeholder="اسم ملف البنر (مثال: mybanner.png)"></div>
              <div class="form-group" style="margin:0">
                <select class="form-select" id="thSpin">
                  <option value="none">بدون دولاب</option>
                  <option value="rezero">دولاب ريزيرو</option>
                  <option value="chainsaw">دولاب تشينسو</option>
                </select>
              </div>
            </div>
            <button class="btn btn-gold" style="width:100%;justify-content:center;margin-top:10px" onclick="saveThemeConfig()">💾 حفظ/إضافة الثيم</button>
          </div>
        </div>
      </div>
      <script>
      function saveSettings(){
        adminAction('/api/admin/settings','POST',{
          seasonName:document.getElementById('seasonName').value,
          seasonEnd:document.getElementById('seasonEnd').value,
          seasonDescription:document.getElementById('seasonDesc').value,
          battlePassActive:document.getElementById('bpActive').checked.toString()
        },'');
      }
      function saveSiteSettings(){
        adminAction('/api/admin/settings','POST',{
          discordInviteCode:document.getElementById('inviteCode').value,
          announcementBanner:document.getElementById('annBanner').value,
          soundEnabled:document.getElementById('soundEnabled').checked.toString()
        },'');
      }
      async function setTheme(theme){
        const r = await fetch('/api/admin/theme',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({theme})});
        const d = await r.json();
        if(r.ok){ showToast('تم تحديث السمة — إعادة التحميل...','success'); setTimeout(()=>location.reload(),1000); }
        else showToast(d.error||'فشل','error');
      }
      async function saveThemeConfig(){
        const payload = {
          key: document.getElementById('thKey').value.trim(),
          name: document.getElementById('thName').value.trim(),
          primary: document.getElementById('thPrimary').value.trim(),
          accent: document.getElementById('thAccent').value.trim(),
          bgStart: document.getElementById('thBgStart').value.trim(),
          bgEnd: document.getElementById('thBgEnd').value.trim(),
          card: document.getElementById('thCard').value.trim(),
          text: document.getElementById('thText').value.trim(),
          bannerFile: document.getElementById('thBanner').value.trim(),
          spinPage: document.getElementById('thSpin').value
        };
        const r = await fetch('/api/admin/theme-config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
        const d = await r.json();
        if(r.ok && d.success){ showToast('تم حفظ الثيم','success'); setTimeout(()=>location.reload(),900); }
        else showToast(d.error||'فشل حفظ الثيم','error');
      }
      function addShopItem(){
        const id=document.getElementById('shopId').value.trim().replace(/\s+/g,'_');
        const label=document.getElementById('shopLabel').value.trim();
        const price=document.getElementById('shopPrice').value;
        const emoji=document.getElementById('shopEmoji').value.trim();
        const desc=document.getElementById('shopDesc').value.trim();
        const roleId=document.getElementById('shopRoleId').value.trim();
        if(!id||!label||!price){showToast('املأ المعرف والاسم والسعر','تحذير');return;}
        adminAction('/api/admin/shop-item','POST',{id,label,price,emoji,description:desc,roleId},'');
      }
      async function addBpXp(){
        const userId=document.getElementById('bpUserId').value.trim();
        const xp=document.getElementById('bpXpAmount').value;
        if(!userId||!xp){showToast('املأ معرف المستخدم ونقاط الخبرة','تحذير');return;}
        adminAction('/api/season/add-xp','POST',{userId,xp},'إضافة '+xp+' نقطة خبرة إلى '+userId+'؟');
      }
      </script>
    `,"/admin/settings",user));
  });

  /* ── واجهة برمجة تطبيقات سمة المشرف ─────────────────────────────────────── */
  app.post("/api/admin/theme", requireOwner, (req,res)=>{
    const { theme } = req.body;
    const settings = loadSettings();
    if(!settings.themes?.[theme]) return res.status(400).json({error:"سمة غير صالحة"});
    settings.activeTheme = theme;
    saveSettings(settings);
    res.json({ok:true, theme});
  });

  app.post("/api/admin/theme-config", requireOwner, (req,res)=>{
    const {
      key, name, primary, accent, bgStart, bgEnd, card, text, bannerFile, spinPage
    } = req.body || {};

    if (!key || !/^[a-z0-9_-]{2,32}$/i.test(key)) {
      return res.status(400).json({ error: "معرف الثيم غير صالح (2-32 أحرف/أرقام)" });
    }

    const settings = loadSettings();
    settings.themes = settings.themes || normalizeSiteThemes(settings);
    const old = settings.themes[key] || { key };
    settings.themes[key] = mergeThemeWithDefaults({
      ...old,
      key,
      name: name || old.name || key,
      primary: primary || old.primary,
      accent: accent || old.accent,
      bgStart: bgStart || old.bgStart,
      bgEnd: bgEnd || old.bgEnd,
      card: card || old.card,
      text: text || old.text,
      bannerFile: bannerFile || old.bannerFile || "luckbanner.png",
      spinPage: ["none","rezero","chainsaw"].includes(spinPage) ? spinPage : (old.spinPage || "none"),
    });
    saveSettings(settings);
    res.json({ success:true, message:"تم حفظ الثيم", key });
  });

  /* ══════════════════════════════════════════════════════════
     مسارات الشطرنج
  ══════════════════════════════════════════════════════════ */
  require('./chessWebRoutes')(app, { db, discordClient, SERVER_SETTINGS, siteLog, payoutFn, layout });

  /* ══════════════════════════════════════════════════════════
     مسارات Crash
  ══════════════════════════════════════════════════════════ */
  try {
    require('./crashWebRoutes')(app, { db, siteLog, layout });
  } catch(e){ console.error('[Crash Routes]', e.message); }

  /* ══════════════════════════════════════════════════════════
     مسارات Piano Tiles
  ══════════════════════════════════════════════════════════ */
  try {
    require('./pianoWebRoutes')(app, { db, siteLog, layout, SERVER_SETTINGS });
  } catch(e){ console.error('[Piano Routes]', e.message); }

  /* ══════════════════════════════════════════════════════════
     مسارات Mines
  ══════════════════════════════════════════════════════════ */
  try {
    require('./minesWebRoutes')(app, { db, siteLog, layout });
  } catch(e){ console.error('[Mines Routes]', e.message); }

  /* ══════════════════════════════════════════════════════════
     مسارات ركلات الترجيح
  ══════════════════════════════════════════════════════════ */
  require('./penaltyWebRoutes')(app, { db, discordClient, SERVER_SETTINGS, siteLog, payoutFn, layout });

  /* ══════════════════════════════════════════════════════════
     مسارات الباركور
  ══════════════════════════════════════════════════════════ */
  try {
    require('./parkourWebRoutes')(app, { db, discordClient, SERVER_SETTINGS, siteLog, payoutFn, layout });
  } catch(e){ console.error('[Parkour Routes]', e.message); }

  /* ══════════════════════════════════════════════════════════
     مسارات حفلة المشاهدة
  ══════════════════════════════════════════════════════════ */
  require('./watchRoutes')(app, { db, discordClient, layout, siteLog });

  app.get('/watch', (req, res) => {
    const user = req.session?.user||null;
    res.send(layout('🎬 حفلة المشاهدة', `
      <div class="page-header animate-slideUp">
        <h1>🎬 حفلة المشاهدة</h1>
        <p>شاهد الأفلام والمسلسلات مع أصدقائك في الوقت الفعلي!</p>
      </div>
      <div style="max-width:660px;margin:0 auto">
        <div class="card card-glow animate-slideUp" style="margin-bottom:20px">
          <div class="card-header"><span class="icon">🚀</span> كيفية البدء</div>
          <div style="color:var(--text2);line-height:2.4;font-size:14px">
            <div>1️⃣ اذهب إلى خادم ديسكورد الخاص بك</div>
            <div>2️⃣ استخدم <code style="background:var(--bg3);padding:3px 8px;border-radius:6px;color:var(--primary)">!watch @friend اسم الفيلم</code></div>
            <div>3️⃣ يقبل صديقك الدعوة في ديسكورد</div>
            <div>4️⃣ يفتح كل منكما رابط غرفة المشاهدة</div>
            <div>5️⃣ الصق رابط يوتيوب وابدأ المشاهدة معًا!</div>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
          <div class="card card-glow animate-slideUp" style="text-align:center;padding:24px">
            <div style="font-size:40px;margin-bottom:10px">🎥</div>
            <div style="font-weight:700;font-size:14px;color:var(--text)">تشغيل متزامن</div>
            <div style="font-size:12px;color:var(--text2);margin-top:4px">التشغيل والإيقاف المؤقت والبحث معًا تلقائيًا</div>
          </div>
          <div class="card card-glow animate-slideUp" style="text-align:center;padding:24px">
            <div style="font-size:40px;margin-bottom:10px">💬</div>
            <div style="font-weight:700;font-size:14px;color:var(--text)">دردشة مباشرة</div>
            <div style="font-size:12px;color:var(--text2);margin-top:4px">علق وتفاعل أثناء المشاهدة</div>
          </div>
          <div class="card card-glow animate-slideUp" style="text-align:center;padding:24px">
            <div style="font-size:40px;margin-bottom:10px">🔗</div>
            <div style="font-weight:700;font-size:14px;color:var(--text)">غرفة خاصة</div>
            <div style="font-size:12px;color:var(--text2);margin-top:4px">أنت وصديقك فقط، لا أحد آخر</div>
          </div>
          <div class="card card-glow animate-slideUp" style="text-align:center;padding:24px">
            <div style="font-size:40px;margin-bottom:10px">🍿</div>
            <div style="font-weight:700;font-size:14px;color:var(--text)">دعم يوتيوب</div>
            <div style="font-size:12px;color:var(--text2);margin-top:4px">الصق أي رابط يوتيوب لتحميل الفيديو</div>
          </div>
        </div>
        <div class="card card-glow animate-slideUp" style="margin-top:20px;text-align:center;padding:28px">
          <div style="font-size:48px;margin-bottom:12px">🤖</div>
          <div style="font-size:16px;font-weight:700;color:var(--text);margin-bottom:6px">ابدأ عبر بوت ديسكورد</div>
          <div style="font-size:13px;color:var(--text2);margin-bottom:16px">يتم إنشاء حفلات المشاهدة من خلال أمر البوت</div>
          <code style="background:var(--bg3);padding:10px 18px;border-radius:8px;color:var(--primary);font-size:15px">!watch @friend عنوان الفيلم</code>
        </div>
      </div>
    `, '/watch', user));
  });

  /* ══════════════════════════════════════════════════════════
     404
  ══════════════════════════════════════════════════════════ */
  /* ── 404 ──────────────────────────────────────────────────── */
  app.use((req,res)=>{
    const user=req.session?.user||null;
    res.status(404).send(layout("غير موجود",`
      <div class="empty-state" style="padding:80px 20px">
        <div class="ei" style="font-size:80px">💎</div>
        <h2 style="font-family:Rajdhani,Cairo,sans-serif;font-size:32px;color:var(--primary);margin-bottom:8px">404 — الصفحة غير موجودة</h2>
        <p style="margin-bottom:24px">هذه الصفحة غير موجودة في كازينونا</p>
        <a href="/" class="btn btn-primary btn-lg">🏠 العودة للرئيسية</a>
      </div>
    `,"",user));
  });

  console.log("💎 تم تهيئة موقع دايموند كازينو");
};

