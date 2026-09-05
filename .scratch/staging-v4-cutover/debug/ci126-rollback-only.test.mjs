import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as diagnostic from './ci126-rollback-only.mjs';

const command = fileURLToPath(new URL('./ci126-rollback-only.mjs', import.meta.url));

test('rollback diagnostic rejects arbitrary paths or commands before fixture creation', () => {
  const result = spawnSync(process.execPath, [command, 'private-command-or-production-path'], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 1024,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 64);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { event: 'invalid-invocation', status: 64 });
});

test('only the unchanged120s empty-output config-json timeout matches the original symptom', () => {
  const original = { tree: 'absent', lastPhase: 'config-json-complete', upCount: 'missing',
    elapsedMs: 120_023, stdoutBytes: 0, stderrBytes: 0, closed: false, deadlineReached: true };
  assert.equal(diagnostic.barrierVerdict(original), 'matching-original-timeout');
  assert.equal(diagnostic.barrierVerdict({ ...original, elapsedMs: 119_999 }), 'other-timeout');
  assert.equal(diagnostic.barrierVerdict({ ...original, stderrBytes: 10 }), 'other-timeout');
  assert.equal(diagnostic.barrierVerdict({ ...original, closed: true, deadlineReached: false }), 'exited-before-barrier');
  assert.equal(diagnostic.barrierVerdict({ ...original, tree: 'present', deadlineReached: false }), 'barrier-reached');
  assert.equal(diagnostic.barrierVerdict({ ...original, closed: true, deadlineReached: false,
    maintenanceRefusal: true }), 'environment-refusal');
});

test('a real settled child failure survives the same result seam used by the diagnostic CLI', () => {
  const child = spawnSync(process.execPath, ['-e',
    'console.error("private-output-must-not-be-echoed"); process.exitCode = 23;'], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 1024,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 23);
  const outcome = { ...child, closed: true };
  assert.equal(diagnostic.diagnosticExitStatus('exited-before-barrier', outcome), 23);
  assert.equal(diagnostic.diagnosticExitStatus('matching-original-timeout', outcome), 23);
  assert.throws(() => diagnostic.requireChildSuccess(outcome), (error) =>
    error.status === 23 && error.message === 'diagnostic child failed'
      && !JSON.stringify(error).includes('private-output'));
  assert.equal(diagnostic.diagnosticExitStatus('matching-original-timeout', { closed: true, status: 0 }), 1);
  assert.equal(diagnostic.diagnosticExitStatus('barrier-reached', { closed: false }), 124);
});

test('a real signalled child preserves its signal exit status', {
  skip: process.platform !== 'linux' && 'POSIX signal status contract',
}, () => {
  const child = spawnSync(process.execPath, ['-e', 'process.kill(process.pid, "SIGTERM");'], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 1024,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.signal, 'SIGTERM');
  assert.equal(diagnostic.diagnosticExitStatus('exited-before-barrier', { ...child, closed: true }), 143);
});

test('launcher exit23 ends barrier observation while its finite descendant still owns inherited pipes', {
  skip: process.platform !== 'linux' && 'requires Linux inherited file-descriptor lifetime',
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-ci126-pipes-'));
  let handle;
  try {
    await fs.writeFile(path.join(root, 'phase-tree'), 'config-json-complete\n');
    handle = diagnostic.startChild(process.execPath, ['--input-type=module', '-e', `
      import { spawn } from 'node:child_process';
      const descendant = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1800);'], {
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      descendant.unref();
      process.exitCode = 23;
    `], {});
    const observed = diagnostic.observeTreeBarrier({ barriers: root,
      factories: { lockFixturePhases: new Set(['config-json-complete']) } }, handle);
    await new Promise((resolve) => handle.child.once('exit', resolve));
    const atExit = { status: handle.status, signal: handle.signal, closed: handle.closed,
      exitStatus: diagnostic.diagnosticExitStatus('exited-before-barrier', handle) };
    const snapshot = await observed;
    assert.deepEqual(atExit, { status: 23, signal: null, closed: false, exitStatus: 23 });
    assert.equal(snapshot.verdict, 'exited-before-barrier');
    assert.equal(snapshot.closed, false, 'barrier verdict must not wait for inherited pipes');
    assert.equal(snapshot.status, 23);
    assert.equal(snapshot.deadlineReached, false);
    assert.equal(diagnostic.barrierVerdict({ ...snapshot, elapsedMs: 120_023,
      deadlineReached: true }), 'exited-before-barrier', 'a known exit cannot become the original timeout');
    assert.throws(() => diagnostic.requireChildSuccess(handle), (error) => error.status === 23);
  } finally {
    // Both processes end naturally; do not erase a fixture while the descendant owns pipes.
    if (handle) await handle.done;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('prepared candidate passes real archive verification and rejects missing or contradictory post-deploy state', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-ci126-rollback-'));
  try {
    const fixture = await diagnostic.prepareFixture(root);
    assert.deepEqual(await diagnostic.verifyFixture(fixture), {
      activeTree: 'candidate', archivePairs: 2, image: 'candidate', container: 'candidate',
      temporaryRelease: 'absent', transactionResidue: 'absent', protectedMetadata: 'verified',
    });
    await fs.writeFile(fixture.releaseState, `sha256:${'2'.repeat(64)}\n`);
    await assert.rejects(diagnostic.verifyFixture(fixture));
    await fs.unlink(fixture.releaseState);
    const sidecar = path.join(fixture.app, 'rollbacks', 'releases', `release-${fixture.current.sha}.tar.gz.sha256`);
    const saved = await fs.readFile(sidecar);
    await fs.unlink(sidecar);
    await assert.rejects(diagnostic.verifyFixture(fixture));
    await fs.writeFile(sidecar, saved, { mode: 0o600 });
    await fs.chmod(path.join(fixture.app, 'candidate.txt'), 0o600);
    await fs.writeFile(path.join(fixture.app, 'candidate.txt'), 'wrong candidate bytes\n');
    await assert.rejects(diagnostic.verifyFixture(fixture));
  } finally {
    // No process is ever started by this fixture-only contract.
    await fs.rm(root, { recursive: true, force: true });
  }
});
