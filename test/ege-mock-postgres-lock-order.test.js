import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const source = await fs.readFile(
  new URL('../storage/postgres-repository.js', import.meta.url), 'utf8',
);

test('EGE Speaking sync and evaluation use the same owner to EGE to Speaking lock order', () => {
  const evaluation = source.slice(
    source.indexOf('async function completeEgeMockSpeakingSessionEvaluation'),
    source.indexOf('async function completeFullSpeakingSessionEvaluation'),
  );
  const ownerLock = evaluation.indexOf('SELECT username, subscription_until FROM users WHERE username = $1 FOR UPDATE');
  const egeLock = evaluation.indexOf('SELECT * FROM ege_mock_attempts WHERE username = $1 AND id = $2 FOR UPDATE');
  const speakingLock = evaluation.indexOf('SELECT * FROM speaking_full_sessions WHERE username = $1 AND id = $2 FOR UPDATE');
  assert.ok(ownerLock >= 0 && ownerLock < egeLock && egeLock < speakingLock,
    'evaluation must match sync lock order and cannot acquire Speaking before EGE');
  assert.match(evaluation, /SELECT clock_timestamp\(\) AS now/u,
    'settlement samples subscription time only after the owner lock');
  assert.match(evaluation, /subscription_until[\s\S]*SUBSCRIPTION_REQUIRED/u,
    'settlement rechecks active subscription inside the transaction');
});

test('PostgreSQL locks full Speaking provenance including EGE selection reason', () => {
  const claim = source.slice(
    source.indexOf('async function claimSpeakingEvaluation'),
    source.indexOf('async function finishSpeakingAttempt'),
  );
  assert.match(claim, /SELECT id, assignments, status, accent_locale, selection_reason\s+FROM speaking_full_sessions/u);
});

test('EGE provider claims lock owner, authoritative attempt and Speaking projection in order', () => {
  const claim = source.slice(
    source.indexOf('async function claimEgeMockFullSpeakingSessionAssessment'),
    source.indexOf('async function claimFullSpeakingSessionAssessment'),
  );
  const ownerLock = claim.indexOf('SELECT username, subscription_until FROM users WHERE username = $1 FOR UPDATE');
  const egeLock = claim.indexOf('SELECT state, oral_submitted_at FROM ege_mock_attempts');
  const speakingLock = claim.indexOf('SELECT * FROM speaking_full_sessions WHERE username = $1 AND id = $2 FOR UPDATE');
  assert.ok(ownerLock >= 0 && ownerLock < egeLock && egeLock < speakingLock);
  assert.match(claim, /SELECT clock_timestamp\(\) AS now/u);
  assert.match(claim, /subscription_until[\s\S]*SUBSCRIPTION_REQUIRED/u);
});
