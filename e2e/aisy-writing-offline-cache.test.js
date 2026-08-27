import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import {
  availablePort,
  chromeExecutable,
  createActiveSubscriptionPage,
  stopProcess,
  waitForReady,
} from './browser-server-harness.js';

const projectDirectory = fileURLToPath(new URL('..', import.meta.url));
const serverPath = fileURLToPath(new URL('../server.js', import.meta.url));
const builtPublicDirectory = path.join(projectDirectory, 'dist', 'public');
const jwtSecret = 'aisy-writing-offline-cache-e2e-secret';
const username = 'writing-cache-learner';

function responseHeaders(owner) {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'X-EasyBoost-Response-Owner': owner,
    Date: new Date().toUTCString(),
  };
}

async function openPractice(page) {
  await page.getByRole('navigation', { name: 'Основные разделы' })
    .getByRole('button', { name: 'Практика', exact: true }).press('Enter');
  await page.locator('#aisy-practice.on').waitFor({ state: 'visible', timeout: 8_000 });
}

async function openWriting(page) {
  await openPractice(page);
  await page.locator('.practice-row[data-skill="writing"] button').press('Enter');
  await page.locator('#scr8.on #w_editor').waitFor({ state: 'visible', timeout: 8_000 });
}

async function cacheLocations(page, assetPaths) {
  return page.evaluate(async (paths) => {
    const locations = Object.fromEntries(paths.map((assetPath) => [assetPath, []]));
    for (const cacheName of await caches.keys()) {
      const cache = await caches.open(cacheName);
      for (const assetPath of paths) {
        const requestUrl = new URL(assetPath, location.origin).href;
        if (await cache.match(requestUrl)) locations[assetPath].push(cacheName);
      }
    }
    return locations;
  }, assetPaths);
}

let browser;
let child;
let context;
let temporaryDirectory;

