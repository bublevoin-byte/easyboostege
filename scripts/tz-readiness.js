#!/usr/bin/env node
/*
 * Пересчёт готовности по «ТЗ подготовки Easy Boost к production».
 *
 * Документ живёт вне репозитория, поэтому путь к нему передаётся аргументом:
 *
 *   npm run tz:readiness -- "../../ТЗ_подготовка_Easy_Boost_к_продакшену.md"
 *   npm run tz:readiness -- "<путь>" --open     # ещё и перечислить открытые пункты
 *
 * Правило взято из самого документа, раздел «Статус выполнения»:
 *
 *   - считаются разделы 4–21 и раздел 24; разделы 1–3 и 22–26 дублируют требования
 *     (цели, границы, этапы, приоритеты, Definition of Done, ожидаемый итог);
 *   - атомарное требование — пункт списка, маркированный или нумерованный;
 *   - выполненное требование — пункт с отметкой `✅`, открытое — пункт без отметки.
 *
 * Требования, сформулированные отдельным абзацем, а не пунктом списка, не считаются
 * вовсе — ни в числителе, ни в знаменателе. Причина в том, что выполненный абзац
 * (зачёркнут, отмечен `✅`) машинно опознаётся, а открытый абзац от пояснительного
 * текста не отличается; считать только выполненные — значит завышать долю.
 * Скрипт печатает их числом отдельно, чтобы величина пропуска была видна.
 *
 * В `npm run check` скрипт намеренно не подключён: документа нет ни в репозитории, ни в CI.
 */

import { readFileSync } from 'node:fs';
import { argv, exit, stdout } from 'node:process';

const COUNTED_SECTIONS = ['4', '5', '6', '7', '8', '9', '10', '11', '12', '13',
  '14', '15', '16', '17', '18', '19', '20', '21', '24'];

const DONE_MARK = '✅';
const TOP_LEVEL_HEADING = /^##\s+(\d+)\.\s/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+\.)\s+\S/;

function parse(text) {
  const lines = text.split(/\r?\n/);
  const counted = new Set(COUNTED_SECTIONS);
  const sections = new Map();
  let section = null;
  let paragraphRequirements = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    const heading = TOP_LEVEL_HEADING.exec(line);
    if (heading) {
      section = counted.has(heading[1]) ? heading[1] : null;
      if (section && !sections.has(section)) {
        sections.set(section, { done: 0, open: 0, openItems: [] });
      }
      continue;
    }

    if (!section) continue;

    const marked = line.includes(DONE_MARK);
    const stats = sections.get(section);

    if (!LIST_ITEM.test(line)) {
      // Абзац-требование: одна строка может закрывать сразу два, у каждого своя отметка.
      if (marked) paragraphRequirements += line.split(DONE_MARK).length - 1;
      continue;
    }

    if (marked) {
      stats.done += 1;
    } else {
      stats.open += 1;
      stats.openItems.push({ line: index + 1, text: line.trim() });
    }
  }

  return { sections, paragraphRequirements };
}

function main() {
  const target = argv[2];
  if (!target || target.startsWith('--')) {
    stdout.write('Использование: node scripts/tz-readiness.js <путь к ТЗ.md> [--open]\n');
    exit(2);
  }

  let text;
  try {
    text = readFileSync(target, 'utf8');
  } catch (error) {
    stdout.write(`Не удалось прочитать ${target}: ${error.message}\n`);
    exit(2);
  }

  const { sections, paragraphRequirements } = parse(text);
  const missing = COUNTED_SECTIONS.filter((section) => !sections.has(section));
  if (missing.length) {
    stdout.write(`В документе не найдены разделы: ${missing.join(', ')}. Это другой документ или изменилась разметка заголовков.\n`);
    exit(2);
  }

  let done = 0;
  let open = 0;

  stdout.write('Раздел  Выполнено  Открыто  Готовность\n');
  for (const section of COUNTED_SECTIONS) {
    const stats = sections.get(section);
    done += stats.done;
    open += stats.open;
    const sectionTotal = stats.done + stats.open;
    const sectionPercent = sectionTotal === 0 ? 0 : (stats.done / sectionTotal) * 100;
    stdout.write(`${section.padStart(6)}  ${String(stats.done).padStart(9)}  ${String(stats.open).padStart(7)}  ${`${sectionPercent.toFixed(0)}%`.padStart(10)}\n`);
  }

  const total = done + open;
  const percent = total === 0 ? 0 : (done / total) * 100;

  stdout.write('\n');
  stdout.write(`Выполнено:  ${done}\n`);
  stdout.write(`Открыто:    ${open}\n`);
  stdout.write(`Всего:      ${total}\n`);
  stdout.write(`Готовность: ${percent.toFixed(1)}% (${done} из ${total})\n`);
  stdout.write(`Вне подсчёта: ${paragraphRequirements} требований-абзацев, все отмечены выполненными — счёт скорее занижает готовность, чем завышает.\n`);

  if (argv.includes('--open')) {
    stdout.write('\nОткрытые пункты:\n');
    for (const section of COUNTED_SECTIONS) {
      for (const item of sections.get(section).openItems) {
        stdout.write(`  §${section}, строка ${item.line}: ${item.text}\n`);
      }
    }
  }
}

main();
