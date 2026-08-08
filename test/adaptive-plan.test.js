import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import * as adaptivePlanModule from '../adaptive-learning/plan.js';

import {
  adaptivePlanInputFingerprint,
  assertAdaptivePlanStabilityTransition,
  buildAdaptiveLearningPlan,
} from '../adaptive-learning/plan.js';
import { buildAdaptiveLearningProfile, EGE_SKILL_TAXONOMY } from '../adaptive-learning/profile.js';
import { createAdaptiveLearningRoutes } from '../routes/adaptive-learning.js';
import { createFileRepository } from '../storage/file-repository.js';
import { publicSpeakingReview, scoreSpeakingTask } from '../speaking/fipi-scoring.js';
import { SPEAKING_TASK2_CATALOG } from '../public/content/speaking/task2-v1.js';

const NOW = new Date('2026-08-04T09:00:00.000Z');

test('persistence callers cannot mint critical-retention bypass authority outside repository verification', () => {
  assert.equal(adaptivePlanModule.createTrustedAdaptivePlanStabilityContext, undefined);
});

function goal(overrides = {}) {
  return {
    id: '61000000-0000-4000-8000-000000000001',
    target_exam: 'ege_english',
    target_score: 85,
    exam_date: '2027-06-01',
    weekly_minutes: 300,
    revision: 1,
    ...overrides,
  };
}

function profile(overrides = {}) {
  const skills = EGE_SKILL_TAXONOMY.skills.map((skill) => ({
    id: skill.id,
    label: skill.label,
    module: skill.module,
    mastery: 60,
    uncertainty: 35,
    status: 'preliminary',
    evidenceCount: 1,
    effectiveEvidenceCount: 1,
    independentEvidenceCount: 1,
    evidenceQuality: 'independent',
    lastObservedAt: '2026-08-03T09:00:00.000Z',
    dueState: 'not_due',
    explanationCode: 'attempt_evidence',
  }));
  return {
    taxonomyVersion: 'ege-en-v2',
    weightingVersion: 'adaptive-evidence-v2',
    profileCalculationRevision: 1,
    evidenceWatermarkVersion: 'adaptive-evidence-watermark-v1',
    evidenceObservedAt: '2026-08-03T09:00:00.000Z',
    evidenceSourceCount: 12,
    evidenceFingerprint: 'a'.repeat(64),
    preliminary: true,
    status: 'preliminary',
    confidence: 55,
    evidenceCount: 12,
    independentEvidenceCount: 12,
    assistedEvidenceCount: 0,
    clientReportedEvidenceCount: 0,
    independentModuleCount: 6,
    establishedSkillCount: 0,
    needsDiagnostic: false,
    explanationCodes: ['unconfirmed_skills'],
    skills,
    modules: [],
    ...overrides,
  };
}

function scoredTask2Review() {
  const semanticFacts = {
    confidence: 0.96, verdict: 'Assessable.', evidence: ['Four direct questions.'], issues: [],
    items: Array.from({ length: 4 }, (_, index) => ({
      index: index + 1, relevant: true, directQuestion: true,
      lexicalGrammarBlocksCommunication: false, evidence: `Question ${index + 1}`,
    })),
  };
  const acousticFacts = {
    available: true, recognitionConfidence: 0.95, signalQuality: 'good', recordingDurationSeconds: 48,
    itemDurations: Array.from({ length: 4 }, (_, index) => ({
      itemIndex: index + 1, durationSeconds: 12,
    })),
    wordAccuracyScore: 96, phonemeAccuracyScore: 95, fluencyScore: 84, wordEvents: [],
  };
  return {
    ...publicSpeakingReview(
      scoreSpeakingTask({ taskType: 2, semantic: semanticFacts, acoustic: acousticFacts }),
      semanticFacts,
    ),
    semanticFacts,
    acousticFacts,
  };
}

async function createUnassistedTask2Evidence(repository, owner) {
  const assignedAt = new Date('2026-08-04T07:00:00.000Z');
  await repository.setSpeakingAccentProfile(owner, {
    locale: 'en-GB', source: 'manual', now: assignedAt,
  });
  const session = await repository.assignSpeakingTask2Session(owner, {
    catalogId: SPEAKING_TASK2_CATALOG.id,
    catalogRevision: SPEAKING_TASK2_CATALOG.revision,
    tasks: SPEAKING_TASK2_CATALOG.tasks,
    now: assignedAt,
  });
  for (let questionNumber = 1; questionNumber <= 4; questionNumber += 1) {
    await repository.completeSpeakingTask2Question(owner, session.id, questionNumber, {
      recordingDurationSeconds: 12, localPlayback: true, selfRating: 'steady',
    }, { now: new Date(assignedAt.getTime() + questionNumber * 12_000) });
  }
  const claim = await repository.claimSpeakingEvaluation(owner, {
    taskType: 2, assignment: {}, transcript: 'Four complete direct questions.',
  }, 'speaking-evaluation-v1', crypto.randomBytes(32).toString('hex'), {
    now: new Date(assignedAt.getTime() + 60_000),
    source: {
      sessionId: session.id, taskRef: session.task_id, taskRevision: Number(session.task_revision),
      catalogId: session.catalog_id, catalogRevision: Number(session.catalog_revision),
      assistanceUsed: false,
    },
  });
  await repository.finishSpeakingAttempt(claim.attempt.id, {
    status: 'completed', review: scoredTask2Review(), provider: 'test', model: 'test', errorCode: null,
  });
  return session;
}

test('transparent plan returns an honest range, exact allocation and diagnostic probes', () => {
  const inputProfile = profile();
  inputProfile.skills = inputProfile.skills.map((skill) => skill.id === 'ege.listening.detail'
    ? { ...skill, mastery: 20, uncertainty: 90 }
    : skill);
  const plan = buildAdaptiveLearningPlan({ goal: goal(), profile: inputProfile, now: NOW });

  assert.equal(plan.version, 'adaptive-plan-v1');
  assert.equal(plan.forecast.kind, 'estimated_range');
  assert.equal('guaranteedScore' in plan.forecast, false);
  assert.ok(plan.forecast.lowScore <= plan.forecast.highScore);
  assert.ok(plan.forecast.highScore <= 100);
  assert.equal(plan.forecast.confidence, 55);
  assert.ok(plan.forecast.assumptionCodes.includes('rule_based_not_calibrated'));
  assert.ok(plan.forecast.requiredWeeklyMinutes > 0);
  assert.equal(plan.allocation.skills.reduce((sum, item) => sum + item.percentage, 0), 100);
  assert.equal(plan.allocation.modules.reduce((sum, item) => sum + item.percentage, 0), 100);
  assert.deepEqual(
    plan.allocation.skills.map((item) => item.id).sort(),
    EGE_SKILL_TAXONOMY.skills.map((item) => item.id).sort(),
  );
  const listeningProbe = plan.allocation.skills.find((item) => item.id === 'ege.listening.detail');
  assert.equal(listeningProbe.activityType, 'diagnostic_probe');
  assert.ok(listeningProbe.reasonCodes.includes('high_uncertainty'));
  assert.equal(plan.allocation.modules.find((item) => item.id === 'listening').percentage,
    plan.allocation.skills.filter((item) => item.module === 'listening')
      .reduce((sum, item) => sum + item.percentage, 0));
});

