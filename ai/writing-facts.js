// Section 10.5: everything a program can decide is decided before the model runs, so the model
// never has to count and cannot get the counting wrong.
//
// Two kinds of results are produced and they must not be confused:
//   * counts   — exact, verifiable facts (words, paragraphs, question sentences);
//   * markers  — evidence found by pattern, never proof of absence (comparisons, problem/solution).
// The prompt presents them under different headings for exactly that reason.

const GREETING = /^\s*(?:dear|hi|hello|hey)\b/iu;
const THANKS = /\b(?:thanks?(?:\s+(?:a\s+lot|so\s+much|for))?|thank\s+you|(?:great|glad|nice|lovely)\s+to\s+hear)\b/iu;
const CLOSING = /\b(?:hope\s+to\s+hear|write\s+back|see\s+you|take\s+care|looking\s+forward|keep\s+in\s+touch|got\s+to\s+go|have\s+to\s+go)\b/iu;
const SIGN_OFF = /^\s*(?:best\s+wishes|yours(?:\s+\w+)?|kind\s+regards|regards|love|all\s+the\s+best|take\s+care|cheers)\s*,?\s*$/imu;

const COMPARISON = [
  /\b\w+er\s+than\b/iu,
  /\b(?:more|less|fewer|higher|lower|greater|smaller)\b/iu,
  /\b(?:twice|three\s+times|half)\s+as\b/iu,
  /\bcompared\s+(?:to|with)\b/iu,
  /\b(?:whereas|while)\b/iu,
  /\bas\s+\w+\s+as\b/iu,
  /\bthe\s+(?:most|least|highest|lowest)\b/iu,
];

const PROBLEM = /\b(?:problem|issue|challenge|drawback|disadvantage|difficulty|risk|concern)\b/iu;
const SOLUTION = /\b(?:solution|solve|resolve|a\s+way\s+(?:to|out)|one\s+way|could\s+be|should\s+be|recommend|suggest|advise|help\s+to)\b/iu;

export function countWords(text) {
  const value = String(text ?? '').trim();
  return value ? value.split(/\s+/u).filter(Boolean).length : 0;
}

// Two shapes are possible: real blank-line paragraphs, or a single block with line breaks.
// Both are reported, because a contenteditable editor produces either depending on the student.
export function countBlocks(text) {
  const value = String(text ?? '').trim();
  if (!value) return { paragraphs: 0, lines: 0 };
  const paragraphs = value.split(/\n\s*\n/u).map((block) => block.trim()).filter(Boolean);
  const lines = value.split(/\n/u).map((line) => line.trim()).filter(Boolean);
  return { paragraphs: paragraphs.length, lines: lines.length };
}

// A run of terminal punctuation closes one sentence, so "Really?!?" counts once.
export function countQuestionSentences(text) {
  const runs = String(text ?? '').match(/[?!]+/gu) || [];
  return runs.filter((run) => run.includes('?')).length;
}

export function findLetterParts(text) {
  const value = String(text ?? '');
  const lines = value.split(/\n/u).map((line) => line.trim()).filter(Boolean);
  const last = lines[lines.length - 1] || '';
  const signOffIndex = lines.findIndex((line) => SIGN_OFF.test(line));
  return {
    greeting: lines.length > 0 && GREETING.test(lines[0]),
    thanks: THANKS.test(value),
    closing: CLOSING.test(value),
    signOff: signOffIndex !== -1,
    // A signature is the bare name after the closing phrase: one or two words, no full stop.
    signature: signOffIndex !== -1 && signOffIndex < lines.length - 1
      && /^[^.!?]{1,40}$/u.test(last) && countWords(last) <= 2,
  };
}

export function findTableFigures(text, rows) {
  const value = String(text ?? '');
  const numbers = new Set((value.match(/\d{1,3}(?=\s*%|\s*per\s*cent)/giu) || []).map(Number));
  const used = [];
  const missing = [];
  for (const row of rows || []) {
    (numbers.has(row.percent) ? used : missing).push(row.percent);
  }
  return { used, missing, mentionedFigures: [...numbers].sort((first, second) => first - second) };
}

export function findComparisons(text) {
  const value = String(text ?? '');
  return COMPARISON.filter((pattern) => pattern.test(value)).length;
}

export function findProblemAndSolution(text) {
  const value = String(text ?? '');
  return { problem: PROBLEM.test(value), solution: SOLUTION.test(value) };
}

export function analyzeWriting(input) {
  const answer = String(input?.answer ?? '');
  const blocks = countBlocks(answer);
  const facts = {
    words: countWords(answer),
    paragraphs: blocks.paragraphs,
    lines: blocks.lines,
    questionSentences: countQuestionSentences(answer),
  };
  if (input?.taskType === 'writing_37') {
    return { ...facts, letterParts: findLetterParts(answer) };
  }
  return {
    ...facts,
    tableFigures: findTableFigures(answer, input?.assignment?.rows),
    comparisonMarkers: findComparisons(answer),
    problemAndSolution: findProblemAndSolution(answer),
  };
}

// Rendered into the prompt. Counts are stated as verified; markers are stated as hints, because a
// pattern can prove that something is present but never that it is absent.
export function describeFacts(facts, taskType) {
  const verified = [
    `слов: ${facts.words}`,
    `абзацев: ${facts.paragraphs}`,
    `непустых строк: ${facts.lines}`,
    `вопросительных предложений: ${facts.questionSentences}`,
  ];
  const hints = [];

  if (taskType === 'writing_37') {
    const parts = facts.letterParts;
    verified.push(`обращение на первой строке: ${parts.greeting ? 'есть' : 'нет'}`);
    verified.push(`завершающая фраза на отдельной строке: ${parts.signOff ? 'есть' : 'нет'}`);
    verified.push(`подпись после завершающей фразы: ${parts.signature ? 'есть' : 'нет'}`);
    hints.push(`благодарность за письмо: ${parts.thanks ? 'найдена' : 'не найдена'}`);
    hints.push(`объяснение окончания письма: ${parts.closing ? 'найдено' : 'не найдено'}`);
  } else {
    const figures = facts.tableFigures;
    verified.push(`числа из таблицы использованы: ${figures.used.length ? figures.used.map((value) => value + '%').join(', ') : 'нет'}`);
    verified.push(`числа из таблицы не упомянуты: ${figures.missing.length ? figures.missing.map((value) => value + '%').join(', ') : 'нет'}`);
    hints.push(`маркеров сравнения: ${facts.comparisonMarkers}`);
    hints.push(`упоминание проблемы: ${facts.problemAndSolution.problem ? 'найдено' : 'не найдено'}`);
    hints.push(`упоминание решения: ${facts.problemAndSolution.solution ? 'найдено' : 'не найдено'}`);
  }

  return [
    `Проверено программно, это точные значения, не пересчитывай их: ${verified.join('; ')}.`,
    `Найдено по ключевым словам, это подсказка, а не доказательство — проверь по тексту: ${hints.join('; ')}.`,
  ].join('\n');
}
