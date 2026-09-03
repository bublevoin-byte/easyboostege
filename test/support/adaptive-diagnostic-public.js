import assert from 'node:assert/strict';

export async function completeShortAdaptiveDiagnostic(request, username, suffix) {
  const startedResponse = await request(username, '/api/v1/adaptive-learning/diagnostics/start', {
    method: 'POST',
    headers: { 'Idempotency-Key': `adaptive-diagnostic-${suffix}-start` },
    body: JSON.stringify({ depth: 'short' }),
  });
  assert.equal(startedResponse.status, 201);
  let current = await startedResponse.json();
  let answerIndex = 0;

  while (current.diagnostic.status === 'in_progress') {
    answerIndex += 1;
    const answeredResponse = await request(
      username,
      `/api/v1/adaptive-learning/diagnostics/${current.diagnostic.id}/answers`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': `adaptive-diagnostic-${suffix}-answer-${answerIndex}` },
        body: JSON.stringify({ itemId: current.item.id, choiceId: current.item.choices[0].id }),
      },
    );
    assert.equal(answeredResponse.status, 201);
    current = await answeredResponse.json();
  }

  assert.equal(current.diagnostic.status, 'ready');
  const completedResponse = await request(
    username,
    `/api/v1/adaptive-learning/diagnostics/${current.diagnostic.id}/complete`,
    {
      method: 'POST',
      headers: { 'Idempotency-Key': `adaptive-diagnostic-${suffix}-complete` },
      body: JSON.stringify({}),
    },
  );
  assert.equal(completedResponse.status, 201);
  return completedResponse.json();
}
