import crypto from 'node:crypto';
import { getCanonicalVoiceTutorItem, getCanonicalVoiceTutorResultSet } from './canonical-items.js';
import {
  GRAMMAR_LEXICON_CAPSULE_VERSION,
  isContextVoiceTutorModule,
  isDirectVoiceTutorModule,
  READING_LISTENING_CAPSULE_VERSION,
  voiceTutorModule,
} from './modules.js';
import { normalizeTutorAnswer } from './state-machine.js';

export const VOICE_CAPSULE_VERSION = GRAMMAR_LEXICON_CAPSULE_VERSION;
export { GRAMMAR_LEXICON_CAPSULE_VERSION, READING_LISTENING_CAPSULE_VERSION };

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
  if (!voiceTutorModule(module)) throw new VoiceTutorCapsuleError('VOICE_TUTOR_ATTEMPT_NOT_SUPPORTED');
  const canonicalId = boundedString(itemId, 120, 'VOICE_TUTOR_ITEM_NOT_FOUND');
  const item = getItem(canonicalId);
  if (!item || item.module !== module) throw new VoiceTutorCapsuleError('VOICE_TUTOR_ITEM_NOT_FOUND');
  if (!Number.isInteger(revision) || revision !== item.revision) throw new VoiceTutorCapsuleError('VOICE_TUTOR_REVISION_MISMATCH');
  return item;
}

function boundedItemContext(item) {
  const descriptor = voiceTutorModule(item.module);
  if (!descriptor?.contextKind) return null;
  const context = item.context;
  const expectedKind = descriptor.contextKind;
  if (!context || typeof context !== 'object' || Array.isArray(context)
    || Object.keys(context).length !== 3 || context.kind !== expectedKind) {
    throw new VoiceTutorCapsuleError('VOICE_TUTOR_CONTEXT_INVALID');
  }
  return {
    kind: expectedKind,
    label: boundedString(context.label, 60, 'VOICE_TUTOR_CONTEXT_INVALID'),
    text: boundedString(context.text, 600, 'VOICE_TUTOR_CONTEXT_INVALID'),
  };
}

export function createVoiceTutorErrorAttempt({ id, resultAttemptId, module, itemId, revision, learnerAnswer }, getItem = getCanonicalVoiceTutorItem) {
  const item = itemForError({ module, itemId, revision, getItem });
  const answer = boundedString(learnerAnswer, 200, 'VOICE_TUTOR_LEARNER_ANSWER_INVALID');
  const normalizedAnswer = normalizeTutorAnswer(answer);
  if (!normalizedAnswer) throw new VoiceTutorCapsuleError('VOICE_TUTOR_LEARNER_ANSWER_INVALID');
  if (item.reference.some((value) => normalizeTutorAnswer(value) === normalizedAnswer)) {
    throw new VoiceTutorCapsuleError('VOICE_TUTOR_ANSWER_NOT_INCORRECT');
  }
  const metadata = { item_id: item.id, item_revision: item.revision, learner_answer: normalizedAnswer };
  if (isContextVoiceTutorModule(item.module)) {
    metadata.result_attempt_id = boundedString(resultAttemptId, 64, 'VOICE_TUTOR_ATTEMPT_NOT_SUPPORTED');
    metadata.validation_source = 'voice_tutor_context_result';
  }
  return {
    id: boundedString(id, 64, 'VOICE_TUTOR_ATTEMPT_NOT_FOUND'),
    module: item.module,
    activity: 'voice_tutor_error',
    score: 0,
    maxScore: 1,
    durationMs: null,
    metadata,
  };
}

export function createGrammarLexiconErrorAttempt(input, getItem = getCanonicalVoiceTutorItem) {
  if (!isDirectVoiceTutorModule(input?.module)) throw new VoiceTutorCapsuleError('VOICE_TUTOR_ATTEMPT_NOT_SUPPORTED');
  return createVoiceTutorErrorAttempt(input, getItem);
}

function deterministicContextErrorId(resultAttemptId, itemId) {
  const hex = crypto.createHash('sha256').update(`${resultAttemptId}:${itemId}`).digest('hex').slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16], 16) % 4];
  const compact = hex.join('');
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

