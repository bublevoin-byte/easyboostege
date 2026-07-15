// Easy Boost — сервер: вход через Telegram, прогресс, ИИ-прокси с резервом (Grok → Groq).
import express from 'express';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { getProgress, saveProgress, getUserByTelegram, createTelegramUser } from './db.js';

dotenv.config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const PORT = process.env.PORT || 3000;

// ИИ: основной Grok (xAI, платный), резерв Groq (бесплатный)
const XAI_KEY = process.env.XAI_API_KEY || '';
const XAI_MODEL = process.env.XAI_MODEL || 'grok-4.5';
const GROQ_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

// Telegram
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
let BOT_USERNAME = '';
const tgCodes = {};   // code -> ts (ожидает подтверждения)
const tgReady = {};   // code -> {telegram_id, name} (подтверждён)

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function makeToken(username) {
  return jwt.sign({ u: username }, SECRET, { expiresIn: '60d' });
}
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  try {
    req.user = jwt.verify(token, SECRET).u;
    next();
  } catch (e) {
    res.status(401).json({ error: 'Требуется вход' });
  }
}

// ---- Telegram bot ----
async function tgApi(method, params) {
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params || {}),
  });
  return r.json();
}
async function startTelegram() {
  if (!TG_TOKEN) { console.log('Telegram: TELEGRAM_BOT_TOKEN не задан — вход через Telegram выключен'); return; }
  try {
    const me = await tgApi('getMe');
    if (me.ok) { BOT_USERNAME = me.result.username; console.log('Telegram bot: @' + BOT_USERNAME); }
    else { console.log('Telegram getMe error:', me.description); return; }
  } catch (e) { console.log('Telegram getMe failed:', e.message); return; }

  let offset = 0;
  const poll = async () => {
    try {
      const upd = await tgApi('getUpdates', { offset, timeout: 30 });
      if (upd.ok) {
        for (const u of upd.result) {
          offset = u.update_id + 1;
          const m = u.message;
          if (m && m.text && m.text.startsWith('/start')) {
            const code = m.text.split(' ')[1];
            const name = ((m.from.first_name || '') + ' ' + (m.from.last_name || '')).trim() || m.from.username || ('id' + m.from.id);
            if (code && tgCodes[code]) {
              tgReady[code] = { telegram_id: m.from.id, name };
              await tgApi('sendMessage', { chat_id: m.chat.id, text: 'Готово! Вернись в приложение Easy Boost — вход выполнен ✅' });
            } else {
              await tgApi('sendMessage', { chat_id: m.chat.id, text: 'Привет! Чтобы войти, нажми «Войти через Telegram» в приложении Easy Boost.' });
            }
          }
        }
      }
    } catch (e) { /* сеть — попробуем снова */ }
    setTimeout(poll, 500);
  };
  poll();
}

app.post('/api/tg/start', (req, res) => {
  if (!TG_TOKEN || !BOT_USERNAME) return res.status(503).json({ error: 'Telegram-вход не настроен на сервере' });
  const code = Math.random().toString(36).slice(2, 10);
  tgCodes[code] = Date.now();
  res.json({ code, url: `https://t.me/${BOT_USERNAME}?start=${code}` });
});
app.get('/api/tg/check', (req, res) => {
  const code = req.query.code;
  const r = code && tgReady[code];
  if (!r) return res.json({ pending: true });
  delete tgReady[code]; delete tgCodes[code];
  const existing = getUserByTelegram(r.telegram_id);
  const uname = existing ? existing.username : createTelegramUser(r.telegram_id, r.name);
  res.json({ token: makeToken(uname), username: uname });
});

// ---- прогресс ----
app.get('/api/progress', auth, (req, res) => res.json(getProgress(req.user)));
app.post('/api/progress', auth, (req, res) => {
  saveProgress(req.user, req.body || {});
  res.json({ ok: true });
});

// ---- лимит на ИИ ----
const hits = {};
function overLimit(user) {
  const now = Date.now();
  const w = hits[user] || { t: now, n: 0 };
  if (now - w.t > 3600000) { w.t = now; w.n = 0; }
  w.n++;
  hits[user] = w;
  return w.n > 200;
}
async function askProvider({ url, key, model }, system, user) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({
      model,
      temperature: 0.3,
      max_tokens: 1600,
      messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: user }],
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || ('HTTP ' + r.status));
  return j.choices?.[0]?.message?.content || '';
}
app.post('/api/ai', auth, async (req, res) => {
  if (overLimit(req.user)) return res.status(429).json({ error: 'Слишком много запросов, попробуй позже' });
  const { system, user } = req.body || {};
  if (!user) return res.status(400).json({ error: 'Пустой запрос' });
  const providers = [];
  if (XAI_KEY) providers.push({ name: 'grok', url: 'https://api.x.ai/v1/chat/completions', key: XAI_KEY, model: XAI_MODEL });
  if (GROQ_KEY) providers.push({ name: 'groq', url: 'https://api.groq.com/openai/v1/chat/completions', key: GROQ_KEY, model: GROQ_MODEL });
  if (!providers.length) return res.status(503).json({ error: 'ИИ не настроен (нет ключей)' });
  let lastErr = '';
  for (const p of providers) {
    try { return res.json({ text: await askProvider(p, system, user), provider: p.name }); }
    catch (e) { lastErr = e.message; }
  }
  res.status(502).json({ error: 'ИИ недоступен: ' + lastErr });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log('Easy Boost server on http://localhost:' + PORT));
startTelegram();
