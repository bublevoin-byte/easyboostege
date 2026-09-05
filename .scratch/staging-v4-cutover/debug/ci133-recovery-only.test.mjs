import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as recovery from './ci133-recovery-only.mjs';
import { startChild } from './ci126-rollback-only.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeSync } from 'node:fs';

test('prepared post-rollback state proves current against real archives and retains stale tree history', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-ci126-rollback-recovery-'));
  try {
    const fixture = await recovery.prepareRecoveryFixture(root);
    assert.deepEqual(await recovery.verifyPreparedRecovery(fixture), {
      activeTree: 'current', archivePairs: 2, image: 'current', container: 'current',
      temporaryRelease: 'absent', transactionResidue: 'absent', protectedMetadata: 'verified',
      counters: 'absent', staleTree: 'retained', recovery: 'absent',
      omittedHistory: 'build-markers-and-compose-log;fresh-supervisor-control-roots',
    });
    assert.equal(await fs.readFile(path.join(fixture.app, 'current.txt'), 'utf8'), 'current\n');
    await assert.rejects(fs.lstat(path.join(fixture.app, 'candidate.txt')), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(fixture.barriers, 'release-tree'), 'utf8'), 'go\n');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function withFixture(action) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-ci126-rollback-recovery-'));
  const handles = [];
  try {
    const fixture = await recovery.prepareRecoveryFixture(root);
    return await action(fixture, handles);
  } finally {
    // Every test child is finite, and its pipes close before private evidence is removed.
    await Promise.all(handles.map((handle) => handle.done));
    const identity = await fs.lstat(root);
    assert.ok(identity.isDirectory() && !identity.isSymbolicLink());
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith('easyboost-ci126-rollback-recovery-'));
    await fs.rm(root, { recursive: true, force: true });
  }
}

