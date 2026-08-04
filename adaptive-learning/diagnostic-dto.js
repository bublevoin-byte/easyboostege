import { getDiagnosticPolicy, publicDiagnosticItem } from './diagnostic-catalog.js';
import { adaptiveLearningProfileSnapshotDto } from './repository-dto.js';

function timestamp(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function adaptiveDiagnosticRepositoryDto(session, responses = []) {
  if (!session) return null;
  return {
    id: session.id,
    catalog_version: session.catalog_version,
    status: session.status,
    current_item_id: session.current_item_id ?? null,
    answered_items: Number(session.answered_items || responses.length || 0),
    correct_items: Number(session.correct_items || responses.filter((response) => response.correct).length || 0),
    stop_reason: session.stop_reason ?? null,
    started_at: timestamp(session.started_at),
    expires_at: timestamp(session.expires_at),
    completed_at: timestamp(session.completed_at),
    updated_at: timestamp(session.updated_at),
    responses: responses.map((response) => ({
      id: response.id,
      item_id: response.item_id,
      skill_id: response.skill_id,
      module: response.module,
      evidence_quality: response.evidence_quality,
      choice_id: response.choice_id,
      correct: Boolean(response.correct),
      response_ms: response.response_ms == null ? null : Number(response.response_ms),
      answered_at: timestamp(response.answered_at),
    })),
  };
}

export function adaptiveDiagnosticStartClaimRepositoryDto(claim) {
  if (!claim) return null;
  return adaptiveDiagnosticRepositoryDto({
    id: claim.diagnostic_id,
    catalog_version: claim.catalog_version,
    status: claim.status,
    current_item_id: claim.current_item_id,
    answered_items: claim.answered_items,
    correct_items: claim.correct_items,
    stop_reason: claim.stop_reason,
    started_at: claim.started_at,
    expires_at: claim.expires_at,
    completed_at: claim.completed_at,
    updated_at: claim.updated_at,
  });
}

export function adaptiveDiagnosticAnswerClaimRepositoryDto(response) {
  if (!response) return null;
  return adaptiveDiagnosticRepositoryDto({
    id: response.diagnostic_id,
    catalog_version: response.replay_catalog_version,
    status: response.replay_status,
    current_item_id: response.replay_current_item_id,
    answered_items: response.replay_answered_items,
    correct_items: response.replay_correct_items,
    stop_reason: response.replay_stop_reason,
    started_at: response.replay_started_at,
    expires_at: response.replay_expires_at,
    completed_at: response.replay_completed_at,
    updated_at: response.replay_updated_at,
  });
}

export function adaptiveDiagnosticCompletionSnapshotDto(snapshot) {
  if (!snapshot?.diagnostic || !snapshot?.result || !snapshot?.profile) return null;
  const diagnostic = snapshot.diagnostic;
  const result = snapshot.result;
  return {
    completed: true,
    diagnostic: {
      id: diagnostic.id,
      catalogVersion: diagnostic.catalogVersion,
      ...(diagnostic.depth === 'deep' ? { depth: 'deep' } : {}),
      status: diagnostic.status,
      estimatedMinutes: Number(diagnostic.estimatedMinutes),
      deadlineMinutes: Number(diagnostic.deadlineMinutes),
      answeredItems: Number(diagnostic.answeredItems),
      maxItems: Number(diagnostic.maxItems),
      progressPercent: Number(diagnostic.progressPercent),
      canComplete: Boolean(diagnostic.canComplete),
      stopReason: diagnostic.stopReason ?? null,
      startedAt: timestamp(diagnostic.startedAt),
      expiresAt: timestamp(diagnostic.expiresAt),
      completedAt: timestamp(diagnostic.completedAt),
    },
    item: null,
    result: {
      preliminary: Boolean(result.preliminary),
      confidence: Number(result.confidence),
      answeredItems: Number(result.answeredItems),
      correctItems: Number(result.correctItems),
      explanationCodes: Array.isArray(result.explanationCodes)
        ? structuredClone(result.explanationCodes)
        : [],
    },
    profile: adaptiveLearningProfileSnapshotDto(snapshot.profile),
  };
}

export function adaptiveDiagnosticPublicDto(session, item, suppliedPolicy = null) {
  if (!session) return { diagnostic: null, item: null };
  const policy = suppliedPolicy || getDiagnosticPolicy(session.catalog_version);
  if (!policy) throw new Error('DIAGNOSTIC_CATALOG_UNSUPPORTED');
  const answeredItems = Number(session.answered_items || session.responses?.length || 0);
  return {
    diagnostic: {
      id: session.id,
      catalogVersion: session.catalog_version,
      ...(policy.depth === 'deep' ? { depth: 'deep' } : {}),
      status: session.status,
      estimatedMinutes: policy.estimatedMinutes,
      deadlineMinutes: Math.ceil(policy.maximumSeconds / 60),
      answeredItems,
      maxItems: policy.maximumItems,
      progressPercent: Math.min(100, Math.round(answeredItems / policy.targetItems * 100)),
      canComplete: session.status === 'ready' || session.status === 'completed',
      stopReason: session.stop_reason ?? null,
      startedAt: session.started_at,
      expiresAt: session.expires_at,
      completedAt: session.completed_at,
    },
    item: publicDiagnosticItem(item),
  };
}

export function adaptiveDiagnosticExportDto(session) {
  const normalized = adaptiveDiagnosticRepositoryDto(session, []);
  if (!normalized) return null;
  const { responses, current_item_id: currentItemId, ...safe } = normalized;
  return { ...safe, current_item_id: currentItemId };
}

export function adaptiveDiagnosticResponseExportDto(response) {
  return adaptiveDiagnosticRepositoryDto({
    id: 'export', catalog_version: 'export', status: 'completed',
  }, [response]).responses[0];
}
