const RECENT_WRITING_LIMIT = 30;
const WRITING_AVERAGE_WINDOW = 5;

function timestamp(value) {
  const result = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(result) ? result : 0;
}

function writingAttemptProgressEntryAt(attempt, observedAt) {
  const attemptId = Number(attempt?.id);
  const got = Number(attempt?.review?.overall_got);
  const max = Number(attempt?.review?.overall_max);
  if (attempt?.status !== 'completed' || !Number.isSafeInteger(attemptId) || attemptId < 1
    || !Number.isInteger(got) || !Number.isInteger(max) || got < 0 || max < 1 || got > max) return null;
  const task = attempt.task_type === 'writing_37' ? 37 : attempt.task_type === 'writing_38' ? 38 : null;
  if (!task || max !== (task === 37 ? 6 : 14)) return null;
  const words = Number(attempt.review?.words);
  return {
    attemptId,
    t: task,
    taskId: attempt.source_task_ref || null,
    g: got,
    m: max,
    n: Number.isSafeInteger(words) && words >= 0 ? words : 0,
    ts: timestamp(observedAt),
  };
}

export function writingAttemptProgressEntry(attempt) {
  return writingAttemptProgressEntryAt(attempt, attempt?.evaluated_at || attempt?.created_at);
}

/* The confirmation travels with an exact idempotent replay. Its timestamp must not change between
 * the initial response and later reads after the repository has attached evaluated_at. */
export function writingAttemptProgressConfirmation(attempt) {
  return writingAttemptProgressEntryAt(attempt, attempt?.created_at);
}

export function writingProgressSummary(attempts) {
  const works = (attempts || []).map(writingAttemptProgressEntry).filter(Boolean)
    .sort((left, right) => left.ts - right.ts || left.attemptId - right.attemptId);
  const recent = works.slice(-RECENT_WRITING_LIMIT);
  const averageWindow = works.slice(-WRITING_AVERAGE_WINDOW);
  const average = averageWindow.length
    ? Math.round(averageWindow.reduce((total, work) => total + work.g / work.m, 0)
      / averageWindow.length * 100)
    : 0;
  return Object.freeze({
    version: 'writing-progress-v1',
    attemptCount: works.length,
    average,
    works: recent,
  });
}

export function withoutClientWritingProgress(progress) {
  const accepted = structuredClone(progress || {});
  delete accepted.works;
  delete accepted.essays;
  delete accepted.writingAttemptIds;
  if (accepted.prog && typeof accepted.prog === 'object' && !Array.isArray(accepted.prog)) {
    accepted.prog = { ...accepted.prog };
    delete accepted.prog.write;
    if (!Object.keys(accepted.prog).length) delete accepted.prog;
  }
  return accepted;
}
