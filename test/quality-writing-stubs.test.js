import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import { isDerivedTag, mergeStubs } from '../scripts/extract-quality-writing.js';

const stubs = JSON.parse(await fs.readFile(new URL('../quality/writing-fipi-stubs.json', import.meta.url), 'utf8'));

const LIMITS = {
  writing_37: { max: 6, criteria: { k1: 2, k2: 2, k3: 2 } },
  writing_38: { max: 14, criteria: { k1: 3, k2: 3, k3: 3, k4: 3, k5: 2 } },
};

test('the stub file keeps the works extracted from the manuals', () => {
  const ids = new Set(stubs.map((item) => item.id));
  assert.equal(ids.size, stubs.length, 'ids must be unique');
  const count = (operation) => stubs.filter((item) => item.operation === operation).length;
  /*
   * Section 11.1 asks for 20 and 30; the manuals give fewer, so these are floors against silent
   * loss, not the target. Task 37 stood at 13 until work 4798 turned out to be one work printed
   * by two manuals: the 2025 heading is set in capitals, the extractor read only the capitalised
   * form it expected, and a work without a number could not be recognised as a reprint. Twelve is
   * therefore the corrected pre-2022 count, not a work lost. The reviewed 2022 import then added
   * three full works to each operation; lowering either new floor needs the same kind of evidence.
   */
  assert.ok(count('writing_37') >= 15, `task 37 stubs dropped to ${count('writing_37')}`);
  assert.ok(count('writing_38') >= 12, `task 38 stubs dropped to ${count('writing_38')}`);
  // Two records of one work is the failure that cost this correction; catch it by number.
  const numbered = stubs.filter((item) => item.source.work).map((item) => `${item.operation}|${item.source.work}|${item.human.total}`);
  assert.equal(new Set(numbered).size, numbered.length, 'the same work appears twice under one number and score');
});