function finiteRecovery(fixture, handles, { delayMs = 0, status = 1, evidence = true,
  restore = true, barrier = true, signal = false, lingerMs = 0, inheritedPipes = false,
  outputBytes = 0 } = {}) {
  const handle = startChild(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs/promises';
    import path from 'node:path';
    import { spawn } from 'node:child_process';
    const [root, prefix] = process.argv.slice(1);
    const barriers = path.join(root, 'barriers');
    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    await fs.writeFile(path.join(barriers, 'phase-recovery'), 'config-json-complete\\n');
    await pause(${delayMs});
    if (${barrier}) {
      await fs.writeFile(path.join(barriers, 'up-count'), '2\\n');
      await fs.writeFile(path.join(barriers, 'recovery'), '');
      const until = performance.now() + 2500;
      while (performance.now() < until) {
        if (await fs.lstat(path.join(barriers, 'release-recovery')).then(() => true, () => false)) break;
        await pause(25);
      }
    }
    if (${restore}) {
      for (const name of ['.dockerignore', 'Dockerfile', 'compose.staging.yml', 'current.txt']) {
        await fs.chmod(path.join(root, 'app', name), 0o644);
      }
      await fs.writeFile(path.join(root, 'app/backups', 'easyboost-staging-20000102T000000Z-' + prefix + '-2.dump'),
        'synthetic-lock-fixture-backup\\n', { mode: 0o600 });
    }
    if (${outputBytes}) process.stdout.write('private-output'.repeat(${outputBytes}));
    if (${evidence}) process.stderr.write('Primary staging deploy failed with status 1; verified prior state restored\\n');
    if (${inheritedPipes}) {
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1200)'], { stdio: ['ignore', 'inherit', 'inherit'] });
      child.unref();
    }
    await pause(${lingerMs});
    if (${signal}) process.kill(process.pid, 'SIGTERM');
    else process.exitCode = ${status};
  `, fixture.root, fixture.candidate.sha.slice(0, 12)], {});
  handles.push(handle);
  return handle;
}

for (const [label, childOptions, expected] of [
  ['late expected exit1', { delayMs: 450 }, 1],
  ['unexpected exit0', { status: 0 }, 1],
  ['unexpected exit23', { status: 23 }, 23],
  ['missing expected evidence', { evidence: false }, 1],
  ['unrestored final files', { restore: false }, 1],
  ['stale tree only', { barrier: false, lingerMs: 450 }, 1],
  ['bounded unsettled finite child', { barrier: false, lingerMs: 1200 }, 124],
  ['bounded child output overflow', { outputBytes: 6000 }, 1],
]) {
  test(`${label} stays nonzero through the actual CLI result seam`, async () => withFixture(async (fixture, handles) => {
    const rows = [];
    const handle = finiteRecovery(fixture, handles, childOptions);
    const status = await recovery.finishRecoveryAttempt(fixture, handle, {
      barrierTimeoutMs: 250, settlementTimeoutMs: 650, emit: (row) => rows.push(row),
    });
    assert.equal(status, expected);
    const initial = rows.find((row) => row.event === 'recovery-barrier');
    const settled = rows.find((row) => row.event === 'settlement');
    assert.equal(initial.staleTree, 'present');
    if (label === 'late expected exit1') {
      assert.equal(initial.verdict, 'other-timeout');
      assert.equal(initial.deadlineReached, true);
      assert.equal(initial.recovery, 'absent');
      assert.equal(settled.status, 1);
      assert.equal(settled.finalState, 'verified-current');
      assert.ok(settled.lateRecoveryElapsedMs >= 250);
    }
    if (label === 'stale tree only' || label === 'bounded unsettled finite child') {
      assert.equal(initial.verdict, 'other-timeout');
      assert.equal(settled.barrierReleased, false);
      await assert.rejects(fs.lstat(path.join(fixture.barriers, 'release-recovery')), { code: 'ENOENT' });
    }
    if (expected === 124) {
      assert.equal(settled.closed, false);
      assert.equal(settled.fixtureRetained, true);
      assert.equal(settled.cleanup, 'disposable-environment-lifecycle');
    }
    assert.ok(rows.every((row) => Buffer.byteLength(JSON.stringify(row)) <= 2048));
    assert.equal(JSON.stringify(rows).includes('private-output'), false);
    assert.equal(JSON.stringify(rows).includes(fixture.root), false);
  }));
}

for (const expected of [1, 23]) {
  test(`real report writer failure preserves known result${expected}`, async () => withFixture(async (fixture, handles) => {
    const descriptor = await fs.open(path.join(fixture.app, '.env.staging'), 'r');
    try {
      const handle = finiteRecovery(fixture, handles, { status: expected });
      const status = await recovery.finishRecoveryAttempt(fixture, handle, {
        barrierTimeoutMs: 2000, settlementTimeoutMs: 2000,
        emit: (row) => writeSync(descriptor.fd, `${JSON.stringify(row)}\n`),
      });
      assert.equal(status, expected);
      assert.equal(await fs.readFile(path.join(fixture.barriers, 'release-recovery'), 'utf8'), 'go\n');
    } finally { await descriptor.close(); }
  }));
}

test('private report file failure cannot replace child23', async () => withFixture(async (fixture, handles) => {
  await fs.mkdir(path.join(fixture.root, 'recovery-stderr'));
  const rows = [];
  const handle = finiteRecovery(fixture, handles, { status: 23 });
  assert.equal(await recovery.finishRecoveryAttempt(fixture, handle, {
    barrierTimeoutMs: 2000, settlementTimeoutMs: 2000, emit: (row) => rows.push(row),
  }), 23);
  assert.equal(rows.at(-1).outputFailed, true);
}));

test('final current proof independently invokes the real Docker fixture inspection seam', {
  skip: process.platform !== 'linux',
}, async () => withFixture(async (fixture, handles) => {
  // Backing files remain current; only the real command disagrees. File-only proof must fail.
  await fs.writeFile(path.join(fixture.bin, 'docker'), '#!/bin/bash\nprintf wrong-image\\n\n');
  const handle = finiteRecovery(fixture, handles);
  assert.equal(await recovery.finishRecoveryAttempt(fixture, handle, {
    barrierTimeoutMs: 2000, settlementTimeoutMs: 2000, emit: () => {},
  }), 1);
}));

test('allowlisted phase timeline samples repeated rewrites no faster than500ms and never exceeds16rows', async () =>
  withFixture(async (fixture, handles) => {
    const rows = [];
    const handle = startChild(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs/promises';
      import path from 'node:path';
      const file = path.join(process.argv[1], 'phase-recovery');
      await fs.writeFile(file, 'private-phase-not-for-report\\n');
      await new Promise((resolve) => setTimeout(resolve, 600));
      for (let i = 0; i < 20; i += 1) {
        await fs.writeFile(file, 'config-json-complete\\n');
        await new Promise((resolve) => setTimeout(resolve, 600));
      }
      process.exitCode = 23;
    `, fixture.barriers], {});
    handles.push(handle);
    assert.equal(await recovery.finishRecoveryAttempt(fixture, handle, {
      barrierTimeoutMs: 200, settlementTimeoutMs: 16000, emit: (row) => rows.push(row),
    }), 23);
    const timeline = rows.find((row) => row.event === 'phase-timeline');
    assert.equal(timeline.intervalMs, 500);
    assert.equal(timeline.rows.length, 16);
    assert.ok(timeline.omittedCount >= 1);
    for (const [index, row] of timeline.rows.entries()) {
      assert.deepEqual(Object.keys(row).sort(), ['elapsedMs', 'phase']);
      assert.equal(row.phase, 'config-json-complete');
      if (index) assert.ok(row.elapsedMs - timeline.rows[index - 1].elapsedMs >= 500);
    }
    assert.equal(JSON.stringify(rows).includes('private-phase'), false);
    assert.ok(rows.every((row) => Buffer.byteLength(JSON.stringify(row)) <= 2048));
  }));

