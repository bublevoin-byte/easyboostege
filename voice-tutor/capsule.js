import crypto from 'node:crypto';
import { parseSpeakingReview, speakingTrustedInputSchema } from '../ai/speaking.js';
import { parseStoredSpeakingReview, SPEAKING_SCORING_VERSION } from '../speaking/fipi-scoring.js';
import { parseAndValidateWritingReview, writingAssignmentSchema } from '../ai/writing.js';
import { getCanonicalVoiceTutorItem, getCanonicalVoiceTutorResultSet } from './canonical-items.js';
import {
  GRAMMAR_LEXICON_CAPSULE_VERSION,
  isContextVoiceTutorModule,
  isDirectVoiceTutorModule,
  READING_LISTENING_CAPSULE_VERSION,
  voiceTutorModule,
  WRITING_SPEAKING_CAPSULE_VERSION,
} from './modules.js';
import { practicePromptKey } from './practice.js';
import { reviewRecoveryTasks } from './recovery.js';
import { normalizeTutorAnswer } from './state-machine.js';

export const VOICE_CAPSULE_VERSION = GRAMMAR_LEXICON_CAPSULE_VERSION;
export { GRAMMAR_LEXICON_CAPSULE_VERSION, READING_LISTENING_CAPSULE_VERSION, WRITING_SPEAKING_CAPSULE_VERSION };

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

function itemRule(item) {
  if (item.rule && typeof item.rule === 'object' && Array.isArray(item.rule.examples)) {
    return { ...item.rule, examples: [...item.rule.examples] };
  }
  return {
    id: `missing:${item.skill.id}`,
    revision: 0,
    title: 'Правило пока не найдено',
    explanation: 'Easy Boost ищет объяснение только в доверенных источниках.',
    examples: [],
    discovery_required: true,
  };
}

function recoveryTask(task, skillId, excludedPrompts) {
  if (!task || (task.skillId && task.skillId !== skillId) || !Array.isArray(task.answers)
    || task.answers.length < 1 || task.answers.length > 10) {
    throw new VoiceTutorCapsuleError('VOICE_TUTOR_REPEAT_TASK_UNAVAILABLE');
  }
  const prompt = boundedString(task.prompt, 1_000, 'VOICE_TUTOR_REPEAT_TASK_UNAVAILABLE');
  const normalized = practicePromptKey(prompt);
  if (!normalized || excludedPrompts.has(normalized)) {
    throw new VoiceTutorCapsuleError('VOICE_TUTOR_REPEAT_TASK_UNAVAILABLE');
  }
  excludedPrompts.add(normalized);
  return {
    ...(task.id ? { id: boundedString(task.id, 180, 'VOICE_TUTOR_REPEAT_TASK_UNAVAILABLE') } : {}),
    skillId,
    prompt,
    answers: task.answers.map((answer) => boundedString(answer, 200, 'VOICE_TUTOR_REPEAT_TASK_UNAVAILABLE')),
  };
}

function itemRecoveryTasks(item) {
  const excludedPrompts = new Set([
    item.prompt, item.microCheck?.prompt, item.transferTask?.prompt,
  ].map(practicePromptKey).filter(Boolean));
  return {
    day_1: recoveryTask(item.recoveryTasks?.day1, item.skill.id, excludedPrompts),
    day_7: recoveryTask(item.recoveryTasks?.day7, item.skill.id, excludedPrompts),
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
      ...(item.origin ? { origin: { ...item.origin } } : {}),
    },
    learner_answer: learnerAnswer,
    error: { type: item.errorType },
    skill: { ...item.skill },
    rule: itemRule(item),
    checks: {
      micro_check: { ...item.microCheck, answers: [...item.microCheck.answers] },
      transfer_task: { ...item.transferTask, answers: [...item.transferTask.answers] },
    },
    recovery_tasks: itemRecoveryTasks(item),
  };
  if (JSON.stringify(capsule).length > 12_000) throw new VoiceTutorCapsuleError('VOICE_TUTOR_CAPSULE_TOO_LARGE');
  return capsule;
}

export function buildGrammarLexiconCapsule(input) {
  if (!isDirectVoiceTutorModule(input?.attempt?.module)) throw new VoiceTutorCapsuleError('VOICE_TUTOR_ATTEMPT_NOT_SUPPORTED');
  return buildVoiceTutorCapsule(input);
}

