import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

import { buildAdaptiveLearningProfile, EGE_SKILL_TAXONOMY } from '../adaptive-learning/profile.js';
import {
  applyAdaptiveRetentionState,
  buildAdaptiveLanguageOrientation,
  buildAdaptiveRetentionState,
} from '../adaptive-learning/retention.js';
import {
  ADAPTIVE_ACTIVITY_REGISTRY,
  adaptiveActivityRequiresPremiumDepth,
  buildAdaptiveSessionPreview,
} from '../adaptive-learning/session.js';
import { adaptiveEvidenceContext } from '../adaptive-learning/session-execution.js';
import { createFileRepository } from '../storage/file-repository.js';
import { createAdaptiveLearningRoutes } from '../routes/adaptive-learning.js';
import { createVoiceTutorRoutes } from '../routes/voice-tutor.js';
import { completeShortAdaptiveDiagnostic } from './support/adaptive-diagnostic-public.js';

const NOW = new Date('2026-08-10T12:00:00.000Z');

function allocation() {
  return EGE_SKILL_TAXONOMY.skills.map((skill, index) => ({
    id: skill.id,
    label: skill.label,
    module: skill.module,
    percentage: [10, 6, 14, 8, 7, 10, 8, 12, 6, 7, 5, 7][index],
    activityType: 'practice',
    reasonCodes: ['target_gap'],
  }));
}

function plan() {
  return {
    id: '71000000-0000-4000-8000-000000000006',
    revision: 6,
    version: 'adaptive-plan-v1',
    taxonomyVersion: 'ege-en-v2',
    allocation: { skills: allocation() },
  };
}

function dueRecoveryMap() {
  return {
    skills: [{
      recovery_id: '72000000-0000-4000-8000-000000000006',
      skill_id: 'ege.grammar.forms',
      skill_label: 'Грамматические формы',
      module: 'grammar',
      repeats: [{
        id: '73000000-0000-4000-8000-000000000006',
        stage: 'day_1',
        task_id: 'voice-repeat.72000000-0000-4000-8000-000000000006.day_1.v1',
        prompt: 'raw prompt must not be copied',
        due_at: '2026-08-10T09:00:00.000Z',
        window_ends_at: '2026-08-11T09:00:00.000Z',
        status: 'due',
      }],
    }],
  };
}

test('day-1/day-7 retention state is reference-only, marks due skill and schedules 4-6 week probes', () => {
  const baseProfile = buildAdaptiveLearningProfile({
    recoveries: [{
      id: '72000000-0000-4000-8000-000000000006',
      module: 'grammar',
      skill_id: 'ege.grammar.forms',
      initial_micro_check_passed: true,
      initial_transfer_passed: true,
      terminal_outcome: 'resolved',
      observed_at: '2026-08-09T09:00:00.000Z',
    }],
    diagnosticCompletions: [{
      catalog_version: 'ege-short-diagnostic-v1',
      completed_at: '2026-07-13T12:00:00.000Z',
    }],
  });
  const retention = buildAdaptiveRetentionState({
    profile: baseProfile,
    recoveryMap: dueRecoveryMap(),
    diagnosticCompletions: [{ catalog_version: 'ege-short-diagnostic-v1', completed_at: '2026-07-13T12:00:00.000Z' }],
    now: NOW,
  });
  assert.deepEqual(Object.keys(retention.dueChecks[0]).sort(), [
    'dueAt', 'module', 'repeatId', 'skillId', 'stage', 'status', 'taskId', 'windowEndsAt',
  ]);
  assert.equal(JSON.stringify(retention).includes('raw prompt'), false);
  assert.equal(retention.rediagnostic.cadenceDays, 28);
  assert.equal(retention.rediagnostic.due, true);

  const enriched = applyAdaptiveRetentionState(baseProfile, retention);
  const grammar = enriched.skills.find((skill) => skill.id === 'ege.grammar.forms');
  assert.equal(grammar.dueState, 'due');
  assert.ok(grammar.mastery <= 49, 'assisted recovery must not prove mastery');
  assert.equal(enriched.needsDiagnostic, false, 'scheduled refresh must not become an initial gate');
  assert.ok(enriched.explanationCodes.includes('rediagnostic_due'));
});

