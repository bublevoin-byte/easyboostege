import { GRAMMAR_PRACTICE_MODES, isGrammarErrorCode, parseGrammarConfusionPair } from './grammar-domain-contract.js';
import { loadAdaptiveSessionRuntime } from './adaptive-session-loader.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ACTIVITY_ID = /^[a-z0-9_]{1,80}$/u;
const CLIENT_REPORTED_MODULES = new Set(['grammar', 'reading', 'listening']);
const ACTIVITY_MODES = new Set([
  ...GRAMMAR_PRACTICE_MODES, 'spaced_review', 'exam_19_24',
  'reading_headings', 'reading_detail', 'reading_gaps', 'reading_exam',
  'listening_matching', 'listening_true_false', 'listening_interview', 'listening_exam',
]);
const ACTIVITY_SOURCES = new Set(['builtin', 'generated', 'mixed', 'catalog']);

function canonicalReadingMetadata(source) {
  const separate = ['task10', 'task11', 'task12_18'].includes(source.readingKind)
    && /^reading-pilot-v1\.(?:task10|task11|task12_18)\.[a-z0-9-]{1,100}$/u.test(String(source.readingSetId || ''))
    && /^builtin:reading:(?:task10|task11|task12_18):(?:b1|b2|b2-plus-c1):v1$/u.test(String(source.readingContentRef || ''))
    && ['B1', 'B2', 'B2+/C1'].includes(source.readingCefr);
  const combinedDetail = source.readingKind === 'full_detail' && source.readingCefr === 'mixed'
    && source.readingContentRef === 'builtin:reading:full:detail:v1'
    && /^reading-pilot-v1\.task11\.[a-z0-9-]+@[1-9][0-9]{0,3}\|reading-pilot-v1\.task12_18\.[a-z0-9-]+@[1-9][0-9]{0,3}$/u.test(String(source.readingSetRefs || ''));
  if (source.readingProvenance !== 'canonical' || (!separate && !combinedDetail)
    || !Number.isInteger(source.readingSetRevision) || source.readingSetRevision < 1 || source.readingSetRevision > 10_000
    || !/^[A-Za-z0-9:._-]{8,180}$/u.test(String(source.readingAttemptId || ''))
    || !['gist', 'detail'].includes(source.readingSlice)) return null;
  return {
    readingProvenance: 'canonical', ...(separate ? { readingSetId: source.readingSetId } : {}),
    ...(combinedDetail ? { readingSetRefs: source.readingSetRefs } : {}),
    readingSetRevision: source.readingSetRevision, readingKind: source.readingKind,
    readingCefr: source.readingCefr, readingContentRef: source.readingContentRef,
    readingAttemptId: source.readingAttemptId, readingSlice: source.readingSlice,
    ...(typeof source.readingIndependent === 'boolean'
      ? { readingIndependent: source.readingIndependent } : {}),
  };
}

function boundedMetadata(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const metadata = {};
  if (ACTIVITY_MODES.has(source.mode)) metadata.mode = source.mode;
  if (ACTIVITY_SOURCES.has(source.source)) metadata.source = source.source;
  if (typeof source.helpUsed === 'boolean') metadata.helpUsed = source.helpUsed;
  if (Number.isInteger(source.hintsUsed) && source.hintsUsed >= 0 && source.hintsUsed <= 100) {
    metadata.hintsUsed = source.hintsUsed;
  }
  if (isGrammarErrorCode(source.grammarErrorCode)) metadata.grammarErrorCode = source.grammarErrorCode;
  const grammarConfusionPair = parseGrammarConfusionPair(source.grammarConfusionPair);
  if (grammarConfusionPair) metadata.grammarConfusionPair = grammarConfusionPair;
  if (Number.isInteger(source.grammarTopicId) && source.grammarTopicId >= 1 && source.grammarTopicId <= 20) {
    metadata.grammarTopicId = source.grammarTopicId;
  }
  const reading = canonicalReadingMetadata(source);
  if (reading) Object.assign(metadata, reading);
  return metadata;
}

