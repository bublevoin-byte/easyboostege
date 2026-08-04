import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  ADAPTIVE_EVIDENCE_WATERMARK_VERSION,
  compareAdaptiveEvidenceWatermarks,
} from './evidence-watermark.js';
import { normalizeCalendarDate } from './calendar-date.js';
import { EGE_SKILL_TAXONOMY } from './profile.js';

export const ADAPTIVE_PLAN_VERSION = 'adaptive-plan-v1';
const MINUTES_PER_SCORE_POINT = 120;
const STUDY_EFFECTIVENESS = 0.75;
const ORDINARY_CHANGE_LIMIT = 10;
const MAX_WEEKLY_MINUTES = 2520;
const CRITICAL_RETENTION_WINDOW_MS = 24 * 60 * 60 * 1_000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;
const CANONICAL_SKILL_BY_ID = new Map(EGE_SKILL_TAXONOMY.skills.map((skill) => [skill.id, skill]));
const CANONICAL_MODULE_IDS = [...new Set(EGE_SKILL_TAXONOMY.skills.map((skill) => skill.module))].sort();
const ALLOCATION_REASON_CODES = new Set([
  'high_uncertainty', 'due_review', 'critical_retention_expiry', 'target_gap',
  'high_ege_impact', 'deadline_pressure', 'maintenance',
]);
const ACTIVE_ASSUMPTION_CODES = new Set([
  'rule_based_not_calibrated', 'study_time_completed_as_planned',
  'preliminary_profile', 'short_deadline',
]);
const CANDIDATE_KEYS = Object.freeze([
  'basePlanRevision', 'goalId', 'goalRevision', 'id', 'inputFingerprint', 'now', 'plan',
  'profileCalculationRevision', 'profileEvidenceObservedAt', 'profileEvidenceSourceCount',
  'profileEvidenceWatermarkVersion', 'recalculationBucket', 'taxonomyVersion',
]);
const PLAN_KEYS = Object.freeze([
  'allocation', 'basePlanRevision', 'calculatedAt', 'forecast', 'goalId', 'goalRevision',
  'profileCalculationRevision', 'profileEvidenceObservedAt', 'profileEvidenceSourceCount',
  'profileEvidenceWatermarkVersion', 'recalculationBucket', 'stability', 'taxonomyVersion', 'version',
]);

