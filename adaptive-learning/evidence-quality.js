export const MODULE_ATTEMPT_EVIDENCE_QUALITIES = Object.freeze([
  'client_reported',
  'server_verified_assisted',
  'server_verified_unassisted',
]);

const MODULE_ATTEMPT_EVIDENCE_QUALITY_SET = new Set(MODULE_ATTEMPT_EVIDENCE_QUALITIES);

export function normalizeModuleAttemptEvidenceQuality(value) {
  return MODULE_ATTEMPT_EVIDENCE_QUALITY_SET.has(value) ? value : 'client_reported';
}

export function requireModuleAttemptEvidenceQuality(value) {
  if (!MODULE_ATTEMPT_EVIDENCE_QUALITY_SET.has(value)) {
    throw new Error('INVALID_MODULE_ATTEMPT_EVIDENCE_QUALITY');
  }
  return value;
}
