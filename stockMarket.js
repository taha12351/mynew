/* ═══════════════════════════════════════════════════════════════════
   📈 DIAMOND CASINO — STOCK MARKET SYSTEM
   سوق الأسهم — نظام تداول الأسهم
═══════════════════════════════════════════════════════════════════ */

const Discord        = require('discord.js');
const StockPortfolio = require('./models/stockPortfolio');
const fs             = require('fs');
const path           = require('path');

// ── Injected from index.js via init() ────────────────────────────
let _client, _db, _SERVER;

// ── Read live tax rate from config.json (respects !settax) ───────
function getTaxRate() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
    return typeof cfg.taxRate === 'number' ? cfg.taxRate : 0.04;
  } catch { return 0.04; }
}

// ── Stock Definitions ────────────────────────────────────────────
const REAL_STOCKS = {
  'AAPL':    { name: 'Apple',        nameAr: 'آبل',        emoji: '🍎', type: 'real' },
  'TSLA':    { name: 'Tesla',        nameAr: 'تيسلا',      emoji: '⚡', type: 'real' },
  'NVDA':    { name: 'NVIDIA',       nameAr: 'إنفيديا',    emoji: '🟢', type: 'real' },
  'AMZN':    { name: 'Amazon',       nameAr: 'أمازون',     emoji: '📦', type: 'real' },
  'GOOGL':   { name: 'Google',       nameAr: 'جوجل',       emoji: '🔍', type: 'real' },
  'BTC-USD': { name: 'Bitcoin',      nameAr: 'بيتكوين',    emoji: '₿',  type: 'real' },
};

const CASINO_STOCKS = {
  'CHAIN':   { name: 'Chainsaw Corp',    nameAr: 'شركة المنشار',     emoji: '🪚', type: 'casino', basePrice: 5000,  volatility: 0.09 },
  'BLOOD':   { name: 'Blood Fiend Corp', nameAr: 'شركة الدم',        emoji: '🩸', type: 'casino', basePrice: 3000,  volatility: 0.13 },
  'DIAMOND': { name: 'Diamond Casino',   nameAr: 'كازينو ألماس',     emoji: '💎', type: 'casino', basePrice: 10000, volatility: 0.05 },
  'REZERO':  { name: 'Re:Zero Fund',     nameAr: 'صندوق ريزيرو',     emoji: '❄️', type: 'casino', basePrice: 4000,  volatility: 0.07 },
};

const ALL_DEFS = { ...REAL_STOCKS, ...CASINO_STOCKS };

// Multiplier: $1 USD = 1000 casino coins
const COIN_MULTIPLIER = 1000;

// ── In-Memory Price Cache ────────────────────────────────────────
const priceCache = {};
let lastUpdate    = 0;
let updateRunning = false;

// Initialize casino stock prices
for (const [sym, def] of Object.entries(CASINO_STOCKS)) {
  priceCache[sym] = { price: def.basePrice, prevPrice: def.basePrice, change: '0.00' };
}

