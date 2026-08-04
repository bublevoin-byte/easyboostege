import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import { chromium } from 'playwright';

const projectDirectory = fileURLToPath(new URL('..', import.meta.url));
const serverPath = fileURLToPath(new URL('../server.js', import.meta.url));

async function findAvailablePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForReady(baseUrl, child, output) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited early.\n${output.join('')}`);
    try {
      if ((await fetch(`${baseUrl}/health/ready`)).ok) return;
    } catch {
      // Connection failures are expected while the child process starts.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Server did not become ready.\n${output.join('')}`);
}

async function stopProcess(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function chromeExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next standard browser location.
    }
  }
  throw new Error('Chrome/Chromium executable was not found. Set CHROME_PATH.');
}

async function openProgress(page) {
  await page.locator('#scr1.on').waitFor({ state: 'visible', timeout: 5_000 });
  await page.evaluate(() => window.tab('scr10'));
  await page.locator('#scr10.on').waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('#adaptive_plan:not([hidden])').waitFor({ state: 'visible', timeout: 5_000 });
}

async function replayPublicRequest(page, pathName, key, body) {
  return page.evaluate(async ({ requestPath, idempotencyKey, payload }) => {
    const response = await fetch(requestPath, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(payload),
    });
    return { status: response.status, body: await response.json() };
  }, { requestPath: pathName, idempotencyKey: key, payload: body });
}

