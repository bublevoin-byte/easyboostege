import assert from 'node:assert/strict';
import test from 'node:test';

/*
 * The chain reads its providers from the configuration once, at import time, so the environment is
 * set before anything pulls in config.js — hence the dynamic imports. The values below are stub
 * credentials for a stub endpoint: no call leaves this process, fetch is replaced throughout.
 */
process.env.XAI_API_KEY = 'stub-xai';
process.env.XAI_API_URL = 'https://xai.stub.test/v1/chat/completions';
process.env.XAI_MODEL = 'stub-grok';
process.env.GROQ_API_KEY = 'stub-groq';
process.env.GROQ_API_URL = 'https://groq.stub.test/v1/chat/completions';
process.env.GROQ_MODEL = 'stub-llama';

const { createProviderClient } = await import('../ai/provider-client.js');
const { AI_OPERATIONS } = await import('../ai/operations.js');

const GROK = { name: 'grok', url: process.env.XAI_API_URL, key: 'stub-xai', model: 'stub-grok' };

function answer(content, { promptTokens = 10, completionTokens = 4 } = {}) {
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }], usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens } }) };
}

function refusal(message, status = 503) {
  return { ok: false, status, json: async () => ({ error: { message } }) };
}

/* Records every outbound call and answers it from `reply`, so no test needs a network or a key. */
function stubFetch(reply) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const call = { url, body: JSON.parse(init.body) };
    calls.push(call);
    return reply(call, calls.length);
  };
  return calls;
}

test('a call carries the limits of the operation it was made for', async () => {
  const client = createProviderClient();
  const calls = stubFetch(() => answer('{"ok":true}', { promptTokens: 120, completionTokens: 34 }));

  const result = await client.askProvider(GROK, 'system text', 'user text', 'writing_38');

  assert.equal(result.text, '{"ok":true}');
  assert.equal(result.promptTokens, 120);
  assert.equal(result.completionTokens, 34);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, GROK.url);
  assert.equal(calls[0].body.model, 'stub-grok');
  assert.equal(calls[0].body.max_tokens, AI_OPERATIONS.writing_38.maxTokens);
  assert.deepEqual(calls[0].body.messages, [
    { role: 'system', content: 'system text' },
    { role: 'user', content: 'user text' },
  ]);
});

test('a failing primary provider hands the request to the spare', async () => {
  const client = createProviderClient();
  const calls = stubFetch((call) => (call.url.startsWith('https://xai.') ? refusal('down for maintenance') : answer('from the spare')));

  const result = await client.askWithFallback('system text', 'user text', 'writing_37');

  assert.equal(result.provider, 'groq');
  assert.equal(result.model, 'stub-llama');
  assert.equal(result.attempts, 2);
  assert.equal(result.text, 'from the spare');
  assert.match(result.fallbackReason, /grok: down for maintenance/u);
  assert.equal(calls.length, 2);
});

test('a pinned provider is the only one offered', () => {
  assert.deepEqual(createProviderClient().aiProviders().map((item) => item.name), ['grok', 'groq']);
  assert.deepEqual(createProviderClient({ provider: 'groq' }).aiProviders().map((item) => item.name), ['groq']);
});

test('a named model belongs to one client, never to the application', async () => {
  const client = createProviderClient({ provider: 'grok', model: 'grok-4.3' });
  const calls = stubFetch(() => answer('{"ok":true}'));

  assert.deepEqual(client.aiProviders().map((item) => item.model), ['grok-4.3']);
  await client.askWithFallback('system text', 'user text', 'writing_37');
  assert.equal(calls[0].body.model, 'grok-4.3', 'the named model reaches the request body');

  /* The application passes nothing and keeps the models the environment gave it: comparing two
   * models is a run of the quality runner, not a change of what students are answered by. */
  assert.deepEqual(createProviderClient().aiProviders().map((item) => item.model), ['stub-grok', 'stub-llama']);
  assert.deepEqual(createProviderClient({ provider: 'grok' }).aiProviders().map((item) => item.model), ['stub-grok']);
});

test('a pinned provider that fails is not replaced by the spare', async () => {
  const client = createProviderClient({ provider: 'grok' });
  const calls = stubFetch(() => refusal('down for maintenance'));

  await assert.rejects(() => client.askWithFallback('system text', 'user text', 'writing_37'), /AI_UNAVAILABLE/u);

  assert.equal(calls.length, 1, 'the spare provider must not be called');
  assert.equal(calls[0].url, GROK.url);
});

test('a contract violation buys exactly one corrected attempt', async () => {
  const client = createProviderClient();
  const calls = stubFetch(() => answer('good'));
  const parse = (text) => {
    if (text !== 'good') throw new Error('AI_RESPONSE_INVALID_SCHEMA');
    return { text };
  };

  const outcome = await client.parseWithOneRepair({
    provider: GROK, text: 'bad', parse, system: 'system text', user: 'user text', operation: 'writing_37',
  });

  assert.deepEqual(outcome.value, { text: 'good' });
  assert.equal(outcome.repair.reason, 'AI_RESPONSE_INVALID_SCHEMA');
  assert.equal(outcome.repair.provider.name, 'grok');
  assert.equal(calls.length, 1);
  /* The repair call quotes the rejected output back, labelled as data rather than instruction. */
  assert.match(calls[0].body.messages.at(-1).content, /ОТКЛОНЁННЫЙ_ОТВЕТ/u);
});

test('a second violation is not repaired again', async () => {
  const client = createProviderClient();
  const calls = stubFetch(() => answer('still bad'));

  await assert.rejects(() => client.parseWithOneRepair({
    provider: GROK,
    text: 'bad',
    parse: () => { throw new Error('AI_RESPONSE_INVALID_SCHEMA'); },
    system: 'system text',
    user: 'user text',
    operation: 'writing_37',
  }), /AI_RESPONSE_INVALID_SCHEMA/u);

  assert.equal(calls.length, 1, 'one repair attempt, never two');
});

test('an accepted answer costs nothing extra', async () => {
  const client = createProviderClient();
  const calls = stubFetch(() => answer('unused'));

  const outcome = await client.parseWithOneRepair({
    provider: GROK, text: 'good', parse: (text) => ({ text }), system: 'system text', user: 'user text', operation: 'writing_37',
  });

  assert.equal(outcome.repair, null);
  assert.equal(calls.length, 0);
});

test('the chain asks for the registry budget, clamped by the deployment ceiling', () => {
  const { limitsFor } = createProviderClient();
  assert.equal(limitsFor('writing_38').maxTokens, AI_OPERATIONS.writing_38.maxTokens);
  /* AI_REQUESTS_PER_HOUR defaults to 60 and the registry asks for 12: the stricter figure wins. */
  assert.equal(limitsFor('writing_38').requestsPerHour, AI_OPERATIONS.writing_38.requestsPerHour);
  assert.ok(limitsFor('writing_38').timeoutMs <= AI_OPERATIONS.writing_38.timeoutMs);
});
