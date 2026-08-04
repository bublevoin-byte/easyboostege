function value(record, camel, snake) {
  return record?.[camel] ?? record?.[snake];
}

function exactIso(valueToCheck) {
  const parsed = new Date(valueToCheck);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

export function adaptiveRepeatExecutionMatches({
  username,
  block,
  repeat,
  recovery,
  attempt,
  claimIssuedAt,
}) {
  const launch = block?.launch;
  const repeatId = String(repeat?.id || '');
  const repeatTaskId = String(value(repeat, 'taskId', 'task_id') || '');
  const repeatDueAt = exactIso(value(repeat, 'dueAt', 'due_at'));
  const repeatWindowEndsAt = exactIso(value(repeat, 'windowEndsAt', 'window_ends_at'));
  const attemptRepeatId = String(value(attempt, 'repeatId', 'repeat_id') || '');
  const attemptTaskId = String(value(attempt, 'taskId', 'task_id') || '');
  const attemptObservedAt = new Date(value(attempt, 'observedAt', 'observed_at')).getTime();
  const issuedAt = new Date(claimIssuedAt).getTime();
  return Boolean(
    username
    && block?.kind === 'learning'
    && block.activityId === 'voice_tutor_recovery'
    && launch?.kind === 'voice_tutor_recovery'
    && String(launch.repeatId || '') === repeatId
    && String(launch.taskId || '') === repeatTaskId
    && launch.stage === repeat?.stage
    && launch.dueAt === repeatDueAt
    && launch.windowEndsAt === repeatWindowEndsAt
    && String(repeat?.recovery_id || '') === String(recovery?.id || '')
    && recovery?.username === username
    && block.skillId === recovery?.skill_id
    && block.module === recovery?.module
    && attemptRepeatId === repeatId
    && attemptTaskId === repeatTaskId
    && Number.isFinite(attemptObservedAt)
    && Number.isFinite(issuedAt)
    && attemptObservedAt >= issuedAt
  );
}
