import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import { chromium, devices, firefox, webkit } from 'playwright';
import { WebSocketServer } from 'ws';

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

const browserEngine = process.env.E2E_BROWSER || 'chromium';
const browserProfile = process.env.E2E_PROFILE || 'desktop';
if (!['chromium', 'firefox', 'webkit'].includes(browserEngine)) {
  throw new Error('E2E_BROWSER must be chromium, firefox or webkit');
}
if (!['desktop', 'android', 'iphone'].includes(browserProfile)) {
  throw new Error('E2E_PROFILE must be desktop, android or iphone');
}
if (browserProfile === 'android' && browserEngine !== 'chromium') {
  throw new Error('The android profile requires E2E_BROWSER=chromium');
}
if (browserProfile === 'iphone' && browserEngine !== 'webkit') {
  throw new Error('The iphone profile requires E2E_BROWSER=webkit');
}

async function launchBrowser() {
  if (browserEngine === 'webkit') return webkit.launch({ headless: true });
  if (browserEngine === 'firefox') {
    return firefox.launch({
      headless: true,
      env: process.platform === 'win32'
        ? { ...process.env, MOZ_DISABLE_CONTENT_SANDBOX: '1' }
        : process.env,
    });
  }
  return chromium.launch({ headless: true, executablePath: await chromeExecutable() });
}

function contextOptions(overrides = {}) {
  const profile = browserProfile === 'android'
    ? devices['Pixel 7']
    : browserProfile === 'iphone'
      ? devices['iPhone 15']
      : {};
  return { ...profile, ...overrides };
}

