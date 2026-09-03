import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import express from 'express';
import {
  GRAMMAR_CATALOG,
  validateGeneratedGrammarSupplement,
} from '../public/grammar-catalog.js';
import { GRAMMAR_ERROR_CODES } from '../public/grammar-domain-contract.js';
import { grammarMasteryEventSchema } from '../validation/grammar-mastery.js';
import { createProgressRoutes } from '../routes/progress.js';
import { createFileRepository } from '../storage/file-repository.js';
import { decorateGeneratedVoiceTutorContent } from '../voice-tutor/generated-items.js';
import { compileOpenApiSchema } from './support/openapi-schema-evaluator.js';

const examSource = await fs.readFile(new URL('../public/modules/exam.js', import.meta.url), 'utf8');

function examModule() {
  const window = {};
  vm.runInNewContext(examSource, {
    window, Object, Number, Math, Array, String, Boolean, Set, Map, JSON,
  });
  return window.EasyBoostExam;
}

function mastery(stage = 'not_started', revision = 0) {
  return {
    masteryVersion: 1, masteryRevision: revision, stage, reviewStep: 0,
    eligibleAt: null, highestReviewStep: 0,
  };
}

test('all three built-in 19–24 forms expose immutable versioned catalog pointers', () => {
  assert.equal(GRAMMAR_CATALOG.exams.length, 3);
  assert.equal(GRAMMAR_CATALOG.exams.flatMap((form) => form.gaps).length, 18);
  for (const form of GRAMMAR_CATALOG.exams) {
    assert.equal(form.revision, GRAMMAR_CATALOG.revision);
    for (const gap of form.gaps) {
      assert.match(gap.id, /^core\.g\.exam\.[1-3]\.[1-6]$/u);
      assert.equal(gap.revision, GRAMMAR_CATALOG.revision);
      assert.equal(gap.type, 'input');
    }
  }
});

test('generated 19–24 supplement keeps its server-issued versioned refs and closed error taxonomy', () => {
  const hash = 'a'.repeat(64);
  const digest = 'b'.repeat(16);
  const generated = validateGeneratedGrammarSupplement('grammar_exam_19_24', {
    tx: ['A ', ' B ', ' C ', ' D ', ' E ', ' F ', ' G.'],
    gaps: Array.from({ length: 6 }, (_, index) => ({
      b: `WORD${index}`, ans: [`answer${index}`], e: `Reason ${index}.`, t: index + 1,
      voice: { id: `generated.g.e.${hash}.${digest}.${index + 1}`, revision: 1 },
    })),
  });

  generated.gaps.forEach((gap, index) => {
    assert.equal(gap.id, `generated.g.e.${hash}.${digest}.${index + 1}`);
    assert.equal(gap.revision, 1);
    assert.equal(gap.type, 'input');
    assert.equal(gap.errorSkill, 'word_or_verb_form');
    assert.equal(gap.provenance, 'generated');
  });
});

test('19–24 assessment builds one replay-safe multi-topic event without claiming mastery', () => {
  const exam = examModule();
  const form = GRAMMAR_CATALOG.exams[0];
  const records = Object.fromEntries([...new Set(form.gaps.map((gap) => gap.t))]
    .map((topicId, index) => [topicId, mastery(index === 0 ? 'confirmed' : 'not_started', index + 2)]));
  const answers = form.gaps.map((gap, index) => index === 0 ? 'definitely wrong' : gap.ans[0]);
  const id = '123e4567-e89b-42d3-a456-426614174000';
  const assessment = exam.assessGrammar19To24({
    id, catalog: GRAMMAR_CATALOG, form, answers, records, startedAt: 1_000, source: 'builtin',
  });

  assert.equal(assessment.score, 5);
  assert.equal(assessment.event.topicId, form.gaps[0].t);
  assert.equal(assessment.event.event.id, id);
  assert.equal(assessment.event.event.session.mode, 'exam_19_24');
  assert.equal(assessment.event.event.session.scope, 'mixed');
  assert.deepEqual(JSON.parse(JSON.stringify(assessment.event.event.completedTypes)), ['input']);
  assert.deepEqual(JSON.parse(JSON.stringify(assessment.event.event.typeScores)), {
    input: { correct: 5, total: 6 },
  });
  assert.equal(assessment.event.event.assisted, true,
    'the disclosed correction is recorded but cannot become mastery evidence');
  assert.equal(assessment.event.event.independentErrors.length, 1);
  assert.equal(assessment.event.event.independentErrors[0].itemId, form.gaps[0].id);
  assert.equal(assessment.errorBank[0].itemKey, form.gaps[0].id);
  assert.equal(assessment.errorBank[0].errorType, 'word_or_verb_form');
  assert.ok(GRAMMAR_ERROR_CODES.includes(assessment.event.event.session.items[0].errorCode));
  assert.equal(grammarMasteryEventSchema.safeParse(assessment.event).success, true);
});

