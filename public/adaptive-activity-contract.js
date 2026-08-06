import { LISTENING_ACTIVITY_IDS, READING_ACTIVITY_IDS } from './learning-activity-contract.js';
import { readingAdaptiveContentRef } from './reading-catalog-contract.js';

export const ADAPTIVE_LAUNCH_CONTRACT_VERSION = 'adaptive-launch-v1';

const activityDefinitions = [
  {
    skillId: 'ege.vocabulary.lexical_choice', activityId: 'vocabulary_lexical_choice_topic_1',
    activityLabel: 'Лексика: выбрать перевод слов о семье и отношениях',
    contentRef: 'builtin:vocabulary:srs:topic:1:lexical-choice:v1',
    minimumMinutes: 15, recommendedMinutes: 15,
    difficulty: 2, modality: 'visual_text', requiresAudio: false, requiresMicrophone: false,
    launch: {
      version: ADAPTIVE_LAUNCH_CONTRACT_VERSION, kind: 'vocabulary_practice', screenId: 'scr2',
      mode: 'lexical_choice', topicId: 1,
    },
  },
  {
    skillId: 'ege.vocabulary.lexical_choice', activityId: 'vocabulary_lexical_choice_topic_6',
    activityLabel: 'Лексика: выбрать перевод слов о науке и технологиях',
    contentRef: 'builtin:vocabulary:srs:topic:6:lexical-choice:v1',
    minimumMinutes: 15, recommendedMinutes: 15,
    difficulty: 2, modality: 'visual_text', requiresAudio: false, requiresMicrophone: false,
    launch: {
      version: ADAPTIVE_LAUNCH_CONTRACT_VERSION, kind: 'vocabulary_practice', screenId: 'scr2',
      mode: 'lexical_choice', topicId: 6,
    },
  },
  {
    skillId: 'ege.grammar.forms', activityId: 'grammar_forms_topic_3',
    activityLabel: 'Практика грамматических форм: времена',
    contentRef: 'builtin:grammar:topic:3', minimumMinutes: 15, recommendedMinutes: 15,
    difficulty: 2, modality: 'visual_text', requiresAudio: false, requiresMicrophone: false,
    launch: { version: ADAPTIVE_LAUNCH_CONTRACT_VERSION, kind: 'grammar_practice', screenId: 'scr3', topicId: 3 },
  },
  {
    skillId: 'ege.grammar.forms', activityId: 'grammar_forms_topic_4',
    activityLabel: 'Практика грамматических форм: будущее время',
    contentRef: 'builtin:grammar:topic:4', minimumMinutes: 15, recommendedMinutes: 15,
    difficulty: 3, modality: 'visual_text', requiresAudio: false, requiresMicrophone: false,
    launch: { version: ADAPTIVE_LAUNCH_CONTRACT_VERSION, kind: 'grammar_practice', screenId: 'scr3', topicId: 4 },
  },
  {
    skillId: 'ege.grammar.forms', activityId: 'grammar_forms_exam_19_24',
    activityLabel: 'Экзаменационная практика: задания 19–24',
    contentRef: 'builtin:exam:grammar:19-24:v1', minimumMinutes: 20, recommendedMinutes: 20,
    difficulty: 4, modality: 'visual_text', requiresAudio: false, requiresMicrophone: false,
    launch: {
      version: ADAPTIVE_LAUNCH_CONTRACT_VERSION, kind: 'exam_workflow', screenId: 'scr3',
      section: 'grammar_19_24',
    },
  },
  {
    skillId: 'ege.grammar.transformations', activityId: 'grammar_transformations_topic_18',
    activityLabel: 'Практика грамматических преобразований: вопросы',
    contentRef: 'builtin:grammar:topic:18', minimumMinutes: 15, recommendedMinutes: 15,
    difficulty: 3, modality: 'visual_text', requiresAudio: false, requiresMicrophone: false,
    launch: { version: ADAPTIVE_LAUNCH_CONTRACT_VERSION, kind: 'grammar_practice', screenId: 'scr3', topicId: 18 },
  },
  ...[
    ['task10', 'ege.reading.gist', READING_ACTIVITY_IDS.headings, 'подобрать заголовки', 15, 2],
    ['task11', 'ege.reading.detail', READING_ACTIVITY_IDS.gaps, 'восстановить пропуски', 20, 3],
    ['task12_18', 'ege.reading.detail', READING_ACTIVITY_IDS.detail, 'ответить на вопросы по тексту', 20, 3],
  ].flatMap(([mode, skillId, activityId, label, minutes, difficulty]) => (
    ['B1', 'B2', 'B2+/C1'].map((cefr) => ({
      skillId, activityId,
      activityLabel: `Чтение ${cefr}: ${label}`,
      contentRef: readingAdaptiveContentRef(mode, cefr),
      minimumMinutes: minutes, recommendedMinutes: minutes,
      difficulty: difficulty + (cefr === 'B2+/C1' ? 1 : 0),
      modality: 'visual_text', requiresAudio: false, requiresMicrophone: false,
      launch: {
        version: ADAPTIVE_LAUNCH_CONTRACT_VERSION,
        kind: 'reading_mode', screenId: 'scr7', mode, cefr,
      },
    }))
  )),
  {
    skillId: 'ege.listening.gist', activityId: LISTENING_ACTIVITY_IDS.matching,
    activityLabel: 'Аудирование: сопоставить говорящих',
    contentRef: 'builtin:listening:matching:v1', minimumMinutes: 15, recommendedMinutes: 15,
    difficulty: 2, modality: 'audio', requiresAudio: true, requiresMicrophone: false,
    launch: { version: ADAPTIVE_LAUNCH_CONTRACT_VERSION, kind: 'listening_mode', screenId: 'scr4', mode: 'matching' },
  },
  {
    skillId: 'ege.listening.detail', activityId: LISTENING_ACTIVITY_IDS.interview,
    activityLabel: 'Аудирование: детальные вопросы к интервью',
    contentRef: 'builtin:listening:interview:v1', minimumMinutes: 20, recommendedMinutes: 20,
    difficulty: 3, modality: 'audio', requiresAudio: true, requiresMicrophone: false,
    launch: { version: ADAPTIVE_LAUNCH_CONTRACT_VERSION, kind: 'listening_mode', screenId: 'scr4', mode: 'interview' },
  },
  {
    skillId: 'ege.writing.email', activityId: 'writing_37',
    activityLabel: 'Письмо: задание 37, письмо Emily',
    contentRef: 'builtin:writing_37:emily-new-flat', minimumMinutes: 25, recommendedMinutes: 25,
    difficulty: 3, modality: 'written', requiresAudio: false, requiresMicrophone: false,
    launch: {
      version: ADAPTIVE_LAUNCH_CONTRACT_VERSION, kind: 'writing_task', screenId: 'scr8',
      taskType: 37, taskId: 'builtin:writing_37:emily-new-flat',
    },
  },
  {
    skillId: 'ege.writing.essay', activityId: 'writing_38',
    activityLabel: 'Письмо: задание 38, проект о спорте',
    contentRef: 'builtin:writing_38:teen-sport', minimumMinutes: 30, recommendedMinutes: 30,
    difficulty: 4, modality: 'written', requiresAudio: false, requiresMicrophone: false,
    launch: {
      version: ADAPTIVE_LAUNCH_CONTRACT_VERSION, kind: 'writing_task', screenId: 'scr8',
      taskType: 38, taskId: 'builtin:writing_38:teen-sport',
    },
  },
  {
    skillId: 'ege.speaking.interaction', activityId: 'speaking_2',
    activityLabel: 'Говорение: задание 2, прямые вопросы',
    contentRef: 'builtin:speaking:task:2:v1', minimumMinutes: 15, recommendedMinutes: 15,
    difficulty: 3, modality: 'microphone', requiresAudio: false, requiresMicrophone: true,
    launch: { version: ADAPTIVE_LAUNCH_CONTRACT_VERSION, kind: 'speaking_task', screenId: 'scr9', taskNumber: 2 },
  },
  {
    skillId: 'ege.speaking.monologue', activityId: 'speaking_4',
    activityLabel: 'Говорение: задание 4, монолог по фотографиям',
    contentRef: 'builtin:speaking:task:4:v1', minimumMinutes: 20, recommendedMinutes: 20,
    difficulty: 4, modality: 'microphone', requiresAudio: false, requiresMicrophone: true,
    launch: { version: ADAPTIVE_LAUNCH_CONTRACT_VERSION, kind: 'speaking_task', screenId: 'scr9', taskNumber: 4 },
  },
];