async function runE2E() {
  let temporaryDirectory;
  let child;
  let browser;
    let fakeProviderServer;
    let fakeProviderWss;
  try {
    browser = await launchBrowser();
    const context = await browser.newContext(contextOptions());
    const page = await context.newPage();
    temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-e2e-'));
    const port = await findAvailablePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const dataFile = path.join(temporaryDirectory, 'data.json');
    const jwtSecret = 'e2e-test-secret-with-at-least-32-characters';
    const fakeProviderPort = await findAvailablePort();
    const fakeProviderEvidence = { connections: 0, headers: null, received: [], bargeIn: [] };
    const tutorEvents = [
      { id: 'e2e-call-diagnose', payload: { type: 'diagnosis_complete' } },
      { id: 'e2e-call-explain', payload: { type: 'explanation_complete' } },
      { id: 'e2e-call-micro', payload: { type: 'check_answer', answer: 'saw' } },
      { id: 'e2e-call-transfer', payload: { type: 'transfer_answer', answer: 'was cooking' } },
    ];
    let tutorEventIndex = 0;
    fakeProviderServer = http.createServer((_request, response) => response.writeHead(404).end());
    fakeProviderWss = new WebSocketServer({ server: fakeProviderServer, maxPayload: 262_144 });
    fakeProviderWss.on('connection', (socket, request) => {
      fakeProviderEvidence.connections += 1;
      const connectionNumber = fakeProviderEvidence.connections;
      fakeProviderEvidence.headers = request.headers;
      socket.send(JSON.stringify({ type: 'session.created' }));
      socket.send(JSON.stringify({ type: 'conversation.created' }));
      const emitTool = () => {
        const tool = tutorEvents[tutorEventIndex];
        if (!tool) { socket.send(JSON.stringify({ type: 'error', error: { code: 'e2e_runtime_failure' } })); return; }
        const responseId = `response-${tool.id}`;
        const itemId = `item-${tool.id}`;
        socket.send(JSON.stringify({ type: 'response.created', response_id: responseId }));
        socket.send(JSON.stringify({
          type: 'response.output_item.added', response_id: responseId,
          item: { type: 'function_call', id: itemId, name: 'advance_pedagogy', call_id: tool.id },
        }));
        socket.send(JSON.stringify({
          type: 'response.function_call_arguments.done', response_id: responseId, item_id: itemId,
          name: 'advance_pedagogy', call_id: tool.id, arguments: JSON.stringify(tool.payload),
        }));
        socket.send(JSON.stringify({ type: 'response.done', response_id: responseId, response: { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }));
      };
      socket.on('message', (data) => {
        const event = JSON.parse(data.toString());
        fakeProviderEvidence.received.push(event);
        if (event.type === 'session.update') {
          socket.send(JSON.stringify({ type: 'session.updated' }));
          if (connectionNumber === 1) {
            setTimeout(() => {
              socket.send(JSON.stringify({ type: 'response.created', response_id: 'response-barge' }));
              socket.send(JSON.stringify({
                type: 'response.output_item.added', response_id: 'response-barge',
                item: { type: 'message', role: 'assistant', id: 'assistant-barge' },
              }));
              socket.send(JSON.stringify({
                type: 'response.output_audio.delta', response_id: 'response-barge',
                delta: Buffer.alloc(2_400).toString('base64'),
              }));
              socket.send(JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
            }, 50);
          }
        }
        if (event.type === 'response.cancel') fakeProviderEvidence.bargeIn.push('cancel');
        if (event.type === 'conversation.item.truncate') {
          fakeProviderEvidence.bargeIn.push('truncate');
          socket.send(JSON.stringify({ type: 'response.cancelled', response_id: 'response-barge' }));
          emitTool();
        }
        if (event.type === 'conversation.item.create' && event.item?.type === 'function_call_output') {
          tutorEventIndex += 1;
          if (tutorEvents[tutorEventIndex]) {
            socket.send(JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
          }
        }
        if (event.type === 'response.create') setTimeout(emitTool, 10);
      });
    });
    await new Promise((resolve, reject) => {
      fakeProviderServer.once('error', reject);
      fakeProviderServer.listen(fakeProviderPort, '127.0.0.1', resolve);
    });
    await fs.writeFile(dataFile, JSON.stringify({
      users: {
        e2euser: {
          created: Date.now(),
          sub_until: Date.now() + 86_400_000,
          privacy_consent: {
            text_processing: true,
            voice_processing: true,
            policy_version: '2026-08-02-voice-v1',
            updated_at: Date.now(),
          },
        },
        expireduser: { created: Date.now(), sub_until: Date.now() - 60_000 },
      },
      progress: {
        e2euser: { words: { known: 0 } },
        expireduser: {},
      },
      subscription_entitlements: {
        e2euser: {
          voice_tutor: {
            starts_at: new Date(Date.now() - 60_000).toISOString(),
            ends_at: new Date(Date.now() + 86_400_000).toISOString(),
          },
        },
      },
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
        ADAPTIVE_LEARNING_ENABLED: 'false',
        XAI_API_KEY: 'e2e-provider-boundary-key',
        XAI_ENABLED: 'true',
        XAI_VOICE_MODEL: 'grok-voice-think-fast-1.0',
        XAI_VOICE_NAME: 'ara',
        XAI_VOICE_REALTIME_URL: `ws://127.0.0.1:${fakeProviderPort}/v1/realtime`,
        VOICE_TUTOR_ENABLED: 'true',
        VOICE_TUTOR_COST_KILL_SWITCH: 'false',
        VOICE_TUTOR_REQUIRE_ZDR: 'true',
        XAI_VOICE_ZDR_ATTESTED: 'true',
        GROQ_API_KEY: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => output.push(chunk.toString()));
    child.stderr.on('data', (chunk) => output.push(chunk.toString()));
    await waitForReady(baseUrl, child, output);
    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    console.log('e2e: login screen loaded');

    await assert.doesNotReject(() => page.getByRole('button', { name: 'Попробовать демо' }).click());
    const wordsCard = page.getByRole('button', { name: 'Слова', exact: true });
    await wordsCard.waitFor({ state: 'visible' });
    assert.equal(await wordsCard.getAttribute('tabindex'), '0');
    await wordsCard.press('Enter');
    console.log('e2e: words module opened by keyboard');

    await page.locator('#scr2.on').waitFor({ state: 'visible', timeout: 5_000 });
    await page.getByRole('button', { name: /^Начать ·/u }).click();
    const options = page.locator('#w_opts button');
    const optionCount = await options.count();
    console.log(`e2e: ${optionCount} answer options found`);
    assert.ok(optionCount >= 4);
    const promptBefore = await page.locator('#w_card').innerText();
    console.log('e2e: prompt captured');
    await options.nth(0).click({ timeout: 5_000 });
    await page.waitForFunction((previous) => document.querySelector('#w_card')?.innerText !== previous, promptBefore, { timeout: 5_000 });
    console.log('e2e: word task advanced');

    const pwa = await page.evaluate(async (origin) => {
      const manifest = document.querySelector('link[rel="manifest"]')?.getAttribute('href');
      const registration = await navigator.serviceWorker.getRegistration();
      return { manifest, scope: registration?.scope || null, expectedScope: `${origin}/` };
    }, baseUrl);
    assert.equal(pwa.manifest, '/manifest.json');
    assert.equal(pwa.scope, pwa.expectedScope);

    await context.close();

    const authenticatedContext = await browser.newContext(contextOptions({ serviceWorkers: 'block' }));
    await authenticatedContext.addCookies([{
      name: 'eb_token',
      value: jwt.sign({ u: 'e2euser' }, jwtSecret, { expiresIn: '1h' }),
      url: baseUrl,
      httpOnly: true,
      sameSite: 'Lax',
    }]);
    const authenticatedPage = await authenticatedContext.newPage();
    const evaluatedWritingTasks = [];
    await authenticatedPage.route('**/api/v1/ai/evaluate-writing', async (route) => {
      const request = route.request();
      const input = request.postDataJSON();
      const task37 = input.taskType === 'writing_37';
      const criteria = task37
        ? [
            { name: 'Решение коммуникативной задачи', got: 2, max: 2 },
            { name: 'Организация текста', got: 2, max: 2 },
            { name: 'Языковое оформление', got: 2, max: 2 },
          ]
        : [
            { name: 'Решение коммуникативной задачи', got: 3, max: 3 },
            { name: 'Организация текста', got: 3, max: 3 },
            { name: 'Лексика', got: 3, max: 3 },
            { name: 'Грамматика', got: 3, max: 3 },
            { name: 'Орфография и пунктуация', got: 2, max: 2 },
          ];
      evaluatedWritingTasks.push(input.taskType);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          review: {
            words: input.answer.trim().split(/\s+/u).length,
            in_range: true,
            overall_got: criteria.reduce((total, criterion) => total + criterion.got, 0),
            overall_max: task37 ? 6 : 14,
            verdict: task37 ? 'Задание 37 проверено' : 'Задание 38 проверено',
            sub: 'Изолированный E2E-разбор',
            criteria,
            errors: [],
          },
          provider: 'e2e',
          attemptId: task37 ? 'writing-37-e2e' : 'writing-38-e2e',
        }),
      });
    });
    await authenticatedPage.goto(baseUrl, { waitUntil: 'networkidle' });
    await authenticatedPage.locator('#scr1.on').waitFor({ state: 'visible', timeout: 5_000 });
    assert.equal(await authenticatedPage.locator('#home_adaptive_plan').isHidden(), true);
    assert.equal(await authenticatedPage.locator('#profile_adaptive_plan').isHidden(), true);
    console.log('e2e: authenticated session restored');

    await authenticatedPage.evaluate(() => window.EasyBoostSync.setBaseline({ words: { known: 0 } }));
    await authenticatedContext.setOffline(true);
    const savedOffline = await authenticatedPage.evaluate(() => window.EasyBoostSync.saveProgress({ words: { known: 1 } }));
    assert.equal(savedOffline, false);
    assert.equal(await authenticatedPage.evaluate(() => window.EasyBoostSync.hasPending()), true);
    console.log('e2e: offline progress queued');

    await authenticatedContext.setOffline(false);
    assert.equal(await authenticatedPage.evaluate(() => window.EasyBoostSync.flush()), true);
    assert.equal(await authenticatedPage.evaluate(() => window.EasyBoostSync.hasPending()), false);
    console.log('e2e: queued progress synchronized');
    await authenticatedPage.reload({ waitUntil: 'networkidle' });
    const persisted = await authenticatedPage.evaluate(async () => (await fetch('/api/v1/progress')).json());
    assert.equal(persisted.words.known, 1);
    console.log('e2e: progress persisted after reload');

    // Section 6.1: built-in tasks and saved progress must survive a start without network.
    const snapshot = await authenticatedPage.evaluate(() => {
      const user = localStorage.getItem('eb_current');
      const state = window.EasyBoostStore.loadLocal(user);
      state.learned = 42;
      state.prog.words = 63;
      state.prog.read = 55;
      state.streak = 7;
      window.EasyBoostStore.saveLocal(user, state);
      return window.EasyBoostStore.loadLocal(user).learned;
    });
    assert.equal(snapshot, 42, 'the running app keeps a local snapshot for offline starts');
    await authenticatedContext.setOffline(true);
    await authenticatedPage.evaluate(() => window.startApp());
    await authenticatedPage.locator('#scr1.on').waitFor({ state: 'visible', timeout: 5_000 });
    assert.equal(await authenticatedPage.locator('#m_words').textContent(), '63');
    assert.equal(await authenticatedPage.locator('#m_read').textContent(), '55');
    assert.match(await authenticatedPage.locator('#h_streak').textContent(), /7 дней подряд/u);
    console.log('e2e: saved progress readable without network');

    await authenticatedPage.getByRole('button', { name: 'Слова', exact: true }).press('Enter');
    await authenticatedPage.locator('#scr2.on').waitFor({ state: 'visible', timeout: 5_000 });
    await authenticatedPage.getByRole('button', { name: /^Начать ·/u }).click();
    assert.ok(await authenticatedPage.locator('#w_opts button').count() >= 2);
    await authenticatedPage.evaluate(() => window.tab('scr1'));
    await authenticatedPage.locator('#scr1.on').waitFor({ state: 'visible', timeout: 5_000 });
    await authenticatedPage.getByRole('button', { name: 'Грамматика', exact: true }).press('Enter');
    await authenticatedPage.locator('#scr3.on').waitFor({ state: 'visible', timeout: 5_000 });
    assert.ok(await authenticatedPage.locator('#g_area button').count() >= 1);
    console.log('e2e: built-in word and grammar tasks work offline');
    await authenticatedContext.setOffline(false);
    await authenticatedPage.evaluate(() => window.tab('scr1'));

    await authenticatedPage.getByRole('button', { name: 'Письмо', exact: true }).press('Enter');
    await authenticatedPage.locator('#scr8.on').waitFor({ state: 'visible', timeout: 5_000 });
    await authenticatedPage.getByRole('button', { name: '37 · Письмо другу' }).click();
    await authenticatedPage.getByRole('textbox', { name: 'Письменный ответ' }).fill(
      Array.from({ length: 105 }, (_, index) => `word${index + 1}`).join(' '),
    );
    await authenticatedPage.getByRole('button', { name: 'Проверить с ИИ' }).click();
    await authenticatedPage.locator('#scr12.on').waitFor({ state: 'visible', timeout: 5_000 });
    await authenticatedPage.waitForFunction(
      () => document.querySelector('#rv_score')?.textContent === '6',
      null,
      { timeout: 5_000 },
    );
    assert.equal(await authenticatedPage.locator('#rv_score').textContent(), '6');
    assert.equal(await authenticatedPage.locator('#rv_verdict').innerText(), 'Задание 37 проверено');

    await authenticatedPage.getByRole('button', { name: 'Исправить' }).click();
    await authenticatedPage.getByRole('button', { name: '38 · Проект' }).click();
    await authenticatedPage.getByRole('textbox', { name: 'Письменный ответ' }).fill(
      Array.from({ length: 205 }, (_, index) => `project${index + 1}`).join(' '),
    );
    await authenticatedPage.getByRole('button', { name: 'Проверить с ИИ' }).click();
    await authenticatedPage.locator('#scr12.on').waitFor({ state: 'visible', timeout: 5_000 });
    await authenticatedPage.waitForFunction(
      () => document.querySelector('#rv_score')?.textContent === '14',
      null,
      { timeout: 5_000 },
    );
    assert.equal(await authenticatedPage.locator('#rv_score').textContent(), '14');
    assert.equal(await authenticatedPage.locator('#rv_verdict').innerText(), 'Задание 38 проверено');
    assert.deepEqual(evaluatedWritingTasks, ['writing_37', 'writing_38']);
    console.log('e2e: writing tasks 37 and 38 received structured reviews');

    await authenticatedPage.evaluate(async () => {
      window.__e2eMicrophoneMode = 'success';
      class FakeAudioContext {
        constructor() {
          this.currentTime = 0;
          this.destination = {};
        }
        createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
        createScriptProcessor() { return { connect() {}, disconnect() {}, onaudioprocess: null }; }
        createGain() { return { gain: { value: 0 }, connect() {}, disconnect() {} }; }
        async close() {}
      }
      Object.defineProperty(window, 'AudioContext', { configurable: true, writable: true, value: FakeAudioContext });
      window.configureVoiceTutor({
        mediaDevices: {
          async getUserMedia() {
            return { getTracks: () => [{ stop() {} }] };
          },
        },
      });
      window.tab('scr3');
      window.S.examIdx = 0;
      window.gExam();
      window.gExamStart();
      const answers = ['go-ed-private-e2e', 'first', 'was founded', 'more beautiful', 'is planning', 'her'];
      answers.forEach((answer, index) => { document.getElementById(`g_ex_${index}`).value = answer; });
      window.gExamCheck();
    });
    const voiceButton = authenticatedPage.locator('#voice_tutor_grammar_0 .voiceTutorTrigger');
    await voiceButton.waitFor({ state: 'visible', timeout: 5_000 });
    await authenticatedPage.evaluate(() => {
      const state = document.getElementById('voiceTutorState');
      window.__voiceTutorStateHistory = [];
      const capture = () => window.__voiceTutorStateHistory.push(state.textContent || '');
      capture();
      new MutationObserver(capture).observe(state, { childList: true, subtree: true, characterData: true });
    });
    const [providerFallbackResponse] = await Promise.all([
      authenticatedPage.waitForResponse((response) => (
        response.request().method() === 'POST'
          && response.url().includes('/voice-tutor/sessions/')
          && response.url().endsWith('/fallback')
      )),
      voiceButton.click(),
    ]);
    const voiceSheet = authenticatedPage.getByRole('dialog', { name: 'Разбор ошибки с ИИ' });
    await voiceSheet.waitFor({ state: 'visible', timeout: 5_000 });
    await authenticatedPage.evaluate(async () => {
      await fetch('/api/v1/privacy/consent', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text_processing: false, voice_processing: true }),
      });
    });
    const expectedTutorStates = [
      'Past Simple — завершённое действие',
      'I _____ him yesterday',
      'While I _____ dinner',
      'правило проверено на новом примере',
    ];
    await authenticatedPage.waitForFunction((fragments) => fragments.every((fragment) => (
      window.__voiceTutorStateHistory.some((value) => value.includes(fragment))
    )), expectedTutorStates, { timeout: 5_000 });
    const tutorStateHistory = await authenticatedPage.evaluate(() => window.__voiceTutorStateHistory);
    for (const fragment of expectedTutorStates) {
      assert.ok(tutorStateHistory.some((value) => value.includes(fragment)), `missing tutor state: ${fragment}`);
    }
    assert.equal(providerFallbackResponse.status(), 200);
    assert.equal((await providerFallbackResponse.json()).mode, 'local');
    await authenticatedPage.waitForFunction(async () => {
      const exported = await (await fetch('/api/v1/account/export')).json();
      const session = exported.voice_tutor_sessions?.[0];
      return session?.delivery_mode === 'local';
    });
    const voiceEvidence = await authenticatedPage.evaluate(async () => {
      const recovery = await (await fetch('/api/v1/voice-tutor/recovery-map')).json();
      const exported = await (await fetch('/api/v1/account/export')).json();
      return {
        recovery,
        voiceExport: exported.voice_tutor_sessions,
        recoveriesExport: exported.voice_tutor_recoveries,
      };
    });
    const settledVoiceSession = voiceEvidence.voiceExport.find((session) => session.delivery_mode === 'local');
    assert.equal(fakeProviderEvidence.connections, 1);
    assert.equal(fakeProviderEvidence.headers.authorization, 'Bearer e2e-provider-boundary-key');
    assert.deepEqual(fakeProviderEvidence.bargeIn, ['cancel', 'truncate']);
    const providerSession = fakeProviderEvidence.received.find((event) => event.type === 'session.update');
    assert.equal(providerSession.session.model, 'grok-voice-think-fast-1.0');
    assert.equal(providerSession.session.voice, 'ara');
    assert.equal(providerSession.session.tools[0].name, 'advance_pedagogy');
    assert.match(providerSession.session.instructions, /diagnose → explain → micro_check → transfer_task/u);
    assert.match(providerSession.session.instructions, /"learner_answer":"go-ed-private-e2e"/u);
    assert.doesNotMatch(providerSession.session.instructions, /"reference":|"answers":/u);
    assert.equal(voiceEvidence.recovery.skills[0].state, 'open');
    assert.equal(voiceEvidence.recovery.skills[0].initial_micro_check_passed, true);
    assert.equal(voiceEvidence.recovery.skills[0].initial_transfer_passed, true);
    assert.equal(settledVoiceSession.delivery_mode, 'local');
    assert.equal(settledVoiceSession.error_code, 'VOICE_TUTOR_PROVIDER_UNAVAILABLE');
    assert.equal(settledVoiceSession.provider, 'xai');
    assert.equal(settledVoiceSession.model, 'grok-voice-think-fast-1.0');
    assert.equal(settledVoiceSession.prompt_version, 'voice-tutor-error-v4');
    assert.equal(Number(settledVoiceSession.proxy_input_audio_bytes), 0);
    assert.equal(
      Number(settledVoiceSession.proxy_output_audio_bytes),
      2_400,
      `unexpected provider usage settlement: ${JSON.stringify({
        status: settledVoiceSession.status,
        delivery_mode: settledVoiceSession.delivery_mode,
        billable_seconds: Number(settledVoiceSession.billable_seconds),
        proxy_usage_confirmed: settledVoiceSession.proxy_usage_confirmed,
        proxy_finalization_reason: settledVoiceSession.proxy_finalization_reason,
        bargeIn: fakeProviderEvidence.bargeIn,
      })}`,
    );
    assert.equal(settledVoiceSession.proxy_usage_confirmed, false);
    assert.equal(Number(settledVoiceSession.billable_seconds), 300);
    assert.equal(voiceEvidence.recovery.voice_minutes.remaining_daily, 5);
    assert.equal(voiceEvidence.recovery.voice_minutes.remaining_monthly, 115);
    assert.ok(Number.isFinite(new Date(settledVoiceSession.voice_activated_at).getTime()));
    assert.doesNotMatch(JSON.stringify(voiceEvidence.voiceExport), /go-ed-private-e2e|raw_audio|full_transcript|utterance/iu);
    assert.doesNotMatch(JSON.stringify(voiceEvidence.recoveriesExport), /go-ed-private-e2e|raw_audio|full_transcript|utterance/iu);
    await voiceSheet.getByRole('button', { name: 'Завершить и вернуться в упражнение' }).click();

    await voiceButton.click();
    await voiceSheet.waitFor({ state: 'visible', timeout: 5_000 });
    try {
      await voiceSheet.getByText('Голосовой репетитор подключён.').waitFor({ state: 'visible', timeout: 5_000 });
    } catch (error) {
      throw new Error(`second voice connection failed: connections=${fakeProviderEvidence.connections}; state=${await voiceSheet.locator('#voiceTutorState').innerText()}`, { cause: error });
    }
    await voiceSheet.getByRole('button', { name: 'Завершить и вернуться в упражнение' }).click();
    await voiceSheet.waitFor({ state: 'hidden', timeout: 5_000 });
    await authenticatedPage.waitForFunction(async () => {
      const exported = await (await fetch('/api/v1/account/export')).json();
      return exported.voice_tutor_sessions?.some((session) => session.proxy_finalization_reason === 'completed');
    });
    const cleanVoiceEvidence = await authenticatedPage.evaluate(async () => {
      const recovery = await (await fetch('/api/v1/voice-tutor/recovery-map')).json();
      const exported = await (await fetch('/api/v1/account/export')).json();
      return { recovery, sessions: exported.voice_tutor_sessions };
    });
    const cleanVoiceSession = cleanVoiceEvidence.sessions.find((session) => session.proxy_finalization_reason === 'completed');
    assert.equal(fakeProviderEvidence.connections, 2);
    assert.equal(Number(cleanVoiceSession.proxy_input_audio_bytes), 0);
    assert.equal(Number(cleanVoiceSession.proxy_output_audio_bytes), 0);
    assert.equal(cleanVoiceSession.proxy_usage_confirmed, true);
    assert.equal(Number(cleanVoiceSession.billable_seconds), 0);
    assert.equal(cleanVoiceEvidence.recovery.voice_minutes.remaining_daily, 5);
    assert.equal(cleanVoiceEvidence.recovery.voice_minutes.remaining_monthly, 115);

    await authenticatedPage.evaluate(() => {
      window.configureVoiceTutor({
        mediaDevices: {
          async getUserMedia() { throw new DOMException('Permission denied', 'NotAllowedError'); },
        },
      });
    });
    const priorVoiceSessionIds = await authenticatedPage.evaluate(async () => {
      const exported = await (await fetch('/api/v1/account/export')).json();
      return exported.voice_tutor_sessions.map((session) => session.id);
    });
    const microphoneFallbackResponsePromise = authenticatedPage.waitForResponse((response) => (
      response.request().method() === 'POST'
        && response.url().includes('/voice-tutor/sessions/')
        && response.url().endsWith('/fallback')
    ));
    await voiceButton.click();
    await voiceSheet.waitFor({ state: 'visible', timeout: 5_000 });
    const microphoneFallbackResponse = await microphoneFallbackResponsePromise;
    assert.equal(microphoneFallbackResponse.status(), 200);
    assert.equal((await microphoneFallbackResponse.json()).mode, 'local');
    await authenticatedPage.waitForFunction(async (priorIds) => {
      const exported = await (await fetch('/api/v1/account/export')).json();
      const session = exported.voice_tutor_sessions?.find((entry) => !priorIds.includes(entry.id));
      return session?.delivery_mode === 'local'
        && session?.proxy_finalization_reason === 'completed'
        && session?.status === 'completed';
    }, priorVoiceSessionIds);
    const deniedVoiceEvidence = await authenticatedPage.evaluate(async (priorIds) => {
      const recovery = await (await fetch('/api/v1/voice-tutor/recovery-map')).json();
      const exported = await (await fetch('/api/v1/account/export')).json();
      return {
        recovery,
        session: exported.voice_tutor_sessions.find((entry) => !priorIds.includes(entry.id)),
        sessions: exported.voice_tutor_sessions.map((session) => ({
          ...session,
          is_new_session: !priorIds.includes(session.id),
        })),
      };
    }, priorVoiceSessionIds);
    assert.equal(fakeProviderEvidence.connections, 3);
    assert.equal(Number(deniedVoiceEvidence.session.proxy_input_audio_bytes), 0);
    assert.equal(Number(deniedVoiceEvidence.session.proxy_output_audio_bytes), 0);
    assert.equal(deniedVoiceEvidence.session.proxy_usage_confirmed, true);
    assert.equal(Number(deniedVoiceEvidence.session.billable_seconds), 0);
    const quotaEvidence = deniedVoiceEvidence.sessions.map((session) => ({
      is_new_session: session.is_new_session,
      started_at: session.started_at,
      status: session.status,
      delivery_mode: session.delivery_mode,
      billable_seconds: Number(session.billable_seconds),
      reserved_seconds: Number(session.reserved_seconds),
      proxy_usage_confirmed: session.proxy_usage_confirmed,
      proxy_finalization_reason: session.proxy_finalization_reason,
    }));
    assert.equal(
      deniedVoiceEvidence.session.delivery_mode,
      'local',
      `denied session delivery reverted: ${JSON.stringify(quotaEvidence)}`,
    );
    assert.equal(
      deniedVoiceEvidence.recovery.voice_minutes.remaining_daily,
      5,
      `unexpected post-denial quota: ${JSON.stringify(quotaEvidence)}`,
    );
    await voiceSheet.getByRole('button', { name: 'Завершить и вернуться в упражнение' }).click();
    const beforeCancelledOpen = await authenticatedPage.evaluate(async () => {
      const exported = await (await fetch('/api/v1/account/export')).json();
      return exported.voice_tutor_sessions.map((session) => session.id);
    });
    await authenticatedPage.evaluate(() => {
      const originalApi = window.EasyBoostApi;
      window.__releaseCancelledVoiceOpen = null;
      const delayedApi = {
        post: (...args) => originalApi.post(...args),
        messageFor: (...args) => originalApi.messageFor(...args),
        async postIdempotent(...args) {
          await new Promise((resolve) => { window.__releaseCancelledVoiceOpen = resolve; });
          return originalApi.postIdempotent(...args);
        },
      };
      window.configureVoiceTutor({ api: delayedApi });
    });
    await voiceButton.click();
    await voiceSheet.waitFor({ state: 'visible', timeout: 5_000 });
    await authenticatedPage.waitForFunction(() => typeof window.__releaseCancelledVoiceOpen === 'function');
    await voiceSheet.locator('#voiceTutorFinish').click();
    await voiceSheet.waitFor({ state: 'hidden', timeout: 5_000 });
    await authenticatedPage.evaluate(() => window.__releaseCancelledVoiceOpen());
    await authenticatedPage.waitForFunction(async (priorIds) => {
      const exported = await (await fetch('/api/v1/account/export')).json();
      const session = exported.voice_tutor_sessions.find((entry) => !priorIds.includes(entry.id));
      return session?.status === 'completed' && Number(session.billable_seconds) === 0;
    }, beforeCancelledOpen);
    assert.equal(fakeProviderEvidence.connections, 3);
    assert.equal(await voiceSheet.isHidden(), true);
    await authenticatedPage.evaluate(() => window.configureVoiceTutor({ api: window.EasyBoostApi }));
    console.log('e2e: cancelled pending Voice Tutor open releases its reservation without starting media');
    console.log('e2e: Voice Error Tutor fake-provider recovery loop passed without paid network');

    await authenticatedPage.evaluate(() => window.tab('scr1'));
    await authenticatedPage.locator('#scr1.on').waitFor({ state: 'visible', timeout: 5_000 });
    await authenticatedPage.evaluate(() => {
      window.__e2eMicrophoneMode = 'success';
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: {
          getUserMedia: async () => {
            if (window.__e2eMicrophoneMode === 'denied') {
              throw new DOMException('Permission denied', 'NotAllowedError');
            }
            return { getTracks: () => [{ stop() {} }] };
          },
        },
      });
      class E2EMediaRecorder {
        static isTypeSupported(type) {
          return type === 'audio/webm';
        }

        constructor() {
          this.mimeType = 'audio/webm';
          this.state = 'inactive';
          this.ondataavailable = null;
          this.onstop = null;
        }

        start() {
          this.state = 'recording';
        }

        stop() {
          this.state = 'inactive';
          this.ondataavailable?.({ data: new Blob(['e2e-audio'], { type: this.mimeType }) });
          this.onstop?.();
        }
      }
      Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: E2EMediaRecorder });
      URL.createObjectURL = () => 'blob:e2e-recording';
      URL.revokeObjectURL = () => {};
    });

    await authenticatedPage.getByRole('button', { name: 'Говорение', exact: true }).press('Enter');
    const speakingTask = authenticatedPage.getByRole('button', { name: /Чтение вслух/ });
    await speakingTask.waitFor({ state: 'visible', timeout: 5_000 });
    await speakingTask.press('Enter');
    await authenticatedPage.getByRole('button', { name: 'Начать подготовку' }).click();
    await authenticatedPage.getByRole('button', { name: 'Готово — к записи' }).click();
    await authenticatedPage.getByRole('button', { name: 'Стоп — закончить запись' }).click();
    await authenticatedPage.getByText('Запись готова!').waitFor({ state: 'visible', timeout: 5_000 });
    await authenticatedPage.getByRole('button', { name: 'Удалить запись' }).waitFor({ state: 'visible' });
    console.log('e2e: successful speaking recording completed');

    await authenticatedPage.getByRole('button', { name: 'К заданиям', exact: true }).click({ force: true });
    await authenticatedPage.evaluate(() => { window.__e2eMicrophoneMode = 'denied'; });
    await authenticatedPage.getByRole('button', { name: /Чтение вслух/ }).press('Enter');
    await authenticatedPage.getByRole('button', { name: 'Начать подготовку' }).click();
    await authenticatedPage.getByRole('button', { name: 'Готово — к записи' }).click();
    const microphoneToast = authenticatedPage.locator('#toast');
    await microphoneToast.waitFor({ state: 'visible', timeout: 5_000 });
    assert.match(await microphoneToast.innerText(), /Нет доступа к микрофону/);
    await authenticatedPage.getByRole('button', { name: 'Начать подготовку' }).waitFor({ state: 'visible' });
    console.log('e2e: microphone denial handled without losing the task');

    await authenticatedPage.getByRole('button', { name: '← К заданиям' }).click();
    await authenticatedPage.getByRole('button', { name: 'Главная' }).click();
    const profileButton = authenticatedPage.locator('#scr1.on [role="button"][aria-label="Профиль"]');
    assert.equal(await profileButton.count(), 1);
    await profileButton.press('Enter');
    console.log('e2e: profile opened by keyboard');
    const privacySheet = authenticatedPage.locator('#privacySheet.open');
    if (await privacySheet.count()) {
      await authenticatedPage.getByRole('button', { name: 'Сохранить выбор' }).click();
      await privacySheet.waitFor({ state: 'hidden', timeout: 5_000 });
    }
    const logoutButton = authenticatedPage.locator('#scr11.on').getByRole('button', { name: 'Выйти', exact: true });
    await logoutButton.waitFor({ state: 'visible', timeout: 5_000 });
    await logoutButton.click({ timeout: 5_000 });
    await authenticatedPage.getByRole('button', { name: 'Попробовать демо' }).waitFor({ state: 'visible', timeout: 5_000 });
    assert.equal((await authenticatedContext.cookies()).some((cookie) => cookie.name === 'eb_token'), false);
    await authenticatedContext.close();

    const expiredContext = await browser.newContext(contextOptions());
    await expiredContext.addCookies([{
      name: 'eb_token',
      value: jwt.sign({ u: 'expireduser' }, jwtSecret, { expiresIn: '1h' }),
      url: baseUrl,
      httpOnly: true,
      sameSite: 'Lax',
    }]);
    const expiredPage = await expiredContext.newPage();
    await expiredPage.goto(baseUrl, { waitUntil: 'networkidle' });
    const paywall = expiredPage.locator('#pw_ov');
    await paywall.waitFor({ state: 'visible', timeout: 5_000 });
    assert.match(await paywall.innerText(), /Чтобы заниматься, оформи доступ/);
    const botLink = paywall.getByRole('link', { name: 'Открыть Telegram-бот' });
    assert.match(await botLink.getAttribute('href'), /^https:\/\/t\.me\//);
    console.log('e2e: expired subscription shows recovery path');
    await expiredContext.close();

    const viewportMatrix = [
      { width: 320, height: 568 },
      { width: 375, height: 667 },
      { width: 390, height: 844 },
      { width: 430, height: 932 },
      { width: 768, height: 1024 },
      { width: 1024, height: 768 },
      { width: 1440, height: 900 },
    ];
    for (const viewport of viewportMatrix) {
      const viewportContext = await browser.newContext(contextOptions({ viewport }));
      const viewportPage = await viewportContext.newPage();
      await viewportPage.goto(baseUrl, { waitUntil: 'networkidle' });
      await viewportPage.getByRole('button', { name: 'Попробовать демо' }).click();
      await viewportPage.locator('#scr1.on').waitFor({ state: 'visible', timeout: 5_000 });
      const layout = await viewportPage.evaluate(() => {
        const frame = document.querySelector('#frame').getBoundingClientRect();
        const activeScreen = document.querySelector('.screen.on').getBoundingClientRect();
        const interactive = [...document.querySelectorAll('.screen.on button, .screen.on a, .screen.on input, .screen.on textarea, .screen.on [role="button"]')]
          .filter((element) => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
          })
          .map((element) => {
            const rect = element.getBoundingClientRect();
            return {
              label: element.getAttribute('aria-label') || element.textContent?.trim().slice(0, 40) || element.id,
              width: rect.width,
              height: rect.height,
            };
          });
        const homeScroll = document.querySelector('#scr1 .homeScroll');
        const homeNav = document.querySelector('#scr1 .navclay');
        homeScroll.scrollTop = homeScroll.scrollHeight;
        const lastContent = homeScroll.lastElementChild.getBoundingClientRect();
        const navigation = homeNav.getBoundingClientRect();
        return {
          viewportWidth: window.innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          frameWidth: frame.width,
          frameLeft: frame.left,
          frameRight: frame.right,
          screenLeft: activeScreen.left,
          screenRight: activeScreen.right,
          undersized: interactive.filter((item) => item.width < 44 || item.height < 44),
          lastContentBottom: lastContent.bottom,
          navigationTop: navigation.top,
        };
      });
      assert.ok(layout.documentWidth <= layout.viewportWidth);
      assert.ok(layout.frameLeft >= -0.5 && layout.frameRight <= layout.viewportWidth + 0.5);
      assert.ok(layout.screenLeft >= -0.5 && layout.screenRight <= layout.viewportWidth + 0.5);
      assert.ok(layout.frameWidth <= 720, `content line length is too wide at ${viewport.width}px`);
      assert.deepEqual(layout.undersized, [], `undersized controls at ${viewport.width}px`);
      assert.ok(layout.lastContentBottom <= layout.navigationTop, `content overlaps navigation at ${viewport.width}px`);
      await viewportContext.close();
    }
    console.log('e2e: responsive matrix 320–1440 px has no horizontal overflow');
  } finally {
    if (browser) await browser.close();
    if (child) await stopProcess(child);
    if (fakeProviderWss) await new Promise((resolve) => fakeProviderWss.close(resolve));
    if (fakeProviderServer) await new Promise((resolve) => fakeProviderServer.close(resolve));
    if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

runE2E()
  .then(() => console.log(`e2e: ${browserEngine}/${browserProfile} critical user flows passed`))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
