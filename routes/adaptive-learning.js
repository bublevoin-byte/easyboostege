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
  DIAGNOSTIC_REGISTRY,
  getDiagnosticItem,
  getDiagnosticPolicy,
  selectDiagnosticItem,
} from '../adaptive-learning/diagnostic-catalog.js';
import {
  adaptiveDiagnosticAnswerSchema,
  adaptiveDiagnosticStartSchema,
  adaptiveGoalSchema,
  isFutureExamDate,
} from '../validation/adaptive-learning.js';

const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,119}$/u;
const DIAGNOSTIC_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
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

export function createAdaptiveLearningRoutes({
  authentication,
  db,
  now = () => new Date(),
  enabled = false,
  diagnosticRegistry = DIAGNOSTIC_REGISTRY,
}) {
  const router = express.Router();
  if (!enabled) return router;
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
