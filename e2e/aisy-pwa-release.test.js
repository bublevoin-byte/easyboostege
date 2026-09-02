import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { availablePort, chromeExecutable } from './browser-server-harness.js';
import {
  PREDECESSOR_COMMIT,
  buildExactPredecessorFixture,
  compatibilityArtifactDirectory,
  settleCleanupOperations,
  verifyPredecessorArtifactAgainstFixture,
  verifyPredecessorCompatibility,
} from '../scripts/pwa-predecessor-compat.js';
import { consumePosixReleaseMaintenanceBinding } from
  '../scripts/posix-release-maintenance-scope.js';

const projectDirectory = fileURLToPath(new URL('..', import.meta.url));
const predecessorMaintenanceBinding = process.platform === 'linux'
  ? consumePosixReleaseMaintenanceBinding({
    checkoutDirectory: projectDirectory,
    lane: 'pwa-predecessor',
  })
  : undefined;
const candidateDirectory = path.join(projectDirectory, 'dist', 'public');
const candidateAssetManifest = JSON.parse(
  await fs.readFile(path.join(candidateDirectory, 'asset-manifest.json'), 'utf8'),
);
const manifest = JSON.parse(await fs.readFile(path.join(candidateDirectory, 'manifest.json'), 'utf8'));
const candidateWorker = await fs.readFile(path.join(candidateDirectory, 'service-worker.js'), 'utf8');
const sourceWorker = await fs.readFile(path.join(projectDirectory, 'public', 'service-worker.js'), 'utf8');
const releaseMatch = /const RELEASE_VERSION='(sha256-[a-f0-9]{64})';/u.exec(candidateWorker);
assert.ok(releaseMatch, 'built service worker must expose its content-addressed release id');
const candidateRelease = releaseMatch[1];
const candidateCacheName = `easyboost-static-${candidateRelease}`;
const candidateClientStateCache = `easyboost-pwa-client-state-v1-easyboost-static-${candidateRelease}`;
const candidateStablePaths = ['/manifest.json', '/theme-prepaint.js', '/icon-maskable-512.png'];
const candidateStableDigests = Object.fromEntries(await Promise.all(candidateStablePaths.map(async (webPath) => [
  webPath, sha256(await fs.readFile(path.join(candidateDirectory, webPath.slice(1)))),
])));
function workerPathArray(workerSource, declaration) {
  const match = new RegExp(`const ${declaration}=(\\[[^\\]]*\\]);`, 'u').exec(workerSource);
  assert.ok(match, `service worker must declare ${declaration}`);
  return JSON.parse(match[1].replaceAll("'", '"'));
}
const sourceEgeExecPaths = workerPathArray(sourceWorker, 'EGE_MOCK_EXEC_PATHS');
const expectedBuiltEgeExecPaths = [...new Set(sourceEgeExecPaths.map((sourcePath) => {
  const moduleName = sourcePath.startsWith('/shared/')
    ? `../shared/${sourcePath.slice('/shared/'.length)}` : sourcePath.slice(1);
  const emitted = candidateAssetManifest.modules[moduleName];
  assert.ok(emitted, `candidate manifest must map EGE source module ${sourcePath}`);
  return `/${emitted}`;
}))].sort();
const builtEgeExecPaths = workerPathArray(candidateWorker, 'EGE_MOCK_EXEC_PATHS').sort();
assert.deepEqual(builtEgeExecPaths, expectedBuiltEgeExecPaths,
  'built worker must contain the exact source-derived EGE executable closure');
const candidateEgeExecCache = `easyboost-ege-mock-exec-v1-${candidateCacheName}-${builtEgeExecPaths.join('|')
  .split('').reduce((hash, character) => Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0,
    2166136261).toString(36)}`;
const candidateEgeExecDigests = {};
for (const webPath of builtEgeExecPaths) {
  const name = webPath.slice(1);
  const content = await fs.readFile(path.join(candidateDirectory, name));
  assert.deepEqual(candidateAssetManifest.assets[name], {
    bytes: content.length, sha256: sha256(content),
  }, `${webPath} must be hash/length verified by the candidate asset manifest`);
  candidateEgeExecDigests[webPath] = sha256(content);
}

assert.equal(candidateAssetManifest.releaseVersion, candidateRelease,
  'asset manifest and worker release ids must agree');
assert.equal(manifest.orientation, 'any');
assert.equal(manifest.background_color, '#fff9f3');
assert.equal(manifest.theme_color, '#b9433a');
assert.deepEqual(manifest.icons.filter((icon) => icon.type === 'image/png').map((icon) => ({
  src: icon.src, sizes: icon.sizes, purpose: icon.purpose,
})), [
  { src: '/icon-192.png', sizes: '192x192', purpose: 'any' },
  { src: '/icon-512.png', sizes: '512x512', purpose: 'any' },
  { src: '/icon-maskable-512.png', sizes: '512x512', purpose: 'maskable' },
]);
assert.match(candidateWorker, /const CACHE_NAME='easyboost-static-'\+RELEASE_VERSION/u);
assert.doesNotMatch(JSON.stringify(candidateAssetManifest), /prototypes\//u);

function pngDimensions(buffer) {
  assert.deepEqual([...buffer.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}
assert.deepEqual(pngDimensions(await fs.readFile(path.join(candidateDirectory, 'icon-192.png'))),
  { width: 192, height: 192 });
assert.deepEqual(pngDimensions(await fs.readFile(path.join(candidateDirectory, 'icon-512.png'))),
  { width: 512, height: 512 });
assert.deepEqual(pngDimensions(await fs.readFile(path.join(candidateDirectory, 'icon-maskable-512.png'))),
  { width: 512, height: 512 });

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'], ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'], ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'], ['.svg', 'image/svg+xml'], ['.webp', 'image/webp'],
  ['.woff2', 'font/woff2'], ['.mp3', 'audio/mpeg'], ['.txt', 'text/plain; charset=utf-8'],
]);

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

