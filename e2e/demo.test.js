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
import { createActiveSubscriptionPage } from './browser-server-harness.js';
import { GRAMMAR_CATALOG } from '../public/grammar-catalog.js';

const grammarItemsById = new Map(Object.values(GRAMMAR_CATALOG.bank).flatMap(levels => (
  ['c', 'c2', 'f', 'correction', 'transform'].flatMap(kind => levels[kind] || [])
)).map(item => [item.id, item]));

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
            policy_version: '2026-08-26-vk-id-v1',
            updated_at: Date.now(),
          },
        },
        expireduser: { created: Date.now(), sub_until: Date.now() - 60_000 },
      },
      progress: {
        e2euser: { words: { known: 0 } },
        expireduser: {},
      },
      speaking_accent_profiles: {
        e2euser: {
          username: 'e2euser', locale: 'en-GB', revision: 1, source: 'manual',
          effective_at: '2026-08-06T00:00:00.000Z', calibration_used: false,
        },
      },
      speaking_calibration_consents: {
        expireduser: {
          granted: true,
          age_group: 'adult',
          guardian_confirmed: false,
          policy_version: 'speaking-calibration-consent-v1',
          granted_at: new Date(Date.now() - 60_000).toISOString(),
          revoked_at: null,
          updated_at: new Date(Date.now() - 60_000).toISOString(),
        },
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
    await page.locator('#scr5.on[data-access-state="no-session"]').waitFor({ state: 'visible', timeout: 5_000 });
    assert.equal(await page.getByRole('button', { name: 'Попробовать демо' }).count(), 0);
    assert.equal(await page.locator('#scr1.on').count(), 0);
    console.log('e2e: no session stays outside the learning shell');
    await context.close();

    const unknownContext=await browser.newContext(contextOptions({serviceWorkers:'block'}));
    await unknownContext.route('**/api/v1/me',route=>route.abort('internetdisconnected'));
    const unknownPage=await unknownContext.newPage();
    await unknownPage.goto(baseUrl,{waitUntil:'networkidle'});
    const unknownGate=unknownPage.locator('#access_gate[data-state="network-unknown"]');
    await unknownGate.waitFor({state:'visible',timeout:5_000});
    assert.match(await unknownGate.innerText(),/Не удалось проверить доступ/u);
    assert.equal(await unknownPage.locator('#scr1.on').count(),0);
    console.log('e2e: unknown network state is not presented as an inactive subscription');
    await unknownContext.close();

    // The initial cookie refresh and a newer identity transition must be ordered. Otherwise a
    // delayed /me response can restore the old cookie after logout and reopen the shell.
    const raceHarness=await createActiveSubscriptionPage(browser,{
      baseUrl,username:'e2euser',jwtSecret,contextOptions:contextOptions({serviceWorkers:'block'}),
    });
    const raceContext=raceHarness.context;
    const racePage=raceHarness.page;
    let releaseInitialSession;
    let initialSessionReached;
    const initialSessionReady=new Promise(resolve=>{initialSessionReached=resolve});
    const releaseInitialSessionResponse=new Promise(resolve=>{releaseInitialSession=resolve});
    let delayedInitialSession=true;
    await racePage.route('**/api/v1/me',async route=>{
      if(!delayedInitialSession){await route.continue();return}
      delayedInitialSession=false;
      const response=await route.fetch();initialSessionReached();await releaseInitialSessionResponse;
      await route.fulfill({response});
    });
    let logoutRequests=0;
    racePage.on('request',request=>{if(request.url().endsWith('/api/v1/logout'))logoutRequests++});
    await racePage.goto(baseUrl,{waitUntil:'load'});
    await initialSessionReady;
    const logoutFinished=racePage.evaluate(()=>window.logout()).catch(()=>null);
    await racePage.waitForTimeout(150);
    assert.equal(logoutRequests,0,'logout waits for the initial session refresh instead of racing it');
    releaseInitialSession();
    await racePage.waitForRequest(request=>request.url().endsWith('/api/v1/logout'),{timeout:5_000});
    await logoutFinished;
    await racePage.locator('#scr5.on[data-access-state="no-session"]').waitFor({state:'visible',timeout:5_000});
    assert.equal(await racePage.locator('#scr1.on').count(),0);
    console.log('e2e: auth transitions are serialized behind initial session restore');
    await raceContext.close();

    const profileRaceHarness=await createActiveSubscriptionPage(browser,{
      baseUrl,username:'e2euser',jwtSecret,contextOptions:contextOptions({serviceWorkers:'block'}),
    });
    const profileRaceContext=profileRaceHarness.context;
    const profileRacePage=profileRaceHarness.page;
    await profileRacePage.goto(baseUrl,{waitUntil:'networkidle'});
    await profileRacePage.locator('#scr1.on').waitFor({state:'visible',timeout:5_000});
    let releaseProfileRefresh;
    let profileRefreshReached;
    const profileRefreshReady=new Promise(resolve=>{profileRefreshReached=resolve});
    const releaseProfileRefreshResponse=new Promise(resolve=>{releaseProfileRefresh=resolve});
    await profileRacePage.route('**/api/v1/me',async route=>{
      const response=await route.fetch();profileRefreshReached();await releaseProfileRefreshResponse;
      await route.fulfill({response});
    });
    let profileLogoutRequests=0;
    profileRacePage.on('request',request=>{if(request.url().endsWith('/api/v1/logout'))profileLogoutRequests++});
    const profileRefreshFinished=profileRacePage.evaluate(()=>window.ebMe()).catch(()=>null);
    await profileRefreshReady;
    const profileLogoutFinished=profileRacePage.evaluate(()=>window.logout()).catch(()=>null);
    await profileRacePage.waitForTimeout(150);
    assert.equal(profileLogoutRequests,0,'logout waits for an in-flight profile session refresh');
    releaseProfileRefresh();
    await profileRacePage.waitForRequest(request=>request.url().endsWith('/api/v1/logout'),{timeout:5_000});
    await Promise.all([profileRefreshFinished,profileLogoutFinished]);
    await profileRacePage.locator('#scr5.on[data-access-state="no-session"]').waitFor({state:'visible',timeout:5_000});
    assert.equal(await profileRacePage.locator('#scr1.on').count(),0);
    console.log('e2e: profile session refresh is serialized before logout');
    await profileRaceContext.close();

    const authenticatedHarness=await createActiveSubscriptionPage(browser,{
      baseUrl,username:'e2euser',jwtSecret,contextOptions:contextOptions({serviceWorkers:'block'}),
    });
    const authenticatedContext=authenticatedHarness.context;
    const authenticatedPage=authenticatedHarness.page;
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
    const persisted = await authenticatedPage.evaluate(async () => {
      const marker = window.EasyBoostStore.readCurrentOwner();
      return (await fetch('/api/v1/progress', {
        headers: { 'X-EasyBoost-Expected-Owner': marker.owner },
      })).json();
    });
    assert.equal(persisted.words.known, 1);
    console.log('e2e: progress persisted after reload');

    // A local snapshot may support an already-open active session, but it is never permission to
    // start the learning shell when the server cannot confirm access.
    const snapshot = await authenticatedPage.evaluate(() => {
      const marker = window.EasyBoostStore.readCurrentOwner();
      const state = window.EasyBoostStore.loadLocal(marker.owner, marker.ownerGeneration);
      state.learned = 42;
      state.prog.words = 63;
      state.prog.read = 55;
      state.streak = 7;
      window.EasyBoostStore.saveLocal(marker.owner, state, marker.ownerGeneration);
      return window.EasyBoostStore.loadLocal(marker.owner, marker.ownerGeneration).learned;
    });
    assert.equal(snapshot, 42, 'the running app keeps a local snapshot for offline continuity');
    await authenticatedContext.setOffline(true);
    await authenticatedPage.evaluate(() => window.startApp());
    await authenticatedPage.locator('#access_gate[data-state="network-unknown"]').waitFor({ state: 'visible', timeout: 5_000 });
    assert.equal(await authenticatedPage.locator('#scr1.on').count(), 0);
    assert.equal(await authenticatedPage.evaluate(() => { const marker = window.EasyBoostStore.readCurrentOwner();
      return window.EasyBoostStore.loadLocal(marker.owner, marker.ownerGeneration).learned; }), 42);
    console.log('e2e: saved progress is not treated as offline access permission');

    await authenticatedContext.setOffline(false);
    await authenticatedPage.evaluate(() => window.pwCheck());
    await authenticatedPage.locator('#scr1.on').waitFor({ state: 'visible', timeout: 5_000 });

    await authenticatedContext.setOffline(true);
    await authenticatedPage.getByRole('button', { name: 'Начать практику', exact: true }).press('Enter');
    await authenticatedPage.locator('#scr2.on').waitFor({ state: 'visible', timeout: 5_000 });
    await authenticatedPage.getByRole('heading', { name: 'Познакомься со словом' }).waitFor();
    await authenticatedPage.getByRole('button', { name: 'Начать вспоминать' }).click();
    await authenticatedPage.getByRole('heading', { name: 'Выбери значение' }).waitFor();
    assert.ok(await authenticatedPage.locator('#w_opts .vocab-choice').count() >= 2);
    await authenticatedPage.evaluate(() => window.tab('scr1'));
    await authenticatedPage.locator('#scr1.on').waitFor({ state: 'visible', timeout: 5_000 });
    await authenticatedPage.evaluate(() => window.nav('scr3'));
    await authenticatedPage.locator('#scr3.on').waitFor({ state: 'visible', timeout: 5_000 });
    assert.ok(await authenticatedPage.locator('#g_area button').count() >= 1);
    await authenticatedPage.evaluate(() => {
      window.S.gram = { 1: { st: 2, ok: 8, err: 1, sr: 4, rs: 0, due: Date.now() + 86_400_000 } };
      delete window.S.grammarMastery;
      window.tab('scr1');
      window.tab('scr3');
    });
    const migratedGrammarTopic = authenticatedPage.locator('#g_area button').filter({ hasText: 'Present Simple' }).first();
    await migratedGrammarTopic.waitFor({ state: 'visible', timeout: 5_000 });
    assert.match(await migratedGrammarTopic.innerText(), /ИЗУЧЕНО/u);
    assert.doesNotMatch(await migratedGrammarTopic.innerText(), /ЗАКРЕПЛЕНА/u);
    assert.equal(await authenticatedPage.evaluate(() => window.S.grammarMastery[1].stage), 'learned');
    console.log('e2e: built-in word and grammar tasks work offline');
    await authenticatedContext.setOffline(false);

    // Grammar 2.0 keeps only stable item IDs in the owner-bound in-progress snapshot. Opening
    // the rule before an answer freezes the whole session as assisted, including after reload.
    await migratedGrammarTopic.click();
    await authenticatedPage.getByRole('button', { name: 'Начать практику' }).click();
    const assistedBeforeReload = await authenticatedPage.evaluate(() => ({
      currentId: window.S.grammarRunner.queue[window.S.grammarRunner.i].id,
      sessionId: window.S.grammarRunner.sessionId,
      queue: window.S.grammarRunner.queue,
    }));
    assert.equal(assistedBeforeReload.queue.length, 16);
    assert.equal(new Set(assistedBeforeReload.queue.map(item => item.id)).size, 16);
    assert.doesNotMatch(JSON.stringify(await authenticatedPage.evaluate(() => window.S.grammarRunner)), /"(?:ans|o|a)"\s*:/u,
      'the reload snapshot contains pointers, not answer keys');
    await authenticatedPage.getByRole('button', { name: 'ПРАВИЛО', exact: true }).click();
    assert.equal(await authenticatedPage.evaluate(() => window.S.grammarRunner.masteryAssisted), true);
    await authenticatedPage.waitForTimeout(750);
    await authenticatedPage.reload({ waitUntil: 'networkidle' });
    await authenticatedPage.locator('#scr1.on').waitFor({ state: 'visible', timeout: 5_000 });
    await authenticatedPage.evaluate(() => window.nav('scr3'));
    await authenticatedPage.locator('#scr3.on').waitFor({ state: 'visible', timeout: 5_000 });
    const assistedAfterReload = await authenticatedPage.evaluate(() => ({
      currentId: window.S.grammarRunner.queue[window.S.grammarRunner.i].id,
      sessionId: window.S.grammarRunner.sessionId,
      masteryAssisted: window.S.grammarRunner.masteryAssisted,
    }));
    assert.deepEqual(assistedAfterReload, {
      currentId: assistedBeforeReload.currentId,
      sessionId: assistedBeforeReload.sessionId,
      masteryAssisted: true,
    });
    await authenticatedPage.evaluate(() => window.gToThemes());

    // A fresh run exercises all four levels. The first wrong answer must create a different,
    // previously unreserved item with the same server-owned weakness metadata; disclosing the
    // correct answer makes this whole continued run assisted and unable to advance mastery.
    const pastTopic = authenticatedPage.locator('#g_area button').filter({ hasText: 'Past Simple и Continuous' }).first();
    await pastTopic.click();
    await authenticatedPage.getByRole('button', { name: 'Начать практику' }).click();
    await authenticatedPage.locator('#g_card[aria-live="polite"]').waitFor({ state: 'visible' });
    for (const reducedMotion of ['no-preference', 'reduce']) {
      await authenticatedPage.emulateMedia({ reducedMotion });
      for (const width of [320, 375, 768, 1440]) {
        await authenticatedPage.setViewportSize({ width, height: 900 });
        assert.equal(await authenticatedPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true,
          `grammar runner has no horizontal overflow at ${width}px (${reducedMotion})`);
        const ruleSamples = await authenticatedPage.locator('#g_rule_btn').evaluate(async button => {
        if (document.fonts?.ready) await document.fonts.ready;
        const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
        await nextFrame();
        await nextFrame();
        const measure = () => {
          const box = button.getBoundingClientRect();
          const computed = getComputedStyle(button);
          return {
            width: box.width,
            height: box.height,
            minHeight: computed.minHeight,
            minBlockSize: computed.minBlockSize,
            display: computed.display,
            flexShrink: computed.flexShrink,
            boxSizing: computed.boxSizing,
          };
        };
        const samples = [measure()];
        await nextFrame();
        samples.push(measure());
        await nextFrame();
        samples.push(measure());
          return samples;
        });
        ruleSamples.forEach((ruleTarget, sampleIndex) => {
          assert.ok(ruleTarget.width >= 44 && ruleTarget.height >= 44,
            `the rule button keeps a stable 44px keyboard/touch target at ${width}px/${reducedMotion} (sample ${sampleIndex + 1}): ${JSON.stringify(ruleTarget)}`);
          assert.equal(ruleTarget.flexShrink, '0');
          assert.equal(ruleTarget.boxSizing, 'border-box');
        });
      }
    }
    await authenticatedPage.emulateMedia({ reducedMotion: 'no-preference' });
    await authenticatedPage.setViewportSize({ width: 1280, height: 720 });
    await authenticatedPage.keyboard.press('Tab');
    assert.equal(await authenticatedPage.evaluate(() => document.activeElement?.tagName === 'BUTTON'), true,
      'native runner controls are keyboard focusable');

    const failedPointer = await authenticatedPage.evaluate(() => {
      const snapshot = window.S.grammarRunner;
      const current = snapshot.queue[snapshot.i];
      return { id: current.id, sessionId: snapshot.sessionId, initialIds: snapshot.queue.map(item => item.id) };
    });
    const failedQuestion = grammarItemsById.get(failedPointer.id);
    const wrong = failedQuestion.diagnostics.findIndex(Boolean);
    const failedDiagnostic = failedQuestion.diagnostics[wrong];
    assert.ok(wrong >= 0 && wrong !== failedQuestion.a && failedDiagnostic);
    assert.doesNotMatch(await authenticatedPage.locator('#g_area').innerHTML(), /diagnostic\.|confusion_pair|word_order/u,
      'unanswered UI does not leak distractor diagnostics');
    const pickProbe = await authenticatedPage.evaluate(index => {
      const buttons = document.querySelectorAll('#g_btns button');
      const button = buttons[index];
      const before = { count: buttons.length, done: button?.dataset.done ?? null, text: button?.textContent ?? null };
      window.gPick(button, index);
      return { ...before, doneAfter: button?.dataset.done ?? null };
    }, wrong);
    assert.equal(pickProbe.count, failedQuestion.o.length);
    assert.equal(pickProbe.done, null);
    assert.equal(pickProbe.text, failedQuestion.o[wrong]);
    assert.equal(pickProbe.doneAfter, '1', 'the active gPick handler must consume the option');
    const failedAudit = {
      ...failedPointer,
      diagnosticId: failedDiagnostic.id,
      errorSkill: failedDiagnostic.errorCode,
      confusionPair: failedDiagnostic.confusionPair,
      transferPair: failedQuestion.transferPair,
    };
    const committedWrong = await authenticatedPage.evaluate(() => {
      const snapshot = window.S.grammarRunner;
      const topicId = String(snapshot.topicId);
      return {
        sessionId: snapshot.sessionId,
        i: snapshot.i,
        done: snapshot.done,
        ok: snapshot.ok,
        phase: snapshot.phase,
        originalId: snapshot.queue[snapshot.i].id,
        errorSkill: snapshot.errorReasons[topicId] ?? null,
        confusionPair: snapshot.confusionPairs[topicId] ?? null,
        diagnosticId: snapshot.itemOutcomes.at(-1)?.diagnosticId ?? null,
        transferId: snapshot.queue[snapshot.i + 1].id,
        transfer: snapshot.queue[snapshot.i + 1].transfer,
      };
    });
    assert.deepEqual(committedWrong, {
      sessionId: failedPointer.sessionId,
      i: 0,
      done: 1,
      ok: 0,
      phase: 'explain',
      originalId: failedAudit.id,
      errorSkill: failedAudit.errorSkill,
      confusionPair: failedAudit.confusionPair ?? null,
      diagnosticId: failedAudit.diagnosticId,
      transferId: committedWrong.transferId,
      transfer: true,
    }, 'the wrong result and unseen transfer are committed synchronously before the explanation timer');

    await authenticatedPage.reload({ waitUntil: 'networkidle' });
    await authenticatedPage.locator('#scr1.on').waitFor({ state: 'visible', timeout: 5_000 });
    await authenticatedPage.evaluate(() => window.nav('scr3'));
    await authenticatedPage.locator('#scr3.on').waitFor({ state: 'visible', timeout: 5_000 });
    await authenticatedPage.getByText('РАЗБОР ОШИБКИ', { exact: true }).waitFor({ state: 'visible', timeout: 5_000 });
    assert.equal(await authenticatedPage.locator('#g_card[aria-live="polite"]').count(), 1,
      'the restored answer explanation is announced');
    const restoredWrong = await authenticatedPage.evaluate(() => {
      const snapshot = window.S.grammarRunner;
      const topicId = String(snapshot.topicId);
      return {
        sessionId: snapshot.sessionId,
        i: snapshot.i,
        done: snapshot.done,
        ok: snapshot.ok,
        phase: snapshot.phase,
        originalId: snapshot.queue[snapshot.i].id,
        errorSkill: snapshot.errorReasons[topicId] ?? null,
        confusionPair: snapshot.confusionPairs[topicId] ?? null,
        diagnosticId: snapshot.itemOutcomes.at(-1)?.diagnosticId ?? null,
        transferId: snapshot.queue[snapshot.i + 1].id,
        transfer: snapshot.queue[snapshot.i + 1].transfer,
      };
    });
    assert.deepEqual(restoredWrong, committedWrong,
      'an immediate reload restores the exact wrong result, error and inserted transfer pointer');
    const transferPointer = { id: restoredWrong.transferId, transfer: restoredWrong.transfer };
    const transferQuestion = grammarItemsById.get(transferPointer.id);
    const transferAudit = {
      ...transferPointer,
      wasInitiallyReserved: failedAudit.initialIds.includes(transferPointer.id),
      transferPair: transferQuestion.transferPair,
      supportsWeakness: transferQuestion.diagnostics.some(diagnostic => diagnostic
        && diagnostic.errorCode === failedAudit.errorSkill
        && (diagnostic.confusionPair ?? null) === (failedAudit.confusionPair ?? null)),
    };
    assert.notEqual(transferAudit.id, failedAudit.id);
    assert.equal(transferAudit.transfer, true);
    assert.equal(transferAudit.wasInitiallyReserved, false);
    assert.equal(transferAudit.transferPair, failedAudit.transferPair);
    assert.equal(transferAudit.supportsWeakness, true);
    await authenticatedPage.getByRole('button', { name: 'Понятно, дальше' }).click();
    const transferLevel = authenticatedPage.locator(`#g_card [data-grammar-level="${transferQuestion.type}"]`);
    await transferLevel.waitFor({ state: 'visible' });
    assert.match(await transferLevel.innerText(), /ТРАНСФЕР/u);

    const completedTypes = new Set();
    const failedTypes = new Set(['choice']);
    const pendingTransferTypes = new Set(['choice']);
    const renderedTransferTypes = new Set();
    for (let guard = 0; guard < 28; guard += 1) {
      if (!await authenticatedPage.evaluate(() => Boolean(window.S.grammarRunner))) break;
      const pointer = await authenticatedPage.evaluate(() => {
        const snapshot = window.S.grammarRunner;
        return snapshot.queue[snapshot.i];
      });
      if (!pointer) break;
      const question = grammarItemsById.get(pointer.id);
      if (pointer.transfer) {
        assert.equal(pendingTransferTypes.has(question.type), true,
          `${question.type} transfer immediately follows its failed original`);
        const renderedLevel = authenticatedPage.locator(`#g_card [data-grammar-level="${question.type}"]`);
        await renderedLevel.waitFor({ state: 'visible', timeout: 2_500 });
        assert.match(await renderedLevel.innerText(), /ТРАНСФЕР/u);
        renderedTransferTypes.add(question.type);
        pendingTransferTypes.delete(question.type);
      } else if (!failedTypes.has(question.type)) {
        const beforeIds = await authenticatedPage.evaluate(() => window.S.grammarRunner.queue.map(item => item.id));
        const wrongAnswer = question.type === 'choice' ? question.diagnostics.findIndex(Boolean) : '__definitely_wrong__';
        const chosenDiagnostic = question.type === 'choice' ? question.diagnostics[wrongAnswer] : null;
        await authenticatedPage.evaluate(({ type, answer }) => {
          if (type === 'choice') window.gPick(document.querySelectorAll('#g_btns button')[answer], answer);
          else {
            const input = document.getElementById('g_inp');
            input.value = answer;
            window.gSubmit();
          }
        }, { type: question.type, answer: wrongAnswer });
        const wrongState = await authenticatedPage.evaluate(() => {
          const snapshot = window.S.grammarRunner;
          return {
            phase: snapshot.phase,
            outcome: snapshot.itemOutcomes.at(-1),
            transfer: snapshot.queue[snapshot.i + 1],
          };
        });
        assert.equal(wrongState.phase, 'explain');
        assert.equal(wrongState.outcome.type, question.type);
        assert.equal(wrongState.outcome.correct, false);
        assert.equal(wrongState.outcome.diagnosticId, chosenDiagnostic?.id ?? null);
        assert.equal(wrongState.outcome.errorCode, chosenDiagnostic?.errorCode ?? question.errorSkill);
        assert.equal(wrongState.outcome.confusionPair,
          chosenDiagnostic ? chosenDiagnostic.confusionPair ?? null : question.confusionPair ?? null);
        assert.equal(wrongState.transfer.transfer, true);
        assert.equal(beforeIds.includes(wrongState.transfer.id), false,
          `${question.type} receives an unseen authored transfer`);
        const transfer = grammarItemsById.get(wrongState.transfer.id);
        assert.equal(transfer.type, question.type);
        assert.equal(transfer.transferPair, question.transferPair);
        failedTypes.add(question.type);
        pendingTransferTypes.add(question.type);
        completedTypes.add(question.type);
        const explanationButton = authenticatedPage.locator('button[onclick="gAfterExplain()"]');
        await explanationButton.waitFor({ state: 'visible', timeout: 2_500 });
        assert.equal(await authenticatedPage.locator('#g_card[aria-live="polite"]').count(), 1);
        await explanationButton.click();
        continue;
      }
      await authenticatedPage.evaluate(({ type, answer }) => {
        if (type === 'choice') {
          window.gPick(document.querySelectorAll('#g_btns button')[answer], answer);
        } else {
          const input = document.getElementById('g_inp');
          input.value = answer;
          window.gSubmit();
        }
      }, { type: question.type, answer: question.type === 'choice' ? question.a : question.ans[0] });
      completedTypes.add(question.type);
      await authenticatedPage.waitForTimeout(700);
    }
    assert.deepEqual([...completedTypes].sort(), ['choice', 'correction', 'input', 'transform']);
    assert.deepEqual([...failedTypes].sort(), ['choice', 'correction', 'input', 'transform']);
    assert.deepEqual([...renderedTransferTypes].sort(), ['choice', 'correction', 'input', 'transform']);
    assert.equal(pendingTransferTypes.size, 0);
    await authenticatedPage.getByText('Подход завершён', { exact: true }).waitFor({ state: 'visible', timeout: 5_000 });
    assert.doesNotMatch(await authenticatedPage.locator('#g_area').innerText(), /Изучено/u);
    const assistedGrammar = await authenticatedPage.evaluate(async () => {
      const marker = window.EasyBoostStore.readCurrentOwner();
      const response = await fetch('/api/v1/progress', { headers: { 'X-EasyBoost-Expected-Owner': marker.owner } });
      return response.json();
    });
    assert.equal(assistedGrammar.grammarMastery['2'].stage, 'not_started');
    assert.equal(assistedGrammar.grammarMastery['2'].masteryHistory.at(-1).outcome, 'recorded');
    assert.equal(assistedGrammar.grammarMastery['2'].masteryHistory.at(-1).session.assisted, true);
    assert.equal(assistedGrammar.grammarMastery['2'].masteryHistory.at(-1).session.id, failedPointer.sessionId);
    assert.equal(assistedGrammar.grammarMastery['2'].masteryHistory.at(-1).session.items.length, 20);
    assert.ok(Number.isSafeInteger(assistedGrammar.grammarMastery['2'].masteryHistory.at(-1).session.endedAt));

    // Only a distinct fresh session completed without any disclosure may advance the topic.
    await authenticatedPage.getByRole('button', { name: 'Ещё подход', exact: true }).click();
    const cleanSessionId = await authenticatedPage.evaluate(() => window.S.grammarRunner.sessionId);
    assert.notEqual(cleanSessionId, failedPointer.sessionId);
    const cleanTypes = new Set();
    for (let guard = 0; guard < 20; guard += 1) {
      if (!await authenticatedPage.evaluate(() => Boolean(window.S.grammarRunner))) break;
      const current = await authenticatedPage.evaluate(() => {
        const snapshot = window.S.grammarRunner;
        return { pointer: snapshot.queue[snapshot.i], last: snapshot.i === snapshot.queue.length - 1 };
      });
      const pointer = current.pointer;
      const question = grammarItemsById.get(pointer.id);
      if (current.last) {
        await authenticatedPage.evaluate(() => {
          const nativeFetch = window.fetch.bind(window);
          window.fetch = function stalledMasteryFetch(input, init) {
            const url = typeof input === 'string' ? input : input?.url || '';
            if (String(url).includes('/api/v1/grammar/mastery-events')
              && String(init?.method || 'GET').toUpperCase() === 'POST') return new Promise(() => {});
            return nativeFetch(input, init);
          };
        });
      }
      await authenticatedPage.evaluate(({ type, answer }) => {
        if (type === 'choice') window.gPick(document.querySelectorAll('#g_btns button')[answer], answer);
        else {
          const input = document.getElementById('g_inp');
          input.value = answer;
          window.gSubmit();
        }
      }, { type: question.type, answer: question.type === 'choice' ? question.a : question.ans[0] });
      cleanTypes.add(question.type);
      await authenticatedPage.waitForTimeout(current.last ? 1_000 : 700);
      if (current.last) break;
    }
    assert.deepEqual([...cleanTypes].sort(), ['choice', 'correction', 'input', 'transform']);
    const pendingCompletion = await authenticatedPage.evaluate(() => {
      const snapshot = window.S.grammarRunner;
      return {
        phase: snapshot?.phase,
        i: snapshot?.i,
        queueLength: snapshot?.queue?.length,
        eventId: snapshot?.completionEvent?.id,
        itemCount: snapshot?.completionEvent?.session?.items?.length,
        locallyQueued: window.EasyBoostSync.pendingGrammarMasteryEvents()
          .some(entry => entry.event?.id === snapshot?.completionEvent?.id),
      };
    });
    assert.deepEqual(pendingCompletion, {
      phase: 'completion_pending', i: 16, queueLength: 16,
      eventId: cleanSessionId, itemCount: 16, locallyQueued: true,
    }, 'the exact completion event is durable before the async server response');
    await authenticatedPage.locator('#g_card[role="status"][aria-live="polite"]').waitFor({ state: 'visible' });
    // Crash boundary: reload while the exact completion event is locally durable but its POST is stalled.
    await authenticatedPage.reload({ waitUntil: 'domcontentloaded' });
    await authenticatedPage.locator('#scr1.on').waitFor({ state: 'visible', timeout: 5_000 });
    await authenticatedPage.evaluate(() => window.nav('scr3'));
    await authenticatedPage.locator('#scr3.on').waitFor({ state: 'visible', timeout: 5_000 });
    // Recovery boundary: the restored completion_pending snapshot retries the same UUID and clears on apply/replay.
    await authenticatedPage.waitForTimeout(1_500);
    const recoveredCompletion = await authenticatedPage.evaluate(eventId => ({
      runnerCleared: window.S.grammarRunner === null,
      pendingSameEvent: window.EasyBoostSync.pendingGrammarMasteryEvents()
        .some(entry => entry.event?.id === eventId),
      stage: window.S.grammarMastery?.['2']?.stage,
      historyHasEvent: window.S.grammarMastery?.['2']?.masteryHistory?.some(entry => entry.eventId === eventId),
    }), cleanSessionId);
    assert.deepEqual(recoveredCompletion, {
      runnerCleared: true, pendingSameEvent: false, stage: 'learned', historyHasEvent: true,
    });
    const authoritativeGrammar = await authenticatedPage.evaluate(async () => {
      const marker = window.EasyBoostStore.readCurrentOwner();
      const response = await fetch('/api/v1/progress', { headers: { 'X-EasyBoost-Expected-Owner': marker.owner } });
      return response.json();
    });
    assert.equal(authoritativeGrammar.grammarMastery['2'].stage, 'learned');
    assert.deepEqual(authoritativeGrammar.grammarMastery['2'].masteryHistory.map(entry => entry.outcome), ['recorded', 'advanced']);
    assert.equal(authoritativeGrammar.grammarMastery['2'].masteryHistory.at(-1).session.id, cleanSessionId);
    assert.equal(authoritativeGrammar.grammarMastery['2'].masteryHistory.at(-1).session.assisted, false);
    assert.equal(authoritativeGrammar.grammarMastery['2'].masteryHistory.at(-1).session.items.length, 16);
    await authenticatedPage.waitForTimeout(750);
    await authenticatedPage.reload({ waitUntil: 'networkidle' });
    await authenticatedPage.locator('#scr1.on').waitFor({ state: 'visible', timeout: 5_000 });
    await authenticatedPage.evaluate(() => window.nav('scr3'));
    await authenticatedPage.locator('#scr3.on').waitFor({ state: 'visible', timeout: 5_000 });
    assert.equal(await authenticatedPage.evaluate(() => window.S.grammarRunner), null,
      'a completed runner snapshot cannot resurrect after server reload');
    assert.match(await authenticatedPage.locator('#g_area button').filter({ hasText: 'Past Simple и Continuous' }).first().innerText(), /ИЗУЧЕНО/u);
    // A delayed explanation callback from an abandoned run cannot replace or advance a new run.
    const abandonedPointer = await authenticatedPage.evaluate(() => {
      window.gStart(3);
      const snapshot = window.S.grammarRunner;
      return snapshot.queue[snapshot.i].id;
    });
    const abandonedQuestion = grammarItemsById.get(abandonedPointer);
    assert.equal(abandonedQuestion.type, 'choice');
    await authenticatedPage.evaluate(index => window.gPick(document.querySelectorAll('#g_btns button')[index], index),
      (abandonedQuestion.a + 1) % abandonedQuestion.o.length);
    const replacementSession = await authenticatedPage.evaluate(() => {
      window.gToThemes();
      window.gStart(4);
      const snapshot = window.S.grammarRunner;
      return {
        sessionId: snapshot.sessionId,
        i: snapshot.i,
        done: snapshot.done,
        phase: snapshot.phase,
        currentId: snapshot.queue[snapshot.i].id,
        queueIds: snapshot.queue.map(item => item.id),
      };
    });
    await authenticatedPage.waitForTimeout(1_050);
    assert.deepEqual(await authenticatedPage.evaluate(() => {
      const snapshot = window.S.grammarRunner;
      return {
        sessionId: snapshot.sessionId,
        i: snapshot.i,
        done: snapshot.done,
        phase: snapshot.phase,
        currentId: snapshot.queue[snapshot.i].id,
        queueIds: snapshot.queue.map(item => item.id),
      };
    }), replacementSession, 'a stale explanation timer cannot mutate its replacement session');
    const correctAbandonedId = await authenticatedPage.evaluate(() => {
      window.gStart(3);
      return window.S.grammarRunner.queue[0].id;
    });
    const correctAbandoned = grammarItemsById.get(correctAbandonedId);
    assert.equal(correctAbandoned.type, 'choice');
    const replacementAfterCorrect = await authenticatedPage.evaluate(answer => {
      window.gPick(document.querySelectorAll('#g_btns button')[answer], answer);
      window.gStart(4);
      const snapshot = window.S.grammarRunner;
      return {
        sessionId: snapshot.sessionId,
        i: snapshot.i,
        done: snapshot.done,
        phase: snapshot.phase,
        currentId: snapshot.queue[snapshot.i].id,
        queueIds: snapshot.queue.map(item => item.id),
      };
    }, correctAbandoned.a);
    await authenticatedPage.waitForTimeout(750);
    assert.deepEqual(await authenticatedPage.evaluate(() => {
      const snapshot = window.S.grammarRunner;
      return {
        sessionId: snapshot.sessionId,
        i: snapshot.i,
        done: snapshot.done,
        phase: snapshot.phase,
        currentId: snapshot.queue[snapshot.i].id,
        queueIds: snapshot.queue.map(item => item.id),
      };
    }), replacementAfterCorrect, 'a stale correct-answer timer cannot advance its replacement session');
    await authenticatedPage.evaluate(() => window.gToThemes());
    console.log('e2e: Grammar 2.0 reload, transfer, four levels and authoritative learned stage work');

    await authenticatedPage.evaluate(() => window.tab('scr1'));

    await authenticatedPage.evaluate(() => window.nav('scr8'));
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
      const recovery = await (await fetch('/api/v1/voice-tutor/recovery-map', { headers: { 'X-EasyBoost-Expected-Owner': 'e2euser' } })).json();
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
      const recovery = await (await fetch('/api/v1/voice-tutor/recovery-map', { headers: { 'X-EasyBoost-Expected-Owner': 'e2euser' } })).json();
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
      const recovery = await (await fetch('/api/v1/voice-tutor/recovery-map', { headers: { 'X-EasyBoost-Expected-Owner': 'e2euser' } })).json();
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
            const track = { readyState: 'live', stop() {} };
            return { getAudioTracks: () => [track], getTracks: () => [track] };
          },
        },
      });
      Object.defineProperty(window, 'AudioContext', { configurable: true, value: undefined });
      Object.defineProperty(window, 'webkitAudioContext', { configurable: true, value: undefined });
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

    await authenticatedPage.evaluate(() => window.nav('scr9'));
    const speakingTask = authenticatedPage.getByRole('button', { name: /Чтение вслух/ });
    await speakingTask.waitFor({ state: 'visible', timeout: 5_000 });
    await speakingTask.press('Enter');
    await authenticatedPage.getByRole('button', { name: 'Проверить микрофон' }).click();
    await authenticatedPage.getByText(/Микрофон готов/).waitFor({ state: 'visible', timeout: 5_000 });
    await authenticatedPage.getByRole('button', { name: 'Начать подготовку' }).click();
    await authenticatedPage.getByRole('button', { name: 'Готово — к записи' }).click();
    await authenticatedPage.getByRole('button', { name: 'Стоп — закончить запись' }).click();
    await authenticatedPage.getByText('Запись готова!').waitFor({ state: 'visible', timeout: 5_000 });
    await authenticatedPage.getByRole('button', { name: 'Удалить запись' }).waitFor({ state: 'visible' });
    console.log('e2e: successful speaking recording completed');

    await authenticatedPage.getByRole('button', { name: 'К заданиям', exact: true }).click({ force: true });
    await authenticatedPage.evaluate(() => { window.__e2eMicrophoneMode = 'denied'; });
    await authenticatedPage.getByRole('button', { name: /Чтение вслух/ }).press('Enter');
    await authenticatedPage.getByRole('button', { name: 'Проверить микрофон' }).click();
    const microphoneToast = authenticatedPage.locator('#toast');
    await microphoneToast.waitFor({ state: 'visible', timeout: 5_000 });
    assert.match(await microphoneToast.innerText(), /Нет доступа к микрофону/);
    await authenticatedPage.getByRole('button', { name: 'Начать подготовку' }).waitFor({ state: 'visible' });
    console.log('e2e: microphone denial handled without losing the task');

    await authenticatedPage.getByRole('button', { name: '← К заданиям' }).click();
    await authenticatedPage.getByRole('button', { name: 'Назад в раздел Сегодня', exact: true }).press('Enter');
    await authenticatedPage.locator('#scr1.on').waitFor({ state: 'visible', timeout: 5_000 });
    assert.equal(
      await authenticatedPage.evaluate(() => document.activeElement === document.getElementById('scr1')),
      true,
      'deep back should move focus to the Today content',
    );
    const profileButton = authenticatedPage.locator('#aisy-shell-nav').getByRole('button', { name: 'Профиль', exact: true });
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
    await Promise.all([
      authenticatedPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15_000 }),
      logoutButton.click({ timeout: 5_000 }),
    ]);
    await authenticatedPage.locator('#scr5.on[data-access-state="no-session"]').waitFor({ state: 'visible', timeout: 5_000 });
    assert.equal(await authenticatedPage.getByRole('button', { name: 'Попробовать демо' }).count(), 0);
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
    const paywall = expiredPage.locator('#access_gate[data-state="inactive"]');
    await paywall.waitFor({ state: 'visible', timeout: 5_000 });
    assert.equal(await expiredPage.locator('#scr5').evaluate(element=>element.inert),true);
    assert.equal(await expiredPage.evaluate(()=>document.activeElement?.id),'access_gate_retry');
    await expiredPage.keyboard.press('Tab');
    assert.equal(await expiredPage.evaluate(()=>document.activeElement?.closest('#access_gate')?.id),'access_gate');
    assert.match(await paywall.innerText(), /Нужен активный доступ/);
    assert.equal(await expiredPage.locator('#scr1.on').count(), 0);
    await paywall.getByRole('button', { name: 'Повторить проверку' }).waitFor({ state: 'visible' });
    assert.equal(await paywall.getByRole('link', { name: 'Открыть Telegram-бот' }).count(), 0);
    await paywall.getByRole('button', { name: 'Настройки приватности и данных' }).click();
    const expiredPrivacy = expiredPage.locator('#privacySheet.open');
    await expiredPrivacy.waitFor({ state: 'visible', timeout: 5_000 });
    const revokeCalibration = expiredPrivacy.getByRole('button', {
      name: 'Отозвать согласие и удалить незавершённые аудиозаписи',
    });
    await revokeCalibration.waitFor({ state: 'visible', timeout: 5_000 });
    await revokeCalibration.click();
    await expiredPrivacy.getByText('Согласие отозвано; незавершённые аудиозаписи удалены.')
      .waitFor({ state: 'visible' });
    assert.equal(await expiredPage.evaluate(async()=>{
      const payload=await (await fetch('/api/v1/speaking/calibration-consent')).json();
      return payload.consent.granted;
    }),false);
    await expiredPrivacy.getByRole('button', { name: 'Позже' }).click();
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
      const viewportHarness=await createActiveSubscriptionPage(browser,{
        baseUrl,username:'e2euser',jwtSecret,contextOptions:contextOptions({viewport}),
      });
      const viewportContext=viewportHarness.context;
      const viewportPage=viewportHarness.page;
      await viewportPage.goto(baseUrl, { waitUntil: 'networkidle' });
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
        const homeNav = document.querySelector('#aisy-shell-nav');
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
          navigationRight: navigation.right,
          navigationIsRail: navigation.height > navigation.width,
        };
      });
      assert.ok(layout.documentWidth <= layout.viewportWidth);
      assert.ok(layout.frameLeft >= -0.5 && layout.frameRight <= layout.viewportWidth + 0.5);
      assert.ok(layout.screenLeft >= -0.5 && layout.screenRight <= layout.viewportWidth + 0.5);
      assert.ok(layout.frameWidth <= 720, `content line length is too wide at ${viewport.width}px`);
      assert.deepEqual(layout.undersized, [], `undersized controls at ${viewport.width}px`);
      if (layout.navigationIsRail) {
        assert.ok(layout.screenLeft >= layout.navigationRight, `content overlaps navigation rail at ${viewport.width}px`);
      } else {
        assert.ok(layout.lastContentBottom <= layout.navigationTop, `content overlaps navigation at ${viewport.width}px`);
      }
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
