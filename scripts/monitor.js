import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateAlerts } from '../observability/alerts.js';
import { collectSystemMetrics } from '../observability/system-metrics.js';

const baseUrl = process.env.MONITORING_URL || 'http://127.0.0.1:3000';
const monitoringToken = process.env.MONITORING_TOKEN || '';
const telegramToken = process.env.TELEGRAM_BOT_TOKEN || '';
const adminId = process.env.ADMIN_TELEGRAM_ID || '';
const stateFile = process.env.MONITORING_STATE_FILE || path.resolve('monitoring-state.json');
const dryRun = process.argv.includes('--dry-run');

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  return response.json();
}

async function readState() {
  try {
    const parsed = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    return parsed && typeof parsed.active === 'object' ? parsed : { active: {} };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { active: {} };
  }
}

async function writeState(active) {
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  const temporary = `${stateFile}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify({ active, checkedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  await fs.rename(temporary, stateFile);
}

async function sendTelegram(text) {
  if (dryRun) {
    console.log(text);
    return;
  }
  if (!telegramToken || !adminId) throw new Error('TELEGRAM_MONITORING_NOT_CONFIGURED');
  const response = await fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: adminId, text }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`TELEGRAM_HTTP_${response.status}`);
}

export async function runMonitor() {
  if (process.argv.includes('--test-alert')) {
    await sendTelegram('🟢 Easy Boost: Telegram-мониторинг подключён и работает.');
    return { healthOk: true, active: [], testAlert: true };
  }
  const previous = await readState();
  let healthOk = false;
  let metrics = null;
  try {
    const health = await fetchJson(`${baseUrl}/health/ready`);
    healthOk = health.status === 'ready';
  } catch { healthOk = false; }
  if (healthOk) {
    try {
      metrics = await fetchJson(`${baseUrl}/internal/metrics`, {
        headers: { Authorization: `Bearer ${monitoringToken}` },
      });
    } catch { metrics = null; }
  }
  if (metrics) {
    metrics.system = await collectSystemMetrics(process.env.MONITORING_APP_DIR || process.cwd());
  }
  const current = evaluateAlerts({
    healthOk,
    metrics,
    thresholds: { aiDailyRequests: Number(process.env.AI_DAILY_REQUEST_BUDGET) || 1000 },
  });
  const active = healthOk ? current : { ...previous.active, ...current };
  for (const [key, message] of Object.entries(current)) {
    if (!previous.active[key]) await sendTelegram(message);
  }
  if (healthOk) {
    for (const key of Object.keys(previous.active)) {
      if (!current[key]) await sendTelegram(`🟢 Easy Boost: проблема устранена (${key}).`);
    }
  }
  await writeState(active);
  return { healthOk, active: Object.keys(active) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runMonitor()
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