function validatedReviewAttempt(source, attempt) {
  if (!attempt || attempt.status !== 'completed' || !attempt.review || !attempt.assignment) {
    throw new VoiceTutorCapsuleError('VOICE_TUTOR_ATTEMPT_NOT_SUPPORTED');
  }
  try {
    if (source === 'writing') {
      const taskType = String(attempt.task_type || '');
      const assignment = writingAssignmentSchema.safeParse({ taskType, assignment: attempt.assignment });
      if (!assignment.success) throw new Error('assignment invalid');
      const answer = boundedString(attempt.answer, 20_000, 'VOICE_TUTOR_REVIEW_INVALID');
      const evaluatedAnswer = boundedString(attempt.evaluated_answer, 8_000, 'VOICE_TUTOR_CAPSULE_TOO_LARGE');
      const review = parseAndValidateWritingReview(JSON.stringify(attempt.review), { taskType, answer, assignment: attempt.assignment });
      return { taskType, assignment: assignment.data.assignment, learnerAnswer: evaluatedAnswer, review };
    }
    if (source === 'speaking') {
      const taskType = Number(attempt.task_type);
      const parsedInput = speakingTrustedInputSchema.safeParse({ taskType, transcript: attempt.transcript, assignment: attempt.assignment });
      if (!parsedInput.success) throw new Error('speaking attempt invalid');
      const learnerAnswer = boundedString(parsedInput.data.transcript, 8_000, 'VOICE_TUTOR_CAPSULE_TOO_LARGE');
      if (attempt.review.scoringVersion === SPEAKING_SCORING_VERSION
        && attempt.review.status !== 'scored') {
        throw new VoiceTutorCapsuleError('VOICE_TUTOR_ATTEMPT_NOT_SUPPORTED');
      }
      const review = attempt.review.scoringVersion === SPEAKING_SCORING_VERSION
        ? parseStoredSpeakingReview(taskType, attempt.review)
        : parseSpeakingReview(taskType, JSON.stringify(attempt.review));
      return { taskType, assignment: structuredClone(parsedInput.data.assignment), learnerAnswer, review };
    }
  } catch (error) {
    if (error instanceof VoiceTutorCapsuleError) throw error;
    throw new VoiceTutorCapsuleError('VOICE_TUTOR_REVIEW_INVALID');
  }
  throw new VoiceTutorCapsuleError('VOICE_TUTOR_ATTEMPT_NOT_SUPPORTED');
}

export function reviewVoiceTutorCriterionChoices(review) {
  const criteria = Array.isArray(review.criteria) ? review.criteria : [];
  return criteria.flatMap((criterion, criterionIndex) => (
    Number.isFinite(Number(criterion?.got)) && Number.isFinite(Number(criterion?.max))
      && Number(criterion.got) < Number(criterion.max)
      ? [{ index: criterionIndex, label: boundedString(criterion.name, 160, 'VOICE_TUTOR_REVIEW_INVALID') }]
      : []
  ));
}

function reviewLosses(source, review) {
  const criteria = Array.isArray(review.criteria) ? review.criteria : [];
  const losses = reviewVoiceTutorCriterionChoices(review).map(({ index: criterionIndex, label: name }) => {
    const criterion = criteria[criterionIndex];
    return {
      criterionIndex,
      name,
      got: Number(criterion.got),
      max: Number(criterion.max),
      lostPoints: Number(criterion.max) - Number(criterion.got),
    };
  });
  if (!losses.length) throw new VoiceTutorCapsuleError('VOICE_TUTOR_ANSWER_NOT_INCORRECT');
  const corrections = source === 'writing' ? review.errors : review.fix;
  const boundedCorrections = (Array.isArray(corrections) ? corrections : [])
    .filter((item) => item && (item.note || item.right))
    .slice(0, 8)
    .map((item) => ({
      ...(String(item.title || '').trim() ? { title: boundedString(item.title, 300, 'VOICE_TUTOR_REVIEW_INVALID') } : {}),
      ...(String(item.note || '').trim() ? { note: boundedString(item.note, 1_000, 'VOICE_TUTOR_REVIEW_INVALID') } : {}),
      ...(String(item.right || '').trim() ? { example: boundedString(item.right, 300, 'VOICE_TUTOR_REVIEW_INVALID') } : {}),
    }));
  return { losses, corrections: boundedCorrections };
}

function practice(microPrompt, microAnswers, transferPrompt, transferAnswers) {
  return Object.freeze({
    microCheck: Object.freeze({ prompt: microPrompt, answers: Object.freeze(microAnswers) }),
    transferTask: Object.freeze({ prompt: transferPrompt, answers: Object.freeze(transferAnswers) }),
  });
}

