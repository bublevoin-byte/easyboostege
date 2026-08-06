import crypto from 'node:crypto';

import { buildAdaptiveLearningPlan, adaptivePlanInputFingerprint } from '../../adaptive-learning/plan.js';
import { buildAdaptiveLearningProfile } from '../../adaptive-learning/profile.js';
import { adaptiveLearningProfilePublicDto } from '../../adaptive-learning/repository-dto.js';
import {
  ADAPTIVE_ACTIVITY_REGISTRY,
  buildAdaptiveSessionPreview,
  buildAdaptiveSessionReplacement,
  createAdaptiveLearningSessionFromPreview,
} from '../../adaptive-learning/session.js';
import {
  adaptiveCompletedBlockDto,
  adaptiveExecutionRequestHash,
  adaptiveExecutionSummary,
  adaptiveExecutionToken,
  adaptiveExecutionTokenHash,
  adaptiveEvidenceContext,
} from '../../adaptive-learning/session-execution.js';
import { adaptiveSpeakingTask } from '../../public/adaptive-speaking-tasks.js';
import { readingAdaptiveAttemptMetadata } from './reading-adaptive-attempt.js';

function reverseObjectKeys(value) {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => (
    [key, reverseObjectKeys(item)]
  )));
}

export async function assertAdaptiveSessionRepositoryContract(assert, repository, username) {
  const executionTokenSecret = 'adaptive-contract-secret-32-characters';
  const instant = new Date(Date.now() - 2 * 60 * 60_000);
  const goal = (await repository.saveAdaptiveLearningGoal(username, {
    id: crypto.randomUUID(), idempotencyKey: 'session-contract-goal-01', requestHash: '7'.repeat(64),
    targetExam: 'ege_english', targetScore: 85, examDate: '2027-06-01', weeklyMinutes: 300,
    now: instant,
  })).goal;
  const rawProfile = buildAdaptiveLearningProfile();
  const storedProfile = await repository.saveAdaptiveLearningProfile(username, rawProfile, { now: instant });
  const profile = adaptiveLearningProfilePublicDto(storedProfile);
  const calculated = buildAdaptiveLearningPlan({ goal, profile, now: instant });
  const storedPlan = (await repository.saveAdaptiveLearningPlan(username, {
    id: crypto.randomUUID(),
    inputFingerprint: adaptivePlanInputFingerprint({ goal, profile, basePlanRevision: null, now: instant }),
    basePlanRevision: null, goalId: goal.id, goalRevision: goal.revision,
    taxonomyVersion: profile.taxonomyVersion,
    profileCalculationRevision: profile.profileCalculationRevision,
    profileEvidenceWatermarkVersion: profile.evidenceWatermarkVersion,
    profileEvidenceObservedAt: profile.evidenceObservedAt,
    profileEvidenceSourceCount: profile.evidenceSourceCount,
    recalculationBucket: calculated.recalculationBucket, plan: calculated, now: instant,
  })).plan;
  const publicPlan = {
    id: storedPlan.id, revision: storedPlan.revision, version: storedPlan.plan_version,
    taxonomyVersion: storedPlan.taxonomy_version, allocation: storedPlan.allocation,
  };
  const preview = buildAdaptiveSessionPreview({
    plan: publicPlan, goal, weekUsage: [], durationMinutes: 90, now: instant,
  });
  const session = createAdaptiveLearningSessionFromPreview(preview, {
    id: crypto.randomUUID(), now: instant,
  });
  const createCandidate = {
    idempotencyKey: 'session-contract-create-01',
    requestHash: crypto.createHash('sha256').update(JSON.stringify([90, preview.previewFingerprint])).digest('hex'),
    planId: publicPlan.id, planRevision: publicPlan.revision,
    previewFingerprint: preview.previewFingerprint, session, now: instant,
  };
  const tamperedSession = structuredClone(session);
  tamperedSession.blocks.find((block) => block.kind === 'learning').contentRef = 'browser:invented-content';
  await assert.rejects(repository.createAdaptiveLearningSession(username, {
    ...createCandidate,
    idempotencyKey: 'session-contract-tamper-01',
    requestHash: '9'.repeat(64),
    session: tamperedSession,
  }), /ADAPTIVE_SESSION_INVALID/u);
  const swappedActivitySession = structuredClone(session);
  const swappedBlock = swappedActivitySession.blocks.find((block) => (
    block.kind === 'learning'
    && ADAPTIVE_ACTIVITY_REGISTRY.activities.some((activity) => (
      activity.skillId === block.skillId
      && activity.contentRef !== block.contentRef
      && activity.minimumMinutes <= block.plannedMinutes
    ))
  ));
  const alternateActivity = ADAPTIVE_ACTIVITY_REGISTRY.activities.find((activity) => (
    activity.skillId === swappedBlock?.skillId
    && activity.contentRef !== swappedBlock?.contentRef
    && activity.minimumMinutes <= swappedBlock?.plannedMinutes
  ));
  assert.ok(swappedBlock && alternateActivity, 'fixture needs a valid registered activity swap');
  Object.assign(swappedBlock, {
    module: alternateActivity.module,
    skillId: alternateActivity.skillId,
    skillLabel: alternateActivity.skillLabel,
    activityId: alternateActivity.activityId,
    activityLabel: alternateActivity.activityLabel,
    contentRef: alternateActivity.contentRef,
    difficulty: alternateActivity.difficulty,
    modality: alternateActivity.modality,
    requiresAudio: alternateActivity.requiresAudio,
    requiresMicrophone: alternateActivity.requiresMicrophone,
    launch: structuredClone(alternateActivity.launch),
  });
  await assert.rejects(repository.createAdaptiveLearningSession(username, {
    ...createCandidate,
    idempotencyKey: 'session-contract-swap-01',
    requestHash: '5'.repeat(64),
    session: swappedActivitySession,
  }), /ADAPTIVE_SESSION_INVALID/u);
  const idTamperedSession = structuredClone(session);
  idTamperedSession.blocks[0].id = `asb_${preview.previewFingerprint.slice(0, 16)}_99`;
  await assert.rejects(repository.createAdaptiveLearningSession(username, {
    ...createCandidate,
    idempotencyKey: 'session-contract-id-tamper-01',
    requestHash: '4'.repeat(64),
    session: idTamperedSession,
  }), /ADAPTIVE_SESSION_INVALID/u);
  const budgetTamperedSession = structuredClone(session);
  budgetTamperedSession.weeklyBudgetSnapshot.weeklyAvailableMinutes += 1;
  await assert.rejects(repository.createAdaptiveLearningSession(username, {
    ...createCandidate,
    idempotencyKey: 'session-contract-budget-tamper-01',
    requestHash: '3'.repeat(64),
    session: budgetTamperedSession,
  }), /ADAPTIVE_SESSION_INVALID/u);
  const reorderedCandidate = reverseObjectKeys(createCandidate);
  const [first, duplicate] = await Promise.all([
    repository.createAdaptiveLearningSession(username, createCandidate),
    repository.createAdaptiveLearningSession(username, reorderedCandidate),
  ]);
  assert.equal([first.created, duplicate.created].filter(Boolean).length, 1);
  const createdSnapshot = first.created ? first.session : duplicate.session;
  assert.deepEqual(first.session, duplicate.session);
  assert.equal(
    await repository.getAdaptiveLearningSessionCommercialScope(username, createdSnapshot.id),
    'base',
  );
  assert.deepEqual(await repository.getAdaptiveLearningCommercialUsage(username), {
    shortDiagnosticsCompleted: 0,
    deepDiagnosticsCompleted: 0,
    sessionsCreated: 1,
    sessionsCompleted: 0,
  });
  await assert.rejects(repository.createAdaptiveLearningSession(username, {
    ...createCandidate,
    idempotencyKey: 'session-contract-free-demo-reuse',
    requestHash: '2'.repeat(64),
    commercialMode: 'free_demo',
    commercialScope: 'free_demo',
  }), /ADAPTIVE_FREE_DEMO_USED/u);
  await assert.rejects(
    repository.createAdaptiveLearningSession(username, { ...createCandidate, requestHash: '8'.repeat(64) }),
    /ADAPTIVE_SESSION_IDEMPOTENCY_CONFLICT/u,
  );
  assert.equal((await repository.getCurrentAdaptiveLearningSession(username)).id, createdSnapshot.id);
  const usage = await repository.getAdaptiveLearningWeekUsage(username, preview.weekStart);
  assert.equal(usage.reduce((sum, item) => sum + item.plannedMinutes, 0), preview.learningMinutes);

  let firstBlock = null;
  let replacementSession = null;
  let alternateReplacement = null;
  for (const block of createdSnapshot.blocks.filter((item) => item.kind === 'learning')
    .sort((left, right) => right.difficulty - left.difficulty)) {
    try {
      const easier = buildAdaptiveSessionReplacement({
        session: createdSnapshot, plan: publicPlan, blockId: block.id, reason: 'too_difficult', now: instant,
      });
      const different = buildAdaptiveSessionReplacement({
        session: createdSnapshot, plan: publicPlan, blockId: block.id, reason: 'excluded', now: instant,
      });
      firstBlock = block;
      replacementSession = easier;
      alternateReplacement = different;
      break;
    } catch (error) {
      if (error?.code !== 'ADAPTIVE_SESSION_NO_REPLACEMENT') throw error;
    }
  }
  assert.ok(firstBlock, 'fixture must contain a block with two truthful replacement choices');
  const replacementCandidate = {
    sessionId: createdSnapshot.id, expectedRevision: 1, blockId: firstBlock.id,
    reason: 'too_difficult', idempotencyKey: 'session-contract-replace-01',
    requestHash: crypto.createHash('sha256').update(JSON.stringify([firstBlock.id, 'too_difficult'])).digest('hex'),
    session: replacementSession, now: instant,
  };
  const tamperedReplacement = structuredClone(replacementSession);
  tamperedReplacement.status = 'completed';
  await assert.rejects(repository.replaceAdaptiveLearningSessionBlock(username, {
    ...replacementCandidate,
    idempotencyKey: 'session-contract-replace-tamper',
    requestHash: '6'.repeat(64),
    session: tamperedReplacement,
  }), /ADAPTIVE_SESSION_INVALID/u);
  const competing = {
    ...replacementCandidate,
    idempotencyKey: 'session-contract-replace-02',
    requestHash: crypto.createHash('sha256').update(JSON.stringify([firstBlock.id, 'excluded'])).digest('hex'),
    reason: 'excluded',
    session: alternateReplacement,
  };
  const race = await Promise.allSettled([
    repository.replaceAdaptiveLearningSessionBlock(username, replacementCandidate),
    repository.replaceAdaptiveLearningSessionBlock(username, competing),
  ]);
  assert.equal(race.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(race.filter((result) => result.status === 'rejected').length, 1);
  const replaced = race.find((result) => result.status === 'fulfilled').value;
  assert.equal(replaced.replaced, true);
  if (replaced.session.replacement.reason === 'excluded') {
    assert.ok(replaced.session.blocks.find((block) => block.id === firstBlock.id)
      .reasonCodes.includes('learner_exclusion'));
  }
  const winningCandidate = replaced.session.replacement.reason === replacementCandidate.reason
    ? replacementCandidate : competing;
  const replay = await repository.replaceAdaptiveLearningSessionBlock(username, winningCandidate);
  assert.deepEqual(replay.session, replaced.session);
  await assert.rejects(repository.getAdaptiveLearningSessionReplacementReplay(username, crypto.randomUUID(), {
    idempotencyKey: winningCandidate.idempotencyKey,
    requestHash: winningCandidate.requestHash,
  }), /ADAPTIVE_SESSION_IDEMPOTENCY_CONFLICT/u);

  const exported = await repository.exportUserData(username);
  assert.equal(exported.adaptive_learning_sessions.length, 1);
  assert.deepEqual(Object.keys(exported.adaptive_learning_sessions[0]).sort(), [
    'blocks', 'break_minutes', 'commercial_scope', 'completed_learning_minutes', 'composer_policy_version',
    'content_registry_version', 'created_at', 'current_block_id', 'duration_minutes', 'id',
    'learning_minutes', 'plan_id', 'plan_revision', 'preview_fingerprint', 'replacement',
    'revision', 'session_version', 'status', 'taxonomy_version', 'updated_at', 'week_start',
    'weekly_budget_snapshot',
  ]);

  let executionRevision = 0;
  let minute = 1;
  const executionBase = instant;
  for (const block of replaced.session.blocks) {
    const stepTime = new Date(executionBase.getTime() + minute * 60_000);
    minute += 1;
    let attempt = null;
    if (block.kind === 'learning') {
      const current = await repository.getAdaptiveLearningSessionExecution(username, replaced.session.id);
      const claimId = crypto.randomUUID();
      const token = adaptiveExecutionToken(claimId, executionTokenSecret);
      const expiresAt = new Date(stepTime.getTime() + 2 * 60 * 60_000);
      const startBody = { blockId: block.id, expectedRevision: executionRevision };
      const startSnapshot = {
        session: { ...current.session, status: 'in_progress', updatedAt: stepTime.toISOString() },
        execution: {
          ...current.execution, revision: executionRevision + 1, status: 'in_progress',
          currentBlockId: block.id, startedAt: current.execution.startedAt || stepTime.toISOString(),
        },
        block, launch: block.launch, executionClaimId: claimId,
        claimExpiresAt: expiresAt.toISOString(), evidenceContext: adaptiveEvidenceContext(block),
      };
      const startCandidate = {
        operation: 'start', sessionId: replaced.session.id, ...startBody,
        idempotencyKey: `shared-execution-start-${String(block.position).padStart(2, '0')}`,
        requestHash: adaptiveExecutionRequestHash(startBody), claimId,
        token, tokenHash: adaptiveExecutionTokenHash(token), expiresAt, now: stepTime,
        evidenceContext: adaptiveEvidenceContext(block),
        responseSnapshot: startSnapshot,
      };
      const started = await repository.startAdaptiveLearningSessionBlock(username, startCandidate);
      assert.equal(started.created, true);
      assert.deepEqual(started.responseSnapshot, startSnapshot);
      const startReplay = await repository.startAdaptiveLearningSessionBlock(username, startCandidate);
      assert.equal(startReplay.replayed, true);
      assert.deepEqual(startReplay.responseSnapshot, startSnapshot);
      executionRevision += 1;

      if (block.module === 'writing') {
        const attemptId = await repository.createWritingAttempt(username, {
          taskType: block.activityId, sourceTaskRef: block.launch.taskId,
          assignment: {}, answer: 'A sufficiently long contract answer.',
        }, 'contract-writing-v1');
        await repository.finishWritingAttempt(attemptId, {
          status: 'completed', review: { overall_got: 1, overall_max: 6 },
        });
        attempt = { type: 'writing', id: attemptId };
      } else if (block.module === 'speaking') {
        const speaking = adaptiveSpeakingTask(block.contentRef);
        const attemptId = await repository.createSpeakingAttempt(username, {
          taskType: speaking.taskNumber, assignment: speaking.assignment,
          transcript: 'A contract transcript.',
        }, 'contract-speaking-v1');
        await repository.finishSpeakingAttempt(attemptId, {
          status: 'completed', review: { got: 1, max: 4 },
        });
        attempt = { type: 'speaking', id: attemptId };
      } else {
        const attemptId = crypto.randomUUID();
        const recorded = await repository.recordModuleAttemptWithAdaptiveClaim(username, {
          id: attemptId, module: block.module, activity: block.activityId,
          score: 1, maxScore: 1, durationMs: 60_000,
          metadata: block.module === 'reading' ? readingAdaptiveAttemptMetadata(block) : {
            helpUsed: true, mode: 'listening_exam', source: 'builtin', hintsUsed: 3, forged: true,
          },
        }, { executionClaim: token, now: new Date(stepTime.getTime() + 1_000) });
        assert.equal(recorded.created, true);
        assert.equal(recorded.evidenceQuality, 'client_reported');
        assert.equal(recorded.adaptiveExecution.sessionId, replaced.session.id);
        const storedAttempt = await repository.getModuleAttempt(username, attemptId);
        assert.equal(storedAttempt.metadata.helpUsed, block.module !== 'reading');
        assert.equal(storedAttempt.metadata.mode, block.module === 'reading'
          ? readingAdaptiveAttemptMetadata(block).mode : 'listening_exam');
        assert.equal(storedAttempt.metadata.source, block.module === 'reading' ? 'catalog' : 'builtin');
        assert.equal(storedAttempt.metadata.hintsUsed, block.module === 'reading' ? 0 : 3);
        assert.equal(Object.hasOwn(storedAttempt.metadata, 'forged'), false);
        const claimReplay = await repository.recordModuleAttemptWithAdaptiveClaim(username, {
          id: attemptId, module: block.module, activity: block.activityId,
          score: 1, maxScore: 1, durationMs: 60_000,
          metadata: block.module === 'reading' ? readingAdaptiveAttemptMetadata(block) : {
            helpUsed: true, mode: 'listening_exam', source: 'builtin', hintsUsed: 3, forged: true,
          },
        }, { executionClaim: token, now: new Date(stepTime.getTime() + 2_000) });
        assert.equal(claimReplay.created, false);
        attempt = { type: 'module', id: attemptId };
      }
      if (attempt.type !== 'module') {
        const bound = await repository.bindAdaptiveLearningServerAttempt(username, {
          sessionId: replaced.session.id, executionClaim: token, attempt,
          now: new Date(stepTime.getTime() + 1_000),
        });
        assert.equal(bound.created, true);
        assert.equal(bound.evidenceQuality, 'server_verified_assisted');
      }
      const recoveryCurrent = await repository.getAdaptiveLearningSessionExecution(
        username, replaced.session.id,
      );
      const recoveryBody = { blockId: block.id, expectedRevision: executionRevision };
      const recoveryCandidate = {
        ...startCandidate,
        ...recoveryBody,
        idempotencyKey: `shared-execution-recover-${String(block.position).padStart(2, '0')}`,
        requestHash: adaptiveExecutionRequestHash(recoveryBody),
        recoveryResponseSnapshot: {
          session: recoveryCurrent.session,
          execution: recoveryCurrent.execution,
          block,
          launch: block.launch,
          evidenceContext: adaptiveEvidenceContext(block),
        },
      };
      const recovered = await repository.startAdaptiveLearningSessionBlock(username, recoveryCandidate);
      assert.equal(recovered.recovered, true);
      assert.deepEqual(recovered.responseSnapshot.recoveryAttempt, attempt);
      assert.equal(Object.hasOwn(recovered.responseSnapshot, 'executionClaimId'), false);
      const recoveryReplay = await repository.startAdaptiveLearningSessionBlock(username, recoveryCandidate);
      assert.equal(recoveryReplay.replayed, true);
      assert.deepEqual(recoveryReplay.responseSnapshot, recovered.responseSnapshot);
    }

    await assert.rejects(repository.getAdaptiveLearningSessionAdvanceContext(username, {
      sessionId: replaced.session.id, blockId: block.id,
      expectedRevision: executionRevision + 1, attempt, now: stepTime,
    }), /ADAPTIVE_SESSION_REVISION_CONFLICT/u);
    const context = await repository.getAdaptiveLearningSessionAdvanceContext(username, {
      sessionId: replaced.session.id, blockId: block.id,
      expectedRevision: executionRevision, attempt, now: stepTime,
    });
    const eventShape = {
      block_id: block.id, block_kind: block.kind, module: block.module,
      skill_id: block.skillId, activity_id: block.activityId,
      source_type: context.source.source_type, source_ref: context.source.source_ref,
      evidence_quality: context.source.evidence_quality, planned_minutes: block.plannedMinutes,
      evidence_context: context.source.evidence_context,
      actual_minutes: context.source.actual_minutes,
    };
    const nextBlockId = context.nextBlock?.id || null;
    const advanceSnapshot = {
      session: {
        ...context.session, status: 'in_progress', currentBlockId: nextBlockId,
        completedLearningMinutes: context.session.completedLearningMinutes
          + (block.kind === 'learning' ? block.plannedMinutes : 0),
        updatedAt: stepTime.toISOString(),
      },
      execution: {
        ...context.execution, revision: executionRevision + 1, status: 'in_progress',
        currentBlockId: nextBlockId,
        completedBlockIds: [...context.execution.completedBlockIds, block.id],
        readyToFinish: nextBlockId === null,
      },
      completedBlock: adaptiveCompletedBlockDto(eventShape),
    };
    const advanceBody = { blockId: block.id, expectedRevision: executionRevision, attempt };
    const advanceCandidate = {
      operation: 'advance', sessionId: replaced.session.id, ...advanceBody,
      idempotencyKey: `shared-execution-advance-${String(block.position).padStart(2, '0')}`,
      requestHash: adaptiveExecutionRequestHash(advanceBody), eventId: crypto.randomUUID(),
      now: stepTime, responseSnapshot: advanceSnapshot,
    };
    const advanced = await repository.advanceAdaptiveLearningSession(username, advanceCandidate);
    assert.equal(advanced.advanced, true);
    assert.deepEqual(advanced.responseSnapshot, advanceSnapshot);
    const advanceReplay = await repository.advanceAdaptiveLearningSession(username, advanceCandidate);
    assert.equal(advanceReplay.replayed, true);
    assert.deepEqual(advanceReplay.responseSnapshot, advanceSnapshot);
    await assert.rejects(repository.advanceAdaptiveLearningSession(username, {
      ...advanceCandidate,
      idempotencyKey: `${advanceCandidate.idempotencyKey}-cas`,
      eventId: crypto.randomUUID(),
    }), /ADAPTIVE_SESSION_REVISION_CONFLICT/u);
    executionRevision += 1;
  }

  const finishTime = new Date(executionBase.getTime() + minute * 60_000);
  const finishContext = await repository.getAdaptiveLearningSessionFinishContext(username, {
    sessionId: replaced.session.id, expectedRevision: executionRevision,
  });
  const nextRecommendedAction = { type: 'create_personal_session', suggestedMinutes: 30 };
  const summary = adaptiveExecutionSummary(
    finishContext.session, finishContext.events, nextRecommendedAction,
  );
  const finishBody = { expectedRevision: executionRevision };
  const finishSnapshot = {
    session: {
      ...finishContext.session, status: 'completed', currentBlockId: null,
      updatedAt: finishTime.toISOString(),
    },
    execution: {
      ...finishContext.execution, revision: executionRevision + 1, status: 'completed',
      currentBlockId: null, readyToFinish: false, completedAt: finishTime.toISOString(),
    },
    summary, nextAction: nextRecommendedAction,
  };
  const finishCandidate = {
    operation: 'finish', sessionId: replaced.session.id, expectedRevision: executionRevision,
    idempotencyKey: 'shared-execution-finish-01', requestHash: adaptiveExecutionRequestHash(finishBody),
    eventId: crypto.randomUUID(), now: finishTime, nextRecommendedAction,
    responseSnapshot: finishSnapshot,
  };
  await assert.rejects(repository.finishAdaptiveLearningSession(username, {
    ...finishCandidate, expectedRevision: executionRevision + 1,
    idempotencyKey: 'shared-execution-finish-cas',
    requestHash: adaptiveExecutionRequestHash({ expectedRevision: executionRevision + 1 }),
  }), /ADAPTIVE_SESSION_REVISION_CONFLICT/u);
  const finished = await repository.finishAdaptiveLearningSession(username, finishCandidate);
  assert.equal(finished.finished, true);
  assert.deepEqual(finished.responseSnapshot, finishSnapshot);
  const finishReplay = await repository.finishAdaptiveLearningSession(username, finishCandidate);
  assert.equal(finishReplay.replayed, true);
  assert.deepEqual(finishReplay.responseSnapshot, finishSnapshot);

  const commercialUsage = await repository.getAdaptiveLearningCommercialUsage(username);
  assert.equal(commercialUsage.sessionsCreated, 1);
  assert.equal(commercialUsage.sessionsCompleted, 1);
  const reports = await repository.getAdaptiveLearningCompletedSessionReports(username, { limit: 12 });
  assert.equal(reports.length, 1);
  assert.equal(reports[0].session.id, replaced.session.id);
  assert.deepEqual(reports[0].summary, summary);

  const executionExport = await repository.exportUserData(username);
  assert.equal(executionExport.adaptive_learning_session_events.length, replaced.session.blocks.length + 1);
  assert.equal(executionExport.adaptive_learning_reports.length, 1);
  assert.equal(JSON.stringify(executionExport).includes('shared_execution_claim_'), false);
  assert.equal(JSON.stringify(executionExport).includes('request_hash'), false);

  const metrics = await repository.getAdaptiveLearningMetrics();
  assert.equal(metrics.version, 'adaptive-metrics-v1');
  assert.equal(metrics.window.days, 90);
  assert.ok(Date.parse(metrics.window.from) < Date.parse(metrics.window.to));
  assert.deepEqual({
    created: metrics.sessions.created,
    started: metrics.sessions.started,
    completed: metrics.sessions.completed,
  }, { created: 1, started: 1, completed: 1 });
  assert.deepEqual(metrics.sessions.byDuration['65_90'], { created: 1, started: 1, completed: 1 });
  assert.equal(metrics.adjustments.sessions, 1);
  assert.equal(metrics.evidence.learningBlockCompletions,
    replaced.session.blocks.filter((block) => block.kind === 'learning').length);
  assert.equal(JSON.stringify(metrics).includes(username), false);
}
