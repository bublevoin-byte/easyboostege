import { GRAMMAR_PRACTICE_MODES } from '../grammar-domain-contract.js';
import { GRAMMAR_CATALOG } from '../grammar-catalog.js';
import {
  READING_CATALOG_ID,
  READING_FULL_ATTEMPT_VERSION,
  READING_KINDS,
  readingSetReference,
} from '../reading-catalog-contract.js';

const PRACTICE_SKILLS = Object.freeze([
  Object.freeze({ id: 'vocabulary', label: 'Слова', screenId: 'scr2', icon: 'cards', description: 'Лексика для всех разделов ЕГЭ: интервальное повторение и активное вспоминание.', outcome: 'После тренировки обновятся сроки повторения слов.', offlineReady: true }),
  Object.freeze({ id: 'grammar', label: 'Грамматика', screenId: 'scr3', icon: 'grammar', description: 'Задания 19–24: формы слов, конструкции и закрепление тем.', outcome: 'После завершения ошибки и повторения обновят следующий шаг.', offlineReady: true }),
  Object.freeze({ id: 'reading', label: 'Чтение', screenId: 'scr7', icon: 'reading', description: 'Задания 10–18: соответствия, пропуски и понимание деталей.', outcome: 'После сдачи откроется разбор, а результат появится в прогрессе.', offlineReady: false }),
  Object.freeze({ id: 'listening', label: 'Аудирование', screenId: 'scr4', icon: 'headphones', description: 'Задания 1–9: основная мысль, детали и интервью.', outcome: 'После сдачи откроется разбор, а результат появится в прогрессе.', offlineReady: false }),
  Object.freeze({ id: 'writing', label: 'Письмо', screenId: 'scr8', icon: 'pen', description: 'Задания 37–38: электронное письмо и развёрнутое высказывание.', outcome: 'После отправки откроется разбор; ИИ-оценка остаётся приблизительной.', offlineReady: false }),
  Object.freeze({ id: 'speaking', label: 'Говорение', screenId: 'scr9', icon: 'microphone', description: 'Устная часть: чтение, вопросы, интервью и монолог.', outcome: 'После завершения запись можно прослушать; автоматическая оценка приблизительная.', offlineReady: false }),
]);

const VALID_SKILLS = new Set(PRACTICE_SKILLS.map((skill) => skill.id));
const STATE_COPY = Object.freeze({
  continue: Object.freeze({ label: 'Продолжить', stateLabel: 'Продолжить', reason: 'Есть незавершённая работа — продолжите с сохранённого места.' }),
  review: Object.freeze({ label: 'Повторить', stateLabel: 'Повторить', reason: 'Пришло время повторения по вашим сохранённым результатам.' }),
  recommended: Object.freeze({ label: 'Начать', stateLabel: 'Рекомендуем', reason: 'Текущий план выделяет этот навык как следующий фокус.' }),
  available: Object.freeze({ label: 'Открыть', stateLabel: 'Доступно', reason: 'Доступно для дополнительной практики.' }),
});
const AVAILABILITY_COPY = Object.freeze({
  default: Object.freeze({
    online: 'После первого открытия материалы сохраняются в кэше браузера.',
    cached: 'Экран уже загружен; сохранённые материалы можно открыть офлайн.',
    cacheRequired: 'Для первого открытия нужно подключение; затем материалы сохранятся в кэше.',
  }),
  writing: Object.freeze({
    online: 'Черновик сохраняется локально; ИИ-проверка использует сеть.',
    cached: 'Черновик доступен офлайн; ИИ-проверка требует сеть.',
    cacheRequired: 'Черновик сохранён локально. Первое открытие требует подключения к сети; ИИ-проверка требует сеть.',
  }),
  speaking: Object.freeze({
    online: 'Задания открываются в приложении; запись и проверка используют сеть.',
    cached: 'Загруженный экран доступен; запись и проверка могут требовать сеть.',
    cacheRequired: 'Первое открытие, запись и проверка требуют подключение к сети.',
  }),
});

function selectedSkills(values) {
  return new Set((Array.isArray(values) ? values : []).filter((value) => VALID_SKILLS.has(value)));
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(String(value || ''));
}

function activeGrammarRunner(value, state) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.phase === 'completed') return false;
  if (value.schema === 'grammar-exam-runner-v1') {
    const forms = value.source === 'generated' ? state.examAi : GRAMMAR_CATALOG.exams;
    const form = Array.isArray(forms) ? forms.find((candidate) => candidate?.id === value.formId) : null;
    return value.catalogVersion === GRAMMAR_CATALOG.version
      && value.catalogRevision === GRAMMAR_CATALOG.revision
      && form?.revision === value.formRevision
      && isUuid(value.sessionId) && Array.isArray(value.answers) && value.answers.length === 6
      && Number.isSafeInteger(value.startedAt) && value.startedAt >= 0
      && ['builtin', 'generated'].includes(value.source);
  }
  if (!['grammar-runner-v4', 'grammar-runner-v5'].includes(value.schema)
    || !GRAMMAR_PRACTICE_MODES.includes(value.mode) || !isUuid(value.sessionId)
    || !Array.isArray(value.queue) || value.queue.length < 1 || !Number.isInteger(value.i) || value.i < 0) return false;
  return value.phase === 'completion_pending' ? value.i === value.queue.length : value.i < value.queue.length;
}