test('confidence and independent coverage choose a truthful 28/35/42-day cadence', () => {
  const sparse = buildAdaptiveLearningProfile();
  const medium = structuredClone(sparse);
  medium.confidence = 65;
  medium.establishedSkillCount = Math.ceil(EGE_SKILL_TAXONOMY.skills.length / 2);
  const strong = structuredClone(sparse);
  strong.confidence = 85;
  strong.establishedSkillCount = EGE_SKILL_TAXONOMY.skills.length;
  for (const [profile, expected] of [[sparse, 28], [medium, 35], [strong, 42]]) {
    assert.equal(buildAdaptiveRetentionState({ profile, recoveryMap: {}, now: NOW }).rediagnostic.cadenceDays, expected);
  }
});

test('due recovery remains executable while deep Writing/Speaking is Premium-filtered server-side', () => {
  const retention = buildAdaptiveRetentionState({
    profile: buildAdaptiveLearningProfile(), recoveryMap: dueRecoveryMap(), now: NOW,
  });
  const profile = applyAdaptiveRetentionState(
    buildAdaptiveLearningProfile(),
    retention,
  );
  const input = {
    plan: plan(), goal: { weekly_minutes: 300 }, profile,
    retention, weekUsage: [], durationMinutes: 45, now: NOW,
  };
  const duePlanSkill = input.plan.allocation.skills.find((skill) => skill.id === 'ege.grammar.forms');
  duePlanSkill.activityType = 'retention_review';
  duePlanSkill.reasonCodes = ['due_review', 'target_gap'];
  const premium = buildAdaptiveSessionPreview({
    ...input, access: { tier: 'premium', capabilities: { premiumDepth: true } },
  });
  assert.equal(premium.blocks[0].activityId, 'voice_tutor_recovery');
  assert.equal(premium.blocks[0].launch.kind, 'voice_tutor_recovery');
  assert.equal(premium.blocks[0].launch.repeatId, retention.dueChecks[0].repeatId);
  assert.equal(premium.blocks[0].launch.taskId, retention.dueChecks[0].taskId);
  assert.equal(premium.blocks[0].launch.dueAt, retention.dueChecks[0].dueAt);
  assert.equal(premium.blocks[0].launch.windowEndsAt, retention.dueChecks[0].windowEndsAt);
  assert.equal(premium.blocks[0].reasonCodes.includes('due_review'), true);
  assert.equal(JSON.stringify(premium).includes('raw prompt'), false);

  const base = buildAdaptiveSessionPreview({
    ...input, access: { tier: 'base', capabilities: { premiumDepth: false } },
  });
  assert.equal(base.blocks.some((block) => ['writing', 'speaking'].includes(block.module)), false);
  assert.equal(base.blocks.some((block) => block.activityId === 'voice_tutor_recovery'), true);

  const writingProfile = buildAdaptiveLearningProfile();
  writingProfile.skills.find((skill) => skill.id === 'ege.writing.email').dueState = 'due';
  const writingRegistry = {
    ...ADAPTIVE_ACTIVITY_REGISTRY,
    activities: ADAPTIVE_ACTIVITY_REGISTRY.activities.filter((activity) => (
      activity.skillId === 'ege.writing.email' && activity.launch.kind === 'voice_tutor_recovery'
    )),
  };
  const writingPlan = plan();
  const dueWriting = writingPlan.allocation.skills.find((skill) => skill.id === 'ege.writing.email');
  dueWriting.activityType = 'retention_review';
  dueWriting.reasonCodes = ['due_review', 'target_gap'];
  const writingRetention = {
    version: 'adaptive-retention-v1', calculatedAt: NOW.toISOString(),
    dueChecks: [{
      repeatId: '73500000-0000-4000-8000-000000000006',
      taskId: 'voice-repeat.73500000-0000-4000-8000-000000000006.day_1.v1',
      skillId: 'ege.writing.email', module: 'writing', stage: 'day_1', status: 'due',
      dueAt: '2026-08-10T09:00:00.000Z', windowEndsAt: '2026-08-11T09:00:00.000Z',
    }],
  };
  const retainedWriting = buildAdaptiveSessionPreview({
    ...input, plan: writingPlan, profile: writingProfile, registry: writingRegistry, durationMinutes: 15,
    retention: writingRetention,
    access: { tier: 'base', capabilities: { premiumDepth: false } },
  });
  assert.equal(retainedWriting.blocks[0].activityId, 'voice_tutor_recovery');
  assert.equal(retainedWriting.blocks[0].module, 'writing');
  assert.equal(adaptiveActivityRequiresPremiumDepth(retainedWriting.blocks[0]), false);
  assert.equal(adaptiveActivityRequiresPremiumDepth({
    module: 'writing', launch: { kind: 'writing_task' },
  }), true);
});

