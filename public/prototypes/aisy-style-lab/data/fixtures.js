const deepFreeze = (value) => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
};

export const DIRECTIONS = deepFreeze([
  { id: 'a', label: 'A', name: 'Бумажный маршрут', signature: 'paper-layers', decisionHint: 'Ближе всего к onboarding' },
  { id: 'b', label: 'B', name: 'Тактильные виджеты', signature: 'tactile-press', decisionHint: 'Самый предметный и игровой' },
  { id: 'c', label: 'C', name: 'Сюжетный маршрут', signature: 'route-draw', decisionHint: 'Самый эмоциональный путь' },
]);

export const BORROWINGS = deepFreeze([
  { id: 'a-route-map', direction: 'a', label: 'Карта на бумаге', detail: 'Сложенный маршрут внутри Today' },
  { id: 'a-paper-transition', direction: 'a', label: 'Смена листов', detail: 'Мягкий переход между шагами' },
  { id: 'b-tactile-controls', direction: 'b', label: 'Тактильные контролы', detail: 'Физичное нажатие и выбор' },
  { id: 'b-seat-release', direction: 'b', label: 'Seat / release', detail: 'Короткий отклик перед переходом' },
  { id: 'c-story-landmarks', direction: 'c', label: 'Ориентиры пути', detail: 'Флаг, задача, разбор и цель' },
  { id: 'c-route-draw', direction: 'c', label: 'Прорисовка маршрута', detail: 'Продвижение к следующему шагу' },
]);

export const FLOW_SCREENS = deepFreeze([
  { id: 'today', label: 'Сегодня', step: 1 },
  { id: 'task', label: 'Задание', step: 2 },
  { id: 'review', label: 'Разбор', step: 3 },
  { id: 'progress', label: 'Прогресс', step: 4 },
]);

export const NAV_ITEMS = deepFreeze([
  { id: 'today', label: 'Сегодня', icon: 'sun' },
  { id: 'practice', label: 'Практика', icon: 'cards' },
  { id: 'ege', label: 'ЕГЭ', icon: 'target' },
  { id: 'progress', label: 'Прогресс', icon: 'chart' },
  { id: 'profile', label: 'Профиль', icon: 'person' },
]);

