import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import {
  GRAMMAR_CATALOG,
  createGrammarCatalog,
  grammarCatalogCoverage,
  validateGeneratedGrammarSupplement,
} from '../public/grammar-catalog.js';

function editableSource() {
  return JSON.parse(JSON.stringify(GRAMMAR_CATALOG));
}

test('versioned grammar catalog preserves every built-in topic, exercise and exam gap', () => {
  const coverage = grammarCatalogCoverage(GRAMMAR_CATALOG);

  assert.equal(GRAMMAR_CATALOG.version, 'grammar-core-v1');
  assert.equal(GRAMMAR_CATALOG.revision, 1);
  assert.equal(coverage.groups, 4);
  assert.equal(coverage.topics, 20);
  assert.equal(coverage.exercises, 200);
  assert.equal(coverage.exams, 3);
  assert.equal(coverage.examGaps, 18);
  assert.deepEqual(coverage.byKind, { c: 100, c2: 25, f: 75 });
  assert.equal(coverage.itemIds.length, 218);
  assert.equal(new Set(coverage.itemIds).size, 218);
  assert.deepEqual(coverage.byTopic[1], { c: 5, c2: 0, f: 5, total: 10 });
  assert.equal(coverage.contentFingerprint, 'fnv1a32:45cee292');

  assert.equal(GRAMMAR_CATALOG.bank[1].c[0].id, 'core.g.1.c.1');
  assert.equal(GRAMMAR_CATALOG.bank[1].c[0].revision, 1);
  assert.equal(GRAMMAR_CATALOG.bank[1].c[0].o[GRAMMAR_CATALOG.bank[1].c[0].a], 'goes');
  assert.match(GRAMMAR_CATALOG.bank[1].c[0].e, /Present Simple/u);
  assert.equal(GRAMMAR_CATALOG.exams[0].gaps[0].id, 'core.g.exam.1.1');
  assert.deepEqual(GRAMMAR_CATALOG.exams[0].gaps[0].ans, ['went']);
  assert.match(GRAMMAR_CATALOG.exams[0].gaps[0].e, /Past Simple/u);
  assert.equal(GRAMMAR_CATALOG.exams[0].tx[0].endsWith(' '), true, 'authored spacing around exam gaps is preserved');
  assert.match(GRAMMAR_CATALOG.topics[1].th, /Ловушка ЕГЭ/u, 'UTF-8 Russian theory is preserved');

  for (const [topicId, levels] of Object.entries(GRAMMAR_CATALOG.bank)) {
    for (const kind of ['c', 'c2', 'f']) {
      levels[kind].forEach((item, index) => {
        assert.equal(item.id, `core.g.${topicId}.${kind}.${index + 1}`);
        assert.equal(item.revision, 1);
        assert.ok(item.e.trim(), `${item.id} explanation`);
        const answers = item.type === 'choice' ? [item.o[item.a]] : item.ans;
        assert.ok(answers.every((answer) => answer.trim()), `${item.id} answers`);
      });
    }
  }
  GRAMMAR_CATALOG.exams.forEach((exam, examIndex) => {
    assert.equal(exam.id, `core.g.exam.${examIndex + 1}`);
    exam.gaps.forEach((gap, gapIndex) => {
      assert.equal(gap.id, `core.g.exam.${examIndex + 1}.${gapIndex + 1}`);
      assert.equal(gap.revision, 1);
      assert.ok(gap.e.trim());
      assert.ok(gap.ans.every((answer) => answer.trim()));
    });
  });
});

test('grammar catalog is recursively immutable and has stable Voice Tutor pointers', () => {
  assert.equal(Object.isFrozen(GRAMMAR_CATALOG), true);
  assert.equal(Object.isFrozen(GRAMMAR_CATALOG.bank[1].c), true);
  assert.equal(Object.isFrozen(GRAMMAR_CATALOG.bank[1].c[0]), true);
  assert.deepEqual(GRAMMAR_CATALOG.bank[1].c[0].voice, { id: 'core.g.1.c.1', revision: 1 });
  assert.deepEqual(GRAMMAR_CATALOG.exams[1].gaps[5].voice, { id: 'core.g.exam.2.6', revision: 1 });
  assert.throws(() => { GRAMMAR_CATALOG.bank[1].c[0].a = 0; }, TypeError);
});