let predecessorFixture = null;
let server = null;
let browser = null;
let context = null;
let closeContext = null;
let installabilityContext = null;
let installabilityProfile = null;
let primaryFailure = null;
try {
predecessorFixture = await buildExactPredecessorFixture({
  projectDirectory,
  commit: PREDECESSOR_COMMIT,
  posixReleaseMaintenanceBinding: predecessorMaintenanceBinding,
});
const predecessorDirectory = predecessorFixture.distDirectory;
const predecessorAssetManifest = JSON.parse(
  await fs.readFile(path.join(predecessorDirectory, 'asset-manifest.json'), 'utf8'),
);
const predecessorCompatibility = await verifyPredecessorCompatibility({
  directory: compatibilityArtifactDirectory(projectDirectory, PREDECESSOR_COMMIT),
  expectedCommit: PREDECESSOR_COMMIT,
});
const predecessorProvenance = await verifyPredecessorArtifactAgainstFixture({
  fixtureDirectory: predecessorDirectory,
  artifactDirectory: compatibilityArtifactDirectory(projectDirectory, PREDECESSOR_COMMIT),
  expectedCommit: PREDECESSOR_COMMIT,
});
assert.equal(predecessorProvenance.filesCompared, 26);
assert.equal(predecessorProvenance.rawBytesCompared, 26);
assert.equal(predecessorProvenance.cacheName, predecessorCompatibility.cacheName);
assert.equal(predecessorProvenance.contentSha256, predecessorCompatibility.contentSha256);
assert.deepEqual(candidateAssetManifest.predecessorCompatibility, predecessorCompatibility,
  'candidate manifest must expose the exact verified predecessor contract');

const candidateEmittedPaths = new Set(
  Object.values(candidateAssetManifest.modules).map((name) => `/${name}`),
);
const predecessorShellOverlap = predecessorCompatibility.files
  .filter((file) => candidateAssetManifest.shell.includes(file.path))
  .map(({ path: webPath, bytes, sha256: digest }) => ({ path: webPath, bytes, sha256: digest }));
assert.deepEqual(predecessorShellOverlap, [
  {
    path: '/assets/asya-assistant-1Lybndln.js',
    bytes: 14642,
    sha256: 'f2a2e4371e15daa72b46777eb4fe61b4a694a7f3bf573f8a6603947db380d176',
  },
  {
    path: '/assets/reading-catalog-contract-HSvgPmNc.js',
    bytes: 13036,
    sha256: '518cc358031b6c9b8a61b615a03515395effe4e5001b6cd6a999280bfcbb8414',
  },
], 'only the two digest-identical current emissions may overlap the predecessor graph and APP_SHELL');
assert.equal(predecessorShellOverlap.every((file) => candidateEmittedPaths.has(file.path)), true,
  'every safe APP_SHELL overlap must be emitted by the current build');
for (const file of predecessorShellOverlap) {
  assert.deepEqual(candidateAssetManifest.assets[file.path.slice(1)], {
    bytes: file.bytes, sha256: file.sha256,
  }, `${file.path} must be byte-identical in the candidate asset manifest`);
}
const compatibilityOutsideShell = predecessorCompatibility.files
  .filter((file) => !candidateAssetManifest.shell.includes(file.path));
assert.equal(compatibilityOutsideShell.length, 24,
  'all compatibility entries except the exact two current shell overlaps must stay outside APP_SHELL');
const predecessorOnlyFiles = predecessorCompatibility.files
  .filter((file) => !candidateEmittedPaths.has(file.path));
assert.equal(predecessorOnlyFiles.length, 16);
assert.equal(predecessorOnlyFiles.every((file) => !candidateAssetManifest.shell.includes(file.path)), true,
  'no predecessor-only executable may enter the current clean-install APP_SHELL');

const predecessorSpeakingName = predecessorAssetManifest.modules['screens/speaking.js'];
const candidateSpeakingName = candidateAssetManifest.modules['screens/speaking.js'];
assert.match(predecessorSpeakingName, /^assets\/speaking-[^/]+\.js$/u);
assert.match(candidateSpeakingName, /^assets\/speaking-[^/]+\.js$/u);
assert.notEqual(predecessorSpeakingName, candidateSpeakingName,
  'the upgrade proof needs genuinely different predecessor and candidate lazy URLs');
const predecessorSpeakingPath = `/${predecessorSpeakingName}`;
const predecessorSpeakingBytes = await fs.readFile(path.join(predecessorDirectory, predecessorSpeakingName));
const packagedSpeakingBytes = await fs.readFile(path.join(candidateDirectory, predecessorSpeakingName));
const candidateSpeakingBytes = await fs.readFile(path.join(candidateDirectory, candidateSpeakingName));
assert.deepEqual(packagedSpeakingBytes, predecessorSpeakingBytes,
  'candidate must package the exact old lazy bytes at the exact old hashed URL');
assert.notEqual(sha256(predecessorSpeakingBytes), sha256(candidateSpeakingBytes),
  'old hashed URL must not be silently mapped to candidate bytes');
assert.equal(
  predecessorCompatibility.files.find((file) => file.path === predecessorSpeakingPath)?.sha256,
  sha256(predecessorSpeakingBytes),
  'compatibility manifest must digest the real predecessor Speaking chunk',
);

let generation = 'predecessor';
const port = await availablePort();
const origin = `http://127.0.0.1:${port}`;
const learner = 'pwa-release-learner';
function sendJson(response, status, payload, { owner = false } = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0',
    Pragma: 'no-cache', Expires: '0',
    ...(owner ? { 'X-EasyBoost-Response-Owner': learner } : {}),
  });
  response.end(JSON.stringify(payload));
}

server = http.createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, origin).pathname);
    const route = pathname.toLocaleLowerCase('en-US');
    if (route === '/health/live') return sendJson(response, 200, { status: 'ok', source: 'fresh-network' });
    if (route === '/health/ready') {
      return sendJson(response, 200, { status: 'ready', storage: 'fixture', source: 'fresh-network' });
    }
    if (route === '/api/v1/auth/providers') return sendJson(response, 200, { vk: { enabled: false } });
    if (route === '/api/v1/me') return sendJson(response, 200, {
      authenticated: true, username: learner, displayName: 'Fresh network learner', role: 'student',
      active: true, sub_until: Date.now() + 86_400_000,
      features: { adaptive_learning: false }, entitlements: { voice_tutor: false },
    }, { owner: true });
    if (route === '/api/v1/progress') return sendJson(response, 200, {}, { owner: true });
    if (route === '/api/v1/speaking/accent-profile') return sendJson(response, 200, {
      profile: { locale: 'en-GB' }, calibration: null,
    }, { owner: true });
    if (route === '/api/v1/speaking/calibration-consent') return sendJson(response, 200, {
      consent: null,
    }, { owner: true });
    if (route === '/api/v1/speaking/task-1/sessions' && request.method === 'POST') {
      return sendJson(response, 201, {
        id: '71100000-0000-4000-8000-000000000011',
        task: {
          id: 'speaking-pilot-v1.task1.community-garden', revision: 1, taskType: 1,
          cefr: 'B1', topic: 'Город и природа', preparationSeconds: 90, responseSeconds: 90,
          maxScore: 1, instruction: 'Read aloud.', text: 'A server-owned reading text.',
        },
        pronunciationAssessment: {
          available: false, reason: 'provider_not_connected',
          message: 'Оценка произношения пока не подключена.',
        },
      }, { owner: true });
    }
    if (route.startsWith('/api/')) {
      return sendJson(response, 404, { error: { code: 'NOT_FOUND', message: 'fixture route is absent' } });
    }
    if (route === '/internal/metrics') {
      return sendJson(response, 200, { source: 'fresh-network', learner });
    }
    if (route === '/api' || route === '/internal') {
      return sendJson(response, 404, { error: { code: 'NOT_FOUND' }, source: 'fresh-network' });
    }

    const root = generation === 'predecessor' ? predecessorDirectory : candidateDirectory;
    const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = path.resolve(root, relative);
    const outside = path.relative(root, file);
    if (outside.startsWith('..') || path.isAbsolute(outside)) {
      response.writeHead(400).end();
      return;
    }
    const content = await fs.readFile(file);
    response.writeHead(200, {
      'Content-Type': contentTypes.get(path.extname(file)) || 'application/octet-stream',
      'Cache-Control': pathname === '/' || pathname === '/service-worker.js'
        ? 'no-store' : 'public, max-age=60',
      ...(pathname === '/service-worker.js' ? { 'Service-Worker-Allowed': '/' } : {}),
    });
    response.end(content);
  } catch (error) {
    if (error?.code === 'ENOENT') response.writeHead(404).end('not found');
    else response.writeHead(500).end('server error');
  }
});

