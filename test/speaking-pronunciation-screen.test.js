import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const source = await fs.readFile(new URL('../public/screens/speaking.js', import.meta.url), 'utf8');

test('speaking hub exposes an accessible live pronunciation provider and quota state', () => {
  assert.match(source, /id="speaking_pronunciation_status"/u);
  assert.match(source, /role="status" aria-live="polite" aria-atomic="true"/u);
  assert.match(source, /\/api\/v1\/speaking\/pronunciation-assessments\/status/u);
  assert.match(source, /speakingModule\.pronunciationStatusView/u);
  assert.match(source, /Локальная запись и прослушивание не расходуют лимит/u);
  assert.match(source, /Оценка произношения пока недоступна/u);
});