test('a persisted v1 taxonomy plan resets stability before a v2 allocation is built', () => {
  const current = buildAdaptiveLearningPlan({ goal: goal(), profile: profile(), now: NOW });
  const legacy = structuredClone(current);
  legacy.revision = 7;
  legacy.taxonomyVersion = 'ege-en-v1';
  const speakingPercentage = legacy.allocation.modules
    .find((module) => module.id === 'speaking').percentage;
  legacy.allocation.skills = legacy.allocation.skills
    .filter((skill) => skill.module !== 'speaking')
    .concat([
      { id: 'ege.speaking.interaction', label: 'Interaction', module: 'speaking', percentage: Math.floor(speakingPercentage / 2), activityType: 'practice', reasonCodes: [] },
      { id: 'ege.speaking.monologue', label: 'Monologue', module: 'speaking', percentage: Math.ceil(speakingPercentage / 2), activityType: 'practice', reasonCodes: [] },
    ]);

  const upgraded = buildAdaptiveLearningPlan({
    goal: goal(), profile: profile(), previousPlan: legacy,
    now: new Date('2026-08-05T09:00:00.000Z'),
  });

  assert.equal(upgraded.basePlanRevision, 7);
  assert.equal(upgraded.taxonomyVersion, 'ege-en-v2');
  assert.equal(upgraded.stability.applied, false);
  assert.equal(upgraded.stability.bypassReason, 'taxonomy_changed');
  assert.equal(upgraded.allocation.skills.length, EGE_SKILL_TAXONOMY.skills.length);
  assert.equal(upgraded.allocation.skills.every((skill) => Number.isFinite(skill.percentage)), true);
  assert.equal(upgraded.allocation.skills.reduce((sum, skill) => sum + skill.percentage, 0), 100);
  assert.doesNotThrow(() => assertAdaptivePlanStabilityTransition(legacy, upgraded));
});

test('module priority is not multiplied by the number of micro-skills in its taxonomy', () => {
  const result = buildAdaptiveLearningPlan({ goal: goal(), profile: profile(), now: NOW });
  const modules = new Map(result.allocation.modules.map((module) => [module.id, module.percentage]));
  assert.ok(modules.get('speaking') <= modules.get('writing') + 2, JSON.stringify(result.allocation.modules));
  for (const module of result.allocation.modules) {
    assert.equal(module.percentage, result.allocation.skills
      .filter((skill) => skill.module === module.id)
      .reduce((sum, skill) => sum + skill.percentage, 0));
  }
  assert.equal(result.allocation.skills.reduce((sum, skill) => sum + skill.percentage, 0), 100);
});

test('unrealistic target offers concrete time and target choices without a promise', () => {
  const result = buildAdaptiveLearningPlan({
    goal: goal({ target_score: 100, exam_date: '2026-08-20', weekly_minutes: 30 }),
    profile: profile({ confidence: 25 }),
    now: NOW,
  });
  assert.equal(result.forecast.feasibility, 'unlikely_with_current_time');
  assert.deepEqual(result.forecast.choices.map((choice) => choice.type), [
    'increase_weekly_time', 'adjust_target_score',
  ]);
  assert.ok(result.forecast.choices[0].weeklyMinutes > 30);
  assert.ok(result.forecast.choices[1].targetScore < 100);
  assert.ok(result.forecast.assumptionCodes.includes('short_deadline'));
});

test('maximum weekly time never masquerades as a sufficient increase for a 15-day target gap', () => {
  const weak = profile({ confidence: 100 });
  weak.skills = weak.skills.map((skill) => ({ ...skill, mastery: 0, uncertainty: 0 }));
  const result = buildAdaptiveLearningPlan({
    goal: goal({ target_score: 40, exam_date: '2026-08-19', weekly_minutes: 2520 }),
    profile: weak,
    now: new Date('2026-08-04T00:00:00.000Z'),
  });

  assert.equal(result.forecast.requiredWeeklyMinutes, 2990);
  assert.equal(result.forecast.feasibility, 'unlikely_with_current_time');
  assert.deepEqual(result.forecast.choices.map((choice) => choice.type), ['adjust_target_score']);
  assert.equal(result.forecast.choices[0].targetScore, 38);
});

test('required time rounds upward on the same effectiveness equation and every increase is truthful', () => {
  const cases = [
    { name: 'zero gap', mastery: 40, uncertainty: 0, target: 40, examDate: '2026-08-19', expected: 0 },
    { name: 'five-minute rounding', mastery: 0, uncertainty: 0, target: 1, examDate: '2026-08-13', expected: 125 },
    { name: 'uncertainty factor', mastery: 0, uncertainty: 100, target: 1, examDate: '2026-08-11', expected: 240 },
    { name: 'supported maximum', mastery: 0, uncertainty: 100, target: 100, examDate: '2026-08-05', expected: 168000 },
  ];
  for (const scenario of cases) {
    const learner = profile({ confidence: 100 });
    learner.skills = learner.skills.map((skill) => ({
      ...skill,
      mastery: scenario.mastery,
      uncertainty: scenario.uncertainty,
    }));
    const forecast = buildAdaptiveLearningPlan({
      goal: goal({
        target_score: scenario.target,
        exam_date: scenario.examDate,
        weekly_minutes: 30,
      }),
      profile: learner,
      now: new Date('2026-08-04T00:00:00.000Z'),
    }).forecast;
    assert.equal(forecast.requiredWeeklyMinutes, scenario.expected, scenario.name);
    assert.equal(forecast.requiredWeeklyMinutes % 5, 0, scenario.name);
    for (const increase of forecast.choices.filter((choice) => choice.type === 'increase_weekly_time')) {
      assert.ok(increase.weeklyMinutes > forecast.availableWeeklyMinutes, scenario.name);
      assert.equal(
        increase.sufficientForEstimatedRequirement,
        increase.weeklyMinutes >= forecast.requiredWeeklyMinutes,
        scenario.name,
      );
    }
  }
});

test('ordinary recalculation keeps every visible skill and module within ten percentage points', () => {
  const initial = buildAdaptiveLearningPlan({ goal: goal(), profile: profile(), now: NOW });
  const changedProfile = profile({ evidenceSourceCount: 13, evidenceObservedAt: NOW.toISOString() });
  changedProfile.skills = changedProfile.skills.map((skill) => skill.module === 'listening'
    ? { ...skill, mastery: 0, uncertainty: 100, dueState: 'overdue' }
    : { ...skill, mastery: 95, uncertainty: 15 });
  const changed = buildAdaptiveLearningPlan({
    goal: goal(), profile: changedProfile, previousPlan: initial,
    now: new Date('2026-08-05T09:00:00.000Z'),
  });

  for (const next of changed.allocation.skills) {
    const before = initial.allocation.skills.find((item) => item.id === next.id);
    assert.ok(Math.abs(next.percentage - before.percentage) <= 10, next.id);
  }
  for (const next of changed.allocation.modules) {
    const before = initial.allocation.modules.find((item) => item.id === next.id);
    assert.ok(Math.abs(next.percentage - before.percentage) <= 10, next.id);
  }
  assert.equal(changed.allocation.skills.reduce((sum, item) => sum + item.percentage, 0), 100);
  assert.equal(changed.stability.applied, true);
  assert.equal(changed.stability.bypassReason, null, 'ordinary overdue work is still stability-bounded');
  assert.deepEqual(changed.stability.bypassedSkillIds, []);
  assert.deepEqual(changed.stability.bypassedModuleIds, []);
});

