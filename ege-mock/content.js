import { assignmentFor, readBuiltinTasks } from '../ai/task-bank.js';
import { GRAMMAR_CATALOG } from '../public/grammar-catalog.js';
import {
  LISTENING_INTERVIEW_SETS,
  LISTENING_MATCHING_SETS,
  LISTENING_TRUE_FALSE_SETS,
} from '../public/listening-pilot-v1.js';
import { READING_TASK10_SETS } from '../public/content/reading/task10-v1.js';
import { READING_TASK11_SETS } from '../public/content/reading/task11-v1.js';
import { READING_TASK12_18_SETS } from '../public/content/reading/task12-18-v1.js';
import { SPEAKING_TASK1_CATALOG } from '../public/content/speaking/task1-v1.js';
import { SPEAKING_TASK2_CATALOG } from '../public/content/speaking/task2-v1.js';
import { SPEAKING_TASK3_CATALOG } from '../public/content/speaking/task3-v1.js';
import { SPEAKING_TASK4_CATALOG } from '../public/content/speaking/task4-v1.js';
import {
  speakingTask1PublicAssignment,
  speakingTask2PublicAssignment,
  speakingTask3PublicAssignment,
  speakingTask4PublicAssignment,
} from '../public/speaking-catalog-contract.js';
import { AUTHORED_LEXIS_ITEMS } from './authored-lexis.js';
import { resolveEgeMockCriteriaRef } from './criteria.js';
import { deepFreeze } from './immutable.js';

function exactById(values, id, revision) {
  const value = values.find((candidate) => candidate.id === id && candidate.revision === revision);
  if (!value) throw new Error(`EGE_MOCK_CONTENT_REF_MISSING: ${id}@${revision}`);
  return value;
}

const contentRef = (catalogId, id, revision) => Object.freeze({ catalogId, id, revision });

function optionList(values) {
  return values.map((text, index) => ({ id: String.fromCharCode(97 + index), text }));
}

function numberedOptionList(values) {
  return values.map((text, index) => ({ id: String(index + 1), text }));
}

function objective(type, maxScore, accepted, scoreRule = { kind: 'all_or_nothing' }) {
  return {
    type,
    maxScore,
    accepted,
    scoreRule,
  };
}

function provisional(maxScore, criteriaRef) {
  const criteria = resolveEgeMockCriteriaRef(criteriaRef);
  if (!criteria || criteria.maxScore !== maxScore) {
    throw new Error(`EGE_MOCK_CRITERIA_REF_MISSING: ${criteriaRef}`);
  }
  return { type: 'provisional', maxScore, criteriaRef, criteriaFingerprint: criteria.fingerprint };
}

const listeningMatching = exactById(
  LISTENING_MATCHING_SETS,
  'listening-pilot-v1.matching.greener-life',
  1,
);
const listeningTrueFalse = exactById(
  LISTENING_TRUE_FALSE_SETS,
  'listening-pilot-v1.true-false.repair-cafe',
  1,
);
const listeningInterview = exactById(
  LISTENING_INTERVIEW_SETS,
  'listening-pilot-v1.interview.youth-orchestra',
  1,
);

const readingTask10 = exactById(
  READING_TASK10_SETS,
  'reading-pilot-v1.task10.student-journalism',
  1,
);
const readingTask11 = exactById(
  READING_TASK11_SETS,
  'reading-pilot-v1.task11.station-after-dark',
  1,
);
const readingTask12 = exactById(
  READING_TASK12_18_SETS,
  'reading-pilot-v1.task12_18.counting-swifts-at-sunset',
  1,
);

const grammarExam = exactById(GRAMMAR_CATALOG.exams, 'core.g.exam.1', 3);
const builtinWriting = readBuiltinTasks();
function exactWriting(id, expectedContentHash) {
  const value = builtinWriting.find(({ externalId, contentHash }) => (
    externalId === id && contentHash === expectedContentHash
  ));
  if (!value) throw new Error(`EGE_MOCK_WRITING_REF_MISSING: ${id}@1`);
  return value;
}
const writing37 = exactWriting(
  'builtin:writing_37:emily-new-flat',
  '2ea49487ee1b7660a9bada1012ab162c391a1e1e3f04e471ed69f06754e28dea',
);
const writing38 = exactWriting(
  'builtin:writing_38:teen-sport',
  'd4c4f14d721f5e0d154275b20cdb42972ff5c4cebffe8d6a58de1d59dd674e4e',
);

const speaking1 = exactById(SPEAKING_TASK1_CATALOG.tasks, 'speaking-pilot-v1.task1.citizen-weather', 1);
const speaking2 = exactById(SPEAKING_TASK2_CATALOG.tasks, 'speaking-pilot-v1.task2.organic-farm-volunteers', 1);
const speaking3 = exactById(SPEAKING_TASK3_CATALOG.tasks, 'speaking-pilot-v1.task3.volunteer-projects', 1);
const speaking4 = exactById(SPEAKING_TASK4_CATALOG.tasks, 'speaking-pilot-v1.task4.school-projects', 1);

