#!/usr/bin/env node
// Reads the filled worksheet back into the stub file and checks the typed text against the
// word count the expert published, which catches a wrong or half-copied work.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stubsFile = path.join(__dirname, '..', 'quality', 'writing-fipi-stubs.json');
const worksheetFile = path.join(__dirname, '..', 'quality', 'transcription-worksheet.md');

const WORD_COUNT_TOLERANCE = 5;

export function parseWorksheet(markdown) {
  const answers = new Map();
  const pattern = /<!--\s*(\S+)\s*-->\s*```text\r?\n([\s\S]*?)```/gu;
  for (const match of markdown.matchAll(pattern)) {
    const text = match[2].replace(/\s+$/u, '').replace(/^\s*\n/u, '');
    if (text.trim()) answers.set(match[1], text);
  }
  return answers;
}

export function countWords(text) {
  return String(text || '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join(' ')
    .trim()
    .split(/\s+/u)
    .filter(Boolean).length;
}

export function applyAnswers(stubs, answers) {
  const applied = [];
  const warnings = [];
  const unknown = [...answers.keys()].filter((id) => !stubs.some((item) => item.id === id));
  for (const id of unknown) warnings.push(`${id}: такой работы нет в наборе — проверьте метку`);

  for (const stub of stubs) {
    const text = answers.get(stub.id);
    if (!text) continue;
    stub.answer = text;
    stub.tags = stub.tags.filter((tag) => tag !== 'needs-answer-text');
    applied.push(stub.id);
    const expected = stub.source.wordCount;
    if (!expected) continue;
    const actual = countWords(text);
    const drift = Math.abs(actual - expected);
    if (drift > WORD_COUNT_TOLERANCE) {
      warnings.push(`${stub.id}: набрано ${actual} слов, эксперт насчитал ${expected} (расхождение ${drift})`);
    }
  }
  return { applied, warnings };
}

async function main() {
  const [stubs, markdown] = await Promise.all([
    fs.readFile(stubsFile, 'utf8').then(JSON.parse),
    fs.readFile(worksheetFile, 'utf8'),
  ]);
  const answers = parseWorksheet(markdown);
  const { applied, warnings } = applyAnswers(stubs, answers);

  await fs.writeFile(stubsFile, `${JSON.stringify(stubs, null, 2)}\n`, 'utf8');
  console.log(`Перенесено работ: ${applied.length}`);
  const left = stubs.filter((item) => !item.answer).length;
  console.log(`Осталось набрать: ${left}`);
  if (warnings.length) {
    console.log('\nПроверьте:');
    warnings.forEach((line) => console.log('  ' + line));
    process.exitCode = 1;
  }
}

// Only run when invoked directly: the parsing helpers above are imported by the tests.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
