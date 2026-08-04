import crypto from 'node:crypto';
import express from 'express';

import { buildAdaptiveLearningProfile } from '../adaptive-learning/profile.js';
import { adaptiveLearningGoalPublicDto } from '../adaptive-learning/goal-dto.js';
import {
  adaptiveLearningProfilePublicDto,
  adaptiveLearningProfileSnapshotDto,
} from '../adaptive-learning/repository-dto.js';
import { adaptiveDiagnosticPublicDto } from '../adaptive-learning/diagnostic-dto.js';
import {
  adaptivePlanInputFingerprint,
  buildAdaptiveLearningPlan,
} from '../adaptive-learning/plan.js';
import { adaptiveLearningPlanPublicDto } from '../adaptive-learning/plan-dto.js';
import {
  ADAPTIVE_ACTIVITY_REGISTRY,
  adaptiveSessionWeekStart,
  buildAdaptiveSessionPreview,
  buildAdaptiveSessionReplacement,
  createAdaptiveLearningSessionFromPreview,
} from '../adaptive-learning/session.js';
import { adaptiveLearningSessionPublicDto } from '../adaptive-learning/session-dto.js';
import {
  ADAPTIVE_EXECUTION_CLAIM_TTL_MS,
  adaptiveCompletedBlockDto,
  adaptiveEvidenceContext,
  adaptiveExecutionRequestHash,
  adaptiveExecutionSummary,
  adaptiveExecutionToken,
  adaptiveExecutionTokenHash,
  adaptivePlanDelta,
  adaptiveProfileDelta,
} from '../adaptive-learning/session-execution.js';
import {
  DIAGNOSTIC_REGISTRY,
  getDiagnosticItem,
  getDiagnosticPolicy,
  selectDiagnosticItem,
} from '../adaptive-learning/diagnostic-catalog.js';
import {
  adaptiveDiagnosticAnswerSchema,
  adaptiveDiagnosticStartSchema,
  adaptiveGoalSchema,
  adaptiveSessionCreateSchema,
  adaptiveSessionAdvanceSchema,
  adaptiveSessionAttemptBindSchema,
  adaptiveSessionFinishSchema,
  adaptiveSessionPreviewSchema,
  adaptiveSessionReplacementSchema,
  adaptiveSessionStartSchema,
  isFutureExamDate,
} from '../validation/adaptive-learning.js';

const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,119}$/u;
const DIAGNOSTIC_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SESSION_ID = DIAGNOSTIC_ID;
const DIAGNOSTIC_START_RATE_LIMIT = 12;
const DIAGNOSTIC_START_RATE_WINDOW_MS = 60 * 60 * 1_000;
const DIAGNOSTIC_START_RATE_MAX_USERS = 10_000;

function createDiagnosticStartRateGate() {
  const windows = new Map();
  return {
    take(username, instant) {
      const instantMs = instant.getTime();
      const current = windows.get(username);
      if (current && current.resetAt > instantMs) {
        if (current.count >= DIAGNOSTIC_START_RATE_LIMIT) return false;
        current.count += 1;
        windows.delete(username);
        windows.set(username, current);
        return true;
      }
      if (!current && windows.size >= DIAGNOSTIC_START_RATE_MAX_USERS) {
        windows.delete(windows.keys().next().value);
      }
      windows.delete(username);
      windows.set(username, {
        count: 1,
        resetAt: instantMs + DIAGNOSTIC_START_RATE_WINDOW_MS,
      });
      return true;
    },
  };
}

function requestHash(goal) {
  return crypto.createHash('sha256').update(JSON.stringify([
    goal.targetExam, goal.targetScore, goal.examDate, goal.weeklyMinutes,
  ])).digest('hex');
}

function diagnosticStopReason({ answeredItems, startedAt, now: instant, hasNextItem, policy }) {
  const elapsedSeconds = Math.max(0, (instant.getTime() - new Date(startedAt).getTime()) / 1_000);
  if (answeredItems >= policy.maximumItems) return 'maximum_items';
  if (answeredItems >= policy.targetItems) return 'target_coverage';
  if (elapsedSeconds >= policy.maximumSeconds) return 'maximum_time';
  if (answeredItems >= policy.minimumItems
    && elapsedSeconds >= policy.targetSeconds) return 'target_time';
  if (!hasNextItem) return 'catalog_exhausted';
  return null;
}

function unsupportedDiagnosticCatalog(res) {
  return res.status(409).json({ error: { code: 'DIAGNOSTIC_CATALOG_UNSUPPORTED' } });
}

function adaptiveStartPublicSnapshot(snapshot, executionTokenSecret) {
  if (snapshot?.recoveryAttempt) {
    const attempt = snapshot.recoveryAttempt;
    const validAttempt = attempt?.type === 'module'
      ? DIAGNOSTIC_ID.test(String(attempt.id || ''))
      : ['writing', 'speaking'].includes(attempt?.type)
        && Number.isSafeInteger(Number(attempt.id)) && Number(attempt.id) > 0;
    if (!validAttempt || Object.hasOwn(snapshot, 'executionClaimId')
      || Object.hasOwn(snapshot, 'executionClaim')
      || !snapshot.block || !snapshot.execution) {
      throw new Error('ADAPTIVE_SESSION_EXECUTION_SNAPSHOT_INVALID');
    }
    return snapshot;
  }
  const claimId = snapshot?.executionClaimId;
  if (!DIAGNOSTIC_ID.test(String(claimId || ''))) {
    throw new Error('ADAPTIVE_SESSION_EXECUTION_SNAPSHOT_INVALID');
  }
  const { executionClaimId, ...publicSnapshot } = snapshot;
  return {
    ...publicSnapshot,
    executionClaim: adaptiveExecutionToken(executionClaimId, executionTokenSecret),
  };
}

