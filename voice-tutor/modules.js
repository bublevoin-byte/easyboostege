export const GRAMMAR_LEXICON_CAPSULE_VERSION = 'grammar-lexicon-v1';
export const READING_LISTENING_CAPSULE_VERSION = 'reading-listening-v1';

const READING_CONTEXT = Object.freeze({
  kind: 'source_excerpt',
  label: 'Фрагмент текста',
  skill: Object.freeze({ id: 'ege.reading.evidence', label: 'Чтение: ответ по фрагменту' }),
  rule: Object.freeze({
    id: 'reading.evidence.v1',
    title: 'Ответ подтверждается конкретным фрагментом',
    example: 'Найди в тексте слова, которые прямо подтверждают выбранный вариант.',
  }),
  microCheck: Object.freeze({
    prompt: 'Фрагмент: “The library closes at six on Fridays.” Во сколько библиотека закрывается по пятницам?',
    answers: Object.freeze(['At six', 'Six']),
  }),
  transferTask: Object.freeze({
    prompt: 'Фрагмент: “Mia postponed university for twelve months to volunteer abroad.” Что сделала Mia?',
    answers: Object.freeze(['She took a year off', 'Mia took a year off']),
  }),
});

const LISTENING_CONTEXT = Object.freeze({
  kind: 'transcript_segment',
  label: 'Фрагмент транскрипта',
  skill: Object.freeze({ id: 'ege.listening.evidence', label: 'Аудирование: ответ по транскрипту' }),
  rule: Object.freeze({
    id: 'listening.evidence.v1',
    title: 'Ответ подтверждается конкретной репликой',
    example: 'Сопоставь вопрос с точными словами говорящего.',
  }),
  microCheck: Object.freeze({
    prompt: 'Фрагмент: “The meeting starts at nine.” Во сколько начинается встреча?',
    answers: Object.freeze(['At nine', 'Nine']),
  }),
  transferTask: Object.freeze({
    prompt: 'Фрагмент: “Ben began running because it was raining and the bus was late.” Почему Ben начал бегать?',
    answers: Object.freeze(['Because it was raining and the bus was late', 'It was raining and the bus was late']),
  }),
});

const MODULES = Object.freeze({
  grammar: Object.freeze({ directError: true, capsuleVersion: GRAMMAR_LEXICON_CAPSULE_VERSION, contextKind: null }),
  vocabulary: Object.freeze({ directError: true, capsuleVersion: GRAMMAR_LEXICON_CAPSULE_VERSION, contextKind: null }),
  reading: Object.freeze({ directError: false, capsuleVersion: READING_LISTENING_CAPSULE_VERSION, contextKind: READING_CONTEXT.kind, context: READING_CONTEXT }),
  listening: Object.freeze({ directError: false, capsuleVersion: READING_LISTENING_CAPSULE_VERSION, contextKind: LISTENING_CONTEXT.kind, context: LISTENING_CONTEXT }),
});

export function voiceTutorModule(module) {
  return MODULES[String(module || '')] || null;
}

export function isDirectVoiceTutorModule(module) {
  return voiceTutorModule(module)?.directError === true;
}

export function isContextVoiceTutorModule(module) {
  const descriptor = voiceTutorModule(module);
  return Boolean(descriptor && !descriptor.directError);
}
