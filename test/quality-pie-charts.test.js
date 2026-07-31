import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import { writingAssignmentSchema } from '../ai/writing.js';
import { applyCharts, parseRows, parseWorksheet } from '../scripts/merge-pie-charts.js';

const worksheet = await fs.readFile(new URL('../quality/pie-chart-worksheet.md', import.meta.url), 'utf8');
const stubs = JSON.parse(await fs.readFile(new URL('../quality/writing-fipi-stubs.json', import.meta.url), 'utf8'));

/*
 * Проценты, которых нет ни в одной методичке. Набор эталонный: подставленное «для примера» число,
 * попавшее в quality/writing-fipi-stubs.json, испортило бы методическую проверку молча, поэтому
 * поведение слияния проверяется на выдуманной работе, а не поверх настоящих.
 */
const fixture = () => [{
  id: 'w38-fipi-demo-001',
  operation: 'writing_38',
  tags: ['fipi-demo', 'assignment-partial'],
  assignment: 'Imagine that you are doing a project on how demo students travel to school in Zetland. '
    + 'You have found some data on the subject – the results of a survey (see the pie chart below). '
    + 'Comment on the survey data and give your opinion on the subject of the project. Write 200–250 words.',
  assignmentData: null,
  answer: 'demo answer',
  human: { total: 6, max: 14 },
  source: { manual: 'fipi-pch-2026.pdf', assignmentPage: 1 },
}];

const sheet = (id, lines) => [`<!-- ${id} -->`, '```text', '# подпись сектора | процент', ...lines, '```'].join('\n');

test('the worksheet has a filled-in block for every work whose chart is a picture', () => {
  /*
   * Работа с диаграммой остаётся работой с диаграммой и после того, как её цифры перенесли:
   * assignment-partial означает «ещё не перенесено», assignment-typed — «перенесено человеком».
   * Считать надо оба тега, иначе тест начнёт краснеть ровно в тот момент, когда владелец сделает
   * то, о чём его просили, а перенос данных не должен выглядеть как поломка сборки.
   */
  const partial = stubs.filter((item) => item.tags.some((tag) => tag === 'assignment-partial' || tag === 'assignment-typed'));
  assert.equal(partial.length, 3, `работ с диаграммой ${partial.length}, а не 3`);
  const blocks = parseWorksheet(worksheet);
  for (const item of partial) {
    assert.ok(blocks.has(item.id), `${item.id}: в опроснике нет блока`);
    assert.ok(worksheet.includes(`страница **${item.source.assignmentPage}**`), `${item.id}: не указана страница`);
    assert.ok(worksheet.includes(item.source.manual), `${item.id}: не указана методичка`);
  }
});

test('the hint line inside a block is not read back as data', () => {
  const blocks = parseWorksheet(sheet('w38-fipi-demo-001', []));
  assert.deepEqual(blocks.get('w38-fipi-demo-001'), [], 'подсказка и пустые строки данными не считаются');
});

test('a filled block is read as rows of label and percent', () => {
  const rows = parseRows(parseWorksheet(sheet('w38-fipi-demo-001', [
    'Walking | 41',
    'By bus — 33',
    'By car | 26%',
  ])).get('w38-fipi-demo-001'));
  assert.deepEqual(rows, [
    { label: 'Walking', percent: 41 },
    { label: 'By bus', percent: 33 },
    { label: 'By car', percent: 26 },
  ]);
});

test('merging writes the assignment, drops the pending tag and keeps the rest of the work', () => {
  const stubsCopy = fixture();
  const blocks = parseWorksheet(sheet('w38-fipi-demo-001', ['Walking | 41', 'By bus | 33', 'By car | 26']));
  const { applied, skipped, problems } = applyCharts(stubsCopy, blocks);

  assert.deepEqual(problems, []);
  assert.deepEqual(applied, ['w38-fipi-demo-001']);
  assert.deepEqual(skipped, []);
  assert.equal(stubsCopy[0].assignmentData.topic, 'how demo students travel to school in Zetland');
  assert.equal(stubsCopy[0].assignmentData.rows.length, 3);
  assert.ok(!stubsCopy[0].tags.includes('assignment-partial'), 'тег снимается у заполненной работы');
  assert.equal(stubsCopy[0].answer, fixture()[0].answer, 'ответ участника не трогается');
  assert.deepEqual(stubsCopy[0].source, fixture()[0].source, 'источник не трогается');
  const checked = writingAssignmentSchema.safeParse({ taskType: 'writing_38', assignment: stubsCopy[0].assignmentData });
  assert.ok(checked.success, JSON.stringify(checked.error?.issues));
});

