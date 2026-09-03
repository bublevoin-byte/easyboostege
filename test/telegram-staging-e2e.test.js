import assert from 'node:assert/strict';
import test from 'node:test';
import { validateStagingUrl } from '../scripts/telegram-staging-e2e.js';

test('Telegram E2E accepts the isolated staging hostname', () => {
  assert.equal(
    validateStagingUrl('https://staging.useboost.ru/path?ignored=1').href,
    'https://staging.useboost.ru/',
  );
});

test('Telegram E2E refuses production', () => {
  assert.throws(
    () => validateStagingUrl('https://useboost.ru'),
    /Refusing to run Telegram E2E against production/u,
  );
});

test('Telegram E2E refuses HTTP and non-staging hosts', () => {
  assert.throws(() => validateStagingUrl('http://staging.useboost.ru'), /requires HTTPS/u);
  assert.throws(() => validateStagingUrl('https://example.com'), /must start with "staging\."/u);
});
