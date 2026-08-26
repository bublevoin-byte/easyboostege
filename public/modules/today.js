const TODAY_DURATIONS = Object.freeze([10, 20, 30, 40]);
const MIN_ADAPTIVE_DURATION = 15;
const MAX_ADAPTIVE_DURATION = 120;

function isAdaptiveDuration(value) {
  return Number.isInteger(value)
    && value >= MIN_ADAPTIVE_DURATION
    && value <= MAX_ADAPTIVE_DURATION
    && value % 5 === 0;
}

const MODULE_LABELS = Object.freeze({
  vocabulary: 'Слова',
  grammar: 'Грамматика',
  reading: 'Чтение',
  listening: 'Аудирование',
  writing: 'Письмо',
  speaking: 'Говорение',
  exam: 'ЕГЭ',
});

const REASON_LABELS = Object.freeze({
  high_uncertainty: 'здесь пока мало самостоятельных результатов',
  due_review: 'этот навык пора повторить',
  critical_retention_expiry: 'важно освежить навык до потери прогресса',
  target_gap: 'план видит здесь главный пробел до цели',
  high_ege_impact: 'этот навык сильно влияет на результат ЕГЭ',
  deadline_pressure: 'экзамен приближается',
  maintenance: 'план помогает не потерять уже освоенный навык',
});

const RECOVERY_STATES = Object.freeze({
  loading: {
    title: 'Собираем план на сегодня',
    message: 'Проверяем прогресс и незавершённые занятия.',
    recovery: { kind: 'retry', label: 'Повторить' },
  },
  empty: {
    title: 'План ещё не собран',
    message: 'Укажите цель ЕГЭ, дату и доступное время — после этого план соберёт первый маршрут.',
    recovery: { kind: 'open-plan', label: 'Настроить цель' },
  },
  offline: {
    title: 'Нет сети',
    message: 'Актуальный план сейчас не проверить. Короткая практика остаётся доступной.',
    recovery: { kind: 'quick-practice', label: 'Практика офлайн' },
  },
  access: {
    title: 'Доступ нужно обновить',
    message: 'План и новое занятие недоступны, пока доступ не будет подтверждён.',
    recovery: { kind: 'open-profile', label: 'Открыть профиль' },
  },
  error: {
    title: 'Не удалось загрузить план',
    message: 'Прогресс не потерян. Повторите загрузку или вернитесь позже.',
    recovery: { kind: 'retry', label: 'Повторить' },
  },
});

function selectedDuration(value, fallback) {
  if (value === 10 || isAdaptiveDuration(value)) return value;
  if (fallback === 10 || isAdaptiveDuration(fallback)) return fallback;
  return 20;
}

function durationChoices(selected) {
  return TODAY_DURATIONS.includes(selected)
    ? [...TODAY_DURATIONS]
    : [...TODAY_DURATIONS, selected].sort((left, right) => left - right);
}

function dateTimeFormat(locale, options, timeZone) {
  return new Intl.DateTimeFormat(locale, timeZone ? { ...options, timeZone } : options);
}

function calendarContext(now, timeZone) {
  const value = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  return dateTimeFormat('ru-RU', {
    weekday: 'long', day: 'numeric', month: 'long',
  }, timeZone).format(new Date(value));
}

function localCalendarDay(value, timeZone) {
  const parts = dateTimeFormat('en-CA', {
    year: 'numeric', month: '2-digit', day: '2-digit',
  }, timeZone).formatToParts(new Date(value));
  const read = (type) => Number(parts.find((part) => part.type === type)?.value);
  return { year: read('year'), month: read('month'), day: read('day') };
}

function countdown(goal, now, timeZone) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(String(goal?.examDate || ''));
  if (!match) return { days: null, label: 'Дата ЕГЭ пока не указана' };
  const today = localCalendarDay(Number(now || Date.now()), timeZone);
  const examDay = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const todayDay = Date.UTC(today.year, today.month - 1, today.day);
  const days = Math.round((examDay - todayDay) / 86_400_000);
  if (days < 0) return { days: null, label: 'Дата ЕГЭ прошла' };
  return { days, label: days === 0 ? 'ЕГЭ сегодня' : `До ЕГЭ — ${days} дн.` };
}