const WRITING_COMMUNICATIVE = practice(
  'Какой ответ полностью раскрывает причину выбора: A — «I chose the club» или B — «I chose the club because I enjoy teamwork»?',
  ['b', 'вариант b'],
  'Новый пример: вставь связку — «I chose the science club ___ I enjoy experiments.»',
  ['because'],
);
const SPEAKING_COMMUNICATIVE = practice(
  'Какой ответ полностью обосновывает выбор: A — «I prefer photo one» или B — «I prefer photo one because it shows teamwork»?',
  ['b', 'вариант b'],
  'Новый пример: вставь связку — «I prefer the second picture ___ the people look relaxed.»',
  ['because'],
);
const ORGANIZATION = practice(
  'Какое средство связи показывает противопоставление: however или because?',
  ['however'],
  'Новый пример: заверши план ответа — «First, describe the situation. ___, give your opinion.»',
  ['finally'],
);
const LANGUAGE = practice(
  'Выбери грамматически верную форму после three: book или books?',
  ['books'],
  'Новый пример: вставь верную форму — «There are five ___ in the classroom» (student).',
  ['students'],
);
const LEXICON = practice(
  'Какая фраза является верным словосочетанием: make a decision или do a decision?',
  ['make a decision'],
  'Новый пример: вставь слово — «This activity ___ an important role in our lives.»',
  ['plays'],
);
const GRAMMAR = practice(
  'Выбери верную форму: «Yesterday she go to school» или «Yesterday she went to school»?',
  ['went', 'yesterday she went to school'],
  'Новый пример: вставь форму — «If I ___ more time, I would join the club.» (have).',
  ['had'],
);
const SPELLING = practice(
  'Какое написание верно: environment или enviroment?',
  ['environment'],
  'Новый пример: напиши верно слово по подсказке — «необходимый» (necessary).',
  ['necessary'],
);
const READING_COMPLETENESS = practice(
  'Какой вариант сохраняет все слова: A — «The train leaves at nine» или B — «The train at nine»?',
  ['a', 'вариант a'],
  'Новый пример: произнеси или введи без пропусков — «The museum opens at ten on Sundays.»',
  ['the museum opens at ten on sundays'],
);
const EXTENDED_ANSWER = practice(
  'Какой ответ достаточно развёрнут: A — одно короткое утверждение или B — утверждение и объясняющая причина?',
  ['b', 'вариант b'],
  'Новый пример: дополни второй фразой — «I enjoy learning English. I practise every day ___ I want to speak confidently.»',
  ['because'],
);
const DIRECT_QUESTIONS = Object.freeze([
  practice('Какой прямой вопрос построен верно: A — «How much does it cost?» или B — «How much it costs?»', ['a', 'вариант a'], 'Новый аналог: задай грамматически верный прямой вопрос о цене.', ['how much does it cost']),
  practice('Какой порядок слов верен: «Where is the hotel located?» или «Where the hotel is located?»', ['where is the hotel located'], 'Новый аналог: задай прямой вопрос о расположении отеля.', ['where is the hotel located']),
  practice('Какой вопрос верен: «Is breakfast included?» или «Breakfast is included?»', ['is breakfast included'], 'Новый аналог: задай прямой вопрос о включённом завтраке.', ['is breakfast included']),
  practice('Какой вопрос верен: «Is there a car park?» или «There is a car park?»', ['is there a car park'], 'Новый аналог: задай прямой вопрос о парковке.', ['is there a car park']),
]);

const REVIEW_PRACTICES = Object.freeze({
  'writing:writing_37:0': WRITING_COMMUNICATIVE,
  'writing:writing_37:1': ORGANIZATION,
  'writing:writing_37:2': LANGUAGE,
  'writing:writing_38:0': WRITING_COMMUNICATIVE,
  'writing:writing_38:1': ORGANIZATION,
  'writing:writing_38:2': LEXICON,
  'writing:writing_38:3': GRAMMAR,
  'writing:writing_38:4': SPELLING,
  'speaking:1:0': READING_COMPLETENESS,
  'speaking:2:0': DIRECT_QUESTIONS[0],
  'speaking:2:1': DIRECT_QUESTIONS[1],
  'speaking:2:2': DIRECT_QUESTIONS[2],
  'speaking:2:3': DIRECT_QUESTIONS[3],
  'speaking:3:0': EXTENDED_ANSWER,
  'speaking:3:1': EXTENDED_ANSWER,
  'speaking:3:2': EXTENDED_ANSWER,
  'speaking:3:3': EXTENDED_ANSWER,
  'speaking:3:4': EXTENDED_ANSWER,
  'speaking:4:0': SPEAKING_COMMUNICATIVE,
  'speaking:4:1': ORGANIZATION,
  'speaking:4:2': LANGUAGE,
});

