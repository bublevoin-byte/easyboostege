import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../public/service-worker.js', import.meta.url), 'utf8');
const buildSource = await fs.readFile(new URL('../scripts/build-frontend.js', import.meta.url), 'utf8');
const projectDirectory = fileURLToPath(new URL('..', import.meta.url));
const immediateLocks = { request(_name, operation) { return operation(); } };

test('service worker serves EGE playback only from the requested fingerprint and digest cache', async () => {
  const listeners = new Map();
  const path = '/audio/listening/listening-pilot-v1/matching/exact.mp3';
  const digest = 'a'.repeat(64);
  const imagePath = '/images/ege-mock/form-1/task-42-pair.png';
  const currentName = `easyboost-ege-mock-assets-v1-form@2-${'b'.repeat(64)}`;
  const oldName = `easyboost-ege-mock-assets-v1-form@1-${'c'.repeat(64)}`;
  const playbackUrl = `https://easyboost.test${path}?egeMockAssetCache=${encodeURIComponent(currentName)}&egeMockAssetDigest=${digest}`;
  const imagePlaybackUrl = `https://easyboost.test${imagePath}?egeMockAssetCache=${encodeURIComponent(currentName)}&egeMockAssetDigest=${digest}`;
  const stores = new Map([
    ['easyboost-static-test', new Map([[`https://easyboost.test${path}`, new Response('generic-corrupt', {
      headers: { 'content-type': 'audio/mpeg' },
    })]])],
    [oldName, new Map([[playbackUrl, new Response('old-revision', {
      headers: { 'content-type': 'audio/mpeg' },
    })]])],
    [currentName, new Map([
      [playbackUrl, new Response('current-exact', { headers: { 'content-type': 'audio/mpeg' } })],
      [imagePlaybackUrl, new Response('exact-png', { headers: { 'content-type': 'image/png' } })],
    ])],
  ]);
  const caches = {
    async open(name) {
      const store = stores.get(name) || new Map();
      stores.set(name, store);
      return {
        async addAll() {},
        async put(key, value) { store.set(typeof key === 'string' ? key : key.url, value); },
        async match(key) { return store.get(typeof key === 'string' ? key : key.url)?.clone(); },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
    async match(key) {
      for (const store of stores.values()) {
        const value = store.get(typeof key === 'string' ? key : key.url);
        if (value) return value.clone();
      }
      return undefined;
    },
  };
  let networkCalls = 0;
  const self = {
    location: { origin: 'https://easyboost.test' }, navigator: { locks: immediateLocks },
    addEventListener(type, listener) { listeners.set(type, listener); },
    async skipWaiting() {}, clients: { async claim() {} },
  };
  vm.runInNewContext(source, {
    self, caches, Headers, URL, Promise, Response,
    async fetch() { networkCalls += 1; return new Response('network-corrupt'); },
  });
  let responsePromise;
  listeners.get('fetch')({
    request: { method: 'GET', mode: 'cors', url: playbackUrl, headers: new Headers({ Range: 'bytes=0-6' }) },
    respondWith(value) { responsePromise = value; },
    waitUntil() {},
  });
  const response = await responsePromise;
  assert.equal(response.status, 206);
  assert.equal(await response.text(), 'current');
  assert.equal(networkCalls, 0);

  listeners.get('fetch')({
    request: { method: 'GET', mode: 'cors', url: imagePlaybackUrl, headers: new Headers() },
    respondWith(value) { responsePromise = value; },
    waitUntil() {},
  });
  const imageResponse = await responsePromise;
  assert.equal(imageResponse.status, 200);
  assert.equal(await imageResponse.text(), 'exact-png');
  assert.equal(networkCalls, 0, 'task-42 PNG is served only from the exact requested cache');

  let capability;
  let capabilityReady;
  listeners.get('message')({
    data: { type: 'EGE_MOCK_ASSET_CAPABILITY' },
    ports: [{ postMessage(value) { capability = value; } }],
    waitUntil(value) { capabilityReady = value; },
  });
  await capabilityReady;
  assert.equal(capability?.capability, 'easyboost-ege-mock-assets-v1');
});

test('exact form manifest survives shell activation and restores offline or after a transient 503', async () => {
  const listeners = new Map();
  const stores = new Map([['easyboost-static-old', new Map()]]);
  const caches = {
    async open(name) {
      const store = stores.get(name) || new Map();
      stores.set(name, store);
      return {
        async addAll() {},
        async put(key, value) { store.set(typeof key === 'string' ? key : key.url, value); },
        async match(key) { return store.get(typeof key === 'string' ? key : key.url)?.clone(); },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
    async match() { return undefined; },
  };
  let network = 'online';
  const self = {
    location: { origin: 'https://easyboost.test' },
    addEventListener(type, listener) { listeners.set(type, listener); },
    async skipWaiting() {}, clients: { async claim() {} },
  };
  vm.runInNewContext(source, {
    self, caches, Headers, URL, Promise, Response,
    async fetch() {
      if (network === 'offline') throw new Error('offline');
      if (network === 'transient') return new Response('temporary', { status: 503 });
      return new Response('export const exactForm=true');
    },
  });
  const request = { method: 'GET', mode: 'cors', url: 'https://easyboost.test/ege-mock-form-1-v1.js' };
  let responsePromise;
  listeners.get('fetch')({ request, respondWith(value) { responsePromise = value; }, waitUntil() {} });
  assert.equal(await (await responsePromise).text(), 'export const exactForm=true');
  let activation;
  listeners.get('activate')({ waitUntil(value) { activation = value; } });
  await activation;
  network = 'transient';
  listeners.get('fetch')({ request, respondWith(value) { responsePromise = value; }, waitUntil() {} });
  assert.equal((await responsePromise).status, 200);
  assert.equal(await (await responsePromise).text(), 'export const exactForm=true');
  network = 'offline';
  listeners.get('fetch')({ request, respondWith(value) { responsePromise = value; }, waitUntil() {} });
  assert.equal(await (await responsePromise).text(), 'export const exactForm=true');
  assert.equal([...stores.keys()].some((name) => name.startsWith('easyboost-ege-mock-form-v1-')), true);
});

test('frontend build pins the exact emitted form module path into the service worker', () => {
  assert.match(source, /\/\* build:ege-mock-form \*\/[\s\S]*?const EGE_MOCK_FORM_PATH='\/ege-mock-form-1-v1\.js';[\s\S]*?\/\* end build:ege-mock-form \*\//u);
  assert.match(buildSource, /modules\['ege-mock-form-1-v1\.js'\]/u);
  assert.match(buildSource, /builtEgeMockFormPath/u);
  assert.match(buildSource, /EGE_MOCK_FORM_PATH/u);
  assert.match(buildSource, /assets\[builtEgeMockFormPath\.slice\(1\)\]/u);
});

test('built output preserves the derived oral and written EGE closure and neutral dependencies', {
  timeout: 120_000,
}, async () => {
  const built = spawnSync(process.execPath, ['scripts/build-frontend.js'], {
    cwd: projectDirectory, encoding: 'utf8', timeout: 110_000,
  });
  assert.equal(built.status, 0, built.stderr || built.stdout);
  const manifest = JSON.parse(await fs.readFile(
    new URL('../dist/public/asset-manifest.json', import.meta.url), 'utf8',
  ));
  const egeModules = [
    'screens/ege-mock.js', 'ege-mock-writing-assessment-ui.js', 'ege-mock-written-assets.js',
    'ege-mock-written-runner.js', 'ege-writing-text.js', 'ege-mock-oral-media.js',
    'ege-mock-oral-runner.js', 'ege-mock-oral-contract.js',
    'modules/listening.js', 'modules/reading.js', 'reading-catalog-contract.js',
    'reading-pilot-v1.js',
    'speaking-local-recording.js', 'speaking-pronunciation-audio.js',
  ];
  assert.equal(egeModules.length, 14);
  const sourceClosure = [
    ...egeModules, '../shared/ege-mock-oral-contract.js', '../shared/ege-writing-text.js',
    '../shared/ege-writing-text-sanitizer.js', '../shared/semantic-json.js',
  ];
  assert.equal(sourceClosure.every((name) => typeof manifest.modules[name] === 'string'), true);
  const expectedPaths = [...new Set(sourceClosure.map((name) => `/${manifest.modules[name]}`))].sort();
  const builtWorker = await fs.readFile(
    new URL('../dist/public/service-worker.js', import.meta.url), 'utf8',
  );
  const builtHtml = await fs.readFile(new URL('../dist/public/index.html', import.meta.url), 'utf8');
  const builtShell = JSON.parse(
    builtWorker.match(/const APP_SHELL=(\[[^\]]*\]);/u)[1].replaceAll("'", '"'),
  );
  const linkedStyles = [...builtHtml.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/gu)]
    .map((match) => match[1]);
  assert.ok(linkedStyles.length > 0, 'the production document must link its emitted stylesheet');
  assert.equal(linkedStyles.every((pathname) => builtShell.includes(pathname)), true,
    'every stylesheet requested by production index.html must survive an offline shell reload');
  const listeners = new Map();
  const stores = new Map();
  let online = true;
  const caches = {
    async open(name) {
      const store = stores.get(name) || new Map(); stores.set(name, store);
      return {
        async addAll(paths) {
          for (const pathname of paths) {
            store.set(`https://easyboost.test${pathname}`, new Response(`built:${pathname}`));
          }
        },
        async put(key, value) { store.set(typeof key === 'string' ? key : key.url, value); },
        async match(key) { return store.get(typeof key === 'string' ? key : key.url)?.clone(); },
        async keys() { return [...store.keys()].map((url) => ({ url })); },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
    async match() { return undefined; },
  };
  const self = {
    location: { origin: 'https://easyboost.test' },
    registration: { active: { scriptURL: 'previous-worker.js' } },
    navigator: { locks: immediateLocks },
    addEventListener(type, listener) { listeners.set(type, listener); },
    async skipWaiting() {}, clients: { async claim() {} },
  };
  vm.runInNewContext(builtWorker, {
    self, caches, Headers, URL, Promise, Response,
    async fetch(request) {
      if (!online) throw new Error('offline');
      const pathname = new URL(typeof request === 'string' ? request : request.url).pathname;
      return new Response(`built:${pathname}`);
    },
  });
  let install;
  listeners.get('install')({ waitUntil(value) { install = value; } });
  await install;
  const executableStore = [...stores.entries()]
    .find(([name]) => name.startsWith('easyboost-ege-mock-exec-v1-'))?.[1];
  const cachedPaths = [...(executableStore?.keys() || [])]
    .map((url) => new URL(url).pathname).sort();
  assert.deepEqual(cachedPaths, expectedPaths);
  const generationStore = [...stores.entries()]
    .find(([name]) => name.startsWith('easyboost-ege-mock-install-v1-'))?.[1];
  const generations = [...(generationStore?.keys() || [])]
    .map((url) => new URL(url, 'https://easyboost.test').pathname);
  assert.deepEqual(generations, ['/__easyboost/ege-mock-install-mode-v3/1-update']);

  let activation;
  listeners.get('activate')({ waitUntil(value) { activation = value; } });
  await activation;
  online = false;
  for (const pathname of expectedPaths) {
    let responsePromise;
    listeners.get('fetch')({
      request: { method: 'GET', mode: 'cors', url: `https://easyboost.test${pathname}` },
      respondWith(value) { responsePromise = value; }, waitUntil() {},
    });
    assert.equal(await (await responsePromise).text(), `built:${pathname}`);
  }
  assert.deepEqual(
    [...(generationStore?.keys() || [])]
      .map((url) => new URL(url, 'https://easyboost.test').pathname),
    ['/__easyboost/ege-mock-install-mode-v3/1-update'],
  );
});

test('an update preserves an opened lazy EGE executable before activation and restores it offline', async () => {
  const listeners = new Map();
  const oldScreen = 'https://easyboost.test/screens/ege-mock.js';
  const stores = new Map([['easyboost-static-old', new Map([[oldScreen, new Response('old-runner')]])]]);
  const caches = {
    async open(name) {
      const store = stores.get(name) || new Map();
      stores.set(name, store);
      return {
        async addAll(paths) {
          for (const path of paths) store.set(`https://easyboost.test${path}`, await fetch(`https://easyboost.test${path}`));
        },
        async put(key, value) { store.set(typeof key === 'string' ? key : key.url, value); },
        async match(key) { return store.get(typeof key === 'string' ? key : key.url)?.clone(); },
        async keys() { return [...store.keys()].map((url) => ({ url })); },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
    async match(key) {
      for (const store of stores.values()) {
        const value = store.get(typeof key === 'string' ? key : key.url);
        if (value) return value.clone();
      }
      return undefined;
    },
  };
  let online = true;
  async function fetch(request) {
    if (!online) throw new Error('offline');
    const url = typeof request === 'string' ? request : request.url;
    return new Response(`new:${new URL(url).pathname}`);
  }
  const self = {
    location: { origin: 'https://easyboost.test' }, navigator: { locks: immediateLocks },
    addEventListener(type, listener) { listeners.set(type, listener); },
    async skipWaiting() {}, clients: { async claim() {} },
  };
  vm.runInNewContext(source, { self, caches, Headers, URL, Promise, Response, fetch });

  let install;
  listeners.get('install')({ waitUntil(value) { install = value; } });
  await install;
  online = false;
  let activation;
  listeners.get('activate')({ waitUntil(value) { activation = value; } });
  await activation;

  let responsePromise;
  listeners.get('fetch')({
    request: { method: 'GET', mode: 'cors', url: oldScreen },
    respondWith(value) { responsePromise = value; }, waitUntil() {},
  });
  assert.equal(await (await responsePromise).text(), 'new:/screens/ege-mock.js');
  assert.equal([...stores.keys()].some((name) => name.startsWith('easyboost-ege-mock-exec-v1-')), true);
});

test('a source-mode update refreshes a complete stable-path executable cache before going offline', async () => {
  const stores = new Map();
  let version = 'old';
  let online = true;
  const paths = [
    '/screens/ege-mock.js', '/ege-mock-writing-assessment-ui.js', '/ege-mock-written-assets.js',
    '/ege-mock-written-runner.js', '/ege-writing-text.js', '/shared/ege-writing-text.js',
    '/shared/ege-writing-text-sanitizer.js', '/shared/semantic-json.js',
  ];
  const caches = {
    async open(name) {
      const store = stores.get(name) || new Map(); stores.set(name, store);
      return {
        async addAll(requestedPaths) {
          for (const path of requestedPaths) store.set(`https://easyboost.test${path}`, await fetch(`https://easyboost.test${path}`));
        },
        async put(key, value) { store.set(typeof key === 'string' ? key : key.url, value); },
        async match(key) { return store.get(typeof key === 'string' ? key : key.url)?.clone(); },
        async keys() { return [...store.keys()].map((url) => ({ url })); },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
    async match() { return undefined; },
  };
  async function fetch(request) {
    if (!online) throw new Error('offline');
    return new Response(`${version}:${new URL(typeof request === 'string' ? request : request.url).pathname}`);
  }
  function evaluateWorker(active) {
    const listeners = new Map();
    const self = {
      location: { origin: 'https://easyboost.test' }, registration: { active }, navigator: { locks: immediateLocks },
      addEventListener(type, listener) { listeners.set(type, listener); },
      async skipWaiting() {}, clients: { async claim() {} },
    };
    vm.runInNewContext(source, { self, caches, Headers, URL, Promise, Response, fetch });
    return listeners;
  }

  const oldListeners = evaluateWorker({ scriptURL: 'old-worker.js' });
  for (const path of paths) {
    let responsePromise;
    oldListeners.get('fetch')({
      request: { method: 'GET', mode: 'cors', url: `https://easyboost.test${path}` },
      respondWith(value) { responsePromise = value; }, waitUntil() {},
    });
    assert.match(await (await responsePromise).text(), /^old:/u);
  }

  version = 'new';
  const updateListeners = evaluateWorker({ scriptURL: 'old-worker.js' });
  let install; updateListeners.get('install')({ waitUntil(value) { install = value; } }); await install;
  online = false;
  const activationListeners = evaluateWorker({ scriptURL: 'current-worker.js' });
  let activation; activationListeners.get('activate')({ waitUntil(value) { activation = value; } }); await activation;
  let responsePromise;
  activationListeners.get('fetch')({
    request: { method: 'GET', mode: 'cors', url: 'https://easyboost.test/screens/ege-mock.js' },
    respondWith(value) { responsePromise = value; }, waitUntil() {},
  });
  assert.equal(await (await responsePromise).text(), 'new:/screens/ege-mock.js');
  activationListeners.get('fetch')({
    request: { method: 'GET', mode: 'cors', url: 'https://easyboost.test/ege-writing-text.js' },
    respondWith(value) { responsePromise = value; }, waitUntil() {},
  });
  assert.equal(await (await responsePromise).text(), 'new:/ege-writing-text.js');

  online = true;
  version = 'newer';
  const cleanReregistrationListeners = evaluateWorker(null);
  let cleanInstall;
  cleanReregistrationListeners.get('install')({ waitUntil(value) { cleanInstall = value; } });
  await cleanInstall;
  online = false;
  const cleanActivationListeners = evaluateWorker({ scriptURL: 'current-worker.js' });
  let cleanActivation;
  cleanActivationListeners.get('activate')({ waitUntil(value) { cleanActivation = value; } });
  await cleanActivation;
  cleanActivationListeners.get('fetch')({
    request: { method: 'GET', mode: 'cors', url: 'https://easyboost.test/screens/ege-mock.js' },
    respondWith(value) { responsePromise = value; }, waitUntil() {},
  });
  assert.equal(await (await responsePromise).text(), 'newer:/screens/ege-mock.js');
});

test('a clean first activation stays lazy when registration.active becomes the current worker', async () => {
  const installListeners = new Map();
  const stores = new Map();
  let executableFetches = 0;
  const caches = {
    async open(name) {
      const store = stores.get(name) || new Map(); stores.set(name, store);
      return {
        async addAll(paths) {
          if (name.startsWith('easyboost-ege-mock-exec-v1-')) {
            executableFetches += paths.length;
            return;
          }
          for (const resourcePath of paths) {
            store.set(`https://easyboost.test${resourcePath}`, new Response(`shell:${resourcePath}`));
          }
        },
        async put(key, value) { store.set(typeof key === 'string' ? key : key.url, value); },
        async match(key) { return store.get(typeof key === 'string' ? key : key.url)?.clone(); },
        async keys() { return [...store.keys()].map((url) => ({ url })); },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
    async match(key) {
      const cacheKey = typeof key === 'string' ? key : key.url;
      for (const store of stores.values()) {
        const value = store.get(cacheKey);
        if (value) return value.clone();
      }
      return undefined;
    },
  };
  const self = {
    location: { origin: 'https://easyboost.test' }, registration: { active: null }, navigator: { locks: immediateLocks },
    addEventListener(type, listener) { installListeners.set(type, listener); },
    async skipWaiting() {}, clients: { async claim() {} },
  };
  vm.runInNewContext(source, {
    self, caches, Headers, URL, Promise, Response,
    async fetch() { throw new Error('a clean install must not fetch lazy EGE code'); },
  });
  let install; installListeners.get('install')({ waitUntil(value) { install = value; } }); await install;

  const activationListeners = new Map();
  const activatingSelf = {
    location: { origin: 'https://easyboost.test' }, registration: { active: { scriptURL: 'current-worker.js' } },
    addEventListener(type, listener) { activationListeners.set(type, listener); },
    async skipWaiting() {}, clients: { async claim() {} },
  };
  vm.runInNewContext(source, {
    self: activatingSelf, caches, Headers, URL, Promise, Response,
    async fetch() { throw new Error('a clean activation must survive worker-global teardown without fetching EGE'); },
  });
  let activation; activationListeners.get('activate')({ waitUntil(value) { activation = value; } }); await activation;
  assert.equal(executableFetches, 0);
  const executableCache = [...stores.entries()].find(([name]) => name.startsWith('easyboost-ege-mock-exec-v1-'))?.[1];
  assert.equal(executableCache?.size || 0, 0);
  for (const resourcePath of ['/modules/reading.js', '/learning-activity-contract.js']) {
    let responsePromise;
    activationListeners.get('fetch')({
      request: { method: 'GET', mode: 'cors', url: `https://easyboost.test${resourcePath}` },
      respondWith(value) { responsePromise = value; }, waitUntil() {},
    });
    assert.equal(await (await responsePromise).text(), `shell:${resourcePath}`,
      `${resourcePath} must remain reachable from the fresh-install shell while offline`);
  }
});

test('an update replaces a retained clean install decision before preserving its executable', async () => {
  const stores = new Map();
  let phase = 'clean';
  let online = true;
  let releaseUpdateMarker;
  const updateMarkerGate = new Promise((resolve) => { releaseUpdateMarker = resolve; });
  const caches = {
    async open(name) {
      const store = stores.get(name) || new Map(); stores.set(name, store);
      return {
        async addAll(paths) {
          if (!name.startsWith('easyboost-ege-mock-exec-v1-')) return;
          for (const path of paths) {
            store.set(`https://easyboost.test${path}`, await fetch(`https://easyboost.test${path}`));
          }
        },
        async put(key, value) {
          if (phase === 'update' && name.startsWith('easyboost-ege-mock-install-v1-')) await updateMarkerGate;
          store.set(typeof key === 'string' ? key : key.url, value);
        },
        async match(key) { return store.get(typeof key === 'string' ? key : key.url)?.clone(); },
        async keys() { return [...store.keys()].map((url) => ({ url })); },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
    async match() { return undefined; },
  };
  async function fetch(request) {
    if (!online) throw new Error('offline');
    return new Response(`new:${new URL(typeof request === 'string' ? request : request.url).pathname}`);
  }
  function evaluateWorker(active) {
    const listeners = new Map();
    const self = {
      location: { origin: 'https://easyboost.test' }, registration: { active }, navigator: { locks: immediateLocks },
      addEventListener(type, listener) { listeners.set(type, listener); },
      async skipWaiting() {}, clients: { async claim() {} },
    };
    vm.runInNewContext(source, { self, caches, Headers, URL, Promise, Response, fetch });
    return listeners;
  }

  const cleanListeners = evaluateWorker(null);
  let cleanInstall; cleanListeners.get('install')({ waitUntil(value) { cleanInstall = value; } }); await cleanInstall;

  phase = 'update';
  const updateListeners = evaluateWorker({ scriptURL: 'old-worker.js' });
  let updateInstall; updateListeners.get('install')({ waitUntil(value) { updateInstall = value; } });
  await Promise.resolve();
  releaseUpdateMarker();
  await updateInstall;

  phase = 'activation';
  online = false;
  const activationListeners = evaluateWorker({ scriptURL: 'current-worker.js' });
  let activation; activationListeners.get('activate')({ waitUntil(value) { activation = value; } });
  await activation;
  const executableCache = [...stores.entries()].find(([name]) => name.startsWith('easyboost-ege-mock-exec-v1-'))?.[1];
  assert.ok(executableCache?.size, 'the update must finish preserving before an offline activation');
});

test('a clean reinstall replaces a retained update decision before deciding to stay lazy', async () => {
  const stores = new Map();
  let phase = 'update';
  let executableFetches = 0;
  let releaseCleanMarker;
  const cleanMarkerGate = new Promise((resolve) => { releaseCleanMarker = resolve; });
  const caches = {
    async open(name) {
      const store = stores.get(name) || new Map(); stores.set(name, store);
      return {
        async addAll(paths) {
          if (!name.startsWith('easyboost-ege-mock-exec-v1-')) return;
          executableFetches += paths.length;
          for (const path of paths) store.set(`https://easyboost.test${path}`, new Response(`new:${path}`));
        },
        async put(key, value) {
          if (phase === 'clean' && name.startsWith('easyboost-ege-mock-install-v1-')) await cleanMarkerGate;
          store.set(typeof key === 'string' ? key : key.url, value);
        },
        async match(key) { return store.get(typeof key === 'string' ? key : key.url)?.clone(); },
        async keys() { return [...store.keys()].map((url) => ({ url })); },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
    async match() { return undefined; },
  };
  function evaluateWorker(active) {
    const listeners = new Map();
    const self = {
      location: { origin: 'https://easyboost.test' }, registration: { active }, navigator: { locks: immediateLocks },
      addEventListener(type, listener) { listeners.set(type, listener); },
      async skipWaiting() {}, clients: { async claim() {} },
    };
    vm.runInNewContext(source, {
      self, caches, Headers, URL, Promise, Response,
      async fetch(request) { return new Response(`new:${new URL(typeof request === 'string' ? request : request.url).pathname}`); },
    });
    return listeners;
  }

  const updateListeners = evaluateWorker({ scriptURL: 'old-worker.js' });
  let updateInstall; updateListeners.get('install')({ waitUntil(value) { updateInstall = value; } }); await updateInstall;
  for (const name of [...stores.keys()]) if (name.startsWith('easyboost-ege-mock-exec-v1-')) stores.delete(name);
  executableFetches = 0;

  phase = 'clean';
  const cleanListeners = evaluateWorker(null);
  let cleanInstall; cleanListeners.get('install')({ waitUntil(value) { cleanInstall = value; } });
  await Promise.resolve();
  releaseCleanMarker();
  await cleanInstall;
  assert.equal(executableFetches, 0, 'a clean reinstall must not inherit a stale update decision');
});

test('durable install generations survive equal timestamps, rollback and a delayed older write', async () => {
  async function runScenario(olderRevision, newerRevision) {
    const stores = new Map();
    let releaseOlderMarker;
    const olderMarkerGate = new Promise((resolve) => { releaseOlderMarker = resolve; });
    let executableFetches = 0;
    let lockTail = Promise.resolve();
    const locks = {
      request(_name, operation) {
        const result = lockTail.then(operation);
        lockTail = result.catch(() => {});
        return result;
      },
    };
    const caches = {
      async open(name) {
        const store = stores.get(name) || new Map(); stores.set(name, store);
        return {
          async addAll(paths) {
            if (!name.startsWith('easyboost-ege-mock-exec-v1-')) return;
            executableFetches += paths.length;
            for (const path of paths) store.set(`https://easyboost.test${path}`, new Response(`new:${path}`));
          },
          async put(key, value) {
            const normalizedKey = typeof key === 'string' ? key : key.url;
            if (name.startsWith('easyboost-ege-mock-install-v1-') && normalizedKey.endsWith('-clean')) await olderMarkerGate;
            store.set(normalizedKey, value);
          },
          async match(key) { return store.get(typeof key === 'string' ? key : key.url)?.clone(); },
          async keys() { return [...store.keys()].map((url) => ({ url })); },
        };
      },
      async keys() { return [...stores.keys()]; },
      async delete(name) { return stores.delete(name); },
      async match() { return undefined; },
    };
    function evaluateWorker(active, revision) {
      const listeners = new Map();
      const self = {
        location: { origin: 'https://easyboost.test' }, registration: { active }, navigator: { locks },
        addEventListener(type, listener) { listeners.set(type, listener); },
        async skipWaiting() {}, clients: { async claim() {} },
      };
      vm.runInNewContext(source, {
        self, caches, Headers, URL, Promise, Response, Date: { now() { return revision; } },
        async fetch(request) { return new Response(`new:${new URL(typeof request === 'string' ? request : request.url).pathname}`); },
      });
      return listeners;
    }

    const olderListeners = evaluateWorker(null, olderRevision);
    let olderInstall; olderListeners.get('install')({ waitUntil(value) { olderInstall = value; } });
    await Promise.resolve();
    const newerListeners = evaluateWorker({ scriptURL: 'old-worker.js' }, newerRevision);
    let newerInstall; newerListeners.get('install')({ waitUntil(value) { newerInstall = value; } });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    releaseOlderMarker();
    await Promise.all([olderInstall, newerInstall]);

    const decisionKeys = [...stores.entries()]
      .filter(([name]) => name.startsWith('easyboost-ege-mock-install-v1-'))
      .flatMap(([, store]) => [...store.keys()])
      .filter((key) => key.includes('/__easyboost/ege-mock-install-mode-v3/'));
    const latestDecision = decisionKeys.sort((left, right) => Number(/v3\/(\d+)-/u.exec(left)?.[1]) - Number(/v3\/(\d+)-/u.exec(right)?.[1])).at(-1);
    assert.match(latestDecision, /-update$/u, 'the causally newer update must own the greatest durable generation');
    executableFetches = 0;
    const activationListeners = evaluateWorker({ scriptURL: 'current-worker.js' }, 300);
    let activation; activationListeners.get('activate')({ waitUntil(value) { activation = value; } }); await activation;
    assert.equal(executableFetches, 0, 'activation must validate the installed generation without network');
  }

  await runScenario(100, 100);
  await runScenario(200, 100);
});

test('activation closes the late-open race before deleting the old lazy EGE executable', async () => {
  const listeners = new Map();
  const oldScreen = 'https://easyboost.test/assets/ege-mock-old.js';
  const oldStore = new Map();
  const stores = new Map([['easyboost-static-old', oldStore]]);
  const caches = {
    async open(name) {
      const store = stores.get(name) || new Map(); stores.set(name, store);
      return {
        async addAll(paths) { for (const path of paths) store.set(`https://easyboost.test${path}`, await fetch(`https://easyboost.test${path}`)); },
        async put(key, value) { store.set(typeof key === 'string' ? key : key.url, value); },
        async match(key) { return store.get(typeof key === 'string' ? key : key.url)?.clone(); },
        async keys() { return [...store.keys()].map((url) => ({ url })); },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
    async match() { return undefined; },
  };
  let online = true;
  async function fetch(request) {
    if (!online) throw new Error('offline');
    return new Response(`new:${new URL(typeof request === 'string' ? request : request.url).pathname}`);
  }
  const self = { location: { origin: 'https://easyboost.test' }, registration: { active: { scriptURL: 'old-worker.js' } }, navigator: { locks: immediateLocks }, addEventListener(type, listener) { listeners.set(type, listener); },
    async skipWaiting() {}, clients: { async claim() {} } };
  vm.runInNewContext(source, { self, caches, Headers, URL, Promise, Response, fetch });
  let install; listeners.get('install')({ waitUntil(value) { install = value; } }); await install;
  oldStore.set(oldScreen, new Response('late-old-runner'));
  let activation; listeners.get('activate')({ waitUntil(value) { activation = value; } }); await activation;
  online = false;
  const executableCache = [...stores.entries()].find(([name]) => name.startsWith('easyboost-ege-mock-exec-v1-'))?.[1];
  assert.ok(executableCache?.size, 'activation must observe a late-opened EGE runner before old-cache deletion');
});

test('an updating worker preloads the exact executable before an open races inside activation', async () => {
  const listeners = new Map();
  const stores = new Map([['easyboost-static-old', new Map()]]);
  let activationKeyReads = 0;
  let activationStarted = false;
  const caches = {
    async open(name) {
      const store = stores.get(name) || new Map(); stores.set(name, store);
      return {
        async addAll(paths) { for (const path of paths) store.set(`https://easyboost.test${path}`, await fetch(`https://easyboost.test${path}`)); },
        async put(key, value) { store.set(typeof key === 'string' ? key : key.url, value); },
        async match(key) { return store.get(typeof key === 'string' ? key : key.url)?.clone(); },
        async keys() { return [...store.keys()].map((url) => ({ url })); },
      };
    },
    async keys() {
      if (activationStarted && ++activationKeyReads === 1) {
        const snapshot = [...stores.keys()];
        queueMicrotask(() => stores.set('easyboost-static-late-open', new Map([
          ['https://easyboost.test/assets/ege-mock-old.js', new Response('late-old-runner')],
        ])));
        return snapshot;
      }
      return [...stores.keys()];
    },
    async delete(name) { return stores.delete(name); },
    async match() { return undefined; },
  };
  async function fetch(request) {
    return new Response(`new:${new URL(typeof request === 'string' ? request : request.url).pathname}`);
  }
  const self = {
    location: { origin: 'https://easyboost.test' }, registration: { active: { scriptURL: 'old-worker.js' } }, navigator: { locks: immediateLocks },
    addEventListener(type, listener) { listeners.set(type, listener); }, async skipWaiting() {},
    clients: { async claim() {} },
  };
  vm.runInNewContext(source, { self, caches, Headers, URL, Promise, Response, fetch, queueMicrotask });
  let install; listeners.get('install')({ waitUntil(value) { install = value; } }); await install;
  activationStarted = true;
  let activation; listeners.get('activate')({ waitUntil(value) { activation = value; } }); await activation;
  const executableCache = [...stores.entries()].find(([name]) => name.startsWith('easyboost-ege-mock-exec-v1-'))?.[1];
  assert.ok(executableCache?.size, 'an update must not depend on one racy opened-cache snapshot');
  assert.match(source, /easyboost-ege-mock-open-v1/u);
});
