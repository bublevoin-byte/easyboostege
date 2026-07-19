import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyBodyParserError, legacyAiRequestSchema, validateProgress } from '../validation/api-input.js';

test('progress validator accepts the extensible application state', () => {
  const progress = { learned: 42, prog: { words: 10 }, srs: { example: { s: 2, due: Date.now() } }, works: [{ t: 37, g: 5 }] };
  assert.deepEqual(validateProgress(progress), { ok: true, data: progress });
});

test('progress validator rejects non-object roots and excessive nesting', () => {
  assert.equal(validateProgress([]).code, 'ROOT_MUST_BE_OBJECT');
  const nested = { value: {} };
  let cursor = nested.value;
  for (let index = 0; index < 11; index++) cursor = cursor.value = {};
  assert.equal(validateProgress(nested).code, 'TOO_DEEP');
});

test('progress validator rejects dangerous keys and oversized strings', () => {
  assert.equal(validateProgress(JSON.parse('{"__proto__":{"admin":true}}')).code, 'FORBIDDEN_KEY');
  assert.equal(validateProgress({ draft: 'x'.repeat(20_001) }).code, 'STRING_TOO_LONG');
});

test('legacy AI request has strict fields and bounded prompts', () => {
  assert.equal(legacyAiRequestSchema.safeParse({ user: 'Explain this' }).success, true);
  assert.equal(legacyAiRequestSchema.safeParse({ user: '' }).success, false);
  assert.equal(legacyAiRequestSchema.safeParse({ user: 'ok', unexpected: true }).success, false);
  assert.equal(legacyAiRequestSchema.safeParse({ user: 'x'.repeat(30_001) }).success, false);
});

test('body parser failures map to safe client errors', () => {
  assert.deepEqual(classifyBodyParserError({ type: 'entity.too.large' }), {
    status: 413, code: 'PAYLOAD_TOO_LARGE', message: 'Тело запроса слишком большое.',
  });
  assert.equal(classifyBodyParserError({ type: 'entity.parse.failed' }).status, 400);
  assert.equal(classifyBodyParserError(new Error('database failed')), null);
});