function activeReadingDraft(value, ownerBinding, catalog) {
  if (!value || typeof value !== 'object' || !ownerBinding || !catalog) return false;
  if (value.version !== READING_FULL_ATTEMPT_VERSION || value.ownerId !== ownerBinding.username
    || value.catalogId !== READING_CATALOG_ID || value.catalogId !== catalog.id
    || value.catalogRevision !== catalog.revision
    || typeof value.id !== 'string' || !value.id.trim() || !Array.isArray(value.sets)
    || value.sets.length !== READING_KINDS.length || !Array.isArray(catalog.sets)) return false;
  const references = value.sets.map(readingSetReference);
  const currentReferences = new Set(catalog.sets.map(readingSetReference).filter(Boolean).map((reference) => reference.key));
  return references.every(Boolean)
    && references.every((reference) => currentReferences.has(reference.key))
    && READING_KINDS.every((kind) => references.filter((reference) => reference.kind === kind).length === 1);
}

function activeSpeakingSession(state) {
  return ['speakingTask2SessionId', 'speakingTask3SessionId', 'speakingTask4SessionId', 'speakingFullSessionId']
    .some((key) => isUuid(state[key]));
}

function activeFromState(state = {}, ownerBinding = null, readingCatalog = null) {
  const active = new Set();
  if (activeGrammarRunner(state.grammarRunner, state)) active.add('grammar');
  if (activeReadingDraft(state.readingPilotDraft, ownerBinding, readingCatalog)) active.add('reading');
  if (Object.values(state.drafts || {}).some(hasText)) active.add('writing');
  if (activeSpeakingSession(state)) active.add('speaking');
  return active;
}

function dueFromState(state = {}, now = Date.now()) {
  const due = new Set();
  if (Object.values(state.srs || {}).some((record) => (
    Number(record?.s) > 0 && Number.isFinite(Number(record?.due)) && Number(record.due) <= now
  ))) due.add('vocabulary');
  if (Object.values(state.grammarMastery || {}).some((record) => {
    const eligibleAt = Number(record?.eligibleAt ?? record?.due);
    return record?.stage !== 'stable' && Number.isFinite(eligibleAt) && eligibleAt <= now;
  })) due.add('grammar');
  return due;
}

function availabilityFor(skill, online, loaded) {
  const copy = AVAILABILITY_COPY[skill.id] || AVAILABILITY_COPY.default;
  if (online) return {
    availability: 'online',
    availabilityLabel: skill.offlineReady ? 'Встроенные материалы доступны и офлайн.' : copy.online,
  };
  if (skill.offlineReady) return { availability: 'offline-ready', availabilityLabel: 'Встроенные материалы доступны офлайн.' };
  if (loaded) return {
    availability: 'cached',
    availabilityLabel: copy.cached,
  };
  return {
    availability: 'cache-required',
    availabilityLabel: copy.cacheRequired,
  };
}

export function projectPractice(input = {}) {
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const active = activeFromState(input.learnerState, input.ownerBinding, input.readingCatalog);
  selectedSkills(input.activeSkills).forEach((skill) => active.add(skill));
  const due = dueFromState(input.learnerState, now);
  selectedSkills(input.dueSkills).forEach((skill) => due.add(skill));
  const loaded = selectedSkills(input.loadedSkills);
  const recommended = VALID_SKILLS.has(input.recommendedSkill) ? input.recommendedSkill : null;
  const online = input.online !== false;

  const skills = PRACTICE_SKILLS.map((skill) => {
      const state = active.has(skill.id) ? 'continue'
        : due.has(skill.id) ? 'review'
          : recommended === skill.id ? 'recommended' : 'available';
      const copy = STATE_COPY[state];
      return Object.freeze({
        ...skill,
        state,
        stateLabel: copy.stateLabel,
        reason: state === 'continue' && skill.id === 'speaking'
          ? 'Сохранён указатель сессии. При открытии сервер проверит, можно ли её продолжить.'
          : copy.reason,
        action: Object.freeze({ label: copy.label, screenId: skill.screenId }),
        ...availabilityFor(skill, online, loaded.has(skill.id)),
      });
    });
  const nextSkill = ['continue', 'review', 'recommended', 'available']
    .map((state) => skills.find((skill) => skill.state === state))
    .find(Boolean);

  return Object.freeze({
    title: 'Практика',
    description: 'Выберите навык для дополнительной работы. Незавершённые задания останутся на месте.',
    skills: Object.freeze(skills),
    nextAction: nextSkill ? Object.freeze({
      skillId: nextSkill.id,
      label: nextSkill.action.label,
      screenId: nextSkill.action.screenId,
      title: nextSkill.label,
      reason: nextSkill.reason,
      outcome: nextSkill.outcome,
      availability: nextSkill.availability,
      availabilityLabel: nextSkill.availabilityLabel,
      disabled: nextSkill.availability === 'cache-required',
    }) : null,
  });
}

export { PRACTICE_SKILLS };
