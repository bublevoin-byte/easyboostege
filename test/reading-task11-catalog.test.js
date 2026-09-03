import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertReadingCatalog,
  assertReadingSet,
} from '../public/reading-catalog-contract.js';
import * as readingPilotModule from '../public/reading-pilot-v1.js';
import { READING_TASK10_SETS } from '../public/content/reading/task10-v1.js';
import { READING_TASK11_SETS } from '../public/content/reading/task11-v1.js';
import {
  READING_EXPECTED_CEFR_COUNTS,
  READING_POSITION_LABELS,
  cloneReadingFixture,
  englishWordCount,
  futureTask12Sets,
  normalizedReadingText,
  russianWordCount,
} from './helpers/reading-catalog-fixtures.js';

const POSITION_LABELS = READING_POSITION_LABELS.slice(0, 6);
const EXPECTED_CEFR_COUNTS = READING_EXPECTED_CEFR_COUNTS;
const clone = cloneReadingFixture;
const normalized = normalizedReadingText;

function restoreTask11Text(set) {
  return set.task.segments.map((segment, position) => (
    position < 6 ? `${segment}${set.task.fragments[set.task.answers[position]]}` : segment
  )).join(' ');
}

function assertTask11ContentPolicy(sets) {
  assert.equal(sets.length, 20, 'the task 11 shard must contain exactly 20 sets');
  assert.equal(new Set(sets.map((set) => set.id)).size, 20, 'set ids must be globally unique');
  assert.equal(new Set(sets.map((set) => set.topic)).size, 20, 'each set must add a distinct topic');
  assert.equal(new Set(sets.map((set) => set.title)).size, 20, 'set titles must be distinct');
  assert.equal(new Set(sets.map((set) => set.genre)).size, 20, 'each set must use a distinct relevant genre');

  const cefrCounts = Object.fromEntries(Object.keys(EXPECTED_CEFR_COUNTS).map((cefr) => [cefr, 0]));
  const allSegments = new Set();
  const allFragments = new Set();
  const restoredTexts = new Set();
  const explanations = new Set();
  const permutations = new Set();
  const unusedIndexes = new Set();
  let gapCount = 0;

  sets.forEach((set, setIndex) => {
    assertReadingSet(set, setIndex);
    assert.equal(set.kind, 'task11');
    assert.equal(set.provenance, 'original');
    cefrCounts[set.cefr] += 1;
    gapCount += set.task.answers.length;

    const permutation = set.task.answers.join('');
    assert.equal(permutations.has(permutation), false, `${set.id}: answer permutation is reused`);
    permutations.add(permutation);
    assert.equal(new Set(set.task.answers).size, 6, `${set.id}: answers must use six unique fragment indexes`);
    assert.equal(set.task.answers.every((answer) => answer >= 0 && answer <= 6), true);
    const unused = set.task.fragments.map((_, index) => index).filter((index) => !set.task.answers.includes(index));
    assert.equal(unused.length, 1, `${set.id}: exactly one fragment must be unused`);
    unusedIndexes.add(unused[0]);

    set.task.segments.forEach((segment, position) => {
      const words = englishWordCount(segment);
      assert.ok(words >= 12 && words <= 65, `${set.id}.segments[${position}]: expected 12-65 words, received ${words}`);
      const fingerprint = normalized(segment);
      assert.equal(allSegments.has(fingerprint), false, `${set.id}.segments[${position}]: segment is duplicated globally`);
      assert.equal(allFragments.has(fingerprint), false, `${set.id}.segments[${position}]: segment duplicates an earlier fragment`);
      allSegments.add(fingerprint);
      assert.doesNotMatch(segment, /(?:\[[A-F]\]|_{2,}|<\/?gap>|\b(?:gap|fragment|option)\s*[A-G0-7]\b)/iu);
    });

    set.task.fragments.forEach((fragment, position) => {
      const words = englishWordCount(fragment);
      assert.ok(words >= 4 && words <= 28, `${set.id}.fragments[${position}]: expected 4-28 words, received ${words}`);
      const fingerprint = normalized(fragment);
      assert.equal(allFragments.has(fingerprint), false, `${set.id}.fragments[${position}]: fragment is duplicated globally`);
      assert.equal(allSegments.has(fingerprint), false, `${set.id}.fragments[${position}]: fragment duplicates a segment`);
      allFragments.add(fingerprint);
      assert.equal(
        set.task.segments.some((segment) => normalized(segment).includes(fingerprint)),
        false,
        `${set.id}.fragments[${position}]: fragment leaks verbatim into the visible text`,
      );
    });

    const restored = restoreTask11Text(set);
    const restoredFingerprint = normalized(restored);
    assert.equal(restoredTexts.has(restoredFingerprint), false, `${set.id}: restored text is duplicated globally`);
    restoredTexts.add(restoredFingerprint);
    const restoredWords = englishWordCount(restored);
    assert.ok(restoredWords >= 175 && restoredWords <= 330, `${set.id}: expected 175-330 restored words, received ${restoredWords}`);
    assert.doesNotMatch(restored, /\s+[,.!?;:]|[.!?][a-z]|\s{2,}/u, `${set.id}: restored text has a broken mechanical join`);
    assert.equal(restored.includes(set.task.fragments[unused[0]]), false, `${set.id}: unused fragment entered the restored text`);
    set.task.answers.forEach((answer) => {
      assert.equal(restored.split(set.task.fragments[answer]).length - 1, 1, `${set.id}: answer fragment must occur once`);
    });

    set.task.evidence.forEach((evidence, position) => {
      const location = `${set.id}.evidence[${position}]`;
      const left = set.task.segments[position];
      const right = set.task.segments[position + 1];
      assert.equal(evidence.position, POSITION_LABELS[position], `${location}: position is not stable`);
      assert.equal(evidence.answer, set.task.answers[position], `${location}: evidence answer differs from the key`);
      assert.equal(left.endsWith(evidence.leftContext), true, `${location}: leftContext must be an exact suffix`);
      assert.equal(right.startsWith(evidence.rightContext), true, `${location}: rightContext must be an exact prefix`);
      assert.equal(`${left} ${right}`.includes(evidence.quote), true, `${location}: quote must be in adjacent source context`);
      assert.ok(englishWordCount(evidence.leftContext) >= 3, `${location}: left context is too vague`);
      assert.ok(englishWordCount(evidence.rightContext) >= 3, `${location}: right context is too vague`);
      assert.ok(englishWordCount(evidence.quote) >= 4, `${location}: evidence quote is too vague`);
      assert.ok(russianWordCount(evidence.explanationRu) >= 10, `${location}: Russian explanation is not substantive`);
      assert.match(
        evidence.explanationRu,
        /связ|местоим|союз|причин|следств|контраст|противопостав|временн|лексическ|повтор|согласован|придаточ|инфинитив|относительн|последователь|услов|уточн|подлежащ|сказуем|дополн|глагол|артикл|форма|герунд|предлог|параллельн|перечислен|конструкц|сравнительн/iu,
        `${location}: explanation must name a lexical, grammatical or logical link`,
      );
      assert.doesNotMatch(
        evidence.explanationRu,
        /^(?:эта|данная)?\s*(?:цитата|часть|фраза) (?:прямо )?(?:подтверждает|подходит|связывает) (?:правильный )?ответ\.?$/iu,
        `${location}: generic explanation is forbidden`,
      );
      const explanationFingerprint = normalized(evidence.explanationRu);
      assert.equal(explanations.has(explanationFingerprint), false, `${location}: explanation is repeated boilerplate`);
      explanations.add(explanationFingerprint);
    });
  });

  assert.deepEqual(cefrCounts, EXPECTED_CEFR_COUNTS);
  assert.equal(gapCount, 120);
  assert.equal(allSegments.size, 140);
  assert.equal(allFragments.size, 140);
  assert.equal(restoredTexts.size, 20);
  assert.equal(explanations.size, 120);
  assert.equal(permutations.size, 20);
  assert.equal(unusedIndexes.size, 7, 'the unused answer position must rotate across the bank');
}

