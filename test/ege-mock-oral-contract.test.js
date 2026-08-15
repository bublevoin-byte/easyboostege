import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EGE_MOCK_ORAL_CONTRACT,
  EGE_MOCK_ORAL_DURATION_MS,
  EGE_MOCK_ORAL_MAXIMUM_SCORE,
  EGE_MOCK_ORAL_POSITIONS,
  EGE_MOCK_ORAL_RESPONSE_COUNT,
  EGE_MOCK_ORAL_TASKS,
  EGE_MOCK_ORAL_TECHNICAL_ISSUE_CODES,
} from '../shared/ege-mock-oral-contract.js';

test('one immutable oral contract owns the exact 17-minute 39-42 format', () => {
  assert.equal(Object.isFrozen(EGE_MOCK_ORAL_CONTRACT), true);
  assert.equal(Object.isFrozen(EGE_MOCK_ORAL_TASKS), true);
  assert.equal(EGE_MOCK_ORAL_DURATION_MS, 17 * 60_000);
  assert.deepEqual(EGE_MOCK_ORAL_POSITIONS, [39, 40, 41, 42]);
  assert.deepEqual(EGE_MOCK_ORAL_TASKS, [
    { position: 39, taskType: 1, responseCount: 1, preparationSeconds: 90, responseSeconds: 90, maximumScore: 1 },
    { position: 40, taskType: 2, responseCount: 4, preparationSeconds: 60, responseSeconds: 20, maximumScore: 4 },
    { position: 41, taskType: 3, responseCount: 5, preparationSeconds: 0, responseSeconds: 40, maximumScore: 5 },
    { position: 42, taskType: 4, responseCount: 1, preparationSeconds: 150, responseSeconds: 180, maximumScore: 10 },
  ]);
  assert.equal(EGE_MOCK_ORAL_RESPONSE_COUNT, 11);
  assert.equal(EGE_MOCK_ORAL_MAXIMUM_SCORE, 20);
  assert.deepEqual(EGE_MOCK_ORAL_TECHNICAL_ISSUE_CODES, [
    'microphone_denied', 'no_audio_track', 'recording_failed', 'response_timeout',
    'offline_capture_unavailable', 'oral_deadline_elapsed', 'silence', 'noise', 'clipping', 'other',
  ]);
  assert.equal(Object.isFrozen(EGE_MOCK_ORAL_TECHNICAL_ISSUE_CODES), true);
});
