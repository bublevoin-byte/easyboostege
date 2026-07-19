// Easy Boost — сервер: вход через Telegram, прогресс, ИИ-прокси с резервом (Grok → Groq).
import express from 'express';
import jwt from 'jsonwebtoken';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { closeDatabase, confirmTelegramAuthCode, consumeTelegramAuthCode, createTelegramAuthCode, createWritingAttempt, finishWritingAttempt, getProgress, getUser, healthCheck, saveProgress, getUserByTelegram, createTelegramUser, grantDays, logAiRequest, markTrialUsed, getSub } from './db.js';
import { config } from './config.js';
import { buildWritingPrompt, parseAndValidateWritingReview, WRITING_PROMPT_VERSION, writingRequestSchema } from './ai/writing.js';
import { protectCookieRequests } from './security/request-origin.js';
import { classifyBodyParserError, legacyAiRequestSchema, validateProgress } from './validation/api-input.js';
import { contentSecurityPolicy } from './security/csp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendHtml = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');

const SECRET = config.jwtSecret;
const PORT = config.port;

// ИИ: основной Grok (xAI, платный), резерв Groq (бесплатный)
const XAI_KEY = config.ai.xaiKey;
const XAI_MODEL = config.ai.xaiModel;
const GROQ_KEY = config.ai.groqKey;
const GROQ_MODEL = config.ai.groqModel;

// Telegram
const TG_TOKEN = config.telegram.token;
const ADMIN_ID = config.telegram.adminId; // твой Telegram ID — тебе приходят заявки на оплату
const APP_URL = config.appUrl; // адрес приложения для ссылки входа из бота
const TRIAL_DAYS = 30;
const SUB_DAYS = 30;
let BOT_USERNAME = '';

const app = express();
if (config.isProduction) app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: contentSecurityPolicy(frontendHtml, config.isProduction),
  crossOriginEmbedderPolicy: false,
  hsts: config.isProduction ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  referrerPolicy: { policy: 'no-referrer' },
}));
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=(self), payment=()');
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  const incoming = String(req.headers['x-request-id'] || '');
  req.requestId = /^[A-Za-z0-9._-]{8,100}$/u.test(incoming) ? incoming : crypto.randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  const startedAt = Date.now();
  const requestPath = req.path;
  res.once('finish', () => {
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
      type: 'http_request',
      requestId: req.requestId,
      method: req.method,
      path: requestPath,
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
      authenticated: Boolean(req.user),
    }));
  });
  next();
});
app.use('/api', protectCookieRequests(config.appUrl));

app.get('/health/live', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/health/ready', async (req, res) => {
  try {
    await healthCheck();
    res.json({ status: 'ready', storage: config.database.provider });
  } catch (error) {
    res.status(503).json({ status: 'not_ready' });
  }
});
app.get('/', async (req, res, next) => {
  try {
    const loginCode = String(req.query.login_code || '');
    if (loginCode) {
      const confirmed = await consumeTelegramAuthCode(loginCode);
      if (!confirmed) return res.redirect('/?login_error=expired');
      const existing = await getUserByTelegram(confirmed.telegram_id);
      const username = existing ? existing.username : await createTelegramUser(confirmed.telegram_id, confirmed.name);
      setAuthCookie(req, res, makeToken(username));
      return res.redirect('/');
    }

    // Временная обратная совместимость со старыми ссылками. Новые ссылки JWT в URL не создают.
    const token = req.query.t;
    if (!token) return next();
    try { jwt.verify(token, SECRET); setAuthCookie(req, res, token); } catch (error) {}
    res.redirect('/');
  } catch (error) { next(error); }
});
app.use(express.static(path.join(__dirname, 'public')));

