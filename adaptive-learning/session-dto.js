import { assertAdaptiveLearningSession } from './session.js';

function timestamp(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function publicSession(value) {
  if (!value) return null;
  if ('session_version' in value) {
    return {
      id: value.id,
      sessionVersion: value.session_version,
      revision: Number(value.revision),
      planId: value.plan_id,
      planRevision: Number(value.plan_revision),
      previewFingerprint: value.preview_fingerprint,
      composerPolicyVersion: value.composer_policy_version,
      contentRegistryVersion: value.content_registry_version,
      taxonomyVersion: value.taxonomy_version,
      weekStart: timestamp(value.week_start),
      durationMinutes: Number(value.duration_minutes),
      learningMinutes: Number(value.learning_minutes),
      breakMinutes: Number(value.break_minutes),
      weeklyBudgetSnapshot: structuredClone(value.weekly_budget_snapshot),
      blocks: structuredClone(value.blocks),
      status: value.status,
      currentBlockId: value.current_block_id,
      completedLearningMinutes: Number(value.completed_learning_minutes),
      replacement: value.replacement == null ? null : structuredClone(value.replacement),
      createdAt: timestamp(value.created_at),
      updatedAt: timestamp(value.updated_at),
    };
  }
  return structuredClone(value);
}

export function adaptiveLearningSessionPublicDto(value) {
  const session = publicSession(value);
  if (!session) return null;
  assertAdaptiveLearningSession(session);
  return session;
}

export function adaptiveLearningSessionRepositoryDto(value) {
  const session = adaptiveLearningSessionPublicDto(value);
  if (!session) return null;
  return {
    id: session.id,
    session_version: session.sessionVersion,
    revision: session.revision,
    plan_id: session.planId,
    plan_revision: session.planRevision,
    preview_fingerprint: session.previewFingerprint,
    composer_policy_version: session.composerPolicyVersion,
    content_registry_version: session.contentRegistryVersion,
    taxonomy_version: session.taxonomyVersion,
    week_start: session.weekStart,
    duration_minutes: session.durationMinutes,
    learning_minutes: session.learningMinutes,
    break_minutes: session.breakMinutes,
    weekly_budget_snapshot: structuredClone(session.weeklyBudgetSnapshot),
    blocks: structuredClone(session.blocks),
    status: session.status,
    current_block_id: session.currentBlockId,
    completed_learning_minutes: session.completedLearningMinutes,
    replacement: session.replacement == null ? null : structuredClone(session.replacement),
    created_at: session.createdAt,
    updated_at: session.updatedAt,
  };
}