// ── Price Fetching ───────────────────────────────────────────────
async function fetchRealPrice(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=2d`;
    const res  = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DiamondCasino/1.0)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json   = await res.json();
    const result = json?.chart?.result?.[0];
    if (!result) return null;
    const meta    = result.meta;
    const current = meta.regularMarketPrice;
    const prev    = meta.chartPreviousClose || meta.previousClose || current;
    const coinPrice     = Math.max(1, Math.round(current * COIN_MULTIPLIER));
    const prevCoinPrice = Math.max(1, Math.round(prev    * COIN_MULTIPLIER));
    const change        = ((current - prev) / prev * 100).toFixed(2);
    return { price: coinPrice, prevPrice: prevCoinPrice, change, usdPrice: current.toFixed(2) };
  } catch { return null; }
}

function tickCasinoPrice(symbol) {
  const def  = CASINO_STOCKS[symbol];
  const prev = priceCache[symbol]?.price || def.basePrice;
  const drift = (Math.random() - 0.47) * def.volatility;
  const floor = Math.round(def.basePrice * 0.25);
  const ceil  = def.basePrice * 8;
  const next  = Math.min(ceil, Math.max(floor, Math.round(prev * (1 + drift))));
  const change = ((next - prev) / prev * 100).toFixed(2);
  priceCache[symbol] = { price: next, prevPrice: prev, change };
}

async function refreshAllPrices() {
  if (updateRunning) return;
  updateRunning = true;
  try {
    for (const sym of Object.keys(REAL_STOCKS)) {
      const data = await fetchRealPrice(sym);
      if (data) priceCache[sym] = data;
      await new Promise(r => setTimeout(r, 400)); // gentle delay between requests
    }
    for (const sym of Object.keys(CASINO_STOCKS)) {
      tickCasinoPrice(sym);
    }
    lastUpdate = Date.now();
    console.log('[📈 StockMarket] تم تحديث جميع الأسعار');
  } catch (e) {
    console.error('[📈 StockMarket] خطأ في التحديث:', e.message);
  } finally {
    updateRunning = false;
  }
}

// ── Helpers ──────────────────────────────────────────────────────
function fmt(n) {
  return Math.round(Number(n)).toLocaleString('en-US');
}
function sign(n) {
  return parseFloat(n) >= 0 ? '+' : '';
}
function trendEmoji(c) {
  return parseFloat(c) >= 0 ? '📈' : '📉';
}
function dotEmoji(c) {
  return parseFloat(c) >= 0 ? '🟢' : '🔴';
}
function getPrice(sym) {
  return priceCache[sym] || null;
}
function stockLog(embed) {
  try {
    const ch = _client.channels.cache.get(_SERVER.channels.allBetsLogId);
    if (ch) ch.send({ embeds: [embed] }).catch(() => {});
  } catch {}
}

// ── News feed — posts to dailyLogId (change to any channel you want) ─
function newsPost(embed) {
  try {
    const ch = _client.channels.cache.get(_SERVER.channels.dailyLogId);
    if (ch) ch.send({ embeds: [embed] }).catch(() => {});
  } catch {}
}

// ── Crash state tracking ──────────────────────────────────────────
const crashState = {
  active:    false,
  symbol:    null,
  warnAt:    0,
  crashAt:   0,
  timer:     null,
};

// ── Price snapshot for news detection (last reported price) ──────
const newsSnapshot = {};
function initNewsSnapshot() {
  for (const sym of Object.keys(ALL_DEFS)) {
    const p = priceCache[sym];
    if (p) newsSnapshot[sym] = p.price;
  }
}

// ── News headlines bank ───────────────────────────────────────────
const BULL_HEADLINES = [
  'يرتفع بشكل لافت وسط موجة شراء قوية',
  'يكسر مقاومة رئيسية — المتداولون يتدافعون للشراء',
  'يحقق ارتفاعاً مفاجئاً بعد أنباء إيجابية',
  'يسجل أعلى مستوياته — المستثمرون يحتفلون',
  'يقفز بعد ضخ ضخم من الكبار',
];
const BEAR_HEADLINES = [
  'يتراجع بحدة وسط عمليات بيع مكثفة',
  'يهبط في جلسة مضطربة — المتداولون قلقون',
  'يفقد أرضاً مهمة تحت ضغط بيعي قوي',
  'ينزلق لأدنى مستوياته — هل هذا بداية الانهيار؟',
  'يتعرض لضربة قوية بعد تقارير سلبية',
];

// ── COMMAND: سوق / !market ───────────────────────────────────────
async function handleMarket(message) {
  const realLines = Object.entries(REAL_STOCKS).map(([sym, def]) => {
    const p = priceCache[sym];
    if (!p) return `${def.emoji} **${sym}** — ⏳ جاري التحديث...`;
    return `${def.emoji} **${sym}** — ${def.nameAr}\n> \`${fmt(p.price)}\` كوين${p.usdPrice ? ` ≈ $${p.usdPrice}` : ''} | ${dotEmoji(p.change)} \`${sign(p.change)}${p.change}%\``;
  }).join('\n\n');

  const casinoLines = Object.entries(CASINO_STOCKS).map(([sym, def]) => {
    const p = priceCache[sym];
    return `${def.emoji} **${sym}** — ${def.nameAr}\n> \`${fmt(p?.price || def.basePrice)}\` كوين | ${dotEmoji(p?.change || '0')} \`${sign(p?.change || '0')}${p?.change || '0.00'}%\``;
  }).join('\n\n');

  const updated = lastUpdate
    ? `<t:${Math.floor(lastUpdate / 1000)}:R>`
    : '⏳ قيد التحميل';

  const embed = new Discord.MessageEmbed()
    .setColor('#0f4c2a')
    .setTitle('📊 سوق الأسهم — Diamond Casino')
    .setDescription('استثمر كوين الكازينو في أسهم حقيقية وأسهم حصرية!')
    .addField('🌍 أسهم حقيقية', realLines || 'لا توجد بيانات', false)
    .addField('🎰 أسهم الكازينو', casinoLines || 'لا توجد بيانات', false)
    .addField('📖 الأوامر',
      '`شراء [رمز] [كمية]` — شراء أسهم\n' +
      '`بيع [رمز] [كمية]` — بيع أسهم\n' +
      '`محفظة` — عرض محفظتك\n' +
      '`سهم [رمز]` — تفاصيل سهم\n' +
      '`اسهم مساعدة` — قائمة الأوامر',
      false)
    .setFooter({ text: `آخر تحديث: ${updated} • الأسعار تتحدث كل ساعة` })
    .setTimestamp();

  return message.reply({ embeds: [embed] });
}

