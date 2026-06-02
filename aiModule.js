// ============================================================
// ==================== AI MODULE v8 ==========================
// require('./aiModule')(client);  ← add to index.js
// ============================================================

const { MessageActionRow, MessageSelectMenu, MessageEmbed } = require("discord.js");
const https = require("https");
const http  = require("http");
const fs    = require("fs");
const path  = require("path");

const PROJECT_ROOT = __dirname;
const PROTECTED    = ["node_modules", ".git", ".env"];
const GROQ_API_KEY = "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";

// ─────────────────────────────────────────────────────────────
// HTTP
// ─────────────────────────────────────────────────────────────
function httpRequest(urlStr, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const u   = new URL(urlStr);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request({
      hostname: u.hostname,
      port:     u.port || (u.protocol === "https:" ? 443 : 80),
      path:     u.pathname + u.search,
      method:   options.method || "GET",
      headers:  options.headers || {},
      timeout:  90000,
    }, (res) => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        const loc = res.headers.location.startsWith("http")
          ? res.headers.location
          : `${u.protocol}//${u.host}${res.headers.location}`;
        return httpRequest(loc, options, body).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          ok:     res.statusCode >= 200 && res.statusCode < 400,
          buffer: buf,
          text:   () => buf.toString("utf8"),
          json:   () => JSON.parse(buf.toString("utf8")),
        });
      });
    });
    req.on("error",   reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout 90s")); });
    if (body) req.write(body);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────
// FILE SYSTEM — ALL writes go through here, directly to disk
// ─────────────────────────────────────────────────────────────
function safePath(p) {
  const resolved = path.resolve(PROJECT_ROOT, p.trim());
  if (!resolved.startsWith(PROJECT_ROOT)) throw new Error("Path outside project");
  for (const x of PROTECTED)
    if (resolved.includes(path.sep + x)) throw new Error(`Protected: ${x}`);
  return resolved;
}

function listFiles(dir = PROJECT_ROOT, depth = 0) {
  if (depth > 4) return [];
  let out = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (PROTECTED.includes(e.name) || e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      const rel  = path.relative(PROJECT_ROOT, full);
      if (e.isDirectory()) { out.push(`📁 ${rel}/`); out = out.concat(listFiles(full, depth+1)); }
      else out.push(`📄 ${rel} (${(fs.statSync(full).size/1024).toFixed(1)}KB)`);
    }
  } catch {}
  return out;
}

function readFile(p, maxBytes = 600000) {
  const full = safePath(p);
  if (!fs.existsSync(full)) throw new Error(`File not found: ${p}`);
  const size = fs.statSync(full).size;
  if (size <= maxBytes) return fs.readFileSync(full, "utf8");
  // Large file: read in chunks, return first + last portions with middle summary
  const fd      = fs.openSync(full, "r");
  const half    = Math.floor(maxBytes / 2);
  const bufHead = Buffer.alloc(half);
  const bufTail = Buffer.alloc(half);
  fs.readSync(fd, bufHead, 0, half, 0);
  fs.readSync(fd, bufTail, 0, half, size - half);
  fs.closeSync(fd);
  const skipped = size - maxBytes;
  return (
    bufHead.toString("utf8") +
    `

/* ===== FILE TOO LARGE: ${(size/1024).toFixed(0)}KB total, ` +
    `${(skipped/1024).toFixed(0)}KB skipped in middle ===== */

` +
    bufTail.toString("utf8")
  );
}

// Read only a line range from a large file
function readFileLines(p, from, to) {
  const full = safePath(p);
  if (!fs.existsSync(full)) throw new Error(`File not found: ${p}`);
  const lines = fs.readFileSync(full, "utf8").split("\n");
  const start = Math.max(0, (from||1) - 1);
  const end   = Math.min(lines.length, (to||lines.length));
  return { lines: lines.slice(start, end).join("\n"), total: lines.length, from: start+1, to: end };
}

