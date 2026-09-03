import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LEARNER_DESTINATIONS,
  projectLearnerShell,
} from '../public/aisy-shell.js';

test('learner shell exposes exactly the five approved top-level destinations', () => {
  assert.deepEqual(
    LEARNER_DESTINATIONS.map(({ id, label, screenId }) => ({ id, label, screenId })),
    [
      { id: 'today', label: 'Сегодня', screenId: 'scr1' },
      { id: 'practice', label: 'Практика', screenId: 'aisy-practice' },
      { id: 'ege', label: 'ЕГЭ', screenId: 'aisy-ege' },
      { id: 'progress', label: 'Прогресс', screenId: 'scr10' },
      { id: 'profile', label: 'Профиль', screenId: 'scr11' },
    ],
  );
  assert.deepEqual(projectLearnerShell('scr1'), {
    activeDestination: 'today',
    backTarget: null,
    topLevel: true,
  });
});

test('deep learner routes project to the hub that owns the back path', () => {
  assert.deepEqual(projectLearnerShell('scr3'), {
    activeDestination: 'practice',
    backTarget: 'aisy-practice',
    topLevel: false,
  });
  assert.deepEqual(projectLearnerShell('scr3', { entryDestination: 'ege' }), {
    activeDestination: 'ege',
    backTarget: 'aisy-ege',
    topLevel: false,
  });
  assert.deepEqual(projectLearnerShell('scr16'), {
    activeDestination: 'ege',
    backTarget: 'aisy-ege',
    topLevel: false,
  });
  assert.deepEqual(projectLearnerShell('scr5'), {
    activeDestination: null,
    backTarget: null,
    topLevel: false,
  });
});