// ── COMMAND: شراء / !buy ─────────────────────────────────────────
async function handleBuy(message, args) {
  const symbol = args[0]?.toUpperCase();
  const amount = parseInt(args[1]);

  if (!symbol || !amount || isNaN(amount) || amount < 1) {
    return message.reply('> ❌ **الاستخدام:** `شراء [رمز السهم] [الكمية]`\n> **مثال:** `شراء AAPL 5`');
  }
  if (!ALL_DEFS[symbol]) {
    return message.reply(`> ❌ الرمز \`${symbol}\` غير موجود.\n> استخدم \`سوق\` لرؤية جميع الأسهم المتاحة.`);
  }
  if (amount > 10000) {
    return message.reply('> ❌ الحد الأقصى للشراء في صفقة واحدة هو **10,000 سهم**.');
  }

  const p = getPrice(symbol);
  if (!p) return message.reply('> ⏳ جاري تحميل بيانات هذا السهم، حاول مرة أخرى بعد لحظة.');

  const totalCost = p.price * amount;
  const userData  = await _db.findOne({ id: message.author.id });

  // ── Block trading while in a game ────────────────────────────
  if (userData?.status_playing === 'yes') {
    return message.reply('> ❌ **لا يمكنك شراء الأسهم أثناء لعب لعبة نشطة!**\n> أنهِ لعبتك الحالية أولاً ثم حاول مجدداً.');
  }
  const balance   = parseInt(userData?.coins || 0);

  if (!userData || balance < totalCost) {
    const need = totalCost - balance;
    return message.reply(
      `> ❌ **رصيدك غير كافٍ.**\n` +
      `> التكلفة الإجمالية: \`${fmt(totalCost)}\` كوين\n` +
      `> رصيدك: \`${fmt(balance)}\` كوين\n` +
      `> تحتاج: \`${fmt(need)}\` كوين إضافي`
    );
  }

  // Deduct coins
  userData.coins = (balance - totalCost).toString();
  await userData.save();

  // Update portfolio
  let portfolio = await StockPortfolio.findOne({ userId: message.author.id });
  if (!portfolio) portfolio = new StockPortfolio({ userId: message.author.id, holdings: [] });

  const existing = portfolio.holdings.find(h => h.symbol === symbol);
  if (existing) {
    const prevTotal = existing.shares * existing.avgBuyPrice;
    existing.shares      += amount;
    existing.avgBuyPrice  = Math.round((prevTotal + totalCost) / existing.shares);
  } else {
    portfolio.holdings.push({ symbol, shares: amount, avgBuyPrice: p.price });
  }
  portfolio.totalInvested = (portfolio.totalInvested || 0) + totalCost;
  portfolio.totalTrades   = (portfolio.totalTrades   || 0) + 1;
  portfolio.markModified('holdings');
  await portfolio.save();

  const def = ALL_DEFS[symbol];
  const embed = new Discord.MessageEmbed()
    .setColor('#1a6b3a')
    .setTitle(`${def.emoji} تم الشراء بنجاح!`)
    .setThumbnail(message.author.displayAvatarURL({ dynamic: true }))
    .addField('📋 تفاصيل الصفقة',
      `> 📌 **السهم:** ${def.nameAr} (${symbol})\n` +
      `> 📦 **الكمية:** ${fmt(amount)} سهم\n` +
      `> 💵 **سعر الشراء:** ${fmt(p.price)} كوين/سهم\n` +
      `> 💸 **المجموع المدفوع:** ${fmt(totalCost)} كوين`, false)
    .addField('💰 رصيدك الجديد', `${fmt(userData.coins)} كوين`, true)
    .addField('📦 رصيدك من هذا السهم', `${fmt(existing ? existing.shares : amount)} سهم`, true)
    .setFooter({ text: message.author.tag })
    .setTimestamp();

  message.reply({ embeds: [embed] });

  // Log
  stockLog(
    new Discord.MessageEmbed()
      .setColor('#1a6b3a')
      .setTitle('📈 شراء أسهم')
      .addField('المستخدم', `<@${message.author.id}> (${message.author.tag})`, true)
      .addField('السهم', `${def.emoji} ${symbol} — ${def.nameAr}`, true)
      .addField('الكمية', fmt(amount), true)
      .addField('سعر الوحدة', `${fmt(p.price)} كوين`, true)
      .addField('التكلفة الإجمالية', `${fmt(totalCost)} كوين`, true)
      .addField('الرصيد المتبقي', `${fmt(userData.coins)} كوين`, true)
      .setTimestamp()
  );
}