// THE real disk writer — bot calls this, NOT the AI
function writeFileToDisk(p, content) {
  const full = safePath(p);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  if (fs.existsSync(full)) fs.writeFileSync(full + ".bak", fs.readFileSync(full));
  fs.writeFileSync(full, content, "utf8");
  // Hard verify
  if (!fs.existsSync(full)) throw new Error(`WRITE FAILED: not on disk: ${full}`);
  const stat = fs.statSync(full);
  if (stat.size === 0 && content.length > 0) throw new Error(`WRITE FAILED: empty file: ${full}`);
  console.log(`[AI v8] ✅ WROTE TO DISK: ${full} (${stat.size} bytes)`);
  return { full, size: stat.size };
}

function deleteFilefromDisk(p) {
  const full = safePath(p);
  if (!fs.existsSync(full)) throw new Error(`Not found: ${p}`);
  fs.unlinkSync(full);
}

// ─────────────────────────────────────────────────────────────
// EXTRACT CODE from AI response — handles every format
// ─────────────────────────────────────────────────────────────
function extractCode(text) {
  if (!text || !text.trim()) return "";
  // pattern 1: ```js\n...\n```
  let m = text.match(/```[a-zA-Z0-9_.-]*\r?\n([\s\S]*?)```/);
  if (m && m[1].trim()) { console.log("[AI v8] extractCode: matched pattern 1"); return m[1].trimEnd(); }
  // pattern 2: ```\n...\n```
  m = text.match(/```\r?\n([\s\S]*?)```/);
  if (m && m[1].trim()) { console.log("[AI v8] extractCode: matched pattern 2"); return m[1].trimEnd(); }
  // pattern 3: ```...```
  m = text.match(/```([\s\S]*?)```/);
  if (m && m[1].trim()) { console.log("[AI v8] extractCode: matched pattern 3"); return m[1].trimEnd(); }
  // pattern 4: no code block, use raw
  console.log("[AI v8] extractCode: no code block found, using raw text");
  return text.trim();
}

