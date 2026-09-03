const timestamp = (value) => {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
};

const withoutImmediateRepeat = (candidates, lastTaskId) => (
  lastTaskId ? candidates.filter((candidate) => candidate.task.id !== lastTaskId) : candidates
);

const byOldest = (first, second) => (
  first.lastAssignedAt - second.lastAssignedAt || first.task.id.localeCompare(second.task.id, 'en')
);

export function selectSpeakingTrainingAssignment(tasks, sessions, now = new Date(), {
  excludeTaskIds = [], preferredTaskIds = [], selectionReason = null, targetedPractice = null,
} = {}) {
  const instant = new Date(now).getTime();
  if (!Number.isFinite(instant) || !Array.isArray(tasks) || !tasks.length) {
    throw new Error('SPEAKING_SELECTION_INVALID');
  }
  const orderedHistory = [...(sessions || [])]
    .sort((left, right) => timestamp(left.assigned_at) - timestamp(right.assigned_at));
  const latestByTask = new Map();
  orderedHistory.forEach((session) => latestByTask.set(session.task_id, session));
  const lastTaskId = orderedHistory.at(-1)?.task_id || null;
  const excluded = new Set(excludeTaskIds.map(String));
  const preferred = new Set(preferredTaskIds.map(String));
  const candidates = tasks.filter((task) => !excluded.has(String(task.id))
    && (!preferred.size || preferred.has(String(task.id)))).map((task) => {
    const latest = latestByTask.get(task.id) || null;
    return { task, latest, lastAssignedAt: timestamp(latest?.assigned_at) };
  });
  const hasImmediateRepeatAlternative = candidates.some((candidate) => candidate.task.id !== lastTaskId);
  const buckets = [
    ['unseen', candidates.filter((candidate) => !candidate.latest)],
    ['due', candidates.filter((candidate) => candidate.latest?.status === 'completed'
      && timestamp(candidate.latest.due_at) > 0 && timestamp(candidate.latest.due_at) <= instant)],
    ['weak', candidates.filter((candidate) => candidate.latest?.status === 'completed'
      && candidate.latest.self_rating === 'weak')],
    ['old', candidates.filter((candidate) => candidate.latest)],
  ];
  for (const [reason, bucket] of buckets) {
    if (!bucket.length) continue;
    const sorted = bucket.sort(byOldest);
    const eligible = hasImmediateRepeatAlternative ? withoutImmediateRepeat(sorted, lastTaskId) : sorted;
    if (eligible.length) return {
      task: eligible[0].task,
      reason: selectionReason || reason,
      targetedPractice: targetedPractice ? structuredClone(targetedPractice) : null,
    };
  }
  throw new Error('SPEAKING_SELECTION_EMPTY');
}
