import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_BASE_URL = 'https://staging.useboost.ru';
// Keep a full 15-minute run below the default 300-check server rate limit.
const POLL_INTERVAL_MS = 4_000;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

function usage() {
  return [
    'Usage: npm run test:telegram:staging',
    '',
    'Optional environment variables:',
    '  TELEGRAM_E2E_URL=https://staging.useboost.ru',
    '  TELEGRAM_E2E_TIMEOUT_MS=300000',
    '  TELEGRAM_E2E_SKIP_TRIAL=1',
    '',
    'The command never needs TELEGRAM_BOT_TOKEN. It waits for a person to',
    'press Start and, unless skipped, activate the trial in the staging bot.',
  ].join('\n');
}

export function validateStagingUrl(value) {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== 'https:') throw new Error('Telegram E2E requires HTTPS.');
  if (hostname === 'useboost.ru' || hostname === 'www.useboost.ru') {
    throw new Error('Refusing to run Telegram E2E against production.');
  }
  if (!hostname.startsWith('staging.')) {
    throw new Error('Telegram E2E URL hostname must start with "staging.".');
  }
  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url;
}

function timeoutFromEnvironment(value) {
  const timeout = Number(value || DEFAULT_TIMEOUT_MS);
  if (!Number.isInteger(timeout) || timeout < 30_000 || timeout > 15 * 60_000) {
    throw new Error('TELEGRAM_E2E_TIMEOUT_MS must be between 30000 and 900000.');
  }
  return timeout;
}

function cookieFrom(response) {
  const raw = response.headers.get('set-cookie') || '';
  return raw.split(';', 1)[0];
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body?.error?.message || body?.error || `HTTP ${response.status}`;
    throw new Error(String(message));
  }
  return { response, body };
}

async function waitUntil(label, timeoutMs, operation) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await operation();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`Timed out while waiting for ${label}.`);
}

export async function runTelegramStagingE2e(environment = process.env) {
  const baseUrl = validateStagingUrl(environment.TELEGRAM_E2E_URL || DEFAULT_BASE_URL);
  const timeoutMs = timeoutFromEnvironment(environment.TELEGRAM_E2E_TIMEOUT_MS);
  const skipTrial = environment.TELEGRAM_E2E_SKIP_TRIAL === '1';
  const origin = baseUrl.origin;

  const ready = await requestJson(new URL('/health/ready', baseUrl));
  if (ready.body?.status !== 'ready') throw new Error('Staging is not ready.');

  const started = await requestJson(new URL('/api/tg/start', baseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: '{}',
  });
  if (!started.body?.code || !started.body?.url) {
    throw new Error('Staging returned an invalid Telegram login response.');
  }

  const botUrl = new URL(started.body.url);
  if (botUrl.protocol !== 'https:' || botUrl.hostname !== 't.me') {
    throw new Error('Staging returned an unsafe Telegram bot URL.');
  }

  console.log(`Staging is ready: ${origin}`);
  console.log(`Open the staging bot and press Start:\n${botUrl.href}`);
  console.log('Waiting for Telegram confirmation...');

  const authenticated = await waitUntil('Telegram confirmation', timeoutMs, async () => {
    const checked = await requestJson(
      new URL(`/api/tg/check?code=${encodeURIComponent(started.body.code)}`, baseUrl),
    );
    if (!checked.body?.authenticated) return null;
    const cookie = cookieFrom(checked.response);
    if (!cookie) throw new Error('Authenticated response did not set a session cookie.');
    return { body: checked.body, cookie };
  });

  const replay = await requestJson(
    new URL(`/api/tg/check?code=${encodeURIComponent(started.body.code)}`, baseUrl),
  );
  if (replay.body?.authenticated || replay.body?.pending !== true) {
    throw new Error('Telegram login code could be consumed more than once.');
  }

  const me = await requestJson(new URL('/api/me', baseUrl), {
    headers: { Cookie: authenticated.cookie },
  });
  if (!me.body?.username || me.body.username !== authenticated.body.username) {
    throw new Error('Telegram session was not accepted by /api/me.');
  }

  console.log(`Login passed for staging user ${me.body.username}.`);
  console.log('One-time code replay protection passed.');

  if (skipTrial) {
    console.log('Trial check skipped by TELEGRAM_E2E_SKIP_TRIAL=1.');
    return;
  }

  if (!me.body.active) {
    console.log('In the staging bot, press “🎁 Попробовать бесплатно месяц”.');
    console.log('Waiting for trial activation...');
    await waitUntil('trial activation', timeoutMs, async () => {
      const current = await requestJson(new URL('/api/me', baseUrl), {
        headers: { Cookie: authenticated.cookie },
      });
      return current.body?.active ? current.body : null;
    });
  }

  console.log('Trial/subscription access is active.');
  console.log('Telegram staging E2E passed.');
}

const isDirectRun = process.argv[1]
  && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isDirectRun) {
  if (process.argv.includes('--help')) {
    console.log(usage());
  } else {
    runTelegramStagingE2e().catch((error) => {
      console.error(`Telegram staging E2E failed: ${error.message}`);
      process.exitCode = 1;
    });
  }
}