test('POSIX signal remains distinguishable from expected exit1', { skip: process.platform !== 'linux' }, async () =>
  withFixture(async (fixture, handles) => {
    const rows = [];
    const handle = finiteRecovery(fixture, handles, { signal: true });
    assert.equal(await recovery.finishRecoveryAttempt(fixture, handle, {
      barrierTimeoutMs: 2000, settlementTimeoutMs: 2000, emit: (row) => rows.push(row),
    }), 143);
    assert.equal(rows.find((row) => row.event === 'settlement').signal, 'SIGTERM');
  }));

test('launcher exit23 stops initial observation while its finite descendant retains pipes', {
  skip: process.platform !== 'linux',
}, async () => withFixture(async (fixture, handles) => {
  const rows = [];
  const handle = finiteRecovery(fixture, handles, { barrier: false, status: 23, inheritedPipes: true });
  assert.equal(await recovery.finishRecoveryAttempt(fixture, handle, {
    barrierTimeoutMs: 2000, settlementTimeoutMs: 100, emit: (row) => rows.push(row),
  }), 124, 'unclosed inherited pipes are unsettled, with original child23 retained in both reports');
  const initial = rows.find((row) => row.event === 'recovery-barrier');
  assert.equal(initial.verdict, 'exited-before-barrier');
  assert.equal(initial.deadlineReached, false);
  assert.equal(initial.status, 23);
  assert.equal(initial.closed, false);
  assert.equal(rows.find((row) => row.event === 'settlement').status, 23);
}));