test('near deadline changes relative priorities instead of multiplying every skill uniformly', () => {
  const deadlineProfile = profile();
  deadlineProfile.skills = deadlineProfile.skills.map((skill) => {
    if (skill.id === 'ege.grammar.forms') return { ...skill, mastery: 10, uncertainty: 25 };
    if (skill.id === 'ege.vocabulary.lexical_choice') return { ...skill, mastery: 75, uncertainty: 25 };
    return { ...skill, mastery: 65, uncertainty: 25 };
  });
  const far = buildAdaptiveLearningPlan({
    goal: goal({ exam_date: '2027-06-01' }), profile: deadlineProfile, now: NOW,
  });
  const near = buildAdaptiveLearningPlan({
    goal: goal({ exam_date: '2026-08-20' }), profile: deadlineProfile, now: NOW,
  });
  const farGrammar = far.allocation.skills.find((item) => item.id === 'ege.grammar.forms');
  const nearGrammar = near.allocation.skills.find((item) => item.id === 'ege.grammar.forms');
  assert.ok(nearGrammar.percentage > farGrammar.percentage);
  assert.ok(nearGrammar.reasonCodes.includes('deadline_pressure'));
  assert.ok(near.forecast.assumptionCodes.includes('short_deadline'));
});

test('persisted critical retention can bypass stability only for its expiring skill and module', () => {
  const initial = buildAdaptiveLearningPlan({ goal: goal(), profile: profile(), now: NOW });
  const criticalProfile = profile({ evidenceSourceCount: 13, evidenceObservedAt: NOW.toISOString() });
  criticalProfile.skills = criticalProfile.skills.map((skill) => skill.id === 'ege.listening.detail'
    ? {
      ...skill,
      mastery: 0,
      uncertainty: 100,
      dueState: 'critical_due',
      criticalRetentionExpiresAt: '2026-08-04T18:00:00.000Z',
    }
    : { ...skill, mastery: 95, uncertainty: 15 });
  const changed = buildAdaptiveLearningPlan({
    goal: goal(), profile: criticalProfile, previousPlan: initial, now: NOW,
  });
  assert.equal(changed.stability.applied, true);
  assert.equal(changed.stability.bypassReason, 'critical_retention_expiry');
  assert.deepEqual(changed.stability.bypassedSkillIds, ['ege.listening.detail']);
  assert.deepEqual(changed.stability.bypassedModuleIds, ['listening']);
  const critical = changed.allocation.skills.find((item) => item.id === 'ege.listening.detail');
  assert.ok(critical.reasonCodes.includes('critical_retention_expiry'));
  assert.ok(Math.abs(critical.percentage - initial.allocation.skills
    .find((item) => item.id === critical.id).percentage) > 10);
  for (const next of changed.allocation.skills) {
    const before = initial.allocation.skills.find((item) => item.id === next.id);
    if (next.id !== critical.id) assert.ok(Math.abs(next.percentage - before.percentage) <= 10, next.id);
  }
  for (const next of changed.allocation.modules) {
    const before = initial.allocation.modules.find((item) => item.id === next.id);
    if (next.id !== 'listening') assert.ok(Math.abs(next.percentage - before.percentage) <= 10, next.id);
  }
  assert.doesNotThrow(() => assertAdaptivePlanStabilityTransition(initial, changed));
});

test('increase-time choice is always savable and discloses when the supported maximum is insufficient', () => {
  const weak = profile({ confidence: 0 });
  weak.skills = weak.skills.map((skill) => ({ ...skill, mastery: 0, uncertainty: 100 }));
  const result = buildAdaptiveLearningPlan({
    goal: goal({ target_score: 100, exam_date: '2026-08-05', weekly_minutes: 30 }),
    profile: weak,
    now: NOW,
  });
  const increase = result.forecast.choices.find((choice) => choice.type === 'increase_weekly_time');
  assert.ok(result.forecast.requiredWeeklyMinutes > 2520);
  assert.equal(increase.weeklyMinutes, 2520);
  assert.equal(increase.sufficientForEstimatedRequirement, false);
  assert.equal(increase.constraintCode, 'maximum_supported_weekly_time');
  assert.equal(result.forecast.feasibility, 'unlikely_with_current_time');
  const adjusted = result.forecast.choices.find((choice) => choice.type === 'adjust_target_score');
  assert.ok(adjusted.targetScore >= 0 && adjusted.targetScore <= 100);
});

test('plan input fingerprint binds the exact base plan revision', () => {
  const input = { goal: goal(), profile: profile(), now: NOW };
  assert.notEqual(
    adaptivePlanInputFingerprint({ ...input, basePlanRevision: 1 }),
    adaptivePlanInputFingerprint({ ...input, basePlanRevision: 2 }),
  );
});

test('one UTC recalculation bucket has one deterministic plan and preserves the final-day fraction', () => {
  const planningGoal = goal({ exam_date: '2026-08-05' });
  const learner = profile();
  const morning = new Date('2026-08-04T00:01:00.000Z');
  const endOfDay = new Date('2026-08-04T23:59:59.999Z');
  const morningPlan = buildAdaptiveLearningPlan({ goal: planningGoal, profile: learner, now: morning });
  const endOfDayPlan = buildAdaptiveLearningPlan({ goal: planningGoal, profile: learner, now: endOfDay });

  assert.equal(
    adaptivePlanInputFingerprint({ goal: planningGoal, profile: learner, now: morning }),
    adaptivePlanInputFingerprint({ goal: planningGoal, profile: learner, now: endOfDay }),
  );
  assert.deepEqual(endOfDayPlan, morningPlan);
  assert.equal(morningPlan.calculatedAt, '2026-08-04T00:00:00.000Z');
  assert.equal(morningPlan.forecast.weeksRemaining, 1 / 7);

  const examDateBucket = buildAdaptiveLearningPlan({
    goal: planningGoal,
    profile: learner,
    now: new Date('2026-08-05T00:00:00.000Z'),
  });
  assert.equal(examDateBucket.forecast.status, 'exam_date_expired');
  assert.equal(examDateBucket.forecast.weeksRemaining, 0);
});

