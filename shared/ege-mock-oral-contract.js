export const EGE_MOCK_ORAL_DURATION_MS = 17 * 60_000;
export const EGE_MOCK_ORAL_STAGE_SETTLEMENT_GRACE_MS = 5_000;

export const EGE_MOCK_ORAL_TASKS = Object.freeze([
  Object.freeze({ position: 39, taskType: 1, responseCount: 1, preparationSeconds: 90, responseSeconds: 90, maximumScore: 1 }),
  Object.freeze({ position: 40, taskType: 2, responseCount: 4, preparationSeconds: 60, responseSeconds: 20, maximumScore: 4 }),
  Object.freeze({ position: 41, taskType: 3, responseCount: 5, preparationSeconds: 0, responseSeconds: 40, maximumScore: 5 }),
  Object.freeze({ position: 42, taskType: 4, responseCount: 1, preparationSeconds: 150, responseSeconds: 180, maximumScore: 10 }),
]);

export const EGE_MOCK_ORAL_POSITIONS = Object.freeze(
  EGE_MOCK_ORAL_TASKS.map(({ position }) => position),
);
export const EGE_MOCK_ORAL_TASK_BY_POSITION = Object.freeze(Object.fromEntries(
  EGE_MOCK_ORAL_TASKS.map((task) => [task.position, task]),
));
export const EGE_MOCK_ORAL_TASK_BY_TYPE = Object.freeze(Object.fromEntries(
  EGE_MOCK_ORAL_TASKS.map((task) => [task.taskType, task]),
));
export const EGE_MOCK_ORAL_RESPONSE_KEYS = Object.freeze(EGE_MOCK_ORAL_TASKS.flatMap((task) => (
  Array.from({ length: task.responseCount }, (_, index) => `${task.position}:${index + 1}`)
)));
export const EGE_MOCK_ORAL_RESPONSE_COUNT = EGE_MOCK_ORAL_RESPONSE_KEYS.length;
export const EGE_MOCK_ORAL_MAXIMUM_SCORE = EGE_MOCK_ORAL_TASKS.reduce(
  (total, task) => total + task.maximumScore, 0,
);
export const EGE_MOCK_ORAL_TECHNICAL_ISSUE_CODES = Object.freeze([
  'microphone_denied', 'no_audio_track', 'recording_failed', 'response_timeout',
  'offline_capture_unavailable', 'oral_deadline_elapsed', 'silence', 'noise', 'clipping', 'other',
]);

export const EGE_MOCK_ORAL_CONTRACT = Object.freeze({
  schemaVersion: 'ege-mock-oral-contract-v1',
  durationMs: EGE_MOCK_ORAL_DURATION_MS,
  stageSettlementGraceMs: EGE_MOCK_ORAL_STAGE_SETTLEMENT_GRACE_MS,
  tasks: EGE_MOCK_ORAL_TASKS,
  positions: EGE_MOCK_ORAL_POSITIONS,
  responseKeys: EGE_MOCK_ORAL_RESPONSE_KEYS,
  responseCount: EGE_MOCK_ORAL_RESPONSE_COUNT,
  maximumScore: EGE_MOCK_ORAL_MAXIMUM_SCORE,
  technicalIssueCodes: EGE_MOCK_ORAL_TECHNICAL_ISSUE_CODES,
});
