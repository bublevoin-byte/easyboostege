#!/usr/bin/env node
// Builds reviewed speaking task 2 and 4 datasets from local FIPI expert manuals.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const qualityDirectory = path.join(__dirname, '..', 'quality');
const sourcesDirectory = path.join(qualityDirectory, 'sources');
const manifestFile = path.join(qualityDirectory, 'speaking-reviewed-assignments.json');
const task2OutputFile = path.join(qualityDirectory, 'speaking-2-fipi.json');
const task4OutputFile = path.join(qualityDirectory, 'speaking-4-fipi.json');
const task4CandidatesFile = path.join(qualityDirectory, 'speaking-4-fipi-candidates.json');

const SOURCE_YEARS = [2026, 2025, 2024, 2023];
const TASK2_MAX = 4;
const TASK4_MAX = 10;
const TASK2_SCRIPT = /^\s*Скрипт(?:\s+ответа)?(?:\s+\d+)?\s*$/u;
const TASK2_COMMENTS = /^\s*(?:КОММЕНТАРИИ|Комментарии?)\s+к\s+выполненному/u;
const TASK2_SCORE = /Оценка:\s*(\d)\s*бал/iu;
const TASK4_SCORE = /ИТОГО:\s*(\d+)\s*бал[^\r\n]*\(\s*К1\s*[–—-]\s*(\d+)\s*,\s*К2\s*[–—-]\s*(\d+)\s*,\s*К3\s*[–—-]\s*(\d+)\s*\)/giu;
const HOMOGLYPHS = {
  А: 'A', В: 'B', С: 'C', Е: 'E', Н: 'H', К: 'K', М: 'M', О: 'O', Р: 'P', Т: 'T', Х: 'X',
  а: 'a', с: 'c', е: 'e', о: 'o', р: 'p', х: 'x', у: 'y', к: 'k', м: 'm', т: 't', в: 'b', н: 'h',
};

function isPageNumber(value) {
  return /^\s*\f?\s*\d{1,3}\s*$/u.test(value);
}

function stripExpertMarkup(value) {
  return value
    .replace(/\([^)]*[А-Яа-яЁё][^)]*\)/gu, ' ')
    .replace(/\[[^\]]*\]/gu, ' ')
    .replace(/(?:GR-R|LOGIC|PHON|LEX|ART|GR|PH)/gu, ' ');
}

function cleanEnglish(value) {
  return stripExpertMarkup(value)
    .replace(/[АВСЕНКМОРТХасеорхукмтвн]/gu, (character) => HOMOGLYPHS[character] ?? character)
    .replace(/\f/gu, ' ')
    .replace(/\s+([,.!?…])/gu, '$1')
    .replace(/\s+/gu, ' ')
    .trim();
}

function collectNumbered(lines, start, stop) {
  const items = [];
  let current = null;
  for (let index = start; index < lines.length; index += 1) {
    const raw = lines[index];
    if (stop(raw, index)) break;
    if (!raw.trim() || isPageNumber(raw)) continue;
    const match = raw.trim().match(/^([1-4])[.)]\s*(.*)$/u);
    if (match) {
      if (current) items.push(current);
      current = { number: Number(match[1]), text: match[2] };
      continue;
    }
    if (current) current.text += ` ${raw.trim()}`;
  }
  if (current) items.push(current);
  return items;
}

function task2Difficulty(total) {
  if (total === TASK2_MAX) return 'strong';
  if (total >= 2) return 'middle';
  return 'weak';
}

function task4Difficulty(total) {
  if (total >= 8) return 'strong';
  if (total >= 4) return 'middle';
  return 'weak';
}

function parseTask2Source(text, year, assignments) {
  const lines = text.split(/\r?\n/u);
  const entries = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!TASK2_SCRIPT.test(lines[index])) continue;
    const commentsIndex = lines.findIndex((line, candidate) => candidate > index && candidate < index + 25 && TASK2_COMMENTS.test(line));
    if (commentsIndex === -1) continue;
    const questions = collectNumbered(lines, index + 1, (_, candidate) => candidate === commentsIndex);
    if (questions.length !== TASK2_MAX) continue;

    const scoredQuestions = questions.map((item) => {
      const match = item.text.trim().match(/([+–—-])\s*$/u);
      if (!match) return null;
      return { question: cleanEnglish(item.text.slice(0, match.index)), score: match[1] === '+' ? 1 : 0 };
    });
    if (scoredQuestions.some((item) => !item)) continue;

    const firstQuestion = scoredQuestions[0].question.toLocaleLowerCase('en');
    const assignment = assignments.find((item) => firstQuestion.includes(item.match.toLocaleLowerCase('en')));
    if (!assignment) continue;

    const scoreIndex = lines.findIndex((line, candidate) => candidate > commentsIndex && candidate < commentsIndex + 80 && TASK2_SCORE.test(line));
    if (scoreIndex === -1) throw new Error(`${year}/${assignment.key}: expert total is missing`);
    const total = Number(lines[scoreIndex].match(TASK2_SCORE)[1]);
    const comments = collectNumbered(lines, commentsIndex + 1, (_, candidate) => candidate === scoreIndex)
      .map((item) => item.text.replace(/Оценка:.*$/iu, '').replace(/\s+/gu, ' ').trim());
    const calculated = scoredQuestions.reduce((sum, item) => sum + item.score, 0);
    if (calculated !== total) throw new Error(`${year}/${assignment.key}: marks total ${calculated}, published total ${total}`);
    if (comments.length !== TASK2_MAX) throw new Error(`${year}/${assignment.key}: expected four expert comments, found ${comments.length}`);

    const criteria = Object.fromEntries(scoredQuestions.map((item, questionIndex) => [`q${questionIndex + 1}`, item.score]));
    entries.push({
      key: assignment.key,
      id: `sp2-fipi-${year}-${assignment.key}`,
      operation: 'speaking_2',
      tags: [task2Difficulty(total), `fipi-${year}`, 'official-expert-score', 'assignment-visually-reviewed'],
      assignment: { ad: assignment.ad, points: assignment.points },
      transcript: scoredQuestions.map((item) => item.question).join(' '),
      human: {
        total,
        max: TASK2_MAX,
        criteria,
        reviewer: `fipi-${year}-expert-manual`,
        notes: comments,
      },
      source: {
        document: `fipi-uch-${year}.pdf`,
        assignmentPage: assignment.source.assignmentPage,
        assignmentReview: 'visual-pdf-review',
      },
      expectedCriticalErrors: [],
      aiRuns: [],
    });
  }
  return entries;
}

