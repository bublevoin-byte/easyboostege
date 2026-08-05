import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertListeningCatalog,
  interviewSetForLegacyScreen,
  loadInterviewCatalog,
  loadMatchingCatalog,
  loadTrueFalseCatalog,
  matchingSetForLegacyScreen,
  trueFalseSetForLegacyScreen,
} from '../public/listening-catalog-contract.js';
import {
  LISTENING_INTERVIEW_SETS,
  LISTENING_MATCHING_SETS,
  LISTENING_PILOT_CATALOG,
  LISTENING_TRUE_FALSE_SETS,
} from '../public/listening-pilot-v1.js';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function trueFalseFixture() {
  return {
    id: 'listening-pilot-v1.true-false.community-garden',
    revision: 1,
    type: 'true_false',
    title: 'Planning a community garden',
    topic: 'environment',
    cefr: 'B1',
    provenance: 'original',
    audio: { path: '/audio/listening/listening-pilot-v1/true-false/community-garden-r1.mp3' },
    script: [
      { role: 'speaker_a', voiceSlot: 'female_1', text: 'The council offered us a sunny piece of land behind the library, but we still need to raise money for tools.' },
      { role: 'speaker_b', voiceSlot: 'male_1', text: 'I can ask the school gardening club to lend us some tools. They meet on Thursdays, although I do not know whether they have a spare wheelbarrow.' },
    ],
    task: {
      statements: [
        'The garden will be behind the library.',
        'The council will pay for all the tools.',
        'The gardening club meets on Thursdays.',
        'The club definitely owns a spare wheelbarrow.',
        'The speakers have already bought seeds.',
        'The offered land gets plenty of sunlight.',
        'The school gardening club may help with equipment.',
      ],
      answers: ['true', 'false', 'true', 'not_stated', 'not_stated', 'true', 'true'],
      evidence: [
        { answer: 'true', quote: 'behind the library', explanationRu: 'Место сада прямо указано: за библиотекой.' },
        { answer: 'false', quote: 'we still need to raise money for tools', explanationRu: 'Деньги на инструменты ещё нужно собрать, совет их не оплачивает.' },
        { answer: 'true', quote: 'They meet on Thursdays', explanationRu: 'День встречи клуба назван прямо — четверг.' },
        { answer: 'not_stated', quote: 'I do not know whether they have a spare wheelbarrow', explanationRu: 'Говорящий не знает, есть ли у клуба свободная тачка.' },
        { answer: 'not_stated', quote: 'we still need to raise money for tools', explanationRu: 'Про покупку семян в разговоре ничего не сообщается.' },
        { answer: 'true', quote: 'a sunny piece of land', explanationRu: 'Участок прямо назван солнечным.' },
        { answer: 'true', quote: 'lend us some tools', explanationRu: 'Клуб могут попросить одолжить инструменты.' },
      ],
    },
  };
}

function interviewFixture() {
  return {
    id: 'listening-pilot-v1.interview.community-radio',
    revision: 1,
    type: 'interview',
    title: 'Running a community radio show',
    topic: 'media',
    cefr: 'B2',
    provenance: 'original',
    audio: { path: '/audio/listening/listening-pilot-v1/interview/community-radio-r1.mp3' },
    script: [
      { role: 'interviewer', voiceSlot: 'female_1', text: 'When did you first become interested in radio?' },
      { role: 'guest', voiceSlot: 'male_1', text: 'A teacher invited me to edit a five-minute school news programme. I enjoyed shaping the interviews more than speaking on air.' },
    ],
    task: {
      questions: Array.from({ length: 7 }, (_, index) => ({
        id: `listening-pilot-v1.interview.community-radio.q${index + 1}`,
        prompt: `What detail does the guest give in answer ${index + 1}?`,
        options: index === 0
          ? ['A school news programme', 'A sports podcast', 'A music competition', 'A local newspaper']
          : [`Correct detail ${index + 1}`, `Wrong detail A${index + 1}`, `Wrong detail B${index + 1}`, `Wrong detail C${index + 1}`],
        answer: 0,
        quote: index === 0 ? 'A teacher invited me to edit a five-minute school news programme' : 'I enjoyed shaping the interviews more than speaking on air',
        explanationRu: index === 0
          ? 'Интерес появился после приглашения сделать школьную новостную программу.'
          : 'Цитата прямо подтверждает выбранную деталь и не поддерживает остальные варианты.',
      })),
    },
  };
}

