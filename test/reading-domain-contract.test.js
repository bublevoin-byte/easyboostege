import assert from 'node:assert/strict';
import test from 'node:test';
import {
  READING_CATALOG_ID,
  READING_CONTRACT_VERSION,
  assertReadingCatalog,
  adaptLegacyReadingFallback,
  loadReadingCatalog,
  readingSetForLegacyScreen,
} from '../public/reading-catalog-contract.js';

const KINDS = ['task10', 'task11', 'task12_18'];

function explanation(index) {
  return `Это точное доказательство для позиции ${index + 1}, которое объясняет связь с правильным ответом.`;
}

function envelope(kind, index) {
  const withinKind = index % 20;
  return {
    id: `${READING_CATALOG_ID}.${kind}.set-${String(withinKind + 1).padStart(2, '0')}`,
    revision: 1,
    kind,
    title: `Reading ${kind} set ${withinKind + 1}`,
    topic: `topic-${kind}-${withinKind + 1}`,
    cefr: withinKind < 4 ? 'B1' : (withinKind < 16 ? 'B2' : 'B2+/C1'),
    provenance: 'original',
    validation: { contract: READING_CONTRACT_VERSION },
  };
}

function task10Set(index) {
  const set = envelope('task10', index);
  const texts = Array.from({ length: 7 }, (_, position) => ({
    id: String.fromCharCode(65 + position),
    text: `Set ${index + 1} text ${position + 1} has a distinct central idea. Exact task ten evidence ${index + 1}-${position + 1} appears here for validation.`,
  }));
  return {
    ...set,
    task: {
      texts,
      headings: Array.from({ length: 8 }, (_, position) => `Distinct heading ${index + 1}-${position + 1}`),
      answers: [0, 1, 2, 3, 4, 5, 6],
      evidence: texts.map((text, position) => ({
        position: text.id,
        answer: position,
        quote: `Exact task ten evidence ${index + 1}-${position + 1}`,
        explanationRu: explanation(position),
      })),
    },
  };
}

function task11Set(index) {
  const set = envelope('task11', index);
  const segments = Array.from({ length: 7 }, (_, position) => (
    `Set ${index + 1} context segment ${position + 1} contains enough surrounding words for a coherent reading passage. `
  ));
  return {
    ...set,
    task: {
      segments,
      fragments: Array.from({ length: 7 }, (_, position) => `fragment ${index + 1}-${position + 1} fits its grammatical context`),
      answers: [0, 1, 2, 3, 4, 5],
      evidence: Array.from({ length: 6 }, (_, position) => ({
        position: String.fromCharCode(65 + position),
        answer: position,
        leftContext: segments[position].trim(),
        rightContext: segments[position + 1].trim(),
        quote: `context segment ${position + 1}`,
        explanationRu: explanation(position),
      })),
    },
  };
}

function task12Set(index) {
  const set = envelope('task12_18', index);
  const sentences = Array.from({ length: 7 }, (_, position) => (
    `Exact detail evidence ${index + 1}-${position + 1} gives the reader a clear fact for question ${position + 1}.`
  ));
  return {
    ...set,
    task: {
      text: sentences.join(' '),
      questions: sentences.map((sentence, position) => ({
        id: `${set.id}.q${position + 1}`,
        prompt: `What fact is stated in set ${index + 1} for detail question ${position + 1}?`,
        options: Array.from({ length: 4 }, (_, option) => `Option ${index + 1}-${position + 1}-${option + 1}`),
        answer: position % 4,
        evidence: {
          quote: `Exact detail evidence ${index + 1}-${position + 1}`,
          explanationRu: explanation(position),
        },
      })),
    },
  };
}

function createCatalog() {
  const factories = { task10: task10Set, task11: task11Set, task12_18: task12Set };
  return {
    id: READING_CATALOG_ID,
    revision: 1,
    validation: { contract: READING_CONTRACT_VERSION },
    sets: KINDS.flatMap((kind) => Array.from({ length: 20 }, (_, index) => factories[kind](index))),
  };
}

function changedCatalog(change) {
  const catalog = structuredClone(createCatalog());
  change(catalog);
  return catalog;
}

test('strict Reading catalog accepts the official 60-set envelope and each task shape', () => {
  const catalog = createCatalog();
  assert.equal(assertReadingCatalog(catalog), catalog);
});

