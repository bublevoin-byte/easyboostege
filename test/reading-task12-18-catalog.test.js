import assert from 'node:assert/strict';
import test from 'node:test';

import { assertReadingCatalog, assertReadingSet } from '../public/reading-catalog-contract.js';
import { READING_TASK10_SETS } from '../public/content/reading/task10-v1.js';
import { READING_TASK11_SETS } from '../public/content/reading/task11-v1.js';
import { READING_TASK12_18_SETS } from '../public/content/reading/task12-18-v1.js';
import * as readingPilotModule from '../public/reading-pilot-v1.js';
import {
  READING_EXPECTED_CEFR_COUNTS,
  cloneReadingFixture,
  englishWordCount,
  normalizedReadingText,
  russianWordCount,
} from './helpers/reading-catalog-fixtures.js';

const QUESTION_TYPES = new Set([
  'detail', 'inference', 'purpose-attitude', 'reference', 'vocabulary-context', 'main-idea',
]);
const WORD_RANGES = {
  B1: [450, 650],
  B2: [550, 750],
  'B2+/C1': [650, 850],
};

function occurrences(source, excerpt) {
  return source.split(excerpt).length - 1;
}

function assertTask12ContentPolicy(sets) {
  assert.equal(sets.length, 20, 'the task 12-18 shard must contain exactly 20 sets');
  assert.equal(new Set(sets.map((set) => set.id)).size, 20, 'set ids must be globally unique');
  assert.equal(new Set(sets.map((set) => set.title)).size, 20, 'set titles must be distinct');
  assert.equal(new Set(sets.map((set) => set.topic)).size, 20, 'each set must add a distinct topic');
  assert.equal(new Set(sets.map((set) => set.genre)).size, 20, 'each set must use a distinct relevant genre');

  const cefrCounts = Object.fromEntries(Object.keys(READING_EXPECTED_CEFR_COUNTS).map((cefr) => [cefr, 0]));
  const answerPositions = [0, 0, 0, 0];
  const passages = new Set();
  const prompts = new Set();
  const options = new Set();
  const explanations = new Set();
  const answerSequences = new Set();
  let questionCount = 0;
  let optionCount = 0;
  let correctIsUniquelyLongest = 0;

  sets.forEach((set, setIndex) => {
    assertReadingSet(set, setIndex);
    assert.equal(set.kind, 'task12_18');
    assert.equal(set.revision, 1, `${set.id}: revision must stay pinned to 1`);
    assert.equal(set.provenance, 'original');
    cefrCounts[set.cefr] += 1;

    const textFingerprint = normalizedReadingText(set.task.text);
    assert.equal(passages.has(textFingerprint), false, `${set.id}: normalized passage is duplicated`);
    passages.add(textFingerprint);

    const words = englishWordCount(set.task.text);
    const [minimumWords, maximumWords] = WORD_RANGES[set.cefr];
    assert.ok(
      words >= minimumWords && words <= maximumWords,
      `${set.id}: expected ${minimumWords}-${maximumWords} passage words, received ${words}`,
    );
    const paragraphs = set.task.text.split(/\n\s*\n/gu);
    assert.ok(paragraphs.length >= 6 && paragraphs.length <= 10, `${set.id}: expected 6-10 natural paragraphs`);
    paragraphs.forEach((paragraph, position) => {
      const paragraphWords = englishWordCount(paragraph);
      assert.ok(
        paragraphWords >= 45 && paragraphWords <= 150,
        `${set.id}.paragraphs[${position}]: expected 45-150 words, received ${paragraphWords}`,
      );
    });

    assert.equal(set.task.questions.length, 7);
    const setTypes = new Set();
    set.task.questions.forEach((question, position) => {
      const location = `${set.id}.task.questions[${position}]`;
      questionCount += 1;
      optionCount += question.options.length;
      assert.equal(question.id, `${set.id}.q${position + 1}`, `${location}: question id is not stable`);
      assert.equal(QUESTION_TYPES.has(question.type), true, `${location}: unknown question type`);
      setTypes.add(question.type);

      const promptFingerprint = normalizedReadingText(question.prompt);
      assert.equal(prompts.has(promptFingerprint), false, `${location}: normalized prompt is duplicated`);
      prompts.add(promptFingerprint);
      assert.doesNotMatch(question.prompt, /\b(?:the answer is|choose option|correct option)\b/iu, `${location}: answer instruction leaks into prompt`);

      assert.equal(question.options.length, 4, `${location}: expected four options`);
      const tokenCounts = question.options.map(englishWordCount);
      assert.ok(Math.max(...tokenCounts) - Math.min(...tokenCounts) <= 12, `${location}: options are not reasonably parallel in length`);
      const punctuationPattern = question.options.map((option) => /[.!?]$/u.test(option));
      assert.equal(new Set(punctuationPattern).size, 1, `${location}: option punctuation must be parallel`);
      question.options.forEach((option, optionIndex) => {
        const optionFingerprint = normalizedReadingText(option);
        assert.equal(options.has(optionFingerprint), false, `${location}.options[${optionIndex}]: normalized option is duplicated`);
        options.add(optionFingerprint);
      });

      assert.equal(Number.isSafeInteger(question.answer), true, `${location}: answer must be numeric`);
      answerPositions[question.answer] += 1;
      assert.equal(
        promptFingerprint.includes(normalizedReadingText(question.options[question.answer])),
        false,
        `${location}: prompt reveals the correct option`,
      );
      const longest = Math.max(...question.options.map((option) => option.length));
      if (question.options.filter((option) => option.length === longest).length === 1
        && question.options[question.answer].length === longest) correctIsUniquelyLongest += 1;

      const quoteWords = englishWordCount(question.evidence.quote);
      assert.ok(quoteWords >= 6 && quoteWords <= 45, `${location}: evidence must contain 6-45 words`);
      assert.equal(set.task.text.includes(question.evidence.quote), true, `${location}: evidence must be a verbatim passage substring`);
      assert.equal(occurrences(set.task.text, question.evidence.quote), 1, `${location}: evidence must identify one exact passage location`);
      assert.ok(russianWordCount(question.evidence.explanationRu) >= 11, `${location}: Russian explanation is not substantive`);
      assert.match(
        question.evidence.explanationRu,
        /показыв|подтвержд|следу|означа|противореч|исключ|раскрыва|указыв|относ|поэтому|связыв|отража|объясн|подчерк|переда|формулир|называ|определя/iu,
        `${location}: explanation must connect evidence to the answer`,
      );
      assert.doesNotMatch(
        question.evidence.explanationRu,
        /^(?:эта|данная)\s+(?:цитата|формулировка|фраза|часть)\s+(?:прямо\s+)?(?:показывает|подтверждает|формулирует|указывает|называет|определяет)(?:\s+на)?\s+(?:правильный\s+)?(?:ответ|вариант)(?:\s+на\s+(?:заданный\s+)?вопрос)?(?:,\s*(?:а\s+)?(?:поэтому\s+)?(?:все\s+)?(?:остальные|другие)\s+варианты(?:\s+ответа)?\s+(?:не\s+подходят(?:\s+к\s+вопросу)?|неверны|исключаются))?\.?$/iu,
        `${location}: generic explanation is forbidden`,
      );
      const explanationFingerprint = normalizedReadingText(question.evidence.explanationRu);
      assert.equal(explanations.has(explanationFingerprint), false, `${location}: explanation is repeated boilerplate`);
      explanations.add(explanationFingerprint);
    });
    const answerSequence = set.task.questions.map((question) => question.answer);
    const answerFingerprint = answerSequence.join('');
    assert.equal(answerSequences.has(answerFingerprint), false, `${set.id}: answer sequence is reused`);
    assert.equal(
      answerSequence.slice(4).every((answer, position) => answer === answerSequence[position]),
      false,
      `${set.id}: answer sequence must not be a predictable four-position cycle`,
    );
    answerSequences.add(answerFingerprint);
    assert.equal(setTypes.has('detail'), true, `${set.id}: detail coverage is required`);
    assert.equal(setTypes.has('inference'), true, `${set.id}: inference coverage is required`);
    assert.ok(setTypes.size >= 4, `${set.id}: expected at least four question types, received ${setTypes.size}`);
  });

  assert.deepEqual(cefrCounts, READING_EXPECTED_CEFR_COUNTS, 'CEFR distribution must remain 4 B1 / 12 B2 / 4 B2+/C1');
  assert.equal(questionCount, 140);
  assert.equal(optionCount, 560);
  assert.equal(passages.size, 20);
  assert.equal(prompts.size, 140);
  assert.equal(options.size, 560);
  assert.equal(explanations.size, 140);
  assert.deepEqual(answerPositions, [35, 35, 35, 35], 'correct positions must be exactly balanced across 140 questions');
  assert.ok(correctIsUniquelyLongest <= 55, 'the longest option must not act as a reliable answer cue');
}