function makeToken(username) {
  return jwt.sign({ u: username }, SECRET, { expiresIn: config.sessionDays + 'd' });
}
function getCookie(req, name) {
  const c = req.headers.cookie || '';
  const m = c.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : '';
}
function setAuthCookie(req, res, token) {
  const secure = (req.headers['x-forwarded-proto'] || req.protocol) === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', 'eb_token=' + encodeURIComponent(token) + '; Path=/; Max-Age=' + (config.sessionDays * 86400) + '; HttpOnly; SameSite=Lax' + secure);
}
async function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = (h.startsWith('Bearer ') ? h.slice(7) : '') || getCookie(req, 'eb_token');
  try {
    const username = jwt.verify(token, SECRET).u;
    if (!await getUser(username)) return res.status(401).json({ error: 'Требуется вход' });
    req.user = username;
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
function fmtDate(ms) { return new Date(ms).toLocaleDateString('ru-RU'); }
function nameOf(from) {
  return ((from.first_name || '') + ' ' + (from.last_name || '')).trim() || from.username || ('id' + from.id);
}
function subKeyboard() {
  return { inline_keyboard: [
    [{ text: '🎁 Попробовать бесплатно месяц', callback_data: 'trial' }],
    [{ text: '💳 Оплатить подписку', callback_data: 'pay' }],
  ] };
}

// Входящее сообщение боту
async function onMessage(m) {
  if (!m.text) return;
  const chatId = m.chat.id, fromId = m.from.id, name = nameOf(m.from);
  if (m.text.startsWith('/start')) {
    const code = m.text.split(' ')[1];
    if (code && await confirmTelegramAuthCode(code, fromId, name)) {
      const existing = await getUserByTelegram(fromId);
      const uname = existing?.username || await createTelegramUser(fromId, name);
      const loginUrl = APP_URL + '/?login_code=' + encodeURIComponent(code);
      await tgApi('sendMessage', {
        chat_id: chatId,
        text: 'Готово! Вход выполнен ✅\nНажми кнопку, чтобы открыть приложение:',
        reply_markup: { inline_keyboard: [
          [{ text: '✅ Открыть Easy Boost', url: loginUrl }],
          [{ text: '🎁 Попробовать бесплатно месяц', callback_data: 'trial' }],
          [{ text: '💳 Оплатить подписку', callback_data: 'pay' }],
        ] },
      });
    } else {
      await tgApi('sendMessage', { chat_id: chatId, text: 'Привет! Это Easy Boost 🎓 — подготовка к ЕГЭ по английскому.\nВыбери, как начать:', reply_markup: subKeyboard() });
    }
    return;
  }
  if (m.text.startsWith('/id')) {
    await tgApi('sendMessage', { chat_id: chatId, text: 'Твой Telegram ID: ' + fromId });
    return;
  }
  await tgApi('sendMessage', { chat_id: chatId, text: 'Меню Easy Boost:', reply_markup: subKeyboard() });
}

// Нажатие inline-кнопки
async function onCallback(cq) {
  const data = cq.data || '';
  const fromId = cq.from.id, name = nameOf(cq.from);
  const chatId = cq.message && cq.message.chat.id;
  const ack = (text) => tgApi('answerCallbackQuery', { callback_query_id: cq.id, text: text || '' });

  if (data === 'trial') {
    const ex = await getUserByTelegram(fromId);
    if (ex && ex.trial_used) {
      await ack('Пробный период уже был использован');
      await tgApi('sendMessage', { chat_id: chatId, text: 'Пробный месяц уже был активирован раньше. Чтобы продолжить — оформи подписку.', reply_markup: { inline_keyboard: [[{ text: '💳 Оплатить подписку', callback_data: 'pay' }]] } });
      return;
    }
    const g = await grantDays(fromId, TRIAL_DAYS, name);
    await markTrialUsed(fromId, name);
    await ack('Готово! Месяц активирован');
    await tgApi('sendMessage', { chat_id: chatId, text: '🎁 Месяц бесплатного доступа активирован до ' + fmtDate(g.sub_until) + '!\nОткрой приложение Easy Boost и занимайся 💪' });
    return;
  }

  if (data === 'pay') {
    await ack('Заявка отправлена');
    await tgApi('sendMessage', { chat_id: chatId, text: '💳 Заявка на подписку отправлена. Как только оплату подтвердят, доступ откроется — обычно это быстро. Спасибо!' });
    if (ADMIN_ID) {
      await tgApi('sendMessage', {
        chat_id: ADMIN_ID,
        text: '💳 Запрос на оплату подписки\n\nПользователь: ' + name + '\nID: ' + fromId,
        reply_markup: { inline_keyboard: [[
          { text: '✅ Активировать', callback_data: 'activate:' + fromId },
          { text: '❌ Отказ', callback_data: 'deny:' + fromId },
        ]] },
      });
    } else {
      console.log('ADMIN_TELEGRAM_ID не задан — заявку на оплату некому отправить');
    }
    return;
  }

  if (data.startsWith('activate:') || data.startsWith('deny:')) {
    if (String(fromId) !== String(ADMIN_ID)) { await ack('Недостаточно прав'); return; }
    const targetId = Number(data.split(':')[1]);
    if (data.startsWith('activate:')) {
      const g = await grantDays(targetId, SUB_DAYS);
      await ack('Активировано');
      if (cq.message) await tgApi('editMessageText', { chat_id: chatId, message_id: cq.message.message_id, text: (cq.message.text || '') + '\n\n✅ Активировано до ' + fmtDate(g.sub_until) });
      await tgApi('sendMessage', { chat_id: targetId, text: '✅ Подписка активирована! Доступ открыт на 30 дней (до ' + fmtDate(g.sub_until) + ').\nОткрой приложение Easy Boost 🎓' });
    } else {
      await ack('Отклонено');
      if (cq.message) await tgApi('editMessageText', { chat_id: chatId, message_id: cq.message.message_id, text: (cq.message.text || '') + '\n\n❌ Отклонено' });
      await tgApi('sendMessage', { chat_id: targetId, text: '❌ Платёж не подтверждён. Пожалуйста, обратитесь в поддержку сервиса.' });
    }
    return;
  }
  await ack();
}

async function startTelegram() {
  if (!TG_TOKEN) { console.log('Telegram: TELEGRAM_BOT_TOKEN не задан — вход через Telegram выключен'); return; }
  try {
    const me = await tgApi('getMe');
    if (me.ok) { BOT_USERNAME = me.result.username; console.log('Telegram bot: @' + BOT_USERNAME); }
    else { console.log('Telegram getMe error:', me.description); return; }
  } catch (e) { console.log('Telegram getMe failed:', e.message); return; }

  console.log('Telegram admin notifications:', ADMIN_ID ? 'configured' : 'disabled');
  let offset = 0;
  const poll = async () => {
    try {
      const upd = await tgApi('getUpdates', { offset, timeout: 30 });
      if (upd.ok) {
        for (const u of upd.result) {
          offset = u.update_id + 1;
          try {
            if (u.message) await onMessage(u.message);
            else if (u.callback_query) await onCallback(u.callback_query);
          } catch (e) { console.log('Telegram handler error:', e.message); }
        }
      }
    } catch (e) { /* сеть — попробуем снова */ }
    setTimeout(poll, 500);
  };
  poll();
}

const telegramStartLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.telegram.authStartsPer15Minutes,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Слишком много попыток входа. Попробуйте позже.' } },
});

const telegramCheckLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.telegram.authChecksPer15Minutes,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Слишком много проверок входа. Начните вход заново.' } },
});

app.post('/api/tg/start', telegramStartLimiter, async (req, res, next) => {
  try {
  if (!TG_TOKEN || !BOT_USERNAME) return res.status(503).json({ error: 'Telegram-вход не настроен на сервере' });
  const code = crypto.randomBytes(24).toString('base64url');
  await createTelegramAuthCode(code, Date.now() + config.telegram.authCodeTtlMs);
  res.json({ code, url: `https://t.me/${BOT_USERNAME}?start=${code}` });
  } catch (error) { next(error); }
});
app.get('/api/tg/check', telegramCheckLimiter, async (req, res, next) => {
  try {
    const code = String(req.query.code || '');
    const r = code && await consumeTelegramAuthCode(code);
    if (!r) return res.json({ pending: true });
    const existing = await getUserByTelegram(r.telegram_id);
    const uname = existing ? existing.username : await createTelegramUser(r.telegram_id, r.name);
    const token = makeToken(uname);
    setAuthCookie(req, res, token);
    res.json({ authenticated: true, username: uname, ...await getSub(uname), bot: BOT_USERNAME });
  } catch (error) { next(error); }
});

// ---- статус доступа (подписка) ----
app.get('/api/me', auth, async (req, res, next) => {
  try {
    const token = makeToken(req.user);
    setAuthCookie(req, res, token);
    res.json({ authenticated: true, username: req.user, bot: BOT_USERNAME, ...await getSub(req.user) });
  } catch (error) { next(error); }
});
app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'eb_token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
  res.json({ ok: true });
});