function reviewPractice(source, taskType, criterionIndex) {
  const result = REVIEW_PRACTICES[`${source}:${taskType}:${criterionIndex}`];
  if (!result) throw new VoiceTutorCapsuleError('VOICE_TUTOR_CRITERION_NOT_FOUND');
  return result;
}

function reviewCriterionFamily(source, taskType, criterionIndex) {
  if (source === 'writing') {
    if (criterionIndex === 0) return 'communicative';
    if (criterionIndex === 1) return 'organization';
    if (taskType === 'writing_37') return 'language';
    return ['lexicon', 'grammar', 'spelling'][criterionIndex - 2] || null;
  }
  if (taskType === 1) return 'reading_aloud';
  if (taskType === 2) return 'direct_questions';
  if (taskType === 3) return 'extended_answer';
  return ['communicative', 'organization', 'language'][criterionIndex] || null;
}

const CORRECTION_FAMILY_PATTERNS = Object.freeze({
  communicative: /аспект|содержан|полност|причин|коммуник|content|reason/iu,
  organization: /организац|структур|абзац|связк|логик|organization|paragraph|linking|structure/iu,
  language: /язык|лексик|граммат|орфограф|пунктуац|множествен|врем|форм|vocab|grammar|spelling|plural|tense/iu,
  lexicon: /лексик|словосочет|collocat|vocab/iu,
  grammar: /граммат|множествен|врем|форм|порядок слов|grammar|plural|tense|word order/iu,
  spelling: /орфограф|пунктуац|написан|spelling|punctuat/iu,
  reading_aloud: /пропуск|без пропуск|omission/iu,
  direct_questions: /прям.{0,20}вопрос|порядок слов|direct question|word order/iu,
  extended_answer: /план|раскры|обосн|пример|extended|plan|example/iu,
});

function correctionsForCriterion(source, taskType, criterionIndex, losses, corrections) {
  if (losses.length === 1) return corrections;
  const selectedFamily = reviewCriterionFamily(source, taskType, criterionIndex);
  const lossFamilies = losses.map((loss) => reviewCriterionFamily(source, taskType, loss.criterionIndex));
  if (!selectedFamily || lossFamilies.filter((family) => family === selectedFamily).length !== 1) return [];
  return corrections.filter((correction) => {
    const evidence = `${correction.title || ''} ${correction.note || ''}`;
    const matched = [...new Set(lossFamilies.filter((family) => CORRECTION_FAMILY_PATTERNS[family]?.test(evidence)))];
    return matched.length === 1 && matched[0] === selectedFamily;
  });
}

function assignmentPrompt(source, taskType, assignment) {
  const label = source === 'writing' ? `Письменное задание ${String(taskType).replace('writing_', '')}` : `Устное задание ${taskType}`;
  return `${label}: ${boundedString(JSON.stringify(assignment), 2_500, 'VOICE_TUTOR_CAPSULE_TOO_LARGE')}`;
}

