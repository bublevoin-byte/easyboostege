const EGE_SECTION_PRACTICE = Object.freeze([
  Object.freeze({ id: 'listening', label: 'Аудирование', range: 'Задания 1–9', screenId: 'scr4', start: 'lExam', icon: 'headphones' }),
  Object.freeze({ id: 'reading', label: 'Чтение', range: 'Задания 10–18', screenId: 'scr7', start: 'rExam', icon: 'reading' }),
  Object.freeze({ id: 'grammar', label: 'Грамматика и лексика', range: 'Задания 19–24', screenId: 'scr3', start: 'gExam', icon: 'grammar' }),
  Object.freeze({ id: 'writing', label: 'Письмо', range: 'Задания 37–38', screenId: 'scr8', start: null, icon: 'pen' }),
  Object.freeze({ id: 'speaking', label: 'Говорение', range: 'Задания 39–42', screenId: 'scr9', start: 'spExam', icon: 'microphone' }),
]);

function validAttemptId(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function scoreForHistory(attempt) {
  const score = attempt?.result?.score;
  const total = Number(score?.primaryTotal);
  if (Number.isInteger(total) && total >= 0 && total <= 82) return `${total} из 82`;
  const minimum = Number(score?.range?.minimum);
  const maximum = Number(score?.range?.maximum);
  if (Number.isInteger(minimum) && Number.isInteger(maximum)
    && minimum >= 0 && maximum >= minimum && maximum <= 82) return `${minimum}–${maximum} из 82`;
  return 'Оценка ещё не готова';
}

function historyEntries(history) {
  if (!Array.isArray(history?.attempts)) return [];
  return history.attempts.filter((attempt) => validAttemptId(attempt?.id)).map((attempt) => Object.freeze({
    attemptId: attempt.id,
    label: typeof attempt.label === 'string' && attempt.label.trim()
      ? attempt.label : 'Пробный вариант',
    completedAt: typeof attempt.completedAt === 'string' ? attempt.completedAt : null,
    score: scoreForHistory(attempt),
    baseline: attempt.id === history.baselineAttemptId || attempt.isBaseline === true,
  }));
}

function projectEgeHub(input = {}) {
  const online = input.online !== false;
  const currentAttempt = validAttemptId(input.currentAttempt?.id) ? input.currentAttempt : null;
  const localContinuation = validAttemptId(input.localContinuation?.attemptId)
    ? input.localContinuation : null;
  const resumable = currentAttempt || localContinuation;
  const history = historyEntries(input.history);
  const latest = history[0] || null;

  return Object.freeze({
    title: 'ЕГЭ',
    description: 'Тренируйте разделы отдельно или проходите полный пробник в строгом режиме.',
    network: Object.freeze({
      online,
      label: online
        ? ''
        : resumable
          ? 'Нет сети. Сохранённую попытку можно открыть; её серверный таймер продолжает идти.'
          : 'Нет сети. Новый пробник требует подключения для проверки формы и запуска серверного таймера.',
    }),
    current: resumable ? Object.freeze({
      attemptId: resumable.id || resumable.attemptId,
      state: currentAttempt?.state || localContinuation?.phase || 'local',
      title: 'Незавершённый пробник',
      description: 'Продолжите с сохранённого места. Перезагрузка и отсутствие сети не ставят таймер на паузу.',
      action: Object.freeze({ kind: 'continue', label: 'Продолжить пробник', attemptId: resumable.id || resumable.attemptId, disabled: false }),
    }) : null,
    fullMock: Object.freeze({
      title: 'Полный пробный вариант',
      description: '38 письменных заданий за 190 минут и отдельная устная часть на 17 минут. До старта приложение проверит точную форму и аудио; таймер начнётся только после явного подтверждения.',
      rationale: 'Полный пробник подойдёт, если хотите проверить весь маршрут в условиях, близких к экзамену. Для короткой работы выберите раздел ниже.',
      assessment: 'Объективные задания проверяются точно. Письмо и говорение получают экспериментальную приблизительную оценку, а не официальный результат ЕГЭ.',
      action: Object.freeze({
        kind: 'start', label: 'Открыть подготовку к пробнику',
        disabled: Boolean(resumable) || !online,
        reason: resumable ? 'Сначала завершите текущую попытку.'
          : online ? '' : 'Подключитесь к интернету, чтобы начать новый пробник.',
      }),
    }),
    latestResult: latest ? Object.freeze({
      ...latest,
      title: 'Последний результат',
      action: Object.freeze({ kind: 'result', label: 'Открыть результат', attemptId: latest.attemptId, disabled: !online }),
    }) : null,
    history: Object.freeze(history),
    sections: EGE_SECTION_PRACTICE,
  });
}

export { EGE_SECTION_PRACTICE, projectEgeHub };