function findTask4Score(text, start, direction) {
  let region;
  if (direction === 'before') region = text.slice(Math.max(0, start - 18_000), start);
  else {
    const nextTask = text.indexOf('ЗАДАНИЕ ', start + 1);
    region = text.slice(start, nextTask === -1 ? undefined : nextTask);
  }
  const matches = [...region.matchAll(TASK4_SCORE)];
  const match = direction === 'before' ? matches.at(-1) : matches[0];
  if (!match) return null;
  return {
    total: Number(match[1]),
    criteria: { task: Number(match[2]), organisation: Number(match[3]), language: Number(match[4]) },
  };
}

function parseTask4Entry(text, item) {
  const start = text.indexOf(item.transcriptStart);
  if (start === -1) throw new Error(`${item.year}/${item.key}: transcript start is missing`);
  const endStart = text.indexOf(item.transcriptEnd, start + item.transcriptStart.length);
  if (endStart === -1) throw new Error(`${item.year}/${item.key}: transcript end is missing`);
  const end = item.scoreDirection === 'before' ? endStart + item.transcriptEnd.length : endStart;
  const transcript = cleanEnglish(text.slice(start, end));
  const human = findTask4Score(text, start, item.scoreDirection);
  if (!human) throw new Error(`${item.year}/${item.key}: expert score is missing`);
  const calculated = Object.values(human.criteria).reduce((sum, score) => sum + score, 0);
  if (calculated !== human.total || human.total > TASK4_MAX) {
    throw new Error(`${item.year}/${item.key}: invalid published criteria total`);
  }

  return {
    id: `sp4-fipi-${item.year}-${item.key}`,
    operation: 'speaking_4',
    tags: [task4Difficulty(human.total), `fipi-${item.year}`, 'official-expert-score', 'full-transcript', 'photos-visually-reviewed'],
    assignment: { topic: item.topic, plan: item.plan, ph: item.ph },
    transcript,
    human: {
      ...human,
      max: TASK4_MAX,
      reviewer: `fipi-${item.year}-expert-manual`,
      notes: ['The transcript and K1/K2/K3 score are published in the FIPI expert manual.'],
    },
    source: {
      document: `fipi-uch-${item.year}.pdf`,
      assignmentPage: item.assignmentPage,
      transcriptPage: item.transcriptPage,
      assignmentReview: 'visual-pdf-review',
    },
    expectedCriticalErrors: [],
    aiRuns: [],
  };
}

async function readSource(year) {
  return fs.readFile(path.join(sourcesDirectory, `fipi-uch-${year}.txt`), 'utf8');
}

async function main() {
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  const sourceTexts = new Map();
  for (const year of SOURCE_YEARS) sourceTexts.set(year, await readSource(year));

  const selectedTask2 = new Map();
  for (const year of SOURCE_YEARS) {
    const found = parseTask2Source(sourceTexts.get(year), year, manifest.speaking2);
    for (const entry of found) if (!selectedTask2.has(entry.key)) selectedTask2.set(entry.key, entry);
  }
  const missingTask2 = manifest.speaking2.filter((item) => !selectedTask2.has(item.key)).map((item) => item.key);
  if (missingTask2.length) throw new Error(`speaking_2 assignments not found: ${missingTask2.join(', ')}`);
  const task2 = [...selectedTask2.values()].map(({ key: _, ...entry }) => entry);

  const task4 = manifest.speaking4.map((item) => parseTask4Entry(sourceTexts.get(item.year), item));
  const candidates = manifest.speaking4Excluded.map((item) => ({
    id: `sp4-fipi-${item.year}-${item.key}-candidate`,
    operation: 'speaking_4',
    status: 'excluded',
    reason: 'The FIPI manual publishes only fragments inside the expert commentary, not a complete student transcript.',
    assignment: { topic: item.topic, ph: item.ph },
    publishedHumanScore: item.publishedHumanScore,
    source: { document: `fipi-uch-${item.year}.pdf`, assignmentPage: item.assignmentPage, assignmentReview: 'visual-pdf-review' },
  }));

  await Promise.all([
    fs.writeFile(task2OutputFile, `${JSON.stringify(task2, null, 2)}\n`, 'utf8'),
    fs.writeFile(task4OutputFile, `${JSON.stringify(task4, null, 2)}\n`, 'utf8'),
    fs.writeFile(task4CandidatesFile, `${JSON.stringify(candidates, null, 2)}\n`, 'utf8'),
  ]);
  console.log(`speaking_2: ${task2.length} fully scored unique works (minimum: 10)`);
  console.log(`speaking_4: ${task4.length} full transcripts (minimum: 10)`);
  console.log(`speaking_4 candidates excluded for incomplete transcripts: ${candidates.length}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
