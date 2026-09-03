import assert from 'node:assert/strict';
import test from 'node:test';

test('shared semantic JSON equality ignores only object-key order', async () => {
  const { sameSemanticJsonValue } = await import('../shared/semantic-json.js');

  assert.equal(sameSemanticJsonValue(
    { nested: { score: 3, evidence: ['a', 'b'] }, status: 'completed' },
    { status: 'completed', nested: { evidence: ['a', 'b'], score: 3 } },
  ), true);
  assert.equal(sameSemanticJsonValue(
    { nested: { score: 3, evidence: ['a', 'b'] }, status: 'completed' },
    { nested: { score: 3, evidence: ['b', 'a'] }, status: 'completed' },
  ), false);
});