test('prepared state rejects missing and contradictory metadata, store and active residue', async () => {
  for (const mutate of [
    async (f) => fs.unlink(path.join(f.app, '.release-sha256')),
    async (f) => fs.writeFile(path.join(f.app, '.release-sha256'), `${f.candidate.sha}\n`),
    async (f) => fs.writeFile(f.imageState, `${f.factories.candidateImageId}\n`),
    async (f) => fs.writeFile(f.containerState, `${f.factories.candidateImageId}\n`),
    async (f) => fs.writeFile(f.releaseState, `${f.factories.previousImageId}\n`),
    async (f) => fs.writeFile(path.join(f.app, '.staging-recovery-required'), 'active\n'),
    async (f) => fs.mkdir(path.join(f.root, 'host-operation.lock')),
    async (f) => fs.mkdir(path.join(f.app, 'rollbacks', '.staging-work')),
    async (f) => fs.writeFile(path.join(f.app, 'backups', '.staging-space-reservation'), 'reservation'),
    async (f) => fs.writeFile(path.join(f.barriers, 'up-count'), '1\n'),
    async (f) => fs.writeFile(path.join(f.barriers, 'curl-count'), '1\n'),
    async (f) => fs.writeFile(path.join(f.barriers, 'recovery'), ''),
    async (f) => fs.unlink(path.join(f.app, 'rollbacks/releases', `release-${f.current.sha}.tar.gz.sha256`)),
    async (f) => fs.writeFile(path.join(f.app, 'rollbacks/releases', `release-${f.current.sha}.tar.gz.sha256`), `${f.candidate.sha}\n`),
    async (f) => fs.writeFile(path.join(f.app, 'rollbacks/releases', `release-${f.candidate.sha}.tar.gz`), 'not-an-archive'),
    async (f) => {
      await fs.chmod(path.join(f.app, 'current.txt'), 0o600);
      await fs.writeFile(path.join(f.app, 'current.txt'), 'wrong current\n');
    },
  ]) await withFixture(async (fixture) => {
    await mutate(fixture);
    await assert.rejects(recovery.verifyPreparedRecovery(fixture));
  });
});

test('Linux installer and Docker state proof use real fixture generation without running a release', {
  skip: process.platform !== 'linux',
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-ci126-rollback-recovery-'));
  const fixture = await recovery.prepareRecoveryFixture(root);
  const installed = await recovery.installRecoveryFixture(fixture, () => {});
  assert.equal(path.basename(installed.launcher), 'easyboost-staging-deploy');
  assert.match(installed.bundleDigest, /^[a-f0-9]{64}$/u);
  await recovery.verifyPreparedRecovery(fixture);
  await recovery.proveCurrentDocker(fixture);
  await fs.writeFile(fixture.containerState, `${fixture.factories.candidateImageId}\n`);
  await assert.rejects(recovery.proveCurrentDocker(fixture));
  // Immutable installed generation is retained for this disposable Linux environment's disposal.
});

function finiteAuxiliarySource(status) {
  return `import { spawn } from 'node:child_process';
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3500)'], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.unref();
    process.exitCode = ${status};
  `;
}

async function retainedAuxiliaryFixture() {
  // Auxiliary settlement is deliberately unproven at the diagnostic deadline. Leave
  // the complete fixture to the disposable Linux environment, even after the test.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-ci126-rollback-recovery-'));
  return recovery.prepareRecoveryFixture(root);
}

async function installFiniteDocker(fixture, status) {
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  await fs.writeFile(path.join(fixture.bin, 'docker'), `#!/bin/bash
exec ${quote(process.execPath)} --input-type=module -e ${quote(finiteAuxiliarySource(status))}
`);
}

test('initial Docker proof reports124 with exited auxiliary0 and unclosed finite inherited pipes', {
  skip: process.platform !== 'linux',
}, async () => {
  const fixture = await retainedAuxiliaryFixture();
  await installFiniteDocker(fixture, 0);
  const rows = [];
  await assert.rejects(recovery.proveCurrentDocker(fixture, {
    timeoutMs: 200, emit: (row) => rows.push(row),
  }), (error) => error.status === 124 && error.auxiliary.role === 'docker-inspection'
    && error.auxiliary.status === 0 && error.auxiliary.exited && !error.auxiliary.closed);
  assert.equal(rows[0].event, 'auxiliary-unsettled');
  assert.equal(rows[0].fixtureRetained, true);
  assert.ok((await fs.lstat(fixture.root)).isDirectory());
});