test('interview adapter exposes seven four-option questions and stable voice-tutor ids', () => {
  const fixture = interviewFixture();
  const catalog = { id: 'listening-pilot-v1', revision: 1, sets: [fixture] };

  assert.doesNotThrow(() => assertListeningCatalog(catalog, { expectedCounts: { interview: 1 } }));
  const exercise = interviewSetForLegacyScreen(fixture);
  assert.equal(exercise.d.length, 2);
  assert.equal(exercise.qs.length, 7);
  assert.equal(exercise.qs.every((question) => question.o.length === 4), true);
  assert.equal(exercise.maxScore, 7);
  assert.deepEqual(exercise.voice, { id: fixture.id, revision: 1 });
  assert.deepEqual(exercise.qs.map((question) => question.voice.id), fixture.task.questions.map((question) => question.id));
});

test('true-false catalog adapter validates all three answers and exposes seven legacy rows', () => {
  const fixture = trueFalseFixture();
  const catalog = { id: 'listening-pilot-v1', revision: 1, sets: [fixture] };

  assert.doesNotThrow(() => assertListeningCatalog(catalog, { expectedCounts: { true_false: 1 } }));
  const exercise = trueFalseSetForLegacyScreen(fixture);
  assert.equal(exercise.d.length, 2);
  assert.equal(exercise.st.length, 7);
  assert.deepEqual(exercise.st.map((item) => item.a), [0, 1, 0, 2, 2, 0, 0]);
  assert.equal(exercise.maxScore, 7);
  assert.equal(exercise.id, fixture.id);
  assert.equal(exercise.audioPath, fixture.audio.path);
});

test('listening pilot exposes 20 original exam-sized matching sets', () => {
  assert.equal(LISTENING_PILOT_CATALOG.id, 'listening-pilot-v1');
  assert.equal(LISTENING_PILOT_CATALOG.revision, 1);
  assert.equal(LISTENING_MATCHING_SETS.length, 20);
  assert.equal(new Set(LISTENING_MATCHING_SETS.map((set) => set.id)).size, 20);
  assert.ok(new Set(LISTENING_MATCHING_SETS.map((set) => set.topic)).size >= 15);
  assert.deepEqual(new Set(LISTENING_MATCHING_SETS.map((set) => set.cefr)), new Set(['B1', 'B2']));

  for (const set of LISTENING_MATCHING_SETS) {
    assert.equal(set.type, 'matching');
    assert.equal(set.provenance, 'original');
    assert.equal(set.script.length, 6, set.id);
    assert.equal(set.task.statements.length, 7, set.id);
    assert.equal(set.task.answers.length, 6, set.id);
    assert.equal(new Set(set.task.answers).size, 6, set.id);
    assert.equal(set.task.evidence.length, 6, set.id);
    assert.equal(set.audio.path.startsWith('/audio/listening/listening-pilot-v1/matching/'), true, set.id);
    assert.equal(Object.isFrozen(set), true, set.id);

    const used = new Set(set.task.answers);
    assert.equal(set.task.statements.filter((_, index) => !used.has(index)).length, 1, set.id);
    set.task.evidence.forEach((evidence, index) => {
      assert.equal(evidence.statementIndex, set.task.answers[index], `${set.id} speaker ${index + 1}`);
      assert.ok(set.script[index].text.includes(evidence.quote), `${set.id} quote ${index + 1}`);
      assert.match(evidence.explanationRu, /[А-Яа-яЁё]/u, set.id);
    });
  }
});

