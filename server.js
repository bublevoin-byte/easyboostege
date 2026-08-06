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
import { claimAiOperationSlot, claimUnseenBankTask, claimVoiceTutorRuleDiscovery, failVoiceTutorRuleDiscovery, getAdaptiveDiagnostic, getAdaptiveDiagnosticCompletionReplay, getBankTask, getBankTaskByExternalId, listBankTaskContents, recordTaskDelivery, settleAiOperationSlot, upsertBankTask, activateTrial, activateVoiceTutorProxySession, closeDatabase, confirmTelegramAuthCode, consumeTelegramAuthCode, consumeVoiceTutorProxyTicket, countAiRequestsSince, createPaymentRequest, createPaymentRequestForUser, createRuleCardForVoiceTutorSession, createSession, createSpeakingAttempt, createTelegramAuthCode, createVoiceTutorReport, createWritingAttempt, deleteUserData, exportUserData, finalizeVoiceTutorProxySession, finishSpeakingAttempt, finishVoiceTutorSession, finishWritingAttempt, getAdaptiveDiagnosticStartClaim, getAdaptiveLearningEvidenceSources, getAdaptiveLearningGoal, getAdaptiveLearningProfile, getCurrentAdaptiveLearningPlan, getAdaptiveLearningPlanRevision, getAdaptiveLearningSessionCreateReplay, createAdaptiveLearningSession, getCurrentAdaptiveLearningSession, getAdaptiveLearningSessionCommercialScope, getAdaptiveLearningSessionReplacementReplay, replaceAdaptiveLearningSessionBlock, getAdaptiveLearningSessionMutationReplay, startAdaptiveLearningSessionBlock, getAdaptiveLearningSessionExecution, getAdaptiveLearningSessionAdvanceContext, advanceAdaptiveLearningSession, getAdaptiveLearningSessionFinishContext, finishAdaptiveLearningSession, getAdaptiveLearningWeekUsage, getAdaptiveLearningCommercialUsage, getAdaptiveLearningCompletedSessionReports, getAdaptiveLearningMetrics, getAiUsageMetrics, getApprovedRuleCard, getGeneratedTask, getRuleCard, getSharedGeneratedTask, getModuleAttempt, getReadingCompletedAttempts, getPaymentRequestForUser, getPrivacyConsent, getProgress, getSpeakingAttempt, getUser, getVoiceTutorAccess, getVoiceTutorRecoveryMap, getVoiceTutorRecoveryMetrics, getVoiceTutorSession, getWordProgress, getWritingAttempt, healthCheck, isSessionActive, issueVoiceTutorProxyTicket, reissueVoiceTutorFallbackNonce, listPaymentRequests, listRuleCards, listVoiceTutorReports, recordModuleAttempt, recordModuleAttemptWithAdaptiveClaim, bindAdaptiveLearningServerAttempt, reserveVoiceTutorSession, resolvePaymentRequest, reviewRuleCard, reviewVoiceTutorReport, revokeEntitlement, revokeSession, saveAdaptiveLearningGoal, saveAdaptiveLearningProfile, saveAdaptiveLearningPlan, saveGeneratedTask, saveProgress, setPrivacyConsent, setUserRole, submitVoiceTutorRepeat, upsertErrorBank, upsertWordProgress, mergeProgress, getUserByTelegram, createTelegramUser, logAiRequest, getSub, advanceVoiceTutorSession, clarifyVoiceTutorSession, setVoiceTutorSessionDelivery, switchVoiceTutorSessionDelivery, startAdaptiveDiagnostic, getCurrentAdaptiveDiagnostic, answerAdaptiveDiagnostic, completeAdaptiveDiagnostic } from './db.js';
import { assignSpeakingTask1Session, completeSpeakingTask1Session, getSpeakingTask1Session } from './db.js';
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
import { createReadingRoutes } from './routes/reading.js';
import { createSpeakingRoutes } from './routes/speaking.js';
import { createAdaptiveLearningRoutes } from './routes/adaptive-learning.js';
import { createAiRoutes } from './routes/ai.js';
import { createMediaRoutes } from './routes/media.js';
import { createTaskRoutes, seedBuiltinTasks } from './routes/tasks.js';
import { createVoiceTutorRoutes, rebuildSourceCapsule } from './routes/voice-tutor.js';
import { createAiTextTutor } from './voice-tutor/text-fallback.js';
import { createVoiceTutorRealtimeProxy } from './voice-tutor/realtime-proxy.js';
import { createProviderClient } from './ai/provider-client.js';
import { createTrustedRuleDiscovery } from './voice-tutor/trusted-rule-discovery.js';
import { createTrustedRuleFetcher } from './voice-tutor/trusted-rule-fetch.js';
import { createConfiguredRuleSearchProvider } from './voice-tutor/trusted-rule-catalog.js';
import { canUseXaiRuleSearch, createXaiRuleSearchProvider } from './voice-tutor/rule-search.js';
import { createAiRuleEvidenceExtractor } from './voice-tutor/rule-evidence-extractor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/* Собранный frontend предпочтительнее исходников, но не обязателен: на чистом клоне и в разработке
   dist/public нет, и приложение должно запускаться из public/ ровно как раньше.
   Каталог выбирается один раз и используется везде — статика, SPA-fallback и подсчёт хешей
   инлайновых скриптов для CSP. Считать политику по одной разметке, а отдавать другую нельзя:
   политика и разметка разъедутся, и приложение перестанет запускаться в production. */
