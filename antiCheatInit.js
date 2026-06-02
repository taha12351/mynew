// ملف: antiCheatInit.js
// هذا الملف سيستخدم require كما تريد

// استخدم require هنا (لن يتأثر باقي المشروع)
const IpBan = require('./models/ipBan');
const DevtoolsLog = require('./models/devtoolsLog');

// متغير لتخزين محاولات DevTools مؤقتاً في الذاكرة
const devtoolsAttempts = new Map();

// تنظيف الذاكرة كل ساعة
setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of devtoolsAttempts.entries()) {
    if (now - data.timestamp > 3600000) {
      devtoolsAttempts.delete(ip);
    }
  }
}, 3600000);

// دالة لحظر IP
async function banIp(ip, reason, req = null, siteLogFn = null) {
  try {
    const existingBan = await IpBan.findOne({ ip });
    if (existingBan) return;

    const banData = {
      ip,
      reason,
      userAgent: req ? req.headers['user-agent'] : null
    };

    if (req && req.session?.user) {
      banData.userId = req.session.user.id;
      banData.username = req.session.user.username;
    }

    await IpBan.create(banData);
    
    if (siteLogFn) {
      await siteLogFn('🚫 تم حظر IP - اكتشاف أدوات المطور', 
        `**العنوان IP:** \`${ip}\`\n**السبب:** ${reason}\n**وكيل المستخدم:** ${banData.userAgent || 'غير معروف'}\n**المستخدم:** ${banData.username || 'زائر'}`,
        '#ED4245'
      );
    }
    
    console.log(`[SECURITY] تم حظر IP: ${ip} - السبب: ${reason}`);
  } catch (err) {
    console.error('[Ban IP Error]', err);
  }
}

// دالة لتسجيل محاولة DevTools
async function logDevtoolsAttempt(ip, req) {
  const now = Date.now();
  const attempts = devtoolsAttempts.get(ip) || { count: 0, timestamp: now };
  
  attempts.count++;
  attempts.timestamp = now;
  devtoolsAttempts.set(ip, attempts);
  
  try {
    await DevtoolsLog.create({
      ip,
      userId: req?.session?.user?.id,
      username: req?.session?.user?.username,
      userAgent: req?.headers['user-agent'],
      timestamp: now
    });
  } catch (err) {
    console.error('[Devtools Log Error]', err);
  }
  
  if (attempts.count >= 3) {
    await banIp(ip, `تم اكتشاف أدوات المطور ${attempts.count} مرات`, req);
  }
  
  return attempts.count;
}

// Middleware للتحقق من IP المحظور
function checkIpBan() {
  return async (req, res, next) => {
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
    
    if (clientIp === '127.0.0.1' || clientIp === '::1') {
      return next();
    }
    
    try {
      const banned = await IpBan.findOne({ ip: clientIp });
      if (banned) {
        if (banned.expiresAt && new Date() > banned.expiresAt) {
          await IpBan.deleteOne({ ip: clientIp });
          return next();
        }
        return res.status(403).send(renderBanPage(banned));
      }
    } catch (err) {
      console.error('[CheckIpBan Error]', err);
    }
    next();
  };
}

// صفحة الحظر
function renderBanPage(banned) {
  return `
    <!DOCTYPE html>
    <html lang="ar" dir="rtl">
    <head>
      <meta charset="UTF-8">
      <title>تم الحظر - دايموند كازينو</title>
      <style>
        body {
          background: linear-gradient(135deg, #0f0c29, #1a1a2e, #16213e);
          color: white;
          font-family: 'Cairo', sans-serif;
          display: flex;
          justify-content: center;
          align-items: center;
          min-height: 100vh;
          margin: 0;
          padding: 20px;
        }
        .ban-card {
          background: rgba(0,0,0,0.8);
          backdrop-filter: blur(10px);
          border-radius: 24px;
          padding: 40px;
          text-align: center;
          max-width: 500px;
          border: 1px solid rgba(239,68,68,0.3);
          box-shadow: 0 0 50px rgba(239,68,68,0.2);
          animation: fadeIn 0.5s ease;
        }
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(-20px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .ban-icon { font-size: 80px; margin-bottom: 20px; animation: shake 0.5s ease; }
        @keyframes shake {
          0%, 100% { transform: translateX(0); }
          25% { transform: translateX(-10px); }
          75% { transform: translateX(10px); }
        }
        h1 { color: #ef4444; margin-bottom: 16px; font-size: 28px; }
        p { color: #94a3b8; margin-bottom: 24px; line-height: 1.6; }
        .reason { background: rgba(239,68,68,0.1); padding: 12px; border-radius: 12px; font-size: 13px; margin: 16px 0; }
        .footer { margin-top: 24px; font-size: 11px; color: #475569; }
      </style>
    </head>
    <body>
      <div class="ban-card">
        <div class="ban-icon">🚫</div>
        <h1>⛔ تم حظر وصولك</h1>
        <p>تم اكتشاف استخدام أدوات المطور (DevTools) على هذا الموقع.<br>هذا مخالف لشروط الاستخدام الخاصة بنا.</p>
        <div class="reason">
          🔒 <strong>تم حظر عنوان IP الخاص بك</strong><br>
          السبب: ${banned.reason}<br>
          تاريخ الحظر: ${new Date(banned.bannedAt).toLocaleString('ar-EG')}
        </div>
        <p style="font-size: 12px; margin-top: 16px;">إذا كنت تعتقد أن هذا خطأ، يرجى التواصل مع فريق الدعم.</p>
        <div class="footer">Diamond Casino - نتمسك باللعب النظيف</div>
      </div>
    </body>
    </html>
  `;
}

// تصدير الدوال
module.exports = {
  banIp,
  logDevtoolsAttempt,
  checkIpBan,
  devtoolsAttempts
};