export function createVoiceTutorContextResult({ id, module, setId, revision, answers }, {
  getItem = getCanonicalVoiceTutorItem,
  getResultSet = getCanonicalVoiceTutorResultSet,
} = {}) {
  if (!isContextVoiceTutorModule(module)) throw new VoiceTutorCapsuleError('VOICE_TUTOR_ATTEMPT_NOT_SUPPORTED');
  const resultAttemptId = boundedString(id, 64, 'VOICE_TUTOR_ATTEMPT_NOT_FOUND');
  const resultSet = getResultSet(boundedString(setId, 120, 'VOICE_TUTOR_ITEM_NOT_FOUND'));
  if (!resultSet || resultSet.module !== module) throw new VoiceTutorCapsuleError('VOICE_TUTOR_ITEM_NOT_FOUND');
  if (!Number.isInteger(revision) || revision !== resultSet.revision) throw new VoiceTutorCapsuleError('VOICE_TUTOR_REVISION_MISMATCH');
  if (!Array.isArray(answers) || answers.length !== resultSet.items.length) {
    throw new VoiceTutorCapsuleError('VOICE_TUTOR_CONTEXT_RESULT_INVALID');
  }
  let score = 0;
  const errors = [];
  const normalizedAnswers = [];
  for (let index = 0; index < resultSet.items.length; index += 1) {
    const item = getItem(resultSet.items[index]);
    if (!item || item.module !== module || !Array.isArray(item.options)) throw new VoiceTutorCapsuleError('VOICE_TUTOR_ITEM_NOT_FOUND');
    const answer = boundedString(answers[index], 200, 'VOICE_TUTOR_CONTEXT_RESULT_INVALID');
    const normalized = normalizeTutorAnswer(answer);
    normalizedAnswers.push(normalized);
    if (!item.options.some((option) => normalizeTutorAnswer(option) === normalized)) {
      throw new VoiceTutorCapsuleError('VOICE_TUTOR_CONTEXT_RESULT_INVALID');
    }
    if (item.reference.some((reference) => normalizeTutorAnswer(reference) === normalized)) {
      score += 1;
    } else {
      const errorAttempt = createVoiceTutorErrorAttempt({
        id: deterministicContextErrorId(resultAttemptId, item.id),
        resultAttemptId,
        module,
        itemId: item.id,
        revision: item.revision,
        learnerAnswer: answer,
      }, getItem);
      errorAttempt.metadata.context_set_id = resultSet.id;
      errors.push(errorAttempt);
    }
  }
  return {
    attempt: {
      id: resultAttemptId,
      module,
      activity: 'voice_tutor_context_result',
      score,
      maxScore: resultSet.items.length,
      durationMs: null,
      metadata: {
        set_id: resultSet.id,
        set_revision: resultSet.revision,
        completed: true,
        answers_hash: crypto.createHash('sha256').update(JSON.stringify(normalizedAnswers)).digest('hex'),
      },
    },
    errors,
  };
}

export function buildVoiceTutorCapsule({ attempt, expectedRevision, getItem = getCanonicalVoiceTutorItem }) {
  const descriptor = voiceTutorModule(attempt?.module);
  if (!attempt || !descriptor || attempt.activity !== 'voice_tutor_error'
    || Number(attempt.score) !== 0 || Number(attempt.max_score ?? attempt.maxScore) !== 1) {
    throw new VoiceTutorCapsuleError('VOICE_TUTOR_ATTEMPT_NOT_SUPPORTED');
  }
  const metadata = attempt.metadata && typeof attempt.metadata === 'object' ? attempt.metadata : {};
  if (isContextVoiceTutorModule(attempt.module)
    && (metadata.validation_source !== 'voice_tutor_context_result' || !metadata.result_attempt_id)) {
    throw new VoiceTutorCapsuleError('VOICE_TUTOR_ATTEMPT_NOT_SUPPORTED');
  }
  const revision = Number(expectedRevision);
  const item = itemForError({ module: attempt.module, itemId: metadata.item_id, revision, getItem });
  if (Number(metadata.item_revision) !== item.revision) {
    throw new VoiceTutorCapsuleError('VOICE_TUTOR_REVISION_MISMATCH');
  }
  const learnerAnswer = boundedString(metadata.learner_answer, 200, 'VOICE_TUTOR_LEARNER_ANSWER_INVALID');
  if (item.reference.some((value) => normalizeTutorAnswer(value) === normalizeTutorAnswer(learnerAnswer))) {
    throw new VoiceTutorCapsuleError('VOICE_TUTOR_ANSWER_NOT_INCORRECT');
  }
  const context = boundedItemContext(item);

  const capsule = {
    id: `voice-capsule:${boundedString(attempt.id, 64, 'VOICE_TUTOR_ATTEMPT_NOT_FOUND')}`,
    version: descriptor.capsuleVersion,
    source: { attempt_id: attempt.id, item_revision: item.revision },
    module: item.module,
    item: {
      id: item.id,
      prompt: item.prompt,
      reference: [...item.reference],
      ...(context ? { context } : {}),
    },
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

export function buildGrammarLexiconCapsule(input) {
  if (!isDirectVoiceTutorModule(input?.attempt?.module)) throw new VoiceTutorCapsuleError('VOICE_TUTOR_ATTEMPT_NOT_SUPPORTED');
  return buildVoiceTutorCapsule(input);
}

export function publicVoiceTutorCapsule(capsule) {
  return {
    id: capsule.id,
    version: capsule.version,
    source: { ...capsule.source },
    module: capsule.module,
    item: {
      id: capsule.item.id,
      prompt: capsule.item.prompt,
      ...(capsule.item.context ? { context: { ...capsule.item.context } } : {}),
    },
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
