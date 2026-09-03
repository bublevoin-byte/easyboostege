import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

import { createAdaptiveLearningRoutes } from '../routes/adaptive-learning.js';
import { createProgressRoutes } from '../routes/progress.js';
import {
  adaptiveProfileMatchesCurrentEvidence,
  buildAdaptiveLearningProfile,
  EGE_SKILL_TAXONOMY,
} from '../adaptive-learning/profile.js';
import { buildAdaptiveLearningPlan } from '../adaptive-learning/plan.js';
import { requiresServerAssessment, SERVER_ASSESSED_MODULES } from '../adaptive-learning/evidence-policy.js';
import { adaptiveAssistedMetadata } from '../adaptive-learning/evidence-quality.js';
import {
  ADAPTIVE_PROFILE_CALCULATION_REVISION,
} from '../adaptive-learning/evidence-watermark.js';
import {
  DEEP_DIAGNOSTIC_CATALOG,
  SHORT_DIAGNOSTIC_CATALOG,
} from '../adaptive-learning/diagnostic-catalog.js';
import { createFileRepository } from '../storage/file-repository.js';

const NOW = new Date('2026-08-04T09:00:00.000Z');

test('adaptive assisted metadata accepts only exact non-content mode and source values', () => {
  assert.deepEqual(adaptiveAssistedMetadata({
    helpUsed: true, mode: 'listening_exam', source: 'builtin', hintsUsed: 2,
  }), { helpUsed: true, mode: 'listening_exam', source: 'builtin', hintsUsed: 2 });
  assert.deepEqual(adaptiveAssistedMetadata({
    helpUsed: true, mode: 'correct_answer_is_option_four',
    source: 'transcript_says_the_answer', hintsUsed: 2,
  }), { helpUsed: true, hintsUsed: 2 });
});
const OWNER_ATTEMPT_ID = '71563fb2-9d76-4de1-ae70-b9a014792ed1';
const STRANGER_ATTEMPT_ID = '03a5be0c-f380-4a90-9ac3-daf7c578f80b';

test('one evidence policy identifies modules that require server assessment', () => {
  assert.deepEqual([...SERVER_ASSESSED_MODULES], ['writing', 'speaking']);
  assert.equal(requiresServerAssessment('writing'), true);
  assert.equal(requiresServerAssessment('speaking'), true);
  assert.equal(requiresServerAssessment('reading'), false);
});

test('one eligible evidence projection owns the complete profile watermark vector', () => {
  const eligible = {
    id: '71563fb2-9d76-4de1-ae70-b9a014792ed1', module: 'grammar', activity: 'grammar_19_24',
    score: 4, max_score: 5, evidence_quality: 'server_verified_unassisted',
    created_at: '2026-08-04T08:00:00.000Z',
  };
  const baseline = buildAdaptiveLearningProfile({ attempts: [eligible] });
  const withExcludedSources = buildAdaptiveLearningProfile({ attempts: [
    eligible,
    {
      id: crypto.randomUUID(), module: 'writing', activity: 'writing_37',
      score: 100, max_score: 100, evidence_quality: 'client_reported',
      created_at: '2026-08-04T09:00:00.000Z',
    },
    {
      id: crypto.randomUUID(), module: 'speaking', activity: 'speaking_4',
      score: 100, max_score: 100, evidence_quality: 'client_reported',
      created_at: '2026-08-04T09:01:00.000Z',
    },
    {
      id: crypto.randomUUID(), module: 'grammar', activity: 'voice_tutor_error',
      score: 1, max_score: 1, evidence_quality: 'server_verified_assisted',
      created_at: '2026-08-04T09:02:00.000Z',
    },
  ] });
  const vector = (profile) => ({
    profileCalculationRevision: profile.profileCalculationRevision,
    evidenceWatermarkVersion: profile.evidenceWatermarkVersion,
    evidenceObservedAt: profile.evidenceObservedAt,
    evidenceSourceCount: profile.evidenceSourceCount,
    evidenceFingerprint: profile.evidenceFingerprint,
  });
  assert.deepEqual(vector(withExcludedSources), vector(baseline));
  assert.equal(withExcludedSources.evidenceCount, baseline.evidenceCount);
});

test('evidence matching validates revision, count, time and fingerprint as one vector', () => {
  const sources = { attempts: [{
    id: '71563fb2-9d76-4de1-ae70-b9a014792ed1', module: 'grammar', activity: 'grammar_19_24',
    score: 4, max_score: 5, evidence_quality: 'server_verified_unassisted',
    created_at: '2026-08-04T08:00:00.000Z',
  }] };
  const profile = buildAdaptiveLearningProfile(sources);
  assert.equal(adaptiveProfileMatchesCurrentEvidence(profile, sources), true);
  for (const changed of [
    { profileCalculationRevision: profile.profileCalculationRevision + 1 },
    { evidenceSourceCount: profile.evidenceSourceCount + 1 },
    { evidenceObservedAt: '2026-08-04T08:00:01.000Z' },
    { evidenceFingerprint: 'f'.repeat(64) },
  ]) {
    assert.equal(adaptiveProfileMatchesCurrentEvidence({ ...profile, ...changed }, sources), false);
  }
});

test('canonical evidence hashing gives Date, ISO, epoch milliseconds and seconds one identity', () => {
  const instant = new Date('2026-08-04T08:00:00.000Z');
  const event = (createdAt) => ({ attempts: [{
    id: '71563fb2-9d76-4de1-ae70-b9a014792ed1', module: 'grammar', activity: 'grammar_19_24',
    score: 4, max_score: 5, evidence_quality: 'server_verified_unassisted', created_at: createdAt,
  }] });
  const profiles = [
    instant,
    instant.toISOString(),
    instant.getTime(),
    instant.getTime() / 1_000,
  ].map((value) => buildAdaptiveLearningProfile(event(value)));
  assert.deepEqual(new Set(profiles.map((profile) => profile.evidenceFingerprint)).size, 1,
    'file epoch and PostgreSQL Date/ISO values must hash identically');
  assert.deepEqual(new Set(profiles.map((profile) => profile.evidenceObservedAt)).size, 1);
});

test('malformed numeric and boolean evidence is absent from the complete watermark vector', () => {
  const timestamp = '2026-08-04T08:00:00.000Z';
  const malformedAttempts = [null, undefined, '', '4', true].flatMap((score, index) => ([{
    id: `bad-score-${index}`, module: 'grammar', activity: 'grammar_19_24',
    score, max_score: 5, evidence_quality: 'server_verified_unassisted', created_at: timestamp,
  }, {
    id: `bad-max-${index}`, module: 'grammar', activity: 'grammar_19_24',
    score: 4, max_score: score, evidence_quality: 'server_verified_unassisted', created_at: timestamp,
  }]));
  const malformedRecoveries = [null, undefined, '', 'false', 0].map((flag, index) => ({
    id: `bad-recovery-${index}`, module: 'grammar', skill_id: 'ege.grammar.forms',
    initial_micro_check_passed: flag, initial_transfer_passed: false,
    terminal_outcome: 'resolved', observed_at: timestamp,
  }));
  const empty = buildAdaptiveLearningProfile();
  const malformed = buildAdaptiveLearningProfile({
    attempts: malformedAttempts,
    recoveries: malformedRecoveries,
  });
  const vector = (profile) => ({
    evidenceSourceCount: profile.evidenceSourceCount,
    evidenceObservedAt: profile.evidenceObservedAt,
    evidenceFingerprint: profile.evidenceFingerprint,
    evidenceCount: profile.evidenceCount,
  });
  assert.deepEqual(vector(malformed), vector(empty));
});

