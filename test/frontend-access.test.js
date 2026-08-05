import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyLearningAccess, LEARNING_ACCESS_STATES } from '../public/access.js';

test('only a server-authenticated session with active true opens learning', () => {
  assert.deepEqual(classifyLearningAccess({ authenticated: true, username: 'active', active: true }), {
    state: LEARNING_ACCESS_STATES.ACTIVE,
    session: { authenticated: true, username: 'active', active: true },
  });

  for (const session of [
    { authenticated: true, username: 'inactive', active: false },
    { authenticated: true, username: 'missing-subscription' },
  ]) {
    assert.equal(classifyLearningAccess(session).state, LEARNING_ACCESS_STATES.INACTIVE);
  }

  assert.equal(classifyLearningAccess(null).state, LEARNING_ACCESS_STATES.NO_SESSION);
  assert.equal(classifyLearningAccess({ authenticated: false }).state, LEARNING_ACCESS_STATES.NO_SESSION);
});

test('session failures distinguish no session from an unknown network or server result', () => {
  assert.equal(
    classifyLearningAccess(null, { status: 401, code: 'SESSION_REVOKED' }).state,
    LEARNING_ACCESS_STATES.NO_SESSION,
  );
  for (const error of [
    { status: 0, code: 'NETWORK_ERROR' },
    { status: 503, code: 'REQUEST_FAILED' },
    new Error('connection reset'),
  ]) {
    assert.equal(
      classifyLearningAccess(null, error).state,
      LEARNING_ACCESS_STATES.NETWORK_UNKNOWN,
    );
  }
});