test('Reading catalog loader validates once and returns deeply immutable content', async () => {
  const catalog = createCatalog();
  const loaded = await loadReadingCatalog(async () => ({ READING_CATALOG: catalog }));
  assert.equal(loaded, catalog);
  assert.equal(Object.isFrozen(loaded), true);
  assert.equal(Object.isFrozen(loaded.sets[0].task), true);
});

test('strict Reading catalog rejects every envelope, count and classification error class', async (t) => {
  const cases = [
    ['non-object envelope', null, /catalog.*object/u],
    ['catalog id/version', changedCatalog((catalog) => { catalog.id = 'reading-pilot-v0'; }), /id must be reading-pilot-v1/u],
    ['catalog revision', changedCatalog((catalog) => { catalog.revision = 0; }), /revision must be a positive integer/u],
    ['validation contract', changedCatalog((catalog) => { catalog.validation.contract = 'reading-v0'; }), /validation\.contract/u],
    ['sets type', changedCatalog((catalog) => { catalog.sets = {}; }), /sets must be an array/u],
    ['set envelope type', changedCatalog((catalog) => { catalog.sets[0] = []; }), /sets\[0\].*object/u],
    ['60 total and 20 per kind', changedCatalog((catalog) => { catalog.sets.pop(); }), /expected 60 sets/u],
    ['duplicate id', changedCatalog((catalog) => { catalog.sets[1].id = catalog.sets[0].id; }), /id must be unique/u],
    ['unknown kind', changedCatalog((catalog) => { catalog.sets[0].kind = 'task9'; }), /kind must be/u],
    ['stable kind-bound id', changedCatalog((catalog) => { catalog.sets[0].id = 'unsafe id'; }), /safe stable id/u],
    ['set revision', changedCatalog((catalog) => { catalog.sets[0].revision = -1; }), /revision must be a positive integer/u],
    ['set validation contract', changedCatalog((catalog) => { catalog.sets[0].validation.contract = 'reading-v0'; }), /validation\.contract/u],
    ['provenance', changedCatalog((catalog) => { catalog.sets[0].provenance = 'generated'; }), /provenance must be original/u],
    ['unknown CEFR', changedCatalog((catalog) => { catalog.sets[0].cefr = 'A2'; }), /cefr must be/u],
    ['CEFR 4-12-4 distribution', changedCatalog((catalog) => { catalog.sets[0].cefr = 'B2'; }), /CEFR distribution/u],
  ];
  for (const [name, catalog, pattern] of cases) {
    await t.test(name, () => assert.throws(() => assertReadingCatalog(catalog), pattern));
  }
});

test('strict Reading catalog rejects every task count, key and evidence error class', async (t) => {
  const cases = [
    ['task envelope type', (set) => { set.task = []; }, /task.*object/u],
    ['task 10 text item type', (set) => { set.task.texts[0] = 'text'; }, /texts\[0\].*object/u],
    ['task 10 text count', (set) => set.task.texts.pop(), /exactly 7 texts/u],
    ['task 10 heading count', (set) => set.task.headings.pop(), /exactly 8 headings/u],
    ['task 10 unique matching keys', (set) => { set.task.answers[1] = set.task.answers[0]; }, /7 unique keys/u],
    ['task 11 segment count', (set) => set.task.segments.pop(), /exactly 7 segments/u, 20],
    ['task 11 fragment count', (set) => set.task.fragments.pop(), /exactly 7 fragments/u, 20],
    ['task 11 answer count', (set) => set.task.answers.pop(), /exactly 6 answers/u, 20],
    ['task 11 unique matching keys', (set) => { set.task.answers[1] = set.task.answers[0]; }, /6 unique keys/u, 20],
    ['task 12 question count', (set) => set.task.questions.pop(), /exactly 7 questions/u, 40],
    ['task 12 option count', (set) => set.task.questions[0].options.pop(), /exactly 4 options/u, 40],
    ['answer type/range', (set) => { set.task.questions[0].answer = 4; }, /answer must reference option indexes/u, 40],
    ['evidence count', (set) => set.task.evidence.pop(), /exactly 7 evidence/u],
    ['empty evidence', (set) => { set.task.evidence[0].quote = ''; }, /quote/u],
    ['evidence item type', (set) => { set.task.evidence[0] = []; }, /evidence\[0\].*object/u],
    ['evidence outside source', (set) => { set.task.evidence[0].quote = 'not present anywhere'; }, /quote must occur verbatim/u],
    ['empty explanation', (set) => { set.task.evidence[0].explanationRu = ''; }, /explanationRu/u],
    ['evidence answer mismatch', (set) => { set.task.evidence[0].answer = 7; }, /answer must equal/u],
    ['gap left/right context', (set) => { set.task.evidence[0].leftContext = 'missing context'; }, /leftContext must occur verbatim/u, 20],
    ['question evidence outside text', (set) => { set.task.questions[0].evidence.quote = 'not in the passage'; }, /quote must occur verbatim/u, 40],
    ['question evidence type', (set) => { set.task.questions[0].evidence = []; }, /evidence.*object/u, 40],
  ];
  for (const [name, mutate, pattern, setIndex = 0] of cases) {
    await t.test(name, () => {
      const catalog = changedCatalog((value) => mutate(value.sets[setIndex]));
      assert.throws(() => assertReadingCatalog(catalog), pattern);
    });
  }
});

