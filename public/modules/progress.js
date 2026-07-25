(function initializeProgressModule(global) {
  'use strict';

  const EXAM_DATE = '2027-06-01';
  const DAY_MS = 86400000;
  const DAILY_GOAL_MINUTES = 30;
  const WORD_TARGET = 500;
  const MODULES = ['words', 'gram', 'read', 'listen', 'write', 'speak'];

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

  global.EasyBoostProgress = Object.freeze({
    daysLeft,
    percent,
    dailyGoal,
    values,
    learnedLabel,
    streakLabel,
    overview,
    EXAM_DATE,
    MODULES,
    DAILY_GOAL_MINUTES,
    WORD_TARGET,
  });
})(window);