// ---- прогресс ----
app.get('/api/progress', auth, async (req, res, next) => {
  try { res.json(await getProgress(req.user)); } catch (error) { next(error); }
});
app.post('/api/progress', auth, async (req, res, next) => {
  try {
    const parsed = validateProgress(req.body);
    if (!parsed.ok) {
      return res.status(400).json({ error: { code: 'INVALID_PROGRESS', message: 'Некорректные данные прогресса.', reason: parsed.code } });
    }
    await saveProgress(req.user, parsed.data);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

async function askProvider({ url, key, model }, system, user) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.ai.timeoutMs);
  let r;
  try {
    r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    signal: controller.signal,
    body: JSON.stringify({
      model,
      temperature: 0.3,
      max_tokens: 1600,
      messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: user }],
    }),
  });
  } finally {
    clearTimeout(timeout);
  }
  const j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || ('HTTP ' + r.status));
  return j.choices?.[0]?.message?.content || '';
}

function aiProviders() {
  const providers = [];
  if (XAI_KEY) providers.push({ name: 'grok', url: 'https://api.x.ai/v1/chat/completions', key: XAI_KEY, model: XAI_MODEL });
  if (GROQ_KEY) providers.push({ name: 'groq', url: 'https://api.groq.com/openai/v1/chat/completions', key: GROQ_KEY, model: GROQ_MODEL });
  return providers;
}

async function askWithFallback(system, user) {
  const providers = aiProviders();
  if (!providers.length) {
    const error = new Error('AI_NOT_CONFIGURED');
    error.status = 503;
    throw error;
  }
  let lastError = null;
  for (const provider of providers) {
    try {
      return { text: await askProvider(provider, system, user), provider: provider.name, model: provider.model };
    } catch (error) {
      lastError = error;
      lastError.provider = provider.name;
      lastError.model = provider.model;
    }
  }
  const error = new Error('AI_UNAVAILABLE');
  error.status = 502;
  error.cause = lastError;
  error.provider = lastError?.provider;
  error.model = lastError?.model;
  throw error;
}

function createUserRateLimiter(limit) {
  return rateLimit({
    windowMs: 60 * 60 * 1000,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (req) => req.user,
    message: { error: { code: 'RATE_LIMITED', message: 'Слишком много запросов. Попробуйте позже.' } },
  });
}

const chatLimiter = createUserRateLimiter(config.ai.maxRequestsPerHour);
const writingLimiter = createUserRateLimiter(config.ai.maxWritingRequestsPerHour);
const ttsLimiter = createUserRateLimiter(config.ai.maxTtsRequestsPerHour);
const sttLimiter = createUserRateLimiter(config.ai.maxSttRequestsPerHour);

async function requireActiveSubscription(req, res, next) {
  try {
    const subscription = await getSub(req.user);
    if (!subscription.active) {
      return res.status(403).json({ error: { code: 'SUBSCRIPTION_REQUIRED', message: 'Для этой функции требуется активный доступ.' } });
    }
    next();
  } catch (error) { next(error); }
}

