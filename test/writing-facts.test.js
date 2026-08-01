import assert from 'node:assert/strict';
import test from 'node:test';

import {
  analyzeWriting, countBlocks, countQuestionSentences, countWords,
  describeFacts, findComparisons, findLetterParts, findProblemAndSolution, findTableFigures,
} from '../ai/writing-facts.js';
import { buildWritingPrompt, WRITING_PROMPT_VERSION } from '../ai/writing.js';

const LETTER = [
  'Dear Alison,',
  '',
  'Thanks a lot for your email! It was great to hear from you again.',
  '',
  'Reading is quite popular here. I read detective stories in my free time.',
  'By the way, what is your project about? How long did it take? Who helped you?',
  '',
  'Anyway, I have to go now.',
  'Hope to hear from you soon!',
  '',
  'Best wishes,',
  'Anya',
].join('\n');

test('word counting matches the rule the review is validated against', () => {
  assert.equal(countWords('one two three'), 3);
  assert.equal(countWords('  spaced   out  '), 2);
  assert.equal(countWords(''), 0);
  assert.equal(countWords(null), 0);
});

test('paragraphs and lines are reported separately', () => {
  assert.deepEqual({ ...countBlocks('a\n\nb\n\nc') }, { paragraphs: 3, lines: 3 });
  // A student who only pressed Enter once has one paragraph but several lines.
  assert.deepEqual({ ...countBlocks('a\nb\nc') }, { paragraphs: 1, lines: 3 });
  assert.deepEqual({ ...countBlocks('') }, { paragraphs: 0, lines: 0 });
});

test('a run of question marks closes exactly one question', () => {
  assert.equal(countQuestionSentences('What? Where? Why?'), 3);
  assert.equal(countQuestionSentences('Really?!?'), 1);
  assert.equal(countQuestionSentences('No questions here.'), 0);
});

test('the required parts of a letter are located by position, not by guessing', () => {
  const parts = findLetterParts(LETTER);
  assert.deepEqual({ ...parts }, { greeting: true, thanks: true, closing: true, signOff: true, signature: true });

  const noSignature = findLetterParts('Dear Sam,\nThanks!\nBest wishes,');
  assert.equal(noSignature.signOff, true);
  assert.equal(noSignature.signature, false, 'a closing phrase with nothing after it is not a signature');

  const plain = findLetterParts('I like sport. It is useful.');
  assert.deepEqual({ ...plain }, { greeting: false, thanks: false, closing: false, signOff: false, signature: false });
});

test('figures from the table are matched against the ones the student used', () => {
  const rows = [{ label: 'Fit', percent: 45 }, { label: 'Friends', percent: 25 }, { label: 'Other', percent: 30 }];
  const figures = findTableFigures('Almost half (45%) keep fit, while 25 per cent meet friends.', rows);

  assert.deepEqual(figures.used, [45, 25]);
  assert.deepEqual(figures.missing, [30]);
  // A bare number without a percent sign is not a figure from the table.
  assert.deepEqual(findTableFigures('I am 45 years old.', rows).used, []);
});

test('comparison and problem-solution markers are counted, never asserted as absent', () => {
  assert.ok(findComparisons('Keeping fit is twice as popular as meeting friends.') >= 1);
  assert.ok(findComparisons('It is more popular than reading.') >= 1);
  assert.ok(findComparisons('Reading is higher than sport, whereas music is lower.') >= 2);
  assert.equal(findComparisons('Everyone does sport.'), 0);

  assert.deepEqual({ ...findProblemAndSolution('However, the main problem is workload. A possible solution is short workouts.') },
    { problem: true, solution: true });
  assert.deepEqual({ ...findProblemAndSolution('Sport is good.') }, { problem: false, solution: false });
});

test('task 37 analysis carries the letter parts and no table data', () => {
  const facts = analyzeWriting({ taskType: 'writing_37', answer: LETTER });
  assert.equal(facts.questionSentences, 3);
  assert.equal(facts.paragraphs, 5);
  assert.equal(facts.lines, 8);
  assert.ok(facts.letterParts.greeting);
  assert.equal(facts.tableFigures, undefined);
});

test('task 38 analysis carries the table data and no letter parts', () => {
  const facts = analyzeWriting({
    taskType: 'writing_38',
    answer: 'According to the data, 45% keep fit, which is more than 25%.',
    assignment: { rows: [{ label: 'Fit', percent: 45 }, { label: 'Friends', percent: 25 }] },
  });
  assert.deepEqual(facts.tableFigures.used, [45, 25]);
  assert.ok(facts.comparisonMarkers >= 1);
  assert.equal(facts.letterParts, undefined);
});

test('counts and pattern hints are presented to the model as different kinds of evidence', () => {
  const facts = analyzeWriting({ taskType: 'writing_37', answer: LETTER });
  const description = describeFacts(facts, 'writing_37');

  assert.match(description, /это точные значения, не пересчитывай их/u);
  assert.match(description, /это подсказка, а не доказательство/u);
  assert.match(description, /вопросительных предложений: 3/u);
  // A keyword hit must not be dressed up as a verified fact.
  const [verified, hinted] = description.split('\n');
  assert.match(verified, /обращение на первой строке/u);
  assert.match(hinted, /благодарность за письмо/u);
  assert.doesNotMatch(verified, /благодарность/u);
});

test('the prompt ships the pre-check results and says so in its version', () => {
  const prompt = buildWritingPrompt({
    taskType: 'writing_37',
    answer: LETTER,
    assignment: { from: 'Alison', stimulus: 'Do you read? What books? Which one would you advise?', questionsTopic: 'the project' },
  });

  // Version string only: v4 adds the angle-bracket ban and the K1 aspect scheme (issue 15).
  assert.equal(WRITING_PROMPT_VERSION, 'writing-v4');
  assert.match(prompt.user, /Проверено программно/u);
  assert.equal(prompt.facts.questionSentences, 3);
  assert.equal(prompt.facts.words, countWords(LETTER));
});
