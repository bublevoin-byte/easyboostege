export const ADAPTIVE_EVIDENCE_WATERMARK_VERSION = 'adaptive-evidence-watermark-v1';
export const ADAPTIVE_PROFILE_CALCULATION_REVISION = 1;

function sourceEvents(sources = {}) {
  return [
    ...(Array.isArray(sources.attempts) ? sources.attempts.map((event) => ({
      event, timestamp: event.created_at ?? event.createdAt,
    })) : []),
    ...(Array.isArray(sources.recoveries) ? sources.recoveries.map((event) => ({
      event, timestamp: event.observed_at ?? event.observedAt,
    })) : []),
    ...(Array.isArray(sources.repeatAttempts) ? sources.repeatAttempts.map((event) => ({
      event, timestamp: event.observed_at ?? event.observedAt,
    })) : []),
    ...(Array.isArray(sources.diagnosticResponses) ? sources.diagnosticResponses.map((event) => ({
      event, timestamp: event.answered_at ?? event.answeredAt,
    })) : []),
    ...(Array.isArray(sources.diagnosticCompletions) ? sources.diagnosticCompletions.map((event) => ({
      event, timestamp: event.completed_at ?? event.completedAt,
    })) : []),
  ];
}

function timestamp(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function buildAdaptiveEvidenceWatermark(sources = {}) {
  const events = sourceEvents(sources);
  const observed = events.map(({ timestamp: value }) => timestamp(value)).filter(Boolean).sort();
  return Object.freeze({
    version: ADAPTIVE_EVIDENCE_WATERMARK_VERSION,
    observedAt: observed.at(-1) || null,
    sourceCount: events.length,
  });
}

function normalizeWatermark(value = {}) {
  return {
    calculationRevision: Number(value.profileCalculationRevision ?? value.profile_calculation_revision ?? 0),
    version: value.evidenceWatermarkVersion ?? value.evidence_watermark_version ?? null,
    observedAt: timestamp(value.evidenceObservedAt ?? value.evidence_observed_at),
    sourceCount: Number(value.evidenceSourceCount ?? value.evidence_source_count ?? 0),
  };
}

export function compareAdaptiveEvidenceWatermarks(candidate, persisted) {
  const next = normalizeWatermark(candidate);
  const current = normalizeWatermark(persisted);
  if (next.calculationRevision < current.calculationRevision) return -1;
  if (next.calculationRevision > current.calculationRevision) return 1;
  if (next.sourceCount !== current.sourceCount) return next.sourceCount > current.sourceCount ? 1 : -1;
  const nextTime = next.observedAt ? new Date(next.observedAt).getTime() : Number.NEGATIVE_INFINITY;
  const currentTime = current.observedAt ? new Date(current.observedAt).getTime() : Number.NEGATIVE_INFINITY;
  if (nextTime !== currentTime) return nextTime > currentTime ? 1 : -1;
  if (!current.version) return 1;
  if (next.version !== current.version) {
    return next.version === ADAPTIVE_EVIDENCE_WATERMARK_VERSION ? 1 : -1;
  }
  return 0;
}