async function workerVersion(page, workerExpression = 'controller') {
  return page.evaluate(async (expression) => {
    const registration = await navigator.serviceWorker.getRegistration();
    const worker = expression === 'waiting' ? registration?.waiting : navigator.serviceWorker.controller;
    if (!worker) return null;
    return new Promise((resolve, reject) => {
      const channel = new MessageChannel();
      const timeout = setTimeout(() => reject(new Error('worker version response timeout')), 5_000);
      channel.port1.onmessage = (event) => { clearTimeout(timeout); resolve(event.data); };
      worker.postMessage({ type: 'GET_RELEASE_VERSION' }, [channel.port2]);
    });
  }, workerExpression);
}

async function waitForCandidateWorker(page, expression = 'controller') {
  await page.waitForFunction(async ({ workerExpression, expected }) => {
    const registration = await navigator.serviceWorker.getRegistration();
    const worker = workerExpression === 'waiting' ? registration?.waiting : navigator.serviceWorker.controller;
    if (!worker) return false;
    return new Promise((resolve) => {
      const channel = new MessageChannel();
      const timeout = setTimeout(() => resolve(false), 250);
      channel.port1.onmessage = (event) => {
        clearTimeout(timeout);
        resolve(event.data?.releaseVersion === expected);
      };
      worker.postMessage({ type: 'GET_RELEASE_VERSION' }, [channel.port2]);
    });
  }, { workerExpression: expression, expected: candidateRelease }, { timeout: 30_000 });
}

async function openLearningApp(page, suffix = '') {
  await page.goto(`${origin}${suffix}`, { waitUntil: 'domcontentloaded' });
  await page.locator('#scr1.on').waitFor({ state: 'visible', timeout: 20_000 });
}

async function installReleaseInstrumentation(targetContext) {
  await targetContext.addInitScript(() => {
    try {
      localStorage.setItem('aisy.onboarding.completion', JSON.stringify({
        version: 1, completedAt: '2026-08-28T00:00:00.000Z',
      }));
      const loads = Number(sessionStorage.getItem('pwa-release-loads') || 0) + 1;
      sessionStorage.setItem('pwa-release-loads', String(loads));
      window.__pwaReleaseLoads = loads;
      window.__pwaUpdateEvents = 0;
      window.__pwaControllerChanges = 0;
      window.addEventListener('easyboost:update-ready', () => {
        window.__pwaUpdateEvents += 1;
      });
      navigator.serviceWorker?.addEventListener('controllerchange', () => {
        window.__pwaControllerChanges += 1;
      });
    } catch {}
  });
}

async function reloadIntoCandidateUpdateUi(page, label) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#scr1.on').waitFor({ state: 'visible', timeout: 20_000 });
  await waitForCandidateWorker(page, 'waiting');
  const notice = page.locator('#pwa_update:not([hidden])');
  await notice.waitFor({ state: 'visible', timeout: 20_000 });
  const apply = page.getByRole('button', { name: 'Обновить после задания', exact: true });
  await apply.waitFor({ state: 'visible' });
  await apply.focus();
  assert.equal(await apply.evaluate((button) => document.activeElement === button), true,
    `${label}: real candidate Apply must be keyboard-focusable under the predecessor controller`);
  assert.equal(await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return Boolean(registration?.waiting && registration.active
      && navigator.serviceWorker.controller === registration.active
      && navigator.serviceWorker.controller !== registration.waiting);
  }), true, `${label}: ordinary reload must keep the exact predecessor active/controller while candidate waits`);
  assert.equal(await page.evaluate(() => window.__pwaControllerChanges), 0,
    `${label}: ordinary reload must not synthesize a controller advancement`);
  return apply;
}

async function openDeepSkill(page, skill) {
  await page.locator('body[data-learning-access="active"]').waitFor({ state: 'attached', timeout: 20_000 });
  const practiceDestination = page.getByRole('navigation', { name: 'Основные разделы' })
    .getByRole('button', { name: 'Практика', exact: true });
  const practiceBack = page.getByRole('button', { name: 'Назад в раздел Практика', exact: true });
  if (await practiceDestination.isVisible()) await practiceDestination.press('Enter');
  else if (await practiceBack.isVisible()) await practiceBack.press('Enter');
  else {
    const state = await page.evaluate(() => ({
      activeScreen: document.querySelector('.screen.on')?.id || null,
      access: document.body.dataset.learningAccess || null,
      navigationHidden: document.getElementById('aisy-shell-nav')?.hidden,
      backHidden: document.getElementById('aisy-shell-back')?.hidden,
      backLabel: document.getElementById('aisy-shell-back')?.getAttribute('aria-label'),
    }));
    throw new Error(`No canonical Practice control in ${JSON.stringify(state)}`);
  }
  await page.locator('#aisy-practice.on').waitFor({ state: 'visible', timeout: 10_000 });
  await page.locator(`.practice-row[data-skill="${skill}"] button`).press('Enter');
  if (skill === 'speaking') {
    await page.locator('#scr9.on #speaking_pronunciation_status').waitFor({ state: 'visible', timeout: 15_000 });
    await page.getByRole('button', { name: /Чтение вслух/u }).press('Enter');
  }
  const selectors = {
    writing: '#scr8.on #writing_primary_action, #scr8.on #w_primary_action',
    reading: '#scr7.on #r_action_dock .aisy-button:not([hidden])',
    speaking: '#scr9.on #speaking_action_dock .speaking-action--primary:not([hidden])',
  };
  const cta = page.locator(selectors[skill]).first();
  await cta.waitFor({ state: 'visible', timeout: 15_000 });
  return cta;
}

