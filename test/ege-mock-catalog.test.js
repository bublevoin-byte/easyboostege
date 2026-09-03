import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';

import {
  EGE_MOCK_FORM_ID,
  EGE_MOCK_FORM_REVISION,
  assertEgeMockForm,
  getEgeMockForm,
  getEgeMockPublicForm,
} from '../ege-mock/catalog.js';
import * as mockCatalog from '../ege-mock/catalog.js';
import { normalizeEgeMockAnswer } from '../ege-mock/assessment.js';
import { AUTHORED_LEXIS_ITEMS } from '../ege-mock/authored-lexis.js';
import { fingerprintEgeMockForm } from '../ege-mock/domain.js';
import { EGE_MOCK_FORM_1_V1_PUBLIC } from '../public/ege-mock-form-1-v1.js';
import {
  assertEgeMockPublicForm,
  loadEgeMockPublicForm,
} from '../public/ege-mock-catalog-contract.js';

test('the first immutable EGE-2026 form has the exact authored position and score matrix', () => {
  const form = getEgeMockForm(EGE_MOCK_FORM_ID, EGE_MOCK_FORM_REVISION);

  assert.equal(form.identity, 'ege-en-2026-form-1@1');
  assert.equal(form.examYear, 2026);
  assert.deepEqual(form.positions.map(({ position }) => position), Array.from({ length: 42 }, (_, index) => index + 1));
  assert.deepEqual(
    form.sections.map(({ id, positionRange, maxScore }) => ({ id, positionRange, maxScore })),
    [
      { id: 'listening', positionRange: [1, 9], maxScore: 12 },
      { id: 'reading', positionRange: [10, 18], maxScore: 12 },
      { id: 'grammar_lexis', positionRange: [19, 36], maxScore: 18 },
      { id: 'writing', positionRange: [37, 38], maxScore: 20 },
      { id: 'speaking', positionRange: [39, 42], maxScore: 20 },
    ],
  );
  assert.equal(form.positions.reduce((sum, item) => sum + item.maxScore, 0), 82);
  assert.equal(form.maxScore, 82);
});

test('all 42 positions point at exact immutable authored content revisions', () => {
  const form = getEgeMockForm(EGE_MOCK_FORM_ID, EGE_MOCK_FORM_REVISION);
  const refs = form.positions.map(({ contentRef }) => `${contentRef.catalogId}:${contentRef.id}@${contentRef.revision}`);

  assert.deepEqual(refs, [
    'listening-pilot-v1:listening-pilot-v1.matching.greener-life@1',
    'listening-pilot-v1:listening-pilot-v1.true-false.repair-cafe@1',
    ...Array.from({ length: 7 }, (_, index) => (
      `listening-pilot-v1:listening-pilot-v1.interview.youth-orchestra.q${index + 1}@1`
    )),
    'reading-pilot-v1:reading-pilot-v1.task10.student-journalism@1',
    'reading-pilot-v1:reading-pilot-v1.task11.station-after-dark@1',
    ...Array.from({ length: 7 }, (_, index) => (
      `reading-pilot-v1:reading-pilot-v1.task12_18.counting-swifts-at-sunset.q${index + 1}@1`
    )),
    ...Array.from({ length: 6 }, (_, index) => `grammar-core-v3:core.g.exam.1.${index + 1}@3`),
    ...Array.from({ length: 5 }, (_, index) => (
      `ege-mock-lexis-v1:ege-mock-lexis-v1.word-formation.community-repair.${index + 25}@1`
    )),
    ...Array.from({ length: 7 }, (_, index) => (
      `ege-mock-lexis-v1:ege-mock-lexis-v1.lexical-choice.community-library.${index + 30}@1`
    )),
    'writing-task-bank-v1:builtin:writing_37:emily-new-flat@1',
    'writing-task-bank-v1:builtin:writing_38:teen-sport@1',
    'speaking-pilot-v1:speaking-pilot-v1.task1.citizen-weather@1',
    'speaking-pilot-v1:speaking-pilot-v1.task2.organic-farm-volunteers@1',
    'speaking-pilot-v1:speaking-pilot-v1.task3.volunteer-projects@1',
    'speaking-pilot-v1:speaking-pilot-v1.task4.school-projects@1',
  ]);
  assert.equal(new Set(refs).size, 42);
  assert.ok(form.positions.every(({ contentRef }) => Object.isFrozen(contentRef)));
  assert.equal(Object.hasOwn(mockCatalog, 'resolveEgeMockContentRef'), false);
  assert.equal(Object.hasOwn(mockCatalog, 'resolveEgeMockCriteriaRef'), false);
  assert.equal(getEgeMockForm(EGE_MOCK_FORM_ID, 999), null);
});