test('listening pilot exposes 20 original exam-sized true-false sets with auditable answers', () => {
  assert.equal(LISTENING_PILOT_CATALOG.sets.length, 60);
  assert.equal(LISTENING_TRUE_FALSE_SETS.length, 20);
  assert.equal(new Set(LISTENING_TRUE_FALSE_SETS.map((set) => set.id)).size, 20);
  assert.ok(new Set(LISTENING_TRUE_FALSE_SETS.map((set) => set.topic)).size >= 15);
  assert.deepEqual(new Set(LISTENING_TRUE_FALSE_SETS.map((set) => set.cefr)), new Set(['B1', 'B2']));
  assert.equal(new Set(LISTENING_TRUE_FALSE_SETS.map((set) => (
    set.script.map((segment) => segment.text).join('\n')
  ))).size, 20);

  for (const set of LISTENING_TRUE_FALSE_SETS) {
    assert.equal(set.type, 'true_false');
    assert.equal(set.provenance, 'original');
    assert.equal(set.task.statements.length, 7, set.id);
    assert.equal(set.task.answers.length, 7, set.id);
    assert.deepEqual(new Set(set.task.answers), new Set(['true', 'false', 'not_stated']), set.id);
    assert.equal(set.task.evidence.length, 7, set.id);
    assert.equal(set.audio.path.startsWith('/audio/listening/listening-pilot-v1/true-false/'), true, set.id);
    assert.equal(Object.isFrozen(set), true, set.id);

    set.task.evidence.forEach((evidence, index) => {
      assert.equal(evidence.answer, set.task.answers[index], `${set.id} statement ${index + 1}`);
      assert.ok(set.script.some((segment) => segment.text.includes(evidence.quote)), `${set.id} quote ${index + 1}`);
      assert.match(evidence.explanationRu, /[А-Яа-яЁё]/u, set.id);
    });
  }
});

test('listening pilot exposes exactly 60 original sets split 20/20/20 with reviewed interview keys', () => {
  assert.equal(LISTENING_PILOT_CATALOG.sets.length, 60);
  assert.equal(LISTENING_INTERVIEW_SETS.length, 20);
  assert.equal(new Set(LISTENING_INTERVIEW_SETS.map((set) => set.id)).size, 20);
  assert.equal(new Set(LISTENING_INTERVIEW_SETS.flatMap((set) => set.task.questions.map((question) => question.id))).size, 140);
  assert.ok(new Set(LISTENING_INTERVIEW_SETS.map((set) => set.topic)).size >= 15);
  assert.deepEqual(new Set(LISTENING_INTERVIEW_SETS.map((set) => set.cefr)), new Set(['B1', 'B2']));
  assert.doesNotThrow(() => assertListeningCatalog(clone(LISTENING_PILOT_CATALOG), {
    expectedCounts: { matching: 20, true_false: 20, interview: 20 }, minimumTopics: 20,
  }));

  for (const set of LISTENING_INTERVIEW_SETS) {
    assert.equal(set.provenance, 'original', set.id);
    assert.equal(set.task.questions.length, 7, set.id);
    assert.equal(set.audio.path.startsWith('/audio/listening/listening-pilot-v1/interview/'), true, set.id);
    assert.equal(Object.isFrozen(set), true, set.id);
    for (const question of set.task.questions) {
      assert.equal(question.options.length, 4, question.id);
      assert.equal(Number.isInteger(question.answer) && question.answer >= 0 && question.answer < 4, true, question.id);
      assert.equal(new Set(question.options.map((option) => option.toLocaleLowerCase('en'))).size, 4, question.id);
      assert.ok(set.script.some((segment) => segment.text.includes(question.quote)), `${question.id}: verbatim quote`);
      assert.match(question.explanationRu, /[А-Яа-яЁё]/u, question.id);
    }
  }
});