test('task 11 shard is exposed through the lazy Reading pilot loader', async () => {
  assert.equal(await readingPilotModule.loadReadingTask11Shard(), READING_TASK11_SETS);
  assert.equal(Object.isFrozen(READING_TASK11_SETS), true);
  assert.equal('READING_CATALOG' in readingPilotModule, false);
  assert.equal('default' in readingPilotModule, false);
});

test('task 11 shard contains 20 original exam-sized sets with auditable cohesive joins', () => {
  assertTask11ContentPolicy(READING_TASK11_SETS);
  assert.equal(READING_TASK11_SETS.every((set) => Object.isFrozen(set)), true);
});

test('assembler fails closed at 40 sets and publishes only a strict-valid frozen 60-set catalog', () => {
  assert.throws(() => readingPilotModule.assembleReadingPilotCatalog({
    task10: READING_TASK10_SETS,
    task11: READING_TASK11_SETS,
  }), /task12_18 shard must be an array|expected 60/u);

  const catalog = readingPilotModule.assembleReadingPilotCatalog({
    task10: READING_TASK10_SETS,
    task11: READING_TASK11_SETS,
    task12_18: futureTask12Sets(),
  });
  assert.equal(assertReadingCatalog(catalog), catalog);
  assert.equal(catalog.sets.length, 60);
  assert.equal(Object.isFrozen(catalog), true);
  assert.equal(Object.isFrozen(catalog.sets), true);
});

