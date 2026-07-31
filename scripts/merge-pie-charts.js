#!/usr/bin/env node
// Reads the filled pie-chart worksheet back into the dataset. The three works it covers are the
// task 38 ones whose survey data is a picture in the PDF: nothing here may invent a percentage,
// so a work the owner has not typed yet is skipped, and anything that does not add up stops the
// whole run before the dataset is touched.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { writingAssignmentSchema } from '../ai/writing.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stubsFile = path.join(__dirname, '..', 'quality', 'writing-fipi-stubs.json');
const worksheetFile = path.join(__dirname, '..', 'quality', 'pie-chart-worksheet.md');

// A pie chart with fewer than three sectors is not a chart, and task 38 assignments never carry
// more than eight rows — the same bounds writingAssignmentSchema enforces.
export const MIN_ROWS = 3;
export const MAX_ROWS = 8;

// The hint the worksheet prints inside every empty block; it starts with # so it is never read
// back as data, which lets the owner leave it in place.
export const HINT_LINE = '# подпись сектора | процент';

const BLOCK = /<!--\s*(\S+)\s*-->\s*```text\r?\n([\s\S]*?)```/gu;
// "<label> | <percent>". The em and en dashes are accepted too: the worksheet calls the table
// «подпись — процент», and a person who types the dash instead of the bar means the same thing.
const ROW = /^(.*?)\s*[|—–]\s*(\S+)\s*$/u;
const PERCENT = /^(\d{1,3})\s*%?$/u;
// The project topic is printed in the condition of the work, exactly as in the manual, so it is
// read from there rather than typed a second time by hand.
const PROJECT_TOPIC = /doing a project on\s+([\s\S]*?)\.\s*You have found/u;

const squash = (value) => String(value).replace(/\s+/gu, ' ').trim();

export function projectTopic(assignment) {
  const found = String(assignment || '').match(PROJECT_TOPIC);
  if (!found) throw new Error('в условии не найдено «doing a project on …» — тему проекта взять неоткуда');
  return squash(found[1]);
}

/*
 * Every labelled block of the worksheet, including the empty ones: the merge skips those, and the
 * builder reuses them to keep what is already typed when the worksheet is generated again.
 * Blank lines and lines starting with # are hints for the owner, not data.
 */
export function parseWorksheet(markdown) {
  const blocks = new Map();
  for (const match of String(markdown || '').matchAll(BLOCK)) {
    const lines = match[2]
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    blocks.set(match[1], lines);
  }
  return blocks;
}

export function parseRows(lines) {
  const rows = lines.map((line) => {
    const found = line.match(ROW);
    if (!found) throw new Error(`строка «${line}» не похожа на «подпись | процент»: нужна вертикальная черта между подписью и числом`);
    const label = found[1].trim();
    if (!label) throw new Error(`строка «${line}»: подпись сектора пустая`);
    const percent = found[2].match(PERCENT);
    if (!percent) throw new Error(`строка «${line}»: «${found[2]}» — процент пишется целым числом от 0 до 100`);
    const value = Number(percent[1]);
    if (value > 100) throw new Error(`строка «${line}»: процент ${value} больше 100`);
    return { label, percent: value };
  });
  if (rows.length < MIN_ROWS || rows.length > MAX_ROWS) {
    throw new Error(`строк ${rows.length}, а нужно от ${MIN_ROWS} до ${MAX_ROWS} — по одной на сектор диаграммы`);
  }
  return rows;
}

export function applyCharts(stubs, blocks) {
  const applied = [];
  const skipped = [];
  const problems = [];
  const byId = new Map(stubs.map((stub) => [stub.id, stub]));

  for (const [id, lines] of blocks) {
    const stub = byId.get(id);
    if (!stub) { problems.push(`${id}: такой работы нет в наборе — проверьте метку`); continue; }
    // Не заполнено — не ошибка: опросник можно сдавать по частям.
    if (!lines.length) { skipped.push(id); continue; }
    try {
      const assignment = { topic: projectTopic(stub.assignment), rows: parseRows(lines) };
      const checked = writingAssignmentSchema.safeParse({ taskType: stub.operation, assignment });
      if (!checked.success) {
        const details = checked.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
        throw new Error(`условие не прошло writingAssignmentSchema — ${details}`);
      }
      stub.assignmentData = checked.data.assignment;
      /*
       * Тег не снимается, а заменяется: набор эталонный, и происхождение каждой цифры — часть
       * данных, а не служебная пометка. Шесть таблиц задания 38 сверяются с текстовым слоем
       * методички построчно, и выдуманное «по смыслу» число там не пройдёт. У диаграмм такой
       * опоры нет и не будет: их цифры существуют только картинкой, и единственный источник —
       * глаза владельца. Работа, помеченная assignment-typed, честно говорит, что её проценты
       * сверить не с чем, — и проверки, которые ищут строку в методичке, её пропускают, вместо
       * того чтобы падать на данных, которые сами же и просили перенести.
       */
      stub.tags = stub.tags.map((tag) => (tag === 'assignment-partial' ? 'assignment-typed' : tag));
      applied.push(id);
    } catch (error) {
      problems.push(`${id}: ${error.message}`);
    }
  }
  return { applied, skipped, problems };
}

async function main() {
  const [stubs, markdown] = await Promise.all([
    fs.readFile(stubsFile, 'utf8').then(JSON.parse),
    fs.readFile(worksheetFile, 'utf8'),
  ]);

  const blocks = parseWorksheet(markdown);
  if (!blocks.size) throw new Error(`в ${worksheetFile} нет ни одного блока работы — выполните npm run quality:charts`);

  const { applied, skipped, problems } = applyCharts(stubs, blocks);
  if (problems.length) {
    // Набор не переписывается вовсе: половина перенесённых диаграмм хуже, чем ни одной.
    console.error('Данные диаграмм не перенесены, набор не изменён:');
    problems.forEach((line) => console.error('  ' + line));
    throw new Error(`работ с ошибками: ${problems.length}`);
  }

  if (applied.length) await fs.writeFile(stubsFile, `${JSON.stringify(stubs, null, 2)}\n`, 'utf8');

  console.log(`Перенесено диаграмм: ${applied.length}`);
  for (const id of applied) {
    const { rows } = stubs.find((stub) => stub.id === id).assignmentData;
    const sum = rows.reduce((total, row) => total + row.percent, 0);
    // Сумма печатается для сверки глазами, но не проверяется: у ФИПИ есть опросы с несколькими
    // вариантами ответа, и требование ровно 100 отвергло бы верные данные.
    console.log(`  ${id}: ${rows.map((row) => `${row.label} ${row.percent}%`).join(', ')} — сумма ${sum}`);
  }
  if (skipped.length) console.log(`Осталось заполнить: ${skipped.length} — ${skipped.join(', ')}`);
  if (applied.length) console.log(`\nФайл: ${stubsFile}`);
}

// Only run when invoked directly: the parsing helpers above are imported by the tests and by
// scripts/build-pie-chart-worksheet.js.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
