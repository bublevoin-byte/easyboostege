import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../public/store.js', import.meta.url), 'utf8');

function createStore(initial = {}) {
  const values = new Map(Object.entries(initial));
  const localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  };
  const sync = Object.freeze({ saveProgress() {}, setBaseline() {} });
  const window = { localStorage, EasyBoostSync: sync };
  vm.runInNewContext(source, { window, Date, JSON, Object });
  return { store: window.EasyBoostStore, values, sync };
}

test('frontend store normalizes and persists isolated user state', () => {
  const { store, values } = createStore();
  const state = store.normalize({ learned: 4 });
  assert.equal(state.learned, 4);
  assert.deepEqual(Object.keys(state.prog), ['words', 'gram', 'read', 'listen', 'write', 'speak']);
  assert.equal(store.saveLocal('student', state), true);
  assert.equal(JSON.parse(values.get('eb_data_student')).learned, 4);
  assert.equal(store.loadLocal('student').learned, 4);
});

test('frontend store exposes the offline synchronization layer', () => {
  const { store, sync } = createStore({ eb_data_broken: '{invalid' });
  assert.equal(store.sync, sync);
  assert.equal(store.loadLocal('broken').learned, 0);
  assert.equal(store.saveLocal('', {}), false);
});