// ── COMMAND: بيع / !sell ─────────────────────────────────────────
async function handleSell(message, args) {
  const symbol = args[0]?.toUpperCase();
  const amount = parseInt(args[1]);

  if (!symbol || !amount || isNaN(amount) || amount < 1) {
    return message.reply('> ❌ **الاستخدام:** `بيع [رمز السهم] [الكمية]`\n> **مثال:** `بيع AAPL 5`');
  }

  // ── Block trading while in a game ────────────────────────────
  const _checkUser = await _db.findOne({ id: message.author.id });
  if (_checkUser?.status_playing === 'yes') {
    return message.reply('> ❌ **لا يمكنك بيع الأسهم أثناء لعب لعبة نشطة!**\n> أنهِ لعبتك الحالية أولاً ثم حاول مجدداً.');
  }

  const portfolio = await StockPortfolio.findOne({ userId: message.author.id });
  const holding   = portfolio?.holdings?.find(h => h.symbol === symbol);

  if (!holding || holding.shares < amount) {
    return message.reply(
      `> ❌ لا تملك \`${fmt(amount)}\` سهم في **${symbol}**.\n` +
      `> رصيدك من هذا السهم: **${fmt(holding?.shares || 0)}** سهم`
    );
  }

  const p = getPrice(symbol);
  if (!p) return message.reply('> ⏳ جاري تحميل بيانات هذا السهم، حاول مرة أخرى بعد لحظة.');

  const grossRevenue = p.price * amount;
  const costBasis    = holding.avgBuyPrice * amount;
  const grossProfit  = grossRevenue - costBasis;

  // ── Tax: applied only on PROFIT, same rate as !settax ────────
  const taxRate    = getTaxRate();
  const taxPercent = Math.round(taxRate * 100);
  const taxAmount  = grossProfit > 0 ? Math.floor(grossProfit * taxRate) : 0;
  const revenue    = grossRevenue - taxAmount;
  const profit     = grossProfit  - taxAmount;
  const profitPct  = costBasis > 0 ? ((profit / costBasis) * 100).toFixed(2) : '0.00';
  const isProfit   = profit >= 0;

  // Update portfolio
  holding.shares -= amount;
  if (holding.shares <= 0) {
    portfolio.holdings = portfolio.holdings.filter(h => h.symbol !== symbol);
  }
  portfolio.realizedProfit = (portfolio.realizedProfit || 0) + profit;
  portfolio.totalTrades    = (portfolio.totalTrades    || 0) + 1;
  portfolio.markModified('holdings');
  await portfolio.save();

  // Add coins (after tax)
  const userData = await _db.findOne({ id: message.author.id });
  const oldBal   = parseInt(userData.coins || 0);
  userData.coins = (oldBal + revenue).toString();
  await userData.save();

  const def = ALL_DEFS[symbol] || { nameAr: symbol, name: symbol, emoji: '📊' };
  const embed = new Discord.MessageEmbed()
    .setColor(isProfit ? '#1a6b3a' : '#dc2626')
    .setTitle(`${def.emoji} تم البيع — ${isProfit ? '🟢 ربح' : '🔴 خسارة'}`)
    .setThumbnail(message.author.displayAvatarURL({ dynamic: true }))
    .addField('📋 تفاصيل الصفقة',
      `> 📌 **السهم:** ${def.nameAr} (${symbol})\n` +
      `> 📦 **الكمية المباعة:** ${fmt(amount)} سهم\n` +
      `> 💵 **سعر البيع:** ${fmt(p.price)} كوين/سهم\n` +
      `> 💰 **الإيراد الإجمالي:** ${fmt(grossRevenue)} كوين\n` +
      `> 🏛️ **الضريبة (${taxPercent}% على الربح):** -${fmt(taxAmount)} كوين\n` +
      `> 💸 **الصافي المستلم:** ${fmt(revenue)} كوين`, false)
    .addField('📊 سعر الشراء الأصلي', `${fmt(holding.avgBuyPrice)} كوين/سهم`, true)
    .addField(isProfit ? '💹 الربح الصافي' : '📉 الخسارة الصافية',
      `${sign(profit)}${fmt(profit)} كوين (${sign(profitPct)}${profitPct}%)`, true)
    .addField('💰 رصيدك الجديد', `${fmt(userData.coins)} كوين`, true)
    .setFooter({ text: `${message.author.tag} • الضريبة: ${taxPercent}% — يمكن تغييرها بـ !settax` })
    .setTimestamp();

  message.reply({ embeds: [embed] });

  // Log
  stockLog(
    new Discord.MessageEmbed()
      .setColor(isProfit ? '#1a6b3a' : '#dc2626')
      .setTitle(`📉 بيع أسهم — ${isProfit ? 'ربح' : 'خسارة'}`)
      .addField('المستخدم', `<@${message.author.id}> (${message.author.tag})`, true)
      .addField('السهم', `${def.emoji} ${symbol}`, true)
      .addField('الكمية', fmt(amount), true)
      .addField('الإيراد الإجمالي', `${fmt(grossRevenue)} كوين`, true)
      .addField('الضريبة المخصومة', `-${fmt(taxAmount)} كوين (${taxPercent}%)`, true)
      .addField('الصافي المستلم', `${fmt(revenue)} كوين`, true)
      .addField(isProfit ? '💹 الربح' : '📉 الخسارة', `${sign(profit)}${fmt(profit)} كوين`, true)
      .addField('الرصيد الجديد', `${fmt(userData.coins)} كوين`, true)
      .setTimestamp()
  );
}