test('final result preserves helper1 evidence while reporting unclosed auxiliary23 as124', {
  skip: process.platform !== 'linux',
}, async () => {
  const fixture = await retainedAuxiliaryFixture();
  await installFiniteDocker(fixture, 23);
  const handle = finiteRecovery(fixture, []);
  const rows = [];
  assert.equal(await recovery.finishRecoveryAttempt(fixture, handle, {
    barrierTimeoutMs: 2000, settlementTimeoutMs: 2000, proofTimeoutMs: 200,
    emit: (row) => rows.push(row),
  }), 124);
  const settled = rows.find((row) => row.event === 'settlement');
  assert.equal(settled.status, 1);
  assert.equal(settled.signal, null);
  assert.equal(settled.closed, true);
  assert.equal(settled.expectedEvidence, true);
  assert.equal(settled.finalState, 'not-proven');
  assert.equal(settled.auxiliary.role, 'docker-inspection');
  assert.equal(settled.auxiliary.status, 23);
  assert.equal(settled.auxiliary.closed, false);
  assert.equal(rows.at(-1).status, 124);
  assert.equal(rows.at(-1).fixtureRetained, true);
  assert.equal(await fs.readFile(path.join(fixture.root, 'recovery-stderr'), 'utf8'),
    'Primary staging deploy failed with status 1; verified prior state restored\n');
});

test('installer reports124 and retains original23 when its finite descendant keeps pipes open', {
  skip: process.platform !== 'linux',
}, async () => {
  const fixture = await retainedAuxiliaryFixture();
  const originalFactory = fixture.factories.prepareInstaller;
  fixture.factories.prepareInstaller = async (root, bin) => {
    const prepared = await originalFactory(root, bin);
    // Local substitute at the existing fixture factory seam: real pinned Node runs
    // a finite installer source from this private fixture; repository bytes stay intact.
    await fs.writeFile(path.join(root, 'helper-installer-source/staging-helper-bundle.js'),
      finiteAuxiliarySource(23));
    return prepared;
  };
  const rows = [];
  await assert.rejects(recovery.installRecoveryFixture(fixture, (row) => rows.push(row), {
    timeoutMs: 200,
  }), (error) => error.status === 124 && error.auxiliary.role === 'installer'
    && error.auxiliary.status === 23 && error.auxiliary.exited && !error.auxiliary.closed);
  assert.equal(rows[0].event, 'auxiliary-unsettled');
  assert.equal(rows[0].fixtureRetained, true);
  assert.ok((await fs.lstat(path.join(fixture.root, 'node-authority/node'))).isFile());
});