function bounded(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function goalField(goal, camel, snake) {
  return goal?.[camel] ?? goal?.[snake];
}

function profileField(profile, camel, snake) {
  return profile?.[camel] ?? profile?.[snake];
}

function isoDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

function calculationBucketInstant(value) {
  const bucket = isoDate(value);
  return bucket ? new Date(`${bucket}T00:00:00.000Z`) : new Date(Number.NaN);
}

function largestRemainder(items, total, minimum = 0) {
  const safeTotal = Math.max(total, items.length * minimum);
  const weightTotal = items.reduce((sum, item) => sum + Math.max(0, item.weight), 0) || items.length;
  const remaining = safeTotal - items.length * minimum;
  const allocations = items.map((item) => {
    const exact = remaining * (Math.max(0, item.weight) || (weightTotal === items.length ? 1 : 0)) / weightTotal;
    return { id: item.id, weight: item.weight, exact, value: minimum + Math.floor(exact) };
  });
  let missing = safeTotal - allocations.reduce((sum, item) => sum + item.value, 0);
  allocations.sort((left, right) => (
    (right.exact - Math.floor(right.exact)) - (left.exact - Math.floor(left.exact))
      || right.weight - left.weight || left.id.localeCompare(right.id)
  ));
  for (let index = 0; index < missing; index += 1) allocations[index % allocations.length].value += 1;
  return new Map(allocations.map((item) => [item.id, item.value]));
}

function stableApportion(items, total, previousById, minimum = 0) {
  const desired = largestRemainder(items, total, minimum);
  if (!previousById || !items.every((item) => previousById.has(item.id))) return desired;
  const entries = items.map((item) => {
    const previous = previousById.get(item.id);
    const lower = Math.max(minimum, previous - ORDINARY_CHANGE_LIMIT);
    const upper = previous + ORDINARY_CHANGE_LIMIT;
    return {
      id: item.id,
      desired: desired.get(item.id),
      weight: item.weight,
      lower,
      upper,
      value: bounded(desired.get(item.id), lower, upper),
    };
  });
  let delta = total - entries.reduce((sum, item) => sum + item.value, 0);
  while (delta !== 0) {
    const candidates = entries.filter((item) => delta > 0 ? item.value < item.upper : item.value > item.lower);
    if (!candidates.length) throw new Error('ADAPTIVE_PLAN_STABILITY_BOUNDS_INFEASIBLE');
    candidates.sort((left, right) => {
      const leftNeed = delta > 0 ? left.desired - left.value : left.value - left.desired;
      const rightNeed = delta > 0 ? right.desired - right.value : right.value - right.desired;
      return rightNeed - leftNeed || (delta > 0 ? right.weight - left.weight : left.weight - right.weight)
        || left.id.localeCompare(right.id);
    });
    candidates[0].value += delta > 0 ? 1 : -1;
    delta += delta > 0 ? -1 : 1;
  }
  return new Map(entries.map((item) => [item.id, item.value]));
}

function priorityFor(skill, estimate, targetScore, weeks) {
  const mastery = bounded(number(estimate?.mastery), 0, 100);
  const uncertainty = bounded(number(estimate?.uncertainty, 100), 0, 100);
  const targetGap = Math.max(5, targetScore - mastery);
  const dueState = estimate?.dueState ?? estimate?.due_state ?? 'not_due';
  const dueMultiplier = dueState === 'critical_due' ? 2.2 : dueState === 'overdue' ? 1.8
    : dueState === 'due' ? 1.4 : 1;
  const deadlineUrgency = bounded((12 - weeks) / 12, 0, 1);
  const relativeDeadlineMultiplier = 1 + deadlineUrgency * (
    skill.egeWeight * 0.7 + bounded(targetGap / 100, 0, 1) * 0.8
  );
  const uncertaintyMultiplier = 1 + uncertainty / 200;
  return targetGap * skill.egeWeight * dueMultiplier * relativeDeadlineMultiplier * uncertaintyMultiplier;
}

function reasonCodesFor(skill, estimate, targetScore, weeks, criticalRetention) {
  const reasons = [];
  const mastery = bounded(number(estimate?.mastery), 0, 100);
  const uncertainty = bounded(number(estimate?.uncertainty, 100), 0, 100);
  const dueState = estimate?.dueState ?? estimate?.due_state ?? 'not_due';
  if (uncertainty >= 70) reasons.push('high_uncertainty');
  if (dueState === 'due' || dueState === 'overdue' || dueState === 'critical_due') reasons.push('due_review');
  if (criticalRetention) reasons.push('critical_retention_expiry');
  if (mastery < targetScore) reasons.push('target_gap');
  if (skill.egeWeight >= 0.9) reasons.push('high_ege_impact');
  if (weeks < 12) reasons.push('deadline_pressure');
  if (!reasons.length) reasons.push('maintenance');
  return reasons;
}

function criticalRetentionExpiresSoon(estimate, now) {
  if ((estimate?.dueState ?? estimate?.due_state) !== 'critical_due') return false;
  const expiresAt = estimate?.criticalRetentionExpiresAt ?? estimate?.critical_retention_expires_at;
  const expiresMs = new Date(expiresAt).getTime();
  const nowMs = now.getTime();
  return Number.isFinite(expiresMs) && expiresMs > nowMs
    && expiresMs - nowMs <= CRITICAL_RETENTION_WINDOW_MS;
}

function criticalRetentionScope(profile, now) {
  const estimates = profile?.skills || profile?.estimates || [];
  const skillIds = [...new Set(estimates
    .filter((skill) => criticalRetentionExpiresSoon(skill, now))
    .map((skill) => skill.id ?? skill.skill_id)
    .filter((id) => CANONICAL_SKILL_BY_ID.has(id)))].sort();
  const moduleIds = [...new Set(skillIds.map((id) => CANONICAL_SKILL_BY_ID.get(id).module))].sort();
  return { skillIds, moduleIds };
}

function buildForecast(goal, profile, now) {
  const targetScore = bounded(number(goalField(goal, 'targetScore', 'target_score')), 0, 100);
  const weeklyMinutes = number(goalField(goal, 'weeklyMinutes', 'weekly_minutes'));
  const examDate = new Date(`${goalField(goal, 'examDate', 'exam_date')}T00:00:00.000Z`);
  const remainingMs = examDate.getTime() - now.getTime();
  const weeks = remainingMs > 0 ? remainingMs / WEEK_MS : 0;
  const estimateById = new Map((profile?.skills || profile?.estimates || []).map((skill) => [
    skill.id ?? skill.skill_id, skill,
  ]));
  const weighted = EGE_SKILL_TAXONOMY.skills.reduce((result, skill) => {
    const mastery = bounded(number(estimateById.get(skill.id)?.mastery), 0, 100);
    return { score: result.score + mastery * skill.egeWeight, weight: result.weight + skill.egeWeight };
  }, { score: 0, weight: 0 });
  const currentScore = Math.round(weighted.score / weighted.weight);
  const averageUncertainty = EGE_SKILL_TAXONOMY.skills.reduce((sum, skill) => (
    sum + bounded(number(estimateById.get(skill.id)?.uncertainty, 100), 0, 100)
  ), 0) / EGE_SKILL_TAXONOMY.skills.length;
  const confidence = bounded(Math.round(number(profileField(profile, 'confidence', 'confidence'))), 0, 100);
  if (weeks === 0) {
    return {
      kind: 'action_required',
      status: 'exam_date_expired',
      actionCode: 'update_exam_date',
      currentEstimatedScore: null,
      lowScore: null,
      highScore: null,
      confidence: null,
      requiredWeeklyMinutes: null,
      availableWeeklyMinutes: weeklyMinutes,
      weeksRemaining: 0,
      feasibility: 'update_exam_date_required',
      assumptionCodes: ['exam_date_reached'],
      choices: [{ type: 'update_exam_date', reasonCode: 'exam_date_reached' }],
    };
  }
  const gap = Math.max(0, targetScore - currentScore);
  const uncertaintyFactor = 1 + averageUncertainty / 200;
  const requiredWeeklyMinutes = gap === 0 ? 0
    : Math.ceil((gap * MINUTES_PER_SCORE_POINT * uncertaintyFactor
      / (weeks * STUDY_EFFECTIVENESS)) / 5) * 5;
  const capacityGain = weeklyMinutes * weeks
    / (MINUTES_PER_SCORE_POINT * uncertaintyFactor) * STUDY_EFFECTIVENESS;
  const centre = bounded(Math.round(currentScore + capacityGain), 0, 100);
  const uncertaintyBand = Math.max(4, Math.round((100 - confidence) / 4));
  const lowScore = bounded(centre - uncertaintyBand, 0, 100);
  const highScore = bounded(centre + uncertaintyBand, 0, 100);
  const unlikely = weeklyMinutes < requiredWeeklyMinutes || highScore < targetScore;
  const assumptionCodes = ['rule_based_not_calibrated', 'study_time_completed_as_planned'];
  if (profileField(profile, 'preliminary', 'preliminary')) assumptionCodes.push('preliminary_profile');
  if (weeks < 8) assumptionCodes.push('short_deadline');
  const choices = [];
  if (unlikely && weeklyMinutes < requiredWeeklyMinutes && weeklyMinutes < MAX_WEEKLY_MINUTES) {
    const recommendedWeeklyMinutes = Math.min(MAX_WEEKLY_MINUTES, requiredWeeklyMinutes);
    choices.push({
      type: 'increase_weekly_time',
      weeklyMinutes: recommendedWeeklyMinutes,
      sufficientForEstimatedRequirement: recommendedWeeklyMinutes >= requiredWeeklyMinutes,
      constraintCode: recommendedWeeklyMinutes < requiredWeeklyMinutes
        ? 'maximum_supported_weekly_time' : null,
      reasonCode: 'time_below_estimated_requirement',
    });
  }
  if (unlikely) {
    choices.push({
      type: 'adjust_target_score',
      targetScore: Math.max(currentScore, Math.min(targetScore - 1, highScore)),
      reasonCode: 'target_outside_current_forecast',
    });
  }
  return {
    kind: 'estimated_range',
    status: 'active',
    actionCode: null,
    currentEstimatedScore: currentScore,
    lowScore,
    highScore,
    confidence,
    requiredWeeklyMinutes,
    availableWeeklyMinutes: weeklyMinutes,
    weeksRemaining: weeks,
    feasibility: unlikely ? 'unlikely_with_current_time' : 'feasible_with_consistent_study',
    assumptionCodes,
    choices,
  };
}

export function adaptivePlanInputFingerprint({ goal, profile, basePlanRevision = null, now }) {
  const bucketInstant = calculationBucketInstant(now);
  return crypto.createHash('sha256').update(JSON.stringify([
    ADAPTIVE_PLAN_VERSION,
    goalField(goal, 'id', 'id'),
    number(goalField(goal, 'revision', 'revision')),
    profileField(profile, 'taxonomyVersion', 'taxonomy_version'),
    number(profileField(profile, 'profileCalculationRevision', 'profile_calculation_revision')),
    profileField(profile, 'evidenceWatermarkVersion', 'evidence_watermark_version'),
    number(profileField(profile, 'evidenceSourceCount', 'evidence_source_count')),
    profileField(profile, 'evidenceObservedAt', 'evidence_observed_at') || null,
    basePlanRevision == null ? null : number(basePlanRevision),
    isoDate(bucketInstant),
  ])).digest('hex');
}

function planEvidenceVector(plan) {
  return {
    profileCalculationRevision: plan?.profileCalculationRevision ?? plan?.profile_calculation_revision,
    evidenceWatermarkVersion: plan?.profileEvidenceWatermarkVersion
      ?? plan?.profile_evidence_watermark_version,
    evidenceObservedAt: plan?.profileEvidenceObservedAt ?? plan?.profile_evidence_observed_at,
    evidenceSourceCount: plan?.profileEvidenceSourceCount ?? plan?.profile_evidence_source_count,
  };
}

export function compareAdaptivePlanInputs(candidate, current) {
  if (!current) return 1;
  const nextGoalRevision = number(candidate?.goalRevision ?? candidate?.goal_revision);
  const currentGoalRevision = number(current?.goalRevision ?? current?.goal_revision);
  if (nextGoalRevision !== currentGoalRevision) return nextGoalRevision > currentGoalRevision ? 1 : -1;
  const evidenceOrder = compareAdaptiveEvidenceWatermarks(
    planEvidenceVector(candidate), planEvidenceVector(current),
  );
  if (evidenceOrder !== 0) return evidenceOrder;
  const nextBucket = isoDate(candidate?.recalculationBucket ?? candidate?.recalculation_bucket);
  const currentBucket = isoDate(current?.recalculationBucket ?? current?.recalculation_bucket);
  if (nextBucket === currentBucket) return 0;
  return nextBucket > currentBucket ? 1 : -1;
}

function allocationById(items) {
  return new Map((Array.isArray(items) ? items : []).map((item) => [item.id, item]));
}

function validateAllocationItems(items, expectedIds) {
  if (!Array.isArray(items) || items.length !== expectedIds.length
    || new Set(items.map((item) => item.id)).size !== items.length
    || expectedIds.some((id) => !items.some((item) => item.id === id))
    || items.some((item) => !item.id || !Number.isInteger(item.percentage)
      || item.percentage < 0 || item.percentage > 100)
    || items.reduce((sum, item) => sum + item.percentage, 0) !== 100) {
    throw new Error('ADAPTIVE_PLAN_STABILITY_VIOLATION');
  }
}

function persistenceInvalid() {
  throw new Error('ADAPTIVE_PLAN_INVALID');
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  return isRecord(value)
    && Object.keys(value).sort().join('\u0000') === [...expected].sort().join('\u0000');
}

function isUuid(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
}

function isCanonicalIso(value) {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isCanonicalBucket(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isIntegerBetween(value, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function hasUniqueAllowedStrings(values, allowed, { minimum = 0 } = {}) {
  return Array.isArray(values) && values.length >= minimum
    && new Set(values).size === values.length
    && values.every((value) => typeof value === 'string' && allowed.has(value));
}

function validateForecastChoice(choice) {
  if (!isRecord(choice)) persistenceInvalid();
  if (choice.type === 'increase_weekly_time') {
    if (!hasExactKeys(choice, [
      'constraintCode', 'reasonCode', 'sufficientForEstimatedRequirement', 'type', 'weeklyMinutes',
    ])
      || !isIntegerBetween(choice.weeklyMinutes, 30, MAX_WEEKLY_MINUTES)
      || choice.weeklyMinutes % 5 !== 0
      || typeof choice.sufficientForEstimatedRequirement !== 'boolean'
      || ![null, 'maximum_supported_weekly_time'].includes(choice.constraintCode)
      || choice.reasonCode !== 'time_below_estimated_requirement'
      || choice.sufficientForEstimatedRequirement !== (choice.constraintCode === null)
      || (choice.constraintCode === 'maximum_supported_weekly_time'
        && choice.weeklyMinutes !== MAX_WEEKLY_MINUTES)) persistenceInvalid();
    return;
  }
  if (choice.type === 'adjust_target_score') {
    if (!hasExactKeys(choice, ['reasonCode', 'targetScore', 'type'])
      || !isIntegerBetween(choice.targetScore, 0, 100)
      || choice.reasonCode !== 'target_outside_current_forecast') persistenceInvalid();
    return;
  }
  if (choice.type === 'update_exam_date') {
    if (!hasExactKeys(choice, ['reasonCode', 'type'])
      || choice.reasonCode !== 'exam_date_reached') persistenceInvalid();
    return;
  }
  persistenceInvalid();
}

function validateForecast(forecast) {
  const keys = [
    'actionCode', 'assumptionCodes', 'availableWeeklyMinutes', 'choices', 'confidence',
    'currentEstimatedScore', 'feasibility', 'highScore', 'kind', 'lowScore',
    'requiredWeeklyMinutes', 'status', 'weeksRemaining',
  ];
  if (!hasExactKeys(forecast, keys)
    || !isIntegerBetween(forecast.availableWeeklyMinutes, 30, MAX_WEEKLY_MINUTES)
    || forecast.availableWeeklyMinutes % 5 !== 0
    || !Array.isArray(forecast.choices)
    || forecast.choices.length > 2) persistenceInvalid();
  forecast.choices.forEach(validateForecastChoice);
  if (forecast.kind === 'action_required') {
    if (forecast.status !== 'exam_date_expired' || forecast.actionCode !== 'update_exam_date'
      || forecast.currentEstimatedScore !== null || forecast.lowScore !== null
      || forecast.highScore !== null || forecast.confidence !== null
      || forecast.requiredWeeklyMinutes !== null || forecast.weeksRemaining !== 0
      || forecast.feasibility !== 'update_exam_date_required'
      || JSON.stringify(forecast.assumptionCodes) !== JSON.stringify(['exam_date_reached'])
      || forecast.choices.length !== 1 || forecast.choices[0].type !== 'update_exam_date') {
      persistenceInvalid();
    }
    return;
  }
  if (forecast.kind !== 'estimated_range' || forecast.status !== 'active' || forecast.actionCode !== null
    || !isIntegerBetween(forecast.currentEstimatedScore, 0, 100)
    || !isIntegerBetween(forecast.lowScore, 0, 100)
    || !isIntegerBetween(forecast.highScore, 0, 100)
    || forecast.lowScore > forecast.highScore
    || !isIntegerBetween(forecast.confidence, 0, 100)
    || !isIntegerBetween(forecast.requiredWeeklyMinutes, 0)
    || forecast.requiredWeeklyMinutes % 5 !== 0
    || !Number.isFinite(forecast.weeksRemaining) || forecast.weeksRemaining <= 0
    || !['feasible_with_consistent_study', 'unlikely_with_current_time'].includes(forecast.feasibility)
    || !hasUniqueAllowedStrings(forecast.assumptionCodes, ACTIVE_ASSUMPTION_CODES, { minimum: 2 })
    || !forecast.assumptionCodes.includes('rule_based_not_calibrated')
    || !forecast.assumptionCodes.includes('study_time_completed_as_planned')) persistenceInvalid();
  if (forecast.feasibility === 'feasible_with_consistent_study'
    && (forecast.choices.length !== 0
      || forecast.availableWeeklyMinutes < forecast.requiredWeeklyMinutes)) persistenceInvalid();
  const shouldOfferIncrease = forecast.availableWeeklyMinutes < forecast.requiredWeeklyMinutes
    && forecast.availableWeeklyMinutes < MAX_WEEKLY_MINUTES;
  if (forecast.feasibility === 'unlikely_with_current_time'
    && (forecast.choices.length !== (shouldOfferIncrease ? 2 : 1)
      || (shouldOfferIncrease && forecast.choices[0].type !== 'increase_weekly_time')
      || forecast.choices.at(-1)?.type !== 'adjust_target_score')) persistenceInvalid();
  if (forecast.feasibility === 'unlikely_with_current_time') {
    const increase = shouldOfferIncrease ? forecast.choices[0] : null;
    const adjustedTarget = forecast.choices.at(-1);
    const requirementSupported = forecast.requiredWeeklyMinutes <= MAX_WEEKLY_MINUTES;
    const expectedMinutes = Math.min(MAX_WEEKLY_MINUTES, forecast.requiredWeeklyMinutes);
    if (increase && (increase.weeklyMinutes !== expectedMinutes
      || increase.weeklyMinutes <= forecast.availableWeeklyMinutes
      || increase.sufficientForEstimatedRequirement !== requirementSupported
      || increase.constraintCode !== (requirementSupported ? null : 'maximum_supported_weekly_time'))) {
      persistenceInvalid();
    }
    if (adjustedTarget.targetScore < forecast.currentEstimatedScore
      || adjustedTarget.targetScore > forecast.highScore) persistenceInvalid();
  }
}

function validateAllocationPersistence(allocation) {
  if (!hasExactKeys(allocation, ['modules', 'skills'])) persistenceInvalid();
  try {
    validateAllocationShape(allocation);
  } catch {
    persistenceInvalid();
  }
  for (const module of allocation.modules) {
    if (!hasExactKeys(module, ['id', 'percentage', 'reasonCodes'])
      || !hasUniqueAllowedStrings(module.reasonCodes, ALLOCATION_REASON_CODES, { minimum: 1 })) {
      persistenceInvalid();
    }
  }
  for (const skill of allocation.skills) {
    const canonical = CANONICAL_SKILL_BY_ID.get(skill.id);
    if (!hasExactKeys(skill, ['activityType', 'id', 'label', 'module', 'percentage', 'reasonCodes'])
      || skill.label !== canonical.label || skill.module !== canonical.module
      || !['diagnostic_probe', 'retention_review', 'practice'].includes(skill.activityType)
      || !hasUniqueAllowedStrings(skill.reasonCodes, ALLOCATION_REASON_CODES, { minimum: 1 })) {
      persistenceInvalid();
    }
  }
}

function validateStability(stability, { basePlanRevision }) {
  if (!hasExactKeys(stability, [
    'applied', 'bypassReason', 'bypassedModuleIds', 'bypassedSkillIds',
    'maximumChangePercentagePoints',
  ])
    || typeof stability.applied !== 'boolean'
    || stability.maximumChangePercentagePoints !== ORDINARY_CHANGE_LIMIT
    || ![null, 'goal_changed'].includes(stability.bypassReason)
    || !hasUniqueAllowedStrings(stability.bypassedSkillIds, new Set(CANONICAL_SKILL_BY_ID.keys()))
    || !hasUniqueAllowedStrings(stability.bypassedModuleIds, new Set(CANONICAL_MODULE_IDS))) {
    persistenceInvalid();
  }
  if (stability.bypassReason === null
    && (stability.bypassedSkillIds.length || stability.bypassedModuleIds.length)) persistenceInvalid();
  if (stability.bypassReason === 'goal_changed'
    && (stability.applied || stability.bypassedSkillIds.length || stability.bypassedModuleIds.length)) {
    persistenceInvalid();
  }
  if ((basePlanRevision === null && (stability.applied || stability.bypassReason !== null))
    || (basePlanRevision !== null && stability.bypassReason === null && !stability.applied)) {
    persistenceInvalid();
  }
}

function profileVectorValue(profile, camel, snake) {
  return profile?.[camel] ?? profile?.[snake];
}

function normalizedProfileObservedAt(profile) {
  const value = profileVectorValue(profile, 'evidenceObservedAt', 'evidence_observed_at');
  if (value == null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function normalizedReplayTimestamp(value) {
  if (value == null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function adaptivePlanReplaySemantics(value) {
  const plan = value?.plan || {};
  const recalculationBucket = normalizeCalendarDate(
    value?.recalculationBucket ?? value?.recalculation_bucket ?? plan.recalculationBucket,
  );
  const calculatedAt = normalizedReplayTimestamp(
    plan.calculatedAt ?? value?.calculatedAt ?? value?.calculated_at,
  ) ?? calculationBucketInstant(recalculationBucket).toISOString();
  const basePlanRevision = value?.basePlanRevision ?? value?.base_plan_revision
    ?? plan.basePlanRevision ?? null;
  const goalId = value?.goalId ?? value?.goal_id ?? plan.goalId;
  const goalRevision = Number(value?.goalRevision ?? value?.goal_revision ?? plan.goalRevision);
  const taxonomyVersion = value?.taxonomyVersion ?? value?.taxonomy_version ?? plan.taxonomyVersion;
  const profileCalculationRevision = Number(
    value?.profileCalculationRevision ?? value?.profile_calculation_revision
      ?? plan.profileCalculationRevision,
  );
  const profileEvidenceWatermarkVersion = value?.profileEvidenceWatermarkVersion
    ?? value?.profile_evidence_watermark_version ?? plan.profileEvidenceWatermarkVersion;
  const profileEvidenceObservedAt = normalizedReplayTimestamp(
    value?.profileEvidenceObservedAt ?? value?.profile_evidence_observed_at
      ?? plan.profileEvidenceObservedAt,
  );
  const profileEvidenceSourceCount = Number(
    value?.profileEvidenceSourceCount ?? value?.profile_evidence_source_count
      ?? plan.profileEvidenceSourceCount,
  );
  return {
    inputFingerprint: value?.inputFingerprint ?? value?.input_fingerprint,
    basePlanRevision: basePlanRevision == null ? null : Number(basePlanRevision),
    goalId,
    goalRevision,
    taxonomyVersion,
    profileCalculationRevision,
    profileEvidenceWatermarkVersion,
    profileEvidenceObservedAt,
    profileEvidenceSourceCount,
    recalculationBucket,
    plan: {
      version: plan.version ?? value?.plan_version,
      goalId,
      goalRevision,
      basePlanRevision: basePlanRevision == null ? null : Number(basePlanRevision),
      taxonomyVersion,
      profileCalculationRevision,
      profileEvidenceWatermarkVersion,
      profileEvidenceObservedAt,
      profileEvidenceSourceCount,
      recalculationBucket,
      calculatedAt,
      forecast: plan.forecast ?? value?.forecast,
      allocation: plan.allocation ?? value?.allocation,
      stability: plan.stability ?? value?.stability,
    },
  };
}

export function assertAdaptivePlanDuplicateReplay(candidate, retainedRevision) {
  if (!retainedRevision || !isDeepStrictEqual(
    adaptivePlanReplaySemantics(candidate),
    adaptivePlanReplaySemantics(retainedRevision),
  )) {
    throw new Error('ADAPTIVE_PLAN_REPLAY_MISMATCH');
  }
}

export function assertAdaptivePlanPersistenceCandidate(candidate, options = {}) {
  const authoritativeProfile = options.authoritativeProfile;
  const requireAuthoritativeProfile = Object.hasOwn(options, 'authoritativeProfile');
  if (!hasExactKeys(candidate, CANDIDATE_KEYS)
    || !isUuid(candidate.id) || !isUuid(candidate.goalId)
    || typeof candidate.inputFingerprint !== 'string'
    || !/^[0-9a-f]{64}$/u.test(candidate.inputFingerprint)
    || (candidate.basePlanRevision !== null && !isIntegerBetween(candidate.basePlanRevision, 1))
    || !isIntegerBetween(candidate.goalRevision, 1)
    || candidate.taxonomyVersion !== EGE_SKILL_TAXONOMY.version
    || !isIntegerBetween(candidate.profileCalculationRevision, 1)
    || candidate.profileEvidenceWatermarkVersion !== ADAPTIVE_EVIDENCE_WATERMARK_VERSION
    || (candidate.profileEvidenceObservedAt !== null
      && !isCanonicalIso(candidate.profileEvidenceObservedAt))
    || !isIntegerBetween(candidate.profileEvidenceSourceCount, 0)
    || !isCanonicalBucket(candidate.recalculationBucket)
    || !(candidate.now instanceof Date) || !Number.isFinite(candidate.now.getTime())
    || candidate.recalculationBucket !== candidate.now.toISOString().slice(0, 10)
    || !hasExactKeys(candidate.plan, PLAN_KEYS)) persistenceInvalid();
  const plan = candidate.plan;
  if (plan.version !== ADAPTIVE_PLAN_VERSION || plan.goalId !== candidate.goalId
    || plan.goalRevision !== candidate.goalRevision
    || plan.basePlanRevision !== candidate.basePlanRevision
    || plan.taxonomyVersion !== candidate.taxonomyVersion
    || plan.profileCalculationRevision !== candidate.profileCalculationRevision
    || plan.profileEvidenceWatermarkVersion !== candidate.profileEvidenceWatermarkVersion
    || plan.profileEvidenceObservedAt !== candidate.profileEvidenceObservedAt
    || plan.profileEvidenceSourceCount !== candidate.profileEvidenceSourceCount
    || plan.recalculationBucket !== candidate.recalculationBucket
    || !isCanonicalIso(plan.calculatedAt)
    || plan.calculatedAt !== calculationBucketInstant(candidate.recalculationBucket).toISOString()) {
    persistenceInvalid();
  }
  const suppliedMetadataFingerprint = adaptivePlanInputFingerprint({
    goal: { id: candidate.goalId, revision: candidate.goalRevision },
    profile: {
      taxonomyVersion: candidate.taxonomyVersion,
      profileCalculationRevision: candidate.profileCalculationRevision,
      evidenceWatermarkVersion: candidate.profileEvidenceWatermarkVersion,
      evidenceObservedAt: candidate.profileEvidenceObservedAt,
      evidenceSourceCount: candidate.profileEvidenceSourceCount,
    },
    basePlanRevision: candidate.basePlanRevision,
    now: candidate.now,
  });
  if (candidate.inputFingerprint !== suppliedMetadataFingerprint) persistenceInvalid();
  validateForecast(plan.forecast);
  validateAllocationPersistence(plan.allocation);
  validateStability(plan.stability, { basePlanRevision: candidate.basePlanRevision });
  if (requireAuthoritativeProfile && (!authoritativeProfile
    || candidate.taxonomyVersion !== profileVectorValue(
      authoritativeProfile, 'taxonomyVersion', 'taxonomy_version',
    )
    || candidate.profileCalculationRevision !== Number(profileVectorValue(
      authoritativeProfile, 'profileCalculationRevision', 'profile_calculation_revision',
    ))
    || candidate.profileEvidenceWatermarkVersion !== profileVectorValue(
      authoritativeProfile, 'evidenceWatermarkVersion', 'evidence_watermark_version',
    )
    || candidate.profileEvidenceObservedAt !== normalizedProfileObservedAt(authoritativeProfile)
    || candidate.profileEvidenceSourceCount !== Number(profileVectorValue(
      authoritativeProfile, 'evidenceSourceCount', 'evidence_source_count',
    )))) {
    throw new Error('ADAPTIVE_PLAN_PROFILE_STALE');
  }
}

export function assertAdaptivePlanAuthoritativeCandidate(candidate, {
  authoritativeGoal,
  authoritativeProfile,
  currentPlan = null,
} = {}) {
  if (!authoritativeGoal || authoritativeGoal.id !== candidate.goalId
    || Number(authoritativeGoal.revision) !== candidate.goalRevision) {
    throw new Error('ADAPTIVE_PLAN_GOAL_STALE');
  }
  assertAdaptivePlanPersistenceCandidate(candidate, { authoritativeProfile });
  const expectedPlan = buildAdaptiveLearningPlan({
    goal: authoritativeGoal,
    profile: authoritativeProfile,
    previousPlan: currentPlan,
    now: candidate.now,
  });
  const expectedFingerprint = adaptivePlanInputFingerprint({
    goal: authoritativeGoal,
    profile: authoritativeProfile,
    basePlanRevision: currentPlan?.revision ?? null,
    now: candidate.now,
  });
  const mismatches = [
    ['fingerprint', candidate.inputFingerprint, expectedFingerprint],
    ['base_plan_revision', candidate.basePlanRevision, currentPlan?.revision ?? null],
    ['taxonomy_version', candidate.taxonomyVersion, expectedPlan.taxonomyVersion],
    ['profile_calculation_revision', candidate.profileCalculationRevision,
      expectedPlan.profileCalculationRevision],
    ['profile_evidence_watermark_version', candidate.profileEvidenceWatermarkVersion,
      expectedPlan.profileEvidenceWatermarkVersion],
    ['profile_evidence_observed_at', candidate.profileEvidenceObservedAt,
      expectedPlan.profileEvidenceObservedAt],
    ['profile_evidence_source_count', candidate.profileEvidenceSourceCount,
      expectedPlan.profileEvidenceSourceCount],
    ['recalculation_bucket', candidate.recalculationBucket, expectedPlan.recalculationBucket],
  ].filter(([, actual, expected]) => actual !== expected).map(([field]) => field);
  for (const key of PLAN_KEYS) {
    if (!isDeepStrictEqual(candidate.plan[key], expectedPlan[key])) mismatches.push(`plan.${key}`);
  }
  if (mismatches.length) {
    throw new Error('ADAPTIVE_PLAN_AUTHORITY_MISMATCH');
  }
}

function validateAllocationShape(allocation) {
  validateAllocationItems(allocation?.modules, CANONICAL_MODULE_IDS);
  validateAllocationItems(allocation?.skills, [...CANONICAL_SKILL_BY_ID.keys()]);
  for (const skill of allocation.skills) {
    if (skill.module !== CANONICAL_SKILL_BY_ID.get(skill.id).module) {
      throw new Error('ADAPTIVE_PLAN_STABILITY_VIOLATION');
    }
  }
  for (const module of allocation.modules) {
    const skillTotal = allocation.skills.filter((skill) => skill.module === module.id)
      .reduce((sum, skill) => sum + Number(skill.percentage), 0);
    if (skillTotal !== Number(module.percentage)) {
      throw new Error('ADAPTIVE_PLAN_STABILITY_VIOLATION');
    }
  }
}

export function assertAdaptivePlanStabilityTransition(current, candidate) {
  validateAllocationShape(candidate.allocation);
  if (!current) {
    if (candidate.stability?.bypassReason
      || candidate.stability?.bypassedSkillIds?.length
      || candidate.stability?.bypassedModuleIds?.length) {
      throw new Error('ADAPTIVE_PLAN_STABILITY_VIOLATION');
    }
    return;
  }
  validateAllocationShape(current.allocation);
  const currentGoalRevision = number(current.goal_revision ?? current.goalRevision);
  const candidateGoalRevision = number(candidate.goal_revision ?? candidate.goalRevision);
  const stability = candidate.stability || {};
  const reason = stability.bypassReason ?? null;
  const goalChanged = candidateGoalRevision !== currentGoalRevision;
  if (goalChanged) {
    if (candidateGoalRevision < currentGoalRevision || reason !== 'goal_changed') {
      throw new Error('ADAPTIVE_PLAN_STABILITY_VIOLATION');
    }
    return;
  }
  if (reason === 'goal_changed') throw new Error('ADAPTIVE_PLAN_STABILITY_VIOLATION');
  if (reason) throw new Error('ADAPTIVE_PLAN_STABILITY_VIOLATION');
  const declaredSkillIds = Array.isArray(stability.bypassedSkillIds) ? stability.bypassedSkillIds : [];
  const declaredModuleIds = Array.isArray(stability.bypassedModuleIds) ? stability.bypassedModuleIds : [];
  if (declaredSkillIds.length || declaredModuleIds.length) {
    throw new Error('ADAPTIVE_PLAN_STABILITY_VIOLATION');
  }
  for (const kind of ['modules', 'skills']) {
    const before = allocationById(current.allocation[kind]);
    const after = allocationById(candidate.allocation[kind]);
    if (before.size !== after.size || [...before.keys()].some((id) => !after.has(id))) {
      throw new Error('ADAPTIVE_PLAN_STABILITY_VIOLATION');
    }
    for (const [id, item] of after) {
      if (Math.abs(number(item.percentage) - number(before.get(id).percentage)) > ORDINARY_CHANGE_LIMIT) {
        throw new Error('ADAPTIVE_PLAN_STABILITY_VIOLATION');
      }
    }
  }
}

export function buildAdaptiveLearningPlan({ goal, profile, previousPlan = null, now = new Date() }) {
  if (!goal || !profile) throw new Error('ADAPTIVE_PLAN_INPUT_REQUIRED');
  const instant = calculationBucketInstant(now);
  if (!Number.isFinite(instant.getTime())) throw new Error('ADAPTIVE_PLAN_INPUT_REQUIRED');
  const targetScore = bounded(number(goalField(goal, 'targetScore', 'target_score')), 0, 100);
  const examDate = new Date(`${goalField(goal, 'examDate', 'exam_date')}T00:00:00.000Z`);
  const weeks = Math.max(0, (examDate.getTime() - instant.getTime()) / WEEK_MS);
  const estimates = profile.skills || profile.estimates || [];
  const estimateById = new Map(estimates.map((skill) => [skill.id ?? skill.skill_id, skill]));
  const weightedSkills = EGE_SKILL_TAXONOMY.skills.map((skill) => ({
    id: skill.id,
    module: skill.module,
    weight: priorityFor(skill, estimateById.get(skill.id), targetScore, weeks),
  }));
  const weightedModules = [...new Set(weightedSkills.map((skill) => skill.module))].map((module) => ({
    id: module,
    weight: weightedSkills.filter((skill) => skill.module === module)
      .reduce((sum, skill) => sum + skill.weight, 0),
  }));
  const goalRevision = number(goalField(goal, 'revision', 'revision'));
  const previousGoalRevision = number(previousPlan?.goalRevision ?? previousPlan?.goal_revision, -1);
  const goalChanged = Boolean(previousPlan) && previousGoalRevision !== goalRevision;
  const criticalScope = criticalRetentionScope(profile, instant);
  const criticalSignalSkillIds = new Set(criticalScope.skillIds);
  const stabilityApplied = Boolean(previousPlan) && !goalChanged;
  const previousModules = stabilityApplied ? new Map((previousPlan.allocation?.modules || [])
    .map((module) => [module.id, number(module.percentage)])) : null;
  const moduleShares = stableApportion(weightedModules, 100, previousModules, 2);
  const previousSkills = stabilityApplied ? new Map((previousPlan.allocation?.skills || [])
    .map((skill) => [skill.id, number(skill.percentage)])) : null;
  const skillShares = new Map();
  for (const module of weightedModules) {
    const moduleSkills = weightedSkills.filter((skill) => skill.module === module.id);
    const modulePrevious = previousSkills && new Map(moduleSkills.map((skill) => [skill.id, previousSkills.get(skill.id)]));
    const shares = stableApportion(moduleSkills, moduleShares.get(module.id), modulePrevious, 1);
    for (const [skillId, percentage] of shares) skillShares.set(skillId, percentage);
  }
  const allocationSkills = EGE_SKILL_TAXONOMY.skills.map((skill) => {
    const estimate = estimateById.get(skill.id);
    const uncertainty = bounded(number(estimate?.uncertainty, 100), 0, 100);
    const dueState = estimate?.dueState ?? estimate?.due_state ?? 'not_due';
    return {
      id: skill.id,
      label: skill.label,
      module: skill.module,
      percentage: skillShares.get(skill.id),
      activityType: criticalSignalSkillIds.has(skill.id) ? 'retention_review' : uncertainty >= 70 ? 'diagnostic_probe'
        : dueState === 'due' || dueState === 'overdue'
        ? 'retention_review' : 'practice',
      reasonCodes: reasonCodesFor(skill, estimate, targetScore, weeks, criticalSignalSkillIds.has(skill.id)),
    };
  });
  const allocationModules = weightedModules.map((module) => ({
    id: module.id,
    percentage: moduleShares.get(module.id),
    reasonCodes: [...new Set(allocationSkills.filter((skill) => skill.module === module.id)
      .flatMap((skill) => skill.reasonCodes))],
  }));
  return {
    version: ADAPTIVE_PLAN_VERSION,
    goalId: goalField(goal, 'id', 'id'),
    goalRevision,
    basePlanRevision: previousPlan?.revision == null ? null : number(previousPlan.revision),
    taxonomyVersion: profileField(profile, 'taxonomyVersion', 'taxonomy_version'),
    profileCalculationRevision: number(profileField(
      profile, 'profileCalculationRevision', 'profile_calculation_revision',
    )),
    profileEvidenceWatermarkVersion: profileField(
      profile, 'evidenceWatermarkVersion', 'evidence_watermark_version',
    ),
    profileEvidenceObservedAt: profileField(
      profile, 'evidenceObservedAt', 'evidence_observed_at',
    ) || null,
    profileEvidenceSourceCount: number(profileField(profile, 'evidenceSourceCount', 'evidence_source_count')),
    recalculationBucket: isoDate(instant),
    calculatedAt: instant.toISOString(),
    stability: {
      applied: stabilityApplied,
      maximumChangePercentagePoints: ORDINARY_CHANGE_LIMIT,
      bypassReason: goalChanged ? 'goal_changed' : null,
      bypassedSkillIds: [],
      bypassedModuleIds: [],
    },
    forecast: buildForecast(goal, profile, instant),
    allocation: { modules: allocationModules, skills: allocationSkills },
  };
}
