import assert from 'node:assert/strict';
import test from 'node:test';

import { createEgeMockOralMedia } from '../public/ege-mock-oral-media.js';

function memoryCacheStorage() {
  const stores = new Map();
  return {
    stores,
    async open(name) {
      const store = stores.get(name) || new Map();
      stores.set(name, store);
      return {
        async match(key) { return store.get(String(key))?.clone(); },
        async put(key, response) { store.set(String(key), response.clone()); },
        async delete(key) { return store.delete(String(key)); },
      };
    },
  };
}

const exactForm = Object.freeze({
  identity: 'ege-en-2026-form-1@1',
  fingerprint: `sha256:${'b'.repeat(64)}`,
});
const immediateLocks = Object.freeze({ request(_name, operation) { return operation(); } });

test('oral media returns an automatically stopped recording exactly once', async () => {
  let recordingReady;
  const calls = [];
  const recorder = {
    async checkMicrophone() { return { status: 'passed', level: 0.5 }; },
    async start(limit) { calls.push(['start', limit]); },
    async stop() {
      const error = new Error('already stopped');
      error.code = 'RECORDING_NOT_ACTIVE';
      throw error;
    },
    dispose() {},
  };
  const media = createEgeMockOralMedia({
    indexedDB: {}, Image: class FakeImage {},
    createRecorder(options) {
      recordingReady = options.onRecordingReady;
      return recorder;
    },
    async convertRecording(blob) {
      calls.push(['convert', await blob.text()]);
      return { blob: new Blob(['wav']), durationSeconds: 20 };
    },
  });

  await media.startRecording(20);
  recordingReady({ blob: new Blob(['source']), durationSeconds: 20 });
  const result = await media.stopRecording();

  assert.equal(result.durationSeconds, 20);
  assert.match(result.sha256, /^[a-f0-9]{64}$/u);
  assert.match(result.recordingId, /^[0-9a-f-]{36}$/u);
  assert.deepEqual(calls, [['start', 20], ['convert', 'source']]);
});

test('oral media can discard a capture without converting or reusing it for another response', async () => {
  const calls = [];
  const media = createEgeMockOralMedia({
    indexedDB: {}, Image: class FakeImage {},
    createRecorder: () => ({
      async checkMicrophone() { return { status: 'passed', level: 0.5 }; },
      async start(limit) { calls.push(['start', limit]); },
      async stop() {
        calls.push(['stop']);
        return { blob: new Blob(['discarded']), durationSeconds: 4 };
      },
      dispose() {},
    }),
    async convertRecording() {
      calls.push(['convert']);
      return { blob: new Blob(['wav']), durationSeconds: 4 };
    },
  });

  await media.startRecording(20);
  await media.cancelRecording();
  await media.startRecording(15);

  assert.deepEqual(calls, [['start', 20], ['stop'], ['start', 15]]);
});

test('one cross-tab recording lease owns microphone capture and transfers after release', async () => {
  let locked = false;
  const lockManager = {
    request(_name, options, operation) {
      if (options?.ifAvailable && locked) return Promise.resolve(operation(null));
      locked = true;
      return Promise.resolve(operation({ name: _name })).finally(() => { locked = false; });
    },
  };
  const options = {
    indexedDB: {}, Image: class FakeImage {}, lockManager,
    createRecorder: () => ({
      async checkMicrophone() { return { status: 'passed', level: 0.4 }; },
      async start() {}, async stop() {}, dispose() {},
    }),
  };
  const first = createEgeMockOralMedia(options);
  const second = createEgeMockOralMedia(options);
  assert.equal(await first.acquireRecordingLease('owner:attempt'), true);
  assert.equal(first.hasRecordingLease(), true);
  assert.equal(await second.acquireRecordingLease('owner:attempt'), false,
    'a peer tab observes but cannot start a second recorder');
  first.releaseRecordingLease();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await second.acquireRecordingLease('owner:attempt'), true,
    'a surviving tab may resume after the original owner closes');
  second.dispose();
});

