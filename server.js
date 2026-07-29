// Easy Boost — сервер: вход через Telegram, прогресс, ИИ-прокси с резервом (Grok → Groq).
import express from 'express';
import compression from 'compression';
import jwt from 'jsonwebtoken';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { activateTrial, closeDatabase, confirmTelegramAuthCode, consumeTelegramAuthCode, countAiRequestsSince, createPaymentRequest, createSession, createSpeakingAttempt, createTelegramAuthCode, createWritingAttempt, deleteUserData, exportUserData, finishSpeakingAttempt, finishWritingAttempt, getAiUsageMetrics, getGeneratedTask, getSharedGeneratedTask, getPrivacyConsent, getProgress, getUser, healthCheck, isSessionActive, recordModuleAttempt, resolvePaymentRequest, revokeSession, saveGeneratedTask, saveProgress, setPrivacyConsent, setUserRole, upsertErrorBank, upsertWordProgress, mergeProgress, getUserByTelegram, createTelegramUser, logAiRequest, getSub } from './db.js';
import { config } from './config.js';
import { buildWritingPrompt, parseAndValidateWritingReview, WRITING_PROMPT_VERSION, writingRequestSchema } from './ai/writing.js';
import { buildContentPrompt, CONTENT_PROMPT_VERSION, contentRequestSchema, parseContentResponse } from './ai/content.js';
import { buildSpeakingPrompt, buildSpeakingSamplePrompt, parseSpeakingReview, parseSpeakingSample, SPEAKING_PROMPT_VERSION, speakingRequestSchema, speakingSampleRequestSchema } from './ai/speaking.js';
import { estimateCostMicrousd, runProviderFallback, TtlCache } from './ai/provider-control.js';
import { pruneAudioCache, validateAudioUpload, withTimeout } from './audio/controls.js';
import { protectCookieRequests } from './security/request-origin.js';
import { classifyBodyParserError, validateProgress } from './validation/api-input.js';
import { moduleAttemptSchema } from './validation/module-attempt.js';
import { wordProgressBatchSchema } from './validation/word-progress.js';
import { errorBankBatchSchema } from './validation/error-bank.js';
import { parseTelegramUpdate } from './validation/telegram-update.js';
import { contentSecurityPolicy } from './security/csp.js';
import { metricsSnapshot, recordDependencyEvent, recordHttpRequest } from './observability/metrics.js';
import { collectSystemMetrics } from './observability/system-metrics.js';
import { createApiVersionRewrite } from './middleware/api-version.js';
import { createAuthentication } from './middleware/authentication.js';
import { createAccessControl, createAnonymousIpLimiter } from './middleware/subscription.js';
import { createSubscriptionService } from './services/subscription.js';
import { createTelegramService } from './services/telegram.js';
import { createUserRoutes } from './routes/users.js';
import { createProgressRoutes } from './routes/progress.js';
import { createAiRoutes } from './routes/ai.js';
import { createMediaRoutes } from './routes/media.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendHtml = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');

const SECRET = config.jwtSecret;
const PORT = config.port;
const PRIVACY_POLICY_VERSION = '2026-07-20';
const logUserId = (username) => username
  ? crypto.createHmac('sha256', SECRET).update(String(username)).digest('hex').slice(0, 20)
  : null;

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
app.use(compression());
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
    const durationMs = Date.now() - startedAt;
    recordHttpRequest({ route: requestPath, status: res.statusCode, durationMs });
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
      type: 'http_request',
      requestId: req.requestId,
      method: req.method,
      path: requestPath,
      status: res.statusCode,
      durationMs,
      authenticated: Boolean(req.user),
      userId: logUserId(req.user),
    }));
  });
  next();
});
app.use('/api', protectCookieRequests(config.appUrl));
app.use('/api', createAnonymousIpLimiter(config.security.anonymousRequestsPer15Minutes));
/* Runs after the request log, so an unversioned caller stays visible in the logs
   and metrics under the path it actually used (section 13.1). */
app.use(createApiVersionRewrite({ enabled: config.api.acceptLegacyPaths }));