test('an owed exact repeat stays high-priority after same-skill weekly planning', () => {
  const retention = buildAdaptiveRetentionState({
    profile: buildAdaptiveLearningProfile(), recoveryMap: dueRecoveryMap(), now: NOW,
  });
  const profile = applyAdaptiveRetentionState(buildAdaptiveLearningProfile(), retention);
  const currentPlan = plan();
  const dueSkill = currentPlan.allocation.skills.find((skill) => skill.id === 'ege.grammar.forms');
  dueSkill.activityType = 'retention_review';
  dueSkill.reasonCodes = ['due_review', 'target_gap'];
  const preview = buildAdaptiveSessionPreview({
    plan: currentPlan, goal: { weekly_minutes: 300 }, profile, retention,
    weekUsage: [{ skillId: 'ege.grammar.forms', plannedMinutes: 300, completedMinutes: 0 }],
    durationMinutes: 15, now: NOW,
  });
  assert.equal(preview.blocks[0].launch.kind, 'voice_tutor_recovery');
  assert.equal(preview.blocks[0].launch.repeatId, retention.dueChecks[0].repeatId);
  assert.equal(preview.blocks[0].reasonCodes.includes('due_review'), true);
  const longPreview = buildAdaptiveSessionPreview({
    plan: currentPlan, goal: { weekly_minutes: 300 }, profile, retention,
    weekUsage: [{ skillId: 'ege.grammar.forms', plannedMinutes: 300, completedMinutes: 0 }],
    durationMinutes: 120, now: NOW,
  });
  assert.equal(longPreview.blocks.filter((block) => (
    block.launch?.repeatId === retention.dueChecks[0].repeatId
  )).length, 1, 'one owed repeat cannot fill several blocks in the same session');
});

test('day-1 stays the exact executable repeat while an overdue day-7 is still locked', () => {
  const recoveryMap = dueRecoveryMap();
  recoveryMap.skills[0].repeats[0].status = 'overdue';
  recoveryMap.skills[0].repeats.push({
    id: '73100000-0000-4000-8000-000000000006',
    stage: 'day_7',
    task_id: 'voice-repeat.72000000-0000-4000-8000-000000000006.day_7.v1',
    prompt: 'another raw prompt',
    due_at: '2026-08-09T10:00:00.000Z',
    window_ends_at: '2026-08-10T10:00:00.000Z',
    status: 'overdue',
  });
  const baseProfile = buildAdaptiveLearningProfile();
  const retention = buildAdaptiveRetentionState({ profile: baseProfile, recoveryMap, now: NOW });
  assert.deepEqual(retention.dueChecks.map((check) => check.stage), ['day_1']);
  const profile = applyAdaptiveRetentionState(baseProfile, retention);
  const currentPlan = plan();
  const dueSkill = currentPlan.allocation.skills.find((skill) => skill.id === 'ege.grammar.forms');
  dueSkill.activityType = 'retention_review';
  dueSkill.reasonCodes = ['due_review', 'target_gap'];
  const preview = buildAdaptiveSessionPreview({
    plan: currentPlan, goal: { weekly_minutes: 300 }, profile, retention,
    weekUsage: [], durationMinutes: 15, now: NOW,
  });
  assert.equal(preview.blocks[0].launch.stage, 'day_1');
  assert.equal(preview.blocks[0].launch.repeatId, recoveryMap.skills[0].repeats[0].id);

  recoveryMap.skills[0].repeats[0] = {
    ...recoveryMap.skills[0].repeats[0],
    status: 'passed',
    attempt: { id: '73200000-0000-4000-8000-000000000006', passed: true },
  };
  const unlocked = buildAdaptiveRetentionState({ profile: baseProfile, recoveryMap, now: NOW });
  assert.deepEqual(unlocked.dueChecks.map((check) => check.stage), ['day_7']);
});