const buildDirectory = path.join(__dirname, 'dist', 'public');
const frontendDirectory = fs.existsSync(path.join(buildDirectory, 'index.html'))
  ? buildDirectory
  : path.join(__dirname, 'public');
const frontendIndex = path.join(frontendDirectory, 'index.html');
const frontendHtml = fs.readFileSync(frontendIndex, 'utf8');

const SECRET = config.jwtSecret;
const PORT = config.port;
const PRIVACY_POLICY_VERSION = '2026-08-02-voice-v1';
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
  contentSecurityPolicy: contentSecurityPolicy(
    frontendHtml,
    config.isProduction,
    '',
  ),
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
app.use(express.static(frontendDirectory, {
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
  getUser,
  createTelegramAuthCode, consumeTelegramAuthCode, getUserByTelegram, createTelegramUser, getSub,
  createPaymentRequestForUser, getPaymentRequestForUser, listPaymentRequests, resolvePaymentRequest, revokeEntitlement,
  getVoiceTutorAccess, reserveVoiceTutorSession, finishVoiceTutorSession, getVoiceTutorSession,
  issueVoiceTutorProxyTicket, reissueVoiceTutorFallbackNonce, consumeVoiceTutorProxyTicket, activateVoiceTutorProxySession, finalizeVoiceTutorProxySession,
  advanceVoiceTutorSession, clarifyVoiceTutorSession, setVoiceTutorSessionDelivery, switchVoiceTutorSessionDelivery,
  submitVoiceTutorRepeat, getVoiceTutorRecoveryMap, getVoiceTutorRecoveryMetrics,
  claimVoiceTutorRuleDiscovery, failVoiceTutorRuleDiscovery,
  createRuleCardForVoiceTutorSession, getRuleCard, listRuleCards, reviewRuleCard, getApprovedRuleCard,
  createVoiceTutorReport, listVoiceTutorReports, reviewVoiceTutorReport,
  revokeSession, exportUserData, deleteUserData, getPrivacyConsent, setPrivacyConsent,
  getProgress, saveProgress, mergeProgress, recordModuleAttempt, recordModuleAttemptWithAdaptiveClaim, bindAdaptiveLearningServerAttempt, getModuleAttempt, getReadingCompletedAttempts, upsertWordProgress, getWordProgress, upsertErrorBank,
  saveAdaptiveLearningGoal, getAdaptiveLearningGoal, getAdaptiveLearningEvidenceSources,
  saveAdaptiveLearningProfile, getAdaptiveLearningProfile,
  saveAdaptiveLearningPlan, getCurrentAdaptiveLearningPlan,
  getAdaptiveLearningPlanRevision,
  getAdaptiveLearningSessionCreateReplay, createAdaptiveLearningSession,
  getCurrentAdaptiveLearningSession, getAdaptiveLearningSessionCommercialScope,
  getAdaptiveLearningSessionReplacementReplay,
  replaceAdaptiveLearningSessionBlock, getAdaptiveLearningSessionMutationReplay,
  startAdaptiveLearningSessionBlock, getAdaptiveLearningSessionExecution,
  getAdaptiveLearningSessionAdvanceContext, advanceAdaptiveLearningSession,
  getAdaptiveLearningSessionFinishContext, finishAdaptiveLearningSession,
  getAdaptiveLearningWeekUsage, getAdaptiveLearningCommercialUsage,
  getAdaptiveLearningCompletedSessionReports, getAdaptiveLearningMetrics,
  startAdaptiveDiagnostic, getAdaptiveDiagnosticStartClaim, getCurrentAdaptiveDiagnostic, getAdaptiveDiagnostic,
  getAdaptiveDiagnosticCompletionReplay,
  answerAdaptiveDiagnostic,
  completeAdaptiveDiagnostic,
  createWritingAttempt, finishWritingAttempt, getWritingAttempt, createSpeakingAttempt, finishSpeakingAttempt, getSpeakingAttempt,
  assignSpeakingTask1Session, completeSpeakingTask1Session, getSpeakingTask1Session,
  getGeneratedTask, getSharedGeneratedTask, saveGeneratedTask, logAiRequest, claimAiOperationSlot, settleAiOperationSlot,
  upsertBankTask, getBankTask, getBankTaskByExternalId, claimUnseenBankTask, recordTaskDelivery, listBankTaskContents,
};
async function promoteConfiguredAdmin(username, telegramId) {
  if (ADMIN_ID && String(telegramId) === String(ADMIN_ID)) await setUserRole(username, 'admin');
}

async function buildMonitoringSnapshot() {
  const [aiUsage, voiceTutorRecovery, adaptiveLearning, system] = await Promise.all([
    getAiUsageMetrics(24), getVoiceTutorRecoveryMetrics(new Date(), {
      costMicrousdPerMinute: config.voiceTutor.costMicrousdPerMinute,
    }), getAdaptiveLearningMetrics(), collectSystemMetrics(__dirname),
  ]);
  return { ...metricsSnapshot(), aiUsage, voiceTutorRecovery, adaptiveLearning, system };
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
  voiceTutorLimits: config.voiceTutor,
  featureFlags: { adaptiveLearning: config.adaptiveLearning.enabled },
}));
app.use(createProgressRoutes({ authentication, db: dbApi }));
app.use(createReadingRoutes({
  authentication, db: dbApi, voiceTutorLimits: config.voiceTutor,
}));
app.use(createAdaptiveLearningRoutes({
  authentication, db: dbApi, enabled: config.adaptiveLearning.enabled,
  executionTokenSecret: SECRET,
  voiceTutorLimits: config.voiceTutor,
}));
const realtimePolicy = () => ({
  enabled: config.voiceTutor.enabled,
  costKillSwitch: config.voiceTutor.costKillSwitch,
  requireZdr: config.voiceTutor.requireZdr,
  zdrAttested: config.voiceTutor.zdrAttested,
});
const voiceTutorProxyConfigured = Boolean(
  config.ai.xaiEnabled && config.ai.xaiKey && config.voiceTutor.model && config.voiceTutor.voice,
);
const {
  createUserRateLimiter, createOperationLimiter, ttsLimiter, sttLimiter, hasAiBudget,
  requireAiBudget, requireActiveSubscription, requirePrivacyConsent,
} = createAccessControl({
  ai: config.ai,
  privacyPolicyVersion: PRIVACY_POLICY_VERSION,
  countAiRequestsSince,
  getSub,
  getPrivacyConsent,
});
const voiceTutorSessionStartLimiter = createUserRateLimiter(config.voiceTutor.sessionStartsPerHour);


