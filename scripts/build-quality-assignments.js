#!/usr/bin/env node
// Turns the flat `assignment` string of every dataset work into the structure `buildWritingPrompt`
// expects: {from, stimulus, questionsTopic} for task 37, {topic, rows} for task 38.
// The string itself stays untouched — it is the scan of record and the stub test checks it.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { writingAssignmentSchema } from '../ai/writing.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stubsFile = path.join(__dirname, '..', 'quality', 'writing-fipi-stubs.json');
const sourcesDirectory = path.join(__dirname, '..', 'quality', 'sources');

// Task 37 conditions are printed to one template across all four manuals.
const FROM = /From:\s*(\S+)\s+To:/u;
const STIMULUS = /(Subject:\s*[\s\S]*?)\s*Write an email to/u;
const QUESTIONS_TOPIC = /ask questions about\s+([^.;]+?)\s*[.;]/u;
const PROJECT_TOPIC = /doing a project on\s+([\s\S]*?)\.\s*You have found/u;

const TABLE_HEADER = /Number of respondents\s*\(%\)/u;
const TABLE_END = /^\s*Write \d{3}\s*[–-]\s*\d{3} words/u;
// pdftotext -layout keeps the two table columns apart by a run of spaces, so a row is
// "<label><spaces><percent>" and nothing else on the line.
const TABLE_ROW = /^\s*(.*\S)\s{2,}(\d{1,3})\s*$/u;
const MAX_TABLE_LINES = 40;

const squash = (value) => String(value).replace(/\s+/gu, ' ').trim();

// pdftotext writes a form feed at the start of every new page, the same convention
// scripts/extract-quality-writing.js counts pages by.
export function readPage(text, page) {
  const pages = text.split('\f');
  return pages[page - 1] || '';
}

export function parseTask37(assignment) {
  const from = assignment.match(FROM);
  const stimulus = assignment.match(STIMULUS);
  const topic = assignment.match(QUESTIONS_TOPIC);
  const missing = [
    from ? null : 'From: …',
    stimulus ? null : 'Subject: … Write an email to …',
    topic ? null : 'ask questions about …',
  ].filter(Boolean);
  if (missing.length) throw new Error(`в условии не найдено: ${missing.join(', ')}`);
  return {
    from: squash(from[1]),
    stimulus: squash(stimulus[1]),
    questionsTopic: squash(topic[1]),
  };
}

export function parseTableRows(pageText) {
  const lines = pageText.split(/\r?\n/);
  const header = lines.findIndex((line) => TABLE_HEADER.test(line));
  if (header === -1) return null;

  const rows = [];
  for (let index = header + 1; index < Math.min(header + 1 + MAX_TABLE_LINES, lines.length); index += 1) {
    const line = lines[index];
    if (TABLE_END.test(line)) break;
    if (!line.trim()) continue;
    const row = line.match(TABLE_ROW);
    // The manuals of 2024–2026 leave a blank line between rows, the 2023 one does not; either way
    // the first line that is neither blank nor a row means the table is over.
    if (!row) { if (rows.length) break; continue; }
    rows.push({ label: squash(row[1]), percent: Number(row[2]) });
  }
  return rows.length ? rows : null;
}

export function parseTask38(assignment, pages) {
  const topic = assignment.match(PROJECT_TOPIC);
  if (!topic) throw new Error('в условии не найдено «doing a project on …»');
  const rows = pages.map(parseTableRows).find(Boolean);
  if (!rows) throw new Error('в тексте методички на этой странице нет таблицы с процентами');

  /*
   * Единственная защита от того, что разобрана таблица чужой работы: подписи, снятые со скана в
   * поле assignment, обязаны совпасть с подписями из методички. Числа в наборе эталонные, и
   * подставленная не туда таблица испортила бы сверку эксперта с ИИ молча.
   */
  const flat = squash(assignment);
  const stray = rows.find((row) => !flat.includes(row.label));
  if (stray) throw new Error(`подпись «${stray.label}» из методички отсутствует в условии работы`);

  return { topic: squash(topic[1]), rows };
}

