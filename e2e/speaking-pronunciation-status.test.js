import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import {
  availablePort, chromeExecutable, createActiveSubscriptionPage, stopProcess, waitForReady,
} from './browser-server-harness.js';

const projectDirectory = fileURLToPath(new URL('..', import.meta.url));
const serverPath = fileURLToPath(new URL('../server.js', import.meta.url));
const jwtSecret = 'speaking-pronunciation-e2e-secret-32-characters';
const username = 'speaking-pronunciation-e2e-user';

let browser;
let child;
let temporaryDirectory;
try {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-speaking-pronunciation-e2e-'));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataFile = path.join(temporaryDirectory, 'data.json');
  await fs.writeFile(dataFile, JSON.stringify({
    users: {
      [username]: {
        created: Date.now(),
        sub_until: Date.now() + 86_400_000,
        privacy_consent: {
          text_processing: true,
          voice_processing: true,
          policy_version: '2026-08-02-voice-v1',
          updated_at: Date.now(),
        },
      },
    },
    progress: { [username]: {} },
    speaking_accent_profiles: {
      [username]: {
        username, locale: 'en-GB', revision: 1, source: 'manual',
        effective_at: '2026-08-06T00:00:00.000Z', calibration_used: false,
      },
    },
  }), 'utf8');

  const output = [];
  child = spawn(process.execPath, [serverPath], {
    cwd: projectDirectory,
    env: {
      ...process.env,
      NODE_ENV: 'test', PORT: String(port), APP_URL: baseUrl,
      DATABASE_PROVIDER: 'file', DATA_FILE: dataFile, JWT_SECRET: jwtSecret,
      TELEGRAM_BOT_TOKEN: '', ADMIN_TELEGRAM_ID: '', XAI_ENABLED: 'false',
      VOICE_TUTOR_ENABLED: 'false', ADAPTIVE_LEARNING_ENABLED: 'false',
      SPEAKING_PRONUNCIATION_ENABLED: 'false', AZURE_SPEECH_KEY: '', AZURE_SPEECH_REGION: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));
  await waitForReady(baseUrl, child, output);

  browser = await chromium.launch({ headless: true, executablePath: await chromeExecutable() });
  const { context, page } = await createActiveSubscriptionPage(browser, {
    baseUrl, username, jwtSecret,
    contextOptions: { viewport: { width: 375, height: 667 }, reducedMotion: 'reduce', serviceWorkers: 'block' },
  });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Говорение', exact: true }).press('Enter');
  const status = page.locator('#speaking_pronunciation_status');
  await status.waitFor({ state: 'visible', timeout: 5_000 });
  await status.getByText('Оценка произношения пока недоступна', { exact: true }).waitFor();
  assert.equal(await status.getAttribute('role'), 'status');
  assert.equal(await status.getAttribute('aria-live'), 'polite');
  assert.equal(await status.getAttribute('aria-atomic'), 'true');
  assert.match(await status.innerText(), /локально — это не расходует лимит/u);
  assert.deepEqual(pageErrors, []);
  await context.close();
} finally {
  if (browser) await browser.close();
  if (child) await stopProcess(child);
  if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true });
}
