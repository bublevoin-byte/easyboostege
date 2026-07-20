import assert from 'node:assert/strict';
import test from 'node:test';
import { errorBankBatchSchema } from '../validation/error-bank.js';

test('error bank accepts bounded flat diagnostic entries', () => {
  const parsed = errorBankBatchSchema.safeParse({ errors: [{ module: 'grammar', itemKey: 'grammar_19_24:go', errorType: 'incorrect_form', details: { expected: 'went' } }] });
  assert.equal(parsed.success, true);
  assert.equal(errorBankBatchSchema.safeParse({ errors: [{ module: 'grammar', itemKey: 'x', errorType: 'Bad Type', details: {} }] }).success, false);
  assert.equal(errorBankBatchSchema.safeParse({ errors: [{ module: 'grammar', itemKey: 'x', errorType: 'incorrect', details: { nested: { raw: 'answer' } } }] }).success, false);
});
