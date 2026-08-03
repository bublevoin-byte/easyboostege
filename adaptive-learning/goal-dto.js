const GOAL_FIELDS = Object.freeze([
  'id', 'target_exam', 'target_score', 'exam_date', 'weekly_minutes', 'revision',
]);

function timestamp(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function dateOnly(value) {
  if (value == null) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString().slice(0, 10) : null;
  const normalized = String(value);
  return /^\d{4}-\d{2}-\d{2}$/u.test(normalized) ? normalized : timestamp(value)?.slice(0, 10) || null;
}

export function adaptiveLearningGoalRepositoryDto(goal) {
  if (!goal) return null;
  return {
    ...Object.fromEntries(GOAL_FIELDS.map((field) => [field, goal[field]])),
    target_score: Number(goal.target_score),
    exam_date: dateOnly(goal.exam_date),
    weekly_minutes: Number(goal.weekly_minutes),
    revision: Number(goal.revision),
    created_at: timestamp(goal.created_at),
    updated_at: timestamp(goal.updated_at),
  };
}

export function adaptiveLearningGoalPublicDto(goal) {
  const normalized = adaptiveLearningGoalRepositoryDto(goal);
  if (!normalized) return null;
  return {
    id: normalized.id,
    targetExam: normalized.target_exam,
    targetScore: normalized.target_score,
    examDate: normalized.exam_date,
    weeklyMinutes: normalized.weekly_minutes,
    revision: normalized.revision,
    createdAt: normalized.created_at,
    updatedAt: normalized.updated_at,
  };
}
