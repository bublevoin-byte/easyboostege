import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const stubs = JSON.parse(await fs.readFile(new URL('../quality/writing-fipi-stubs.json', import.meta.url), 'utf8'));

const LIMITS = {
  writing_37: { max: 6, criteria: { k1: 2, k2: 2, k3: 2 } },
  writing_38: { max: 14, criteria: { k1: 3, k2: 3, k3: 3, k4: 3, k5: 2 } },
};

test('the stub file keeps the works extracted from the manuals', () => {
  const ids = new Set(stubs.map((item) => item.id));
  assert.equal(ids.size, stubs.length, 'ids must be unique');
  const count = (operation) => stubs.filter((item) => item.operation === operation).length;
  // Section 11.1 asks for 20 and 30; the manuals give fewer, so these are floors, not the target.
  assert.ok(count('writing_37') >= 13, `task 37 stubs dropped to ${count('writing_37')}`);
  assert.ok(count('writing_38') >= 9, `task 38 stubs dropped to ${count('writing_38')}`);
});

test('expert scores stay inside the official maxima and add up', () => {
  for (const item of stubs) {
    const limit = LIMITS[item.operation];
    assert.ok(limit, `${item.id}: unknown operation ${item.operation}`);
    assert.equal(item.human.max, limit.max, `${item.id}: wrong maximum`);
    assert.ok(item.human.total >= 0 && item.human.total <= limit.max, `${item.id}: total out of range`);
    if (!item.human.criteria) {
      assert.ok(item.tags.includes('total-only'), `${item.id}: a stub without criteria must say so`);
      continue;
    }
    assert.deepEqual(Object.keys(item.human.criteria), Object.keys(limit.criteria), `${item.id}: criteria set`);
    for (const [name, score] of Object.entries(item.human.criteria)) {
      assert.ok(score >= 0 && score <= limit.criteria[name], `${item.id}: ${name} = ${score} exceeds ${limit.criteria[name]}`);
    }
    const sum = Object.values(item.human.criteria).reduce((total, score) => total + score, 0);
    assert.equal(sum, item.human.total, `${item.id}: criteria do not add up to the total`);
  }
});

test('each stub carries its assignment, its source and its reviewer', () => {
  for (const item of stubs) {
    assert.ok(item.assignment && item.assignment.length > 60, `${item.id}: assignment is missing`);
    assert.doesNotMatch(item.assignment, /[А-Яа-яЁё]/u, `${item.id}: assignment must be the English condition`);
    assert.match(item.human.reviewer, /^fipi-20\d\d-expert-manual$/u, `${item.id}: reviewer is recorded`);
    assert.match(item.source.manual, /^fipi-pch-20\d\d\.pdf$/u, `${item.id}: source manual is recorded`);
  }
});

test('a stub without the answer text is marked as unfinished', () => {
  for (const item of stubs) {
    if (item.answer) {
      assert.ok(!item.tags.includes('needs-answer-text'), `${item.id}: the answer is typed in, drop the tag`);
      continue;
    }
    assert.ok(item.tags.includes('needs-answer-text'), `${item.id}: an empty answer must be tagged`);
  }
});
