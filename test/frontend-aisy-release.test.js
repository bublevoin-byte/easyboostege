import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import test from 'node:test';

const packageJson = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('the default and dedicated release gates run the real Aisy learner contour', async () => {
  for (const script of ['test:e2e', 'test:e2e:aisy']) {
    assert.match(packageJson.scripts[script],
      /node e2e\/aisy-accessibility\.test\.js.*node e2e\/aisy-learner-release\.test\.js.*node e2e\/aisy-progress-profile\.test\.js/u,
      `${script} must keep accessibility, full learner flow and Progress/Profile proof in order`);
  }
  for (const script of ['test:e2e', 'test:e2e:aisy', 'test:e2e:writing-paper']) {
    assert.match(packageJson.scripts[script],
      /node e2e\/aisy-writing-paper\.test\.js.*node e2e\/aisy-writing-offline-cache\.test\.js/u,
      `${script} must keep the online Writing matrix and offline cache proof in order`);
  }
});

test('the learner release runtime fails closed around providers and network errors', async () => {
  const {
    createReleaseNetworkGuard, createReleaseServerEnvironment, prepareReleaseBrowserBoundary,
  } = await import(
    '../e2e/aisy-learner-release-safety.js'
  );
  const environment = createReleaseServerEnvironment({ PORT: '4321' }, {
    XAI_ENABLED: 'true',
    XAI_API_KEY: 'inherited-xai-secret',
    XAI_API_URL: 'https://provider.invalid/xai',
    XAI_RULE_SEARCH_URL: 'https://provider.invalid/search',
    XAI_VOICE_REALTIME_URL: 'wss://provider.invalid/voice',
    GROQ_ENABLED: 'true',
    GROQ_API_KEY: 'inherited-groq-secret',
    GROQ_API_URL: 'https://provider.invalid/groq',
    AZURE_SPEECH_KEY: 'inherited-azure-secret',
  });
  assert.equal(environment.PORT, '4321');
  for (const key of ['XAI_API_KEY', 'GROQ_API_KEY', 'AZURE_SPEECH_KEY']) {
    assert.equal(environment[key], '', `${key} must never reach the release child`);
  }
  assert.equal(environment.XAI_ENABLED, 'false');
  assert.equal(environment.GROQ_ENABLED, 'false');
  assert.equal(environment.VOICE_TUTOR_ENABLED, 'false');
  for (const key of [
    'XAI_API_URL', 'XAI_RULE_SEARCH_URL', 'XAI_VOICE_REALTIME_URL', 'GROQ_API_URL',
  ]) assert.match(environment[key], /^(?:http|ws):\/\/127\.0\.0\.1:9\//u);

  const guard = createReleaseNetworkGuard({
    allowedHttpResponses: [{ method: 'GET', path: '/empty', status: 404 }],
  });
  guard.recordConsoleError('Failed to load resource: online asset');
  guard.recordConsoleError('Unexpected application error');
  guard.recordHttpResponse('GET', '/empty', 404);
  guard.setOffline(true);
  guard.recordConsoleError('Failed to load resource: expected offline request');
  guard.recordRequestFailure('GET', '/offline', 'net::ERR_INTERNET_DISCONNECTED');
  guard.recordHttpResponse('GET', '/offline', 503);
  guard.setOffline(false);
  guard.recordRequestFailure('GET', '/missing.js', 'net::ERR_FAILED');
  guard.recordHttpResponse('GET', '/broken', 500);
  assert.deepEqual(guard.failures, [
    'console: Unexpected application error',
    'requestfailed: GET /missing.js (net::ERR_FAILED)',
    'http: GET /broken -> 500',
  ]);

  const firstPage = new EventEmitter();
  const browserContext = new EventEmitter();
  browserContext.pages = () => [firstPage];
  const hermeticRoutes = [];
  browserContext.route = async (routePattern, handler) => hermeticRoutes.push({ routePattern, handler });
  const browserGuards = await prepareReleaseBrowserBoundary(browserContext, {
    applicationOrigin: 'http://127.0.0.1:4321', networkGuard: guard,
  });
  assert.deepEqual(hermeticRoutes.map(({ routePattern }) => routePattern), ['**/*']);
  const routeOutcomes = [];
  const fakeRoute = (url) => ({
    request: () => ({ url: () => url }),
    continue: async () => routeOutcomes.push('continue'),
    fulfill: async () => routeOutcomes.push('fulfill'),
    abort: async () => routeOutcomes.push('abort'),
  });
  await hermeticRoutes[0].handler(fakeRoute('http://127.0.0.1:4321/app.js'));
  await hermeticRoutes[0].handler(fakeRoute('https://fonts.googleapis.com/css2?family=Manrope'));
  await hermeticRoutes[0].handler(fakeRoute('https://analytics.invalid/collect?token=private'));
  assert.deepEqual(routeOutcomes, ['continue', 'fulfill', 'abort']);
  const crossTab = new EventEmitter();
  browserContext.emit('page', crossTab);
  crossTab.emit('pageerror', new Error('cross-tab failed'));
  crossTab.emit('console', {
    type: () => 'error', text: () => 'cross-tab console failed',
  });
  crossTab.emit('websocket', { url: () => 'wss://provider.invalid/realtime?ticket=private' });
  browserContext.emit('request', {
    method: () => 'POST', url: () => 'https://api.x.ai/v1/responses?token=private',
  });
  assert.deepEqual(browserGuards.browserFailures, ['pageerror: cross-tab failed']);
  assert.equal(guard.failures.at(-1), 'console: cross-tab console failed');
  assert.deepEqual(browserGuards.paidBoundaryCalls, [
    'WS wss://provider.invalid', 'POST https://api.x.ai',
  ]);

  const privateGuard = createReleaseNetworkGuard();
  privateGuard.recordRequestFailure(
    'GET', '/api/v1/ege-mocks/attempts/11111111-2222-4333-8444-555555555555/result?ticket=private',
    'failed token=private',
  );
  assert.deepEqual(privateGuard.failures, [
    'requestfailed: GET /api/v1/ege-mocks/attempts/:id/result (failed token=<redacted>)',
  ]);

  const offlineGuard = createReleaseNetworkGuard();
  offlineGuard.setOffline(true);
  offlineGuard.recordRequestFailure(
    'GET', 'https://analytics.invalid/collect?token=private', 'blocked token=private',
    { external: true },
  );
  offlineGuard.recordConsoleError(
    'provider failed https://api.x.ai/v1/responses?ticket=private',
  );
  assert.deepEqual(offlineGuard.failures, [
    'requestfailed: GET https://analytics.invalid (blocked token=<redacted>)',
    'console: provider failed https://api.x.ai',
  ]);
});

test('the Aisy UX operations contract keeps release evidence bounded and local', async () => {
  const operations = await fs.readFile(new URL('../docs/AISY_UX_OPERATIONS.md', import.meta.url), 'utf8');
  for (const requirement of [
    /Сегодня.*Практика.*ЕГЭ.*Прогресс.*Профиль/su,
    /150\s*КБ/iu,
    /reload.*offline.*cross-tab/isu,
    /npm run test:e2e:aisy/u,
    /npm run test:e2e:performance/u,
    /npm run security:secrets/u,
    /npm run security:history/u,
    /git diff --check/u,
    /не.*deploy|deploy.*не/iu,
    /не содержит.*username|username.*не/iu,
  ]) assert.match(operations, requirement);
});