function testAuthentication() {
  return {
    auth(req, res, next) {
      const username = String(req.headers['x-test-user'] || '');
      if (!username) return res.status(401).json({ error: { code: 'AUTH_REQUIRED' } });
      req.user = username;
      next();
    },
  };
}

async function withAdaptiveApp(run, { enabled = true } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-adaptive-'));
  const file = path.join(directory, 'data.json');
  const repository = createFileRepository(file);
  const owner = await repository.createTelegramUser(8201, 'Adaptive Owner');
  const stranger = await repository.createTelegramUser(8202, 'Adaptive Stranger');
  await repository.recordModuleAttempt(owner, {
    id: OWNER_ATTEMPT_ID,
    module: 'exam',
    activity: 'grammar_19_24',
    score: 4,
    maxScore: 5,
    durationMs: 120_000,
    metadata: { source: 'builtin' },
  });
  await repository.recordModuleAttempt(stranger, {
    id: STRANGER_ATTEMPT_ID,
    module: 'listening',
    activity: 'listening_detail',
    score: 0,
    maxScore: 5,
    durationMs: 120_000,
    metadata: { source: 'builtin' },
  });

  const app = express();
  app.use(express.json());
  app.use(createProgressRoutes({ authentication: testAuthentication(), db: repository, now: () => NOW }));
  app.use(createAdaptiveLearningRoutes({
    authentication: testAuthentication(),
    db: repository,
    executionTokenSecret: 'adaptive-test-token-secret-32-characters',
    now: () => NOW,
    enabled,
  }));
  app.use((error, req, res, next) => {
    res.status(500).json({ error: { code: error.code || error.message || 'INTERNAL_ERROR' } });
  });
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const request = (username, pathname, options = {}) => fetch(
    `http://127.0.0.1:${server.address().port}${pathname}`,
    {
      ...options,
      body: pathname === '/api/v1/module-attempts' && options.body
        ? JSON.stringify({ owner: username, ...JSON.parse(options.body) }) : options.body,
      headers: {
        'Content-Type': 'application/json',
        ...(username ? { 'X-Test-User': username, 'X-EasyBoost-Expected-Owner': username } : {}),
        ...(options.headers || {}),
      },
    },
  );

  try { await run({ repository, owner, stranger, request, file }); }
  finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('versioned EGE taxonomy covers six modules and assisted recovery is not mastery proof', () => {
  assert.equal(EGE_SKILL_TAXONOMY.version, 'ege-en-v2');
  assert.deepEqual(
    [...new Set(EGE_SKILL_TAXONOMY.skills.map((skill) => skill.module))].sort(),
    ['grammar', 'listening', 'reading', 'speaking', 'vocabulary', 'writing'],
  );

  const profile = buildAdaptiveLearningProfile({
    attempts: [{
      id: OWNER_ATTEMPT_ID,
      module: 'grammar',
      activity: 'grammar_19_24',
      score: 4,
      max_score: 5,
      evidence_quality: 'server_verified_unassisted',
      created_at: NOW.toISOString(),
    }],
    recoveries: [{
      id: '56864086-e5de-4d67-89d8-742e897728cd',
      skill_id: 'ege.grammar.forms',
      module: 'grammar',
      initial_micro_check_passed: true,
      initial_transfer_passed: false,
      terminal_outcome: 'resolved',
      observed_at: NOW.toISOString(),
    }],
    repeatAttempts: [],
  });

  const grammar = profile.skills.find((skill) => skill.id === 'ege.grammar.forms');
  assert.deepEqual(
    {
      mastery: grammar.mastery,
      uncertainty: grammar.uncertainty,
      evidenceCount: grammar.evidenceCount,
      explanationCode: grammar.explanationCode,
    },
    { mastery: 80, uncertainty: 86, evidenceCount: 2, explanationCode: 'mixed_with_assistance' },
  );
  assert.equal(profile.preliminary, true);
  assert.equal(profile.confidence, 1);
  assert.equal(profile.weightingVersion, 'adaptive-evidence-v2');
  assert.equal(profile.profileCalculationRevision, ADAPTIVE_PROFILE_CALCULATION_REVISION);
  assert.equal(profile.evidenceWatermarkVersion, 'adaptive-evidence-watermark-v1');
  assert.equal(profile.evidenceObservedAt, NOW.toISOString());
  assert.equal(profile.evidenceSourceCount, 2);
  assert.equal(profile.independentEvidenceCount, 1);
  assert.equal(profile.assistedEvidenceCount, 1);
  assert.equal(grammar.independentEvidenceCount, 1);
  assert.equal(grammar.evidenceQuality, 'mixed');
});

test('assisted-only histories never establish mastery while genuine retention evidence can', () => {
  const recoveries = EGE_SKILL_TAXONOMY.skills.flatMap((skill) => Array.from({ length: 13 }, (_, index) => ({
    id: crypto.randomUUID(),
    skill_id: skill.id,
    module: skill.module,
    initial_micro_check_passed: true,
    initial_transfer_passed: true,
    terminal_outcome: 'resolved',
    observed_at: new Date(NOW.getTime() + index * 1_000).toISOString(),
  })));
  const assistedOnly = buildAdaptiveLearningProfile({ recoveries });
  assert.equal(assistedOnly.confidence, 0);
  assert.equal(assistedOnly.evidenceCount, recoveries.length);
  assert.equal(assistedOnly.independentEvidenceCount, 0);
  assert.equal(assistedOnly.assistedEvidenceCount, recoveries.length);
  assert.equal(assistedOnly.preliminary, true);
  assert.equal(assistedOnly.status, 'preliminary');
  assert.ok(assistedOnly.explanationCodes.includes('insufficient_independent_evidence'));

  const repeatAttempts = EGE_SKILL_TAXONOMY.skills.flatMap((skill) => Array.from({ length: 4 }, (_, index) => ({
    id: crypto.randomUUID(),
    skill_id: skill.id,
    module: skill.module,
    passed: true,
    observed_at: new Date(NOW.getTime() + index * 86_400_000).toISOString(),
  })));
  const retentionBacked = buildAdaptiveLearningProfile({ repeatAttempts });
  assert.equal(retentionBacked.independentEvidenceCount, repeatAttempts.length);
  assert.equal(retentionBacked.assistedEvidenceCount, 0);
  assert.equal(retentionBacked.preliminary, false);
  assert.equal(retentionBacked.status, 'established');
});

test('positive assisted evidence stays observable but cannot raise mastery or weaken the plan priority', () => {
  const independentFailure = {
    id: crypto.randomUUID(), module: 'grammar', activity: 'grammar_19_24',
    score: 0, max_score: 10, evidence_quality: 'server_verified_unassisted',
    created_at: NOW.toISOString(),
  };
  const assistedSuccess = {
    id: crypto.randomUUID(), module: 'grammar', activity: 'grammar_19_24',
    score: 10, max_score: 10, evidence_quality: 'server_verified_assisted',
    created_at: new Date(NOW.getTime() + 1_000).toISOString(),
  };
  const baseline = buildAdaptiveLearningProfile({ attempts: [independentFailure] });
  const withHelp = buildAdaptiveLearningProfile({ attempts: [independentFailure, assistedSuccess] });
  const forms = (profile) => profile.skills.find((skill) => skill.id === 'ege.grammar.forms');
  assert.equal(forms(baseline).mastery, 0);
  assert.equal(forms(withHelp).mastery, 0);
  assert.equal(forms(withHelp).evidenceCount, 2);
  assert.equal(withHelp.assistedEvidenceCount, 1);
  assert.equal(withHelp.evidenceSourceCount, 2,
    'assisted evidence must remain in the append-only watermark');

  const planningGoal = {
    id: '61000000-0000-4000-8000-000000000001', target_exam: 'ege_english',
    target_score: 85, exam_date: '2027-06-01', weekly_minutes: 300, revision: 1,
  };
  const baselinePlan = buildAdaptiveLearningPlan({ goal: planningGoal, profile: baseline, now: NOW });
  const assistedPlan = buildAdaptiveLearningPlan({ goal: planningGoal, profile: withHelp, now: NOW });
  const formsAllocation = (plan) => plan.allocation.skills.find((skill) => (
    skill.id === 'ege.grammar.forms'
  ));
  assert.equal(formsAllocation(assistedPlan).percentage, formsAllocation(baselinePlan).percentage);
  assert.deepEqual(formsAllocation(assistedPlan).reasonCodes, formsAllocation(baselinePlan).reasonCodes);
});

test('short diagnostic productive choices stay preliminary and cannot create Free productive mastery', () => {
  const productiveItems = SHORT_DIAGNOSTIC_CATALOG.items.filter((item) => (
    item.module === 'writing' || item.module === 'speaking'
  ));
  assert.deepEqual(
    [...new Set(productiveItems.map((item) => item.skillId))].sort(),
    EGE_SKILL_TAXONOMY.skills
      .filter((skill) => skill.module === 'writing' || skill.module === 'speaking')
      .map((skill) => skill.id).sort(),
  );
  assert.ok(productiveItems.every((item) => item.evidenceQuality === 'assisted'));
  const profile = buildAdaptiveLearningProfile({
    diagnosticResponses: productiveItems.map((item, index) => ({
      catalog_version: SHORT_DIAGNOSTIC_CATALOG.version,
      item_id: item.id,
      skill_id: item.skillId,
      module: item.module,
      evidence_quality: item.evidenceQuality,
      correct: true,
      answered_at: new Date(NOW.getTime() + index * 1_000).toISOString(),
    })),
    diagnosticCompletions: [{
      catalog_version: SHORT_DIAGNOSTIC_CATALOG.version,
      completed_at: NOW.toISOString(),
    }],
  });
  const productive = profile.skills.filter((skill) => (
    skill.module === 'writing' || skill.module === 'speaking'
  ));
  assert.ok(productive.every((skill) => skill.independentEvidenceCount === 0));
  assert.ok(productive.every((skill) => skill.status === 'preliminary'));
  assert.equal(profile.independentEvidenceCount, 0);
});

test('Speaking diagnostic copy points to the real assessment available in the Speaking section, not Premium-only proof', () => {
  const speakingItems = SHORT_DIAGNOSTIC_CATALOG.items.filter((item) => item.module === 'speaking');
  assert.ok(speakingItems.length > 0);
  assert.ok(speakingItems.every((item) => item.measurementNotice.includes('разделе «Говорение»')));
  assert.ok(speakingItems.every((item) => !item.measurementNotice.includes('Premium-проверкой')));
});

test('saved v1 Speaking diagnostic history maps through compatibility without changing the old response', () => {
  const profile = buildAdaptiveLearningProfile({
    diagnosticResponses: [{
      id: crypto.randomUUID(),
      catalog_version: 'ege-short-diagnostic-v1',
      item_id: 'speaking-interaction-follow-up-1',
      skill_id: 'ege.speaking.interaction',
      module: 'speaking',
      evidence_quality: 'assisted',
      correct: true,
      answered_at: NOW.toISOString(),
    }],
    diagnosticCompletions: [{
      catalog_version: 'ege-short-diagnostic-v1', completed_at: NOW.toISOString(),
    }],
  });
  const directQuestions = profile.skills.find((skill) => (
    skill.id === 'ege.speaking.direct_questions'
  ));
  assert.equal(profile.evidenceCount, 1);
  assert.equal(profile.assistedEvidenceCount, 1);
  assert.equal(directQuestions.evidenceCount, 1);
  assert.equal(directQuestions.mastery, 0);
});

test('deep diagnostic recognition without audio or productive work remains assisted', () => {
  const indirectItems = DEEP_DIAGNOSTIC_CATALOG.items.filter((item) => (
    ['listening', 'writing', 'speaking'].includes(item.module)
  ));
  assert.equal(indirectItems.length, 12 + EGE_SKILL_TAXONOMY.skills
    .filter((skill) => skill.module === 'speaking').length);
  assert.ok(indirectItems.every((item) => item.evidenceQuality === 'assisted'));
  assert.ok(indirectItems.every((item) => item.measurementNotice));
});

test('repeating the same diagnostic item is useful but never adds a second strong observation', () => {
  const item = SHORT_DIAGNOSTIC_CATALOG.items.find((candidate) => (
    candidate.id === 'grammar-forms-present-perfect-1'
  ));
  const response = (answeredAt) => ({
    catalog_version: SHORT_DIAGNOSTIC_CATALOG.version,
    item_id: item.id,
    skill_id: item.skillId,
    module: item.module,
    evidence_quality: item.evidenceQuality,
    correct: true,
    answered_at: answeredAt,
  });
  const profile = buildAdaptiveLearningProfile({
    diagnosticResponses: [
      response(NOW.toISOString()),
      response(new Date(NOW.getTime() + 35 * 24 * 60 * 60_000).toISOString()),
    ],
    diagnosticCompletions: [
      { catalog_version: SHORT_DIAGNOSTIC_CATALOG.version, completed_at: NOW.toISOString() },
    ],
  });
  const grammar = profile.skills.find((skill) => skill.id === item.skillId);
  assert.equal(grammar.evidenceCount, 2);
  assert.equal(grammar.independentEvidenceCount, 1);
  assert.equal(grammar.status, 'preliminary');
  assert.equal(grammar.explanationCode, 'repeated_diagnostic_item');
  assert.equal(profile.independentEvidenceCount, 1);
});

test('the same question copied into short and deep catalogs stays one strong observation', () => {
  const shortItem = SHORT_DIAGNOSTIC_CATALOG.items.find((candidate) => (
    candidate.id === 'grammar-forms-present-perfect-1'
  ));
  const deepItem = DEEP_DIAGNOSTIC_CATALOG.items.find((candidate) => candidate.id === shortItem.id);
  const profile = buildAdaptiveLearningProfile({
    diagnosticResponses: [
      {
        catalog_version: SHORT_DIAGNOSTIC_CATALOG.version,
        item_id: shortItem.id,
        skill_id: shortItem.skillId,
        module: shortItem.module,
        evidence_quality: shortItem.evidenceQuality,
        correct: true,
        answered_at: NOW.toISOString(),
      },
      {
        catalog_version: DEEP_DIAGNOSTIC_CATALOG.version,
        item_id: deepItem.id,
        skill_id: deepItem.skillId,
        module: deepItem.module,
        evidence_quality: deepItem.evidenceQuality,
        correct: true,
        answered_at: new Date(NOW.getTime() + 60_000).toISOString(),
      },
    ],
    diagnosticCompletions: [
      { catalog_version: SHORT_DIAGNOSTIC_CATALOG.version, completed_at: NOW.toISOString() },
      { catalog_version: DEEP_DIAGNOSTIC_CATALOG.version, completed_at: new Date(NOW.getTime() + 60_000).toISOString() },
    ],
  });
  const grammar = profile.skills.find((skill) => skill.id === shortItem.skillId);
  assert.equal(grammar.evidenceCount, 2);
  assert.equal(grammar.independentEvidenceCount, 1);
  assert.equal(grammar.status, 'preliminary');
  assert.equal(grammar.explanationCode, 'repeated_diagnostic_item');
});

test('mixed trust never presents assisted-only skills or the whole profile as established', () => {
  const independentActivities = [
    ['grammar', 'grammar_19_24'],
    ['grammar', 'grammar_25_29'],
    ['reading', 'reading_gist'],
    ['reading', 'reading_detail'],
    ['listening', 'listening_gist'],
    ['listening', 'listening_detail'],
  ];
  const attempts = independentActivities.flatMap(([module, activity]) => Array.from({ length: 4 }, () => ({
    id: crypto.randomUUID(), module, activity, score: 9, max_score: 10,
    evidence_quality: 'server_verified_unassisted', created_at: NOW.toISOString(),
  })));
  const assistedSkills = EGE_SKILL_TAXONOMY.skills
    .filter((skill) => ['vocabulary', 'writing', 'speaking'].includes(skill.module));
  const recoveries = assistedSkills.flatMap((skill) => Array.from({ length: 13 }, () => ({
    id: crypto.randomUUID(), skill_id: skill.id, module: skill.module,
    initial_micro_check_passed: true, initial_transfer_passed: true,
    terminal_outcome: 'resolved', observed_at: NOW.toISOString(),
  })));

  const profile = buildAdaptiveLearningProfile({ attempts, recoveries });
  assert.ok(profile.confidence <= 50);
  assert.equal(profile.independentEvidenceCount, 24);
  assert.equal(profile.independentModuleCount, 3);
  assert.equal(profile.establishedSkillCount, 6);
  assert.equal(profile.preliminary, true);
  assert.equal(profile.status, 'preliminary');
  assert.ok(profile.explanationCodes.includes('unconfirmed_skills'));
  for (const skill of profile.skills.filter((item) => assistedSkills.some((candidate) => candidate.id === item.id))) {
    assert.equal(skill.status, 'preliminary');
    assert.equal(skill.independentEvidenceCount, 0);
    assert.ok(skill.mastery <= 49, `${skill.id} assisted mastery must stay conservative`);
    assert.ok(skill.uncertainty >= 70, `${skill.id} assisted uncertainty must stay explicit`);
  }
  for (const skill of profile.skills.filter((item) => ['grammar', 'reading', 'listening'].includes(item.module))) {
    assert.equal(skill.status, 'established');
  }
});

test('activity mapping is exact, most-specific and covers every versioned taxonomy skill', () => {
  const activities = new Map([
    ['ege.vocabulary.lexical_choice', ['vocabulary', 'lexical_choice']],
    ['ege.vocabulary.word_formation', ['vocabulary', 'word_formation']],
    ['ege.grammar.forms', ['grammar', 'grammar_19_24']],
    ['ege.grammar.transformations', ['grammar', 'ege.grammar.transformations']],
    ['ege.reading.gist', ['reading', 'reading_gist']],
    ['ege.reading.detail', ['reading', 'reading_detail']],
    ['ege.listening.gist', ['listening', 'listening_gist']],
    ['ege.listening.detail', ['listening', 'listening_detail']],
    ['ege.writing.email', ['writing', 'writing_37']],
    ['ege.writing.essay', ['writing', 'writing_38']],
    ['ege.speaking.reading_aloud', ['speaking', 'speaking_1']],
    ['ege.speaking.direct_questions', ['speaking', 'speaking_2']],
    ['ege.speaking.interview_completeness', ['speaking', 'speaking_3']],
    ['ege.speaking.monologue_content', ['speaking', 'speaking_4']],
    ['ege.speaking.monologue_organization', ['speaking', 'speaking_4_organization']],
    ['ege.speaking.spoken_grammar', ['speaking', 'speaking_4_grammar']],
    ['ege.speaking.spoken_lexis', ['speaking', 'speaking_4_lexis']],
    ['ege.speaking.fluency', ['speaking', 'speaking_1_fluency']],
    ['ege.speaking.pronunciation_words', ['speaking', 'speaking_1_words']],
    ['ege.speaking.pronunciation_phonemes', ['speaking', 'speaking_1_phonemes']],
    ['ege.speaking.signal_quality', ['speaking', 'speaking_1_signal']],
  ]);
  const attempts = [...activities].map(([skillId, [module, activity]]) => ({
    id: crypto.randomUUID(), module, activity, score: 1, max_score: 1,
    evidence_quality: ['writing', 'speaking'].includes(module)
      ? 'server_verified_assisted'
      : 'client_reported',
    created_at: NOW.toISOString(), skillId,
  }));
  const profile = buildAdaptiveLearningProfile({ attempts });
  for (const skill of EGE_SKILL_TAXONOMY.skills) {
    assert.equal(profile.skills.find((item) => item.id === skill.id).evidenceCount, 1, skill.id);
  }

  const grammarForms = EGE_SKILL_TAXONOMY.skills.find((skill) => skill.id === 'ege.grammar.forms');
  const grammarTransformations = EGE_SKILL_TAXONOMY.skills.find((skill) => skill.id === 'ege.grammar.transformations');
  for (let topic = 1; topic <= 20; topic += 1) {
    const activity = topic === 18 ? 'grammar_transformations_topic_18' : `grammar_forms_topic_${topic}`;
    const expected = topic === 18 ? grammarTransformations : grammarForms;
    assert.ok(expected.activityIds.includes(activity), `${activity} must be explicitly taxonomized`);
  }
  assert.ok(grammarForms.activityIds.includes('grammar_forms_review'));
  assert.ok(grammarTransformations.activityIds.includes('grammar_transformations_review'));

  const executableActivities = [
    ['vocabulary', 'vocabulary_lexical_choice_topic_1', 'ege.vocabulary.lexical_choice'],
    ['grammar', 'grammar_forms_topic_4', 'ege.grammar.forms'],
    ['grammar', 'grammar_transformations_topic_18', 'ege.grammar.transformations'],
    ['reading', 'reading_headings', 'ege.reading.gist'],
    ['reading', 'reading_gaps', 'ege.reading.detail'],
    ['reading', 'reading_detail', 'ege.reading.detail'],
    ['listening', 'listening_matching', 'ege.listening.gist'],
    ['listening', 'listening_true_false', 'ege.listening.detail'],
    ['listening', 'listening_interview', 'ege.listening.detail'],
  ];
  for (const [module, activity, expectedSkill] of executableActivities) {
    const executableProfile = buildAdaptiveLearningProfile({ attempts: [{
      id: crypto.randomUUID(), module, activity, score: 1, max_score: 1,
      evidence_quality: 'client_reported', created_at: NOW.toISOString(),
    }] });
    assert.equal(executableProfile.skills.find((item) => item.id === expectedSkill).evidenceCount, 1);
  }

  const fallback = buildAdaptiveLearningProfile({ attempts: [
    { id: crypto.randomUUID(), module: 'grammar', activity: 'legacy_unknown', score: 1, max_score: 1 },
    { id: crypto.randomUUID(), module: 'exam', activity: 'legacy_unknown', score: 1, max_score: 1 },
  ] });
  assert.equal(fallback.skills.find((skill) => skill.id === 'ege.grammar.forms').evidenceCount, 1);
  assert.equal(fallback.evidenceCount, 1, 'unknown exam activity is intentionally ignored');
});

test('legacy client-reported writing and speaking rows cannot influence the adaptive profile', () => {
  const attempts = [
    { id: crypto.randomUUID(), module: 'writing', activity: 'writing_37', score: 100, max_score: 100, evidence_quality: 'client_reported', created_at: '2026-08-04T08:00:00.000Z' },
    { id: crypto.randomUUID(), module: 'speaking', activity: 'speaking_4', score: 100, max_score: 100, evidence_quality: 'client_reported', created_at: '2026-08-04T08:01:00.000Z' },
    { id: crypto.randomUUID(), module: 'writing', activity: 'writing_37', score: 4, max_score: 5, evidence_quality: 'server_verified_assisted', created_at: '2026-08-04T08:02:00.000Z' },
    { id: crypto.randomUUID(), module: 'speaking', activity: 'speaking_4', score: 3, max_score: 5, evidence_quality: 'server_verified_assisted', created_at: '2026-08-04T08:03:00.000Z' },
    { id: crypto.randomUUID(), module: 'grammar', activity: 'grammar_19_24', score: 4, max_score: 5, evidence_quality: 'client_reported', created_at: '2026-08-04T08:04:00.000Z' },
  ];

  const profile = buildAdaptiveLearningProfile({ attempts });
  assert.equal(profile.profileCalculationRevision, ADAPTIVE_PROFILE_CALCULATION_REVISION);
  assert.equal(profile.evidenceSourceCount, 3);
  assert.equal(profile.evidenceCount, 3);
  assert.equal(profile.clientReportedEvidenceCount, 1);
  assert.equal(profile.assistedEvidenceCount, 2);
  assert.equal(profile.modules.find((module) => module.id === 'writing').evidenceCount, 1);
  assert.equal(profile.modules.find((module) => module.id === 'speaking').evidenceCount, 1);
});

test('ordinary module-attempt API rejects productive client evidence for every owner', async () => {
  await withAdaptiveApp(async ({ repository, owner, stranger, request }) => {
    for (const [username, module, activity] of [
      [owner, 'writing', 'writing_37'],
      [stranger, 'speaking', 'speaking_4'],
    ]) {
      const response = await request(username, '/api/v1/module-attempts', {
        method: 'POST',
        body: JSON.stringify({
          id: crypto.randomUUID(), module, activity, score: 100, maxScore: 100,
          durationMs: 60_000, metadata: {},
        }),
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, 'SERVER_ASSESSMENT_REQUIRED');
    }

    const ownerSources = await repository.getAdaptiveLearningEvidenceSources(owner);
    const strangerSources = await repository.getAdaptiveLearningEvidenceSources(stranger);
    assert.equal(ownerSources.attempts.some((attempt) => attempt.module === 'writing'), false);
    assert.equal(strangerSources.attempts.some((attempt) => attempt.module === 'speaking'), false);
  });
});

test('production Voice Tutor recovery skill families map to the intended adaptive skills', () => {
  const productionRecoveries = [
    ['grammar', 'ege.grammar.past_simple', 'ege.grammar.forms'],
    ['grammar', 'ege.grammar.topic_12', 'ege.grammar.forms'],
    ['grammar', 'ege.grammar.generated_0123456789abcdef', 'ege.grammar.forms'],
    ['grammar', 'ege.word_formation.topic_16', 'ege.vocabulary.word_formation'],
    ['grammar', 'ege.collocation.topic_15', 'ege.vocabulary.lexical_choice'],
    ['vocabulary', 'ege.vocabulary.meaning_in_context', 'ege.vocabulary.lexical_choice'],
    ['vocabulary', 'ege.vocabulary.lexeme_42', 'ege.vocabulary.lexical_choice'],
    ['vocabulary', 'ege.vocabulary.generated_0123456789abcdef', 'ege.vocabulary.lexical_choice'],
    ['vocabulary', 'ege.collocation.lexeme_42', 'ege.vocabulary.lexical_choice'],
    ['vocabulary', 'ege.collocation.generated_0123456789abcdef', 'ege.vocabulary.lexical_choice'],
    ['reading', 'ege.reading.evidence', 'ege.reading.detail'],
    ['listening', 'ege.listening.evidence', 'ege.listening.detail'],
    ['writing', 'ege.writing.writing_37.criterion.1', 'ege.writing.email'],
    ['writing', 'ege.writing.email.criterion.2', 'ege.writing.email'],
    ['writing', 'ege.writing.writing_38.criterion.5', 'ege.writing.essay'],
    ['writing', 'ege.writing.essay.criterion.1', 'ege.writing.essay'],
    ['speaking', 'ege.speaking.1.criterion.1', 'ege.speaking.reading_aloud'],
    ['speaking', 'ege.speaking.2.criterion.4', 'ege.speaking.direct_questions'],
    ['speaking', 'ege.speaking.3.criterion.5', 'ege.speaking.interview_completeness'],
    ['speaking', 'ege.speaking.4.criterion.1', 'ege.speaking.monologue_content'],
    ['speaking', 'ege.speaking.4.criterion.2', 'ege.speaking.monologue_organization'],
  ];

  for (const [module, skillId, expectedAdaptiveSkill] of productionRecoveries) {
    const profile = buildAdaptiveLearningProfile({ recoveries: [{
      id: crypto.randomUUID(), module, skill_id: skillId,
      initial_micro_check_passed: true, initial_transfer_passed: true,
      terminal_outcome: 'resolved', observed_at: NOW.toISOString(),
    }] });
    const credited = profile.skills.filter((skill) => skill.evidenceCount > 0);
    assert.deepEqual(credited.map((skill) => skill.id), [expectedAdaptiveSkill], skillId);
    assert.equal(credited[0].evidenceQuality, 'assisted');
    assert.equal(credited[0].status, 'preliminary');
    assert.ok(credited[0].mastery <= 49);
    assert.equal(credited[0].uncertainty, 100);
  }

  const combinedLanguageCriterion = buildAdaptiveLearningProfile({ recoveries: [{
    id: crypto.randomUUID(), module: 'speaking', skill_id: 'ege.speaking.4.criterion.3',
    initial_micro_check_passed: true, initial_transfer_passed: true,
    terminal_outcome: 'resolved', observed_at: NOW.toISOString(),
  }] });
  assert.equal(combinedLanguageCriterion.evidenceCount, 0,
    'the combined official language criterion cannot establish grammar or lexis without a split');
  assert.equal(ADAPTIVE_PROFILE_CALCULATION_REVISION, 4,
    'assisted zero-weight semantics must outrank older persisted snapshots');

  const mismatchedKnownFamily = buildAdaptiveLearningProfile({ recoveries: [{
    id: crypto.randomUUID(), module: 'grammar', skill_id: 'ege.writing.essay.criterion.1',
    terminal_outcome: 'resolved', observed_at: NOW.toISOString(),
  }] });
  assert.equal(mismatchedKnownFamily.evidenceCount, 0, 'known families never fall through to an unrelated module');

  const unknownLegacyFamily = buildAdaptiveLearningProfile({ recoveries: [{
    id: crypto.randomUUID(), module: 'reading', skill_id: 'legacy.reading.custom',
    terminal_outcome: 'resolved', observed_at: NOW.toISOString(),
  }] });
  assert.equal(unknownLegacyFamily.evidenceCount, 0, 'unknown recovery is not a concrete micro-skill');

  const unknownPassedRepeat = buildAdaptiveLearningProfile({ repeatAttempts: [{
    id: crypto.randomUUID(), module: 'reading', skill_id: 'legacy.reading.custom',
    passed: true, observed_at: NOW.toISOString(),
  }] });
  assert.equal(unknownPassedRepeat.evidenceCount, 0);
  assert.equal(unknownPassedRepeat.independentEvidenceCount, 0);
  assert.equal(unknownPassedRepeat.establishedSkillCount, 0);
});

test('Voice Tutor service attempts do not double-credit a module default beside the exact recovery skill', () => {
  const profile = buildAdaptiveLearningProfile({
    attempts: [{
      id: crypto.randomUUID(),
      module: 'grammar',
      activity: 'voice_tutor_error',
      score: 0,
      max_score: 1,
      evidence_quality: 'server_verified_assisted',
      created_at: '2026-08-04T08:00:00.000Z',
    }],
    recoveries: [{
      id: crypto.randomUUID(),
      module: 'grammar',
      skill_id: 'ege.word_formation.topic_16',
      initial_micro_check_passed: true,
      initial_transfer_passed: true,
      terminal_outcome: 'resolved',
      observed_at: '2026-08-04T08:01:00.000Z',
    }],
  });

  assert.equal(profile.evidenceSourceCount, 1, 'unsupported service rows are outside the canonical watermark');
  assert.equal(profile.evidenceCount, 1, 'only the exact recovery supplies adaptive evidence');
  assert.equal(profile.skills.find((skill) => skill.id === 'ege.grammar.forms').evidenceCount, 0);
  assert.equal(profile.skills.find((skill) => skill.id === 'ege.vocabulary.word_formation').evidenceCount, 1);
});

test('many forged public module attempts remain useful but cannot establish a profile', async () => {
  await withAdaptiveApp(async ({ repository, owner, request }) => {
    const activities = EGE_SKILL_TAXONOMY.skills.map((skill) => ({
      module: skill.module,
      activity: skill.id,
    }));
    for (let round = 0; round < 10; round += 1) {
      for (const activity of activities) {
        const response = await request(owner, '/api/v1/module-attempts', {
          method: 'POST',
          body: JSON.stringify({
            id: crypto.randomUUID(),
            ...activity,
            score: 100,
            maxScore: 100,
            durationMs: 60_000,
            metadata: { source: 'server_verified_unassisted' },
          }),
        });
        assert.equal(response.status, ['writing', 'speaking'].includes(activity.module) ? 400 : 201);
        if (['writing', 'speaking'].includes(activity.module)) {
          assert.equal((await response.json()).error.code, 'SERVER_ASSESSMENT_REQUIRED');
        }
      }
    }

    const sources = await repository.getAdaptiveLearningEvidenceSources(owner);
    assert.equal(sources.attempts.filter((attempt) => attempt.evidence_quality === 'client_reported').length, 81);
    assert.equal(sources.attempts.some((attempt) => attempt.evidence_quality === 'server_verified_unassisted'), false);
    const overview = await (await request(owner, '/api/v1/adaptive-learning/overview')).json();
    assert.equal(overview.profile.clientReportedEvidenceCount, 81);
    assert.equal(overview.profile.independentEvidenceCount, 0);
    assert.equal(overview.profile.evidenceCount, 81);
    assert.equal(overview.profile.preliminary, true);
    assert.equal(overview.profile.status, 'preliminary');
    assert.ok(overview.profile.confidence <= 15);
    for (const skill of overview.profile.skills.filter((item) => item.evidenceCount > 0)) {
      assert.equal(skill.status, 'preliminary');
      assert.ok(skill.mastery <= 49);
      assert.ok(skill.uncertainty >= 85);
    }
    assert.ok(overview.profile.skills.some((skill) => skill.mastery > 0), 'unverified history may guide diagnostics');
  });
});

test('disabled plan rollout keeps the owner-bound evidence overview but no plan or mutation routes', async () => {
  await withAdaptiveApp(async ({ owner, stranger, request }) => {
    assert.equal((await request(owner, '/api/v1/adaptive-learning/goal')).status, 404);
    const response = await request(owner, '/api/v1/adaptive-learning/overview');
    assert.equal(response.status, 200);
    const ownerOverview = await response.json();
    assert.equal(ownerOverview.goal, null);
    assert.equal(ownerOverview.plan, null);
    assert.equal(ownerOverview.profile.evidenceCount, 1);
    assert.equal(ownerOverview.profile.modules.find((module) => module.id === 'grammar').evidenceCount, 1);
    assert.equal(ownerOverview.profile.modules.find((module) => module.id === 'listening').evidenceCount, 0);

    const strangerOverview = await (await request(stranger, '/api/v1/adaptive-learning/overview')).json();
    assert.equal(strangerOverview.profile.evidenceCount, 1);
    assert.equal(strangerOverview.profile.modules.find((module) => module.id === 'grammar').evidenceCount, 0);
    assert.equal(strangerOverview.profile.modules.find((module) => module.id === 'listening').evidenceCount, 1);
  }, { enabled: false });
});

test('adaptive overview exposes a safe owner-bound full-mock dashboard projection', async () => {
  await withAdaptiveApp(async ({ repository, owner, stranger, request }) => {
    repository.getEgeMockHistory = async (username) => username === owner ? {
      baselineAttemptId: '11111111-1111-4111-8111-111111111111',
      attempts: [{
        id: '11111111-1111-4111-8111-111111111111', isBaseline: true,
        result: {
          score: { primaryTotal: null, maximum: 82, range: { minimum: 40, maximum: 80 } },
          forecast: {
            policyId: 'ege-mock-forecast-2026-v1', label: 'Прогноз тестового балла',
            score: null, range: { minimum: 49, maximum: 98 },
            disclaimer: 'Ориентировочный прогноз Easy Boost, а не официальный результат ЕГЭ.',
            baselineEligible: true,
          },
        },
      }],
    } : { baselineAttemptId: null, attempts: [] };

    const ownerOverview = await (await request(owner, '/api/v1/adaptive-learning/overview')).json();
    const strangerOverview = await (await request(stranger, '/api/v1/adaptive-learning/overview')).json();

    assert.equal(ownerOverview.egeMock.baselineAttemptId,
      '11111111-1111-4111-8111-111111111111');
    assert.deepEqual(ownerOverview.egeMock.baseline.range, { minimum: 40, maximum: 80 });
    assert.equal(strangerOverview.egeMock.baseline, null);
  });
});

test('adaptive overview reconciles EGE history before reading its profile evidence snapshot', async () => {
  await withAdaptiveApp(async ({ repository, owner, request }) => {
    const getSources = repository.getAdaptiveLearningEvidenceSources.bind(repository);
    let historyReconciled = false;
    repository.getEgeMockHistory = async () => {
      historyReconciled = true;
      return { baselineAttemptId: null, attempts: [] };
    };
    repository.getAdaptiveLearningEvidenceSources = async (...args) => {
      assert.equal(historyReconciled, true,
        'the profile snapshot must start only after deadline reconciliation can commit EGE evidence');
      return getSources(...args);
    };

    const response = await request(owner, '/api/v1/adaptive-learning/overview');
    assert.equal(response.status, 200);
  });
});

test('adaptive overview exposes the same owner-bound exact grammar focus as the resolver API', async () => {
  await withAdaptiveApp(async ({ owner, stranger, request }) => {
    const goal = await request(owner, '/api/v1/adaptive-learning/goal', {
      method: 'PUT', headers: { 'Idempotency-Key': 'grammar-focus-goal-0001' },
      body: JSON.stringify({
        targetExam: 'ege_english', targetScore: 85,
        examDate: '2026-08-10', weeklyMinutes: 300,
      }),
    });
    assert.equal(goal.status, 201);

    const overview = await (await request(owner, '/api/v1/adaptive-learning/overview')).json();
    const direct = await (await request(owner, '/api/v1/grammar/recommendation')).json();
    assert.deepEqual(overview.grammarRecommendation, direct.recommendation);
    assert.equal(overview.grammarRecommendation.pointer.version, 'grammar-focus-v1');
    assert.ok(overview.grammarRecommendation.reasonCodes.includes('deadline_pressure'));
    assert.equal(Object.hasOwn(overview.grammarRecommendation.pointer, 'learnerAnswer'), false);

    const strangerOverview = await (await request(stranger, '/api/v1/adaptive-learning/overview')).json();
    assert.equal(strangerOverview.grammarRecommendation.reasonCodes.includes('deadline_pressure'), false,
      'one learner\'s exam deadline cannot leak into another learner\'s recommendation');
  });
});

test('adaptive HTTP boundary rejects a shared-cookie owner switch before returning private data', async () => {
  await withAdaptiveApp(async ({ owner, stranger, request }) => {
    const rejected = await request(stranger, '/api/v1/adaptive-learning/overview', {
      headers: { 'X-EasyBoost-Expected-Owner': owner },
    });
    assert.equal(rejected.status, 409);
    assert.equal((await rejected.json()).error.code, 'OWNER_CHANGED');

    const accepted = await request(owner, '/api/v1/adaptive-learning/overview', {
      headers: { 'X-EasyBoost-Expected-Owner': owner },
    });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get('x-easyboost-response-owner'), owner);
  });
});

test('adaptive owner boundary preserves legacy callers and binds supplied request and response owners', async () => {
  const [openapi, middleware, apiClient] = await Promise.all([
    fs.readFile(new URL('../docs/openapi.yaml', import.meta.url), 'utf8'),
    fs.readFile(new URL('../middleware/expected-owner.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/api.js', import.meta.url), 'utf8'),
  ]);
  assert.match(openapi, /ExpectedOwner:[\s\S]*name: X-EasyBoost-Expected-Owner[\s\S]*required: true/u);
  assert.match(openapi, /OptionalExpectedOwner:[\s\S]*name: X-EasyBoost-Expected-Owner[\s\S]*required: false/u);
  assert.match(openapi, /headers:\s*\n\s+X-EasyBoost-Response-Owner:/u);
  const ownerBoundPaths = [...openapi.matchAll(/^  (\/api\/v1\/(?:adaptive-learning\/[^:]+|voice-tutor\/(?:recovery-map|repeats\/\{repeatId\}\/attempts))):\s*$/gmu)];
  assert.equal(ownerBoundPaths.length, 19, 'the exact adaptive and Voice owner-bound route set is documented');
  for (let index = 0; index < ownerBoundPaths.length; index += 1) {
    const start = ownerBoundPaths[index].index;
    const nextPath = openapi.slice(start + 1).search(/^  \/api\/v1\//mu);
    const end = nextPath < 0 ? openapi.length : start + 1 + nextPath;
    const section = openapi.slice(start, end);
    const ownerParameter = ownerBoundPaths[index][1].startsWith('/api/v1/adaptive-learning/')
      ? /#\/components\/parameters\/OptionalExpectedOwner/u
      : /#\/components\/parameters\/ExpectedOwner/u;
    assert.match(section, ownerParameter,
      `${ownerBoundPaths[index][1]} must document its compatible owner boundary`);
    const successes = [...section.matchAll(/^        '(?:200|201)':([\s\S]*?)(?=^        '(?:[1-5][0-9]{2}|default)':|^  \/api\/v1\/|(?![\s\S]))/gmu)];
    for (const success of successes) {
      assert.match(success[1], /#\/components\/headers\/X-EasyBoost-Response-Owner/u,
        `${ownerBoundPaths[index][1]} success response must document its authoritative owner`);
    }
  }
  assert.match(middleware, /EXPECTED_OWNER_REQUIRED/u);
  assert.match(middleware, /function validateExpectedOwner/u);
  assert.match(middleware, /X-EasyBoost-Response-Owner/u);
  assert.match(apiClient, /x-easyboost-response-owner/u);
});

test('authenticated learner saves an idempotent goal and gets an owner-bound preliminary overview', async () => {
  await withAdaptiveApp(async ({ repository, owner, stranger, request, file }) => {
    assert.equal((await request('', '/api/v1/adaptive-learning/overview')).status, 401);

    const before = await (await request(owner, '/api/v1/adaptive-learning/overview')).json();
    assert.equal(before.goal, null);
    assert.equal(before.profile.preliminary, true);
    assert.equal(before.profile.evidenceCount, 1);
    assert.equal(before.profile.modules.find((module) => module.id === 'grammar').mastery, 49);
    assert.equal(before.profile.modules.find((module) => module.id === 'listening').evidenceCount, 0);
    assert.equal(before.profile.needsDiagnostic, true);
    assert.equal('attempts' in before.profile, false);

    const body = {
      targetExam: 'ege_english',
      targetScore: 85,
      examDate: '2027-06-01',
      weeklyMinutes: 300,
    };
    const first = await request(owner, '/api/v1/adaptive-learning/goal', {
      method: 'PUT',
      headers: { 'Idempotency-Key': 'adaptive-goal-owner-0001' },
      body: JSON.stringify(body),
    });
    assert.equal(first.status, 201);
    const created = await first.json();
    assert.equal(created.created, true);
    assert.deepEqual(
      {
        targetExam: created.goal.targetExam,
        targetScore: created.goal.targetScore,
        examDate: created.goal.examDate,
        weeklyMinutes: created.goal.weeklyMinutes,
        revision: created.goal.revision,
      },
      { ...body, revision: 1 },
    );
    assert.equal(created.profile.taxonomyVersion, 'ege-en-v2');
    assert.match(created.goal.createdAt, /^2026-08-04T/u);
    assert.match(created.goal.updatedAt, /^2026-08-04T/u);

    const replay = await request(owner, '/api/v1/adaptive-learning/goal', {
      method: 'PUT',
      headers: { 'Idempotency-Key': 'adaptive-goal-owner-0001' },
      body: JSON.stringify(body),
    });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).created, false);

    const conflict = await request(owner, '/api/v1/adaptive-learning/goal', {
      method: 'PUT',
      headers: { 'Idempotency-Key': 'adaptive-goal-owner-0001' },
      body: JSON.stringify({ ...body, targetScore: 90 }),
    });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).error.code, 'IDEMPOTENCY_CONFLICT');

    const updated = await request(owner, '/api/v1/adaptive-learning/goal', {
      method: 'PUT',
      headers: { 'Idempotency-Key': 'adaptive-goal-owner-0002' },
      body: JSON.stringify({ ...body, targetScore: 90 }),
    });
    assert.equal(updated.status, 201);
    assert.equal((await updated.json()).goal.revision, 2);
    const currentGoal = await (await request(owner, '/api/v1/adaptive-learning/goal')).json();
    assert.equal(currentGoal.goal.targetScore, 90);

    const strangerOverview = await (await request(stranger, '/api/v1/adaptive-learning/overview')).json();
    assert.equal(strangerOverview.goal, null);
    assert.equal(strangerOverview.profile.evidenceCount, 1);
    assert.equal(strangerOverview.profile.modules.find((module) => module.id === 'grammar').evidenceCount, 0);
    assert.equal(strangerOverview.profile.modules.find((module) => module.id === 'listening').mastery, 0);

    for (const invalid of [
      { ...body, examDate: '2026-08-04' },
      { ...body, extra: true },
      { ...body, weeklyMinutes: 31 },
    ]) {
      const response = await request(owner, '/api/v1/adaptive-learning/goal', {
        method: 'PUT',
        headers: { 'Idempotency-Key': `invalid-${JSON.stringify(invalid).length}-goal` },
        body: JSON.stringify(invalid),
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, 'VALIDATION_ERROR');
    }

    const exported = await repository.exportUserData(owner);
    assert.equal(exported.adaptive_learning_goals.length, 2);
    assert.equal(exported.adaptive_learning_profile.taxonomy_version, 'ege-en-v2');
    assert.equal(exported.adaptive_learning_profile.evidence_watermark_version, 'adaptive-evidence-watermark-v1');
    assert.match(exported.adaptive_learning_profile.updated_at, /^\d{4}-\d{2}-\d{2}T/u);
    assert.ok(exported.adaptive_learning_skill_estimates.every((estimate) => (
      estimate.updated_at === exported.adaptive_learning_profile.updated_at
      && (estimate.last_observed_at === null || typeof estimate.last_observed_at === 'string')
    )));
    assert.ok(exported.adaptive_learning_skill_estimates.length > 6);
    assert.equal(JSON.stringify(exported).includes(STRANGER_ATTEMPT_ID), false);

    assert.equal(await repository.deleteUserData(owner), true);
    const persisted = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(await repository.exportUserData(owner), null);
    assert.equal(persisted.adaptive_learning_goals?.some((goal) => goal.username === owner) || false, false);
  });
});

