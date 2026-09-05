import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as diagnostic from './ci126-rollback-only.mjs';

const command = fileURLToPath(new URL('./ci126-rollback-only.mjs', import.meta.url));

for (const [childStatus, expectedStatus] of [[0, 1], [23, 23]]) {
  test(`late tree and child exit${childStatus} preserve the original failed assertion at the CLI observation seam`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-ci126-late-'));
    let handle;
    try {
      handle = diagnostic.startChild(process.execPath, ['--input-type=module', '-e', `
        import fs from 'node:fs/promises';
        import path from 'node:path';
        const root = process.argv[1];
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        await fs.writeFile(path.join(root, 'phase-tree'), 'build-complete\\n');
        const deadline = performance.now() + 3000;
        while (performance.now() < deadline) {
          if (await fs.stat(path.join(root, 'release-tree')).then(() => true, () => false)) break;
          await sleep(25);
        }
        await fs.writeFile(path.join(root, 'phase-tree'), 'up-barrier\\n');
        await fs.writeFile(path.join(root, 'tree'), 'ready\\n');
        await sleep(650);
        await fs.writeFile(path.join(root, 'phase-tree'), 'up-complete\\n');
        process.stderr.write('private-output\\n');
        process.exitCode = ${childStatus};
      `, root], {});
      const rows = [];
      const outcome = await diagnostic.observeRollback({ barriers: root,
        factories: { lockFixturePhases: new Set(['build-complete', 'up-barrier', 'up-complete']) } },
      handle, { barrierTimeoutMs: 300, settlementTimeoutMs: 2000, emit: (row) => rows.push(row) });
      const initial = rows.find((row) => row.event === 'tree-barrier');
      assert.equal(initial.verdict, 'other-timeout');
      assert.equal(initial.deadlineReached, true);
      assert.equal(initial.tree, 'absent');
      assert.equal(initial.lastPhase, 'build-complete');
      assert.equal(initial.status, null);
      assert.equal(initial.closed, false);
      assert.equal(initial.stderrBytes, 0);
      const settlement = rows.find((row) => row.event === 'settlement');
      assert.equal(settlement.exited, true);
      assert.equal(settlement.closed, true);
      assert.equal(settlement.status, childStatus);
      assert.equal(settlement.lateTree, 'present');
      assert.ok(settlement.lateTreeElapsedMs >= initial.elapsedMs);
      assert.equal(settlement.finalPhase, 'up-complete');
      assert.equal(settlement.stdoutBytes, 0);
      assert.equal(settlement.stderrBytes, 15);
      assert.equal(outcome, expectedStatus, 'late settlement preserves failure and the exact nonzero child status');
      assert.ok(rows.every((row) => Buffer.byteLength(JSON.stringify(row)) <= 2048));
      assert.equal(JSON.stringify(rows).includes('private-output'), false);
    } finally {
      // This finite child ends naturally even if observation fails before releasing its marker.
      if (handle) await handle.done;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}

test('later observation expires without claiming settlement or erasing the still-active finite fixture', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-ci126-unsettled-'));
  let handle;
  try {
    handle = diagnostic.startChild(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs/promises';
      import path from 'node:path';
      await fs.writeFile(path.join(process.argv[1], 'phase-tree'), 'build-complete\\n');
      await new Promise((resolve) => setTimeout(resolve, 1500));
    `, root], {});
    const rows = [];
    const outcome = await diagnostic.observeRollback({ barriers: root,
      factories: { lockFixturePhases: new Set(['build-complete']) } },
    handle, { barrierTimeoutMs: 300, settlementTimeoutMs: 100, emit: (row) => rows.push(row) });
    const settlement = rows.find((row) => row.event === 'settlement');
    assert.equal(outcome, 124);
    assert.equal(settlement.exited, false);
    assert.equal(settlement.closed, false);
    assert.equal(settlement.status, null);
    assert.equal(settlement.helperCompletedCleanly, false);
    assert.equal(settlement.fixtureRetained, true);
    assert.equal(settlement.cleanup, 'disposable-environment-lifecycle');
    assert.equal(settlement.finalPhase, 'build-complete');
    assert.ok(settlement.elapsedMs >= 100 && settlement.elapsedMs < 1000);
    assert.equal(await fs.readFile(path.join(root, 'release-tree'), 'utf8'), 'go\n');
  } finally {
    if (handle) await handle.done;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('separate observed rewrites of the same phase remain visible without exposing file metadata', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-ci126-rewrites-'));
  let handle;
  try {
    handle = diagnostic.startChild(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs/promises';
      import path from 'node:path';
      const file = path.join(process.argv[1], 'phase-tree');
      for (let index = 0; index < 3; index += 1) {
        await fs.writeFile(file, 'config-json-complete\\n');
        await new Promise((resolve) => setTimeout(resolve, 900));
      }
    `, root], {});
    const rows = [];
    await diagnostic.observeRollback({ barriers: root,
      factories: { lockFixturePhases: new Set(['config-json-complete']) } },
    handle, { barrierTimeoutMs: 300, settlementTimeoutMs: 4000, emit: (row) => rows.push(row) });
    const timeline = rows.find((row) => row.event === 'phase-timeline');
    assert.equal(timeline.rows.length, 3, 'distinct sampled rewrites cannot collapse into one phase');
    assert.equal(timeline.omittedCount, 0);
    for (const row of timeline.rows) {
      assert.equal(row.phase, 'config-json-complete');
      assert.deepEqual(Object.keys(row).sort(), ['elapsedMs', 'phase']);
    }
  } finally {
    if (handle) await handle.done;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('rollback diagnostic rejects arbitrary paths or commands before fixture creation', () => {
  const result = spawnSync(process.execPath, [command, 'private-command-or-production-path'], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 1024,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 64);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { event: 'invalid-invocation', status: 64 });
});

test('real phase progression is allowlisted, sampled no faster than500ms and capped at16rows', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-ci126-phases-'));
  let handle;
  try {
    handle = diagnostic.startChild(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs/promises';
      import path from 'node:path';
      const file = path.join(process.argv[1], 'phase-tree');
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      await fs.writeFile(file, 'private-phase-must-never-appear\\n');
      await sleep(900);
      for (let index = 0; index < 24; index += 1) {
        await fs.writeFile(file, index % 2 ? 'config-json-complete\\n' : 'config-json-enter\\n');
        await sleep(600);
      }
      await fs.writeFile(file, 'up-complete\\n');
    `, root], {});
    const rows = [];
    const outcome = await diagnostic.observeRollback({ barriers: root,
      factories: { lockFixturePhases: new Set(['config-json-enter', 'config-json-complete', 'up-complete']) } },
    handle, { barrierTimeoutMs: 300, settlementTimeoutMs: 18000, emit: (row) => rows.push(row) });
    const timeline = rows.find((row) => row.event === 'phase-timeline');
    assert.ok(timeline, 'the real operation must publish its sampled phase progression');
    assert.equal(timeline.intervalMs, 500);
    assert.equal(timeline.rows.length, 16);
    assert.ok(timeline.omittedCount > 0, 'later phase changes remain counted after the row cap');
    for (const [index, row] of timeline.rows.entries()) {
      assert.ok(['config-json-enter', 'config-json-complete'].includes(row.phase));
      if (index > 0) assert.ok(row.elapsedMs - timeline.rows[index - 1].elapsedMs >= 500);
    }
    const settlement = rows.find((row) => row.event === 'settlement');
    assert.equal(settlement.finalPhase, 'up-complete', 'final phase is available even after the timeline fills');
    assert.equal(settlement.lateTree, 'absent');
    assert.equal(settlement.lateTreeElapsedMs, null);
    assert.equal(outcome, 1);
    assert.ok(rows.every((row) => Buffer.byteLength(JSON.stringify(row)) <= 2048));
    assert.equal(JSON.stringify(rows).includes('private-phase'), false);
  } finally {
    if (handle) await handle.done;
    await fs.rm(root, { recursive: true, force: true });
  }
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