export const LAB_FIXTURE = deepFreeze({
  meta: {
    id: 'grammar-route-01',
    product: 'Aisy ЕГЭ — Английский',
    learner: 'Саша',
    dateLabel: 'Вторник, 25 августа',
    egeCountdownDays: 281,
  },
  today: {
    state: 'ready',
    eyebrow: 'Личный маршрут · день 12',
    title: 'Закрепим условные предложения',
    reason: 'Вчера в заданиях 19–25 эта тема дала 2 ошибки подряд.',
    durationOptions: [10, 20, 30, 40],
    duration: 20,
    durationEstimates: {
      10: { warmup: 2, grammar: 6, recap: 2 },
      20: { warmup: 3, grammar: 12, recap: 5 },
      30: { warmup: 5, grammar: 18, recap: 7 },
      40: { warmup: 6, grammar: 24, recap: 10 },
    },
    completedMinutes: 0,
    blocks: [
      { id: 'warmup', label: 'Разминка', detail: '3 минуты', state: 'ready' },
      { id: 'grammar', label: 'Грамматика ЕГЭ', detail: '12 минут', state: 'recommended' },
      { id: 'recap', label: 'Разбор', detail: '5 минут', state: 'locked' },
    ],
    cta: { label: 'Начать маршрут', target: 'task' },
    resumeCta: { label: 'Продолжить · 8 минут', target: 'task' },
    rhythm: { completedDays: 3, goalDays: 5, label: '3 из 5 дней на этой неделе' },
  },
  task: {
    state: 'answering',
    section: 'Грамматика · задание 19',
    progressLabel: '2 из 6',
    progress: 0.333,
    promptLead: 'Choose the correct form',
    sentenceBefore: 'If Kate ',
    gap: '____',
    sentenceAfter: ' earlier, she would have caught the train.',
    options: [
      { id: 'a', label: 'left' },
      { id: 'b', label: 'had left' },
      { id: 'c', label: 'would leave' },
      { id: 'd', label: 'has left' },
    ],
    selectedOptionId: 'c',
    correctOptionId: 'b',
    cta: { label: 'Проверить ответ', target: 'review' },
    assistance: { used: false, label: 'Без подсказки' },
  },
  review: {
    state: 'incorrect',
    eyebrow: 'Ответ разобран',
    title: 'Нужен Past Perfect',
    resultLabel: 'Пока неточно',
    selectedAnswer: 'would leave',
    correctAnswer: 'had left',
    explanation: 'В условном предложении третьего типа после if ставим Past Perfect: had + V3.',
    reusableRule: 'If + had done, … would have done',
    example: 'If Kate had left earlier, she would have caught the train.',
    evidence: { kind: 'independent', label: 'Самостоятельная попытка', masteryDelta: 3 },
    cta: { label: 'Продолжить', target: 'progress' },
  },
  progress: {
    state: 'updated',
    eyebrow: 'Маршрут обновлён',
    title: 'Ты нашёл слабое место',
    scoreLabel: '+3 к точности',
    before: 62,
    after: 65,
    skill: 'Условные предложения',
    improvement: 'Правило уже распознаёшь; нужно закрепить форму had + V3.',
    next: 'Ещё 4 коротких примера завтра',
    week: { completedDays: 4, goalDays: 5, minutes: 76 },
    cta: { label: 'Вернуться в Сегодня', target: 'today' },
  },
  states: {
    ready: { id: 'ready', label: 'Маршрут готов', tone: 'success' },
    resume: { id: 'resume', label: 'Есть незавершённый маршрут', tone: 'info' },
    diagnostic: { id: 'diagnostic', label: 'Рекомендуем диагностику 10–15 минут', tone: 'info' },
    loading: { id: 'loading', label: 'Собираем маршрут…', tone: 'neutral' },
    offline: { id: 'offline', label: 'Офлайн: доступна сохранённая практика', tone: 'warning' },
    error: { id: 'error', label: 'Не удалось обновить маршрут', tone: 'error', action: 'Повторить' },
    access: { id: 'access', label: 'Маршрут доступен в Premium', tone: 'warning', action: 'Подробнее' },
  },
  gallery: {
    buttonStates: ['default', 'pressed', 'focus', 'loading', 'disabled'],
    choiceStates: ['default', 'selected', 'correct', 'incorrect', 'disabled'],
    alertStates: ['info', 'success', 'warning', 'error'],
    cardStates: ['ready', 'resume', 'loading', 'offline', 'error'],
  },
});

const validDirectionIds = new Set(DIRECTIONS.map(({ id }) => id));
const validBorrowingIds = new Set(BORROWINGS.map(({ id }) => id));
const validScreenIds = new Set(FLOW_SCREENS.map(({ id }) => id));
const validFixtureStates = new Set(Object.keys(LAB_FIXTURE.states));

export function normalizeDecisionState(input = {}) {
  const base = validDirectionIds.has(input.base) ? input.base : '';
  if (!base) return { base: '', borrowings: [] };
  const borrowings = [...new Set(Array.isArray(input.borrowings) ? input.borrowings : [])]
    .filter((id) => validBorrowingIds.has(id))
    .filter((id) => BORROWINGS.find((item) => item.id === id)?.direction !== base)
    .slice(0, 2);
  return { base, borrowings };
}

export function normalizeLabState(input = {}) {
  return {
    direction: validDirectionIds.has(input.direction) ? input.direction : 'a',
    screen: validScreenIds.has(input.screen) ? input.screen : 'today',
    fixtureState: validFixtureStates.has(input.fixtureState) ? input.fixtureState : 'ready',
  };
}

export function projectScreen(input = {}) {
  const state = normalizeLabState(input);
  const screen = LAB_FIXTURE[state.screen];
  const status = LAB_FIXTURE.states[state.fixtureState];
  return deepFreeze({
    ...state,
    directionMeta: DIRECTIONS.find(({ id }) => id === state.direction),
    flowMeta: FLOW_SCREENS.find(({ id }) => id === state.screen),
    meta: LAB_FIXTURE.meta,
    navigation: NAV_ITEMS,
    content: screen,
    status,
  });
}

export function stateFromSearch(search = '') {
  const params = new URLSearchParams(search);
  return normalizeLabState({
    direction: params.get('direction'),
    screen: params.get('screen'),
    fixtureState: params.get('state'),
  });
}

export function searchFromState(input = {}) {
  const state = normalizeLabState(input);
  return `?direction=${state.direction}&screen=${state.screen}&state=${state.fixtureState}`;
}