app.post('/api/v1/ai/evaluate-writing', auth, requireActiveSubscription, writingLimiter, async (req, res, next) => {
  const parsed = writingRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Некорректные данные письменного задания.',
        fields: parsed.error.issues.map((issue) => issue.path.join('.')),
      },
    });
  }

  const input = parsed.data;
  const startedAt = Date.now();
  let attemptId;
  let provider = null;
  let model = null;
  try {
    attemptId = await createWritingAttempt(req.user, input, WRITING_PROMPT_VERSION);
    const prompt = buildWritingPrompt(input);
    const result = await askWithFallback(prompt.system, prompt.user);
    provider = result.provider;
    model = result.model;
    const review = parseAndValidateWritingReview(result.text, input);
    await finishWritingAttempt(attemptId, { status: 'completed', review, provider });
    await logAiRequest({
      username: req.user,
      operation: input.taskType,
      provider,
      model,
      promptVersion: WRITING_PROMPT_VERSION,
      status: 'completed',
      durationMs: Date.now() - startedAt,
    });
    res.json({ review, provider, attemptId });
  } catch (error) {
    if (!attemptId) return next(error);
    provider ||= error.provider || error.cause?.provider || null;
    model ||= error.model || error.cause?.model || null;
    const invalidResponse = String(error.message).startsWith('AI_RESPONSE_');
    const code = invalidResponse
      ? 'AI_RESPONSE_INVALID'
      : error.message === 'AI_NOT_CONFIGURED' ? 'AI_NOT_CONFIGURED' : 'AI_UNAVAILABLE';
    const status = invalidResponse ? 502 : (error.status || 502);
    const writes = [logAiRequest({
      username: req.user,
      operation: input.taskType,
      provider,
      model,
      promptVersion: WRITING_PROMPT_VERSION,
      status: 'failed',
      durationMs: Date.now() - startedAt,
      errorCode: code,
    })];
    if (attemptId) writes.push(finishWritingAttempt(attemptId, { status: 'failed', provider, errorCode: code }));
    await Promise.allSettled(writes);
    const message = code === 'AI_NOT_CONFIGURED'
      ? 'ИИ не настроен на сервере.'
      : code === 'AI_RESPONSE_INVALID'
        ? 'ИИ вернул некорректный разбор. Попробуйте ещё раз.'
        : 'ИИ временно недоступен.';
    res.status(status).json({ error: { code, message } });
  }
});

app.post('/api/ai', auth, requireActiveSubscription, chatLimiter, async (req, res) => {
  const parsed = legacyAiRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Некорректный запрос к ИИ.' } });
  }
  const { system, user } = parsed.data;
  const providers = aiProviders();
  if (!providers.length) return res.status(503).json({ error: 'ИИ не настроен (нет ключей)' });
  let lastErr = '';
  for (const p of providers) {
    try { return res.json({ text: await askProvider(p, system, user), provider: p.name }); }
    catch (e) { lastErr = e.message; }
  }
  res.status(502).json({ error: 'ИИ недоступен: ' + lastErr });
});

// ---- нейро-озвучка: Grok TTS (основной) + Edge TTS (запасной и для медленного) ----
const TTS_DIR = path.join(__dirname, 'tts-cache');
try { fs.mkdirSync(TTS_DIR, { recursive: true }); } catch (e) {}
const TTS_VOICES = new Set(['en-GB-SoniaNeural', 'en-GB-RyanNeural', 'en-GB-LibbyNeural', 'en-GB-ThomasNeural']);
// соответствие ролей: женский/мужской
const GROK_VOICE = { 'en-GB-SoniaNeural': 'eve', 'en-GB-RyanNeural': 'rex', 'en-GB-LibbyNeural': 'ara', 'en-GB-ThomasNeural': 'leo' };
let _ttsMod = null;

