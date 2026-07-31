import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildWritingPrompt, writingAssignmentSchema } from '../ai/writing.js';
import { parseTableRows, parseTask37, readPage } from '../scripts/build-quality-assignments.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourcesDirectory = path.join(__dirname, '..', 'quality', 'sources');
const stubs = JSON.parse(await fs.readFile(new URL('../quality/writing-fipi-stubs.json', import.meta.url), 'utf8'));

// quality/sources/ holds the FIPI manuals and is in .gitignore, so a clone has the dataset but not
// the text it was taken from. The checks that reread the manual are skipped there, never dropped.
const manuals = new Map();
for (const name of new Set(stubs.map((item) => item.source.manual.replace(/\.pdf$/u, '.txt')))) {
  try { manuals.set(name, await fs.readFile(path.join(sourcesDirectory, name), 'utf8')); }
  catch { /* skipped below */ }
}
const withoutManuals = manuals.size === 0 && 'quality/sources/*.txt отсутствуют — npm run quality:sources';

const assignmentPage = (item) => {
  const text = manuals.get(item.source.manual.replace(/\.pdf$/u, '.txt'));
  return text === undefined ? null : readPage(text, item.source.assignmentPage);
};

test('every structured assignment matches the shape the prompt is built from', () => {
  for (const item of stubs) {
    assert.ok('assignmentData' in item, `${item.id}: поле assignmentData не заполнено скриптом`);
    if (item.assignmentData === null) continue;
    const checked = writingAssignmentSchema.safeParse({ taskType: item.operation, assignment: item.assignmentData });
    assert.ok(checked.success, `${item.id}: ${JSON.stringify(checked.error?.issues)}`);
  }
});

test('only the works whose data is a picture are left without an assignment', () => {
  const partial = stubs.filter((item) => item.tags.includes('assignment-partial')).map((item) => item.id);
  const empty = stubs.filter((item) => item.assignmentData === null).map((item) => item.id);
  // Три работы задания 38 построены на круговой диаграмме: цифр нет в текстовом слое PDF.
  assert.deepEqual(empty.sort(), partial.sort(), 'без условия остаются ровно работы с тегом assignment-partial');
  assert.equal(partial.length, 3, `работ с диаграммой ${partial.length}, а не 3`);

  const ready = (operation) => stubs.filter((item) => item.operation === operation && item.assignmentData).length;
  assert.equal(ready('writing_37'), 12, 'задание 37 разбирается механически, работ должно быть 12');
  assert.equal(ready('writing_38'), 6, 'таблицы задания 38: 6 работ из 9');
});

test('the structured assignment reaches the prompt the student would get', () => {
  for (const item of stubs) {
    if (!item.assignmentData) continue;
    const { user } = buildWritingPrompt({ taskType: item.operation, assignment: item.assignmentData, answer: item.answer });
    if (item.operation === 'writing_37') {
      assert.ok(user.includes(item.assignmentData.from), `${item.id}: отправитель не попал в промпт`);
      assert.ok(user.includes(item.assignmentData.questionsTopic), `${item.id}: тема вопросов не попала в промпт`);
      continue;
    }
    for (const row of item.assignmentData.rows) {
      assert.ok(user.includes(`${row.label} — ${row.percent}%`), `${item.id}: строка «${row.label}» не попала в промпт`);
    }
  }
});

test('task 37 assignments are reproduced from the scanned condition', () => {
  for (const item of stubs) {
    if (item.operation !== 'writing_37') continue;
    assert.deepEqual(parseTask37(item.assignment), item.assignmentData, `${item.id}: разбор условия разошёлся с набором`);
  }
});

test('task 38 percentages are the ones printed in the manual', { skip: withoutManuals }, () => {
  let checked = 0;
  for (const item of stubs) {
    if (item.operation !== 'writing_38' || !item.assignmentData) continue;
    const page = assignmentPage(item);
    if (page === null) continue;
    for (const row of item.assignmentData.rows) {
      // Подпись и процент стоят на одной строке методички — так их и сверяем, без разбора таблицы:
      // выдуманное «по смыслу» число здесь не пройдёт.
      const printed = new RegExp(`^\\s*${row.label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\s+${row.percent}\\s*$`, 'mu');
      assert.match(page, printed, `${item.id}: «${row.label} ${row.percent}» нет в ${item.source.manual} на с. ${item.source.assignmentPage}`);
      checked += 1;
    }
    assert.deepEqual(parseTableRows(page), item.assignmentData.rows, `${item.id}: таблица разошлась с методичкой`);
  }
  assert.ok(checked >= 30, `сверено строк таблиц ${checked}, ожидалось не меньше 30`);
});