async function assertUpdateDoesNotCoverCta(page, cta, label) {
  const geometry = await cta.evaluate((button) => {
    const rect = button.getBoundingClientRect();
    const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const dismiss = document.getElementById('pwa_update_dismiss');
    const updateApply = document.getElementById('pwa_update_apply');
    const dismissRect = dismiss.getBoundingClientRect();
    const updateApplyRect = updateApply.getBoundingClientRect();
    const updateApplyStyle = getComputedStyle(updateApply);
    const deepCtaStyle = getComputedStyle(button);
    const noticeRect = document.getElementById('pwa_update').getBoundingClientRect();
    const frameRect = document.getElementById('frame').getBoundingClientRect();
    return {
      hit: target === button || button.contains(target),
      cta: { top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height },
      notice: {
        top: noticeRect.top, right: noticeRect.right,
        bottom: noticeRect.bottom, left: noticeRect.left,
      },
      frame: {
        top: frameRect.top, right: frameRect.right,
        bottom: frameRect.bottom, left: frameRect.left, width: frameRect.width,
      },
      noticeInsideFrame: noticeRect.top >= frameRect.top - 0.5
        && noticeRect.right <= frameRect.right + 0.5
        && noticeRect.bottom <= frameRect.bottom + 0.5
        && noticeRect.left >= frameRect.left - 0.5,
      frameCentered: Math.abs((frameRect.left + frameRect.right) / 2 - innerWidth / 2) <= 1,
      dismiss: { width: dismissRect.width, height: dismissRect.height },
      updateApply: {
        width: updateApplyRect.width,
        height: updateApplyRect.height,
        updateApplySecondary: updateApply.classList.contains('aisy-button--secondary'),
        updateApplyBackground: updateApplyStyle.backgroundColor,
        deepCtaBackground: deepCtaStyle.backgroundColor,
      },
    };
  });
  assert.equal(geometry.hit, true,
    `${label}: waiting-update notice intercepts the real deep CTA ${JSON.stringify(geometry)}`);
  assert.ok(geometry.dismiss.width >= 44 && geometry.dismiss.height >= 44,
    `${label}: update snooze target is below 44px ${JSON.stringify(geometry.dismiss)}`);
  assert.ok(geometry.updateApply.width >= 44 && geometry.updateApply.height >= 44,
    label + ': update Apply target is below 44px ' + JSON.stringify(geometry.updateApply));
  assert.equal(geometry.updateApply.updateApplySecondary, true,
    label + ': update Apply must remain the Paper A secondary beside the deep-task CTA');
  assert.notEqual(geometry.updateApply.updateApplyBackground, geometry.updateApply.deepCtaBackground,
    label + ': update Apply visually duplicates the solid deep-task CTA '
      + JSON.stringify(geometry.updateApply));
  assert.equal(geometry.noticeInsideFrame, true,
    `${label}: waiting-update notice escaped the portrait frame ${JSON.stringify(geometry)}`);
  assert.equal(geometry.frameCentered, true,
    `${label}: portrait frame is not centered ${JSON.stringify(geometry.frame)}`);
  assert.ok(geometry.frame.width <= 390.5,
    `${label}: portrait frame exceeds its approved width ${JSON.stringify(geometry.frame)}`);
}

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', resolve);
});

  browser = await chromium.launch({ headless: true, executablePath: await chromeExecutable() });
  context = await browser.newContext({ viewport: { width: 375, height: 812 } });
  await installReleaseInstrumentation(context);

  const applyingPage = await context.newPage();
  await openLearningApp(applyingPage, '/?login_code=secret-sentinel#private-fragment');
  await applyingPage.waitForFunction(async () => {
    await navigator.serviceWorker.ready;
    return Boolean(navigator.serviceWorker.controller);
  }, null, { timeout: 30_000 });
  assert.equal(await applyingPage.evaluate(() => window.__pwaReleaseLoads), 1,
    'exact predecessor clean install must not reload the learner app');

  const lateConsentPage = await context.newPage();
  await openLearningApp(lateConsentPage);
  await openDeepSkill(lateConsentPage, 'writing');
  const draft = 'Несохранённый ответ ученика остаётся в реальном Writing editor.';
  await lateConsentPage.locator('#w_editor').fill(draft);
  await lateConsentPage.waitForFunction((expected) => {
    const editor = document.getElementById('w_editor');
    return Boolean(editor?.dataset.draftKey && window.S?.drafts?.[editor.dataset.draftKey] === expected);
  }, draft);
  assert.equal(await lateConsentPage.evaluate((oldPath) => (
    performance.getEntriesByType('resource').some((entry) => new URL(entry.name).pathname === oldPath)
  ), predecessorSpeakingPath), false, 'B must not have loaded predecessor Speaking before the upgrade');

  await applyingPage.evaluate(async () => {
    const sentinel = await caches.open('foreign-sentinel-cache-v1');
    await sentinel.put('/foreign-sentinel', new Response('must survive'));
  });
  assert.ok((await applyingPage.evaluate(() => caches.keys())).includes(predecessorCompatibility.cacheName));

  generation = 'candidate';
  await applyingPage.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  await applyingPage.waitForFunction(() => window.__pwaUpdateEvents > 0, null, { timeout: 40_000 });
  await applyingPage.getByText('Доступна новая версия Aisy.space. Обновите страницу.', { exact: true })
    .waitFor({ state: 'visible', timeout: 10_000 });
  await waitForCandidateWorker(applyingPage, 'waiting');
  assert.equal(await applyingPage.evaluate(() => window.__pwaReleaseLoads), 1,
    'waiting candidate must not reload predecessor A');
  assert.equal(await lateConsentPage.evaluate(() => window.__pwaReleaseLoads), 1,
    'waiting candidate must not reload predecessor B');
  const waitingCaches = await applyingPage.evaluate(() => caches.keys());
  assert.ok(waitingCaches.includes(predecessorCompatibility.cacheName));
  assert.ok(waitingCaches.includes(candidateCacheName));
  assert.ok(waitingCaches.includes('foreign-sentinel-cache-v1'));
  const waitingEgeCacheKeys = await applyingPage.evaluate(async (cacheName) => (
    (await (await caches.open(cacheName)).keys()).map((request) => new URL(request.url).pathname).sort()
  ), candidateEgeExecCache);
  assert.deepEqual(waitingEgeCacheKeys, builtEgeExecPaths,
    'waiting candidate must cache the exact emitted EGE executable closure before activation');

  const layoutViewports = [
    { width: 320, height: 720, label: '320 portrait' },
    { width: 720, height: 320, label: '320 landscape' },
    { width: 375, height: 812, label: '375 portrait' },
    { width: 812, height: 375, label: '375 landscape' },
    { width: 1440, height: 900, label: '1440 desktop' },
  ];
  for (const skill of ['writing', 'reading', 'speaking']) {
    const page = await context.newPage();
    await openLearningApp(page);
    const cta = await openDeepSkill(page, skill);
    await page.locator('#pwa_update:not([hidden])').waitFor({ state: 'visible', timeout: 15_000 });
    for (const viewport of layoutViewports) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await assertUpdateDoesNotCoverCta(page, cta, `${skill} · ${viewport.label}`);
    }
    await cta.focus();
    await page.getByRole('button', { name: 'Позже', exact: true }).focus();
    await page.keyboard.press('Enter');
    await page.locator('#pwa_update').waitFor({ state: 'hidden' });
    assert.equal(await cta.evaluate((button) => document.activeElement === button), true,
      `${skill}: keyboard snooze must restore the exact prior deep-task control`);
    assert.deepEqual(await workerVersion(page, 'waiting'), {
      releaseVersion: candidateRelease, cacheName: candidateCacheName,
    }, `${skill}: snooze must leave the candidate worker waiting`);
    await page.close();
  }

  const bodyOriginPage = await context.newPage();
  await openLearningApp(bodyOriginPage);
  await openDeepSkill(bodyOriginPage, 'reading');
  await bodyOriginPage.locator('#pwa_update:not([hidden])').waitFor({ state: 'visible', timeout: 15_000 });
  await bodyOriginPage.evaluate(() => {
    document.body.tabIndex = -1;
    document.body.focus();
    document.body.removeAttribute('tabindex');
  });
  assert.equal(await bodyOriginPage.evaluate(() => document.activeElement === document.body), true);
  const bodyOriginTraversal = [];
  for (let step = 0; step < 80; step += 1) {
    await bodyOriginPage.keyboard.press('Tab');
    const active = await bodyOriginPage.evaluate(() => ({
      id: document.activeElement?.id || null,
      tag: document.activeElement?.tagName || null,
    }));
    bodyOriginTraversal.push(active);
    if (active.id === 'pwa_update_dismiss') break;
  }
  assert.equal(bodyOriginTraversal.at(-1)?.id, 'pwa_update_dismiss',
    `body-origin keyboard traversal must reach the real Later control: ${JSON.stringify(bodyOriginTraversal)}`);
  await bodyOriginPage.keyboard.press('Tab');
  assert.equal(await bodyOriginPage.evaluate(() => document.activeElement?.id), 'pwa_update_apply',
    'keyboard traversal must continue from Later to the real Apply control');
  await bodyOriginPage.keyboard.press('Shift+Tab');
  assert.equal(await bodyOriginPage.evaluate(() => document.activeElement?.id), 'pwa_update_dismiss',
    'reverse traversal must return to the real Later control');
  await bodyOriginPage.keyboard.press('Enter');
  await bodyOriginPage.locator('#pwa_update').waitFor({ state: 'hidden' });
  const bodyOriginFocus = await bodyOriginPage.evaluate(() => ({
    id: document.activeElement?.id || null,
    tag: document.activeElement?.tagName || null,
    root: document.activeElement === document.body || document.activeElement === document.documentElement,
    inActiveScreen: Boolean(document.activeElement?.closest('.screen.on')),
  }));
  assert.deepEqual(bodyOriginFocus, { id: null, tag: 'MAIN', root: false, inActiveScreen: true },
    'body-origin keyboard snooze must use the deterministic active-screen control fallback');
  await bodyOriginPage.close();

  const consentFocusPage = await context.newPage();
  await openLearningApp(consentFocusPage);
  const consentFocusCta = await openDeepSkill(consentFocusPage, 'reading');
  await consentFocusPage.locator('#pwa_update:not([hidden])').waitFor({ state: 'visible', timeout: 15_000 });
  await consentFocusCta.focus();
  const focusApply = consentFocusPage.locator('#pwa_update_apply');
  await consentFocusPage.getByRole('button', { name: 'Обновить после задания', exact: true }).focus();
  await consentFocusPage.keyboard.press('Enter');
  await consentFocusPage.getByText(/перезагрузится автоматически/u).waitFor({ state: 'visible' });
  assert.equal(await consentFocusPage.getByRole('button', { name: 'Позже', exact: true }).isVisible(), false,
    'Later must disappear after this tab has already consented');
  assert.equal(await focusApply.isDisabled(), true);
  assert.equal(await focusApply.textContent(), 'Ждём другие вкладки');
  assert.equal(await consentFocusCta.evaluate((button) => document.activeElement === button), true,
    'Apply→WAITING must restore the exact prior deep-task focus target');
  await consentFocusPage.close();

  const applyingButton = await reloadIntoCandidateUpdateUi(applyingPage, 'A');
  assert.equal(await applyingPage.evaluate(() => window.__pwaReleaseLoads), 2,
    'A ordinary online reload must load candidate UI without activating the waiting worker');
  await applyingButton.press('Enter');
  await applyingPage.waitForFunction(async (stateCache) => {
    const keys = await (await caches.open(stateCache)).keys();
    return keys.filter((request) => new URL(request.url).pathname
      .startsWith('/__easyboost/pwa-consent-v1/')).length >= 2;
  }, candidateClientStateCache, { timeout: 15_000 });
  const markerPrivacy = await applyingPage.evaluate(async (stateCache) => {
    const cache = await caches.open(stateCache);
    const keys = (await cache.keys()).filter((request) => new URL(request.url).pathname
      .startsWith('/__easyboost/pwa-consent-v1/'));
    return {
      keys: keys.map((request) => request.url),
      bodies: await Promise.all(keys.map(async (request) => (await cache.match(request)).text())),
    };
  }, candidateClientStateCache);
  assert.ok(markerPrivacy.bodies.length >= 2);
  assert.equal(markerPrivacy.bodies.every((body) => body === candidateRelease), true);
  assert.doesNotMatch(JSON.stringify(markerPrivacy), /login_code|secret-sentinel|private-fragment/u,
    'client markers must never persist a private page URL, query or fragment');
  await waitForCandidateWorker(applyingPage, 'waiting');
  assert.equal(await applyingPage.evaluate(() => window.__pwaReleaseLoads), 2,
    'A consent alone must keep candidate UI under the predecessor until B consents or closes');
  assert.equal(await lateConsentPage.evaluate(() => window.__pwaReleaseLoads), 1,
    'A consent must not navigate or reload nonconsenting predecessor B');
  assert.equal(await lateConsentPage.evaluate(() => window.__pwaControllerChanges), 0,
    'B must remain controlled by its predecessor until B explicitly consents');
  assert.equal(await lateConsentPage.locator('#w_editor').inputValue(), draft,
    'A applying must not disturb B Writing draft');
  assert.ok((await applyingPage.evaluate(() => caches.keys())).includes(predecessorCompatibility.cacheName),
    'the exact predecessor cache must remain while B is still a predecessor document');

  await openDeepSkill(lateConsentPage, 'speaking');
  const predecessorResources = await lateConsentPage.evaluate(({ oldPath, candidatePath }) => ({
    oldLoaded: performance.getEntriesByType('resource')
      .some((entry) => new URL(entry.name).pathname === oldPath),
    candidateLoaded: performance.getEntriesByType('resource')
      .some((entry) => new URL(entry.name).pathname === candidatePath),
  }), { oldPath: predecessorSpeakingPath, candidatePath: `/${candidateSpeakingName}` });
  assert.deepEqual(predecessorResources, { oldLoaded: true, candidateLoaded: false },
    'snoozed B must execute its genuine unvisited predecessor chunk, never candidate bytes');
  assert.ok((await lateConsentPage.evaluate(() => caches.keys())).includes(predecessorCompatibility.cacheName));

  const lateConsentButton = await reloadIntoCandidateUpdateUi(lateConsentPage, 'B');
  assert.equal(await lateConsentPage.evaluate(() => window.__pwaReleaseLoads), 2,
    'B ordinary online reload must expose real candidate update UI under predecessor control');
  await context.setOffline(true);
  await lateConsentButton.press('Enter');
  try {
    await Promise.all([
      applyingPage.waitForFunction(() => window.__pwaReleaseLoads === 3, null, { timeout: 30_000 }),
      lateConsentPage.waitForFunction(() => window.__pwaReleaseLoads === 3, null, { timeout: 30_000 }),
    ]);
  } catch (error) {
    const activationState = await Promise.all([
      ['A', applyingPage], ['B', lateConsentPage],
    ].map(async ([label, page]) => page.evaluate(async ({ stateCache, pageLabel }) => {
      const registration = await navigator.serviceWorker?.getRegistration?.();
      const cache = globalThis.caches ? await caches.open(stateCache) : null;
      const paths = cache
        ? (await cache.keys()).map((request) => new URL(request.url).pathname) : [];
      const count = (prefix) => paths.filter((pathname) => pathname.startsWith(prefix)).length;
      return {
        label: pageLabel,
        loads: window.__pwaReleaseLoads,
        controllerChanges: window.__pwaControllerChanges,
        updateEvents: window.__pwaUpdateEvents,
        readyState: document.readyState,
        online: navigator.onLine,
        activeState: registration?.active?.state ?? null,
        waitingState: registration?.waiting?.state ?? null,
        installingState: registration?.installing?.state ?? null,
        consentCount: count('/__easyboost/pwa-consent-v1/'),
        readyCount: count('/__easyboost/pwa-current-ready-v1/'),
        participantCount: count('/__easyboost/pwa-learner-shell-v1/'),
        serviceWorkerAvailable: Boolean(navigator.serviceWorker),
        cacheStorageAvailable: Boolean(globalThis.caches),
        activated: Boolean(await cache?.match('/__easyboost/pwa-activated-v1')),
        applyText: document.getElementById('pwa_update_apply')?.textContent ?? null,
      };
    }, { stateCache: candidateClientStateCache, pageLabel: label })));
    throw new Error(`PWA consent quorum did not reload both clients: ${JSON.stringify(activationState)}`,
      { cause: error });
  }
  await waitForCandidateWorker(applyingPage, 'controller');
  await waitForCandidateWorker(lateConsentPage, 'controller');
  for (const [label, page] of [['A', applyingPage], ['B', lateConsentPage]]) {
    const boot = await page.evaluate(() => ({
      title: document.title,
      shell: document.documentElement.dataset.aisyAppShell,
      candidateNotice: Boolean(document.getElementById('pwa_update')),
    }));
    assert.deepEqual(boot, { title: 'Aisy ЕГЭ — Английский · Aisy.space', shell: 'v1', candidateNotice: true },
      `${label} must boot the candidate root from the current release cache while offline`);
  }
  await lateConsentPage.waitForFunction((oldCache) => caches.keys().then((keys) => !keys.includes(oldCache)),
    predecessorCompatibility.cacheName, { timeout: 20_000 });
  await context.setOffline(false);
  await openLearningApp(lateConsentPage);
  await openDeepSkill(lateConsentPage, 'writing');
  assert.equal(await lateConsentPage.locator('#w_editor').inputValue(), draft,
    'the real Writing draft survives B later explicitly consenting to the candidate');
  const retiredCaches = await lateConsentPage.evaluate(() => caches.keys());
  assert.ok(retiredCaches.includes('foreign-sentinel-cache-v1'),
    'Aisy retirement must preserve a foreign sentinel cache');
  assert.equal(await lateConsentPage.evaluate(async () => {
    const response = await (await caches.open('foreign-sentinel-cache-v1')).match('/foreign-sentinel');
    return response?.text();
  }), 'must survive');

  const installPage = await context.newPage();
  await openLearningApp(installPage);
  const stableEvidence = await installPage.evaluate(async ({ paths, cacheName }) => {
    async function digest(response) {
      const bytes = await response.arrayBuffer();
      return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
        .map((value) => value.toString(16).padStart(2, '0')).join('');
    }
    const cache = await caches.open(cacheName);
    const evidence = {};
    for (const webPath of paths) {
      evidence[webPath] = {
        fetched: await digest(await fetch(webPath)),
        installed: await digest(await cache.match(webPath)),
      };
    }
    return evidence;
  }, { paths: candidateStablePaths, cacheName: candidateCacheName });
  for (const webPath of candidateStablePaths) {
    assert.deepEqual(stableEvidence[webPath], {
      fetched: candidateStableDigests[webPath], installed: candidateStableDigests[webPath],
    }, `${webPath} must expose candidate bytes through both HTTP-cache-bypassing fetch and install cache`);
  }
  const candidateSpeakingDigest = sha256(candidateSpeakingBytes);
  await installPage.evaluate(async ({ assetPath, currentCacheName }) => {
    const current = await caches.open(currentCacheName);
    const candidateAsset = await fetch(assetPath, { cache: 'reload' });
    await current.put(assetPath, candidateAsset.clone());
    const foreign = await caches.open('foreign-sentinel-cache-v1');
    await foreign.put('/', new Response('<!doctype html><title>FOREIGN CACHE POISON</title>', {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    }));
    await foreign.put(assetPath, new Response('foreign lazy poison', {
      headers: { 'Content-Type': 'text/javascript; charset=utf-8' },
    }));
  }, { assetPath: `/${candidateSpeakingName}`, currentCacheName: candidateCacheName });
  await context.setOffline(true);
  const offlineEgeExecDigests = await installPage.evaluate(async (paths) => {
    const evidence = {};
    for (const webPath of paths) {
      const response = await fetch(webPath);
      const bytes = await response.arrayBuffer();
      evidence[webPath] = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
        .map((value) => value.toString(16).padStart(2, '0')).join('');
    }
    return evidence;
  }, builtEgeExecPaths);
  assert.deepEqual(offlineEgeExecDigests, candidateEgeExecDigests,
    'every emitted EGE executable must retain its exact candidate bytes offline after upgrade');
  const collisionAssetDigest = await installPage.evaluate(async (assetPath) => {
    const response = await fetch(assetPath);
    const bytes = await response.arrayBuffer();
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map((value) => value.toString(16).padStart(2, '0')).join('');
  }, `/${candidateSpeakingName}`);
  assert.equal(collisionAssetDigest, candidateSpeakingDigest,
    'generic fallback must prefer the current lazy asset over a foreign collision');
  await installPage.goto(origin, { waitUntil: 'domcontentloaded' });
  assert.equal(await installPage.title(), 'Aisy ЕГЭ — Английский · Aisy.space',
    'offline navigation must prefer the current root over a foreign collision');
  assert.equal(await installPage.locator('html').getAttribute('data-aisy-app-shell'), 'v1');
  await context.setOffline(false);

  const privatePaths = [
    '/api', '/API', '/aPi', '/internal', '/INTERNAL', '/InTeRnAl',
    '/API/v1/me', '/INTERNAL/metrics', '/health/live', '/HEALTH/READY',
  ];
  const privateBypass = await installPage.evaluate(async ({ paths, currentCacheName }) => {
    const poison = await caches.open(currentCacheName);
    for (const privatePath of paths) {
      await poison.put(privatePath, new Response(JSON.stringify({ source: 'stale-poison' }), {
        headers: { 'Content-Type': 'application/json' },
      }));
    }
    const evidence = {};
    for (const privatePath of paths) {
      const response = await fetch(privatePath);
      evidence[privatePath] = {
        status: response.status,
        cacheControl: response.headers.get('cache-control'),
        body: await response.json(),
      };
    }
    return evidence;
  }, { paths: privatePaths, currentCacheName: candidateCacheName });
  for (const privatePath of privatePaths) {
    assert.match(privateBypass[privatePath].cacheControl, /no-store/u, `${privatePath} HTTP response`);
    assert.notEqual(privateBypass[privatePath].body.source, 'stale-poison', `${privatePath} cache poison replayed`);
  }
  assert.equal(privateBypass['/API/v1/me'].body.displayName, 'Fresh network learner');
  assert.equal(privateBypass['/INTERNAL/metrics'].body.source, 'fresh-network');
  assert.equal(privateBypass['/health/live'].body.source, 'fresh-network');
  assert.equal(privateBypass['/HEALTH/READY'].body.source, 'fresh-network');
  await context.setOffline(true);
  assert.deepEqual(await installPage.evaluate(async (paths) => Promise.all(
    paths.map(async (url) => {
      try { await fetch(url); return 'replayed'; } catch { return 'network-failed'; }
    }),
  ), privatePaths), privatePaths.map(() => 'network-failed'),
  'mixed-case private/control/health requests must bypass even a poisoned current-release cache offline');
  await context.setOffline(false);

  const legacyCallbackPath = '/?login_code=pwa-private-callback-sentinel';
  const legacyCallbackPage = await context.newPage();
  await openLearningApp(legacyCallbackPage);
  await waitForCandidateWorker(legacyCallbackPage, 'controller');
  await legacyCallbackPage.evaluate(async ({ cacheName, callbackPath }) => {
    await (await caches.open(cacheName)).put(callbackPath, new Response(
      '<!doctype html><title>LEGACY CALLBACK CACHE POISON</title>',
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    ));
  }, { cacheName: candidateCacheName, callbackPath: legacyCallbackPath });
  const onlineCallback = await legacyCallbackPage.goto(`${origin}${legacyCallbackPath}`, {
    waitUntil: 'domcontentloaded',
  });
  assert.match(onlineCallback.headers()['cache-control'] || '', /no-store/u,
    'the legacy root callback must stay network-only online');
  assert.equal(await legacyCallbackPage.title(), 'Aisy ЕГЭ — Английский · Aisy.space',
    'the current-release cache poison must not replace the online callback response');
  await context.setOffline(true);
  await assert.rejects(
    legacyCallbackPage.goto(`${origin}${legacyCallbackPath}`, {
      waitUntil: 'domcontentloaded', timeout: 10_000,
    }),
    /ERR_INTERNET_DISCONNECTED|ERR_FAILED|Navigation failed/iu,
    'offline callback navigation must fail instead of replaying the cached root or exact poison',
  );
  await context.setOffline(false);
  await legacyCallbackPage.close();

  const cdp = await context.newCDPSession(installPage);
  const appManifest = await cdp.send('Page.getAppManifest');
  assert.equal(appManifest.url, `${origin}/manifest.json`);
  assert.deepEqual(appManifest.errors, []);
  assert.equal(JSON.parse(appManifest.data).orientation, 'any');
  const iconEvidence = await installPage.evaluate(async () => {
    async function pixels(src) {
      const image = new Image(); image.src = src; await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const context2d = canvas.getContext('2d'); context2d.drawImage(image, 0, 0);
      const at = (x, y) => [...context2d.getImageData(x, y, 1, 1).data];
      const sample = [];
      for (let y = 154; y <= 358; y += 34) {
        for (let x = 154; x <= 358; x += 34) sample.push(at(x, y).join(','));
      }
      return {
        corner: at(0, 0),
        center: at(Math.floor(image.naturalWidth / 2), Math.floor(image.naturalHeight / 2)),
        safeZoneColors: new Set(sample).size,
      };
    }
    return { any: await pixels('/icon-512.png'), maskable: await pixels('/icon-maskable-512.png') };
  });
  assert.equal(iconEvidence.any.corner[3], 0, 'ordinary icon keeps transparent rounded corners');
  assert.deepEqual(iconEvidence.maskable.corner.slice(0, 3), [185, 67, 58],
    'maskable icon fills its crop background');
  assert.equal(iconEvidence.maskable.corner[3], 255);
  assert.ok(iconEvidence.maskable.safeZoneColors >= 4,
    `maskable safe zone lost the Aisy mark: ${JSON.stringify(iconEvidence.maskable)}`);

  await installPage.goto(`${origin}/privacy.html`, { waitUntil: 'networkidle' });
  assert.match(await installPage.title(), /Политика конфиденциальности/u);
  await context.setOffline(true);
  await installPage.goto(origin, { waitUntil: 'domcontentloaded' });
  assert.match(await installPage.title(), /Aisy ЕГЭ/u);
  assert.equal(await installPage.locator('html').getAttribute('data-aisy-app-shell'), 'v1',
    'privacy navigation must not replace the offline root app shell');
  await context.setOffline(false);

  await context.close();
  context = null;
  generation = 'predecessor';
  closeContext = await browser.newContext({ viewport: { width: 375, height: 812 } });
  await installReleaseInstrumentation(closeContext);
  const closeApplyingPage = await closeContext.newPage();
  await openLearningApp(closeApplyingPage);
  await closeApplyingPage.waitForFunction(async () => {
    await navigator.serviceWorker.ready;
    return Boolean(navigator.serviceWorker.controller);
  }, null, { timeout: 30_000 });
  const closingTaskPage = await closeContext.newPage();
  await openLearningApp(closingTaskPage);
  await closeApplyingPage.evaluate(async () => {
    const sentinel = await caches.open('foreign-close-sentinel-v1');
    await sentinel.put('/foreign-close-sentinel', new Response('survives-close-upgrade'));
  });

  generation = 'candidate';
  await closeApplyingPage.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  await closeApplyingPage.waitForFunction(() => window.__pwaUpdateEvents > 0, null, { timeout: 40_000 });
  await closeApplyingPage.getByText('Доступна новая версия Aisy.space. Обновите страницу.', { exact: true })
    .waitFor({ state: 'visible', timeout: 10_000 });
  await waitForCandidateWorker(closeApplyingPage, 'waiting');
  const closeApplyingButton = await reloadIntoCandidateUpdateUi(closeApplyingPage, 'A close-quorum');
  assert.equal(await closeApplyingPage.evaluate(() => window.__pwaReleaseLoads), 2,
    'close-quorum A must load the real candidate update UI before consenting');
  await closeApplyingButton.press('Enter');
  await closeApplyingPage.waitForFunction(async (stateCache) => {
    const keys = await (await caches.open(stateCache)).keys();
    return keys.some((request) => new URL(request.url).pathname
      .startsWith('/__easyboost/pwa-consent-v1/'));
  }, candidateClientStateCache, { timeout: 15_000 });
  assert.equal(await closeApplyingPage.evaluate(() => window.__pwaReleaseLoads), 2,
    'A candidate UI must remain under predecessor control while B is open and nonconsenting');
  assert.equal(await closingTaskPage.evaluate(() => window.__pwaReleaseLoads), 1);
  await waitForCandidateWorker(closeApplyingPage, 'waiting');
  assert.ok((await closeApplyingPage.evaluate(() => caches.keys())).includes(predecessorCompatibility.cacheName));

  await openDeepSkill(closingTaskPage, 'speaking');
  const closeResources = await closingTaskPage.evaluate(({ oldPath, candidatePath }) => ({
    oldLoaded: performance.getEntriesByType('resource')
      .some((entry) => new URL(entry.name).pathname === oldPath),
    candidateLoaded: performance.getEntriesByType('resource')
      .some((entry) => new URL(entry.name).pathname === candidatePath),
  }), { oldPath: predecessorSpeakingPath, candidatePath: `/${candidateSpeakingName}` });
  assert.deepEqual(closeResources, { oldLoaded: true, candidateLoaded: false },
    'open B must keep loading the genuine predecessor lazy graph before it closes');

  await closeContext.setOffline(true);
  await closingTaskPage.close();
  await closeApplyingPage.waitForFunction(() => window.__pwaReleaseLoads === 3, null, { timeout: 30_000 });
  await waitForCandidateWorker(closeApplyingPage, 'controller');
  const closeBoot = await closeApplyingPage.evaluate(() => ({
    title: document.title,
    shell: document.documentElement.dataset.aisyAppShell,
    candidateNotice: Boolean(document.getElementById('pwa_update')),
  }));
  assert.deepEqual(closeBoot, {
    title: 'Aisy ЕГЭ — Английский · Aisy.space', shell: 'v1', candidateNotice: true,
  }, 'B close must complete quorum and boot candidate A from current cache while offline');
  await closeApplyingPage.waitForFunction((oldCache) => caches.keys().then((keys) => !keys.includes(oldCache)),
    predecessorCompatibility.cacheName, { timeout: 20_000 });
  const closeCaches = await closeApplyingPage.evaluate(() => caches.keys());
  assert.ok(closeCaches.includes('foreign-close-sentinel-v1'));
  assert.equal(await closeApplyingPage.evaluate(async () => (
    await (await (await caches.open('foreign-close-sentinel-v1')).match('/foreign-close-sentinel')).text()
  )), 'survives-close-upgrade');
  await closeContext.setOffline(false);
  await closeContext.close();
  closeContext = null;

  await browser.close();
  browser = null;
  installabilityProfile = await fs.mkdtemp(path.join(os.tmpdir(), 'aisy-pwa-installability-'));
  installabilityContext = await chromium.launchPersistentContext(installabilityProfile, {
    headless: true, executablePath: await chromeExecutable(), viewport: { width: 375, height: 812 },
  });
  await installReleaseInstrumentation(installabilityContext);
  const installabilityPage = installabilityContext.pages()[0] || await installabilityContext.newPage();
  await openLearningApp(installabilityPage);
  await installabilityPage.waitForFunction(async () => {
    await navigator.serviceWorker.ready;
    return Boolean(navigator.serviceWorker.controller);
  }, null, { timeout: 30_000 });
  const installabilityCdp = await installabilityContext.newCDPSession(installabilityPage);
  const installabilityManifest = await installabilityCdp.send('Page.getAppManifest');
  assert.equal(installabilityManifest.url, `${origin}/manifest.json`);
  assert.deepEqual(installabilityManifest.errors, []);
  const installability = await installabilityCdp.send('Page.getInstallabilityErrors');
  assert.deepEqual(installability, { installabilityErrors: [] },
    'controlled production dist in a persistent Chromium profile must have zero installability errors');
  await installabilityContext.close();
  installabilityContext = null;
  await fs.rm(installabilityProfile, { recursive: true, force: true });
  installabilityProfile = null;

  console.log(`PWA exact predecessor ${PREDECESSOR_COMMIT.slice(0, 8)} / ${predecessorSpeakingName}`
    + ` -> ${candidateRelease.slice(0, 18)}…: consent+close quorum, offline current-cache boot, 26-file provenance, private bypass and Aisy-only prune GREEN.`);
} catch (error) {
  primaryFailure = error;
} finally {
  const phaseOneCleanupErrors = await settleCleanupOperations([
    ['installability context', async () => {
      if (!installabilityContext) return;
      const resource = installabilityContext;
      installabilityContext = null;
      await resource.close();
    }],
    ['close-quorum context', async () => {
      if (!closeContext) return;
      const resource = closeContext;
      closeContext = null;
      await resource.close();
    }],
    ['primary browser context', async () => {
      if (!context) return;
      const resource = context;
      context = null;
      await resource.close();
    }],
  ]);
  const phaseTwoCleanupErrors = await settleCleanupOperations([
    ['browser', async () => {
      if (!browser) return;
      const resource = browser;
      browser = null;
      await resource.close();
    }],
    ['listening server', async () => {
      if (!server?.listening) return;
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }],
    ['installability profile', async () => {
      if (!installabilityProfile) return;
      const directory = installabilityProfile;
      installabilityProfile = null;
      await fs.rm(directory, { recursive: true, force: true });
    }],
    ['predecessor fixture', async () => {
      if (!predecessorFixture) return;
      const directory = predecessorFixture.rootDirectory;
      predecessorFixture = null;
      await fs.rm(directory, { recursive: true, force: true });
    }],
  ]);
  const cleanupErrors = [...phaseOneCleanupErrors, ...phaseTwoCleanupErrors];
  if (primaryFailure && cleanupErrors.length) {
    throw new AggregateError([primaryFailure, ...cleanupErrors],
      'PWA release scenario and resource cleanup both failed');
  }
  if (primaryFailure) throw primaryFailure;
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'PWA release resource cleanup failed');
}