test('positions 25–36 contain checked original word-formation and lexical-choice content', () => {
  const form = getEgeMockForm(EGE_MOCK_FORM_ID, EGE_MOCK_FORM_REVISION);
  const items = form.positions.slice(24, 36);

  assert.deepEqual(items.map(({ assessment }) => assessment.accepted), [
    ['volunteers'], ['success'], ['practical'], ['reduction'], ['achievement'],
    ['take'], ['came'], ['out'], ['on'], ['attract'], ['donate'], ['difference'],
  ]);
  assert.deepEqual(items.map(({ presentation }) => presentation.kind), [
    ...Array(5).fill('word_formation'),
    ...Array(7).fill('lexical_choice'),
  ]);
  assert.ok(items.every(({ presentation, assessment }) => (
    presentation.provenance.kind === 'original'
      && presentation.provenance.author === 'Easy Boost'
      && presentation.provenance.reviewStatus === 'contract_checked'
      && Array.isArray(assessment.accepted)
      && assessment.accepted.length > 0
      && assessment.accepted.every((answer) => typeof answer === 'string' && answer.length > 0)
  )));
  assert.ok(items.slice(0, 5).every(({ presentation }) => (
    presentation.prompt.includes('_____') && /^[A-Z]+$/u.test(presentation.base)
  )));
  assert.ok(items.slice(5).every(({ presentation, assessment }) => (
    presentation.options.length === 4
      && new Set(presentation.options.map(({ id }) => id)).size === 4
      && presentation.options.some(({ id }) => assessment.accepted.includes(id))
  )));
  assert.equal(new Set(items.map(({ presentation }) => presentation.prompt)).size, 12);
  assert.ok(items.every(Object.isFrozen));
  assert.deepEqual(AUTHORED_LEXIS_ITEMS.map(({ assessment }) => assessment.type), [
    ...Array(5).fill('short_text'), ...Array(7).fill('single_choice'),
  ]);
  assert.ok(AUTHORED_LEXIS_ITEMS.every(({ assessment }) => (
    assessment.maxScore === 1 && assessment.scoreRule.kind === 'all_or_nothing'
  )));
});

test('every authored reference resolves to one complete presentation and one assessment rule', () => {
  const form = getEgeMockForm(EGE_MOCK_FORM_ID, EGE_MOCK_FORM_REVISION);

  assert.deepEqual(form.positions.map(({ presentation }) => presentation.kind), [
    'listening_matching', 'listening_true_false', ...Array(7).fill('listening_choice'),
    'reading_headings', 'reading_gaps', ...Array(7).fill('reading_choice'),
    ...Array(6).fill('grammar_form'),
    ...Array(5).fill('word_formation'), ...Array(7).fill('lexical_choice'),
    'writing_email', 'writing_report',
    'speaking_read_aloud', 'speaking_questions', 'speaking_interview', 'speaking_voice_message',
  ]);
  assert.ok(form.positions.every(({ presentation, assessment, maxScore }) => (
    Object.isFrozen(presentation)
      && Object.isFrozen(assessment)
      && assessment.maxScore === maxScore
  )));
  assert.deepEqual(
    form.positions.slice(36).map(({ assessment }) => [assessment.type, assessment.criteriaRef]),
    [
      ['provisional', 'writing-ege-2026-task37-v1'],
      ['provisional', 'writing-ege-2026-task38-v1'],
      ['provisional', 'speaking-ege-2026-task1-v1'],
      ['provisional', 'speaking-ege-2026-task2-v1'],
      ['provisional', 'speaking-ege-2026-task3-v1'],
      ['provisional', 'speaking-ege-2026-task4-v1'],
    ],
  );
  assert.deepEqual(form.positions.slice(36).map(({ assessment }) => assessment.criteriaFingerprint), [
    'sha256:a64921436b50ba9a9578cb73d7639ca3035f98174ffb2d2c616530de9da9b5f2',
    'sha256:dac7eea22d6ec506444c764ac348fb9ddc982048d8b43d951f86bb7c986b0171',
    'sha256:49bc79635efbd1b83ea757c6574632f1022aeb38972b9e4e2957ba6343b35311',
    'sha256:16657f2f71118f41931a4d2881a3e5f2620922ecb6ae66eeabf7a1e6e192f627',
    'sha256:a6a48bbcd5abc000fe19ee53e7311a59a0bae3b1f8316359d14f02094a08a306',
    'sha256:ab18bb168e2e294dad719bbae829841f2f6cdfae95293d781793b2739ce67a4f',
  ]);
  assert.equal(form.stimuli.length, 2);
  assert.deepEqual(form.stimuli.map(({ id }) => id), [
    'reading-pilot-v1.task12_18.counting-swifts-at-sunset@1:passage',
    'core.g.exam.1@3:passage',
  ]);
});