test('runtime accepts only one exact ordered exam form and every first wrong built-in topic error', () => {
  const exam = examModule();
  const records = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [index + 1, mastery()]));
  const first = exam.assessGrammar19To24({
    id: '123e4567-e89b-42d3-a456-426614174020', catalog: GRAMMAR_CATALOG,
    form: GRAMMAR_CATALOG.exams[0], answers: GRAMMAR_CATALOG.exams[0].gaps.map(() => 'wrong'),
    records, startedAt: 1_000, source: 'builtin',
  }).event;
  const second = exam.assessGrammar19To24({
    id: '123e4567-e89b-42d3-a456-426614174021', catalog: GRAMMAR_CATALOG,
    form: GRAMMAR_CATALOG.exams[1], answers: GRAMMAR_CATALOG.exams[1].gaps.map(() => 'wrong'),
    records, startedAt: 1_000, source: 'builtin',
  }).event;

  const hybrid = structuredClone(first);
  hybrid.event.session.items[0] = structuredClone(second.event.session.items[1]);
  hybrid.topicId = hybrid.event.session.items[0].topicId;
  hybrid.event.expectedRevision = records[hybrid.topicId].masteryRevision;
  hybrid.event.expectedStage = records[hybrid.topicId].stage;
  hybrid.event.expectedReviewStep = records[hybrid.topicId].reviewStep;
  hybrid.event.session.topicExpectations = [...new Set(hybrid.event.session.items.map((item) => item.topicId))]
    .map((topicId) => ({ topicId, expectedRevision: 0, expectedStage: 'not_started', expectedReviewStep: 0 }));
  hybrid.event.independentErrors = hybrid.event.session.items
    .filter((item, index, items) => !item.correct && items.findIndex((candidate) => candidate.topicId === item.topicId) === index)
    .map((item) => ({ topicId: item.topicId, itemId: item.id, diagnosticId: null, reason: item.errorCode, confusionPair: null }));
  assert.equal(grammarMasteryEventSchema.safeParse(hybrid).success, false,
    'individually valid gaps cannot be mixed across immutable forms');

  const missingError = structuredClone(first);
  missingError.event.independentErrors.shift();
  assert.equal(grammarMasteryEventSchema.safeParse(missingError).success, false,
    'each physical topic keeps exactly its first wrong built-in outcome as regression evidence');
});

test('runtime binds generated exam outcomes to one exact group in positions 1–6', () => {
  const exam = examModule();
  const makeForm = (requestHash, resultDigest) => validateGeneratedGrammarSupplement('grammar_exam_19_24', {
    tx: ['A ', ' B ', ' C ', ' D ', ' E ', ' F ', '.'],
    gaps: Array.from({ length: 6 }, (_, index) => ({
      b: `WORD${index}`, ans: [`answer${index}`], e: `Reason ${index}.`, t: index + 1,
      voice: { id: `generated.g.e.${requestHash}.${resultDigest}.${index + 1}`, revision: 1 },
    })),
  });
  const records = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [index + 1, mastery()]));
  const firstForm = makeForm('a'.repeat(64), 'b'.repeat(16));
  const secondForm = makeForm('c'.repeat(64), 'd'.repeat(16));
  const event = exam.assessGrammar19To24({
    id: '123e4567-e89b-42d3-a456-426614174022', catalog: GRAMMAR_CATALOG,
    form: firstForm, answers: firstForm.gaps.map((gap) => gap.ans[0]), records,
    startedAt: 1_000, source: 'generated',
  }).event;
  event.event.session.items[1] = {
    ...event.event.session.items[1], id: secondForm.gaps[1].id,
  };
  assert.equal(grammarMasteryEventSchema.safeParse(event).success, false,
    'one generated completion cannot splice a position from another server-issued group');
});

