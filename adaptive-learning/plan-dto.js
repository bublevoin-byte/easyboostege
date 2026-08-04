import { normalizeCalendarDate } from './calendar-date.js';

function timestamp(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function bucketTimestamp(value) {
  const bucket = normalizeCalendarDate(value);
  return bucket ? `${bucket}T00:00:00.000Z` : null;
}

function forecastDto(forecast = {}) {
  const nullableNumber = (value) => value == null ? null : Number(value);
  return {
    kind: forecast.kind,
    status: forecast.status,
    actionCode: forecast.actionCode ?? null,
    currentEstimatedScore: nullableNumber(forecast.currentEstimatedScore),
    lowScore: nullableNumber(forecast.lowScore),
    highScore: nullableNumber(forecast.highScore),
    confidence: nullableNumber(forecast.confidence),
    requiredWeeklyMinutes: nullableNumber(forecast.requiredWeeklyMinutes),
    availableWeeklyMinutes: Number(forecast.availableWeeklyMinutes),
    weeksRemaining: Number(forecast.weeksRemaining),
    feasibility: forecast.feasibility,
    assumptionCodes: Array.isArray(forecast.assumptionCodes) ? [...forecast.assumptionCodes] : [],
    choices: Array.isArray(forecast.choices) ? forecast.choices.map((choice) => ({
      type: choice.type,
      ...(choice.weeklyMinutes == null ? {} : { weeklyMinutes: Number(choice.weeklyMinutes) }),
      ...(choice.targetScore == null ? {} : { targetScore: Number(choice.targetScore) }),
      ...(choice.sufficientForEstimatedRequirement == null ? {} : {
        sufficientForEstimatedRequirement: Boolean(choice.sufficientForEstimatedRequirement),
      }),
      ...(choice.constraintCode === undefined ? {} : { constraintCode: choice.constraintCode ?? null }),
      reasonCode: choice.reasonCode,
    })) : [],
  };
}

function allocationDto(allocation = {}) {
  return {
    modules: Array.isArray(allocation.modules) ? allocation.modules.map((module) => ({
      id: module.id,
      percentage: Number(module.percentage),
      reasonCodes: Array.isArray(module.reasonCodes) ? [...module.reasonCodes] : [],
    })) : [],
    skills: Array.isArray(allocation.skills) ? allocation.skills.map((skill) => ({
      id: skill.id,
      label: skill.label,
      module: skill.module,
      percentage: Number(skill.percentage),
      activityType: skill.activityType,
      reasonCodes: Array.isArray(skill.reasonCodes) ? [...skill.reasonCodes] : [],
    })) : [],
  };
}

function stabilityDto(stability = {}) {
  return {
    applied: Boolean(stability.applied),
    maximumChangePercentagePoints: Number(stability.maximumChangePercentagePoints),
    bypassReason: stability.bypassReason ?? null,
    bypassedSkillIds: Array.isArray(stability.bypassedSkillIds) ? [...stability.bypassedSkillIds] : [],
    bypassedModuleIds: Array.isArray(stability.bypassedModuleIds) ? [...stability.bypassedModuleIds] : [],
  };
}

export function adaptiveLearningPlanRepositoryDto(plan) {
  if (!plan) return null;
  return {
    id: plan.id,
    plan_version: plan.plan_version,
    revision: Number(plan.revision),
    base_plan_revision: plan.base_plan_revision == null ? null : Number(plan.base_plan_revision),
    goal_id: plan.goal_id,
    goal_revision: Number(plan.goal_revision),
    taxonomy_version: plan.taxonomy_version,
    profile_calculation_revision: Number(plan.profile_calculation_revision),
    profile_evidence_watermark_version: plan.profile_evidence_watermark_version,
    profile_evidence_observed_at: timestamp(plan.profile_evidence_observed_at),
    profile_evidence_source_count: Number(plan.profile_evidence_source_count),
    recalculation_bucket: normalizeCalendarDate(plan.recalculation_bucket),
    calculated_at: bucketTimestamp(plan.recalculation_bucket),
    forecast: forecastDto(plan.forecast),
    allocation: allocationDto(plan.allocation),
    stability: stabilityDto(plan.stability),
    created_at: timestamp(plan.created_at),
    updated_at: timestamp(plan.updated_at),
  };
}

export function adaptiveLearningPlanPublicDto(plan) {
  const normalized = adaptiveLearningPlanRepositoryDto(plan);
  if (!normalized) return null;
  return {
    id: normalized.id,
    version: normalized.plan_version,
    revision: normalized.revision,
    basePlanRevision: normalized.base_plan_revision,
    goalRevision: normalized.goal_revision,
    taxonomyVersion: normalized.taxonomy_version,
    profileCalculationRevision: normalized.profile_calculation_revision,
    profileEvidenceWatermarkVersion: normalized.profile_evidence_watermark_version,
    profileEvidenceObservedAt: normalized.profile_evidence_observed_at,
    profileEvidenceSourceCount: normalized.profile_evidence_source_count,
    recalculationBucket: normalized.recalculation_bucket,
    calculatedAt: normalized.calculated_at,
    forecast: normalized.forecast,
    allocation: normalized.allocation,
    stability: normalized.stability,
    createdAt: normalized.created_at,
    updatedAt: normalized.updated_at,
  };
}
