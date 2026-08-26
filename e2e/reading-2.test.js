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
const username = 'reading-2-user';
const premiumUsername = 'reading_2_premium_user';
const adminUsername = 'reading-2-admin-user';
const unknownAccessUsername = 'reading-2-unknown-access';
const inactiveAccessUsername = 'reading-2-inactive-access';

async function openReading(page) {
  await page.goto(page.url() || '/', { waitUntil: 'networkidle' });
  await page.locator('#scr1.on').waitFor({ state: 'visible', timeout: 8_000 });
  await page.evaluate(() => window.tab('scr7'));
  await page.locator('#scr7.on').waitFor({ state: 'visible', timeout: 8_000 });
  try {
    await page.getByRole('heading', { name: 'Каталог чтения' }).waitFor({ state: 'visible', timeout: 8_000 });
  } catch (error) {
    throw new Error(`Reading hub did not open: ${await page.locator('body').innerText()}\n${error.message}`);
  }
}

async function selectedSet(page, kind) {
  return page.evaluate(async (selectedKind) => {
    const catalog = await window.EasyBoostReading.loadPilotCatalog();
    const id = window.S.readingPilot.history.lastSelected[selectedKind].id;
    return catalog.sets.find((set) => set.id === id);
  }, kind);
}

async function fillCurrentKindCorrectly(page, kind) {
  const set = await selectedSet(page, kind);
  const answers = kind === 'task12_18'
    ? set.task.questions.map((question) => question.answer)
    : set.task.answers;
  const fields = page.locator(`[data-reading-kind="${kind}"] [data-reading-answer]`);
  assert.equal(await fields.count(), kind === 'task12_18' ? answers.length * 4 : answers.length);
  for (let index = 0; index < answers.length; index += 1) {
    if (kind === 'task12_18') {
      const choice = page.locator(`[data-reading-kind="${kind}"] [data-reading-answer][data-position="${index}"][value="${answers[index]}"]`);
      await choice.focus();
      await choice.press('Space');
    } else {
      await fields.nth(index).selectOption(String(answers[index]));
    }
  }
}

async function launchAdaptiveReading(page, kind, cefr) {
  const cefrSlug = cefr === 'B1' ? 'b1' : (cefr === 'B2' ? 'b2' : 'b2-plus-c1');
  const contentRef = `builtin:reading:${kind}:${cefrSlug}:v1`;
  const launched = await page.evaluate(({ launchKind, launchCefr, launchContentRef }) => {
    return window.launchReadingPractice(launchKind, launchCefr, launchContentRef);
  }, { launchKind: kind, launchCefr: cefr, launchContentRef: contentRef });
  assert.equal(launched, true);
  const set = await selectedSet(page, kind);
  assert.equal(set.kind, kind);
  assert.equal(set.cefr, cefr);
  await fillCurrentKindCorrectly(page, kind);
  await page.getByRole('button', { name: 'Проверить ответы' }).click();
  await page.locator('[data-reading-review-row]').first().waitFor();
  assert.equal(await page.locator('[data-reading-review-row]').count(), kind === 'task11' ? 6 : 7);
  await page.getByRole('button', { name: 'К каталогу' }).click();
  return { id: set.id, revision: set.revision, kind, cefr, contentRef };
}