const positions = [
  {
    position: 1,
    contentRef: contentRef('listening-pilot-v1', listeningMatching.id, listeningMatching.revision),
    presentation: {
      kind: 'listening_matching', title: listeningMatching.title, topic: listeningMatching.topic,
      cefr: listeningMatching.cefr, statements: listeningMatching.task.statements,
    },
    assessment: objective(
      'ordered_choice_list', 2, listeningMatching.task.answers.map((answer) => String(answer + 1)),
      { kind: 'correct_count_bands', bands: [[6, 2], [4, 1], [0, 0]] },
    ),
  },
  {
    position: 2,
    contentRef: contentRef('listening-pilot-v1', listeningTrueFalse.id, listeningTrueFalse.revision),
    presentation: {
      kind: 'listening_true_false', title: listeningTrueFalse.title, topic: listeningTrueFalse.topic,
      cefr: listeningTrueFalse.cefr, statements: listeningTrueFalse.task.statements,
      options: [
        { id: 'true', text: 'True' }, { id: 'false', text: 'False' },
        { id: 'not_stated', text: 'Not stated' },
      ],
    },
    assessment: objective(
      'ordered_choice_list', 3, listeningTrueFalse.task.answers,
      { kind: 'correct_count_bands', bands: [[7, 3], [5, 2], [3, 1], [0, 0]] },
    ),
  },
  ...listeningInterview.task.questions.map((question, index) => ({
    position: index + 3,
    contentRef: contentRef(
      'listening-pilot-v1', `${listeningInterview.id}.q${index + 1}`, listeningInterview.revision,
    ),
    presentation: {
      kind: 'listening_choice', prompt: question.prompt, options: optionList(question.options),
    },
    assessment: objective('single_choice', 1, [String.fromCharCode(97 + question.answer)]),
  })),
  {
    position: 10,
    contentRef: contentRef('reading-pilot-v1', readingTask10.id, readingTask10.revision),
    presentation: {
      kind: 'reading_headings', title: readingTask10.title, topic: readingTask10.topic,
      cefr: readingTask10.cefr, texts: readingTask10.task.texts,
      options: numberedOptionList(readingTask10.task.headings),
    },
    assessment: objective(
      'ordered_choice_list', 3, readingTask10.task.answers.map((answer) => String(answer + 1)),
      { kind: 'correct_count_bands', bands: [[7, 3], [5, 2], [3, 1], [0, 0]] },
    ),
  },
  {
    position: 11,
    contentRef: contentRef('reading-pilot-v1', readingTask11.id, readingTask11.revision),
    presentation: {
      kind: 'reading_gaps', title: readingTask11.title, topic: readingTask11.topic,
      cefr: readingTask11.cefr, segments: readingTask11.task.segments,
      options: numberedOptionList(readingTask11.task.fragments),
    },
    assessment: objective(
      'ordered_choice_list', 2, readingTask11.task.answers.map((answer) => String(answer + 1)),
      { kind: 'correct_count_bands', bands: [[6, 2], [4, 1], [0, 0]] },
    ),
  },
  ...readingTask12.task.questions.map((question, index) => ({
    position: index + 12,
    contentRef: contentRef(
      'reading-pilot-v1', `${readingTask12.id}.q${index + 1}`, readingTask12.revision,
    ),
    presentation: {
      kind: 'reading_choice', stimulusId: `${readingTask12.id}@1:passage`,
      prompt: question.prompt, options: optionList(question.options),
    },
    assessment: objective('single_choice', 1, [String.fromCharCode(97 + question.answer)]),
  })),
  ...grammarExam.gaps.map((gap, index) => ({
    position: index + 19,
    contentRef: contentRef('grammar-core-v3', `${grammarExam.id}.${index + 1}`, grammarExam.revision),
    presentation: {
      kind: 'grammar_form', stimulusId: `${grammarExam.id}@3:passage`, gapIndex: index,
      base: gap.b,
    },
    assessment: objective('short_text', 1, gap.ans),
  })),
  ...AUTHORED_LEXIS_ITEMS.map((item) => ({
    position: item.position,
    contentRef: item.contentRef,
    presentation: item.presentation,
    assessment: item.assessment,
  })),
  {
    position: 37,
    contentRef: contentRef('writing-task-bank-v1', writing37.externalId, 1),
    presentation: { kind: 'writing_email', ...assignmentFor(writing37.operation, writing37.content) },
    assessment: provisional(6, 'writing-ege-2026-task37-v1'),
  },
  {
    position: 38,
    contentRef: contentRef('writing-task-bank-v1', writing38.externalId, 1),
    presentation: { kind: 'writing_report', ...assignmentFor(writing38.operation, writing38.content) },
    assessment: provisional(14, 'writing-ege-2026-task38-v1'),
  },
  {
    position: 39,
    contentRef: contentRef('speaking-pilot-v1', speaking1.id, speaking1.revision),
    presentation: { kind: 'speaking_read_aloud', ...speakingTask1PublicAssignment(speaking1) },
    assessment: provisional(1, 'speaking-ege-2026-task1-v1'),
  },
  {
    position: 40,
    contentRef: contentRef('speaking-pilot-v1', speaking2.id, speaking2.revision),
    presentation: { kind: 'speaking_questions', ...speakingTask2PublicAssignment(speaking2) },
    assessment: provisional(4, 'speaking-ege-2026-task2-v1'),
  },
  {
    position: 41,
    contentRef: contentRef('speaking-pilot-v1', speaking3.id, speaking3.revision),
    presentation: { kind: 'speaking_interview', ...speakingTask3PublicAssignment(speaking3) },
    assessment: provisional(5, 'speaking-ege-2026-task3-v1'),
  },
  {
    position: 42,
    contentRef: contentRef('speaking-pilot-v1', speaking4.id, speaking4.revision),
    presentation: { kind: 'speaking_voice_message', ...speakingTask4PublicAssignment(speaking4) },
    assessment: provisional(10, 'speaking-ege-2026-task4-v1'),
  },
];

export const EGE_MOCK_FORM_CONTENT = deepFreeze({
  positions,
  stimuli: [
    { id: `${readingTask12.id}@1:passage`, kind: 'reading_passage', text: readingTask12.task.text },
    { id: `${grammarExam.id}@3:passage`, kind: 'gap_passage', fragments: grammarExam.tx },
  ],
});
