#!/usr/bin/env node
// Builds the worksheet for the three task 38 works whose survey data is a picture: the pie chart
// carries the percentages, and the text layer of the PDF does not. The file ships empty — the
// numbers are copied off the chart by a person, never guessed here.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HINT_LINE, MAX_ROWS, MIN_ROWS, parseWorksheet, projectTopic } from './merge-pie-charts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stubsFile = path.join(__dirname, '..', 'quality', 'writing-fipi-stubs.json');
const worksheetFile = path.join(__dirname, '..', 'quality', 'pie-chart-worksheet.md');

// Printed in the condition of the newer manuals right above the chart; it names what the sectors
// are about and helps tell one chart from another on a spread with two tasks.
const SURVEY_QUESTION = /The survey question:\s*([^?]+\?)/u;

function wrap(text, width = 100) {
  const words = String(text || '').split(/\s+/u);
  const lines = [];
  let line = '';
  for (const word of words) {
    if ((line + ' ' + word).trim().length > width) { lines.push(line.trim()); line = word; }
    else line += ' ' + word;
  }
  if (line.trim()) lines.push(line.trim());
  return lines.join('\n');
}

const squashLine = (value) => String(value).replace(/\s+/gu, ' ').trim();

function topicOf(item) {
  try { return projectTopic(item.assignment); }
  catch { return null; }
}

function block(item, index, typed) {
  const topic = topicOf(item);
  const question = String(item.assignment || '').match(SURVEY_QUESTION);
  return [
    `## ${index + 1}. ${item.id}`,
    '',
    `- **Файл:** \`quality/sources/${item.source.manual}\`, страница **${item.source.assignmentPage}**`,
    `- **Работа:** ${item.source.work ? `№ ${item.source.work}` : 'номер бланка не указан — ищите по теме проекта'}`,
    `- **Тема проекта:** ${topic || 'в условии не найдена — сверяйтесь по тексту ниже'}`,
    ...(question ? [`- **Вопрос опроса:** ${squashLine(question[1])}`] : []),
    '',
    'Диаграмма нарисована картинкой, поэтому в тексте её не видно: смотрите на страницу глазами.',
    'Если на указанной странице диаграммы нет, она на следующей — условие иногда переносится.',
    '',
    '<details><summary>Условие задания (для сверки, что нашли нужную диаграмму)</summary>',
    '',
    '```',
    wrap(item.assignment),
    '```',
    '',
    '</details>',
    '',
    `Перепишите подписи и проценты с диаграммы — по одной строке на сектор, от ${MIN_ROWS} до ${MAX_ROWS} строк:`,
    '',
    `<!-- ${item.id} -->`,
    '```text',
    HINT_LINE,
    ...typed,
    '```',
    '',
  ].join('\n');
}

function header(count) {
  return [
    '# Круговые диаграммы задания 38 — цифры со сканов',
    '',
    `Работ в этом листе: **${count}**.`,
    '',
    'В этих работах данные опроса нарисованы картинкой: в текстовом слое PDF их нет, и никакая',
    'программа их оттуда не достанет. Проценты нужно один раз переписать с диаграммы глазами —',
    'иначе эти три работы не попадут в проверку ИИ.',
    '',
    '## Что делать',
    '',
    '1. Если методичек ещё нет на диске, скачайте их: `npm run quality:sources` — PDF лягут',
    '   в `quality/sources/`.',
    '2. Откройте указанный у работы PDF на указанной странице. Номер страницы — тот, что стоит',
    '   в поле «страница» у просмотрщика, а не напечатанный внизу листа.',
    '3. Найдите круговую диаграмму. У каждого сектора подписаны название (по-английски)',
    '   и процент.',
    '4. Перепишите их в блок этой работы — тот, что между строками ``` ниже.',
    '5. Сохраните файл и запустите `npm run quality:merge-charts`. Скрипт перенесёт цифры',
    '   в набор и скажет, что получилось.',
    '',
    '## Как заполнять',
    '',
    `- **Одна строка — один сектор диаграммы**, всего от ${MIN_ROWS} до ${MAX_ROWS} строк.`,
    '- В строке: сначала подпись сектора, потом вертикальная черта `|`, потом процент.',
    '  Подсказка с этим порядком уже стоит первой строкой в каждом блоке.',
    '- **Подпись — ровно как на диаграмме**, по-английски, без перевода и без сокращений.',
    '- **Процент — целое число от 0 до 100**, без знака `%`. Написано `27%` — пишите `27`.',
    '  Попалось дробное — округлите до целого.',
    '- **Сумма процентов может не равняться 100, и подгонять её не нужно.** В части опросов',
    '  можно выбрать несколько вариантов ответа, и там сумма больше ста — это нормально.',
    '- Строки, начинающиеся с `#`, скрипт не читает: это подсказки, их можно оставить как есть.',
    '- Метки вида `<!-- w38-... -->` не удаляйте — по ним скрипт понимает, к какой работе',
    '  относятся цифры.',
    '',
    '## Если что-то пойдёт не так',
    '',
    '- Заполнять можно по частям: работы без цифр скрипт молча пропустит и напомнит о них.',
    '- Если строка не понравится проверке, скрипт **ничего не запишет в набор** и назовёт работу',
    '  и строку, в которой ошибка. Поправьте её и запустите `npm run quality:merge-charts` снова.',
    '- Заново собрать этот файл можно командой `npm run quality:charts` — уже вписанные строки',
    '  она сохраняет.',
    '',
    '---',
    '',
  ].join('\n');
}

async function main() {
  const stubs = JSON.parse(await fs.readFile(stubsFile, 'utf8'));
  const pending = stubs.filter((item) => item.tags.includes('assignment-partial'));

  // Rebuilding the worksheet must never cost the owner what is already typed.
  let existing = new Map();
  try { existing = parseWorksheet(await fs.readFile(worksheetFile, 'utf8')); }
  catch { /* первый запуск: опросника ещё нет */ }

  const body = pending.map((item, index) => block(item, index, existing.get(item.id) || []));
  await fs.writeFile(worksheetFile, header(pending.length) + body.join('\n'), 'utf8');

  console.log(`Опросник: ${worksheetFile}`);
  console.log(`Работ с круговой диаграммой: ${pending.length}`);
  for (const item of pending) {
    const typed = (existing.get(item.id) || []).length;
    console.log(`  ${item.id} — ${item.source.manual}, с. ${item.source.assignmentPage}${typed ? `, уже вписано строк: ${typed}` : ''}`);
  }
  if (!pending.length) console.log('Все диаграммы уже перенесены в набор.');
}

// Only run when invoked directly: the helpers above are imported by the tests.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