// Keeps `assignmentData` next to the string it was parsed from instead of at the end of the record.
function withAssignmentData(stub, assignmentData) {
  const next = {};
  for (const [key, value] of Object.entries(stub)) {
    if (key === 'assignmentData') continue;
    next[key] = value;
    if (key === 'assignment') next.assignmentData = assignmentData;
  }
  if (!('assignmentData' in next)) next.assignmentData = assignmentData;
  return next;
}

export function buildAssignmentData(stub, sources) {
  /*
   * Три работы задания 38 построены на круговой диаграмме: в текстовом слое PDF её цифр нет,
   * там картинка. Выдумать процент нельзя — набор эталонный, — поэтому работа остаётся с null
   * и тегом assignment-partial, а цифры переносит владелец по опроснику.
   */
  if (stub.tags.includes('assignment-partial')) return null;

  const assignment = stub.assignment || '';
  const parsed = stub.operation === 'writing_37'
    ? parseTask37(assignment)
    : parseTask38(assignment, pagesFor(stub, sources));

  const checked = writingAssignmentSchema.safeParse({ taskType: stub.operation, assignment: parsed });
  if (!checked.success) {
    const details = checked.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`условие не прошло writingAssignmentSchema — ${details}`);
  }
  return checked.data.assignment;
}

// The condition sometimes runs over a page break, so the next page is looked at as well.
function pagesFor(stub, sources) {
  const manual = stub.source.manual.replace(/\.pdf$/u, '.txt');
  const text = sources.get(manual);
  if (text === undefined) throw new Error(`нет ${manual} — выполните npm run quality:sources`);
  const page = stub.source.assignmentPage;
  return [readPage(text, page), readPage(text, page + 1)];
}

async function main() {
  const stubs = JSON.parse(await fs.readFile(stubsFile, 'utf8'));

  const manuals = new Set(stubs
    .filter((stub) => stub.operation === 'writing_38' && !stub.tags.includes('assignment-partial'))
    .map((stub) => stub.source.manual.replace(/\.pdf$/u, '.txt')));
  const sources = new Map();
  for (const manual of manuals) {
    try { sources.set(manual, await fs.readFile(path.join(sourcesDirectory, manual), 'utf8')); }
    catch { /* pagesFor names the missing manual together with the work that needed it. */ }
  }

  const problems = [];
  const next = stubs.map((stub) => {
    try {
      return withAssignmentData(stub, buildAssignmentData(stub, sources));
    } catch (error) {
      problems.push(`${stub.id}: ${error.message}`);
      return stub;
    }
  });

  if (problems.length) {
    console.error('Условие не разобрано:');
    problems.forEach((line) => console.error('  ' + line));
    throw new Error(`не разобрано работ: ${problems.length}`);
  }

  await fs.writeFile(stubsFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8');

  const filled = next.filter((stub) => stub.assignmentData);
  const count = (operation) => filled.filter((stub) => stub.operation === operation).length;
  console.log(`Задание 37: ${count('writing_37')} из ${next.filter((s) => s.operation === 'writing_37').length}`);
  console.log(`Задание 38: ${count('writing_38')} из ${next.filter((s) => s.operation === 'writing_38').length}`);
  for (const stub of filled.filter((item) => item.operation === 'writing_38')) {
    const sum = stub.assignmentData.rows.reduce((total, row) => total + row.percent, 0);
    console.log(`  ${stub.id}: ${stub.assignmentData.rows.map((row) => `${row.label} ${row.percent}%`).join(', ')} — сумма ${sum}`);
  }
  const partial = next.filter((stub) => !stub.assignmentData);
  console.log(`\nБез условия (данные картинкой, набирает владелец): ${partial.length}`);
  partial.forEach((stub) => console.log(`  ${stub.id} — ${stub.source.manual}, с. ${stub.source.assignmentPage}`));
  console.log(`\nФайл: ${stubsFile}`);
}

// Only run when invoked directly: the parsing helpers above are imported by the tests.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
