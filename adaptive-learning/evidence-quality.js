import { READING_TASK10_SETS } from '../public/content/reading/task10-v1.js';
import { READING_TASK11_SETS } from '../public/content/reading/task11-v1.js';
import { READING_TASK12_18_SETS } from '../public/content/reading/task12-18-v1.js';

export const MODULE_ATTEMPT_EVIDENCE_QUALITIES = Object.freeze([
  'client_reported',
  'server_verified_assisted',
  'server_verified_unassisted',
]);

const READING_SET_BY_ID = new Map([
  ...READING_TASK10_SETS, ...READING_TASK11_SETS, ...READING_TASK12_18_SETS,
].map((set) => [set.id, set]));

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

export function adaptiveReadingMetadata(value, block) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const match = /^builtin:reading:(task10|task11|task12_18):(b1|b2|b2-plus-c1):v1$/u
    .exec(String(source.readingContentRef || ''));
  const cefr = { b1: 'B1', b2: 'B2', 'b2-plus-c1': 'B2+/C1' }[match?.[2]];
  const activity = { task10: 'reading_headings', task11: 'reading_gaps', task12_18: 'reading_detail' }[source.readingKind];
  const mode = { task10: 'reading_headings', task11: 'reading_gaps', task12_18: 'reading_detail' }[source.readingKind];
  const slice = source.readingKind === 'task10' ? 'gist' : 'detail';
  const set = READING_SET_BY_ID.get(String(source.readingSetId || ''));
  if (block?.module !== 'reading' || block.activityId !== activity || block.contentRef !== source.readingContentRef
    || source.mode !== mode || source.source !== 'catalog' || source.readingProvenance !== 'canonical'
    || match?.[1] !== source.readingKind || cefr !== source.readingCefr
    || !set || set.kind !== source.readingKind || set.cefr !== source.readingCefr
    || set.revision !== source.readingSetRevision
    || !/^reading-pilot-v1\.(?:task10|task11|task12_18)\.[a-z0-9-]{1,100}$/u.test(String(source.readingSetId || ''))
    || !String(source.readingSetId).startsWith(`reading-pilot-v1.${source.readingKind}.`)
    || !Number.isInteger(source.readingSetRevision) || source.readingSetRevision < 1 || source.readingSetRevision > 10_000
    || !/^[A-Za-z0-9:._-]{8,180}$/u.test(String(source.readingAttemptId || ''))
    || source.readingSlice !== slice || typeof source.helpUsed !== 'boolean'
    || !Number.isInteger(source.hintsUsed) || source.hintsUsed < 0 || source.hintsUsed > 100) {
    throw new Error('ADAPTIVE_EXECUTION_ATTEMPT_MISMATCH');
  }
  return {
    mode, source: 'catalog', helpUsed: source.helpUsed, hintsUsed: source.hintsUsed,
    readingProvenance: 'canonical', readingSetId: source.readingSetId,
    readingSetRevision: source.readingSetRevision, readingKind: source.readingKind,
    readingCefr: source.readingCefr, readingContentRef: source.readingContentRef,
    readingAttemptId: source.readingAttemptId, readingSlice: slice,
    ...(typeof source.readingIndependent === 'boolean'
      ? { readingIndependent: source.readingIndependent } : {}),
  };
}
