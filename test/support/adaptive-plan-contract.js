import crypto from 'node:crypto';

import {
  adaptivePlanInputFingerprint,
  buildAdaptiveLearningPlan,
} from '../../adaptive-learning/plan.js';
import { buildAdaptiveLearningProfile } from '../../adaptive-learning/profile.js';

const PLAN_KEYS = Object.freeze([
  'allocation', 'base_plan_revision', 'calculated_at', 'created_at', 'forecast', 'goal_id', 'goal_revision', 'id',
  'plan_version', 'profile_calculation_revision', 'profile_evidence_observed_at',
  'profile_evidence_source_count', 'profile_evidence_watermark_version', 'recalculation_bucket',
  'revision', 'stability', 'taxonomy_version', 'updated_at',
]);

function candidate({
  goal,
  profile,
  plan,
  basePlanRevision,
  now,
}) {
  return {
    id: crypto.randomUUID(),
    inputFingerprint: adaptivePlanInputFingerprint({
      goal, profile, basePlanRevision, now,
    }),
    basePlanRevision,
    goalId: goal.id,
    goalRevision: goal.revision,
    taxonomyVersion: profile.taxonomyVersion,
    profileCalculationRevision: profile.profileCalculationRevision,
    profileEvidenceWatermarkVersion: profile.evidenceWatermarkVersion,
    profileEvidenceObservedAt: profile.evidenceObservedAt,
    profileEvidenceSourceCount: profile.evidenceSourceCount,
    recalculationBucket: plan.recalculationBucket,
    plan,
    now,
  };
}

function assertBoundedTransition(assert, previous, next) {
  for (const skill of next.allocation.skills) {
    const before = previous.allocation.skills.find((item) => item.id === skill.id);
    assert.ok(Math.abs(skill.percentage - before.percentage) <= 10, skill.id);
  }
  for (const module of next.allocation.modules) {
    const before = previous.allocation.modules.find((item) => item.id === module.id);
    assert.ok(Math.abs(module.percentage - before.percentage) <= 10, module.id);
  }
}

function shiftAllocationBeyondOrdinaryLimit(plan) {
  const shifted = structuredClone(plan);
  const target = shifted.allocation.skills.find((skill) => skill.id === 'ege.listening.detail');
  const moduleChanges = new Map([[target.module, 11]]);
  target.percentage += 11;
  let remaining = 11;
  const donors = [];
  for (const skill of shifted.allocation.skills) {
    if (remaining === 0) break;
    if (skill.module === target.module || skill.percentage <= 0) continue;
    const amount = Math.min(10, skill.percentage, remaining);
    skill.percentage -= amount;
    remaining -= amount;
    donors.push(skill);
    moduleChanges.set(skill.module, (moduleChanges.get(skill.module) || 0) - amount);
  }
  if (remaining !== 0) throw new Error('TEST_PLAN_SHIFT_INFEASIBLE');
  for (const module of shifted.allocation.modules) {
    module.percentage += moduleChanges.get(module.id) || 0;
  }
  return { shifted, target, donors, affectedModules: [...moduleChanges.keys()] };
}

