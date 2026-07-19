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

const nodeEnv = process.env.NODE_ENV || 'development';
const isProduction = nodeEnv === 'production';
const jwtSecret = process.env.JWT_SECRET || '';
const databaseProvider = process.env.DATABASE_PROVIDER || (process.env.DATABASE_URL ? 'postgres' : 'file');

if (!['file', 'postgres'].includes(databaseProvider)) {
  throw new Error('DATABASE_PROVIDER must be either file or postgres');
}

if (isProduction && jwtSecret.length < 32) {
  throw new Error('JWT_SECRET is required in production and must contain at least 32 characters');
}

if (isProduction && databaseProvider !== 'postgres') {
  throw new Error('PostgreSQL storage is required in production');
}

export const config = Object.freeze({
  nodeEnv,
  isProduction,
  port: readInteger('PORT', 3000, { min: 1, max: 65535 }),
  jwtSecret: jwtSecret || 'development-only-secret-change-before-production',
  sessionDays: readInteger('SESSION_DAYS', 30, { min: 1, max: 90 }),
  appUrl: process.env.APP_URL || 'http://localhost:3000',
  database: Object.freeze({
    provider: databaseProvider,
    url: process.env.DATABASE_URL || '',
    file: process.env.DATA_FILE || fileURLToPath(new URL('./data.json', import.meta.url)),
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
    xaiModel: process.env.XAI_MODEL || 'grok-4.5',
    groqKey: process.env.GROQ_API_KEY || '',
    groqModel: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    timeoutMs: readInteger('AI_TIMEOUT_MS', 25_000, { min: 1_000, max: 120_000 }),
    maxRequestsPerHour: readInteger('AI_REQUESTS_PER_HOUR', 60, { min: 1, max: 1000 }),
    maxWritingRequestsPerHour: readInteger('WRITING_REQUESTS_PER_HOUR', 30, { min: 1, max: 500 }),
    maxTtsRequestsPerHour: readInteger('TTS_REQUESTS_PER_HOUR', 300, { min: 1, max: 5000 }),
    maxSttRequestsPerHour: readInteger('STT_REQUESTS_PER_HOUR', 30, { min: 1, max: 500 }),
  }),
});
