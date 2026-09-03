import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import { chromium } from 'playwright';
import { availablePort, chromeExecutable, stopProcess, waitForReady } from './browser-server-harness.js';

const projectDirectory = fileURLToPath(new URL('..', import.meta.url));
const serverPath = fileURLToPath(new URL('../server.js', import.meta.url));
const jwtSecret = 'learning-progress-e2e-secret-32-characters';

function verifiedGrammarAttempts(username) {
  const activities = [
    'grammar_forms_topic_1', 'grammar_forms_topic_2',
    'grammar_transformations_topic_18', 'grammar_transformations_topic_18',
  ];
  return activities.map((activity, index) => ({
    id: `30000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    username,
    module: 'grammar',
    activity,
    score: 4,
    max_score: 5,
    duration_ms: 60_000,
    metadata: {},
    evidence_quality: 'server_verified_unassisted',
    created_at: Date.parse(`2026-08-05T08:0${index}:00.000Z`),
  }));
}

async function authenticate(context, baseUrl, username) {
  await context.addInitScript(() => {
    try {
      if (!localStorage.getItem('aisy.onboarding.completion')) {
        localStorage.setItem('aisy.onboarding.completion', JSON.stringify({
          version: 1,
          completedAt: '2026-08-26T00:00:00.000Z',
        }));
      }
    } catch {
      // Storage can be unavailable in hardened browser profiles.
    }
  });
  await context.addCookies([{
    name: 'eb_token',
    value: jwt.sign({ u: username }, jwtSecret, { expiresIn: '1h' }),
    url: baseUrl,
    httpOnly: true,
    sameSite: 'Lax',
  }]);
}

let browser;
let child;
let temporaryDirectory;
try {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-learning-progress-'));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataFile = path.join(temporaryDirectory, 'data.json');
  const now = Date.now();
  await fs.writeFile(dataFile, JSON.stringify({
    users: {
      'progress-user': {
        created: now,
        sub_until: now + 86_400_000,
        privacy_consent: {
          text_processing: true,
          voice_processing: false,
          policy_version: '2026-08-26-vk-id-v1',
          updated_at: new Date(now).toISOString(),
        },
      },
      'established-user': {
        created: now,
        sub_until: now + 86_400_000,
        privacy_consent: {
          text_processing: true,
          voice_processing: false,
          policy_version: '2026-08-26-vk-id-v1',
          updated_at: new Date(now).toISOString(),
        },
      },
    },
    progress: { 'progress-user': {}, 'established-user': {} },
    module_attempts: verifiedGrammarAttempts('established-user'),
  }), 'utf8');

  const output = [];
  child = spawn(process.execPath, [serverPath], {
    cwd: projectDirectory,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      APP_URL: baseUrl,
      DATABASE_PROVIDER: 'file',
      DATA_FILE: dataFile,
      JWT_SECRET: jwtSecret,
      TELEGRAM_BOT_TOKEN: '',
      ADMIN_TELEGRAM_ID: '',
      XAI_ENABLED: 'false',
      VOICE_TUTOR_ENABLED: 'false',
      ADAPTIVE_LEARNING_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));
  await waitForReady(baseUrl, child, output);

  browser = await chromium.launch({ headless: true, executablePath: await chromeExecutable() });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
  });
  await authenticate(context, baseUrl, 'progress-user');
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.locator('#scr1.on').waitFor({ state: 'visible', timeout: 5_000 });

  const emptyOverview = page.waitForResponse((response) => (
    response.request().method() === 'GET'
      && response.url().endsWith('/api/v1/adaptive-learning/overview')
  ));
  await page.evaluate(() => window.tab('scr10'));
  assert.equal((await emptyOverview).status(), 200, 'summary endpoint remains available while plan rollout is hidden');
  const summary = page.locator('#evidence_progress_summary');
  await summary.locator('[data-source="online"]').waitFor({ state: 'visible', timeout: 5_000 });
  assert.equal(await summary.getAttribute('aria-live'), 'polite');
  assert.equal(await summary.locator('[role="list"] [role="listitem"]').count(), 6);
  assert.equal(await page.locator('#adaptive_plan').isHidden(), true);
  const emptyText = await summary.innerText();
  assert.match(emptyText, /Недостаточно занятий для оценки/u);
  assert.doesNotMatch(emptyText, /Освоение:\s*0%|CEFR|IELTS|\bA2\b|\bB1\b|\bB2\b/u);

  await page.evaluate(() => window.tab('scr7'));
  await page.locator('#scr7.on').waitFor({ state: 'visible', timeout: 5_000 });
  await page.getByRole('button', { name: 'Начать Task 10' }).press('Enter');
  await page.waitForFunction(() => Boolean(window.S.readingPilot?.history?.lastSelected?.task10?.id));
  const readingAnswers = await page.evaluate(async () => {
    const catalog = await window.EasyBoostReading.loadPilotCatalog();
    const selected = window.S.readingPilot.history.lastSelected.task10;
    return catalog.sets.find((set) => set.id === selected.id).task.answers;
  });
  for (let index = 0; index < readingAnswers.length; index += 1) {
    await page.locator(`[data-reading-kind="task10"] [data-reading-answer][data-position="${index}"]`)
      .selectOption(String(readingAnswers[index]));
  }
  const attemptResponse = page.waitForResponse((response) => (
    response.request().method() === 'POST' && response.url().endsWith('/api/v1/module-attempts')
  ));
  await page.locator('#r_action_dock [data-reading-action="submit-training"]').press('Enter');
  assert.equal((await attemptResponse).status(), 201);

  const updatedOverview = page.waitForResponse((response) => (
    response.request().method() === 'GET'
      && response.url().endsWith('/api/v1/adaptive-learning/overview')
  ));
  await page.evaluate(() => window.tab('scr10'));
  const overviewPayload = await (await updatedOverview).json();
  assert.equal(overviewPayload.goal, null);
  assert.equal(overviewPayload.plan, null);
  assert.equal(overviewPayload.profile.evidenceCount, 1);
  assert.equal(overviewPayload.profile.modules.find((module) => module.id === 'reading').evidenceCount, 1);
  const reading = summary.locator('[data-module="reading"]');
  await reading.locator('text=Предварительная оценка').waitFor({ state: 'visible', timeout: 5_000 });
  assert.equal(await reading.getAttribute('data-state'), 'preliminary');
  assert.match(await reading.innerText(), /Освоение:\s*\d+%.*Уверенность:\s*\d+%.*неопределённость:\s*\d+%.*Свидетельств:\s*1/su);

  const persisted = JSON.parse(await fs.readFile(dataFile, 'utf8'));
  const ordinaryAttempts = (persisted.module_attempts || []).filter((attempt) => attempt.id !== undefined
    && attempt.username === 'progress-user');
  assert.equal(ordinaryAttempts.length, 1);
  assert.equal(ordinaryAttempts[0].activity, 'reading_headings');
  assert.equal(ordinaryAttempts[0].evidence_quality, 'client_reported');
  assert.equal((persisted.module_attempts || []).some((attempt) => (
    attempt.username === 'established-user' && attempt.activity === 'reading_headings'
  )), false, 'the ordinary completion stays owner-bound');

  await page.evaluate(() => window.tab('scr7'));
  await context.setOffline(true);
  await page.evaluate(() => window.tab('scr10'));
  await summary.locator('[data-source="offline"]').waitFor({ state: 'visible', timeout: 5_000 });
  const offlineSource = summary.locator('#evidence_progress_source');
  assert.match(await offlineSource.innerText(), /Сохранённая копия.*не свежими/u);
  assert.match(await offlineSource.locator('time').getAttribute('datetime'), /^\d{4}-\d{2}-\d{2}T/u);
  assert.doesNotMatch(await offlineSource.innerText(), /Актуально по данным сервера/u);
  assert.equal(await reading.getAttribute('data-state'), 'preliminary');
  assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true);

  await context.close();
  const establishedContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
  });
  await authenticate(establishedContext, baseUrl, 'established-user');
  const establishedPage = await establishedContext.newPage();
  const establishedPageErrors = [];
  establishedPage.on('pageerror', (error) => establishedPageErrors.push(error.message));
  await establishedPage.goto(baseUrl, { waitUntil: 'networkidle' });
  await establishedPage.locator('#scr1.on').waitFor({ state: 'visible', timeout: 5_000 });
  const establishedOverview = establishedPage.waitForResponse((response) => (
    response.request().method() === 'GET'
      && response.url().endsWith('/api/v1/adaptive-learning/overview')
  ));
  await establishedPage.evaluate(() => window.tab('scr10'));
  await establishedOverview;
  const grammar = establishedPage.locator('#evidence_progress_summary [data-module="grammar"]');
  await grammar.locator('text=Оценка подтверждена').waitFor({ state: 'visible', timeout: 5_000 });
  assert.equal(await grammar.getAttribute('data-state'), 'established');
  assert.match(await grammar.innerText(), /Освоение:\s*80%.*Свидетельств:\s*4/su);
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(establishedPageErrors, []);
  await establishedContext.close();
  console.log('Evidence-backed learning progress Chromium E2E passed.');
} finally {
  if (browser) await browser.close();
  await stopProcess(child);
  if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true });
}
