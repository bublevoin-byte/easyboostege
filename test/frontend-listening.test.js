import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../public/modules/listening.js', import.meta.url), 'utf8');

function createListeningModule() {
  const window = {};
  vm.runInNewContext(source, { window, Object, Number, Math, Array });
  return window.EasyBoostListening;
}

test('listening module normalizes state and calculates aggregate accuracy', () => {
  const listening = createListeningModule();
  const state = listening.normalizeState({ m: { ok: 3, tot: 4 }, done: 2 });
  state.tf = { ok: 2, tot: 5 };
  state.iq = { ok: 3, tot: 4 };

  assert.deepEqual(
    { ...listening.summary(state) },
    { correct: 8, total: 13, accuracy: 62, completed: 2 },
  );
});

test('listening module remaps matching answers and enforces unique selections', () => {
  const listening = createListeningModule();
  const shuffled = listening.shuffleMatching({
    st: ['A', 'B', 'C'],
    sp: [{ t: 'one' }, { t: 'two' }],
    a: [0, 2],
    k: ['one', 'two'],
  }, () => 0);

  shuffled.a.forEach((answer, index) => {
    assert.equal(shuffled.st[answer], index === 0 ? 'A' : 'C');
  });
  assert.deepEqual(Array.from(listening.selectUnique([0, 1, null], 2, 1)), [0, null, 1]);
});

test('listening module scores an exam and enforces the playback limit', () => {
  const listening = createListeningModule();
  const result = listening.scoreExam({
    m: { a: [0, 1] },
    tf: { st: [{ a: 2 }, { a: 0 }] },
    iq: { qs: [{ a: 1 }, { a: 2 }] },
    selM: [0, 2],
    selT: [2, 0],
    selI: [1, 0],
  });
  const plays = [0, 0, 0];

  assert.deepEqual({ ...result }, { matching: 1, trueFalse: 2, interview: 1, total: 4 });
  assert.equal(listening.registerPlay(plays, 1), true);
  assert.equal(listening.registerPlay(plays, 1), true);
  assert.equal(listening.registerPlay(plays, 1), false);
  assert.deepEqual(plays, [0, 2, 0]);
  assert.deepEqual(Array.from(listening.pool([1], [2, 3])), [1, 2, 3]);
});