async function waitForReadingAttempts(dataFile, owner, count) {
  const deadline = Date.now() + 5_000;
  let lastAttempts = [];
  while (Date.now() < deadline) {
    const data = JSON.parse(await fs.readFile(dataFile, 'utf8'));
    const attempts = (data.module_attempts || []).filter((attempt) => (
      attempt.username === owner && attempt.module === 'reading'
    ));
    lastAttempts = attempts;
    if (attempts.length >= count) return attempts;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${count} persisted Reading attempts for ${owner}: ${JSON.stringify(lastAttempts)}`);
}

let browser;
let child;
let temporaryDirectory;
try {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-reading-2-'));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const jwtSecret = 'reading-2-e2e-secret-at-least-32-characters';
  const dataFile = path.join(temporaryDirectory, 'data.json');
  await fs.writeFile(dataFile, JSON.stringify({
    users: Object.fromEntries([username, premiumUsername, adminUsername, unknownAccessUsername, inactiveAccessUsername].map((name) => [name, {
      created: Date.now(), sub_until: Date.now() + 86_400_000,
      ...(name === adminUsername ? { role: 'admin', telegram_id: 987654321 } : {}),
      privacy_consent: {
        text_processing: true, voice_processing: true,
        policy_version: '2026-08-26-vk-id-v1', updated_at: new Date().toISOString(),
      },
    }])),
    progress: { [username]: {}, [premiumUsername]: {}, [adminUsername]: {} },
    subscription_entitlements: {
      [premiumUsername]: { voice_tutor: {
        starts_at: new Date(Date.now() - 60_000).toISOString(),
        ends_at: new Date(Date.now() + 86_400_000).toISOString(),
      } },
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
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));
  await waitForReady(baseUrl, child, output);

  browser = await chromium.launch({ headless: true, executablePath: await chromeExecutable() });
  const { context, page } = await createActiveSubscriptionPage(browser, {
    baseUrl, username, jwtSecret,
    contextOptions: { viewport: { width: 375, height: 812 }, reducedMotion: 'reduce', serviceWorkers: 'block' },
  });
  const errors = [];
  const moduleAttemptResponses = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    if (response.request().method() === 'POST' && response.url().endsWith('/api/v1/module-attempts')) {
      moduleAttemptResponses.push({ status: response.status(), body: response.request().postDataJSON() });
    }
  });
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await openReading(page);

  assert.equal(await page.getByRole('button', { name: /Task 10/u }).count(), 1);
  assert.equal(await page.getByRole('button', { name: /Task 11/u }).count(), 1);
  assert.equal(await page.getByRole('button', { name: /Task 12–18/u }).count(), 1);
  assert.equal(await page.getByRole('button', { name: /Полный раздел 10–18/u }).count(), 1);
  assert.match(await page.locator('#r_area').innerText(), /60 комплект/u);
  assert.match(await page.locator('#r_area').innerText(), /Автоматически проверено/u);
  await page.getByRole('heading', { name: 'Краткий отчёт' }).waitFor({ timeout: 8_000 });
  assert.match(await page.locator('.reading-report').innerText(), /пока недостаточно данных/iu);
  assert.match(await page.locator('#r_area').innerText(), /Premium добавляет только/iu);
  const baseExpanded = await page.request.get(`${baseUrl}/api/v1/reading/report?scope=expanded`, {
    headers: { 'X-EasyBoost-Expected-Owner': username },
  });
  assert.equal(baseExpanded.status(), 403);
  assert.equal((await baseExpanded.json()).error.code, 'READING_PREMIUM_REQUIRED');

  const adaptiveReadingSets = [];
  for (const [kind, cefr] of [['task10', 'B1'], ['task11', 'B2'], ['task12_18', 'B2+/C1']]) {
    adaptiveReadingSets.push(await launchAdaptiveReading(page, kind, cefr));
  }

  await page.getByRole('button', { name: /Task 10/u }).click();
  await page.getByRole('heading', { name: 'Задание 10' }).waitFor();
  assert.equal(await page.locator('[data-reading-answer]').count(), 7);
  assert.equal(await page.locator('[data-reading-heading]').count(), 8);
  const task10 = await selectedSet(page, 'task10');
  const preSubmitText = await page.locator('#r_area').innerText();
  const preSubmitAria = await page.locator('#r_area [aria-label]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label')).join('\n'));
  assert.doesNotMatch(`${preSubmitText}\n${preSubmitAria}`, new RegExp(task10.task.evidence[0].explanationRu.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  assert.doesNotMatch(preSubmitText, /Цитата-доказательство/u);
  assert.doesNotMatch(preSubmitText, /Правильный ответ/u);
  const firstWord = page.locator('[data-reading-kind="task10"] .reading-text .clk').first();
  const exactSourceSentence = decodeURIComponent(await firstWord.getAttribute('data-context'));
  await firstWord.click();
  await page.locator('#r_pop').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: '+ Учить', exact: true }).click();
  const savedWord = await page.evaluate(() => window.S.personalWords[0]);
  assert.equal(savedWord.contexts.length, 1);
  assert.deepEqual(savedWord.contexts[0], {
    text: exactSourceSentence.trim().replace(/\s+/gu, ' '), source: 'reading',
    readingProvenance: 'canonical', readingSetId: task10.id, readingSetRevision: task10.revision,
    readingKind: 'task10', position: 'A',
  });
  await firstWord.click();
  await page.locator('#r_pop').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: '+ Учить', exact: true }).click();
  assert.equal(await page.evaluate(() => window.S.personalWords[0].contexts.length), 1);
  for (let index = 0; index < 7; index += 1) {
    await page.locator('[data-reading-answer]').nth(index).selectOption(String(index));
  }
  await page.getByRole('button', { name: 'Проверить ответы' }).click();
  await page.getByRole('heading', { name: 'Разбор задания 10' }).waitFor();
  assert.equal(await page.locator('[data-reading-review-row]').count(), 7);
  assert.equal(await page.locator('.voiceTutorTrigger').count(), 0, 'Base keeps the text review without Voice launch');
  assert.match(await page.locator('[data-reading-review-row]').first().innerText(), /Ответ ученика.*Правильный ответ.*Цитата-доказательство.*Объяснение/siu);
  const firstId = task10.id;
  await page.getByRole('button', { name: 'Следующий комплект' }).click();
  await page.waitForFunction((previousId) => window.S.readingPilot.history.lastSelected.task10.id !== previousId, firstId);
  assert.notEqual((await selectedSet(page, 'task10')).id, firstId);

  await page.getByRole('button', { name: 'К каталогу' }).click();
  await page.getByRole('button', { name: /Task 11/u }).click();
  await page.getByRole('heading', { name: 'Задание 11' }).waitFor();
  assert.equal(await page.locator('[data-reading-answer]').count(), 6);
  assert.equal(await page.locator('[data-reading-fragment]').count(), 7);
  await page.getByRole('button', { name: 'К каталогу' }).click();
  await page.getByRole('button', { name: /Task 12–18/u }).click();
  await page.getByRole('heading', { name: 'Задания 12–18' }).waitFor();
  assert.equal(await page.locator('[data-reading-question]').count(), 7);
  assert.equal(await page.locator('[data-reading-answer]').count(), 28);

  await page.getByRole('button', { name: 'К каталогу' }).click();
  await page.getByRole('button', { name: /Полный раздел 10–18/u }).click();
  assert.match(await page.locator('#r_area').innerText(), /9\s*заданий.*20\s*полей ответа/su);
  assert.doesNotMatch(await page.locator('#r_area').innerText(), /20 задани(?:й|я) ЕГЭ/iu);
  assert.match(await page.locator('#r_area').innerText(), /рекомендация ФИПИ — 30 минут/iu);
  assert.match(await page.locator('#r_area').innerText(), /не завершается автоматически/iu);
  await page.getByRole('button', { name: 'Начать полный раздел' }).click();
  await page.locator('.reading-overview').waitFor();
  assert.equal(await page.locator('.reading-overview [data-reading-overview-field]').count(), 20);
  await page.locator('[data-reading-kind="task10"] [data-reading-answer]').first().selectOption({ index: 1 });
  assert.match(await page.locator('#reading-full-timer').innerText(), /\d{2}:\d{2}/u);
  await page.waitForTimeout(1_100);
  assert.notEqual(await page.locator('#reading-full-timer').innerText(), '00:00');

  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('#scr1.on').waitFor({ state: 'visible', timeout: 8_000 });
  await page.evaluate(() => window.tab('scr7'));
  await page.getByText('Незавершённая попытка восстановлена', { exact: true }).waitFor({ timeout: 8_000 });
  assert.equal(await page.locator('.reading-overview [data-reading-overview-field]').count(), 20);
  await page.getByRole('button', { name: 'Дальше: Task 11' }).click();
  await page.getByRole('button', { name: 'Дальше: Task 12–18' }).click();
  await page.getByRole('button', { name: 'Сдать раздел' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'В ответах есть пропуски' });
  await dialog.waitFor();
  await dialog.getByRole('button', { name: 'Вернуться к ответам' }).click();
  assert.equal(await dialog.isVisible(), false);

  await page.getByRole('button', { name: 'Назад: Task 11' }).click();
  await page.getByRole('button', { name: 'Назад: Task 10' }).click();
  await fillCurrentKindCorrectly(page, 'task10');
  await page.getByRole('button', { name: 'Дальше: Task 11' }).click();
  await fillCurrentKindCorrectly(page, 'task11');
  await page.getByRole('button', { name: 'Дальше: Task 12–18' }).click();
  await fillCurrentKindCorrectly(page, 'task12_18');
  await page.getByRole('button', { name: 'Сдать раздел' }).first().click();
  await page.getByRole('heading', { name: 'Результат полного раздела' }).waitFor();
  assert.match(await page.locator('#r_area').innerText(), /12 из 12 первичных баллов/u);
  assert.match(await page.locator('#r_area').innerText(), /20 из 20 верных полей/u);
  assert.equal(await page.locator('[data-reading-review-row]').count(), 20);
  assert.equal(await page.locator('.voiceTutorTrigger').count(), 0, 'Base full section still has text-only review');
  let persistedReading;
  try {
    persistedReading = await waitForReadingAttempts(dataFile, username, 6);
  } catch (error) {
    error.message += `; responses=${JSON.stringify(moduleAttemptResponses)}`;
    throw error;
  }
  assert.equal(moduleAttemptResponses.length, 6);
  assert.equal(moduleAttemptResponses.every((response) => response.status >= 200 && response.status < 300), true);
  assert.deepEqual(moduleAttemptResponses.slice(0, 3).map((response) => ({
    setId: response.body.metadata.readingSetId,
    kind: response.body.metadata.readingKind,
    cefr: response.body.metadata.readingCefr,
    contentRef: response.body.metadata.readingContentRef,
  })), adaptiveReadingSets.map((set) => ({
    setId: set.id, kind: set.kind, cefr: set.cefr, contentRef: set.contentRef,
  })));
  const fullSlices = persistedReading.filter((attempt) => (
    String(attempt.metadata?.readingAttemptId || '').startsWith('reading-full-')
  ));
  assert.equal(fullSlices.length, 2, 'one restored full attempt persists exactly one gist and one detail slice');
  assert.equal(new Set(fullSlices.map((attempt) => attempt.metadata.readingAttemptId)).size, 1);
  assert.deepEqual(fullSlices.map((attempt) => attempt.max_score).sort((left, right) => left - right), [7, 13]);
  assert.deepEqual(fullSlices.map((attempt) => attempt.metadata.readingSlice).sort(), ['detail', 'gist']);
  const completedDuration = await page.evaluate(() => window.RE.result.durationMs);
  assert.equal(completedDuration > 0, true);
  assert.equal(fullSlices.reduce((sum, attempt) => sum + attempt.duration_ms, 0), completedDuration);
  assert.equal(fullSlices.every((attempt) => attempt.evidence_quality === 'client_reported'), true);

  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const metrics = await page.locator('#scr7').evaluate((screen) => ({
      clientWidth: screen.clientWidth, scrollWidth: screen.scrollWidth,
      controls: [...screen.querySelectorAll('button:not([hidden]),select:not([hidden])')]
        .filter((control) => control.offsetParent !== null)
        .map((control) => ({ label: control.getAttribute('aria-label') || control.textContent.trim(), width: control.getBoundingClientRect().width, height: control.getBoundingClientRect().height })),
    }));
    assert.ok(metrics.scrollWidth <= metrics.clientWidth + 1, `${width}px Reading overflowed horizontally`);
    assert.equal(metrics.controls.every((control) => control.height >= 44 && control.width >= 44), true,
      `${width}px undersized controls: ${JSON.stringify(metrics.controls.filter((control) => control.height < 44 || control.width < 44))}`);
  }
  assert.deepEqual(errors, []);
  await context.close();

  const premiumSession = await createActiveSubscriptionPage(browser, {
    baseUrl, username: premiumUsername, jwtSecret,
    contextOptions: { viewport: { width: 768, height: 900 }, serviceWorkers: 'block' },
  });
  const contextPayloads = [];
  premiumSession.page.on('request', (request) => {
    if (request.url().endsWith('/api/v1/voice-tutor/context-attempts')) {
      contextPayloads.push(request.postDataJSON());
    }
  });
  await premiumSession.page.goto(baseUrl, { waitUntil: 'networkidle' });
  await openReading(premiumSession.page);
  await premiumSession.page.getByRole('heading', { name: 'Расширенный персональный отчёт' }).waitFor({ timeout: 8_000 });
  assert.match(await premiumSession.page.locator('.reading-expanded-report').innerText(), /недостаточно данных/iu);
  await premiumSession.page.getByRole('button', { name: /Task 10/u }).click();
  await premiumSession.page.getByRole('heading', { name: 'Задание 10' }).waitFor();
  const premiumSet = await selectedSet(premiumSession.page, 'task10');
  const premiumFields = premiumSession.page.locator('[data-reading-kind="task10"] [data-reading-answer]');
  for (let index = 0; index < premiumSet.task.answers.length; index += 1) {
    await premiumFields.nth(index).selectOption(String((premiumSet.task.answers[index] + 1) % premiumSet.task.headings.length));
  }
  assert.equal(contextPayloads.length, 0, 'no Voice context is sent before submit');
  await premiumSession.page.getByRole('button', { name: 'Проверить ответы' }).click();
  await premiumSession.page.locator('.voiceTutorTrigger').first().waitFor({ timeout: 8_000 });
  assert.equal(await premiumSession.page.locator('.voiceTutorTrigger').count(), 7);
  assert.equal(contextPayloads.length, 1);
  assert.deepEqual(Object.keys(contextPayloads[0]).sort(), ['answers', 'attemptId', 'module', 'revision', 'setId']);
  assert.equal(contextPayloads[0].setId, premiumSet.id);
  assert.equal(contextPayloads[0].revision, premiumSet.revision);
  assert.equal(JSON.stringify(contextPayloads[0]).includes('evidence'), false);

  await premiumSession.page.getByRole('button', { name: 'К каталогу' }).click();
  await premiumSession.page.getByRole('heading', { name: 'Расширенный персональный отчёт' }).waitFor({ timeout: 8_000 });
  assert.match(await premiumSession.page.locator('.reading-expanded-report').innerText(), /Основное содержание.*1 наблюдени/siu);

  await premiumSession.page.route('**/api/v1/reading/report?scope=*', (route) => route.abort());
  await premiumSession.page.getByRole('button', { name: /Task 11/u }).click();
  await premiumSession.page.getByRole('button', { name: 'К каталогу' }).click();
  const reportFailure = premiumSession.page.getByText(/Не удалось обновить отчёт/u);
  await reportFailure.waitFor({ timeout: 8_000 });
  assert.match(await premiumSession.page.locator('.reading-report-shell').innerText(), /Статус Premium не изменён/iu);
  assert.doesNotMatch(await premiumSession.page.locator('.reading-report-shell').innerText(), /Основное содержание.*1 наблюдени/siu,
    'previous expanded text is not treated as a fresh entitlement result');
  await premiumSession.page.unroute('**/api/v1/reading/report?scope=*');
  await premiumSession.page.getByRole('button', { name: 'Повторить загрузку отчёта' }).click();
  await premiumSession.page.getByRole('heading', { name: 'Расширенный персональный отчёт' }).waitFor({ timeout: 8_000 });

  const adminSession = await createActiveSubscriptionPage(browser, {
    baseUrl, username: adminUsername, jwtSecret,
    contextOptions: { viewport: { width: 768, height: 900 }, serviceWorkers: 'block' },
  });
  await adminSession.page.goto(baseUrl, { waitUntil: 'networkidle' });
  const revoke = await adminSession.page.evaluate(async (targetUsername) => {
    const response = await fetch(`/api/v1/admin/users/${encodeURIComponent(targetUsername)}/entitlements/voice_tutor/revoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    return { status: response.status, body: await response.json() };
  }, premiumUsername);
  assert.equal(revoke.status, 200, JSON.stringify(revoke.body));
  await adminSession.context.close();
  await premiumSession.page.getByRole('button', { name: 'Обновить расширенный отчёт' }).click();
  await premiumSession.page.getByText(/Доступ к расширенному отчёту изменился/u).waitFor({ timeout: 8_000 });
  assert.equal(await premiumSession.page.locator('.reading-expanded-report').count(), 0);
  assert.equal(await premiumSession.page.evaluate(() => window.__sub?.entitlements?.voice_tutor), false);
  await premiumSession.page.getByRole('button', { name: /Task 10/u }).click();
  await premiumSession.page.getByRole('heading', { name: 'Задание 10' }).waitFor();
  const revokedSet = await selectedSet(premiumSession.page, 'task10');
  const revokedFields = premiumSession.page.locator('[data-reading-kind="task10"] [data-reading-answer]');
  for (let index = 0; index < revokedSet.task.answers.length; index += 1) {
    await revokedFields.nth(index).selectOption(String((revokedSet.task.answers[index] + 1) % revokedSet.task.headings.length));
  }
  await premiumSession.page.getByRole('button', { name: 'Проверить ответы' }).click();
  assert.equal(await premiumSession.page.locator('.voiceTutorTrigger').count(), 0,
    'revoked entitlement prevents a new Voice launch');
  await premiumSession.context.close();

  const unknownAccess = await createActiveSubscriptionPage(browser, {
    baseUrl, username: unknownAccessUsername, jwtSecret,
    contextOptions: { viewport: { width: 375, height: 812 }, serviceWorkers: 'block' },
  });
  await unknownAccess.page.goto(baseUrl, { waitUntil: 'networkidle' });
  await openReading(unknownAccess.page);
  await unknownAccess.page.route('**/api/v1/me', (route) => route.abort('internetdisconnected'));
  await unknownAccess.page.getByRole('button', { name: /Task 10/u }).click();
  await unknownAccess.page.getByRole('heading', { name: 'Не удалось проверить доступ' }).waitFor({ timeout: 8_000 });
  assert.equal(await unknownAccess.page.getByRole('heading', { name: 'Задание 10' }).count(), 0,
    'network-unknown cannot start a cached Reading training');
  await unknownAccess.context.close();

  const inactiveAccess = await createActiveSubscriptionPage(browser, {
    baseUrl, username: inactiveAccessUsername, jwtSecret,
    contextOptions: { viewport: { width: 768, height: 900 }, serviceWorkers: 'block' },
  });
  await inactiveAccess.page.goto(baseUrl, { waitUntil: 'networkidle' });
  await openReading(inactiveAccess.page);
  await inactiveAccess.page.getByRole('button', { name: /Полный раздел 10–18/u }).click();
  await inactiveAccess.page.route('**/api/v1/me', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ authenticated: true, username: inactiveAccessUsername, active: false, sub_until: Date.now() - 1,
      entitlements: { voice_tutor: false } }),
  }));
  await inactiveAccess.page.getByRole('button', { name: 'Начать полный раздел' }).click();
  await inactiveAccess.page.getByRole('heading', { name: 'Нужен активный доступ' }).waitFor({ timeout: 8_000 });
  assert.equal(await inactiveAccess.page.locator('.reading-overview').count(), 0,
    'confirmed inactive access cannot create a full Reading attempt');
  await inactiveAccess.context.close();

  const fallbackSession = await createActiveSubscriptionPage(browser, {
    baseUrl, username, jwtSecret,
    contextOptions: { viewport: { width: 768, height: 900 }, serviceWorkers: 'block' },
  });
  const fallbackErrors = [];
  fallbackSession.page.on('pageerror', (error) => fallbackErrors.push(error.message));
  await fallbackSession.page.route('**/content/reading/*.js', (route) => route.abort());
  await fallbackSession.page.route('**/assets/task*-v1-*.js', (route) => route.abort());
  await fallbackSession.page.goto(baseUrl, { waitUntil: 'networkidle' });
  await fallbackSession.page.locator('#scr1.on').waitFor();
  await fallbackSession.page.evaluate(() => window.tab('scr7'));
  await fallbackSession.page.getByRole('alert').waitFor({ timeout: 8_000 });
  assert.match(await fallbackSession.page.getByRole('alert').innerText(), /Каталог не загрузился/u);
  const beforeFallback = await fallbackSession.page.evaluate(() => JSON.stringify(window.S.readingPilot?.history || null));
  await fallbackSession.page.getByRole('button', { name: 'Техническая тренировка' }).click();
  await fallbackSession.page.getByRole('heading', { name: 'Задание 10' }).waitFor();
  assert.deepEqual(fallbackErrors, []);
  assert.match(await fallbackSession.page.locator('#r_area').innerText(), /не записывается в прогресс/iu);
  const fallbackAnswers = fallbackSession.page.locator('[data-reading-kind="task10"] [data-reading-answer]');
  assert.equal(await fallbackAnswers.count(), 2);
  assert.equal(await fallbackSession.page.locator('[data-reading-heading]').count(), 3);
  await fallbackAnswers.nth(0).selectOption('1');
  await fallbackAnswers.nth(1).selectOption('2');
  await fallbackSession.page.getByRole('button', { name: 'Проверить ответы' }).click();
  assert.match(await fallbackSession.page.locator('#r_area').innerText(), /Технический результат: 2 из 2/u);
  assert.match(await fallbackSession.page.locator('#r_area').innerText(), /Официальная шкала и прогресс не применяются/u);
  const afterFallback = await fallbackSession.page.evaluate(() => JSON.stringify(window.S.readingPilot?.history || null));
  assert.equal(afterFallback, beforeFallback);
  await fallbackSession.context.close();

  console.log('Reading 2 Chromium E2E passed.');
} finally {
  if (browser) await browser.close();
  await stopProcess(child);
  if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true });
}
