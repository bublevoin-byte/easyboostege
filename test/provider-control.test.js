import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateCostMicrousd, runProviderFallback, TtlCache } from '../ai/provider-control.js';

test('provider fallback uses the secondary provider after primary failure', async () => {
  const calls = [];
  const result = await runProviderFallback([{ name: 'primary', model: 'one' }, { name: 'secondary', model: 'two' }], async (provider) => {
    calls.push(provider.name);
    if (provider.name === 'primary') throw new Error('offline');
    return { text: 'ok', promptTokens: 10, completionTokens: 5 };
  });
  assert.deepEqual(calls, ['primary', 'secondary']);
  assert.equal(result.provider, 'secondary');
  assert.equal(result.text, 'ok');
});

test('provider fallback returns stable errors when unavailable', async () => {
  await assert.rejects(() => runProviderFallback([], async () => ({})), /AI_NOT_CONFIGURED/u);
  await assert.rejects(() => runProviderFallback([{ name: 'only', model: 'one' }], async () => { throw new Error('offline'); }), /AI_UNAVAILABLE/u);
});

test('AI cost calculation uses provider token prices', () => {
  assert.equal(estimateCostMicrousd({ promptTokens: 1000, completionTokens: 500 }, { inputMicrousdPerMillion: 2_000_000, outputMicrousdPerMillion: 4_000_000 }), 4000);
  assert.equal(estimateCostMicrousd({}, {}), null);
});

test('TTL cache clones values and expires entries', () => {
  const cache = new TtlCache(1000, 2);
  cache.set('word', { tr: 'слово' }, 100);
  const value = cache.get('word', 200);
  value.tr = 'изменено';
  assert.equal(cache.get('word', 300).tr, 'слово');
  assert.equal(cache.get('word', 1100), null);
});