test('reviewed not-stated items ask about genuinely missing details instead of contradicted decisions', () => {
  const reviewed = new Map(LISTENING_TRUE_FALSE_SETS.map((set) => [set.id, set]));
  const cases = [
    ['listening-pilot-v1.true-false.coastal-weekend', 'Bicycles can be hired beside the guest house.', 'Shall we hire bicycles on Sunday?'],
    ['listening-pilot-v1.true-false.local-podcast', 'The team bought its microphones last year.', 'we must bring our own microphones and laptop'],
    ['listening-pilot-v1.true-false.surprise-party', 'Ben will be travelling on the day of the party.', 'Ben has not replied'],
    ['listening-pilot-v1.true-false.climbing-final', 'The athlete injured the shoulder during last month’s competition.', 'My shoulder feels better'],
  ];

  for (const [id, statement, quote] of cases) {
    const set = reviewed.get(id);
    const index = set.task.statements.indexOf(statement);
    assert.notEqual(index, -1, id);
    assert.equal(set.task.answers[index], 'not_stated', id);
    assert.equal(set.task.evidence[index].quote, quote, id);
    assert.match(set.task.evidence[index].explanationRu, /не (?:называ|сообща)|неизвест/iu, id);
  }
});

test('reviewed false item contradicts the stated notification time rather than inventing a decision time', () => {
  const set = LISTENING_TRUE_FALSE_SETS.find((item) => item.id === 'listening-pilot-v1.true-false.forest-bird-survey');
  const statement = 'A cancellation message would be sent after six on Saturday morning.';
  const index = set.task.statements.indexOf(statement);

  assert.notEqual(index, -1);
  assert.equal(set.task.answers[index], 'false');
  assert.equal(set.task.evidence[index].quote, 'before six on Saturday morning');
});

test('catalog validator reports the damaged set id and rejects unsafe or ambiguous matching data', () => {
  const valid = clone(LISTENING_PILOT_CATALOG);
  assert.doesNotThrow(() => assertListeningCatalog(valid, { expectedCounts: { matching: 20 } }));

  const cases = [
    ['unsafe id', (catalog) => { catalog.sets[0].id = '../escape'; }, /\.\.\/escape.*safe stable id/iu],
    ['unversioned set', (catalog) => { catalog.sets[0].revision = 0; }, /revision/iu],
    ['copied provenance', (catalog) => { catalog.sets[0].provenance = 'external'; }, /provenance.*original/iu],
    ['wrong speaker count', (catalog) => { catalog.sets[0].script.pop(); }, /script.*6/iu],
    ['unknown role', (catalog) => { catalog.sets[0].script[0].role = 'narrator'; }, /role/iu],
    ['duplicate answer', (catalog) => { catalog.sets[0].task.answers[1] = catalog.sets[0].task.answers[0]; }, /unique/iu],
    ['missing evidence', (catalog) => { catalog.sets[0].task.evidence[0].quote = ''; }, /quote/iu],
    ['unsafe audio path', (catalog) => { catalog.sets[0].audio.path = '/audio/listening/../secret.mp3'; }, /audio\.path/iu],
    ['stale audio revision', (catalog) => { catalog.sets[0].revision = 2; }, /audio\.path/iu],
  ];

  for (const [name, mutate, expected] of cases) {
    const damaged = clone(LISTENING_PILOT_CATALOG);
    mutate(damaged);
    assert.throws(
      () => assertListeningCatalog(damaged, { expectedCounts: { matching: 20 } }),
      expected,
      name,
    );
  }
});

test('catalog validator rejects incomplete or unauditable true-false data', () => {
  const cases = [
    ['wrong statement count', (set) => { set.task.statements.pop(); }, /statements.*7/iu],
    ['missing answer class', (set) => { set.task.answers = set.task.answers.map((answer) => (answer === 'not_stated' ? 'false' : answer)); }, /include true, false and not_stated/iu],
    ['unknown role', (set) => { set.script[0].role = 'host'; }, /role must be speaker_a or speaker_b/iu],
    ['changed voice', (set) => { set.script[2].voiceSlot = 'female_3'; }, /keep one voiceSlot/iu],
    ['invented quote', (set) => { set.task.evidence[0].quote = 'This sentence does not occur in the dialogue.'; }, /quote must occur verbatim/iu],
    ['mismatched evidence answer', (set) => { set.task.evidence[0].answer = 'false'; }, /answer must equal/iu],
    ['unsafe audio path', (set) => { set.audio.path = '/audio/listening/../private.mp3'; }, /audio\.path/iu],
  ];

  for (const [name, mutate, expected] of cases) {
    const damaged = clone(LISTENING_TRUE_FALSE_SETS[0]);
    mutate(damaged);
    assert.throws(
      () => assertListeningCatalog({ id: 'listening-pilot-v1', revision: 1, sets: [damaged] }),
      expected,
      name,
    );
  }
});