// ── COMMAND: محفظة / !portfolio ──────────────────────────────────
async function handlePortfolio(message, targetUser) {
  const userId      = targetUser?.id   || message.author.id;
  const displayUser = targetUser       || message.author;

  const portfolio = await StockPortfolio.findOne({ userId });
  if (!portfolio || !portfolio.holdings?.length) {
    const who = targetUser ? `<@${userId}>` : 'أنت';
    return message.reply(
      `> 📭 ${who} لا تمتلك أي أسهم حالياً.\n` +
      `> استخدم \`شراء [رمز] [كمية]\` للبدء — مثال: \`شراء AAPL 10\``
    );
  }

  let totalValue = 0;
  let totalCost  = 0;
  const lines    = [];

  for (const h of portfolio.holdings) {
    const p            = getPrice(h.symbol);
    const currentPrice = p?.price || h.avgBuyPrice;
    const value        = currentPrice * h.shares;
    const cost         = h.avgBuyPrice * h.shares;
    const pnl          = value - cost;
    const pnlPct       = cost > 0 ? ((pnl / cost) * 100).toFixed(2) : '0.00';
    const def          = ALL_DEFS[h.symbol] || { emoji: '📊', nameAr: h.symbol };
    totalValue += value;
    totalCost  += cost;
    lines.push(
      `${def.emoji} **${h.symbol}** × \`${fmt(h.shares)}\` سهم\n` +
      `> شراء: \`${fmt(h.avgBuyPrice)}\` | الآن: \`${fmt(currentPrice)}\` | ${dotEmoji(pnlPct)} \`${sign(pnl)}${fmt(pnl)} (${sign(pnlPct)}${pnlPct}%)\``
    );
  }

  const totalPnl = totalValue - totalCost;
  const totalPct = totalCost > 0 ? ((totalPnl / totalCost) * 100).toFixed(2) : '0.00';
  const isUp     = totalPnl >= 0;

  const embed = new Discord.MessageEmbed()
    .setColor(isUp ? '#1a6b3a' : '#dc2626')
    .setTitle(`💼 محفظة ${displayUser.username} الاستثمارية`)
    .setThumbnail(displayUser.displayAvatarURL({ dynamic: true }))
    .addField('📦 الأسهم المحتفظ بها', lines.join('\n\n') || '—', false)
    .addField('📊 القيمة الإجمالية',    `${fmt(totalValue)} كوين`,                           true)
    .addField(isUp ? '💹 الربح الكلي' : '📉 الخسارة الكلية',
      `${sign(totalPnl)}${fmt(totalPnl)} كوين\n${sign(totalPct)}${totalPct}%`, true)
    .addField('💎 أرباح محققة (تاريخية)', `${fmt(portfolio.realizedProfit || 0)} كوين`,       true)
    .addField('🔄 إجمالي الصفقات',       `${portfolio.totalTrades || 0} صفقة`,              true)
    .setFooter({ text: displayUser.tag })
    .setTimestamp();

  return message.reply({ embeds: [embed] });
}

// ── COMMAND: سهم / !stock ────────────────────────────────────────
async function handleStockInfo(message, symbol) {
  symbol = symbol?.toUpperCase();
  if (!symbol || !ALL_DEFS[symbol]) {
    return message.reply('> ❌ رمز غير معروف. استخدم `سوق` لرؤية جميع الرموز المتاحة.');
  }

  const def = ALL_DEFS[symbol];
  const p   = getPrice(symbol);

  if (!p) return message.reply('> ⏳ جاري تحميل بيانات السهم، حاول مرة أخرى بعد لحظة.');

  const isUp = parseFloat(p.change) >= 0;
  const embed = new Discord.MessageEmbed()
    .setColor(isUp ? '#1a6b3a' : '#dc2626')
    .setTitle(`${def.emoji} ${def.nameAr} — ${symbol}`)
    .setDescription(`**${def.name}** | ${def.type === 'real' ? '🌍 سهم حقيقي' : '🎰 سهم كازينو'}`)
    .addField('💰 السعر الحالي', `${fmt(p.price)} كوين${p.usdPrice ? ` ≈ $${p.usdPrice}` : ''}`, true)
    .addField('📅 سعر الأمس',    `${fmt(p.prevPrice)} كوين`, true)
    .addField(`${trendEmoji(p.change)} التغيير`, `${sign(p.change)}${p.change}%`, true)
    .addField('📖 شراء',  `\`شراء ${symbol} [كمية]\``, true)
    .addField('💸 بيع',   `\`بيع ${symbol} [كمية]\``,  true)
    .addField('📊 تفاصيل محفظتك', `\`محفظة\``, true)
    .setFooter({ text: 'الأسعار تتحدث كل ساعة' })
    .setTimestamp();

  return message.reply({ embeds: [embed] });
}

// ── COMMAND: اسهم مساعدة / !stockhelp ───────────────────────────
async function handleHelp(message) {
  const symbols = Object.entries(ALL_DEFS).map(([s, d]) => `${d.emoji} \`${s}\``).join(' · ');
  const embed = new Discord.MessageEmbed()
    .setColor('#0f4c2a')
    .setTitle('📈 مساعدة — سوق الأسهم')
    .setDescription('استثمر كوين الكازينو وحقق أرباحاً حقيقية!')
    .addField('📋 الأوامر المتاحة',
      '`سوق` — عرض جميع الأسهم وأسعارها الحالية\n' +
      '`شراء [رمز] [كمية]` — شراء أسهم\n' +
      '`بيع [رمز] [كمية]` — بيع أسهم\n' +
      '`محفظة` / `محفظة @مستخدم` — عرض المحفظة\n' +
      '`سهم [رمز]` — تفاصيل سهم محدد\n' +
      '`هدية-سهم @مستخدم [رمز] [كمية]` — هبة أسهم لشخص آخر\n' +
      '`اسهم مساعدة` — هذه القائمة', false)
    .addField('📌 الأسهم المتاحة', symbols, false)
    .addField('💡 معلومات مهمة',
      '> • الأسهم الحقيقية: السعر الحقيقي × 1000 كوين\n' +
      '> • أسهم الكازينو تتقلب كل 15 دقيقة\n' +
      '> • الضريبة على الأرباح فقط (نفس معدل `!settax`)\n' +
      '> • 📰 الأخبار تُنشر تلقائياً عند تحرك ±8%\n' +
      '> • 💣 أحداث الانهيار عشوائية — راقب الأخبار!', false)
    .setTimestamp();

  return message.reply({ embeds: [embed] });
}

