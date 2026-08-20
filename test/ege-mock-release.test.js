import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('one full EGE acceptance contour is wired into the default gates', async () => {
  const packageSource = await fs.readFile(new URL('../package.json', import.meta.url), 'utf8');
  const packageJson = JSON.parse(packageSource);

  assert.match(packageJson.scripts['test:e2e'], /node e2e\/ege-mock-release\.test\.js/u);
  assert.match(packageJson.scripts['test:e2e:ege-mock'], /node e2e\/ege-mock-release\.test\.js/u);
});

test('the full EGE operator contract binds monitoring, privacy, retention and local release proof', async () => {
  const [runbook, monitoring, retention, openapi] = await Promise.all([
    fs.readFile(new URL('../docs/EGE_MOCK_OPERATIONS.md', import.meta.url), 'utf8'),
    fs.readFile(new URL('../docs/MONITORING.md', import.meta.url), 'utf8'),
    fs.readFile(new URL('../docs/DATA_RETENTION.md', import.meta.url), 'utf8'),
    fs.readFile(new URL('../docs/openapi.yaml', import.meta.url), 'utf8'),
  ]);

  assert.match(runbook, /ege-en-2026-form-1@1/u);
  assert.match(runbook, /npm run test:e2e:ege-mock/u);
  assert.match(runbook, /\/api\/v1\/admin\/metrics.*\/internal\/metrics/su);
  assert.match(runbook, /:id/u);
  assert.match(runbook, /(?:ответ|answer).*(?:transcript|аудио|audio).*(?:метрик|лог)/isu);
  assert.match(runbook, /190 минут.*17 минут/su);
  assert.match(runbook, /offline.*reload.*reconnect/isu);
  assert.match(runbook, /(?:никакого|никакие|ни на какие)\s+push.*deploy/isu);
  assert.match(monitoring, /EGE_MOCK_OPERATIONS\.md/u);
  assert.match(monitoring, /полный текст.*аудио.*не попада/isu);
  assert.match(retention, /Full EGE mock attempts/u);
  assert.match(openapi, /\/api\/v1\/ege-mocks\/attempts\/\{attemptId\}\/result:/u);
});
