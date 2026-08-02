import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

dotenv.config();

function readInteger(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function readBoolean(name, fallback = true) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new Error(`${name} must be true, false, 1 or 0`);
}

const nodeEnv = process.env.NODE_ENV || 'development';
const isProduction = nodeEnv === 'production';

function readProviderUrl(name, fallback) {
  const value = process.env[name] || fallback;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  const loopbackTestUrl = nodeEnv === 'test'
    && url.protocol === 'http:'
    && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !loopbackTestUrl) {
    throw new Error(`${name} must use HTTPS (loopback HTTP is allowed only in tests)`);
  }
  return url.toString();
}

const jwtSecret = process.env.JWT_SECRET || '';
const databaseProvider = process.env.DATABASE_PROVIDER || (process.env.DATABASE_URL ? 'postgres' : 'file');
const voiceTutorDailySeconds = readInteger('VOICE_TUTOR_DAILY_SECONDS', 600, { min: 60, max: 86_400 });
const voiceTutorMonthlySeconds = readInteger('VOICE_TUTOR_MONTHLY_SECONDS', 7_200, { min: 60, max: 2_678_400 });
const voiceTutorSessionSeconds = readInteger('VOICE_TUTOR_SESSION_SECONDS', 300, { min: 60, max: 3_600 });

if (!['file', 'postgres'].includes(databaseProvider)) {
  throw new Error('DATABASE_PROVIDER must be either file or postgres');
}

if (isProduction && jwtSecret.length < 32) {
  throw new Error('JWT_SECRET is required in production and must contain at least 32 characters');
}

if (isProduction && databaseProvider !== 'postgres') {
  throw new Error('PostgreSQL storage is required in production');
}

if (isProduction && process.env.MONITORING_TOKEN && process.env.MONITORING_TOKEN.length < 32) {
  throw new Error('MONITORING_TOKEN must contain at least 32 characters when configured');
}

if (voiceTutorSessionSeconds > voiceTutorDailySeconds || voiceTutorSessionSeconds > voiceTutorMonthlySeconds) {
  throw new Error('VOICE_TUTOR_SESSION_SECONDS must not exceed daily or monthly voice limits');
}