test('overview fails closed after reverse-order profile recomputation exhausts bounded retries', async () => {
  await withAdaptiveApp(async ({ repository, owner, request }) => {
    const attempt = (id, createdAt) => ({
      id,
      module: 'grammar',
      activity: 'grammar_19_24',
      score: 4,
      max_score: 5,
      evidence_quality: 'server_verified_unassisted',
      created_at: createdAt,
    });
    const first = attempt('40000000-0000-4000-8000-000000000001', '2026-08-04T07:00:00.000Z');
    const second = attempt('40000000-0000-4000-8000-000000000002', '2026-08-04T08:00:00.000Z');
    const authoritative = buildAdaptiveLearningProfile({ attempts: [first, second] });
    await repository.saveAdaptiveLearningProfile(owner, authoritative, {
      now: new Date('2026-08-04T08:30:00.000Z'),
    });
    repository.getAdaptiveLearningEvidenceSources = async () => ({
      attempts: [first], recoveries: [], repeatAttempts: [],
    });

    const response = await request(owner, '/api/v1/adaptive-learning/overview');
    assert.equal(response.status, 409);
    assert.equal(response.headers.get('retry-after'), '1');
    assert.deepEqual(await response.json(), {
      error: { code: 'ADAPTIVE_PROFILE_RETRY_REQUIRED', retryable: true },
    });
  });
});