/* ══════════════════════════════════════════════════════════════════
   📰 MARKET NEWS FEED
══════════════════════════════════════════════════════════════════ */
function checkAndPostNews() {
  for (const [sym, def] of Object.entries(ALL_DEFS)) {
    const p = priceCache[sym];
    if (!p) continue;
    const prev = newsSnapshot[sym];
    if (!prev || prev === 0) { newsSnapshot[sym] = p.price; continue; }

    const movePct = ((p.price - prev) / prev) * 100;
    if (Math.abs(movePct) < 8) continue; // only report ±8% moves

    const isBull   = movePct > 0;
    const headlines = isBull ? BULL_HEADLINES : BEAR_HEADLINES;
    const headline  = headlines[Math.floor(Math.random() * headlines.length)];
    const color     = isBull ? '#16a34a' : '#dc2626';
    const arrow     = isBull ? '🟢📈' : '🔴📉';

    const embed = new Discord.MessageEmbed()
      .setColor(color)
      .setTitle(`📰 أخبار السوق — ${def.emoji} ${sym}`)
      .setDescription(`**${def.nameAr} (${sym})** ${headline}`)
      .addField('💰 السعر الحالي', `${fmt(p.price)} كوين`, true)
      .addField('📅 السعر السابق',  `${fmt(prev)} كوين`,    true)
      .addField(`${arrow} التغيير`,  `${sign(movePct)}${movePct.toFixed(2)}%`, true)
      .setFooter({ text: 'Diamond Casino — نشرة أسواق المال' })
      .setTimestamp();

    newsPost(embed);
    newsSnapshot[sym] = p.price; // reset snapshot after reporting
    console.log(`[📰 MarketNews] ${sym} moved ${movePct.toFixed(1)}% — news posted`);
  }
}

/* ══════════════════════════════════════════════════════════════════
   💣 MARKET CRASH EVENT
══════════════════════════════════════════════════════════════════ */
function triggerCrashNow(symbol) {
  const def  = ALL_DEFS[symbol];
  const prev = priceCache[symbol]?.price || CASINO_STOCKS[symbol]?.basePrice || 5000;
  const crashed = Math.round(prev * 0.60); // -40%
  const changePct = ((crashed - prev) / prev * 100).toFixed(2);
  priceCache[symbol] = { price: crashed, prevPrice: prev, change: changePct };
  newsSnapshot[symbol] = crashed;
  crashState.active = false;
  crashState.symbol = null;

  console.log(`[💣 MarketCrash] ${symbol} crashed from ${prev} → ${crashed}`);

  const embed = new Discord.MessageEmbed()
    .setColor('#7f1d1d')
    .setTitle(`💣 انهيار السوق! — ${def?.emoji || '📉'} ${symbol}`)
    .setDescription(`> ⚠️ **${def?.nameAr || symbol}** انهار للتو!\n> السوق يغرق والمستثمرون في حالة ذعر!`)
    .addField('📉 السعر قبل الانهيار', `${fmt(prev)} كوين`,    true)
    .addField('💥 السعر بعد الانهيار', `${fmt(crashed)} كوين`, true)
    .addField('📊 الخسارة',           `${changePct}%`,         true)
    .addField('💡 ماذا تفعل؟',
      '> • **بائعو الأسهم:** فرصة ذهبية للبيع الآن\n' +
      '> • **المشترون:** انتظر الاستقرار قبل الدخول\n' +
      '> • **المحترفون:** هذا قد يكون فرصة شراء رخيص!', false)
    .setFooter({ text: 'Diamond Casino — تحذير: هذا حدث عشوائي للترفيه فقط' })
    .setTimestamp();

  newsPost(embed);
  stockLog(embed);
}

async function scheduleCrash(symbol, warnMinutes = 10) {
  if (crashState.active) return false; // only one crash at a time
  if (!ALL_DEFS[symbol]) return false;

  crashState.active = true;
  crashState.symbol = symbol;
  crashState.warnAt = Date.now();
  crashState.crashAt = Date.now() + warnMinutes * 60 * 1000;

  const def = ALL_DEFS[symbol];

  // Warning embed
  const warnEmbed = new Discord.MessageEmbed()
    .setColor('#b45309')
    .setTitle(`⚠️ تحذير انهيار السوق! — ${def?.emoji || '📉'} ${symbol}`)
    .setDescription(
      `> 🚨 **تحذير:** سيشهد سهم **${def?.nameAr || symbol}** انهياراً حاداً خلال **${warnMinutes} دقائق**!\n` +
      `> احرص على اتخاذ قراراتك قبل فوات الأوان!`
    )
    .addField('⏰ موعد الانهيار', `<t:${Math.floor(crashState.crashAt / 1000)}:R>`, true)
    .addField('💰 السعر الحالي',  `${fmt(priceCache[symbol]?.price || 0)} كوين`,     true)
    .addField('📉 الانخفاض المتوقع', '~40%', true)
    .setFooter({ text: 'Diamond Casino — تحذير مبكر | @everyone' })
    .setTimestamp();

  newsPost(warnEmbed);
  console.log(`[💣 MarketCrash] Warning sent for ${symbol}, crash in ${warnMinutes} min`);

  crashState.timer = setTimeout(() => triggerCrashNow(symbol), warnMinutes * 60 * 1000);
  return true;
}