function ttsSend(res, buf, file) {
  try { fs.writeFileSync(file, buf); } catch (e) {}
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'public, max-age=604800');
  res.end(buf);
}
async function grokTts(text, voice) {
  const r = await fetch('https://api.x.ai/v1/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + XAI_KEY },
    body: JSON.stringify({ text, voice_id: GROK_VOICE[voice] || 'eve', language: 'en' }),
  });
  if (!r.ok) throw new Error('Grok TTS HTTP ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  if (!buf.length) throw new Error('Grok TTS: пустое аудио');
  return buf;
}
async function edgeTts(text, voice, slow) {
  if (!_ttsMod) _ttsMod = await import('msedge-tts');
  const { MsEdgeTTS, OUTPUT_FORMAT } = _ttsMod;
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  const st = await tts.toStream(text, slow ? { rate: '-25%' } : undefined);
  const stream = st && st.audioStream ? st.audioStream : st;
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => { const b = Buffer.concat(chunks); b.length ? resolve(b) : reject(new Error('пустое аудио')); });
    stream.on('error', reject);
  });
}
app.get('/api/tts', auth, requireActiveSubscription, ttsLimiter, async (req, res) => {
  const text = String(req.query.text || '').slice(0, 500).trim();
  if (!text) return res.status(400).json({ error: 'нет текста' });
  const voice = TTS_VOICES.has(req.query.voice) ? req.query.voice : 'en-GB-SoniaNeural';
  const slow = req.query.slow === '1';
  const useGrok = !!XAI_KEY && !slow;
  const key = crypto.createHash('sha1').update((useGrok ? 'g' : 'e') + '|' + voice + '|' + (slow ? 1 : 0) + '|' + text).digest('hex');
  const file = path.join(TTS_DIR, key + '.mp3');
  if (fs.existsSync(file)) {
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'public, max-age=604800');
    return res.sendFile(file);
  }
  if (useGrok) {
    try { return ttsSend(res, await grokTts(text, voice), file); }
    catch (e) { console.log('Grok TTS не сработал, пробую Edge:', e.message); }
  }
  try {
    const ekey = crypto.createHash('sha1').update('e|' + voice + '|' + (slow ? 1 : 0) + '|' + text).digest('hex');
    return ttsSend(res, await edgeTts(text, voice, slow), path.join(TTS_DIR, ekey + '.mp3'));
  } catch (e) {
    res.status(503).json({ error: 'Озвучка недоступна: ' + e.message });
  }
});

// ---- расшифровка речи (Grok STT) для оценки говорения ----
app.post('/api/stt', auth, requireActiveSubscription, sttLimiter, express.raw({ type: () => true, limit: '20mb' }), async (req, res) => {
  try {
    if (!XAI_KEY) return res.status(503).json({ error: 'XAI_API_KEY не задан на сервере' });
    const buf = req.body;
    if (!buf || !buf.length) return res.status(400).json({ error: 'нет аудио' });
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type: req.headers['content-type'] || 'audio/webm' }), 'rec.webm');
    fd.append('language', 'en');
    const r = await fetch('https://api.x.ai/v1/stt', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + XAI_KEY },
      body: fd,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({ error: 'STT: ' + ((j.error && (j.error.message || j.error)) || r.status) });
    res.json({ text: j.text || '', duration: j.duration || 0 });
  } catch (e) {
    res.status(502).json({ error: 'STT: ' + e.message });
  }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((error, req, res, next) => {
  const publicError = classifyBodyParserError(error);
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: 'error',
    type: 'request_error',
    requestId: req.requestId,
    method: req.method,
    path: req.path,
    errorCode: publicError?.code || error.code || 'INTERNAL_ERROR',
  }));
  if (res.headersSent) return next(error);
  if (publicError) {
    return res.status(publicError.status).json({
      error: { code: publicError.code, message: publicError.message, requestId: req.requestId },
    });
  }
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Внутренняя ошибка сервера.', requestId: req.requestId } });
});

const server = app.listen(PORT, () => console.log('Easy Boost server on http://localhost:' + PORT));
startTelegram();

async function shutdown(signal) {
  console.log(signal + ': shutting down');
  server.close(async () => {
    try { await closeDatabase(); } finally { process.exit(0); }
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
