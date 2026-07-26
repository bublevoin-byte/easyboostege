import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import { applyAnswers, countWords, parseWorksheet } from '../scripts/merge-transcription-worksheet.js';

const worksheet = await fs.readFile(new URL('../quality/transcription-worksheet.md', import.meta.url), 'utf8');
const stubs = JSON.parse(await fs.readFile(new URL('../quality/writing-fipi-stubs.json', import.meta.url), 'utf8'));

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('the worksheet has a labelled slot for every work still missing its text', () => {
  const pending = stubs.filter((item) => !item.answer);
  for (const item of pending) {
    assert.ok(worksheet.includes(`<!-- ${item.id} -->`), `${item.id}: no slot in the worksheet`);
    assert.ok(worksheet.includes(`страница **${item.source.page}**`), `${item.id}: no page reference`);
  }
  // Empty slots stay empty until somebody types into them.
  assert.equal(parseWorksheet(worksheet).size, 0);
});

test('a filled slot is read back under its own id', () => {
  const filled = worksheet.replace(
    `<!-- ${stubs[0].id} -->\n\`\`\`text\n\n\`\`\``,
    `<!-- ${stubs[0].id} -->\n\`\`\`text\nDear Mike,\n\nThanks for your email.\n\`\`\``,
  );
  const answers = parseWorksheet(filled);
  assert.equal(answers.size, 1);
  assert.equal(answers.get(stubs[0].id), 'Dear Mike,\n\nThanks for your email.');
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