function diagnosticProjection(input) {
  const active = input.diagnostic?.diagnostic;
  const initialNeeded = input.overview?.profile?.needsDiagnostic === true;
  const refreshDue = input.overview?.retention?.rediagnostic?.due === true;
  if (input.source === 'offline' && (active || initialNeeded || refreshDue)) return {
    visible: true,
    state: 'offline',
    title: 'Диагностика доступна онлайн',
    copy: 'Сохранённая копия не подтверждает текущий статус. Подключитесь к сети, чтобы проверить диагностику.',
    action: null,
    blocksAdaptive: false,
  };
  if (active?.status === 'expired') return {
    visible: true,
    state: 'expired',
    title: 'Срок диагностики истёк',
    copy: 'Ответы из закрытой попытки не станут оценкой. Новую попытку можно начать, когда будет удобно.',
    action: { kind: 'open-diagnostic', label: 'Начать заново' },
    blocksAdaptive: initialNeeded,
  };
  if (active) return {
    visible: true,
    state: 'active',
    title: 'Диагностика начата',
    copy: 'Продолжите с того же места. План обновится только после завершения.',
    action: { kind: 'open-diagnostic', label: 'Продолжить диагностику' },
    blocksAdaptive: initialNeeded,
  };
  if (!initialNeeded && !refreshDue) return {
    visible: false, state: 'complete', action: null, blocksAdaptive: false,
  };
  if (input.diagnosticDeferred) return {
    visible: true,
    state: 'deferred',
    title: 'План пока предварительный',
    copy: 'Пропуск — это не оценка: маршрут будет уточняться по самостоятельным результатам.',
    action: { kind: 'open-diagnostic', label: 'Вернуться к диагностике' },
    blocksAdaptive: initialNeeded,
  };
  return {
    visible: true,
    state: 'recommended',
    title: 'Уточните маршрут',
    copy: 'Короткая диагностика даст плану больше самостоятельных данных. Её можно отложить.',
    action: { kind: 'open-diagnostic', label: 'Пройти диагностику' },
    blocksAdaptive: initialNeeded,
  };
}

function recommendationProjection(input, minutes, diagnostic) {
  const session = input.session;
  if (session && ['created', 'in_progress', 'planned', 'active', 'paused'].includes(session.status)) return {
    title: 'Продолжить текущее занятие',
    reason: 'Вы уже начали этот маршрут — прогресс и место в нём сохранены.',
    estimatedMinutes: session.durationMinutes || null,
    ctaLabel: 'Продолжить занятие',
    outcome: 'После следующего блока прогресс сохранится, а план покажет следующий шаг.',
    action: {
      kind: 'continue-adaptive-session', sessionId: session.id,
      adaptiveMinutes: session.durationMinutes || null,
    },
  };

  const provisional = diagnostic.blocksAdaptive === true;
  const adaptiveAvailable = input.overview?.access?.capabilities?.adaptivePlan !== false;
  const offline = input.source === 'offline';
  if (minutes === 10 || provisional || !adaptiveAvailable || offline) return {
    title: 'Быстрая практика слов',
    reason: offline
      ? 'Пока нет сети, доступна только локальная практика; сохранённый план не выдаём за актуальный.'
      : provisional
      ? 'План пока предварительный: завершённая практика даст ему честные данные.'
      : 'Короткое повторение поможет сохранить учебный ритм.',
    estimatedMinutes: minutes,
    ctaLabel: 'Начать практику',
    outcome: 'Результаты сохранятся и помогут плану уточнить следующий фокус.',
    action: { kind: 'quick-practice', adaptiveMinutes: null },
  };

  const allocations = input.overview?.plan?.allocation?.modules || [];
  const allocation = allocations.filter((candidate) => MODULE_LABELS[candidate?.id]
    && Number(candidate?.percentage) > 0).reduce(function(priority, candidate) {
    return !priority||Number(candidate?.percentage) > Number(priority?.percentage) ? candidate : priority;
  }, null);
  if (!allocation) return {
    title: 'Быстрая практика слов',
    reason: 'План пока не назвал следующий учебный блок, поэтому показываем нейтральную практику без догадок о составе занятия.',
    estimatedMinutes: minutes,
    ctaLabel: 'Начать практику',
    outcome: 'Результат сохранится и даст плану данные для следующей рекомендации.',
    action: { kind: 'quick-practice', adaptiveMinutes: null },
  };
  const moduleLabel = MODULE_LABELS[allocation.id];
  const reasonCode = allocation?.reasonCodes?.[0];
  return {
    title: `${moduleLabel} в фокусе`,
    reason: REASON_LABELS[reasonCode] || 'План выбрал следующий шаг по вашим самостоятельным результатам.',
    estimatedMinutes: minutes,
    ctaLabel: 'Начать занятие',
    outcome: 'После завершения результаты обновят план и его следующий фокус.',
    action: { kind: 'adaptive-session', adaptiveMinutes: minutes },
  };
}