test('human-audit regressions keep their deterministic structural symptoms fixed', () => {
  /* These checks pin review findings; they do not claim to automate semantic judgement. */
  const station = READING_TASK11_SETS.find((set) => set.id.endsWith('.station-after-dark'));
  const stationText = restoreTask11Text(station);
  assert.match(stationText, /volunteers each kept a simple travel diary/u);
  assert.doesNotMatch(stationText, /volunteers kept one simple travel diary[\s\S]*The diaries/u);

  const oralHistory = READING_TASK11_SETS.find((set) => set.id.endsWith('.the-pause-in-the-story'));
  const oralUnused = oralHistory.task.fragments.find((_, index) => !oralHistory.task.answers.includes(index));
  assert.doesNotMatch(
    oralUnused,
    /^(?:that|where|whether|why|how)\b/iu,
    'unused fragment must not form another content clause after “The producer knew”',
  );

  const weather = READING_TASK11_SETS.find((set) => set.id.endsWith('.weather-from-many-windows'));
  assert.doesNotMatch(restoreTask11Text(weather), /particular winds[^.]*particular winds/iu);
});

test('task 11 content policy detects structural, cohesion and audit regressions', async (t) => {
  const cases = [
    ['short segment', (sets) => { sets[0].task.segments[0] = 'Far too short.'; }, /between 20 and 1500|12-65 words/u],
    ['global segment duplicate', (sets) => {
      sets[1].task.segments[0] = sets[0].task.segments[0];
      sets[1].task.evidence[0].leftContext = sets[0].task.evidence[0].leftContext;
      sets[1].task.evidence[0].quote = sets[0].task.evidence[0].quote;
    }, /segment is duplicated globally/u],
    ['global fragment duplicate', (sets) => {
      sets[1].task.fragments[0] = sets[0].task.fragments[0];
    }, /fragment is duplicated globally/u],
    ['duplicate answer key', (sets) => {
      sets[0].task.answers[1] = sets[0].task.answers[0];
      sets[0].task.evidence[1].answer = sets[0].task.answers[0];
    }, /unique keys|six unique fragment indexes/u],
    ['inexact left context', (sets) => {
      sets[0].task.evidence[0].leftContext = sets[0].task.evidence[0].leftContext.slice(0, -1);
    }, /exact suffix/u],
    ['inexact right context', (sets) => {
      sets[0].task.evidence[0].rightContext = sets[0].task.evidence[0].rightContext.slice(1);
    }, /exact prefix/u],
    ['evidence outside neighbours', (sets) => {
      sets[0].task.evidence[0].quote = 'This invented quotation is absent from both neighbouring segments.';
    }, /quote must occur verbatim|adjacent source context/u],
    ['generic explanation', (sets) => {
      sets[0].task.evidence[0].explanationRu = 'Эта фраза прямо подтверждает правильный ответ.';
    }, /not substantive|generic explanation/u],
    ['literal fragment leak', (sets) => {
      sets[0].task.segments[0] += ` ${sets[0].task.fragments[0]}`;
    }, /fragment leaks verbatim/u],
    ['broken mechanical join', (sets) => {
      const answer = sets[0].task.answers[0];
      sets[0].task.fragments[answer] = ` ${sets[0].task.fragments[answer]}`;
    }, /broken mechanical join/u],
    ['reused answer permutation', (sets) => {
      sets[1].task.answers = sets[0].task.answers.slice();
      sets[1].task.evidence.forEach((evidence, position) => { evidence.answer = sets[1].task.answers[position]; });
    }, /answer permutation is reused/u],
  ];

  for (const [name, mutate, pattern] of cases) {
    await t.test(name, () => {
      const damaged = clone(READING_TASK11_SETS);
      mutate(damaged);
      assert.throws(() => assertTask11ContentPolicy(damaged), pattern);
    });
  }
});
