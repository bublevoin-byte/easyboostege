(function initializeProgressModule(global) {
  'use strict';

  const EXAM_DATE = '2027-06-01';
  const DAY_MS = 86400000;
  const DAILY_GOAL_MINUTES = 30;
  const WORD_TARGET = 500;
  const MODULES = ['words', 'gram', 'read', 'listen', 'write', 'speak'];
  const EVIDENCE_MODULE_LABELS = Object.freeze({
    vocabulary: 'Лексика',
    grammar: 'Грамматика',
    reading: 'Чтение',
    listening: 'Аудирование',
    writing: 'Письмо',
    speaking: 'Говорение',
  });
  const EVIDENCE_MODULES = Object.freeze(Object.entries(EVIDENCE_MODULE_LABELS).map(([id, label]) => (
    Object.freeze({ id, label })
  )));

  function daysLeft(now, examDate) {
    const exam = new Date(examDate || EXAM_DATE).getTime();
    const from = Number(now) || 0;
    return Math.max(0, Math.round((exam - from) / DAY_MS));
  }

  function percent(value, total) {
    if (!total) return 0;
    return Math.max(0, Math.min(100, Math.round((Number(value) || 0) / total * 100)));
  }

  function dailyGoal(minutes, goal) {
    const target = Number(goal) || DAILY_GOAL_MINUTES;
    const spent = Math.max(0, Number(minutes) || 0);
    return { minutes: spent, goal: target, percent: percent(spent, target) };
  }

  function values(progress) {
    const source = progress || {};
    const result = {};
    MODULES.forEach((name) => {
      result[name] = Math.max(0, Math.min(100, Math.round(Number(source[name]) || 0)));
    });
    return result;
  }

  function learnedLabel(learned, target) {
    return 'учу · ' + Math.max(0, Number(learned) || 0) + ' / ' + (Number(target) || WORD_TARGET);
  }

  function streakLabel(streak, withSuffix) {
    const days = Math.max(0, Number(streak) || 0);
    return '🔥 ' + days + (withSuffix ? ' дней подряд' : '');
  }

  function overview(state, now) {
    const value = state && typeof state === 'object' ? state : {};
    return {
      streak: Math.max(0, Number(value.streak) || 0),
      learned: Math.max(0, Number(value.learned) || 0),
      daily: dailyGoal(value.dayMin),
      modules: values(value.prog),
      daysLeft: daysLeft(now),
    };
  }

  function boundedPercent(value) {
    return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  }

  function evidenceSummary(profile) {
    const source = Array.isArray(profile && profile.modules) ? profile.modules : [];
    const byId = new Map(source.map((module) => [module && module.id, module]));
    return EVIDENCE_MODULES.map(({ id, label }) => {
      const module = byId.get(id) || {};
      const evidenceCount = Math.max(0, Math.floor(Number(module.evidenceCount) || 0));
      if (!evidenceCount) {
        return {
          id, label, state: 'unobserved', stateLabel: 'Недостаточно занятий для оценки',
          mastery: null, confidence: null, uncertainty: null, evidenceCount: 0,
        };
      }
      const uncertainty = boundedPercent(module.uncertainty);
      const established = module.status === 'established';
      return {
        id, label, state: established ? 'established' : 'preliminary',
        stateLabel: established ? 'Оценка подтверждена' : 'Предварительная оценка',
        mastery: boundedPercent(module.mastery),
        confidence: 100 - uncertainty,
        uncertainty,
        evidenceCount,
      };
    });
  }

  function recoveryOverview(payload) {
    const value = payload && typeof payload === 'object' ? payload : {};
    const summary = value.summary && typeof value.summary === 'object' ? value.summary : {};
    const metric = value.error_recovery_rate && typeof value.error_recovery_rate === 'object' ? value.error_recovery_rate : {};
    const voice = value.voice_minutes && typeof value.voice_minutes === 'object' ? value.voice_minutes : {};
    const due = Array.isArray(value.due_repeats) ? value.due_repeats.length : 0;
    const numerator = Math.max(0, Number(metric.numerator) || 0);
    const denominator = Math.max(0, Number(metric.denominator) || 0);
    const used = Math.max(0, Number(voice.used_monthly) || 0);
    const remaining = Math.max(0, Number(voice.remaining_monthly) || 0);
    const monthlyLimit = Math.round((used + remaining) * 100) / 100;
    const potential = Math.max(0, Number(summary.potential_ege_points) || 0);
    return {
      counts: {
        open: Math.max(0, Number(summary.open) || 0),
        recovered: Math.max(0, Number(summary.recovered) || 0),
        relapsed: Math.max(0, Number(summary.relapsed) || 0),
      },
      rateLabel: denominator ? Math.round(numerator / denominator * 100) + '% подтверждено' : 'Пока нет проверенных переносов',
      voiceLabel: (Number.isInteger(used) ? used : used.toFixed(1)) + ' из ' + (Number.isInteger(monthlyLimit) ? monthlyLimit : monthlyLimit.toFixed(1)) + ' мин использовано',
      dueLabel: due + (due === 1 ? ' повтор готов' : ' повторов готово'),
      potentialLabel: 'до ' + potential + ' учебных баллов потенциала*',
      notice: value.potential_points_notice || 'Оценка Aisy.space — не официальный балл ЕГЭ.',
      nextBest: value.next_best_review || null,
    };
  }

  function safeCount(value) {
    return Math.max(0, Math.floor(Number(value) || 0));
  }

  function outcomeChange(profile, previousProfile) {
    const previous = previousProfile && typeof previousProfile === 'object' ? previousProfile : null;
    const currentFingerprint = typeof profile.evidenceFingerprint === 'string'
      ? profile.evidenceFingerprint : '';
    const previousFingerprint = typeof previous?.evidenceFingerprint === 'string'
      ? previous.evidenceFingerprint : '';
    const noBaseline = {
      comparable: false,
      direction: 'none',
      text: 'Сравнение появится после второй сопоставимой самостоятельной попытки.',
      detail: 'Пока показываем текущий подтверждённый срез без заявления о росте.',
    };
    if (!previous || !currentFingerprint || !previousFingerprint
      || currentFingerprint === previousFingerprint
      || safeCount(profile.independentEvidenceCount) <= safeCount(previous.independentEvidenceCount)
      || safeCount(previous.independentEvidenceCount) === 0) return noBaseline;

    const previousById = new Map((Array.isArray(previous.modules) ? previous.modules : [])
      .filter((module) => module && safeCount(module.independentEvidenceCount) > 0)
      .map((module) => [module.id, module]));
    const comparisons = (Array.isArray(profile.modules) ? profile.modules : [])
      .filter((module) => module && previousById.has(module.id)
        && safeCount(module.independentEvidenceCount)
          > safeCount(previousById.get(module.id).independentEvidenceCount))
      .map((module) => {
        const before = previousById.get(module.id);
        const previousMastery = boundedPercent(before.mastery);
        const currentMastery = boundedPercent(module.mastery);
        return {
          id: module.id,
          label: EVIDENCE_MODULE_LABELS[module.id] || 'Навык',
          previousMastery,
          currentMastery,
          delta: currentMastery - previousMastery,
          evidenceCount: safeCount(module.independentEvidenceCount),
        };
      });
    if (!comparisons.length) return noBaseline;
    comparisons.sort((first, second) => {
      return Math.abs(second.delta) - Math.abs(first.delta)
        || second.evidenceCount - first.evidenceCount;
    });
    const selected = comparisons[0];
    const sign = selected.delta > 0 ? '+' : '';
    return {
      comparable: true,
      direction: selected.delta > 0 ? 'up' : selected.delta < 0 ? 'down' : 'steady',
      text: selected.label + ': ' + sign + selected.delta + ' п. п.',
      detail: 'Освоение ' + selected.previousMastery + '% → ' + selected.currentMastery
        + '% по двум сопоставимым сохранённым срезам.',
    };
  }

  function narrative(payload, { previousProfile = null } = {}) {
    const value = payload && typeof payload === 'object' ? payload : {};
    const profile = value.profile && typeof value.profile === 'object' ? value.profile : {};
    const modules = (Array.isArray(profile.modules) ? profile.modules : [])
      .filter((module) => module && safeCount(module.evidenceCount) > 0)
      .map((module) => ({
        id: module.id,
        label: EVIDENCE_MODULE_LABELS[module.id] || 'Навык',
        mastery: boundedPercent(module.mastery),
        uncertainty: boundedPercent(module.uncertainty),
        established: module.status === 'established',
        independentEvidenceCount: safeCount(module.independentEvidenceCount),
      }));
    const weakest = modules.slice().sort((first, second) => (
      first.mastery - second.mastery || second.uncertainty - first.uncertainty
    ))[0] || null;
    const retention = value.retention && typeof value.retention === 'object' ? value.retention : {};
    const review = retention.next_best_review || retention.nextBestReview || null;
    let next;
    if (profile.needsDiagnostic) {
      next = {
        kind: 'diagnostic', title: 'Уточнить учебный профиль',
        text: 'Короткая диагностика сделает следующий маршрут точнее.',
        actionLabel: 'Открыть диагностику',
      };
    } else if (review && review.skill_label) {
      next = {
        kind: 'review', title: 'Повторить ' + String(review.skill_label).slice(0, 80),
        text: 'Проверим, сохранился ли навык после предыдущей работы.',
        actionLabel: 'Открыть повтор',
      };
    } else if (weakest) {
      next = {
        kind: 'practice', title: 'Потренировать: ' + weakest.label,
        text: weakest.independentEvidenceCount > 0
          ? 'Здесь сейчас меньше всего подтверждённых самостоятельных результатов.'
          : 'Самостоятельных подтверждений пока нет; самостоятельная практика уточнит слабое место.',
        actionLabel: 'Открыть Практику',
      };
    } else {
      next = {
        kind: 'practice', title: 'Начать первое занятие',
        text: 'После самостоятельной работы здесь появятся подтверждённые изменения.',
        actionLabel: 'Открыть Практику',
      };
    }
    const change = outcomeChange(profile, previousProfile);
    return {
      next,
      change,
      improved: { title: 'Изменение результата', text: change.text },
      needsWork: weakest ? {
        title: 'Что требует внимания',
        text: weakest.label + ': текущая оценка ' + weakest.mastery
          + '% и остаётся ' + (weakest.independentEvidenceCount === 0
            ? 'оценкой без самостоятельного подтверждения.'
            : weakest.established ? 'подтверждённой.' : 'предварительной.'),
      } : {
        title: 'Что требует внимания',
        text: 'Сначала соберём самостоятельные результаты по учебным разделам.',
      },
      evidence: [
        {
          id: 'independent', label: 'Самостоятельно',
          count: safeCount(profile.independentEvidenceCount),
          detail: 'Может подтверждать владение навыком.',
        },
        {
          id: 'assisted', label: 'С помощью',
          count: safeCount(profile.assistedEvidenceCount),
          detail: 'Подсказки и помощь не подтверждают самостоятельное владение.',
        },
        {
          id: 'approximate', label: 'Ориентировочно',
          count: safeCount(profile.clientReportedEvidenceCount),
          detail: 'Автоматическая или ИИ-оценка, если используется, экспериментальна и не является официальным результатом ЕГЭ.',
        },
      ],
    };
  }

  global.EasyBoostProgress = Object.freeze({
    daysLeft,
    percent,
    dailyGoal,
    values,
    learnedLabel,
    streakLabel,
    overview,
    evidenceSummary,
    recoveryOverview,
    narrative,
    EXAM_DATE,
    MODULES,
    EVIDENCE_MODULE_LABELS,
    EVIDENCE_MODULES,
    DAILY_GOAL_MINUTES,
    WORD_TARGET,
  });
})(window);