test('exact independent repeats are scheduled reviews before Writing/Speaking assistance labels', () => {
  assert.equal(adaptiveEvidenceContext({
    kind: 'learning', module: 'writing', reasonCodes: ['due_review'],
    launch: { kind: 'voice_tutor_recovery' },
  }), 'scheduled_review');
  assert.equal(adaptiveEvidenceContext({
    kind: 'learning', module: 'speaking', reasonCodes: ['due_review'],
    launch: { kind: 'voice_tutor_recovery' },
  }), 'scheduled_review');
  assert.equal(adaptiveEvidenceContext({
    kind: 'learning', module: 'writing', reasonCodes: ['target_gap'],
    launch: { kind: 'writing_task' },
  }), 'ai_assisted_review');
});

test('CEFR/IELTS orientation is approximate and refuses assisted-only mastery', () => {
  const assisted = buildAdaptiveLearningProfile({ recoveries: [{
    module: 'grammar', skill_id: 'ege.grammar.forms',
    initial_micro_check_passed: true, initial_transfer_passed: true,
    terminal_outcome: 'resolved', observed_at: NOW.toISOString(),
  }] });
  const result = buildAdaptiveLanguageOrientation(assisted);
  assert.equal(result.approximate, true);
  assert.equal(result.officialIeltsResult, false);
  assert.equal(result.basis.independentlyEstablishedSkills, 0);
  assert.equal(result.cefr.range, 'insufficient_evidence');
  assert.equal(result.ielts.range, 'insufficient_evidence');
});

