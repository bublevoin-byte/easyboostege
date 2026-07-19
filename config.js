import dotenv from 'dotenv';

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

if (isProduction && jwtSecret.length < 32) {
  throw new Error('JWT_SECRET is required in production and must contain at least 32 characters');
}

export const config = Object.freeze({
  nodeEnv,
  isProduction,
  port: readInteger('PORT', 3000, { min: 1, max: 65535 }),
  jwtSecret: jwtSecret || 'development-only-secret-change-before-production',
  appUrl: process.env.APP_URL || 'http://localhost:3000',
  telegram: Object.freeze({
    token: process.env.TELEGRAM_BOT_TOKEN || '',
    adminId: process.env.ADMIN_TELEGRAM_ID || '',
  }),
  ai: Object.freeze({
    xaiKey: process.env.XAI_API_KEY || '',
    xaiModel: process.env.XAI_MODEL || 'grok-4.5',
    groqKey: process.env.GROQ_API_KEY || '',
    groqModel: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    timeoutMs: readInteger('AI_TIMEOUT_MS', 25_000, { min: 1_000, max: 120_000 }),
    maxRequestsPerHour: readInteger('AI_REQUESTS_PER_HOUR', 60, { min: 1, max: 1000 }),
  }),
});

