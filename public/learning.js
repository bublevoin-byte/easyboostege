(function exposeLearning(root) {
  'use strict';

  const DAY_MS = 86_400_000;
  const SRS_INTERVAL_DAYS = Object.freeze([0, 1, 3, 7, 16, 35]);

  function normalizeRecord(record) {
    return {
      s: Math.max(0, Math.min(5, Number(record?.s) || 0)),
      e: Math.max(0, Number(record?.e) || 0),
      n: Math.max(0, Number(record?.n) || 0),
      due: Math.max(0, Number(record?.due) || 0),
    };
  }

  function reviewWord(record, correct, now = Date.now()) {
    const next = normalizeRecord(record);
    next.n += 1;
    if (correct) {
      next.s = Math.min(5, next.s + 1);
      next.due = now + SRS_INTERVAL_DAYS[next.s] * DAY_MS;
    } else {
      next.e += 1;
      next.s = Math.max(1, next.s - 2);
      next.due = now;
    }
    return next;
  }

  function calculateProgress(completed, total) {
    const safeTotal = Math.max(0, Number(total) || 0);
    if (!safeTotal) return 0;
    const safeCompleted = Math.max(0, Math.min(safeTotal, Number(completed) || 0));
    return Math.round(safeCompleted / safeTotal * 100);
  }

  root.EasyBoostLearning = Object.freeze({
    SRS_INTERVAL_DAYS,
    reviewWord,
    calculateProgress,
  });
})(globalThis);
