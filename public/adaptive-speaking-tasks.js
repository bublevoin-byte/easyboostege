const taskPattern = /^server:speaking:task:([1-4])(?::skill:([a-z0-9._-]{3,120}))?(?::focus:([a-z0-9._-]{3,120}))?:new:v1$/u;

export function adaptiveSpeakingTask(contentRef) {
  const match = taskPattern.exec(String(contentRef || ''));
  return match ? {
    taskNumber: Number(match[1]), skillId: match[2] || null, focusRef: match[3] || null,
  } : null;
}

export function adaptiveSpeakingContentRef(taskNumber, skillId = null, focusRef = null) {
  const normalized = Number(taskNumber);
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > 4) return null;
  const normalizedSkill = String(skillId || '');
  if (normalizedSkill && !/^[a-z0-9._-]{3,120}$/u.test(normalizedSkill)) return null;
  const normalizedFocus = String(focusRef || '');
  if (normalizedFocus && !/^[a-z0-9._-]{3,120}$/u.test(normalizedFocus)) return null;
  return `server:speaking:task:${normalized}${normalizedSkill ? `:skill:${normalizedSkill}` : ''}`
    + `${normalizedFocus ? `:focus:${normalizedFocus}` : ''}:new:v1`;
}

export function adaptiveSpeakingActivityMatchesTask(activityId, taskNumber) {
  const normalized = Number(taskNumber);
  return Number.isInteger(normalized) && normalized >= 1 && normalized <= 4
    && new RegExp(`^speaking_${normalized}(?:_|$)`, 'u').test(String(activityId || ''));
}
