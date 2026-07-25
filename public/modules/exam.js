(function initializeExamModule(global) {
  'use strict';

  const DEFAULT_BADGES = { gold: 0.9, silver: 0.6 };

  function record(previous, score) {
    const before = previous && typeof previous === 'object' ? previous : { n: 0, last: 0, best: 0 };
    const value = Math.max(0, Number(score) || 0);
    return {
      n: (Number(before.n) || 0) + 1,
      last: value,
      best: Math.max(Number(before.best) || 0, value),
    };
  }

  function elapsedSeconds(startedAt, now) {
    const start = Number(startedAt) || 0;
    const end = Number(now) || 0;
    return Math.max(0, Math.floor((end - start) / 1000));
  }

  function sections(parts) {
    return (parts || []).map((part) => ({
      label: String(part[0]),
      correct: Math.max(0, Number(part[1]) || 0),
      total: Math.max(0, Number(part[2]) || 0),
    }));
  }

  function total(parts) {
    return sections(parts).reduce((sum, part) => sum + part.correct, 0);
  }

  function maxScore(parts) {
    return sections(parts).reduce((sum, part) => sum + part.total, 0);
  }

  function sectionLine(parts) {
    return sections(parts).map((part) => part.label + ' ' + part.correct + '/' + part.total).join(' · ');
  }

  function weakestSection(parts) {
    const list = sections(parts);
    if (!list.length) return null;
    return list.slice().sort((left, right) => (
      (left.total ? left.correct / left.total : 0) - (right.total ? right.correct / right.total : 0)
    ))[0];
  }

  function badge(score, max, thresholds) {
    const bounds = thresholds || DEFAULT_BADGES;
    const ratio = max ? (Number(score) || 0) / max : 0;
    if (ratio >= bounds.gold) return '🏆';
    if (ratio >= bounds.silver) return '💪';
    return '📚';
  }

  function attempt(id, details) {
    const value = details || {};
    return {
      id: String(id),
      module: String(value.module || 'exam'),
      activity: String(value.activity || ''),
      score: Math.max(0, Number(value.score) || 0),
      maxScore: Math.max(0, Number(value.maxScore) || 0),
      durationMs: Math.max(0, Number(value.durationMs) || 0),
      metadata: value.metadata || { source: 'builtin' },
    };
  }

  global.EasyBoostExam = Object.freeze({
    record,
    elapsedSeconds,
    sections,
    total,
    maxScore,
    sectionLine,
    weakestSection,
    badge,
    attempt,
    DEFAULT_BADGES,
  });
})(window);