const vocabularyTopics = [
  [1, 'семья и отношения'],
  [2, 'образование'],
  [3, 'работа и карьера'],
  [4, 'путешествия'],
  [5, 'природа и экология'],
  [6, 'наука и технологии'],
  [7, 'здоровье и спорт'],
  [8, 'культура и досуг'],
  [9, 'общество и СМИ'],
  [10, 'город и покупки'],
];
const vocabularyPractices = [
  {
    mode: 'lexical_choice', id: 'lexical_choice', ref: 'srs', suffix: 'lexical-choice',
    label: 'выбрать перевод', difficulty: 2, modality: 'visual_text', requiresAudio: false,
  },
  {
    mode: 'english_production', id: 'productive', ref: 'active-recall', suffix: 'productive',
    label: 'вспомнить и написать слово', difficulty: 3, modality: 'written', requiresAudio: false,
  },
  {
    mode: 'contextual_production', id: 'context', ref: 'active-recall', suffix: 'context',
    label: 'вставить слово в контекст', difficulty: 4, modality: 'written', requiresAudio: false,
  },
  {
    mode: 'listening', id: 'listening', ref: 'active-recall', suffix: 'listening',
    label: 'распознать слово на слух', difficulty: 4, modality: 'audio', requiresAudio: true,
  },
];
const existingVocabularyActivities = new Set(activityDefinitions.map((activity) => activity.activityId));
for (const [topicId, topicLabel] of vocabularyTopics) {
  for (const practice of vocabularyPractices) {
    const activityId = `vocabulary_${practice.id}_topic_${topicId}`;
    if (existingVocabularyActivities.has(activityId)) continue;
    activityDefinitions.push({
      skillId: 'ege.vocabulary.lexical_choice', activityId,
      activityLabel: `Лексика: ${practice.label} — ${topicLabel}`,
      contentRef: `builtin:vocabulary:${practice.ref}:topic:${topicId}:${practice.suffix}:v1`,
      minimumMinutes: 15, recommendedMinutes: 15,
      difficulty: practice.difficulty, modality: practice.modality,
      requiresAudio: practice.requiresAudio, requiresMicrophone: false,
      launch: {
        version: ADAPTIVE_LAUNCH_CONTRACT_VERSION, kind: 'vocabulary_practice', screenId: 'scr2',
        mode: practice.mode, topicId,
      },
    });
  }
}