test('the six reviewed 2022 works are complete, sourced and have no AI runs', () => {
  const reviewed = stubs.filter((item) => item.tags.includes('fipi-2022'));
  assert.equal(reviewed.length, 6);
  assert.equal(reviewed.filter((item) => item.operation === 'writing_37').length, 3);
  assert.equal(reviewed.filter((item) => item.operation === 'writing_38').length, 3);

  for (const item of reviewed) {
    assert.ok(item.answer.length > 100, `${item.id}: reviewed answer is missing`);
    assert.ok(item.assignmentData, `${item.id}: structured assignment is missing`);
    assert.ok(item.tags.includes('full-answer'), `${item.id}: full-answer provenance is missing`);
    assert.ok(item.tags.includes('official-expert-score'), `${item.id}: expert provenance is missing`);
    assert.ok(item.source.answerReview, `${item.id}: answer review method is missing`);
    assert.equal(item.source.originalTask, item.operation === 'writing_37' ? 39 : 40);
    assert.deepEqual(item.aiRuns, [], `${item.id}: the import must not launch or invent an AI run`);
  }

  const zeroRule = reviewed.find((item) => item.id === 'w38-fipi-2022-literary-genres-7611');
  assert.equal(zeroRule.human.total, 0);
  assert.deepEqual(zeroRule.human.criteria, { k1: 0, k2: 0, k3: 0, k4: 0, k5: 0 });
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

/*
 * `npm run quality:stubs` пересобирает набор из методичек, а в наборе лежит то, чего в методичках
 * нет: тексты работ со сканов, разобранные условия, проценты диаграмм, оплаченные прогоны ИИ.
 * Ниже — то, что пересборка обязана оставить в покое. `rebuilt` изображает свежую заготовку из
 * PDF: та же работа, но без всего набранного руками и с вернувшимися тегами «не сделано».
 */
const rebuilt = (item) => {
  // The 2022 manifest is itself the reviewed source: unlike an ordinary scan stub it can and must
  // reproduce the answer and the visually checked table on a clean checkout.
  const reviewed = Boolean(item.source.answerReview);
  return {
    id: item.id,
    operation: item.operation,
    tags: reviewed ? item.tags : [
      ...item.tags.filter((tag) => isDerivedTag(tag) && tag !== 'needs-answer-text'),
      'needs-answer-text',
      ...(item.tags.includes('assignment-typed') ? ['assignment-partial'] : []),
    ],
    assignment: item.assignment,
    ...(reviewed ? { assignmentData: item.assignmentData } : {}),
    answer: reviewed ? item.answer : '',
    human: item.human,
    source: item.source,
    expectedCriticalErrors: [],
    aiRuns: [],
  };
};

test('a rebuild from the manuals merges into the dataset instead of overwriting it', () => {
  const merged = mergeStubs(stubs, stubs.map(rebuilt));

  assert.equal(merged.missing.length, 0, 'every work of the dataset is in the rebuild of itself');
  assert.equal(merged.added.length, 0, 'a rebuild of the dataset adds nothing');
  assert.deepEqual(merged.updated, [], 'nothing came out of the manuals differently, so nothing changes');
  assert.equal(merged.untouched.length, stubs.length);
  // Побайтовое равенство: в наборе нет поля, которое пересборка сдвинула бы или переписала.
  assert.equal(JSON.stringify(merged.stubs, null, 2), JSON.stringify(stubs, null, 2));

  for (const [index, item] of merged.stubs.entries()) {
    const before = stubs[index];
    assert.equal(item.answer, before.answer, `${item.id}: the typed answer survives the rebuild`);
    assert.deepEqual(item.assignmentData, before.assignmentData, `${item.id}: assignmentData survives`);
    assert.deepEqual(item.aiRuns, before.aiRuns, `${item.id}: paid AI runs survive`);
    assert.deepEqual(item.expectedCriticalErrors, before.expectedCriticalErrors, `${item.id}: expectedCriticalErrors survives`);
    if (item.answer) assert.ok(!item.tags.includes('needs-answer-text'), `${item.id}: the dropped tag does not come back`);
    if (before.tags.includes('assignment-typed')) {
      assert.ok(item.tags.includes('assignment-typed'), `${item.id}: percentages read off the picture stay marked as such`);
      assert.ok(!item.tags.includes('assignment-partial'), `${item.id}: the typed chart is not asked for a second time`);
    }
  }
});

test('a work the manuals no longer yield stays in the dataset and is named', () => {
  const merged = mergeStubs(stubs, []);
  assert.deepEqual(merged.stubs, stubs, 'an empty rebuild is a parsing regression, not permission to delete');
  assert.deepEqual(merged.missing, stubs.map((item) => item.id));
  assert.equal(merged.updated.length + merged.added.length, 0);
});

test('the first run on a missing file writes the rebuild as it is', () => {
  const fresh = stubs.map(rebuilt);
  const merged = mergeStubs([], fresh);
  assert.deepEqual(merged.stubs, fresh);
  assert.deepEqual(merged.added, fresh.map((item) => item.id));
  assert.equal(merged.missing.length, 0);
});

test('a field that came out of the manual differently is applied and reported', () => {
  const [kept] = stubs;
  const fresh = rebuilt(kept);
  fresh.assignment = `${kept.assignment} And one more question.`;
  fresh.source = { ...kept.source, page: kept.source.page + 1 };
  fresh.human = { ...kept.human, reviewer: 'fipi-2099-expert-manual' };

  const merged = mergeStubs([kept], [fresh]);
  const [stub] = merged.stubs;
  assert.equal(stub.assignment, fresh.assignment, 'the condition comes from the manual, so the manual wins');
  assert.equal(stub.source.page, fresh.source.page);
  assert.equal(stub.human.reviewer, fresh.human.reviewer);
  // И ровно то же самое — в сводке: пересборка эталонного набора не имеет права быть молчаливой.
  assert.equal(merged.updated.length, 1);
  const [{ id, changes }] = merged.updated;
  assert.equal(id, kept.id);
  assert.ok(changes.some((line) => line.startsWith('assignment:')), changes.join('\n'));
  assert.ok(changes.some((line) => line.startsWith('source.page:')), changes.join('\n'));
  assert.ok(changes.some((line) => line.startsWith('human.reviewer:')), changes.join('\n'));
  // Обновление полей из PDF не повод потерять набранное руками.
  assert.equal(stub.answer, kept.answer);
  assert.deepEqual(stub.assignmentData, kept.assignmentData);
});