test('prepared proof refuses a same-byte replacement of its captured active marker', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-ci126-rollback-recovery-'));
  try {
    const fixture = await recovery.prepareRecoveryFixture(root);
    const marker = path.join(fixture.app, '.release-sha256');
    const held = await fs.open(marker, 'r');
    try {
      await fs.unlink(marker);
      await fs.writeFile(marker, `${fixture.current.sha}\n`, { mode: 0o600 });
      await assert.rejects(recovery.verifyPreparedRecovery(fixture));
    } finally { await held.close(); }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('fixed recovery CLI rejects an arbitrary command, path or environment argument before setup', () => {
  const command = fileURLToPath(new URL('./ci133-recovery-only.mjs', import.meta.url));
  const child = spawnSync(process.execPath, [command, 'private-path', 'BLOCK_AT=tree'], {
    encoding: 'utf8', timeout: 3000, maxBuffer: 1024,
  });
  assert.equal(child.status, 64);
  assert.equal(child.stderr, '');
  assert.deepEqual(JSON.parse(child.stdout), { event: 'invalid-invocation', status: 64 });
});

test('actual CLI retains invalid-invocation64 when its report descriptor is closed', {
  skip: process.platform !== 'linux' && 'POSIX descriptor closure semantics',
}, () => {
  const moduleUrl = new URL('./ci133-recovery-only.mjs', import.meta.url).href;
  const command = fileURLToPath(moduleUrl);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { closeSync } from 'node:fs';
    process.argv = [process.execPath, ${JSON.stringify(command)}, 'private-path'];
    closeSync(1);
    await import(${JSON.stringify(moduleUrl)});
  `], { encoding: 'utf8', timeout: 3000, maxBuffer: 4096 });
  assert.equal(child.status, 64);
  assert.equal(child.stdout, '');
  assert.equal(child.stderr, '');
});

test('Linux prepared image metadata rejects a same-byte symlink', { skip: process.platform !== 'linux' }, async () =>
  withFixture(async (fixture) => {
    await fs.unlink(fixture.imageState);
    await fs.symlink(fixture.containerState, fixture.imageState);
    await assert.rejects(recovery.verifyPreparedRecovery(fixture));
  }));

test('Linux protected modes and single-link metadata are independently checked', { skip: process.platform !== 'linux' }, async () => {
  for (const mutate of [
    async (f) => fs.chmod(path.join(f.app, '.env.staging'), 0o4600),
    async (f) => fs.chmod(path.join(f.app, 'rollbacks'), 0o1700),
    async (f) => fs.chmod(path.join(f.app, 'current.txt'), 0o644),
    async (f) => fs.link(path.join(f.app, '.env.staging'), path.join(f.root, 'extra-env-link')),
  ]) await withFixture(async (fixture) => {
    await mutate(fixture);
    await assert.rejects(recovery.verifyPreparedRecovery(fixture));
  });
});

test('invalid or unreadable phase/count evidence cannot mask child23', async () => {
  for (const unreadable of [false, true]) await withFixture(async (fixture, handles) => {
    const rows = [];
    const handle = startChild(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs/promises';
      import path from 'node:path';
      const root = process.argv[1];
      if (${unreadable}) await fs.mkdir(path.join(root, 'phase-recovery'));
      else await fs.writeFile(path.join(root, 'phase-recovery'), 'private-phase\\n');
      await fs.writeFile(path.join(root, 'up-count'), 'private-count\\n');
      process.exitCode = 23;
    `, fixture.barriers], {});
    handles.push(handle);
    assert.equal(await recovery.finishRecoveryAttempt(fixture, handle, {
      barrierTimeoutMs: 2000, settlementTimeoutMs: 1000, emit: (row) => rows.push(row),
    }), 23);
    const initial = rows.find((row) => row.event === 'recovery-barrier');
    assert.equal(initial.verdict, 'exited-before-barrier');
    assert.equal(initial.lastPhase, 'unavailable');
    assert.equal(initial.upCount, 'unavailable');
    assert.equal(JSON.stringify(rows).includes('private-phase'), false);
    assert.equal(JSON.stringify(rows).includes('private-count'), false);
  });
});

test('on-time recovery and expected helper exit1 require independently restored final current files at the CLI result seam', async () =>
  withFixture(async (fixture, handles) => {
    const handle = finiteRecovery(fixture, handles);
    const rows = [];
    assert.equal(await recovery.finishRecoveryAttempt(fixture, handle, {
      barrierTimeoutMs: 2000, settlementTimeoutMs: 3000, emit: (row) => rows.push(row),
    }), 0);
    assert.equal(rows.find((row) => row.event === 'recovery-barrier').verdict, 'barrier-reached');
    assert.equal(rows.find((row) => row.event === 'settlement').finalState, 'verified-current');
    assert.equal(rows.at(-1).status, 0);
    assert.equal(JSON.stringify(rows).includes('Primary staging'), false);
    assert.equal(await fs.readFile(path.join(fixture.root, 'recovery-stderr'), 'utf8'),
      'Primary staging deploy failed with status 1; verified prior state restored\n');
  }));
