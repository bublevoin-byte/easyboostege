import assert from 'node:assert/strict';
import test from 'node:test';
import { EGE_MOCK_FORM_1_V1_PUBLIC as form } from '../public/ege-mock-form-1-v1.js';
import {
  createEgeMockAssetPreflight, egeMockAssetPlaybackUrl, egeMockWrittenAssetManifest,
} from '../public/ege-mock-written-assets.js';

function responseFor(asset) {
  const body = new Uint8Array(asset.bytes);
  return {
    ok: true, status: 200,
    headers: { get(name) { return name.toLowerCase() === 'content-type' ? asset.mimeType : null; } },
    clone() { return responseFor(asset); },
    async arrayBuffer() { return body.buffer.slice(0); },
  };
}

function serialLocks() {
  let tail = Promise.resolve();
  return {
    request(_name, callback) {
      const result = tail.then(callback);
      tail = result.catch(() => {});
      return result;
    },
  };
}

test('written preflight verifies and caches the exact 20 immutable audio assets', async () => {
  const manifest = egeMockWrittenAssetManifest(form);
  assert.equal(manifest.length, 20);
  assert.equal(manifest.every((asset) => asset.kind === 'audio' && asset.path.endsWith('.mp3')), true);
  assert.equal(manifest.some((asset) => asset.path.includes('/speaking/')), false);
  const cached = new Map();
  const cache = {
    async put(key, response) { cached.set(String(key), response); },
    async match(key) { return cached.get(String(key)); },
  };
  const cacheStorage = {
    async open() { return cache; },
    async delete() { cached.clear(); return true; },
  };
  const requested = [];
  const assetsByPath = new Map(manifest.map((asset) => [asset.path, asset]));
  const adapter = createEgeMockAssetPreflight({
    cacheStorage, playbackControl: async () => true, lockManager: serialLocks(),
    async fetch(path, options) {
      requested.push({ path, options });
      return responseFor(assetsByPath.get(path));
    },
    async digest(_bytes, asset) { return asset.sha256; },
  });

  const evidence = await adapter.preflight(form);
  assert.deepEqual(evidence, {
    schema: 'ege-mock-written-assets-v1', identity: form.identity,
    fingerprint: form.fingerprint, assetCount: 20,
  });
  assert.equal(requested.length, 20);
  assert.equal(requested.every(({ options }) => options.cache === 'no-store'), true);
  assert.equal(await adapter.isReady(form, evidence), true);
});

test('preflight fails before fetching when no exact-capable service worker controls playback', async () => {
  let fetches = 0;
  const adapter = createEgeMockAssetPreflight({
    cacheStorage: { async open() { return { async match() {}, async put() {} }; } },
    async fetch() { fetches += 1; throw new Error('must not fetch'); },
    playbackControl: async () => false,
    lockManager: serialLocks(),
  });

  await assert.rejects(adapter.preflight(form), /SERVICE_WORKER_REQUIRED/u);
  assert.equal(fetches, 0);
});

test('concurrent same-form preflights publish one complete cache without destructive repopulation', async () => {
  const manifest = egeMockWrittenAssetManifest(form);
  const stores = new Map();
  const cacheStorage = {
    async open(name) {
      const store = stores.get(name) || new Map();
      stores.set(name, store);
      return {
        async put(key, response) { store.set(String(key), response); },
        async match(key) { return store.get(String(key)); },
      };
    },
    async delete(name) { return stores.delete(name); },
  };
  let releaseFirst;
  let firstEntered;
  const entered = new Promise((resolve) => { firstEntered = resolve; });
  const release = new Promise((resolve) => { releaseFirst = resolve; });
  let fetches = 0;
  const byPath = new Map(manifest.map((asset) => [asset.path, asset]));
  const adapter = createEgeMockAssetPreflight({
    cacheStorage, playbackControl: async () => true, lockManager: serialLocks(),
    async fetch(path) {
      fetches += 1;
      if (fetches === 1) { firstEntered(); await release; }
      return responseFor(byPath.get(path));
    },
    async digest(_bytes, asset) { return asset.sha256; },
  });

  const first = adapter.preflight(form);
  await entered;
  const second = adapter.preflight(form);
  releaseFirst();
  const [left, right] = await Promise.all([first, second]);

  assert.deepEqual(left, right);
  assert.equal(fetches, 20);
  assert.equal(await adapter.isReady(form, left), true);
});

test('playback URL binds service-worker lookup to the exact form fingerprint cache', () => {
  const asset = egeMockWrittenAssetManifest(form)[0];
  const url = new URL(egeMockAssetPlaybackUrl(form, asset.path), 'https://easyboost.test');
  assert.equal(url.pathname, asset.path);
  assert.match(url.searchParams.get('egeMockAssetCache'),
    /^easyboost-ege-mock-assets-v1-ege-en-2026-form-1@1-[a-f0-9]{64}$/u);
  assert.equal(url.searchParams.get('egeMockAssetDigest'), asset.sha256);
});
