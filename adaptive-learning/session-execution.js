import crypto from 'node:crypto';

export const ADAPTIVE_EXECUTION_VERSION = 'adaptive-execution-v1';
export const ADAPTIVE_EXECUTION_CLAIM_TTL_MS = 2 * 60 * 60 * 1000;

export function adaptiveExecutionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function adaptiveExecutionTokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

export function adaptiveExecutionRequestHash(value) {
  const canonical = (item) => {
    if (Array.isArray(item)) return item.map(canonical);
    if (!item || typeof item !== 'object') return item;
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, canonical(item[key])]));
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export function adaptiveLaunchFingerprint(block) {
  return adaptiveExecutionRequestHash({
    module: block.module,
    skillId: block.skillId,
    activityId: block.activityId,
    contentRef: block.contentRef,
    launch: block.launch,
  });
}

export function adaptiveExecutionView(session, events = []) {
  const completedBlockIds = events
    .filter((event) => event.event_type === 'block_completed')
    .map((event) => event.block_id);
  return {
    version: ADAPTIVE_EXECUTION_VERSION,
    revision: Number(session.execution_revision || 0),
    status: session.status,
    currentBlockId: session.current_block_id ?? session.currentBlockId ?? null,
    completedBlockIds,
    readyToFinish: session.status === 'in_progress'
      && !((session.current_block_id ?? session.currentBlockId) || null),
    startedAt: timestamp(session.started_at ?? session.startedAt),
    completedAt: timestamp(session.completed_at ?? session.completedAt),
  };
}

export function adaptiveExecutionEventExportDto(event) {
  return {
    id: event.id,
    session_id: event.session_id,
    event_type: event.event_type,
    block_id: event.block_id ?? null,
    block_kind: event.block_kind ?? null,
    module: event.module ?? null,
    skill_id: event.skill_id ?? null,
    activity_id: event.activity_id ?? null,
    source_type: event.source_type ?? null,
    source_ref: event.source_ref ?? null,
    evidence_quality: event.evidence_quality ?? null,
    planned_minutes: Number(event.planned_minutes || 0),
    actual_minutes: event.actual_minutes == null ? null : Number(event.actual_minutes),
    created_at: timestamp(event.created_at),
  };
}

export function adaptiveExecutionSummary(session, events, nextRecommendedAction) {
  const completed = events.filter((event) => event.event_type === 'block_completed');
  const learning = completed.filter((event) => event.block_kind === 'learning');
  const actual = learning.filter((event) => event.actual_minutes != null);
  const evidenceByQuality = {};
  for (const event of learning) {
    if (event.evidence_quality) {
      evidenceByQuality[event.evidence_quality] = (evidenceByQuality[event.evidence_quality] || 0) + 1;
    }
  }
  return {
    completedBlocks: completed.length,
    completedLearningBlocks: learning.length,
    plannedLearningMinutes: Number(session.learning_minutes ?? session.learningMinutes),
    actualLearningMinutes: actual.reduce((sum, event) => sum + Number(event.actual_minutes), 0),
    actualMinutesComplete: actual.length === learning.length,
    evidenceByQuality,
    nextRecommendedAction,
  };
}

export function adaptiveProfileDelta(before, after) {
  return {
    confidenceBefore: Number(before?.confidence || 0),
    confidenceAfter: Number(after?.confidence || 0),
    evidenceSourceCountBefore: Number(before?.evidenceSourceCount ?? before?.evidence_source_count ?? 0),
    evidenceSourceCountAfter: Number(after?.evidenceSourceCount ?? after?.evidence_source_count ?? 0),
    establishedSkillCountBefore: Number(before?.establishedSkillCount ?? before?.established_skill_count ?? 0),
    establishedSkillCountAfter: Number(after?.establishedSkillCount ?? after?.established_skill_count ?? 0),
  };
}

export function adaptivePlanDelta(before, after) {
  const beforeModules = new Map((before?.allocation?.modules || []).map((item) => [item.id, item.percentage]));
  return {
    reasonCode: 'learning_block_completed',
    planRevisionBefore: Number(before?.revision || 0),
    planRevisionAfter: Number(after?.revision || 0),
    modulePercentageChanges: (after?.allocation?.modules || []).map((item) => ({
      module: item.id,
      before: Number(beforeModules.get(item.id) || 0),
      after: Number(item.percentage || 0),
      delta: Number(item.percentage || 0) - Number(beforeModules.get(item.id) || 0),
    })).filter((item) => item.delta !== 0),
  };
}

export function adaptiveCompletedBlockDto(event) {
  return {
    blockId: event.block_id,
    kind: event.block_kind,
    module: event.module ?? null,
    skillId: event.skill_id ?? null,
    activityId: event.activity_id ?? null,
    plannedMinutes: Number(event.planned_minutes || 0),
    actualMinutes: event.actual_minutes == null ? null : Number(event.actual_minutes),
    attempt: event.source_type && event.source_ref
      ? { type: event.source_type, id: String(event.source_ref) }
      : null,
    evidenceQuality: event.evidence_quality ?? null,
  };
}

function timestamp(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