// ─────────────────────────────────────────────────────────────
// PARSE COMMAND — detects what the user is trying to do
// accepts typos: creat/create/new/make, delet/delete, etc.
// ─────────────────────────────────────────────────────────────
function parseCommand(prompt) {
  const p = prompt.trim();

  // ── Exact commands ──────────────────────────────────────────
  if (/^clear$/i.test(p)) return { cmd: "clear" };
  if (/^files?$/i.test(p)) return { cmd: "files" };

  // check <file>
  let m = p.match(/^check\s+(\S+)$/i);
  if (m) return { cmd: "check", file: m[1] };

  // read <file>
  m = p.match(/^read\s+(\S+)$/i);
  if (m) return { cmd: "read", file: m[1] };

  // delete <file>
  m = p.match(/^(?:delete?|del|remove)\s+(\S+)$/i);
  if (m) return { cmd: "delete", file: m[1] };

  // create <file>: <desc>  OR  create <file>
  m = p.match(/^(?:creat[e]?|new|make)\s+(\S+?)(?:\s*:\s*([\s\S]+))?$/i);
  if (m) return { cmd: "create", file: m[1], desc: m[2] || `A new ${path.extname(m[1]).slice(1)||"js"} file` };

  // edit <file>: <instruction>
  m = p.match(/^(?:edit?|edt|modify|update|fix)\s+(\S+?)\s*:\s*([\s\S]+)$/i);
  if (m) return { cmd: "edit", file: m[1], instruction: m[2] };

  // ── Natural language detection ──────────────────────────────
  const fileMatch = p.match(/\b([\w./\\-]+\.(?:js|ts|json|md|txt|html|css|py|sh|yml|yaml|env|sql))\b/i);

  if (fileMatch) {
    const file = fileMatch[1];

    // QUESTION patterns → chat (not a file action)
    // "do you see X?" "are you done?" "can you see X?" "is X there?"
    if (/\b(?:do you|can you see|are you|did you|have you|is it|does it|what is|what's|tell me about|show me|view|read|open|display|print|content|what.{0,10}in)\b/i.test(p) &&
        !/\b(?:edit|update|fix|change|add|remove|modify|rewrite|refactor|improve|create|creat|make|new|delete|del|remove|erase)\b/i.test(p)) {
      return { cmd: "chat", text: p };
    }

    // QUESTION words at start → chat
    if (/^(?:do |did |does |is |are |was |were |can |could |would |should |have |has |what |why |how |when |where )/i.test(p) &&
        !/\b(?:edit|update|fix|change|add|remove|modify|rewrite|refactor|improve|create|creat|make|new|delete|del|erase)\b/i.test(p)) {
      return { cmd: "chat", text: p };
    }

    // CREATE action
    if (/\b(?:creat[e]?|new|make)\b/i.test(p)) {
      const desc = p.replace(/\b(?:creat[e]?|new|make)\b/gi,"").replace(fileMatch[0],"").replace(/[,:.]/g,"").trim() || `A new ${path.extname(file).slice(1)||"js"} file`;
      return { cmd: "create", file, desc };
    }

    // EDIT action — must have clear action keyword
    if (/\b(?:edit|edt|modify|update|fix|change|add to|remove from|refactor|rewrite|improve|put|type|write|insert|append)\b/i.test(p)) {
      const instruction = p.replace(fileMatch[0],"").trim() || "Improve this file";
      return { cmd: "edit", file, instruction };
    }

    // DELETE action
    if (/\b(?:delete|del|remove|erase)\b/i.test(p)) {
      return { cmd: "delete", file };
    }

    // CHECK/EXIST
    if (/\b(?:exist|exists|there|found|present|check)\b/i.test(p)) {
      return { cmd: "check", file };
    }

    // File mentioned with no recognized action → chat (ask AI)
    return { cmd: "chat", text: p };
  }

  // ── lines <file> <from>-<to>
  let lm = p.match(/^lines?\s+(\S+)(?:\s+(\d+)(?:[:-](\d+))?)?$/i);
  if (lm) return { cmd: "lines", file: lm[1], from: parseInt(lm[2])||1, to: parseInt(lm[3])||50 };

  // ── restart ───────────────────────────────────────────────
  if (/^restart\b/i.test(p)) return { cmd: "restart" };

  // ── Fallback: text chat ─────────────────────────────────────
  return { cmd: "chat", text: p };
}

// ─────────────────────────────────────────────────────────────
// SYSTEM PROMPT
// ─────────────────────────────────────────────────────────────
function buildSystemPrompt() {
  const fileList = listFiles().slice(0, 100).join("\n");
  return `You are a senior full-stack engineer and AI assistant embedded inside a live Discord.js v13 bot project.

THE BOT handles all actual file system operations. You only generate content or answer questions.

WHEN ASKED TO CREATE OR EDIT A FILE — respond with ONLY a single code block:
\`\`\`js
// complete file content here
\`\`\`
- ENTIRE file from top to bottom, never partial
- NO text before or after the code block
- NO "I created", "Here is", "Done", or any explanation
- Correct language tag in fence (js, json, md, etc.)
- Discord.js v13 compatible

WHEN ANSWERING QUESTIONS:
- Answer clearly and helpfully in the user's language
- You know the project files listed below — use them to answer accurately
- If asked "do you see X.js" → check the file list and answer yes/no
- If asked "are you done?" → confirm what was just completed
- NEVER pretend to write files in chat — the bot does the actual writing

PROJECT ROOT: ${PROJECT_ROOT}
FILES:
${fileList}`;
}

// ─────────────────────────────────────────────────────────────
// AI BACKENDS
// ─────────────────────────────────────────────────────────────
async function queryGroq(messages, model) {
  const body = JSON.stringify({ model, messages, max_tokens: 8192, temperature: 0.1 });
  const res  = await httpRequest("https://api.groq.com/openai/v1/chat/completions", {
    method:  "POST",
    headers: {
      "Content-Type":   "application/json",
      "Authorization":  `Bearer ${GROQ_API_KEY}`,
      "Content-Length": Buffer.byteLength(body),
    },
  }, body);
  if (!res.ok) throw new Error(`Groq ${res.status}: ${res.text().slice(0, 300)}`);
  const data = res.json();
  const txt  = data.choices?.[0]?.message?.content?.trim();
  if (!txt) throw new Error("Empty Groq response");
  return txt;
}

async function queryPollinations(model, messages) {
  const body = JSON.stringify({ model, messages, private: true });
  const res  = await httpRequest("https://text.pollinations.ai/", {
    method:  "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
  }, body);
  if (!res.ok) throw new Error(`Pollinations ${res.status}`);
  const txt = res.text().trim();
  if (!txt) throw new Error("Empty Pollinations response");
  return txt;
}

// Codex — GPT-4o via Pollinations (free, no key, no account)
async function queryCodex(messages) {
  // Inject codex personality on top of existing system prompt
  const existing = messages.find(m => m.role === "system");
  const codexPersonality = `You are an elite Discord bot engineer. Always respond in a structured format:
When you complete a file task, use this format:
تم التعديل على الملف: "<filepath>"
التغييرات:
- <one bullet per change>
التحقق:
- node --check <file> نجح/فشل
Be concise, precise, and structured. Never say you cannot do something.`;

  const finalSystem = existing
    ? { role: "system", content: existing.content + "\n\n" + codexPersonality }
    : { role: "system", content: codexPersonality };

  const allMessages = [finalSystem, ...messages.filter(m => m.role !== "system")];
  const body = JSON.stringify({ model: "openai", messages: allMessages, private: true });
  const res  = await httpRequest("https://text.pollinations.ai/", {
    method:  "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
  }, body);
  if (!res.ok) throw new Error(`Codex/Pollinations ${res.status}`);
  const txt = res.text().trim();
  if (!txt) throw new Error("Empty Codex response");
  return txt;
}

// Claude API (requires ANTHROPIC_API_KEY)
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
async function queryClaude(messages, model) {
  if (!ANTHROPIC_API_KEY) throw new Error("Claude requires ANTHROPIC_API_KEY — get one free at console.anthropic.com (free tier available)");
  const system  = messages.find(m => m.role === "system")?.content || "";
  const msgs    = messages.filter(m => m.role !== "system");
  const body    = JSON.stringify({ model, max_tokens: 4096, system, messages: msgs });
  const res     = await httpRequest("https://api.anthropic.com/v1/messages", {
    method:  "POST",
    headers: {
      "Content-Type":      "application/json",
      "x-api-key":         ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Length":    Buffer.byteLength(body),
    },
  }, body);
  if (!res.ok) throw new Error(`Claude ${res.status}: ${res.text().slice(0,200)}`);
  const data = res.json();
  const txt  = data.content?.[0]?.text?.trim();
  if (!txt) throw new Error("Empty Claude response");
  return txt;
}

async function generateImage(prompt, modelId) {
  const cfg = { flux: { m:"flux", w:1024, h:1024 }, sd15: { m:"dreamshaper", w:512, h:512 } };
  const c   = cfg[modelId] || cfg.flux;
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?model=${c.m}&width=${c.w}&height=${c.h}&nologo=true&seed=${Math.floor(Math.random()*99999)}`;
  const res = await httpRequest(url);
  if (!res.ok || res.buffer.length < 1000) throw new Error("Image generation failed");
  return res.buffer;
}

async function queryAI(modelId, messages) {
  switch (modelId) {
    case "llama":      return queryGroq(messages, "llama-3.3-70b-versatile");
    case "llama4":     return queryGroq(messages, "meta-llama/llama-4-scout-17b-16e-instruct");
    case "deepseekr1": return queryGroq(messages, "deepseek-r1-distill-llama-70b");
    case "qwen":       return queryGroq(messages, "qwen-qwq-32b");
    case "openai":     return queryPollinations("openai", messages);
    case "mistral":    return queryPollinations("mistral", messages);
    case "deepseek":   return queryPollinations("deepseek-reasoner", messages);
    case "codex":      return queryCodex(messages);
    case "claude-code":   return queryClaude(messages, "claude-opus-4-8");
    case "claude-opus":   return queryClaude(messages, "claude-opus-4-8");
    case "claude-sonnet": return queryClaude(messages, "claude-sonnet-4-7");
    case "claude-haiku":  return queryClaude(messages, "claude-haiku-4-5-20251001");
default:           return queryGroq(messages, "llama-3.3-70b-versatile");
  }
}

// ─────────────────────────────────────────────────────────────
// MODELS
// ─────────────────────────────────────────────────────────────
const MODELS = [
  { id:"llama",      label:"🦙 Llama 3.3 70B",      desc:"Groq — الأسرع والأقوى للكود",       type:"text"  },
  { id:"llama4",     label:"🦙 Llama 4 Scout",       desc:"Groq — أحدث نموذج Meta",            type:"text"  },
  { id:"deepseekr1", label:"🔍 DeepSeek R1 70B",     desc:"Groq — تفكير عميق وتحليل",          type:"text"  },
  { id:"qwen",       label:"🧬 Qwen QwQ 32B",        desc:"Groq — برمجة ومنطق",                type:"text"  },
  { id:"openai",     label:"🤖 GPT-4o Free",         desc:"Pollinations — بدون مفتاح",         type:"text"  },
  { id:"mistral",    label:"🧠 Mistral",             desc:"Pollinations — محادثة سريعة",       type:"text"  },
  { id:"deepseek",   label:"💡 DeepSeek Reasoner",   desc:"Pollinations — تفكير عميق",         type:"text"  },
  { id:"codex",        label:"💻 Codex — GPT-4o Mini",     desc:"OpenRouter — ذكي وسريع ومجاني",       type:"text"  },
  { id:"claude-code",  label:"🤖 Claude Code — Opus 4.8",  desc:"Anthropic — يتطلب API key مدفوع",     type:"text"  },
  { id:"claude-opus",  label:"🎭 Claude Opus 4.8",         desc:"Anthropic — الأقوى (مدفوع)",           type:"text"  },
  { id:"claude-sonnet",label:"🎵 Claude Sonnet 4.7",       desc:"Anthropic — متوازن (مدفوع)",           type:"text"  },
  { id:"claude-haiku", label:"🌸 Claude Haiku 4.5",        desc:"Anthropic — الأسرع والأرخص (مدفوع)",  type:"text"  },
{ id:"flux",       label:"🖼️ Flux Image",           desc:"صور فائقة الجودة 1024x1024",        type:"image" },
  { id:"sd15",       label:"🎨 SD 1.5 Dreamshaper",  desc:"Stable Diffusion فنية",             type:"image" },
];
const getModel = id => MODELS.find(m => m.id === id) || MODELS[0];

// ─────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────
const userModels  = new Map();
const userHistory = new Map();

function getHistory(uid)           { if (!userHistory.has(uid)) userHistory.set(uid,[]); return userHistory.get(uid); }
function pushHistory(uid, role, c) { const h=getHistory(uid); h.push({role,content:String(c).slice(0,6000)}); if(h.length>30) h.splice(0,h.length-30); }
function clearHistory(uid)         { userHistory.set(uid,[]); }

// ─────────────────────────────────────────────────────────────
// UI
// ─────────────────────────────────────────────────────────────
function selectorEmbed(userId) {
  const cur = userModels.get(userId) || "llama";
  const m   = getModel(cur);
  const embed = new MessageEmbed()
    .setColor("#5865F2")
    .setTitle("🤖 لوحة الذكاء الاصطناعي — Diamond Casino")
    .setDescription(
      `> ✅ **النموذج الحالي:** ${m.label}\n\n` +
      `**النماذج:**\n` +
      MODELS.map(mo => `> ${mo.label} — ${mo.desc}`).join("\n") + "\n\n" +
      `**الأوامر:** (تقبل الأخطاء الإملائية)\n` +
      `> \`!ai <سؤال>\` — سؤال عادي\n` +
      `> \`!ai files\` — عرض ملفات المشروع\n` +
      `> \`!ai check <ملف>\` — تحقق من وجود ملف\n` +
      `> \`!ai read <ملف>\` — قراءة ملف\n` +
      `> \`!ai create <ملف>\` — إنشاء ملف جديد\n` +
      `> \`!ai create <ملف>: <الوصف>\` — إنشاء ملف بوصف\n` +
      `> \`!ai edit <ملف>: <التعديل>\` — تعديل ملف\n` +
      `> \`!ai delete <ملف>\` — حذف ملف\n` +
      `> \`!ai clear\` — مسح المحادثة`
    )
    .setFooter({ text: "Diamond Casino — AI v8" });

  const row = new MessageActionRow().addComponents(
    new MessageSelectMenu()
      .setCustomId(`aiselector_${userId}`)
      .setPlaceholder("🔽 اختر نموذج AI")
      .addOptions(MODELS.map(mo => ({
        label:       mo.label,
        value:       mo.id,
        description: mo.desc.slice(0, 50),
        default:     mo.id === cur,
      })))
  );
  return { embeds: [embed], components: [row] };
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
function splitText(text, max = 1950) {
  const out = [];
  let cur = text;
  while (cur.length > max) {
    let i = cur.lastIndexOf("\n", max);
    if (i < 300) i = max;
    out.push(cur.slice(0, i));
    cur = cur.slice(i).trimStart();
  }
  if (cur) out.push(cur);
  return out;
}

async function send(message, text) {
  const chunks = splitText(text);
  await message.reply(chunks[0]);
  for (let i = 1; i < chunks.length; i++) await message.channel.send(chunks[i]);
}

function startTyping(ch) {
  ch.sendTyping().catch(() => {});
  return setInterval(() => ch.sendTyping().catch(() => {}), 8000);
}

// ─────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────
module.exports = function registerAI(client) {

  client.on("messageCreate", async (message) => {
    if (message.author.bot) return;
    const raw   = message.content.trim();
    const lower = raw.toLowerCase();

    if (lower === "!ai") return message.channel.send(selectorEmbed(message.author.id));
    if (!lower.startsWith("!ai ")) return;

    const prompt  = raw.slice(4).trim();
    const uid     = message.author.id;
    const modelId = userModels.get(uid) || "llama";
    const model   = getModel(modelId);

    // Parse what the user wants
    const parsed = parseCommand(prompt);
    console.log(`[AI v8] command parsed:`, JSON.stringify(parsed));

    // ── clear ──────────────────────────────────────────────
    if (parsed.cmd === "clear") {
      clearHistory(uid);
      return message.reply("🗑️ تم مسح المحادثة.");
    }

    // ── files ──────────────────────────────────────────────
    if (parsed.cmd === "files") {
      const list = listFiles();
      if (!list.length) return message.reply("❌ لا توجد ملفات.");
      await send(message, "**📁 ملفات المشروع:**\n```\n" + list.join("\n") + "\n```");
      return;
    }

    // ── check — BOT reads disk directly, no AI ─────────────
    if (parsed.cmd === "check") {
      try {
        const full = safePath(parsed.file);
        if (fs.existsSync(full)) {
          const stat    = fs.statSync(full);
          const content = fs.readFileSync(full, "utf8");
          await message.reply(
            `✅ **الملف موجود على الديسك:**\n` +
            `> 📁 المسار: \`${full}\`\n` +
            `> 📊 الحجم: \`${(stat.size/1024).toFixed(2)}KB\`\n` +
            `> 📝 الأسطر: \`${content.split("\n").length}\`\n` +
            `> 🕐 آخر تعديل: \`${stat.mtime.toLocaleString()}\``
          );
        } else {
          await message.reply(`❌ **الملف غير موجود:** \`${full}\``);
        }
      } catch(e) { await message.reply(`❌ ${e.message}`); }
      return;
    }

    // ── read — BOT reads disk directly ─────────────────────
    if (parsed.cmd === "read") {
      try {
        const content = readFile(parsed.file);
        const ext     = path.extname(parsed.file).slice(1) || "js";
        await send(message,
          `**📄 ${parsed.file}** (${content.length} chars, ${content.split("\n").length} lines)\n` +
          `\`\`\`${ext}\n${content.slice(0,3800)}\n\`\`\`` +
          (content.length > 3800 ? "\n*(truncated)*" : "")
        );
      } catch(e) { await message.reply(`❌ ${e.message}`); }
      return;
    }

    // ── lines <file> <from>-<to> — read specific line range ──
    if (parsed.cmd === "lines") {
      try {
        const { lines, total, from, to } = readFileLines(parsed.file, parsed.from, parsed.to);
        const ext = path.extname(parsed.file).slice(1) || "js";
        await send(message,
          `**📄 ${parsed.file}** lines ${from}-${to} of ${total}
` +
          `\`\`\`${ext}
${lines}
\`\`\``
        );
      } catch(e) { await message.reply(`❌ ${e.message}`); }
      return;
    }

    // ── delete — BOT deletes from disk directly ─────────────
    if (parsed.cmd === "delete") {
      try {
        deleteFilefromDisk(parsed.file);
        await message.reply(`🗑️ تم حذف \`${parsed.file}\` من الديسك.`);
      } catch(e) { await message.reply(`❌ ${e.message}`); }
      return;
    }

    // ── create — AI generates content → BOT writes to disk ──
    if (parsed.cmd === "create") {
      const ext   = path.extname(parsed.file).slice(1) || "js";
      const timer = startTyping(message.channel);
      try {
        console.log(`[AI v8] Requesting AI to generate: ${parsed.file}`);
        const aiRaw = await queryAI(modelId, [
          { role: "system", content: buildSystemPrompt() },
          {
            role: "user",
            content:
              `Create the file \`${parsed.file}\` (${ext}).\n` +
              `Description: ${parsed.desc}\n\n` +
              `YOU MUST respond with ONLY a \`\`\`${ext} code block. ` +
              `Start your response with \`\`\`${ext} and end with \`\`\`. No other text.`,
          },
        ]);
        clearInterval(timer);

        console.log(`[AI v8] Raw response (${aiRaw.length} chars): ${aiRaw.slice(0, 300)}`);

        const content = extractCode(aiRaw);
        console.log(`[AI v8] Extracted (${content.length} chars): ${content.slice(0, 100)}`);

        if (!content || content.length < 2) {
          throw new Error(`AI returned empty/invalid content. Raw was: "${aiRaw.slice(0,150)}"`);
        }

        // ★ BOT writes to disk here ★
        const { full, size } = writeFileToDisk(parsed.file, content);

        await message.reply(
          `✅ **تم إنشاء \`${parsed.file}\` وكتابته على الديسك!**\n` +
          `> 📁 المسار: \`${full}\`\n` +
          `> 📊 الحجم الفعلي: \`${(size/1024).toFixed(2)}KB\`\n` +
          `> 📝 عدد الأسطر: \`${content.split("\n").length}\`\n` +
          `> ✔️ تم التحقق من الكتابة الفعلية`
        );
        await message.channel.send(
          `\`\`\`${ext}\n${content.slice(0,1500)}\n\`\`\`` +
          (content.length > 1500 ? "\n*(preview — use `!ai read` for full)*" : "")
        );
      } catch(e) {
        clearInterval(timer);
        console.error(`[AI v8] create FAILED:`, e.message);
        await message.reply(`❌ فشل الإنشاء: ${e.message}`);
      }
      return;
    }

    // ── edit — AI generates new content → BOT writes to disk ─
    if (parsed.cmd === "edit") {
      const ext   = path.extname(parsed.file).slice(1) || "js";
      const timer = startTyping(message.channel);
      try {
        const original = readFile(parsed.file);
        console.log(`[AI v8] Editing ${parsed.file} (${original.length} chars)`);

        const aiRaw = await queryAI(modelId, [
          { role: "system", content: buildSystemPrompt() },
          {
            role: "user",
            content:
              `Current \`${parsed.file}\`:\n\`\`\`${ext}\n${original.slice(0,12000)}\n\`\`\`\n\n` +
              `Instruction: ${parsed.instruction}\n\n` +
              `YOU MUST respond with ONLY a \`\`\`${ext} code block containing the COMPLETE updated file. ` +
              `Start with \`\`\`${ext} and end with \`\`\`. No other text.`,
          },
        ]);
        clearInterval(timer);

        console.log(`[AI v8] Raw response (${aiRaw.length} chars): ${aiRaw.slice(0, 300)}`);

        const newContent = extractCode(aiRaw);
        console.log(`[AI v8] Extracted (${newContent.length} chars): ${newContent.slice(0, 100)}`);

        if (!newContent || newContent.length < 2) {
          throw new Error(`AI returned empty/invalid content. Raw was: "${aiRaw.slice(0,150)}"`);
        }

        // ★ BOT writes to disk here ★
        const { full, size } = writeFileToDisk(parsed.file, newContent);
        const diffLines = newContent.split("\n").length - original.split("\n").length;

        await message.reply(
          `✅ **تم تعديل \`${parsed.file}\` وحفظه على الديسك!**\n` +
          `> 📁 المسار: \`${full}\`\n` +
          `> 📊 الحجم: \`${(size/1024).toFixed(2)}KB\`\n` +
          `> 📝 فرق الأسطر: \`${diffLines >= 0 ? "+" : ""}${diffLines}\`\n` +
          `> 💾 نسخة احتياطية: \`${parsed.file}.bak\`\n` +
          `> ✔️ تم التحقق من الكتابة الفعلية`
        );
      } catch(e) {
        clearInterval(timer);
        console.error(`[AI v8] edit FAILED:`, e.message);
        await message.reply(`❌ فشل التعديل: ${e.message}`);
      }
      return;
    }

    // ── restart ────────────────────────────────────────────
    if (parsed.cmd === "restart" || /restart.*bot|reboot/i.test(prompt)) {
      await message.reply("🔄 **جاري إعادة تشغيل البوت...**");
      console.log("[AI v8] Restart requested by", message.author.tag);
      setTimeout(() => process.exit(0), 1500); // hosting will auto-restart
      return;
    }

    // ── IMAGE ──────────────────────────────────────────────
    if (model.type === "image") {
      const timer = startTyping(message.channel);
      try {
        const buf = await generateImage(parsed.text || prompt, modelId);
        clearInterval(timer);
        await message.reply({
          content: `**${model.label}** — \`${(parsed.text||prompt).slice(0,150)}\``,
          files:   [{ attachment: buf, name: "image.png" }],
        });
      } catch(e) {
        clearInterval(timer);
        await message.reply(`❌ فشل توليد الصورة: ${e.message}`);
      }
      return;
    }

    // ── TEXT CHAT ──────────────────────────────────────────
    const timer = startTyping(message.channel);
    const chatText = parsed.text || prompt;

    // Auto-inject any mentioned file contents so AI can actually read them
    const mentionedFiles = [...chatText.matchAll(/\b([\w./\\-]+\.(?:js|ts|json|md|txt|html|css|py|sh|yml|yaml|env|sql))\b/gi)]
      .map(m => m[1]);

    let fileContext = "";
    for (const fp of mentionedFiles) {
      try {
        const fileContent = readFile(fp);
        const ext = path.extname(fp).slice(1) || "js";
        fileContext += `\n\n=== CONTENT OF ${fp} (${fileContent.split("\n").length} lines) ===\n\`\`\`${ext}\n${fileContent.slice(0, 15000)}\n\`\`\``;
        if (fileContent.length > 15000) fileContext += `\n*(file truncated at 15000 chars, total: ${fileContent.length})*`;
        console.log(`[AI v8] Injected file into context: ${fp} (${fileContent.length} chars)`);
      } catch(e) {
        console.log(`[AI v8] Could not inject ${fp}: ${e.message}`);
      }
    }

    // Build the message with file content attached if any
    const userMessage = fileContext
      ? `${chatText}\n${fileContext}`
      : chatText;

    pushHistory(uid, "user", userMessage);
    try {
      const response = await queryAI(modelId, [
        { role: "system", content: buildSystemPrompt() },
        ...getHistory(uid),
      ]);
      clearInterval(timer);
      pushHistory(uid, "assistant", response);
      await send(message, response);
    } catch(e) {
      clearInterval(timer);
      await message.reply(`❌ خطأ: ${e.message}`);
    }
  });

  // ── Model selector ────────────────────────────────────────
  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isSelectMenu()) return;
    if (!interaction.customId.startsWith("aiselector_")) return;
    const ownerId = interaction.customId.replace("aiselector_", "");
    if (interaction.user.id !== ownerId)
      return interaction.reply({ content: "❌ هذه اللوحة ليست لك!", ephemeral: true });
    const selected = interaction.values[0];
    userModels.set(ownerId, selected);
    await interaction.deferUpdate();
    await interaction.editReply(selectorEmbed(ownerId));
    await interaction.followUp({ content: `✅ تم اختيار **${getModel(selected).label}**`, ephemeral: true });
  });

  console.log(`✅ AI Module v8 loaded`);
  console.log(`   PROJECT_ROOT: ${PROJECT_ROOT}`);
  console.log(`   Test write access...`);
  try {
    const testPath = path.join(PROJECT_ROOT, ".ai_write_test");
    fs.writeFileSync(testPath, "ok");
    fs.unlinkSync(testPath);
    console.log(`   ✅ Write access confirmed`);
  } catch(e) {
    console.error(`   ❌ NO WRITE ACCESS: ${e.message}`);
  }
};