export function createAdaptiveLearningRoutes({
  authentication,
  db,
  now = () => new Date(),
  enabled = false,
  executionTokenSecret,
  diagnosticRegistry = DIAGNOSTIC_REGISTRY,
  activityRegistry = ADAPTIVE_ACTIVITY_REGISTRY,
}) {
  const router = express.Router();
  if (!enabled) return router;
  if (typeof executionTokenSecret !== 'string' || executionTokenSecret.length < 32) {
    throw new Error('ADAPTIVE_EXECUTION_TOKEN_CONFIG_INVALID');
  }
  const { auth } = authentication;
  const diagnosticStartRateGate = createDiagnosticStartRateGate();

  async function overview(username, { remainingPlanRetries = 2 } = {}) {
    const [goal, sources] = await Promise.all([
      db.getAdaptiveLearningGoal(username),
      db.getAdaptiveLearningEvidenceSources(username),
    ]);
    const profile = buildAdaptiveLearningProfile(sources, { diagnosticRegistry });
    const authoritativeProfile = await db.saveAdaptiveLearningProfile(username, profile, { now: now() });
    const publicProfile = adaptiveLearningProfilePublicDto(authoritativeProfile);
    let plan = null;
    if (goal) {
      const previousPlan = await db.getCurrentAdaptiveLearningPlan(username);
      const basePlanRevision = previousPlan?.revision ?? null;
      const instant = now();
      const calculated = buildAdaptiveLearningPlan({
        goal,
        profile: publicProfile,
        previousPlan,
        now: instant,
      });
      try {
        const saved = await db.saveAdaptiveLearningPlan(username, {
          id: crypto.randomUUID(),
          inputFingerprint: adaptivePlanInputFingerprint({
            goal, profile: publicProfile, basePlanRevision, now: instant,
          }),
          basePlanRevision,
          goalId: goal.id,
          goalRevision: goal.revision,
          taxonomyVersion: publicProfile.taxonomyVersion,
          profileCalculationRevision: publicProfile.profileCalculationRevision,
          profileEvidenceWatermarkVersion: publicProfile.evidenceWatermarkVersion,
          profileEvidenceObservedAt: publicProfile.evidenceObservedAt,
          profileEvidenceSourceCount: publicProfile.evidenceSourceCount,
          recalculationBucket: calculated.recalculationBucket,
          plan: calculated,
          now: instant,
        });
        if (saved.conflict) {
          if (remainingPlanRetries > 0) {
            return overview(username, { remainingPlanRetries: remainingPlanRetries - 1 });
          }
          throw new Error('ADAPTIVE_PLAN_RECALCULATION_CONFLICT');
        }
        if (Number(saved.plan?.goal_revision) !== Number(goal.revision)) {
          if (remainingPlanRetries > 0) {
            return overview(username, { remainingPlanRetries: remainingPlanRetries - 1 });
          }
          throw new Error('ADAPTIVE_PLAN_RECALCULATION_CONFLICT');
        }
        plan = adaptiveLearningPlanPublicDto(saved.plan);
      } catch (error) {
        if (['ADAPTIVE_PLAN_GOAL_STALE', 'ADAPTIVE_PLAN_PROFILE_STALE'].includes(error?.message)
          && remainingPlanRetries > 0) {
          return overview(username, { remainingPlanRetries: remainingPlanRetries - 1 });
        }
        throw error;
      }
    }
    return {
      goal: adaptiveLearningGoalPublicDto(goal),
      profile: publicProfile,
      plan,
    };
  }

  router.get('/api/v1/adaptive-learning/goal', auth, async (req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json({ goal: adaptiveLearningGoalPublicDto(await db.getAdaptiveLearningGoal(req.user)) });
    } catch (error) { next(error); }
  });

  router.put('/api/v1/adaptive-learning/goal', auth, async (req, res, next) => {
    const parsed = adaptiveGoalSchema.safeParse(req.body);
    const idempotencyKey = String(req.headers['idempotency-key'] || '');
    if (!parsed.success || !IDEMPOTENCY_KEY.test(idempotencyKey)
      || !isFutureExamDate(parsed.data?.examDate, now())) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Проверьте цель, дату экзамена и доступное время.' },
      });
    }
    try {
      const saved = await db.saveAdaptiveLearningGoal(req.user, {
        id: crypto.randomUUID(),
        idempotencyKey,
        requestHash: requestHash(parsed.data),
        targetExam: parsed.data.targetExam,
        targetScore: parsed.data.targetScore,
        examDate: parsed.data.examDate,
        weeklyMinutes: parsed.data.weeklyMinutes,
        now: now(),
      });
      const result = await overview(req.user);
      const savedIsCurrent = result.goal?.id === saved.goal?.id
        && Number(result.goal?.revision) === Number(saved.goal?.revision);
      const responseCreated = Boolean(saved.created && savedIsCurrent);
      return res.status(responseCreated ? 201 : 200).json({
        created: responseCreated,
        replayed: !saved.created,
        superseded: !savedIsCurrent,
        goal: result.goal,
        profile: result.profile,
        plan: result.plan,
      });
    } catch (error) {
      if (error?.message === 'ADAPTIVE_GOAL_IDEMPOTENCY_CONFLICT') {
        return res.status(409).json({
          error: { code: 'IDEMPOTENCY_CONFLICT', message: 'Этот ключ уже использован для другой цели.' },
        });
      }
      return next(error);
    }
  });

  router.get('/api/v1/adaptive-learning/overview', auth, async (req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await overview(req.user));
    } catch (error) { next(error); }
  });

  router.get('/api/v1/adaptive-learning/plan', auth, async (req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      const result = await overview(req.user);
      if (!result.goal || !result.plan) {
        return res.status(409).json({ error: { code: 'ADAPTIVE_GOAL_REQUIRED' } });
      }
      return res.json(result);
    } catch (error) { return next(error); }
  });

  function sessionRequestHash(value) {
    return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }

  async function sessionPreview(username, durationMinutes, instant = now()) {
    const result = await overview(username);
    if (!result.goal || !result.plan) {
      throw Object.assign(new Error('ADAPTIVE_GOAL_REQUIRED'), { status: 409, code: 'ADAPTIVE_GOAL_REQUIRED' });
    }
    const weekStart = adaptiveSessionWeekStart(instant);
    const weekUsage = await db.getAdaptiveLearningWeekUsage(username, weekStart);
    return buildAdaptiveSessionPreview({
      plan: result.plan,
      goal: result.goal,
      profile: result.profile,
      weekUsage,
      durationMinutes,
      now: instant,
      registry: activityRegistry,
    });
  }

  function sessionError(res, error) {
    const known = {
      ADAPTIVE_GOAL_REQUIRED: [409, 'ADAPTIVE_GOAL_REQUIRED'],
      ADAPTIVE_SESSION_COVERAGE_GAP: [409, 'ADAPTIVE_SESSION_COVERAGE_GAP'],
      ADAPTIVE_SESSION_NO_CONTENT: [409, 'ADAPTIVE_SESSION_NO_CONTENT'],
      ADAPTIVE_SESSION_NO_REPLACEMENT: [409, 'ADAPTIVE_SESSION_NO_REPLACEMENT'],
      ADAPTIVE_SESSION_PREVIEW_STALE: [409, 'ADAPTIVE_SESSION_PREVIEW_STALE'],
      ADAPTIVE_SESSION_PLAN_STALE: [409, 'ADAPTIVE_SESSION_PLAN_STALE'],
      ADAPTIVE_SESSION_ALREADY_CURRENT: [409, 'ADAPTIVE_SESSION_ALREADY_CURRENT'],
      ADAPTIVE_SESSION_REPLACEMENT_ALREADY_USED: [409, 'ADAPTIVE_SESSION_REPLACEMENT_ALREADY_USED'],
      ADAPTIVE_SESSION_REVISION_CONFLICT: [409, 'ADAPTIVE_SESSION_REVISION_CONFLICT'],
      ADAPTIVE_SESSION_IDEMPOTENCY_CONFLICT: [409, 'IDEMPOTENCY_CONFLICT'],
      ADAPTIVE_SESSION_STATE_CONFLICT: [409, 'ADAPTIVE_SESSION_STATE_CONFLICT'],
      ADAPTIVE_SESSION_BLOCK_NOT_CURRENT: [409, 'ADAPTIVE_SESSION_BLOCK_NOT_CURRENT'],
      ADAPTIVE_SESSION_BLOCK_NOT_LAUNCHABLE: [409, 'ADAPTIVE_SESSION_BLOCK_NOT_LAUNCHABLE'],
      ADAPTIVE_SESSION_BLOCK_ALREADY_STARTED: [409, 'ADAPTIVE_SESSION_BLOCK_ALREADY_STARTED'],
      ADAPTIVE_SESSION_BLOCK_ALREADY_COMPLETED: [409, 'ADAPTIVE_SESSION_BLOCK_ALREADY_COMPLETED'],
      ADAPTIVE_SESSION_ATTEMPT_REQUIRED: [409, 'ADAPTIVE_SESSION_ATTEMPT_REQUIRED'],
      ADAPTIVE_SESSION_ATTEMPT_NOT_BOUND: [409, 'ADAPTIVE_SESSION_ATTEMPT_NOT_BOUND'],
      ADAPTIVE_SESSION_ATTEMPT_MISMATCH: [409, 'ADAPTIVE_SESSION_ATTEMPT_MISMATCH'],
      ADAPTIVE_SESSION_BREAK_ATTEMPT_FORBIDDEN: [409, 'ADAPTIVE_SESSION_BREAK_ATTEMPT_FORBIDDEN'],
      ADAPTIVE_SESSION_NOT_READY_TO_FINISH: [409, 'ADAPTIVE_SESSION_NOT_READY_TO_FINISH'],
      ADAPTIVE_EXECUTION_CLAIM_INVALID: [409, 'ADAPTIVE_EXECUTION_CLAIM_INVALID'],
      ADAPTIVE_EXECUTION_CLAIM_EXPIRED: [410, 'ADAPTIVE_EXECUTION_CLAIM_EXPIRED'],
      ADAPTIVE_EXECUTION_CLAIM_CONSUMED: [409, 'ADAPTIVE_EXECUTION_CLAIM_CONSUMED'],
      ADAPTIVE_EXECUTION_ATTEMPT_MISMATCH: [409, 'ADAPTIVE_EXECUTION_ATTEMPT_MISMATCH'],
      ADAPTIVE_SESSION_BLOCK_NOT_FOUND: [404, 'ADAPTIVE_SESSION_NOT_FOUND'],
      ADAPTIVE_SESSION_NOT_FOUND: [404, 'ADAPTIVE_SESSION_NOT_FOUND'],
    }[error?.message || error?.code];
    if (!known) return false;
    res.status(known[0]).json({ error: { code: known[1] } });
    return true;
  }

  router.post('/api/v1/adaptive-learning/sessions/preview', auth, async (req, res, next) => {
    const parsed = adaptiveSessionPreviewSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: { code: 'VALIDATION_ERROR' } });
    try {
      const instant = now();
      const preview = await sessionPreview(req.user, parsed.data.durationMinutes, instant);
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ serverTime: instant.toISOString(), preview });
    } catch (error) {
      if (sessionError(res, error)) return undefined;
      return next(error);
    }
  });

  router.post('/api/v1/adaptive-learning/sessions', auth, async (req, res, next) => {
    const parsed = adaptiveSessionCreateSchema.safeParse(req.body);
    const idempotencyKey = String(req.headers['idempotency-key'] || '');
    if (!parsed.success || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR' } });
    }
    const hash = sessionRequestHash([parsed.data.durationMinutes, parsed.data.previewFingerprint]);
    try {
      const replay = await db.getAdaptiveLearningSessionCreateReplay(req.user, {
        idempotencyKey, requestHash: hash,
      });
      if (replay) return res.json({ created: false, replayed: true, session: replay });
      const instant = now();
      const preview = await sessionPreview(req.user, parsed.data.durationMinutes, instant);
      if (preview.previewFingerprint !== parsed.data.previewFingerprint) {
        throw new Error('ADAPTIVE_SESSION_PREVIEW_STALE');
      }
      const session = createAdaptiveLearningSessionFromPreview(preview, {
        id: crypto.randomUUID(), now: instant,
      });
      const saved = await db.createAdaptiveLearningSession(req.user, {
        idempotencyKey,
        requestHash: hash,
        planId: preview.planId,
        planRevision: preview.planRevision,
        previewFingerprint: preview.previewFingerprint,
        session,
        now: instant,
      });
      return res.status(saved.created ? 201 : 200).json({
        created: saved.created,
        replayed: saved.replayed,
        session: adaptiveLearningSessionPublicDto(saved.session),
      });
    } catch (error) {
      if (sessionError(res, error)) return undefined;
      return next(error);
    }
  });

  router.get('/api/v1/adaptive-learning/sessions/current', auth, async (req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      const session = await db.getCurrentAdaptiveLearningSession(req.user);
      if (!session) return res.status(404).json({ error: { code: 'ADAPTIVE_SESSION_NOT_FOUND' } });
      return res.json(await db.getAdaptiveLearningSessionExecution(req.user, session.id));
    } catch (error) { return next(error); }
  });

  router.post('/api/v1/adaptive-learning/sessions/:sessionId/replace', auth, async (req, res, next) => {
    const parsed = adaptiveSessionReplacementSchema.safeParse(req.body);
    const idempotencyKey = String(req.headers['idempotency-key'] || '');
    if (!parsed.success || !IDEMPOTENCY_KEY.test(idempotencyKey)
      || !SESSION_ID.test(req.params.sessionId)) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR' } });
    }
    const hash = sessionRequestHash([parsed.data.blockId, parsed.data.reason]);
    try {
      const replay = await db.getAdaptiveLearningSessionReplacementReplay(
        req.user,
        req.params.sessionId,
        { idempotencyKey, requestHash: hash },
      );
      if (replay) return res.json({ replaced: false, replayed: true, session: replay });
      const current = await db.getCurrentAdaptiveLearningSession(req.user);
      if (!current || current.id !== req.params.sessionId) throw new Error('ADAPTIVE_SESSION_NOT_FOUND');
      const storedPlan = await db.getAdaptiveLearningPlanRevision(req.user, current.planRevision);
      if (!storedPlan || storedPlan.id !== current.planId) throw new Error('ADAPTIVE_SESSION_PLAN_STALE');
      const instant = now();
      const session = buildAdaptiveSessionReplacement({
        session: current,
        plan: adaptiveLearningPlanPublicDto(storedPlan),
        blockId: parsed.data.blockId,
        reason: parsed.data.reason,
        now: instant,
        registry: activityRegistry,
      });
      const saved = await db.replaceAdaptiveLearningSessionBlock(req.user, {
        sessionId: current.id,
        expectedRevision: current.revision,
        blockId: parsed.data.blockId,
        reason: parsed.data.reason,
        idempotencyKey,
        requestHash: hash,
        session,
        now: instant,
      });
      return res.json({
        replaced: saved.replaced,
        replayed: saved.replayed,
        session: adaptiveLearningSessionPublicDto(saved.session),
      });
    } catch (error) {
      if (sessionError(res, error)) return undefined;
      return next(error);
    }
  });

  router.post('/api/v1/adaptive-learning/sessions/:sessionId/start', auth, async (req, res, next) => {
    const parsed = adaptiveSessionStartSchema.safeParse(req.body);
    const idempotencyKey = String(req.headers['idempotency-key'] || '');
    if (!parsed.success || !IDEMPOTENCY_KEY.test(idempotencyKey)
      || !SESSION_ID.test(req.params.sessionId)) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR' } });
    }
    const requestHash = adaptiveExecutionRequestHash(parsed.data);
    try {
      const replay = await db.getAdaptiveLearningSessionMutationReplay(req.user, {
        operation: 'start', sessionId: req.params.sessionId, idempotencyKey, requestHash,
      });
      if (replay) return res.json(adaptiveStartPublicSnapshot(replay, executionTokenSecret));
      const current = await db.getAdaptiveLearningSessionExecution(req.user, req.params.sessionId);
      if (!current) throw new Error('ADAPTIVE_SESSION_NOT_FOUND');
      const block = current.session.blocks.find((item) => item.id === parsed.data.blockId);
      if (!block || current.session.currentBlockId !== block.id) {
        throw new Error('ADAPTIVE_SESSION_BLOCK_NOT_CURRENT');
      }
      if (block.kind !== 'learning') throw new Error('ADAPTIVE_SESSION_BLOCK_NOT_LAUNCHABLE');
      const instant = now();
      const claimId = crypto.randomUUID();
      const token = adaptiveExecutionToken(claimId, executionTokenSecret);
      const expiresAt = new Date(instant.getTime() + ADAPTIVE_EXECUTION_CLAIM_TTL_MS);
      const execution = {
        ...current.execution,
        revision: current.execution.revision + 1,
        status: 'in_progress',
        currentBlockId: block.id,
        startedAt: current.execution.startedAt || instant.toISOString(),
      };
      const responseSnapshot = {
        session: { ...current.session, status: 'in_progress', updatedAt: instant.toISOString() },
        execution,
        block,
        launch: block.launch,
        executionClaimId: claimId,
        claimExpiresAt: expiresAt.toISOString(),
        evidenceContext: adaptiveEvidenceContext(block),
      };
      const recoveryResponseSnapshot = {
        session: current.session,
        execution: current.execution,
        block,
        launch: block.launch,
        evidenceContext: adaptiveEvidenceContext(block),
      };
      const saved = await db.startAdaptiveLearningSessionBlock(req.user, {
        operation: 'start', sessionId: req.params.sessionId,
        blockId: parsed.data.blockId, expectedRevision: parsed.data.expectedRevision,
        idempotencyKey, requestHash, claimId, token,
        tokenHash: adaptiveExecutionTokenHash(token), expiresAt, now: instant,
        evidenceContext: responseSnapshot.evidenceContext,
        responseSnapshot, recoveryResponseSnapshot,
      });
      return res.status(saved.created ? 201 : 200)
        .json(adaptiveStartPublicSnapshot(saved.responseSnapshot, executionTokenSecret));
    } catch (error) {
      if (sessionError(res, error)) return undefined;
      return next(error);
    }
  });

  router.post('/api/v1/adaptive-learning/sessions/:sessionId/advance', auth, async (req, res, next) => {
    const parsed = adaptiveSessionAdvanceSchema.safeParse(req.body);
    const idempotencyKey = String(req.headers['idempotency-key'] || '');
    if (!parsed.success || !IDEMPOTENCY_KEY.test(idempotencyKey)
      || !SESSION_ID.test(req.params.sessionId)) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR' } });
    }
    const requestHash = adaptiveExecutionRequestHash(parsed.data);
    try {
      const replay = await db.getAdaptiveLearningSessionMutationReplay(req.user, {
        operation: 'advance', sessionId: req.params.sessionId, idempotencyKey, requestHash,
      });
      if (replay) return res.json(replay);
      const instant = now();
      const context = await db.getAdaptiveLearningSessionAdvanceContext(req.user, {
        sessionId: req.params.sessionId, ...parsed.data, now: instant,
      });
      if (!context) throw new Error('ADAPTIVE_SESSION_NOT_FOUND');
      const storedProfile = await db.getAdaptiveLearningProfile(req.user);
      const storedPlan = await db.getCurrentAdaptiveLearningPlan(req.user);
      const profileBefore = adaptiveLearningProfilePublicDto(storedProfile);
      const planBefore = storedPlan ? adaptiveLearningPlanPublicDto(storedPlan) : null;
      const refreshed = context.block.kind === 'learning'
        ? await overview(req.user)
        : { profile: profileBefore, plan: planBefore };
      const profileAfter = refreshed.profile;
      const planAfter = refreshed.plan;
      const completedEvent = {
        block_id: context.block.id,
        block_kind: context.block.kind,
        module: context.block.module,
        skill_id: context.block.skillId,
        activity_id: context.block.activityId,
        source_type: context.source.source_type,
        source_ref: context.source.source_ref,
        evidence_quality: context.source.evidence_quality,
        evidence_context: context.source.evidence_context,
        planned_minutes: context.block.plannedMinutes,
        actual_minutes: context.source.actual_minutes,
      };
      const nextCurrentBlockId = context.nextBlock?.id || null;
      const session = {
        ...context.session,
        status: 'in_progress',
        currentBlockId: nextCurrentBlockId,
        completedLearningMinutes: context.session.completedLearningMinutes
          + (context.block.kind === 'learning' ? context.block.plannedMinutes : 0),
        updatedAt: instant.toISOString(),
      };
      const execution = {
        ...context.execution,
        revision: context.execution.revision + 1,
        status: 'in_progress',
        currentBlockId: nextCurrentBlockId,
        completedBlockIds: [...context.execution.completedBlockIds, context.block.id],
        readyToFinish: nextCurrentBlockId === null,
      };
      const completedBlock = adaptiveCompletedBlockDto(completedEvent);
      const planChange = context.block.kind === 'learning'
        ? adaptivePlanDelta(planBefore, planAfter)
        : { reasonCode: 'scheduled_break_completed', planRevisionBefore: Number(planBefore?.revision || 0), planRevisionAfter: Number(planAfter?.revision || 0), modulePercentageChanges: [] };
      const nextAction = context.nextBlock
        ? { type: context.nextBlock.kind === 'break' ? 'take_break' : 'start_block', blockId: context.nextBlock.id }
        : { type: 'finish_session', sessionId: context.session.id };
      const responseSnapshot = {
        session, execution, completedBlock,
        profileBefore, profileAfter,
        profileChange: adaptiveProfileDelta(profileBefore, profileAfter),
        planBefore, planAfter, planChange, nextAction,
      };
      const saved = await db.advanceAdaptiveLearningSession(req.user, {
        operation: 'advance', sessionId: req.params.sessionId, ...parsed.data,
        idempotencyKey, requestHash, eventId: crypto.randomUUID(), now: instant,
        responseSnapshot,
      });
      return res.json(saved.responseSnapshot);
    } catch (error) {
      if (sessionError(res, error)) return undefined;
      return next(error);
    }
  });

  router.post('/api/v1/adaptive-learning/sessions/:sessionId/bind-attempt', auth, async (req, res, next) => {
    const parsed = adaptiveSessionAttemptBindSchema.safeParse(req.body);
    if (!parsed.success || !SESSION_ID.test(req.params.sessionId)) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR' } });
    }
    try {
      const result = await db.bindAdaptiveLearningServerAttempt(req.user, {
        sessionId: req.params.sessionId, ...parsed.data, now: now(),
      });
      return res.status(result.created ? 201 : 200).json(result);
    } catch (error) {
      if (sessionError(res, error)) return undefined;
      return next(error);
    }
  });

  router.post('/api/v1/adaptive-learning/sessions/:sessionId/finish', auth, async (req, res, next) => {
    const parsed = adaptiveSessionFinishSchema.safeParse(req.body);
    const idempotencyKey = String(req.headers['idempotency-key'] || '');
    if (!parsed.success || !IDEMPOTENCY_KEY.test(idempotencyKey)
      || !SESSION_ID.test(req.params.sessionId)) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR' } });
    }
    const requestHash = adaptiveExecutionRequestHash(parsed.data);
    try {
      const replay = await db.getAdaptiveLearningSessionMutationReplay(req.user, {
        operation: 'finish', sessionId: req.params.sessionId, idempotencyKey, requestHash,
      });
      if (replay) return res.json(replay);
      const instant = now();
      const context = await db.getAdaptiveLearningSessionFinishContext(req.user, {
        sessionId: req.params.sessionId, ...parsed.data,
      });
      if (!context) throw new Error('ADAPTIVE_SESSION_NOT_FOUND');
      const currentPlan = await db.getCurrentAdaptiveLearningPlan(req.user);
      const nextRecommendedAction = {
        type: 'create_personal_session',
        suggestedMinutes: Math.min(60, Math.max(15, Number(context.session.durationMinutes || 30))),
      };
      const session = {
        ...context.session, status: 'completed', currentBlockId: null, updatedAt: instant.toISOString(),
      };
      const execution = {
        ...context.execution, revision: context.execution.revision + 1,
        status: 'completed', currentBlockId: null, readyToFinish: false,
        completedAt: instant.toISOString(),
      };
      const planRevisionAfter = Number(currentPlan?.revision || context.session.planRevision || 0);
      const summary = adaptiveExecutionSummary(context.session, context.events, nextRecommendedAction, {
        planRevisionAfter,
      });
      const responseSnapshot = { session, execution, summary, nextAction: nextRecommendedAction };
      const saved = await db.finishAdaptiveLearningSession(req.user, {
        operation: 'finish', sessionId: req.params.sessionId,
        expectedRevision: parsed.data.expectedRevision,
        idempotencyKey, requestHash, eventId: crypto.randomUUID(), now: instant,
        nextRecommendedAction, planRevisionAfter, responseSnapshot,
      });
      return res.json(saved.responseSnapshot);
    } catch (error) {
      if (sessionError(res, error)) return undefined;
      return next(error);
    }
  });

  router.post('/api/v1/adaptive-learning/diagnostics/start', auth, async (req, res, next) => {
    const parsed = adaptiveDiagnosticStartSchema.safeParse(req.body);
    const idempotencyKey = String(req.headers['idempotency-key'] || '');
    if (!parsed.success || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Не удалось начать диагностику.' } });
    }
    try {
      const startRequestHash = crypto.createHash('sha256').update('{}').digest('hex');
      const claimed = await db.getAdaptiveDiagnosticStartClaim(req.user, {
        idempotencyKey,
        requestHash: startRequestHash,
        now: now(),
      });
      if (claimed) {
        const claimedPolicy = getDiagnosticPolicy(claimed.catalog_version, diagnosticRegistry);
        if (!claimedPolicy) return unsupportedDiagnosticCatalog(res);
        return res.json({
          required: true,
          ...adaptiveDiagnosticPublicDto(
            claimed,
            getDiagnosticItem(claimed.catalog_version, claimed.current_item_id, diagnosticRegistry),
            claimedPolicy,
          ),
        });
      }
      if (!diagnosticStartRateGate.take(req.user, now())) {
        return res.status(429).json({ error: { code: 'DIAGNOSTIC_START_RATE_LIMIT' } });
      }
      const currentOverview = await overview(req.user);
      if (!currentOverview.profile.needsDiagnostic) {
        return res.json({ required: false, diagnostic: null, item: null, profile: currentOverview.profile });
      }
      const currentVersion = diagnosticRegistry.currentVersion;
      const currentPolicy = getDiagnosticPolicy(currentVersion, diagnosticRegistry);
      const firstItem = selectDiagnosticItem(
        currentVersion,
        currentOverview.profile,
        [],
        [],
        diagnosticRegistry,
      );
      const instant = now();
      const saved = await db.startAdaptiveDiagnostic(req.user, {
        id: crypto.randomUUID(),
        idempotencyKey,
        requestHash: startRequestHash,
        catalogVersion: currentVersion,
        currentItemId: firstItem.id,
        now: instant,
        expiresAt: new Date(instant.getTime() + currentPolicy.maximumSeconds * 1_000),
      });
      const savedPolicy = getDiagnosticPolicy(saved.diagnostic.catalog_version, diagnosticRegistry);
      if (!savedPolicy) return unsupportedDiagnosticCatalog(res);
      const item = getDiagnosticItem(
        saved.diagnostic.catalog_version,
        saved.diagnostic.current_item_id,
        diagnosticRegistry,
      );
      return res.status(saved.created ? 201 : 200).json({
        required: true,
        ...adaptiveDiagnosticPublicDto(saved.diagnostic, item, savedPolicy),
      });
    } catch (error) {
      if (error?.message === 'ADAPTIVE_DIAGNOSTIC_IDEMPOTENCY_CONFLICT') {
        return res.status(409).json({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
      }
      if (error?.message === 'ADAPTIVE_DIAGNOSTIC_START_LIMIT') {
        return res.status(429).json({ error: { code: 'DIAGNOSTIC_START_LIMIT' } });
      }
      return next(error);
    }
  });

  router.get('/api/v1/adaptive-learning/diagnostics/current', auth, async (req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      const diagnostic = await db.getCurrentAdaptiveDiagnostic(req.user);
      const expired = ['in_progress', 'ready'].includes(diagnostic?.status)
        && new Date(diagnostic.expires_at).getTime() <= now().getTime();
      const visible = expired ? {
        ...diagnostic,
        status: 'expired',
        current_item_id: null,
        stop_reason: 'maximum_time',
      } : diagnostic;
      const visiblePolicy = visible
        ? getDiagnosticPolicy(visible.catalog_version, diagnosticRegistry)
        : null;
      if (visible && !visiblePolicy) return unsupportedDiagnosticCatalog(res);
      return res.json(adaptiveDiagnosticPublicDto(
        visible,
        getDiagnosticItem(visible?.catalog_version, visible?.current_item_id, diagnosticRegistry),
        visiblePolicy,
      ));
    } catch (error) { return next(error); }
  });

  router.post('/api/v1/adaptive-learning/diagnostics/:diagnosticId/answers', auth, async (req, res, next) => {
    const parsed = adaptiveDiagnosticAnswerSchema.safeParse(req.body);
    const idempotencyKey = String(req.headers['idempotency-key'] || '');
    if (!parsed.success || !IDEMPOTENCY_KEY.test(idempotencyKey)
      || !DIAGNOSTIC_ID.test(req.params.diagnosticId)) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Выберите один ответ.' } });
    }
    try {
      const target = await db.getAdaptiveDiagnostic(req.user, req.params.diagnosticId);
      if (!target) return res.status(404).json({ error: { code: 'DIAGNOSTIC_NOT_FOUND' } });
      const targetPolicy = getDiagnosticPolicy(target.catalog_version, diagnosticRegistry);
      if (!targetPolicy) return unsupportedDiagnosticCatalog(res);
      const item = getDiagnosticItem(target.catalog_version, parsed.data.itemId, diagnosticRegistry);
      if (!item || !item.choices.some((choice) => choice.id === parsed.data.choiceId)) {
        return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Выберите один ответ.' } });
      }
      const answeredIds = [...(target.responses || []).map((response) => response.item_id), item.id];
      const sessionResponses = [
        ...(target.responses || []),
        { item_id: item.id, choice_id: parsed.data.choiceId },
      ];
      const currentOverview = await overview(req.user);
      const nextItem = selectDiagnosticItem(
        target.catalog_version,
        currentOverview.profile,
        answeredIds,
        sessionResponses,
        diagnosticRegistry,
      );
      const instant = now();
      const answeredItems = answeredIds.length;
      const stopReason = diagnosticStopReason({
        answeredItems,
        startedAt: target.started_at || instant,
        now: instant,
        hasNextItem: Boolean(nextItem),
        policy: targetPolicy,
      });
      const saved = await db.answerAdaptiveDiagnostic(req.user, {
        id: crypto.randomUUID(),
        diagnosticId: req.params.diagnosticId,
        itemId: item.id,
        skillId: item.skillId,
        module: item.module,
        evidenceQuality: item.evidenceQuality,
        choiceId: parsed.data.choiceId,
        correct: parsed.data.choiceId === item.correctChoiceId,
        responseMs: Math.max(0, Math.min(300_000, instant.getTime() - new Date(target.updated_at || instant).getTime())),
        idempotencyKey,
        requestHash: crypto.createHash('sha256').update(JSON.stringify([
          item.id, parsed.data.choiceId,
        ])).digest('hex'),
        nextItemId: stopReason ? null : nextItem?.id || null,
        status: stopReason ? 'ready' : 'in_progress',
        stopReason,
        now: instant,
      });
      return res.status(saved.created ? 201 : 200).json({
        accepted: true,
        ...adaptiveDiagnosticPublicDto(
          saved.diagnostic,
          getDiagnosticItem(
            saved.diagnostic.catalog_version,
            saved.diagnostic.current_item_id,
            diagnosticRegistry,
          ),
          targetPolicy,
        ),
      });
    } catch (error) {
      const known = {
        ADAPTIVE_DIAGNOSTIC_NOT_FOUND: [404, 'DIAGNOSTIC_NOT_FOUND'],
        ADAPTIVE_DIAGNOSTIC_ITEM_ALREADY_ANSWERED: [409, 'DIAGNOSTIC_ITEM_ALREADY_ANSWERED'],
        ADAPTIVE_DIAGNOSTIC_ITEM_NOT_CURRENT: [409, 'DIAGNOSTIC_ITEM_NOT_CURRENT'],
        ADAPTIVE_DIAGNOSTIC_TIME_EXPIRED: [409, 'DIAGNOSTIC_TIME_EXPIRED'],
        ADAPTIVE_DIAGNOSTIC_IDEMPOTENCY_CONFLICT: [409, 'IDEMPOTENCY_CONFLICT'],
      }[error?.message];
      if (known) return res.status(known[0]).json({ error: { code: known[1] } });
      return next(error);
    }
  });

  router.post('/api/v1/adaptive-learning/diagnostics/:diagnosticId/complete', auth, async (req, res, next) => {
    const parsed = adaptiveDiagnosticStartSchema.safeParse(req.body);
    const idempotencyKey = String(req.headers['idempotency-key'] || '');
    if (!parsed.success || !IDEMPOTENCY_KEY.test(idempotencyKey)
      || !DIAGNOSTIC_ID.test(req.params.diagnosticId)) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR' } });
    }
    try {
      const completionRequestHash = crypto.createHash('sha256').update('{}').digest('hex');
      const completionReplay = await db.getAdaptiveDiagnosticCompletionReplay(req.user, {
        diagnosticId: req.params.diagnosticId,
        idempotencyKey,
        requestHash: completionRequestHash,
      });
      if (completionReplay) {
        if (!getDiagnosticPolicy(completionReplay.diagnostic.catalogVersion, diagnosticRegistry)) {
          return unsupportedDiagnosticCatalog(res);
        }
        return res.json(completionReplay);
      }
      const target = await db.getAdaptiveDiagnostic(req.user, req.params.diagnosticId);
      if (!target) return res.status(404).json({ error: { code: 'DIAGNOSTIC_NOT_FOUND' } });
      const targetPolicy = getDiagnosticPolicy(target.catalog_version, diagnosticRegistry);
      if (!targetPolicy) return unsupportedDiagnosticCatalog(res);
      const instant = now();
      const sources = await db.getAdaptiveLearningEvidenceSources(req.user);
      const completionProfile = buildAdaptiveLearningProfile({
        ...sources,
        diagnosticResponses: [
          ...(sources.diagnosticResponses || []),
          ...(target.responses || []).map((response) => ({
            ...response,
            catalog_version: target.catalog_version,
          })),
        ],
        diagnosticCompletions: [
          ...(sources.diagnosticCompletions || []),
          { catalog_version: target.catalog_version, completed_at: instant },
        ],
      }, { diagnosticRegistry });
      const profileSnapshot = adaptiveLearningProfileSnapshotDto(completionProfile);
      const diagnosticView = adaptiveDiagnosticPublicDto({
        ...target,
        status: 'completed',
        current_item_id: null,
        completed_at: instant,
        updated_at: instant,
      }, null, targetPolicy);
      const responseSnapshot = {
        completed: true,
        ...diagnosticView,
        result: {
          preliminary: profileSnapshot.preliminary,
          confidence: profileSnapshot.confidence,
          answeredItems: Number(target.answered_items),
          correctItems: Number(target.correct_items),
          explanationCodes: profileSnapshot.explanationCodes,
        },
        profile: profileSnapshot,
      };
      const saved = await db.completeAdaptiveDiagnostic(req.user, {
        diagnosticId: req.params.diagnosticId,
        idempotencyKey,
        requestHash: completionRequestHash,
        responseSnapshot,
        now: instant,
      });
      if (saved.created) {
        await db.saveAdaptiveLearningProfile(req.user, completionProfile, { now: instant });
      }
      return res.status(saved.created ? 201 : 200).json(saved.responseSnapshot);
    } catch (error) {
      const known = {
        ADAPTIVE_DIAGNOSTIC_NOT_FOUND: [404, 'DIAGNOSTIC_NOT_FOUND'],
        ADAPTIVE_DIAGNOSTIC_NOT_READY: [409, 'DIAGNOSTIC_NOT_READY'],
        ADAPTIVE_DIAGNOSTIC_TIME_EXPIRED: [409, 'DIAGNOSTIC_TIME_EXPIRED'],
        ADAPTIVE_DIAGNOSTIC_IDEMPOTENCY_CONFLICT: [409, 'IDEMPOTENCY_CONFLICT'],
      }[error?.message];
      if (known) return res.status(known[0]).json({ error: { code: known[1] } });
      return next(error);
    }
  });

  return router;
}