test('a work nobody typed is skipped, not reported as broken', () => {
  const stubsCopy = fixture();
  const { applied, skipped, problems } = applyCharts(stubsCopy, parseWorksheet(sheet('w38-fipi-demo-001', [])));

  assert.deepEqual(problems, []);
  assert.deepEqual(applied, []);
  assert.deepEqual(skipped, ['w38-fipi-demo-001']);
  assert.equal(stubsCopy[0].assignmentData, null, 'незаполненная работа остаётся как была');
  assert.ok(stubsCopy[0].tags.includes('assignment-partial'), 'тег остаётся до тех пор, пока цифр нет');
});

test('a percentage outside 0–100 stops the merge and names the work', () => {
  const stubsCopy = fixture();
  const blocks = parseWorksheet(sheet('w38-fipi-demo-001', ['Walking | 41', 'By bus | 133', 'By car | 26']));
  const { applied, problems } = applyCharts(stubsCopy, blocks);

  assert.deepEqual(applied, []);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^w38-fipi-demo-001: /u);
  assert.match(problems[0], /133 больше 100/u);
  assert.equal(stubsCopy[0].assignmentData, null, 'набор не переписывается по неверным данным');
});

test('a percentage that is not a whole number is refused', () => {
  const { problems } = applyCharts(fixture(), parseWorksheet(
    sheet('w38-fipi-demo-001', ['Walking | 41,5', 'By bus | 33', 'By car | 26']),
  ));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /целым числом от 0 до 100/u);
});

test('fewer than three rows or more than eight are refused', () => {
  const short = applyCharts(fixture(), parseWorksheet(sheet('w38-fipi-demo-001', ['Walking | 41', 'By bus | 33'])));
  assert.equal(short.problems.length, 1);
  assert.match(short.problems[0], /строк 2, а нужно от 3 до 8/u);

  const rows = Array.from({ length: 9 }, (_, index) => `Option ${index + 1} | 10`);
  const long = applyCharts(fixture(), parseWorksheet(sheet('w38-fipi-demo-001', rows)));
  assert.equal(long.problems.length, 1);
  assert.match(long.problems[0], /строк 9, а нужно от 3 до 8/u);
});

test('a row without a percent and a row without a label are both refused', () => {
  const noPercent = applyCharts(fixture(), parseWorksheet(
    sheet('w38-fipi-demo-001', ['Walking 41', 'By bus | 33', 'By car | 26']),
  ));
  assert.equal(noPercent.problems.length, 1);
  assert.match(noPercent.problems[0], /не похожа на «подпись \| процент»/u);

  const noLabel = applyCharts(fixture(), parseWorksheet(
    sheet('w38-fipi-demo-001', ['| 41', 'By bus | 33', 'By car | 26']),
  ));
  assert.equal(noLabel.problems.length, 1);
  assert.match(noLabel.problems[0], /подпись сектора пустая/u);
});

// Сумма процентов не проверяется намеренно: у ФИПИ есть опросы, где выбирают несколько вариантов,
// и требование ровно 100 отвергло бы верно перенесённые данные.
test('percentages that do not add up to 100 are accepted', () => {
  const stubsCopy = fixture();
  const blocks = parseWorksheet(sheet('w38-fipi-demo-001', ['Walking | 70', 'By bus | 60', 'By car | 50']));
  const { applied, problems } = applyCharts(stubsCopy, blocks);
  assert.deepEqual(problems, []);
  assert.deepEqual(applied, ['w38-fipi-demo-001']);
});

test('a label the set does not know is reported instead of being dropped', () => {
  const { applied, problems } = applyCharts(fixture(), parseWorksheet(
    sheet('w38-does-not-exist', ['Walking | 41', 'By bus | 33', 'By car | 26']),
  ));
  assert.deepEqual(applied, []);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /такой работы нет в наборе/u);
});