test('one assessment normalizer canonicalizes every objective answer shape', () => {
  assert.deepEqual(normalizeEgeMockAnswer({
    formId: EGE_MOCK_FORM_ID,
    formRevision: EGE_MOCK_FORM_REVISION,
    position: 1,
    value: [5, ' 2 ', 4, 6, 1, 3],
  }), {
    canonical: ['5', '2', '4', '6', '1', '3'],
    correctness: [true, true, true, true, true, true],
    correctCount: 6,
    isAccepted: true,
  });
  assert.deepEqual(normalizeEgeMockAnswer({
    formId: EGE_MOCK_FORM_ID,
    formRevision: EGE_MOCK_FORM_REVISION,
    position: 3,
    value: ' B ',
  }), {
    canonical: 'b', correctness: true, correctCount: 1, isAccepted: true,
  });
  assert.deepEqual(normalizeEgeMockAnswer({
    formId: EGE_MOCK_FORM_ID,
    formRevision: EGE_MOCK_FORM_REVISION,
    position: 22,
    value: '  MORE   BEAUTIFUL  ',
  }), {
    canonical: 'more beautiful', correctness: true, correctCount: 1, isAccepted: true,
  });

  const form = getEgeMockForm(EGE_MOCK_FORM_ID, EGE_MOCK_FORM_REVISION);
  for (const item of form.positions.slice(0, 36)) {
    const accepted = item.assessment.type === 'ordered_choice_list'
      ? item.assessment.accepted
      : item.assessment.accepted[0];
    assert.equal(normalizeEgeMockAnswer({
      formId: form.id, formRevision: form.revision, position: item.position, value: accepted,
    }).isAccepted, true, `position ${item.position}`);
  }

  assert.throws(() => normalizeEgeMockAnswer({
    formId: EGE_MOCK_FORM_ID, formRevision: 1, position: 1, value: ['1', '1', '2', '3', '4', '5'],
  }), /EGE_MOCK_ANSWER_INVALID/u);
  assert.throws(() => normalizeEgeMockAnswer({
    formId: EGE_MOCK_FORM_ID, formRevision: 1, position: 25, value: '<script>',
  }), /EGE_MOCK_ANSWER_INVALID/u);
  assert.throws(() => normalizeEgeMockAnswer({
    formId: EGE_MOCK_FORM_ID, formRevision: 1, position: 37, value: 'student answer',
  }), /EGE_MOCK_ANSWER_NOT_OBJECTIVE/u);
});

test('the form fingerprint covers a complete digest-checked authored asset manifest', () => {
  const form = getEgeMockForm(EGE_MOCK_FORM_ID, EGE_MOCK_FORM_REVISION);

  assert.match(form.fingerprint, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(form.fingerprint, 'sha256:0a24dad6e3e3e37d2a30b0062351e216f0106ca1b55a859440f06f895642f001');
  assert.equal(fingerprintEgeMockForm(form), form.fingerprint);
  const changed = structuredClone(form);
  changed.positions[24].presentation.prompt += ' changed';
  assert.notEqual(fingerprintEgeMockForm(changed), form.fingerprint);

  assert.equal(form.assets.length, 21);
  const referenced = new Set(form.positions.flatMap(({ assetIds }) => assetIds));
  assert.deepEqual([...referenced].sort(), form.assets.map(({ id }) => id).sort());
  for (const asset of form.assets) {
    assert.match(asset.sha256, /^[a-f0-9]{64}$/u, asset.id);
    const bytes = fs.readFileSync(new URL(`../public${asset.path}`, import.meta.url));
    assert.equal(bytes.length, asset.bytes, asset.id);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), asset.sha256, asset.id);
  }
  assert.deepEqual(form.assets.find(({ kind }) => kind === 'image'), {
    id: '/assets/speaking/task4-v1/school-projects.png',
    kind: 'image',
    path: '/assets/speaking/task4-v1/school-projects.png',
    mimeType: 'image/png',
    bytes: 2471629,
    sha256: '18af3f4072fbe48946abb251abeb21f69656517f097d047d959c8ced52938507',
  });
});

