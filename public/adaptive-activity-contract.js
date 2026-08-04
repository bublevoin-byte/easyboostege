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
    skillId: 'ege.grammar.transformations', activityId: 'grammar_transformations_topic_18',
    activityLabel: 'Практика грамматических преобразований: вопросы',
    contentRef: 'builtin:grammar:topic:18', minimumMinutes: 15, recommendedMinutes: 15,
    difficulty: 3, modality: 'visual_text', requiresAudio: false, requiresMicrophone: false,
    launch: { version: ADAPTIVE_LAUNCH_CONTRACT_VERSION, kind: 'grammar_practice', screenId: 'scr3', topicId: 18 },
  },
  {
    skillId: 'ege.reading.gist', activityId: 'reading_headings',
    activityLabel: 'Чтение: подобрать заголовки',
    contentRef: 'builtin:reading:headings:v1', minimumMinutes: 15, recommendedMinutes: 15,
    difficulty: 2, modality: 'visual_text', requiresAudio: false, requiresMicrophone: false,
    launch: { version: ADAPTIVE_LAUNCH_CONTRACT_VERSION, kind: 'reading_mode', screenId: 'scr7', mode: 'headings' },
  },
  {
    skillId: 'ege.reading.detail', activityId: 'reading_detail',
    activityLabel: 'Чтение: детальные вопросы по тексту',
    contentRef: 'builtin:reading:detail:v1', minimumMinutes: 20, recommendedMinutes: 20,
    difficulty: 3, modality: 'visual_text', requiresAudio: false, requiresMicrophone: false,
    launch: { version: ADAPTIVE_LAUNCH_CONTRACT_VERSION, kind: 'reading_mode', screenId: 'scr7', mode: 'detail' },
  },
  {
    skillId: 'ege.listening.gist', activityId: 'listening_matching',
    activityLabel: 'Аудирование: сопоставить говорящих',
    contentRef: 'builtin:listening:matching:v1', minimumMinutes: 15, recommendedMinutes: 15,
    difficulty: 2, modality: 'audio', requiresAudio: true, requiresMicrophone: false,
    launch: { version: ADAPTIVE_LAUNCH_CONTRACT_VERSION, kind: 'listening_mode', screenId: 'scr4', mode: 'matching' },
  },
  {
    skillId: 'ege.listening.detail', activityId: 'listening_interview',
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

function exactKeys(value, expected) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

export function isAdaptiveLaunchDescriptor(value) {
  if (!value || value.version !== ADAPTIVE_LAUNCH_CONTRACT_VERSION) return false;
  if (value.kind === 'vocabulary_practice') {
    return exactKeys(value, ['kind', 'mode', 'screenId', 'topicId', 'version'])
      && value.screenId === 'scr2' && value.mode === 'lexical_choice'
      && [1, 6].includes(value.topicId);
  }
  if (value.kind === 'grammar_practice') {
    return exactKeys(value, ['kind', 'screenId', 'topicId', 'version'])
      && value.screenId === 'scr3' && [3, 4, 18].includes(value.topicId);
  }
  if (value.kind === 'reading_mode') {
    return exactKeys(value, ['kind', 'mode', 'screenId', 'version'])
      && value.screenId === 'scr7' && ['headings', 'detail'].includes(value.mode);
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
  return false;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

export const ADAPTIVE_ACTIVITY_DEFINITIONS = deepFreeze(activityDefinitions);