test('catalog validator rejects ambiguous or untraceable interview data', () => {
  const cases = [
    ['wrong question count', (set) => { set.task.questions.pop(); }, /questions.*7/iu],
    ['wrong option count', (set) => { set.task.questions[0].options.pop(); }, /options.*4/iu],
    ['duplicate option', (set) => { set.task.questions[0].options[1] = set.task.questions[0].options[0]; }, /options.*unique/iu],
    ['invalid answer key', (set) => { set.task.questions[0].answer = 4; }, /answer.*0 through 3/iu],
    ['duplicate item id', (set) => { set.task.questions[1].id = set.task.questions[0].id; }, /stable voice-tutor item id|question ids.*unique/iu],
    ['unstable item id', (set) => { set.task.questions[0].id = 'question-one'; }, /stable voice-tutor item id/iu],
    ['invented quote', (set) => { set.task.questions[0].quote = 'This quote is absent from the interview.'; }, /quote must occur verbatim/iu],
  ];

  for (const [name, mutate, expected] of cases) {
    const damaged = interviewFixture();
    mutate(damaged);
    assert.throws(
      () => assertListeningCatalog({ id: 'listening-pilot-v1', revision: 1, sets: [damaged] }),
      expected,
      name,
    );
  }
});

test('matching catalog adapter preserves identity, evidence and dynamic exam dimensions', () => {
  const source = LISTENING_MATCHING_SETS[0];
  const exercise = matchingSetForLegacyScreen(source);

  assert.deepEqual(exercise.st, source.task.statements);
  assert.deepEqual(exercise.a, source.task.answers);
  assert.equal(exercise.sp.length, 6);
  assert.equal(exercise.k.length, 6);
  assert.equal(exercise.maxScore, 6);
  assert.equal(exercise.id, source.id);
  assert.equal(exercise.revision, source.revision);
  assert.equal(exercise.evidenceSource, 'builtin');
  assert.equal(exercise.audioPath, source.audio.path);
});

test('catalog loader returns an empty set for load or validation failure so the screen can use fallback', async () => {
  assert.deepEqual(await loadMatchingCatalog(async () => { throw new Error('offline'); }), []);
  assert.deepEqual(await loadMatchingCatalog(async () => ({ LISTENING_MATCHING_SETS: [{}] })), []);
  assert.equal((await loadMatchingCatalog(async () => ({ LISTENING_MATCHING_SETS }))).length, 20);
});

test('true-false loader adapts the shared catalog and fails closed for invalid data', async () => {
  assert.deepEqual(await loadTrueFalseCatalog(async () => { throw new Error('offline'); }), []);
  assert.deepEqual(await loadTrueFalseCatalog(async () => ({ LISTENING_TRUE_FALSE_SETS: [{}] })), []);
  const loaded = await loadTrueFalseCatalog(async () => ({ LISTENING_TRUE_FALSE_SETS }));
  assert.equal(loaded.length, 20);
  assert.equal(loaded.every((set) => set.st.length === 7 && set.maxScore === 7), true);
});

test('interview loader adapts the shared catalog and fails closed for invalid data', async () => {
  assert.deepEqual(await loadInterviewCatalog(async () => { throw new Error('offline'); }), []);
  assert.deepEqual(await loadInterviewCatalog(async () => ({ LISTENING_INTERVIEW_SETS: [{}] })), []);
  const loaded = await loadInterviewCatalog(async () => ({ LISTENING_INTERVIEW_SETS }));
  assert.equal(loaded.length, 20);
  assert.equal(loaded.every((set) => set.qs.length === 7 && set.maxScore === 7), true);
});
