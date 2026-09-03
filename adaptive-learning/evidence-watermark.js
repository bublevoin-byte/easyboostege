import crypto from 'node:crypto';

export const ADAPTIVE_EVIDENCE_WATERMARK_VERSION = 'adaptive-evidence-watermark-v1';
export const ADAPTIVE_PROFILE_CALCULATION_REVISION = 4;

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

export function canonicalAdaptiveEvidenceTimestamp(value) {
  if (value == null) return null;
  let normalized = value;
  if (typeof normalized === 'number' && Number.isFinite(normalized)) {
    normalized = Math.abs(normalized) < 100_000_000_000 ? normalized * 1_000 : normalized;
  } else if (typeof normalized === 'string' && /^-?\d+(?:\.\d+)?$/u.test(normalized.trim())) {
    const numeric = Number(normalized);
    normalized = Math.abs(numeric) < 100_000_000_000 ? numeric * 1_000 : numeric;
  }
  const date = normalized instanceof Date ? normalized : new Date(normalized);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

const TIMESTAMP_FIELDS = new Map([
  ['answeredAt', 'answered_at'], ['answered_at', 'answered_at'],
  ['assistanceUpdatedAt', 'assistance_updated_at'], ['assistance_updated_at', 'assistance_updated_at'],
  ['completedAt', 'completed_at'], ['completed_at', 'completed_at'],
  ['createdAt', 'created_at'], ['created_at', 'created_at'],
  ['evaluatedAt', 'evaluated_at'], ['evaluated_at', 'evaluated_at'],
  ['observedAt', 'observed_at'], ['observed_at', 'observed_at'],
  ['updatedAt', 'updated_at'], ['updated_at', 'updated_at'],
]);

function canonicalEvidenceValue(value, field = null) {
  if (field && TIMESTAMP_FIELDS.has(field)) return canonicalAdaptiveEvidenceTimestamp(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((entry) => canonicalEvidenceValue(entry));
  if (value && typeof value === 'object') {
    const entries = Object.keys(value).sort().map((key) => [
      TIMESTAMP_FIELDS.get(key) || key,
      canonicalEvidenceValue(value[key], key),
    ]);
    return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
  }
  return value;
}

function evidenceFingerprint(events) {
  const canonicalEvents = events
    .map(({ event }) => JSON.stringify(canonicalEvidenceValue(event)))
    .sort();
  return crypto.createHash('sha256').update(JSON.stringify(canonicalEvents)).digest('hex');
}

export function buildAdaptiveEvidenceWatermark(sources = {}) {
  const events = sourceEvents(sources);
  const observed = events.map(({ timestamp: value }) => canonicalAdaptiveEvidenceTimestamp(value))
    .filter(Boolean).sort();
  return Object.freeze({
    version: ADAPTIVE_EVIDENCE_WATERMARK_VERSION,
    observedAt: observed.at(-1) || null,
    sourceCount: events.length,
    fingerprint: evidenceFingerprint(events),
  });
}

export function adaptiveEvidenceSourcesFingerprint(sources = {}) {
  return evidenceFingerprint(sourceEvents(sources));
}

export function adaptiveProfileMatchesEvidenceSources(profile, sources = {}) {
  const watermark = buildAdaptiveEvidenceWatermark(sources);
  const vector = normalizeWatermark(profile);
  return vector.calculationRevision === ADAPTIVE_PROFILE_CALCULATION_REVISION
    && vector.version === watermark.version
    && vector.observedAt === watermark.observedAt
    && vector.sourceCount === watermark.sourceCount
    && vector.fingerprint === watermark.fingerprint;
}

function normalizeWatermark(value = {}) {
  const fingerprint = value.evidenceFingerprint ?? value.evidence_fingerprint
    ?? value.profileEvidenceFingerprint ?? value.profile_evidence_fingerprint ?? null;
  return {
    calculationRevision: Number(value.profileCalculationRevision ?? value.profile_calculation_revision ?? 0),
    version: value.evidenceWatermarkVersion ?? value.evidence_watermark_version
      ?? value.profileEvidenceWatermarkVersion ?? value.profile_evidence_watermark_version ?? null,
    observedAt: canonicalAdaptiveEvidenceTimestamp(value.evidenceObservedAt ?? value.evidence_observed_at
      ?? value.profileEvidenceObservedAt ?? value.profile_evidence_observed_at),
    sourceCount: Number(value.evidenceSourceCount ?? value.evidence_source_count
      ?? value.profileEvidenceSourceCount ?? value.profile_evidence_source_count ?? 0),
    fingerprint: typeof fingerprint === 'string' && /^[0-9a-f]{64}$/u.test(fingerprint)
      ? fingerprint : null,
  };
}

export function adaptiveEvidenceFingerprintConflict(candidate, persisted) {
  const next = normalizeWatermark(candidate);
  const current = normalizeWatermark(persisted);
  return next.calculationRevision === current.calculationRevision
    && next.version === current.version
    && next.observedAt === current.observedAt
    && next.sourceCount === current.sourceCount
    && next.fingerprint !== null
    && current.fingerprint !== null
    && next.fingerprint !== current.fingerprint;
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
  if (next.fingerprint !== current.fingerprint) {
    if (!next.fingerprint) return -1;
    return 1;
  }
  return 0;
}