test('Grammar 2.0 dashboard reports all 20 stages, due work and exact weak error types', () => {
  const exam = examModule();
  const records = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [index + 1, {
    ...mastery(index === 0 ? 'stable' : index === 1 ? 'learned' : 'not_started', index),
    eligibleAt: index === 1 ? 1_000 : null,
    lastRegressionReason: index === 1 ? 'agreement' : null,
    stats: { correct: 0, errors: index === 1 ? 2 : 0, assistedAttempts: 0, advancedStreak: 0 },
  }]));
  records[3].stats.errors = 1;
  records[3].masteryHistory = [{
    at: 1_500,
    session: {
      source: 'builtin', scope: 'mixed',
      items: [{ topicId: 3, correct: false, errorCode: 'word_or_verb_form' }],
    },
  }];
  const dashboard = exam.grammarDashboard(records, { now: 2_000 });

  assert.equal(dashboard.topics.length, 20);
  assert.equal(dashboard.stageCounts.stable, 1);
  assert.equal(dashboard.stageCounts.learned, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(dashboard.dueTopicIds)), [2]);
  assert.deepEqual(JSON.parse(JSON.stringify(dashboard.weakErrorTypes)), [
    { errorCode: 'agreement', topics: 1, errors: 2 },
    { errorCode: 'word_or_verb_form', topics: 1, errors: 1 },
  ]);
});