test('grammar catalog schema rejects malformed or unsupported authored content', () => {
  const cases = [
    ['unknown exercise kind', (source) => { source.bank[1].unknown = []; }, /UNSUPPORTED_GRAMMAR_KIND/u],
    ['unknown exam gap type', (source) => { source.exams[0].gaps[0].type = 'essay'; }, /UNSUPPORTED_GRAMMAR_KIND/u],
    ['empty accepted answer', (source) => { source.bank[1].f[0].ans = [' ']; }, /EMPTY_GRAMMAR_ANSWER/u],
    ['invalid choice index', (source) => { source.bank[1].c[0].a = 99; }, /INVALID_GRAMMAR_ANSWER_INDEX/u],
    ['invalid negative revision', (source) => { source.bank[1].c[0].revision = -1; }, /INVALID_GRAMMAR_REVISION/u],
    ['invalid fractional revision', (source) => { source.bank[1].c[0].revision = 1.5; }, /INVALID_GRAMMAR_REVISION/u],
    ['unbounded revision', (source) => { source.bank[1].c[0].revision = 1_000_001; }, /INVALID_GRAMMAR_REVISION/u],
    ['non-finite item revision', (source) => { source.bank[1].c[0].revision = Number.POSITIVE_INFINITY; }, /INVALID_GRAMMAR_REVISION/u],
    ['non-finite topic revision', (source) => { source.topics[1].revision = Number.NaN; }, /INVALID_GRAMMAR_REVISION/u],
    ['non-finite exam revision', (source) => { source.exams[0].revision = Number.NEGATIVE_INFINITY; }, /INVALID_GRAMMAR_REVISION/u],
    ['ID encodes another topic and kind', (source) => {
      source.bank[1].c[0].id = 'core.g.20.f.999';
    }, /INVALID_GRAMMAR_IDENTITY/u],
    ['exam gap ID encodes another position', (source) => {
      source.exams[0].gaps[0].id = 'core.g.exam.9.9';
    }, /INVALID_GRAMMAR_IDENTITY/u],
    ['duplicate stable ID', (source) => { source.bank[1].c[1].id = source.bank[1].c[0].id; }, /DUPLICATE_GRAMMAR_ID/u],
    ['duplicate prompt and answer', (source) => {
      const originalId = source.bank[1].c[1].id;
      source.bank[1].c[1] = { ...source.bank[1].c[0], id: originalId };
    }, /DUPLICATE_GRAMMAR_CONTENT/u],
    ['unsupported markup', (source) => { source.topics[1].th = '<script>alert(1)</script>'; }, /UNSUPPORTED_GRAMMAR_MARKUP/u],
  ];

  for (const [label, mutate, expected] of cases) {
    const source = editableSource();
    mutate(source);
    assert.throws(() => createGrammarCatalog(source), expected, label);
  }
});

test('generated grammar supplements pass through the same strict catalog boundary', () => {
  const topic = validateGeneratedGrammarSupplement('grammar_topic_set', {
    c: [{ t: ['She ', ' every day.'], o: ['go', 'goes', 'going', 'went'], a: 1, e: 'Present Simple.' }],
    f: [{ s: 'She _____ (GO) every day.', b: 'GO', ans: ['goes'], e: 'Third person singular.' }],
  });
  assert.equal(topic.c[0].o[topic.c[0].a], 'goes');
  assert.equal(Object.isFrozen(topic), true);

  assert.throws(() => validateGeneratedGrammarSupplement('grammar_topic_set', {
    c: [{ t: ['She ', '.'], o: ['go', 'goes'], a: 2, e: 'Bad index.' }],
    f: [],
  }), /INVALID_GRAMMAR_ANSWER_INDEX/u);
  assert.throws(() => validateGeneratedGrammarSupplement('grammar_topic_set', {
    c: [{ type: 'essay', t: ['She ', '.'], o: ['go', 'goes', 'going', 'went'], a: 1, e: 'Bad type.' }],
    f: [],
  }), /UNSUPPORTED_GRAMMAR_KIND/u);
  assert.throws(() => validateGeneratedGrammarSupplement('grammar_topic_set', {
    c: [
      { t: ['She ', '.'], o: ['go', 'goes', 'going', 'went'], a: 1, e: 'Present Simple.' },
      { t: [' she  ', '!'], o: ['go', 'goes', 'going', 'went'], a: 1, e: 'Same content.' },
    ],
    f: [],
  }), /DUPLICATE_GRAMMAR_CONTENT/u);
  assert.throws(() => validateGeneratedGrammarSupplement('grammar_exam_19_24', {
    tx: ['A ', ' B ', ' C ', ' D ', ' E ', ' F ', ' G.'],
    gaps: Array.from({ length: 6 }, (_, index) => ({
      type: index === 0 ? 'essay' : 'input', b: 'GO', ans: ['went'], e: 'Past.', t: 2,
    })),
  }), /UNSUPPORTED_GRAMMAR_KIND/u);
  assert.throws(() => validateGeneratedGrammarSupplement('unknown', {}), /UNSUPPORTED_GRAMMAR_SUPPLEMENT/u);
});

test('screen and Voice Tutor consume the public catalog instead of hidden grammar copies', async () => {
  const [screen, serverCatalog, generatedCatalog] = await Promise.all([
    fs.readFile(new URL('../public/screens/grammar.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../voice-tutor/core-catalog.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../voice-tutor/generated-core-catalog.js', import.meta.url), 'utf8'),
  ]);

  assert.match(screen, /from ['"]\.\.\/grammar-catalog\.js['"]/u);
  assert.doesNotMatch(screen, /const G_(?:GROUPS|TOPICS|BANK|EXAMS)\s*=\s*(?:\[|\{)/u);
  assert.match(serverCatalog, /from ['"]\.\.\/public\/grammar-catalog\.js['"]/u);
  assert.doesNotMatch(generatedCatalog, /"grammar"\s*:/u);
  assert.doesNotMatch(generatedCatalog, /"topics"\s*:/u);
  assert.doesNotMatch(generatedCatalog, /"exams"\s*:/u);
});
