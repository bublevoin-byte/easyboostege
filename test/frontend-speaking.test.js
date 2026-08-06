import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../public/modules/speaking.js', import.meta.url), 'utf8');

function createSpeakingModule() {
  const window = {};
  vm.runInNewContext(source, { window, Object, Number, Math, Array, String, Boolean });
  return window.EasyBoostSpeaking;
}

// Values built inside the vm realm are not reference-equal to host literals.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('speaking module exposes exam timings and a 20-point maximum', () => {
  const speaking = createSpeakingModule();

  assert.deepEqual(Array.from(speaking.TASKS), [1, 2, 3, 4]);
  assert.equal(speaking.EXAM_MAX, 20);
  assert.deepEqual(plain(speaking.config(1)), { name: 'Чтение вслух', prep: 90, rec: 90, max: 1, sub: 'задание 1 · 1 балл' });
  assert.equal(speaking.config(3).prep, 0);
  assert.equal(speaking.config(4).prep, 150);
  assert.equal(speaking.config(4).rec, 180);
  assert.equal(speaking.isExperimentalTask(1), false);
  assert.equal(speaking.isExperimentalTask(2), false);
  assert.equal(speaking.isExperimentalTask(3), true);
  assert.equal(speaking.isExperimentalTask(4), true);
  assert.equal(speaking.formatTime(150), '2:30');
  assert.equal(speaking.formatTime(-5), '0:00');
  assert.equal(speaking.formatTime(9), '0:09');
});

test('speaking module counts trainings before any AI score exists', () => {
  const speaking = createSpeakingModule();
  const state = speaking.normalizeState({ t1: { n: 3 }, t3: { n: -2 } });

  assert.deepEqual(plain(state), { t1: { n: 3 }, t3: { n: 0 }, t2: { n: 0 }, t4: { n: 0 } });
  assert.equal(speaking.trainingTotal(state), 3);
  assert.deepEqual(
    { ...speaking.summary([], state) },
    { count: 0, average: 0, trainings: 3, progress: 12, rated: false },
  );
  assert.equal(speaking.summary([], { t1: { n: 40 } }).progress, 100);
});

test('speaking module averages the last five AI scores and caps history', () => {
  const speaking = createSpeakingModule();
  let scores = [];
  for (let index = 0; index < 34; index += 1) {
    scores = speaking.appendScore(scores, { t: 4, g: 5, m: 10, ts: index });
  }

  assert.equal(scores.length, speaking.SCORE_LIMIT);
  assert.equal(scores[0].ts, 4);

  const summary = speaking.summary(scores, { t1: { n: 1 } });
  assert.equal(summary.rated, true);
  assert.equal(summary.average, 50);
  assert.equal(summary.progress, 50);
  assert.equal(summary.count, 30);
});

test('speaking module picks a supported recorder MIME type', () => {
  const speaking = createSpeakingModule();

  assert.equal(speaking.preferredMimeType({ isTypeSupported: () => true }), 'audio/mp4');
  assert.equal(
    speaking.preferredMimeType({ isTypeSupported: (type) => type.startsWith('audio/webm') }),
    'audio/webm;codecs=opus',
  );
  assert.equal(speaking.preferredMimeType({ isTypeSupported: () => false }), '');
  assert.equal(speaking.preferredMimeType(undefined), '');
  assert.equal(speaking.preferredMimeType({ isTypeSupported: () => { throw new Error('blocked'); } }), '');
});

test('speaking module cycles task sets and builds per-task assignments', () => {
  const speaking = createSpeakingModule();
  const sets = speaking.pool([{ tx: 'base' }], [{ tx: 'ai' }]);

  assert.equal(speaking.select(sets, 3).tx, 'ai');
  assert.equal(speaking.select([], 1), null);
  assert.deepEqual(plain(speaking.assignment(2, { ad: 'ad', points: ['a'], qs: ['ignored'] })), { ad: 'ad', points: ['a'] });
  assert.deepEqual(plain(speaking.assignment(3, { topic: 'T', qs: ['q'] })), { topic: 'T', qs: ['q'] });
  assert.deepEqual(plain(speaking.assignment(4, { topic: 'T', plan: ['p'], ph: ['1', '2'] })), { topic: 'T', plan: ['p'], ph: ['1', '2'] });
});

test('speaking module rejects unusable transcripts and clamps AI scores to the task maximum', () => {
  const speaking = createSpeakingModule();

  assert.equal(speaking.isTranscriptUsable('one two three'), true);
  assert.equal(speaking.isTranscriptUsable('  one   two  '), false);
  assert.equal(speaking.isTranscriptUsable(''), false);
  assert.equal(speaking.isTranscriptUsable(null), false);

  assert.deepEqual({ ...speaking.clampScore({ got: 40 }, 1) }, { got: 1, max: 1 });
  assert.deepEqual({ ...speaking.clampScore({ got: -3 }, 4) }, { got: 0, max: 10 });
  assert.deepEqual({ ...speaking.clampScore({ got: '3' }, 5) }, { got: 1, max: 1 });
  assert.deepEqual({ ...speaking.clampScore(null, 3) }, { got: 0, max: 5 });
});

