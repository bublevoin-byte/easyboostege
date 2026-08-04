import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
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
  let temporaryDirectory;
  try {
    temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-adaptive-e2e-'));
    const port = await findAvailablePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const dataFile = path.join(temporaryDirectory, 'data.json');
    const jwtSecret = 'adaptive-e2e-secret-with-at-least-32-characters';
    await fs.writeFile(dataFile, JSON.stringify({
      users: {
        adaptivee2e: { created: Date.now(), sub_until: Date.now() + 86_400_000 },
      },
      progress: { adaptivee2e: {} },
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
        XAI_ENABLED: 'false',
        XAI_API_KEY: '',
        GROQ_API_KEY: '',
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
    assert.equal(previewResult.preview.weeklyBudgetSnapshot.weeklyAvailableMinutes, 30);
    assert.ok(previewResult.preview.weeklyBudgetSnapshot.coverageGaps
      .includes('ege.vocabulary.word_formation'));
    assert.equal(previewResult.preview.blocks.some((block) => block.kind === 'break'), true);
    await page.getByText(/Перерыв · 10 мин/u).waitFor({ state: 'visible', timeout: 5_000 });

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
    assert.equal(await page.locator('#adaptive_session_start').isVisible(), true);

    const learningBlocks = createSessionResult.session.blocks.filter((block) => block.kind === 'learning');
    const replacementTarget = learningBlocks.slice().sort((left, right) => right.difficulty - left.difficulty)[0];
    const replacementIndex = learningBlocks.findIndex((block) => block.id === replacementTarget.id);
    const replacementButton = page.getByRole('button', { name: 'Заменить' }).nth(replacementIndex);
    const replacementResponsePromise = page.waitForResponse((response) => (
      response.request().method() === 'POST' && response.url().endsWith('/replace')
    ));
    await replacementButton.focus();
    await replacementButton.press('Enter');
    const replacementResponse = await replacementResponsePromise;
    assert.equal(replacementResponse.status(), 200);
    const replacementResult = await replacementResponse.json();
    assert.equal(replacementResult.session.revision, 2);
    assert.deepEqual(
      replacementResult.session.blocks.map((block) => block.id),
      createSessionResult.session.blocks.map((block) => block.id),
    );
    assert.equal(await page.getByRole('button', { name: 'Заменить' }).count(), 0);

    const firstActivity = replacementResult.session.blocks.find((block) => block.kind === 'learning');
    assert.match(await page.locator('#adaptive_session_blocks').innerText(), new RegExp(
      `${firstActivity.skillLabel} — ${firstActivity.activityLabel}`.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'),
      'u',
    ));
    const startSessionButton = page.locator('#adaptive_session_start');
    await startSessionButton.focus();
    await startSessionButton.press('Enter');
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
    await page.evaluate(() => window.tab('scr2'));
    await page.locator('#scr2.on').waitFor({ state: 'visible', timeout: 5_000 });
    await page.waitForFunction(() => typeof window.launchVocabularyPractice === 'function', null, {
      timeout: 5_000,
    });
    assert.equal(await page.evaluate(() => window.launchVocabularyPractice('lexical_choice', 1)), true);
    assert.match(await page.locator('#w_card').innerText(), /ВЫБЕРИ ПЕРЕВОД/u);
    assert.equal(blockedExternalUrls.some((url) => /x\.ai|groq|openai/u.test(url)), false);
    console.log('adaptive e2e: diagnostic plus session/replacement/vocabulary handoff passed');
  } finally {
    if (context) await context.close();
    if (browser) await browser.close();
    if (child) await stopProcess(child);
    if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

runAdaptiveDiagnosticE2E().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