const retentionSkills = [
  ['ege.vocabulary.lexical_choice', 'Лексический выбор', 'vocabulary'],
  ['ege.vocabulary.word_formation', 'Словообразование', 'vocabulary'],
  ['ege.grammar.forms', 'Грамматические формы', 'grammar'],
  ['ege.grammar.transformations', 'Грамматические преобразования', 'grammar'],
  ['ege.reading.gist', 'Основная мысль текста', 'reading'],
  ['ege.reading.detail', 'Детальное понимание текста', 'reading'],
  ['ege.listening.gist', 'Основная мысль аудио', 'listening'],
  ['ege.listening.detail', 'Детальное понимание аудио', 'listening'],
  ['ege.writing.email', 'Электронное письмо', 'writing'],
  ['ege.writing.essay', 'Развёрнутое письменное высказывание', 'writing'],
  ['ege.speaking.interaction', 'Устное взаимодействие', 'speaking'],
  ['ege.speaking.monologue', 'Монологическое высказывание', 'speaking'],
];

for (const [skillId, label, module] of retentionSkills) {
  activityDefinitions.push({
    skillId,
    activityId: 'voice_tutor_recovery',
    activityLabel: `Проверка переноса: ${label}`,
    contentRef: `builtin:voice-tutor-repeat:${skillId}:v1`,
    minimumMinutes: 15,
    recommendedMinutes: 15,
    difficulty: 3,
    modality: 'visual_text',
    requiresAudio: false,
    requiresMicrophone: false,
    launch: {
      version: ADAPTIVE_LAUNCH_CONTRACT_VERSION,
      kind: 'voice_tutor_recovery',
      screenId: 'scr10',
      skillId,
      module,
    },
  });
}