test('speaking module totals the exam and finds the weakest task', () => {
  const speaking = createSpeakingModule();
  const results = { 1: { got: 1 }, 2: { got: 4 }, 3: { got: 1 }, 4: { got: 8 } };

  assert.equal(speaking.examTotal(results), 14);
  assert.equal(speaking.weakestTask(results), 3);
  assert.equal(speaking.examTotal({}), 0);
  assert.deepEqual(plain(speaking.BADGES), { gold: 0.8, silver: 0.5 });
});

test('speaking module splits sample answers into sentences for playback', () => {
  const speaking = createSpeakingModule();

  assert.deepEqual(
    Array.from(speaking.sentences('  Hello there! How are you?  ')),
    ['Hello there!', 'How are you?'],
  );
  assert.deepEqual(Array.from(speaking.sentences('no final punctuation')), ['no final punctuation']);
  assert.deepEqual(Array.from(speaking.sentences('   ')), []);
});

test('speaking module rejects malformed AI-generated task sets', () => {
  const speaking = createSpeakingModule();
  const longText = new Array(60).fill('word').join(' ');

  assert.equal(speaking.normalizeGenerated(1, { tx: 'too short' }), null);
  assert.deepEqual(plain(speaking.normalizeGenerated(1, { tx: longText })), { tx: longText });
  assert.equal(speaking.normalizeGenerated(2, { ad: 'ad', points: ['a', 'b', 'c'], exq: ['1', '2', '3', '4'] }), null);
  assert.equal(speaking.normalizeGenerated(2, { ad: 'ad', points: ['a', 'b', 'c', 'd'], exq: ['1'] }), null);
  assert.equal(speaking.normalizeGenerated(3, { topic: 'T', qs: ['1', '2', '3', '4'] }), null);
  assert.equal(speaking.normalizeGenerated(4, { topic: 'T', ph: ['one'] }), null);
  assert.equal(speaking.normalizeGenerated(4, null), null);

  const monologue = speaking.normalizeGenerated(4, { topic: 'T', ph: ['one', 'two'] });
  assert.equal(monologue.plan.length, 4);
  assert.equal(monologue.ph.length, 2);
});

test('speaking module normalizes pronunciation availability and quota without trusting malformed payloads', () => {
  const speaking = createSpeakingModule();
  assert.deepEqual(plain(speaking.pronunciationStatusView({
    provider: { available: true, provider: 'azure-speech', reason: null },
    quota: {
      tier: 'base', periodStart: '2026-08-01T00:00:00.000Z', limitSeconds: 3600,
      usedSeconds: 80, heldSeconds: 20, remainingSeconds: 3500,
    },
  })), { available: true, reason: null, tier: 'base', remainingSeconds: 3500, limitSeconds: 3600 });
  assert.deepEqual(plain(speaking.pronunciationStatusView({
    provider: { available: false, provider: 'azure-speech', reason: 'sdk_not_installed' },
    quota: { tier: 'premium', remainingSeconds: 14_400, limitSeconds: 14_400 },
  })), {
    available: false, reason: 'sdk_not_installed', tier: 'premium',
    remainingSeconds: 14_400, limitSeconds: 14_400,
  });
  assert.deepEqual(plain(speaking.pronunciationStatusView({ provider: { available: true }, quota: {} })), {
    available: false, reason: 'invalid_status', tier: null, remainingSeconds: 0, limitSeconds: 0,
  });
});

test('speaking module accepts only the server-owned public task 1 assignment shape', () => {
  const speaking = createSpeakingModule();
  const session = {
    id: '71100000-0000-4000-8000-000000000001',
    task: {
      id: 'speaking-pilot-v1.task1.community-garden', revision: 1, taskType: 1,
      cefr: 'B1', topic: 'Город и природа', preparationSeconds: 90, responseSeconds: 90,
      maxScore: 1, instruction: 'Read aloud.', text: 'A server-owned reading text.',
    },
    pronunciationAssessment: { available: false, reason: 'provider_not_connected' },
  };

  assert.deepEqual(plain(speaking.serverTask1Set(session)), {
    id: session.task.id,
    revision: 1,
    tx: session.task.text,
    topic: session.task.topic,
    cefr: 'B1',
  });
  assert.equal(speaking.serverTask1Set({ ...session, task: { ...session.task, preparationSeconds: 60 } }), null);
  assert.equal(speaking.serverTask1Set({ ...session, task: { ...session.task, reference: { script: 'secret' } } }), null);
  assert.equal(speaking.serverTask1Set({ ...session, pronunciationAssessment: { available: true } }), null);
});