test('PostgreSQL DATE keeps its calendar day in a positive timezone and the plan sees the same exam day', () => {
  const script = `
    import pg from 'pg';
    import { adaptiveLearningGoalRepositoryDto } from './adaptive-learning/goal-dto.js';
    import { buildAdaptiveLearningPlan } from './adaptive-learning/plan.js';
    import { buildAdaptiveLearningProfile } from './adaptive-learning/profile.js';

    const row = {
      id: '61000000-0000-4000-8000-000000000001',
      target_exam: 'ege_english', target_score: 85, weekly_minutes: 300, revision: 1,
      created_at: '2026-08-04T00:00:00.000Z', updated_at: '2026-08-04T00:00:00.000Z',
    };
    const parsedDate = pg.types.getTypeParser(1082)('2027-06-01');
    const fromFile = adaptiveLearningGoalRepositoryDto({ ...row, exam_date: '2027-06-01' });
    const fromPostgres = adaptiveLearningGoalRepositoryDto({ ...row, exam_date: parsedDate });
    const plan = buildAdaptiveLearningPlan({
      goal: fromPostgres,
      profile: buildAdaptiveLearningProfile(),
      now: new Date('2027-05-31T23:59:59.999Z'),
    });
    process.stdout.write(JSON.stringify({
      parserIso: parsedDate.toISOString(),
      fileExamDate: fromFile.exam_date,
      postgresExamDate: fromPostgres.exam_date,
      invalidExamDate: adaptiveLearningGoalRepositoryDto({
        ...row, exam_date: new Date(Number.NaN),
      }).exam_date,
      nullExamDate: adaptiveLearningGoalRepositoryDto({ ...row, exam_date: null }).exam_date,
      status: plan.forecast.status,
      weeksRemaining: plan.forecast.weeksRemaining,
    }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    env: { ...process.env, TZ: 'Asia/Omsk' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    parserIso: '2027-05-31T18:00:00.000Z',
    fileExamDate: '2027-06-01',
    postgresExamDate: '2027-06-01',
    invalidExamDate: null,
    nullExamDate: null,
    status: 'active',
    weeksRemaining: 1 / 7,
  });
});

test('the final days use real fractional weeks and never invent a full week', () => {
  const finalDays = buildAdaptiveLearningPlan({
    goal: goal({ exam_date: '2026-08-05' }),
    profile: profile(),
    now: new Date('2026-08-04T12:00:00.000Z'),
  });
  assert.equal(finalDays.forecast.kind, 'estimated_range');
  assert.ok(finalDays.forecast.weeksRemaining > 0);
  assert.ok(finalDays.forecast.weeksRemaining < 1);
  assert.ok(finalDays.forecast.requiredWeeklyMinutes > 2520);
});

test('a reached exam date becomes action-required without a future score range or fictitious week', () => {
  const expired = buildAdaptiveLearningPlan({
    goal: goal({ exam_date: '2026-08-05' }),
    profile: profile(),
    now: new Date('2026-08-05T00:01:00.000Z'),
  });
  assert.equal(expired.forecast.kind, 'action_required');
  assert.equal(expired.forecast.status, 'exam_date_expired');
  assert.equal(expired.forecast.lowScore, null);
  assert.equal(expired.forecast.highScore, null);
  assert.equal(expired.forecast.requiredWeeklyMinutes, null);
  assert.equal(expired.forecast.weeksRemaining, 0);
  assert.equal(expired.forecast.feasibility, 'update_exam_date_required');
  assert.deepEqual(expired.forecast.choices.map((choice) => choice.type), ['update_exam_date']);
  assert.equal(expired.forecast.actionCode, 'update_exam_date');
});

test('initial plan validation rejects non-canonical or incomplete allocation before any early return', () => {
  const valid = buildAdaptiveLearningPlan({ goal: goal(), profile: profile(), now: NOW });
  assert.throws(() => assertAdaptivePlanStabilityTransition(null, {
    ...valid,
    allocation: { ...valid.allocation, modules: valid.allocation.modules.slice(1) },
  }), /ADAPTIVE_PLAN_STABILITY_VIOLATION/u);
  assert.throws(() => assertAdaptivePlanStabilityTransition(null, {
    ...valid,
    allocation: {
      ...valid.allocation,
      skills: valid.allocation.skills.map((skill, index) => index === 0
        ? { ...skill, id: 'forged.skill' } : skill),
    },
  }), /ADAPTIVE_PLAN_STABILITY_VIOLATION/u);
});

function testAuthentication() {
  return { auth(req, res, next) {
    const username = String(req.headers['x-test-user'] || '');
    if (!username) return res.status(401).json({ error: { code: 'AUTH_REQUIRED' } });
    req.user = username;
    next();
  } };
}

async function withPlanApp(run, { decorateDb, enabled = true } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-plan-'));
  const repository = createFileRepository(path.join(directory, 'data.json'));
  const owner = await repository.createTelegramUser(9301, 'Plan Owner');
  const stranger = await repository.createTelegramUser(9302, 'Plan Stranger');
  let currentTime = new Date(NOW);
  const app = express();
  app.use(express.json());
  app.use(createAdaptiveLearningRoutes({
    authentication: testAuthentication(), db: decorateDb ? decorateDb(repository) : repository, enabled,
    now: () => new Date(currentTime),
    executionTokenSecret: 'adaptive-test-token-secret-32-characters',
  }));
  app.use((error, req, res, next) => res.status(500).json({ error: { code: error.message } }));
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const request = (username, pathname, options = {}) => fetch(
    `http://127.0.0.1:${server.address().port}${pathname}`,
    { ...options, headers: {
      'Content-Type': 'application/json',
      ...(username ? { 'X-Test-User': username, 'X-EasyBoost-Expected-Owner': username } : {}),
      ...(options.headers || {}),
    } },
  );
  try {
    await run({ repository, owner, stranger, request, setTime(value) { currentTime = new Date(value); } });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('authenticated plan API persists one daily revision and diagnostic evidence feeds its forecast', async () => {
  await withPlanApp(async ({ repository, owner, stranger, request, setTime }) => {
    assert.equal((await request('', '/api/v1/adaptive-learning/plan')).status, 401);
    assert.equal((await request(owner, '/api/v1/adaptive-learning/plan')).status, 409);

    const goalResponse = await request(owner, '/api/v1/adaptive-learning/goal', {
      method: 'PUT', headers: { 'Idempotency-Key': 'adaptive-plan-goal-owner-01' },
      body: JSON.stringify({
        targetExam: 'ege_english', targetScore: 85,
        examDate: '2027-06-01', weeklyMinutes: 300,
      }),
    });
    assert.equal(goalResponse.status, 201);
    const created = await goalResponse.json();
    assert.deepEqual(
      { created: created.created, replayed: created.replayed, superseded: created.superseded },
      { created: true, replayed: false, superseded: false },
    );
    assert.equal(created.plan.goalRevision, created.goal.revision);
    assert.equal(created.plan.revision, 1);
    assert.equal(created.plan.forecast.kind, 'estimated_range');
    assert.equal(created.plan.profileEvidenceSourceCount, 0);

    const sameDay = await (await request(owner, '/api/v1/adaptive-learning/plan')).json();
    assert.equal(sameDay.plan.id, created.plan.id);
    assert.equal(sameDay.plan.revision, 1);
    assert.equal((await repository.exportUserData(owner)).adaptive_learning_plan_revisions.length, 1);

    await repository.recordModuleAttempt(owner, {
      id: crypto.randomUUID(), module: 'grammar', activity: 'grammar_19_24',
      score: 10, maxScore: 10, durationMs: 60_000, metadata: { source: 'builtin' },
    }, { evidenceQuality: 'server_verified_unassisted' });
    setTime('2026-08-05T09:00:00.000Z');
    const updated = await (await request(owner, '/api/v1/adaptive-learning/overview')).json();
    assert.equal(updated.plan.revision, 2);
    assert.equal(updated.plan.profileEvidenceSourceCount, 1);
    assert.ok(updated.plan.allocation.skills.every((item) => item.reasonCodes.length > 0));

    assert.equal((await request(stranger, '/api/v1/adaptive-learning/plan')).status, 409);
    const strangerExport = await repository.exportUserData(stranger);
    assert.equal(strangerExport.adaptive_learning_plan_revisions.length, 0);
    assert.equal(JSON.stringify(strangerExport).includes(updated.plan.id), false);
  });
});

test('file HTTP overview creates a coherent new plan for same-time post-hoc assistance evidence', async () => {
  await withPlanApp(async ({ repository, owner, request }) => {
    const session = await createUnassistedTask2Evidence(repository, owner);
    const createdResponse = await request(owner, '/api/v1/adaptive-learning/goal', {
      method: 'PUT', headers: { 'Idempotency-Key': 'adaptive-plan-assistance-file-01' },
      body: JSON.stringify({
        targetExam: 'ege_english', targetScore: 85,
        examDate: '2027-06-01', weeklyMinutes: 300,
      }),
    });
    assert.equal(createdResponse.status, 201);
    const before = await createdResponse.json();
    assert.ok(before.profile.independentEvidenceCount > 0);
    assert.equal(before.plan.profileEvidenceFingerprint, before.profile.evidenceFingerprint);

    await repository.markSpeakingSessionAssisted(owner, 2, session.id, {
      now: new Date(before.profile.evidenceObservedAt),
    });
    const response = await request(owner, '/api/v1/adaptive-learning/overview');
    assert.equal(response.status, 200);
    const after = await response.json();
    assert.equal(after.profile.evidenceSourceCount, before.profile.evidenceSourceCount);
    assert.equal(after.profile.evidenceObservedAt, before.profile.evidenceObservedAt);
    assert.notEqual(after.profile.evidenceFingerprint, before.profile.evidenceFingerprint);
    assert.equal(after.profile.independentEvidenceCount, 0);
    assert.ok(after.profile.assistedEvidenceCount > 0);
    assert.equal(after.plan.revision, before.plan.revision + 1);
    assert.notEqual(after.plan.id, before.plan.id);
    assert.equal(after.plan.profileEvidenceFingerprint, after.profile.evidenceFingerprint);
    assert.notDeepEqual(after.plan.allocation, before.plan.allocation);
    const revisions = (await repository.exportUserData(owner)).adaptive_learning_plan_revisions;
    assert.deepEqual(revisions.map((entry) => entry.revision), [1, 2]);
    assert.deepEqual(revisions.map((entry) => entry.profile_evidence_fingerprint), [
      before.profile.evidenceFingerprint, after.profile.evidenceFingerprint,
    ]);
  });
});

test('file HTTP overview retries evidence changed after profile save before plan save', async () => {
  let armed = false;
  let injected = false;
  let sourceSession = null;
  const decorateDb = (repository) => new Proxy(repository, {
    get(target, property) {
      if (property !== 'saveAdaptiveLearningPlan') return Reflect.get(target, property);
      return async (username, candidate) => {
        if (armed && !injected) {
          injected = true;
          await target.markSpeakingSessionAssisted(username, 2, sourceSession.id, {
            now: new Date(candidate.profileEvidenceObservedAt),
          });
        }
        return target.saveAdaptiveLearningPlan(username, candidate);
      };
    },
  });
  await withPlanApp(async ({ repository, owner, request }) => {
    sourceSession = await createUnassistedTask2Evidence(repository, owner);
    const createdResponse = await request(owner, '/api/v1/adaptive-learning/goal', {
      method: 'PUT', headers: { 'Idempotency-Key': 'adaptive-plan-interleaving-file-01' },
      body: JSON.stringify({
        targetExam: 'ege_english', targetScore: 85,
        examDate: '2027-06-01', weeklyMinutes: 300,
      }),
    });
    assert.equal(createdResponse.status, 201);
    const before = await createdResponse.json();
    armed = true;

    const response = await request(owner, '/api/v1/adaptive-learning/overview');
    assert.equal(response.status, 200);
    const after = await response.json();
    assert.equal(injected, true);
    assert.equal(after.profile.evidenceSourceCount, before.profile.evidenceSourceCount);
    assert.equal(after.profile.evidenceObservedAt, before.profile.evidenceObservedAt);
    assert.notEqual(after.profile.evidenceFingerprint, before.profile.evidenceFingerprint);
    assert.equal(after.profile.independentEvidenceCount, 0);
    assert.ok(after.profile.assistedEvidenceCount > 0);
    assert.equal(after.plan.revision, before.plan.revision + 1);
    assert.equal(after.plan.profileEvidenceFingerprint, after.profile.evidenceFingerprint);
    assert.notDeepEqual(after.plan.allocation, before.plan.allocation);
    const current = await repository.getCurrentAdaptiveLearningPlan(owner);
    assert.equal(current.profile_evidence_fingerprint, after.profile.evidenceFingerprint);
    assert.equal((await repository.exportUserData(owner)).adaptive_learning_plan_revisions.length, 2,
      'the rejected stale plan must not create a revision');
  }, { decorateDb });
});

test('file overview exhausts profile CAS retries as a retryable 409 without a goal or plan', async () => {
  let saves = 0;
  const decorateDb = (repository) => new Proxy(repository, {
    get(target, property) {
      if (property !== 'saveAdaptiveLearningProfile') return Reflect.get(target, property);
      return async () => {
        saves += 1;
        throw new Error('ADAPTIVE_PROFILE_EVIDENCE_STALE');
      };
    },
  });
  await withPlanApp(async ({ owner, request }) => {
    const response = await request(owner, '/api/v1/adaptive-learning/overview');
    assert.equal(response.status, 409);
    assert.equal(response.headers.get('retry-after'), '1');
    assert.deepEqual(await response.json(), {
      error: { code: 'ADAPTIVE_PROFILE_RETRY_REQUIRED', retryable: true },
    });
    assert.equal(saves, 3, 'initial profile CAS plus two bounded retries');
  }, { decorateDb, enabled: false });
});

test('file overview recovers coherently when the first or second profile CAS retry wins', async () => {
  for (const failures of [1, 2]) {
    let saves = 0;
    const decorateDb = (repository) => new Proxy(repository, {
      get(target, property) {
        if (property !== 'saveAdaptiveLearningProfile') return Reflect.get(target, property);
        return async (...args) => {
          saves += 1;
          if (saves <= failures) throw new Error('ADAPTIVE_PROFILE_EVIDENCE_STALE');
          return target.saveAdaptiveLearningProfile(...args);
        };
      },
    });
    await withPlanApp(async ({ owner, request }) => {
      const response = await request(owner, '/api/v1/adaptive-learning/overview');
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.goal, null);
      assert.equal(result.plan, null);
      assert.equal(result.profile.evidenceSourceCount, 0);
      assert.equal(saves, failures + 1);
    }, { decorateDb, enabled: false });
  }
});

test('file overview normalizes every exhausted plan race to one retryable bounded 409', async () => {
  const failures = [
    { label: 'save conflict', result: () => ({ conflict: true }) },
    { label: 'goal mismatch', result: (_target, candidate) => ({
      conflict: false, plan: { goal_revision: Number(candidate.goalRevision) + 1 },
    }) },
    ...['ADAPTIVE_PLAN_GOAL_STALE', 'ADAPTIVE_PLAN_PROFILE_STALE',
      'ADAPTIVE_PLAN_EVIDENCE_STALE', 'ADAPTIVE_PLAN_RECALCULATION_CONFLICT']
      .map((code) => ({ label: code, result: () => { throw new Error(code); } })),
  ];
  for (const [index, failure] of failures.entries()) {
    let armed = false;
    let saves = 0;
    const decorateDb = (repository) => new Proxy(repository, {
      get(target, property) {
        if (property !== 'saveAdaptiveLearningPlan') return Reflect.get(target, property);
        return async (username, candidate) => {
          if (!armed) return target.saveAdaptiveLearningPlan(username, candidate);
          saves += 1;
          return failure.result(target, candidate);
        };
      },
    });
    await withPlanApp(async ({ owner, request }) => {
      const goal = await request(owner, '/api/v1/adaptive-learning/goal', {
        method: 'PUT', headers: { 'Idempotency-Key': `adaptive-plan-race-${index}-0001` },
        body: JSON.stringify({
          targetExam: 'ege_english', targetScore: 85,
          examDate: '2027-06-01', weeklyMinutes: 300,
        }),
      });
      assert.equal(goal.status, 201, failure.label);
      armed = true;
      const response = await request(owner, '/api/v1/adaptive-learning/overview');
      assert.equal(response.status, 409, failure.label);
      assert.equal(response.headers.get('retry-after'), '1', failure.label);
      assert.deepEqual(await response.json(), {
        error: { code: 'ADAPTIVE_PROFILE_RETRY_REQUIRED', retryable: true },
      }, failure.label);
      assert.equal(saves, 3, `${failure.label}: initial plan attempt plus two bounded retries`);
    }, { decorateDb });
  }
});

test('file overview recovers coherently when the first or second plan race retry wins', async () => {
  for (const failures of [1, 2]) {
    let armed = false;
    let saves = 0;
    const decorateDb = (repository) => new Proxy(repository, {
      get(target, property) {
        if (property !== 'saveAdaptiveLearningPlan') return Reflect.get(target, property);
        return async (...args) => {
          if (!armed) return target.saveAdaptiveLearningPlan(...args);
          saves += 1;
          if (saves <= failures) throw new Error('ADAPTIVE_PLAN_EVIDENCE_STALE');
          return target.saveAdaptiveLearningPlan(...args);
        };
      },
    });
    await withPlanApp(async ({ owner, request }) => {
      const goal = await request(owner, '/api/v1/adaptive-learning/goal', {
        method: 'PUT', headers: { 'Idempotency-Key': `adaptive-plan-recovery-${failures}-0001` },
        body: JSON.stringify({
          targetExam: 'ege_english', targetScore: 85,
          examDate: '2027-06-01', weeklyMinutes: 300,
        }),
      });
      assert.equal(goal.status, 201);
      armed = true;
      const response = await request(owner, '/api/v1/adaptive-learning/overview');
      assert.equal(response.status, 200);
      const overview = await response.json();
      assert.equal(overview.plan.goalRevision, overview.goal.revision);
      assert.equal(saves, failures + 1);
    }, { decorateDb });
  }
});

test('goal replay and concurrent goal saves return one internally consistent current snapshot', async () => {
  await withPlanApp(async ({ owner, request }) => {
    const firstBody = {
      targetExam: 'ege_english', targetScore: 80,
      examDate: '2027-05-30', weeklyMinutes: 300,
    };
    const first = await request(owner, '/api/v1/adaptive-learning/goal', {
      method: 'PUT', headers: { 'Idempotency-Key': 'adaptive-goal-snapshot-01' },
      body: JSON.stringify(firstBody),
    });
    assert.equal(first.status, 201);
    const firstResult = await first.json();
    assert.equal(firstResult.goal.revision, firstResult.plan.goalRevision);

    const second = await request(owner, '/api/v1/adaptive-learning/goal', {
      method: 'PUT', headers: { 'Idempotency-Key': 'adaptive-goal-snapshot-02' },
      body: JSON.stringify({ ...firstBody, targetScore: 90 }),
    });
    assert.equal(second.status, 201);
    const secondResult = await second.json();
    assert.equal(secondResult.goal.revision, 2);
    assert.equal(secondResult.goal.revision, secondResult.plan.goalRevision);

    const replay = await request(owner, '/api/v1/adaptive-learning/goal', {
      method: 'PUT', headers: { 'Idempotency-Key': 'adaptive-goal-snapshot-01' },
      body: JSON.stringify(firstBody),
    });
    assert.equal(replay.status, 200);
    const replayResult = await replay.json();
    assert.deepEqual(
      { created: replayResult.created, replayed: replayResult.replayed, superseded: replayResult.superseded },
      { created: false, replayed: true, superseded: true },
    );
    assert.equal(replayResult.goal.revision, 2);
    assert.equal(replayResult.plan.goalRevision, replayResult.goal.revision);

    const concurrent = await Promise.all([
      request(owner, '/api/v1/adaptive-learning/goal', {
        method: 'PUT', headers: { 'Idempotency-Key': 'adaptive-goal-snapshot-03' },
        body: JSON.stringify({ ...firstBody, targetScore: 91 }),
      }),
      request(owner, '/api/v1/adaptive-learning/goal', {
        method: 'PUT', headers: { 'Idempotency-Key': 'adaptive-goal-snapshot-04' },
        body: JSON.stringify({ ...firstBody, targetScore: 92 }),
      }),
    ]);
    for (const response of concurrent) {
      const result = await response.json();
      assert.equal(result.goal.revision, result.plan.goalRevision);
    }
  });
});

test('overview retries and rejects a profile advance that is not backed by current evidence', async () => {
  let advanced = false;
  const decorateDb = (repository) => new Proxy(repository, {
    get(target, property) {
      if (property !== 'saveAdaptiveLearningProfile') return Reflect.get(target, property);
      return async (username, candidateProfile, options) => {
        const saved = await target.saveAdaptiveLearningProfile(username, candidateProfile, options);
        if (!advanced) {
          advanced = true;
          await target.saveAdaptiveLearningProfile(username, {
            ...candidateProfile,
            evidenceSourceCount: candidateProfile.evidenceSourceCount + 1,
            evidenceObservedAt: '2026-08-04T08:59:00.000Z',
          }, options);
        }
        return saved;
      };
    },
  });
  await withPlanApp(async ({ owner, request }) => {
    const response = await request(owner, '/api/v1/adaptive-learning/goal', {
      method: 'PUT', headers: { 'Idempotency-Key': 'adaptive-goal-profile-race-01' },
      body: JSON.stringify({
        targetExam: 'ege_english', targetScore: 80,
        examDate: '2027-05-30', weeklyMinutes: 300,
      }),
    });
    assert.equal(response.status, 201);
    const result = await response.json();
    assert.equal(result.plan.profileEvidenceSourceCount, 0);
    assert.equal(result.profile.evidenceSourceCount, 0);
  }, { decorateDb });
});

test('API retries an exact historical plan fingerprint after goal revision two to a coherent current snapshot', async () => {
  let replayOldSnapshot = false;
  let historicalGoal = null;
  let oldPlanRead = false;
  let observedHistoricalReplay = false;
  const decorateDb = (repository) => new Proxy(repository, {
    get(target, property) {
      if (property === 'getAdaptiveLearningGoal') return async (...args) => {
        if (replayOldSnapshot) return historicalGoal;
        return target.getAdaptiveLearningGoal(...args);
      };
      if (property === 'getCurrentAdaptiveLearningPlan') return async (...args) => {
        if (replayOldSnapshot && !oldPlanRead) {
          oldPlanRead = true;
          return null;
        }
        return target.getCurrentAdaptiveLearningPlan(...args);
      };
      if (property === 'saveAdaptiveLearningPlan') return async (...args) => {
        const saved = await target.saveAdaptiveLearningPlan(...args);
        observedHistoricalReplay ||= saved.reason === 'historical_fingerprint';
        replayOldSnapshot = false;
        return saved;
      };
      return Reflect.get(target, property);
    },
  });
  await withPlanApp(async ({ owner, request }) => {
    const body = {
      targetExam: 'ege_english', targetScore: 80,
      examDate: '2027-05-30', weeklyMinutes: 300,
    };
    const first = await (await request(owner, '/api/v1/adaptive-learning/goal', {
      method: 'PUT', headers: { 'Idempotency-Key': 'adaptive-goal-old-plan-01' },
      body: JSON.stringify(body),
    })).json();
    historicalGoal = first.goal;
    const second = await (await request(owner, '/api/v1/adaptive-learning/goal', {
      method: 'PUT', headers: { 'Idempotency-Key': 'adaptive-goal-old-plan-02' },
      body: JSON.stringify({ ...body, targetScore: 90 }),
    })).json();
    assert.equal(second.goal.revision, 2);
    replayOldSnapshot = true;
    oldPlanRead = false;
    const response = await request(owner, '/api/v1/adaptive-learning/overview');
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(observedHistoricalReplay, true);
    assert.equal(result.goal.revision, 2);
    assert.equal(result.plan.goalRevision, 2);
  }, { decorateDb });
});

test('API plan replay cannot turn a captured fingerprint into a bare persistence request', async () => {
  let capturedFingerprint = null;
  let probeBareReplay = false;
  let bareReplayError = null;
  const decorateDb = (repository) => new Proxy(repository, {
    get(target, property) {
      if (property !== 'saveAdaptiveLearningPlan') return Reflect.get(target, property);
      return async (username, candidate) => {
        if (!capturedFingerprint) capturedFingerprint = candidate.inputFingerprint;
        if (probeBareReplay) {
          probeBareReplay = false;
          try {
            await target.saveAdaptiveLearningPlan(username, {
              inputFingerprint: capturedFingerprint,
            });
          } catch (error) {
            bareReplayError = error.message;
          }
        }
        return target.saveAdaptiveLearningPlan(username, candidate);
      };
    },
  });
  await withPlanApp(async ({ owner, request }) => {
    const created = await request(owner, '/api/v1/adaptive-learning/goal', {
      method: 'PUT', headers: { 'Idempotency-Key': 'adaptive-goal-bare-plan-01' },
      body: JSON.stringify({
        targetExam: 'ege_english', targetScore: 80,
        examDate: '2027-05-30', weeklyMinutes: 300,
      }),
    });
    assert.equal(created.status, 201);
    probeBareReplay = true;
    const replay = await request(owner, '/api/v1/adaptive-learning/plan');
    assert.equal(replay.status, 200);
    assert.equal(bareReplayError, 'ADAPTIVE_PLAN_INVALID');
    assert.equal((await replay.json()).plan.revision, 1);
  }, { decorateDb });
});

test('API rejects a same-fingerprint plan whose semantic payload differs from the retained revision', async () => {
  let corruptNextReplay = false;
  let hideCurrentOnce = false;
  const decorateDb = (repository) => new Proxy(repository, {
    get(target, property) {
      if (property === 'getCurrentAdaptiveLearningPlan') return async (...args) => {
        if (hideCurrentOnce) {
          hideCurrentOnce = false;
          return null;
        }
        return target.getCurrentAdaptiveLearningPlan(...args);
      };
      if (property !== 'saveAdaptiveLearningPlan') return Reflect.get(target, property);
      return async (username, candidate) => {
        if (!corruptNextReplay) return target.saveAdaptiveLearningPlan(username, candidate);
        corruptNextReplay = false;
        const changed = structuredClone(candidate);
        changed.plan.forecast.confidence += 1;
        return target.saveAdaptiveLearningPlan(username, changed);
      };
    },
  });
  await withPlanApp(async ({ owner, request }) => {
    const created = await request(owner, '/api/v1/adaptive-learning/goal', {
      method: 'PUT', headers: { 'Idempotency-Key': 'adaptive-goal-replay-payload-01' },
      body: JSON.stringify({
        targetExam: 'ege_english', targetScore: 80,
        examDate: '2027-05-30', weeklyMinutes: 300,
      }),
    });
    assert.equal(created.status, 201);

    corruptNextReplay = true;
    hideCurrentOnce = true;
    const rejected = await request(owner, '/api/v1/adaptive-learning/plan');
    assert.equal(rejected.status, 500);
    assert.equal((await rejected.json()).error.code, 'ADAPTIVE_PLAN_REPLAY_MISMATCH');

    const replayed = await request(owner, '/api/v1/adaptive-learning/plan');
    assert.equal(replayed.status, 200);
    assert.equal((await replayed.json()).plan.revision, 1);
  }, { decorateDb });
});

test('saved goal becomes an explicit expired action state when its exam date passes', async () => {
  await withPlanApp(async ({ owner, request, setTime }) => {
    const response = await request(owner, '/api/v1/adaptive-learning/goal', {
      method: 'PUT', headers: { 'Idempotency-Key': 'adaptive-goal-expiry-0001' },
      body: JSON.stringify({
        targetExam: 'ege_english', targetScore: 85,
        examDate: '2026-08-05', weeklyMinutes: 300,
      }),
    });
    assert.equal(response.status, 201);
    setTime('2026-08-05T00:01:00.000Z');
    const expired = await (await request(owner, '/api/v1/adaptive-learning/plan')).json();
    assert.equal(expired.plan.forecast.status, 'exam_date_expired');
    assert.equal(expired.plan.forecast.lowScore, null);
    assert.equal(expired.plan.forecast.highScore, null);
    assert.equal(expired.plan.forecast.weeksRemaining, 0);
    assert.equal(expired.plan.forecast.actionCode, 'update_exam_date');
  });
});

test('plan API keeps revision two authoritative when an older daily input is requested again', async () => {
  await withPlanApp(async ({ repository, owner, request, setTime }) => {
    const goalResponse = await request(owner, '/api/v1/adaptive-learning/goal', {
      method: 'PUT', headers: { 'Idempotency-Key': 'adaptive-plan-history-0001' },
      body: JSON.stringify({
        targetExam: 'ege_english', targetScore: 85,
        examDate: '2027-06-01', weeklyMinutes: 300,
      }),
    });
    assert.equal((await goalResponse.json()).plan.revision, 1);
    setTime('2026-08-05T09:00:00.000Z');
    const second = await (await request(owner, '/api/v1/adaptive-learning/plan')).json();
    assert.equal(second.plan.revision, 2);
    setTime('2026-08-04T09:00:00.000Z');
    const replayedOlderInput = await (await request(owner, '/api/v1/adaptive-learning/plan')).json();
    assert.equal(replayedOlderInput.plan.revision, 2);
    assert.equal((await repository.exportUserData(owner)).adaptive_learning_plan_revisions.length, 2);
  });
});

test('plan API recomputes against the winning concurrent base instead of losing newer evidence', async () => {
  let injectedConflict = false;
  let observedConflict = false;
  const decorateDb = (repository) => new Proxy(repository, {
    get(target, property) {
      if (property !== 'saveAdaptiveLearningPlan') return Reflect.get(target, property);
      return async (username, candidate) => {
        const current = await target.getCurrentAdaptiveLearningPlan(username);
        if (!injectedConflict && current?.revision === 1 && candidate.profileEvidenceSourceCount === 1) {
          injectedConflict = true;
          const [authoritativeGoal, authoritativeProfile] = await Promise.all([
            target.getAdaptiveLearningGoal(username),
            target.getAdaptiveLearningProfile(username),
          ]);
          const winningNow = new Date('2026-08-04T23:00:00.000Z');
          const winningPlan = buildAdaptiveLearningPlan({
            goal: authoritativeGoal,
            profile: authoritativeProfile,
            previousPlan: current,
            now: winningNow,
          });
          await target.saveAdaptiveLearningPlan(username, {
            id: crypto.randomUUID(),
            inputFingerprint: adaptivePlanInputFingerprint({
              goal: authoritativeGoal,
              profile: authoritativeProfile,
              basePlanRevision: current.revision,
              now: winningNow,
            }),
            basePlanRevision: current.revision,
            goalId: authoritativeGoal.id,
            goalRevision: authoritativeGoal.revision,
            taxonomyVersion: authoritativeProfile.taxonomy_version,
            profileCalculationRevision: Number(authoritativeProfile.profile_calculation_revision),
            profileEvidenceWatermarkVersion: authoritativeProfile.evidence_watermark_version,
            profileEvidenceObservedAt: authoritativeProfile.evidence_observed_at,
            profileEvidenceSourceCount: Number(authoritativeProfile.evidence_source_count),
            profileEvidenceFingerprint: authoritativeProfile.evidence_fingerprint,
            recalculationBucket: '2026-08-04',
            now: winningNow,
            plan: winningPlan,
          });
        }
        const saved = await target.saveAdaptiveLearningPlan(username, candidate);
        observedConflict ||= saved.conflict === true;
        return saved;
      };
    },
  });
  await withPlanApp(async ({ repository, owner, request, setTime }) => {
    await request(owner, '/api/v1/adaptive-learning/goal', {
      method: 'PUT', headers: { 'Idempotency-Key': 'adaptive-plan-race-goal-01' },
      body: JSON.stringify({
        targetExam: 'ege_english', targetScore: 85,
        examDate: '2027-06-01', weeklyMinutes: 300,
      }),
    });
    await repository.recordModuleAttempt(owner, {
      id: crypto.randomUUID(), module: 'grammar', activity: 'grammar_19_24',
      score: 10, maxScore: 10, durationMs: 60_000, metadata: { source: 'builtin' },
    }, { evidenceQuality: 'server_verified_unassisted' });
    setTime('2026-08-05T09:00:00.000Z');
    const response = await request(owner, '/api/v1/adaptive-learning/plan');
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(observedConflict, true, 'the route must observe and recover from a base CAS conflict');
    assert.equal(result.plan.revision, 3);
    assert.equal(result.plan.profileEvidenceSourceCount, 1);
    const revisions = (await repository.exportUserData(owner)).adaptive_learning_plan_revisions;
    assert.deepEqual(revisions.map((entry) => entry.revision), [1, 2, 3]);
    for (const next of revisions[2].allocation.skills) {
      const before = revisions[1].allocation.skills.find((item) => item.id === next.id);
      assert.ok(Math.abs(next.percentage - before.percentage) <= 10, next.id);
    }
  }, { decorateDb });
});

test('plan card exposes forecast confidence, reasons, allocation and realistic choices accessibly', async () => {
  const [markup, screen, openapi] = await Promise.all([
    fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/screens/progress.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../docs/openapi.yaml', import.meta.url), 'utf8'),
  ]);
  assert.match(markup, /id="adaptive_forecast"[^>]*aria-labelledby="adaptive_forecast_title"/u);
  assert.match(markup, /id="adaptive_forecast_confidence"/u);
  assert.match(markup, /id="adaptive_weekly_allocation"[^>]*aria-label=/u);
  assert.match(markup, /id="adaptive_plan_choices"/u);
  assert.match(screen, /plan\.forecast\.lowScore/u);
  assert.match(screen, /plan\.forecast\.highScore/u);
  assert.match(screen, /requiredWeeklyMinutes/u);
  assert.match(screen, /reasonCodes/u);
  assert.match(screen, /increase_weekly_time/u);
  assert.match(screen, /adjust_target_score/u);
  assert.match(screen, /maximum_supported_weekly_time/u);
  assert.match(screen, /critical_retention_expiry:'[^']+'/u);
  assert.match(screen, /exam_date_expired/u);
  assert.doesNotMatch(screen, /guaranteedScore/u);
  assert.match(openapi, /\/adaptive-learning\/plan:/u);
  assert.match(openapi, /rule_based_not_calibrated/u);
  assert.match(openapi, /increase_weekly_time/u);
  assert.match(openapi, /adjust_target_score/u);
  assert.match(openapi, /maximum_supported_weekly_time/u);
  assert.match(openapi, /AdaptiveGoalMutationResponse/u);
  assert.match(openapi, /exam_date_expired/u);
  assert.match(openapi, /profileEvidenceFingerprint/u);
});