test('repository accepts only a monotonic due-state refresh for an unchanged evidence watermark', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'adaptive-retention-refresh-'));
  const repository = createFileRepository(path.join(directory, 'data.json'));
  try {
    const owner = await repository.createTelegramUser(9806, 'Retention Refresh');
    const base = buildAdaptiveLearningProfile();
    await repository.saveAdaptiveLearningProfile(owner, base, { now: new Date('2026-08-10T01:00:00.000Z') });
    const due = structuredClone(base);
    due.skills.find((skill) => skill.id === 'ege.grammar.forms').dueState = 'due';
    due.skills.find((skill) => skill.id === 'ege.grammar.forms').explanationCode = 'retention_check_due';
    const injected = structuredClone(due);
    injected.explanationCodes = [...injected.explanationCodes, 'caller_injected_reason'];
    const rejectedInjection = await repository.saveAdaptiveLearningProfile(owner, injected, { now: NOW });
    assert.equal(rejectedInjection.estimates.find((skill) => skill.skill_id === 'ege.grammar.forms').due_state, 'not_due');
    assert.equal(rejectedInjection.explanation_codes.includes('caller_injected_reason'), false);
    const refreshed = await repository.saveAdaptiveLearningProfile(owner, due, { now: NOW });
    assert.equal(refreshed.estimates.find((skill) => skill.skill_id === 'ege.grammar.forms').due_state, 'due');

    const critical = structuredClone(due);
    critical.skills.find((skill) => skill.id === 'ege.grammar.forms').dueState = 'critical_due';
    critical.skills.find((skill) => skill.id === 'ege.grammar.forms').criticalRetentionExpiresAt = '2026-08-11T09:00:00.000Z';
    const escalated = await repository.saveAdaptiveLearningProfile(owner, critical, {
      now: new Date('2026-08-10T12:30:00.000Z'),
    });
    assert.equal(escalated.estimates.find((skill) => skill.skill_id === 'ege.grammar.forms').due_state, 'critical_due');

    const stale = await repository.saveAdaptiveLearningProfile(owner, base, { now: new Date('2026-08-10T13:00:00.000Z') });
    assert.equal(stale.estimates.find((skill) => skill.skill_id === 'ege.grammar.forms').due_state, 'critical_due');
  } finally {
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('due repeat executes end-to-end through the existing ledger and orientation stays Premium-only', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'adaptive-retention-e2e-'));
  const dataPath = path.join(directory, 'data.json');
  let repository = createFileRepository(dataPath);
  let authorityNow = new Date(NOW);
  let server;
  try {
    const owner = await repository.createTelegramUser(9816, 'Retention Premium');
    const base = await repository.createTelegramUser(9817, 'Retention Base');
    for (const [telegramId, username] of [[9816, owner], [9817, base]]) {
      await repository.grantDays(telegramId, 30, username);
    }
    await repository.setEntitlement(owner, 'voice_tutor', {
      startsAt: new Date('2026-08-01T00:00:00.000Z'),
      endsAt: new Date('2026-09-01T00:00:00.000Z'),
    });
    await repository.close();

    const recoveryId = '74000000-0000-4000-8000-000000000006';
    const repeatId = '75000000-0000-4000-8000-000000000006';
    const taskId = `voice-repeat.${recoveryId}.day_1.v1`;
    const olderRecoveryId = '74100000-0000-4000-8000-000000000006';
    const olderRepeatId = '75100000-0000-4000-8000-000000000006';
    const olderTaskId = `voice-repeat.${olderRecoveryId}.day_1.v1`;
    const state = JSON.parse(await fs.readFile(dataPath, 'utf8'));
    const recoveryTemplate = {
      id: recoveryId, username: owner,
      session_id: '76000000-0000-4000-8000-000000000006',
      skill_id: 'ege.grammar.forms', skill_label: 'Грамматические формы', module: 'grammar',
      rule_id: 'grammar.forms.v1', origin_item_id: 'origin.item.v1',
      origin_transfer_task_id: 'origin.transfer.v1', initial_micro_check_passed: true,
      initial_transfer_passed: true, terminal_outcome: 'resolved', potential_ege_points: 1,
      repeat_tasks: {
        day_1: { prompt: 'Complete the retained form.', answers: ['was built'] },
        day_7: { prompt: 'Complete another retained form.', answers: ['were built'] },
      },
      observed_at: '2026-08-09T09:00:00.000Z',
    };
    state.voice_tutor_recoveries.push({
      ...recoveryTemplate,
      id: olderRecoveryId,
      session_id: '76100000-0000-4000-8000-000000000006',
      observed_at: '2026-08-08T09:00:00.000Z',
    }, recoveryTemplate);
    state.voice_tutor_repeats.push({
      id: olderRepeatId, recovery_id: olderRecoveryId, stage: 'day_1', task_id: olderTaskId,
      due_at: '2026-08-10T08:00:00.000Z', window_ends_at: '2026-08-11T08:00:00.000Z',
      superseded_at: null,
    }, {
      id: repeatId, recovery_id: recoveryId, stage: 'day_1', task_id: taskId,
      due_at: '2026-08-10T09:00:00.000Z', window_ends_at: '2026-08-11T09:00:00.000Z',
      superseded_at: null,
    }, {
      id: '77000000-0000-4000-8000-000000000006', recovery_id: recoveryId,
      stage: 'day_7', task_id: `voice-repeat.${recoveryId}.day_7.v1`,
      due_at: '2026-08-09T08:00:00.000Z', window_ends_at: '2026-08-10T08:00:00.000Z',
      superseded_at: null,
    });
    await fs.writeFile(dataPath, JSON.stringify(state));
    repository = createFileRepository(dataPath, {
      adaptiveMutationNow: () => new Date(authorityNow),
    });

    const authentication = { auth(req, res, next) {
      const username = String(req.headers['x-test-user'] || '');
      if (!username) return res.status(401).json({ error: { code: 'UNAUTHORIZED' } });
      req.user = username;
      next();
    } };
    const limits = { dailySeconds: 600, monthlySeconds: 7_200, sessionSeconds: 300 };
    const app = express();
    app.use(express.json());
    app.use(createAdaptiveLearningRoutes({
      authentication, db: repository, enabled: true, now: () => new Date(NOW),
      executionTokenSecret: 'adaptive-retention-test-secret-32-characters',
      voiceTutorLimits: limits,
    }));
    app.use(createVoiceTutorRoutes({
      authentication, db: repository, limits, now: () => new Date(NOW),
      realtimePolicy: { enabled: false }, privacyPolicyVersion: 'test-v1',
    }));
    app.use((error, req, res, next) => res.status(500).json({ error: { code: error.message } }));
    server = http.createServer(app);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const request = (username, pathname, options = {}) => fetch(
      `http://127.0.0.1:${server.address().port}${pathname}`,
      { ...options, headers: {
        'Content-Type': 'application/json', 'X-Test-User': username,
        'X-EasyBoost-Expected-Owner': username, ...(options.headers || {}),
      } },
    );

    assert.equal((await request(base, '/api/v1/adaptive-learning/orientation')).status, 403);
    const orientation = await request(owner, '/api/v1/adaptive-learning/orientation');
    assert.equal(orientation.status, 200);
    assert.equal((await orientation.json()).orientation.officialIeltsResult, false);

    const goal = await request(owner, '/api/v1/adaptive-learning/goal', {
      method: 'PUT', headers: { 'Idempotency-Key': 'retention-e2e-goal-0001' },
      body: JSON.stringify({
        targetExam: 'ege_english', targetScore: 85,
        examDate: '2027-06-01', weeklyMinutes: 300,
      }),
    });
    assert.equal(goal.status, 201);
    await completeShortAdaptiveDiagnostic(request, owner, 'retention-owner');
    const overview = await (await request(owner, '/api/v1/adaptive-learning/overview')).json();
    assert.equal(overview.retention.dueChecks[0].repeatId, repeatId);
    assert.deepEqual(overview.retention.dueChecks.map((check) => check.stage), ['day_1']);
    assert.equal(JSON.stringify(overview.retention).includes('Complete the retained form'), false);

    const previewResponse = await request(owner, '/api/v1/adaptive-learning/sessions/preview', {
      method: 'POST', body: JSON.stringify({ durationMinutes: 15 }),
    });
    assert.equal(previewResponse.status, 200);
    const preview = (await previewResponse.json()).preview;
    assert.equal(preview.blocks[0].activityId, 'voice_tutor_recovery');
    assert.equal(preview.blocks[0].launch.repeatId, repeatId);
    assert.equal(preview.blocks[0].launch.taskId, taskId);
    const createdResponse = await request(owner, '/api/v1/adaptive-learning/sessions', {
      method: 'POST', headers: { 'Idempotency-Key': 'retention-e2e-create-001' },
      body: JSON.stringify({ durationMinutes: 15, previewFingerprint: preview.previewFingerprint }),
    });
    assert.equal(createdResponse.status, 201, await createdResponse.clone().text());
    const session = (await createdResponse.json()).session;
    const startedResponse = await request(owner, `/api/v1/adaptive-learning/sessions/${session.id}/start`, {
      method: 'POST', headers: { 'Idempotency-Key': 'retention-e2e-start-0001' },
      body: JSON.stringify({ blockId: session.blocks[0].id, expectedRevision: 0 }),
    });
    assert.equal(startedResponse.status, 201);
    const started = await startedResponse.json();

    const mismatchedAttemptId = '78100000-0000-4000-8000-000000000006';
    const mismatchedRepeat = await request(owner, `/api/v1/voice-tutor/repeats/${olderRepeatId}/attempts`, {
      method: 'POST', body: JSON.stringify({
        attemptId: mismatchedAttemptId, taskId: olderTaskId, answer: 'was built',
        adaptiveExecutionClaim: started.executionClaim, adaptiveSessionId: session.id,
      }),
    });
    assert.equal(mismatchedRepeat.status, 409,
      'a same-skill repeat other than the one advertised by the block must not bind');
    const afterMismatch = JSON.parse(await fs.readFile(dataPath, 'utf8'));
    assert.equal(afterMismatch.voice_tutor_repeat_attempts.some((item) => item.id === mismatchedAttemptId), false,
      'repeat submission and adaptive claim binding must fail atomically');

    authorityNow = new Date(new Date(started.claimExpiresAt).getTime() + 1);
    const expiredAttemptId = '78200000-0000-4000-8000-000000000006';
    const expiredAttempt = await request(owner, `/api/v1/voice-tutor/repeats/${repeatId}/attempts`, {
      method: 'POST', body: JSON.stringify({
        attemptId: expiredAttemptId, taskId, answer: 'was built',
        adaptiveExecutionClaim: started.executionClaim, adaptiveSessionId: session.id,
      }),
    });
    assert.equal(expiredAttempt.status, 410);
    assert.equal((await expiredAttempt.json()).error.code, 'ADAPTIVE_EXECUTION_CLAIM_EXPIRED');
    assert.equal((JSON.parse(await fs.readFile(dataPath, 'utf8'))).voice_tutor_repeat_attempts
      .some((item) => item.id === expiredAttemptId), false);
    const restartedResponse = await request(owner,
      `/api/v1/adaptive-learning/sessions/${session.id}/start`, {
        method: 'POST', headers: { 'Idempotency-Key': 'retention-e2e-restart-001' },
        body: JSON.stringify({ blockId: session.blocks[0].id, expectedRevision: 1 }),
      });
    assert.equal(restartedResponse.status, 201, await restartedResponse.clone().text());
    const restarted = await restartedResponse.json();

    const strangerAttempt = await request(base, `/api/v1/voice-tutor/repeats/${repeatId}/attempts`, {
      method: 'POST', body: JSON.stringify({
        attemptId: '78000000-0000-4000-8000-000000000006', taskId, answer: 'was built',
      }),
    });
    assert.equal(strangerAttempt.status, 404);

    const attemptResponse = await request(owner, `/api/v1/voice-tutor/repeats/${repeatId}/attempts`, {
      method: 'POST', body: JSON.stringify({
        attemptId: '79000000-0000-4000-8000-000000000006', taskId, answer: 'was built',
        adaptiveExecutionClaim: restarted.executionClaim, adaptiveSessionId: session.id,
      }),
    });
    assert.equal(attemptResponse.status, 201, await attemptResponse.clone().text());
    const attempt = (await attemptResponse.json()).attempt;
    assert.equal(attempt.passed, true);
    const advancedResponse = await request(owner, `/api/v1/adaptive-learning/sessions/${session.id}/advance`, {
      method: 'POST', headers: { 'Idempotency-Key': 'retention-e2e-advance-01' },
      body: JSON.stringify({
        blockId: session.blocks[0].id, expectedRevision: 2,
        attempt: { type: 'voice_tutor_repeat', id: attempt.id },
      }),
    });
    assert.equal(advancedResponse.status, 200);
    const advanced = await advancedResponse.json();
    assert.equal(advanced.completedBlock.evidenceQuality, 'server_verified_unassisted');
    assert.equal(advanced.completedBlock.evidenceContext, 'scheduled_review');
    const exported = await repository.exportUserData(owner);
    assert.equal(JSON.stringify(exported.adaptive_learning_sessions).includes('Complete the retained form'), false);
    assert.equal(JSON.stringify(exported.adaptive_learning_session_events).includes('Complete the retained form'), false);
  } finally {
    if (server) await new Promise((resolve) => server.close(() => resolve()));
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