test('speaking module accepts only the server-owned four-support task 2 assignment shape', () => {
  const speaking = createSpeakingModule();
  const session = {
    id: '72200000-0000-4000-8000-000000000001',
    task: {
      id: 'speaking-pilot-v1.task2.weekend-pottery', revision: 1, taskType: 2,
      cefr: 'B1', topic: 'Creative courses', preparationSeconds: 60, questionSeconds: 20,
      maxScore: 4, instruction: 'Ask four questions.', advertisement: 'A server-owned advertisement.',
      supports: ['course dates', 'participation fee', 'group size', 'tools provided'],
    },
    assessment: { available: false, reason: 'deferred_to_tickets_06_07' },
  };

  assert.deepEqual(plain(speaking.serverTask2Set(session)), {
    id: session.task.id, revision: 1, ad: session.task.advertisement,
    points: session.task.supports, topic: session.task.topic, cefr: 'B1',
  });
  assert.equal(speaking.serverTask2Set({ ...session, task: { ...session.task, supports: [...session.task.supports, 'fifth'] } }), null);
  assert.equal(speaking.serverTask2Set({ ...session, task: { ...session.task, questionSeconds: 25 } }), null);
  assert.equal(speaking.serverTask2Set({ ...session, assessment: { available: true } }), null);
});

test('speaking module accepts only the server-owned five-question task 3 assignment shape', () => {
  const speaking = createSpeakingModule();
  const session = {
    id: '73300000-0000-4000-8000-000000000001',
    task: {
      id: 'speaking-pilot-v1.task3.free-time-routines', revision: 1, taskType: 3,
      cefr: 'B1', topic: 'Свободное время', preparationSeconds: 0, questionSeconds: 40,
      maxScore: 5, instruction: 'Give five full answers.',
      questions: Array.from({ length: 5 }, (_, index) => `Original interview question ${index + 1}?`),
    },
    assessment: { available: false, reason: 'deferred_to_tickets_06_07' },
  };

  assert.deepEqual(plain(speaking.serverTask3Set(session)), {
    id: session.task.id, revision: 1, topic: session.task.topic,
    instruction: session.task.instruction, qs: session.task.questions, cefr: 'B1',
  });
  assert.equal(speaking.serverTask3Set({ ...session, task: { ...session.task, questions: session.task.questions.slice(0, 4) } }), null);
  assert.equal(speaking.serverTask3Set({ ...session, task: { ...session.task, preparationSeconds: 60 } }), null);
  assert.equal(speaking.serverTask3Set({ ...session, task: { ...session.task, completeness: [] } }), null);
  assert.equal(speaking.serverTask3Set({ ...session, assessment: { available: true } }), null);
});

test('speaking module accepts only the server-owned task 4 photo-project assignment shape', () => {
  const speaking = createSpeakingModule();
  const session = {
    id: '74400000-0000-4000-8000-000000000001',
    task: {
      id: 'speaking-pilot-v1.task4.learning-new-skills', revision: 1, taskType: 4,
      cefr: 'B1', topic: 'Learning new skills', projectTitle: 'Learning new skills',
      preparationSeconds: 150, responseSeconds: 180, maxScore: 10,
      instruction: 'Give a talk for your project.',
      photoPair: {
        assetId: 'speaking-task4-photo-pair.learning-new-skills.v1',
        src: '/assets/speaking/task4-v1/learning-new-skills.png',
        alt: 'Two photographs comparing ways to learn new skills.',
        panels: [{ number: 1, alt: 'A student attends a pottery lesson.' },
          { number: 2, alt: 'A student follows a guitar lesson.' }],
      },
      plan: ['Describe both photographs in detail.', 'Explain what the photographs have in common.',
        'Compare the main differences between the photographs.', 'Say which way you prefer and explain why.'],
    },
    assessment: { available: false, reason: 'deferred_to_tickets_06_07' },
  };

  assert.deepEqual(plain(speaking.serverTask4Set(session)), {
    id: session.task.id, revision: 1, topic: session.task.topic,
    projectTitle: session.task.projectTitle, instruction: session.task.instruction,
    photoPair: session.task.photoPair, plan: session.task.plan, cefr: 'B1',
  });
  assert.equal(speaking.serverTask4Set({ ...session, task: { ...session.task, responseSeconds: 150 } }), null);
  assert.equal(speaking.serverTask4Set({ ...session, task: { ...session.task, photoPair: { ...session.task.photoPair, src: 'https://external.example/pair.png' } } }), null);
  assert.equal(speaking.serverTask4Set({ ...session, task: { ...session.task, photoPair: { ...session.task.photoPair, assetId: 'unsafe' } } }), null);
  assert.equal(speaking.serverTask4Set({ ...session, task: { ...session.task, photoPair: { ...session.task.photoPair,
    panels: [{ position: 'left', alt: 'Wrong panel shape.' }, { position: 'right', alt: 'Wrong panel shape.' }] } } }), null);
  assert.equal(speaking.serverTask4Set({ ...session, task: { ...session.task, rubric: {} } }), null);
  assert.equal(speaking.serverTask4Set({ ...session, assessment: { available: true } }), null);
});
