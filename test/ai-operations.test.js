import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import { AI_OPERATIONS, operationLimits, operationNames, providersFor } from '../ai/operations.js';
import { createConcurrencyGate } from '../ai/provider-control.js';
import { parseAndValidateWritingReview } from '../ai/writing.js';

const REVIEW = {
  words: 3,
  in_range: false,
  overall_got: 0,
  overall_max: 6,
  verdict: 'Черновая проверка',
  sub: 'Совет',
  criteria: [
    { name: 'Решение коммуникативной задачи', got: 0, max: 2 },
    { name: 'Организация текста', got: 0, max: 2 },
    { name: 'Языковое оформление', got: 0, max: 2 },
  ],
  errors: [],
};
const INPUT = {
  taskType: 'writing_37',
  answer: 'one two three',
  assignment: { from: 'Sam', stimulus: 'x', questionsTopic: 'y' },
};

test('every operation declares its own budget', () => {
  for (const name of operationNames()) {
    const limits = AI_OPERATIONS[name];
    assert.ok(limits.maxTokens >= 100 && limits.maxTokens <= 4000, `${name}: token limit`);
    assert.ok(limits.timeoutMs >= 5_000 && limits.timeoutMs <= 120_000, `${name}: timeout`);
    assert.ok(limits.requestsPerHour >= 1, `${name}: hourly limit`);
    assert.ok(['secondary', 'none'].includes(limits.fallback), `${name}: fallback rule`);
    assert.ok(limits.promptVersion && limits.promptVersion !== 'unknown', `${name}: prompt version`);
  }
});

test('evaluation gets more room than generation', () => {
  assert.ok(operationLimits('writing_38').maxTokens > operationLimits('dictionary_lookup').maxTokens);
  assert.ok(operationLimits('writing_38').timeoutMs > operationLimits('dictionary_lookup').timeoutMs);
  // A review is the expensive call, so it is rationed harder than a lookup.
  assert.ok(operationLimits('writing_38').requestsPerHour < operationLimits('dictionary_lookup').requestsPerHour);
});

test('an unknown operation falls back to a safe default instead of crashing', () => {
  const limits = operationLimits('does_not_exist');
  assert.equal(limits.fallback, 'secondary');
  assert.ok(limits.maxTokens > 0);
});

test('fallback rules decide how many providers an operation may use', () => {
  const providers = [{ name: 'grok' }, { name: 'groq' }];
  assert.equal(providersFor('writing_38', providers).length, 2);
  // A sample answer is a convenience, not a grade: one provider and no retry.
  assert.equal(providersFor('speaking_sample', providers).length, 1);
});

test('a review carrying markup is rejected, not escaped and stored', () => {
  assert.doesNotThrow(() => parseAndValidateWritingReview(JSON.stringify(REVIEW), INPUT));

  for (const mutate of [
    (review) => { review.verdict = 'Ошибка <b>тут</b>'; },
    (review) => { review.sub = 'Совет <script>x</script>'; },
    (review) => { review.criteria[0].name = 'Критерий <i>'; },
    (review) => { review.errors = [{ title: 'a', wrong: '<b>x</b>', right: '', kind: 'err', note: 'n' }]; },
    (review) => { review.errors = [{ title: 'a', wrong: '', right: '', kind: 'err', note: 'note <div>' }]; },
  ]) {
    const review = structuredClone(REVIEW);
    mutate(review);
    assert.throws(() => parseAndValidateWritingReview(JSON.stringify(review), INPUT), /AI_RESPONSE_INVALID_SCHEMA/u);
  }
});

test('calls above the concurrency limit wait instead of piling onto the provider', async () => {
  const gate = createConcurrencyGate(2);
  let peak = 0;
  let active = 0;
  const task = async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
  };

  await Promise.all(Array.from({ length: 6 }, () => gate.run(task)));
  assert.equal(peak, 2, `at most two calls at once, saw ${peak}`);
  assert.deepEqual({ ...gate.stats() }, { active: 0, waiting: 0, limit: 2 });
});

test('a caller that waits too long is refused rather than hanging', async () => {
  const gate = createConcurrencyGate(1, 20);
  const blocker = gate.run(() => new Promise((resolve) => setTimeout(resolve, 200)));

  await assert.rejects(() => gate.run(() => 'never'), /AI_QUEUE_TIMEOUT/u);
  await blocker;
  assert.equal(gate.stats().waiting, 0, 'a timed-out caller leaves no entry behind');
});

/*
 * The clamps moved to ai/provider-client.js with the rest of the provider call chain, so that the
 * quality runner of section 11.2 measures the code students hit rather than a copy of it. Only the
 * file being read changed: the guarantee under test — the deployment may tighten the registry but
 * never loosen it — is the same one, asserted the same way.
 */
test('the deployment can clamp the registry but not raise it', async () => {
  const route = await fs.readFile(new URL('../ai/provider-client.js', import.meta.url), 'utf8');
  assert.match(route, /Math\.min\(base\.requestsPerHour, config\.ai\.maxRequestsPerHour\)/u);
  assert.match(route, /Math\.min\(base\.timeoutMs, config\.ai\.maxTimeoutMs\)/u);
  assert.match(route, /max_tokens: limits\.maxTokens/u);
  assert.match(route, /gate\.run\(\(\) => fetch\(url/u);
});
