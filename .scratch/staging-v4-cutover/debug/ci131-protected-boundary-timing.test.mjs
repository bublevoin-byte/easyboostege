import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { readBoundaryObservation, reportBoundaryRows } from './ci131-protected-boundary-timing.mjs';

test('protected timing preserves a real finite child failure despite valid-looking output', () => {
  const result = spawnSync(process.execPath, ['-e',
    'console.log("boundary compose 1 10.0 10.1"); process.exitCode = 23;'], {
    encoding: 'utf8', timeout: 5000,
  });
  assert.throws(() => readBoundaryObservation(result, 'compose'), (error) => error.status === 23);
});

test('protected timing accepts exactly three ordered finite rows and bounds its output', () => {
  const result = spawnSync(process.execPath, ['-e',
    'console.log("boundary compose 1 10.0 10.1\\nboundary compose 2 11.0 11.3\\nboundary compose 3 12.0 12.2");'], {
    encoding: 'utf8', timeout: 5000,
  });
  const rows = readBoundaryObservation(result, 'compose');
  assert.deepEqual(rows.map((row) => row.elapsed_ms), [100, 300, 200]);
  assert.deepEqual(rows.map((row) => row.iteration), [1, 2, 3]);
  assert.ok(rows.every((row) => row.source === 'chain' && row.status === 0));
  assert.throws(() => readBoundaryObservation({ ...result, stdout: 'private-payload' }, 'compose'));
  assert.throws(() => readBoundaryObservation({ ...result, stdout: result.stdout.repeat(30) }, 'compose'));
  assert.throws(() => readBoundaryObservation({ ...result, stdout: result.stdout.replace('12.2', '72.1') }, 'compose'));
  assert.throws(() => readBoundaryObservation(result, 'workspace'));
  assert.throws(() => readBoundaryObservation(result, '/tmp/arbitrary'));
  assert.throws(() => readBoundaryObservation({ ...result, stderr: 'unexpected' }, 'compose'));
  assert.throws(() => readBoundaryObservation({ ...result, status: null, error: { code: 'ETIMEDOUT' } }, 'compose'),
    (error) => error.status === 124);
});

test('fixed protected-timing CLI refuses caller paths, commands, environment flags and internal mode', () => {
  const script = fileURLToPath(new URL('./ci131-protected-boundary-timing.mjs', import.meta.url));
  for (const args of [['/tmp/arbitrary'], ['--command', 'true'], ['--env', 'PATH=/tmp'], ['owner']]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 64);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, '{"event":"invalid-invocation","status":64}\n');
  }
});

test('protected report failure preserves real child23 and turns only child success into failure1', () => {
  const brokenWriter = () => { throw Object.assign(new Error('private writer detail'), { code: 'EPIPE' }); };
  for (const childStatus of [23, 0]) {
    const child = spawnSync(process.execPath, ['-e', `process.exitCode = ${childStatus};`], {
      encoding: 'utf8', timeout: 5000,
    });
    assert.equal(child.error, undefined);
    assert.equal(child.signal, null);
    assert.equal(child.status, childStatus);
    assert.equal(reportBoundaryRows(child.status, [{ event: 'protected-component-only', status: child.status }],
      brokenWriter), childStatus === 0 ? 1 : 23);
  }
  for (const status of [124, 64, 69]) {
    assert.equal(reportBoundaryRows(status, [{ event: 'fixed-refusal', status }], brokenWriter), status);
  }
  const written = [];
  assert.equal(reportBoundaryRows(0, [{ event: 'protected-component-only', status: 0 }],
    (row) => written.push(row)), 0);
  assert.deepEqual(written, [{ event: 'protected-component-only', status: 0 }]);
});