export const config = Object.freeze({
  nodeEnv,
  isProduction,
  port: readInteger('PORT', 3000, { min: 1, max: 65535 }),
  jwtSecret: jwtSecret || 'development-only-secret-change-before-production',
  sessionDays: readInteger('SESSION_DAYS', 30, { min: 1, max: 90 }),
  appUrl: process.env.APP_URL || 'http://localhost:3000',
  monitoring: Object.freeze({
    token: process.env.MONITORING_TOKEN || '',
  }),
  security: Object.freeze({
    // Ceiling for callers without a session, counted per address over 15 minutes.
    anonymousRequestsPer15Minutes: readInteger('ANONYMOUS_REQUESTS_PER_15_MINUTES', 300, { min: 10, max: 5000 }),
  }),
  api: Object.freeze({
    // Section 13.1: /api/v1 is the only supported contract.
    // Unversioned paths are rewritten and logged so a device running a cached
    // service worker shell survives the deploy. Turn this off once the logs stop
    // reporting api_legacy_path; keeping it forever would make the version meaningless.
    acceptLegacyPaths: readBoolean('API_ACCEPT_LEGACY_PATHS', true),
  }),
  database: Object.freeze({
    provider: databaseProvider,
    url: process.env.DATABASE_URL || '',
    file: process.env.DATA_FILE || fileURLToPath(new URL('./data.json', import.meta.url)),
  }),
  voiceTutor: Object.freeze({
    dailySeconds: voiceTutorDailySeconds,
    monthlySeconds: voiceTutorMonthlySeconds,
    sessionSeconds: voiceTutorSessionSeconds,
  }),
  telegram: Object.freeze({
    token: process.env.TELEGRAM_BOT_TOKEN || '',
    adminId: process.env.ADMIN_TELEGRAM_ID || '',
    authCodeTtlMs: readInteger('TELEGRAM_AUTH_CODE_TTL_MS', 600_000, { min: 60_000, max: 3_600_000 }),
    authStartsPer15Minutes: readInteger('TELEGRAM_AUTH_STARTS_PER_15_MINUTES', 10, { min: 1, max: 100 }),
    authChecksPer15Minutes: readInteger('TELEGRAM_AUTH_CHECKS_PER_15_MINUTES', 300, { min: 10, max: 2000 }),
  }),
  ai: Object.freeze({
    xaiKey: process.env.XAI_API_KEY || '',
    xaiEnabled: readBoolean('XAI_ENABLED'),
    xaiModel: process.env.XAI_MODEL || 'grok-4.5',
    xaiUrl: readProviderUrl('XAI_API_URL', 'https://api.x.ai/v1/chat/completions'),
    groqKey: process.env.GROQ_API_KEY || '',
    groqEnabled: readBoolean('GROQ_ENABLED'),
    groqModel: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    groqUrl: readProviderUrl('GROQ_API_URL', 'https://api.groq.com/openai/v1/chat/completions'),
    timeoutMs: readInteger('AI_TIMEOUT_MS', 25_000, { min: 1_000, max: 120_000 }),
    // How many provider calls may be in flight at once; the rest queue (section 10.8).
    maxConcurrentRequests: readInteger('AI_MAX_CONCURRENT_REQUESTS', 4, { min: 1, max: 64 }),
    // Hard ceiling over the per-operation timeouts in ai/operations.js.
    maxTimeoutMs: readInteger('AI_MAX_TIMEOUT_MS', 90_000, { min: 1_000, max: 300_000 }),
    maxRequestsPerHour: readInteger('AI_REQUESTS_PER_HOUR', 60, { min: 1, max: 1000 }),
    maxWritingRequestsPerHour: readInteger('WRITING_REQUESTS_PER_HOUR', 30, { min: 1, max: 500 }),
    maxTtsRequestsPerHour: readInteger('TTS_REQUESTS_PER_HOUR', 300, { min: 1, max: 5000 }),
    maxSttRequestsPerHour: readInteger('STT_REQUESTS_PER_HOUR', 30, { min: 1, max: 500 }),
    sttTimeoutMs: readInteger('STT_TIMEOUT_MS', 30_000, { min: 1_000, max: 120_000 }),
    sttMaxBytes: readInteger('STT_MAX_BYTES', 20 * 1024 * 1024, { min: 1024, max: 50 * 1024 * 1024 }),
    ttsTimeoutMs: readInteger('TTS_TIMEOUT_MS', 20_000, { min: 1_000, max: 120_000 }),
    ttsMaxBytes: readInteger('TTS_MAX_BYTES', 5 * 1024 * 1024, { min: 1024, max: 50 * 1024 * 1024 }),
    ttsCacheMaxAgeMs: readInteger('TTS_CACHE_MAX_AGE_MS', 7 * 86_400_000, { min: 60_000, max: 30 * 86_400_000 }),
    ttsCacheMaxBytes: readInteger('TTS_CACHE_MAX_BYTES', 256 * 1024 * 1024, { min: 1024 * 1024, max: 2 * 1024 * 1024 * 1024 }),
    dailyRequestBudget: readInteger('AI_DAILY_REQUEST_BUDGET', 1000, { min: 1, max: 1_000_000 }),
    dictionaryCacheTtlMs: readInteger('AI_DICTIONARY_CACHE_TTL_MS', 86_400_000, { min: 1_000, max: 604_800_000 }),
    xaiInputMicrousdPerMillion: readInteger('XAI_INPUT_MICROUSD_PER_MILLION', 0, { min: 0, max: 1_000_000_000 }),
    xaiOutputMicrousdPerMillion: readInteger('XAI_OUTPUT_MICROUSD_PER_MILLION', 0, { min: 0, max: 1_000_000_000 }),
    groqInputMicrousdPerMillion: readInteger('GROQ_INPUT_MICROUSD_PER_MILLION', 0, { min: 0, max: 1_000_000_000 }),
    groqOutputMicrousdPerMillion: readInteger('GROQ_OUTPUT_MICROUSD_PER_MILLION', 0, { min: 0, max: 1_000_000_000 }),
  }),
});