export async function assertAdaptivePlanRepositoryContract(assert, repository, username) {
  const firstGoal = (await repository.saveAdaptiveLearningGoal(username, {
    id: crypto.randomUUID(), idempotencyKey: 'plan-contract-goal-0001', requestHash: '1'.repeat(64),
    targetExam: 'ege_english', targetScore: 85, examDate: '2027-06-01', weeklyMinutes: 300,
    now: new Date('2026-08-04T08:00:00.000Z'),
  })).goal;
  const firstProfile = buildAdaptiveLearningProfile();
  await repository.saveAdaptiveLearningProfile(username, firstProfile, {
    now: new Date('2026-08-04T08:30:00.000Z'),
  });
  const firstPlan = buildAdaptiveLearningPlan({
    goal: firstGoal, profile: firstProfile, now: new Date('2026-08-04T09:00:00.000Z'),
  });
  const firstCandidate = candidate({
    goal: firstGoal,
    profile: firstProfile,
    plan: firstPlan,
    basePlanRevision: null,
    now: new Date('2026-08-04T09:00:00.000Z'),
  });
  const syntheticProfile = structuredClone(firstProfile);
  syntheticProfile.skills = syntheticProfile.skills.map((skill) => skill.id === 'ege.listening.detail'
    ? { ...skill, mastery: 55, uncertainty: 15 }
    : skill);
  await assert.rejects(
    repository.saveAdaptiveLearningPlan(username, candidate({
      goal: firstGoal,
      profile: syntheticProfile,
      plan: buildAdaptiveLearningPlan({
        goal: firstGoal,
        profile: syntheticProfile,
        now: new Date('2026-08-04T09:00:00.000Z'),
      }),
      basePlanRevision: null,
      now: new Date('2026-08-04T09:00:00.000Z'),
    })),
    /ADAPTIVE_PLAN_AUTHORITY_MISMATCH/u,
    'shape-valid skill values cannot replace the full persisted authoritative profile',
  );
  const syntheticDueProfile = structuredClone(firstProfile);
  syntheticDueProfile.skills = syntheticDueProfile.skills.map((skill) => skill.id === 'ege.grammar.forms'
    ? { ...skill, dueState: 'overdue' }
    : skill);
  await assert.rejects(
    repository.saveAdaptiveLearningPlan(username, candidate({
      goal: firstGoal,
      profile: syntheticDueProfile,
      plan: buildAdaptiveLearningPlan({
        goal: firstGoal,
        profile: syntheticDueProfile,
        now: new Date('2026-08-04T09:00:00.000Z'),
      }),
      basePlanRevision: null,
      now: new Date('2026-08-04T09:00:00.000Z'),
    })),
    /ADAPTIVE_PLAN_AUTHORITY_MISMATCH/u,
    'shape-valid due state cannot replace the persisted authoritative skill state',
  );
  for (const [name, goalOverride] of [
    ['target score', { target_score: firstGoal.target_score - 5 }],
    ['exam date', { exam_date: '2027-05-01' }],
    ['weekly minutes', { weekly_minutes: firstGoal.weekly_minutes + 5 }],
  ]) {
    const syntheticGoal = { ...firstGoal, ...goalOverride };
    await assert.rejects(
      repository.saveAdaptiveLearningPlan(username, candidate({
        goal: syntheticGoal,
        profile: firstProfile,
        plan: buildAdaptiveLearningPlan({
          goal: syntheticGoal,
          profile: firstProfile,
          now: new Date('2026-08-04T09:00:00.000Z'),
        }),
        basePlanRevision: null,
        now: new Date('2026-08-04T09:00:00.000Z'),
      })),
      /ADAPTIVE_PLAN_AUTHORITY_MISMATCH/u,
      `${name} must come from the full persisted current goal`,
    );
  }
  const alteredForecastPlan = structuredClone(firstPlan);
  alteredForecastPlan.forecast.confidence = alteredForecastPlan.forecast.confidence === 100
    ? 99 : alteredForecastPlan.forecast.confidence + 1;
  await assert.rejects(
    repository.saveAdaptiveLearningPlan(username, candidate({
      goal: firstGoal,
      profile: firstProfile,
      plan: alteredForecastPlan,
      basePlanRevision: null,
      now: new Date('2026-08-04T09:00:00.000Z'),
    })),
    /ADAPTIVE_PLAN_AUTHORITY_MISMATCH/u,
    'a shape-valid forecast with the same watermark cannot replace the deterministic plan',
  );
  const malformedCandidates = [
    ['forged plan version', (entry) => { entry.plan.version = 'adaptive-plan-forged'; }],
    ['zero calculation revision', (entry) => {
      entry.profileCalculationRevision = 0;
      entry.plan.profileCalculationRevision = 0;
    }],
    ['negative source count', (entry) => {
      entry.profileEvidenceSourceCount = -99;
      entry.plan.profileEvidenceSourceCount = -99;
    }],
    ['null recalculation bucket', (entry) => {
      entry.recalculationBucket = null;
      entry.plan.recalculationBucket = null;
    }],
    ['invalid recalculation bucket', (entry) => {
      entry.recalculationBucket = '2026-13-40';
      entry.plan.recalculationBucket = '2026-13-40';
    }],
    ['arbitrary forecast discriminator', (entry) => { entry.plan.forecast.kind = 'fortune'; }],
    ['contradictory forecast choice', (entry) => {
      entry.plan.forecast.choices[0].sufficientForEstimatedRequirement = false;
    }],
    ['adjusted target above the forecast range', (entry) => {
      entry.plan.forecast.choices.at(-1).targetScore = 100;
    }],
    ['increase choice that does not increase current time', (entry) => {
      entry.plan.forecast.choices[0].weeklyMinutes = entry.plan.forecast.availableWeeklyMinutes;
    }],
    ['feasible forecast with insufficient time', (entry) => {
      entry.plan.forecast.feasibility = 'feasible_with_consistent_study';
      entry.plan.forecast.choices = [];
    }],
    ['off-grid required minutes', (entry) => { entry.plan.forecast.requiredWeeklyMinutes = 3; }],
    ['arbitrary allocation reason', (entry) => {
      entry.plan.allocation.skills[0].reasonCodes = ['because_i_said_so'];
    }],
    ['incoherent initial stability metadata', (entry) => { entry.plan.stability.applied = true; }],
    ['goal-change reset on an initial plan', (entry) => {
      entry.plan.stability.bypassReason = 'goal_changed';
    }],
    ['non-ISO observed timestamp', (entry) => {
      entry.profileEvidenceObservedAt = '2026-08-04 08:00';
      entry.plan.profileEvidenceObservedAt = '2026-08-04 08:00';
    }],
    ['outer and inner profile vector mismatch', (entry) => {
      entry.plan.profileEvidenceSourceCount += 1;
    }],
    ['non-UUID plan id', (entry) => { entry.id = 'not-a-uuid'; }],
    ['non-lowercase fingerprint', (entry) => { entry.inputFingerprint = 'A'.repeat(64); }],
  ];
  for (const [name, mutate] of malformedCandidates) {
    const malformed = structuredClone(firstCandidate);
    malformed.id = crypto.randomUUID();
    mutate(malformed);
    if (name !== 'non-lowercase fingerprint') {
      malformed.inputFingerprint = adaptivePlanInputFingerprint({
        goal: { id: malformed.goalId, revision: malformed.goalRevision },
        profile: {
          taxonomyVersion: malformed.taxonomyVersion,
          profileCalculationRevision: malformed.profileCalculationRevision,
          evidenceWatermarkVersion: malformed.profileEvidenceWatermarkVersion,
          evidenceObservedAt: malformed.profileEvidenceObservedAt,
          evidenceSourceCount: malformed.profileEvidenceSourceCount,
        },
        basePlanRevision: malformed.basePlanRevision,
        now: malformed.now,
      });
    }
    await assert.rejects(
      repository.saveAdaptiveLearningPlan(username, malformed),
      /ADAPTIVE_PLAN_INVALID/u,
      `${name} must fail identically before persistence`,
    );
  }
  await assert.rejects(
    repository.saveAdaptiveLearningPlan(username, {
      ...firstCandidate,
      id: crypto.randomUUID(),
      inputFingerprint: '0'.repeat(64),
      plan: {
        ...firstPlan,
        allocation: { ...firstPlan.allocation, skills: firstPlan.allocation.skills.slice(1) },
      },
    }),
    /ADAPTIVE_PLAN_INVALID/u,
    'even the first persisted plan must contain the exact canonical allocation',
  );
  const concurrent = await Promise.all([
    repository.saveAdaptiveLearningPlan(username, firstCandidate),
    repository.saveAdaptiveLearningPlan(username, { ...firstCandidate, id: crypto.randomUUID() }),
  ]);
  assert.deepEqual(concurrent.map((entry) => entry.created).sort(), [false, true]);
  assert.deepEqual(concurrent[0].plan, concurrent[1].plan);
  assert.equal(concurrent[0].plan.revision, 1);
  assert.equal(concurrent.find((entry) => !entry.created).replayed, true);
  assert.deepEqual(Object.keys(concurrent[0].plan).sort(), [...PLAN_KEYS]);
  assert.equal(concurrent[0].plan.base_plan_revision, null);
  assert.equal(concurrent[0].plan.calculated_at, '2026-08-04T00:00:00.000Z');
  assert.equal(concurrent[0].plan.created_at, '2026-08-04T09:00:00.000Z');
  assert.equal('input_fingerprint' in concurrent[0].plan, false);
  assert.deepEqual(await repository.getCurrentAdaptiveLearningPlan(username), concurrent[0].plan);

  const duplicateReplayMutations = [
    ['forecast confidence', (plan) => { plan.forecast.confidence += 1; }],
    ['allocation percentage', (plan) => {
      const [target, donor] = plan.allocation.skills.filter((skill) => skill.module === 'vocabulary');
      target.percentage += 1;
      donor.percentage -= 1;
    }],
    ['allocation reason', (plan) => { plan.allocation.skills[0].reasonCodes = ['maintenance']; }],
  ];
  for (const [name, mutate] of duplicateReplayMutations) {
    const forgedReplay = structuredClone(firstCandidate);
    forgedReplay.id = crypto.randomUUID();
    mutate(forgedReplay.plan);
    await assert.rejects(
      repository.saveAdaptiveLearningPlan(username, forgedReplay),
      /ADAPTIVE_PLAN_REPLAY_MISMATCH/u,
      `a retained fingerprint cannot replay changed ${name}`,
    );
  }
  const freshSameBucketNow = new Date('2026-08-04T23:59:59.999Z');
  const freshSameBucketPlan = buildAdaptiveLearningPlan({
    goal: firstGoal,
    profile: firstProfile,
    now: freshSameBucketNow,
  });
  const freshSameBucketReplay = await repository.saveAdaptiveLearningPlan(username, candidate({
    goal: firstGoal,
    profile: firstProfile,
    plan: freshSameBucketPlan,
    basePlanRevision: null,
    now: freshSameBucketNow,
  }));
  assert.equal(freshSameBucketReplay.created, false);
  assert.equal(freshSameBucketReplay.replayed, true);
  assert.equal(freshSameBucketReplay.plan.revision, 1);

  const nextProfile = {
    ...firstProfile,
    evidenceSourceCount: 1,
    evidenceObservedAt: '2026-08-05T08:00:00.000Z',
  };
  await repository.saveAdaptiveLearningProfile(username, nextProfile, {
    now: new Date('2026-08-05T08:30:00.000Z'),
  });
  const staleProfilePlan = buildAdaptiveLearningPlan({
    goal: firstGoal,
    profile: firstProfile,
    previousPlan: concurrent[0].plan,
    now: new Date('2026-08-05T09:00:00.000Z'),
  });
  await assert.rejects(
    repository.saveAdaptiveLearningPlan(username, candidate({
      goal: firstGoal,
      profile: firstProfile,
      plan: staleProfilePlan,
      basePlanRevision: 1,
      now: new Date('2026-08-05T09:00:00.000Z'),
    })),
    /ADAPTIVE_PLAN_PROFILE_STALE/u,
    'a candidate built before a newer authoritative profile cannot become current',
  );
  const secondPlan = buildAdaptiveLearningPlan({
    goal: firstGoal,
    profile: nextProfile,
    previousPlan: concurrent[0].plan,
    now: new Date('2026-08-05T09:00:00.000Z'),
  });
  const secondCandidate = candidate({
    goal: firstGoal,
    profile: nextProfile,
    plan: secondPlan,
    basePlanRevision: 1,
    now: new Date('2026-08-05T09:00:00.000Z'),
  });
  const second = await repository.saveAdaptiveLearningPlan(username, secondCandidate);
  assert.equal(second.created, true);
  assert.equal(second.plan.revision, 2);
  assert.equal(second.plan.base_plan_revision, 1);

  await assert.rejects(
    repository.saveAdaptiveLearningPlan(username, {
      inputFingerprint: firstCandidate.inputFingerprint,
    }),
    /ADAPTIVE_PLAN_INVALID/u,
    'a bare known fingerprint cannot bypass the complete candidate contract',
  );
  await assert.rejects(
    repository.saveAdaptiveLearningPlan(username, {
      ...secondCandidate,
      id: crypto.randomUUID(),
      inputFingerprint: firstCandidate.inputFingerprint,
    }),
    /ADAPTIVE_PLAN_INVALID/u,
    'a known fingerprint must still match the supplied historical metadata',
  );

  const historicalFingerprint = await repository.saveAdaptiveLearningPlan(username, {
    ...firstCandidate,
    id: crypto.randomUUID(),
  });
  assert.equal(historicalFingerprint.created, false);
  assert.equal(historicalFingerprint.replayed, true);
  assert.equal(historicalFingerprint.stale, true);
  assert.equal(historicalFingerprint.reason, 'historical_fingerprint');
  assert.equal(historicalFingerprint.plan.revision, 2,
    'a historical fingerprint never escapes as the live plan');

  await assert.rejects(
    repository.saveAdaptiveLearningPlan(username, candidate({
      goal: firstGoal,
      profile: firstProfile,
      plan: buildAdaptiveLearningPlan({
        goal: firstGoal,
        profile: firstProfile,
        previousPlan: second.plan,
        now: new Date('2026-08-06T09:00:00.000Z'),
      }),
      basePlanRevision: 2,
      now: new Date('2026-08-06T09:00:00.000Z'),
    })),
    /ADAPTIVE_PLAN_PROFILE_STALE/u,
  );

  const newAlgorithmProfile = {
    ...firstProfile,
    profileCalculationRevision: 2,
    evidenceSourceCount: 0,
    evidenceObservedAt: null,
  };
  await repository.saveAdaptiveLearningProfile(username, newAlgorithmProfile, {
    now: new Date('2026-08-06T08:30:00.000Z'),
  });
  const newAlgorithmPlan = buildAdaptiveLearningPlan({
    goal: firstGoal,
    profile: newAlgorithmProfile,
    previousPlan: second.plan,
    now: new Date('2026-08-06T09:00:00.000Z'),
  });
  const newAlgorithm = await repository.saveAdaptiveLearningPlan(username, candidate({
    goal: firstGoal,
    profile: newAlgorithmProfile,
    plan: newAlgorithmPlan,
    basePlanRevision: 2,
    now: new Date('2026-08-06T09:00:00.000Z'),
  }));
  assert.equal(newAlgorithm.created, true);
  assert.equal(newAlgorithm.plan.revision, 3);
  assert.equal(newAlgorithm.plan.profile_calculation_revision, 2);
  assert.equal(newAlgorithm.plan.profile_evidence_source_count, 0);

  const olderAlgorithmProfile = {
    ...nextProfile,
    profileCalculationRevision: 1,
    evidenceSourceCount: 100,
    evidenceObservedAt: '2026-08-07T08:00:00.000Z',
  };
  await assert.rejects(
    repository.saveAdaptiveLearningPlan(username, candidate({
      goal: firstGoal,
      profile: olderAlgorithmProfile,
      plan: buildAdaptiveLearningPlan({
        goal: firstGoal,
        profile: olderAlgorithmProfile,
        previousPlan: newAlgorithm.plan,
        now: new Date('2026-08-07T09:00:00.000Z'),
      }),
      basePlanRevision: 3,
      now: new Date('2026-08-07T09:00:00.000Z'),
    })),
    /ADAPTIVE_PLAN_PROFILE_STALE/u,
  );

  const winningProfile = {
    ...newAlgorithmProfile,
    evidenceSourceCount: 1,
    evidenceObservedAt: '2026-08-08T08:00:00.000Z',
  };
  winningProfile.skills = winningProfile.skills.map((skill) => skill.module === 'listening'
    ? { ...skill, mastery: 20, uncertainty: 90 }
    : skill);
  await repository.saveAdaptiveLearningProfile(username, winningProfile, {
    now: new Date('2026-08-08T08:30:00.000Z'),
  });
  const winningPlan = buildAdaptiveLearningPlan({
    goal: firstGoal,
    profile: winningProfile,
    previousPlan: newAlgorithm.plan,
    now: new Date('2026-08-08T09:00:00.000Z'),
  });
  const winner = await repository.saveAdaptiveLearningPlan(username, candidate({
    goal: firstGoal,
    profile: winningProfile,
    plan: winningPlan,
    basePlanRevision: 3,
    now: new Date('2026-08-08T09:00:00.000Z'),
  }));
  assert.equal(winner.plan.revision, 4);

  const newerProfile = {
    ...winningProfile,
    evidenceSourceCount: 2,
    evidenceObservedAt: '2026-08-09T08:00:00.000Z',
  };
  newerProfile.skills = newerProfile.skills.map((skill) => skill.module === 'writing'
    ? { ...skill, mastery: 5, uncertainty: 95 }
    : skill);
  await repository.saveAdaptiveLearningProfile(username, newerProfile, {
    now: new Date('2026-08-09T08:30:00.000Z'),
  });
  const staleBasePlan = buildAdaptiveLearningPlan({
    goal: firstGoal,
    profile: newerProfile,
    previousPlan: newAlgorithm.plan,
    now: new Date('2026-08-09T09:00:00.000Z'),
  });
  const conflict = await repository.saveAdaptiveLearningPlan(username, candidate({
    goal: firstGoal,
    profile: newerProfile,
    plan: staleBasePlan,
    basePlanRevision: 3,
    now: new Date('2026-08-09T09:00:00.000Z'),
  }));
  assert.equal(conflict.created, false);
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.reason, 'base_plan_revision_mismatch');
  assert.equal(conflict.plan.revision, 4);

  const recomputedPlan = buildAdaptiveLearningPlan({
    goal: firstGoal,
    profile: newerProfile,
    previousPlan: conflict.plan,
    now: new Date('2026-08-09T09:00:00.000Z'),
  });
  const recomputed = await repository.saveAdaptiveLearningPlan(username, candidate({
    goal: firstGoal,
    profile: newerProfile,
    plan: recomputedPlan,
    basePlanRevision: 4,
    now: new Date('2026-08-09T09:00:00.000Z'),
  }));
  assert.equal(recomputed.created, true);
  assert.equal(recomputed.plan.revision, 5);
  assertBoundedTransition(assert, conflict.plan, recomputed.plan);

  const criticalProfile = {
    ...newerProfile,
    evidenceSourceCount: 3,
    evidenceObservedAt: '2026-08-10T06:00:00.000Z',
    skills: newerProfile.skills.map((skill) => skill.id === 'ege.listening.detail' ? {
      ...skill,
      dueState: 'critical_due',
      criticalRetentionExpiresAt: '2026-08-10T12:00:00.000Z',
      mastery: 0,
      uncertainty: 100,
    } : skill),
  };
  const authoritativeCriticalProfile = {
    ...criticalProfile,
    skills: newerProfile.skills,
  };
  await repository.saveAdaptiveLearningProfile(username, authoritativeCriticalProfile, {
    now: new Date('2026-08-10T06:30:00.000Z'),
  });
  const criticalPlan = buildAdaptiveLearningPlan({
    goal: firstGoal,
    profile: criticalProfile,
    previousPlan: recomputed.plan,
    now: new Date('2026-08-10T07:00:00.000Z'),
  });
  const criticalCandidate = candidate({
    goal: firstGoal,
    profile: criticalProfile,
    plan: criticalPlan,
    basePlanRevision: 5,
    now: new Date('2026-08-10T07:00:00.000Z'),
  });
  await assert.rejects(
    repository.saveAdaptiveLearningPlan(username, criticalCandidate),
    /ADAPTIVE_PLAN_AUTHORITY_MISMATCH/u,
    'an unpersisted synthetic critical-expiry signal cannot alter a saved plan',
  );
  const authoritativeCriticalPlan = buildAdaptiveLearningPlan({
    goal: firstGoal,
    profile: authoritativeCriticalProfile,
    previousPlan: recomputed.plan,
    now: new Date('2026-08-10T07:00:00.000Z'),
  });
  const savedCriticalPriority = await repository.saveAdaptiveLearningPlan(username, candidate({
    goal: firstGoal,
    profile: authoritativeCriticalProfile,
    plan: authoritativeCriticalPlan,
    basePlanRevision: 5,
    now: new Date('2026-08-10T07:00:00.000Z'),
  }));
  assert.equal(savedCriticalPriority.created, true);
  assert.equal(savedCriticalPriority.plan.revision, 6);
  assert.equal(savedCriticalPriority.plan.stability.bypassReason, null);
  assert.equal(savedCriticalPriority.plan.allocation.skills
    .find((skill) => skill.id === 'ege.listening.detail')
    .reasonCodes.includes('critical_retention_expiry'), false);

  const nextOrdinaryPlan = buildAdaptiveLearningPlan({
    goal: firstGoal,
    profile: authoritativeCriticalProfile,
    previousPlan: savedCriticalPriority.plan,
    now: new Date('2026-08-11T07:30:00.000Z'),
  });
  const ordinaryShift = shiftAllocationBeyondOrdinaryLimit(nextOrdinaryPlan);
  await assert.rejects(
    repository.saveAdaptiveLearningPlan(username, candidate({
      goal: firstGoal,
      profile: authoritativeCriticalProfile,
      plan: ordinaryShift.shifted,
      basePlanRevision: 6,
      now: new Date('2026-08-11T07:30:00.000Z'),
    })),
    /ADAPTIVE_PLAN_AUTHORITY_MISMATCH/u,
    'shape-valid allocation changes cannot replace the deterministic authoritative plan',
  );

  const forgedCritical = structuredClone(ordinaryShift.shifted);
  const bypassedSkillIds = [ordinaryShift.target, ...ordinaryShift.donors].map((skill) => skill.id);
  for (const skill of forgedCritical.allocation.skills) {
    if (bypassedSkillIds.includes(skill.id)
      && !skill.reasonCodes.includes('critical_retention_expiry')) {
      skill.reasonCodes.push('critical_retention_expiry');
    }
  }
  for (const module of forgedCritical.allocation.modules) {
    if (ordinaryShift.affectedModules.includes(module.id)
      && !module.reasonCodes.includes('critical_retention_expiry')) {
      module.reasonCodes.push('critical_retention_expiry');
    }
  }
  forgedCritical.stability = {
    ...forgedCritical.stability,
    bypassReason: 'critical_retention_expiry',
    bypassedSkillIds,
    bypassedModuleIds: ordinaryShift.affectedModules,
  };
  await assert.rejects(
    repository.saveAdaptiveLearningPlan(username, candidate({
      goal: firstGoal,
      profile: authoritativeCriticalProfile,
      plan: forgedCritical,
      basePlanRevision: 6,
      now: new Date('2026-08-11T07:30:00.000Z'),
    }), { stabilityContext: { profile: criticalProfile, owner: username } }),
    /ADAPTIVE_PLAN_AUTHORITY_MISMATCH/u,
    'a caller-supplied synthetic profile/context cannot authorize a critical bypass',
  );

  const forgedGoalBypass = {
    ...nextOrdinaryPlan,
    goalRevision: firstGoal.revision + 1,
    stability: {
      ...nextOrdinaryPlan.stability,
      applied: false,
      bypassReason: 'goal_changed',
    },
  };
  await assert.rejects(
    repository.saveAdaptiveLearningPlan(username, candidate({
      goal: firstGoal,
      profile: authoritativeCriticalProfile,
      plan: forgedGoalBypass,
      basePlanRevision: 6,
      now: new Date('2026-08-11T07:30:00.000Z'),
    })),
    /ADAPTIVE_PLAN_INVALID/u,
    'plan JSON cannot forge a goal revision to obtain a repository stability bypass',
  );

  const secondGoal = (await repository.saveAdaptiveLearningGoal(username, {
    id: crypto.randomUUID(), idempotencyKey: 'plan-contract-goal-0002', requestHash: '2'.repeat(64),
    targetExam: 'ege_english', targetScore: 90, examDate: '2027-06-01', weeklyMinutes: 360,
    now: new Date('2026-08-10T08:00:00.000Z'),
  })).goal;
  const resetPlan = buildAdaptiveLearningPlan({
    goal: secondGoal,
    profile: authoritativeCriticalProfile,
    previousPlan: savedCriticalPriority.plan,
    now: new Date('2026-08-11T09:00:00.000Z'),
  });
  const reset = await repository.saveAdaptiveLearningPlan(username, candidate({
    goal: secondGoal,
    profile: authoritativeCriticalProfile,
    plan: resetPlan,
    basePlanRevision: 6,
    now: new Date('2026-08-11T09:00:00.000Z'),
  }));
  assert.equal(reset.created, true, 'a new current goal revision explicitly resets evidence ordering');
  assert.equal(reset.plan.revision, 7);
  assert.equal(reset.plan.goal_revision, 2);
  assert.equal(reset.plan.stability.bypassReason, 'goal_changed');

  const historicalAfterGoalChange = await repository.saveAdaptiveLearningPlan(username, {
    ...firstCandidate,
    id: crypto.randomUUID(),
  });
  assert.equal(historicalAfterGoalChange.created, false);
  assert.equal(historicalAfterGoalChange.replayed, true);
  assert.equal(historicalAfterGoalChange.stale, true);
  assert.equal(historicalAfterGoalChange.reason, 'historical_fingerprint');
  assert.equal(historicalAfterGoalChange.plan.id, reset.plan.id);
  assert.equal(historicalAfterGoalChange.plan.goal_revision, 2);

  const structurallyValidOldGoalPlan = buildAdaptiveLearningPlan({
    goal: firstGoal,
    profile: newerProfile,
    previousPlan: reset.plan,
    now: new Date('2026-08-11T09:00:00.000Z'),
  });
  await assert.rejects(
    repository.saveAdaptiveLearningPlan(username, candidate({
      goal: firstGoal,
      profile: newerProfile,
      plan: structurallyValidOldGoalPlan,
      basePlanRevision: reset.plan.revision,
      now: new Date('2026-08-11T09:00:00.000Z'),
    })),
    /ADAPTIVE_PLAN_GOAL_STALE/u,
  );

  const exported = await repository.exportUserData(username);
  assert.deepEqual(exported.adaptive_learning_plan_revisions.at(-1), reset.plan);
  assert.equal(JSON.stringify(exported.adaptive_learning_plan_revisions).includes('input_fingerprint'), false);
  return reset.plan;
}
