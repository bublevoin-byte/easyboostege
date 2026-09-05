import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { finishCostObservation, reportCostRows, runCostFixture } from './ci129-supervisor-cost.mjs';

const command = fileURLToPath(new URL('./ci129-supervisor-cost.mjs', import.meta.url));

test('cost observer refuses arbitrary commands without echoing them', () => {
  const result = spawnSync(process.execPath, [command, 'private-value'], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 1024,
  });
  assert.equal(result.status, 64);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { event: 'invalid-invocation', status: 64 });
});

test('real finite supervised success produces bounded ordered phase measurements and cleans its fixture', {
  skip: process.platform !== 'linux', timeout: 45000,
}, async () => {
  const result = await runCostFixture(0, 1);
  assert.equal(result.status, 0);
  assert.equal(result.fixture_removed, 1);
  assert.equal(result.rows.length, 1);
  const row = result.rows[0];
  assert.equal(row.status, 0);
  assert.equal(row.event, 'supervisor-cost');
  assert.equal(row.source, 'descriptor');
  assert.ok(row.control_ms > 0 && row.invocation_ms > 0 && row.dispose_ms > 0);
  assert.ok(row.total_ms >= row.control_ms + row.invocation_ms + row.dispose_ms);
  assert.ok(row.invocation_cpu_ms > 0 && row.profile_samples > 0);
  assert.ok(row.spawn_to_ready_ms >= 0 && row.ready_to_status_ms >= 0);
  assert.ok(row.status_to_kill_ms >= 0 && row.kill_to_close_ms >= 0);
  assert.ok(row.close_to_finish_ms >= row.dispose_ms);
  assert.ok(Buffer.byteLength(JSON.stringify(row)) <= 1024);
  assert.doesNotMatch(JSON.stringify(result), /private|secret|argv|digest|authority|\/tmp|\/proc|pid/);
});

test('a profiler failure cannot replace a known real finite child failure', async () => {
  const child = spawnSync(process.execPath, ['-e', 'process.exitCode = 23'], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 1024,
  });
  assert.equal(child.status, 23);
  const stopped = await finishCostObservation(child.status, () => {
    throw new Error('synthetic profiler failure');
  });
  assert.deepEqual(stopped, { status: 23 });
});

test('throwing output preserves a real finite child failure and fails otherwise successful output', () => {
  for (const expected of [23, 0]) {
    const child = spawnSync(process.execPath, ['-e', `process.exitCode = ${expected}`], {
      encoding: 'utf8', timeout: 5000, maxBuffer: 1024,
    });
    assert.equal(child.status, expected);
    let writes = 0;
    const status = reportCostRows(child.status, [
      { event: 'component-failed', status: child.status },
      { event: 'component-only', status: child.status, fixture_removed: 0 },
    ], () => { writes++; throw new Error('synthetic output failure'); });
    assert.equal(status, expected === 23 ? 23 : 1);
    assert.equal(writes, 1);
  }
});

test('a real inherited Node chain reaches the same observed finite command and settles', {
  skip: process.platform !== 'linux', timeout: 45000,
}, async () => {
  const result = await runCostFixture(0, 1, 'chain');
  assert.equal(result.status, 0);
  assert.equal(result.fixture_removed, 1);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].source, 'chain');
  assert.ok(result.rows[0].invocation_cpu_ms > 0);
  assert.equal(result.rows[0].descriptor_hash_samples, 0);
});

// Run last: its intentionally retained fixture consumes the disposable tmpfs until outer exit.
test('a real supervised finite failure remains23 and retains its fixture', {
  skip: process.platform !== 'linux', timeout: 45000,
}, async () => {
  const result = await runCostFixture(23, 1);
  assert.equal(result.status, 23);
  assert.equal(result.fixture_removed, 0);
  assert.deepEqual(result.rows, [{ event: 'component-failed', status: 23 }]);
});