test('oral preflight verifies the immutable task-4 composite image before the timer', async () => {
  const loaded = [];
  const verifiedBlobs = [];
  const bytes = new TextEncoder().encode('immutable-pair');
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
    .map((value) => value.toString(16).padStart(2, '0')).join('');
  class FakeImage {
    decode() { return Promise.resolve(); }
    set src(value) { loaded.push(value); queueMicrotask(() => this.onload()); }
  }
  const media = createEgeMockOralMedia({
    indexedDB: {}, Image: FakeImage,
    cacheStorage: memoryCacheStorage(), lockManager: immediateLocks,
    URL: {
      createObjectURL(blob) { verifiedBlobs.push(blob); return 'blob:verified-pair'; },
      revokeObjectURL() {},
    },
    fetch: async () => new Response(bytes, {
      status: 200, headers: { 'content-type': 'image/png' },
    }),
    createRecorder: () => ({
      async checkMicrophone() { return { status: 'passed', level: 0.4 }; },
      dispose() {},
    }),
  });
  const result = await media.preflight({
    form: exactForm,
    tasks: [{ presentation: { photoPair: { src: '/pair.png' } } }],
    assets: [{ path: '/pair.png', kind: 'image', mimeType: 'image/png', sha256: digest }],
  });
  assert.equal(result.assetCount, 1);
  assert.deepEqual(loaded, ['blob:verified-pair']);
  assert.equal(await verifiedBlobs[0].text(), 'immutable-pair');
  assert.equal(media.assetUrl('/pair.png'), 'blob:verified-pair');
});

test('oral task-42 image reloads offline from the exact form fingerprint and digest cache', async () => {
  const bytes = new TextEncoder().encode('immutable-task-42-pair');
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
    .map((value) => value.toString(16).padStart(2, '0')).join('');
  const cacheStorage = memoryCacheStorage();
  let online = true;
  let fetchCalls = 0;
  const loaded = [];
  class FakeImage {
    decode() { return Promise.resolve(); }
    set src(value) { loaded.push(value); queueMicrotask(() => this.onload()); }
  }
  const options = {
    indexedDB: {}, Image: FakeImage, cacheStorage, lockManager: immediateLocks,
    URL: {
      createObjectURL() { return `blob:pair-${loaded.length + 1}`; },
      revokeObjectURL() {},
    },
    async fetch() {
      fetchCalls += 1;
      if (!online) throw new Error('offline');
      return new Response(bytes, { status: 200, headers: { 'content-type': 'image/png' } });
    },
    createRecorder: () => ({
      async checkMicrophone() { return { status: 'passed', level: 0.4 }; },
      dispose() {},
    }),
  };
  const input = {
    form: exactForm,
    tasks: [{ presentation: { photoPair: { src: '/pair.png' } } }],
    assets: [{ path: '/pair.png', kind: 'image', mimeType: 'image/png', sha256: digest }],
  };
  const first = createEgeMockOralMedia(options);
  assert.equal((await first.preflight(input)).assetCount, 1);
  first.dispose();
  online = false;
  const restored = createEgeMockOralMedia(options);
  assert.equal((await restored.preflight(input)).assetCount, 1);
  assert.equal(restored.assetUrl('/pair.png'), 'blob:pair-2');
  assert.equal(fetchCalls, 1, 'offline reload reads the exact cached bytes without a network call');
  assert.equal([...cacheStorage.stores.keys()].some((name) => (
    name.includes(exactForm.identity) && name.includes(exactForm.fingerprint.slice(7))
  )), true);
});

test('oral preflight rejects immutable image bytes or MIME that do not match the form manifest', async () => {
  const media = createEgeMockOralMedia({
    indexedDB: {}, Image: class FakeImage {},
    cacheStorage: memoryCacheStorage(), lockManager: immediateLocks,
    URL: { createObjectURL() { return 'blob:invalid'; }, revokeObjectURL() {} },
    fetch: async () => new Response(new Uint8Array([1, 2, 3]), {
      status: 200, headers: { 'content-type': 'image/jpeg' },
    }),
    createRecorder: () => ({
      async checkMicrophone() { return { status: 'passed', level: 0.4 }; },
      dispose() {},
    }),
  });
  await assert.rejects(() => media.preflight({
    form: exactForm,
    tasks: [{ presentation: { photoPair: { src: '/pair.png' } } }],
    assets: [{ url: '/pair.png', mimeType: 'image/png', sha256: 'a'.repeat(64) }],
  }), { message: 'EGE_MOCK_ORAL_ASSET_INVALID' });
});

test('oral preflight normalizes an unavailable asset response before reading bytes', async () => {
  const media = createEgeMockOralMedia({
    indexedDB: {}, Image: class FakeImage {},
    cacheStorage: memoryCacheStorage(), lockManager: immediateLocks,
    URL: { createObjectURL() { return 'blob:unreachable'; }, revokeObjectURL() {} },
    fetch: async () => ({ ok: false, headers: { get() { return 'image/png'; } } }),
    createRecorder: () => ({
      async checkMicrophone() { return { status: 'passed', level: 0.4 }; },
      dispose() {},
    }),
  });
  await assert.rejects(() => media.preflight({
    form: exactForm,
    tasks: [{ presentation: { photoPair: { src: '/pair.png' } } }],
    assets: [{ path: '/pair.png', kind: 'image', mimeType: 'image/png', sha256: 'a'.repeat(64) }],
  }), { message: 'EGE_MOCK_ORAL_ASSET_UNAVAILABLE' });
});