const access = {
  createOperationLimiter, ttsLimiter, sttLimiter, hasAiBudget,
  requireAiBudget, requireActiveSubscription, requirePrivacyConsent,
};
app.use(createSpeakingRoutes({ authentication, access, db: dbApi }));
const claimVoiceTutorAiOperation = ({ username, ...slot }) => claimAiOperationSlot(username, {
  ...slot, dailyLimit: config.ai.dailyRequestBudget,
});
const voiceTutorTextTutor = createAiTextTutor({
  providerClient: createProviderClient(),
  claimAiOperation: claimVoiceTutorAiOperation,
  settleAiOperation: settleAiOperationSlot,
});
const externalRuleSearchEnabled = canUseXaiRuleSearch({
  enabled: config.voiceTutor.ruleSearchEnabled, xaiEnabled: config.ai.xaiEnabled, apiKey: config.ai.xaiKey,
});
const ruleSearchProvider = externalRuleSearchEnabled
  ? createXaiRuleSearchProvider({
    apiKey: config.ai.xaiKey,
    endpoint: config.voiceTutor.ruleSearchEndpoint,
    model: config.voiceTutor.ruleSearchModel,
    allowlist: config.voiceTutor.trustedRuleAllowlist,
    timeoutMs: config.voiceTutor.ruleSearchTimeoutMs,
    claimAiOperation: claimVoiceTutorAiOperation,
    settleAiOperation: settleAiOperationSlot,
  })
  : config.voiceTutor.trustedRuleSources && Object.keys(config.voiceTutor.trustedRuleSources).length
    ? createConfiguredRuleSearchProvider(config.voiceTutor.trustedRuleSources)
    : null;
