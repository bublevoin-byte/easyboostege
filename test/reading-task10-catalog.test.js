import assert from 'node:assert/strict';
import test from 'node:test';

import {
  READING_CATALOG_ID,
  READING_CONTRACT_VERSION,
  assertReadingCatalog,
  assertReadingSet,
} from '../public/reading-catalog-contract.js';
import * as readingPilotModule from '../public/reading-pilot-v1.js';
import { READING_TASK10_SETS } from '../public/content/reading/task10-v1.js';

const { assembleReadingPilotCatalog } = readingPilotModule;
const POSITION_LABELS = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
const EXPECTED_CEFR_COUNTS = { B1: 4, B2: 12, 'B2+/C1': 4 };

function clone(value) {
  return structuredClone(value);
}

function normalized(value) {
  return value.trim().toLocaleLowerCase('en').replace(/\s+/gu, ' ');
}

function englishWordCount(value) {
  return value.match(/[A-Za-z]+(?:[’'-][A-Za-z]+)*/gu)?.length || 0;
}

function russianWordCount(value) {
  return value.match(/[А-Яа-яЁё]+(?:-[А-Яа-яЁё]+)*/gu)?.length || 0;
}

function assertTask10ContentPolicy(sets) {
  assert.equal(sets.length, 20, 'the task 10 shard must contain exactly 20 sets');
  assert.equal(new Set(sets.map((set) => set.id)).size, 20, 'set ids must be globally unique');
  assert.equal(new Set(sets.map((set) => set.topic)).size, 20, 'each set must add a distinct topic');

  const cefrCounts = Object.fromEntries(Object.keys(EXPECTED_CEFR_COUNTS).map((cefr) => [cefr, 0]));
  const normalizedTexts = new Set();
  const normalizedAssignments = new Set();
  const normalizedExplanations = new Set();

  sets.forEach((set, setIndex) => {
    assertReadingSet(set, setIndex);
    cefrCounts[set.cefr] += 1;

    const taskFingerprint = normalized(JSON.stringify({
      texts: set.task.texts.map((item) => item.text),
      headings: set.task.headings,
    }));
    assert.equal(normalizedAssignments.has(taskFingerprint), false, `${set.id}: normalized assignment is duplicated`);
    normalizedAssignments.add(taskFingerprint);

    assert.equal(new Set(set.task.answers).size, 7, `${set.id}: answers must form a seven-key bijection`);
    const unused = set.task.headings.map((_, index) => index).filter((index) => !set.task.answers.includes(index));
    assert.equal(unused.length, 1, `${set.id}: exactly one heading must remain unused`);

    set.task.texts.forEach((item, position) => {
      const location = `${set.id}.task.texts[${position}]`;
      assert.equal(item.id, POSITION_LABELS[position], `${location}: stable position id`);
      const words = englishWordCount(item.text);
      assert.ok(words >= 40 && words <= 105, `${location}: expected 40-105 words, received ${words}`);

      const fingerprint = normalized(item.text);
      assert.equal(normalizedTexts.has(fingerprint), false, `${location}: normalized text is duplicated globally`);
      normalizedTexts.add(fingerprint);

      for (const heading of set.task.headings) {
        assert.equal(
          fingerprint.includes(normalized(heading)),
          false,
          `${location}: heading leaks verbatim into its task text`,
        );
      }

      const evidence = set.task.evidence[position];
      assert.equal(evidence.position, item.id, `${location}: evidence position must match`);
      assert.equal(evidence.answer, set.task.answers[position], `${location}: evidence key must match`);
      assert.ok(item.text.includes(evidence.quote), `${location}: evidence must be a verbatim substring`);
      assert.ok(englishWordCount(evidence.quote) >= 5, `${location}: evidence quote is too vague`);
      assert.ok(russianWordCount(evidence.explanationRu) >= 9, `${location}: Russian explanation is not substantive`);
      assert.doesNotMatch(
        evidence.explanationRu,
        /^(?:эта|данная)?\s*цитата (?:прямо )?подтверждает (?:правильный )?ответ\.?$/iu,
        `${location}: generic explanation is forbidden`,
      );
      const explanationFingerprint = normalized(evidence.explanationRu);
      assert.equal(
        normalizedExplanations.has(explanationFingerprint),
        false,
        `${location}: explanation must be specific rather than repeated boilerplate`,
      );
      normalizedExplanations.add(explanationFingerprint);
    });
  });

  assert.deepEqual(cefrCounts, EXPECTED_CEFR_COUNTS);
  assert.equal(normalizedTexts.size, 140);
  assert.equal(normalizedAssignments.size, 20);
  assert.equal(normalizedExplanations.size, 140);
}

function futureEnvelope(kind, index) {
  const cefr = index < 4 ? 'B1' : (index < 16 ? 'B2' : 'B2+/C1');
  return {
    id: `${READING_CATALOG_ID}.${kind}.future-${String(index + 1).padStart(2, '0')}`,
    revision: 1,
    kind,
    title: `Future ${kind} fixture ${index + 1}`,
    topic: `future-${kind}-${index + 1}`,
    cefr,
    provenance: 'original',
    validation: { contract: READING_CONTRACT_VERSION },
  };
}

function futureTask11Set(index) {
  const set = futureEnvelope('task11', index);
  const segments = Array.from({ length: 7 }, (_, position) => (
    `Future gap fixture ${index + 1}, segment ${position + 1}, provides distinct surrounding context for strict catalog validation. `
  ));
  return {
    ...set,
    task: {
      segments,
      fragments: Array.from({ length: 7 }, (_, position) => (
        `future fragment ${index + 1}-${position + 1} completes one grammatical connection`
      )),
      answers: [0, 1, 2, 3, 4, 5],
      evidence: Array.from({ length: 6 }, (_, position) => ({
        position: POSITION_LABELS[position],
        answer: position,
        leftContext: segments[position].trim(),
        rightContext: segments[position + 1].trim(),
        quote: `Future gap fixture ${index + 1}, segment ${position + 1}`,
        explanationRu: `Тестовый контекст позиции ${position + 1} однозначно связывает соседние части будущего комплекта ${index + 1}.`,
      })),
    },
  };
}

function futureTask12Set(index) {
  const set = futureEnvelope('task12_18', index);
  const details = Array.from({ length: 7 }, (_, position) => (
    `Future detail fixture ${index + 1}-${position + 1} records an independent fact for strict validation. `
      + `Its deliberately separate wording keeps the passage and question globally identifiable without modelling production content.`
  ));
  return {
    ...set,
    task: {
      text: details.join(' '),
      questions: details.map((_, position) => ({
        id: `${set.id}.q${position + 1}`,
        prompt: `Which independent fact is tested by future fixture ${index + 1}-${position + 1}?`,
        options: Array.from({ length: 4 }, (__, option) => (
          `Future option ${index + 1}-${position + 1}-${option + 1}`
        )),
        answer: position % 4,
        evidence: {
          quote: `Future detail fixture ${index + 1}-${position + 1} records an independent fact`,
          explanationRu: `Тестовая цитата позиции ${position + 1} связывает вопрос с отдельным фактом будущего комплекта ${index + 1}.`,
        },
      })),
    },
  };
}

function futureShards() {
  return {
    task11: Array.from({ length: 20 }, (_, index) => futureTask11Set(index)),
    task12_18: Array.from({ length: 20 }, (_, index) => futureTask12Set(index)),
  };
}

test('task 10 shard contains 20 original exam-sized sets with a 4/12/4 CEFR split', () => {
  assertTask10ContentPolicy(READING_TASK10_SETS);
  assert.equal(READING_TASK10_SETS.every((set) => set.kind === 'task10'), true);
  assert.equal(READING_TASK10_SETS.every((set) => set.provenance === 'original'), true);
  assert.equal(READING_TASK10_SETS.every((set) => Object.isFrozen(set)), true);
});

test('task 10 content policy detects length, duplication, key, explanation and leak regressions', async (t) => {
  const cases = [
    ['short text', (sets) => {
      sets[0].task.texts[0].text = 'A text that is much too short for this exam-sized task.';
      sets[0].task.evidence[0].quote = 'much too short for this exam-sized task';
    }, /40-105 words/u],
    ['normalized duplicate text', (sets) => {
      sets[1].task.texts[0].text = `  ${sets[0].task.texts[0].text.toUpperCase()}  `;
      sets[1].task.evidence[0].quote = sets[1].task.texts[0].text.trim();
    }, /normalized text is duplicated globally/u],
    ['duplicate matching key', (sets) => { sets[0].task.answers[1] = sets[0].task.answers[0]; }, /unique keys|seven-key bijection/u],
    ['generic explanation', (sets) => { sets[0].task.evidence[0].explanationRu = 'Эта цитата прямо подтверждает правильный ответ.'; }, /not substantive|generic explanation/u],
    ['heading leak', (sets) => {
      sets[0].task.headings[7] = 'unexpected literal answer leak';
      sets[0].task.texts[0].text += ' The unexpected literal answer leak is visible here.';
    }, /heading leaks verbatim/u],
  ];

  for (const [name, mutate, pattern] of cases) {
    await t.test(name, () => {
      const damaged = clone(READING_TASK10_SETS);
      mutate(damaged);
      assert.throws(() => assertTask10ContentPolicy(damaged), pattern);
    });
  }
});

test('task 10 shard passes the shared strict set validator and rejects unauditable mutations', async (t) => {
  READING_TASK10_SETS.forEach((set, index) => assertReadingSet(set, index));
  const cases = [
    ['wrong text count', (set) => set.task.texts.pop(), /exactly 7 texts/u],
    ['wrong heading count', (set) => set.task.headings.pop(), /exactly 8 headings/u],
    ['evidence outside paragraph', (set) => { set.task.evidence[0].quote = 'This sentence is absent from the paragraph.'; }, /quote must occur verbatim/u],
    ['non-Russian explanation', (set) => { set.task.evidence[0].explanationRu = 'A long but unauditable English explanation.'; }, /Russian explanation/u],
  ];
  for (const [name, mutate, pattern] of cases) {
    await t.test(name, () => {
      const damaged = clone(READING_TASK10_SETS[0]);
      mutate(damaged);
      assert.throws(() => assertReadingSet(damaged), pattern);
    });
  }
});

test('assembler publishes only a complete catalog that passes the shared strict validator', async () => {
  const future = futureShards();
  const catalog = assembleReadingPilotCatalog({
    task10: READING_TASK10_SETS,
    task11: future.task11,
    task12_18: future.task12_18,
  });

  assert.equal(assertReadingCatalog(catalog), catalog);
  assert.deepEqual(
    catalog.sets.reduce((counts, set) => ({ ...counts, [set.kind]: counts[set.kind] + 1 }), {
      task10: 0, task11: 0, task12_18: 0,
    }),
    { task10: 20, task11: 20, task12_18: 20 },
  );
  assert.equal(Object.isFrozen(catalog), true);
  assert.equal(Object.isFrozen(catalog.sets), true);
  assert.equal(Object.isFrozen(catalog.sets[0].task), true);
  assert.equal(await readingPilotModule.loadReadingTask10Shard(), READING_TASK10_SETS);
  assert.equal('READING_CATALOG' in readingPilotModule, false, 'a partial 20/60 catalog must never be exported');
  assert.equal('default' in readingPilotModule, false, 'a partial catalog must never masquerade as a default export');
});

test('assembler rejects incomplete, duplicate and unauditable shard combinations', async (t) => {
  const future = futureShards();
  const valid = {
    task10: READING_TASK10_SETS,
    task11: future.task11,
    task12_18: future.task12_18,
  };
  const cases = [
    ['missing future shard', { ...valid, task12_18: undefined }, /task12_18.*array|expected 60/u],
    ['incomplete task 10 shard', { ...valid, task10: READING_TASK10_SETS.slice(1) }, /task10.*20|expected 60/u],
    ['duplicate global id', (() => {
      const task10 = clone(READING_TASK10_SETS);
      task10[1].id = task10[0].id;
      return { ...valid, task10 };
    })(), /id must be unique/u],
    ['evidence outside its paragraph', (() => {
      const task10 = clone(READING_TASK10_SETS);
      task10[0].task.evidence[0].quote = 'An invented quotation that is not in the paragraph.';
      return { ...valid, task10 };
    })(), /quote must occur verbatim/u],
  ];

  for (const [name, shards, pattern] of cases) {
    await t.test(name, () => assert.throws(() => assembleReadingPilotCatalog(shards), pattern));
  }
});