function ordinaryAttempt(completion) {
  if (!completion || typeof completion !== 'object'
    || !UUID.test(String(completion.id || ''))
    || !CLIENT_REPORTED_MODULES.has(completion.module)
    || !ACTIVITY_ID.test(String(completion.activityId || ''))) {
    throw new TypeError('LEARNING_ACTIVITY_INVALID');
  }
  const maximum = Math.min(1000, Math.max(1, Math.round(Number(completion.maxScore) || 1)));
  const score = Math.min(maximum, Math.max(0, Math.round(Number(completion.score) || 0)));
  const duration = Number(completion.durationMs);
  return {
    id: String(completion.id),
    module: completion.module,
    activity: String(completion.activityId),
    score,
    maxScore: maximum,
    durationMs: Number.isFinite(duration) ? Math.min(14_400_000, Math.max(0, Math.round(duration))) : 0,
    metadata: boundedMetadata(completion.metadata),
  };
}

function recorderOwnerBinding() {
  const binding = window.EasyBoostSync?.currentOwnerBinding?.();
  return binding && typeof binding.username === 'string' && binding.username
    && Number.isSafeInteger(binding.generation) && binding.generation >= 0
    ? { username: binding.username, generation: binding.generation }
    : null;
}

function sameOwnerBinding(left, right) {
  return Boolean(left && right && left.username === right.username && left.generation === right.generation);
}

function ownerGuard(binding) {
  return { owner: binding.username, ownerGeneration: binding.generation };
}

export function createLearningActivityEvidence({ id = crypto.randomUUID(), module, activityId, mode, source, startedAt = Date.now(), metadata = {} } = {}) {
  return {
    id,
    module,
    activityId,
    mode,
    source,
    startedAt,
    reported: false,
    helpUsed: false,
    hintsUsed: 0,
    metadata,
    ownerBinding: recorderOwnerBinding(),
  };
}

export function prepareLearningActivityRecording() {
  return loadAdaptiveSessionRuntime();
}

export async function recordCompletedLearningActivity(completion = {}, options = {}) {
  const attempt = ordinaryAttempt(completion);
  const authority = options.ownerBinding === undefined ? recorderOwnerBinding() : options.ownerBinding;
  if (!authority) return { path: 'blocked', reason: 'owner_unavailable', recorded: false };
  const { adaptiveRuntimeSnapshot, completeAdaptiveModuleActivity } = await loadAdaptiveSessionRuntime();
  if (!sameOwnerBinding(authority, recorderOwnerBinding())) {
    return { path: 'blocked', reason: 'owner_changed', recorded: false };
  }
  const active = adaptiveRuntimeSnapshot().active;
  if (active) {
    if (active.module !== attempt.module || active.activityId !== attempt.activity) {
      return { path: 'blocked', reason: 'adaptive_activity_mismatch', recorded: false };
    }
    if (attempt.module === 'reading' && active.contentRef !== attempt.metadata.readingContentRef) {
      return { path: 'blocked', reason: 'adaptive_content_mismatch', recorded: false };
    }
    const result = await completeAdaptiveModuleActivity({
      module: attempt.module,
      activityId: attempt.activity,
      score: attempt.score,
      maxScore: attempt.maxScore,
      durationMs: attempt.durationMs,
      ...(attempt.metadata.helpUsed === true || attempt.module === 'reading'
        ? { metadata: attempt.metadata } : {}),
    });
    return { path: 'adaptive', result };
  }
  if (!window.EasyBoostSync || typeof window.EasyBoostSync.saveModuleAttempt !== 'function') {
    throw new Error('LEARNING_ACTIVITY_SYNC_UNAVAILABLE');
  }
  return {
    path: 'ordinary',
    saved: await window.EasyBoostSync.saveModuleAttempt(attempt, ownerGuard(authority)),
    attempt,
  };
}

export async function recordLearningActivityEvidence(evidence, { score, maxScore, durationMs } = {}) {
  if (!evidence || evidence.reported) return false;
  evidence.reported = true;
  try {
    return await recordCompletedLearningActivity({
      id: evidence.id,
      module: evidence.module,
      activityId: evidence.activityId,
      score,
      maxScore,
      durationMs: durationMs == null ? Math.max(0, Date.now() - evidence.startedAt) : durationMs,
      metadata: {
        mode: evidence.mode,
        source: evidence.source,
        helpUsed: evidence.helpUsed,
        hintsUsed: evidence.hintsUsed,
        ...(evidence.metadata || {}),
      },
    }, { ownerBinding: evidence.ownerBinding });
  } catch (error) {
    evidence.reported = false;
    throw error;
  }
}