test('the publication validator fails closed on matrix, reference, asset, or fingerprint drift', () => {
  const form = getEgeMockForm(EGE_MOCK_FORM_ID, EGE_MOCK_FORM_REVISION);
  assert.equal(assertEgeMockForm(structuredClone(form)).identity, form.identity);

  const mutations = [
    (candidate) => candidate.positions.pop(),
    (candidate) => { candidate.positions[0].maxScore = 3; },
    (candidate) => { candidate.positions[24].contentRef.revision = 2; },
    (candidate) => { candidate.assets[0].sha256 = '0'.repeat(64); },
    (candidate) => { candidate.positions[0].assetIds = []; },
    (candidate) => { candidate.fingerprint = `sha256:${'f'.repeat(64)}`; },
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(form);
    mutate(candidate);
    assert.throws(() => assertEgeMockForm(candidate), /EGE_MOCK_FORM_INVALID/u);
  }

  const recomputedTamper = structuredClone(form);
  recomputedTamper.positions[24].presentation.prompt += ' altered';
  recomputedTamper.fingerprint = fingerprintEgeMockForm(recomputedTamper);
  assert.throws(() => assertEgeMockForm(recomputedTamper), /EGE_MOCK_FORM_INVALID/u);

  const unresolvedRef = structuredClone(form);
  unresolvedRef.positions[24].contentRef.id = 'ege-mock-lexis-v1.unknown';
  unresolvedRef.fingerprint = fingerprintEgeMockForm(unresolvedRef);
  assert.throws(() => assertEgeMockForm(unresolvedRef), /EGE_MOCK_FORM_INVALID/u);
});

test('the browser catalog is a static answer-free projection with no private module graph', async () => {
  const projection = getEgeMockPublicForm(EGE_MOCK_FORM_ID, EGE_MOCK_FORM_REVISION);
  assert.deepEqual(EGE_MOCK_FORM_1_V1_PUBLIC, projection);
  assert.deepEqual(await loadEgeMockPublicForm(), projection);
  assert.equal(assertEgeMockPublicForm(EGE_MOCK_FORM_1_V1_PUBLIC), EGE_MOCK_FORM_1_V1_PUBLIC);
  const forgedFingerprint = structuredClone(EGE_MOCK_FORM_1_V1_PUBLIC);
  forgedFingerprint.fingerprint = `sha256:${'f'.repeat(64)}`;
  assert.throws(() => assertEgeMockPublicForm(forgedFingerprint), /EGE_MOCK_PUBLIC_FORM_INVALID/u);
  assert.equal(projection.positions.length, 42);
  assert.equal(projection.maxScore, 82);
  assert.equal(projection.fingerprint, getEgeMockForm(EGE_MOCK_FORM_ID, 1).fingerprint);

  const forbiddenKeys = new Set([
    'accepted', 'answer', 'answers', 'assessment', 'contentRef', 'criteriaRef',
    'evidence', 'explanationRu', 'reference', 'rubric', 'script', 'scoreRule',
  ]);
  const visit = (value, location = 'form') => {
    if (!value || typeof value !== 'object') return;
    assert.equal(Object.isFrozen(value), true, `${location} must be immutable`);
    for (const [key, child] of Object.entries(value)) {
      assert.equal(forbiddenKeys.has(key), false, `${location}.${key} leaked private assessment data`);
      visit(child, `${location}.${key}`);
    }
  };
  visit(projection);

  const moduleSource = fs.readFileSync(new URL('../public/ege-mock-form-1-v1.js', import.meta.url), 'utf8');
  assert.doesNotMatch(moduleSource, /^\s*import\s/mu);
  assert.doesNotMatch(moduleSource, /\b(?:accepted|answers?|assessment|rubric|criteriaRef|contentRef)\s*:/u);
});