test('task 12-18 shard contains 20 original long passages and exactly 140 auditable questions', () => {
  assertTask12ContentPolicy(READING_TASK12_18_SETS);
  assert.equal(READING_TASK12_18_SETS.every((set) => Object.isFrozen(set)), true);
});

test('the task 12-18 shard and complete catalog load through lazy production entry points', async () => {
  assert.equal(await readingPilotModule.loadReadingTask12Shard(), READING_TASK12_18_SETS);
  const catalog = await readingPilotModule.loadReadingPilotCatalog();
  assert.equal(assertReadingCatalog(catalog), catalog);
  assert.equal(catalog.sets.length, 60);
  assert.equal(catalog.sets.filter((set) => set.kind === 'task12_18').length, 20);
  assert.deepEqual(
    catalog.sets.reduce((counts, set) => ({ ...counts, [set.cefr]: counts[set.cefr] + 1 }), {
      B1: 0, B2: 0, 'B2+/C1': 0,
    }),
    { B1: 12, B2: 36, 'B2+/C1': 12 },
  );
  assert.equal(catalog.sets.every((set) => set.provenance === 'original'), true);
  assert.equal(Object.isFrozen(catalog.sets.at(-1).task.questions[0].options), true);
});

test('task 12-18 content policy rejects count, identity, duplication, leak and audit regressions', async (t) => {
  const cases = [
    ['set count', (sets) => sets.pop(), /exactly 20 sets/u],
    ['question count', (sets) => sets[0].task.questions.pop(), /exactly 7 questions|questions.*7/u],
    ['option count', (sets) => sets[0].task.questions[0].options.pop(), /exactly 4 options|four options/u],
    ['unstable id', (sets) => { sets[0].task.questions[0].id = `${sets[0].id}.q7`; }, /id must be/u],
    ['normalized prompt duplicate', (sets) => {
      sets[1].task.questions[0].prompt = `  ${sets[0].task.questions[0].prompt.toUpperCase()}  `;
    }, /normalized prompt is duplicated/u],
    ['normalized passage duplicate', (sets) => {
      sets[1].task.text = sets[0].task.text;
      sets[1].task.questions.forEach((question) => { question.evidence.quote = sets[0].task.questions[0].evidence.quote; });
    }, /normalized passage is duplicated/u],
    ['normalized option duplicate', (sets) => {
      sets[0].task.questions[1].options[0] = ` ${sets[0].task.questions[0].options[0].toUpperCase()} `;
    }, /normalized option is duplicated/u],
    ['evidence outside source', (sets) => {
      sets[0].task.questions[0].evidence.quote = 'This invented evidence sentence cannot be found in the source passage.';
    }, /quote must occur verbatim|verbatim passage substring/u],
    ['literal answer leak', (sets) => {
      const question = sets[0].task.questions[0];
      question.prompt += ` ${question.options[question.answer]}`;
    }, /reveal/u],
    ['reused answer sequence', (sets) => {
      sets[1].task.questions.forEach((question, position) => {
        question.answer = sets[0].task.questions[position].answer;
      });
    }, /answer sequence is reused/u],
    ['cyclic answer sequence', (sets) => {
      const descendingCycle = [0, 3, 2, 1, 0, 3, 2];
      sets[0].task.questions.forEach((question, position) => { question.answer = descendingCycle[position]; });
    }, /predictable four-position cycle/u],
    ['CEFR split', (sets) => { sets[4].cefr = 'B1'; }, /CEFR|cefr/u],
    ['provenance', (sets) => { sets[0].provenance = 'generated'; }, /provenance must be original/u],
    ['revision', (sets) => { sets[0].revision = 0; }, /revision must be a positive integer/u],
    ['generic explanation', (sets) => {
      sets[0].task.questions[0].evidence.explanationRu = 'Эта цитата показывает правильный ответ.';
    }, /not substantive/u],
    ['formal explanation chaff', (sets) => {
      sets[0].task.questions[0].evidence.explanationRu = 'Эта цитата прямо показывает правильный ответ на заданный вопрос, поэтому все остальные варианты ответа не подходят к вопросу.';
    }, /generic explanation/u],
  ];

  for (const [name, mutate, pattern] of cases) {
    await t.test(name, () => {
      const damaged = cloneReadingFixture(READING_TASK12_18_SETS);
      mutate(damaged);
      assert.throws(() => assertTask12ContentPolicy(damaged), pattern);
    });
  }
});