// Admin command: !انهيار-سوق [symbol] [minutes?]
async function handleAdminCrash(message, args, owners) {
  if (!owners.includes(message.author.id)) {
    return message.reply('> ❌ هذا الأمر للمالك فقط.');
  }
  if (crashState.active) {
    return message.reply(`> ⚠️ يوجد انهيار قيد التنفيذ بالفعل على **${crashState.symbol}**. انتظر حتى ينتهي.`);
  }

  const symbol  = args[0]?.toUpperCase();
  const minutes = parseInt(args[1]) || 10;

  if (!symbol || !ALL_DEFS[symbol]) {
    const list = Object.keys(ALL_DEFS).join(', ');
    return message.reply(`> ❌ رمز غير صحيح. الرموز المتاحة: \`${list}\``);
  }
  if (minutes < 1 || minutes > 60) {
    return message.reply('> ❌ الوقت يجب أن يكون بين 1 و60 دقيقة.');
  }

  const ok = await scheduleCrash(symbol, minutes);
  if (ok) {
    message.reply(`> ✅ تم جدولة انهيار **${symbol}** خلال **${minutes} دقيقة**. تم إرسال التحذير للقناة.`);
  }
}

/* ══════════════════════════════════════════════════════════════════
   🤝 STOCK GIFTING
══════════════════════════════════════════════════════════════════ */
async function handleGift(message, args) {
  const target = message.mentions.users.first();
  const symbol = args.find(a => ALL_DEFS[a?.toUpperCase()])?.toUpperCase();
  const amount = parseInt(args.find(a => /^\d+$/.test(a)));

  if (!target) {
    return message.reply('> ❌ **الاستخدام:** `هدية-سهم @مستخدم [رمز] [كمية]`\n> **مثال:** `هدية-سهم @علي AAPL 5`');
  }
  if (target.id === message.author.id) {
    return message.reply('> ❌ لا يمكنك إهداء أسهم لنفسك!');
  }
  if (target.bot) {
    return message.reply('> ❌ لا يمكنك إهداء أسهم للبوت.');
  }
  if (!symbol) {
    return message.reply(`> ❌ رمز السهم غير موجود. استخدم \`سوق\` لرؤية الأسهم المتاحة.`);
  }
  if (!amount || isNaN(amount) || amount < 1) {
    return message.reply('> ❌ الكمية يجب أن تكون رقماً صحيحاً أكبر من 0.');
  }
  if (amount > 1000) {
    return message.reply('> ❌ الحد الأقصى للإهداء في مرة واحدة هو **1,000 سهم**.');
  }

  // Check sender has enough shares
  const senderPort = await StockPortfolio.findOne({ userId: message.author.id });
  const holding    = senderPort?.holdings?.find(h => h.symbol === symbol);
  if (!holding || holding.shares < amount) {
    return message.reply(
      `> ❌ لا تملك \`${fmt(amount)}\` سهم من **${symbol}**.\n` +
      `> رصيدك الحالي: **${fmt(holding?.shares || 0)}** سهم`
    );
  }

  // Deduct from sender
  holding.shares -= amount;
  if (holding.shares <= 0) {
    senderPort.holdings = senderPort.holdings.filter(h => h.symbol !== symbol);
  }
  senderPort.markModified('holdings');
  await senderPort.save();

  // Add to receiver
  let receiverPort = await StockPortfolio.findOne({ userId: target.id });
  if (!receiverPort) receiverPort = new StockPortfolio({ userId: target.id, holdings: [] });
  const existing = receiverPort.holdings.find(h => h.symbol === symbol);
  const currentPrice = priceCache[symbol]?.price || holding.avgBuyPrice;
  if (existing) {
    const newTotal       = existing.shares * existing.avgBuyPrice + amount * currentPrice;
    existing.shares     += amount;
    existing.avgBuyPrice = Math.round(newTotal / existing.shares);
  } else {
    receiverPort.holdings.push({ symbol, shares: amount, avgBuyPrice: currentPrice });
  }
  receiverPort.markModified('holdings');
  await receiverPort.save();

  const def = ALL_DEFS[symbol];
  const embed = new Discord.MessageEmbed()
    .setColor('#7c3aed')
    .setTitle(`🎁 هدية أسهم — ${def.emoji} ${symbol}`)
    .setThumbnail(message.author.displayAvatarURL({ dynamic: true }))
    .addField('🎁 من',       `<@${message.author.id}>`, true)
    .addField('📨 إلى',      `<@${target.id}>`,          true)
    .addField('📦 السهم',    `${def.emoji} ${def.nameAr} (${symbol})`, true)
    .addField('📊 الكمية',   `${fmt(amount)} سهم`,       true)
    .addField('💰 القيمة التقريبية', `${fmt(currentPrice * amount)} كوين`, true)
    .addField('📦 رصيدك المتبقي', `${fmt(holding.shares)} سهم`, true)
    .setFooter({ text: 'هدية مجانية — لا ضريبة على الهبات' })
    .setTimestamp();

  message.reply({ embeds: [embed] });

  // Try to DM the receiver
  try {
    const dmEmbed = new Discord.MessageEmbed()
      .setColor('#7c3aed')
      .setTitle(`🎁 تلقيت هدية أسهم!`)
      .setDescription(`أرسل لك **${message.author.tag}** هدية من أسهم ${def.emoji} **${def.nameAr} (${symbol})**!`)
      .addField('📦 الكمية', `${fmt(amount)} سهم`, true)
      .addField('💰 القيمة', `${fmt(currentPrice * amount)} كوين`, true)
      .setTimestamp();
    await target.send({ embeds: [dmEmbed] });
  } catch {}

  stockLog(
    new Discord.MessageEmbed()
      .setColor('#7c3aed')
      .setTitle('🎁 هبة أسهم')
      .addField('المُهدي',  `<@${message.author.id}> (${message.author.tag})`, true)
      .addField('المستلم',  `<@${target.id}> (${target.tag})`,                 true)
      .addField('السهم',    `${def.emoji} ${symbol}`,                           true)
      .addField('الكمية',   `${fmt(amount)} سهم`,                               true)
      .addField('القيمة',   `${fmt(currentPrice * amount)} كوين`,               true)
      .setTimestamp()
  );
}

