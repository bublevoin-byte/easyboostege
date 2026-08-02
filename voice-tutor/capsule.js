import { getCanonicalVoiceTutorItem } from './canonical-items.js';
import { normalizeTutorAnswer } from './state-machine.js';

export const VOICE_CAPSULE_VERSION = 'grammar-lexicon-v1';

export class VoiceTutorCapsuleError extends Error {
  constructor(code) {
    super(code);
    this.name = 'VoiceTutorCapsuleError';
    this.code = code;
  }
}

function boundedString(value, maximum, code) {
  const text = String(value ?? '').trim();
  if (!text || text.length > maximum) throw new VoiceTutorCapsuleError(code);
  return text;
}

function itemForError({ module, itemId, revision, getItem }) {
  if (!['grammar', 'vocabulary'].includes(module)) throw new VoiceTutorCapsuleError('VOICE_TUTOR_ATTEMPT_NOT_SUPPORTED');
  const canonicalId = boundedString(itemId, 120, 'VOICE_TUTOR_ITEM_NOT_FOUND');
  const item = getItem(canonicalId);
  if (!item || item.module !== module) throw new VoiceTutorCapsuleError('VOICE_TUTOR_ITEM_NOT_FOUND');
  if (!Number.isInteger(revision) || revision !== item.revision) throw new VoiceTutorCapsuleError('VOICE_TUTOR_REVISION_MISMATCH');
  return item;
}

export function createGrammarLexiconErrorAttempt({ id, module, itemId, revision, learnerAnswer }, getItem = getCanonicalVoiceTutorItem) {
  const item = itemForError({ module, itemId, revision, getItem });
  const answer = boundedString(learnerAnswer, 200, 'VOICE_TUTOR_LEARNER_ANSWER_INVALID');
  const normalizedAnswer = normalizeTutorAnswer(answer);
  if (!normalizedAnswer) throw new VoiceTutorCapsuleError('VOICE_TUTOR_LEARNER_ANSWER_INVALID');
  if (item.reference.some((value) => normalizeTutorAnswer(value) === normalizedAnswer)) {
    throw new VoiceTutorCapsuleError('VOICE_TUTOR_ANSWER_NOT_INCORRECT');
  }
  return {
    id: boundedString(id, 64, 'VOICE_TUTOR_ATTEMPT_NOT_FOUND'),
    module: item.module,
    activity: 'voice_tutor_error',
    score: 0,
    maxScore: 1,
    durationMs: null,
    metadata: { item_id: item.id, item_revision: item.revision, learner_answer: normalizedAnswer },
  };
}

export function buildGrammarLexiconCapsule({ attempt, expectedRevision, getItem = getCanonicalVoiceTutorItem }) {
  if (!attempt || !['grammar', 'vocabulary'].includes(attempt.module) || attempt.activity !== 'voice_tutor_error'
    || Number(attempt.score) !== 0 || Number(attempt.max_score ?? attempt.maxScore) !== 1) {
    throw new VoiceTutorCapsuleError('VOICE_TUTOR_ATTEMPT_NOT_SUPPORTED');
  }
  const metadata = attempt.metadata && typeof attempt.metadata === 'object' ? attempt.metadata : {};
  const revision = Number(expectedRevision);
  const item = itemForError({ module: attempt.module, itemId: metadata.item_id, revision, getItem });
  if (Number(metadata.item_revision) !== item.revision) {
    throw new VoiceTutorCapsuleError('VOICE_TUTOR_REVISION_MISMATCH');
  }
  const learnerAnswer = boundedString(metadata.learner_answer, 200, 'VOICE_TUTOR_LEARNER_ANSWER_INVALID');
  if (item.reference.some((value) => normalizeTutorAnswer(value) === normalizeTutorAnswer(learnerAnswer))) {
    throw new VoiceTutorCapsuleError('VOICE_TUTOR_ANSWER_NOT_INCORRECT');
  }

  const capsule = {
    id: `voice-capsule:${boundedString(attempt.id, 64, 'VOICE_TUTOR_ATTEMPT_NOT_FOUND')}`,
    version: VOICE_CAPSULE_VERSION,
    source: { attempt_id: attempt.id, item_revision: item.revision },
    module: item.module,
    item: { id: item.id, prompt: item.prompt, reference: [...item.reference] },
    learner_answer: learnerAnswer,
    error: { type: item.errorType },
    skill: { ...item.skill },
    rule: { ...item.rule, examples: [...item.rule.examples] },
    checks: {
      micro_check: { ...item.microCheck, answers: [...item.microCheck.answers] },
      transfer_task: { ...item.transferTask, answers: [...item.transferTask.answers] },
    },
  };
  if (JSON.stringify(capsule).length > 12_000) throw new VoiceTutorCapsuleError('VOICE_TUTOR_CAPSULE_TOO_LARGE');
  return capsule;
}

export function publicVoiceTutorCapsule(capsule) {
  return {
    id: capsule.id,
    version: capsule.version,
    source: { ...capsule.source },
    module: capsule.module,
    item: { id: capsule.item.id, prompt: capsule.item.prompt },
    error: { ...capsule.error },
    skill: { ...capsule.skill },
    rule: { ...capsule.rule, examples: [...capsule.rule.examples] },
    checks: {
      micro_check: { id: capsule.checks.micro_check.id, prompt: capsule.checks.micro_check.prompt },
      transfer_task: { id: capsule.checks.transfer_task.id, prompt: capsule.checks.transfer_task.prompt },
    },
  };
}

export function persistedVoiceTutorCapsule(capsule) {
  const stored = structuredClone(capsule);
  delete stored.learner_answer;
  return stored;
}