test('manual semantic audit pins every corrected key to its evidence-supported option', () => {
  /* These literals record human editorial findings; structural heuristics are not a semantic judge. */
  const expectedCorrections = {
    'museum-after-closing-time.q3': 'To show feedback exposed an excluding assumption',
    'joke-that-crossed-a-border.q2': 'It might wrongly connect the fictional character to a real culture',
    'map-made-of-memories.q1': 'It omitted some locations residents said had flooded',
    'map-made-of-memories.q2': 'So reports could be assessed and checked with appropriate care',
    'lunchroom-as-a-laboratory.q2': 'Pupils selected more but also left more uneaten',
    'lunchroom-as-a-laboratory.q3': 'They lowered the social and practical risk of trying something',
    'photographs-without-names.q3': 'A small visual detail can overturn a confident shared interpretation',
    'feed-that-learned-too-well.q2': 'A long pause may reflect absence rather than interest',
    'feed-that-learned-too-well.q4': 'Signals from Hana’s observable reading actions',
    'feed-that-learned-too-well.q5': 'A group of closely related familiar topics',
    'crop-below-the-tide.q3': 'To show farm decisions respond to local growth and weather',
    'crop-below-the-tide.q4': 'The restaurants’ changing purchases of seaweed',
    'crop-below-the-tide.q5': 'Unaffected locations used to judge changes near the farm',
    'crop-below-the-tide.q6': 'Testing linked ecological, labour and market factors',
    'crop-below-the-tide.q7': 'To include environmental costs alongside productive output',
    'language-returning-to-airwaves.q7': 'One online-play total cannot show whether recognition becomes active use',
    'weather-written-before-instruments.q5': 'A sequence of connected evidence from independent records',
    'weather-written-before-instruments.q6': 'Transparent ranges can represent limited evidence more honestly',
    'weather-written-before-instruments.q7': 'A trustworthy record may be irrelevant to the inference being made',
    'journey-home-for-storm-bird.q2': 'To distinguish its obligations from a generic art example',
    'forest-that-listens-back.q1': 'Human teams could not observe every valley frequently enough',
  };
  const questions = new Map(READING_TASK12_18_SETS.flatMap((set) => (
    set.task.questions.map((question, position) => [`${set.id.split('.').at(-1)}.q${position + 1}`, question])
  )));

  assert.equal(Object.keys(expectedCorrections).length, 21);
  Object.entries(expectedCorrections).forEach(([id, expectedOption]) => {
    const question = questions.get(id);
    assert.ok(question, `${id}: audited question must exist`);
    assert.equal(question.options[question.answer], expectedOption, `${id}: key must match the manual semantic audit`);
  });

  assert.equal(
    questions.get('joke-that-crossed-a-border.q4').prompt,
    'What may be unable to hold a longer phrase in paragraph 4?',
  );

  const stormBirdQuestion = questions.get('journey-home-for-storm-bird.q1');
  assert.equal(stormBirdQuestion.options[stormBirdQuestion.answer], 'Letters revealing coercion behind the supposed collection');
  assert.match(stormBirdQuestion.evidence.quote, /troops ordered a coastal village to surrender ceremonial objects/u);
});

test('all three production shards assemble into one strict frozen catalog', () => {
  const catalog = readingPilotModule.assembleReadingPilotCatalog({
    task10: READING_TASK10_SETS,
    task11: READING_TASK11_SETS,
    task12_18: READING_TASK12_18_SETS,
  });
  assert.equal(assertReadingCatalog(catalog), catalog);
  assert.equal(catalog.sets.length, 60);
  assert.equal(Object.isFrozen(catalog), true);
  assert.equal(Object.isFrozen(catalog.sets.at(-1).task.questions[0].evidence), true);
});
