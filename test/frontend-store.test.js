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

test('listening rotation history remains isolated in the existing per-user offline snapshots', () => {
  const { store } = createStore();
  const student = store.normalize({
    listeningPilotHistory: {
      version: 1,
      items: {
        'listening-pilot-v1.matching.sample@1': {
          id: 'listening-pilot-v1.matching.sample', revision: 1, attempts: 1,
          lastScore: 4, lastMaxScore: 6, lastAttemptAt: 100,
          transcriptExposed: true,
          help: { slowPlayback: false, additionalPlaybacks: 0, synthFallback: false },
        },
      },
      lastSelected: { matching: { id: 'listening-pilot-v1.matching.sample', revision: 1 } },
    },
  });
  assert.equal(store.saveLocal('student-a', student), true);

  assert.equal(store.loadLocal('student-b').listeningPilotHistory, undefined);
  assert.equal(Object.keys(store.loadLocal('student-a').listeningPilotHistory.items).length, 1);
});

test('frontend store exposes the offline synchronization layer', () => {
  const { store, sync } = createStore({ eb_data_broken: '{invalid' });
  assert.equal(store.sync, sync);
  assert.equal(store.loadLocal('broken').learned, 0);
  assert.equal(store.saveLocal('', {}), false);
});

test('restore prefers the server answer and normalizes it', () => {
  const { store } = createStore({ eb_data_student: JSON.stringify({ learned: 4, streak: 9 }) });
  const state = store.restore('student', { learned: 12 }, {});

  assert.equal(state.learned, 12);
  assert.equal(state.streak, 0, 'the server answer replaces the snapshot, it is not merged into it');
  assert.deepEqual(Object.keys(state.prog), ['words', 'gram', 'read', 'listen', 'write', 'speak']);
});

test('restore falls back to the local snapshot when the network is gone', () => {
  const { store } = createStore({
    eb_data_student: JSON.stringify({ learned: 4, streak: 9, box: { apple: 3 }, prog: { words: 40 } }),
  });
  const state = store.restore('student', null, {});

  assert.equal(state.learned, 4);
  assert.equal(state.streak, 9);
  assert.equal(state.box.apple, 3);
  assert.equal(state.prog.words, 40);
});

test('restore starts from zero on a device with no snapshot', () => {
  const { store } = createStore();
  const state = store.restore('newcomer', null, {});

  assert.equal(state.learned, 0);
  assert.equal(state.streak, 0);
  assert.deepEqual(Object.keys(state.box), []);
});

test('queued modules win over both the server answer and the snapshot', () => {
  const { store } = createStore({ eb_data_student: JSON.stringify({ learned: 4 }) });
  const fromServer = store.restore('student', { learned: 12, srs: { a: 1 } }, { learned: 15 });
  const offline = store.restore('student', null, { learned: 15 });

  assert.equal(fromServer.learned, 15);
  assert.deepEqual({ ...fromServer.srs }, { a: 1 }, 'untouched modules keep the server value');
  assert.equal(offline.learned, 15);
  assert.equal(store.applyModules({ learned: 1 }, { learned: undefined }).learned, 1);
  assert.equal(store.applyModules({ learned: 1 }, null).learned, 1);
});