const trustedRuleDiscovery = Array.isArray(config.voiceTutor.trustedRuleAllowlist)
  && config.voiceTutor.trustedRuleAllowlist.length >= 2
  && ruleSearchProvider
  ? createTrustedRuleDiscovery({
    allowlist: config.voiceTutor.trustedRuleAllowlist,
    searchProvider: ruleSearchProvider,
    fetchDocument: createTrustedRuleFetcher({ allowlist: config.voiceTutor.trustedRuleAllowlist }),
    evidenceExtractor: createAiRuleEvidenceExtractor({
      providerClient: createProviderClient(),
      claimAiOperation: claimVoiceTutorAiOperation,
      settleAiOperation: settleAiOperationSlot,
    }),
    createRuleCard: (card) => createRuleCardForVoiceTutorSession(
      card.createdForUsername, card.sessionId, card.capsuleId, card, card.discovery,
    ),
  })
  : null;
app.use(createVoiceTutorRoutes({
  authentication,
  db: dbApi,
  limits: config.voiceTutor,
  realtimeProxy: voiceTutorProxyConfigured ? {
    proxyPath: '/api/v1/voice-tutor/realtime',
    ticketTtlSeconds: config.voiceTutor.proxyTicketTtlSeconds,
    waitForSettlement: (...args) => voiceTutorRealtimeProxy.waitForSettlement(...args),
    claimPedagogyCall: (...args) => voiceTutorRealtimeProxy.claimPedagogyCall(...args),
    completePedagogyCall: (...args) => voiceTutorRealtimeProxy.completePedagogyCall(...args),
    failPedagogyCall: (...args) => voiceTutorRealtimeProxy.failPedagogyCall(...args),
  } : null,
  textTutor: voiceTutorTextTutor,
  trustedRuleDiscovery,
  privacyPolicyVersion: PRIVACY_POLICY_VERSION,
  realtimePolicy,
  sessionStartLimiter: voiceTutorSessionStartLimiter,
}));
const aiRoutes = createAiRoutes({ authentication, access, db: dbApi });
app.use(aiRoutes.router);
app.use(createTaskRoutes({
  authentication,
  access,
  db: dbApi,
  /* Section 10.1: the bank pays for a task only when this student has seen everything it holds. */
  generateBankTask: ({ username, operation, exclude }) =>
    aiRoutes.runContentGeneration({ username, input: { operation, exclude } }),
}));
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
  res.sendFile(frontendIndex);
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

const server = app.listen(PORT, () => console.log(
  'Easy Boost server on http://localhost:' + PORT
  + ' (frontend: ' + (frontendDirectory === buildDirectory ? 'dist/public' : 'public') + ')',
));
const voiceTutorRealtimeProxy = createVoiceTutorRealtimeProxy({
  authentication,
  db: dbApi,
  providerEndpoint: config.voiceTutor.realtimeUrl,
  apiKey: voiceTutorProxyConfigured ? config.ai.xaiKey : '',
  model: config.voiceTutor.model,
  voice: config.voiceTutor.voice,
  policy: realtimePolicy,
  authorize: async (username) => {
    const [consent, accessResult] = await Promise.all([
      getPrivacyConsent(username),
      getVoiceTutorAccess(username, config.voiceTutor, new Date()),
    ]);
    return Boolean(consent?.voice_processing)
      && consent.policy_version === PRIVACY_POLICY_VERSION
      && Boolean(accessResult?.entitlements?.voice_tutor);
  },
  resolveCapsule: (username, capsule) => rebuildSourceCapsule(dbApi, username, capsule, new Date()),
  providerHandshakeTimeoutMs: config.voiceTutor.providerHandshakeTimeoutMs,
  allowInsecureProvider: config.nodeEnv === 'test',
  trustedProxyHops: config.isProduction ? 1 : 0,
});
const detachVoiceTutorRealtimeProxy = voiceTutorRealtimeProxy.attach(server);
startTelegram();

/* Section 10.1: built-in tasks need rows in the bank, otherwise they have no identifier a client
   could send. Seeding is keyed on content, so a restart adds nothing. A failure here must not take
   the process down — the built-in tasks still work offline in the browser. */
seedBuiltinTasks(dbApi).catch((error) => {
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: 'error',
    type: 'task_bank_seed_failed',
    errorCode: error.code || 'SEED_FAILED',
  }));
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(signal + ': shutting down');
  const forceExitTimer = setTimeout(() => process.exit(1), 10_000);
  forceExitTimer.unref();
  detachVoiceTutorRealtimeProxy();
  const serverClosed = new Promise((resolve) => server.close(() => resolve()));
  await Promise.allSettled([
    voiceTutorRealtimeProxy.close({ timeoutMs: 2_500 }),
    serverClosed,
  ]);
  try { await closeDatabase(); } finally {
    clearTimeout(forceExitTimer);
    process.exit(0);
  }
}

process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
process.once('SIGINT', () => { void shutdown('SIGINT'); });