try {
  const manifest = JSON.parse(await fs.readFile(
    path.join(builtPublicDirectory, 'asset-manifest.json'),
    'utf8',
  ));
  const builtHtml = await fs.readFile(path.join(builtPublicDirectory, 'index.html'), 'utf8');
  const workerSource = await fs.readFile(path.join(builtPublicDirectory, 'service-worker.js'), 'utf8');
  const moduleSources = [
    'screens/writing.js',
    'modules/writing.js',
    '../shared/ege-writing-text-sanitizer.js',
  ];
  const moduleAssets = Object.fromEntries(moduleSources.map((source) => {
    const emitted = manifest.modules?.[source];
    assert.equal(typeof emitted, 'string', `${source} must be present in the production manifest`);
    return [source, `/${emitted}`];
  }));
  const lazyAssetPaths = [...new Set(Object.values(moduleAssets))];
  const stylesheetPaths = [...builtHtml.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/gu)]
    .map((match) => match[1]);
  let cssPath = null;
  for (const stylesheetPath of stylesheetPaths) {
    const stylesheet = await fs.readFile(path.join(builtPublicDirectory, stylesheetPath.slice(1)), 'utf8');
    if (stylesheet.includes('.writing-primary') && stylesheet.includes('--aisy-button-height')) {
      cssPath = stylesheetPath;
      break;
    }
  }
  assert.equal(typeof cssPath, 'string', 'the production document must link the CSS containing Writing');
  const assetPaths = [...lazyAssetPaths, cssPath];
  const shell = new Set(manifest.shell || []);

  for (const [source, assetPath] of Object.entries(moduleAssets)) {
    assert.equal(shell.has(assetPath), false, `${source} must stay out of the install shell`);
    assert.equal(
      (manifest.dynamicChunks || []).includes(assetPath.slice(1)),
      true,
      `${source} must remain in the lazy production graph`,
    );
  }
  assert.equal(shell.has(cssPath), false, 'the emitted Writing CSS must join the cache through the online document');
  assert.equal(workerSource.includes(`'${cssPath}'`), false, 'the emitted Writing CSS must not be mislabeled as install-shell input');

  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'aisy-writing-offline-cache-e2e-'));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const now = Date.now();
  const dataFile = path.join(temporaryDirectory, 'data.json');
  await fs.writeFile(dataFile, JSON.stringify({
    users: {
      [username]: {
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
    progress: { [username]: {} },
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
  const harness = await createActiveSubscriptionPage(browser, {
    baseUrl,
    username,
    jwtSecret,
    contextOptions: {
      viewport: { width: 375, height: 812 },
      reducedMotion: 'reduce',
      serviceWorkers: 'allow',
    },
  });
  context = harness.context;
  const page = harness.page;
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.locator('#scr1.on').waitFor({ state: 'visible', timeout: 8_000 });
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  if (!await page.evaluate(() => Boolean(navigator.serviceWorker.controller))) {
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('#scr1.on').waitFor({ state: 'visible', timeout: 8_000 });
  }
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, { timeout: 15_000 });
  /* clients.claim() can attach after the first document has already fetched its styles.
     Begin the measured journey from a document whose complete request graph is SW-controlled. */
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('#scr1.on').waitFor({ state: 'visible', timeout: 8_000 });
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, { timeout: 15_000 });

  const beforeOpen = await cacheLocations(page, assetPaths);
  for (const assetPath of lazyAssetPaths) {
    assert.deepEqual(beforeOpen[assetPath], [], `${assetPath} must not be preloaded before Writing opens`);
  }
  assert.ok(beforeOpen[cssPath].length > 0, 'the first online document must runtime-cache its Writing CSS bundle');

  await openWriting(page);
  await page.locator('#w_seg37').press('Enter');
  const draft = 'Dear Sam,\n\nThank you for your message.\nThis draft must reopen from the cached Writing route.\n\nBest wishes,\nAlex';
  await page.locator('#w_editor').fill(draft);
  await page.waitForFunction((expected) => Object.values(window.S?.drafts || {}).includes(expected), draft);
  await page.getByRole('button', { name: 'Назад в раздел Практика', exact: true }).press('Enter');
  await page.locator('#aisy-practice.on').waitFor({ state: 'visible' });

  await page.waitForFunction(async (paths) => {
    const names = await caches.keys();
    for (const assetPath of paths) {
      let found = false;
      for (const cacheName of names) {
        const cache = await caches.open(cacheName);
        if (await cache.match(new URL(assetPath, location.origin).href)) {
          found = true;
          break;
        }
      }
      if (!found) return false;
    }
    return true;
  }, assetPaths, { timeout: 10_000 });
  const afterOpen = await cacheLocations(page, assetPaths);
  for (const [source, assetPath] of Object.entries(moduleAssets)) {
    assert.ok(afterOpen[assetPath].length > 0, `${source} must join CacheStorage after its first use`);
  }

  const progressResponse = await context.request.get(`${baseUrl}/api/v1/progress`, {
    headers: { 'X-EasyBoost-Expected-Owner': username },
  });
  assert.equal(progressResponse.ok(), true);
  const progressPayload = await progressResponse.json();
  const mePattern = new RegExp(`^${baseUrl.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}/api/v1/me(?:\\?.*)?$`, 'u');
  const progressPattern = new RegExp(`^${baseUrl.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}/api/v1/progress(?:\\?.*)?$`, 'u');
  await context.route(mePattern, (route) => route.fulfill({
    status: 200,
    headers: responseHeaders(username),
    body: JSON.stringify(harness.session),
  }));
  await context.route(progressPattern, (route) => route.fulfill({
    status: 200,
    headers: responseHeaders(username),
    body: JSON.stringify(progressPayload),
  }));

  /* A dead origin is the independent proof that the reload cannot fall through to HTTP.
     The two authority reads above remain explicit test-boundary fixtures: production correctly
     refuses to trust a stale subscription when /me cannot be checked. */
  await stopProcess(child);
  child = null;
  await assert.rejects(
    fetch(`${baseUrl}/health/ready`, { signal: AbortSignal.timeout(1_000) }),
    'the origin must be unreachable before the cache-only reload',
  );

  const offlineAssetResponses = [];
  page.on('response', (response) => {
    const pathname = new URL(response.url()).pathname;
    if (assetPaths.includes(pathname)) {
      offlineAssetResponses.push({
        pathname,
        status: response.status(),
        fromServiceWorker: response.fromServiceWorker(),
      });
    }
  });
  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#scr1.on').waitFor({ state: 'visible', timeout: 20_000 });
  assert.equal(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)), true);

  await openWriting(page);
  assert.equal(await page.locator('#w_editor').inputValue(), draft, 'the exact local draft must survive an offline reload');
  assert.equal(await page.locator('#w_seg37').getAttribute('aria-checked'), 'true');
  assert.equal(await page.evaluate(() => typeof window.EasyBoostWriting?.buildPayload), 'function');
  const paper = await page.evaluate((expectedCssPath) => {
    const primary = document.getElementById('w_primary_action');
    const editor = document.getElementById('w_editor');
    return {
      stylesheetLoaded: [...document.styleSheets].some((sheet) => (
        sheet.href && new URL(sheet.href).pathname === expectedCssPath
      )),
      primaryMinHeight: getComputedStyle(primary).minBlockSize,
      editorMinHeight: Number.parseFloat(getComputedStyle(editor).minHeight),
    };
  }, cssPath);
  assert.equal(paper.stylesheetLoaded, true, 'the cached Writing stylesheet must join the offline document');
  assert.equal(paper.primaryMinHeight, '58px', 'cached Writing CSS must preserve the CTA token');
  assert.ok(paper.editorMinHeight > 0, 'cached Writing CSS must style the editor');

  for (const [source, assetPath] of Object.entries(moduleAssets)) {
    assert.ok(
      offlineAssetResponses.some((response) => response.pathname === assetPath
        && response.status === 200 && response.fromServiceWorker),
      `${source} must execute from the service worker after an offline document reload`,
    );
  }
  assert.ok(
    offlineAssetResponses.some((response) => response.pathname === cssPath
      && response.status === 200 && response.fromServiceWorker),
    'Writing CSS must come from the service worker after an offline document reload',
  );
  assert.deepEqual(pageErrors, []);

  console.log('Aisy Writing offline cache E2E passed: lazy screen, logic, sanitizer and CSS reopen through the production service worker');
} finally {
  if (context) await context.close();
  if (browser) await browser.close();
  await stopProcess(child);
  if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true });
}
