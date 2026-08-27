import assert from 'node:assert/strict';
import test from 'node:test';

import { writingProgressSummary } from '../storage/writing-progress.js';

test('authoritative Writing summary keeps total truth while bounding recent work DTOs', () => {
  const attempts = Array.from({ length: 35 }, (_, index) => ({
    id: index + 1,
    task_type: index % 2 ? 'writing_37' : 'writing_38',
    source_task_ref: `task-${index + 1}`,
    status: 'completed',
    review: {
      words: index % 2 ? 110 : 220,
      overall_got: index % 2 ? 4 : 10,
      overall_max: index % 2 ? 6 : 14,
    },
    created_at: index + 1,
    evaluated_at: index + 1,
  }));
  const summary = writingProgressSummary(attempts);
  assert.equal(summary.attemptCount, 35);
  assert.equal(summary.works.length, 30);
  assert.equal(summary.works[0].attemptId, 6);
  assert.equal(summary.works.at(-1).attemptId, 35);
  assert.equal(summary.works.some((work) => work.attemptId === 1), false,
    'an old exact replay is intentionally outside the bounded recent list');
  assert.ok(summary.average >= 0 && summary.average <= 100);
});
