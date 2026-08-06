import crypto from 'node:crypto';

const DAY_MS = 86_400_000;
const DUE_DAYS = Object.freeze({ weak: 1, steady: 7, strong: 14 });

function timestamp(value) {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function excludeImmediateRepeat(candidates, lastTaskId) {
  if (!lastTaskId) return candidates;
  return candidates.filter((candidate) => candidate.task.id !== lastTaskId);
}

function byOldest(first, second) {
  return first.lastAssignedAt - second.lastAssignedAt || first.task.id.localeCompare(second.task.id, 'en');
}

export function selectSpeakingTask1Assignment(tasks, sessions, now = new Date()) {
  const instant = new Date(now).getTime();
  if (!Number.isFinite(instant) || !Array.isArray(tasks) || !tasks.length) throw new Error('SPEAKING_TASK1_SELECTION_INVALID');
  const orderedHistory = [...(sessions || [])].sort((left, right) => timestamp(left.assigned_at) - timestamp(right.assigned_at));
  const latestByTask = new Map();
  orderedHistory.forEach((session) => latestByTask.set(session.task_id, session));
  const lastTaskId = orderedHistory.at(-1)?.task_id || null;
  const candidates = tasks.map((task) => {
    const latest = latestByTask.get(task.id) || null;
    return { task, latest, lastAssignedAt: timestamp(latest?.assigned_at) };
  });
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
    const eligible = excludeImmediateRepeat(bucket.sort(byOldest), lastTaskId);
    if (!eligible.length) continue;
    return { task: eligible[0].task, reason };
  }
  throw new Error('SPEAKING_TASK1_SELECTION_EMPTY');
}

export function speakingTask1CompletionMetadata(input, now = new Date()) {
  const completedAt = new Date(now);
  const dueAt = new Date(completedAt.getTime() + DUE_DAYS[input.selfRating] * DAY_MS);
  return {
    recording_duration_seconds: input.recordingDurationSeconds,
    mic_check: input.micCheck,
    local_playback: input.localPlayback,
    self_rating: input.selfRating,
    completed_at: completedAt.toISOString(),
    due_at: dueAt.toISOString(),
  };
}

export function newSpeakingTask1Session({ username, catalogId, catalogRevision, selection, now = new Date() }) {
  return {
    id: crypto.randomUUID(),
    username,
    catalog_id: catalogId,
    catalog_revision: catalogRevision,
    task_id: selection.task.id,
    task_revision: selection.task.revision,
    selection_reason: selection.reason,
    status: 'assigned',
    assigned_at: new Date(now).toISOString(),
    completed_at: null,
    due_at: null,
    recording_duration_seconds: null,
    mic_check: null,
    local_playback: false,
    self_rating: null,
  };
}

export function publicSpeakingTask1Session(session, task) {
  return {
    id: session.id,
    catalog: { id: session.catalog_id, revision: Number(session.catalog_revision) },
    task,
    selectionReason: session.selection_reason,
    status: session.status,
    assignedAt: new Date(session.assigned_at).toISOString(),
    completedAt: session.completed_at ? new Date(session.completed_at).toISOString() : null,
    practice: session.status === 'completed' ? {
      recordingDurationSeconds: Number(session.recording_duration_seconds),
      micCheck: session.mic_check,
      localPlayback: Boolean(session.local_playback),
      selfRating: session.self_rating,
    } : null,
    pronunciationAssessment: {
      available: false,
      reason: 'provider_not_connected',
      message: 'Оценка произношения пока не подключена.',
    },
  };
}
