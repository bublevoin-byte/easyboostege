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
import { buildAdaptiveLearningProfile, EGE_SKILL_TAXONOMY } from '../adaptive-learning/profile.js';
import {
  DEEP_DIAGNOSTIC_CATALOG,
  SHORT_DIAGNOSTIC_CATALOG,
} from '../adaptive-learning/diagnostic-catalog.js';
import { createFileRepository } from '../storage/file-repository.js';

const NOW = new Date('2026-08-04T09:00:00.000Z');
const OWNER_ATTEMPT_ID = '71563fb2-9d76-4de1-ae70-b9a014792ed1';
const STRANGER_ATTEMPT_ID = '03a5be0c-f380-4a90-9ac3-daf7c578f80b';

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
  app.use(createProgressRoutes({ authentication: testAuthentication(), db: repository }));
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
      headers: {
        'Content-Type': 'application/json',
        ...(username ? { 'X-Test-User': username } : {}),
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
  assert.equal(EGE_SKILL_TAXONOMY.version, 'ege-en-v1');
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
    { mastery: 73, uncertainty: 86, evidenceCount: 2, explanationCode: 'mixed_with_assistance' },
  );
  assert.equal(profile.preliminary, true);
  assert.equal(profile.confidence, 1);
  assert.equal(profile.weightingVersion, 'adaptive-evidence-v1');
  assert.equal(profile.profileCalculationRevision, 1);
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

test('short diagnostic productive choices stay preliminary and cannot create Free productive mastery', () => {
  const productiveItems = SHORT_DIAGNOSTIC_CATALOG.items.filter((item) => (
    item.module === 'writing' || item.module === 'speaking'
  ));
  assert.equal(productiveItems.length, 4);
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

test('deep diagnostic recognition without audio or productive work remains assisted', () => {
  const indirectItems = DEEP_DIAGNOSTIC_CATALOG.items.filter((item) => (
    ['listening', 'writing', 'speaking'].includes(item.module)
  ));
  assert.equal(indirectItems.length, 12);
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
    ['ege.speaking.interaction', ['speaking', 'speaking_interaction']],
    ['ege.speaking.monologue', ['speaking', 'speaking_monologue']],
  ]);
  const attempts = [...activities].map(([skillId, [module, activity]]) => ({
    id: crypto.randomUUID(), module, activity, score: 1, max_score: 1,
    evidence_quality: 'client_reported', created_at: NOW.toISOString(), skillId,
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
    ['speaking', 'ege.speaking.2.criterion.4', 'ege.speaking.interaction'],
    ['speaking', 'ege.speaking.3.criterion.5', 'ege.speaking.interaction'],
    ['speaking', 'ege.speaking.4.criterion.3', 'ege.speaking.monologue'],
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

  const mismatchedKnownFamily = buildAdaptiveLearningProfile({ recoveries: [{
    id: crypto.randomUUID(), module: 'grammar', skill_id: 'ege.writing.essay.criterion.1',
    terminal_outcome: 'resolved', observed_at: NOW.toISOString(),
  }] });
  assert.equal(mismatchedKnownFamily.evidenceCount, 0, 'known families never fall through to an unrelated module');

  const unsupportedReadingAloud = buildAdaptiveLearningProfile({ recoveries: [{
    id: crypto.randomUUID(), module: 'speaking', skill_id: 'ege.speaking.1.criterion.1',
    terminal_outcome: 'resolved', observed_at: NOW.toISOString(),
  }] });
  assert.equal(unsupportedReadingAloud.evidenceCount, 0, 'reading aloud has no matching v1 adaptive skill');

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

  assert.equal(profile.evidenceSourceCount, 2, 'raw watermark still sees both server records');
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
    for (let round = 0; round < 20; round += 1) {
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
        assert.equal(response.status, 201);
      }
    }

    const sources = await repository.getAdaptiveLearningEvidenceSources(owner);
    assert.equal(sources.attempts.filter((attempt) => attempt.evidence_quality === 'client_reported').length, 241);
    assert.equal(sources.attempts.some((attempt) => attempt.evidence_quality === 'server_verified_unassisted'), false);
    const overview = await (await request(owner, '/api/v1/adaptive-learning/overview')).json();
    assert.equal(overview.profile.clientReportedEvidenceCount, 241);
    assert.equal(overview.profile.independentEvidenceCount, 0);
    assert.equal(overview.profile.evidenceCount, 241);
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

test('adaptive API is absent unless rollout is explicitly enabled', async () => {
  await withAdaptiveApp(async ({ owner, request }) => {
    assert.equal((await request(owner, '/api/v1/adaptive-learning/goal')).status, 404);
    assert.equal((await request(owner, '/api/v1/adaptive-learning/overview')).status, 404);
  }, { enabled: false });
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
    assert.equal(created.profile.taxonomyVersion, 'ege-en-v1');
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
    assert.equal(exported.adaptive_learning_profile.taxonomy_version, 'ege-en-v1');
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

test('overview returns the authoritative stored profile when a reverse-order recomputation is rejected', async () => {
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
    assert.equal(response.status, 200);
    const overview = await response.json();
    assert.equal(overview.profile.evidenceSourceCount, 2);
    assert.equal(overview.profile.evidenceCount, 2);
    assert.equal(overview.profile.skills.find((skill) => skill.id === 'ege.grammar.forms').evidenceCount, 2);
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

  assert.match(markup, /id="adaptive_plan"[^>]*hidden[^>]*aria-label="Мой план подготовки"[^>]*aria-live="polite"/u);
  assert.match(markup, /<label[^>]*for="adaptive_target_score"/u);
  assert.match(markup, /id="adaptive_exam_date"[^>]*type="date"/u);
  assert.match(markup, /id="adaptive_weekly_minutes"[^>]*step="5"/u);
  assert.match(screen, /apiGet\('\/api\/v1\/adaptive-learning\/overview'\)/u);
  assert.match(screen, /apiPut\('\/api\/v1\/adaptive-learning\/goal'/u);
  assert.match(screen, /Idempotency-Key/u);
  assert.match(screen, /profile\.preliminary/u);
  assert.match(screen, /needsDiagnostic/u);
  assert.match(screen, /establishedSkillCount/u);
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
  assert.doesNotMatch(openapi, /no revision may reduce evidenceSourceCount/u);
  assert.doesNotMatch(openapi, /goal: \{ \$ref: '#\/components\/schemas\/AdaptiveGoal', nullable: true \}/u);
  assert.equal([...openapi.matchAll(/goal:\s*\n\s+allOf:\s*\n\s+- \$ref: '#\/components\/schemas\/AdaptiveGoal'\s*\n\s+nullable: true/gu)].length, 2);
});