test('19–24 HTTP result applies each physical topic atomically and replays without duplicate evidence', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-grammar-exam-release-'));
  const repository = createFileRepository(path.join(directory, 'data.json'));
  const owner = await repository.createTelegramUser(8_813_001, 'Grammar Exam Owner');
  const form = GRAMMAR_CATALOG.exams[0];
  const topicIds = [...new Set(form.gaps.map((gap) => gap.t))];
  await repository.saveProgress(owner, { gram: Object.fromEntries(topicIds.map((topicId, index) => [
    topicId, index === 0 ? { st: 2, due: 1, ok: 8, err: 0, sr: 4 } : { st: 0, ok: 0, err: 0, sr: 0 },
  ])) });
  const records = await repository.migrateGrammarMastery(owner);
  const assessment = examModule().assessGrammar19To24({
    id: '123e4567-e89b-42d3-a456-426614174001',
    catalog: GRAMMAR_CATALOG,
    form,
    answers: form.gaps.map((gap, index) => index === 0 ? 'wrong' : gap.ans[0]),
    records,
    startedAt: 1_000,
    source: 'builtin',
  });
  const app = express();
  app.use(express.json());
  app.use(createProgressRoutes({
    authentication: { auth(req, _res, next) { req.user = req.headers['x-test-user']; next(); } },
    db: repository,
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  async function submit() {
    const response = await fetch(`${baseUrl}/api/v1/grammar/mastery-events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-user': owner,
        'x-easyboost-expected-owner': owner,
      },
      body: JSON.stringify(assessment.event),
    });
    return { status: response.status, body: await response.json() };
  }
  try {
    const applied = await submit();
    assert.equal(applied.status, 201, JSON.stringify(applied.body));
    assert.equal(applied.body.results.length, topicIds.length);
    const wrongTopic = applied.body.results.find((result) => result.topicId === form.gaps[0].t);
    assert.equal(wrongTopic.record.stage, 'learned');
    assert.equal(wrongTopic.record.lastRegressionReason, 'word_or_verb_form');
    const cleanTopic = applied.body.results.find((result) => result.topicId === form.gaps[1].t);
    assert.equal(cleanTopic.record.stage, 'not_started', 'exam correctness is useful history, not mastery proof');

    const next = await fetch(`${baseUrl}/api/v1/grammar/recommendation`, {
      headers: {
        'x-test-user': owner,
        'x-easyboost-expected-owner': owner,
      },
    });
    const nextBody = await next.json();
    assert.equal(next.status, 200, JSON.stringify(nextBody));
    assert.deepEqual({
      topicId: nextBody.recommendation.pointer.topicId,
      errorCode: nextBody.recommendation.pointer.errorCode,
    }, {
      topicId: form.gaps[0].t,
      errorCode: 'word_or_verb_form',
    }, 'the exact built-in exam weakness becomes the next targeted practice focus');
    assert.ok(nextBody.recommendation.reasonCodes.includes('recent_weakness'),
      'the focus comes from the exact exam history rather than a coincidental catalog fallback');

    const replay = await submit();
    assert.equal(replay.status, 200);
    assert.equal(replay.body.results.every((result) => result.replay), true);
    assert.equal(replay.body.results.every((result) => result.record.masteryHistory.length === 1), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('generated 19–24 refs are checked against the owner task and remain assisted evidence', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-generated-grammar-exam-'));
  const repository = createFileRepository(path.join(directory, 'data.json'));
  const owner = await repository.createTelegramUser(8_813_002, 'Generated Grammar Exam Owner');
  const requestHash = 'd'.repeat(64);
  const raw = {
    tx: ['Last week ', ' and then ', '. Later ', ', while ', '. Finally ', ' before ', ' home.'],
    gaps: [
      { b: 'GO', ans: ['went'], e: 'Past Simple.', t: 2 },
      { b: 'VISIT', ans: ['visited'], e: 'Past Simple.', t: 2 },
      { b: 'BUILD', ans: ['was built'], e: 'Past passive.', t: 5 },
      { b: 'WORK', ans: ['was working'], e: 'Past Continuous.', t: 2 },
      { b: 'GOOD', ans: ['better'], e: 'Comparative.', t: 10 },
      { b: 'SHE', ans: ['her'], e: 'Possessive.', t: 11 },
    ],
  };
  const decorated = decorateGeneratedVoiceTutorContent('grammar_exam_19_24', requestHash, raw);
  assert.ok(decorated.gaps.every((gap) => gap.voice), 'fixture must use the same server decorator as production');
  const form = validateGeneratedGrammarSupplement('grammar_exam_19_24', decorated);
  await repository.saveGeneratedTask(owner, {
    operation: 'grammar_exam_19_24', requestHash,
    request: { operation: 'grammar_exam_19_24' }, result: raw,
    provider: 'test', promptVersion: 'content-v1',
  });
  const records = await repository.migrateGrammarMastery(owner);
  const assessment = examModule().assessGrammar19To24({
    id: '123e4567-e89b-42d3-a456-426614174002',
    catalog: GRAMMAR_CATALOG, form, answers: form.gaps.map((gap) => gap.ans[0]),
    records, startedAt: 2_000, source: 'generated',
  });
  assert.equal(grammarMasteryEventSchema.safeParse(assessment.event).success, true);
  const app = express();
  app.use(express.json());
  app.use(createProgressRoutes({
    authentication: { auth(req, _res, next) { req.user = req.headers['x-test-user']; next(); } },
    db: repository,
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/grammar/mastery-events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', 'x-test-user': owner, 'x-easyboost-expected-owner': owner,
      },
      body: JSON.stringify(assessment.event),
    });
    const body = await response.json();
    assert.equal(response.status, 201, JSON.stringify(body));
    assert.equal(body.results.every((result) => result.record.stage === 'not_started'), true);
    assert.equal(body.results.every((result) => result.record.stats.assistedAttempts === 1), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('browser exam uses the owner-bound mastery seam and a device-local resumable snapshot', async () => {
  const screen = await fs.readFile(new URL('../public/screens/grammar.js', import.meta.url), 'utf8');
  const examBlock = screen.slice(screen.indexOf('/* ===== ЭКЗАМЕН'));
  const sync = await fs.readFile(new URL('../public/sync.js', import.meta.url), 'utf8');
  const exam = examModule();
  const form = GRAMMAR_CATALOG.exams[0];

  assert.equal(typeof exam.normalizeGrammarAnswer, 'function',
    'assessment and result rendering need one public exam answer normalizer');
  assert.equal(exam.assessGrammar19To24({
    id: '123e4567-e89b-42d3-a456-426614174023', catalog: GRAMMAR_CATALOG, form,
    answers: form.gaps.map((gap, index) => `${gap.ans[0]}${[',', ';', ':'][index % 3]}`),
    records: Object.fromEntries(Array.from({ length: 20 }, (_, index) => [index + 1, mastery()])),
    startedAt: 3_000, source: 'builtin',
  }).score, 6, 'bounded trailing punctuation remains correct at the assessment seam');

  assert.match(examBlock, /examModule\.assessGrammar19To24/u);
  assert.match(examBlock, /examModule\.normalizeGrammarAnswer/u,
    'the result UI must render correctness through the same canonical checker as assessment');
  assert.match(examBlock, /gSubmitMasteryEvent/u);
  assert.match(examBlock, /grammar-exam-runner-v1/u);
  assert.match(examBlock, /oninput="gExamInput\(/u);
  assert.doesNotMatch(examBlock, /legacy\.err\+\+|S\.gram\[/u,
    'the old client-only counter cannot be the exam authority');
  assert.match(sync, /NON_SYNC_PROGRESS_MODULES=new Set\(\['grammarMastery','grammarRunner','works','essays','writingAttemptIds'\]\)/u,
    'the resumable exam uses the already isolated device-local Grammar workflow slot');
});

test('Grammar map renders the release dashboard with stages, due queue, weak errors and both entry modes', async () => {
  const screen = await fs.readFile(new URL('../public/screens/grammar.js', import.meta.url), 'utf8');
  assert.match(screen, /examModule\.grammarDashboard\(S\.grammarMastery/u);
  assert.match(screen, /data-grammar-dashboard/u);
  assert.match(screen, /20 тем/u);
  assert.match(screen, /На повторение/u);
  assert.match(screen, /Слабые места/u);
  assert.match(screen, /Смешанная практика/u);
  assert.match(screen, /Экзамен · задания 19–24/u);
});

test('OpenAPI executes the exact built-in and generated 19–24 release contract', async () => {
  const openapi = await fs.readFile(new URL('../docs/openapi.yaml', import.meta.url), 'utf8');
  const validateRequest = compileOpenApiSchema(openapi, 'GrammarMasteryEventRequest');
  const validateExamRequest = compileOpenApiSchema(openapi, 'GrammarExamMasteryEventRequest');
  const form = GRAMMAR_CATALOG.exams[0];
  const topicIds = [...new Set(form.gaps.map((gap) => gap.t))];
  const records = Object.fromEntries(topicIds.map((topicId) => [topicId, mastery()]));
  const builtIn = examModule().assessGrammar19To24({
    id: '123e4567-e89b-42d3-a456-426614174003',
    catalog: GRAMMAR_CATALOG, form, answers: form.gaps.map((gap) => gap.ans[0]),
    records, startedAt: 3_000, source: 'builtin',
  }).event;
  assert.equal(validateExamRequest(builtIn), true, JSON.stringify(validateExamRequest.errors));
  assert.equal(validateRequest(builtIn), true, JSON.stringify(validateRequest.errors));

  const forged = structuredClone(builtIn);
  forged.event.session.items[0].id = 'core.g.exam.1.999';
  assert.equal(validateExamRequest(forged), false, 'unknown built-in exam gaps stay closed');

  const requestHash = 'e'.repeat(64);
  const raw = {
    tx: ['A ', ' B ', ' C ', ' D ', ' E ', ' F ', '.'],
    gaps: Array.from({ length: 6 }, (_, index) => ({
      b: `WORD${index}`, ans: [`answer${index}`], e: `Reason ${index}.`, t: index + 1,
    })),
  };
  const generatedForm = validateGeneratedGrammarSupplement(
    'grammar_exam_19_24', decorateGeneratedVoiceTutorContent('grammar_exam_19_24', requestHash, raw),
  );
  const generated = examModule().assessGrammar19To24({
    id: '123e4567-e89b-42d3-a456-426614174004',
    catalog: GRAMMAR_CATALOG, form: generatedForm,
    answers: generatedForm.gaps.map((gap) => gap.ans[0]), records,
    startedAt: 4_000, source: 'generated',
  }).event;
  assert.equal(validateExamRequest(generated), true, JSON.stringify(validateExamRequest.errors));
  assert.equal(validateRequest(generated), true, JSON.stringify(validateRequest.errors));
  generated.event.session.items[0].id = generated.event.session.items[0].id.replace('.g.e.', '.g.q.');
  assert.equal(validateExamRequest(generated), false, 'practice pointers cannot impersonate exam pointers');
});

test('operations, retention and schema docs publish the Grammar 2.0 release boundaries', async () => {
  const [operations, retention, database] = await Promise.all([
    fs.readFile(new URL('../docs/AI_OPERATIONS.md', import.meta.url), 'utf8'),
    fs.readFile(new URL('../docs/DATA_RETENTION.md', import.meta.url), 'utf8'),
    fs.readFile(new URL('../docs/DATABASE_SCHEMA.md', import.meta.url), 'utf8'),
  ]);
  assert.match(operations, /Grammar 2\.0 exam 19–24/u);
  assert.match(operations, /generated\.g\.e\./u);
  assert.match(operations, /assisted.*never advances mastery/isu);
  assert.match(retention, /Grammar 2\.0 mastery and exam resume/u);
  assert.match(retention, /device-local.*grammarRunner/isu);
  assert.match(retention, /prompts.*answers.*not persisted/isu);
  assert.match(database, /Grammar 2\.0 mastery persistence/u);
  assert.match(database, /user_progress\.data\.grammarMastery/u);
  assert.match(database, /exam_19_24.*atomic/isu);
});
