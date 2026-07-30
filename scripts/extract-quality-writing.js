#!/usr/bin/env node
// Builds writing 37/38 dataset stubs from the FIPI expert manuals.
// The student answers are scans of handwritten answer sheets, so only the assignment, the work
// number and the expert scores can be extracted. `answer` stays empty for a human to type in.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourcesDirectory = path.join(__dirname, '..', 'quality', 'sources');
const outputFile = path.join(__dirname, '..', 'quality', 'writing-fipi-stubs.json');

const YEARS = [2023, 2024, 2025, 2026];

const TASKS = {
  37: {
    operation: 'writing_37',
    max: 6,
    criteria: ['k1', 'k2', 'k3'],
    labels: { k1: 'Решение коммуникативной задачи', k2: 'Организация текста', k3: 'Языковое оформление' },
    maxima: { k1: 2, k2: 2, k3: 2 },
    start: /You have received an email (?:message )?from your English-speaking pen-friend/u,
    end: /Remember the rules of email writing/u,
  },
  38: {
    operation: 'writing_38',
    max: 14,
    criteria: ['k1', 'k2', 'k3', 'k4', 'k5'],
    labels: {
      k1: 'Решение коммуникативной задачи', k2: 'Организация текста',
      k3: 'Лексика', k4: 'Грамматика', k5: 'Орфография и пунктуация',
    },
    maxima: { k1: 3, k2: 3, k3: 3, k4: 3, k5: 2 },
    start: /(?:^|\s)Imagine that you are doing a project/u,
    end: /Write 200[–-]250 words/u,
  },
};

/*
 * Заголовок работы набран по-разному в разные годы: «Работа 4798» в методичке 2026 года и
 * «РАБОТА 4798 (с сохранением языкового оформления оригинала)» в методичках 2023–2025.
 * Чувствительный к регистру шаблон видел только первый вариант, и пять работ остались без номера —
 * а вместе с номером они теряли и единственный надёжный признак, по которому переиздание одной
 * и той же работы отличается от двух разных.
 */
const WORK = /^\s*работа\s+(\d{3,5})/iu;
// \b is ASCII-only in JavaScript, so a Cyrillic word boundary has to be spelled out.
// The manuals close a review either with "Итог ..." or with "за работу автор получит ...".
const SUMMARY = /^\s*Итог[оа]?(?![А-Яа-яЁё])|за (?:всю )?работу (?:автор |участник (?:экзамена )?)?получит/u;
const WORDS_COUNTED = /\((\d{2,3}) слов/u;

// Criterion names differ by year: К1..К5, or the abbreviations used in the criteria tables.
const NAMES = new Map([
  ['к1', 'k1'], ['ркз', 'k1'],
  ['к2', 'k2'], ['от', 'k2'],
  ['к3', 'k3'], ['яо', 'k3'], ['лексика', 'k3'],
  ['к4', 'k4'], ['грамматика', 'k4'],
  ['к5', 'k5'], ['орфография', 'k5'], ['орфография и пунктуация', 'k5'],
]);

function parseScores(text) {
  const scores = {};
  const pattern = /(К[1-5]|РКЗ|ОТ|ЯО|лексика|грамматика|орфография(?: и пунктуация)?)\s*[–—-]?\s*(\d)/gu;
  for (const match of text.matchAll(pattern)) {
    const key = NAMES.get(match[1].toLocaleLowerCase('ru'));
    if (key && scores[key] === undefined) scores[key] = Number(match[2]);
  }
  const total = text.match(/(\d{1,2})\s*балл/u);
  return { scores, statedTotal: total ? Number(total[1]) : null };
}

function readAssignment(lines, from, task) {
  const collected = [];
  for (let index = from; index < Math.min(from + 40, lines.length); index += 1) {
    const line = lines[index].trim();
    if (line) collected.push(line);
    if (task.end.test(line)) break;
  }
  // Labels from the scanned answer sheet and the criteria table bleed into the running text.
  return collected.join(' ')
    .replace(/[А-Яа-яЁё][А-Яа-яЁё\s()]*/gu, ' ')
    .replace(/\s+\d{1,3}\s+/gu, ' ')
    .replace(/\s+([,.:;])/gu, '$1')
    .replace(/\s+/gu, ' ')
    .replace(/^\d{2}\s+/u, '')
    .trim();
}

function extract(text, year) {
  const lines = text.split(/\r?\n/);
  const stubs = [];
  const problems = [];
  let taskNumber = null;
  let assignment = '';
  let work = null;
  let words = null;
  let page = 1;
  let assignmentPage = 1;
  let workPage = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    // pdftotext writes a form feed at the start of every new page.
    page += (line.match(/\f/gu) || []).length;
    const trimmed = line.trim();

    // The condition always precedes its work, so it is the reliable signal for which task follows.
    for (const [number, candidate] of Object.entries(TASKS)) {
      if (!candidate.start.test(trimmed)) continue;
      taskNumber = Number(number);
      assignment = readAssignment(lines, index, candidate);
      assignmentPage = page;
      work = null;
      workPage = null;
      words = null;
      break;
    }
    if (!taskNumber) continue;
    const task = TASKS[taskNumber];
    const found = line.trim().match(WORK);
    if (found) { work = found[1]; workPage = page; continue; }
    const counted = line.match(WORDS_COUNTED);
    if (counted) { words = Number(counted[1]); continue; }
    if (!SUMMARY.test(line)) continue;

    const joined = [line, lines[index + 1] || '', lines[index + 2] || '', lines[index + 3] || ''].join(' ').replace(/\s+/gu, ' ');
    const { scores, statedTotal } = parseScores(joined);
    const present = task.criteria.filter((name) => scores[name] !== undefined);
    const complete = present.length === task.criteria.length;
    if (!complete && statedTotal === null) {
      problems.push(`${year} задание ${taskNumber} работа ${work || '?'}: в итоге нет ни критериев, ни общего балла — «${joined.slice(0, 90)}»`);
      continue;
    }
    // Some years print only the overall score. That still feeds the deviation metrics.
    const total = complete ? task.criteria.reduce((sum, name) => sum + scores[name], 0) : statedTotal;
    if (total > task.max) {
      problems.push(`${year} задание ${taskNumber} работа ${work || '?'}: итог ${total} выше максимума ${task.max}`);
      continue;
    }
    if (complete && statedTotal !== null && statedTotal !== total && statedTotal <= task.max) {
      problems.push(`${year} задание ${taskNumber} работа ${work || '?'}: сумма ${total} не сходится с заявленным итогом ${statedTotal}`);
      continue;
    }
    const overflow = task.criteria.find((name) => scores[name] > task.maxima[name]);
    if (overflow) {
      problems.push(`${year} задание ${taskNumber} работа ${work || '?'}: ${overflow} = ${scores[overflow]} выше максимума ${task.maxima[overflow]}`);
      continue;
    }

    stubs.push({
      id: `w${taskNumber}-fipi-${year}-${work || String(stubs.length + 1).padStart(3, '0')}`,
      operation: task.operation,
      tags: [
        `fipi-${year}`, 'needs-answer-text',
        ...(complete ? [] : ['total-only']),
        // Task 38 needs the survey figures; when the table was a picture they are not in the text.
        ...(taskNumber === 38 && !/\d\s*%|\(%\)/u.test(assignment) ? ['assignment-partial'] : []),
      ],
      assignment: assignment || null,
      answer: '',
      human: {
        total,
        max: task.max,
        criteria: complete ? Object.fromEntries(task.criteria.map((name) => [name, scores[name]])) : null,
        criteriaLabels: task.labels,
        reviewer: `fipi-${year}-expert-manual`,
      },
      source: { manual: `fipi-pch-${year}.pdf`, work: work || null, wordCount: words, page: workPage || assignmentPage, assignmentPage },
      expectedCriticalErrors: [],
      aiRuns: [],
    });
    work = null;
    workPage = null;
    words = null;
  }
  return { stubs, problems };
}