// ── Register all commands on the client ─────────────────────────
function registerCommands(client) {
  client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const raw  = message.content.trim();
    const part = raw.split(/\s+/);
    const cmd  = part[0].toLowerCase();

    try {
      // سوق / !market
      if (cmd === 'سوق' || cmd === '!market') {
        return await handleMarket(message);
      }

      // شراء [رمز] [كمية] / !buy
      if (cmd === 'شراء' || cmd === '!buy') {
        return await handleBuy(message, part.slice(1));
      }

      // بيع [رمز] [كمية] / !sell
      if (cmd === 'بيع' || cmd === '!sell') {
        return await handleSell(message, part.slice(1));
      }

      // محفظة [@mention] / !portfolio
      if (cmd === 'محفظة' || cmd === '!portfolio') {
        const target = message.mentions.users.first() || null;
        return await handlePortfolio(message, target);
      }

      // سهم [رمز] / !stock
      if (cmd === 'سهم' || cmd === '!stock') {
        return await handleStockInfo(message, part[1]);
      }

      // اسهم مساعدة / !stockhelp
      if (cmd === 'اسهم' && part[1] === 'مساعدة') {
        return await handleHelp(message);
      }
      if (cmd === '!stockhelp') {
        return await handleHelp(message);
      }

      // هدية-سهم @user [symbol] [amount] / !gift-stock
      if (cmd === 'هدية-سهم' || cmd === '!gift-stock') {
        return await handleGift(message, part.slice(1));
      }

      // !انهيار-سوق [symbol] [minutes?] — owner only
      if (cmd === '!انهيار-سوق' || cmd === '!market-crash') {
        return await handleAdminCrash(message, part.slice(1), _SERVER.users.owners);
      }

    } catch (e) {
      console.error('[📈 StockMarket] خطأ في معالجة الأمر:', e.message);
      message.reply('> ❌ حدث خطأ داخلي. حاول مرة أخرى.').catch(() => {});
    }
  });
}

// ── Init ─────────────────────────────────────────────────────────
function init(client, db, SERVER_SETTINGS) {
  _client  = client;
  _db      = db;
  _SERVER  = SERVER_SETTINGS;

  // Initial price load then snapshot for news
  refreshAllPrices().then(() => {
    setTimeout(initNewsSnapshot, 3000);
  });

  // Update prices every hour + check news after each update
  setInterval(async () => {
    await refreshAllPrices();
    checkAndPostNews();
  }, 60 * 60 * 1000);

  // Tick casino prices every 15 minutes + check news
  setInterval(() => {
    for (const sym of Object.keys(CASINO_STOCKS)) tickCasinoPrice(sym);
    checkAndPostNews();
    console.log('[📈 StockMarket] تم تحديث أسهم الكازينو');
  }, 15 * 60 * 1000);

  // Random crash event — every 6 hours, 15% chance one casino stock crashes
  setInterval(() => {
    if (crashState.active) return;
    if (Math.random() > 0.15) return; // 15% chance
    const symbols = Object.keys(CASINO_STOCKS);
    const target  = symbols[Math.floor(Math.random() * symbols.length)];
    console.log(`[💣 MarketCrash] Auto-crash triggered for ${target}`);
    scheduleCrash(target, 10);
  }, 6 * 60 * 60 * 1000);

  // Register message commands
  registerCommands(client);

  console.log('[📈 StockMarket] تم تهيئة سوق الأسهم بنجاح ✅');
}

module.exports = { init, refreshAllPrices, getPrice };
