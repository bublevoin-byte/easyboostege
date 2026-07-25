import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../public/modules/grammar.js', import.meta.url), 'utf8');

function createGrammarModule() {
  const window = {};
  vm.runInNewContext(source, { window, Object, String, Number, Math, Date });
  return window.EasyBoostGrammar;
}

test('grammar module normalizes answers and reports closed and due topics', () => {
  const grammar = createGrammarModule();
  const records = {
    1: { st: 2, due: 100 },
    2: { st: 2, due: 900 },
    3: { st: 1, due: 50 },
  };

  assert.equal(grammar.normalizeAnswer("  Hasn't... "), 'hasnt');
  assert.equal(grammar.countClosed(records), 2);
  assert.deepEqual(Array.from(grammar.dueTopics(records, { now: 500 })), [1]);
  assert.equal(grammar.formatDuration(125), '2:05');
});

test('grammar module combines built-in and generated banks and builds level queues', () => {
  const grammar = createGrammarModule();
  const choice = { t: ['A ', ' B'], o: ['x', 'y'], a: 0 };
  const fill = { s: 'A _____ B', ans: ['x'] };
  const bank = grammar.effectiveBank(
    { c: [choice], c2: [] },
    [{ k: 'c', q: choice }, { k: 'f', q: fill }],
  );
  const initial = grammar.buildTopicQueue(bank, 4, { st: 0 }, () => 0.5);
  const continuing = grammar.buildTopicQueue(bank, 4, { st: 1 }, () => 0.5);

  assert.equal(bank.c.length, 2);
  assert.equal(bank.f.length, 1);
  assert.equal(initial.filter((item) => item.k === 'c').length, 2);
  assert.equal(initial.filter((item) => item.k === 'f').length, 1);
  assert.equal(continuing.length, 3);
});

test('grammar module applies learning and review answers with spaced repetition', () => {
  const grammar = createGrammarModule();
  const record = { st: 1, ok: 0, err: 0, sr: 3 };
  const item = { k: 'f', t: 2, q: {} };
  const session = { queue: [item], mode: 'learn', ok: 0, done: 0, errT: {} };

  grammar.applyAnswer(record, session, item, true, 1_000);
  assert.equal(record.st, 2);
  assert.equal(record.sr, 4);
  assert.equal(record.due, 1_000 + 7 * 86_400_000);
  assert.equal(session.ok, 1);

  const reviewRecord = { st: 2, ok: 1, err: 0, sr: 4 };
  const review = { queue: [item], mode: 'rev', ok: 0, done: 0, errT: {} };
  grammar.applyAnswer(reviewRecord, review, item, false, 2_000);
  assert.equal(reviewRecord.err, 1);
  assert.equal(review.errT[2], 1);
  assert.equal(review.queue.length, 2);
});
