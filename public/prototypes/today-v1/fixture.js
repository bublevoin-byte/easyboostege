/* Representative read-only state shaped like the production Today projection. */
export const TODAY_FIXTURE = Object.freeze({
  greeting: 'Здравствуйте, Лера',
  context: 'пятница, 21 августа',
  duration: Object.freeze({
    choices: Object.freeze([10, 20, 30, 40]),
    selected: 30,
    help: 'План занятия на 30 минут.',
  }),
  recommendation: Object.freeze({
    title: 'Аудирование в фокусе',
    reason: 'Этот навык пора повторить.',
    estimatedMinutes: 30,
    ctaLabel: 'Начать занятие',
    outcome: 'После завершения результаты обновят план и его следующий фокус.',
  }),
  rhythm: Object.freeze({
    streakDays: 5,
    weeklyTargetMinutes: 160,
    days: Object.freeze([
      Object.freeze({ label: 'Пн', status: 'complete' }),
      Object.freeze({ label: 'Вт', status: 'complete' }),
      Object.freeze({ label: 'Ср', status: 'complete' }),
      Object.freeze({ label: 'Чт', status: 'complete' }),
      Object.freeze({ label: 'Пт', status: 'today', minutes: 18 }),
      Object.freeze({ label: 'Сб', status: 'future' }),
      Object.freeze({ label: 'Вс', status: 'future' }),
    ]),
  }),
  countdown: Object.freeze({
    days: 291,
  }),
  evidence: Object.freeze({
    label: 'Самостоятельные данные учтены',
    detail: 'Рекомендация опирается на учебный ритм и результаты практики, а не на случайный выбор.',
  }),
  /* Static educational context for the concept, not a product API field. */
  studyContext: Object.freeze({
    label: 'Подсказка Аси',
    title: 'Слушайте связки, а не отдельные слова',
    copy: 'В быстрой речи знакомые слова сливаются. Сначала отметьте смысл фразы, затем возвращайтесь к деталям.',
  }),
});