async function runAdaptiveDiagnosticE2E() {
  let browser;
  let child;
  let context;
  let examContext;
  let writerContext;
  let providerServer;
  let temporaryDirectory;
  try {
    temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-adaptive-e2e-'));
    const port = await findAvailablePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const dataFile = path.join(temporaryDirectory, 'data.json');
    const jwtSecret = 'adaptive-e2e-secret-with-at-least-32-characters';
    const providerPort = await findAvailablePort();
    const providerCalls = [];
    providerServer = http.createServer((request, response) => {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        providerCalls.push(request.url);
        const review = {
          words: 110, in_range: true, overall_got: 4, overall_max: 6,
          verdict: 'Изолированный браузерный разбор готов', sub: 'Проверь связность абзацев',
          criteria: [
            { name: 'Решение коммуникативной задачи', got: 2, max: 2 },
            { name: 'Организация текста', got: 1, max: 2 },
            { name: 'Языковое оформление', got: 1, max: 2 },
          ],
          errors: [],
        };
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({
          choices: [{ message: { content: JSON.stringify(review) } }],
          usage: { prompt_tokens: 90, completion_tokens: 40 },
        }));
      });
    });
    await new Promise((resolve, reject) => {
      providerServer.once('error', reject);
      providerServer.listen(providerPort, '127.0.0.1', resolve);
    });
    const writerAttempts = [];
    const writerActivities = [
      ['vocabulary', 'vocabulary_lexical_choice_topic_1', 1],
      ['vocabulary', 'vocabulary_word_formation', 1],
      ['grammar', 'grammar_forms_topic_3', 1],
      ['grammar', 'grammar_transformations_topic_18', 1],
      ['reading', 'reading_headings', 1], ['reading', 'reading_detail', 1],
      ['listening', 'listening_matching', 1], ['listening', 'listening_interview', 1],
      ['writing', 'writing_37', 0], ['writing', 'writing_38', 0],
      ['speaking', 'speaking_2', 1], ['speaking', 'speaking_4', 1],
    ];
    let writerAttemptIndex = 0;
    for (const [module, activity, score] of writerActivities) for (let repeat = 0; repeat < 2; repeat += 1) {
      writerAttemptIndex += 1;
      writerAttempts.push({
        id: `30000000-0000-4000-8000-${String(writerAttemptIndex).padStart(12, '0')}`,
        username: 'adaptivewriter', module, activity, score, max_score: 1,
        evidence_quality: 'server_verified_unassisted', created_at: Date.now() - repeat * 60_000,
      });
    }
    const examAttempts = [];
    const examActivities = writerActivities.map(([module, activity]) => [
      module, activity, activity === 'grammar_forms_topic_3' ? 0 : 1,
    ]);
    let examAttemptIndex = 0;
    for (const [module, activity, score] of examActivities) for (let repeat = 0; repeat < 2; repeat += 1) {
      examAttemptIndex += 1;
      examAttempts.push({
        id: `40000000-0000-4000-8000-${String(examAttemptIndex).padStart(12, '0')}`,
        username: 'adaptiveexam', module, activity, score, max_score: 1,
        evidence_quality: 'server_verified_unassisted', created_at: Date.now() - repeat * 60_000,
      });
    }
    await fs.writeFile(dataFile, JSON.stringify({
      users: {
        adaptivee2e: {
          created: Date.now(), sub_until: Date.now() + 86_400_000,
          privacy_consent: {
            text_processing: true, voice_processing: true,
            policy_version: '2026-08-02-voice-v1', updated_at: new Date().toISOString(),
          },
        },
        adaptiveexam: {
          created: Date.now(), sub_until: Date.now() + 86_400_000,
          privacy_consent: {
            text_processing: true, voice_processing: true,
            policy_version: '2026-08-02-voice-v1', updated_at: new Date().toISOString(),
          },
        },
        adaptivewriter: {
          created: Date.now(), sub_until: Date.now() + 86_400_000,
          privacy_consent: {
            text_processing: true, voice_processing: true,
            policy_version: '2026-08-02-voice-v1', updated_at: new Date().toISOString(),
          },
        },
      },
      progress: { adaptivee2e: {}, adaptiveexam: {}, adaptivewriter: {} },
      module_attempts: [...writerAttempts, ...examAttempts],
    }));

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
        ADAPTIVE_LEARNING_ENABLED: 'true',
        XAI_ENABLED: 'true',
        XAI_API_KEY: 'adaptive-local-e2e-key',
        XAI_API_URL: `http://127.0.0.1:${providerPort}/xai`,
        GROQ_API_KEY: '',
        GROQ_ENABLED: 'false',
        VOICE_TUTOR_ENABLED: 'false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => output.push(chunk.toString()));
    child.stderr.on('data', (chunk) => output.push(chunk.toString()));
    await waitForReady(baseUrl, child, output);

    browser = await chromium.launch({ headless: true, executablePath: await chromeExecutable() });
    context = await browser.newContext({ serviceWorkers: 'block' });
    const blockedExternalUrls = [];
    await context.route('https://**', async (route) => {
      blockedExternalUrls.push(route.request().url());
      await route.abort('blockedbyclient');
    });
    await context.addCookies([{
      name: 'eb_token',
      value: jwt.sign({ u: 'adaptivee2e' }, jwtSecret, { expiresIn: '1h' }),
      url: baseUrl,
      httpOnly: true,
      sameSite: 'Lax',
    }]);
    await context.addInitScript(() => {
      window.__adaptiveSpeechCalls = [];
      class FakeSpeechSynthesisUtterance {
        constructor(text) {
          this.text = text;
          this.lang = '';
        }
      }
      Object.defineProperty(window, 'SpeechSynthesisUtterance', {
        configurable: true,
        value: FakeSpeechSynthesisUtterance,
      });
      Object.defineProperty(window, 'speechSynthesis', {
        configurable: true,
        value: {
          cancel() {},
          speak(utterance) {
            window.__adaptiveSpeechCalls.push({ text: utterance.text, lang: utterance.lang });
          },
        },
      });
    });
    const page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await openProgress(page);

    await page.locator('#adaptive_target_score').fill('85');
    await page.locator('#adaptive_exam_date').fill('2027-06-01');
    await page.locator('#adaptive_weekly_minutes').fill('300');
    const goalResponsePromise = page.waitForResponse((response) => (
      response.request().method() === 'PUT'
        && response.url().endsWith('/api/v1/adaptive-learning/goal')
    ));
    await page.locator('#adaptive_goal_form button[type="submit"]').press('Enter');
    const goalResponse = await goalResponsePromise;
    assert.equal(goalResponse.status(), 201);
    const goalResult = await goalResponse.json();
    assert.equal(goalResult.plan.revision, 1);
    await page.locator('#adaptive_forecast:not([hidden])').waitFor({ state: 'visible', timeout: 5_000 });
    assert.match(await page.locator('#adaptive_forecast_range').innerText(), /Ориентир: \d+–\d+ баллов/u);
    assert.match(await page.locator('#adaptive_forecast_confidence').innerText(), /не обещание результата/u);
    assert.equal(await page.locator('#adaptive_weekly_allocation > div').count(), 6);

    const startButton = page.locator('#adaptive_diagnostic_start');
    await startButton.waitFor({ state: 'visible', timeout: 5_000 });
    assert.match(await page.locator('#adaptive_plan').innerText(), /Точное время и предел заданий появятся после старта/u);
    await startButton.focus();
    const startResponsePromise = page.waitForResponse((response) => (
      response.request().method() === 'POST'
        && response.url().endsWith('/api/v1/adaptive-learning/diagnostics/start')
    ));
    await startButton.press('Enter');
    const startResponse = await startResponsePromise;
    assert.equal(startResponse.status(), 201);
    const started = await startResponse.json();
    const startKey = startResponse.request().headers()['idempotency-key'];
    assert.ok(startKey);
    await page.locator('#adaptive_diagnostic_form').waitFor({ state: 'visible', timeout: 5_000 });
    assert.match(await page.locator('#adaptive_diagnostic_timing').innerText(), /20 минут после старта/u);
    assert.equal(await page.locator('#adaptive_diagnostic_progress').getAttribute('max'), '12');
    assert.equal(await page.locator('#adaptive_diagnostic_progress_label').innerText(), '0 из 12');
    const diagnosticId = started.diagnostic.id;
    const initialItemId = started.item.id;

    const replayedStart = await replayPublicRequest(
      page,
      '/api/v1/adaptive-learning/diagnostics/start',
      startKey,
      {},
    );
    assert.equal(replayedStart.status, 200);
    assert.equal(replayedStart.body.diagnostic.id, diagnosticId);
    assert.equal(replayedStart.body.diagnostic.status, 'in_progress');
    assert.equal(replayedStart.body.diagnostic.answeredItems, 0);
    assert.equal(replayedStart.body.item.id, initialItemId);

    await page.reload({ waitUntil: 'networkidle' });
    await openProgress(page);
    await page.waitForFunction(({ expectedDiagnosticId, expectedItemId }) => {
      const section = document.querySelector('#adaptive_diagnostic');
      return section?.dataset.diagnosticId === expectedDiagnosticId
        && section?.dataset.itemId === expectedItemId;
    }, { expectedDiagnosticId: diagnosticId, expectedItemId: initialItemId }, { timeout: 5_000 });
    assert.equal(await page.locator('#adaptive_diagnostic_progress').getAttribute('value'), '0');
    assert.match(await page.locator('#adaptive_diagnostic').innerText(), /20 минут/u);

    let audioWasPlayed = false;
    let firstAnswerReplay;
    for (let answered = 0; answered < 10; answered += 1) {
      const section = page.locator('#adaptive_diagnostic');
      const priorItemId = await section.getAttribute('data-item-id');
      const audioButton = page.locator('#adaptive_diagnostic_audio');
      if (await audioButton.isVisible()) {
        const before = await page.evaluate(() => window.__adaptiveSpeechCalls.length);
        assert.match(await page.locator('#adaptive_diagnostic_notice').innerText(), /ориентировочная проверка аудирования/u);
        await audioButton.focus();
        await audioButton.press('Enter');
        await page.waitForFunction((count) => window.__adaptiveSpeechCalls.length === count + 1, before);
        audioWasPlayed = true;
      }

      const firstChoice = page.locator('input[name="adaptive_diagnostic_choice"]').first();
      await firstChoice.focus();
      await firstChoice.press('Space');
      const answerPath = `/api/v1/adaptive-learning/diagnostics/${diagnosticId}/answers`;
      const answerResponsePromise = page.waitForResponse((response) => (
        response.request().method() === 'POST' && response.url().endsWith(answerPath)
      ));
      const submitButton = page.locator('#adaptive_diagnostic_form button[type="submit"]');
      await submitButton.focus();
      await submitButton.press('Enter');
      const answerResponse = await answerResponsePromise;
      assert.equal(answerResponse.status(), 201);
      const answerResult = await answerResponse.json();

      if (answered === 0) {
        const answerRequest = answerResponse.request();
        const answerKey = answerRequest.headers()['idempotency-key'];
        const answerBody = answerRequest.postDataJSON();
        const replayedAnswer = await replayPublicRequest(page, answerPath, answerKey, answerBody);
        assert.equal(replayedAnswer.status, 200);
        assert.equal(replayedAnswer.body.diagnostic.id, diagnosticId);
        assert.equal(replayedAnswer.body.diagnostic.answeredItems, 1);
        firstAnswerReplay = {
          path: answerPath,
          key: answerKey,
          body: answerBody,
          expected: replayedAnswer.body,
        };
      }
      if (answered === 1) {
        const replayedAfterLaterAnswer = await replayPublicRequest(
          page,
          firstAnswerReplay.path,
          firstAnswerReplay.key,
          firstAnswerReplay.body,
        );
        assert.equal(replayedAfterLaterAnswer.status, 200);
        assert.deepEqual(replayedAfterLaterAnswer.body, firstAnswerReplay.expected);
      }

      assert.equal(answerResult.diagnostic.answeredItems, answered + 1);
      await page.waitForFunction(({ itemId, expectedAnswered }) => {
        const diagnostic = document.querySelector('#adaptive_diagnostic');
        const progress = document.querySelector('#adaptive_diagnostic_progress');
        return Number(progress?.value) === expectedAnswered
          && (diagnostic?.dataset.itemId !== itemId || expectedAnswered === 10);
      }, { itemId: priorItemId, expectedAnswered: answered + 1 }, { timeout: 5_000 });
    }

    assert.equal(audioWasPlayed, true);
    const speechCalls = await page.evaluate(() => window.__adaptiveSpeechCalls);
    assert.ok(speechCalls.length >= 1);
    assert.ok(speechCalls.every((call) => call.lang === 'en-US'));
    const completeButton = page.locator('#adaptive_diagnostic_complete');
    await completeButton.waitFor({ state: 'visible', timeout: 5_000 });
    await completeButton.focus();
    const completeResponsePromise = page.waitForResponse((response) => (
      response.request().method() === 'POST'
        && response.url().endsWith(`/api/v1/adaptive-learning/diagnostics/${diagnosticId}/complete`)
    ));
    await completeButton.press('Enter');
    const completeResponse = await completeResponsePromise;
    assert.equal(
      completeResponse.status(),
      201,
      `Unexpected completion response: ${await completeResponse.text()}\n${output.join('')}`,
    );
    const replayedAfterCompletion = await replayPublicRequest(
      page,
      firstAnswerReplay.path,
      firstAnswerReplay.key,
      firstAnswerReplay.body,
    );
    assert.equal(replayedAfterCompletion.status, 200);
    assert.deepEqual(replayedAfterCompletion.body, firstAnswerReplay.expected);
    await page.getByText(/Диагностика завершена/u).waitFor({ state: 'visible', timeout: 5_000 });
    assert.equal(await page.locator('#adaptive_diagnostic_form').isHidden(), true);
    assert.equal(await startButton.isHidden(), true);

    const current = await page.evaluate(async () => {
      const response = await fetch('/api/v1/adaptive-learning/diagnostics/current');
      return { status: response.status, body: await response.json() };
    });
    assert.equal(current.status, 200);
    assert.deepEqual(current.body, { diagnostic: null, item: null });
    const currentPlan = await page.evaluate(async () => {
      const response = await fetch('/api/v1/adaptive-learning/plan');
      return { status: response.status, body: await response.json() };
    });
    assert.equal(currentPlan.status, 200);
    assert.equal(currentPlan.body.plan.revision, 2);
    assert.ok(currentPlan.body.plan.profileEvidenceSourceCount >= 10);
    assert.equal(await page.locator('#adaptive_forecast').isVisible(), true);
    const lowBudgetGoal = await page.evaluate(async () => {
      const response = await fetch('/api/v1/adaptive-learning/goal', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'adaptive-e2e-low-budget-goal-01',
        },
        body: JSON.stringify({
          targetExam: 'ege_english', targetScore: 85, examDate: '2027-06-01', weeklyMinutes: 30,
        }),
      });
      return { status: response.status, body: await response.json() };
    });
    assert.equal(lowBudgetGoal.status, 201);
    assert.equal(lowBudgetGoal.body.goal.weeklyMinutes, 30);
    assert.equal(lowBudgetGoal.body.plan.revision, 3);
    const vocabularyGap = await page.evaluate(async () => {
      const responses = [];
      const activities = [
        ['vocabulary', 'vocabulary_lexical_choice_topic_1', 0],
        ['grammar', 'grammar_forms_topic_3', 1],
        ['grammar', 'grammar_transformations_topic_18', 1],
        ['reading', 'reading_headings', 1], ['reading', 'reading_detail', 1],
        ['listening', 'listening_matching', 1], ['listening', 'listening_interview', 1],
        ['writing', 'writing_37', 1], ['writing', 'writing_38', 1],
        ['speaking', 'speaking_2', 1], ['speaking', 'speaking_4', 1],
      ];
      for (const [module, activity, score] of activities) for (let index = 0; index < 3; index += 1) {
        const response = await fetch('/api/v1/module-attempts', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: crypto.randomUUID(), module, activity, score, maxScore: 1,
          }),
        });
        responses.push(response.status);
      }
      const plan = await fetch('/api/v1/adaptive-learning/plan', { credentials: 'same-origin' });
      return { responses, status: plan.status, body: await plan.json() };
    });
    assert.equal(vocabularyGap.responses.length, 33);
    assert.equal(vocabularyGap.responses.every((status) => status === 201), true);
    assert.equal(vocabularyGap.status, 200);
    assert.equal(vocabularyGap.body.plan.revision, 4);
    const resetAllocation = await page.evaluate(async () => {
      const response = await fetch('/api/v1/adaptive-learning/goal', {
        method: 'PUT', credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'adaptive-e2e-evidence-reset-goal-01',
        },
        body: JSON.stringify({
          targetExam: 'ege_english', targetScore: 85, examDate: '2027-06-01', weeklyMinutes: 35,
        }),
      });
      return { status: response.status, body: await response.json() };
    });
    assert.equal(resetAllocation.status, 201);
    assert.equal(resetAllocation.body.plan.revision, 5);

    const duration90 = page.locator('input[name="adaptive_session_duration"][value="90"]');
    await duration90.focus();
    await duration90.press('Space');
    const previewResponsePromise = page.waitForResponse((response) => (
      response.request().method() === 'POST'
        && response.url().endsWith('/api/v1/adaptive-learning/sessions/preview')
    ));
    const previewButton = page.locator('#adaptive_session_preview');
    await previewButton.focus();
    await previewButton.press('Enter');
    const previewResponse = await previewResponsePromise;
    assert.equal(previewResponse.status(), 200);
    const previewResult = await previewResponse.json();
    assert.equal(previewResult.preview.durationMinutes, 90);
    assert.equal(previewResult.preview.weeklyBudgetSnapshot.weeklyAvailableMinutes, 35);
    assert.ok(previewResult.preview.weeklyBudgetSnapshot.coverageGaps
      .includes('ege.vocabulary.word_formation'));
    assert.equal(previewResult.preview.blocks.some((block) => block.kind === 'break'), true);
    await page.getByText(/Перерыв · 10 мин/u).waitFor({ state: 'visible', timeout: 5_000 });

    const duration15 = page.locator('input[name="adaptive_session_duration"][value="15"]');
    await duration15.focus();
    await duration15.press('Space');
    const executablePreviewPromise = page.waitForResponse((response) => (
      response.request().method() === 'POST'
        && response.url().endsWith('/api/v1/adaptive-learning/sessions/preview')
    ));
    await previewButton.focus();
    await previewButton.press('Enter');
    const executablePreviewResponse = await executablePreviewPromise;
    assert.equal(executablePreviewResponse.status(), 200);
    const executablePreview = (await executablePreviewResponse.json()).preview;
    assert.equal(executablePreview.durationMinutes, 15);
    assert.equal(executablePreview.blocks.length, 1);
    assert.ok(['vocabulary', 'listening'].includes(executablePreview.blocks[0].module));

    const createSessionResponsePromise = page.waitForResponse((response) => (
      response.request().method() === 'POST'
        && response.url().endsWith('/api/v1/adaptive-learning/sessions')
    ));
    const createSessionButton = page.locator('#adaptive_session_create');
    await createSessionButton.focus();
    await createSessionButton.press('Enter');
    const createSessionResponse = await createSessionResponsePromise;
    assert.equal(createSessionResponse.status(), 201);
    const createSessionResult = await createSessionResponse.json();
    assert.equal(createSessionResult.session.status, 'created');
    await page.locator('#adaptive_session_start').waitFor({ state: 'visible', timeout: 5_000 });

    const firstActivity = createSessionResult.session.blocks.find((block) => block.kind === 'learning');
    assert.ok(['vocabulary', 'listening'].includes(firstActivity.module));
    assert.match(await page.locator('#adaptive_session_blocks').innerText(), new RegExp(
      `${firstActivity.skillLabel} — ${firstActivity.activityLabel}`.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'),
      'u',
    ));
    const startSessionButton = page.locator('#adaptive_session_start');
    const startBlockResponsePromise = page.waitForResponse((response) => (
      response.request().method() === 'POST' && response.url().endsWith('/start')
    ));
    await startSessionButton.focus();
    await startSessionButton.press('Enter');
    const startBlockResponse = await startBlockResponsePromise;
    assert.equal(startBlockResponse.status(), 201);
    await page.locator(`#${firstActivity.launch.screenId}.on`).waitFor({ state: 'visible', timeout: 5_000 });
    await page.waitForFunction(({ screenId, kind, contentRef }) => {
      const screen = document.getElementById(screenId);
      return screen?.dataset.adaptiveLaunchKind === kind
        && screen?.dataset.adaptiveLaunchContentRef === contentRef;
    }, {
      screenId: firstActivity.launch.screenId,
      kind: firstActivity.launch.kind,
      contentRef: firstActivity.contentRef,
    }, { timeout: 5_000 });
    const activeHandoff = await page.evaluate(() => (
      JSON.parse(localStorage.getItem('easyboost.adaptive.execution.v1')).active
    ));
    assert.equal(activeHandoff.module, firstActivity.module);
    assert.equal(activeHandoff.activityId, firstActivity.activityId);
    assert.equal(activeHandoff.pending, null);
    const privacyLater = page.getByRole('button', { name: 'Позже', exact: true });
    if (await privacyLater.isVisible()) await privacyLater.click();
    const attemptResponsePromise = page.waitForResponse((response) => (
      response.request().method() === 'POST'
        && response.url().endsWith('/api/v1/module-attempts')
        && Boolean(response.request().postDataJSON().adaptiveExecutionClaim)
    ), { timeout: 5_000 }).catch(() => null);
    const advanceResponsePromise = page.waitForResponse((response) => (
      response.request().method() === 'POST' && response.url().endsWith('/advance')
    ), { timeout: 5_000 }).catch(() => null);
    if (firstActivity.launch.kind === 'vocabulary_practice') {
      assert.match(await page.locator('#w_card').innerText(), /ВЫБЕРИ ПЕРЕВОД/u);
      await page.evaluate(() => window.WQ.splice(1));
      const correctTranslation = await page.evaluate(() => window.WQ[window.WI].tr);
      await page.locator('#w_opts button').filter({ hasText: correctTranslation }).click();
    } else if (firstActivity.launch.mode === 'matching') {
      for (let row = 0; row < 4; row += 1) {
        await page.locator(`#lmt_row_${row} button`).nth(row).click();
      }
      await page.getByRole('button', { name: 'Проверить', exact: true }).click();
    } else {
      const questionCount = await page.locator('[id^="liq_row_"]').count();
      for (let row = 0; row < questionCount; row += 1) {
        await page.locator(`#liq_row_${row} button`).first().click();
      }
      await page.getByRole('button', { name: 'Проверить', exact: true }).click();
    }
    const attemptResponse = await attemptResponsePromise;
    if (!attemptResponse) {
      const probe = await page.evaluate(async () => {
        const raw = localStorage.getItem('easyboost.adaptive.execution.v1');
        const current = await fetch('/api/v1/adaptive-learning/sessions/current');
        return { raw, currentStatus: current.status, current: await current.json() };
      });
      assert.fail(`adaptive attempt was not sent: ${JSON.stringify({ firstActivity, probe })}`);
    }
    assert.equal(attemptResponse.status(), 201);
    const advanceResponse = await advanceResponsePromise;
    assert.ok(advanceResponse, 'adaptive advance response was not observed');
    assert.equal(advanceResponse.status(), 200);
    const advanceResult = await advanceResponse.json();
    assert.equal(advanceResult.execution.readyToFinish, true);
    assert.equal(advanceResult.completedBlock.evidenceQuality, 'client_reported');
    await page.locator('#scr10.on').waitFor({ state: 'visible', timeout: 5_000 });
    await page.locator('#adaptive_session_blocks li[data-state="completed"]').waitFor({
      state: 'visible', timeout: 5_000,
    });
    assert.match(await page.locator('#adaptive_session_notice').innerText(), /новых доказательств: 1/u);
    assert.equal(await page.evaluate(() => (
      JSON.parse(localStorage.getItem('easyboost.adaptive.execution.v1')).active
    )), null);

    const finishResponsePromise = page.waitForResponse((response) => (
      response.request().method() === 'POST' && response.url().endsWith('/finish')
    ));
    await page.locator('#adaptive_session_start').press('Enter');
    const finishResponse = await finishResponsePromise;
    assert.equal(finishResponse.status(), 200);
    const finishResult = await finishResponse.json();
    assert.equal(finishResult.session.status, 'completed');
    assert.equal(finishResult.summary.completedLearningBlocks, 1);
    assert.equal(finishResult.summary.completedWork.length, 1);
    assert.equal(finishResult.summary.completedWork[0].activityId, firstActivity.activityId);
    assert.equal(finishResult.summary.completedWork[0].evidenceQuality, 'client_reported');
    assert.ok(['planned_practice', 'scheduled_review'].includes(
      finishResult.summary.completedWork[0].evidenceContext,
    ));
    await page.getByText(/Занятие завершено: 1 учебных блоков/u).waitFor({
      state: 'visible', timeout: 5_000,
    });
    assert.match(await page.locator('#adaptive_session_blocks').innerText(), new RegExp(
      firstActivity.activityLabel.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u',
    ));
    const currentSessionAfterFinish = await page.evaluate(async () => (
      (await fetch('/api/v1/adaptive-learning/sessions/current')).status
    ));
    assert.equal(currentSessionAfterFinish, 404);
    const examLaunch = await page.evaluate(() => new Promise((resolve) => {
      window.nav('scr3', () => resolve(
        window.launchGrammarExam('builtin:exam:grammar:19-24:v1'),
      ));
    }));
    assert.equal(examLaunch, true);
    await page.locator('#scr3.on').waitFor({ state: 'visible', timeout: 5_000 });
    assert.match(await page.locator('#g_card').innerText(), /ЗАДАНИЯ 19–24/u);
    assert.equal(await page.locator('[id^="g_ex_"]').count(), 6);

    examContext = await browser.newContext({ serviceWorkers: 'block' });
    await examContext.route('https://**', async (route) => {
      blockedExternalUrls.push(route.request().url());
      await route.abort('blockedbyclient');
    });
    await examContext.addCookies([{
      name: 'eb_token',
      value: jwt.sign({ u: 'adaptiveexam' }, jwtSecret, { expiresIn: '1h' }),
      url: baseUrl,
      httpOnly: true,
      sameSite: 'Lax',
    }]);
    const examPage = await examContext.newPage();
    await examPage.goto(baseUrl, { waitUntil: 'networkidle' });
    await openProgress(examPage);
    await examPage.locator('#adaptive_target_score').fill('85');
    await examPage.locator('#adaptive_exam_date').fill('2027-06-01');
    await examPage.locator('#adaptive_weekly_minutes').fill('300');
    const examGoalPromise = examPage.waitForResponse((response) => (
      response.request().method() === 'PUT'
        && response.url().endsWith('/api/v1/adaptive-learning/goal')
    ));
    await examPage.locator('#adaptive_goal_form button[type="submit"]').press('Enter');
    assert.equal((await examGoalPromise).status(), 201);
    await examPage.locator('#adaptive_session_custom').fill('20');
    const examPreviewPromise = examPage.waitForResponse((response) => (
      response.request().method() === 'POST'
        && response.url().endsWith('/api/v1/adaptive-learning/sessions/preview')
    ));
    await examPage.locator('#adaptive_session_preview').press('Enter');
    const examPreviewResponse = await examPreviewPromise;
    assert.equal(examPreviewResponse.status(), 200);
    const examPreview = (await examPreviewResponse.json()).preview;
    assert.equal(examPreview.blocks[0].activityId, 'grammar_forms_exam_19_24');
    const examCreatePromise = examPage.waitForResponse((response) => (
      response.request().method() === 'POST'
        && response.url().endsWith('/api/v1/adaptive-learning/sessions')
    ));
    await examPage.locator('#adaptive_session_create').press('Enter');
    const examCreateResponse = await examCreatePromise;
    assert.equal(examCreateResponse.status(), 201);
    const examSession = (await examCreateResponse.json()).session;
    const examBlock = examSession.blocks[0];
    const examStartPromise = examPage.waitForResponse((response) => (
      response.request().method() === 'POST' && response.url().endsWith('/start')
    ));
    await examPage.locator('#adaptive_session_start').press('Enter');
    assert.equal((await examStartPromise).status(), 201);
    await examPage.locator('#scr3.on').waitFor({ state: 'visible', timeout: 5_000 });
    assert.equal(await examPage.locator('[id^="g_ex_"]').count(), 6);
    for (let index = 0; index < 6; index += 1) await examPage.locator(`#g_ex_${index}`).fill('wrong');
    const examAttemptPromise = examPage.waitForResponse((response) => (
      response.request().method() === 'POST'
        && response.url().endsWith('/api/v1/module-attempts')
        && response.request().postDataJSON().adaptiveExecutionClaim
    ));
    const examAdvancePromise = examPage.waitForResponse((response) => (
      response.request().method() === 'POST' && response.url().endsWith('/advance')
    ));
    await examPage.getByRole('button', { name: 'Проверить', exact: true }).press('Enter');
    assert.equal((await examAttemptPromise).status(), 201);
    const examAdvanceResponse = await examAdvancePromise;
    assert.equal(examAdvanceResponse.status(), 200);
    const examAdvance = await examAdvanceResponse.json();
    assert.equal(examAdvance.completedBlock.activityId, examBlock.activityId);
    assert.equal(examAdvance.completedBlock.evidenceQuality, 'client_reported');
    assert.equal(examAdvance.completedBlock.evidenceContext, 'exam_practice');
    await examPage.locator('#scr10.on').waitFor({ state: 'visible', timeout: 5_000 });
    await examPage.waitForFunction(() => {
      const button = document.getElementById('adaptive_session_start');
      return button && !button.hidden && !button.disabled
        && button.textContent === 'Завершить занятие';
    });
    const examFinishPromise = examPage.waitForResponse((response) => (
      response.request().method() === 'POST' && response.url().endsWith('/finish')
    ));
    await examPage.locator('#adaptive_session_start').press('Enter');
    const examFinishResponse = await examFinishPromise;
    assert.equal(examFinishResponse.status(), 200);
    const examFinish = await examFinishResponse.json();
    assert.equal(examFinish.summary.completedWork[0].evidenceContext, 'exam_practice');

    writerContext = await browser.newContext({ serviceWorkers: 'block' });
    await writerContext.route('https://**', async (route) => {
      blockedExternalUrls.push(route.request().url());
      await route.abort('blockedbyclient');
    });
    await writerContext.addCookies([{
      name: 'eb_token',
      value: jwt.sign({ u: 'adaptivewriter' }, jwtSecret, { expiresIn: '1h' }),
      url: baseUrl,
      httpOnly: true,
      sameSite: 'Lax',
    }]);
    const writerPage = await writerContext.newPage();
    await writerPage.goto(baseUrl, { waitUntil: 'networkidle' });
    await openProgress(writerPage);
    await writerPage.locator('#adaptive_target_score').fill('85');
    await writerPage.locator('#adaptive_exam_date').fill('2027-06-01');
    await writerPage.locator('#adaptive_weekly_minutes').fill('300');
    const writerGoalPromise = writerPage.waitForResponse((response) => (
      response.request().method() === 'PUT'
        && response.url().endsWith('/api/v1/adaptive-learning/goal')
    ));
    await writerPage.locator('#adaptive_goal_form button[type="submit"]').press('Enter');
    assert.equal((await writerGoalPromise).status(), 201);

    await writerPage.locator('#adaptive_session_custom').fill('25');
    const writerPreviewPromise = writerPage.waitForResponse((response) => (
      response.request().method() === 'POST'
        && response.url().endsWith('/api/v1/adaptive-learning/sessions/preview')
    ));
    await writerPage.locator('#adaptive_session_preview').press('Enter');
    const writerPreviewResponse = await writerPreviewPromise;
    assert.equal(writerPreviewResponse.status(), 200);
    const writerPreview = (await writerPreviewResponse.json()).preview;
    assert.equal(writerPreview.blocks.length, 1);
    assert.equal(writerPreview.blocks[0].activityId, 'writing_37');

    const writerCreatePromise = writerPage.waitForResponse((response) => (
      response.request().method() === 'POST'
        && response.url().endsWith('/api/v1/adaptive-learning/sessions')
    ));
    await writerPage.locator('#adaptive_session_create').press('Enter');
    const writerCreateResponse = await writerCreatePromise;
    assert.equal(writerCreateResponse.status(), 201);
    const writerSession = (await writerCreateResponse.json()).session;
    const writingBlock = writerSession.blocks[0];
    assert.equal(writingBlock.contentRef, 'builtin:writing_37:emily-new-flat');

    const writerStartPromise = writerPage.waitForResponse((response) => (
      response.request().method() === 'POST' && response.url().endsWith('/start')
    ));
    await writerPage.locator('#adaptive_session_start').press('Enter');
    assert.equal((await writerStartPromise).status(), 201);
    await writerPage.locator('#scr8.on').waitFor({ state: 'visible', timeout: 5_000 });
    assert.equal(await writerPage.getByRole('button', { name: 'Новая тема' }).count(), 0);
    assert.equal(await writerPage.locator('#w_seg37').isDisabled(), true);
    const lockedWritingTask = await writerPage.evaluate(() => ({
      changed: window.wrNext(),
      contentRef: document.getElementById('scr8').dataset.adaptiveLaunchContentRef,
    }));
    assert.equal(lockedWritingTask.changed, false);
    assert.equal(lockedWritingTask.contentRef, writingBlock.contentRef);

    const writingAnswer = Array.from({ length: 110 }, (_, index) => `word${index}`).join(' ');
    await writerPage.locator('#w_editor').fill(writingAnswer);
    const writingEvaluationPromise = writerPage.waitForResponse((response) => (
      response.request().method() === 'POST'
        && response.url().endsWith('/api/v1/ai/evaluate-writing')
    ));
    const writingAdvancePromise = writerPage.waitForResponse((response) => (
      response.request().method() === 'POST' && response.url().endsWith('/advance')
    ));
    await writerPage.getByRole('button', { name: 'Проверить с ИИ' }).press('Enter');
    assert.equal((await writingEvaluationPromise).status(), 200);
    const writingAdvance = await writingAdvancePromise;
    assert.equal(writingAdvance.status(), 200);
    const writingAdvanceResult = await writingAdvance.json();
    assert.equal(writingAdvanceResult.completedBlock.evidenceQuality, 'server_verified_assisted');
    assert.equal(writingAdvanceResult.completedBlock.evidenceContext, 'ai_assisted_review');
    await writerPage.locator('#scr12.on').waitFor({ state: 'visible', timeout: 5_000 });
    await writerPage.getByText('Изолированный браузерный разбор готов').waitFor({ state: 'visible' });
    const returnFromWriting = writerPage.locator('#adaptive_writing_return');
    await returnFromWriting.waitFor({ state: 'visible', timeout: 5_000 });
    assert.equal(await writerPage.locator('#scr10.on').count(), 0);
    await returnFromWriting.press('Enter');
    await writerPage.locator('#scr10.on').waitFor({ state: 'visible', timeout: 5_000 });
    await writerPage.waitForFunction(() => {
      const button = document.getElementById('adaptive_session_start');
      return button && !button.hidden && !button.disabled
        && button.textContent === 'Завершить занятие';
    });

    const writerFinishPromise = writerPage.waitForResponse((response) => (
      response.request().method() === 'POST' && response.url().endsWith('/finish')
    ));
    await writerPage.locator('#adaptive_session_start').press('Enter');
    const writerFinishResponse = await writerFinishPromise;
    assert.equal(writerFinishResponse.status(), 200);
    const writerFinish = await writerFinishResponse.json();
    assert.equal(writerFinish.summary.completedWork[0].evidenceQuality, 'server_verified_assisted');
    assert.equal(writerFinish.summary.completedWork[0].evidenceContext, 'ai_assisted_review');
    assert.ok(providerCalls.length >= 1);
    assert.equal(blockedExternalUrls.some((url) => /x\.ai|groq|openai/u.test(url)), false);
    console.log('adaptive e2e: diagnostic plus client module, exam launch and exact writing execution passed');
  } finally {
    if (writerContext) await writerContext.close();
    if (examContext) await examContext.close();
    if (context) await context.close();
    if (browser) await browser.close();
    if (child) await stopProcess(child);
    if (providerServer) await new Promise((resolve) => providerServer.close(resolve));
    if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

runAdaptiveDiagnosticE2E().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
