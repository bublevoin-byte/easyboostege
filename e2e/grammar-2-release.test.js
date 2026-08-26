import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { GRAMMAR_CATALOG } from '../public/grammar-catalog.js';
import {
  availablePort, chromeExecutable, createActiveSubscriptionPage, openPracticeSkill, stopProcess, waitForReady,
} from './browser-server-harness.js';

const projectDirectory = fileURLToPath(new URL('..', import.meta.url));
const serverPath = fileURLToPath(new URL('../server.js', import.meta.url));
const username = 'grammar-2-release-user';
const jwtSecret = 'grammar-2-release-e2e-secret-32-characters';

let browser;
let child;
let context;
let temporaryDirectory;

try {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-grammar-2-release-'));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataFile = path.join(temporaryDirectory, 'data.json');
  await fs.writeFile(dataFile, JSON.stringify({
    users: {
      [username]: {
        created: Date.now(), sub_until: Date.now() + 86_400_000,
        privacy_consent: {
          text_processing: true, voice_processing: false,
          policy_version: '2026-08-26-vk-id-v1', updated_at: Date.now(),
        },
      },
    },
    progress: { [username]: {} },
  }), 'utf8');
  const output = [];
  child = spawn(process.execPath, [serverPath], {
    cwd: projectDirectory,
    env: {
      ...process.env, NODE_ENV: 'test', PORT: String(port), APP_URL: baseUrl,
      DATABASE_PROVIDER: 'file', DATA_FILE: dataFile, JWT_SECRET: jwtSecret,
      TELEGRAM_BOT_TOKEN: '', ADMIN_TELEGRAM_ID: '', XAI_ENABLED: 'false',
      VOICE_TUTOR_ENABLED: 'false', ADAPTIVE_LEARNING_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));
  await waitForReady(baseUrl, child, output);

  browser = await chromium.launch({ headless: true, executablePath: await chromeExecutable() });
  const harness = await createActiveSubscriptionPage(browser, {
    baseUrl, username, jwtSecret,
    contextOptions: {
      viewport: { width: 375, height: 812 }, reducedMotion: 'reduce', serviceWorkers: 'block',
    },
  });
  context = harness.context;
  const page = harness.page;
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.locator('#scr1.on').waitFor({ state: 'visible', timeout: 5_000 });
  await openPracticeSkill(page, 'grammar');
  await page.locator('#scr3.on').waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('[data-grammar-dashboard]').waitFor();
  assert.match(await page.locator('[data-grammar-dashboard]').innerText(), /Grammar 2\.0 · 20 тем/u);
  assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true);

  for (const width of [375, 1440]) {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true,
      `Grammar dashboard overflowed at ${width}px`);
  }
  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByRole('button', { name: /Экзамен · задания 19–24/u }).press('Enter');
  await page.getByRole('button', { name: 'Начать', exact: true }).press('Enter');
  await page.locator('#g_ex_0').waitFor();
  await page.locator('#g_ex_0').fill('definitely wrong');
  for (let index = 1; index < 6; index += 1) {
    await page.locator(`#g_ex_${index}`).fill(GRAMMAR_CATALOG.exams[0].gaps[index].ans[0]);
  }
  assert.equal(await page.evaluate(() => window.S.grammarRunner.schema), 'grammar-exam-runner-v1');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true,
    'mobile exam runner has no horizontal overflow');
  assert.deepEqual(await page.locator('#g_area input, #g_area button').evaluateAll((controls) => controls
    .map((control) => ({ label: control.getAttribute('aria-label') || control.textContent?.trim(), height: control.getBoundingClientRect().height }))
    .filter((control) => control.height < 44)), [], 'exam controls keep a 44px keyboard/touch target');
  await page.locator('#g_ex_0').press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'g_ex_1',
    'native exam inputs preserve keyboard order');
  await page.getByRole('button', { name: 'Проверить', exact: true }).press('Enter');
  await page.getByText('5 из 6', { exact: true }).waitFor({ timeout: 8_000 });
  assert.match(await page.locator('#g_area').innerText(), /слабые темы отмечены к повторению/u);
  assert.equal(await page.evaluate(() => window.S.grammarRunner), null);

  const canonical = await context.request.get(`${baseUrl}/api/v1/progress`, {
    headers: { 'X-EasyBoost-Expected-Owner': username },
  });
  assert.equal(canonical.ok(), true);
  const progress = await canonical.json();
  const firstGap = GRAMMAR_CATALOG.exams[0].gaps[0];
  assert.equal(progress.grammarMastery[String(firstGap.t)].stats.errors, 1);
  assert.equal(progress.grammarMastery[String(firstGap.t)].masteryHistory.at(-1).session.items
    .some((item) => item.topicId === firstGap.t && item.errorCode === 'word_or_verb_form'), true);
  assert.equal(progress.grammarMastery[String(GRAMMAR_CATALOG.exams[0].gaps[1].t)].stage, 'not_started',
    'correct exam work is history, not mastery credit');

  await page.getByRole('button', { name: 'К темам', exact: true }).press('Enter');
  assert.match(await page.locator('[data-grammar-dashboard]').innerText(), /форма слова или глагола/u,
    'the dashboard surfaces the exact exam weakness even before a late-stage regression');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: /Экзамен · задания 19–24/u }).press('Enter');
  await page.getByRole('button', { name: 'Начать', exact: true }).press('Enter');
  await page.locator('#g_ex_0').fill('offline draft one');
  await page.locator('#g_ex_1').fill('offline draft two');
  const resumeIdentity = await page.evaluate(() => ({
    sessionId: window.S.grammarRunner.sessionId,
    answers: window.S.grammarRunner.answers.slice(0, 2),
  }));
  await context.setOffline(true);
  await page.evaluate(() => window.tab('scr1'));
  await openPracticeSkill(page, 'grammar');
  await page.locator('#g_ex_0').waitFor();
  assert.equal(await page.locator('#g_ex_0').inputValue(), 'offline draft one');
  assert.equal(await page.locator('#g_ex_1').inputValue(), 'offline draft two');
  assert.deepEqual(await page.evaluate(() => ({
    sessionId: window.S.grammarRunner.sessionId,
    answers: window.S.grammarRunner.answers.slice(0, 2),
  })), resumeIdentity, 'offline navigation restores the exact device-local session');
  await page.locator('#g_ex_0').fill('editable offline draft');
  assert.equal(await page.evaluate(() => window.S.grammarRunner.answers[0]), 'editable offline draft',
    'the restored in-memory exam remains editable after route hooks finish');
  await context.setOffline(false);
  await page.reload({ waitUntil: 'networkidle' });
  await openPracticeSkill(page, 'grammar');
  await page.locator('#g_ex_0').waitFor();
  assert.equal(await page.locator('#g_ex_0').inputValue(), 'editable offline draft');
  assert.equal(await page.evaluate(() => window.S.grammarRunner.sessionId), resumeIdentity.sessionId,
    'reload resumes the same exam identity');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true,
    'the complete desktop exam runner has no horizontal overflow');
  assert.deepEqual(await page.locator('#g_area input, #g_area button').evaluateAll((controls) => controls
    .map((control) => control.getBoundingClientRect().height).filter((height) => height < 44)), [],
  'desktop exam controls keep a 44px keyboard/touch target');

  const offlineForm = GRAMMAR_CATALOG.exams[1];
  for (let index = 0; index < 6; index += 1) {
    await page.locator(`#g_ex_${index}`).fill(offlineForm.gaps[index].ans[0]);
  }
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Проверить', exact: true }).press('Enter');
  await page.getByText('6 из 6', { exact: true }).waitFor({ timeout: 8_000 });
  const queued = await page.evaluate(() => window.EasyBoostSync.pendingGrammarMasteryEvents());
  assert.equal(queued.some((entry) => entry.event.id === resumeIdentity.sessionId), true,
    'offline completion first reaches the owner-scoped durable queue with the same UUID');
  assert.equal(await page.evaluate(() => window.S.grammarRunner), null,
    'a durably queued completion clears only the device-local runner');

  await context.setOffline(false);
  await page.evaluate(() => window.EasyBoostSync.flush());
  await page.waitForFunction((sessionId) => !window.EasyBoostSync.pendingGrammarMasteryEvents()
    .some((entry) => entry.event.id === sessionId), resumeIdentity.sessionId, { timeout: 8_000 });
  const synchronized = await context.request.get(`${baseUrl}/api/v1/progress`, {
    headers: { 'X-EasyBoost-Expected-Owner': username },
  });
  assert.equal(synchronized.ok(), true);
  const synchronizedProgress = await synchronized.json();
  for (const topicId of new Set(offlineForm.gaps.map((gap) => gap.t))) {
    assert.equal(synchronizedProgress.grammarMastery[String(topicId)].masteryHistory
      .filter((entry) => entry.eventId === resumeIdentity.sessionId).length, 1,
    `reconnect writes the offline exam evidence once for topic ${topicId}`);
  }
  assert.deepEqual(pageErrors, []);
  console.log('Grammar 2.0 release E2E passed at 375px/desktop with keyboard, reduced motion, offline resume and queued reconnect');
} finally {
  if (context) await context.close();
  if (browser) await browser.close();
  if (child) await stopProcess(child);
  if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true });
}
