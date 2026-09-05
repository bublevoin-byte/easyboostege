import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { requireComponentSuccess, removeFixture } from './native-bounded-timing.mjs';
import { completeComponent } from './bounded-timing-chain.mjs';
import { runSupervisedCommand, readLinuxProcessStartTime } from '../../../scripts/staging-command-supervisor.js';
import { createPosixSessionInvocation } from '../../../scripts/posix-session-supervisor.js';

const command = fileURLToPath(new URL('./native-bounded-timing.mjs', import.meta.url));

test('the component CLI rejects arbitrary commands without echoing input', () => {
  const result = spawnSync(process.execPath, [command, 'private-command-value'], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 1024,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 64);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { event: 'invalid-invocation', status: 64 });
});

test('owned fixture cleanup rejects a replacement root and does not follow a link outside its scope', {
  skip: process.platform !== 'linux' && 'requires Linux private /tmp fixture',
}, async () => {
  const root = await fs.mkdtemp('/tmp/easyboost-bounded-timing-');
  const outside = await fs.mkdtemp('/tmp/easyboost-bounded-outside-');
  const identity = await fs.lstat(root);
  try {
    await fs.writeFile(path.join(outside, 'keep'), 'synthetic');
    await fs.chmod(outside, 0o500);
    await fs.symlink(outside, path.join(root, 'link'));
    await assert.rejects(removeFixture(root, { dev: identity.dev, ino: -1 }));
    assert.ok((await fs.lstat(root)).isDirectory());
    await removeFixture(root, identity);
    assert.equal(await fs.readFile(path.join(outside, 'keep'), 'utf8'), 'synthetic');
    assert.equal((await fs.stat(outside)).mode & 0o777, 0o500);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.chmod(outside, 0o700);
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('a real finite child failure survives diagnostic error handling without exposing its streams', () => {
  const child = spawnSync(process.execPath, ['-e',
    'console.error("private-stderr-value"); process.exitCode = 23;'], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 1024,
  });
  assert.equal(child.error, undefined);
  assert.throws(() => requireComponentSuccess(child), (error) => error.status === 23
    && error.message === 'component failed' && !JSON.stringify(error).includes('private'));
});

test('the real supervisor early parent-identity refusal stays143 when invocation timing never starts', {
  skip: process.platform !== 'linux' && 'requires real Linux parent starttime',
}, async () => {
  const actualStartTime = readLinuxProcessStartTime(process.pid);
  assert.match(actualStartTime, /^[1-9][0-9]*$/);
  let invocationMs;
  let invocations = 0;
  const started = performance.now();
  const status = await runSupervisedCommand({
    command: '/usr/bin/true', args: [], timeoutMs: 1000, parentPid: process.pid,
    parentStartTime: String(BigInt(actualStartTime) + 1n),
    posixSessionInvocation(...args) {
      invocations++;
      const before = performance.now();
      const invocation = createPosixSessionInvocation(...args);
      invocationMs = performance.now() - before;
      return invocation;
    },
  });
  assert.equal(status, 143);
  assert.equal(invocations, 0);
  assert.equal(invocationMs, undefined);
  const completed = completeComponent(status, { operation: 'true', depth: 0, iteration: 1,
    controlMs: 0, invocationMs, elapsedMs: performance.now() - started });
  assert.equal(completed, 143);
  assert.throws(() => requireComponentSuccess({ status: completed }), (error) => error.status === 143);
});

test('the fixed Linux matrix completes through real descriptor and inherited controls and cleans its fixture', {
  skip: process.platform !== 'linux' && 'requires Linux /proc and cached Python runtime',
}, async () => {
  const before = await fs.readdir(os.tmpdir());
  const result = spawnSync(process.execPath, [command], {
    encoding: 'utf8', timeout: 130_000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.stderr, '');
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 20);
  assert.ok(lines.every((line) => Buffer.byteLength(line) <= 512));
  assert.doesNotMatch(result.stdout, /private|secret|argv|digest|authority|\/tmp|\/proc|pid/);
  const rows = lines.map((line) => JSON.parse(line));
  assert.ok(rows.every((row) => row.status === 0));
  assert.deepEqual(rows.filter((row) => row.event === 'operation').map((row) => row.operation),
    ['true-once', 'true-repeat', 'true-depth-one', 'true-depth-two', 'helper-bundle', 'compose']);
  const components = rows.filter((row) => row.event === 'component');
  assert.equal(components.length, 12);
  assert.equal(components.filter((row) => row.source === 'descriptor').length, 9);
  assert.equal(components.filter((row) => row.source === 'chain').length, 3);
  assert.ok(components.every((row) => row.control_ms >= 0 && row.invocation_ms > 0
    && row.elapsed_ms >= row.invocation_ms));
  assert.deepEqual(rows.at(-1), { event: 'component-only', status: 0, fixture_removed: 1 });
  const after = await fs.readdir(os.tmpdir());
  assert.deepEqual(after.filter((name) => name.startsWith('easyboost-bounded-timing-')
    && !before.includes(name)), []);
});
