import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import { applyAnswers, countWords, parseWorksheet } from '../scripts/merge-transcription-worksheet.js';

const worksheet = await fs.readFile(new URL('../quality/transcription-worksheet.md', import.meta.url), 'utf8');
const stubs = JSON.parse(await fs.readFile(new URL('../quality/writing-fipi-stubs.json', import.meta.url), 'utf8'));

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('the worksheet has a labelled slot for every work in the set', () => {
  for (const item of stubs) {
    assert.ok(worksheet.includes(`<!-- ${item.id} -->`), `${item.id}: no slot in the worksheet`);
    assert.ok(worksheet.includes(`страница **${item.source.page}**`), `${item.id}: no page reference`);
  }
});

/*
 * The worksheet and the set have to agree in both directions. A typed work that no id claims is
 * lost silently, and an id nobody typed under is a work the set believes it has. The duplicate
 * block — work 4798, printed by two manuals and typed twice before that was noticed — carries a
 * comment instead of an id precisely so it does not enter the set a second time.
 */
test('every typed slot belongs to the set, and every work in the set was typed', () => {
  const answers = parseWorksheet(worksheet);
  const ids = new Set(stubs.map((item) => item.id));
  for (const id of answers.keys()) assert.ok(ids.has(id), `${id}: typed under an id the set does not have`);
  for (const item of stubs) {
    if (item.answer) assert.ok(answers.has(item.id), `${item.id}: the set has an answer the worksheet does not`);
  }
  assert.equal(answers.size, stubs.filter((item) => item.answer).length);
});

test('a filled slot is read back under its own id', () => {
  // Built here rather than by editing the real worksheet: the assertion is about parsing, and it
  // must keep meaning the same thing whether the worksheet is empty, half typed or finished.
  const sample = [
    '## 1. w37-fipi-demo-001', '', '<!-- w37-fipi-demo-001 -->', '```text',
    'Dear Mike,', '', 'Thanks for your email.', '```', '',
    '## 2. w37-fipi-demo-002', '', '<!-- w37-fipi-demo-002 -->', '```text', '', '```', '',
  ].join('\n');
  const answers = parseWorksheet(sample);
  assert.equal(answers.size, 1, 'an empty slot is not an answer');
  assert.equal(answers.get('w37-fipi-demo-001'), 'Dear Mike,\n\nThanks for your email.');
});

test('word counting ignores the transcriber notes', () => {
  assert.equal(countWords('one two three'), 3);
  assert.equal(countWords('one two\n# неразборчиво: three\nfour'), 3);
  assert.equal(countWords(''), 0);
});

test('applying an answer clears the pending tag and keeps the expert score', () => {
  const copy = clone(stubs);
  const target = copy[0];
  const words = Array.from({ length: target.source.wordCount }, (_, index) => `word${index + 1}`).join(' ');
  const { applied, warnings } = applyAnswers(copy, new Map([[target.id, words]]));

  assert.deepEqual(applied, [target.id]);
  assert.deepEqual(warnings, []);
  assert.equal(target.answer, words);
  assert.ok(!target.tags.includes('needs-answer-text'));
  assert.deepEqual(target.human, stubs[0].human, 'the expert score must not change');
});

test('a transcript that does not match the counted length is reported', () => {
  const copy = clone(stubs);
  const target = copy[0];
  const short = Array.from({ length: target.source.wordCount - 20 }, () => 'word').join(' ');
  const { warnings } = applyAnswers(copy, new Map([[target.id, short]]));

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /расхождение 20/u);
});

test('an unknown label is reported instead of being silently dropped', () => {
  const { applied, warnings } = applyAnswers(clone(stubs), new Map([['w37-does-not-exist', 'text']]));
  assert.deepEqual(applied, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /такой работы нет/u);
});
