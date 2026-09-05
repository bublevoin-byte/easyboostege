import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { readPairObservation } from './ci130-release-pair-timing.mjs';

test('pair timing preserves a real finite child failure instead of accepting a success row', () => {
  const result = spawnSync(process.execPath, ['-e',
    'console.log("pair 1 10.0 10.1"); process.exitCode = 23;'], { encoding: 'utf8', timeout: 5000 });
  assert.throws(() => readPairObservation(result, 'before'), (error) => error.status === 23);
});

test('pair timing accepts only three bounded real child rows without a timing threshold', () => {
  const result = spawnSync(process.execPath, ['-e',
    'console.log("pair 1 10.0 10.1\\npair 2 11.0 11.3\\npair 3 12.0 12.2");'], {
    encoding: 'utf8', timeout: 5000,
  });
  const rows = readPairObservation(result, 'after');
  assert.deepEqual(rows.map((row) => row.iteration), [1, 2, 3]);
  assert.deepEqual(rows.map((row) => row.elapsed_ms), [100, 300, 200]);
  assert.ok(rows.every((row) => row.status === 0 && row.source === 'chain'));
  assert.throws(() => readPairObservation({ ...result, stdout: 'private-value' }, 'after'));
  assert.throws(() => readPairObservation({ ...result, stdout: result.stdout.repeat(2) }, 'after'));
});