function sessionRoute(input) {
  const blocks = Array.isArray(input.session?.blocks) ? input.session.blocks : [];
  if (!blocks.length) return null;
  const completed = new Set(Array.isArray(input.execution?.completedBlockIds)
    ? input.execution.completedBlockIds : []);
  const currentId = input.execution?.currentBlockId || input.session?.currentBlockId || null;
  const currentIndex = Math.max(0, blocks.findIndex((block) => block.id === currentId));
  const start = Math.min(Math.max(0, currentIndex - 1), Math.max(0, blocks.length - 3));
  const steps = blocks.slice(start, start + 3).map((block, index) => {
    const state = completed.has(block.id) ? 'complete' : block.id === currentId ? 'current' : 'next';
    const status = state === 'complete' ? 'готово' : state === 'current' ? 'сейчас' : 'дальше';
    const minutes = Number.isFinite(Number(block.plannedMinutes)) ? `${Number(block.plannedMinutes)} мин` : 'по плану';
    return {
      position: Number.isInteger(block.position) ? block.position : start + index + 1,
      label: block.kind === 'break'
        ? 'Перерыв'
        : String(block.activityLabel || MODULE_LABELS[block.module] || 'Учебный блок'),
      detail: `${minutes} · ${status}`,
      state,
    };
  });
  return {
    label: `Маршрут текущего занятия на ${input.session.durationMinutes || '—'} минут`,
    steps,
  };
}

function plannedRoute(input, minutes, recommendation) {
  const current = sessionRoute(input);
  if (current) return current;
  if (recommendation.action.kind === 'quick-practice') return {
    label: `Маршрут быстрой практики на ${recommendation.estimatedMinutes || minutes} минут`,
    steps: [
      { position: 1, label: 'Повторение слов', detail: `${recommendation.estimatedMinutes || minutes} мин · сейчас`, state: 'current' },
      { position: 2, label: 'Сохранение результата', detail: 'Ритм и план получат новые данные', state: 'next' },
    ],
  };
  const allocations = (input.overview?.plan?.allocation?.modules || [])
    .filter((item) => MODULE_LABELS[item?.id] && Number(item?.percentage) > 0)
    .slice()
    .sort((left, right) => Number(right.percentage) - Number(left.percentage))
    .slice(0, 2);
  const steps = allocations.map((item, index) => ({
    position: index + 1,
    label: MODULE_LABELS[item.id],
    detail: `${Number(item.percentage)}% недельного плана`,
    state: index === 0 ? 'current' : 'next',
  }));
  steps.push({
    position: steps.length + 1,
    label: 'Итог занятия',
    detail: 'Прогресс обновит следующий шаг',
    state: 'next',
  });
  return { label: `Ориентир по недельному плану на ${minutes} минут`, steps };
}

export function projectToday(input = {}) {
  let status = Object.hasOwn(RECOVERY_STATES, input.status) ? input.status : 'ready';
  const adaptiveAvailable = input.overview?.access?.capabilities?.adaptivePlan !== false;
  const missingPlan = input.source !== 'offline' && input.overview && !input.session && adaptiveAvailable
    && input.overview.profile?.needsDiagnostic !== true
    && (!input.overview.goal || !input.overview.plan);
  if (status === 'ready' && missingPlan) status = 'empty';
  const minutes = selectedDuration(
    input.selectedMinutes,
    input.preferences?.preferredSessionMinutes,
  );
  const isQuickPractice = minutes === 10;

  if (status !== 'ready') return {
    status,
    greeting: `Здравствуйте${input.displayName ? `, ${input.displayName}` : ''}`,
    context: calendarContext(input.now, input.timeZone),
    state: RECOVERY_STATES[status],
  };

  const diagnostic = diagnosticProjection(input);
  const recommendation = recommendationProjection(input, minutes, diagnostic);
  const hasCurrentSession = recommendation.action.kind === 'continue-adaptive-session';

  return {
    status,
    greeting: `Здравствуйте${input.displayName ? `, ${input.displayName}` : ''}`,
    context: calendarContext(input.now, input.timeZone),
    duration: {
      choices: durationChoices(minutes),
      selected: minutes,
      preferenceMinutes: isQuickPractice ? null : minutes,
      help: isQuickPractice
        ? hasCurrentSession
          ? '10 минут — отдельная быстрая практика; длительность текущего занятия не изменится.'
          : 'Быстрая практика на 10 минут не меняет обычную длительность занятия.'
        : hasCurrentSession
        ? `Выбор ${minutes} минут применится к следующему занятию.`
        : recommendation.action.kind === 'quick-practice'
        ? `${minutes} минут — ориентир для практики; она завершится по вашему действию.`
        : `План занятия на ${minutes} минут.`,
    },
    recommendation,
    route: plannedRoute(input, minutes, recommendation),
    diagnostic,
    rhythm: {
      todayMinutes: Math.max(0, Number(input.localProgress?.dayMin) || 0),
      streakDays: Math.max(0, Number(input.localProgress?.streak) || 0),
      weeklyTargetMinutes: Math.max(0, Number(input.overview?.goal?.weeklyMinutes) || 0),
    },
    countdown: countdown(input.overview?.goal, input.now, input.timeZone),
    source: input.source === 'offline' ? 'offline' : 'online',
  };
}