test('strict Reading catalog rejects global normalized duplicates and simple answer leaks', async (t) => {
  const cases = [
    ['duplicate task 10 text', (catalog) => {
      catalog.sets[1].task.texts[0] = structuredClone(catalog.sets[0].task.texts[0]);
      catalog.sets[1].task.evidence[0] = structuredClone(catalog.sets[0].task.evidence[0]);
    }, /normalized task text must be globally unique/u],
    ['duplicate restored task 11 text', (catalog) => { catalog.sets[21].task = structuredClone(catalog.sets[20].task); }, /normalized restored text must be globally unique/u],
    ['duplicate task 12 passage', (catalog) => {
      catalog.sets[41].task.text = catalog.sets[40].task.text;
      catalog.sets[41].task.questions.forEach((question, index) => {
        question.evidence = structuredClone(catalog.sets[40].task.questions[index].evidence);
      });
    }, /normalized passage text must be globally unique/u],
    ['duplicate normalized question', (catalog) => { catalog.sets[41].task.questions[0].prompt = `  ${catalog.sets[40].task.questions[0].prompt.toUpperCase()}  `; }, /normalized question must be globally unique/u],
    ['task 10 distractor leaks into a text', (catalog) => { catalog.sets[0].task.headings[7] = 'distinct central idea'; }, /unused heading must not appear verbatim/u],
    ['task 12 prompt reveals correct option', (catalog) => {
      const question = catalog.sets[40].task.questions[0];
      question.prompt = `Which statement is correct: ${question.options[question.answer]}?`;
    }, /must not reveal its correct option/u],
  ];
  for (const [name, mutate, pattern] of cases) {
    await t.test(name, () => assert.throws(() => assertReadingCatalog(changedCatalog(mutate)), pattern));
  }
});

test('canonical Reading sets adapt to the compact legacy screen shapes without sharing arrays', () => {
  const canonical = [task10Set(0), task11Set(0), task12Set(0)];
  const [headings, gaps, questions] = canonical.map(readingSetForLegacyScreen);

  assert.deepEqual([headings.txts.length, headings.hl.length], [7, 8]);
  assert.deepEqual([gaps.tx.length, gaps.fr.length, gaps.a.length], [7, 7, 6]);
  assert.deepEqual([questions.qs.length, questions.qs[0].o.length], [7, 4]);
  assert.equal(headings.evidenceSource, 'builtin');
  headings.hl.pop();
  assert.equal(canonical[0].task.headings.length, 8);
});

test('legacy fallback adapts into an explicit non-recordable technical domain set', () => {
  const legacy = {
    hl: ['One', 'Two'],
    txts: [{ t: 'Legacy fallback text.', a: 1, k: 'Старое объяснение.' }],
  };
  const adapted = adaptLegacyReadingFallback('task10', legacy, { id: 'legacy.task10.one', revision: 2 });
  assert.equal(adapted.provenance, 'legacy');
  assert.equal(adapted.recordable, false);
  assert.equal(adapted.validation.contract, 'reading-legacy-adapter-v1');
  assert.equal(adapted.task.texts[0].text, legacy.txts[0].t);
  adapted.task.headings.pop();
  assert.equal(legacy.hl.length, 2);
});

export { createCatalog, task10Set, task11Set, task12Set };
