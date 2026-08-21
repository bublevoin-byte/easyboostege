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

let browser;
let child;
let temporaryDirectory;
try {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-reading-listening-'));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataFile = path.join(temporaryDirectory, 'data.json');
  const jwtSecret = 'reading-listening-e2e-secret-32-characters';
  await fs.writeFile(dataFile, JSON.stringify({
    users: {
      'evidence-user': {
        created: Date.now(), sub_until: Date.now() + 86_400_000,
        privacy_consent: {
          text_processing: true, voice_processing: true,
          policy_version: '2026-08-02-voice-v1', updated_at: new Date().toISOString(),
        },
      },
    },
    progress: { 'evidence-user': {} },
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
  await context.addCookies([{
    name: 'eb_token',
    value: jwt.sign({ u: 'evidence-user' }, jwtSecret, { expiresIn: '1h' }),
    url: baseUrl,
    httpOnly: true,
    sameSite: 'Lax',
  }]);
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.locator('#scr1.on').waitFor({ state: 'visible', timeout: 5_000 });

  await page.evaluate(() => window.tab('scr7'));
  await page.locator('#scr7.on').waitFor({ state: 'visible', timeout: 5_000 });
  await page.getByRole('heading', { name: 'Каталог чтения' }).waitFor({ timeout: 8_000 });
  await page.getByRole('button', { name: 'Начать Task 10' }).press('Enter');
  await page.waitForFunction(() => Boolean(window.S.readingPilot?.history?.lastSelected?.task10?.id));
  const readingSet = await page.evaluate(async () => {
    const catalog = await window.EasyBoostReading.loadPilotCatalog();
    const selected = window.S.readingPilot.history.lastSelected.task10;
    const set = catalog.sets.find((item) => item.id === selected.id);
    return { id: set.id, revision: set.revision, cefr: set.cefr, answers: set.task.answers };
  });
  for (let index = 0; index < readingSet.answers.length; index += 1) {
    await page.locator(`[data-reading-kind="task10"] [data-reading-answer][data-position="${index}"]`)
      .selectOption(String(readingSet.answers[index]));
  }
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Завершить тренировку', exact: true }).press('Enter');
  try {
    await page.waitForFunction(() => window.EasyBoostSync.pendingModuleAttempts().length === 1,
      null, { timeout: 5_000 });
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      active: document.querySelector('.screen.on')?.id,
      queue: window.EasyBoostSync.pendingModuleAttempts(),
      area: document.querySelector('#r_area')?.textContent,
    }));
    throw new Error(`${error.message}\n${JSON.stringify(diagnostic)}\npageErrors=${JSON.stringify(pageErrors)}`);
  }
  const queued = await page.evaluate(() => window.EasyBoostSync.pendingModuleAttempts()[0]);
  assert.equal(queued.module, 'reading');
  assert.equal(queued.activity, 'reading_headings');
  assert.equal(queued.maxScore, 7);
  assert.deepEqual(Object.keys(queued.metadata).sort(), [
    'helpUsed', 'hintsUsed', 'mode', 'readingAttemptId', 'readingCefr', 'readingContentRef',
    'readingIndependent', 'readingKind', 'readingProvenance', 'readingSetId',
    'readingSetRevision', 'readingSlice', 'source',
  ]);
  assert.equal(queued.metadata.readingSetId, readingSet.id);
  assert.equal(queued.metadata.readingSetRevision, readingSet.revision);
  assert.equal(queued.metadata.readingCefr, readingSet.cefr);
  assert.equal(queued.metadata.readingContentRef, `builtin:reading:task10:${readingSet.cefr === 'B1' ? 'b1' : readingSet.cefr === 'B2' ? 'b2' : 'b2-plus-c1'}:v1`);
  assert.equal(queued.metadata.readingKind, 'task10');
  assert.equal(queued.metadata.readingSlice, 'gist');
  assert.equal(queued.metadata.readingIndependent, true);

  await context.setOffline(false);
  await page.waitForFunction(() => window.EasyBoostSync.pendingModuleAttempts().length === 0);

  await page.evaluate(() => window.tab('scr4'));
  await page.locator('#scr4.on').waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('button[onclick="lMt()"]').first().press('Enter');
  await page.locator('#lmt_row_5').waitFor({ state: 'visible', timeout: 5_000 });
  const firstMatchingId = await page.evaluate(() => window.S.listeningPilotHistory.lastSelected.matching.id);
  for (let index = 0; index < 6; index += 1) {
    await page.locator(`#lmt_row_${index} button`).nth(index).press('Enter');
  }
  const matchingResponsePromise = page.waitForResponse((response) => (
    response.request().method() === 'POST' && response.url().endsWith('/api/v1/module-attempts')
  ));
  await page.locator('button[onclick="lMtCheck()"]').press('Enter');
  assert.equal((await matchingResponsePromise).status(), 201);
  await page.locator('button[onclick="lMt()"]').first().press('Enter');
  const secondMatchingId = await page.evaluate(() => window.S.listeningPilotHistory.lastSelected.matching.id);
  assert.notEqual(secondMatchingId, firstMatchingId);
  await page.locator('button[onclick="lHub()"]').last().press('Enter');

  await page.locator('button[onclick="lTf()"]').first().press('Enter');
  await page.locator('#ltf_row_6').waitFor({ state: 'visible', timeout: 5_000 });
  const firstTrueFalseId = await page.evaluate(() => window.S.listeningPilotHistory.lastSelected.true_false.id);
  await page.getByText('Тренировочная синтезированная озвучка', { exact: true })
    .waitFor({ state: 'visible', timeout: 5_000 });
  for (let index = 0; index < 7; index += 1) {
    await page.locator(`#ltf_row_${index} button`).first().press('Enter');
  }
  const responsePromise = page.waitForResponse((response) => (
    response.request().method() === 'POST' && response.url().endsWith('/api/v1/module-attempts')
  ));
  await page.getByRole('button', { name: 'Проверить', exact: true }).press('Enter');
  assert.equal((await responsePromise).status(), 201);

  await page.locator('button[onclick="lTf()"]').first().press('Enter');
  const secondTrueFalseId = await page.evaluate(() => window.S.listeningPilotHistory.lastSelected.true_false.id);
  assert.notEqual(secondTrueFalseId, firstTrueFalseId);
  await page.locator('button[onclick="lHub()"]').last().press('Enter');
  await page.locator('button[onclick="lIq()"]').first().press('Enter');
  await page.locator('#liq_row_6').waitFor({ state: 'visible', timeout: 5_000 });
  const firstInterviewId = await page.evaluate(() => window.S.listeningPilotHistory.lastSelected.interview.id);
  assert.equal(await page.locator('[id^="liq_row_"]').count(), 7);
  assert.deepEqual(await page.locator('[id^="liq_row_"]').evaluateAll((rows) => (
    rows.map((row) => row.previousElementSibling?.textContent?.trim().split('.')[0])
  )), ['3', '4', '5', '6', '7', '8', '9']);
  for (let index = 0; index < 7; index += 1) {
    assert.equal(await page.locator(`#liq_row_${index} button`).count(), 4);
    await page.locator(`#liq_row_${index} button`).first().press('Enter');
  }
  for (let playback = 0; playback < 3; playback += 1) {
    await page.locator('#l_playbtn').press('Enter');
    await page.waitForTimeout(100);
  }
  const interviewResponsePromise = page.waitForResponse((response) => (
    response.request().method() === 'POST' && response.url().endsWith('/api/v1/module-attempts')
  ));
  await page.getByRole('button', { name: 'Проверить', exact: true }).press('Enter');
  assert.equal((await interviewResponsePromise).status(), 201);
  await page.getByText('ТРАНСКРИПТ · тапни слово для перевода').waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('button[onclick="lIq()"]').first().press('Enter');
  const secondInterviewId = await page.evaluate(() => window.S.listeningPilotHistory.lastSelected.interview.id);
  assert.notEqual(secondInterviewId, firstInterviewId);

  const history = await page.evaluate(() => window.S.listeningPilotHistory);
  assert.equal(history.version, 1);
  assert.equal(Object.keys(history.items).length, 3);
  assert.equal(Object.values(history.items).every((item) => item.transcriptExposed === true), true);
  assert.doesNotMatch(JSON.stringify(history), /correct answer|audio\/listening|Speaker [A-F]/iu);

  const adaptiveOverview = await page.evaluate(async () => {
    const response = await fetch('/api/v1/adaptive-learning/overview', {
      credentials: 'same-origin', headers: { 'X-EasyBoost-Expected-Owner': 'evidence-user' },
    });
    return { status: response.status, body: await response.json() };
  });
  assert.equal(adaptiveOverview.status, 200);
  const listeningSkills = adaptiveOverview.body.profile.skills.filter((skill) => skill.module === 'listening');
  assert.deepEqual(listeningSkills.map((skill) => skill.id).sort(), [
    'ege.listening.detail', 'ege.listening.gist',
  ]);
  assert.equal(listeningSkills.every((skill) => skill.evidenceCount > 0), true);

  const attempts = await fs.readFile(dataFile, 'utf8').then((contents) => (
    JSON.parse(contents).module_attempts || []
  ));
  const learnerAttempts = attempts.filter((attempt) => attempt.username === 'evidence-user');
  assert.deepEqual(learnerAttempts.map((attempt) => attempt.activity).sort(), [
    'listening_interview', 'listening_matching', 'listening_true_false', 'reading_headings',
  ]);
  assert.equal(learnerAttempts.every((attempt) => attempt.evidence_quality === 'client_reported'), true);
  assert.equal(learnerAttempts.find((attempt) => attempt.activity === 'listening_true_false')?.max_score, 7);
  assert.equal(learnerAttempts.find((attempt) => attempt.activity === 'listening_interview')?.max_score, 7);
  assert.equal(learnerAttempts.find((attempt) => attempt.activity === 'listening_matching')?.max_score, 6);
  assert.equal(learnerAttempts.find((attempt) => attempt.activity === 'listening_interview')?.metadata.helpUsed, true);
  assert.deepEqual(pageErrors, []);
  await context.close();
  console.log('Reading/listening evidence Chromium E2E passed.');
} finally {
  if (browser) await browser.close();
  await stopProcess(child);
  if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true });
}