app.get('/health/live', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/health/ready', async (req, res) => {
  try {
    await healthCheck();
    recordDependencyEvent('database', 'success');
    res.json({ status: 'ready', storage: config.database.provider });
  } catch (error) {
    recordDependencyEvent('database', 'error');
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
      await promoteConfiguredAdmin(username, confirmed.telegram_id);
      setAuthCookie(req, res, await issueToken(username));
      return res.redirect('/');
    }

    return next();
  } catch (error) { next(error); }
});
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (path.basename(filePath) === 'index.html') res.setHeader('Cache-Control', 'no-store');
  },
}));

const authentication = createAuthentication({
  secret: SECRET,
  sessionDays: config.sessionDays,
  monitoringToken: config.monitoring.token,
  createSession,
  getUser,
  isSessionActive,
});
const { issueToken, setAuthCookie } = authentication;
// The routers receive the database as one object so each module lists only what it uses.
const dbApi = {
  createTelegramAuthCode, consumeTelegramAuthCode, getUserByTelegram, createTelegramUser, getSub,
  revokeSession, exportUserData, deleteUserData, getPrivacyConsent, setPrivacyConsent,
  getProgress, saveProgress, mergeProgress, recordModuleAttempt, upsertWordProgress, upsertErrorBank,
  createWritingAttempt, finishWritingAttempt, createSpeakingAttempt, finishSpeakingAttempt,
  getGeneratedTask, getSharedGeneratedTask, saveGeneratedTask, logAiRequest,
};
async function promoteConfiguredAdmin(username, telegramId) {
  if (ADMIN_ID && String(telegramId) === String(ADMIN_ID)) await setUserRole(username, 'admin');
}

async function buildMonitoringSnapshot() {
  const [aiUsage, system] = await Promise.all([getAiUsageMetrics(24), collectSystemMetrics(__dirname)]);
  return { ...metricsSnapshot(), aiUsage, system };
}

// ---- Telegram bot ----
const subscriptions = createSubscriptionService({
  adminId: ADMIN_ID,
  newRequestId: () => crypto.randomUUID(),
  activateTrial,
  createPaymentRequest,
  resolvePaymentRequest,
  getUserByTelegram,
});
const telegram = createTelegramService({
  token: TG_TOKEN,
  adminId: ADMIN_ID,
  appUrl: APP_URL,
  subscriptions,
  parseUpdate: parseTelegramUpdate,
  recordDependencyEvent,
  confirmTelegramAuthCode,
  getUserByTelegram,
  createTelegramUser,
});
const startTelegram = async () => { await telegram.start(); BOT_USERNAME = telegram.username(); };

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

app.use(createUserRoutes({
  secret: SECRET,
  telegramEnabled: () => Boolean(TG_TOKEN),
  botUsername: () => BOT_USERNAME,
  authCodeTtlMs: config.telegram.authCodeTtlMs,
  privacyPolicyVersion: PRIVACY_POLICY_VERSION,
  limiters: { telegramStart: telegramStartLimiter, telegramCheck: telegramCheckLimiter },
  authentication,
  buildMonitoringSnapshot,
  promoteConfiguredAdmin,
  db: dbApi,
}));
app.use(createProgressRoutes({ authentication, db: dbApi }));

const {
  createOperationLimiter, ttsLimiter, sttLimiter, hasAiBudget,
  requireAiBudget, requireActiveSubscription, requirePrivacyConsent,
} = createAccessControl({
  ai: config.ai,
  privacyPolicyVersion: PRIVACY_POLICY_VERSION,
  countAiRequestsSince,
  getSub,
  getPrivacyConsent,
});


const access = {
  createOperationLimiter, ttsLimiter, sttLimiter, hasAiBudget,
  requireAiBudget, requireActiveSubscription, requirePrivacyConsent,
};
app.use(createAiRoutes({ authentication, access, db: dbApi }));
app.use(createMediaRoutes({ authentication, access }));

/* An unknown API path is an error, not a request for the application shell.
   Without this the SPA fallback below would answer 200 and a page of HTML, and a
   client calling a misspelled or retired endpoint would never learn it was wrong. */
app.use('/api', (req, res) => {
  res.status(404).json({
    error: {
      code: 'UNKNOWN_ENDPOINT',
      message: 'Неизвестный маршрут API.',
      requestId: req.requestId,
    },
  });
});

app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((error, req, res, next) => {
  const publicError = classifyBodyParserError(error);
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: 'error',
    type: 'request_error',
    requestId: req.requestId,
    method: req.method,
    path: req.path,
    userId: logUserId(req.user),
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