test('progress screen contains an accessible current-plan form and renders the server overview', async () => {
  const [markup, screen, configSource, serverSource, openapi] = await Promise.all([
    fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/screens/progress.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../config.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../server.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../docs/openapi.yaml', import.meta.url), 'utf8'),
  ]);

  assert.match(markup, /id="adaptive_plan"[^>]*hidden[^>]*aria-label="Мой план подготовки"[^>]*aria-labelledby="adaptive_plan_title"/u);
  assert.doesNotMatch(markup, /id="adaptive_plan"[^>]*aria-live=/u,
    'the plan container must not duplicate its scoped live status descendants');
  assert.match(markup, /<label[^>]*for="adaptive_target_score"/u);
  assert.match(markup, /id="adaptive_exam_date"[^>]*type="date"/u);
  assert.match(markup, /id="adaptive_weekly_minutes"[^>]*step="5"/u);
  assert.match(markup, /id="adaptive_grammar_focus"[^>]*role="status"/u);
  assert.match(screen, /apiGet\('\/api\/v1\/adaptive-learning\/overview',adaptiveOwnerHeaders/u);
  assert.match(screen, /adaptivePut\('\/api\/v1\/adaptive-learning\/goal'/u);
  assert.match(screen, /Idempotency-Key/u);
  assert.match(screen, /profile\.preliminary/u);
  assert.match(screen, /needsDiagnostic/u);
  assert.match(screen, /establishedSkillCount/u);
  assert.match(screen, /grammarRecommendation/u);
  assert.match(screen, /Точный фокус грамматики/u);
  assert.match(screen, /Результаты с подсказкой не подтверждают владение навыком/u);
  assert.match(screen, /features\?\.adaptive_learning/u);
  assert.match(configSource, /adaptiveLearning:\s*Object\.freeze\(\{[\s\S]*ADAPTIVE_LEARNING_ENABLED', false/u);
  assert.match(serverSource, /featureFlags:\s*\{ adaptiveLearning: config\.adaptiveLearning\.enabled \}/u);
  assert.match(serverSource, /enabled: config\.adaptiveLearning\.enabled/u);
  assert.match(openapi, /evidenceWatermarkVersion/u);
  assert.match(openapi, /adaptive-evidence-watermark-v1/u);
  assert.match(openapi, /profileCalculationRevision/u);
  assert.match(openapi, /Higher profileCalculationRevision wins first/u);
  assert.match(openapi, /Within the same calculation revision, evidenceSourceCount is monotonic/u);
  assert.match(openapi, /ADAPTIVE_PROFILE_RETRY_REQUIRED/u);
  assert.match(openapi, /Retry-After:/u);
  assert.doesNotMatch(openapi, /no revision may reduce evidenceSourceCount/u);
  assert.doesNotMatch(openapi, /goal: \{ \$ref: '#\/components\/schemas\/AdaptiveGoal', nullable: true \}/u);
  assert.equal([...openapi.matchAll(/goal:\s*\n\s+allOf:\s*\n\s+- \$ref: '#\/components\/schemas\/AdaptiveGoal'\s*\n\s+nullable: true/gu)].length, 2);
});