function exactKeys(value, expected) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function exactIso(value) {
  const parsed = new Date(value);
  return typeof value === 'string' && Number.isFinite(parsed.getTime())
    && parsed.toISOString() === value;
}

export function isAdaptiveLaunchDescriptor(value) {
  if (!value || value.version !== ADAPTIVE_LAUNCH_CONTRACT_VERSION) return false;
  if (value.kind === 'vocabulary_practice') {
    return exactKeys(value, ['kind', 'mode', 'screenId', 'topicId', 'version'])
      && value.screenId === 'scr2'
      && ['lexical_choice', 'english_production', 'contextual_production', 'listening'].includes(value.mode)
      && Number.isInteger(value.topicId) && value.topicId >= 1 && value.topicId <= 10;
  }
  if (value.kind === 'grammar_practice') {
    return exactKeys(value, ['kind', 'screenId', 'topicId', 'version'])
      && value.screenId === 'scr3' && [3, 4, 18].includes(value.topicId);
  }
  if (value.kind === 'exam_workflow') {
    return exactKeys(value, ['kind', 'screenId', 'section', 'version'])
      && value.screenId === 'scr3' && value.section === 'grammar_19_24';
  }
  if (value.kind === 'reading_mode') {
    return exactKeys(value, ['cefr', 'kind', 'mode', 'screenId', 'version'])
      && value.screenId === 'scr7'
      && ['task10', 'task11', 'task12_18'].includes(value.mode)
      && ['B1', 'B2', 'B2+/C1'].includes(value.cefr);
  }
  if (value.kind === 'listening_mode') {
    return exactKeys(value, ['kind', 'mode', 'screenId', 'version'])
      && value.screenId === 'scr4' && ['matching', 'interview'].includes(value.mode);
  }
  if (value.kind === 'writing_task') {
    return exactKeys(value, ['kind', 'screenId', 'taskId', 'taskType', 'version'])
      && value.screenId === 'scr8' && [37, 38].includes(value.taskType)
      && value.taskId === (value.taskType === 37
        ? 'builtin:writing_37:emily-new-flat' : 'builtin:writing_38:teen-sport');
  }
  if (value.kind === 'speaking_task') {
    return exactKeys(value, ['kind', 'screenId', 'taskNumber', 'version'])
      && value.screenId === 'scr9' && [2, 4].includes(value.taskNumber);
  }
  if (value.kind === 'voice_tutor_recovery') {
    return exactKeys(value, [
      'dueAt', 'kind', 'module', 'repeatId', 'screenId', 'skillId', 'stage',
      'status', 'taskId', 'version', 'windowEndsAt',
    ])
      && value.screenId === 'scr10'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value.repeatId)
      && /^[a-z0-9][a-z0-9._:-]{3,179}$/u.test(value.taskId)
      && ['day_1', 'day_7'].includes(value.stage)
      && ['due', 'critical_due'].includes(value.status)
      && exactIso(value.dueAt) && exactIso(value.windowEndsAt)
      && new Date(value.windowEndsAt) > new Date(value.dueAt)
      && retentionSkills.some(([skillId, , module]) => (
        value.skillId === skillId && value.module === module
      ));
  }
  return false;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

export const ADAPTIVE_ACTIVITY_DEFINITIONS = deepFreeze(activityDefinitions);