// The manuals reprint the same discussed works year after year. Without the answer text the
// signature is the assignment plus the scores plus the word count the expert counted.
function signature(stub) {
  return [
    stub.operation,
    (stub.assignment || '').slice(0, 120),
    stub.human.total,
    JSON.stringify(stub.human.criteria),
  ].join('|');
}

/*
 * Поле, которое напечатала только одна из двух методичек, не может служить доказательством
 * различия. Прежняя подпись включала объём по подсчёту эксперта наравне с остальным, и работа
 * 4798 попала в набор дважды: методичка 2026 года объём печатает, методичка 2025-го — нет.
 * Разошлись подписи, а работа одна и та же.
 */
function agrees(left, right) {
  return left == null || right == null || String(left) === String(right);
}

function dedupe(stubs) {
  const groups = new Map();
  for (const stub of stubs) {
    const key = signature(stub);
    const bucket = groups.get(key) || [];
    const twin = bucket.find((kept) => agrees(kept.source.work, stub.source.work)
      && agrees(kept.source.wordCount, stub.source.wordCount));
    if (!twin) { bucket.push(stub); groups.set(key, bucket); continue; }
    twin.source.reprintedIn = [...(twin.source.reprintedIn || []), stub.source.manual];
    /* Годы дополняют друг друга: что напечатал один, оставляем, даже если другой промолчал. */
    twin.source.work = twin.source.work ?? stub.source.work;
    twin.source.wordCount = twin.source.wordCount ?? stub.source.wordCount;
  }
  return [...groups.values()].flat();
}

async function main() {
  const stubs = [];
  const problems = [];
  const report = [];
  for (const year of YEARS) {
    const file = path.join(sourcesDirectory, `fipi-pch-${year}.txt`);
    let text;
    try { text = await fs.readFile(file, 'utf8'); }
    catch (error) {
      report.push(`${year}: нет ${path.basename(file)} — выполните npm run quality:sources и pdftotext -enc UTF-8 -layout`);
      continue;
    }
    const result = extract(text, year);
    stubs.push(...result.stubs);
    problems.push(...result.problems);
    const count = (operation) => result.stubs.filter((item) => item.operation === operation).length;
    report.push(`${year}: задание 37 — ${count('writing_37')}, задание 38 — ${count('writing_38')}, пропущено ${result.problems.length}`);
  }

  const unique = dedupe(stubs);
  await fs.writeFile(outputFile, `${JSON.stringify(unique, null, 2)}\n`, 'utf8');
  report.forEach((line) => console.log(line));
  if (problems.length) {
    console.log('\nНе разобрано (проверьте вручную):');
    problems.forEach((line) => console.log('  ' + line));
  }
  const total37 = unique.filter((item) => item.operation === 'writing_37').length;
  const total38 = unique.filter((item) => item.operation === 'writing_38').length;
  console.log(`\nПовторов между годами убрано: ${stubs.length - unique.length}`);
  console.log(`Уникальных заготовок: задание 37 — ${total37} из 20, задание 38 — ${total38} из 30`);
  console.log('В каждой заготовке пустое поле answer: текст работы набирается со скана вручную.');
  console.log(`Файл: ${outputFile}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
