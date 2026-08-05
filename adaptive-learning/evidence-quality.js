export const MODULE_ATTEMPT_EVIDENCE_QUALITIES = Object.freeze([
  'client_reported',
  'server_verified_assisted',
  'server_verified_unassisted',
]);

const MODULE_ATTEMPT_EVIDENCE_QUALITY_SET = new Set(MODULE_ATTEMPT_EVIDENCE_QUALITIES);
const ASSISTED_MODES = new Set([
  'topic_practice', 'spaced_review', 'exam_19_24',
  'reading_headings', 'reading_detail', 'reading_gaps', 'reading_exam',
  'listening_matching', 'listening_true_false', 'listening_interview', 'listening_exam',
]);
const ASSISTED_SOURCES = new Set(['builtin', 'generated', 'mixed']);

export function normalizeModuleAttemptEvidenceQuality(value) {
  return MODULE_ATTEMPT_EVIDENCE_QUALITY_SET.has(value) ? value : 'client_reported';
}

export function requireModuleAttemptEvidenceQuality(value) {
  if (!MODULE_ATTEMPT_EVIDENCE_QUALITY_SET.has(value)) {
    throw new Error('INVALID_MODULE_ATTEMPT_EVIDENCE_QUALITY');
  }
  return value;
}

export function adaptiveAssistedMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.helpUsed !== true) return {};
  const result = { helpUsed: true };
  if (ASSISTED_MODES.has(value.mode)) result.mode = value.mode;
  if (ASSISTED_SOURCES.has(value.source)) result.source = value.source;
  if (Number.isInteger(value.hintsUsed) && value.hintsUsed >= 0 && value.hintsUsed <= 100) {
    result.hintsUsed = value.hintsUsed;
  }
  return result;
}