export function buildWritingSpeakingCapsule({ source, attempt, expectedRevision, criterionIndex }) {
  if (source !== 'writing' && source !== 'speaking') throw new VoiceTutorCapsuleError('VOICE_TUTOR_ATTEMPT_NOT_SUPPORTED');
  if (!Number.isInteger(Number(attempt?.id)) || Number(attempt.id) < 1) throw new VoiceTutorCapsuleError('VOICE_TUTOR_ATTEMPT_NOT_FOUND');
  if (Number(expectedRevision) !== 1) throw new VoiceTutorCapsuleError('VOICE_TUTOR_REVISION_MISMATCH');
  if (!Number.isInteger(criterionIndex) || criterionIndex < 0 || criterionIndex > 20) {
    throw new VoiceTutorCapsuleError('VOICE_TUTOR_CRITERION_NOT_FOUND');
  }
  const validated = validatedReviewAttempt(source, attempt);
  const { losses, corrections } = reviewLosses(source, validated.review);
  const selected = losses.find((loss) => loss.criterionIndex === criterionIndex);
  if (!selected) throw new VoiceTutorCapsuleError('VOICE_TUTOR_CRITERION_NOT_FOUND');
  const selectedPractice = reviewPractice(source, validated.taskType, criterionIndex);
  const selectedCorrections = correctionsForCriterion(
    source, validated.taskType, criterionIndex, losses, corrections,
  );
  const correctionNote = selectedCorrections[0]?.note
    || `По критерию «${selected.name}» потеряно ${selected.lostPoints} из ${selected.max}. Разберём этот критерий на отдельном примере.`;
  const sourceId = Number(attempt.id);
  const skillId = `ege.${source}.${validated.taskType}.criterion.${criterionIndex + 1}`;
  const recoveryTasks = reviewRecoveryTasks(skillId);
  if (!recoveryTasks) throw new VoiceTutorCapsuleError('VOICE_TUTOR_REPEAT_TASK_UNAVAILABLE');
  const excludedPrompts = new Set([
    assignmentPrompt(source, validated.taskType, validated.assignment),
    selectedPractice.microCheck.prompt,
    selectedPractice.transferTask.prompt,
  ].map(practicePromptKey).filter(Boolean));
  const capsule = {
    id: `voice-capsule:${source}:${sourceId}:criterion:${criterionIndex + 1}`,
    version: WRITING_SPEAKING_CAPSULE_VERSION,
    source: { attempt_type: source, attempt_id: sourceId, item_revision: 1, criterion_index: criterionIndex },
    module: source,
    item: {
      id: `${source}.${validated.taskType}.criterion.${criterionIndex + 1}`,
      prompt: assignmentPrompt(source, validated.taskType, validated.assignment),
      reference: {
        selectedCriterionIndex: criterionIndex,
        criteria: losses,
        review: {
          verdict: boundedString(validated.review.verdict, 1_000, 'VOICE_TUTOR_REVIEW_INVALID'),
          note: correctionNote,
          corrections: selectedCorrections,
        },
      },
    },
    learner_answer: validated.learnerAnswer,
    error: { type: `${source}_criterion_loss`, lost_points: selected.lostPoints },
    skill: { id: skillId, label: `${source === 'writing' ? 'Письмо' : 'Устная часть'}: ${selected.name}` },
    rule: {
      id: `${source}.${validated.taskType}.criterion.${criterionIndex + 1}.review-v1`,
      title: `Критерий «${selected.name}»`,
      explanation: `${losses.map((loss) => `«${loss.name}»: потеряно ${loss.lostPoints} из ${loss.max}`).join('; ')}. Сейчас разбираем «${selected.name}». ${correctionNote}`,
      examples: selectedCorrections.flatMap((correction) => correction.example ? [correction.example] : []),
    },
    checks: {
      micro_check: {
        id: `${source}.${sourceId}.criterion.${criterionIndex + 1}.check`,
        ...selectedPractice.microCheck,
      },
      transfer_task: {
        id: `${source}.${sourceId}.criterion.${criterionIndex + 1}.transfer`,
        ...selectedPractice.transferTask,
      },
    },
    recovery_tasks: {
      day_1: recoveryTask(recoveryTasks.day_1, skillId, excludedPrompts),
      day_7: recoveryTask(recoveryTasks.day_7, skillId, excludedPrompts),
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
    item: {
      id: capsule.item.id,
      prompt: capsule.item.prompt,
      ...(capsule.item.context ? { context: { ...capsule.item.context } } : {}),
      ...(capsule.item.origin ? { origin: { ...capsule.item.origin } } : {}),
    },
    error: { ...capsule.error },
    skill: { ...capsule.skill },
    ...(capsule.rule_card_id ? { rule_card_id: capsule.rule_card_id } : {}),
    rule: { ...capsule.rule, examples: [...capsule.rule.examples] },
    checks: {
      micro_check: { id: capsule.checks.micro_check.id, prompt: capsule.checks.micro_check.prompt },
      transfer_task: { id: capsule.checks.transfer_task.id, prompt: capsule.checks.transfer_task.prompt },
    },
  };
}

export function persistedVoiceTutorCapsule(capsule) {
  return {
    schema: 'voice-tutor-reference-v1',
    id: capsule.id,
    version: capsule.version,
    source: structuredClone(capsule.source),
    module: capsule.module,
    skill_id: capsule.skill.id,
    ...(capsule.rule_card_id ? { rule_card_id: capsule.rule_card_id } : {}),
  };
}
